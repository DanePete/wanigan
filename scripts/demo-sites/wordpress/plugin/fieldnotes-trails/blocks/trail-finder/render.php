<?php
/**
 * fieldnotes/trail-finder: every trail as a card, and three sets of buttons
 * (difficulty, season, unit) that narrow the cards in the browser.
 *
 * The page arrives complete: the server works out every directive from the
 * same state the browser will use (wp_interactivity_state, with derived
 * values as closures), so the list reads right before any script runs and
 * view.js only takes over the clicks.
 *
 * @var array $attributes
 */

defined( 'ABSPATH' ) || exit;

$fieldnotes_cards = fieldnotes_trails_cards();
if ( ! $fieldnotes_cards ) {
	return;
}

$fieldnotes_ns = 'fieldnotes/trail-finder';
wp_interactivity_state(
	$fieldnotes_ns,
	array(
		'difficulty' => 'all',
		'season'     => 'all',
		'unit'       => 'km',
		'total'      => count( $fieldnotes_cards ),
		'trails'     => array_map(
			static fn ( $c ) => array(
				'difficulty' => $c['difficulty'],
				'seasons'    => $c['seasons'],
			),
			$fieldnotes_cards
		),
		'shownCount' => count( $fieldnotes_cards ),
		'isEmpty'    => false,
		'isChosen'   => static function () use ( $fieldnotes_ns ) {
			$context = wp_interactivity_get_context( $fieldnotes_ns );
			$state   = wp_interactivity_state( $fieldnotes_ns );
			return ( $state[ $context['group'] ] ?? null ) === $context['value'];
		},
		'isHidden'   => false,
		'distance'   => static function () use ( $fieldnotes_ns ) {
			$context = wp_interactivity_get_context( $fieldnotes_ns );
			$state   = wp_interactivity_state( $fieldnotes_ns );
			return fieldnotes_trails_distance( (float) $context['km'], $state['unit'] );
		},
	)
);

