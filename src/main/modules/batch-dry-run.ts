import { client, isMock, explainApiError } from '../batch/anthropic';
import { estimateTokens } from '../../shared/tokens';
import { recordDirectRequestMeters } from './usage-paid-operations';
import type { BuiltRequest } from '../batch/build';

/**
 * Pre-flight: send exactly one request synchronously through the Messages API.
 * Batch validation is asynchronous — a malformed params object is not reported
 * until the whole batch finishes, so this is the only cheap way to fail fast.
 */
// No cfg parameter: buildRequests has already baked the config into
// req.params, so a second one here could only disagree with what is
// actually about to be sent.
export async function dryRun(req: BuiltRequest) {
  if (isMock()) {
    return {
      ok: true as const,
      text: `[mock dry run] would send ${req.rendered.length} chars for custom_id ${req.custom_id}`,
      usage: { input_tokens: estimateTokens(req.rendered), output_tokens: 128 },
      stopReason: 'end_turn',
      customId: req.custom_id,
    };
  }
  try {
    const msg = await client().messages.create(req.params as never);
    // The one paid request here with no ledger of its own: a sample nobody
    // keeps. Its meters go to Usage's, so its receipt can be accounted for.
    recordDirectRequestMeters({ source: 'batch:dry-run', model: msg.model, inputTokens: msg.usage?.input_tokens,
      outputTokens: msg.usage?.output_tokens, requestId: (msg as { _request_id?: string | null })._request_id });
    const text = msg.content
      .flatMap((b) => (b.type === 'text' ? [b.text] : []))
      .join('\n');
    return {
      ok: true as const,
      text,
      usage: { input_tokens: msg.usage.input_tokens, output_tokens: msg.usage.output_tokens },
      stopReason: msg.stop_reason ?? null,
      customId: req.custom_id,
    };
  } catch (e: unknown) {
    const err = e as { status?: number; message?: string; error?: { error?: { type?: string; message?: string } } };
    return {
      ok: false as const,
      status: err.status ?? 0,
      type: err.error?.error?.type ?? 'unknown_error',
      message: explainApiError(e),
      customId: req.custom_id,
    };
  }
}
