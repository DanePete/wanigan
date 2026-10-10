// The WordPress helper's ACF adapter for stored words (helper version 4): one Wanigan_Live_Words_Adapter
// (live-helper-wordpress-words.ts), used only when Advanced Custom Fields is loaded, and never needed by the core
// search. PHP source appended to the must-use plugin, PHP 7.4 syntax.
//
// Read from ACF 6.8.10's own source (the free version, GPL, from wordpress.org; not kept here):
// - A field's value is a custom field named for it, beside a reference field `_<name>` holding the field's key
//   (acf_get_reference(), src/Meta/MetaLocation.php get_reference()). A sub field of a group, a repeater row or a
//   flexible content layout is its own row named `<parent>_<row>_<name>` with its own reference: so the core search
//   finds the exact row, and the reference says which field it is.
// - ACF saves a value with acf_update_value($value, $post_id, $field) (includes/acf-value-functions.php): the
//   acf/update_value filters, the value and its reference written by the field's meta location, ACF's own value cache
//   flushed. The location writes with update_metadata() (posts) or update_option() after wp_unslash() (options), so
//   the value goes in slashed. A sub field is saved the same way, its field's name set to its row's full name, as
//   ACF's own repeater saves each row.
// - acf_validate_value() (includes/validation.php) runs the field's own checks (required, a text field's maxlength,
//   …) and says why not through acf_get_validation_errors().
// - Options are options named `options_<name>`, with `_options_<name>` references (src/Meta/Option.php,
//   acf_get_option_meta()): one value every page that prints it shows, so it is said first and saved only when the
//   owner says so, and only by a user who may manage the site's options.
// Not readable here, from ACF PRO, and so built on ACF's public documentation of the stored format and then checked
// against the free code's storage functions above: repeater and flexible content rows (`<name>_<row>_<sub>` with
// references), and ACF blocks, whose values live in the block's `data` attribute in the post's content, each with a
// `_<name>` reference (a block's data is written into its settings as the core search writes any block's settings,
// after ACF's own validation). ACF PRO's own save path is not exercised; check it on a site with ACF PRO.
//
// Field types: text, textarea, wysiwyg (formatted text: one run of words inside the markup is changed, every other
// byte kept) and link (its title) are saved through ACF; a field whose value is a choice, a number, a date, an
// address, a file or a reference is refused, saying so; any other type (another plugin's) is left to the core save.

