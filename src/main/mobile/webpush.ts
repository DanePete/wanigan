import type http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { json, registerApiRoute, requestJson } from './dispatch';
import { boolSetting, KEY } from './config';
import {
  MAX_PUSH_DEVICES,
  ensureVapidKeys,
  mobileCredentialsReady,
  pushDevices,
  pushEndpointValid,
  rotateVapidKeys,
  savePushDevices,
  secretsIssue,
} from './secrets';
import type { MobilePushDevice } from './secrets';
import { configureWebPushProbe, safeString } from './snapshot';
import { MAX_PLAINTEXT_BYTES, encryptPushPayload, vapidAuthorization } from './webpush-crypto';
// Type only, so this module still sits beside ./push rather than on top of it.
// The two sinks share a result shape because ./alerts merges them, and two
// identical shapes maintained separately is how one of them grows a field the
// merge silently ignores.
import type { MobilePushInput, MobilePushResult } from './push';

/**
 * Notifications delivered to the installed Wanigan Remote app itself.
 *
 * The ntfy sink beside this one publishes a plaintext alert to a topic on a
 * server the operator chose, and anyone who learns that topic receives every
 * alert. This one is the opposite arrangement: the payload is encrypted to a
 * key that exists only inside one device's browser, and the push service that
 * carries it — Apple's, for an iPhone or iPad — is handed ciphertext it has no
 * way to read. What it does learn is real and worth naming: an endpoint that
 * identifies a device, and the times Wanigan sends to it.
 *
 * Three properties of the delivery path are worth holding on to, because each
 * one shaped the code below:
 *
 * A subscription is a capability. Endpoint plus `p256dh` plus `auth` is
 * everything needed to put a notification on someone's lock screen, so it lives
 * in the OS-encrypted credential file with the pairing token and never crosses
 * back to any device, not even the one it came from.
 *
 * A subscription is bound to the VAPID key it was made with. Rotating that key
 * does not revoke devices politely; it makes every one of them permanently
 * undeliverable. `rotateVapidKeys` therefore clears the list in the same write,
 * because a Settings panel listing devices that can never be reached again is
 * worse than one listing none.
 *
 * Only the push service knows a subscription has died. A phone that was reset,
 * or an app that was deleted, tells Wanigan nothing — the 404 or 410 on the
 * next publish is the only notice there will ever be, which is why those two
 * codes prune the row rather than being recorded as a failure to retry.
 */

export const WEB_PUSH_TIMEOUT_MS = 8_000;

/**
 * How long a push service should hold an undelivered alert for.
 *
 * Short on purpose, and shorter for the urgent kind. "An agent is waiting for
 * approval" stops being a thing to act on and becomes a thing to be confused by
 * once it is hours old — by then either somebody answered it or the session has
 * been sitting idle long enough that a lock-screen banner is the wrong way to
 * find out. An expired alert is dropped by the service and never shown.
 */
const TTL_URGENT_SECONDS = 60 * 60;
const TTL_NORMAL_SECONDS = 30 * 60;

/**
 * The VAPID `sub` claim: a contact for the push service, required by Apple.
 *
 * Wanigan's own project URL rather than the operator's email address, which is
 * the other thing the spec permits. Nobody reads this field in practice, and
 * putting a real person's address on every notification sent to a third party
 * to satisfy it is not a trade this app makes on its user's behalf.
 */
const VAPID_SUBJECT = 'https://wanigan.deadnorth.io';

/** Room for the JSON envelope around the title and body, inside one record. */
const MAX_TITLE = 200;
const MAX_BODY = 1_200;

let pushResult: MobilePushResult | null = null;

/** Same redaction the ntfy sink applies: no absolute path leaves this machine. */
function pushText(value: unknown, max: number): string {
  return safeString(value, max)
    .replace(/(^|\s)(?:~\/|\/(?!\/))[^\s]+/g, '$1[local path]')
    .replace(/(^|\s)[A-Za-z]:\\[^\s]+/g, '$1[local path]');
}

