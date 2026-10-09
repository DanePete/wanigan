// The Drupal helper as written into a site: its PHP parses, every class a
// service, route or swap names is one it writes, each core interception point
// extends the core class it says it does, and an update leaves no file of an
// older helper behind. Nothing here runs Drupal or ddev; `php -l` runs when
// PHP is installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

test('this Wanigan writes helper version 2, and its info file says so under the mark', () => {
  assert.equal(DRUPAL_HELPER_VERSION, 2);
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
  for (const route of ['wanigan_live.trace', 'wanigan_live.edit', 'wanigan_live.edit_done', 'wanigan_live.move', 'wanigan_live.insert', 'wanigan_live.undo', 'wanigan_live.find']) {
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