const SOURCE = String.raw`
/**
 * ACF's fields, options and blocks: the core search's places that are ACF's saved through ACF (Wanigan's
 * src/core/live-helper-wordpress-acf.ts says what was read where).
 */
final class Wanigan_Live_Acf implements Wanigan_Live_Words_Adapter {
	/** Field types whose value is words, saved through ACF. */
	const WORDS = array('text', 'textarea', 'wysiwyg', 'link');
	/** Field types whose value is a choice, a number, a date, an address, a file or a reference, which are never words to save into. */
	const NOT_WORDS = array('select', 'checkbox', 'radio', 'button_group', 'true_false', 'number', 'range', 'email', 'url', 'password', 'date_picker', 'date_time_picker', 'time_picker', 'color_picker', 'image', 'file', 'gallery', 'post_object', 'page_link', 'relationship', 'taxonomy', 'user', 'google_map', 'oembed', 'icon_picker');

	public static function active(): bool {
		return function_exists('acf_get_reference') && function_exists('acf_get_field') && function_exists('acf_update_value');
	}

	public static function name(): string {
		return 'ACF';
	}

	public static function places(WP_Post $post, string $want, array $hints, string $noun): ?array {
		return null;
	}

	/** The ACF field a stored value is, by its name and where it is stored (a post's ID, or 'options'); null when it is not ACF's. */
	private static function field(string $name, $where): ?array {
		$ref = acf_get_reference($name, $where);
		if (!is_string($ref) || strpos($ref, 'field_') !== 0) return null;
		$field = acf_get_field($ref);
		return is_array($field) && !empty($field['type']) ? $field : null;
	}

	/** A field as the owner reads it: “Name”, and the row of the field it is in, when it is in one. */
	private static function label(array $field, string $name): string {
		$out = '“' . (isset($field['label']) && $field['label'] !== '' ? $field['label'] : $field['name']) . '”';
		$parent = !empty($field['parent']) && is_string($field['parent']) && strpos($field['parent'], 'field_') === 0 ? acf_get_field($field['parent']) : null;
		if (is_array($parent)) {
			$row = preg_match('/_(\d+)_' . preg_quote((string) $field['name'], '/') . '$/', $name, $m) ? 'row ' . ((int) $m[1] + 1) . ' of' : 'in';
			$out .= ' (' . $row . ' “' . (isset($parent['label']) ? $parent['label'] : $parent['name']) . '”)';
		}
		return $out;
	}

	/** Why ACF would not save a value for a field, or null (acf_validate_value() and the errors it records). */
	private static function invalid($value, array $field): ?string {
		if (!function_exists('acf_validate_value')) return null;
		if (acf_validate_value($value, $field, 'acf[' . $field['key'] . ']')) return null;
		$errors = function_exists('acf_get_validation_errors') ? (array) acf_get_validation_errors() : array();
		if (function_exists('acf_reset_validation_errors')) acf_reset_validation_errors();
		$said = array();
		foreach ($errors as $e) {
			if (is_array($e) && isset($e['message'])) $said[] = wp_strip_all_tags((string) $e['message']);
		}
		return 'ACF would not save it' . ($said ? ': ' . implode(' ', array_slice($said, 0, 2)) : '') . '.';
	}

	/** A place the core search found, made ACF's: its label, and either its writer or why its words are not saved. */
	private static function claimed(array $p, array $field, string $name, $where, string $label, string $after): array {
		$p['label'] = $label;
		$type = (string) $field['type'];
		if (in_array($type, self::NOT_WORDS, true)) {
			foreach ($p['hits'] as &$h) {
				if ($h['stuck'] === '') $h['stuck'] = 'it is an ACF ' . str_replace('_', ' ', $type) . ' field, whose value is a choice or a setting, not words: change it in the editor';
			}
			unset($h);
			return $p;
		}
		if (!in_array($type, self::WORDS, true)) {
			// Another plugin's field type: ACF's own save cannot be counted on for it, and an option is never written without it.
			if ($where === 'options') {
				foreach ($p['hits'] as &$h) {
					if ($h['stuck'] === '') $h['stuck'] = 'it is an ACF field of a type Wanigan does not save through ACF (' . $type . '), and the site’s options are saved here only through ACF';
				}
				unset($h);
			}
			return $p;
		}
		$p['writer'] = self::class;
		$p['acf'] = array('field' => $field, 'name' => $name, 'where' => $where);
		$p['cache'] = 'Saved through ACF’s own acf_update_value(), which clears ACF’s own copy of the value; a plugin or theme that shows it from a cache of its own can show the old words until that is made again.';
		// What ACF would make of the new value, asked before anything is saved.
		foreach ($p['hits'] as &$h) {
			if ($h['stuck'] !== '' || !Wanigan_Live_Words_Match::shown($h)) continue;
			$why = self::invalid(Wanigan_Live_Stored::changed($p, $h, $after), $field);
			if ($why !== null) $h['stuck'] = rtrim($why, '.');
		}
		unset($h);
		return $p;
	}

	public static function claim(array $places, WP_Post $post, string $noun, string $after): array {
		foreach ($places as $i => $p) {
			if (isset($p['key'], $p['mid'])) {
				$field = self::field((string) $p['key'], $post->ID);
				if ($field) $places[$i] = self::claimed($p, $field, (string) $p['key'], $post->ID, 'this ' . $noun . '’s ACF field ' . self::label($field, (string) $p['key']), $after);
				continue;
			}
			if (!isset($p['block']['name'], $p['block']['attrs']['data']) || !is_array($p['block']['attrs']['data'])) continue;
			// An ACF block: its values in its "data" setting, each with its field's key under "_<name>".
			$data = $p['block']['attrs']['data'];
			foreach ($p['hits'] as $j => $h) {
				if (!isset($h['steps'][0], $h['steps'][1]) || $h['steps'][0] !== array('k', 'data') || !is_string($h['steps'][1][1])) continue;
				$name = $h['steps'][1][1];
				$ref = isset($data['_' . $name]) && is_string($data['_' . $name]) ? $data['_' . $name] : (strpos($name, 'field_') === 0 ? $name : null);
				$field = $ref ? acf_get_field($ref) : null;
				if (!is_array($field) || empty($field['type'])) continue;
				$h['where'] = ', in its ACF block “' . $p['block']['name'] . '”, the field ' . self::label($field, $name);
				if (in_array((string) $field['type'], self::NOT_WORDS, true)) {
					$h['stuck'] = 'it is an ACF ' . str_replace('_', ' ', (string) $field['type']) . ' field, whose value is a choice or a setting, not words: change it in the editor';
				}
				elseif ($h['stuck'] === '') {
					$value = Wanigan_Live_Words_Match::put($data[$name], array_slice($h['steps'], 2), $h['start'], $h['end'], Wanigan_Live_Words_Match::insert($h, $after), null);
					$why = self::invalid($value, $field);
					if ($why !== null) $h['stuck'] = rtrim($why, '.');
				}
				$places[$i]['hits'][$j] = $h;
			}
		}
		return $places;
	}

	/** ACF's options ("options_<name>", as acf_get_option_meta() reads them), searched when the post holds the words nowhere. */
	public static function site_places(string $want, string $after): array {
		if (!function_exists('acf_get_option_meta')) return array();
		$out = array();
		foreach ((array) acf_get_option_meta('options') as $name => $values) {
			$raw = is_array($values) && isset($values[0]) ? $values[0] : null;
			if (!is_string($name) || $name === '' || $name[0] === '_' || !is_string($raw) || $raw === '') continue;
			$hits = Wanigan_Live_Words_Match::in_value($raw, $want, $name, array('Wanigan_Live_Stored', 'unserialize'));
			if (!$hits) continue;
			$field = self::field($name, 'options');
			if (!$field) continue;
			$label = 'the site’s ACF option ' . self::label($field, $name);
			$place = array('root' => 'acf-option:' . $name, 'label' => $label, 'raw' => $raw, 'hash' => md5($raw), 'hits' => $hits, 'writer' => 'core', 'revisions' => false, 'site' => true, 'post' => 0);
			$place = self::claimed($place, $field, $name, 'options', $label, $after);
			if ($place['writer'] === 'core') {
				foreach ($place['hits'] as &$h) {
					if ($h['stuck'] === '') $h['stuck'] = 'the site’s options are saved here only through ACF';
				}
				unset($h);
			}
			$out[] = $place;
		}
		return $out;
	}

	/** A value as stored: a post's custom field by its meta_id, or an ACF option. */
	private static function stored($where, ?int $mid, string $name, int $pid): ?string {
		if ($where === 'options') {
			$all = function_exists('acf_get_option_meta') ? (array) acf_get_option_meta('options') : array();
			return isset($all[$name][0]) && is_string($all[$name][0]) ? $all[$name][0] : null;
		}
		return $mid ? Wanigan_Live_Stored::meta_raw($pid, $mid) : null;
	}

	public static function write(array $place, array $hit, string $after, WP_Post $post) {
		$a = $place['acf'];
		$field = $a['field'];
		$field['name'] = $a['name'];
		$where = $a['where'];
		if ($where === 'options' && !current_user_can('manage_options')) return new WP_Error('wanigan', 'Your WordPress user cannot change the site’s options (manage_options).', array('status' => 403));
		$value = Wanigan_Live_Stored::changed($place, $hit, $after);
		$why = self::invalid($value, $field);
		if ($why !== null) return new WP_Error('wanigan', $why, array('status' => 422));
		// ACF's meta locations unslash what they are given, as WordPress's own writes do.
		acf_update_value(is_string($value) ? wp_slash($value) : Wanigan_Live_Stored::slash_deep($value), $where, $field);
		if ($where !== 'options') clean_post_cache($post->ID);
		$mid = isset($place['mid']) ? (int) $place['mid'] : null;
		$now = self::stored($where, $mid, $a['name'], $post->ID);
		return array('revision' => null, 'undo' => array('type' => 'stored', 'writer' => self::class, 'where' => $where === 'options' ? 'options' : 'post', 'post' => $post->ID, 'mid' => $mid, 'name' => $a['name'], 'key' => (string) $field['key'], 'before' => $place['raw'], 'after' => md5((string) $now)));
	}

	public static function undo(array $u) {
		$field = acf_get_field((string) $u['key']);
		if (!is_array($field)) return new WP_Error('wanigan', 'ACF no longer has that field, so it is not put back.');
		$field['name'] = (string) $u['name'];
		$where = $u['where'] === 'options' ? 'options' : (int) $u['post'];
		if ($where === 'options' && !current_user_can('manage_options')) return new WP_Error('wanigan', 'Your WordPress user cannot change the site’s options (manage_options).');
		if ($where !== 'options') {
			$post = get_post((int) $u['post']);
			if (!$post instanceof WP_Post) return new WP_Error('wanigan', 'That content is gone.');
			$why = Wanigan_Live::post_refusal($post, Wanigan_Live_Stored::noun($post));
			if ($why) return new WP_Error('wanigan', $why);
		}
		$now = self::stored($where, isset($u['mid']) ? (int) $u['mid'] : null, (string) $u['name'], (int) $u['post']);
		if ($now === null || md5($now) !== $u['after']) return new WP_Error('wanigan', 'It changed again since, so putting it back could undo other work.');
		$old = Wanigan_Live_Stored::unserialize((string) $u['before']);
		acf_update_value($old !== null ? Wanigan_Live_Stored::slash_deep($old) : wp_slash((string) $u['before']), $where, $field);
		if ($where !== 'options') clean_post_cache((int) $u['post']);
		return array('revision' => null);
	}
}
Wanigan_Live_Stored::adapt('Wanigan_Live_Acf');
`;

export const WORDPRESS_ACF_SOURCE = SOURCE;