/**
 * Strip anything that identifies a device from a message that will be shown.
 *
 * A push service's error body is text a remote server chose, and it is retained
 * here and then displayed in Settings. Endpoints are the credential in this
 * design, so an error that echoes one back must not survive being written down.
 */
function withoutEndpoints(value: string | null): string | null {
  if (!value) return null;
  const stripped = value.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[endpoint]');
  return safeString(stripped, 300) || null;
}

/** Whether the operator has switched this channel on. Defaults to on. */
export function webPushEnabled(): boolean {
  return boolSetting(KEY.webPushEnabled, true);
}

/**
 * Why a publish cannot be attempted, or null when it can.
 *
 * Read by both the send path and the state Settings and the phone are shown,
 * for the reason the ntfy sink gives at the same function: a second copy of
 * these preconditions could call the channel healthy while every send fails,
 * and the panel that exists to catch a silent failure would have become one.
 */
function pushBlock(): { reason: string; retryable: boolean } | null {
  if (!mobileCredentialsReady()) {
    return {
      reason: secretsIssue() ?? 'Encrypted phone-monitor credentials are unavailable.',
      retryable: true,
    };
  }
  if (pushDevices().length === 0) {
    return {
      // Named as the action rather than the state: this is the one blocked
      // reason whose fix is on the phone, and an operator reading it in Settings
      // on the Mac cannot do anything about it there.
      reason: 'No device is subscribed. Open Wanigan Remote on the phone or iPad, go to Device, and turn on alerts to that device.',
      retryable: false,
    };
  }
  return null;
}

export type MobileWebPushProbe = {
  enabled: boolean;
  ready: boolean;
  blocked: string | null;
  deviceCount: number;
  last: MobilePushResult | null;
};

export function webPushProbe(): MobileWebPushProbe {
  const enabled = webPushEnabled();
  const blocked = enabled
    ? pushBlock()
    : { reason: 'Alerts to the Wanigan app are switched off in Settings → Phone monitor.', retryable: false };
  return {
    enabled,
    ready: blocked === null,
    blocked: blocked?.reason ?? null,
    deviceCount: pushDevices().length,
    last: lastWebPushResult(),
  };
}

export function lastWebPushResult(): MobilePushResult | null {
  return pushResult ? { ...pushResult } : null;
}

function remember(result: MobilePushResult): MobilePushResult {
  pushResult = { ...result, error: withoutEndpoints(result.error) };
  return { ...pushResult };
}

/* ── the devices ─────────────────────────────────────────────────────── */

/**
 * What Settings and the phone may be told about a subscribed device.
 *
 * Rebuilt field by field rather than filtered, on the same principle as the
 * fleet snapshot: the endpoint and the two keys are the capability, and a view
 * assembled by omission is one property rename away from carrying them.
 */
export type MobilePushDeviceView = {
  id: string;
  label: string;
  createdAt: number;
  lastAt: number | null;
  lastOk: boolean | null;
  lastError: string | null;
};

export function listPushDevices(): MobilePushDeviceView[] {
  return pushDevices().map((device) => ({
    id: device.id,
    label: device.label,
    createdAt: device.createdAt,
    lastAt: device.lastAt,
    lastOk: device.lastOk,
    lastError: withoutEndpoints(device.lastError),
  }));
}

/**
 * The distinct push-service hosts Wanigan would actually POST to right now.
 *
 * Hosts, never endpoints. The egress panel exists to name what leaves this
 * machine, and the host is the whole of that answer — the rest of an endpoint
 * is the capability to notify one specific device, which has no business on a
 * screen. It is read from the stored subscriptions rather than hard-coded
 * because the destination is chosen by each device's browser: Safari says
 * web.push.apple.com, Firefox says something else, and a list typed into this
 * file would be a privacy claim that had quietly stopped being true.
 */
