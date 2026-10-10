// What a classic WordPress theme's template files write, and the term names a page shows, as the helper traces them
// (helper version 4) under a stand-in WordPress: the plugin is the real file Wanigan writes; the theme's template
// files are real files on disk, which the helper reads (it never runs them); the page is rendered through the hooks
// load_template() and the template loader fire, made up here in core's shape, as an archive of a category in a child
// theme ("Acme Child") of a parent theme ("Acme"), with a menu built partly from a term and a plugin's template.
// What it proves: a theme's template file is a part with identity (its theme, its path there, and which theme it
// is); the words typed into its HTML and the strings it prints through a gettext function become targets on that
// part, each saying why it is not saved here, its file and line, and its text domain; what its PHP computes is never
// offered; a parent's file under an active child says the change belongs in a copy in the child theme; a plugin's
// template and a file too large to read say so; and a term's name a menu or an archive heading shows is a target
// saved through wp_update_term(), saying where else it shows. Made-up sites only (acme, northwind); nothing here
// touches a site; it needs PHP.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { wordpressHelper } from './live-helper-wordpress.ts';
import { parseTrace, type EditTarget, type LiveTrace, type TracePart } from '../shared/live-trace.ts';

const TOKEN = '7c'.repeat(24);

const php = ((): string | null => {
  try { execFileSync('php', ['-v'], { stdio: 'ignore' }); return 'php'; } catch { return null; }
})();

/** The theme's files, one line per entry, so each line number below is the one the file has. */
const HEADER = [
  '<!DOCTYPE html>',
  '<html <?php language_attributes(); ?>>',
  '<head>',
  '<title>Acme Outfitters</title>',
  '<script>var acme = "Not shown";</script>',
  '<?php wp_head(); ?>',
  '</head>',
  '<body <?php body_class(); ?>>',
  '<a class="skip-link" href="#content"><?php esc_html_e( \'Skip to content\', \'acme\' ); ?></a>',
  '<header class="site-header">',
  '\t<p class="site-tagline"><?php echo esc_html( get_bloginfo( \'description\' ) ); ?></p>',
  '\t<p class="hello">Hello <?php echo esc_html( $name ); ?>, welcome back</p>',
  '\t<p class="built"><?php echo esc_html__( \'Built by \' . $maker, \'acme\' ); ?></p>',
  '\t<nav class="main-navigation" aria-label="<?php esc_attr_e( \'Primary menu\', \'acme\' ); ?>">',
  '\t\t<span class="menu-label">Paddle &amp; camp</span>',
  '\t\t<?php wp_nav_menu( array( \'theme_location\' => \'primary\' ) ); ?>',
  '\t</nav>',
  '\t<span class="open"><?php _e( \'Open daily\', $acme_domain ); ?></span>',
  '\t<!-- Words in a comment -->',
  '</header>',
].join('\n');
const ARCHIVE = [
  '<?php get_header(); ?>',
  '<main id="content">',
  '\t<h1 class="page-title"><?php the_archive_title(); ?></h1>',
  '\t<p class="intro">Trips we run</p>',
  '\t<?php $acme->_e( \'Not a translation\' ); ?>',
  '</main>',
  '<?php get_footer(); ?>',
].join('\n');
const FOOTER = [
  '<footer class="site-footer">',
  '\t<p class="credit">Made in <?php echo esc_html( $town ); ?></p>',
  '\t<p class="credit-line">Proudly made by Acme</p>',
  '\t<p><?php printf( esc_html__( \'Theme: %s\', \'acme-child\' ), \'Acme\' ); ?></p>',
  '\t<ul class="cats"><?php wp_list_categories(); ?></ul>',
  '\t<p class="again">Proudly made by Acme</p>',
  '</footer>',
  '<?php wp_footer(); ?>',
  '</body>',
  '</html>',
].join('\n');
const PLUGIN_TEMPLATE = '<section class="events"><h2>Upcoming events</h2><?php esc_html_e( "No events yet", \'northwind-events\' ); ?></section>\n';

