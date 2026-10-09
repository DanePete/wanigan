// When the owner says No at a Claude Code permission prompt, or presses Esc
// mid-turn, Claude Code goes back to its prompt and fires no hook (2.1.292:
// PermissionDenied is the auto-mode classifier's alone, and an interrupted turn
// has no Stop). Its transcript says so, though: the newest record is the
// owner's "[Request interrupted by user]" or "… for tool use]". The screen is no
// witness: Claude redraws earlier interrupt lines whenever a dialog closes.
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

const INTERRUPTED = /^\[Request interrupted by user/;
/** The newest records of a transcript are in its last few kilobytes. */
const TAIL_BYTES = 64 * 1024;

/**
 * When the owner interrupted the conversation, if the newest thing in its
 * transcript is that interrupt; null otherwise, or when it cannot be read.
 */
export function interruptedAt(transcript: string): number | null {
  let fd: number | null = null;
  try {
    fd = openSync(transcript, 'r');
    const size = fstatSync(fd).size;
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n');
    // The first line may be cut by the window; the last may be half written.
    for (let i = lines.length - 1; i >= (length < size ? 1 : 0); i--) {
      const line = lines[i]?.trim();
      if (!line) continue;
      let record: { type?: unknown; timestamp?: unknown; message?: { content?: unknown } };
      try { record = JSON.parse(line) as typeof record; } catch { continue; }
      // Bookkeeping (snapshots, summaries, titles) is not the conversation.
      if (record.type !== 'user' && record.type !== 'assistant') continue;
      if (record.type !== 'user') return null;
      const content = record.message?.content;
      const text = typeof content === 'string' ? content
        : Array.isArray(content) && content.length === 1 && (content[0] as { type?: unknown })?.type === 'text' ? String((content[0] as { text?: unknown }).text ?? '')
          : '';
      if (!INTERRUPTED.test(text)) return null;
      const at = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN;
      return Number.isFinite(at) ? at : null;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}