export function pushEndpointHosts(): string[] {
  const hosts = new Set<string>();
  for (const device of pushDevices()) {
    try { hosts.add(new URL(device.endpoint).hostname); }
    catch { /* stored endpoints are validated on the way in; a bad one is simply not named */ }
  }
  return [...hosts].sort();
}

/** Forget one device by Wanigan's own id. Its browser keeps a dead subscription. */
export function forgetPushDevice(id: string): MobilePushDeviceView[] {
  savePushDevices(pushDevices().filter((device) => device.id !== id));
  return listPushDevices();
}

/** Forget every device without touching the key, so each can simply re-subscribe. */
export function forgetAllPushDevices(): MobilePushDeviceView[] {
  savePushDevices([]);
  return listPushDevices();
}

/** New keypair, no devices. Every phone must subscribe again. */
export function rotatePushKeys(): MobilePushDeviceView[] {
  rotateVapidKeys();
  pushResult = null;
  return listPushDevices();
}

/** The public half devices subscribe against, generated on first use. */
export function pushPublicKey(): string {
  return ensureVapidKeys().publicKey;
}

/**
 * Record a device's subscription, replacing any row with the same endpoint.
 *
 * Replacing rather than rejecting is what makes the phone's re-registration on
 * every launch safe to run: a browser that still holds a valid subscription
 * re-asserts it, and a Mac that lost the row for any reason gets it back
 * without the operator being asked to notice.
 */
export function rememberPushDevice(input: {
  endpoint: string;
  p256dh: string;
  auth: string;
  label: string;
  /** The device's own stable id, when its browser sent one. */
  clientId?: string;
}): MobilePushDeviceView[] {
  const existing = pushDevices();
  // Matched on the device before its address. Safari rotates a Home Screen
  // app's endpoint by itself, so an endpoint is where a device can be reached
  // today rather than which device it is — matching on it alone turned one
  // iPhone into a new row every week or two, each one dead, until they filled
  // the list and started evicting the operator's other devices.
  const clientId = safeString(input.clientId, 64) || undefined;
  const previous = (clientId ? existing.find((device) => device.clientId === clientId) : undefined)
    ?? existing.find((device) => device.endpoint === input.endpoint);
  const device: MobilePushDevice = {
    id: previous?.id ?? randomBytes(9).toString('base64url'),
    ...(clientId ? { clientId } : previous?.clientId ? { clientId: previous.clientId } : {}),
    label: safeString(input.label, 60) || 'Paired device',
    endpoint: input.endpoint,
    p256dh: input.p256dh,
    auth: input.auth,
    createdAt: previous?.createdAt ?? Date.now(),
    lastAt: previous?.lastAt ?? null,
    lastOk: previous?.lastOk ?? null,
    lastError: previous?.lastError ?? null,
  };
  // Oldest out when a ninth device arrives. Appending the new row last is what
  // makes the cap drop the least recently added rather than the newest one.
  const kept = existing.filter((row) => row.id !== device.id
    && row.endpoint !== input.endpoint
    && !(clientId !== undefined && row.clientId === clientId));
  savePushDevices([...kept, device].slice(-MAX_PUSH_DEVICES));
  return listPushDevices();
}

/* ── sending ─────────────────────────────────────────────────────────── */

type DeliveryOutcome = {
  ok: boolean;
  /** The row is gone at the service and must be dropped, not retried. */
  expired: boolean;
  retryable: boolean;
  httpStatus: number | null;
  error: string | null;
  /** Seconds the push service asked to be left alone for, from Retry-After. */
  retryAfterSeconds: number | null;
};

/**
 * RFC 8030's Topic header: at most 32 characters from the base64url alphabet.
 *
 * A push message with a topic *replaces* any undelivered message the service is
 * already holding with the same one. That is a different collapse from the tag
 * inside the payload, which only merges banners once they have arrived: a phone
 * that has been off for an hour comes back to one alert about a session rather
 * than five queued behind each other.
 *
 * Hashed rather than sent through, for two reasons. The tag is a session id and
 * a state, which is neither short enough nor in the right alphabet — and it
 * would put an internal identifier in a plaintext header, where the payload
 * encryption this whole path is built on cannot reach it.
 */
