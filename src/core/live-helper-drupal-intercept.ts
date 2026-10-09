// Where the Drupal helper's trace hooks into core: each class extends the core
// service it times or marks, and calls the core method it overrides, so the
// order and result are core's own. WaniganLiveServiceProvider swaps a class
// in only when core's class and method signatures are the ones written here
// (Drupal 11.4); otherwise core's own class stays and that part of the trace
// is simply absent. Map and edge cases: docs/research/2026-10-09-drupal-core-live-trace.md.

const PROVIDER = String.raw`<?php

namespace Drupal\wanigan_live;

use Drupal\Core\DependencyInjection\ContainerBuilder;
use Drupal\Core\DependencyInjection\ServiceModifierInterface;

/**
 * Puts the trace's subclasses in place of core's services, only where core's
 * class and the methods they extend are exactly as these were written for.
 *
 * Core calls ::alter() while compiling the container (DrupalKernel::
 * compileContainer()); a module's provider is found by its name. When core
 * changes one of these signatures, that service keeps core's class: the trace
 * loses that piece, and the site never loads a class that no longer fits.
 */
final class WaniganLiveServiceProvider implements ServiceModifierInterface {

  /**
   * Service id => [core class, the trace's class, [class => [method => signature]]].
   */
  private const SWAPS = [
    'module_handler' => [
      'Drupal\Core\Extension\ModuleHandler',
      'Drupal\wanigan_live\Trace\TraceModuleHandler',
      ['Drupal\Core\Extension\ModuleHandler' => [
        'invokeAllWith' => '(string $hook, callable $callback): void',
        'invoke' => '($module, $hook, array $args)',
        'alter' => '($type, &$data, &$context1, &$context2)',
        'getHookImplementationList' => '(string $hook): Drupal\Core\Hook\ImplementationList',
        'getCombinedListeners' => '(array $hooks): array',
      ]],
    ],
    'theme.manager' => [
      'Drupal\Core\Theme\ThemeManager',
      'Drupal\wanigan_live\Trace\TraceThemeManager',
      ['Drupal\Core\Theme\ThemeManager' => [
        'invokeAllWith' => '(string $hook, callable $callback): void',
        'invoke' => '(string $theme, string $hook, array $args)',
        'alterForTheme' => '(Drupal\Core\Theme\ActiveTheme $theme, $type, &$data, &$context1, &$context2)',
        'getImplementationsForTheme' => '(string $theme_key, string $hook): array',
        'getThemeChain' => '(Drupal\Core\Theme\ActiveTheme $active_theme): array',
      ]],
    ],
    'theme.registry' => [
      'Drupal\Core\Theme\Registry',
      'Drupal\wanigan_live\Trace\TraceRegistry',
      [
        'Drupal\Core\Theme\Registry' => ['getRuntime' => '()'],
        'Drupal\Core\Utility\ThemeRegistry' => [
          'has' => '($key)',
          'get' => '($key)',
          'set' => '($key, $value)',
          'delete' => '($key)',
          'reset' => '()',
          'clear' => '()',
          'destruct' => '()',
          'resolveCacheMiss' => '($key)',
          'initializeRegistry' => '()',
          'getPreprocessInvokes' => '(): array',
          'getGlobalPreprocess' => '(): array',
        ],
      ],
    ],
    'renderer' => [
      'Drupal\Core\Render\Renderer',
      'Drupal\wanigan_live\Trace\TraceRenderer',
      ['Drupal\Core\Render\Renderer' => [
        'doRender' => '(array &$elements, Drupal\Core\Render\RenderContext $context): Drupal\Component\Render\MarkupInterface|string',
        'doRenderPlaceholder' => '(array &$placeholder_element): Drupal\Component\Render\MarkupInterface|string',
        'executeInRenderContext' => '(Drupal\Core\Render\RenderContext $context, callable $callable)',
      ]],
    ],
    'Drupal\Core\Template\TwigThemeEngine' => [
      'Drupal\Core\Template\TwigThemeEngine',
      'Drupal\wanigan_live\Trace\TraceThemeEngine',
      ['Drupal\Core\Template\TwigThemeEngine' => [
        'renderTemplate' => '(string $template_file, array $variables): Drupal\Component\Render\MarkupInterface|string',
      ]],
    ],
  ];

  /**
   * {@inheritdoc}
   */
  public function alter(ContainerBuilder $container) {
    foreach (self::SWAPS as $id => [$core, $ours, $signatures]) {
      if (!$container->hasDefinition($id) || !class_exists($core)) {
        continue;
      }
      $definition = $container->getDefinition($id);
      if (ltrim((string) ($definition->getClass() ?? $id), '\\') !== $core || !self::fits($signatures)) {
        continue;
      }
      $definition->setClass($ours);
    }
  }

  /**
   * Whether every method is there with exactly the signature expected.
   */
  public static function fits(array $signatures): bool {
    foreach ($signatures as $class => $methods) {
      if (!class_exists($class)) {
        return FALSE;
      }
      foreach ($methods as $method => $expected) {
        if (!method_exists($class, $method) || self::signature(new \ReflectionMethod($class, $method)) !== $expected) {
          return FALSE;
        }
      }
    }
    return TRUE;
  }

  public static function signature(\ReflectionMethod $method): string {
    $params = [];
    foreach ($method->getParameters() as $param) {
      $type = $param->getType();
      $params[] = ($type ? self::type($type) . ' ' : '') . ($param->isPassedByReference() ? '&' : '') . '$' . $param->getName();
    }
    $return = $method->getReturnType();
    return '(' . implode(', ', $params) . ')' . ($return ? ': ' . self::type($return) : '');
  }

  private static function type(\ReflectionType $type): string {
    if ($type instanceof \ReflectionUnionType) {
      $names = array_map(fn ($t) => ltrim((string) $t, '?'), $type->getTypes());
      sort($names);
      return implode('|', $names);
    }
    return ltrim((string) $type, '?');
  }

}
`;

