<?php
/**
 * Title: From the weather log
 * Slug: fieldnotes/weather-strip
 * Description: A dark band with the four newest weather logs as dated rows.
 * Categories: fieldnotes, query
 * Keywords: weather, log, posts
 * Viewport Width: 1440
 */

$fieldnotes_log = get_term_by( 'slug', 'weather-log', 'category' );
$fieldnotes_ids = $fieldnotes_log ? array( (int) $fieldnotes_log->term_id ) : array();
$fieldnotes_url = $fieldnotes_log ? get_term_link( $fieldnotes_log ) : home_url( '/' );
?>
<!-- wp:group {"metadata":{"name":"From the weather log"},"tagName":"section","align":"full","className":"fn-weather","style":{"spacing":{"padding":{"top":"var:preset|spacing|70","bottom":"var:preset|spacing|70"}},"elements":{"link":{"color":{"text":"var:preset|color|on-deep"}}}},"backgroundColor":"deep","textColor":"on-deep","layout":{"type":"constrained"}} -->
<section class="wp-block-group alignfull fn-weather has-on-deep-color has-deep-background-color has-text-color has-background has-link-color" style="padding-top:var(--wp--preset--spacing--70);padding-bottom:var(--wp--preset--spacing--70)"><!-- wp:columns {"align":"wide","style":{"spacing":{"blockGap":{"top":"var:preset|spacing|50","left":"var:preset|spacing|60"}}}} -->
<div class="wp-block-columns alignwide"><!-- wp:column {"width":"38%"} -->
<div class="wp-block-column" style="flex-basis:38%"><!-- wp:group {"className":"fn-sticky","style":{"spacing":{"blockGap":"var:preset|spacing|30"}},"layout":{"type":"flex","orientation":"vertical"}} -->
<div class="wp-block-group fn-sticky"><!-- wp:paragraph {"className":"fn-eyebrow fn-dim"} -->
<p class="fn-eyebrow fn-dim">04 — Weather log</p>
<!-- /wp:paragraph -->

<!-- wp:heading {"fontSize":"xx-large"} -->
<h2 class="wp-block-heading has-xx-large-font-size">The weather, <em>written down at six</em></h2>
<!-- /wp:heading -->

<!-- wp:paragraph {"className":"fn-dim"} -->
<p class="fn-dim">A brass thermometer on the north wall of the cabin, a barometer that sticks in the cold, and whatever the sky was doing at six in the evening. Kept every week since the spring of 2019.</p>
<!-- /wp:paragraph -->

<!-- wp:buttons -->
<div class="wp-block-buttons"><!-- wp:button {"className":"is-style-arrow"} -->
<div class="wp-block-button is-style-arrow"><a class="wp-block-button__link wp-element-button" href="<?php echo esc_url( is_wp_error( $fieldnotes_url ) ? home_url( '/' ) : $fieldnotes_url ); ?>">The whole log</a></div>
<!-- /wp:button --></div>
<!-- /wp:buttons --></div>
<!-- /wp:group --></div>
<!-- /wp:column -->

<!-- wp:column {"width":"62%"} -->
<div class="wp-block-column" style="flex-basis:62%"><!-- wp:query {"queryId":71,"query":{"perPage":4,"pages":0,"offset":0,"postType":"post","order":"desc","orderBy":"date","author":"","search":"","exclude":[],"sticky":"","inherit":false,"taxQuery":{"include":{"category":<?php echo wp_json_encode( $fieldnotes_ids ); ?>}}},"metadata":{"name":"Newest weather logs"}} -->
<div class="wp-block-query"><!-- wp:post-template {"className":"fn-rows is-style-numbered","style":{"spacing":{"blockGap":"0"}}} -->
<!-- wp:group {"className":"fn-card","style":{"spacing":{"padding":{"top":"var:preset|spacing|40","bottom":"var:preset|spacing|40"},"blockGap":"var:preset|spacing|30"}},"layout":{"type":"flex","flexWrap":"nowrap","verticalAlignment":"top"}} -->
<div class="wp-block-group fn-card" style="padding-top:var(--wp--preset--spacing--40);padding-bottom:var(--wp--preset--spacing--40)"><!-- wp:group {"style":{"spacing":{"blockGap":"0.4rem"}},"layout":{"type":"flex","orientation":"vertical"}} -->
<div class="wp-block-group"><!-- wp:post-date {"format":"l j F Y","className":"fn-dim","style":{"elements":{"link":{"color":{"text":"var:preset|color|on-deep"}}}}} /-->

<!-- wp:post-title {"level":3,"isLink":true,"fontSize":"large"} /-->

<!-- wp:post-excerpt {"className":"fn-dim","excerptLength":24} /--></div>
<!-- /wp:group --></div>
<!-- /wp:group -->
<!-- /wp:post-template --></div>
<!-- /wp:query --></div>
<!-- /wp:column --></div>
<!-- /wp:columns --></section>
<!-- /wp:group -->
