<?php
/**
 * Title: Post header
 * Slug: fieldnotes/post-header
 * Description: Where you are, the section, the title, the standfirst and the byline, for the top of an entry.
 * Categories: fieldnotes
 * Inserter: no
 */
?>
<!-- wp:group {"metadata":{"name":"Post header"},"tagName":"header","align":"wide","className":"fn-hero-in","style":{"spacing":{"padding":{"top":"var:preset|spacing|60"},"blockGap":"var:preset|spacing|30"}},"layout":{"type":"constrained","contentSize":"56rem","justifyContent":"left"}} -->
<header class="wp-block-group alignwide fn-hero-in" style="padding-top:var(--wp--preset--spacing--60)"><!-- wp:breadcrumbs /-->

<!-- wp:post-terms {"term":"category","textColor":"accent"} /-->

<!-- wp:post-title {"level":1,"fontSize":"display"} /-->

<!-- wp:post-excerpt {"className":"fn-standfirst","fontSize":"large","textColor":"muted","excerptLength":60} /-->

<!-- wp:group {"metadata":{"name":"Byline"},"style":{"spacing":{"blockGap":"var:preset|spacing|40","padding":{"top":"var:preset|spacing|30"},"margin":{"top":"var:preset|spacing|20"}},"border":{"top":{"color":"var:preset|color|line","width":"1px"}}},"layout":{"type":"flex","flexWrap":"wrap"}} -->
<div class="wp-block-group" style="border-top-color:var(--wp--preset--color--line);border-top-width:1px;margin-top:var(--wp--preset--spacing--20);padding-top:var(--wp--preset--spacing--30)"><!-- wp:post-author-name {"isLink":false} /-->

<!-- wp:post-date {"format":"j F Y"} /-->

<!-- wp:post-time-to-read /--></div>
<!-- /wp:group --></header>
<!-- /wp:group -->
