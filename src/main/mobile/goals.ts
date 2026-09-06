import type http from 'node:http';
// `../control` is the durable work control plane: dockets, their task graph and
// the evidence recorded against them. `./control`, in this same directory, is
// the phone's remote-control bridge and is an unrelated module that happens to
// share a basename. The two dots are the only thing telling them apart, so it
// is worth reading the import twice before editing either.
import { completeNode, docket as goalRecord, listDockets } from '../control';
import { MAX_DOCKET_NODE_DEPENDENCIES, MAX_DOCKET_PLAN_NODES } from '../../shared/types';
import type { DocketAutopilot, DocketDetail, DocketNodeKind, WorkDocket } from '../../shared/types';
import { json, registerApiRoute, requestJson, send } from './dispatch';
import { safeString } from './snapshot';

/**
 * A goal on the phone: its contract, the shape of its task graph, the evidence
 * recorded against it, and the one decision a person has to make.
 *
 * Reading, plus exactly one write. Starting a task, arming unattended dispatch
 * and setting a cap stay at the Mac: each of them spends money or a working
 * tree, and a phone is the device least able to check what it is agreeing to.
 * The terminal review node is different in kind. It is the one place in a
 * docket where the record is waiting on a person and nothing else can move it,
 * so a goal stays blocked for exactly as long as that person is away from the
 * desk — which is the situation this surface exists for.
 *
 * The write is deliberately narrow. It carries two ids and one of three
 * verdicts from a closed list, never a state built out of free text; it is
 * refused unless the node is in a state ../control would take a decision in;
 * and the decision itself is recorded by ../control's `completeNode`, the same
 * function the desktop calls. There is no second account here of what approving
 * a review means, and a rule that changes there changes here.
 *
 * Four things the desktop already says carefully, which this wire must not
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
 *  - **The gate result travels with the decision.** control.ts refuses an
 *    approval unless the latest `test` proof of every verification task passed,
 *    so the same proofs are read back out of the record and sent beside the
 *    decision. Approving a review without knowing whether the project's own
 *    checks passed is the failure this screen exists to prevent. What crosses
 *    is evidence and never a verdict: the Mac re-reads those proofs when the
 *    decision arrives, and its refusal — naming the verification tasks still
 *    unproven — is the sentence the operator gets.
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

/**
 * How much of an operator's own note travels *into* the Mac with a decision.
 *
 * control.ts accepts four thousand characters on a completion note and this
 * sends far less, because the two are bounding different things: that cap
 * protects a column, and this one is the length of a note somebody types with a
 * thumb. A longer one is refused rather than trimmed — a decision is durable
 * evidence, and half a sentence recorded against it as if it were the whole
 * reason is a worse record than no note at all.
 */
const NOTE_CHARS = 500;

/**
 * How a decision made from a phone says so in the record.
 *
 * There is no column for the device a decision came from, and inventing one
 * would change the shape of a stored row for a fact that fits in the field
 * ../control already writes. So the provenance goes in the completion note,
 * which is the desktop's own evidence field for a decision and is displayed
 * next to it on both surfaces. The exact bytes are shown on the phone before
 * the decision is sent, so nobody is surprised by prose they did not type.
 */
const PHONE_NOTE_PREFIX = 'From the paired phone: ';
const PHONE_NOTE_ALONE = 'Recorded from the paired phone.';

/** Exported so the offline suite asserts the recorded provenance rather than restating it. */
export const MOBILE_GOAL_DECISION_NOTE = { prefix: PHONE_NOTE_PREFIX, alone: PHONE_NOTE_ALONE } as const;

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

/**
 * What the project's own review gate last said about one verification task.
 *
 * 'not-run' is its own word rather than a missing row: a gate nobody has run
 * and a gate that failed are the two states an operator must never confuse
 * while deciding, and an absent field would render as the safer of them on any
 * screen that forgot to check.
 */
export type MobileGoalGateResult = 'passed' | 'failed' | 'not-run' | 'unknown';

export type MobileGoalGateTask = {
  taskTitle: string;
  result: MobileGoalGateResult;
  /** control.ts's own sentence for that run — 'Review gate failed after 2 command(s).' */
  summary: MobileGoalText | null;
  ranAt: number | null;
};

/**
 * The gate reading for a whole goal.
 *
 * 'no-verification' is not an oversight state, it is a fact about the graph:
 * control.ts refuses an approval outright on a goal with no verification task,
 * and a screen that showed only "no gate result" there would leave the operator
 * reading a missing check where the Mac sees an impossible approval.
 */
