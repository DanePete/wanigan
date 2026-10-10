// For tests only: a stand-in Drupal core shaped like one release, for running the Drupal helper's trace under PHP
// without Drupal. Two kinds:
// - declarationsOnly(): every method of the classes the trace extends, with exactly the declaration that release has
//   (src/core/fixtures/drupal-core-trace-signatures.json) and an empty body, for checking which of the trace's
//   classes the service provider picks, and that each one it picks loads against that release's real signatures.
// - standInCore(): a working core of that release's shape, small: a module handler, theme manager, theme registry,
//   renderer and Twig engine that do what that release's do, in its order (procedural hooks or implementation lists,
//   preprocess functions or initial preprocess and invoke maps, twig_render_template() or the engine service), each
//   method declared exactly as the release declares it. Templates are PHP closures. Its container is compiled by the
//   helper's own WaniganLiveServiceProvider, so a page renders through whichever of the trace's classes it picked.
// Nothing here runs Drupal or touches a site; the content tests render is made up.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface CoreClass {
  class: string;
  parent: string | null;
  methods: Record<string, { signature: string; declaration: string }>;
  properties: Record<string, string>;
  versions: string[];
}

export interface CoreSignatures {
  versions: Record<string, { classes: Record<string, string | null>; functions: Record<string, string | null> }>;
  classes: Record<string, CoreClass>;
}

export const CORE_SIGNATURES = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'drupal-core-trace-signatures.json'), 'utf8')) as CoreSignatures;

/** Every release the fixture was read from, oldest first. */
export const CORE_RELEASES = Object.keys(CORE_SIGNATURES.versions);

const MH = 'Drupal\\Core\\Extension\\ModuleHandler';
const TM = 'Drupal\\Core\\Theme\\ThemeManager';
const REGISTRY = 'Drupal\\Core\\Theme\\Registry';
const RUNTIME = 'Drupal\\Core\\Utility\\ThemeRegistry';
const RENDERER = 'Drupal\\Core\\Render\\Renderer';
const ENGINE = 'Drupal\\Core\\Template\\TwigThemeEngine';
const LIST = 'Drupal\\Core\\Hook\\ImplementationList';

/**
 * A core release that does not exist yet: 11.4, with every method the trace extends declared differently, so none
 * of the trace's classes fits it and the helper finds a page's parts through hooks instead.
 */
export const FUTURE = 'future';
const FUTURE_DECLARATIONS: Record<string, Record<string, string>> = {
  [MH]: { alter: 'public function alter(array|string $type, mixed &$data, mixed &$context1 = NULL, mixed &$context2 = NULL): void' },
  [TM]: { alterForTheme: 'public function alterForTheme(\\Drupal\\Core\\Theme\\ActiveTheme $theme, array|string $type, mixed &$data, mixed &$context1 = NULL, mixed &$context2 = NULL): void' },
  [REGISTRY]: { getRuntime: 'public function getRuntime(): \\Drupal\\Core\\Utility\\ThemeRegistry' },
  [RENDERER]: { doRender: 'protected function doRender(array &$elements, \\Drupal\\Core\\Render\\RenderContext $context, bool $root = FALSE): \\Drupal\\Component\\Render\\MarkupInterface|string' },
  [ENGINE]: { renderTemplate: 'public function renderTemplate(string $template_file, array $variables, array $options = []): \\Drupal\\Component\\Render\\MarkupInterface|string' },
};

function release(version: string): string {
  return version === FUTURE ? '11.4.9' : version;
}

function coreClass(version: string, cls: string): CoreClass | null {
  const key = CORE_SIGNATURES.versions[release(version)]?.classes[cls];
  if (key === undefined) throw new Error(`No release ${version} in the fixture`);
  return key === null ? null : CORE_SIGNATURES.classes[key] ?? null;
}

/** A method's declaration in a release, as the fixture has it (or as the future changes it). */
export function declaration(version: string, cls: string, method: string): string {
  const changed = version === FUTURE ? FUTURE_DECLARATIONS[cls]?.[method] : undefined;
  if (changed) return changed;
  const found = coreClass(version, cls)?.methods[method]?.declaration;
  if (!found) throw new Error(`${cls}::${method} is not in ${version}`);
  return found;
}

/** Whether a release has a method, by the fixture. */
function has(version: string, cls: string, method: string): boolean {
  return !!coreClass(version, cls)?.methods[method];
}

function at(version: string): number[] {
  return release(version).split('.').map(Number);
}

/** Whether a release is the given minor version or later. */
function since(version: string, major: number, minor: number): boolean {
  const [a = 0, b = 0] = at(version);
  return a > major || (a === major && b >= minor);
}

const phpProperty = (name: string, spec: string): string => {
  const words = spec.split(' ');
  const visibility = words.shift();
  const flags: string[] = [];
  while (words[0] === 'static' || words[0] === 'readonly') flags.push(words.shift() as string);
  const type = words.join(' ');
  const typed = type ? (type.split('|').map((t) => (/^[A-Z]/.test(t) && t.includes('\\') ? `\\${t}` : t)).join('|') + ' ') : '';
  return `${visibility} ${flags.join(' ')}${flags.length ? ' ' : ''}${typed}$${name};`;
};

/**
 * Every class the trace extends or reads, as a release declares it, with empty bodies: what the provider reflects
 * on, and what the trace's classes must load against.
 */
export function declarationsOnly(version: string): string {
  const out: string[] = ['<?php'];
  for (const cls of [MH, TM, REGISTRY, RUNTIME, RENDERER, ENGINE, LIST]) {
    const c = coreClass(version, cls);
    if (!c) continue;
    const ns = cls.slice(0, cls.lastIndexOf('\\'));
    const name = cls.slice(cls.lastIndexOf('\\') + 1);
    const body = [
      ...Object.entries(c.properties).map(([p, spec]) => `  ${phpProperty(p, spec)}`),
      ...Object.keys(c.methods).map((m) => `  ${declaration(version, cls, m)} {}`),
    ];
    out.push(`namespace ${ns} {\nclass ${name} {\n${body.join('\n')}\n}\n}`);
  }
  out.push(String.raw`namespace Drupal\Core\DependencyInjection {
  interface ServiceModifierInterface { public function alter(ContainerBuilder $container); }
  final class Definition { public function __construct(private ?string $class) {} public function getClass() { return $this->class; } public function setClass($class) { $this->class = $class; return $this; } }
  final class ContainerBuilder {
    public array $definitions = [];
    public array $parameters = [];
    public function hasDefinition($id) { return isset($this->definitions[$id]); }
    public function getDefinition($id) { return $this->definitions[$id]; }
    public function setDefinition($id, Definition $definition) { return $this->definitions[$id] = $definition; }
    public function setParameter($name, $value) { $this->parameters[$name] = $value; }
  }
}`);
  return out.join('\n');
}

