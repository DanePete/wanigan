/**
 * A shell command line, read the way a POSIX shell would split it — enough of
 * it, at least, to say which programs a line runs and with what arguments.
 *
 * The policy gate used to split a command on `;`, `&&`, `|` and friends with a
 * regular expression and then look at the first word of each piece. That reads
 * `git log --grep="a|b"` as two commands, and it reads `bash -c "rm -rf ~"`,
 * `env X=1 sudo reboot`, `time rm -rf ~` and `echo $(rm -rf ~)` as one harmless
 * one each, because the word it looked at was `bash`, `env`, `time` or `echo`.
 * Every one of those passed the gate.
 *
 * This is not a shell. It does not expand variables, globs, aliases or
 * functions, and it never will: what a variable holds at run time is not
 * something a reader of the text can know, and guessing would be a lie in
 * either direction. A word that still depends on expansion is marked
 * `dynamic`, and callers treat it as unknown rather than as safe. What it does
 * do is the part a shell does before it runs anything — quoting, escaping,
 * operators, redirections, command and process substitution, and the wrapper
 * programs (`env`, `sudo`, `nohup`, `xargs`, `bash -c`, …) whose job is to run
 * the command named after them.
 *
 * Pure, dependency-free and bounded: a line nested deeper than MAX_DEPTH, or
 * split into more than MAX_SEGMENTS commands, stops being read and says so in
 * `notes`, which the gate surfaces rather than hiding.
 */

export type ShellWord = {
  /** The word with quoting and escapes removed. Unexpanded `$…` stays literal. */
  text: string;
  /** Any part of it was quoted. */
  quoted: boolean;
  /** It still depends on expansion — a variable, `$(…)`, backticks, `$((…))`. */
  dynamic: boolean;
};

export type ShellRedirect = {
  /** `>`, `>>`, `<`, `&>`, `&>>`, `>|`, `<<`, `<<<`, `>&`, `<&`. */
  op: string;
  /** The file-descriptor number written before the operator, when there was one. */
  fd: string | null;
  target: ShellWord;
};

export type SegmentOrigin =
  /** A command written at the top of the line. */
  | 'command'
  /** The string handed to `bash -c`, `sh -c`, `zsh -c` or `eval`. */
  | 'wrapper'
  /** The inside of `$(…)` or backticks. */
  | 'substitution'
  /** The inside of `<(…)` or `>(…)`. */
  | 'process-substitution';

export type ShellSegment = {
  /** The program and its arguments, after wrappers and assignments are peeled off. */
  argv: ShellWord[];
  /** `NAME=value` words written before the program, including `env`'s. */
  assignments: string[];
  redirects: ShellRedirect[];
  /** The wrappers peeled off, outermost first: `sudo`, `env`, `bash -c`, `xargs`… */
  via: string[];
  origin: SegmentOrigin;
  depth: number;
  /** Written after a `|`, so its input is the previous command's output. */
  pipedFrom: boolean;
  /** Followed by a `|`, so its output feeds the next command. */
  pipedTo: boolean;
  /** The words as a person would read them back, for a trace. */
  text: string;
  /**
   * Index, in the flat segment list, of the command whose words this one was
   * found inside — the `bash -c` that carried it or the command around a
   * substitution. Null at the top level.
   */
  parent: number | null;
};

export type ParsedShell = {
  segments: ShellSegment[];
  /** Everything the reader could not follow, in words. Empty when it read the whole line. */
  notes: string[];
};

export const MAX_DEPTH = 4;
export const MAX_SEGMENTS = 200;

/* ── lexing ──────────────────────────────────────────────────────────── */

type Sub = { kind: 'command' | 'process'; text: string };

type Token =
  | { t: 'word'; word: ShellWord; subs: Sub[] }
  | { t: 'op'; op: string }
  | { t: 'redir'; op: string; fd: string | null };

