<?php
/**
 * Title: Journal hero
 * Slug: fieldnotes/hero-journal
 * Description: The front page's opening: a large title and a standfirst over a wide plate, the title above the picture rather than on it.
 * Categories: fieldnotes, banner
 * Keywords: hero, intro, front page
 * Viewport Width: 1440
 */

[ $fieldnotes_id, $fieldnotes_url, $fieldnotes_alt ] = fieldnotes_picture( 'hero-lakes', 'full' );
$fieldnotes_journal = (int) get_option( 'page_for_posts' );
?>
<!-- wp:group {"metadata":{"name":"Journal hero"},"tagName":"section","align":"full","style":{"spacing":{"padding":{"top":"var:preset|spacing|60","bottom":"var:preset|spacing|50"},"blockGap":"var:preset|spacing|50"}},"layout":{"type":"constrained"}} -->
<section class="wp-block-group alignfull" style="padding-top:var(--wp--preset--spacing--60);padding-bottom:var(--wp--preset--spacing--50)"><!-- wp:columns {"verticalAlignment":"bottom","align":"wide","style":{"spacing":{"blockGap":{"top":"var:preset|spacing|40","left":"var:preset|spacing|60"}}}} -->
<div class="wp-block-columns alignwide are-vertically-aligned-bottom"><!-- wp:column {"verticalAlignment":"bottom","width":"62%","className":"fn-hero-in"} -->
<div class="wp-block-column is-vertically-aligned-bottom fn-hero-in" style="flex-basis:62%"><!-- wp:paragraph {"className":"fn-eyebrow","textColor":"accent"} -->
<p class="fn-eyebrow has-accent-color has-text-color">Volume 7 · Autumn 2026</p>
<!-- /wp:paragraph -->

<!-- wp:heading {"level":1,"fontSize":"display"} -->
<h1 class="wp-block-heading has-display-font-size">Notes from the <em>edge of the map</em></h1>
<!-- /wp:heading --></div>
<!-- /wp:column -->

<!-- wp:column {"verticalAlignment":"bottom","width":"38%","className":"fn-hero-in"} -->
<div class="wp-block-column is-vertically-aligned-bottom fn-hero-in" style="flex-basis:38%"><!-- wp:paragraph {"className":"fn-standfirst","fontSize":"large"} -->
<p class="fn-standfirst has-large-font-size">A field journal of trails walked, kit carried and weather written down the evening it happened, kept in the lake country since 2019.</p>
<!-- /wp:paragraph -->

<!-- wp:buttons -->
<div class="wp-block-buttons"><!-- wp:button -->
<div class="wp-block-button"><a class="wp-block-button__link wp-element-button" href="<?php echo esc_url( $fieldnotes_journal ? get_permalink( $fieldnotes_journal ) : home_url( '/' ) ); ?>">Read the journal</a></div>
<!-- /wp:button -->

<!-- wp:button {"className":"is-style-outline"} -->
<div class="wp-block-button is-style-outline"><a class="wp-block-button__link wp-element-button" href="<?php echo esc_url( (string) get_post_type_archive_link( 'trail' ) ); ?>">Find a trail</a></div>
<!-- /wp:button --></div>
<!-- /wp:buttons --></div>
<!-- /wp:column --></div>
<!-- /wp:columns -->

<?php if ( $fieldnotes_id ) : ?>
<!-- wp:image {"id":<?php echo (int) $fieldnotes_id; ?>,"sizeSlug":"full","linkDestination":"none","align":"wide","className":"is-style-plate fn-hero-image"} -->
<figure class="wp-block-image alignwide size-full is-style-plate fn-hero-image"><img src="<?php echo esc_url( $fieldnotes_url ); ?>" alt="<?php echo esc_attr( $fieldnotes_alt ); ?>" class="wp-image-<?php echo (int) $fieldnotes_id; ?>"/><figcaption class="wp-element-caption">Plate 01 — Tamarack Lake at twenty to seven, before the wind got up.</figcaption></figure>
<!-- /wp:image -->
<?php endif; ?></section>
<!-- /wp:group -->
