import fs from 'node:fs';
import { db } from './db';
import { exactTranscriptPath } from './transcripts';
import { checkTranscriptChain, type ChainCheck } from '../shared/transcript-chain';

/**
 * The resume chain check's reads: find a conversation's own Claude Code
 * transcript and run the detector over it, read-only.
 *
 * The file is the harness's, and Wanigan never writes it — not a repair, not a
 * backup beside it. A result is cached against the file's size and mtime, so a
 * Recent list redrawn every few seconds does not reread megabytes it has
 * already read; a transcript that grows invalidates itself.
 */

const MAX_BYTES = 256 * 1024 * 1024;
const cache = new Map<string, { size: number; mtimeMs: number; value: ChainCheck }>();
const CACHE_MAX = 200;

type Row = { id: string; conversation_id: string | null; provider_id: string; harness_id: string | null; project_path: string; worktree: string | null };

function harnessOf(row: Row): string {
  if (row.harness_id?.trim()) return row.harness_id;
  return row.provider_id === 'codex' ? 'codex' : 'claude-code';
}

export function chainCheckFor(sessionId: string): ChainCheck {
  const row = db().prepare('SELECT id, conversation_id, provider_id, harness_id, project_path, worktree FROM session_log WHERE id = ?')
    .get(sessionId) as Row | undefined;
  if (!row) return { checked: false, reason: 'That conversation is not in Wanigan’s records.' };
  if (harnessOf(row) !== 'claude-code') return { checked: false, reason: 'Only Claude Code transcripts carry a parentUuid chain to check.' };
  const file = exactTranscriptPath(row.worktree ?? row.project_path, row.conversation_id);
  if (!file) return { checked: false, reason: 'No transcript for this exact conversation was found.' };
  let st: fs.Stats;
  try { st = fs.statSync(file); } catch { return { checked: false, reason: 'The transcript could not be read.' }; }
  if (st.size > MAX_BYTES) return { checked: false, reason: `The transcript is larger than ${MAX_BYTES / 1024 / 1024} MB, so it was not read.` };
  const hit = cache.get(file);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.value;
  let value: ChainCheck;
  try {
    const r = checkTranscriptChain(fs.readFileSync(file, 'utf8'));
    value = { checked: true, skipped: r.skipped, breaks: r.breaks.length, kinds: [...new Set(r.breaks.map((b) => b.kind))], messages: r.messages, bytes: st.size };
  } catch {
    value = { checked: false, reason: 'The transcript could not be read.' };
  }
  cache.set(file, { size: st.size, mtimeMs: st.mtimeMs, value });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
  return value;
}

export function chainChecks(ids: unknown): Record<string, ChainCheck> {
  if (!Array.isArray(ids)) return {};
  const out: Record<string, ChainCheck> = {};
  for (const id of ids.filter((v): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128).slice(0, 60)) {
    out[id] = chainCheckFor(id);
  }
  return out;
}
