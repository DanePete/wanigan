<?php
/**
 * Fieldnotes' settings, people and content. build.sh runs it with
 *   ddev wp eval-file .demo-build/seed/seed.php
 * after the theme and plugin are in place and the pictures are drawn into
 * .demo-images. Safe to run again: everything is found by a stable key and
 * updated in place (see lib.php), so ids stay the same and nothing doubles.
 */

defined( 'ABSPATH' ) || exit;

require __DIR__ . '/lib.php';

// As the admin, so content is saved exactly as written (no HTML filtering).
wp_set_current_user( 1 );

/* ── Settings ─────────────────────────────────────────────────────────── */

$fn_options = array(
	'blogname'                      => 'Fieldnotes',
	'blogdescription'               => 'A field journal of trails, weather and small observations',
	'admin_email'                   => 'admin@fieldnotes.example',
	'permalink_structure'           => '/%postname%/',
	'timezone_string'               => 'America/Chicago',
	'date_format'                   => 'j F Y',
	'time_format'                   => 'H:i',
	'start_of_week'                 => 1,
	'posts_per_page'                => 9,
	'blog_public'                   => 0,
	'uploads_use_yearmonth_folders' => 0,
	'default_comment_status'        => 'open',
	'default_ping_status'           => 'closed',
	'default_pingback_flag'         => 0,
	'comment_moderation'            => 0,
	'comment_previously_approved'   => 0,
	'comments_notify'               => 0,
	'moderation_notify'             => 0,
	'require_name_email'            => 1,
	'thread_comments'               => 1,
	'thread_comments_depth'         => 3,
	'show_avatars'                  => 0,
	'close_comments_for_old_posts'  => 0,
	'large_size_w'                  => 1600,
	'large_size_h'                  => 1600,
	'medium_large_size_w'           => 960,
	'medium_large_size_h'           => 0,
	'wp_page_for_privacy_policy'    => 0,
);
foreach ( $fn_options as $fn_name => $fn_value ) {
	if ( (string) get_option( $fn_name ) !== (string) $fn_value ) {
		update_option( $fn_name, $fn_value );
	}
}
global $wp_rewrite;
$wp_rewrite->set_permalink_structure( '/%postname%/' );
WP_CLI::log( '  · settings' );

/* ── People ───────────────────────────────────────────────────────────── */

wp_update_user(
	array(
		'ID'           => 1,
		'display_name' => 'Fieldnotes',
		'nickname'     => 'Fieldnotes',
		'user_email'   => 'admin@fieldnotes.example',
	)
);
$fn_people = array(
	'maren' => fn_user( 'maren', 'Maren Holt', 'maren@fieldnotes.example', 'Keeps the weather log and walks most of the trails twice: once to learn them, once to write them up. Trained as a surveyor, which explains the tables.' ),
	'jonah' => fn_user( 'jonah', 'Jonah Reyes', 'jonah@fieldnotes.example', 'Draws the maps, mends the kit and writes the essays when the weather keeps us in. Has paddled every lake in the region and capsized in two of them.' ),
);
WP_CLI::log( '  · people: admin, maren, jonah' );

/* ── Sections, tags and regions ───────────────────────────────────────── */

fn_term( 'category', 'trail-notes', 'Trail notes', 'What a trail was like on the day we walked it: the ground, the light, the water, and anything that was first or last of the year.' );
fn_term( 'category', 'gear', 'Gear', 'The kit we carry, what it weighs, how we mend it, and the arguments about it.' );
fn_term( 'category', 'weather-log', 'Weather log', 'A week of readings from the cabin wall at six every evening, and what the numbers say about the week.' );
fn_term( 'category', 'essays', 'Essays', 'The things that will not fit in a table.' );
foreach ( array( 'frost', 'birch', 'autumn', 'wind', 'rain', 'river', 'summer', 'night', 'camp', 'maps', 'navigation', 'marsh', 'fog', 'snow', 'winter', 'sunrise', 'ridge', 'ice', 'paddling', 'repair', 'notebook', 'storm' ) as $fn_tag ) {
	fn_term( 'post_tag', $fn_tag, $fn_tag );
}
fn_term( 'region', 'tamarack-lakes', 'Tamarack Lakes', 'Two big lakes and a dozen small ones, joined by portages and ringed with tamarack: the country around the cabin.' );
fn_term( 'region', 'basswood-hills', 'Basswood Hills', 'The high ground to the west: a long granite ridge, open on top, and the spurs that run off it.' );
fn_term( 'region', 'cedar-river-valley', 'Cedar River Valley', 'Old cedar and hemlock along a river that floods every spring, and a high meadow with the darkest skies in the region.' );
fn_term( 'wp_pattern_category', 'fieldnotes', 'Fieldnotes' );
WP_CLI::log( '  · sections, tags, regions' );

