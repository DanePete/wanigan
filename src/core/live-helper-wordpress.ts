// The WordPress helper for the live view: one must-use plugin file Wanigan
// writes into wp-content/mu-plugins when the owner asks, and deletes when they
// ask. WordPress loads it by itself, so installing runs nothing. For requests
// that carry the token written into it (the live view's own), it traces each
// render through WordPress core's own hooks and APIs: what made every part of
// the page, the callbacks that shaped it, its cost, the data behind it, and
// what can be changed there; and it saves those changes through core's REST
// API as the logged-in user. Every other request is untouched, apart from a
// counter of content changes the view watches to reload.
//
// It names no plugin or theme: anything built on core (themes, block
// libraries, page builders, custom post types, registered meta) shows up
// because it goes through the template hierarchy, the block API, theme.json,
// shortcodes, widgets, menus, options and the REST API.
//
// The trace it serves is src/shared/live-trace.ts; the core code each
// interception point depends on, version by version, is mapped in
// docs/research/2026-10-09-wordpress-core-live-trace.md.
// Design: docs/design/2026-10-08-live-view.md.

export const WORDPRESS_HELPER_VERSION = 2;
export const WORDPRESS_HELPER_FILE = 'wanigan-live.php';
/** A line of the file: how Wanigan knows a file of that name is its own. */
export const WORDPRESS_HELPER_MARK = '// Written by Wanigan for its live view.';

/**
 * The plugin's source, with its token and where WordPress sits in the project
 * (the folder holding wp-content, relative to the project's root: '' when it
 * is the root), so the paths it reports are relative to the project.
 */
export function wordpressHelper(token: string, siteDir = ''): string {
  if (!/^[0-9a-f]{16,128}$/.test(token)) throw new Error('A helper token is hex.');
  const dir = siteDir.replace(/^\/+|\/+$/g, '');
  if (!/^[A-Za-z0-9._/-]*$/.test(dir) || dir.split('/').some((s) => s === '..' || s === '.')) throw new Error('WordPress’s folder must be a plain relative path.');
  return SOURCE.split('__WANIGAN_TOKEN__').join(token)
    .split('__WANIGAN_SITE_DIR__').join(dir)
    .split('__WANIGAN_VERSION__').join(String(WORDPRESS_HELPER_VERSION))
    .split('__WANIGAN_MARK__').join(WORDPRESS_HELPER_MARK);
}

