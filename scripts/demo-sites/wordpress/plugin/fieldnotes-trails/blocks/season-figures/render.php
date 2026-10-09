<?php
/**
 * fieldnotes/season-figures: four numbers counted from the site itself when
 * the page is made, so they are always true of what the journal holds.
 *
 * @var array $attributes
 */

defined( 'ABSPATH' ) || exit;

$fieldnotes_trails = get_posts(
	array(
		'post_type'      => 'trail',
		'post_status'    => 'publish',
		'posts_per_page' => -1,
		'fields'         => 'ids',
	)
);
$fieldnotes_km     = array_sum( array_map( static fn ( $id ) => (float) get_post_meta( $id, 'distance', true ), $fieldnotes_trails ) );
$fieldnotes_logs   = get_term_by( 'slug', 'weather-log', 'category' );
$fieldnotes_notes  = (int) get_comments(
	array(
		'status' => 'approve',
		'count'  => true,
	)
);

$fieldnotes_figures = array(
	array( number_format_i18n( count( $fieldnotes_trails ) ), __( 'trails walked and written up', 'fieldnotes-trails' ) ),
	array( number_format_i18n( $fieldnotes_km, 1 ), __( 'kilometres of trail in the log', 'fieldnotes-trails' ) ),
	array( number_format_i18n( $fieldnotes_logs ? (int) $fieldnotes_logs->count : 0 ), __( 'weeks of weather, written down', 'fieldnotes-trails' ) ),
	array( number_format_i18n( $fieldnotes_notes ), __( 'notes from readers', 'fieldnotes-trails' ) ),
);
?>
<dl <?php echo get_block_wrapper_attributes( array( 'class' => 'season-figures' ) ); ?>>
	<?php foreach ( $fieldnotes_figures as [ $fieldnotes_value, $fieldnotes_label ] ) : ?>
		<div class="season-figures__item">
			<dt><?php echo esc_html( $fieldnotes_label ); ?></dt>
			<dd><?php echo esc_html( $fieldnotes_value ); ?></dd>
		</div>
	<?php endforeach; ?>
</dl>
