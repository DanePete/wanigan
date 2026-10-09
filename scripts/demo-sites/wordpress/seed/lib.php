<?php
/**
 * The seed's tools: block markup written the way the block editor saves it,
 * and "find it by its key, then create or update it" for everything the
 * seed makes, so a rerun keeps ids and duplicates nothing.
 *
 * Every post the seed makes carries _fieldnotes_key ("post:first-hard-frost"),
 * every picture _fieldnotes_picture ("birch-hollow"), every comment
 * _fieldnotes_key ("comment:frost-1").
 */

defined( 'ABSPATH' ) || exit;

require_once ABSPATH . 'wp-admin/includes/image.php';
require_once ABSPATH . 'wp-admin/includes/file.php';
require_once ABSPATH . 'wp-admin/includes/media.php';

const FN_PICTURES = '/var/www/html/.demo-images';

/* ── Block markup ──────────────────────────────────────────────────────
 * Each helper returns one block as the editor would save it: its comment
 * delimiters with attributes, and the HTML its save() writes.
 */

function fn_attrs( array $attrs ): string {
	$attrs = array_filter( $attrs, static fn ( $v ) => null !== $v && '' !== $v && array() !== $v );
	return $attrs ? ' ' . wp_json_encode( $attrs, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE ) : '';
}

function fn_block( string $name, array $attrs, string $html ): string {
	return "<!-- wp:{$name}" . fn_attrs( $attrs ) . " -->\n{$html}\n<!-- /wp:{$name} -->\n\n";
}

function fn_class( string ...$classes ): string {
	return trim( implode( ' ', array_filter( $classes ) ) );
}

/** A paragraph. $o: className, dropCap, fontSize, textColor. */
function p( string $html, array $o = array() ): string {
	$class = fn_class(
		! empty( $o['dropCap'] ) ? 'has-drop-cap' : '',
		$o['className'] ?? '',
		! empty( $o['textColor'] ) ? "has-{$o['textColor']}-color has-text-color" : '',
		! empty( $o['fontSize'] ) ? "has-{$o['fontSize']}-font-size" : ''
	);
	$attrs = array(
		'dropCap'   => ! empty( $o['dropCap'] ) ? true : null,
		'className' => $o['className'] ?? null,
		'textColor' => $o['textColor'] ?? null,
		'fontSize'  => $o['fontSize'] ?? null,
	);
	return fn_block( 'paragraph', $attrs, '<p' . ( $class ? " class=\"{$class}\"" : '' ) . ">{$html}</p>" );
}

/** A heading. $o: className, fontSize, anchor. */
function h( int $level, string $html, array $o = array() ): string {
	$class = fn_class( 'wp-block-heading', $o['className'] ?? '', ! empty( $o['fontSize'] ) ? "has-{$o['fontSize']}-font-size" : '' );
	$attrs = array(
		'level'     => 2 === $level ? null : $level,
		'className' => $o['className'] ?? null,
		'fontSize'  => $o['fontSize'] ?? null,
		'anchor'    => $o['anchor'] ?? null,
	);
	$id    = ! empty( $o['anchor'] ) ? " id=\"{$o['anchor']}\"" : '';
	return fn_block( 'heading', $attrs, "<h{$level} class=\"{$class}\"{$id}>{$html}</h{$level}>" );
}

/** An image from the media library by its picture name. $o: align, size, className, caption. */
function img( string $picture, string $caption = '', array $o = array() ): string {
	$id    = fn_picture_id( $picture );
	$size  = $o['size'] ?? 'large';
	$url   = (string) wp_get_attachment_image_url( $id, $size );
	$alt   = esc_attr( (string) get_post_meta( $id, '_wp_attachment_image_alt', true ) );
	$align = $o['align'] ?? '';
	$class = fn_class( 'wp-block-image', $align ? "align{$align}" : '', "size-{$size}", $o['className'] ?? '' );
	$attrs = array(
		'id'              => $id,
		'sizeSlug'        => $size,
		'linkDestination' => 'none',
		'align'           => $align ?: null,
		'className'       => $o['className'] ?? null,
	);
	$cap   = '' !== $caption ? "<figcaption class=\"wp-element-caption\">{$caption}</figcaption>" : '';
	return fn_block( 'image', $attrs, "<figure class=\"{$class}\"><img src=\"" . esc_url( $url ) . "\" alt=\"{$alt}\" class=\"wp-image-{$id}\"/>{$cap}</figure>" );
}

