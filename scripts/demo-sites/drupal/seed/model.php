<?php

/**
 * @file
 * The content model: site settings, languages, image and responsive image
 * styles, media view modes, vocabularies, content types, fields, displays,
 * block types, the editorial workflow, translation settings and roles.
 */

use Drupal\block_content\Entity\BlockContentType;
use Drupal\Core\Entity\Entity\EntityViewMode;
use Drupal\image\Entity\ImageStyle;
use Drupal\language\Entity\ConfigurableLanguage;
use Drupal\language\Entity\ContentLanguageSettings;
use Drupal\node\Entity\NodeType;
use Drupal\user\Entity\Role;
use Drupal\workflows\Entity\Workflow;

/* ── site ─────────────────────────────────────────────────────────────── */

\Drupal::configFactory()->getEditable('system.site')
  ->set('name', 'Northstar Storefront')
  ->set('slogan', 'Goods for long days outside')
  ->set('mail', 'hello@northstar.example')
  ->save();
\Drupal::configFactory()->getEditable('system.date')
  ->set('country.default', 'US')
  ->set('timezone.default', 'America/Chicago')
  ->set('timezone.user.configurable', FALSE)
  ->save();
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
\Drupal::configFactory()->getEditable('user.settings')->set('register', 'admin_only')->save();

/* ── languages ────────────────────────────────────────────────────────── */

// No translations are fetched from the internet; the few the theme needs are
// added below.
\Drupal::configFactory()->getEditable('locale.settings')
  ->set('translation.import_enabled', FALSE)
  ->set('translation.use_source', 'local')
  ->save();
if (!ConfigurableLanguage::load('fr')) {
  ConfigurableLanguage::createFromLangcode('fr')->save();
}
ns_say('languages: English, French (at /fr)');

/* ── image styles and responsive image styles ─────────────────────────── */

$styles = [];
foreach ([480, 800, 1200] as $w) {
  $styles["ns_square_$w"] = ["Northstar square $w", 'image_scale_and_crop', ['width' => $w, 'height' => $w, 'anchor' => 'center-center']];
}
foreach ([640, 1280, 1920] as $w) {
  $styles["ns_wide_$w"] = ["Northstar wide $w (16:9)", 'image_scale_and_crop', ['width' => $w, 'height' => (int) round($w * 9 / 16), 'anchor' => 'center-center']];
}
foreach ([960, 1600, 2400] as $w) {
  $styles["ns_hero_$w"] = ["Northstar hero $w", 'image_scale', ['width' => $w, 'height' => NULL, 'upscale' => FALSE]];
}
$styles['ns_thumb'] = ['Northstar thumbnail (160)', 'image_scale_and_crop', ['width' => 160, 'height' => 160, 'anchor' => 'center-center']];
foreach ($styles as $id => [$label, $effect, $data]) {
  $style = ImageStyle::load($id) ?: ImageStyle::create(['name' => $id, 'label' => $label]);
  $style->set('label', $label);
  foreach ($style->getEffects() as $existing) {
    $style->deleteImageEffect($existing);
  }
  $style->addImageEffect(['id' => $effect, 'weight' => 0, 'data' => $data]);
  // Smaller files: WebP for every derivative.
  $style->addImageEffect(['id' => 'image_convert', 'weight' => 1, 'data' => ['extension' => 'webp']]);
  $style->save();
}
$responsive = [
  'ns_square' => ['Northstar square', '(min-width: 1100px) 560px, (min-width: 700px) 50vw, 100vw', ['ns_square_480', 'ns_square_800', 'ns_square_1200'], 'ns_square_800'],
  'ns_card' => ['Northstar card', '(min-width: 1200px) 280px, (min-width: 700px) 33vw, 50vw', ['ns_square_480', 'ns_square_800'], 'ns_square_480'],
  'ns_wide' => ['Northstar wide', '(min-width: 1200px) 1100px, 100vw', ['ns_wide_640', 'ns_wide_1280', 'ns_wide_1920'], 'ns_wide_1280'],
  'ns_wide_card' => ['Northstar wide card', '(min-width: 1200px) 380px, (min-width: 700px) 50vw, 100vw', ['ns_wide_640', 'ns_wide_1280'], 'ns_wide_640'],
  'ns_hero' => ['Northstar hero', '100vw', ['ns_hero_960', 'ns_hero_1600', 'ns_hero_2400'], 'ns_hero_1600'],
];
foreach ($responsive as $id => [$label, $sizes, $list, $fallback]) {
  ns_config('responsive_image_style', $id, [
    'label' => $label,
    'breakpoint_group' => 'responsive_image',
    'fallback_image_style' => $fallback,
    'image_style_mappings' => [[
      'breakpoint_id' => 'responsive_image.viewport_sizing',
      'multiplier' => '1x',
      'image_mapping_type' => 'sizes',
      'image_mapping' => ['sizes' => $sizes, 'sizes_image_styles' => $list],
    ]],
  ]);
}
ns_say('image styles (WebP) and five responsive image styles');

