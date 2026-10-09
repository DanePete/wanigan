<?php

/**
 * @file
 * Seeds the Northstar Storefront demo: content model, pictures, made-up
 * content, views, blocks, menus and the Layout Builder front page.
 *
 * Run by build.sh with `drush php:script`. Safe to run again: each thing is
 * created when missing and set back to these values when present. Content is
 * matched by a UUID derived from its name, so a rerun updates it in place and
 * node ids stay the same.
 */

use Drupal\block\Entity\Block;
use Drupal\block_content\Entity\BlockContent;
use Drupal\block_content\Entity\BlockContentType;
use Drupal\Core\Entity\ContentEntityInterface;
use Drupal\field\Entity\FieldConfig;
use Drupal\field\Entity\FieldStorageConfig;
use Drupal\file\Entity\File;
use Drupal\image\Entity\ImageStyle;
use Drupal\layout_builder\Section;
use Drupal\layout_builder\SectionComponent;
use Drupal\menu_link_content\Entity\MenuLinkContent;
use Drupal\node\Entity\Node;
use Drupal\node\Entity\NodeType;
use Drupal\taxonomy\Entity\Term;
use Drupal\taxonomy\Entity\Vocabulary;
use Drupal\user\Entity\User;
use Drupal\views\Entity\View;

$build = getenv('DEMO_BUILD') ?: '/var/www/html/.demo-build';
$images = getenv('DEMO_IMAGES') ?: '/var/www/html/.demo-images';
$theme = 'northstar';

/* ── helpers ──────────────────────────────────────────────────────────── */

function ns_say(string $what): void {
  echo "  · $what\n";
}

/** A UUID that is always the same for the same name. */
function ns_uuid(string $name): string {
  $h = md5('northstar-demo:' . $name);
  return sprintf('%s-%s-4%s-a%s-%s', substr($h, 0, 8), substr($h, 8, 4), substr($h, 13, 3), substr($h, 17, 3), substr($h, 20, 12));
}

/** Loads a content entity by the UUID its name gives, or creates it; sets the values; saves only when something changed. */
function ns_content(string $type, string $name, array $values): ContentEntityInterface {
  $storage = \Drupal::entityTypeManager()->getStorage($type);
  $uuid = ns_uuid("$type:$name");
  $found = $storage->loadByProperties(['uuid' => $uuid]);
  $entity = $found ? reset($found) : $storage->create(['uuid' => $uuid] + $values);
  if (!$entity->isNew()) {
    foreach ($values as $field => $value) {
      $entity->set($field, $value);
    }
  }
  if ($entity->isNew() || $entity->hasTranslationChanges()) {
    $entity->save();
  }
  return $entity;
}

/** Loads a config entity or creates it, then sets the values and saves. */
function ns_config(string $type, string $id, array $values) {
  $storage = \Drupal::entityTypeManager()->getStorage($type);
  $entity = $storage->load($id) ?: $storage->create([$storage->getEntityType()->getKey('id') => $id] + $values);
  foreach ($values as $key => $value) {
    $entity->set($key, $value);
  }
  $entity->save();
  return $entity;
}

function ns_field(string $entity_type, string $bundle, string $name, string $type, string $label, array $options = []): void {
  if (!FieldStorageConfig::loadByName($entity_type, $name)) {
    FieldStorageConfig::create([
      'entity_type' => $entity_type,
      'field_name' => $name,
      'type' => $type,
      'cardinality' => $options['cardinality'] ?? 1,
      'settings' => $options['storage'] ?? [],
    ])->save();
  }
  else {
    $storage = FieldStorageConfig::loadByName($entity_type, $name);
    if (isset($options['storage']['allowed_values'])) {
      $storage->setSetting('allowed_values', $options['storage']['allowed_values'])->save();
    }
  }
  $field = FieldConfig::loadByName($entity_type, $bundle, $name) ?: FieldConfig::create([
    'entity_type' => $entity_type,
    'bundle' => $bundle,
    'field_name' => $name,
  ]);
  $field->set('label', $label);
  $field->set('required', $options['required'] ?? FALSE);
  $field->set('description', $options['description'] ?? '');
  foreach ($options['settings'] ?? [] as $key => $value) {
    $field->setSetting($key, $value);
  }
  $field->save();
}

