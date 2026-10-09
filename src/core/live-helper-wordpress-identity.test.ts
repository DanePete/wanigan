// What each part of a traced WordPress page names (helper version 4,
// PartIdentity in src/shared/live-trace.ts), under a stand-in WordPress: the
// plugin is the real file Wanigan writes, and the page is rendered through the
// paths it hooks, made up here in core's shape (apply_filters() calling the
// 'all' hook first, WP_Block::render() with pre_render_block and
// render_block_{name}, the_content, dynamic_sidebar(), wp_nav_menu(), the
// template canvas) over made-up content (acme, northwind). The trace is the
// one the helper stores once the page's buffer has said which parts it kept.
// What it proves: a post's content, title and excerpt are the post's fields, a
// block in stored markup is named by its store and path, a template, template
// part, widget and menu item are configuration, a menu is its term, a block
// with no store of its own is a component by where it sits, and what has
// nothing stable to name (or an odd id) has no identity. Nothing here touches
// a site; it needs PHP.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { wordpressHelper } from './live-helper-wordpress.ts';
import { identityKey, kindKey, parseTrace, type LiveTrace, type PartIdentity, type TracePart } from '../shared/live-trace.ts';

const TOKEN = 'ef'.repeat(24);

const php = ((): string | null => {
  try { execFileSync('php', ['-v'], { stdio: 'ignore' }); return 'php'; } catch { return null; }
})();