/** Which of core's ways a release has, for the stand-in's bodies. */
function shape(version: string): { mh: '103' | '111' | '112' | '113'; templates: 'functions' | 'invokes' | 'globals'; engine: boolean; context: boolean } {
  return {
    mh: since(version, 11, 3) ? '113' : since(version, 11, 2) ? '112' : since(version, 11, 1) ? '111' : '103',
    templates: since(version, 11, 3) ? 'globals' : since(version, 11, 2) ? 'invokes' : 'functions',
    engine: has(version, ENGINE, 'renderTemplate'),
    context: since(version, 11, 2),
  };
}

const MODULE_HANDLER_COMMON = String.raw`
  protected $moduleList = [];

  /**
   * The stand-in's own: the modules, in their order.
   */
  public function __construct(array $modules) {
    foreach ($modules as $name) {
      $this->moduleList[$name] = new Extension('modules/custom/' . $name);
    }
  }
`;

function moduleHandler(version: string): string {
  const s = shape(version);
  const d = (m: string): string => declaration(version, MH, m);
  const common = String.raw`
  ${d('moduleExists')} {
    return isset($this->moduleList[$module]);
  }

  ${d('getModuleList')} {
    return $this->moduleList;
  }

  ${d('isLoaded')} {
    return TRUE;
  }

  ${d('invokeAll')} {
    $return = [];
    $this->invokeAllWith($hook, function (callable $hook, string $module) use ($args, &$return) {
      $result = call_user_func_array($hook, $args);
      if (isset($result) && is_array($result)) {
        $return = array_merge_recursive($return, $result);
      }
      elseif (isset($result)) {
        $return[] = $result;
      }
    });
    return $return;
  }
`;
  // How each release lists a hook's implementations and runs them: core's own code, with the lists built from
  // the procedural functions the test defines.
  const listing: Record<string, () => string> = {
    '103': () => String.raw`
  protected $alterFunctions = [];
  protected $implementations = [];

  ${d('getImplementationInfo')} {
    if (!isset($this->implementations[$hook])) {
      $this->implementations[$hook] = [];
      foreach ($this->moduleList as $module => $extension) {
        if (function_exists($module . '_' . $hook)) {
          $this->implementations[$hook][$module] = FALSE;
        }
      }
    }
    return $this->implementations[$hook];
  }

  ${d('hasImplementations')} {
    $implementations = array_keys($this->getImplementationInfo($hook));
    return (bool) (isset($modules) ? array_intersect($implementations, (array) $modules) : $implementations);
  }

  ${d('invokeAllWith')} {
    foreach (array_keys($this->getImplementationInfo($hook)) as $module) {
      $hookInvoker = \Closure::fromCallable($module . '_' . $hook);
      $callback($hookInvoker, $module);
    }
  }

  ${d('invoke')} {
    if (!$this->hasImplementations($hook, $module)) {
      return;
    }
    $hookInvoker = \Closure::fromCallable($module . '_' . $hook);
    return call_user_func_array($hookInvoker, $args);
  }

  ${d('alter')} {
    if (is_array($type)) {
      $cid = implode(',', $type);
      $extra_types = $type;
      $type = array_shift($extra_types);
      if (empty($extra_types)) {
        unset($extra_types);
      }
    }
    else {
      $cid = $type;
    }
    if (!isset($this->alterFunctions[$cid])) {
      $this->alterFunctions[$cid] = [];
      $hook = $type . '_alter';
      $modules = array_keys($this->getImplementationInfo($hook));
      if (!isset($extra_types)) {
        foreach ($modules as $module) {
          $this->alterFunctions[$cid][] = $module . '_' . $hook;
        }
      }
      else {
        $extra_modules = [];
        foreach ($extra_types as $extra_type) {
          $extra_modules[] = array_keys($this->getImplementationInfo($extra_type . '_alter'));
        }
        $extra_modules = array_merge(...$extra_modules);
        if (array_diff($extra_modules, $modules)) {
          $modules = array_intersect(array_keys($this->moduleList), array_merge($modules, $extra_modules));
          $implementations = array_fill_keys($modules, FALSE);
          $this->alter('module_implements', $implementations, $hook);
          $modules = array_keys($implementations);
        }
        foreach ($modules as $module) {
          $function = $module . '_' . $hook;
          if (function_exists($function)) {
            $this->alterFunctions[$cid][] = $function;
          }
          foreach ($extra_types as $extra_type) {
            $function = $module . '_' . $extra_type . '_alter';
            if (function_exists($function)) {
              $this->alterFunctions[$cid][] = $function;
            }
          }
        }
      }
    }
    foreach ($this->alterFunctions[$cid] as $function) {
      $function($data, $context1, $context2);
    }
  }
`,
    '111': () => String.raw`
  protected array $alterEventListeners = [];
  protected array $invokeMap = [];

  ${d('getHookListeners')} {
    if (!isset($this->invokeMap[$hook])) {
      foreach ($this->moduleList as $module => $extension) {
        if (function_exists($module . '_' . $hook)) {
          $this->invokeMap[$hook][$module][] = '\\' . $module . '_' . $hook;
        }
      }
    }
    return $this->invokeMap[$hook] ?? [];
  }

  ${d('hasImplementations')} {
    $implementation_modules = array_keys($this->getHookListeners($hook));
    return (bool) (isset($modules) ? array_intersect($implementation_modules, (array) $modules) : $implementation_modules);
  }

  ${d('invokeAllWith')} {
    foreach ($this->getHookListeners($hook) as $module => $listeners) {
      foreach ($listeners as $listener) {
        $callback($listener, $module);
      }
    }
  }

  ${d('invoke')} {
    if ($listeners = $this->getHookListeners($hook)[$module] ?? []) {
      return reset($listeners)(... $args);
    }
    return $this->legacyInvoke($module, $hook, $args);
  }

  ${d('legacyInvoke')} {
    $function = $module . '_' . $hook;
    if (function_exists($function)) {
      return $function(... $args);
    }
    return NULL;
  }

  ${d('reOrderModulesForAlter')} {
    $modules = array_intersect(array_keys($this->moduleList), $modules);
    $implementations = array_fill_keys($modules, FALSE);
    $this->alter('module_implements', $implementations, $hook);
    return array_keys($implementations);
  }

  ${d('alter')} {
    if (is_array($type)) {
      $cid = implode(',', $type);
      $extra_types = $type;
      $type = array_shift($extra_types);
      if (empty($extra_types)) {
        unset($extra_types);
      }
    }
    else {
      $cid = $type;
    }
    if (!isset($this->alterEventListeners[$cid])) {
      $this->alterEventListeners[$cid] = [];
      $hook = $type . '_alter';
      $hook_listeners = $this->getHookListeners($hook);
      if (isset($extra_types)) {
        foreach ($extra_types as $extra_type) {
          foreach ($this->getHookListeners($extra_type . '_alter') as $module => $listeners) {
            if (isset($hook_listeners[$module])) {
              $hook_listeners[$module] = array_merge($hook_listeners[$module], $listeners);
            }
            else {
              $hook_listeners[$module] = $listeners;
              $extra_modules = TRUE;
            }
          }
        }
      }
      $modules = array_keys($hook_listeners);
      if (isset($extra_modules)) {
        $modules = $this->reOrderModulesForAlter($modules, $hook);
      }
      foreach ($modules as $module) {
        foreach ($hook_listeners[$module] ?? [] as $listener) {
          $this->alterEventListeners[$cid][] = $listener;
        }
      }
    }
    foreach ($this->alterEventListeners[$cid] as $listener) {
      $listener($data, $context1, $context2);
    }
  }
`,
    '112': () => String.raw`
  protected array $alterEventListeners = [];
  protected array $invokeMap = [];
  protected array $listenersByHook = [];
  protected array $modulesByHook = [];

  ${d('getFlatHookListeners')} {
    if (!isset($this->listenersByHook[$hook])) {
      $this->listenersByHook[$hook] = [];
      foreach ($this->moduleList as $module => $extension) {
        if (function_exists($module . '_' . $hook)) {
          $this->listenersByHook[$hook][] = '\\' . $module . '_' . $hook;
          $this->modulesByHook[$hook][] = $module;
        }
      }
    }
    return $this->listenersByHook[$hook];
  }

  ${d('getHookListeners')} {
    if (!isset($this->invokeMap[$hook])) {
      $this->invokeMap[$hook] = [];
      foreach ($this->getFlatHookListeners($hook) as $index => $listener) {
        $this->invokeMap[$hook][$this->modulesByHook[$hook][$index]][] = $listener;
      }
    }
    return $this->invokeMap[$hook] ?? [];
  }

  ${d('hasImplementations')} {
    $implementation_modules = array_keys($this->getHookListeners($hook));
    return (bool) (isset($modules) ? array_intersect($implementation_modules, (array) $modules) : $implementation_modules);
  }

  ${d('invokeAllWith')} {
    foreach ($this->getFlatHookListeners($hook) as $index => $listener) {
      $callback($listener, $this->modulesByHook[$hook][$index]);
    }
  }

  ${d('invoke')} {
    if ($listeners = $this->getHookListeners($hook)[$module] ?? []) {
      return reset($listeners)(... $args);
    }
    return $this->legacyInvoke($module, $hook, $args);
  }

  ${d('legacyInvoke')} {
    $function = $module . '_' . $hook;
    if (function_exists($function)) {
      return $function(... $args);
    }
    return NULL;
  }

  ${d('reOrderModulesForAlter')} {
    $modules = array_intersect(array_keys($this->moduleList), $modules);
    $implementations = array_fill_keys($modules, FALSE);
    $this->alter('module_implements', $implementations, $hook);
    return array_keys($implementations);
  }

  ${d('getCombinedListeners')} {
    $by_module = [];
    $extra = FALSE;
    foreach ($hooks as $i => $hook) {
      foreach ($this->getHookListeners($hook) as $module => $listeners) {
        $extra = $extra || ($i > 0 && !isset($by_module[$module]));
        $by_module[$module] = array_merge($by_module[$module] ?? [], $listeners);
      }
    }
    $modules = array_keys($by_module);
    if ($extra) {
      $modules = $this->reOrderModulesForAlter($modules, $hooks[0]);
    }
    return array_merge(...array_map(static fn ($module) => $by_module[$module], $modules));
  }

  ${d('alter')} {
    $cid = is_array($type) ? implode(',', $type) : $type;
    if (!isset($this->alterEventListeners[$cid])) {
      $hooks = is_array($type) ? array_map(static fn (string $type) => $type . '_alter', $type) : [$type . '_alter'];
      $this->alterEventListeners[$cid] = $this->getCombinedListeners($hooks);
    }
    foreach ($this->alterEventListeners[$cid] as $listener) {
      $listener($data, $context1, $context2);
    }
  }
`,
    '113': () => String.raw`
  protected array $alterHookListeners = [];
  protected array $hookImplementationLists = [];

  ${d('getHookImplementationList')} {
    if (!isset($this->hookImplementationLists[$hook])) {
      $listeners = [];
      $modules = [];
      foreach ($this->moduleList as $module => $extension) {
        if (function_exists($module . '_' . $hook)) {
          $listeners[] = $module . '_' . $hook;
          $modules[] = $module;
        }
      }
      $this->hookImplementationLists[$hook] = new \Drupal\Core\Hook\ImplementationList($listeners, $modules);
    }
    return $this->hookImplementationLists[$hook];
  }

  ${d('hasImplementations')} {
    $list = $this->getHookImplementationList($hook);
    return $modules === NULL ? $list->hasImplementations() : $list->hasImplementationsForModules((array) $modules);
  }

  ${d('invokeAllWith')} {
    $list = $this->getHookImplementationList($hook);
    foreach ($list->iterateByModule() as $module => $listener) {
      $callback($listener, $module);
    }
  }

  ${d('invoke')} {
    $listeners = $this->getHookImplementationList($hook)->getForModule($module);
    if ($listeners) {
      return reset($listeners)(... $args);
    }
    return $this->legacyInvoke($module, $hook, $args);
  }

  ${d('legacyInvoke')} {
    $function = $module . '_' . $hook;
    if (function_exists($function)) {
      return $function(... $args);
    }
    return NULL;
  }

  ${d('reOrderModulesForAlter')} {
    $modules = array_intersect(array_keys($this->moduleList), $modules);
    $implementations = array_fill_keys($modules, FALSE);
    $this->alter('module_implements', $implementations, $hook);
    return array_keys($implementations);
  }

  ${d('getCombinedListeners')} {
    $lists = array_filter(array_map($this->getHookImplementationList(...), $hooks), fn (\Drupal\Core\Hook\ImplementationList $list) => $list->hasImplementations());
    if (!$lists) {
      return [];
    }
    if (array_keys($lists) === [0]) {
      return $lists[0]->listeners;
    }
    $identifiers_by_module = [];
    $listeners_by_identifier = [];
    foreach ($lists as $list) {
      foreach ($list->iterateByModule() as $module => $listener) {
        $identifier = is_array($listener) ? get_class($listener[0]) . '::' . $listener[1] : $listener;
        $listeners_by_identifier[$identifier] = $listener;
        $identifiers_by_module[$module][] = $identifier;
      }
    }
    $modules = $this->reOrderModulesForAlter(array_keys($identifiers_by_module), $hooks[0]);
    $identifiers = array_merge(...array_map(fn (string $module) => $identifiers_by_module[$module], $modules));
    return array_map(static fn (string $identifier) => $listeners_by_identifier[$identifier], $identifiers);
  }

  ${d('alter')} {
    $cid = is_array($type) ? implode(',', $type) : $type;
    if (!isset($this->alterHookListeners[$cid])) {
      $hooks = is_array($type) ? array_map(static fn (string $type) => $type . '_alter', $type) : [$type . '_alter'];
      $this->alterHookListeners[$cid] = $this->getCombinedListeners($hooks);
    }
    foreach ($this->alterHookListeners[$cid] as $listener) {
      $listener($data, $context1, $context2);
    }
  }
`,
  };
  return `class ModuleHandler {\n${MODULE_HANDLER_COMMON}${common}${(listing[s.mh] as () => string)()}\n}`;
}

