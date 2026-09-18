import { randomUUID } from 'node:crypto';
import { db } from './db';
import { HaltedError, halted } from './halt';
import { projectById } from './store';
import { launchFieldsFor, providerById } from './providers';
import { providerModelCatalogue } from './launch-choices';
import * as control from './control';
import * as accounts from './accounts';
import * as otel from './otel';
import { intersectChoices, launchFieldChoices } from '../shared/launch-fields';
import { chooseStage, type RouteCandidate, type RouteDefaults, type StageRoute } from '../shared/relay-route';
import { MIN_HISTORY, forecastPhase, forecastTotals, type ForecastSample } from '../shared/relay-forecast';
import { HANDBACK_LIMIT } from '../shared/gate-feedback';
import { DOCKET_NODE_KINDS } from '../shared/types';
import type {
  DocketDetail, DocketNode, DocketNodeKind, RelayCreateInput, RelayForecast, RelayNodeRead, RelayPhaseForecast,
  RelayRead, WorkDocket,
} from '../shared/types';

/**
 * Relay: one intent, a staged docket, each stage routed to a profile before
 * anything starts, priced from this project's own history before the operator
 * approves, and a failed review handed back to the implementer a bounded
 * number of times.
 *
 * It owns no table and no scheduler. A relay is a `work_dockets` row created
 * through `control.createDocket` from the shared default plan, marked with the
 * additive `relay` column; its routing decisions and its forecast are
 * `work_proofs` rows (`kind='route'`, `kind='estimate'`) beside the plan and
 * the gate results the operator already reads; its stages start through
 * `control.startNode` exactly as any goal task does. What is new here is the
 * arithmetic between those existing moves, and every result of it is either a
 * recorded row or a thrown sentence — nothing here returns a silent null,
 * calls a model, or auto-commits anything.
 *
 * The router (`shared/relay-route.ts`) is handed the profile's declared
 * candidates and nothing wider; the forecast (`shared/relay-forecast.ts`) is
 * handed rows and nothing invented. Both are pure, so this module is the SQL
 * and the sequencing and nothing else.
 */

/** Most recent completed tool calls a node read carries; `cadence()` needs three and the pile caps at 24. */
const COMPLETIONS_MAX = 64;
/** Completed phases the forecast reads at most, newest first. Two thousand is years of goals on one project. */
const HISTORY_MAX = 2_000;
/** Longest title derived from an intent; the intent itself is bounded by `control.MAX_OBJECTIVE`. */
const TITLE_MAX = 120;
/** Longest provider, model or effort name an override may carry. */
const ROUTE_VALUE_MAX = 200;
/** Tool-call events that mean a call finished. A failed call still finished; the agent got its answer and moved on. */
const COMPLETION_EVENTS = "('PostToolUse','PostToolUseFailure')";

const uid = (prefix: string) => `${prefix}_${randomUUID().slice(0, 12)}`;
const now = () => Date.now();

