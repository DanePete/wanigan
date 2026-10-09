// The WordPress helper's source: what Wanigan writes into a site. When PHP is
// on this Mac the file is linted, and loaded under a stand-in WordPress that
// records which hooks it adds, to prove a request without the token gets
// nothing but the change counter. Nothing here touches a real site.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { WORDPRESS_HELPER_MARK, WORDPRESS_HELPER_VERSION, wordpressHelper } from './live-helper-wordpress.ts';

// A made-up token, built here so no key-shaped string sits in the source.
const TOKEN = 'ab'.repeat(24);

const php = ((): string | null => {
  try {
    execFileSync('php', ['-v'], { stdio: 'ignore' });
    return 'php';
  } catch {
    return null;
  }
})();

test('the plugin carries its token, version, mark and where WordPress sits in the project', () => {
  const src = wordpressHelper(TOKEN, 'web');
  assert.ok(src.startsWith('<?php\n'));
  assert.ok(src.includes(WORDPRESS_HELPER_MARK));
  assert.ok(src.includes(`// wanigan-helper-version: ${WORDPRESS_HELPER_VERSION}`));
  assert.ok(src.includes(` * Version: ${WORDPRESS_HELPER_VERSION}\n`));
  assert.ok(src.includes(`const WANIGAN_LIVE_TOKEN = '${TOKEN}';`));
  assert.ok(src.includes("const WANIGAN_LIVE_SITE_DIR = 'web';"));
  assert.equal(WORDPRESS_HELPER_VERSION, 2, 'a helper installed by an older Wanigan reads as outdated');
  assert.ok(!/__WANIGAN_[A-Z_]+__/.test(src), 'every placeholder is filled');
  assert.ok(wordpressHelper(TOKEN, '/web/').includes("WANIGAN_LIVE_SITE_DIR = 'web';"), 'slashes around the folder are dropped');
  assert.ok(wordpressHelper(TOKEN).includes("WANIGAN_LIVE_SITE_DIR = '';"));
});

test('only a hex token and a plain relative folder are written into PHP', () => {
  assert.throws(() => wordpressHelper("abc'; system('x'); //"), /hex/);
  assert.throws(() => wordpressHelper('ABCDEF0123456789'), /hex/);
  for (const bad of ['../outside', 'web/../..', "web'; //", 'a b', 'web/./x']) assert.throws(() => wordpressHelper(TOKEN, bad), /plain relative path/, bad);
});

test('it hooks core, and names no plugin or theme', () => {
  const src = wordpressHelper(TOKEN);
  // The seams the trace and the edits are built on, each from WordPress core.
  for (const hook of ["add_action('all'", "'log_query_custom_data'", "'wp_before_load_template'", "'wp_before_include_template'", "'pre_render_block'", "'interactivity_process_directives'", "'wp_template_enhancement_output_buffer'", "'render_block_core_template_part_file'", "'block_bindings_source_value'", "'dynamic_sidebar_params'", "'walker_nav_menu_start_el'", 'rest_do_request(', 'WP_REST_Post_Meta_Fields', 'serialize_blocks(', 'wp_set_sidebars_widgets(', "'wp-admin/menu.php'"]) {
    assert.ok(src.includes(hook), hook);
  }
  // A few names a helper could be tempted to special-case; none appear.
  for (const name of ['elementor', 'acf', 'woocommerce', 'yoast', 'gravity', 'divi', 'astra', 'twentytwenty']) {
    assert.ok(!new RegExp(`\\b${name}`, 'i').test(src), name);
  }
});

