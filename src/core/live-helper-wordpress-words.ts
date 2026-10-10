// The WordPress helper's stored words (POST /_wanigan/words, helper version 4): words a page shows that nothing the
// page offers to edit holds, found where the site keeps them for one post, and saved there through core. PHP source,
// appended to the must-use plugin (src/core/live-helper-wordpress.ts), so PHP 7.4 syntax like the rest of it.
// Contract: src/shared/live-stored-words.ts. The design layer asks it last, when no edit target of the trace holds the
// words (src/main/live-layer.ts implement()).
//
// - What is searched: the post the edit's part belongs to, as the page's own trace names it: its stored content
//   (raw: block delimiters' settings as JSON, markup's text and quoted attribute values, registered shortcodes'
//   settings and the words they wrap), its excerpt, and every custom field of it (has_meta(): a string, JSON read by
//   its string values, a serialized array through core's maybe_unserialize, walked). The matching rules are the
//   shared matcher's (live-helper-stored-match.ts). Read-only until the save.
// - Found once, as words, or refused: nowhere ("the site does not keep these words in this content"), more than once
//   (naming where), only in code (an address, a class, a style, a script), or kept where it cannot be written back
//   exactly.
// - Saved through core, as the logged-in user: the content and excerpt with wp_update_post() (a revision where the
//   post type keeps them), only when core's own filters on saving content would leave every other byte as it is; a
//   custom field with update_metadata_by_mid() (the exact row; a serialized array as an array; JSON re-encoded
//   token by token with the flags that wrote it), only when its registered sanitizing would too. The user's
//   edit_post capability and the post lock are checked, and the stored value's hash taken when found is checked just
//   before writing (a 409 when it changed). The new words go through kses as plain text: words only.
// - Undo: the old value is kept with the helper's undo tokens (POST /_wanigan/undo, ten minutes), and put back only
//   while the value is still what the save wrote; custom fields keep no revision in core, so this is their only way back.
// - Plugins that keep words their own way register an adapter (Wanigan_Live_Words_Adapter) from their own file:
//   it is asked first for the post (a page builder renders the post from its own data, so its copy is the one that
//   counts), may claim a place the core search found (a field plugin's field saved through its own API), and may
//   offer places outside the post (site-wide ones, asked about first). The core search and save never depend on one:
//   with none registered or active, this is all there is.

import { WORDPRESS_WORDS_MATCH } from './live-helper-stored-match.ts';