/** A required string from the renderer, trimmed and bounded, or a sentence. */
function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`);
  const flat = value.trim();
  if (flat.length > max) throw new Error(`${label} is too long (maximum ${max.toLocaleString()} characters).`);
  return flat;
}

/** An optional string: absent or blank is undefined, anything else is checked as `text` is. */
function optional(value: unknown, label: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`${label} must be text.`);
  return value.trim() ? text(value, label, max) : undefined;
}

/** The first line of an intent, fit for a goal title. */
function titleOf(intent: string): string {
  const line = intent.split('\n').map((part) => part.replace(/\s+/g, ' ').trim()).find((part) => part.length > 0) ?? intent;
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
}

type StageOverride = { providerId?: string; model?: string; effort?: string; accountId?: string | null; permissionMode?: string };

/**
 * The operator's per-stage overrides, checked field by field. A key that is
 * not a stage kind is refused by name: an unknown key would otherwise be
 * silently ignored, and the operator would believe a stage was pinned.
 */
function readRoutes(raw: unknown): Partial<Record<DocketNodeKind, StageOverride>> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Stage routes must be an object keyed by stage kind.');
  const out: Partial<Record<DocketNodeKind, StageOverride>> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!DOCKET_NODE_KINDS.includes(key as DocketNodeKind)) {
      throw new Error(`Unknown stage "${key}"; a relay routes one of: ${DOCKET_NODE_KINDS.join(', ')}.`);
    }
    if (key === 'estimate') throw new Error('The estimate stage runs no agent, so it takes no route.');
    if (value === undefined || value === null) continue;
    if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`The route for the ${key} stage must be an object.`);
    const over = value as Record<string, unknown>;
    out[key as DocketNodeKind] = {
      providerId: optional(over.providerId, `The ${key} stage's provider`, ROUTE_VALUE_MAX),
      model: optional(over.model, `The ${key} stage's model`, ROUTE_VALUE_MAX),
      effort: optional(over.effort, `The ${key} stage's effort`, ROUTE_VALUE_MAX),
      // null is a value here, not an absence: it means "this stage resolves its
      // account the ordinary way" even when the relay pinned one above it.
      accountId: over.accountId === null ? null : optional(over.accountId, `The ${key} stage's account`, ROUTE_VALUE_MAX),
      permissionMode: optional(over.permissionMode, `The ${key} stage's permission mode`, ROUTE_VALUE_MAX),
    };
  }
  return out;
}

/**
 * The account a stage will launch as, refused here rather than at launch.
 *
 * `createSession` would reject a bad id too, but five phases are written in one
 * transaction and started hours apart: a relay that accepted an account the
 * harness cannot use would look correct on the rail and fail on the phase that
 * reached it, after the phases before it had already spent. So the same check
 * `accounts.resolve` makes is made now, by name, before anything is written.
 * Null is not "no account" — it is "resolve it the way every other session
 * does", which is the project's account and then the default.
 */
function accountFor(id: string | null | undefined, harness: string, where: string): string | null {
  if (id === undefined || id === null || id === '') return null;
  const account = accounts.byId(id);
  if (!account) throw new Error(`${where} names an account that no longer exists.`);
  if (account.harness !== harness) {
    throw new Error(`${where} names an account for ${account.harness}, but that stage runs on ${harness}.`);
  }
  if (!accounts.supportsAccounts(harness)) {
    throw new Error(`${where} names an account, but ${harness} has no configuration directory Wanigan can switch.`);
  }
  return account.id;
}

/** A profile's legal move set for the router, read once per profile per relay. */
type Profile = {
  providerId: string;
  candidates: RouteCandidate[];
  defaults: RouteDefaults;
  /** Where the candidate rows came from, kept on the proof so a later reader knows what "declared" meant that day. */
  catalogue: string;
  note: string | null;
};

/**
 * What one profile declares, in the shape `chooseStage` takes.
 *
 * The candidate rows are exactly what `launch-choices.ts` gives the New session
 * dialog: the profile's declaration intersected with its backend's catalogue,
 * never widened. Each row's efforts are the profile's declared levels narrowed
 * by what the catalogue says that model accepts, which is the same
 * intersection the dialog performs; a profile that takes no effort at all
 * declares none for any row. The default is the profile's own or nothing —
 * `launchFieldChoices` never invents one, and neither does this.
 */
async function profileFor(providerId: string): Promise<Profile> {
  const def = providerById(providerId);
  if (!def) throw new Error(`The profile “${providerId}” is not installed, so no stage can be routed to it.`);
  const info = { backendId: def.backendId, supports: def.supports, launchFields: launchFieldsFor(def) };
  const models = launchFieldChoices(info, 'model');
  const efforts = launchFieldChoices(info, 'effort');
  const catalogue = models.supported ? await providerModelCatalogue(info) : { rows: [], source: 'none' as const, note: null };
  const levels = efforts.supported ? efforts.choices : [];
  const candidates: RouteCandidate[] = catalogue.rows.map((row) => {
    const declared = intersectChoices(levels, row.efforts).map((choice) => choice.value);
    return { model: row.value, label: row.label, efforts: declared.length ? declared : null };
  });
  return {
    providerId,
    candidates,
    defaults: { model: models.defaultValue || null, effort: efforts.defaultValue || null },
    catalogue: catalogue.source,
    note: catalogue.note,
  };
}