function themeManager(version: string): string {
  const s = shape(version);
  const d = (m: string): string => declaration(version, TM, m);
  // Preprocess, as each release's ThemeManager::render() runs it.
  const preprocess: Record<string, string> = {
    functions: String.raw`
    if (isset($info['preprocess functions'])) {
      foreach ($info['preprocess functions'] as $preprocessor_function) {
        if (is_callable($preprocessor_function)) {
          call_user_func_array($preprocessor_function, [&$variables, $hook, $info]);
        }
      }
    }`,
    invokes: String.raw`
    if (!empty($info['initial preprocess'])) {
      $callable = $info['initial preprocess'];
      $callable($variables, $hook, $info);
    }
    if (isset($info['preprocess functions'])) {
      foreach ($info['preprocess functions'] as $preprocessor_function) {
        if (is_string($preprocessor_function) && isset($invoke_map[$preprocessor_function])) {
          $this->moduleHandler->invoke(... $invoke_map[$preprocessor_function], args: [&$variables, $hook, $info]);
        }
        elseif (is_callable($preprocessor_function)) {
          call_user_func_array($preprocessor_function, [&$variables, $hook, $info]);
        }
      }
    }`,
    globals: String.raw`
    if (!empty($info['initial preprocess'])) {
      $callable = $info['initial preprocess'];
      $callable($variables, $hook, $info);
    }
    $invoke_preprocess_callback = function (mixed $preprocessor_function) use ($invoke_map, &$variables, $hook, $info): mixed {
      if (is_string($preprocessor_function) && isset($invoke_map[$preprocessor_function])) {
        if (isset($invoke_map[$preprocessor_function]['module'])) {
          $handler = $this->moduleHandler;
          $name = $invoke_map[$preprocessor_function]['module'];
        }
        else {
          $handler = $this;
          $name = $invoke_map[$preprocessor_function]['theme'];
        }
        $handler->invoke($name, $invoke_map[$preprocessor_function]['hook'], [&$variables, $hook, $info]);
      }
      elseif (is_callable($preprocessor_function)) {
        call_user_func_array($preprocessor_function, [&$variables, $hook, $info]);
      }
      return $variables;
    };
    $global_preprocess = $theme_registry->getGlobalPreprocess();
    $global_preprocess_called = FALSE;
    if (isset($info['preprocess functions'])) {
      foreach ($info['preprocess functions'] as $preprocessor_function) {
        if (!$global_preprocess_called && is_string($preprocessor_function) && !str_starts_with($preprocessor_function, 'template_')) {
          $global_preprocess_called = TRUE;
          foreach ($global_preprocess as $global_preprocess_callback) {
            $invoke_preprocess_callback($global_preprocess_callback);
          }
        }
        $invoke_preprocess_callback($preprocessor_function);
      }
    }
    if (!$global_preprocess_called) {
      foreach ($global_preprocess as $global_preprocess_callback) {
        $invoke_preprocess_callback($global_preprocess_callback);
      }
    }`,
  };
  const output = s.engine
    ? String.raw`
    $template_file = $info['template'];
    if (isset($info['path'])) {
      $template_file = $info['path'] . '/' . $template_file;
    }
    $variables['theme_hook_suggestions'] = $suggestions;
    $output = [$this->getThemeEngine('twig'), 'renderTemplate']($template_file, $variables);`
    : String.raw`
    $template_file = $info['template'] . '.html.twig';
    if (isset($info['path'])) {
      $template_file = $info['path'] . '/' . $template_file;
    }
    $variables['theme_hook_suggestions'] = $suggestions;
    $output = twig_render_template($template_file, $variables);`;
  // Themes' own hooks: functions named for the theme before 11.3, implementation lists after.
  const themeHooks = s.engine
    ? String.raw`
  protected array $themeHookImplementations = [];

  ${d('invokeAllWith')} {
    foreach ($this->getThemeChain($this->getActiveTheme()) as $theme_key) {
      foreach ($this->getImplementationsForTheme($theme_key, $hook) as $listener) {
        $callback($listener, $theme_key);
      }
    }
  }

  ${d('invoke')} {
    $listeners = $this->getImplementationsForTheme($theme, $hook);
    if ($listeners) {
      return reset($listeners)(... $args);
    }
  }

  ${d('alterForTheme')} {
    if (is_array($type)) {
      $extra_types = $type;
      $type = array_shift($extra_types);
      if (empty($extra_types)) {
        unset($extra_types);
      }
    }
    $listeners = [];
    foreach ($this->getThemeChain($theme) as $theme_key) {
      $listeners = array_merge($listeners, $this->getImplementationsForTheme($theme_key, $type . '_alter'));
      if (isset($extra_types)) {
        foreach ($extra_types as $extra_type) {
          $listeners = array_merge($listeners, $this->getImplementationsForTheme($theme_key, $extra_type . '_alter'));
        }
      }
    }
    foreach (array_filter($listeners) as $callback) {
      $callback($data, $context1, $context2);
    }
  }

  ${d('getImplementationsForTheme')} {
    if (!isset($this->themeHookImplementations[$theme_key][$hook])) {
      $this->themeHookImplementations[$theme_key][$hook] = function_exists($theme_key . '_' . $hook) ? [$theme_key . '_' . $hook] : [];
    }
    return $this->themeHookImplementations[$theme_key][$hook];
  }

  ${d('getThemeChain')} {
    $theme_keys = array_reverse(array_keys($active_theme->getBaseThemeExtensions()));
    $theme_keys[] = $active_theme->getName();
    return $theme_keys;
  }

  ${d('getThemeEngine')} {
    return $name === 'twig' ? \Drupal::service('Drupal\Core\Template\TwigThemeEngine') : NULL;
  }
`
    : String.raw`
  ${d('alterForTheme')} {
    if (is_array($type)) {
      $extra_types = $type;
      $type = array_shift($extra_types);
      if (empty($extra_types)) {
        unset($extra_types);
      }
    }
    $theme_keys = array_reverse(array_keys($theme->getBaseThemeExtensions()));
    $theme_keys[] = $theme->getName();
    $functions = [];
    foreach ($theme_keys as $theme_key) {
      $function = $theme_key . '_' . $type . '_alter';
      if (function_exists($function)) {
        $functions[] = $function;
      }
      if (isset($extra_types)) {
        foreach ($extra_types as $extra_type) {
          $function = $theme_key . '_' . $extra_type . '_alter';
          if (function_exists($function)) {
            $functions[] = $function;
          }
        }
      }
    }
    foreach ($functions as $function) {
      $function($data, $context1, $context2);
    }
  }
`;
  return String.raw`class ThemeManager {

  protected $themeRegistry;

  /**
   * The stand-in's own: the module handler and the active theme.
   */
  public function __construct(protected $moduleHandler, private ActiveTheme $activeTheme) {}

  ${d('setThemeRegistry')} {
    $this->themeRegistry = $theme_registry;
  }

  ${d('getActiveTheme')} {
    return $this->activeTheme;
  }

  ${d('render')} {
    $theme_registry = $this->themeRegistry->getRuntime();
    if (is_array($hook)) {
      foreach ($hook as $candidate) {
        if ($theme_registry->has($candidate)) {
          break;
        }
      }
      $hook = $candidate;
    }
    $original_hook = $hook;
    if (!$theme_registry->has($hook)) {
      while ($pos = strrpos($hook, '__')) {
        $hook = substr($hook, 0, $pos);
        if ($theme_registry->has($hook)) {
          break;
        }
      }
      if (!$theme_registry->has($hook)) {
        return FALSE;
      }
    }
    $info = $theme_registry->get($hook);
    ${s.templates === 'functions' ? '' : '$invoke_map = $theme_registry->getPreprocessInvokes();'}
    if (isset($variables['#theme']) || isset($variables['#theme_wrappers'])) {
      $element = $variables;
      $variables = [];
      if (isset($info['variables'])) {
        foreach (array_keys($info['variables']) as $name) {
          if (\array_key_exists("#$name", $element)) {
            $variables[$name] = $element["#$name"];
          }
        }
      }
      else {
        $variables[$info['render element']] = $element;
        $variables[$info['render element']]['#render_children'] = TRUE;
      }
    }
    if (!empty($info['variables'])) {
      $variables += $info['variables'];
    }
    elseif (!empty($info['render element'])) {
      $variables += [$info['render element'] => []];
    }
    $variables += ['theme_hook_original' => $original_hook];
    $suggestions = $this->buildThemeHookSuggestions($hook, $info['base hook'] ?? '', $variables);
    foreach (array_reverse($suggestions) as $suggestion) {
      if ($theme_registry->has($suggestion)) {
        $info = $theme_registry->get($suggestion);
        break;
      }
    }
${preprocess[s.templates]}
${output}
    return ($output instanceof \Drupal\Component\Render\MarkupInterface) ? $output : (string) $output;
  }

  ${d('buildThemeHookSuggestions')} {
    $base_theme_hook = $info_base_hook ?: $hook;
    $suggestions = $this->moduleHandler->invokeAll('theme_suggestions_' . $base_theme_hook, [$variables]);
    if ($info_base_hook) {
      $suggestions[] = $hook;
    }
    $hooks = ['theme_suggestions', 'theme_suggestions_' . $base_theme_hook];
    $this->moduleHandler->alter($hooks, $suggestions, $variables, $base_theme_hook);
    $this->alter($hooks, $suggestions, $variables, $base_theme_hook);
    return $suggestions;
  }

  ${d('alter')} {
    $this->alterForTheme($this->getActiveTheme(), $type, $data, $context1, $context2);
  }
${themeHooks}
}`;
}

