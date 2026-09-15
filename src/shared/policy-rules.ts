/**
 * The rules behind "may this tool call proceed?", with no process attached.
 *
 * THIS IS DEFENCE IN DEPTH OVER THE OS SANDBOX. IT IS NOT CONTAINMENT.
 *
 * Everything below reads a tool call's text. It is bypassed by a script the
 * agent wrote thirty seconds ago, by base64, by an alias, by any indirection a
 * reader of the text cannot follow. The 2026 CVEs did not even need that much:
 * CVE-2026-22708 poisoned a Cursor execution environment so that an allowlisted
 * `git branch` delivered the payload, and CVE-2025-59532 showed a Codex CLI
 * sandbox boundary being redefined by the agent's own output. Neither would
 * have tripped a rule here, because neither ran a command that looked
 * dangerous. What these rules buy is a pause and a ledger row on the shapes a
 * human would recognise on sight. Real containment is the OS sandbox, a
 * container, or a machine you are willing to rebuild.
 *
 * What changed from the string matcher these rules replace is the reading, not
 * the rules. A command line is parsed first (see shell-parse.ts), so the gate
 * judges each command the line would run — including the ones handed to
 * `bash -c`, `env`, `sudo`, `nohup`, `xargs`, `time`, `$(…)` and backticks — and
 * the answer for the line is the most restrictive answer for any of them. The
 * old whole-line patterns still run on the raw text as well, so nothing the old
 * matcher caught is lost; the trace says which of the two found it.
 *
 * Pure: file-system questions (where a symlink really points, what is in a
 * directory) come in through `RuleEnv`, so the gate's self-test corpus can run
 * the same code under `node --test` with a synthetic home and project.
 *
 * Known and deliberate holes, so the shape of the gap is on the record: no
 * variable expansion, no alias or function resolution, no reading of scripts a
 * command runs. `$HOME` is the one variable resolved, because the gate has
 * always resolved it.
 */

import { TRUST_COPY } from './types.ts';
import type { HookInput, PolicyDecision, TrustLevel } from './types.ts';
import { parseShell, programOf, type SegmentOrigin, type ShellSegment, type ShellWord } from './shell-parse.ts';
import { dirname, expandHome, isAbsolute, normalize, resolve, within } from './posix-path.ts';

export type RuleEnv = {
  home: string;
  /** A path's nearest existing ancestor, resolved through symlinks, with the rest re-attached. */
  realish: (p: string) => string;
  /** Where a relative path resolves when the session has no project root. */
  cwd: string;
};

export type RuleContext = {
  trust: TrustLevel;
  projectPath: string | null;
};

export type TraceStep = {
  /** The command as read back, or `(whole line)` for a raw-text pattern. */
  text: string;
  via: string[];
  origin: SegmentOrigin | 'raw';
  /** The directory relative paths in this command resolve against, when known. */
  cwd: string | null;
  rule: string | null;
  decision: PolicyDecision['decision'];
  reason: string | null;
};

export type PolicyTrace = {
  tool: string;
  trust: TrustLevel;
  steps: TraceStep[];
  /** What the shell reader could not follow. */
  notes: string[];
  decided: PolicyDecision;
};

export type Evaluation = { decision: PolicyDecision; trace: PolicyTrace };

export type EvaluateExtras = {
  /** The operator's emergency stop. Outranks every trust level. */
  halted?: boolean;
};

/* ── the rule register ───────────────────────────────────────────────── */

export type RuleSpec = {
  id: string;
  /** The answer the rule gives when it fires, at the trust level it is written for. */
  outcome: PolicyDecision['decision'];
  level: TrustLevel | 'any';
  summary: string;
};

/**
 * Every rule the gate can name in a ledger row. The self-test corpus is held
 * to this list — a rule added here without a fixture that makes it fire, and
 * one that shows it standing aside, fails `npm run test:shared`.
 */
