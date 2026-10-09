<?php

/**
 * @file
 * The site around the content: reusable blocks, menus, the two Layout
 * Builder landing pages, views, block placements, the contact form, search,
 * and the French words the theme and views use.
 */

use Drupal\block\Entity\Block;
use Drupal\block_content\Entity\BlockContent;
use Drupal\contact\Entity\ContactForm;
use Drupal\layout_builder\Section;
use Drupal\layout_builder\SectionComponent;
use Drupal\views\Entity\View;

$data = dirname(__DIR__) . '/content';
$home = require "$data/home.php";
$workshop = require "$data/workshop.php";

/* ── reusable blocks ──────────────────────────────────────────────────── */

$basic = [
  'free-shipping' => ['Free shipping over $75', '<p>Free shipping on orders over $75, and free returns for a season.</p>', '<p>Livraison offerte dès 75 $, retours gratuits pendant une saison.</p>'],
  'footer-about' => ['About Northstar', '<p>Northstar makes a small run of goods for long days outside: enamel that takes a knock, canvas that softens, maps drawn by hand.</p><p>The workshop is open Thursday to Saturday, ten until four.</p>', '<p>Northstar fabrique en petites séries des objets pour les longues journées dehors.</p><p>L’atelier est ouvert du jeudi au samedi, de dix heures à seize heures.</p>'],
  'footer-letters' => ['Letters from the lake', '<p>One short letter a month: what we are making, what we are reading, and where the fish were. <a href="/contact">Ask to be on the list</a>.</p>', '<p>Une courte lettre par mois : ce que nous fabriquons, ce que nous lisons, et où étaient les poissons.</p>'],
];
$blocks = [];
foreach ($basic as $slug => [$info, $body, $fr]) {
  $blocks[$slug] = ns_content('block_content', "block:$slug", ['type' => 'basic', 'langcode' => 'en', 'info' => $info, 'reusable' => TRUE, 'body' => ns_text($body)]);
  ns_translate($blocks[$slug], 'fr', ['info' => $info, 'body' => ns_text($fr)]);
}

// The front page's blocks are reusable, so each can be translated: Layout
// Builder's inline blocks are not.
$hero = $home['hero'];
$blocks['home-hero'] = ns_content('block_content', 'block:home-hero', [
  'type' => 'hero', 'langcode' => 'en', 'info' => 'Front page hero', 'reusable' => TRUE,
  'field_kicker' => $hero['kicker'], 'field_heading' => $hero['heading'], 'field_summary' => $hero['text'],
  'field_media' => ['target_id' => ns_media($hero['image'], $hero['alt'])->id()],
  'field_link' => ['uri' => 'internal:/shop', 'title' => $hero['cta']],
  'field_style' => 'overlay',
]);
ns_translate($blocks['home-hero'], 'fr', ['info' => 'Front page hero', 'field_kicker' => $home['fr']['hero']['kicker'], 'field_heading' => $home['fr']['hero']['heading'], 'field_summary' => $home['fr']['hero']['text'], 'field_link' => ['uri' => 'internal:/shop', 'title' => $home['fr']['hero']['cta']]]);
foreach ($home['features'] as $n => $feature) {
  $blocks["home-feature-$n"] = ns_content('block_content', "block:home-feature-$n", [
    'type' => 'feature', 'langcode' => 'en', 'info' => 'Front page: ' . $feature['heading'], 'reusable' => TRUE,
    'field_icon' => $feature['icon'], 'field_heading' => $feature['heading'], 'field_summary' => $feature['text'],
  ]);
  ns_translate($blocks["home-feature-$n"], 'fr', ['info' => 'Front page: ' . $feature['heading'], 'field_heading' => $home['fr']['features'][$n]['heading'], 'field_summary' => $home['fr']['features'][$n]['text']]);
}
$blocks['home-callout'] = ns_content('block_content', 'block:home-callout', [
  'type' => 'callout', 'langcode' => 'en', 'info' => 'Front page shipping callout', 'reusable' => TRUE,
  'field_heading' => $home['callout']['heading'], 'field_summary' => $home['callout']['text'],
  'field_link' => ['uri' => 'internal:/shipping', 'title' => $home['callout']['cta']],
  'field_tone' => 'pine',
]);
ns_translate($blocks['home-callout'], 'fr', ['info' => 'Front page shipping callout', 'field_heading' => $home['fr']['callout']['heading'], 'field_summary' => $home['fr']['callout']['text'], 'field_link' => ['uri' => 'internal:/shipping', 'title' => $home['fr']['callout']['cta']]]);
ns_say('reusable blocks: announcement, footer, and the front page’s hero, features and callout (all in French too)');

