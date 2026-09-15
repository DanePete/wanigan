import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { app, dialog, type BrowserWindow } from 'electron';
import { db } from './db';
import { runGit, head } from './git';
import { projectById } from './store';
import { runCommand } from './review';
import { verificationTreeFor } from './control';
import { linkIgnoredDeps, repoRootFor } from './worktrees';
import {
  PROOF_VERDICT_LABEL, classifyProof, outputTail, validateProofCommand, type ProofRun, type ProofVerdict,
} from '../shared/regression-proof';
import type { RegressionProofRecord } from '../shared/review-work';

/**
 * Fails before, passes after, for a goal's verify task.
 *
 * The operator names one test command. Wanigan runs it twice: in a scratch
 * checkout of the goal's base commit, made with `git worktree add --detach` in
 * Wanigan's own data directory and removed afterwards, and in the tree the
 * verification is about — the implementation's worktree, or the project when
 * the work happened there. Both results are stored as one `work_proofs` row of
 * kind `regression`, with exit codes, durations and output tails. The review
 * gate's pass/fail proof is a separate row and this one never stands in for it.
 *
 * The command is stored only after a dialog the operator answers, the same
 * rule the review recipe follows: it reaches `$SHELL -lc` twice, so consent is
 * given where the capability is created, and running it later does not ask
 * again. There is no model call anywhere here.
 *
 * The scratch checkout gets the same ignored dependency directories a session
 * worktree gets (node_modules, vendor, .venv — linked, not copied), so "could
 * not run before" is not simply the absence of an install. The proof records
 * which were linked. A base commit whose dependencies differ from today's is a
 * real limit of that choice and is not hidden: its output tail is kept.
 */

type NodeRow = { id: string; docket_id: string; kind: string; title: string };
type DocketRow = { id: string; project_id: string; base_commit: string | null };

function nodeAndGoal(nodeId: unknown): { node: NodeRow; docket: DocketRow } {
  if (typeof nodeId !== 'string' || !nodeId || nodeId.length > 200) throw new Error('Choose a verify task.');
  const node = db().prepare('SELECT id, docket_id, kind, title FROM work_nodes WHERE id = ?').get(nodeId) as NodeRow | undefined;
  if (!node) throw new Error('Goal task not found.');
  if (node.kind !== 'verify') throw new Error('A regression proof belongs to a goal\'s verify task.');
  const docket = db().prepare('SELECT id, project_id, base_commit FROM work_dockets WHERE id = ?').get(node.docket_id) as DocketRow | undefined;
  if (!docket) throw new Error('Goal not found.');
  return { node, docket };
}

export function proofCommand(nodeId: unknown): { command: string | null; approvedAt: number | null } {
  const { node } = nodeAndGoal(nodeId);
  const row = db().prepare('SELECT command, approved_at FROM regression_proof_commands WHERE node_id = ?').get(node.id) as { command: string; approved_at: number } | undefined;
  return { command: row?.command ?? null, approvedAt: row?.approved_at ?? null };
}

/** Stores the command with no question. Only the consent wrapper below and the smoke suite call it. */
export function saveProofCommand(nodeId: string, raw: unknown): { command: string; approvedAt: number } {
  const { node } = nodeAndGoal(nodeId);
  const checked = validateProofCommand(raw);
  if (!checked.ok) throw new Error(checked.reason);
  const at = Date.now();
  db().prepare(`INSERT INTO regression_proof_commands (node_id, command, approved_at) VALUES (?,?,?)
    ON CONFLICT(node_id) DO UPDATE SET command = excluded.command, approved_at = excluded.approved_at`).run(node.id, checked.command, at);
  return { command: checked.command, approvedAt: at };
}

export async function saveProofCommandWithConsent(win: BrowserWindow | null, nodeId: unknown, raw: unknown): Promise<{ command: string; approvedAt: number }> {
  const { node, docket } = nodeAndGoal(nodeId);
  const checked = validateProofCommand(raw);
  if (!checked.ok) throw new Error(checked.reason);
  const stored = proofCommand(node.id).command;
  if (stored === checked.command) return { command: stored, approvedAt: proofCommand(node.id).approvedAt ?? Date.now() };
  const project = projectById(docket.project_id);
  if (!project) throw new Error('Project not found.');
  if (!win || win.isDestroyed()) throw new Error('Saving a regression proof command needs the Wanigan window open to confirm it.');
  const answer = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Cancel', 'Save this command'],
    defaultId: 0,
    cancelId: 0,
    title: 'Save a regression proof command?',
    message: `Run this test command for “${node.title}”?`,
    detail:
      `Wanigan runs it through your login shell twice for each proof: once in a scratch checkout of the goal's base commit, made in Wanigan's data directory and removed afterwards, and once in ${project.name}'s implementation tree.\n\n`
      + `    ${checked.command}\n\n`
      + 'This is stored, not run once: pressing "Run regression proof" runs it again without asking. Save only what you would type here yourself.',
  });
  if (answer.response !== 1) throw new Error('Cancelled. The command was not saved, so no regression proof can run it.');
  return saveProofCommand(node.id, checked.command);
}

