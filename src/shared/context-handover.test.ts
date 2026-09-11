/**
 * When the bubble may speak, and what it may claim.
 *
 * Every assertion here is a sentence Wanigan would otherwise be free to say
 * about somebody's machine on no evidence. The orb has refused to perform on an
 * assumed window since it was written; the point of most of this file is that
 * the sentence refuses in exactly the same places, because an orb crowding
 * while the text stays silent — or worse, text appearing where the orb will not
 * move — is a disagreement only running the app would reveal.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HANDOVER_PROMPT, SETTLE_BELOW, SUGGEST_AT,
  handoverMessage, handoverSeed, handoverState,
} from './context-handover.ts';
import { contextPressure, type ContextReading } from './orb-story.ts';

const now = 1_800_000_000_000;
const reading = (over: Partial<ContextReading> = {}): ContextReading => ({
  sessionId: 's1', label: 'Refactor', ratio: 0.9, estimated: false, at: now - 1_000, note: 'Reported', ...over,
});

test('it never speaks where the orb will not move', () => {
  // The whole cross-product of the refusals contextPressure makes.
  const silent: Partial<ContextReading>[] = [
    { estimated: true },                  // a window nobody measured
    { ratio: null },                      // no percentage to quote
    { at: null },                         // no timestamp to age
    { at: now - 121_000 },                // stale past two minutes
    { at: now + 6_000 },                  // a clock that ran backwards
  ];
  for (const over of silent) {
    const r = reading({ ratio: 0.99, ...over });
    assert.equal(contextPressure(r, now), 0, `pressure for ${JSON.stringify(over)}`);
    assert.equal(handoverState(r, now, false), 'none', `fresh for ${JSON.stringify(over)}`);
    assert.equal(handoverState(r, now, true), 'none',
      `already showing, for ${JSON.stringify(over)} — a reading going bad must retract the message`);
  }
  assert.equal(handoverState(undefined, now, true), 'none');
});

test('an estimated window is silent even at the very top', () => {
  // The one most likely to be "fixed" by somebody who thinks 99% must matter.
  assert.equal(handoverState(reading({ ratio: 0.99, estimated: true }), now, false), 'none');
});

test('it suggests at the threshold and not before', () => {
  assert.equal(handoverState(reading({ ratio: SUGGEST_AT }), now, false), 'suggest');
  assert.equal(handoverState(reading({ ratio: SUGGEST_AT - 0.001 }), now, false), 'none');
  assert.equal(handoverState(reading({ ratio: 0.5 }), now, false), 'none');
});

test('the band is hysteresis, so a streaming turn cannot flicker it', () => {
  // Between the two numbers the answer depends on what is already on screen.
  const between = reading({ ratio: (SUGGEST_AT + SETTLE_BELOW) / 2 });
  assert.equal(handoverState(between, now, false), 'none', 'does not start here');
  assert.equal(handoverState(between, now, true), 'suggest', 'but does not vanish here either');
  assert.equal(handoverState(reading({ ratio: SETTLE_BELOW - 0.001 }), now, true), 'none',
    'and clears once the conversation drops below the lower number');
  assert.ok(SETTLE_BELOW < SUGGEST_AT, 'the band has to have width to be a band');
});

test('the message quotes what was read, rounded down', () => {
  // Never up: 84.9% reading as 85% would put a number on screen that is over a
  // threshold the reading did not actually cross.
  assert.equal(handoverMessage(reading({ ratio: 0.869 })), 'This conversation is at 86% of its window.');
  assert.equal(handoverMessage(reading({ ratio: 0.9 })), 'This conversation is at 90% of its window.');
});

test('an unconfirmed conversation match is said, not hidden', () => {
  const text = handoverMessage(reading({ ratio: 0.9 }), false);
  assert.match(text, /90%/);
  assert.match(text, /could not confirm/);
});

test('the prompt asks for the work, not for a recap of the talking', () => {
  // A new session cannot see the old conversation, so a summary of what was
  // said is close to useless to it; the task state is what carries.
  for (const word of ['handover', 'decided', 'next step', 'files']) {
    assert.match(HANDOVER_PROMPT, new RegExp(word, 'i'), `prompt mentions ${word}`);
  }
  assert.match(HANDOVER_PROMPT, /cannot see this conversation/i);
});

test('the seed is labelled as a handover rather than passed off as the work', () => {
  const seed = handoverSeed('  Refactoring the account panel.  ');
  assert.match(seed, /Handover note from the previous session/);
  assert.match(seed, /Refactoring the account panel\./);
  // The blank line between the label and the note is deliberate, so this
  // asserts the note's own edges rather than the gap before it.
  assert.ok(seed.endsWith('Refactoring the account panel.'),
    'the note is trimmed at both ends and nothing follows it');
  assert.match(seed, /session:\n\n\S/, 'exactly one blank line separates the label from the note');
});