function pushTopic(tag: string): string {
  return createHash('sha256').update(tag).digest('base64url').slice(0, 32);
}

/** Retry-After is seconds, or an HTTP date. Both are permitted; both are read. */
function retryAfterSeconds(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 86_400);
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.min(86_400, Math.round((at - Date.now()) / 1_000)));
}

async function deliver(device: MobilePushDevice, payload: Buffer, urgent: boolean, tag: string): Promise<DeliveryOutcome> {
  let body: Buffer;
  let authorization: string;
  try {
    body = encryptPushPayload(payload, { p256dh: device.p256dh, auth: device.auth });
    authorization = vapidAuthorization(ensureVapidKeys(), device.endpoint, VAPID_SUBJECT);
  } catch (error) {
    // A subscription whose keys will not encrypt is not a network problem and
    // will not fix itself; say so rather than retrying it every alert forever.
    return {
      ok: false, expired: false, retryable: false, httpStatus: null, retryAfterSeconds: null,
      error: safeString(error instanceof Error ? error.message : String(error), 300, 'This subscription could not be encrypted to.'),
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEB_PUSH_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await fetch(device.endpoint, {
      method: 'POST',
      headers: {
        'content-encoding': 'aes128gcm',
        'content-type': 'application/octet-stream',
        'content-length': String(body.length),
        ttl: String(urgent ? TTL_URGENT_SECONDS : TTL_NORMAL_SECONDS),
        urgency: urgent ? 'high' : 'normal',
        ...(tag ? { topic: pushTopic(tag) } : {}),
        authorization,
      },
      body: new Uint8Array(body),
      signal: controller.signal,
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    });
    // The response body is never read. RFC 8030 puts everything Wanigan acts on
    // in the status line, and a push service's body is bytes from a third party
    // that would only ever be retained and shown.
    if (response.ok) {
      return { ok: true, expired: false, retryable: false, httpStatus: response.status, error: null, retryAfterSeconds: null };
    }
    const expired = response.status === 404 || response.status === 410;
    const after = retryAfterSeconds(response.headers.get('retry-after'));
    return {
      ok: false,
      expired,
      retryable: response.status === 408 || response.status === 429 || response.status >= 500,
      httpStatus: response.status,
      retryAfterSeconds: after,
      error: expired
        ? 'The push service says this subscription no longer exists.'
        : `The push service returned HTTP ${response.status}.`
          // Said out loud rather than silently obeyed. The attention machinery
          // owns the retry cadence, and a wait this path invented on its own
          // would be a second, invisible schedule disagreeing with it.
          + (after !== null ? ` It asked to be left alone for ${after}s.` : ''),
    };
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'AbortError';
    return {
      ok: false,
      expired: false,
      retryable: true,
      httpStatus: null,
      retryAfterSeconds: null,
      error: timedOut
        ? `The push service did not answer within ${Math.round(WEB_PUSH_TIMEOUT_MS / 1_000)} seconds.`
        : safeString(error instanceof Error ? error.message : String(error), 300, 'The push request failed.'),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Publish one alert to every subscribed device.
 *
 * Never rejects, for the reason the ntfy sink gives: this is called from hook
 * handlers and session-exit paths, and notification delivery is commentary on
 * the work rather than the work itself.
 *
 * The aggregate is deliberately optimistic about success and pessimistic about
 * retry. One device that took the alert means the operator was told, so the
 * result is ok; one device that failed recoverably means a retry could still
 * help somebody, so the result is retryable. Reporting the worst outcome as the
 * result would let a phone the operator stopped using suppress the alert that
 * reached the one in their hand.
 */
export async function sendWebPush(input: MobilePushInput, force = false): Promise<MobilePushResult> {
  const at = Date.now();
  try {
    if (!force && !webPushEnabled()) {
      return remember({ at, ok: false, skipped: true, retryable: true, httpStatus: null, error: null });
    }
    const blocked = pushBlock();
    if (blocked) {
      return remember({
        at, ok: false, skipped: false, retryable: blocked.retryable, httpStatus: null, error: blocked.reason,
      });
    }

    const title = pushText(input.title, MAX_TITLE);
    const body = pushText(input.body, MAX_BODY);
    if (!title || !body) {
      return remember({
        at, ok: false, skipped: false, retryable: false, httpStatus: null,
        error: 'A push notification needs both a title and a message.',
      });
    }

    const tag = safeString(input.tag, 120);
    const payload = Buffer.from(JSON.stringify({
      title,
      body,
      urgent: input.urgent === true,
      // Collapses repeats about one session into a single banner rather than a
      // column of them. It is inside the encrypted record, so the push service
      // is not told which session an alert is about.
      tag: tag || undefined,
      view: 'fleet',
    }), 'utf8');
    if (payload.length > MAX_PLAINTEXT_BYTES) {
      return remember({
        at, ok: false, skipped: false, retryable: false, httpStatus: null,
        error: 'The notification was too large to encrypt into one push record.',
      });
    }

    const devices = pushDevices();
    const outcomes = await Promise.all(devices.map((device) => deliver(device, payload, input.urgent === true, tag)));

    // Applied to the list as it is *now*, not to the copy this send started
    // with. A device that subscribed while these requests were in flight — the
    // phone re-registers itself every time the app is opened — would otherwise
    // be erased by a write built from a snapshot taken before it existed, and
    // the operator would be looking at a phone that says it is subscribed and a
    // Mac that has never heard of it.
    const byEndpoint = new Map(devices.map((device, index) => [device.endpoint, outcomes[index]]));
    try {
      savePushDevices(pushDevices().flatMap((device) => {
        const outcome = byEndpoint.get(device.endpoint);
        if (!outcome) return [device];
        if (outcome.expired) return [];
        return [{
          ...device,
          lastAt: at,
          lastOk: outcome.ok,
          lastError: outcome.ok ? null : withoutEndpoints(outcome.error),
        }];
      }));
    } catch {
      // The alert was still delivered. Losing the record of how it went is not
      // worth turning a successful notification into a reported failure.
    }

    const delivered = outcomes.filter((outcome) => outcome.ok).length;
    const pruned = outcomes.filter((outcome) => outcome.expired).length;
    const failed = outcomes.filter((outcome) => !outcome.ok && !outcome.expired);
    if (delivered > 0) {
      return remember({
        at, ok: true, skipped: false, retryable: false,
        httpStatus: outcomes.find((outcome) => outcome.ok)?.httpStatus ?? null,
        error: null,
      });
    }
    return remember({
      at,
      ok: false,
      skipped: false,
      retryable: failed.some((outcome) => outcome.retryable),
      httpStatus: failed[0]?.httpStatus ?? null,
      error: pruned > 0 && failed.length === 0
        ? `${pruned === 1 ? 'The subscribed device' : `All ${pruned} subscribed devices`} no longer exist at the push service, so ${pruned === 1 ? 'it was' : 'they were'} forgotten. Turn alerts on again from the phone.`
        : failed[0]?.error ?? 'No device accepted the notification.',
    });
  } catch (error) {
    return remember({
      at, ok: false, skipped: false, retryable: true, httpStatus: null,
      error: safeString(error instanceof Error ? error.message : String(error), 300, 'The push notification failed.'),
    });
  }
}

/** A recognisable, non-urgent notification, sent from Settings. */
export function testWebPush(): Promise<MobilePushResult> {
  return sendWebPush({
    title: 'Wanigan test alert',
    body: 'Alerts to this device are working. Wanigan sends one only when a session needs approval, stops on an error, or finishes a turn.',
    urgent: false,
    tag: 'wanigan-test',
  }, true);
}

/* ── routes ──────────────────────────────────────────────────────────── */

/**
 * Monitor scope, and authenticated like everything else on this listener.
 *
 * Subscribing is not a second door into the fleet: a device that cannot already
 * read the fleet cannot ask to be told about it. That is why these three routes
 * are ordinary authenticated routes rather than anything resembling /api/pair,
 * which is unauthenticated precisely because it is what hands the token out.
 */
function serveKey(res: http.ServerResponse): void {
  try {
    json(res, 200, {
      key: pushPublicKey(),
      enabled: webPushEnabled(),
      devices: pushDevices().length,
      max: MAX_PUSH_DEVICES,
    });
  } catch (error) {
    json(res, 503, {
      error: safeString(
        error instanceof Error ? error.message : String(error),
        240,
        'Wanigan could not read its push key.',
      ),
    });
  }
}

async function serveSubscribe(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await requestJson(req, 4_096);
  const keys = body?.keys && typeof body.keys === 'object' ? body.keys as Record<string, unknown> : {};
  const endpoint = body?.endpoint;
  const p256dh = keys.p256dh;
  const auth = keys.auth;
  if (!pushEndpointValid(endpoint)) {
    json(res, 400, { error: 'That push endpoint is not an HTTPS URL Wanigan will send to.' });
    return;
  }
  if (typeof p256dh !== 'string' || typeof auth !== 'string') {
    json(res, 400, { error: 'A subscription must carry both of its keys.' });
    return;
  }
  try {
    // Proving the keys encrypt now is what keeps an unusable row out of the
    // store: the alternative is accepting it, reporting the device as
    // subscribed, and failing at 3am on the one alert that mattered.
    encryptPushPayload(Buffer.from('subscription check', 'utf8'), { p256dh, auth });
  } catch (error) {
    json(res, 400, {
      error: safeString(error instanceof Error ? error.message : String(error), 200, 'Those subscription keys are unusable.'),
    });
    return;
  }
  try {
    const devices = rememberPushDevice({
      endpoint,
      p256dh,
      auth,
      label: typeof body?.label === 'string' ? body.label : 'Paired device',
      clientId: typeof body?.clientId === 'string' ? body.clientId : undefined,
    });
    json(res, 200, { ok: true, devices: devices.length, enabled: webPushEnabled() });
  } catch (error) {
    json(res, 503, {
      error: safeString(
        error instanceof Error ? error.message : String(error),
        240,
        'Wanigan could not store this subscription.',
      ),
    });
  }
}

async function serveForget(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await requestJson(req, 4_096);
  const endpoint = body?.endpoint;
  if (!pushEndpointValid(endpoint)) {
    json(res, 400, { error: 'That push endpoint is not one Wanigan recognises.' });
    return;
  }
  try {
    const remaining = pushDevices().filter((device) => device.endpoint !== endpoint);
    savePushDevices(remaining);
    json(res, 200, { ok: true, devices: remaining.length });
  } catch (error) {
    json(res, 503, {
      error: safeString(
        error instanceof Error ? error.message : String(error),
        240,
        'Wanigan could not forget this subscription.',
      ),
    });
  }
}

registerApiRoute({ path: '/api/push/key', method: 'GET', scope: 'monitor', handler: (_req, res) => serveKey(res) });
// Housekeeping rather than action: the page re-registers this device on every
// launch, and charging that to the twenty-a-minute remote-action budget meant a
// device could spend its own ability to interrupt a run on saying hello.
registerApiRoute({ path: '/api/push/subscribe', method: 'POST', scope: 'monitor', budget: 'housekeeping', handler: serveSubscribe });
registerApiRoute({ path: '/api/push/forget', method: 'POST', scope: 'monitor', budget: 'housekeeping', handler: serveForget });

// Handed up rather than imported back, the way ./push does it: this module
// already takes its string sanitiser from ./snapshot, and importing the payload
// builder back would make the pair a cycle.
configureWebPushProbe(webPushProbe);
