import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEVTOOLS_CLOSED, centreOf, devtoolsBox, devtoolsPoint, devtoolsStep, offScreen, viewportBox,
  type DevtoolsEffect, type DevtoolsEvent, type DevtoolsModel,
} from './live-devtools.ts';

const DOCK = { x: 300, y: 620, width: 1100, height: 260 };
const MOVED = { x: 300, y: 540, width: 1100, height: 340 };

/** Run events from a model, collecting every effect in order. */
function run(from: DevtoolsModel, ...events: DevtoolsEvent[]): { model: DevtoolsModel; effects: DevtoolsEffect[] } {
  let model = from;
  const effects: DevtoolsEffect[] = [];
  for (const e of events) {
    const next = devtoolsStep(model, e);
    model = next.model;
    effects.push(...next.effects);
  }
  return { model, effects };
}
const withPage = (project = 'p1', page = 7): DevtoolsModel => run(DEVTOOLS_CLOSED, { type: 'page', page, project }).model;
const kinds = (effects: DevtoolsEffect[]): string[] => effects.map((e) => e.do);

test('showing the tab opens DevTools in a view of its own over the dock, and says so', () => {
  const { model, effects } = run(withPage(), { type: 'show', bounds: DOCK });
  assert.equal(model.mode, 'docked');
  assert.deepEqual(effects, [{ do: 'dock' }, { do: 'place', bounds: DOCK, visible: true }, { do: 'tell', mode: 'docked' }]);
});

test('the view follows the dock: a resize, the dock’s height, its side', () => {
  const docked = run(withPage(), { type: 'show', bounds: DOCK }).model;
  const { model, effects } = run(docked, { type: 'bounds', bounds: MOVED });
  assert.deepEqual(effects, [{ do: 'place', bounds: MOVED, visible: true }], 'moved where the tab now is, nothing reopened');
  assert.deepEqual(model.bounds, MOVED);
});

test('hiding the tab steps the view aside and keeps DevTools; showing it again does not open it twice', () => {
  const docked = run(withPage(), { type: 'show', bounds: DOCK }).model;
  const hidden = run(docked, { type: 'hide' });
  assert.deepEqual(hidden.effects, [{ do: 'place', bounds: DOCK, visible: false }]);
  assert.equal(hidden.model.mode, 'docked', 'still open, its console and selection kept');
  // While hidden, the dock still moves (the window is resized): kept for when it shows, never drawn.
  const moved = run(hidden.model, { type: 'bounds', bounds: MOVED });
  assert.deepEqual(moved.effects, [{ do: 'place', bounds: MOVED, visible: false }]);
  const again = run(moved.model, { type: 'show', bounds: MOVED });
  assert.deepEqual(again.effects, [{ do: 'place', bounds: MOVED, visible: true }]);
  // Hiding twice draws nothing twice.
  assert.deepEqual(run(hidden.model, { type: 'hide' }).effects, []);
});

test('leaving the project, or closing the window, closes DevTools wherever it is', () => {
  const docked = run(withPage(), { type: 'show', bounds: DOCK }).model;
  assert.deepEqual(run(docked, { type: 'close' }).effects, [{ do: 'undock' }, { do: 'tell', mode: 'closed' }]);
  const detached = run(docked, { type: 'detach' }).model;
  assert.deepEqual(run(detached, { type: 'close' }).effects, [{ do: 'close-window' }, { do: 'tell', mode: 'closed' }]);
  // The window going away is the page going away.
  assert.deepEqual(kinds(run(docked, { type: 'page', page: null, project: null }).effects), ['undock', 'tell']);
  assert.deepEqual(kinds(run(detached, { type: 'page', page: null, project: null }).effects), ['close-window', 'tell']);
  assert.deepEqual(run(withPage(), { type: 'close' }).effects, [], 'closing what is closed does nothing');
});

test('in its own window, the dock’s view is gone and the tab does not pull DevTools back', () => {
  const docked = run(withPage(), { type: 'show', bounds: DOCK }).model;
  const out = run(docked, { type: 'detach' });
  assert.deepEqual(out.effects, [{ do: 'undock' }, { do: 'detach' }, { do: 'tell', mode: 'detached' }]);
  // The tab shown again (or moved) leaves it in its window, on the second screen.
  assert.deepEqual(run(out.model, { type: 'show', bounds: DOCK }, { type: 'bounds', bounds: MOVED }, { type: 'hide' }).effects, []);
  // Back into the dock is closing it there and showing the tab.
  const back = run(out.model, { type: 'close' }, { type: 'show', bounds: DOCK });
  assert.deepEqual(kinds(back.effects), ['close-window', 'tell', 'dock', 'place', 'tell']);
  assert.equal(back.model.mode, 'docked');
  // Its window closed by the owner: closed, and said.
  assert.deepEqual(run(out.model, { type: 'gone' }).effects, [{ do: 'tell', mode: 'closed' }]);
  // Detaching with nothing open opens its window at once.
  assert.deepEqual(kinds(run(withPage(), { type: 'detach' }).effects), ['detach', 'tell']);
});

