/**
 * The desktop terminal has an ANSI parser. The mobile view deliberately uses
 * a plain, inert <pre>, so terminal escape sequences must never be sent to it
 * verbatim. Apart from making colour codes visible as garbage, OSC sequences
 * can contain arbitrary terminal metadata. This produces a readable snapshot
 * while keeping the remote page incapable of interpreting terminal controls.
 */
export function readableTerminal(value: string): string {
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
  const MAX_ROWS = 10_000;
  const MAX_COLUMNS = 2_000;
  let row = 0;
  let column = 0;
  let saved: { row: number; column: number } | null = null;

  const setRow = (next: number) => {
    row = Math.max(0, Math.min(MAX_ROWS, Math.round(next) || 0));
    while (lines.length <= row) lines.push('');
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
    setColumn(column + 1);
  };
  const eraseLine = (mode: number) => {
    const line = lines[row] ?? '';
    if (mode === 2) { lines[row] = ''; column = 0; return; }
    if (mode === 1) { lines[row] = `${' '.repeat(column)}${line.slice(column)}`; return; }
    lines[row] = line.slice(0, column);
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
            if (mode === 2 || mode === 3) { lines.splice(0, lines.length, ''); row = 0; column = 0; }
            else if (mode === 0) { lines.splice(row + 1); eraseLine(0); }
            else if (mode === 1) { lines.splice(0, row); row = 0; eraseLine(1); }
            break;
          }
          case 'K': eraseLine(Number(params[0] || '0')); break;
          case 's': saved = { row, column }; break;
          case 'u': if (saved) { setRow(saved.row); setColumn(saved.column); } break;
          // SGR and the remaining terminal controls are styling, reports, or
          // private mode switches. They are deliberately discarded.
          default: break;
        }
        continue;
      }
      if (next === '7') { saved = { row, column }; i++; continue; }
      if (next === '8') { if (saved) { setRow(saved.row); setColumn(saved.column); } i++; continue; }
      if (next === 'c') { lines.splice(0, lines.length, ''); row = 0; column = 0; i++; continue; }
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
  return lines.join('\n').replace(/\n{4,}/g, '\n\n\n');
}
