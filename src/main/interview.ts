import { randomUUID } from 'node:crypto';
import { db } from './db';
import { client, explainApiError, isMock } from './batch/anthropic';
import { getKey } from './keys';
import { DEFAULT_MODEL, MODELS, isPricedModel, syncCostOf } from './batch/pricing';
import { createDocket } from './control';
import { projectById } from './store';
import { refuseIfHalted } from './halt';
import {
  DOCKET_NODE_KINDS,
  MAX_DOCKET_NODE_DEPENDENCIES,
  MAX_DOCKET_PLAN_NODES,
} from '../shared/types';
import type {
  DocketDetail, DocketNodeKind, DocketPlanNode, DocketRisk,
  Interview, InterviewProposal, InterviewTurn,
} from '../shared/types';

/**
 * The interview: a model that grills you about an idea until it can write down
 * a contract, then hands you a task graph to accept or throw away.
 *
 * Wanigan could already create a goal, and the goal it created was always the
 * same four phases — plan, implement, verify, review — regardless of what the
 * work actually was. That default is a reasonable shape and a poor plan: it
 * knows nothing about the repository, it cannot say what "done" means, and its
 * acceptance checks are whatever the operator could be bothered to type into a
 * box before the interesting part. Most were one line.
 *
 * The thing that makes an acceptance check worth having is that it could fail.
 * You do not get one of those out of a form; you get it out of somebody asking
 * "what happens if the offer has no end date" and refusing to move on. So this
 * asks — one question at a time, each one written against the last answer —
 * and only proposes a goal once it can state a contract that could be failed.
 *
 * Three properties are load-bearing, and all three are about spending someone
 * else's money on their behalf:
 *
 * Every interview has a budget, given before the first question. The cap is
 * checked before each call and the recorded spend is what the API reported, not
 * an estimate — an unpriced call is refused rather than counted as free.
 *
 * The model can only do two things, because it is given exactly two tools: ask
 * one question, or propose a goal. There is no free-text path where it decides
 * to write an essay, and no branch where it silently does neither.
 *
 * Nothing it proposes is trusted. The plan goes through the same buildPlan()
 * validation as a hand-written one — the comment there already says "validation
 * is where untrusted planner output is refused" — and the operator accepts the
 * goal before a single row is written.
 */

/** The ceiling on how hard the operator can ask to be grilled. */
export const MAX_INTERVIEW_QUESTIONS = 20;
export const DEFAULT_INTERVIEW_QUESTIONS = 10;

/**
 * A typical call's shape, used to price an interview before it runs.
 *
 * The input grows with the transcript — every question carries the whole
 * conversation back — so this is the middle of a ten-question run rather than
 * the first call or the last. It is an estimate and the screen says so; what
 * gets recorded as spend is always what the API reported.
 */
const TYPICAL_CALL = { input_tokens: 2_500, output_tokens: 300 };

/**
 * Said once, and kept once said.
 *
 * `detail` is written on every step, and writing `null` on a priced call is
 * what used to erase this: one unpriced question in an interview of ten put the
 * warning on screen and the next question took it straight back off, leaving a
 * spend figure that was quietly too low and nothing anywhere saying so. The
 * sentence names "at least one call" because it is cumulative, so the write
 * below preserves it rather than replacing it with an absence.
 */
const UNPRICED_NOTE = 'The API reported no usage for at least one call, so the recorded spend is lower than the real one.';

/** What one question costs at this model's synchronous rates. */
export function costPerQuestion(model: string): number {
  return syncCostOf(model, TYPICAL_CALL);
}

/**
 * The dollar ceiling for an interview of this length, with room to be wrong.
 *
 * The operator's dial is the number of questions, not a dollar figure — that
 * is the thing they actually want to decide, and the money follows from it. A
 * whole interview lands between ten and thirty cents, so a menu of $0.25 / $1 /
 * $3 / $10 was asking them to choose between four numbers that all mean "yes".
 *
 * The budget still exists, because a model that returns something pathological
 * — a runaway output, a retry storm — must hit a wall rather than an estimate.
 * Three times the estimate plus a floor is loose enough never to stop a healthy
 * interview and tight enough to stop a sick one.
 */
