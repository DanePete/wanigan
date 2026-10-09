<?php

/**
 * @file
 * Seeds the Northstar Storefront demo. Run by build.sh with drush
 * php:script. Safe to run again: each thing is created when missing and set
 * back to these values when present; content is matched by UUIDs derived
 * from names, so node ids stay the same and nothing is duplicated.
 */

echo "Northstar Storefront: content model, content and site\n";
require __DIR__ . '/seed/lib.php';
require __DIR__ . '/seed/model.php';
require __DIR__ . '/seed/content.php';
require __DIR__ . '/seed/site.php';
echo "Done.\n";