const HARNESS = String.raw`<?php
define('ABSPATH', getenv('WL_SITE') . '/');
define('WPINC', 'wp-includes');
define('WP_CONTENT_DIR', ABSPATH . 'wp-content');
define('WP_PLUGIN_DIR', WP_CONTENT_DIR . '/plugins');
define('WPMU_PLUGIN_DIR', WP_CONTENT_DIR . '/mu-plugins');
$GLOBALS['wl'] = array('transients' => array());
$GLOBALS['wp_current_filter'] = array();
$GLOBALS['wp_actions'] = array();
$GLOBALS['wp_filter'] = array();
function add_action() { return true; }
function add_filter() { return true; }
function remove_action() { return true; }
function remove_filter() { return true; }
function has_filter() { return false; }
function current_filter() { return end($GLOBALS['wp_current_filter']); }
function current_action() { return current_filter(); }
function doing_action($h = null) { return in_array($h, $GLOBALS['wp_current_filter'], true); }
/**
 * plugin.php apply_filters(): the hook goes on $wp_current_filter and the 'all' hook runs first; then its callbacks,
 * which here are core's own the plugin needs (do_blocks on the_content) and the helper's closers at PHP_INT_MAX.
 */
function apply_filters($hook, $value, ...$args) {
  $GLOBALS['wp_current_filter'][] = $hook;
  Wanigan_Live::all($hook, $value, ...$args);
  $closers = array('the_content' => 'content_end', 'the_title' => 'single_end', 'the_excerpt' => 'single_end', 'pre_render_block' => 'pre_render_end', 'dynamic_sidebar_params' => 'widget_marks', 'pre_wp_nav_menu' => 'menu_short', 'wp_nav_menu' => 'menu_end', 'walker_nav_menu_start_el' => 'item_end', 'pre_do_shortcode_tag' => 'shortcode_short', 'do_shortcode_tag' => 'shortcode_end');
  if ($hook === 'the_content') $value = do_blocks($value);
  if (strpos($hook, 'render_block_') === 0) $value = Wanigan_Live::block_end($value, ...$args);
  elseif (isset($closers[$hook])) $value = call_user_func(array('Wanigan_Live', $closers[$hook]), $value, ...$args);
  array_pop($GLOBALS['wp_current_filter']);
  return $value;
}
function do_action($hook, ...$args) {
  $GLOBALS['wp_actions'][$hook] = ($GLOBALS['wp_actions'][$hook] ?? 0) + 1;
  $GLOBALS['wp_current_filter'][] = $hook;
  Wanigan_Live::all($hook, ...$args);
  $handlers = array('wp_before_include_template' => 'main_start', 'wp_head' => 'block_template_end', 'wp_body_open' => 'block_template_begin_mark', 'wp_footer' => 'block_template_end_mark', 'wp_before_load_template' => 'template_start', 'wp_after_load_template' => 'template_end', 'render_block_core_template_part_file' => 'template_part_source', 'dynamic_sidebar_before' => 'sidebar_start', 'dynamic_sidebar' => 'widget_start', 'dynamic_sidebar_after' => 'sidebar_end');
  if (isset($handlers[$hook])) call_user_func_array(array('Wanigan_Live', $handlers[$hook]), $args);
  array_pop($GLOBALS['wp_current_filter']);
}
function wp_parse_url($u, $c = -1) { return parse_url($u, $c); }
function wp_normalize_path($p) { return str_replace(chr(92), '/', $p); }
function untrailingslashit($s) { return rtrim($s, '/'); }
function is_admin() { return false; }
function wp_doing_ajax() { return false; }
function wp_doing_cron() { return false; }
function is_feed() { return false; }
function is_robots() { return false; }
function is_favicon() { return false; }
function is_trackback() { return false; }
function nocache_headers() {}
function wp_json_encode($v, $f = 0) { return json_encode($v, $f); }
function wp_strip_all_tags($s) { return trim(strip_tags((string) $s)); }
function esc_attr($s) { return htmlspecialchars((string) $s, ENT_QUOTES); }
function admin_url($p = '') { return '/wp-admin/' . $p; }
function get_option($k, $d = false) { return $d; }
function get_transient($k) { return $GLOBALS['wl']['transients'][$k] ?? false; }
function set_transient($k, $v) { $GLOBALS['wl']['transients'][$k] = $v; return true; }
function delete_transient($k) { unset($GLOBALS['wl']['transients'][$k]); return true; }
function get_site_transient($k) { return false; }
function get_current_user_id() { return 1; }
function is_user_logged_in() { return true; }
function current_user_can() { return true; }
function wp_get_current_user() { return new class { public $display_name = 'editor'; public $user_login = 'editor'; public $roles = array('editor'); public function exists() { return true; } }; }
function get_theme_root() { return WP_CONTENT_DIR . '/themes'; }
function get_stylesheet() { return 'northwind'; }
function get_template() { return 'northwind'; }
function get_stylesheet_directory() { return WP_CONTENT_DIR . '/themes/northwind'; }
function get_template_directory() { return WP_CONTENT_DIR . '/themes/northwind'; }
function is_child_theme() { return false; }
function wp_is_block_theme() { return true; }
function get_queried_object() { return get_post(7); }
final class WP_Post {
  public $ID; public $post_type; public $post_title; public $post_content = ''; public $post_excerpt = ''; public $post_status = 'publish'; public $post_name = '';
  public $post_author = 1; public $post_date = ''; public $post_modified = ''; public $post_parent = 0; public $menu_order = 0; public $post_password = '';
  public function __construct(array $f) { foreach ($f as $k => $v) $this->$k = $v; }
}
final class WP_Term { public $term_id; public $name; public $taxonomy = 'nav_menu'; public function __construct($id, $name) { $this->term_id = $id; $this->name = $name; } }
function get_post($id = null) {
  if ($id === null) return isset($GLOBALS['post']) ? $GLOBALS['post'] : null;
  if ($id instanceof WP_Post) return $id;
  return $GLOBALS['wl']['posts'][(int) $id] ?? null;
}
function get_the_title($p = 0) { $p = get_post($p ?: null); return $p ? $p->post_title : ''; }
function get_post_type_object($t) { return (object) array('labels' => (object) array('singular_name' => ucfirst($t))); }
function rest_get_route_for_post($p) { return '/wp/v2/' . $p->post_type . 's/' . $p->ID; }
function post_type_supports($t, $f) { return true; }
function wp_revisions_enabled($p) { return true; }
function get_post_thumbnail_id($p) { return 0; }
function get_edit_post_link($id, $c = '') { return '/wp-admin/post.php?post=' . $id . '&action=edit'; }
function use_block_editor_for_post($p) { return true; }
function get_page_template_slug($p) { return ''; }
function get_post_meta($id, $key = '', $single = false) { return $key === '' ? array() : ''; }
function is_protected_meta($k) { return $k[0] === '_'; }
function wp_get_post_revisions($id, $a = array()) { return array(); }
function get_post_status($p) { return $p->post_status; }
function get_block_template($id, $type = 'wp_template') { return isset($GLOBALS['wl']['templates'][$type][$id]) ? (object) $GLOBALS['wl']['templates'][$type][$id] : null; }
function wp_get_sidebars_widgets() { return array('sidebar-1' => array('text-3', 'Old Widget')); }
function wp_get_nav_menu_items($menu, $a = array()) { return array((object) array('ID' => 31, 'menu_item_parent' => 0, 'menu_order' => 1)); }
function wp_setup_nav_menu_item($item) { return (object) array('type' => 'post_type', 'object' => 'page', 'type_label' => 'Page', 'title' => $item->post_title, 'url' => 'https://acme.example.test/about/'); }
function wp_scripts() { return new WlDeps(); }
function wp_styles() { return new WlDeps(); }
final class WlDeps { public $done = array(); public $queue = array(); public $registered = array(); public function get_data($h, $k) { return false; } }

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
}
/** class-wp-block.php: the interactivity filter first, each inner block after pre_render_block, a dynamic block's callback, then render_block and render_block_{name}. */
final class WP_Block {
  public $name; public $parsed_block; public $attributes; public $context = array(); public $block_type; public $inner_blocks = array();
  public function __construct($parsed) {
    $this->parsed_block = $parsed;
    $this->name = $parsed['blockName'];
    $this->attributes = $parsed['attrs'];
    $this->block_type = $this->name ? WP_Block_Type_Registry::get_instance()->get_registered($this->name) : null;
    foreach ($parsed['innerBlocks'] as $inner) $this->inner_blocks[] = new WP_Block($inner);
  }
  public function render() {
    apply_filters('interactivity_process_directives', true);
    $content = '';
    $i = 0;
    foreach ($this->parsed_block['innerContent'] as $chunk) {
      if (is_string($chunk)) { $content .= $chunk; continue; }
      $inner = $this->inner_blocks[$i++];
      $pre = apply_filters('pre_render_block', null, $inner->parsed_block, $this);
      $content .= $pre === null ? $inner->render() : $pre;
    }
    if ($this->block_type && $this->block_type->is_dynamic()) $content = call_user_func($this->block_type->render_callback, $this->attributes, $content, $this);
    $content = apply_filters('render_block', $content, $this->parsed_block, $this);
    return apply_filters('render_block_' . $this->name, $content, $this->parsed_block, $this);
  }
}
function render_block($parsed) {
  $pre = apply_filters('pre_render_block', null, $parsed, null);
  return $pre !== null ? $pre : (new WP_Block($parsed))->render();
}
function do_blocks($content) { $out = ''; foreach (parse_blocks($content) as $b) $out .= render_block($b); return $out; }
// Dynamic blocks, as core's render callbacks reach the hooks the helper reads.
function render_block_core_template_part($attributes) {
  $id = $attributes['theme'] . '//' . $attributes['slug'];
  $part = get_block_template($id, 'wp_template_part');
  do_action('render_block_core_template_part_file', $id, $attributes, WP_CONTENT_DIR . '/themes/northwind/parts/' . $attributes['slug'] . '.html', $part->content);
  return '<header class="wp-block-template-part">' . do_blocks($part->content) . '</header>';
}
function render_block_core_post_content() { return '<div class="entry-content">' . apply_filters('the_content', get_post()->post_content) . '</div>'; }
function render_block_core_block($attributes) { return do_blocks(get_post($attributes['ref'])->post_content); }
function render_block_core_site_title() { return '<p class="wp-block-site-title">Acme</p>'; }
// Classic template tags, as post-template.php and widgets.php print them.
function the_title($before = '', $after = '') { echo $before . apply_filters('the_title', get_the_title(), get_post()->ID) . $after; }
function get_the_excerpt() { $p = get_post(); return apply_filters('get_the_excerpt', $p->post_excerpt !== '' ? $p->post_excerpt : 'Made from the content.', $p); }
function the_excerpt() { echo apply_filters('the_excerpt', get_the_excerpt()); }
function acme_text_widget() { return '<p>Opening hours</p>'; }
function dynamic_sidebar($index) {
  global $wp_registered_sidebars, $wp_registered_widgets;
  do_action('dynamic_sidebar_before', $index, true);
  foreach (wp_get_sidebars_widgets()[$index] as $id) {
    $params = apply_filters('dynamic_sidebar_params', array(array_merge($wp_registered_sidebars[$index], array('widget_id' => $id, 'widget_name' => $wp_registered_widgets[$id]['name'])), array()));
    do_action('dynamic_sidebar', $wp_registered_widgets[$id]);
    echo $params[0]['before_widget'] . call_user_func($wp_registered_widgets[$id]['callback']) . $params[0]['after_widget'];
  }
  do_action('dynamic_sidebar_after', $index, true);
}
function wp_nav_menu($args) {
  $args = apply_filters('wp_nav_menu_args', (object) $args);
  if (apply_filters('pre_wp_nav_menu', null, $args) !== null) return;
  $out = '';
  foreach (apply_filters('wp_nav_menu_objects', $GLOBALS['wl']['menu'], $args) as $item) {
    $item_args = apply_filters('nav_menu_item_args', $args, $item, 0);
    $out .= '<li>' . apply_filters('walker_nav_menu_start_el', '<a href="' . $item->url . '">' . $item->title . '</a>', $item, 0, $item_args) . '</li>';
  }
  echo apply_filters('wp_nav_menu', '<ul>' . $out . '</ul>', $args);
}
function acme_shortcode($tag) {
  if (($pre = apply_filters('pre_do_shortcode_tag', false, $tag, array(), array())) !== false) return $pre;
  return apply_filters('do_shortcode_tag', '<span class="gallery">Gallery</span>', $tag, array(), array());
}

// The site: a block template with a header part and the post's content, a synced pattern in the post, a sidebar,
// a menu, a second post's title and excerpt, and a shortcode.
$edited = getenv('WL_EDIT') === '1';
$GLOBALS['wl']['posts'] = array(
  7 => new WP_Post(array('ID' => 7, 'post_type' => 'page', 'post_title' => 'Welcome page', 'post_excerpt' => 'A short welcome.', 'post_content' => "<!-- wp:heading -->\n<h2>Welcome</h2>\n<!-- /wp:heading -->\n\n<!-- wp:paragraph -->\n<p>One</p>\n<!-- /wp:paragraph -->\n\n<!-- wp:block {\"ref\":9} /-->")),
  8 => new WP_Post(array('ID' => 8, 'post_type' => 'post', 'post_title' => 'Northwind news')),
  9 => new WP_Post(array('ID' => 9, 'post_type' => 'wp_block', 'post_title' => 'Shared', 'post_content' => "<!-- wp:paragraph -->\n<p>Shared one</p>\n<!-- /wp:paragraph -->\n\n<!-- wp:paragraph -->\n<p>Shared two</p>\n<!-- /wp:paragraph -->")),
  31 => new WP_Post(array('ID' => 31, 'post_type' => 'nav_menu_item', 'post_title' => 'About')),
);
$GLOBALS['wl']['templates'] = array(
  'wp_template' => array('northwind//page' => array('id' => 'northwind//page', 'slug' => 'page', 'title' => 'Page', 'source' => 'theme', 'has_theme_file' => false, 'wp_id' => 0, 'content' => "<!-- wp:template-part {\"slug\":\"header\",\"theme\":\"northwind\"} /-->\n\n<!-- wp:group -->\n<div class=\"wp-block-group\"><!-- wp:post-content /--></div>\n<!-- /wp:group -->")),
  // An edit elsewhere on the page: a block added to the header, after what was there.
  'wp_template_part' => array('northwind//header' => array('id' => 'northwind//header', 'slug' => 'header', 'title' => 'Header', 'source' => 'theme', 'has_theme_file' => false, 'wp_id' => 0, 'content' => '<!-- wp:site-title /-->' . ($edited ? "\n\n<!-- wp:paragraph -->\n<p>Sale today</p>\n<!-- /wp:paragraph -->" : ''))),
);
$GLOBALS['wl']['menu'] = array((object) array('ID' => 31, 'title' => 'About', 'url' => 'https://acme.example.test/about/', 'menu_item_parent' => 0, 'menu_order' => 1));
$GLOBALS['wp_registered_sidebars'] = array('sidebar-1' => array('name' => 'Sidebar', 'before_widget' => '<section>', 'after_widget' => '</section>'));
// A widget id from an old-style registration, with a space in it: traced, and named nothing.
$GLOBALS['wp_registered_widgets'] = array('text-3' => array('name' => 'Text', 'callback' => 'acme_text_widget'), 'Old Widget' => array('name' => 'Old Widget', 'callback' => 'acme_text_widget'));
$GLOBALS['shortcode_tags'] = array('gallery' => 'acme_shortcode');
$dynamic = function ($fn) { return array('render_callback' => $fn); };
WP_Block_Type_Registry::$types = array(
  'core/template-part' => new WP_Block_Type('core/template-part', $dynamic('render_block_core_template_part')),
  'core/post-content' => new WP_Block_Type('core/post-content', $dynamic('render_block_core_post_content')),
  'core/block' => new WP_Block_Type('core/block', $dynamic('render_block_core_block')),
  'core/site-title' => new WP_Block_Type('core/site-title', array('title' => 'Site Title') + $dynamic('render_block_core_site_title')),
  'core/group' => new WP_Block_Type('core/group', array('title' => 'Group')),
  'core/heading' => new WP_Block_Type('core/heading', array('title' => 'Heading')),
  'core/paragraph' => new WP_Block_Type('core/paragraph', array('title' => 'Paragraph')),
);

$_SERVER['REQUEST_URI'] = '/welcome-page/';
$_SERVER['SCRIPT_FILENAME'] = ABSPATH . 'index.php';
$_SERVER['HTTP_X_WANIGAN_LIVE'] = getenv('WL_TOKEN');
require getenv('WL_PLUGIN');
$GLOBALS['post'] = get_post(7);
$GLOBALS['_wp_current_template_id'] = 'northwind//page';

// class-wp.php WP::main() fires 'wp'; then template-canvas.php renders the block template before wp_head().
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
// A theme file with a block of its own, a widget area, a menu, another post's title and excerpt, a shortcode.
$sidebar = WP_CONTENT_DIR . '/themes/northwind/sidebar.php';
do_action('wp_before_load_template', $sidebar, true, array());
echo '<aside>' . do_blocks("<!-- wp:paragraph -->\n<p>Aside</p>\n<!-- /wp:paragraph -->");
dynamic_sidebar('sidebar-1');
wp_nav_menu(array('menu' => new WP_Term(5, 'Main'), 'theme_location' => 'primary'));
echo '</aside>';
do_action('wp_after_load_template', $sidebar, true, array());
the_excerpt();
$GLOBALS['post'] = get_post(8);
the_title('<h2>', '</h2>');
the_excerpt();
echo acme_shortcode('gallery');
echo '</body></html>';
// shutdown_action_hook(): the trace is assembled at 0, core's template buffer flushed after, and the trace stored.
Wanigan_Live::assemble();
$html = ob_get_clean();
Wanigan_Live::buffer($html);
Wanigan_Live::flushed();
$id = (new ReflectionProperty('Wanigan_Live', 'id'))->getValue();
$stored = get_transient('wanigan_live_t_1_' . $id);
echo json_encode(array('trace' => $stored ? $stored['trace'] : null, 'keys' => array_map(array('Wanigan_Live', 'identity_key'), json_decode(getenv('WL_SAMPLES'), true))));
`;

