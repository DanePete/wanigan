import type http from 'node:http';
import { learningSettings } from '../settings';
import { projectById } from '../store';
import { listCandidates, reviewCandidate } from '../learning/repository';
import { getSignal } from '../learning/signals';
import type { KnowledgeCandidate } from '../learning/types';
import { json, registerApiRoute, requestJson } from './dispatch';
import { safeString } from './snapshot';

/**
 * The review inbox, and the one Learning job that is genuinely a spare-moment
 * job: deciding on the proposals that are waiting.
 *
 * Everything else on the desktop's Learning screen is a desk job. Editing a
 * proposal's text is writing the sentence an agent will be told for months;
 * compiling it into a skill or projecting it into CLAUDE.md writes files inside
 * a repository this device does not have. Those stay on the Mac. What is left
 * is the part that stalls the whole pipeline while nobody is at the machine —
 * a proposal nobody has said yes or no to — and that is a decision a person can
 * make from a queue at a coffee shop, provided the evidence is in front of them.
 *
 * Which is the rule this module is built around. CLAUDE.md is strict here and a
 * phone must not soften it: only reversible personal memory with high
 * confidence and at least two independent sources may ever promote itself, and
 * everything else waits for a person. A person tapping Approve on a card that
 * shows a title and a number is not that person — that is rubber-stamping with
 * extra steps. So this route carries the claim itself, the rationale behind it,
 * and the citations it rests on; and where it cannot carry one of those, the
 * response says so and main refuses the approval rather than letting the page
 * decide whether the operator saw enough.
 *
 * The scope split follows ./manage and ./manage-runs, for their reason. Reading
 * the inbox is 'monitor': what is waiting for a decision is a fact about this
 * Mac, and a monitor that cannot say how much work has piled up behind a person
 * has a hole in exactly the place someone opens it to look. Deciding is
 * 'control' and POST, so the dispatcher's separate remote-control opt-in
 * refuses it outright when the operator has not enabled it, and it draws on the
 * same twenty-writes-a-minute window as launching an agent rather than an
 * allowance of its own.
 *
 * Nothing here — on the wire or on the page — may suggest that a model read a
 * proposal. Model-assisted consolidation is not connected in this build:
 * `learningSettings().allowModelAssistance` is a hardcoded false reserving the
 * boundary for a consolidator that would need consent, provider routing and
 * usage metering first. Consolidation is deterministic clustering and template
 * phrasing over signals this Mac recorded, and the page says that in words.
 *
 * Approving is deliberately only half of what the desktop's Approve button
 * does. The desktop reviews and then promotes in one action; this route records
 * the review and stops. Promotion writes a canonical knowledge item that
 * retrieval may inject into later sessions, and it is the step that refuses an
 * unauthored nomination — a candidate whose observations were counted but whose
 * meaning nobody has written. Leaving it at the Mac keeps this route to the
 * decision itself, and the page says plainly that nothing has been written yet.
 */

/** How many proposals one response carries; the page is a phone on a radio. */
const MAX_PROPOSALS = 12;

/**
 * How deep the inbox is read before that cap, so "and N more are waiting" is a
 * counted number rather than a guess. A read that hits this ceiling reports the
 * count as a floor instead of pretending it saw the end of the queue.
 */
const READ_LIMIT = 120;

/** Citation summaries carried per proposal, and ids checked per proposal. */
const MAX_SHOWN_CITATIONS = 4;
const MAX_CHECKED_CITATIONS = 24;

const TITLE_MAX = 200;
const CLAIM_MAX = 4_000;
const RATIONALE_MAX = 1_200;
const CONFLICT_MAX = 4;
const MAX_JSON_BYTES = 256 * 1024;

/**
 * Why there is no cache here, unlike ./explore.
 *
 * The frame re-runs a visible screen's read on every poll, which is every three
 * seconds, and this payload does touch the same synchronous database handle the
 * session recorder writes through. What it costs is one indexed select bounded
 * by READ_LIMIT plus, for the dozen proposals it composes, a primary-key lookup
 * per cited observation — bounded by MAX_CHECKED_CITATIONS above, which is why
 * that ceiling exists at all. That is a few hundred point reads at worst, not
 * the multi-day aggregate ./explore caches to stay off this thread.
 *
 * Reusing a composed answer would also buy the wrong thing. A queue is read to
 * be cleared, and a proposal created or decided at the Mac showing up seconds
 * late on the phone is precisely the stale claim this surface exists to refuse.
 */

/**
 * What the phone is told when the learning records will not open. It names the
 * two facts the page cannot establish on its own — the Mac was reached, and
 * nothing was written — rather than restating the failure the page is already
 * printing above it. A database error can carry a local path or a table name,
 * so it does not travel.
 */
