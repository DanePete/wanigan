import type http from 'node:http';
import { theme } from '../settings';
import { controlScopeAllowed, json, registerApiRoute, send } from './dispatch';
import type { MobileFleetSession, MobileFleetSnapshot } from '../../shared/types';
import type { MobilePushProbe } from './push';
import type { MobileWebPushProbe } from './webpush';

/**
 * The privacy boundary. /api/status is the only route that carries fleet
 * state, and the response is rebuilt field by field from an allow-list so an
 * accidental extra property on a structurally compatible source object — a
 * path, a pid, a transcript — cannot cross the HTTP boundary.
 *
 * The same rebuild applies to the alert state added below: the phone is told
 * whether the outbound channel works, never the ntfy topic or server URL that
 * make it work.
 *
 * The value sanitisers below are shared with the other mobile modules: every
 * string that leaves this process for a phone goes through safeString.
 */

const MAX_SESSIONS = 250;
const MAX_JSON_BYTES = 512 * 1024;
const SNAPSHOT_TIMEOUT_MS = 3_000;

const ATTENTION = new Set(['permission', 'error', 'finished', 'idle', 'working']);
const SESSION_STATUS = new Set(['starting', 'running', 'exited']);

type SnapshotSource = () => MobileFleetSnapshot | Promise<MobileFleetSnapshot>;
let snapshotSource: SnapshotSource | null = null;

type PushProbeSource = () => MobilePushProbe;
let pushProbeSource: PushProbeSource | null = null;

type WebPushProbeSource = () => MobileWebPushProbe;
let webPushProbeSource: WebPushProbeSource | null = null;

/** Register the only source of bytes returned by /api/status. */
export function configureSnapshotSource(fn: SnapshotSource | null): void {
  snapshotSource = fn;
}

/**
 * Register the outbound alert path's report of itself. ./push calls this at
 * import time rather than this module importing it back, because push already
 * reads its sanitiser from here and the pair would otherwise be a cycle.
 *
 * With nothing registered the phone is told an alert has never been attempted,
 * which is the truth for a build where the push module was never loaded.
 */
export function configureMobilePushProbe(fn: PushProbeSource | null): void {
  pushProbeSource = fn;
}

/**
 * The same, for the Web Push sink.
 *
 * Registered separately rather than composed by whichever module happens to
 * load last. Two sinks reporting through one setter would make the phone's
 * alert state depend on module import order, and the failure that produces —
 * one channel's report silently replacing the other's — looks exactly like a
 * working screen.
 */
export function configureWebPushProbe(fn: WebPushProbeSource | null): void {
  webPushProbeSource = fn;
}

