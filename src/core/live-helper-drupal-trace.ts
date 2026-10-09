// The Drupal helper's trace: what made each part of a page, recorded while a
// request carrying the live view's token renders, and served as a LiveTrace
// (src/shared/live-trace.ts). PHP source, written into the module folder by
// live-helper-drupal.ts. Every interception point is a core API or a subclass
// of a core service whose method it extends, named in a comment at the point
// with the 11.4 file and function it relies on; WaniganLiveServiceProvider
// checks each core signature before swapping a class in, and leaves core's
// own class when it differs. Nothing here acts unless Recorder::$on is set,
// which only TraceSubscriber does, and only for a token request.
// The map of every point, and its edge cases: docs/research/2026-10-09-drupal-core-live-trace.md.

const RECORDER = String.raw`<?php

namespace Drupal\wanigan_live\Trace;

use Drupal\Component\Render\MarkupInterface;
use Drupal\Core\Render\Markup;

/**
 * One traced render: its parts, the hooks that ran, queries and log entries.
 *
 * Self::$on holds the recorder of the request being traced, and is NULL for
 * every other request, so each interception point costs one property read
 * when it is not needed. State is kept per Fiber: Drupal 11 renders inside
 * Fibers (Renderer::executeInRenderContext(), Renderer::replacePlaceholders()
 * in core/lib/Drupal/Core/Render/Renderer.php), and a Fiber that suspends
 * must not see another's frames.
 */
final class Recorder {

  /**
   * The recorder of the request being traced, or NULL.
   */
  public static ?Recorder $on = NULL;

  public const LIMITS = ['parts' => 4000, 'edits' => 4000, 'hooks' => 5000, 'queries' => 2000, 'assets' => 500, 'logs' => 500, 'chain' => 200, 'variables' => 200, 'preview' => 400, 'collections' => 1000, 'palette' => 1000];

  public readonly string $id;
  public readonly float $start;
  public readonly int $startNs;

  /**
   * Parts by id: the record each interception point filled in.
   */
  public array $parts = [];
  public bool $partsCut = FALSE;
  public array $hooks = [];
  public int $hookCount = 0;

  /**
   * Queries as [sql, ms, caller, frame]; frames kept for every query, so a
   * part's count is right even past the bound on the listed ones.
   */
  public array $queries = [];
  public int $queryCount = 0;
  public float $queryMs = 0.0;
  public array $logs = [];
  public int $logCount = 0;

  /**
   * Where a placeholder sat when it was cut out, by its lazy builder.
   */
  public array $placeholderFrames = [];

  /**
   * The database events this request switched on, to switch off again.
   */
  public array $enabledEvents = [];

  /**
   * Placeholders being rendered now (TraceRenderer::doRenderPlaceholder()).
   */
  public int $placeholders = 0;

  private \WeakMap $fibers;
  private FiberState $main;
  private int $seq = 0;

  public function __construct(public readonly string $url) {
    $this->id = bin2hex(random_bytes(8));
    $this->start = microtime(TRUE);
    $this->startNs = hrtime(TRUE);
    $this->fibers = new \WeakMap();
    $this->main = new FiberState();
  }

  /**
   * The frames of the Fiber running now.
   */
  public function state(): FiberState {
    $fiber = \Fiber::getCurrent();
    if ($fiber === NULL) {
      return $this->main;
    }
    if (!isset($this->fibers[$fiber])) {
      $this->fibers[$fiber] = new FiberState();
    }
    return $this->fibers[$fiber];
  }

  /**
   * The innermost open frame: of this Fiber, else the one it was started in.
   */
  public function top(): ?Frame {
    $state = $this->state();
    return $state->frames ? $state->frames[array_key_last($state->frames)] : $state->base;
  }

  public function push(Frame $frame): Frame {
    $frame->parent = $this->top();
    $frame->t0 = hrtime(TRUE);
    $this->state()->frames[] = $frame;
    return $frame;
  }

  /**
   * Closes a frame, and any left open above it by an exception.
   */
  public function pop(Frame $frame): void {
    $frame->ms = (hrtime(TRUE) - $frame->t0) / 1e6;
    $state = $this->state();
    for ($i = count($state->frames) - 1; $i >= 0; $i--) {
      if ($state->frames[$i] === $frame) {
        array_splice($state->frames, $i);
        return;
      }
    }
  }

  /**
   * The open theme frame for a hook, searching down from the top.
   */
  public function themeFrame(string $original): ?Frame {
    $frames = $this->state()->frames;
    for ($i = count($frames) - 1; $i >= 0; $i--) {
      if ($frames[$i]->type === 'T' && ($frames[$i]->info['original'] ?? NULL) === $original) {
        return $frames[$i];
      }
    }
    return NULL;
  }

  /**
   * A new part id, or NULL once the bound is reached (and it says so).
   */
  public function newPart(): ?string {
    if (count($this->parts) >= self::LIMITS['parts']) {
      $this->partsCut = TRUE;
      return NULL;
    }
    return 'p' . (++$this->seq);
  }

  public static function open(string $id): string {
    return '<!-- wl:part id="' . $id . '" -->';
  }

  public static function close(string $id): string {
    return '<!-- /wl:part id="' . $id . '" -->';
  }

  /**
   * Notes one hook implementation's turn: request-wide, and on the element
   * being built when it ran.
   */
  public function hook(string $hook, string $by, mixed $listener, int $t0, ?array $changed = NULL): void {
    $ms = (hrtime(TRUE) - $t0) / 1e6;
    $this->hookCount++;
    $step = ['hook' => $hook, 'by' => $by, 'listener' => $listener, 'ms' => $ms];
    if ($changed) {
      $step['changed'] = $changed;
    }
    if (count($this->hooks) < self::LIMITS['hooks']) {
      $this->hooks[] = $step;
    }
    if (str_starts_with($hook, 'theme_suggestions')) {
      // Suggestions are built just before the template's first preprocess
      // (ThemeManager::render() then ::buildThemeHookSuggestions()), in the
      // same Fiber: the next theme frame takes them as its first steps.
      $this->state()->suggestions[] = $step;
      return;
    }
    $top = $this->top();
    if ($top !== NULL && $top->type === 'R' && count($top->steps) < self::LIMITS['chain']) {
      $top->steps[] = $step;
    }
  }

  public function takeSuggestions(): array {
    $state = $this->state();
    $steps = $state->suggestions;
    $state->suggestions = [];
    return $steps;
  }

  public function query(string $sql, float $ms, array $caller): void {
    $this->queryCount++;
    $this->queryMs += $ms;
    $this->queries[] = [count($this->queries) < self::LIMITS['queries'] ? $sql : NULL, $ms, count($this->queries) < self::LIMITS['queries'] ? $caller : NULL, $this->top()];
  }

  public function log(string $level, string $message, ?string $file, ?int $line): void {
    $this->logCount++;
    if (count($this->logs) < self::LIMITS['logs']) {
      $this->logs[] = ['level' => $level, 'message' => $message, 'file' => $file, 'line' => $line];
    }
  }

  /**
   * The nearest open element frame.
   */
  public function nearestElement(): ?Frame {
    for ($frame = $this->top(); $frame !== NULL; $frame = $frame->parent) {
      if ($frame->type === 'R') {
        return $frame;
      }
    }
    return NULL;
  }

  /**
   * A template's render begins: ThemeManager::render() calls its 'initial
   * preprocess' first (TracedRuntime puts this there).
   */
  public function beginTheme(string $hook, array $info, array $variables): Frame {
    $top = $this->top();
    $frame = new Frame('T', [
      'hook' => $hook,
      'original' => (string) ($variables['theme_hook_original'] ?? $hook),
      'base' => (string) ($info['base hook'] ?? $hook),
      'key' => $info['render element'] ?? NULL,
      'element' => ($top !== NULL && $top->type === 'R') ? $top : NULL,
    ]);
    $frame->steps = $this->takeSuggestions();
    return $this->push($frame);
  }

  /**
   * One preprocess callback of a template, in the order it ran.
   */
  public function themeStep(Frame $frame, mixed $listener, string $hook, ?string $by, int $t0, array $changed): void {
    if (count($frame->steps) >= self::LIMITS['chain']) {
      $frame->info['chainCut'] = TRUE;
      return;
    }
    $frame->steps[] = ['hook' => $hook, 'by' => $by, 'listener' => $listener, 'ms' => (hrtime(TRUE) - $t0) / 1e6, 'changed' => $changed, 'theme' => TRUE];
  }

  /**
   * A template rendered (TraceThemeEngine): its output becomes a part.
   */
  public function themePart(Frame $frame, string $file, array $variables, string|MarkupInterface $output): string|MarkupInterface {
    $this->pop($frame);
    // The document itself is not a part; nor is output with nothing in it.
    if ($frame->info['base'] === 'html' || trim((string) $output) === '') {
      return $output;
    }
    $id = $this->newPart();
    if ($id === NULL) {
      return $output;
    }
    $frame->part = $id;
    $this->parts[$id] = ['id' => $id, 'frame' => $frame] + Describe::theme($frame, $file, $variables);
    $element = $frame->info['element'];
    if ($element instanceof Frame) {
      $element->children[] = $id;
      // The element's own template (#theme) speaks for it; otherwise its
      // outermost wrapper (#theme_wrappers render in order).
      if (in_array($frame->info['original'], (array) ($element->info['theme'] ?? []), TRUE)) {
        $element->part = $id;
        $element->info['themed'] = TRUE;
      }
      elseif (empty($element->info['themed'])) {
        $element->part = $id;
      }
    }
    return Markup::create(self::open($id) . $output . self::close($id));
  }

  /**
   * An element rendered (TraceRenderer): its bubbled metadata, and a part of
   * its own when it shows an entity that has no template.
   */
  public function leaveElement(Frame $frame, array &$elements, string|MarkupInterface $markup): string|MarkupInterface {
    $this->pop($frame);
    $text = (string) $markup;
    if ($text !== '' && isset($elements['#attached']['placeholders'][$text])) {
      // Cut out as a placeholder (PlaceholderGenerator::createPlaceholder()):
      // rendered later, from where it sits now.
      $lazy = $elements['#attached']['placeholders'][$text]['#lazy_builder'] ?? NULL;
      if ($lazy !== NULL) {
        $this->placeholderFrames[md5(serialize($lazy))] = $frame->parent;
      }
      return $markup;
    }
    $entity = Describe::entityOf($elements);
    if (!$frame->children && $entity === NULL) {
      $frame->steps = [];
      return $markup;
    }
    $frame->info['cache'] = [
      'tags' => array_values((array) ($elements['#cache']['tags'] ?? [])),
      'contexts' => array_values((array) ($elements['#cache']['contexts'] ?? [])),
      'maxAge' => $elements['#cache']['max-age'] ?? -1,
    ];
    $frame->info['libraries'] = array_values(array_unique((array) ($elements['#attached']['library'] ?? [])));
    if ($entity !== NULL && $frame->part === NULL && trim($text) !== '') {
      $id = $this->newPart();
      if ($id !== NULL) {
        $frame->part = $id;
        $frame->children[] = $id;
        $this->parts[$id] = ['id' => $id, 'frame' => $frame] + Describe::entityPart($entity, $elements);
        $elements['#markup'] = Markup::create(self::open($id) . $text . self::close($id));
        return $elements['#markup'];
      }
    }
    return $markup;
  }

  /**
   * A component template starts (TraceTwigExtension::open()).
   */
  public function componentOpen(string $component, array $context): string {
    $element = $this->nearestElement();
    $frame = $this->push(new Frame('C', ['component' => $component, 'element' => $element]));
    $id = $this->newPart();
    if ($id === NULL) {
      return '';
    }
    $frame->part = $id;
    $this->parts[$id] = ['id' => $id, 'frame' => $frame] + Describe::component($component, $context, $frame);
    if ($element !== NULL) {
      $element->children[] = $id;
      if ($element->part === NULL) {
        $element->part = $id;
      }
    }
    return self::open($id);
  }

  /**
   * A component template ends (TraceTwigExtension::close()).
   */
  public function componentClose(string $component): string {
    $frames = $this->state()->frames;
    for ($i = count($frames) - 1; $i >= 0; $i--) {
      if ($frames[$i]->type === 'C' && ($frames[$i]->info['component'] ?? NULL) === $component) {
        $frame = $frames[$i];
        $this->pop($frame);
        return $frame->part !== NULL ? self::close($frame->part) : '';
      }
    }
    return '';
  }

}
`;