function themeRegistry(version: string): string {
  const s = shape(version);
  const d = (m: string): string => declaration(version, RUNTIME, m);
  return String.raw`class ThemeRegistry {

  /**
   * The stand-in's own: definitions by hook, and 'preprocess invokes' and 'global preprocess'.
   */
  public function __construct(public array $data = []) {}

  ${d('has')} {
    return isset($this->data[$key]);
  }

  ${d('get')} {
    return $this->data[$key] ?? NULL;
  }

  ${d('set')} {
    $this->data[$key] = $value;
  }

  ${d('delete')} {
    unset($this->data[$key]);
  }

  ${d('reset')} {}

  ${d('clear')} {
    $this->data = [];
  }

  ${d('destruct')} {}

  ${d('resolveCacheMiss')} {
    return NULL;
  }

  ${d('initializeRegistry')} {
    return [];
  }
${s.templates !== 'functions' ? String.raw`
  ${d('getPreprocessInvokes')} {
    return $this->get('preprocess invokes') ?? [];
  }
` : ''}${s.templates === 'globals' ? String.raw`
  ${d('getGlobalPreprocess')} {
    return $this->get('global preprocess') ?? [];
  }
` : ''}
}`;
}

function registry(version: string): string {
  const s = shape(version);
  return String.raw`class Registry {

  private ?\Drupal\Core\Utility\ThemeRegistry $runtime = NULL;

  /**
   * The stand-in's own: built from the hooks a test defines (StandIn::define()).
   */
  public function __construct() {}

  ${declaration(version, REGISTRY, 'getRuntime')} {
    if ($this->runtime === NULL) {
      $this->runtime = new \Drupal\Core\Utility\ThemeRegistry(['preprocess invokes' => [], 'global preprocess' => []]);
    }
    return $this->runtime;
  }

  /**
   * A theme hook's definition, as this release's Registry::processExtension() builds it, then altered by modules
   * and themes (hook_theme_registry_alter()). Preprocess functions are the test's procedural ones, found by name.
   */
  public function define(string $hook, array $info): void {
    $runtime = $this->getRuntime();
    $modules = array_keys(\Drupal::moduleHandler()->getModuleList());
    $active = \Drupal::theme()->getActiveTheme();
    $themes = array_merge(array_reverse(array_keys($active->getBaseThemeExtensions())), [$active->getName()]);
    $mode = '${s.templates}';
    $functions = ['template_preprocess'];
    if (function_exists('template_preprocess_' . $hook)) {
      if ($mode === 'functions') {
        $functions[] = 'template_preprocess_' . $hook;
      }
      else {
        $info += ['initial preprocess' => 'template_preprocess_' . $hook];
      }
    }
    $invokes = $runtime->get('preprocess invokes') ?? [];
    $globals = $runtime->get('global preprocess') ?? [];
    foreach ($modules as $module) {
      foreach (['preprocess', 'preprocess_' . $hook] as $name) {
        $function = $module . '_' . $name;
        if (!function_exists($function)) {
          continue;
        }
        if ($mode !== 'functions') {
          $invokes[$function] = ['module' => $module, 'hook' => $name];
        }
        if ($mode === 'globals' && $name === 'preprocess') {
          $globals[$function] = $function;
          continue;
        }
        $functions[] = $function;
      }
    }
    foreach ($themes as $theme) {
      foreach (['preprocess', 'preprocess_' . $hook] as $name) {
        $function = $theme . '_' . $name;
        if (!function_exists($function)) {
          continue;
        }
        if ($mode !== 'functions') {
          $invokes[$function] = [$mode === 'globals' ? 'theme' : 'module' => $theme, 'hook' => $name];
        }
        $functions[] = $function;
      }
    }
    $info += ['type' => 'module', 'preprocess functions' => $functions];
    $cache = [$hook => $info];
    \Drupal::moduleHandler()->alter('theme_registry', $cache);
    \Drupal::theme()->alterForTheme($active, 'theme_registry', $cache);
    $runtime->set($hook, $cache[$hook]);
    $runtime->set('preprocess invokes', $invokes);
    $runtime->set('global preprocess', array_values($globals));
  }

}`;
}

