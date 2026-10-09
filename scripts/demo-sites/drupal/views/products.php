<?php

/**
 * @file
 * The products view: the shop at /shop (a grid with category and price range
 * filters, a sort and a pager), promoted products for the front page and the
 * journal's sidebar, and "More like this" under a product (same category,
 * not the product itself).
 */

require_once __DIR__ . '/common.php';

$filters = ns_views_published_of('product');
$filters += ns_views_filter('field_category_target_id', 'node__field_category', 'field_category_target_id', 'taxonomy_index_tid', [
  'operator' => 'or', 'value' => [], 'exposed' => TRUE,
  'expose' => ['label' => 'Category', 'identifier' => 'category'] + ns_views_expose('category', 'Category'),
  'reduce_duplicates' => FALSE, 'vid' => 'category', 'type' => 'select', 'hierarchy' => FALSE, 'limit' => TRUE, 'error_message' => TRUE,
]);
$filters += ns_views_filter('field_price_value', 'node__field_price', 'field_price_value', 'numeric', [
  'operator' => 'between', 'value' => ['min' => '', 'max' => '', 'value' => ''], 'exposed' => TRUE,
  'expose' => ns_views_expose('price', 'Price, $') + ['min_placeholder' => 'Min', 'max_placeholder' => 'Max'],
]);
$default = ns_views_base('Shop', $filters, ns_views_grid(), ns_views_pager('full', 9));
$default['sorts'] = ns_views_sort('created', 'node_field_data', 'created', 'date', 'DESC', 'Newest', 'newest', ['entity_type' => 'node', 'entity_field' => 'created', 'granularity' => 'second'])
  + ns_views_sort('field_price_value', 'node__field_price', 'field_price_value', 'standard', 'ASC', 'Price, low to high', 'price_low')
  + ns_views_sort('field_price_value_1', 'node__field_price', 'field_price_value', 'standard', 'DESC', 'Price, high to low', 'price_high')
  + ns_views_sort('title', 'node_field_data', 'title', 'standard', 'ASC', 'Name', 'name', ['entity_type' => 'node', 'entity_field' => 'title']);
$default['empty'] = ns_views_text('area_text_custom', '<p>Nothing matches. Try another category or a wider price range, or <a href="/shop">see everything</a>.</p>', TRUE);
$default['header'] = ns_views_text('result', '', FALSE);
$default['header']['result'] = ['id' => 'result', 'table' => 'views', 'field' => 'result', 'relationship' => 'none', 'group_type' => 'group', 'admin_label' => '', 'plugin_id' => 'result', 'empty' => FALSE, 'content' => 'Showing @start–@end of @total'];

$promoted = ns_views_published_of('product', TRUE);
// Blocks draw their rows as a plain list, which the theme lays out as cards.
$row_list = ['style' => ns_views_list('products__item'), 'row' => ['type' => 'entity:node', 'options' => ['relationship' => 'none', 'view_mode' => 'teaser']]];
$simple_sort = ns_views_newest_first();