test('a navigation is not a new page: DevTools stays; a new page of the project while it shows gets it again', () => {
  const docked = run(withPage('p1', 7), { type: 'show', bounds: DOCK }).model;
  assert.deepEqual(run(docked, { type: 'page', page: 7, project: 'p1' }).effects, [], 'the same page, navigated, keeps its DevTools');
  // Another environment of the project: the view is made again, and DevTools with it, where it was.
  const env = run(docked, { type: 'page', page: null, project: null }, { type: 'page', page: 9, project: 'p1' });
  assert.deepEqual(kinds(env.effects), ['undock', 'tell', 'dock', 'place', 'tell']);
  assert.deepEqual(env.effects[3], { do: 'place', bounds: DOCK, visible: true });
  assert.equal(env.model.page, 9);
  // Another project's page never inherits it.
  const other = run(docked, { type: 'page', page: null, project: null }, { type: 'page', page: 11, project: 'p2' });
  assert.deepEqual(kinds(other.effects), ['undock', 'tell']);
  assert.equal(other.model.mode, 'closed');
  assert.equal(other.model.shown, false);
  // Hidden (on another tab) when the page changed: closed, opened fresh when the tab shows.
  const hidden = run(docked, { type: 'hide' }, { type: 'page', page: 9, project: 'p1' });
  assert.equal(hidden.model.mode, 'closed');
});

test('the tab shown before the page exists opens DevTools once the page does', () => {
  const early = run(DEVTOOLS_CLOSED, { type: 'show', bounds: DOCK });
  assert.deepEqual(early.effects, [], 'nothing to open yet');
  const later = run(early.model, { type: 'page', page: 3, project: 'p1' });
  assert.deepEqual(kinds(later.effects), ['dock', 'place', 'tell']);
});

test('Show in DevTools opens it in the dock when it is closed, then points it at the element', () => {
  const closed = run(withPage(), { type: 'show', bounds: DOCK }, { type: 'close' }).model;
  const opened = run(closed, { type: 'inspect', x: 210, y: 64 });
  assert.deepEqual(opened.effects, [{ do: 'dock' }, { do: 'place', bounds: DOCK, visible: false }, { do: 'inspect', x: 210, y: 64 }, { do: 'tell', mode: 'docked' }]);
  // The tab then shows it (Show in DevTools opens the tab).
  assert.deepEqual(run(opened.model, { type: 'show', bounds: DOCK }).effects, [{ do: 'place', bounds: DOCK, visible: true }]);
  // Open already, docked or in its own window: only the inspection.
  const docked = run(withPage(), { type: 'show', bounds: DOCK }).model;
  assert.deepEqual(run(docked, { type: 'inspect', x: 1, y: 2 }).effects, [{ do: 'inspect', x: 1, y: 2 }]);
  const detached = run(docked, { type: 'detach' }).model;
  assert.deepEqual(run(detached, { type: 'inspect', x: 1, y: 2 }).effects, [{ do: 'inspect', x: 1, y: 2 }]);
  // No page: nothing.
  assert.deepEqual(run(DEVTOOLS_CLOSED, { type: 'inspect', x: 1, y: 2 }).effects, []);
});

test('the dock’s view stopping on its own closes DevTools and takes the view away', () => {
  const docked = run(withPage(), { type: 'show', bounds: DOCK }).model;
  assert.deepEqual(run(docked, { type: 'gone' }).effects, [{ do: 'undock' }, { do: 'tell', mode: 'closed' }]);
  assert.deepEqual(run(withPage(), { type: 'gone' }).effects, [], 'gone when closed is nothing');
});

test('boxes and points from the window are checked', () => {
  assert.deepEqual(devtoolsBox({ x: 10.4, y: -3, width: 99999, height: 200 }), { x: 10, y: 0, width: 10_000, height: 200 });
  for (const bad of [null, 'x', { x: 1, y: 2, width: 3 }, { x: Number.NaN, y: 0, width: 1, height: 1 }, { x: '1', y: 0, width: 1, height: 1 }]) assert.equal(devtoolsBox(bad), null);
  assert.deepEqual(devtoolsPoint(12.6, 0), { x: 13, y: 0 });
  for (const [x, y] of [[-1, 0], [0, 10_001], [Number.POSITIVE_INFINITY, 1], ['3', 4], [null, null]]) assert.equal(devtoolsPoint(x, y), null, `${String(x)}, ${String(y)}`);
  // A part's box may run off the top or the left of the viewport.
  assert.deepEqual(viewportBox({ x: -40, y: -1200.2, width: 300, height: 80 }), { x: -40, y: -1200, width: 300, height: 80 });
  assert.equal(viewportBox({ x: 0, y: 0, width: -1, height: 4 }), null);
  assert.equal(viewportBox({ x: 0, y: 2e9, width: 1, height: 4 }), null);
});

test('the centre of a part is the centre of what of it is on screen, in the page’s pixels', () => {
  const view = { width: 1000, height: 600 };
  assert.deepEqual(centreOf({ x: 100, y: 50, width: 200, height: 100 }, view), { x: 200, y: 100 });
  // Cut by the bottom of the viewport: the centre of the part that shows.
  assert.deepEqual(centreOf({ x: 0, y: 500, width: 1000, height: 400 }, view), { x: 500, y: 550 });
  // Taller than the viewport and scrolled through: the middle of the screen.
  assert.deepEqual(centreOf({ x: 0, y: -900, width: 1000, height: 3000 }, view), { x: 500, y: 300 });
  // Off screen, above, below or beside: nothing to point at until the page scrolls to it.
  for (const off of [{ x: 0, y: -200, width: 100, height: 200 }, { x: 0, y: 600, width: 100, height: 20 }, { x: 1000, y: 10, width: 50, height: 50 }]) {
    assert.equal(centreOf(off, view), null);
    assert.ok(offScreen(off, view));
  }
  // A sliver of a pixel is not on screen; a part of one pixel is.
  assert.equal(centreOf({ x: 0, y: 599.5, width: 100, height: 20 }, view), null);
  assert.deepEqual(centreOf({ x: 999, y: 599, width: 1, height: 1 }, view), { x: 999, y: 599 });
});