const MODULE_HANDLER = String.raw`<?php

namespace Drupal\wanigan_live\Trace;

use Drupal\Core\Extension\ModuleHandler;

/**
 * Core's module handler, timing each hook implementation of a traced request.
 *
 * Extends core/lib/Drupal/Core/Extension/ModuleHandler.php (11.4). Which
 * implementations run, and in what order, stays core's: OOP (#[Hook]) and
 * procedural ones alike come from ::getHookImplementationList(), and alters
 * from ::getCombinedListeners() with its ordering rules. ::invokeAllWith()
 * times the callback core hands each implementation to; nearly every caller
 * calls the implementation there once, and the few that only list who
 * implements a hook show as turns of almost no time.
 */
class TraceModuleHandler extends ModuleHandler {

  /**
   * {@inheritdoc}
   */
  public function invokeAllWith(string $hook, callable $callback): void {
    $recorder = Recorder::$on;
    if ($recorder === NULL) {
      parent::invokeAllWith($hook, $callback);
      return;
    }
    parent::invokeAllWith($hook, static function (callable $listener, string $module) use ($callback, $hook, $recorder) {
      $t0 = hrtime(TRUE);
      try {
        return $callback($listener, $module);
      }
      finally {
        $recorder->hook($hook, $module, $listener, $t0);
      }
    });
  }

  /**
   * {@inheritdoc}
   */
  public function invoke($module, $hook, array $args = []) {
    $recorder = Recorder::$on;
    if ($recorder === NULL) {
      return parent::invoke($module, $hook, $args);
    }
    $listener = $this->listenerFor($module, $hook);
    if ($listener === NULL) {
      return parent::invoke($module, $hook, $args);
    }
    $t0 = hrtime(TRUE);
    try {
      return parent::invoke($module, $hook, $args);
    }
    finally {
      $recorder->hook($hook, $module, $listener, $t0);
    }
  }

  /**
   * {@inheritdoc}
   *
   * The same listeners in the same order as ModuleHandler::alter(), called
   * one at a time so each can be timed (core keeps the list in
   * ::$alterHookListeners; a traced request builds it fresh each time).
   */
  public function alter($type, &$data, &$context1 = NULL, &$context2 = NULL) {
    $recorder = Recorder::$on;
    if ($recorder === NULL) {
      parent::alter($type, $data, $context1, $context2);
      return;
    }
    $hooks = array_map(static fn ($t) => $t . '_alter', is_array($type) ? $type : [$type]);
    $owners = [];
    foreach ($hooks as $hook) {
      $list = $this->getHookImplementationList($hook);
      foreach ($list->listeners as $i => $listener) {
        $owners[] = [$listener, $list->modules[$i], $hook];
      }
    }
    foreach ($this->getCombinedListeners($hooks) as $listener) {
      $owner = [NULL, 'unknown', $hooks[0]];
      foreach ($owners as $candidate) {
        if ($candidate[0] === $listener) {
          $owner = $candidate;
          break;
        }
      }
      $before = is_array($data) ? self::shape($data) : NULL;
      $t0 = hrtime(TRUE);
      try {
        $listener($data, $context1, $context2);
      }
      finally {
        $recorder->hook($owner[2], $owner[1], $listener, $t0, $before !== NULL && is_array($data) ? self::changed($before, $data) : NULL);
      }
    }
  }

  /**
   * The one implementation of a hook in a module, or NULL.
   */
  public function listenerFor(string $module, string $hook): mixed {
    $listeners = $this->getHookImplementationList($hook)->getForModule($module);
    if ($listeners) {
      return reset($listeners);
    }
    return function_exists($module . '_' . $hook) ? $module . '_' . $hook : NULL;
  }

  /**
   * A list's items (theme suggestions), or an array's keys with fingerprints.
   */
  private static function shape(array $data): array {
    return array_is_list($data) && count(array_filter($data, 'is_string')) === count($data) ? ['list' => $data] : ['keys' => Preview::snapshot($data)];
  }

  private static function changed(array $before, array $data): array {
    if (isset($before['list'])) {
      return array_values(array_diff(array_filter($data, 'is_string'), $before['list']));
    }
    return Preview::changed($before['keys'], $data);
  }

}
`;

