import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EMPTY_NAV, NAV_LIMIT, canBack, canForward, navBack, navForget, navForward, navGo, navJump, recentSpots, type NavSpot } from './nav-history.ts';

const at = (key: string, line: number, col = 1): NavSpot => ({ key, path: key, line, col });

test('a jump remembers where the cursor was and where it went; Back and Forward walk between them', () => {
  let nav = navJump(EMPTY_NAV, null, at('a.twig', 1));
  nav = navJump(nav, at('a.twig', 2), at('b.css', 12));
  assert.deepEqual(nav.spots.map((s) => `${s.key}:${s.line}`), ['a.twig:2', 'b.css:12'], 'where the cursor had moved to by the jump replaces the place nearby');
  nav = navJump(EMPTY_NAV, null, at('a.twig', 1));
  nav = navJump(nav, at('a.twig', 40), at('b.css', 12));
  assert.deepEqual(nav.spots.map((s) => `${s.key}:${s.line}`), ['a.twig:1', 'a.twig:40', 'b.css:12'], 'a place far from it is a place of its own');
  const back = navBack(nav, at('b.css', 12));
  assert.deepEqual(back?.to, at('a.twig', 40));
  assert.ok(back && canForward(back.nav));
  const fwd = navForward(back!.nav, at('a.twig', 40));
  assert.deepEqual(fwd?.to, at('b.css', 12));
  assert.equal(navForward(fwd!.nav, at('b.css', 12)), null, 'nothing past the newest');
});

test('moving on after Back and then jumping drops what Forward would have returned to', () => {
  let nav = navJump(EMPTY_NAV, at('a', 1), at('b', 1));
  nav = navJump(nav, at('b', 1), at('c', 1));
  nav = navBack(nav, at('c', 1))!.nav;
  nav = navJump(nav, at('b', 1), at('d', 1));
  assert.deepEqual(nav.spots.map((s) => s.key), ['a', 'b', 'd']);
  assert.equal(canForward(nav), false);
});

test('a place the cursor wandered to after a jump is kept, so Forward comes back to it', () => {
  let nav = navJump(EMPTY_NAV, at('a', 1), at('b', 10));
  const back = navBack(nav, at('b', 200))!;
  assert.deepEqual(back.to, at('b', 10));
  nav = back.nav;
  assert.deepEqual(navForward(nav, at('b', 10))?.to, at('b', 200));
});

test('places a few lines apart in one file are one place; Back from the only place goes nowhere', () => {
  let nav = navJump(EMPTY_NAV, at('a', 10), at('a', 12));
  assert.equal(nav.spots.length, 1);
  assert.equal(canBack(nav, at('a', 11)), false);
  assert.equal(navBack(nav, at('a', 11)), null);
  assert.equal(canBack(nav, at('a', 90)), true, 'having moved far from it, Back returns to it');
  nav = navBack(nav, at('a', 90))!.nav;
  assert.deepEqual(nav.spots[nav.index], at('a', 12));
});

test('the history keeps its newest places, and the recent list is newest first with the current marked', () => {
  let nav = EMPTY_NAV;
  for (let i = 0; i < NAV_LIMIT + 15; i++) nav = navJump(nav, null, at(`f${i}`, 1));
  assert.equal(nav.spots.length, NAV_LIMIT);
  assert.equal(nav.spots[0]?.key, 'f15');
  const recent = recentSpots(nav);
  assert.equal(recent[0]?.spot.key, `f${NAV_LIMIT + 14}`);
  assert.equal(recent[0]?.current, true);
  const went = navGo(nav, 3, at(`f${NAV_LIMIT + 14}`, 1));
  assert.equal(went?.to.key, 'f18');
  assert.equal(went?.nav.spots.length, NAV_LIMIT, 'going straight to a place keeps the others');
});

test('a closed file that is gone is forgotten, and Back never lands on it', () => {
  let nav = navJump(EMPTY_NAV, at('a', 1), at('gone', 1));
  nav = navJump(nav, at('gone', 1), at('c', 1));
  nav = navForget(nav, 'gone');
  assert.deepEqual(nav.spots.map((s) => s.key), ['a', 'c']);
  assert.equal(nav.index, 1);
  assert.deepEqual(navBack(nav, at('c', 1))?.to.key, 'a');
});
