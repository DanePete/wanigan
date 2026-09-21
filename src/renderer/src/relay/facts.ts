import type { DocketNode, DocketNodeKind, DocketProof, RelayNodeRead, RelayRead, RelayStageKey } from '@shared/types';
import type { RelayDeliveryKind, RelayDeliveryStage } from '@shared/relay-delivery';
import { DOCKET_NODE_KINDS } from '@shared/types';
import { cadence, gauge, sediment, seedOf, stageKeyOf, type Cadence, type Gauge, type Sediment } from '@shared/relay';

/**
 * What the rail says about each phase, derived from recorded rows and
 * nothing else.
 *
 * Every field here is a reading of a `RelayRead`: which basin holds the
 * water, whether a gate is open, how fast a basin breathes, how much silt is
 * on its floor, and the one word its pill shows. None of it comes from a
 * clock ticking or a renderer guessing. The arithmetic itself lives in
 * `src/shared/relay.ts` (cadence, sediment, seed, gauge) and is only called
 * from here, so the same numbers answer in `test:shared` and on screen.
 *
 * It is deliberately not React: no hooks, no DOM, no timers. The view feeds it
 * the last read plus the completions that arrived since, and renders what
 * comes back.
 */

export type Decision = 'approve' | 'request_changes' | 'reject';

/** The pill's `data-rl-v` value and the word it shows. The word is the signal;
 *  the value only picks a colour that agrees with it. */
export type PhaseState = { value: string; word: string };

export type Route = {
  providerId: string | null;
  model: string | null;
  effort: string | null;
  /** The router's own sentence from the route proof, or null for a node that runs no agent. */
  reason: string | null;
  source: string | null;
};

type PhaseReading = {
  id: string;
  kind: DocketNodeKind | RelayDeliveryKind;
  status: DocketNode['status'] | RelayDeliveryStage['status'];
  activityId: string;
  /** Position on the rail, top to bottom: the basin index. */
  index: number;
  route: Route;
  /** The short line etched under the phase name. */
  routeText: string;
  completions: number[];
  completed: number;
  cadence: Cadence;
  sediment: Sediment;
  seed: number;
  gauge: Gauge;
  state: PhaseState;
  decision: Decision | null;
  handbacks: number;
  /** The basin the water is in: the first phase not yet completed, or the last one once every phase is. */
  live: boolean;
  /** A gate opens when its phase completes and never shuts again on this relay. */
  gateOpen: boolean;
  /** The Simple tier's stream: the one open gate feeding the live basin. */
  streamOn: boolean;
};

export type Phase = PhaseReading & (
  | { source: 'docket'; node: DocketNode }
  | { source: 'delivery'; stage: RelayDeliveryStage }
);
export type DocketPhase = Extract<Phase, { source: 'docket' }>;

export const KIND_WORD: Record<DocketNodeKind | RelayDeliveryKind, string> = {
  plan: 'Plan', estimate: 'Estimate', implement: 'Implement', verify: 'Verify', review: 'Review', commit: 'Commit', deploy: 'Deploy',
};

/** Every relay stage key's word, the clean-up stage included. */
export const STAGE_WORD: Record<RelayStageKey, string> = { ...KIND_WORD, refine: 'Clean up' };

/**
 * The word for one docket node. Two implement nodes look alike by kind; the
 * clean-up node is told apart by its title, the same way main tells it apart.
 */
export function nodeWord(node: Pick<DocketNode, 'kind' | 'title'>): string {
  return STAGE_WORD[stageKeyOf(node)];
}

/** The phases that run an agent and so carry a route, silt and a swell. */
export const AGENT_KINDS: readonly DocketNodeKind[] = ['plan', 'implement', 'review'];

const kindRank = (node: DocketNode): number => {
  const rank = DOCKET_NODE_KINDS.indexOf(node.kind);
  return rank < 0 ? DOCKET_NODE_KINDS.length : rank;
};

/**
 * The docket's nodes in dependency order, ties broken by the kind order
 * `DOCKET_NODE_KINDS` declares. A dependency the docket does not hold is
 * ignored rather than waited on forever, and a cycle — which the main process
 * refuses, but a renderer takes nothing on trust — places the first pending
 * node rather than hanging.
 */