/** Sets a display's components to exactly these, hiding the rest. */
function ns_display(string $kind, string $entity_type, string $bundle, string $mode, array $components): void {
  $repo = \Drupal::service('entity_display.repository');
  $display = $kind === 'view' ? $repo->getViewDisplay($entity_type, $bundle, $mode) : $repo->getFormDisplay($entity_type, $bundle, $mode);
  $display->setStatus(TRUE);
  foreach (array_keys($display->getComponents()) as $name) {
    if (!isset($components[$name])) {
      $display->removeComponent($name);
    }
  }
  $weight = 0;
  foreach ($components as $name => $options) {
    $display->setComponent($name, $options + ['weight' => $weight++]);
  }
  $display->save();
}

/** A picture from images/out as a permanent file in public://northstar/. */
function ns_file(string $images, string $name): File {
  $uri = "public://northstar/$name";
  $fs = \Drupal::service('file_system');
  $dir = 'public://northstar';
  $fs->prepareDirectory($dir, \Drupal\Core\File\FileSystemInterface::CREATE_DIRECTORY);
  $source = "$images/$name";
  if (!file_exists($source)) {
    throw new \RuntimeException("Missing picture $source: build.sh draws them first.");
  }
  if (!file_exists($uri) || md5_file($uri) !== md5_file($source)) {
    $fs->copy($source, $uri, \Drupal\Core\File\FileExists::Replace);
    // A redrawn picture needs its image style copies made again.
    foreach (ImageStyle::loadMultiple() as $style) {
      $style->flush($uri);
    }
  }
  $files = \Drupal::entityTypeManager()->getStorage('file')->loadByProperties(['uri' => $uri]);
  $file = $files ? reset($files) : File::create(['uri' => $uri, 'uid' => 1]);
  $file->setPermanent();
  $file->setFilename($name);
  $file->save();
  return $file;
}

function ns_image(string $images, string $name, string $alt): array {
  $file = ns_file($images, $name);
  [$w, $h] = getimagesize($file->getFileUri());
  return ['target_id' => $file->id(), 'alt' => $alt, 'width' => $w, 'height' => $h];
}

function ns_text(string $html, string $format = 'basic_html'): array {
  return ['value' => trim($html), 'format' => $format];
}

/* ── site ─────────────────────────────────────────────────────────────── */

echo "Northstar Storefront: content model, content, views, blocks and menus\n";

\Drupal::configFactory()->getEditable('system.site')
  ->set('name', 'Northstar Storefront')
  ->set('slogan', 'Goods for long days outside')
  ->set('mail', 'hello@northstar.example')
  ->save();
\Drupal::configFactory()->getEditable('system.date')->set('country.default', 'US')->set('timezone.default', 'America/Chicago')->save();
// A development site: Twig debug on and caches off, so a trace names every
// template and an edit shows on the next load. CSS and JS are served file by
// file for the same reason.
\Drupal::keyValue('development_settings')->setMultiple([
  'twig_debug' => TRUE,
  'twig_cache_disable' => TRUE,
  'disable_rendered_output_cache_bins' => TRUE,
]);
\Drupal::configFactory()->getEditable('system.performance')->set('css.preprocess', FALSE)->set('js.preprocess', FALSE)->save();
\Drupal::configFactory()->getEditable('node.settings')->set('use_admin_theme', TRUE)->save();

/* ── image styles ─────────────────────────────────────────────────────── */

$styles = [
  'ns_card' => ['Northstar card (640×640)', 'image_scale_and_crop', ['width' => 640, 'height' => 640, 'anchor' => 'center-center']],
  'ns_large' => ['Northstar large (1200×1200)', 'image_scale', ['width' => 1200, 'height' => 1200, 'upscale' => FALSE]],
  'ns_wide' => ['Northstar wide (1600×900)', 'image_scale_and_crop', ['width' => 1600, 'height' => 900, 'anchor' => 'center-center']],
  'ns_wide_card' => ['Northstar wide card (800×450)', 'image_scale_and_crop', ['width' => 800, 'height' => 450, 'anchor' => 'center-center']],
  'ns_hero' => ['Northstar hero (2000 wide)', 'image_scale', ['width' => 2000, 'height' => NULL, 'upscale' => FALSE]],
];
foreach ($styles as $id => [$label, $effect, $data]) {
  $style = ImageStyle::load($id) ?: ImageStyle::create(['name' => $id, 'label' => $label]);
  $style->set('label', $label);
  foreach ($style->getEffects() as $existing) {
    $style->deleteImageEffect($existing);
  }
  $style->addImageEffect(['id' => $effect, 'weight' => 0, 'data' => $data]);
  $style->save();
}
ns_say('image styles');

