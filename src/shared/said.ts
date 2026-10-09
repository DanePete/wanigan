// Finding what agents said: the text of a session's recorded terminal output
// with its escape sequences removed, matched without regard to case, and a
// short snippet around each match. Pure, so the core's search and its tests
// share one reading of a terminal's bytes.
import type { Provider, SessionState } from './model.ts';

/** Shorter queries match nearly everything a terminal ever printed. */
export const SAID_MIN_QUERY = 3;
export const SAID_MAX_QUERY = 200;

/** The bounds of one search. Every one is said when it cut the results. */
export interface SaidCaps {
  /** The newest bytes of each session's recorded output that are read. */
  bytesPerFile: number;
  /** Bytes read across every session, in all. */
  totalBytes: number;
  /** The most recent sessions looked at. */
  sessions: number;
  /** Matches shown from one session. */
  perSession: number;
  /** Time spent reading before stopping. */
  timeMs: number;
}

export const SAID_CAPS: SaidCaps = {
  bytesPerFile: 1024 * 1024,
  totalBytes: 16 * 1024 * 1024,
  sessions: 200,
  perSession: 3,
  timeMs: 600,
};

export interface SaidSnippet {
  /** Text before the match, on one line; starts with … when cut. */
  before: string;
  /** The words that matched, as they were printed. */
  match: string;
  /** Text after the match; ends with … when cut. */
  after: string;
}

export interface SaidHit {
  sessionId: string;
  sessionTitle: string;
  provider: Provider;
  state: SessionState;
  projectId: string;
  projectKey: string;
  projectName: string;
  /** Where it was found: the session's title, or what the session printed. */
  in: 'title' | 'output';
  snippet: SaidSnippet;
  /**
   * Terminal output is recorded without times, so when a line was said is not
   * known. It was said after the session started and by its last output.
   */
  startedAt: number;
  /** When the session last printed anything, from its record; null when nothing is recorded. */
  lastOutputAt: number | null;
  endedAt: number | null;
}

/** Why a search may not show everything that was said. */
export type SaidCut =
  /** More matches than were asked for. */
  | 'results'
  /** Time ran out before every session was read. */
  | 'time'
  /** A session's output was longer than what was read: only its newest part was searched. */
  | 'bytes'
  /** More sessions than are looked at: only the most recent were searched. */
  | 'sessions';

export interface SaidSearch {
  hits: SaidHit[];
  /** Sessions looked at. */
  searched: number;
  /** Empty when nothing was left out. */
  cut: SaidCut[];
}

const CSI_LINE = new Set(['A', 'B', 'E', 'F', 'H', 'f', 'd']);
const CSI_SPACE = new Set(['C', 'G', '`', 'I']);
// One pass over the escape sequences a terminal program writes: OSC (titles,
// hyperlinks, notifications), DCS/SOS/PM/APC strings, CSI (colour, cursor
// movement, erasing), the 8-bit CSI, and the short two- and three-byte escapes.
// Strings are bounded, so one never left open does not swallow the rest.
const SEQUENCE = /\x1b\][^\x07\x1b]{0,4096}(?:\x07|\x1b\\)?|\x1b[P^_X][^\x1b]{0,4096}(?:\x1b\\)?|(?:\x1b\[|\x9b)[0-?]*[ -/]*([@-~])|\x1b[ -/]*[0-~]/g;

/**
 * What a person would read in a terminal's raw output, near enough to search:
 * escape sequences removed, a cursor move to another line read as a line break
 * and one along the line as a space (so words drawn apart stay apart), line
 * endings as \n, box drawing and spinners as spaces, other controls dropped.
 */
export function plainText(raw: string): string {
  return raw
    .replace(SEQUENCE, (_all, final: string | undefined) => (final === undefined ? '' : CSI_LINE.has(final) ? '\n' : CSI_SPACE.has(final) ? ' ' : ''))
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/[─-▟⠀-⣿]/g, ' ')
    .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, '');
}

/** A query as a pattern: its words in order, any run of whitespace between them, any case. Null when there are no words. */
export function saidPattern(query: string): RegExp | null {
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  return new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'), 'giu');
}

const BEFORE = 40;
const AFTER = 110;
/** How many of the newest matches are looked at for distinct snippets. */
const RECENT = 400;

const squash = (s: string): string => s.replace(/\s+/g, ' ');

/** The text around one match, on one line, cut at word edges where it can be. */
export function snippetAt(text: string, start: number, end: number): SaidSnippet {
  let from = Math.max(0, start - BEFORE);
  let to = Math.min(text.length, end + AFTER);
  if (from > 0) {
    const space = text.slice(from, start).search(/\s/);
    if (space >= 0 && space < 16) from += space + 1;
  }
  if (to < text.length) {
    const tail = text.slice(end, to);
    const space = tail.search(/\s\S*$/);
    if (space > AFTER - 24) to = end + space;
  }
  const before = squash(text.slice(from, start)).trimStart();
  const after = squash(text.slice(end, to)).trimEnd();
  return {
    before: `${from > 0 ? '…' : ''}${before}`,
    match: squash(text.slice(start, end)),
    after: `${after}${to < text.length ? '…' : ''}`,
  };
}

/**
 * Where a pattern matched in plain text, newest first, at most `max`, without
 * repeats: a terminal redraws the same line many times, and one copy says it.
 */
export function findSaid(text: string, pattern: RegExp, max: number): SaidSnippet[] {
  const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  const recent: [number, number][] = [];
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (!m[0]) { re.lastIndex++; continue; }
    recent.push([m.index, m.index + m[0].length]);
    if (recent.length > RECENT) recent.shift();
  }
  const out: SaidSnippet[] = [];
  const seen = new Set<string>();
  for (let i = recent.length - 1; i >= 0 && out.length < max; i--) {
    const [start, end] = recent[i] as [number, number];
    // The line it was on is what repeats when a line is drawn again.
    const line = squash(text.slice(Math.max(text.lastIndexOf('\n', start - 1) + 1, start - 200), lineEnd(text, end))).trim().toLowerCase();
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(snippetAt(text, start, end));
  }
  return out;
}

function lineEnd(text: string, from: number): number {
  const at = text.indexOf('\n', from);
  return Math.min(at < 0 ? text.length : at, from + 200);
}

/** What to tell the owner about a search that was cut, or null when it was whole. */
export function saidCutText(cut: readonly SaidCut[], caps: SaidCaps = SAID_CAPS): string | null {
  if (!cut.length) return null;
  const parts: string[] = [];
  if (cut.includes('results')) parts.push('There are more matches than shown; type more to narrow them.');
  if (cut.includes('sessions')) parts.push(`Only the ${caps.sessions} most recent sessions were searched.`);
  if (cut.includes('time')) parts.push('The search stopped to stay quick, so older sessions were not read.');
  if (cut.includes('bytes')) parts.push(`Only the newest ${megabytes(caps.bytesPerFile)} of a session’s output is searched.`);
  return parts.join(' ');
}

const megabytes = (bytes: number): string => (bytes >= 1024 * 1024 ? `${Math.round(bytes / (1024 * 1024))} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