const HARNESS = String.raw`<?php
define('ABSPATH', getenv('WL_SITE') . '/');
define('WPINC', 'wp-includes');
define('WP_CONTENT_DIR', ABSPATH . 'wp-content');
define('WP_PLUGIN_DIR', WP_CONTENT_DIR . '/plugins');
define('WPMU_PLUGIN_DIR', WP_CONTENT_DIR . '/mu-plugins');
$GLOBALS['wl'] = array('transients' => array(), 'options' => array(), 'updated' => array(), 'cannot' => array_filter(explode(',', (string) getenv('WL_CANNOT'))));
$GLOBALS['wp_current_filter'] = array();
$GLOBALS['wp_actions'] = array();
$GLOBALS['wp_filter'] = array();
final class WlSent extends Exception { public $data; public $status; public function __construct($d, $s) { parent::__construct('sent'); $this->data = $d; $this->status = $s; } }
function add_action() { return true; }
function add_filter() { return true; }
function remove_action() { return true; }
function remove_filter() { return true; }
function has_filter() { return false; }
function current_filter() { return end($GLOBALS['wp_current_filter']); }
function current_action() { return current_filter(); }
function doing_action($h = null) { return in_array($h, $GLOBALS['wp_current_filter'], true); }
/** plugin.php apply_filters(): the 'all' hook first, then the helper's own callbacks for the hooks this page fires. */
function apply_filters($hook, $value, ...$args) {
  $GLOBALS['wp_current_filter'][] = $hook;
  Wanigan_Live::all($hook, $value, ...$args);
  $closers = array('pre_wp_nav_menu' => 'menu_short', 'wp_nav_menu' => 'menu_end', 'walker_nav_menu_start_el' => 'item_end', 'single_cat_title' => 'term_title', 'list_cats' => 'term_listed');
  if (isset($closers[$hook]) && method_exists('Wanigan_Live', $closers[$hook])) $value = call_user_func(array('Wanigan_Live', $closers[$hook]), $value, ...$args);
  array_pop($GLOBALS['wp_current_filter']);
  return $value;
}
function do_action($hook, ...$args) {
  $GLOBALS['wp_actions'][$hook] = ($GLOBALS['wp_actions'][$hook] ?? 0) + 1;
  $GLOBALS['wp_current_filter'][] = $hook;
  Wanigan_Live::all($hook, ...$args);
  $handlers = array('wp_before_include_template' => 'main_start', 'wp_before_load_template' => 'template_start', 'wp_after_load_template' => 'template_end');
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
function status_header() {}
function wp_send_json($data, $status = 200) { throw new WlSent($data, $status); }
function wp_json_encode($v, $f = 0) { return json_encode($v, $f); }
function wp_strip_all_tags($s) { return trim(strip_tags((string) $s)); }
function esc_attr($s) { return htmlspecialchars((string) $s, ENT_QUOTES); }
function admin_url($p = '') { return '/wp-admin/' . $p; }
function get_option($k, $d = false) { return $GLOBALS['wl']['options'][$k] ?? $d; }
function update_option($k, $v) { $GLOBALS['wl']['options'][$k] = $v; return true; }
function get_transient($k) { return $GLOBALS['wl']['transients'][$k] ?? false; }
function set_transient($k, $v) { $GLOBALS['wl']['transients'][$k] = $v; return true; }
function delete_transient($k) { unset($GLOBALS['wl']['transients'][$k]); return true; }
function get_site_transient($k) { return false; }
function get_current_user_id() { return 1; }
function is_user_logged_in() { return true; }
function current_user_can($cap, ...$args) { return !in_array($cap, $GLOBALS['wl']['cannot'], true); }
function wp_get_current_user() { return new class { public $display_name = 'editor'; public $user_login = 'editor'; public $roles = array('editor'); public function exists() { return true; } }; }
function wp_slash($v) { if (is_array($v)) return array_map('wp_slash', $v); return is_string($v) ? addslashes($v) : $v; }
final class WP_Error { private $m; public function __construct($c = '', $m = '') { $this->m = $m; } public function get_error_message() { return $this->m; } }
function is_wp_error($v) { return $v instanceof WP_Error; }
/** rest-api.php, as far as a string with a minimum length goes. */
function rest_validate_value_from_schema($v, $schema, $param = '') {
  if (($schema['type'] ?? null) === 'string' && !is_string($v)) return new WP_Error('rest_invalid_type', $param . ' is not of type string.');
  if (isset($schema['minLength']) && mb_strlen((string) $v) < $schema['minLength']) return new WP_Error('rest_too_short', $param . ' must be at least 1 character long.');
  return true;
}
function rest_sanitize_value_from_schema($v, $schema, $param = '') { return $v; }
// A child theme ("Acme Child", acme-child) of a classic parent theme ("Acme", acme).
function get_theme_root() { return WP_CONTENT_DIR . '/themes'; }
function get_stylesheet() { return 'acme-child'; }
function get_template() { return 'acme'; }
function get_stylesheet_directory() { return WP_CONTENT_DIR . '/themes/acme-child'; }
function get_template_directory() { return WP_CONTENT_DIR . '/themes/acme'; }
function is_child_theme() { return true; }
function wp_is_block_theme() { return false; }
function wp_get_theme($s = null) {
  $names = array('acme' => 'Acme', 'acme-child' => 'Acme Child');
  $name = $names[$s ?? 'acme-child'] ?? '';
  return new class($name) { private $n; public function __construct($n) { $this->n = $n; } public function exists() { return $this->n !== ''; } public function get($k) { return $this->n; } };
}
/** template.php locate_template(): the child theme first, then its parent. */
function locate_template($names, $load = false, $once = true, $args = array()) {
  foreach ((array) $names as $n) foreach (array(get_stylesheet_directory(), get_template_directory()) as $d) if (file_exists($d . '/' . $n)) return $d . '/' . $n;
  return '';
}
final class WP_Post {
  public $ID; public $post_type = 'post'; public $post_title = ''; public $post_content = ''; public $post_excerpt = ''; public $post_status = 'publish'; public $post_name = '';
  public $post_author = 1; public $post_date = ''; public $post_modified = ''; public $post_parent = 0; public $menu_order = 0; public $post_password = '';
  public function __construct(array $f) { foreach ($f as $k => $v) $this->$k = $v; }
}
final class WP_Term { public $term_id; public $name; public $taxonomy; public function __construct($id, $name, $taxonomy) { $this->term_id = $id; $this->name = $name; $this->taxonomy = $taxonomy; } }
function get_post($id = null) { return $GLOBALS['wl']['posts'][(int) $id] ?? null; }
function get_post_type_object($t) { return (object) array('labels' => (object) array('singular_name' => ucfirst($t))); }
function get_term($id, $taxonomy = '') { $t = $GLOBALS['wl']['terms'][(int) $id] ?? null; return $t && ($taxonomy === '' || $t->taxonomy === $taxonomy) ? $t : null; }
function get_taxonomy($t) { return $t === 'category' ? (object) array('labels' => (object) array('singular_name' => 'Category')) : false; }
/** taxonomy.php wp_update_term(): what it was asked, slashed as it expects, and the name it keeps. */
function wp_update_term($id, $taxonomy, $args = array()) {
  $GLOBALS['wl']['updated'][] = array($id, $taxonomy, $args);
  $GLOBALS['wl']['terms'][(int) $id]->name = stripslashes($args['name']);
  return array('term_id' => $id, 'term_taxonomy_id' => $id);
}
function get_queried_object() { return get_term(5); }
function wp_get_nav_menu_items($menu, $a = array()) { return $GLOBALS['wl']['menu']; }
function wp_get_sidebars_widgets() { return array(); }
function wp_setup_nav_menu_item($item) { return $GLOBALS['wl']['setup'][$item->ID]; }
function wp_scripts() { return new WlDeps(); }
function wp_styles() { return new WlDeps(); }
final class WlDeps { public $done = array(); public $queue = array(); public $registered = array(); public function get_data($h, $k) { return false; } }
final class WP_Block_Type_Registry { public static function get_instance() { return new self(); } public function get_all_registered() { return array(); } public function get_registered($n) { return null; } }
final class WP_Block_Patterns_Registry { public static function get_instance() { return new self(); } public function get_all_registered() { return array(); } }
/** nav-menu-template.php wp_nav_menu(), through the filters the helper reads. */
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

// The site: two categories, and a main menu of a category (no text of its own, so it shows the term's name) and a
// custom link with its own text.
$GLOBALS['wl']['terms'] = array(5 => new WP_Term(5, 'Trips', 'category'), 7 => new WP_Term(7, 'Gear &amp; rentals', 'category'), 3 => new WP_Term(3, 'Main', 'nav_menu'));
$GLOBALS['wl']['posts'] = array(41 => new WP_Post(array('ID' => 41, 'post_type' => 'nav_menu_item', 'post_title' => '')), 42 => new WP_Post(array('ID' => 42, 'post_type' => 'nav_menu_item', 'post_title' => 'Contact')));
$GLOBALS['wl']['menu'] = array(
  (object) array('ID' => 41, 'title' => 'Trips', 'url' => 'https://acme.example.test/category/trips/', 'menu_item_parent' => 0, 'menu_order' => 1),
  (object) array('ID' => 42, 'title' => 'Contact', 'url' => 'https://acme.example.test/contact/', 'menu_item_parent' => 0, 'menu_order' => 2),
);
$GLOBALS['wl']['setup'] = array(
  41 => (object) array('type' => 'taxonomy', 'object' => 'category', 'object_id' => '5', 'type_label' => 'Category', 'title' => 'Trips', 'url' => 'https://acme.example.test/category/trips/'),
  42 => (object) array('type' => 'custom', 'object' => 'custom', 'object_id' => '42', 'type_label' => 'Custom Link', 'title' => 'Contact', 'url' => 'https://acme.example.test/contact/'),
);

$_SERVER['REQUEST_URI'] = '/category/trips/';
$_SERVER['SCRIPT_FILENAME'] = ABSPATH . 'index.php';
$_SERVER['HTTP_X_WANIGAN_LIVE'] = getenv('WL_TOKEN');
require getenv('WL_PLUGIN');

// The category archive, as the parent theme's archive.php prints it through get_header(), a plugin's template part
// and get_footer(): the files' own words echoed here as they print them (the helper reads the files themselves).
$themes = WP_CONTENT_DIR . '/themes/';
$events = WP_CONTENT_DIR . '/plugins/northwind-events/templates/upcoming.php';
do_action('wp');
Wanigan_Live::decide();
Wanigan_Live::$buffer_on = true;
ob_start();
do_action('wp_before_include_template', $themes . 'acme/archive.php');
Wanigan_Live::candidates(array('header.php'));
do_action('wp_before_load_template', $themes . 'acme/header.php', true, array());
echo '<!DOCTYPE html><html><head><title>Acme Outfitters</title></head><body><a class="skip-link" href="#content">Skip to content</a><header class="site-header"><p class="site-tagline">Gear for the north</p><p class="hello">Hello Dana, welcome back</p><nav class="main-navigation" aria-label="Primary menu"><span class="menu-label">Paddle &amp; camp</span>';
wp_nav_menu(array('theme_location' => 'primary', 'menu' => get_term(3)));
echo '</nav><span class="open">Open daily</span></header>';
do_action('wp_after_load_template', $themes . 'acme/header.php', true, array());
echo '<main id="content"><h1 class="page-title">Category: <span>' . apply_filters('single_cat_title', 'Trips') . '</span></h1><p class="intro">Trips we run</p>';
do_action('wp_before_load_template', $events, false, array());
echo '<section class="events"><h2>Upcoming events</h2>No events yet</section>';
do_action('wp_after_load_template', $events, false, array());
do_action('wp_before_load_template', $themes . 'acme-child/template-parts/huge.php', false, array());
echo '<p class="huge">Too much to read</p>';
do_action('wp_after_load_template', $themes . 'acme-child/template-parts/huge.php', false, array());
echo '</main>';
Wanigan_Live::candidates(array('footer.php'));
do_action('wp_before_load_template', $themes . 'acme-child/footer.php', true, array());
echo '<footer class="site-footer"><p class="credit">Made in Northwind Bay</p><p class="credit-line">Proudly made by Acme</p><p>Theme: Acme</p><ul class="cats"><li>' . apply_filters('list_cats', 'Gear &amp; rentals', get_term(7)) . '</li></ul><p class="again">Proudly made by Acme</p></footer></body></html>';
do_action('wp_after_load_template', $themes . 'acme-child/footer.php', true, array());
Wanigan_Live::assemble();
$html = ob_get_clean();
Wanigan_Live::buffer($html);
Wanigan_Live::flushed();
$id = (new ReflectionProperty('Wanigan_Live', 'id'))->getValue();
$stored = get_transient('wanigan_live_t_1_' . $id);
$out = array('trace' => $stored ? $stored['trace'] : null);

// Renaming the category the menu and the heading show, as the window saves a schema target: once, then again over
// the name the page showed, which the site no longer has.
$save = new ReflectionMethod('Wanigan_Live', 'edit_save');
if (PHP_VERSION_ID < 80100) $save->setAccessible(true);
foreach (array('saved' => 'Paddle trips', 'again' => 'Paddling trips', 'empty' => '') as $key => $value) {
  if ($key === 'empty') $GLOBALS['wl']['terms'][5]->name = 'Trips';
  try { $save->invoke(null, 'term-5', array('trace' => $id, 'value' => $value)); } catch (WlSent $s) { $out[$key] = array($s->data, $s->status); }
}
$out['updated'] = $GLOBALS['wl']['updated'];
echo json_encode($out, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
`;

