<?php
/**
 * Title: Almanac: opening
 * Slug: fieldnotes/almanac-hero
 * Description: The Almanac landing page's opening: title, what it is, the price and two ways in, beside the book.
 * Categories: fieldnotes, banner
 * Keywords: landing, product, book
 * Viewport Width: 1440
 */

[ $fieldnotes_id, $fieldnotes_url, $fieldnotes_alt ] = fieldnotes_picture( 'almanac-cover', 'large' );
?>
<!-- wp:group {"metadata":{"name":"Almanac: opening"},"tagName":"section","align":"full","style":{"spacing":{"padding":{"top":"var:preset|spacing|60","bottom":"var:preset|spacing|60"}}},"layout":{"type":"constrained"}} -->
<section class="wp-block-group alignfull" style="padding-top:var(--wp--preset--spacing--60);padding-bottom:var(--wp--preset--spacing--60)"><!-- wp:columns {"verticalAlignment":"center","align":"wide","style":{"spacing":{"blockGap":{"top":"var:preset|spacing|50","left":"var:preset|spacing|60"}}}} -->
<div class="wp-block-columns alignwide are-vertically-aligned-center"><!-- wp:column {"verticalAlignment":"center","width":"50%","className":"fn-hero-in"} -->
<div class="wp-block-column is-vertically-aligned-center fn-hero-in" style="flex-basis:50%"><!-- wp:paragraph {"className":"fn-eyebrow","textColor":"accent"} -->
<p class="fn-eyebrow has-accent-color has-text-color">New for 2027 · Ships in November</p>
<!-- /wp:paragraph -->

<!-- wp:heading {"level":1,"fontSize":"display"} -->
<h1 class="wp-block-heading has-display-font-size">The Fieldnotes <em>Almanac</em></h1>
<!-- /wp:heading -->

<!-- wp:paragraph {"className":"fn-standfirst","fontSize":"large"} -->
<p class="fn-standfirst has-large-font-size">A year in the lake country, bound to lie flat: fourteen route maps, fifty-two weeks of weather pages, kit lists by season and room for your own notes.</p>
<!-- /wp:paragraph -->

<!-- wp:group {"metadata":{"name":"Price"},"style":{"spacing":{"blockGap":"var:preset|spacing|30"}},"layout":{"type":"flex","flexWrap":"wrap","verticalAlignment":"center"}} -->
<div class="wp-block-group"><!-- wp:paragraph {"fontSize":"x-large","fontFamily":"literata"} -->
<p class="has-literata-font-family has-x-large-font-size">$34</p>
<!-- /wp:paragraph -->

<!-- wp:paragraph {"className":"fn-label","textColor":"muted"} -->
<p class="fn-label has-muted-color has-text-color">248 pages · cloth · 17 × 24 cm</p>
<!-- /wp:paragraph --></div>
<!-- /wp:group -->

<!-- wp:buttons -->
<div class="wp-block-buttons"><!-- wp:button -->
<div class="wp-block-button"><a class="wp-block-button__link wp-element-button" href="mailto:almanac@fieldnotes.example?subject=Reserve%20a%20copy">Reserve a copy</a></div>
<!-- /wp:button -->

<!-- wp:button {"className":"is-style-outline"} -->
<div class="wp-block-button is-style-outline"><a class="wp-block-button__link wp-element-button" href="#inside">See what is inside</a></div>
<!-- /wp:button --></div>
<!-- /wp:buttons --></div>
<!-- /wp:column -->

<!-- wp:column {"verticalAlignment":"center","width":"50%"} -->
<div class="wp-block-column is-vertically-aligned-center" style="flex-basis:50%"><?php if ( $fieldnotes_id ) : ?><!-- wp:image {"id":<?php echo (int) $fieldnotes_id; ?>,"sizeSlug":"large","linkDestination":"none","className":"fn-almanac-cover"} -->
<figure class="wp-block-image size-large fn-almanac-cover"><img src="<?php echo esc_url( $fieldnotes_url ); ?>" alt="<?php echo esc_attr( $fieldnotes_alt ); ?>" class="wp-image-<?php echo (int) $fieldnotes_id; ?>"/></figure>
<!-- /wp:image --><?php endif; ?></div>
<!-- /wp:column --></div>
<!-- /wp:columns --></section>
<!-- /wp:group -->