function scratchParent(): string {
  const dir = path.join(app.getPath('userData'), 'proof-worktrees');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

async function runAt(command: string, cwd: string, commit: string | null): Promise<ProofRun> {
  const result = await runCommand(command, cwd);
  return { commit, exitCode: result.exitCode, durationMs: result.durationMs, outputTail: outputTail(result.output), notRun: null };
}

export async function runRegressionProof(nodeId: unknown): Promise<RegressionProofRecord> {
  const { node, docket } = nodeAndGoal(nodeId);
  const project = projectById(docket.project_id);
  if (!project) throw new Error('Project not found.');
  const command = proofCommand(node.id).command;
  if (!command) throw new Error('Name the test command first; it is saved with a confirmation before it can run.');

  const tree = verificationTreeFor(node.id);
  if (tree.kind === 'gone') {
    throw new Error(`The worktree “${tree.fromTitle}” produced is no longer on disk, so there is no head to run the proof at.`);
  }
  const headDir = tree.kind === 'found' ? tree.path : project.path;
  const repoRoot = await repoRootFor(headDir);
  if (!repoRoot) throw new Error(`${headDir} is not a git repository, so there is no base commit to check out.`);
  const headCommit = await head(headDir);

  let before: ProofRun;
  let linked: string[] = [];
  const base = docket.base_commit && /^[0-9a-f]{7,64}$/i.test(docket.base_commit) ? docket.base_commit : null;
  if (!base) {
    before = { commit: null, exitCode: null, durationMs: 0, outputTail: '', notRun: 'the goal recorded no base commit when it was created, so there is nothing to run before' };
  } else {
    const scratch = path.join(scratchParent(), `proof-${randomUUID().slice(0, 12)}`);
    const add = await runGit(repoRoot, ['worktree', 'add', '--detach', scratch, base], { timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024 });
    if (!add.ok) {
      before = { commit: base, exitCode: null, durationMs: 0, outputTail: '', notRun: `the scratch checkout of ${base.slice(0, 8)} could not be created (${add.err.split('\n').pop() || 'git refused'})` };
    } else {
      try {
        linked = (await linkIgnoredDeps(repoRoot, scratch)).map((l) => l.path);
        before = await runAt(command, scratch, base);
      } finally {
        const removed = await runGit(repoRoot, ['worktree', 'remove', '--force', scratch], { timeout: 5 * 60_000 });
        if (!removed.ok) { try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* reported by prune below */ } }
        await runGit(repoRoot, ['worktree', 'prune'], { timeout: 60_000 });
      }
    }
  }
  const after = await runAt(command, headDir, headCommit);
  const { verdict, because } = classifyProof(before, after);
  const createdAt = Date.now();
  const id = `proof_${randomUUID().slice(0, 12)}`;
  const status = verdict === 'proved' ? 'passed' : verdict === 'still-failing' ? 'failed' : 'recorded';
  // The summary crosses to a paired phone, so it names the verdict and exit
  // codes and never a path or the command's output; those stay in detail_json.
  const summary = `Regression proof: ${PROOF_VERDICT_LABEL[verdict]}.`;
  db().prepare('INSERT INTO work_proofs (id,docket_id,node_id,kind,status,summary,detail_json,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, docket.id, node.id, 'regression', status, summary, JSON.stringify({ command, verdict, because, before, after, linked, headDir }), createdAt);
  db().prepare('UPDATE work_dockets SET updated_at=? WHERE id=?').run(createdAt, docket.id);
  return { id, nodeId: node.id, command, verdict, label: PROOF_VERDICT_LABEL[verdict], because, before, after, linked, createdAt };
}

export function latestRegressionProof(nodeId: unknown): RegressionProofRecord | null {
  const { node } = nodeAndGoal(nodeId);
  const row = db().prepare("SELECT id, detail_json, created_at FROM work_proofs WHERE node_id = ? AND kind = 'regression' ORDER BY created_at DESC, rowid DESC LIMIT 1")
    .get(node.id) as { id: string; detail_json: string; created_at: number } | undefined;
  if (!row) return null;
  try {
    const d = JSON.parse(row.detail_json) as { command: string; verdict: ProofVerdict; because: string; before: ProofRun; after: ProofRun; linked?: string[] };
    return { id: row.id, nodeId: node.id, command: d.command, verdict: d.verdict, label: PROOF_VERDICT_LABEL[d.verdict] ?? d.verdict, because: d.because,
      before: d.before, after: d.after, linked: d.linked ?? [], createdAt: row.created_at };
  } catch { return null; }
}
