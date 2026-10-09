<?php

/**
 * @file
 * Pieces both views share: handlers written the way Views exports them.
 */

function ns_views_text(string $id, string $content, bool $empty = FALSE): array {
  return [$id => [
    'id' => $id,
    'table' => 'views',
    'field' => 'area_text_custom',
    'relationship' => 'none',
    'group_type' => 'group',
    'admin_label' => '',
    'plugin_id' => 'text_custom',
    'empty' => $empty,
    'content' => $content,
    'tokenize' => FALSE,
  ]];
}

function ns_views_published_of(string $bundle, bool $promoted = FALSE): array {
  $filters = [
    'status' => [
      'id' => 'status', 'table' => 'node_field_data', 'field' => 'status', 'relationship' => 'none', 'group_type' => 'group', 'admin_label' => '',
      'entity_type' => 'node', 'entity_field' => 'status', 'plugin_id' => 'boolean', 'operator' => '=', 'value' => '1', 'group' => 1, 'exposed' => FALSE,
      'expose' => ['operator_id' => '', 'label' => '', 'description' => '', 'use_operator' => FALSE, 'operator' => '', 'operator_limit_selection' => FALSE, 'operator_list' => [], 'identifier' => '', 'required' => FALSE, 'remember' => FALSE, 'multiple' => FALSE, 'remember_roles' => ['authenticated' => 'authenticated']],
      'is_grouped' => FALSE,
    ],
    'type' => [
      'id' => 'type', 'table' => 'node_field_data', 'field' => 'type', 'relationship' => 'none', 'group_type' => 'group', 'admin_label' => '',
      'entity_type' => 'node', 'entity_field' => 'type', 'plugin_id' => 'bundle', 'operator' => 'in', 'value' => [$bundle => $bundle], 'group' => 1, 'exposed' => FALSE,
      'expose' => ['operator_id' => '', 'label' => '', 'description' => '', 'use_operator' => FALSE, 'operator' => '', 'operator_limit_selection' => FALSE, 'operator_list' => [], 'identifier' => '', 'required' => FALSE, 'remember' => FALSE, 'multiple' => FALSE, 'remember_roles' => ['authenticated' => 'authenticated'], 'reduce' => FALSE],
      'is_grouped' => FALSE,
    ],
  ];
  if ($promoted) {
    $filters['promote'] = ['plugin_id' => 'boolean', 'id' => 'promote', 'field' => 'promote', 'entity_field' => 'promote'] + $filters['status'];
  }
  return $filters;
}

function ns_views_newest_first(): array {
  return ['created' => [
    'id' => 'created', 'table' => 'node_field_data', 'field' => 'created', 'relationship' => 'none', 'group_type' => 'group', 'admin_label' => '',
    'entity_type' => 'node', 'entity_field' => 'created', 'plugin_id' => 'date', 'order' => 'DESC',
    'expose' => ['label' => '', 'field_identifier' => ''], 'exposed' => FALSE, 'granularity' => 'second',
  ]];
}

function ns_views_base(string $title, array $filters, array $style, int $items): array {
  return [
    'title' => $title,
    'fields' => [],
    'access' => ['type' => 'perm', 'options' => ['perm' => 'access content']],
    'cache' => ['type' => 'tag', 'options' => []],
    'query' => ['type' => 'views_query', 'options' => ['query_comment' => '', 'disable_sql_rewrite' => FALSE, 'distinct' => FALSE, 'replica' => FALSE, 'query_tags' => []]],
    'exposed_form' => ['type' => 'basic', 'options' => ['submit_button' => 'Show', 'reset_button' => FALSE, 'reset_button_label' => 'Reset', 'exposed_sorts_label' => 'Sort by', 'expose_sort_order' => TRUE, 'sort_asc_label' => 'Asc', 'sort_desc_label' => 'Desc']],
    'pager' => ['type' => 'mini', 'options' => ['offset' => 0, 'pagination_heading_level' => 'h4', 'items_per_page' => $items, 'total_pages' => NULL, 'id' => 0, 'tags' => ['next' => '››', 'previous' => '‹‹'], 'expose' => ['items_per_page' => FALSE, 'items_per_page_label' => 'Items per page', 'items_per_page_options' => '5, 10, 25, 50', 'items_per_page_options_all' => FALSE, 'items_per_page_options_all_label' => '- All -', 'offset' => FALSE, 'offset_label' => 'Offset']]],
    'sorts' => ns_views_newest_first(),
    'filters' => $filters,
    'filter_groups' => ['operator' => 'AND', 'groups' => [1 => 'AND']],
    'style' => $style,
    'row' => ['type' => 'entity:node', 'options' => ['relationship' => 'none', 'view_mode' => 'teaser']],
    'header' => [],
    'footer' => [],
    'empty' => [],
    'relationships' => [],
    'arguments' => [],
    'display_extenders' => [],
    'use_ajax' => FALSE,
  ];
}

function ns_views_some(int $items): array {
  return ['type' => 'some', 'options' => ['offset' => 0, 'items_per_page' => $items]];
}
