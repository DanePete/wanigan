import type http from 'node:http';
// `../control` is the durable work control plane: dockets, their task graph and
// the evidence recorded against them. `./control`, in this same directory, is
// the phone's remote-control bridge and is an unrelated module that happens to
// share a basename. The two dots are the only thing telling them apart, so it
// is worth reading the import twice before editing either.
import { docket as goalRecord, listDockets } from '../control';
import { MAX_DOCKET_NODE_DEPENDENCIES, MAX_DOCKET_PLAN_NODES } from '../../shared/types';
import type { DocketAutopilot, DocketDetail, DocketNodeKind, WorkDocket } from '../../shared/types';
import { json, registerApiRoute, send } from './dispatch';
import { safeString } from './snapshot';

/**
 * A goal on the phone: its contract, the shape of its task graph, and the
 * evidence recorded against it.
 *
 * Reading only. Nothing here starts a task, approves a review, arms unattended
 * dispatch or sets a cap — those are decisions with money and a working tree
 * behind them, and they stay at the Mac. A phone screen that offered them would
 * be offering them from the device least able to check what it was agreeing to.
 *
 * Three things the desktop already says carefully, which this wire must not
 * flatten on its way to a smaller screen:
 *
 *  - **'blocked' means two different things.** control.ts derives a task's
 *    readiness from stored rows on every read, and writes 'blocked' both for a
 *    task whose prerequisite failed or was canceled and for one whose
 *    prerequisite simply has not finished. The operator's next move differs —
 *    reopen the failed task, or wait — so every task carries the prerequisites
 *    it waits on with each of their statuses, and a `hold` naming which of the
 *    two situations produced the word. Neither is a second vocabulary: the
 *    statuses are control.ts's own, and the split is the one Control.tsx draws.
 *  - **A goal with no base commit reports the absence.** A null base commit has
 *    several causes — no repository, a repository with no commit yet, a git read
 *    that failed — and nothing here can tell them apart, so the absence crosses
 *    as an absence and the page names it without diagnosing it.
 *  - **Spend carries how much of it was reported.** `spendUsd` counts only
 *    provider-reported cost, so a cap enforced against it is a weaker promise
 *    than it looks; `spendStatus` is what lets the page say which promise it is
 *    showing rather than printing a number that reads like a measurement.
 *
 * No file path crosses this route. A task's claim path is project-relative and
 * would be safe to send, but `grep "scope: 'repo'"` in ./dispatch is meant to be
 * the complete list of routes that can put a path on this wire, and the Git
 * screen says in its own served bytes that no other screen sends one. Making
 * both of those sentences false to save an operator a trip to the Mac is a bad
 * trade, so a task reports *that* it declares or holds a claim and the path
 * itself stays behind. Worktrees, session ids and provider conversation ids
 * never cross at all, which is the same promise ./snapshot makes for the fleet.
 *
 * Every field is rebuilt explicitly from an allow-list, like ./snapshot: the
 * records here are main-process objects and structural typing lets a caller
 * hold extra properties on them, so spreading one is exactly how a worktree
 * path reaches a phone without anyone deciding it should.
 */

/**
 * How many goals one list carries. The desktop asks for eighty; a phone is
 * reading a list it scrolls with a thumb, and each row already costs
 * control.ts a spend aggregate over that goal's sessions.
 */
const MAX_GOALS = 20;
/**
 * A docket cannot hold more tasks than this — buildPlan refuses past it — so
 * the cap is the graph's own ceiling rather than a second, tighter one that
 * would cut a legal graph in half. The count that was left out still travels,
 * because a row written before that rule exists.
 */
const MAX_TASKS = MAX_DOCKET_PLAN_NODES;
const MAX_PREREQUISITES = MAX_DOCKET_NODE_DEPENDENCIES;
const MAX_ACCEPTANCE = 20;
const MAX_PROOFS = 12;
const MAX_CHECKPOINTS = 8;

