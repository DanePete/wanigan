import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { db } from './db';
import { getSetting, setSetting } from './settings';
import { TRUST_COPY, TRUST_LEVELS } from '../shared/types';
import type { HookInput, LedgerEntry, PolicyDecision, TrustLevel } from '../shared/types';

/**
 * Trust levels and the ledger.
 *
 * Wanigan launches agents at permission modes up to bypassPermissions and runs
 * shell commands as a batch data source. Both are things an operator can
 * legitimately want; neither should happen without a row somewhere saying it
 * did. This module answers one question — "may this tool call proceed?" — and
 * writes down the answer.
 */

export type PolicyContext = {
  sessionId: string | null;
  projectId: string | null;
  projectPath: string | null;
  trust: TrustLevel;
  /**
   * Whether a human is sitting in front of this run. Optional, and only ever
   * read as `=== false`: an absent value means "nobody said", and not knowing is
   * not grounds for denying a call or for telling an agent it is alone. The
   * headless fan-out is the one caller that sets it, and it sets it false.
   */
  attended?: boolean;
};

/* ── trust levels ─────────────────────────────────────────────────────── */

const DEFAULT_TRUST_KEY = 'default_trust';

function asTrust(v: unknown): TrustLevel | null {
  return typeof v === 'string' && (TRUST_LEVELS as readonly string[]).includes(v) ? (v as TrustLevel) : null;
}

function requireTrust(level: TrustLevel): TrustLevel {
  const t = asTrust(level);
  if (!t) {
    throw new Error(
      `Unknown trust level "${String(level)}". Use one of: ${TRUST_LEVELS.join(', ')}.`
    );
  }
  return t;
}

/**
 * 'project' is the only defensible default. 'readonly' makes a fresh install
 * look broken, which teaches the user to turn the whole feature off; 'trusted'
 * makes the ledger the only thing between an agent and the home directory.
 */
export function defaultTrust(): TrustLevel {
  return asTrust(getSetting(DEFAULT_TRUST_KEY, 'project')) ?? 'project';
}

export function setDefaultTrust(level: TrustLevel): void {
  setSetting(DEFAULT_TRUST_KEY, requireTrust(level));
}

export function trustFor(projectId: string | null): TrustLevel {
  if (!projectId) return defaultTrust();
  const row = db()
    .prepare('SELECT trust FROM project_trust WHERE project_id = ?')
    .get(projectId) as { trust: string } | undefined;
  // An unrecognised stored value falls back rather than throwing: a bad row in
  // the database must never be able to stop every session from starting.
  return asTrust(row?.trust) ?? defaultTrust();
}

export function setTrust(projectId: string, level: TrustLevel): void {
  db()
    .prepare(
      `INSERT INTO project_trust (project_id, trust, set_at) VALUES (?,?,?)
       ON CONFLICT(project_id) DO UPDATE SET trust=excluded.trust, set_at=excluded.set_at`
    )
    .run(projectId, requireTrust(level), Date.now());
}

/* ── tool classification ──────────────────────────────────────────────── */

/**
 * What 'readonly' allows.
 *
 * WebFetch and WebSearch are reads, but they are reads that leave the machine,
 * and a URL is a fine place to put text you were only supposed to read. They
 * are allowed here deliberately — a level that cannot look anything up is a
 * level nobody keeps switched on. Note the drift this leaves behind:
 * TRUST_COPY.readonly tells the user "network calls are denied", which is a
 * promise this list does not keep. The copy in shared/types.ts is the half that
 * is wrong; fix it there rather than quietly denying WebFetch here, because a
 * user who has read that sentence is making decisions based on it.
 */
const READ_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'NotebookRead', 'TodoWrite',
  'ExitPlanMode', 'ListMcpResourcesTool', 'ReadMcpResourceTool', 'ReadMcpResourceDirTool',
]);

/** Tools whose whole purpose is to change something on this machine. */
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'ApplyPatch']);

/** Codex and Claude Code name the same capability differently. */
const SHELL_TOOLS = new Set(['bash', 'shell', 'local_shell', 'exec_command', 'run_command', 'run_terminal_cmd']);

