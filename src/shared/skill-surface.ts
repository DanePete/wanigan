/**
 * What a skill can make an agent do, read deterministically from its files.
 *
 * A digest says that a skill changed. A capability surface says what it can now
 * do: which programs its shell lines run, which hosts it names, which paths it
 * reads or writes, and which patterns in it are known ways to turn a skill
 * against the agent reading it — `curl | sh`, a base64 blob, "ignore previous
 * instructions", a read of ~/.ssh. SkilLock pins exactly this surface and blocks
 * on growth until a person approves the delta; SkillSpector and skillshare scan
 * for the patterns with severities and keep any aggregate score informational
 * (c-claude-helper-tools.md §1.19, d-codex-crossagent-tools.md §10).
 *
 * Findings carry severities and there is no score. Nothing here runs a model or
 * executes a line: it reads text. A skill that fetches its real instructions at
 * run time has a small surface here and a large one in practice, which is why
 * the hosts it names are part of the surface too.
 */

import { parseShell, programOf } from './shell-parse.ts';

export type SkillFile = { path: string; text: string };

export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low';

export type SurfaceFinding = {
  severity: FindingSeverity;
  code: string;
  file: string;
  detail: string;
};

export type SkillSurface = {
  commands: string[];
  hosts: string[];
  paths: string[];
  findings: SurfaceFinding[];
  /** Files read, and files skipped with why. */
  files: number;
  skipped: string[];
};

export type SurfaceDelta = {
  commands: string[];
  hosts: string[];
  paths: string[];
  findings: SurfaceFinding[];
  grew: boolean;
};