const OPERATORS = ['&&', '||', '|&', ';;', '|', ';', '&', '\n', '(', ')'];
const REDIRECTS = ['&>>', '&>', '>>', '>|', '>&', '<<<', '<<-', '<<', '<&', '<>', '>', '<'];

/**
 * Reads balanced text from `open` onward, honouring quotes, and returns the
 * index just past the matching `close`. Used for `$(…)`, `<(…)` and `$((…))`,
 * whose insides may themselves contain quotes and parentheses.
 */
function balanced(src: string, from: number, open: string, close: string): number {
  let depth = 1;
  let i = from;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    if (c === '"') {
      i += 1;
      while (i < src.length && src[i] !== '"') i += src[i] === '\\' ? 2 : 1;
      i += 1;
      continue;
    }
    if (c === open) depth += 1;
    else if (c === close) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return src.length;
}

function lex(src: string, notes: string[]): Token[] {
  const out: Token[] = [];
  let i = 0;
  let text = '';
  let quoted = false;
  let dynamic = false;
  let inWord = false;
  let subs: Sub[] = [];
  const heredocs: string[] = [];

  const flush = () => {
    if (inWord) out.push({ t: 'word', word: { text, quoted, dynamic }, subs });
    text = '';
    quoted = false;
    dynamic = false;
    inWord = false;
    subs = [];
  };

  while (i < src.length) {
    const c = src[i];

    if (c === '\\') {
      // A backslash before a newline joins the lines; before anything else it
      // makes that character literal — which is how `\rm` runs `rm`.
      if (src[i + 1] === '\n') { i += 2; continue; }
      if (i + 1 < src.length) { text += src[i + 1]; inWord = true; quoted = true; }
      i += 2;
      continue;
    }

    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      if (end === -1) {
        notes.push('A single quote is never closed, so the shell would refuse this line; the rest was read as one word.');
        text += src.slice(i + 1);
        inWord = true; quoted = true;
        i = src.length;
        continue;
      }
      text += src.slice(i + 1, end);
      inWord = true; quoted = true;
      i = end + 1;
      continue;
    }

    if (c === '"') {
      inWord = true; quoted = true;
      i += 1;
      let closed = false;
      while (i < src.length) {
        const d = src[i];
        if (d === '"') { closed = true; i += 1; break; }
        if (d === '\\' && i + 1 < src.length && '"\\$`\n'.includes(src[i + 1])) {
          if (src[i + 1] !== '\n') text += src[i + 1];
          i += 2;
          continue;
        }
        if (d === '$' && src[i + 1] === '(') {
          const arithmetic = src[i + 2] === '(';
          const end = arithmetic ? balanced(src, i + 3, '(', ')') + 1 : balanced(src, i + 2, '(', ')');
          if (!arithmetic) subs.push({ kind: 'command', text: src.slice(i + 2, end - 1) });
          text += src.slice(i, end);
          dynamic = true;
          i = end;
          continue;
        }
        if (d === '`') {
          const end = src.indexOf('`', i + 1);
          const stop = end === -1 ? src.length : end;
          subs.push({ kind: 'command', text: src.slice(i + 1, stop) });
          text += src.slice(i, stop + 1);
          dynamic = true;
          i = stop + 1;
          continue;
        }
        if (d === '$' && /[A-Za-z_{@*#?$!0-9-]/.test(src[i + 1] ?? '')) dynamic = true;
        text += d;
        i += 1;
      }
      if (!closed) notes.push('A double quote is never closed, so the shell would refuse this line; the rest was read as one word.');
      continue;
    }

    if (c === '$' && src[i + 1] === '(') {
      const arithmetic = src[i + 2] === '(';
      const end = arithmetic ? balanced(src, i + 3, '(', ')') + 1 : balanced(src, i + 2, '(', ')');
      if (!arithmetic) subs.push({ kind: 'command', text: src.slice(i + 2, end - 1) });
      text += src.slice(i, end);
      inWord = true; dynamic = true;
      i = end;
      continue;
    }
    if (c === '`') {
      const end = src.indexOf('`', i + 1);
      const stop = end === -1 ? src.length : end;
      subs.push({ kind: 'command', text: src.slice(i + 1, stop) });
      text += src.slice(i, stop + 1);
      inWord = true; dynamic = true;
      i = stop + 1;
      continue;
    }
    if ((c === '<' || c === '>') && src[i + 1] === '(') {
      const end = balanced(src, i + 2, '(', ')');
      subs.push({ kind: 'process', text: src.slice(i + 2, end - 1) });
      text += src.slice(i, end);
      inWord = true; dynamic = true;
      i = end;
      continue;
    }
    if (c === '$' && /[A-Za-z_{@*#?$!0-9-]/.test(src[i + 1] ?? '')) {
      dynamic = true;
      text += c;
      inWord = true;
      i += 1;
      continue;
    }

    if (c === '#' && !inWord) {
      const end = src.indexOf('\n', i);
      i = end === -1 ? src.length : end;
      continue;
    }

    if (c === ' ' || c === '\t' || c === '\r') { flush(); i += 1; continue; }

    if (c === '\n') {
      flush();
      out.push({ t: 'op', op: '\n' });
      i += 1;
      // A here-document's body is data for the command above it, not commands.
      while (heredocs.length) {
        const delim = heredocs.shift()!;
        const lines = src.slice(i).split('\n');
        let consumed = 0;
        let found = false;
        for (const line of lines) {
          consumed += line.length + 1;
          if (line.replace(/^\t+/, '') === delim) { found = true; break; }
        }
        i = Math.min(src.length, i + consumed);
        if (!found) notes.push(`A here-document is never closed by ${delim}; the rest of the line was read as its data.`);
      }
      continue;
    }

    // An fd number glued to a redirect operator (`2>`, `1>&2`) belongs to it.
    const fdMatch = !inWord ? null : /^\d+$/.test(text) ? text : null;
    const redir = REDIRECTS.find((r) => src.startsWith(r, i));
    if (redir) {
      const fd = fdMatch && !quoted ? fdMatch : null;
      if (fd) { text = ''; inWord = false; subs = []; } else flush();
      out.push({ t: 'redir', op: redir, fd });
      i += redir.length;
      if (redir === '<<' || redir === '<<-') {
        const m = /^[ \t]*(['"]?)([A-Za-z0-9_.-]+)\1/.exec(src.slice(i));
        if (m) {
          heredocs.push(m[2]);
          out.push({ t: 'word', word: { text: m[2], quoted: Boolean(m[1]), dynamic: false }, subs: [] });
          i += m[0].length;
        }
      }
      continue;
    }

    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (op) {
      flush();
      out.push({ t: 'op', op });
      i += op.length;
      continue;
    }

    text += c;
    inWord = true;
    i += 1;
  }
  flush();
  return out;
}

/* ── wrappers ────────────────────────────────────────────────────────── */

/** Words that open or close shell grammar rather than naming a program. */
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', '!', '{', '}', 'in', 'esac']);

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Options each wrapper takes that consume the following word. */
const WRAPPER_ARG_OPTIONS: Record<string, Set<string>> = {
  env: new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string']),
  sudo: new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-R', '-T', '-U', '--user', '--group', '--host', '--prompt', '--chdir']),
  doas: new Set(['-u', '-C']),
  nice: new Set(['-n', '--adjustment']),
  ionice: new Set(['-c', '-n', '-p', '-P', '-u']),
  time: new Set(['-f', '-o', '--format', '--output']),
  stdbuf: new Set(['-i', '-o', '-e']),
  timeout: new Set(['-s', '-k', '--signal', '--kill-after']),
  xargs: new Set(['-I', '-i', '-n', '-P', '-L', '-l', '-s', '-d', '-E', '-e', '-a', '--arg-file', '--delimiter', '--max-args', '--max-procs', '--replace']),
  exec: new Set(['-a']),
  watch: new Set(['-n', '--interval', '-d']),
  caffeinate: new Set(['-t', '-w']),
  command: new Set([]),
  builtin: new Set([]),
  nohup: new Set([]),
  unbuffer: new Set([]),
  chronic: new Set([]),
};

/** Wrappers that take a positional argument before the command (timeout's duration). */
const WRAPPER_POSITIONAL: Record<string, number> = { timeout: 1 };

function basenameOf(word: string): string {
  const i = word.lastIndexOf('/');
  return i === -1 ? word : word.slice(i + 1);
}

type Peeled = {
  argv: ShellWord[];
  assignments: string[];
  via: string[];
  /** A `bash -c` / `eval` string to parse as commands of its own. */
  inner: string | null;
  innerVia: string | null;
  /** `command -v`, `type`: a lookup that runs nothing. */
  inert: boolean;
};

function peel(words: ShellWord[]): Peeled {
  let argv = words;
  const assignments: string[] = [];
  const via: string[] = [];

  for (let guard = 0; guard < 16; guard++) {
    while (argv.length && !argv[0].quoted && ASSIGNMENT.test(argv[0].text)) {
      assignments.push(argv[0].text);
      argv = argv.slice(1);
    }
    while (argv.length && !argv[0].quoted && KEYWORDS.has(argv[0].text)) argv = argv.slice(1);
    if (!argv.length) break;

    const head = argv[0];
    const name = head.dynamic ? '' : basenameOf(head.text);

    if (name === 'command' && argv[1] && (argv[1].text === '-v' || argv[1].text === '-V')) {
      return { argv, assignments, via, inner: null, innerVia: null, inert: true };
    }

    if (name in WRAPPER_ARG_OPTIONS) {
      const takesArg = WRAPPER_ARG_OPTIONS[name];
      let j = 1;
      let positional = WRAPPER_POSITIONAL[name] ?? 0;
      while (j < argv.length) {
        const w = argv[j].text;
        if (w === '--') { j += 1; break; }
        if (w.startsWith('-') && w.length > 1) {
          // `nice -10` and `nice -n 10` both exist; a bare negative number is its own value.
          if (takesArg.has(w)) j += 2;
          else j += 1;
          continue;
        }
        if (name === 'env' && ASSIGNMENT.test(w) && !argv[j].quoted) {
          assignments.push(w);
          j += 1;
          continue;
        }
        if (positional > 0) { positional -= 1; j += 1; continue; }
        break;
      }
      if (j >= argv.length) break;
      via.push(name);
      argv = argv.slice(j);
      continue;
    }

    if (SHELLS.has(name)) {
      // `bash -c 'string' [name args…]`, `bash -lc …`, `sh -e -c …`.
      let j = 1;
      let hasC = false;
      while (j < argv.length && argv[j].text.startsWith('-') && argv[j].text !== '--') {
        const flag = argv[j].text;
        if (!flag.startsWith('--') && flag.slice(1).includes('c')) { hasC = true; j += 1; break; }
        j += flag === '-o' || flag === '-O' ? 2 : 1;
      }
      if (hasC && j < argv.length) {
        return { argv, assignments, via, inner: argv[j].text, innerVia: `${name} -c`, inert: false };
      }
      break;
    }

    if (name === 'eval' && argv.length > 1) {
      return { argv, assignments, via, inner: argv.slice(1).map((w) => w.text).join(' '), innerVia: 'eval', inert: false };
    }
    break;
  }
  return { argv, assignments, via, inner: null, innerVia: null, inert: false };
}

/* ── segments ────────────────────────────────────────────────────────── */

type Raw = { words: { word: ShellWord; subs: Sub[] }[]; redirects: ShellRedirect[]; pipedFrom: boolean; pipedTo: boolean };

function group(tokens: Token[]): Raw[] {
  const out: Raw[] = [];
  let cur: Raw = { words: [], redirects: [], pipedFrom: false, pipedTo: false };
  let pendingRedirect: { op: string; fd: string | null } | null = null;
  const close = (pipe: boolean) => {
    if (cur.words.length || cur.redirects.length) {
      cur.pipedTo = pipe;
      out.push(cur);
    }
    cur = { words: [], redirects: [], pipedFrom: pipe && (cur.words.length > 0 || cur.redirects.length > 0), pipedTo: false };
  };
  for (const tok of tokens) {
    if (tok.t === 'redir') { pendingRedirect = { op: tok.op, fd: tok.fd }; continue; }
    if (tok.t === 'word') {
      if (pendingRedirect) {
        cur.redirects.push({ ...pendingRedirect, target: tok.word });
        // A substitution inside a redirect target still runs.
        if (tok.subs.length) cur.words.push({ word: { text: '', quoted: false, dynamic: true }, subs: tok.subs });
        pendingRedirect = null;
      } else {
        cur.words.push({ word: tok.word, subs: tok.subs });
      }
      continue;
    }
    pendingRedirect = null;
    close(tok.op === '|' || tok.op === '|&');
  }
  close(false);
  return out;
}

function render(words: ShellWord[]): string {
  return words.map((w) => (/[\s;&|<>()'"\\]/.test(w.text) || w.text === '' ? JSON.stringify(w.text) : w.text)).join(' ');
}

/**
 * Every command a line would run, flattened: top-level commands, the strings
 * handed to `bash -c` and `eval`, and the insides of every substitution — each
 * with the chain of wrappers that led to it.
 */
export function parseShell(command: string): ParsedShell {
  const segments: ShellSegment[] = [];
  const notes: string[] = [];
  walk(command, 'command', 0, [], null, segments, notes);
  return { segments, notes: [...new Set(notes)] };
}

function walk(
  src: string, origin: SegmentOrigin, depth: number, outerVia: string[], parent: number | null,
  segments: ShellSegment[], notes: string[],
): void {
  if (depth > MAX_DEPTH) {
    notes.push(`Commands nested more than ${MAX_DEPTH} levels deep were not read.`);
    return;
  }
  for (const raw of group(lex(src, notes))) {
    if (segments.length >= MAX_SEGMENTS) {
      notes.push(`Only the first ${MAX_SEGMENTS} commands in this line were read.`);
      return;
    }
    const words = raw.words.map((w) => w.word).filter((w) => w.text !== '' || w.quoted);
    const peeled = peel(words);
    const index = segments.length;
    const via = [...outerVia, ...peeled.via];
    if (peeled.argv.length || raw.redirects.length) {
      segments.push({
        argv: peeled.argv,
        assignments: peeled.assignments,
        redirects: raw.redirects,
        via,
        origin,
        depth,
        pipedFrom: raw.pipedFrom,
        pipedTo: raw.pipedTo,
        text: render([...peeled.argv]) + raw.redirects.map((r) => ` ${r.fd ?? ''}${r.op} ${render([r.target])}`).join(''),
        parent,
      });
    }
    if (peeled.inert) continue;
    if (peeled.inner !== null) {
      walk(peeled.inner, 'wrapper', depth + 1, [...via, peeled.innerVia ?? 'shell -c'], index, segments, notes);
    }
    for (const w of raw.words) {
      for (const sub of w.subs) {
        walk(sub.text, sub.kind === 'process' ? 'process-substitution' : 'substitution', depth + 1, via, index, segments, notes);
      }
    }
  }
}

/** The program a segment runs, as a bare name — `/usr/bin/git` is `git`. Empty when unknown. */
export function programOf(segment: ShellSegment): string {
  const head = segment.argv[0];
  if (!head || head.dynamic) return '';
  return basenameOf(head.text);
}

/** One word, split into the tokens a gate compares against — for callers that only need text. */
export function wordsOf(segment: ShellSegment): string[] {
  return segment.argv.map((w) => w.text);
}