const THEME_MANAGER = String.raw`<?php

namespace Drupal\wanigan_live\Trace;

use Drupal\Core\Theme\ActiveTheme;
use Drupal\Core\Theme\ThemeManager;

/**
 * Core's theme manager, timing each theme's hook implementations.
 *
 * Extends core/lib/Drupal/Core/Theme/ThemeManager.php (11.4): themes'
 * implementations come from ::getImplementationsForTheme(), over the theme
 * chain from ::getThemeChain() (base themes first), as core runs them.
 * ::render() is untouched: what a template is shaped by is recorded by the
 * runtime registry (TraceRegistry) and the Twig engine (TraceThemeEngine).
 */
class TraceThemeManager extends ThemeManager {

  /**
   * {@inheritdoc}
   */
  public function invokeAllWith(string $hook, callable $callback): void {
    $recorder = Recorder::$on;
    if ($recorder === NULL) {
      parent::invokeAllWith($hook, $callback);
      return;
    }
    parent::invokeAllWith($hook, static function (callable $listener, string $theme) use ($callback, $hook, $recorder) {
      $t0 = hrtime(TRUE);
      try {
        return $callback($listener, $theme);
      }
      finally {
        $recorder->hook($hook, $theme, $listener, $t0);
      }
    });
  }

  /**
   * {@inheritdoc}
   */
  public function invoke(string $theme, string $hook, array $args = []) {
    $recorder = Recorder::$on;
    $listener = $recorder !== NULL ? $this->listenerFor($theme, $hook) : NULL;
    if ($listener === NULL) {
      return parent::invoke($theme, $hook, $args);
    }
    $t0 = hrtime(TRUE);
    try {
      return parent::invoke($theme, $hook, $args);
    }
    finally {
      $recorder->hook($hook, $theme, $listener, $t0);
    }
  }

  /**
   * {@inheritdoc}
   *
   * The listeners ThemeManager::alterForTheme() gathers, in its order (each
   * theme of the chain: the generic hook, then the specific ones), called one
   * at a time so each can be timed.
   */
  public function alterForTheme(ActiveTheme $theme, $type, &$data, &$context1 = NULL, &$context2 = NULL) {
    $recorder = Recorder::$on;
    if ($recorder === NULL) {
      parent::alterForTheme($theme, $type, $data, $context1, $context2);
      return;
    }
    $types = is_array($type) ? array_values($type) : [$type];
    foreach ($this->getThemeChain($theme) as $theme_key) {
      foreach ($types as $one) {
        foreach ($this->getImplementationsForTheme($theme_key, $one . '_alter') as $listener) {
          if (!$listener) {
            continue;
          }
          $before = is_array($data) && array_is_list($data) ? $data : NULL;
          $t0 = hrtime(TRUE);
          try {
            $listener($data, $context1, $context2);
          }
          finally {
            $recorder->hook($one . '_alter', $theme_key, $listener, $t0, $before !== NULL && is_array($data) ? array_values(array_diff(array_filter($data, 'is_string'), array_filter($before, 'is_string'))) : NULL);
          }
        }
      }
    }
  }

  /**
   * A theme's one implementation of a hook, or NULL.
   */
  public function listenerFor(string $theme, string $hook): mixed {
    $listeners = $this->getImplementationsForTheme($theme, $hook);
    return $listeners ? reset($listeners) : NULL;
  }

}
`;

const REGISTRY = String.raw`<?php

namespace Drupal\wanigan_live\Trace;

use Drupal\Core\Theme\Registry;

/**
 * Core's theme registry, handing a traced request a runtime registry whose
 * hooks report what shaped them.
 *
 * Extends core/lib/Drupal/Core/Theme/Registry.php (11.4). ThemeManager::
 * render() reads every hook's definition from ::getRuntime(); for a traced
 * request only, that is TracedRuntime around core's own runtime registry,
 * which is still the one cached and destructed as before.
 */
class TraceRegistry extends Registry {

  private ?TracedRuntime $traced = NULL;

  /**
   * {@inheritdoc}
   */
  public function getRuntime() {
    $runtime = parent::getRuntime();
    if (Recorder::$on === NULL) {
      return $runtime;
    }
    if ($this->traced === NULL || $this->traced->inner !== $runtime) {
      $this->traced = new TracedRuntime($runtime);
    }
    return $this->traced;
  }

  /**
   * Core's runtime registry, never the traced one.
   */
  public function coreRuntime() {
    return parent::getRuntime();
  }

}
`;

