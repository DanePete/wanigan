<?php
/**
 * Title: Almanac: a spread
 * Slug: fieldnotes/almanac-spread
 * Description: One spread of the book beside what is on it: a media and text block.
 * Categories: fieldnotes, about
 * Keywords: media, book, spread
 * Viewport Width: 1440
 */

[ $fieldnotes_id, $fieldnotes_url, $fieldnotes_alt ] = fieldnotes_picture( 'almanac-spread', 'large' );
?>
<!-- wp:group {"metadata":{"name":"Almanac: a spread"},"tagName":"section","align":"full","style":{"spacing":{"padding":{"top":"var:preset|spacing|60","bottom":"var:preset|spacing|60"}}},"layout":{"type":"constrained"}} -->
<section class="wp-block-group alignfull" style="padding-top:var(--wp--preset--spacing--60);padding-bottom:var(--wp--preset--spacing--60)"><!-- wp:media-text {"align":"wide","mediaId":<?php echo (int) $fieldnotes_id; ?>,"mediaLink":"<?php echo esc_url( $fieldnotes_url ); ?>","mediaType":"image","mediaWidth":56,"mediaSizeSlug":"large","verticalAlignment":"center","className":"fn-spread"} -->
<div class="wp-block-media-text alignwide is-stacked-on-mobile is-vertically-aligned-center fn-spread" style="grid-template-columns:56% auto"><figure class="wp-block-media-text__media"><img src="<?php echo esc_url( $fieldnotes_url ); ?>" alt="<?php echo esc_attr( $fieldnotes_alt ); ?>" class="wp-image-<?php echo (int) $fieldnotes_id; ?> size-large"/></figure><div class="wp-block-media-text__content"><!-- wp:paragraph {"className":"fn-eyebrow","textColor":"accent"} -->
<p class="fn-eyebrow has-accent-color has-text-color">A spread from week 41</p>
<!-- /wp:paragraph -->

<!-- wp:heading {"fontSize":"x-large"} -->
<h2 class="wp-block-heading has-x-large-font-size">One route, one spread, one week of weather</h2>
<!-- /wp:heading -->

<!-- wp:paragraph -->
<p>Each route gets two pages: the map on the left at a scale you can walk by, and on the right the facts, the turns, and a column of notes from the times we walked it.</p>
<!-- /wp:paragraph -->

<!-- wp:list {"className":"is-style-checklist"} -->
<ul class="wp-block-list is-style-checklist"><!-- wp:list-item -->
<li><strong>Distances and climbs</strong> measured on the ground, not from a screen</li>
<!-- /wp:list-item -->

<!-- wp:list-item -->
<li><strong>Trailheads</strong> with where to park and what the road is like in March</li>
<!-- /wp:list-item -->

<!-- wp:list-item -->
<li><strong>The best season</strong> for each, and the one to avoid</li>
<!-- /wp:list-item --></ul>
<!-- /wp:list --></div></div>
<!-- /wp:media-text --></section>
<!-- /wp:group -->
