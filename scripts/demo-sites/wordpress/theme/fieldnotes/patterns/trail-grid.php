<?php
/**
 * Title: Trail grid
 * Slug: fieldnotes/trail-grid
 * Description: The page's own trails (a region, the trail archive) as cards, with pagination.
 * Categories: fieldnotes
 * Inserter: no
 */
?>
<!-- wp:query {"queryId":51,"query":{"perPage":9,"pages":0,"offset":0,"postType":"trail","order":"asc","orderBy":"title","author":"","search":"","exclude":[],"sticky":"","inherit":true},"metadata":{"name":"Trails here"},"align":"wide"} -->
<div class="wp-block-query alignwide"><!-- wp:query-total {"displayType":"total-results"} /-->

<!-- wp:post-template {"className":"fn-grid","style":{"spacing":{"blockGap":"var:preset|spacing|50"}},"layout":{"type":"grid","columnCount":3,"minimumColumnWidth":"18rem"}} -->
<!-- wp:pattern {"slug":"fieldnotes/trail-card"} /-->
<!-- /wp:post-template -->

<!-- wp:pattern {"slug":"fieldnotes/pagination"} /-->

<!-- wp:query-no-results -->
<!-- wp:paragraph -->
<p>No trails written up here yet.</p>
<!-- /wp:paragraph -->
<!-- /wp:query-no-results --></div>
<!-- /wp:query -->
