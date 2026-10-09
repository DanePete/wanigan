// Markdown, read for display only: headings, paragraphs, lists, quotes, code,
// tables and rules, with inline code, emphasis and links. It produces plain data
// that the interface turns into elements, so nothing in a file is ever treated
// as HTML: a tag in the text is shown as the text it is.

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'strong'; v: Inline[] }
  | { t: 'em'; v: Inline[] }
  | { t: 'link'; v: Inline[]; href: string };

export type Block =
  | { t: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; v: Inline[] }
  | { t: 'paragraph'; v: Inline[] }
  | { t: 'code'; lang: string; v: string }
  | { t: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { t: 'quote'; v: Block[] }
  | { t: 'table'; head: Inline[][]; rows: Inline[][][] }
  | { t: 'rule' };

export interface ListItem {
  depth: number;
  /** A task-list box: true checked, false empty, null none. */
  task: boolean | null;
  v: Inline[];
}

const FENCE = /^(\s{0,3})(`{3,}|~{3,})\s*([^`\s]*)/;
const HEADING_OPEN = /^\s{0,3}(#{1,6})\s/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const BULLET = /^(\s*)([-*+]|(\d{1,9})[.)])\s+(.*)$/;
// Sticky and bounded: matched where the reader stands, never against a copy of
// the rest of the text, so a page of unmatched brackets stays fast.
const LINK = /\[([^\]\n]{1,500})\]\(([^)\s]{1,2000})(?:\s+"[^"\n]{0,500}")?\)/y;

function tableDivider(line: string): boolean {
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|')) text = text.slice(0, -1);
  // Separate cells before matching, so optional outer pipes and whitespace
  // cannot make adjacent unbounded matches backtrack over the same spaces.
  return text.split('|').every((cell) => /^:?-{2,}:?$/.test(cell.trim()));
}

/**
 * A heading's level and title, without the closing run of #s. Read by hand: the
 * one-regex form backtracked on a long run of spaces (13 seconds for 4,000), and
 * a skill's text is written by whoever wrote the skill.
 */
function headingOf(line: string): { level: 1 | 2 | 3 | 4 | 5 | 6; text: string } | null {
  const open = HEADING_OPEN.exec(line);
  if (!open) return null;
  let text = line.slice(open[0].length).trim();
  let end = text.length;
  while (end > 0 && text[end - 1] === '#') end--;
  // Closing #s count only after a space ("# C#" keeps its #), or when they are all there is.
  if (end === 0) text = '';
  else if (end < text.length && /\s/.test(text[end - 1] as string)) text = text.slice(0, end).trimEnd();
  return { level: (open[1] as string).length as 1 | 2 | 3 | 4 | 5 | 6, text };
}

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  return blocks(lines);
}

function blocks(lines: string[], depth = 0): Block[] {
  // A skill can nest quotes arbitrarily. Past this, keep the remaining syntax
  // as text instead of building a tree that can overflow React's stack too.
  if (depth >= 32) return [{ t: 'paragraph', v: [{ t: 'text', v: lines.join('\n') }] }];
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (!line.trim()) { i++; continue; }

    const fence = FENCE.exec(line);
    if (fence) {
      const mark = fence[2] as string;
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] as string).trimStart().startsWith(mark)) body.push(lines[i++] as string);
      i++;
      out.push({ t: 'code', lang: fence[3] ?? '', v: body.join('\n') });
      continue;
    }
    const heading = headingOf(line);
    if (heading) {
      out.push({ t: 'heading', level: heading.level, v: inline(heading.text) });
      i++;
      continue;
    }
    if (RULE.test(line)) { out.push({ t: 'rule' }); i++; continue; }
    if (/^\s{0,3}>/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i] as string)) quoted.push((lines[i++] as string).replace(/^\s{0,3}>\s?/, ''));
      out.push({ t: 'quote', v: blocks(quoted, depth + 1) });
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && tableDivider(lines[i + 1] as string)) {
      const head = cells(line);
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && (lines[i] as string).includes('|') && (lines[i] as string).trim()) rows.push(cells(lines[i++] as string));
      out.push({ t: 'table', head, rows });
      continue;
    }
    if (/^\s{4,}\S/.test(line) && !BULLET.test(line)) {
      const body: string[] = [];
      while (i < lines.length && (/^\s{4,}/.test(lines[i] as string) || !(lines[i] as string).trim())) body.push((lines[i++] as string).replace(/^\s{4}/, ''));
      out.push({ t: 'code', lang: '', v: body.join('\n').replace(/\n+$/, '') });
      continue;
    }
    const bullet = BULLET.exec(line);
    if (bullet) {
      const ordered = bullet[3] !== undefined;
      const start = ordered ? Number(bullet[3]) : 1;
      const items: ListItem[] = [];
      const base = (bullet[1] as string).length;
      while (i < lines.length) {
        const current = lines[i] as string;
        const m = BULLET.exec(current);
        // A top-level item of the other kind starts a new list.
        if (m && items.length && (m[1] as string).length <= base && (m[3] !== undefined) !== ordered) break;
        if (m) {
          let text = m[4] as string;
          let task: boolean | null = null;
          const box = /^\[([ xX])\]\s+(.*)$/.exec(text);
          if (box) { task = box[1] !== ' '; text = box[2] as string; }
          items.push({ depth: Math.max(0, Math.min(4, Math.floor(((m[1] as string).length - base) / 2))), task, v: inline(text) });
          i++;
          continue;
        }
        // A wrapped line continues the item above it; a blank line or a new block ends the list.
        if (current.trim() && /^\s+\S/.test(current) && items.length) {
          const last = items[items.length - 1] as ListItem;
          last.v.push({ t: 'text', v: ' ' });
          for (const span of inline(current.trim())) last.v.push(span);
          i++;
          continue;
        }
        if (!current.trim() && BULLET.test(lines[i + 1] ?? '')) { i++; continue; }
        break;
      }
      out.push({ t: 'list', ordered, start, items });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length) {
      const current = lines[i] as string;
      if (!current.trim() || FENCE.test(current) || HEADING_OPEN.test(current) || /^\s{0,3}>/.test(current) || BULLET.test(current) || RULE.test(current)) break;
      para.push(current.trim());
      i++;
    }
    if (!para.length) { para.push(line.trim()); i++; }
    out.push({ t: 'paragraph', v: inline(para.join(' ')) });
  }
  return out;
}