/** A gallery of pictures: [[name, caption], ...]. $o: columns, align, caption. */
function gallery( array $pictures, array $o = array() ): string {
	$inner = '';
	foreach ( $pictures as [ $picture, $caption ] ) {
		$inner .= trim( img( $picture, $caption ) );
	}
	$columns = $o['columns'] ?? null;
	$align   = $o['align'] ?? '';
	$class   = fn_class( 'wp-block-gallery', $align ? "align{$align}" : '', 'has-nested-images', $columns ? "columns-{$columns}" : 'columns-default', 'is-cropped' );
	$attrs   = array(
		'columns' => $columns,
		'linkTo'  => 'none',
		'align'   => $align ?: null,
	);
	$cap     = ! empty( $o['caption'] ) ? "<figcaption class=\"blocks-gallery-caption wp-element-caption\">{$o['caption']}</figcaption>" : '';
	return fn_block( 'gallery', $attrs, "<figure class=\"{$class}\">{$inner}{$cap}</figure>" );
}

/** A quote of one or more paragraphs. */
function quote( string|array $paragraphs, string $cite = '', string $style = '' ): string {
	$inner = '';
	foreach ( (array) $paragraphs as $para ) {
		$inner .= trim( p( $para ) );
	}
	$class = fn_class( 'wp-block-quote', $style ? "is-style-{$style}" : '' );
	$attrs = array( 'className' => $style ? "is-style-{$style}" : null );
	return fn_block( 'quote', $attrs, "<blockquote class=\"{$class}\">{$inner}" . ( $cite ? "<cite>{$cite}</cite>" : '' ) . '</blockquote>' );
}

function pullquote( string $text, string $cite = '' ): string {
	return fn_block( 'pullquote', array(), "<figure class=\"wp-block-pullquote\"><blockquote><p>{$text}</p>" . ( $cite ? "<cite>{$cite}</cite>" : '' ) . '</blockquote></figure>' );
}

/** A list. Items are HTML strings, or [html, [sub items]] for a nested list. $o: ordered, className. */
function items( array $list, array $o = array() ): string {
	$inner = '';
	foreach ( $list as $item ) {
		if ( is_array( $item ) ) {
			[ $html, $sub ] = $item;
			$inner         .= fn_block( 'list-item', array(), "<li>{$html}" . trim( items( $sub ) ) . '</li>' );
		} else {
			$inner .= fn_block( 'list-item', array(), "<li>{$item}</li>" );
		}
	}
	$tag   = ! empty( $o['ordered'] ) ? 'ol' : 'ul';
	$class = fn_class( 'wp-block-list', $o['className'] ?? '' );
	$attrs = array(
		'ordered'   => ! empty( $o['ordered'] ) ? true : null,
		'className' => $o['className'] ?? null,
	);
	return fn_block( 'list', $attrs, "<{$tag} class=\"{$class}\">" . trim( str_replace( "\n\n", "\n", $inner ) ) . "</{$tag}>" );
}

/** A table: header cells, rows of cells, an optional footer row and caption. Logbook style by default. */
function table( array $head, array $rows, string $caption = '', ?array $foot = null, string $style = 'logbook' ): string {
	$cells = static fn ( array $row, string $tag ) => '<tr>' . implode( '', array_map( static fn ( $c ) => "<{$tag}>{$c}</{$tag}>", $row ) ) . '</tr>';
	$html  = '<thead>' . $cells( $head, 'th' ) . '</thead><tbody>' . implode( '', array_map( static fn ( $r ) => $cells( $r, 'td' ), $rows ) ) . '</tbody>';
	if ( $foot ) {
		$html .= '<tfoot>' . $cells( $foot, 'td' ) . '</tfoot>';
	}
	$class = fn_class( 'wp-block-table', $style ? "is-style-{$style}" : '' );
	$attrs = array(
		'hasFixedLayout' => false,
		'className'      => $style ? "is-style-{$style}" : null,
	);
	$cap   = $caption ? "<figcaption class=\"wp-element-caption\">{$caption}</figcaption>" : '';
	return fn_block( 'table', $attrs, "<figure class=\"{$class}\"><table>{$html}</table>{$cap}</figure>" );
}

