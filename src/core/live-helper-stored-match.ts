// The site helpers' stored-words matcher (helper version 4): where words a page shows are kept inside one value the
// site stored, and that value with only those words changed. Plain PHP with no WordPress or Drupal call in it, so both
// helpers carry the same class: WordPress's must-use plugin as Wanigan_Live_Words_Match, Drupal's module as
// Drupal\wanigan_live\Save\WordsMatch. Used by POST /_wanigan/words (live-helper-wordpress-words.ts,
// live-helper-drupal-stored.ts) when nothing the page offers to edit holds the words.
//
// What it matches, and why each rule is there:
// - Words are compared as the page shows them: typographic quotes, dashes and the ellipsis read as typed (what
//   WordPress's wptexturize makes of them), any run of whitespace as one space, and in markup every character
//   reference read (`&amp;` is `&`). The same folding as the design layer's asWords() (src/main/live-layer.ts).
// - Only whole words count: a match that runs on into a letter or digit is not one.
// - A value is walked, never matched as raw bytes: an array or object by its keys, a JSON text by its string values
//   (each token decoded, so escaped slashes and \uXXXX are read as what they say), a serialized array through the
//   unserialize the caller gives (WordPress: core's maybe_unserialize; Drupal: no classes), markup by its text nodes
//   and quoted attribute values.
// - Text inside a script, a style or a template, an attribute that is an address, a class, an id, a style or a
//   handler, and a setting whose name says it is one of those (url, link, class, css, style, id…) are code: found
//   there, the words are said to be there and are never changed.
// - Writing changes only those words: a span of a string replaced by the new words escaped for where they go; a JSON
//   token re-encoded with the flags that reproduce the old token byte for byte (or not written at all); a serialized
//   array written back only when serializing it unchanged gives back the stored bytes.
//
// PHP 7.4 syntax (WordPress 7.1's minimum, and a parse error in a must-use plugin takes the site down), no `${` (this
// is a template literal) and no backtick (the TAG pattern spells it \x60).

