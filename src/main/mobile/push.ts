import { mobileConfig, normaliseHttpsUrl } from './config';
import { mobileCredentialsReady, secretsIssue } from './secrets';
import { safeString } from './snapshot';

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

function rememberPush(result: MobilePushResult): MobilePushResult {
  pushResult = result;
  return { ...result };
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
    if (!mobileCredentialsReady()) {
      return rememberPush({
        at,
        ok: false,
        skipped: false,
        retryable: true,
        httpStatus: null,
        error: secretsIssue() ?? 'Encrypted phone-monitor credentials are unavailable.',
      });
    }
    if (!config.pushServer) {
      return rememberPush({
        at, ok: false, skipped: false, retryable: false, httpStatus: null,
        error: 'Mobile push is enabled but no HTTPS ntfy server is configured.',
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
