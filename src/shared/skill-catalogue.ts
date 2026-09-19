import type { Session, ShadowedSkill, SkillInvocability, SkillProjectionLink, SkillSource } from './types';

export type SkillInfo = {
  /**
   * What the command is keyed by. For personal and project skills that is the
   * DIRECTORY name: the docs say a frontmatter `name` there "sets only the
   * display label shown in skill listings, and the command still comes from
   * the directory name" (docs/en/skills, read 2026-09-05 against CLI 2.1.261).
   * For plugin skills it is the frontmatter name, directory as fallback, and
   * the plugin prefix stays in place.
   */
  name: string;
  /** The display label: frontmatter `name` when present, else `name`. */
  label: string;
  description: string;
  source: SkillSource;
  /** Whose loader reads the root this came from. */
  harness: 'claude-code' | 'codex';
  /** Absolute path to SKILL.md. */
  path: string;
  dir: string;
  /**
   * What you type to invoke it. Plugin skills are namespaced. Empty for the
   * `.agents` family: Wanigan has not verified how Codex invokes one.
   */
  invoke: string;
  plugin: string | null;
  marketplace: string | null;
  projectId: string | null;
  allowedTools: string[];
  /** Helper files shipped alongside the skill, which is a rough proxy for depth. */
  extras: number;
  bytes: number;
  modified: number;
  /** Predicted from SKILL.md frontmatter and skillOverrides; never a runtime fact. */
  invocable: SkillInvocability;
  /** Set when Wanigan's own compiler wrote this file — an applied or stale projection. */
  projection: SkillProjectionLink | null;
};

export type SkillRootStatus = { source: SkillSource; path: string; exists: boolean; note: string | null };

export type SkillCatalogue = {
  /** Claude Code's loader: what `/name` runs, one row per command. */
  skills: SkillInfo[];
  counts: Record<SkillSource, number>;
  /** Where each Claude source was read from, so an empty section is explicable. */
  roots: SkillRootStatus[];
  /** Files present but not the one that runs for their command, and which file shadows them. */
  shadowed: ShadowedSkill[];
  /**
   * The `.agents/skills` family, harness-labelled. Listed as found, in no
   * precedence order: Codex's loader was not consulted, so which of two
   * same-named directories it would prefer is not claimed.
   */
  agentSkills: SkillInfo[];
  agentRoots: SkillRootStatus[];
  scannedAt: number;
};

/** Presentation preflight only. Main re-reads the session and its catalogue before typing. */
export function skillTypingUnavailable(
  skill: Pick<SkillInfo, 'harness' | 'invoke' | 'invocable'>,
  session: Pick<Session, 'harnessId' | 'status' | 'projectId'> | null | undefined,
  projectId: string | undefined,
  stale: boolean,
): string | null {
  if (stale) return 'Rescan successfully before typing a skill into a session.';
  if (skill.harness !== 'claude-code' || !skill.invoke) {
    return 'Found on disk for Codex. Wanigan has not verified its loading order or invocation. Copy its name or read the file.';
  }
  if (skill.invocable.user === false) return 'This skill is configured to prevent manual invocation. You can still read its instructions.';
  if (!session || session.status === 'exited') return 'Select a live Claude Code session to type this command. You can copy it at any time.';
  if (session.harnessId !== 'claude-code') return 'The selected session does not use the verified Claude Code command form. Select a Claude Code session to type this command.';
  if (session.projectId !== projectId) return 'The selected session uses another project. Match the Skills project to that session before typing.';
  return null;
}
