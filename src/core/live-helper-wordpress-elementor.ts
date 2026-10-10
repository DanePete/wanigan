// The WordPress helper's Elementor adapter for stored words (helper version 4): one Wanigan_Live_Words_Adapter
// (live-helper-wordpress-words.ts), used only when Elementor is loaded, and never needed by the core search. PHP
// source appended to the must-use plugin, PHP 7.4 syntax.
//
// Read from Elementor 4.3.4's own source (free, GPL, from wordpress.org; not kept here):
// - A post built with Elementor (Document::is_built_with_elementor(), the `_elementor_edit_mode` field) renders from
//   `_elementor_data`, the elements tree as JSON in a custom field (Document::get_elements_data(), get_json_meta()).
//   Its stored content is a plain-text copy Elementor writes for search on every save (includes/db.php
//   save_plain_text()); `_elementor_element_cache` keeps rendered HTML and `_elementor_css` its CSS. So the copy and
//   the caches are never searched for such a post: found there, the words would be "kept twice" or saved where
//   nothing renders them.
// - The editor saves with Document::save(['elements' => ...]) (core/documents-manager.php ajax_save()): it checks
//   the user may edit the document (is_editable_by_current_user()), runs kses over the data for a user without
//   unfiltered_html, writes `_elementor_data`, writes the plain-text copy with wp_update_post() (a revision, which
//   Elementor's revisions module fills with its data), deletes the post's CSS file and its element cache. Words are
//   saved through that same call, so Elementor's caches and revisions stay right.
// - Elementor drops an element it cannot load (a widget whose plugin is off) when it saves (get_elements_raw_data()),
//   so a document where that would happen is not saved. A newer autosave (changes in the editor not yet saved) is
//   refused rather than left behind.
// - Each document Elementor renders is marked data-elementor-id, each element data-id: the main process passes those
//   as hints (live-stored-words.ts), so a template shown on the page (a header, say) is found too, and two widgets
//   holding the same words are told apart. A document that is not the page's own is said to show wherever it is
//   used, and saved only once the owner says so.
// - Undo saves the tree as it was through Document::save() again (never a raw write of its data), so its plain-text
//   copy, its caches and a revision follow as on any save.
// - For the live view's own requests Elementor's element cache is switched off (pre_option_elementor_element_cache_ttl
//   → "disable"): on a cache hit no element renders, so the trace would see none, and a read-back could see old ones.