const SHELL_FENCES = new Set(['', 'bash', 'sh', 'shell', 'zsh', 'console', 'terminal', 'fish']);
const SCRIPT_EXT = /\.(?:sh|bash|zsh|fish)$/i;
const SUBCOMMAND_PROGRAMS = new Set(['git', 'npm', 'pnpm', 'yarn', 'bun', 'docker', 'kubectl', 'gh', 'glab', 'aws', 'gcloud', 'az', 'terraform', 'cargo', 'go', 'pip', 'pip3', 'brew', 'apt', 'apt-get', 'make', 'just', 'composer', 'drush', 'helm', 'systemctl', 'launchctl', 'security']);
const CREDENTIAL = /(?:~|\$HOME|\/Users\/[^/\s]+|\/home\/[^/\s]+)?\/?\.(?:ssh|aws\/credentials|aws\/config|npmrc|netrc|pypirc|docker\/config\.json|kube\/config|config\/gh|gnupg)\b|\bLibrary\/Keychains\b|\bsecurity\s+find-(?:generic|internet)-password\b|(?:^|[\s/'"])\.env(?:\.[\w-]+)?(?=$|[\s'"])/;

function shellLines(file: SkillFile): string[] {
  if (SCRIPT_EXT.test(file.path)) return file.text.split('\n');
  const out: string[] = [];
  const lines = file.text.split('\n');
  let fence: string | null = null;
  let buffer: string[] = [];
  for (const line of lines) {
    const open = /^\s*(```|~~~)\s*([\w-]*)/.exec(line);
    if (open && fence === null) { fence = open[2].toLowerCase(); buffer = []; continue; }
    if (fence !== null && /^\s*(```|~~~)\s*$/.test(line)) {
      if (SHELL_FENCES.has(fence)) out.push(...buffer);
      fence = null;
      continue;
    }
    if (fence !== null) { buffer.push(line); continue; }
    // Claude Code skills can run `!`command`` before the model sees the file.
    for (const m of line.matchAll(/!`([^`]+)`/g)) out.push(m[1]);
  }
  return out.map((l) => l.replace(/^\s*[$>#]\s+/, '').trim()).filter((l) => l && !l.startsWith('#'));
}

function add(set: Set<string>, value: string, max = 200): void {
  if (set.size < max) set.add(value);
}

/** The capability surface of a skill's files. Pure and order-independent. */
export function computeSkillSurface(files: SkillFile[], skipped: string[] = []): SkillSurface {
  const commands = new Set<string>();
  const hosts = new Set<string>();
  const paths = new Set<string>();
  const findings: SurfaceFinding[] = [];
  const find = (severity: FindingSeverity, code: string, file: string, detail: string) => {
    if (findings.length < 200 && !findings.some((f) => f.code === code && f.file === file && f.detail === detail)) findings.push({ severity, code, file, detail: detail.slice(0, 200) });
  };

  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const text = file.text;
    for (const m of text.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/(?:[^/\s'"`@]+@)?([A-Za-z0-9.-]+\.[A-Za-z]{2,}|localhost|\d+\.\d+\.\d+\.\d+)/gi)) add(hosts, m[1].toLowerCase());

    const allowed = /^allowed-tools:\s*(.+)$/im.exec(text);
    if (allowed) for (const t of allowed[1].split(/,\s*/)) if (/^Bash\(/.test(t.trim())) add(commands, `allowed-tools ${t.trim()}`);

    for (const line of shellLines(file)) {
      const parsed = parseShell(line);
      for (const seg of parsed.segments) {
        const program = programOf(seg);
        if (!program) continue;
        const sub = seg.argv[1]?.text && SUBCOMMAND_PROGRAMS.has(program) && !seg.argv[1].text.startsWith('-') ? ` ${seg.argv[1].text}` : '';
        add(commands, `${seg.via.includes('sudo') ? 'sudo ' : ''}${program}${sub}`);
        for (const w of [...seg.argv.slice(1), ...seg.redirects.map((r) => r.target)]) {
          const t = w.text;
          if (!t || t.startsWith('-') || /^[a-z][a-z0-9+.-]*:\/\//i.test(t)) continue;
          if (t.startsWith('/') || t.startsWith('~') || t.startsWith('$HOME') || (t.includes('/') && /\.[A-Za-z0-9]{1,6}$/.test(t))) add(paths, t);
        }
        if (seg.via.includes('sudo')) find('medium', 'runs-as-root', file.path, seg.text);
        if (program === 'rm' && seg.argv.some((w) => /^-[a-zA-Z]*r/.test(w.text)) && seg.argv.some((w) => ['/', '~', '$HOME', '/*', '~/*'].includes(w.text))) find('high', 'destructive-root', file.path, seg.text);
        if (program === 'curl' && seg.argv.some((w) => /^(-d|--data.*|-F|--form|-T|--upload-file)$/.test(w.text))) find('medium', 'sends-data', file.path, seg.text);
        if (['scp', 'nc', 'ncat', 'netcat', 'sftp'].includes(program)) find('medium', 'sends-data', file.path, seg.text);
      }
      if (/\b(?:curl|wget)\b[^|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|python[\d.]*|node|perl|ruby)\b/.test(line) || /\b(?:sh|bash)\s+<\(\s*(?:curl|wget)/.test(line) || /eval\s+"?\$\((?:curl|wget)/.test(line)) {
        find('critical', 'download-piped-to-interpreter', file.path, line);
      }
      if (/base64\s+(?:-d|--decode|-D)\b[^|]*\|\s*(?:sh|bash|zsh|python[\d.]*|node)/.test(line)) find('critical', 'decoded-payload-executed', file.path, line);
    }

    if (CREDENTIAL.test(text)) {
      const m = CREDENTIAL.exec(text);
      find('high', 'credential-path', file.path, (m?.[0] ?? '').trim());
      if (m) add(paths, m[0].trim());
    }
    if (/\b(?:ignore|disregard|forget)\s+(?:all\s+|any\s+)?(?:the\s+)?(?:previous|prior|above|earlier|preceding)\s+(?:instructions|prompts|rules|directions)\b/i.test(text)) {
      find('high', 'instruction-override', file.path, 'text asks the reader to ignore earlier instructions');
    }
    if (/\b(?:do not|don't|never)\s+(?:tell|inform|mention|show)\s+(?:the\s+)?(?:user|operator|human)\b/i.test(text)) {
      find('high', 'concealment', file.path, 'text asks the reader to hide something from the user');
    }
    const blob = /[A-Za-z0-9+/]{200,}={0,2}/.exec(text);
    if (blob) find('medium', 'base64-blob', file.path, `${blob[0].length}-character encoded blob`);
    if (/[\u200B-\u200F\u202A-\u202E\u2066-\u2069]/.test(text)) find('medium', 'invisible-unicode', file.path, 'zero-width or bidirectional control characters');
    for (const c of text.matchAll(/<!--([\s\S]*?)-->/g)) {
      if (/\b(?:run|execute|ignore|send|upload|curl|read|you must|always)\b/i.test(c[1])) { find('medium', 'hidden-comment-instruction', file.path, c[1].trim().slice(0, 120)); break; }
    }
  }
  for (const s of skipped) find('low', 'file-not-read', s, 'not read: binary, too large, or past the file limit');
  const order: FindingSeverity[] = ['critical', 'high', 'medium', 'low'];
  findings.sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity) || a.code.localeCompare(b.code) || a.file.localeCompare(b.file));
  return {
    commands: [...commands].sort(),
    hosts: [...hosts].sort(),
    paths: [...paths].sort(),
    findings,
    files: files.length,
    skipped: [...skipped].sort(),
  };
}

const findingKey = (f: SurfaceFinding) => `${f.severity}|${f.code}|${f.file}|${f.detail}`;

/** What `current` can do that `approved` could not. Removals are not growth. */
export function surfaceDelta(approved: SkillSurface | null, current: SkillSurface): SurfaceDelta {
  const base = approved ?? { commands: [], hosts: [], paths: [], findings: [], files: 0, skipped: [] };
  const commands = current.commands.filter((c) => !base.commands.includes(c));
  const hosts = current.hosts.filter((h) => !base.hosts.includes(h));
  const paths = current.paths.filter((p) => !base.paths.includes(p));
  const known = new Set(base.findings.map(findingKey));
  const findings = current.findings.filter((f) => !known.has(findingKey(f)));
  return { commands, hosts, paths, findings, grew: commands.length + hosts.length + paths.length + findings.length > 0 };
}

/** The canonical text a digest is taken over: the surface, not the bytes. */
export function surfaceCanonical(surface: SkillSurface): string {
  return JSON.stringify({ c: surface.commands, h: surface.hosts, p: surface.paths, f: surface.findings.map(findingKey) });
}
