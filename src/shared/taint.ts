/**
 * What came in from the network, and whether it is what runs next.
 *
 * Johann Rehberger's auto-mode bypass (26 Aug 2026, a-claude-articles.md §1.14)
 * needed no dangerous-looking command at any step: a 415 pushes the agent from
 * WebFetch to `curl`, a redirect serves a zip, the agent declines the bundled
 * binary and writes its own Python decoder, and runs it inside the extracted
 * directory — where `import base64` loads the attacker's `struct.py`. About 80%
 * success, and "Auto Mode approval is not evidence that a command is safe."
 *
 * This connects the two halves a string matcher sees separately: which paths a
 * session created by downloading, extracting or cloning, and whether a later
 * interpreter runs a file inside them — or runs Python in a directory holding a
 * file named like a standard-library module. It is a tripwire, not
 * containment: a download renamed, moved or unpacked by a script the agent
 * wrote is invisible to it, and the gate says so wherever it fires.
 */

import { parseShell, programOf, type ShellSegment, type ShellWord } from './shell-parse.ts';
import { basename, dirname, expandHome, resolve, within } from './posix-path.ts';

/**
 * Python standard-library modules an attacker can shadow by dropping a file of
 * the same name beside the script (Python puts the script's directory first on
 * sys.path, and the working directory for `-c` and `-m`). Built-in modules
 * compiled into the interpreter — sys, time, builtins — cannot be shadowed this
 * way and are deliberately absent.
 */
export const STDLIB_SHADOW_NAMES: ReadonlySet<string> = new Set([
  'abc', 'argparse', 'ast', 'asyncio', 'base64', 'binascii', 'bz2', 'calendar', 'codecs', 'collections', 'configparser',
  'contextlib', 'copy', 'csv', 'ctypes', 'dataclasses', 'datetime', 'decimal', 'difflib', 'email', 'enum', 'fnmatch',
  'functools', 'getpass', 'glob', 'gzip', 'hashlib', 'heapq', 'hmac', 'html', 'http', 'importlib', 'inspect', 'io',
  'ipaddress', 'json', 'locale', 'logging', 'lzma', 'mimetypes', 'multiprocessing', 'numbers', 'operator', 'os',
  'pathlib', 'pickle', 'platform', 'pprint', 'queue', 'random', 're', 'secrets', 'select', 'selectors', 'shlex',
  'shutil', 'signal', 'site', 'socket', 'sqlite3', 'ssl', 'stat', 'string', 'struct', 'subprocess', 'tarfile',
  'tempfile', 'textwrap', 'threading', 'token', 'tokenize', 'traceback', 'types', 'typing', 'unittest', 'urllib',
  'uuid', 'warnings', 'weakref', 'xml', 'zipfile', 'zlib',
]);

/** Whether a directory entry named `name` would shadow a standard-library module. */
export function shadowsStdlib(name: string): boolean {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:\.py|\.pyc)?$/.exec(name);
  return !!m && STDLIB_SHADOW_NAMES.has(m[1]) && (name.endsWith('.py') || name.endsWith('.pyc') || name === m[1]);
}

export type CreatedPath = { path: string; how: string };

export type TripwireView = {
  /** Paths — files or directories — the session created by downloading, extracting or cloning. */
  tainted: string[];
  /** Entry names in `dir` that shadow a standard-library module; empty when none or unreadable. */
  shadowsIn: (dir: string) => string[];
};

export type TripwireFinding = {
  rule: 'tripwire.downloaded-run' | 'tripwire.stdlib-shadow';
  /** The command that runs the file. */
  command: string;
  detail: string;
};

const INTERPRETERS = /^(?:python[\d.]*|node|bash|sh|zsh|dash|ksh|ruby|perl|php|deno|bun)$/;

function staticText(w: ShellWord | undefined): string | null {
  return w && !w.dynamic ? w.text : null;
}

