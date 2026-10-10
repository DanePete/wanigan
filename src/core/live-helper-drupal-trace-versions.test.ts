// The Drupal helper's trace on every core release it supports (core_version_requirement ^10.3 || ^11), run under
// PHP against stand-ins of each release (live-helper-drupal-stand-in.ts): which of the trace's classes the service
// provider puts in place, judged by each release's real signatures (fixtures/drupal-core-trace-signatures.json, read
// from the release tarballs), and that each one it picks loads against them; then a page rendered through a working
// stand-in of 10.6, 11.0, 11.1, 11.2 and 11.4 is traced the same way on each, and through a core none of the classes
// fits (a future release), its parts are still found and named, through hooks, with what that loses said in the
// trace. Nothing here runs Drupal or touches a site; the content is made up (acme, northwind).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { DRUPAL_HELPER_FILES } from './live-helper-drupal.ts';
import { which } from './environment.ts';
import { CORE_RELEASES, CORE_SIGNATURES, FUTURE, declarationsOnly, standInCore } from './live-helper-drupal-stand-in.ts';
import { parseTrace, type LiveTrace, type TracePart } from '../shared/live-trace.ts';

const php = which('php', process.env.PATH ?? '');
const T = 'Drupal\\wanigan_live\\Trace\\';
const ENGINE = 'Drupal\\Core\\Template\\TwigThemeEngine';

/** Writes the helper's files into a folder, under helper/. */
function writeHelper(folder: string): string {
  const helper = join(folder, 'helper');
  for (const [file, text] of Object.entries(DRUPAL_HELPER_FILES)) {
    const path = join(helper, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  return helper;
}

function runPhp(folder: string, script: string, env: Record<string, string> = {}): unknown {
  writeFileSync(join(folder, 'check.php'), script);
  const out = execFileSync(php as string, [join(folder, 'check.php')], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...env } });
  try {
    return JSON.parse(out) as unknown;
  } catch {
    throw new Error(`Not JSON from PHP: ${out.slice(0, 4000)}`);
  }
}

/** The trace's class for each service, on each release: written against that release's signatures. */
const FAMILY: Record<string, Record<string, string | null>> = {};
for (const v of CORE_RELEASES) {
  const [major = 0, minor = 0] = v.split('.').map(Number);
  const at = (a: number, b: number): boolean => major > a || (major === a && minor >= b);
  FAMILY[v] = {
    module_handler: T + (at(11, 3) ? 'TraceModuleHandler' : at(11, 2) ? 'TraceModuleHandler112' : at(11, 1) ? 'TraceModuleHandler111' : 'TraceModuleHandler103'),
    'theme.manager': T + (at(11, 3) ? 'TraceThemeManager' : 'TraceThemeManager103'),
    'theme.registry': T + (at(11, 3) ? 'TraceRegistry' : at(11, 2) ? 'TraceRegistry112' : 'TraceRegistry103'),
    renderer: T + (at(11, 2) ? 'TraceRenderer' : 'TraceRenderer103'),
    [ENGINE]: at(11, 3) ? T + 'TraceThemeEngine' : null,
  };
}