const BODY = String.raw`
	/** Most bytes of one string searched; a longer one is left out, and said to be. */
	const MAX_STRING = 4194304;
	/** How deep arrays, objects and JSON are walked. */
	const MAX_DEPTH = 48;
	/** Most places kept for one search: more than one is already too many. */
	const MAX_HITS = 20;
	/** A tag, a comment, a CDATA section, a declaration or a processing instruction: what in markup is not text. A quoted attribute value may hold a ">". */
	const TAG = '~<!--.*?-->|<!\[CDATA\[.*?\]\]>|<![^>]*>|<\?.*?>|</?[A-Za-z][^\s/>]*(?:\s+[^\s/>"\'=]+(?:\s*=\s*(?:"[^"]*"|\'[^\']*\'|[^\s"\'=<>\x60]+))?)*\s*/?>~s';
	/** One attribute of a tag: its name, then its value double-quoted, single-quoted or bare. */
	const ATTR = '~\s([^\s/>"\'=]+)(?:\s*=\s*(?:"([^"]*)"|\'([^\']*)\'|([^\s"\'=<>\x60]+)))?~';
	/** Elements whose text is code, or not shown as words. */
	const RAW = array('script', 'style', 'template', 'textarea', 'title', 'noscript', 'xmp', 'iframe', 'noembed', 'noframes');
	/** Attributes whose values are addresses, names code uses, or code. */
	const CODE_ATTR = '~^(?:href|src|srcset|sizes|action|formaction|poster|cite|background|codebase|longdesc|usemap|manifest|ping|class|id|style|for|form|name|rel|rev|target|type|role|lang|dir|width|height|xmlns(?::[\w-]+)?|xlink:href|on[a-z]+|data-[\w-]*?(?:url|href|src|link|class|id|style|settings|options|config|json))$~i';
	/** An address with no spaces in it: a scheme, a path, a fragment, a query, a protocol-relative URL. */
	const ADDRESS = '~^(?:(?:https?|mailto|tel|sms|ftp|data|javascript|file|wss?):|//|/|#|\?|\./|\.\./)\S*$~i';
	/** A character reference in markup. */
	const REF = '&(?:#(?:[0-9]{1,7}|[xX][0-9a-fA-F]{1,6})|[A-Za-z][A-Za-z0-9]{1,31});';
	/** Typography WordPress's wptexturize prints, read as what was typed (as asWords() in src/main/live-layer.ts). */
	const TYPED = array("\u{2018}" => "'", "\u{2019}" => "'", "\u{201A}" => "'", "\u{201B}" => "'", "\u{2032}" => "'", "\u{201C}" => '"', "\u{201D}" => '"', "\u{201E}" => '"', "\u{201F}" => '"', "\u{2033}" => '"', "\u{2026}" => '...', "\u{2013}" => '-', "\u{2014}" => '-');

	/** Words as compared: the typography read as typed, whitespace as one space, trimmed. */
	public static function fold(string $words): string {
		$n = self::norm($words, false);
		return trim($n[0]);
	}

	/**
	 * Whether new words are words only: no tag, comment or control character. kses on plain text takes nothing else
	 * out, so what passes is saved as typed.
	 */
	public static function words_only(string $words): bool {
		return !preg_match('~<[A-Za-z!/?]|[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]~', $words);
	}

	/**
	 * A text as compared, with where each piece of it came from: [the folded text, its pieces], each piece
	 * [folded start, folded end, raw start, raw end, whether it is copied byte for byte]. In markup ($html) every
	 * character reference is read as its character.
	 */
	public static function norm(string $text, bool $html): array {
		$typed = '\x{2018}\x{2019}\x{201A}\x{201B}\x{2032}\x{201C}\x{201D}\x{201E}\x{201F}\x{2033}\x{2026}\x{2013}\x{2014}';
		$pattern = '~' . ($html ? self::REF . '|' : '') . '-{2,3}|[\s\x{00A0}]+|[^' . ($html ? '&' : '') . '\s\x{00A0}\-' . $typed . ']+|.~su';
		$out = '';
		$pieces = array();
		if (!preg_match_all($pattern, $text, $m, PREG_OFFSET_CAPTURE)) return array('', array());
		foreach ($m[0] as $token) {
			$raw = $token[0];
			$at = $token[1];
			$end = $at + strlen($raw);
			$char = ($html && $raw[0] === '&' && strlen($raw) > 1) ? html_entity_decode($raw, ENT_QUOTES | ENT_HTML5, 'UTF-8') : $raw;
			if ($char === '--' || $char === '---') $folded = '-';
			elseif (preg_match('~^[\s\x{00A0}]+$~u', $char)) $folded = ' ';
			else $folded = strtr($char, self::TYPED);
			if ($folded === ' ' && $out !== '' && substr($out, -1) === ' ') {
				$pieces[count($pieces) - 1][3] = $end;
				$pieces[count($pieces) - 1][4] = false;
				continue;
			}
			$same = $folded === $raw;
			$pieces[] = array(strlen($out), strlen($out) + strlen($folded), $at, $end, $same);
			$out .= $folded;
		}
		return array($out, $pieces);
	}

	/** The longest run of letters or digits in folded words: a value without it cannot hold them. */
	public static function probe(string $want): string {
		$best = '';
		if (preg_match_all('~[\p{L}\p{N}]+~u', $want, $m)) {
			foreach ($m[0] as $run) if (strlen($run) > strlen($best)) $best = $run;
		}
		return $best;
	}

	/** The character before byte $at, or ''. */
	private static function before_at(string $s, int $at): string {
		if ($at <= 0) return '';
		$i = $at - 1;
		while ($i > 0 && (ord($s[$i]) & 0xC0) === 0x80) $i--;
		return substr($s, $i, $at - $i);
	}

	/** The character at byte $at, or ''. */
	private static function char_at(string $s, int $at): string {
		if ($at >= strlen($s)) return '';
		$c = ord($s[$at]);
		$n = $c < 0x80 ? 1 : ($c < 0xE0 ? 2 : ($c < 0xF0 ? 3 : 4));
		return substr($s, $at, $n);
	}

	private static function wordy(string $c): bool {
		return $c !== '' && preg_match('~^[\p{L}\p{N}]$~u', $c) === 1;
	}

	/** Where folded byte $at falls in the raw text, as the start ($start) or the end of a match; null inside a piece that is not copied byte for byte. */
	private static function raw_at(array $pieces, int $at, bool $start): ?int {
		$lo = 0;
		$hi = count($pieces) - 1;
		$found = -1;
		while ($lo <= $hi) {
			$mid = intdiv($lo + $hi, 2);
			if ($start ? $pieces[$mid][0] <= $at : $pieces[$mid][0] < $at) {
				$found = $mid;
				$lo = $mid + 1;
			}
			else {
				$hi = $mid - 1;
			}
		}
		if ($found < 0) return null;
		$p = $pieces[$found];
		if ($start ? $at >= $p[1] : $at > $p[1]) return null;
		if ($p[4]) return $p[2] + ($at - $p[0]);
		if ($start) return $at === $p[0] ? $p[2] : null;
		return $at === $p[1] ? $p[3] : null;
	}

	/** Where the folded words are in a text, as whole words: raw byte spans [start, end). In markup ($html) references are read. */
	public static function spans(string $text, string $want, bool $html): array {
		if ($want === '' || $text === '' || strlen($text) > self::MAX_STRING) return array();
		$probe = self::probe($want);
		if ($probe !== '' && strpos($text, $probe) === false && (!$html || strpos($text, '&') === false || strpos(html_entity_decode($text, ENT_QUOTES | ENT_HTML5, 'UTF-8'), $probe) === false)) return array();
		$n = self::norm($text, $html);
		$folded = $n[0];
		$pieces = $n[1];
		$out = array();
		$from = 0;
		$len = strlen($want);
		$first = self::wordy(self::char_at($want, 0));
		$last = self::wordy(self::before_at($want, $len));
		while (($at = strpos($folded, $want, $from)) !== false) {
			$from = $at + 1;
			if ($first && self::wordy(self::before_at($folded, $at))) continue;
			if ($last && self::wordy(self::char_at($folded, $at + $len))) continue;
			$a = self::raw_at($pieces, $at, true);
			$b = self::raw_at($pieces, $at + $len, false);
			if ($a === null || $b === null) continue;
			$out[] = array($a, $b);
			if (count($out) > self::MAX_HITS) break;
		}
		return $out;
	}

	/** One place in a value: what it is, its span in the string at the end of its steps, and what it is under. */
	private static function hit(string $kind, int $start, int $end, string $quote = '', string $why = '', string $name = ''): array {
		return array('kind' => $kind, 'start' => $start, 'end' => $end, 'quote' => $quote, 'why' => $why, 'name' => $name, 'steps' => array(), 'stuck' => '');
	}

	/** Whether a string is markup: it holds a tag or a character reference. */
	public static function markup(string $s): bool {
		return preg_match('~<[A-Za-z!/?]|' . self::REF . '~', $s) === 1;
	}

	/** Why a setting by this name is code, or '' when it may hold words: an address, a class, a style, a script, an id. */
	public static function code_key($key): string {
		if (!is_string($key)) return '';
		$k = strtolower((string) preg_replace('~([a-z0-9])([A-Z])~', '$1_$2', $key));
		if (!preg_match('~(?:^|[_\-.])(url|uri|href|src|srcset|link|class|classes|class_name|css|style|styles|script|scripts|js|id|ids|anchor|slug|selector|html_tag)$~', $k, $m)) return '';
		return self::what($m[1]);
	}

	/** A code attribute's or setting's name, said as what its value is. */
	private static function what(string $name): string {
		$name = strtolower($name);
		if (in_array($name, array('class', 'classes', 'class_name'), true)) return 'a class';
		if (in_array($name, array('id', 'ids', 'anchor', 'for', 'form', 'name', 'slug', 'selector'), true)) return 'a name the site’s code uses';
		if (in_array($name, array('style', 'styles', 'css'), true)) return 'a style';
		if (in_array($name, array('script', 'scripts', 'js'), true) || preg_match('~^on[a-z]+$~', $name)) return 'a script';
		if (in_array($name, array('href', 'src', 'srcset', 'action', 'formaction', 'poster', 'cite', 'background', 'codebase', 'longdesc', 'usemap', 'manifest', 'ping', 'xlink:href', 'url', 'uri', 'link'), true)) return 'an address';
		return 'a setting the site’s code reads';
	}

	/** Where the words are in markup: text nodes ('text'), quoted attribute values ('attr'), and code ('code', with why). */
	public static function in_html(string $html, string $want): array {
		$out = array();
		$len = strlen($html);
		$pos = 0;
		while ($pos < $len) {
			if (!preg_match(self::TAG, $html, $m, PREG_OFFSET_CAPTURE, $pos)) {
				self::text_hits($out, $html, $pos, $len, $want, '');
				break;
			}
			$tag = $m[0][0];
			$at = $m[0][1];
			if ($at > $pos) self::text_hits($out, $html, $pos, $at, $want, '');
			$end = $at + strlen($tag);
			if (preg_match('~^<([A-Za-z][^\s/>]*)~', $tag, $t)) {
				$name = strtolower($t[1]);
				self::attr_hits($out, $tag, $at + strlen($t[0]), strlen($t[0]), $want);
				if (in_array($name, self::RAW, true) && substr($tag, -2) !== '/>') {
					$close = stripos($html, '</' . $name, $end);
					$stop = $close === false ? $len : $close;
					self::text_hits($out, $html, $end, $stop, $want, $name === 'script' ? 'a script' : ($name === 'style' ? 'a style' : 'a <' . $name . '> element'));
					$end = $stop;
				}
			}
			$pos = max($end, $pos + 1);
			if (count($out) > self::MAX_HITS) break;
		}
		return $out;
	}

	private static function text_hits(array &$out, string $html, int $from, int $to, string $want, string $code): void {
		if ($to <= $from) return;
		foreach (self::spans(substr($html, $from, $to - $from), $want, true) as $s) {
			$out[] = $code === '' ? self::hit('text', $from + $s[0], $from + $s[1]) : self::hit('code', $from + $s[0], $from + $s[1], '', $code);
		}
	}

	/** Words in a tag's attribute values; $offset is where $tag's attributes start in the markup, $skip how much of $tag is its name. */
	private static function attr_hits(array &$out, string $tag, int $offset, int $skip, string $want): void {
		$attrs = substr($tag, $skip);
		if (!preg_match_all(self::ATTR, $attrs, $m, PREG_SET_ORDER | PREG_OFFSET_CAPTURE | PREG_UNMATCHED_AS_NULL)) return;
		foreach ($m as $a) {
			$name = $a[1][0];
			$quote = '"';
			$value = null;
			foreach (array(2 => '"', 3 => "'", 4 => '') as $group => $q) {
				if (isset($a[$group]) && $a[$group][0] !== null && $a[$group][1] >= 0) {
					$value = $a[$group];
					$quote = $q;
					break;
				}
			}
			if ($value === null || $value[0] === '') continue;
			$at = $offset + $value[1];
			$code = preg_match(self::CODE_ATTR, $name) ? self::what(preg_replace('~^data-[\w-]*?(url|href|src|link|class|id|style)$~i', '$1', $name)) : (preg_match(self::ADDRESS, trim($value[0])) ? 'an address' : '');
			foreach (self::spans($value[0], $want, true) as $s) {
				$out[] = $code !== '' ? self::hit('code', $at + $s[0], $at + $s[1], $quote, $code, $name) : self::hit('attr', $at + $s[0], $at + $s[1], $quote, '', $name);
			}
		}
	}

	/** Where the words are in one string: in markup as in_html(), else as plain text ('plain'); a setting named for code ($key) or an address holds code. */
	public static function in_string(string $s, string $want, $key): array {
		$code = self::code_key($key);
		if ($code === '' && preg_match(self::ADDRESS, trim($s))) $code = 'an address';
		$html = self::markup($s);
		if ($code !== '') {
			$out = array();
			foreach (self::spans($s, $want, $html) as $sp) $out[] = self::hit('code', $sp[0], $sp[1], '', $code, is_string($key) ? $key : '');
			return $out;
		}
		if ($html) return self::in_html($s, $want);
		$out = array();
		foreach (self::spans($s, $want, false) as $sp) $out[] = self::hit('plain', $sp[0], $sp[1]);
		return $out;
	}

	/**
	 * A JSON text's string values, each [offset, length, value, key]: key the name it is under when it is an object's
	 * value, else null. Null when the text is not a JSON object or list.
	 */
	public static function json_values(string $raw): ?array {
		$t = ltrim($raw);
		if ($t === '' || ($t[0] !== '{' && $t[0] !== '[')) return null;
		json_decode($raw);
		if (json_last_error() !== JSON_ERROR_NONE) return null;
		if (!preg_match_all('~"(?:[^"\\\\]|\\\\.)*+"~s', $raw, $m, PREG_OFFSET_CAPTURE)) return array();
		$out = array();
		$key = null;
		foreach ($m[0] as $token) {
			$tok = $token[0];
			$at = $token[1];
			$end = $at + strlen($tok);
			$decoded = json_decode($tok);
			if (!is_string($decoded)) continue;
			if (preg_match('~\G\s*:~', $raw, $colon, 0, $end)) {
				$key = array($decoded, $end);
				continue;
			}
			$under = ($key !== null && preg_match('~^\s*:\s*$~', substr($raw, $key[1], $at - $key[1]))) ? $key[0] : null;
			$out[] = array($at, strlen($tok), $decoded, $under);
		}
		return $out;
	}

	/** The json_encode() flags that write $value back as exactly $token, or null when none does. */
	public static function json_flags(string $token, string $value): ?int {
		$hex = JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT;
		foreach (array(JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE, JSON_UNESCAPED_UNICODE, JSON_UNESCAPED_SLASHES, 0, $hex | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE, $hex | JSON_UNESCAPED_UNICODE, $hex | JSON_UNESCAPED_SLASHES, $hex) as $flags) {
			if (json_encode($value, $flags) === $token) return $flags;
		}
		return null;
	}

	/**
	 * Every place in one stored value holding the words, each a hit with the steps that lead to its string: ['k', key]
	 * into an array or object, ['j', offset, length, flags] into one JSON string token, ['s'] into a serialized array.
	 * $unserialize turns a serialized string into what it holds, or null when the string is not one; null means
	 * serialized strings are only strings here.
	 */
	public static function in_value($value, string $want, $key, $unserialize, int $depth = 0): array {
		if ($depth > self::MAX_DEPTH) return array();
		if (is_array($value) || $value instanceof \stdClass) {
			$out = array();
			foreach ((array) $value as $k => $v) {
				foreach (self::in_value($v, $want, $k, $unserialize, $depth + 1) as $hit) {
					array_unshift($hit['steps'], array('k', $k));
					$out[] = $hit;
				}
				if (count($out) > self::MAX_HITS) break;
			}
			return $out;
		}
		if (!is_string($value) || $value === '' || strlen($value) > self::MAX_STRING) return array();
		$probe = self::probe($want);
		if ($probe !== '' && strpos($value, $probe) === false && strpos($value, '\\') === false && strpos($value, '&') === false) return array();
		$json = self::json_values($value);
		if ($json !== null) {
			$out = array();
			foreach ($json as $v) {
				$found = self::in_value($v[2], $want, $v[3], null, $depth + 1);
				if (!$found) continue;
				$flags = self::json_flags(substr($value, $v[0], $v[1]), $v[2]);
				foreach ($found as $hit) {
					array_unshift($hit['steps'], array('j', $v[0], $v[1], $flags));
					if ($flags === null && $hit['stuck'] === '') $hit['stuck'] = 'they are kept in JSON written in a way Wanigan cannot write back exactly, so nothing else in it would stay as it is';
					$out[] = $hit;
				}
			}
			return $out;
		}
		if ($unserialize !== null) {
			$held = call_user_func($unserialize, $value);
			if (is_array($held) || $held instanceof \stdClass) {
				$out = array();
				$exact = serialize($held) === $value;
				foreach (self::in_value($held, $want, $key, $unserialize, $depth + 1) as $hit) {
					array_unshift($hit['steps'], array('s'));
					if (!$exact && $hit['stuck'] === '') $hit['stuck'] = 'they are kept in a saved list that would not be written back byte for byte, so other parts of it could change';
					$out[] = $hit;
				}
				return $out;
			}
		}
		return self::in_string($value, $want, $key);
	}

	/** The value with the span [start, end) of the string its steps lead to replaced by $insert, every other byte kept. */
	public static function put($value, array $steps, int $start, int $end, string $insert, $unserialize) {
		if (!$steps) return substr((string) $value, 0, $start) . $insert . substr((string) $value, $end);
		$step = array_shift($steps);
		if ($step[0] === 'k') {
			$k = $step[1];
			if ($value instanceof \stdClass) {
				$copy = clone $value;
				$copy->{$k} = self::put($value->{$k}, $steps, $start, $end, $insert, $unserialize);
				return $copy;
			}
			$value[$k] = self::put($value[$k], $steps, $start, $end, $insert, $unserialize);
			return $value;
		}
		if ($step[0] === 'j') {
			$token = substr((string) $value, $step[1], $step[2]);
			$new = json_encode(self::put(json_decode($token), $steps, $start, $end, $insert, $unserialize), (int) $step[3]);
			return substr((string) $value, 0, $step[1]) . $new . substr((string) $value, $step[1] + $step[2]);
		}
		return serialize(self::put(call_user_func($unserialize, (string) $value), $steps, $start, $end, $insert, $unserialize));
	}

	/** The new words as they are written where a hit is: as typed in plain text, escaped in a text node or an attribute value (quoted when it was bare). */
	public static function insert(array $hit, string $after): string {
		switch ($hit['kind']) {
			case 'text':
				return htmlspecialchars($after, ENT_NOQUOTES | ENT_HTML401 | ENT_SUBSTITUTE, 'UTF-8');
			case 'attr':
				$escaped = htmlspecialchars($after, ($hit['quote'] === "'" ? ENT_QUOTES : ENT_COMPAT) | ENT_HTML401 | ENT_SUBSTITUTE, 'UTF-8');
				return $hit['quote'] === '' ? '"' . $escaped . '"' : $escaped;
			default:
				return $after;
		}
	}

	/**
	 * A tag a template or a dynamic value is written with, which the site replaces when it renders: %%title%%,
	 * %title%, {{post_title}}, #post_title, [node:title], <o-dynamic>…</o-dynamic>.
	 */
	const TEMPLATE = '~%%[A-Za-z0-9_]+%%|%[A-Za-z][A-Za-z0-9_-]*%|\{\{\s*[A-Za-z0-9_.:-]+\s*\}\}|(?<![\w&])#(?:[a-z]+)_[a-z0-9_]+\b|\[[a-z][a-z0-9_-]*:[^\]\s]+\]|<o-dynamic\b[^>]*>.*?</o-dynamic>~s';

	/**
	 * The template tags in a value whose text, each tag read as any words, is exactly the words the page shows: what
	 * makes them when the page renders. Walked as in_value() walks (arrays, JSON, serialized lists), each line of a
	 * string (markup's tags as line ends) compared whole.
	 */
	public static function made($value, string $want, $unserialize, int $depth = 0): array {
		if ($depth > self::MAX_DEPTH || $want === '') return array();
		if (is_array($value) || $value instanceof \stdClass) {
			$out = array();
			foreach ((array) $value as $v) {
				$out = array_merge($out, self::made($v, $want, $unserialize, $depth + 1));
				if (count($out) > 4) break;
			}
			return $out;
		}
		if (!is_string($value) || $value === '' || strlen($value) > self::MAX_STRING) return array();
		$json = self::json_values($value);
		if ($json !== null) {
			$out = array();
			foreach ($json as $v) $out = array_merge($out, self::made($v[2], $want, null, $depth + 1));
			return $out;
		}
		if ($unserialize !== null) {
			$held = call_user_func($unserialize, $value);
			if (is_array($held) || $held instanceof \stdClass) return self::made($held, $want, $unserialize, $depth + 1);
		}
		if (!preg_match(self::TEMPLATE, $value)) return array();
		$text = preg_replace('~<o-dynamic\b[^>]*>.*?</o-dynamic>~s', '{{dynamic}}', $value);
		if (self::markup($text)) $text = html_entity_decode((string) preg_replace(self::TAG, "\n", $text), ENT_QUOTES | ENT_HTML5, 'UTF-8');
		foreach (preg_split('~\R~u', (string) $text) as $line) {
			$line = trim($line);
			if (!preg_match_all(self::TEMPLATE, $line, $tags)) continue;
			$pieces = array_map(function ($piece) { $n = self::norm($piece, false); return preg_quote($n[0], '~'); }, preg_split(self::TEMPLATE, $line));
			if (preg_match('~^' . implode('.+?', $pieces) . '$~su', $want)) return $tags[0];
		}
		return array();
	}

	/** Whether a hit is words the page shows (not code). */
	public static function shown(array $hit): bool {
		return $hit['kind'] !== 'code';
	}

	/** Where a hit is, as a key: the same place on two searches of an unchanged value. */
	public static function key(array $hit): string {
		return substr(md5(json_encode(array($hit['steps'], $hit['start'], $hit['end'], $hit['kind']))), 0, 16);
	}
`;

/** The matcher in WordPress's must-use plugin: one global class, appended to it (live-helper-wordpress.ts). */
export const WORDPRESS_WORDS_MATCH = `
/**
 * Where words a page shows are kept inside one stored value, and that value with only those words changed: plain PHP,
 * the same as the Drupal helper's WordsMatch (Wanigan's src/core/live-helper-stored-match.ts says each rule's why).
 */
final class Wanigan_Live_Words_Match {
${BODY}
}
`;

/** The matcher as a file of the Drupal helper's module. */
export const DRUPAL_WORDS_MATCH = `<?php

namespace Drupal\\wanigan_live\\Save;

/**
 * Where words a page shows are kept inside one stored value, and that value
 * with only those words changed: plain PHP, the same as the WordPress
 * helper's Wanigan_Live_Words_Match (Wanigan's
 * src/core/live-helper-stored-match.ts says each rule's why).
 */
final class WordsMatch {
${BODY}
}
`;