test('it stays within PHP 7.4, WordPress 7.1’s minimum, where a must-use plugin cannot afford a parse error', () => {
  const src = wordpressHelper(TOKEN);
  assert.ok(!/\?->/.test(src), 'no nullsafe operator');
  assert.ok(!/\bmatch\s*\(/.test(src), 'no match expression');
  assert.ok(!/\bcatch\s*\(\s*[A-Za-z_\\]+\s*\)/.test(src), 'every catch names its variable');
  assert.ok(!/:\s*(mixed|static|never)\b/.test(src), 'no PHP 8 return types');
  assert.ok(!/function\s*\([^)]*\b(int|string|array|bool)\s*\|/.test(src), 'no union types');
  assert.ok(!src.includes('#['), 'no attributes');
});

describe('loaded under a stand-in WordPress', { skip: php ? false : 'PHP is not installed here' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'wg-wp-helper-'));
  const plugin = join(dir, 'wanigan-live.php');
  const harness = join(dir, 'harness.php');
  writeFileSync(plugin, wordpressHelper(TOKEN));
  writeFileSync(harness, `<?php
define('ABSPATH', __DIR__ . '/');
$GLOBALS['wl_hooks'] = array();
function add_action($h, $cb, $p = 10, $n = 1) { $GLOBALS['wl_hooks'][] = $h; return true; }
function add_filter($h, $cb, $p = 10, $n = 1) { $GLOBALS['wl_hooks'][] = $h; return true; }
function wp_parse_url($u, $c = -1) { return parse_url($u, $c); }
function wp_normalize_path($p) { return str_replace('\\\\', '/', $p); }
function is_admin() { return false; }
$_SERVER['REQUEST_URI'] = getenv('WL_URI');
parse_str((string) parse_url($_SERVER['REQUEST_URI'], PHP_URL_QUERY), $_GET);
$_SERVER['SCRIPT_FILENAME'] = '/var/www/html/' . (getenv('WL_SCRIPT') ?: 'index.php');
if (getenv('WL_TOKEN')) $_SERVER['HTTP_X_WANIGAN_LIVE'] = getenv('WL_TOKEN');
ob_start();
require getenv('WL_PLUGIN');
$out = ob_get_clean();
echo json_encode(array('hooks' => array_values(array_unique($GLOBALS['wl_hooks'])), 'output' => $out, 'savequeries' => defined('SAVEQUERIES'), 'admin' => defined('WP_ADMIN'), 'handler' => set_error_handler(null) !== null));
`);
  after(() => rmSync(dir, { recursive: true, force: true }));

  const load = (uri: string, token?: string, script?: string): { hooks: string[]; output: string; savequeries: boolean; admin: boolean; handler: boolean } => JSON.parse(execFileSync(php as string, [harness], {
    env: { PATH: process.env.PATH ?? '', WL_URI: uri, WL_PLUGIN: plugin, ...(token ? { WL_TOKEN: token } : {}), ...(script ? { WL_SCRIPT: script } : {}) },
    encoding: 'utf8',
  }));
  const COUNTER = ['save_post', 'deleted_post', 'trashed_post', 'untrashed_post', 'edited_term', 'created_term', 'delete_term', 'wp_update_nav_menu', 'customize_save_after', 'switch_theme', 'update_option_sidebars_widgets', 'added_post_meta', 'updated_post_meta', 'deleted_post_meta', 'updated_option'];

  test('a move or insert puts the item at its place in the target after the move, appends at the length, and refuses past it', () => {
    const place = join(dir, 'place.php');
    writeFileSync(place, `<?php
define('ABSPATH', __DIR__ . '/');
function add_action() { return true; }
function add_filter() { return true; }
require getenv('WL_PLUGIN');
$cases = json_decode(getenv('WL_CASES'), true);
echo json_encode(array_map(function ($c) { return Wanigan_Live::place($c[0], $c[1], $c[2]); }, $cases));
`);
    // [items of the target, the moving item (null for an insert), index] → the item it goes before, null for the end, false for refused.
    const cases: [string[], string | null, number, string | null | false][] = [
      [['A', 'B', 'C'], 'B', 2, null], // [A,C,B]
      [['A', 'B', 'C'], 'B', 0, 'A'], // [B,A,C]
      [['A', 'B', 'C'], 'B', 1, 'C'], // [A,B,C]: where it was
      [['A', 'B', 'C'], 'B', 3, false], // past the end once B is out of the list
      [['X', 'Y'], 'B', 1, 'Y'], // into another collection: [X,B,Y]
      [['X', 'Y'], 'B', 2, null], // appended: [X,Y,B]
      [['X', 'Y'], 'B', 3, false],
      [['X', 'Y'], 'B', -1, false],
      [[], 'B', 0, null], // into an empty collection
      [['A', 'B'], null, 2, null], // an insert at the length appends
      [['A', 'B'], null, 0, 'A'],
      [['A', 'B'], null, 3, false],
    ];
    const got = JSON.parse(execFileSync(php as string, [place], {
      env: { PATH: process.env.PATH ?? '', WL_PLUGIN: plugin, WL_CASES: JSON.stringify(cases.map(([items, moving, index]) => [items, moving, index])) },
      encoding: 'utf8',
    })) as (string | null | false)[];
    assert.deepEqual(got, cases.map((c) => c[3]));
  });

  test('PHP finds no syntax error in it', () => {
    assert.match(execFileSync(php as string, ['-l', plugin], { encoding: 'utf8' }), /No syntax errors/);
  });

  test('without the token, or with another, it adds only the change counter and prints nothing', () => {
    for (const token of [undefined, 'f'.repeat(48)]) {
      const r = load('/about/', token);
      assert.deepEqual(r.hooks.sort(), [...COUNTER].sort());
      assert.equal(r.output, '');
      assert.equal(r.savequeries, false, 'queries are not saved for anyone else');
      assert.equal(r.handler, false, 'no error handler for anyone else');
    }
  });

  test('with the token, a page is traced: the all hook, saved queries and the error handler, still printing nothing at load', () => {
    const r = load('/about/', TOKEN);
    for (const h of ['all', 'wp', 'log_query_custom_data', 'wp_before_load_template', 'pre_render_block', 'the_content']) assert.ok(r.hooks.includes(h), h);
    assert.equal(r.savequeries, true);
    assert.equal(r.handler, true);
    assert.equal(r.output, '');
  });

  test('with the token, its JSON routes and the REST API are not traced, and only the Go to index runs as an admin request', () => {
    for (const uri of ['/_wanigan/trace/0123456789abcdef', '/_wanigan/edit/post-1-title', '/_wanigan/move', '/_wanigan/find?q=x']) {
      const r = load(uri, TOKEN);
      assert.ok(!r.hooks.includes('all'), uri);
      assert.ok(r.hooks.includes('wp_loaded'), uri);
      assert.equal(r.savequeries, false, uri);
      assert.equal(r.admin, uri.startsWith('/_wanigan/find'), uri);
    }
    for (const [uri, script] of [['/wp-json/wp/v2/posts', 'index.php'], ['/?rest_route=/wp/v2/posts', 'index.php'], ['/wp-admin/admin-ajax.php', 'admin-ajax.php'], ['/wp-cron.php', 'wp-cron.php']] as const) {
      const r = load(uri, TOKEN, script);
      assert.ok(!r.hooks.includes('all'), uri);
      assert.equal(r.savequeries, false, uri);
    }
  });
});
