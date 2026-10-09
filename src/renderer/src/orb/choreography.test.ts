// The orb's choreography without a GPU: which signal shows, what a mood change
// performs, how long a fire whirl and a recovery flame last, and that every
// gesture ends. The fluid itself is checked by scripts/orb-probe.mjs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Expression } from './expression.ts';
import { cueFor, playable, ORB_ACTIONS } from './mood.ts';
import { TINT, alarmTint, signalFor } from './signal.ts';
import { Story } from './story.ts';

const needs = (...kinds: string[]) => kinds.map((kind) => ({ kind })) as Parameters<typeof signalFor>[0];

/** Run `subject` for `seconds` at 60 frames a second and return the last value. */
function run<T>(seconds: number, frame: (dt: number) => T): T {
  let last = frame(0);
  for (let t = 0; t < seconds - 1e-9; t += 1 / 60) last = frame(1 / 60);
  return last;
}

test('the signal is the most urgent need, and an unread list is not an all-clear', () => {
  assert.equal(signalFor(undefined, 3), 'unavailable');
  assert.equal(signalFor(needs(), 0), 'quiet');
  assert.equal(signalFor(needs(), 2), 'working');
  assert.equal(signalFor(needs('waiting'), 2), 'finished');
  assert.equal(signalFor(needs('waiting', 'review'), 0), 'attention');
  assert.equal(signalFor(needs('waiting', 'permission', 'interrupted'), 1), 'failed');
  // A session gone quiet is not a colour of its own; it still counts as running.
  assert.equal(signalFor(needs('quiet'), 1), 'working');
});

test('finished is green, unavailable is a dim slate, and the held alarm yields to a performance', () => {
  const [r, g, b, strength] = TINT.finished;
  assert.ok(g > r && g > b && strength > 0.5);
  assert.ok(TINT.unavailable[3] < 0.3);
  assert.equal(alarmTint(0)[3], 0.3);
  assert.equal(alarmTint(1)[3], 0);
});

test('entering a mood performs once; the first mood and holding one perform nothing', () => {
  assert.equal(cueFor('idle', 'idle'), null);
  assert.equal(cueFor('idle', 'thinking'), null);
  assert.equal(cueFor('thinking', 'celebrate'), 'celebrate');
  assert.equal(cueFor('celebrate', 'celebrate'), null);
  assert.equal(cueFor('idle', 'alarm'), 'fail');
  assert.equal(cueFor('alarm', 'recovered'), 'recover');
  assert.equal(cueFor('recovered', 'idle'), null);
});

test('the lava lamp refuses only what needs water', () => {
  assert.deepEqual(ORB_ACTIONS.filter((a) => !playable(a, 'wax')), ['burst', 'rain', 'bloom']);
  assert.ok(ORB_ACTIONS.every((a) => playable(a, 'water')));
});

test('a failure is one fire whirl of about six seconds, and it re-arms only after eight', () => {
  const story = new Story();
  story.fail();
  const rising = run(1.2, (dt) => story.step(dt).whirl);
  assert.ok(rising > 0.9, `whirl at 1.2 s: ${rising}`);
  const holding = run(3.5, (dt) => story.step(dt).whirl);
  assert.ok(holding > 0.95, `whirl at 4.7 s: ${holding}`);
  story.fail(); // a second failure while the first still burns adds nothing
  const done = run(2.6, (dt) => story.step(dt).whirl);
  assert.equal(done, 0, `whirl at 7.3 s: ${done}`);
  assert.equal(story.active, false);
  run(1, (dt) => story.step(dt));
  story.fail();
  assert.ok(run(1.2, (dt) => story.step(dt).whirl) > 0.9, 'a failure after eight seconds burns again');
});

test('a recovery puts out the whirl and burns blue for about three seconds', () => {
  const story = new Story();
  story.fail();
  run(2, (dt) => story.step(dt));
  story.recover();
  const flame = run(0.8, (dt) => story.step(dt));
  assert.ok(flame.recovery > 0.9 && flame.whirl < 0.05, JSON.stringify(flame));
  assert.equal(run(2.6, (dt) => story.step(dt)).recovery, 0);
});

test('with motion reduced, an outcome is absorbed rather than performed', () => {
  const story = new Story();
  story.fail();
  story.settle();
  assert.deepEqual(run(1, (dt) => story.step(dt)), { whirl: 0, recovery: 0 });
});

test('a spin winds up for 140 ms, turns once, and cools down for 1.5 s', () => {
  const face = new Expression();
  run(0.5, (dt) => face.step(dt));
  assert.equal(face.spin(), true);
  const windUp = run(0.1, (dt) => face.step(dt));
  assert.ok(windUp.gazeX < -0.3, `eyes lead the turn: ${windUp.gazeX}`);
  assert.equal(face.spin(), false, 'refused while cooling down');
  const turned = run(1.6, (dt) => face.step(dt));
  assert.ok(turned.yaw > Math.PI && Math.cos(turned.yaw) > 0.95, `a full turn ends facing front: ${turned.yaw}`);
  assert.equal(face.spin(), true);
});

test('a celebration is a single burst with a nod and warmth, then rest', () => {
  const face = new Expression();
  run(0.5, (dt) => face.step(dt));
  face.celebrate();
  const now = face.step(1 / 60);
  assert.ok(now.celebration > 0.9);
  const nod = run(0.5, (dt) => face.step(dt));
  assert.equal(nod.celebration, 0);
  assert.ok(nod.warmth > 0.5 && nod.pitch > 0.03, JSON.stringify({ warmth: nod.warmth, pitch: nod.pitch }));
  const after = run(3, (dt) => face.step(dt));
  assert.ok(after.warmth < 0.05 && Math.abs(after.pitch) < 0.01);
});

test('thinking swirls the water while it lasts, and stops when it ends', () => {
  const face = new Expression();
  face.think(true);
  assert.ok(run(3, (dt) => face.step(dt)).vortex > 0.55);
  assert.equal(run(3, (dt) => face.step(dt)).bubbleInterest, 0, 'no bubble watching while thinking');
  face.think(false);
  assert.ok(run(4, (dt) => face.step(dt)).vortex < 0.02);
});

test('wax fades in over about a second, or at once with motion reduced', () => {
  const face = new Expression();
  face.material(true);
  assert.ok(run(0.3, (dt) => face.step(dt)).lava < 0.8);
  assert.ok(run(1.5, (dt) => face.step(dt)).lava > 0.97);
  face.material(false, true);
  assert.equal(face.step(0).lava, 0);
  assert.equal(new Expression({ wax: true }).step(0).lava, 1);
});

test('listening looks toward the text box and nods once', () => {
  const face = new Expression();
  run(0.5, (dt) => face.step(dt));
  face.listen({ x: 0.9, y: -0.6 });
  const looking = run(0.6, (dt) => face.step(dt));
  assert.ok(looking.gazeX > 0.8 && looking.gazeY < -0.5, JSON.stringify(looking));
  assert.equal(looking.bubbleInterest, 0);
  face.listen(null);
  assert.ok(Math.abs(run(1, (dt) => face.step(dt)).gazeX) < 0.5);
});
