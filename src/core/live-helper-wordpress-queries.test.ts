// The WordPress helper's query log, run under a stand-in WordPress whose wpdb does what core's does in order: the
// 'query' filter, the query run, the query logged (log_query_custom_data, when SAVEQUERIES is on), and only then its
// result read into last_result. What it proves: while a page is traced, a plugin reading its own option as it loads
// gets its own option back, and nothing the helper does while a query is logged runs another query. Naming who asked
// once read the plugins' update transient right there, and the plugin got the transient instead (a real site's form
// plugin then stopped every traced page). The asker is still named, once the trace is built. Nothing here runs
// WordPress; it needs PHP. Made-up plugins (acme-fields); nothing real.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { wordpressHelper } from './live-helper-wordpress.ts';
import { which } from './environment.ts';

const TOKEN = 'b'.repeat(48);

const HARNESS = String.raw`<?php
define('ABSPATH', getenv('WL_SITE') . '/');
define('WP_CONTENT_DIR', ABSPATH . 'wp-content');
define('WP_PLUGIN_DIR', WP_CONTENT_DIR . '/plugins');
define('WPMU_PLUGIN_DIR', WP_CONTENT_DIR . '/mu-plugins');
$GLOBALS['wl_actions'] = array();
function add_action($h, $cb, $p = 10, $n = 1) { $GLOBALS['wl_actions'][$h][] = $cb; return true; }
function add_filter($h, $cb, $p = 10, $n = 1) { $GLOBALS['wl_actions'][$h][] = $cb; return true; }
function remove_action($h, $cb, $p = 10) { return true; }
function remove_filter($h, $cb, $p = 10) { return true; }
function do_action($h, ...$args) { foreach ($GLOBALS['wl_actions'][$h] ?? array() as $cb) call_user_func_array($cb, $args); }
function apply_filters($h, $v, ...$args) { foreach ($GLOBALS['wl_actions'][$h] ?? array() as $cb) $v = call_user_func_array($cb, array_merge(array($v), $args)); return $v; }
function wp_parse_url($u, $c = -1) { return parse_url($u, $c); }
function wp_normalize_path($p) { return str_replace(chr(92), '/', $p); }
function untrailingslashit($s) { return rtrim($s, '/'); }
function is_admin() { return false; }
function get_theme_root() { return WP_CONTENT_DIR . '/themes'; }
function get_stylesheet_directory() { return WP_CONTENT_DIR . '/themes/northwind'; }
function get_template_directory() { return WP_CONTENT_DIR . '/themes/northwind'; }
// Core's order in wpdb::query() and wpdb::_do_query(): filter, run, log, then read the result.
class wpdb {
	public $result = array(); public $last_result = array(); public $num_rows = 0; public $rows_affected = 0; public $last_query = '';
	public $options = array('acme_fields_version' => '6.2', '_site_transient_update_plugins' => 'the plugin update transient');
	public $ran = array(); public $nested = array(); private $depth = 0;
	public function query($q) {
		$q = apply_filters('query', $q);
		$this->last_query = $q;
		$this->ran[] = $q;
		// A query started while another is between running and reading its result.
		if ($this->depth > 0) $this->nested[] = $q;
		$this->depth++;
		$this->result = preg_match("/option_name = '([^']+)'/", $q, $m) && isset($this->options[$m[1]]) ? array((object) array('option_value' => $this->options[$m[1]])) : array();
		if (defined('SAVEQUERIES') && SAVEQUERIES) apply_filters('log_query_custom_data', array(), $q, 0.0004, 'require_once', microtime(true));
		$this->last_result = $this->result;
		$this->num_rows = count($this->result);
		$this->depth--;
		return $this->num_rows;
	}
}
$GLOBALS['wpdb'] = new wpdb();
// Core reads a site transient from the database when no object cache holds it.
function get_site_transient($t) {
	global $wpdb;
	$wpdb->query("SELECT option_value FROM wp_options WHERE option_name = '_site_transient_$t' LIMIT 1");
	return (object) array('checked' => array('acme-fields/acme-fields.php' => '1.0'), 'no_update' => array('acme-fields/acme-fields.php' => (object) array()));
}
$_SERVER['REQUEST_URI'] = '/';
$_SERVER['SCRIPT_FILENAME'] = ABSPATH . 'index.php';
$_SERVER['HTTP_X_WANIGAN_LIVE'] = getenv('WL_TOKEN');
ob_start();
require getenv('WL_PLUGIN');
if (getenv('WL_PRELOAD') === '1') do_action('muplugins_loaded');
// A plugin reading its own option as it loads, as a form plugin does in its constructor.
require WP_PLUGIN_DIR . '/acme-fields/acme-fields.php';
$got = acme_fields_version();
if (method_exists('Wanigan_Live', 'callers')) (new ReflectionMethod('Wanigan_Live', 'callers'))->invoke(null);
$queries = (new ReflectionProperty('Wanigan_Live', 'queries'))->getValue();
ob_end_clean();
echo json_encode(array('got' => $got, 'nested' => $GLOBALS['wpdb']->nested, 'queries' => $queries));
`;