/* ── media: view modes for each place a picture appears ───────────────── */

$media_modes = ['card' => ['Card', 'ns_card'], 'gallery' => ['Gallery', 'ns_square'], 'wide' => ['Wide', 'ns_wide'], 'hero' => ['Hero', 'ns_hero']];
foreach ($media_modes as $mode => [$label, $style]) {
  if (!EntityViewMode::load("media.$mode")) {
    EntityViewMode::create(['id' => "media.$mode", 'targetEntityType' => 'media', 'label' => $label])->save();
  }
  ns_display('view', 'media', 'image', $mode, [
    'field_media_image' => ['type' => 'responsive_image', 'label' => 'hidden', 'settings' => ['responsive_image_style' => $style, 'image_link' => '', 'image_loading' => ['attribute' => $mode === 'hero' ? 'eager' : 'lazy']]],
  ]);
}

/* ── vocabularies ─────────────────────────────────────────────────────── */

ns_config('taxonomy_vocabulary', 'category', ['name' => 'Category', 'description' => 'What kind of thing a product is.']);
ns_config('taxonomy_vocabulary', 'material', ['name' => 'Material', 'description' => 'What a product is made of.']);
ns_field('taxonomy_term', 'category', 'field_media', 'entity_reference', 'Picture', [
  'storage' => ['target_type' => 'media'],
  'settings' => ['handler' => 'default:media', 'handler_settings' => ['target_bundles' => ['image' => 'image']]],
  'translatable' => FALSE,
]);

/* ── content types and fields ─────────────────────────────────────────── */

$types = [
  'product' => ['Product', 'Something the shop sells: pictures, price, highlights, badges and care.'],
  'landing_page' => ['Landing page', 'A page laid out with Layout Builder: sections of blocks and fields.'],
  'event' => ['Event', 'An open day or an evening at the workshop.'],
];
foreach ($types as $id => [$name, $description]) {
  $type = NodeType::load($id) ?: NodeType::create(['type' => $id]);
  $type->set('name', $name);
  $type->set('description', $description);
  $type->set('new_revision', TRUE);
  $type->set('display_submitted', FALSE);
  $type->save();
}
foreach (['page', 'article'] as $bundle) {
  $t = NodeType::load($bundle);
  $t->set('display_submitted', FALSE);
  $t->set('new_revision', TRUE);
  $t->save();
}

$media_ref = fn (int $cardinality = 1) => [
  'cardinality' => $cardinality,
  'storage' => ['target_type' => 'media'],
  'settings' => ['handler' => 'default:media', 'handler_settings' => ['target_bundles' => ['image' => 'image']]],
  'translatable' => FALSE,
];
$term_ref = fn (string $vid, int $cardinality = 1) => [
  'cardinality' => $cardinality,
  'storage' => ['target_type' => 'taxonomy_term'],
  'settings' => ['handler' => 'default:taxonomy_term', 'handler_settings' => ['target_bundles' => [$vid => $vid], 'auto_create' => FALSE]],
  'translatable' => FALSE,
];
$product_ref = fn (int $cardinality) => [
  'cardinality' => $cardinality,
  'storage' => ['target_type' => 'node'],
  'settings' => ['handler' => 'default:node', 'handler_settings' => ['target_bundles' => ['product' => 'product']]],
  'translatable' => FALSE,
];