type Pick_ = { providerId: string; route: StageRoute; profile: Profile; accountId: string | null; permissionMode: string | null };

/**
 * Create a relay: a docket from the default plan, every agent stage routed
 * before a row is written, and one `route` proof per routed node.
 *
 * Routing happens first and the docket second, so an override the profile
 * does not declare refuses the whole request and leaves nothing behind: the
 * router's own sentence is thrown, because a relay that quietly ran the
 * default where the operator chose something else would record a decision
 * they never made. The estimate node gets no route and no provider — it runs
 * no agent — and the node columns for the rest are written here so the
 * forecast and the rail read the decision from the row, not only from the
 * proof.
 */
export async function createRelay(raw: RelayCreateInput): Promise<RelayRead> {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Partial<RelayCreateInput>;
  const projectId = text(input.projectId, 'Project', 200);
  if (!projectById(projectId)) throw new Error('Choose a registered project before starting a relay.');
  const intent = text(input.intent, 'Intent', control.MAX_OBJECTIVE);
  const providerId = text(input.providerId, 'Provider', ROUTE_VALUE_MAX);
  const routes = readRoutes(input.routes);
  // Relay-level defaults. Each stage may name its own, and a stage naming null
  // steps out of the relay's pin entirely.
  const relayAccountId = input.accountId === null ? null : optional(input.accountId, 'The account', ROUTE_VALUE_MAX);
  const relayPermissionMode = optional(input.permissionMode, 'The permission mode', ROUTE_VALUE_MAX);
  const acceptance = Array.isArray(input.acceptance)
    ? input.acceptance.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).map((value) => value.trim())
    : [];
  if (acceptance.length === 0) {
    acceptance.push('The work satisfies the intent as written.', 'The review gate passes and a human review decision is recorded.');
  }

  const profiles = new Map<string, Profile>();
  const load = async (id: string): Promise<Profile> => {
    const cached = profiles.get(id);
    if (cached) return cached;
    const profile = await profileFor(id);
    profiles.set(id, profile);
    return profile;
  };
  const picks = new Map<DocketNodeKind, Pick_>();
  for (const kind of DOCKET_NODE_KINDS) {
    if (kind === 'estimate') continue;
    const wants = routes[kind];
    const stageProvider = wants?.providerId ?? providerId;
    const profile = await load(stageProvider);
    const operator = wants && (wants.model !== undefined || wants.effort !== undefined)
      ? { model: wants.model, effort: wants.effort } : undefined;
    const route = chooseStage(kind, profile.candidates, profile.defaults, null, operator ? { operator } : undefined);
    if (operator && route.source !== 'operator') throw new Error(route.reason);
    // The stage's own account, then the relay's, then null. A stage that names
    // null explicitly opts out of the relay's pin and resolves the ordinary way.
    const info = providerById(stageProvider);
    const harness = info?.harness ?? '';
    const wanted = wants && 'accountId' in wants ? wants.accountId : relayAccountId;
    const accountId = accountFor(wanted, harness, `The ${kind} stage`);
    picks.set(kind, {
      providerId: stageProvider, route, profile, accountId,
      permissionMode: wants?.permissionMode ?? relayPermissionMode ?? null,
    });
  }

  const created = control.createDocket({ projectId, title: titleOf(intent), objective: intent, acceptance, risk: 'elevated' });
  const at = now();
  db().transaction(() => {
    db().prepare('UPDATE work_dockets SET relay=1, updated_at=? WHERE id=?').run(at, created.id);
    for (const node of created.nodes) {
      const pick = picks.get(node.kind);
      if (!pick) continue;
      db().prepare('UPDATE work_nodes SET provider_id=?, model=?, effort=?, account_id=?, permission_mode=? WHERE id=?')
        .run(pick.providerId, pick.route.model, pick.route.effort, pick.accountId, pick.permissionMode, node.id);
      db().prepare(`INSERT INTO work_proofs (id,docket_id,node_id,kind,status,summary,detail_json,created_at)
        VALUES (?,?,?,'route','recorded',?,?,?)`)
        .run(uid('proof'), created.id, node.id, pick.route.reason, JSON.stringify({
          providerId: pick.providerId,
          // On the proof as well as the row: a route proof is the record of
          // what was decided, and "which account pays" is part of that decision.
          accountId: pick.accountId,
          permissionMode: pick.permissionMode,
          ...pick.route,
          candidates: pick.profile.candidates.map((row) => row.model),
          catalogue: pick.profile.catalogue,
          note: pick.profile.note,
        }), at);
    }
  })();
  return readRelay(created.id);
}