/** Prose caps. Past these the remainder is counted and named, never dropped in silence. */
const OBJECTIVE_CHARS = 1_200;
const INSTRUCTION_CHARS = 600;
const LINE_CHARS = 240;

/** A backstop under the caps above, not the thing that normally bounds a reply. */
const MAX_JSON_BYTES = 128 * 1024;

const READ_FAILED = 'The Mac answered, but its record of your goals would not open.';

/**
 * A bounded piece of an operator's or an agent's prose, with what was left
 * behind counted rather than quietly cut.
 *
 * A docket carries instructions written for an agent, and those run to
 * thousands of characters. Trimming one to fit a phone produces a paragraph
 * that ends mid-sentence and reads exactly like a paragraph that ended, which
 * is the same lie a truncated diff would tell on the Git screen.
 */
export type MobileGoalText = { text: string; omitted: number };

export type MobileGoalStatus =
  | 'draft' | 'executing' | 'review' | 'accepted' | 'rejected' | 'blocked' | 'unknown';
export type MobileGoalRisk = 'low' | 'elevated' | 'high';
export type MobileGoalTaskStatus =
  | 'pending' | 'ready' | 'running' | 'completed' | 'failed' | 'canceled' | 'blocked' | 'unknown';

/**
 * Why a task is blocked, when the graph can say.
 *
 * 'prerequisite-failed' is the one an operator can act on — a task upstream
 * failed or was canceled and somebody has to reopen it — and
 * 'prerequisite-unfinished' is the one where waiting is the whole answer. null
 * covers both a task that is not blocked and a task whose stored status says
 * blocked while its prerequisites all completed: that last one is a fact about
 * the row rather than about the graph, and inventing a cause for it would be
 * this module diagnosing something it cannot see.
 */
export type MobileGoalHold = 'prerequisite-failed' | 'prerequisite-unfinished' | null;

export type MobileGoalPrerequisite = { title: string; status: MobileGoalTaskStatus };

export type MobileGoalTask = {
  kind: DocketNodeKind;
  title: string;
  status: MobileGoalTaskStatus;
  hold: MobileGoalHold;
  waitsOn: MobileGoalPrerequisite[];
  /** Prerequisites that resolved but did not fit the cap above. */
  waitsOnOmitted: number;
  /** Prerequisite ids this goal no longer lists. They count as unfinished, as control.ts counts them. */
  waitsOnUnlisted: number;
  instructions: MobileGoalText;
  /** Whether this task named a path at planning time. The path itself stays on the Mac. */
  declaresClaim: boolean;
  /** Whether it is holding that claim right now. */
  holdsClaim: boolean;
  providerId: string | null;
  model: string | null;
  startedAt: number | null;
  endedAt: number | null;
  /** The note recorded when the task was completed or failed, if there is one. */
  detail: MobileGoalText | null;
};

/** What one goal has spent and how far its cap actually reaches. */
export type MobileGoalSpend = {
  armed: boolean;
  /** Whether unattended dispatch ever stopped itself here. It outlives a re-arm on purpose. */
  halted: boolean;
  capUsd: number | null;
  spendUsd: number;
  spendStatus: DocketAutopilot['spendStatus'];
};

export type MobileGoalAutopilot = MobileGoalSpend & {
  providerId: string | null;
  model: string | null;
  haltedReason: MobileGoalText | null;
  haltedAt: number | null;
};

export type MobileGoalSummary = {
  id: string;
  title: string;
  projectName: string;
  status: MobileGoalStatus;
  risk: MobileGoalRisk;
  updatedAt: number;
  spend: MobileGoalSpend;
};

export type MobileGoalProof = {
  kind: 'plan' | 'test' | 'diff' | 'review' | 'decision' | 'unknown';
  status: 'recorded' | 'passed' | 'failed' | 'unknown';
  summary: MobileGoalText;
  taskTitle: string | null;
  createdAt: number;
};

