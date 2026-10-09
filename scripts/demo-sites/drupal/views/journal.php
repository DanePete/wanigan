<?php

/**
 * @file
 * The journal view: every entry at /journal, and the latest three as a block.
 */

require_once __DIR__ . '/common.php';

$default = ns_views_base('Journal', ns_views_published_of('article'), ['type' => 'default', 'options' => ['grouping' => [], 'row_class' => 'journal__item', 'default_row_class' => TRUE, 'uses_fields' => FALSE]], 9);

return [
  'label' => 'Journal',
  'module' => 'views',
  'description' => 'Journal entries, newest first.',
  'tag' => 'northstar',
  'base_table' => 'node_field_data',
  'base_field' => 'nid',
  'display' => [
    'default' => [
      'id' => 'default',
      'display_title' => 'Default',
      'display_plugin' => 'default',
      'position' => 0,
      'display_options' => $default,
    ],
    'page_1' => [
      'id' => 'page_1',
      'display_title' => 'Journal',
      'display_plugin' => 'page',
      'position' => 1,
      'display_options' => [
        'path' => 'journal',
        'header' => ns_views_text('area_text_custom', '<p>Notes from the workshop and the water: how things are tested, made and cared for.</p>'),
        'defaults' => ['header' => FALSE],
        'display_extenders' => [],
      ],
    ],
    'block_1' => [
      'id' => 'block_1',
      'display_title' => 'Latest',
      'display_plugin' => 'block',
      'position' => 2,
      'display_options' => [
        'display_description' => 'The three newest entries.',
        'block_description' => 'From the journal',
        'block_hide_empty' => TRUE,
        'title' => 'From the journal',
        'pager' => ns_views_some(3),
        'footer' => ns_views_text('area_text_custom', '<p><a class="button button--secondary" href="/journal">Read the journal <span aria-hidden="true">→</span></a></p>'),
        'defaults' => ['title' => FALSE, 'pager' => FALSE, 'footer' => FALSE],
        'display_extenders' => [],
      ],
    ],
  ],
];
