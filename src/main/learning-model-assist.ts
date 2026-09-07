import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { db } from './db';
import { getSetting, setSetting } from './settings';
import { providerById, refreshProviderPacks, shellPath, type ProviderDef } from './providers';
import { headlessEnv, parseCliOutput, resolveBin } from './headless';
import * as accounts from './accounts';
import type {
  ModelAssistConsent, ModelAssistConsentPreview, ModelAssistMetering,
  ModelAssistRefusal, ModelAssistRouting, ModelAssistStatus,
} from '../shared/types';

/**
 * Model-assisted phrasing for the clusters no template claims.
 *
 * The deterministic pass in learning-service.ts turns a repeated observation
 * into a candidate by matching it against hand-authored templates. A cluster no
 * template matches falls through to `nominate()`, which deliberately refuses to
 * write a claim: it emits a `NEEDS AUTHORING —` marker that promotion rejects,
 * because a sentence assembled out of a repetition counter is not knowledge.
 *
 * This module fills exactly that gap and nothing else. It is the only place in
 * Wanigan that spends money to learn, so all three gates the guardrails require
 * live here and are checked in one place, in order:
 *
 *   consent   — a person accepted this provider/backend by name, after seeing
 *               the argv, the environment destinations and every field of the
 *               payload. Consent is pinned to the profile fingerprint, so a
 *               pack upgrade invalidates it rather than inheriting it.
 *   routing   — the call goes to the backend that produced the signals, on a
 *               declared non-interactive protocol. Never a hardcoded id.
 *   metering  — the harness returns usage numbers Wanigan can record, and the
 *               month's recorded spend is under the configured budget. A
 *               harness that reports nothing is proven unmetered by its own
 *               first run and then refused by name.
 *
 * What is sent is the cluster's structured facets and its two counts. Not a
 * prompt, not a response, not a transcript, not file contents — the same
 * bounded operational shape `learning_signals` is allowed to store, and the
 * same shape `describeFacets()` already renders into the candidate a person
 * reads today. See PAYLOAD_FIELDS, which is both the contract and the consent
 * screen's source of truth.
 *
 * Failure is never louder than the feature is worth: every refusal and every
 * error returns null and the caller falls back to `nominate()`. A build where
 * this module never succeeds behaves exactly like the build before it existed.
 */

/* ── the payload contract ─────────────────────────────────────────────── */

/**
 * Every field that may leave the machine, named once. The consent screen
 * renders this list verbatim, so a field added here without a matching thought
 * about what it discloses will be shown to the person approving the call.
 */
export const PAYLOAD_FIELDS = [
  'signalKind', 'toolName', 'outcome', 'errorClass',
  'command', 'pathPrefix', 'sharedFile', 'observations', 'independentTasks',
] as const;

export type ClusterFacts = {
  signalKind: string;
  toolName: string | null;
  outcome: string | null;
  errorClass: string | null;
  command: string | null;
  pathPrefix: string | null;
  sharedFile: string | null;
  observations: number;
  independentTasks: number;
};

/**
 * No tool is needed to rewrite nine facts into two sentences, so none is
 * allowed. This is a deny list rather than an empty allow list because
 * `--allowedTools` is a pre-approval, not an exclusion: naming nothing there
 * does not stop the agent reaching for Bash. `Task` is on the list for the
 * reason headless.ts gives — a subagent inherits none of these flags.
 */
const NO_TOOLS = [
  'Read', 'Glob', 'Grep', 'NotebookRead',
  'Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
  'Task', 'WebFetch', 'WebSearch',
];

/** A phrasing call that has not answered in this long is not going to. */
const CALL_TIMEOUT_MS = 90_000;
/** Bounds the stored claim; the candidate column truncates at 480 bytes. */
const MAX_TITLE_BYTES = 480;
const MAX_TEXT_CHARS = 1_200;
/** Enough output for two sentences and a JSON wrapper; anything more is wrong. */
const MAX_STDOUT_BYTES = 256 * 1024;