export type MobileGoalCheckpoint = {
  note: MobileGoalText;
  taskTitle: string | null;
  repoCommit: string | null;
  /** Whether a provider conversation was recorded. The id itself never crosses. */
  thread: boolean;
  createdAt: number;
};

export type MobileGoalDetail = {
  id: string;
  title: string;
  projectName: string;
  status: MobileGoalStatus;
  risk: MobileGoalRisk;
  createdAt: number;
  updatedAt: number;
  objective: MobileGoalText;
  acceptance: MobileGoalText[];
  acceptanceOmitted: number;
  /** null means no base commit was recorded. It is not a diagnosis. */
  baseCommit: string | null;
  autopilot: MobileGoalAutopilot;
  tasks: MobileGoalTask[];
  tasksOmitted: number;
  /** Paths held right now by this goal's tasks, as a count. The paths stay on the Mac. */
  claimsHeld: number;
  proofs: MobileGoalProof[];
  proofsOmitted: number;
  checkpoints: MobileGoalCheckpoint[];
  checkpointsOmitted: number;
};

export type MobileGoalsPayload = {
  generatedAt: number;
  goals: MobileGoalSummary[];
  /**
   * Whether the Mac holds goals older than the ones sent. It is a flag rather
   * than a count on purpose: counting every goal on the Mac would mean reading
   * every goal on the Mac, and a number that is really "how many we looked at"
   * would be read as "how many there are".
   */
  truncated: boolean;
};

export type MobileGoalPayload = { generatedAt: number; goal: MobileGoalDetail };

/**
 * The stored words, mapped onto what the phone is allowed to claim.
 *
 * Maps rather than object literals, for ./manage-runs' reason: a status read
 * out of a row is a string, and `constructor` or `toString` resolving to
 * something inherited from Object.prototype would be a lookup hit that never
 * came from this table. control.ts casts these columns to their unions without
 * checking them, so an unfamiliar value is real and arrives here as 'unknown'
 * rather than as whichever member of the union happens to be first.
 */
const GOAL_STATUSES = new Map<string, MobileGoalStatus>([
  ['draft', 'draft'], ['executing', 'executing'], ['review', 'review'],
  ['accepted', 'accepted'], ['rejected', 'rejected'], ['blocked', 'blocked'],
]);
const TASK_STATUSES = new Map<string, MobileGoalTaskStatus>([
  ['pending', 'pending'], ['ready', 'ready'], ['running', 'running'], ['completed', 'completed'],
  ['failed', 'failed'], ['canceled', 'canceled'], ['blocked', 'blocked'],
]);
const TASK_KINDS = new Map<string, DocketNodeKind>([
  ['plan', 'plan'], ['implement', 'implement'], ['verify', 'verify'], ['review', 'review'],
]);
const PROOF_KINDS = new Map<string, MobileGoalProof['kind']>([
  ['plan', 'plan'], ['test', 'test'], ['diff', 'diff'], ['review', 'review'], ['decision', 'decision'],
]);
const PROOF_STATUSES = new Map<string, MobileGoalProof['status']>([
  ['recorded', 'recorded'], ['passed', 'passed'], ['failed', 'failed'],
]);
const RISKS = new Map<string, MobileGoalRisk>([
  ['low', 'low'], ['elevated', 'elevated'], ['high', 'high'],
]);
const SPEND_STATUSES = new Map<string, DocketAutopilot['spendStatus']>([
  ['reported', 'reported'], ['partial', 'partial'], ['unreported', 'unreported'], ['none', 'none'],
]);

/** A prerequisite whose stored status means the task above it cannot proceed until someone acts. */
const DEAD: ReadonlySet<MobileGoalTaskStatus> = new Set(['failed', 'canceled']);

