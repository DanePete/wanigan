<?php
/**
 * "More like this" for Query Loop blocks.
 *
 * A Query Loop whose query carries "fieldnotesRelated": true shows posts that
 * share the page's own category (for a post) or region (for a trail), and
 * leaves the page's own post out. The theme's single templates use it for
 * "More from the journal" and "More trails nearby".
 */

defined( 'ABSPATH' ) || exit;

add_filter(
	'query_loop_block_query_vars',
	static function ( array $query, WP_Block $block ): array {
		if ( empty( $block->context['query']['fieldnotesRelated'] ) ) {
			return $query;
		}
		$current = get_queried_object();
		if ( ! $current instanceof WP_Post ) {
			return $query;
		}
		$query['post__not_in']        = array_merge( (array) ( $query['post__not_in'] ?? array() ), array( $current->ID ) );
		$query['ignore_sticky_posts'] = true;
		$taxonomy                     = 'trail' === $current->post_type ? 'region' : 'category';
		$terms                        = wp_get_post_terms( $current->ID, $taxonomy, array( 'fields' => 'ids' ) );
		if ( ! is_wp_error( $terms ) && $terms ) {
			$query['tax_query'] = array(
				array(
					'taxonomy' => $taxonomy,
					'terms'    => $terms,
				),
			);
		}
		return $query;
	},
	10,
	2
);