const READ_FAILED = 'The Mac answered, but its record of the review inbox would not open. Nothing has been changed.';

/** One stored observation behind a proposal, as much of it as may cross. */
export type MobileLearningCitation = {
  /** The signal kind, as the record spells it: 'tool-failure', 'correction'. */
  kind: string;
  summary: string;
  /** True when the Mac redacted the summary before storing it. */
  redacted: boolean;
  at: number;
};

/** A knowledge item this proposal may be arguing with, as the record found it. */
export type MobileLearningConflict = {
  relation: 'possible-conflict' | 'duplicate';
  title: string;
  reason: string;
};

/**
 * One proposal waiting for a decision.
 *
 * Rebuilt field by field from an allow-list like every other response that
 * leaves this process, and two fields are deliberately absent. The proposal's
 * signal ids do not travel: they identify rows in this Mac's database and the
 * page has no use for them beyond decoration. Neither does an absolute path
 * scope — see `pathWithheld` below.
 */
export type MobileLearningProposal = {
  id: string;
  title: string;
  /**
   * The sentence the proposal asks Wanigan to remember, and whether the phone
   * is being shown all of it. A claim too long for this wire is not a claim
   * anyone can weigh on a phone, and `claimComplete: false` is what stops the
   * approval rather than a quietly truncated paragraph.
   */
  claim: string;
  claimComplete: boolean;
  /** Why the proposal exists, in the record's own words, and the same question. */
  rationale: string;
  rationaleComplete: boolean;
  /** 'memory', 'rule', 'instruction', 'skill' — what an approval would become. */
  targetKind: string;
  scope: 'personal' | 'project' | 'path';
  /**
   * The path selector a path-scoped proposal carries, and whether it was held
   * back. A selector that names an absolute location identifies this machine to
   * anyone who intercepts it, which is the one thing the mobile boundary never
   * hands over — so it is withheld, and a withheld selector blocks the approval
   * instead of being quietly dropped from a card someone then taps.
   */
  pathSelector: string | null;
  pathWithheld: boolean;
  /** The repository's name, never its path. Null when the project row is gone. */
  projectName: string | null;
  status: 'pending';
  /** A rule, not a measurement and not a model's opinion — see the desktop's glossary. */
  confidence: number;
  evidenceCount: number;
  taskCount: number;
  createdAt: number;
  updatedAt: number;
  conflicts: MobileLearningConflict[];
  /**
   * How many observations the proposal cites and how many of those rows are
   * still on this Mac. `checked: false` means this device did not verify them
   * at all, which is a different answer from having verified them and found
   * them present — and it must never be rendered as the second.
   */
  citations: { named: number; found: number; checked: boolean };
  shown: MobileLearningCitation[];
  /** Why a snoozed proposal came back, as the stored reason code's counts. */
  wake: { newSignals: number; newTasks: number; at: number } | null;
  /**
   * Whether main will accept an approval for this proposal, and why not. The
   * page draws the button from it; main re-derives it on the write rather than
   * trusting the answer to come back unchanged from a browser.
   */
  approvable: boolean;
  approveBlocked: string | null;
};

export type MobileLearningInbox = {
  generatedAt: number;
  /** The master switch. False means the page draws its off state, not an empty queue. */
  enabled: boolean;
  /**
   * Whether any model was involved in producing these proposals. It is read
   * from the setting rather than written as a constant so this cannot go on
   * claiming "no model" after a metered consolidator lands — but the setting is
   * a hardcoded false in this build, and the page says so in words.
   */
  modelAssisted: boolean;
  /** Proposals waiting for a decision, capped; `waiting` counts what was seen. */
  proposals: MobileLearningProposal[];
  waiting: number;
  /** True when the read hit its own ceiling, so `waiting` is a floor. */
  waitingIsFloor: boolean;
};

/**
 * A bounded string, and whether the phone is seeing all of it.
 *
 * safeString flattens control characters and collapses runs of whitespace,
 * which turns a multi-line claim into one flowing paragraph — fine on a phone,
 * and the same sanitising every other string on this wire goes through. What
 * mattered enough to return separately is the truncation: a decision taken on
 * the first four thousand characters of a longer claim is a decision taken on
 * something the operator never read.
 */
function bounded(value: string, max: number): { text: string; complete: boolean } {
  const flat = safeString(value, max + 1);
  return flat.length > max ? { text: flat.slice(0, max), complete: false } : { text: flat, complete: true };
}