ns_field('node', 'product', 'body', 'text_with_summary', 'Description');
ns_field('node', 'product', 'field_media', 'entity_reference', 'Pictures', $media_ref(6) + ['description' => 'The first picture is the one on cards.']);
ns_field('node', 'product', 'field_price', 'decimal', 'Price', ['storage' => ['precision' => 10, 'scale' => 2], 'settings' => ['min' => 0, 'prefix' => '$'], 'required' => TRUE, 'translatable' => FALSE]);
ns_field('node', 'product', 'field_compare_price', 'decimal', 'Earlier price', ['storage' => ['precision' => 10, 'scale' => 2], 'settings' => ['min' => 0, 'prefix' => '$'], 'translatable' => FALSE, 'description' => 'Set it to show the product as reduced.']);
ns_field('node', 'product', 'field_highlights', 'string', 'Highlights', ['cardinality' => -1, 'description' => 'One short line each, shown as a ticked list.']);
ns_field('node', 'product', 'field_badges', 'list_string', 'Badges', [
  'cardinality' => -1,
  'storage' => ['allowed_values' => ['new' => 'New', 'bestseller' => 'Bestseller', 'limited' => 'Limited run', 'recycled' => 'Recycled materials']],
  'translatable' => FALSE,
]);
ns_field('node', 'product', 'field_category', 'entity_reference', 'Category', $term_ref('category'));
ns_field('node', 'product', 'field_materials', 'entity_reference', 'Materials', $term_ref('material', -1));
ns_field('node', 'product', 'field_related', 'entity_reference', 'Pairs well with', $product_ref(3));
ns_field('node', 'product', 'field_since', 'datetime', 'In the shop since', ['storage' => ['datetime_type' => 'date'], 'translatable' => FALSE]);
ns_field('node', 'product', 'field_sku', 'string', 'Item number', ['translatable' => FALSE]);
ns_field('node', 'product', 'field_care', 'text_long', 'Materials and care');
ns_field('node', 'product', 'field_guide', 'link', 'Care guide', ['settings' => ['title' => 1, 'link_type' => 17], 'translatable' => FALSE]);

// The article recipe's picture and tags are shared by every translation.
foreach (['field_image', 'field_tags'] as $shared) {
  $config = \Drupal\field\Entity\FieldConfig::loadByName('node', 'article', $shared);
  $config->set('translatable', FALSE)->save();
}
ns_field('node', 'article', 'field_trip', 'daterange', 'On the water', ['storage' => ['datetime_type' => 'date'], 'translatable' => FALSE]);
ns_field('node', 'article', 'field_products', 'entity_reference', 'Shop the story', $product_ref(-1));

ns_field('node', 'event', 'body', 'text_with_summary', 'About it');
ns_field('node', 'event', 'field_when', 'daterange', 'When', ['storage' => ['datetime_type' => 'datetime'], 'required' => TRUE, 'translatable' => FALSE]);
ns_field('node', 'event', 'field_where', 'string', 'Where');
ns_field('node', 'event', 'field_media', 'entity_reference', 'Picture', $media_ref());
ns_field('node', 'event', 'field_link', 'link', 'How to come', ['settings' => ['title' => 2, 'link_type' => 17], 'translatable' => FALSE]);

ns_field('node', 'landing_page', 'body', 'text_with_summary', 'Introduction');

/* Displays */