function renderer(version: string): string {
  const s = shape(version);
  const d = (m: string): string => declaration(version, RENDERER, m);
  const child = s.context ? '$this->doRender($elements[$key], $context)' : '$this->doRender($elements[$key])';
  const root = s.context ? '$this->doRender($elements, new RenderContext())' : '$this->doRender($elements, $is_root_call)';
  return String.raw`class Renderer {

  protected $rendererConfig = ['required_cache_contexts' => ['languages:language_interface', 'theme']];
  protected $renderCache;

  /**
   * The stand-in's own: the theme manager; a render cache that has nothing.
   */
  public function __construct(protected $theme) {
    $this->renderCache = new class {
      public function get(array $elements) {
        return FALSE;
      }
    };
  }

  ${d('render')} {
    return ${root};
  }

  ${d('executeInRenderContext')} {
    return $callable();
  }

  ${d('doRenderPlaceholder')} {
    $placeholder_element['#create_placeholder'] = FALSE;
    return $this->render($placeholder_element);
  }

  ${d('doRender')} {
    if (empty($elements)) {
      return '';
    }
    if (isset($elements['#access']) && $elements['#access'] === FALSE) {
      return '';
    }
    if (!empty($elements['#printed'])) {
      return '';
    }
    if (isset($elements['#type']) && empty($elements['#defaults_loaded'])) {
      $elements += \Drupal::service('element_info')->getInfo($elements['#type']);
      $elements['#defaults_loaded'] = TRUE;
    }
    if (isset($elements['#cache']['keys'])) {
      $this->renderCache->get($elements);
    }
    if (isset($elements['#lazy_builder'])) {
      [$callable, $args] = $elements['#lazy_builder'];
      $new_elements = call_user_func_array($callable, $args);
      $new_elements += $elements;
      unset($new_elements['#lazy_builder']);
      $elements = $new_elements;
    }
    foreach ($elements['#pre_render'] ?? [] as $callable) {
      $elements = call_user_func($callable, $elements);
    }
    $elements['#children'] = '';
    $theme_is_implemented = FALSE;
    if (isset($elements['#theme'])) {
      $output = $this->theme->render($elements['#theme'], $elements);
      $theme_is_implemented = $output !== FALSE;
      if ($theme_is_implemented) {
        $elements['#children'] = $output;
      }
    }
    if (!$theme_is_implemented) {
      $children = isset($elements['#markup']) ? (string) $elements['#markup'] : '';
      foreach (Element::children($elements) as $key) {
        if (is_array($elements[$key])) {
          $children .= ${child};
        }
      }
      $elements['#children'] = $children;
    }
    foreach ($elements['#theme_wrappers'] ?? [] as $key => $value) {
      $wrapper = is_string($key) ? $key : $value;
      $elements['#children'] = $this->theme->render($wrapper, $elements);
    }
    foreach ($elements['#post_render'] ?? [] as $callable) {
      $elements['#children'] = call_user_func($callable, $elements['#children'], $elements);
    }
    $elements['#markup'] = Markup::create(($elements['#prefix'] ?? '') . $elements['#children'] . ($elements['#suffix'] ?? ''));
    $elements['#printed'] = TRUE;
    return $elements['#markup'];
  }

}`;
}