/* ── Pictures ─────────────────────────────────────────────────────────── */

$fn_pictures = require __DIR__ . '/content/pictures.php';
foreach ( $fn_pictures as $fn_name => [ $fn_title, $fn_alt ] ) {
	fn_picture( $fn_name, $fn_title, $fn_alt );
}
WP_CLI::log( '  · pictures: ' . count( $fn_pictures ) );

/* ── Synced patterns ──────────────────────────────────────────────────── */

$fn_synced = array(
	'field-letter'   => array( 'The field letter', static fn () => fn_expand( pattern( 'fieldnotes/field-letter' ) ) ),
	'leave-no-trace' => array(
		'Leave it as you found it',
		static fn () => group(
			p( 'Leave it as you found it', array( 'className' => 'fn-label', 'textColor' => 'accent' ) )
			. p( 'Carry out everything you carried in, including the orange peel. Stay on the trail where it is marked and on the boards where there are boards. Fires only in the rings at the campsites, and only when the fire danger sign says so. Close every gate behind you.' )
			. p( 'Most of these trails cross land that someone has let us walk on. It stays that way if we leave no trace that we did.', array( 'textColor' => 'muted', 'fontSize' => 'small' ) ),
			array(
				'className' => 'is-style-card fn-pad',
				'name'      => 'Leave it as you found it',
			)
		),
	),
	'weather-method' => array(
		'How we keep the log',
		static fn () => group(
			p( 'How we keep the log', array( 'className' => 'fn-label', 'textColor' => 'accent' ) )
			. p( 'Readings are taken at six in the evening: temperature from a brass thermometer on the north wall of the cabin, pressure from a mechanical barometer in the hall, rain from a gauge on the fence post by the dock. Wind is judged on the Beaufort scale from the end of the dock.', array( 'fontSize' => 'small' ) )
			. p( 'We are not a weather station. We are two people who write things down at the same time every day.', array( 'textColor' => 'muted', 'fontSize' => 'small' ) ),
			array(
				'className' => 'is-style-card fn-pad',
				'name'      => 'How we keep the log',
			)
		),
	),
);
foreach ( $fn_synced as $fn_key => [ $fn_title, $fn_content ] ) {
	fn_post(
		"block:{$fn_key}",
		array(
			'post_type'    => 'wp_block',
			'post_name'    => $fn_key,
			'post_title'   => $fn_title,
			'post_content' => $fn_content(),
			'post_date'    => '2025-01-15 09:00:00',
			'terms'        => array( 'wp_pattern_category' => array( 'fieldnotes' ) ),
		)
	);
}
WP_CLI::log( '  · synced patterns: ' . count( $fn_synced ) );

/* ── Journal entries ──────────────────────────────────────────────────── */

$fn_posts  = require __DIR__ . '/content/posts.php';
$fn_sticky = array();
foreach ( $fn_posts as $fn_key => $fn_post ) {
	$fn_id = fn_post(
		"post:{$fn_key}",
		array(
			'post_type'      => 'post',
			'post_name'      => $fn_post['slug'],
			'post_title'     => $fn_post['title'],
			'post_excerpt'   => $fn_post['excerpt'],
			'post_content'   => $fn_post['content'](),
			'post_date'      => $fn_post['date'],
			'post_author'    => $fn_people[ $fn_post['author'] ],
			'comment_status' => 'open',
			'terms'          => array(
				'category' => array( $fn_post['category'] ),
				'post_tag' => $fn_post['tags'],
			),
			'picture'        => $fn_post['picture'],
		)
	);
	if ( ! empty( $fn_post['sticky'] ) ) {
		$fn_sticky[] = $fn_id;
	}
}
if ( get_option( 'sticky_posts' ) !== $fn_sticky ) {
	update_option( 'sticky_posts', $fn_sticky );
}
WP_CLI::log( '  · journal entries: ' . count( $fn_posts ) );

/* ── Trails ───────────────────────────────────────────────────────────── */