export const POLICY_RULES: readonly RuleSpec[] = [
  { id: 'halted.deny', outcome: 'deny', level: 'any', summary: 'The halt switch is on; every call is refused.' },
  { id: 'trusted.allow', outcome: 'allow', level: 'trusted', summary: 'Trusted projects are never denied by Wanigan.' },
  { id: 'credential-path', outcome: 'ask', level: 'any', summary: 'Touching a credential directory under your home folder asks.' },
  { id: 'readonly.mcp-read', outcome: 'allow', level: 'readonly', summary: 'An MCP tool whose verb reads is allowed.' },
  { id: 'readonly.mcp-write', outcome: 'ask', level: 'readonly', summary: 'Any other MCP tool asks.' },
  { id: 'readonly.read', outcome: 'allow', level: 'readonly', summary: 'Read, search and lookup tools are allowed.' },
  { id: 'readonly.shell', outcome: 'ask', level: 'readonly', summary: 'Every shell command asks.' },
  { id: 'readonly.write', outcome: 'ask', level: 'readonly', summary: 'Every file write asks.' },
  { id: 'readonly.unknown', outcome: 'ask', level: 'readonly', summary: 'A tool Wanigan does not know asks.' },
  { id: 'bash.curl-pipe-shell', outcome: 'ask', level: 'project', summary: 'A download piped into an interpreter asks.' },
  { id: 'bash.fork-bomb', outcome: 'deny', level: 'project', summary: 'A fork bomb is denied.' },
  { id: 'bash.raw-disk', outcome: 'deny', level: 'project', summary: 'Writing a raw device or formatting a volume is denied.' },
  { id: 'bash.sudo', outcome: 'ask', level: 'project', summary: 'sudo asks, however it is wrapped.' },
  { id: 'bash.redirect-outside', outcome: 'ask', level: 'project', summary: 'Redirecting output to a file outside the project asks.' },
  { id: 'bash.force-push-protected', outcome: 'ask', level: 'project', summary: 'A force push to a protected branch asks.' },
  { id: 'bash.destructive-root', outcome: 'deny', level: 'project', summary: 'A mutating command aimed at / or your home folder is denied.' },
  { id: 'bash.target-outside', outcome: 'ask', level: 'project', summary: 'A mutating command aimed outside the project asks.' },
  { id: 'project.no-root', outcome: 'ask', level: 'project', summary: 'With no known project directory, commands and writes ask.' },
  { id: 'project.command', outcome: 'allow', level: 'project', summary: 'A command with none of the checked escapes is allowed.' },
  { id: 'project.unknown-target', outcome: 'ask', level: 'project', summary: 'A write whose target cannot be read asks.' },
  { id: 'project.write-outside', outcome: 'ask', level: 'project', summary: 'A write outside the project asks.' },
  { id: 'project.write-inside', outcome: 'allow', level: 'project', summary: 'A write inside the project is allowed.' },
  { id: 'project.allow', outcome: 'allow', level: 'project', summary: 'Everything else at Project trust is allowed.' },
];

/* ── tool classification ─────────────────────────────────────────────── */

/**
 * What 'readonly' allows. WebFetch and WebSearch are reads that leave the
 * machine, allowed deliberately — a level that cannot look anything up is a
 * level nobody keeps switched on. TRUST_COPY.readonly says so.
 */
export const READ_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'NotebookRead', 'TodoWrite',
  'ExitPlanMode', 'ListMcpResourcesTool', 'ReadMcpResourceTool', 'ReadMcpResourceDirTool',
]);

/** Tools whose whole purpose is to change something on this machine. */
export const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'ApplyPatch']);

/** Codex and Claude Code name the same capability differently. */
const SHELL_TOOLS = new Set(['bash', 'shell', 'local_shell', 'exec_command', 'run_command', 'run_terminal_cmd']);

export function isShellTool(tool: string, input: HookInput): boolean {
  if (tool === 'SlashCommand') return false; // its `command` is a slash command, not a shell line
  if (SHELL_TOOLS.has(tool.toLowerCase())) return true;
  return typeof input.tool_input?.command === 'string';
}

