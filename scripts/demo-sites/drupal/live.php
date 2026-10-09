<?php

/**
 * @file
 * Makes the Live stand-in's database look like production a step behind
 * Local: development settings off, the older hero and shipping words, a
 * higher price on one product, and the newest product not yet published.
 * Run against the copy with drush --uri=https://northstar-live.127.0.0.1.nip.io.
 */

require __DIR__ . '/seed/lib.php';

$db = \Drupal::database()->getConnectionOptions()['database'] ?? '';
if ($db !== 'live') {
  throw new \RuntimeException("live.php changes only the Live copy; this is '$db'.");
}

\Drupal::keyValue('development_settings')->setMultiple([
  'twig_debug' => FALSE,
  'twig_cache_disable' => FALSE,
  'disable_rendered_output_cache_bins' => FALSE,
]);

$hero = ns_find('block_content', 'block:home-hero');
$hero->set('field_kicker', 'The summer range');
$hero->set('field_heading', 'Goods for long days outside');
$hero->save();
$callout = ns_find('block_content', 'block:home-callout');
$callout->set('field_heading', 'Free shipping over $100');
$callout->save();
$banner = ns_find('block_content', 'block:free-shipping');
$banner->set('body', ns_text('<p>Free shipping on orders over $100.</p>'));
$banner->save();

$pack = ns_find('node', 'product:rolltop-day-pack');
$pack->set('field_price', '95.00');
$pack->set('moderation_state', 'published');
$pack->save();
$beanie = ns_find('node', 'product:storm-wool-beanie');
$beanie->set('moderation_state', 'archived');
$beanie->save();

echo "  · Live copy: development settings off, older words, one price, one product not out yet\n";
