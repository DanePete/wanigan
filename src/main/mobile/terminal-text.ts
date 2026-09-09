/**
 * The desktop terminal has an ANSI parser. The mobile view deliberately uses
 * a plain, inert <pre>, so terminal escape sequences must never be sent to it
 * verbatim. Apart from making colour codes visible as garbage, OSC sequences
 * can contain arbitrary terminal metadata. This produces a readable snapshot
 * while keeping the remote page incapable of interpreting terminal controls.
 *
 * Colour is the one thing that used to be thrown away here, and throwing it
 * away cost more than it looked like it did. An agent CLI says a great deal with
 * it — which lines are its own and which are the tool's, what failed, what is a
 * diff and which side of it — and a phone that rendered all of it in one grey
 * left the operator reading a wall of text for structure the Mac was drawing for
 * free. So SGR is now parsed and carried, and it is carried as *data*: a small
 * palette of resolved styles, plus per-line column ranges that point into it.
 * The page still never sees an escape byte, still cannot be told to interpret
 * one, and builds spans with textContent and a validated colour. That is the
 * property this module exists to hold, and it is unchanged.
 */

/** Bit flags for the attributes worth carrying to a phone. */
export const TERMINAL_BOLD = 1;
export const TERMINAL_DIM = 2;
export const TERMINAL_ITALIC = 4;
export const TERMINAL_UNDERLINE = 8;
export const TERMINAL_INVERSE = 16;

/**
 * One resolved style. A colour is either one of the sixteen named slots, which
 * the page maps to its own theme exactly as the desktop maps xterm's palette to
 * CSS tokens, or a `#rrggbb` literal from a 24-bit or 256-colour SGR. Never a
 * raw parameter list, and never a string the page has to parse.
 */
export type TerminalStyle = {
  fg: string | null;
  bg: string | null;
  flags: number;
};

/** The sixteen slot names, in SGR order, shared with the page's palette. */
export const TERMINAL_SLOTS = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'bright-black', 'bright-red', 'bright-green', 'bright-yellow',
  'bright-blue', 'bright-magenta', 'bright-cyan', 'bright-white',
] as const;

export type StyledTerminal = {
  /** Exactly what readableTerminal() returns for the same input. */
  text: string;
  /**
   * One row per line of `text`, each a flat run of `[column, length, styleId]`
   * triples in column order. A line with nothing but default styling is an
   * empty row rather than a row of zeroes.
   */
  spans: number[][];
  /** styleId → style. Index 0 is always the default: no colour, no flags. */
  palette: TerminalStyle[];
};

const DEFAULT_STYLE: TerminalStyle = { fg: null, bg: null, flags: 0 };

/** The 6×6×6 cube and the 24 greys of the 256-colour palette, as hex. */
function cubeColor(index: number): string | null {
  if (index < 16) return null;
  if (index < 232) {
    const step = (value: number): number => (value === 0 ? 0 : 55 + value * 40);
    const n = index - 16;
    const r = step(Math.floor(n / 36));
    const g = step(Math.floor((n % 36) / 6));
    const b = step(n % 6);
    return hex(r, g, b);
  }
  if (index < 256) {
    const level = 8 + (index - 232) * 10;
    return hex(level, level, level);
  }
  return null;
}

function byte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value) || 0));
}

