<?php

/**
 * @file
 * The made-up content: people, terms, pictures, products, journal entries,
 * events and pages, with French translations, drafts and revision history.
 */

$data = dirname(__DIR__) . '/content';

/* ── people ───────────────────────────────────────────────────────────── */

$people = [];
foreach (['dana' => ['Dana Reyes', 'content_editor'], 'sam' => ['Sam Okafor', 'author'], 'mika' => ['Mika Lindqvist', 'author']] as $login => [$name, $role]) {
  $people[$login] = ns_content('user', "person:$login", [
    'name' => $name,
    'mail' => "$login@northstar.example",
    'status' => 1,
    'roles' => [$role],
    'timezone' => 'America/Chicago',
  ]);
}
ns_say('people: Dana (editor), Sam and Mika (authors)');

/* ── terms ────────────────────────────────────────────────────────────── */

$categories = [];
$category_words = [
  'Drinkware' => ['Tasses et gourdes', 'Mugs and bottles in enamel and steel, for the dock rail and the camp stove.', 'lakeside-enamel-mug-1.jpg'],
  'Bags' => ['Sacs', 'Canvas totes and a roll-top pack that keep a downpour out of your lunch.', 'rolltop-day-pack-1.jpg'],
  'Prints' => ['Affiches', 'Lake maps and star charts, drawn by hand and printed on cotton paper.', 'silverpine-lake-map-1.jpg'],
  'Apparel' => ['Vêtements', 'Waxed caps and recycled wool beanies for when the wind turns.', 'waxed-field-cap-1.jpg'],
  'Paper goods' => ['Papeterie', 'Field journals that lie flat and take fountain pen ink.', 'field-journal-1.jpg'],
  'Camp' => ['Camp', 'A lantern and a wool blanket for the porch and the canoe bottom.', 'harbor-camp-lantern-1.jpg'],
];
$i = 0;
foreach ($category_words as $name => [$fr, $description, $picture]) {
  $slug = strtolower(str_replace(' ', '-', $name));
  $term = ns_content('taxonomy_term', "category:$name", [
    'vid' => 'category',
    'name' => $name,
    'weight' => $i++,
    'description' => ns_text("<p>$description</p>"),
    'path' => ['alias' => "/shop/category/$slug", 'pathauto' => 0],
  ]);
  $categories[$name] = $term;
  ns_translate($term, 'fr', ['name' => $fr, 'path' => ['alias' => "/shop/category/$slug", 'pathauto' => 0]]);
}
$materials = [];
foreach (['Enamelled steel', 'Stainless steel', 'Cotton canvas', 'Waxed canvas', 'Leather', 'Recycled wool', 'Cotton rag paper', 'Glass'] as $j => $name) {
  $slug = strtolower(str_replace(' ', '-', $name));
  $materials[$name] = ns_content('taxonomy_term', "material:$name", [
    'vid' => 'material',
    'name' => $name,
    'weight' => $j,
    'path' => ['alias' => "/shop/material/$slug", 'pathauto' => 0],
  ]);
}
ns_say('terms: six categories (with French names), eight materials');

/* ── products ─────────────────────────────────────────────────────────── */