$fn_trails = require __DIR__ . '/content/trails.php';
foreach ( $fn_trails as $fn_slug => $fn_trail ) {
	[ $fn_distance, $fn_gain, $fn_difficulty, $fn_season, $fn_trailhead ] = $fn_trail['facts'];
	fn_post(
		"trail:{$fn_slug}",
		array(
			'post_type'      => 'trail',
			'post_name'      => $fn_slug,
			'post_title'     => $fn_trail['title'],
			'post_excerpt'   => $fn_trail['excerpt'],
			'post_content'   => $fn_trail['content'](),
			'post_date'      => $fn_trail['date'],
			'post_author'    => $fn_people['maren'],
			'menu_order'     => $fn_trail['order'],
			'comment_status' => 'open',
			'meta'           => array(
				'distance'               => $fn_distance,
				'elevation_gain'         => $fn_gain,
				'difficulty'             => $fn_difficulty,
				'season'                 => $fn_season,
				'trailhead'              => $fn_trailhead,
				'_fieldnotes_conditions' => array_map(
					static fn ( $r ) => array(
						'date'   => $r[0],
						'status' => $r[1],
						'note'   => $r[2],
					),
					$fn_trail['conditions']
				),
			),
			'terms'          => array( 'region' => array( $fn_trail['region'] ) ),
			'picture'        => $fn_trail['picture'],
		)
	);
}
WP_CLI::log( '  · trails: ' . count( $fn_trails ) );

/* ── Pages ────────────────────────────────────────────────────────────── */

$fn_pages = require __DIR__ . '/content/pages.php';
foreach ( $fn_pages as $fn_key => $fn_page ) {
	fn_post(
		"page:{$fn_key}",
		array(
			'post_type'    => 'page',
			'post_name'    => $fn_page['slug'],
			'post_title'   => $fn_page['title'],
			'post_excerpt' => $fn_page['excerpt'] ?? '',
			'post_content' => $fn_page['content'](),
			'post_date'    => '2025-01-15 09:00:00',
			'post_author'  => 1,
			'post_parent'  => ! empty( $fn_page['parent'] ) ? fn_post_id( "page:{$fn_page['parent']}" ) : 0,
			'menu_order'   => $fn_page['order'],
			'meta'         => array( '_wp_page_template' => $fn_page['template'] ?: 'default' ),
			'picture'      => $fn_page['picture'] ?? null,
		)
	);
}
foreach ( array(
	'show_on_front'  => 'page',
	'page_on_front'  => fn_post_id( 'page:home' ),
	'page_for_posts' => fn_post_id( 'page:journal' ),
) as $fn_name => $fn_value ) {
	if ( (string) get_option( $fn_name ) !== (string) $fn_value ) {
		update_option( $fn_name, $fn_value );
	}
}
WP_CLI::log( '  · pages: ' . count( $fn_pages ) );

/* ── The main menu: a Navigation block menu with submenus ─────────────── */

$fn_cat  = static fn ( string $slug ) => get_term_by( 'slug', $slug, 'category' );
$fn_reg  = static fn ( string $slug ) => get_term_by( 'slug', $slug, 'region' );
$fn_term_link = static function ( WP_Term $term, string $kind_type ): string {
	return dynamic(
		'navigation-link',
		array(
			'label' => $term->name,
			'type'  => $kind_type,
			'id'    => $term->term_id,
			'url'   => get_term_link( $term ),
			'kind'  => 'taxonomy',
		)
	);
};
$fn_page_link = static function ( string $key, string $label ) {
	$id = fn_post_id( "page:{$key}" );
	return array(
		'label' => $label,
		'type'  => 'page',
		'id'    => $id,
		'url'   => get_permalink( $id ),
		'kind'  => 'post-type',
	);
};
$fn_menu  = fn_block( 'navigation-submenu', $fn_page_link( 'journal', 'Journal' ), trim( implode( '', array_map( static fn ( $s ) => $fn_term_link( $fn_cat( $s ), 'category' ), array( 'trail-notes', 'gear', 'weather-log', 'essays' ) ) ) ) );
$fn_menu .= fn_block(
	'navigation-submenu',
	array(
		'label' => 'Trails',
		'type'  => 'trail',
		'url'   => get_post_type_archive_link( 'trail' ),
		'kind'  => 'post-type-archive',
	),
	trim( implode( '', array_map( static fn ( $s ) => $fn_term_link( $fn_reg( $s ), 'region' ), array( 'tamarack-lakes', 'basswood-hills', 'cedar-river-valley' ) ) ) )
);
$fn_menu .= dynamic( 'navigation-link', $fn_page_link( 'gear-checklist', 'Gear checklist' ) );
$fn_menu .= dynamic( 'navigation-link', $fn_page_link( 'almanac', 'Almanac' ) );
$fn_menu .= fn_block( 'navigation-submenu', $fn_page_link( 'about', 'About' ), trim( dynamic( 'navigation-link', $fn_page_link( 'colophon', 'Colophon' ) ) . dynamic( 'navigation-link', $fn_page_link( 'contact', 'Write to us' ) ) ) );
fn_post(
	'navigation:main',
	array(
		'post_type'    => 'wp_navigation',
		'post_name'    => 'main-menu',
		'post_title'   => 'Main menu',
		'post_content' => $fn_menu,
		'post_date'    => '2025-01-15 09:00:00',
	)
);
WP_CLI::log( '  · main menu' );

