/**
 * Did every ask get answered: splitting one operator message into the asks it
 * contains.
 *
 * The attention queue says a turn *finished*. It cannot say "finished two of
 * the three things you asked for", because nothing ever wrote the three things
 * down. This module does, deterministically and with no model call
 * (c-claude-helper-tools.md §1.12, after hstack's prompt-items): a message is
 * split into items, each item names the files and commands it mentions, and
 * the main process later lays recorded evidence beside each one.
 *
 * What counts as a separate item, and nothing else:
 *   · each numbered or bulleted line (`1.`, `2)`, `(3)`, `-`, `*`, `•`), with
 *     its indented continuation lines;
 *   · each sentence ending in `?`;
 *   · clauses joined by "and also", "then" (as a clause opener, not the "then"
 *     of an if) or ";".
 *
 * Ordinary sentences ending in `.` are deliberately not split apart. "Fix the
 * login bug. It started after the upgrade." is one ask with a reason attached,
 * and a checklist that made the reason a second item to tick would be asking
 * the operator to confirm something they never requested.
 *
 * A message that yields fewer than two items gets no checklist at all: one ask
 * is the whole message, and the turn's own outcome already answers it.
 *
 * Code is never split. Fenced blocks are dropped from item text and inline
 * backtick spans are masked before any splitting, so `a; b` inside a span
 * stays one command.
 */

export type AskItemKind = 'list' | 'question' | 'clause';

export type AskItem = {
  /** 0-based position in the message. */
  index: number;
  text: string;
  kind: AskItemKind;
  /** Path-like tokens the item names, in the order they appear. */
  files: string[];
  /** Commands the item names: backticked command lines, or a recognised program and its words. */
  commands: string[];
};

/** A message longer than this is a paste; only its head is read. */
export const MAX_MESSAGE_CHARS = 20_000;
/** More asks than this in one message is a document, not a request list. */
export const MAX_ITEMS = 24;
const MAX_ITEM_CHARS = 400;
const MAX_REFS = 12;

/** The fewest items that earn a checklist. */
export const CHECKLIST_MIN_ITEMS = 2;

