<?php
/**
 * Fieldnotes: a child of Twenty Twenty-Five.
 *
 * Most of the design is in theme.json (palette, type, spacing) and the
 * templates, parts and patterns. What is here: the theme's stylesheet, a
 * pattern category, and the custom block styles, each with its own small
 * stylesheet that loads only on pages using that block.
 *
 * @package Fieldnotes
 */

defined( 'ABSPATH' ) || exit;

/**
 * The theme's stylesheet: the few things theme.json cannot say (underline
 * colours, the sticky header, motion), on the front and in the editor.
 */
add_action(
	'wp_enqueue_scripts',
	static function () {
		$file = get_theme_file_path( 'assets/css/theme.css' );
		wp_enqueue_style( 'fieldnotes', get_theme_file_uri( 'assets/css/theme.css' ), array(), (string) filemtime( $file ) );
		wp_style_add_data( 'fieldnotes', 'path', $file );
	}
);
add_action(
	'after_setup_theme',
	static function () {
		add_editor_style( 'assets/css/theme.css' );
		remove_theme_support( 'core-block-patterns' );
	}
);

/**
 * The custom block styles: block => [style name => label]. Each block's styles
 * live in assets/css/blocks/<block>.css, enqueued with that block.
 */
function fieldnotes_block_styles(): array {
	return array(
		'core/list'          => array( 'checklist' => __( 'Checklist', 'fieldnotes' ) ),
		'core/table'         => array( 'logbook' => __( 'Logbook', 'fieldnotes' ) ),
		'core/group'         => array(
			'card'     => __( 'Card', 'fieldnotes' ),
			'notebook' => __( 'Notebook page', 'fieldnotes' ),
		),
		'core/image'         => array( 'plate' => __( 'Plate', 'fieldnotes' ) ),
		'core/separator'     => array( 'contour' => __( 'Contour', 'fieldnotes' ) ),
		'core/heading'       => array( 'eyebrow' => __( 'Eyebrow', 'fieldnotes' ) ),
		'core/quote'         => array( 'margin-note' => __( 'Margin note', 'fieldnotes' ) ),
		'core/button'        => array( 'arrow' => __( 'Text with arrow', 'fieldnotes' ) ),
		'core/details'       => array( 'ledger' => __( 'Ledger', 'fieldnotes' ) ),
		'core/categories'    => array( 'chips' => __( 'Chips', 'fieldnotes' ) ),
		'core/terms-query'   => array( 'chips' => __( 'Chips', 'fieldnotes' ) ),
		'core/post-template' => array( 'numbered' => __( 'Numbered', 'fieldnotes' ) ),
	);
}

add_action(
	'init',
	static function () {
		foreach ( fieldnotes_block_styles() as $block => $styles ) {
			foreach ( $styles as $name => $label ) {
				register_block_style(
					$block,
					array(
						'name'  => $name,
						'label' => $label,
					)
				);
			}
			$slug = substr( $block, strlen( 'core/' ) );
			$file = get_theme_file_path( "assets/css/blocks/{$slug}.css" );
			if ( is_readable( $file ) ) {
				wp_enqueue_block_style(
					$block,
					array(
						'handle' => "fieldnotes-{$slug}",
						'src'    => get_theme_file_uri( "assets/css/blocks/{$slug}.css" ),
						'path'   => $file,
						'ver'    => (string) filemtime( $file ),
					)
				);
			}
		}

		register_block_pattern_category(
			'fieldnotes',
			array(
				'label'       => __( 'Fieldnotes', 'fieldnotes' ),
				'description' => __( 'Sections made for the field journal.', 'fieldnotes' ),
			)
		);
		register_block_pattern_category(
			'fieldnotes-pages',
			array(
				'label'       => __( 'Fieldnotes pages', 'fieldnotes' ),
				'description' => __( 'Whole pages to start from.', 'fieldnotes' ),
			)
		);
	}
);

/**
 * Twenty Twenty-Five's own patterns are left out of the inserter: this site
 * offers its own. They are named from the parent's pattern headers, so no
 * pattern's content is loaded just to remove it (several of ours look up
 * pictures and terms, and should do so only when they are used).
 */
add_action(
	'init',
	static function () {
		$parent = wp_get_theme()->parent();
		if ( ! $parent ) {
			return;
		}
		$registry = WP_Block_Patterns_Registry::get_instance();
		foreach ( $parent->get_block_patterns() as $pattern ) {
			if ( ! empty( $pattern['slug'] ) && str_starts_with( $pattern['slug'], 'twentytwentyfive/' ) && $registry->is_registered( $pattern['slug'] ) ) {
				$registry->unregister( $pattern['slug'] );
			}
		}
	},
	20
);

/**
 * The header's Navigation block (named "Main menu" in the header part) shows
 * the menu whose slug is main-menu. A theme file cannot know a menu's id, and
 * WordPress's own fallback picks whichever menu is newest.
 */
add_filter(
	'render_block_data',
	static function ( array $block ): array {
		if ( 'core/navigation' !== ( $block['blockName'] ?? '' ) || ! empty( $block['attrs']['ref'] ) || ! empty( $block['innerBlocks'] ) ) {
			return $block;
		}
		if ( 'Main menu' !== ( $block['attrs']['metadata']['name'] ?? '' ) ) {
			return $block;
		}
		$menu = get_page_by_path( 'main-menu', OBJECT, 'wp_navigation' );
		if ( $menu && 'publish' === $menu->post_status ) {
			$block['attrs']['ref'] = $menu->ID;
		}
		return $block;
	}
);

/**
 * A picture from the media library by its stable name (the file name it was
 * drawn as, without .jpg), for patterns: [id, url, alt]. The seed marks each
 * picture it imports with the _fieldnotes_picture meta key.
 */
function fieldnotes_picture( string $name, string $size = 'full' ): array {
	$ids = get_posts(
		array(
			'post_type'      => 'attachment',
			'post_status'    => 'inherit',
			'posts_per_page' => 1,
			'meta_key'       => '_fieldnotes_picture',
			'meta_value'     => $name,
			'fields'         => 'ids',
		)
	);
	if ( ! $ids ) {
		return array( 0, '', '' );
	}
	$id = (int) $ids[0];
	return array( $id, (string) wp_get_attachment_image_url( $id, $size ), (string) get_post_meta( $id, '_wp_attachment_image_alt', true ) );
}

/**
 * The address of a post by its slug, for patterns that point at one: '' when
 * there is no such post yet.
 */
function fieldnotes_link( string $slug, string $type = 'post' ): string {
	$post = get_page_by_path( $slug, OBJECT, $type );
	return $post ? (string) get_permalink( $post ) : '';
}
