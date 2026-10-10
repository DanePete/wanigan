// The WordPress helper's source: what Wanigan writes into a site. When PHP is
// on this Mac the file is linted, and loaded under a stand-in WordPress that
// records which hooks it adds, to prove a request without the token gets
// nothing but the change counter. Nothing here touches a real site.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { WORDPRESS_HELPER_MARK, WORDPRESS_HELPER_VERSION, wordpressHelper } from './live-helper-wordpress.ts';
import { WORDPRESS_ELEMENTOR_SOURCE } from './live-helper-wordpress-elementor.ts';
import { WORDPRESS_ACF_SOURCE } from './live-helper-wordpress-acf.ts';
import { WORDPRESS_COPIES_SOURCE } from './live-helper-wordpress-copies.ts';

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
  assert.equal(WORDPRESS_HELPER_VERSION, 4, 'a helper installed by an older Wanigan reads as outdated');
  assert.ok(!/__WANIGAN_[A-Z_]+__/.test(src), 'every placeholder is filled');
  assert.ok(wordpressHelper(TOKEN, '/web/').includes("WANIGAN_LIVE_SITE_DIR = 'web';"), 'slashes around the folder are dropped');
  assert.ok(wordpressHelper(TOKEN).includes("WANIGAN_LIVE_SITE_DIR = '';"));
});

test('only a hex token and a plain relative folder are written into PHP', () => {
  assert.throws(() => wordpressHelper("abc'; system('x'); //"), /hex/);
  assert.throws(() => wordpressHelper('ABCDEF0123456789'), /hex/);
  for (const bad of ['../outside', 'web/../..', "web'; //", 'a b', 'web/./x']) assert.throws(() => wordpressHelper(TOKEN, bad), /plain relative path/, bad);
});

test('it hooks core, and names no plugin or theme outside the stored-words adapters, each isolated in its own class', () => {
  // The adapters (Elementor, ACF, known copies) are the one place a plugin is named: each in its own file and class,
  // registered with the stored-words search, which never depends on them. Everything else is core only.
  const adapters = [WORDPRESS_ELEMENTOR_SOURCE, WORDPRESS_ACF_SOURCE, WORDPRESS_COPIES_SOURCE];
  const full = wordpressHelper(TOKEN);
  for (const a of adapters) assert.ok(full.includes(a));
  const src = adapters.reduce((s, a) => s.replace(a, ''), full);
  for (const [a, name, shape] of [
    [WORDPRESS_ELEMENTOR_SOURCE, 'Wanigan_Live_Adapter_Elementor', 'extends Wanigan_Live_Adapter implements Wanigan_Live_Words_Adapter'],
    [WORDPRESS_ACF_SOURCE, 'Wanigan_Live_Acf', 'implements Wanigan_Live_Words_Adapter'],
    [WORDPRESS_COPIES_SOURCE, 'Wanigan_Live_Copies', 'implements Wanigan_Live_Words_Adapter'],
  ] as const) {
    assert.match(a, new RegExp(`final class ${name} ${shape}`));
    assert.ok(!src.includes(name), `${name} is named only in its own file`);
  }
  // The seams the trace and the edits are built on, each from WordPress core.
  for (const hook of ["add_action('all'", "'log_query_custom_data'", "'wp_before_load_template'", "'wp_before_include_template'", "'pre_render_block'", "'interactivity_process_directives'", "'wp_template_enhancement_output_buffer'", "'render_block_core_template_part_file'", "'block_bindings_source_value'", "'dynamic_sidebar_params'", "'walker_nav_menu_start_el'", 'rest_do_request(', 'WP_REST_Post_Meta_Fields', 'serialize_blocks(', 'wp_set_sidebars_widgets(', "'wp-admin/menu.php'"]) {
    assert.ok(src.includes(hook), hook);
  }
  // A few names a helper could be tempted to special-case; none appear.
  for (const name of ['elementor', 'acf', 'woocommerce', 'yoast', 'gravity', 'divi', 'astra', 'twentytwenty', 'rank-math', 'jetpack', 'akismet', 'mwai', 'alttext', 'openai', 'anthropic']) {
    assert.ok(!new RegExp(`\\b${name}`, 'i').test(src), name);
  }
});