const FRAME = String.raw`<?php

namespace Drupal\wanigan_live\Trace;

/**
 * One open piece of rendering: an element (R), a theme hook (T) or a
 * single-directory component (C).
 */
final class Frame {

  public ?Frame $parent = NULL;
  public int $t0 = 0;
  public float $ms = 0.0;

  /**
   * The part this frame became (T, C) or is shown as (R: its own template).
   */
  public ?string $part = NULL;

  /**
   * R: hooks that ran while it was built. T: its chain.
   */
  public array $steps = [];

  /**
   * R: parts made directly inside it.
   */
  public array $children = [];

  public function __construct(public readonly string $type, public array $info = []) {}

  /**
   * The nearest part this frame is, or sits in.
   */
  public function partOrAbove(array $present): ?string {
    for ($frame = $this; $frame !== NULL; $frame = $frame->parent) {
      if ($frame->part !== NULL && isset($present[$frame->part])) {
        return $frame->part;
      }
    }
    return NULL;
  }

}
`;

const FIBER_STATE = String.raw`<?php

namespace Drupal\wanigan_live\Trace;

/**
 * The open frames of one Fiber, and the frame it was started inside.
 */
final class FiberState {

  public array $frames = [];
  public ?Frame $base = NULL;
  public array $suggestions = [];

}
`;