/* ── views ────────────────────────────────────────────────────────────── */

foreach (['products', 'journal', 'events'] as $id) {
  $config = require dirname(__DIR__) . "/views/$id.php";
  $view = View::load($id) ?: View::create(['id' => $id]);
  foreach ($config as $key => $value) {
    $view->set($key, $value);
  }
  $view->save();
}
// Core's taxonomy term pages: product cards in the same grid as the shop.
$terms_view = View::load('taxonomy_term');
$display = &$terms_view->getDisplay('default');
$display['display_options']['style'] = ['type' => 'grid_responsive', 'options' => ['grouping' => [], 'columns' => 3, 'cell_min_width' => 240, 'grid_gutter' => 24, 'alignment' => 'horizontal']];
$display['display_options']['pager'] = ['type' => 'mini', 'options' => ['items_per_page' => 12, 'offset' => 0]];
$terms_view->save();
ns_say('views: shop (/shop: category, price range, sort, pager), journal, events, related products, term pages');

/* ── menus ────────────────────────────────────────────────────────────── */

\Drupal::service('plugin.manager.menu.link')->updateDefinition('standard.front_page', ['enabled' => FALSE]);
$link = function (string $menu, string $key, string $title, string $uri, int $weight, ?string $parent = NULL, string $description = '', ?string $fr = NULL) {
  $values = [
    'menu_name' => $menu,
    'langcode' => 'en',
    'title' => $title,
    'description' => $description,
    'link' => ['uri' => $uri],
    'weight' => $weight,
    'expanded' => TRUE,
    'enabled' => TRUE,
    'parent' => $parent ? 'menu_link_content:' . ns_find('menu_link_content', $parent)->uuid() : '',
  ];
  $item = ns_content('menu_link_content', $key, $values);
  if ($fr) {
    ns_translate($item, 'fr', ['title' => $fr]);
  }
  return $item;
};
$term_uri = fn ($term) => 'entity:taxonomy_term/' . $term->id();
$link('main', 'main:shop', 'Shop', 'internal:/shop', 0, NULL, 'Everything we make', 'Boutique');
$w = 0;
$descriptions = ['Drinkware' => 'Enamel mugs and a steel bottle', 'Bags' => 'Totes and a roll-top pack', 'Prints' => 'Lake maps and star charts', 'Apparel' => 'Waxed caps, wool beanies', 'Paper goods' => 'Field journals', 'Camp' => 'Lantern and blanket'];
foreach ($categories as $name => $term) {
  $link('main', "main:shop:$name", $name, $term_uri($term), $w++, 'main:shop', $descriptions[$name], $term->getTranslation('fr')->label());
}
$link('main', 'main:journal', 'Journal', 'internal:/journal', 1, NULL, 'Notes from the workshop and the water', 'Journal');
$w = 0;
foreach (['Trips', 'Workshop', 'Maps'] as $tag) {
  $link('main', "main:journal:$tag", $tag, $term_uri($tags[$tag]), $w++, 'main:journal', ['Trips' => 'Nights out and what we packed', 'Workshop' => 'How things are made and tested', 'Maps' => 'Reading and drawing lakes'][$tag], ['Trips' => 'Sorties', 'Workshop' => 'Atelier', 'Maps' => 'Cartes'][$tag]);
}
$link('main', 'main:workshop', 'Workshop', 'internal:/workshop', 2, NULL, 'Where the goods are made', 'Atelier');
$link('main', 'main:workshop:about', 'About us', 'entity:node/' . $page_nodes['about']->id(), 0, 'main:workshop', 'Who makes what', 'À propos');
$link('main', 'main:workshop:events', 'Open days', 'internal:/events', 1, 'main:workshop', 'Come and see the workshop', 'Journées portes ouvertes');
$link('main', 'main:workshop:care', 'Care guide', 'entity:node/' . $page_nodes['care']->id(), 2, 'main:workshop', 'Make it last', 'Entretien');
$link('main', 'main:workshop:contact', 'Contact', 'internal:/contact', 3, 'main:workshop', 'Ask the workshop anything', 'Contact');
$link('footer', 'footer:about', 'About us', 'entity:node/' . $page_nodes['about']->id(), 0, NULL, '', 'À propos');
$link('footer', 'footer:shipping', 'Shipping & returns', 'entity:node/' . $page_nodes['shipping']->id(), 1, NULL, '', 'Livraison et retours');
$link('footer', 'footer:care', 'Care guide', 'entity:node/' . $page_nodes['care']->id(), 2, NULL, '', 'Entretien');
$link('footer', 'footer:events', 'Open days', 'internal:/events', 3, NULL, '', 'Portes ouvertes');
$link('footer', 'footer:contact', 'Contact', 'internal:/contact', 4, NULL, '', 'Contact');
ns_say('menus: a two-level main menu (shop categories, journal topics, the workshop) and the footer');