/* ── refusals ─────────────────────────────────────────────────────────── */

// The public shapes live in shared/types.ts so the renderer reads the same
// definitions the main process writes; re-exported here because this module is
// where they are produced.
export type {
  ModelAssistConsent, ModelAssistConsentPreview, ModelAssistMetering,
  ModelAssistRefusal, ModelAssistRouting, ModelAssistStatus,
} from '../shared/types';

/* ── stored intent and consent ────────────────────────────────────────── */

const SWITCH_KEY = 'learning_model_assistance';
const CONSENT_KEY = 'learning_model_assist_consent';

type ConsentRecord = ModelAssistConsent;

/** The operator's stored intent, which is not the same as the effective state. */
export function switchedOn(): boolean {
  return getSetting(SWITCH_KEY, '0') === '1';
}

export function readConsent(): ConsentRecord | null {
  try {
    const parsed = JSON.parse(getSetting(CONSENT_KEY, 'null')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const row = parsed as Record<string, unknown>;
    const providerId = typeof row.providerId === 'string' ? row.providerId : '';
    const fingerprint = typeof row.fingerprint === 'string' ? row.fingerprint : '';
    if (!providerId || !fingerprint) return null;
    return {
      providerId,
      backendId: typeof row.backendId === 'string' ? row.backendId : null,
      fingerprint,
      acceptedAt: typeof row.acceptedAt === 'number' ? row.acceptedAt : 0,
      model: typeof row.model === 'string' && row.model.trim() ? row.model.trim() : null,
    };
  } catch {
    return null;
  }
}

/**
 * What a person is agreeing to, assembled from the definition rather than
 * described in prose, so the screen cannot drift from what actually runs.
 * Mirrors the provider-pack consent rule: show every argv entry and every
 * environment destination, with credential values redacted.
 */
type ConsentPreview = ModelAssistConsentPreview;

export function consentPreview(providerId: string, model?: string | null): ConsentPreview | null {
  refreshProviderPacks();
  const def = providerById(providerId);
  if (!def) return null;
  const protocol = String(def.headless ?? 'none');
  if (protocol === 'none') return null;
  const metering = meteringVerdict(providerId);
  // An unsupported model is dropped rather than shown in an argv that would not
  // carry it: the preview must be the command that runs.
  const chosenModel = def.supports.model && typeof model === 'string' && model.trim()
    ? model.trim() : null;
  return {
    providerId: def.id,
    backendId: def.backendId ?? null,
    label: def.label,
    protocol,
    fingerprint: def.profileFingerprint,
    argv: [def.bin, ...previewArgv(def, chosenModel)],
    supportsModel: def.supports.model === true,
    model: chosenModel,
    envDestinations: [
      ...Object.keys(def.env?.() ?? {}),
      ...Object.keys(accounts.launchEnv(accounts.resolve({
        harness: def.harness, projectId: null, appliesToAnthropic: undefined,
      }).account)),
    ].filter((name, index, all) => all.indexOf(name) === index).sort(),
    payloadFields: PAYLOAD_FIELDS,
    deniedTools: NO_TOOLS,
    metering,
    probeRequired: metering === 'unproven',
  };
}

/** Consent is pinned to the fingerprint so a pack upgrade re-asks. */
export function acceptConsent(providerId: string, model?: string | null): ConsentRecord {
  refreshProviderPacks();
  const def = providerById(providerId);
  if (!def) throw new Error(`Unknown provider: ${providerId}`);
  if (String(def.headless ?? 'none') === 'none') {
    throw new Error(`${def.label} declares no non-interactive protocol, so it cannot phrase a candidate.`);
  }
  const record: ConsentRecord = {
    providerId: def.id,
    backendId: def.backendId ?? null,
    fingerprint: def.profileFingerprint,
    acceptedAt: Date.now(),
    model: def.supports.model && typeof model === 'string' && model.trim() ? model.trim() : null,
  };
  setSetting(CONSENT_KEY, JSON.stringify(record));
  return record;
}

/** Withdrawing consent also switches the feature off; it cannot outlive it. */
export function withdrawConsent(): void {
  setSetting(CONSENT_KEY, 'null');
  setSetting(SWITCH_KEY, '0');
}

/* ── metering ─────────────────────────────────────────────────────────── */

type MeteringVerdict = ModelAssistMetering;

/**
 * A harness is metered when it has ever returned a usage figure Wanigan could
 * record, unmetered once it has run and never returned one, and unproven before
 * its first run. The distinction is drawn from recorded runs rather than from a
 * table of provider names, because the fact being asserted — "this reported a
 * cost" — is only knowable by having asked.
 */
export function meteringVerdict(providerId: string): MeteringVerdict {
  const row = db().prepare(`
    SELECT COUNT(*) AS runs, COALESCE(SUM(cost_reported), 0) AS priced
    FROM learning_model_runs WHERE provider_id=? AND status='ok'
  `).get(providerId) as { runs: number; priced: number } | undefined;
  if (!row || row.runs === 0) return 'unproven';
  return row.priced > 0 ? 'metered' : 'unmetered';
}

function startOfMonth(at = Date.now()): number {
  const d = new Date(at);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

/** Recorded spend only. A run the harness did not price contributes nothing. */
export function monthToDateUsd(): number {
  const row = db().prepare(`
    SELECT COALESCE(SUM(cost_usd), 0) AS usd
    FROM learning_model_runs WHERE at >= ? AND cost_reported=1
  `).get(startOfMonth()) as { usd: number } | undefined;
  return row?.usd ?? 0;
}

function recordRun(input: {
  providerId: string; backendId: string | null; clusterKey: string | null;
  status: 'ok' | 'failed' | 'refused'; costUsd: number | null;
  inTokens: number; outTokens: number; durationMs: number; error: string | null;
}): void {
  try {
    db().prepare(`
      INSERT INTO learning_model_runs
        (id, at, provider_id, backend_id, cluster_key, status, cost_usd, cost_reported,
         in_tokens, out_tokens, duration_ms, error)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      randomUUID(), Date.now(), input.providerId, input.backendId, input.clusterKey,
      input.status, input.costUsd ?? 0, input.costUsd === null ? 0 : 1,
      input.inTokens, input.outTokens, input.durationMs, input.error,
    );
  } catch (error) {
    // The ledger failing must not also lose the phrasing, but an unrecorded
    // spend is exactly what the budget gate depends on, so it is loud.
    console.warn('[wanigan] learning model run not recorded:', error);
  }
}

/* ── routing ──────────────────────────────────────────────────────────── */

/**
 * Decides whether one cluster may be phrased, and by whom. Pure: it spends
 * nothing and writes nothing, so a caller may ask per cluster.
 *
 * `budgetUsd` is passed in rather than read here because the setting lives on
 * the learning settings record this module deliberately does not import.
 */
export function assessRouting(
  providerId: string | null,
  backendId: string | null,
  budgetUsd: number,
  opts: { ignoreSwitch?: boolean } = {},
): ModelAssistRouting {
  // `ignoreSwitch` is for the moment the switch is being turned on: the checks
  // below have to run before the setting is written, or the refusal would
  // report the switch itself as the blocker rather than the real one.
  if (!opts.ignoreSwitch && !switchedOn()) {
    return { ok: false, reason: 'switched-off', detail: 'Model-assisted phrasing is off.' };
  }
  // A cluster is keyed on provider and backend, so every signal in it shares
  // both. One that carries neither cannot be routed to "the backend that first
  // processed it", and guessing a destination for it is the exact thing the
  // cross-backend rule forbids.
  if (!providerId) {
    return {
      ok: false, reason: 'no-attribution',
      detail: 'These observations carry no provider attribution, so there is no backend to route them back to.',
    };
  }
  const consent = readConsent();
  if (!consent) {
    return { ok: false, reason: 'not-consented', detail: 'No provider has been approved for model-assisted phrasing.' };
  }
  if (consent.providerId !== providerId) {
    return {
      ok: false, reason: 'not-consented',
      detail: `Observations from ${providerId} cannot be phrased by the approved ${consent.providerId} profile: `
        + 'content stays inside the backend that produced it.',
    };
  }

  refreshProviderPacks();
  const def = providerById(providerId);
  if (!def) {
    return { ok: false, reason: 'unknown-provider', detail: `${providerId} is not installed or is disabled.` };
  }
  if (def.profileFingerprint !== consent.fingerprint) {
    return {
      ok: false, reason: 'profile-changed',
      detail: `${def.label} has changed since it was approved. Review and approve it again.`,
    };
  }
  // Belt and braces over the consent check above: the cluster's own backend has
  // to be the one being dialled, even if a pack were to reuse a provider id.
  if (backendId && def.backendId && backendId !== def.backendId) {
    return {
      ok: false, reason: 'not-consented',
      detail: `These observations were processed by the ${backendId} backend, not ${def.backendId}.`,
    };
  }
  const protocol = String(def.headless ?? 'none');
  if (protocol === 'none') {
    return {
      ok: false, reason: 'no-headless-protocol',
      detail: `${def.label} declares no non-interactive protocol.`,
    };
  }

  // Metering, last, because it is the gate that costs something to answer.
  const metering = meteringVerdict(providerId);
  if (metering === 'unmetered') {
    return {
      ok: false, reason: 'unmetered-harness',
      detail: `${def.label} returns no usage figures, so its spend cannot be recorded. `
        + 'Model-assisted phrasing stays off for it.',
    };
  }
  if (!(budgetUsd > 0)) {
    return {
      ok: false, reason: 'no-budget-set',
      detail: 'Set a monthly learning budget before Wanigan spends anything to phrase a candidate.',
    };
  }
  const spent = monthToDateUsd();
  if (spent >= budgetUsd) {
    return {
      ok: false, reason: 'budget-exhausted',
      detail: `This month's recorded learning spend ($${spent.toFixed(2)}) has reached the $${budgetUsd.toFixed(2)} budget.`,
    };
  }

  return {
    ok: true,
    providerId: def.id,
    backendId: def.backendId ?? null,
    label: def.label,
    protocol,
    fingerprint: def.profileFingerprint,
    metering,
  };
}

/* ── the call ─────────────────────────────────────────────────────────── */

const PROMPT_HEADER =
  'You are naming a pattern an engineering tool observed while running coding agents. '
  + 'You are given only structured counters and identifiers — no code, no transcript. '
  + 'Write what the repetition most likely means, as a claim an engineer could act on.\n\n'
  + 'Reply with one JSON object and nothing else: {"title": "...", "text": "..."}\n'
  + '- title: under 80 characters, specific, no trailing punctuation.\n'
  + '- text: two sentences at most. State the pattern and what to do about it.\n'
  + '- If the counters do not support a claim, reply {"title": null, "text": null}.\n'
  + '- Never invent a file, tool, command or error you were not given.\n\n'
  + 'Observed facts:\n';

function promptFor(facts: ClusterFacts): string {
  const lines = PAYLOAD_FIELDS.map((field) => {
    const value = facts[field];
    return value === null || value === '' ? null : `- ${field}: ${String(value)}`;
  }).filter(Boolean);
  return PROMPT_HEADER + lines.join('\n') + '\n';
}

/**
 * The argv shown on the consent screen. Identical to the real one but with the
 * prompt body replaced, because the prompt is per cluster and the approval is
 * per profile — showing one cluster's text would misrepresent what was agreed.
 */
function previewArgv(def: ProviderDef, model: string | null): string[] {
  return buildArgv(def, '<the observed facts listed below>', model);
}

/**
 * Routed by declared protocol, exactly as headlessArgs does, and refusing the
 * same way for anything undeclared. Deliberately not headlessArgs itself: that
 * builds a *run* — worktree, hooks, gates, budget flag — and a phrasing call is
 * none of those things. It gets no repository and no tools.
 */
function buildArgv(def: ProviderDef, prompt: string, model: string | null): string[] {
  const protocol = String(def.headless ?? 'none');
  // The model flag is spelled by the definition, never by this module: a pack
  // that names it differently still gets the right argv, and one that takes no
  // model at all gets nothing added.
  const chosen = def.supports.model && model ? def.launchArgs([], { model }) : [];
  if (protocol === 'claude-json') {
    return [
      '-p', prompt,
      '--output-format', 'json',
      '--disallowedTools', NO_TOOLS.join(','),
      ...chosen,
    ];
  }
  if (protocol === 'codex-json') {
    return ['exec', '--json', ...chosen, prompt];
  }
  throw new Error(`${def.label} does not provide a trusted non-interactive protocol.`);
}

export type PhraseInput = {
  providerId: string | null;
  backendId: string | null;
  clusterKey: string | null;
  facts: ClusterFacts;
  budgetUsd: number;
};

export type PhraseResult = { title: string; text: string; providerId: string; label: string };

/** One completed invocation, whatever it produced. Shared by phrasing and probe. */
type Invocation = {
  bin: string;
  argv: string[];
  durationMs: number;
  /** Non-null when the call never completed: spawn, permissions, or timeout. */
  failure: string | null;
  reportedCostUsd: number | null;
  inTokens: number;
  outTokens: number;
  harnessError: boolean;
  replyBytes: number;
  claim: { title: string; text: string } | null;
};

/**
 * Runs one phrasing call and records it, whatever the outcome. Every exit
 * writes exactly one ledger row, because the metering verdict is read from
 * those rows: a call that happened and was not recorded would let an unmetered
 * harness stay unproven forever.
 */
async function invoke(
  routing: Extract<ModelAssistRouting, { ok: true }>,
  facts: ClusterFacts,
  clusterKey: string | null,
  /** The approved model, threaded from the consent assessRouting validated. */
  model: string | null,
): Promise<Invocation> {
  const startedAt = Date.now();
  const blank: Omit<Invocation, 'bin' | 'argv' | 'durationMs' | 'failure'> = {
    reportedCostUsd: null, inTokens: 0, outTokens: 0,
    harnessError: false, replyBytes: 0, claim: null,
  };
  const def = providerById(routing.providerId);
  if (!def) {
    return { bin: '', argv: [], durationMs: 0, failure: 'The profile disappeared before the call.', ...blank };
  }

  let bin = '';
  let argv: string[] = [];
  let env: NodeJS.ProcessEnv;
  let scratch: string;
  const fail = (message: string): Invocation => {
    recordRun({
      providerId: routing.providerId, backendId: routing.backendId, clusterKey,
      status: 'failed', costUsd: null, inTokens: 0, outTokens: 0,
      durationMs: Date.now() - startedAt, error: message,
    });
    return { bin, argv, durationMs: Date.now() - startedAt, failure: message, ...blank };
  };

  try {
    bin = await resolveBin(def);
    fs.accessSync(bin, fs.constants.X_OK);
    argv = buildArgv(def, promptFor(facts), model);
    const account = accounts.resolve({
      harness: def.harness, projectId: null,
      appliesToAnthropic: accounts.appliesTo(def, false),
    }).account;
    env = headlessEnv(await shellPath(), def.env?.() ?? {}, accounts.launchEnv(account));
    // An empty directory, never a repository. There is nothing here to read,
    // edit or leak, which is a stronger guarantee than a tool clamp alone.
    scratch = path.join(app.getPath('userData'), 'learning-phrasing');
    fs.mkdirSync(scratch, { recursive: true });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }

  let stdout: string;
  try {
    stdout = await run(bin, argv, scratch, env);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }

  const reported = parseCliOutput(stdout);
  const claim = reported.isError ? null : parseClaimReply(reported.message);
  recordRun({
    providerId: routing.providerId,
    backendId: routing.backendId,
    clusterKey,
    // 'ok' means the call completed and could be priced or proven unpriced —
    // that is what meteringVerdict reads. Whether it produced a usable claim is
    // a separate question, recorded in `error`.
    status: reported.isError ? 'failed' : 'ok',
    costUsd: reported.costUsd,
    inTokens: reported.inTokens,
    outTokens: reported.outTokens,
    durationMs: Date.now() - startedAt,
    error: reported.isError ? (reported.message ?? 'The harness reported an error.')
      : claim ? null : 'No usable claim in the reply.',
  });

  // The run that proved a harness unmetered is also the last one it gets: turn
  // the switch off here rather than refusing silently on every later pass, so
  // the settings screen can say which profile stopped it and why.
  if (!reported.isError && reported.costUsd === null && meteringVerdict(routing.providerId) === 'unmetered') {
    setSetting(SWITCH_KEY, '0');
    console.warn(
      `[wanigan] ${routing.label} returned no usage figures; model-assisted phrasing switched off `
      + 'because its spend cannot be recorded.',
    );
  }

  return {
    bin, argv, durationMs: Date.now() - startedAt, failure: null,
    reportedCostUsd: reported.costUsd,
    inTokens: reported.inTokens,
    outTokens: reported.outTokens,
    harnessError: reported.isError,
    replyBytes: Buffer.byteLength(stdout, 'utf8'),
    claim,
  };
}

/**
 * Returns a phrased claim, or null for every refusal and every failure. The
 * caller falls back to a nomination, which is what it would have written
 * anyway, so nothing here needs to throw.
 */
export async function phraseCluster(input: PhraseInput): Promise<PhraseResult | null> {
  const routing = assessRouting(input.providerId, input.backendId, input.budgetUsd);
  if (!routing.ok) return null;
  const result = await invoke(routing, input.facts, input.clusterKey, readConsent()?.model ?? null);
  return result.claim
    ? { ...result.claim, providerId: routing.providerId, label: routing.label }
    : null;
}

/**
 * One deliberate call against invented facts, so an operator can find out what
 * a profile actually does before any real observation is sent to it — and, more
 * to the point, whether it reports what it spent. This is the call the consent
 * screen promises when it says a harness has not been priced yet.
 *
 * It ignores the on/off switch (the point is to inform that decision) but not
 * consent, routing or the budget: a probe is a real call that really spends.
 * The facts below are fictional on purpose — a probe discloses nothing about
 * this machine's work.
 */
export const PROBE_FACTS: ClusterFacts = {
  signalKind: 'tool-failure',
  toolName: 'ExampleTool',
  outcome: 'denied',
  errorClass: 'permission',
  command: null,
  pathPrefix: 'src/example',
  sharedFile: 'src/example/widget.ts',
  observations: 4,
  independentTasks: 3,
};

export type ProbeReport = {
  ok: boolean;
  providerId: string;
  label: string;
  /** Absent when routing refused before anything ran. */
  invocation: Invocation | null;
  refusal: { reason: ModelAssistRefusal; detail: string } | null;
  meteringBefore: ModelAssistMetering;
  meteringAfter: ModelAssistMetering;
  monthToDateUsd: number;
};

export async function probe(providerId: string, budgetUsd: number): Promise<ProbeReport> {
  const meteringBefore = meteringVerdict(providerId);
  const consent = readConsent();
  const routing = assessRouting(
    providerId,
    consent?.backendId ?? null,
    budgetUsd,
    { ignoreSwitch: true },
  );
  if (!routing.ok) {
    return {
      ok: false, providerId, label: providerId, invocation: null,
      refusal: { reason: routing.reason, detail: routing.detail },
      meteringBefore, meteringAfter: meteringBefore, monthToDateUsd: monthToDateUsd(),
    };
  }
  const invocation = await invoke(routing, PROBE_FACTS, null, consent?.model ?? null);
  return {
    ok: !invocation.failure && !invocation.harnessError,
    providerId: routing.providerId,
    label: routing.label,
    invocation,
    refusal: null,
    meteringBefore,
    meteringAfter: meteringVerdict(routing.providerId),
    monthToDateUsd: monthToDateUsd(),
  };
}

function run(bin: string, argv: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let truncated = false;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      reject(new Error(`No reply within ${CALL_TIMEOUT_MS / 1000}s.`));
    }, CALL_TIMEOUT_MS);
    timer.unref?.();

    child.stdout?.on('data', (chunk: Buffer) => {
      if (truncated) return;
      out += chunk.toString('utf8');
      // A runaway writer must not be allowed to fill memory before the timeout.
      if (Buffer.byteLength(out, 'utf8') > MAX_STDOUT_BYTES) {
        truncated = true;
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }
    });
    // stderr is drained but never read: a CLI that blocks on a full pipe never
    // reaches its own exit, and nothing here should parse a diagnostic stream.
    child.stderr?.on('data', () => { /* drained */ });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(out);
    });
  });
}