const TRACED_RUNTIME = String.raw`<?php

namespace Drupal\wanigan_live\Trace;

use Drupal\Core\Utility\ThemeRegistry;

/**
 * Core's runtime theme registry, as a traced request sees it: every hook's
 * preprocess callbacks wrapped so each is timed and its changes noted.
 *
 * ThemeManager::render() (core/lib/Drupal/Core/Theme/ThemeManager.php, 11.4)
 * calls 'initial preprocess' first, then each 'preprocess functions' entry
 * through its invoke map ('preprocess invokes': module and theme hooks, OOP
 * or procedural), and the global preprocess callbacks just before the first
 * entry that is not a template_ function (or after the loop when there is
 * none). The wrapped definition keeps exactly that order with the global
 * callbacks folded into the list, and ::getGlobalPreprocess() answers none,
 * so nothing runs twice and nothing runs out of order. Definitions are copied:
 * core's runtime registry, which is cached, never holds a wrapper.
 */
class TracedRuntime extends ThemeRegistry {

  /**
   * Core's constructor is not called: this holds no cache of its own.
   */
  public function __construct(public readonly ThemeRegistry $inner) {}

  public function has($key) {
    return $this->inner->has($key);
  }

  public function get($key) {
    $info = $this->inner->get($key);
    if (!is_array($info) || $key === 'preprocess invokes' || $key === 'global preprocess') {
      return $info;
    }
    return $this->wrap($info);
  }

  public function set($key, $value) {
    $this->inner->set($key, $value);
  }

  public function delete($key) {
    $this->inner->delete($key);
  }

  public function reset() {
    $this->inner->reset();
  }

  public function clear() {
    $this->inner->clear();
  }

  /**
   * Nothing to write: core destructs its own runtime registry.
   */
  public function destruct() {}

  public function resolveCacheMiss($key) {
    return $this->inner->resolveCacheMiss($key);
  }

  public function initializeRegistry() {
    return $this->inner->initializeRegistry();
  }

  public function getPreprocessInvokes(): array {
    return $this->inner->getPreprocessInvokes();
  }

  /**
   * Folded into each definition by ::wrap(), in core's order.
   */
  public function getGlobalPreprocess(): array {
    return [];
  }

  private function wrap(array $info): array {
    $invokes = $this->inner->getPreprocessInvokes();
    $globals = $this->inner->getGlobalPreprocess();
    $holder = new \stdClass();
    $holder->frame = NULL;
    $initial = $info['initial preprocess'] ?? NULL;
    $info['initial preprocess'] = static function (array &$variables, $hook, $info) use ($initial, $holder) {
      $recorder = Recorder::$on;
      if ($recorder !== NULL) {
        $holder->frame = $recorder->beginTheme((string) $hook, $info, $variables);
      }
      if (empty($initial)) {
        return;
      }
      // Resolved as ThemeManager::render() does; an invalid definition throws
      // the same InvalidArgumentException, which core catches and logs.
      $callable = is_callable($initial) ? $initial : \Drupal::service('callable_resolver')->getCallableFromDefinition($initial);
      $before = $holder->frame ? Preview::snapshot($variables) : NULL;
      $t0 = hrtime(TRUE);
      try {
        $callable($variables, $hook, $info);
      }
      finally {
        if ($recorder !== NULL && $holder->frame) {
          $recorder->themeStep($holder->frame, $initial, 'initial preprocess', NULL, $t0, Preview::changed($before, $variables));
        }
      }
    };
    $steps = [];
    $globals_done = FALSE;
    foreach ($info['preprocess functions'] ?? [] as $function) {
      if (!$globals_done && is_string($function) && !str_starts_with($function, 'template_')) {
        $globals_done = TRUE;
        foreach ($globals as $global) {
          $steps[] = self::step($global, $invokes, $holder);
        }
      }
      $steps[] = self::step($function, $invokes, $holder);
    }
    if (!$globals_done) {
      foreach ($globals as $global) {
        $steps[] = self::step($global, $invokes, $holder);
      }
    }
    // Last, after every preprocess of the site: the helper's own marks.
    $steps[] = static function (array &$variables, $hook, $info) use ($holder) {
      if (Recorder::$on !== NULL && $holder->frame) {
        Marks::afterPreprocess(Recorder::$on, $holder->frame, $variables);
      }
    };
    $info['preprocess functions'] = $steps;
    return $info;
  }

  /**
   * One preprocess callback, run as ThemeManager::render() runs it.
   */
  private static function step(mixed $function, array $invokes, \stdClass $holder): \Closure {
    return static function (array &$variables, $hook, $info) use ($function, $invokes, $holder) {
      $recorder = Recorder::$on;
      $frame = $holder->frame;
      $before = ($recorder !== NULL && $frame) ? Preview::snapshot($variables) : NULL;
      $name = 'preprocess';
      $by = NULL;
      $t0 = hrtime(TRUE);
      try {
        if (is_string($function) && isset($invokes[$function])) {
          $name = $invokes[$function]['hook'];
          if (isset($invokes[$function]['module'])) {
            $by = $invokes[$function]['module'];
            \Drupal::moduleHandler()->invoke($by, $name, [&$variables, $hook, $info]);
          }
          else {
            $by = $invokes[$function]['theme'];
            \Drupal::theme()->invoke($by, $name, [&$variables, $hook, $info]);
          }
        }
        elseif (is_callable($function)) {
          call_user_func_array($function, [&$variables, $hook, $info]);
        }
      }
      finally {
        if ($recorder !== NULL && $frame) {
          $recorder->themeStep($frame, $function, $name, $by, $t0, Preview::changed($before, $variables));
        }
      }
    };
  }

}
`;

