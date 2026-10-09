// Skills: folders with a SKILL.md that an agent loads as a reusable procedure.
// Plain data and pure helpers; the core reads the disk.
//
// Where each agent looks, as verified on October 6, 2026:
// - Claude Code 2.1.292 (its own loader, read out of the shipped binary):
//   personal `<config>/skills/<name>/SKILL.md` (config is CLAUDE_CONFIG_DIR or
//   ~/.claude), project `<project>/.claude/skills/<name>/SKILL.md`, installed
//   plugins (from `<config>/plugins/installed_plugins.json`), and skills synced
//   from claude.ai under `<config>/skills/synced/<org>_<account>/`.
// - Codex 0.155.1 (asked through its own app-server, `skills/list`, against a
//   throwaway home): `~/.agents/skills` and `$CODEX_HOME/skills` for the user,
//   `<project>/.agents/skills` and `<project>/.codex/skills` for a repository,
//   each walked into subfolders, hidden folders skipped. `~/.codex/skills` is
//   not read when CODEX_HOME points elsewhere, and `.claude/skills` never is.
// - Gemini CLI 0.46 (its SkillManager and skillLoader, read from the bundle;
//   `gemini skills list` run against a throwaway home): `~/.gemini/skills` and
//   `~/.agents/skills` for the user, `<project>/.gemini/skills` and
//   `<project>/.agents/skills` only in a folder it trusts. One level only
//   (`*/SKILL.md`); a SKILL.md without both `name` and `description` in its
//   frontmatter is skipped. It goes by its frontmatter name, and each skill is
//   also a slash command. Its built-in skills live inside the CLI.
//   Wanigan's Gemini sessions read the user folders through links in Wanigan's
//   Gemini home (hooks.ts), so they are the owner's own.
import type { AccountProvider } from './model.ts';

export type SkillAgent = AccountProvider | 'gemini';
export type SkillSource = 'personal' | 'project' | 'plugin' | 'synced';

export interface Skill {
  /** Opaque; the core maps it back to a folder it found itself. */
  id: string;
  name: string;
  description: string;
  agent: SkillAgent;
  source: SkillSource;
  /** How it is called in Claude Code (`/name`, `/plugin:name`) or Gemini CLI (`/name`); null when not known. */
  invoke: string | null;
  /** The skill's folder, absolute, and as the owner would type it. */
  dir: string;
  displayDir: string;
  /** Set when the folder is a link: where it points. */
  linkedTo: string | null;
  /** `name@marketplace` for a plugin's skill. */
  plugin: string | null;
  /** A plugin's switch in the account's settings; null when not a plugin, or not set. */
  enabled: boolean | null;
  /** Who sees it: these accounts (or every account of its agent) in these projects (or all). */
  accountIds: string[] | 'all';
  projectIds: string[] | 'all';
  bytes: number;
  files: number;
  modified: number;
  /** In a place the owner manages by hand, so Wanigan may remove it on request. */
  removable: boolean;
}

export interface SkillGroup {
  id: string;
  agent: SkillAgent;
  source: SkillSource;
  title: string;
  /** The account it belongs to, by label, when it belongs to one. */
  account: string | null;
  projectId: string | null;
  /** The folder this group reads, as the owner would type it. */
  where: string;
  note: string | null;
  skills: Skill[];
}

export interface SkillsListing {
  groups: SkillGroup[];
  /** Places looked in that hold no skills, as the owner would type them. */
  empty: { agent: SkillAgent; where: string }[];
  notes: string[];
}

/** Where a copy goes: a project, or the owner's own skills for an agent (and account, for Claude). */
export interface SkillTarget {
  agent: SkillAgent;
  projectId?: string | null;
  accountId?: string | null;
}

export interface SkillCopyPlan {
  /** Fingerprint of exactly what will be written. Applying a different plan is refused. */
  planId: string;
  skillId: string;
  name: string;
  dest: string;
  displayDest: string;
  /** Paths relative to the new folder, in write order. */
  files: { path: string; bytes: number }[];
  skipped: { path: string; why: string }[];
  totalBytes: number;
  /** What is already at the destination; it is moved to Wanigan's trash, never deleted. */
  replaces: { files: number; linkedTo: string | null } | null;
  /** The destination is inside a project folder. */
  inProject: boolean;
}

export interface SkillRead {
  skill: Skill;
  text: string;
  truncated: boolean;
}

/** A folder name a skill may have: no separators, no dot-dot, nothing hidden. */
export const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type Frontmatter = Record<string, string | string[]>;

/**
 * A small reader for SKILL.md frontmatter: a flat map of scalars and short
 * lists, with wrapped and block (`>`, `|`) values. Anything else is skipped
 * rather than guessed at. A real YAML parser would be a dependency bought to
 * read two keys.
 */
export function parseFrontmatter(text: string): { data: Frontmatter; body: string } {
  const normal = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  if (!normal.startsWith('---\n')) return { data: {}, body: normal };
  const end = normal.indexOf('\n---', 3);
  if (end === -1) return { data: {}, body: normal };
  const block = normal.slice(4, end);
  const after = normal.indexOf('\n', end + 4);
  const body = after === -1 ? '' : normal.slice(after + 1);
  const data: Frontmatter = {};
  let key: string | null = null;
  let block_: '>' | '|' | null = null;
  for (const raw of block.split('\n')) {
    const line = raw.trimEnd();
    const top = /^([A-Za-z0-9_-]+):(?:\s+(.*))?$/.exec(line);
    if (top && !/^\s/.test(line)) {
      key = top[1] as string;
      const value = (top[2] ?? '').trim();
      block_ = /^[>|][+-]?$/.test(value) ? (value[0] as '>' | '|') : null;
      data[key] = block_ ? '' : unquote(value);
      continue;
    }
    if (!key || !line.trim() || line.trim().startsWith('#')) {
      if (key && block_ === '|' && !line.trim()) data[key] = `${data[key] as string}\n`;
      continue;
    }
    const item = /^\s+-\s+(.*)$/.exec(line);
    const prev = data[key];
    if (item && !block_) {
      const items = Array.isArray(prev) ? prev : prev ? [prev] : [];
      items.push(unquote(item[1] as string));
      data[key] = items;
      continue;
    }
    if (Array.isArray(prev)) {
      prev[prev.length - 1] += ` ${line.trim()}`;
    } else {
      const joiner = block_ === '|' ? '\n' : ' ';
      data[key] = prev ? `${prev}${prev.endsWith('\n') ? '' : joiner}${line.trim()}` : line.trim();
    }
  }
  for (const [k, v] of Object.entries(data)) if (typeof v === 'string') data[k] = v.trim();
  return { data, body };
}

function unquote(v: string): string {
  const t = v.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1).replace(/''/g, "'");
  }
  return t;
}

/** The text of one frontmatter key, or ''. */
export function frontmatterText(data: Frontmatter, key: string): string {
  const v = data[key];
  return typeof v === 'string' ? v : Array.isArray(v) ? v.join(', ') : '';
}

/** A description for a skill that has none: its first line of prose. */
export function firstProse(body: string): string {
  let fenced = false;
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (t.startsWith('```')) { fenced = !fenced; continue; }
    if (fenced || !t || t.startsWith('#') || t.startsWith('>') || t.startsWith('|') || t.startsWith('<')) continue;
    return t.length > 240 ? `${t.slice(0, 237)}…` : t;
  }
  return '';
}