ns_display('view', 'node', 'product', 'default', [
  'field_media' => ['type' => 'entity_reference_entity_view', 'label' => 'hidden', 'settings' => ['view_mode' => 'gallery']],
  'field_category' => ['type' => 'entity_reference_label', 'label' => 'hidden', 'settings' => ['link' => TRUE]],
  'field_price' => ['type' => 'number_decimal', 'label' => 'hidden', 'settings' => ['scale' => 2, 'prefix_suffix' => TRUE, 'thousand_separator' => ',', 'decimal_separator' => '.']],
  'field_badges' => ['type' => 'list_default', 'label' => 'hidden'],
  'field_highlights' => ['type' => 'string', 'label' => 'above'],
  'body' => ['type' => 'text_default', 'label' => 'hidden'],
  'field_care' => ['type' => 'text_default', 'label' => 'hidden'],
  'field_materials' => ['type' => 'entity_reference_label', 'label' => 'inline', 'settings' => ['link' => TRUE]],
  'field_sku' => ['type' => 'string', 'label' => 'inline'],
  'field_since' => ['type' => 'datetime_custom', 'label' => 'inline', 'settings' => ['date_format' => 'F Y', 'timezone_override' => '']],
  'field_guide' => ['type' => 'link', 'label' => 'hidden', 'settings' => ['trim_length' => 80, 'rel' => '', 'target' => '']],
  'field_related' => ['type' => 'entity_reference_entity_view', 'label' => 'above', 'settings' => ['view_mode' => 'teaser']],
]);
// What search indexes: the product's own words, not the cards around it.
ns_display('view', 'node', 'product', 'search_index', [
  'field_category' => ['type' => 'entity_reference_label', 'label' => 'hidden', 'settings' => ['link' => FALSE]],
  'field_highlights' => ['type' => 'string', 'label' => 'hidden'],
  'body' => ['type' => 'text_default', 'label' => 'hidden'],
  'field_materials' => ['type' => 'entity_reference_label', 'label' => 'hidden', 'settings' => ['link' => FALSE]],
  'field_care' => ['type' => 'text_default', 'label' => 'hidden'],
]);
ns_display('view', 'node', 'article', 'search_index', [
  'body' => ['type' => 'text_default', 'label' => 'hidden'],
  'field_tags' => ['type' => 'entity_reference_label', 'label' => 'hidden', 'settings' => ['link' => FALSE]],
]);
ns_display('view', 'node', 'product', 'teaser', [
  'field_media' => ['type' => 'entity_reference_entity_view', 'label' => 'hidden', 'settings' => ['view_mode' => 'card']],
  'field_price' => ['type' => 'number_decimal', 'label' => 'hidden', 'settings' => ['scale' => 2]],
  'field_badges' => ['type' => 'list_default', 'label' => 'hidden'],
]);
ns_display('form', 'node', 'product', 'default', [
  'title' => ['type' => 'string_textfield'],
  'field_media' => ['type' => 'media_library_widget', 'settings' => ['media_types' => []]],
  'field_price' => ['type' => 'number'],
  'field_compare_price' => ['type' => 'number'],
  'field_category' => ['type' => 'options_select'],
  'field_materials' => ['type' => 'options_buttons'],
  'field_badges' => ['type' => 'options_buttons'],
  'field_highlights' => ['type' => 'string_textfield'],
  'body' => ['type' => 'text_textarea_with_summary'],
  'field_care' => ['type' => 'text_textarea'],
  'field_guide' => ['type' => 'link_default'],
  'field_sku' => ['type' => 'string_textfield'],
  'field_since' => ['type' => 'datetime_default'],
  'field_related' => ['type' => 'entity_reference_autocomplete'],
  'langcode' => ['type' => 'language_select'],
  'translation' => ['weight' => 90],
  'path' => ['type' => 'path'],
  'promote' => ['type' => 'boolean_checkbox', 'settings' => ['display_label' => TRUE]],
  'moderation_state' => ['type' => 'moderation_state_default'],
]);
ns_display('view', 'node', 'article', 'default', [
  'field_image' => ['type' => 'responsive_image', 'label' => 'hidden', 'settings' => ['responsive_image_style' => 'ns_wide', 'image_link' => '', 'image_loading' => ['attribute' => 'eager']]],
  'field_trip' => ['type' => 'daterange_custom', 'label' => 'inline', 'settings' => ['date_format' => 'j F Y', 'separator' => '–', 'timezone_override' => '']],
  'body' => ['type' => 'text_default', 'label' => 'hidden'],
  'field_tags' => ['type' => 'entity_reference_label', 'label' => 'visually_hidden', 'settings' => ['link' => TRUE]],
  'field_products' => ['type' => 'entity_reference_entity_view', 'label' => 'above', 'settings' => ['view_mode' => 'teaser']],
]);
ns_display('view', 'node', 'article', 'teaser', [
  'field_image' => ['type' => 'responsive_image', 'label' => 'hidden', 'settings' => ['responsive_image_style' => 'ns_wide_card', 'image_link' => '', 'image_loading' => ['attribute' => 'lazy']]],
  'body' => ['type' => 'text_summary_or_trimmed', 'label' => 'hidden', 'settings' => ['trim_length' => 150]],
]);
ns_display('form', 'node', 'article', 'default', [
  'title' => ['type' => 'string_textfield'],
  'field_image' => ['type' => 'image_image'],
  'body' => ['type' => 'text_textarea_with_summary'],
  'field_tags' => ['type' => 'entity_reference_autocomplete_tags'],
  'field_trip' => ['type' => 'daterange_default'],
  'field_products' => ['type' => 'entity_reference_autocomplete'],
  'langcode' => ['type' => 'language_select'],
  'translation' => ['weight' => 90],
  'path' => ['type' => 'path'],
  'moderation_state' => ['type' => 'moderation_state_default'],
]);
ns_display('view', 'node', 'event', 'default', [
  'field_media' => ['type' => 'entity_reference_entity_view', 'label' => 'hidden', 'settings' => ['view_mode' => 'wide']],
  'field_when' => ['type' => 'daterange_custom', 'label' => 'hidden', 'settings' => ['date_format' => 'l j F, g:i a', 'separator' => 'to', 'timezone_override' => '']],
  'field_where' => ['type' => 'string', 'label' => 'hidden'],
  'body' => ['type' => 'text_default', 'label' => 'hidden'],
  'field_link' => ['type' => 'link', 'label' => 'hidden'],
]);
ns_display('view', 'node', 'event', 'teaser', [
  'field_when' => ['type' => 'daterange_custom', 'label' => 'hidden', 'settings' => ['date_format' => 'g:i a', 'separator' => '–', 'timezone_override' => '']],
  'field_where' => ['type' => 'string', 'label' => 'hidden'],
  'body' => ['type' => 'text_summary_or_trimmed', 'label' => 'hidden', 'settings' => ['trim_length' => 140]],
]);
ns_display('form', 'node', 'event', 'default', [
  'title' => ['type' => 'string_textfield'],
  'field_when' => ['type' => 'daterange_default'],
  'field_where' => ['type' => 'string_textfield'],
  'field_media' => ['type' => 'media_library_widget', 'settings' => ['media_types' => []]],
  'body' => ['type' => 'text_textarea_with_summary'],
  'field_link' => ['type' => 'link_default'],
  'path' => ['type' => 'path'],
  'moderation_state' => ['type' => 'moderation_state_default'],
]);
ns_display('view', 'node', 'page', 'default', ['body' => ['type' => 'text_default', 'label' => 'hidden']]);
ns_display('form', 'node', 'landing_page', 'default', [
  'title' => ['type' => 'string_textfield'],
  'body' => ['type' => 'text_textarea_with_summary'],
  'langcode' => ['type' => 'language_select'],
  'translation' => ['weight' => 90],
  'path' => ['type' => 'path'],
  'moderation_state' => ['type' => 'moderation_state_default'],
]);
ns_display('view', 'node', 'landing_page', 'default', ['body' => ['type' => 'text_default', 'label' => 'hidden']]);
ns_display('view', 'taxonomy_term', 'category', 'default', [
  'description' => ['type' => 'text_default', 'label' => 'hidden'],
]);
/** @var \Drupal\layout_builder\Entity\LayoutBuilderEntityViewDisplay $lb */
$lb = \Drupal::service('entity_display.repository')->getViewDisplay('node', 'landing_page', 'default');
$lb->enableLayoutBuilder()->setOverridable()->save();
ns_say('content types: Product, Article, Event, Basic page, Landing page (Layout Builder)');