test('each adapter calls its plugin only inside its own source', () => {
  // Elementor's API is called only by its adapter, ACF's only by its: the known-copies list may name their data (it is
  // the exclusion list, kept whether or not an adapter exists), never call them.
  const others = (mine: string): string => [WORDPRESS_ELEMENTOR_SOURCE, WORDPRESS_ACF_SOURCE, WORDPRESS_COPIES_SOURCE].filter((a) => a !== mine).join('\n');
  assert.ok(/\\Elementor\\Plugin::\$instance/.test(WORDPRESS_ELEMENTOR_SOURCE) && !/\\?Elementor\\/.test(others(WORDPRESS_ELEMENTOR_SOURCE)), 'Elementor’s classes');
  assert.ok(/\bacf_update_value\(/.test(WORDPRESS_ACF_SOURCE) && !/\bacf_[a-z_]+\(/.test(others(WORDPRESS_ACF_SOURCE)), 'ACF’s functions');
  assert.ok(!/\bFLBuilder|SiteOrigin_Panels|\\Bricks\\|aioseo\(/.test(others(WORDPRESS_COPIES_SOURCE)), 'the copies’ plugins are named only by the copies');
});

test('the site’s AI is read through core alone, and no key is ever read', () => {
  const src = wordpressHelper(TOKEN);
  // Core's own seams, each feature-detected rather than trusted by version.
  for (const seam of ["function_exists('wp_get_connectors')", "function_exists('_wp_connectors_get_api_key_source')", "function_exists('wp_get_abilities')", "function_exists('wp_ai_client_prompt')", "function_exists('wp_supports_ai')",
    "'wp_ai_client_before_generate_result'", "'wp_ai_client_after_generate_result'", "'wp_ability_invoked'", "'wp_before_execute_ability'", "'wp_after_execute_ability'", "'wp_ai_client_prevent_prompt'", '$wp_filter[$hook]->callbacks']) {
    assert.ok(src.includes(seam), seam);
  }
  // A key's source is asked of core; its value never is, nor an application password.
  assert.ok(!src.includes('wp_connectors_get_application_password_credentials'), 'never the function that hands back a password');
  assert.ok(!/get_option\(\s*\$auth/.test(src) && !/getenv\(/.test(src) && !/constant\(\s*\$auth/.test(src), 'never a key’s value');
  assert.ok(!/isProviderConfigured|->generate_|wp_ai_client_prompt\(/.test(src), 'never a call that reaches a provider');
  // Stopping core's AI Client is only the owner's choice for one save, and nothing else does it.
  assert.equal(src.match(/'wp_ai_client_prevent_prompt'/g)?.length, 1);
  assert.match(src, /self::listen\(isset\(\$body\['noSiteAi'\]\) && \$body\['noSiteAi'\] === true\);\n\t\t\tif \(\$route === 'edit'\)/);
});

test('it stays within PHP 7.4, WordPress 7.1’s minimum, where a must-use plugin cannot afford a parse error', () => {
  const src = wordpressHelper(TOKEN);
  assert.ok(!/\?->/.test(src), 'no nullsafe operator');
  assert.ok(!/\bmatch\s*\(/.test(src), 'no match expression');
  assert.ok(!/\bcatch\s*\(\s*[A-Za-z_\\]+\s*\)/.test(src), 'every catch names its variable');
  assert.ok(!/:\s*(mixed|static|never)\b/.test(src), 'no PHP 8 return types');
  assert.ok(!/function\s*\([^)]*\b(int|string|array|bool)\s*\|/.test(src), 'no union types');
  assert.ok(!src.includes('#['), 'no attributes');
  // PHP 8.0 also parses these, and 7.4 stops at each.
  assert.ok(!/,\s*\)\s*(\{|use\b|:\s*\??[A-Za-z])/.test(src), 'no trailing comma in a parameter or use list');
  assert.ok(!/\b[A-Za-z_]\w*\(\s*[a-z_]\w*\s*:(?![:/])/.test(src.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, "''")), 'no named arguments');
  assert.ok(!/(\?\?|\?|=>|[^=!<>]=|&&|\|\|)\s*throw\b/.test(src), 'no throw expression');
  assert.ok(!/\w\(\s*\.\.\.\s*\)/.test(src), 'no first-class callable');
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
if (getenv('WL_LOGGED_IN_COOKIE')) define('LOGGED_IN_COOKIE', getenv('WL_LOGGED_IN_COOKIE'));
$_COOKIE = getenv('WL_COOKIE') ? array(getenv('WL_COOKIE') => 'stand-in') : array();
ob_start();
require getenv('WL_PLUGIN');
$out = ob_get_clean();
echo json_encode(array('hooks' => array_values(array_unique($GLOBALS['wl_hooks'])), 'output' => $out, 'savequeries' => defined('SAVEQUERIES'), 'admin' => defined('WP_ADMIN'), 'handler' => set_error_handler(null) !== null));
`);
  after(() => rmSync(dir, { recursive: true, force: true }));

  const load = (uri: string, token?: string, script?: string, cookies: { cookie?: string; name?: string } = {}): { hooks: string[]; output: string; savequeries: boolean; admin: boolean; handler: boolean } => JSON.parse(execFileSync(php as string, [harness], {
    env: {
      PATH: process.env.PATH ?? '', WL_URI: uri, WL_PLUGIN: plugin, ...(token ? { WL_TOKEN: token } : {}), ...(script ? { WL_SCRIPT: script } : {}),
      ...(cookies.cookie ? { WL_COOKIE: cookies.cookie } : {}), ...(cookies.name ? { WL_LOGGED_IN_COOKIE: cookies.name } : {}),
    },
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
      // Another Wanigan's key also gets one header saying a helper is here and answers to another Wanigan.
      assert.deepEqual(r.hooks.sort(), [...COUNTER, ...(token ? ['send_headers'] : [])].sort());
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
    const LOGGED_IN = { cookie: 'wordpress_logged_in_0123abcd' };
    for (const uri of ['/_wanigan/trace/0123456789abcdef', '/_wanigan/edit/post-1-title', '/_wanigan/move', '/_wanigan/remove', '/_wanigan/components', '/_wanigan/find?q=x']) {
      const r = load(uri, TOKEN, undefined, LOGGED_IN);
      assert.ok(!r.hooks.includes('all'), uri);
      assert.ok(r.hooks.includes('wp_loaded'), uri);
      assert.equal(r.savequeries, false, uri);
      assert.equal(r.admin, uri.startsWith('/_wanigan/find'), uri);
    }
    // Only a logged-in request has an admin menu to list. An anonymous one is not made an admin request: plugins
    // that hide wp-admin send those to a 404 page, which would turn the helper's answer into a redirect.
    assert.equal(load('/_wanigan/find', TOKEN).admin, false, 'no cookie');
    assert.equal(load('/_wanigan/find', TOKEN, undefined, { cookie: 'wordpress_sec_0123abcd' }).admin, false, 'only the auth cookie');
    assert.equal(load('/_wanigan/find', TOKEN, undefined, { cookie: 'acme_login', name: 'acme_login' }).admin, true, 'a LOGGED_IN_COOKIE wp-config.php names');
    assert.equal(load('/_wanigan/find', TOKEN, undefined, { cookie: 'wordpress_logged_in_0123abcd', name: 'acme_login' }).admin, false, 'not the default name when another is set');
    for (const [uri, script] of [['/wp-json/wp/v2/posts', 'index.php'], ['/?rest_route=/wp/v2/posts', 'index.php'], ['/wp-admin/admin-ajax.php', 'admin-ajax.php'], ['/wp-cron.php', 'wp-cron.php']] as const) {
      const r = load(uri, TOKEN, script);
      assert.ok(!r.hooks.includes('all'), uri);
      assert.equal(r.savequeries, false, uri);
    }
  });

  /*
   * A stand-in WordPress with made-up plugins, a theme and a must-use plugin on disk, so the helper names whose
   * code is hooked by the file it is written in, as it does on a real site. WL_DO picks what the harness runs.
   */
  const site = join(dir, 'site');
  const AI = join(dir, 'ai.php');
  const secret = ['wl', 'not', 'a', 'real', 'key', '0042'].join('-');
  for (const [file, code] of [
    ['wp-content/plugins/acme-seo/acme-seo.php', '<?php\n/* Plugin Name: Acme SEO */\nfunction acme_seo_on_save() {}\nfunction acme_seo_summary() {}\nclass Acme_Seo_Meta { public function meta() {} }\n'],
    ['wp-content/plugins/northwind-alt/northwind-alt.php', '<?php\nfunction northwind_alt_on_upload() {}\n'],
    ['wp-content/themes/northwind/functions.php', '<?php\nfunction northwind_theme_on_save() {}\n'],
    ['wp-content/mu-plugins/acme-tools.php', '<?php\nfunction acme_tools_on_save() {}\n'],
    ['wp-includes/post.php', '<?php\nfunction wl_core_on_save() {}\nfunction wl_core_site_info() {}\n'],
  ] as const) {
    mkdirSync(dirname(join(site, file)), { recursive: true });
    writeFileSync(join(site, file), code);
  }
  writeFileSync(AI, `<?php
define('ABSPATH', getenv('WL_SITE') . '/');
define('WP_CONTENT_DIR', ABSPATH . 'wp-content');
define('WP_PLUGIN_DIR', WP_CONTENT_DIR . '/plugins');
define('WPMU_PLUGIN_DIR', WP_CONTENT_DIR . '/mu-plugins');
$GLOBALS['wl_actions'] = array();
function add_action($h, $cb, $p = 10, $n = 1) { $GLOBALS['wl_actions'][$h][] = $cb; return true; }
function add_filter($h, $cb, $p = 10, $n = 1) { $GLOBALS['wl_actions'][$h][] = $cb; return true; }
function do_action($h, ...$args) { foreach ($GLOBALS['wl_actions'][$h] ?? array() as $cb) call_user_func_array($cb, $args); }
function apply_filters($h, $v, ...$args) { foreach ($GLOBALS['wl_actions'][$h] ?? array() as $cb) $v = call_user_func_array($cb, array_merge(array($v), $args)); return $v; }
function wp_parse_url($u, $c = -1) { return parse_url($u, $c); }
function wp_normalize_path($p) { return str_replace(chr(92), '/', $p); }
function is_admin() { return false; }
function untrailingslashit($s) { return rtrim($s, '/'); }
function wp_strip_all_tags($s) { return trim(strip_tags((string) $s)); }
function get_theme_root() { return WP_CONTENT_DIR . '/themes'; }
function get_stylesheet_directory() { return WP_CONTENT_DIR . '/themes/northwind'; }
function get_template_directory() { return WP_CONTENT_DIR . '/themes/northwind'; }
// The updater knows acme-seo (someone else's plugin) and no theme (northwind is the project's own).
function get_site_transient($k) { return (object) array('checked' => array('x' => '1'), 'no_update' => $k === 'update_plugins' ? array('acme-seo/acme-seo.php' => (object) array()) : array()); }
function nocache_headers() {}
function get_option($k, $d = false) { return $k === 'connectors_ai_acme_api_key' ? '${secret}' : $d; }
function wp_send_json($data, $status = 200) { echo json_encode(array('status' => $status, 'data' => $data)); exit; }
function get_plugins() { return array('acme-seo/acme-seo.php' => array('Name' => 'Acme SEO'), 'northwind-alt/northwind-alt.php' => array('Name' => 'Northwind Alt Text')); }
function get_mu_plugins() { return array('acme-tools.php' => array('Name' => 'Acme Tools')); }
class WP_Theme_Stub { public function exists() { return true; } public function get($k) { return 'Northwind'; } }
function wp_get_theme($s = null) { return new WP_Theme_Stub(); }
function get_post_types($args = array(), $out = 'names') { return array('post' => 'post', 'page' => 'page', 'attachment' => 'attachment'); }
function get_post_type_object($t) { return (object) array('labels' => (object) array('singular_name' => ucfirst($t))); }
class WP_Hook { public $callbacks = array(); }
$GLOBALS['wp_filter'] = array();
function hooked($hook, $fns) { $h = new WP_Hook(); foreach ($fns as $i => $fn) $h->callbacks[10 + $i][] = array('function' => $fn, 'accepted_args' => 1); $GLOBALS['wp_filter'][$hook] = $h; }
// Core's AI pieces, made up: three connectors and two abilities.
function wp_supports_ai() { return true; }
function wp_ai_client_prompt() { throw new Exception('Wanigan never prompts.'); }
function wp_get_connectors() {
  return array(
    'acme' => array('name' => 'Acme AI', 'type' => 'ai_provider', 'authentication' => array('method' => 'api_key', 'setting_name' => 'connectors_ai_acme_api_key'), 'plugin' => array('file' => 'acme-ai/plugin.php', 'is_active' => function () { return true; })),
    'local' => array('name' => 'Northwind Local', 'type' => 'ai_provider', 'authentication' => array('method' => 'none')),
    'spam' => array('name' => 'Example Spam Filter', 'type' => 'spam_filtering', 'authentication' => array('method' => 'api_key', 'setting_name' => 'example_spam_key', 'constant_name' => 'EXAMPLE_SPAM_KEY')),
  );
}
// Core's own check reads the value to say where it is, and answers only that.
function _wp_connectors_get_api_key_source($setting, $env = '', $constant = '') { return get_option($setting, '') !== '' ? 'database' : 'none'; }
class WP_Ability {
  protected $name; protected $label; protected $description; protected $category; protected $execute_callback; protected $meta;
  public function __construct($name, $args) { $this->name = $name; foreach ($args as $k => $v) $this->$k = $v; }
  public function get_name() { return $this->name; } public function get_label() { return $this->label; } public function get_description() { return $this->description; }
  public function get_category() { return $this->category; } public function get_meta() { return $this->meta; }
}
function wp_get_abilities() {
  return array(
    new WP_Ability('acme-seo/summarize', array('label' => 'Summarize a post', 'description' => 'Writes a summary.', 'category' => 'content', 'execute_callback' => 'acme_seo_summary', 'meta' => array('annotations' => array('readonly' => false, 'destructive' => false, 'idempotent' => null), 'public' => true, 'show_in_rest' => true))),
    new WP_Ability('core/get-site-info', array('label' => 'Get site information', 'description' => '', 'category' => 'site', 'execute_callback' => 'wl_core_site_info', 'meta' => array('annotations' => array('readonly' => true, 'destructive' => false, 'idempotent' => true), 'show_in_rest' => true))),
  );
}
$_SERVER['REQUEST_URI'] = getenv('WL_URI');
$_SERVER['SCRIPT_FILENAME'] = ABSPATH . 'index.php';
$_SERVER['HTTP_X_WANIGAN_LIVE'] = getenv('WL_TOKEN');
// A site that shows PHP errors on screen, as its wp-config.php says before any plugin loads.
if (getenv('WL_NOISE') === '1' || getenv('WL_DO') === 'display') ini_set('display_errors', '1');
require getenv('WL_PLUGIN');
foreach (array('wp-content/plugins/acme-seo/acme-seo.php', 'wp-content/plugins/northwind-alt/northwind-alt.php', 'wp-content/themes/northwind/functions.php', 'wp-content/mu-plugins/acme-tools.php', 'wp-includes/post.php') as $f) require_once ABSPATH . $f;
// A plugin loaded after the must-use plugins printing a deprecation notice, on a site that shows errors on screen.
if (getenv('WL_NOISE') === '1') {
  echo "<br />\n<b>Deprecated</b>:  Creation of dynamic property Acme_Seo::$x is deprecated in acme-seo.php on line 1<br />\n";
  trigger_error('Acme_Seo::legacy() is deprecated', E_USER_DEPRECATED);
}
if (getenv('WL_DO') === 'display') { echo json_encode(array('display' => ini_get('display_errors'))); exit; }
hooked('save_post', array('acme_seo_on_save', 'wl_core_on_save', 'acme_tools_on_save'));
hooked('save_post_page', array('northwind_theme_on_save'));
hooked('wp_after_insert_post', array(array(new Acme_Seo_Meta(), 'meta')));
hooked('add_attachment', array('northwind_alt_on_upload'));
hooked('updated_option', array('wanigan_live_changed'));
$call = function ($method, ...$args) { $m = new ReflectionMethod('Wanigan_Live', $method); return $m->invoke(null, ...$args); };
if (getenv('WL_DO') === 'route') Wanigan_Live::route();
if (getenv('WL_DO') === 'listen') {
  $call('listen', getenv('WL_STOP') === '1');
  // A plugin's save hook prompting through core's AI Client and running an ability, made up as the SDK's events look.
  $model = new class { public function providerMetadata() { return new class { public function getId() { return 'acme'; } }; } public function metadata() { return new class { public function getId() { return 'acme-large-2'; } }; } };
  $event = new class($model) { private $m; public function __construct($m) { $this->m = $m; } public function getModel() { return $this->m; } public function getCapability() { return (object) array('value' => 'text_generation'); } public function getMessages() { return array('${secret} prompt text'); } };
  $after = new class($model) { private $m; public function __construct($m) { $this->m = $m; } public function getModel() { return $this->m; } public function getResult() { return new class { public function getTokenUsage() { return new class { public function getTotalTokens() { return 812; } }; } }; } };
  $stopped = apply_filters('wp_ai_client_prevent_prompt', false, null);
  if (!$stopped) { do_action('wp_ai_client_before_generate_result', $event); do_action('wp_ai_client_after_generate_result', $after); }
  do_action('wp_ability_invoked', 'acme-seo/summarize', array('text' => 'input'), null);
  do_action('wp_before_execute_ability', 'acme-seo/summarize', array('text' => 'input'), null);
  do_action('wp_after_execute_ability', 'acme-seo/summarize', array('text' => 'input'), 'result', null);
  do_action('wp_ability_invoked', 'core/get-site-info', null, null);
  echo json_encode(array('stopped' => $stopped, 'ai' => $call('ai_report'), 'saves' => $call('save_code', 'post:page'), 'attachment' => $call('save_code', 'post:attachment')));
}
`);
  type Answer = { status?: number; data?: Record<string, unknown>; ai?: Record<string, unknown>; stopped?: boolean; saves?: Record<string, unknown>; attachment?: Record<string, unknown> };
  const ai = (what: 'route' | 'listen', extra: Record<string, string> = {}): Answer => {
    const out = execFileSync(php as string, [AI], { env: { PATH: process.env.PATH ?? '', WL_SITE: realpathSync(site), WL_PLUGIN: plugin, WL_TOKEN: TOKEN, WL_URI: '/_wanigan/ai', WL_DO: what, ...extra }, encoding: 'utf8' });
    assert.ok(!out.includes(secret), 'no key, and no prompt text, ever leaves the helper');
    return JSON.parse(out) as Answer;
  };

  test('a site that shows PHP errors on screen cannot break an answer: what was printed before it is dropped, and no error is shown', () => {
    const r = ai('route', { WL_NOISE: '1' });
    assert.equal(r.status, 200, 'the answer is only its JSON');
    const shown = execFileSync(php as string, [AI], { env: { PATH: process.env.PATH ?? '', WL_SITE: realpathSync(site), WL_PLUGIN: plugin, WL_TOKEN: TOKEN, WL_URI: '/_wanigan/ai', WL_DO: 'display' }, encoding: 'utf8' });
    assert.equal((JSON.parse(shown) as { display: string }).display, '0', 'its own routes show no PHP error on screen');
  });

  test('GET /_wanigan/ai lists core’s connectors with where each key comes from, never the key, and the abilities by whose code they are', () => {
    const r = ai('route');
    assert.equal(r.status, 200);
    const d = r.data as { version: number; platform: string; coreAi: boolean; supports: boolean; watches: unknown; connectors: unknown[]; abilities: Record<string, unknown>[]; saves: { id: string; runs: { by: string }[]; core: number }[] };
    assert.deepEqual([d.version, d.platform, d.coreAi, d.supports], [1, 'wordpress', true, true]);
    assert.deepEqual(d.watches, { prompts: true, abilities: true });
    assert.deepEqual(d.connectors, [
      { id: 'acme', name: 'Acme AI', type: 'ai_provider', method: 'api_key', keySource: 'database', setUp: true, plugin: 'acme-ai/plugin.php', active: true },
      { id: 'local', name: 'Northwind Local', type: 'ai_provider', method: 'none', keySource: 'none', setUp: true },
      { id: 'spam', name: 'Example Spam Filter', type: 'spam_filtering', method: 'api_key', keySource: 'none', setUp: false },
    ]);
    assert.deepEqual(d.abilities[0], { name: 'acme-seo/summarize', label: 'Summarize a post', readonly: false, destructive: false, idempotent: null, description: 'Writes a summary.', category: 'content', public: true, rest: true, by: 'acme-seo', kind: 'plugin', owner: 'plugin', byName: 'Acme SEO' });
    assert.deepEqual([d.abilities[1]?.by, d.abilities[1]?.byName, d.abilities[1]?.owner, d.abilities[1]?.readonly], ['wordpress', 'WordPress core', 'core', true]);
    const page = d.saves.find((x) => x.id === 'post:page');
    assert.deepEqual(page?.runs.map((x) => x.by), ['acme-seo', 'acme-tools', 'northwind'], 'a plugin, a must-use plugin and a theme on the page save path');
    assert.equal(page?.core, 1, 'core’s own callback is counted, not listed');
  });

  test('what a save runs is read from the hooks core fires for it, named by the file each callback is in, the helper’s own left out', () => {
    const r = ai('listen');
    const saves = r.saves as { label: string; runs: Record<string, unknown>[] };
    assert.equal(saves.label, 'Saving a Page');
    assert.deepEqual(saves.runs, [
      { by: 'acme-seo', kind: 'plugin', owner: 'plugin', hooks: ['save_post', 'wp_after_insert_post'], callbacks: ['acme_seo_on_save', 'Acme_Seo_Meta->meta'], name: 'Acme SEO' },
      { by: 'acme-tools', kind: 'mu-plugin', owner: 'yours', hooks: ['save_post'], callbacks: ['acme_tools_on_save'], name: 'Acme Tools' },
      { by: 'northwind', kind: 'theme', owner: 'yours', hooks: ['save_post_page'], callbacks: ['northwind_theme_on_save'], name: 'Northwind' },
    ]);
    const media = (r.attachment as { runs: { by: string; hooks: string[] }[] }).runs;
    assert.deepEqual(media.find((x) => x.by === 'northwind-alt')?.hooks, ['add_attachment'], 'media has its own hooks: an upload-time plugin shows');
  });

  test('during a save it records which provider, model and ability ran, as core reports them, and stops core’s AI Client only when asked', () => {
    const r = ai('listen');
    assert.equal(r.stopped, false, 'nothing is stopped unless the owner chose it');
    assert.deepEqual(r.ai, {
      watched: { prompts: true, abilities: true },
      prompts: [{ provider: 'acme', model: 'acme-large-2', capability: 'text_generation', done: true, tokens: 812 }],
      abilities: [{ name: 'acme-seo/summarize', done: true }, { name: 'core/get-site-info', done: false }],
    });
    const stopped = ai('listen', { WL_STOP: '1' });
    assert.equal(stopped.stopped, true);
    assert.equal((stopped.ai as { stopped: number }).stopped, 1);
    assert.deepEqual((stopped.ai as { prompts: unknown[] }).prompts, []);
  });
});
