<?php
/**
 * Fieldnotes, a made-up field journal built for Wanigan's demo by
 * scripts/demo-sites/build.sh in the Wanigan repository.
 *
 * Two environments share this code. Local is https://fieldnotes-demo.ddev.site;
 * Live is a stand-in at https://fieldnotes-live.127.0.0.1.nip.io (a name that
 * resolves to 127.0.0.1 only), serving a copy of the database (named "live")
 * with production's settings. The address a request came in on picks the
 * database and the site's addresses, before ddev's own settings load (they
 * only fill in what is still undefined).
 *
 * No keys or salts here: WordPress makes its own and keeps them in the
 * database when none are defined.
 */

$fieldnotes_host = $_SERVER['HTTP_HOST'] ?? '';

if ( 'fieldnotes-live.127.0.0.1.nip.io' === $fieldnotes_host ) {
	define( 'DB_NAME', 'live' );
	define( 'WP_HOME', 'https://fieldnotes-live.127.0.0.1.nip.io' );
	define( 'WP_SITEURL', 'https://fieldnotes-live.127.0.0.1.nip.io' );
	define( 'WP_ENVIRONMENT_TYPE', 'production' );
	define( 'WP_DEBUG', false );
	define( 'DISALLOW_FILE_EDIT', true );
} else {
	define( 'WP_HOME', 'https://fieldnotes-demo.ddev.site' );
	define( 'WP_SITEURL', 'https://fieldnotes-demo.ddev.site' );
	define( 'WP_ENVIRONMENT_TYPE', 'local' );
	define( 'WP_DEBUG', true );
	define( 'WP_DEBUG_LOG', true );
}
// Notices go to wp-content/debug.log, never into the page.
define( 'WP_DEBUG_DISPLAY', false );

define( 'DB_CHARSET', 'utf8mb4' );
define( 'DB_COLLATE', '' );
define( 'WP_POST_REVISIONS', 5 );
define( 'AUTOMATIC_UPDATER_DISABLED', true );

defined( 'ABSPATH' ) || define( 'ABSPATH', __DIR__ . '/' );

// ddev's settings: database user, password and host, and the table prefix.
$ddev_settings = __DIR__ . '/wp-config-ddev.php';
if ( getenv( 'IS_DDEV_PROJECT' ) === 'true' && is_readable( $ddev_settings ) ) {
	require_once $ddev_settings;
}

require_once ABSPATH . 'wp-settings.php';