/* ── block types ──────────────────────────────────────────────────────── */

$block_types = [
  'hero' => ['Hero', 'A wide picture with a heading and one call to action.'],
  'callout' => ['Callout', 'A boxed message with one action.'],
  'feature' => ['Feature', 'An icon, a heading and a sentence: one of a row.'],
  'stat' => ['Number', 'A big number with a label.'],
  'faq_item' => ['Question', 'A question and its answer, opened and closed in place.'],
  'quote' => ['Quote', 'A few words from someone, with their name.'],
  'media_text' => ['Picture and text', 'A picture beside a heading, a paragraph and a link.'],
];
foreach ($block_types as $id => [$label, $description]) {
  $bt = BlockContentType::load($id) ?: BlockContentType::create(['id' => $id]);
  $bt->set('label', $label);
  $bt->set('description', $description);
  $bt->set('revision', TRUE);
  $bt->save();
}
$link = ['settings' => ['title' => 2, 'link_type' => 17], 'translatable' => TRUE];
ns_field('block_content', 'hero', 'field_kicker', 'string', 'Kicker');
ns_field('block_content', 'hero', 'field_heading', 'string', 'Heading', ['required' => TRUE]);
ns_field('block_content', 'hero', 'field_summary', 'string_long', 'Text');
ns_field('block_content', 'hero', 'field_media', 'entity_reference', 'Picture', $media_ref());
ns_field('block_content', 'hero', 'field_link', 'link', 'Call to action', $link + []);
ns_field('block_content', 'hero', 'field_style', 'list_string', 'Look', ['storage' => ['allowed_values' => ['overlay' => 'Words over the picture', 'split' => 'Words beside the picture']], 'translatable' => FALSE]);
ns_field('block_content', 'callout', 'field_heading', 'string', 'Heading', ['required' => TRUE]);
ns_field('block_content', 'callout', 'field_summary', 'string_long', 'Text');
ns_field('block_content', 'callout', 'field_link', 'link', 'Action', $link);
ns_field('block_content', 'callout', 'field_tone', 'list_string', 'Colour', ['storage' => ['allowed_values' => ['pine' => 'Pine', 'sand' => 'Sand', 'ember' => 'Ember']], 'translatable' => FALSE]);
ns_field('block_content', 'feature', 'field_icon', 'list_string', 'Icon', ['storage' => ['allowed_values' => ['mountain' => 'Mountain', 'compass' => 'Compass', 'wave' => 'Wave', 'leaf' => 'Leaf', 'tent' => 'Tent', 'star' => 'Star']], 'translatable' => FALSE]);
ns_field('block_content', 'feature', 'field_heading', 'string', 'Heading', ['required' => TRUE]);
ns_field('block_content', 'feature', 'field_summary', 'string_long', 'Text');
ns_field('block_content', 'stat', 'field_number', 'string', 'Number', ['required' => TRUE]);
ns_field('block_content', 'stat', 'field_heading', 'string', 'Label', ['required' => TRUE]);
ns_field('block_content', 'stat', 'field_summary', 'string_long', 'Text');
ns_field('block_content', 'faq_item', 'field_heading', 'string', 'Question', ['required' => TRUE]);
ns_field('block_content', 'faq_item', 'field_answer', 'text_long', 'Answer', ['required' => TRUE]);
ns_field('block_content', 'quote', 'field_summary', 'string_long', 'Quote', ['required' => TRUE]);
ns_field('block_content', 'quote', 'field_cite', 'string', 'Who said it');
ns_field('block_content', 'media_text', 'field_media', 'entity_reference', 'Picture', $media_ref());
ns_field('block_content', 'media_text', 'field_heading', 'string', 'Heading', ['required' => TRUE]);
ns_field('block_content', 'media_text', 'field_summary', 'string_long', 'Text');
ns_field('block_content', 'media_text', 'field_link', 'link', 'Link', $link);
ns_field('block_content', 'media_text', 'field_reverse', 'boolean', 'Picture on the right', ['translatable' => FALSE]);

