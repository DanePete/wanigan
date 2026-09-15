/**
 * Exposure paths: a sensitive read, followed later in the same session by a
 * way for data to leave.
 *
 * Wanigan already records both halves — the hook timeline has the read of
 * `.env` and the egress report has the hosts — and neither half is a finding on
 * its own. Joining them is (Confessor, c-claude-helper-tools.md §1.20): "read
 * ~/.aws/credentials, then curl POST 15 seconds later". The result is a lead,
 * not proof. Nothing here knows what bytes moved, only that the order of two
 * recorded events makes the question worth asking, and every surface that
 * shows one says so.
 *
 * Deterministic and local: stored events in, leads out.
 */

import { parseShell, programOf } from './shell-parse.ts';

export type ExposureEvent = {
  id: number;
  sessionId: string;
  at: number;
  event: string;
  toolName: string | null;
  summary: string | null;
  paths: string[];
};

export type SinkKind = 'web' | 'upload' | 'copy-to-host' | 'raw-socket' | 'git-push-other-remote' | 'mcp-remote' | 'mcp-unknown';

export type ExposureLead = {
  sessionId: string;
  read: { eventId: number; at: number; what: string; path: string };
  sink: { eventId: number; at: number; what: string; kind: SinkKind };
  gapMs: number;
  /** Other sensitive reads earlier in the session than the one shown. */
  earlierReads: number;
  label: 'lead, not proof';
};

export type McpLocality = (server: string) => 'local' | 'remote' | 'unknown';

const READERS = new Set(['cat', 'less', 'more', 'head', 'tail', 'cp', 'base64', 'xxd', 'od', 'strings', 'grep', 'rg', 'awk', 'sed', 'source', '.', 'openssl', 'tar', 'zip', 'gpg', 'jq', 'python', 'python3', 'node']);

/**
 * Whether a path names a place credentials live. Home-anchored directories are
 * matched by segment so a project's own `.claude/` is not a credential store;
 * `.env` files and `auth.json` match anywhere, because that is where they are.
 */
export function sensitivePath(p: string, home: string): string | null {
  const path = p.replace(/^~(?=\/|$)/, home).replace(/^\$\{?HOME\}?(?=\/|$)/, home);
  const homeDirs = ['.ssh', '.aws', '.gnupg', '.docker', '.kube', '.config/gh', '.claude', '.codex'];
  for (const d of homeDirs) {
    const root = `${home}/${d}`;
    if (path === root || path.startsWith(`${root}/`)) return root;
  }
  for (const f of ['.npmrc', '.netrc', '.pypirc']) if (path === `${home}/${f}`) return path;
  const base = path.split('/').pop() ?? '';
  if (/^\.env(\.[\w.-]+)?$/.test(base) && !/\.(example|sample|template|dist)$/.test(base)) return path;
  if (base === 'auth.json' || base === 'credentials.json') return path;
  if (/\/Library\/Keychains(\/|$)/.test(path) || /\.keychain(-db)?$/.test(base)) return path;
  return null;
}

function readOf(e: ExposureEvent, home: string): { what: string; path: string } | null {
  const tool = e.toolName ?? '';
  if (tool === 'Read' || tool === 'NotebookRead' || tool === 'Grep' || tool === 'Glob') {
    for (const p of e.paths) {
      const hit = sensitivePath(p, home);
      if (hit) return { what: `${tool} ${p}`, path: hit };
    }
    return null;
  }
  if (tool !== 'Bash' || !e.summary) return null;
  if (/\bsecurity\s+find-(?:generic|internet)-password\b/.test(e.summary)) return { what: e.summary, path: 'macOS keychain' };
  for (const seg of parseShell(e.summary).segments) {
    const program = programOf(seg);
    if (!READERS.has(program)) continue;
    for (const w of [...seg.argv.slice(1), ...seg.redirects.filter((r) => r.op === '<').map((r) => r.target)]) {
      if (w.text.startsWith('-')) continue;
      const hit = sensitivePath(w.text, home);
      if (hit) return { what: seg.text, path: hit };
    }
  }
  return null;
}

function sinkOf(e: ExposureEvent, locality: McpLocality): { what: string; kind: SinkKind } | null {
  const tool = e.toolName ?? '';
  if (tool === 'WebFetch' || tool === 'WebSearch') return { what: `${tool} ${e.summary ?? ''}`.trim(), kind: 'web' };
  if (tool.startsWith('mcp__')) {
    const server = tool.split('__')[1] ?? '';
    const where = locality(server);
    if (where === 'local') return null;
    return { what: tool, kind: where === 'remote' ? 'mcp-remote' : 'mcp-unknown' };
  }
  if (tool !== 'Bash' || !e.summary) return null;
  for (const seg of parseShell(e.summary).segments) {
    const program = programOf(seg);
    const words = seg.argv.slice(1).map((w) => w.text);
    if (program === 'curl') {
      const xi = words.findIndex((w) => w === '-X' || w === '--request');
      if (words.some((w) => /^(-d|--data.*|-F|--form.*|-T|--upload-file|--json)$/.test(w)) || (xi >= 0 && /^(POST|PUT|PATCH)$/i.test(words[xi + 1] ?? ''))) {
        return { what: seg.text, kind: 'upload' };
      }
    }
    if (program === 'wget' && words.some((w) => /^--(post-data|post-file|body-data|body-file|method)/.test(w))) return { what: seg.text, kind: 'upload' };
    if (program === 'scp' || program === 'sftp' || (program === 'rsync' && words.some((w) => /^[^/-][^:\s]*:/.test(w)))) return { what: seg.text, kind: 'copy-to-host' };
    if (program === 'nc' || program === 'ncat' || program === 'netcat' || program === 'socat') return { what: seg.text, kind: 'raw-socket' };
    if (program === 'git' && words.includes('push')) {
      const positional = words.slice(words.indexOf('push') + 1).filter((w) => !w.startsWith('-'));
      const remote = positional[0];
      if (remote && remote !== 'origin') return { what: seg.text, kind: 'git-push-other-remote' };
    }
  }
  return null;
}

/**
 * Leads for one session's events, oldest sink first. Each sink is joined to the
 * newest sensitive read before it; the earlier reads are counted, not repeated.
 */
export function exposureLeads(events: ExposureEvent[], home: string, locality: McpLocality, max = 50): ExposureLead[] {
  const sorted = [...events].sort((a, b) => a.at - b.at || a.id - b.id);
  const reads = new Map<string, { eventId: number; at: number; what: string; path: string }[]>();
  const out: ExposureLead[] = [];
  for (const e of sorted) {
    const r = readOf(e, home);
    if (r) {
      const list = reads.get(e.sessionId) ?? [];
      list.push({ eventId: e.id, at: e.at, ...r });
      reads.set(e.sessionId, list);
      continue;
    }
    const s = sinkOf(e, locality);
    if (!s) continue;
    const prior = reads.get(e.sessionId);
    if (!prior?.length) continue;
    const last = prior[prior.length - 1];
    out.push({
      sessionId: e.sessionId,
      read: last,
      sink: { eventId: e.id, at: e.at, ...s },
      gapMs: Math.max(0, e.at - last.at),
      earlierReads: prior.length - 1,
      label: 'lead, not proof',
    });
    if (out.length >= max) break;
  }
  return out;
}
