<?php
/**
 * Plugin Name:       Fieldnotes Trails
 * Description:       Trails for the Fieldnotes journal: the Trail post type and its Region taxonomy, trail facts as post meta for block bindings, and three blocks (a trail finder, a conditions log and season figures).
 * Version:           1.0.0
 * Requires at least: 7.0
 * Requires PHP:      8.1
 * Author:            Fieldnotes
 * License:           GPL-2.0-or-later
 * Text Domain:       fieldnotes-trails
 *
 * Made up for Wanigan's demo: every trail, region and report is invented.
 */

defined( 'ABSPATH' ) || exit;

const FIELDNOTES_TRAILS_VERSION = '1.0.0';

require __DIR__ . '/includes/content-model.php';
require __DIR__ . '/includes/queries.php';
require __DIR__ . '/includes/blocks.php';

register_activation_hook(
	__FILE__,
	static function () {
		fieldnotes_trails_register_content_model();
		flush_rewrite_rules();
	}
);
