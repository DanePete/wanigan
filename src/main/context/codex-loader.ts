import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as accounts from '../accounts';
import { discoverSkills } from '../skills';
import { projectById } from '../store';
import { markInstructionPathsServable } from './instructions';
import { estimateTokens } from '../../shared/tokens';
import {
  codexChain, codexSkillBudget, readImplicitInvocation, searchDirectories, skillListingLine, candidateFilenames,
  CODEX_DEFAULT_PROJECT_DOC_MAX_BYTES, CODEX_DEFAULT_ROOT_MARKERS, type CodexChain, type DirectoryListing, type SkillBudget,
} from '../../shared/codex-loader';
import { readTomlKeys, tomlInteger, tomlString, tomlStrings, type TomlKeys } from '../../shared/toml-keys';
import type { CodexLoaderReport, CodexSkillRow } from '../../shared/cost-types';

/**
 * The Codex half of "what will my agent actually be told": the AGENTS.md chain
 * Codex builds for a session started at a project's root, its byte budget and
 * where it cuts, and what the skills listing costs every turn.
 *
 * Read from disk only. The account whose `CODEX_HOME` a launch in this project
 * would use supplies config.toml and the models cache; nothing here starts
 * Codex or asks it anything.
 */

const MAX_CONFIG_BYTES = 256 * 1024;
/** A file bigger than this is not read to decide whether it is blank; it plainly is not. */
const BLANK_CHECK_BYTES = 1024 * 1024;

export function codexHomeForProject(projectId: string | null): { dir: string; accountLabel: string | null; source: 'account' | 'environment' | 'default' } {
  try {
    const resolved = accounts.resolve({ harness: 'codex', projectId });
    if (resolved.account?.configDir) return { dir: path.resolve(resolved.account.configDir), accountLabel: resolved.account.label, source: 'account' };
  } catch { /* no accounts table yet: fall through to the ambient home */ }
  const env = process.env.CODEX_HOME?.trim();
  if (env) return { dir: path.resolve(env), accountLabel: null, source: 'environment' };
  return { dir: path.join(os.homedir(), '.codex'), accountLabel: null, source: 'default' };
}

function readSmall(file: string, cap: number): string | null {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > cap) return null;
    return fs.readFileSync(file, 'utf8');
  } catch { return null; }
}

export type CodexConfigRead = {
  path: string;
  exists: boolean;
  keys: TomlKeys | null;
  maxBytes: number;
  maxBytesFrom: 'config' | 'default';
  fallbacks: string[];
  rootMarkers: string[];
  skillsMaxTokens: number | null;
  model: string | null;
  contextWindowOverride: number | null;
  unreadable: string[];
};

export function readCodexConfig(home: string): CodexConfigRead {
  const file = path.join(home, 'config.toml');
  const text = readSmall(file, MAX_CONFIG_BYTES);
  const keys = text === null ? null : readTomlKeys(text);
  const maxBytes = keys ? tomlInteger(keys, 'project_doc_max_bytes') : null;
  const watched = ['project_doc_max_bytes', 'project_doc_fallback_filenames', 'project_root_markers', 'skills.max_context_tokens', 'model', 'model_context_window'];
  return {
    path: file,
    exists: fs.existsSync(file),
    keys,
    maxBytes: maxBytes !== null && maxBytes >= 0 ? maxBytes : CODEX_DEFAULT_PROJECT_DOC_MAX_BYTES,
    maxBytesFrom: maxBytes !== null && maxBytes >= 0 ? 'config' : 'default',
    fallbacks: (keys && tomlStrings(keys, 'project_doc_fallback_filenames')) ?? [],
    rootMarkers: (keys && tomlStrings(keys, 'project_root_markers')) ?? CODEX_DEFAULT_ROOT_MARKERS,
    skillsMaxTokens: keys ? tomlInteger(keys, 'skills.max_context_tokens') : null,
    model: keys ? tomlString(keys, 'model') : null,
    contextWindowOverride: keys ? tomlInteger(keys, 'model_context_window') : null,
    unreadable: (keys?.unreadable ?? []).filter((key) => watched.includes(key)),
  };
}

