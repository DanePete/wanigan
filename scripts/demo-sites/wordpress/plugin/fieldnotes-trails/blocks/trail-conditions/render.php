<?php
/**
 * fieldnotes/trail-conditions: the newest report in the trail's conditions
 * log, and the earlier ones behind a toggle that view.js opens and closes.
 *
 * @var array    $attributes
 * @var WP_Block $block
 */

defined( 'ABSPATH' ) || exit;

$fieldnotes_post_id = (int) ( $block->context['postId'] ?? get_the_ID() );
if ( ! $fieldnotes_post_id || 'trail' !== get_post_type( $fieldnotes_post_id ) ) {
	return;
}
$fieldnotes_log = fieldnotes_trails_conditions( $fieldnotes_post_id );
if ( ! $fieldnotes_log ) {
	return;
}

$fieldnotes_status = array(
	'open'   => __( 'Open', 'fieldnotes-trails' ),
	'wet'    => __( 'Open, wet', 'fieldnotes-trails' ),
	'closed' => __( 'Closed', 'fieldnotes-trails' ),
);
$fieldnotes_latest  = array_shift( $fieldnotes_log );
$fieldnotes_earlier = array_slice( $fieldnotes_log, 0, max( 0, (int) $attributes['earlier'] ) );
$fieldnotes_list_id = 'trail-conditions-' . $fieldnotes_post_id;
$fieldnotes_more    = sprintf(
	/* translators: %d: number of earlier reports */
	_n( 'Show %d earlier report', 'Show %d earlier reports', count( $fieldnotes_earlier ), 'fieldnotes-trails' ),
	count( $fieldnotes_earlier )
);
$fieldnotes_less    = __( 'Hide earlier reports', 'fieldnotes-trails' );

wp_interactivity_state(
	'fieldnotes/trail-conditions',
	array(
		'label' => static function () {
			$context = wp_interactivity_get_context( 'fieldnotes/trail-conditions' );
			return $context['open'] ? $context['less'] : $context['more'];
		},
	)
);

$fieldnotes_day = static fn ( string $date ) => wp_date( get_option( 'date_format' ), strtotime( $date . ' 12:00' ) );
?>
<section
	<?php echo get_block_wrapper_attributes( array( 'class' => 'trail-conditions' ) ); ?>
	data-wp-interactive="fieldnotes/trail-conditions"
	data-wp-context="<?php echo esc_attr( wp_json_encode( array( 'open' => false, 'more' => $fieldnotes_more, 'less' => $fieldnotes_less ) ) ); ?>"
	aria-labelledby="<?php echo esc_attr( $fieldnotes_list_id ); ?>-title"
>
	<div class="trail-conditions__head">
		<h2 class="trail-conditions__title" id="<?php echo esc_attr( $fieldnotes_list_id ); ?>-title"><?php esc_html_e( 'Conditions', 'fieldnotes-trails' ); ?></h2>
		<p class="trail-conditions__status trail-conditions__status--<?php echo esc_attr( $fieldnotes_latest['status'] ); ?>">
			<?php echo esc_html( $fieldnotes_status[ $fieldnotes_latest['status'] ] ?? ucfirst( $fieldnotes_latest['status'] ) ); ?>
		</p>
	</div>
	<p class="trail-conditions__note"><?php echo esc_html( $fieldnotes_latest['note'] ?? '' ); ?></p>
	<p class="trail-conditions__when">
		<?php
		/* translators: %s: date of the report */
		printf( esc_html__( 'Reported %s', 'fieldnotes-trails' ), '<time datetime="' . esc_attr( $fieldnotes_latest['date'] ) . '">' . esc_html( $fieldnotes_day( $fieldnotes_latest['date'] ) ) . '</time>' );
		?>
	</p>
	<?php if ( $fieldnotes_earlier ) : ?>
		<button
			type="button"
			class="trail-conditions__toggle"
			aria-controls="<?php echo esc_attr( $fieldnotes_list_id ); ?>"
			data-wp-on--click="actions.toggle"
			data-wp-bind--aria-expanded="context.open"
			data-wp-text="state.label"
		><?php echo esc_html( $fieldnotes_more ); ?></button>
		<ol class="trail-conditions__earlier" id="<?php echo esc_attr( $fieldnotes_list_id ); ?>" data-wp-bind--hidden="!context.open">
			<?php foreach ( $fieldnotes_earlier as $fieldnotes_report ) : ?>
				<li>
					<time datetime="<?php echo esc_attr( $fieldnotes_report['date'] ); ?>"><?php echo esc_html( $fieldnotes_day( $fieldnotes_report['date'] ) ); ?></time>
					<span class="trail-conditions__dot trail-conditions__dot--<?php echo esc_attr( $fieldnotes_report['status'] ); ?>"><?php echo esc_html( $fieldnotes_status[ $fieldnotes_report['status'] ] ?? $fieldnotes_report['status'] ); ?></span>
					<span><?php echo esc_html( $fieldnotes_report['note'] ?? '' ); ?></span>
				</li>
			<?php endforeach; ?>
		</ol>
	<?php endif; ?>
</section>
