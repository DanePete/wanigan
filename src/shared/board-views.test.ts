import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_BOARD_VIEW, readBoardView, sameView, shownView, viewNameKey, type BoardView, type SavedBoardView } from './board-views.ts';

const view = (over: Partial<BoardView> = {}): BoardView => ({ ...DEFAULT_BOARD_VIEW, ...over });
const saved = (id: string, v: BoardView): SavedBoardView => ({ id, projectId: 'p', name: id, view: v, createdAt: 1, updatedAt: 1 });

test('two views are the same when they show the same cards in the same order', () => {
  assert.ok(sameView(view({ filter: '  Checkout ' }), view({ filter: 'checkout' })), 'the filter matches in any case, around its spaces');
  assert.ok(sameView(view({ types: ['idea', 'bug'] }), view({ types: ['bug', 'idea'] })), 'types are a set');
  assert.ok(!sameView(view({ types: ['bug'] }), view({ types: ['bug', 'idea'] })));
  assert.ok(!sameView(view({ types: ['bug', 'bug'] }), view({ types: ['bug', 'idea'] })), 'a repeated type is not another type');
  assert.ok(!sameView(view({ sort: 'priority' }), view()));
  assert.ok(!sameView(view({ priority: 0 }), view()));
  assert.ok(!sameView(view({ agent: 'none' }), view()));
  assert.ok(!sameView(view({ filter: 'cart' }), view({ filter: 'carts' })));
});

test('the board names the saved view it shows, and says when it has changed since it was applied', () => {
  const bugs = saved('bugs', view({ types: ['bug'] }));
  const urgent = saved('urgent', view({ priority: 0 }));
  const alsoBugs = saved('also-bugs', view({ types: ['bug'] }));
  const views = [bugs, urgent, alsoBugs];
  assert.deepEqual(shownView(views, view({ types: ['bug'] }), 'also-bugs'), { view: alsoBugs, changed: false }, 'the one applied, while the board matches it');
  assert.deepEqual(shownView(views, view({ priority: 0 }), 'bugs'), { view: urgent, changed: false }, 'changed into another saved view is that view');
  assert.deepEqual(shownView(views, view({ types: ['bug'], sort: 'newest' }), 'bugs'), { view: bugs, changed: true });
  assert.deepEqual(shownView(views, view({ types: ['bug'] }), null), { view: bugs, changed: false }, 'a board that matches a view shows it, applied or not');
  assert.equal(shownView(views, view({ agent: 'codex' }), null), null);
  assert.equal(shownView(views, view({ agent: 'codex' }), 'deleted-since'), null, 'a view deleted since it was applied is not shown');
  assert.equal(shownView([], view(), 'bugs'), null);
});

test('a view read back from storage keeps only what this build knows', () => {
  assert.deepEqual(readBoardView({ filter: 'cart', types: ['epic', 'idea', 'bug', 7], sort: 'swimlanes', priority: 9, agent: 'grok', columns: ['done'] }),
    { filter: 'cart', types: ['bug', 'idea'], sort: 'manual', priority: 'any', agent: 'any' });
  assert.deepEqual(readBoardView({ filter: 'x', types: ['task'], sort: 'jev', priority: 0, agent: 'gemini' }),
    { filter: 'x', types: ['task'], sort: 'jev', priority: 0, agent: 'gemini' });
  for (const junk of [null, undefined, 'board', 42, [], { types: 'bug', priority: '1', filter: 3 }]) assert.deepEqual(readBoardView(junk), DEFAULT_BOARD_VIEW, JSON.stringify(junk));
  assert.equal(readBoardView({ filter: 'y'.repeat(500) }).filter.length, 200);
});

test('a view’s name compares in any case and however its letters are composed', () => {
  assert.equal(viewNameKey('  Été Release '), viewNameKey('ÉTÉ release'));
  assert.equal(viewNameKey('Été'), viewNameKey('Été'));
  assert.notEqual(viewNameKey('Bugs'), viewNameKey('Bug'));
});