function finite(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function money(value: unknown): number {
  return Math.max(0, finite(value));
}

function stamp(value: unknown): number {
  return Math.max(0, Math.round(finite(value)));
}

/**
 * ./snapshot's sanitiser, with the remainder counted instead of dropped.
 *
 * safeString is still the only thing that decides which characters may leave
 * this process — this asks it for the whole flattened string first, so
 * `omitted` describes what the phone did not get rather than what survived a
 * silent slice.
 */
function clip(value: unknown, max: number): MobileGoalText {
  const whole = safeString(value, Number.MAX_SAFE_INTEGER);
  return whole.length <= max
    ? { text: whole, omitted: 0 }
    : { text: whole.slice(0, max), omitted: whole.length - max };
}

function autopilotOf(auto: DocketAutopilot): MobileGoalAutopilot {
  const raw = auto as DocketAutopilot & Record<string, unknown>;
  const reason = raw.haltedReason === null || raw.haltedReason === undefined
    ? null
    : clip(raw.haltedReason, LINE_CHARS);
  return {
    armed: raw.enabled === true,
    halted: reason !== null,
    capUsd: raw.budgetUsd === null || raw.budgetUsd === undefined ? null : money(raw.budgetUsd),
    spendUsd: money(raw.spendUsd),
    spendStatus: SPEND_STATUSES.get(String(raw.spendStatus)) ?? 'none',
    providerId: raw.providerId ? safeString(raw.providerId, 100) || null : null,
    model: raw.model ? safeString(raw.model, 120) || null : null,
    haltedReason: reason,
    haltedAt: raw.haltedAt === null || raw.haltedAt === undefined ? null : stamp(raw.haltedAt) || null,
  };
}

function summaryOf(record: WorkDocket): MobileGoalSummary {
  const raw = record as WorkDocket & Record<string, unknown>;
  const auto = autopilotOf(raw.autopilot as DocketAutopilot);
  return {
    id: safeString(raw.id, 120),
    title: safeString(raw.title, 160, 'Untitled goal'),
    projectName: safeString(raw.projectName, 160, 'Unknown project'),
    status: GOAL_STATUSES.get(String(raw.status)) ?? 'unknown',
    // 'elevated' is control.ts's own fallback for a risk it does not recognise,
    // and the two surfaces have to say the same word about the same row.
    risk: RISKS.get(String(raw.risk)) ?? 'elevated',
    updatedAt: stamp(raw.updatedAt),
    spend: {
      armed: auto.armed, halted: auto.halted, capUsd: auto.capUsd,
      spendUsd: auto.spendUsd, spendStatus: auto.spendStatus,
    },
  };
}

/**
 * One task, with what it waits on and how each of those stands.
 *
 * The hold is derived from every prerequisite, including the ones that did not
 * fit the list and the ones whose id no longer resolves — control.ts counts an
 * unresolvable dependency as unmet, and a phone that called such a task ready
 * would be describing a different graph.
 */
function taskOf(node: DocketDetail['nodes'][number], byId: Map<string, DocketDetail['nodes'][number]>, holding: ReadonlySet<string>): MobileGoalTask {
  const raw = node as typeof node & Record<string, unknown>;
  const status = TASK_STATUSES.get(String(raw.status)) ?? 'unknown';
  const dependsOn = Array.isArray(raw.dependsOn) ? raw.dependsOn.filter((id): id is string => typeof id === 'string') : [];

  const resolved: MobileGoalPrerequisite[] = [];
  let unlisted = 0;
  let failedAbove = false;
  let unfinishedAbove = false;
  for (const id of dependsOn) {
    const dep = byId.get(id);
    if (!dep) { unlisted += 1; unfinishedAbove = true; continue; }
    const depStatus = TASK_STATUSES.get(String(dep.status)) ?? 'unknown';
    if (DEAD.has(depStatus)) failedAbove = true;
    else if (depStatus !== 'completed') unfinishedAbove = true;
    resolved.push({ title: safeString(dep.title, 160, 'Untitled task'), status: depStatus });
  }

  const detail = raw.detail === null || raw.detail === undefined ? null : clip(raw.detail, LINE_CHARS);
  return {
    kind: TASK_KINDS.get(String(raw.kind)) ?? 'implement',
    title: safeString(raw.title, 160, 'Untitled task'),
    status,
    hold: status !== 'blocked' ? null
      : failedAbove ? 'prerequisite-failed'
      : unfinishedAbove ? 'prerequisite-unfinished'
      : null,
    waitsOn: resolved.slice(0, MAX_PREREQUISITES),
    waitsOnOmitted: Math.max(0, resolved.length - MAX_PREREQUISITES),
    waitsOnUnlisted: unlisted,
    instructions: clip(raw.instructions, INSTRUCTION_CHARS),
    // The path is deliberately absent; see the note at the top of this file.
    declaresClaim: typeof raw.claimPath === 'string' && raw.claimPath.length > 0,
    holdsClaim: typeof raw.id === 'string' && holding.has(raw.id),
    providerId: raw.providerId ? safeString(raw.providerId, 100) || null : null,
    model: raw.model ? safeString(raw.model, 120) || null : null,
    startedAt: raw.startedAt === null || raw.startedAt === undefined ? null : stamp(raw.startedAt) || null,
    endedAt: raw.endedAt === null || raw.endedAt === undefined ? null : stamp(raw.endedAt) || null,
    detail: detail && detail.text ? detail : null,
  };
}

/**
 * One goal, rebuilt for the wire.
 *
 * Exported so the offline suite can assert on the shape without an HTTP round
 * trip: the two facts worth holding to — that a task held by a failure reads
 * differently from one that is merely waiting, and that no absolute path is in
 * here — are properties of this function rather than of the transport.
 */
export function mobileGoal(record: DocketDetail): MobileGoalDetail {
  const raw = record as DocketDetail & Record<string, unknown>;
  const nodes = Array.isArray(raw.nodes) ? raw.nodes : [];
  const byId = new Map(nodes.filter((node) => typeof node?.id === 'string').map((node) => [node.id, node]));
  const claims = Array.isArray(raw.claims) ? raw.claims : [];
  const held = claims.filter((claim) => claim && claim.releasedAt === null);
  const holding = new Set(held.map((claim) => claim.nodeId).filter((id): id is string => typeof id === 'string'));

  const titleFor = (nodeId: unknown): string | null => {
    const node = typeof nodeId === 'string' ? byId.get(nodeId) : undefined;
    return node ? safeString(node.title, 160, 'Untitled task') : null;
  };

  const acceptance = Array.isArray(raw.acceptance)
    ? raw.acceptance.filter((check): check is string => typeof check === 'string')
    : [];
  const proofs = Array.isArray(raw.proofs) ? raw.proofs : [];
  const checkpoints = Array.isArray(raw.checkpoints) ? raw.checkpoints : [];

  return {
    ...summaryOf(record),
    createdAt: stamp(raw.createdAt),
    objective: clip(raw.objective, OBJECTIVE_CHARS),
    acceptance: acceptance.slice(0, MAX_ACCEPTANCE).map((check) => clip(check, LINE_CHARS)),
    acceptanceOmitted: Math.max(0, acceptance.length - MAX_ACCEPTANCE),
    // A commit is a fact about the repository's history, not a location on this
    // disk, so it crosses whole. Null crosses as null: the causes of a missing
    // base commit are not distinguishable from here.
    baseCommit: typeof raw.baseCommit === 'string' && raw.baseCommit ? safeString(raw.baseCommit, 64) || null : null,
    autopilot: autopilotOf(raw.autopilot as DocketAutopilot),
    tasks: nodes.slice(0, MAX_TASKS).map((node) => taskOf(node, byId, holding)),
    tasksOmitted: Math.max(0, nodes.length - MAX_TASKS),
    claimsHeld: held.length,
    proofs: proofs.slice(0, MAX_PROOFS).map((proof) => ({
      kind: PROOF_KINDS.get(String(proof?.kind)) ?? 'unknown',
      status: PROOF_STATUSES.get(String(proof?.status)) ?? 'unknown',
      summary: clip(proof?.summary, LINE_CHARS),
      taskTitle: titleFor(proof?.nodeId),
      createdAt: stamp(proof?.createdAt),
    })),
    proofsOmitted: Math.max(0, proofs.length - MAX_PROOFS),
    checkpoints: checkpoints.slice(0, MAX_CHECKPOINTS).map((point) => ({
      note: clip(point?.note, LINE_CHARS),
      taskTitle: titleFor(point?.nodeId),
      repoCommit: typeof point?.repoCommit === 'string' && point.repoCommit ? safeString(point.repoCommit, 64) || null : null,
      // The id would identify a provider thread and has no use on a screen that
      // cannot open one. Whether a checkpoint can be resumed exactly is the part
      // an operator away from the Mac actually needs, so that is what travels.
      thread: typeof point?.conversationId === 'string' && point.conversationId.length > 0,
      createdAt: stamp(point?.createdAt),
    })),
    checkpointsOmitted: Math.max(0, checkpoints.length - MAX_CHECKPOINTS),
  };
}

/**
 * The goal list, newest first.
 *
 * Exported alongside mobileGoal for the same reason: the list is where a
 * goal's spend reaches a phone, and an assertion about that belongs against the
 * function that builds it.
 */
export function mobileGoals(limit = MAX_GOALS): MobileGoalsPayload {
  const max = Math.max(1, Math.min(MAX_GOALS, Math.round(limit)));
  // One more than the cap, so the page can say a list is shortened without
  // this route reading every goal on the Mac to count them.
  const records = listDockets(null, max + 1);
  return {
    generatedAt: Date.now(),
    goals: records.slice(0, max).map(summaryOf),
    truncated: records.length > max,
  };
}

function serveJson(res: http.ServerResponse, body: unknown, what: string): void {
  const text = JSON.stringify(body);
  if (Buffer.byteLength(text) > MAX_JSON_BYTES) {
    // A backstop rather than the usual bound: every list and every piece of
    // prose above is already capped and says what it left out. Reaching this
    // means one of those caps is wrong, and a refusal the operator can read is
    // better than half a task graph that looks whole.
    json(res, 503, { error: `Wanigan could not send ${what} to this device: the reading was larger than this screen accepts.` });
    return;
  }
  send(res, 200, 'application/json; charset=utf-8', text);
}

function serveGoals(res: http.ServerResponse): void {
  try {
    serveJson(res, mobileGoals(), 'your goals');
  } catch {
    // A database error can carry a local path or a table name. The phone needs
    // to know the read failed, not which local byte made it fail.
    json(res, 503, { error: READ_FAILED });
  }
}

function serveGoal(res: http.ServerResponse, url: URL): void {
  const id = safeString(url.searchParams.get('goal'), 120);
  if (!id) { json(res, 400, { error: 'Choose a goal.' }); return; }
  let record: DocketDetail;
  try {
    record = goalRecord(id);
  } catch (error) {
    // control.ts throws this exact sentence for an id that names no row, and
    // matching it is what separates "that goal is gone" from "the database
    // would not open". If the wording there ever changes this degrades to the
    // 503 below, which is the safe direction: it claims less, not more.
    if (error instanceof Error && error.message === 'Goal not found.') {
      json(res, 404, { error: 'Wanigan has no goal with that id. It may have been created on another Mac, or removed.' });
      return;
    }
    json(res, 503, { error: READ_FAILED });
    return;
  }
  try {
    serveJson(res, { generatedAt: Date.now(), goal: mobileGoal(record) } satisfies MobileGoalPayload, 'this goal');
  } catch {
    json(res, 503, { error: READ_FAILED });
  }
}

registerApiRoute({
  path: '/api/goals',
  method: 'GET',
  scope: 'monitor',
  handler: (_req, res) => serveGoals(res),
});

registerApiRoute({
  path: '/api/goal',
  method: 'GET',
  scope: 'monitor',
  handler: (_req, res, url) => serveGoal(res, url),
});
