import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { db } from './db';
import { redactCredentials } from './redact';
import { createdPathsIn, shadowsStdlib, STDLIB_SHADOW_NAMES, type TripwireView } from '../shared/taint';
import type { HookInput, SessionEvent } from '../shared/types';

/**
 * The main-process state behind the download tripwire: which paths each live
 * session created by downloading, extracting or cloning, and what a directory
 * on disk holds when Python is about to run in it.
 *
 * In memory, by session, and deliberately so. A live agent process cannot
 * survive a quit, so neither can the set of things it downloaded; what outlives
 * the session is the ledger row and the policy signal written when a tripwire
 * fired. Bounded per session and in total, oldest first.
 */

const MAX_PATHS_PER_SESSION = 500;
const MAX_SESSIONS = 200;
const MAX_DIR_ENTRIES = 4000;
const SHADOW_CACHE_MS = 2_000;

const taint = new Map<string, Set<string>>();
const shadowCache = new Map<string, { at: number; names: string[] }>();

function add(sessionId: string, p: string): void {
  let set = taint.get(sessionId);
  if (!set) {
    if (taint.size >= MAX_SESSIONS) {
      const oldest = taint.keys().next();
      if (!oldest.done) taint.delete(oldest.value);
    }
    set = new Set();
    taint.set(sessionId, set);
  }
  if (set.size >= MAX_PATHS_PER_SESSION) {
    const oldest = set.values().next();
    if (!oldest.done) set.delete(oldest.value);
  }
  set.add(p);
}

/**
 * Called with every stored hook event. A Bash PreToolUse is read for the paths
 * it creates — recorded at announcement rather than completion, which errs
 * towards asking about a download that failed. A Write that creates a file
 * named like a standard-library module taints its directory, so a later
 * Python run there asks even when the directory listing is not readable.
 */
export function observeForTaint(stored: SessionEvent, input: HookInput, cwd: string | null): void {
  if (stored.event !== 'PreToolUse') return;
  const home = os.homedir();
  const tool = input.tool_name ?? '';
  const command = typeof input.tool_input?.command === 'string' ? input.tool_input.command : '';
  const where = cwd && path.isAbsolute(cwd) ? cwd : null;
  if (command && where) {
    for (const c of createdPathsIn(command, where, home)) add(stored.sessionId, c.path);
    return;
  }
  if (tool === 'Write' || tool === 'NotebookEdit') {
    const target = typeof input.tool_input?.file_path === 'string' ? input.tool_input.file_path : '';
    if (target && path.isAbsolute(target) && shadowsStdlib(path.basename(target))) {
      add(stored.sessionId, path.dirname(target));
    }
  }
}

function shadowsIn(dir: string): string[] {
  const hit = shadowCache.get(dir);
  if (hit && Date.now() - hit.at < SHADOW_CACHE_MS) return hit.names;
  let names: string[] = [];
  try {
    const dirHandle = fs.opendirSync(dir);
    try {
      for (let i = 0; i < MAX_DIR_ENTRIES; i++) {
        const entry = dirHandle.readSync();
        if (!entry) break;
        if (entry.isFile() ? shadowsStdlib(entry.name) : entry.isDirectory() && STDLIB_SHADOW_NAMES.has(entry.name) && fs.existsSync(path.join(dir, entry.name, '__init__.py'))) {
          names.push(entry.name);
        }
      }
    } finally {
      dirHandle.closeSync();
    }
  } catch {
    names = [];
  }
  if (shadowCache.size > 500) shadowCache.clear();
  shadowCache.set(dir, { at: Date.now(), names });
  return names;
}

/** The view the gate evaluates a call against. A session nothing is known about has no taint. */
export function tripwireViewFor(sessionId: string | null): TripwireView {
  const set = sessionId ? taint.get(sessionId) : undefined;
  return { tainted: set ? [...set] : [], shadowsIn };
}

export function forgetTaint(sessionId: string): void {
  taint.delete(sessionId);
}

/**
 * A tripwire that fired, as a policy signal: a data row the attention queue can
 * read without re-deriving it from the ledger. Written at every trust level,
 * including Trusted, where the call itself was allowed.
 */
export function recordTripwireSignal(sessionId: string | null, projectId: string | null, rule: string, summary: string, trust: string): void {
  try {
    db().prepare('INSERT INTO policy_signals (at, session_id, project_id, kind, rule, summary, detail_json) VALUES (?,?,?,?,?,?,?)')
      .run(Date.now(), sessionId, projectId, 'tripwire', rule, redactCredentials(summary).slice(0, 400),
        JSON.stringify({ trust, label: 'tripwire, not containment' }));
  } catch { /* the ledger row still stands */ }
}
