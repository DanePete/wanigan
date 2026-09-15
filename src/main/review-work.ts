import fs from 'node:fs';
import path from 'node:path';
import { db } from './db';
import { runGit, runGitBuffer } from './git';
import { listSessions, sessionBaseline } from './sessions';
import { assertManagedRoot } from './roots';
import { listCheckpoints } from './checkpoints';
import { mergeWorktree } from './worktrees';
import { projectById } from './store';
import { lastAssistantTurn, transcriptFor } from './transcripts';
import { shellChangedPaths, shellCommands, shellDiffReported } from './shell-results';
import {
  DELETED_HASH, MAX_MARK_NOTE_CHARS, branchAnchor, fileReview, highTierUnapproved, needsReviewLabel, needsReviewVerdict,
  validMarkState, type FileReview, type ReviewFile, type ReviewMark, type TurnState,
} from '../shared/review-marks';
import { ATTRIBUTION_LABEL, EDIT_TOOLS, attributeFiles, relativeToRoot, type Attribution } from '../shared/edit-attribution';
import { fileKind, splitPatchByFile, testAlarms } from '../shared/review-order';
import { tierOf, validateRiskRules, type RiskRule, type RiskTier } from '../shared/risk-tiers';
import { describeDepChange, diffDependencies, isInstallCommand, manifestKind, readManifest } from '../shared/dependencies';
import { addedTextOf, extractClaims, gradeClaims } from '../shared/claims';
import type {
  ClaimsReview, DependencyReview, ManifestReview, MergeCheck, ReviewImageSide, ReviewSummary, ReviewWork, ReviewWorkFile, TurnStat,
} from '../shared/review-work';
/* ── helper sweep · P7 depth ── */
import { markScratch, promotedPaths } from './scratch';
import { scratchReason } from '../shared/scratch-files';
/* ── end helper sweep · P7 depth ── */

/**
 * Reviewing a session's work: the diff against the commit it started from, the
 * operator's per-file marks on it, and what follows from those — "needs
 * review", the dependency list, the test alarms, the risk tiers and the claims
 * in the final message.
 *
 * Every read here is git in the session's own checkout (its worktree when it
 * was isolated, the project otherwise), against the base commit recorded at
 * launch, with argv arrays and the hardened environment git.ts owns. Nothing
 * here writes to the repository. The marks live in Wanigan's database, keyed by
 * the diff they were made on, and a mark is only ever stored against a content
 * hash main computed itself — never one the renderer supplied.
 */

/* ── the target: which checkout, against which commit ───────────────── */

const OBJECT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
/** A diff with more files than this is summarised, not listed in full. */
const MAX_FILES = 2_000;
/** Bytes of patch scanned for alarms, claims and find; the cut is reported. */
const MAX_PATCH_BYTES = 2 * 1024 * 1024;
/** Untracked files larger than this are listed but not read into the patch. */
const MAX_UNTRACKED_READ = 256 * 1024;
/** Untracked files read into the whole patch, each its own `git diff --no-index`; the rest are listed only. */
const MAX_UNTRACKED_PATCHES = 60;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const SUMMARY_TTL_MS = 8_000;

type Target = {
  sessionId: string;
  root: string;
  base: string | null;
  /** Repository-relative paths already dirty at launch; null when none were recorded. */
  dirty: Set<string> | null;
  /** The checkout's path inside its repository, when it is a subdirectory of one. */
  sub: string | null;
  turn: TurnState;
  projectId: string | null;
  projectPath: string;
  worktree: string | null;
  conversationId: string | null;
  harness: string;
  startedAt: number;
};

type LogRow = {
  project_id: string | null; project_path: string; worktree: string | null; conversation_id: string | null;
  provider_id: string; harness_id: string | null; started_at: number;
};

function validSessionId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new Error('Choose a session to review.');
  return value;
}

/** The turn from the hook record: the later of the last prompt and the last end of turn decides. */
function turnState(sessionId: string, exited: boolean): TurnState {
  if (exited) return 'exited';
  const row = db().prepare(`SELECT event FROM session_events WHERE session_id = ? AND event IN ('UserPromptSubmit','Stop','StopFailure')
    ORDER BY at DESC, id DESC LIMIT 1`).get(sessionId) as { event: string } | undefined;
  return row && row.event !== 'UserPromptSubmit' ? 'turn-ended' : 'working';
}

function harnessOf(harnessId: string | null, providerId: string): string {
  return harnessId?.trim() || (providerId === 'codex' ? 'codex' : providerId === 'claude' || providerId === 'glm' ? 'claude-code' : `provider:${providerId}`);
}