function hex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((value) => byte(value).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * One extended-colour selector — `38;5;n`, `38;2;r;g;b`, and the colon-separated
 * forms the same parameters also arrive in. Returns the colour and how many
 * parameters it consumed, so the caller can carry on with the rest of the SGR.
 */
function extendedColor(params: string[], at: number): { color: string | null; used: number } {
  const kind = Number(params[at + 1] ?? '');
  if (kind === 5) {
    const index = Number(params[at + 2] ?? '');
    if (!Number.isFinite(index) || index < 0 || index > 255) return { color: null, used: 3 };
    return { color: index < 16 ? TERMINAL_SLOTS[index] : cubeColor(index), used: 3 };
  }
  if (kind === 2) {
    // ITU T.416 writes this one with a colour-space id between the selector and
    // the channels — `38:2::255:0:0` — and the split above flattens ':' and ';'
    // into the same array, so that id arrives as an empty parameter. Reading
    // straight past it took the empty string as red (Number('') is 0), shifted
    // the real red into green, and left the last channel behind to be read as
    // the next SGR code — which for a plain `38:2::255:0:0` is a literal 0, so
    // the colour came out wrong *and* reset everything after it. An empty
    // parameter here can only be that id: `38;2;;r;g` is malformed either way.
    const spaced = (params[at + 2] ?? '') === '' && params.length > at + 5 ? 1 : 0;
    const first = at + 2 + spaced;
    const parts = [params[first], params[first + 1], params[first + 2]].map((value) => Number(value ?? ''));
    if (parts.some((value) => !Number.isFinite(value))) return { color: null, used: 5 + spaced };
    return { color: hex(parts[0], parts[1], parts[2]), used: 5 + spaced };
  }
  // An unrecognised selector consumes only itself: guessing at its length would
  // silently eat the attributes that follow it.
  return { color: null, used: 2 };
}

/**
 * The display parser, returning the readable text and the styling that goes
 * with it. `readableTerminal` is this without the styling, and the two can never
 * disagree about where a character landed because there is only one parser.
 */
export function styledTerminal(value: string): StyledTerminal {
  // This is deliberately a small *display* parser, not an xterm replacement.
  // Stripping every CSI sequence made carriage-return redraws leave the old
  // characters behind ("working…\rDone" became "Doneing…" on iPad). Handling
  // the common cursor and erase controls keeps normal CLI output legible while
  // the remote page remains an inert `<pre>` with no terminal escape handling.
  const input = value
    // OSC may carry titles, hyperlinks, or clipboard data; DCS/APC/PM/SOS are
    // equally out-of-band control strings. None belongs in a remote plain-text
    // transcript, even as harmless-looking printable payload.
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[P_^X][\s\S]*?\x1b\\/g, '');
  const lines = [''];
  // One style id per written cell, in step with `lines`. A gap left by a cursor
  // jump is style 0, the same as the space that fills it.
  const cells: number[][] = [[]];
  const MAX_ROWS = 10_000;
  const MAX_COLUMNS = 2_000;
  // A screen this parser has already spent its budget styling keeps its text and
  // stops gaining palette entries. 4096 distinct styles is far past any real
  // TUI; a stream that reached it is fuzzing the palette, not colouring output.
  const MAX_STYLES = 4_096;
  let row = 0;
  let column = 0;
  let saved: { row: number; column: number } | null = null;
  let style: TerminalStyle = DEFAULT_STYLE;
  let styleId = 0;
  const palette: TerminalStyle[] = [DEFAULT_STYLE];
  // Keyed exactly as useStyle() keys a style, so a reset back to the default
  // resolves to id 0 instead of minting a second, identical entry — and a run of
  // ordinary text then carries no span at all, which is most of a screen.
  const styleKeys = new Map<string, number>([['||0', 0]]);

  const useStyle = (next: TerminalStyle) => {
    style = next;
    const key = `${next.fg ?? ''}|${next.bg ?? ''}|${next.flags}`;
    const known = styleKeys.get(key);
    if (known !== undefined) { styleId = known; return; }
    if (palette.length >= MAX_STYLES) { styleId = 0; return; }
    palette.push(next);
    styleId = palette.length - 1;
    styleKeys.set(key, styleId);
  };

  const setRow = (next: number) => {
    row = Math.max(0, Math.min(MAX_ROWS, Math.round(next) || 0));
    while (lines.length <= row) { lines.push(''); cells.push([]); }
  };
  const setColumn = (next: number) => { column = Math.max(0, Math.min(MAX_COLUMNS, Math.round(next) || 0)); };
  const number = (params: string[], index: number, fallback = 1) => {
    const raw = params[index] ?? '';
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? Math.min(10_000, Math.floor(parsed)) : fallback;
  };
  const put = (char: string) => {
    const line = lines[row] ?? '';
    lines[row] = column < line.length
      ? `${line.slice(0, column)}${char}${line.slice(column + 1)}`
      : `${line}${' '.repeat(Math.max(0, column - line.length))}${char}`;
    const cell = cells[row] ?? (cells[row] = []);
    // The padding a cursor jump left behind is unstyled, so it is spaces on the
    // page rather than a block of whatever colour is current.
    while (cell.length < column) cell.push(0);
    cell[column] = styleId;
    setColumn(column + 1);
  };
  const eraseLine = (mode: number) => {
    const line = lines[row] ?? '';
    const cell = cells[row] ?? (cells[row] = []);
    if (mode === 2) { lines[row] = ''; cells[row] = []; column = 0; return; }
    if (mode === 1) {
      lines[row] = `${' '.repeat(column)}${line.slice(column)}`;
      cells[row] = new Array(Math.min(column, MAX_COLUMNS)).fill(0).concat(cell.slice(column));
      return;
    }
    lines[row] = line.slice(0, column);
    cells[row] = cell.slice(0, column);
  };
  const clearAll = () => {
    lines.splice(0, lines.length, '');
    cells.splice(0, cells.length, []);
    row = 0;
    column = 0;
  };

  /**
   * SGR. Anything this does not recognise resets nothing and is skipped, which
   * is what keeps an unknown attribute from silently clearing the colour of
   * everything after it.
   */
  const applySgr = (params: string[]) => {
    if (!params.length) { useStyle(DEFAULT_STYLE); return; }
    let next: TerminalStyle = { fg: style.fg, bg: style.bg, flags: style.flags };
    for (let at = 0; at < params.length; at++) {
      const code = Number(params[at] ?? '');
      if (!Number.isFinite(code)) continue;
      if (code === 0) { next = { fg: null, bg: null, flags: 0 }; continue; }
      if (code === 1) { next.flags |= TERMINAL_BOLD; continue; }
      if (code === 2) { next.flags |= TERMINAL_DIM; continue; }
      if (code === 3) { next.flags |= TERMINAL_ITALIC; continue; }
      if (code === 4) { next.flags |= TERMINAL_UNDERLINE; continue; }
      if (code === 7) { next.flags |= TERMINAL_INVERSE; continue; }
      if (code === 21 || code === 22) { next.flags &= ~(TERMINAL_BOLD | TERMINAL_DIM); continue; }
      if (code === 23) { next.flags &= ~TERMINAL_ITALIC; continue; }
      if (code === 24) { next.flags &= ~TERMINAL_UNDERLINE; continue; }
      if (code === 27) { next.flags &= ~TERMINAL_INVERSE; continue; }
      if (code >= 30 && code <= 37) { next.fg = TERMINAL_SLOTS[code - 30]; continue; }
      if (code === 39) { next.fg = null; continue; }
      if (code >= 40 && code <= 47) { next.bg = TERMINAL_SLOTS[code - 40]; continue; }
      if (code === 49) { next.bg = null; continue; }
      if (code >= 90 && code <= 97) { next.fg = TERMINAL_SLOTS[code - 90 + 8]; continue; }
      if (code >= 100 && code <= 107) { next.bg = TERMINAL_SLOTS[code - 100 + 8]; continue; }
      if (code === 38 || code === 48) {
        const resolved = extendedColor(params, at);
        if (code === 38) next.fg = resolved.color;
        else next.bg = resolved.color;
        at += resolved.used - 1;
        continue;
      }
    }
    useStyle(next);
  };

  for (let i = 0; i < input.length;) {
    const char = input[i++];
    if (char === '\x1b') {
      const next = input[i];
      if (next === ']' || next === 'P' || next === '_' || next === '^' || next === 'X') {
        // A complete OSC was stripped above. An incomplete one must not leak
        // opaque terminal metadata into the remote display.
        break;
      }
      if (next === '[') {
        i++;
        const begin = i;
        while (i < input.length && !/[@-~]/.test(input[i])) i++;
        if (i >= input.length) break;
        const command = input[i++];
        const prefixed = /^[?>!]/.test(input.slice(begin, i - 1));
        const raw = input.slice(begin, i - 1).replace(/^[?>!]/, '');
        const params = raw ? raw.split(/[;:]/) : [];
        const n = number(params, 0);
        switch (command) {
          case 'A': setRow(row - n); break;
          case 'B': setRow(row + n); break;
          case 'C': setColumn(column + n); break;
          case 'D': setColumn(column - n); break;
          case 'E': setRow(row + n); column = 0; break;
          case 'F': setRow(row - n); column = 0; break;
          case 'G': setColumn(n - 1); break;
          case 'H':
          case 'f': setRow(number(params, 0) - 1); setColumn(number(params, 1) - 1); break;
          case 'J': {
            const mode = Number(params[0] || '0');
            if (mode === 2 || mode === 3) clearAll();
            else if (mode === 0) { lines.splice(row + 1); cells.splice(row + 1); eraseLine(0); }
            else if (mode === 1) { lines.splice(0, row); cells.splice(0, row); row = 0; eraseLine(1); }
            break;
          }
          case 'K': eraseLine(Number(params[0] || '0')); break;
          case 's': saved = { row, column }; break;
          case 'u': if (saved) { setRow(saved.row); setColumn(saved.column); } break;
          // A private-mode switch shares its final byte with SGR. `?25h` is a
          // cursor, not a colour, and reading it as one would reset the style on
          // every spinner frame.
          case 'm': if (!prefixed) applySgr(params); break;
          // The remaining terminal controls are reports and private mode
          // switches. They are deliberately discarded.
          default: break;
        }
        continue;
      }
      if (next === '7') { saved = { row, column }; i++; continue; }
      if (next === '8') { if (saved) { setRow(saved.row); setColumn(saved.column); } i++; continue; }
      if (next === 'c') { clearAll(); useStyle(DEFAULT_STYLE); i++; continue; }
      // Charset selectors and all remaining two-byte escape forms.
      if (next !== undefined) i++;
      continue;
    }
    if (char === '\n') { setRow(row + 1); column = 0; continue; }
    if (char === '\r') { column = 0; continue; }
    if (char === '\b') { setColumn(column - 1); continue; }
    if (char === '\t') { setColumn(column + (2 - (column % 2))); continue; }
    if (char < ' ' || char === '\x7f') continue;
    put(char);
  }

  // The blank-run collapse has to move the styling with it, so it is done on the
  // two arrays together rather than on the joined string. It was a regex over
  // newline counts, which meant a run at the very top of the screen collapsed to
  // one length and the same run in the middle collapsed to another; stated in
  // lines it is one rule everywhere. Two consecutive blank lines survive, which
  // is what the interior case did before.
  const keptText: string[] = [];
  const keptCells: number[][] = [];
  let blanks = 0;
  for (let at = 0; at < lines.length; at++) {
    const line = lines[at] ?? '';
    if (line === '') {
      blanks++;
      if (blanks > 2) continue;
    } else blanks = 0;
    keptText.push(line);
    keptCells.push(cells[at] ?? []);
  }

  return {
    text: keptText.join('\n'),
    spans: keptCells.map((cell, at) => runsOf(cell, (keptText[at] ?? '').length)),
    palette,
  };
}

/** One line's cell styles, reduced to `[column, length, styleId]` triples. */
function runsOf(cell: number[], width: number): number[] {
  const out: number[] = [];
  let at = 0;
  while (at < width) {
    const id = cell[at] ?? 0;
    let end = at + 1;
    while (end < width && (cell[end] ?? 0) === id) end++;
    if (id !== 0) out.push(at, end - at, id);
    at = end;
  }
  return out;
}

/**
 * The readable snapshot on its own, which is what the cursor protocol in
 * terminal.ts hashes and what the smoke suite pins. Derived from the styled
 * parse so the text a span points into is the text that was sent.
 */
export function readableTerminal(value: string): string {
  return styledTerminal(value).text;
}
