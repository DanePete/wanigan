// Words a WordPress template file writes (helper version 4), appended to the plugin's source after the stored-words
// matcher it reads with (live-helper-wordpress.ts). PHP source, PHP 7.4 syntax like the rest of the plugin, and no
// backtick or dollar-brace in it (this is a template literal).
//
// The WordPress twin of the Drupal helper's TemplateWords (live-helper-drupal-words.ts). A classic theme writes most
// of the words an owner retypes into its PHP template files: typed into the file's HTML (a "Skip to content" link, a
// footer's "Proudly made by"), or printed through a translation function (`esc_html_e( 'Search', 'acme' )`). WordPress
// keeps no stored copy of either, so nothing the page offers to edit holds them, and without this the design layer
// could only say so. For each template file the page loaded (load_template()'s, and the page template the hierarchy
// chose), the plugin lists both, read from the file with PHP's own tokenizer (nothing is included or run):
//
// - `words.tpl.<hash>`: the runs of words between the file's tags and between what its PHP prints. PHP the file runs
//   is a wall no run of words goes across, and what it computes is never guessed at.
// - `words.t.<hash>`, one per text domain: the literal first argument of l10n.php's gettext functions (__(), _e(),
//   esc_html__(), esc_html_e(), esc_attr__(), esc_attr_e(), _x(), _ex(), esc_html_x(), esc_attr_x(), _n(), _nx()),
//   with its text domain. A string built from anything but one literal is left out.
//
// Each is a read-only `template-override` target with a `why` saying why it is not saved here and what is (its file,
// and for a parent theme's file under an active child theme, that the change belongs in a copy in the child theme),
// and each of its words says its line. The design layer finds an element's words there when nothing that saves holds
// them (src/main/live-layer.ts writtenIn()). Bounded: 200 files a page, 256 KB a file, 100 runs and 100 strings a
// file and domain, 2,000 characters a run; a file not read says why. Read at the end of the page, from the file,
// never the database.