const ENGINE = String.raw`<?php

namespace Drupal\wanigan_live\Trace;

use Drupal\Component\Render\MarkupInterface;
use Drupal\Core\Template\TwigThemeEngine;

/**
 * Core's Twig theme engine, marking each template's output as a part.
 *
 * Extends core/lib/Drupal/Core/Template/TwigThemeEngine.php (11.3 and later,
 * where theme engines are services: ThemeManager::getThemeEngine()).
 * ::renderTemplate() is the one place a template's final variables, its file
 * and its output meet. Core's own Twig debug comments stay inside the marks.
 */
class TraceThemeEngine extends TwigThemeEngine {

  /**
   * {@inheritdoc}
   */
  public function renderTemplate(string $template_file, array $variables): string|MarkupInterface {
    $recorder = Recorder::$on;
    if ($recorder === NULL) {
      return parent::renderTemplate($template_file, $variables);
    }
    $original = (string) ($variables['theme_hook_original'] ?? '');
    $frame = $recorder->themeFrame($original) ?? $recorder->push(new Frame('T', ['hook' => $original, 'original' => $original, 'base' => preg_replace('/__.*$/', '', $original), 'key' => NULL, 'element' => NULL]));
    try {
      $output = parent::renderTemplate($template_file, $variables);
    }
    catch (\Throwable $e) {
      $recorder->pop($frame);
      throw $e;
    }
    return $recorder->themePart($frame, $template_file . '.html.twig', $variables, $output);
  }

}
`;

const RENDERER = String.raw`<?php

namespace Drupal\wanigan_live\Trace;

use Drupal\Component\Render\MarkupInterface;
use Drupal\Core\Cache\Cache;
use Drupal\Core\Render\RenderContext;
use Drupal\Core\Render\Renderer;

/**
 * Core's renderer, noting each element's cost, cache metadata and assets.
 *
 * Extends core/lib/Drupal/Core/Render/Renderer.php (11.4).
 * - ::doRender(): one frame per element. A traced render reads and writes no
 *   render cache: core would serve a cached element without running what
 *   made it (no preprocess, no template), and would store this request's
 *   marks for others. So the element's keys are taken off after asking the
 *   render cache whether a normal request would be served it ('hit' or
 *   'miss'), with the required cache contexts merged as core merges them.
 *   After core renders it, the element carries its bubbled #cache and
 *   #attached (RenderContext::update()), which is what the trace reports.
 * - ::executeInRenderContext(): core renders each isolated subtree in a new
 *   Fiber; the frame it starts from is handed to that Fiber.
 * - ::doRenderPlaceholder(): a placeholder is rendered later, in its own
 *   Fiber; it is given the frame it was cut out of, and called 'placeholder'.
 */
class TraceRenderer extends Renderer {

  /**
   * {@inheritdoc}
   */
  protected function doRender(array &$elements, RenderContext $context): string|MarkupInterface {
    $recorder = Recorder::$on;
    if ($recorder === NULL || !$elements) {
      return parent::doRender($elements, $context);
    }
    $frame = $recorder->push(new Frame('R', [
      'theme' => $elements['#theme'] ?? NULL,
      'type' => $elements['#type'] ?? NULL,
      'component' => $elements['#component'] ?? NULL,
    ]));
    if ($recorder->placeholders > 0 && isset($elements['#lazy_builder']) && ($elements['#create_placeholder'] ?? NULL) === FALSE) {
      $frame->info['status'] = 'placeholder';
    }
    if (isset($elements['#cache']['keys'])) {
      $elements['#cache']['contexts'] = Cache::mergeContexts($elements['#cache']['contexts'] ?? [], $this->rendererConfig['required_cache_contexts'] ?? []);
      if (empty($elements['#create_placeholder']) && !isset($frame->info['status'])) {
        try {
          $frame->info['status'] = $this->renderCache->get($elements) !== FALSE ? 'hit' : 'miss';
        }
        catch (\Throwable) {
          // A cache that cannot be asked: no status.
        }
      }
      unset($elements['#cache']['keys']);
    }
    try {
      $markup = parent::doRender($elements, $context);
    }
    catch (\Throwable $e) {
      $recorder->pop($frame);
      throw $e;
    }
    return $recorder->leaveElement($frame, $elements, $markup);
  }

  /**
   * {@inheritdoc}
   */
  public function executeInRenderContext(RenderContext $context, callable $callable) {
    $recorder = Recorder::$on;
    if ($recorder === NULL) {
      return parent::executeInRenderContext($context, $callable);
    }
    $base = $recorder->top();
    return parent::executeInRenderContext($context, static function () use ($callable, $base, $recorder) {
      $recorder->state()->base = $base;
      return $callable();
    });
  }

  /**
   * {@inheritdoc}
   */
  protected function doRenderPlaceholder(array &$placeholder_element): MarkupInterface|string {
    $recorder = Recorder::$on;
    if ($recorder === NULL) {
      return parent::doRenderPlaceholder($placeholder_element);
    }
    $state = $recorder->state();
    $previous = $state->base;
    $lazy = $placeholder_element['#lazy_builder'] ?? NULL;
    if ($lazy !== NULL) {
      $state->base = $recorder->placeholderFrames[md5(serialize($lazy))] ?? $previous;
    }
    $recorder->placeholders++;
    try {
      return parent::doRenderPlaceholder($placeholder_element);
    }
    finally {
      $recorder->placeholders--;
      $state->base = $previous;
    }
  }

}
`;