type NodeColumns = { id: string; session_id: string | null; effort: string | null; handbacks: number };

/** The columns `control.docket` does not map, read once per docket. */
function nodeColumns(docketId: string): Map<string, NodeColumns> {
  const rows = db().prepare('SELECT id, session_id, effort, handbacks FROM work_nodes WHERE docket_id=?').all(docketId) as NodeColumns[];
  return new Map(rows.map((row) => [row.id, row]));
}

const ROUTE_SOURCES = new Set(['profile-default', 'suggested', 'operator']);

/** The newest `route` proof per node, parsed; a node with none, or with one this build cannot read, has null. */
function routesFor(docketId: string): Map<string, NonNullable<RelayNodeRead['route']>> {
  const rows = db().prepare(`SELECT id, node_id, detail_json, created_at FROM work_proofs
    WHERE docket_id=? AND node_id IS NOT NULL AND kind='route' ORDER BY created_at DESC, rowid DESC`)
    .all(docketId) as { id: string; node_id: string; detail_json: string; created_at: number }[];
  const out = new Map<string, NonNullable<RelayNodeRead['route']>>();
  for (const row of rows) {
    if (out.has(row.node_id)) continue;
    let detail: Record<string, unknown>;
    try { detail = JSON.parse(row.detail_json) as Record<string, unknown>; } catch { continue; }
    if (!detail || typeof detail !== 'object' || !ROUTE_SOURCES.has(String(detail.source)) || typeof detail.reason !== 'string') continue;
    const str = (value: unknown) => typeof value === 'string' ? value : null;
    out.set(row.node_id, {
      proofId: row.id,
      createdAt: row.created_at,
      providerId: str(detail.providerId),
      route: {
        model: str(detail.model),
        effort: str(detail.effort),
        source: detail.source as StageRoute['source'],
        confidence: typeof detail.confidence === 'number' && Number.isFinite(detail.confidence) ? detail.confidence : null,
        reason: detail.reason,
      },
    });
  }
  return out;
}

/** The latest recorded forecast for a docket, or null until the estimate phase has run. */
function latestForecast(docketId: string): RelayForecast | null {
  const row = db().prepare(`SELECT detail_json FROM work_proofs
    WHERE docket_id=? AND kind='estimate' AND status='recorded' ORDER BY created_at DESC, rowid DESC LIMIT 1`)
    .get(docketId) as { detail_json: string } | undefined;
  if (!row) return null;
  try {
    const value = JSON.parse(row.detail_json) as RelayForecast;
    return value && Array.isArray(value.perPhase) && typeof value.computedAt === 'number' ? value : null;
  } catch {
    return null;
  }
}

/**
 * The docket as Control reads it, plus what the rail needs per node: the
 * recorded finish times of the session's tool calls, its recorded route, its
 * effort and how many hand-backs it has taken. The rail derives every moving
 * thing from these rows and nothing else.
 */