const SOURCE = String.raw`<?php

namespace Drupal\wanigan_live\Trace;

use Composer\InstalledVersions;

/**
 * Files named as the owner knows them: relative to the project's root (the
 * folder holding composer.json, not the docroot), whose they are, and which
 * module, theme or package they belong to.
 */
final class Source {

  private static ?string $root = NULL;
  private static ?string $app = NULL;
  private static ?array $extensions = NULL;
  private static array $callables = [];

  /**
   * The project's root, absolute, with a trailing slash.
   */
  public static function root(): string {
    if (self::$root === NULL) {
      $root = NULL;
      if (class_exists(InstalledVersions::class)) {
        $path = InstalledVersions::getRootPackage()['install_path'] ?? NULL;
        $root = $path ? realpath($path) : NULL;
      }
      if (!$root) {
        $app = self::app();
        $root = is_file($app . 'composer.json') ? rtrim($app, '/') : (is_file(dirname($app) . '/composer.json') ? dirname($app) : rtrim($app, '/'));
      }
      self::$root = rtrim($root, '/') . '/';
    }
    return self::$root;
  }

  /**
   * Drupal's root (the docroot), absolute, with a trailing slash.
   */
  public static function app(): string {
    return self::$app ??= rtrim((string) (realpath(\Drupal::root()) ?: \Drupal::root()), '/') . '/';
  }

  /**
   * A file relative to the project's root; NULL when it is outside it.
   */
  public static function rel(?string $file): ?string {
    if ($file === NULL || $file === '') {
      return NULL;
    }
    if ($file[0] !== '/') {
      $file = self::app() . $file;
    }
    $real = realpath($file) ?: $file;
    $root = self::root();
    if (!str_starts_with($real, $root)) {
      return NULL;
    }
    $rel = substr($real, strlen($root));
    return ($rel === '' || str_contains('/' . $rel . '/', '/../')) ? NULL : $rel;
  }

  /**
   * Whose a file is, by where it sits (as Wanigan's originOf() says it).
   */
  public static function owner(string $rel): string {
    $app = substr(self::app(), strlen(self::root()));
    $inApp = ($app !== '' && str_starts_with($rel, $app)) ? substr($rel, strlen($app)) : $rel;
    if (str_starts_with($inApp, 'core/')) {
      return 'core';
    }
    if (str_starts_with($rel, 'vendor/') || preg_match('~(^|/)(contrib|node_modules)/~', $rel)) {
      return 'contrib';
    }
    return 'yours';
  }

  /**
   * The module, theme or profile a file belongs to (the longest path that
   * holds it), 'core', or a vendor package.
   */
  public static function package(string $rel): ?string {
    if (self::$extensions === NULL) {
      self::$extensions = [];
      $prefix = substr(self::app(), strlen(self::root()));
      try {
        foreach (\Drupal::moduleHandler()->getModuleList() as $name => $extension) {
          self::$extensions[$prefix . $extension->getPath() . '/'] = $name;
        }
        foreach (\Drupal::service('theme_handler')->listInfo() as $name => $extension) {
          self::$extensions[$prefix . $extension->getPath() . '/'] = $name;
        }
      }
      catch (\Throwable) {
        // Early in a request, before extensions load: no packages to name.
      }
      uksort(self::$extensions, fn ($a, $b) => strlen($b) <=> strlen($a));
    }
    foreach (self::$extensions as $path => $name) {
      if (str_starts_with($rel, $path)) {
        return $name;
      }
    }
    if (preg_match('~^vendor/([^/]+/[^/]+)/~', $rel, $m)) {
      return $m[1];
    }
    return self::owner($rel) === 'core' ? 'core' : NULL;
  }

  /**
   * A TraceSource for a file, or NULL when it is outside the project.
   */
  public static function of(?string $file, ?int $line = NULL): ?array {
    $rel = self::rel($file);
    if ($rel === NULL) {
      return NULL;
    }
    $out = ['file' => $rel, 'owner' => self::owner($rel)];
    if ($line) {
      $out['line'] = $line;
    }
    if ($package = self::package($rel)) {
      $out['package'] = $package;
    }
    return $out;
  }

  /**
   * A callable's name (function or Class::method) and where it is written.
   */
  public static function callable(mixed $callable): array {
    $key = is_string($callable) ? $callable : (is_array($callable) && count($callable) === 2 ? (is_object($callable[0]) ? get_class($callable[0]) : (string) $callable[0]) . '::' . $callable[1] : NULL);
    if ($key !== NULL && isset(self::$callables[$key])) {
      return self::$callables[$key];
    }
    $out = ['name' => $key ?? 'closure'];
    try {
      if ($callable instanceof \Closure) {
        $reflection = new \ReflectionFunction($callable);
        $class = $reflection->getClosureScopeClass();
        $out['name'] = $class ? $class->getName() . '::{closure}' : '{closure}';
      }
      elseif (is_string($callable) && str_contains($callable, '::')) {
        $reflection = new \ReflectionMethod($callable);
      }
      elseif (is_string($callable) && str_contains($callable, ':') && !str_contains($callable, '::')) {
        // A service or class with a method, as core's CallableResolver reads it.
        [$class, $method] = explode(':', $callable, 2);
        $out['name'] = $class . '::' . $method;
        $reflection = class_exists($class) ? new \ReflectionMethod($class, $method) : NULL;
      }
      elseif (is_string($callable)) {
        $reflection = function_exists($callable) ? new \ReflectionFunction($callable) : NULL;
      }
      elseif (is_array($callable)) {
        $reflection = new \ReflectionMethod($callable[0], $callable[1]);
      }
      elseif (is_object($callable) && method_exists($callable, '__invoke')) {
        $reflection = new \ReflectionMethod($callable, '__invoke');
        $out['name'] = get_class($callable) . '::__invoke';
      }
      if (!empty($reflection) && $reflection->getFileName()) {
        $source = self::of($reflection->getFileName(), $reflection->getStartLine() ?: NULL);
        if ($source) {
          $out['source'] = $source;
        }
      }
    }
    catch (\Throwable) {
      // A callable reflection cannot read: its name alone.
    }
    if ($key !== NULL) {
      self::$callables[$key] = $out;
    }
    return $out;
  }

}
`;