const PLACEHOLDERS = String.raw`<?php

namespace Drupal\wanigan_live\Trace;

use Drupal\Core\Render\Placeholder\PlaceholderStrategyInterface;

/**
 * Renders a traced page's placeholders into the page itself.
 *
 * Core's ChainedPlaceholderStrategy (core/lib/Drupal/Core/Render/Placeholder/
 * ChainedPlaceholderStrategy.php) asks each strategy in priority order, and
 * a placeholder one strategy keeps is not offered to the next. Tagged above
 * all of them, this keeps every placeholder of a traced request only, which
 * HtmlResponseAttachmentsProcessor::renderPlaceholders() then renders before
 * the response leaves, as the single-flush strategy would: so BigPipe has
 * nothing to stream after the trace is stored. Every other request, it keeps
 * none, and the chain is as it was.
 */
final class TracePlaceholderStrategy implements PlaceholderStrategyInterface {

  /**
   * {@inheritdoc}
   */
  public function processPlaceholders(array $placeholders) {
    return Recorder::$on !== NULL ? $placeholders : [];
  }

}
`;

const TWIG = String.raw`<?php

namespace Drupal\wanigan_live\Trace;

use Drupal\Core\Render\Markup;
use Drupal\Core\Theme\ComponentPluginManager;
use Twig\Extension\AbstractExtension;
use Twig\TwigFunction;

/**
 * Marks each single-directory component a page renders, however it is
 * rendered: from a render element (ComponentElement embeds it in an inline
 * template) or from Twig code ({{ include() }}, {% embed %}).
 *
 * A Twig extension, as core's own ComponentsTwigExtension is; its node
 * visitor (ComponentPartVisitor) adds the two calls to every component
 * template. They print nothing unless the request is traced.
 */
final class TraceTwigExtension extends AbstractExtension {

  public function __construct(private readonly ComponentPluginManager $components) {}

  /**
   * {@inheritdoc}
   */
  public function getNodeVisitors(): array {
    return class_exists('Twig\Node\Nodes') ? [new ComponentPartVisitor($this->components)] : [];
  }

  /**
   * {@inheritdoc}
   */
  public function getFunctions(): array {
    return [
      new TwigFunction('wanigan_live_part_open', [$this, 'open'], ['needs_context' => TRUE, 'is_safe' => ['html']]),
      new TwigFunction('wanigan_live_part_close', [$this, 'close'], ['is_safe' => ['html']]),
    ];
  }

  public function open(array $context, string $component): string {
    $recorder = Recorder::$on;
    return $recorder === NULL ? '' : $recorder->componentOpen($component, $context);
  }

  public function close(string $component): string {
    $recorder = Recorder::$on;
    return $recorder === NULL ? '' : $recorder->componentClose($component);
  }

  public function components(): ComponentPluginManager {
    return $this->components;
  }

}
`;

const VISITOR = String.raw`<?php

namespace Drupal\wanigan_live\Trace;

use Drupal\Core\Render\Component\Exception\ComponentNotFoundException;
use Drupal\Core\Theme\ComponentPluginManager;
use Twig\Environment;
use Twig\Node\Expression\ConstantExpression;
use Twig\Node\Expression\FunctionExpression;
use Twig\Node\ModuleNode;
use Twig\Node\Node;
use Twig\Node\Nodes;
use Twig\Node\PrintNode;
use Twig\NodeVisitor\NodeVisitorInterface;
use Twig\TwigFunction;

/**
 * Brackets every component template's output with the trace's two calls.
 *
 * Finds component templates exactly as core's ComponentNodeVisitor does
 * (core/lib/Drupal/Core/Template/ComponentNodeVisitor.php: the template name
 * is a component id the plugin manager knows), and runs after it (priority
 * 260 > 250), so the marks sit outside core's own "Component start/end"
 * debug comments. Twig keeps compiled templates per extension set, so they
 * are compiled afresh when the helper is added or removed.
 */
final class ComponentPartVisitor implements NodeVisitorInterface {

  public function __construct(private readonly ComponentPluginManager $components) {}

  public function enterNode(Node $node, Environment $env): Node {
    return $node;
  }

  public function leaveNode(Node $node, Environment $env): ?Node {
    if (!$node instanceof ModuleNode) {
      return $node;
    }
    $id = (string) $node->getTemplateName();
    if (!preg_match('/^[a-z]([a-zA-Z0-9_-]*[a-zA-Z0-9])*:[a-z]([a-zA-Z0-9_-]*[a-zA-Z0-9])*$/', $id)) {
      return $node;
    }
    try {
      $this->components->find($id);
    }
    catch (ComponentNotFoundException) {
      return $node;
    }
    $line = $node->getTemplateLine();
    $extension = $env->getExtension(TraceTwigExtension::class);
    $open = new PrintNode(new FunctionExpression(
      new TwigFunction('wanigan_live_part_open', [$extension, 'open'], ['needs_context' => TRUE, 'is_safe' => ['html']]),
      new Nodes([new ConstantExpression($id, $line)]),
      $line
    ), $line);
    $close = new PrintNode(new FunctionExpression(
      new TwigFunction('wanigan_live_part_close', [$extension, 'close'], ['is_safe' => ['html']]),
      new Nodes([new ConstantExpression($id, $line)]),
      $line
    ), $line);
    $node->setNode('display_start', new Nodes([$open, $node->getNode('display_start')]));
    $node->setNode('display_end', new Nodes([$node->getNode('display_end'), $close]));
    return $node;
  }

  public function getPriority(): int {
    return 260;
  }

}
`;