export function readRelay(docketId: unknown): RelayRead {
  const id = text(docketId, 'Goal', 200);
  const docket = control.docket(id);
  const flag = db().prepare('SELECT relay FROM work_dockets WHERE id=?').get(id) as { relay: number } | undefined;
  const columns = nodeColumns(id);
  const routes = routesFor(id);
  const recent = db().prepare(`SELECT at FROM session_events WHERE session_id=? AND event IN ${COMPLETION_EVENTS} ORDER BY at DESC LIMIT ?`);
  const count = db().prepare(`SELECT COUNT(*) AS n FROM session_events WHERE session_id=? AND event IN ${COMPLETION_EVENTS}`);
  const nodes: RelayNodeRead[] = docket.nodes.map((node) => {
    const column = columns.get(node.id);
    const sessionId = column?.session_id ?? null;
    const completions = sessionId
      ? (recent.all(sessionId, COMPLETIONS_MAX) as { at: number }[]).map((row) => row.at).reverse()
      : [];
    const completed = sessionId ? (count.get(sessionId) as { n: number }).n : 0;
    return {
      nodeId: node.id,
      effort: column?.effort ?? null,
      handbacks: column?.handbacks ?? 0,
      completions,
      completed,
      route: routes.get(node.id) ?? null,
    };
  });
  return { docket, relay: flag?.relay === 1, nodes, forecast: latestForecast(id), handbackLimit: HANDBACK_LIMIT };
}

type HistoryRow = {
  id: string; kind: string; provider_id: string; model: string | null; effort: string | null;
  started_at: number; ended_at: number; session_id: string | null;
};

/**
 * This project's completed phases as forecast samples, by kind.
 *
 * Duration is `ended_at − started_at` on the node row, which is the phase's
 * most recent run: a reopened task's earlier run is gone from that row and is
 * not reconstructed. Effort is the node's own, falling back to the effort its
 * session was launched at, so goals started before the column existed still
 * count at the rung they actually ran at.
 *
 * Cost is the reported provider cost of every session the phase ran under —
 * the live pointer and the `work_node_sessions` record, the same union the
 * autopilot cap sums over — and only when every one of those sessions reported
 * a cost. A phase with an unreported session is a sample with no price, never
 * a cheap one. Nothing here leaves the machine: it is the session metrics the
 * CLIs already wrote, read back.
 */
function historyFor(projectId: string, excludeDocketId: string): Map<DocketNodeKind, ForecastSample[]> {
  const rows = db().prepare(`SELECT n.id, n.kind, n.provider_id, n.model, COALESCE(n.effort, s.effort) AS effort,
      n.started_at, n.ended_at, n.session_id
    FROM work_nodes n JOIN work_dockets d ON d.id = n.docket_id LEFT JOIN session_log s ON s.id = n.session_id
    WHERE d.project_id = ? AND n.docket_id != ? AND n.status = 'completed' AND n.provider_id IS NOT NULL
      AND n.started_at IS NOT NULL AND n.ended_at IS NOT NULL AND n.ended_at >= n.started_at
    ORDER BY n.ended_at DESC LIMIT ?`).all(projectId, excludeDocketId, HISTORY_MAX) as HistoryRow[];
  const sessionsOf = new Map<string, Set<string>>();
  for (const row of rows) sessionsOf.set(row.id, new Set(row.session_id ? [row.session_id] : []));
  const recorded = db().prepare(`SELECT ws.node_id, ws.session_id FROM work_node_sessions ws
    JOIN work_nodes n ON n.id = ws.node_id JOIN work_dockets d ON d.id = n.docket_id
    WHERE d.project_id = ? AND n.docket_id != ?`).all(projectId, excludeDocketId) as { node_id: string; session_id: string }[];
  for (const row of recorded) sessionsOf.get(row.node_id)?.add(row.session_id);
  const every = new Set<string>();
  for (const set of sessionsOf.values()) for (const sessionId of set) every.add(sessionId);
  const usage = every.size ? otel.usageForMany([...every]) : {};

  const out = new Map<DocketNodeKind, ForecastSample[]>();
  for (const row of rows) {
    if (!DOCKET_NODE_KINDS.includes(row.kind as DocketNodeKind)) continue;
    const sessions = [...(sessionsOf.get(row.id) ?? [])];
    let costUsd: number | null = sessions.length ? 0 : null;
    for (const sessionId of sessions) {
      const reading = usage[sessionId];
      if (!reading || reading.costStatus !== 'reported') { costUsd = null; break; }
      costUsd = (costUsd ?? 0) + reading.costUsd;
    }
    const sample: ForecastSample = {
      providerId: row.provider_id, model: row.model, effort: row.effort,
      durationMs: row.ended_at - row.started_at, costUsd,
    };
    const list = out.get(row.kind as DocketNodeKind) ?? [];
    list.push(sample);
    out.set(row.kind as DocketNodeKind, list);
  }
  return out;
}