export function orderedNodes(nodes: readonly DocketNode[]): DocketNode[] {
  const ids = new Set(nodes.map((node) => node.id));
  const pending = [...nodes].sort((a, b) => kindRank(a) - kindRank(b));
  const placed = new Set<string>();
  const out: DocketNode[] = [];
  while (pending.length) {
    const at = pending.findIndex((node) => node.dependsOn.every((id) => placed.has(id) || !ids.has(id)));
    const [next] = pending.splice(at < 0 ? 0 : at, 1);
    placed.add(next.id);
    out.push(next);
  }
  return out;
}

/**
 * The latest recorded decision on a review node, read the way Control.tsx
 * reads it: from the `decision` proof's summary.
 */
export function decisionOf(proofs: readonly DocketProof[], nodeId: string): Decision | null {
  const latest = proofs
    .filter((proof) => proof.kind === 'decision' && proof.nodeId === nodeId)
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  if (!latest) return null;
  const summary = latest.summary.toLowerCase();
  if (/request(?:ed)? changes/.test(summary)) return 'request_changes';
  if (/reject/.test(summary)) return 'reject';
  if (/approv/.test(summary)) return 'approve';
  return null;
}

function routeOf(node: DocketNode, read: RelayNodeRead | null): Route {
  if (read?.route) {
    return {
      providerId: read.route.providerId,
      model: read.route.route.model,
      effort: read.route.route.effort,
      reason: read.route.route.reason,
      source: read.route.route.source,
    };
  }
  return { providerId: node.providerId, model: node.model, effort: read?.effort ?? null, reason: null, source: null };
}

/** The line under a phase's name: what runs it, in the fewest words that are true. */
export function routeText(kind: DocketNodeKind, route: Route): string {
  if (kind === 'estimate') return 'local · no spend';
  if (kind === 'verify') return 'gate';
  return [route.model ?? 'profile default', route.effort].filter((part): part is string => !!part).join(' · ');
}

/**
 * The level a basin may show, where one is honest. `gauge()` in relay.ts
 * refuses every phase but estimate and verify; this only finds their numbers.
 *
 * Estimate: phases priced over phases in the plan, from the recorded forecast.
 * Verify: the project's gate commands, all of them once a gate run has passed
 * since the task last (re)opened, none before. A gate proof records which
 * command failed but not how many ran before it, so a failed run reads as
 * nothing passed rather than as a count nobody recorded.
 */
function gaugeOf(node: DocketNode, read: RelayRead): Gauge {
  if (node.kind === 'estimate') {
    return read.forecast ? gauge('estimate', read.forecast.priced, read.forecast.phases) : null;
  }
  if (node.kind === 'verify') {
    const total = read.docket.reviewCommands;
    const since = node.reopenedAt ?? 0;
    const latest = read.docket.proofs
      .filter((proof) => proof.kind === 'test' && proof.nodeId === node.id && proof.createdAt >= since)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    return gauge('verify', latest?.status === 'passed' ? total : 0, total);
  }
  return null;
}

/**
 * The one word a basin's pill shows.
 *
 * A running basin whose completions have gone quiet says "quiet" in
 * words. Tool silence alone is not proof that a session has stalled. A ready
 * basin says "your call", because a phase waiting on a person is the hold
 * and stillness is not allowed to be its only announcement. A completed
 * review reads its decision.
 */
function stateOf(node: DocketNode, beat: Cadence, decision: Decision | null): PhaseState {
  if (node.kind === 'review' && (node.status === 'completed' || node.status === 'failed') && decision) {
    if (decision === 'approve') return { value: 'pass', word: 'approved' };
    if (decision === 'request_changes') return { value: 'failed', word: 'changes requested' };
    return { value: 'failed', word: 'rejected' };
  }
  switch (node.status) {
    case 'running':
      return beat.kind === 'still' && beat.reason === 'quiet'
        ? { value: 'quiet', word: 'quiet' }
        : { value: 'running', word: node.gateRunningSince !== null ? 'gate running' : 'running' };
    case 'completed': return { value: 'completed', word: 'completed' };
    case 'failed': return { value: 'failed', word: 'failed' };
    case 'canceled': return { value: 'canceled', word: 'canceled' };
    case 'blocked': return { value: 'pending', word: 'blocked' };
    case 'ready': return node.queued ? { value: 'pending', word: 'queued' } : { value: 'hold', word: 'your call' };
    default: return { value: 'pending', word: 'pending' };
  }
}

