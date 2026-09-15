/**
 * Where a session's money went inside the session: the main conversation, its
 * subagents, or the CLI's own background calls — and which skill, plugin, MCP
 * server or subagent each dollar was attributed to.
 *
 * Claude Code attaches these to its `cost.usage` and `token.usage` metrics
 * itself. Read out of the 2.1.270 binary (2026-09-14): `query_source` is main
 * for the REPL thread and SDK, subagent for `agent:*` and hook agents, and
 * auxiliary for everything else; `agent.name`, `skill.name`, `plugin.name` and
 * `mcp_server.name` come with them. The CLI withholds a name it does not
 * consider its own to log — a user-defined agent or MCP server reads `custom`,
 * a plugin from an unlisted marketplace and its skills read `third-party` —
 * unless OTEL_LOG_TOOL_DETAILS=1 is in the environment the session inherited;
 * Wanigan never sets it. Those two words are therefore a group of their own
 * here, never a skill called "custom".
 *
 * The dollars are the CLI's estimate at list price, exactly as the rest of the
 * session spend on the Insights page is.
 */

export type SpendDimension = 'source' | 'skill' | 'plugin' | 'mcp' | 'agent';

export const SPEND_DIMENSIONS: readonly SpendDimension[] = ['source', 'skill', 'plugin', 'mcp', 'agent'];

/** One aggregated row as main reads it out of session_spend_sources. */
export type SpendSourceRow = {
  metric: 'cost' | 'tokens';
  /** For tokens: input, output, cacheRead or cacheCreation, as the CLI spells them. Empty for cost. */
  tokenType: string;
  querySource: string;
  agent: string;
  skill: string;
  plugin: string;
  mcpServer: string;
  value: number;
  /**
   * The session ran on a backend nobody bills at the price the CLI computed
   * from — a GLM or DeepSeek plan, a provider pack. Its tokens are real; its
   * dollars are arithmetic about a model nobody is charging for.
   */
  unverified: boolean;
};

export type SpendSourceGroup = {
  /** The attribute exactly as the CLI sent it; empty when the metric carried none. */
  key: string;
  costUsd: number;
  unverifiedUsd: number;
  inTokens: number;
  outTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export type SpendSourceReport = {
  days: number;
  since: number;
  groups: Record<SpendDimension, SpendSourceGroup[]>;
  totals: Omit<SpendSourceGroup, 'key'>;
  /** Rows in the window before grouping; zero is the empty state, not a zero bill. */
  rows: number;
};

function keyOf(row: SpendSourceRow, dimension: SpendDimension): string {
  switch (dimension) {
    case 'source': return row.querySource;
    case 'skill': return row.skill;
    case 'plugin': return row.plugin;
    case 'mcp': return row.mcpServer;
    case 'agent': return row.agent;
  }
}

function blank(key: string): SpendSourceGroup {
  return { key, costUsd: 0, unverifiedUsd: 0, inTokens: 0, outTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

/** Token types are matched on a case- and separator-free form, as otel.ts reads them. */
function tokenBucket(type: string): 'in' | 'out' | 'read' | 'write' | null {
  switch (type.toLowerCase().replace(/[^a-z0-9]/g, '')) {
    case 'input': return 'in';
    case 'output': return 'out';
    case 'cacheread': return 'read';
    case 'cachecreation': case 'cachewrite': return 'write';
    default: return null;
  }
}

function add(target: SpendSourceGroup, row: SpendSourceRow): void {
  if (row.metric === 'cost') {
    if (row.unverified) target.unverifiedUsd += row.value;
    else target.costUsd += row.value;
    return;
  }
  switch (tokenBucket(row.tokenType)) {
    case 'in': target.inTokens += row.value; break;
    case 'out': target.outTokens += row.value; break;
    case 'read': target.cacheReadTokens += row.value; break;
    case 'write': target.cacheWriteTokens += row.value; break;
  }
}

function tidy(g: SpendSourceGroup): SpendSourceGroup {
  return {
    ...g,
    inTokens: Math.round(g.inTokens), outTokens: Math.round(g.outTokens),
    cacheReadTokens: Math.round(g.cacheReadTokens), cacheWriteTokens: Math.round(g.cacheWriteTokens),
  };
}

/**
 * The same rows grouped along one attribute, dearest first, then by tokens.
 *
 * Every row lands in exactly one group of every dimension — the empty key is a
 * group too — so each dimension's groups add back to the same total. A table
 * that dropped unattributed spend would make the attributed rows read as the
 * whole bill.
 */
export function groupSpend(rows: readonly SpendSourceRow[], dimension: SpendDimension): SpendSourceGroup[] {
  const byKey = new Map<string, SpendSourceGroup>();
  for (const row of rows) {
    const key = keyOf(row, dimension);
    const group = byKey.get(key) ?? blank(key);
    add(group, row);
    byKey.set(key, group);
  }
  return [...byKey.values()].map(tidy).sort((a, b) =>
    (b.costUsd + b.unverifiedUsd) - (a.costUsd + a.unverifiedUsd)
    || (b.inTokens + b.outTokens) - (a.inTokens + a.outTokens)
    || a.key.localeCompare(b.key));
}

export function spendReport(rows: readonly SpendSourceRow[], days: number, since: number): SpendSourceReport {
  const totals = blank('');
  for (const row of rows) add(totals, row);
  const { key: _key, ...rest } = tidy(totals);
  const groups = {} as Record<SpendDimension, SpendSourceGroup[]>;
  for (const d of SPEND_DIMENSIONS) groups[d] = groupSpend(rows, d);
  return { days, since, groups, totals: rest, rows: rows.length };
}

/**
 * What a group's key means in words. The two withheld-name spellings are said
 * as what they are, and the empty key says which absence it is — a metric from
 * before the CLI attached query_source is not "main".
 */
export function spendKeyLabel(dimension: SpendDimension, key: string): string {
  if (key === 'custom') return 'custom — name withheld by the CLI';
  if (key === 'third-party') return 'third-party — name withheld by the CLI';
  if (key !== '') return key;
  switch (dimension) {
    case 'source': return 'not reported';
    case 'skill': return 'no skill';
    case 'plugin': return 'no plugin';
    case 'mcp': return 'no MCP server';
    case 'agent': return 'no subagent';
  }
}