/** What the provider made of a release's signatures, read in PHP (one process each: the classes are that release's). */
function choose(declarations: string): { classes: Record<string, string>; parameter: { parts: string; classes: Record<string, string | null> }; loaded: string[]; after: string[]; fits: Record<string, string[]> } {
  const folder = mkdtempSync(join(tmpdir(), 'wanigan-drupal-provider-'));
  try {
    const helper = writeHelper(folder);
    writeFileSync(join(folder, 'core.php'), declarations);
    return runPhp(folder, String.raw`<?php
require getenv('WL_FOLDER') . '/core.php';
spl_autoload_register(static function (string $class) {
  if (str_starts_with($class, 'Drupal\\wanigan_live\\')) {
    $file = getenv('WL_HELPER') . '/src/' . strtr(substr($class, strlen('Drupal\\wanigan_live\\')), '\\', '/') . '.php';
    if (is_file($file)) {
      require $file;
    }
  }
});
use Drupal\Core\DependencyInjection\ContainerBuilder;
use Drupal\Core\DependencyInjection\Definition;
use Drupal\wanigan_live\WaniganLiveServiceProvider;
$container = new ContainerBuilder();
foreach (['module_handler' => 'Drupal\Core\Extension\ModuleHandler', 'theme.manager' => 'Drupal\Core\Theme\ThemeManager', 'theme.registry' => 'Drupal\Core\Theme\Registry', 'renderer' => 'Drupal\Core\Render\Renderer', 'Drupal\Core\Template\TwigThemeEngine' => 'Drupal\Core\Template\TwigThemeEngine'] as $id => $class) {
  if (class_exists($class)) {
    $container->setDefinition($id, new Definition($class));
  }
}
(new WaniganLiveServiceProvider())->alter($container);
$before = array_values(array_filter(get_declared_classes(), fn ($c) => str_starts_with($c, 'Drupal\\wanigan_live\\Trace\\')));
// Every family that fits, for each service: one at most.
$fits = [];
foreach (WaniganLiveServiceProvider::SWAPS as $id => [$core, $families]) {
  $fits[$id] = array_keys(array_filter($families, fn ($signatures, $class) => WaniganLiveServiceProvider::fits(WaniganLiveServiceProvider::withOwn($id, $core, $signatures)), ARRAY_FILTER_USE_BOTH));
}
$classes = array_map(fn ($d) => $d->getClass(), $container->definitions);
// Each class put in place loads against this release's declarations (a class that did not fit would be a fatal error).
foreach ($classes as $class) {
  if (!str_starts_with($class, 'Drupal\\Core\\') && !class_exists($class)) {
    throw new \RuntimeException('No class ' . $class);
  }
}
$after = array_values(array_filter(get_declared_classes(), fn ($c) => str_starts_with($c, 'Drupal\\wanigan_live\\Trace\\')));
echo json_encode(['classes' => $classes, 'parameter' => $container->parameters['wanigan_live.trace'] ?? NULL, 'loaded' => $before, 'after' => $after, 'fits' => $fits]);
`, { WL_FOLDER: folder, WL_HELPER: helper }) as ReturnType<typeof choose>;
  } finally { rmSync(folder, { recursive: true, force: true }); }
}

test('the fixture holds every supported minor release, each read from its own tarball', () => {
  assert.deepEqual(CORE_RELEASES.map((v) => v.split('.').slice(0, 2).join('.')), ['10.3', '10.4', '10.5', '10.6', '11.0', '11.1', '11.2', '11.3', '11.4']);
  for (const v of CORE_RELEASES) {
    for (const cls of ['Drupal\\Core\\Extension\\ModuleHandler', 'Drupal\\Core\\Theme\\ThemeManager', 'Drupal\\Core\\Theme\\Registry', 'Drupal\\Core\\Utility\\ThemeRegistry', 'Drupal\\Core\\Render\\Renderer']) {
      const key = CORE_SIGNATURES.versions[v]?.classes[cls];
      assert.ok(key && CORE_SIGNATURES.classes[key]?.versions.includes(v), `${cls} in ${v}`);
    }
  }
  // What the families are told apart by, as core has it.
  const method = (v: string, cls: string, m: string): string | undefined => CORE_SIGNATURES.classes[CORE_SIGNATURES.versions[v]?.classes[cls] ?? '']?.methods[m]?.signature;
  assert.equal(method('10.6.18', 'Drupal\\Core\\Render\\Renderer', 'doRender'), '(&$elements, $is_root_call)');
  assert.equal(method('11.4.9', 'Drupal\\Core\\Render\\Renderer', 'doRender'), '(array &$elements, Drupal\\Core\\Render\\RenderContext $context): Drupal\\Component\\Render\\MarkupInterface|string');
  assert.equal(method('10.6.18', 'Drupal\\Core\\Extension\\ModuleHandler', 'getImplementationInfo'), '($hook)');
  assert.equal(method('11.1.10', 'Drupal\\Core\\Extension\\ModuleHandler', 'getHookListeners'), '(string $hook): array');
  assert.equal(method('11.2.14', 'Drupal\\Core\\Utility\\ThemeRegistry', 'getPreprocessInvokes'), '()');
  assert.equal(method('11.3.18', 'Drupal\\Core\\Utility\\ThemeRegistry', 'getGlobalPreprocess'), '(): array');
  assert.equal(CORE_SIGNATURES.versions['11.2.14']?.classes[ENGINE], null, 'no theme engine service before 11.3');
  assert.equal(CORE_SIGNATURES.versions['11.2.14']?.functions.twig_render_template, '($template_file, array $variables): Drupal\\Component\\Render\\MarkupInterface|string');
});

