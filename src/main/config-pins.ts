import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { db } from './db';
import { runGit } from './git';
import {
  claudeSettingsItems, codexConfigItems, diffSnapshots, dotenvItems, gitConfigItems, gitHookItems, mcpJsonItems,
  snapshotOf, summarizeItems, type ConfigPinCheck, type ExecItem, type ExecSnapshot,
} from '../shared/exec-config';

export type { ConfigPinCheck } from '../shared/exec-config';

/**
 * Pinning the configuration a repository runs before its agent does anything.
 *
 * What gets pinned, and why each is here, is in src/shared/exec-config.ts. This
 * module reads it — bounded, never following it anywhere it points — keeps the
 * digests a person has let launch, and answers the one question a launch asks:
 * is this the configuration that was accepted?
 *
 * Trust on first use, and said so. The first launch in a repository with any
 * executable config records its digest as "pinned at first launch, not
 * reviewed"; the launch dialog shows the same summary before that first press.
 * What changes after that is asked about: an attended launch shows the
 * difference and needs an explicit acceptance, and a headless run — which has
 * nobody to ask — is blocked. A pin is a record of what was let through, not a
 * claim that it is safe: the Context view says which pins were reviewed and
 * which only happened to be first.
 */

const MAX_FILE_BYTES = 512 * 1024;
const MAX_HOOK_BYTES = 256 * 1024;
const KEEP_PINS = 20;

const hash = (text: string) => createHash('sha256').update(text).digest('hex');

type Read = { kind: 'absent' } | { kind: 'text'; text: string } | { kind: 'unreadable' };

function readBounded(file: string): Read {
  let stat: fs.Stats;
  try { stat = fs.statSync(file); } catch { return { kind: 'absent' }; }
  if (!stat.isFile()) return { kind: 'unreadable' };
  if (stat.size > MAX_FILE_BYTES) return { kind: 'unreadable' };
  try { return { kind: 'text', text: fs.readFileSync(file, 'utf8') }; } catch { return { kind: 'unreadable' }; }
}

/** `git config --list -z` pairs: each entry is "key\nvalue\0". */
function configPairs(out: string): [string, string][] {
  return out.split('\0').filter(Boolean).map((entry) => {
    const at = entry.indexOf('\n');
    return (at < 0 ? [entry, ''] : [entry.slice(0, at), entry.slice(at + 1)]) as [string, string];
  });
}

