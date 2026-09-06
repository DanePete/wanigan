import { mobileConfig, normaliseHttpsUrl } from './config';
import { mobileCredentialsReady, secretsIssue } from './secrets';
import { configureMobilePushProbe, safeString } from './snapshot';
import type { MobileMonitorConfig } from '../../shared/types';

/**
 * One privacy-bounded ntfy publish, and the memory of the last attempt. The
 * dashboard's HTTP surface is not involved: a push leaves the machine for an
 * operator-chosen server, which is why the payload is scrubbed of local paths
 * and never carries the private dashboard URL.
 */

export const MOBILE_PUSH_TIMEOUT_MS = 8_000;

export type MobilePushInput = {
  title: string;
  body: string;
  urgent?: boolean;
};

export type MobilePushResult = {
  at: number;
  ok: boolean;
  skipped: boolean;
  /** Whether a persistent attention state may safely retry this automatically. */
  retryable: boolean;
  httpStatus: number | null;
  error: string | null;
};

/**
 * What the alert path can report about itself: whether it is switched on,
 * whether a publish would actually be attempted, and how the last attempt
 * ended. The phone is shown this, so it carries no topic and no server URL.
 */
export type MobilePushProbe = {
  /** The operator switched phone alerts on. */
  enabled: boolean;
  /** Everything a publish needs is present, so an alert would be attempted. */
  ready: boolean;
  /** Why it would not be attempted, in one sentence, or null when it would. */
  blocked: string | null;
  last: MobilePushResult | null;
};

let pushResult: MobilePushResult | null = null;

function pushText(value: unknown, max: number): string {
  const flat = safeString(value, max);
  // Push payloads leave the machine. Refuse the two common absolute-path
  // shapes even if a caller accidentally hands over an attention detail.
  return flat
    .replace(/(^|\s)(?:~\/|\/(?!\/))[^\s]+/g, '$1[local path]')
    .replace(/(^|\s)[A-Za-z]:\\[^\s]+/g, '$1[local path]');
}

async function responseSnippet(response: Response, limit = 4_096): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let out = '';
  try {
    while (size < limit) {
      const item = await reader.read();
      if (item.done) break;
      const take = item.value.subarray(0, Math.max(0, limit - size));
      size += take.length;
      out += decoder.decode(take, { stream: size < limit });
      if (take.length < item.value.length) break;
    }
  } finally {
    try { await reader.cancel(); } catch { /* response already ended */ }
  }
  return safeString(out, limit);
}

function pushTopicQuietly(): string {
  // Reading the topic decrypts a credential file, which can fail on its own.
  // This runs on the failure path of a function that is contractually not
  // allowed to reject, so a second failure here must not become the one that
  // aborts a hook handler.
  try { return mobileConfig().pushTopic; } catch { return ''; }
}

function withoutSecrets(value: string | null): string | null {
  if (!value) return null;
  // An ntfy failure body is text a remote server chose, and this string is kept
  // and then shown in two places: desktop Settings and, now, the paired phone.
  // A server that echoes the request back would put the topic into a
  // diagnostic, and the topic is the whole subscription credential - anyone
  // holding it receives every alert Wanigan sends. Strip it, and any URL, at
  // the one place a result is retained, so no consumer can leak what it was
  // never given.
  const stripped = value.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[url]');
  const topic = pushTopicQuietly();
  const clean = topic ? stripped.split(topic).join('[topic]') : stripped;
  return safeString(clean, 300) || null;
}

function rememberPush(result: MobilePushResult): MobilePushResult {
  pushResult = { ...result, error: withoutSecrets(result.error) };
  return { ...pushResult };
}

/**
 * Why a publish cannot even be attempted, or null when the path is clear.
 *
 * The send path and the state the phone is shown read this one function on
 * purpose. A second copy of these preconditions could disagree with the first
 * in the one direction that matters - the phone calling the alert path healthy
 * while every send fails on the same missing server - and a screen that exists
 * to catch a silent failure would have become one.
 */