/** One sample of each kind of identity, with every optional value and without. */
const SAMPLES: PartIdentity[] = [
  { kind: 'entity', type: 'post', id: '7', bundle: 'page', field: 'post_content' },
  { kind: 'entity', type: 'node', id: '0a1b2c3d-0000-4000-8000-000000000012', bundle: 'page', langcode: 'en', field: 'field_related', item: 'ref:node:0a1b2c3d-0000-4000-8000-0000000000a1' },
  { kind: 'entity', type: 'term', id: '5' },
  { kind: 'component', name: 'core/paragraph', within: 'block|post:7|4|core/block', nth: 1 },
  { kind: 'component', name: 'core/paragraph', within: null, nth: 0 },
  { kind: 'config', type: 'wp_template_part', id: 'northwind//header' },
  { kind: 'config', type: 'widget', id: 'text-3', plugin: 'text' },
  { kind: 'block', store: 'tpl:northwind//page', path: [2, 0], name: 'core/post-content' },
];

describe('what each part of a WordPress page names, under a stand-in WordPress', { skip: php ? false : 'PHP is not installed here' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'wg-wp-identity-'));
  const site = join(dir, 'site');
  const plugin = join(dir, 'wanigan-live.php');
  const harness = join(dir, 'harness.php');
  writeFileSync(plugin, wordpressHelper(TOKEN));
  writeFileSync(harness, HARNESS);
  for (const file of ['wp-content/themes/northwind/sidebar.php', 'wp-content/themes/northwind/parts/header.html', 'wp-includes/template-canvas.php']) {
    mkdirSync(dirname(join(site, file)), { recursive: true });
    writeFileSync(join(site, file), '');
  }
  after(() => rmSync(dir, { recursive: true, force: true }));
  const run = (edited: boolean): { trace: unknown; keys: string[] } => JSON.parse(execFileSync(php as string, [harness], {
    env: { PATH: process.env.PATH ?? '', WL_SITE: site, WL_PLUGIN: plugin, WL_TOKEN: TOKEN, WL_SAMPLES: JSON.stringify(SAMPLES), ...(edited ? { WL_EDIT: '1' } : {}) },
    encoding: 'utf8',
  })) as { trace: unknown; keys: string[] };
  const first = run(false);
  const again = run(true);

  /** A trace's parts by label, in page order. */
  const byLabel = (trace: LiveTrace): Map<string, TracePart[]> => {
    const out = new Map<string, TracePart[]>();
    for (const p of trace.parts) out.set(p.label, [...(out.get(p.label) ?? []), p]);
    return out;
  };
  const one = (parts: Map<string, TracePart[]>, label: string, n = 0): TracePart => {
    const p = parts.get(label)?.[n];
    assert.ok(p, `a part labelled ${label} (#${n})`);
    return p;
  };

  test('every part it can name carries its identity, and the trace keeps it', () => {
    const trace = parseTrace(first.trace);
    assert.ok(trace, 'the stored trace is a trace by the contract');
    const raw = (first.trace as { parts: { identity?: unknown }[]; logs?: unknown[] });
    assert.equal(raw.parts.filter((p) => p.identity !== undefined).length, trace.parts.filter((p) => p.identity).length, 'no identity was refused');
    assert.deepEqual(raw.logs ?? [], [], 'nothing went wrong while the page was traced');
    const parts = byLabel(trace);
    const synced: PartIdentity = { kind: 'block', store: 'post:7', path: [4], name: 'core/block' };

    assert.deepEqual(one(parts, 'Template: Page').identity, { kind: 'config', type: 'wp_template', id: 'northwind//page' }, 'a block template');
    assert.deepEqual(one(parts, 'Template part: Header').identity, { kind: 'config', type: 'wp_template_part', id: 'northwind//header' }, 'a template part is the part it shows, wherever its block sits');
    assert.deepEqual(one(parts, 'Site Title').identity, { kind: 'block', store: 'tp:northwind//header', path: [0], name: 'core/site-title' }, 'a block in a template part');
    assert.deepEqual(one(parts, 'Group').identity, { kind: 'block', store: 'tpl:northwind//page', path: [2], name: 'core/group' }, 'a block in a template: its path among the blocks there');
    assert.deepEqual(one(parts, 'core/post-content').identity, { kind: 'block', store: 'tpl:northwind//page', path: [2, 0], name: 'core/post-content' }, 'inside another');
    assert.deepEqual(one(parts, 'Page 7: Welcome page').identity, { kind: 'entity', type: 'post', id: '7', bundle: 'page', field: 'post_content' }, 'a post’s content');
    assert.deepEqual(one(parts, 'Heading').identity, { kind: 'block', store: 'post:7', path: [0], name: 'core/heading' }, 'a block in a post');
    assert.deepEqual(one(parts, 'Paragraph').identity, { kind: 'block', store: 'post:7', path: [2], name: 'core/paragraph' });
    assert.deepEqual(one(parts, 'Synced pattern: Shared').identity, synced);

    // Blocks with no store of their own: within the nearest identified part, counted by name there.
    assert.deepEqual([one(parts, 'Paragraph', 1).identity, one(parts, 'Paragraph', 2).identity], [
      { kind: 'component', name: 'core/paragraph', within: identityKey(synced), nth: 0 },
      { kind: 'component', name: 'core/paragraph', within: identityKey(synced), nth: 1 },
    ], 'a synced pattern’s two paragraphs: the first and second of their name inside it');
    assert.deepEqual(one(parts, 'Paragraph', 3).identity, { kind: 'component', name: 'core/paragraph', within: null, nth: 0 }, 'a block a theme file renders, inside nothing identified');
    assert.equal(kindKey(one(parts, 'Paragraph', 3).identity!), kindKey(one(parts, 'Paragraph').identity!), 'a paragraph is one kind, stored or not');

    assert.deepEqual(one(parts, 'Text widget').identity, { kind: 'config', type: 'widget', id: 'text-3' }, 'a widget');
    assert.equal(one(parts, 'Old Widget widget').identity, undefined, 'a widget id with a space: no identity, never a cleaned-up one');
    assert.deepEqual(one(parts, 'Menu: Main (primary)').identity, { kind: 'entity', type: 'term', id: '5', bundle: 'nav_menu' }, 'a menu is the term WordPress stores it as');
    assert.deepEqual(one(parts, 'Link: About').identity, { kind: 'config', type: 'menu_item', id: '31' }, 'a menu item');
    assert.deepEqual(one(parts, 'Title').identity, { kind: 'entity', type: 'post', id: '8', bundle: 'post', field: 'post_title' }, 'a post’s title');
    assert.deepEqual(one(parts, 'Excerpt').identity, { kind: 'entity', type: 'post', id: '7', bundle: 'page', field: 'post_excerpt' }, 'a post’s own excerpt');
    assert.equal(one(parts, 'Excerpt', 1).identity, undefined, 'an excerpt WordPress made from the content is not the excerpt field');

    // Nothing stable to name.
    for (const label of ['Block template canvas', 'sidebar.php', 'Widget area: Sidebar', '[gallery]']) assert.equal(one(parts, label).identity, undefined, label);
  });

  test('after an edit elsewhere on the page, every part is found again by its key, though its part id moved', () => {
    const a = parseTrace(first.trace)!;
    const b = parseTrace(again.trace)!;
    const keys = (t: LiveTrace): Map<string, string> => new Map(t.parts.flatMap((p) => (p.identity ? [[identityKey(p.identity), p.id] as const] : [])));
    const before = keys(a);
    const now = keys(b);
    assert.equal(before.size, a.parts.filter((p) => p.identity).length, 'no two parts of a page share a key');
    for (const key of before.keys()) assert.ok(now.has(key), `found again: ${key}`);
    assert.deepEqual([...now.keys()].filter((k) => !before.has(k)), ['block|tp:northwind//header|2|core/paragraph'], 'only the added block is new');
    const content = 'entity|post|7||post_content|';
    assert.notEqual(before.get(content), now.get(content), 'the post’s content has another part id now');
  });

  test('the helper’s identity key is identityKey(), byte for byte', () => {
    assert.deepEqual(first.keys, SAMPLES.map(identityKey));
  });
});
