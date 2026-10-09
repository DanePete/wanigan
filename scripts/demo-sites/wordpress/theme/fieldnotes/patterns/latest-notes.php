<?php
/**
 * Title: Latest from the journal
 * Slug: fieldnotes/latest-notes
 * Description: A numbered section head, the journal's sections as chips, and the three newest entries as cards.
 * Categories: fieldnotes, query
 * Keywords: latest, posts, journal
 * Viewport Width: 1440
 */

$fieldnotes_journal = (int) get_option( 'page_for_posts' );
?>
<!-- wp:group {"metadata":{"name":"Latest from the journal"},"tagName":"section","align":"full","style":{"spacing":{"padding":{"top":"var:preset|spacing|60","bottom":"var:preset|spacing|60"},"blockGap":"var:preset|spacing|40"}},"layout":{"type":"constrained"}} -->
<section class="wp-block-group alignfull" style="padding-top:var(--wp--preset--spacing--60);padding-bottom:var(--wp--preset--spacing--60)"><!-- wp:group {"metadata":{"name":"Section head"},"align":"wide","className":"fn-section-head","style":{"spacing":{"blockGap":"var:preset|spacing|30"}},"layout":{"type":"flex","flexWrap":"wrap","justifyContent":"space-between","verticalAlignment":"bottom"}} -->
<div class="wp-block-group alignwide fn-section-head"><!-- wp:group {"style":{"spacing":{"blockGap":"var:preset|spacing|20"}},"layout":{"type":"flex","orientation":"vertical"}} -->
<div class="wp-block-group"><!-- wp:paragraph {"className":"fn-eyebrow","textColor":"accent"} -->
<p class="fn-eyebrow has-accent-color has-text-color">01 — The journal</p>
<!-- /wp:paragraph -->

<!-- wp:heading {"fontSize":"xx-large"} -->
<h2 class="wp-block-heading has-xx-large-font-size">Latest from the field</h2>
<!-- /wp:heading --></div>
<!-- /wp:group -->

<!-- wp:buttons -->
<div class="wp-block-buttons"><!-- wp:button {"className":"is-style-arrow"} -->
<div class="wp-block-button is-style-arrow"><a class="wp-block-button__link wp-element-button" href="<?php echo esc_url( $fieldnotes_journal ? get_permalink( $fieldnotes_journal ) : home_url( '/' ) ); ?>">Every entry</a></div>
<!-- /wp:button --></div>
<!-- /wp:buttons --></div>
<!-- /wp:group -->

<!-- wp:pattern {"slug":"fieldnotes/category-chips"} /-->

<!-- wp:query {"queryId":61,"query":{"perPage":3,"pages":0,"offset":0,"postType":"post","order":"desc","orderBy":"date","author":"","search":"","exclude":[],"sticky":"","inherit":false},"metadata":{"name":"Three newest"},"align":"wide"} -->
<div class="wp-block-query alignwide"><!-- wp:post-template {"className":"fn-grid","style":{"spacing":{"blockGap":"var:preset|spacing|50"}},"layout":{"type":"grid","columnCount":3,"minimumColumnWidth":"18rem"}} -->
<!-- wp:pattern {"slug":"fieldnotes/post-card"} /-->
<!-- /wp:post-template --></div>
<!-- /wp:query --></section>
<!-- /wp:group -->
