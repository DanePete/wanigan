import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { db } from './db';
import { runGit } from './git';
import { redactCredentials } from './redact';
import { isManagedRoot } from './roots';
import { explainCommand, manifestsFor, type ApprovalExplanation, type ManifestFiles } from '../shared/script-explain';
import type { ApprovalDetail, HookInput, SessionEvent } from '../shared/types';

/**
 * The main-process half of "show what a script actually runs": load the
 * manifests a command names, from the working tree and from the session's
 * launch commit, hand them to the pure explainer, and attach the result to the
 * stored PreToolUse or PermissionRequest row.
 *
 * It runs after the hook has been answered, never before. An approval prompt
 * that waited on `git show` would be an approval prompt that arrives late, and
 * the explanation is for the person reading the prompt, not for the gate.
 *
 * Reads are fenced twice. A manifest must resolve, symlinks included, inside a
 * project or worktree Wanigan manages — `make -f /etc/passwd` names a file, and
 * copying that file's lines into the timeline would be a disclosure the agent
 * asked for by typing it. And every string in the stored record passes through
 * the shared credential redactor, because a script body is exactly where a
 * token pasted into package.json lives.
 */

const MAX_MANIFEST_BYTES = 512 * 1024;
const CACHE_MS = 2 * 60_000;
const MAX_CACHE = 200;

type Cached = { at: number; value: Promise<ApprovalExplanation | null> };
const cache = new Map<string, Cached>();

function readContained(abs: string): string | null | 'outside' {
  let real: string;
  try {
    real = fs.realpathSync(abs);
  } catch {
    // Absent is an answer: the explainer says "there is no package.json here".
    return isManagedRoot(path.dirname(abs)) ? null : 'outside';
  }
  if (!isManagedRoot(path.dirname(real))) return 'outside';
  try {
    const st = fs.statSync(real);
    if (!st.isFile() || st.size > MAX_MANIFEST_BYTES) return null;
    return fs.readFileSync(real, 'utf8');
  } catch {
    return null;
  }
}

function launchCommitFor(sessionId: string): string | null {
  try {
    const row = db().prepare('SELECT baseline_head FROM session_log WHERE id = ?').get(sessionId) as { baseline_head: string | null } | undefined;
    const head = row?.baseline_head ?? null;
    return head && /^[0-9a-f]{7,64}$/i.test(head) ? head : null;
  } catch {
    return null;
  }
}

async function atCommit(cwd: string, commit: string, abs: string): Promise<string | null | undefined> {
  const top = await runGit(cwd, ['rev-parse', '--show-toplevel'], { timeout: 5_000 });
  const root = top.out.trim();
  if (!top.ok || !root) return undefined;
  let realRoot = root;
  let realFile = abs;
  try { realRoot = fs.realpathSync(root); } catch { /* keep lexical */ }
  try { realFile = path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs)); } catch { /* keep lexical */ }
  const rel = path.relative(realRoot, realFile);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  const shown = await runGit(root, ['show', `${commit}:${rel.split(path.sep).join('/')}`], { timeout: 5_000, maxBuffer: MAX_MANIFEST_BYTES * 2 });
  if (shown.ok) return shown.out;
  // "exists on disk, but not in <commit>" and "path does not exist in" are git
  // telling us the file was absent at launch; anything else is not an answer.
  return /does not exist|exists on disk, but not in/i.test(shown.err) ? null : undefined;
}

/** Every string in the record, through the redactor. Structure is left alone. */
function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redactCredentials(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactDeep(v);
    return out as T;
  }
  return value;
}

/**
 * The explanation for one command in one session, or null when the command
 * names no runner Wanigan reads. Cached briefly, because the same command
 * arrives as a PreToolUse and then as a PermissionRequest a moment later.
 */
export function explainForSession(sessionId: string, cwd: string, command: string): Promise<ApprovalExplanation | null> {
  const home = os.homedir();
  if (!command || !path.isAbsolute(cwd)) return Promise.resolve(null);
  const wanted = manifestsFor(command, cwd, home);
  if (!wanted.length) return Promise.resolve(null);
  const key = JSON.stringify([sessionId, cwd, command]);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  if (cache.size >= MAX_CACHE) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  const value = (async () => {
    const commit = launchCommitFor(sessionId);
    const files: ManifestFiles = { now: {}, launch: commit ? {} : null, launchCommit: commit };
    const outside: string[] = [];
    for (const abs of wanted) {
      const now = readContained(abs);
      if (now === 'outside') { outside.push(abs); files.now[abs] = null; continue; }
      files.now[abs] = now;
      if (commit && files.launch) {
        const before = await atCommit(cwd, commit, abs).catch(() => undefined);
        if (before !== undefined) files.launch[abs] = before;
      }
    }
    const explained = explainCommand(command, cwd, files, home);
    if (!explained) return null;
    if (outside.length) {
      for (const s of explained.scripts) {
        if (outside.some((o) => o.endsWith(s.manifest) || s.manifest === o)) {
          s.notes.unshift('That manifest is outside every project and worktree Wanigan manages, so Wanigan did not read it.');
        }
      }
    }
    return redactDeep(explained);
  })();
  cache.set(key, { at: Date.now(), value });
  return value;
}

/**
 * Attach the explanation to a stored event row. Only Bash-shaped PreToolUse and
 * PermissionRequest rows carry one. Best effort by design: the row is already
 * the evidence, and this is commentary on it.
 */
export function attachApprovalExplanation(stored: SessionEvent, input: HookInput, fallbackCwd: string | null): void {
  if (stored.event !== 'PreToolUse' && stored.event !== 'PermissionRequest') return;
  const command = typeof input.tool_input?.command === 'string' ? input.tool_input.command : '';
  if (!command.trim()) return;
  const cwd = typeof input.cwd === 'string' && path.isAbsolute(input.cwd) ? input.cwd : fallbackCwd;
  if (!cwd) return;
  void explainForSession(stored.sessionId, cwd, command)
    .then((explained) => {
      if (!explained) return;
      db().prepare('UPDATE session_events SET detail_json = ? WHERE id = ?')
        .run(JSON.stringify({ approval: explained }), stored.id);
    })
    .catch(() => { /* commentary lost; the event row stands */ });
}

/**
 * The newest explained approval in a session, optionally no older than
 * `sinceAt`. This is the read the Fleet inspector, the attention detail and the
 * phone card share, so the three cannot disagree about which command it was.
 */
export function approvalDetailFor(sessionId: string, sinceAt = 0): ApprovalDetail | null {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  const rows = db().prepare(`
    SELECT id, at, event, tool_name, detail_json FROM session_events
     WHERE session_id = ? AND at >= ? AND detail_json IS NOT NULL
       AND event IN ('PermissionRequest', 'PreToolUse')
     ORDER BY at DESC, id DESC LIMIT 20
  `).all(sessionId, Math.max(0, Math.trunc(sinceAt) || 0)) as { id: number; at: number; event: string; tool_name: string | null; detail_json: string }[];
  for (const r of rows) {
    try {
      const parsed = JSON.parse(r.detail_json) as { approval?: ApprovalExplanation };
      if (parsed.approval && parsed.approval.v === 1) {
        return { eventId: r.id, at: r.at, event: r.event, toolName: r.tool_name, approval: parsed.approval };
      }
    } catch { /* a malformed row is skipped, not repaired */ }
  }
  return null;
}
