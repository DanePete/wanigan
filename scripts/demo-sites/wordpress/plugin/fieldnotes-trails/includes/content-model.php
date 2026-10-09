<?php
/**
 * The Trail post type, the Region taxonomy, and the trail facts.
 *
 * Each fact is registered post meta, shown in the REST API so the block
 * editor and block bindings (the core/post-meta source) can read it. The
 * trail templates in the fieldnotes theme bind paragraphs to these keys, so a
 * fact is written once, on the trail, and shown wherever a template asks.
 */

defined( 'ABSPATH' ) || exit;

/**
 * The facts a trail carries: meta key => [label, description].
 */
function fieldnotes_trails_facts(): array {
	return array(
		'distance'       => array( __( 'Distance', 'fieldnotes-trails' ), __( 'Length of the route, with its unit: 6.4 km.', 'fieldnotes-trails' ) ),
		'elevation_gain' => array( __( 'Elevation gain', 'fieldnotes-trails' ), __( 'Total climb over the route, with its unit: 120 m.', 'fieldnotes-trails' ) ),
		'difficulty'     => array( __( 'Difficulty', 'fieldnotes-trails' ), __( 'Easy, Moderate or Hard.', 'fieldnotes-trails' ) ),
		'season'         => array( __( 'Season', 'fieldnotes-trails' ), __( 'When it walks best: one or more of Spring, Summer, Autumn, Winter, or All seasons.', 'fieldnotes-trails' ) ),
		'trailhead'      => array( __( 'Trailhead', 'fieldnotes-trails' ), __( 'Where the route starts, as a person would find it.', 'fieldnotes-trails' ) ),
	);
}

function fieldnotes_trails_register_content_model(): void {
	register_post_type(
		'trail',
		array(
			'labels'        => array(
				'name'               => __( 'Trails', 'fieldnotes-trails' ),
				'singular_name'      => __( 'Trail', 'fieldnotes-trails' ),
				'add_new_item'       => __( 'Add trail', 'fieldnotes-trails' ),
				'edit_item'          => __( 'Edit trail', 'fieldnotes-trails' ),
				'view_item'          => __( 'View trail', 'fieldnotes-trails' ),
				'all_items'          => __( 'All trails', 'fieldnotes-trails' ),
				'search_items'       => __( 'Search trails', 'fieldnotes-trails' ),
				'not_found'          => __( 'No trails found.', 'fieldnotes-trails' ),
				'archives'           => __( 'Trails', 'fieldnotes-trails' ),
				'item_published'     => __( 'Trail published.', 'fieldnotes-trails' ),
				'item_updated'       => __( 'Trail updated.', 'fieldnotes-trails' ),
				'menu_name'          => __( 'Trails', 'fieldnotes-trails' ),
			),
			'description'   => __( 'Routes we have walked, with their facts and a log of conditions.', 'fieldnotes-trails' ),
			'public'        => true,
			'show_in_rest'  => true,
			'has_archive'   => 'trails',
			'rewrite'       => array(
				'slug'       => 'trails',
				'with_front' => false,
			),
			'menu_position' => 5,
			'menu_icon'     => 'dashicons-location-alt',
			'supports'      => array( 'title', 'editor', 'excerpt', 'thumbnail', 'custom-fields', 'comments', 'revisions', 'author' ),
		)
	);

	register_taxonomy(
		'region',
		array( 'trail' ),
		array(
			'labels'            => array(
				'name'          => __( 'Regions', 'fieldnotes-trails' ),
				'singular_name' => __( 'Region', 'fieldnotes-trails' ),
				'all_items'     => __( 'All regions', 'fieldnotes-trails' ),
				'edit_item'     => __( 'Edit region', 'fieldnotes-trails' ),
				'add_new_item'  => __( 'Add region', 'fieldnotes-trails' ),
			),
			'hierarchical'      => true,
			'show_in_rest'      => true,
			'show_admin_column' => true,
			'rewrite'           => array(
				'slug'       => 'region',
				'with_front' => false,
			),
		)
	);

	foreach ( fieldnotes_trails_facts() as $key => [ $label, $description ] ) {
		register_post_meta(
			'trail',
			$key,
			array(
				'type'              => 'string',
				'label'             => $label,
				'description'       => $description,
				'single'            => true,
				'default'           => '',
				'show_in_rest'      => true,
				'sanitize_callback' => 'sanitize_text_field',
				'auth_callback'     => static fn () => current_user_can( 'edit_posts' ),
			)
		);
	}

	// The conditions log: a list of dated reports, newest first, read by the
	// trail-conditions block. Kept out of REST; reports come from the seed or
	// from a wp-cli command.
	register_post_meta(
		'trail',
		'_fieldnotes_conditions',
		array(
			'type'         => 'array',
			'single'       => true,
			'show_in_rest' => false,
		)
	);
}
add_action( 'init', 'fieldnotes_trails_register_content_model' );

/**
 * The conditions log of a trail: [ ['date' => Y-m-d, 'status' => open|wet|closed, 'note' => text], ... ], newest first.
 */
function fieldnotes_trails_conditions( int $post_id ): array {
	$log = get_post_meta( $post_id, '_fieldnotes_conditions', true );
	if ( ! is_array( $log ) ) {
		return array();
	}
	$log = array_values(
		array_filter(
			$log,
			static fn ( $r ) => is_array( $r ) && ! empty( $r['date'] ) && ! empty( $r['status'] )
		)
	);
	usort( $log, static fn ( $a, $b ) => strcmp( $b['date'], $a['date'] ) );
	return $log;
}

/**
 * A trail's seasons as lower-case words; "all" for a trail that walks all year.
 */
function fieldnotes_trails_seasons( int $post_id ): array {
	$season = strtolower( (string) get_post_meta( $post_id, 'season', true ) );
	if ( str_contains( $season, 'all' ) ) {
		return array( 'all' );
	}
	return array_values( array_filter( array_map( 'trim', preg_split( '/[,&]|\band\b/', $season ) ) ) );
}