const LOGGER = String.raw`<?php

namespace Drupal\wanigan_live\Trace;

use Drupal\Core\Logger\LogMessageParserInterface;
use Drupal\Core\Logger\RfcLoggerTrait;
use Drupal\Core\Logger\RfcLogLevel;
use Psr\Log\LoggerInterface;

/**
 * Keeps what the site logs while a traced request renders.
 *
 * A logger, tagged as core's dblog and syslog are: LoggerChannelFactory adds
 * it to every channel (core/lib/Drupal/Core/Logger/LoggerChannelFactory.php).
 */
final class TraceLogger implements LoggerInterface {

  use RfcLoggerTrait;

  public function __construct(private readonly LogMessageParserInterface $parser) {}

  /**
   * {@inheritdoc}
   */
  public function log($level, string|\Stringable $message, array $context = []): void {
    $recorder = Recorder::$on;
    if ($recorder === NULL) {
      return;
    }
    $text = (string) $message;
    $values = $context;
    $placeholders = $this->parser->parseMessagePlaceholders($text, $values);
    $text = strip_tags(strtr($text, array_map(static fn ($v) => is_scalar($v) || $v instanceof \Stringable ? (string) $v : get_debug_type($v), $placeholders)));
    $level = is_int($level) ? $level : RfcLogLevel::INFO;
    $name = $level <= RfcLogLevel::ERROR ? 'error' : ($level === RfcLogLevel::WARNING ? 'warning' : ($level === RfcLogLevel::NOTICE ? 'notice' : 'info'));
    $channel = (string) ($context['channel'] ?? '');
    $recorder->log($name, mb_substr(($channel !== '' ? $channel . ': ' : '') . trim(preg_replace('/\s+/u', ' ', $text) ?? $text), 0, 2000), isset($context['%file']) ? (string) $context['%file'] : NULL, isset($context['%line']) ? (int) $context['%line'] : NULL);
  }

}
`;

const SUBSCRIBER = String.raw`<?php

namespace Drupal\wanigan_live\Trace;

use Drupal\Core\Database\Database;
use Drupal\Core\Database\Event\StatementExecutionEndEvent;
use Drupal\Core\Database\Event\StatementExecutionStartEvent;
use Drupal\Core\Render\HtmlResponse;
use Drupal\wanigan_live\Token;
use Symfony\Component\EventDispatcher\EventSubscriberInterface;
use Symfony\Component\HttpKernel\Event\RequestEvent;
use Symfony\Component\HttpKernel\Event\ResponseEvent;
use Symfony\Component\HttpKernel\KernelEvents;

/**
 * Starts a trace for a page the live view asks for, and stores it as the
 * page leaves.
 *
 * Only a main GET request for an HTML page that carries the token is traced
 * (not AJAX, not another wrapper format, not the helper's own routes but a
 * piece). The trace is finished after every core response subscriber has
 * run (BigPipe's last one is at -10000), so the page it describes is the page
 * that is sent.
 */
final class TraceSubscriber implements EventSubscriberInterface {

  public function __construct(
    private readonly Token $token,
    private readonly TraceStore $store,
  ) {}

  public static function getSubscribedEvents(): array {
    return [
      KernelEvents::REQUEST => [['start', 1000]],
      KernelEvents::RESPONSE => [['finish', -10050]],
      KernelEvents::TERMINATE => [['terminate', 0]],
      StatementExecutionEndEvent::class => [['query', 0]],
    ];
  }

  public function start(RequestEvent $event): void {
    if (!$event->isMainRequest() || Recorder::$on !== NULL) {
      return;
    }
    $request = $event->getRequest();
    $wrapper = $request->query->get('_wrapper_format');
    $path = $request->getPathInfo();
    if (!$request->isMethod('GET') || $request->isXmlHttpRequest() || ($wrapper !== NULL && $wrapper !== 'html')
      || (str_contains($path, '/_wanigan/') && !str_contains($path, '/_wanigan/piece/')) || !$this->token->carried($request)) {
      return;
    }
    $recorder = new Recorder($request->getRequestUri());
    Recorder::$on = $recorder;
    // Statement events, as Database::startLog() switches them on, on this
    // request's connection only (Connection::enableEvents(), 10.1 and later).
    try {
      $connection = Database::getConnection();
      foreach ([StatementExecutionStartEvent::class, StatementExecutionEndEvent::class] as $name) {
        if (!$connection->isEventEnabled($name)) {
          $connection->enableEvents([$name]);
          $recorder->enabledEvents[] = $name;
        }
      }
    }
    catch (\Throwable) {
      // No database connection to listen to: a trace without queries.
    }
  }

  public function query(StatementExecutionEndEvent $event): void {
    Recorder::$on?->query($event->queryString, $event->getElapsedTime() * 1000, $event->caller);
  }

  public function finish(ResponseEvent $event): void {
    $recorder = Recorder::$on;
    if ($recorder === NULL || !$event->isMainRequest()) {
      return;
    }
    Recorder::$on = NULL;
    $this->stop($recorder);
    $response = $event->getResponse();
    if (!$response instanceof HtmlResponse || !is_string($response->getContent())) {
      return;
    }
    try {
      [$trace, $private, $html] = (new TraceBuilder($recorder))->build($response->getContent());
      $response->setContent($html);
      $this->store->save($recorder->id, $trace, $private);
      $response->headers->set('X-Wanigan-Trace', $recorder->id);
    }
    catch (\Throwable $e) {
      \Drupal::logger('wanigan_live')->warning('The live view could not build a trace of @url: @message', ['@url' => $recorder->url, '@message' => $e->getMessage()]);
    }
  }

  public function terminate(): void {
    if (Recorder::$on !== NULL) {
      $this->stop(Recorder::$on);
      Recorder::$on = NULL;
    }
  }

  private function stop(Recorder $recorder): void {
    if ($recorder->enabledEvents) {
      try {
        Database::getConnection()->disableEvents($recorder->enabledEvents);
      }
      catch (\Throwable) {
      }
      $recorder->enabledEvents = [];
    }
  }

}
`;