/* ── Layout Builder landing pages ─────────────────────────────────────── */

/** A Layout Builder component for a reusable block. */
function ns_lb_block(string $key, BlockContent $block, string $label, bool $show_label = FALSE): array {
  return [ns_uuid("component:$key"), ['id' => 'block_content:' . $block->uuid(), 'label' => $label, 'label_display' => $show_label ? 'visible' : '0', 'provider' => 'block_content', 'status' => TRUE, 'info' => '', 'view_mode' => 'full', 'context_mapping' => []]];
}

/** A Layout Builder component for a views block. */
function ns_lb_view(string $key, string $plugin, string $label): array {
  return [ns_uuid("component:$key"), ['id' => "views_block:$plugin", 'label' => $label, 'label_display' => 'visible', 'provider' => 'views', 'views_label' => '', 'items_per_page' => 'none', 'context_mapping' => []]];
}

/** A Layout Builder component for one of the page's own fields. */
function ns_lb_field(string $key, string $field, string $label): array {
  return [ns_uuid("component:$key"), ['id' => "field_block:node:landing_page:$field", 'label' => $label, 'label_display' => '0', 'provider' => 'layout_builder', 'formatter' => ['label' => 'hidden', 'type' => 'text_default', 'settings' => [], 'third_party_settings' => []], 'context_mapping' => ['entity' => 'layout_builder.entity', 'view_mode' => 'view_mode']]];
}

/**
 * Builds a landing page's layout from a list of sections. An inline block is
 * matched to the one already on the page by its component, updated in place,
 * and only handed to Layout Builder to save when it is new or changed.
 */
function ns_landing(string $key, array $values, array $sections, array $fr = []) {
  $storage = \Drupal::entityTypeManager()->getStorage('node');
  $node = ns_find('node', "landing:$key") ?? $storage->create(['uuid' => ns_uuid("node:landing:$key"), 'type' => 'landing_page', 'langcode' => 'en', 'uid' => 1]);
  foreach ($values as $field => $value) {
    $node->set($field, $value);
  }
  $existing = [];
  if (!$node->isNew()) {
    foreach ($node->get('layout_builder__layout')->getSections() as $section) {
      foreach ($section->getComponents() as $component) {
        $existing[$component->getUuid()] = $component->toArray()['configuration'];
      }
    }
  }
  $items = [];
  foreach ($sections as [$layout, $settings, $regions]) {
    $section = new Section($layout, $settings + ['context_mapping' => []]);
    foreach ($regions as $region => $components) {
      foreach ($components as $component) {
        if (($component['inline'] ?? NULL) !== NULL) {
          [$bundle, $label, $fields] = $component['inline'];
          $uuid = ns_uuid("component:{$component['key']}");
          $stored = $existing[$uuid] ?? [];
          $block = !empty($stored['block_revision_id']) ? \Drupal::entityTypeManager()->getStorage('block_content')->loadRevision($stored['block_revision_id']) : NULL;
          $block = $block ?: BlockContent::create(['type' => $bundle, 'reusable' => FALSE, 'langcode' => 'en']);
          $block->set('info', $label);
          foreach ($fields as $field => $value) {
            $block->set($field, $value);
          }
          if (!$block->isNew() && !$block->hasTranslationChanges() && $stored) {
            // Unchanged: keep the configuration exactly as Layout Builder
            // stored it (it compares layouts strictly), so nothing is saved.
            $config = $stored;
            $config['label'] = $label;
          }
          else {
            // New or changed: Layout Builder saves the block and records where it is used.
            $config = ['id' => "inline_block:$bundle", 'label' => $label, 'label_display' => '0', 'provider' => 'layout_builder', 'view_mode' => 'full', 'block_id' => $block->isNew() ? NULL : $block->id(), 'block_revision_id' => $block->isNew() ? NULL : $block->getRevisionId(), 'block_serialized' => serialize($block), 'context_mapping' => []];
          }
          $section->appendComponent(new SectionComponent($uuid, $region, $config));
        }
        else {
          [$uuid, $config] = $component;
          $section->appendComponent(new SectionComponent($uuid, $region, $config));
        }
      }
    }
    $items[] = ['section' => $section];
  }
  $node->get('layout_builder__layout')->setValue($items);
  if ($node->isNew() || $node->hasTranslationChanges()) {
    $node->set('moderation_state', 'published');
    $node->save();
  }
  if ($fr) {
    ns_translate($node, 'fr', $fr + ['moderation_state' => 'published']);
  }
  return $node;
}