/**
 * Accepts a claim only if it is shaped like one. A reply that is prose, that is
 * the model declining, or that smuggles the nomination marker back in, is not a
 * claim — and the caller writing a nomination instead is the correct outcome.
 */
export function parseClaimReply(message: string | null): { title: string; text: string } | null {
  if (!message) return null;
  const body = message.trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(body.slice(start, end + 1)); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const row = parsed as Record<string, unknown>;
  const title = typeof row.title === 'string' ? row.title.trim() : '';
  const text = typeof row.text === 'string' ? row.text.trim() : '';
  if (!title || !text) return null;
  if (Buffer.byteLength(title, 'utf8') > MAX_TITLE_BYTES) return null;
  if (text.length > MAX_TEXT_CHARS) return null;
  // The marker is promotion's refusal signal. A reply containing it would make
  // an authored claim unpromotable, or worse, look like one that was reviewed.
  if (title.includes('NEEDS AUTHORING') || text.includes('NEEDS AUTHORING')) return null;
  return { title, text };
}

/**
 * Whether a phrasing call could be made right now, cheaply enough for the
 * settings accessor to call on every read: `assessRouting` returns on the
 * switch before it touches the provider registry, so the common off case costs
 * one settings lookup.
 */
export function isEffective(budgetUsd: number): boolean {
  const consent = readConsent();
  return assessRouting(consent?.providerId ?? null, consent?.backendId ?? null, budgetUsd).ok;
}