const PREVIEW = String.raw`<?php

namespace Drupal\wanigan_live\Trace;

use Drupal\Component\Render\MarkupInterface;
use Drupal\Core\Entity\EntityInterface;
use Drupal\Core\Field\FieldItemListInterface;
use Drupal\Core\Session\AccountInterface;
use Drupal\Core\Template\Attribute;
use Drupal\Core\Url;

/**
 * Bounded, redacted renderings of values, and cheap fingerprints of a
 * template's variables to tell which ones a preprocess step changed.
 *
 * Never renders anything (a render array is summarised, not rendered), and
 * never shows a value whose name is key-, token-, password-, secret-, hash-
 * or session-like, nor a string that looks like a token.
 */
final class Preview {

  private const SECRET_NAME = '/(^|[_\-.\s])(pass|password|passwd|pwd|secret|token|key|apikey|api_key|private|hash|salt|nonce|csrf|session|sess|sid|cookie|credential|credentials|auth|authorization|signature)([_\-.\s]|$)/i';

  /**
   * Variables the theme system adds for itself, not the template's own.
   */
  private const INTERNAL = ['theme_hook_suggestions', 'theme_hook_suggestions__DEPRECATED', 'theme_hook_original', 'theme_hook_suggestion'];

  public static function secretName(string|int $name): bool {
    return is_string($name) && ($name === 'form_token' || $name === 'form_build_id' || preg_match(self::SECRET_NAME, $name) === 1);
  }

  /**
   * A template's variables, as TraceVariable records (name, type, preview).
   */
  public static function variables(array $variables, int $max): array {
    $out = [];
    foreach ($variables as $name => $value) {
      $name = (string) $name;
      if ($name === '' || $name[0] === '#' || in_array($name, self::INTERNAL, TRUE)) {
        continue;
      }
      if (count($out) >= $max) {
        break;
      }
      $out[] = ['name' => $name, 'type' => self::type($value), 'preview' => self::secretName($name) ? '[redacted]' : self::of($value)];
    }
    return $out;
  }

  public static function type(mixed $value): string {
    return get_debug_type($value);
  }

  /**
   * A value, bounded to the preview limit.
   */
  public static function of(mixed $value, int $depth = 0): string {
    return mb_substr(self::render($value, $depth), 0, Recorder::LIMITS['preview']);
  }

  private static function render(mixed $value, int $depth): string {
    if ($value === NULL) {
      return 'null';
    }
    if (is_bool($value)) {
      return $value ? 'true' : 'false';
    }
    if (is_int($value) || is_float($value)) {
      return (string) $value;
    }
    if (is_string($value)) {
      return self::text($value);
    }
    if ($value instanceof Attribute) {
      return trim(self::text((string) $value));
    }
    if ($value instanceof MarkupInterface) {
      return self::text((string) $value);
    }
    if ($value instanceof EntityInterface) {
      return $value->getEntityTypeId() . ' ' . ($value->id() ?? 'new') . ' · ' . self::text((string) $value->label());
    }
    if ($value instanceof AccountInterface) {
      return 'user ' . $value->id() . ' · ' . self::text((string) $value->getDisplayName());
    }
    if ($value instanceof FieldItemListInterface) {
      return count($value) . ' item(s) of ' . $value->getFieldDefinition()->getType();
    }
    if ($value instanceof Url) {
      try {
        return $value->toString(TRUE)->getGeneratedUrl();
      }
      catch (\Throwable) {
        return 'Url';
      }
    }
    if (is_object($value)) {
      return get_class($value);
    }
    if (is_array($value)) {
      return self::arrayOf($value, $depth);
    }
    return get_debug_type($value);
  }

  private static function arrayOf(array $value, int $depth): string {
    $keys = array_keys($value);
    $render = array_filter($keys, fn ($k) => is_string($k) && $k !== '' && $k[0] === '#');
    if ($render) {
      // A render array: what it is, never its rendering.
      $parts = [];
      foreach (['#type', '#theme', '#markup', '#plain_text', '#title'] as $k) {
        if (isset($value[$k]) && (is_scalar($value[$k]) || $value[$k] instanceof MarkupInterface)) {
          $parts[] = $k . ' ' . self::text((string) $value[$k], 80);
        }
      }
      $children = array_values(array_filter($keys, fn ($k) => !is_string($k) || $k === '' || $k[0] !== '#'));
      if ($children) {
        $parts[] = count($children) . ' children (' . implode(', ', array_slice($children, 0, 8)) . (count($children) > 8 ? ', …' : '') . ')';
      }
      return 'render array: ' . ($parts ? implode(', ', $parts) : implode(', ', array_slice($render, 0, 8)));
    }
    if ($depth >= 2) {
      return 'array(' . count($value) . ')';
    }
    $out = [];
    $length = 0;
    foreach ($value as $k => $v) {
      $item = (array_is_list($value) ? '' : $k . ': ') . (self::secretName($k) ? '[redacted]' : self::render($v, $depth + 1));
      $out[] = $item;
      $length += strlen($item);
      if ($length > Recorder::LIMITS['preview']) {
        $out[] = '…';
        break;
      }
    }
    return (array_is_list($value) ? '[' : '{') . implode(', ', $out) . (array_is_list($value) ? ']' : '}');
  }

  private static function text(string $text, int $max = 400): string {
    $text = trim(preg_replace('/\s+/u', ' ', $text) ?? $text);
    // A long run of token characters, or a password hash: not shown.
    if (preg_match('~^\$2[aby]\$|^\$argon2~', $text) || (preg_match('~^[A-Za-z0-9+/_=-]{32,}$~', $text) && !preg_match('~^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$~i', $text))) {
      return '[redacted]';
    }
    return mb_substr($text, 0, $max);
  }

  /**
   * A cheap fingerprint of each variable, to diff before and after a step.
   */
  public static function snapshot(array $variables): array {
    $out = [];
    foreach ($variables as $name => $value) {
      $out[$name] = self::fingerprint($value);
    }
    return $out;
  }

  /**
   * The variables a step set, changed or removed.
   */
  public static function changed(?array $before, array $variables): array {
    if ($before === NULL) {
      return [];
    }
    $after = self::snapshot($variables);
    $changed = [];
    foreach ($after as $name => $print) {
      if (!array_key_exists($name, $before) || $before[$name] !== $print) {
        $changed[] = (string) $name;
      }
    }
    foreach (array_diff_key($before, $after) as $name => $print) {
      $changed[] = (string) $name;
    }
    return array_slice($changed, 0, 100);
  }

  private static function fingerprint(mixed $value): string {
    if ($value === NULL || is_scalar($value)) {
      return gettype($value) . ':' . (is_string($value) && strlen($value) > 64 ? md5($value) : var_export($value, TRUE));
    }
    if ($value instanceof Attribute) {
      return 'A:' . md5((string) $value);
    }
    if (is_object($value)) {
      return 'o:' . spl_object_id($value);
    }
    $print = count($value) . ':';
    foreach ($value as $k => $v) {
      $print .= $k . '=' . match (TRUE) {
        is_string($v) => strlen($v) > 32 ? md5($v) : $v,
        is_scalar($v) => var_export($v, TRUE),
        is_array($v) => 'a' . count($v),
        $v instanceof Attribute => 'A' . md5((string) $v),
        is_object($v) => 'o' . spl_object_id($v),
        default => 'n',
      } . ';';
      if (strlen($print) > 4000) {
        break;
      }
    }
    return md5($print);
  }

}
`;

export const DRUPAL_TRACE_FILES: Readonly<Record<string, string>> = {
  'src/Trace/Recorder.php': RECORDER,
  'src/Trace/Frame.php': FRAME,
  'src/Trace/FiberState.php': FIBER_STATE,
  'src/Trace/Source.php': SOURCE,
  'src/Trace/Preview.php': PREVIEW,
};
