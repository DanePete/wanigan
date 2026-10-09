<?php

/**
 * @file
 * The products view: the shop at /shop (a grid with a category filter), and
 * two blocks of promoted products (the front page's bestsellers, and the
 * journal's sidebar).
 */

require_once __DIR__ . '/common.php';

$grid = ['type' => 'grid_responsive', 'options' => ['grouping' => [], 'columns' => 3, 'cell_min_width' => 240, 'grid_gutter' => 24, 'alignment' => 'horizontal']];
$filters = ns_views_published_of('product');
$filters['field_category_target_id'] = [
  'id' => 'field_category_target_id', 'table' => 'node__field_category', 'field' => 'field_category_target_id', 'relationship' => 'none', 'group_type' => 'group', 'admin_label' => '',
  'plugin_id' => 'taxonomy_index_tid', 'operator' => 'or', 'value' => [], 'group' => 1, 'exposed' => TRUE,
  'expose' => ['operator_id' => 'field_category_target_id_op', 'label' => 'Category', 'description' => '', 'use_operator' => FALSE, 'operator' => 'field_category_target_id_op', 'operator_limit_selection' => FALSE, 'operator_list' => [], 'identifier' => 'category', 'required' => FALSE, 'remember' => FALSE, 'multiple' => FALSE, 'remember_roles' => ['authenticated' => 'authenticated', 'anonymous' => '0'], 'reduce' => FALSE],
  'is_grouped' => FALSE,
  'group_info' => ['label' => '', 'description' => '', 'identifier' => '', 'optional' => TRUE, 'widget' => 'select', 'multiple' => FALSE, 'remember' => FALSE, 'default_group' => 'All', 'default_group_multiple' => [], 'group_items' => []],
  'reduce_duplicates' => FALSE, 'vid' => 'category', 'type' => 'select', 'hierarchy' => FALSE, 'limit' => TRUE, 'error_message' => TRUE,
];
$default = ns_views_base('Shop', $filters, $grid, 12);
$default['empty'] = ns_views_text('area_text_custom', '<p>Nothing in this category yet. Try another, or <a href="/shop">see everything</a>.</p>', TRUE);

$promoted = ns_views_published_of('product', TRUE);

return [
  'label' => 'Products',
  'module' => 'views',
  'description' => 'The shop: every product in a grid, with a category filter; and promoted products as blocks.',
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
      'display_title' => 'Shop',
      'display_plugin' => 'page',
      'position' => 1,
      'display_options' => [
        'path' => 'shop',
        'header' => ns_views_text('area_text_custom', '<p>Twelve things we make and use ourselves. Pick a category, or see them all.</p>'),
        'defaults' => ['header' => FALSE],
        'display_extenders' => [],
      ],
    ],
    'block_1' => [
      'id' => 'block_1',
      'display_title' => 'Bestsellers',
      'display_plugin' => 'block',
      'position' => 2,
      'display_options' => [
        'display_description' => 'Four promoted products, for the front page.',
        'block_description' => 'Bestsellers',
        'block_hide_empty' => TRUE,
        'title' => 'Bestsellers this month',
        'filters' => $promoted,
        'filter_groups' => ['operator' => 'AND', 'groups' => [1 => 'AND']],
        'pager' => ns_views_some(4),
        'footer' => ns_views_text('area_text_custom', '<p><a class="button button--secondary" href="/shop">See everything in the shop <span aria-hidden="true">→</span></a></p>'),
        'defaults' => ['title' => FALSE, 'filters' => FALSE, 'filter_groups' => FALSE, 'pager' => FALSE, 'footer' => FALSE],
        'display_extenders' => [],
      ],
    ],
    'block_2' => [
      'id' => 'block_2',
      'display_title' => 'From the shop',
      'display_plugin' => 'block',
      'position' => 3,
      'display_options' => [
        'display_description' => 'Two promoted products, for the journal\'s sidebar.',
        'block_description' => 'From the shop',
        'block_hide_empty' => TRUE,
        'title' => 'From the shop',
        'filters' => $promoted,
        'filter_groups' => ['operator' => 'AND', 'groups' => [1 => 'AND']],
        'pager' => ns_views_some(2),
        'defaults' => ['title' => FALSE, 'filters' => FALSE, 'filter_groups' => FALSE, 'pager' => FALSE],
        'display_extenders' => [],
      ],
    ],
  ],
];
