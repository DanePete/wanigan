// The WordPress helper's version 4 under a stand-in WordPress: taking a placed
// item out (a block from a post's markup, a widget, a menu item) and putting
// it back, the component library from core's registries, and the piece that
// pictures one entry alone. The plugin is the real file Wanigan writes; the
// WordPress around it is made up here (a small block parser and serializer
// shaped like core's, REST routes that record what they were asked) with
// made-up blocks (acme, northwind). Nothing here touches a site; it needs PHP.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { wordpressHelper } from './live-helper-wordpress.ts';
import { parseLibrary } from '../shared/live-library.ts';

const TOKEN = 'cd'.repeat(24);

const php = ((): string | null => {
  try { execFileSync('php', ['-v'], { stdio: 'ignore' }); return 'php'; } catch { return null; }
})();

const HARNESS = String.raw`<?php
define('ABSPATH', getenv('WL_SITE') . '/');
define('WP_CONTENT_DIR', ABSPATH . 'wp-content');
define('WP_PLUGIN_DIR', WP_CONTENT_DIR . '/plugins');
define('WPMU_PLUGIN_DIR', WP_CONTENT_DIR . '/mu-plugins');
$GLOBALS['wl'] = array('hooks' => array(), 'options' => array(), 'transients' => array(), 'rest' => array(), 'posts' => array(), 'menu' => array(), 'sidebars' => array(), 'enqueued' => array(), 'inline' => array(), 'next' => 100);
final class WlSent extends Exception { public $data; public $status; public function __construct($d, $s) { parent::__construct('sent'); $this->data = $d; $this->status = $s; } }
function add_action($h, $cb, $p = 10, $n = 1) { $GLOBALS['wl']['hooks'][$h][] = $cb; return true; }
function add_filter($h, $cb, $p = 10, $n = 1) { $GLOBALS['wl']['hooks'][$h][] = $cb; return true; }
function remove_action() { return true; }
function remove_filter() { return true; }
function apply_filters($h, $v) { return $v; }
function wp_parse_url($u, $c = -1) { return parse_url($u, $c); }
function wp_normalize_path($p) { return str_replace(chr(92), '/', $p); }
function untrailingslashit($s) { return rtrim($s, '/'); }
function is_admin() { return false; }
function wp_unslash($v) { return $v; }
function wp_json_encode($v, $f = 0) { return json_encode($v, $f); }
function wp_strip_all_tags($s) { return trim(strip_tags((string) $s)); }
function esc_attr($s) { return htmlspecialchars((string) $s, ENT_QUOTES); }
function esc_html($s) { return htmlspecialchars((string) $s, ENT_QUOTES); }
function esc_url($s) { return (string) $s; }
function add_query_arg() { return $_SERVER['REQUEST_URI']; }
function get_option($k, $d = false) { return $GLOBALS['wl']['options'][$k] ?? $d; }
function update_option($k, $v) { $GLOBALS['wl']['options'][$k] = $v; return true; }
function get_transient($k) { return $GLOBALS['wl']['transients'][$k] ?? false; }
function set_transient($k, $v) { $GLOBALS['wl']['transients'][$k] = $v; return true; }
function delete_transient($k) { unset($GLOBALS['wl']['transients'][$k]); return true; }
function get_current_user_id() { return 1; }
function is_user_logged_in() { return true; }
function current_user_can() { return true; }
function wp_send_json($data, $status = 200) { throw new WlSent($data, $status); }
function nocache_headers() {}
function status_header() {}
function get_site_transient($k) { return false; }
function get_theme_root() { return WP_CONTENT_DIR . '/themes'; }
function get_stylesheet() { return 'northwind'; }
function get_template() { return 'northwind'; }
function get_stylesheet_directory() { return WP_CONTENT_DIR . '/themes/northwind'; }
function get_template_directory() { return WP_CONTENT_DIR . '/themes/northwind'; }
// All of a post's meta as stored (values serialized), or '' for one key; add_post_meta() unslashes and serializes, as core's does.
function get_post_meta($id = 0, $key = '') { return $key === '' ? (isset($GLOBALS['wl']['meta'][(int) $id]) ? $GLOBALS['wl']['meta'][(int) $id] : array()) : ''; }
function add_post_meta($id, $key, $value) { $GLOBALS['wl']['meta'][(int) $id][wp_unslash($key)][] = maybe_serialize(wp_unslash($value)); return 1; }
function maybe_serialize($v) { return is_array($v) || is_object($v) || (is_string($v) && @unserialize($v) !== false) ? serialize($v) : $v; }
function maybe_unserialize($v) { $u = is_string($v) ? @unserialize($v) : false; return $u !== false || $v === 'b:0;' ? $u : $v; }
function wp_slash($v) { return $v; }
final class WP_Post { public $ID; public $post_type = 'page'; public $post_title = 'Home'; public function __construct($id) { $this->ID = $id; } }
function get_post($id) { return isset($GLOBALS['wl']['posts'][(int) $id]) ? new WP_Post((int) $id) : null; }
function get_post_field($f, $id) { return $GLOBALS['wl']['posts'][(int) $id]; }
function get_post_type_object($t) { return (object) array('labels' => (object) array('singular_name' => 'Page')); }
function rest_get_route_for_post($p) { return '/wp/v2/pages/' . $p->ID; }
function wp_get_post_revisions($id) { return array($GLOBALS['wl']['next']); }
function wp_get_sidebars_widgets() { return $GLOBALS['wl']['sidebars']; }
function wp_set_sidebars_widgets($s) { $GLOBALS['wl']['sidebars'] = $s; }
function wp_get_nav_menu_items($menu) { $out = array(); foreach ($GLOBALS['wl']['menu'] as $id => $m) $out[] = (object) array('ID' => $id, 'menu_item_parent' => $m['parent'], 'menu_order' => $m['menu_order']); return $out; }
final class WP_Error { private $m; private $d; public function __construct($c = '', $m = '', $d = null) { $this->m = $m; $this->d = $d; } public function get_error_message() { return $this->m; } public function get_error_data() { return $this->d; } }
function is_wp_error($v) { return $v instanceof WP_Error; }
final class WP_REST_Request {
  public $method; public $route; public $params = array();
  public function __construct($m, $r) { $this->method = $m; $this->route = $r; }
  public function set_query_params($p) { $this->params = $p; } public function set_body_params($p) { $this->params = $p; }
}
final class WlResponse { private $d; public function __construct($d) { $this->d = $d; } public function is_error() { return false; } public function get_data() { return $this->d; } }
function rest_do_request($r) {
  $GLOBALS['wl']['rest'][] = array($r->method, $r->route, $r->params);
  $wl = &$GLOBALS['wl'];
  if ($r->method === 'POST' && preg_match('#^/wp/v2/pages/(\d+)$#', $r->route, $m)) { $wl['posts'][(int) $m[1]] = $r->params['content']; $wl['next']++; return new WlResponse(array('id' => (int) $m[1])); }
  if ($r->method === 'GET' && preg_match('#^/wp/v2/menu-items/(\d+)$#', $r->route, $m)) { $i = $wl['menu'][(int) $m[1]]; return new WlResponse(array('id' => (int) $m[1], 'title' => array('raw' => $i['title'], 'rendered' => '<b>' . $i['title'] . '</b>'), 'type' => 'post_type', 'object' => 'page', 'object_id' => 12, 'url' => 'https://acme.example.test/about/', 'parent' => $i['parent'], 'menu_order' => $i['menu_order'], 'menus' => 3, 'status' => 'publish', 'classes' => array(''))); }
  if ($r->method === 'DELETE' && preg_match('#^/wp/v2/menu-items/(\d+)$#', $r->route, $m)) { unset($wl['menu'][(int) $m[1]]); return new WlResponse(array('deleted' => true)); }
  if ($r->method === 'POST' && $r->route === '/wp/v2/menu-items') { $id = ++$wl['next']; $wl['menu'][$id] = array('title' => $r->params['title'], 'parent' => $r->params['parent'], 'menu_order' => $r->params['menu_order']); return new WlResponse(array('id' => $id)); }
  if ($r->method === 'POST' && preg_match('#^/wp/v2/menu-items/(\d+)$#', $r->route, $m)) { $wl['menu'][(int) $m[1]]['menu_order'] = $r->params['menu_order']; $wl['menu'][(int) $m[1]]['parent'] = $r->params['parent']; return new WlResponse(array('id' => (int) $m[1])); }
  return new WlResponse(array());
}
// Blocks, shaped like core's blocks.php: delimiters, inner content with null placeholders, core/ dropped when written.
const WL_DELIM = '/<!--\s+(\/)?wp:([a-z][a-z0-9_-]*(?:\/[a-z][a-z0-9_-]*)?)\s+(\{(?:(?!-->).)*?\}\s+)?(\/)?-->/s';
function wl_block($s, &$pos) {
  preg_match(WL_DELIM, $s, $m, PREG_OFFSET_CAPTURE, $pos);
  $name = strpos($m[2][0], '/') === false ? 'core/' . $m[2][0] : $m[2][0];
  $attrs = isset($m[3]) && $m[3][1] >= 0 ? (json_decode(trim($m[3][0]), true) ?: array()) : array();
  $pos = $m[0][1] + strlen($m[0][0]);
  $b = array('blockName' => $name, 'attrs' => $attrs, 'innerBlocks' => array(), 'innerHTML' => '', 'innerContent' => array());
  if (isset($m[4]) && $m[4][0] === '/') return $b;
  while (preg_match(WL_DELIM, $s, $n, PREG_OFFSET_CAPTURE, $pos)) {
    if ($n[0][1] > $pos) { $t = substr($s, $pos, $n[0][1] - $pos); $b['innerHTML'] .= $t; $b['innerContent'][] = $t; }
    if ($n[1][0] === '/') { $pos = $n[0][1] + strlen($n[0][0]); return $b; }
    $pos = $n[0][1];
    $b['innerBlocks'][] = wl_block($s, $pos);
    $b['innerContent'][] = null;
  }
  return $b;
}
function parse_blocks($s) {
  $pos = 0; $out = array();
  while (true) {
    $found = preg_match(WL_DELIM, $s, $m, PREG_OFFSET_CAPTURE, $pos);
    $at = $found ? $m[0][1] : strlen($s);
    if ($at > $pos) { $t = substr($s, $pos, $at - $pos); $out[] = array('blockName' => null, 'attrs' => array(), 'innerBlocks' => array(), 'innerHTML' => $t, 'innerContent' => array($t)); }
    if (!$found) break;
    $pos = $at;
    $out[] = wl_block($s, $pos);
  }
  return $out;
}
function serialize_block($b) {
  $content = ''; $i = 0;
  foreach ($b['innerContent'] as $chunk) $content .= is_string($chunk) ? $chunk : serialize_block($b['innerBlocks'][$i++]);
  if ($b['blockName'] === null) return $content;
  $name = strpos($b['blockName'], 'core/') === 0 ? substr($b['blockName'], 5) : $b['blockName'];
  $attrs = empty($b['attrs']) ? '' : json_encode($b['attrs'], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . ' ';
  return $content === '' ? "<!-- wp:$name $attrs/-->" : "<!-- wp:$name $attrs-->" . $content . "<!-- /wp:$name -->";
}
function serialize_blocks($bs) { return implode('', array_map('serialize_block', $bs)); }
function do_blocks($markup) { return '<div class="rendered">' . htmlspecialchars($markup) . '</div>'; }
// Registries.
final class WP_Block_Type {
  public $name; public $title = ''; public $category = null; public $description = ''; public $attributes = array(); public $example = null; public $styles = array();
  public $parent = null; public $ancestor = null; public $supports = array(); public $render_callback = null; public $editor_script_handles = array();
  public function __construct($name, $args) { $this->name = $name; foreach ($args as $k => $v) $this->$k = $v; }
  public function is_dynamic() { return is_callable($this->render_callback); }
}
final class WP_Block_Type_Registry {
  public static $types = array();
  public static function get_instance() { return new self(); }
  public function get_all_registered() { return self::$types; }
  public function get_registered($n) { return self::$types[$n] ?? null; }
}
final class WP_Block_Patterns_Registry {
  public static $patterns = array();
  public static function get_instance() { return new self(); }
  public function get_all_registered() { return array_values(self::$patterns); }
  public function get_registered($n) { return self::$patterns[$n] ?? null; }
}
final class WP_Block_Styles_Registry {
  public static function get_instance() { return new self(); }
  public function get_all_registered() { return array('acme/card' => array('outline' => array('name' => 'outline', 'label' => 'Outline'))); }
}
function get_language_attributes() { return 'lang="en"'; }
function get_bloginfo() { return 'UTF-8'; }
function wp_head() { echo '<!-- head -->'; }
function wp_footer() { echo '<!-- foot -->'; }
function get_body_class($c) { return array($c, 'error404'); }
function wp_enqueue_script($h) { $GLOBALS['wl']['enqueued'][] = $h; }
function wp_add_inline_script($h, $code) { $GLOBALS['wl']['inline'][] = array($h, substr($code, 0, 60)); }

$_SERVER['REQUEST_URI'] = getenv('WL_URI');
$_SERVER['SCRIPT_FILENAME'] = ABSPATH . 'index.php';
$_SERVER['HTTP_X_WANIGAN_LIVE'] = getenv('WL_TOKEN');
require getenv('WL_PLUGIN');
$call = function ($method, ...$args) {
  $m = new ReflectionMethod('Wanigan_Live', $method);
  try { $r = $m->invoke(null, ...$args); return array('returned' => $r); } catch (WlSent $s) { return array('status' => $s->status, 'data' => $s->data); }
};
$out = array();
$store = function ($trace, $private) { set_transient('wanigan_live_t_1_0123456789abcdef', array('trace' => $trace, 'private' => array('collections' => $private))); };

if (getenv('WL_DO') === 'remove') {
  // A post: a heading, an image (attachment 42), a paragraph. The image block goes; the attachment is never touched.
  $content = "<!-- wp:heading -->\n<h2>Welcome</h2>\n<!-- /wp:heading -->\n\n<!-- wp:image {\"id\":42} -->\n<figure><img src=\"x.jpg\"/></figure>\n<!-- /wp:image -->\n\n<!-- wp:paragraph -->\n<p>Hello</p>\n<!-- /wp:paragraph -->";
  $GLOBALS['wl']['posts'][7] = $content;
  $blocks = parse_blocks($content);
  $fps = array('pa' => md5(serialize_block($blocks[0])), 'pb' => md5(serialize_block($blocks[2])), 'pc' => md5(serialize_block($blocks[4])));
  $GLOBALS['wl']['sidebars'] = array('sidebar-1' => array('block-2', 'search-3'), 'wp_inactive_widgets' => array('text-9'));
  $GLOBALS['wl']['menu'] = array(31 => array('title' => 'About', 'parent' => 0, 'menu_order' => 1), 32 => array('title' => 'Shop', 'parent' => 0, 'menu_order' => 2), 33 => array('title' => 'Gifts', 'parent' => 32, 'menu_order' => 3));
  $state = array(31 => array(0, 1), 32 => array(0, 2), 33 => array(32, 3));
  // The item's own fields, which /wp/v2/menu-items makes again, and a theme's setting for it, which it does not.
  $GLOBALS['wl']['meta'][31] = array('_menu_item_type' => array('post_type'), '_edit_lock' => array('1:1'), 'acme_icon' => array('star'), 'acme_columns' => array(serialize(array('a' => 1))));
  $trace = array('collections' => array(
    array('id' => 'c-post', 'kind' => 'post-blocks', 'items' => array('pa', 'pb', 'pc'), 'removes' => true),
    array('id' => 'c-w', 'kind' => 'widgets', 'items' => array('w1', 'w2'), 'removes' => true),
    array('id' => 'c-m', 'kind' => 'menu', 'items' => array('m1', 'm2'), 'removes' => true),
    array('id' => 'c-no', 'kind' => 'region-blocks', 'items' => array('x'), 'removes' => false, 'removeWhy' => 'Your WordPress user cannot change templates (edit_theme_options).'),
  ));
  $private = array(
    'c-post' => array('type' => 'blocks', 'store' => 'post:7', 'parent' => array(), 'holder' => null, 'paths' => array('pa' => array(0), 'pb' => array(2), 'pc' => array(4)), 'fps' => $fps, 'hash' => md5($content)),
    'c-w' => array('type' => 'widgets', 'sidebar' => 'sidebar-1', 'widgets' => array('w1' => 'block-2', 'w2' => 'search-3'), 'state' => array('block-2', 'search-3')),
    'c-m' => array('type' => 'menu', 'menu' => 3, 'parent' => 0, 'items' => array('m1' => 31, 'm2' => 32), 'state' => $state, 'this' => null),
    'c-no' => array('type' => 'blocks'),
  );
  $store($trace, $private);
  $undo = function ($answer) use ($call) { return $call('undo', array('undo' => $answer['data']['undo'])); };

  $r = $call('remove', array('trace' => '0123456789abcdef', 'collection' => 'c-post', 'item' => 'pb'));
  $out['block'] = array($r, $GLOBALS['wl']['posts'][7], end($GLOBALS['wl']['rest']));
  $out['blockUndo'] = array($undo($r)['status'], $GLOBALS['wl']['posts'][7] === $content);
  $GLOBALS['wl']['posts'][7] = str_replace('Hello', 'Hello again', $content);
  $out['blockChanged'] = $call('remove', array('trace' => '0123456789abcdef', 'collection' => 'c-post', 'item' => 'pb'));
  $GLOBALS['wl']['posts'][7] = $content;

  $r = $call('remove', array('trace' => '0123456789abcdef', 'collection' => 'c-w', 'item' => 'w1'));
  $out['widget'] = array($r['status'], $GLOBALS['wl']['sidebars']);
  $out['widgetUndo'] = array($undo($r)['status'], $GLOBALS['wl']['sidebars']);

  $GLOBALS['wl']['rest'] = array();
  $r = $call('remove', array('trace' => '0123456789abcdef', 'collection' => 'c-m', 'item' => 'm1'));
  $out['menu'] = array($r['status'], array_keys($GLOBALS['wl']['menu']), array_map(function ($x) { return array($x[0], $x[1]); }, $GLOBALS['wl']['rest']));
  $GLOBALS['wl']['rest'] = array();
  $u = $undo($r);
  $out['menuUndo'] = array($u['status'], $GLOBALS['wl']['menu'], $GLOBALS['wl']['rest'][0]);
  $made = max(array_keys($GLOBALS['wl']['menu']));
  $out['menuMeta'] = isset($GLOBALS['wl']['meta'][$made]) ? $GLOBALS['wl']['meta'][$made] : array();
  // The first is back (under a new id): the trace is from before, so make it as the trace saw it again for the next.
  $GLOBALS['wl']['menu'] = array(31 => array('title' => 'About', 'parent' => 0, 'menu_order' => 1), 32 => array('title' => 'Shop', 'parent' => 0, 'menu_order' => 2), 33 => array('title' => 'Gifts', 'parent' => 32, 'menu_order' => 3));
  $out['menuParent'] = $call('remove', array('trace' => '0123456789abcdef', 'collection' => 'c-m', 'item' => 'm2'));
  $out['refused'] = $call('remove', array('trace' => '0123456789abcdef', 'collection' => 'c-no', 'item' => 'x'));
  $out['gone'] = $call('remove', array('trace' => 'ffffffffffffffff', 'collection' => 'c-post', 'item' => 'pb'))['status'];
}

if (getenv('WL_DO') === 'library') {
  $site = getenv('WL_SITE');
  Wanigan_Live::block_json(array('name' => 'acme/card', 'file' => $site . '/wp-content/plugins/acme-blocks/build/card/block.json'));
  Wanigan_Live::block_json(array('name' => 'core/paragraph', 'file' => $site . '/wp-includes/blocks/paragraph/block.json'));
  WP_Block_Type_Registry::$types = array(
    'acme/card' => new WP_Block_Type('acme/card', array('title' => 'Card', 'category' => 'design', 'description' => 'A <b>card</b>.', 'attributes' => array('heading' => array('type' => 'rich-text', 'source' => 'rich-text', 'selector' => 'h3'), 'tone' => array('type' => 'string', 'enum' => array('light', 'dark'), 'default' => 'light')), 'example' => array('attributes' => array('heading' => 'Spring sale')), 'styles' => array(array('name' => 'plain', 'label' => 'Plain', 'is_default' => true)))),
    'acme/latest' => new WP_Block_Type('acme/latest', array('title' => 'Latest', 'render_callback' => function () { return ''; }, 'parent' => array('acme/card'))),
    'core/paragraph' => new WP_Block_Type('core/paragraph', array('title' => 'Paragraph', 'example' => array('attributes' => array('content' => 'Hi')))),
    'core/block' => new WP_Block_Type('core/block', array('title' => 'Pattern', 'render_callback' => function () { return ''; })),
    'core/legacy-widget' => new WP_Block_Type('core/legacy-widget', array('title' => 'Legacy widget', 'render_callback' => function () { return ''; })),
    'northwind/hidden' => new WP_Block_Type('northwind/hidden', array('title' => 'Hidden', 'supports' => array('inserter' => false))),
  );
  WP_Block_Patterns_Registry::$patterns = array(
    'northwind/hero' => array('name' => 'northwind/hero', 'title' => 'Hero', 'categories' => array('banner'), 'blockTypes' => array('core/cover'), 'filePath' => $site . '/wp-content/themes/northwind/patterns/hero.php', 'content' => '<!-- wp:paragraph --><p>Hero</p><!-- /wp:paragraph -->'),
    'northwind/secret' => array('name' => 'northwind/secret', 'title' => 'Hidden', 'inserter' => false, 'content' => ''),
  );
  $first = $call('components');
  touch($site . '/wp-content/plugins/acme-blocks/build/card/block.json', time() + 100);
  clearstatcache();
  $again = $call('components');
  $out['library'] = $first['data'];
  $out['moved'] = $first['data']['hash'] !== $again['data']['hash'];
}

if (getenv('WL_DO') === 'piece') {
  WP_Block_Type_Registry::$types = array(
    'acme/card' => new WP_Block_Type('acme/card', array('title' => 'Card', 'example' => array('attributes' => array('heading' => 'Spring sale'), 'innerBlocks' => array(array('name' => 'core/paragraph', 'attributes' => array('content' => 'Inside')), array('nope' => 1))), 'editor_script_handles' => array('acme-card-editor'))),
    'acme/latest' => new WP_Block_Type('acme/latest', array('title' => 'Latest', 'render_callback' => function () { return ''; }, 'example' => array('attributes' => array('count' => 3)))),
    'core/paragraph' => new WP_Block_Type('core/paragraph', array('title' => 'Paragraph')),
    'core/block' => new WP_Block_Type('core/block', array('title' => 'Pattern', 'render_callback' => function () { return ''; })),
  );
  WP_Block_Patterns_Registry::$patterns = array('northwind/hero' => array('name' => 'northwind/hero', 'title' => 'Hero', 'content' => '<!-- wp:paragraph --><p>Hero</p><!-- /wp:paragraph -->'));
  $page = function ($entry, $post = null) {
    $_GET = array('entry' => $entry);
    $_POST = $post === null ? array() : array('markup' => $post);
    $_SERVER['REQUEST_METHOD'] = $post === null ? 'GET' : 'POST';
    $GLOBALS['wl']['enqueued'] = array();
    ob_start();
    Wanigan_Live::library_piece();
    return array(ob_get_clean(), $GLOBALS['wl']['enqueued']);
  };
  $out['pattern'] = $page('pattern:northwind/hero');
  $out['dynamic'] = $page('block:acme/latest');
  $out['static'] = $page('style:acme/card:outline');
  $out['posted'] = $page('block:acme/card', '<!-- wp:acme/card {"heading":"Spring sale"} --><h3>Spring sale</h3><!-- /wp:acme/card -->');
  $out['other'] = $page('block:acme/card', '<!-- wp:core/html --><script>x</script><!-- /wp:core/html -->');
  $out['reference'] = $page('block:core/block');
  $out['missing'] = $page('block:acme/gone');
  $out['fields'] = Wanigan_Live::menu_item_fields(array('id' => 31, 'title' => array('raw' => 'About', 'rendered' => '<b>About</b>'), 'type' => 'post_type', 'object' => 'page', 'object_id' => 12, 'url' => 'https://acme.example.test/about/', 'parent' => 0, 'menu_order' => 1, 'menus' => 3, '_links' => array()));
  $out['custom'] = Wanigan_Live::menu_item_fields(array('title' => array('raw' => 'Docs'), 'type' => 'custom', 'url' => 'https://example.test/docs'));
}
echo json_encode($out);
`;

