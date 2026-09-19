import { app } from 'electron';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { db } from './db';
import * as control from './control';
import * as git from './git';
import * as review from './review';
import { checkoutSnapshot } from './review-checkout';
import { assistedByPreview } from './assisted-by';
import { commitChecked } from './guarded-git';
import { scanFor } from './secret-scan';
import { projectById } from './store';
import { listSessions } from './sessions';
import { halted, HaltedError, registerHaltStopper } from './halt';
import { hostPlatform, killProcessTree } from './platform';
import { processStartProbe, shellCommand } from '../shared/platform';
import type { DocketDetail } from '../shared/types';
import type {
  RelayDeliveryAttempt, RelayDeliveryKind, RelayDeliveryPreview, RelayDeliveryRead,
  RelayDeliveryStage, RelayDeployConfig,
} from '../shared/relay-delivery';

const DEFAULT_TIMEOUT = 10 * 60_000;
const OUTPUT_LIMIT = 128 * 1024;
const PREVIEW_TTL = 5 * 60_000;
type Proof = { ordinal: number; id: string; status: string; created_at: number; detail_json: string };
type Binding = { approval: string; fingerprint: string; runs: string[]; recipe: string; tree: string };
type Token = { docketId: string; preview: RelayDeliveryPreview; binding: Binding; config: string; commitReceipt: string | null };
type AttemptRow = { id: string; docket_id: string; kind: RelayDeliveryKind; status: RelayDeliveryAttempt['status']; checkout: string; owner_pid: number; owner_start: number | null; attempt_json: string; binding_json: string };
const tokens = new Map<string, Token>();
const active = new Map<string, { docketId: string; kind: RelayDeliveryKind; child: ChildProcess | null; reason: string | null; stop: (reason: string) => void }>();