export type MobileGoalGateState = 'passed' | 'failed' | 'partial' | 'not-run' | 'no-verification';

export type MobileGoalGate = {
  state: MobileGoalGateState;
  tasks: MobileGoalGateTask[];
  /** Verification tasks past the cap. The graph's own ceiling makes this 0 today. */
  tasksOmitted: number;
  /** The newest gate result on this goal, or null when none has ever run. */
  lastRunAt: number | null;
  /** Verification tasks whose latest gate result is not a pass, by title. */
  unproven: string[];
};

/**
 * The one decision this surface can record, and whether it can be recorded now.
 *
 * `awaiting` mirrors ../control's own rule — a ready or running task is the
 * only kind it will complete — rather than inventing a second one, and
 * `refusal` is the sentence for every other case, naming the state the task is
 * actually in. The check is repeated against a freshly read record when a
 * decision arrives, because a phone taps a screen that was painted a minute
 * and a half ago and the record moves underneath it.
 */
export type MobileGoalDecision = {
  /** The review task's id — the handle a decision names. Empty when there is no review task. */
  nodeId: string;
  taskTitle: string | null;
  status: MobileGoalTaskStatus;
  awaiting: boolean;
  refusal: string | null;
  /** Prerequisite titles that have not completed, when those are what is holding it. */
  unfinished: string[];
};

export type MobileGoalVerdict = 'approve' | 'request_changes' | 'reject';