export function mcpTool(tool: string): { server: string; name: string } | null {
  if (!tool.startsWith('mcp__')) return null;
  const parts = tool.split('__');
  if (parts.length < 3) return null;
  const server = parts[1];
  let name = parts.slice(2).join('__');
  // Servers commonly repeat their own name in every tool ('zendesk_get_ticket'),
  // which would hide the verb from the prefix test.
  if (name.startsWith(`${server}_`)) name = name.slice(server.length + 1);
  return { server, name };
}

export const MCP_READ_VERB = /^(get|list|read|search|fetch|query|describe|find|view|show|lookup|inspect|count|check|preview|summar)/i;

/* ── paths ───────────────────────────────────────────────────────────── */

const PATH_KEYS = ['file_path', 'notebook_path', 'path', 'filePath', 'notebookPath', 'target_file', 'absolute_path'];

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export function targetPath(input: HookInput): string {
  const ti = input.tool_input ?? {};
  for (const k of PATH_KEYS) {
    const v = str(ti[k]);
    if (v) return v;
  }
  return '';
}

/**
 * Containment is decided AFTER resolution, never by hunting for '..' in the
 * raw string, and on both ends: a symlink inside the project pointing at
 * ~/.ssh is lexically inside and must still be refused, and on macOS a project
 * added as /tmp/x really lives at /private/tmp/x.
 */
export function insideRoot(env: RuleEnv, root: string, target: string): boolean {
  const base = resolve(env.cwd, root);
  const full = resolve(base, expandHome(target, env.home));
  return within(env.realish(base), env.realish(full));
}

export function absolutise(env: RuleEnv, root: string | null, target: string): string {
  return resolve(root ? resolve(env.cwd, root) : env.cwd, expandHome(target, env.home));
}

/**
 * Home-anchored only. A project's own .claude/ directory is ordinary work;
 * ~/.claude holds the credentials for every session Wanigan will ever run.
 */
export const CREDENTIAL_PATHS = ['.ssh', '.aws', '.claude', '.gnupg', '.docker', '.kube', '.npmrc', '.netrc', '.config/gh'];

export function credentialHit(env: RuleEnv, abs: string): string | null {
  const real = env.realish(abs);
  for (const rel of CREDENTIAL_PATHS) {
    const root = `${env.home}/${rel}`;
    if (within(root, abs) || within(env.realish(root), real)) return root;
  }
  return null;
}

