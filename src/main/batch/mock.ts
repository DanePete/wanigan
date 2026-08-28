import fs from 'node:fs';
import path from 'node:path';
import { resultsDir } from '../db';

/**
 * Local stand-in for the Batches API. Same object shapes, same lifecycle
 * (in_progress -> ended), same out-of-order .jsonl results, no network, no spend.
 * Used when BATCHSTUDIO_MOCK=1 so the UI can be built and demoed end to end.
 */
type MockBatch = {
  id: string; processing_status: string; created_at: string; expires_at: string;
  ended_at: string | null; cancel_initiated_at: string | null; results_url: string | null;
  request_counts: { processing: number; succeeded: number; errored: number; canceled: number; expired: number };
  _requests: { custom_id: string; params: Record<string, unknown> }[];
  _readyAt: number;
};

const store = new Map<string, MockBatch>();

function file(id: string) { return path.join(resultsDir(), `${id}.mock.json`); }

function save(b: MockBatch) {
  fs.mkdirSync(resultsDir(), { recursive: true });
  fs.writeFileSync(file(b.id), JSON.stringify(b));
  store.set(b.id, b);
}
function load(id: string): MockBatch | null {
  if (store.has(id)) return store.get(id)!;
  try { const b = JSON.parse(fs.readFileSync(file(id), 'utf8')); store.set(id, b); return b; } catch { return null; }
}

export function mockCreate(requests: { custom_id: string; params: Record<string, unknown> }[]) {
  const id = `msgbatch_mock${Math.random().toString(36).slice(2, 12)}`;
  const now = Date.now();
  const b: MockBatch = {
    id, processing_status: 'in_progress',
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + 24 * 3600_000).toISOString(),
    ended_at: null, cancel_initiated_at: null, results_url: null,
    request_counts: { processing: requests.length, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
    _requests: requests,
    _readyAt: now + Number(process.env.WANIGAN_MOCK_DELAY_MS || 20_000), // so the monitor UI has something to show
  };
  save(b);
  return b;
}

export function mockRetrieve(id: string) {
  const b = load(id);
  if (!b) throw new Error(`Unknown mock batch ${id}`);
  if (b.processing_status !== 'ended' && Date.now() >= b._readyAt) {
    const total = b._requests.length;
    // Fail ~4% so the dead-letter queue and retry path are actually exercised.
    const errored = Math.floor(total * 0.04);
    b.request_counts = { processing: 0, succeeded: total - errored, errored, canceled: 0, expired: 0 };
    b.processing_status = 'ended';
    b.ended_at = new Date().toISOString();
    b.results_url = `mock://${id}`;
    save(b);
  }
  return b;
}

export function mockCancel(id: string) {
  const b = load(id);
  if (!b) throw new Error(`Unknown mock batch ${id}`);
  b.processing_status = 'canceling';
  b.cancel_initiated_at = new Date().toISOString();
  b._readyAt = Date.now();
  save(b);
  return b;
}

/** Yields results deliberately out of order, exactly as the real API may. */
export function* mockResults(id: string) {
  const b = load(id);
  if (!b) throw new Error(`Unknown mock batch ${id}`);
  const errored = b.request_counts.errored;
  const shuffled = b._requests.map((r, i) => ({ r, i })).reverse();

  for (const { r, i } of shuffled) {
    if (i < errored) {
      yield {
        custom_id: r.custom_id,
        result: { type: 'errored', error: { type: 'error', error: { type: 'invalid_request_error', message: 'mock: simulated validation failure' } } },
      };
      continue;
    }
    const prompt = String((r.params.messages as { content: string }[])[0]?.content ?? '');
    yield {
      custom_id: r.custom_id,
      result: {
        type: 'succeeded',
        message: {
          id: `msg_mock${i}`, type: 'message', role: 'assistant', model: r.params.model,
          content: [{ type: 'text', text: `[mock output for ${r.custom_id}]\n${prompt.slice(0, 200)}` }],
          stop_reason: 'end_turn', stop_sequence: null,
          usage: { input_tokens: Math.round(prompt.length / 4), output_tokens: 60 + (i % 40) },
        },
      },
    };
  }
}
