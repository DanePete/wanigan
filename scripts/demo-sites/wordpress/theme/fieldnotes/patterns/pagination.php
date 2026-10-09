<?php
/**
 * Title: Pagination
 * Slug: fieldnotes/pagination
 * Description: Newer and older entries, with page numbers between, for the foot of a Query Loop. Templates write it out in place: a pattern block renders without its query's context, so pagination has to sit inside the query itself.
 * Categories: fieldnotes
 * Block Types: core/query
 */
?>
<!-- wp:query-pagination {"paginationArrow":"arrow","className":"fn-pagination","style":{"spacing":{"margin":{"top":"var:preset|spacing|60"}}},"layout":{"type":"flex","justifyContent":"space-between"}} -->
<!-- wp:query-pagination-previous {"label":"Newer"} /-->

<!-- wp:query-pagination-numbers /-->

<!-- wp:query-pagination-next {"label":"Older"} /-->
<!-- /wp:query-pagination -->
