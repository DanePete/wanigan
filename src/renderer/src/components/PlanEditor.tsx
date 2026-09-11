import { useMemo, useState } from 'react';
import type { DocketNodeKind, DocketPlanNode } from '@shared/types';
import {
  DEFAULT_DOCKET_PLAN, DOCKET_NODE_KINDS, MAX_DOCKET_NODE_DEPENDENCIES, MAX_DOCKET_PLAN_NODES,
} from '@shared/types';
import { Chip, Hint } from './bits';

/**
 * Draw a goal's task graph before the goal exists.
 *
 * control.ts has validated a proposed graph since the plan field was added —
 * the node cap, the dependency cap, the cycle walk, the single terminal review
 * and the claim-overlap rule are all there, and all covered. Nothing in the
 * renderer could reach any of it: Control called control.create without a
 * `plan`, so every goal in the app got the same four phases and the validator
 * only ever ran against the default it passes trivially. This is the half that
 * lets a person propose something else.
 *
 * The editor is not a second validator with authority. Everything here is
 * checked again in the main process, because renderer input is untrusted until
 * it has been; what these checks buy is that the operator meets a rule as a
 * control that will not do the wrong thing, or as a sentence beside the field,
 * rather than as an error thrown at them after they pressed Create.
 *
 * Two of main's rules are made structurally unrepresentable rather than merely
 * reported:
 *
 *  - **A dependency can only point at an earlier row.** That is why there is no
 *    cycle check here. A cycle needs a forward edge, the control that would
 *    draw one is not rendered, and reordering refuses any move that would turn
 *    an existing edge forward. main's walk still runs — it is the one that has
 *    to survive a hand-written plan — but a graph drawn here cannot deadlock.
 *  - **The node and dependency caps.** Add stops at MAX_DOCKET_PLAN_NODES and a
 *    prerequisite chip stops being pressable at MAX_DOCKET_NODE_DEPENDENCIES,
 *    each saying so, instead of letting someone build a 41-task graph and lose
 *    it to a refusal.
 *
 * The rest — the single terminal review, the claim overlap, the required title
 * and instructions — is reported inline against the task it belongs to, before
 * submit, in the same terms main would use.
 */

/**
 * One row of the editor: a DocketPlanNode with its optional fields made
 * present.
 *
 * `dependsOn` and `claimPath` are both optional on DocketPlanNode, and a
 * controlled input cannot be handed `undefined` without React switching it to
 * an uncontrolled field mid-edit. So the row type is the total one and
 * `toPlanNodes` narrows it back on the way out.
 */
export type PlanRow = {
  kind: DocketNodeKind;
  title: string;
  instructions: string;
  dependsOn: number[];
  claimPath: string;
};

/** A refusal the operator can read now, against the task it belongs to. */
export type PlanProblem = {
  /** The row index this attaches to, or null when it is about the graph. */
  row: number | null;
  message: string;
};

/**
 * The starting graph: the same four phases Control has always created.
 *
 * Seeded from DEFAULT_DOCKET_PLAN rather than retyped, so touching nothing in
 * this editor produces exactly the plan main would have built from its own
 * default — down to the instruction text an agent is going to be handed.
 */
export function planRowsFromDefault(): PlanRow[] {
  return DEFAULT_DOCKET_PLAN.map((node) => ({
    kind: node.kind,
    title: node.title,
    instructions: node.instructions,
    dependsOn: [...(node.dependsOn ?? [])],
    claimPath: node.claimPath ?? '',
  }));
}

/**
 * The wire shape, with an untouched claim field turned back into "declared
 * nothing".
 *
 * main distinguishes a null claim from the empty-string root claim, and the
 * empty string is what an untouched text input holds. Sending '' verbatim
 * would silently claim the whole repository for every task in the graph and
 * then refuse the graph for overlapping with itself.
 */
export function toPlanNodes(rows: PlanRow[]): DocketPlanNode[] {
  return rows.map((row) => ({
    kind: row.kind,
    title: row.title.trim(),
    instructions: row.instructions.trim(),
    dependsOn: [...row.dependsOn].sort((a, b) => a - b),
    claimPath: row.claimPath.trim() ? row.claimPath.trim() : null,
  }));
}