const SOURCE = String.raw`
/**
 * Elementor's documents: words searched in the elements tree Elementor renders from, and saved through its own
 * Document::save() (Wanigan's src/core/live-helper-wordpress-elementor.ts says what was read where). A site adapter on
 * the shared base (Wanigan_Live_Adapter): what it calls is declared in requires(), checked where it runs and by the
 * compatibility watch against every Elementor release; a missing call refuses every save by name.
 */
final class Wanigan_Live_Adapter_Elementor extends Wanigan_Live_Adapter implements Wanigan_Live_Words_Adapter {
	const DATA = '_elementor_data';
	const MODE = '_elementor_edit_mode';

	public static function id(): string {
		return 'elementor';
	}

	public static function extension(): array {
		$version = defined('ELEMENTOR_VERSION') ? (string) constant('ELEMENTOR_VERSION') : null;
		return array('name' => 'Elementor', 'active' => $version !== null && class_exists('\Elementor\Plugin'), 'version' => $version);
	}

	/** Everything this adapter calls or relies on, for the check where it runs and the weekly watch. */
	public static function requires(): array {
		return array(
			'constant:ELEMENTOR_VERSION',
			'class:Elementor\Plugin',
			'class:Elementor\Core\Documents_Manager',
			'method:Elementor\Core\Documents_Manager::get',
			'method:Elementor\Core\Documents_Manager::switch_to_document',
			'method:Elementor\Core\Documents_Manager::restore_document',
			'class:Elementor\DB',
			'method:Elementor\DB::switch_to_post',
			'method:Elementor\DB::restore_current_post',
			'class:Elementor\Core\Base\Document',
			'method:Elementor\Core\Base\Document::is_built_with_elementor',
			'method:Elementor\Core\Base\Document::is_editable_by_current_user',
			'method:Elementor\Core\Base\Document::get_newer_autosave',
			'method:Elementor\Core\Base\Document::get_elements_data',
			'method:Elementor\Core\Base\Document::get_elements_raw_data',
			'method:Elementor\Core\Base\Document::save',
			// Its element cache, switched off for the live view's own requests (Document::print_elements() reads it).
			'hook:pre_option_elementor_element_cache_ttl',
			'option:elementor_element_cache_ttl',
			// Its tree, whether a post is built with it (read directly only to refuse by name when it is broken), and the
			// rendered-element cache its save clears.
			'meta:_elementor_data',
			'meta:_elementor_edit_mode',
			'meta:_elementor_element_cache',
		);
	}

	public static function verified(): array {
		return array('from' => '4.3.4', 'through' => '4.3.4');
	}

	public static function active(): bool {
		$ext = self::extension();
		return !empty($ext['active']);
	}

	public static function name(): string {
		return 'Elementor';
	}

	/** A post's Elementor document, when Elementor builds it. */
	private static function document(int $id) {
		$doc = \Elementor\Plugin::$instance->documents->get($id);
		return $doc && method_exists($doc, 'is_built_with_elementor') && $doc->is_built_with_elementor() ? $doc : null;
	}

	/** Every element in a tree, counted. */
	private static function count(array $elements): int {
		$n = 0;
		foreach ($elements as $e) {
			if (!is_array($e)) continue;
			$n += 1 + (isset($e['elements']) && is_array($e['elements']) ? self::count($e['elements']) : 0);
		}
		return $n;
	}

	/**
	 * Where the words are in an elements tree: only in each element's settings (never its id or type), and never in a
	 * setting Elementor keeps for itself (__dynamic__, __globals__).
	 */
	private static function hits(array $elements, string $want, array $path): array {
		$out = array();
		foreach ($elements as $i => $e) {
			if (!is_array($e)) continue;
			$at = array_merge($path, array(array('k', $i)));
			$settings = isset($e['settings']) && is_array($e['settings']) ? $e['settings'] : array();
			foreach ($settings as $key => $value) {
				if (is_string($key) && strpos($key, '__') === 0) continue;
				foreach (Wanigan_Live_Words_Match::in_value($value, $want, $key, null) as $hit) {
					$hit['steps'] = array_merge($at, array(array('k', 'settings'), array('k', $key)), $hit['steps']);
					$hit['element'] = isset($e['id']) && is_string($e['id']) ? $e['id'] : '';
					$type = isset($e['widgetType']) && is_string($e['widgetType']) ? $e['widgetType'] . ' widget' : (isset($e['elType']) && is_string($e['elType']) ? $e['elType'] : 'element');
					$hit['where'] = ' (its ' . str_replace(array('-', '_'), ' ', $type) . ')';
					$out[] = $hit;
				}
			}
			if (isset($e['elements']) && is_array($e['elements'])) $out = array_merge($out, self::hits($e['elements'], $want, array_merge($at, array(array('k', 'elements')))));
		}
		return $out;
	}

	public static function places(WP_Post $post, string $want, array $hints, string $noun): ?array {
		$state = Wanigan_Live_Adapters::status(self::class);
		if ($state['status'] === 'broken') {
			// Elementor is here, but something this adapter saves through is not: its pages are still its own (the stored
			// content is its plain-text copy), so the words are found in its tree, read only, and the save refuses them by
			// name (Wanigan_Live_Stored asks the adapter's status before it answers).
			if (!get_post_meta($post->ID, self::MODE, true)) return null;
			$raw = (string) get_post_meta($post->ID, self::DATA, true);
			$tree = json_decode($raw, true);
			$hits = is_array($tree) ? self::hits($tree, $want, array()) : array();
			$places = $hits ? array(array('root' => 'elementor:' . $post->ID, 'post' => $post->ID, 'label' => 'the Elementor ' . $noun . ' “' . trim((string) $post->post_title) . '”', 'raw' => $raw, 'hash' => md5($raw), 'hits' => $hits, 'writer' => self::class, 'revisions' => false, 'site' => false)) : array();
			return array('places' => $places, 'content' => true, 'meta' => array('_elementor_'));
		}
		$own = self::document($post->ID);
		$ids = $own ? array($post->ID) : array();
		$hint = isset($hints['elementor']) ? $hints['elementor'] : null;
		foreach ($hint ? $hint['documents'] : array() as $d) {
			if (!in_array((int) $d, $ids, true)) $ids[] = (int) $d;
		}
		if (!$ids) return null;
		$places = array();
		foreach ($ids as $id) {
			$doc = $id === $post->ID ? $own : self::document($id);
			$theirs = get_post($id);
			// A revision or an autosave of a document is never what the page shows.
			if (!$doc || !$theirs || $theirs->post_type === 'revision' || !$doc->is_editable_by_current_user()) continue;
			$elements = $doc->get_elements_data();
			if (!is_array($elements)) continue;
			$hits = self::hits($elements, $want, array());
			if (!$hits) continue;
			$raw = (string) get_post_meta($id, self::DATA, true);
			$title = trim((string) $theirs->post_title);
			$kind = $id === $post->ID ? $noun : ($theirs->post_type === 'elementor_library' ? 'template' : Wanigan_Live_Stored::noun($theirs));
			$places[] = array(
				'root' => 'elementor:' . $id, 'post' => $id, 'label' => 'the Elementor ' . $kind . ($title !== '' ? ' “' . $title . '”' : ''), 'raw' => $raw, 'hash' => md5($raw),
				'hits' => $hits, 'writer' => self::class, 'revisions' => function_exists('wp_revisions_enabled') && wp_revisions_enabled($theirs), 'site' => $id !== $post->ID,
				'cache' => 'Elementor’s own save cleared its CSS file and element cache for it; a page cache in front of the site can still serve the old page.',
			);
		}
		// For a post Elementor builds, its stored content is Elementor's plain-text copy and its _elementor_ fields are
		// its own data and caches: not searched by the core search.
		return array('places' => $places, 'content' => (bool) $own, 'meta' => $own ? array('_elementor_') : array());
	}

	public static function claim(array $places, WP_Post $post, string $noun, string $after): array {
		return $places;
	}

	public static function owned(string $key): ?string {
		return null;
	}

	public static function site_places(string $want, string $after): array {
		return array();
	}

	public static function write(array $place, array $hit, string $after, WP_Post $post) {
		$state = Wanigan_Live_Adapters::status(self::class);
		if ($state['status'] === 'broken') return new WP_Error('wanigan', Wanigan_Live_Adapters::refusal($state));
		$id = (int) $place['post'];
		$doc = self::document($id);
		if (!$doc) return new WP_Error('wanigan', 'Elementor no longer builds this, so nothing is saved.');
		if (!$doc->is_editable_by_current_user()) return new WP_Error('wanigan', 'Elementor says the user you are logged in as may not edit this. Log in there as someone who may.', array('status' => 403));
		$theirs = get_post($id);
		if ($id !== $post->ID && $theirs && ($why = Wanigan_Live::post_refusal($theirs, 'template'))) return new WP_Error('wanigan', $why);
		if (method_exists($doc, 'get_newer_autosave') && $doc->get_newer_autosave()) {
			return new WP_Error('wanigan', 'This has changes in Elementor’s editor that are not saved yet (an autosave newer than what visitors see): saving here would leave them behind, so nothing is saved. Save or discard them in Elementor first.');
		}
		$raw = (string) get_post_meta($id, self::DATA, true);
		$elements = $doc->get_elements_data();
		if (!is_array($elements)) return new WP_Error('wanigan', 'Elementor’s data for this cannot be read, so nothing is saved.');
		// Elementor drops an element it cannot load when it saves: refused rather than lost.
		$loaded = $doc->get_elements_raw_data($elements);
		if (!is_array($loaded) || self::count($loaded) !== self::count($elements)) {
			return new WP_Error('wanigan', 'Elementor cannot load every element of this now (a widget whose plugin is off, say), and saving through it would drop them, so nothing is saved.');
		}
		$new = Wanigan_Live_Words_Match::put($elements, $hit['steps'], $hit['start'], $hit['end'], Wanigan_Live_Words_Match::insert($hit, $after), null);
		$content = (string) get_post_field('post_content', $id, 'raw');
		$before = Wanigan_Live::revision_of($id);
		$plugin = \Elementor\Plugin::$instance;
		// As the editor's save sets them up (Documents_Manager::ajax_save()).
		$plugin->documents->switch_to_document($doc);
		$plugin->db->switch_to_post($id);
		try {
			$saved = $doc->save(array('elements' => $new));
		} finally {
			$plugin->db->restore_current_post();
			$plugin->documents->restore_document();
		}
		if (!$saved) return new WP_Error('wanigan', 'Elementor did not save it.');
		$now = (string) get_post_meta($id, self::DATA, true);
		$after_rev = Wanigan_Live::revision_of($id);
		return array('revision' => $after_rev && $after_rev !== $before ? $after_rev : null, 'undo' => array('type' => 'stored', 'writer' => self::class, 'post' => $id, 'before' => $raw, 'content' => $content, 'after' => md5($now)));
	}

	public static function undo(array $u) {
		$state = Wanigan_Live_Adapters::status(self::class);
		if ($state['status'] === 'broken') return new WP_Error('wanigan', Wanigan_Live_Adapters::refusal($state));
		$id = (int) $u['post'];
		$doc = self::document($id);
		if (!$doc || !$doc->is_editable_by_current_user()) return new WP_Error('wanigan', 'Elementor says the user you are logged in as may not edit this.');
		$theirs = get_post($id);
		if ($theirs && ($why = Wanigan_Live::post_refusal($theirs, Wanigan_Live_Stored::noun($theirs)))) return new WP_Error('wanigan', $why);
		if (md5((string) get_post_meta($id, self::DATA, true)) !== $u['after']) return new WP_Error('wanigan', 'It changed again since, so putting it back could undo other work.');
		$old = json_decode((string) $u['before'], true);
		if (!is_array($old)) return new WP_Error('wanigan', 'The tree as it was cannot be read back, so it is not put back.');
		$before = Wanigan_Live::revision_of($id);
		// The tree as it was, through Elementor's own save again: its plain-text copy, its caches and a revision follow.
		$plugin = \Elementor\Plugin::$instance;
		$plugin->documents->switch_to_document($doc);
		$plugin->db->switch_to_post($id);
		try {
			$saved = $doc->save(array('elements' => $old));
		} finally {
			$plugin->db->restore_current_post();
			$plugin->documents->restore_document();
		}
		if (!$saved) return new WP_Error('wanigan', 'Elementor did not put it back.');
		$after = Wanigan_Live::revision_of($id);
		return array('revision' => $after && $after !== $before ? $after : null);
	}
}
Wanigan_Live_Stored::adapt('Wanigan_Live_Adapter_Elementor');
// Elementor's own global colours are not read yet: its source is not on hand to read the API they are kept behind, so
// the palette says so by name rather than guess at one. Custom properties its pages print are still read, by the page.
Wanigan_Live::colour_source(function () {
	if (!Wanigan_Live_Adapter_Elementor::active()) return null;
	return array('id' => 'elementor', 'name' => 'Elementor', 'why' => 'Elementor’s global colours are not read from Elementor yet. Where its pages set them as custom properties, they show among the theme’s tokens.');
});
// For the live view's own requests only, Elementor renders every element afresh rather than from its element cache
// (Document::print_elements() reads elementor_element_cache_ttl, and "disable" skips the cache): on a cache hit no
// element is rendered, so the trace would see none of them, and a page read back after a save could show the old ones.
if (wanigan_live_on()) {
	add_filter('pre_option_elementor_element_cache_ttl', function () { return 'disable'; });
}
`;

export const WORDPRESS_ELEMENTOR_SOURCE = SOURCE;
