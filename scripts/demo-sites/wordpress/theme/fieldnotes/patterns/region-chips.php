<?php
/**
 * Title: Regions
 * Slug: fieldnotes/region-chips
 * Description: Every region as a chip with its number of trails (a Terms Query of the region taxonomy).
 * Categories: fieldnotes
 * Inserter: no
 */
?>
<!-- wp:group {"metadata":{"name":"Regions"},"align":"wide","style":{"spacing":{"blockGap":"0.75rem"}},"layout":{"type":"flex","flexWrap":"wrap","verticalAlignment":"center"}} -->
<div class="wp-block-group alignwide"><!-- wp:paragraph {"className":"fn-label","textColor":"muted"} -->
<p class="fn-label has-muted-color has-text-color">By region</p>
<!-- /wp:paragraph -->

<!-- wp:terms-query {"termQuery":{"perPage":10,"taxonomy":"region","order":"asc","orderBy":"name","include":[],"hideEmpty":true,"showNested":false,"inherit":false},"className":"is-style-chips"} -->
<div class="wp-block-terms-query is-style-chips"><!-- wp:term-template -->
<!-- wp:term-name {"isLink":true} /-->

<!-- wp:term-count /-->
<!-- /wp:term-template --></div>
<!-- /wp:terms-query --></div>
<!-- /wp:group -->
