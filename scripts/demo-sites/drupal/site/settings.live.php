
/**
 * The Live stand-in for Wanigan's demo: this same code serving a copy of the
 * database at another address, so the live view can compare Local with Live.
 * Written by scripts/demo-sites/build.sh in the Wanigan repository.
 */
if (($_SERVER['HTTP_HOST'] ?? '') === 'northstar-live.localtest.me') {
  $databases['default']['default']['database'] = 'live';
  $config['system.performance']['css']['preprocess'] = TRUE;
  $config['system.performance']['js']['preprocess'] = TRUE;
}