/* ── categories ───────────────────────────────────────────────────────── */

ns_config('taxonomy_vocabulary', 'category', ['name' => 'Category', 'description' => 'What kind of thing a product is.']);
$categories = [];
foreach (['Drinkware', 'Bags', 'Prints', 'Apparel', 'Paper goods', 'Camp'] as $i => $name) {
  $categories[$name] = ns_content('taxonomy_term', "category:$name", ['vid' => 'category', 'name' => $name, 'weight' => $i]);
}
ns_say('categories');

/* ── content types and fields ─────────────────────────────────────────── */

$type = NodeType::load('product') ?: NodeType::create(['type' => 'product']);
$type->set('name', 'Product');
$type->set('description', 'Something the shop sells: pictures, price, highlights and badges.');
$type->set('new_revision', TRUE);
$type->set('display_submitted', FALSE);
$type->save();

$type = NodeType::load('landing_page') ?: NodeType::create(['type' => 'landing_page']);
$type->set('name', 'Landing page');
$type->set('description', 'A page laid out with Layout Builder: sections of blocks and fields.');
$type->set('new_revision', TRUE);
$type->set('display_submitted', FALSE);
$type->save();

foreach (['page', 'article'] as $bundle) {
  $t = NodeType::load($bundle);
  $t->set('display_submitted', FALSE);
  $t->save();
}

ns_field('node', 'product', 'body', 'text_with_summary', 'Description');
ns_field('node', 'product', 'field_images', 'image', 'Pictures', [
  'cardinality' => 4,
  'settings' => ['alt_field_required' => TRUE, 'file_directory' => 'northstar/products', 'file_extensions' => 'png jpg jpeg webp'],
]);
ns_field('node', 'product', 'field_price', 'decimal', 'Price', [
  'storage' => ['precision' => 10, 'scale' => 2],
  'settings' => ['min' => 0, 'prefix' => '$'],
  'required' => TRUE,
]);
ns_field('node', 'product', 'field_highlights', 'string', 'Highlights', [
  'cardinality' => -1,
  'description' => 'One short line each, shown as a ticked list.',
]);
ns_field('node', 'product', 'field_badges', 'list_string', 'Badges', [
  'cardinality' => -1,
  'storage' => ['allowed_values' => ['new' => 'New', 'bestseller' => 'Bestseller', 'limited' => 'Limited run', 'recycled' => 'Recycled materials']],
]);
ns_field('node', 'product', 'field_category', 'entity_reference', 'Category', [
  'storage' => ['target_type' => 'taxonomy_term'],
  'settings' => ['handler' => 'default:taxonomy_term', 'handler_settings' => ['target_bundles' => ['category' => 'category']]],
]);
ns_field('node', 'product', 'field_related', 'entity_reference', 'You might also like', [
  'cardinality' => 3,
  'storage' => ['target_type' => 'node'],
  'settings' => ['handler' => 'default:node', 'handler_settings' => ['target_bundles' => ['product' => 'product']]],
]);
ns_field('node', 'landing_page', 'body', 'text_with_summary', 'Introduction');