for (const version of CORE_RELEASES) {
  test(`on ${version} the provider puts in place the classes written against its signatures, each loads, and no other is loaded`, (t) => {
    if (!php) { t.skip('PHP is not installed here'); return; }
    const out = choose(declarationsOnly(version));
    const expected = FAMILY[version] as Record<string, string | null>;
    for (const [id, cls] of Object.entries(expected)) {
      if (cls === null) {
        assert.equal(out.classes[id], undefined, `${id}: no such service on ${version}`);
        continue;
      }
      assert.equal(out.classes[id], cls, `${id} on ${version}`);
      assert.deepEqual(out.fits[id], [cls], `${id}: exactly one family fits ${version}`);
    }
    assert.equal(out.parameter.parts, 'swaps', 'every template is opened and marked by the classes in place');
    // The provider read signatures only: no class of the trace was loaded to decide.
    assert.deepEqual(out.loaded, [], 'the provider loads none of the trace\'s classes');
    // Each one it chose is now loaded, against this release's declarations, and no class of another release's.
    // (TraceRegistry112 and TraceRegistry103 extend TraceRegistry, whose own methods are the same on every release.)
    const chosen = Object.values(expected).filter((c): c is string => c !== null).flatMap((c) => (/TraceRegistry\d+$/.test(c) ? [c, T + 'TraceRegistry'] : [c]));
    for (const cls of chosen) assert.ok(out.after.includes(cls), `${cls} loaded`);
    const others = Object.values(FAMILY).flatMap((f) => Object.values(f)).filter((c): c is string => c !== null && !chosen.includes(c));
    for (const cls of others) assert.ok(!out.after.includes(cls), `${cls} not loaded on ${version}`);
  });
}

test('a core none of the trace\'s classes fits keeps its own, and parts are then found through hooks', (t) => {
  if (!php) { t.skip('PHP is not installed here'); return; }
  const out = choose(declarationsOnly(FUTURE));
  for (const id of ['module_handler', 'theme.manager', 'theme.registry', 'renderer', ENGINE]) {
    assert.match(out.classes[id] ?? '', /^Drupal\\Core\\/, `${id} keeps core's class`);
    assert.deepEqual(out.fits[id], [], `${id}: no family fits`);
  }
  assert.equal(out.parameter.parts, 'hooks');
});

test('without a way to mark templates, the theme registry and renderer stay core\'s too: the theme side is one piece', (t) => {
  if (!php) { t.skip('PHP is not installed here'); return; }
  // 11.4, but its Twig engine's renderTemplate() takes another argument: nothing marks a template's output.
  const declarations = declarationsOnly('11.4.9').replace(
    'public function renderTemplate(string $template_file, array $variables): \\Drupal\\Component\\Render\\MarkupInterface|string {}',
    'public function renderTemplate(string $template_file, array $variables, array $options = []): \\Drupal\\Component\\Render\\MarkupInterface|string {}',
  );
  assert.notEqual(declarations, declarationsOnly('11.4.9'));
  const out = choose(declarations);
  assert.equal(out.classes.module_handler, T + 'TraceModuleHandler', 'hooks are still timed');
  assert.equal(out.classes['theme.manager'], T + 'TraceThemeManager');
  assert.equal(out.classes['theme.registry'], 'Drupal\\Core\\Theme\\Registry');
  assert.equal(out.classes.renderer, 'Drupal\\Core\\Render\\Renderer');
  assert.equal(out.classes[ENGINE], ENGINE);
  assert.equal(out.parameter.parts, 'hooks');
});

