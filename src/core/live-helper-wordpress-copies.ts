// The WordPress helper's known copies for stored words (helper version 4): one Wanigan_Live_Words_Adapter
// (live-helper-wordpress-words.ts) that never saves anything. Some plugins keep a second copy of words that never
// renders (a stripped copy for search, a rendered cache, a mirror of their own table): found there, the core search
// would call the words "kept twice", or save into the copy and report "saved" while the page never changes. Each rule
// below names the plugin, how its own data tells it is in use, and what it does. PHP source appended to the must-use
// plugin, PHP 7.4 syntax; checked from those plugins' public source (file and line in the session's coverage notes),
// not run here.
//
// - Beaver Builder (a post with `_fl_builder_enabled`): the page renders `_fl_builder_data` (serialized nodes) and
//   ignores the post's stored content, which is a stripped copy written at publish; a draft layout
//   (`_fl_builder_draft`) is published over it later. Wanigan does not save into Beaver Builder's layout: its words are
//   found there (read only) and refused, saying where, and the stored content copy is not searched.
// - SiteOrigin Page Builder (a post with `panels_data`): the stored content is a copy; `panels_data` itself is what
//   renders, and the core search writes it back byte for byte.
// - SiteOrigin widget blocks (`sowb/*`): `widgetMarkup` and `html` in the block's settings are rendered copies the
//   block rebuilds; only `widgetData` is words to change.
// - Pagelayer: `pagelayer-data` is a copy that never renders; its words are in the post's block markup, as core keeps
//   them.
// - All in One SEO: `_aioseo_*` custom fields mirror its own table, which is what renders: never written.
// - Bricks (`_bricks_*`) and Breakdance (`_breakdance_data`): their own page data, not saved into.
// Every one of these custom fields is also kept out of the fields the trace offers to type into (owned()), and words
// found in one are refused, saying whose data it is. For the live view's own requests, The Events Calendar's HTML cache
// is switched off (tribe_events_views_v2_should_cache_html), so the trace and a read-back see what it renders now.

const SOURCE = String.raw`
/**
 * Copies of words some plugins keep that never render (Wanigan's src/core/live-helper-wordpress-copies.ts names each,
 * and how it is known to be in use). It saves nothing: it keeps the core search from finding or saving the copy.
 */
final class Wanigan_Live_Copies implements Wanigan_Live_Words_Adapter {
	public static function active(): bool {
		return true;
	}

	public static function name(): string {
		return 'a known copy';
	}

	/** A serialized value's contents with no classes but stdClass, or null. */
	public static function nodes(string $s) {
		if (!is_serialized($s)) return null;
		$v = @unserialize(trim($s), array('allowed_classes' => array('stdClass')));
		return is_array($v) || $v instanceof stdClass ? $v : null;
	}

	/** Custom fields that are a plugin's own data, by the start of their names, and why; none is a field to type into, or saved by the core search. */
	const OWNED = array(
		'_elementor_' => 'it is Elementor’s own data for the page, which only Elementor’s own save keeps right (its CSS, its element cache, its revisions)',
		'_fl_builder_' => 'it is Beaver Builder’s layout, which Wanigan does not save into yet (its published and draft layouts and its asset cache move together): change it in Beaver Builder',
		'panels_data' => 'it is SiteOrigin Page Builder’s layout, which Wanigan does not save into yet: change it in SiteOrigin Page Builder',
		'_bricks_' => 'it is Bricks’ own data for the page, which Wanigan does not save into: change it in Bricks',
		'_breakdance_data' => 'it is Breakdance’s own data for the page, which Wanigan does not save into: change it in Breakdance',
		'pagelayer-data' => 'it is a copy Pagelayer keeps that never shows; the words it shows are in the page’s own blocks',
		'_aioseo_' => 'it is a copy All in One SEO keeps of its own table, which is what the page shows, so saving it would change nothing: change it in All in One SEO',
	);

	public static function owned(string $key): ?string {
		foreach (self::OWNED as $prefix => $why) {
			if (strpos($key, $prefix) === 0) return $why;
		}
		return null;
	}

	public static function places(WP_Post $post, string $want, array $hints, string $noun): ?array {
		// What a plugin's own data holds is said, never saved: found there read only, each hit refused with whose it is.
		// Elementor's is its adapter's when Elementor is loaded; when it is not, the page shows the stored content.
		$places = array();
		foreach (Wanigan_Live_Stored::meta_rows($post->ID) as $row) {
			$key = (string) $row['meta_key'];
			$why = self::owned($key);
			if ($why === null || strpos($key, '_elementor_') === 0 || !is_string($row['meta_value']) || $row['meta_value'] === '') continue;
			$hits = Wanigan_Live_Words_Match::in_value($row['meta_value'], $want, $key, array(self::class, 'nodes'));
			foreach ($hits as &$h) {
				if ($h['stuck'] === '') $h['stuck'] = $why;
			}
			unset($h);
			$form = $hits && $hits[0]['steps'] ? ($hits[0]['steps'][0][0] === 's' ? ' (in its saved list)' : ($hits[0]['steps'][0][0] === 'j' ? ' (in its JSON)' : '')) : '';
			if ($hits) $places[] = array('root' => 'owned:' . (int) $row['meta_id'], 'label' => 'this ' . $noun . '’s custom field “' . $key . '”' . $form, 'raw' => $row['meta_value'], 'hash' => md5($row['meta_value']), 'hits' => $hits, 'writer' => 'core', 'revisions' => false, 'site' => false, 'post' => $post->ID);
		}
		// Beaver Builder and SiteOrigin Page Builder render their own layouts: the stored content is their copy.
		$panels = get_post_meta($post->ID, 'panels_data', true);
		$copy = (bool) get_post_meta($post->ID, '_fl_builder_enabled', true) || (is_array($panels) && $panels !== array());
		return array('places' => $places, 'content' => $copy, 'meta' => array());
	}

	public static function claim(array $places, WP_Post $post, string $noun, string $after): array {
		foreach ($places as $i => $p) {
			// A SiteOrigin widget block's rendered copies, rebuilt from its widgetData.
			if (isset($p['block']['name']) && strpos((string) $p['block']['name'], 'sowb/') === 0) {
				foreach ($places[$i]['hits'] as $j => $h) {
					$first = isset($h['steps'][0]) ? $h['steps'][0] : null;
					if ($first === array('k', 'widgetMarkup') || $first === array('k', 'html')) {
						$places[$i]['hits'][$j]['kind'] = 'code';
						$places[$i]['hits'][$j]['why'] = 'a copy the SiteOrigin widget rebuilds when it is saved';
					}
				}
			}
		}
		return $places;
	}

	public static function site_places(string $want, string $after): array {
		return array();
	}

	public static function write(array $place, array $hit, string $after, WP_Post $post) {
		return new WP_Error('wanigan', 'That is a copy, and Wanigan does not save into it.');
	}

	public static function undo(array $record) {
		return new WP_Error('wanigan', 'That is a copy, and Wanigan did not save into it.');
	}
}
Wanigan_Live_Stored::adapt('Wanigan_Live_Copies');
// For the live view's own requests only, The Events Calendar renders its views afresh rather than from its HTML cache:
// on a cache hit the trace would see none of the events' parts, and a read-back could see old words.
if (wanigan_live_on()) {
	add_filter('tribe_events_views_v2_should_cache_html', '__return_false');
}
`;

export const WORDPRESS_COPIES_SOURCE = SOURCE;
