<?php
/**
 * Title: Essay feature
 * Slug: fieldnotes/essay-feature
 * Description: One essay given the whole width: a night plate behind, the title and opening low on the left.
 * Categories: fieldnotes, featured
 * Keywords: cover, essay, feature
 * Viewport Width: 1440
 */

[ $fieldnotes_id, $fieldnotes_url ] = fieldnotes_picture( 'night-meadow', 'full' );
$fieldnotes_link = fieldnotes_link( 'a-cold-night-under-a-clear-sky' );
?>
<!-- wp:cover {"url":"<?php echo esc_url( $fieldnotes_url ); ?>","id":<?php echo (int) $fieldnotes_id; ?>,"dimRatio":100,"gradient":"spruce-shade","minHeight":680,"minHeightUnit":"px","isDark":true,"metadata":{"name":"Essay feature"},"align":"full","className":"fn-essay","style":{"spacing":{"padding":{"top":"var:preset|spacing|70","bottom":"var:preset|spacing|60"}}},"textColor":"on-deep","layout":{"type":"constrained"}} -->
<div class="wp-block-cover alignfull fn-essay has-on-deep-color has-text-color" style="padding-top:var(--wp--preset--spacing--70);padding-bottom:var(--wp--preset--spacing--60);min-height:680px"><img class="wp-block-cover__image-background wp-image-<?php echo (int) $fieldnotes_id; ?>" alt="" src="<?php echo esc_url( $fieldnotes_url ); ?>" data-object-fit="cover"/><span aria-hidden="true" class="wp-block-cover__background has-background-dim-100 has-background-dim wp-block-cover__gradient-background has-background-gradient has-spruce-shade-gradient-background"></span><div class="wp-block-cover__inner-container"><!-- wp:group {"align":"wide","style":{"spacing":{"blockGap":"var:preset|spacing|30"}},"layout":{"type":"constrained","contentSize":"46rem","justifyContent":"left"}} -->
<div class="wp-block-group alignwide"><!-- wp:paragraph {"className":"fn-eyebrow"} -->
<p class="fn-eyebrow">03 — An essay</p>
<!-- /wp:paragraph -->

<!-- wp:heading {"fontSize":"xx-large"} -->
<h2 class="wp-block-heading has-xx-large-font-size">Notes on a cold night <em>under a clear sky</em></h2>
<!-- /wp:heading -->

<!-- wp:paragraph {"className":"fn-standfirst","fontSize":"large"} -->
<p class="fn-standfirst has-large-font-size">It went down to minus four in the meadow, and the stars came out in an order we had never thought to notice.</p>
<!-- /wp:paragraph -->

<!-- wp:buttons -->
<div class="wp-block-buttons"><!-- wp:button {"backgroundColor":"on-deep","textColor":"deep"} -->
<div class="wp-block-button"><a class="wp-block-button__link has-deep-color has-on-deep-background-color has-text-color has-background wp-element-button" href="<?php echo esc_url( $fieldnotes_link ); ?>">Read the essay</a></div>
<!-- /wp:button --></div>
<!-- /wp:buttons --></div>
<!-- /wp:group --></div></div>
<!-- /wp:cover -->
