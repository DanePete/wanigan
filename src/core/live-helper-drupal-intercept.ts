// Where the Drupal helper's trace hooks into core: each class extends the core
// service it times or marks, and calls the core method it overrides, so the
// order and result are core's own. Core's classes changed shape across the
// releases the helper supports (10.3 to 11.4), so each service has one class
// per shape, sharing its recording through a trait; WaniganLiveServiceProvider
// puts in place the one whose core signatures are exactly the running core's,
// and keeps core's own class when none is. When the theme side cannot be
// extended (a release the helper does not know), a page's parts are still
// found through hooks every supported release has (PartsByHooks), and the
// trace says what that loses. Signatures of every supported release:
// fixtures/drupal-core-trace-signatures.json. Map and edge cases:
// docs/research/2026-10-09-drupal-core-live-trace.md.

const PROVIDER = String.raw`<?php

namespace Drupal\wanigan_live;

use Drupal\Core\DependencyInjection\ContainerBuilder;
use Drupal\Core\DependencyInjection\ServiceModifierInterface;

/**
 * Puts the trace's subclasses in place of core's services: for each, the one
 * written against the running core's own signatures, or none.
 *
 * Core calls ::alter() while compiling the container (DrupalKernel::
 * compileContainer()); a module's provider is found by its name. Each service
 * has a family of the trace's classes, one per shape its core class has taken
 * since 10.3, newest first. A family lists every core method its class
 * overrides or calls, with the exact signature it was written against (NULL:
 * a method it relies on core not having), and the properties it reads
 * ('$name' => TRUE). The first family whose every entry holds is put in
 * place, and none is loaded to decide. When none holds (a release the helper
 * does not know), or the service's class is not core's own, the service keeps
 * its class: the site never loads a class that does not fit, and the trace
 * says what it lacks (Recorder::sense()).
 *
 * Every supported release's signatures, read from its tarball, are in
 * Wanigan's src/core/fixtures/drupal-core-trace-signatures.json.
 */
final class WaniganLiveServiceProvider implements ServiceModifierInterface {

  /**
   * The Twig theme engine's service (11.3 and later), named by its class.
   */
  public const ENGINE = 'Drupal\Core\Template\TwigThemeEngine';

  /**
   * ModuleHandler's methods the timing overrides (TimesModuleHooks): the
   * same in every supported release.
   */
  private const HOOKS = [
    'invokeAllWith' => '(string $hook, callable $callback): void',
    'invoke' => '($module, $hook, array $args)',
    'alter' => '($type, &$data, &$context1, &$context2)',
  ];

  /**
   * ThemeManager::alterForTheme(), which TimesThemeHooks overrides: the same
   * in every supported release.
   */
  private const ALTER_FOR_THEME = '(Drupal\Core\Theme\ActiveTheme $theme, $type, &$data, &$context1, &$context2)';

  /**
   * The runtime theme registry's methods TracedRuntime overrides: the same in
   * every supported release; and its own, which core's must not have.
   */
  private const RUNTIME = [
    'has' => '($key)',
    'get' => '($key)',
    'set' => '($key, $value)',
    'delete' => '($key)',
    'reset' => '()',
    'clear' => '()',
    'destruct' => '()',
    'resolveCacheMiss' => '($key)',
    'initializeRegistry' => '()',
    'wrap' => NULL,
    'step' => NULL,
    'owner' => NULL,
    '$inner' => NULL,
    '$mode' => NULL,
    '$owners' => NULL,
  ];

  /**
   * Renderer's methods TracesElements overrides, the same in every supported
   * release, and the properties it reads.
   */
  private const ELEMENTS = [
    'doRenderPlaceholder' => '(array &$placeholder_element): Drupal\Component\Render\MarkupInterface|string',
    'executeInRenderContext' => '(Drupal\Core\Render\RenderContext $context, callable $callable)',
    '$rendererConfig' => TRUE,
    '$renderCache' => TRUE,
  ];

  /**
   * Service id => [core's class, [the trace's class => [class => [member =>
   * signature]]]], each family newest first.
   */
  public const SWAPS = [
    'module_handler' => ['Drupal\Core\Extension\ModuleHandler', [
      // 11.3 and later: each hook's implementation list, #[Hook] methods and
      // procedural functions alike; alters combined with ordering rules.
      'Drupal\wanigan_live\Trace\TraceModuleHandler' => [
        'Drupal\Core\Extension\ModuleHandler' => self::HOOKS + [
          'getHookImplementationList' => '(string $hook): Drupal\Core\Hook\ImplementationList',
          'getCombinedListeners' => '(array $hooks): array',
        ],
        'Drupal\Core\Hook\ImplementationList' => [
          'getForModule' => '(string $module): array',
          '$listeners' => TRUE,
          '$modules' => TRUE,
        ],
      ],
      // 11.2: listeners by module; alters combined with ordering rules.
      'Drupal\wanigan_live\Trace\TraceModuleHandler112' => [
        'Drupal\Core\Extension\ModuleHandler' => self::HOOKS + [
          'getHookListeners' => '(string $hook): array',
          'getCombinedListeners' => '(array $hooks): array',
          'getHookImplementationList' => NULL,
        ],
      ],
      // 11.1: listeners by module (#[Hook] arrives); an alter's listeners
      // gathered in alter() itself.
      'Drupal\wanigan_live\Trace\TraceModuleHandler111' => [
        'Drupal\Core\Extension\ModuleHandler' => self::HOOKS + [
          'getHookListeners' => '(string $hook): array',
          'reOrderModulesForAlter' => '(array $modules, string $hook): array',
          'getCombinedListeners' => NULL,
          '$alterEventListeners' => TRUE,
        ],
      ],
      // 10.3 to 11.0: procedural hooks only, by module.
      'Drupal\wanigan_live\Trace\TraceModuleHandler103' => [
        'Drupal\Core\Extension\ModuleHandler' => self::HOOKS + [
          'getImplementationInfo' => '($hook)',
          'hasImplementations' => '(string $hook, $modules): bool',
          'getHookListeners' => NULL,
          '$alterFunctions' => TRUE,
          '$moduleList' => TRUE,
        ],
      ],
    ]],
    'theme.manager' => ['Drupal\Core\Theme\ThemeManager', [
      // 11.3 and later: themes' hooks as implementation lists; templates are
      // rendered by theme engine services (TraceThemeEngine marks them).
      'Drupal\wanigan_live\Trace\TraceThemeManager' => [
        'Drupal\Core\Theme\ThemeManager' => [
          'invokeAllWith' => '(string $hook, callable $callback): void',
          'invoke' => '(string $theme, string $hook, array $args)',
          'alterForTheme' => self::ALTER_FOR_THEME,
          'getImplementationsForTheme' => '(string $theme_key, string $hook): array',
          'getThemeChain' => '(Drupal\Core\Theme\ActiveTheme $active_theme): array',
        ],
      ],
      // 10.3 to 11.2: themes' hooks are functions named for the theme, and
      // ::render() renders a template with twig_render_template(), so this
      // class marks each template's output there.
      'Drupal\wanigan_live\Trace\TraceThemeManager103' => [
        'Drupal\Core\Theme\ThemeManager' => [
          'render' => '($hook, array $variables)',
          'alterForTheme' => self::ALTER_FOR_THEME,
          'getImplementationsForTheme' => NULL,
          'getThemeEngine' => NULL,
        ],
      ],
    ]],
    'theme.registry' => ['Drupal\Core\Theme\Registry', [
      // 11.3 and later: initial preprocess, preprocess invokes by module or
      // theme, and global preprocess.
      'Drupal\wanigan_live\Trace\TraceRegistry' => [
        'Drupal\Core\Theme\Registry' => ['getRuntime' => '()'],
        'Drupal\Core\Utility\ThemeRegistry' => self::RUNTIME + [
          'getPreprocessInvokes' => '(): array',
          'getGlobalPreprocess' => '(): array',
        ],
      ],
      // 11.2: initial preprocess, and preprocess invokes through the module
      // handler, themes' included.
      'Drupal\wanigan_live\Trace\TraceRegistry112' => [
        'Drupal\Core\Theme\Registry' => ['getRuntime' => '()'],
        'Drupal\Core\Utility\ThemeRegistry' => self::RUNTIME + [
          'getPreprocessInvokes' => '()',
          'getGlobalPreprocess' => NULL,
        ],
      ],
      // 10.3 to 11.1: preprocess functions, each called as it is.
      'Drupal\wanigan_live\Trace\TraceRegistry103' => [
        'Drupal\Core\Theme\Registry' => ['getRuntime' => '()'],
        'Drupal\Core\Utility\ThemeRegistry' => self::RUNTIME + [
          'getPreprocessInvokes' => NULL,
          'getGlobalPreprocess' => NULL,
        ],
      ],
    ]],
    'renderer' => ['Drupal\Core\Render\Renderer', [
      // 11.2 and later: each element rendered in a render context.
      'Drupal\wanigan_live\Trace\TraceRenderer' => [
        'Drupal\Core\Render\Renderer' => self::ELEMENTS + [
          'doRender' => '(array &$elements, Drupal\Core\Render\RenderContext $context): Drupal\Component\Render\MarkupInterface|string',
        ],
      ],
      // 10.3 to 11.1: each element rendered with whether it is the root call.
      'Drupal\wanigan_live\Trace\TraceRenderer103' => [
        'Drupal\Core\Render\Renderer' => self::ELEMENTS + [
          'doRender' => '(&$elements, $is_root_call)',
        ],
      ],
    ]],
    self::ENGINE => [self::ENGINE, [
      // 11.3 and later: theme engines are services.
      'Drupal\wanigan_live\Trace\TraceThemeEngine' => [
        self::ENGINE => [
          'renderTemplate' => '(string $template_file, array $variables): Drupal\Component\Render\MarkupInterface|string',
        ],
      ],
    ]],
  ];

  /**
   * What each service's classes add to core's (their own methods and
   * properties): core's class must not already have them.
   */
  private const OWN = [
    'module_handler' => ['listenerFor', 'alterListeners', 'owned', 'shape', 'changed'],
    'theme.manager' => ['listenerFor', 'themeAlterListeners'],
    'theme.registry' => ['coreRuntime', 'runtimeMode', '$traced'],
    'renderer' => ['traceElement'],
    self::ENGINE => [],
  ];

  /**
   * The class that marks templates before 11.3, in ::render().
   */
  private const MARKS_IN_RENDER = 'Drupal\wanigan_live\Trace\TraceThemeManager103';

  /**
   * {@inheritdoc}
   */
  public function alter(ContainerBuilder $container) {
    $chosen = [];
    foreach (self::SWAPS as $id => [$core, $families]) {
      $chosen[$id] = self::choose($container, $id, $core, $families);
    }
    // The theme side is one piece: each template's frame is opened by the
    // runtime registry, and its output marked by the engine (11.3 and later)
    // or the theme manager (before). Without both, the registry, engine and
    // renderer keep core's classes, and the page's parts are found through
    // hooks instead (Trace\PartsByHooks), which keep their own frames.
    $marked = isset($chosen[self::ENGINE]) || ($chosen['theme.manager'] ?? NULL) === self::MARKS_IN_RENDER;
    $parts = isset($chosen['theme.registry']) && $marked ? 'swaps' : 'hooks';
    if ($parts === 'hooks') {
      unset($chosen['theme.registry'], $chosen[self::ENGINE], $chosen['renderer']);
    }
    $chosen = array_filter($chosen);
    foreach ($chosen as $id => $class) {
      $container->getDefinition($id)->setClass($class);
    }
    $container->setParameter('wanigan_live.trace', ['parts' => $parts, 'classes' => $chosen]);
  }

  /**
   * The first of a service's families that fits, or NULL.
   */
  private static function choose(ContainerBuilder $container, string $id, string $core, array $families): ?string {
    if (!$container->hasDefinition($id) || !class_exists($core) || (new \ReflectionClass($core))->isFinal()) {
      return NULL;
    }
    if (ltrim((string) ($container->getDefinition($id)->getClass() ?? $id), '\\') !== $core) {
      return NULL;
    }
    foreach ($families as $class => $signatures) {
      if (self::fits(self::withOwn($id, $core, $signatures))) {
        return $class;
      }
    }
    return NULL;
  }

  /**
   * A family's entries, with what its classes add to core's: absent there.
   */
  public static function withOwn(string $id, string $core, array $signatures): array {
    $signatures[$core] = ($signatures[$core] ?? []) + array_fill_keys(self::OWN[$id] ?? [], NULL);
    return $signatures;
  }

  /**
   * Whether every entry holds: each method there with exactly the signature
   * given, or not there for NULL; each property there for TRUE, not there
   * for NULL.
   */
  public static function fits(array $signatures): bool {
    foreach ($signatures as $class => $members) {
      if (!class_exists($class)) {
        return FALSE;
      }
      foreach ($members as $name => $expected) {
        if ($name[0] === '$') {
          if (property_exists($class, substr($name, 1)) !== ($expected !== NULL)) {
            return FALSE;
          }
        }
        elseif ($expected === NULL ? method_exists($class, $name) : (!method_exists($class, $name) || self::signature(new \ReflectionMethod($class, $name)) !== $expected)) {
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

const HOOK_LISTENERS = String.raw`<?php

