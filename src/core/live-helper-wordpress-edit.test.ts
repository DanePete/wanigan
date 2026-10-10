// The WordPress helper's edit targets under a stand-in WordPress: what each
// part of a page offers to change, and what saving it writes, through the same
// core routes the helper uses on a real site (the REST controllers, called with
// rest_do_request()). The plugin is the real file Wanigan writes; the WordPress
// around it is made up here in core's shape: a block parser and serializer, the
// HTML API's processor and the block processor reduced to what the helper
// calls, WP_Block::render() with its hooks, and REST routes that record what
// they were asked and change the made-up site as core would. The site's words
// are made up (acme, northwind). Nothing here touches a site; it needs PHP.
//
// What it cannot prove: how the block editor reads what was written (whether
// it calls a spliced block valid). That needs the block editor itself.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { wordpressHelper } from './live-helper-wordpress.ts';
import { parseTrace, type EditTarget } from '../shared/live-trace.ts';

const TOKEN = '9a'.repeat(24);

const php = ((): string | null => {
  try { execFileSync('php', ['-v'], { stdio: 'ignore' }); return 'php'; } catch { return null; }
})();

const HARNESS = String.raw`<?php
define('ABSPATH', getenv('WL_SITE') . '/');
define('WPINC', 'wp-includes');
define('WP_CONTENT_DIR', ABSPATH . 'wp-content');
define('WP_PLUGIN_DIR', WP_CONTENT_DIR . '/plugins');
define('WPMU_PLUGIN_DIR', WP_CONTENT_DIR . '/mu-plugins');
$S = json_decode((string) file_get_contents(getenv('WL_SCENARIO')), true);
$GLOBALS['wl'] = array('transients' => array(), 'rest' => array(), 'next' => 900, 'posts' => array(), 'meta' => array(), 'revisions' => array(), 'options' => array(), 'templates' => array('wp_template' => array(), 'wp_template_part' => array()));
$GLOBALS['wp_current_filter'] = array();
$GLOBALS['wp_actions'] = array();
$GLOBALS['wp_filter'] = array();
final class WlSent extends Exception { public $data; public $status; public function __construct($d, $s) { parent::__construct('sent'); $this->data = $d; $this->status = $s; } }

/* plugin.php, as far as the helper needs it */
function add_action() { return true; }
function add_filter() { return true; }
function remove_action() { return true; }
function remove_filter() { return true; }
function has_filter() { return false; }
function current_filter() { return end($GLOBALS['wp_current_filter']); }
function current_action() { return current_filter(); }
function doing_action($h = null) { return in_array($h, $GLOBALS['wp_current_filter'], true); }
function did_action($h) { return $GLOBALS['wp_actions'][$h] ?? 0; }
/** apply_filters(): the 'all' hook first, then the core callbacks this stand-in needs, then the helper's closers at PHP_INT_MAX. */
function apply_filters($hook, $value, ...$args) {
  $GLOBALS['wp_current_filter'][] = $hook;
  Wanigan_Live::all($hook, $value, ...$args);
  $closers = array('the_content' => 'content_end', 'pre_render_block' => 'pre_render_end', 'block_bindings_source_value' => 'binding', 'dynamic_sidebar_params' => 'widget_marks', 'the_title' => 'single_end', 'post_thumbnail_html' => 'single_end');
  if ($hook === 'the_content') $value = do_blocks($value);
  if (strpos($hook, 'render_block_') === 0 && $hook !== 'render_block_data' && $hook !== 'render_block_context') $value = Wanigan_Live::block_end($value, ...$args);
  elseif (isset($closers[$hook])) $value = call_user_func(array('Wanigan_Live', $closers[$hook]), $value, ...$args);
  array_pop($GLOBALS['wp_current_filter']);
  return $value;
}
function do_action($hook, ...$args) {
  $GLOBALS['wp_actions'][$hook] = ($GLOBALS['wp_actions'][$hook] ?? 0) + 1;
  $GLOBALS['wp_current_filter'][] = $hook;
  Wanigan_Live::all($hook, ...$args);
  $handlers = array('wp_before_include_template' => 'main_start', 'wp_head' => 'block_template_end', 'wp_body_open' => 'block_template_begin_mark', 'wp_footer' => 'block_template_end_mark', 'render_block_core_template_part_file' => 'template_part_source', 'render_block_core_template_part_post' => 'template_part_source', 'dynamic_sidebar_before' => 'sidebar_start', 'dynamic_sidebar' => 'widget_start', 'dynamic_sidebar_after' => 'sidebar_end');
  if (isset($handlers[$hook])) call_user_func_array(array('Wanigan_Live', $handlers[$hook]), $args);
  array_pop($GLOBALS['wp_current_filter']);
}

/* the rest of core the helper calls, made up */
function wp_parse_url($u, $c = -1) { return parse_url($u, $c); }
function wp_normalize_path($p) { return str_replace(chr(92), '/', $p); }
function untrailingslashit($s) { return rtrim($s, '/'); }
function trailingslashit($s) { return rtrim($s, '/') . '/'; }
function is_admin() { return false; }
function wp_doing_ajax() { return false; }
function wp_doing_cron() { return false; }
function is_feed() { return false; }
function is_robots() { return false; }
function is_favicon() { return false; }
function is_trackback() { return false; }
function nocache_headers() {}
function status_header() {}
function wp_send_json($data, $status = 200) { throw new WlSent($data, $status); }
function wp_json_encode($v, $f = 0) { return json_encode($v, $f); }
function wp_strip_all_tags($s) { return trim(strip_tags((string) $s)); }
function esc_attr($s) { return htmlspecialchars((string) $s, ENT_QUOTES); }
function esc_html($s) { return htmlspecialchars((string) $s, ENT_QUOTES); }
function admin_url($p = '') { return '/wp-admin/' . $p; }
function home_url($p = '') { return 'https://acme.example.test' . $p; }
function wp_is_numeric_array($a) { return is_array($a) && array_keys($a) === range(0, count($a) - 1); }
function wp_slash($v) { return $v; }
function wp_unslash($v) { return $v; }
function wp_hash($data, $scheme = 'auth') { return hash_hmac('md5', $data, 'wl-stand-in-salt'); }
function get_option($k, $d = false) { return $GLOBALS['wl']['options'][$k] ?? $d; }
function update_option($k, $v) { $GLOBALS['wl']['options'][$k] = $v; return true; }
function get_transient($k) { return $GLOBALS['wl']['transients'][$k] ?? false; }
function set_transient($k, $v) { $GLOBALS['wl']['transients'][$k] = $v; return true; }
function delete_transient($k) { unset($GLOBALS['wl']['transients'][$k]); return true; }
function get_site_transient($k) { return false; }
function get_current_user_id() { return 1; }
function is_user_logged_in() { return true; }
/** The scenario's 'cannot' lists capabilities the user lacks, as "cap" or "cap:object". */
function current_user_can($cap, ...$args) {
  $no = $GLOBALS['S']['cannot'] ?? array();
  return !in_array($cap, $no, true) && !($args && in_array($cap . ':' . implode(':', $args), $no, true));
}
function wp_get_current_user() { return new class { public $display_name = 'editor'; public $user_login = 'editor'; public $roles = array('editor'); public function exists() { return true; } }; }
function get_userdata($id) { return (object) array('display_name' => 'editor'); }
function get_theme_root() { return WP_CONTENT_DIR . '/themes'; }
function get_stylesheet() { return 'northwind'; }
function get_template() { return 'northwind'; }
function get_stylesheet_directory() { return WP_CONTENT_DIR . '/themes/northwind'; }
function get_template_directory() { return WP_CONTENT_DIR . '/themes/northwind'; }
function is_child_theme() { return false; }
function wp_is_block_theme() { return true; }
function wp_get_theme($s = null) { return new class { public function get($k) { return 'Northwind'; } public function get_block_patterns() { return array(); } }; }
function get_queried_object() { return get_post($GLOBALS['S']['post'] ?? 7); }
function wp_scripts() { return new WlDeps(); }
function wp_styles() { return new WlDeps(); }
final class WlDeps { public $done = array(); public $queue = array(); public $registered = array(); public function get_data($h, $k) { return false; } }

/* posts and meta */
final class WP_Post {
  public $ID; public $post_type = 'page'; public $post_title = ''; public $post_content = ''; public $post_excerpt = ''; public $post_status = 'publish'; public $post_name = '';
  public $post_author = 1; public $post_date = ''; public $post_modified = ''; public $post_modified_gmt = ''; public $post_parent = 0; public $menu_order = 0; public $post_password = '';
  public function __construct(array $f) { foreach ($f as $k => $v) $this->$k = $v; }
}
final class WP_Term { public $term_id; public $name; public $taxonomy = 'nav_menu'; }
function get_post($id = null) {
  if ($id === null) return $GLOBALS['post'] ?? null;
  if ($id instanceof WP_Post) return $id;
  return $GLOBALS['wl']['posts'][(int) $id] ?? null;
}
function get_post_field($f, $id, $c = 'display') { $p = get_post($id); return $p ? $p->$f : ''; }
function get_post_status($p) { return $p->post_status; }
function get_the_title($p = 0) { $p = get_post($p ?: null); return $p ? $p->post_title : ''; }
function get_post_type_object($t) {
  $names = array('page' => 'Page', 'post' => 'Post', 'wp_block' => 'Pattern', 'wp_navigation' => 'Navigation Menu', 'attachment' => 'Media');
  return (object) array('labels' => (object) array('singular_name' => $names[$t] ?? ucfirst($t)));
}
function rest_get_route_for_post($p) {
  $bases = array('page' => 'pages', 'post' => 'posts', 'wp_block' => 'blocks', 'wp_navigation' => 'navigation', 'attachment' => 'media');
  return isset($bases[$p->post_type]) ? '/wp/v2/' . $bases[$p->post_type] . '/' . $p->ID : '';
}
function post_type_supports($t, $f) { return !in_array($t . ':' . $f, $GLOBALS['S']['unsupported'] ?? array(), true); }
function wp_revisions_enabled($p) { return true; }
function get_post_thumbnail_id($p) { $p = get_post($p); return $p ? (int) ($GLOBALS['wl']['meta'][$p->ID]['_thumbnail_id'] ?? 0) : 0; }
function get_attached_file($id) { return '/uploads/image-' . $id . '.jpg'; }
function get_edit_post_link($id, $c = '') { return '/wp-admin/post.php?post=' . $id . '&action=edit'; }
function use_block_editor_for_post($p) { return true; }
function get_page_template_slug($p) { return ''; }
function get_post_meta($id, $key = '', $single = false) {
  $all = $GLOBALS['wl']['meta'][(int) $id] ?? array();
  if ($key === '') return array_map(function ($v) { return array($v); }, $all);
  return $all[$key] ?? '';
}
function is_protected_meta($k, $t = 'post') { return isset($k[0]) && $k[0] === '_'; }
function get_registered_meta_keys($type, $sub = '') { return $sub === '' ? array() : ($GLOBALS['S']['registered'][$sub] ?? array()); }
function wp_get_post_revisions($id, $a = array()) {
  $list = array_reverse($GLOBALS['wl']['revisions'][(int) $id] ?? array());
  return ($a['fields'] ?? '') === 'ids' ? array_map(function ($r) { return $r->ID; }, $list) : $list;
}
function wp_is_post_autosave($r) { return false; }
function get_block_template($id, $type = 'wp_template') { return isset($GLOBALS['wl']['templates'][$type][$id]) ? (object) $GLOBALS['wl']['templates'][$type][$id] : null; }
function _get_block_template_file($type, $slug) { return null; }
/** WP_REST_Post_Meta_Fields: the registered keys shown in REST, with register_meta()'s schema. */
final class WP_REST_Post_Meta_Fields {
  private $type;
  public function __construct($type) { $this->type = $type; }
  public function get_field_schema() {
    $props = array();
    foreach (get_registered_meta_keys('post', $this->type) as $key => $args) if (!empty($args['show_in_rest'])) $props[$key] = array('type' => $args['type'] ?? 'string', 'description' => $args['description'] ?? '');
    return array('type' => 'object', 'properties' => $props);
  }
  public function get_value($id, $request) {
    $out = array();
    foreach (get_registered_meta_keys('post', $this->type) as $key => $args) if (!empty($args['show_in_rest'])) $out[$key] = get_post_meta($id, $key, true);
    return $out;
  }
}
final class WP_REST_Request {
  public $method; public $route; public $params = array();
  public function __construct($m = 'GET', $r = '') { $this->method = $m; $this->route = $r; }
  public function set_query_params($p) { $this->params = $p; }
  public function set_body_params($p) { $this->params = $p; }
}
final class WP_Error { private $m; private $d; public function __construct($c = '', $m = '', $d = null) { $this->m = $m; $this->d = $d; } public function get_error_message() { return $this->m; } public function get_error_data() { return $this->d; } }
function is_wp_error($v) { return $v instanceof WP_Error; }
function rest_validate_value_from_schema($v, $schema, $param = '') {
  $t = $schema['type'] ?? null;
  if ($t === 'object' && !is_array($v)) return new WP_Error('rest_invalid_type', $param . ' is not of type object.');
  if ($t === 'string' && !is_string($v)) return new WP_Error('rest_invalid_type', $param . ' is not of type string.');
  if ($t === 'object' && isset($schema['properties'])) {
    foreach ($v as $k => $x) {
      if (!isset($schema['properties'][$k]) && isset($schema['additionalProperties']) && $schema['additionalProperties'] === false) return new WP_Error('rest_additional_properties_forbidden', $k . ' is not a valid property of Object.');
    }
  }
  return true;
}
function rest_sanitize_value_from_schema($v, $schema, $param = '') { return $v; }

/* REST routes, recording what they were asked and changing the site as core's controllers do */
final class WlResponse {
  private $d; private $e;
  public function __construct($d, $e = null) { $this->d = $d; $this->e = $e; }
  public function is_error() { return $this->e !== null; }
  public function as_error() { return new WP_Error('rest', $this->e); }
  public function get_data() { return $this->d; }
}
function wl_revision($id) { $GLOBALS['wl']['revisions'][$id][] = new WP_Post(array('ID' => ++$GLOBALS['wl']['next'], 'post_author' => 1, 'post_modified_gmt' => '2026-10-09 12:00:00')); }
function rest_do_request($r) {
  $GLOBALS['wl']['rest'][] = array($r->method, $r->route, $r->params);
  $wl = &$GLOBALS['wl'];
  $p = $r->params;
  if ($r->method === 'POST' && preg_match('#^/wp/v2/(pages|posts|blocks|navigation)/(\d+)$#', $r->route, $m)) {
    $post = get_post((int) $m[2]);
    if (!$post) return new WlResponse(null, 'Invalid post ID.');
    if (isset($p['content'])) $post->post_content = $p['content'];
    if (isset($p['title'])) $post->post_title = $p['title'];
    // WP_REST_Meta_Fields: only registered keys shown in REST, only for a type that supports custom fields.
    if (isset($p['meta']) && post_type_supports($post->post_type, 'custom-fields')) {
      foreach ($p['meta'] as $k => $v) {
        $reg = get_registered_meta_keys('post', $post->post_type);
        if (empty($reg[$k]['show_in_rest'])) continue;
        if (!current_user_can('edit_post_meta', $post->ID, $k)) return new WlResponse(null, 'Sorry, you are not allowed to edit the ' . $k . ' custom field.');
        $wl['meta'][$post->ID][$k] = $v;
      }
    }
    if (isset($p['content']) || isset($p['title'])) wl_revision($post->ID);
    return new WlResponse(array('id' => $post->ID));
  }
  if ($r->method === 'POST' && preg_match('#^/wp/v2/(templates|template-parts)/(.+)$#', $r->route, $m)) {
    $type = $m[1] === 'templates' ? 'wp_template' : 'wp_template_part';
    if (!isset($wl['templates'][$type][$m[2]])) return new WlResponse(null, 'No template exists with that id.');
    $t = &$wl['templates'][$type][$m[2]];
    $t['content'] = $p['content'];
    // A theme's file stays as it is: the first save makes the database copy the Site Editor makes.
    if (empty($t['wp_id'])) { $t['wp_id'] = ++$wl['next']; $t['source'] = 'custom'; $wl['posts'][$t['wp_id']] = new WP_Post(array('ID' => $t['wp_id'], 'post_type' => $type, 'post_content' => $p['content'])); }
    wl_revision($t['wp_id']);
    return new WlResponse(array('id' => $m[2], 'wp_id' => $t['wp_id']));
  }
  if ($r->method === 'POST' && preg_match('#^/wp/v2/media/(\d+)$#', $r->route, $m)) {
    if (array_key_exists('alt_text', $p)) $wl['meta'][(int) $m[1]]['_wp_attachment_image_alt'] = $p['alt_text'];
    return new WlResponse(array('id' => (int) $m[1]));
  }
  if ($r->method === 'POST' && preg_match('#^/wp/v2/widgets/(.+)$#', $r->route, $m)) return wl_save_widget($m[1], $p);
  if ($r->method === 'POST' && $r->route === '/wp/v2/settings') { foreach ($p as $k => $v) $wl['options'][$k === 'title' ? 'blogname' : 'blogdescription'] = $v; return new WlResponse($p); }
  return new WlResponse(null, 'No route was found matching the URL and request method.');
}
/** class-wp-rest-widgets-controller.php save_widget(): raw only with show_instance_in_rest, encoded only with its hash, then the widget's own update(). */
function wl_save_widget($id, $p) {
  global $wp_registered_widgets, $wp_registered_widget_updates;
  $parsed = wp_parse_widget_id($id);
  if (!isset($wp_registered_widget_updates[$parsed['id_base']])) return new WlResponse(null, 'The provided widget type (id_base) cannot be updated.');
  $widget = $wp_registered_widgets[$id]['callback'][0] ?? null;
  if (!$widget instanceof WP_Widget) return new WlResponse(null, 'Cannot set instance on a widget that does not extend WP_Widget.');
  if (isset($p['instance']['raw'])) {
    if (empty($widget->widget_options['show_instance_in_rest'])) return new WlResponse(null, 'Widget type does not support raw instances.');
    $instance = $p['instance']['raw'];
  } elseif (isset($p['instance']['encoded'], $p['instance']['hash'])) {
    $serialized = base64_decode($p['instance']['encoded']);
    if (!hash_equals(wp_hash($serialized), $p['instance']['hash'])) return new WlResponse(null, 'The provided instance is malformed.');
    $instance = unserialize($serialized);
  } else {
    return new WlResponse(null, 'The provided instance is invalid. Must contain raw OR encoded and hash.');
  }
  $all = $widget->get_settings();
  $all[$parsed['number']] = $widget->update($instance, $all[$parsed['number']] ?? array());
  $GLOBALS['wl']['options']['widget_' . $parsed['id_base']] = $all;
  return new WlResponse(array('id' => $id));
}
function wp_parse_widget_id($id) { return preg_match('/^(.+)-(\d+)$/', $id, $m) ? array('id_base' => $m[1], 'number' => (int) $m[2]) : array('id_base' => $id); }
function wp_get_sidebars_widgets() { return $GLOBALS['wl']['options']['sidebars_widgets'] ?? array(); }
/** WP_Widget: settings in the widget_{id_base} option; the Text widget's update() cleans its text as core's does for a user without unfiltered_html. */
class WP_Widget {
  public $id_base; public $name; public $widget_options = array();
  public function __construct($id_base, $name, $options = array()) { $this->id_base = $id_base; $this->name = $name; $this->widget_options = $options; }
  public function get_settings() { return $GLOBALS['wl']['options']['widget_' . $this->id_base] ?? array(); }
  public function update($new, $old) { return $new; }
  public function widget($args, $instance) {}
}
final class WL_Text_Widget extends WP_Widget {
  public function update($new, $old) { $new['title'] = wp_strip_all_tags($new['title'] ?? ''); $new['text'] = wp_kses_post($new['text'] ?? ''); return $new; }
}
function wl_widget_display($id) { return '<p>' . $id . '</p>'; }

/* blocks.php, in core's shape: delimiters, inner content with null placeholders, core/ dropped when written */
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
function serialize_block_attributes($a) { return strtr(json_encode($a, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), array('\\\\' => '\\u005c', '--' => '\\u002d\\u002d', '<' => '\\u003c', '>' => '\\u003e', '&' => '\\u0026', '\\"' => '\\u0022')); }
function strip_core_block_namespace($n = null) { return is_string($n) && strpos($n, 'core/') === 0 ? substr($n, 5) : $n; }
function get_comment_delimited_block_content($name, $attrs, $content) {
  if ($name === null) return $content;
  $s = strip_core_block_namespace($name);
  $a = empty($attrs) ? '' : serialize_block_attributes($attrs) . ' ';
  return empty($content) ? "<!-- wp:$s $a/-->" : "<!-- wp:$s $a-->" . $content . "<!-- /wp:$s -->";
}
function serialize_block($b) {
  $content = ''; $i = 0;
  foreach ($b['innerContent'] as $chunk) $content .= is_string($chunk) ? $chunk : serialize_block($b['innerBlocks'][$i++]);
  return get_comment_delimited_block_content($b['blockName'], is_array($b['attrs']) ? $b['attrs'] : array(), $content);
}
function serialize_blocks($bs) { return implode('', array_map('serialize_block', $bs)); }
function get_block_bindings_supported_attributes($name) {
  $list = array('core/paragraph' => array('content'), 'core/heading' => array('content'), 'core/list-item' => array('content'), 'core/image' => array('id', 'url', 'title', 'alt', 'caption'), 'core/button' => array('url', 'text', 'linkTarget', 'rel'));
  return $list[$name] ?? array();
}

/* class-wp-block-processor.php (6.9), reduced: tokens with core's depth rule (up before an opener, a void block or an HTML span, down before a closer) and byte spans */
final class WP_Block_Processor {
  const OPENER = 'opener'; const CLOSER = 'closer'; const VOID = 'void';
  private $tokens = array(); private $at = -1;
  public function __construct(string $text) {
    preg_match_all(WL_DELIM, $text, $m, PREG_OFFSET_CAPTURE | PREG_SET_ORDER);
    $depth = 0; $pos = 0;
    foreach ($m as $d) {
      $at = $d[0][1];
      if ($at > $pos) $this->tokens[] = array('html', $pos, $at - $pos, $depth + 1);
      $len = strlen($d[0][0]);
      if ($d[1][0] === '/') { $depth--; $this->tokens[] = array(self::CLOSER, $at, $len, $depth); }
      elseif (isset($d[4]) && $d[4][0] === '/') $this->tokens[] = array(self::VOID, $at, $len, $depth + 1);
      else { $depth++; $this->tokens[] = array(self::OPENER, $at, $len, $depth); }
      $pos = $at + $len;
    }
    if ($pos < strlen($text)) $this->tokens[] = array('html', $pos, strlen($text) - $pos, $depth + 1);
  }
  public function next_token(): bool { return ++$this->at < count($this->tokens); }
  public function get_depth(): int { return $this->tokens[$this->at][3]; }
  public function is_html(): bool { return $this->tokens[$this->at][0] === 'html'; }
  public function get_delimiter_type(): ?string { return $this->is_html() ? null : $this->tokens[$this->at][0]; }
  public function get_span() { $t = $this->tokens[$this->at]; return new WP_HTML_Span($t[1], $t[2]); }
  public function get_last_error(): ?string { return null; }
}

/* html-api, reduced: the tag processor and WP_HTML_Processor over well-formed markup, with core's depths, bookmarks and serialization */
final class WP_HTML_Span { public $start; public $length; public function __construct($s, $l) { $this->start = $s; $this->length = $l; } }
class WP_HTML_Tag_Processor {
  const VOIDS = array('AREA', 'BASE', 'BR', 'COL', 'EMBED', 'HR', 'IMG', 'INPUT', 'LINK', 'META', 'SOURCE', 'TRACK', 'WBR');
  protected $bookmarks = array();
  private $wl_html = ''; private $wl_tokens = array(); private $wl_at = -1; private $wl_updates = array();
  public function __construct($html) { $this->wl_read((string) $html); }
  protected function wl_read(string $html): void {
    $this->wl_html = $html;
    $this->wl_tokens = array();
    preg_match_all('#<!--.*?-->|</?([A-Za-z][A-Za-z0-9-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|\'[^\']*\'|[^\s>]+))?)*)\s*/?>#s', $html, $m, PREG_OFFSET_CAPTURE | PREG_SET_ORDER);
    $open = array(); $pos = 0;
    foreach ($m as $t) {
      $at = $t[0][1];
      if ($at > $pos) $this->wl_tokens[] = array('type' => '#text', 'start' => $pos, 'length' => $at - $pos, 'depth' => count($open) + 3);
      $raw = $t[0][0];
      if (strpos($raw, '<!--') === 0) $this->wl_tokens[] = array('type' => '#comment', 'start' => $at, 'length' => strlen($raw), 'depth' => count($open) + 3);
      elseif ($raw[1] === '/') {
        $name = strtoupper($t[1][0]);
        $i = array_search($name, array_reverse($open, true), true);
        if ($i !== false) array_splice($open, $i);
        $this->wl_tokens[] = array('type' => '#tag', 'name' => $name, 'closer' => true, 'stray' => $i === false, 'start' => $at, 'length' => strlen($raw), 'depth' => count($open) + 2);
      } else {
        $name = strtoupper($t[1][0]);
        $void = in_array($name, self::VOIDS, true);
        preg_match_all('/([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|\'([^\']*)\'|([^\s>]+)))?/', $t[2][0] ?? '', $am, PREG_SET_ORDER);
        $attrs = array();
        foreach ($am as $a) $attrs[strtolower($a[1])] = isset($a[2]) ? html_entity_decode($a[2] . ($a[3] ?? '') . ($a[4] ?? ''), ENT_QUOTES | ENT_HTML5) : true;
        if (!$void) $open[] = $name;
        $this->wl_tokens[] = array('type' => '#tag', 'name' => $name, 'closer' => false, 'void' => $void, 'attrs' => $attrs, 'start' => $at, 'length' => strlen($raw), 'depth' => count($open) + ($void ? 3 : 2));
      }
      $pos = $at + strlen($raw);
    }
    if ($pos < strlen($html)) $this->wl_tokens[] = array('type' => '#text', 'start' => $pos, 'length' => strlen($html) - $pos, 'depth' => count($open) + 3);
  }
  private function wl_t() { return $this->wl_tokens[$this->wl_at] ?? null; }
  public function next_token(): bool { return ++$this->wl_at < count($this->wl_tokens); }
  public function next_tag($query = null): bool { while ($this->next_token()) { $t = $this->wl_t(); if ($t['type'] === '#tag' && !$t['closer']) return true; } return false; }
  public function get_token_type(): ?string { $t = $this->wl_t(); return $t ? $t['type'] : null; }
  public function get_token_name(): ?string { $t = $this->wl_t(); return $t ? ($t['type'] === '#tag' ? $t['name'] : $t['type']) : null; }
  public function get_tag(): ?string { $t = $this->wl_t(); return $t && $t['type'] === '#tag' ? $t['name'] : null; }
  public function is_tag_closer(): bool { $t = $this->wl_t(); return $t && $t['type'] === '#tag' && $t['closer']; }
  public function expects_closer($node = null): ?bool { $t = $this->wl_t(); return $t ? ($t['type'] === '#tag' && !$t['closer'] && !$t['void']) : null; }
  public function get_current_depth(): int { $t = $this->wl_t(); return $t ? $t['depth'] : 0; }
  public function get_last_error(): ?string { return null; }
  public function set_bookmark($name): bool { $t = $this->wl_t(); if (!$t) return false; $this->bookmarks['_' . $name] = new WP_HTML_Span($t['start'], $t['length']); return true; }
  public function has_class($c): ?bool { $t = $this->wl_t(); return in_array($c, preg_split('/\s+/', (string) ($t['attrs']['class'] ?? '')), true); }
  public function get_attribute($n) { $t = $this->wl_t(); return $t['attrs'][strtolower($n)] ?? null; }
  public function get_modifiable_text(): string { $t = $this->wl_t(); return $t && $t['type'] === '#text' ? html_entity_decode(substr($this->wl_html, $t['start'], $t['length']), ENT_QUOTES | ENT_HTML5) : ''; }
  public function set_modifiable_text(string $text): bool { $t = $this->wl_t(); $this->wl_updates[$t['start']] = array($t['length'], htmlspecialchars($text, ENT_QUOTES | ENT_HTML5)); return true; }
  public function set_attribute($n, $v): bool {
    $t = $this->wl_t();
    $t['attrs'][strtolower($n)] = $v;
    $this->wl_updates[$t['start']] = array($t['length'], self::wl_opener($t['name'], $t['attrs']));
    return true;
  }
  public function get_updated_html(): string {
    $html = $this->wl_html;
    krsort($this->wl_updates);
    foreach ($this->wl_updates as $at => $u) $html = substr($html, 0, $at) . $u[1] . substr($html, $at + $u[0]);
    return $html;
  }
  private static function wl_opener($name, $attrs) {
    $out = '<' . strtolower($name);
    foreach ($attrs as $k => $v) $out .= $v === true ? ' ' . $k : ' ' . $k . '="' . htmlspecialchars((string) $v, ENT_QUOTES | ENT_HTML5) . '"';
    return $out . '>';
  }
  public function serialize(): ?string {
    $out = ''; $open = array();
    foreach ($this->wl_tokens as $t) {
      if ($t['type'] === '#text') $out .= htmlspecialchars(html_entity_decode(substr($this->wl_html, $t['start'], $t['length']), ENT_QUOTES | ENT_HTML5), ENT_QUOTES | ENT_HTML5);
      elseif ($t['type'] === '#comment') $out .= substr($this->wl_html, $t['start'], $t['length']);
      elseif ($t['closer']) { if (!$t['stray']) { $out .= '</' . strtolower($t['name']) . '>'; array_pop($open); } }
      else { $out .= self::wl_opener($t['name'], $t['attrs']); if (!$t['void']) $open[] = $t['name']; }
    }
    while ($open) $out .= '</' . strtolower(array_pop($open)) . '>';
    return $out;
  }
}
class WP_HTML_Processor extends WP_HTML_Tag_Processor {
  const CONSTRUCTOR_UNLOCK_CODE = 'Use WP_HTML_Processor::create_fragment() instead of calling the class constructor directly.';
  public function __construct($html, $unlock = null) { parent::__construct($html); }
  public static function create_fragment($html, $context = '<body>', $encoding = 'UTF-8') { $p = new static('', self::CONSTRUCTOR_UNLOCK_CODE); $p->wl_read((string) $html); return $p; }
  public static function normalize(string $html): ?string { return static::create_fragment($html)->serialize(); }
}
/** kses.php wp_kses_post(), reduced to what these tests send it: no scripts, no event handlers. */
function wp_kses_post($s) {
  $s = preg_replace('#<(script|style|iframe)\b[^>]*>.*?</\1>#is', '', (string) $s);
  return preg_replace('#\s+on[a-z]+\s*=\s*("[^"]*"|\'[^\']*\'|[^\s>]+)#i', '', $s);
}

/* block types and WP_Block::render(), as class-wp-block.php runs it */
final class WP_Block_Type {
  public $name; public $title = ''; public $description = ''; public $attributes = array(); public $parent = null; public $ancestor = null; public $supports = array();
  public $allowed_blocks = null; public $provides_context = null; public $render_callback = null;
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
  public static function get_instance() { return new self(); }
  public function get_all_registered() { return array(); }
  public function is_registered($n) { return isset($GLOBALS['S']['patterns'][$n]); }
  public function get_registered($n) { return array('name' => $n, 'content' => $GLOBALS['S']['patterns'][$n]); }
}
final class WP_Block {
  public $name; public $parsed_block; public $attributes; public $context = array(); public $block_type; public $inner_blocks = array(); public $inner_content = array();
  public function __construct($parsed, $context = array()) {
    $this->parsed_block = $parsed;
    $this->context = $context;
    $this->refresh();
  }
  private function refresh() {
    $this->name = $this->parsed_block['blockName'];
    $this->attributes = $this->parsed_block['attrs'];
    $this->inner_content = $this->parsed_block['innerContent'];
    $this->block_type = $this->name ? WP_Block_Type_Registry::get_instance()->get_registered($this->name) : null;
    $ctx = $this->context;
    // core/block provides pattern/overrides to the blocks of its synced pattern.
    if ($this->name === 'core/block') $ctx['pattern/overrides'] = $this->attributes['content'] ?? array();
    $this->inner_blocks = array();
    foreach ($this->parsed_block['innerBlocks'] as $inner) $this->inner_blocks[] = new WP_Block($inner, $ctx);
  }
  public function refresh_context_dependents() { $this->refresh(); }
  /** process_block_bindings(): each bound attribute's value from its source, through block_bindings_source_value. */
  private function bindings() {
    $out = array();
    foreach ($this->attributes['metadata']['bindings'] ?? array() as $attr => $b) {
      $source = $b['source'] ?? '';
      $args = $b['args'] ?? array();
      if ($attr === '__default') continue;
      $value = null;
      if ($source === 'core/post-meta') {
        $reg = get_registered_meta_keys('post', get_post($this->context['postId'])->post_type);
        if (!is_protected_meta($args['key']) && !empty($reg[$args['key']]['show_in_rest'])) $value = get_post_meta($this->context['postId'], $args['key'], true);
      }
      if ($source === 'core/pattern-overrides') $value = $this->context['pattern/overrides'][$this->attributes['metadata']['name'] ?? ''][$attr] ?? null;
      $value = apply_filters('block_bindings_source_value', $value, $source, $args, $this, $attr);
      if ($value !== null) $out[$attr] = $value;
    }
    if (($this->attributes['metadata']['bindings']['__default']['source'] ?? '') === 'core/pattern-overrides') {
      foreach (get_block_bindings_supported_attributes($this->name) as $attr) {
        $value = apply_filters('block_bindings_source_value', $this->context['pattern/overrides'][$this->attributes['metadata']['name'] ?? ''][$attr] ?? null, 'core/pattern-overrides', array(), $this, $attr);
        if ($value !== null) $out[$attr] = $value;
      }
    }
    return $out;
  }
  public function render($options = array()) {
    apply_filters('interactivity_process_directives', true);
    $this->bindings();
    $content = '';
    $i = 0;
    foreach ($this->inner_content as $chunk) {
      if (is_string($chunk)) { $content .= $chunk; continue; }
      $inner = $this->inner_blocks[$i++];
      $pre = apply_filters('pre_render_block', null, $inner->parsed_block, $this);
      $content .= $pre === null ? $inner->render() : $pre;
    }
    if (($options['dynamic'] ?? true) && $this->block_type && $this->block_type->is_dynamic()) $content = call_user_func($this->block_type->render_callback, $this->attributes, $content, $this);
    $content = apply_filters('render_block', $content, $this->parsed_block, $this);
    return apply_filters('render_block_' . $this->name, $content, $this->parsed_block, $this);
  }
}
function wl_context() { $p = get_post(); return $p ? array('postId' => $p->ID, 'postType' => $p->post_type) : array(); }
function render_block($parsed) {
  $pre = apply_filters('pre_render_block', null, $parsed, null);
  return $pre !== null ? $pre : (new WP_Block($parsed, wl_context()))->render();
}
function do_blocks($content) { $out = ''; foreach (parse_blocks($content) as $b) $out .= render_block($b); return $out; }

/* dynamic blocks, as core's render callbacks reach the hooks the helper reads */
function render_block_core_template_part($a) {
  $id = $a['theme'] . '//' . $a['slug'];
  $part = get_block_template($id, 'wp_template_part');
  if (!empty($part->wp_id)) do_action('render_block_core_template_part_post', $id, $a, get_post($part->wp_id), $part->content);
  else do_action('render_block_core_template_part_file', $id, $a, WP_CONTENT_DIR . '/themes/northwind/parts/' . $a['slug'] . '.html', $part->content);
  return '<header class="wp-block-template-part">' . do_blocks($part->content) . '</header>';
}
function render_block_core_post_content() { return '<div class="entry-content">' . apply_filters('the_content', get_post()->post_content) . '</div>'; }
/** blocks/block.php (7.1): the synced pattern's blocks become this block's inner blocks, rendered by the same instance. */
function render_block_core_block($a, $content, $block) {
  $ref = get_post($a['ref']);
  if (!$ref || $ref->post_type !== 'wp_block') return '';
  $block->parsed_block['innerBlocks'] = parse_blocks($ref->post_content);
  $block->parsed_block['innerContent'] = array_fill(0, count($block->parsed_block['innerBlocks']), null);
  $block->refresh_context_dependents();
  return $block->render(array('dynamic' => false));
}
/** blocks/pattern.php: a registered pattern's content, rendered from the registry each time. */
function render_block_core_pattern($a) { return do_blocks($GLOBALS['S']['patterns'][$a['slug']] ?? ''); }
/** blocks/navigation.php: a wp_navigation post's blocks (empty ones dropped), or a fallback, each rendered directly. */
function render_block_core_navigation($a, $content, $block) {
  if (!empty($a['ref'])) {
    $nav = get_post($a['ref']);
    $blocks = $nav && $nav->post_status === 'publish' ? array_values(array_filter(parse_blocks($nav->post_content), function ($b) { return isset($b['blockName']); })) : array();
  } else {
    $blocks = parse_blocks('<!-- wp:navigation-link {"label":"Acme home","url":"/"} /-->');
  }
  $out = '';
  foreach ($blocks as $b) $out .= (new WP_Block($b, $block->context))->render();
  return '<nav class="wp-block-navigation"><ul>' . $out . '</ul></nav>';
}
function render_block_core_navigation_link($a) { return '<li class="wp-block-navigation-item"><a href="' . esc_attr($a['url'] ?? '') . '">' . ($a['label'] ?? '') . '</a></li>'; }
function render_block_core_navigation_submenu($a, $content, $block) {
  $out = '';
  foreach ($block->inner_blocks as $inner) $out .= $inner->render();
  return '<li class="wp-block-navigation-submenu">' . ($a['label'] ?? '') . '<ul>' . $out . '</ul></li>';
}
function render_block_core_image($a, $content) { return $content; }
function render_block_core_post_featured_image($a, $content, $block) { $id = get_post_thumbnail_id($block->context['postId']); return $id ? '<figure class="wp-block-post-featured-image"><img src="/uploads/image-' . $id . '.jpg" alt=""></figure>' : ''; }
function render_block_core_site_logo() { return '<div class="wp-block-site-logo"><img src="/uploads/logo.png" alt=""></div>'; }
function get_theme_mod($k, $d = false) { return $GLOBALS['S']['theme_mods'][$k] ?? $d; }

$text = array('type' => 'rich-text', 'source' => 'rich-text', 'role' => 'content');
$dynamic = function ($fn, $extra = array()) { return array('render_callback' => $fn) + $extra; };
WP_Block_Type_Registry::$types = array(
  'core/template-part' => new WP_Block_Type('core/template-part', $dynamic('render_block_core_template_part', array('attributes' => array('slug' => array('type' => 'string'), 'theme' => array('type' => 'string'))))),
  'core/post-content' => new WP_Block_Type('core/post-content', $dynamic('render_block_core_post_content')),
  'core/block' => new WP_Block_Type('core/block', $dynamic('render_block_core_block', array('title' => 'Pattern', 'attributes' => array('ref' => array('type' => 'number'), 'content' => array('type' => 'object', 'default' => array()))))),
  'core/pattern' => new WP_Block_Type('core/pattern', $dynamic('render_block_core_pattern', array('attributes' => array('slug' => array('type' => 'string'))))),
  'core/navigation' => new WP_Block_Type('core/navigation', $dynamic('render_block_core_navigation', array('title' => 'Navigation', 'attributes' => array('ref' => array('type' => 'number'))))),
  'core/navigation-link' => new WP_Block_Type('core/navigation-link', $dynamic('render_block_core_navigation_link', array('title' => 'Custom Link', 'attributes' => array('label' => array('type' => 'string', 'role' => 'content'), 'url' => array('type' => 'string', 'role' => 'content'), 'kind' => array('type' => 'string'))))),
  'core/navigation-submenu' => new WP_Block_Type('core/navigation-submenu', $dynamic('render_block_core_navigation_submenu', array('title' => 'Submenu', 'attributes' => array('label' => array('type' => 'string', 'role' => 'content'), 'url' => array('type' => 'string'))))),
  'core/group' => new WP_Block_Type('core/group', array('title' => 'Group', 'attributes' => array('tagName' => array('type' => 'string', 'default' => 'div')))),
  'core/paragraph' => new WP_Block_Type('core/paragraph', array('title' => 'Paragraph', 'attributes' => array('content' => $text + array('selector' => 'p'), 'dropCap' => array('type' => 'boolean', 'default' => false)))),
  'core/heading' => new WP_Block_Type('core/heading', array('title' => 'Heading', 'attributes' => array('content' => $text + array('selector' => 'h1,h2,h3,h4,h5,h6'), 'level' => array('type' => 'number', 'default' => 2)))),
  'core/list' => new WP_Block_Type('core/list', array('title' => 'List', 'attributes' => array('ordered' => array('type' => 'boolean', 'default' => false)))),
  'core/list-item' => new WP_Block_Type('core/list-item', array('title' => 'List item', 'attributes' => array('content' => $text + array('selector' => 'li')))),
  'core/quote' => new WP_Block_Type('core/quote', array('title' => 'Quote', 'attributes' => array('value' => array('type' => 'string', 'source' => 'html', 'selector' => 'blockquote'), 'citation' => $text + array('selector' => 'cite')))),
  'core/button' => new WP_Block_Type('core/button', array('title' => 'Button', 'attributes' => array('text' => $text + array('selector' => 'a,button'), 'url' => array('type' => 'string', 'source' => 'attribute', 'selector' => 'a', 'attribute' => 'href')))),
  'core/image' => new WP_Block_Type('core/image', $dynamic('render_block_core_image', array('title' => 'Image', 'attributes' => array('id' => array('type' => 'number'), 'url' => array('type' => 'string', 'source' => 'attribute', 'selector' => 'img', 'attribute' => 'src'), 'alt' => array('type' => 'string', 'source' => 'attribute', 'selector' => 'img', 'attribute' => 'alt', 'default' => ''), 'caption' => $text + array('selector' => 'figcaption'))))),
  'core/post-featured-image' => new WP_Block_Type('core/post-featured-image', $dynamic('render_block_core_post_featured_image', array('title' => 'Featured Image', 'attributes' => array('isLink' => array('type' => 'boolean', 'default' => false))))),
  'core/site-logo' => new WP_Block_Type('core/site-logo', $dynamic('render_block_core_site_logo', array('title' => 'Site Logo', 'attributes' => array('width' => array('type' => 'number'))))),
);

/* the made-up site */
foreach ($S['posts'] ?? array() as $id => $p) $GLOBALS['wl']['posts'][(int) $id] = new WP_Post(array('ID' => (int) $id) + $p);
foreach ($S['meta'] ?? array() as $id => $m) $GLOBALS['wl']['meta'][(int) $id] = $m;
foreach ($S['options'] ?? array() as $k => $v) $GLOBALS['wl']['options'][$k] = $v;
foreach ($S['templates'] ?? array() as $type => $list) foreach ($list as $id => $t) $GLOBALS['wl']['templates'][$type][$id] = $t + array('id' => $id, 'slug' => substr($id, strpos($id, '//') + 2), 'title' => ucfirst(substr($id, strpos($id, '//') + 2)), 'source' => 'theme', 'has_theme_file' => true, 'wp_id' => 0);
if (!isset($GLOBALS['wl']['templates']['wp_template']['northwind//page'])) $GLOBALS['wl']['templates']['wp_template']['northwind//page'] = array('id' => 'northwind//page', 'slug' => 'page', 'title' => 'Page', 'source' => 'theme', 'has_theme_file' => true, 'wp_id' => 0, 'content' => '<!-- wp:post-content /-->');
$GLOBALS['wp_registered_sidebars'] = array('sidebar-1' => array('name' => 'Sidebar', 'before_widget' => '<section>', 'after_widget' => '</section>'));
$GLOBALS['wp_registered_widgets'] = array();
$GLOBALS['wp_registered_widget_updates'] = array();
foreach ($S['widgets'] ?? array() as $wid => $w) {
  $parsed = wp_parse_widget_id($wid);
  if ($w['class'] === 'none') $GLOBALS['wp_registered_widgets'][$wid] = array('name' => $w['name'], 'callback' => 'wl_widget_display');
  else {
    $class = $w['class'] === 'text' ? 'WL_Text_Widget' : 'WP_Widget';
    $obj = new $class($parsed['id_base'], $w['name'], $w['options'] ?? array());
    $GLOBALS['wp_registered_widgets'][$wid] = array('name' => $w['name'], 'callback' => array($obj, 'widget'));
  }
  if (!empty($w['update'])) $GLOBALS['wp_registered_widget_updates'][$parsed['id_base']] = array('callback' => 'wl_widget_display', 'params' => array());
}

$_SERVER['REQUEST_URI'] = '/welcome/';
$_SERVER['SCRIPT_FILENAME'] = ABSPATH . 'index.php';
$_SERVER['HTTP_X_WANIGAN_LIVE'] = getenv('WL_TOKEN');
require getenv('WL_PLUGIN');
$GLOBALS['post'] = get_post($S['post'] ?? 7);
$GLOBALS['_wp_current_template_id'] = 'northwind//page';

/* the page: the block template canvas, then a widget area */
do_action('wp');
Wanigan_Live::decide();
Wanigan_Live::$buffer_on = true;
ob_start();
do_action('wp_before_include_template', ABSPATH . WPINC . '/template-canvas.php');
$template = do_blocks(get_block_template('northwind//page')->content);
echo '<!DOCTYPE html><html><head>';
do_action('wp_head');
echo '</head><body>';
do_action('wp_body_open');
echo $template;
do_action('wp_footer');
if (!empty($S['widgets'])) {
  do_action('dynamic_sidebar_before', 'sidebar-1', true);
  foreach (array_keys($S['widgets']) as $wid) {
    $params = apply_filters('dynamic_sidebar_params', array(array_merge($GLOBALS['wp_registered_sidebars']['sidebar-1'], array('widget_id' => $wid, 'widget_name' => $S['widgets'][$wid]['name'])), array()));
    do_action('dynamic_sidebar', $GLOBALS['wp_registered_widgets'][$wid]);
    echo $params[0]['before_widget'] . '<p>' . $wid . '</p>' . $params[0]['after_widget'];
  }
  do_action('dynamic_sidebar_after', 'sidebar-1', true);
}
echo '</body></html>';
Wanigan_Live::assemble();
$html = ob_get_clean();
Wanigan_Live::buffer($html);
Wanigan_Live::flushed();
$id = (new ReflectionProperty('Wanigan_Live', 'id'))->getValue();
$stored = get_transient('wanigan_live_t_1_' . $id);

/* what changed on the site after the page was shown, then each save, as POST /_wanigan/edit/<id> runs it */
foreach ($S['change'] ?? array() as $pid => $c) get_post((int) $pid)->post_content = $c;
$answers = array();
$save = new ReflectionMethod('Wanigan_Live', 'edit_save');
foreach ($S['saves'] ?? array() as $s) {
  $target = null;
  foreach ($stored ? $stored['trace']['edits'] : array() as $e) {
    if (strpos($e['label'], $s['find']) !== false && (!isset($s['kind']) || $e['kind'] === $s['kind'])) { $target = $e['id']; break; }
  }
  if ($target === null) { $answers[] = array('status' => 0, 'data' => array('ok' => false, 'error' => 'no target labelled ' . $s['find'])); continue; }
  try {
    $save->invoke(null, $target, array('trace' => $id, 'value' => $s['value']));
    $answers[] = array('status' => 0, 'data' => array('ok' => false, 'error' => 'no answer'));
  } catch (WlSent $sent) {
    $answers[] = array('status' => $sent->status, 'data' => $sent->data);
  }
}
$posts = array();
foreach ($GLOBALS['wl']['posts'] as $pid => $p) $posts[$pid] = $p->post_content;
echo json_encode(array('trace' => $stored ? $stored['trace'] : null, 'answers' => $answers, 'rest' => $GLOBALS['wl']['rest'], 'posts' => $posts, 'meta' => $GLOBALS['wl']['meta'], 'templates' => $GLOBALS['wl']['templates'], 'options' => $GLOBALS['wl']['options']));
`;