/**
 * The forecast for a docket: each agent phase priced at its recorded route
 * from the medians of this project's comparable completed phases.
 *
 * Local SQL only — no egress, no credential, no model call — and always
 * labelled `estimate`: nothing here fixes provider, model, effort and commit
 * in a controlled run, so nothing here may claim more. The estimate phase
 * itself is left out of the list: it runs no agent, so it has no duration to
 * draw from and no price, and a row of zeros for it would be a claim that it
 * was measured.
 */
function forecastFor(docket: DocketDetail): RelayForecast {
  const routes = routesFor(docket.id);
  const columns = nodeColumns(docket.id);
  const history = historyFor(docket.projectId, docket.id);
  const perPhase: RelayPhaseForecast[] = docket.nodes.filter((node) => node.kind !== 'estimate').map((node) => {
    const recorded = routes.get(node.id);
    const route = recorded
      ? { providerId: recorded.providerId, model: recorded.route.model, effort: recorded.route.effort }
      : { providerId: node.providerId, model: node.model, effort: columns.get(node.id)?.effort ?? null };
    return { nodeId: node.id, kind: node.kind, route, ...forecastPhase(route, history.get(node.kind) ?? []) };
  });
  return { perPhase, ...forecastTotals(perPhase), evidenceLevel: 'estimate', computedAt: now() };
}

export function forecast(docketId: unknown): RelayForecast {
  return forecastFor(control.docket(text(docketId, 'Goal', 200)));
}

