<?php
/**
 * Title: Three trails
 * Slug: fieldnotes/featured-trails
 * Description: A section head and three trails as cards, each showing its distance, climb and difficulty through block bindings.
 * Categories: fieldnotes, query
 * Keywords: trails, cards
 * Viewport Width: 1440
 */
?>
<!-- wp:group {"metadata":{"name":"Three trails"},"tagName":"section","align":"full","style":{"spacing":{"padding":{"top":"var:preset|spacing|60","bottom":"var:preset|spacing|60"},"blockGap":"var:preset|spacing|40"}},"layout":{"type":"constrained"}} -->
<section class="wp-block-group alignfull" style="padding-top:var(--wp--preset--spacing--60);padding-bottom:var(--wp--preset--spacing--60)"><!-- wp:group {"align":"wide","style":{"spacing":{"blockGap":"var:preset|spacing|20"}},"layout":{"type":"flex","orientation":"vertical"}} -->
<div class="wp-block-group alignwide"><!-- wp:paragraph {"className":"fn-eyebrow","textColor":"accent"} -->
<p class="fn-eyebrow has-accent-color has-text-color">Take it outside</p>
<!-- /wp:paragraph -->

<!-- wp:heading {"fontSize":"xx-large"} -->
<h2 class="wp-block-heading has-xx-large-font-size">Three trails this kit was made for</h2>
<!-- /wp:heading --></div>
<!-- /wp:group -->

<!-- wp:query {"queryId":81,"query":{"perPage":3,"pages":0,"offset":0,"postType":"trail","order":"desc","orderBy":"date","author":"","search":"","exclude":[],"sticky":"","inherit":false},"metadata":{"name":"Three trails"},"align":"wide"} -->
<div class="wp-block-query alignwide"><!-- wp:post-template {"className":"fn-grid","style":{"spacing":{"blockGap":"var:preset|spacing|50"}},"layout":{"type":"grid","columnCount":3,"minimumColumnWidth":"18rem"}} -->
<!-- wp:pattern {"slug":"fieldnotes/trail-card"} /-->
<!-- /wp:post-template --></div>
<!-- /wp:query --></section>
<!-- /wp:group -->
