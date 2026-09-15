import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { dataDir } from './db';
import { runGit } from './git';
import { listCheckpoints } from './checkpoints';
import { listSessions } from './sessions';
import { assertManagedRoot } from './roots';
import { splitPatchByFile } from '../shared/review-order';
import { decideFileStaging, type Interval } from '../shared/hunk-attribution';
import type { StagePlan, StagePlanFile } from '../shared/review-work';

/**
 * "Stage only the session's hunks": put into the index exactly the changes the
 * session's turns produced, and leave every other change in the working tree
 * unstaged — the operator's own edits most of all.
 *
 * The per-turn checkpoints are what make this answerable. Each turn has a
 * snapshot at its start and at its end, so the patch between them is what
 * happened while the agent held the turn; the gaps (launch to the first turn,
 * between turns, after the last) are everything else. The decision about which
 * files can be separated lives in shared/hunk-attribution.ts and refuses when an
 * edit outside the turns lands too close to a turn's lines.
 *
 * Nothing is written until the operator has seen the preview. The plan carries a
 * digest of the index, the working tree and the exact patch; applying recomputes
 * the plan and refuses if the digest moved, so what is staged is what was shown.
 * Only the index is written — `git apply --cached`, one invocation, which git
 * applies whole or not at all — and never HEAD, a branch or the working tree.
 */

const GIT_OPTS = { timeout: 60_000, maxBuffer: 64 * 1024 * 1024 };
const PATHSPEC_CHUNK = 150;

function scratchDir(): string {
  const dir = path.join(dataDir(), 'stage-scratch');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function refused(refusal: string, root: string | null = null): StagePlan {
  return { ok: false, refusal, digest: null, root, files: [], untouched: [], patch: '', turns: 0 };
}

async function indexPath(root: string): Promise<string | null> {
  const r = await runGit(root, ['rev-parse', '--git-path', 'index'], { timeout: 8_000, maxBuffer: 1024 * 1024 });
  if (!r.ok || !r.out.trim()) return null;
  return path.resolve(root, r.out.trim());
}

/** A private copy of the index to work in, removed by the caller. */
async function tempIndex(root: string): Promise<string | null> {
  const real = await indexPath(root);
  if (!real) return null;
  const copy = path.join(scratchDir(), `index-${randomUUID()}`);
  try { fs.copyFileSync(real, copy); } catch { /* no index yet: git starts an empty one */ }
  return copy;
}

async function writePatchFile(patch: string): Promise<string> {
  const file = path.join(scratchDir(), `patch-${randomUUID()}.diff`);
  fs.writeFileSync(file, patch, { mode: 0o600 });
  return file;
}

async function diffFor(root: string, from: string, to: string, files: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < files.length; i += PATHSPEC_CHUNK) {
    const chunk = files.slice(i, i + PATHSPEC_CHUNK);
    const r = await runGit(root, ['-c', 'core.quotePath=false', 'diff', '--binary', '--full-index', '--no-renames', '--no-color', '--no-ext-diff', from, to, '--', ...chunk], GIT_OPTS);
    if (!r.ok) throw new Error(`git could not compare two snapshots: ${r.err.split('\n')[0]}`);
    for (const [file, patch] of splitPatchByFile(r.out)) out.set(file, patch);
  }
  return out;
}

