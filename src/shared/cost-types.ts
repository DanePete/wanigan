/**
 * Shapes the cost, quota and context surfaces hand across IPC. Kept apart from
 * types.ts so this package's additions do not interleave with every other
 * feature's in the one file everyone edits.
 */
import type { CodexChain, ProjectionBudgetVerdict, SkillBudget } from './codex-loader';

export type CodexSkillRow = {
  name: string;
  description: string;
  path: string;
  dir: string;
  /** Which root Codex found it in. */
  root: 'project' | 'personal' | 'codex-home';
  /** policy.allow_implicit_invocation from agents/openai.yaml; null when absent (Codex's default: allowed). */
  implicit: boolean | null | 'unknown';
  /** Whether its name and description are put in front of the model each turn. */
  listed: boolean;
  /** Estimated tokens its listing line costs. 0 when not listed. */
  estTokens: number;
};

export type CodexLoaderReport = {
  projectRoot: string;
  codexHome: string;
  accountLabel: string | null;
  homeSource: 'account' | 'environment' | 'default';
  configPath: string;
  configExists: boolean;
  maxBytes: number;
  maxBytesFrom: 'config' | 'default';
  fallbacks: string[];
  rootMarkers: string[];
  rootDir: string | null;
  chain: CodexChain;
  /** The Codex home's own AGENTS.md: the user's instructions, not counted against the project budget. */
  global: { path: string; name: string; bytes: number } | null;
  model: string | null;
  contextWindow: number | null;
  contextWindowSource: string | null;
  skillBudget: SkillBudget;
  skills: CodexSkillRow[];
  listedSkills: number;
  listedTokens: number;
  notes: string[];
};

export type ReferenceIssue = {
  file: string;
  line: number;
  kind: 'path' | 'command';
  text: string;
  /** For a path: the closest tracked file, if any. For a command: null. */
  suggestion: string | null;
};

export type ReferenceLintReport = {
  files: { path: string; harness: 'claude-code' | 'codex' | 'both'; references: number }[];
  issues: ReferenceIssue[];
  /** False when git ls-files could not be read: paths were still checked on disk, without suggestions. */
  tracked: boolean;
  note: string;
};

export type AgentDefinitionRow = {
  name: string;
  description: string;
  path: string;
  scope: 'user' | 'project' | 'plugin';
  plugin: string | null;
  model: string | null;
  /** `omitClaudeMd: true` in frontmatter: loads no user, project or local CLAUDE.md. */
  omitClaudeMd: boolean | 'unknown';
};

export type AgentDefinitionsReport = {
  agents: AgentDefinitionRow[];
  /** The CLI version the omitClaudeMd key was verified in, and whether the installed CLI is at or past it. */
  keySince: string;
  installedVersion: string | null;
  supported: boolean | null;
  note: string;
};

/** The Codex budget verdict for one candidate and provider, as the review inbox shows it. */
export type ProjectionBudgetView =
  | { applies: false; reason: string }
  | ({ applies: true; target: string; kind: 'agents-md' | 'skill' | 'user-instructions' } & ProjectionBudgetVerdict);

export type SkillListingRow = {
  harness: 'claude-code' | 'codex';
  name: string;
  description: string;
  path: string;
  /** Catalogue source for Claude Code; root for Codex. */
  source: string;
  /** Put in front of the model each turn; 'unknown' when the setting could not be read (counted as listed). */
  listed: boolean | 'unknown';
  decidedBy: 'disable-model-invocation' | 'allow_implicit_invocation' | 'skillOverrides' | 'default';
  personal: boolean;
  /** An applied Wanigan projection wrote this skill. */
  managed: boolean;
  /** The switch is offered: personal and managed. */
  toggle: boolean;
  estTokens: number;
};

export type SkillListingReport = {
  providers: {
    harness: 'claude-code' | 'codex';
    label: string;
    listed: number;
    hidden: number;
    unknown: number;
    estTokens: number;
    rows: SkillListingRow[];
  }[];
  codexHome: string;
  note: string;
};

export type CodexCreditsReport = {
  days: number;
  rateCard: { source: string; readOn: string; fastMultiplier: number; models: Record<string, { input: number; cached: number; output: number }> };
  sessions: {
    sessionId: string;
    title: string | null;
    projectName: string | null;
    startedAt: number;
    /** `auth_mode` from the account's auth.json: 'chatgpt' for a plan, 'apikey' for an API key, null when unread. */
    authMode: string | null;
    tokens: { input: number; cached: number; output: number } | null;
    estimate: import('./codex-credits').CreditEstimate;
  }[];
  totalCredits: number;
  /** The same total with every tier-changed session at its all-Fast bound. */
  upperCredits: number;
  estimatedSessions: number;
  tierNotRecorded: number;
  unestimated: number;
};

export type CacheWarmthFacts = {
  supported: boolean;
  reason: string | null;
  /** The last Stop hook, else the last recorded request. */
  lastTurnEndedAt: number | null;
  /** input + cache read + cache write of the last recorded request. */
  contextTokens: number | null;
  ttl: import('./cache-warmth').CacheTtl;
};

export type CostCausesReport = {
  days: number;
  idle: {
    conversations: (import('./cost-causes').IdleGapRewrite & { sessionId: string | null; live: boolean; title: string | null; where: string | null })[];
    gaps: number;
    cappedTokens: number;
    uncappedTokens: number;
    requestsRead: number;
    truncated: boolean;
  };
  reads: {
    rows: (import('./cost-causes').RepeatedRead & { live: boolean; title: string | null; where: string | null })[];
    files: number;
    sessions: number;
    /** Reads past the second, summed over every flagged file. */
    extraReads: number;
  };
  mcp: { days: number; configured: number; unused: import('./cost-causes').McpServerUse[]; hooklessNote: string };
  cacheMiss: {
    recorded: boolean;
    types: { type: string; count: number }[];
    missedTokens: number | null;
    transcriptsScanned: number;
    sessionsConsidered: number;
    cliVersions: string[];
    sessions: { sessionId: string; live: boolean; title: string | null; where: string; types: Record<string, number> }[];
    note: string;
  };
};
