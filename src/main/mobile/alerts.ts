import { mobilePushProbe, sendMobilePush, testMobilePush } from './push';
import { sendWebPush, testWebPush, webPushProbe } from './webpush';
import type { MobilePushInput, MobilePushProbe, MobilePushResult } from './push';
import type { MobileWebPushProbe } from './webpush';
import type { MobileAlertChannels, MobileAlertTest } from '../../shared/types';

/**
 * The one call that reaches a phone, and the rule for what two channels
 * disagreeing means.
 *
 * There are two sinks with different shapes. Web Push reaches the installed
 * Wanigan Remote app on a device that has explicitly subscribed, and is the one
 * an operator normally uses. ntfy reaches anything that can subscribe to a
 * topic, which is the answer for a device that cannot install the app at all.
 * They are independent opt-ins and either may be off, so `notify()` calls this
 * rather than either of them: a caller that picked a channel would be a caller
 * that has to be edited when a third one appears, and — worse — one that
 * decides on its own which failures matter.
 *
 * Merging is where the judgement is. It is optimistic about delivery and
 * pessimistic about retry, and both halves are deliberate:
 *
 * One channel accepting the alert means the operator was told, so the merged
 * result is a success even if the other failed. The alternative lets an ntfy
 * topic that has been misconfigured for a week mark every alert as failed while
 * the phone in the operator's hand is buzzing correctly.
 *
 * One channel wanting a retry makes the merged result retryable, because the
 * attention machinery retries the whole alert rather than one sink. Retrying a
 * channel that already succeeded costs a duplicate banner; not retrying the one
 * that failed costs the notification entirely, and those two are not close.
 */

/** Both sinks were switched off, so nothing was attempted and nothing is owed. */
function skippedResult(at: number): MobilePushResult {
  return { at, ok: false, skipped: true, retryable: true, httpStatus: null, error: null };
}

function merge(at: number, results: readonly MobilePushResult[]): MobilePushResult {
  const attempted = results.filter((result) => !result.skipped);
  if (attempted.length === 0) return skippedResult(at);

  const delivered = attempted.find((result) => result.ok);
  if (delivered) {
    return { at, ok: true, skipped: false, retryable: false, httpStatus: delivered.httpStatus, error: null };
  }
  const failed = attempted.filter((result) => !result.ok);
  return {
    at,
    ok: false,
    skipped: false,
    retryable: failed.some((result) => result.retryable),
    httpStatus: failed.find((result) => result.httpStatus !== null)?.httpStatus ?? null,
    // One sentence, not two joined: this string is shown on a phone screen and
    // in a Settings line, and a channel that is deliberately switched off has
    // no failure to report. The first real reason is the actionable one.
    error: failed.find((result) => result.error)?.error ?? 'No alert channel accepted the notification.',
  };
}

/**
 * Send one alert everywhere it is wanted.
 *
 * Never rejects, and neither sink can make the other wait on it: both are
 * started before either is awaited, because this runs inside hook handlers and
 * a slow ntfy server must not add its timeout to the phone's.
 */
export async function deliverMobileAlert(input: MobilePushInput): Promise<MobilePushResult> {
  const at = Date.now();
  const results = await Promise.all([
    sendWebPush(input).catch((): MobilePushResult => ({
      at, ok: false, skipped: false, retryable: true, httpStatus: null, error: 'Web Push failed.',
    })),
    sendMobilePush(input).catch((): MobilePushResult => ({
      at, ok: false, skipped: false, retryable: true, httpStatus: null, error: 'ntfy delivery failed.',
    })),
  ]);
  return merge(at, results);
}

/**
 * Prove each channel separately, and report them separately.
 *
 * A merged verdict is the wrong answer for a test: "one of your two channels
 * works" is exactly the sentence an operator cannot act on, and the whole point
 * of pressing the button is to find out which.
 */
export async function testMobileAlerts(): Promise<MobileAlertTest[]> {
  const [webpush, ntfy] = await Promise.all([testWebPush(), testMobilePush()]);
  return [
    {
      channel: 'webpush',
      ok: webpush.ok,
      detail: webpush.ok
        ? 'Sent to every subscribed device. Whether one showed it is up to the device.'
        : webpush.error ?? 'The push service did not accept the test alert.',
    },
    {
      channel: 'ntfy',
      ok: ntfy.ok,
      detail: ntfy.ok
        ? 'Accepted by ntfy; device receipt is not reported.'
        : ntfy.error ?? (ntfy.skipped ? 'ntfy alerts are switched off.' : 'ntfy did not accept the test alert.'),
    },
  ];
}

/**
 * Which channels a test would actually reach, before one is sent.
 *
 * Read so the button can say what pressing it will do. "Send a test" that
 * silently exercises two of four surfaces is how somebody concludes the whole
 * feature is broken when in fact they never subscribed a device — which is the
 * first thing that happened to this feature in the field.
 */
export function alertChannelReadiness(): MobileAlertChannels {
  const web = webPushProbe();
  const ntfy = mobilePushProbe();
  // Rebuilt field by field rather than handed over. A probe carries its own
  // last result, and the renderer only needs to know whether a press would
  // reach anything — passing the whole thing would put a push service's error
  // body on a second screen that never asked for it.
  return {
    webPush: { enabled: web.enabled, ready: web.ready, blocked: web.blocked, deviceCount: web.deviceCount },
    ntfy: { enabled: ntfy.enabled, ready: ntfy.ready, blocked: ntfy.blocked },
  };
}