$products = require "$data/products.php";
$made = [];
$when = strtotime('2026-09-28 09:00:00');
foreach ($products as $n => $p) {
  $media = [
    ns_media($p['slug'] . '-1.jpg', $p['alt'], $p['title']),
    ns_media($p['slug'] . '-2.jpg', $p['alt'] . ', close up', $p['title'] . ', close up'),
  ];
  $made[$p['slug']] = $node = ns_content('node', 'product:' . $p['slug'], [
    'type' => 'product',
    'langcode' => 'en',
    'title' => $p['title'],
    'uid' => $people['dana']->id(),
    'status' => 1,
    'moderation_state' => 'published',
    'promote' => (int) !empty($p['featured']),
    'created' => $when - $n * 86400,
    'field_price' => $p['price'],
    'field_compare_price' => $p['was'] ?? NULL,
    'field_category' => ['target_id' => $categories[$p['category']]->id()],
    'field_materials' => array_map(fn ($m) => ['target_id' => $materials[$m]->id()], $p['materials']),
    'field_highlights' => $p['highlights'],
    'field_badges' => $p['badges'],
    'field_media' => array_map(fn ($m) => ['target_id' => $m->id()], $media),
    'field_since' => $p['since'],
    'field_sku' => $p['sku'],
    'field_care' => ns_text($p['care']),
    'field_guide' => ['uri' => 'internal:/care', 'title' => 'Read the care guide'],
    'body' => ns_text($p['body']),
    'path' => ['alias' => '/shop/' . $p['slug'], 'pathauto' => 0],
  ]);
  ns_translate($node, 'fr', [
    'title' => $p['fr']['title'],
    'promote' => (int) !empty($p['featured']),
    'created' => $when - $n * 86400,
    'field_highlights' => $p['fr']['highlights'],
    'body' => ns_text($p['fr']['body']),
    'field_care' => ns_text($p['care']),
    'path' => ['alias' => '/shop/' . $p['slug'], 'pathauto' => 0],
    'moderation_state' => 'published',
  ]);
}
foreach ($products as $p) {
  $node = \Drupal::entityTypeManager()->getStorage('node')->load($made[$p['slug']]->id());
  $node->set('field_related', array_map(fn ($slug) => ['target_id' => $made[$slug]->id()], $p['related']));
  if ($node->hasTranslationChanges()) {
    $node->set('moderation_state', 'published');
    $node->save();
  }
}

/**
 * Makes sure a node's latest revision is a draft with these values, above
 * its published one: a change waiting for review.
 */
function ns_pending_draft(int $nid, array $values, string $log, $author): void {
  $storage = \Drupal::entityTypeManager()->getStorage('node');
  $latest = $storage->loadRevision($storage->getLatestRevisionId($nid));
  if (!$latest->isDefaultRevision()) {
    $same = TRUE;
    foreach ($values as $field => $value) {
      $want = is_array($value) ? trim((string) ($value['value'] ?? '')) : (string) $value;
      $have = trim((string) $latest->get($field)->value);
      $same = $same && (is_numeric($want) ? (float) $want === (float) $have : $want === $have);
    }
    if ($same) {
      return;
    }
  }
  // Saved as the person who wrote it, so the moderation state is theirs.
  $switcher = \Drupal::service('account_switcher');
  $switcher->switchTo($author);
  $draft = $storage->createRevision($latest, FALSE);
  foreach ($values as $field => $value) {
    $draft->set($field, $value);
  }
  $draft->set('moderation_state', 'draft');
  $draft->setRevisionLogMessage($log);
  $draft->setRevisionUserId($author->id());
  $draft->save();
  $switcher->switchBack();
}

foreach ($products as $p) {
  if (!empty($p['draft'])) {
    ns_pending_draft($made[$p['slug']]->id(), ['field_price' => $p['draft']['price'], 'body' => ns_text($p['draft']['body'])], $p['draft']['log'], $people['sam']);
  }
}
ns_say(count($made) . ' products (in French too), one with a draft waiting for review');

/* ── journal ──────────────────────────────────────────────────────────── */