$string = ['type' => 'string', 'label' => 'hidden'];
$long = ['type' => 'basic_string', 'label' => 'hidden'];
$block_displays = [
  'hero' => ['field_media' => ['type' => 'entity_reference_entity_view', 'label' => 'hidden', 'settings' => ['view_mode' => 'hero']], 'field_kicker' => $string, 'field_heading' => $string, 'field_summary' => $long],
  'callout' => ['field_heading' => $string, 'field_summary' => $long],
  'feature' => ['field_heading' => $string, 'field_summary' => $long],
  'stat' => ['field_number' => $string, 'field_heading' => $string, 'field_summary' => $long],
  'faq_item' => ['field_heading' => $string, 'field_answer' => ['type' => 'text_default', 'label' => 'hidden']],
  'quote' => ['field_summary' => $long, 'field_cite' => $string],
  'media_text' => ['field_media' => ['type' => 'entity_reference_entity_view', 'label' => 'hidden', 'settings' => ['view_mode' => 'gallery']], 'field_heading' => $string, 'field_summary' => $long],
];
foreach ($block_displays as $bundle => $components) {
  ns_display('view', 'block_content', $bundle, 'default', $components);
  $form = ['info' => ['type' => 'string_textfield']];
  foreach (\Drupal::service('entity_field.manager')->getFieldDefinitions('block_content', $bundle) as $name => $definition) {
    if (str_starts_with($name, 'field_')) {
      $form[$name] = [];
    }
  }
  $widgets = ['field_media' => 'media_library_widget', 'field_link' => 'link_default', 'field_summary' => 'string_textarea', 'field_answer' => 'text_textarea', 'field_reverse' => 'boolean_checkbox', 'field_style' => 'options_select', 'field_tone' => 'options_select', 'field_icon' => 'options_select'];
  foreach ($form as $name => &$options) {
    $options = $name === 'info' ? $options : ['type' => $widgets[$name] ?? 'string_textfield'];
  }
  unset($options);
  ns_display('form', 'block_content', $bundle, 'default', $form);
}
ns_say('block types: Hero, Callout, Feature, Number, Question, Quote, Picture and text');

