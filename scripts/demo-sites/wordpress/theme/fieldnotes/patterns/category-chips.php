<?php
/**
 * Title: Journal sections
 * Slug: fieldnotes/category-chips
 * Description: The journal's sections as a row of chips, the one you are in filled: a filter for the entries below.
 * Categories: fieldnotes
 * Inserter: no
 */

$fieldnotes_journal = (int) get_option( 'page_for_posts' );
$fieldnotes_all     = $fieldnotes_journal ? get_permalink( $fieldnotes_journal ) : home_url( '/' );
?>
<!-- wp:group {"metadata":{"name":"Journal sections"},"align":"wide","className":"fn-chips","style":{"spacing":{"blockGap":"0.5rem"}},"layout":{"type":"flex","flexWrap":"wrap"}} -->
<div class="wp-block-group alignwide fn-chips"><!-- wp:paragraph {"className":"fn-label","textColor":"muted","style":{"spacing":{"margin":{"right":"0.5rem"}}}} -->
<p class="fn-label has-muted-color has-text-color" style="margin-right:0.5rem">Sections</p>
<!-- /wp:paragraph -->

<!-- wp:paragraph {"className":"fn-chip fn-chip--all"} -->
<p class="fn-chip fn-chip--all"><a href="<?php echo esc_url( $fieldnotes_all ); ?>">Everything</a></p>
<!-- /wp:paragraph -->

<!-- wp:categories {"showPostCounts":false,"showEmpty":false,"className":"is-style-chips"} /--></div>
<!-- /wp:group -->
