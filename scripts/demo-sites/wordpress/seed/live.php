<?php
/**
 * The Live stand-in's differences from Local. build.sh copies the local
 * database into "live", moves its addresses to fieldnotes-live.127.0.0.1.nip.io,
 * then runs this against it:
 *   ddev wp @live eval-file .demo-build/seed/live.php
 *
 * Live is a step behind, as production usually is: the tagline is the old
 * one, the latest weather log is still a draft there, and the front page
 * still says summer. Search engines are allowed, as on a real site.
 */

defined( 'ABSPATH' ) || exit;

if ( 'live' !== DB_NAME ) {
	WP_CLI::error( 'live.php changes the Live stand-in only; run it with @live.' );
}

// As the admin, so content is saved exactly as it is (no HTML filtering).
wp_set_current_user( 1 );

$fn_find = static function ( string $key ): int {
	$ids = get_posts(
		array(
			'post_type'      => 'any',
			'post_status'    => 'any',
			'posts_per_page' => 1,
			'fields'         => 'ids',
			'meta_key'       => '_fieldnotes_key',
			'meta_value'     => $key,
		)
	);
	return $ids ? (int) $ids[0] : 0;
};

update_option( 'blogdescription', 'Trail notes and weather logs from the lake country' );
update_option( 'blog_public', 1 );

$fn_draft = $fn_find( 'post:quiet-week-then-frost' );
if ( $fn_draft ) {
	wp_update_post(
		array(
			'ID'          => $fn_draft,
			'post_status' => 'draft',
		)
	);
}

$fn_home = (int) get_option( 'page_on_front' );
if ( $fn_home ) {
	$fn_content = get_post_field( 'post_content', $fn_home );
	wp_update_post(
		array(
			'ID'           => $fn_home,
			'post_content' => wp_slash( str_replace( 'Volume 7 · Autumn 2026', 'Volume 7 · Summer 2026', $fn_content ) ),
		)
	);
}

WP_CLI::success( 'Live: older tagline, latest weather log unpublished, the front page a season behind.' );