/** A made-up page, rendered through a release's stand-in and the trace's classes the provider put in place. */
const PAGE = String.raw`<?php
namespace Drupal\wanigan_live\Edit {
  // Edit targets and stored orders read forms and access; neither is what this proves.
  final class Targets {
    public function __construct($builder) {}
    public function forPart(array $p): array { return []; }
    public static function variableEdit($p, $name, $edits) { return NULL; }
  }
  final class Moves { public static function levelOrder($menu, $parent) { return []; } }
}
namespace Drupal\wanigan_live\Trace {
  final class SaveCode {
    public static function forTarget($id, $p) { return NULL; }
    public static function forCollection($p, $changes) { return NULL; }
    public static function forEntityType($type) { return NULL; }
  }
}
namespace {
  use Drupal\wanigan_live\Trace\Recorder;
  use Drupal\wanigan_live\Trace\TraceBuilder;

  require getenv('WL_FOLDER') . '/core.php';

  final class Node implements Drupal\Core\Entity\FieldableEntityInterface {
    public function __construct(public string $id, public string $uuid, public string $bundle, public string $label) {}
    public function getEntityTypeId() { return 'node'; }
    public function id() { return $this->id; }
    public function uuid() { return $this->uuid; }
    public function bundle() { return $this->bundle; }
    public function label() { return $this->label; }
    public function isNew() { return FALSE; }
    public function language() { return new class { public function getId() { return 'en'; } }; }
    public function getEntityType() { return new class { public function isRevisionable() { return FALSE; } public function hasKey($k) { return TRUE; } public function getLabel() { return 'Content'; } }; }
    public function access($op, $account = NULL, $object = FALSE) { return new class { public function isAllowed() { return TRUE; } public function isForbidden() { return FALSE; } }; }
  }
  final class Item implements Drupal\Core\Field\FieldItemInterface {
    public function __construct(private array $v) {}
    public function getValue() { return $this->v; }
  }
  final class Items implements Drupal\Core\Field\FieldItemListInterface {
    public function __construct(private array $items) {}
    public function offsetExists($d) { return isset($this->items[$d]); }
    public function get($d) { return $this->items[$d]; }
  }
  final class Link {
    public function __construct(private string $id) {}
    public function getPluginId() { return $this->id; }
    public function getMetaData() { return []; }
    public function getEditRoute() { return NULL; }
    public function getTitle() { return $this->id; }
  }

  // The site's hooks: a module (acme) and its theme (acme_theme), procedural, as every release runs them.
  function acme_theme_suggestions_node(array $variables) {
    return ['node__' . $variables['elements']['#node']->bundle()];
  }
  function acme_theme_suggestions_alter(array &$suggestions, array $variables, $hook) {
    if ($hook === 'block') {
      $suggestions[] = 'block__acme';
    }
  }
  function acme_theme_theme_suggestions_node_alter(array &$suggestions, array $variables) {
    $suggestions[] = 'node__acme_theme';
  }
  function acme_preprocess_node(&$variables) {
    $variables['acme_flag'] = TRUE;
  }
  function acme_theme_preprocess_node(&$variables) {
    $variables['theme_flag'] = 'northwind';
  }
  function acme_theme_preprocess_block(&$variables) {
    $variables['attributes']['class'][] = 'acme-block';
  }

  // Core's own template preprocess, as the variables its templates are given.
  function template_preprocess_page(&$variables) {
    $variables['content'] = $variables['page']['content'] ?? [];
  }
  function template_preprocess_region(&$variables) {
    $variables['content'] = $variables['elements']['#children'];
    $variables['region'] = $variables['elements']['#region'];
  }
  function template_preprocess_block(&$variables) {
    $variables['content'] = $variables['elements']['content'] ?? [];
    $variables['label'] = $variables['elements']['#configuration']['label'] ?? '';
    $variables['plugin_id'] = $variables['elements']['#plugin_id'];
  }
  function template_preprocess_node(&$variables) {
    $variables['node'] = $variables['elements']['#node'];
    $variables['content'] = [];
    foreach (Drupal\Core\Render\Element::children($variables['elements']) as $key) {
      $variables['content'][$key] = $variables['elements'][$key];
    }
  }
  function template_preprocess_field(&$variables) {
    $element = $variables['element'];
    $variables['items'] = [];
    foreach (Drupal\Core\Render\Element::children($element) as $delta) {
      $variables['items'][$delta] = ['content' => $element[$delta]];
    }
  }

  // Building: a block's lazy builder, and a node's #pre_render that adds its fields.
  function wl_lazy_block(string $which) {
    $node = $GLOBALS['wl_node'];
    if ($which === 'main') {
      $node_build = StandIn::entity(['#theme' => 'node', '#node' => $node, '#view_mode' => 'full', '#pre_render' => ['wl_build_node'], '#cache' => ['keys' => ['entity_view', 'node', '1', 'full']]], $node, 'node', 'full');
      return StandIn::block(['#theme' => 'block', '#id' => 'acme_content', '#plugin_id' => 'system_main_block', '#configuration' => ['label' => 'Main content'], 'content' => $node_build], 'system_main_block');
    }
    $items = [];
    foreach (['standard.front_page' => 'Home', 'acme.about' => 'About'] as $plugin => $title) {
      $items[$plugin] = ['title' => $title, 'original_link' => new Link($plugin), 'below' => []];
    }
    return StandIn::block(['#theme' => 'block', '#id' => 'acme_main_menu', '#plugin_id' => 'system_menu_block:main', '#configuration' => ['label' => 'Main navigation'], 'content' => ['#theme' => 'menu__main', '#menu_name' => 'main', '#items' => $items]], 'system_menu_block:main');
  }
  function wl_build_node(array $build) {
    $node = $build['#node'];
    $build['body'] = ['#theme' => 'field', '#field_name' => 'body', '#field_type' => 'text_long', '#object' => $node, '#items' => new Items([new Item(['value' => 'Hello']), new Item(['value' => 'World'])]), '#title' => 'Body', '#view_mode' => 'full', '#formatter' => 'text_default', 0 => ['#markup' => 'Hello'], 1 => ['#markup' => 'World']];
    return $build;
  }

  $helper = getenv('WL_HELPER');
  Drupal::$root = getenv('WL_FOLDER') . '/web';
  StandIn::$elementInfo['page'] = ['#theme' => 'page'];
  StandIn::boot(['acme', 'wanigan_live'], 'acme_theme', $helper);
  Drupal::$services['entity_type.manager'] = new class {
    public function hasDefinition($type) { return FALSE; }
    public function getStorage($type) { return new class { public function load($id) { return new class($id) { public function __construct(private string $id) {} public function label() { return ucfirst($this->id) . ' navigation'; } }; } }; }
  };
  Drupal::$services['plugin.manager.menu.link'] = new class { public function createInstance($id) { return new Link($id); } };
  $render = fn ($e) => StandIn::render($e);
  StandIn::define('page', ['render element' => 'page'], 'core/modules/system/templates/page.html.twig', fn ($v) => '<main>' . $render($v['content']) . '</main>');
  StandIn::define('region', ['render element' => 'elements'], 'core/modules/system/templates/region.html.twig', fn ($v) => '<div class="region">' . $v['content'] . '</div>');
  StandIn::define('block', ['render element' => 'elements'], 'core/modules/block/templates/block.html.twig', fn ($v) => '<div class="block"><h2>' . $v['label'] . '</h2>' . $render($v['content']) . '</div>');
  StandIn::define('node', ['render element' => 'elements'], 'core/modules/node/templates/node.html.twig', fn ($v) => '<article>' . implode('', array_map($render, $v['content'])) . '</article>');
  StandIn::define('field', ['render element' => 'element'], 'core/modules/system/templates/field.html.twig', fn ($v) => '<div class="field">' . implode('', array_map(fn ($i) => '<div>' . $render($i['content']) . '</div>', $v['items'])) . '</div>');
  StandIn::define('menu', ['variables' => ['menu_name' => NULL, 'items' => []]], 'core/modules/system/templates/menu.html.twig', fn ($v) => '<ul>' . implode('', array_map(fn ($i) => '<li><a href="#">' . $i['title'] . '</a></li>', $v['items'])) . '</ul>');

  $GLOBALS['wl_node'] = new Node('1', '0a1b2c3d-0000-4000-8000-000000000001', 'article', 'Northwind news');
  $page = ['#type' => 'page', 'content' => ['#theme_wrappers' => ['region'], '#region' => 'content', 'main' => ['#lazy_builder' => ['wl_lazy_block', ['main']]], 'nav' => ['#lazy_builder' => ['wl_lazy_block', ['nav']]]]];
  $r = new Recorder('/node/1');
  if (method_exists($r, 'sense')) {
    $r->sense();
  }
  Recorder::$on = $r;
  $html = StandIn::render($page);
  Recorder::$on = NULL;
  [$trace, , $final] = (new TraceBuilder($r))->build('<html><body>' . $html . '</body></html>');
  echo json_encode(['trace' => $trace, 'classes' => StandIn::$classes, 'log' => StandIn::$log, 'html' => $final]);
}
`;

