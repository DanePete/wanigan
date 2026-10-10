// The WordPress helper's part in the design layer's verification (src/main/live-layer.ts, "Verifying"), appended to
// the plugin's source (live-helper-wordpress.ts). PHP source, PHP 7.4 syntax like the rest of the plugin.
//
// It acts only for a request that carries the view's token and X-Wanigan-Steady, which only a verification's
// hidden renders send (never the owner's view, never anyone else's request):
// - WordPress keeps no cache metadata, so what changes between renders is known by block type and attributes, as
//   core renders them (docs/research/2026-10-09-core-limits.md, "Masking can be per part"): a gallery in random
//   order, the calendar's today, a relative date, the latest comments, a feed, login/out, a Query Loop ordered by
//   rand. Through render_block, the root tag of each such block gets `data-wanigan-vary="<why>"` with
//   WP_HTML_Tag_Processor, which changes no layout; Wanigan leaves those boxes out of the pixel steps and names them.
// - Two of those can be held still instead, with the hold the header carries (t=<a time, never later than now>;
//   s=<a seed>): a relative date is measured to that time (the human_time_diff filter, formatting.php), and a random
//   query is ordered by RAND(<seed>) (pre_get_posts, which WP_Query's parse_orderby() allows). Their marks then say
//   `data-wanigan-held`, and the response says what was held (X-Wanigan-Steady), so Wanigan compares them between
//   renders held alike instead of leaving them out. time() and current_time() have no filter, so the calendar stays
//   left out; seeding the gallery's shuffle() is unverified, so it does too.