describe('version 4 of the WordPress helper, under a stand-in WordPress', { skip: php ? false : 'PHP is not installed here' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'wg-wp-library-'));
  const site = join(dir, 'site');
  const plugin = join(dir, 'wanigan-live.php');
  const harness = join(dir, 'harness.php');
  writeFileSync(plugin, wordpressHelper(TOKEN));
  writeFileSync(harness, HARNESS);
  for (const [file, text] of [
    ['wp-content/plugins/acme-blocks/build/card/block.json', '{"name":"acme/card"}'],
    ['wp-content/plugins/acme-blocks/build/card/render.php', '<?php'],
    ['wp-includes/blocks/paragraph/block.json', '{"name":"core/paragraph"}'],
    ['wp-content/themes/northwind/patterns/hero.php', '<?php // Title: Hero'],
    ['wp-content/themes/northwind/theme.json', '{}'],
    ['wp-admin/includes/post.php', '<?php function get_block_editor_server_block_settings() { return array("acme/card" => array("title" => "Card")); }'],
  ] as const) {
    mkdirSync(join(site, file, '..'), { recursive: true });
    writeFileSync(join(site, file), text);
  }
  after(() => rmSync(dir, { recursive: true, force: true }));
  const run = (what: string, uri: string): Record<string, unknown> => JSON.parse(execFileSync(php as string, [harness], {
    env: { PATH: process.env.PATH ?? '', WL_SITE: site, WL_PLUGIN: plugin, WL_TOKEN: TOKEN, WL_URI: uri, WL_DO: what }, encoding: 'utf8',
  })) as Record<string, unknown>;

  test('a block, a widget and a menu item are taken out through core’s own APIs, and each undo puts it back', () => {
    const out = run('remove', '/_wanigan/remove') as Record<string, [Record<string, unknown>, ...unknown[]] & unknown[]>;
    const [answer, content, rest] = out.block as [{ status: number; data: Record<string, unknown> }, string, [string, string, Record<string, string>]];
    assert.equal(answer.status, 200);
    assert.equal(answer.data.ok, true);
    assert.match(String(answer.data.undo), /^[0-9a-f]{24}$/);
    assert.equal(answer.data.revision, '101', 'the post saved a new revision');
    assert.equal(content, '<!-- wp:heading -->\n<h2>Welcome</h2>\n<!-- /wp:heading -->\n\n<!-- wp:paragraph -->\n<p>Hello</p>\n<!-- /wp:paragraph -->', 'the image block and the space beside it went; the rest is byte for byte');
    assert.deepEqual([rest[0], rest[1]], ['POST', '/wp/v2/pages/7'], 'saved through the post’s REST route, as the editor saves');
    assert.deepEqual(out.blockUndo, [200, true], 'undo writes the post back as it was');
    const changed = out.blockChanged as unknown as { status: number; data: { error: string; items: string[] } };
    assert.equal(changed.status, 409);
    assert.deepEqual(changed.data.items, ['pa', 'pb'], 'the order now, as the trace’s part ids that are still the same');

    assert.deepEqual(out.widget, [200, { 'sidebar-1': ['search-3'], wp_inactive_widgets: ['block-2', 'text-9'] }], 'to Inactive widgets, its settings kept');
    assert.deepEqual(out.widgetUndo, [200, { 'sidebar-1': ['block-2', 'search-3'], wp_inactive_widgets: ['text-9'] }]);

    assert.deepEqual(out.menu, [200, [32, 33], [['GET', '/wp/v2/menu-items/31'], ['DELETE', '/wp/v2/menu-items/31']]], 'its fields read first, then the item deleted (its page is not)');
    const [undone, menu, made] = out.menuUndo as unknown as [number, Record<string, { title: string; parent: number; menu_order: number }>, [string, string, Record<string, unknown>]];
    assert.equal(undone, 200);
    assert.deepEqual([made[0], made[1]], ['POST', '/wp/v2/menu-items']);
    assert.deepEqual(made[2], { type: 'post_type', status: 'publish', parent: 0, classes: [''], menu_order: 1, object: 'page', object_id: 12, menus: 3, title: 'About' }, 'made again from its own fields: the raw title, no rendered markup, no address for a page link');
    assert.deepEqual(Object.values(menu).map((m) => [m.title, m.parent, m.menu_order]).sort(), [['About', 0, 1], ['Gifts', 32, 3], ['Shop', 0, 2]], 'back in its place');
    assert.deepEqual(out.menuMeta, { acme_icon: ['star'], acme_columns: ['a:1:{s:1:"a";i:1;}'] }, 'its other meta put back as it was stored; its own fields and edit lock left to core');
    const parent = out.menuParent as unknown as { status: number; data: { error: string } };
    assert.equal(parent.status, 409);
    assert.match(parent.data.error, /links under it/);
    assert.deepEqual(out.refused, { status: 403, data: { ok: false, error: 'Your WordPress user cannot change templates (edit_theme_options).' } });
    assert.equal(out.gone, 409, 'a trace that is gone');
  });

  test('the library lists block types, patterns and styles from core’s registries, each with how it is pictured', () => {
    const out = run('library', '/_wanigan/components') as { library: unknown; moved: boolean };
    const lib = parseLibrary(out.library);
    assert.ok(lib, 'a library by the contract');
    assert.equal(lib.platform, 'wordpress');
    assert.equal(lib.theme, 'northwind');
    assert.deepEqual(lib.counts, { block: 6, pattern: 1, style: 2 });
    assert.deepEqual(lib.skipped, { 'patterns hidden from the inserter': 1 });
    const byId = new Map(lib.entries.map((e) => [e.id, e]));
    assert.deepEqual([...byId.keys()], ['block:acme/card', 'style:acme/card:plain', 'style:acme/card:outline', 'block:acme/latest', 'block:core/block', 'block:core/legacy-widget', 'block:core/paragraph', 'block:northwind/hidden', 'pattern:northwind/hero']);
    const card = byId.get('block:acme/card')!;
    // With no update data from core, whose a plugin is stays unknown rather than guessed.
    assert.deepEqual([card.by, card.owner, card.category, card.description, card.files], ['acme-blocks', 'unknown', 'design', 'A card.', ['wp-content/plugins/acme-blocks/build/card/block.json', 'wp-content/plugins/acme-blocks/build/card/render.php']]);
    assert.deepEqual(card.props, { type: 'object', properties: { heading: { type: 'string', source: 'rich-text' }, tone: { type: 'string', enum: ['light', 'dark'], default: 'light' } } });
    assert.deepEqual(card.picture, { from: 'example', piece: '/_wanigan/piece/library?entry=block%3Aacme%2Fcard' });
    assert.deepEqual(byId.get('style:acme/card:outline')?.picture, { from: 'example', piece: '/_wanigan/piece/library?entry=style%3Aacme%2Fcard%3Aoutline' }, 'a registered style, pictured as its block with its class');
    assert.equal(byId.get('style:acme/card:plain')?.description, 'The block’s default style.');
    assert.deepEqual(byId.get('block:acme/latest')?.blocks, ['acme/card'], 'where it may sit');
    assert.equal(byId.get('block:acme/latest')?.picture.from, 'defaults', 'no example: its defaults');
    assert.deepEqual([byId.get('block:core/paragraph')?.by, byId.get('block:core/paragraph')?.owner], ['wordpress', 'core']);
    for (const id of ['block:core/block', 'block:core/legacy-widget', 'block:northwind/hidden']) assert.equal(byId.get(id)?.picture.from, 'none', id);
    assert.match((byId.get('block:core/block')!.picture as { why: string }).why, /synced pattern by reference/);
    const hero = byId.get('pattern:northwind/hero')!;
    assert.deepEqual([hero.by, hero.owner, hero.category, hero.blocks, hero.files, hero.picture.from], ['northwind', 'unknown', 'banner', ['core/cover'], ['wp-content/themes/northwind/patterns/hero.php'], 'as-written']);
    assert.match(lib.hash, /^[0-9a-f]{32}$/);
    assert.equal(out.moved, true, 'a block.json changed, the hash moved');
  });

  test('a piece renders a pattern as written, a dynamic block from its example, and has a static block’s own editor script write its markup', () => {
    const out = run('piece', '/_wanigan/piece/library') as Record<string, [string, string[]]>;
    const [pattern] = out.pattern!;
    assert.match(pattern, /<main class="wanigan-live-piece" data-wanigan-piece="ready" style="padding:24px"><div class="rendered">&lt;!-- wp:paragraph --&gt;&lt;p&gt;Hero/);
    assert.match(pattern, /<!-- head -->.*<body class="wanigan-live-piece error404"><div class="wp-site-blocks">.*<!-- foot -->/s, 'in the theme’s own head and foot');
    assert.match(out.dynamic![0], /data-wanigan-piece="ready" style="padding:24px"><div class="rendered">&lt;!-- wp:acme\/latest \{&quot;count&quot;:3\} \/--&gt;/, 'core renders a dynamic block from its example’s attributes');
    const [serializing, scripts] = out.static!;
    assert.match(serializing, /data-wanigan-piece="serializing"/);
    assert.match(serializing, /<form id="wanigan-live-serialize" method="post" action="\/_wanigan\/piece\/library" hidden>/);
    assert.match(serializing, /wp\.blocks\.serialize\(\[make\(\{"name":"acme\/card","attributes":\{"heading":"Spring sale","className":"is-style-outline"\},"innerBlocks":\[\{"name":"core\/paragraph","attributes":\{"content":"Inside"\},"innerBlocks":\[\]\}\]\}\)\]\)/, 'the example with the style’s class, a malformed inner block left out');
    assert.deepEqual(scripts, ['wp-blocks', 'wp-block-library', 'acme-card-editor'], 'core’s block library and the block’s own editor script');
    assert.match(out.posted![0], /data-wanigan-piece="ready" style="padding:24px"><div class="rendered">&lt;!-- wp:acme\/card \{&quot;heading&quot;:&quot;Spring sale&quot;\} --&gt;&lt;h3&gt;Spring sale/, 'the markup posted back is rendered by core');
    assert.match(out.other![0], /data-wanigan-piece="failed".*The markup sent back is not this block\./s, 'only the block asked for is rendered');
    assert.match(out.reference![0], /data-wanigan-piece="failed".*synced pattern by reference/s);
    assert.match(out.missing![0], /data-wanigan-piece="failed".*not registered any more/s);
    assert.deepEqual(out.fields, { type: 'post_type', parent: 0, menu_order: 1, object: 'page', object_id: 12, menus: 3, title: 'About' });
    assert.deepEqual(out.custom, { type: 'custom', url: 'https://example.test/docs', title: 'Docs' });
  });
});