ns_display('view', 'node', 'product', 'default', [
  'field_images' => ['type' => 'image', 'label' => 'hidden', 'settings' => ['image_style' => 'ns_large', 'image_link' => '', 'image_loading' => ['attribute' => 'eager']]],
  'field_category' => ['type' => 'entity_reference_label', 'label' => 'hidden', 'settings' => ['link' => FALSE]],
  'field_price' => ['type' => 'number_decimal', 'label' => 'hidden', 'settings' => ['scale' => 2, 'prefix_suffix' => TRUE, 'thousand_separator' => ',', 'decimal_separator' => '.']],
  'field_badges' => ['type' => 'list_default', 'label' => 'hidden'],
  'field_highlights' => ['type' => 'string', 'label' => 'above'],
  'body' => ['type' => 'text_default', 'label' => 'hidden'],
  'field_related' => ['type' => 'entity_reference_entity_view', 'label' => 'above', 'settings' => ['view_mode' => 'teaser']],
]);
ns_display('view', 'node', 'product', 'teaser', [
  'field_images' => ['type' => 'image', 'label' => 'hidden', 'settings' => ['image_style' => 'ns_card', 'image_link' => '', 'image_loading' => ['attribute' => 'lazy']]],
  'field_price' => ['type' => 'number_decimal', 'label' => 'hidden', 'settings' => ['scale' => 2]],
  'field_badges' => ['type' => 'list_default', 'label' => 'hidden'],
]);
ns_display('form', 'node', 'product', 'default', [
  'title' => ['type' => 'string_textfield'],
  'field_images' => ['type' => 'image_image', 'settings' => ['preview_image_style' => 'thumbnail', 'progress_indicator' => 'throbber']],
  'field_price' => ['type' => 'number'],
  'field_category' => ['type' => 'options_select'],
  'field_badges' => ['type' => 'options_buttons'],
  'field_highlights' => ['type' => 'string_textfield'],
  'body' => ['type' => 'text_textarea_with_summary'],
  'field_related' => ['type' => 'entity_reference_autocomplete'],
  'path' => ['type' => 'path'],
  'status' => ['type' => 'boolean_checkbox', 'settings' => ['display_label' => TRUE]],
  'promote' => ['type' => 'boolean_checkbox', 'settings' => ['display_label' => TRUE]],
]);
ns_display('view', 'node', 'article', 'default', [
  'field_image' => ['type' => 'image', 'label' => 'hidden', 'settings' => ['image_style' => 'ns_wide', 'image_link' => '', 'image_loading' => ['attribute' => 'eager']]],
  'body' => ['type' => 'text_default', 'label' => 'hidden'],
  'field_tags' => ['type' => 'entity_reference_label', 'label' => 'visually_hidden', 'settings' => ['link' => TRUE]],
]);
ns_display('view', 'node', 'article', 'teaser', [
  'field_image' => ['type' => 'image', 'label' => 'hidden', 'settings' => ['image_style' => 'ns_wide_card', 'image_link' => '', 'image_loading' => ['attribute' => 'lazy']]],
  'body' => ['type' => 'text_summary_or_trimmed', 'label' => 'hidden', 'settings' => ['trim_length' => 160]],
]);
ns_display('view', 'node', 'page', 'default', [
  'body' => ['type' => 'text_default', 'label' => 'hidden'],
]);
ns_display('form', 'node', 'landing_page', 'default', [
  'title' => ['type' => 'string_textfield'],
  'body' => ['type' => 'text_textarea_with_summary'],
  'path' => ['type' => 'path'],
  'status' => ['type' => 'boolean_checkbox', 'settings' => ['display_label' => TRUE]],
]);
ns_display('view', 'node', 'landing_page', 'default', [
  'body' => ['type' => 'text_default', 'label' => 'hidden'],
]);
// Layout Builder on landing pages, each page free to lay itself out.
/** @var \Drupal\layout_builder\Entity\LayoutBuilderEntityViewDisplay $lb */
$lb = \Drupal::service('entity_display.repository')->getViewDisplay('node', 'landing_page', 'default');
$lb->enableLayoutBuilder()->setOverridable()->save();
ns_say('content types: Product, Landing page (Layout Builder), Article, Basic page');

/* ── block types for Layout Builder ───────────────────────────────────── */

