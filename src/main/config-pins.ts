import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { db } from './db';
import { runGit } from './git';
import {
  claudeSettingsItems, codexConfigItems, diffSnapshots, dotenvItems, gitConfigItems, gitHookItems, mcpJsonItems,
  snapshotOf, summarizeItems, type ConfigPinCheck, type ExecItem, type ExecSnapshot,
} from '../shared/exec-config';
/* ── helper sweep · P7 depth ── */
import { getSetting, setSetting } from './settings';
import {
  describeFiles, diffInstructions, instructionDecision, instructionDigest, isInstructionPath,
  type InstructionCheck, type InstructionPinHow, type InstructionText,
} from '../shared/instruction-pins';
/* ── end helper sweep · P7 depth ── */

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
  /* ── helper sweep · P7 depth ── */
  const instructions = await checkInstructions(projectId, root).catch(() => null);
  return { ...await checkExecutable(projectId, root), instructions };
}

async function checkExecutable(projectId: string, root: string): Promise<ConfigPinCheck> {
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
  /* ── helper sweep · P7 depth ── */
  // Instruction files first: a project that asks about them refuses here, and
  // one that only shows them lets the executable gate below decide. The new
  // baseline is recorded only once that gate has let the launch through.
  let instructions: InstructionCheck | null = null;
  try { instructions = await checkInstructions(projectId, root); } catch { instructions = null; }
  const decided = instructions ? instructionDecision(instructions, attended) : null;
  if (decided && !decided.allowed) return { allowed: false, reason: decided.reason };
  const gate = await gateExecutable(projectId, root, acceptDigest, attended);
  if (!gate.allowed || !decided || !instructions) return gate;
  if (decided.record) recordInstructionPin(projectId, root, instructions, decided.record);
  const notes = [gate.note, decided.note].filter(Boolean).join(' ');
  return { allowed: true, note: notes || null };
  /* ── end helper sweep · P7 depth ── */
}

async function gateExecutable(projectId: string, root: string, acceptDigest: string | null, attended: boolean): Promise<LaunchGate> {
  const check = await checkExecutable(projectId, root);
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

/* ── helper sweep · P7 depth ── instruction files beside the pin ───────── */

const MAX_INSTRUCTION_FILES = 200;
const INSTRUCTION_ROOT_FILES = ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', 'AGENTS.override.md'];
/** Directories a nested AGENTS.md walk never enters: dependencies, build output, VCS internals, Wanigan's own worktrees. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'vendor', 'dist', 'build', 'out', 'target', '.venv', 'venv', '__pycache__', '.next', 'coverage']);
const WALK_MAX_DIRS = 4_000;
const WALK_MAX_DEPTH = 8;

/**
 * Every instruction file in the project, with its text. Read from disk rather
 * than from git, because CLAUDE.local.md is usually ignored and still loaded.
 * Symlinks are not followed, and the walk is bounded; a file too large to read
 * is listed as unreadable, which changes the digest.
 */
export function readInstructionFiles(root: string): { texts: InstructionText[]; unreadable: string[] } {
  const texts: InstructionText[] = [];
  const unreadable: string[] = [];
  const take = (rel: string) => {
    if (texts.length + unreadable.length >= MAX_INSTRUCTION_FILES || !isInstructionPath(rel)) return;
    const read = readBounded(path.join(root, rel));
    if (read.kind === 'text') texts.push({ path: rel, text: read.text });
    else if (read.kind === 'unreadable') unreadable.push(rel);
  };
  for (const name of INSTRUCTION_ROOT_FILES) take(name);
  let dirs = 0;
  const walk = (rel: string, depth: number, rulesOnly: boolean) => {
    if (depth > WALK_MAX_DEPTH || dirs++ > WALK_MAX_DIRS) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (rulesOnly) { walk(child, depth + 1, true); continue; }
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        walk(child, depth + 1, false);
      } else if (e.isFile() && depth > 0) {
        if (rulesOnly ? e.name.endsWith('.md') : (e.name === 'AGENTS.md' || e.name === 'AGENTS.override.md')) take(child);
      }
    }
  };
  walk('.claude/rules', 1, true);
  walk('', 0, false);
  return { texts, unreadable };
}