// PHP 7.4 syntax throughout (WordPress 7.1's minimum): a parse error in a
// must-use plugin would take the whole site down, on every request.
const SOURCE = String.raw`<?php
/**
 * Plugin Name: Wanigan live view
 * Description: Shows Wanigan's live view what made each part of a page, and saves changes made there through WordPress, only for requests that carry its token. Development only: remove it from Wanigan (it is kept out of git).
 * Version: __WANIGAN_VERSION__
 */

__WANIGAN_MARK__
// wanigan-helper-version: __WANIGAN_VERSION__
//
// Every interception point below names the core file and function it depends
// on. The full map, with ordering and edge cases: Wanigan's
// docs/research/2026-10-09-wordpress-core-live-trace.md.

defined('ABSPATH') || exit;

const WANIGAN_LIVE_TOKEN = '__WANIGAN_TOKEN__';
/** The folder holding wp-content, relative to the project's root ('' when it is the root). */
const WANIGAN_LIVE_SITE_DIR = '__WANIGAN_SITE_DIR__';

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
 * A file's path from the WordPress root, as the version 1 marks name it.
 */
function wanigan_live_path(string $file): string {
	$root = wp_normalize_path(ABSPATH);
	$file = wp_normalize_path($file);
	return str_starts_with($file, $root) ? substr($file, strlen($root)) : $file;
}

/**
 * A version 1 mark: <!-- wl:begin file="..." --> and its end.
 */
function wanigan_live_mark(string $edge, string $kind, string $value): string {
	return "\n<!-- wl:{$edge} {$kind}=\"" . esc_attr($value) . "\" -->\n";
}

// Content changes, counted once a request on every request: what the live view watches to reload when content is
// saved anywhere (wp-admin, wp-cli, the REST API). The one thing this plugin does for requests without the token,
// and it changes no output.
function wanigan_live_changed(): void {
	static $counted = false;
	if ($counted) return;
	$counted = true;
	update_option('wanigan_live_changes', (int) get_option('wanigan_live_changes', 0) + 1, false);
}
foreach (array('save_post', 'deleted_post', 'trashed_post', 'untrashed_post', 'edited_term', 'created_term', 'delete_term', 'wp_update_nav_menu', 'customize_save_after', 'switch_theme', 'update_option_sidebars_widgets') as $wanigan_live_hook) {
	add_action($wanigan_live_hook, 'wanigan_live_changed');
}
unset($wanigan_live_hook);
foreach (array('added_post_meta', 'updated_post_meta', 'deleted_post_meta') as $wanigan_live_hook) {
	add_action($wanigan_live_hook, function ($ids, $object, $key) {
		// An editor's lock and last-edit stamps change while someone merely has the post open.
		if (!str_starts_with((string) $key, '_edit_') && !str_starts_with((string) $key, '_wp_old_')) wanigan_live_changed();
	}, 10, 3);
}
unset($wanigan_live_hook);
add_action('updated_option', function ($name) {
	if (!preg_match('/^(_transient|_site_transient|cron$|wanigan_live_|rewrite_rules$|recently_activated$|active_plugins$|auto_updater|_wp_session|wp_user_roles$)/', (string) $name)) wanigan_live_changed();
});

/**
 * The trace: everything below runs only for requests that carry the token.
 */
final class Wanigan_Live {
	const KEEP = 20;
	const TTL = 600;
	const MAX_JSON = 4000000;
	const LIMITS = array('parts' => 4000, 'edits' => 4000, 'hooks' => 5000, 'queries' => 2000, 'assets' => 500, 'logs' => 500, 'chain' => 200, 'variables' => 200, 'preview' => 400, 'collections' => 1000, 'palette' => 1000);
	/** Keys whose values are never shown. */
	const SECRET = '/pass|pwd|secret|token|nonce|auth|cookie|salt|session|api[_-]?key|private[_-]?key|credential|signature|hash/i';

	/**
	 * Filters whose callbacks shape a part's output or data. While one of these runs for a traced part, each of its
	 * callbacks is timed and checked for whether it changed the value. Dynamic names (render_block_{name},
	 * wp_nav_menu_{slug}_items, {type}_template_hierarchy, {type}_template) are matched in chain_target().
	 */
	const CHAIN = array(
		'pre_render_block' => 'block', 'render_block_data' => 'block', 'render_block_context' => 'block',
		'render_block' => 'instance', 'block_bindings_source_value' => 'top',
		'the_content' => 'content', 'the_title' => 'single', 'the_excerpt' => 'single', 'get_the_excerpt' => 'excerpt', 'post_thumbnail_html' => 'single',
		'pre_do_shortcode_tag' => 'shortcode', 'do_shortcode_tag' => 'shortcode',
		'dynamic_sidebar_params' => 'widget', 'widget_display_callback' => 'top', 'widget_title' => 'top', 'widget_text' => 'top', 'widget_text_content' => 'top', 'widget_block_content' => 'top', 'widget_custom_html_content' => 'top',
		'wp_nav_menu_args' => 'menu', 'pre_wp_nav_menu' => 'menu', 'wp_nav_menu_objects' => 'top', 'wp_nav_menu_items' => 'top', 'wp_nav_menu' => 'top',
		'nav_menu_item_args' => 'item', 'nav_menu_css_class' => 'item', 'nav_menu_item_id' => 'item', 'nav_menu_item_attributes' => 'item', 'nav_menu_item_title' => 'item', 'nav_menu_link_attributes' => 'item', 'walker_nav_menu_start_el' => 'item',
		'template_include' => 'template',
	);

	/** @var bool This request renders a page that is traced. */
	private static $front = false;
	/** @var bool Collecting: from load until the request is known not to be a page. */
	private static $collecting = false;
	private static $id = '';
	private static $self = '';
	private static $busy = 0;
	private static $seq = 0;
	private static $firings = 0;
	private static $assembled = false;
	private static $stored = false;
	private static $buffered = false;
	/** @var array<string,array> Parts by id. */
	private static $parts = array();
	/** @var array<string,array> What finalising needs to know about each part. */
	private static $meta = array();
	/** @var array[] Open frames: what is rendering now, innermost last. */
	private static $stack = array();
	/** @var object[] Open hook applications whose callbacks are being timed, innermost last. */
	private static $apps = array();
	/** @var array<string,array> Wrapped callbacks to put back, by hook. */
	private static $wrapped = array();
	/** @var SplObjectStorage|null */
	private static $wrappers = null;
	/** @var SplObjectStorage|null Closures, and whether they are this file's own. */
	private static $closures = null;
	private static $acts = array();
	private static $listed = array();
	private static $hooks = array();
	private static $queries = array();
	private static $qcount = 0;
	private static $qms = 0.0;
	private static $logs = array();
	private static $truncated = array();
	private static $pending_block = null;
	private static $pending_menu = null;
	private static $pending_item = null;
	private static $pending_excerpt = null;
	private static $pending_widget = null;
	private static $singles = array();
	private static $shortcodes = array();
	private static $sidebar = null;
	private static $widget = null;
	private static $template = null;
	private static $hierarchy = array();
	private static $candidates = null;
	private static $main = null;
	private static $block_template = null;
	private static $block_json = array();
	private static $trees = array();
	private static $edits = array();
	private static $private = array();
	private static $post_edits = array();
	private static $options_seen = array();
	private static $describe = array();
	private static $whose = array();
	private static $prev_handler = null;
	private static $trace = null;
	private static $present = null;
	private static $nesting = array();
	private static $started = 0.0;

	/* ── starting ───────────────────────────────────────────────────────── */

	/**
	 * Runs when WordPress loads must-use plugins (wp-settings.php, after the database and object cache are up and
	 * before plugins, so before any theme or block is registered).
	 */
	public static function boot(): void {
		self::$self = wp_normalize_path(__FILE__);
		$path = self::request_path();
		if (preg_match('#/_wanigan/(changed|save|trace|edit|move|insert|undo|find)(/|$)#', $path, $m)) {
			// The Go to index lists the wp-admin menu as core builds it for this user. Plugins register their admin
			// pages only in an admin request (many check is_admin() when they load), so this request is one:
			// wp-admin/admin.php defines WP_ADMIN before WordPress loads, and must-use plugins load before plugins.
			// It runs no admin_init and no admin screen; it answers JSON at wp_loaded and stops.
			if ($m[1] === 'find' && !defined('WP_ADMIN')) define('WP_ADMIN', true);
			add_action('wp_loaded', array(self::class, 'route'), PHP_INT_MAX);
			return;
		}
		// A page render goes through index.php (wp-blog-header.php). wp-admin, admin-ajax.php, wp-cron.php,
		// wp-login.php and the REST API (/wp-json/ or ?rest_route=) are never traced.
		$script = basename(isset($_SERVER['SCRIPT_FILENAME']) ? (string) $_SERVER['SCRIPT_FILENAME'] : '');
		if ($script !== 'index.php' || is_admin() || (defined('DOING_AJAX') && DOING_AJAX) || (defined('DOING_CRON') && DOING_CRON) || isset($_GET['rest_route']) || preg_match('#/wp-json(/|$)#', $path)) return;
		self::$collecting = true;
		self::$started = microtime(true);
		self::$id = bin2hex(random_bytes(8));
		self::$wrappers = new SplObjectStorage();
		self::$closures = new SplObjectStorage();
		// class-wpdb.php wpdb::_do_query() logs a query only while SAVEQUERIES is true, reading the constant on every
		// query, so defining it here records every query from now on, for this request only. A wp-config.php that
		// defines it false wins, and the trace says so.
		if (!defined('SAVEQUERIES')) define('SAVEQUERIES', true);
		if (!SAVEQUERIES) self::log('info', 'SAVEQUERIES is false in wp-config.php, so this trace has no queries.', null);
		add_filter('log_query_custom_data', array(self::class, 'logged'), PHP_INT_MAX, 5);
		add_filter('query', array(self::class, 'rows'), PHP_INT_MAX);
		// plugin.php _wp_call_all_hook(): the 'all' hook runs before every action and filter, after did_action()'s
		// count moved and with the hook already on $wp_current_filter.
		add_action('all', array(self::class, 'all'));
		self::$prev_handler = set_error_handler(array(self::class, 'error'));
		foreach (array('doing_it_wrong_run' => 3, 'deprecated_function_run' => 3, 'deprecated_argument_run' => 3, 'deprecated_hook_run' => 4, 'deprecated_file_included' => 4, 'deprecated_class_run' => 3) as $hook => $n) {
			add_action($hook, array(self::class, 'wrong'), 10, $n);
		}
		// blocks.php register_block_type_from_metadata(): the only place a block's block.json path is known.
		add_filter('block_type_metadata', array(self::class, 'block_json'), PHP_INT_MAX);
		add_action('wp', array(self::class, 'decide'), PHP_INT_MAX);
		self::part_hooks();
	}

	/**
	 * class-wp.php WP::main() fires 'wp' once the query is parsed: only now is it known whether this is a page.
	 */
	public static function decide(): void {
		if (is_admin() || wp_doing_ajax() || wp_doing_cron() || (defined('REST_REQUEST') && REST_REQUEST) || (defined('XMLRPC_REQUEST') && XMLRPC_REQUEST) || is_feed() || is_robots() || is_favicon() || is_trackback()) {
			self::stop();
			return;
		}
		self::$front = true;
		// Never let a page cache keep a traced page and serve it to anyone else.
		if (!defined('DONOTCACHEPAGE')) define('DONOTCACHEPAGE', true);
		if (!headers_sent()) {
			header('X-Wanigan-Trace: ' . self::$id);
			nocache_headers();
		}
		// template.php (6.9+): a filter on the whole template's output starts core's own output buffer at
		// wp_before_include_template (priority 1000); the trace is stored when it is flushed, so it can drop parts the
		// page no longer contains.
		add_filter('wp_template_enhancement_output_buffer', array(self::class, 'buffer'), PHP_INT_MAX, 2);
		add_action('wp_template_enhancement_output_buffer_started', function () { Wanigan_Live::$buffer_on = true; });
		add_action('wp_finalized_template_enhancement_output_buffer', array(self::class, 'flushed'), PHP_INT_MAX);
		// shutdown_action_hook() runs 'shutdown'; wp_ob_end_flush_all() flushes buffers at priority 1. Assembling at 0
		// happens outside any output buffer handler, where rendering (ob_start) is still allowed.
		add_action('shutdown', array(self::class, 'assemble'), 0);
		add_action('shutdown', array(self::class, 'store_late'), PHP_INT_MAX);
	}

	/** @var bool core's template output buffer started. */
	public static $buffer_on = false;

	private static function stop(): void {
		self::$collecting = false;
		remove_action('all', array(self::class, 'all'));
		remove_filter('log_query_custom_data', array(self::class, 'logged'), PHP_INT_MAX);
		remove_filter('query', array(self::class, 'rows'), PHP_INT_MAX);
		while (self::$apps) self::finish(array_pop(self::$apps));
	}

	private static function request_path(): string {
		$uri = isset($_SERVER['REQUEST_URI']) ? (string) $_SERVER['REQUEST_URI'] : '';
		return (string) wp_parse_url($uri, PHP_URL_PATH);
	}

	/* ── the 'all' hook ─────────────────────────────────────────────────── */

	/**
	 * Before every action and filter. Counts it, lists its callbacks the first time it fires, opens the part a hook
	 * begins, and times the callbacks of the hooks in CHAIN.
	 */
	public static function all($hook): void {
		if (self::$busy || !self::$collecting || !is_string($hook)) return;
		self::$busy++;
		try {
			self::$firings++;
			global $wp_filter, $wp_actions, $wp_current_filter;
			// plugin.php do_action() increments $wp_actions before calling 'all'; apply_filters() increments $wp_filters.
			$n = isset($wp_actions[$hook]) ? $wp_actions[$hook] : 0;
			$action = $n !== (isset(self::$acts[$hook]) ? self::$acts[$hook] : 0);
			if ($action) self::$acts[$hook] = $n;
			$depth = is_array($wp_current_filter) ? count($wp_current_filter) : 0;
			// An application at this depth or deeper has ended: a sibling or a shallower hook is starting.
			while (self::$apps && end(self::$apps)->depth >= $depth) self::finish(array_pop(self::$apps));
			if (!isset(self::$listed[$hook])) {
				self::$listed[$hook] = true;
				if (isset($wp_filter[$hook])) self::list_hook($hook, $action);
			}
			if (!self::$front || $action) return;
			$args = func_get_args();
			$target = self::open_for($hook, $args);
			$chain = self::chain_target($hook, $args, $target);
			if ($chain !== false) self::begin($hook, $depth, $args, $chain);
		} catch (Throwable $e) {
			self::log('warning', 'Wanigan’s trace stumbled on ' . $hook . ': ' . $e->getMessage(), null);
		} finally {
			self::$busy--;
		}
	}

	/** Every callback on a hook the first time it fires, in priority order: the request-wide list. */
	private static function list_hook(string $hook, bool $action): void {
		global $wp_filter;
		foreach ($wp_filter[$hook]->callbacks as $priority => $callbacks) {
			foreach ($callbacks as $cb) {
				if (self::ours($cb['function'])) continue;
				if (count(self::$hooks) >= self::LIMITS['hooks']) {
					self::$truncated['hooks'] = true;
					return;
				}
				$d = self::describe($cb['function']);
				$step = array('hook' => ($action ? 'action:' : 'filter:') . $hook, 'by' => $d['by'], 'callback' => $d['callback'], 'priority' => (int) $priority);
				if ($d['source']) $step['source'] = $d['source'];
				self::$hooks[] = $step;
			}
		}
	}

	/**
	 * Opens the part a filter begins, before its callbacks run, and answers what that part is.
	 */
	private static function open_for(string $hook, array $args) {
		switch ($hook) {
			case 'pre_render_block':
				return self::pending_block($args);
			case 'interactivity_process_directives':
				// class-wp-block.php WP_Block::render() (6.6+) applies this first thing, on every render of every block.
				self::block_start();
				return null;
			case 'the_content':
				return self::content_start();
			case 'the_title':
			case 'the_excerpt':
			case 'post_thumbnail_html':
				return self::single_start($hook, $args);
			case 'get_the_excerpt':
				self::$pending_excerpt = (object) array('steps' => array(), 'start' => hrtime(true));
				return self::$pending_excerpt;
			case 'pre_do_shortcode_tag':
				return self::shortcode_start($args);
			case 'dynamic_sidebar_params':
				return self::widget_next($args);
			case 'wp_nav_menu_args':
				self::$pending_menu = (object) array('steps' => array(), 'start' => hrtime(true), 'q0' => self::$qcount, 'qms0' => self::$qms);
				return self::$pending_menu;
			case 'wp_nav_menu_objects':
				return self::menu_start($args);
			case 'nav_menu_item_args':
				return self::item_start($args);
		}
		if (substr($hook, -19) === '_template_hierarchy') {
			if (!has_filter($hook, array(self::class, 'hierarchy'))) add_filter($hook, array(self::class, 'hierarchy'), PHP_INT_MAX);
			if (!self::$template) self::$template = (object) array('steps' => array());
			return self::$template;
		}
		if (strpos($hook, 'render_block_') === 0 && $hook !== 'render_block_data' && $hook !== 'render_block_context') {
			// class-wp-block.php: "render_block_{$this->name}" is the last filter on a block's output.
			if (!has_filter($hook, array(self::class, 'block_end'))) add_filter($hook, array(self::class, 'block_end'), PHP_INT_MAX, 3);
		}
		return null;
	}

	/**
	 * Where the steps of a CHAIN hook's callbacks go: a part id, a pending object, or null for an application that is
	 * not traced. False for a hook that is not timed at all.
	 */
	private static function chain_target(string $hook, array $args, $opened) {
		$kind = isset(self::CHAIN[$hook]) ? self::CHAIN[$hook] : null;
		if ($kind === null) {
			if (strpos($hook, 'render_block_') === 0 && strpos($hook, '/') !== false) $kind = 'instance';
			elseif (preg_match('/^wp_nav_menu_.+_items$/', $hook)) $kind = 'top';
			elseif (substr($hook, -19) === '_template_hierarchy') $kind = 'template';
			elseif (self::$hierarchy && $hook === end(self::$hierarchy)['type'] . '_template') $kind = 'template';
			else return false;
		}
		switch ($kind) {
			case 'block':
				return self::$pending_block;
			case 'instance':
				$instance = isset($args[3]) ? $args[3] : null;
				if (!$instance instanceof WP_Block) return null;
				$i = self::frame_index(spl_object_id($instance));
				return ($i !== null && self::$stack[$i]['type'] !== 'skip') ? self::$stack[$i]['part'] : null;
			case 'top':
				$f = end(self::$stack);
				return ($f && $f['type'] === 'part') ? $f['part'] : null;
			case 'content':
			case 'single':
			case 'shortcode':
			case 'widget':
				return $opened;
			case 'excerpt':
				return self::$pending_excerpt;
			case 'menu':
				return self::$pending_menu;
			case 'item':
				return self::$pending_item;
			case 'template':
				if (!self::$template) self::$template = (object) array('steps' => array());
				return self::$template;
		}
		return null;
	}

	/**
	 * class-wp-hook.php WP_Hook::apply_filters() calls $callbacks[$priority][$key]['function'] for each callback,
	 * reading each priority's array as it reaches it. Swapping the 'function' for a timing wrapper, under the same
	 * key, leaves has_filter() and remove_filter() working (they look up the key, never the callable), and the
	 * wrapper receives exactly the arguments WP_Hook sliced to accepted_args. The originals go back as soon as the
	 * hook is no longer running (finish()).
	 */
	private static function begin(string $hook, int $depth, array $args, $target): void {
		$rec = new stdClass();
		$rec->hook = $hook;
		$rec->depth = $depth;
		$rec->steps = array();
		$rec->target = $target;
		$rec->consumed = false;
		// apply_filters() passes ($hook_name, $value, ...$args) to 'all'.
		$rec->value = count($args) > 1 ? $args[1] : null;
		$rec->start = hrtime(true);
		self::$apps[] = $rec;
		if ($target === null) return;
		global $wp_filter;
		if (!isset($wp_filter[$hook])) return;
		$h = $wp_filter[$hook];
		foreach ($h->callbacks as $priority => $callbacks) {
			foreach ($callbacks as $key => $cb) {
				$fn = $cb['function'];
				if ((is_object($fn) && self::$wrappers->contains($fn)) || self::ours($fn)) continue;
				$wrapper = self::wrap($hook, (int) $priority, $fn);
				$h->callbacks[$priority][$key]['function'] = $wrapper;
				self::$wrapped[$hook][] = array($priority, $key, $fn, $wrapper);
			}
		}
	}

	private static function wrap(string $hook, int $priority, $fn): Closure {
		$d = self::describe($fn);
		$wrapper = static function () use ($hook, $priority, $fn, $d) {
			$args = func_get_args();
			$rec = self::open_record($hook);
			if (!$rec || $rec->target === null) return call_user_func_array($fn, $args);
			$in = $args ? $args[0] : $rec->value;
			$t = hrtime(true);
			$out = call_user_func_array($fn, $args);
			$ms = (hrtime(true) - $t) / 1e6;
			$rec->value = $out;
			if (count($rec->steps) < self::LIMITS['chain']) {
				$step = array('hook' => 'filter:' . $hook, 'by' => $d['by'], 'callback' => $d['callback'], 'ms' => round($ms, 3), 'priority' => $priority, 'changed' => self::changed($in, $out));
				if ($d['source']) $step['source'] = $d['source'];
				$rec->steps[] = $step;
			}
			return $out;
		};
		self::$wrappers->attach($wrapper);
		return $wrapper;
	}

	/** The innermost running application of a hook. */
	public static function open_record(string $hook) {
		for ($i = count(self::$apps) - 1; $i >= 0; $i--) {
			if (self::$apps[$i]->hook === $hook) return self::$apps[$i];
		}
		return null;
	}

	/** An application ended: its steps go where they belong, and its callbacks go back when nothing runs it. */
	private static function finish($rec): void {
		if (!$rec->consumed && $rec->target !== null && $rec->steps) self::deliver($rec->target, $rec->steps);
		if (isset(self::$wrapped[$rec->hook]) && !self::open_record($rec->hook)) self::restore($rec->hook);
	}

	private static function restore(string $hook): void {
		global $wp_filter;
		foreach (self::$wrapped[$hook] as $w) {
			list($priority, $key, $fn, $wrapper) = $w;
			if (isset($wp_filter[$hook]) && isset($wp_filter[$hook]->callbacks[$priority][$key]) && $wp_filter[$hook]->callbacks[$priority][$key]['function'] === $wrapper) {
				$wp_filter[$hook]->callbacks[$priority][$key]['function'] = $fn;
			}
			self::$wrappers->detach($wrapper);
		}
		unset(self::$wrapped[$hook]);
	}

	private static function deliver($target, array $steps): void {
		if (is_object($target)) {
			$target->steps = array_merge($target->steps, $steps);
			return;
		}
		if (!is_string($target) || !isset(self::$parts[$target])) return;
		$chain = isset(self::$parts[$target]['chain']) ? self::$parts[$target]['chain'] : array();
		foreach ($steps as $s) {
			if (count($chain) >= self::LIMITS['chain']) {
				self::$truncated['chain:' . $target] = true;
				break;
			}
			$chain[] = $s;
		}
		self::$parts[$target]['chain'] = $chain;
	}

	/** Take the steps of the running application of the current filter (a closer is its last callback). */
	private static function take(string $hook): array {
		$rec = self::open_record($hook);
		if (!$rec || $rec->consumed) return array();
		$rec->consumed = true;
		return $rec->steps;
	}

	/** What a callback changed: nothing, the output, or the keys of an array it returned. */
	public static function changed($in, $out): array {
		if ($in === $out) return array();
		if (is_array($in) && is_array($out)) {
			$keys = array();
			foreach (array_unique(array_merge(array_keys($in), array_keys($out))) as $k) {
				if (!array_key_exists($k, $in) || !array_key_exists($k, $out) || $in[$k] !== $out[$k]) {
					if ($k === 'attrs' && isset($in['attrs'], $out['attrs']) && is_array($in['attrs']) && is_array($out['attrs'])) {
						foreach (array_unique(array_merge(array_keys($in['attrs']), array_keys($out['attrs']))) as $a) {
							if (!array_key_exists($a, $in['attrs']) || !array_key_exists($a, $out['attrs']) || $in['attrs'][$a] !== $out['attrs'][$a]) $keys[] = 'attrs.' . $a;
						}
					} else {
						$keys[] = (string) $k;
					}
				}
				if (count($keys) >= 20) break;
			}
			return $keys ? $keys : array('value');
		}
		return array(is_string($in) || is_string($out) ? 'output' : 'value');
	}

	/* ── frames and parts ───────────────────────────────────────────────── */

	private static function new_part(string $kind, string $label, array $extra = array()): string {
		$id = 'p' . (++self::$seq);
		$part = array('id' => $id, 'kind' => $kind, 'label' => self::cut($label, 300));
		$parent = self::top_part();
		if ($parent) $part['parent'] = $parent;
		self::$parts[$id] = array_merge($part, $extra);
		self::$meta[$id] = array();
		return $id;
	}

	private static function open(string $kind, string $label, array $extra = array(), array $frame = array(), $pending = null): string {
		$id = self::new_part($kind, $label, $extra);
		self::$stack[] = array_merge(array(
			'type' => 'part', 'part' => $id, 'children' => 0, 'map' => null,
			'start' => $pending ? $pending->start : hrtime(true),
			'q0' => ($pending && isset($pending->q0)) ? $pending->q0 : self::$qcount,
			'qms0' => ($pending && isset($pending->qms0)) ? $pending->qms0 : self::$qms,
		), $frame);
		if ($pending && $pending->steps) self::deliver($id, $pending->steps);
		return $id;
	}

	/** Close a part's frame, and any left open above it (a render that returned early). */
	private static function close(string $id): void {
		for ($i = count(self::$stack) - 1; $i >= 0; $i--) {
			if (self::$stack[$i]['type'] === 'part' && self::$stack[$i]['part'] === $id) break;
		}
		if ($i < 0) return;
		while (count(self::$stack) > $i) {
			$f = array_pop(self::$stack);
			if ($f['type'] === 'part') self::cost($f);
		}
	}

	private static function cost(array $f): void {
		$cost = array('ms' => round((hrtime(true) - $f['start']) / 1e6, 3));
		if (SAVEQUERIES) {
			$cost['queries'] = self::$qcount - $f['q0'];
			$cost['queryMs'] = round(self::$qms - $f['qms0'], 3);
		}
		self::$parts[$f['part']]['cost'] = $cost;
	}

	/** The part being rendered now. */
	private static function top_part(): ?string {
		for ($i = count(self::$stack) - 1; $i >= 0; $i--) {
			if (self::$stack[$i]['part']) return self::$stack[$i]['part'];
		}
		return null;
	}

	private static function frame_index(int $oid): ?int {
		for ($i = count(self::$stack) - 1; $i >= 0; $i--) {
			if (isset(self::$stack[$i]['block']) && self::$stack[$i]['block'] === $oid) return $i;
		}
		return null;
	}

	private static function begin_mark(string $id): string {
		return '<!-- wl:part id="' . $id . '" -->';
	}

	private static function end_mark(string $id): string {
		return '<!-- /wl:part id="' . $id . '" -->';
	}

	/**
	 * A part's output between its marks. Output with no markup is left as it is (it may end up in an attribute),
	 * unless core is known to print it as text ($text: the_title() and the_excerpt() echo it between tags).
	 */
	private static function marked(string $id, $html, bool $text = false) {
		if (!is_string($html) || trim($html) === '' || (!$text && strpos($html, '<') === false)) return $html;
		self::$meta[$id]['marked'] = true;
		return self::begin_mark($id) . $html . self::end_mark($id);
	}

	/* ── what the parts are ─────────────────────────────────────────────── */

	private static function part_hooks(): void {
		// template.php load_template() fires these around every template file it requires (header.php, template parts).
		add_action('wp_before_load_template', array(self::class, 'template_start'), PHP_INT_MAX, 3);
		add_action('wp_after_load_template', array(self::class, 'template_end'), -PHP_INT_MAX, 3);
		// general-template.php get_header()/get_footer()/get_sidebar()/get_template_part(): the names locate_template() will try.
		foreach (array('get_header' => 'header', 'get_footer' => 'footer', 'get_sidebar' => 'sidebar') as $hook => $slug) {
			add_action($hook, function ($name = null) use ($slug) {
				$name = (string) $name;
				Wanigan_Live::candidates($name !== '' ? array("{$slug}-{$name}.php", "{$slug}.php") : array("{$slug}.php"));
			}, PHP_INT_MAX, 1);
		}
		add_action('get_template_part', function ($slug, $name, $templates) { Wanigan_Live::candidates((array) $templates); }, PHP_INT_MAX, 3);
		// template-loader.php (7.0+): the chosen template, just before it is included.
		add_action('wp_before_include_template', array(self::class, 'main_start'), PHP_INT_MAX, 1);
		add_filter('template_include', array(self::class, 'template_chosen'), PHP_INT_MAX);
		add_action('wp_head', array(self::class, 'block_template_end'), -PHP_INT_MAX);
		add_action('wp_body_open', array(self::class, 'block_template_begin_mark'), PHP_INT_MAX);
		add_action('wp_footer', array(self::class, 'block_template_end_mark'), -PHP_INT_MAX);
		add_filter('pre_render_block', array(self::class, 'pre_render_end'), PHP_INT_MAX, 3);
		add_action('render_block_core_template_part_post', array(self::class, 'template_part_source'), PHP_INT_MAX, 4);
		add_action('render_block_core_template_part_file', array(self::class, 'template_part_source'), PHP_INT_MAX, 4);
		add_action('render_block_core_template_part_none', array(self::class, 'template_part_source'), PHP_INT_MAX, 3);
		add_filter('block_bindings_source_value', array(self::class, 'binding'), PHP_INT_MAX, 5);
		add_filter('the_content', array(self::class, 'content_end'), PHP_INT_MAX);
		add_filter('the_title', array(self::class, 'single_end'), PHP_INT_MAX, 2);
		add_filter('the_excerpt', array(self::class, 'single_end'), PHP_INT_MAX);
		add_filter('post_thumbnail_html', array(self::class, 'single_end'), PHP_INT_MAX, 2);
		add_filter('pre_do_shortcode_tag', array(self::class, 'shortcode_short'), PHP_INT_MAX, 4);
		add_filter('do_shortcode_tag', array(self::class, 'shortcode_end'), PHP_INT_MAX, 4);
		add_action('dynamic_sidebar_before', array(self::class, 'sidebar_start'), PHP_INT_MAX, 2);
		add_filter('dynamic_sidebar_params', array(self::class, 'widget_marks'), PHP_INT_MAX);
		add_action('dynamic_sidebar', array(self::class, 'widget_start'), PHP_INT_MAX);
		add_action('dynamic_sidebar_after', array(self::class, 'sidebar_end'), -PHP_INT_MAX, 2);
		add_filter('pre_wp_nav_menu', array(self::class, 'menu_short'), PHP_INT_MAX, 2);
		add_filter('wp_nav_menu', array(self::class, 'menu_end'), PHP_INT_MAX, 2);
		add_filter('walker_nav_menu_start_el', array(self::class, 'item_end'), PHP_INT_MAX, 4);
		foreach (array('option_blogname' => 'blogname', 'option_blogdescription' => 'blogdescription') as $hook => $option) {
			add_filter($hook, function ($value) use ($option) { Wanigan_Live::option_seen($option); return $value; }, PHP_INT_MAX);
		}
	}

	public static function candidates(array $templates): void {
		if (self::$front) self::$candidates = array_values(array_filter($templates, 'is_string'));
	}

	/** The theme's own name for a template file: its path inside the theme, or its path in the project. */
	private static function theme_name(string $file): string {
		$f = wp_normalize_path($file);
		foreach (array(get_stylesheet_directory(), get_template_directory()) as $dir) {
			$d = wp_normalize_path($dir) . '/';
			if (strpos($f, $d) === 0) return substr($f, strlen($d));
		}
		$rel = self::rel($f);
		return $rel !== null ? $rel : basename($f);
	}

	public static function template_start($file, $load_once = true, $args = array()): void {
		if (!self::$front || !is_string($file)) return;
		self::$busy++;
		try {
			$name = self::theme_name($file);
			$extra = array();
			$src = self::source($file, 1);
			if ($src) $extra['source'] = $src;
			if (self::$candidates) {
				$alts = array();
				foreach (self::$candidates as $c) {
					$located = locate_template(array($c));
					$alt = array('name' => $c, 'exists' => $located !== '');
					$r = $located !== '' ? self::rel($located) : null;
					if ($r !== null) $alt['file'] = $r;
					if ($located !== '' && wp_normalize_path($located) === wp_normalize_path($file)) $alt['chosen'] = true;
					$alts[] = $alt;
				}
				$extra['alternatives'] = $alts;
				self::$candidates = null;
			}
			if (is_array($args) && $args) $extra['variables'] = self::variables($args, 'args');
			$id = self::open('template', $name, $extra);
			self::$meta[$id] = array('file' => wp_normalize_path($file));
			echo self::begin_mark($id);
			self::$meta[$id]['marked'] = true;
		} finally {
			self::$busy--;
		}
	}

	public static function template_end($file): void {
		if (!self::$front || !is_string($file)) return;
		$f = wp_normalize_path($file);
		for ($i = count(self::$stack) - 1; $i >= 0; $i--) {
			$p = self::$stack[$i]['part'];
			if (self::$stack[$i]['type'] === 'part' && isset(self::$meta[$p]['file']) && self::$meta[$p]['file'] === $f && empty(self::$meta[$p]['main'])) {
				echo self::end_mark($p);
				self::close($p);
				return;
			}
		}
	}

	/** template_include's final answer: what template-loader.php includes (a plugin may have replaced the theme's). */
	public static function template_chosen($template) {
		if (self::$front && self::$template) self::$template->chosen = is_string($template) ? $template : '';
		return $template;
	}

	/** Each {type}_template_hierarchy filter's final list (template.php get_query_template()). */
	public static function hierarchy($templates) {
		if (self::$front) {
			$type = substr(current_filter(), 0, -19);
			self::$hierarchy[] = array('type' => $type, 'templates' => array_values(array_filter((array) $templates, 'is_string')));
			$hook = $type . '_template';
			if (!has_filter($hook, array(self::class, 'located'))) add_filter($hook, array(self::class, 'located'), PHP_INT_MAX, 3);
		}
		return $templates;
	}

	/** get_query_template()'s answer for a type: the file locate_template() found, or the block template canvas. */
	public static function located($template) {
		if (self::$front && self::$hierarchy) {
			$last = count(self::$hierarchy) - 1;
			self::$hierarchy[$last]['located'] = is_string($template) ? $template : '';
		}
		return $template;
	}

	/**
	 * template-loader.php fires wp_before_include_template (7.0+) with the realpath of the template it is about to
	 * include. Nothing fires after the include returns, so this part ends when the page does: its end mark is
	 * printed at shutdown, inside core's output buffer, after </html>.
	 */
	public static function main_start($template): void {
		if (!self::$front || !is_string($template) || self::$main) return;
		self::$busy++;
		try {
			$file = wp_normalize_path($template);
			$canvas = $file === wp_normalize_path(ABSPATH . WPINC . '/template-canvas.php');
			$extra = array();
			$src = self::source($file, 1);
			if ($src) $extra['source'] = $src;
			$extra['variables'] = self::query_variables();
			$label = $canvas ? 'Block template canvas' : 'Page template: ' . self::theme_name($file);
			$id = self::open('template', $label, $extra);
			self::$meta[$id] = array('file' => $file, 'main' => true, 'canvas' => $canvas);
			self::$main = $id;
			echo self::begin_mark($id);
			self::$meta[$id]['marked'] = true;
			global $_wp_current_template_id;
			if ($canvas && is_string($_wp_current_template_id) && $_wp_current_template_id !== '') {
				// block-template.php locate_block_template() resolved the wp_template; template-canvas.php renders it
				// with get_the_block_template_html() before wp_head(), and prints it between wp_body_open() and wp_footer().
				$tpl = get_block_template($_wp_current_template_id, 'wp_template');
				$t = $tpl ? $tpl->title : $_wp_current_template_id;
				$bid = self::open('template', 'Template: ' . $t, array(), array('map' => array('store' => 'tpl:' . $_wp_current_template_id, 'path' => array())));
				self::$meta[$bid] = array('wp_template' => $_wp_current_template_id);
				self::$block_template = $bid;
			}
		} finally {
			self::$busy--;
		}
	}

	public static function block_template_end(): void {
		if (self::$front && self::$block_template) self::close(self::$block_template);
	}

	public static function block_template_begin_mark(): void {
		if (self::$front && self::$block_template && empty(self::$meta[self::$block_template]['marked'])) {
			echo self::begin_mark(self::$block_template);
			self::$meta[self::$block_template]['marked'] = true;
		}
	}

	public static function block_template_end_mark(): void {
		if (self::$front && self::$block_template && !empty(self::$meta[self::$block_template]['marked']) && empty(self::$meta[self::$block_template]['ended'])) {
			echo self::end_mark(self::$block_template);
			self::$meta[self::$block_template]['ended'] = true;
		}
	}

	/* blocks */

	/**
	 * blocks.php render_block() and class-wp-block.php WP_Block::render() apply pre_render_block before every block,
	 * top-level and inner, with the parsed block and its parent WP_Block (null at the top). Its place among its
	 * siblings is counted here, in the order WP_Block::render() walks inner_content.
	 */
	private static function pending_block(array $args) {
		$parsed = isset($args[2]) && is_array($args[2]) ? $args[2] : array();
		$parent = isset($args[3]) ? $args[3] : null;
		$p = (object) array('name' => isset($parsed['blockName']) ? $parsed['blockName'] : null, 'block' => $parsed, 'steps' => array(), 'start' => hrtime(true), 'q0' => self::$qcount, 'qms0' => self::$qms, 'map' => null, 'parent' => null);
		$i = $parent instanceof WP_Block ? self::frame_index(spl_object_id($parent)) : (self::$stack ? count(self::$stack) - 1 : null);
		if ($i !== null) {
			$index = self::$stack[$i]['children']++;
			$map = self::$stack[$i]['map'];
			if ($map && $p->name !== null) $p->map = self::map_child($map, $index, $parsed);
			$p->parent = self::$stack[$i]['part'];
		}
		self::$pending_block = $p;
		return $p;
	}

	/** pre_render_block's last callback: a non-null answer replaces the block's whole render. */
	public static function pre_render_end($pre, $parsed = null, $parent = null) {
		if (!self::$front || $pre === null || !self::$pending_block) return $pre;
		self::$busy++;
		try {
			$p = self::$pending_block;
			self::$pending_block = null;
			if ($p->name === null) return $pre;
			$id = self::new_part('block', self::block_label($p->name), $p->parent ? array('parent' => $p->parent) : array());
			self::$meta[$id] = array('block' => $p->name, 'parsed' => $p->block, 'map' => $p->map, 'short' => true);
			self::deliver($id, array_merge($p->steps, self::take('pre_render_block')));
			self::$parts[$id]['cost'] = array('ms' => round((hrtime(true) - $p->start) / 1e6, 3));
			return self::marked($id, $pre);
		} finally {
			self::$busy--;
		}
	}

	/**
	 * The start of WP_Block::render(), from the interactivity_process_directives filter it applies first; the block
	 * is the object on that frame. A second render() of the same instance inside the first (core/block renders its
	 * synced pattern this way) belongs to the first.
	 */
	private static function block_start(): void {
		$block = null;
		foreach (debug_backtrace(DEBUG_BACKTRACE_PROVIDE_OBJECT | DEBUG_BACKTRACE_IGNORE_ARGS, 8) as $f) {
			if (isset($f['object'], $f['function']) && $f['function'] === 'render' && $f['object'] instanceof WP_Block) {
				$block = $f['object'];
				break;
			}
		}
		if (!$block) return;
		$oid = spl_object_id($block);
		$top = end(self::$stack);
		if ($top && isset($top['block']) && $top['block'] === $oid) {
			self::$stack[] = array('type' => 're', 'part' => $top['part'], 'block' => $oid, 'children' => 0, 'map' => null);
			return;
		}
		$p = self::$pending_block;
		self::$pending_block = null;
		if ($p && $p->name !== $block->name) $p = null;
		if (!$block->name || !$block->block_type) {
			// Freeform HTML between blocks, and core/null (the copies post-template renders): not parts of their own.
			self::$stack[] = array('type' => 'skip', 'part' => self::top_part(), 'block' => $oid, 'children' => 0, 'map' => null);
			return;
		}
		$id = self::open('block', self::block_label($block->name), array(), array('block' => $oid), $p);
		self::$meta[$id] = array('block' => $block->name, 'parsed' => $block->parsed_block, 'map' => $p ? $p->map : null, 'context' => is_array($block->context) ? $block->context : array());
		// Its inner blocks are found in the same stored tree.
		if ($p && $p->map) self::$stack[count(self::$stack) - 1]['map'] = $p->map;
	}

	/** "render_block_{$name}"'s last callback: the block's output, final. */
	public static function block_end($content, $parsed = null, $instance = null) {
		if (!self::$front || !$instance instanceof WP_Block) return $content;
		self::$busy++;
		try {
			$i = self::frame_index(spl_object_id($instance));
			if ($i === null) {
				// A render whose start was not seen (WordPress before 6.6): a part with no cost.
				if (!$instance->name || !$instance->block_type) return $content;
				$id = self::new_part('block', self::block_label($instance->name));
				self::$meta[$id] = array('block' => $instance->name, 'parsed' => $instance->parsed_block, 'map' => null, 'context' => (array) $instance->context);
				self::deliver($id, self::take(current_filter()));
				return self::marked($id, $content);
			}
			$f = self::$stack[$i];
			if ($f['type'] !== 'part') {
				array_splice(self::$stack, $i);
				return $content;
			}
			self::close($f['part']);
			self::deliver($f['part'], self::take(current_filter()));
			return self::marked($f['part'], $content);
		} finally {
			self::$busy--;
		}
	}

	/** blocks/template-part.php render_block_core_template_part() says where a template part's content came from. */
	public static function template_part_source($id, $attributes = array(), $from = null, $content = null): void {
		if (!self::$front) return;
		$f = end(self::$stack);
		if (!$f || $f['type'] !== 'part' || !isset(self::$meta[$f['part']]['block']) || self::$meta[$f['part']]['block'] !== 'core/template-part') return;
		$part = $f['part'];
		self::$meta[$part]['tp'] = (string) $id;
		$action = current_action();
		if ($action === 'render_block_core_template_part_post' && $from instanceof WP_Post) self::$meta[$part]['tp_post'] = $from->ID;
		if ($action === 'render_block_core_template_part_file' && is_string($from) && $from !== '') self::$meta[$part]['tp_file'] = $from;
		if ($action !== 'render_block_core_template_part_none') {
			// _wp_apply_block_content_filters() runs do_blocks() on this content next: its top-level blocks are this part's.
			self::$stack[count(self::$stack) - 1]['map'] = array('store' => 'tp:' . $id, 'path' => array());
		}
	}

	/** class-wp-block-bindings-source.php get_value(): an attribute whose value comes from a binding source. */
	public static function binding($value, $source = '', $args = array(), $instance = null, $attribute = '') {
		if (self::$front && $instance instanceof WP_Block) {
			$i = self::frame_index(spl_object_id($instance));
			if ($i !== null && self::$stack[$i]['type'] === 'part') {
				self::$meta[self::$stack[$i]['part']]['bindings'][(string) $attribute] = array('source' => (string) $source, 'args' => is_array($args) ? $args : array(), 'value' => $value);
			}
		}
		return $value;
	}

	/* posts */

	/**
	 * the_content is a post's content only when post-template.php the_content() applies it, when the post-content
	 * block does (blocks/post-content.php), or when a theme file applies it itself. Other callers (excerpts, feeds,
	 * meta descriptions, the REST API) are not a part of the page.
	 */
	private static function content_start() {
		$site = self::filter_site('apply_filters');
		if (!$site) return null;
		$ok = in_array($site['caller'], array('the_content', 'render_block_core_post_content'), true) || self::in_theme($site['file']);
		$post = get_post();
		if (!$ok || !$post instanceof WP_Post) return null;
		$type = get_post_type_object($post->post_type);
		$label = ($type ? $type->labels->singular_name : $post->post_type) . ' ' . $post->ID . ($post->post_title !== '' ? ': ' . wp_strip_all_tags($post->post_title) : '');
		$extra = array();
		$src = self::caller_source();
		if ($src) $extra['source'] = $src;
		$id = self::open('entity', $label, $extra, array('map' => array('store' => 'post:' . $post->ID, 'path' => array())));
		self::$meta[$id] = array('post' => $post->ID, 'content' => true);
		return $id;
	}

	public static function content_end($content) {
		if (!self::$front) return $content;
		$rec = self::open_record('the_content');
		if (!$rec || !is_string($rec->target) || !isset(self::$meta[$rec->target]['content'])) return $content;
		self::$busy++;
		try {
			$id = $rec->target;
			self::close($id);
			self::deliver($id, self::take('the_content'));
			return self::marked($id, $content);
		} finally {
			self::$busy--;
		}
	}

	/**
	 * the_title, the_excerpt and post_thumbnail_html are parts only when post-template.php the_title() /
	 * the_excerpt() / post-thumbnail-template.php the_post_thumbnail() print them: get_the_title() also fills
	 * attributes, menus and feeds.
	 */
	private static function single_start(string $hook, array $args) {
		$printer = array('the_title' => 'the_title', 'the_excerpt' => 'the_excerpt', 'post_thumbnail_html' => 'the_post_thumbnail');
		$found = false;
		foreach (debug_backtrace($hook === 'the_title' ? 0 : DEBUG_BACKTRACE_IGNORE_ARGS, 10) as $f) {
			if (!isset($f['class']) && isset($f['function']) && $f['function'] === $printer[$hook]) {
				// the_title( $before, $after, $display = true ): a title it returns may go anywhere.
				if ($hook === 'the_title' && isset($f['args'][2]) && !$f['args'][2]) return null;
				$found = true;
				break;
			}
		}
		$post = get_post();
		if (!$found || !$post instanceof WP_Post) return null;
		$p = (object) array('hook' => $hook, 'post' => $post->ID, 'steps' => array(), 'start' => hrtime(true));
		if ($hook === 'the_excerpt' && self::$pending_excerpt) {
			$p->steps = self::$pending_excerpt->steps;
			$p->start = self::$pending_excerpt->start;
			self::$pending_excerpt = null;
		}
		self::$singles[] = $p;
		return $p;
	}

	public static function single_end($value) {
		if (!self::$front || !self::$singles) return $value;
		$hook = current_filter();
		$rec = self::open_record($hook);
		if (!$rec || !is_object($rec->target) || !isset($rec->target->hook) || $rec->target->hook !== $hook) return $value;
		self::$busy++;
		try {
			$p = $rec->target;
			self::$singles = array_values(array_filter(self::$singles, function ($s) use ($p) { return $s !== $p; }));
			$labels = array('the_title' => 'Title', 'the_excerpt' => 'Excerpt', 'post_thumbnail_html' => 'Featured image');
			$id = self::new_part('field', $labels[$hook]);
			self::$meta[$id] = array('post' => $p->post, 'field' => $hook);
			self::deliver($id, array_merge($p->steps, self::take($hook)));
			self::$parts[$id]['cost'] = array('ms' => round((hrtime(true) - $p->start) / 1e6, 3));
			$src = self::caller_source();
			if ($src) self::$parts[$id]['source'] = $src;
			return self::marked($id, $value, $hook !== 'post_thumbnail_html');
		} finally {
			self::$busy--;
		}
	}

	/* shortcodes */

	/**
	 * shortcodes.php do_shortcode_tag() applies pre_do_shortcode_tag before the shortcode's callback and
	 * do_shortcode_tag after it. A shortcode inside an HTML attribute (do_shortcodes_in_html_tags()) ends up in that
	 * attribute, so it is not marked.
	 */
	private static function shortcode_start(array $args) {
		$tag = isset($args[2]) ? (string) $args[2] : '';
		$in_attribute = false;
		foreach (debug_backtrace(DEBUG_BACKTRACE_IGNORE_ARGS, 12) as $f) {
			if (isset($f['function']) && $f['function'] === 'do_shortcodes_in_html_tags') {
				$in_attribute = true;
				break;
			}
		}
		if ($in_attribute || $tag === '') {
			self::$shortcodes[] = null;
			return null;
		}
		global $shortcode_tags;
		$extra = array();
		if (isset($shortcode_tags[$tag])) {
			$d = self::describe($shortcode_tags[$tag]);
			if ($d['source']) $extra['source'] = $d['source'];
			$extra['chain'] = array(array_filter(array('hook' => 'shortcode:' . $tag, 'by' => $d['by'], 'callback' => $d['callback'], 'source' => $d['source'])));
		}
		$attr = isset($args[3]) ? $args[3] : array();
		$extra['variables'] = self::variables(is_array($attr) ? $attr : array(), 'attribute');
		$id = self::open('shortcode', '[' . $tag . ']', $extra);
		self::$meta[$id] = array('shortcode' => $tag);
		self::$shortcodes[] = $id;
		return $id;
	}

	public static function shortcode_short($return, $tag = '', $attr = array(), $m = array()) {
		if (!self::$front || $return === false || !self::$shortcodes) return $return;
		$id = array_pop(self::$shortcodes);
		if (!$id) return $return;
		self::$busy++;
		try {
			self::close($id);
			self::deliver($id, self::take('pre_do_shortcode_tag'));
			return self::marked($id, $return);
		} finally {
			self::$busy--;
		}
	}

	public static function shortcode_end($output, $tag = '', $attr = array(), $m = array()) {
		if (!self::$front || !self::$shortcodes) return $output;
		$id = array_pop(self::$shortcodes);
		if (!$id) return $output;
		self::$busy++;
		try {
			self::close($id);
			self::deliver($id, self::take('do_shortcode_tag'));
			return self::marked($id, $output);
		} finally {
			self::$busy--;
		}
	}

	/* widgets */

	/** widgets.php dynamic_sidebar(): a widget area with widgets. */
	public static function sidebar_start($index, $has_widgets = false): void {
		if (!self::$front || !$has_widgets) return;
		global $wp_registered_sidebars;
		$name = isset($wp_registered_sidebars[$index]['name']) ? $wp_registered_sidebars[$index]['name'] : (string) $index;
		$id = self::open('region', 'Widget area: ' . $name);
		self::$meta[$id] = array('sidebar' => (string) $index, 'widgets' => array());
		self::$sidebar = $id;
		echo self::begin_mark($id);
		self::$meta[$id]['marked'] = true;
	}

	/** dynamic_sidebar_params is applied once per widget, before 'dynamic_sidebar' and its callback. */
	private static function widget_next(array $args) {
		if (self::$widget) {
			self::close(self::$widget);
			self::$widget = null;
		}
		$params = isset($args[1]) && is_array($args[1]) ? $args[1] : array();
		$wid = isset($params[0]['widget_id']) ? (string) $params[0]['widget_id'] : '';
		if (!self::$sidebar || $wid === '') return null;
		$name = isset($params[0]['widget_name']) ? (string) $params[0]['widget_name'] : $wid;
		$id = self::new_part('widget', $name . ' widget');
		self::$meta[$id] = array('widget' => $wid, 'sidebar' => self::$meta[self::$sidebar]['sidebar']);
		self::$meta[self::$sidebar]['widgets'][] = $id;
		self::$pending_widget = (object) array('id' => $id, 'steps' => array(), 'start' => hrtime(true), 'q0' => self::$qcount, 'qms0' => self::$qms);
		return $id;
	}

	/** The widget's own before_widget and after_widget carry its marks (a widget prints them around its output). */
	public static function widget_marks($params) {
		if (!self::$front || !self::$pending_widget || !is_array($params) || !isset($params[0]) || !is_array($params[0])) return $params;
		$id = self::$pending_widget->id;
		$params[0]['before_widget'] = self::begin_mark($id) . (isset($params[0]['before_widget']) ? $params[0]['before_widget'] : '');
		$params[0]['after_widget'] = (isset($params[0]['after_widget']) ? $params[0]['after_widget'] : '') . self::end_mark($id);
		self::$meta[$id]['marked'] = true;
		return $params;
	}

	public static function widget_start($widget): void {
		if (!self::$front || !self::$pending_widget) return;
		$p = self::$pending_widget;
		self::$pending_widget = null;
		$d = isset($widget['callback']) ? self::describe($widget['callback']) : null;
		if ($d && $d['source']) self::$parts[$p->id]['source'] = $d['source'];
		$parent = self::top_part();
		self::$stack[] = array('type' => 'part', 'part' => $p->id, 'children' => 0, 'map' => null, 'start' => $p->start, 'q0' => $p->q0, 'qms0' => $p->qms0);
		if ($parent) self::$parts[$p->id]['parent'] = $parent;
		self::$widget = $p->id;
	}

	public static function sidebar_end($index, $has_widgets = false): void {
		if (!self::$front || !self::$sidebar) return;
		if (self::$widget) {
			self::close(self::$widget);
			self::$widget = null;
		}
		echo self::end_mark(self::$sidebar);
		self::close(self::$sidebar);
		self::$sidebar = null;
	}

	/* menus */

	/** nav-menu-template.php wp_nav_menu(): wp_nav_menu_objects is applied only once the menu has items to show. */
	private static function menu_start(array $args) {
		$a = isset($args[2]) ? $args[2] : null;
		$menu = null;
		if (is_object($a)) {
			if (isset($a->menu) && $a->menu instanceof WP_Term) $menu = $a->menu;
			elseif (!empty($a->menu)) $menu = wp_get_nav_menu_object($a->menu);
			if (!$menu && !empty($a->theme_location)) {
				$locations = get_nav_menu_locations();
				if (isset($locations[$a->theme_location])) $menu = wp_get_nav_menu_object($locations[$a->theme_location]);
			}
		}
		$label = 'Menu' . ($menu ? ': ' . $menu->name : '') . (is_object($a) && !empty($a->theme_location) ? ' (' . $a->theme_location . ')' : '');
		$extra = array();
		$src = self::caller_source();
		if ($src) $extra['source'] = $src;
		$id = self::open('menu', $label, $extra, array(), self::$pending_menu);
		self::$pending_menu = null;
		self::$meta[$id] = array('menu' => $menu ? (int) $menu->term_id : 0, 'items' => array());
		return $id;
	}

	public static function menu_short($nav, $args = null) {
		if (!self::$front || $nav === null || !self::$pending_menu) return $nav;
		self::$busy++;
		try {
			$id = self::new_part('menu', 'Menu');
			self::deliver($id, array_merge(self::$pending_menu->steps, self::take('pre_wp_nav_menu')));
			self::$pending_menu = null;
			return self::marked($id, $nav);
		} finally {
			self::$busy--;
		}
	}

	public static function menu_end($nav, $args = null) {
		if (!self::$front) return $nav;
		$f = end(self::$stack);
		if (!$f || $f['type'] !== 'part' || !isset(self::$meta[$f['part']]['menu'])) return $nav;
		self::$busy++;
		try {
			self::close($f['part']);
			self::deliver($f['part'], self::take('wp_nav_menu'));
			return self::marked($f['part'], $nav);
		} finally {
			self::$busy--;
		}
	}

	/** class-walker-nav-menu.php Walker_Nav_Menu::start_el() applies nav_menu_item_args first, walker_nav_menu_start_el last. */
	private static function item_start(array $args) {
		$f = end(self::$stack);
		if (!$f || $f['type'] !== 'part' || !isset(self::$meta[$f['part']]['menu'])) return null;
		$item = isset($args[2]) ? $args[2] : null;
		if (!is_object($item) || !isset($item->ID)) return null;
		self::$pending_item = (object) array('item' => $item, 'menu' => $f['part'], 'steps' => array(), 'start' => hrtime(true));
		return self::$pending_item;
	}

	public static function item_end($output, $item = null, $depth = 0, $args = null) {
		if (!self::$front || !self::$pending_item || !is_object($item) || !isset($item->ID) || (int) self::$pending_item->item->ID !== (int) $item->ID) return $output;
		self::$busy++;
		try {
			$p = self::$pending_item;
			self::$pending_item = null;
			$id = self::new_part('menu', 'Link: ' . wp_strip_all_tags((string) $item->title), array('parent' => $p->menu));
			self::$meta[$id] = array('item' => (int) $item->ID, 'item_parent' => (int) $item->menu_item_parent, 'menu_part' => $p->menu, 'order' => (int) $item->menu_order);
			self::$meta[$p->menu]['items'][] = $id;
			self::deliver($id, array_merge($p->steps, self::take('walker_nav_menu_start_el')));
			self::$parts[$id]['cost'] = array('ms' => round((hrtime(true) - $p->start) / 1e6, 3));
			return self::marked($id, $output);
		} finally {
			self::$busy--;
		}
	}

	/** get_option( 'blogname' ) and 'blogdescription' read while a part renders, outside the document head. */
	public static function option_seen(string $option): void {
		if (!self::$front || self::$busy || doing_action('wp_head')) return;
		$part = self::top_part();
		if ($part && $part !== self::$main) self::$options_seen[$part][$option] = true;
	}

	/* ── queries, logs, errors ──────────────────────────────────────────── */

	/**
	 * class-wpdb.php wpdb::log_query() applies log_query_custom_data (5.3+) to every query it logs. Its caller string
	 * names functions; a backtrace here names the file and line that asked: the first frame outside core when there
	 * is one, else the first outside wpdb.
	 */
	public static function logged($data, $query = '', $time = 0, $stack = '', $start = 0) {
		if (self::$busy || !self::$collecting) return $data;
		self::$qcount++;
		self::$qms += (float) $time * 1000;
		if (count(self::$queries) >= self::LIMITS['queries']) {
			self::$truncated['queries'] = true;
			return $data;
		}
		$core = null;
		$caller = null;
		foreach (debug_backtrace(DEBUG_BACKTRACE_IGNORE_ARGS, 40) as $f) {
			if (empty($f['file'])) continue;
			$file = wp_normalize_path($f['file']);
			if ($file === self::$self || str_ends_with($file, '/wp-includes/class-wpdb.php')) continue;
			if ($core === null) $core = array($file, isset($f['line']) ? (int) $f['line'] : 0);
			$w = self::whose($file);
			if ($w[0] !== 'core') {
				$caller = array($file, isset($f['line']) ? (int) $f['line'] : 0);
				break;
			}
		}
		$at = $caller ? $caller : $core;
		$q = array('sql' => self::cut((string) $query, 4000), 'ms' => round((float) $time * 1000, 3));
		$src = $at ? self::source($at[0], $at[1]) : null;
		if ($src) $q['caller'] = $src;
		$part = self::top_part();
		if ($part) $q['part'] = $part;
		self::$queries[] = $q;
		return $data;
	}

	/**
	 * wpdb::query() applies the 'query' filter before it flushes the last result, so the previous query's row
	 * count is still on $wpdb here.
	 */
	public static function rows($query) {
		if (!self::$busy && self::$queries) {
			$last = count(self::$queries) - 1;
			if (!isset(self::$queries[$last]['rows'])) {
				global $wpdb;
				self::$queries[$last]['rows'] = preg_match('/^\s*(insert|update|delete|replace)\s/i', self::$queries[$last]['sql']) ? (int) $wpdb->rows_affected : (int) $wpdb->num_rows;
			}
		}
		return $query;
	}

	/** PHP's warnings and notices during the request; the handler that was there before still runs. */
	public static function error($level, $message, $file = '', $line = 0) {
		$reporting = error_reporting();
		// An @-suppressed error: PHP 8 leaves only fatal levels on (4437), PHP 7 none.
		// _doing_it_wrong() and the _deprecated_*() family trigger_error() what wrong() has already logged, with their
		// call site.
		$reported = false;
		if ($level === E_USER_NOTICE || $level === E_USER_DEPRECATED || $level === E_USER_WARNING) {
			foreach (debug_backtrace(DEBUG_BACKTRACE_IGNORE_ARGS, 8) as $f) {
				if (isset($f['function']) && (strpos($f['function'], '_doing_it_wrong') === 0 || strpos($f['function'], '_deprecated_') === 0)) $reported = true;
			}
		}
		if (!$reported && $reporting !== 0 && $reporting !== 4437 && self::$collecting) {
			$levels = array(E_WARNING => 'warning', E_USER_WARNING => 'warning', E_CORE_WARNING => 'warning', E_COMPILE_WARNING => 'warning', E_NOTICE => 'notice', E_USER_NOTICE => 'notice', E_DEPRECATED => 'info', E_USER_DEPRECATED => 'info', E_RECOVERABLE_ERROR => 'error', E_USER_ERROR => 'error');
			$lv = isset($levels[$level]) ? $levels[$level] : 'warning';
			$prefix = ($level === E_DEPRECATED || $level === E_USER_DEPRECATED) ? 'Deprecated: ' : '';
			self::log($lv, $prefix . (string) $message, $file ? self::source((string) $file, (int) $line) : null);
		}
		if (self::$prev_handler) return call_user_func(self::$prev_handler, $level, $message, $file, $line);
		return false;
	}

	/** functions.php _doing_it_wrong() and the _deprecated_*() family fire these whether or not WP_DEBUG is on. */
	public static function wrong($what = '', $b = '', $c = '', $d = ''): void {
		if (!self::$collecting) return;
		$hook = current_action();
		$messages = array(
			'doing_it_wrong_run' => sprintf('%s was called incorrectly: %s (since %s)', $what, wp_strip_all_tags((string) $b), $c),
			'deprecated_function_run' => sprintf('%s is deprecated since %s%s', $what, $c, $b ? '; use ' . $b : ''),
			'deprecated_class_run' => sprintf('%s is deprecated since %s%s', $what, $c, $b ? '; use ' . $b : ''),
			'deprecated_argument_run' => sprintf('An argument of %s is deprecated since %s: %s', $what, $c, wp_strip_all_tags((string) $b)),
			'deprecated_hook_run' => sprintf('The hook %s is deprecated since %s%s', $what, $c, $b ? '; use ' . $b : ''),
			'deprecated_file_included' => sprintf('%s is deprecated since %s%s', self::rel((string) $what) ?: basename((string) $what), $c, $b ? '; use ' . $b : ''),
		);
		$message = isset($messages[$hook]) ? $messages[$hook] : (string) $what;
		self::log($hook === 'doing_it_wrong_run' ? 'notice' : 'info', $message, self::caller_source());
	}

	private static function log(string $level, string $message, $source): void {
		if (count(self::$logs) >= self::LIMITS['logs']) {
			self::$truncated['logs'] = true;
			return;
		}
		$l = array('level' => $level, 'message' => self::cut($message, 2000));
		if ($source) $l['source'] = $source;
		self::$logs[] = $l;
	}

	public static function block_json($metadata) {
		if (is_array($metadata) && isset($metadata['name'], $metadata['file']) && is_string($metadata['file'])) self::$block_json[$metadata['name']] = $metadata['file'];
		return $metadata;
	}

	/* ── finishing the trace ────────────────────────────────────────────── */

	/** At shutdown, before core's output buffer is flushed: everything the trace says, but which parts the page kept. */
	public static function assemble(): void {
		if (!self::$front || self::$assembled) return;
		self::$assembled = true;
		self::$busy++;
		try {
			if (self::$main && !empty(self::$meta[self::$main]['marked'])) echo self::end_mark(self::$main);
			while (self::$stack) {
				$f = array_pop(self::$stack);
				if ($f['type'] === 'part') self::cost($f);
			}
			while (self::$apps) self::finish(array_pop(self::$apps));
			foreach (array_keys(self::$wrapped) as $hook) self::restore($hook);
			self::$collecting = false;
			$last = error_get_last();
			if ($last && in_array($last['type'], array(E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR), true)) self::log('error', (string) $last['message'], self::source((string) $last['file'], (int) $last['line']));
			if (self::$queries) {
				global $wpdb;
				$i = count(self::$queries) - 1;
				if (!isset(self::$queries[$i]['rows'])) self::$queries[$i]['rows'] = (int) $wpdb->num_rows;
			}
			self::$trace = self::build();
		} catch (Throwable $e) {
			self::$trace = null;
			error_log('Wanigan live view: the trace could not be built: ' . $e->getMessage() . ' at ' . $e->getFile() . ':' . $e->getLine());
		} finally {
			self::$busy--;
		}
		if (!self::$buffer_on) self::store();
	}

	/** Core's template output buffer, whole: empty parts lose their marks, and the parts still on the page are noted. */
	public static function buffer($html, $original = '') {
		if (!self::$front || !is_string($html)) return $html;
		$html = preg_replace('/<!-- wl:part id="(p\d+)" --><!-- \/wl:part id="\1" -->/', '', $html);
		// Which part each one sits inside, as the page has them: a shortcode's output is inside the block that held
		// it, though do_shortcode() ran on the content after the block rendered.
		preg_match_all('/<!-- (\/?)wl:part id="(p\d+)" -->/', $html, $marks, PREG_SET_ORDER);
		$stack = array();
		$begun = array();
		$ended = array();
		foreach ($marks as $m) {
			if ($m[1] === '') {
				self::$nesting[$m[2]] = $stack ? end($stack) : null;
				$stack[] = $m[2];
				$begun[$m[2]] = true;
			} else {
				$ended[$m[2]] = true;
				$i = array_search($m[2], $stack, true);
				if ($i !== false) array_splice($stack, $i);
			}
		}
		self::$present = array_intersect_key($begun, $ended);
		return $html;
	}

	public static function flushed(): void {
		self::store();
	}

	public static function store_late(): void {
		self::store();
	}

	private static function store(): void {
		if (self::$stored || !self::$trace) return;
		self::$stored = true;
		self::$busy++;
		try {
			$trace = self::$trace;
			if (self::$present !== null) $trace = self::prune($trace, self::$present);
			$trace = self::fit($trace);
			$user = get_current_user_id();
			$private = array('edits' => self::$private, 'collections' => isset($trace['_collections']) ? $trace['_collections'] : array());
			unset($trace['_collections']);
			set_transient('wanigan_live_t_' . $user . '_' . self::$id, array('trace' => $trace, 'private' => $private), self::TTL);
			$index = get_transient('wanigan_live_ti_' . $user);
			$index = is_array($index) ? $index : array();
			$index[] = self::$id;
			while (count($index) > self::KEEP) delete_transient('wanigan_live_t_' . $user . '_' . array_shift($index));
			set_transient('wanigan_live_ti_' . $user, $index, self::TTL);
		} catch (Throwable $e) {
			error_log('Wanigan live view: the trace could not be stored: ' . $e->getMessage());
		} finally {
			self::$busy--;
		}
	}

	/**
	 * Parts whose marks are not on the page (their output was dropped, stripped or never printed) leave the trace;
	 * their children move up to the nearest part that stayed.
	 */
	private static function prune(array $trace, array $present): array {
		$keep = array();
		foreach ($trace['parts'] as $p) {
			if (isset($present[$p['id']])) $keep[$p['id']] = true;
		}
		$byId = array();
		foreach ($trace['parts'] as $p) $byId[$p['id']] = $p;
		$nesting = self::$nesting;
		$up = function ($id) use ($byId, $nesting) {
			return array_key_exists($id, $nesting) ? $nesting[$id] : (isset($byId[$id]['parent']) ? $byId[$id]['parent'] : null);
		};
		$parts = array();
		foreach ($trace['parts'] as $p) {
			if (!isset($keep[$p['id']])) continue;
			$parent = $up($p['id']);
			while ($parent !== null && !isset($keep[$parent])) $parent = $up($parent);
			if ($parent === null) unset($p['parent']);
			else $p['parent'] = $parent;
			$parts[] = $p;
		}
		$trace['parts'] = $parts;
		$used = array();
		foreach ($parts as $p) foreach (isset($p['edits']) ? $p['edits'] : array() as $e) $used[$e] = true;
		$trace['edits'] = array_values(array_filter($trace['edits'], function ($e) use ($used) { return isset($used[$e['id']]); }));
		foreach ($trace['queries'] as $i => $q) {
			if (isset($q['part']) && !isset($keep[$q['part']])) {
				$parent = isset($byId[$q['part']]['parent']) ? $byId[$q['part']]['parent'] : null;
				while ($parent !== null && !isset($keep[$parent])) $parent = isset($byId[$parent]['parent']) ? $byId[$parent]['parent'] : null;
				if ($parent === null) unset($trace['queries'][$i]['part']);
				else $trace['queries'][$i]['part'] = $parent;
			}
		}
		$trace['queries'] = array_values($trace['queries']);
		if (isset($trace['collections'])) {
			$ids = array();
			foreach ($trace['collections'] as $i => $c) {
				$trace['collections'][$i]['items'] = array_values(array_filter($c['items'], function ($it) use ($keep) { return isset($keep[$it]); }));
				if (isset($c['part']) && !isset($keep[$c['part']])) unset($trace['collections'][$i]['part']);
				if (!$trace['collections'][$i]['items'] && !isset($trace['collections'][$i]['part'])) unset($trace['collections'][$i]);
				else $ids[$c['id']] = true;
			}
			$trace['collections'] = array_values($trace['collections']);
			foreach ($trace['collections'] as $i => $c) {
				if (isset($c['movesTo'])) $trace['collections'][$i]['movesTo'] = array_values(array_filter($c['movesTo'], function ($m) use ($ids) { return isset($ids[$m]); }));
			}
		}
		return $trace;
	}

	/** A trace larger than a transient should hold is cut, longest lists first, and says what was cut. */
	private static function fit(array $trace): array {
		foreach (array('hooks', 'queries', 'logs') as $list) {
			$json = wp_json_encode($trace);
			if ($json === false || strlen($json) <= self::MAX_JSON) break;
			if (!empty($trace[$list])) {
				$trace[$list] = array_slice($trace[$list], 0, (int) (count($trace[$list]) / 4));
				$trace['truncated'][] = $list;
			}
		}
		if (isset($trace['truncated'])) $trace['truncated'] = array_values(array_unique($trace['truncated']));
		return $trace;
	}

	private static function build(): array {
		global $timestart;
		$parts = array();
		foreach (self::$parts as $id => $p) {
			if (count($parts) >= self::LIMITS['parts']) {
				self::$truncated['parts'] = true;
				break;
			}
			$parts[$id] = self::finish_part($p, isset(self::$meta[$id]) ? self::$meta[$id] : array());
		}
		$collections = self::collections($parts);
		$public = array();
		$private = array();
		foreach ($collections as $c) {
			$private[$c['id']] = $c['_private'];
			unset($c['_private']);
			$public[] = $c;
		}
		foreach (self::$options_seen as $part => $options) {
			if (!isset($parts[$part])) continue;
			foreach (array_keys($options) as $o) $parts[$part]['edits'][] = self::option_edit($o);
			$parts[$part]['edits'] = array_values(array_unique($parts[$part]['edits']));
		}
		$user = wp_get_current_user();
		$started = isset($timestart) && is_numeric($timestart) ? (float) $timestart : self::$started;
		$trace = array(
			'version' => 1,
			'platform' => 'wordpress',
			'id' => self::$id,
			'url' => self::cut(isset($_SERVER['REQUEST_URI']) ? (string) $_SERVER['REQUEST_URI'] : '/', 4000),
			'at' => (int) round(microtime(true) * 1000),
			'total' => array('ms' => round((microtime(true) - $started) * 1000, 3), 'memoryBytes' => memory_get_peak_usage(), 'hooks' => self::$firings),
			'parts' => array_values($parts),
			'edits' => array_values(array_slice(self::$edits, 0, self::LIMITS['edits'])),
			'hooks' => self::$hooks,
			'queries' => self::$queries,
			'assets' => self::assets(),
			'logs' => self::$logs,
			'collections' => array_slice($public, 0, self::LIMITS['collections']),
			'palette' => self::palette(),
			'_collections' => $private,
		);
		if (SAVEQUERIES) {
			$trace['total']['queries'] = self::$qcount;
			$trace['total']['queryMs'] = round(self::$qms, 3);
		}
		if ($user && $user->exists()) $trace['user'] = array('name' => $user->display_name !== '' ? $user->display_name : $user->user_login, 'roles' => array_values((array) $user->roles));
		if (count(self::$edits) > self::LIMITS['edits']) self::$truncated['edits'] = true;
		if (self::$truncated) $trace['truncated'] = array_keys(self::$truncated);
		if (strpos($trace['url'], '/') !== 0) $trace['url'] = '/';
		return $trace;
	}

	/** What a part says once the page is done: its source, variables, edits and history. */
	private static function finish_part(array $p, array $m): array {
		if (isset($m['block'])) $p = self::finish_block($p, $m);
		elseif (isset($m['post'])) $p = self::finish_post($p, $m);
		elseif (isset($m['main']) || isset($m['file'])) $p = self::finish_template($p, $m);
		elseif (isset($m['wp_template'])) $p = self::finish_wp_template($p, $m);
		elseif (isset($m['widget'])) $p = self::finish_widget($p, $m);
		elseif (isset($m['item'])) $p = self::finish_item($p, $m);
		elseif (isset($m['menu'])) $p = self::finish_menu($p, $m);
		elseif (isset($m['sidebar'])) $p['edits'][] = self::link_edit('config', 'Widgets in Appearance › Widgets', admin_url('widgets.php'), 'edit_theme_options', false);
		if (isset($p['variables']) && count($p['variables']) > self::LIMITS['variables']) {
			$p['variables'] = array_slice($p['variables'], 0, self::LIMITS['variables']);
			self::$truncated['variables:' . $p['id']] = true;
		}
		if (isset($p['edits'])) $p['edits'] = array_values(array_unique(array_filter($p['edits'])));
		return $p;
	}

	/* posts: fields, meta, history, access */

	private static function finish_post(array $p, array $m): array {
		$post = get_post($m['post']);
		if (!$post) return $p;
		$edits = self::post_edits($post);
		$field = isset($m['field']) ? $m['field'] : null;
		if ($field === 'the_title') $p['edits'] = array($edits['title']);
		elseif ($field === 'the_excerpt') $p['edits'] = isset($edits['excerpt']) ? array($edits['excerpt']) : array();
		elseif ($field === 'post_thumbnail_html') $p['edits'] = isset($edits['featured']) ? array($edits['featured']) : array();
		else {
			$p['edits'] = array_values($edits);
			$p['variables'] = self::post_variables($post, $edits);
			$p['history'] = self::history($post->ID);
			$p['access'] = self::access($post);
		}
		return $p;
	}

	private static function post_variables(WP_Post $post, array $edits): array {
		$vars = array();
		$fields = array('ID' => null, 'post_type' => null, 'post_title' => 'title', 'post_name' => 'slug', 'post_status' => 'status', 'post_excerpt' => 'excerpt', 'post_author' => null, 'post_date' => null, 'post_modified' => null, 'post_parent' => null, 'menu_order' => null);
		foreach ($fields as $f => $edit) {
			$v = array('name' => $f, 'type' => gettype($post->$f), 'preview' => self::preview($post->$f));
			if ($edit && isset($edits[$edit])) $v['edit'] = $edits[$edit];
			$vars[] = $v;
		}
		$thumb = get_post_thumbnail_id($post);
		if ($thumb || isset($edits['featured'])) {
			$v = array('name' => 'featured image', 'type' => 'integer', 'preview' => $thumb ? $thumb . ' (' . basename((string) get_attached_file($thumb)) . ')' : 'none');
			if (isset($edits['featured'])) $v['edit'] = $edits['featured'];
			$vars[] = $v;
		}
		$template = get_page_template_slug($post);
		if ($template) $vars[] = array('name' => 'page template', 'type' => 'string', 'preview' => $template);
		foreach ($edits as $key => $edit) {
			if (strpos($key, 'meta:') !== 0) continue;
			$meta = substr($key, 5);
			$value = self::$private[$edit]['value_preview'];
			$vars[] = array('name' => 'meta ' . $meta, 'type' => self::$private[$edit]['value_type'], 'preview' => $value, 'edit' => $edit);
		}
		foreach (get_post_meta($post->ID) as $key => $values) {
			if (isset($edits['meta:' . $key]) || count($vars) >= 120) continue;
			if (is_protected_meta($key, 'post')) continue;
			$vars[] = array('name' => 'meta ' . $key, 'type' => count($values) > 1 ? 'array' : 'string', 'preview' => self::preview(preg_match(self::SECRET, $key) ? '[redacted]' : (count($values) > 1 ? $values : $values[0])), 'setBy' => 'unregistered meta (not in the REST API, so not editable here)');
		}
		return $vars;
	}

	/**
	 * The fields of a post core can change, as schema targets saved through the post's REST route (the block
	 * editor's own path: validation, capabilities, revisions, rest_after_insert_* hooks), and its registered meta
	 * through WP_REST_Post_Meta_Fields with the schema register_meta() gave it.
	 */
	private static function post_edits(WP_Post $post): array {
		if (isset(self::$post_edits[$post->ID])) return self::$post_edits[$post->ID];
		$pid = $post->ID;
		$type = get_post_type_object($post->post_type);
		$noun = $type ? strtolower($type->labels->singular_name) : 'post';
		$why = self::post_why($post, $noun);
		$route = rest_get_route_for_post($post);
		if (!$why && $route === '') $why = 'This ' . $noun . ' type is not in the REST API (show_in_rest is off), which is how WordPress saves its fields here. Change it in wp-admin.';
		$revisions = post_type_supports($post->post_type, 'revisions') && wp_revisions_enabled($post);
		$title = $post->post_title !== '' ? '“' . self::cut(wp_strip_all_tags($post->post_title), 60) . '”' : $noun . ' ' . $pid;
		$out = array();
		$add = function ($key, $kind, $label, $schema, $value, $field, $rev, $extra_why = null) use (&$out, $pid, $why, $route) {
			$id = 'post-' . $pid . '-' . $key;
			$target = array('id' => $id, 'kind' => $kind, 'label' => $label, 'via' => 'schema', 'schema' => $schema, 'value' => $value, 'revisions' => $rev);
			$w = $extra_why ? $extra_why : $why;
			if ($w) $target['why'] = $w;
			self::$edits[$id] = $target;
			self::$private[$id] = array('type' => 'post', 'post' => $pid, 'field' => $field, 'route' => $route);
			$out[$key] = $id;
		};
		if (post_type_supports($post->post_type, 'title')) $add('title', 'field', 'Title of ' . $title, array('type' => 'string', 'title' => 'Title'), $post->post_title, 'title', $revisions);
		if (post_type_supports($post->post_type, 'excerpt')) $add('excerpt', 'field', 'Excerpt of ' . $title, array('type' => 'string', 'title' => 'Excerpt'), $post->post_excerpt, 'excerpt', $revisions);
		$add('slug', 'property', 'Slug of ' . $title, array('type' => 'string', 'title' => 'Slug', 'description' => 'The last part of its address. WordPress makes it unique and URL-safe when it saves.'), $post->post_name, 'slug', false);
		$statuses = array('publish', 'future', 'draft', 'pending', 'private');
		if (!in_array($post->post_status, $statuses, true)) $statuses[] = $post->post_status;
		$add('status', 'property', 'Status of ' . $title, array('type' => 'string', 'title' => 'Status', 'enum' => $statuses), $post->post_status, 'status', false);
		if (post_type_supports($post->post_type, 'thumbnail')) {
			$add('featured', 'field', 'Featured image of ' . $title, array('type' => 'integer', 'title' => 'Featured image', 'minimum' => 0, 'description' => 'An image’s attachment ID; 0 removes it.'), (int) get_post_thumbnail_id($post), 'featured_media', $revisions);
		}
		if (class_exists('WP_REST_Post_Meta_Fields')) {
			$fields = new WP_REST_Post_Meta_Fields($post->post_type);
			$schema = $fields->get_field_schema();
			$values = $fields->get_value($pid, new WP_REST_Request());
			$registered = get_registered_meta_keys('post', $post->post_type) + get_registered_meta_keys('post', '');
			$n = 0;
			foreach (isset($schema['properties']) ? $schema['properties'] : array() as $key => $s) {
				if (++$n > 60) break;
				$secret = (bool) preg_match(self::SECRET, $key);
				$value = array_key_exists($key, $values) ? $values[$key] : null;
				$rev = !empty($registered[$key]['revisions_enabled']);
				$label = (isset($s['description']) && $s['description'] !== '' ? $s['description'] : $key) . ' (' . $title . ')';
				$add('meta-' . $n, 'meta', $label, $s, $secret ? null : $value, 'meta', $rev, $secret ? 'Wanigan does not show or change a value that looks like a secret.' : null);
				$id = $out['meta-' . $n];
				unset($out['meta-' . $n]);
				$out['meta:' . $key] = $id;
				self::$private[$id]['key'] = $key;
				self::$private[$id]['value_preview'] = $secret ? '[redacted]' : self::preview($value);
				self::$private[$id]['value_type'] = gettype($value);
			}
		}
		$editor = get_edit_post_link($pid, 'raw');
		if ($editor) {
			$id = 'post-' . $pid . '-editor';
			self::$edits[$id] = array('id' => $id, 'kind' => 'field', 'label' => (use_block_editor_for_post($post) ? 'Open ' . $title . ' in the block editor' : 'Open ' . $title . ' in the editor'), 'via' => 'native-form', 'revisions' => $revisions);
			self::$private[$id] = array('type' => 'link', 'url' => $editor, 'cap' => array('edit_post', $pid));
			$out['editor'] = $id;
		}
		self::$post_edits[$pid] = $out;
		return $out;
	}

	/** Why the logged-in user cannot change a post here now, or null. */
	private static function post_why(WP_Post $post, string $noun): ?string {
		$why = self::cannot('edit_post', 'edit this ' . $noun, $post->ID);
		return $why ? $why : self::lock($post->ID, $noun);
	}

	/** capabilities.php current_user_can(), said as why not: log in first, or which capability is missing. */
	private static function cannot(string $cap, string $what, ?int $object = null): ?string {
		if (!is_user_logged_in()) return 'Log in to WordPress in the live view to change this.';
		$can = $object === null ? current_user_can($cap) : current_user_can($cap, $object);
		return $can ? null : 'Your WordPress user cannot ' . $what . ' (' . $cap . ').';
	}

	/**
	 * wp-admin/includes/post.php wp_check_post_lock(): '_edit_lock' is "time:user", live for the
	 * wp_check_post_lock_window filter's seconds (150). A save here would be overwritten by the editor that holds it,
	 * even when that editor is the owner's own.
	 */
	private static function lock(int $pid, string $noun = 'post'): ?string {
		$lock = get_post_meta($pid, '_edit_lock', true);
		if (!$lock) return null;
		$parts = explode(':', (string) $lock);
		$time = (int) $parts[0];
		$user = isset($parts[1]) ? (int) $parts[1] : 0;
		if (!$time || $time <= time() - (int) apply_filters('wp_check_post_lock_window', 150)) return null;
		if ($user && $user === get_current_user_id()) return 'You have this ' . $noun . ' open in the editor: save it there, or close the editor first (it would write over a change made here).';
		$u = $user ? get_userdata($user) : null;
		return ($u ? $u->display_name : 'Someone') . ' is editing this ' . $noun . ' right now.';
	}

	/** revision.php wp_get_post_revisions(): newest first; autosaves are revisions too. */
	private static function history(int $pid): array {
		$out = array();
		foreach (wp_get_post_revisions($pid, array('posts_per_page' => 20)) as $r) {
			$author = get_userdata((int) $r->post_author);
			$h = array('id' => (string) $r->ID, 'at' => (int) (strtotime($r->post_modified_gmt . ' UTC') * 1000), 'by' => $author ? $author->display_name : 'unknown');
			if (wp_is_post_autosave($r)) $h['message'] = 'Autosave';
			$out[] = $h;
		}
		return $out;
	}

	private static function access(WP_Post $post): array {
		$can = current_user_can('read_post', $post->ID);
		$status = get_post_status($post);
		$reason = $status === 'publish' ? ($post->post_password !== '' ? 'Published behind a password' : 'Published: anyone can read it')
			: ($status === 'private' ? 'Private: only users who can read private posts see it' : 'Not published (' . $status . '): only users who can edit it see it');
		return array('result' => $can ? 'allowed' : 'forbidden', 'reason' => $reason . ' (read_post)');
	}

	/* blocks: source, variables, attributes as a schema */

	private static function block_label(string $name): string {
		$type = WP_Block_Type_Registry::get_instance()->get_registered($name);
		return ($type && $type->title) ? $type->title : $name;
	}

	private static function finish_block(array $p, array $m): array {
		$name = $m['block'];
		$type = WP_Block_Type_Registry::get_instance()->get_registered($name);
		$parsed = isset($m['parsed']) && is_array($m['parsed']) ? $m['parsed'] : array();
		$attrs = isset($parsed['attrs']) && is_array($parsed['attrs']) ? $parsed['attrs'] : array();
		$src = self::block_source($name, $type);
		if ($src) {
			$p['source'] = $src[0];
			if ($src[1]) array_unshift($p['chain'], $src[1]);
		}
		if (!isset($p['chain'])) $p['chain'] = array();
		if (!$p['chain']) unset($p['chain']);
		$vars = array();
		$vars[] = array('name' => 'block', 'type' => 'string', 'preview' => $name . ($type && $type->is_dynamic() ? ' (dynamic: rendered by PHP)' : ' (static: saved markup)'));
		foreach ($attrs as $k => $v) {
			if (count($vars) >= 60) break;
			$vars[] = array('name' => 'attributes.' . $k, 'type' => gettype($v), 'preview' => self::preview(preg_match(self::SECRET, (string) $k) ? '[redacted]' : $v));
		}
		if (!empty($m['bindings'])) {
			foreach ($m['bindings'] as $attr => $b) {
				$vars[] = array('name' => 'attributes.' . $attr, 'type' => gettype($b['value']), 'preview' => self::preview($b['value']), 'setBy' => 'binding ' . $b['source'] . ($b['args'] ? ' ' . wp_json_encode($b['args']) : ''));
			}
		}
		if (!empty($attrs['metadata']['patternName'])) $vars[] = array('name' => 'pattern', 'type' => 'string', 'preview' => self::pattern_label((string) $attrs['metadata']['patternName']), 'setBy' => 'inserted from a pattern');
		if (!empty($parsed['innerBlocks'])) $vars[] = array('name' => 'innerBlocks', 'type' => 'array', 'preview' => count($parsed['innerBlocks']) . ' blocks');
		if (isset($m['context']['postId'])) $vars[] = array('name' => 'context.postId', 'type' => 'integer', 'preview' => (string) $m['context']['postId']);
		foreach (self::block_styles($name, $attrs) as $v) $vars[] = $v;
		$p['variables'] = $vars;
		$edits = array();
		if ($name === 'core/template-part' && !empty($m['tp'])) $p = self::finish_template_part($p, $m, $edits);
		if ($name === 'core/block' && !empty($attrs['ref'])) {
			$ref = get_post((int) $attrs['ref']);
			if ($ref) {
				$p['label'] = 'Synced pattern: ' . $ref->post_title;
				$link = get_edit_post_link($ref->ID, 'raw');
				if ($link) $edits[] = self::link_edit('field', 'Open the synced pattern “' . $ref->post_title . '” (changes every page using it)', $link, array('edit_post', $ref->ID), true);
				$p['history'] = self::history($ref->ID);
			}
		}
		if ($name === 'core/pattern' && !empty($attrs['slug'])) $p['label'] = 'Pattern: ' . self::pattern_label((string) $attrs['slug']);
		if ($name === 'core/navigation' && !empty($attrs['ref'])) {
			$nav = get_post((int) $attrs['ref']);
			if ($nav && current_user_can('edit_theme_options')) $edits[] = self::link_edit('menu-link', 'Edit the navigation “' . $nav->post_title . '” in the Site Editor', admin_url('site-editor.php?p=' . rawurlencode('/wp_navigation/' . $nav->ID) . '&canvas=edit'), 'edit_theme_options', true);
		}
		if (!empty($m['bindings'])) {
			foreach ($m['bindings'] as $b) {
				if ($b['source'] === 'core/post-meta' && !empty($b['args']['key']) && isset($m['context']['postId'])) {
					$post = get_post((int) $m['context']['postId']);
					if ($post) {
						$pe = self::post_edits($post);
						if (isset($pe['meta:' . $b['args']['key']])) $edits[] = $pe['meta:' . $b['args']['key']];
					}
				}
			}
		}
		if (!empty($m['map'])) {
			$e = self::block_edit($name, $type, $m['map']);
			if ($e) $edits[] = $e;
		}
		if ($edits) $p['edits'] = $edits;
		return $p;
	}

	/** The code that renders a block: its render.php, its render_callback, or, for a static block, its block.json. */
	private static function block_source(string $name, $type): ?array {
		$json = isset(self::$block_json[$name]) ? self::source(self::$block_json[$name], 1) : null;
		if (!$type || !$type->render_callback) return $json ? array($json, null) : null;
		$fn = $type->render_callback;
		if ($fn instanceof Closure) {
			// blocks.php register_block_type_from_metadata() wraps a block.json "render" file in a closure that keeps
			// its path in $template_path.
			try {
				$r = new ReflectionFunction($fn);
				$vars = $r->getStaticVariables();
				if (isset($vars['template_path']) && is_string($vars['template_path'])) {
					$s = self::source($vars['template_path'], 1);
					if ($s) return array($s, array('hook' => 'render', 'by' => $s['package'] ?? 'unknown', 'callback' => 'render: ' . basename($vars['template_path']), 'source' => $s));
				}
			} catch (Throwable $e) {
				// Fall through to the callback itself.
			}
		}
		$d = self::describe($fn);
		$step = array_filter(array('hook' => 'render_callback', 'by' => $d['by'], 'callback' => $d['callback'], 'source' => $d['source']));
		return array($d['source'] ? $d['source'] : $json, $step);
	}

	private static function pattern_label(string $name): string {
		$registry = WP_Block_Patterns_Registry::get_instance();
		if (!$registry->is_registered($name)) return $name;
		foreach (array(get_stylesheet(), get_template()) as $slug) {
			foreach (wp_get_theme($slug)->get_block_patterns() as $file => $data) {
				if (isset($data['slug']) && $data['slug'] === $name) return $name . ' (' . $slug . '/patterns/' . $file . ')';
			}
		}
		return $name;
	}

	/**
	 * class-wp-theme-json-resolver.php: core defaults (get_core_data), blocks' own (get_block_data, 6.1+), the
	 * theme's theme.json (get_theme_data) and the user's global styles (get_user_data) are merged in that order, so
	 * each style value is set by the last origin that has it. A block style variation (is-style-*) applies on top.
	 */
	private static function block_styles(string $name, array $attrs): array {
		static $origins = null;
		if ($origins === null) {
			$origins = array();
			if (class_exists('WP_Theme_JSON_Resolver')) {
				$labels = array('get_core_data' => 'WordPress core (theme.json defaults)', 'get_block_data' => 'the block’s block.json', 'get_theme_data' => 'the theme’s theme.json', 'get_user_data' => 'global styles (Site Editor)');
				foreach ($labels as $method => $label) {
					if (!method_exists('WP_Theme_JSON_Resolver', $method)) continue;
					try {
						$data = call_user_func(array('WP_Theme_JSON_Resolver', $method));
						$origins[$label] = $data ? $data->get_raw_data() : array();
					} catch (Throwable $e) {
						continue;
					}
				}
			}
		}
		$variation = null;
		if (!empty($attrs['className']) && preg_match('/(?:^|\s)is-style-([a-z0-9-]+)/', (string) $attrs['className'], $mm)) $variation = $mm[1];
		$set = array();
		foreach ($origins as $label => $raw) {
			$styles = isset($raw['styles']['blocks'][$name]) ? $raw['styles']['blocks'][$name] : null;
			if (is_array($styles)) {
				$v = isset($styles['variations']) ? $styles['variations'] : array();
				unset($styles['variations']);
				foreach (self::flatten($styles) as $path => $value) $set[$path] = array($value, $label);
				if ($variation && isset($v[$variation]) && is_array($v[$variation])) {
					foreach (self::flatten($v[$variation]) as $path => $value) $set[$path] = array($value, $label . ', style variation ' . $variation);
				}
			}
		}
		if (!empty($attrs['style']) && is_array($attrs['style'])) {
			foreach (self::flatten($attrs['style']) as $path => $value) $set[$path] = array($value, 'this block’s own style attribute');
		}
		$out = array();
		foreach ($set as $path => $v) {
			if (count($out) >= 80) break;
			$out[] = array('name' => 'style.' . $path, 'type' => gettype($v[0]), 'preview' => self::preview($v[0]), 'setBy' => $v[1]);
		}
		return $out;
	}

	private static function flatten(array $a, string $prefix = '', int $depth = 0): array {
		$out = array();
		foreach ($a as $k => $v) {
			$key = $prefix === '' ? (string) $k : $prefix . '.' . $k;
			if (is_array($v) && $depth < 4 && $v && !wp_is_numeric_array($v)) $out += self::flatten($v, $key, $depth + 1);
			else $out[$key] = $v;
		}
		return $out;
	}

	/**
	 * A block in stored content, as a schema target built from its type's attributes (class-wp-block-type.php
	 * $attributes, block.json plus the attributes block supports add). WordPress builds a static block's markup in
	 * the editor (its JavaScript save function), so a change made here may only be one the markup itself holds:
	 * - a dynamic block that saved no markup: any attribute in its comment delimiter;
	 * - a sourced attribute ("source": "rich-text", "html", "text" or "attribute" with a selector) whose element
	 *   holds plain text, or whose attribute it is: the markup changes, and the editor reads it back the same.
	 * Everything else is listed read-only, saying why.
	 */
	private static function block_edit(string $name, $type, array $map): ?string {
		$store = $map['store'];
		$node = self::node($store, $map['path']);
		if (!$node || !$type) return null;
		$info = self::store_info($store);
		if (!$info) return null;
		$id = 'block-' . self::short($store) . '-' . implode('.', $map['path']);
		if (isset(self::$edits[$id])) return $id;
		$dynamic = $type->is_dynamic();
		$own = '';
		foreach ($node['innerContent'] as $chunk) if (is_string($chunk)) $own .= $chunk;
		$empty = trim($own) === '';
		$bindings = isset($node['attrs']['metadata']['bindings']) && is_array($node['attrs']['metadata']['bindings']) ? $node['attrs']['metadata']['bindings'] : array();
		$props = array();
		$value = array();
		$writable = 0;
		foreach ((array) $type->attributes as $attr => $def) {
			if (count($props) >= 60) break;
			if (!is_array($def)) continue;
			$schema = self::attribute_schema($def);
			$source = isset($def['source']) ? $def['source'] : null;
			$why = null;
			$current = null;
			if (isset($bindings[$attr]) || (isset($bindings['__default']) && $source !== null)) {
				$why = 'Bound to ' . (isset($bindings[$attr]['source']) ? $bindings[$attr]['source'] : 'a source') . ': it shows that source’s value, so change it there.';
			}
			if ($source === null) {
				$current = array_key_exists($attr, $node['attrs']) ? $node['attrs'][$attr] : (isset($def['default']) ? $def['default'] : null);
				if (!$why && in_array($attr, array('metadata', 'lock'), true)) $why = 'The editor’s own bookkeeping.';
				if (!$why && !$dynamic) $why = 'WordPress writes this block’s markup from this setting in the editor, so it can change only there.';
				if (!$why && !$empty) $why = 'This block saved markup the editor checks against its settings, so it can change only in the editor.';
			} elseif (in_array($source, array('rich-text', 'html', 'text'), true) || $source === 'attribute') {
				$found = self::sourced($node, $def);
				$current = $found['value'];
				if (!$why && $found['why']) $why = $found['why'];
			} else {
				$why = 'Read from the block’s markup (' . $source . '), which Wanigan does not rewrite.';
			}
			if ($why) {
				$schema['readOnly'] = true;
				$schema['description'] = $why;
			} else {
				$writable++;
			}
			$props[$attr] = $schema;
			if ($current !== null) $value[$attr] = preg_match(self::SECRET, (string) $attr) ? null : $current;
		}
		$post = isset($info['post']) ? get_post($info['post']) : null;
		$noun = $info['noun'];
		$target = array('id' => $id, 'kind' => 'block-attributes', 'label' => self::block_label($name) . ' block in ' . $info['label'], 'via' => 'schema', 'schema' => array('type' => 'object', 'properties' => $props, 'additionalProperties' => false), 'value' => (object) $value, 'revisions' => $info['revisions']);
		$why = $info['why'];
		if (!$why && !$writable) $why = 'Nothing in this block can change here: each setting says why. Change it in the editor.';
		if (!$why && !self::round_trips($store)) $why = 'Writing this ' . $noun . '’s blocks back would change other parts of it (its saved markup does not survive parse_blocks() and serialize_blocks() unchanged), so Wanigan does not save it. Change it in the editor.';
		if ($why) $target['why'] = $why;
		self::$edits[$id] = $target;
		self::$private[$id] = array('type' => 'block', 'store' => $store, 'path' => $map['path'], 'fp' => md5(serialize_block($node)), 'hash' => md5(self::$trees[$store]['content']), 'name' => $name);
		return $id;
	}

	private static function attribute_schema(array $def): array {
		$s = array();
		foreach (array('type', 'enum', 'items', 'properties', 'default', 'minimum', 'maximum', 'pattern') as $k) {
			if (isset($def[$k])) $s[$k] = $def[$k];
		}
		// 6.5+: "rich-text" is a block attribute type; its value is a string of HTML.
		if (isset($s['type']) && $s['type'] === 'rich-text') $s['type'] = 'string';
		if (isset($def['source'])) $s['source'] = $def['source'];
		return $s;
	}

	/**
	 * A sourced attribute's value in a block's own markup, found the way the editor's parser does (the first element
	 * its selector matches), and whether it can be written back: plain text only for rich text, and a selector with
	 * no combinators unless it matches exactly one element.
	 */
	private static function sourced(array $node, array $def): array {
		if (!empty($node['innerBlocks'])) return array('value' => null, 'why' => 'This block has inner blocks around its own markup; change it in the editor.');
		$selector = isset($def['selector']) ? (string) $def['selector'] : '';
		if ($selector === '') return array('value' => null, 'why' => 'It is read from the whole block’s markup; change it in the editor.');
		$p = self::find_element((string) $node['innerHTML'], $selector);
		if (!$p) return array('value' => null, 'why' => 'Its element (' . $selector . ') is not in the saved markup.');
		if ($def['source'] === 'attribute') {
			$v = $p->get_attribute((string) $def['attribute']);
			return array('value' => is_string($v) ? $v : null, 'why' => null);
		}
		$tag = $p->get_tag();
		if (!$p->next_token()) return array('value' => null, 'why' => 'Its element could not be read.');
		if ($p->get_token_name() === $tag && $p->is_tag_closer()) return array('value' => '', 'why' => 'It is empty; add words in the editor first.');
		if ($p->get_token_name() !== '#text') return array('value' => null, 'why' => 'It has formatting (links, bold, other tags); change it in the editor.');
		$text = $p->get_modifiable_text();
		if ($p->next_token() && $p->get_token_name() === $tag && $p->is_tag_closer()) return array('value' => $text, 'why' => null);
		// Formatted: its words, for showing, read up to the element's own closer.
		$depth = 1;
		do {
			$name = $p->get_token_name();
			if ($name === '#text') $text .= $p->get_modifiable_text();
			elseif ($name === $tag) $depth += $p->is_tag_closer() ? -1 : 1;
		} while ($depth > 0 && $p->next_token());
		return array('value' => $text, 'why' => 'It has formatting (links, bold, other tags); change it in the editor.');
	}

	/** html-api WP_HTML_Tag_Processor at the first element a simple selector matches, or null. */
	private static function find_element(string $html, string $selector) {
		$alternatives = array_map('trim', explode(',', $selector));
		$combined = (bool) preg_match('/[\s>+~]/', $selector);
		$p = new WP_HTML_Tag_Processor($html);
		$found = null;
		$count = 0;
		$i = 0;
		while ($p->next_tag()) {
			$i++;
			foreach ($alternatives as $alt) {
				$parts = preg_split('/[\s>+~]+/', $alt);
				$last = end($parts);
				if (!preg_match('/^([a-zA-Z][a-zA-Z0-9-]*)?((?:\.[a-zA-Z0-9_-]+)*)$/', $last, $mm)) return null;
				if ($mm[1] !== '' && strtoupper($mm[1]) !== $p->get_tag()) continue;
				$ok = true;
				foreach (array_filter(explode('.', $mm[2])) as $class) {
					if (!$p->has_class($class)) $ok = false;
				}
				if (!$ok) continue;
				$count++;
				if ($found === null) $found = $i;
				break;
			}
			if ($found !== null && !$combined) break;
		}
		if ($found === null || ($combined && $count !== 1)) return null;
		$p = new WP_HTML_Tag_Processor($html);
		for ($j = 0; $j < $found; $j++) $p->next_tag();
		return $p;
	}

	/* templates */

	private static function finish_template(array $p, array $m): array {
		$file = $m['file'];
		if (!empty($m['main'])) $p['alternatives'] = self::main_alternatives($file, !empty($m['canvas']));
		if (empty($m['canvas'])) {
			$e = self::override_edit($file);
			if ($e) $p['edits'][] = $e;
		}
		return $p;
	}

	/**
	 * template-loader.php tries each template type in order; get_query_template() applies
	 * "{$type}_template_hierarchy" and locate_template() takes the first that exists (child theme, parent theme,
	 * then wp-includes/theme-compat). In a block theme, locate_block_template() looks for a wp_template of the same
	 * names. template_include may then replace the result.
	 */
	private static function main_alternatives(string $file, bool $canvas): array {
		global $_wp_current_template_id;
		$out = array();
		$chosen_slug = (is_string($_wp_current_template_id) && strpos($_wp_current_template_id, '//') !== false) ? substr($_wp_current_template_id, strpos($_wp_current_template_id, '//') + 2) : null;
		$block_theme = function_exists('wp_is_block_theme') && wp_is_block_theme();
		$found_chosen = false;
		foreach (self::$hierarchy as $h) {
			foreach ($h['templates'] as $name) {
				if (count($out) >= 100) break 2;
				$located = locate_template(array($name));
				$alt = array('name' => $name, 'exists' => $located !== '');
				$r = $located !== '' ? self::rel($located) : null;
				if ($r !== null) $alt['file'] = $r;
				if ($canvas || $block_theme) {
					$slug = preg_replace('/\.(php|html)$/', '', $name);
					$tpl = get_block_template(get_stylesheet() . '//' . $slug, 'wp_template');
					if ($tpl) {
						$alt['exists'] = true;
						$alt['name'] = $name . ' (wp_template ' . $slug . ($tpl->source === 'custom' ? ', edited in the Site Editor' : '') . ')';
						if (!$r && $tpl->has_theme_file) {
							$tf = _get_block_template_file('wp_template', $slug);
							if ($tf && ($tr = self::rel($tf['path'])) !== null) $alt['file'] = $tr;
						}
					}
					if ($chosen_slug !== null && $slug === $chosen_slug && !$found_chosen) {
						$alt['chosen'] = true;
						$found_chosen = true;
					}
				} elseif ($located !== '' && wp_normalize_path($located) === $file && !$found_chosen) {
					$alt['chosen'] = true;
					$found_chosen = true;
				}
				$out[] = $alt;
			}
		}
		if (!$found_chosen && !$canvas) {
			$alt = array('name' => self::theme_name($file) . ' (from template_include)', 'exists' => true, 'chosen' => true);
			$r = self::rel($file);
			if ($r !== null) $alt['file'] = $r;
			$out[] = $alt;
		}
		return $out;
	}

	/**
	 * Copying a template file from the parent theme (or wp-includes/theme-compat) into the active theme, where
	 * locate_template() looks first. Offered as an explicit action that names the path; refused when the file is
	 * already there, when it came from a plugin (core's hierarchy does not look in the theme for it), or when the
	 * site turns theme file edits off.
	 */
	private static function override_edit(string $file): ?string {
		$f = wp_normalize_path($file);
		$active = wp_normalize_path(get_stylesheet_directory()) . '/';
		$parent = wp_normalize_path(get_template_directory()) . '/';
		$compat = wp_normalize_path(ABSPATH . WPINC . '/theme-compat') . '/';
		if (strpos($f, $active) === 0) return null;
		$id = 'override-' . self::short($f);
		if (isset(self::$edits[$id])) return $id;
		$name = null;
		if (is_child_theme() && strpos($f, $parent) === 0) $name = substr($f, strlen($parent));
		elseif (strpos($f, $compat) === 0) $name = substr($f, strlen($compat));
		$target = array('id' => $id, 'kind' => 'template-override', 'via' => 'schema', 'revisions' => false);
		if ($name === null) {
			$w = self::whose($f);
			$target['label'] = 'Override ' . basename($f);
			$target['why'] = $w[0] === 'plugin' || $w[0] === 'yours'
				? basename($f) . ' comes from ' . ($w[1] !== '' ? $w[1] : 'a plugin') . ' (through template_include or its own loader), not the theme’s template hierarchy, so a copy in your theme would not be used.'
				: 'This template is in the active theme, and that theme has no parent: there is nowhere to copy it to. Edit it, or make a child theme first.';
			self::$edits[$id] = $target;
			return $id;
		}
		$to = $active . $name;
		$rel_to = self::rel($to);
		$target['label'] = 'Copy ' . $name . ' into ' . wp_get_theme()->get('Name') . ' to change it there';
		$target['schema'] = array('type' => 'object', 'title' => 'Copy the template', 'description' => 'Copies ' . (self::rel($f) ?: $name) . ' to ' . ($rel_to ?: $to) . '. WordPress then uses the copy, which is yours to change.', 'properties' => array('to' => array('type' => 'string', 'const' => $rel_to ?: $to, 'readOnly' => true)), 'required' => array('to'));
		$target['value'] = array('to' => $rel_to ?: $to);
		if (file_exists($to)) $target['why'] = ($rel_to ?: $to) . ' already exists.';
		elseif (defined('DISALLOW_FILE_EDIT') && DISALLOW_FILE_EDIT) $target['why'] = 'This site turns theme file editing off (DISALLOW_FILE_EDIT), so Wanigan does not write theme files through WordPress. Ask an agent to copy it.';
		elseif ($w = self::cannot('edit_themes', 'edit theme files')) $target['why'] = $w;
		self::$edits[$id] = $target;
		self::$private[$id] = array('type' => 'copy', 'from' => $f, 'to' => $to, 'shown' => $rel_to ?: $to);
		return $id;
	}

	private static function finish_wp_template(array $p, array $m): array {
		$tpl = get_block_template($m['wp_template'], 'wp_template');
		if (!$tpl) return $p;
		$vars = array(array('name' => 'template', 'type' => 'string', 'preview' => $tpl->id), array('name' => 'source', 'type' => 'string', 'preview' => $tpl->source === 'custom' ? 'edited in the Site Editor (stored in the database)' : 'the theme’s file'));
		$p['variables'] = $vars;
		if ($tpl->has_theme_file && $tpl->source !== 'custom') {
			$tf = _get_block_template_file('wp_template', $tpl->slug);
			if ($tf) {
				$s = self::source($tf['path'], 1);
				if ($s) $p['source'] = $s;
			}
		}
		if ($tpl->wp_id) $p['history'] = self::history((int) $tpl->wp_id);
		$p['edits'][] = self::link_edit('template-override', 'Edit the template “' . $tpl->title . '” in the Site Editor', admin_url('site-editor.php?p=' . rawurlencode('/wp_template/' . $tpl->id) . '&canvas=edit'), 'edit_theme_options', true);
		return $p;
	}

	private static function finish_template_part(array $p, array $m, array &$edits): array {
		$tp = get_block_template($m['tp'], 'wp_template_part');
		$p['label'] = 'Template part: ' . ($tp ? $tp->title : $m['tp']);
		if (!empty($m['tp_file'])) {
			$s = self::source($m['tp_file'], 1);
			if ($s) $p['source'] = $s;
		}
		$p['variables'][] = array('name' => 'template part', 'type' => 'string', 'preview' => $m['tp'] . (!empty($m['tp_post']) ? ' (edited in the Site Editor: stored in the database)' : ' (the theme’s file)'));
		if (!empty($m['tp_post'])) $p['history'] = self::history((int) $m['tp_post']);
		$edits[] = self::link_edit('template-override', 'Edit the template part “' . ($tp ? $tp->title : $m['tp']) . '” in the Site Editor (changes every page using it)', admin_url('site-editor.php?p=' . rawurlencode('/wp_template_part/' . $m['tp']) . '&canvas=edit'), 'edit_theme_options', true);
		return $p;
	}

	/* widgets and menus */

	/**
	 * A widget's settings, when its widget class shares them with core's REST API (show_instance_in_rest): saved
	 * through /wp/v2/widgets, which runs the widget's own update() to clean them.
	 */
	private static function finish_widget(array $p, array $m): array {
		global $wp_registered_widgets;
		$wid = $m['widget'];
		$id = 'widget-' . self::short($wid);
		$target = array('id' => $id, 'kind' => 'config', 'label' => 'Settings of the ' . $p['label'], 'via' => 'schema', 'revisions' => false);
		$widget = isset($wp_registered_widgets[$wid]['callback'][0]) ? $wp_registered_widgets[$wid]['callback'][0] : null;
		$parsed = function_exists('wp_parse_widget_id') ? wp_parse_widget_id($wid) : array();
		if ($widget instanceof WP_Widget && isset($parsed['number'])) {
			$settings = $widget->get_settings();
			$instance = isset($settings[$parsed['number']]) ? $settings[$parsed['number']] : array();
			$p['variables'] = self::variables(is_array($instance) ? $instance : array(), 'instance');
			if (!empty($widget->widget_options['show_instance_in_rest'])) {
				$props = array();
				foreach ((array) $instance as $k => $v) {
					if (is_scalar($v) && !preg_match(self::SECRET, (string) $k)) $props[$k] = array('type' => is_bool($v) ? 'boolean' : (is_int($v) ? 'integer' : (is_float($v) ? 'number' : 'string')));
				}
				$target['schema'] = array('type' => 'object', 'properties' => $props);
				$target['value'] = (object) array_intersect_key((array) $instance, $props);
				if (!$props) $target['why'] = 'This widget has no simple settings to change here; use Appearance › Widgets.';
			} else {
				$target['why'] = 'This widget does not share its settings with core’s API (show_instance_in_rest is off); change it in Appearance › Widgets.';
			}
			$d = self::describe(array($widget, 'widget'));
			if ($d['source']) $p['source'] = $d['source'];
		} else {
			$target['why'] = 'This widget is not a WP_Widget, so core’s widget API cannot change it; use Appearance › Widgets.';
		}
		if (!isset($target['why']) && ($w = self::cannot('edit_theme_options', 'change widgets'))) $target['why'] = $w;
		self::$edits[$id] = $target;
		self::$private[$id] = array('type' => 'widget', 'widget' => $wid);
		$p['edits'][] = $id;
		return $p;
	}

	private static function finish_menu(array $p, array $m): array {
		if (!empty($m['menu'])) {
			$p['edits'][] = self::link_edit('menu-link', 'Edit this menu in Appearance › Menus', admin_url('nav-menus.php?action=edit&menu=' . (int) $m['menu']), 'edit_theme_options', false);
			$p['history'] = array();
			unset($p['history']);
		}
		return $p;
	}

	/** A menu link's title and address, through /wp/v2/menu-items (nav-menu.php wp_update_nav_menu_item()). */
	private static function finish_item(array $p, array $m): array {
		$item = get_post($m['item']);
		if (!$item) return $p;
		$menu_item = wp_setup_nav_menu_item($item);
		$id = 'menu-item-' . $item->ID;
		$custom = $menu_item->type === 'custom';
		$schema = array('type' => 'object', 'properties' => array(
			'title' => array('type' => 'string', 'title' => 'Link text', 'description' => 'Empty uses the linked item’s own title.'),
			'url' => array('type' => 'string', 'title' => 'Address', 'format' => 'uri') + ($custom ? array() : array('readOnly' => true, 'description' => 'It links to ' . $menu_item->type_label . ' “' . wp_strip_all_tags((string) $menu_item->title) . '”, whose address WordPress works out.')),
		));
		$target = array('id' => $id, 'kind' => 'menu-link', 'label' => 'Menu link “' . wp_strip_all_tags((string) $menu_item->title) . '”', 'via' => 'schema', 'schema' => $schema, 'value' => array('title' => $item->post_title, 'url' => (string) $menu_item->url), 'revisions' => false);
		if ($w = self::cannot('edit_theme_options', 'change menus')) $target['why'] = $w;
		self::$edits[$id] = $target;
		self::$private[$id] = array('type' => 'menu-item', 'item' => $item->ID, 'custom' => $custom);
		$p['edits'][] = $id;
		$p['variables'] = array(
			array('name' => 'type', 'type' => 'string', 'preview' => $menu_item->type . ' (' . $menu_item->object . ')'),
			array('name' => 'url', 'type' => 'string', 'preview' => self::cut((string) $menu_item->url, 400)),
			array('name' => 'menu_order', 'type' => 'integer', 'preview' => (string) $item->menu_order),
		);
		return $p;
	}

	/** The site's title and tagline, through /wp/v2/settings (register_setting() in option.php register_initial_settings()). */
	private static function option_edit(string $option): string {
		$id = 'option-' . $option;
		if (isset(self::$edits[$id])) return $id;
		$labels = array('blogname' => 'Site title', 'blogdescription' => 'Tagline');
		$target = array('id' => $id, 'kind' => 'option', 'label' => $labels[$option], 'via' => 'schema', 'schema' => array('type' => 'string', 'title' => $labels[$option]), 'value' => get_option($option), 'revisions' => false);
		if ($w = self::cannot('manage_options', 'change site settings')) $target['why'] = $w;
		self::$edits[$id] = $target;
		self::$private[$id] = array('type' => 'option', 'field' => $option === 'blogname' ? 'title' : 'description');
		return $id;
	}

	/** A 'native-form' target: the platform's own screen for it, opened by /_wanigan/edit/<id>. */
	private static function link_edit(string $kind, string $label, string $url, $cap, bool $revisions): string {
		$id = 'link-' . self::short($url);
		if (!isset(self::$edits[$id])) {
			$target = array('id' => $id, 'kind' => $kind, 'label' => $label, 'via' => 'native-form', 'revisions' => $revisions);
			$why = is_array($cap) ? self::cannot($cap[0], 'open this', (int) $cap[1]) : self::cannot($cap, 'open this');
			if ($why) $target['why'] = $why;
			self::$edits[$id] = $target;
			self::$private[$id] = array('type' => 'link', 'url' => $url, 'cap' => $cap);
		}
		return $id;
	}

	/* ── collections: what can be moved, and what can be inserted ───────── */

	private static function collections(array $parts): array {
		$out = array();
		// Block lists: a post's top-level blocks, a container block's inner blocks, a template's or template part's.
		$lists = array();
		foreach (self::$meta as $id => $m) {
			if (!isset($parts[$id]) || empty($m['block']) || empty($m['map'])) continue;
			$map = $m['map'];
			$parent = array_slice($map['path'], 0, -1);
			$key = $map['store'] . '|' . implode('.', $parent);
			$lists[$key]['store'] = $map['store'];
			$lists[$key]['parent'] = $parent;
			$lists[$key]['items'][] = $id;
			$lists[$key]['paths'][$id] = $map['path'];
		}
		// The part each list belongs to: its container block, or the content, template or template part.
		$holders = array();
		foreach (self::$meta as $id => $m) {
			if (!isset($parts[$id])) continue;
			if (!empty($m['block']) && !empty($m['map'])) $holders[$m['map']['store'] . '|' . implode('.', $m['map']['path'])] = $id;
			if (!empty($m['content'])) $holders['post:' . $m['post'] . '|'] = $id;
			if (!empty($m['wp_template'])) $holders['tpl:' . $m['wp_template'] . '|'] = $id;
			if (!empty($m['tp'])) $holders['tp:' . $m['tp'] . '|'] = $id;
		}
		$by_store = array();
		foreach ($lists as $key => $l) $by_store[$l['store']][] = 'c-' . self::short($key);
		$palette = self::palette();
		foreach ($lists as $key => $l) {
			$info = self::store_info($l['store']);
			if (!$info) continue;
			$cid = 'c-' . self::short($key);
			$tree = self::$trees[$l['store']];
			$fps = array();
			foreach ($l['items'] as $item) {
				$n = self::node($l['store'], $l['paths'][$item]);
				$fps[$item] = $n ? md5(serialize_block($n)) : '';
			}
			$holder = isset($holders[$key]) ? $holders[$key] : null;
			$c = array('id' => $cid, 'kind' => $info['changes'] === 'content' ? 'post-blocks' : 'region-blocks', 'label' => ($l['parent'] ? 'Blocks inside ' . (isset($parts[$holder]) ? $parts[$holder]['label'] : 'a block') : 'Blocks of ' . $info['label']), 'items' => $l['items'], 'changes' => $info['changes'], 'revisions' => $info['revisions']);
			if ($holder) $c['part'] = $holder;
			$moves = array_values(array_diff($by_store[$l['store']], array($cid)));
			if ($moves) $c['movesTo'] = $moves;
			$c['inserts'] = array();
			foreach ($palette as $e) if ($e['kind'] === 'block' || $e['kind'] === 'pattern') $c['inserts'][] = $e['id'];
			$why = $info['why'];
			if (!$why && !self::round_trips($l['store'])) $why = 'Writing these blocks back would change other parts of ' . $info['label'] . ' (its saved markup does not survive parse_blocks() and serialize_blocks() unchanged).';
			if ($why) $c['why'] = $why;
			$holder_node = $l['parent'] ? self::node($l['store'], $l['parent']) : null;
			$c['_private'] = array('type' => 'blocks', 'store' => $l['store'], 'parent' => $l['parent'], 'holder' => $holder_node ? $holder_node['blockName'] : null, 'paths' => $l['paths'], 'fps' => $fps, 'hash' => md5($tree['content']));
			$out[] = $c;
		}
		// Widget areas: sidebars_widgets, through wp_set_sidebars_widgets() (widgets.php).
		$sidebars = array();
		foreach (self::$meta as $id => $m) {
			if (isset($parts[$id]) && isset($m['sidebar']) && isset($m['widgets'])) $sidebars[$id] = $m;
		}
		$sidebar_ids = array();
		foreach ($sidebars as $id => $m) $sidebar_ids[$id] = 'c-w-' . self::short($m['sidebar']);
		$all = wp_get_sidebars_widgets();
		foreach ($sidebars as $id => $m) {
			$items = array();
			$widgets = array();
			foreach ($m['widgets'] as $w) {
				if (isset($parts[$w])) {
					$items[] = $w;
					$widgets[$w] = self::$meta[$w]['widget'];
				}
			}
			$c = array('id' => $sidebar_ids[$id], 'kind' => 'widgets', 'label' => $parts[$id]['label'], 'part' => $id, 'items' => $items, 'changes' => 'configuration', 'revisions' => false);
			$moves = array_values(array_diff($sidebar_ids, array($sidebar_ids[$id])));
			if ($moves) $c['movesTo'] = $moves;
			if ($w = self::cannot('edit_theme_options', 'change widgets')) $c['why'] = $w;
			$c['_private'] = array('type' => 'widgets', 'sidebar' => $m['sidebar'], 'widgets' => $widgets, 'state' => isset($all[$m['sidebar']]) ? array_values((array) $all[$m['sidebar']]) : array());
			$out[] = $c;
		}
		// Menu levels: the links under one parent, ordered by menu_order, through /wp/v2/menu-items.
		foreach (self::$meta as $id => $m) {
			if (!isset($parts[$id]) || !isset($m['menu']) || empty($m['menu']) || !isset($m['items'])) continue;
			$levels = array();
			foreach ($m['items'] as $item) {
				if (!isset($parts[$item])) continue;
				$levels[self::$meta[$item]['item_parent']][] = $item;
			}
			$level_ids = array();
			foreach (array_keys($levels) as $parent) $level_ids[$parent] = 'c-m-' . $m['menu'] . '-' . $parent;
			$state = self::menu_state((int) $m['menu']);
			foreach ($levels as $parent => $items) {
				$label = $parent ? 'Links under “' . wp_strip_all_tags(get_the_title($parent)) . '” in ' . $parts[$id]['label'] : 'Links of ' . $parts[$id]['label'];
				$c = array('id' => $level_ids[$parent], 'kind' => 'menu', 'label' => $label, 'items' => $items, 'changes' => 'configuration', 'revisions' => false);
				if (!$parent) $c['part'] = $id;
				else {
					foreach ($m['items'] as $it) if (self::$meta[$it]['item'] === $parent && isset($parts[$it])) $c['part'] = $it;
				}
				$moves = array_values(array_diff($level_ids, array($level_ids[$parent])));
				if ($moves) $c['movesTo'] = $moves;
				foreach ($palette as $e) if ($e['kind'] === 'menu-link') $c['inserts'][] = $e['id'];
				if ($w = self::cannot('edit_theme_options', 'change menus')) $c['why'] = $w;
				$ids = array();
				foreach ($items as $it) $ids[$it] = self::$meta[$it]['item'];
				$object = get_queried_object();
				$c['_private'] = array('type' => 'menu', 'menu' => (int) $m['menu'], 'parent' => (int) $parent, 'items' => $ids, 'state' => $state, 'this' => $object instanceof WP_Post ? array($object->post_type, $object->ID) : null);
				$out[] = $c;
			}
		}
		return $out;
	}

	/** What can be inserted: registered patterns, dynamic blocks that render from their attributes alone, and a link to this page. */
	private static function palette(): array {
		static $palette = null;
		if ($palette !== null) return $palette;
		$palette = array();
		foreach (WP_Block_Patterns_Registry::get_instance()->get_all_registered() as $pattern) {
			if (count($palette) >= 300) break;
			if (empty($pattern['name']) || (isset($pattern['inserter']) && !$pattern['inserter'])) continue;
			$e = array('id' => 'pattern:' . $pattern['name'], 'kind' => 'pattern', 'label' => isset($pattern['title']) ? (string) $pattern['title'] : $pattern['name']);
			if (!empty($pattern['description'])) $e['description'] = self::cut((string) $pattern['description'], 500);
			$e['by'] = strtok($pattern['name'], '/');
			$palette[] = $e;
		}
		// A block inserted from here is a void delimiter, <!-- wp:name /-->: right only for a block that renders from its
		// attributes alone. PHP cannot run a block's save(), so that is a dynamic block (render_callback) with no
		// attribute read from markup ("source") and no inner blocks of its own (allowed_blocks, provides_context);
		// anything that needs a reference (a synced pattern, a template part, a pattern) is left to the editor.
		$skip = array('core/block', 'core/pattern', 'core/template-part', 'core/missing', 'core/freeform', 'core/legacy-widget', 'core/widget-group', 'core/post-content');
		foreach (WP_Block_Type_Registry::get_instance()->get_all_registered() as $type) {
			if (count($palette) >= self::LIMITS['palette'] - 1) break;
			if (!$type->is_dynamic() || in_array($type->name, $skip, true) || !empty($type->parent) || !empty($type->ancestor)) continue;
			if (isset($type->supports['inserter']) && $type->supports['inserter'] === false) continue;
			if (!empty($type->allowed_blocks) || !empty($type->provides_context)) continue;
			$sourced = false;
			foreach ((array) $type->attributes as $def) if (is_array($def) && isset($def['source'])) $sourced = true;
			if ($sourced) continue;
			$e = array('id' => 'block:' . $type->name, 'kind' => 'block', 'label' => $type->title ? $type->title : $type->name, 'by' => strtok($type->name, '/'));
			if ($type->description) $e['description'] = self::cut(wp_strip_all_tags((string) $type->description), 500);
			$palette[] = $e;
		}
		$object = get_queried_object();
		if ($object instanceof WP_Post) {
			$palette[] = array('id' => 'menu-link:this', 'kind' => 'menu-link', 'label' => 'A link to this page: ' . wp_strip_all_tags($object->post_title));
		}
		return $palette;
	}

	private static function menu_state(int $menu): array {
		$state = array();
		foreach ((array) wp_get_nav_menu_items($menu, array('update_post_term_cache' => false)) as $it) $state[(int) $it->ID] = array((int) $it->menu_item_parent, (int) $it->menu_order);
		return $state;
	}

	/* ── stored block trees ─────────────────────────────────────────────── */

	/**
	 * Where a list of blocks is stored, and how WordPress saves it: a post's content through its REST route (a new
	 * revision), or a block template or template part as it is in the Site Editor (block-template-utils.php
	 * get_block_template(): the theme's file, or the database copy the Site Editor saved), through
	 * /wp/v2/templates or /wp/v2/template-parts, which save a database copy as the Site Editor does.
	 */
	private static function store_info(string $store): ?array {
		static $cache = array();
		if (array_key_exists($store, $cache)) return $cache[$store];
		$info = null;
		if (preg_match('/^post:(\d+)$/', $store, $m)) {
			$post = get_post((int) $m[1]);
			if ($post) {
				$type = get_post_type_object($post->post_type);
				$noun = $type ? strtolower($type->labels->singular_name) : 'post';
				$why = self::post_why($post, $noun);
				$route = rest_get_route_for_post($post);
				if (!$why && $route === '') $why = 'This ' . $noun . ' type is not in the REST API (show_in_rest is off), which is how WordPress saves blocks here.';
				$info = array('content' => $post->post_content, 'route' => $route, 'post' => $post->ID, 'label' => $noun . ' “' . self::cut(wp_strip_all_tags($post->post_title), 60) . '”', 'noun' => $noun, 'changes' => 'content', 'revisions' => post_type_supports($post->post_type, 'revisions') && wp_revisions_enabled($post), 'why' => $why);
			}
		} elseif (preg_match('/^(tp|tpl):(.+)$/', $store, $m)) {
			$kind = $m[1] === 'tp' ? 'wp_template_part' : 'wp_template';
			$tpl = get_block_template($m[2], $kind);
			if ($tpl) {
				$why = self::cannot('edit_theme_options', 'change templates');
				if (!$why && $tpl->wp_id) $why = self::lock((int) $tpl->wp_id, $m[1] === 'tp' ? 'template part' : 'template');
				$info = array('content' => (string) $tpl->content, 'route' => '/wp/v2/' . ($m[1] === 'tp' ? 'template-parts' : 'templates') . '/' . $tpl->id, 'post' => $tpl->wp_id ? (int) $tpl->wp_id : null, 'label' => ($m[1] === 'tp' ? 'the template part “' : 'the template “') . $tpl->title . '”', 'noun' => $m[1] === 'tp' ? 'template part' : 'template', 'changes' => 'configuration', 'revisions' => true, 'why' => $why);
			}
		}
		if ($info && !isset(self::$trees[$store])) self::$trees[$store] = array('content' => $info['content'], 'blocks' => parse_blocks($info['content']));
		$cache[$store] = $info;
		return $info;
	}

	private static function node(string $store, array $path): ?array {
		if (!isset(self::$trees[$store]) && !self::store_info($store)) return null;
		return self::node_in(self::$trees[$store]['blocks'], $path);
	}

	private static function node_in(array $blocks, array $path): ?array {
		$list = $blocks;
		$node = null;
		foreach ($path as $i) {
			if (!isset($list[$i]) || !is_array($list[$i])) return null;
			$node = $list[$i];
			$list = isset($node['innerBlocks']) ? $node['innerBlocks'] : array();
		}
		return $node;
	}

	/**
	 * Where a rendered block is in its stored tree: its parent's place plus its index, checked against the stored
	 * block (name, attributes and markup). When WordPress inserted blocks while rendering (block hooks), the index
	 * is off: the one stored sibling that matches is taken, or none.
	 */
	private static function map_child(array $map, int $index, array $parsed): ?array {
		$store = $map['store'];
		if (!self::store_info($store)) return null;
		$siblings = $map['path'] ? (self::node($store, $map['path'])['innerBlocks'] ?? array()) : self::$trees[$store]['blocks'];
		if (isset($siblings[$index]) && self::same_block($siblings[$index], $parsed)) return array('store' => $store, 'path' => array_merge($map['path'], array($index)));
		$match = null;
		foreach ($siblings as $i => $s) {
			if (self::same_block($s, $parsed)) {
				if ($match !== null) return null;
				$match = $i;
			}
		}
		return $match === null ? null : array('store' => $store, 'path' => array_merge($map['path'], array($match)));
	}

	private static function same_block(array $a, array $b): bool {
		$strip = function ($attrs) {
			$attrs = is_array($attrs) ? $attrs : array();
			unset($attrs['metadata']['ignoredHookedBlocks']);
			if (isset($attrs['metadata']) && !$attrs['metadata']) unset($attrs['metadata']);
			return $attrs;
		};
		return (isset($a['blockName']) ? $a['blockName'] : null) === (isset($b['blockName']) ? $b['blockName'] : null)
			&& $strip(isset($a['attrs']) ? $a['attrs'] : array()) == $strip(isset($b['attrs']) ? $b['attrs'] : array())
			&& (isset($a['innerHTML']) ? $a['innerHTML'] : '') === (isset($b['innerHTML']) ? $b['innerHTML'] : '');
	}

	/** Whether blocks.php serialize_blocks( parse_blocks( $content ) ) gives the content back byte for byte. */
	private static function round_trips(string $store): bool {
		static $cache = array();
		if (!isset($cache[$store])) $cache[$store] = isset(self::$trees[$store]) && serialize_blocks(self::$trees[$store]['blocks']) === self::$trees[$store]['content'];
		return $cache[$store];
	}

	/* ── assets ──────────────────────────────────────────────────────────── */

	/**
	 * class-wp-dependencies.php: the scripts and styles printed ($done) or still queued, with what added them.
	 * script-loader.php wp_maybe_inline_styles() prints small stylesheets inline and sets their src to false,
	 * keeping the address in 'inlined_src' and the file in 'path'; class-wp-script-modules.php (6.5+) keeps
	 * script modules apart from wp_scripts().
	 */
	private static function assets(): array {
		$out = array();
		foreach (array('script' => wp_scripts(), 'style' => wp_styles()) as $kind => $deps) {
			foreach (array_unique(array_merge((array) $deps->done, (array) $deps->queue)) as $handle) {
				if (!isset($deps->registered[$handle])) continue;
				$src = $deps->registered[$handle]->src;
				$path = $deps->get_data($handle, 'path');
				if (!is_string($src) || $src === '') {
					$inlined = $deps->get_data($handle, 'inlined_src');
					$extra = $deps->get_data($handle, 'after');
					if (is_string($inlined) && $inlined !== '') $src = $inlined . ' (printed inline)';
					elseif (is_string($path) && $path !== '') $src = (self::rel($path) ?: basename($path)) . ' (printed inline)';
					elseif ($extra) $src = '(inline)';
					else continue;
				}
				$file = is_string($path) && $path !== '' ? wp_normalize_path($path) : self::asset_file(preg_replace('/ \(printed inline\)$/', '', $src));
				if (!self::asset($out, $kind, (string) $handle, $src, $file)) break 2;
			}
		}
		$modules = function_exists('wp_script_modules') ? wp_script_modules() : null;
		if ($modules && method_exists($modules, 'get_queue') && method_exists($modules, 'get_registered')) {
			foreach ((array) $modules->get_queue() as $module) {
				$m = $modules->get_registered($module);
				$src = is_array($m) && isset($m['src']) && is_string($m['src']) ? $m['src'] : '';
				if ($src === '') continue;
				if (!self::asset($out, 'script', 'module:' . $module, $src, self::asset_file($src))) break;
			}
		}
		return $out;
	}

	private static function asset(array &$out, string $kind, string $handle, string $src, ?string $file): bool {
		if (count($out) >= self::LIMITS['assets']) {
			self::$truncated['assets'] = true;
			return false;
		}
		$a = array('kind' => $kind, 'handle' => $handle, 'src' => self::cut($src, 2000), 'by' => $file ? self::whose($file)[2] : 'unknown');
		if ($file && is_file($file)) $a['bytes'] = (int) filesize($file);
		$out[] = $a;
		return true;
	}

	private static function asset_file(string $src): ?string {
		$path = (string) wp_parse_url($src, PHP_URL_PATH);
		if ($path === '') return null;
		$host = wp_parse_url($src, PHP_URL_HOST);
		if ($host && $host !== wp_parse_url(home_url(), PHP_URL_HOST)) return null;
		$content = (string) wp_parse_url(content_url(), PHP_URL_PATH);
		if ($content !== '' && strpos($path, $content . '/') === 0) return wp_normalize_path(WP_CONTENT_DIR . substr($path, strlen($content)));
		$site = (string) wp_parse_url(site_url(), PHP_URL_PATH);
		$rel = $site !== '' && strpos($path, $site . '/') === 0 ? substr($path, strlen($site)) : $path;
		return wp_normalize_path(ABSPATH . ltrim($rel, '/'));
	}

	/* ── naming code ─────────────────────────────────────────────────────── */

	/** Whether a callback is this file's own. */
	private static function ours($fn): bool {
		if (is_string($fn)) return strpos($fn, 'wanigan_live') === 0 || strpos($fn, 'Wanigan_Live::') === 0;
		if (is_array($fn)) return isset($fn[0]) && ($fn[0] === self::class || $fn[0] === 'Wanigan_Live');
		if ($fn instanceof Closure) {
			if (self::$closures && self::$closures->contains($fn)) return self::$closures[$fn];
			try {
				$own = wp_normalize_path((string) (new ReflectionFunction($fn))->getFileName()) === self::$self;
			} catch (Throwable $e) {
				$own = false;
			}
			if (self::$closures) self::$closures[$fn] = $own;
			return $own;
		}
		return false;
	}

	/** A callback's name, where it is written, and whose it is. */
	private static function describe($fn): array {
		$key = null;
		if (is_string($fn)) $key = $fn;
		elseif (is_array($fn) && isset($fn[0], $fn[1]) && is_string($fn[1])) $key = (is_object($fn[0]) ? get_class($fn[0]) . '->' : (string) $fn[0] . '::') . $fn[1];
		if ($key !== null && isset(self::$describe[$key])) return self::$describe[$key];
		$name = 'unknown';
		$r = null;
		try {
			if (is_string($fn)) {
				$name = $fn;
				if (strpos($fn, '::') !== false) {
					list($c, $m) = explode('::', $fn, 2);
					$r = new ReflectionMethod($c, $m);
				} elseif (function_exists($fn)) {
					$r = new ReflectionFunction($fn);
				}
			} elseif ($fn instanceof Closure) {
				$r = new ReflectionFunction($fn);
				$scope = $r->getClosureScopeClass();
				$name = ($scope ? self::class_name($scope->getName()) . '::' : '') . '{closure}';
			} elseif (is_array($fn) && isset($fn[0], $fn[1])) {
				$class = is_object($fn[0]) ? get_class($fn[0]) : (string) $fn[0];
				$name = self::class_name($class) . (is_object($fn[0]) ? '->' : '::') . $fn[1];
				if (method_exists($fn[0], (string) $fn[1])) $r = new ReflectionMethod($fn[0], (string) $fn[1]);
			} elseif (is_object($fn) && method_exists($fn, '__invoke')) {
				$name = self::class_name(get_class($fn)) . '->__invoke';
				$r = new ReflectionMethod($fn, '__invoke');
			}
		} catch (Throwable $e) {
			$r = null;
		}
		$file = $r ? $r->getFileName() : false;
		$source = $file ? self::source($file, (int) $r->getStartLine()) : null;
		$by = $file ? self::whose($file)[2] : ($r && $r->isInternal() ? 'php' : 'unknown');
		$out = array('callback' => self::cut($name, 300), 'source' => $source, 'by' => $by);
		if ($key !== null) self::$describe[$key] = $out;
		return $out;
	}

	private static function class_name(string $class): string {
		$nul = strpos($class, "\0");
		return $nul === false ? $class : substr($class, 0, $nul);
	}

	/** A file and line as the trace names them: relative to the project, with whose code it is. */
	private static function source(string $file, int $line = 0): ?array {
		$rel = self::rel($file);
		if ($rel === null) return null;
		$w = self::whose($file);
		$s = array('file' => $rel, 'owner' => $w[0]);
		if ($line > 0) $s['line'] = $line;
		if ($w[1] !== '') $s['package'] = $w[1];
		return $s;
	}

	/** The project's root: the folder holding wp-content, less WANIGAN_LIVE_SITE_DIR. */
	private static function root(): string {
		static $root = null;
		if ($root === null) {
			$base = untrailingslashit(wp_normalize_path(dirname(WP_CONTENT_DIR)));
			$dir = trim(WANIGAN_LIVE_SITE_DIR, '/');
			$root = ($dir !== '' && substr($base, -strlen($dir) - 1) === '/' . $dir) ? substr($base, 0, -strlen($dir) - 1) : $base;
		}
		return $root;
	}

	public static function rel($file): ?string {
		if (!is_string($file) || $file === '') return null;
		$f = wp_normalize_path($file);
		$r = self::root() . '/';
		if (strpos($f, $r) !== 0) return null;
		$rel = substr($f, strlen($r));
		return ($rel === '' || in_array('..', explode('/', $rel), true)) ? null : $rel;
	}

	/**
	 * Whose code a file is: [owner, package, by]. A plugin or theme core's update data knows (the
	 * update_plugins and update_themes site transients: WordPress.org's or a vendor's updater) is someone else's;
	 * one installed but unknown to it is the project's own. Must-use plugins have no update source and count as the
	 * project's own.
	 */
	private static function whose(string $file): array {
		$f = wp_normalize_path($file);
		$dir = dirname($f);
		if (isset(self::$whose[$dir])) return self::$whose[$dir];
		$out = array('unknown', '', 'unknown');
		$plugins = wp_normalize_path(WP_PLUGIN_DIR) . '/';
		$mu = wp_normalize_path(WPMU_PLUGIN_DIR) . '/';
		$content = wp_normalize_path(WP_CONTENT_DIR) . '/';
		$abs = wp_normalize_path(ABSPATH);
		$themes = array_unique(array(wp_normalize_path(get_theme_root()), wp_normalize_path(dirname(get_stylesheet_directory())), wp_normalize_path(dirname(get_template_directory()))));
		$first = function ($base) use ($f) {
			$rest = substr($f, strlen($base));
			$seg = strtok($rest, '/');
			return $seg === false ? '' : $seg;
		};
		if (strpos($f, $mu) === 0) {
			$seg = preg_replace('/\.php$/', '', $first($mu));
			$out = array('yours', $seg, $seg);
		} elseif (strpos($f, $plugins) === 0) {
			$seg = $first($plugins);
			$slug = preg_replace('/\.php$/', '', $seg);
			$out = array(self::updates('update_plugins', $seg, 'plugin'), $slug, $slug);
		} else {
			foreach ($themes as $root) {
				if (strpos($f, $root . '/') === 0) {
					$slug = $first($root . '/');
					$out = array(self::updates('update_themes', $slug, 'theme'), $slug, $slug);
					break;
				}
			}
			if ($out[0] === 'unknown') {
				if (preg_match('#/vendor/([^/]+/[^/]+)/#', $f, $m)) $out = array('contrib', $m[1], $m[1]);
				elseif (strpos($f, $abs . 'wp-includes/') === 0 || strpos($f, $abs . 'wp-admin/') === 0 || $dir . '/' === $abs) $out = array('core', 'wordpress', 'core');
				elseif ($dir . '/' === $content) $out = array('unknown', 'drop-in', 'drop-in');
			}
		}
		self::$whose[$dir] = $out;
		return $out;
	}

	private static function updates(string $transient, string $key, string $kind): string {
		static $data = array();
		if (!array_key_exists($transient, $data)) $data[$transient] = get_site_transient($transient);
		$u = $data[$transient];
		if (!is_object($u) || empty($u->checked)) return 'unknown';
		foreach (array('response', 'no_update') as $list) {
			if (empty($u->$list)) continue;
			foreach ((array) $u->$list as $file => $x) {
				if ($file === $key || strpos((string) $file, $key . '/') === 0) return $kind;
			}
		}
		return 'yours';
	}

	/** The first file outside core and this plugin on the stack: where a theme or plugin asked for what is happening. */
	private static function caller_source(): ?array {
		$core = null;
		foreach (debug_backtrace(DEBUG_BACKTRACE_IGNORE_ARGS, 30) as $f) {
			if (empty($f['file'])) continue;
			$file = wp_normalize_path($f['file']);
			// The hook machinery itself says nothing about who asked.
			if ($file === self::$self || str_ends_with($file, '/wp-includes/plugin.php') || str_ends_with($file, '/wp-includes/class-wp-hook.php')) continue;
			if (self::whose($file)[0] !== 'core') return self::source($file, isset($f['line']) ? (int) $f['line'] : 0);
			if ($core === null) $core = self::source($file, isset($f['line']) ? (int) $f['line'] : 0);
		}
		return $core;
	}

	/** Where a function (apply_filters) was called from: the file and line, and the function that called it. */
	private static function filter_site(string $function): ?array {
		$bt = debug_backtrace(DEBUG_BACKTRACE_IGNORE_ARGS, 12);
		foreach ($bt as $i => $f) {
			if (isset($f['function']) && $f['function'] === $function && !isset($f['class'])) {
				return array('file' => isset($f['file']) ? wp_normalize_path($f['file']) : '', 'caller' => isset($bt[$i + 1]['function']) && !isset($bt[$i + 1]['class']) ? $bt[$i + 1]['function'] : '');
			}
		}
		return null;
	}

	private static function in_theme(string $file): bool {
		foreach (array(get_stylesheet_directory(), get_template_directory()) as $dir) {
			if ($file !== '' && strpos($file, wp_normalize_path($dir) . '/') === 0) return true;
		}
		return false;
	}

	/* ── values ──────────────────────────────────────────────────────────── */

	private static function query_variables(): array {
		global $wp_query;
		$vars = array();
		$object = get_queried_object();
		if ($object) $vars[] = array('name' => 'queried object', 'type' => get_class($object), 'preview' => self::preview($object));
		$flags = array();
		foreach (array('is_front_page', 'is_home', 'is_singular', 'is_single', 'is_page', 'is_attachment', 'is_archive', 'is_category', 'is_tag', 'is_tax', 'is_author', 'is_date', 'is_search', 'is_404', 'is_paged', 'is_post_type_archive') as $c) {
			if (function_exists($c) && call_user_func($c)) $flags[] = $c;
		}
		$vars[] = array('name' => 'conditionals', 'type' => 'array', 'preview' => implode(', ', $flags));
		if ($wp_query instanceof WP_Query) {
			$vars[] = array('name' => 'found_posts', 'type' => 'integer', 'preview' => (string) $wp_query->found_posts);
			foreach ((array) $wp_query->query_vars as $k => $v) {
				if ($v === '' || $v === array() || $v === null || $v === false || $v === 0) continue;
				if (count($vars) >= 80) break;
				$vars[] = array('name' => 'query_vars.' . $k, 'type' => gettype($v), 'preview' => self::preview(preg_match(self::SECRET, (string) $k) ? '[redacted]' : $v));
			}
		}
		return $vars;
	}

	private static function variables(array $values, string $prefix): array {
		$out = array();
		foreach ($values as $k => $v) {
			if (count($out) >= 60) break;
			$out[] = array('name' => $prefix . '.' . $k, 'type' => is_object($v) ? self::class_name(get_class($v)) : gettype($v), 'preview' => self::preview(preg_match(self::SECRET, (string) $k) ? '[redacted]' : $v));
		}
		return $out;
	}

	/** A bounded rendering of a value, with secrets redacted by key. */
	public static function preview($v): string {
		return self::cut(self::flat($v, 0), self::LIMITS['preview']);
	}

	private static function flat($v, int $depth) {
		if (is_string($v)) return $v;
		if (is_bool($v)) return $v ? 'true' : 'false';
		if ($v === null) return 'null';
		if (is_int($v) || is_float($v)) return (string) $v;
		if ($v instanceof WP_Post) return 'WP_Post ' . $v->ID . ' (' . $v->post_type . ': ' . wp_strip_all_tags($v->post_title) . ')';
		if ($v instanceof WP_Term) return 'WP_Term ' . $v->term_id . ' (' . $v->taxonomy . ': ' . $v->name . ')';
		if ($v instanceof WP_User) return 'WP_User ' . $v->ID . ' (' . $v->user_login . ')';
		if ($v instanceof WP_Post_Type) return 'WP_Post_Type ' . $v->name;
		if ($v instanceof WP_Block) return 'WP_Block ' . $v->name;
		if (is_object($v)) return self::class_name(get_class($v));
		if (is_array($v)) {
			$json = wp_json_encode(self::bounded($v, $depth));
			return $json === false ? 'array(' . count($v) . ')' : $json;
		}
		return gettype($v);
	}

	private static function bounded(array $a, int $depth): array {
		$out = array();
		$n = 0;
		foreach ($a as $k => $v) {
			if (++$n > 30) {
				$out['…'] = (count($a) - 30) . ' more';
				break;
			}
			if (is_string($k) && preg_match(self::SECRET, $k)) $out[$k] = '[redacted]';
			elseif (is_array($v)) $out[$k] = $depth < 3 ? self::bounded($v, $depth + 1) : 'array(' . count($v) . ')';
			elseif (is_object($v)) $out[$k] = self::flat($v, $depth + 1);
			elseif (is_string($v)) $out[$k] = self::cut($v, 200);
			else $out[$k] = $v;
		}
		return $out;
	}

	private static function cut(string $s, int $max): string {
		if (strlen($s) <= $max) return $s;
		return function_exists('mb_strcut') ? mb_strcut($s, 0, $max, 'UTF-8') : substr($s, 0, $max);
	}

	private static function short(string $s): string {
		return substr(md5($s), 0, 10);
	}


	/* ── Go to: the site's destinations ─────────────────────────────────── */

	/**
	 * GET /_wanigan/find: every destination the logged-in user may open (src/shared/live-find.ts). With ?q= it also
	 * searches posts of every show_ui type and media (titles only: WP_Query's search_columns, 6.2+), terms and users
	 * by name, at most 50, ahead of the index.
	 */
	private static function find(): void {
		if (!is_user_logged_in()) self::answer(array('ok' => false, 'error' => 'Log in to WordPress in the live view first.'), 403);
		$user = wp_get_current_user();
		global $wp_version;
		$cache = md5(implode('|', array($user->ID, md5(serialize($user->allcaps)), (int) get_option('wanigan_live_changes', 0), md5(serialize(get_option('active_plugins'))), get_stylesheet(), $wp_version, get_locale(), (string) get_option('page_on_front'), (string) get_option('page_for_posts'), (string) filemtime(__FILE__))));
		$key = 'wanigan_live_f_' . $user->ID;
		$stored = get_transient($key);
		if (is_array($stored) && isset($stored['cacheId']) && $stored['cacheId'] === $cache) {
			$index = $stored['items'];
		} else {
			$index = self::find_index();
			set_transient($key, array('cacheId' => $cache, 'items' => $index), HOUR_IN_SECONDS);
		}
		$q = isset($_GET['q']) ? trim(wp_unslash((string) $_GET['q'])) : '';
		if ($q === '') self::answer(array('cacheId' => $cache, 'items' => $index));
		$limit = isset($_GET['limit']) ? max(1, min(50, (int) $_GET['limit'])) : 50;
		$found = self::find_search(self::cut($q, 200), $limit);
		self::answer(array('cacheId' => $cache, 'items' => array_merge($found['items'], $index), 'total' => $found['total'], 'truncated' => $found['total'] > count($found['items'])));
	}

	private static function find_index(): array {
		$items = self::find_admin_menu();
		$seen = array();
		foreach ($items as $i) $seen[$i['url']] = true;
		$add = function ($item) use (&$items, &$seen) {
			if (!$item || isset($seen[$item['url'] . '#' . $item['id']])) return;
			$seen[$item['url'] . '#' . $item['id']] = true;
			$items[] = $item;
		};
		// The front page and the posts page (options-reading.php: show_on_front, page_on_front, page_for_posts).
		$home = self::site_path(home_url('/'));
		if (get_option('show_on_front') === 'page' && ($front = get_post((int) get_option('page_on_front')))) {
			$item = self::find_post($front, array());
			if ($item) {
				$item['id'] = 'front';
				$item['label'] = 'Front page: ' . $item['label'];
				$item['url'] = $home;
				$add($item);
			}
			if ($posts = get_post((int) get_option('page_for_posts'))) {
				$item = self::find_post($posts, array());
				if ($item) {
					$item['label'] = 'Posts page: ' . $item['label'];
					$add($item);
				}
			}
		} elseif ($home) {
			$add(array('id' => 'front', 'kind' => 'content', 'label' => 'Front page (latest posts)', 'url' => $home, 'tags' => array('home')));
		}
		// The block theme's templates and template parts, in the Site Editor.
		if (function_exists('wp_is_block_theme') && wp_is_block_theme() && current_user_can('edit_theme_options')) {
			$add(array('id' => 'site-editor:styles', 'kind' => 'setting', 'label' => 'Styles', 'url' => self::site_path(admin_url('site-editor.php?p=' . rawurlencode('/styles'))), 'trail' => array('Appearance', 'Editor', 'Styles')));
			foreach (array('wp_template' => 'Template', 'wp_template_part' => 'Template part') as $type => $noun) {
				foreach (get_block_templates(array(), $type) as $t) {
					$url = self::site_path(admin_url('site-editor.php?p=' . rawurlencode('/' . $type . '/' . $t->id) . '&canvas=edit'));
					if (!$url) continue;
					$item = array('id' => 'template:' . $t->id, 'kind' => 'template', 'label' => $t->title ? (string) $t->title : $t->slug, 'url' => $url, 'type' => $noun, 'edit' => $url, 'tags' => array_values(array_filter(array($t->slug, $t->source === 'custom' ? 'customized' : 'theme', isset($t->area) ? (string) $t->area : null))));
					if ($t->wp_id && ($post = get_post($t->wp_id))) $item['changed'] = self::ms($post->post_modified_gmt);
					$add($item);
				}
			}
		}
		// The most recently changed content of every public or show_ui post type.
		$types = array_unique(array_merge(get_post_types(array('public' => true)), get_post_types(array('show_ui' => true))));
		$posts = array();
		foreach ($types as $type) {
			if (in_array($type, array('wp_template', 'wp_template_part', 'revision', 'nav_menu_item', 'wp_global_styles', 'wp_font_family', 'wp_font_face', 'customize_changeset', 'oembed_cache', 'user_request', 'custom_css'), true)) continue;
			$q = new WP_Query(array('post_type' => $type, 'post_status' => $type === 'attachment' ? 'inherit' : array('publish', 'future', 'draft', 'pending', 'private'), 'posts_per_page' => 10, 'orderby' => 'modified', 'order' => 'DESC', 'no_found_rows' => true, 'ignore_sticky_posts' => true, 'update_post_meta_cache' => false, 'update_post_term_cache' => false, 'perm' => 'readable'));
			foreach ($q->posts as $post) $posts[] = $post;
		}
		$revisions = self::latest_revisions($posts);
		foreach ($posts as $post) $add(self::find_post($post, $revisions));
		return array_slice($items, 0, 5000);
	}

	/**
	 * The wp-admin menu as wp-admin/menu.php builds it: core's entries for this user's capabilities, every plugin's
	 * add_menu_page() and add_submenu_page() on admin_menu, and wp-admin/includes/menu.php's removal of what the
	 * user may not open. Links are made as wp-admin/menu-header.php _wp_menu_output() makes them.
	 */
	private static function find_admin_menu(): array {
		if (!is_admin() || !current_user_can('read')) return array();
		global $menu, $submenu, $_wp_menu_nopriv, $_wp_submenu_nopriv, $_registered_pages, $_parent_pages, $admin_page_hooks, $_wp_real_parent_file, $compat, $_wp_last_object_menu, $_wp_last_utility_menu, $menu_order, $default_menu_order, $pagenow, $typenow, $taxnow, $plugin_page, $hook_suffix, $parent_file, $submenu_file, $self, $title;
		require_once ABSPATH . 'wp-admin/includes/admin.php';
		$pagenow = 'index.php';
		ob_start();
		try {
			require ABSPATH . 'wp-admin/menu.php';
		} catch (Throwable $e) {
			ob_end_clean();
			return array(array('id' => 'admin:index.php', 'kind' => 'admin', 'label' => 'Dashboard', 'url' => self::site_path(admin_url('index.php'))));
		}
		ob_end_clean();
		$plugins = wp_normalize_path(WP_PLUGIN_DIR) . '/';
		$admin = wp_normalize_path(ABSPATH . 'wp-admin') . '/';
		$file_of = function ($slug) {
			$pos = strpos($slug, '?');
			return $pos === false ? $slug : substr($slug, 0, $pos);
		};
		$is_plugin_page = function ($slug, $parent) use ($plugins, $admin, $file_of) {
			$file = $file_of($slug);
			return get_plugin_page_hook($slug, $parent) || ($slug !== 'index.php' && file_exists($plugins . $file) && !file_exists($admin . $file));
		};
		$label = function ($html) {
			// Counts ride along in spans (Comments 3, Plugins 2); they are not part of the name.
			$text = preg_replace('#<span[^>]*>.*?</span>#s', '', (string) $html);
			return trim(html_entity_decode(wp_strip_all_tags($text), ENT_QUOTES));
		};
		$kind_of = function ($parent, $slug) {
			if ($parent === 'options-general.php' || $slug === 'options-general.php' || strpos($slug, 'customize.php') === 0) return 'setting';
			if (in_array($parent, array('themes.php', 'site-editor.php'), true) || in_array($slug, array('nav-menus.php', 'widgets.php', 'themes.php', 'site-editor.php'), true) || strpos($slug, 'edit-tags.php') === 0) return 'structure';
			return 'admin';
		};
		$out = array();
		foreach ((array) $menu as $item) {
			if (empty($item[2]) || (isset($item[4]) && strpos((string) $item[4], 'wp-menu-separator') !== false)) continue;
			$top = $label($item[0]);
			$subs = isset($submenu[$item[2]]) ? $submenu[$item[2]] : array();
			$admin_is_parent = false;
			if ($subs) {
				$first = reset($subs);
				if ($is_plugin_page($first[2], $item[2])) {
					$admin_is_parent = true;
					$url = 'admin.php?page=' . $first[2];
				} else {
					$url = $first[2];
				}
			} elseif ($is_plugin_page($item[2], 'admin.php')) {
				$admin_is_parent = true;
				$url = 'admin.php?page=' . $item[2];
			} else {
				$url = $item[2];
			}
			$path = self::site_path(admin_url($url));
			if ($path && $top !== '') $out[] = array('id' => 'menu:' . $item[2], 'kind' => $kind_of('', $item[2]), 'label' => $top, 'url' => $path, 'trail' => array($top));
			$menu_file = $file_of($item[2]);
			foreach ($subs as $sub) {
				if (empty($sub[2])) continue;
				if ($is_plugin_page($sub[2], $item[2])) {
					$sub_url = ((!$admin_is_parent && file_exists($plugins . $menu_file) && !is_dir($plugins . $item[2])) || file_exists($admin . $menu_file))
						? add_query_arg(array('page' => $sub[2]), $item[2])
						: add_query_arg(array('page' => $sub[2]), 'admin.php');
				} else {
					$sub_url = $sub[2];
				}
				$sub_path = self::site_path(admin_url($sub_url));
				$name = $label($sub[0]);
				if (!$sub_path || $name === '') continue;
				$out[] = array('id' => 'admin:' . $sub_url, 'kind' => $kind_of($item[2], $sub[2]), 'label' => $name, 'url' => $sub_path, 'trail' => array($top, $name), 'tags' => array_values(array_filter(array(isset($sub[3]) ? $label($sub[3]) : null))));
			}
		}
		return $out;
	}

	/** A post as a destination: where it shows, its edit screen, and what else wp-admin offers for it. */
	private static function find_post(WP_Post $post, array $revisions): ?array {
		if (!current_user_can('read_post', $post->ID)) return null;
		$type = get_post_type_object($post->post_type);
		if (!$type) return null;
		$can_edit = current_user_can('edit_post', $post->ID);
		$edit = $can_edit ? self::site_path((string) get_edit_post_link($post->ID, 'raw')) : null;
		$viewable = is_post_type_viewable($type) && $post->post_status !== 'trash';
		$view = $viewable ? self::site_path((string) get_permalink($post)) : null;
		$url = $view ? $view : $edit;
		if (!$url) return null;
		$statuses = array('publish' => 'published', 'inherit' => 'published', 'future' => 'scheduled', 'draft' => 'draft', 'pending' => 'draft', 'auto-draft' => 'draft', 'private' => 'private', 'trash' => 'trash');
		$item = array('id' => 'post:' . $post->ID, 'kind' => $post->post_type === 'attachment' ? 'media' : 'content', 'label' => $post->post_title !== '' ? wp_strip_all_tags($post->post_title) : '(no title)', 'url' => $url, 'type' => $type->labels->singular_name, 'tags' => array_values(array_filter(array($post->post_type, $post->post_name, (string) $post->ID))));
		if (isset($statuses[$post->post_status])) $item['status'] = $statuses[$post->post_status];
		$changed = self::ms($post->post_modified_gmt);
		if ($changed) $item['changed'] = $changed;
		$actions = array();
		if ($edit) {
			$item['edit'] = $edit;
			$actions[] = array('label' => 'Edit', 'url' => $edit);
		}
		if ($viewable && $can_edit && $post->post_status !== 'publish' && ($preview = self::site_path((string) get_preview_post_link($post)))) $actions[] = array('label' => 'Preview', 'url' => $preview);
		elseif ($view) $actions[] = array('label' => 'View', 'url' => $view);
		if ($can_edit && isset($revisions[$post->ID]) && ($r = self::site_path(admin_url('revision.php?revision=' . (int) $revisions[$post->ID])))) $actions[] = array('label' => 'Revisions', 'url' => $r);
		if ($post->post_status !== 'trash' && current_user_can('delete_post', $post->ID) && ($trash = self::site_path((string) get_delete_post_link($post->ID)))) $actions[] = array('label' => EMPTY_TRASH_DAYS ? 'Trash' : 'Delete permanently', 'url' => $trash);
		if ($actions) $item['actions'] = $actions;
		return $item;
	}

	/** The newest revision of each post, in one query over the revisions core keeps (revision.php). */
	private static function latest_revisions(array $posts): array {
		$ids = array();
		foreach ($posts as $p) if (post_type_supports($p->post_type, 'revisions')) $ids[] = (int) $p->ID;
		if (!$ids) return array();
		global $wpdb;
		$rows = $wpdb->get_results("SELECT post_parent, MAX(ID) AS latest FROM {$wpdb->posts} WHERE post_type = 'revision' AND post_parent IN (" . implode(',', array_unique($ids)) . ') GROUP BY post_parent');
		$out = array();
		foreach ((array) $rows as $r) $out[(int) $r->post_parent] = (int) $r->latest;
		return $out;
	}

	private static function find_search(string $q, int $limit): array {
		$items = array();
		$total = 0;
		if (ctype_digit($q) && ($post = get_post((int) $q)) && ($item = self::find_post($post, array()))) {
			$items[] = $item;
			$total++;
		}
		$types = array_values(array_diff(get_post_types(array('show_ui' => true)), array('wp_template', 'wp_template_part', 'wp_navigation', 'wp_global_styles')));
		$types[] = 'attachment';
		$statuses = array('publish', 'future', 'draft', 'pending', 'private', 'inherit');
		if (current_user_can('edit_posts')) $statuses[] = 'trash';
		$query = new WP_Query(array('s' => $q, 'search_columns' => array('post_title'), 'post_type' => array_unique($types), 'post_status' => $statuses, 'posts_per_page' => $limit, 'ignore_sticky_posts' => true, 'update_post_meta_cache' => false, 'update_post_term_cache' => false, 'perm' => 'readable'));
		$total += (int) $query->found_posts;
		$revisions = self::latest_revisions($query->posts);
		foreach ($query->posts as $post) {
			if (count($items) >= $limit) break;
			$item = self::find_post($post, $revisions);
			if ($item && (!$items || $items[0]['id'] !== $item['id'])) $items[] = $item;
		}
		$taxonomies = get_taxonomies(array('show_ui' => true));
		if ($taxonomies && count($items) < $limit) {
			$terms = get_terms(array('taxonomy' => array_values($taxonomies), 'name__like' => $q, 'number' => $limit - count($items), 'hide_empty' => false, 'update_term_meta_cache' => false));
			foreach (is_array($terms) ? $terms : array() as $term) {
				$total++;
				$tax = get_taxonomy($term->taxonomy);
				$edit = current_user_can('edit_term', $term->term_id) ? self::site_path((string) get_edit_term_link($term, $term->taxonomy)) : null;
				$view = $tax && $tax->public ? self::site_path((string) get_term_link($term)) : null;
				$url = $view ? $view : $edit;
				if (!$url) continue;
				$item = array('id' => 'term:' . $term->taxonomy . ':' . $term->term_id, 'kind' => 'term', 'label' => $term->name, 'url' => $url, 'type' => $tax ? $tax->labels->singular_name : $term->taxonomy, 'tags' => array($term->taxonomy, $term->slug));
				$actions = array();
				if ($edit) {
					$item['edit'] = $edit;
					$actions[] = array('label' => 'Edit', 'url' => $edit);
				}
				if ($view) $actions[] = array('label' => 'View', 'url' => $view);
				if ($actions) $item['actions'] = $actions;
				$items[] = $item;
			}
		}
		if (current_user_can('list_users') && count($items) < $limit) {
			$users = new WP_User_Query(array('search' => '*' . $q . '*', 'search_columns' => array('user_login', 'user_nicename', 'display_name'), 'number' => $limit - count($items), 'count_total' => true, 'fields' => array('ID', 'display_name', 'user_login')));
			$total += (int) $users->get_total();
			foreach ($users->get_results() as $u) {
				$edit = current_user_can('edit_user', $u->ID) ? self::site_path((string) get_edit_user_link($u->ID)) : null;
				$view = self::site_path((string) get_author_posts_url($u->ID));
				$url = $edit ? $edit : $view;
				if (!$url) continue;
				$item = array('id' => 'user:' . $u->ID, 'kind' => 'user', 'label' => $u->display_name !== '' ? $u->display_name : $u->user_login, 'url' => $url, 'tags' => array($u->user_login));
				$actions = array();
				if ($edit) {
					$item['edit'] = $edit;
					$actions[] = array('label' => 'Edit', 'url' => $edit);
				}
				if ($view) $actions[] = array('label' => 'Posts', 'url' => $view);
				$item['actions'] = $actions;
				$items[] = $item;
			}
		}
		return array('items' => array_slice($items, 0, $limit), 'total' => $total);
	}

	/** A URL on this site as a same-origin path (with its query), or null for anywhere else. */
	private static function site_path(string $url): ?string {
		if ($url === '') return null;
		$parts = wp_parse_url($url);
		if (!is_array($parts)) return null;
		if (isset($parts['host'])) {
			$hosts = array(wp_parse_url(home_url(), PHP_URL_HOST), wp_parse_url(site_url(), PHP_URL_HOST), wp_parse_url(admin_url(), PHP_URL_HOST));
			if (!in_array($parts['host'], $hosts, true)) return null;
		}
		$path = isset($parts['path']) ? $parts['path'] : '/';
		if ($path === '' || $path[0] !== '/' || strpos($path, '//') === 0) return null;
		return $path . (isset($parts['query']) ? '?' . $parts['query'] : '');
	}

	private static function ms($gmt): ?int {
		if (!is_string($gmt) || $gmt === '' || strpos($gmt, '0000') === 0) return null;
		$t = strtotime($gmt . ' UTC');
		return $t ? $t * 1000 : null;
	}

	/* ── the live view's routes ──────────────────────────────────────────── */

	/** Runs at wp_loaded: post types, meta, blocks and settings are registered, and the user is known. */
	public static function route(): void {
		$path = self::request_path();
		if (!preg_match('#/_wanigan/(trace|edit|move|insert|undo|find)(?:/([A-Za-z0-9._-]+))?/?$#', $path, $m)) return;
		nocache_headers();
		$post = isset($_SERVER['REQUEST_METHOD']) && $_SERVER['REQUEST_METHOD'] === 'POST';
		$route = $m[1];
		$arg = isset($m[2]) ? $m[2] : '';
		try {
			if ($route === 'trace' && !$post) self::serve_trace($arg);
			if ($route === 'find' && !$post) self::find();
			if ($route === 'edit' && !$post && $arg === 'done') self::edit_done();
			if ($route === 'edit' && !$post) self::edit_form($arg);
			if (!$post) self::answer(array('ok' => false, 'error' => 'That route takes a POST.'), 405);
			$body = json_decode((string) file_get_contents('php://input', false, null, 0, 2 * 1024 * 1024), true);
			if (!is_array($body)) self::answer(array('ok' => false, 'error' => 'The request was not JSON.'), 400);
			if (!is_user_logged_in()) self::answer(array('ok' => false, 'error' => 'Log in to WordPress in the live view to change this.'), 403);
			if ($route === 'edit') self::edit_save($arg, $body);
			if ($route === 'move') self::move($body, false);
			if ($route === 'insert') self::move($body, true);
			if ($route === 'undo') self::undo($body);
		} catch (Throwable $e) {
			self::answer(array('ok' => false, 'error' => 'WordPress stopped with an error: ' . $e->getMessage()), 500);
		}
		self::answer(array('ok' => false, 'error' => 'No such route.'), 404);
	}

	private static function answer(array $data, int $status = 200): void {
		wp_send_json($data, $status);
	}

	private static function load(string $id): ?array {
		if (!preg_match('/^[0-9a-f]{16}$/', $id)) return null;
		$stored = get_transient('wanigan_live_t_' . get_current_user_id() . '_' . $id);
		return is_array($stored) ? $stored : null;
	}

	private static function serve_trace(string $id): void {
		$stored = self::load($id);
		if (!$stored) self::answer(array('ok' => false, 'error' => 'No such trace for this user: it is older than ten minutes, or another user’s.'), 404);
		self::answer($stored['trace']);
	}

	/** GET /_wanigan/edit/<id>?trace=<id>: the platform's own screen for a 'native-form' target. */
	private static function edit_form(string $target): void {
		$stored = self::load(isset($_GET['trace']) ? (string) $_GET['trace'] : '');
		$p = $stored && isset($stored['private']['edits'][$target]) ? $stored['private']['edits'][$target] : null;
		if (!$p || $p['type'] !== 'link') {
			status_header(404);
			die('That edit is not in this trace (older than ten minutes, or another user’s).');
		}
		$cap = $p['cap'];
		$can = is_array($cap) ? current_user_can($cap[0], $cap[1]) : current_user_can($cap);
		if (!$can) {
			status_header(403);
			die(is_user_logged_in() ? 'Your WordPress user cannot open this.' : 'Log in to WordPress in the live view first.');
		}
		wp_safe_redirect($p['url']);
		exit;
	}

	private static function edit_done(): void {
		status_header(200);
		header('Content-Type: text/html; charset=utf-8');
		echo '<!DOCTYPE html><meta charset="utf-8"><title>Saved</title><p>Saved.</p>';
		exit;
	}

	/** POST /_wanigan/edit/<id>: a 'schema' target, validated against the schema it gave, saved through core. */
	private static function edit_save(string $target, array $body): void {
		$stored = self::load(isset($body['trace']) ? (string) $body['trace'] : '');
		if (!$stored) self::answer(array('ok' => false, 'error' => 'That page was shown more than ten minutes ago (or to another user): reload it and try again.'), 409);
		$p = isset($stored['private']['edits'][$target]) ? $stored['private']['edits'][$target] : null;
		$public = null;
		foreach ($stored['trace']['edits'] as $e) if ($e['id'] === $target) $public = $e;
		if (!$p || !$public || $public['via'] !== 'schema') self::answer(array('ok' => false, 'error' => 'That is not something this page can change.'), 404);
		if (!empty($public['why'])) self::answer(array('ok' => false, 'error' => $public['why']), 403);
		$value = array_key_exists('value', $body) ? $body['value'] : null;
		$valid = rest_validate_value_from_schema($value, $public['schema'], 'value');
		if (is_wp_error($valid)) self::answer(array('ok' => false, 'error' => $valid->get_error_message()), 400);
		$value = rest_sanitize_value_from_schema($value, $public['schema'], 'value');
		switch ($p['type']) {
			case 'post':
				$result = self::save_post_field($p, $value);
				break;
			case 'option':
				$result = self::rest('POST', '/wp/v2/settings', array($p['field'] => $value));
				break;
			case 'menu-item':
				$params = array('title' => isset($value['title']) ? $value['title'] : '');
				if ($p['custom'] && isset($value['url'])) $params['url'] = $value['url'];
				$result = self::rest('POST', '/wp/v2/menu-items/' . (int) $p['item'], $params);
				break;
			case 'widget':
				$result = self::save_widget($p, (array) $value);
				break;
			case 'block':
				$result = self::save_block($p, (array) $value);
				break;
			case 'copy':
				$result = self::copy_template($p, (array) $value);
				break;
			default:
				$result = new WP_Error('wanigan', 'Wanigan does not know how to save that.');
		}
		if (is_wp_error($result)) self::answer(array('ok' => false, 'error' => $result->get_error_message()), 409);
		wanigan_live_changed();
		$out = array('ok' => true);
		if (is_array($result) && isset($result['revision'])) $out['revision'] = (string) $result['revision'];
		self::answer($out);
	}

	/** A post field through the post's REST route: class-wp-rest-posts-controller.php update_item() as the editor saves. */
	private static function save_post_field(array $p, $value) {
		$post = get_post($p['post']);
		if (!$post) return new WP_Error('wanigan', 'That post is gone.');
		$type = get_post_type_object($post->post_type);
		$noun = $type ? strtolower($type->labels->singular_name) : 'post';
		$why = self::post_why($post, $noun);
		if ($why) return new WP_Error('wanigan', $why);
		$before = self::latest_revision($post->ID);
		if ($p['field'] === 'meta') {
			$result = self::rest('POST', $p['route'], array('meta' => array($p['key'] => $value)));
		} else {
			$result = self::rest('POST', $p['route'], array($p['field'] => $value));
		}
		if (is_wp_error($result)) return $result;
		$after = self::latest_revision($post->ID);
		return $after && $after !== $before ? array('revision' => $after) : array();
	}

	private static function latest_revision(int $pid): ?int {
		$r = wp_get_post_revisions($pid, array('posts_per_page' => 1, 'fields' => 'ids'));
		return $r ? (int) reset($r) : null;
	}

	private static function save_widget(array $p, array $value) {
		global $wp_registered_widgets;
		$wid = $p['widget'];
		$widget = isset($wp_registered_widgets[$wid]['callback'][0]) ? $wp_registered_widgets[$wid]['callback'][0] : null;
		$parsed = wp_parse_widget_id($wid);
		if (!$widget instanceof WP_Widget || !isset($parsed['number'])) return new WP_Error('wanigan', 'That widget is gone.');
		$settings = $widget->get_settings();
		$instance = isset($settings[$parsed['number']]) ? (array) $settings[$parsed['number']] : array();
		return self::rest('POST', '/wp/v2/widgets/' . $wid, array('instance' => array('raw' => array_merge($instance, $value))));
	}

	/**
	 * A block's attributes or sourced text, written into the stored tree it was rendered from and saved through the
	 * store's REST route; refused when the stored content changed since the trace.
	 */
	private static function save_block(array $p, array $value) {
		$info = self::fresh_store($p['store']);
		if (is_wp_error($info)) return $info;
		if (md5($info['content']) !== $p['hash']) return new WP_Error('wanigan', 'This ' . $info['noun'] . ' changed since the page was shown: reload it and try again.');
		$blocks = parse_blocks($info['content']);
		if (serialize_blocks($blocks) !== $info['content']) return new WP_Error('wanigan', 'Writing this ' . $info['noun'] . '’s blocks back would change other parts of it, so Wanigan does not save it.');
		$node = self::node_in($blocks, $p['path']);
		if (!$node || md5(serialize_block($node)) !== $p['fp']) return new WP_Error('wanigan', 'That block is not where it was: reload the page and try again.');
		$type = WP_Block_Type_Registry::get_instance()->get_registered($p['name']);
		if (!$type) return new WP_Error('wanigan', 'That block type is no longer registered.');
		foreach ($value as $attr => $v) {
			$def = isset($type->attributes[$attr]) ? $type->attributes[$attr] : null;
			if (!is_array($def)) return new WP_Error('wanigan', 'The block has no setting called ' . $attr . '.');
			$source = isset($def['source']) ? $def['source'] : null;
			if ($source === null) {
				if (array_key_exists('default', $def) && $def['default'] === $v) unset($node['attrs'][$attr]);
				else $node['attrs'][$attr] = $v;
				continue;
			}
			$html = (string) $node['innerHTML'];
			$el = self::find_element($html, (string) $def['selector']);
			if (!$el) return new WP_Error('wanigan', 'The element for ' . $attr . ' is not in the block any more.');
			if ($source === 'attribute') {
				$el->set_attribute((string) $def['attribute'], (string) $v);
			} else {
				$tag = $el->get_tag();
				if (!$el->next_token() || $el->get_token_name() !== '#text') return new WP_Error('wanigan', 'The text of ' . $attr . ' has formatting now; change it in the editor.');
				$el->set_modifiable_text((string) $v);
			}
			$html = $el->get_updated_html();
			$node['innerHTML'] = $html;
			$node['innerContent'] = array($html);
		}
		$blocks = self::replace_node($blocks, $p['path'], $node);
		return self::save_store($p['store'], $info, serialize_blocks($blocks));
	}

	private static function replace_node(array $blocks, array $path, array $node): array {
		$i = array_shift($path);
		if (!$path) {
			$blocks[$i] = $node;
			return $blocks;
		}
		$blocks[$i]['innerBlocks'] = self::replace_node($blocks[$i]['innerBlocks'], $path, $node);
		return $blocks;
	}

	/** The store as it is now (not as the trace saw it), with why it cannot be changed, as an error. */
	private static function fresh_store(string $store) {
		$info = null;
		if (preg_match('/^post:(\d+)$/', $store, $m)) {
			$post = get_post((int) $m[1]);
			if (!$post) return new WP_Error('wanigan', 'That post is gone.');
			$type = get_post_type_object($post->post_type);
			$noun = $type ? strtolower($type->labels->singular_name) : 'post';
			$why = self::post_why($post, $noun);
			if ($why) return new WP_Error('wanigan', $why);
			$info = array('content' => get_post_field('post_content', $post->ID, 'raw'), 'route' => rest_get_route_for_post($post), 'post' => $post->ID, 'noun' => $noun);
		} elseif (preg_match('/^(tp|tpl):(.+)$/', $store, $m)) {
			if (!current_user_can('edit_theme_options')) return new WP_Error('wanigan', 'Your WordPress user cannot change templates (edit_theme_options).');
			$tpl = get_block_template($m[2], $m[1] === 'tp' ? 'wp_template_part' : 'wp_template');
			if (!$tpl) return new WP_Error('wanigan', 'That template is gone.');
			if ($tpl->wp_id && ($why = self::lock((int) $tpl->wp_id, 'template'))) return new WP_Error('wanigan', $why);
			$info = array('content' => (string) $tpl->content, 'route' => '/wp/v2/' . ($m[1] === 'tp' ? 'template-parts' : 'templates') . '/' . $tpl->id, 'post' => $tpl->wp_id ? (int) $tpl->wp_id : null, 'noun' => $m[1] === 'tp' ? 'template part' : 'template');
		}
		if (!$info || $info['route'] === '') return new WP_Error('wanigan', 'WordPress has no REST route to save that.');
		return $info;
	}

	private static function save_store(string $store, array $info, string $content) {
		$before = $info['post'] ? self::latest_revision($info['post']) : null;
		$result = self::rest('POST', $info['route'], array('content' => $content));
		if (is_wp_error($result)) return $result;
		$out = array('content' => $content);
		$post = $info['post'];
		if (!$post && is_array($result) && isset($result['wp_id'])) $post = (int) $result['wp_id'];
		$after = $post ? self::latest_revision($post) : null;
		if ($after && $after !== $before) $out['revision'] = $after;
		return $out;
	}

	/** Copy a template into the active theme (template-override). */
	private static function copy_template(array $p, array $value) {
		if (!isset($value['to']) || $value['to'] !== $p['shown']) return new WP_Error('wanigan', 'Say exactly where to copy it: ' . $p['shown'] . '.');
		if (!current_user_can('edit_themes')) return new WP_Error('wanigan', 'Your WordPress user cannot edit theme files (edit_themes).');
		if (file_exists($p['to'])) return new WP_Error('wanigan', $p['shown'] . ' already exists. Nothing was changed.');
		if (!is_file($p['from'])) return new WP_Error('wanigan', 'The template to copy is gone.');
		if (!wp_mkdir_p(dirname($p['to'])) || !copy($p['from'], $p['to'])) return new WP_Error('wanigan', 'WordPress could not write ' . $p['shown'] . '.');
		return array();
	}

	/** wp-includes/rest-api.php rest_do_request(): a REST request inside this one, as the logged-in user. */
	private static function rest(string $method, string $route, array $params) {
		$request = new WP_REST_Request($method, $route);
		$request->set_body_params($params);
		$response = rest_do_request($request);
		if ($response->is_error()) {
			$error = $response->as_error();
			return new WP_Error('wanigan', $error->get_error_message());
		}
		return $response->get_data();
	}

	/* moving and inserting */

	/**
	 * POST /_wanigan/move and /_wanigan/insert: one item of a collection moved (to another index, or into a
	 * collection in its movesTo), or a palette entry inserted, through the API that stores that collection.
	 */
	private static function move(array $body, bool $insert): void {
		$stored = self::load(isset($body['trace']) ? (string) $body['trace'] : '');
		if (!$stored) self::answer(array('ok' => false, 'error' => 'That page was shown more than ten minutes ago (or to another user): reload it and try again.'), 409);
		$cid = isset($body['collection']) ? (string) $body['collection'] : '';
		$c = self::collection($stored, $cid);
		if (!$c) self::answer(array('ok' => false, 'error' => 'That is not a collection on this page.'), 404);
		if (!empty($c['public']['why'])) self::answer(array('ok' => false, 'error' => $c['public']['why']), 403);
		if ($insert) {
			$entry = isset($body['entry']) ? (string) $body['entry'] : '';
			if (!in_array($entry, isset($c['public']['inserts']) ? $c['public']['inserts'] : array(), true)) self::answer(array('ok' => false, 'error' => 'That cannot be inserted there.'), 400);
			$to = $c;
			$index = isset($body['index']) ? (int) $body['index'] : count($c['public']['items']);
			$item = null;
		} else {
			$item = isset($body['item']) ? (string) $body['item'] : '';
			if (!in_array($item, $c['public']['items'], true)) self::answer(array('ok' => false, 'error' => 'That item is not in the collection.'), 400);
			$dest = isset($body['to']['collection']) ? (string) $body['to']['collection'] : $cid;
			if ($dest !== $cid && !in_array($dest, isset($c['public']['movesTo']) ? $c['public']['movesTo'] : array(), true)) self::answer(array('ok' => false, 'error' => 'It cannot move there.'), 400);
			$to = $dest === $cid ? $c : self::collection($stored, $dest);
			if (!$to) self::answer(array('ok' => false, 'error' => 'That is not a collection on this page.'), 404);
			$index = isset($body['to']['index']) ? (int) $body['to']['index'] : 0;
			$entry = null;
		}
		$index = max(0, $index);
		switch ($c['private']['type']) {
			case 'blocks':
				$result = self::move_blocks($c, $to, $item, $entry, $index);
				break;
			case 'widgets':
				$result = $insert ? new WP_Error('wanigan', 'Add widgets in Appearance › Widgets.') : self::move_widget($c, $to, $item, $index);
				break;
			case 'menu':
				$result = self::move_menu($c, $to, $item, $entry, $index, $stored);
				break;
			default:
				$result = new WP_Error('wanigan', 'Wanigan cannot move that.');
		}
		if (is_wp_error($result)) {
			$data = $result->get_error_data();
			$out = array('ok' => false, 'error' => $result->get_error_message());
			if (is_array($data) && isset($data['items'])) {
				$out['items'] = $data['items'];
				self::answer($out, 409);
			}
			self::answer($out, 409);
		}
		wanigan_live_changed();
		$token = bin2hex(random_bytes(12));
		set_transient('wanigan_live_u_' . get_current_user_id() . '_' . $token, $result['undo'], self::TTL);
		$out = array('ok' => true, 'undo' => $token);
		if (isset($result['revision'])) $out['revision'] = (string) $result['revision'];
		self::answer($out);
	}

	private static function collection(array $stored, string $id): ?array {
		foreach (isset($stored['trace']['collections']) ? $stored['trace']['collections'] : array() as $c) {
			if ($c['id'] === $id && isset($stored['private']['collections'][$id])) return array('public' => $c, 'private' => $stored['private']['collections'][$id]);
		}
		return null;
	}

	/**
	 * Blocks moved inside one stored tree (a post, template or template part), or a pattern or dynamic block
	 * inserted. A container's inner blocks sit at null placeholders in its innerContent (blocks.php
	 * serialize_block() walks innerContent, taking the next inner block at each null), so a block moving in or out
	 * of a container moves a placeholder too.
	 */
	private static function move_blocks(array $from, array $to, ?string $item, ?string $entry, int $index) {
		$fp = $from['private'];
		$tp = $to['private'];
		if ($fp['store'] !== $tp['store']) return new WP_Error('wanigan', 'Blocks move only within one post or template.');
		$info = self::fresh_store($fp['store']);
		if (is_wp_error($info)) return $info;
		if (md5($info['content']) !== $fp['hash']) {
			return new WP_Error('wanigan', 'This ' . $info['noun'] . ' changed since the page was shown.', array('items' => self::current_items($info['content'], $fp)));
		}
		$blocks = parse_blocks($info['content']);
		if (serialize_blocks($blocks) !== $info['content']) return new WP_Error('wanigan', 'Writing this ' . $info['noun'] . '’s blocks back would change other parts of it, so Wanigan does not save it.');
		$target_items = $tp['paths'];
		$anchor = null;
		$keys = array_keys($target_items);
		if ($item !== null) $keys = array_values(array_diff($keys, array($item)));
		if ($index < count($keys)) $anchor = $target_items[$keys[$index]];
		if ($item !== null) {
			$path = $fp['paths'][$item];
			$node = self::node_in($blocks, $path);
			if (!$node || md5(serialize_block($node)) !== $fp['fps'][$item]) return new WP_Error('wanigan', 'That block is not where it was.', array('items' => self::current_items($info['content'], $fp)));
			$check = self::may_hold($blocks, $tp['parent'], $node['blockName']);
			if (is_wp_error($check)) return $check;
			$blocks = self::remove_at($blocks, $path);
			// Paths after the removed block in the same list shift down by one.
			if ($anchor !== null) $anchor = self::shift_after($anchor, $path);
			$parent = self::shift_after($tp['parent'], $path);
			$new = array($node);
		} else {
			$parent = $tp['parent'];
			$new = self::entry_blocks((string) $entry);
			if (is_wp_error($new)) return $new;
			foreach ($new as $n) {
				$check = self::may_hold($blocks, $parent, $n['blockName']);
				if (is_wp_error($check)) return $check;
			}
		}
		$at = $anchor !== null ? end($anchor) : null;
		$blocks = self::insert_at($blocks, $parent, $at, $new);
		if (is_wp_error($blocks)) return $blocks;
		$content = serialize_blocks($blocks);
		$saved = self::save_store($fp['store'], $info, $content);
		if (is_wp_error($saved)) return $saved;
		// A theme's template or part saved for the first time became the Site Editor's database copy; undoing that is
		// deleting the copy (what the Site Editor's Reset does), which brings the theme's file back.
		$undo = array('type' => 'blocks', 'store' => $fp['store'], 'before' => $info['content'], 'after' => md5($content), 'reset' => $info['post'] === null && strpos($fp['store'], 'post:') !== 0);
		$out = array('undo' => $undo);
		if (isset($saved['revision'])) $out['revision'] = $saved['revision'];
		return $out;
	}

	/**
	 * The current order of a block list, as the trace's part ids where a block is still the same. A container may
	 * have moved: then it is the block of the same type holding most of the list's blocks.
	 */
	private static function current_items(string $content, array $private): array {
		$blocks = parse_blocks($content);
		$by_fp = array();
		foreach ($private['fps'] as $part => $fp) $by_fp[$fp][] = $part;
		$list = $blocks;
		if ($private['parent']) {
			$best = -1;
			$walk = function ($nodes) use (&$walk, &$best, &$list, $by_fp, $private) {
				foreach ($nodes as $n) {
					if (!empty($n['blockName']) && $n['blockName'] === $private['holder']) {
						$hits = 0;
						foreach ($n['innerBlocks'] as $b) if (isset($by_fp[md5(serialize_block($b))])) $hits++;
						if ($hits > $best) {
							$best = $hits;
							$list = $n['innerBlocks'];
						}
					}
					if (!empty($n['innerBlocks'])) $walk($n['innerBlocks']);
				}
			};
			$list = array();
			$walk($blocks);
		}
		$out = array();
		foreach ($list as $b) {
			if (empty($b['blockName'])) continue;
			$fp = md5(serialize_block($b));
			if (!empty($by_fp[$fp])) $out[] = array_shift($by_fp[$fp]);
		}
		return $out;
	}

	/** class-wp-block-type.php $parent / $ancestor / $allowed_blocks: where a block may go. */
	private static function may_hold(array $blocks, array $parent_path, ?string $name) {
		if ($name === null) return true;
		$type = WP_Block_Type_Registry::get_instance()->get_registered($name);
		$holder = $parent_path ? self::node_in($blocks, $parent_path) : null;
		$holder_name = $holder ? $holder['blockName'] : null;
		if ($type && !empty($type->parent) && !in_array($holder_name, (array) $type->parent, true)) return new WP_Error('wanigan', self::block_label($name) . ' may only sit directly inside ' . implode(' or ', (array) $type->parent) . '.');
		if ($holder_name) {
			$ht = WP_Block_Type_Registry::get_instance()->get_registered($holder_name);
			if ($ht && isset($ht->allowed_blocks) && is_array($ht->allowed_blocks) && $ht->allowed_blocks && !in_array($name, $ht->allowed_blocks, true)) return new WP_Error('wanigan', self::block_label($holder_name) . ' does not take ' . self::block_label($name) . ' blocks.');
		}
		return true;
	}

	private static function shift_after(array $path, array $removed): array {
		$depth = count($removed) - 1;
		if (count($path) > $depth && array_slice($path, 0, $depth) === array_slice($removed, 0, $depth) && $path[$depth] > $removed[$depth]) $path[$depth]--;
		return $path;
	}

	private static function separator(): array {
		return array('blockName' => null, 'attrs' => array(), 'innerBlocks' => array(), 'innerHTML' => "\n\n", 'innerContent' => array("\n\n"));
	}

	private static function is_space(array $b): bool {
		return $b['blockName'] === null && trim((string) $b['innerHTML']) === '';
	}

	/** Remove the block at a path, with one whitespace neighbour (a separator between top-level blocks, or between placeholders). */
	private static function remove_at(array $blocks, array $path): array {
		$i = array_pop($path);
		if (!$path) {
			array_splice($blocks, $i, 1);
			if (isset($blocks[$i]) && self::is_space($blocks[$i])) array_splice($blocks, $i, 1);
			elseif ($i > 0 && isset($blocks[$i - 1]) && self::is_space($blocks[$i - 1])) array_splice($blocks, $i - 1, 1);
			return $blocks;
		}
		$holder = self::node_in($blocks, $path);
		array_splice($holder['innerBlocks'], $i, 1);
		$n = -1;
		foreach ($holder['innerContent'] as $k => $chunk) {
			if ($chunk === null && ++$n === $i) {
				array_splice($holder['innerContent'], $k, 1);
				// The whitespace that separated it from the next placeholder, or else from the previous one.
				$c = $holder['innerContent'];
				$space = function ($x) { return is_string($x) && trim($x) === ''; };
				if (isset($c[$k], $c[$k + 1]) && $space($c[$k]) && $c[$k + 1] === null) array_splice($holder['innerContent'], $k, 1);
				elseif ($k >= 2 && $space($c[$k - 1]) && $c[$k - 2] === null) array_splice($holder['innerContent'], $k - 1, 1);
				break;
			}
		}
		return self::replace_node($blocks, $path, $holder);
	}

	/** Insert blocks into a list before the block at index $at (null: at the end). */
	private static function insert_at(array $blocks, array $parent, ?int $at, array $new) {
		if (!$parent) {
			$chunk = array();
			foreach ($new as $n) {
				$chunk[] = $n;
				$chunk[] = self::separator();
			}
			if ($at === null) {
				if ($blocks && !self::is_space(end($blocks))) array_unshift($chunk, self::separator());
				array_pop($chunk);
				return array_merge($blocks, $chunk);
			}
			array_splice($blocks, $at, 0, $chunk);
			return $blocks;
		}
		$holder = self::node_in($blocks, $parent);
		if (!$holder) return new WP_Error('wanigan', 'The block to put it in is gone.');
		$nulls = array_keys(array_filter($holder['innerContent'], function ($c) { return $c === null; }));
		if (!$nulls) return new WP_Error('wanigan', 'That block is empty, so WordPress has no place in its markup to put a block yet. Add one in the editor first.');
		$at = $at === null ? count($holder['innerBlocks']) : $at;
		array_splice($holder['innerBlocks'], $at, 0, $new);
		$placeholders = array();
		foreach ($new as $n) {
			$placeholders[] = null;
			$placeholders[] = "\n\n";
		}
		if ($at < count($nulls)) {
			array_splice($holder['innerContent'], $nulls[$at], 0, $placeholders);
		} else {
			array_pop($placeholders);
			array_unshift($placeholders, "\n\n");
			array_splice($holder['innerContent'], end($nulls) + 1, 0, $placeholders);
		}
		return self::replace_node($blocks, $parent, $holder);
	}

	/**
	 * A palette entry as blocks: a registered pattern's content (class-wp-block-patterns-registry.php
	 * get_registered(), saved markup the editor accepts as it is), or a dynamic block's void delimiter.
	 */
	private static function entry_blocks(string $entry) {
		if (strpos($entry, 'pattern:') === 0) {
			$pattern = WP_Block_Patterns_Registry::get_instance()->get_registered(substr($entry, 8));
			if (!$pattern) return new WP_Error('wanigan', 'That pattern is not registered any more.');
			$blocks = array_values(array_filter(parse_blocks($pattern['content']), function ($b) { return !empty($b['blockName']); }));
			return $blocks ? $blocks : new WP_Error('wanigan', 'That pattern has no blocks.');
		}
		if (strpos($entry, 'block:') === 0) {
			$type = WP_Block_Type_Registry::get_instance()->get_registered(substr($entry, 6));
			if (!$type || !$type->is_dynamic()) return new WP_Error('wanigan', 'That block type cannot be inserted from here.');
			return array(array('blockName' => $type->name, 'attrs' => array(), 'innerBlocks' => array(), 'innerHTML' => '', 'innerContent' => array()));
		}
		return new WP_Error('wanigan', 'That cannot be inserted there.');
	}

	/** widgets.php wp_set_sidebars_widgets(): a widget's place among the widget areas. */
	private static function move_widget(array $from, array $to, string $item, int $index) {
		if (!current_user_can('edit_theme_options')) return new WP_Error('wanigan', 'Your WordPress user cannot change widgets (edit_theme_options).');
		$all = wp_get_sidebars_widgets();
		$fs = $from['private']['sidebar'];
		$ts = $to['private']['sidebar'];
		$now = isset($all[$fs]) ? array_values((array) $all[$fs]) : array();
		if ($now !== $from['private']['state'] || ($ts !== $fs && (isset($all[$ts]) ? array_values((array) $all[$ts]) : array()) !== $to['private']['state'])) {
			$items = array();
			$by = array_flip($from['private']['widgets']);
			foreach ($now as $w) if (isset($by[$w])) $items[] = $by[$w];
			return new WP_Error('wanigan', 'The widgets here changed since the page was shown.', array('items' => $items));
		}
		$wid = $from['private']['widgets'][$item];
		$before = array($fs => $now);
		$before[$ts] = isset($all[$ts]) ? array_values((array) $all[$ts]) : array();
		$all[$fs] = array_values(array_diff($now, array($wid)));
		$list = $ts === $fs ? $all[$fs] : $before[$ts];
		// The index counts the items the page shows; place it before the shown item at that index.
		$shown = array_values(array_diff(array_values($to['private']['widgets']), array($wid)));
		$pos = $index < count($shown) ? array_search($shown[$index], $list, true) : false;
		array_splice($list, $pos === false ? count($list) : $pos, 0, array($wid));
		$all[$ts] = $list;
		wp_set_sidebars_widgets($all);
		$after = array($fs => $all[$fs], $ts => $all[$ts]);
		return array('undo' => array('type' => 'widgets', 'before' => $before, 'after' => $after));
	}

	/**
	 * Menu links reordered (or moved under another link of the same menu, or a link to this page added) through
	 * /wp/v2/menu-items: menu_order is one sequence over the whole menu, depth first, so the menu is renumbered.
	 */
	private static function move_menu(array $from, array $to, ?string $item, ?string $entry, int $index, array $stored) {
		if (!current_user_can('edit_theme_options')) return new WP_Error('wanigan', 'Your WordPress user cannot change menus (edit_theme_options).');
		$menu = $from['private']['menu'];
		if ($to['private']['menu'] !== $menu) return new WP_Error('wanigan', 'Links move only within one menu.');
		$state = self::menu_state($menu);
		if ($state !== $from['private']['state']) {
			$items = array();
			$by = array_flip($from['private']['items']);
			$order = $state;
			uasort($order, function ($a, $b) { return $a[1] - $b[1]; });
			foreach ($order as $iid => $s) if ($s[0] === $from['private']['parent'] && isset($by[$iid])) $items[] = $by[$iid];
			return new WP_Error('wanigan', 'This menu changed since the page was shown.', array('items' => $items));
		}
		$parent = $to['private']['parent'];
		$created = null;
		if ($item !== null) {
			$moving = (int) $from['private']['items'][$item];
		} else {
			$this_page = $to['private']['this'];
			if ($entry !== 'menu-link:this' || !$this_page || !get_post($this_page[1])) return new WP_Error('wanigan', 'That cannot be inserted there.');
			$made = self::rest('POST', '/wp/v2/menu-items', array('menus' => $menu, 'type' => 'post_type', 'object' => $this_page[0], 'object_id' => (int) $this_page[1], 'parent' => $parent, 'status' => 'publish', 'menu_order' => count($state) + 1));
			if (is_wp_error($made)) return $made;
			$moving = (int) $made['id'];
			$created = $moving;
			$state[$moving] = array($parent, count($state) + 1);
		}
		$children = array();
		uasort($state, function ($a, $b) { return $a[1] - $b[1]; });
		foreach ($state as $iid => $s) if ($iid !== $moving) $children[$s[0]][] = $iid;
		$shown = array_values(array_diff(array_map('intval', array_values($to['private']['items'])), array($moving)));
		$siblings = isset($children[$parent]) ? $children[$parent] : array();
		$pos = $index < count($shown) ? array_search($shown[$index], $siblings, true) : false;
		array_splice($siblings, $pos === false ? count($siblings) : $pos, 0, array($moving));
		$children[$parent] = $siblings;
		$order = array();
		$walk = function ($p) use (&$walk, &$order, $children) {
			foreach (isset($children[$p]) ? $children[$p] : array() as $iid) {
				$order[] = $iid;
				$walk($iid);
			}
		};
		$walk(0);
		$before = self::menu_state($menu);
		$after = array();
		foreach ($order as $n => $iid) {
			$p = $iid === $moving ? $parent : $state[$iid][0];
			$after[$iid] = array($p, $n + 1);
			if (!isset($before[$iid]) || $before[$iid] !== $after[$iid]) {
				$r = self::rest('POST', '/wp/v2/menu-items/' . $iid, array('menu_order' => $n + 1, 'parent' => $p));
				if (is_wp_error($r)) return $r;
			}
		}
		if ($created) unset($before[$created]);
		return array('undo' => array('type' => 'menu', 'menu' => $menu, 'before' => $before, 'after' => self::menu_state($menu), 'created' => $created));
	}

	/** POST /_wanigan/undo: put a move or insert back, only while nothing else has changed it since. */
	private static function undo(array $body): void {
		$token = isset($body['undo']) ? (string) $body['undo'] : '';
		$key = 'wanigan_live_u_' . get_current_user_id() . '_' . (preg_match('/^[0-9a-f]{24}$/', $token) ? $token : 'x');
		$u = get_transient($key);
		if (!is_array($u)) self::answer(array('ok' => false, 'error' => 'That can no longer be undone here (it is older than ten minutes).'), 409);
		$result = null;
		if ($u['type'] === 'blocks') {
			$info = self::fresh_store($u['store']);
			if (is_wp_error($info)) $result = $info;
			elseif (md5($info['content']) !== $u['after']) $result = new WP_Error('wanigan', 'It changed again since, so putting it back could undo other work.');
			elseif (!empty($u['reset'])) $result = self::rest('DELETE', $info['route'], array('force' => true));
			else $result = self::save_store($u['store'], $info, $u['before']);
		} elseif ($u['type'] === 'widgets') {
			$all = wp_get_sidebars_widgets();
			foreach ($u['after'] as $sidebar => $list) {
				if ((isset($all[$sidebar]) ? array_values((array) $all[$sidebar]) : array()) !== $list) $result = new WP_Error('wanigan', 'The widgets changed again since, so putting them back could undo other work.');
			}
			if (!$result) {
				foreach ($u['before'] as $sidebar => $list) $all[$sidebar] = $list;
				wp_set_sidebars_widgets($all);
				$result = array();
			}
		} elseif ($u['type'] === 'menu') {
			if (self::menu_state($u['menu']) !== $u['after']) $result = new WP_Error('wanigan', 'The menu changed again since, so putting it back could undo other work.');
			else {
				if ($u['created']) {
					$r = self::rest('DELETE', '/wp/v2/menu-items/' . (int) $u['created'], array('force' => true));
					if (is_wp_error($r)) $result = $r;
				}
				if (!$result) {
					foreach ($u['before'] as $iid => $s) {
						$r = self::rest('POST', '/wp/v2/menu-items/' . $iid, array('menu_order' => $s[1], 'parent' => $s[0]));
						if (is_wp_error($r)) {
							$result = $r;
							break;
						}
					}
				}
				if (!$result) $result = array();
			}
		}
		if (is_wp_error($result)) self::answer(array('ok' => false, 'error' => $result->get_error_message()), 409);
		delete_transient($key);
		wanigan_live_changed();
		$out = array('ok' => true);
		if (is_array($result) && isset($result['revision'])) $out['revision'] = (string) $result['revision'];
		self::answer($out);
	}
}

if (wanigan_live_on()) {
	Wanigan_Live::boot();

	// Version 1's marks, which the live view's page script still reads: template files bracketed, each block's
	// name on its outermost element, each post's content bracketed as the post it is.
	$GLOBALS['wanigan_live_page'] = null;
	add_filter('template_include', function ($template) {
		$GLOBALS['wanigan_live_page'] = is_string($template) ? wanigan_live_path($template) : null;
		return $template;
	}, PHP_INT_MAX);
	add_action('get_header', function () { $GLOBALS['wanigan_live_header'] = 'next'; });
	add_action('wp_before_load_template', function ($file) {
		if (($GLOBALS['wanigan_live_header'] ?? null) === 'next') $GLOBALS['wanigan_live_header'] = (string) $file;
		echo wanigan_live_mark('begin', 'file', wanigan_live_path((string) $file));
	}, 10, 1);
	add_action('wp_after_load_template', function ($file) {
		echo wanigan_live_mark('end', 'file', wanigan_live_path((string) $file));
		if (($GLOBALS['wanigan_live_header'] ?? null) === (string) $file && $GLOBALS['wanigan_live_page']) {
			$GLOBALS['wanigan_live_header'] = null;
			$GLOBALS['wanigan_live_open'] = $GLOBALS['wanigan_live_page'];
			echo wanigan_live_mark('begin', 'file', $GLOBALS['wanigan_live_page']);
		}
	}, 10, 1);
	add_action('get_footer', function () {
		if (!empty($GLOBALS['wanigan_live_open'])) {
			echo wanigan_live_mark('end', 'file', $GLOBALS['wanigan_live_open']);
			$GLOBALS['wanigan_live_open'] = null;
		}
	});
	add_filter('render_block', function ($content, $block) {
		if (empty($block['blockName']) || !is_string($content) || $content === '' || !class_exists('WP_HTML_Tag_Processor')) return $content;
		$name = $block['blockName'];
		if ($name === 'core/template-part' && !empty($block['attrs']['slug'])) $name .= ':' . $block['attrs']['slug'];
		$tags = new WP_HTML_Tag_Processor($content);
		if ($tags->next_tag()) {
			$tags->set_attribute('data-wl-block', $name);
			return $tags->get_updated_html();
		}
		return $content;
	}, PHP_INT_MAX, 2);
	add_filter('the_content', function ($content) {
		if (!in_the_loop()) return $content;
		$post = get_post();
		if (!$post) return $content;
		$id = "post:{$post->post_type}:{$post->ID}:full";
		return wanigan_live_mark('begin', 'entity', $id) . $content . wanigan_live_mark('end', 'entity', $id);
	}, PHP_INT_MAX - 1);

	// The live view's own routes: what changed (polled every two seconds while a turn runs), and one post alone.
	add_action('init', function () {
		$path = (string) wp_parse_url($_SERVER['REQUEST_URI'] ?? '', PHP_URL_PATH);
		if (!preg_match('#/_wanigan/(changed|save)$#', $path, $m)) return;
		nocache_headers();
		if ($m[1] === 'changed') wp_send_json(array('changed' => (int) get_option('wanigan_live_changes', 0)));
		wp_send_json(array('ok' => false, 'error' => 'This WordPress helper saves through /_wanigan/edit: reload the live view.'), 409);
	}, 0);
	add_action('template_redirect', function () {
		$path = (string) wp_parse_url($_SERVER['REQUEST_URI'] ?? '', PHP_URL_PATH);
		if (!preg_match('#/_wanigan/piece/entity/post/(\d+)/?$#', $path, $m)) return;
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
		echo wanigan_live_mark('begin', 'entity', $id);
		the_content();
		echo wanigan_live_mark('end', 'entity', $id);
		echo '</main>';
		wp_footer();
		echo '</body></html>';
		exit;
	}, 0);
}
`;