foreach (['hero' => ['Hero', 'A wide picture with a heading and one call to action.'], 'callout' => ['Callout', 'A boxed message with one action.']] as $id => [$label, $description]) {
  $bt = BlockContentType::load($id) ?: BlockContentType::create(['id' => $id]);
  $bt->set('label', $label);
  $bt->set('description', $description);
  $bt->set('revision', TRUE);
  $bt->save();
}
ns_field('block_content', 'hero', 'field_kicker', 'string', 'Kicker');
ns_field('block_content', 'hero', 'field_heading', 'string', 'Heading', ['required' => TRUE]);
ns_field('block_content', 'hero', 'field_summary', 'string_long', 'Text');
ns_field('block_content', 'hero', 'field_image', 'image', 'Picture', ['settings' => ['file_directory' => 'northstar/blocks', 'alt_field_required' => TRUE]]);
ns_field('block_content', 'hero', 'field_link', 'link', 'Call to action', ['settings' => ['title' => 2, 'link_type' => 17]]);
ns_field('block_content', 'callout', 'field_heading', 'string', 'Heading', ['required' => TRUE]);
ns_field('block_content', 'callout', 'field_summary', 'string_long', 'Text');
ns_field('block_content', 'callout', 'field_link', 'link', 'Action', ['settings' => ['title' => 2, 'link_type' => 17]]);
ns_field('block_content', 'callout', 'field_tone', 'list_string', 'Colour', [
  'storage' => ['allowed_values' => ['pine' => 'Pine', 'sand' => 'Sand', 'ember' => 'Ember']],
]);
ns_display('view', 'block_content', 'hero', 'default', [
  'field_image' => ['type' => 'image', 'label' => 'hidden', 'settings' => ['image_style' => 'ns_hero', 'image_link' => '', 'image_loading' => ['attribute' => 'eager']]],
  'field_kicker' => ['type' => 'string', 'label' => 'hidden'],
  'field_heading' => ['type' => 'string', 'label' => 'hidden'],
  'field_summary' => ['type' => 'basic_string', 'label' => 'hidden'],
]);
ns_display('form', 'block_content', 'hero', 'default', [
  'info' => ['type' => 'string_textfield'],
  'field_kicker' => ['type' => 'string_textfield'],
  'field_heading' => ['type' => 'string_textfield'],
  'field_summary' => ['type' => 'string_textarea'],
  'field_image' => ['type' => 'image_image'],
  'field_link' => ['type' => 'link_default'],
]);
ns_display('view', 'block_content', 'callout', 'default', [
  'field_heading' => ['type' => 'string', 'label' => 'hidden'],
  'field_summary' => ['type' => 'basic_string', 'label' => 'hidden'],
]);
ns_display('form', 'block_content', 'callout', 'default', [
  'info' => ['type' => 'string_textfield'],
  'field_heading' => ['type' => 'string_textfield'],
  'field_summary' => ['type' => 'string_textarea'],
  'field_link' => ['type' => 'link_default'],
  'field_tone' => ['type' => 'options_select'],
]);
ns_say('block types: Hero, Callout');

/* ── people ───────────────────────────────────────────────────────────── */

$people = [];
foreach (['Dana Reyes' => 'dana', 'Sam Okafor' => 'sam'] as $name => $login) {
  $people[$login] = ns_content('user', "person:$login", [
    'name' => $name,
    'mail' => "$login@northstar.example",
    'status' => 1,
    'roles' => ['content_editor'],
  ]);
}

/* ── products ─────────────────────────────────────────────────────────── */

$products = require __DIR__ . '/content/products.php';
$made = [];
$when = strtotime('2026-09-28 09:00:00');
foreach ($products as $i => $p) {
  $made[$p['slug']] = ns_content('node', 'product:' . $p['slug'], [
    'type' => 'product',
    'title' => $p['title'],
    'uid' => 1,
    'status' => 1,
    'promote' => (int) !empty($p['featured']),
    'sticky' => 0,
    'created' => $when - $i * 86400,
    'changed' => $when - $i * 86400,
    'field_price' => $p['price'],
    'field_category' => ['target_id' => $categories[$p['category']]->id()],
    'field_highlights' => $p['highlights'],
    'field_badges' => $p['badges'],
    'field_images' => [
      ns_image($images, $p['slug'] . '-1.jpg', $p['alt']),
      ns_image($images, $p['slug'] . '-2.jpg', $p['alt'] . ', close up'),
    ],
    'body' => ns_text($p['body']),
    'path' => ['alias' => '/shop/' . $p['slug'], 'pathauto' => 0],
  ]);
}
foreach ($products as $p) {
  $related = array_map(fn ($slug) => ['target_id' => $made[$slug]->id()], $p['related']);
  $node = $made[$p['slug']];
  $node->set('field_related', $related);
  if ($node->hasTranslationChanges()) {
    $node->save();
  }
}
ns_say(count($made) . ' products');

/* ── journal ──────────────────────────────────────────────────────────── */