/**
 * A working stand-in core of a release's shape, and its StandIn helper: what a test requires before rendering a
 * page through the helper's trace.
 */
export function standInCore(version: string): string {
  const s = shape(version);
  const engine = s.engine
    ? String.raw`
namespace Drupal\Core\Theme {
  interface ThemeEngineInterface {}
}
namespace Drupal\Core\Template {
  class TwigThemeEngine implements \Drupal\Core\Theme\ThemeEngineInterface {
    ${declaration(version, ENGINE, 'renderTemplate')} {
      return \StandIn::template($template_file . '.html.twig', $variables);
    }
  }
}`
    : String.raw`
namespace {
  function twig_render_template($template_file, array $variables) {
    return \StandIn::template($template_file, $variables);
  }
}`;
  const list = s.mh === '113'
    ? String.raw`
namespace Drupal\Core\Hook {
  final class ImplementationList {
    ${declaration(version, LIST, '__construct')} {
      $this->listeners = $listeners;
      $this->modules = $modules;
    }
    public array $listeners;
    public array $modules;
    ${declaration(version, LIST, 'iterateByModule')} {
      foreach ($this->listeners as $i => $listener) {
        yield $this->modules[$i] => $listener;
      }
    }
    ${declaration(version, LIST, 'getForModule')} {
      return array_values(array_intersect_key($this->listeners, array_intersect($this->modules, [$module])));
    }
    ${declaration(version, LIST, 'hasImplementations')} {
      return $this->listeners !== [];
    }
    ${declaration(version, LIST, 'hasImplementationsForModules')} {
      return (bool) array_intersect($this->modules, $modules);
    }
  }
}`
    : '';
  return String.raw`<?php
// A stand-in Drupal core shaped like ${version} (src/core/live-helper-drupal-stand-in.ts). For tests only.

namespace Drupal\Component\Render {
  interface MarkupInterface extends \Stringable {}
}
namespace Drupal\Component\Utility {
  final class Html {
    public static function escape($s) { return htmlspecialchars((string) $s, ENT_QUOTES); }
  }
  final class Xss {
    public static function filterAdmin($s) { return (string) $s; }
  }
}
namespace Drupal\Core\Cache {
  final class Cache {
    public static function mergeContexts(array ...$contexts) {
      $merged = array_values(array_unique(array_merge(...$contexts)));
      sort($merged);
      return $merged;
    }
  }
}
namespace Drupal\Core\Security {
  interface TrustedCallbackInterface {
    public static function trustedCallbacks();
  }
}
namespace Drupal\Core\Entity {
  interface EntityInterface {}
  interface FieldableEntityInterface extends EntityInterface {}
  interface ContentEntityInterface extends FieldableEntityInterface {}
}
namespace Drupal\Core\Field {
  interface FieldItemInterface {}
  interface FieldItemListInterface {}
}
namespace Drupal\Core\Block {
  interface BlockPluginInterface {}
}
namespace Drupal\Core\DependencyInjection {
  interface ServiceModifierInterface {
    public function alter(ContainerBuilder $container);
  }
  final class Definition {
    public function __construct(private ?string $class) {}
    public function getClass() { return $this->class; }
    public function setClass($class) { $this->class = $class; return $this; }
  }
  final class ContainerBuilder {
    public array $definitions = [];
    public array $parameters = [];
    public function hasDefinition($id) { return isset($this->definitions[$id]); }
    public function getDefinition($id) { return $this->definitions[$id]; }
    public function setDefinition($id, Definition $definition) { return $this->definitions[$id] = $definition; }
    public function setParameter($name, $value) { $this->parameters[$name] = $value; }
  }
}
namespace Drupal\Core\Render {
  final class Markup implements \Drupal\Component\Render\MarkupInterface {
    private function __construct(private string $s) {}
    public static function create($s) { return new self((string) $s); }
    public function __toString(): string { return $this->s; }
  }
  class RenderContext {}
  final class Element {
    public static function children(array $elements, $sort = FALSE) {
      return array_values(array_filter(array_keys($elements), static fn ($key) => !is_string($key) || $key === '' || $key[0] !== '#'));
    }
  }
  ${renderer(version)}
}
namespace Drupal\Core\Extension {
  final class Extension {
    public function __construct(private string $path) {}
    public function getPath() { return $this->path; }
  }
  ${moduleHandler(version)}
}
${list}
namespace Drupal\Core\Theme {
  final class ActiveTheme {
    public function __construct(private string $name, private array $base = []) {}
    public function getName() { return $this->name; }
    public function getBaseThemeExtensions() { return array_fill_keys($this->base, NULL); }
    public function getEngine() { return 'twig'; }
    public function getRegions() { return ['header', 'content', 'footer']; }
  }
  ${themeManager(version)}
  ${registry(version)}
}
namespace Drupal\Core\Utility {
  ${themeRegistry(version)}
}
${engine}
namespace {
  use Drupal\Core\DependencyInjection\ContainerBuilder;
  use Drupal\Core\DependencyInjection\Definition;

  /**
   * A small service container, as \Drupal reads it.
   */
  final class Drupal {
    public static array $services = [];
    public static string $root = '';
    public static function root() { return self::$root; }
    public static function hasService($id) { return isset(self::$services[$id]); }
    public static function service($id) {
      if (!isset(self::$services[$id])) {
        throw new \RuntimeException('No ' . $id . ' in this stand-in.');
      }
      if (self::$services[$id] instanceof \Closure) {
        self::$services[$id] = (self::$services[$id])();
      }
      return self::$services[$id];
    }
    public static function moduleHandler() { return self::service('module_handler'); }
    public static function theme() { return self::service('theme.manager'); }
    public static function currentUser() { return self::service('current_user'); }
    public static function entityTypeManager() { return self::service('entity_type.manager'); }
    public static function logger($channel) { return self::service('logger.factory')->get($channel); }
  }

  /**
   * The test's side of the stand-in: booting it, defining theme hooks and templates, and building blocks and
   * entities as core's view builders do (their alter hooks included).
   */
  final class StandIn {
    public const VERSION = '${version}';

    /** Templates by file: closures given the template's variables. */
    public static array $templates = [];

    /** Element types' defaults (element_info), before modules alter them. */
    public static array $elementInfo = [];

    /** Which class the provider put in place for each service. */
    public static array $classes = [];

    /** What the site logged. */
    public static array $log = [];

    /**
     * Compiles the container with the helper's provider, and starts the services it chose.
     */
    public static function boot(array $modules, string $theme, string $helper): void {
      spl_autoload_register(static function (string $class) use ($helper) {
        if (str_starts_with($class, 'Drupal\\wanigan_live\\')) {
          $file = $helper . '/src/' . strtr(substr($class, strlen('Drupal\\wanigan_live\\')), '\\', '/') . '.php';
          if (is_file($file)) {
            require $file;
          }
        }
      });
      require_once $helper . '/wanigan_live.module';
      $container = new ContainerBuilder();
      foreach (['module_handler' => 'Drupal\Core\Extension\ModuleHandler', 'theme.manager' => 'Drupal\Core\Theme\ThemeManager', 'theme.registry' => 'Drupal\Core\Theme\Registry', 'renderer' => 'Drupal\Core\Render\Renderer', 'Drupal\Core\Template\TwigThemeEngine' => 'Drupal\Core\Template\TwigThemeEngine'] as $id => $class) {
        if (class_exists($class)) {
          $container->setDefinition($id, new Definition($class));
        }
      }
      (new \Drupal\wanigan_live\WaniganLiveServiceProvider())->alter($container);
      $class = fn ($id) => $container->hasDefinition($id) ? $container->getDefinition($id)->getClass() : NULL;
      self::$classes = array_map(fn ($d) => $d->getClass(), $container->definitions);
      $modules_handler = new ($class('module_handler'))($modules);
      $themes = new ($class('theme.manager'))($modules_handler, new \Drupal\Core\Theme\ActiveTheme($theme));
      $registry = new ($class('theme.registry'))();
      $themes->setThemeRegistry($registry);
      Drupal::$services['module_handler'] = $modules_handler;
      Drupal::$services['theme.manager'] = $themes;
      Drupal::$services['theme.registry'] = $registry;
      Drupal::$services['renderer'] = new ($class('renderer'))($themes);
      if ($class('Drupal\Core\Template\TwigThemeEngine')) {
        Drupal::$services['Drupal\Core\Template\TwigThemeEngine'] = new ($class('Drupal\Core\Template\TwigThemeEngine'))();
      }
      Drupal::$services['element_info'] = new class {
        private ?array $info = NULL;
        public function getInfo($type) {
          if ($this->info === NULL) {
            $this->info = StandIn::$elementInfo;
            \Drupal::moduleHandler()->alter('element_info', $this->info);
          }
          return $this->info[$type] ?? [];
        }
      };
      Drupal::$services['wanigan_live.token'] = new class {
        public function carried($request = NULL): bool { return FALSE; }
      };
      Drupal::$services['current_user'] = new class {
        public function id() { return 1; }
        public function getDisplayName() { return 'editor'; }
        public function getRoles() { return ['authenticated']; }
      };
      Drupal::$services['logger.factory'] = new class {
        public function get($channel) {
          return new class($channel) {
            public function __construct(private string $channel) {}
            public function warning($message, $context = []) { StandIn::$log[] = $this->channel . ': ' . strtr($message, $context); }
            public function notice($message, $context = []) { StandIn::$log[] = $this->channel . ': ' . strtr($message, $context); }
          };
        }
      };
      Drupal::$services['entity_type.manager'] = new class {
        public function hasDefinition($type) { return FALSE; }
      };
      Drupal::$services['entity_type.bundle.info'] = new class {
        public function getBundleInfo($type) { return []; }
      };
    }

    /**
     * A theme hook, its template file and what renders it: the registry's definition is built as this release
     * builds it, from the preprocess functions the test defines.
     */
    public static function define(string $hook, array $info, string $file, callable $template): void {
      self::$templates[$file] = $template;
      $info += ['template' => basename($file, '.html.twig'), 'path' => dirname($file)];
      Drupal::service('theme.registry')->define($hook, $info);
    }

    /**
     * A template's output, as Twig would print it.
     */
    public static function template(string $file, array $variables) {
      if (!isset(self::$templates[$file])) {
        throw new \RuntimeException('No template ' . $file . ' in this stand-in.');
      }
      return \Drupal\Core\Render\Markup::create((string) (self::$templates[$file])($variables));
    }

    /**
     * What a template prints for a render array: Twig's render filter.
     */
    public static function render($element): string {
      if (!is_array($element)) {
        return (string) $element;
      }
      return (string) Drupal::service('renderer')->render($element);
    }

    /**
     * A block, as BlockViewBuilder::buildPreRenderableBlock() builds it: hook_block_view_alter() may add callbacks.
     */
    public static function block(array $build, string $plugin): array {
      $block = new class implements \Drupal\Core\Block\BlockPluginInterface {};
      Drupal::moduleHandler()->alter(['block_view', 'block_view_' . explode(':', $plugin)[0]], $build, $block);
      return $build;
    }

    /**
     * An entity's build, as EntityViewBuilder::getBuildDefaults() starts it: hook_entity_build_defaults_alter()
     * may add callbacks.
     */
    public static function entity(array $build, $entity, string $type, string $view_mode): array {
      Drupal::moduleHandler()->alter([$type . '_build_defaults', 'entity_build_defaults'], $build, $entity, $view_mode);
      return $build;
    }
  }

  /**
   * template_preprocess(), as the stand-in's: what a test gives a template besides its element, as core's own
   * template_preprocess_HOOK() functions build them ('#wl_variables', which no template sees).
   */
  function template_preprocess(&$variables, $hook, $info) {
    $key = $info['render element'] ?? NULL;
    if ($key !== NULL && isset($variables[$key]['#wl_variables'])) {
      $variables += $variables[$key]['#wl_variables'];
      unset($variables[$key]['#wl_variables']);
    }
    if (array_key_exists('wl_variables', $variables)) {
      $variables += (array) $variables['wl_variables'];
      unset($variables['wl_variables']);
    }
  }
}
`;
}
