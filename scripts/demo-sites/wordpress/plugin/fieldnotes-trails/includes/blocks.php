<?php
/**
 * The plugin's blocks, each a folder under blocks/ with its block.json:
 *
 *   fieldnotes/trail-finder      every trail, filtered by difficulty and season (Interactivity API)
 *   fieldnotes/trail-conditions  the current trail's conditions log, earlier reports on a toggle (Interactivity API)
 *   fieldnotes/season-figures    the season in numbers, counted when the page is made
 *
 * All three render on the server (render.php). Their editor scripts are plain
 * scripts with no build step, showing the server's rendering in the editor.
 */

defined( 'ABSPATH' ) || exit;

add_action(
	'init',
	static function () {
		foreach ( array( 'trail-finder', 'trail-conditions', 'season-figures' ) as $block ) {
			register_block_type( dirname( __DIR__ ) . '/blocks/' . $block );
		}
	}
);

/**
 * Every published trail, as the trail finder shows it.
 */
function fieldnotes_trails_cards(): array {
	$trails = get_posts(
		array(
			'post_type'      => 'trail',
			'post_status'    => 'publish',
			'posts_per_page' => 50,
			'orderby'        => array(
				'menu_order' => 'ASC',
				'title'      => 'ASC',
			),
		)
	);
	$cards  = array();
	foreach ( $trails as $trail ) {
		$regions = get_the_terms( $trail, 'region' );
		$cards[] = array(
			'id'         => $trail->ID,
			'title'      => get_the_title( $trail ),
			'url'        => get_permalink( $trail ),
			'image'      => get_post_thumbnail_id( $trail ),
			'region'     => ( $regions && ! is_wp_error( $regions ) ) ? $regions[0]->name : '',
			'km'         => (float) get_post_meta( $trail->ID, 'distance', true ),
			'gain'       => (string) get_post_meta( $trail->ID, 'elevation_gain', true ),
			'difficulty' => strtolower( (string) get_post_meta( $trail->ID, 'difficulty', true ) ),
			'season'     => (string) get_post_meta( $trail->ID, 'season', true ),
			'seasons'    => fieldnotes_trails_seasons( $trail->ID ),
		);
	}
	return $cards;
}

/**
 * A distance in the unit asked for: "6.4 km" or "4.0 mi".
 */
function fieldnotes_trails_distance( float $km, string $unit ): string {
	return 'mi' === $unit
		? sprintf( '%s mi', number_format_i18n( $km * 0.621371, 1 ) )
		: sprintf( '%s km', number_format_i18n( $km, 1 ) );
}