type Saved = [{ ok: boolean; error?: string }, number];
interface Result { trace: unknown; saved: Saved; again: Saved; empty: Saved; updated: [number, string, { name: string }][] }

describe('the words a classic theme’s template files write, and the term names a page shows, under a stand-in WordPress', { skip: php ? false : 'PHP is not installed here' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'wg-wp-template-words-'));
  const site = join(dir, 'site');
  const plugin = join(dir, 'wanigan-live.php');
  const harness = join(dir, 'harness.php');
  writeFileSync(plugin, wordpressHelper(TOKEN));
  writeFileSync(harness, HARNESS);
  const files: Record<string, string> = {
    'wp-content/themes/acme/header.php': HEADER,
    'wp-content/themes/acme/archive.php': ARCHIVE,
    'wp-content/themes/acme-child/footer.php': FOOTER,
    // Larger than the helper reads.
    'wp-content/themes/acme-child/template-parts/huge.php': `<p class="huge">Too much to read</p>\n${'<!-- filler -->\n'.repeat(17_000)}`,
    'wp-content/plugins/northwind-events/templates/upcoming.php': PLUGIN_TEMPLATE,
  };
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(site, file)), { recursive: true });
    writeFileSync(join(site, file), text);
  }
  after(() => rmSync(dir, { recursive: true, force: true }));
  const run = (cannot: string[] = []): Result => {
    const out = execFileSync(php as string, [harness], { env: { PATH: process.env.PATH ?? '', WL_SITE: site, WL_PLUGIN: plugin, WL_TOKEN: TOKEN, WL_CANNOT: cannot.join(',') }, encoding: 'utf8' });
    try { return JSON.parse(out) as Result; } catch { throw new Error(`The stand-in WordPress did not answer JSON:\n${out.slice(0, 4000)}`); }
  };
  const r = run();
  const trace = parseTrace(r.trace) as LiveTrace;

  const part = (label: string): TracePart => {
    const p = trace.parts.find((x) => x.label === label);
    assert.ok(p, `a part labelled ${label} among: ${trace.parts.map((x) => x.label).join(' | ')}`);
    return p;
  };
  const targetsOf = (p: TracePart): EditTarget[] => (p.edits ?? []).map((id) => trace.edits.find((e) => e.id === id)).filter((e): e is EditTarget => !!e);
  const words = (t: EditTarget | undefined): Record<string, { words: string; at: string }> => {
    assert.ok(t, 'the target is there');
    const props = (t.schema as { properties: Record<string, { description: string; readOnly: boolean }> }).properties;
    const value = t.value as Record<string, string>;
    return Object.fromEntries(Object.entries(value).map(([k, v]) => {
      assert.equal(props[k]?.readOnly, true, `${k} is read-only`);
      return [v, { words: v, at: props[k]?.description ?? '' }];
    }));
  };
  const variable = (p: TracePart, name: string): string | undefined => p.variables?.find((v) => v.name === name)?.preview;

  test('the trace is the contract’s, and nothing went wrong while the page was traced', () => {
    assert.ok(trace, 'parseTrace accepts it');
    assert.deepEqual((r.trace as { logs?: unknown[] }).logs ?? [], []);
    const raw = (r.trace as { edits: { id: string; why?: string }[] }).edits.filter((e) => /^words\./.test(e.id));
    assert.ok(raw.length >= 8);
    for (const e of raw) assert.equal(trace.edits.find((x) => x.id === e.id)?.why, e.why, `${e.id}: its why fits what the trace keeps, whole`);
  });

  test('each theme template file is a part named by its theme, its path there and which theme it is; a plugin’s is not', () => {
    assert.deepEqual(part('header.php').identity, { kind: 'template', theme: 'acme', path: 'header.php', role: 'parent' }, 'the parent theme’s header, under its active child');
    assert.deepEqual(part('footer.php').identity, { kind: 'template', theme: 'acme-child', path: 'footer.php', role: 'child' }, 'the child theme’s own footer');
    assert.deepEqual(part('Page template: archive.php').identity, { kind: 'template', theme: 'acme', path: 'archive.php', role: 'parent' }, 'the page template the hierarchy chose');
    assert.deepEqual(part('template-parts/huge.php').identity, { kind: 'template', theme: 'acme-child', path: 'template-parts/huge.php', role: 'child' });
    assert.equal(part('wp-content/plugins/northwind-events/templates/upcoming.php').identity, undefined, 'a plugin’s template file is no theme’s');
  });

  test('a header’s literal words and an esc_html_e() string become targets on its part, with file and line', () => {
    const header = part('header.php');
    const targets = targetsOf(header);
    const written = targets.find((t) => t.id.startsWith('words.tpl.'));
    assert.equal(written?.label, 'Words written in header.php');
    assert.equal(written?.kind, 'template-override');
    assert.deepEqual(words(written), {
      Hello: { words: 'Hello', at: 'They are on line 12.' },
      ', welcome back': { words: ', welcome back', at: 'They are on line 12.' },
      'Paddle & camp': { words: 'Paddle & camp', at: 'They are on line 15.' },
    }, 'the words typed between its tags, cut where its PHP prints; character references read');
    assert.match(written?.why ?? '', /^These words are written in wp-content\/themes\/acme\/header\.php, a template of the parent theme “Acme”: code, so WordPress keeps no copy of them to change/);
    const acme = targets.find((t) => t.label === 'Words header.php translates (acme)');
    assert.deepEqual(words(acme), {
      'Skip to content': { words: 'Skip to content', at: 'They are on line 9, printed through esc_html_e().' },
      'Primary menu': { words: 'Primary menu', at: 'They are on line 14, printed through esc_attr_e().' },
    });
    assert.ok(acme?.id.startsWith('words.t.'));
    assert.match(acme?.why ?? '', /printed by wp-content\/themes\/acme\/header\.php through a WordPress translation function, in the text domain “acme”\./);
    assert.match(acme?.why ?? '', /A translation file for that text domain \(\.po and \.mo, or \.l10n\.php\) changes them without code; changing the string in the template is a code change/);
    const computedDomain = targets.find((t) => t.label === 'Words header.php translates');
    assert.deepEqual(words(computedDomain), { 'Open daily': { words: 'Open daily', at: 'They are on line 18, printed through _e().' } });
    assert.match(computedDomain?.why ?? '', /in a text domain its code works out/);
    assert.equal(variable(header, 'template.words'), 'read: 3 runs of words, 3 translated strings', 'the part says its file was read');
  });

  test('what a template’s PHP computes is never offered: no guess at a tagline, a name, a joined string, a title, a script or a comment', () => {
    const offered = trace.edits.filter((t) => /^words\./.test(t.id)).flatMap((t) => Object.values(t.value as Record<string, string>));
    for (const never of ['Gear for the north', 'Hello Dana, welcome back', 'Built by', 'Acme Outfitters', 'Not shown', 'Words in a comment', 'Not a translation', 'Made in Northwind Bay']) {
      assert.ok(!offered.some((w) => w.includes(never)), `not offered: ${never}`);
    }
    assert.deepEqual(words(targetsOf(part('Page template: archive.php')).find((t) => t.id.startsWith('words.tpl.'))), { 'Trips we run': { words: 'Trips we run', at: 'They are on line 4.' } }, 'a method called _e() is not the gettext function');
  });

  test('a parent theme’s template under an active child theme says the change belongs in a copy in the child theme', () => {
    const header = targetsOf(part('header.php'));
    const written = header.find((t) => t.id.startsWith('words.tpl.'))?.why ?? '';
    assert.match(written, /a parent theme update would overwrite an edit there\. The change belongs in the active child theme, “Acme Child”: copy the file to wp-content\/themes\/acme-child\/header\.php, which WordPress then uses instead, and change the copy\. An agent can do both from a brief\.$/);
    assert.ok(!written.includes('loaded by its path'), 'get_header() found it through the template lookup, which takes the child’s copy first');
    assert.match(header.find((t) => t.label === 'Words header.php translates (acme)')?.why ?? '', /The template is the parent theme’s, so a code change belongs in a copy of it at the same path in the child theme “Acme Child”\./);
    const footer = targetsOf(part('footer.php'));
    const own = footer.find((t) => t.id.startsWith('words.tpl.'));
    assert.match(own?.why ?? '', /^These words are written in wp-content\/themes\/acme-child\/footer\.php, a template of the active child theme “Acme Child”: code, so WordPress keeps no copy of them to change\. An agent can change the template from a brief\.$/);
    assert.ok(!(own?.why ?? '').includes('child theme:'), 'its own file is changed where it is');
    assert.deepEqual(words(own), {
      'Made in': { words: 'Made in', at: 'They are on line 2.' },
      'Proudly made by Acme': { words: 'Proudly made by Acme', at: 'They are on lines 3 and 6.' },
    });
    assert.deepEqual(Object.keys(words(footer.find((t) => t.label === 'Words footer.php translates (acme-child)'))), ['Theme: %s']);
  });

  test('a plugin’s template says whose it is, and a file too large to read says so and offers nothing', () => {
    const events = targetsOf(part('wp-content/plugins/northwind-events/templates/upcoming.php'));
    const written = events.find((t) => t.id.startsWith('words.tpl.'));
    assert.deepEqual(Object.keys(words(written)), ['Upcoming events']);
    assert.match(written?.why ?? '', /a template of the plugin “northwind-events”: the plugin’s code, which its updates overwrite, so Wanigan does not change it/);
    assert.deepEqual(Object.keys(words(events.find((t) => t.label === 'Words upcoming.php translates (northwind-events)'))), ['No events yet'], 'a double-quoted string is read too');
    const huge = part('template-parts/huge.php');
    assert.equal(variable(huge, 'template.words'), 'not read: it is larger than 256 KB');
    assert.deepEqual(targetsOf(huge).filter((t) => /^words\./.test(t.id)), []);
  });

  test('a term’s name a menu or an archive heading shows is a target with its reach, saved through wp_update_term()', () => {
    const term: EditTarget = {
      id: 'term-5', kind: 'field', label: 'Name of the category “Trips”', via: 'schema',
      schema: { type: 'string', title: 'Name', minLength: 1 }, value: 'Trips', revisions: false,
      shows: 'the category’s archive, every menu built from it and every list that names it',
    };
    assert.deepEqual(trace.edits.find((e) => e.id === 'term-5'), term);
    assert.ok(part('Link: Trips').edits?.includes('term-5'), 'a menu item built from the term, with no text of its own');
    assert.ok(!part('Link: Contact').edits?.some((e) => e.startsWith('term-')), 'a link with its own text shows that text');
    assert.ok(part('Page template: archive.php').edits?.includes('term-5'), 'the archive’s heading, where the template printed it');
    assert.ok(part('footer.php').edits?.includes('term-7'), 'a list of categories');
    assert.equal(trace.edits.find((e) => e.id === 'term-7')?.label, 'Name of the category “Gear & rentals”');
    // Saved as the term editor saves it, slashed; then refused over a name the site no longer has, and empty.
    assert.deepEqual(r.saved, [{ ok: true }, 200]);
    assert.deepEqual(r.updated, [[5, 'category', { name: 'Paddle trips' }]]);
    assert.equal(r.again[1], 409);
    assert.match(r.again[0].error ?? '', /The category’s name changed on the site since the page was shown/);
    assert.equal(r.empty[1], 400, 'a name is required');
  });

  test('a user who may not rename the term is told so on its target', () => {
    const refused = parseTrace(run(['edit_term']).trace) as LiveTrace;
    assert.equal(refused.edits.find((e) => e.id === 'term-5')?.why, 'Your WordPress user cannot rename this category (edit_term).');
  });
});