function cells(line: string): Inline[][] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split(/(?<!\\)\|/).map((c) => inline(c.trim().replace(/\\\|/g, '|')));
}

/** Inline spans: `code`, **strong**, *em* or _em_, and [text](href). Everything else is text. */
export function inline(text: string): Inline[] {
  const out: Inline[] = [];
  // Index complete runs once. Re-scanning an unmatched run at each character
  // made a 400 KB paragraph take tens of seconds; exact lengths also prevent
  // a longer run from prematurely closing a code span.
  const ticks = new Map<number, number[]>();
  for (const match of text.matchAll(/`+/g)) {
    const positions = ticks.get(match[0].length) ?? [];
    positions.push(match.index);
    ticks.set(match[0].length, positions);
  }
  let buffer = '';
  const flush = (): void => { if (buffer) { out.push({ t: 'text', v: buffer }); buffer = ''; } };
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === '\\' && i + 1 < text.length && /[\\`*_[\]()#+\-.!|<>]/.test(text[i + 1] as string)) {
      buffer += text[i + 1];
      i += 2;
      continue;
    }
    if (ch === '`') {
      let end = i + 1;
      while (text[end] === '`') end++;
      const length = end - i;
      const positions = ticks.get(length) ?? [];
      let low = 0;
      let high = positions.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if ((positions[mid] as number) < end) low = mid + 1; else high = mid;
      }
      const close = positions[low];
      if (close !== undefined) {
        flush();
        out.push({ t: 'code', v: text.slice(end, close).trim() || text.slice(end, close) });
        i = close + length;
      } else {
        buffer += text.slice(i, end);
        i = end;
      }
      continue;
    }
    if ((ch === '*' || ch === '_') && text[i + 1] === ch) {
      const close = text.indexOf(ch + ch, i + 2);
      if (close > i + 2) {
        flush();
        out.push({ t: 'strong', v: inline(text.slice(i + 2, close)) });
        i = close + 2;
        continue;
      }
    }
    if ((ch === '*' || ch === '_') && text[i + 1] !== ' ' && text[i + 1] !== undefined) {
      // `_` only opens emphasis at a word boundary, so snake_case stays as written.
      const opens = ch === '*' || i === 0 || /[\s(]/.test(text[i - 1] as string);
      const close = text.indexOf(ch, i + 1);
      const closes = close > i + 1 && text[close - 1] !== ' ' && (ch === '*' || close + 1 >= text.length || /[\s.,;:!?)]/.test(text[close + 1] as string));
      if (opens && closes) {
        flush();
        out.push({ t: 'em', v: inline(text.slice(i + 1, close)) });
        i = close + 1;
        continue;
      }
    }
    if (ch === '[') {
      LINK.lastIndex = i;
      const m = LINK.exec(text);
      if (m) {
        flush();
        out.push({ t: 'link', v: inline(m[1] as string), href: m[2] as string });
        i += m[0].length;
        continue;
      }
    }
    buffer += ch;
    i++;
  }
  flush();
  return out;
}
