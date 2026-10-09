<?php
/**
 * Title: More from the journal
 * Slug: fieldnotes/related-posts
 * Description: Three more entries from the same section as the one you are reading (the fieldnotes-trails plugin narrows the query).
 * Categories: fieldnotes
 * Inserter: no
 */

$fieldnotes_journal = (int) get_option( 'page_for_posts' );
?>
<!-- wp:group {"metadata":{"name":"More from the journal"},"tagName":"section","align":"full","backgroundColor":"surface","style":{"spacing":{"padding":{"top":"var:preset|spacing|60","bottom":"var:preset|spacing|60"},"blockGap":"var:preset|spacing|40"},"border":{"top":{"color":"var:preset|color|line","width":"1px"}}},"layout":{"type":"constrained"}} -->
<section class="wp-block-group alignfull has-surface-background-color has-background" style="border-top-color:var(--wp--preset--color--line);border-top-width:1px;padding-top:var(--wp--preset--spacing--60);padding-bottom:var(--wp--preset--spacing--60)"><!-- wp:group {"align":"wide","layout":{"type":"flex","flexWrap":"wrap","justifyContent":"space-between","verticalAlignment":"bottom"}} -->
<div class="wp-block-group alignwide"><!-- wp:heading {"fontSize":"x-large"} -->
<h2 class="wp-block-heading has-x-large-font-size">More from the journal</h2>
<!-- /wp:heading -->

<!-- wp:buttons -->
<div class="wp-block-buttons"><!-- wp:button {"className":"is-style-arrow"} -->
<div class="wp-block-button is-style-arrow"><a class="wp-block-button__link wp-element-button" href="<?php echo esc_url( $fieldnotes_journal ? get_permalink( $fieldnotes_journal ) : home_url( '/' ) ); ?>">Every entry</a></div>
<!-- /wp:button --></div>
<!-- /wp:buttons --></div>
<!-- /wp:group -->

<!-- wp:query {"queryId":21,"query":{"perPage":3,"pages":0,"offset":0,"postType":"post","order":"desc","orderBy":"date","author":"","search":"","exclude":[],"sticky":"","inherit":false,"fieldnotesRelated":true},"metadata":{"name":"Same section"},"align":"wide"} -->
<div class="wp-block-query alignwide"><!-- wp:post-template {"className":"fn-grid","style":{"spacing":{"blockGap":"var:preset|spacing|50"}},"layout":{"type":"grid","columnCount":3,"minimumColumnWidth":"18rem"}} -->
<!-- wp:pattern {"slug":"fieldnotes/post-card"} /-->
<!-- /wp:post-template --></div>
<!-- /wp:query --></section>
<!-- /wp:group -->
