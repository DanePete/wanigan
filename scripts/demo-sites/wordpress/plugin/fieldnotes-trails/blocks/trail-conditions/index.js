/**
 * The editor's view of fieldnotes/trail-conditions: the server's own rendering, so what
 * the editor shows is what the page shows. A plain script, no build step.
 */
( function ( blocks, element, blockEditor, ServerSideRender ) {
	blocks.registerBlockType( 'fieldnotes/trail-conditions', {
		edit: function Edit( props ) {
			return element.createElement(
				'div',
				blockEditor.useBlockProps(),
				element.createElement( ServerSideRender, {
					block: 'fieldnotes/trail-conditions',
					attributes: props.attributes,
					urlQueryArgs: props.context && props.context.postId ? { post_id: props.context.postId } : {},
				} )
			);
		},
	} );
} )( window.wp.blocks, window.wp.element, window.wp.blockEditor, window.wp.serverSideRender );