async function targetFor(sessionId: string): Promise<Target> {
  const id = validSessionId(sessionId);
  const live = listSessions().find((s) => s.id === id) ?? null;
  const row = db().prepare('SELECT project_id, project_path, worktree, conversation_id, provider_id, harness_id, started_at FROM session_log WHERE id = ?')
    .get(id) as LogRow | undefined;
  if (!live && !row) throw new Error('Wanigan has no record of that session.');
  const worktree = live?.worktree ?? row?.worktree ?? null;
  const projectPath = live?.projectPath ?? row?.project_path ?? '';
  const root = worktree ?? projectPath;
  const baseline = sessionBaseline(id);
  const base = baseline?.head && OBJECT.test(baseline.head) ? baseline.head : null;
  let sub: string | null = null;
  if (fs.existsSync(root)) {
    const prefix = await runGit(root, ['rev-parse', '--show-prefix'], { timeout: 8_000, maxBuffer: 1024 * 1024 });
    const p = prefix.ok ? prefix.out.trim().replace(/\/$/, '') : '';
    sub = p || null;
  }
  return {
    sessionId: id,
    root,
    base,
    dirty: baseline ? new Set(baseline.dirty) : null,
    sub,
    turn: turnState(id, !live || live.status === 'exited'),
    projectId: live?.projectId ?? row?.project_id ?? null,
    projectPath,
    worktree,
    conversationId: live?.conversationId ?? row?.conversation_id ?? null,
    harness: harnessOf(live?.harnessId ?? row?.harness_id ?? null, live?.providerId ?? row?.provider_id ?? ''),
    startedAt: live?.createdAt ?? row?.started_at ?? 0,
  };
}

/* ── the branch diff ─────────────────────────────────────────────────── */

type BranchRead = { files: ReviewFile[]; unreadable: string | null; truncated: boolean };

function parseNameStatus(out: string): { status: string; path: string; oldPath: string | null }[] {
  const parts = out.split('\0');
  const rows: { status: string; path: string; oldPath: string | null }[] = [];
  for (let i = 0; i < parts.length; i++) {
    const status = parts[i];
    if (!status) continue;
    if (status[0] === 'R' || status[0] === 'C') {
      rows.push({ status: status[0], oldPath: parts[i + 1] ?? null, path: parts[i + 2] ?? '' });
      i += 2;
    } else {
      rows.push({ status: status[0], oldPath: null, path: parts[i + 1] ?? '' });
      i += 1;
    }
  }
  return rows.filter((r) => r.path);
}

function parseNumstat(out: string): Map<string, { added: number | null; removed: number | null }> {
  const parts = out.split('\0');
  const map = new Map<string, { added: number | null; removed: number | null }>();
  for (let i = 0; i < parts.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(parts[i]);
    if (!m) continue;
    const counts = { added: m[1] === '-' ? null : Number(m[1]), removed: m[2] === '-' ? null : Number(m[2]) };
    if (m[3] === '') { map.set(parts[i + 2] ?? '', counts); i += 2; }
    else map.set(m[3], counts);
  }
  return map;
}

function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0);
}

/** A working-tree file inside the root, never through a symlinked directory. */
function insideRoot(root: string, rel: string): string | null {
  if (typeof rel !== 'string' || !rel || rel.includes('\0') || path.isAbsolute(rel)) return null;
  const abs = path.resolve(root, rel);
  const base = path.resolve(root);
  if (abs !== base && !abs.startsWith(base + path.sep)) return null;
  try {
    const realRoot = fs.realpathSync(base);
    const realParent = fs.realpathSync(path.dirname(abs));
    if (realParent !== realRoot && !realParent.startsWith(realRoot + path.sep)) return null;
    return path.join(realParent, path.basename(abs));
  } catch { return null; }
}