const SOURCE = String.raw`
/**
 * A plugin's own way of keeping and saving words, asked by Wanigan_Live_Stored when the plugin is active. Each
 * method is static; an adapter that has nothing for a step returns the neutral value.
 */
interface Wanigan_Live_Words_Adapter {
	/** Whether the plugin is loaded and its API is there. */
	public static function active(): bool;
	/** The plugin's name, as the answer says who saved the words. */
	public static function name(): string;
	/**
	 * Places the plugin keeps for this post, searched for the words, and what of the core search they replace:
	 * array('places' => [...], 'content' => bool (the post's stored content is not what shows), 'meta' => [prefixes of
	 * custom fields that are the plugin's own copy or cache]). Null when the plugin keeps nothing for it.
	 */
	public static function places(WP_Post $post, string $want, array $hints, string $noun): ?array;
	/** The core search's places, with any the plugin saves through its own API claimed (writer, label). */
	public static function claim(array $places, WP_Post $post, string $noun, string $after): array;
	/** Places outside the post (site-wide), searched only when the post holds the words nowhere. */
	public static function site_places(string $want): array;
	/** Saves one place this adapter claimed: array('revision' => ?int, 'undo' => record), or a WP_Error. */
	public static function write(array $place, array $hit, string $after, WP_Post $post);
	/** Puts one of its saves back: array('revision' => ?int), or a WP_Error. */
	public static function undo(array $record);
}

/**
 * POST /_wanigan/words: find where a post keeps the words a page shows, then save new words there (Wanigan's
 * src/core/live-helper-wordpress-words.ts says the rules).
 */
final class Wanigan_Live_Stored {
	/** Custom fields WordPress keeps for itself, which are never words. */
	const OWN = array('_edit_lock', '_edit_last', '_wp_old_slug', '_wp_old_date', '_wp_page_template', '_thumbnail_id', '_wp_attached_file', '_wp_attachment_metadata', '_wp_attachment_backup_sizes', '_wp_attachment_image_alt', '_encloseme', '_pingme', '_wp_trash_meta_status', '_wp_trash_meta_time', '_wp_trash_meta_comments_status', '_wp_desired_post_slug', '_wp_suggested_privacy_policy_content', '_menu_item_type', '_menu_item_object', '_menu_item_object_id', '_menu_item_url', '_menu_item_target', '_menu_item_classes', '_menu_item_xfn', '_menu_item_menu_item_parent', '_wp_ignored_hooked_blocks');
	/** Most custom fields of one post searched. */
	const MAX_META = 2000;
	/** Words longest that are saved here (the design layer cuts at the same). */
	const MAX_WORDS = 2000;
	/** A block delimiter, as WP_Block_Parser reads one (class-wp-block-parser.php next_token()). */
	const DELIMITER = '/<!--\s+(?P<closer>\/)?wp:(?P<namespace>[a-z][a-z0-9_-]*\/)?(?P<name>[a-z][a-z0-9_-]*)\s+(?P<attrs>{(?:(?:[^}]+|}+(?=})|(?!}\s+\/?-->).)*+)?}\s+)?(?P<void>\/)?-->/s';
	/** What a site's own cache may do, said with every save made through core. */
	const CACHE = 'If a plugin or theme shows these words from a copy of its own (a cache), the page can show the old words until that copy is made again.';

	/** @var string[] Adapter classes, registered by their own files. */
	private static $adapters = array();

	/** Registers a plugin's adapter (its own file calls this when it loads). */
	public static function adapt(string $class): void {
		if (!in_array($class, self::$adapters, true) && in_array('Wanigan_Live_Words_Adapter', class_implements($class) ?: array(), true)) self::$adapters[] = $class;
	}

	/** The registered adapters whose plugin is active now. */
	private static function adapters(): array {
		$out = array();
		foreach (self::$adapters as $a) {
			try {
				if (call_user_func(array($a, 'active'))) $out[] = $a;
			} catch (Throwable $e) {
				// An adapter that cannot tell is not used: the core search still runs.
			}
		}
		return $out;
	}

	/** A refusal: [answer, status], with what kind it is for the design layer. */
	private static function refuse(int $status, string $reason, string $error): array {
		return array(array('ok' => false, 'error' => $error, 'reason' => $reason), $status);
	}

	/** The request: find (read only) or save. [answer, HTTP status]. */
	public static function request(array $body): array {
		$step = isset($body['step']) && is_string($body['step']) ? $body['step'] : '';
		$trace = isset($body['trace']) && is_string($body['trace']) ? $body['trace'] : '';
		$content = isset($body['content']) && is_array($body['content']) ? $body['content'] : array();
		$before = isset($body['before']) && is_string($body['before']) ? $body['before'] : '';
		$after = isset($body['after']) && is_string($body['after']) ? trim($body['after']) : '';
		if (!in_array($step, array('find', 'save'), true) || !preg_match('/^[0-9a-f]{16}$/', $trace)) return self::refuse(400, 'refused', 'Which page, and which step?');
		if (!isset($content['type'], $content['id']) || $content['type'] !== 'post' || !preg_match('/^\d{1,20}$/', (string) $content['id'])) return self::refuse(400, 'refused', 'Which content?');
		$want = Wanigan_Live_Words_Match::fold($before);
		if ($want === '' || strlen($before) > self::MAX_WORDS || strlen($after) > self::MAX_WORDS) return self::refuse(400, 'refused', 'What words, and what instead?');
		if ($after === '') return self::refuse(400, 'refused', 'The new words are empty: taking words out is a change to make in the editor.');
		// kses on the new words as plain text: what it would take out (a tag, a comment) is not saved from here.
		$plain = function_exists('wp_kses') ? html_entity_decode(wp_kses($after, array()), ENT_QUOTES | ENT_HTML5, 'UTF-8') : $after;
		if (!Wanigan_Live_Words_Match::words_only($after) || $plain !== $after) return self::refuse(400, 'refused', 'Only words are saved from here: no tags, comments or control characters (WordPress’s kses would take them out).');
		if (Wanigan_Live_Words_Match::fold($after) === $want) return self::refuse(409, 'refused', 'These are the words it holds already: there is nothing to save.');
		$stored = Wanigan_Live::stored_trace($trace);
		if (!$stored) return self::refuse(409, 'changed', 'That page was shown more than ten minutes ago (or to another user): reload it and try again.');
		$pid = (int) $content['id'];
		if (!self::on_page($stored, $pid)) return self::refuse(409, 'refused', 'That content is not on the page this edit was made on: reload it and try again.');
		$post = get_post($pid);
		if (!$post instanceof WP_Post) return self::refuse(404, 'refused', 'That content is gone.');
		$noun = self::noun($post);
		$why = Wanigan_Live::post_refusal($post, $noun);
		if ($why) return self::refuse(strpos($why, 'Your WordPress user cannot') === 0 || strpos($why, 'Log in') === 0 ? 403 : 409, 'refused', $why);
		$hints = self::hints($body);
		$places = self::places($post, $want, $hints, $noun, $after);
		$picked = self::pick($places, $hints, $noun, $after);
		if (isset($picked['refusal']) && $picked['refusal'][2] === 'nowhere') {
			// Nothing in the post: what a plugin keeps for the whole site, asked about before it is saved.
			$site = array();
			foreach (self::adapters() as $a) {
				try {
					$site = array_merge($site, (array) call_user_func(array($a, 'site_places'), $want));
				} catch (Throwable $e) {
					continue;
				}
			}
			if ($site) {
				$again = self::pick($site, $hints, $noun, $after);
				if (!isset($again['refusal']) || $again['refusal'][2] !== 'nowhere') $picked = $again;
			}
		}
		if (isset($picked['refusal'])) return self::refuse($picked['refusal'][0], $picked['refusal'][2], $picked['refusal'][1]);
		$place = $picked['place'];
		$hit = $picked['hit'];
		$id = $place['root'] . '#' . Wanigan_Live_Words_Match::key($hit);
		$where = $place['label'] . (isset($hit['where']) ? $hit['where'] : '');
		$writer = $place['writer'] === 'core' ? 'core' : call_user_func(array($place['writer'], 'name'));
		$cache = isset($place['cache']) ? $place['cache'] : self::CACHE;
		$ask = !empty($place['site']) ? 'These words are kept in ' . $where . ', which every page that prints it shows, not this page alone.' : null;
		$answer = array('ok' => true, 'step' => $step, 'place' => $id, 'hash' => $place['hash'], 'where' => $where, 'revisions' => (bool) $place['revisions'], 'writer' => $writer, 'cache' => $cache, 'ask' => $ask, 'revision' => null, 'undo' => null);
		if ($step === 'find') return array($answer, 200);
		// Saving: only the place found, only over the value as it was found, and a site-wide one only once asked.
		$given = isset($body['place']) && is_string($body['place']) ? $body['place'] : '';
		$hash = isset($body['hash']) && is_string($body['hash']) ? $body['hash'] : '';
		if ($given !== $id || !hash_equals($place['hash'], $hash)) return self::refuse(409, 'changed', 'This changed on the site since Wanigan found where the words are kept: reload the page, and try again.');
		if ($ask !== null && (!isset($body['confirmed']) || $body['confirmed'] !== true)) return self::refuse(409, 'refused', $ask . ' Say so first: nothing is saved there without it.');
		try {
			$result = $place['writer'] === 'core' ? self::write($place, $hit, $after, $post, $noun) : call_user_func(array($place['writer'], 'write'), $place, $hit, $after, $post);
		} catch (Throwable $e) {
			$result = new WP_Error('wanigan', 'WordPress stopped with an error while saving: ' . $e->getMessage());
		}
		if (is_wp_error($result)) {
			$data = $result->get_error_data();
			return self::refuse(is_array($data) && isset($data['status']) ? (int) $data['status'] : 409, 'refused', $result->get_error_message());
		}
		$token = bin2hex(random_bytes(12));
		set_transient('wanigan_live_u_' . get_current_user_id() . '_' . $token, $result['undo'], Wanigan_Live::TTL);
		wanigan_live_changed();
		$answer['revision'] = isset($result['revision']) && $result['revision'] ? (string) $result['revision'] : null;
		$answer['undo'] = $token;
		return array($answer, 200);
	}

	/** Whether the page's trace shows the post: as a part, a block stored in it, or the post a block shows through its context. */
	private static function on_page(array $stored, int $pid): bool {
		$parts = isset($stored['trace']['parts']) && is_array($stored['trace']['parts']) ? $stored['trace']['parts'] : array();
		foreach ($parts as $p) {
			$i = isset($p['identity']) && is_array($p['identity']) ? $p['identity'] : array();
			if (isset($i['kind']) && $i['kind'] === 'entity' && isset($i['type'], $i['id']) && $i['type'] === 'post' && (string) $i['id'] === (string) $pid) return true;
			if (isset($i['kind']) && $i['kind'] === 'block' && isset($i['store']) && $i['store'] === 'post:' . $pid) return true;
			foreach (isset($p['variables']) && is_array($p['variables']) ? $p['variables'] : array() as $v) {
				if (isset($v['name'], $v['preview']) && $v['name'] === 'context.postId' && (string) $v['preview'] === (string) $pid) return true;
			}
		}
		return false;
	}

	/** What a post is called: its type's own name, lower case. */
	public static function noun(WP_Post $post): string {
		$type = get_post_type_object($post->post_type);
		return $type && isset($type->labels->singular_name) ? strtolower((string) $type->labels->singular_name) : 'post';
	}

	/** What the page said around the words, checked: a page builder's document and element ids. */
	private static function hints(array $body): array {
		$h = isset($body['hints']) && is_array($body['hints']) ? $body['hints'] : array();
		$out = array();
		foreach ($h as $name => $v) {
			if (!is_string($name) || !preg_match('/^[a-z][a-z0-9_-]{0,30}$/', $name) || !is_array($v)) continue;
			$docs = isset($v['documents']) && is_array($v['documents']) ? array_values(array_filter($v['documents'], function ($d) { return is_string($d) && preg_match('/^\d{1,20}$/', $d); })) : array();
			$element = isset($v['element']) && is_string($v['element']) && preg_match('/^[A-Za-z0-9_-]{1,40}$/', $v['element']) ? $v['element'] : null;
			$out[$name] = array('documents' => array_slice($docs, 0, 8), 'element' => $element);
		}
		return $out;
	}

	/** Every place in the post holding the words: a page builder's first, then the core search, then what plugins claim of it. */
	private static function places(WP_Post $post, string $want, array $hints, string $noun, string $after): array {
		$places = array();
		$skip_content = false;
		$skip_meta = array();
		$adapters = self::adapters();
		foreach ($adapters as $a) {
			try {
				$own = call_user_func(array($a, 'places'), $post, $want, $hints, $noun);
			} catch (Throwable $e) {
				continue;
			}
			if (!is_array($own)) continue;
			$places = array_merge($places, isset($own['places']) ? (array) $own['places'] : array());
			$skip_content = $skip_content || !empty($own['content']);
			$skip_meta = array_merge($skip_meta, isset($own['meta']) ? (array) $own['meta'] : array());
		}
		$core = array();
		if (!$skip_content) $core = array_merge($core, self::content_places($post, 'post_content', $want, $noun));
		$core = array_merge($core, self::content_places($post, 'post_excerpt', $want, $noun));
		$core = array_merge($core, self::meta_places($post, $want, $noun, $skip_meta));
		foreach ($adapters as $a) {
			try {
				$core = call_user_func(array($a, 'claim'), $core, $post, $noun, $after);
			} catch (Throwable $e) {
				continue;
			}
		}
		return array_merge($places, $core);
	}

	/**
	 * The one place showing the words, or why there is none: array('place', 'hit') or array('refusal' => [status,
	 * words, reason]). A page builder's hint (the element the page named around the words) settles two places only
	 * when exactly one is inside it.
	 */
	private static function pick(array $places, array $hints, string $noun, string $after): array {
		$shown = array();
		$code = array();
		foreach ($places as $pi => $p) {
			foreach ($p['hits'] as $hi => $h) {
				if (Wanigan_Live_Words_Match::shown($h)) $shown[] = array($pi, $hi);
				else $code[] = array($pi, $hi);
			}
		}
		if (count($shown) > 1) {
			$named = array();
			foreach ($shown as $s) {
				$h = $places[$s[0]]['hits'][$s[1]];
				foreach ($hints as $hint) {
					if (!empty($hint['element']) && isset($h['element']) && $h['element'] === $hint['element']) $named[] = $s;
				}
			}
			if (count($named) === 1) $shown = $named;
		}
		$label = function (array $s) use ($places): string {
			$h = $places[$s[0]]['hits'][$s[1]];
			return $places[$s[0]]['label'] . (isset($h['where']) ? $h['where'] : '');
		};
		if (count($shown) > 1) {
			$where = array_values(array_unique(array_map($label, $shown)));
			return array('refusal' => array(409, 'These words are kept more than once in this ' . $noun . ' (' . self::listed($where, count($shown)) . '), so Wanigan cannot tell which one the page shows, and saves none of them.', 'twice'));
		}
		if (!$shown && $code) {
			$what = array_values(array_unique(array_map(function ($s) use ($places) { return $places[$s[0]]['hits'][$s[1]]['why']; }, $code)));
			$where = array_values(array_unique(array_map($label, $code)));
			return array('refusal' => array(409, 'These words are kept here only inside ' . self::listed($what, count($what)) . ' (' . self::listed($where, count($where)) . '): code, not words the page shows, so Wanigan does not change them.', 'hidden'));
		}
		if (!$shown) return array('refusal' => array(404, 'The site does not keep these words in this content: code or another content item makes them. (Searched: this ' . $noun . '’s stored content, its excerpt and its custom fields.)', 'nowhere'));
		$place = $places[$shown[0][0]];
		$hit = $place['hits'][$shown[0][1]];
		if ($hit['stuck'] !== '') return array('refusal' => array(409, 'These words are kept in ' . $place['label'] . (isset($hit['where']) ? $hit['where'] : '') . ', but ' . $hit['stuck'] . '. Nothing is saved.', 'refused'));
		if ($hit['kind'] === 'sattr' && (strpbrk($after, '[]\\') !== false || ($hit['quote'] !== '' && strpos($after, $hit['quote']) !== false) || ($hit['quote'] === '' && preg_match('/\s|["\']/', $after)))) {
			return array('refusal' => array(409, 'These words are a shortcode’s setting (' . $place['label'] . $hit['where'] . '), and new words there cannot hold ' . ($hit['quote'] === '' ? 'spaces, quotes, ' : 'the quote around them, ') . '“[”, “]” or “\\”: WordPress would read the setting wrongly. Nothing is saved.', 'refused'));
		}
		return array('place' => $place, 'hit' => $hit);
	}

	/** Labels said as a list: "A and B", "A, B and C", and how many more past four. */
	private static function listed(array $labels, int $count): string {
		$shown = array_slice($labels, 0, 4);
		$more = max(0, $count - count($shown));
		if ($more) return implode(', ', $shown) . ' and ' . $more . ' more';
		if (count($shown) < 2) return (string) reset($shown);
		$last = array_pop($shown);
		return implode(', ', $shown) . ' and ' . $last;
	}

	/** The post's stored content (or excerpt): the words in its markup, a shortcode's settings, a block's settings. */
	private static function content_places(WP_Post $post, string $field, string $want, string $noun): array {
		$raw = (string) get_post_field($field, $post->ID, 'raw');
		if ($raw === '' || strlen($raw) > Wanigan_Live_Words_Match::MAX_STRING) return array();
		$label = 'this ' . $noun . ($field === 'post_content' ? '’s stored content' : '’s excerpt');
		$base = array('root' => $field, 'field' => $field, 'label' => $label, 'raw' => $raw, 'hash' => md5($raw), 'writer' => 'core', 'revisions' => function_exists('wp_revisions_enabled') && wp_revisions_enabled($post), 'site' => false, 'post' => $post->ID);
		$out = array();
		$hits = self::shortcoded($raw, Wanigan_Live_Words_Match::in_html($raw, $want));
		if ($hits) $out[] = $base + array('hits' => $hits);
		// Each block's settings, kept as JSON in its delimiter (block markup's own words are in the markup above).
		if (strpos($raw, '<!-- wp:') !== false && preg_match_all(self::DELIMITER, $raw, $m, PREG_SET_ORDER | PREG_OFFSET_CAPTURE)) {
			foreach ($m as $d) {
				if (!isset($d['attrs']) || $d['attrs'][1] < 0 || $d['attrs'][0] === '' || (isset($d['closer']) && $d['closer'][0] !== '')) continue;
				$json = rtrim($d['attrs'][0]);
				$attrs = json_decode($json, true);
				if (!is_array($attrs)) continue;
				$found = Wanigan_Live_Words_Match::in_value($attrs, $want, null, null);
				if (!$found) continue;
				$name = (isset($d['namespace']) && $d['namespace'][0] !== '' ? $d['namespace'][0] : 'core/') . $d['name'][0];
				$exact = function_exists('serialize_block_attributes') && serialize_block_attributes($attrs) === $json;
				foreach ($found as &$h) {
					$h['where'] = ', in the settings of its “' . $name . '” block';
					$h['block'] = $name;
					if (!$exact && $h['stuck'] === '') $h['stuck'] = 'that block’s settings are written in a way WordPress would write differently, so its other settings could change';
				}
				unset($h);
				$out[] = array_merge($base, array('root' => $field . ':block:' . $d['attrs'][1], 'hits' => $found, 'block' => array('at' => $d['attrs'][1], 'len' => strlen($json), 'attrs' => $attrs, 'name' => $name)));
			}
		}
		return $out;
	}

	/**
	 * Hits in stored content, with what registered shortcodes make of them: inside a shortcode's own brackets, a
	 * quoted setting's value ('sattr') or code; between its brackets, words it wraps.
	 */
	private static function shortcoded(string $raw, array $hits): array {
		$codes = self::shortcodes($raw, 0, 0);
		if (!$codes) return $hits;
		foreach ($hits as &$h) {
			foreach ($codes as $c) {
				$open = $c['open'];
				$inside = $h['start'] >= $open[0] && $h['end'] <= $open[1];
				$across = !$inside && $h['start'] < $open[1] && $h['end'] > $open[0];
				if ($inside) {
					$in = null;
					foreach ($c['attrs'] as $a) {
						if ($h['start'] >= $a['at'] && $h['end'] <= $a['at'] + $a['len']) $in = $a;
					}
					if ($in && $in['code'] === '') {
						$h['kind'] = 'sattr';
						$h['quote'] = $in['quote'];
						$h['name'] = $in['name'];
						$h['where'] = ', in ' . ($in['name'] !== '' ? 'the setting “' . $in['name'] . '”' : 'a setting') . ' of the shortcode [' . $c['tag'] . ']';
					}
					else {
						$h['kind'] = 'code';
						$h['why'] = $in ? $in['code'] : 'a shortcode’s name';
						$h['where'] = ', in the shortcode [' . $c['tag'] . ']';
					}
					break;
				}
				if ($across) {
					$h['kind'] = 'code';
					$h['why'] = 'a shortcode';
					$h['where'] = ', across the shortcode [' . $c['tag'] . ']';
					break;
				}
				if ($c['inner'] && $h['start'] >= $c['inner'][0] && $h['end'] <= $c['inner'][1]) $h['where'] = ', inside the shortcode [' . $c['tag'] . ']';
			}
		}
		unset($h);
		return $hits;
	}

	/**
	 * Registered shortcodes in a text, outermost first (core's get_shortcode_regex(), the pattern do_shortcode() uses;
	 * an escaped [[tag]] shows as written and is not one): each with its own brackets' span, its settings' values
	 * (get_shortcode_atts_regex(), as shortcode_parse_atts() reads them) and the span of the words it wraps.
	 */
	private static function shortcodes(string $text, int $offset, int $depth): array {
		global $shortcode_tags;
		if ($depth > 8 || empty($shortcode_tags) || !function_exists('get_shortcode_regex') || strpos($text, '[') === false) return array();
		if (!preg_match_all('/' . get_shortcode_regex() . '/s', $text, $m, PREG_SET_ORDER | PREG_OFFSET_CAPTURE)) return array();
		$out = array();
		foreach ($m as $s) {
			if (isset($s[1], $s[6]) && $s[1][0] === '[' && $s[6][0] === ']') continue;
			$attrs_at = $s[3][1];
			$close = strpos($text, ']', $attrs_at + strlen($s[3][0]));
			if ($close === false) continue;
			$inner = isset($s[5]) && $s[5][1] >= 0 && $s[5][0] !== '' ? array($offset + $s[5][1], $offset + $s[5][1] + strlen($s[5][0])) : null;
			$attrs = array();
			if ($s[3][0] !== '' && function_exists('get_shortcode_atts_regex') && preg_match_all(get_shortcode_atts_regex(), $s[3][0], $am, PREG_SET_ORDER | PREG_OFFSET_CAPTURE)) {
				foreach ($am as $a) {
					// The pattern's alternatives: name="value", name='value', name=value, then "value", 'value' and value alone.
					foreach (array(array(1, 2, '"'), array(3, 4, "'"), array(5, 6, ''), array(0, 7, '"'), array(0, 8, "'"), array(0, 9, '')) as $g) {
						if (!isset($a[$g[1]]) || $a[$g[1]][1] < 0) continue;
						if ($g[0] && (!isset($a[$g[0]]) || $a[$g[0]][1] < 0)) continue;
						$name = $g[0] ? (string) $a[$g[0]][0] : '';
						$value = (string) $a[$g[1]][0];
						$code = Wanigan_Live_Words_Match::code_key($name);
						if ($code === '' && preg_match('~^(?:href|src|class|id|style|on[a-z]+)$~i', $name)) $code = $name === 'class' ? 'a class' : ($name === 'style' ? 'a style' : ($name === 'id' ? 'a name the site’s code uses' : (stripos($name, 'on') === 0 ? 'a script' : 'an address')));
						if ($code === '' && preg_match(Wanigan_Live_Words_Match::ADDRESS, trim($value))) $code = 'an address';
						$attrs[] = array('name' => $name, 'at' => $offset + $attrs_at + $a[$g[1]][1], 'len' => strlen($value), 'quote' => $g[2], 'code' => $code);
						break;
					}
				}
			}
			$out[] = array('tag' => $s[2][0], 'open' => array($offset + $s[0][1], $offset + $close + 1), 'inner' => $inner, 'attrs' => $attrs);
			if ($inner) $out = array_merge($out, self::shortcodes($s[5][0], $offset + $s[5][1], $depth + 1));
		}
		return $out;
	}

	/** A custom field's stored value as a string, or what a serialized one holds; null for a string that is not serialized. */
	public static function unserialize(string $s) {
		return is_serialized($s) ? maybe_unserialize($s) : null;
	}

	/** Every custom field of the post holding the words (has_meta(): each row, by its meta_id, its value as stored). */
	private static function meta_places(WP_Post $post, string $want, string $noun, array $skip): array {
		$rows = self::meta_rows($post->ID);
		$kept = function_exists('wp_post_revision_meta_keys') ? (array) wp_post_revision_meta_keys($post->post_type) : array();
		$out = array();
		foreach (array_slice($rows, 0, self::MAX_META) as $row) {
			$key = (string) $row['meta_key'];
			$raw = $row['meta_value'];
			if (!is_string($raw) || $raw === '' || in_array($key, self::OWN, true) || strpos($key, '_wanigan') === 0) continue;
			foreach ($skip as $prefix) {
				if ($prefix !== '' && strpos($key, $prefix) === 0) continue 2;
			}
			$hits = Wanigan_Live_Words_Match::in_value($raw, $want, $key, array(self::class, 'unserialize'));
			if (!$hits) continue;
			$form = $hits[0]['steps'] ? ($hits[0]['steps'][0][0] === 'j' ? ' (in its JSON)' : ($hits[0]['steps'][0][0] === 's' ? ' (in its saved list)' : '')) : '';
			$out[] = array('root' => 'meta:' . (int) $row['meta_id'], 'mid' => (int) $row['meta_id'], 'key' => $key, 'label' => 'this ' . $noun . '’s custom field “' . $key . '”' . $form, 'raw' => $raw, 'hash' => md5($raw), 'hits' => $hits, 'writer' => 'core', 'revisions' => in_array($key, $kept, true), 'site' => false, 'post' => $post->ID);
		}
		return $out;
	}

	/** A post's custom fields as stored (wp-admin/includes/post.php has_meta(): key, value, meta_id), read only. */
	public static function meta_rows(int $pid): array {
		if (!function_exists('has_meta')) require_once ABSPATH . 'wp-admin/includes/post.php';
		$rows = has_meta($pid);
		return is_array($rows) ? $rows : array();
	}

	/** One custom field's value as stored, by its meta_id; null when the row is gone. */
	public static function meta_raw(int $pid, int $mid): ?string {
		foreach (self::meta_rows($pid) as $row) {
			if ((int) $row['meta_id'] === $mid) return (string) $row['meta_value'];
		}
		return null;
	}

	/** wp_slash() through arrays and objects alike (map_deep()): update_metadata_by_mid() unslashes both. */
	public static function slash_deep($value) {
		return map_deep($value, function ($v) { return is_string($v) ? addslashes($v) : $v; });
	}

	/** The value at a place with the words in its hit made the new ones: the stored string, or what a serialized one holds. */
	public static function changed(array $place, array $hit, string $after) {
		$insert = Wanigan_Live_Words_Match::insert($hit, $after);
		$steps = $hit['steps'];
		if ($steps && $steps[0][0] === 's') return Wanigan_Live_Words_Match::put(maybe_unserialize($place['raw']), array_slice($steps, 1), $hit['start'], $hit['end'], $insert, array(self::class, 'unserialize'));
		return Wanigan_Live_Words_Match::put($place['raw'], $steps, $hit['start'], $hit['end'], $insert, array(self::class, 'unserialize'));
	}

	/** The latest revision of a post when a save made a new one, else null. */
	private static function new_revision(int $pid, ?int $before): ?int {
		$after = Wanigan_Live::revision_of($pid);
		return $after && $after !== $before ? $after : null;
	}

	/** Saves one place through core: the post's content or excerpt with wp_update_post(), a custom field with update_metadata_by_mid(). */
	private static function write(array $place, array $hit, string $after, WP_Post $post, string $noun) {
		if (isset($place['field'])) {
			$field = $place['field'];
			$raw = $place['raw'];
			if (isset($place['block'])) {
				$attrs = Wanigan_Live_Words_Match::put($place['block']['attrs'], $hit['steps'], $hit['start'], $hit['end'], Wanigan_Live_Words_Match::insert($hit, $after), null);
				$new = substr($raw, 0, $place['block']['at']) . serialize_block_attributes($attrs) . substr($raw, $place['block']['at'] + $place['block']['len']);
			}
			else {
				$new = Wanigan_Live_Words_Match::put($raw, $hit['steps'], $hit['start'], $hit['end'], Wanigan_Live_Words_Match::insert($hit, $after), null);
			}
			return self::write_post_field($post, $field, $raw, $new, $noun);
		}
		$value = self::changed($place, $hit, $after);
		// What WordPress would store: a sanitize callback registered for the field must leave the rest as it is.
		if (sanitize_meta($place['key'], $value, 'post', $post->post_type) !== $value) return new WP_Error('wanigan', 'WordPress would change more of the custom field “' . $place['key'] . '” than these words when it saves it (a sanitize callback registered for it), so nothing is saved.');
		$write = is_string($value) ? wp_slash($value) : self::slash_deep($value);
		if (!update_metadata_by_mid('post', $place['mid'], $write)) return new WP_Error('wanigan', 'WordPress did not save the custom field “' . $place['key'] . '”.');
		$now = self::meta_raw($post->ID, $place['mid']);
		return array('revision' => null, 'undo' => array('type' => 'stored', 'writer' => 'core', 'post' => $post->ID, 'mid' => $place['mid'], 'key' => $place['key'], 'before' => $place['raw'], 'after' => md5((string) $now)));
	}

	/**
	 * A post's content or excerpt saved with wp_update_post(), as the editor's own save ends: a revision where the post
	 * type keeps them. Only when core's filters on saving it (sanitize_post_field() in the db context: kses for a user
	 * who may not post unfiltered HTML, and any plugin's) would store exactly these bytes.
	 */
	public static function write_post_field(WP_Post $post, string $field, string $raw, string $new, string $noun) {
		$filtered = wp_unslash(sanitize_post_field($field, wp_slash($new), $post->ID, 'db'));
		if ($filtered !== $new) return new WP_Error('wanigan', 'WordPress would change more of this ' . $noun . ' than these words when it saves it (its filters on saving content: kses, for a user who may not post unfiltered HTML, or a plugin’s), so nothing is saved.');
		$before = Wanigan_Live::revision_of($post->ID);
		$saved = wp_update_post(array('ID' => $post->ID, $field => wp_slash($new)), true);
		if (is_wp_error($saved)) return $saved;
		$now = (string) get_post_field($field, $post->ID, 'raw');
		return array('revision' => self::new_revision($post->ID, $before), 'undo' => array('type' => 'stored', 'writer' => 'core', 'post' => $post->ID, 'field' => $field, 'before' => $raw, 'after' => md5($now)));
	}

	/** POST /_wanigan/undo of a stored-words save: the old value put back, only while the value is what the save wrote. */
	public static function undo(array $u) {
		$writer = isset($u['writer']) ? (string) $u['writer'] : 'core';
		if ($writer !== 'core') {
			if (!in_array($writer, self::$adapters, true)) return new WP_Error('wanigan', 'That cannot be undone here: the plugin that saved it is not loaded.');
			return call_user_func(array($writer, 'undo'), $u);
		}
		$post = get_post((int) $u['post']);
		if (!$post instanceof WP_Post) return new WP_Error('wanigan', 'That content is gone.');
		$noun = self::noun($post);
		$why = Wanigan_Live::post_refusal($post, $noun);
		if ($why) return new WP_Error('wanigan', $why);
		if (isset($u['field'])) {
			$now = (string) get_post_field($u['field'], $post->ID, 'raw');
			if (md5($now) !== $u['after']) return new WP_Error('wanigan', 'It changed again since, so putting it back could undo other work.');
			$before = Wanigan_Live::revision_of($post->ID);
			$saved = wp_update_post(array('ID' => $post->ID, $u['field'] => wp_slash($u['before'])), true);
			if (is_wp_error($saved)) return $saved;
			return array('revision' => self::new_revision($post->ID, $before));
		}
		$now = self::meta_raw($post->ID, (int) $u['mid']);
		if ($now === null || md5($now) !== $u['after']) return new WP_Error('wanigan', 'It changed again since, so putting it back could undo other work.');
		$old = self::unserialize((string) $u['before']);
		update_metadata_by_mid('post', (int) $u['mid'], $old !== null ? self::slash_deep($old) : wp_slash((string) $u['before']));
		if (self::meta_raw($post->ID, (int) $u['mid']) !== (string) $u['before']) return new WP_Error('wanigan', 'WordPress put the custom field “' . $u['key'] . '” back, but not byte for byte as it was.');
		return array('revision' => null);
	}
}
`;

/** The stored-words source the plugin carries: the shared matcher, the core search and save, and the adapter seam. */
export const WORDPRESS_WORDS_SOURCE = WORDPRESS_WORDS_MATCH + SOURCE;