const STORE = String.raw`<?php

namespace Drupal\wanigan_live\Trace;

use Drupal\Core\KeyValueStore\KeyValueExpirableFactoryInterface;
use Drupal\Core\Session\AccountInterface;

/**
 * Traces and undo records, in core's expirable key-value store.
 *
 * A trace is kept 10 minutes, and each user's last 20 only. Its JSON is what
 * GET /_wanigan/trace/{id} answers; beside it, what the helper needs to act
 * on an edit or a move (ids, orders), which is never sent.
 */
final class TraceStore {

  public const TTL = 600;
  public const KEEP = 20;

  public function __construct(
    private readonly KeyValueExpirableFactoryInterface $factory,
    private readonly AccountInterface $user,
  ) {}

  public function save(string $id, array $trace, array $private): void {
    $store = $this->factory->get('wanigan_live.trace');
    $json = json_encode($trace, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE | JSON_PARTIAL_OUTPUT_ON_ERROR);
    $packed = function_exists('gzcompress') ? gzcompress((string) $json, 6) : (string) $json;
    $uid = (int) $this->user->id();
    $store->setWithExpire($id, ['uid' => $uid, 'json' => $packed, 'gz' => function_exists('gzcompress'), 'private' => $private], self::TTL);
    $index = (array) $store->get('index.' . $uid, []);
    $index[] = $id;
    while (count($index) > self::KEEP) {
      $store->delete((string) array_shift($index));
    }
    $store->setWithExpire('index.' . $uid, $index, self::TTL);
  }

  public function json(string $id): ?string {
    $row = $this->factory->get('wanigan_live.trace')->get($id);
    if (!is_array($row) || !isset($row['json'])) {
      return NULL;
    }
    return !empty($row['gz']) ? (gzuncompress($row['json']) ?: NULL) : $row['json'];
  }

  public function private(string $id): ?array {
    $row = $this->factory->get('wanigan_live.trace')->get($id);
    return is_array($row) && isset($row['private']) ? $row['private'] : NULL;
  }

  public function keepUndo(array $record): string {
    $token = bin2hex(random_bytes(12));
    $record['uid'] = (int) $this->user->id();
    $this->factory->get('wanigan_live.undo')->setWithExpire($token, $record, self::TTL);
    return $token;
  }

  public function takeUndo(string $token): ?array {
    $store = $this->factory->get('wanigan_live.undo');
    $record = $store->get($token);
    if (!is_array($record) || ($record['uid'] ?? NULL) !== (int) $this->user->id()) {
      return NULL;
    }
    $store->delete($token);
    return $record;
  }

}
`;

export const DRUPAL_INTERCEPT_FILES: Readonly<Record<string, string>> = {
  'src/WaniganLiveServiceProvider.php': PROVIDER,
  'src/Trace/TraceModuleHandler.php': MODULE_HANDLER,
  'src/Trace/TraceThemeManager.php': THEME_MANAGER,
  'src/Trace/TraceRegistry.php': REGISTRY,
  'src/Trace/TracedRuntime.php': TRACED_RUNTIME,
  'src/Trace/TraceThemeEngine.php': ENGINE,
  'src/Trace/TraceRenderer.php': RENDERER,
  'src/Trace/TracePlaceholderStrategy.php': PLACEHOLDERS,
  'src/Trace/TraceTwigExtension.php': TWIG,
  'src/Trace/ComponentPartVisitor.php': VISITOR,
  'src/Trace/TraceLogger.php': LOGGER,
  'src/Trace/TraceSubscriber.php': SUBSCRIBER,
  'src/Trace/TraceStore.php': STORE,
};
