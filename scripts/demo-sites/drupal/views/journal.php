<?php

/**
 * @file
 * The journal view: every entry at /journal with a topic filter and a
 * pager, and the latest three as a block.
 */

require_once __DIR__ . '/common.php';

$filters = ns_views_published_of('article');
$filters += ns_views_filter('field_tags_target_id', 'node__field_tags', 'field_tags_target_id', 'taxonomy_index_tid', [
  'operator' => 'or', 'value' => [], 'exposed' => TRUE,
  'expose' => ns_views_expose('topic', 'Topic'),
  'reduce_duplicates' => FALSE, 'vid' => 'tags', 'type' => 'select', 'hierarchy' => FALSE, 'limit' => TRUE, 'error_message' => TRUE,
]);
$default = ns_views_base('Journal', $filters, ns_views_list('journal__item'), ns_views_pager('full', 6));
$default['empty'] = ns_views_text('area_text_custom', '<p>Nothing on that topic yet.</p>', TRUE);

return [
  'label' => 'Journal',
  'module' => 'views',
  'description' => 'Journal entries, newest first.',
  'tag' => 'northstar',
  'base_table' => 'node_field_data',
  'base_field' => 'nid',
  'display' => [
    'default' => ns_views_display('default', 'Default', 'default', 0, $default),
    'page_1' => ns_views_display('page_1', 'Journal', 'page', 1, [
      'path' => 'journal',
      'header' => ns_views_text('area_text_custom', '<p>Notes from the workshop and the water: how things are tested, made and cared for.</p>'),
      'defaults' => ['header' => FALSE],
    ]),
    'block_1' => ns_views_display('block_1', 'Latest', 'block', 2, [
      'display_description' => 'The three newest entries.',
      'block_description' => 'From the journal',
      'block_hide_empty' => TRUE,
      'title' => 'From the journal',
      'filters' => ns_views_published_of('article'),
      'filter_groups' => ['operator' => 'AND', 'groups' => [1 => 'AND']],
      'pager' => ['type' => 'some', 'options' => ['offset' => 0, 'items_per_page' => 3]],
      'empty' => [],
      'footer' => ns_views_text('area_text_custom', '<p><a class="button button--secondary" href="/journal">Read the journal <span aria-hidden="true">→</span></a></p>'),
      'defaults' => ['title' => FALSE, 'pager' => FALSE, 'footer' => FALSE, 'filters' => FALSE, 'filter_groups' => FALSE, 'empty' => FALSE],
    ]),
  ],
];