/** control.ts's cleanClaim, for comparison only — main does the real cleaning. */
function normalizeClaim(raw: string): string {
  const value = raw.trim().replaceAll('\\', '/');
  const trimmed = value.replace(/^\.\//, '').replace(/\/+$/, '');
  return trimmed === '.' ? '' : trimmed;
}

/** control.ts's escape check: a claim is project-relative and stays inside. */
function claimEscapes(raw: string): boolean {
  const value = raw.trim().replaceAll('\\', '/');
  return value.startsWith('/') || value.split('/').includes('..');
}

/** control.ts's overlaps(): '' is the root claim and therefore hits everything. */
function overlaps(a: string, b: string): boolean {
  if (a === '' || b === '') return true;
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

const nameOf = (rows: PlanRow[], index: number) => rows[index].title.trim() || `task ${index + 1}`;

/**
 * Which tasks each task waits on, transitively.
 *
 * A plain forward pass rather than main's depth-first walk with a visiting set,
 * because an edge here always points backwards: by the time row `index` is
 * reached, every row it depends on already holds its complete ancestor set. A
 * forward edge would be a bug in this file rather than untrusted input, so it
 * is skipped here and reported as a problem instead of being followed.
 */
function ancestorsOf(rows: PlanRow[]): Set<number>[] {
  const ancestors = rows.map(() => new Set<number>());
  rows.forEach((row, index) => {
    for (const dep of row.dependsOn) {
      if (!Number.isInteger(dep) || dep < 0 || dep >= index) continue;
      ancestors[index].add(dep);
      for (const older of ancestors[dep]) ancestors[index].add(older);
    }
  });
  return ancestors;
}

/**
 * Every reason main would refuse this graph, in main's own terms.
 *
 * Exported because Control gates Create on the same list the editor renders. A
 * button that is disabled for a reason nobody can see is the dead end this view
 * has already been fixed for twice, and a second copy of the rules would be the
 * version that drifts.
 */
export function planProblems(rows: PlanRow[]): PlanProblem[] {
  const problems: PlanProblem[] = [];
  if (rows.length === 0) return [{ row: null, message: 'A task graph needs at least one task.' }];
  if (rows.length > MAX_DOCKET_PLAN_NODES) {
    problems.push({ row: null, message: `A goal holds at most ${MAX_DOCKET_PLAN_NODES} tasks; this graph has ${rows.length}. Split the work across goals.` });
  }

  rows.forEach((row, index) => {
    if (!row.title.trim()) problems.push({ row: index, message: 'This task needs a title. It is what the goal board and the agent’s own capsule call it.' });
    else if (row.title.trim().length > 180) problems.push({ row: index, message: 'This title is longer than 180 characters.' });
    if (!row.instructions.trim()) problems.push({ row: index, message: 'This task needs instructions. They are the contract the agent is launched with.' });
    if (row.dependsOn.length > MAX_DOCKET_NODE_DEPENDENCIES) {
      problems.push({ row: index, message: `This task waits on ${row.dependsOn.length} others; the maximum is ${MAX_DOCKET_NODE_DEPENDENCIES}.` });
    }
    for (const dep of row.dependsOn) {
      if (!Number.isInteger(dep) || dep < 0 || dep >= rows.length) {
        problems.push({ row: index, message: 'This task waits on a task that is not in this graph.' });
      } else if (dep >= index) {
        problems.push({ row: index, message: `This task waits on task ${dep + 1}, which comes after it. A prerequisite has to be above the task that waits on it.` });
      }
    }
    if (row.claimPath.trim() && claimEscapes(row.claimPath)) {
      problems.push({ row: index, message: 'A claimed path is relative to the project and cannot escape it, so no leading “/” and no “..”.' });
    }
  });

  const reviews = rows.map((row, index) => (row.kind === 'review' ? index : -1)).filter((index) => index >= 0);
  if (reviews.length === 0) {
    problems.push({ row: null, message: 'A goal needs one review task; the human decision is its final gate.' });
  } else if (reviews.length > 1) {
    problems.push({ row: null, message: `A goal needs exactly one review task; this graph has ${reviews.length} (${reviews.map((index) => `task ${index + 1}`).join(', ')}).` });
  }

  const ancestors = ancestorsOf(rows);
  if (reviews.length === 1) {
    const terminal = reviews[0];
    const unreviewed = rows.map((_, index) => index).filter((index) => index !== terminal && !ancestors[terminal].has(index));
    if (unreviewed.length) {
      const names = unreviewed.map((index) => `task ${index + 1} (“${nameOf(rows, index)}”)`).join(', ');
      problems.push({ row: null, message: `The review task must wait on every other task, directly or through another. ${names} would be accepted without anyone reviewing it.` });
    }
  }

  for (let a = 0; a < rows.length; a++) {
    if (!rows[a].claimPath.trim() || claimEscapes(rows[a].claimPath)) continue;
    const left = normalizeClaim(rows[a].claimPath);
    for (let b = a + 1; b < rows.length; b++) {
      if (!rows[b].claimPath.trim() || claimEscapes(rows[b].claimPath)) continue;
      const right = normalizeClaim(rows[b].claimPath);
      // Tasks ordered by a dependency hand the path over and may share it, so
      // this compares reachability rather than the two paths alone. Getting it
      // wrong in the strict direction would forbid the ordinary
      // implement-then-verify pair from naming the same directory.
      if (ancestors[a].has(b) || ancestors[b].has(a)) continue;
      if (overlaps(left, right)) {
        problems.push({ row: null, message: `Task ${a + 1} and task ${b + 1} can run at the same time and both claim “${left || '.'}” and “${right || '.'}”. Order them with a dependency, or narrow one of the paths.` });
      }
    }
  }

  return problems;
}

/** Renumber every dependency through a new row order, dropping what is gone. */
function renumber(rows: PlanRow[], order: number[]): PlanRow[] {
  const positionOf = new Map<number, number>();
  order.forEach((from, to) => positionOf.set(from, to));
  return order.map((from) => ({
    ...rows[from],
    dependsOn: rows[from].dependsOn
      .map((dep) => positionOf.get(dep))
      .filter((dep): dep is number => dep !== undefined)
      .sort((a, b) => a - b),
  }));
}

/**
 * Swap two adjacent rows, or refuse.
 *
 * Reordering is where a naive editor invents the cycle it spent the rest of its
 * code preventing: move a task above the one it waits on and the edge is
 * suddenly forward. Rather than silently dropping that edge — which changes the
 * graph the operator drew without saying so — the move is refused, and the
 * button that would have made it says why. Refusal is decided by rebuilding the
 * graph and checking every edge, not by a special case, so it stays true when
 * the swap moves a row several edges depend on.
 */
export function reordered(rows: PlanRow[], from: number, to: number): PlanRow[] | null {
  if (to < 0 || to >= rows.length) return null;
  const order = rows.map((_, index) => index);
  order[from] = to; order[to] = from;
  const next = renumber(rows, order);
  const backwards = next.every((row, index) => row.dependsOn.every((dep) => dep < index));
  return backwards ? next : null;
}

/** Drop a row, and pull every dependency that pointed past it back into place. */
export function withoutRow(rows: PlanRow[], index: number): PlanRow[] {
  return renumber(rows, rows.map((_, i) => i).filter((i) => i !== index));
}

/**
 * Add a task, positioned so the graph it lands in is still one main accepts.
 *
 * A row appended after the review would be a task nobody reviews, which is the
 * exact refusal buildPlan writes. So a new task goes in *above* a trailing
 * review and the review is made to wait on it: the one-click path from the
 * default chain to a pair of parallel implement tasks with a fan-in review is
 * then a valid graph at every step, and the operator's next move is to give the
 * two of them disjoint claim paths rather than to repair an ordering.
 */
export function withRow(rows: PlanRow[]): PlanRow[] {
  const fresh: PlanRow = { kind: 'implement', title: '', instructions: '', dependsOn: [], claimPath: '' };
  const last = rows.length - 1;
  const at = rows.length > 0 && rows[last].kind === 'review' ? last : rows.length;
  const shifted = rows.map((row) => ({ ...row, dependsOn: row.dependsOn.map((dep) => (dep >= at ? dep + 1 : dep)) }));
  const next = [...shifted.slice(0, at), fresh, ...shifted.slice(at)];
  const terminal = next.length - 1;
  if (at < rows.length && next[terminal].dependsOn.length < MAX_DOCKET_NODE_DEPENDENCIES) {
    next[terminal] = { ...next[terminal], dependsOn: [...next[terminal].dependsOn, at].sort((a, b) => a - b) };
  }
  return next;
}

const KIND_HINT: Record<DocketNodeKind, string> = {
  plan: 'Produces the plan the rest of the graph implements. Makes no changes.',
  implement: 'Does the work in an isolated worktree, holding whatever path it claims.',
  verify: 'Runs the review gate; a passing command result is required to complete it.',
  review: 'The human decision. Never dispatched by autopilot, and the goal is accepted through it.',
};

/**
 * The editor itself: rows in graph order, each waiting only on rows above it.
 */
export default function PlanEditor({ rows, onChange }: { rows: PlanRow[]; onChange: (rows: PlanRow[]) => void }) {
  const [expanded, setExpanded] = useState<number | null>(null);
  const problems = useMemo(() => planProblems(rows), [rows]);
  const graphProblems = problems.filter((problem) => problem.row === null);
  const reviewCount = rows.filter((row) => row.kind === 'review').length;
  const atCap = rows.length >= MAX_DOCKET_PLAN_NODES;

  const patch = (index: number, change: Partial<PlanRow>) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...change } : row)));

  const toggleDep = (index: number, dep: number) => {
    const held = rows[index].dependsOn;
    const next = held.includes(dep) ? held.filter((entry) => entry !== dep) : [...held, dep].sort((a, b) => a - b);
    patch(index, { dependsOn: next });
  };

  return <div className="control-plan">
    <p className="control-plan-lead">
      Open a task to shape its instructions and prerequisites. The final review brings the work back to you.
    </p>
    <div className="control-plan-rows">
      {rows.map((row, index) => {
        const rowProblems = problems.filter((problem) => problem.row === index);
        const up = reordered(rows, index, index - 1);
        const down = reordered(rows, index, index + 1);
        const onlyReview = row.kind === 'review' && reviewCount === 1;
        const depsFull = row.dependsOn.length >= MAX_DOCKET_NODE_DEPENDENCIES;
        return <details className="control-plan-row" key={index} open={expanded === index}>
          <summary className="control-plan-summary" onClick={event => { event.preventDefault(); setExpanded(expanded === index ? null : index); }}><span>{index + 1}</span><strong>{row.title.trim() || 'Name this task'}</strong><small>{row.kind}{rowProblems.length > 0 ? ' · needs detail' : ''}</small></summary>
          <div className="control-plan-edit">
          <div className="control-plan-top">
            <span className="label">Task {index + 1}</span>
            <div className="control-plan-actions">
              <button className="btn btn-sm" type="button" disabled={up === null}
                      title={index === 0 ? 'This is already the first task.'
                        : up === null ? `Task ${index + 1} waits on task ${index}, so it cannot move above it.`
                        : `Move this task above task ${index}.`}
                      onClick={() => { if (up) { onChange(up); setExpanded(index - 1); } }}>Move up</button>
              <button className="btn btn-sm" type="button" disabled={down === null}
                      title={index === rows.length - 1 ? 'This is already the last task.'
                        : down === null ? `Task ${index + 2} waits on this one, so it cannot move below it.`
                        : `Move this task below task ${index + 2}.`}
                      onClick={() => { if (down) { onChange(down); setExpanded(index + 1); } }}>Move down</button>
              <button className="btn btn-sm" type="button" disabled={rows.length < 2 || onlyReview}
                      title={rows.length < 2 ? 'A goal needs at least one task.'
                        : onlyReview ? 'This is the goal’s only review task, and a goal is accepted through its review.'
                        : 'Remove this task; everything that waited on it stops waiting.'}
                      onClick={() => { onChange(withoutRow(rows, index)); setExpanded(null); }}>Remove</button>
            </div>
          </div>
          <div className="control-inline">
            <label><span className="label">Kind</span>
              {/* DOCKET_NODE_KINDS, not a list retyped here: main interpolates
                  that same array into the refusal it writes when a kind is
                  wrong, so a private copy could offer a fifth word this app
                  would then reject in its own dialect. */}
              <select className="field" value={row.kind} title={KIND_HINT[row.kind]}
                      onChange={(event) => patch(index, { kind: event.target.value as DocketNodeKind })}>
                {DOCKET_NODE_KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
              </select>
            </label>
            <label><span className="label">Title</span>
              <input className="field" value={row.title} maxLength={180} placeholder="What this task is"
                     onChange={(event) => patch(index, { title: event.target.value })} />
            </label>
          </div>
          <label><span className="label">Instructions</span>
            <textarea className="field control-textarea" value={row.instructions}
                      placeholder="What this task must do, and what it must not."
                      onChange={(event) => patch(index, { instructions: event.target.value })} />
          </label>
          <label><span className="label">Claim path · optional</span>
            <input className="field" value={row.claimPath} placeholder="src/cart/total.ts"
                   onChange={(event) => patch(index, { claimPath: event.target.value })} />
          </label>
          {index === 0
            ? <Hint>The first task has nothing above it to wait on, so it starts ready.</Hint>
            : <div className="control-plan-deps" role="group" aria-label={`Task ${index + 1} waits on`}>
                <span className="label">Waits on</span>
                {rows.slice(0, index).map((earlier, dep) => {
                  const pressed = row.dependsOn.includes(dep);
                  return <Chip key={dep} pressed={pressed} disabled={!pressed && depsFull}
                               title={!pressed && depsFull
                                 ? `A task waits on at most ${MAX_DOCKET_NODE_DEPENDENCIES} others.`
                                 : `Task ${dep + 1}: ${nameOf(rows, dep)}`}
                               onToggle={() => toggleDep(index, dep)}>
                    {dep + 1} · {earlier.kind}
                  </Chip>;
                })}
                {row.dependsOn.length === 0 && <span className="control-plan-parallel">nothing — runs in parallel with the tasks above it</span>}
              </div>}
          {/* A chip that has stopped being pressable with only a tooltip to say
              why is the dead end this view has been fixed for twice, so the cap
              says itself in visible text the moment it starts refusing. */}
          {depsFull && <Hint>This task already waits on the maximum {MAX_DOCKET_NODE_DEPENDENCIES} tasks, so the rest are not pressable.</Hint>}
          {rowProblems.map((problem, at) => <p className="control-plan-problem" key={at}>
            <span className="glyph" aria-hidden="true">✕</span>{problem.message}
          </p>)}
          </div>
        </details>;
      })}
    </div>
    <div className="control-plan-add">
      <button className="btn btn-sm" type="button" disabled={atCap}
              title={atCap ? `A goal holds at most ${MAX_DOCKET_PLAN_NODES} tasks.` : 'Add a task above the review, and make the review wait on it.'}
              onClick={() => { onChange(withRow(rows)); setExpanded(rows.at(-1)?.kind === 'review' ? rows.length - 1 : rows.length); }}>Add task</button>
      <button className="btn btn-sm" type="button"
              title="Go back to the four phases every goal gets by default."
              onClick={() => { onChange(planRowsFromDefault()); setExpanded(null); }}>Reset to the default four</button>
    </div>
    {atCap && <Hint>This graph holds the maximum {MAX_DOCKET_PLAN_NODES} tasks. Past that, split the work across goals.</Hint>}
    {graphProblems.map((problem, at) => <p className="control-plan-problem" key={at}>
      <span className="glyph" aria-hidden="true">✕</span>{problem.message}
    </p>)}
  </div>;
}
