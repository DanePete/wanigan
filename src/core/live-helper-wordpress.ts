// The WordPress helper for the live view: one must-use plugin file Wanigan
// writes into wp-content/mu-plugins when the owner asks, and deletes when they
// ask. WordPress loads it by itself, so installing runs nothing. It marks the
// template files that made the page (header.php, template parts, the page
// template's own content), each block, and each post's content; counts
// content changes so the view can reload when content is saved; and shows one
// post alone. It acts only for requests that carry the token written into it,
// which the live view alone sends.
// Design: docs/design/2026-10-08-live-view.md.

export const WORDPRESS_HELPER_VERSION = 1;
export const WORDPRESS_HELPER_FILE = 'wanigan-live.php';
/** A line of the file: how Wanigan knows a file of that name is its own. */
export const WORDPRESS_HELPER_MARK = '// Written by Wanigan for its live view.';

/** The plugin's source, with its token. */
export function wordpressHelper(token: string): string {
  if (!/^[0-9a-f]{16,128}$/.test(token)) throw new Error('A helper token is hex.');
  return `<?php
/**
 * Plugin Name: Wanigan live view
 * Description: Marks what made each part of a page for Wanigan's live view, only for requests that carry its token. Development only: remove it from Wanigan (it is kept out of git).
 * Version: ${WORDPRESS_HELPER_VERSION}
 */

${WORDPRESS_HELPER_MARK}
// wanigan-helper-version: ${WORDPRESS_HELPER_VERSION}

defined('ABSPATH') || exit;

const WANIGAN_LIVE_TOKEN = '${token}';

/**
 * Whether this request came from Wanigan's live view.
 */
function wanigan_live_on(): bool {
  static $on = null;
  if ($on === null) {
    $given = isset($_SERVER['HTTP_X_WANIGAN_LIVE']) ? (string) $_SERVER['HTTP_X_WANIGAN_LIVE'] : '';
    $on = $given !== '' && hash_equals(WANIGAN_LIVE_TOKEN, $given);
  }
  return $on;
}

/**
 * A file's path from the WordPress root, as the live view names it.
 */
function wanigan_live_path(string $file): string {
  $root = wp_normalize_path(ABSPATH);
  $file = wp_normalize_path($file);
  return str_starts_with($file, $root) ? substr($file, strlen($root)) : $file;
}

/**
 * A mark the live view reads: <!-- wl:begin file="..." --> and its end.
 */
function wanigan_live_mark(string $edge, string $kind, string $value): string {
  return "\\n<!-- wl:{$edge} {$kind}=\\"" . esc_attr($value) . "\\" -->\\n";
}

// Each template file WordPress loads (header.php, footer.php, template parts), and the page template's own content:
// what lies between its header and its footer.
$GLOBALS['wanigan_live_page'] = null;
add_filter('template_include', function ($template) {
  $GLOBALS['wanigan_live_page'] = is_string($template) ? wanigan_live_path($template) : null;
  return $template;
}, PHP_INT_MAX);
// The header is the first template loaded after get_header; the page's own content begins when that file ends (not
// when a part the header loads ends).
add_action('get_header', function () { $GLOBALS['wanigan_live_header'] = 'next'; });
add_action('wp_before_load_template', function ($file) {
  if (!wanigan_live_on()) return;
  if (($GLOBALS['wanigan_live_header'] ?? null) === 'next') $GLOBALS['wanigan_live_header'] = (string) $file;
  echo wanigan_live_mark('begin', 'file', wanigan_live_path((string) $file));
}, 10, 1);
add_action('wp_after_load_template', function ($file) {
  if (!wanigan_live_on()) return;
  echo wanigan_live_mark('end', 'file', wanigan_live_path((string) $file));
  if (($GLOBALS['wanigan_live_header'] ?? null) === (string) $file && $GLOBALS['wanigan_live_page']) {
    $GLOBALS['wanigan_live_header'] = null;
    $GLOBALS['wanigan_live_open'] = $GLOBALS['wanigan_live_page'];
    echo wanigan_live_mark('begin', 'file', $GLOBALS['wanigan_live_page']);
  }
}, 10, 1);
add_action('get_footer', function () {
  if (wanigan_live_on() && !empty($GLOBALS['wanigan_live_open'])) {
    echo wanigan_live_mark('end', 'file', $GLOBALS['wanigan_live_open']);
    $GLOBALS['wanigan_live_open'] = null;
  }
});

// Each block: its name on its outermost element.
add_filter('render_block', function ($content, $block) {
  if (!wanigan_live_on() || empty($block['blockName']) || !is_string($content) || $content === '' || !class_exists('WP_HTML_Tag_Processor')) return $content;
  $name = $block['blockName'];
  if ($name === 'core/template-part' && !empty($block['attrs']['slug'])) $name .= ':' . $block['attrs']['slug'];
  $tags = new WP_HTML_Tag_Processor($content);
  if ($tags->next_tag()) {
    $tags->set_attribute('data-wl-block', $name);
    return $tags->get_updated_html();
  }
  return $content;
}, PHP_INT_MAX, 2);

// Each post's content, marked as the post it is.
add_filter('the_content', function ($content) {
  if (!wanigan_live_on() || !in_the_loop()) return $content;
  $post = get_post();
  if (!$post) return $content;
  $id = "post:{$post->post_type}:{$post->ID}:full";
  return wanigan_live_mark('begin', 'entity', $id) . $content . wanigan_live_mark('end', 'entity', $id);
}, PHP_INT_MAX);

// Content changes, counted once a request: what the live view watches to reload when content is saved.
function wanigan_live_changed(): void {
  static $counted = false;
  if ($counted) return;
  $counted = true;
  update_option('wanigan_live_changes', (int) get_option('wanigan_live_changes', 0) + 1, false);
}
foreach (['save_post', 'deleted_post', 'trashed_post', 'untrashed_post', 'edited_term', 'created_term', 'delete_term', 'wp_update_nav_menu', 'customize_save_after', 'switch_theme', 'acf/save_post'] as $hook) {
  add_action($hook, 'wanigan_live_changed');
}
foreach (['added_post_meta', 'updated_post_meta', 'deleted_post_meta'] as $hook) {
  add_action($hook, function ($ids, $object, $key) {
    // An editor's lock and last-edit stamps change while someone merely has the post open.
    if (!str_starts_with((string) $key, '_edit_') && !str_starts_with((string) $key, '_wp_old_')) wanigan_live_changed();
  }, 10, 3);
}
add_action('updated_option', function ($name) {
  if (!preg_match('/^(_transient|_site_transient|cron$|wanigan_live_|rewrite_rules$|recently_activated$|active_plugins$|auto_updater|_wp_session|wp_user_roles$)/', (string) $name)) wanigan_live_changed();
});

// The live view's own routes: what changed, and one post alone.
add_action('init', function () {
  $path = (string) wp_parse_url($_SERVER['REQUEST_URI'] ?? '', PHP_URL_PATH);
  if (!preg_match('#/_wanigan/(changed|save)$#', $path, $m)) return;
  if (!wanigan_live_on()) {
    status_header(403);
    exit;
  }
  nocache_headers();
  if ($m[1] === 'changed') wp_send_json(['changed' => (int) get_option('wanigan_live_changes', 0)]);
  wp_send_json(['ok' => false, 'error' => 'Wanigan does not save WordPress content by hand yet. Change it in WordPress, or ask an agent.'], 409);
}, 0);
add_action('template_redirect', function () {
  $path = (string) wp_parse_url($_SERVER['REQUEST_URI'] ?? '', PHP_URL_PATH);
  if (!preg_match('#/_wanigan/piece/entity/post/(\\d+)/?$#', $path, $m)) return;
  if (!wanigan_live_on()) {
    status_header(403);
    exit;
  }
  $post = get_post((int) $m[1]);
  if (!$post || ($post->post_status !== 'publish' && !current_user_can('read_post', $post->ID))) {
    status_header(404);
    exit;
  }
  status_header(200);
  nocache_headers();
  $GLOBALS['post'] = $post;
  setup_postdata($post);
  echo '<!DOCTYPE html><html ' . get_language_attributes() . '><head><meta charset="' . esc_attr(get_bloginfo('charset')) . '">';
  wp_head();
  echo '</head><body class="wanigan-live-piece"><main style="padding:24px">';
  $id = "post:{$post->post_type}:{$post->ID}:full";
  echo wanigan_live_mark('begin', 'entity', $id) . apply_filters('the_content', $post->post_content) . wanigan_live_mark('end', 'entity', $id);
  echo '</main>';
  wp_footer();
  echo '</body></html>';
  exit;
}, 0);
`;
}