$front = ns_landing('home', [
  'title' => $home['title'],
  'status' => 1,
  'body' => ns_text($home['intro']),
  'path' => ['alias' => '/home', 'pathauto' => 0],
], [
  ['layout_onecol', ['label' => 'Hero'], ['content' => [ns_lb_block('home-hero', $blocks['home-hero'], 'Front page hero')]]],
  ['layout_threecol_section', ['label' => 'Why Northstar', 'column_widths' => '33-34-33'], [
    'first' => [ns_lb_block('home-feature-0', $blocks['home-feature-0'], 'Tested outside')],
    'second' => [ns_lb_block('home-feature-1', $blocks['home-feature-1'], 'Drawn by hand')],
    'third' => [ns_lb_block('home-feature-2', $blocks['home-feature-2'], 'Returns for a season')],
  ]],
  ['layout_onecol', ['label' => 'Bestsellers'], ['content' => [ns_lb_view('home-featured', 'products-block_1', 'Bestsellers this month')]]],
  ['layout_twocol_section', ['label' => 'Introduction', 'column_widths' => '67-33'], [
    'first' => [ns_lb_field('home-intro', 'body', 'Introduction')],
    'second' => [ns_lb_block('home-callout', $blocks['home-callout'], 'Free shipping')],
  ]],
  ['layout_onecol', ['label' => 'From the journal'], ['content' => [ns_lb_view('home-journal', 'journal-block_1', 'From the journal')]]],
], [
  'title' => $home['fr']['title'],
  'body' => ns_text($home['fr']['intro']),
  'path' => ['alias' => '/home', 'pathauto' => 0],
]);
\Drupal::configFactory()->getEditable('system.site')->set('page.front', '/node/' . $front->id())->save();

$wk = $workshop;
$inline = fn (string $key, string $bundle, string $label, array $fields) => ['key' => $key, 'inline' => [$bundle, $label, $fields]];
ns_landing('workshop', [
  'title' => $wk['title'],
  'status' => 1,
  'body' => ns_text($wk['intro']),
  'path' => ['alias' => '/workshop', 'pathauto' => 0],
], [
  ['layout_onecol', ['label' => 'Hero'], ['content' => [$inline('workshop-hero', 'hero', 'Workshop hero', [
    'field_kicker' => $wk['hero']['kicker'], 'field_heading' => $wk['hero']['heading'], 'field_summary' => $wk['hero']['text'],
    'field_media' => ['target_id' => ns_media($wk['hero']['image'], $wk['hero']['alt'])->id()],
    'field_link' => ['uri' => 'internal:/events', 'title' => $wk['hero']['cta']], 'field_style' => 'split',
  ])]]],
  ['layout_twocol_section', ['label' => 'The shed', 'column_widths' => '50-50'], [
    'first' => [ns_lb_field('workshop-intro', 'body', 'Introduction')],
    'second' => [$inline('workshop-media', 'media_text', 'A season on the dock', [
      'field_heading' => $wk['media_text']['heading'], 'field_summary' => $wk['media_text']['text'],
      'field_media' => ['target_id' => ns_media($wk['media_text']['image'], $wk['media_text']['alt'])->id()],
      'field_link' => ['uri' => 'internal:/journal/a-cold-morning-test', 'title' => $wk['media_text']['cta']], 'field_reverse' => FALSE,
    ])],
  ]],
  ['layout_threecol_section', ['label' => 'In numbers', 'column_widths' => '33-34-33'], array_combine(['first', 'second', 'third'], array_map(
    fn ($n, $stat) => [$inline("workshop-stat-$n", 'stat', 'Number: ' . $stat['label'], ['field_number' => $stat['number'], 'field_heading' => $stat['label'], 'field_summary' => $stat['text']])],
    array_keys($wk['stats']), $wk['stats'],
  ))],
  ['layout_twocol_section', ['label' => 'Questions', 'column_widths' => '33-67'], [
    'first' => [$inline('workshop-faq-intro', 'callout', 'Questions', ['field_heading' => 'Questions we hear on the dock', 'field_summary' => 'Anything else, ask us: the contact form reaches whoever is at the workshop.', 'field_link' => ['uri' => 'internal:/contact', 'title' => 'Ask the workshop'], 'field_tone' => 'sand'])],
    'second' => array_map(fn ($n, $q) => $inline("workshop-faq-$n", 'faq_item', 'Question: ' . $q['q'], ['field_heading' => $q['q'], 'field_answer' => ns_text($q['a'])]), array_keys($wk['faq']), $wk['faq']),
  ]],
  ['layout_onecol', ['label' => 'Open days'], ['content' => [ns_lb_view('workshop-events', 'events-block_1', 'Come to an open day')]]],
  ['layout_onecol', ['label' => 'A word from Dana'], ['content' => [$inline('workshop-quote', 'quote', 'Quote from Dana', ['field_summary' => $wk['quote']['text'], 'field_cite' => $wk['quote']['cite']])]]],
]);
ns_say('landing pages: the front page (five sections, in French too) and the workshop (six sections of inline blocks)');