/* ── status for the settings screen ───────────────────────────────────── */

/** Observed mean of priced calls; null before any call has been priced. */
export function averageCostUsd(): number | null {
  const row = db().prepare(`
    SELECT COUNT(*) AS n, COALESCE(SUM(cost_usd), 0) AS usd
    FROM learning_model_runs WHERE cost_reported=1
  `).get() as { n: number; usd: number } | undefined;
  return row && row.n > 0 ? row.usd / row.n : null;
}

export function status(budgetUsd: number): ModelAssistStatus {
  const consent = readConsent();
  const routing = assessRouting(consent?.providerId ?? null, consent?.backendId ?? null, budgetUsd);
  const runs = db().prepare(`
    SELECT at, provider_id, status, cost_usd, cost_reported
    FROM learning_model_runs ORDER BY at DESC LIMIT 20
  `).all() as { at: number; provider_id: string; status: string; cost_usd: number; cost_reported: number }[];
  return {
    switchedOn: switchedOn(),
    effective: routing.ok,
    consent,
    routing,
    monthToDateUsd: monthToDateUsd(),
    averageCostUsd: averageCostUsd(),
    runs: runs.map((row) => ({
      at: row.at,
      providerId: row.provider_id,
      status: row.status,
      costUsd: row.cost_usd,
      costReported: row.cost_reported === 1,
    })),
  };
}