function sep( string $style = '' ): string {
	$class = fn_class( 'wp-block-separator', 'has-alpha-channel-opacity', $style ? "is-style-{$style}" : '' );
	return fn_block( 'separator', array( 'className' => $style ? "is-style-{$style}" : null ), "<hr class=\"{$class}\"/>" );
}

function details( string $summary, string $inner, string $style = 'ledger' ): string {
	$class = fn_class( 'wp-block-details', $style ? "is-style-{$style}" : '' );
	return fn_block( 'details', array( 'className' => $style ? "is-style-{$style}" : null ), "<details class=\"{$class}\"><summary>{$summary}</summary>" . trim( $inner ) . '</details>' );
}

/** Columns: [[width or '', inner markup], ...]. $o: align, verticalAlignment, className. */
function columns( array $cols, array $o = array() ): string {
	$inner = '';
	foreach ( $cols as [ $width, $content ] ) {
		$inner .= fn_block(
			'column',
			array( 'width' => $width ?: null ),
			'<div class="wp-block-column"' . ( $width ? " style=\"flex-basis:{$width}\"" : '' ) . '>' . trim( $content ) . '</div>'
		);
	}
	$align = $o['align'] ?? '';
	$va    = $o['verticalAlignment'] ?? '';
	$class = fn_class( 'wp-block-columns', $align ? "align{$align}" : '', $va ? "are-vertically-aligned-{$va}" : '', $o['className'] ?? '' );
	$attrs = array(
		'verticalAlignment' => $va ?: null,
		'align'             => $align ?: null,
		'className'         => $o['className'] ?? null,
	);
	return fn_block( 'columns', $attrs, "<div class=\"{$class}\">" . trim( $inner ) . '</div>' );
}

/** A group. $o: className, align, layout (default constrained), backgroundColor, textColor, name, tagName. */
function group( string $inner, array $o = array() ): string {
	$tag   = $o['tagName'] ?? 'div';
	$align = $o['align'] ?? '';
	$bg    = $o['backgroundColor'] ?? '';
	$text  = $o['textColor'] ?? '';
	$class = fn_class(
		'wp-block-group',
		$align ? "align{$align}" : '',
		$o['className'] ?? '',
		$text ? "has-{$text}-color" : '',
		$bg ? "has-{$bg}-background-color" : '',
		$text ? 'has-text-color' : '',
		$bg ? 'has-background' : ''
	);
	$attrs = array(
		'metadata'        => ! empty( $o['name'] ) ? array( 'name' => $o['name'] ) : null,
		'tagName'         => 'div' === $tag ? null : $tag,
		'align'           => $align ?: null,
		'className'       => $o['className'] ?? null,
		'backgroundColor' => $bg ?: null,
		'textColor'       => $text ?: null,
		'layout'          => $o['layout'] ?? array( 'type' => 'constrained' ),
	);
	return fn_block( 'group', $attrs, "<{$tag} class=\"{$class}\">" . trim( $inner ) . "</{$tag}>" );
}

/** Buttons: [[text, url, style], ...]; style '' (filled), 'outline' or 'arrow'. */
function buttons( array $list, array $o = array() ): string {
	$inner = '';
	foreach ( $list as $b ) {
		[ $text, $url ] = $b;
		$style          = $b[2] ?? '';
		$class          = fn_class( 'wp-block-button', $style ? "is-style-{$style}" : '' );
		$inner         .= fn_block( 'button', array( 'className' => $style ? "is-style-{$style}" : null ), "<div class=\"{$class}\"><a class=\"wp-block-button__link wp-element-button\" href=\"" . esc_url( $url ) . "\">{$text}</a></div>" );
	}
	return fn_block( 'buttons', array( 'layout' => $o['layout'] ?? null ), '<div class="wp-block-buttons">' . trim( $inner ) . '</div>' );
}

/** A synced pattern (reusable block) by its seed key. */
function synced( string $key ): string {
	return '<!-- wp:block {"ref":' . fn_post_id( "block:{$key}" ) . "} /-->\n\n";
}

/** A registered pattern, to be expanded into its blocks by fn_expand(). */
function pattern( string $slug ): string {
	return '<!-- wp:pattern {"slug":"' . $slug . "\"} /-->\n\n";
}

/** A plugin or core block with no saved HTML (dynamic). */
function dynamic( string $name, array $attrs = array() ): string {
	return "<!-- wp:{$name}" . fn_attrs( $attrs ) . " /-->\n\n";
}