export const WORDPRESS_TEMPLATE_WORDS_SOURCE = String.raw`
// ── Words a theme's template file writes. See Wanigan's src/core/live-helper-wordpress-template-words.ts.

final class Wanigan_Live_Template_Words {
	/** Bytes of one template file read; a larger one is not read, and says so. */
	const MAX_FILE = 262144;
	/** Template files read for one page. */
	const MAX_FILES = 200;
	/** Runs of words, and strings, offered for one file, and for one of its text domains. */
	const MAX_WORDS = 100;
	/** Text domains offered for one file. */
	const MAX_DOMAINS = 20;
	/** The longest words offered. */
	const MAX_LENGTH = 2000;
	/** Lines named for the same words. */
	const MAX_LINES = 5;
	/** Characters of a why, as the trace keeps it. */
	const MAX_WHY = 500;
	/** Tokens read for one call's arguments. */
	const MAX_CALL = 400;
	/** Where the file's PHP runs: whatever it prints or decides there, no run of words goes across it. */
	const PRINTED = "\u{E000}";
	/**
	 * A comment, a declaration, or a tag up to the next ">": looser than the stored-words matcher's, since PHP inside a
	 * tag (an attribute it prints, a class list) leaves no space before it here.
	 */
	const TAG = '~<!--.*?-->|<![^>]*>|</?[A-Za-z][^<>]*>~s';
	/** l10n.php's gettext functions, and where each takes its text domain among its arguments, from 0. */
	const GETTEXT = array('__' => 1, '_e' => 1, 'esc_html__' => 1, 'esc_html_e' => 1, 'esc_attr__' => 1, 'esc_attr_e' => 1, '_x' => 2, '_ex' => 2, 'esc_html_x' => 2, 'esc_attr_x' => 2, '_n' => 3, '_nx' => 4);

	/** @var array<string,array|string> Each file read this request, by its path: what it writes, or why it was not read. */
	private static $read = array();

	/**
	 * A template file's words, read once a request: array('written' => words => lines, 'translated' => domain =>
	 * words => array('lines' => lines, 'function' => name)), or why it was not read. The domain is '' where the code
	 * works it out.
	 */
	public static function read(string $file) {
		$file = wp_normalize_path($file);
		if (array_key_exists($file, self::$read)) return self::$read[$file];
		if (count(self::$read) >= self::MAX_FILES) return 'the page loaded more than ' . self::MAX_FILES . ' template files, and the helper reads that many';
		try {
			$read = self::scan($file);
		} catch (Throwable $e) {
			$read = 'it could not be read';
		}
		return self::$read[$file] = $read;
	}

	/** What read() found, in a few words: what the template part's template.words variable says. */
	public static function summary(array $read): string {
		$strings = 0;
		foreach ($read['translated'] as $s) $strings += count($s);
		return 'read: ' . count($read['written']) . ' run' . (count($read['written']) === 1 ? '' : 's') . ' of words, ' . $strings . ' translated string' . ($strings === 1 ? '' : 's');
	}

	/**
	 * The targets for one template file the page loaded: words.tpl.<hash> for the words written in it, one
	 * words.t.<hash> per text domain for the strings it prints through a translation function. $about says whose file
	 * it is (Wanigan_Live::template_about()). None for a file not read.
	 */
	public static function targets(string $file, array $about): array {
		$read = self::read($file);
		if (!is_array($read)) return array();
		$shown = (string) $about['shown'];
		$base = basename($shown);
		$out = array();
		if ($read['written']) {
			$out[] = self::target('words.tpl.' . substr(md5($shown), 0, 12), 'Words written in ' . $base, $read['written'], self::fit('written_why', $about, ''), false);
		}
		foreach ($read['translated'] as $domain => $strings) {
			$domain = (string) $domain;
			$label = 'Words ' . $base . ' translates' . ($domain !== '' ? ' (' . $domain . ')' : '');
			$out[] = self::target('words.t.' . substr(md5($shown . "\n" . $domain), 0, 12), $label, $strings, self::fit('translated_why', $about, $domain), true);
		}
		return $out;
	}

	/**
	 * A why within the 500 characters the trace keeps of one (parseTrace() in src/shared/live-trace.ts): with the
	 * files' paths, or, when those make it longer, their names.
	 */
	private static function fit(string $say, array $about, string $domain): string {
		$why = (string) call_user_func(array(self::class, $say), $about, $domain);
		if (self::chars($why) <= self::MAX_WHY) return $why;
		$about['shown'] = basename((string) $about['shown']);
		if (isset($about['copy'])) $about['copy'] = null;
		$why = (string) call_user_func(array(self::class, $say), $about, $domain);
		return self::chars($why) <= self::MAX_WHY ? $why : mb_substr($why, 0, self::MAX_WHY - 1, 'UTF-8') . '…';
	}

	private static function chars(string $s): int {
		return function_exists('mb_strlen') ? mb_strlen($s, 'UTF-8') : strlen($s);
	}

	private static function target(string $id, string $label, array $words, string $why, bool $translated): array {
		$properties = array();
		$value = array();
		$i = 0;
		foreach ($words as $w => $at) {
			$i++;
			$lines = $translated ? $at['lines'] : $at;
			$where = (count($lines) > 1 ? 'They are on lines ' . self::listed($lines) : 'They are on line ' . $lines[0]) . ($translated ? ', printed through ' . $at['function'] . '()' : '') . '.';
			$properties['w' . $i] = array('type' => 'string', 'title' => 'Words ' . $i, 'description' => $where, 'readOnly' => true);
			$value['w' . $i] = (string) $w;
		}
		return array('id' => $id, 'kind' => 'template-override', 'label' => $label, 'via' => 'schema', 'revisions' => false, 'schema' => array('type' => 'object', 'properties' => $properties), 'value' => $value, 'why' => $why);
	}

	/** "12", "12 and 30", "12, 30 and 41". */
	private static function listed(array $lines): string {
		$last = array_pop($lines);
		return $lines ? implode(', ', $lines) . ' and ' . $last : (string) $last;
	}

	/** Why words written in the file are not saved here, and where they change: by whose file it is. */
	public static function written_why(array $about, string $domain = ''): string {
		$shown = $about['shown'];
		$role = isset($about['role']) ? $about['role'] : null;
		if ($role === 'parent') {
			$to = !empty($about['copy']) ? 'copy the file to ' . $about['copy'] : 'copy the file to the same path there';
			$why = 'These words are written in ' . $shown . ', a template of the parent theme “' . $about['theme'] . '”: code, so WordPress keeps no copy of them to change, and a parent theme update would overwrite an edit there. The change belongs in the active child theme, “' . $about['child'] . '”: ' . $to . ', which WordPress then uses instead, and change the copy. An agent can do both from a brief.';
			if (empty($about['looked_up'])) $why .= ' It was loaded by its path, so what loads it must load the copy too.';
			return $why;
		}
		if ($role === 'theme' || $role === 'child') {
			$why = 'These words are written in ' . $shown . ', a template of the ' . ($role === 'child' ? 'active child theme' : 'theme') . ' “' . $about['theme'] . '”: code, so WordPress keeps no copy of them to change. An agent can change the template from a brief.';
			if (!empty($about['outside'])) $why .= ' The theme is updated from outside this project, which would overwrite that: the brief is to make a child theme first and change a copy of the file there.';
			return $why;
		}
		return 'These words are written in ' . $shown . ', ' . self::not_theme($about) . '.';
	}

	/** Why strings the file prints through a translation function are not saved here, and the two ways they change. */
	public static function translated_why(array $about, string $domain): string {
		$shown = $about['shown'];
		$role = isset($about['role']) ? $about['role'] : null;
		$in = $domain === '' ? 'in a text domain its code works out' : 'in the text domain “' . $domain . '”';
		$why = 'These words are printed by ' . $shown . ' through a WordPress translation function, ' . $in . '. A translation file for that text domain (.po and .mo, or .l10n.php) changes them without code; changing the string in the template is a code change, after which its translations no longer match it.';
		if ($role === 'parent') return $why . ' The template is the parent theme’s, so a code change belongs in a copy of it at the same path in the child theme “' . $about['child'] . '”. An agent can make either from a brief.';
		if ($role === 'theme' || $role === 'child') return $why . ' An agent can make either from a brief.';
		return $why . ' The template is ' . self::not_theme($about) . '.';
	}

	/** A template file outside the active theme and its parent, said by whose it is. */
	private static function not_theme(array $about): string {
		$kind = isset($about['kind']) ? $about['kind'] : 'unknown';
		$package = isset($about['package']) && $about['package'] !== '' ? $about['package'] : '';
		if ($kind === 'plugin' || $kind === 'mu-plugin') {
			$noun = ($kind === 'mu-plugin' ? 'the must-use plugin' : 'the plugin') . ($package !== '' ? ' “' . $package . '”' : '');
			return !empty($about['yours'])
				? 'a template of ' . $noun . ', which this project keeps itself: they change in its source'
				: 'a template of ' . $noun . ': the plugin’s code, which its updates overwrite, so Wanigan does not change it. Where the plugin lets a theme override its templates, a copy in the theme is where they change';
		}
		if ($kind === 'core') return 'WordPress core’s fallback template, which a core update replaces: copy it into the active theme, where WordPress looks first, and change the copy';
		return 'a template outside the active theme, which Wanigan does not change';
	}

	/* ── reading a file ─────────────────────────────────────────────────── */

	private static function scan(string $file) {
		if (!function_exists('token_get_all')) return 'PHP’s tokenizer is not installed on this site';
		if (!preg_match('/\.php$/i', $file)) return 'it is not a PHP file';
		$size = @filesize($file);
		if ($size === false) return 'it could not be read';
		if ($size > self::MAX_FILE) return 'it is larger than ' . (self::MAX_FILE / 1024) . ' KB';
		$code = @file_get_contents($file);
		if (!is_string($code)) return 'it could not be read';
		$tokens = @token_get_all($code);
		if (!is_array($tokens)) return 'it could not be read';
		$names = array(T_STRING => true);
		if (defined('T_NAME_FULLY_QUALIFIED')) $names[constant('T_NAME_FULLY_QUALIFIED')] = true;
		$gettext = self::GETTEXT;
		// The file's HTML, with PRINTED wherever its PHP runs, and where each stretch of HTML begins: [offset, line].
		$html = '';
		$starts = array();
		$translated = array();
		$prev = null;
		$count = count($tokens);
		for ($i = 0; $i < $count; $i++) {
			$t = $tokens[$i];
			$kind = is_array($t) ? $t[0] : null;
			if ($kind === T_INLINE_HTML) {
				$starts[] = array(strlen($html), (int) $t[2]);
				$html .= $t[1];
				continue;
			}
			if ($kind === T_OPEN_TAG || $kind === T_OPEN_TAG_WITH_ECHO) {
				$html .= self::PRINTED;
				$prev = null;
				continue;
			}
			if ($kind === T_WHITESPACE || $kind === T_COMMENT || $kind === T_DOC_COMMENT || $kind === T_CLOSE_TAG) continue;
			if ($kind !== null && isset($names[$kind]) && !self::member($prev)) {
				$name = ltrim($t[1], chr(92));
				if (isset($gettext[$name])) {
					$args = self::args($tokens, $i + 1);
					$text = $args ? self::literal($args[0]) : null;
					$words = $text === null ? '' : self::words(html_entity_decode(strip_tags($text), ENT_QUOTES | ENT_HTML5, 'UTF-8'));
					if ($words !== '') {
						// Its text domain: core's own ('default') when none is given, '' when the code works it out.
						$at = $gettext[$name];
						$domain = isset($args[$at]) && $args[$at] ? self::literal($args[$at]) : 'default';
						$domain = $domain === null ? '' : self::cut_domain($domain);
						$room = isset($translated[$domain]) ? count($translated[$domain]) < self::MAX_WORDS : count($translated) < self::MAX_DOMAINS;
						if (!isset($translated[$domain][$words]) && $room) $translated[$domain][$words] = array('lines' => array(), 'function' => $name);
						if (isset($translated[$domain][$words])) self::line($translated[$domain][$words]['lines'], (int) $t[2]);
					}
				}
			}
			$prev = $t;
		}
		return array('written' => self::written($html, $starts), 'translated' => $translated);
	}

	/** Whether a name follows an object arrow (nullsafe or not) or ::, a method and not l10n.php’s function, or function or new. */
	private static function member($prev): bool {
		if (!is_array($prev)) return false;
		$kinds = array(T_OBJECT_OPERATOR, T_DOUBLE_COLON, T_FUNCTION, T_NEW);
		if (defined('T_NULLSAFE_OBJECT_OPERATOR')) $kinds[] = constant('T_NULLSAFE_OBJECT_OPERATOR');
		return in_array($prev[0], $kinds, true);
	}

	/**
	 * A call's arguments from just after its name, each as its tokens (whitespace and comments left out), or null when
	 * what follows is not a call this can read.
	 */
	private static function args(array $tokens, int $from): ?array {
		$count = min(count($tokens), $from + self::MAX_CALL);
		$i = $from;
		while ($i < $count && is_array($tokens[$i]) && in_array($tokens[$i][0], array(T_WHITESPACE, T_COMMENT, T_DOC_COMMENT), true)) $i++;
		if ($i >= $count || $tokens[$i] !== '(') return null;
		$args = array(array());
		$depth = 0;
		for ($i++; $i < $count; $i++) {
			$t = $tokens[$i];
			if (is_array($t) && in_array($t[0], array(T_WHITESPACE, T_COMMENT, T_DOC_COMMENT), true)) continue;
			$c = is_array($t) ? null : $t;
			if ($c === ')' && $depth === 0) return $args;
			if ($c === ',' && $depth === 0) {
				$args[] = array();
				continue;
			}
			if ($c === '(' || $c === '[' || $c === '{' || (is_array($t) && in_array($t[0], array(T_CURLY_OPEN, T_DOLLAR_OPEN_CURLY_BRACES), true))) $depth++;
			if ($c === ')' || $c === ']' || $c === '}') $depth--;
			if ($depth < 0) return null;
			$args[count($args) - 1][] = $t;
		}
		return null;
	}

	/** An argument that is one string literal, as PHP reads it; null for anything else (computed, or not a string). */
	private static function literal(array $arg): ?string {
		if (count($arg) !== 1 || !is_array($arg[0]) || $arg[0][0] !== T_CONSTANT_ENCAPSED_STRING) return null;
		// A b"…" prefix (a binary string) reads as the string.
		$s = ltrim($arg[0][1], 'bB');
		$quote = $s[0];
		$inner = substr($s, 1, -1);
		$bs = chr(92);
		if ($quote === "'") return strtr($inner, array($bs . $bs => $bs, $bs . "'" => "'"));
		// Double quotes with nothing to interpolate (PHP tokenizes those apart): its escapes, as stripcslashes() reads them.
		return stripcslashes($inner);
	}

	private static function cut_domain(string $domain): string {
		return preg_match('/^[A-Za-z0-9_.-]{1,100}$/', $domain) ? $domain : substr(preg_replace('/[^A-Za-z0-9_.-]/', '-', $domain), 0, 100);
	}

	/** Words as the design layer compares them, or '' when they have no letter or are too long. */
	private static function words(string $s): string {
		$w = Wanigan_Live_Words_Match::fold($s);
		return $w !== '' && strlen($w) <= self::MAX_LENGTH && preg_match('/\p{L}/u', $w) ? $w : '';
	}

	/** Keep a line once, up to MAX_LINES. */
	private static function line(array &$lines, int $line): void {
		if ($line > 0 && !in_array($line, $lines, true) && count($lines) < self::MAX_LINES) $lines[] = $line;
	}

	/**
	 * The runs of words in the file's HTML: the text between its tags, cut wherever its PHP runs, outside comments and
	 * elements whose text is code or not shown (a script, a style, the head's title). Each with the lines it is on.
	 */
	private static function written(string $html, array $starts): array {
		$source = $html;
		$raw = implode('|', Wanigan_Live_Words_Match::RAW);
		// Blanked to a declaration of the same length, so offsets, and so lines, stay where they were.
		$html = (string) preg_replace_callback('~<(' . $raw . ')\b[^>]*>.*?</\1\s*>~is', function ($m) {
			return '<!' . str_repeat(' ', max(0, strlen($m[0]) - 3)) . '>';
		}, $html);
		$out = array();
		$from = 0;
		$cuts = array();
		if (preg_match_all(self::TAG, $html, $m, PREG_OFFSET_CAPTURE)) {
			foreach ($m[0] as $tag) $cuts[] = array($tag[1], $tag[1] + strlen($tag[0]));
		}
		$cuts[] = array(strlen($html), strlen($html));
		foreach ($cuts as $cut) {
			if ($cut[0] > $from) {
				$text = substr($html, $from, $cut[0] - $from);
				foreach (preg_split('~' . self::PRINTED . '~u', $text, -1, PREG_SPLIT_OFFSET_CAPTURE) as $piece) {
					// A "<" or ">" left in text is a tag this could not read, and no words.
					if (strpbrk($piece[0], '<>') !== false) continue;
					$words = self::words(html_entity_decode($piece[0], ENT_QUOTES | ENT_HTML5, 'UTF-8'));
					if ($words === '') continue;
					if (!isset($out[$words]) && count($out) >= self::MAX_WORDS) continue;
					if (!isset($out[$words])) $out[$words] = array();
					$lead = strlen($piece[0]) - strlen(ltrim($piece[0]));
					self::line($out[$words], self::line_at($source, $starts, $from + $piece[1] + $lead));
				}
			}
			$from = max($from, $cut[1]);
		}
		return $out;
	}

	/** The file's line at an offset of its HTML: the line its stretch of HTML began on, and the newlines since. */
	private static function line_at(string $source, array $starts, int $at): int {
		$line = 0;
		foreach ($starts as $s) {
			if ($s[0] > $at) break;
			$line = $s[1] + ($at > $s[0] ? substr_count($source, "\n", $s[0], $at - $s[0]) : 0);
		}
		return $line;
	}
}
`;
