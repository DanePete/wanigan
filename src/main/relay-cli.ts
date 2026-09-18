import * as relay from './relay';
import { app } from 'electron';
import { listProjects } from './store';
import { detectProviders } from './providers';
import type { RelayCreateInput, RelayRead, RelayStartRequest } from '../shared/types';

/**
 * Relays from a terminal — the two halves that spend nothing.
 *
 * `relay-create` writes the docket and its route proofs, and `relay-show`
 * prints the plan and the forecast. Neither starts an agent: every phase lands
 * `pending`, and the free half is scriptable and testable on its own.
 *
 * `relay-start` is the one command that spends, and it keeps that split rather
 * than erasing it. It requires `--spend`, and it does not launch the agent —
 * it asks the running window to, because that is the process the session has
 * to outlive this command in.
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
                               nothing
  relay-show <docketId>        the phases, their routes, and the forecast —
                               which is history, not a promise
  relay-start <docketId> <kind> --spend
                               ask the running Wanigan to start one ready
                               phase. This launches a real agent and spends
                               real money, so --spend is required`;

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

/**
 * Start one ready phase — the paid boundary, and the only command here that
 * crosses it.
 *
 * It does not start the agent. It asks the running Wanigan to, and that is the
 * whole design: a PTY belongs to the process that spawned it, so a session
 * started from a terminal dies when the terminal does. `phone-start` gets away
 * with it because it is a six-second probe that kills what it started; a relay
 * phase runs for minutes and must outlive this command by hours. Started here,
 * a shell timeout would leave the node marked `running` behind a process that
 * no longer exists — a lie in the database, which is the one thing the evidence
 * record cannot afford.
 *
 * The single-instance lock is the channel. Failing to take it *is* the signal
 * that a Wanigan is up, and Electron hands that instance our payload on its
 * way past. No socket, no port, no second way in.
 *
 * `--spend` is required and does nothing but be required. Everything else in
 * this file is free, and a command that launched an agent on the strength of a
 * docket id alone would make "relay-create then relay-start" look like one
 * motion rather than two decisions. The flag is not a safety net against a
 * mistyped id; it is the deliberate act, written down.
 */
export async function cmdRelayStart(rest: string[], say: Say): Promise<number> {
  const [docketId, kind] = rest;
  if (!docketId || !kind) { say('usage: relay-start <docketId> <kind> --spend'); return USAGE; }
  if (!rest.includes('--spend')) {
    say('Starting a phase launches a real agent and spends real money.');
    say('Re-run with --spend once that is what you mean.');
    return USAGE;
  }
  // Read first, so an unstartable phase is refused here rather than waking the
  // window to refuse it there.
  const read = relay.readRelay(docketId);
  const node = read.docket.nodes.find((entry) => entry.kind === kind);
  if (!node) {
    say(`This relay has no ${kind} phase. It holds: ${read.docket.nodes.map((entry) => entry.kind).join(', ')}.`);
    return FAILED;
  }
  if (node.kind === 'estimate') {
    say('The estimate phase is Wanigan’s own arithmetic over this project’s history. It starts no agent and costs nothing; it runs when the plan before it completes.');
    return FAILED;
  }
  if (node.status !== 'ready') {
    say(`The ${kind} phase is ${node.status}, not ready. A phase runs once the phases it depends on have finished.`);
    return FAILED;
  }
  if (!node.providerId) { say(`The ${kind} phase has no routed provider, so there is nothing to start it on.`); return FAILED; }

  const payload: RelayStartRequest = { wanigan: 'relay-start', nodeId: node.id, providerId: node.providerId };
  const gotLock = app.requestSingleInstanceLock(payload);
  if (gotLock) {
    // Nothing was listening, so nothing was asked. Release immediately: held,
    // this lock is what makes the next Wanigan launch exit without a window.
    app.releaseSingleInstanceLock();
    say('Wanigan is not running, so there is no process to own the session.');
    say('Open Wanigan and run this again. Nothing was started and nothing was spent.');
    return FAILED;
  }

  say(`Asked Wanigan to start ${kind} on ${node.providerId}${node.model ? ` · ${node.model}` : ''}…`);
  // The window answers by moving the row, which is the only acknowledgement
  // worth having: it is the same record the app and the rail read.
  for (let waited = 0; waited < 20_000; waited += 500) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const now = relay.readRelay(docketId).docket.nodes.find((entry) => entry.id === node.id);
    if (now && now.status !== 'ready') {
      say(`${kind} is ${now.status}. Watch it in Wanigan; the phase completes when the agent finishes its turn.`);
      return OK;
    }
  }
  say(`${kind} is still ready after 20 seconds, so the running Wanigan did not take it.`);
  say('Check the Relay view — the refusal, if there was one, is reported there.');
  return FAILED;
}