/** Path-shaped tokens in a shell command, absolute or home-relative. */
const PATH_TOKEN = /(?:~|\$\{?HOME\}?|\/)[^\s;|&'"<>()]*/g;

function credentialTarget(env: RuleEnv, input: HookInput, root: string | null): string | null {
  const p = targetPath(input);
  if (p) {
    const hit = credentialHit(env, absolutise(env, root, p));
    if (hit) return hit;
  }
  const cmd = str(input.tool_input?.command);
  for (const token of cmd.match(PATH_TOKEN) ?? []) {
    const hit = credentialHit(env, absolutise(env, root, token));
    if (hit) return hit;
  }
  return null;
}

/* ── shell inspection ────────────────────────────────────────────────── */

type Finding = { rule: string; reason: string; hard?: boolean };

const PIPE_TO_INTERPRETER =
  /\b(?:curl|wget)\b[^|]*\|\s*(?:sudo\s+)?(?:[\w./-]*\/)?(?:sh|bash|zsh|ksh|dash|python[\d.]*|node|perl|ruby)\b/i;
const PROCESS_SUB_FETCH = /\b(?:sh|bash|zsh|source|\.)\s+<\(\s*(?:curl|wget)\b/i;
const FORK_BOMB = /:\s*\(\s*\)\s*\{.*\|.*&.*\}\s*;\s*:/;
const RAW_DISK = /\b(?:mkfs(?:\.\w+)?|diskutil\s+erase\w*)\b|\bdd\b[^|;&]*\bof=\/dev\//i;
const INTERPRETER = /^(?:sh|bash|zsh|ksh|dash|python[\d.]*|node|perl|ruby)$/;
const PROTECTED_BRANCHES = new Set(['main', 'master', 'trunk', 'develop', 'production', 'prod', 'release', 'staging']);
/** Commands whose job is to change something at their target path. */
const MUTATING_BINARIES = new Set(['rm', 'rmdir', 'mv', 'cp', 'tee', 'install', 'ln', 'chmod', 'chown', 'chgrp', 'touch', 'mkdir', 'truncate', 'shred', 'unlink', 'rsync']);
/** Of those, the ones that only write to their final argument. */
const DEST_ONLY = new Set(['cp', 'mv', 'ln', 'install', 'rsync']);
const WRITE_REDIRECTS = new Set(['>', '>>', '&>', '&>>', '>|', '<>']);

const INSTEAD_ASK_OPERATOR = 'Do not look for another way to do the same thing; stop and tell the operator this step needs them.';

const REASON = {
  curlPipe: 'This pipes a download straight into an interpreter, so what runs is whatever the server returns at that moment. Approve it only if you trust the source right now; downloading and reading it first is safer.',
  forkBomb: `This is a fork bomb. It will take the machine down until it is rebooted. ${INSTEAD_ASK_OPERATOR}`,
  rawDisk: `This writes to a raw device or reformats a volume. Run it yourself, from a shell, if you truly mean it. ${INSTEAD_ASK_OPERATOR}`,
  sudo: 'sudo runs outside the project’s authority by definition. Approve it if you meant to grant that.',
};

/**
 * The word as a path the gate can judge, or null when it depends on expansion.
 * A leading `$HOME` is resolved because the gate always has; anything else
 * dynamic is unknown, and a guess here would be a lie in either direction.
 */
function staticPath(w: ShellWord): string | null {
  const t = w.text;
  if (!w.dynamic) return t;
  const rest = t.replace(/^\$\{?HOME\}?(?=\/|$)/, '');
  if (rest === t) return null;
  if (rest.includes('$') || rest.includes('`')) return null;
  return t;
}

function inspectSegment(seg: ShellSegment, all: ShellSegment[], index: number, cwd: string | null, root: string | null, env: RuleEnv): Finding | null {
  const program = programOf(seg);
  const words = seg.argv;

  if (seg.via.includes('sudo') || seg.via.includes('doas') || program === 'sudo' || program === 'doas') {
    return { rule: 'bash.sudo', reason: REASON.sudo };
  }

  if (/^mkfs(\.\w+)?$/.test(program) || (program === 'diskutil' && /^erase/i.test(words[1]?.text ?? ''))
    || (program === 'dd' && words.some((w) => /^of=\/dev\//.test(w.text)))) {
    return { rule: 'bash.raw-disk', reason: REASON.rawDisk, hard: true };
  }

  if (INTERPRETER.test(program) && seg.pipedFrom) {
    for (let i = index - 1; i >= 0 && all[i].pipedTo; i--) {
      if (/^(curl|wget)$/.test(programOf(all[i]))) return { rule: 'bash.curl-pipe-shell', reason: REASON.curlPipe };
    }
  }
  if (seg.origin === 'process-substitution' && /^(curl|wget)$/.test(program) && seg.parent !== null) {
    const outer = programOf(all[seg.parent]);
    if (/^(sh|bash|zsh|source|\.)$/.test(outer)) return { rule: 'bash.curl-pipe-shell', reason: REASON.curlPipe };
  }

  if (root) {
    for (const r of seg.redirects) {
      if (!WRITE_REDIRECTS.has(r.op) || /^\d+$/.test(r.target.text)) continue;
      const target = staticPath(r.target);
      if (target === null) continue;
      const expanded = expandHome(target, env.home);
      if (!isAbsolute(expanded) && cwd === null) continue;
      const abs = resolve(cwd ?? root, expanded);
      if (abs === '/dev/null' || abs.startsWith('/dev/std') || abs === '/dev/tty' || abs.startsWith('/dev/fd/')) continue;
      if (!insideRoot(env, root, abs)) {
        return {
          rule: 'bash.redirect-outside',
          reason: `This redirects output into ${abs}, which is outside the project. Approve it if that is where it belongs, or raise this project to ${TRUST_COPY.trusted.label} in Settings to stop being asked.`,
        };
      }
    }
  }

  if (program === 'git') {
    const t = words.map((w) => w.text);
    if (t.includes('push')) {
      // --force-with-lease is the careful version and stays allowed: it refuses
      // the push if the remote moved, which is the failure mode being guarded.
      const forced = t.some((x) => x === '--force' || x === '-f' || x === '--mirror') || t.some((x) => /^\+/.test(x));
      if (forced) {
        const named = t.filter((x) => !x.startsWith('-')).map((x) => x.replace(/^\+/, '').split(':').pop() ?? '');
        const hit = named.find((x) => PROTECTED_BRANCHES.has(x)) ?? (t.includes('--mirror') || t.includes('--all') ? 'every branch' : null);
        if (hit) {
          return {
            rule: 'bash.force-push-protected',
            reason: `A force push to ${hit} rewrites history other people have already pulled. Approve it only if this branch is yours to rewrite; --force-with-lease after a fetch is the careful version.`,
          };
        }
      }
    }
  }

  if (MUTATING_BINARIES.has(program)) {
    // `rm` and `chmod` mutate every path they are given; `cp` and `mv` mutate
    // only the last one. Checking a copy's source would refuse `cp /etc/hosts ./x`.
    const args = words.slice(1).filter((w) => !w.text.startsWith('-'));
    const candidates = DEST_ONLY.has(program) ? args.slice(-1) : args;
    for (const word of candidates) {
      const token = staticPath(word);
      if (token === null || token === '') continue;
      // A glob is judged by the directory it expands within — 'rm -rf /*' is 'rm -rf /'.
      const candidate = /[*?]/.test(token) && !word.quoted ? dirname(token.replace(/[*?].*$/, 'x')) : token;
      const expanded = expandHome(candidate, env.home);
      if (!isAbsolute(expanded) && cwd === null) continue;
      const abs = resolve(cwd ?? env.cwd, expanded);
      if (abs === '/' || normalize(abs) === normalize(env.home)) {
        return {
          rule: 'bash.destructive-root',
          reason: `This runs ${program} against ${abs}. Nothing an agent is asked to do needs that; run it yourself if you meant it. Instead, name the specific directory inside the project you meant to change.`,
          hard: true,
        };
      }
      if (root && !insideRoot(env, root, abs)) {
        return {
          rule: 'bash.target-outside',
          reason: `This ${program}s ${abs}, which is outside the project. Approve it if you mean it, or raise this project to ${TRUST_COPY.trusted.label} in Settings to stop being asked.`,
        };
      }
    }
  }
  return null;
}

const RANK: Record<PolicyDecision['decision'], number> = { allow: 0, ask: 1, deny: 2 };

/** Reads every command a shell line runs and answers for the most restrictive of them. */
function inspectShell(command: string, root: string | null, env: RuleEnv): { finding: Finding | null; steps: TraceStep[]; notes: string[] } {
  const parsed = parseShell(command);
  const steps: TraceStep[] = [];
  const findings: Finding[] = [];

  const raw: Finding[] = [];
  if (PIPE_TO_INTERPRETER.test(command) || PROCESS_SUB_FETCH.test(command)) raw.push({ rule: 'bash.curl-pipe-shell', reason: REASON.curlPipe });
  if (FORK_BOMB.test(command)) raw.push({ rule: 'bash.fork-bomb', reason: REASON.forkBomb, hard: true });
  if (RAW_DISK.test(command)) raw.push({ rule: 'bash.raw-disk', reason: REASON.rawDisk, hard: true });

  // Relative paths resolve against the directory each command runs in, which
  // a `cd` earlier on the same line changes. A `cd` the reader cannot follow
  // makes later relative paths unknown rather than quietly project-relative.
  let cwd: string | null = root ? resolve(env.cwd, root) : null;
  const cwdAt: (string | null)[] = [];
  parsed.segments.forEach((seg, i) => {
    cwdAt[i] = cwd;
    if (seg.origin === 'command' && programOf(seg) === 'cd') {
      const target = seg.argv[1];
      if (!target) cwd = env.home;
      else {
        const p = staticPath(target);
        cwd = p === null || p === '-' ? null : resolve(cwd ?? env.cwd, expandHome(p, env.home));
      }
    }
  });

  parsed.segments.forEach((seg, i) => {
    const f = inspectSegment(seg, parsed.segments, i, cwdAt[i], root, env);
    if (f) findings.push(f);
    steps.push({
      text: seg.text,
      via: seg.via,
      origin: seg.origin,
      cwd: cwdAt[i],
      rule: f?.rule ?? null,
      decision: f ? (f.hard ? 'deny' : 'ask') : 'allow',
      reason: f?.reason ?? null,
    });
  });

  for (const f of raw) {
    const parsedFound = findings.some((x) => x.rule === f.rule);
    steps.push({
      text: '(whole line)',
      via: [],
      origin: 'raw',
      cwd: null,
      rule: f.rule,
      decision: f.hard ? 'deny' : 'ask',
      reason: parsedFound ? f.reason : `${f.reason} Matched on the raw text; the parsed commands did not show it, so a quoted string may be run by another program.`,
    });
  }

  let best: Finding | null = null;
  for (const f of [...raw, ...findings]) {
    if (!best || RANK[f.hard ? 'deny' : 'ask'] > RANK[best.hard ? 'deny' : 'ask']) best = f;
  }
  return { finding: best, steps, notes: parsed.notes };
}

/* ── the decision ────────────────────────────────────────────────────── */

const allow = (reason: string, rule: string): PolicyDecision => ({ decision: 'allow', reason, rule });
const deny = (reason: string, rule: string): PolicyDecision => ({ decision: 'deny', reason, rule });
const ask = (reason: string, rule: string): PolicyDecision => ({ decision: 'ask', reason, rule });

/**
 * The gate's answer for one tool call, and the trace that says how it got
 * there. `decideFor` in main is this plus the ledger.
 */
export function evaluate(ctx: RuleContext, input: HookInput, env: RuleEnv, extras: EvaluateExtras = {}): Evaluation {
  const tool = (input.tool_name ?? '').trim();
  const trace: PolicyTrace = { tool, trust: ctx.trust, steps: [], notes: [], decided: allow('Not a tool call.', 'no-tool') };
  const done = (d: PolicyDecision): Evaluation => { trace.decided = d; return { decision: d, trace }; };
  if (!tool) return done(allow('Not a tool call.', 'no-tool'));

  if (extras.halted) {
    return done(deny('Wanigan is halted. Every tool call is refused until the halt is cleared at the Mac. Stop and wait; do not retry.', 'halted.deny'));
  }

  const shell = isShellTool(tool, input);
  const command = shell ? str(input.tool_input?.command) : '';
  const inspected = shell ? inspectShell(command, ctx.projectPath, env) : null;
  if (inspected) { trace.steps = inspected.steps; trace.notes = inspected.notes; }

  // Checked before any rule so that TRUST_COPY.trusted — "Nothing is denied by
  // Wanigan" — stays literally true. The trace is still built: a trusted
  // project's ledger row is where the operator reads what the line did.
  if (ctx.trust === 'trusted') {
    return done(allow(`${TRUST_COPY.trusted.label}: Wanigan denies nothing here.`, 'trusted.allow'));
  }

  const cred = credentialTarget(env, input, ctx.projectPath);
  const credAsk = cred
    ? ask(`This touches ${cred}, where your credentials live — reading a private key is half of an exfiltration. Approve it only if you asked for exactly this.`, 'credential-path')
    : null;

  let base: PolicyDecision;
  if (ctx.trust === 'readonly') base = readonlyDecision(tool, shell);
  else base = projectDecision(ctx, tool, input, shell, inspected?.finding ?? null, env);

  // A hard finding outranks a question at any level below Trusted: a fork bomb
  // at Read only is not a thing to put to the operator as a yes/no.
  if (ctx.trust === 'readonly' && inspected?.finding?.hard) {
    base = deny(inspected.finding.reason, inspected.finding.rule);
  }
  // Most restrictive wins. The credential question used to return early, which
  // let `cat ~/.ssh/id_rsa; rm -rf /` come back as a question about the key.
  // An equal question still names the credential directory, as it always has.
  if (credAsk && RANK[base.decision] <= RANK.ask) return done(credAsk);
  return done(base);
}

function readonlyDecision(tool: string, shell: boolean): PolicyDecision {
  const mcp = mcpTool(tool);
  if (mcp) {
    return MCP_READ_VERB.test(mcp.name)
      ? allow(`${mcp.server} ${mcp.name} reads.`, 'readonly.mcp-read')
      : ask(
        `${mcp.server} ${mcp.name} is not a read, and ${TRUST_COPY.readonly.label} allows only reads without asking. Approve this one call, or set the project to ${TRUST_COPY.project.label} in Settings if the agent should change things freely.`,
        'readonly.mcp-write',
      );
  }
  if (READ_TOOLS.has(tool)) return allow(`${tool} reads.`, 'readonly.read');
  if (shell) {
    return ask(
      `Shell commands need your approval at ${TRUST_COPY.readonly.label} trust. Approve this one, or set the project to ${TRUST_COPY.project.label} in Settings if the agent should run commands freely.`,
      'readonly.shell',
    );
  }
  if (WRITE_TOOLS.has(tool)) {
    return ask(
      `${tool} changes files, which ${TRUST_COPY.readonly.label} holds for your approval. Approve it, or set the project to ${TRUST_COPY.project.label} in Settings if the agent should edit the repo freely.`,
      'readonly.write',
    );
  }
  // Unknown tool at the strictest level: denying blocks harmless things and
  // allowing defeats the level, so hand it to the person who can tell.
  return ask(`Wanigan does not know what ${tool} does, and ${TRUST_COPY.readonly.label} allows only known reads. Approve it if it only reads.`, 'readonly.unknown');
}

function projectDecision(ctx: RuleContext, tool: string, input: HookInput, shell: boolean, finding: Finding | null, env: RuleEnv): PolicyDecision {
  const root = ctx.projectPath;
  if (shell) {
    if (finding) return finding.hard ? deny(finding.reason, finding.rule) : ask(finding.reason, finding.rule);
    if (!root) {
      return ask('Wanigan does not know this session’s project directory, so it cannot tell whether this command stays inside it. Approve it if you know where it runs.', 'project.no-root');
    }
    return allow('Command shows none of the escapes Wanigan checks for.', 'project.command');
  }
  if (WRITE_TOOLS.has(tool)) {
    const target = targetPath(input);
    if (!target) return ask(`Wanigan could not tell which file ${tool} would change. Approve it if the path is inside the project.`, 'project.unknown-target');
    if (!root) {
      return ask(`Wanigan does not know this session’s project directory, so it cannot tell whether ${absolutise(env, null, target)} is inside it. Approve it if it is.`, 'project.no-root');
    }
    if (!insideRoot(env, root, target)) {
      return ask(`${tool} targets ${absolutise(env, root, target)}, which is outside ${root}. Approve it if that is where the change belongs, or raise this project to ${TRUST_COPY.trusted.label} in Settings to stop being asked.`, 'project.write-outside');
    }
    return allow(`${tool} stays inside the project.`, 'project.write-inside');
  }
  return allow(`${TRUST_COPY.project.label} allows everything that is not a write or a command outside the project.`, 'project.allow');
}

/**
 * An 'ask' is a question, and a question needs somebody to answer it. On an
 * unattended run there is nobody, so the ask becomes a denial that says so and
 * tells the agent what to do instead.
 */
export function nobodyToAsk(d: PolicyDecision): PolicyDecision {
  if (d.decision !== 'ask') return d;
  return {
    decision: 'deny',
    reason: `This run is unattended, so there was nobody to put the question to and Wanigan denied it. Finish the work that does not need this, and say in your final message that this step needs an operator. The question was: ${d.reason}`,
    rule: `${d.rule}.unattended`,
  };
}
