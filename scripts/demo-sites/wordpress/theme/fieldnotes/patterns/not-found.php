<?php
/**
 * Title: Off the map
 * Slug: fieldnotes/not-found
 * Description: The page for an address that leads nowhere: a fogged-in trail, a search, and two ways back.
 * Categories: fieldnotes
 * Inserter: no
 */

[ $fieldnotes_id, $fieldnotes_url, $fieldnotes_alt ] = fieldnotes_picture( 'fog-404', 'large' );
$fieldnotes_journal = (int) get_option( 'page_for_posts' );
?>
<!-- wp:columns {"metadata":{"name":"Off the map"},"verticalAlignment":"center","align":"wide","style":{"spacing":{"blockGap":{"top":"var:preset|spacing|50","left":"var:preset|spacing|60"}}}} -->
<div class="wp-block-columns alignwide are-vertically-aligned-center"><!-- wp:column {"verticalAlignment":"center","width":"46%"} -->
<div class="wp-block-column is-vertically-aligned-center" style="flex-basis:46%"><!-- wp:group {"className":"fn-hero-in","style":{"spacing":{"blockGap":"var:preset|spacing|30"}},"layout":{"type":"flex","orientation":"vertical"}} -->
<div class="wp-block-group fn-hero-in"><!-- wp:paragraph {"className":"fn-eyebrow","textColor":"accent"} -->
<p class="fn-eyebrow has-accent-color has-text-color">404 · Off the map</p>
<!-- /wp:paragraph -->

<!-- wp:heading {"level":1,"fontSize":"display"} -->
<h1 class="wp-block-heading has-display-font-size">This trail <em>fades out</em> here.</h1>
<!-- /wp:heading -->

<!-- wp:paragraph {"className":"fn-standfirst","textColor":"muted","fontSize":"large"} -->
<p class="fn-standfirst has-muted-color has-text-color has-large-font-size">The page you followed has moved, or was never blazed. Search the notebook, or take one of the marked ways back.</p>
<!-- /wp:paragraph -->

<!-- wp:search {"label":"Search the journal","showLabel":false,"placeholder":"Search the journal","width":100,"widthUnit":"%","buttonText":"Search","buttonPosition":"button-inside","buttonUseIcon":true} /-->

<!-- wp:buttons -->
<div class="wp-block-buttons"><!-- wp:button -->
<div class="wp-block-button"><a class="wp-block-button__link wp-element-button" href="<?php echo esc_url( $fieldnotes_journal ? get_permalink( $fieldnotes_journal ) : home_url( '/' ) ); ?>">Back to the journal</a></div>
<!-- /wp:button -->

<!-- wp:button {"className":"is-style-outline"} -->
<div class="wp-block-button is-style-outline"><a class="wp-block-button__link wp-element-button" href="<?php echo esc_url( (string) get_post_type_archive_link( 'trail' ) ); ?>">See every trail</a></div>
<!-- /wp:button --></div>
<!-- /wp:buttons --></div>
<!-- /wp:group --></div>
<!-- /wp:column -->

<!-- wp:column {"verticalAlignment":"center","width":"54%"} -->
<div class="wp-block-column is-vertically-aligned-center" style="flex-basis:54%"><?php if ( $fieldnotes_id ) : ?><!-- wp:image {"id":<?php echo (int) $fieldnotes_id; ?>,"sizeSlug":"large","linkDestination":"none","className":"is-style-plate"} -->
<figure class="wp-block-image size-large is-style-plate"><img src="<?php echo esc_url( $fieldnotes_url ); ?>" alt="<?php echo esc_attr( $fieldnotes_alt ); ?>" class="wp-image-<?php echo (int) $fieldnotes_id; ?>"/><figcaption class="wp-element-caption">Plate 404 — Where the blazes stop.</figcaption></figure>
<!-- /wp:image --><?php endif; ?></div>
<!-- /wp:column --></div>
<!-- /wp:columns -->
