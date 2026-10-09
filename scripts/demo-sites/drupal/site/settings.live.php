<?php

/**
 * @file
 * The Live stand-in for Wanigan's demo: this same code serving a copy of the
 * database at another address, so the live view can compare Local with Live.
 * Copied here by scripts/demo-sites/build.sh in the Wanigan repository, and
 * included from the end of settings.php.
 */

if (($_SERVER['HTTP_HOST'] ?? '') === 'northstar-live.127.0.0.1.nip.io') {
  $databases['default']['default']['database'] = 'live';
  // Production serves CSS and JavaScript aggregated.
  $config['system.performance']['css']['preprocess'] = TRUE;
  $config['system.performance']['js']['preprocess'] = TRUE;
}