$articles = require __DIR__ . '/content/articles.php';
$tags = [];
foreach ($articles as $i => $a) {
  $refs = [];
  foreach ($a['tags'] as $tag) {
    $tags[$tag] ??= ns_content('taxonomy_term', "tag:$tag", ['vid' => 'tags', 'name' => $tag]);
    $refs[] = ['target_id' => $tags[$tag]->id()];
  }
  ns_content('node', 'article:' . $a['slug'], [
    'type' => 'article',
    'title' => $a['title'],
    'uid' => $people[$a['author']]->id(),
    'status' => 1,
    'promote' => 0,
    'created' => strtotime($a['date']),
    'changed' => strtotime($a['date']),
    'field_image' => ns_image($images, $a['image'], $a['alt']),
    'field_tags' => $refs,
    'body' => ns_text($a['body']),
    'path' => ['alias' => '/journal/' . $a['slug'], 'pathauto' => 0],
  ]);
}
ns_say(count($articles) . ' journal entries');

/* ── pages ────────────────────────────────────────────────────────────── */

$pages = require __DIR__ . '/content/pages.php';
$page_nodes = [];
foreach ($pages as $slug => $pg) {
  $page_nodes[$slug] = ns_content('node', "page:$slug", [
    'type' => 'page',
    'title' => $pg['title'],
    'uid' => 1,
    'status' => 1,
    'promote' => 0,
    'body' => ns_text($pg['body']),
    'path' => ['alias' => "/$slug", 'pathauto' => 0],
  ]);
}
ns_say(count($page_nodes) . ' pages');

/* ── views ────────────────────────────────────────────────────────────── */

foreach (['products', 'journal'] as $id) {
  $config = require __DIR__ . "/views/$id.php";
  $view = View::load($id) ?: View::create(['id' => $id]);
  foreach ($config as $key => $value) {
    $view->set($key, $value);
  }
  $view->save();
}
ns_say('views: products (/shop, with a category filter), journal (/journal)');

/* ── reusable blocks ──────────────────────────────────────────────────── */

$custom = [
  'free-shipping' => ['Free shipping over $75', '<p>Free shipping on orders over $75, and free returns for a season.</p>'],
  'footer-about' => ['About Northstar', '<p>Northstar makes a small run of goods for long days outside: enamel that takes a knock, canvas that softens, maps drawn by hand.</p><p>The workshop is open Thursday to Saturday, ten until four.</p>'],
  'footer-letters' => ['Letters from the lake', '<p>One short letter a month: what we are making, what we are reading, and where the fish were.</p>'],
];
$blocks = [];
foreach ($custom as $slug => [$info, $body]) {
  $blocks[$slug] = ns_content('block_content', "block:$slug", [
    'type' => 'basic',
    'info' => $info,
    'reusable' => TRUE,
    'body' => ns_text($body),
  ]);
}

/* ── menus ────────────────────────────────────────────────────────────── */

// The standard profile's Home link: the logo already goes home.
\Drupal::service('plugin.manager.menu.link')->updateDefinition('standard.front_page', ['enabled' => FALSE]);
$links = [
  ['main', 'Shop', 'internal:/shop', 0],
  ['main', 'Journal', 'internal:/journal', 1],
  ['main', 'About', 'entity:node/' . $page_nodes['about']->id(), 2],
  ['footer', 'About us', 'entity:node/' . $page_nodes['about']->id(), 0],
  ['footer', 'Shipping & returns', 'entity:node/' . $page_nodes['shipping']->id(), 1],
  ['footer', 'Journal', 'internal:/journal', 2],
  ['footer', 'Care guide', 'entity:node/' . $page_nodes['care']->id(), 3],
];
foreach ($links as [$menu, $title, $uri, $weight]) {
  ns_content('menu_link_content', "link:$menu:$title", [
    'menu_name' => $menu,
    'title' => $title,
    'link' => ['uri' => $uri],
    'weight' => $weight,
    'expanded' => FALSE,
    'enabled' => TRUE,
  ]);
}
ns_say('menus: main and footer');

/* ── the front page ───────────────────────────────────────────────────── */

$home = require __DIR__ . '/content/home.php';
$storage = \Drupal::entityTypeManager()->getStorage('node');
$uuid = ns_uuid('node:landing:home');
$found = $storage->loadByProperties(['uuid' => $uuid]);
$node = $found ? reset($found) : $storage->create([
  'uuid' => $uuid,
  'type' => 'landing_page',
  'uid' => 1,
]);
$node->set('title', $home['title']);
$node->set('status', 1);
$node->set('body', ns_text($home['intro']));
$node->set('path', ['alias' => '/home', 'pathauto' => 0]);

