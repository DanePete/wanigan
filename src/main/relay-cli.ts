import * as relay from './relay';
import { listProjects } from './store';
import { detectProviders } from './providers';
import type { RelayCreateInput, RelayRead } from '../shared/types';

/**
 * Relays from a terminal — the two halves that spend nothing.
 *
 * `relay-create` writes the docket and its route proofs, and `relay-show`
 * prints the plan and the forecast. Neither starts an agent: every phase lands
 * `pending`, and starting one is still a deliberate act in the app, where the
 * consent and the spend live. That split is the point of having this at all —
 * it makes the free half scriptable and testable without putting a paid launch
 * behind a flag somebody could pass by accident.
 *
 * The estimate phase is free in the same sense: it is a query over this
 * project's own completed phases, with no provider call, so `relay-show` can
 * price a relay before anyone has approved anything.
 */

type Say = (line: string) => void;

const OK = 0;
const FAILED = 1;
const USAGE = 2;

export const RELAY_CLI_HELP = `  relay-create <project> <intent…> [--provider ID] [--account ID] [--model M] [--effort E]
                               plan a relay: a docket, five phases and one
                               route proof each. Starts no agent and spends
                               nothing; phases are started in the app
  relay-show <docketId>        the phases, their routes, and the forecast —
                               which is history, not a promise`;

/** A project by id, or by a unique case-insensitive name fragment. */
function resolveProject(token: string): { id: string; name: string } {
  const projects = listProjects();
  const exact = projects.find((project) => project.id === token);
  if (exact) return exact;
  const needle = token.toLowerCase();
  // An exact name wins before any fragment. Without this, naming a project
  // exactly was ambiguous whenever another project's name contained it —
  // "wanigan" refused because "wanigan-night" also matched, which is a refusal
  // the operator cannot act on by being more precise, since they already were.
  const named = projects.find((project) => project.name.toLowerCase() === needle);
  if (named) return named;
  const hits = projects.filter((project) => project.name.toLowerCase().includes(needle));
  if (hits.length === 1) return hits[0]!;
  if (!hits.length) {
    throw new Error(`No registered project matches "${token}". Known: ${projects.map((p) => p.name).join(', ') || 'none'}.`);
  }
  throw new Error(`"${token}" matches ${hits.length} projects (${hits.map((p) => p.name).join(', ')}). Name one exactly.`);
}

function flag(rest: string[], name: string): string | undefined {
  const at = rest.indexOf(`--${name}`);
  if (at < 0) return undefined;
  const value = rest[at + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`--${name} needs a value.`);
  return value;
}

/** Everything that is not a flag or a flag's value, joined — the intent. */
function words(rest: string[]): string {
  const out: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (token.startsWith('--')) { i += 1; continue; }
    out.push(token);
  }
  return out.join(' ').trim();
}

function printRead(read: RelayRead, say: Say): void {
  say(`${read.docket.title}`);
  say(`  ${read.docket.id} · ${read.docket.nodes.length} phases`);
  for (const node of read.docket.nodes) {
    const route = node.kind === 'estimate'
      ? 'Wanigan itself — no agent, no provider call'
      : [node.providerId, node.model, node.effort, node.accountId ? `account ${node.accountId}` : null]
        .filter(Boolean).join(' · ') || 'profile default';
    say(`  ${node.status.padEnd(9)} ${node.kind.padEnd(10)} ${route}`);
  }
}

export async function cmdRelayCreate(rest: string[], say: Say): Promise<number> {
  const [projectToken, ...tail] = rest;
  if (!projectToken) { say('usage: relay-create <project> <intent…> [--provider ID] [--account ID] [--model M] [--effort E]'); return USAGE; }
  const intent = words(tail);
  if (!intent) { say('An intent is required: say what done looks like.'); return USAGE; }

  const project = resolveProject(projectToken);
  // The first profile whose CLI actually resolves on this machine: `path` is
  // null for one that is declared but not installed, and routing a relay to it
  // would fail at the first phase rather than here.
  const providerId = flag(rest, 'provider') ?? (await detectProviders()).find((info) => info.path !== null)?.id;
  if (!providerId) { say('No installed provider profile to route this relay to.'); return FAILED; }

  const model = flag(rest, 'model');
  const effort = flag(rest, 'effort');
  const accountId = flag(rest, 'account');
  // A model or effort named once applies to every agent phase. Per-stage
  // routing is the app's job; this is the "one profile, one account" shape a
  // script wants, and the router still refuses anything the profile does not
  // declare rather than clamping it.
  const stage = model || effort ? { model, effort } : undefined;
  const input: RelayCreateInput = {
    projectId: project.id,
    intent,
    providerId,
    ...(accountId ? { accountId } : {}),
    ...(stage ? { routes: { plan: stage, implement: stage, verify: stage, review: stage } } : {}),
  };

  const read = await relay.createRelay(input);
  say(`Planned a relay on ${project.name}.`);
  printRead(read, say);
  say('');
  say('Nothing has started and nothing has been spent. Open Relay in Wanigan to start the plan');
  say(`phase, or read the forecast first with:  npm run cli -- relay-show ${read.docket.id}`);
  return OK;
}

export function cmdRelayShow(rest: string[], say: Say): number {
  const docketId = rest[0];
  if (!docketId) { say('usage: relay-show <docketId>'); return USAGE; }
  const read = relay.readRelay(docketId);
  printRead(read, say);

  const forecast = relay.forecast(docketId);
  say('');
  say(`Forecast — ${forecast.priced} of ${forecast.phases} phases priced, from this project's own history.`);
  for (const phase of forecast.perPhase) {
    if (phase.medianMs === null && phase.medianUsd === null) {
      say(`  ${phase.kind.padEnd(10)} no comparable history yet (${phase.n} runs at the closest rung)`);
      continue;
    }
    const time = phase.medianMs === null ? 'no time' : `${Math.round(phase.medianMs / 60_000)} min`;
    const cost = phase.medianUsd === null
      ? 'no reported cost'
      : `$${phase.medianUsd.toFixed(2)}`;
    say(`  ${phase.kind.padEnd(10)} ${time} · ${cost} · from ${phase.n} runs at the ${phase.basis} rung`);
  }
  say('');
  // Said plainly because the shape invites the opposite reading: these are
  // medians of what happened before, on a different intent, and the label the
  // forecast carries is `estimate` for exactly that reason.
  say(forecast.totalUsd === null
    ? 'No total: a total of some phases is not the cost of the relay, so none is offered.'
    : `Total of the priced phases: $${forecast.totalUsd.toFixed(2)} — an estimate from past runs, never a quote.`);
  return OK;
}