$articles = require "$data/articles.php";
$tags = [];
foreach ($articles as $a) {
  $refs = [];
  foreach ($a['tags'] as $tag) {
    $slug = strtolower(str_replace(' ', '-', $tag));
    $tags[$tag] ??= ns_content('taxonomy_term', "tag:$tag", ['vid' => 'tags', 'name' => $tag, 'path' => ['alias' => "/journal/tag/$slug", 'pathauto' => 0]]);
    $refs[] = ['target_id' => $tags[$tag]->id()];
  }
  $state = $a['state'] ?? 'published';
  \Drupal::service('account_switcher')->switchTo($people[$a['author']]);
  $node = ns_content('node', 'article:' . $a['slug'], [
    'type' => 'article',
    'langcode' => 'en',
    'title' => $a['title'],
    'uid' => $people[$a['author']]->id(),
    'revision_uid' => $people[$a['author']]->id(),
    'status' => (int) ($state === 'published'),
    'moderation_state' => $state,
    'promote' => 0,
    'created' => strtotime($a['date']),
    'field_image' => ns_image($a['image'], $a['alt']),
    'field_tags' => $refs,
    'field_trip' => isset($a['trip']) ? ['value' => $a['trip'][0], 'end_value' => $a['trip'][1]] : NULL,
    'field_products' => array_map(fn ($slug) => ['target_id' => $made[$slug]->id()], $a['products'] ?? []),
    'body' => ns_text($a['body']),
    'path' => ['alias' => '/journal/' . $a['slug'], 'pathauto' => 0],
  ]);
  \Drupal::service('account_switcher')->switchBack();
  if (!empty($a['fr'])) {
    ns_translate($node, 'fr', [
      'title' => $a['fr']['title'],
      'created' => strtotime($a['date']),
      'body' => ns_text($a['fr']['body']),
      'path' => ['alias' => '/journal/' . $a['slug'], 'pathauto' => 0],
      'moderation_state' => 'published',
    ]);
  }
}
ns_say(count($articles) . ' journal entries (two in French, one still a draft)');

/* ── events ───────────────────────────────────────────────────────────── */

$events = require "$data/events.php";
foreach ($events as $e) {
  ns_content('node', 'event:' . $e['slug'], [
    'type' => 'event',
    'langcode' => 'en',
    'title' => $e['title'],
    'uid' => $people['mika']->id(),
    'status' => 1,
    'moderation_state' => 'published',
    'field_when' => ['value' => $e['start'], 'end_value' => $e['end']],
    'field_where' => $e['where'],
    'field_media' => ['target_id' => ns_media($e['image'], $e['alt'])->id()],
    'field_link' => ['uri' => 'internal:/contact', 'title' => $e['link']],
    'body' => ns_text($e['body']),
    'path' => ['alias' => '/events/' . $e['slug'], 'pathauto' => 0],
  ]);
}
ns_say(count($events) . ' events');

/* ── pages ────────────────────────────────────────────────────────────── */

$pages = require "$data/pages.php";
$page_nodes = [];
foreach ($pages as $slug => $pg) {
  $existing = ns_find('node', "page:$slug");
  // A page made for the first time gets its earlier revisions first, so its
  // history has something to show.
  if (!$existing && !empty($pg['history'])) {
    $first = TRUE;
    foreach ($pg['history'] as [$who, $log, $body]) {
      $node = $first
        ? \Drupal::entityTypeManager()->getStorage('node')->create(['uuid' => ns_uuid("node:page:$slug"), 'type' => 'page', 'langcode' => 'en', 'title' => $pg['title'], 'uid' => $people[$who]->id(), 'path' => ['alias' => "/$slug", 'pathauto' => 0]])
        : \Drupal::entityTypeManager()->getStorage('node')->load($node->id());
      $node->set('body', ns_text($body));
      $node->set('moderation_state', 'published');
      $node->setNewRevision(TRUE);
      $node->setRevisionLogMessage($log);
      $node->setRevisionUserId($people[$who]->id());
      $node->save();
      $first = FALSE;
    }
  }
  $page_nodes[$slug] = $node = ns_content('node', "page:$slug", [
    'type' => 'page',
    'langcode' => 'en',
    'title' => $pg['title'],
    'uid' => $people['dana']->id(),
    'status' => 1,
    'moderation_state' => 'published',
    'promote' => 0,
    'body' => ns_text($pg['body']),
    'revision_log' => 'Dana: tightened the opening, added who we are',
    'path' => ['alias' => "/$slug", 'pathauto' => 0],
  ]);
  if (!empty($pg['fr'])) {
    ns_translate($node, 'fr', ['title' => $pg['fr']['title'], 'body' => ns_text($pg['fr']['body']), 'path' => ['alias' => "/$slug", 'pathauto' => 0], 'moderation_state' => 'published']);
  }
}
ns_say(count($page_nodes) . ' pages (the about page with a revision history)');