/**
 * Patterns expanded into their blocks, as the editor does when someone
 * inserts one: the top block keeps the pattern's name in its metadata.
 */
function fn_expand( string $markup ): string {
	return serialize_blocks( resolve_pattern_blocks( parse_blocks( $markup ) ) );
}

/* ── Find or make ─────────────────────────────────────────────────────── */

function fn_find( string $key ): int {
	$ids = get_posts(
		array(
			'post_type'        => 'any',
			'post_status'      => 'any',
			'posts_per_page'   => 1,
			'fields'           => 'ids',
			'meta_key'         => '_fieldnotes_key',
			'meta_value'       => $key,
			'suppress_filters' => true,
		)
	);
	if ( ! $ids ) {
		// wp_block, wp_navigation and attachments are not in 'any'.
		$ids = get_posts(
			array(
				'post_type'        => array( 'wp_block', 'wp_navigation' ),
				'post_status'      => 'any',
				'posts_per_page'   => 1,
				'fields'           => 'ids',
				'meta_key'         => '_fieldnotes_key',
				'meta_value'       => $key,
				'suppress_filters' => true,
			)
		);
	}
	return $ids ? (int) $ids[0] : 0;
}

function fn_post_id( string $key ): int {
	$id = fn_find( $key );
	if ( ! $id ) {
		WP_CLI::error( "The seed asked for {$key} before making it." );
	}
	return $id;
}

/**
 * Creates or updates a post found by its key. Only what differs is written,
 * so a rerun leaves modified dates and revisions alone.
 * $data: wp_insert_post fields, plus meta => [...], terms => [taxonomy => [slugs]], picture => name.
 */
function fn_post( string $key, array $data ): int {
	$meta    = $data['meta'] ?? array();
	$terms   = $data['terms'] ?? array();
	$picture = $data['picture'] ?? null;
	unset( $data['meta'], $data['terms'], $data['picture'] );
	$data += array(
		'post_status'    => 'publish',
		'comment_status' => 'closed',
		'ping_status'    => 'closed',
	);
	if ( isset( $data['post_date'] ) ) {
		$data['post_date_gmt'] = get_gmt_from_date( $data['post_date'] );
	}

	$id = fn_find( $key );
	if ( $id ) {
		$current = get_post( $id, ARRAY_A );
		$changed = array();
		foreach ( $data as $field => $value ) {
			if ( (string) ( $current[ $field ] ?? '' ) !== (string) $value ) {
				$changed[ $field ] = $value;
			}
		}
		if ( $changed ) {
			$changed['ID'] = $id;
			wp_update_post( wp_slash( $changed ), true );
		}
	} else {
		$id = wp_insert_post( wp_slash( $data ), true );
		if ( is_wp_error( $id ) ) {
			WP_CLI::error( "{$key}: " . $id->get_error_message() );
		}
		update_post_meta( $id, '_fieldnotes_key', $key );
	}

	foreach ( $meta as $meta_key => $value ) {
		if ( get_post_meta( $id, $meta_key, true ) !== $value ) {
			update_post_meta( $id, $meta_key, $value );
		}
	}
	foreach ( $terms as $taxonomy => $slugs ) {
		$ids = array_map( static fn ( $slug ) => (int) get_term_by( 'slug', $slug, $taxonomy )->term_id, $slugs );
		wp_set_object_terms( $id, $ids, $taxonomy );
	}
	if ( $picture ) {
		set_post_thumbnail( $id, fn_picture_id( $picture ) );
	}
	return (int) $id;
}

function fn_term( string $taxonomy, string $slug, string $name, string $description = '', string $parent = '' ): int {
	$parent_id = $parent ? (int) get_term_by( 'slug', $parent, $taxonomy )->term_id : 0;
	$term      = get_term_by( 'slug', $slug, $taxonomy );
	$args      = array(
		'name'        => $name,
		'slug'        => $slug,
		'description' => $description,
		'parent'      => $parent_id,
	);
	if ( $term ) {
		if ( $term->name !== $name || $term->description !== $description || (int) $term->parent !== $parent_id ) {
			wp_update_term( $term->term_id, $taxonomy, $args );
		}
		return (int) $term->term_id;
	}
	$made = wp_insert_term( $name, $taxonomy, $args );
	if ( is_wp_error( $made ) ) {
		WP_CLI::error( "{$taxonomy} {$slug}: " . $made->get_error_message() );
	}
	return (int) $made['term_id'];
}

