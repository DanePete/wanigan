<?php
/**
 * Title: Lead story
 * Slug: fieldnotes/journal-lead
 * Description: The sticky post, large: picture on one side, its title and opening on the other.
 * Categories: fieldnotes
 * Inserter: no
 */
?>
<!-- wp:query {"queryId":32,"query":{"perPage":1,"pages":0,"offset":0,"postType":"post","order":"desc","orderBy":"date","author":"","search":"","exclude":[],"sticky":"only","inherit":false},"metadata":{"name":"Lead story"},"align":"wide"} -->
<div class="wp-block-query alignwide"><!-- wp:post-template -->
<!-- wp:columns {"verticalAlignment":"center","className":"fn-card fn-lead","style":{"spacing":{"blockGap":{"top":"var:preset|spacing|40","left":"var:preset|spacing|60"}}}} -->
<div class="wp-block-columns are-vertically-aligned-center fn-card fn-lead"><!-- wp:column {"verticalAlignment":"center","width":"58%"} -->
<div class="wp-block-column is-vertically-aligned-center" style="flex-basis:58%"><!-- wp:post-featured-image {"aspectRatio":"3/2","sizeSlug":"large"} /--></div>
<!-- /wp:column -->

<!-- wp:column {"verticalAlignment":"center","width":"42%"} -->
<div class="wp-block-column is-vertically-aligned-center" style="flex-basis:42%"><!-- wp:group {"style":{"spacing":{"blockGap":"var:preset|spacing|30"}},"layout":{"type":"flex","orientation":"vertical"}} -->
<div class="wp-block-group"><!-- wp:group {"style":{"spacing":{"blockGap":"0.75rem"}},"layout":{"type":"flex","flexWrap":"wrap"}} -->
<div class="wp-block-group"><!-- wp:paragraph {"className":"fn-label","textColor":"accent"} -->
<p class="fn-label has-accent-color has-text-color">Lead story</p>
<!-- /wp:paragraph -->

<!-- wp:post-date {"format":"j M Y"} /--></div>
<!-- /wp:group -->

<!-- wp:post-title {"level":2,"isLink":true,"fontSize":"xx-large"} /-->

<!-- wp:post-excerpt {"className":"fn-standfirst","fontSize":"large","excerptLength":40} /-->

<!-- wp:post-author-name {"isLink":false,"fontSize":"small"} /--></div>
<!-- /wp:group --></div>
<!-- /wp:column --></div>
<!-- /wp:columns -->
<!-- /wp:post-template --></div>
<!-- /wp:query -->