async function hashFiles(root: string, paths: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const CHUNK = 100;
  for (let i = 0; i < paths.length; i += CHUNK) {
    const chunk = paths.slice(i, i + CHUNK);
    const r = await runGit(root, ['hash-object', '--', ...chunk], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    const hashes = r.ok ? r.out.trim().split('\n') : [];
    if (r.ok && hashes.length === chunk.length) {
      chunk.forEach((p, j) => out.set(p, hashes[j]));
      continue;
    }
    // One unhashable path (a directory where a file was, a socket) must not cost
    // its neighbours their hashes; retry singly.
    for (const p of chunk) {
      const one = await runGit(root, ['hash-object', '--', p], { timeout: 10_000, maxBuffer: 1024 * 1024 });
      out.set(p, one.ok && one.out.trim() ? one.out.trim() : `unhashable:${Date.now()}`);
    }
  }
  return out;
}

async function readBranch(t: Target): Promise<BranchRead> {
  if (!t.base) return { files: [], unreadable: null, truncated: false };
  if (!fs.existsSync(t.root)) return { files: [], unreadable: `The checkout at ${t.root} no longer exists.`, truncated: false };
  assertManagedRoot(t.root, 'That session checkout');
  const opts = { timeout: 30_000, maxBuffer: 32 * 1024 * 1024 };
  const [names, nums, untracked] = await Promise.all([
    runGit(t.root, ['diff', '--relative', '--name-status', '-z', '-M', '--no-ext-diff', t.base, '--'], opts),
    runGit(t.root, ['diff', '--relative', '--numstat', '-z', '-M', '--no-ext-diff', t.base, '--'], opts),
    runGit(t.root, ['ls-files', '--others', '--exclude-standard', '-z'], opts),
  ]);
  if (!names.ok) return { files: [], unreadable: names.err.split('\n')[0] || 'git diff failed.', truncated: false };
  const counts = nums.ok ? parseNumstat(nums.out) : new Map();
  const rows = parseNameStatus(names.out);
  const extra = untracked.ok ? untracked.out.split('\0').filter(Boolean) : [];
  const truncated = rows.length + extra.length > MAX_FILES;
  const files: ReviewFile[] = [];
  for (const r of rows.slice(0, MAX_FILES)) {
    const c = counts.get(r.path);
    files.push({ path: r.path, oldPath: r.oldPath, status: r.status, added: c ? c.added : null, removed: c ? c.removed : null,
      binary: c ? c.added === null : false, contentHash: r.status === 'D' ? DELETED_HASH : '' });
  }
  for (const p of extra.slice(0, Math.max(0, MAX_FILES - files.length))) {
    let added: number | null = 0;
    let binary = false;
    const abs = insideRoot(t.root, p);
    try {
      const st = abs ? fs.statSync(abs) : null;
      if (st && st.isFile() && st.size <= MAX_UNTRACKED_READ) {
        const buf = fs.readFileSync(abs as string);
        binary = looksBinary(buf);
        added = binary ? null : buf.toString('utf8').split('\n').length - (buf.length && buf[buf.length - 1] === 10 ? 1 : 0);
      } else if (st && st.isFile()) {
        added = null;
      }
    } catch { added = null; }
    files.push({ path: p, oldPath: null, status: '?', added, removed: binary || added === null ? null : 0, binary, contentHash: '' });
  }
  const hashes = await hashFiles(t.root, files.filter((f) => f.contentHash === '').map((f) => f.path));
  for (const f of files) {
    if (f.contentHash === '') f.contentHash = hashes.get(f.path) ?? 'unhashable';
    if (t.dirty) f.preexisting = t.dirty.has(t.sub ? `${t.sub}/${f.path}` : f.path) || (!!f.oldPath && t.dirty.has(t.sub ? `${t.sub}/${f.oldPath}` : f.oldPath));
  }
  /* ── helper sweep · P7 depth ── scratch files leave every count that reads reviewableFiles. */
  await markScratch(t.root, t.projectId, files);
  return { files, unreadable: null, truncated };
}

/** The whole diff against base, untracked text files included, capped. */
async function readPatch(t: Target, files: readonly ReviewFile[], whitespace: boolean): Promise<{ patch: string; truncated: boolean }> {
  if (!t.base || !fs.existsSync(t.root)) return { patch: '', truncated: false };
  const r = await runGit(t.root, ['diff', '--relative', '-M', '--no-ext-diff', '--no-color', ...(whitespace ? ['-w'] : []), t.base, '--'],
    { timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
  let patch = r.ok ? r.out : '';
  let truncated = !r.ok || patch.length > MAX_PATCH_BYTES;
  if (patch.length > MAX_PATCH_BYTES) patch = patch.slice(0, MAX_PATCH_BYTES);
  let untrackedRead = 0;
  for (const f of files) {
    if (f.status !== '?' || f.binary || f.added === null) continue;
    if (patch.length > MAX_PATCH_BYTES || untrackedRead >= MAX_UNTRACKED_PATCHES) { truncated = true; break; }
    untrackedRead += 1;
    const one = await runGit(t.root, ['diff', '--no-index', '--no-color', '--', '/dev/null', f.path], { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });
    patch += one.out;
  }
  return { patch, truncated };
}

/* ── marks ───────────────────────────────────────────────────────────── */

function marksFor(t: Target): ReviewMark[] {
  if (!t.base) return [];
  const rows = db().prepare('SELECT path, state, note, content_hash, worktree, base_commit, marked_at FROM review_marks WHERE session_id = ? AND worktree = ? AND base_commit = ?')
    .all(t.sessionId, t.root, t.base) as { path: string; state: string; note: string | null; content_hash: string; worktree: string; base_commit: string; marked_at: number }[];
  return rows.filter((r) => validMarkState(r.state)).map((r) => ({
    path: r.path, state: r.state as ReviewMark['state'], note: r.note, contentHash: r.content_hash,
    worktree: r.worktree, baseCommit: r.base_commit, markedAt: r.marked_at,
  }));
}

const summaryCache = new Map<string, { at: number; value: ReviewSummary }>();

export async function setReviewMark(sessionId: unknown, rawPath: unknown, rawState: unknown, rawNote?: unknown): Promise<FileReview> {
  const t = await targetFor(String(sessionId));
  if (!t.base) throw new Error('This session recorded no base commit at launch, so there is no diff to mark.');
  if (typeof rawPath !== 'string' || !rawPath || rawPath.length > 4_096) throw new Error('Choose a changed file to mark.');
  if (!validMarkState(rawState)) throw new Error('A review mark is unreviewed, commented, approved or rejected.');
  if (rawNote !== undefined && rawNote !== null && typeof rawNote !== 'string') throw new Error('A review note must be text.');
  const note = typeof rawNote === 'string' && rawNote.trim() ? rawNote.trim() : null;
  if (note && note.length > MAX_MARK_NOTE_CHARS) throw new Error(`Keep a review note under ${MAX_MARK_NOTE_CHARS.toLocaleString('en-US')} characters.`);
  if (rawState === 'commented' && !note) throw new Error('Write the comment first.');
  const branch = await readBranch(t);
  if (branch.unreadable) throw new Error(`git could not read this session's diff: ${branch.unreadable}`);
  const file = branch.files.find((f) => f.path === rawPath);
  if (!file) throw new Error(`\`${rawPath}\` is not a changed file in this session's diff any more.`);
  /* ── helper sweep · P7 depth ── */
  if (file.scratch) throw new Error(`\`${rawPath}\` is a scratch file, so it is not part of the review. Count this file first to mark it.`);
  const now = Date.now();
  const d = db();
  d.transaction(() => {
    if (rawState === 'unreviewed') {
      d.prepare('DELETE FROM review_marks WHERE session_id = ? AND worktree = ? AND base_commit = ? AND path = ?').run(t.sessionId, t.root, t.base, file.path);
    } else {
      d.prepare(`INSERT INTO review_marks (session_id, worktree, base_commit, path, content_hash, state, note, marked_at) VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(session_id, worktree, base_commit, path) DO UPDATE SET content_hash = excluded.content_hash, state = excluded.state, note = excluded.note, marked_at = excluded.marked_at`)
        .run(t.sessionId, t.root, t.base, file.path, file.contentHash, rawState, note, now);
    }
    d.prepare('INSERT INTO review_mark_events (session_id, path, state, content_hash, at) VALUES (?,?,?,?,?)').run(t.sessionId, file.path, rawState, file.contentHash, now);
  })();
  summaryCache.delete(t.sessionId);
  return fileReview(file, marksFor(t));
}

/** Files whose mark history holds a rejection or comment and whose current mark is a standing approval. */
export function resolvedCount(sessionId: string, files: readonly ReviewFile[], marks: readonly ReviewMark[]): number {
  const rows = db().prepare("SELECT DISTINCT path FROM review_mark_events WHERE session_id = ? AND state IN ('rejected','commented')").all(sessionId) as { path: string }[];
  const flagged = new Set(rows.map((r) => r.path));
  return files.filter((f) => flagged.has(f.path) && fileReview(f, marks).state === 'approved').length;
}

/* ── attribution ─────────────────────────────────────────────────────── */

function rootSpellings(root: string): string[] {
  const out = [path.resolve(root)];
  try { out.push(fs.realpathSync(root)); } catch { /* gone */ }
  if (out[0].startsWith('/private/')) out.push(out[0].slice('/private'.length));
  else out.push(`/private${out[0]}`);
  return [...new Set(out)];
}

function editToolPaths(sessionId: string): string[] {
  const rows = db().prepare(`SELECT paths_json FROM session_events WHERE session_id = ? AND event = 'PostToolUse' AND paths_json IS NOT NULL
    AND tool_name IN (${EDIT_TOOLS.map(() => '?').join(',')})`).all(sessionId, ...EDIT_TOOLS) as { paths_json: string }[];
  const out = new Set<string>();
  for (const r of rows) {
    try { const p: unknown = JSON.parse(r.paths_json); if (Array.isArray(p)) for (const v of p) if (typeof v === 'string') out.add(v); } catch { /* skip */ }
  }
  return [...out];
}

function hooksRecorded(sessionId: string): boolean {
  return !!db().prepare('SELECT 1 FROM session_events WHERE session_id = ? LIMIT 1').get(sessionId);
}

function attributionFor(t: Target, files: readonly ReviewFile[]): { map: Record<string, Attribution>; recorded: boolean; shellReported: boolean } {
  const roots = rootSpellings(t.root);
  const rel = (abs: string[]) => abs.map((p) => relativeToRoot(p, roots)).filter((p): p is string => p !== null);
  const recorded = hooksRecorded(t.sessionId);
  return {
    map: attributeFiles({ files, editPaths: rel(editToolPaths(t.sessionId)), shellPaths: rel(shellChangedPaths(t.sessionId)), hooksRecorded: recorded }),
    recorded,
    shellReported: shellDiffReported(t.sessionId),
  };
}

/* ── risk tiers ──────────────────────────────────────────────────────── */

export function riskRules(projectId: unknown): RiskRule[] {
  if (typeof projectId !== 'string' || !projectId) return [];
  const rows = db().prepare('SELECT pattern, tier FROM project_risk_tiers WHERE project_id = ? ORDER BY position, pattern').all(projectId) as { pattern: string; tier: string }[];
  return rows.filter((r) => r.tier === 'high' || r.tier === 'medium').map((r) => ({ pattern: r.pattern, tier: r.tier as RiskTier }));
}

export function saveRiskRules(projectId: unknown, raw: unknown): RiskRule[] {
  if (typeof projectId !== 'string' || !projectById(projectId)) throw new Error('Project not found.');
  const checked = validateRiskRules(raw);
  if (!checked.ok) throw new Error(checked.reason);
  const d = db();
  const now = Date.now();
  d.transaction(() => {
    d.prepare('DELETE FROM project_risk_tiers WHERE project_id = ?').run(projectId);
    const ins = d.prepare('INSERT INTO project_risk_tiers (project_id, pattern, tier, position, updated_at) VALUES (?,?,?,?,?)');
    checked.rules.forEach((rule, i) => ins.run(projectId, rule.pattern, rule.tier, i, now));
  })();
  summaryCache.clear();
  return riskRules(projectId);
}

/** Tier by the path from the repository root when the checkout is a subdirectory, since rules are written that way. */
function tierFor(t: Target, rules: readonly RiskRule[], p: string): RiskTier | null {
  return tierOf(p, rules) ?? (t.sub ? tierOf(`${t.sub}/${p}`, rules) : null);
}

/* ── the review, whole ───────────────────────────────────────────────── */

const IMAGE = /\.(png|jpe?g|gif|webp|svg)$/i;

export async function reviewWork(sessionId: unknown, opts?: { whitespace?: unknown }): Promise<ReviewWork> {
  const t = await targetFor(String(sessionId));
  const branch = await readBranch(t);
  const marks = marksFor(t);
  const rules = riskRules(t.projectId);
  const attribution = attributionFor(t, branch.files);
  const { patch, truncated: patchTruncated } = branch.files.length ? await readPatch(t, branch.files, opts?.whitespace === true) : { patch: '', truncated: false };
  const perFile = splitPatchByFile(patch);
  const files: ReviewWorkFile[] = branch.files.map((f) => ({
    ...f,
    review: fileReview(f, marks),
    attribution: attribution.map[f.path] ?? 'unrecorded',
    attributionLabel: ATTRIBUTION_LABEL[attribution.map[f.path] ?? 'unrecorded'],
    tier: tierFor(t, rules, f.path) ?? (f.oldPath ? tierFor(t, rules, f.oldPath) : null),
    kind: fileKind(f.path),
    alarms: testAlarms(f.path, f.status, perFile.get(f.path) ?? (f.oldPath ? perFile.get(f.oldPath) ?? '' : '')),
    image: IMAGE.test(f.path),
  }));
  const verdict = needsReviewVerdict({ turn: t.turn, base: t.base, unreadable: branch.unreadable, files: branch.files, marks });
  return {
    sessionId: t.sessionId, root: t.root, base: t.base, anchor: t.base ? branchAnchor(t.base) : null, turn: t.turn,
    files, verdict, label: needsReviewLabel(verdict),
    hooksRecorded: attribution.recorded, shellDiffReported: attribution.shellReported,
    tiersConfigured: rules.length > 0,
    highTierUnapproved: highTierUnapproved(branch.files, marks, (p) => tierFor(t, rules, p)).map((f) => f.path),
    truncated: branch.truncated, patchTruncated, unreadable: branch.unreadable, projectId: t.projectId,
  };
}

async function summaryOf(sessionId: string): Promise<ReviewSummary> {
  const hit = summaryCache.get(sessionId);
  if (hit && Date.now() - hit.at < SUMMARY_TTL_MS) return hit.value;
  const t = await targetFor(sessionId);
  const branch = await readBranch(t);
  const marks = marksFor(t);
  const rules = riskRules(t.projectId);
  const verdict = needsReviewVerdict({ turn: t.turn, base: t.base, unreadable: branch.unreadable, files: branch.files, marks });
  const value: ReviewSummary = {
    sessionId, needsReview: verdict.needsReview, reason: verdict.reason, because: verdict.because,
    label: needsReviewLabel(verdict), counts: verdict.counts,
    highTierUnapproved: highTierUnapproved(branch.files, marks, (p) => tierFor(t, rules, p)).length,
  };
  summaryCache.set(sessionId, { at: Date.now(), value });
  return value;
}

/** Summaries for many sessions at once, for Fleet and the Git view. A session that cannot be read is left out, not zeroed. */
export async function reviewSummaries(ids: unknown): Promise<Record<string, ReviewSummary>> {
  if (!Array.isArray(ids)) return {};
  const out: Record<string, ReviewSummary> = {};
  for (const id of ids.filter((v): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200).slice(0, 60)) {
    try { out[id] = await summaryOf(id); } catch { /* absent rather than invented */ }
  }
  return out;
}

/* ── one file's diff, the whole patch, an image ─────────────────────── */

export async function reviewFileDiff(sessionId: unknown, file: unknown, opts?: { whitespace?: unknown }): Promise<string> {
  const t = await targetFor(String(sessionId));
  if (!t.base) throw new Error('This session recorded no base commit at launch, so there is no branch diff to show.');
  if (typeof file !== 'string' || !file) throw new Error('Choose a changed file.');
  const branch = await readBranch(t);
  const hit = branch.files.find((f) => f.path === file);
  if (!hit) throw new Error(`\`${file}\` is not in this session's diff.`);
  const ws = opts?.whitespace === true ? ['-w'] : [];
  if (hit.status === '?') {
    const r = await runGit(t.root, ['diff', '--no-index', '--no-color', ...ws, '--', '/dev/null', hit.path], { timeout: 15_000, maxBuffer: 16 * 1024 * 1024 });
    return r.out;
  }
  const r = await runGit(t.root, ['diff', '--relative', '-M', '--no-ext-diff', '--no-color', ...ws, t.base, '--', ...(hit.oldPath ? [hit.oldPath] : []), hit.path],
    { timeout: 15_000, maxBuffer: 16 * 1024 * 1024 });
  if (!r.ok) throw new Error(r.err.split('\n')[0] || 'git diff failed.');
  return r.out;
}

export async function reviewPatch(sessionId: unknown, opts?: { whitespace?: unknown }): Promise<{ patch: string; truncated: boolean }> {
  const t = await targetFor(String(sessionId));
  const branch = await readBranch(t);
  return readPatch(t, branch.files, opts?.whitespace === true);
}

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };

/**
 * Before and after for a changed image, as data URLs. The renderer's CSP allows
 * `img-src data:` and nothing on disk, so a file:// path never crosses: main
 * reads the base side out of git's object store and the new side from the
 * working tree, checks the size, and hands over bytes.
 */
export async function reviewImage(sessionId: unknown, file: unknown): Promise<{ before: ReviewImageSide; after: ReviewImageSide }> {
  const t = await targetFor(String(sessionId));
  if (typeof file !== 'string' || !IMAGE.test(file)) throw new Error('Only PNG, JPEG, GIF, WebP and SVG files have an image view.');
  const branch = await readBranch(t);
  const hit = branch.files.find((f) => f.path === file);
  if (!hit || !t.base) throw new Error(`\`${file}\` is not in this session's diff.`);
  const mime = MIME[(file.split('.').pop() ?? '').toLowerCase()];
  const empty = (note: string): ReviewImageSide => ({ dataUrl: null, bytes: null, note });
  const tooBig = (bytes: number): ReviewImageSide => ({ dataUrl: null, bytes, note: `${Math.round(bytes / 1024).toLocaleString('en-US')} KB is over the ${MAX_IMAGE_BYTES / 1024 / 1024} MB preview limit.` });

  let before: ReviewImageSide;
  if (hit.status === 'A' || hit.status === '?') before = empty('New in this diff.');
  else {
    const spec = `${t.base}:./${hit.oldPath ?? hit.path}`;
    const size = await runGit(t.root, ['cat-file', '-s', spec], { timeout: 8_000, maxBuffer: 1024 * 1024 });
    const bytes = size.ok ? Number(size.out.trim()) : NaN;
    if (!Number.isFinite(bytes)) before = empty('git could not read the base version.');
    else if (bytes > MAX_IMAGE_BYTES) before = tooBig(bytes);
    else {
      const blob = await runGitBuffer(t.root, ['cat-file', 'blob', spec], { timeout: 15_000, maxBuffer: MAX_IMAGE_BYTES + 1024 });
      before = blob.ok ? { dataUrl: `data:${mime};base64,${blob.out.toString('base64')}`, bytes, note: null } : empty('git could not read the base version.');
    }
  }

  let after: ReviewImageSide;
  if (hit.status === 'D') after = empty('Deleted in this diff.');
  else {
    const abs = insideRoot(t.root, hit.path);
    const st = abs ? fs.lstatSync(abs, { throwIfNoEntry: false }) : undefined;
    if (!abs || !st || !st.isFile()) after = empty('The working-tree file is not a regular file Wanigan will read.');
    else if (st.size > MAX_IMAGE_BYTES) after = tooBig(st.size);
    else after = { dataUrl: `data:${mime};base64,${fs.readFileSync(abs).toString('base64')}`, bytes: st.size, note: null };
  }
  return { before, after };
}

/* ── per-turn diff stats ─────────────────────────────────────────────── */

const turnStatCache = new Map<string, Map<string, { added: number | null; removed: number | null }>>();

/* ── helper sweep · P7 depth ── */
function projectOf(sessionId: string): string | null {
  const row = db().prepare('SELECT project_id FROM session_log WHERE id = ?').get(sessionId) as { project_id: string | null } | undefined;
  return row?.project_id ?? null;
}
/* ── end helper sweep · P7 depth ── */

/** +N −M for each turn with both snapshots. Keyed by commit pair, which never changes. */
export async function turnStats(sessionId: unknown): Promise<Record<number, TurnStat>> {
  const id = validSessionId(sessionId);
  const rows = listCheckpoints(id);
  const out: Record<number, TurnStat> = {};
  const maxTurn = rows.reduce((m, r) => Math.max(m, r.turn), 0);
  for (let n = 1; n <= maxTurn; n++) {
    const inTurn = rows.filter((r) => r.turn === n);
    const start = inTurn.find((r) => r.kind === 'turn-start' && r.commitHash);
    const end = [...inTurn].reverse().find((r) => (r.kind === 'turn-end' || r.kind === 'session-end') && r.commitHash);
    if (!start?.commitHash || !end?.commitHash) continue;
    const key = `${start.commitHash}..${end.commitHash}`;
    let counts = turnStatCache.get(key);
    if (!counts) {
      const root = fs.existsSync(start.repoRoot) ? start.repoRoot : null;
      if (!root) continue;
      const r = await runGit(root, ['diff', '--numstat', '-z', '--no-renames', start.commitHash, end.commitHash], { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 });
      if (!r.ok) continue;
      counts = parseNumstat(r.out);
      turnStatCache.set(key, counts);
    }
    /* ── helper sweep · P7 depth ── scratch paths leave the turn's counts; a checkpoint already leaves out ignored files. */
    const promoted = promotedPaths(projectOf(id));
    const stat: TurnStat = { files: 0, added: 0, removed: 0 };
    for (const [p, c] of counts) {
      if (!promoted.has(p) && scratchReason(p)) continue;
      stat.files += 1; stat.added += c.added ?? 0; stat.removed += c.removed ?? 0;
    }
    out[n] = stat;
  }
  return out;
}

/* ── dependencies ────────────────────────────────────────────────────── */

async function manifestText(t: Target, f: ReviewFile, side: 'before' | 'after'): Promise<{ text: string | null; error: string | null }> {
  if (side === 'before') {
    if (f.status === 'A' || f.status === '?' || !t.base) return { text: null, error: null };
    const r = await runGit(t.root, ['show', `${t.base}:./${f.oldPath ?? f.path}`], { timeout: 15_000, maxBuffer: MAX_MANIFEST_BYTES });
    return r.ok ? { text: r.out, error: null } : { text: null, error: 'git could not read the base version.' };
  }
  if (f.status === 'D') return { text: null, error: null };
  const abs = insideRoot(t.root, f.path);
  const st = abs ? fs.lstatSync(abs, { throwIfNoEntry: false }) : undefined;
  if (!abs || !st?.isFile()) return { text: null, error: 'The working-tree file is not a regular file Wanigan will read.' };
  if (st.size > MAX_MANIFEST_BYTES) return { text: null, error: `The file is over ${MAX_MANIFEST_BYTES / 1024 / 1024} MB, so it was not read.` };
  return { text: fs.readFileSync(abs, 'utf8'), error: null };
}

async function dependencyReviewFor(t: Target, files: readonly ReviewFile[]): Promise<DependencyReview> {
  const manifests: ManifestReview[] = [];
  for (const f of files) {
    const kind = manifestKind(f.path);
    if (!kind) continue;
    const [before, after] = await Promise.all([manifestText(t, f, 'before'), manifestText(t, f, 'after')]);
    const fail = before.error ?? after.error;
    if (fail) { manifests.push({ path: f.path, kind, changes: [], lines: [], note: null, error: fail }); continue; }
    const a = readManifest(kind, before.text);
    const b = readManifest(kind, after.text);
    if (!a.ok || !b.ok) {
      manifests.push({ path: f.path, kind, changes: [], lines: [], note: null, error: !a.ok ? `Base version: ${a.reason}` : `Working tree: ${(b as { reason: string }).reason}` });
      continue;
    }
    const changes = diffDependencies(a.entries, b.entries);
    manifests.push({ path: f.path, kind, changes, lines: changes.map((c) => describeDepChange(c, f.path)), note: b.note ?? a.note, error: null });
  }
  const installs = shellCommands(t.sessionId).filter((c) => isInstallCommand(c.command)).map((c) => ({ command: c.command, ok: c.ok, exitCode: c.exitCode, at: c.at }));
  return { manifests, installs, hooksRecorded: hooksRecorded(t.sessionId) };
}

export async function dependencyReview(sessionId: unknown): Promise<DependencyReview> {
  const t = await targetFor(String(sessionId));
  const branch = await readBranch(t);
  return dependencyReviewFor(t, branch.files);
}

/* ── claims in the final message ─────────────────────────────────────── */

export async function claimsReview(sessionId: unknown): Promise<ClaimsReview> {
  const t = await targetFor(String(sessionId));
  if (t.harness !== 'claude-code') {
    return { state: 'unsupported', reason: 'Wanigan reads the final message from Claude Code transcripts only; this session ran another harness.' };
  }
  if (t.turn === 'working') return { state: 'working', reason: 'The session is still in a turn. Its final message is graded once the turn ends.' };
  if (!t.base) return { state: 'no-base', reason: 'No base commit was recorded at launch, so there is no diff to check claims against.' };
  let message: string | null = null;
  let source = '';
  const archived = transcriptFor(t.sessionId);
  for (let i = archived.turns.length - 1; i >= 0; i--) {
    if (archived.turns[i].role === 'assistant' && archived.turns[i].text.trim()) { message = archived.turns[i].text.trim(); source = 'the archived transcript'; break; }
  }
  if (!message) {
    for (const cwd of [t.worktree, t.projectPath].filter((v): v is string => !!v)) {
      try { message = lastAssistantTurn(cwd, t.conversationId); } catch { message = null; }
      if (message) { source = "Claude Code's transcript"; break; }
    }
  }
  if (!message) return { state: 'no-message', reason: 'No assistant message was found in this session\'s transcript.' };
  const branch = await readBranch(t);
  const { patch } = await readPatch(t, branch.files, false);
  const deps = await dependencyReviewFor(t, branch.files);
  const claims = gradeClaims(extractClaims(message), {
    files: branch.files,
    addedText: addedTextOf(patch),
    dependencies: deps.manifests.flatMap((m) => m.changes.map((c) => ({ name: c.name, change: c.change }))),
    commands: shellCommands(t.sessionId),
    hooksRecorded: hooksRecorded(t.sessionId),
  });
  return { state: 'graded', source, claims, messageChars: message.length };
}

/* ── the merge gate ──────────────────────────────────────────────────── */

/**
 * Whether a worktree merge may proceed under the project's risk tiers: every
 * high-tier file in the session's diff needs a standing approval. A worktree
 * with no session has no marks to give and no tiers are applied to it; that is
 * said, not hidden.
 */
export async function mergeCheck(worktreePath: string): Promise<MergeCheck> {
  let canonical = path.resolve(worktreePath);
  try { canonical = fs.realpathSync(canonical); } catch { /* compared as given */ }
  const row = db().prepare('SELECT session_id FROM worktrees WHERE path = ? AND removed_at IS NULL').get(canonical) as { session_id: string | null } | undefined;
  if (!row?.session_id) return { allowed: true, sessionId: null, highTier: [], detail: 'No Wanigan session owns this worktree, so no review marks or risk tiers apply to it.' };
  const t = await targetFor(row.session_id);
  const rules = riskRules(t.projectId);
  if (!rules.some((r) => r.tier === 'high')) return { allowed: true, sessionId: t.sessionId, highTier: [], detail: null };
  const branch = await readBranch(t);
  if (branch.unreadable) return { allowed: false, sessionId: t.sessionId, highTier: [], detail: `git could not read this session's diff, so its high-tier files cannot be checked: ${branch.unreadable}` };
  const open = highTierUnapproved(branch.files, marksFor(t), (p) => tierFor(t, rules, p)).map((f) => f.path);
  return open.length
    ? { allowed: false, sessionId: t.sessionId, highTier: open, detail: `${open.length} high-tier file${open.length === 1 ? '' : 's'} in this diff ${open.length === 1 ? 'is' : 'are'} not approved: ${open.slice(0, 8).join(', ')}${open.length > 8 ? `, and ${open.length - 8} more` : ''}. Approve ${open.length === 1 ? 'it' : 'each one'} in the session's code rail before merging.` }
    : { allowed: true, sessionId: t.sessionId, highTier: [], detail: null };
}

/**
 * The merge the Git view's button runs: the risk-tier check, then the
 * worktree merge with all its own guards. One function so the IPC handler and
 * the smoke suite exercise the same composition.
 */
export async function mergeWorktreeReviewed(worktreePath: string, opts?: { squash?: boolean; message?: string }): Promise<{ merged: boolean; detail: string }> {
  const gate = await mergeCheck(worktreePath);
  if (!gate.allowed) return { merged: false, detail: gate.detail ?? "The merge is blocked by the project's risk tiers." };
  return mergeWorktree(worktreePath, opts);
}

/* ── for the PR body and the smoke suite ─────────────────────────────── */

export async function reviewEvidence(sessionId: string): Promise<{ root: string; base: string | null; files: ReviewFile[]; marks: ReviewMark[]; dependencies: DependencyReview } | null> {
  try {
    const t = await targetFor(sessionId);
    if (!fs.existsSync(t.root)) return null;
    const branch = await readBranch(t);
    return { root: t.root, base: t.base, files: branch.files, marks: marksFor(t), dependencies: await dependencyReviewFor(t, branch.files) };
  } catch { return null; }
}

export const __test = { parseNameStatus, parseNumstat, clearCaches: () => { summaryCache.clear(); turnStatCache.clear(); } };