/** A duration in words an operator reads on a proof row. */
function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60); const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} hour${hours === 1 ? '' : 's'}`;
}

/**
 * The sentence the estimate proof carries. It crosses to the phone as the
 * whole record, so it names the total, the weakest N and the rung of every
 * phase — the three things a reader needs to know how far to trust it — and
 * calls itself an estimate.
 */
function forecastSentence(value: RelayForecast): string {
  if (value.priced === 0) {
    return `Not enough history yet: none of this goal’s ${value.phases} agent phase${value.phases === 1 ? '' : 's'} has ${MIN_HISTORY} comparable completed phases on this project, so no number was drawn. An estimate would have been invented; none was.`;
  }
  const rungs = value.perPhase.filter((phase) => phase.basis !== 'none')
    .map((phase) => `${phase.kind} from ${phase.n} at the ${phase.basis} rung${phase.medianUsd === null ? `, ${phase.nPriced} priced` : ''}`).join('; ');
  const time = value.totalMs !== null
    ? `about ${duration(value.totalMs)} in all`
    : `${value.priced} of ${value.phases} phases have a duration, so no total`;
  const cost = value.totalUsd !== null
    ? `about $${value.totalUsd.toFixed(2)} in reported cost`
    : `no cost total, because at least one phase has fewer than ${MIN_HISTORY} priced runs`;
  return `Estimate from this project’s history: ${time}; ${cost}; weakest N ${value.n} (${rungs}). Medians of recorded phases, not a measurement of this one.`;
}

/**
 * Run the estimate phase for a docket whose estimate node is ready: compute the
 * forecast, complete the node through Control's own completion path with the
 * sentence as its note, and record the forecast as an `estimate` proof.
 */
async function runEstimate(docket: DocketDetail, node: DocketNode): Promise<void> {
  const value = forecastFor(docket);
  const summary = forecastSentence(value);
  await control.completeNode(node.id, { detail: summary });
  db().prepare(`INSERT INTO work_proofs (id,docket_id,node_id,kind,status,summary,detail_json,created_at)
    VALUES (?,?,?,'estimate','recorded',?,?,?)`).run(uid('proof'), docket.id, node.id, summary, JSON.stringify(value), now());
}

/**
 * Run the estimate phase by hand. The phase runs itself when the plan before
 * it completes (see the listener at the bottom); this is for a docket whose
 * automatic run was refused and recorded, or whose plan was completed while
 * the automatic path was not there to see it.
 */
export async function estimate(docketId: unknown): Promise<RelayRead> {
  const id = text(docketId, 'Goal', 200);
  const docket = control.docket(id);
  const node = docket.nodes.find((candidate) => candidate.kind === 'estimate');
  if (!node) throw new Error('This goal has no estimate phase. Goals created before the phase existed price nothing; a new goal gets one.');
  if (node.status === 'completed') throw new Error('The estimate phase has already run for this goal; its forecast is recorded beside the plan.');
  if (node.status !== 'ready') throw new Error(`The estimate phase is ${node.status}; it runs once the plan before it is complete.`);
  await runEstimate(docket, node);
  return readRelay(id);
}

/** Relays in a project, newest first. */
export function listRelays(projectId: unknown, limit = 50): WorkDocket[] {
  const id = text(projectId, 'Project', 200);
  if (!projectById(id)) throw new Error('That project is not registered with Wanigan.');
  const max = Math.max(1, Math.min(200, Math.round(Number.isFinite(limit) ? limit : 50)));
  const ids = db().prepare('SELECT id FROM work_dockets WHERE project_id=? AND relay=1 ORDER BY created_at DESC, rowid DESC LIMIT ?')
    .all(id, max) as { id: string }[];
  return ids.map((row) => control.docket(row.id));
}

/** The tasks a review stands on, walking its dependencies. */
function upstream(docket: DocketDetail, nodeId: string): DocketNode[] {
  const byId = new Map(docket.nodes.map((node) => [node.id, node]));
  const seen = new Set<string>();
  const out: DocketNode[] = [];
  const walk = (id: string) => {
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (seen.has(dep)) continue;
      seen.add(dep);
      const node = byId.get(dep);
      if (!node) continue;
      out.push(node);
      walk(dep);
    }
  };
  walk(nodeId);
  return out;
}

/** What became of a hand-back, recorded on the task it was for in the shape gate proofs already use. */
function recordHandBack(docketId: string, nodeId: string, handBack: { sent: boolean; attempt: number | null; sentence: string }): void {
  db().prepare(`INSERT INTO work_proofs (id,docket_id,node_id,kind,status,summary,detail_json,created_at)
    VALUES (?,?,?,'review',?,?,?,?)`)
    .run(uid('proof'), docketId, nodeId, handBack.sent ? 'recorded' : 'failed', handBack.sentence, JSON.stringify({ handBack }), now());
}

/**
 * Hand a failed review back to the implementer, inside the cap.
 *
 * Runs only for a relay, only on a `request_changes` decision, and only after
 * that decision is durable. The reopen is Control's own `retryNode`, which
 * already sends a review's request for changes back to the completed
 * implementation and verification it stands on; what this adds is the count.
 * The counter is bumped in the same statement that checks it, so two decisions
 * racing to the same slot cannot both take it, and it is never reset by a
 * reopen, so the cap holds across restarts. Every refusal is written where the
 * hand-back would have been: halted, over budget, at the cap, or a graph with
 * no single implementer to hand to. A hand-back here is a reopen, not text
 * typed into a live prompt, so the "still waiting at the prompt it stopped at"
 * refusal the gate hand-back needs has nothing to protect and is not applied.
 */
function handBack(docketId: string, reviewNodeId: string): void {
  const docket = control.docket(docketId);
  const implementers = upstream(docket, reviewNodeId).filter((node) => node.kind === 'implement');
  const target = implementers.length === 1 ? implementers[0] : null;
  const refuse = (sentence: string) => recordHandBack(docketId, target?.id ?? reviewNodeId, { sent: false, attempt: null, sentence });
  if (!target) {
    refuse(implementers.length === 0
      ? 'The reviewer requested changes, but no implementation task leads to this review, so there is nothing to hand them back to.'
      : `The reviewer requested changes, but ${implementers.length} implementation tasks lead to this review and Wanigan hands back to exactly one, so this waits for you.`);
    return;
  }
  const taken = db().prepare('SELECT handbacks FROM work_nodes WHERE id=?').get(target.id) as { handbacks: number } | undefined;
  const count = taken?.handbacks ?? 0;
  if (halted()) { refuse(new HaltedError('hand the failed review back to the implementer').message); return; }
  if (docket.budgetUsd !== null && docket.autopilot.spendUsd >= docket.budgetUsd) {
    refuse(`This relay’s reported spend of $${docket.autopilot.spendUsd.toFixed(2)} has reached its $${docket.budgetUsd.toFixed(2)} budget, so Wanigan did not start another implementation turn; the reviewer’s request waits for you.`);
    return;
  }
  if (count >= HANDBACK_LIMIT) {
    refuse(`This task has already been handed back ${HANDBACK_LIMIT} times, so the reviewer’s request waits for you.`);
    return;
  }
  const attempt = db().transaction((): number | null => {
    const changed = db().prepare('UPDATE work_nodes SET handbacks=handbacks+1 WHERE id=? AND handbacks=?').run(target.id, count).changes;
    if (changed !== 1) return null;
    control.retryNode(reviewNodeId);
    return count + 1;
  }).immediate();
  if (attempt === null) { refuse('Another hand-back counted against this task first, so this one was not taken.'); return; }
  recordHandBack(docketId, target.id, {
    sent: true, attempt,
    sentence: `Handed back automatically (${attempt} of ${HANDBACK_LIMIT}): the reviewer requested changes, so the implementation task was reopened`
      + (attempt >= HANDBACK_LIMIT ? '. That was the last automatic hand-back; a later one waits for you.' : '.'),
  });
}

/**
 * The estimate phase, run when whatever it waited on completes. Any docket, not
 * only a relay: the default plan now holds the phase for every goal, and a
 * goal that stalled at a phase nothing runs would be a graph that cannot
 * finish. A failure is recorded as a failed `estimate` proof and the node
 * stays ready for `estimate()`, so the completion that fired this never
 * inherits a forecast's problem.
 */
async function estimateIfReady(docketId: string): Promise<void> {
  const docket = control.docket(docketId);
  const node = docket.nodes.find((candidate) => candidate.kind === 'estimate' && candidate.status === 'ready');
  if (!node) return;
  try {
    await runEstimate(docket, node);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    db().prepare(`INSERT INTO work_proofs (id,docket_id,node_id,kind,status,summary,detail_json,created_at)
      VALUES (?,?,?,'estimate','failed',?,?,?)`)
      .run(uid('proof'), docketId, node.id,
        `The estimate phase did not run: ${reason} It stays ready; run it from the Relay view, or complete it by hand.`,
        JSON.stringify({ reason }), now());
  }
}

async function afterCompletion(event: control.CompletionEvent): Promise<void> {
  if (event.status === 'completed') await estimateIfReady(event.docketId);
  if (event.relay && event.kind === 'review' && event.decision === 'request_changes') handBack(event.docketId, event.nodeId);
}

// Registered when the module loads, which is when the IPC surface that imports
// it is built. Every completion in the app passes through Control's one seam,
// so this is also how a decision taken from the phone reaches the relay.
control.registerCompletionListener(afterCompletion);
