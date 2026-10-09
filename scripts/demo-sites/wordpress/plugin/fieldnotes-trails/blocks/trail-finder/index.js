/**
 * The editor's view of fieldnotes/trail-finder: the server's own rendering, so what
 * the editor shows is what the page shows. A plain script, no build step.
 */
( function ( blocks, element, blockEditor, ServerSideRender ) {
	blocks.registerBlockType( 'fieldnotes/trail-finder', {
		edit: function Edit( props ) {
			return element.createElement(
				'div',
				blockEditor.useBlockProps(),
				element.createElement( ServerSideRender, {
					block: 'fieldnotes/trail-finder',
					attributes: props.attributes,
					urlQueryArgs: props.context && props.context.postId ? { post_id: props.context.postId } : {},
				} )
			);
		},
	} );
} )( window.wp.blocks, window.wp.element, window.wp.blockEditor, window.wp.serverSideRender );