namespace Drupal\wanigan_live\Trace;

/**
 * A module handler or theme manager the trace extends: the listener a module
 * or theme has for a hook, as its core lists it, or NULL.
 */
interface HookListeners {

  public function listenerFor(string $owner, string $hook): mixed;

}
`;

const TIMES_MODULE_HOOKS = String.raw`<?php

namespace Drupal\wanigan_live\Trace;

/**
 * Core's module handler, timing each hook implementation of a traced request:
 * what every TraceModuleHandler class shares.
 *
 * Which implementations run, and in what order, stays core's: each class says
 * only how its core lists them (::alterListeners(), ::listenerFor()).
 * ::invokeAllWith() times the callback core hands each implementation to;
 * nearly every caller calls the implementation there once, and the few that
 * only list who implements a hook show as turns of almost no time.
 */
trait TimesModuleHooks {

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
   * The same listeners in the same order as core's alter(), called one at a
   * time so each can be timed.
   */
  public function alter($type, &$data, &$context1 = NULL, &$context2 = NULL) {
    $recorder = Recorder::$on;
    if ($recorder === NULL) {
      parent::alter($type, $data, $context1, $context2);
      return;
    }
    $hooks = array_map(static fn ($t) => $t . '_alter', is_array($type) ? array_values($type) : [$type]);
    foreach ($this->alterListeners($type, $hooks) as [$listener, $module, $hook]) {
      $before = is_array($data) ? self::shape($data) : NULL;
      $t0 = hrtime(TRUE);
      try {
        $listener($data, $context1, $context2);
      }
      finally {
        $recorder->hook($hook, $module, $listener, $t0, $before !== NULL && is_array($data) ? self::changed($before, $data) : NULL);
      }
    }
  }