/* ── contact and search ───────────────────────────────────────────────── */

$form = ContactForm::load('workshop') ?: ContactForm::create(['id' => 'workshop']);
$form->set('label', 'Ask the workshop');
$form->set('recipients', ['hello@northstar.example']);
$form->set('message', 'Thank you. Whoever is at the workshop will answer within a few days.');
$form->set('reply', '');
$form->set('weight', 0);
$form->set('redirect', '/');
$form->save();
\Drupal::configFactory()->getEditable('contact.settings')->set('default_form', 'workshop')->save();
foreach (['anonymous', 'authenticated'] as $rid) {
  \Drupal\user\Entity\Role::load($rid)->grantPermission('access site-wide contact form')->save();
}
if ($feedback = ContactForm::load('feedback')) {
  $feedback->delete();
}
\Drupal::configFactory()->getEditable('search.settings')->set('default_page', 'node_search')->set('index.cron_limit', 100)->save();
ns_say('contact form "Ask the workshop" at /contact; search over content');

/* ── block placements ─────────────────────────────────────────────────── */

$theme = 'northstar';
$block_content = fn (string $slug, string $label, bool $show = FALSE) => ['block_content:' . $blocks[$slug]->uuid(), ['label' => $label, 'label_display' => $show ? 'visible' : '0', 'provider' => 'block_content', 'status' => TRUE, 'info' => '', 'view_mode' => 'full']];
$place = [
  'northstar_free_shipping' => ['announcement', ...$block_content('free-shipping', 'Free shipping')],
  'northstar_branding' => ['header', 'system_branding_block', ['label' => 'Site branding', 'label_display' => '0', 'provider' => 'system', 'use_site_logo' => TRUE, 'use_site_name' => TRUE, 'use_site_slogan' => FALSE]],
  'northstar_main_menu' => ['primary_menu', 'system_menu_block:main', ['label' => 'Main navigation', 'label_display' => '0', 'provider' => 'system', 'level' => 1, 'depth' => 2, 'expand_all_items' => TRUE]],
  'northstar_search' => ['header_tools', 'search_form_block', ['label' => 'Search', 'label_display' => '0', 'provider' => 'search', 'page_id' => 'node_search']],
  'northstar_language' => ['header_tools', 'language_block:language_interface', ['label' => 'Language', 'label_display' => '0', 'provider' => 'language']],
  'northstar_welcome' => ['header_tools', 'northstar_welcome', ['label' => 'Welcome back', 'label_display' => '0', 'provider' => 'northstar_account']],
  'northstar_messages' => ['highlighted', 'system_messages_block', ['label' => 'Status messages', 'label_display' => '0', 'provider' => 'system']],
  'northstar_breadcrumbs' => ['breadcrumb', 'system_breadcrumb_block', ['label' => 'Breadcrumbs', 'label_display' => '0', 'provider' => 'system']],
  'northstar_page_title' => ['content_above', 'page_title_block', ['label' => 'Page title', 'label_display' => '0', 'provider' => 'core']],
  'northstar_tabs' => ['content_above', 'local_tasks_block', ['label' => 'Tabs', 'label_display' => '0', 'provider' => 'core', 'primary' => TRUE, 'secondary' => TRUE]],
  'northstar_actions' => ['content_above', 'local_actions_block', ['label' => 'Primary admin actions', 'label_display' => '0', 'provider' => 'core']],
  'northstar_content' => ['content', 'system_main_block', ['label' => 'Main page content', 'label_display' => '0', 'provider' => 'system']],
  'northstar_shop_the_story' => ['sidebar', 'views_block:products-block_2', ['label' => 'From the shop', 'label_display' => 'visible', 'provider' => 'views', 'views_label' => '', 'items_per_page' => 'none']],
  'northstar_related' => ['content_below', 'views_block:products-block_3', ['label' => 'More like this', 'label_display' => 'visible', 'provider' => 'views', 'views_label' => '', 'items_per_page' => 'none']],
  'northstar_footer_about' => ['footer_top', ...$block_content('footer-about', 'About Northstar', TRUE)],
  'northstar_footer_menu' => ['footer_top', 'system_menu_block:footer', ['label' => 'Help', 'label_display' => 'visible', 'provider' => 'system', 'level' => 1, 'depth' => 1, 'expand_all_items' => FALSE]],
  'northstar_footer_letters' => ['footer_top', ...$block_content('footer-letters', 'Letters from the lake', TRUE)],
  'northstar_powered' => ['footer_bottom', 'system_powered_by_block', ['label' => 'Powered by Drupal', 'label_display' => '0', 'provider' => 'system']],
];
$visibility = [
  'northstar_shop_the_story' => ['entity_bundle:node' => ['id' => 'entity_bundle:node', 'negate' => FALSE, 'context_mapping' => ['node' => '@node.node_route_context:node'], 'bundles' => ['article' => 'article']]],
  'northstar_related' => ['entity_bundle:node' => ['id' => 'entity_bundle:node', 'negate' => FALSE, 'context_mapping' => ['node' => '@node.node_route_context:node'], 'bundles' => ['product' => 'product']]],
  'northstar_welcome' => ['user_role' => ['id' => 'user_role', 'negate' => FALSE, 'context_mapping' => ['user' => '@user.current_user_context:current_user'], 'roles' => ['authenticated' => 'authenticated']]],
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
  $block->set('plugin', $plugin);
  $block->set('settings', ['id' => $plugin] + $settings);
  $block->set('visibility', $visibility[$id] ?? []);
  $block->save();
}
ns_say(count($place) . ' blocks placed in ' . count(array_unique(array_column($place, 0))) . ' regions');

