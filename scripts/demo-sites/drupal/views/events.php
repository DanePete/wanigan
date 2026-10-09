<?php

/**
 * @file
 * The events view: open days still to come, soonest first, at /events and
 * as a block.
 */

require_once __DIR__ . '/common.php';

$filters = ns_views_published_of('event');
$filters += ns_views_filter('field_when_end_value', 'node__field_when', 'field_when_end_value', 'datetime', [
  'operator' => '>=', 'value' => ['min' => '', 'max' => '', 'value' => 'now', 'type' => 'offset'],
]);
$default = ns_views_base('Open days', $filters, ns_views_list('events__item'), ns_views_pager('mini', 10));
$default['sorts'] = ns_views_sort('field_when_value', 'node__field_when', 'field_when_value', 'datetime', 'ASC', '', '', ['granularity' => 'second']);
$default['empty'] = ns_views_text('area_text_custom', '<p>No open days planned just now. <a href="/contact">Ask us</a> when the next one is.</p>', TRUE);

return [
  'label' => 'Events',
  'module' => 'views',
  'description' => 'Open days still to come, soonest first.',
  'tag' => 'northstar',
  'base_table' => 'node_field_data',
  'base_field' => 'nid',
  'display' => [
    'default' => ns_views_display('default', 'Default', 'default', 0, $default),
    'page_1' => ns_views_display('page_1', 'Open days', 'page', 1, [
      'path' => 'events',
      'header' => ns_views_text('area_text_custom', '<p>Twice a season the workshop doors open on a Saturday, with a few evenings in between.</p>'),
      'defaults' => ['header' => FALSE],
    ]),
    'block_1' => ns_views_display('block_1', 'Coming up', 'block', 2, [
      'display_description' => 'The next three.',
      'block_description' => 'Coming up at the workshop',
      'block_hide_empty' => TRUE,
      'title' => 'Come to an open day',
      'pager' => ['type' => 'some', 'options' => ['offset' => 0, 'items_per_page' => 3]],
      'defaults' => ['title' => FALSE, 'pager' => FALSE],
    ]),
  ],
];