export function budgetForQuestions(model: string, questions: number): number {
  return Math.max(0.25, Math.round(costPerQuestion(model) * questions * 3 * 100) / 100);
}

export const MIN_INTERVIEW_BUDGET_USD = 0.05;
export const MAX_INTERVIEW_BUDGET_USD = 20;
const MAX_SEED = 4_000;
const MAX_ANSWER = 4_000;
const MAX_OUTPUT_TOKENS = 4_000;

const SYSTEM = `You are interviewing an experienced engineer about a change they want to make to a
specific repository. Your job is to end up with a goal contract that could fail: a title, an
objective, acceptance checks that a reviewer could mark as not met, and a task graph.

Rules:
- Ask exactly ONE question at a time, using ask_one_question. Never ask two.
- Write each question against the last answer. Do not work from a checklist.
- Push back on vague answers. "Handle errors properly" is not an answer; ask what happens.
- Prefer questions whose answer would change the plan. If an answer cannot change what gets
  built, it is not worth a question.
- Go after: what "done" looks like and how it is checked, what must not break, who or what
  else touches this, the failure mode they would find worst, and anything they are assuming.
- Do not propose solutions during the interview. You are establishing the contract.
- You have NOT seen this repository. You know its name and nothing else. Never state a file
  path, module name, framework or version as fact — ask about it instead. Inventing a
  plausible-looking detail is the worst thing you can do here, because it will be read as
  something you checked.
- Do not ask for anything personal: no names, no email addresses, no scheduling.
- When you can write acceptance checks that could genuinely fail, call propose_goal. Do not
  keep asking to be thorough.

Work through five things, in roughly this order, skipping any the operator has already
settled: (1) what is broken or missing today, concretely enough to recognise; (2) what "done"
looks like and how somebody would check it; (3) what must not break — the existing behaviour,
the other consumers; (4) the worst failure they can imagine, and whether it is acceptable;
(5) anything they are assuming that you have not been told.

When you propose:
- Acceptance checks are observable and falsifiable. "Offers with no end date never render"
  is one; "the code is clean" is not.
- The task graph is the work, in dependency order. Use as many tasks as the work has, not
  four because four is the default. A task is one agent's job in one sitting.
- 'plan' tasks investigate and produce a plan; 'implement' changes code; 'verify' proves it
  with tests or a run; 'review' is the human decision at the end. Every graph ends in review.
- claimPath is the project-relative directory a task will own while it runs. Give one ONLY if
  the operator named that path during the interview. You cannot see the repository, and a
  guessed path is worse than none: it reads as a decision somebody made, and it silences the
  overlap check that keeps two agents out of the same directory. Leave it out when unsure.`;

const ASK_TOOL = {
  name: 'ask_one_question',
  description: 'Ask the operator exactly one question about their goal.',
  input_schema: {
    type: 'object' as const,
    properties: {
      question: { type: 'string', description: 'The question. One sentence where possible.' },
      why: { type: 'string', description: 'One short line on what this changes about the plan.' },
    },
    required: ['question'],
  },
};

const PROPOSE_TOOL = {
  name: 'propose_goal',
  description: 'Propose the goal contract and its task graph. Call this when the contract could fail.',
  input_schema: {
    type: 'object' as const,
    properties: {
      title: { type: 'string' },
      objective: { type: 'string', description: 'What this goal is for, in the operator’s terms.' },
      risk: { type: 'string', enum: ['low', 'elevated', 'high'] },
      acceptance: {
        type: 'array',
        description: 'Observable checks a reviewer could mark as not met.',
        items: { type: 'string' },
      },
      plan: {
        type: 'array',
        items: {
          type: 'object' as const,
          properties: {
            kind: { type: 'string', enum: ['plan', 'implement', 'verify', 'review'] },
            title: { type: 'string' },
            instructions: { type: 'string' },
            dependsOn: { type: 'array', items: { type: 'integer' }, description: 'Indices earlier in this array.' },
            claimPath: { type: 'string', description: 'Project-relative path this task owns while it runs.' },
          },
          required: ['kind', 'title', 'instructions'],
        },
      },
    },
    required: ['title', 'objective', 'acceptance', 'plan'],
  },
};