// The inline blocks already on the page, by the component that holds them.
$existing = [];
if (!$node->isNew()) {
  foreach ($node->get('layout_builder__layout')->getSections() as $section) {
    foreach ($section->getComponents() as $component) {
      $existing[$component->getUuid()] = $component->get('block_revision_id') ?? NULL;
    }
  }
}
$inline = function (string $key, string $bundle, array $values) use ($existing, $images) {
  $uuid = ns_uuid("component:$key");
  $block = NULL;
  if (!empty($existing[$uuid])) {
    $block = \Drupal::entityTypeManager()->getStorage('block_content')->loadRevision($existing[$uuid]);
  }
  $block = $block ?: BlockContent::create(['type' => $bundle, 'reusable' => FALSE]);
  foreach ($values as $field => $value) {
    $block->set($field, $value);
  }
  $config = [
    'id' => "inline_block:$bundle",
    'label' => $values['info'],
    'label_display' => FALSE,
    'provider' => 'layout_builder',
    'view_mode' => 'full',
    'context_mapping' => [],
    'block_revision_id' => $block->isNew() ? NULL : $block->getRevisionId(),
    'block_serialized' => NULL,
  ];
  // Layout Builder saves a new or changed block, and records where it is used.
  if ($block->isNew() || $block->hasTranslationChanges()) {
    $config['block_serialized'] = serialize($block);
  }
  return [$uuid, $config];
};

$hero = $home['hero'];
[$hero_uuid, $hero_config] = $inline('home-hero', 'hero', [
  'info' => 'Home hero',
  'field_kicker' => $hero['kicker'],
  'field_heading' => $hero['heading'],
  'field_summary' => $hero['text'],
  'field_image' => ns_image($images, 'hero-lake.jpg', $hero['alt']),
  'field_link' => ['uri' => 'internal:/shop', 'title' => $hero['cta']],
]);
$callout = $home['callout'];
[$callout_uuid, $callout_config] = $inline('home-callout', 'callout', [
  'info' => 'Home shipping callout',
  'field_heading' => $callout['heading'],
  'field_summary' => $callout['text'],
  'field_link' => ['uri' => 'entity:node/' . $page_nodes['shipping']->id(), 'title' => $callout['cta']],
  'field_tone' => 'pine',
]);

$s1 = new Section('layout_onecol', ['label' => 'Hero']);
$s1->appendComponent(new SectionComponent($hero_uuid, 'content', $hero_config));
$s2 = new Section('layout_twocol_section', ['label' => 'Introduction', 'column_widths' => '67-33']);
$s2->appendComponent(new SectionComponent(ns_uuid('component:home-intro'), 'first', [
  'id' => 'field_block:node:landing_page:body',
  'label' => 'Introduction',
  'label_display' => FALSE,
  'provider' => 'layout_builder',
  'formatter' => ['label' => 'hidden', 'type' => 'text_default', 'settings' => [], 'third_party_settings' => []],
  'context_mapping' => ['entity' => 'layout_builder.entity', 'view_mode' => 'view_mode'],
]));
$s2->appendComponent(new SectionComponent($callout_uuid, 'second', $callout_config));
$s3 = new Section('layout_onecol', ['label' => 'Shop and journal']);
$s3->appendComponent(new SectionComponent(ns_uuid('component:home-featured'), 'content', [
  'id' => 'views_block:products-block_1',
  'label' => 'Bestsellers this month',
  'label_display' => 'visible',
  'provider' => 'views',
  'views_label' => 'Bestsellers this month',
  'items_per_page' => 'none',
  'context_mapping' => [],
]));
$s3->appendComponent(new SectionComponent(ns_uuid('component:home-journal'), 'content', [
  'id' => 'views_block:journal-block_1',
  'label' => 'From the journal',
  'label_display' => 'visible',
  'provider' => 'views',
  'views_label' => 'From the journal',
  'items_per_page' => 'none',
  'context_mapping' => [],
]));
$node->get('layout_builder__layout')->setValue([
  ['section' => $s1],
  ['section' => $s2],
  ['section' => $s3],
]);
if ($node->isNew() || $node->hasTranslationChanges()) {
  $node->setNewRevision(TRUE);
  $node->save();
}
\Drupal::configFactory()->getEditable('system.site')->set('page.front', '/node/' . $node->id())->save();
ns_say('front page: a landing page in three Layout Builder sections');

/* ── block placements ─────────────────────────────────────────────────── */