/** The model's context window from the models cache Codex keeps in its home. */
export function contextWindowFor(home: string, model: string | null): { tokens: number | null; source: string | null } {
  if (!model) return { tokens: null, source: null };
  const text = readSmall(path.join(home, 'models_cache.json'), 4 * 1024 * 1024);
  if (!text) return { tokens: null, source: null };
  try {
    const parsed = JSON.parse(text) as { models?: { slug?: unknown; context_window?: unknown }[] };
    const hit = (parsed.models ?? []).find((m) => m.slug === model);
    const n = typeof hit?.context_window === 'number' ? hit.context_window : null;
    return n && n > 0 ? { tokens: n, source: 'models_cache.json' } : { tokens: null, source: null };
  } catch { return { tokens: null, source: null }; }
}

/** The nearest ancestor of cwd (itself included) holding one of Codex's project root markers. */
export function projectRootFor(cwd: string, markers: string[]): string | null {
  let dir = path.resolve(cwd);
  for (;;) {
    if (markers.some((marker) => fs.existsSync(path.join(dir, marker)))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function listingsFor(dirs: string[], fallbacks: string[]): DirectoryListing[] {
  const names = candidateFilenames(fallbacks);
  return dirs.map((dir) => ({
    dir,
    present: names.flatMap((name) => {
      const file = path.join(dir, name);
      try {
        const st = fs.statSync(file);
        if (!st.isFile()) return [];
        let blank = false;
        if (st.size <= BLANK_CHECK_BYTES) {
          try { blank = fs.readFileSync(file, 'utf8').trim() === ''; } catch { /* unreadable reads as not blank */ }
        }
        return [{ name, path: file, bytes: st.size, blank }];
      } catch { return []; }
    }),
  }));
}

/** Discovery for a session started in `cwd`: root marker, directories, listings. */
export function chainForCwd(cwd: string, config: CodexConfigRead): { root: string | null; dirs: string[]; listings: DirectoryListing[]; chain: CodexChain } {
  const root = projectRootFor(cwd, config.rootMarkers);
  const dirs = searchDirectories(path.resolve(cwd), root, path.sep);
  const listings = listingsFor(dirs, config.fallbacks);
  return { root, dirs, listings, chain: codexChain(listings, config.fallbacks, config.maxBytes) };
}

function frontmatterField(text: string, key: string): string {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return '';
  const line = m[1].split(/\r?\n/).find((l) => l.startsWith(`${key}:`));
  return line ? line.slice(key.length + 1).trim().replace(/^["']|["']$/g, '') : '';
}

function homeSkills(home: string): { name: string; description: string; path: string; dir: string }[] {
  const root = path.join(home, 'skills');
  const out: { name: string; description: string; path: string; dir: string }[] = [];
  const visit = (dir: string, depth: number) => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      const sub = path.join(dir, entry.name);
      const skill = path.join(sub, 'SKILL.md');
      const text = readSmall(skill, 512 * 1024);
      if (text !== null) {
        out.push({ name: frontmatterField(text, 'name') || entry.name, description: frontmatterField(text, 'description'), path: skill, dir: sub });
      } else if (depth < 1) {
        visit(sub, depth + 1);
      }
    }
  };
  visit(root, 0);
  return out;
}

export function implicitPolicyOf(skillDir: string): boolean | null | 'unknown' {
  const yaml = readSmall(path.join(skillDir, 'agents', 'openai.yaml'), 64 * 1024);
  return yaml === null ? null : readImplicitInvocation(yaml);
}

export function codexSkillRows(projectId: string | null, home: string, homeDir?: string): CodexSkillRow[] {
  const rows: CodexSkillRow[] = [];
  const seen = new Set<string>();
  const push = (skill: { name: string; description: string; path: string; dir: string }, root: CodexSkillRow['root']) => {
    if (seen.has(skill.path)) return;
    seen.add(skill.path);
    const implicit = implicitPolicyOf(skill.dir);
    const listed = implicit !== false;
    rows.push({
      name: skill.name, description: skill.description, path: skill.path, dir: skill.dir, root, implicit, listed,
      estTokens: listed ? estimateTokens(skillListingLine(skill)) : 0,
    });
  };
  try {
    for (const skill of discoverSkills(projectId ?? undefined, { homeDir }).agentSkills) {
      push({ name: skill.label || skill.name, description: skill.description, path: skill.path, dir: skill.dir },
        skill.source === 'agents-project' ? 'project' : 'personal');
    }
  } catch { /* a catalogue failure leaves the home skills below */ }
  for (const skill of homeSkills(home)) push(skill, 'codex-home');
  return rows;
}

export function codexLoaderReport(projectId: string | null, projectPath: string): CodexLoaderReport {
  const project = projectId ? projectById(projectId) : undefined;
  const cwd = path.resolve(project?.path ?? projectPath);
  const home = codexHomeForProject(project?.id ?? null);
  const config = readCodexConfig(home.dir);
  const { root, chain } = chainForCwd(cwd, config);
  const globalListing = listingsFor([home.dir], [])[0];
  const global = globalListing.present.sort((a, b) => (a.name === 'AGENTS.override.md' ? -1 : b.name === 'AGENTS.override.md' ? 1 : 0))[0] ?? null;
  const model = config.model;
  const window = config.contextWindowOverride !== null
    ? { tokens: config.contextWindowOverride, source: 'config.toml model_context_window' }
    : contextWindowFor(home.dir, model);
  const budget: SkillBudget = codexSkillBudget({ explicit: config.skillsMaxTokens, contextWindow: window.tokens });
  const skills = codexSkillRows(project?.id ?? null, home.dir);
  const listedTokens = skills.reduce((sum, s) => sum + s.estTokens, 0);
  const projectConfig = path.join(cwd, '.codex', 'config.toml');
  const projectKeys = readSmall(projectConfig, MAX_CONFIG_BYTES);
  const projectOverrides = projectKeys === null ? [] : Object.keys(readTomlKeys(projectKeys).values)
    .filter((key) => ['project_doc_max_bytes', 'project_doc_fallback_filenames', 'project_root_markers', 'skills.max_context_tokens', 'model'].includes(key));

  const notes: string[] = [];
  if (!root) notes.push(`No ${config.rootMarkers.join(' / ')} marker was found above ${cwd}, so Codex searches that directory alone.`);
  if (config.unreadable.length) notes.push(`config.toml sets ${config.unreadable.join(', ')} in a form Wanigan’s reader does not parse; the defaults are shown instead.`);
  if (projectOverrides.length) notes.push(`${projectConfig} also sets ${projectOverrides.join(', ')}. Codex applies a project config only when it trusts the project; the account values are shown.`);
  notes.push('Profile-level overrides are not read. Whether a whitespace-only AGENTS.md consumes budget is modelled as not.');

  markInstructionPathsServable([...chain.files.map((f) => f.path), ...(global ? [global.path] : [])]);
  return {
    projectRoot: cwd,
    codexHome: home.dir,
    accountLabel: home.accountLabel,
    homeSource: home.source,
    configPath: config.path,
    configExists: config.exists,
    maxBytes: config.maxBytes,
    maxBytesFrom: config.maxBytesFrom,
    fallbacks: config.fallbacks,
    rootMarkers: config.rootMarkers,
    rootDir: root,
    chain,
    global: global ? { path: global.path, name: global.name, bytes: global.bytes } : null,
    model,
    contextWindow: window.tokens,
    contextWindowSource: window.source,
    skillBudget: budget,
    skills,
    listedSkills: skills.filter((s) => s.listed).length,
    listedTokens,
    notes,
  };
}
