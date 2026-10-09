<?php
/**
 * Title: Trail facts
 * Slug: fieldnotes/trail-facts
 * Description: A trail's distance, climb, difficulty and season, each bound to the trail's own post meta (the core/post-meta binding source), so the facts are written once, on the trail.
 * Categories: fieldnotes
 * Post Types: trail
 * Inserter: no
 */
?>
<!-- wp:group {"metadata":{"name":"Trail facts"},"align":"wide","className":"fn-facts","style":{"spacing":{"padding":{"top":"var:preset|spacing|30"},"blockGap":"var:preset|spacing|40"}},"layout":{"type":"grid","columnCount":4,"minimumColumnWidth":"9rem"}} -->
<div class="wp-block-group alignwide fn-facts" style="padding-top:var(--wp--preset--spacing--30)">
<!-- wp:group {"metadata":{"name":"Distance"},"style":{"spacing":{"blockGap":"0.35rem"}},"layout":{"type":"flex","orientation":"vertical"}} -->
<div class="wp-block-group"><!-- wp:paragraph {"className":"fn-label","textColor":"muted"} -->
<p class="fn-label has-muted-color has-text-color">Distance</p>
<!-- /wp:paragraph -->

<!-- wp:paragraph {"metadata":{"bindings":{"content":{"source":"core/post-meta","args":{"key":"distance"}}}},"className":"fn-fact__value","fontSize":"x-large"} -->
<p class="fn-fact__value has-x-large-font-size"></p>
<!-- /wp:paragraph --></div>
<!-- /wp:group -->

<!-- wp:group {"metadata":{"name":"Elevation gain"},"style":{"spacing":{"blockGap":"0.35rem"}},"layout":{"type":"flex","orientation":"vertical"}} -->
<div class="wp-block-group"><!-- wp:paragraph {"className":"fn-label","textColor":"muted"} -->
<p class="fn-label has-muted-color has-text-color">Elevation gain</p>
<!-- /wp:paragraph -->

<!-- wp:paragraph {"metadata":{"bindings":{"content":{"source":"core/post-meta","args":{"key":"elevation_gain"}}}},"className":"fn-fact__value","fontSize":"x-large"} -->
<p class="fn-fact__value has-x-large-font-size"></p>
<!-- /wp:paragraph --></div>
<!-- /wp:group -->

<!-- wp:group {"metadata":{"name":"Difficulty"},"style":{"spacing":{"blockGap":"0.35rem"}},"layout":{"type":"flex","orientation":"vertical"}} -->
<div class="wp-block-group"><!-- wp:paragraph {"className":"fn-label","textColor":"muted"} -->
<p class="fn-label has-muted-color has-text-color">Difficulty</p>
<!-- /wp:paragraph -->

<!-- wp:paragraph {"metadata":{"bindings":{"content":{"source":"core/post-meta","args":{"key":"difficulty"}}}},"className":"fn-fact__value","fontSize":"x-large"} -->
<p class="fn-fact__value has-x-large-font-size"></p>
<!-- /wp:paragraph --></div>
<!-- /wp:group -->

<!-- wp:group {"metadata":{"name":"Season"},"style":{"spacing":{"blockGap":"0.35rem"}},"layout":{"type":"flex","orientation":"vertical"}} -->
<div class="wp-block-group"><!-- wp:paragraph {"className":"fn-label","textColor":"muted"} -->
<p class="fn-label has-muted-color has-text-color">Season</p>
<!-- /wp:paragraph -->

<!-- wp:paragraph {"metadata":{"bindings":{"content":{"source":"core/post-meta","args":{"key":"season"}}}},"className":"fn-fact__value","fontSize":"x-large"} -->
<p class="fn-fact__value has-x-large-font-size"></p>
<!-- /wp:paragraph --></div>
<!-- /wp:group -->
</div>
<!-- /wp:group -->