export async function stagePlan(sessionId: unknown): Promise<StagePlan> {
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200) return refused('Choose a session.');
  const rows = listCheckpoints(sessionId);
  const launch = rows.find((r) => r.kind === 'session-start' && r.commitHash);
  if (!launch?.commitHash) {
    return refused('This session has no launch snapshot, so there is nothing to tell its changes apart from anyone else\'s. Per-turn checkpoints need a hook-capable harness in a git repository.');
  }
  const root = launch.repoRoot;
  if (!fs.existsSync(root)) return refused('The checkout this session ran in no longer exists.');
  try { assertManagedRoot(root, 'That repository'); } catch (e) { return refused(e instanceof Error ? e.message : String(e)); }

  const live = listSessions().find((s) => s.id === sessionId);
  const maxTurn = rows.reduce((m, r) => Math.max(m, r.turn), 0);
  const turns: { n: number; start: string; end: string }[] = [];
  for (let n = 1; n <= maxTurn; n++) {
    const inTurn = rows.filter((r) => r.turn === n);
    const start = inTurn.find((r) => r.kind === 'turn-start' && r.commitHash)?.commitHash;
    const end = [...inTurn].reverse().find((r) => (r.kind === 'turn-end' || r.kind === 'session-end') && r.commitHash)?.commitHash;
    if (!start && !end) continue;
    if (!start || !end) {
      const inFlight = n === maxTurn && live && live.status !== 'exited';
      return refused(inFlight
        ? `Turn ${n} is still running, so its changes are not final. Stage once the turn ends.`
        : `Turn ${n} has no ${start ? 'end' : 'start'} snapshot (its capture failed), so what it changed cannot be told from what happened around it.`, root);
    }
    turns.push({ n, start, end });
  }
  if (!turns.length) return refused('No turn of this session has both snapshots yet, so there are no session hunks to stage.', root);

  const indexTree = await runGit(root, ['write-tree'], GIT_OPTS);
  if (!indexTree.ok || !indexTree.out.trim()) {
    return refused(`git could not read the index (${indexTree.err.split('\n')[0] || 'write-tree failed'}). Resolve any conflicts first.`, root);
  }
  const scratchIndex = await tempIndex(root);
  if (!scratchIndex) return refused('git could not locate this checkout\'s index.', root);
  const cleanup: string[] = [scratchIndex];
  try {
    const env = { GIT_INDEX_FILE: scratchIndex };
    const add = await runGit(root, ['add', '-A', '.'], { ...GIT_OPTS, env });
    const work = add.ok ? await runGit(root, ['write-tree'], { ...GIT_OPTS, env }) : add;
    if (!work.ok || !work.out.trim()) return refused(`git could not snapshot the working tree: ${work.err.split('\n')[0]}`, root);
    const W = work.out.trim();
    const I = indexTree.out.trim();

    // The timeline of snapshots, and the interval between each neighbouring pair.
    const points = [launch.commitHash, ...turns.flatMap((t) => [t.start, t.end]), W];
    const between: { from: string; to: string; kind: 'turn' | 'outside'; turn: number | null; label: string }[] = [];
    for (let i = 0; i < points.length - 1; i++) {
      const turnIndex = i % 2 === 1 ? (i - 1) / 2 : null;
      const turn = turnIndex === null ? null : turns[turnIndex];
      const label = turn ? `turn ${turn.n}`
        : i === 0 ? 'before the first turn'
          : i === points.length - 2 ? 'after the last turn'
            : `between turn ${turns[i / 2 - 1].n} and turn ${turns[i / 2].n}`;
      between.push({ from: points[i], to: points[i + 1], kind: turn ? 'turn' : 'outside', turn: turn?.n ?? null, label });
    }

    const agentFiles = new Set<string>();
    for (const iv of between.filter((b) => b.kind === 'turn')) {
      const names = await runGit(root, ['-c', 'core.quotePath=false', 'diff-tree', '-r', '--name-only', '--no-renames', '-z', iv.from, iv.to], GIT_OPTS);
      if (!names.ok) return refused(`git could not read turn ${iv.turn}'s snapshots: ${names.err.split('\n')[0]}`, root);
      for (const f of names.out.split('\0').filter(Boolean)) agentFiles.add(f);
    }
    const files = [...agentFiles].sort();

    const untouchedRun = await runGit(root, ['-c', 'core.quotePath=false', 'diff-tree', '-r', '--name-only', '--no-renames', '-z', I, W], GIT_OPTS);
    const untouched = untouchedRun.ok ? untouchedRun.out.split('\0').filter((f) => f && !agentFiles.has(f)) : [];
    if (!files.length) {
      return { ok: true, refusal: null, digest: null, root, files: [], untouched, patch: '', turns: turns.length };
    }

    const patches = await Promise.all(between.map((iv) => diffFor(root, iv.from, iv.to, files)));
    const plan: StagePlanFile[] = [];
    for (const file of files) {
      const intervals: Interval[] = between.map((iv, i) => ({ kind: iv.kind, turn: iv.turn, label: iv.label, patch: patches[i].get(file) ?? '' }));
      const outsideChanged = intervals.map((iv, i) => ({ iv, i })).filter(({ iv }) => iv.kind === 'outside' && iv.patch.trim());
      let stretches: { before: string; after: string } | undefined;
      if (outsideChanged.length === 1) {
        const i = outsideChanged[0].i;
        const lastEnd = points.length - 2;
        const [before, after] = await Promise.all([
          i > 0 ? diffFor(root, points[0], points[i], [file]).then((m) => m.get(file) ?? '') : Promise.resolve(''),
          i + 1 < lastEnd ? diffFor(root, points[i + 1], points[lastEnd], [file]).then((m) => m.get(file) ?? '') : Promise.resolve(''),
        ]);
        stretches = { before, after };
      }
      const decision = decideFileStaging(file, intervals, stretches);
      if (decision.action === 'none') continue;
      if (decision.action === 'refuse') { plan.push({ path: file, action: 'refuse', turns: [], mixed: true, reason: decision.reason, patch: '' }); continue; }
      plan.push({ path: file, action: 'stage', turns: decision.turns, mixed: decision.mixed, reason: null,
        patch: intervals.filter((iv) => iv.kind === 'turn' && iv.patch.trim()).map((iv) => iv.patch).join('') });
    }

    // Check every patch against a private copy of the real index, in order, so a
    // change already staged or committed is recognised rather than re-applied,
    // and a turn's patch that no longer applies is refused with git's words.
    const verifyIndex = await tempIndex(root);
    if (!verifyIndex) return refused('git could not locate this checkout\'s index.', root);
    cleanup.push(verifyIndex);
    const venv = { GIT_INDEX_FILE: verifyIndex };
    for (const entry of plan.filter((p) => p.action === 'stage')) {
      const pieces = entry.turns.map((n) => patches[between.findIndex((b) => b.turn === n)].get(entry.path) ?? '').filter((p) => p.trim());
      const kept: string[] = [];
      for (const [k, piece] of pieces.entries()) {
        const pf = await writePatchFile(piece);
        cleanup.push(pf);
        const check = await runGit(root, ['apply', '--cached', '--check', pf], { ...GIT_OPTS, env: venv });
        if (check.ok) {
          const applied = await runGit(root, ['apply', '--cached', pf], { ...GIT_OPTS, env: venv });
          if (!applied.ok) { entry.action = 'refuse'; entry.reason = `git would not apply turn ${entry.turns[k]}'s change to \`${entry.path}\`: ${applied.err.split('\n')[0]}`; break; }
          kept.push(piece);
          continue;
        }
        const reverse = await runGit(root, ['apply', '--cached', '--reverse', '--check', pf], { ...GIT_OPTS, env: venv });
        if (reverse.ok) continue;
        entry.action = 'refuse';
        entry.reason = `Turn ${entry.turns[k]}'s change to \`${entry.path}\` does not apply to the index as it is now: ${check.err.split('\n')[0] || 'git refused it'}.`;
        break;
      }
      if (entry.action === 'stage') {
        entry.patch = kept.join('');
        if (!kept.length) { entry.action = 'already-staged'; entry.reason = 'Already in the index or committed.'; }
      } else {
        entry.patch = '';
      }
    }

    const patch = plan.filter((p) => p.action === 'stage').map((p) => p.patch).join('');
    const digest = createHash('sha256').update(`${I}\n${W}\n`).update(patch).digest('hex');
    return { ok: true, refusal: null, digest: patch ? digest : null, root, files: plan, untouched, patch, turns: turns.length };
  } finally {
    for (const f of cleanup) { try { fs.rmSync(f, { force: true }); } catch { /* scratch */ } }
  }
}