function pushBlock(config: MobileMonitorConfig): { reason: string; retryable: boolean } | null {
  if (!mobileCredentialsReady()) {
    return {
      reason: secretsIssue() ?? 'Encrypted phone-monitor credentials are unavailable.',
      retryable: true,
    };
  }
  if (!config.pushServer) {
    return {
      reason: 'Mobile push is enabled but no HTTPS ntfy server is configured.',
      retryable: false,
    };
  }
  return null;
}

/** The alert path's own report of itself, for the paired phone and for tests. */
export function mobilePushProbe(): MobilePushProbe {
  const config = mobileConfig();
  const blocked = config.pushEnabled
    ? pushBlock(config)
    : { reason: 'Phone alerts are switched off in Wanigan Settings → Phone monitor.', retryable: false };
  return {
    enabled: config.pushEnabled,
    ready: blocked === null,
    blocked: blocked?.reason ?? null,
    last: lastMobilePushResult(),
  };
}

/** Most recent ntfy attempt, including skips; no secret or response body is retained. */
export function lastMobilePushResult(): MobilePushResult | null {
  return pushResult ? { ...pushResult } : null;
}

/**
 * Publish one privacy-bounded notification through ntfy.
 *
 * The function never rejects. Notification delivery is commentary on the work
 * and cannot be allowed to abort a hook handler, poll cycle, or session exit.
 */
export async function sendMobilePush(input: MobilePushInput, force = false): Promise<MobilePushResult> {
  const at = Date.now();
  try {
    const config = mobileConfig();
    if (!force && !config.pushEnabled) {
      return rememberPush({ at, ok: false, skipped: true, retryable: true, httpStatus: null, error: null });
    }
    const blocked = pushBlock(config);
    if (blocked) {
      return rememberPush({
        at, ok: false, skipped: false, retryable: blocked.retryable, httpStatus: null,
        error: blocked.reason,
      });
    }

    const serverUrl = normaliseHttpsUrl(config.pushServer, 'ntfy server');
    const title = pushText(input.title, 200);
    const message = pushText(input.body, 1_200);
    if (!title || !message) {
      return rememberPush({
        at, ok: false, skipped: false, retryable: false, httpStatus: null,
        error: 'A mobile push needs both a title and a message.',
      });
    }

    const payload: Record<string, unknown> = {
      topic: config.pushTopic,
      title,
      message,
      priority: input.urgent ? 5 : 3,
    };
    // Do not attach the private dashboard URL as ntfy's click target. A
    // tailnet hostname is still network-identifying metadata, and the alert
    // needs only enough information to decide whether to open the separately
    // paired dashboard.

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MOBILE_PUSH_TIMEOUT_MS);
    timer.unref?.();
    try {
      const response = await fetch(serverUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
        redirect: 'error',
        referrerPolicy: 'no-referrer',
      });
      if (!response.ok) {
        const detail = await responseSnippet(response);
        return rememberPush({
          at,
          ok: false,
          skipped: false,
          retryable: response.status === 408 || response.status === 425
            || response.status === 429 || response.status >= 500,
          httpStatus: response.status,
          error: safeString(
            `ntfy returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
            500,
          ),
        });
      }
      // Drain a bounded prefix so the connection can be reused without ever
      // retaining ntfy's response payload.
      await responseSnippet(response);
      return rememberPush({
        at, ok: true, skipped: false, retryable: false, httpStatus: response.status, error: null,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'AbortError';
    return rememberPush({
      at,
      ok: false,
      skipped: false,
      retryable: true,
      httpStatus: null,
      error: timedOut
        ? `ntfy did not answer within ${Math.round(MOBILE_PUSH_TIMEOUT_MS / 1_000)} seconds.`
        : safeString(error instanceof Error ? error.message : String(error), 500, 'Mobile push failed.'),
    });
  }
}

/** Send a recognisable, non-urgent notification from Settings. */
export function testMobilePush(): Promise<MobilePushResult> {
  return sendMobilePush({
    title: 'Wanigan mobile test',
    body: 'Notifications are connected. Wanigan will use this channel only when configured to do so.',
    urgent: false,
  }, true);
}

// The phone's status payload is assembled in ./snapshot, which sits below this
// module - push already takes its string sanitiser from there, and importing
// the payload back would make the pair a cycle. Hand the probe up instead, the
// way the route table takes its control gate.
configureMobilePushProbe(mobilePushProbe);
