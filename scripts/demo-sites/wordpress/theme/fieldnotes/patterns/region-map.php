<?php
/**
 * Title: Region map
 * Slug: fieldnotes/region-map
 * Description: The overview map of the whole lake country, as a printed plate with its caption.
 * Categories: fieldnotes
 * Inserter: no
 */

[ $fieldnotes_id, $fieldnotes_url, $fieldnotes_alt ] = fieldnotes_picture( 'map-region', 'full' );
if ( ! $fieldnotes_id ) {
	return;
}
?>
<!-- wp:image {"id":<?php echo (int) $fieldnotes_id; ?>,"sizeSlug":"full","linkDestination":"none","align":"wide","className":"is-style-plate"} -->
<figure class="wp-block-image alignwide size-full is-style-plate"><img src="<?php echo esc_url( $fieldnotes_url ); ?>" alt="<?php echo esc_attr( $fieldnotes_alt ); ?>" class="wp-image-<?php echo (int) $fieldnotes_id; ?>"/><figcaption class="wp-element-caption">Plate 00 — The Fieldnotes country. The numbers follow the order of the trails above.</figcaption></figure>
<!-- /wp:image -->