const PLUGIN = `<?php
function acme_fields_version() {
	global $wpdb;
	$wpdb->query("SELECT option_value FROM wp_options WHERE option_name = 'acme_fields_version' LIMIT 1");
	return $wpdb->last_result ? $wpdb->last_result[0]->option_value : false;
}
`;

type Run = { got: unknown; nested: string[]; queries: { sql: string; caller?: { file: string; owner: string; package?: string }; at?: unknown }[] };

function run(t: { skip(why: string): void }, preload: boolean): Run | null {
  const php = which('php', process.env.PATH ?? '');
  if (!php) { t.skip('PHP is not installed here'); return null; }
  const site = realpathSync(mkdtempSync(join(tmpdir(), 'wl-wp-queries-')));
  try {
    mkdirSync(join(site, 'wp-content/plugins/acme-fields'), { recursive: true });
    mkdirSync(join(site, 'wp-content/mu-plugins'), { recursive: true });
    writeFileSync(join(site, 'wp-content/plugins/acme-fields/acme-fields.php'), PLUGIN);
    writeFileSync(join(site, 'wp-content/mu-plugins/wanigan-live.php'), wordpressHelper(TOKEN));
    writeFileSync(join(site, 'harness.php'), HARNESS);
    const out = execFileSync(php, [join(site, 'harness.php')], {
      env: { PATH: process.env.PATH ?? '', WL_SITE: site, WL_PLUGIN: join(site, 'wp-content/mu-plugins/wanigan-live.php'), WL_TOKEN: TOKEN, WL_PRELOAD: preload ? '1' : '0' },
      encoding: 'utf8',
    });
    return JSON.parse(out) as Run;
  } finally {
    rmSync(site, { recursive: true, force: true });
  }
}

test('a plugin reading its own option while a page is traced gets its own option, not what naming it read', (t) => {
  for (const preload of [false, true]) {
    const r = run(t, preload);
    if (!r) return;
    assert.equal(r.got, '6.2', `the plugin's own option (update data read ${preload ? 'before plugins load' : 'only on demand'})`);
    assert.deepEqual(r.nested, [], 'nothing queried while another query was being logged');
  }
});

test('who asked is still named, once the trace is built: the plugin, by its folder and its owner', (t) => {
  const r = run(t, true);
  if (!r) return;
  const q = r.queries.find((x) => x.sql.includes('acme_fields_version'));
  assert.ok(q, 'the query is in the trace');
  assert.equal(q.at, undefined, 'the raw file and line are not left in the trace');
  assert.deepEqual([q.caller?.file, q.caller?.package, q.caller?.owner], ['wp-content/plugins/acme-fields/acme-fields.php', 'acme-fields', 'plugin']);
});