/* ── Readers' notes ───────────────────────────────────────────────────── */

$fn_comments = require __DIR__ . '/content/comments.php';
foreach ( $fn_comments as $fn_key => $fn_c ) {
	[ $fn_where, $fn_name, $fn_email, $fn_date, $fn_text, $fn_reply ] = $fn_c;
	$fn_login = $fn_c[6] ?? '';
	$fn_user  = $fn_login ? get_user_by( 'login', $fn_login ) : null;
	fn_comment(
		"comment:{$fn_key}",
		fn_post_id( $fn_where ),
		array(
			'comment_author'       => $fn_name,
			'comment_author_email' => $fn_user ? $fn_user->user_email : $fn_email,
			'comment_author_url'   => '',
			'comment_date'         => $fn_date,
			'comment_content'      => $fn_text,
			'comment_parent'       => $fn_reply ? (int) get_comments(
				array(
					'meta_key'   => '_fieldnotes_key',
					'meta_value' => "comment:{$fn_reply}",
					'number'     => 1,
					'fields'     => 'ids',
				)
			)[0] : 0,
			'user_id'              => $fn_user ? $fn_user->ID : 0,
		)
	);
}
foreach ( array_unique( array_map( static fn ( $c ) => fn_post_id( $c[0] ), $fn_comments ) ) as $fn_id ) {
	wp_update_comment_count_now( $fn_id );
}
WP_CLI::log( "  · readers' notes: " . count( $fn_comments ) );

/* ── Put back what a visit to the editors may have changed ────────────── */

// WordPress's own first post, page and privacy page draft.
foreach ( array( array( 'hello-world', 'post' ), array( 'sample-page', 'page' ), array( 'privacy-policy', 'page' ) ) as [ $fn_slug, $fn_type ] ) {
	$fn_found = get_page_by_path( $fn_slug, OBJECT, $fn_type );
	if ( $fn_found && ! get_post_meta( $fn_found->ID, '_fieldnotes_key', true ) ) {
		wp_delete_post( $fn_found->ID, true );
	}
}
// Menus WordPress made by itself (it makes one from the page list when it
// finds none): the header shows main-menu.
foreach ( get_posts(
	array(
		'post_type'      => 'wp_navigation',
		'post_status'    => 'any',
		'posts_per_page' => -1,
		'fields'         => 'ids',
	)
) as $fn_id ) {
	if ( ! get_post_meta( $fn_id, '_fieldnotes_key', true ) ) {
		wp_delete_post( $fn_id, true );
	}
}
// Templates, parts and global styles saved from the site editor override the
// theme's files; the build puts the theme's own back.
foreach ( get_posts(
	array(
		'post_type'      => array( 'wp_template', 'wp_template_part', 'wp_global_styles' ),
		'post_status'    => 'any',
		'posts_per_page' => -1,
		'fields'         => 'ids',
	)
) as $fn_id ) {
	wp_delete_post( $fn_id, true );
}

$fn_count = static fn ( string $type ) => (int) array_sum( (array) wp_count_posts( $type ) );
WP_CLI::success(
	sprintf(
		'Fieldnotes: %d entries, %d trails, %d pages, %d synced patterns, %d pictures, %d readers\' notes.',
		$fn_count( 'post' ),
		$fn_count( 'trail' ),
		$fn_count( 'page' ),
		$fn_count( 'wp_block' ),
		$fn_count( 'attachment' ),
		(int) get_comments( array( 'count' => true ) )
	)
);
