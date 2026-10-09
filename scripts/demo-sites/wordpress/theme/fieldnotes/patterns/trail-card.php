<?php
/**
 * Title: Trail card
 * Slug: fieldnotes/trail-card
 * Description: One trail as a card, for inside a Query Loop of trails: its map, region, name, and its distance, climb and difficulty bound to its post meta.
 * Categories: fieldnotes
 * Block Types: core/post-template
 * Inserter: no
 */
?>
<!-- wp:group {"metadata":{"name":"Trail card"},"className":"fn-card fn-trail-card","style":{"spacing":{"blockGap":"var:preset|spacing|20"}},"layout":{"type":"flex","orientation":"vertical","justifyContent":"stretch"}} -->
<div class="wp-block-group fn-card fn-trail-card"><!-- wp:post-featured-image {"aspectRatio":"16/10","sizeSlug":"medium_large","style":{"spacing":{"margin":{"bottom":"var:preset|spacing|20"}}}} /-->

<!-- wp:post-terms {"term":"region","textColor":"accent"} /-->

<!-- wp:post-title {"level":3,"isLink":true,"fontSize":"large"} /-->

<!-- wp:group {"metadata":{"name":"Facts"},"className":"fn-facts--compact","style":{"spacing":{"blockGap":"0.6em"}},"layout":{"type":"flex","flexWrap":"wrap"}} -->
<div class="wp-block-group fn-facts--compact"><!-- wp:paragraph {"metadata":{"bindings":{"content":{"source":"core/post-meta","args":{"key":"distance"}}}}} -->
<p></p>
<!-- /wp:paragraph -->

<!-- wp:paragraph {"metadata":{"bindings":{"content":{"source":"core/post-meta","args":{"key":"elevation_gain"}}}}} -->
<p></p>
<!-- /wp:paragraph -->

<!-- wp:paragraph {"metadata":{"bindings":{"content":{"source":"core/post-meta","args":{"key":"difficulty"}}}}} -->
<p></p>
<!-- /wp:paragraph --></div>
<!-- /wp:group --></div>
<!-- /wp:group -->