$fieldnotes_groups = array(
	'difficulty' => array(
		'label'   => __( 'Difficulty', 'fieldnotes-trails' ),
		'choices' => array(
			'all'      => __( 'Any', 'fieldnotes-trails' ),
			'easy'     => __( 'Easy', 'fieldnotes-trails' ),
			'moderate' => __( 'Moderate', 'fieldnotes-trails' ),
			'hard'     => __( 'Hard', 'fieldnotes-trails' ),
		),
	),
	'season'     => array(
		'label'   => __( 'Season', 'fieldnotes-trails' ),
		'choices' => array(
			'all'    => __( 'Any', 'fieldnotes-trails' ),
			'spring' => __( 'Spring', 'fieldnotes-trails' ),
			'summer' => __( 'Summer', 'fieldnotes-trails' ),
			'autumn' => __( 'Autumn', 'fieldnotes-trails' ),
			'winter' => __( 'Winter', 'fieldnotes-trails' ),
		),
	),
);
if ( ! empty( $attributes['showUnits'] ) ) {
	$fieldnotes_groups['unit'] = array(
		'label'   => __( 'Units', 'fieldnotes-trails' ),
		'choices' => array(
			'km' => __( 'km', 'fieldnotes-trails' ),
			'mi' => __( 'mi', 'fieldnotes-trails' ),
		),
	);
}
?>
<div <?php echo get_block_wrapper_attributes( array( 'class' => 'trail-finder' ) ); ?> data-wp-interactive="<?php echo esc_attr( $fieldnotes_ns ); ?>">
	<div class="trail-finder__controls">
		<?php foreach ( $fieldnotes_groups as $fieldnotes_group => $fieldnotes_set ) : ?>
			<div class="trail-finder__group trail-finder__group--<?php echo esc_attr( $fieldnotes_group ); ?>" role="group" aria-label="<?php echo esc_attr( $fieldnotes_set['label'] ); ?>">
				<span class="trail-finder__label" aria-hidden="true"><?php echo esc_html( $fieldnotes_set['label'] ); ?></span>
				<?php foreach ( $fieldnotes_set['choices'] as $fieldnotes_value => $fieldnotes_name ) : ?>
					<button
						type="button"
						class="trail-finder__choice"
						data-wp-context="<?php echo esc_attr( wp_json_encode( array( 'group' => $fieldnotes_group, 'value' => (string) $fieldnotes_value ) ) ); ?>"
						data-wp-on--click="actions.choose"
						data-wp-bind--aria-pressed="state.isChosen"
					><?php echo esc_html( $fieldnotes_name ); ?></button>
				<?php endforeach; ?>
			</div>
		<?php endforeach; ?>
	</div>

	<p class="trail-finder__count" aria-live="polite">
		<?php
		printf(
			/* translators: 1: trails shown, 2: all trails */
			esc_html__( 'Showing %1$s of %2$s trails', 'fieldnotes-trails' ),
			'<strong data-wp-text="state.shownCount">' . esc_html( (string) count( $fieldnotes_cards ) ) . '</strong>',
			esc_html( (string) count( $fieldnotes_cards ) )
		);
		?>
	</p>

	<ul class="trail-finder__list" role="list">
		<?php foreach ( $fieldnotes_cards as $fieldnotes_card ) : ?>
			<li
				class="trail-card"
				data-wp-context="<?php echo esc_attr( wp_json_encode( array( 'difficulty' => $fieldnotes_card['difficulty'], 'seasons' => $fieldnotes_card['seasons'], 'km' => $fieldnotes_card['km'] ) ) ); ?>"
				data-wp-bind--hidden="state.isHidden"
			>
				<a class="trail-card__picture" href="<?php echo esc_url( $fieldnotes_card['url'] ); ?>" tabindex="-1" aria-hidden="true">
					<?php
					if ( $fieldnotes_card['image'] ) {
						echo wp_get_attachment_image(
							$fieldnotes_card['image'],
							'medium_large',
							false,
							array(
								'sizes'   => '(max-width: 640px) 100vw, (max-width: 1100px) 50vw, 400px',
								'loading' => 'lazy',
								'alt'     => '',
							)
						);
					}
					?>
				</a>
				<div class="trail-card__body">
					<?php if ( $fieldnotes_card['region'] ) : ?>
						<p class="trail-card__region"><?php echo esc_html( $fieldnotes_card['region'] ); ?></p>
					<?php endif; ?>
					<h3 class="trail-card__title"><a href="<?php echo esc_url( $fieldnotes_card['url'] ); ?>"><?php echo esc_html( $fieldnotes_card['title'] ); ?></a></h3>
					<ul class="trail-card__facts" role="list">
						<li><span class="screen-reader-text"><?php esc_html_e( 'Distance', 'fieldnotes-trails' ); ?> </span><span data-wp-text="state.distance"><?php echo esc_html( fieldnotes_trails_distance( $fieldnotes_card['km'], 'km' ) ); ?></span></li>
						<?php if ( $fieldnotes_card['gain'] ) : ?>
							<li><?php /* translators: %s: elevation gain with its unit */ printf( esc_html__( '%s gain', 'fieldnotes-trails' ), esc_html( $fieldnotes_card['gain'] ) ); ?></li>
						<?php endif; ?>
						<li><?php echo esc_html( $fieldnotes_card['season'] ); ?></li>
					</ul>
					<p class="trail-card__difficulty trail-card__difficulty--<?php echo esc_attr( $fieldnotes_card['difficulty'] ); ?>"><?php echo esc_html( ucfirst( $fieldnotes_card['difficulty'] ) ); ?></p>
				</div>
			</li>
		<?php endforeach; ?>
	</ul>

	<p class="trail-finder__empty" data-wp-bind--hidden="!state.isEmpty">
		<?php esc_html_e( 'No trail is both of those. Try another season, or any difficulty.', 'fieldnotes-trails' ); ?>
	</p>
</div>