  /**
   * Core's listeners for an alter, in core's order, each as [listener,
   * module, hook].
   */
  abstract protected function alterListeners(string|array $type, array $hooks): array;

  /**
   * Listeners, each with the module and hook it was listed for.
   */
  private static function owned(array $listeners, array $owners, string $hook): array {
    $out = [];
    foreach ($listeners as $listener) {
      $owner = [$listener, 'unknown', $hook];
      foreach ($owners as $candidate) {
        if ($candidate[0] === $listener) {
          $owner = $candidate;
          break;
        }
      }
      $out[] = $owner;
    }
    return $out;
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

const MODULE_HANDLER = String.raw`<?php

namespace Drupal\wanigan_live\Trace;

use Drupal\Core\Extension\ModuleHandler;

/**
 * Core's module handler of 11.3 and later, timed (TimesModuleHooks).
 *
 * Extends core/lib/Drupal/Core/Extension/ModuleHandler.php (11.3, 11.4): OOP
 * (#[Hook]) and procedural implementations alike come from
 * ::getHookImplementationList(), and alters from ::getCombinedListeners()
 * with its ordering rules.
 */
final class TraceModuleHandler extends ModuleHandler implements HookListeners {

  use TimesModuleHooks;

  /**
   * {@inheritdoc}
   */
  protected function alterListeners(string|array $type, array $hooks): array {
    $owners = [];
    foreach ($hooks as $hook) {
      $list = $this->getHookImplementationList($hook);
      foreach ($list->listeners as $i => $listener) {
        $owners[] = [$listener, $list->modules[$i], $hook];
      }
    }
    return self::owned($this->getCombinedListeners($hooks), $owners, $hooks[0]);
  }

  /**
   * The one implementation of a hook in a module, or NULL.
   */
  public function listenerFor(string $owner, string $hook): mixed {
    $listeners = $this->getHookImplementationList($hook)->getForModule($owner);
    if ($listeners) {
      return reset($listeners);
    }
    return function_exists($owner . '_' . $hook) ? $owner . '_' . $hook : NULL;
  }

}
`;

const MODULE_HANDLER_112 = String.raw`<?php

namespace Drupal\wanigan_live\Trace;

use Drupal\Core\Extension\ModuleHandler;

/**
 * Core's module handler of 11.2, timed (TimesModuleHooks).
 *
 * Extends core/lib/Drupal/Core/Extension/ModuleHandler.php (11.2): each
 * module's listeners for a hook come from ::getHookListeners(), and an
 * alter's from ::getCombinedListeners() with its ordering rules, as
 * ModuleHandler::alter() asks for them.
 */
final class TraceModuleHandler112 extends ModuleHandler implements HookListeners {

  use TimesModuleHooks;

  /**
   * {@inheritdoc}
   */
  protected function alterListeners(string|array $type, array $hooks): array {
    $owners = [];
    foreach ($hooks as $hook) {
      foreach ($this->getHookListeners($hook) as $module => $listeners) {
        foreach ($listeners as $listener) {
          $owners[] = [$listener, $module, $hook];
        }
      }
    }
    return self::owned($this->getCombinedListeners($hooks), $owners, $hooks[0]);
  }

  /**
   * The one implementation of a hook in a module, or NULL.
   */
  public function listenerFor(string $owner, string $hook): mixed {
    $listeners = $this->getHookListeners($hook)[$owner] ?? [];
    if ($listeners) {
      return reset($listeners);
    }
    return function_exists($owner . '_' . $hook) ? $owner . '_' . $hook : NULL;
  }

}
`;

const MODULE_HANDLER_111 = String.raw`<?php

namespace Drupal\wanigan_live\Trace;

use Drupal\Core\Extension\ModuleHandler;

/**
 * Core's module handler of 11.1, timed (TimesModuleHooks).
 *
 * Extends core/lib/Drupal/Core/Extension/ModuleHandler.php (11.1): each
 * module's listeners for a hook come from ::getHookListeners(). Core gathers
 * an alter's listeners inside alter() itself, into ::$alterEventListeners:
 * ::alterListeners() gathers them the same way, and keeps them there, so
 * the list is core's whether it or core built it.
 */
final class TraceModuleHandler111 extends ModuleHandler implements HookListeners {

  use TimesModuleHooks;

  /**
   * {@inheritdoc}
   */
  protected function alterListeners(string|array $type, array $hooks): array {
    $cid = is_array($type) ? implode(',', $type) : $type;
    if (!isset($this->alterEventListeners[$cid])) {
      // As ModuleHandler::alter() (11.1): the first hook's listeners by
      // module, then the others', merged into each module's; when a module
      // implements only another, the modules are put in order again.
      $hook_listeners = $this->getHookListeners($hooks[0]);
      $extra_modules = FALSE;
      foreach (array_slice($hooks, 1) as $hook) {
        foreach ($this->getHookListeners($hook) as $module => $listeners) {
          if (isset($hook_listeners[$module])) {
            $hook_listeners[$module] = array_merge($hook_listeners[$module], $listeners);
          }
          else {
            $hook_listeners[$module] = $listeners;
            $extra_modules = TRUE;
          }
        }
      }
      $modules = array_keys($hook_listeners);
      if ($extra_modules) {
        $modules = $this->reOrderModulesForAlter($modules, $hooks[0]);
      }
      $this->alterEventListeners[$cid] = [];
      foreach ($modules as $module) {
        foreach ($hook_listeners[$module] ?? [] as $listener) {
          $this->alterEventListeners[$cid][] = $listener;
        }
      }
    }
    $owners = [];
    foreach ($hooks as $hook) {
      foreach ($this->getHookListeners($hook) as $module => $listeners) {
        foreach ($listeners as $listener) {
          $owners[] = [$listener, $module, $hook];
        }
      }
    }
    return self::owned($this->alterEventListeners[$cid], $owners, $hooks[0]);
  }

  /**
   * The one implementation of a hook in a module, or NULL.
   */
  public function listenerFor(string $owner, string $hook): mixed {
    $listeners = $this->getHookListeners($hook)[$owner] ?? [];
    if ($listeners) {
      return reset($listeners);
    }
    return function_exists($owner . '_' . $hook) ? $owner . '_' . $hook : NULL;
  }

}
`;

const MODULE_HANDLER_103 = String.raw`<?php

namespace Drupal\wanigan_live\Trace;

use Drupal\Core\Extension\ModuleHandler;

/**
 * Core's module handler of 10.3 to 11.0, timed (TimesModuleHooks).
 *
 * Extends core/lib/Drupal/Core/Extension/ModuleHandler.php (10.3 to 11.0,
 * the same file in each): hooks are procedural functions, module_hook, and a
 * hook's modules come from ::getImplementationInfo() in module order with
 * hook_module_implements_alter() applied. Core gathers an alter's functions
 * inside alter() itself, into ::$alterFunctions: ::alterListeners() gathers
 * them the same way, and keeps them there, so the list is core's whether it
 * or core built it.
 */
final class TraceModuleHandler103 extends ModuleHandler implements HookListeners {

  use TimesModuleHooks;

  /**
   * {@inheritdoc}
   */
  protected function alterListeners(string|array $type, array $hooks): array {
    $cid = is_array($type) ? implode(',', $type) : $type;
    if (!isset($this->alterFunctions[$cid])) {
      // As ModuleHandler::alter() (10.3 to 11.0): one hook's functions in its
      // modules' order; for several, every module implementing any of them,
      // put in order again when one implements only another, and each
      // module's functions for the first hook, then the others.
      $hook = $hooks[0];
      $extra_hooks = array_slice($hooks, 1);
      $modules = array_keys($this->getImplementationInfo($hook));
      $functions = [];
      if (!$extra_hooks) {
        foreach ($modules as $module) {
          $functions[] = $module . '_' . $hook;
        }
      }
      else {
        $extra_modules = [];
        foreach ($extra_hooks as $extra_hook) {
          $extra_modules[] = array_keys($this->getImplementationInfo($extra_hook));
        }
        $extra_modules = array_merge(...$extra_modules);
        if (array_diff($extra_modules, $modules)) {
          $modules = array_intersect(array_keys($this->moduleList), array_merge($modules, $extra_modules));
          $implementations = array_fill_keys($modules, FALSE);
          $this->alter('module_implements', $implementations, $hook);
          $modules = array_keys($implementations);
        }
        foreach ($modules as $module) {
          foreach ($hooks as $one) {
            if (function_exists($module . '_' . $one)) {
              $functions[] = $module . '_' . $one;
            }
          }
        }
      }
      $this->alterFunctions[$cid] = $functions;
    }
    // Each function is named for its module and hook: the longest hook first,
    // so form_node_form_alter is not read as form_alter.
    $longest = $hooks;
    usort($longest, static fn ($a, $b) => strlen($b) <=> strlen($a));
    $out = [];
    foreach ($this->alterFunctions[$cid] as $function) {
      $owner = [$function, 'unknown', $hooks[0]];
      foreach ($longest as $hook) {
        $module = substr($function, 0, -strlen($hook) - 1);
        if (str_ends_with($function, '_' . $hook) && isset($this->moduleList[$module])) {
          $owner = [$function, $module, $hook];
          break;
        }
      }
      $out[] = $owner;
    }
    return $out;
  }

  /**
   * A module's function for a hook, or NULL: what ModuleHandler::invoke()
   * calls (10.3 to 11.0).
   */
  public function listenerFor(string $owner, string $hook): mixed {
    return $this->hasImplementations($hook, $owner) ? $owner . '_' . $hook : NULL;
  }

}
`;

const TIMES_THEME_HOOKS = String.raw`<?php

namespace Drupal\wanigan_live\Trace;

use Drupal\Core\Theme\ActiveTheme;

/**
 * Core's theme manager, timing each theme's alter implementations: what
 * every TraceThemeManager class shares. Which run, and in what order, stays
 * core's: each class says only how its core lists them.
 */
trait TimesThemeHooks {

  /**
   * {@inheritdoc}
   *
   * The listeners ThemeManager::alterForTheme() gathers, in its order (each
   * theme of the chain, base themes first: the generic hook, then the
   * specific ones), called one at a time so each can be timed.
   */
  public function alterForTheme(ActiveTheme $theme, $type, &$data, &$context1 = NULL, &$context2 = NULL) {
    $recorder = Recorder::$on;
    if ($recorder === NULL) {
      parent::alterForTheme($theme, $type, $data, $context1, $context2);
      return;
    }
    foreach ($this->themeAlterListeners($theme, is_array($type) ? array_values($type) : [$type]) as [$listener, $theme_key, $hook]) {
      $before = is_array($data) && array_is_list($data) ? $data : NULL;
      $t0 = hrtime(TRUE);
      try {
        $listener($data, $context1, $context2);
      }
      finally {
        $recorder->hook($hook, $theme_key, $listener, $t0, $before !== NULL && is_array($data) ? array_values(array_diff(array_filter($data, 'is_string'), array_filter($before, 'is_string'))) : NULL);
      }
    }
  }

  /**
   * Core's listeners for a theme alter, in core's order, each as [listener,
   * theme, hook].
   */
  abstract protected function themeAlterListeners(ActiveTheme $theme, array $types): array;

}
`;

const THEME_MANAGER = String.raw`<?php

namespace Drupal\wanigan_live\Trace;

use Drupal\Core\Theme\ActiveTheme;
use Drupal\Core\Theme\ThemeManager;

/**
 * Core's theme manager of 11.3 and later, timing each theme's hook
 * implementations.
 *
 * Extends core/lib/Drupal/Core/Theme/ThemeManager.php (11.3, 11.4): themes'
 * implementations come from ::getImplementationsForTheme(), over the theme
 * chain from ::getThemeChain() (base themes first), as core runs them.
 * ::render() is untouched: what a template is shaped by is recorded by the
 * runtime registry (TracedRuntime) and the Twig engine (TraceThemeEngine).
 */
final class TraceThemeManager extends ThemeManager implements HookListeners {

  use TimesThemeHooks;

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
   */
  protected function themeAlterListeners(ActiveTheme $theme, array $types): array {
    $out = [];
    foreach ($this->getThemeChain($theme) as $theme_key) {
      foreach ($types as $type) {
        foreach ($this->getImplementationsForTheme($theme_key, $type . '_alter') as $listener) {
          if ($listener) {
            $out[] = [$listener, $theme_key, $type . '_alter'];
          }
        }
      }
    }
    return $out;
  }

  /**
   * A theme's one implementation of a hook, or NULL.
   */
  public function listenerFor(string $owner, string $hook): mixed {
    $listeners = $this->getImplementationsForTheme($owner, $hook);
    return $listeners ? reset($listeners) : NULL;
  }

}
`;

const THEME_MANAGER_103 = String.raw`<?php

namespace Drupal\wanigan_live\Trace;

use Drupal\Core\Theme\ActiveTheme;
use Drupal\Core\Theme\ThemeManager;

/**
 * Core's theme manager of 10.3 to 11.2: timing each theme's alter
 * functions, and marking each template's output as a part.
 *
 * Extends core/lib/Drupal/Core/Theme/ThemeManager.php (10.3 to 11.2).
 * Themes' hooks are functions named for the theme (theme_hook), over the
 * theme chain, base themes first. Theme engines are not services yet:
 * ::render() renders a template itself, with twig_render_template()
 * (core/themes/engines/twig/twig.engine), so what TraceThemeEngine does on
 * 11.3 and later is done around it. The runtime registry (TracedRuntime)
 * opens the template's frame with its first preprocess callback, and with its
 * last hands over the template's file and core's own variables, which core
 * finishes after (theme_hook_suggestions, attributes), so the part describes
 * the variables the template is given.
 */
final class TraceThemeManager103 extends ThemeManager implements HookListeners {

  use TimesThemeHooks;

  /**
   * {@inheritdoc}
   */
  public function render($hook, array $variables) {
    $recorder = Recorder::$on;
    if ($recorder === NULL || $recorder->byHooks) {
      return parent::render($hook, $variables);
    }
    $state = $recorder->state();
    $template = new PendingTemplate();
    $state->templates[] = $template;
    try {
      $output = parent::render($hook, $variables);
    }
    catch (\Throwable $e) {
      if ($template->frame !== NULL) {
        $recorder->pop($template->frame);
      }
      throw $e;
    }
    finally {
      $at = array_search($template, $state->templates, TRUE);
      if ($at !== FALSE) {
        array_splice($state->templates, $at, 1);
      }
    }
    if ($template->frame === NULL) {
      return $output;
    }
    $given = $template->take();
    if ($output === FALSE || $template->file === NULL) {
      $recorder->pop($template->frame);
      return $output;
    }
    return $recorder->themePart($template->frame, $template->file, $given, $output);
  }

  /**
   * {@inheritdoc}
   *
   * The functions ThemeManager::alterForTheme() calls (10.3 to 11.2): for
   * each theme of the chain, theme_type_alter, then each further type's.
   */
  protected function themeAlterListeners(ActiveTheme $theme, array $types): array {
    $theme_keys = array_reverse(array_keys($theme->getBaseThemeExtensions()));
    $theme_keys[] = $theme->getName();
    $out = [];
    foreach ($theme_keys as $theme_key) {
      foreach ($types as $type) {
        $function = $theme_key . '_' . $type . '_alter';
        if (function_exists($function)) {
          $out[] = [$function, $theme_key, $type . '_alter'];
        }
      }
    }
    return $out;
  }

  /**
   * A theme's function for a hook, or NULL.
   */
  public function listenerFor(string $owner, string $hook): mixed {
    return function_exists($owner . '_' . $hook) ? $owner . '_' . $hook : NULL;
  }

}
`;

const PENDING_TEMPLATE = String.raw`<?php

namespace Drupal\wanigan_live\Trace;

/**
 * A template TraceThemeManager103 is rendering (before 11.3): its frame,
 * opened by TracedRuntime with the template's first preprocess callback, and,
 * from its last, the template's file and core's own variables.
 */
final class PendingTemplate {

  public ?Frame $frame = NULL;
  public ?string $file = NULL;

  /**
   * A reference to ThemeManager::render()'s variables: core adds what it
   * adds after preprocess (theme_hook_suggestions, attributes) to these.
   */
  public mixed $variables = NULL;

  /**
   * The variables as the template was given them; the reference let go.
   */
  public function take(): array {
    $variables = is_array($this->variables) ? $this->variables : [];
    unset($this->variables);
    $this->variables = NULL;
    return $variables;
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
 * Extends core/lib/Drupal/Core/Theme/Registry.php, whose ::getRuntime() is
 * the same in every supported release. ThemeManager::render() reads every
 * hook's definition from it; for a traced request only, that is
 * TracedRuntime around core's own runtime registry, which is still the one
 * cached and destructed as before. How render() runs a definition's
 * preprocess callbacks changed (::runtimeMode()), so each release's shape has
 * its class: this one 11.3 and later, TraceRegistry112, TraceRegistry103.
 */
class TraceRegistry extends Registry {

  private ?TracedRuntime $traced = NULL;

  /**
   * {@inheritdoc}
   */
  public function getRuntime() {
    $runtime = parent::getRuntime();
    if (Recorder::$on === NULL || Recorder::$on->byHooks) {
      return $runtime;
    }
    if ($this->traced === NULL || $this->traced->inner !== $runtime) {
      $this->traced = new TracedRuntime($runtime, $this->runtimeMode());
    }
    return $this->traced;
  }

  /**
   * Core's runtime registry, never the traced one.
   */
  public function coreRuntime() {
    return parent::getRuntime();
  }

  /**
   * How core's ThemeManager::render() runs a definition's preprocess
   * callbacks (TracedRuntime::GLOBALS: 11.3 and later).
   */
  protected function runtimeMode(): int {
    return TracedRuntime::GLOBALS;
  }

}
`;

const REGISTRY_112 = String.raw`<?php

namespace Drupal\wanigan_live\Trace;

/**
 * Core's theme registry of 11.2: initial preprocess, and preprocess invokes
 * through the module handler, themes' included (TracedRuntime::INVOKES).
 */
final class TraceRegistry112 extends TraceRegistry {

  /**
   * {@inheritdoc}
   */
  protected function runtimeMode(): int {
    return TracedRuntime::INVOKES;
  }

}
`;

const REGISTRY_103 = String.raw`<?php

namespace Drupal\wanigan_live\Trace;

/**
 * Core's theme registry of 10.3 to 11.1: preprocess functions only, each
 * called as it is (TracedRuntime::FUNCTIONS).
 */
final class TraceRegistry103 extends TraceRegistry {

  /**
   * {@inheritdoc}
   */
  protected function runtimeMode(): int {
    return TracedRuntime::FUNCTIONS;
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
 * ThemeManager::render() (core/lib/Drupal/Core/Theme/ThemeManager.php) runs
 * a definition's callbacks one of three ways, by release (::$mode):
 * - FUNCTIONS (10.3 to 11.1): each 'preprocess functions' entry, called as
 *   it is. The template's frame opens with a first callback of the trace's
 *   own; a module's or theme's function is named for it by its name.
 * - INVOKES (11.2): 'initial preprocess' first, then each entry, through its
 *   invoke map ('preprocess invokes', modules' and themes' alike through
 *   ModuleHandler::invoke()) when it is in it, else called as it is.
 * - GLOBALS (11.3 and later): as 11.2, themes' through ThemeManager::
 *   invoke(), and the global preprocess callbacks just before the first
 *   entry that is not a template_ function (or after the loop when there is
 *   none).
 * The wrapped definition keeps exactly that order, with the global callbacks
 * folded into the list, and ::getGlobalPreprocess() answers none, so nothing
 * runs twice and nothing runs out of order. Definitions are copied: core's
 * runtime registry, which is cached, never holds a wrapper.
 */
final class TracedRuntime extends ThemeRegistry {

  /**
   * 10.3 to 11.1: preprocess functions only.
   */
  public const FUNCTIONS = 1;

  /**
   * 11.2: initial preprocess, and preprocess invokes.
   */
  public const INVOKES = 2;

  /**
   * 11.3 and later: initial preprocess, preprocess invokes by module or
   * theme, and global preprocess.
   */
  public const GLOBALS = 3;

  /**
   * Preprocess functions' owners, by name (FUNCTIONS): [owner, hook] or NULL.
   */
  private static array $owners = [];

  /**
   * Core's constructor is not called: this holds no cache of its own.
   */
  public function __construct(public readonly ThemeRegistry $inner, public readonly int $mode = self::GLOBALS) {}

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
    return $this->mode === self::FUNCTIONS ? [] : (array) $this->inner->getPreprocessInvokes();
  }

  /**
   * Folded into each definition by ::wrap(), in core's order.
   */
  public function getGlobalPreprocess(): array {
    return [];
  }

  private function wrap(array $info): array {
    $invokes = $this->getPreprocessInvokes();
    $globals = $this->mode === self::GLOBALS ? $this->inner->getGlobalPreprocess() : [];
    $mode = $this->mode;
    $holder = new \stdClass();
    $holder->frame = NULL;
    // The template's frame opens, and a template TraceThemeManager103 is
    // rendering (before 11.3) is told which it is.
    $open = static function (array &$variables, $hook, $info) use ($holder): void {
      $recorder = Recorder::$on;
      if ($recorder === NULL) {
        return;
      }
      $holder->frame = $recorder->beginTheme((string) $hook, $info, $variables);
      $template = $recorder->pendingTemplate();
      if ($template !== NULL && $template->frame === NULL) {
        $template->frame = $holder->frame;
      }
    };
    $steps = [];
    if ($mode === self::FUNCTIONS) {
      // No initial preprocess before 11.2: the frame opens with a first
      // callback of the trace's own.
      $steps[] = $open;
    }
    else {
      $initial = $info['initial preprocess'] ?? NULL;
      $info['initial preprocess'] = static function (array &$variables, $hook, $info) use ($initial, $holder, $open) {
        $open($variables, $hook, $info);
        if (empty($initial)) {
          return;
        }
        // Resolved as ThemeManager::render() does; an invalid definition
        // throws the same InvalidArgumentException, which core catches and
        // logs.
        $callable = is_callable($initial) ? $initial : \Drupal::service('callable_resolver')->getCallableFromDefinition($initial);
        $recorder = Recorder::$on;
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
    }
    $globals_done = FALSE;
    foreach ($info['preprocess functions'] ?? [] as $function) {
      if (!$globals_done && is_string($function) && !str_starts_with($function, 'template_')) {
        $globals_done = TRUE;
        foreach ($globals as $global) {
          $steps[] = self::step($global, $invokes, $holder, $mode);
        }
      }
      $steps[] = self::step($function, $invokes, $holder, $mode);
    }
    if (!$globals_done) {
      foreach ($globals as $global) {
        $steps[] = self::step($global, $invokes, $holder, $mode);
      }
    }
    // Last, after every preprocess of the site: the helper's own marks; and
    // before 11.3, the template's file and variables, for
    // TraceThemeManager103 to mark the template's output with.
    $steps[] = static function (array &$variables, $hook, $info) use ($holder) {
      $recorder = Recorder::$on;
      if ($recorder === NULL || !$holder->frame) {
        return;
      }
      Marks::afterPreprocess($recorder, $holder->frame, $variables);
      $template = $recorder->pendingTemplate();
      if ($template !== NULL && $template->frame === $holder->frame) {
        $template->file = (isset($info['path']) ? $info['path'] . '/' : '') . $info['template'] . '.html.twig';
        $template->variables = &$variables;
      }
    };
    $info['preprocess functions'] = $steps;
    return $info;
  }

  /**
   * One preprocess callback, run as ThemeManager::render() runs it.
   */
  private static function step(mixed $function, array $invokes, \stdClass $holder, int $mode): \Closure {
    return static function (array &$variables, $hook, $info) use ($function, $invokes, $holder, $mode) {
      $recorder = Recorder::$on;
      $frame = $holder->frame;
      $before = ($recorder !== NULL && $frame) ? Preview::snapshot($variables) : NULL;
      $name = 'preprocess';
      $by = NULL;
      $owner = ($mode === self::FUNCTIONS && is_string($function)) ? self::owner($function) : NULL;
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
          if ($owner !== NULL) {
            [$by, $name] = $owner;
          }
          call_user_func_array($function, [&$variables, $hook, $info]);
        }
      }
      finally {
        if ($recorder !== NULL && $owner !== NULL) {
          // Before 11.2 core calls a module's or theme's preprocess function
          // itself: its turn is noted here, as the module handler or theme
          // manager notes it on later releases.
          $recorder->hook($name, $by, $function, $t0);
        }
        if ($recorder !== NULL && $frame) {
          $recorder->themeStep($frame, $function, $name, $by, $t0, Preview::changed($before, $variables));
        }
      }
    };
  }

  /**
   * Whose a preprocess function is (FUNCTIONS), by the name Registry::
   * processExtension() gives it, owner_preprocess or owner_preprocess_hook
   * for an enabled module or a theme of the active theme's chain: [owner,
   * hook], or NULL (template_ functions, a theme engine's, a callback a
   * module added).
   */
  private static function owner(string $function): ?array {
    if (array_key_exists($function, self::$owners)) {
      return self::$owners[$function];
    }
    $owner = NULL;
    try {
      $modules = \Drupal::moduleHandler();
      $theme = \Drupal::theme()->getActiveTheme();
      $themes = array_merge(array_keys($theme->getBaseThemeExtensions()), [$theme->getName()]);
      for ($at = strpos($function, '_preprocess'); $at !== FALSE; $at = strpos($function, '_preprocess', $at + 1)) {
        $prefix = substr($function, 0, $at);
        $hook = substr($function, $at + 1);
        if ($hook !== 'preprocess' && !str_starts_with($hook, 'preprocess_')) {
          continue;
        }
        if ($prefix === 'template') {
          break;
        }
        if ($modules->moduleExists($prefix) || in_array($prefix, $themes, TRUE)) {
          $owner = [$prefix, $hook];
          break;
        }
      }
    }
    catch (\Throwable) {
      // No module list or theme to read: not named.
    }
    return self::$owners[$function] = $owner;
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
 * where theme engines are services: ThemeManager::getThemeEngine(); before,
 * TraceThemeManager103 marks templates). ::renderTemplate() is the one place
 * a template's final variables, its file and its output meet. Core's own
 * Twig debug comments stay inside the marks.
 */
class TraceThemeEngine extends TwigThemeEngine {

  /**
   * {@inheritdoc}
   */
  public function renderTemplate(string $template_file, array $variables): string|MarkupInterface {
    $recorder = Recorder::$on;
    if ($recorder === NULL || $recorder->byHooks) {
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

const TRACES_ELEMENTS = String.raw`<?php

namespace Drupal\wanigan_live\Trace;

use Drupal\Component\Render\MarkupInterface;
use Drupal\Core\Cache\Cache;
use Drupal\Core\Render\RenderContext;

/**
 * Core's renderer, noting each element's cost, cache metadata and assets:
 * what every TraceRenderer class shares.
 *
 * - One frame per element (::traceElement(), from each class's doRender()).
 *   A traced render reads and writes no render cache: core would serve a
 *   cached element without running what made it (no preprocess, no
 *   template), and would store this request's marks for others. So the
 *   element's keys are taken off after asking the render cache whether a
 *   normal request would be served it ('hit' or 'miss'), with the required
 *   cache contexts merged as core merges them. After core renders it, the
 *   element carries its bubbled #cache and #attached (RenderContext::
 *   update()), which is what the trace reports.
 * - ::executeInRenderContext(): from 11.3 core renders each isolated subtree
 *   in a new Fiber; before, in the Fiber already running. Either way the
 *   subtree starts from the frame it was asked from, and the Fiber it ran in
 *   is left as it was.
 * - ::doRenderPlaceholder(): a placeholder is rendered later, in its own
 *   Fiber; it is given the frame it was cut out of, and called 'placeholder'.
 */
trait TracesElements {

  /**
   * One element: its frame around core's render of it ($render).
   *
   * $asks_first: core asks the render cache before it would placeholder the
   * element (before 11.2), so a normal request could be served it even then.
   */
  private function traceElement(Recorder $recorder, array &$elements, bool $asks_first, \Closure $render): string|MarkupInterface {
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
      if (($asks_first || empty($elements['#create_placeholder'])) && !isset($frame->info['status'])) {
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
      $markup = $render();
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
    if ($recorder === NULL || $recorder->byHooks) {
      return parent::executeInRenderContext($context, $callable);
    }
    $base = $recorder->top();
    return parent::executeInRenderContext($context, static function () use ($callable, $base, $recorder) {
      $state = $recorder->state();
      $previous = $state->base;
      $state->base = $base;
      try {
        return $callable();
      }
      finally {
        $state->base = $previous;
      }
    });
  }

  /**
   * {@inheritdoc}
   */
  protected function doRenderPlaceholder(array &$placeholder_element): MarkupInterface|string {
    $recorder = Recorder::$on;
    if ($recorder === NULL || $recorder->byHooks) {
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

const RENDERER = String.raw`<?php

namespace Drupal\wanigan_live\Trace;

use Drupal\Component\Render\MarkupInterface;
use Drupal\Core\Render\RenderContext;
use Drupal\Core\Render\Renderer;

/**
 * Core's renderer of 11.2 and later, noting each element (TracesElements).
 *
 * Extends core/lib/Drupal/Core/Render/Renderer.php (11.2 to 11.4), whose
 * ::doRender() renders an element in a render context.
 */
final class TraceRenderer extends Renderer {

  use TracesElements;

  /**
   * {@inheritdoc}
   */
  protected function doRender(array &$elements, RenderContext $context): string|MarkupInterface {
    $recorder = Recorder::$on;
    if ($recorder === NULL || $recorder->byHooks || !$elements) {
      return parent::doRender($elements, $context);
    }
    return $this->traceElement($recorder, $elements, FALSE, function () use (&$elements, $context) {
      return parent::doRender($elements, $context);
    });
  }

}
`;

const RENDERER_103 = String.raw`<?php

namespace Drupal\wanigan_live\Trace;

use Drupal\Core\Render\Renderer;

/**
 * Core's renderer of 10.3 to 11.1, noting each element (TracesElements).
 *
 * Extends core/lib/Drupal/Core/Render/Renderer.php (10.3 to 11.1), whose
 * ::doRender() renders an element with whether it is the root call, and asks
 * the render cache before it would placeholder an element.
 */
final class TraceRenderer103 extends Renderer {

  use TracesElements;

  /**
   * {@inheritdoc}
   */
  protected function doRender(&$elements, $is_root_call = FALSE) {
    $recorder = Recorder::$on;
    if ($recorder === NULL || $recorder->byHooks || !$elements || !is_array($elements)) {
      return parent::doRender($elements, $is_root_call);
    }
    return $this->traceElement($recorder, $elements, TRUE, function () use (&$elements, $is_root_call) {
      return parent::doRender($elements, $is_root_call);
    });
  }

}
`;

const PARTS_BY_HOOKS = String.raw`<?php

namespace Drupal\wanigan_live\Trace;

use Drupal\Core\Render\Element;
use Drupal\Core\Security\TrustedCallbackInterface;
use Drupal\wanigan_live\WaniganLiveServiceProvider;

/**
 * A traced page's parts, found through hooks every supported release has,
 * on a Drupal core whose template rendering the trace's classes do not fit
 * (WaniganLiveServiceProvider keeps core's theme registry, engine and
 * renderer then).
 *
 * - hook_theme_registry_alter(): every template's preprocess starts with
 *   ::open(), which opens its frame, and ends with ::close(), after every
 *   preprocess of the site, which adds the helper's marks (Marks) and keeps
 *   the template's file and core's own variables.
 * - #pre_render and #post_render callbacks: ::preRender() opens an element's
 *   frame, hands the callbacks on to the element's children, and takes off
 *   its render cache keys (a page with marks is never stored); ::postRender()
 *   puts the element's own template's part, or its outermost wrapper's,
 *   around its markup (Recorder::leaveByHooks()). They reach the page from
 *   hook_element_info_alter() (html, page), every block from
 *   hook_block_view_alter(), and every entity from
 *   hook_entity_build_defaults_alter(): lazy builders, which may carry no
 *   other property, are reached through those.
 *
 * What hooks cannot give, the trace says (Recorder::sense()): a template and
 * its wrappers are one part, the preprocess steps that shaped a template are
 * not listed, a part's cache metadata is its own (not what its contents
 * added), and an element rendered on its own, outside the page's render
 * arrays (a string a preprocess renders, say), is not a part. Nothing acts
 * unless a request is traced, and the registry and element info are altered
 * only on such a core.
 */
final class PartsByHooks implements TrustedCallbackInterface {

  /**
   * Element frames opened, numbered: how an element's #post_render finds
   * its frame.
   */
  private static int $elements = 0;

  /**
   * {@inheritdoc}
   */
  public static function trustedCallbacks() {
    return ['preRender', 'postRender'];
  }

  /**
   * Whether this site needs it: the theme registry and template marking the
   * trace extends are not both in place.
   */
  public static function needed(): bool {
    try {
      $marks = \Drupal::theme() instanceof TraceThemeManager103
        || (\Drupal::hasService(WaniganLiveServiceProvider::ENGINE) && \Drupal::service(WaniganLiveServiceProvider::ENGINE) instanceof TraceThemeEngine);
      return !(\Drupal::service('theme.registry') instanceof TraceRegistry && $marks);
    }
    catch (\Throwable) {
      return FALSE;
    }
  }

  /**
   * The recorder of a request traced through hooks, or NULL.
   */
  private static function recorder(): ?Recorder {
    $recorder = Recorder::$on;
    return ($recorder !== NULL && $recorder->byHooks) ? $recorder : NULL;
  }

  /**
   * hook_theme_registry_alter(): the helper's own preprocess, first and last.
   */
  public static function registry(array &$registry): void {
    if (!self::needed()) {
      return;
    }
    foreach ($registry as &$info) {
      // A theme hook (not 'preprocess invokes' or 'global preprocess').
      if (!is_array($info) || !isset($info['template'])) {
        continue;
      }
      $info['preprocess functions'] = array_merge([[self::class, 'open']], (array) ($info['preprocess functions'] ?? []), [[self::class, 'close']]);
    }
  }

  /**
   * hook_element_info_alter(): the page's callbacks.
   */
  public static function elementInfo(array &$info): void {
    if (!self::needed()) {
      return;
    }
    foreach (['html', 'page'] as $type) {
      if (isset($info[$type]) && !in_array([self::class, 'preRender'], $info[$type]['#pre_render'] ?? [], TRUE)) {
        $info[$type]['#pre_render'][] = [self::class, 'preRender'];
      }
    }
  }

  /**
   * hook_block_view_alter() and hook_entity_build_defaults_alter(): a
   * block's or entity's callbacks, for a request traced through hooks.
   */
  public static function attach(array &$build): void {
    if (self::recorder() !== NULL) {
      self::callbacks($build);
    }
  }

  private static function callbacks(array &$element): void {
    // An element built lazily may carry no other property.
    if (isset($element['#lazy_builder'])) {
      return;
    }
    // Defaults loaded as Renderer::doRender() loads them: a #pre_render set
    // first would keep the element type's own from being merged in.
    if (isset($element['#type']) && empty($element['#defaults_loaded'])) {
      $element += \Drupal::service('element_info')->getInfo($element['#type']);
      $element['#defaults_loaded'] = TRUE;
    }
    if (!in_array([self::class, 'preRender'], $element['#pre_render'] ?? [], TRUE)) {
      $element['#pre_render'][] = [self::class, 'preRender'];
    }
  }

  /**
   * An element begins: its frame, and its children's callbacks.
   */
  public static function preRender(array $element): array {
    $recorder = self::recorder();
    if ($recorder === NULL || isset($element['#wanigan_live_frame'])) {
      return $element;
    }
    $frame = $recorder->push(new Frame('R', [
      'theme' => $element['#theme'] ?? NULL,
      'type' => $element['#type'] ?? NULL,
      'component' => $element['#component'] ?? NULL,
    ]));
    $element['#wanigan_live_frame'] = $frame->info['hooked'] = ++self::$elements;
    $element['#post_render'][] = [self::class, 'postRender'];
    // Never stored in the render cache with this request's marks in it.
    unset($element['#cache']['keys']);
    foreach (Element::children($element) as $key) {
      if (is_array($element[$key])) {
        self::callbacks($element[$key]);
      }
    }
    return $element;
  }

  /**
   * An element is rendered: its part around its markup.
   */
  public static function postRender($markup, array $element) {
    $recorder = self::recorder();
    if ($recorder === NULL || !isset($element['#wanigan_live_frame'])) {
      return $markup;
    }
    $frame = $recorder->openFrame((int) $element['#wanigan_live_frame']);
    return $frame !== NULL ? $recorder->leaveByHooks($frame, $element, $markup) : $markup;
  }

  /**
   * A template's first preprocess callback: its frame opens, inside the
   * nearest element's.
   */
  public static function open(array &$variables, $hook, $info): void {
    $recorder = self::recorder();
    if ($recorder === NULL) {
      return;
    }
    $frame = $recorder->beginTheme((string) $hook, (array) $info, $variables, TRUE);
    $frame->info['byHooks'] = TRUE;
    if ($frame->info['element'] instanceof Frame) {
      $frame->info['element']->info['templates'][] = $frame;
    }
  }

  /**
   * A template's last preprocess callback: the helper's marks, and its file
   * and variables (a reference: core finishes them after).
   */
  public static function close(array &$variables, $hook, $info): void {
    $recorder = self::recorder();
    if ($recorder === NULL) {
      return;
    }
    $original = (string) ($variables['theme_hook_original'] ?? $hook);
    $frames = $recorder->state()->frames;
    for ($i = count($frames) - 1; $i >= 0; $i--) {
      $frame = $frames[$i];
      if ($frame->type === 'T' && !empty($frame->info['byHooks']) && !isset($frame->info['file']) && $frame->info['original'] === $original) {
        Marks::afterPreprocess($recorder, $frame, $variables);
        $frame->info['file'] = (isset($info['path']) ? $info['path'] . '/' : '') . $info['template'] . '.html.twig';
        $frame->info['variables'] = &$variables;
        return;
      }
    }
  }

}
`;

export const DRUPAL_TRACE_MODULE = String.raw`
/**
 * Implements hook_theme_registry_alter().
 *
 * Only on a Drupal core whose template rendering the trace's classes do not
 * fit: the helper's own preprocess, first and last for every template, so a
 * traced page's parts are still found (Trace\PartsByHooks).
 */
function wanigan_live_theme_registry_alter(&$theme_registry) {
  \Drupal\wanigan_live\Trace\PartsByHooks::registry($theme_registry);
}

/**
 * Implements hook_element_info_alter().
 *
 * Only on such a core: the page's elements are followed, for a traced
 * request only.
 */
function wanigan_live_element_info_alter(array &$info) {
  \Drupal\wanigan_live\Trace\PartsByHooks::elementInfo($info);
}

/**
 * Implements hook_block_view_alter().
 */
function wanigan_live_block_view_alter(array &$build, \Drupal\Core\Block\BlockPluginInterface $block) {
  \Drupal\wanigan_live\Trace\PartsByHooks::attach($build);
}

/**
 * Implements hook_entity_build_defaults_alter().
 */
function wanigan_live_entity_build_defaults_alter(array &$build, \Drupal\Core\Entity\EntityInterface $entity, $view_mode) {
  \Drupal\wanigan_live\Trace\PartsByHooks::attach($build);
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
    // Which of the trace's classes this site runs, and so how its parts are
    // found (PartsByHooks when the theme side's are not in place).
    $recorder->sense();
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
    if (!$event->isMainRequest()) {
      return;
    }
    if ($recorder === NULL) {
      // Another Wanigan's key: say only that a helper is here and answers to another Wanigan, so this one can ask
      // its owner to set it up again instead of showing a page without a trace.
      if ($this->token->other($event->getRequest())) {
        $event->getResponse()->headers->set('X-Wanigan-Helper', 'other');
      }
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
  'src/Trace/HookListeners.php': HOOK_LISTENERS,
  'src/Trace/TimesModuleHooks.php': TIMES_MODULE_HOOKS,
  'src/Trace/TraceModuleHandler.php': MODULE_HANDLER,
  'src/Trace/TraceModuleHandler112.php': MODULE_HANDLER_112,
  'src/Trace/TraceModuleHandler111.php': MODULE_HANDLER_111,
  'src/Trace/TraceModuleHandler103.php': MODULE_HANDLER_103,
  'src/Trace/TimesThemeHooks.php': TIMES_THEME_HOOKS,
  'src/Trace/TraceThemeManager.php': THEME_MANAGER,
  'src/Trace/TraceThemeManager103.php': THEME_MANAGER_103,
  'src/Trace/PendingTemplate.php': PENDING_TEMPLATE,
  'src/Trace/TraceRegistry.php': REGISTRY,
  'src/Trace/TraceRegistry112.php': REGISTRY_112,
  'src/Trace/TraceRegistry103.php': REGISTRY_103,
  'src/Trace/TracedRuntime.php': TRACED_RUNTIME,
  'src/Trace/TraceThemeEngine.php': ENGINE,
  'src/Trace/TracesElements.php': TRACES_ELEMENTS,
  'src/Trace/TraceRenderer.php': RENDERER,
  'src/Trace/TraceRenderer103.php': RENDERER_103,
  'src/Trace/PartsByHooks.php': PARTS_BY_HOOKS,
  'src/Trace/TracePlaceholderStrategy.php': PLACEHOLDERS,
  'src/Trace/TraceTwigExtension.php': TWIG,
  'src/Trace/ComponentPartVisitor.php': VISITOR,
  'src/Trace/TraceLogger.php': LOGGER,
  'src/Trace/TraceSubscriber.php': SUBSCRIBER,
  'src/Trace/TraceStore.php': STORE,
};