$place = [
  'northstar_free_shipping' => ['announcement', 'block_content:' . $blocks['free-shipping']->uuid(), ['label' => 'Free shipping', 'label_display' => '0', 'provider' => 'block_content', 'status' => TRUE, 'info' => '', 'view_mode' => 'full']],
  'northstar_branding' => ['header', 'system_branding_block', ['label' => 'Site branding', 'label_display' => '0', 'provider' => 'system', 'use_site_logo' => TRUE, 'use_site_name' => TRUE, 'use_site_slogan' => FALSE]],
  'northstar_main_menu' => ['primary_menu', 'system_menu_block:main', ['label' => 'Main navigation', 'label_display' => '0', 'provider' => 'system', 'level' => 1, 'depth' => 1, 'expand_all_items' => FALSE]],
  'northstar_search' => ['header_tools', 'search_form_block', ['label' => 'Search', 'label_display' => '0', 'provider' => 'search', 'page_id' => '']],
  'northstar_messages' => ['highlighted', 'system_messages_block', ['label' => 'Status messages', 'label_display' => '0', 'provider' => 'system']],
  'northstar_breadcrumbs' => ['breadcrumb', 'system_breadcrumb_block', ['label' => 'Breadcrumbs', 'label_display' => '0', 'provider' => 'system']],
  'northstar_page_title' => ['content_above', 'page_title_block', ['label' => 'Page title', 'label_display' => '0', 'provider' => 'core']],
  'northstar_tabs' => ['content_above', 'local_tasks_block', ['label' => 'Tabs', 'label_display' => '0', 'provider' => 'core', 'primary' => TRUE, 'secondary' => TRUE]],
  'northstar_actions' => ['content_above', 'local_actions_block', ['label' => 'Primary admin actions', 'label_display' => '0', 'provider' => 'core']],
  'northstar_content' => ['content', 'system_main_block', ['label' => 'Main page content', 'label_display' => '0', 'provider' => 'system']],
  'northstar_shop_the_story' => ['sidebar', 'views_block:products-block_2', ['label' => 'From the shop', 'label_display' => 'visible', 'provider' => 'views', 'views_label' => 'From the shop', 'items_per_page' => 'none']],
  'northstar_footer_about' => ['footer_top', 'block_content:' . $blocks['footer-about']->uuid(), ['label' => 'About Northstar', 'label_display' => 'visible', 'provider' => 'block_content', 'status' => TRUE, 'info' => '', 'view_mode' => 'full']],
  'northstar_footer_menu' => ['footer_top', 'system_menu_block:footer', ['label' => 'Help', 'label_display' => 'visible', 'provider' => 'system', 'level' => 1, 'depth' => 1, 'expand_all_items' => FALSE]],
  'northstar_footer_letters' => ['footer_top', 'block_content:' . $blocks['footer-letters']->uuid(), ['label' => 'Letters from the lake', 'label_display' => 'visible', 'provider' => 'block_content', 'status' => TRUE, 'info' => '', 'view_mode' => 'full']],
  'northstar_powered' => ['footer_bottom', 'system_powered_by_block', ['label' => 'Powered by Drupal', 'label_display' => '0', 'provider' => 'system']],
];
$keep = array_keys($place);
foreach (\Drupal::entityTypeManager()->getStorage('block')->loadByProperties(['theme' => $theme]) as $block) {
  if (!in_array($block->id(), $keep, TRUE)) {
    $block->delete();
  }
}
$weight = 0;
foreach ($place as $id => [$region, $plugin, $settings]) {
  $block = Block::load($id) ?: Block::create(['id' => $id, 'theme' => $theme, 'plugin' => $plugin]);
  $block->set('region', $region);
  $block->set('weight', $weight++);
  $block->set('status', TRUE);
  $block->set('settings', ['id' => $plugin] + $settings);
  $block->set('plugin', $plugin);
  $block->set('visibility', $id === 'northstar_shop_the_story'
    ? ['entity_bundle:node' => ['id' => 'entity_bundle:node', 'negate' => FALSE, 'context_mapping' => ['node' => '@node.node_route_context:node'], 'bundles' => ['article' => 'article']]]
    : []);
  $block->save();
}
ns_say(count($place) . ' blocks placed in ' . count(array_unique(array_column($place, 0))) . ' regions');

echo "Done.\n";