/**
 * Every phase of a relay, read from the last poll plus the completions that
 * arrived since it (`extras`, by node id). `now` is the clock the cadence is
 * measured against — the moment of the read, not a timer of the view's own.
 */
export function phasesOf(read: RelayRead, extras: Readonly<Record<string, readonly number[]>>, now: number): Phase[] {
  const nodes = orderedNodes(read.docket.nodes);
  const reads = new Map(read.nodes.map((row) => [row.nodeId, row]));

  const phases = nodes.map((node, index): Phase => {
    const row = reads.get(node.id) ?? null;
    const extra = extras[node.id] ?? [];
    const completions = [...(row?.completions ?? []), ...extra];
    const completed = (row?.completed ?? 0) + extra.length;
    const beat = cadence(completions, now);
    const decision = node.kind === 'review' ? decisionOf(read.docket.proofs.filter((proof) => proof.createdAt >= (node.reopenedAt ?? 0)), node.id) : null;
    const route = routeOf(node, row);
    const gateOpen = node.status === 'completed';
    return {
      source: 'docket', id: node.id, kind: node.kind, status: node.status,
      activityId: `${node.id}:${node.sessionId ?? 'none'}:${node.reopenedAt ?? ''}`,
      index, node, route, routeText: routeText(node.kind, route),
      completions, completed, cadence: beat, sediment: sediment(completed), seed: seedOf(node.id),
      gauge: gaugeOf(node, read), state: stateOf(node, beat, decision), decision,
      handbacks: row?.handbacks ?? 0,
      live: false, gateOpen, streamOn: false,
    };
  });
  // Delivery stages exist only when main has persisted them for this relay.
  // They are command/commit records, never invented agent task nodes.
  if (read.delivery) {
    for (const kind of ['commit', 'deploy'] as const) {
      const stage = read.delivery[kind];
      const id = `${read.docket.id}:delivery:${kind}`;
      const state = stage.status === 'completed' ? { value: 'completed', word: 'completed' }
        : stage.status === 'running' ? { value: 'running', word: 'running' }
          : stage.status === 'failed' || stage.status === 'interrupted' ? { value: 'failed', word: stage.status }
            : { value: 'pending', word: 'pending' };
      phases.push({
        source: 'delivery', stage, id, kind, status: stage.status, activityId: id,
        index: phases.length, route: { providerId: null, model: null, effort: null, reason: null, source: null },
        routeText: kind === 'commit' ? 'Local git commit' : 'Project deployment command',
        completions: [], completed: 0, cadence: cadence([], now), sediment: sediment(0), seed: seedOf(id),
        gauge: null, state, decision: null, handbacks: 0, live: false,
        gateOpen: stage.status === 'completed', streamOn: false,
      });
    }
  }
  const first = phases.findIndex((phase) => phase.status !== 'completed');
  const live = first < 0 ? phases.length - 1 : first;
  return phases.map((phase, index) => ({ ...phase, live: index === live, streamOn: phase.gateOpen && index + 1 === live }));
}

/**
 * Whether the return line is drawn: a hand-back is a pump, and it runs only
 * while the implement phase it fed is running again after at least one.
 */
export function returnOn(phases: readonly Phase[]): boolean {
  return phases.some((phase) => phase.kind === 'implement' && phase.handbacks > 0 && phase.status === 'running');
}

/** The grains each basin floor holds at a read, keyed by node id — the baseline a later diff is drawn against. */
export function grainCounts(read: RelayRead): Record<string, number> {
  return Object.fromEntries(read.nodes.map((row) => [row.nodeId, sediment(row.completed).grains]));
}