/** Schema belongs to Relay; a historical goal is never silently given delivery actions. */
export function migrateDelivery(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS relay_delivery (docket_id TEXT PRIMARY KEY REFERENCES work_dockets(id) ON DELETE CASCADE, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS relay_deploy_config (project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE, command TEXT NOT NULL, timeout_ms INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS relay_delivery_attempts (
      id TEXT PRIMARY KEY, docket_id TEXT NOT NULL REFERENCES relay_delivery(docket_id) ON DELETE CASCADE,
      kind TEXT NOT NULL, status TEXT NOT NULL, checkout TEXT NOT NULL, owner_pid INTEGER NOT NULL,
      attempt_json TEXT NOT NULL, binding_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS relay_delivery_attempts_docket ON relay_delivery_attempts(docket_id);
    CREATE UNIQUE INDEX IF NOT EXISTS relay_delivery_running_checkout ON relay_delivery_attempts(checkout) WHERE status='running';
    CREATE UNIQUE INDEX IF NOT EXISTS relay_delivery_running_docket ON relay_delivery_attempts(docket_id) WHERE status='running';
  `);
  const columns = d.prepare('PRAGMA table_info(relay_delivery_attempts)').all() as { name: string }[];
  if (!columns.some(column => column.name === 'owner_start')) d.exec('ALTER TABLE relay_delivery_attempts ADD COLUMN owner_start INTEGER');
}

function text(value: unknown, label: string, limit = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || value.includes('\0')) throw new Error(`${label} must be nonempty text of at most ${limit} characters.`);
  return value.trim();
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Delivery options must be an object.');
  return value as Record<string, unknown>;
}
function relayDocket(value: unknown, requireEnabled = true): DocketDetail {
  const id = text(value, 'Relay');
  const row = db().prepare('SELECT relay FROM work_dockets WHERE id=?').get(id) as { relay: number } | undefined;
  if (row?.relay !== 1) throw new Error('Delivery is available only for a recorded Relay.');
  if (requireEnabled && !db().prepare('SELECT docket_id FROM relay_delivery WHERE docket_id=?').get(id)) throw new Error('Add Git commit and Deploy to this existing Relay first.');
  return control.docket(id);
}
function configFor(projectId: string): RelayDeployConfig {
  const row = db().prepare('SELECT command,timeout_ms,updated_at FROM relay_deploy_config WHERE project_id=?').get(projectId) as { command: string; timeout_ms: number; updated_at: number } | undefined;
  return row ? { command: row.command, timeoutMs: row.timeout_ms, updatedAt: row.updated_at } : { command: '', timeoutMs: DEFAULT_TIMEOUT, updatedAt: null };
}
export function enableDelivery(docketId: unknown): RelayDeliveryRead {
  const docket = relayDocket(docketId, false);
  db().prepare('INSERT OR IGNORE INTO relay_delivery (docket_id,created_at) VALUES (?,?)').run(docket.id, Date.now());
  return readDelivery(docket.id)!;
}
export function saveDeployConfig(docketId: unknown, input: unknown): RelayDeliveryRead {
  const docket = relayDocket(docketId);
  const body = record(input);
  if (typeof body.command !== 'string' || body.command.length > 4_000 || body.command.includes('\0')) throw new Error('Deploy command must be text of at most 4,000 characters.');
  if (typeof body.timeoutMs !== 'number' || !Number.isInteger(body.timeoutMs) || body.timeoutMs < 1_000 || body.timeoutMs > 60 * 60_000) throw new Error('Deploy timeout must be between one second and one hour.');
  db().prepare(`INSERT INTO relay_deploy_config (project_id,command,timeout_ms,updated_at) VALUES (?,?,?,?)
    ON CONFLICT(project_id) DO UPDATE SET command=excluded.command,timeout_ms=excluded.timeout_ms,updated_at=excluded.updated_at`)
    .run(docket.projectId, body.command.trim(), body.timeoutMs, Date.now());
  return readDelivery(docket.id)!;
}
/**
 * Revalidate work after a failed delivery changed the index or the checkout.
 * Acceptance stays Control's decision: Relay only withdraws that acceptance
 * and reopens its existing verification/review nodes through Control's normal
 * retry bookkeeping. No implementation hand-back or agent launch occurs.
 */
export async function reopenDeliveryReview(docketId: unknown): Promise<RelayDeliveryRead> {
  const docket = relayDocket(docketId);
  const checkout = await checkoutFor(docket);
  const before = JSON.stringify(docket.nodes);
  recoverDelivery();
  db().transaction(() => {
    const current = relayDocket(docket.id);
    if (current.status !== 'accepted' || JSON.stringify(current.nodes) !== before) throw new Error('Only the unchanged accepted Relay can reopen its delivery review. Refresh the Relay first.');
    const delivery = readDelivery(docket.id)!;
    if (delivery.commit.receipt) throw new Error('This Relay already recorded its commit. Start a new Relay for further changes.');
    if (db().prepare("SELECT id FROM relay_delivery_attempts WHERE status='running' AND (docket_id=? OR checkout=?) LIMIT 1").get(docket.id, checkout)) {
      throw new Error('Wait for the current delivery action to finish before reopening verification.');
    }
    const reviews = current.nodes.filter(node => node.kind === 'review');
    const verifies = current.nodes.filter(node => node.kind === 'verify');
    if (reviews.length !== 1 || reviews[0].status !== 'completed' || !verifies.length || verifies.some(node => node.status !== 'completed')) {
      throw new Error('Verification and human review must be completed before delivery can reopen them.');
    }
    const nodes = [...verifies, reviews[0]];
    const sessions = listSessions().filter(session => session.status !== 'exited');
    const live = new Set(sessions.map(session => session.id));
    const checkoutInUse = sessions.some(session => {
      try { return realpathSync(session.worktree ?? session.projectPath) === checkout; } catch { return false; }
    });
    if (checkoutInUse || current.nodes.some(node => node.status === 'running' || (node.sessionId !== null && live.has(node.sessionId)) || control.gateRunning(node.id))) {
      throw new Error('Stop live Relay work and wait for running checks before reopening verification.');
    }
    const decision = db().prepare("SELECT id,detail_json FROM work_proofs WHERE docket_id=? AND node_id=? AND kind='decision' ORDER BY created_at DESC,rowid DESC LIMIT 1")
      .get(docket.id, reviews[0].id) as { id: string; detail_json: string } | undefined;
    if (!decision || (JSON.parse(decision.detail_json) as { decision?: unknown }).decision !== 'approve') throw new Error('The latest human decision is not an approval. Continue from the current review state.');
    control.setAutopilot(docket.id, { enabled: false });
    const fail = db().prepare("UPDATE work_nodes SET status='failed' WHERE id=? AND docket_id=? AND status='completed'");
    for (const node of nodes) fail.run(node.id, docket.id);
    for (const node of nodes) control.retryNode(node.id);
    db().prepare(`INSERT INTO work_proofs (id,docket_id,node_id,kind,status,summary,detail_json,created_at)
      VALUES (?,?,?,'review','recorded',?,?,?)`).run(randomUUID(), docket.id, reviews[0].id,
      'Delivery review reopened by the operator. Verification and human approval must be repeated; autopilot is off. No agent was launched.',
      JSON.stringify({ deliveryRecovery: true, priorDecisionId: decision.id, reopenedNodeIds: nodes.map(node => node.id) }), Date.now());
  }).immediate();
  for (const [key, token] of tokens) if (token.docketId === docket.id) tokens.delete(key);
  return readDelivery(docket.id)!;
}
function finish(id: string, changes: Partial<RelayDeliveryAttempt>, binding?: Binding): void {
  const row = db().prepare("SELECT * FROM relay_delivery_attempts WHERE id=? AND status='running'").get(id) as AttemptRow | undefined;
  if (!row) return;
  const attempt = { ...JSON.parse(row.attempt_json) as RelayDeliveryAttempt, ...changes, endedAt: Date.now() };
  db().prepare("UPDATE relay_delivery_attempts SET status=?,attempt_json=?,binding_json=? WHERE id=? AND status='running'")
    .run(attempt.status, JSON.stringify(attempt), binding ? JSON.stringify(binding) : row.binding_json, id);
}
/** A crashed owner's receipt is historical uncertainty, never a request to repeat a command. */
function processStart(pid: number): number | null {
  const probe = processStartProbe([pid], hostPlatform());
  if (!probe) return null;
  try {
    const output = execFileSync(probe.file, probe.args, { encoding: 'utf8', timeout: 2_000, maxBuffer: 8_192, windowsHide: true, env: { ...process.env, LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'ignore'] });
    const match = /^\s*\d+\s+(.+)$/m.exec(output);
    const at = match ? Date.parse(match[1].replace(/\s+/g, ' ').trim()) : NaN;
    return Number.isFinite(at) ? at : null;
  } catch { return null; }
}
export function recoverDelivery(): number {
  const rows = db().prepare("SELECT * FROM relay_delivery_attempts WHERE status='running'").all() as AttemptRow[];
  let count = 0;
  for (const row of rows) {
    if (active.has(row.id)) continue;
    if (row.owner_pid !== process.pid) {
      try {
        process.kill(row.owner_pid, 0);
        const started = row.owner_start === null ? null : processStart(row.owner_pid);
        if (started === null || started === row.owner_start) continue;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue; }
    }
    finish(row.id, { status: 'interrupted', error: 'Wanigan stopped before recording a result. Inspect the checkout or deployment before retrying; nothing was restarted automatically.' });
    count++;
  }
  return count;
}
function stage(kind: RelayDeliveryKind, attempts: RelayDeliveryAttempt[]): RelayDeliveryStage {
  const own = attempts.filter(value => value.kind === kind);
  const latest = own[0] ?? null;
  return { kind, status: latest?.status ?? 'pending', detail: latest?.error ?? (latest?.status === 'completed'
    ? kind === 'commit' ? `Recorded commit ${latest.commitHash}. Nothing was pushed.` : 'Deploy command exited 0. Check the target service to confirm its health.'
    : kind === 'commit' ? 'Available after current checks and human approval.' : 'Available after Git commit and a saved deploy command.'), attempts: own,
  receipt: own.find(value => value.status === 'completed') ?? null };
}
export function readDelivery(docketId: unknown): RelayDeliveryRead | null {
  const docket = relayDocket(docketId, false);
  if (!db().prepare('SELECT docket_id FROM relay_delivery WHERE docket_id=?').get(docket.id)) return null;
  recoverDelivery();
  const rows = db().prepare('SELECT attempt_json FROM relay_delivery_attempts WHERE docket_id=? ORDER BY rowid DESC').all(docket.id) as { attempt_json: string }[];
  const attempts = rows.map(row => JSON.parse(row.attempt_json) as RelayDeliveryAttempt);
  return { commit: stage('commit', attempts), deploy: stage('deploy', attempts), config: configFor(docket.projectId) };
}
function haltCheck(): void {
  if (halted()) throw new HaltedError('start Relay delivery');
  const redirects = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE'];
  if (Object.keys(process.env).some(key => key.startsWith('GIT_CONFIG') || redirects.includes(key))) {
    throw new Error('Git environment overrides prevent Relay from proving which checkout it would change. Restart Wanigan without Git directory, index, object, or config overrides.');
  }
}
function real(value: string): string {
  try { return realpathSync(value); } catch { throw new Error('The recorded implementation checkout is unavailable. Restore it before delivery.'); }
}
function approvalIdentity(docket: DocketDetail): { identity: string; proofs: Proof[]; runs: string[]; tree: string } {
  if (docket.status !== 'accepted') throw new Error('Approve the current Relay review before delivery.');
  const reviews = docket.nodes.filter(node => node.kind === 'review');
  if (reviews.length !== 1 || reviews[0].status !== 'completed') throw new Error('Delivery requires one completed human review.');
  const decision = db().prepare("SELECT rowid AS ordinal,id,status,created_at,detail_json FROM work_proofs WHERE docket_id=? AND node_id=? AND kind='decision' ORDER BY rowid DESC LIMIT 1")
    .get(docket.id, reviews[0].id) as Proof | undefined;
  if (!decision || (JSON.parse(decision.detail_json) as { decision?: unknown }).decision !== 'approve') throw new Error('A recorded human approval is required before delivery.');
  const verifies = docket.nodes.filter(node => node.kind === 'verify');
  if (!verifies.length) throw new Error('Delivery needs recorded verification.');
  const proofs = verifies.map(node => {
    const proof = db().prepare("SELECT rowid AS ordinal,id,status,created_at,detail_json FROM work_proofs WHERE docket_id=? AND node_id=? AND kind='test' AND created_at>=? ORDER BY rowid DESC LIMIT 1")
      .get(docket.id, node.id, node.reopenedAt ?? 0) as Proof | undefined;
    if (node.status !== 'completed' || !proof || proof.status !== 'passed' || proof.ordinal > decision.ordinal) throw new Error('Verification changed after approval or has no passed proof. Rerun checks as needed and record a new human approval.');
    return proof;
  });
  const runs = proofs.map(proof => text((JSON.parse(proof.detail_json) as { reviewRunId?: unknown }).reviewRunId, 'Verification run'));
  const trees = [...new Set(proofs.map(proof => (JSON.parse(proof.detail_json) as { tree?: unknown }).tree))];
  if (trees.length !== 1 || typeof trees[0] !== 'string' || !/^[a-f0-9]{40,64}$/.test(trees[0])) throw new Error('The approved verification has no single recorded Git tree. Run checks and review again before delivery.');
  return { identity: JSON.stringify({ projectId: docket.projectId, nodes: docket.nodes.map(({ id, kind, status, dependsOn, worktree, reopenedAt }) => ({ id, kind, status, dependsOn, worktree, reopenedAt })), decision, proofs }), proofs, runs, tree: trees[0] };
}
async function checkoutFor(docket: DocketDetail): Promise<string> {
  const project = projectById(docket.projectId);
  if (!project) throw new Error('The Relay project no longer exists.');
  await git.acting(project.path, 'deliver changes');
  const implementers = docket.nodes.filter(node => node.kind === 'implement');
  if (!implementers.length || implementers.some(node => node.status !== 'completed')) throw new Error('Complete the implementation before delivery.');
  const roots = [...new Set(implementers.map(node => real(node.worktree ?? project.path)))];
  if (roots.length !== 1) throw new Error('Delivery requires one implementation checkout. Integrate and review branches together first.');
  const root = roots[0];
  await git.acting(root, 'deliver changes');
  const common = async (cwd: string) => {
    const result = await git.runGit(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'], { timeout: 8_000 });
    if (!result.ok) throw new Error('Could not identify the implementation repository.');
    return real(result.out.trim());
  };
  if (await common(root) !== await common(project.path)) throw new Error('The recorded implementation checkout belongs to another repository.');
  const live = listSessions().some(session => {
    if (session.status === 'exited') return false;
    const cwd = session.worktree ?? projectById(session.projectId)?.path;
    if (!cwd) return false;
    try { return realpathSync(cwd) === root; } catch { return false; }
  });
  if (live) throw new Error('Stop the live agent sessions in this implementation checkout before delivery.');
  const status = await git.status(root);
  if (status.operation || status.conflicted.length) throw new Error('Finish the Git operation and resolve conflicts before delivery.');
  return root;
}
async function checked(docketId: string, kind: RelayDeliveryKind): Promise<{ docket: DocketDetail; checkout: string; head: string; files: string[]; binding: Binding; receipt: RelayDeliveryAttempt | null }> {
  haltCheck();
  const docket = relayDocket(docketId);
  const approval = approvalIdentity(docket);
  const checkout = await checkoutFor(docket);
  const snapshot = await checkoutSnapshot(checkout);
  if (!snapshot.fingerprint || !snapshot.head) throw new Error(snapshot.unavailableReason ?? 'Delivery requires a recorded Git HEAD.');
  const recipe = JSON.stringify(review.recipe(docket.projectId));
  const binding: Binding = { approval: approval.identity, fingerprint: snapshot.fingerprint, runs: approval.runs, recipe, tree: approval.tree };
  const delivery = readDelivery(docketId)!;
  const receipt = delivery.commit.receipt;
  const status = await git.status(checkout);
  if (kind === 'commit') {
    if (delivery.commit.receipt) throw new Error('This Relay already recorded its commit.');
    for (const run of approval.runs) if (!await review.isCurrentPass(run, docket.projectId, checkout)) throw new Error('The approved verification is stale. Rerun verification and human review for the current checkout and commands.');
  } else {
    if (!receipt?.commitHash) throw new Error('Record Git commit before deploying.');
    const row = db().prepare('SELECT binding_json FROM relay_delivery_attempts WHERE id=?').get(receipt.id) as { binding_json: string };
    const committed = JSON.parse(row.binding_json) as Binding;
    if (!status.clean || snapshot.head !== receipt.commitHash || snapshot.fingerprint !== committed.fingerprint || checkout !== receipt.checkout) throw new Error('The committed checkout changed. Restore the recorded clean commit before deployment.');
    if (binding.approval !== committed.approval || binding.recipe !== committed.recipe) throw new Error('The human approval or verification commands changed after commit. This delivery receipt no longer authorizes deployment.');
    if (!delivery.config.command) throw new Error('Save a deploy command for this project first.');
    if (delivery.deploy.receipt) throw new Error('This Relay already recorded a successful deploy command.');
  }
  for (const run of approval.runs) review.assertPassNotSuperseded(run, docket.projectId, checkout);
  if (approvalIdentity(relayDocket(docketId)).identity !== approval.identity || JSON.stringify(review.recipe(docket.projectId)) !== recipe) throw new Error('The review changed during delivery validation. Refresh and preview again.');
  const after = await checkoutSnapshot(checkout);
  if (after.fingerprint !== snapshot.fingerprint) throw new Error('The implementation checkout changed while delivery was being prepared. Preview again.');
  if (approvalIdentity(relayDocket(docketId)).identity !== approval.identity || JSON.stringify(review.recipe(docket.projectId)) !== recipe) throw new Error('The review changed during the checkout comparison. Refresh and preview again.');
  for (const run of approval.runs) review.assertPassNotSuperseded(run, docket.projectId, checkout);
  return { docket, checkout, head: snapshot.head, files: [...new Set([...status.staged, ...status.unstaged, ...status.untracked].map(file => file.path))].sort(), binding, receipt };
}
export async function previewDelivery(docketId: unknown, inputKind: unknown): Promise<RelayDeliveryPreview> {
  const id = text(docketId, 'Relay');
  if (inputKind !== 'commit' && inputKind !== 'deploy') throw new Error('Choose Git commit or Deploy.');
  const value = await checked(id, inputKind);
  const config = configFor(value.docket.projectId);
  const trailers = inputKind === 'commit' && value.files.length ? (await assistedByPreview(value.checkout)).trailers : [];
  const preview: RelayDeliveryPreview = { kind: inputKind, token: randomUUID(), expiresAt: Date.now() + PREVIEW_TTL,
    checkout: value.checkout, head: value.head, files: value.files, message: value.docket.title, trailers,
    command: inputKind === 'deploy' ? config.command : null, timeoutMs: config.timeoutMs, existingCommit: value.files.length === 0 };
  for (const [key, old] of tokens) if (old.preview.expiresAt < Date.now()) tokens.delete(key);
  if (tokens.size >= 100) tokens.delete(tokens.keys().next().value!);
  tokens.set(preview.token, { docketId: id, preview, binding: value.binding, config: JSON.stringify(config), commitReceipt: value.receipt?.id ?? null });
  return preview;
}
function consume(docketId: unknown, input: unknown, kind: RelayDeliveryKind): { token: Token; body: Record<string, unknown> } {
  const id = text(docketId, 'Relay'); const body = record(input); const key = text(body.token, 'Preview token');
  const token = tokens.get(key); tokens.delete(key);
  if (!token || token.docketId !== id || token.preview.kind !== kind || token.preview.expiresAt < Date.now()) throw new Error('This delivery preview expired or was already used. Preview again before continuing.');
  return { token, body };
}
async function validateToken(token: Token): Promise<void> {
  const current = await checked(token.docketId, token.preview.kind);
  if (JSON.stringify(current.binding) !== JSON.stringify(token.binding) || current.checkout !== token.preview.checkout || current.head !== token.preview.head
    || JSON.stringify(current.files) !== JSON.stringify(token.preview.files) || JSON.stringify(configFor(current.docket.projectId)) !== token.config
    || (current.receipt?.id ?? null) !== token.commitReceipt) throw new Error('The checkout, approval, commit, or deploy settings changed after preview. Preview again; nothing was started.');
  haltCheck();
}
function begin(token: Token, message: string | null): RelayDeliveryAttempt {
  recoverDelivery(); haltCheck();
  const attempt: RelayDeliveryAttempt = { id: randomUUID(), kind: token.preview.kind, status: 'running', startedAt: Date.now(), endedAt: null,
    checkout: token.preview.checkout, head: token.preview.head, files: token.preview.files, trailers: token.preview.trailers,
    command: token.preview.command, commitHash: null, message, exitCode: null, output: '', error: null };
  try {
    db().prepare('INSERT INTO relay_delivery_attempts (id,docket_id,kind,status,checkout,owner_pid,owner_start,attempt_json,binding_json) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(attempt.id, token.docketId, attempt.kind, 'running', attempt.checkout, process.pid, processStart(process.pid), JSON.stringify(attempt), JSON.stringify(token.binding));
  } catch (error) {
    if ((error as { code?: string }).code?.startsWith('SQLITE_CONSTRAINT')) throw new Error('Another delivery action is already running for this Relay or checkout. Wait for it to finish.');
    throw error;
  }
  active.set(attempt.id, { docketId: token.docketId, kind: attempt.kind, child: null, reason: null, stop(reason) { this.reason = reason; if (this.child) stopProcess(this.child); } });
  return attempt;
}
function stopProcess(child: ChildProcess): void {
  // A shell can exit while its descendants retain stdout. The group still
  // belongs to this run even after child.exitCode is set.
  if (hostPlatform() !== 'win32' && child.pid) {
    try { process.kill(-child.pid, 'SIGKILL'); return; } catch { /* fall through to the child */ }
  }
  killProcessTree(child, 'SIGKILL');
}
function actionCheck(id: string): void {
  haltCheck();
  const reason = active.get(id)?.reason;
  if (reason) throw new Error(reason);
}
function authorizationCheck(token: Token, id: string): void {
  actionCheck(id);
  const docket = relayDocket(token.docketId);
  if (approvalIdentity(docket).identity !== token.binding.approval || JSON.stringify(review.recipe(docket.projectId)) !== token.binding.recipe
    || JSON.stringify(configFor(docket.projectId)) !== token.config) throw new Error('The review or delivery settings changed before delivery finished. Refresh and review the evidence before retrying.');
  for (const run of token.binding.runs) review.assertPassNotSuperseded(run, docket.projectId, token.preview.checkout);
  if (listSessions().some(session => {
    if (session.status === 'exited') return false;
    try { return realpathSync(session.worktree ?? session.projectPath) === token.preview.checkout; } catch { return false; }
  })) throw new Error('A live agent is using the implementation checkout. Stop it before delivery.');
}
export async function commitDelivery(docketId: unknown, input: unknown): Promise<RelayDeliveryRead> {
  const { token, body } = consume(docketId, input, 'commit');
  const message = token.preview.existingCommit ? null : text(body.message, 'Commit message', 10_000);
  const attempt = begin(token, message);
  let staged = false;
  try {
    await validateToken(token);
    authorizationCheck(token, attempt.id);
    if (!token.preview.existingCommit) {
      const result = await git.runGit(attempt.checkout, ['--literal-pathspecs', 'add', '--', ...attempt.files], { timeout: 30_000, maxBuffer: OUTPUT_LIMIT });
      if (!result.ok) throw new Error(`Could not stage the previewed files: ${result.err}`);
      staged = true;
      const written = await git.runGit(attempt.checkout, ['write-tree'], { timeout: 8_000 });
      if (!written.ok || written.out.trim() !== token.binding.tree) throw new Error('Staged content differs from the approved Git tree. Nothing was committed.');
      const scan = await scanFor(attempt.checkout, { action: 'commit', all: false });
      if (scan.needsAcknowledgement) throw new Error('The secret scan needs attention. Inspect and resolve its findings in Changes. Nothing was committed.');
      authorizationCheck(token, attempt.id);
    }
    const output = token.preview.existingCommit ? 'Recorded the existing approved commit. Nothing was pushed.'
      : await commitChecked(attempt.checkout, message!, { all: false, trailers: token.preview.trailers, acknowledge: null });
    const snapshot = await checkoutSnapshot(attempt.checkout);
    const status = await git.status(attempt.checkout);
    if (!snapshot.fingerprint || !snapshot.head || !status.clean) throw new Error('Git returned, but the resulting checkout is not a verified clean commit. Inspect Changes before retrying.');
    if (!token.preview.existingCommit && snapshot.head === attempt.head) throw new Error('Git did not record a new commit. Inspect Changes before retrying.');
    const committedTree = await git.runGit(attempt.checkout, ['rev-parse', 'HEAD^{tree}'], { timeout: 8_000 });
    if (!committedTree.ok || committedTree.out.trim() !== token.binding.tree) throw new Error('The resulting commit contains a different tree from the approved work. Inspect Git history before continuing.');
    if (!token.preview.existingCommit) {
      const parent = await git.runGit(attempt.checkout, ['rev-parse', 'HEAD^'], { timeout: 8_000 });
      if (!parent.ok || parent.out.trim() !== attempt.head) throw new Error('The resulting commit has an unexpected parent. Inspect Git history before continuing.');
    }
    authorizationCheck(token, attempt.id);
    const interrupted = active.get(attempt.id)?.reason;
    finish(attempt.id, { status: interrupted ? 'interrupted' : 'completed', commitHash: snapshot.head, exitCode: 0, output: output.slice(0, OUTPUT_LIMIT), error: interrupted ?? null }, { ...token.binding, fingerprint: snapshot.fingerprint });
  } catch (error) {
    finish(attempt.id, { status: active.get(attempt.id)?.reason ? 'interrupted' : 'failed', error: (error instanceof Error ? error.message : String(error))
      + (staged ? ' Files may remain staged; inspect Changes, rerun verification and approve again before retrying.' : '') });
  } finally { active.delete(attempt.id); }
  return readDelivery(token.docketId)!;
}
export async function deployDelivery(docketId: unknown, input: unknown): Promise<RelayDeliveryRead> {
  const { token } = consume(docketId, input, 'deploy');
  const attempt = begin(token, null);
  try {
    await validateToken(token);
    authorizationCheck(token, attempt.id);
    const processResult = new Promise<void>((resolve) => {
      const command = shellCommand(token.preview.command!, hostPlatform(), process.env);
      const child = spawn(command.file, command.args, { cwd: attempt.checkout, env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' }, detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const running = active.get(attempt.id)!; running.child = child;
      let output = ''; let truncated = false; let settled = false;
      let forceSettle: ReturnType<typeof setTimeout> | null = null;
      const append = (chunk: Buffer) => {
        const value = chunk.toString(); const remaining = Math.max(0, OUTPUT_LIMIT - output.length);
        output += value.slice(0, remaining); if (value.length > remaining) truncated = true;
      };
      child.stdout?.on('data', append); child.stderr?.on('data', append);
      const timeout = setTimeout(() => running.stop(`Deploy command exceeded its ${Math.round(token.preview.timeoutMs / 1000)} second timeout.`), token.preview.timeoutMs);
      const done = (code: number | null, error: string | null) => {
        if (settled) return; settled = true; clearTimeout(timeout);
        if (forceSettle) clearTimeout(forceSettle);
        finish(attempt.id, { status: running.reason ? 'interrupted' : code === 0 && !error ? 'completed' : 'failed', exitCode: code,
          commitHash: attempt.head, output: output + (truncated ? '\n[Output truncated at 128 KiB.]' : ''), error: running.reason ?? error ?? (code === 0 ? null : `Deploy command exited ${code === null ? 'without an exit code' : code}.`) });
        resolve();
      };
      running.stop = (reason) => {
        running.reason = reason; stopProcess(child);
        if (!forceSettle) forceSettle = setTimeout(() => { child.stdout?.destroy(); child.stderr?.destroy(); done(null, 'The process group was signaled, but no final exit result arrived.'); }, 1_000);
      };
      child.once('error', error => done(null, error.message));
      child.once('close', (code, signal) => done(code, signal ? `Deploy command ended with ${signal}.` : null));
    });
    void processResult.catch(error => {
      finish(attempt.id, { status: 'failed', error: error instanceof Error ? error.message : String(error) });
    }).finally(() => { active.delete(attempt.id); });
  } catch (error) {
    finish(attempt.id, { status: active.get(attempt.id)?.reason ? 'interrupted' : 'failed', error: error instanceof Error ? error.message : String(error) });
    active.delete(attempt.id);
  }
  return readDelivery(token.docketId)!;
}
export function cancelDeploy(docketId: unknown): RelayDeliveryRead {
  const docket = relayDocket(docketId);
  for (const running of active.values()) if (running.docketId === docket.id && running.kind === 'deploy') running.stop('Deploy command was canceled. Inspect the target before retrying.');
  return readDelivery(docket.id)!;
}
function stopAll(reason: string, quitting = false): number {
  let stopped = 0;
  for (const [id, running] of active) {
    running.stop(reason);
    // Keep the checkout lease until an in-flight Git helper settles. Unlike a
    // deploy process it has no cancellable handle; halt must not claim it died.
    if (quitting) finish(id, { status: 'interrupted', error: reason });
    if (running.kind === 'deploy') stopped++;
  }
  return stopped;
}
registerHaltStopper({ name: 'Relay delivery', stop: () => ({ name: 'Relay delivery', stopped: stopAll('Interrupted by the emergency halt. Inspect the checkout and target before retrying.'), note: 'Deploy process groups signaled. An already running Git command may still finish; inspect its receipt. Nothing restarts automatically.' }) });
app.on('will-quit', () => { stopAll('Wanigan quit during delivery. An in-flight Git command may still finish; inspect the checkout and target before retrying.', true); });