/**
 * Whether a path selector names a location on this machine.
 *
 * A scope like `src/main` is a selector inside a repository and says nothing
 * about where that repository lives; `/Users/someone/Projects/x` and `~/x` are
 * the machine. The mobile boundary hands over names, never locations, so the
 * second kind is withheld — and because a proposal whose scope is withheld is
 * a proposal nobody can weigh, that withholding blocks the approval too.
 */
function namesTheMachine(selector: string): boolean {
  return selector.startsWith('/') || selector.startsWith('~') || /^[a-zA-Z]:[\\/]/.test(selector);
}

function pathScopeFor(candidate: KnowledgeCandidate): { selector: string | null; withheld: boolean } {
  if (candidate.scope !== 'path') return { selector: null, withheld: false };
  const raw = safeString(candidate.pathScope, 300);
  // createCandidate refuses a path-scoped candidate with no selector, so an
  // empty one here is a row written before that rule or by hand. Either way the
  // scope is unreadable from this device, which is the same answer.
  if (!raw) return { selector: null, withheld: true };
  if (namesTheMachine(raw)) return { selector: null, withheld: true };
  return { selector: raw, withheld: false };
}

/**
 * The stored observations behind one proposal, resolved now rather than trusted
 * from the counters on the row.
 *
 * `evidenceCount` was computed when the candidate was created and never moves
 * again; the signal rows it counted can be gone by the time anyone reads the
 * inbox. Before promotion a candidate has no knowledge_evidence rows at all —
 * ../learning/repository writes those from the same signal ids at promotion
 * time — so the signals *are* the citations here, and resolving them is the
 * only way to know whether the evidence for this claim can still be produced.
 */
function citationsFor(candidate: KnowledgeCandidate): Pick<MobileLearningProposal, 'citations' | 'shown'> {
  const named = candidate.signalIds.length;
  if (named > MAX_CHECKED_CITATIONS) {
    // Deliberately not a partial check reported as a whole one. A proposal
    // citing more observations than this device is willing to resolve is a
    // proposal to decide at the Mac.
    return { citations: { named, found: 0, checked: false }, shown: [] };
  }
  let found = 0;
  const shown: MobileLearningCitation[] = [];
  for (const id of candidate.signalIds) {
    const signal = getSignal(id);
    if (!signal) continue;
    found++;
    if (shown.length >= MAX_SHOWN_CITATIONS) continue;
    shown.push({
      kind: safeString(signal.kind, 100, 'observation'),
      summary: safeString(signal.summary, 300),
      redacted: signal.detail?.summaryRedacted === true,
      at: Number.isFinite(signal.createdAt) ? signal.createdAt : 0,
    });
  }
  return { citations: { named, found, checked: true }, shown };
}

/**
 * Whether an approval may be taken from this device, and the sentence naming
 * why not.
 *
 * Every branch is the same rule: an approval is a person saying they read the
 * evidence and agree, so it is refused whenever this device was not shown the
 * evidence. Rejection is deliberately not held to it. A proposal you cannot see
 * enough of is one you are entitled to throw out, the decision stays in the
 * audit history, and the desktop can reopen it — refusing both directions would
 * leave the inbox growing with exactly the proposals nobody can clear.
 *
 * The conflicts branch is not a phone rule at all: the desktop disables its own
 * Approve button while a proposal contradicts an active item, because that
 * contradiction is a decision about which of the two survives and neither
 * surface should take it blind.
 */
function approveRefusal(row: Omit<MobileLearningProposal, 'approvable' | 'approveBlocked'>): string | null {
  if (!row.claimComplete) {
    return 'This proposal is longer than this device is shown, so approving it here would be approving text you have not read. Decide it at the Mac.';
  }
  if (!row.rationaleComplete) {
    return 'The reasoning behind this proposal is longer than this device is shown. Decide it at the Mac.';
  }
  if (row.pathWithheld) {
    return 'This proposal is scoped to a path Wanigan does not send to a phone, so this device cannot show you what it would apply to. Decide it at the Mac.';
  }
  if (row.conflicts.length) {
    return 'This proposal conflicts with knowledge Wanigan already holds. Which one survives is a decision to take at the Mac, where both texts are in front of you.';
  }
  if (!row.citations.checked) {
    return 'This proposal cites more observations than this device checks, so nothing here has confirmed its evidence still exists. Decide it at the Mac.';
  }
  if (!row.citations.named) {
    return 'Nothing is cited on this proposal, so there is no evidence here to approve it on.';
  }
  if (row.citations.found < row.citations.named) {
    const missing = row.citations.named - row.citations.found;
    return `${missing} of the ${row.citations.named} observations this proposal cites `
      + `${missing === 1 ? 'is' : 'are'} no longer on the Mac, so its evidence cannot be checked from here.`;
  }
  return null;
}