const LIST_LINE = /^\s{0,3}(?:(\d{1,3})[.)]|\((\d{1,3})\)|[-*•])\s+(.*)$/;
const FENCE = /^\s*(```|~~~)/;

/** Abbreviations whose period does not end a sentence. */
const ABBREVIATIONS = /\b(?:e\.g|i\.e|etc|vs|cf|approx|incl|min|max|no|fig|mr|mrs|ms|dr)\.$/i;

/**
 * Words that open a conditional; a "then" after one of these belongs to the
 * condition ("if the build fails then retry") and is not a second ask.
 */
const CONDITIONAL_OPENER = /^(?:if|when|whenever|once|after|before|unless|until|while|as soon as)\b/i;

/** Programs whose unquoted mention reads as a command to run. */
const COMMAND_PROGRAMS = [
  'npm', 'npx', 'pnpm', 'yarn', 'bun', 'node', 'deno', 'git', 'make', 'cargo', 'go', 'pytest', 'python', 'python3',
  'pip', 'uv', 'poetry', 'tox', 'jest', 'vitest', 'tsc', 'eslint', 'prettier', 'composer', 'php', 'phpunit',
  'drush', 'bundle', 'rake', 'rspec', 'mvn', 'gradle', 'dotnet', 'swift', 'xcodebuild', 'docker', 'kubectl',
  'terraform', 'gh', 'ruff', 'mypy', 'black', 'rustc', 'just', 'ddev', 'lando',
] as const;
const PROGRAM_SET = new Set<string>(COMMAND_PROGRAMS);

/** File extensions that make a bare word a file mention even with no slash in it. */
const FILE_EXTENSIONS = /\.(?:[cm]?[jt]sx?|json|jsonc|ya?ml|toml|md|mdx|txt|css|scss|less|html?|vue|svelte|py|rb|go|rs|java|kt|swift|cs|php|module|inc|install|theme|twig|sh|zsh|bash|sql|graphql|gql|proto|lock|env|ini|cfg|conf|xml|gradle|c|cc|cpp|h|hpp|m|mm|ex|exs|erl|dart|lua|r|scala|tf|dockerfile)$/i;

/**
 * Split one message into its asks. Pure and deterministic: the same text
 * always yields the same items.
 */
export function splitAsks(message: string): AskItem[] {
  if (typeof message !== 'string') return [];
  const text = message.slice(0, MAX_MESSAGE_CHARS).replace(/\r\n?/g, '\n');
  const chunks: { text: string; kind: AskItemKind | 'prose' }[] = [];

  let inFence = false;
  let list: string[] | null = null;
  let prose: string[] = [];
  const flushProse = () => {
    const joined = prose.join(' ').trim();
    if (joined) chunks.push({ text: joined, kind: 'prose' });
    prose = [];
  };
  const flushList = () => {
    if (list) {
      const joined = list.join(' ').trim();
      if (joined) chunks.push({ text: joined, kind: 'list' });
    }
    list = null;
  };

  for (const line of text.split('\n')) {
    if (FENCE.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = LIST_LINE.exec(line);
    if (m) {
      // "Before the release:" introduces the list; it is not an ask of its own.
      if (!list && /:\s*$/.test(prose.join(' '))) prose = [];
      flushProse();
      flushList();
      list = [m[3]];
      continue;
    }
    if (!line.trim()) { flushList(); flushProse(); continue; }
    // An indented line under a list item continues it; anything else ends the list.
    if (list && /^\s{2,}\S/.test(line)) { list.push(line.trim()); continue; }
    flushList();
    prose.push(line.trim());
  }
  flushList();
  flushProse();

  const raw: { text: string; kind: AskItemKind }[] = [];
  for (const chunk of chunks) {
    if (chunk.kind === 'list') { raw.push({ text: chunk.text, kind: 'list' }); continue; }
    for (const piece of splitProse(chunk.text)) raw.push(piece);
  }

  const items: AskItem[] = [];
  for (const r of raw) {
    const clean = tidy(r.text);
    if (!meaningful(clean)) continue;
    if (items.length >= MAX_ITEMS) break;
    items.push({
      index: items.length,
      text: clean.length > MAX_ITEM_CHARS ? `${clean.slice(0, MAX_ITEM_CHARS - 1)}…` : clean,
      kind: r.kind,
      files: filesIn(clean),
      commands: commandsIn(clean),
    });
  }
  return items;
}

/** Whether a split earns a checklist on screen. One ask is the message itself. */
export function earnsChecklist(items: readonly AskItem[]): boolean {
  return items.length >= CHECKLIST_MIN_ITEMS;
}

/* ── prose ───────────────────────────────────────────────────────────── */

/**
 * Questions come out one per sentence; the sentences between questions are
 * kept together and then split on the clause connectors.
 */
function splitProse(textIn: string): { text: string; kind: AskItemKind }[] {
  const { masked, restore } = maskCode(textIn);
  const sentences = sentencesOf(masked);
  const out: { text: string; kind: AskItemKind }[] = [];
  let run: string[] = [];
  const flushRun = () => {
    if (!run.length) return;
    for (const clause of clausesOf(run.join(' '))) out.push({ text: restore(clause), kind: 'clause' });
    run = [];
  };
  for (const s of sentences) {
    if (/\?\s*$/.test(s)) {
      flushRun();
      out.push({ text: restore(s), kind: 'question' });
    } else {
      run.push(s);
    }
  }
  flushRun();
  return out;
}

function sentencesOf(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== '.' && ch !== '?' && ch !== '!') continue;
    // Runs like "?!" or "..." end together.
    let j = i;
    while (j + 1 < text.length && /[.?!]/.test(text[j + 1])) j++;
    const next = text[j + 1];
    if (next !== undefined && !/\s/.test(next)) { i = j; continue; }
    const candidate = text.slice(start, j + 1);
    if (ch === '.' && ABBREVIATIONS.test(candidate.trimEnd())) { i = j; continue; }
    out.push(candidate.trim());
    start = j + 1;
    i = j;
  }
  const rest = text.slice(start).trim();
  if (rest) out.push(rest);
  return out.filter(Boolean);
}

/**
 * ";", "and also", and a clause-opening "then". Each resulting piece must
 * still read as a clause of its own (two words or more); a piece that does
 * not is folded back into the one before it, so "tidy up; thanks" never
 * becomes an ask called "thanks".
 */
const CONNECTOR = /\s*;\s*|,?\s+and also\s+|(?:,|\s+and)\s+then\s+|(?<=[.!])\s+then\s*,?\s+/gi;

function clausesOf(text: string): string[] {
  // `open` marks a conditional still waiting for its consequence: "if the build
  // fails" takes the next piece as its own, once, and then closes.
  const pieces: { text: string; open: boolean }[] = [];
  let last = 0;
  let separator = '';
  const push = (part: string) => {
    const t = part.trim();
    if (!t) return;
    const prev = pieces[pieces.length - 1];
    // Folded back with the connector it was split on, so the text reads as written.
    if (prev !== undefined && (wordCount(t) < 2 || prev.open)) {
      prev.text = `${prev.text}${separator}${t}`;
      prev.open = false;
    } else {
      pieces.push({ text: t, open: CONDITIONAL_OPENER.test(t) && !/[.!]$/.test(t) });
    }
  };
  for (const m of text.matchAll(CONNECTOR)) {
    push(text.slice(last, m.index));
    separator = m[0];
    last = (m.index ?? 0) + m[0].length;
  }
  push(text.slice(last));
  // A sentence that opens with "Then" is a new clause even without a comma before it.
  return pieces.map((p) => {
    const lead = /^then\s*,?\s+(.*)$/i.exec(p.text);
    return lead ? lead[1] : p.text;
  });
}

function wordCount(t: string): number {
  return t.split(/\s+/).filter((w) => /[A-Za-z0-9`\u0000]/.test(w)).length;
}

