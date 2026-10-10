// A tour is offered once, replayed whenever asked, never points at nothing,
// and its card is always inside the window beside what it describes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { markDismissed, markSeen, mayOffer, nextShown, placeCard, readTourState, writeTourState, NO_TOURS_SEEN } from './tour-model.ts';

test('what was stored is read defensively: garbage, wrong types and huge lists are "nothing seen", never a throw', () => {
  assert.deepEqual(readTourState(null), NO_TOURS_SEEN);
  assert.deepEqual(readTourState('not json'), NO_TOURS_SEEN);
  assert.deepEqual(readTourState('[1,2]'), { off: false, seen: [], dismissed: [] });
  assert.deepEqual(readTourState('{"off":"yes","seen":[1,"board","board",""],"dismissed":"live"}'), { off: false, seen: ['board'], dismissed: [] });
  const many = JSON.stringify({ seen: Array.from({ length: 500 }, (_, i) => `t${i}`) });
  assert.equal(readTourState(many).seen.length, 200);
  const s = markDismissed(markSeen({ ...NO_TOURS_SEEN, off: true }, 'welcome'), 'live');
  assert.deepEqual(readTourState(writeTourState(s)), { off: true, seen: ['welcome'], dismissed: ['live'] });
});

test('a tour offers itself once: not after it was seen, not after Not now, never while tours are off', () => {
  assert.equal(mayOffer(NO_TOURS_SEEN, 'board'), true);
  assert.equal(mayOffer(markSeen(NO_TOURS_SEEN, 'board'), 'board'), false);
  assert.equal(mayOffer(markDismissed(NO_TOURS_SEEN, 'board'), 'board'), false);
  assert.equal(mayOffer({ ...NO_TOURS_SEEN, off: true }, 'board'), false);
  assert.equal(mayOffer(markSeen(NO_TOURS_SEEN, 'live'), 'board'), true);
  const once = markSeen(NO_TOURS_SEEN, 'board');
  assert.equal(markSeen(once, 'board'), once, 'marking twice changes nothing');
});

test('a step whose target is not on the screen is passed over, both ways; off the end is -1', () => {
  const on = [true, false, false, true, true];
  const shown = (i: number): boolean => on[i] ?? false;
  assert.equal(nextShown(5, -1, 1, shown), 0, 'the first shown step starts it');
  assert.equal(nextShown(5, 0, 1, shown), 3);
  assert.equal(nextShown(5, 3, -1, shown), 0);
  assert.equal(nextShown(5, 4, 1, shown), -1, 'forward past the last ends the tour');
  assert.equal(nextShown(5, 0, -1, shown), -1, 'back before the first has nowhere to go');
  assert.equal(nextShown(3, -1, 1, () => false), -1, 'a tour with nothing on the screen never starts');
});

test('the card goes on the side asked for, flips when it would not fit, and is always inside the window', () => {
  const view = { width: 1280, height: 800 };
  const card = { width: 320, height: 160 };
  // A rail item on the left edge: asked for the right, it goes right.
  const rail = { left: 10, top: 300, width: 40, height: 40 };
  const r = placeCard(rail, card, view, 'right');
  assert.equal(r.side, 'right');
  assert.equal(r.left, 10 + 40 + 12);
  // Asked for the left of the rail item, there is no room: it flips to the right.
  assert.equal(placeCard(rail, card, view, 'left').side, 'right');
  // A status-line control at the bottom: asked for below, it flips above.
  const status = { left: 1200, top: 770, width: 24, height: 24 };
  const s = placeCard(status, card, view, 'bottom');
  assert.equal(s.side, 'top');
  assert.ok(s.left + card.width <= view.width - 12, 'clamped inside the right edge');
  // A target as big as the window: the side with the most room, still inside.
  const big = placeCard({ left: 0, top: 0, width: 1280, height: 800 }, card, view, 'bottom');
  assert.ok(big.left >= 12 && big.top >= 12 && big.left + card.width <= view.width - 12 + 0.001 && big.top + card.height <= view.height - 12 + 0.001);
  // No target: centred.
  assert.deepEqual(placeCard(null, card, view), { left: 480, top: 320, side: 'center' });
});