function isShellTool(tool: string, input: HookInput): boolean {
  if (tool === 'SlashCommand') return false; // its `command` is a slash command, not a shell line
  if (SHELL_TOOLS.has(tool.toLowerCase())) return true;
  return typeof input.tool_input?.command === 'string';
}

function mcpTool(tool: string): { server: string; name: string } | null {
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

const MCP_READ_VERB = /^(get|list|read|search|fetch|query|describe|find|view|show|lookup|inspect|count|check|preview|summar)/i;

/* ── path containment ─────────────────────────────────────────────────── */

const PATH_KEYS = ['file_path', 'notebook_path', 'path', 'filePath', 'notebookPath', 'target_file', 'absolute_path'];

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function targetPath(input: HookInput): string {
  const ti = input.tool_input ?? {};
  for (const k of PATH_KEYS) {
    const v = str(ti[k]);
    if (v) return v;
  }
  return '';
}

function expandHome(p: string): string {
  const home = os.homedir();
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return p.replace(/^\$\{?HOME\}?(?=\/|$)/, home);
}

function prefixed(base: string, full: string): boolean {
  return full === base || full.startsWith(base + path.sep);
}

/**
 * Resolve a path to its nearest existing ancestor's real location. A file that
 * does not exist yet — the normal case for Write — cannot be realpath'd, but
 * the directory that will hold it can, and that is where a symlink would be.
 */
function realish(p: string): string {
  let cur = p;
  const rest: string[] = [];
  for (let i = 0; i < 64; i++) {
    try {
      return path.join(fs.realpathSync(cur), ...[...rest].reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return p;
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
  return p;
}

/**
 * Containment is decided AFTER resolution, never by hunting for '..' in the raw
 * string: 'notes..md' is a legitimate filename, and '/etc/passwd' never needed
 * a '..' to get there. path.resolve collapses the traversal, then both ends go
 * through realpath and the prefix test decides.
 *
 * Both ends, not just the target. A symlink inside the project pointing at
 * ~/.ssh is lexically inside and must still be denied — but on macOS a project
 * added as /tmp/x really lives at /private/tmp/x, and comparing a real path
 * against a lexical root would deny every write in it. Resolving the root too
 * closes the first hole without opening the second.
 */
function insideRoot(root: string, target: string): boolean {
  const base = path.resolve(root);
  const full = path.resolve(base, expandHome(target));
  return prefixed(realish(base), realish(full));
}

function absolutise(root: string | null, target: string): string {
  const t = expandHome(target);
  return path.resolve(root ? path.resolve(root) : process.cwd(), t);
}

/* ── credentials ──────────────────────────────────────────────────────── */

/**
 * Home-anchored only. A project's own .claude/ directory is ordinary work and
 * agents edit it constantly; ~/.claude holds the credentials for every session
 * Wanigan will ever run, and the two must not be confused.
 */
const CREDENTIAL_PATHS = ['.ssh', '.aws', '.claude', '.gnupg', '.docker', '.kube', '.npmrc', '.netrc', path.join('.config', 'gh')];

/**
 * Resolved on both ends, for the same reason insideRoot is. A lexical compare
 * here was the whole hole: a dotfiles repo containing `ssh -> ~/.ssh` puts a
 * private key at a path that is lexically inside the project, and nothing else
 * checks reads — readonlyDecision allows every READ_TOOLS entry outright and
 * projectDecision only path-checks writes and shell commands. So the key could
 * be read and then handed to WebFetch, with notableAllow writing no ledger row
 * for either. The raw prefix test is kept alongside as the cheap first answer.
 */
function credentialHit(abs: string): string | null {
  const home = os.homedir();
  const real = realish(abs);
  for (const rel of CREDENTIAL_PATHS) {
    const root = path.join(home, rel);
    if (prefixed(root, abs) || prefixed(realish(root), real)) return root;
  }
  return null;
}

/** Path-shaped tokens in a shell command, absolute or home-relative. */
const PATH_TOKEN = /(?:~|\$\{?HOME\}?|\/)[^\s;|&'"<>()]*/g;

function credentialTarget(input: HookInput, root: string | null): string | null {
  const p = targetPath(input);
  if (p) {
    const hit = credentialHit(absolutise(root, p));
    if (hit) return hit;
  }
  const cmd = str(input.tool_input?.command);
  for (const token of cmd.match(PATH_TOKEN) ?? []) {
    const hit = credentialHit(absolutise(root, token));
    if (hit) return hit;
  }
  return null;
}

/* ── shell inspection ─────────────────────────────────────────────────── */

/**
 * THIS IS DEFENCE IN DEPTH OVER THE OS SANDBOX. IT IS NOT CONTAINMENT.
 *
 * Everything below is a string matcher over a shell command, which makes it a
 * speed bump. It is bypassed by `$(printf '\x72\x6d')`, by an alias, by a make
 * target, by a script the agent wrote thirty seconds ago, by base64, by any
 * indirection at all. The 2026 CVEs did not even need that much:
 * CVE-2026-22708 poisoned a Cursor execution environment so that an
 * allowlisted `git branch` delivered the payload, and CVE-2025-59532 showed a
 * Codex CLI sandbox boundary being redefined by the agent's own output.
 * Neither would have tripped a single rule here, because neither ran a command
 * that looked dangerous.
 *
 * What these rules buy is a pause and a ledger row on the shapes a human would
 * recognise on sight. Real containment is the OS sandbox, a container, or a
 * machine you are willing to rebuild. This comment exists so that nobody later
 * reads the list below, concludes Wanigan blocks bad commands, and ships
 * something genuinely dangerous behind it.
 *
 * Known and deliberate holes, so the shape of the gap is on the record: no
 * variable expansion, no alias or function resolution, no quoting-aware
 * tokenizer, and no follow-through on a two-step `curl -o x && sh x`.
 */

type BashFinding = { rule: string; reason: string };

const PIPE_TO_INTERPRETER =
  /\b(?:curl|wget)\b[^|]*\|\s*(?:sudo\s+)?(?:[\w./-]*\/)?(?:sh|bash|zsh|ksh|dash|python[\d.]*|node|perl|ruby)\b/i;
const PROCESS_SUB_FETCH = /\b(?:sh|bash|zsh|source|\.)\s+<\(\s*(?:curl|wget)\b/i;
const FORK_BOMB = /:\s*\(\s*\)\s*\{.*\|.*&.*\}\s*;\s*:/;
const RAW_DISK = /\b(?:mkfs(?:\.\w+)?|diskutil\s+erase\w*)\b|\bdd\b[^|;&]*\bof=\/dev\//i;
const PROTECTED_BRANCHES = new Set(['main', 'master', 'trunk', 'develop', 'production', 'prod', 'release', 'staging']);
/** Commands whose job is to change something at their target path. */
const MUTATING_BINARIES = new Set(['rm', 'rmdir', 'mv', 'cp', 'tee', 'install', 'ln', 'chmod', 'chown', 'chgrp', 'touch', 'mkdir', 'truncate', 'shred', 'unlink', 'rsync']);
/** Of those, the ones that only write to their final argument. */
const DEST_ONLY = new Set(['cp', 'mv', 'ln', 'install', 'rsync']);

function segments(command: string): string[] {
  return command.split(/\n|;|&&|\|\||\||&/).map((s) => s.trim()).filter(Boolean);
}

function tokens(segment: string): string[] {
  return segment.match(/(?:"[^"]*"|'[^']*'|[^\s])+/g)?.map((t) => t.replace(/^['"]|['"]$/g, '')) ?? [];
}

/** Tokens we cannot evaluate — a guess here would be a lie either way. */
function opaque(token: string): boolean {
  return token.includes('$(') || token.includes('`') || /\$\{?[A-Za-z_]/.test(token.replace(/^\$\{?HOME\}?/, ''));
}

function inspectBash(command: string, root: string | null): BashFinding | null {
  if (PIPE_TO_INTERPRETER.test(command) || PROCESS_SUB_FETCH.test(command)) {
    return {
      rule: 'bash.curl-pipe-shell',
      reason: 'This pipes a download straight into an interpreter, so what runs is whatever the server returns at that moment. Download it, read it, then run it.',
    };
  }
  if (FORK_BOMB.test(command)) {
    return { rule: 'bash.fork-bomb', reason: 'This is a fork bomb. It will take the machine down until it is rebooted.' };
  }
  if (RAW_DISK.test(command)) {
    return { rule: 'bash.raw-disk', reason: 'This writes to a raw device or reformats a volume. Run it yourself, from a shell, if you truly mean it.' };
  }

  for (const seg of segments(command)) {
    // Matched on the leading token rather than anywhere in the string, so that
    // `echo sudo` and `grep sudo /var/log` are not denials.
    if (tokens(seg)[0] === 'sudo') {
      return { rule: 'bash.sudo', reason: 'sudo puts the command outside the project by definition. Run it yourself if you meant it.' };
    }
    const found = inspectRedirects(seg, root) ?? inspectGitPush(seg) ?? inspectMutation(seg, root);
    if (found) return found;
  }
  return null;
}

/** `>` / `>>` to an absolute or home path outside the project. */
function inspectRedirects(segment: string, root: string | null): BashFinding | null {
  if (!root) return null;
  const re = /(?:^|[^0-9>&])>>?\s*(['"]?)((?:~|\$\{?HOME\}?|\/)[^\s;|&'"<>]*)\1/g;
  for (const m of segment.matchAll(re)) {
    const target = m[2];
    if (opaque(target)) continue;
    const abs = absolutise(root, target);
    if (abs === '/dev/null' || abs.startsWith('/dev/std') || abs === '/dev/tty') continue;
    if (!insideRoot(root, abs)) {
      return {
        rule: 'bash.redirect-outside',
        reason: `This redirects output into ${abs}, which is outside the project. Write it inside the project, or raise this project to ${TRUST_COPY.trusted.label}.`,
      };
    }
  }
  return null;
}

function inspectGitPush(segment: string): BashFinding | null {
  const t = tokens(segment);
  if (t[0] !== 'git' || !t.includes('push')) return null;
  // --force-with-lease is the careful version and stays allowed: it refuses the
  // push if the remote moved, which is the whole failure mode being guarded.
  const forced = t.some((x) => x === '--force' || x === '-f' || x === '--mirror') || t.some((x) => /^\+/.test(x));
  if (!forced) return null;
  const named = t.filter((x) => !x.startsWith('-')).map((x) => x.replace(/^\+/, '').split(':').pop() ?? '');
  const hit = named.find((x) => PROTECTED_BRANCHES.has(x)) ?? (t.includes('--mirror') || t.includes('--all') ? 'every branch' : null);
  if (!hit) return null;
  return {
    rule: 'bash.force-push-protected',
    reason: `A force push to ${hit} rewrites history other people have already pulled. Push a feature branch instead, or use --force-with-lease after a fetch.`,
  };
}

/** A mutating command whose target resolves outside the project. */
function inspectMutation(segment: string, root: string | null): BashFinding | null {
  const t = tokens(segment);
  const bin = path.basename(t[0] ?? '');
  if (!MUTATING_BINARIES.has(bin)) return null;

  // `rm` and `chmod` mutate every path they are given; `cp` and `mv` mutate
  // only the last one. Checking a copy's source would deny `cp /etc/hosts ./x`,
  // which reads a file the agent could have read anyway.
  const args = t.slice(1).filter((x) => !x.startsWith('-'));
  const candidates = DEST_ONLY.has(bin) ? args.slice(-1) : args;

  for (const token of candidates) {
    if (opaque(token)) continue;
    // A glob is judged by the directory it expands within — 'rm -rf /*' is 'rm -rf /'.
    const candidate = /[*?]/.test(token) ? path.dirname(token.replace(/[*?].*$/, 'x')) : token;
    if (!candidate) continue;
    const abs = absolutise(root, candidate);
    if (abs === path.parse(abs).root || abs === os.homedir()) {
      return {
        rule: 'bash.destructive-root',
        reason: `This runs ${bin} against ${abs}. Nothing an agent is asked to do needs that; run it yourself if you meant it.`,
      };
    }
    if (root && !insideRoot(root, abs)) {
      return {
        rule: 'bash.target-outside',
        reason: `This ${bin}s ${abs}, which is outside the project. Keep the change inside the project, or raise this project to ${TRUST_COPY.trusted.label}.`,
      };
    }
  }
  return null;
}

/* ── the decision ─────────────────────────────────────────────────────── */

function allow(reason: string, rule: string): PolicyDecision {
  return { decision: 'allow', reason, rule };
}
function deny(reason: string, rule: string): PolicyDecision {
  return { decision: 'deny', reason, rule };
}
function ask(reason: string, rule: string): PolicyDecision {
  return { decision: 'ask', reason, rule };
}

export function decideFor(ctx: PolicyContext, input: HookInput): PolicyDecision {
  const tool = (input.tool_name ?? '').trim();
  if (!tool) return allow('Not a tool call.', 'no-tool');

  // Checked before anything else so that TRUST_COPY.trusted — "Nothing is
  // denied by Wanigan" — stays literally true.
  if (ctx.trust === 'trusted') {
    return allow(`${TRUST_COPY.trusted.label}: Wanigan denies nothing here.`, 'trusted.allow');
  }

  const cred = credentialTarget(input, ctx.projectPath);
  if (cred) {
    return deny(
      `This touches ${cred}, where your credentials live. Reading a private key is half of an exfiltration; do it yourself if you genuinely meant to.`,
      'credential-path'
    );
  }

  return ctx.trust === 'readonly' ? readonlyDecision(tool, input) : projectDecision(ctx, tool, input);
}

function readonlyDecision(tool: string, input: HookInput): PolicyDecision {
  const mcp = mcpTool(tool);
  if (mcp) {
    return MCP_READ_VERB.test(mcp.name)
      ? allow(`${mcp.server} ${mcp.name} reads.`, 'readonly.mcp-read')
      : deny(
          `${mcp.server} ${mcp.name} is not a read, and ${TRUST_COPY.readonly.label} allows only reads. Set this project to ${TRUST_COPY.project.label} if the agent should be able to change things.`,
          'readonly.mcp-write'
        );
  }
  if (READ_TOOLS.has(tool)) return allow(`${tool} reads.`, 'readonly.read');
  if (isShellTool(tool, input)) {
    return deny(
      `Shell commands are denied at ${TRUST_COPY.readonly.label} trust. Set this project to ${TRUST_COPY.project.label} in Settings if the agent needs to run commands.`,
      'readonly.shell'
    );
  }
  if (WRITE_TOOLS.has(tool)) {
    return deny(
      `${tool} changes files, and ${TRUST_COPY.readonly.label} denies that. Set this project to ${TRUST_COPY.project.label} in Settings if the agent should be able to edit the repo.`,
      'readonly.write'
    );
  }
  // Unknown tool at the strictest level: denying blocks harmless things and
  // allowing defeats the level, so hand it to the person who can tell.
  return ask(
    `Wanigan does not know what ${tool} does, and ${TRUST_COPY.readonly.label} allows only known reads. Approve it if it only reads.`,
    'readonly.unknown'
  );
}

function projectDecision(ctx: PolicyContext, tool: string, input: HookInput): PolicyDecision {
  const root = ctx.projectPath;

  if (isShellTool(tool, input)) {
    const command = str(input.tool_input?.command);
    const found = inspectBash(command, root);
    if (found) return deny(found.reason, found.rule);
    if (!root) {
      return ask(
        `Wanigan does not know this session's project directory, so it cannot tell whether this command stays inside it. Approve it if you know where it runs.`,
        'project.no-root'
      );
    }
    return allow('Command shows none of the escapes Wanigan checks for.', 'project.command');
  }

  if (WRITE_TOOLS.has(tool)) {
    const target = targetPath(input);
    if (!target) {
      return ask(`Wanigan could not tell which file ${tool} would change. Approve it if the path is inside the project.`, 'project.unknown-target');
    }
    if (!root) {
      return ask(
        `Wanigan does not know this session's project directory, so it cannot tell whether ${absolutise(null, target)} is inside it. Approve it if it is.`,
        'project.no-root'
      );
    }
    if (!insideRoot(root, target)) {
      return deny(
        `${tool} targets ${absolutise(root, target)}, which is outside ${root}. Keep the change inside the project, or raise this project to ${TRUST_COPY.trusted.label} in Settings.`,
        'project.write-outside'
      );
    }
    return allow(`${tool} stays inside the project.`, 'project.write-inside');
  }

  return allow(`${TRUST_COPY.project.label} allows everything that is not a write or a command outside the project.`, 'project.allow');
}

/* ── who is on the other end ──────────────────────────────────────────── */

/**
 * Contexts for runs Wanigan launched and owns the lifetime of.
 *
 * An interactive pane can be looked up in the live session list. The headless
 * fan-out cannot: its "session" is a (runId, projectId) row with no pane, no PTY
 * and no entry in that list. Without a registration here every headless tool
 * call would be judged at the default trust level with no project root — so a
 * repository the operator marked Trusted would start collecting denials, and one
 * marked Read only would be evaluated as though nothing had been set at all.
 */
const contexts = new Map<string, PolicyContext>();

export function registerPolicyContext(ctx: PolicyContext): void {
  if (!ctx.sessionId) return;
  contexts.set(ctx.sessionId, ctx);
}

/**
 * Called when the run that registered the context is over. A context left behind
 * keeps answering for an id nothing is using, with a trust level the operator
 * may have changed in the meantime.
 */
export function releasePolicyContext(sessionId: string): void {
  contexts.delete(sessionId);
}

/**
 * The registered context for a session id, or null when nothing registered one.
 *
 * Null means "Wanigan does not know", which is deliberately not the same answer
 * as "the default trust level": the caller decides what to do with not knowing,
 * and nothing here invents a project root or an attendance it cannot vouch for.
 */
export function contextForSession(sessionId: string | null): PolicyContext | null {
  if (!sessionId) return null;
  return contexts.get(sessionId) ?? null;
}

/**
 * An 'ask' is a question, and a question needs somebody to answer it.
 *
 * On an unattended run there is nobody: headless.ts spawns with stdin on
 * /dev/null precisely because there is no keyboard, so an 'ask' handed back to
 * the CLI is not a checkpoint — it is the row sitting still until its per-repo
 * timeout fires and reports a timeout for something that was only ever waiting
 * to be asked. Denying says the true thing, costs one tool call rather than the
 * whole timeout, and leaves the agent free to do the rest of its work.
 */
function nobodyToAsk(d: PolicyDecision): PolicyDecision {
  if (d.decision !== 'ask') return d;
  return {
    decision: 'deny',
    reason: `This run is unattended, so there was nobody to put the question to and Wanigan denied it. The question was: ${d.reason}`,
    rule: `${d.rule}.unattended`,
  };
}

/**
 * The answer when the gate itself failed — a rule that threw, or a ledger write
 * that did.
 *
 * On an attended session no answer is the right answer: the CLI falls back to
 * its own permission prompt and a human decides. On an unattended run there is
 * no prompt and no human, so "no answer" means the call runs unexamined and
 * unrecorded, on the one surface Wanigan deliberately launches at
 * bypassPermissions. That is the exact thing the ledger exists to prevent.
 *
 * The failure mode if this misfires is bounded and loud on purpose. It is a
 * denial, not a hang: every tool call in the run gets this sentence back, the
 * agent stops early instead of waiting, the row still lands inside its per-repo
 * timeout, and 'unattended.unevaluable' is one ledger query away — so a run that
 * hit this looks nothing like a run that simply had little to do.
 */
function unevaluable(): PolicyDecision {
  return deny(
    'Wanigan could not work out whether this call is allowed, and this run has nobody at the keyboard to ask, ' +
    'so it was denied rather than allowed. Open this repository as an interactive session if you need to approve it yourself.',
    'unattended.unevaluable'
  );
}

/**
 * Decide, write it down, and fail in the direction this particular run can
 * survive. One function because the three are one answer: a decision nobody
 * recorded and a refusal nobody explained are each worse than no gate at all.
 */
export function answerFor(ctx: PolicyContext, input: HookInput): PolicyDecision | null {
  try {
    const decided = decideFor(ctx, input);
    const answer = ctx.attended === false ? nobodyToAsk(decided) : decided;
    recordDecision(ctx, input, answer);
    return answer;
  } catch {
    if (ctx.attended !== false) return null;
    const refusal = unevaluable();
    // Best effort: if the ledger is what just threw, this writes nothing — which
    // is why the refusal above also says so to the agent, in the only channel
    // left that a person will read afterwards.
    try { recordDecision(ctx, input, refusal); } catch { /* the ledger is what failed */ }
    return refusal;
  }
}

/**
 * One sentence for the agent at SessionStart, so the constraint the operator set
 * is something it knows rather than something it discovers one denial at a time.
 *
 * Deliberately not TRUST_COPY.detail. That copy tells the user Read only denies
 * "network calls", which READ_TOOLS above does not do — see the comment there —
 * and repeating it to an agent would hand it a constraint that is not real. An
 * agent that believes it cannot look anything up stops trying. The label comes
 * from TRUST_COPY because the label is the half that is true, and the agent
 * should name the level the same way the Settings screen does.
 *
 * No budget figure appears here, and none should be added. Nothing in Wanigan
 * refuses, pauses or throttles work when a budget is breached — budgetBreached()
 * draws a banner and stops there — so a remaining-spend sentence would be
 * announcing a constraint that does not exist.
 */
export function trustBriefing(ctx: PolicyContext): string {
  const where = ctx.projectPath ? ` (${ctx.projectPath})` : '';
  const line =
    ctx.trust === 'trusted'
      ? `Wanigan is running this session at ${TRUST_COPY.trusted.label} trust: it denies nothing, and it still writes shell commands, non-read MCP calls and writes outside the working directory to its policy ledger.`
      : ctx.trust === 'readonly'
        ? `Wanigan is running this session at ${TRUST_COPY.readonly.label} trust: reads, searches and lookups are allowed, and file writes, shell commands and any MCP call that is not a read will be denied — describe the change rather than attempting it.`
        : `Wanigan is running this session at ${TRUST_COPY.project.label} trust: writes and shell commands are allowed inside the working directory${where}, and anything resolving outside it, or touching the credential directories under your home folder, will be denied.`;

  // Only for a run with nobody watching, and only because it changes what the
  // agent should expect back. Everywhere else an unevaluable call becomes a
  // prompt somebody answers, and saying this there would be false.
  return ctx.attended === false
    ? `${line} Nobody is watching this run, so a call Wanigan cannot evaluate is denied rather than queued for approval.`
    : line;
}

/* ── the ledger ───────────────────────────────────────────────────────── */

/** Anything shaped like a credential, in case a command carries one inline. */
function redact(text: string): string {
  return text
    .replace(/sk-ant-[A-Za-z0-9_-]{6,}/g, 'sk-ant-[redacted]')
    .replace(/\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Za-z0-9_]*)=\S+/gi, '$1=[redacted]')
    .replace(/\b(-{1,2}(?:password|token|api-?key))(\s+|=)\S+/gi, '$1$2[redacted]');
}

function clip(s: string, max = 400): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Built from a fixed list of fields — command, path, url, pattern — and never
 * from the whole tool_input. A Write's tool_input carries the file's entire new
 * contents and a prompt-shaped tool carries the prompt; neither belongs in a
 * table that gets exported to disk and mailed to someone.
 */
function summarise(tool: string, input: HookInput): string {
  const ti = input.tool_input ?? {};
  const cmd = str(ti.command);
  if (cmd) return clip(redact(cmd.replace(/\s+/g, ' ').trim()));
  const p = targetPath(input);
  if (p) return clip(p);
  const url = str(ti.url);
  if (url) return clip(redact(url));
  const pattern = str(ti.pattern);
  if (pattern) return clip(`${pattern}${str(ti.path) ? ` in ${str(ti.path)}` : ''}`);
  return tool;
}

/**
 * Allows are only worth a row when a reasonable person would want to find them
 * later. A Write inside the project at 'project' level is the feature working;
 * a shell command, a write outside the project, or an MCP call that changes a
 * remote system is a thing you might have to explain afterwards.
 */
function notableAllow(ctx: PolicyContext, tool: string, input: HookInput): boolean {
  if (isShellTool(tool, input)) return true;
  const mcp = mcpTool(tool);
  if (mcp) return !MCP_READ_VERB.test(mcp.name);
  if (!WRITE_TOOLS.has(tool)) return false;
  const target = targetPath(input);
  if (!target) return true;
  return !ctx.projectPath || !insideRoot(ctx.projectPath, target);
}

/**
 * policy_ledger is append-only on purpose: a record you can edit is not a
 * record. Nothing in Wanigan updates or deletes a row here, and nothing should
 * be added that does — the value of the table is that its contents cannot be
 * tidied up after the thing you would want to tidy up has happened.
 */
export function recordDecision(ctx: PolicyContext, input: HookInput, decision: PolicyDecision): void {
  const tool = (input.tool_name ?? '').trim();
  if (!tool) return;
  if (decision.decision === 'allow' && !notableAllow(ctx, tool, input)) return;

  db()
    .prepare(
      `INSERT INTO policy_ledger (at, session_id, project_id, trust, tool_name, summary, decision, rule, reason)
       VALUES (?,?,?,?,?,?,?,?,?)`
    )
    .run(
      Date.now(),
      ctx.sessionId,
      ctx.projectId,
      ctx.trust,
      tool,
      summarise(tool, input),
      decision.decision,
      decision.rule,
      decision.reason
    );
}

type LedgerRow = {
  id: number;
  at: number;
  session_id: string | null;
  project_id: string | null;
  project_name: string | null;
  trust: string;
  tool_name: string;
  summary: string;
  decision: string;
  rule: string;
  reason: string;
};

const LEDGER_SELECT = `
  SELECT l.id, l.at, l.session_id, l.project_id, p.name AS project_name, l.trust,
         l.tool_name, l.summary, l.decision, l.rule, l.reason
  FROM policy_ledger l
  LEFT JOIN projects p ON p.id = l.project_id
`;

function toEntry(r: LedgerRow): LedgerEntry {
  return {
    id: r.id,
    at: r.at,
    sessionId: r.session_id,
    projectId: r.project_id,
    projectName: r.project_name,
    trust: asTrust(r.trust) ?? 'project',
    toolName: r.tool_name,
    summary: r.summary,
    decision: r.decision === 'deny' || r.decision === 'ask' ? r.decision : 'allow',
    rule: r.rule,
    reason: r.reason,
  };
}

export function ledger(limit = 200, opts?: { deniedOnly?: boolean }): LedgerEntry[] {
  const n = Math.min(Math.max(Math.trunc(limit) || 0, 1), 5000);
  const where = opts?.deniedOnly ? "WHERE l.decision = 'deny'" : '';
  const rows = db()
    .prepare(`${LEDGER_SELECT} ${where} ORDER BY l.at DESC, l.id DESC LIMIT ?`)
    .all(n) as LedgerRow[];
  return rows.map(toEntry);
}

/**
 * Newline-delimited JSON, in the order the rows were written — the export of an
 * append-only log should read like the log. Written through one file descriptor
 * in ~256KB chunks so a long ledger is neither a syscall per row nor a single
 * string the size of the table.
 */
export function exportLedger(filePath: string): number {
  const out = path.resolve(filePath);
  let fd: number;
  try {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fd = fs.openSync(out, 'w');
  } catch (e) {
    throw new Error(
      `Could not write the ledger to ${out}: ${(e as Error).message}. Choose a folder you can write to.`
    );
  }

  let count = 0;
  try {
    const rows = db().prepare(`${LEDGER_SELECT} ORDER BY l.at ASC, l.id ASC`).iterate() as IterableIterator<LedgerRow>;
    let chunk = '';
    for (const r of rows) {
      chunk += `${JSON.stringify(toEntry(r))}\n`;
      count++;
      if (chunk.length > 256 * 1024) {
        fs.writeSync(fd, chunk);
        chunk = '';
      }
    }
    if (chunk) fs.writeSync(fd, chunk);
  } finally {
    fs.closeSync(fd);
  }
  return count;
}

export function ledgerSummary(): { denied: number; asked: number; allowed: number; since: number | null } {
  const rows = db()
    .prepare('SELECT decision, COUNT(*) AS n, MIN(at) AS first_at FROM policy_ledger GROUP BY decision')
    .all() as { decision: string; n: number; first_at: number | null }[];

  const out = { denied: 0, asked: 0, allowed: 0, since: null as number | null };
  for (const r of rows) {
    if (r.decision === 'deny') out.denied = r.n;
    else if (r.decision === 'ask') out.asked = r.n;
    else out.allowed += r.n;
    if (r.first_at !== null && (out.since === null || r.first_at < out.since)) out.since = r.first_at;
  }
  return out;
}
