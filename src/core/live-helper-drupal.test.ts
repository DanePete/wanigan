// The Drupal helper as written into a site: its PHP parses, every class a
// service, route or swap names is one it writes, each core interception point
// extends the core class it says it does, and an update leaves no file of an
// older helper behind. Nothing here runs Drupal or ddev; `php -l` runs when
// PHP is installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DRUPAL_HELPER_FILES, DRUPAL_HELPER_MARK, DRUPAL_HELPER_MODULE, DRUPAL_HELPER_VERSION } from './live-helper-drupal.ts';
import { writeDrupalHelper } from './live.ts';
import { which } from './environment.ts';

const files = DRUPAL_HELPER_FILES;
const php = Object.entries(files).filter(([f]) => f.endsWith('.php'));

/** The class a PHP file declares, fully qualified. */
function declared(text: string): string | null {
  const ns = /^namespace ([\w\\]+);/m.exec(text)?.[1];
  const name = /^(?:final |abstract )?(?:class|interface|trait) (\w+)/m.exec(text)?.[1];
  return ns && name ? `${ns}\\${name}` : null;
}

const classes = new Map(php.map(([f, t]) => [declared(t), { file: f, text: t }]));

test('this Wanigan writes helper version 3, and its info file says so under the mark', () => {
  assert.equal(DRUPAL_HELPER_VERSION, 3);
  const info = files[`${DRUPAL_HELPER_MODULE}.info.yml`] ?? '';
  assert.ok(info.startsWith(DRUPAL_HELPER_MARK));
  assert.match(info, new RegExp(`# wanigan-helper-version: ${DRUPAL_HELPER_VERSION}\\n`));
});