export async function stageApply(sessionId: unknown, digest: unknown): Promise<{ staged: string[]; detail: string }> {
  if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) throw new Error('Preview the staging first.');
  const plan = await stagePlan(sessionId);
  if (!plan.ok || !plan.root) throw new Error(plan.refusal ?? 'The staging plan could not be made.');
  if (plan.digest !== digest) {
    throw new Error('The index or the working tree changed since the preview, so what would be staged is not what you were shown. Nothing was staged; preview again.');
  }
  const staged = plan.files.filter((f) => f.action === 'stage').map((f) => f.path);
  const pf = await writePatchFile(plan.patch);
  try {
    const check = await runGit(plan.root, ['apply', '--cached', '--check', pf], GIT_OPTS);
    if (!check.ok) throw new Error(`git refused the staging, so nothing was staged: ${check.err.split('\n')[0]}`);
    const apply = await runGit(plan.root, ['apply', '--cached', pf], GIT_OPTS);
    if (!apply.ok) throw new Error(`git refused the staging, so nothing was staged: ${apply.err.split('\n')[0]}`);
  } finally {
    try { fs.rmSync(pf, { force: true }); } catch { /* scratch */ }
  }
  const left = plan.files.filter((f) => f.mixed && f.action === 'stage').length;
  return {
    staged,
    detail: `Staged the session's hunks in ${staged.length} file${staged.length === 1 ? '' : 's'}.`
      + (left ? ` ${left} of them also have edits from outside the session's turns, which stay unstaged.` : '')
      + (plan.untouched.length ? ` ${plan.untouched.length} other changed file${plan.untouched.length === 1 ? ' was' : 's were'} left as they were.` : ''),
  };
}
