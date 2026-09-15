import { getSetting, setSetting } from '../settings';
import {
  grantKey, parseGrant, toolGranted, validProfileId, validateGrant,
  type McpToolGrant, type McpToolInfo,
} from '../../shared/mcp-tool-grants';

/**
 * Per-profile grants for Wanigan's own MCP tools, stored and read.
 *
 * A leaf, like capabilities.ts, for the same reason: registry.ts decides at
 * launch whether a session's config carries Wanigan's server at all, and
 * server.ts refuses calls on every request, and neither may import the other.
 * The catalogue below is the tool list server.ts serves; the offline suite
 * holds the two to the same names so a tool added there cannot slip past a
 * grant by being missing here.
 */
export const WANIGAN_TOOL_CATALOGUE: readonly McpToolInfo[] = [
  { name: 'wanigan_estimate_run', title: 'Estimate a batch run', readOnly: true },
  { name: 'wanigan_dry_run', title: 'Dry run one row (costs one request)', readOnly: false },
  { name: 'wanigan_submit_run', title: 'Submit a batch run (spends money, always asks you)', readOnly: false },
  { name: 'wanigan_run_status', title: 'Run status', readOnly: true },
  { name: 'wanigan_fetch_results', title: 'Fetch results', readOnly: true },
  { name: 'wanigan_list_runs', title: 'List runs', readOnly: true },
  { name: 'wanigan_list_goals', title: 'List Goals', readOnly: true },
  { name: 'wanigan_get_goal', title: 'Inspect a Goal', readOnly: true },
  { name: 'wanigan_goal_checkpoint', title: 'Record a Goal checkpoint', readOnly: false },
  { name: 'wanigan_goal_claim', title: 'Claim a Goal file path', readOnly: false },
  { name: 'wanigan_list_projects', title: 'This session’s project', readOnly: true },
  { name: 'wanigan_find_repos', title: 'Find a repository inside this project', readOnly: true },
  { name: 'wanigan_list_sessions', title: 'This session', readOnly: true },
  { name: 'wanigan_start_session', title: 'Start an agent session (always asks you)', readOnly: false },
  { name: 'wanigan_recall_transcripts', title: 'Recall this project’s archived transcripts (only where the project opted in)', readOnly: true },
  /* ── helper sweep · P10 notes ── */
  { name: 'wanigan_annotate_change', title: 'Explain its own change in a note on a hunk (never your notes)', readOnly: false },
  { name: 'wanigan_list_change_notes', title: 'List its own change notes', readOnly: true },
  { name: 'wanigan_withdraw_change_note', title: 'Withdraw one of its own change notes', readOnly: false },
  /* ── end helper sweep · P10 notes ── */
];

const KNOWN = WANIGAN_TOOL_CATALOGUE.map((t) => t.name);

export function toolGrantFor(profileId: string | null | undefined): McpToolGrant {
  if (!validProfileId(profileId)) return parseGrant(null, KNOWN);
  return parseGrant(getSetting(grantKey(profileId), '') || null, KNOWN);
}

/** Both Goal tools a launch capsule tells the agent to call. Offering one it cannot call would be an instruction that fails. */
export function goalToolsGranted(profileId: string | null | undefined): boolean {
  const grant = toolGrantFor(profileId);
  return toolGranted(grant, 'wanigan_goal_checkpoint') && toolGranted(grant, 'wanigan_goal_claim');
}

/* ── helper sweep · P10 notes ── */
/** Whether a launch may tell the agent about change notes: only a profile granted the annotate tool is told it exists. */
export function changeNoteToolGranted(profileId: string | null | undefined): boolean {
  return toolGranted(toolGrantFor(profileId), 'wanigan_annotate_change');
}
/* ── end helper sweep · P10 notes ── */

export function setToolGrant(profileId: unknown, input: unknown): McpToolGrant {
  if (!validProfileId(profileId)) throw new Error('That is not a provider profile id.');
  const grant = validateGrant(input, KNOWN);
  setSetting(grantKey(profileId), JSON.stringify(grant));
  return grant;
}
