import { createHash } from 'node:crypto';
import { readableTerminal } from './terminal-text';

/**
 * What the phone's terminal poll actually reads.
 *
 * The console asks every 1.5 seconds, and it used to be answered with the whole
 * readable scrollback every time — up to MAX_TERMINAL_BYTES of it, over a
 * tunnel, to a device on cellular. A session printing steadily therefore cost a
 * quarter of a megabyte a tick to report that four lines had appeared.
 *
 * This answers the same question from a cursor instead, and the hard part is
 * that neither thing it reads is append-only. sessions.ts keeps the last 512KB
 * of a session's output and drops the front, so a byte offset into that ring
 * stops meaning anything the moment it wraps; and the rendered screen is not
 * append-only either, because an agent TUI redrawing itself rewrites lines that
 * were already sent. A cursor that was only a position would go on looking
 * valid in both cases and quietly hand the page an append that skipped the
 * middle.
 *
 * So the cursor names a line count *and* carries a hash of the exact lines it
 * counted. If that hash no longer matches what Wanigan holds, the read says
 * which way it failed and returns a fresh screen. Never a silent gap: that is
 * the only property here worth having, and the rest is bookkeeping around it.
 */

/** The ceiling on the text any single terminal response may carry. */
export const MAX_TERMINAL_BYTES = 240 * 1024;

/**
 * How much of the bottom of the screen is treated as still being redrawn. An
 * agent TUI rewrites its last handful of lines constantly — the spinner, the
 * input box, the token counter — so those are re-sent whole on every read
 * rather than being counted as settled and then invalidating the page's cursor
 * a second later. Everything above them is what the cursor is about.
 */
const LIVE_TAIL_LINES = 48;

/**
 * …and a byte ceiling for that tail, because one pasted or wrapped line can be
 * very wide and a "small" tail measured only in lines is not small.
 */
const MAX_TAIL_BYTES = 32 * 1024;

const CURSOR_PATTERN = /^([0-9]{1,9})\.([0-9a-f]{16})$/;

/** Why a whole screen was sent instead of an append. */
export type MobileTerminalScreenReason = 'first-read' | 'behind' | 'too-much-output';

export type MobileTerminalRead = {
  title: string;
  running: boolean;
  /** 'screen' replaces what the page is showing; 'append' adds to the end of it. */
  mode: 'screen' | 'append';
  /**
   * In 'screen' mode the whole bounded rendering, which is what this route
   * returned before there was a cursor at all. In 'append' mode only the lines
   * that settled since the cursor, carrying their own leading newline so the
   * page can concatenate without having to guess at the join.
   */
  text: string;
  /**
   * The still-redrawing bottom of the screen, replaced wholesale on every read
   * and always a suffix of `text` in 'screen' mode.
   */
  tail: string;
  /** Send this back as `cursor` on the next read. */
  cursor: string;
  /** Null on an append; otherwise which of the three screen cases this is. */
  screenReason: MobileTerminalScreenReason | null;
  /** True when output older than this response exists but did not fit in it. */
  truncated: boolean;
};

export type MobileTerminalRequest = {
  sessionId: string;
  title: string;
  running: boolean;
  /** The session's raw scrollback, ANSI and all. */
  raw: string;
  /** Whatever the page sent as its cursor. Untrusted; anything unusable reads as no cursor. */
  cursor: string | null;
};

/**
 * The session id is inside the hash so a cursor minted against one terminal
 * cannot be honoured against another's identical opening lines — two sessions
 * of the same agent in the same repository start with the same banner.
 */
function mark(sessionId: string, prefix: string): string {
  return createHash('sha256').update(sessionId).update('\n').update(prefix).digest('hex').slice(0, 16);
}

function parseCursor(value: string | null | undefined): { lines: number; mark: string } | null {
  if (typeof value !== 'string') return null;
  const match = CURSOR_PATTERN.exec(value.trim());
  return match ? { lines: Number(match[1]), mark: match[2] } : null;
}

/** The index of the first line of the live tail: everything below it is settled. */
function liveTailStart(lines: string[]): number {
  let start = lines.length;
  let bytes = 0;
  while (start > 0 && lines.length - start < LIVE_TAIL_LINES) {
    const next = Buffer.byteLength(lines[start - 1]) + 1;
    // One line always goes into the tail however wide it is. A tail of nothing
    // would make the line the agent is redrawing right now "settled", and every
    // redraw of it would then invalidate the cursor and cost a whole screen.
    if (bytes + next > MAX_TAIL_BYTES && start < lines.length) break;
    bytes += next;
    start--;
  }
  return start;
}

/**
 * The last `maxBytes` of `text`, cut back to a line boundary. Cutting at the
 * first newline inside the byte slice does two jobs: it drops the half line the
 * byte cut landed in, and it removes the replacement character that a split
 * multi-byte sequence decodes to.
 */
function lastBytesOfLines(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return { text, truncated: false };
  const cut = buffer.subarray(buffer.length - maxBytes).toString('utf8');
  const boundary = cut.indexOf('\n');
  // A slice with no newline at all is one enormous line; strip the replacement
  // character directly rather than throwing the whole line away.
  return { text: boundary >= 0 ? cut.slice(boundary + 1) : cut.replace(/^\ufffd+/, ''), truncated: true };
}

export function readTerminalScreen(request: MobileTerminalRequest): MobileTerminalRead {
  // readableTerminal is the display parser the smoke suite pins; this module
  // reads what it produced and never reinterprets terminal control bytes.
  const lines = readableTerminal(request.raw).split('\n');
  const start = liveTailStart(lines);
  const settled = lines.slice(0, start).join('\n');
  // The newline that `split` consumed belongs between the two halves, and only
  // exists when there is a settled half and a tail half to separate.
  const joiner = start > 0 && start < lines.length ? '\n' : '';
  const tail = joiner + lines.slice(start).join('\n');
  const tailBytes = Buffer.byteLength(tail);
  const cursor = `${start}.${mark(request.sessionId, settled)}`;
  const asked = parseCursor(request.cursor);

  const screen = (reason: MobileTerminalScreenReason): MobileTerminalRead => {
    // The tail is bounded by construction, so the settled budget is never
    // squeezed to nothing and a screen can never exceed the ceiling.
    const bounded = lastBytesOfLines(settled, MAX_TERMINAL_BYTES - tailBytes);
    return {
      title: request.title,
      running: request.running,
      mode: 'screen',
      text: bounded.text + tail,
      tail,
      cursor,
      screenReason: reason,
      truncated: bounded.truncated,
    };
  };

  if (!asked) return screen('first-read');

  // A cursor past the settled line count means the screen shrank underneath it:
  // the ring dropped lines from the front, or the agent cleared the display.
  if (asked.lines > start) return screen('behind');
  const prefix = lines.slice(0, asked.lines).join('\n');
  // And a cursor that still counts is only usable if those lines are still the
  // same lines. This is the check that turns a wrapped ring or a redraw above
  // the live tail into an honest repaint instead of an append across a gap.
  if (mark(request.sessionId, prefix) !== asked.mark) return screen('behind');

  const appended = settled.slice(prefix.length);
  // A session that dumped more than one response can carry cannot be caught up
  // by appending, so it is a repaint that says so rather than a short append
  // pretending to be complete.
  if (Buffer.byteLength(appended) + tailBytes > MAX_TERMINAL_BYTES) return screen('too-much-output');

  return {
    title: request.title,
    running: request.running,
    mode: 'append',
    text: appended,
    tail,
    cursor,
    screenReason: null,
    truncated: false,
  };
}