/** What the Mac's record said after a decision was written to it. */
export type MobileGoalDecisionOutcome = {
  decision: MobileGoalVerdict;
  taskTitle: string;
  /** Read back from the record after the write, never predicted from the verdict. */
  taskStatus: MobileGoalTaskStatus;
  goalStatus: MobileGoalStatus;
  /** The completion note exactly as it was stored, provenance included. */
  note: MobileGoalText;
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
  /** What the project's review gate last said, read out of this goal's own proofs. */
  gate: MobileGoalGate;
  /** The terminal review node, and whether it is waiting on a person right now. */
  decision: MobileGoalDecision;
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
 * The answer to a recorded decision: the goal as it stands afterwards, and what
 * the record says changed.
 *
 * Both may be null on a success. The write is ../control's and it either
 * happened or threw; a read that fails after it is not a reason to report a
 * failure that did not occur, so the page has a branch that claims the decision
 * was recorded and nothing about what it did.
 */
export type MobileGoalDecisionPayload = {
  ok: true;
  generatedAt: number;
  outcome: MobileGoalDecisionOutcome | null;
  goal: MobileGoalDetail | null;
};

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
/**
 * The three verdicts ../control takes, as a closed list.
 *
 * A Map for the reason the tables above are Maps, and it matters more here than
 * anywhere else in this file: this value decides whether a goal is accepted or
 * recorded as rejected, and a lookup that resolved through Object.prototype
 * would be a decision nobody in this codebase wrote down.
 */
const VERDICTS = new Map<string, MobileGoalVerdict>([
  ['approve', 'approve'], ['request_changes', 'request_changes'], ['reject', 'reject'],
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
 * What the project's review gate last said about this goal.
 *
 * The gate is not run from here and nothing in this module knows how to run
 * one: `runProof` in ../control spawns the project's configured commands and
 * writes the outcome as a `test` proof, and this reads those proofs back. The
 * Git screen has a gate route of its own for a working tree; this is the
 * docket's own recorded result, which is the one an approval is checked
 * against.
 *
 * Read per verification task, because that is how the approval rule reads it:
 * control.ts requires the latest `test` proof of *every* verification task to
 * have passed, so one green branch of a fanned-out goal cannot speak for a red
 * one. The latest is the newest `createdAt` among that task's `test` proofs,
 * which is the same ordering control.ts uses; where two gate runs shared a
 * millisecond the two could in principle disagree, and that is one more reason
 * this reading is evidence rather than a verdict — the Mac re-reads the proofs
 * when the decision arrives and refuses in its own words.
 */
export function mobileGoalGate(record: DocketDetail): MobileGoalGate {
  const raw = record as DocketDetail & Record<string, unknown>;
  const nodes = Array.isArray(raw.nodes) ? raw.nodes : [];
  const proofs = Array.isArray(raw.proofs) ? raw.proofs : [];
  const verify = nodes.filter((node) => TASK_KINDS.get(String(node?.kind)) === 'verify');

  // Only proofs written by the gate. A decision proof and a completion note
  // share this table, and counting one of those as a passing check would be
  // this screen reporting a human's word as a command result.
  const latest = new Map<string, DocketDetail['proofs'][number]>();
  for (const proof of proofs) {
    const nodeId = typeof proof?.nodeId === 'string' ? proof.nodeId : '';
    if (!nodeId || PROOF_KINDS.get(String(proof?.kind)) !== 'test') continue;
    const held = latest.get(nodeId);
    if (!held || stamp(proof?.createdAt) > stamp(held.createdAt)) latest.set(nodeId, proof);
  }

  const tasks: MobileGoalGateTask[] = verify.slice(0, MAX_TASKS).map((node) => {
    const proof = typeof node?.id === 'string' ? latest.get(node.id) : undefined;
    const status = proof ? PROOF_STATUSES.get(String(proof.status)) ?? 'unknown' : undefined;
    return {
      taskTitle: safeString(node?.title, 160, 'Untitled task'),
      // A 'recorded' gate proof is not a pass and is not a failure; runProof
      // writes only passed or failed, so anything else is a row this screen
      // has not been taught to read and says so.
      result: !proof ? 'not-run' : status === 'passed' ? 'passed' : status === 'failed' ? 'failed' : 'unknown',
      summary: proof ? clip(proof.summary, LINE_CHARS) : null,
      ranAt: proof ? stamp(proof.createdAt) || null : null,
    };
  });

  const ran = tasks.map((task) => task.ranAt).filter((at): at is number => at !== null);
  const unproven = tasks.filter((task) => task.result !== 'passed').map((task) => task.taskTitle);
  const state: MobileGoalGateState = verify.length === 0 ? 'no-verification'
    : tasks.some((task) => task.result === 'failed') ? 'failed'
      : unproven.length === 0 ? 'passed'
        : tasks.every((task) => task.result === 'not-run') ? 'not-run'
          : 'partial';
  return {
    state,
    tasks,
    tasksOmitted: Math.max(0, verify.length - MAX_TASKS),
    lastRunAt: ran.length ? Math.max(...ran) : null,
    unproven,
  };
}

/**
 * The review node, and whether the Mac would take a decision on it right now.
 *
 * The first review row is the one this reports, because it is the one the goal
 * itself follows: `setDocketPhase` in ../control reads `nodes.find(kind ===
 * 'review')` to decide whether a goal is in review or accepted. A graph with
 * two of them cannot be built — `buildPlan` refuses it — but a row written
 * before that rule existed can still be read, and the two surfaces have to name
 * the same task when it is.
 *
 * `awaiting` is ../control's rule and not a second one: `completeNode` takes a
 * decision on a ready or running task and refuses every other status. What is
 * added here is the sentence, because "this task is blocked" leaves out the
 * part the operator needs — whether something failed above it or the queue has
 * simply not reached it.
 */
export function mobileGoalDecision(record: DocketDetail): MobileGoalDecision {
  const raw = record as DocketDetail & Record<string, unknown>;
  const nodes = Array.isArray(raw.nodes) ? raw.nodes : [];
  const node = nodes.find((value) => TASK_KINDS.get(String(value?.kind)) === 'review');
  if (!node || typeof node.id !== 'string' || !node.id) {
    return {
      nodeId: '', taskTitle: null, status: 'unknown', awaiting: false, unfinished: [],
      refusal: 'This goal has no review task, so there is no decision for anyone to record — here or at the Mac.',
    };
  }

  const byId = new Map(nodes.filter((value) => typeof value?.id === 'string').map((value) => [value.id, value]));
  const status = TASK_STATUSES.get(String(node.status)) ?? 'unknown';
  const title = safeString(node.title, 160, 'Untitled task');
  const dependsOn = Array.isArray(node.dependsOn) ? node.dependsOn.filter((id): id is string => typeof id === 'string') : [];

  const unfinished: string[] = [];
  let failedAbove = false;
  let unlisted = 0;
  for (const id of dependsOn) {
    const dep = byId.get(id);
    if (!dep) { unlisted += 1; continue; }
    const depStatus = TASK_STATUSES.get(String(dep.status)) ?? 'unknown';
    if (DEAD.has(depStatus)) failedAbove = true;
    else if (depStatus !== 'completed') unfinished.push(safeString(dep.title, 160, 'Untitled task'));
  }

  const base = { nodeId: node.id, taskTitle: title, status, unfinished: unfinished.slice(0, MAX_PREREQUISITES) };
  if (status === 'ready' || status === 'running') return { ...base, awaiting: true, refusal: null };

  const refusal = status === 'completed'
    ? 'This review has already been decided: the Mac records the task as completed. There is nothing left to record from here.'
    : status === 'failed' || status === 'canceled'
      ? 'A decision has already been recorded here — the Mac records the review task as ' + status +
        '. Reopen it at the Mac when the revised work is ready for another pass.'
      : status === 'blocked' && failedAbove
        ? 'This review is blocked by a task above it that failed or was canceled. Nothing here moves until that task is reopened at the Mac.'
        : status === 'blocked' && (unfinished.length > 0 || unlisted > 0)
          ? 'This review is not waiting on you yet: ' + (unfinished.length + unlisted) +
            ' of the tasks it depends on have not finished.'
          : status === 'blocked'
            ? 'The Mac records this review task as blocked while every task it depends on is complete. That is a fact about the stored row rather than about the graph, and it has to be looked at on the Mac.'
            : status === 'pending'
              ? 'The Mac records this review task as pending, which is not a state it takes a decision in.'
              : 'The Mac records this review task in a state this screen cannot name, so no decision is offered for it here.';
  return { ...base, awaiting: false, refusal };
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
    gate: mobileGoalGate(record),
    decision: mobileGoalDecision(record),
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

/** One goal's record, or the refusal already written to the response. */
function readGoal(res: http.ServerResponse, id: string): DocketDetail | null {
  try {
    return goalRecord(id);
  } catch (error) {
    // control.ts throws this exact sentence for an id that names no row, and
    // matching it is what separates "that goal is gone" from "the database
    // would not open". If the wording there ever changes this degrades to the
    // 503 below, which is the safe direction: it claims less, not more.
    if (error instanceof Error && error.message === 'Goal not found.') {
      json(res, 404, { error: 'Wanigan has no goal with that id. It may have been created on another Mac, or removed.' });
      return null;
    }
    json(res, 503, { error: READ_FAILED });
    return null;
  }
}

function serveGoal(res: http.ServerResponse, url: URL): void {
  const id = safeString(url.searchParams.get('goal'), 120);
  if (!id) { json(res, 400, { error: 'Choose a goal.' }); return; }
  const record = readGoal(res, id);
  if (!record) return;
  try {
    serveJson(res, { generatedAt: Date.now(), goal: mobileGoal(record) } satisfies MobileGoalPayload, 'this goal');
  } catch {
    json(res, 503, { error: READ_FAILED });
  }
}

/**
 * The operator's own note, bounded, with the provenance the record has room
 * for.
 *
 * The note is the one piece of free text on this route and it is evidence
 * rather than state: nothing branches on it, ../control stores it on the node
 * as the completion note, and both surfaces display it beside the decision. A
 * note past the cap is refused rather than shortened, because a decision is
 * durable and half a reason recorded as if it were the whole one is worse than
 * none.
 */
function decisionNote(value: unknown): string {
  if (value === undefined || value === null || value === '') return PHONE_NOTE_ALONE;
  if (typeof value !== 'string') throw new Error('That note is not text.');
  const text = safeString(value, NOTE_CHARS + 1);
  if (!text) return PHONE_NOTE_ALONE;
  if (text.length > NOTE_CHARS) throw new Error(`A note recorded with a decision may be up to ${NOTE_CHARS} characters.`);
  return PHONE_NOTE_PREFIX + text;
}

/**
 * Record the human review decision for one goal, from a paired device.
 *
 * Every refusal below is here because the screen that posted this was painted
 * some seconds ago and the record has moved since. A phone shows a review as
 * ready, the operator walks to the car, a task at the Mac fails, and the thumb
 * lands on Approve against a graph that no longer exists. So the goal is read
 * again *now*, the node is checked to belong to it, its kind is checked to be
 * the review, and its state is checked to be one ../control would take a
 * decision in — before anything is written.
 *
 * The decision itself is `completeNode`, unchanged and unrepeated. It applies
 * the approval rule (a passed gate proof for every verification task), writes
 * the node status and note, files the decision proof, records one model outcome
 * per launched phase and moves the goal. This module contributes the refusals
 * of a stale screen and nothing else; when the Mac refuses, the operator reads
 * the Mac's sentence rather than this file's guess at it.
 */
async function serveDecision(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await requestJson(req, 4_096);
  const goalId = safeString(body?.goal, 120);
  const nodeId = safeString(body?.task, 120);
  if (!goalId || !nodeId) { json(res, 400, { error: 'Choose a goal and the review task on it.' }); return; }
  // Before the record is touched, so an unrecognised verdict is refused the
  // same way whatever state the goal is in. A near miss that still recorded a
  // decision would be the worst outcome available here.
  const verdict = VERDICTS.get(typeof body?.decision === 'string' ? body.decision : '');
  if (!verdict) { json(res, 400, { error: 'That is not a decision this screen can record.' }); return; }

  let note: string;
  try {
    note = decisionNote(body?.note);
  } catch (error) {
    json(res, 400, { error: safeString(error instanceof Error ? error.message : String(error), 240, 'That note was refused.') });
    return;
  }

  const before = readGoal(res, goalId);
  if (!before) return;
  // completeNode resolves a node id on its own, across every goal on this Mac.
  // Checking membership here is what keeps this route to the goal the device
  // was actually shown: an id from another docket is refused rather than
  // silently deciding a review nobody opened.
  const node = (Array.isArray(before.nodes) ? before.nodes : []).find((value) => value?.id === nodeId);
  if (!node) { json(res, 404, { error: 'That task is not part of this goal, so nothing was recorded.' }); return; }
  if (TASK_KINDS.get(String(node.kind)) !== 'review') {
    json(res, 409, { error: 'That is not the review task. This screen records the human review decision; other tasks are completed at the Mac.' });
    return;
  }

  const decision = mobileGoalDecision(before);
  if (decision.nodeId !== nodeId) {
    json(res, 409, { error: 'This goal records more than one review task, and this is not the one its status follows. Decide it at the Mac.' });
    return;
  }
  if (!decision.awaiting) {
    // 409 rather than 400: the request is well formed and every id in it is
    // real. What is wrong is the state of the goal on the Mac, and the page
    // tells the two apart so it can say what that state is.
    json(res, 409, { error: decision.refusal ?? 'That review task is not waiting on a decision.' });
    return;
  }

  try {
    completeNode(nodeId, { detail: note, decision: verdict });
  } catch (error) {
    // control.ts's own words, including the approval refusal that names which
    // verification tasks are still unproven. Rewriting that sentence here
    // would put a second, staler account of the gate rule on a phone.
    json(res, 409, { error: safeString(error instanceof Error ? error.message : String(error), 400, 'The Mac refused that decision.') });
    return;
  }

  // Written. Everything below is a read, and a read that fails now is not a
  // failed decision — so the payload has room to say the decision was recorded
  // and nothing about what it did.
  let after: DocketDetail | null = null;
  try { after = goalRecord(goalId); } catch { after = null; }
  const wire = after ? mobileGoal(after) : null;
  const decided = after ? mobileGoalDecision(after) : null;
  const outcome: MobileGoalDecisionOutcome | null = wire && decided ? {
    decision: verdict,
    taskTitle: decision.taskTitle ?? 'Untitled task',
    // Read back rather than predicted. Approving a review on a goal that also
    // holds a failed task leaves it 'blocked' rather than 'accepted', and a
    // payload that reported the verdict's intention would be wrong exactly
    // when it mattered.
    taskStatus: decided.status,
    goalStatus: wire.status,
    note: clip(note, LINE_CHARS),
  } : null;

  try {
    serveJson(res, {
      ok: true, generatedAt: Date.now(), outcome, goal: wire,
    } satisfies MobileGoalDecisionPayload, 'this goal');
  } catch {
    json(res, 200, { ok: true, generatedAt: Date.now(), outcome: null, goal: null } satisfies MobileGoalDecisionPayload);
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

// The one write on this wire, at 'control' rather than 'monitor': recording a
// human decision moves a goal and files evidence against it, so it belongs
// behind the same opt-in as typing into a session and is charged to the same
// per-minute action budget. Reading a goal stays at 'monitor' — a device that
// may watch the work is not thereby a device that may decide it. No path
// crosses in either direction, so the sentence ./dispatch makes about
// `scope: 'repo'` being the complete list of routes that can send one is left
// standing.
registerApiRoute({
  path: '/api/goal',
  method: 'POST',
  scope: 'control',
  handler: (req, res) => serveDecision(req, res),
});
