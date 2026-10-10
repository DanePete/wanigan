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

	public static function places(WP_Post $post, string $want, array $hints, string $noun): ?array {
		if (get_post_meta($post->ID, '_fl_builder_enabled', true)) {
			// Beaver Builder renders its own layout: found there, said so; its stored-content copy and its fields are not searched.
			$places = array();
			foreach (array('_fl_builder_data' => 'Beaver Builder’s layout for this ' . $noun) as $key => $label) {
				foreach (Wanigan_Live_Stored::meta_rows($post->ID) as $row) {
					if ((string) $row['meta_key'] !== $key || !is_string($row['meta_value'])) continue;
					$hits = Wanigan_Live_Words_Match::in_value($row['meta_value'], $want, $key, array(self::class, 'nodes'));
					foreach ($hits as &$h) {
						if ($h['stuck'] === '') $h['stuck'] = 'Wanigan does not save into Beaver Builder’s layout yet (its published and draft layouts and its asset cache move together): change them in Beaver Builder';
					}
					unset($h);
					if ($hits) $places[] = array('root' => 'copy:' . $key, 'label' => $label, 'raw' => $row['meta_value'], 'hash' => md5($row['meta_value']), 'hits' => $hits, 'writer' => 'core', 'revisions' => false, 'site' => false, 'post' => $post->ID);
				}
			}
			return array('places' => $places, 'content' => true, 'meta' => array('_fl_builder_'));
		}
		$skip = array('pagelayer-data');
		// SiteOrigin Page Builder renders panels_data; the stored content is its copy.
		$panels = get_post_meta($post->ID, 'panels_data', true);
		return array('places' => array(), 'content' => is_array($panels) && $panels !== array(), 'meta' => $skip);
	}

	public static function claim(array $places, WP_Post $post, string $noun, string $after): array {
		foreach ($places as $i => $p) {
			// All in One SEO's mirror of its own table: what renders is the table.
			if (isset($p['key']) && strpos((string) $p['key'], '_aioseo_') === 0) {
				foreach ($places[$i]['hits'] as $j => $h) {
					if ($h['stuck'] === '') $places[$i]['hits'][$j]['stuck'] = 'that field is a copy All in One SEO keeps of its own table, which is what the page shows, so saving it would change nothing: change it in All in One SEO for this ' . $noun;
				}
			}
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
`;

export const WORDPRESS_COPIES_SOURCE = SOURCE;