function fn_user( string $login, string $name, string $email, string $bio, string $role = 'author' ): int {
	$user  = get_user_by( 'login', $login );
	$parts = explode( ' ', $name, 2 );
	$data  = array(
		'user_login'   => $login,
		'user_email'   => $email,
		'display_name' => $name,
		'nickname'     => $name,
		'first_name'   => $parts[0],
		'last_name'    => $parts[1] ?? '',
		'description'  => $bio,
		'role'         => $role,
	);
	if ( $user ) {
		$data['ID'] = $user->ID;
		wp_update_user( $data );
		return (int) $user->ID;
	}
	$data['user_pass'] = wp_generate_password( 24 );
	$id                = wp_insert_user( $data );
	if ( is_wp_error( $id ) ) {
		WP_CLI::error( "user {$login}: " . $id->get_error_message() );
	}
	return (int) $id;
}

/** The attachment id of a picture, importing it from .demo-images the first time. */
function fn_picture_id( string $name ): int {
	static $cache = array();
	if ( isset( $cache[ $name ] ) ) {
		return $cache[ $name ];
	}
	$ids = get_posts(
		array(
			'post_type'      => 'attachment',
			'post_status'    => 'inherit',
			'posts_per_page' => 1,
			'fields'         => 'ids',
			'meta_key'       => '_fieldnotes_picture',
			'meta_value'     => $name,
		)
	);
	if ( $ids ) {
		return $cache[ $name ] = (int) $ids[0];
	}
	$source = FN_PICTURES . "/{$name}.jpg";
	if ( ! is_readable( $source ) ) {
		WP_CLI::error( "No picture {$name}.jpg in .demo-images: draw_images should have made it." );
	}
	$tmp = wp_tempnam( "{$name}.jpg" );
	copy( $source, $tmp );
	$id = media_handle_sideload(
		array(
			'name'     => "{$name}.jpg",
			'tmp_name' => $tmp,
		),
		0
	);
	if ( is_wp_error( $id ) ) {
		WP_CLI::error( "picture {$name}: " . $id->get_error_message() );
	}
	update_post_meta( $id, '_fieldnotes_picture', $name );
	return $cache[ $name ] = (int) $id;
}

/** A picture's words: title, alt text and caption, kept up to date on every run. */
function fn_picture( string $name, string $title, string $alt, string $caption = '' ): int {
	$id = fn_picture_id( $name );
	$post = get_post( $id );
	if ( $post->post_title !== $title || $post->post_excerpt !== $caption ) {
		wp_update_post(
			array(
				'ID'           => $id,
				'post_title'   => $title,
				'post_excerpt' => $caption,
			)
		);
	}
	if ( get_post_meta( $id, '_wp_attachment_image_alt', true ) !== $alt ) {
		update_post_meta( $id, '_wp_attachment_image_alt', $alt );
	}
	return $id;
}

function fn_comment( string $key, int $post_id, array $data ): int {
	$found = get_comments(
		array(
			'meta_key'   => '_fieldnotes_key',
			'meta_value' => $key,
			'number'     => 1,
			'fields'     => 'ids',
			'status'     => 'all',
		)
	);
	$data += array(
		'comment_post_ID'  => $post_id,
		'comment_approved' => 1,
		'comment_type'     => 'comment',
	);
	if ( isset( $data['comment_date'] ) ) {
		$data['comment_date_gmt'] = get_gmt_from_date( $data['comment_date'] );
	}
	if ( $found ) {
		$id      = (int) $found[0];
		$current = get_comment( $id, ARRAY_A );
		$changed = array_filter( $data, static fn ( $v, $k ) => (string) ( $current[ $k ] ?? '' ) !== (string) $v, ARRAY_FILTER_USE_BOTH );
		if ( $changed ) {
			wp_update_comment( array( 'comment_ID' => $id ) + $changed );
		}
		return $id;
	}
	$id = wp_insert_comment( $data );
	update_comment_meta( $id, '_fieldnotes_key', $key );
	return (int) $id;
}

/**
 * The address a seeded post will have, from its type and slug: posts at
 * /slug/, trails at /trails/slug/, pages at their path. Known before the post
 * exists, so entries can link to each other in any order.
 */
function fn_link( string $type, string $slug ): string {
	return match ( $type ) {
		'trail' => home_url( "/trails/{$slug}/" ),
		default => home_url( "/{$slug}/" ),
	};
}