type Row = {
  id: string; project_id: string; seed: string; model: string; status: Interview['status'];
  turns_json: string; proposal_json: string | null; docket_id: string | null;
  spend_usd: number; budget_usd: number; max_questions: number; calls: number; detail: string | null;
  created_at: number; updated_at: number;
};

function now(): number { return Date.now(); }

function text(value: unknown, label: string, max: number): string {
  const flat = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (!flat) throw new Error(`${label} is required.`);
  return flat.slice(0, max);
}

function parseTurns(raw: string): InterviewTurn[] {
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value as InterviewTurn[] : [];
  } catch { return []; }
}

function mapRow(row: Row): Interview {
  return {
    id: row.id,
    projectId: row.project_id,
    seed: row.seed,
    model: row.model,
    status: row.status,
    turns: parseTurns(row.turns_json),
    proposal: row.proposal_json ? JSON.parse(row.proposal_json) as InterviewProposal : null,
    docketId: row.docket_id,
    spendUsd: row.spend_usd,
    budgetUsd: row.budget_usd,
    maxQuestions: row.max_questions || DEFAULT_INTERVIEW_QUESTIONS,
    calls: row.calls,
    detail: row.detail,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowOf(id: string): Row {
  const row = db().prepare('SELECT * FROM interviews WHERE id=?').get(id) as Row | undefined;
  if (!row) throw new Error('Interview not found.');
  return row;
}

export function interview(id: string): Interview {
  return mapRow(rowOf(id));
}

export function listInterviews(projectId?: string | null, limit = 20): Interview[] {
  const rows = (projectId
    ? db().prepare('SELECT * FROM interviews WHERE project_id=? ORDER BY updated_at DESC LIMIT ?').all(projectId, Math.min(100, limit))
    : db().prepare('SELECT * FROM interviews ORDER BY updated_at DESC LIMIT ?').all(Math.min(100, limit))) as Row[];
  return rows.map(mapRow);
}

/**
 * Turn what the model sent back into either a question or a proposal.
 *
 * Rebuilt field by field rather than cast. This is untrusted output on its way
 * to a screen and then to a goal, and the plan half of it is about to be handed
 * to buildPlan() — which refuses a bad graph, but only if what reaches it is
 * the shape it expects rather than whatever JSON came back.
 */
function readProposal(input: Record<string, unknown>): InterviewProposal {
  const rawPlan = Array.isArray(input.plan) ? input.plan : [];
  const plan: DocketPlanNode[] = rawPlan.slice(0, MAX_DOCKET_PLAN_NODES).map((raw, index) => {
    const node = (raw ?? {}) as Record<string, unknown>;
    const kind = DOCKET_NODE_KINDS.includes(node.kind as DocketNodeKind)
      ? node.kind as DocketNodeKind
      : 'implement';
    const depends = Array.isArray(node.dependsOn) ? node.dependsOn : [];
    return {
      kind,
      title: typeof node.title === 'string' ? node.title.slice(0, 180) : `Task ${index + 1}`,
      instructions: typeof node.instructions === 'string' ? node.instructions.slice(0, 8_000) : '',
      // Only backward references, and only to tasks that exist. A forward or
      // self dependency is a cycle, and buildPlan would refuse the whole graph
      // over one — losing an otherwise good plan to one bad index.
      dependsOn: depends
        .filter((value): value is number => typeof value === 'number' && Number.isInteger(value))
        .filter((value) => value >= 0 && value < index)
        .slice(0, MAX_DOCKET_NODE_DEPENDENCIES),
      claimPath: typeof node.claimPath === 'string' && node.claimPath.trim()
        ? node.claimPath.trim().slice(0, 400)
        : null,
    };
  });

  const risk = ['low', 'elevated', 'high'].includes(String(input.risk))
    ? String(input.risk) as DocketRisk
    : 'elevated';

  return {
    title: typeof input.title === 'string' ? input.title.slice(0, 180) : 'Untitled goal',
    objective: typeof input.objective === 'string' ? input.objective.slice(0, 12_000) : '',
    risk,
    acceptance: (Array.isArray(input.acceptance) ? input.acceptance : [])
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .map((value) => value.trim().slice(0, 1_000))
      .slice(0, 16),
    plan,
  };
}

/** The conversation so far, as the API wants it. */
function messages(row: Row): { role: 'user' | 'assistant'; content: string }[] {
  const turns = parseTurns(row.turns_json);
  const out: { role: 'user' | 'assistant'; content: string }[] = [
    { role: 'user', content: `The repository is "${projectById(row.project_id)?.name ?? 'a project'}".\n\nWhat I want to do:\n${row.seed}` },
  ];
  for (const turn of turns) {
    out.push({ role: 'assistant', content: turn.question });
    out.push({ role: 'user', content: turn.answer ?? '(no answer given)' });
  }
  return out;
}

/**
 * One model call, and the money gate in front of it.
 *
 * The cap is checked before the call rather than after, because after is too
 * late: the spend has happened. What is checked is the spend already recorded
 * against the budget, so an interview reaches its cap between questions and
 * stops there, rather than mid-answer.
 */
async function step(row: Row, force: 'propose' | null): Promise<Interview> {
  refuseIfHalted('run an interview');
  if (row.spend_usd >= row.budget_usd) {
    throw new Error(
      `This interview has spent $${row.spend_usd.toFixed(2)} of its $${row.budget_usd.toFixed(2)} budget. `
      + 'Raise the budget or propose the goal from what it has.',
    );
  }

  const body = {
    model: row.model,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: SYSTEM,
    tools: force === 'propose' ? [PROPOSE_TOOL] : [ASK_TOOL, PROPOSE_TOOL],
    // 'any' rather than 'auto': the model must pick one of the two tools. Left
    // on auto it can answer in prose, and a prose answer is a turn that cost
    // money, advanced nothing, and has to be shown to the operator as an error
    // about a thing they did not do.
    tool_choice: force === 'propose'
      ? { type: 'tool' as const, name: PROPOSE_TOOL.name }
      : { type: 'any' as const },
    messages: force === 'propose'
      ? [...messages(row), {
        role: 'user' as const,
        content: 'That is as far as this interview goes. Propose the goal from what you have, '
          + 'and say in the objective what you did not get to ask about.',
      }]
      : messages(row),
  };

  let response: Awaited<ReturnType<ReturnType<typeof client>['messages']['create']>>;
  try {
    response = await client().messages.create(body as never);
  } catch (error) {
    const detail = explainApiError(error);
    db().prepare("UPDATE interviews SET status='failed', detail=?, updated_at=? WHERE id=?")
      .run(detail.slice(0, 1_000), now(), row.id);
    throw new Error(detail);
  }

  const message = response as unknown as {
    content: { type: string; name?: string; input?: Record<string, unknown> }[];
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const usage = message.usage;
  // Synchronous rates, not batch. costOf() prices the batch API, which is half
  // of list — reporting that here would tell an operator an interview cost half
  // what it did, on the one screen in this feature that is about money.
  const spent = usage && typeof usage.input_tokens === 'number' && typeof usage.output_tokens === 'number'
    ? syncCostOf(row.model, { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens })
    : null;

  const note = spent === null ? UNPRICED_NOTE : null;

  const call = message.content.find((part) => part.type === 'tool_use');
  const turns = parseTurns(row.turns_json);
  const at = now();

  if (call?.name === PROPOSE_TOOL.name) {
    const proposal = readProposal(call.input ?? {});
    db().prepare(`UPDATE interviews SET status='proposed', proposal_json=?, spend_usd=spend_usd+?,
      calls=calls+1, detail=CASE WHEN ? IS NOT NULL THEN ? ELSE detail END, updated_at=? WHERE id=?`)
      .run(JSON.stringify(proposal), spent ?? 0, note, note, at, row.id);
    return interview(row.id);
  }

  if (call?.name === ASK_TOOL.name) {
    const input = call.input ?? {};
    turns.push({
      question: typeof input.question === 'string' ? input.question.slice(0, 2_000) : 'Tell me more.',
      why: typeof input.why === 'string' ? input.why.slice(0, 500) : null,
      answer: null,
      at,
    });
    db().prepare(`UPDATE interviews SET status='asking', turns_json=?, spend_usd=spend_usd+?,
      calls=calls+1, detail=CASE WHEN ? IS NOT NULL THEN ? ELSE detail END, updated_at=? WHERE id=?`)
      .run(JSON.stringify(turns), spent ?? 0, note, note, at, row.id);
    return interview(row.id);
  }

  // Neither tool. tool_choice makes this very unlikely, and it is still
  // recorded as a failure with the money already spent rather than retried in a
  // loop that would spend it again.
  db().prepare(`UPDATE interviews SET status='failed', spend_usd=spend_usd+?, calls=calls+1,
    detail=?, updated_at=? WHERE id=?`)
    .run(spent ?? 0, 'The model answered without asking a question or proposing a goal.', at, row.id);
  throw new Error('The model answered without asking a question or proposing a goal. Nothing was changed.');
}

/** Open an interview and ask the first question. */
export async function startInterview(input: {
  projectId: string; seed: string; model?: string; budgetUsd?: number; maxQuestions?: number;
}): Promise<Interview> {
  refuseIfHalted('start an interview');
  const project = projectById(input.projectId);
  if (!project) throw new Error('Choose a project before starting an interview.');
  const seed = text(input.seed, 'A rough description of what you want', MAX_SEED);
  // Only a model this build has a published rate for. An unpriced one would be
  // billed at the default's rates and reported as if that were the price, which
  // is the one thing spend reporting in this app must never do.
  const model = input.model ?? DEFAULT_MODEL;
  if (!isPricedModel(model)) {
    throw new Error(`Wanigan has no published rate for ${model}, so it will not run an interview it cannot price.`);
  }
  const requested = Math.round(input.maxQuestions ?? DEFAULT_INTERVIEW_QUESTIONS);
  if (!Number.isFinite(requested) || requested < 1 || requested > MAX_INTERVIEW_QUESTIONS) {
    throw new Error(`Ask for between 1 and ${MAX_INTERVIEW_QUESTIONS} questions.`);
  }
  const budgetUsd = input.budgetUsd ?? budgetForQuestions(model, requested);
  if (!Number.isFinite(budgetUsd) || budgetUsd < MIN_INTERVIEW_BUDGET_USD || budgetUsd > MAX_INTERVIEW_BUDGET_USD) {
    throw new Error(`An interview budget must be between $${MIN_INTERVIEW_BUDGET_USD.toFixed(2)} and $${MAX_INTERVIEW_BUDGET_USD}.`);
  }
  if (!isMock() && getKey() === null) {
    throw new Error('The interview calls the Claude Platform API. Add a key in Settings — Agents.');
  }

  const id = `iv_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const at = now();
  db().prepare(`INSERT INTO interviews
    (id, project_id, seed, model, status, turns_json, proposal_json, docket_id, spend_usd, budget_usd, max_questions, calls, detail, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, project.id, seed, model, 'asking', '[]', null, null, 0, budgetUsd, requested, 0, null, at, at);
  return step(rowOf(id), null);
}

/** Answer the open question, and get the next one — or a proposal. */
export async function answerInterview(id: string, answer: string): Promise<Interview> {
  const row = rowOf(id);
  if (row.status !== 'asking') throw new Error(`This interview is ${row.status}; there is no question waiting.`);
  const turns = parseTurns(row.turns_json);
  const open = turns[turns.length - 1];
  if (!open || open.answer !== null) throw new Error('There is no question waiting for an answer.');
  open.answer = text(answer, 'An answer', MAX_ANSWER);
  db().prepare('UPDATE interviews SET turns_json=?, updated_at=? WHERE id=?')
    .run(JSON.stringify(turns), now(), id);

  // The question cap forces a proposal rather than refusing. An interview that
  // asked twelve questions and then produced nothing has spent the operator's
  // money and given them a transcript.
  const asked = turns.length;
  const cap = row.max_questions || DEFAULT_INTERVIEW_QUESTIONS;
  return step(rowOf(id), asked >= cap ? 'propose' : null);
}

/** Stop asking and propose from what the interview has. */
export async function concludeInterview(id: string): Promise<Interview> {
  const row = rowOf(id);
  if (row.status !== 'asking') throw new Error(`This interview is ${row.status}; it has nothing left to conclude.`);
  return step(row, 'propose');
}

/**
 * Accept the proposal, edits included, and write the goal.
 *
 * The edits are the point of the review step: the operator gets the last word
 * on the contract, and what they send is what is stored. Nothing here trusts
 * the proposal it is committing — createDocket runs the same validation on this
 * plan as on a hand-written one.
 */
export function commitInterview(id: string, edits?: Partial<InterviewProposal>): DocketDetail {
  const row = rowOf(id);
  if (row.status !== 'proposed') throw new Error(`This interview is ${row.status}; there is no proposal to accept.`);
  if (!row.proposal_json) throw new Error('This interview has no proposal to accept.');
  const proposed = JSON.parse(row.proposal_json) as InterviewProposal;
  const merged: InterviewProposal = {
    title: edits?.title ?? proposed.title,
    objective: edits?.objective ?? proposed.objective,
    risk: edits?.risk ?? proposed.risk,
    acceptance: edits?.acceptance ?? proposed.acceptance,
    plan: edits?.plan ?? proposed.plan,
  };

  const docket = createDocket({
    projectId: row.project_id,
    title: merged.title,
    objective: merged.objective,
    acceptance: merged.acceptance,
    risk: merged.risk,
    plan: merged.plan,
  });
  db().prepare("UPDATE interviews SET status='committed', proposal_json=?, docket_id=?, updated_at=? WHERE id=?")
    .run(JSON.stringify(merged), docket.id, now(), id);
  return docket;
}

export function abandonInterview(id: string): Interview {
  db().prepare("UPDATE interviews SET status='abandoned', updated_at=? WHERE id=? AND status IN ('asking','proposed','failed')")
    .run(now(), id);
  return interview(id);
}

/**
 * The models an interview can actually run on, with what each costs a question.
 *
 * Deliberately only the Platform API's own models. Codex, GLM and DeepSeek are
 * *agent harnesses* — Wanigan launches them as CLIs with their own logins — and
 * this path is a direct Messages API call on the operator's Platform key. There
 * is no honest way to offer "run the interview on Codex" here, and offering it
 * and failing later would be worse than saying so on the screen.
 *
 * Retired ids are dropped, and so is anything with no published rate: an
 * interview Wanigan cannot price is one it will not start.
 */
export function interviewModels(): { id: string; label: string; costPerQuestion: number }[] {
  return MODELS
    .filter((model) => !model.retired && isPricedModel(model.id))
    .map((model) => ({ id: model.id, label: model.label, costPerQuestion: costPerQuestion(model.id) }));
}
