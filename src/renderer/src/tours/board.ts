// The tours of the board and the list (places board, list): one per place, each a few stops through what the view
// does and what you can do there (types.ts says how a step is written). The card drawer is not a place of its own:
// the board's tour points at a card and says what opening it shows.
import type { Tour } from './types';
import { keys } from './types';

export const BOARD_TOURS: Tour[] = [
  {
    id: 'board',
    name: 'Board',
    intro: 'Where the project’s work is: a card for each piece, moving from filed to done.',
    steps: [
      {
        target: 'board-lanes', side: 'top', title: 'The lanes',
        body: 'A card moves left to right: filed into the Inbox, accepted to Ready, held by a session in Working, submitted with evidence to Review, and Done when you approve it. Only you approve.',
      },
      {
        target: 'board-card', side: 'right', title: 'A card',
        body: 'Click a card, or press Enter on it, to open it beside the board: its criteria, the conversation, the AI review, its branch and what its agent saw. J and K move between cards, H and L between lanes.',
      },
      {
        target: 'board-card', side: 'right', title: 'Move a card',
        body: (c) => `Drag it to another lane, or hold ${keys(c, 'Mod')} and press an arrow. The board’s rules hold either way: Working starts a session on it, Review needs evidence, and Done approves it.`,
      },
      {
        target: 'board-filters', side: 'bottom', title: 'Narrow the board',
        body: 'Type words, pick card types, or a priority and an agent. The List keeps the same filters.',
      },
      {
        target: 'board-views', side: 'bottom', title: 'Saved views',
        body: 'Save the filters and order you use under a name; 1 to 9 apply them from the board.',
      },
      {
        target: 'board-new', side: 'bottom', title: 'New card',
        body: 'C files a card from anywhere. Yours go straight to Ready, or to the Inbox if you choose, and Draft with Claude can write one up from a rough note.',
      },
      {
        target: 'board-how', side: 'bottom', title: 'How this works',
        body: 'The board’s rules as a picture, with live numbers from this board, whenever you want them.',
      },
    ],
  },
  {
    id: 'list',
    name: 'List',
    intro: 'Every card on the board in one table, archived ones too.',
    steps: [
      {
        target: 'list-table', side: 'top', title: 'Every card',
        body: 'The board’s cards in one dense table, archived ones too, with the board’s filters and saved views above it.',
      },
      {
        target: 'list-head', side: 'bottom', title: 'Sort',
        body: 'Click a column’s head to sort by it, and again to turn it round. The List remembers how you left it.',
      },
      {
        target: 'list-row', side: 'bottom', title: 'Walk the rows',
        body: 'J and K, or the arrows, move between rows; Home and End go to the first and the last. On a card in the Inbox, A accepts it and X archives it.',
      },
      {
        target: 'list-row', side: 'bottom', title: 'Open a card',
        body: 'Enter, or a click, opens the card beside the List. Esc closes it and puts you back on its row.',
      },
      {
        target: 'board-modes', side: 'bottom', title: 'Board or List',
        body: 'Back to the lanes here, or G then B; G then L comes back to the List.',
      },
    ],
  },
];
