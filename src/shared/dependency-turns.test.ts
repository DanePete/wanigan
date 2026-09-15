/**
 * Which turn added a dependency. The claim under test is that a turn is named
 * only when a turn's own snapshots show the change first, and that every other
 * case — already there at launch, between prompts, a turn with no end snapshot,
 * a reading that failed, no checkpoints at all — says so instead.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attributeDependencyChanges, attributionPhrase, installPhrase, spansOf, type ManifestPoint } from './dependency-turns.ts';
import type { DepChange, DepEntry } from './dependencies.ts';

const dep = (name: string, version: string, section = 'dependencies'): DepEntry => ({ name, version, section });
const T0 = 1_000_000;
let id = 0;
const base = (entries: DepEntry[] | null): ManifestPoint => ({ source: 'base', checkpointId: null, turn: null, kind: null, at: null, entries, unreadable: entries ? null : 'broken' });
const cp = (turn: number, kind: string, at: number, entries: DepEntry[] | null, unreadable: string | null = null): ManifestPoint =>
  ({ source: 'checkpoint', checkpointId: ++id, turn, kind, at: T0 + at, entries, unreadable });
const now = (entries: DepEntry[] | null): ManifestPoint => ({ source: 'working-tree', checkpointId: null, turn: null, kind: null, at: null, entries, unreadable: null });
const added = (name: string, after: string): DepChange => ({ name, section: 'dependencies', change: 'added', before: null, after });

test('a dependency added in turn 2 is attributed to turn 2, with the install command recorded between its snapshots', () => {
  const react = dep('react', '^19.0.0');
  const points = [
    base([react]),
    cp(0, 'session-start', 0, [react]),
    cp(1, 'turn-start', 10, [react]), cp(1, 'turn-end', 20, [react]),
    cp(2, 'turn-start', 30, [react]), cp(2, 'turn-end', 40, [react, dep('p-retry', '6.2.0')]),
    now([react, dep('p-retry', '6.2.0')]),
  ];
  const commands = [
    { at: T0 + 15, command: 'npm install zod', ok: true, exitCode: null },
    { at: T0 + 35, command: 'npm install p-retry@6.2.0', ok: true, exitCode: null },
    { at: T0 + 36, command: 'npm test', ok: false, exitCode: 1 },
  ];
  const [a] = attributeDependencyChanges({ changes: [added('p-retry', '6.2.0')], points, commands, hooksRecorded: true });
  assert.equal(a.state, 'turn');
  if (a.state !== 'turn') return;
  assert.equal(a.turn, 2);
  assert.equal(a.fromCheckpoint, points[4].checkpointId);
  assert.equal(a.toCheckpoint, points[5].checkpointId);
  assert.deepEqual(a.install, { state: 'ran', commands: [{ command: 'npm install p-retry@6.2.0', ok: true, exitCode: null }] },
    'only the install inside turn 2 counts; turn 1\'s install and turn 2\'s test run do not');
  assert.equal(attributionPhrase(a), 'turn 2');
  assert.equal(installPhrase(a.install), 'an install command ran in that turn: `npm install p-retry@6.2.0`');

  const quiet = attributeDependencyChanges({ changes: [added('p-retry', '6.2.0')], points, commands: [], hooksRecorded: true })[0];
  assert.equal(quiet.state === 'turn' && quiet.install.state, 'none-recorded');
  const noHooks = attributeDependencyChanges({ changes: [added('p-retry', '6.2.0')], points, commands, hooksRecorded: false })[0];
  assert.equal(noHooks.state === 'turn' && installPhrase(noHooks.install), 'this session has no hook record, so whether an install ran in that turn is unknown');
});

test('already in the working tree at launch is "before the first checkpoint", not turn 1', () => {
  const points = [base([]), cp(0, 'session-start', 0, [dep('left-pad', '1.3.0')]), cp(1, 'turn-start', 10, [dep('left-pad', '1.3.0')]),
    cp(1, 'turn-end', 20, [dep('left-pad', '1.3.0')]), now([dep('left-pad', '1.3.0')])];
  const [a] = attributeDependencyChanges({ changes: [added('left-pad', '1.3.0')], points, commands: [], hooksRecorded: true });
  assert.equal(a.state, 'before-first-checkpoint');
  assert.equal(attributionPhrase(a), 'before the first checkpoint');
});

test('an edit between prompts, after the last snapshot, or in a turn with no end snapshot is outside the recorded turns', () => {
  const between = [base([]), cp(0, 'session-start', 0, []), cp(1, 'turn-start', 10, []), cp(1, 'turn-end', 20, []),
    cp(2, 'turn-start', 30, [dep('zod', '3.23.0')]), cp(2, 'turn-end', 40, [dep('zod', '3.23.0')]), now([dep('zod', '3.23.0')])];
  const a = attributeDependencyChanges({ changes: [added('zod', '3.23.0')], points: between, commands: [], hooksRecorded: true })[0];
  assert.equal(a.state, 'outside-turns');
  assert.match(a.detail, /between turn 1 and turn 2/);

  const tail = [base([]), cp(0, 'session-start', 0, []), cp(1, 'turn-start', 10, []), cp(1, 'turn-end', 20, []), now([dep('zod', '3.23.0')])];
  const b = attributeDependencyChanges({ changes: [added('zod', '3.23.0')], points: tail, commands: [], hooksRecorded: true })[0];
  assert.equal(b.state, 'outside-turns');
  assert.match(b.detail, /working tree since the last snapshot, after turn 1/);

  // Turn 2 is still running: its start snapshot exists, its end does not.
  const running = [base([]), cp(0, 'session-start', 0, []), cp(2, 'turn-start', 30, []), now([dep('zod', '3.23.0')])];
  const c = attributeDependencyChanges({ changes: [added('zod', '3.23.0')], points: running, commands: [], hooksRecorded: true })[0];
  assert.equal(c.state, 'outside-turns', 'a turn with no end snapshot is not guessed to be the turn');
  assert.match(c.detail, /after turn 2 began — it has no end snapshot yet/);
});

test('a reading that failed before the change stops the search, and no checkpoints at all names no turn', () => {
  const points = [base([]), cp(0, 'session-start', 0, []), cp(1, 'turn-start', 10, null, 'package.json is not valid JSON.'),
    cp(1, 'turn-end', 20, [dep('zod', '1.0.0')]), cp(2, 'turn-start', 30, [dep('zod', '1.0.0')]), cp(2, 'turn-end', 40, [dep('zod', '1.0.0')]), now([dep('zod', '1.0.0')])];
  const a = attributeDependencyChanges({ changes: [added('zod', '1.0.0')], points, commands: [], hooksRecorded: true })[0];
  assert.equal(a.state, 'unknown');
  assert.match(a.detail, /could not be read at the turn-start snapshot of turn 1 \(package\.json is not valid JSON\.\)/);

  const none = attributeDependencyChanges({ changes: [added('zod', '1.0.0')], points: [base([]), now([dep('zod', '1.0.0')])], commands: [], hooksRecorded: true })[0];
  assert.equal(none.state, 'no-checkpoints');
});

test('an upgrade across two turns is attributed to the first, and the other turn is named', () => {
  const points = [base([dep('react', '18.2.0')]), cp(0, 'session-start', 0, [dep('react', '18.2.0')]),
    cp(1, 'turn-start', 10, [dep('react', '18.2.0')]), cp(1, 'turn-end', 20, [dep('react', '18.3.0')]),
    cp(2, 'turn-start', 30, [dep('react', '18.3.0')]), cp(2, 'turn-end', 40, [dep('react', '19.0.0')]), now([dep('react', '19.0.0')])];
  const change: DepChange = { name: 'react', section: 'dependencies', change: 'upgraded', before: '18.2.0', after: '19.0.0' };
  const [a] = attributeDependencyChanges({ changes: [change], points, commands: [], hooksRecorded: true });
  assert.equal(a.state === 'turn' && a.turn, 1);
  assert.deepEqual(a.alsoTurns, [2]);
  // Removed in turn 1 and added back in turn 2 at a new version is still one upgrade, first made visible by turn 1.
  const out = [base([dep('react', '18.2.0')]), cp(1, 'turn-start', 10, [dep('react', '18.2.0')]), cp(1, 'turn-end', 20, []),
    cp(2, 'turn-start', 30, []), cp(2, 'turn-end', 40, [dep('react', '19.0.0')]), now([dep('react', '19.0.0')])];
  const b = attributeDependencyChanges({ changes: [change], points: out, commands: [], hooksRecorded: true })[0];
  assert.equal(b.state === 'turn' && b.turn, 2, 'removal is not the upgrade; the re-add at the new version is');
});

test('only a turn-start followed by its own end is a turn; a restore splits the span', () => {
  const spans = spansOf([base([]), cp(0, 'session-start', 0, []), cp(3, 'turn-start', 10, []), cp(3, 'pre-revert', 15, []), cp(3, 'turn-end', 20, []), now([])]);
  assert.deepEqual(spans.map((s) => s.kind), ['before-first', 'outside', 'turn', 'outside', 'outside']);
  assert.match(spans[3].where, /restore to an earlier checkpoint during turn 3/);
});