/**
 * Rebuilt field by field, like every other response that leaves this process.
 * The signal ids, the cluster key and the reviewer's stored note are among the
 * fields deliberately not here: the first two identify rows in this Mac's
 * database, and the third is a note about a decision that has not been taken.
 */
function wireProposal(candidate: KnowledgeCandidate): MobileLearningProposal {
  const claim = bounded(candidate.proposedText, CLAIM_MAX);
  const rationale = bounded(candidate.rationale, RATIONALE_MAX);
  const path = pathScopeFor(candidate);
  const row = {
    id: safeString(candidate.id, 120),
    title: safeString(candidate.title, TITLE_MAX, 'Untitled proposal'),
    claim: claim.text,
    claimComplete: claim.complete,
    rationale: rationale.text,
    rationaleComplete: rationale.complete,
    targetKind: safeString(candidate.targetKind, 60, 'knowledge'),
    scope: candidate.scope,
    pathSelector: path.selector,
    pathWithheld: path.withheld,
    projectName: candidate.projectId
      ? safeString(projectById(candidate.projectId)?.name, 160) || null
      : null,
    status: 'pending' as const,
    confidence: Math.max(0, Math.min(1, Number(candidate.confidence) || 0)),
    evidenceCount: Math.max(0, Math.round(Number(candidate.evidenceCount) || 0)),
    taskCount: Math.max(0, Math.round(Number(candidate.taskCount) || 0)),
    createdAt: Number.isFinite(candidate.createdAt) ? candidate.createdAt : 0,
    updatedAt: Number.isFinite(candidate.updatedAt) ? candidate.updatedAt : 0,
    conflicts: candidate.conflicts.slice(0, CONFLICT_MAX).map((conflict) => ({
      relation: conflict.relation,
      title: safeString(conflict.title, 160, 'An existing knowledge item'),
      reason: safeString(conflict.reason, 240),
    })),
    ...citationsFor(candidate),
    wake: candidate.wake
      ? {
          newSignals: Math.max(0, Math.round(Number(candidate.wake.newSignals) || 0)),
          newTasks: Math.max(0, Math.round(Number(candidate.wake.newTasks) || 0)),
          at: Number.isFinite(candidate.wake.at) ? candidate.wake.at : 0,
        }
      : null,
  };
  const blocked = approveRefusal(row);
  return { ...row, approvable: blocked === null, approveBlocked: blocked };
}

/**
 * The proposals actually waiting for a decision: pending, and nothing else.
 *
 * The desktop's "needs a decision" filter is wider than this, and the narrowing
 * is deliberate in both directions it cuts. Approved proposals are left out
 * because an approved proposal is waiting to be promoted into canonical
 * knowledge, which is a step at the Mac; listing it in a queue whose two
 * buttons are Approve and Reject would invite a second decision on something
 * already decided. Snoozed proposals are left out because snoozing *is* a
 * decision — a person's "not now, ask again when there is more" — and
 * ../learning-service already returns one to pending by itself the moment the
 * same pattern is observed in a new independent task. A phone that re-asked the
 * deferred question would be overriding the operator with a smaller screen.
 */
function readInbox(): { rows: KnowledgeCandidate[]; floor: boolean } {
  const rows = listCandidates({ status: 'pending', limit: READ_LIMIT });
  return { rows, floor: rows.length >= READ_LIMIT };
}

function composeInbox(): MobileLearningInbox {
  const settings = learningSettings();
  if (!settings.enabled) {
    // Nothing is read at all: with the switch off, consolidation is not running
    // and the queue behind it is not a live reading of anything. The page draws
    // its off state from this and names the setting.
    return {
      generatedAt: Date.now(),
      enabled: false,
      // Read rather than written as a constant even on this branch: a field
      // that reports a setting must report the setting, on every path.
      modelAssisted: settings.allowModelAssistance === true,
      proposals: [], waiting: 0, waitingIsFloor: false,
    };
  }
  const { rows, floor } = readInbox();
  return {
    generatedAt: Date.now(),
    enabled: true,
    modelAssisted: settings.allowModelAssistance === true,
    proposals: rows.slice(0, MAX_PROPOSALS).map(wireProposal),
    waiting: rows.length,
    waitingIsFloor: floor,
  };
}