function urlBasename(url: string): string | null {
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^/]+(\/[^?#]*)?/i.exec(url);
  if (!m) return null;
  const tail = basename(m[1] ?? '');
  return tail && tail !== '/' ? tail : null;
}

function optionValue(words: ShellWord[], flags: string[], joined: RegExp | null): string | null {
  for (let i = 0; i < words.length; i++) {
    const t = words[i].text;
    if (flags.includes(t)) return staticText(words[i + 1]);
    if (joined) {
      const m = joined.exec(t);
      if (m && !words[i].dynamic) return m[1];
    }
  }
  return null;
}

/** Paths one command creates by downloading, extracting or cloning, resolved against `cwd`. */
function createdBy(seg: ShellSegment, cwd: string, home: string): CreatedPath[] {
  const program = programOf(seg);
  const w = seg.argv.slice(1);
  const at = (p: string) => resolve(cwd, expandHome(p, home));
  const out: CreatedPath[] = [];
  const urls = w.map((x) => staticText(x)).filter((x): x is string => !!x && /^[a-z][a-z0-9+.-]*:\/\//i.test(x));

  if (program === 'curl') {
    const o = optionValue(w, ['-o', '--output'], /^-o(.+)$/);
    if (o && o !== '-') out.push({ path: at(o), how: 'curl -o' });
    const remoteName = w.some((x) => x.text === '-O' || x.text === '--remote-name' || x.text === '--remote-name-all' || /^-[a-zA-Z]*O[a-zA-Z]*$/.test(x.text));
    if (remoteName) {
      const dir = optionValue(w, ['--output-dir'], /^--output-dir=(.+)$/);
      for (const u of urls) {
        const name = urlBasename(u);
        if (name) out.push({ path: resolve(dir ? at(dir) : cwd, name), how: 'curl -O' });
      }
    }
    for (const r of seg.redirects) {
      if ((r.op === '>' || r.op === '>>') && !r.target.dynamic && !r.fd) out.push({ path: at(r.target.text), how: 'curl >' });
    }
  } else if (program === 'wget') {
    const doc = optionValue(w, ['-O', '--output-document'], /^--output-document=(.+)$/);
    const prefix = optionValue(w, ['-P', '--directory-prefix'], /^--directory-prefix=(.+)$/);
    if (doc && doc !== '-') out.push({ path: at(doc), how: 'wget -O' });
    else if (!doc) {
      if (prefix) out.push({ path: at(prefix), how: 'wget -P' });
      for (const u of urls) out.push({ path: resolve(prefix ? at(prefix) : cwd, urlBasename(u) ?? 'index.html'), how: 'wget' });
    }
  } else if (program === 'unzip') {
    const d = optionValue(w, ['-d'], null);
    if (d) out.push({ path: at(d), how: 'unzip -d' });
  } else if (program === 'tar' || program === 'bsdtar' || program === 'gtar') {
    const first = w[0]?.text ?? '';
    const extracting = /^-?[a-zA-Z]*x/.test(first) || w.some((x) => x.text === '--extract' || x.text === '-x' || /^-[a-zA-Z]*x[a-zA-Z]*$/.test(x.text));
    const into = optionValue(w, ['-C', '--directory'], /^--directory=(.+)$/);
    if (extracting && into) out.push({ path: at(into), how: 'tar -x -C' });
  } else if (program === 'git' && w.find((x) => !x.text.startsWith('-'))?.text === 'clone') {
    const positional = w.filter((x) => !x.text.startsWith('-')).slice(1);
    const source = staticText(positional[0]);
    const dest = staticText(positional[1]);
    if (dest) out.push({ path: at(dest), how: 'git clone' });
    else if (source) {
      const name = basename(source.replace(/\/+$/, '').replace(/:/g, '/')).replace(/\.git$/, '');
      if (name) out.push({ path: resolve(cwd, name), how: 'git clone' });
    }
  }
  return out;
}

type Run = { command: string; interpreter: string; script: string | null; cwd: string; python: boolean };

function runOf(seg: ShellSegment, cwd: string, home: string): Run | null {
  const program = programOf(seg);
  const head = seg.argv[0];
  if (!head || head.dynamic) return null;
  if (INTERPRETERS.test(program)) {
    const args = seg.argv.slice(1);
    let script: string | null = null;
    for (let i = 0; i < args.length; i++) {
      const t = args[i].text;
      if (t === '-c' || t === '-e' || t === '-m' || t === '--eval' || t === '-p') break;
      if (t.startsWith('-')) continue;
      script = args[i].dynamic ? null : resolve(cwd, expandHome(t, home));
      break;
    }
    return { command: seg.text, interpreter: program, script, cwd, python: /^python/.test(program) };
  }
  if (head.text.includes('/')) {
    return { command: seg.text, interpreter: head.text, script: resolve(cwd, expandHome(head.text, home)), cwd, python: false };
  }
  return null;
}

/** Paths a whole command line creates, following `cd` along the line. */
export function createdPathsIn(command: string, cwd: string, home: string): CreatedPath[] {
  const out: CreatedPath[] = [];
  walkLine(command, cwd, home, (seg, here) => { out.push(...createdBy(seg, here, home)); });
  return out;
}

function walkLine(command: string, cwd: string, home: string, visit: (seg: ShellSegment, cwd: string) => void): void {
  let here = cwd;
  for (const seg of parseShell(command).segments) {
    if (seg.origin === 'command' && programOf(seg) === 'cd') {
      const target = staticText(seg.argv[1]);
      if (!seg.argv[1]) here = home;
      else if (target && target !== '-') here = resolve(here, expandHome(target, home));
      continue;
    }
    visit(seg, here);
  }
}

/**
 * Interpreter runs on the line that execute a downloaded path, or run Python
 * next to a standard-library shadow. A download earlier on the same line counts
 * the same as one from an earlier call: `curl -o x.sh … && bash x.sh` is the
 * two-step the string matcher always missed.
 */
export function tripwireFindings(command: string, cwd: string, home: string, view: TripwireView): TripwireFinding[] {
  const tainted = [...view.tainted];
  const findings: TripwireFinding[] = [];
  walkLine(command, cwd, home, (seg, here) => {
    const run = runOf(seg, here, home);
    if (run) {
      const inside = tainted.find((t) => (run.script && within(t, run.script)) || within(t, run.cwd));
      if (inside) {
        findings.push({
          rule: 'tripwire.downloaded-run',
          command: run.command,
          detail: `${run.script ?? run.interpreter} runs inside ${inside}, which this session downloaded, extracted or cloned`,
        });
      }
      if (run.python) {
        const dirs = [...new Set([run.script ? dirname(run.script) : null, run.cwd].filter((d): d is string => !!d))];
        for (const dir of dirs) {
          const names = view.shadowsIn(dir).filter(shadowsStdlib);
          if (names.length) {
            findings.push({
              rule: 'tripwire.stdlib-shadow',
              command: run.command,
              detail: `${dir} holds ${names.slice(0, 4).join(', ')}, which Python would import instead of the standard library`,
            });
            break;
          }
        }
      }
    }
    for (const c of createdBy(seg, here, home)) tainted.push(c.path);
  });
  return findings;
}