/** Backtick spans, replaced with placeholders so no splitter looks inside them. */
function maskCode(text: string): { masked: string; restore: (t: string) => string } {
  const spans: string[] = [];
  const masked = text.replace(/`[^`\n]+`/g, (span) => {
    spans.push(span);
    return `\u0000${spans.length - 1}\u0000`;
  });
  return { masked, restore: (t) => t.replace(/\u0000(\d+)\u0000/g, (_, n: string) => spans[Number(n)] ?? '') };
}

function tidy(t: string): string {
  return t.replace(/\s+/g, ' ').replace(/^(?:(?:also|and|then|plus)\s*,?\s+)+/i, '').replace(/^[,;:\s]+/, '').trim();
}

/** Something a person could tick: at least one word of three letters or a named file or command. */
function meaningful(t: string): boolean {
  if (!t) return false;
  if (/`[^`]+`/.test(t)) return true;
  return /[A-Za-z]{3,}/.test(t);
}

/* ── what an item names ──────────────────────────────────────────────── */

/**
 * Path-like tokens: anything with a slash and a letter in it, or a bare word
 * ending in a known source extension. URLs are not files.
 */
export function filesIn(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const t = raw.replace(/^[("'[{<]+|[)"'\]}>,.:;!?]+$/g, '').replace(/:(\d+)(?::\d+)?$/, '');
    if (!t || t.length > 300 || seen.has(t)) return;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t) || /^www\./i.test(t)) return;
    if (/^\d+(?:\/\d+)+$/.test(t)) return; // a date or a fraction
    const slashy = t.includes('/') && /[A-Za-z]/.test(t) && !/\s/.test(t);
    const extensioned = FILE_EXTENSIONS.test(t) && /^[\w.@~/-]+$/.test(t) && !/^\.+$/.test(t);
    if (!slashy && !extensioned) return;
    // "and/or", "yes/no", "on/off" are words, not paths.
    if (slashy && !extensioned && /^[a-z]{1,6}\/[a-z]{1,6}$/i.test(t) && !t.startsWith('.')) return;
    seen.add(t);
    out.push(t);
  };
  for (const span of text.match(/`[^`]+`/g) ?? []) {
    const inner = span.slice(1, -1).trim();
    if (!/\s/.test(inner)) add(inner);
    else for (const word of inner.split(/\s+/)) if (word.includes('/') || FILE_EXTENSIONS.test(word)) add(word);
  }
  const bare = text.replace(/`[^`]+`/g, ' ');
  for (const word of bare.split(/\s+/)) add(word);
  return out.slice(0, MAX_REFS);
}

/**
 * Commands: a backticked span whose first word is a program Wanigan
 * recognises, or an unquoted program name followed by its subcommand words
 * ("run npm test", "git rebase main"). Only the words up to punctuation or a
 * connector are kept, so "run npm test and fix what fails" names `npm test`.
 */
export function commandsIn(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (c: string) => {
    const t = c.trim().replace(/[.,;:!?]+$/, '');
    if (!t || seen.has(t) || t.length > 200) return;
    seen.add(t);
    out.push(t);
  };
  for (const span of text.match(/`[^`]+`/g) ?? []) {
    const inner = span.slice(1, -1).trim();
    const first = inner.split(/\s+/)[0] ?? '';
    if (PROGRAM_SET.has(first) || /^\.\/[\w.-]+$/.test(first)) { add(inner); continue; }
    // `cd app && npm test` names the command after the cd.
    for (const segment of inner.split(/\s*(?:;|&&|\|\|)\s*/)) {
      if (PROGRAM_SET.has(segment.split(/\s+/)[0] ?? '')) add(segment);
    }
  }
  const bare = text.replace(/`[^`]+`/g, ' ');
  const words = bare.split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    const w = words[i].replace(/^[("']+/, '');
    if (!PROGRAM_SET.has(w)) continue;
    const taken = [w];
    for (let j = i + 1; j < words.length && taken.length < 5; j++) {
      const next = words[j];
      if (/^(?:and|then|to|so|but|or|if|when|before|after|until|in|on|for|with|again)$/i.test(next)) break;
      if (!/^[\w@.:/=-]+[.,;:!?]?$/.test(next)) break;
      taken.push(next);
      if (/[.,;:!?]$/.test(next)) break;
    }
    // A program name alone ("check git") is a noun, not a command.
    if (taken.length >= 2 || w === 'pytest' || w === 'make' || w === 'tsc') add(taken.join(' '));
  }
  return out.slice(0, MAX_REFS);
}

/* ── evidence ────────────────────────────────────────────────────────── */

/* The stored shape the main process returns and the Timeline reads. */
export type AskSource = 'composer' | 'phone';

export type AskTurnState =
  /** No UserPromptSubmit has arrived for this send yet. */
  | 'waiting'
  /** The prompt arrived and the turn has not ended. */
  | 'running'
  /** A Stop (or StopFailure) closed the turn: the checklist is due. */
  | 'ended'
  /** No prompt ever followed the send, or this session records no hook events at all. */
  | 'unobserved';

export type StoredAskItem = AskItem & { id: number; tickedAt: number | null; hints: AskHints | null };

export type AskMessage = {
  id: number;
  sessionId: string;
  sentAt: number;
  source: AskSource;
  state: AskTurnState;
  promptAt: number | null;
  stopAt: number | null;
  stopFailed: boolean;
  items: StoredAskItem[];
};


/** A Bash call the session recorded, as the evidence matcher reads it. */
export type RecordedCommand = { eventId: number; at: number; command: string; ok: boolean | null; exitCode: number | null };

export type AskFileHint = { path: string; touched: boolean; via: string | null };
export type AskCommandHint = {
  command: string;
  ran: boolean;
  /** The newest matching run, when there was one. */
  latest: { eventId: number; at: number; ok: boolean | null; exitCode: number | null; text: string } | null;
  runs: number;
};
export type AskHints = { files: AskFileHint[]; commands: AskCommandHint[] };

/**
 * Evidence hints for one item: which of the files it names were touched, and
 * which of the commands it names ran, with the exit code of the newest run.
 *
 * A hint, never a verdict. A file that was touched was not necessarily
 * changed the way the item asked; a command that exited 0 may have run the
 * wrong suite. The operator's tick is the answer; these are what to look at.
 *
 * File matching is by suffix on path segments, so `auth/login.ts` in an item
 * matches `/repo/src/auth/login.ts` in the record and `login.ts` matches any
 * file of that name. Command matching is by the item's command appearing at a
 * word boundary in the recorded command line, so `npm test` matches
 * `cd app && npm test -- --watch=false`.
 */
export function hintsFor(item: Pick<AskItem, 'files' | 'commands'>, touched: readonly { path: string; via: string }[], commands: readonly RecordedCommand[]): AskHints {
  const files = item.files.map((f) => {
    const hit = touched.find((t) => pathMatches(f, t.path));
    return { path: f, touched: !!hit, via: hit?.via ?? null };
  });
  const cmds = item.commands.map((c) => {
    const needle = normaliseCommand(c);
    const matches = commands.filter((r) => commandMatches(needle, normaliseCommand(r.command)));
    const latest = matches.length ? matches.reduce((a, b) => (b.at > a.at || (b.at === a.at && b.eventId > a.eventId) ? b : a)) : null;
    return {
      command: c,
      ran: matches.length > 0,
      latest: latest ? { eventId: latest.eventId, at: latest.at, ok: latest.ok, exitCode: latest.exitCode, text: latest.command } : null,
      runs: matches.length,
    };
  });
  return { files, commands: cmds };
}

export function pathMatches(mentioned: string, recorded: string): boolean {
  const want = mentioned.replace(/^\.\//, '').replace(/\/+$/, '');
  const have = recorded.replace(/\/+$/, '');
  if (!want || !have) return false;
  if (have === want) return true;
  return have.endsWith(`/${want}`);
}

function normaliseCommand(c: string): string {
  return c.replace(/\s+/g, ' ').trim();
}

function commandMatches(needle: string, hay: string): boolean {
  if (!needle) return false;
  const at = hay.indexOf(needle);
  if (at < 0) return false;
  const before = at === 0 ? ' ' : hay[at - 1];
  const after = hay[at + needle.length] ?? ' ';
  return /[\s;&|(]/.test(before) && /[\s;&|)]/.test(after);
}

/**
 * The drafted message for the unticked items: plain, numbered, and naming
 * each item as the operator wrote it. Never sent by this module or anything
 * that calls it on its own; the composer puts it in front of a person.
 */
export function draftFollowUp(unticked: readonly Pick<AskItem, 'text'>[]): string {
  if (!unticked.length) return '';
  if (unticked.length === 1) return `One thing from my last message still looks open: ${unticked[0].text}`;
  const lines = unticked.map((item, i) => `${i + 1}. ${item.text}`);
  return `These items from my last message still look open:\n${lines.join('\n')}`;
}