export function safeString(value: unknown, max: number, fallback = ''): string {
  if (typeof value !== 'string') return fallback;
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function finite(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function count(value: unknown): number {
  return Math.max(0, Math.round(finite(value)));
}

function money(value: unknown): number {
  return Math.max(0, finite(value));
}

/**
 * What the phone is told about the channels that are meant to reach it when
 * this page is closed. The point of putting it on the wire at all is that a
 * phone showing a healthy fleet and a phone whose alerts have been failing for
 * two days look identical, and only one of them is safe to walk away from.
 *
 * Nothing here identifies a channel. The ntfy topic is that channel's whole
 * subscription credential — anyone holding it receives every alert — and a Web
 * Push endpoint is the capability to put a banner on one specific device's lock
 * screen. Neither travels, in either direction: the phone that just handed over
 * its own subscription is not handed it back.
 *
 * The top-level fields are the two channels merged, because the question this
 * screen answers is "will anything reach me", not "which pipe carried it". The
 * `webPush` block beside them is the exception, and it is here for one reason:
 * it is the only channel this device can do something about, and the Device
 * screen needs to know whether the Mac would accept a subscription from it
 * before offering a button that asks for notification permission.
 */
export type MobileAlertState = {
  enabled: boolean;
  /** Wanigan would actually attempt a publish; false means it cannot. */
  ready: boolean;
  /** Why it cannot, in one sentence, or null when it can. */
  blocked: string | null;
  lastAt: number | null;
  lastOutcome: 'none' | 'sent' | 'skipped' | 'failed';
  /** A bounded reason for a failure, with any URL removed. */
  lastReason: string | null;
  lastHttpStatus: number | null;
  /** Whether Wanigan will attempt the next alert by itself after a failure. */
  retryable: boolean;
  /** Which of the two channels the operator has switched on at the Mac. */
  channels: { webPush: boolean; ntfy: boolean };
  webPush: {
    enabled: boolean;
    ready: boolean;
    blocked: string | null;
    /**
     * How many devices hold a subscription. A count and not a list: this device
     * learns that it is not alone, never who the others are.
     */
    devices: number;
  };
};

function wireReason(value: string | null | undefined, max: number): string | null {
  // The failure text can begin life as an ntfy response body: text a remote
  // server chose, retained on the machine and now leaving it again. ./push
  // strips its own secrets before keeping it; this boundary independently
  // refuses to hand a phone any URL, because no address of any kind is part of
  // what the page is being told.
  const flat = safeString(value, max);
  return flat ? flat.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[url]') : null;
}

/**
 * Rebuilt field by field like everything else on this route: the probe is a
 * local object, but treating it as trusted enough to spread is exactly how a
 * later field lands on the wire without anyone deciding it should.
 */
function alertState(): MobileAlertState {
  const ntfy = pushProbeSource ? pushProbeSource() : null;
  const web = webPushProbeSource ? webPushProbeSource() : null;

  const ntfyOn = ntfy?.enabled === true;
  const webOn = web?.enabled === true;
  const ready = ntfy?.ready === true || web?.ready === true;

  // The blocked sentence is the one an operator acts on, so when both channels
  // are stuck it names the one they would fix. Web Push first: it is the
  // default channel, its fix is a tap on the device already in their hand, and
  // an ntfy sentence shown to somebody who never configured ntfy sends them to
  // a screen about a service they are not using.
  const blocked = ready ? null : (webOn ? web?.blocked : null) ?? (ntfyOn ? ntfy?.blocked : null)
    ?? web?.blocked ?? ntfy?.blocked ?? null;

  // The more recent of the two attempts, whichever channel made it. A merged
  // "last alert" that always reported one channel would go on saying an alert
  // was sent an hour ago while the other channel failed a minute ago.
  const attempts = [web?.last ?? null, ntfy?.last ?? null].filter((value) => value !== null);
  const last = attempts.reduce<typeof attempts[number] | null>(
    (newest, item) => (newest === null || finite(item!.at) > finite(newest.at) ? item : newest),
    null,
  );
  const outcome: MobileAlertState['lastOutcome'] = !last
    ? 'none'
    : last.ok === true ? 'sent' : last.skipped === true ? 'skipped' : 'failed';
  const status = last?.httpStatus;
  return {
    enabled: ntfyOn || webOn,
    ready,
    blocked: wireReason(blocked, 240),
    lastAt: last ? finite(last.at) || null : null,
    lastOutcome: outcome,
    lastReason: wireReason(last?.error, 240),
    lastHttpStatus: typeof status === 'number' && Number.isFinite(status) ? Math.trunc(status) : null,
    retryable: last?.retryable === true,
    channels: { webPush: webOn, ntfy: ntfyOn },
    webPush: {
      enabled: webOn,
      ready: web?.ready === true,
      blocked: wireReason(web?.blocked, 240),
      devices: count(web?.deviceCount),
    },
  };
}

/**
 * Structural typing permits callers to hold extra properties even when the
 * function says MobileFleetSnapshot. Rebuild the response from an allow-list
 * so those properties never cross the HTTP boundary.
 */
function privacyFilterSnapshot(input: MobileFleetSnapshot): MobileFleetSnapshot {
  const value = input as MobileFleetSnapshot & Record<string, unknown>;
  const rows = Array.isArray(value.sessions) ? value.sessions.slice(0, MAX_SESSIONS) : [];
  const sessions: MobileFleetSession[] = rows.map((raw) => {
    const row = raw as MobileFleetSession & Record<string, unknown>;
    const attention = row.attention as MobileFleetSession['attention'] | undefined;
    const usage = row.usage as MobileFleetSession['usage'] | undefined;
    const kind = ATTENTION.has(attention?.kind ?? '')
      ? attention!.kind
      : 'idle';
    const status = SESSION_STATUS.has(row.status ?? '') ? row.status : 'exited';
    return {
      id: safeString(row.id, 160),
      projectName: safeString(row.projectName, 160, 'Unknown project'),
      title: safeString(row.title, 200, 'Agent session'),
      providerId: safeString(row.providerId, 100, 'unknown'),
      // Rebuilt like every other field rather than passed through: the label is
      // bounded and the id is carried only so two accounts with the same label
      // stay distinguishable. Nothing else about an account crosses.
      account: row.account
        ? { id: row.account.id === null ? null : safeString(row.account.id, 120) || null,
            label: safeString(row.account.label, 120, 'Unknown account') }
        : undefined,
      model: row.model === null ? null : safeString(row.model, 120) || null,
      status,
      createdAt: finite(row.createdAt),
      endedAt: row.endedAt === null ? null : finite(row.endedAt) || null,
      attention: {
        kind,
        label: safeString(attention?.label, 40, kind),
        since: finite(attention?.since),
      },
      usage: {
        costUsd: money(usage?.costUsd),
        costStatus: usage?.costStatus === 'unavailable' ? 'unavailable' : 'reported',
        inTokens: count(usage?.inTokens),
        outTokens: count(usage?.outTokens),
        linesAdded: count(usage?.linesAdded),
        linesRemoved: count(usage?.linesRemoved),
        requests: count(usage?.requests),
        errors: count(usage?.errors),
        lastAt: usage?.lastAt === null ? null : finite(usage?.lastAt) || null,
      },
    };
  });

  const providedTotals = value.totals as MobileFleetSnapshot['totals'] | undefined;
  return {
    generatedAt: finite(value.generatedAt, Date.now()),
    host: safeString(value.host, 160, 'Wanigan'),
    version: safeString(value.version, 80),
    totals: {
      sessions: count(providedTotals?.sessions),
      running: count(providedTotals?.running),
      permission: count(providedTotals?.permission),
      error: count(providedTotals?.error),
      finished: count(providedTotals?.finished),
      idle: count(providedTotals?.idle),
      working: count(providedTotals?.working),
      costUsd: money(providedTotals?.costUsd),
      costUnavailable: providedTotals?.costUnavailable === true,
      inTokens: count(providedTotals?.inTokens),
      outTokens: count(providedTotals?.outTokens),
      linesAdded: count(providedTotals?.linesAdded),
      linesRemoved: count(providedTotals?.linesRemoved),
      requests: count(providedTotals?.requests),
      errors: count(providedTotals?.errors),
    },
    sessions,
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('snapshot timed out')), ms);
    timer.unref?.();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

async function serveStatus(res: http.ServerResponse): Promise<void> {
  const source = snapshotSource;
  if (!source) {
    json(res, 503, { error: 'The mobile snapshot source is not configured.' });
    return;
  }
  try {
    const snapshot = privacyFilterSnapshot(await withTimeout(Promise.resolve().then(source), SNAPSHOT_TIMEOUT_MS));
    // Appearance, the capability flag and the alert state carry no repo/session
    // secret, but keeping them on the same poll lets an already-installed PWA
    // follow a desktop appearance/control change without a manual refresh — and
    // lets the page say, on every reading, whether anything would actually
    // reach the operator once they stop looking at it.
    const body = JSON.stringify({
      ...snapshot,
      appearance: theme(),
      remoteControl: controlScopeAllowed(),
      alerts: alertState(),
    });
    if (Buffer.byteLength(body) > MAX_JSON_BYTES) {
      json(res, 503, { error: 'The mobile fleet snapshot is too large to serve safely.' });
      return;
    }
    send(res, 200, 'application/json; charset=utf-8', body);
  } catch {
    // Source errors can contain local paths or database details. The dashboard
    // needs to know the read failed, not which local byte made it fail.
    json(res, 503, { error: 'Wanigan could not build the mobile fleet snapshot.' });
  }
}

registerApiRoute({
  path: '/api/status',
  method: 'GET',
  scope: 'monitor',
  handler: (_req, res) => serveStatus(res),
});