/** A made-up site and what to do on it: the page's post, posts by ID, templates, meta, widgets, then saves by label. */
interface Scenario {
  post?: number;
  posts: Record<number, Record<string, unknown>>;
  templates?: Record<string, Record<string, Record<string, unknown>>>;
  meta?: Record<number, Record<string, unknown>>;
  registered?: Record<string, Record<string, Record<string, unknown>>>;
  patterns?: Record<string, string>;
  widgets?: Record<string, Record<string, unknown>>;
  options?: Record<string, unknown>;
  theme_mods?: Record<string, unknown>;
  cannot?: string[];
  unsupported?: string[];
  /** Post content changed after the page was shown, before the saves. */
  change?: Record<number, string>;
  saves?: { find: string; kind?: string; value: unknown }[];
}
interface Result {
  trace: unknown;
  answers: { status: number; data: { ok: boolean; error?: string; revision?: string } }[];
  rest: [string, string, Record<string, unknown>][];
  posts: Record<string, string>;
  meta: Record<string, Record<string, unknown>>;
  templates: Record<string, Record<string, Record<string, unknown>>>;
  options: Record<string, unknown>;
}

describe('what a WordPress page offers to change, and what saving it writes, under a stand-in WordPress', { skip: php ? false : 'PHP is not installed here' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'wg-wp-edit-'));
  const site = join(dir, 'site');
  const plugin = join(dir, 'wanigan-live.php');
  const harness = join(dir, 'harness.php');
  writeFileSync(plugin, wordpressHelper(TOKEN));
  writeFileSync(harness, HARNESS);
  for (const file of ['wp-includes/template-canvas.php', 'wp-content/themes/northwind/parts/header.html']) {
    mkdirSync(dirname(join(site, file)), { recursive: true });
    writeFileSync(join(site, file), '');
  }
  after(() => rmSync(dir, { recursive: true, force: true }));
  let n = 0;
  const run = (s: Scenario): Result => {
    const file = join(dir, `scenario-${++n}.json`);
    writeFileSync(file, JSON.stringify(s));
    const out = execFileSync(php as string, [harness], { env: { PATH: process.env.PATH ?? '', WL_SITE: site, WL_PLUGIN: plugin, WL_TOKEN: TOKEN, WL_SCENARIO: file }, encoding: 'utf8' });
    try {
      return JSON.parse(out) as Result;
    } catch {
      throw new Error(`The stand-in WordPress did not answer JSON:\n${out.slice(0, 4000)}`);
    }
  };
  /** The trace's edit targets, as the window reads them (parseTrace), checked to be a trace. */
  const edits = (r: Result): EditTarget[] => {
    const t = parseTrace(r.trace);
    assert.ok(t, 'the stored trace is a trace by the contract');
    assert.deepEqual((r.trace as { logs?: unknown[] }).logs ?? [], [], 'nothing went wrong while the page was traced');
    return t.edits;
  };
  const target = (r: Result, label: string): EditTarget => {
    const e = edits(r).find((x) => x.label.includes(label));
    assert.ok(e, `a target labelled …${label}… among: ${edits(r).map((x) => x.label).join(' | ')}`);
    return e;
  };
  /** One property of a block target's schema. */
  const prop = (e: EditTarget, name: string): Record<string, unknown> => {
    const p = (e.schema as { properties?: Record<string, Record<string, unknown>> }).properties?.[name];
    assert.ok(p, `${e.label} has a property ${name}`);
    return p;
  };
  const page = (content: string, extra: Partial<Scenario> = {}): Scenario => ({ post: 7, posts: { 7: { post_type: 'page', post_title: 'Welcome', post_content: content } }, ...extra });

  test('formatted words are rich text the editor would read back, and a save splices them in as core’s own bindings do, cleaned by kses', () => {
    const content = '<!-- wp:paragraph -->\n<p>Fresh <strong>bread</strong> &amp; <a href="/menu">coffee</a></p>\n<!-- /wp:paragraph -->';
    const r = run(page(content, { saves: [{ find: 'Paragraph block', value: { content: 'Warm <em>rolls</em> &amp; tea<script>alert(1)</script>' } }] }));
    const e = target(r, 'Paragraph block');
    assert.equal(e.why, undefined, 'the block can change here');
    const content_ = prop(e, 'content');
    assert.equal(content_.readOnly, undefined, 'formatted words are no longer read-only');
    assert.equal(content_.contentMediaType, 'text/html', 'its value is HTML, as the block attribute is');
    assert.equal((e.value as Record<string, unknown>).content, 'Fresh <strong>bread</strong> &amp; <a href="/menu">coffee</a>', 'its words as the stored HTML');
    assert.deepEqual(r.answers[0]?.data, { ok: true, revision: r.answers[0]?.data.revision }, r.answers[0]?.data.error);
    assert.equal(r.posts[7], '<!-- wp:paragraph -->\n<p>Warm <em>rolls</em> &amp; tea</p>\n<!-- /wp:paragraph -->', 'only the words changed; the script kses took out never reaches the page');
    assert.deepEqual(r.rest.map(([m, route]) => `${m} ${route}`), ['POST /wp/v2/pages/7'], 'saved through the page’s own REST route');
  });

  test('a list item’s words are saved up to its nested list, which is kept byte for byte', () => {
    const nested = '<!-- wp:list -->\n<ul class="wp-block-list"><!-- wp:list-item -->\n<li>Rye</li>\n<!-- /wp:list-item --></ul>\n<!-- /wp:list -->';
    const content = `<!-- wp:list -->\n<ul class="wp-block-list"><!-- wp:list-item -->\n<li>Breads <em>daily</em>${nested}</li>\n<!-- /wp:list-item --></ul>\n<!-- /wp:list -->`;
    const r = run(page(content, { saves: [{ find: 'List item block in page “Welcome”', value: { content: 'Loaves, <strong>baked</strong> daily' } }] }));
    const items = edits(r).filter((x) => x.label.startsWith('List item block'));
    assert.equal(items.length, 2, 'the outer item and the nested one');
    assert.deepEqual(items[0]?.value, { content: 'Breads <em>daily</em>' }, 'its own words stop at the first inner block, as WP_Block::replace_html() stops in 7.1');
    assert.equal(items[0]?.why, undefined);
    assert.ok(r.answers[0]?.data.ok, r.answers[0]?.data.error);
    assert.equal(r.posts[7], content.replace('<li>Breads <em>daily</em>', '<li>Loaves, <strong>baked</strong> daily'));
  });

  test('words may hold only inline formatting: a block element or a comment is refused before anything is written', () => {
    const content = '<!-- wp:paragraph -->\n<p>Plain</p>\n<!-- /wp:paragraph -->';
    const r = run(page(content, { saves: [
      { find: 'Paragraph block', value: { content: 'Two</p><div>blocks</div>' } },
      { find: 'Paragraph block', value: { content: 'Sneaky <!-- /wp:paragraph --> close' } },
    ] }));
    for (const a of r.answers) {
      assert.equal(a.data.ok, false);
      assert.equal(a.status, 409);
    }
    assert.match(r.answers[0]?.data.error ?? '', /a <(div|p)> cannot/);
    assert.match(r.answers[1]?.data.error ?? '', /comment/i);
    assert.deepEqual(r.rest, [], 'nothing was sent to WordPress');
    assert.equal(r.posts[7], content);
  });

  test('one block is written back alone: markup elsewhere that a whole-document round trip would rewrite stays byte for byte', () => {
    // Attribute JSON written by another tool: escaped slashes, which serialize_block_attributes() writes unescaped.
    const card = '<!-- wp:acme/card {"link":"https:\\/\\/acme.example.test\\/menu","title":"Menu"} /-->';
    const content = `<!-- wp:paragraph -->\n<p>Open daily</p>\n<!-- /wp:paragraph -->\n\n${card}\n\n<!-- wp:paragraph {"dropCap":true} -->\n<p class="has-drop-cap">Since 1990</p>\n<!-- /wp:paragraph -->`;
    const r = run(page(content, { saves: [{ find: 'Paragraph block', value: { content: 'Open <strong>every</strong> day', dropCap: false } }] }));
    const paragraphs = edits(r).filter((x) => x.label.startsWith('Paragraph block'));
    assert.equal(paragraphs.length, 2);
    for (const e of paragraphs) assert.equal(e.why, undefined, 'the document need not survive parse_blocks() and serialize_blocks() whole');
    assert.ok(r.answers[0]?.data.ok, r.answers[0]?.data.error);
    assert.equal(r.posts[7], content.replace('<p>Open daily</p>', '<p>Open <strong>every</strong> day</p>'), 'only the words changed; the other blocks’ bytes, escaped slashes and all, are as they were');
    assert.deepEqual(r.rest.map(([m, route]) => `${m} ${route}`), ['POST /wp/v2/pages/7']);
  });

  test('a block’s attribute change rewrites only its own delimiter, and a save still refuses a change since the trace and a post someone has open', () => {
    const content = '<!-- wp:navigation-link {"label":"Menu","url":"/menu","kind":"custom"} /-->\n\n<!-- wp:paragraph -->\n<p>Open</p>\n<!-- /wp:paragraph -->';
    const changed = run(page(content, { saves: [{ find: 'Custom Link block', value: { label: 'Our menu' } }] }));
    assert.ok(changed.answers[0]?.data.ok, changed.answers[0]?.data.error);
    assert.equal(changed.posts[7], content.replace('{"label":"Menu","url":"/menu","kind":"custom"}', '{"label":"Our menu","url":"/menu","kind":"custom"}'));

    const stale = run(page(content, { change: { 7: content.replace('Open', 'Closed') }, saves: [{ find: 'Paragraph block', value: { content: 'Shut' } }] }));
    assert.equal(stale.answers[0]?.status, 409);
    assert.match(stale.answers[0]?.data.error ?? '', /changed since the page was shown/);
    assert.deepEqual(stale.rest, [], 'nothing was written over the newer content');

    const locked = run(page(content, { meta: { 7: { _edit_lock: `${Math.floor(Date.now() / 1000)}:1` } }, saves: [{ find: 'Paragraph block', value: { content: 'Shut' } }] }));
    assert.match(target(locked, 'Paragraph block').why ?? '', /open in the editor/, 'the owner’s own open editor would write over it');
    assert.equal(locked.answers[0]?.status, 403);
    assert.deepEqual(locked.rest, []);
  });

  test('words bound to post meta save to that field through the post’s REST route; a field the binding cannot read, or the user cannot edit, says why', () => {
    const bound = (key: string): string => `<!-- wp:paragraph {"metadata":{"bindings":{"content":{"source":"core/post-meta","args":{"key":"${key}"}}}}} -->\n<p>Placeholder</p>\n<!-- /wp:paragraph -->`;
    const registered = { page: { subtitle: { show_in_rest: true, type: 'string', description: 'Subtitle', revisions_enabled: true }, hidden: { show_in_rest: false, type: 'string' } } };
    const r = run(page(`${bound('subtitle')}\n\n${bound('hidden')}\n\n${bound('_secret_plan')}`, {
      registered, meta: { 7: { subtitle: 'Baked at <em>dawn</em>', hidden: 'x', _secret_plan: 'y' } },
      saves: [{ find: 'kept in the field “subtitle”', value: 'Baked at <strong>six</strong>' }],
    }));
    const e = target(r, 'kept in the field “subtitle”');
    assert.equal(e.kind, 'meta');
    assert.equal(e.why, undefined);
    assert.equal(e.value, 'Baked at <em>dawn</em>');
    assert.equal(e.revisions, true, 'the field keeps revisions (revisions_enabled)');
    assert.match(e.label, /shows wherever that field shows/);
    assert.ok(r.answers[0]?.data.ok, r.answers[0]?.data.error);
    assert.deepEqual(r.rest[0], ['POST', '/wp/v2/pages/7', { meta: { subtitle: 'Baked at <strong>six</strong>' } }], 'through the page’s REST route, as the editor’s binding saves it');
    assert.equal(r.meta[7]?.subtitle, 'Baked at <strong>six</strong>');
    assert.match(r.posts[7] ?? '', /<p>Placeholder<\/p>/, 'the block’s own markup is not touched');
    // The block's own words say where they come from.
    const block = edits(r).find((x) => x.label.startsWith('Paragraph block'));
    assert.match(String(prop(block!, 'content').description), /field “subtitle”/);
    for (const key of ['hidden', '_secret_plan']) assert.match(target(r, `kept in the field “${key}”`).why ?? '', /^WordPress keeps no such thing: /, key);

    const cannot = run(page(bound('subtitle'), { registered, meta: { 7: { subtitle: 'a' } }, cannot: ['edit_post_meta:7:subtitle'] }));
    assert.match(target(cannot, 'kept in the field “subtitle”').why ?? '', /edit_post_meta/);
    const noFields = run(page(bound('subtitle'), { registered, meta: { 7: { subtitle: 'a' } }, unsupported: ['page:custom-fields'] }));
    assert.match(target(noFields, 'kept in the field “subtitle”').why ?? '', /^Wanigan does not do this yet: .*custom fields/);
  });

  test('a static block’s own settings stay read-only, saying WordPress keeps no PHP save() to write them', () => {
    const r = run(page('<!-- wp:heading {"level":3} -->\n<h3 class="wp-block-heading">Hours</h3>\n<!-- /wp:heading -->'));
    const e = target(r, 'Heading block');
    assert.equal(prop(e, 'content').readOnly, undefined);
    assert.equal(prop(e, 'level').readOnly, true);
    assert.match(String(prop(e, 'level').description), /^WordPress keeps no such thing: /);
  });
});
