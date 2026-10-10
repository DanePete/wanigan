// The WordPress helper's "where it is used" (GET /_wanigan/usage?entry=…,
// helper version 4): every place the site's stored data says a library entry
// is used, through core's own APIs only, read-only. PHP source, appended to
// the must-use plugin (src/core/live-helper-wordpress.ts), so PHP 7.4 syntax
// like the rest of it. Contract: src/shared/live-library.ts EntryUsage. Why
// each step is core's way, with core file:line:
// docs/research/2026-10-09-core-limits.md, "WordPress where-used is a search,
// closed over references".

export const WORDPRESS_USAGE_SOURCE = String.raw`
/**
 * Where a library entry is used across the site, as stored data says (Wanigan's src/shared/live-library.ts
 * EntryUsage). Core keeps no usage index (has_block() tests one string and follows no reference), so it is a
 * search, and it reads only: a LIKE on stored block markup (posts of every public type, wp_template,
 * wp_template_part, wp_block, wp_navigation), each hit confirmed block by block with WP_Block_Processor
 * (class-wp-block-processor.php, 6.9; parse_blocks() before it), which also gives each use's path as the trace
 * names blocks; the theme's template and part files (get_block_templates()); registered patterns' content
 * (WP_Block_Patterns_Registry); block widgets (widget_block). Then closed over the references core does not
 * follow: what holds a use (a synced pattern, a pattern, a template part, a navigation menu) is searched for in turn,
 * so a block in synced pattern 12 is found wherever core/block {"ref":12} is.
 */
final class Wanigan_Live_Usage {
	const VERSION = 1;
	const MAX_PLACES = 500;
	const MAX_CANDIDATES = 2000;
	const MAX_SECONDS = 10.0;
	const MAX_REFERENCES = 200;
	const MAX_HITS = 200;
	const MAX_PATHS = 20;
	const STATUSES = array('publish', 'future', 'draft', 'pending', 'private');
	const ENTRY = '/^(block|pattern|style):[A-Za-z0-9_.:\/-]{1,250}$/';
	const KINDS = array('wp_template' => 'template', 'wp_template_part' => 'template-part', 'wp_block' => 'synced-pattern', 'wp_navigation' => 'navigation');

	private $entry;
	private $started;
	private $seconds;
	private $until;
	private $late = false;
	private $places = array();
	private $found = 0;
	private $gaps = array();
	private $searched = array();
	private $unseen = array();
	/** @var array|null The theme's template and part files no saved copy replaces, read once. */
	private $files = null;
	/** @var array|null Registered patterns, read once. */
	private $patterns = null;
	/** @var array|null Block widgets with where each is, read once. */
	private $widgets = null;
	/** @var array<string,bool> What has been searched for, by key: each reference is followed once. */
	private $done = array();
	/** @var array[] What is still to be searched for: [target, the place it is reached through]. */
	private $queue = array();

	private function __construct(string $entry, float $seconds) {
		$this->entry = $entry;
		$this->started = microtime(true);
		$this->seconds = $seconds;
		$this->until = $this->started + $seconds;
	}

	/** GET /_wanigan/usage?entry=…: the answer and its status. */
	public static function request(string $entry): array {
		if (!preg_match(self::ENTRY, $entry)) return array(array('ok' => false, 'error' => 'Which entry? Pass its id from the library: block:…, pattern:… or style:….'), 400);
		$usage = self::of($entry);
		if ($usage === null) return array(array('ok' => false, 'error' => 'This site’s library has no entry ' . $entry . ' now: ask the library again.'), 422);
		return array($usage, 200);
	}

	/** Where an entry is used; null when the site's registries have no such entry. */
	public static function of(string $entry, float $seconds = self::MAX_SECONDS): ?array {
		if (!preg_match(self::ENTRY, $entry)) return null;
		$target = self::target_of($entry);
		if ($target === null) return null;
		$usage = new self($entry, $seconds);
		$usage->run($target);
		return $usage->answer();
	}

	/* ── what is searched for ───────────────────────────────────────────── */

	/** The block markup a block, pattern or style is found by, from the library's id; null when it is not registered. */
	private static function target_of(string $entry): ?array {
		list($kind, $id) = explode(':', $entry, 2);
		$types = WP_Block_Type_Registry::get_instance();
		if ($kind === 'block') return $types->is_registered($id) ? self::block_target($id) : null;
		if ($kind === 'pattern') return WP_Block_Patterns_Registry::get_instance()->is_registered($id) ? self::pattern_target($id) : null;
		// style:<block>:<style>. A block's name has no colon, so the last one ends it.
		$at = strrpos($id, ':');
		if ($at === false) return null;
		$block = substr($id, 0, $at);
		$name = substr($id, $at + 1);
		$type = $types->get_registered($block);
		if (!$type || $name === '') return null;
		$styles = array();
		foreach ((array) $type->styles as $s) if (is_array($s) && isset($s['name'])) $styles[$s['name']] = $s;
		if (class_exists('WP_Block_Styles_Registry')) foreach ((array) WP_Block_Styles_Registry::get_instance()->get_registered_styles_for_block($block) as $s) if (is_array($s) && isset($s['name'])) $styles[$s['name']] = $s;
		if (!isset($styles[$name])) return null;
		$default = !empty($styles[$name]['is_default']) || !empty($styles[$name]['isDefault']);
		return array('key' => 'style:' . $id, 'test' => 'class', 'name' => $block, 'class' => 'is-style-' . $name, 'needles' => array('is-style-' . $name), 'default' => $default);
	}

	/** A block type, by its delimiter: core's are written without "core/" (serialize_block()), and may be written with it. */
	private static function block_target(string $name): array {
		$short = strpos($name, 'core/') === 0 ? substr($name, 5) : $name;
		$needles = array('<!-- wp:' . $short . ' ');
		if ($short !== $name) $needles[] = '<!-- wp:' . $name . ' ';
		return array('key' => 'block:' . $name, 'test' => 'type', 'name' => $name, 'needles' => $needles);
	}

	/** A pattern: a core/pattern block naming it, or a block it was inserted as (metadata.patternName, one-block patterns only). */
	private static function pattern_target(string $slug): array {
		return array('key' => 'pattern:' . $slug, 'test' => 'pattern', 'slug' => $slug, 'needles' => array(self::pair('slug', $slug), self::pair('patternName', $slug)));
	}

	/** A synced pattern (core/block) or navigation menu (core/navigation) by its post id. */
	private static function ref_target(string $block, int $id): array {
		return array('key' => $block . ':' . $id, 'test' => 'ref', 'name' => $block, 'ref' => $id, 'needles' => array(self::pair('ref', $id)));
	}

	/** A template part (core/template-part) by its slug, in its theme or with none named. */
	private static function part_target(string $slug, string $theme): array {
		return array('key' => 'part:' . $theme . '//' . $slug, 'test' => 'part', 'slug' => $slug, 'theme' => $theme, 'needles' => array(self::pair('slug', $slug)));
	}

	/** One attribute as a block delimiter writes it (serialize_block_attributes()): what a LIKE can look for. */
	private static function pair(string $key, $value): string {
		$json = function_exists('serialize_block_attributes') ? serialize_block_attributes(array($key => $value)) : (string) wp_json_encode(array($key => $value), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
		return substr($json, 1, -1);
	}

	/** Whether a block is what is searched for: its type, and the attributes a style, pattern or reference is named by. */
	private static function matches(array $t, string $type, $attrs): bool {
		$attrs = is_array($attrs) ? $attrs : array();
		switch ($t['test']) {
			case 'type':
				return $type === $t['name'];
			case 'class':
				return $type === $t['name'] && isset($attrs['className']) && is_string($attrs['className']) && in_array($t['class'], preg_split('/\s+/', trim($attrs['className'])), true);
			case 'pattern':
				return ($type === 'core/pattern' && isset($attrs['slug']) && $attrs['slug'] === $t['slug'])
					|| (isset($attrs['metadata']['patternName']) && $attrs['metadata']['patternName'] === $t['slug']);
			case 'ref':
				return $type === $t['name'] && isset($attrs['ref']) && is_numeric($attrs['ref']) && (int) $attrs['ref'] === $t['ref'];
			case 'part':
				return $type === 'core/template-part' && isset($attrs['slug']) && $attrs['slug'] === $t['slug'] && (empty($attrs['theme']) || $attrs['theme'] === $t['theme']);
		}
		return false;
	}

	private static function mentions(string $markup, array $t): bool {
		foreach ($t['needles'] as $needle) if (strpos($markup, $needle) !== false) return true;
		return false;
	}

	/**
	 * Each block of the markup that is what is searched for: its path (the index among its siblings at each depth,
	 * counting a top-level stretch of HTML as parse_blocks() does, so it is the trace's block path) and the block
	 * names it sits in.
	 */
	public static function find(string $markup, array $t): array {
		$out = array();
		if ($markup === '' || !self::mentions($markup, $t)) return $out;
		$attrs = $t['test'] !== 'type';
		if (class_exists('WP_Block_Processor')) {
			$p = new WP_Block_Processor($markup);
			$next = array();
			$path = array();
			// With '*' it stops at HTML too. Top-level HTML counts, as parse_blocks() makes a freeform block of it;
			// HTML inside a block does not, as parse_blocks() keeps it in innerContent, not innerBlocks. (7.1.3 stops
			// at inner HTML as well, whatever next_delimiter()'s comment says.)
			while ($p->next_delimiter('*')) {
				if ($p->get_delimiter_type() === WP_Block_Processor::CLOSER) continue;
				$level = $p->get_depth() - 1;
				if ($level > 0 && $p->is_html()) continue;
				$index = isset($next[$level]) ? $next[$level] : 0;
				$next = array_slice($next, 0, $level);
				$next[$level] = $index + 1;
				$path = array_slice($path, 0, $level);
				$path[] = $index;
				if ($p->is_html()) continue;
				$type = $p->get_block_type();
				if ($type === null || !self::matches($t, $type, $attrs ? $p->allocate_and_return_parsed_attributes() : null)) continue;
				$out[] = array('path' => $path, 'crumbs' => $p->get_breadcrumbs());
				if (count($out) >= self::MAX_HITS) break;
			}
			return $out;
		}
		$walk = function (array $blocks, array $path, array $crumbs) use (&$walk, &$out, $t) {
			foreach (array_values($blocks) as $i => $b) {
				if (count($out) >= self::MAX_HITS) return;
				if (empty($b['blockName'])) continue;
				$here = array_merge($path, array($i));
				$names = array_merge($crumbs, array($b['blockName']));
				if (self::matches($t, $b['blockName'], isset($b['attrs']) ? $b['attrs'] : array())) $out[] = array('path' => $here, 'crumbs' => $names);
				if (!empty($b['innerBlocks'])) $walk($b['innerBlocks'], $here, $names);
			}
		};
		$walk(parse_blocks($markup), array(), array());
		return $out;
	}

	/* ── the search ─────────────────────────────────────────────────────── */

	private function run(array $target): void {
		$this->searched[] = 'Stored block markup of every public post type, templates, template parts, synced patterns and navigation menus (published, scheduled, draft, pending and private), each match confirmed block by block.';
		$this->searched[] = 'The theme’s template and part files, as WordPress reads them.';
		$this->searched[] = 'Registered patterns.';
		$this->searched[] = 'Block widgets.';
		$this->searched[] = 'What holds it, followed wherever that is used in turn: synced patterns, patterns, template parts and navigation menus.';
		$this->unseen[] = 'Blocks that Block Hooks insert as a page renders: stored content never holds them (WordPress adds them to the theme’s files and patterns as it reads them, and those are searched as it reads them).';
		$this->unseen[] = 'Blocks a theme or plugin renders from PHP: a classic theme’s templates, do_blocks() on its own markup, a shortcode.';
		$this->unseen[] = 'Which pages show a template or template part: the template hierarchy decides it as each page renders.';
		$this->unseen[] = 'Revisions, autosaves and the trash.';
		if ($target['test'] === 'pattern') $this->unseen[] = 'Where a pattern of more than one top-level block was inserted: WordPress keeps a pattern’s name only on a pattern of one block, so the others are ordinary blocks once placed.';
		if ($target['test'] === 'class' && !empty($target['default'])) $this->unseen[] = 'Blocks that show this style because it is the default: they carry no class to find.';
		if (function_exists('is_multisite') && is_multisite()) $this->unseen[] = 'The other sites of this network.';
		$this->queue[] = array($target, null);
		while ($this->queue) {
			if ($this->late()) break;
			list($t, $via) = array_shift($this->queue);
			if (isset($this->done[$t['key']])) continue;
			if (count($this->done) >= self::MAX_REFERENCES) {
				$this->gaps[] = 'More than ' . self::MAX_REFERENCES . ' things hold it; where the rest are used was not followed.';
				break;
			}
			$this->done[$t['key']] = true;
			$this->scan($t, $via);
		}
	}

	private function follow(array $target, string $via): void {
		if (!isset($this->done[$target['key']])) $this->queue[] = array($target, $via);
	}

	private function late(): bool {
		if (!$this->late && microtime(true) > $this->until) $this->late = true;
		return $this->late;
	}

	private function scan(array $t, $via): void {
		foreach ($this->candidates($t['needles']) as $id) {
			if ($this->late()) return;
			$post = get_post((int) $id);
			if (!$post) continue;
			$hits = self::find((string) $post->post_content, $t);
			if ($hits) $this->stored($post, $hits, $via);
		}
		foreach ($this->files() as $template) {
			$hits = self::find((string) $template->content, $t);
			if ($hits) $this->file_template($template, $hits, $via);
		}
		foreach ($this->patterns() as $pattern) {
			if ($t['test'] === 'pattern' && $pattern['name'] === $t['slug']) continue;
			$hits = self::find((string) $pattern['content'], $t);
			if (!$hits) continue;
			$label = isset($pattern['title']) && $pattern['title'] !== '' ? (string) $pattern['title'] : (string) $pattern['name'];
			$this->add($this->place('pattern', $label, $hits, $via, array(
				'file' => isset($pattern['filePath']) && is_string($pattern['filePath']) ? Wanigan_Live::rel($pattern['filePath']) : null,
				'note' => isset($pattern['inserter']) && !$pattern['inserter'] ? 'hidden from the inserter' : null,
			)));
			$this->follow(self::pattern_target((string) $pattern['name']), 'the pattern “' . $label . '”');
		}
		foreach ($this->widgets() as $widget) {
			$hits = self::find($widget['content'], $t);
			if (!$hits) continue;
			$active = $widget['sidebar'] !== null && $widget['sidebar'] !== 'wp_inactive_widgets';
			$name = $active && isset($GLOBALS['wp_registered_sidebars'][$widget['sidebar']]['name']) ? (string) $GLOBALS['wp_registered_sidebars'][$widget['sidebar']]['name'] : (string) $widget['sidebar'];
			$this->add($this->place('widget', $active ? 'Block widget in ' . $name : 'Inactive block widget', $hits, $via, array(
				'note' => $active ? null : 'in Inactive widgets, so no page shows it',
				'edit' => current_user_can('edit_theme_options') ? self::path(admin_url('widgets.php')) : null,
			)));
		}
	}

	/** Every post type the editor stores blocks in that a search should read. */
	private static function post_types(): array {
		$public = array_diff(array_values(get_post_types(array('public' => true))), array('attachment'));
		return array_values(array_unique(array_merge($public, array('wp_template', 'wp_template_part', 'wp_block', 'wp_navigation'))));
	}

	/** Posts whose stored markup holds a needle: a prepared LIKE (no search filter reworks it), bounded. */
	private function candidates(array $needles): array {
		global $wpdb;
		$types = self::post_types();
		$likes = array();
		foreach ($needles as $needle) $likes[] = '%' . $wpdb->esc_like($needle) . '%';
		$sql = 'SELECT ID FROM ' . $wpdb->posts
			. ' WHERE post_type IN (' . implode(', ', array_fill(0, count($types), '%s')) . ')'
			. ' AND post_status IN (' . implode(', ', array_fill(0, count(self::STATUSES), '%s')) . ')'
			. ' AND (' . implode(' OR ', array_fill(0, count($likes), 'post_content LIKE %s')) . ')'
			. ' ORDER BY ID LIMIT %d';
		$ids = $wpdb->get_col($wpdb->prepare($sql, array_merge($types, self::STATUSES, $likes, array(self::MAX_CANDIDATES + 1))));
		$ids = is_array($ids) ? $ids : array();
		if (count($ids) > self::MAX_CANDIDATES) {
			$this->gaps[] = 'More than ' . self::MAX_CANDIDATES . ' stored items mention it; the first ' . self::MAX_CANDIDATES . ' were read.';
			$ids = array_slice($ids, 0, self::MAX_CANDIDATES);
		}
		return $ids;
	}

	/** The theme's template and part files that no saved copy replaces (a saved one is a post, searched above). */
	private function files(): array {
		if ($this->files === null) {
			$this->files = array();
			foreach (array('wp_template', 'wp_template_part') as $type) {
				foreach ((array) get_block_templates(array(), $type) as $template) {
					if (is_object($template) && empty($template->wp_id) && isset($template->content)) $this->files[] = $template;
				}
			}
		}
		return $this->files;
	}

	private function patterns(): array {
		if ($this->patterns === null) {
			$this->patterns = array();
			foreach ((array) WP_Block_Patterns_Registry::get_instance()->get_all_registered() as $pattern) {
				if (is_array($pattern) && !empty($pattern['name']) && isset($pattern['content'])) $this->patterns[] = $pattern;
			}
		}
		return $this->patterns;
	}

	private function widgets(): array {
		if ($this->widgets === null) {
			$this->widgets = array();
			$where = array();
			foreach ((array) wp_get_sidebars_widgets() as $sidebar => $ids) foreach ((array) $ids as $wid) $where[(string) $wid] = (string) $sidebar;
			foreach ((array) get_option('widget_block', array()) as $n => $instance) {
				if (!is_numeric($n) || !is_array($instance) || !isset($instance['content']) || !is_string($instance['content'])) continue;
				$wid = 'block-' . $n;
				$this->widgets[] = array('id' => $wid, 'content' => $instance['content'], 'sidebar' => isset($where[$wid]) ? $where[$wid] : null);
			}
		}
		return $this->widgets;
	}

	/* ── places ─────────────────────────────────────────────────────────── */

	/** A saved post, template, part, synced pattern or navigation menu that holds it; what holds it by reference is followed. */
	private function stored($post, array $hits, $via): void {
		$type = (string) $post->post_type;
		$kind = isset(self::KINDS[$type]) ? self::KINDS[$type] : 'content';
		$theme = null;
		if ($kind === 'template' || $kind === 'template-part') {
			$terms = get_the_terms($post->ID, 'wp_theme');
			$theme = is_array($terms) && $terms ? (string) $terms[0]->name : get_stylesheet();
			$store = ($kind === 'template' ? 'tpl:' : 'tp:') . $theme . '//' . $post->post_name;
		} else {
			$store = 'post:' . $post->ID;
		}
		$readable = current_user_can('read_post', $post->ID);
		$object = get_post_type_object($type);
		$noun = $object && isset($object->labels->singular_name) ? (string) $object->labels->singular_name : $type;
		$title = trim(wp_strip_all_tags((string) $post->post_title));
		$label = $readable ? ($title !== '' ? $title : ((string) $post->post_name !== '' ? (string) $post->post_name : '(no title)')) : 'A ' . strtolower($noun) . ' the user logged in here cannot read';
		$notes = array();
		if ($kind === 'content') $notes[] = $noun;
		if ($post->post_status !== 'publish') {
			$status = get_post_status_object($post->post_status);
			$notes[] = $status && !empty($status->label) ? strtolower((string) $status->label) : (string) $post->post_status;
		}
		if ($theme !== null && $theme !== get_stylesheet()) $notes[] = 'for the ' . $theme . ' theme, not the one in use';
		$url = null;
		if ($kind === 'content' && $post->post_status === 'publish' && is_post_type_viewable($type)) $url = self::path((string) get_permalink($post));
		if ($kind === 'template' && $theme === get_stylesheet()) $url = self::template_url((string) $post->post_name);
		$this->add($this->place($kind, $label, $hits, $via, array(
			'store' => $store, 'note' => implode('; ', $notes), 'url' => $url,
			'edit' => $readable ? self::path((string) get_edit_post_link($post->ID, 'raw')) : null,
		)));
		$what = $readable ? '“' . $label . '”' : 'one the user here cannot read';
		if ($type === 'wp_block') $this->follow(self::ref_target('core/block', (int) $post->ID), 'the synced pattern ' . $what);
		if ($type === 'wp_navigation') $this->follow(self::ref_target('core/navigation', (int) $post->ID), 'the navigation menu ' . $what);
		if ($type === 'wp_template_part' && $theme === get_stylesheet()) $this->follow(self::part_target((string) $post->post_name, $theme), 'the template part ' . $what);
	}

	/** A template or part of the theme's files, read as WordPress reads it; a part is followed wherever it is used. */
	private function file_template($template, array $hits, $via): void {
		$type = (string) $template->type;
		$kind = $type === 'wp_template' ? 'template' : 'template-part';
		$label = !empty($template->title) ? (string) $template->title : (string) $template->slug;
		$object = get_post_type_object($type);
		$edit = $object && !empty($object->_edit_link) && current_user_can('edit_theme_options') ? self::path(admin_url(sprintf($object->_edit_link, $type, urlencode((string) $template->id)))) : null;
		$this->add($this->place($kind, $label, $hits, $via, array(
			'store' => ($kind === 'template' ? 'tpl:' : 'tp:') . $template->id,
			'file' => self::theme_file($type, (string) $template->slug),
			'note' => 'the theme’s file',
			'url' => $kind === 'template' ? self::template_url((string) $template->slug) : null,
			'edit' => $edit,
		)));
		if ($kind === 'template-part') $this->follow(self::part_target((string) $template->slug, (string) $template->theme), 'the template part “' . $label . '”');
	}

	private function place(string $kind, string $label, array $hits, $via, array $more): array {
		$paths = array();
		foreach (array_slice($hits, 0, self::MAX_PATHS) as $hit) $paths[] = $hit['path'];
		return array_merge(array(
			'kind' => $kind, 'label' => $label,
			'where' => implode(' › ', array_slice($hits[0]['crumbs'], -6)),
			'count' => count($hits) > 1 ? count($hits) : null,
			'via' => $via,
			'paths' => isset($more['store']) ? $paths : null,
		), $more);
	}

	private function add(array $place): void {
		$this->found++;
		if (count($this->places) >= self::MAX_PLACES) return;
		$this->places[] = array_filter($place, function ($v) { return $v !== null && $v !== '' && $v !== array(); });
	}

	/** The page a template is sure to show on: the front page's own templates. */
	private static function template_url(string $slug): ?string {
		if ($slug === 'front-page' || ($slug === 'home' && get_option('show_on_front') !== 'page')) return self::path(home_url('/'));
		return null;
	}

	/** A theme template or part file, relative to the project: the child theme's, else the parent's. */
	private static function theme_file(string $type, string $slug): ?string {
		$folders = function_exists('get_block_theme_folders') ? get_block_theme_folders() : array('wp_template' => 'templates', 'wp_template_part' => 'parts');
		$folder = isset($folders[$type]) ? $folders[$type] : ($type === 'wp_template' ? 'templates' : 'parts');
		foreach (array(get_stylesheet_directory(), get_template_directory()) as $dir) {
			$file = $dir . '/' . $folder . '/' . $slug . '.html';
			if (is_file($file)) return Wanigan_Live::rel($file);
		}
		return null;
	}

	/** A path on this site from a URL WordPress made; null for one that would leave it. */
	private static function path(string $url): ?string {
		if ($url === '') return null;
		$u = wp_parse_url($url);
		if (!is_array($u)) return null;
		if (isset($u['host'])) {
			$hosts = array();
			foreach (array(home_url('/'), site_url('/')) as $own) {
				$h = wp_parse_url($own, PHP_URL_HOST);
				if (is_string($h)) $hosts[] = strtolower($h);
			}
			if (!in_array(strtolower((string) $u['host']), $hosts, true)) return null;
		}
		$path = isset($u['path']) && $u['path'] !== '' ? (string) $u['path'] : '/';
		if ($path[0] !== '/' || strpos($path, '//') === 0) return null;
		return $path . (isset($u['query']) ? '?' . $u['query'] : '');
	}

	private function answer(): array {
		if ($this->late) $this->gaps[] = 'The search stopped after ' . round($this->seconds, 1) . ' seconds, so what it had not reached is not listed.';
		if ($this->found > count($this->places)) $this->gaps[] = 'Only the first ' . count($this->places) . ' of ' . $this->found . ' places are listed.';
		$gaps = array_values(array_unique($this->gaps));
		return array(
			'version' => self::VERSION, 'platform' => 'wordpress', 'entry' => $this->entry,
			'places' => $this->places, 'found' => $this->found, 'complete' => !$gaps, 'gaps' => $gaps,
			'searched' => $this->searched, 'unseen' => $this->unseen,
			'ms' => (int) round((microtime(true) - $this->started) * 1000),
		);
	}
}
`;
