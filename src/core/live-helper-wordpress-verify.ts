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
 * A block's output with its root tag marked as changing between renders (data-wanigan-vary), when it does. An
 * attribute changes no layout, where a wrapper would.
 */
function wanigan_live_mark_vary(string $content, array $block): string {
	$vary = wanigan_live_vary($block);
	if ($vary === null || $content === '' || !class_exists('WP_HTML_Tag_Processor')) return $content;
	$tags = new WP_HTML_Tag_Processor($content);
	if (!$tags->next_tag()) return $content;
	$tags->set_attribute('data-wanigan-vary', $vary[0]);
	return $tags->get_updated_html();
}

if (wanigan_live_on() && isset($_SERVER['HTTP_X_WANIGAN_STEADY'])) {
	// class-wp-block.php WP_Block::render() applies render_block to every block's output.
	add_filter('render_block', function ($content, $block) {
		return is_string($content) && is_array($block) ? wanigan_live_mark_vary($content, $block) : $content;
	}, PHP_INT_MAX - 2, 2);
}
`;
