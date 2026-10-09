/**
 * fieldnotes/trail-conditions in the browser: one button opens and closes
 * the earlier reports. The open state lives in the block's own context, so
 * two of these on one page do not share it.
 */
import { store, getContext } from '@wordpress/interactivity';

store( 'fieldnotes/trail-conditions', {
	state: {
		get label() {
			const context = getContext();
			return context.open ? context.less : context.more;
		},
	},
	actions: {
		toggle() {
			const context = getContext();
			context.open = ! context.open;
		},
	},
} );