const PIPELINES = ['10.6.18', '11.0.13', '11.1.10', '11.2.14', '11.4.9'];

const traced = new Map<string, { trace: LiveTrace; raw: { trace: unknown; classes: Record<string, string>; log: string[]; html: string } }>();
/** The page traced on a release (each once). */
function page(version: string): { trace: LiveTrace; raw: { trace: unknown; classes: Record<string, string>; log: string[]; html: string } } {
  const done = traced.get(version);
  if (done) return done;
  const folder = mkdtempSync(join(tmpdir(), 'wanigan-drupal-versions-'));
  try {
    const helper = writeHelper(folder);
    writeFileSync(join(folder, 'core.php'), standInCore(version));
    writeFileSync(join(folder, 'composer.json'), '{}');
    const raw = runPhp(folder, PAGE, { WL_FOLDER: folder, WL_HELPER: helper }) as { trace: unknown; classes: Record<string, string>; log: string[]; html: string };
    const trace = parseTrace(raw.trace);
    assert.ok(trace, `the helper's answer on ${version} is a trace by the contract`);
    const out = { trace, raw };
    traced.set(version, out);
    return out;
  } finally { rmSync(folder, { recursive: true, force: true }); }
}

/** A part, by label (the nth of that label). */
function part(trace: LiveTrace, label: string, n = 0): TracePart {
  const found = trace.parts.filter((p) => p.label === label)[n];
  assert.ok(found, `a part labelled ${label} in ${trace.parts.map((p) => p.label).join(', ')}`);
  return found;
}