async function gitItems(root: string, unreadable: string[]): Promise<ExecItem[]> {
  const inside = await runGit(root, ['rev-parse', '--is-inside-work-tree'], { timeout: 8_000 });
  if (!inside.ok || inside.out.trim() !== 'true') return [];
  const safe = ['-c', 'core.fsmonitor=false'];
  const pairs: [string, string][] = [];
  const local = await runGit(root, [...safe, 'config', '--local', '--list', '-z'], { timeout: 8_000 });
  if (local.ok) pairs.push(...configPairs(local.out));
  else if (local.code !== 1) unreadable.push('git config');
  // Per-worktree config exists only where the extension is on. Without it git
  // answers `--worktree` exactly as it answers `--local`, and reading both put
  // every risky key into the pin twice.
  const worktreeConfig = pairs.some(([key, value]) => key.toLowerCase() === 'extensions.worktreeconfig' && /^(true|yes|on|1)$/i.test(value));
  if (worktreeConfig) {
    const worktree = await runGit(root, [...safe, 'config', '--worktree', '--list', '-z'], { timeout: 8_000 });
    if (worktree.ok) pairs.push(...configPairs(worktree.out));
  }
  const seen = new Set<string>();
  const unique = pairs.filter(([key, value]) => {
    const identity = `${key.toLowerCase()}\u0000${value}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
  const items = gitConfigItems(unique, hash);

  const hooksPathSetting = unique.find(([key]) => key.toLowerCase() === 'core.hookspath')?.[1];
  const hooksDir = hooksPathSetting
    ? path.resolve(root, hooksPathSetting)
    : (await runGit(root, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks'], { timeout: 8_000 })).out.trim();
  if (hooksDir) {
    let names: string[] = [];
    try { names = fs.readdirSync(hooksDir); } catch { names = []; }
    const hooks: { name: string; sha256: string }[] = [];
    for (const name of names.sort()) {
      if (name.endsWith('.sample')) continue;
      const file = path.join(hooksDir, name);
      let stat: fs.Stats;
      try { stat = fs.statSync(file); } catch { continue; }
      if (!stat.isFile() || (stat.mode & 0o111) === 0) continue;
      if (stat.size > MAX_HOOK_BYTES) { unreadable.push(`git hook ${name}`); continue; }
      try { hooks.push({ name, sha256: hash(fs.readFileSync(file, 'utf8')) }); } catch { unreadable.push(`git hook ${name}`); }
    }
    items.push(...gitHookItems(hooks));
  }
  return items;
}

/** Everything a launch in `root` would run of the repository's own configuration. */
export async function readExecConfig(root: string): Promise<ExecSnapshot> {
  const items: ExecItem[] = [];
  const unreadable: string[] = [];
  const json = (rel: string, into: (value: unknown) => ExecItem[]) => {
    const read = readBounded(path.join(root, rel));
    if (read.kind === 'absent') return;
    if (read.kind === 'unreadable') { unreadable.push(rel); return; }
    try { items.push(...into(JSON.parse(read.text))); } catch { unreadable.push(rel); }
  };
  const text = (rel: string, into: (value: string) => ExecItem[]) => {
    const read = readBounded(path.join(root, rel));
    if (read.kind === 'absent') return;
    if (read.kind === 'unreadable') { unreadable.push(rel); return; }
    items.push(...into(read.text));
  };
  json('.claude/settings.json', (value) => claudeSettingsItems('.claude/settings.json', value, hash));
  json('.claude/settings.local.json', (value) => claudeSettingsItems('.claude/settings.local.json', value, hash));
  json('.mcp.json', (value) => mcpJsonItems('.mcp.json', value, hash));
  text('.codex/config.toml', (value) => codexConfigItems('.codex/config.toml', value, hash));
  text('.env', (value) => dotenvItems('.env', value, hash));
  items.push(...await gitItems(root, unreadable));
  return snapshotOf(items, unreadable, hash);
}

type PinRow = { digest: string; items_json: string; how: 'first-use' | 'reviewed'; root: string; created_at: number };

function pinsFor(projectId: string): PinRow[] {
  return db().prepare('SELECT digest, items_json, how, root, created_at FROM config_pins WHERE project_id=? ORDER BY created_at DESC, rowid DESC')
    .all(projectId) as PinRow[];
}

function parseItems(json: string): ExecItem[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed as ExecItem[] : [];
  } catch { return []; }
}

export async function checkConfig(projectId: string, root: string): Promise<ConfigPinCheck> {
  const snapshot = await readExecConfig(root);
  const summary = summarizeItems(snapshot.items) + (snapshot.unreadable.length ? `; unreadable: ${snapshot.unreadable.join(', ')}` : '');
  const pins = pinsFor(projectId);
  const accepted = pins.find((pin) => pin.digest === snapshot.digest) ?? null;
  const last = accepted ?? pins[0] ?? null;
  const lastAccepted = last ? { how: last.how, at: last.created_at, root: last.root } : null;
  if (!snapshot.items.length && !snapshot.unreadable.length) return { state: 'none', snapshot, summary, diff: null, lastAccepted };
  if (accepted) return { state: 'accepted', snapshot, summary, diff: null, lastAccepted };
  if (!pins.length) return { state: 'first-use', snapshot, summary, diff: null, lastAccepted: null };
  return { state: 'changed', snapshot, summary, diff: diffSnapshots(parseItems(pins[0].items_json), snapshot.items), lastAccepted };
}

function recordPin(projectId: string, snapshot: ExecSnapshot, how: 'first-use' | 'reviewed', root: string): void {
  const d = db();
  d.prepare('INSERT INTO config_pins (id, project_id, digest, items_json, how, root, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(randomUUID(), projectId, snapshot.digest, JSON.stringify(snapshot.items), how, root, Date.now());
  // Bounded: every accepted digest is a way back in, and twenty is a long
  // enough memory for branches that move between known configurations.
  d.prepare(`DELETE FROM config_pins WHERE project_id=? AND rowid NOT IN (
      SELECT rowid FROM config_pins WHERE project_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?)`)
    .run(projectId, projectId, KEEP_PINS);
}

/**
 * Accept what is on disk now, after reading it. The renderer names a digest it
 * was shown; main recomputes and refuses when the configuration moved again in
 * between, so nobody accepts a version they did not see.
 */
export async function acceptConfig(projectId: string, root: string, digest: string): Promise<ConfigPinCheck> {
  const current = await checkConfig(projectId, root);
  if (current.snapshot.digest !== digest) {
    throw new Error('The configuration changed again while it was on screen. Read the current version before accepting it.');
  }
  if (current.state !== 'none') recordPin(projectId, current.snapshot, 'reviewed', root);
  return checkConfig(projectId, root);
}

export type LaunchGate = { allowed: true; note: string | null } | { allowed: false; reason: string };

/**
 * The launch-time check. `acceptDigest` is the digest the operator accepted in
 * the launch dialog; only an attended launch can carry one.
 */
export async function gateLaunch(projectId: string, root: string, acceptDigest: string | null, attended: boolean): Promise<LaunchGate> {
  const check = await checkConfig(projectId, root);
  if (check.state === 'none' || check.state === 'accepted') return { allowed: true, note: null };
  if (check.state === 'first-use') {
    recordPin(projectId, check.snapshot, 'first-use', root);
    return { allowed: true, note: `Pinned this repository's executable config at first launch, without review: ${check.summary}.` };
  }
  if (attended && acceptDigest === check.snapshot.digest) {
    recordPin(projectId, check.snapshot, 'reviewed', root);
    return { allowed: true, note: `Launched with changed config you reviewed: ${check.summary}.` };
  }
  const diff = check.diff!;
  const counts = [
    diff.added.length ? `${diff.added.length} added` : '', diff.changed.length ? `${diff.changed.length} changed` : '',
    diff.removed.length ? `${diff.removed.length} removed` : '', check.snapshot.unreadable.length ? `${check.snapshot.unreadable.length} unreadable` : '',
  ].filter(Boolean).join(', ');
  return {
    allowed: false,
    reason: attended
      ? `This repository's executable config changed since it was last accepted (${counts || 'changed'}). Review it in the New session dialog, or accept it in Context, then launch again.`
      : `This repository's executable config changed since it was last accepted (${counts || 'changed'}), and an unattended run has nobody to review it. Accept it in Context first.`,
  };
}
