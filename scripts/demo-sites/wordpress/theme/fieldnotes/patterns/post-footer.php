<?php
/**
 * Title: Post footer
 * Slug: fieldnotes/post-footer
 * Description: Tags, a word about who wrote it, and the entries either side.
 * Categories: fieldnotes
 * Inserter: no
 */
?>
<!-- wp:group {"metadata":{"name":"Post footer"},"style":{"spacing":{"blockGap":"var:preset|spacing|40"}},"layout":{"type":"constrained"}} -->
<div class="wp-block-group"><!-- wp:post-terms {"term":"post_tag","prefix":"Filed under ","className":"fn-tags"} /-->

<!-- wp:group {"metadata":{"name":"About the author"},"className":"is-style-card","style":{"spacing":{"padding":{"top":"var:preset|spacing|40","bottom":"var:preset|spacing|40","left":"var:preset|spacing|40","right":"var:preset|spacing|40"},"blockGap":"0.5rem"}},"layout":{"type":"flex","orientation":"vertical"}} -->
<div class="wp-block-group is-style-card" style="padding-top:var(--wp--preset--spacing--40);padding-right:var(--wp--preset--spacing--40);padding-bottom:var(--wp--preset--spacing--40);padding-left:var(--wp--preset--spacing--40)"><!-- wp:paragraph {"className":"fn-label","textColor":"muted"} -->
<p class="fn-label has-muted-color has-text-color">Written by</p>
<!-- /wp:paragraph -->

<!-- wp:post-author-name {"isLink":true,"fontSize":"large","style":{"typography":{"fontWeight":"400"}},"fontFamily":"literata"} /-->

<!-- wp:post-author-biography {"textColor":"muted","fontSize":"small"} /--></div>
<!-- /wp:group -->

<!-- wp:group {"metadata":{"name":"Either side"},"className":"fn-either-side","style":{"spacing":{"blockGap":"var:preset|spacing|40"}},"layout":{"type":"flex","flexWrap":"wrap","justifyContent":"space-between"}} -->
<div class="wp-block-group fn-either-side"><!-- wp:post-navigation-link {"type":"previous","label":"Older","showTitle":true,"linkLabel":true} /-->

<!-- wp:post-navigation-link {"textAlign":"right","label":"Newer","showTitle":true,"linkLabel":true} /--></div>
<!-- /wp:group --></div>
<!-- /wp:group -->