/* ── editorial workflow ───────────────────────────────────────────────── */

$workflow = Workflow::load('editorial');
$plugin = $workflow->getTypePlugin();
foreach (['product', 'article', 'page', 'event', 'landing_page'] as $bundle) {
  if (!$plugin->appliesToEntityTypeAndBundle('node', $bundle)) {
    $plugin->addEntityTypeAndBundle('node', $bundle);
  }
}
$workflow->save();
ns_say('editorial workflow (draft, published, archived) on every content type');

/* ── translation ──────────────────────────────────────────────────────── */

$translatable = ['node' => ['product', 'article', 'page', 'landing_page', 'event'], 'taxonomy_term' => ['category', 'material'], 'block_content' => ['hero', 'callout', 'feature', 'basic'], 'menu_link_content' => ['menu_link_content']];
foreach ($translatable as $entity_type => $bundles) {
  foreach ($bundles as $bundle) {
    $settings = ContentLanguageSettings::loadByEntityTypeBundle($entity_type, $bundle);
    $settings->setDefaultLangcode('site_default')->setLanguageAlterable(TRUE);
    $settings->setThirdPartySetting('content_translation', 'enabled', TRUE);
    $settings->setThirdPartySetting('content_translation', 'bundle_settings', ['untranslatable_fields_hide' => '1']);
    $settings->save();
  }
}
\Drupal::service('router.builder')->setRebuildNeeded();
ns_say('content translation on products, journal, pages, events, landing pages, terms, blocks and menu links');

/* ── roles ────────────────────────────────────────────────────────────── */

$common = ['access content overview', 'access contextual links', 'access navigation', 'view the administration theme', 'view own unpublished content', 'view latest version', 'access media overview', 'create media', 'access files overview'];
$editor = Role::load('content_editor');
$editor->set('label', 'Editor');
$wanted = $common;
foreach (['product', 'article', 'page', 'event', 'landing_page'] as $bundle) {
  array_push($wanted, "create $bundle content", "edit any $bundle content", "delete any $bundle content", "view $bundle revisions", "revert $bundle revisions", "translate $bundle node");
}
array_push($wanted, 'view any unpublished content', 'update any media', 'delete any media', 'configure editable landing_page node layout overrides', 'create content translations', 'update content translations', 'delete content translations', 'translate editable entities',
  'use editorial transition create_new_draft', 'use editorial transition publish', 'use editorial transition archive', 'use editorial transition archived_draft', 'use editorial transition archived_published',
  'create terms in category', 'edit terms in category', 'create terms in tags', 'edit terms in tags', 'access block library', 'administer block content', 'view all revisions');
foreach (ns_permissions($wanted) as $permission) {
  $editor->grantPermission($permission);
}
$editor->save();
$author = Role::load('author') ?: Role::create(['id' => 'author', 'label' => 'Author']);
$author->set('label', 'Author');
$author->set('weight', 2);
foreach (ns_permissions(array_merge($common, ['create article content', 'edit own article content', 'view article revisions', 'use editorial transition create_new_draft', 'update own media', 'create terms in tags'])) as $permission) {
  $author->grantPermission($permission);
}
$author->save();
ns_say('roles: Editor (publishes anything), Author (writes journal drafts)');
