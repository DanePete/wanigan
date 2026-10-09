<?php
/**
 * Title: Post card
 * Slug: fieldnotes/post-card
 * Description: One journal entry as a card, for inside a Query Loop: picture, section, date, title and a line of the excerpt.
 * Categories: fieldnotes
 * Block Types: core/post-template
 * Inserter: no
 */
?>
<!-- wp:group {"metadata":{"name":"Post card"},"className":"fn-card","style":{"spacing":{"blockGap":"var:preset|spacing|20"}},"layout":{"type":"flex","orientation":"vertical","justifyContent":"stretch"}} -->
<div class="wp-block-group fn-card"><!-- wp:post-featured-image {"aspectRatio":"3/2","sizeSlug":"medium_large","style":{"spacing":{"margin":{"bottom":"var:preset|spacing|20"}}}} /-->

<!-- wp:group {"style":{"spacing":{"blockGap":"0.75rem"}},"layout":{"type":"flex","flexWrap":"wrap"}} -->
<div class="wp-block-group"><!-- wp:post-terms {"term":"category","textColor":"accent"} /-->

<!-- wp:post-date {"format":"j M Y"} /--></div>
<!-- /wp:group -->

<!-- wp:post-title {"level":3,"isLink":true,"fontSize":"large"} /-->

<!-- wp:post-excerpt {"excerptLength":22} /--></div>
<!-- /wp:group -->