function askKey(projectId: string): string {
  return `instruction_ask:${projectId}`;
}

export function instructionAsk(projectId: string): boolean {
  try { return getSetting(askKey(projectId), '0') === '1'; } catch { return false; }
}

export function setInstructionAsk(projectId: unknown, on: unknown): boolean {
  if (typeof projectId !== 'string' || !projectId || projectId.length > 200) throw new Error('Choose a project first.');
  if (!db().prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) throw new Error('That is not a project Wanigan knows.');
  setSetting(askKey(projectId), on === true ? '1' : '0');
  return on === true;
}

type InstructionPinRow = { digest: string; texts_json: string; how: string; created_at: number };

function latestInstructionPin(projectId: string): InstructionPinRow | null {
  return (db().prepare('SELECT digest, texts_json, how, created_at FROM instruction_pins WHERE project_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1')
    .get(projectId) as InstructionPinRow | undefined) ?? null;
}

function pinTexts(row: InstructionPinRow): InstructionText[] {
  try {
    const parsed: unknown = JSON.parse(row.texts_json);
    return Array.isArray(parsed) ? parsed.filter((t): t is InstructionText => !!t && typeof (t as InstructionText).path === 'string' && typeof (t as InstructionText).text === 'string') : [];
  } catch { return []; }
}

export async function checkInstructions(projectId: string, root: string): Promise<InstructionCheck> {
  const { texts, unreadable } = readInstructionFiles(root);
  const files = describeFiles(texts, hash);
  const digest = instructionDigest(files, unreadable, hash);
  const pin = latestInstructionPin(projectId);
  const askOnChange = instructionAsk(projectId);
  const lastTrusted = pin ? { at: pin.created_at, how: (['first-use', 'shown', 'reviewed'].includes(pin.how) ? pin.how : 'shown') as InstructionPinHow } : null;
  const base = { digest, files, unreadable, askOnChange, lastTrusted, diff: [] };
  if (!pin) return { ...base, state: files.length || unreadable.length ? 'first-use' : 'none' };
  if (pin.digest === digest) return { ...base, state: files.length || unreadable.length ? 'same' : 'none' };
  return { ...base, state: 'changed', diff: diffInstructions(pinTexts(pin), texts) };
}

function recordInstructionPin(projectId: string, root: string, check: InstructionCheck, how: InstructionPinHow): void {
  const { texts } = readInstructionFiles(root);
  // Recorded only when what is on disk is still what was decided about.
  if (instructionDigest(describeFiles(texts, hash), check.unreadable, hash) !== check.digest) return;
  const d = db();
  d.prepare('INSERT INTO instruction_pins (id, project_id, digest, items_json, texts_json, how, root, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(randomUUID(), projectId, check.digest, JSON.stringify(check.files), JSON.stringify(texts), how, root, Date.now());
  d.prepare(`DELETE FROM instruction_pins WHERE project_id=? AND rowid NOT IN (
      SELECT rowid FROM instruction_pins WHERE project_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?)`).run(projectId, projectId, KEEP_PINS);
}

/** Accept the instruction files on disk now, as reviewed. Refused when they moved again since they were shown. */
export async function acceptInstructions(projectId: string, root: string, digest: string): Promise<ConfigPinCheck> {
  const current = await checkInstructions(projectId, root);
  if (current.digest !== digest) throw new Error('The instruction files changed again while they were on screen. Read the current version before accepting it.');
  if (current.state !== 'none') recordInstructionPin(projectId, root, current, 'reviewed');
  return checkConfig(projectId, root);
}
/* ── end helper sweep · P7 depth ── */