function serveInbox(res: http.ServerResponse): void {
  let body: MobileLearningInbox;
  try {
    body = composeInbox();
  } catch {
    json(res, 503, { error: READ_FAILED });
    return;
  }
  const text = JSON.stringify(body);
  if (Buffer.byteLength(text) > MAX_JSON_BYTES) {
    // The caps above make this unreachable for any inbox this build can write,
    // and it stays here for the one that a later cap change would not: a
    // response too large to serve safely is refused rather than trimmed
    // silently, because a trimmed proposal is one someone approves half of.
    json(res, 503, { error: 'The review inbox is too large to serve to a phone.' });
    return;
  }
  json(res, 200, body);
}

/**
 * Approve or reject one proposal.
 *
 * The id arrives from a browser and is untrusted until this process has agreed
 * on it, so it is matched against the same inbox the device was shown before
 * anything is written. That is not only a guard against a malformed string: the
 * inbox is deliberately narrower than the candidates table — it omits the
 * approved, rejected, snoozed, promoted and applied rows — and a membership
 * test against it is what keeps a string from this route from re-deciding a
 * proposal that has already been decided, deferred or promoted.
 *
 * The approval gate is then re-derived here rather than read from the request.
 * The page is handed `approvable` so it can hide a button it must not offer,
 * and a page is not a place to enforce anything: a stale card, a replayed
 * request or a crafted one would otherwise approve a proposal whose evidence
 * this device never showed.
 *
 * The write itself is ../learning/repository's `reviewCandidate` and never SQL
 * of this module's own. That function owns the legal transitions — approve from
 * pending or snoozed, reject from pending, snoozed or approved — and the
 * snoozed_at column the automation gate reads as "a person deferred this". Its
 * table stays the authority even though every row this route can reach is
 * pending when it is read: a decision taken at the Mac between that read and
 * this write moves the row, and a transition the repository refuses comes back
 * to the phone as a refusal in its words rather than as a success this route
 * invented.
 */
async function serveDecision(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await requestJson(req, 2_048);
  const action = typeof body?.action === 'string' ? body.action : '';
  if (action !== 'approve' && action !== 'reject') {
    json(res, 400, { error: 'Approving or rejecting is the only change this device can make to a proposal.' });
    return;
  }
  const id = safeString(body?.id, 120);
  if (!id) { json(res, 400, { error: 'Choose a proposal.' }); return; }

  if (!learningSettings().enabled) {
    // The page names where the switch is, because it is the surface drawing
    // the off state and one authority for that sentence is enough. What this
    // has to carry is only that nothing was written.
    json(res, 409, { error: 'Learning is switched off on the Mac, so nothing can be decided from here.' });
    return;
  }

  let waiting: KnowledgeCandidate | undefined;
  try {
    // Matched first and composed second. Composing the whole queue to find one
    // row would resolve every other proposal's citations one query at a time on
    // the handle that owns the live PTYs, to answer a question about a single
    // id.
    waiting = readInbox().rows.find((row) => row.id === id);
  } catch {
    json(res, 503, { error: READ_FAILED });
    return;
  }
  if (!waiting) {
    json(res, 404, { error: 'That is not a proposal this device can decide.' });
    return;
  }
  const known = wireProposal(waiting);
  if (action === 'approve' && known.approveBlocked) {
    // 409 rather than 400: the request is well formed and the id is real, and
    // what is wrong is that this device was not shown enough to approve on. The
    // page tells the two apart so it can print the reason rather than "bad
    // request" over a proposal the operator can see perfectly well.
    json(res, 409, { error: known.approveBlocked });
    return;
  }

  let after: KnowledgeCandidate;
  try {
    // The provenance note is Wanigan's own sentence, not the operator's. The
    // desktop's reject chips write the reviewer's words into this column; a
    // phone offers no such words, and leaving the column null would lose the
    // one thing this decision knows that the desktop's does not — that it was
    // taken from a paired device rather than at the machine.
    after = reviewCandidate(id, action, 'Decided from the paired phone.');
  } catch (error) {
    json(res, 409, {
      error: safeString(error instanceof Error ? error.message : String(error), 240,
        'Wanigan refused that decision.'),
    });
    return;
  }
  // What the Mac now records, never what this page asked for. The two are the
  // same in the ordinary case and the honest report is the one that stays true
  // when they are not.
  json(res, 200, {
    ok: true,
    id: known.id,
    status: safeString(after.status, 40, 'unknown'),
    /** Whether it is still waiting for a decision, so the page can say it left. */
    open: after.status === 'pending',
  });
}

registerApiRoute({
  path: '/api/learning',
  method: 'GET',
  scope: 'monitor',
  handler: (_req, res) => serveInbox(res),
});

registerApiRoute({
  path: '/api/learning',
  method: 'POST',
  scope: 'control',
  handler: (req, res) => serveDecision(req, res),
});
