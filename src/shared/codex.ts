// Codex's lifecycle, read from its terminal. Codex does not post hook events
// the way Claude Code does, but it can write two structured notifications —
// a turn completing and an approval being requested — as OSC 9 escape
// sequences. Wanigan asks for exactly those two, for its own terminal only, and
// reads them out of the output stream. No prompt or response text is kept.
//
// Carried over from Wanigan 1 (src/main/sessions.ts), which read any
// notification that was not "agent turn complete" as the approval. Codex
// 0.155.1 ends a turn with the agent's last message instead, so it is the other
// way round now: an approval is worded as one, and anything else ends a turn.

/**
 * Launch arguments that make this one Codex terminal report its lifecycle, and
 * keep it from animating while idle: with its colour queries answered (xterm
 * does), Codex 0.155.1 redraws its composer about 2 KB every 15 s at rest, which
 * fills the replay and the record and leaves Watch and search with nothing.
 * Nor does it ask to update Codex: that question starts on "Update now (runs
 * brew upgrade)", behind what Wanigan reads as Codex at its prompt, so a message
 * typed in from the composer would choose it. No user config is edited.
 */
export const CODEX_LIFECYCLE_ARGS: readonly string[] = [
  '--config', 'tui.notifications=["agent-turn-complete","approval-requested"]',
  '--config', 'tui.notification_condition="always"',
  '--config', 'tui.notification_method="osc9"',
  '--config', 'tui.animations=false',
  '--config', 'check_for_update_on_startup=false',
];

export interface CodexSignal { kind: 'finished' | 'permission'; text: string }

const OSC9 = '\x1b]9;';
/**
 * How Codex words an approval (0.155.1's binary: "Approval requested: …",
 * "Approval requested by …", "Codex wants to edit …"). Anything else is the
 * turn ending: "Agent turn complete", or since 0.155.1 the agent's last message.
 */
const APPROVAL = /^(approval requested\b|codex wants to\b)/i;
const MAX_HELD = 2_048;

/**
 * Pull OSC 9 lifecycle messages out of arbitrary PTY chunks. A sequence can be
 * split at any byte, so a short unfinished tail is carried to the next chunk;
 * nothing else is retained.
 */
export function scanCodex(pending: string, chunk: string): { pending: string; signals: CodexSignal[] } {
  let input = `${pending}${chunk}`;
  const signals: CodexSignal[] = [];
  for (;;) {
    const start = input.indexOf(OSC9);
    if (start < 0) {
      let tail = '';
      for (let n = Math.min(OSC9.length - 1, input.length); n > 0; n--) {
        const candidate = input.slice(-n);
        if (OSC9.startsWith(candidate)) { tail = candidate; break; }
      }
      return { pending: tail, signals };
    }
    const at = start + OSC9.length;
    const bel = input.indexOf('\x07', at);
    const st = input.indexOf('\x1b\\', at);
    const end = bel < 0 ? st : st < 0 ? bel : Math.min(bel, st);
    if (end < 0) return { pending: input.slice(start, start + MAX_HELD), signals };
    const payload = input.slice(at, end).replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
    // OSC 9;4 is a progress report ("4;1;50"), not a notification.
    if (/^\d+;/.test(payload)) { /* progress */ } else if (APPROVAL.test(payload)) signals.push({ kind: 'permission', text: payload.slice(0, 200) });
    else if (payload) signals.push({ kind: 'finished', text: payload });
    input = input.slice(end + (end === st ? 2 : 1));
  }
}

/**
 * What the owner has typed into Codex since the last Enter. `answering` is set
 * inside a terminal's string answer to a query (OSC 10/11 colours, DCS), which
 * reaches the PTY as input but is not typed.
 */
export interface TypedLine { text: string; pasting: boolean; answering?: boolean }

export const EMPTY_LINE: TypedLine = { text: '', pasting: false };

const MAX_TYPED = 256;
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/**
 * Follow the owner's keystrokes into Codex, to know when Enter submits a
 * prompt. Enter on an empty line, or on a slash command (/status, /model),
 * starts no turn, and a newline inside a paste is not Enter. Only the start of
 * the line is kept: enough to tell a command from a prompt.
 */
export function typeInto(line: TypedLine, data: string): { line: TypedLine; submitted: boolean } {
  let { text, pasting } = line;
  let answering = line.answering ?? false;
  let submitted = false;
  let i = 0;
  while (i < data.length) {
    if (answering) {
      // A string answer ends at BEL or ST (ESC \); an Enter ends one never closed.
      if (data[i] === '\x07') { answering = false; i += 1; continue; }
      if (data.startsWith('\x1b\\', i)) { answering = false; i += 2; continue; }
      if (data[i] !== '\r' && data[i] !== '\n') { i += 1; continue; }
      answering = false;
    }
    if (data.startsWith(PASTE_START, i)) { pasting = true; i += PASTE_START.length; continue; }
    if (data.startsWith(PASTE_END, i)) { pasting = false; i += PASTE_END.length; continue; }
    const ch = data[i] as string;
    // OSC, DCS, APC, PM and SOS strings: what a terminal answers to a query.
    if (ch === '\x1b' && /^[\]P_^X]$/.test(data[i + 1] ?? '')) { answering = true; i += 2; continue; }
    if (ch === '\x1b') {
      // Any other escape sequence (arrows, function keys) moves the cursor; skip it.
      const m = /^\x1b(?:\[[0-?]*[ -/]*[@-~]|O.|.)?/.exec(data.slice(i, i + 32));
      i += m?.[0].length || 1;
      continue;
    }
    i += 1;
    if (ch === '\r' || ch === '\n') {
      if (pasting) { if (text.length < MAX_TYPED) text += ' '; continue; }
      const typed = text.trim();
      if (typed && !typed.startsWith('/')) submitted = true;
      text = '';
    } else if (ch === '\x7f' || ch === '\b') {
      text = text.slice(0, -1);
    } else if (ch === '\x15' || ch === '\x03') {
      text = ''; // Ctrl-U clears the line; Ctrl-C abandons it
    } else if (ch >= ' ' && text.length < MAX_TYPED) {
      text += ch;
    }
  }
  return { line: { text, pasting, ...(answering ? { answering } : {}) }, submitted };
}
