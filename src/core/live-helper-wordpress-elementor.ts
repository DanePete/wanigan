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
// - Undo puts back `_elementor_data` and the plain-text copy byte for byte, then clears the CSS file and the element
//   cache as Elementor's own save does.

const SOURCE = String.raw`
/**
 * Elementor's documents: words searched in the elements tree Elementor renders from, and saved through its own
 * Document::save() (Wanigan's src/core/live-helper-wordpress-elementor.ts says what was read where).
 */
final class Wanigan_Live_Elementor implements Wanigan_Live_Words_Adapter {
	const DATA = '_elementor_data';
	const CACHE = '_elementor_element_cache';

	public static function active(): bool {
		return class_exists('\Elementor\Plugin') && isset(\Elementor\Plugin::$instance) && is_object(\Elementor\Plugin::$instance) && isset(\Elementor\Plugin::$instance->documents);
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
			if (!$doc || !$doc->is_editable_by_current_user()) continue;
			$elements = $doc->get_elements_data();
			if (!is_array($elements)) continue;
			$hits = self::hits($elements, $want, array());
			if (!$hits) continue;
			$raw = (string) get_post_meta($id, self::DATA, true);
			$theirs = get_post($id);
			$title = $theirs ? trim((string) $theirs->post_title) : '';
			$kind = $id === $post->ID ? $noun : ($theirs && $theirs->post_type === 'elementor_library' ? 'template' : Wanigan_Live_Stored::noun($theirs));
			$places[] = array(
				'root' => 'elementor:' . $id, 'post' => $id, 'label' => 'the Elementor ' . $kind . ($title !== '' ? ' “' . $title . '”' : ''), 'raw' => $raw, 'hash' => md5($raw),
				'hits' => $hits, 'writer' => self::class, 'revisions' => $theirs && function_exists('wp_revisions_enabled') && wp_revisions_enabled($theirs), 'site' => $id !== $post->ID,
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

	public static function site_places(string $want, string $after): array {
		return array();
	}

	public static function write(array $place, array $hit, string $after, WP_Post $post) {
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
		$id = (int) $u['post'];
		$doc = self::document($id);
		if (!$doc || !$doc->is_editable_by_current_user()) return new WP_Error('wanigan', 'Elementor says the user you are logged in as may not edit this.');
		$theirs = get_post($id);
		if ($theirs && ($why = Wanigan_Live::post_refusal($theirs, Wanigan_Live_Stored::noun($theirs)))) return new WP_Error('wanigan', $why);
		if (md5((string) get_post_meta($id, self::DATA, true)) !== $u['after']) return new WP_Error('wanigan', 'It changed again since, so putting it back could undo other work.');
		$before = Wanigan_Live::revision_of($id);
		// The data as it was, byte for byte (update_metadata() unslashes what it is given), then the plain-text copy as it
		// was: a revision, which Elementor fills with its data.
		update_metadata('post', $id, self::DATA, wp_slash((string) $u['before']));
		if ((string) get_post_field('post_content', $id, 'raw') !== (string) $u['content']) wp_update_post(array('ID' => $id, 'post_content' => wp_slash((string) $u['content'])));
		// What Elementor kept of the words, let go as its own save lets it go: the post's CSS file and its element cache.
		if (class_exists('\Elementor\Core\Files\CSS\Post')) \Elementor\Core\Files\CSS\Post::create($id)->delete();
		$doc->delete_meta(self::CACHE);
		clean_post_cache($id);
		$after = Wanigan_Live::revision_of($id);
		return array('revision' => $after && $after !== $before ? $after : null);
	}
}
Wanigan_Live_Stored::adapt('Wanigan_Live_Elementor');
`;

export const WORDPRESS_ELEMENTOR_SOURCE = SOURCE;