export const WORDPRESS_VERIFY_SOURCE = String.raw`
// ── The design layer's verification: only for a token request that also carries X-Wanigan-Steady, which only
// Wanigan's verification renders send. See Wanigan's src/core/live-helper-wordpress-verify.ts.

/**
 * Why a core block changes from one render to the next, by its name and attributes as core renders it
 * (wp-includes/blocks/*.php), with what would hold it still for a held request ('time', 'order'), or null; null for
 * a block that renders the same each time.
 */
function wanigan_live_vary(array $block) {
	$name = isset($block['blockName']) ? (string) $block['blockName'] : '';
	$attrs = isset($block['attrs']) && is_array($block['attrs']) ? $block['attrs'] : array();
	switch ($name) {
		// gallery.php: shuffle() when randomOrder is set.
		case 'core/gallery':
			return !empty($attrs['randomOrder']) ? array('random-order', null) : null;
		// general-template.php get_calendar(): today's month and day, from current_time(), which has no filter.
		case 'core/calendar':
			return array('today', null);
		case 'core/latest-comments':
			return array('latest-comments', null);
		// rss.php: fetch_feed(), another site's.
		case 'core/rss':
			return array('remote-feed', null);
		case 'core/loginout':
			return array('login-state', null);
		// post-date.php, comment-date.php: human_time_diff() against now when the format is human-diff.
		case 'core/post-date':
		case 'core/comment-date':
			return isset($attrs['format']) && $attrs['format'] === 'human-diff' ? array('relative-date', 'time') : null;
		// blocks.php build_query_vars_from_query_block(): the stored orderBy goes to WP_Query as it is.
		case 'core/query':
			return isset($attrs['query']['orderBy']) && $attrs['query']['orderBy'] === 'rand' && empty($attrs['query']['inherit']) ? array('random-order', 'order') : null;
	}
	return null;
}

/**
 * A block's output with its root tag marked as changing between renders (data-wanigan-vary), when it does, and as
 * held still (data-wanigan-held) when this request's hold removed what changes it. An attribute changes no layout,
 * where a wrapper would.
 */
function wanigan_live_mark_vary(string $content, array $block, bool $held): string {
	$vary = wanigan_live_vary($block);
	if ($vary === null || $content === '' || !class_exists('WP_HTML_Tag_Processor')) return $content;
	$tags = new WP_HTML_Tag_Processor($content);
	if (!$tags->next_tag()) return $content;
	$tags->set_attribute('data-wanigan-vary', $vary[0]);
	if ($held && $vary[1] !== null) $tags->set_attribute('data-wanigan-held', $vary[1]);
	return $tags->get_updated_html();
}

/**
 * The hold a verification sent: [time, seed], or null. A time later than now is refused, and so is one more than 400
 * days old.
 */
function wanigan_live_hold(string $header, int $now) {
	if (!preg_match('/^t=(\d{1,12});s=(\d{1,9})$/', $header, $m)) return null;
	$t = (int) $m[1];
	$s = (int) $m[2];
	if ($t > $now || $t < $now - 400 * 86400 || $s < 1) return null;
	return array($t, $s);
}

/**
 * human_time_diff()'s answer again, measured to the held time where it was measured to now: core's $to defaults to
 * time() (formatting.php), and a theme's current_time('timestamp') is the local now, held by the same offset. Any
 * other two times are left as they were.
 */
function wanigan_live_held_diff($since, $from, $to, int $held, int $now, int $offset) {
	static $inside = false;
	if ($inside) return $since;
	if (abs((int) $to - $now) <= 2) $base = $held;
	elseif ($offset !== 0 && abs((int) $to - ($now + $offset)) <= 2) $base = $held + $offset;
	else return $since;
	$inside = true;
	try {
		return human_time_diff((int) $from, $base);
	} finally {
		$inside = false;
	}
}

/**
 * A query's order with every random part seeded: WP_Query takes RAND(n) as an order (class-wp-query.php
 * parse_orderby()), as a word of an order string or as a key of an order array.
 */
function wanigan_live_seeded_order($orderby, int $seed) {
	$rand = 'RAND(' . $seed . ')';
	if (is_string($orderby) && $orderby !== '') {
		$words = preg_split('/\s+/', trim($orderby));
		foreach ($words as $i => $word) if (strtolower($word) === 'rand') $words[$i] = $rand;
		return implode(' ', $words);
	}
	if (is_array($orderby)) {
		$out = array();
		foreach ($orderby as $key => $order) $out[is_string($key) && strtolower($key) === 'rand' ? $rand : $key] = $order;
		return $out;
	}
	return $orderby;
}

if (wanigan_live_on() && isset($_SERVER['HTTP_X_WANIGAN_STEADY'])) {
	$wanigan_live_hold = wanigan_live_hold((string) $_SERVER['HTTP_X_WANIGAN_STEADY'], time());
	// class-wp-block.php WP_Block::render() applies render_block to every block's output.
	add_filter('render_block', function ($content, $block) use ($wanigan_live_hold) {
		return is_string($content) && is_array($block) ? wanigan_live_mark_vary($content, $block, $wanigan_live_hold !== null) : $content;
	}, PHP_INT_MAX - 2, 2);
	if ($wanigan_live_hold !== null) {
		add_filter('human_time_diff', function ($since, $diff, $from, $to) use ($wanigan_live_hold) {
			return wanigan_live_held_diff($since, $from, $to, $wanigan_live_hold[0], time(), (int) round((float) get_option('gmt_offset') * 3600));
		}, PHP_INT_MAX, 4);
		add_action('pre_get_posts', function ($query) use ($wanigan_live_hold) {
			if (is_object($query) && method_exists($query, 'get')) {
				$orderby = $query->get('orderby');
				$seeded = wanigan_live_seeded_order($orderby, $wanigan_live_hold[1]);
				if ($seeded !== $orderby) $query->set('orderby', $seeded);
			}
		}, PHP_INT_MAX);
		add_action('send_headers', function () use ($wanigan_live_hold) {
			header('X-Wanigan-Steady: t=' . $wanigan_live_hold[0] . ';s=' . $wanigan_live_hold[1]);
		});
	}
	unset($wanigan_live_hold);
}
`;