return [
  'label' => 'Products',
  'module' => 'views',
  'description' => 'The shop, the promoted products and "More like this".',
  'tag' => 'northstar',
  'base_table' => 'node_field_data',
  'base_field' => 'nid',
  'display' => [
    'default' => ns_views_display('default', 'Default', 'default', 0, $default),
    'page_1' => ns_views_display('page_1', 'Shop', 'page', 1, [
      'path' => 'shop',
      'menu' => ['type' => 'none'],
    ]),
    'block_1' => ns_views_display('block_1', 'Bestsellers', 'block', 2, [
      'display_description' => 'Four promoted products, for the front page.',
      'block_description' => 'Bestsellers',
      'block_hide_empty' => TRUE,
      'title' => 'Bestsellers this month',
      'filters' => $promoted,
      'filter_groups' => ['operator' => 'AND', 'groups' => [1 => 'AND']],
      'sorts' => $simple_sort,
      'pager' => ['type' => 'some', 'options' => ['offset' => 0, 'items_per_page' => 4]],
      'header' => [],
      'empty' => [],
      'footer' => ns_views_text('area_text_custom', '<p><a class="button button--secondary" href="/shop">See everything in the shop <span aria-hidden="true">→</span></a></p>'),
      'defaults' => ['title' => FALSE, 'filters' => FALSE, 'filter_groups' => FALSE, 'pager' => FALSE, 'footer' => FALSE, 'header' => FALSE, 'empty' => FALSE, 'sorts' => FALSE, 'style' => FALSE, 'row' => FALSE],
    ] + $row_list),
    'block_2' => ns_views_display('block_2', 'From the shop', 'block', 3, [
      'display_description' => 'Two promoted products, for the journal\'s sidebar.',
      'block_description' => 'From the shop',
      'block_hide_empty' => TRUE,
      'title' => 'From the shop',
      'filters' => $promoted,
      'filter_groups' => ['operator' => 'AND', 'groups' => [1 => 'AND']],
      'sorts' => $simple_sort,
      'pager' => ['type' => 'some', 'options' => ['offset' => 0, 'items_per_page' => 2]],
      'header' => [],
      'empty' => [],
      'defaults' => ['title' => FALSE, 'filters' => FALSE, 'filter_groups' => FALSE, 'pager' => FALSE, 'header' => FALSE, 'empty' => FALSE, 'sorts' => FALSE, 'style' => FALSE, 'row' => FALSE],
    ] + $row_list),
    'block_3' => ns_views_display('block_3', 'More like this', 'block', 4, [
      'display_description' => 'Products in the same category as the one shown, not counting it.',
      'block_description' => 'More like this',
      'block_hide_empty' => TRUE,
      'title' => 'More like this',
      'filters' => ns_views_published_of('product'),
      'filter_groups' => ['operator' => 'AND', 'groups' => [1 => 'AND']],
      'sorts' => $simple_sort,
      'pager' => ['type' => 'some', 'options' => ['offset' => 0, 'items_per_page' => 4]],
      'header' => [],
      'empty' => [],
      'arguments' => [
        'field_category_target_id' => [
          'id' => 'field_category_target_id', 'table' => 'node__field_category', 'field' => 'field_category_target_id', 'relationship' => 'none', 'group_type' => 'group', 'admin_label' => '',
          'plugin_id' => 'numeric', 'default_action' => 'default', 'exception' => ['value' => 'all', 'title_enable' => FALSE, 'title' => 'All'], 'title_enable' => FALSE, 'title' => '',
          'default_argument_type' => 'taxonomy_tid', 'default_argument_options' => ['term_page' => '0', 'node' => TRUE, 'limit' => TRUE, 'vids' => ['category' => 'category'], 'anyall' => '+'],
          'summary_options' => ['base_path' => '', 'count' => TRUE, 'override' => FALSE, 'items_per_page' => 25], 'summary' => ['sort_order' => 'asc', 'number_of_records' => 0, 'format' => 'default_summary'],
          'specify_validation' => FALSE, 'validate' => ['type' => 'none', 'fail' => 'not found'], 'validate_options' => [], 'break_phrase' => TRUE, 'not' => FALSE,
        ],
        'nid' => [
          'id' => 'nid', 'table' => 'node_field_data', 'field' => 'nid', 'relationship' => 'none', 'group_type' => 'group', 'admin_label' => '', 'entity_type' => 'node', 'entity_field' => 'nid',
          'plugin_id' => 'node_nid', 'default_action' => 'default', 'exception' => ['value' => 'all', 'title_enable' => FALSE, 'title' => 'All'], 'title_enable' => FALSE, 'title' => '',
          'default_argument_type' => 'node', 'default_argument_options' => [],
          'summary_options' => ['base_path' => '', 'count' => TRUE, 'override' => FALSE, 'items_per_page' => 25], 'summary' => ['sort_order' => 'asc', 'number_of_records' => 0, 'format' => 'default_summary'],
          'specify_validation' => FALSE, 'validate' => ['type' => 'none', 'fail' => 'not found'], 'validate_options' => [], 'break_phrase' => FALSE, 'not' => TRUE,
        ],
      ],
      'defaults' => ['title' => FALSE, 'filters' => FALSE, 'filter_groups' => FALSE, 'pager' => FALSE, 'header' => FALSE, 'empty' => FALSE, 'sorts' => FALSE, 'arguments' => FALSE, 'style' => FALSE, 'row' => FALSE],
    ] + $row_list),
  ],
];