test('every PHP file declares the one class its path names (PSR-4 under src/)', () => {
  for (const [file, text] of php) {
    assert.ok(text.startsWith('<?php\n'), file);
    const cls = declared(text);
    assert.ok(cls, `${file} declares a class`);
    assert.equal(cls, `Drupal\\${DRUPAL_HELPER_MODULE}\\${file.replace(/^src\//, '').replace(/\.php$/, '').split('/').join('\\')}`, file);
    assert.doesNotMatch(text, /\$\{/, `${file} has no template interpolation left in it`);
  }
});

test('every class the services, routes and the service provider name is one the helper writes', () => {
  const services = files[`${DRUPAL_HELPER_MODULE}.services.yml`] ?? '';
  for (const [, cls] of services.matchAll(/class: ([\w\\]+)/g)) assert.ok(classes.has(cls!), `service class ${cls}`);
  const routing = files[`${DRUPAL_HELPER_MODULE}.routing.yml`] ?? '';
  for (const [, cls, method] of routing.matchAll(/'\\?(Drupal\\[\w\\]+)::(\w+)'/g)) {
    const found = classes.get(cls!);
    assert.ok(found, `route class ${cls}`);
    assert.match(found.text, new RegExp(`function ${method}\\(`), `${cls}::${method}`);
  }
  for (const route of ['wanigan_live.trace', 'wanigan_live.edit', 'wanigan_live.edit_done', 'wanigan_live.move', 'wanigan_live.insert', 'wanigan_live.undo', 'wanigan_live.find', 'wanigan_live.ai']) {
    assert.match(routing, new RegExp(`^${route.replace('.', '\\.')}:\\n`, 'm'), route);
  }
  // Every route answers only the live view's token.
  const routes = routing.split(/\n(?=\S)/);
  for (const r of routes) assert.match(r, /_custom_access: '\\Drupal\\wanigan_live\\Controller\\LiveController::access'/, r.split('\n')[0]);
});

test('each swap puts in a class that extends the core class it replaces, only under the provider\'s check', () => {
  const provider = classes.get('Drupal\\wanigan_live\\WaniganLiveServiceProvider')?.text ?? '';
  assert.match(provider, /implements ServiceModifierInterface/);
  const swaps = [...provider.matchAll(/'([\w.\\]+)' => \[\n\s+'(Drupal\\Core\\[\w\\]+)',\n\s+'(Drupal\\wanigan_live\\[\w\\]+)',/g)];
  assert.deepEqual(swaps.map((m) => m[1]).sort(), ['Drupal\\Core\\Template\\TwigThemeEngine', 'module_handler', 'renderer', 'theme.manager', 'theme.registry']);
  for (const [, , core, ours] of swaps) {
    const text = classes.get(ours!)?.text ?? '';
    const short = core!.split('\\').pop();
    assert.match(text, new RegExp(`^use ${core!.replace(/\\/g, '\\\\')};`, 'm'), `${ours} uses ${core}`);
    assert.match(text, new RegExp(`class \\w+ extends ${short} `), `${ours} extends ${short}`);
  }
  assert.match(provider, /self::fits\(\$signatures\)/, 'a class is swapped only when core\'s signatures fit');
});

test('nothing in the helper acts unless a trace is on, or the token is carried', () => {
  for (const [file, text] of php) {
    if (!/^(?:final )?class \w+ extends (ModuleHandler|ThemeManager|Registry|TwigThemeEngine|Renderer) /m.test(text)) continue;
    // Every overriding method of a swapped service asks the recorder first.
    // (Its own additions, which only read core, are not overrides.)
    for (const [, name, body] of text.matchAll(/\n {2}(?:public|protected) function (\w+)\([^)]*\)[^{]*\{\n([\s\S]*?)\n {2}\}/g)) {
      if (['coreRuntime', 'listenerFor'].includes(name!)) continue;
      if (/parent::/.test(body!)) assert.match(body!, /Recorder::\$on/, `${file}: ${name}() calls core only after asking Recorder::$on`);
    }
  }
  const subscriber = classes.get('Drupal\\wanigan_live\\Trace\\TraceSubscriber')?.text ?? '';
  assert.match(subscriber, /\$this->token->carried\(\$request\)/, 'a trace starts only for a request carrying the token');
  assert.match(subscriber, /isMethod\('GET'\)/);
  // Another Wanigan's key gets one header saying so, and nothing else (no trace, no recording).
  assert.match(subscriber, /if \(\$this->token->other\(\$event->getRequest\(\)\)\) \{\n\s+\$event->getResponse\(\)->headers->set\('X-Wanigan-Helper', 'other'\);/);
  const token = classes.get('Drupal\\wanigan_live\\Token')?.text ?? Object.values(files).join('\n');
  assert.match(token, /public function other\([^)]*\): bool \{[\s\S]*?!hash_equals\(\$token, \$given\)/, 'another key is told apart in constant time');
});

test('the helper names no contributed or custom module: everything goes through core', () => {
  const all = Object.values(files).join('\n');
  for (const [, ns] of all.matchAll(/\buse (Drupal\\(\w+)\\[\w\\]+);/g)) {
    const owner = ns!.split('\\')[1];
    assert.ok(['Core', 'Component', 'wanigan_live', 'views', 'layout_builder', 'block', 'user'].includes(owner!), `uses ${ns}`);
  }
  assert.doesNotMatch(all, /moduleExists\('(?!block|layout_builder|views)\w+'\)/);
});

test('an update writes every file and leaves none an older helper wrote', () => {
  const folder = mkdtempSync(join(tmpdir(), 'wanigan-drupal-helper-'));
  try {
    mkdirSync(join(folder, 'src', 'Retired'), { recursive: true });
    writeFileSync(join(folder, 'src', 'Retired', 'Gone.php'), '<?php // an older helper');
    writeFileSync(join(folder, 'old.txt'), 'stale');
    writeDrupalHelper(folder);
    for (const file of Object.keys(files)) assert.equal(readFileSync(join(folder, file), 'utf8'), files[file], file);
    assert.equal(existsSync(join(folder, 'old.txt')), false);
    assert.equal(existsSync(join(folder, 'src', 'Retired')), false, 'an emptied folder goes too');
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('every PHP file passes php -l', (t) => {
  const bin = which('php', process.env.PATH ?? '');
  if (!bin) { t.skip('PHP is not installed here'); return; }
  const folder = mkdtempSync(join(tmpdir(), 'wanigan-drupal-lint-'));
  try {
    for (const [file, text] of Object.entries(files)) {
      if (!file.endsWith('.php') && !file.endsWith('.module')) continue;
      const path = join(folder, file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
      assert.match(execFileSync(bin, ['-l', path], { encoding: 'utf8' }), /No syntax errors/, file);
    }
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('a move\'s index is the item\'s place in the target once moved, from 0 to its other items, and nothing past', (t) => {
  const bin = which('php', process.env.PATH ?? '');
  if (!bin) { t.skip('PHP is not installed here'); return; }
  const folder = mkdtempSync(join(tmpdir(), 'wanigan-drupal-moves-'));
  try {
    writeFileSync(join(folder, 'Moves.php'), files['src/Edit/Moves.php'] ?? '');
    const script = [
      '<?php',
      `require ${JSON.stringify(join(folder, 'Moves.php'))};`,
      'use Drupal\\wanigan_live\\Edit\\Moves;',
      'echo json_encode([',
      "  Moves::place(['A', 'B', 'C'], ['A', 'B', 'C'], 'B', 2),",
      "  Moves::place(['A', 'B', 'C'], ['A', 'B', 'C'], 'B', 0),",
      "  Moves::place(['X', 'Y'], ['X', 'Y'], 'B', 1),",
      "  Moves::place(['X', 'Y'], ['X', 'Y'], 'B', 2),",
      "  Moves::place(['A', 'H', 'B', 'C'], ['A', 'B', 'C'], 'C', 1),",
      "  Moves::place([], [], 'B', 0),",
      "  [Moves::placeExists(['A', 'B', 'C'], 'B', 2), Moves::placeExists(['A', 'B', 'C'], 'B', 3), Moves::placeExists(['X', 'Y'], 'B', 2), Moves::placeExists(['X', 'Y'], 'B', 3), Moves::placeExists(['X', 'Y'], NULL, 2), Moves::placeExists(['X', 'Y'], NULL, 3), Moves::placeExists([], 'B', -1)],",
      ']);',
    ].join('\n');
    writeFileSync(join(folder, 'check.php'), script);
    const [b2, b0, into1, append, hidden, empty, fits] = JSON.parse(execFileSync(bin, [join(folder, 'check.php')], { encoding: 'utf8' })) as unknown[];
    assert.deepEqual(b2, ['A', 'C', 'B'], 'B to 2 in [A, B, C]');
    assert.deepEqual(b0, ['B', 'A', 'C'], 'B to 0 in [A, B, C]');
    assert.deepEqual(into1, ['X', 'B', 'Y'], 'B into [X, Y] at 1');
    assert.deepEqual(append, ['X', 'Y', 'B'], 'an index equal to the target\'s length appends');
    assert.deepEqual(hidden, ['A', 'H', 'C', 'B'], 'an item the page does not show keeps its place');
    assert.deepEqual(empty, ['B'], 'into an empty collection');
    assert.deepEqual(fits, [true, false, true, false, true, false, false], 'from 0 to the target\'s other items, nothing past');
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('what a save runs is read from core’s module handler and extension list, named by module, core counted and the helper left out', (t) => {
  const bin = which('php', process.env.PATH ?? '');
  if (!bin) { t.skip('PHP is not installed here'); return; }
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'wanigan-drupal-saves-')));
  try {
    // A made-up project: composer.json at its root, Drupal in web/, a contributed, a custom and a core module.
    const module = (path: string, code: string): void => { mkdirSync(join(folder, dirname(path)), { recursive: true }); writeFileSync(join(folder, path), `<?php\n${code}\n`); };
    writeFileSync(join(folder, 'composer.json'), '{}');
    module('web/modules/contrib/acme_ai/acme_ai.module', 'function acme_ai_entity_presave($e) {}\nfunction acme_ai_node_presave($e) {}');
    module('web/modules/custom/northwind_seo/northwind_seo.module', 'function northwind_seo_node_update($e) {}');
    module('web/modules/custom/northwind_seo/src/Listener.php', 'class NorthwindListener { public function onSave() {} }');
    module('web/core/modules/node/node.module', 'function node_node_presave($e) {}');
    module('web/core/lib/CoreListener.php', 'class CoreListener { public function onSave() {} }');
    module('web/modules/custom/wanigan_live/wanigan_live.module', 'function wanigan_live_entity_presave($e) {}');
    for (const f of ['src/Trace/Source.php', 'src/Trace/SaveCode.php', 'src/Edit/Targets.php']) module(`helper/${f}`, (files[f] ?? '').replace(/^<\?php\n/, ''));
    writeFileSync(join(folder, 'check.php'), `<?php
namespace Drupal\\Core\\Config\\Entity { interface ConfigEntityTypeInterface {} }
namespace Drupal\\Core\\Entity { interface ContentEntityTypeInterface {} }
namespace {
  $root = ${JSON.stringify(folder)};
  foreach (['web/modules/contrib/acme_ai/acme_ai.module', 'web/modules/custom/northwind_seo/northwind_seo.module', 'web/modules/custom/northwind_seo/src/Listener.php', 'web/core/modules/node/node.module', 'web/core/lib/CoreListener.php', 'web/modules/custom/wanigan_live/wanigan_live.module', 'helper/src/Trace/Source.php', 'helper/src/Trace/SaveCode.php', 'helper/src/Edit/Targets.php'] as $f) require $root . '/' . $f;
  class Ext { public function __construct(private string $path, private string $type = 'module') {} public function getPath() { return $this->path; } public function getType() { return $this->type; } }
  $modules = ['acme_ai' => ['modules/contrib/acme_ai', 'Acme AI'], 'northwind_seo' => ['modules/custom/northwind_seo', 'Northwind SEO'], 'node' => ['core/modules/node', 'Node'], 'wanigan_live' => ['modules/custom/wanigan_live', 'Wanigan live view']];
  class ModuleList { public function __construct(private array $m) {} public function exists($n) { return isset($this->m[$n]); } public function get($n) { return new Ext($this->m[$n][0]); } public function getName($n) { return $this->m[$n][1]; } public function getPath($n) { return $this->m[$n][0]; } }
  class Handler {
    public function __construct(private array $m) {}
    public function getModuleList() { return array_map(fn ($x) => new Ext($x[0]), $this->m); }
    public function invokeAllWith($hook, callable $cb) { foreach (['acme_ai', 'northwind_seo', 'node', 'wanigan_live'] as $module) { if (function_exists($module . '_' . $hook)) $cb($module . '_' . $hook, $module); } }
  }
  class Content implements Drupal\\Core\\Entity\\ContentEntityTypeInterface { public function __construct(private string $l) {} public function getSingularLabel() { return $this->l; } }
  class Configured implements Drupal\\Core\\Config\\Entity\\ConfigEntityTypeInterface { public function getSingularLabel() { return 'block'; } }
  class Types { public function hasDefinition($t) { return isset($this->getDefinitions()[$t]); } public function getDefinition($t) { return $this->getDefinitions()[$t]; } public function getDefinitions() { return ['node' => new Content('content item'), 'paragraph' => new Content('paragraph'), 'block' => new Configured()]; } }
  class Dispatcher { public function getListeners($e) { return $e === 'config.save' ? [[new NorthwindListener(), 'onSave'], [new CoreListener(), 'onSave']] : []; } }
  class Drupal {
    public static array $m;
    public static function root() { return ${JSON.stringify(join(folder, 'web'))}; }
    public static function entityTypeManager() { return new Types(); }
    public static function moduleHandler() { return new Handler(self::$m); }
    public static function service($id) { return match ($id) { 'extension.list.module' => new ModuleList(self::$m), 'event_dispatcher' => new Dispatcher(), 'theme_handler' => new class { public function listInfo() { return []; } } }; }
  }
  Drupal::$m = $modules;
  class_alias('Drupal\\wanigan_live\\Trace\\SaveCode', 'SaveCode');
  echo json_encode([
    'node' => SaveCode::forEntityType('node'),
    'block' => SaveCode::forEntityType('block'),
    'missing' => SaveCode::forEntityType('nope'),
    'articles' => array_map([SaveCode::class, 'article'], ['user', 'URL alias', 'order', 'item', 'image style', 'unpublished thing']),
    'site' => array_column(SaveCode::site(), 'id'),
    'targets' => [SaveCode::forTarget('field.node.title.en.12', ['kind' => 'field', 'type' => 'node']), SaveCode::forTarget('config.block.acme_search', ['kind' => 'config']), SaveCode::forTarget('link.menu_link_content:abc', ['kind' => 'link']), SaveCode::forTarget('link.system.admin', ['kind' => 'link']), SaveCode::forTarget('tpl.0123', ['kind' => 'template-override'])],
    'collections' => [SaveCode::forCollection(['kind' => 'field-items', 'type' => 'paragraph'], 'content'), SaveCode::forCollection(['kind' => 'region-blocks'], 'configuration'), SaveCode::forCollection(['kind' => 'menu'], 'configuration'), SaveCode::forCollection(['kind' => 'layout', 'storage' => 'overrides', 'type' => 'node'], 'content'), SaveCode::forCollection(['kind' => 'layout', 'storage' => 'defaults', 'type' => 'node'], 'configuration')],
  ]);
}
`);
    const out = JSON.parse(execFileSync(bin, [join(folder, 'check.php')], { encoding: 'utf8' })) as Record<string, unknown>;
    assert.deepEqual(out.node, {
      id: 'entity:node', label: 'Saving a content item (node)', core: 1,
      runs: [
        { by: 'acme_ai', kind: 'module', owner: 'contrib', hooks: ['node_presave', 'entity_presave'], callbacks: ['acme_ai_node_presave', 'acme_ai_entity_presave'], name: 'Acme AI' },
        { by: 'northwind_seo', kind: 'module', owner: 'yours', hooks: ['node_update'], callbacks: ['northwind_seo_node_update'], name: 'Northwind SEO' },
      ],
    });
    const block = out.block as { runs: { by: string; hooks: string[] }[]; core: number };
    assert.deepEqual(block.runs.map((r) => [r.by, r.hooks]), [['acme_ai', ['entity_presave']], ['northwind_seo', ['config.save']]], 'configuration adds the config save listeners, by the module their class is in');
    assert.equal(block.core, 1, 'core’s own listener is counted, not listed');
    assert.equal(out.missing, null);
    assert.deepEqual(out.articles, ['a', 'a', 'an', 'an', 'an', 'an'], 'a user, a URL alias, an order');
    assert.deepEqual(out.site, ['entity:node', 'entity:paragraph'], 'the site-wide list is content, those running the most first');
    assert.deepEqual(out.targets, ['node', 'block', 'menu_link_content', null, null]);
    assert.deepEqual(out.collections, ['paragraph', 'block', null, 'node', 'entity_view_display']);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