/** What a part is, as the live view shows it, without what differs from one render to the next. */
function outline(trace: LiveTrace): unknown[] {
  const label = new Map(trace.parts.map((p) => [p.id, p.label]));
  return trace.parts.map((p) => ({ label: p.label, kind: p.kind, parent: p.parent ? label.get(p.parent) : null, file: p.source?.file ?? null, identity: p.identity ?? null }));
}

const PARTS = [
  { label: 'Page', kind: 'template', parent: null },
  { label: 'content', kind: 'region', parent: 'Page' },
  { label: 'Main content', kind: 'block', parent: 'content' },
  { label: 'article: Northwind news', kind: 'entity', parent: 'Main content' },
  { label: 'Body', kind: 'field', parent: 'article: Northwind news' },
  { label: 'Body #1', kind: 'field', parent: 'Body' },
  { label: 'Body #2', kind: 'field', parent: 'Body' },
  { label: 'Main navigation', kind: 'block', parent: 'content' },
  { label: 'Main navigation', kind: 'menu', parent: 'Main navigation' },
  { label: 'Home', kind: 'menu', parent: 'Main navigation' },
  { label: 'About', kind: 'menu', parent: 'Main navigation' },
];

for (const version of PIPELINES) {
  test(`a page rendered on ${version} is traced: every part found, named and nested as the page shows it`, (t) => {
    if (!php) { t.skip('PHP is not installed here'); return; }
    const { trace, raw } = page(version);
    assert.deepEqual(raw.log, [], 'nothing went wrong while it was built');
    assert.deepEqual(outline(trace).map((p) => { const { label, kind, parent } = p as { label: string; kind: string; parent: string | null }; return { label, kind, parent }; }), PARTS);
    for (const [id, cls] of Object.entries(FAMILY[version] ?? {})) if (cls) assert.equal(raw.classes[id], cls, `${id} on ${version}`);
    assert.deepEqual(part(trace, 'article: Northwind news').identity, { kind: 'entity', type: 'node', id: '0a1b2c3d-0000-4000-8000-000000000001', bundle: 'article', langcode: 'en' });
    assert.deepEqual(part(trace, 'Body #2').identity, { kind: 'entity', type: 'node', id: '0a1b2c3d-0000-4000-8000-000000000001', bundle: 'article', langcode: 'en', field: 'body', item: 'delta:1' });
    assert.deepEqual(part(trace, 'Main content').identity, { kind: 'config', type: 'block', id: 'acme_content', plugin: 'system_main_block' });
    assert.equal(part(trace, 'Main content').source?.file, 'web/core/modules/block/templates/block.html.twig', 'the template the page used, from the project\'s root');
    // What shaped the node, in core's order: the suggestions hook, the alters (module, then theme), then the
    // module's and the theme's preprocess, each by who implements it.
    const node = part(trace, 'article: Northwind news');
    const site = (node.chain ?? []).filter((s) => s.by === 'acme' || s.by === 'acme_theme').map((s) => `${s.hook} by ${s.by}: ${s.callback ?? ''}`);
    assert.deepEqual(site, [
      'theme_suggestions_node by acme: acme_theme_suggestions_node',
      'theme_suggestions_alter by acme: acme_theme_suggestions_alter',
      'theme_suggestions_node_alter by acme_theme: acme_theme_theme_suggestions_node_alter',
      'preprocess_node by acme: acme_preprocess_node',
      'preprocess_node by acme_theme: acme_theme_preprocess_node',
    ]);
    assert.deepEqual((node.variables ?? []).filter((v) => ['acme_flag', 'theme_flag'].includes(v.name)).map((v) => [v.name, v.setBy]), [['acme_flag', 'acme_preprocess_node'], ['theme_flag', 'acme_theme_preprocess_node']], 'each variable says which step set it');
    assert.ok(node.cost && node.cost.ms >= 0, 'its cost');
    assert.ok((part(trace, 'Main content').alternatives ?? []).some((a) => a.name === 'block--acme'), 'the suggestion the module added is offered');
    // Request-wide, every hook implementation that ran, timed.
    assert.ok((trace.hooks ?? []).some((h) => h.hook === 'theme_suggestions_alter' && h.by === 'acme' && h.callback === 'acme_theme_suggestions_alter' && typeof h.ms === 'number'));
    assert.deepEqual(trace.logs ?? [], [], 'every piece of the trace is in place, so it notes nothing missing');
    // The page itself is unchanged but for the marks.
    assert.equal(raw.html.replace(/<!-- \/?wl:part id="p\d+" -->/g, ''), '<html><body><main><div class="region"><div class="block"><h2>Main content</h2><article><div class="field"><div>Hello</div><div>World</div></div></article></div><div class="block"><h2>Main navigation</h2><ul><li><a href="#">Home</a></li><li><a href="#">About</a></li></ul></div></div></main></body></html>');
  });
}