/* ── French for the theme's words and the views' titles ───────────────── */

$words = require "$data/french.php";
$locale = \Drupal::service('locale.storage');
foreach ($words['strings'] as $key => $translation) {
  // A key is the English, or "English|context" for words core translates in a context (month names).
  [$source, $context] = array_pad(explode('|', $key, 2), 2, '');
  $string = $locale->findString(['source' => $source, 'context' => $context]) ?: $locale->createString(['source' => $source, 'context' => $context])->save();
  $existing = $locale->findTranslation(['lid' => $string->lid, 'language' => 'fr']);
  if ($existing && !$existing->isNew() && $existing->getString() !== NULL) {
    if ($existing->getString() !== $translation) {
      $existing->setString($translation)->save();
    }
  }
  else {
    $locale->createTranslation(['lid' => $string->lid, 'language' => 'fr', 'translation' => $translation])->save();
  }
}
$overrides = \Drupal::languageManager();
foreach ($words['config'] as $name => $values) {
  $override = $overrides->getLanguageConfigOverride('fr', $name);
  foreach ($values as $key => $value) {
    $override->set($key, $value);
  }
  $override->save();
}
if (function_exists('_locale_refresh_translations')) {
  _locale_refresh_translations(['fr']);
}
\Drupal::cache('discovery')->deleteAll();
ns_say(count($words['strings']) . ' theme words and ' . count($words['config']) . ' configuration objects in French');
