/**
 * fieldnotes/trail-finder in the browser: the buttons set the choice, and
 * every card, count and distance follows from it. render.php gives the same
 * state to the server, so the first paint already matches.
 */
import { store, getContext } from '@wordpress/interactivity';

const matches = ( trail, choice ) =>
	( choice.difficulty === 'all' || trail.difficulty === choice.difficulty ) &&
	( choice.season === 'all' ||
		trail.seasons.includes( 'all' ) ||
		trail.seasons.includes( choice.season ) );

const { state } = store( 'fieldnotes/trail-finder', {
	state: {
		get isChosen() {
			const { group, value } = getContext();
			return state[ group ] === value;
		},
		get isHidden() {
			return ! matches( getContext(), state );
		},
		get shownCount() {
			return state.trails.filter( ( trail ) => matches( trail, state ) ).length;
		},
		get isEmpty() {
			return state.shownCount === 0;
		},
		get distance() {
			const { km } = getContext();
			const value = state.unit === 'mi' ? km * 0.621371 : km;
			return `${ value.toFixed( 1 ) } ${ state.unit }`;
		},
	},
	actions: {
		choose() {
			const { group, value } = getContext();
			state[ group ] = value;
		},
	},
} );