test('every release traces the page alike: the same parts, names, files and identities', (t) => {
  if (!php) { t.skip('PHP is not installed here'); return; }
  const newest = outline(page('11.4.9').trace);
  for (const version of PIPELINES) assert.deepEqual(outline(page(version).trace), newest, version);
});

test('on a core none of the trace\'s classes fits, the page\'s parts are still found and named, through hooks, and the trace says what that loses', (t) => {
  if (!php) { t.skip('PHP is not installed here'); return; }
  const { trace, raw } = page(FUTURE);
  for (const id of ['module_handler', 'theme.manager', 'theme.registry', 'renderer', ENGINE]) assert.match(raw.classes[id] ?? '', /^Drupal\\Core\\/, `${id} keeps core's class`);
  assert.deepEqual(raw.log, []);
  assert.ok(trace.parts.length > 0, 'never no parts');
  const outlined = outline(trace).map((p) => { const { label, kind, parent } = p as { label: string; kind: string; parent: string | null }; return { label, kind, parent }; });
  assert.deepEqual(outlined, PARTS, 'the same parts as every release with the trace\'s classes in place');
  const newest = outline(page('11.4.9').trace);
  assert.deepEqual(outline(trace), newest, 'named, nested and identified alike');
  // What hooks cannot give, said in the trace's log for the live view to show.
  const notes = (trace.logs ?? []).filter((l) => l.level === 'notice').map((l) => l.message);
  assert.ok(notes.some((n) => /not timed/.test(n)), notes.join('\n'));
  assert.ok(notes.some((n) => /through hooks/.test(n)), notes.join('\n'));
  assert.equal(raw.html.replace(/<!-- \/?wl:part id="p\d+" -->/g, ''), page('11.4.9').raw.html.replace(/<!-- \/?wl:part id="p\d+" -->/g, ''), 'the page is the same');
});
