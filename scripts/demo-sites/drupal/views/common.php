<?php

/**
 * @file
 * Pieces the views share: handlers written the way Views exports them.
 */

function ns_views_text(string $id, string $content, bool $empty = FALSE): array {
  return [$id => [
    'id' => $id, 'table' => 'views', 'field' => 'area_text_custom', 'relationship' => 'none', 'group_type' => 'group', 'admin_label' => '',
    'plugin_id' => 'text_custom', 'empty' => $empty, 'content' => $content, 'tokenize' => FALSE,
  ]];
}

function ns_views_expose(string $identifier = '', string $label = ''): array {
  return ['operator_id' => $identifier ? "{$identifier}_op" : '', 'label' => $label, 'description' => '', 'use_operator' => FALSE, 'operator' => $identifier ? "{$identifier}_op" : '', 'operator_limit_selection' => FALSE, 'operator_list' => [], 'identifier' => $identifier, 'required' => FALSE, 'remember' => FALSE, 'multiple' => FALSE, 'remember_roles' => ['authenticated' => 'authenticated'], 'reduce' => FALSE, 'placeholder' => ''];
}

function ns_views_filter(string $id, string $table, string $field, string $plugin, array $more): array {
  return [$id => $more + [
    'id' => $id, 'table' => $table, 'field' => $field, 'relationship' => 'none', 'group_type' => 'group', 'admin_label' => '',
    'plugin_id' => $plugin, 'operator' => '=', 'value' => '', 'group' => 1, 'exposed' => FALSE, 'expose' => ns_views_expose(), 'is_grouped' => FALSE,
  ]];
}

function ns_views_published_of(string $bundle, bool $promoted = FALSE): array {
  $filters = ns_views_filter('status', 'node_field_data', 'status', 'boolean', ['entity_type' => 'node', 'entity_field' => 'status', 'value' => '1'])
    + ns_views_filter('type', 'node_field_data', 'type', 'bundle', ['entity_type' => 'node', 'entity_field' => 'type', 'operator' => 'in', 'value' => [$bundle => $bundle]])
    // Each language shows its own translation, once.
    + ns_views_filter('langcode', 'node_field_data', 'langcode', 'language', ['entity_type' => 'node', 'entity_field' => 'langcode', 'operator' => 'in', 'value' => ['***LANGUAGE_language_interface***' => '***LANGUAGE_language_interface***']]);
  if ($promoted) {
    $filters += ns_views_filter('promote', 'node_field_data', 'promote', 'boolean', ['entity_type' => 'node', 'entity_field' => 'promote', 'value' => '1']);
  }
  return $filters;
}

function ns_views_sort(string $id, string $table, string $field, string $plugin, string $order, string $label = '', string $identifier = '', array $more = []): array {
  return [$id => $more + [
    'id' => $id, 'table' => $table, 'field' => $field, 'relationship' => 'none', 'group_type' => 'group', 'admin_label' => '',
    'plugin_id' => $plugin, 'order' => $order, 'exposed' => (bool) $label, 'expose' => ['label' => $label, 'field_identifier' => $identifier],
  ]];
}

function ns_views_newest_first(): array {
  return ns_views_sort('created', 'node_field_data', 'created', 'date', 'DESC', '', '', ['entity_type' => 'node', 'entity_field' => 'created', 'granularity' => 'second']);
}

function ns_views_pager(string $type, int $items): array {
  return ['type' => $type, 'options' => ['offset' => 0, 'pagination_heading_level' => 'h2', 'items_per_page' => $items, 'total_pages' => NULL, 'id' => 0, 'quantity' => 5, 'tags' => ['next' => 'Next ›', 'previous' => '‹ Previous', 'first' => '« First', 'last' => 'Last »'], 'expose' => ['items_per_page' => FALSE, 'items_per_page_label' => 'Items per page', 'items_per_page_options' => '5, 10, 25, 50', 'items_per_page_options_all' => FALSE, 'items_per_page_options_all_label' => '- All -', 'offset' => FALSE, 'offset_label' => 'Offset']]];
}

function ns_views_base(string $title, array $filters, array $style, array $pager): array {
  return [
    'title' => $title,
    'fields' => [],
    'access' => ['type' => 'perm', 'options' => ['perm' => 'access content']],
    'cache' => ['type' => 'tag', 'options' => []],
    'query' => ['type' => 'views_query', 'options' => ['query_comment' => '', 'disable_sql_rewrite' => FALSE, 'distinct' => FALSE, 'replica' => FALSE, 'query_tags' => []]],
    'exposed_form' => ['type' => 'basic', 'options' => ['submit_button' => 'Show', 'reset_button' => FALSE, 'reset_button_label' => 'Reset', 'exposed_sorts_label' => 'Sort by', 'expose_sort_order' => FALSE, 'sort_asc_label' => 'Asc', 'sort_desc_label' => 'Desc']],
    'pager' => $pager,
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
    'rendering_language' => '***LANGUAGE_entity_translation***',
    'use_ajax' => FALSE,
  ];
}

function ns_views_grid(): array {
  return ['type' => 'grid_responsive', 'options' => ['grouping' => [], 'columns' => 3, 'cell_min_width' => 240, 'grid_gutter' => 24, 'alignment' => 'horizontal']];
}

function ns_views_list(string $class): array {
  return ['type' => 'default', 'options' => ['grouping' => [], 'row_class' => $class, 'default_row_class' => TRUE, 'uses_fields' => FALSE]];
}

function ns_views_display(string $id, string $title, string $plugin, int $position, array $options): array {
  return ['id' => $id, 'display_title' => $title, 'display_plugin' => $plugin, 'position' => $position, 'display_options' => $options + ['display_extenders' => []]];
}
