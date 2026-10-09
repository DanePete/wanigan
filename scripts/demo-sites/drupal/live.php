<?php

/**
 * @file
 * Makes the Live stand-in's database look like production a step behind
 * Local: development settings off, the older hero and shipping words, a
 * higher price on one product, and the newest product not yet published.
 * Run against the copy with drush --uri=https://northstar-live.localtest.me.
 */

$db = \Drupal::database()->getConnectionOptions()['database'] ?? '';
if ($db !== 'live') {
  throw new \RuntimeException("live.php changes only the Live copy; this is '$db'.");
}

\Drupal::keyValue('development_settings')->setMultiple([
  'twig_debug' => FALSE,
  'twig_cache_disable' => FALSE,
  'disable_rendered_output_cache_bins' => FALSE,
]);

$load = function (string $type, string $name) {
  $h = md5('northstar-demo:' . $name);
  $uuid = sprintf('%s-%s-4%s-a%s-%s', substr($h, 0, 8), substr($h, 8, 4), substr($h, 13, 3), substr($h, 17, 3), substr($h, 20, 12));
  $found = \Drupal::entityTypeManager()->getStorage($type)->loadByProperties(['uuid' => $uuid]);
  return $found ? reset($found) : NULL;
};

// The words on the front page, as they were before this autumn's changes.
$home = $load('node', 'node:landing:home');
foreach ($home->get('layout_builder__layout')->getSections() as $section) {
  foreach ($section->getComponents() as $component) {
    $id = $component->get('block_revision_id');
    if (!$id) {
      continue;
    }
    $block = \Drupal::entityTypeManager()->getStorage('block_content')->loadRevision($id);
    if ($block->bundle() === 'hero') {
      $block->set('field_kicker', 'The summer range');
      $block->set('field_heading', 'Goods for long days outside');
    }
    if ($block->bundle() === 'callout') {
      $block->set('field_heading', 'Free shipping over $100');
    }
    $block->setNewRevision(FALSE);
    $block->save();
  }
}
$banner = $load('block_content', 'block:free-shipping');
$banner->set('body', ['value' => '<p>Free shipping on orders over $100.</p>', 'format' => 'basic_html']);
$banner->save();

$pack = $load('node', 'product:rolltop-day-pack');
$pack->set('field_price', '95.00');
$pack->save();
$lantern = $load('node', 'product:harbor-camp-lantern');
$lantern->setUnpublished();
$lantern->save();

echo "  · Live copy: development settings off, older words, one price, one product not yet out\n";
