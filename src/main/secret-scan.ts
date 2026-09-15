import { createHash, createHmac, randomBytes } from 'node:crypto';
import { devNull } from 'node:os';
import { runGit, scopeOf, type GitRun } from './git';
import {
  MAX_LISTED_FINDINGS, scanPatch,
  type PatchScan, type SecretFinding, type SecretScanReport,
} from '../shared/secret-scan';

/**
 * Secrets caught before they leave: what a commit would record and what a push
 * would publish, read from git and scanned before either one runs.
 *
 * The check lives here and not in the renderer because the renderer is not the
 * only thing that can ask main to commit. The Git view scans first so it can
 * show the findings, but the commit and push handlers scan again themselves and
 * go past a finding only when the request carries this scan's digest back — a
 * hash of the action and every finding, fingerprints included. So "Commit
 * anyway" acknowledges exactly the list that was on the screen: a different
 * secret staged since, or a finding that appeared after the panel was drawn,
 * produces a different digest and the action is refused again.
 *
 * Fingerprints are keyed with a secret made fresh in each process. The digest
 * reaches the renderer, and a plain hash of a short password could be guessed
 * back out of it; a keyed one cannot, and an acknowledgement has no reason to
 * outlive the process that computed it.
 *
 * Every git here runs with its filesystem monitor, external diff drivers and
 * textconv filters off, and with its path prefixes pinned. The first three are
 * commands a repository's own config can name, and a check made on the
 * operator's behalf must not be what runs them; the prefixes are what the
 * patch parser reads file names from, and `diff.noprefix` in someone's config
 * would otherwise file every finding under no name at all.
 *
 * Bounded, and the bound is said. A diff past SCAN_LIMITS.bytes is read up to
 * that point and the report says the rest was not checked; a push of more
 * commits than SCAN_LIMITS.commits reads the newest ones and says how many it
 * left out. Either needs the same acknowledgement a finding does, because a scan
 * that stopped early is not a scan that found nothing.
 */

const FINGERPRINT_KEY = randomBytes(32);

export const SCAN_LIMITS = {
  bytes: 16 * 1024 * 1024,
  commits: 200,
  timeoutMs: 60_000,
} as const;

const SAFE = ['-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false'];
const PATCH_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv', '--no-relative', '-U0', '-M', '--src-prefix=a/', '--dst-prefix=b/'];

export type ScanRequest =
  | { action: 'commit'; all: boolean; amend: boolean }
  | { action: 'push'; setUpstream: boolean; branch: string | null };

/** A branch name as `git push -u origin <name>` would take it; the same narrow rule git.ts applies. */
function branchName(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.startsWith('-') || /[\s\u0000-\u001f\u007f]/.test(value) || value.length > 250) {
    throw new Error('A push scan needs a plain branch name.');
  }
  return value;
}

/** Renderer input, narrowed. Anything that is not one of the two shapes is refused rather than guessed at. */
export function scanRequest(input: unknown): ScanRequest {
  const body = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  if (body.action === 'commit') return { action: 'commit', all: body.all === true, amend: body.amend === true };
  if (body.action === 'push') return { action: 'push', setUpstream: body.setUpstream === true, branch: branchName(body.branch) };
  throw new Error('A secret scan is for a commit or a push.');
}

function lastWord(r: GitRun): string {
  if (r.killed) return 'git did not answer in time';
  const lines = r.err.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? 'git gave no reason';
}

async function resolves(repoRoot: string, rev: string): Promise<string | null> {
  const r = await runGit(repoRoot, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], { timeout: 8_000 });
  const sha = r.out.trim();
  return r.ok && sha ? sha : null;
}

async function emptyTree(repoRoot: string): Promise<string> {
  const r = await runGit(repoRoot, ['hash-object', '-t', 'tree', devNull], { timeout: 8_000 });
  return r.out.trim() || '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
}

type Read =
  | { kind: 'patches'; scope: string; patches: Array<{ patch: string; commit: string | null }>; partial: string | null }
  | { kind: 'unreadable'; scope: string; reason: string };

function megabytes(n: number): string {
  return `${Math.round(n / (1024 * 1024))} MB`;
}

/** A patch read up to the byte bound: whole lines only, and a sentence when it stopped early. */
function bounded(r: GitRun, scope: string): { text: string; partial: string | null } | { reason: string } {
  if (r.ok) return { text: r.out, partial: null };
  if (r.truncated) {
    const cut = r.out.lastIndexOf('\n');
    return {
      text: cut >= 0 ? r.out.slice(0, cut) : '',
      partial: `${scope} ran past the ${megabytes(SCAN_LIMITS.bytes)} Wanigan reads for this check, and what came after that point was not scanned`,
    };
  }
  return { reason: `git could not list ${scope}: ${lastWord(r)}` };
}

async function readCommit(repoRoot: string, req: Extract<ScanRequest, { action: 'commit' }>): Promise<Read> {
  const head = await resolves(repoRoot, 'HEAD');
  let args: string[];
  let scope: string;
  if (req.amend) {
    // An amended commit replaces HEAD, so everything it will hold is new
    // relative to HEAD's parent — including what HEAD already carried.
    const parent = head ? await resolves(repoRoot, 'HEAD^') : null;
    args = ['diff', '--cached', ...PATCH_FLAGS, parent ?? await emptyTree(repoRoot)];
    scope = 'the amended commit';
  } else if (req.all) {
    // `commit -a` records every tracked file as it is on disk: the working tree
    // against HEAD, which never lists an untracked file.
    args = ['diff', ...PATCH_FLAGS, head ?? await emptyTree(repoRoot)];
    scope = 'the tracked changes';
  } else {
    args = ['diff', '--cached', ...PATCH_FLAGS];
    scope = 'the staged changes';
  }
  const r = await runGit(repoRoot, [...SAFE, ...args], { timeout: SCAN_LIMITS.timeoutMs, maxBuffer: SCAN_LIMITS.bytes });
  const read = bounded(r, scope);
  if ('reason' in read) return { kind: 'unreadable', scope, reason: read.reason };
  return { kind: 'patches', scope, patches: [{ patch: read.text, commit: null }], partial: read.partial };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/**
 * What a push would publish, as a revision range.
 *
 * With an upstream, the commits on HEAD it does not have. Without one, the
 * commits the branch has that origin/<branch> does not, measured from their
 * merge base; and when origin has no such branch at all — a first push — the
 * commits no origin ref already contains. A secret added in one commit and
 * removed in the next is still published by the push, so each commit's own
 * patch is scanned rather than the difference between the ends.
 *
 * A merge commit prints no patch of its own here, so a line written while
 * resolving a merge — rather than in either side's commits, which are read — is
 * not scanned. The combined diff that would show it marks lines in a column per
 * parent, which the unified-diff reader does not parse.
 */
async function pushRange(repoRoot: string, req: Extract<ScanRequest, { action: 'push' }>): Promise<{ range: string[]; scope: string } | { reason: string }> {
  if (!req.setUpstream) {
    const up = await runGit(repoRoot, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { timeout: 8_000 });
    const upstream = up.ok ? up.out.trim() : '';
    if (upstream && await resolves(repoRoot, '@{upstream}')) {
      return { range: ['@{upstream}..HEAD'], scope: `the commits not yet on ${upstream}` };
    }
  }
  const current = (await runGit(repoRoot, ['branch', '--show-current'], { timeout: 8_000 })).out.trim();
  const branch = req.branch ?? current;
  if (!branch) return { reason: 'HEAD is detached, so there is no branch whose push could be checked' };
  const tip = await resolves(repoRoot, `refs/heads/${branch}`);
  if (!tip) return { reason: `there is no local branch named ${branch} to check` };
  const remote = await resolves(repoRoot, `refs/remotes/origin/${branch}`);
  if (remote) {
    const mb = await runGit(repoRoot, ['merge-base', remote, tip], { timeout: 20_000 });
    const base = mb.out.trim();
    if (mb.ok && base) return { range: [`${base}..${tip}`], scope: `the commits not yet on origin/${branch}` };
    return { range: [tip, '--not', remote], scope: `the commits not yet on origin/${branch}` };
  }
  return { range: [tip, '--not', '--remotes=origin'], scope: `the commits on ${branch} that no origin branch has` };
}

async function readPush(repoRoot: string, req: Extract<ScanRequest, { action: 'push' }>): Promise<Read> {
  const found = await pushRange(repoRoot, req);
  if ('reason' in found) return { kind: 'unreadable', scope: 'this push', reason: found.reason };
  const counted = await runGit(repoRoot, ['rev-list', '--count', ...found.range], { timeout: 20_000 });
  const total = Number(counted.out.trim());
  if (!counted.ok || !Number.isFinite(total)) {
    return { kind: 'unreadable', scope: found.scope, reason: `git could not count ${found.scope}: ${lastWord(counted)}` };
  }
  if (total === 0) return { kind: 'patches', scope: found.scope, patches: [], partial: null };
  const r = await runGit(repoRoot, [
    ...SAFE, 'log', '--reverse', `--max-count=${SCAN_LIMITS.commits}`, '--format=%x1e%H', '--no-show-signature',
    '-p', ...PATCH_FLAGS, ...found.range,
  ], { timeout: SCAN_LIMITS.timeoutMs, maxBuffer: SCAN_LIMITS.bytes });
  const read = bounded(r, found.scope);
  if ('reason' in read) return { kind: 'unreadable', scope: found.scope, reason: read.reason };
  const patches = read.text.split('\x1e').filter((chunk) => chunk.trim()).map((chunk) => {
    const nl = chunk.indexOf('\n');
    return { commit: (nl < 0 ? chunk : chunk.slice(0, nl)).trim(), patch: nl < 0 ? '' : chunk.slice(nl + 1) };
  });
  const skipped = Math.max(0, total - SCAN_LIMITS.commits);
  const partial = [
    skipped ? `only the newest ${plural(SCAN_LIMITS.commits, 'commit')} of ${plural(total, 'commit')} were read, so ${plural(skipped, 'older commit')} ${skipped === 1 ? 'was' : 'were'} not scanned` : null,
    read.partial,
  ].filter(Boolean).join('; ') || null;
  const scope = `${found.scope} (${plural(total, 'commit')})`;
  return { kind: 'patches', scope, patches, partial };
}

function fingerprint(secret: string): string {
  return createHmac('sha256', FINGERPRINT_KEY).update(secret).digest('hex');
}

function digestOf(action: ScanRequest['action'], findings: readonly SecretFinding[], partial: string | null, unreadable: string | null): string {
  return createHash('sha256').update(JSON.stringify({
    v: 1, action, partial, unreadable,
    findings: findings.map((f) => [f.file, f.line, f.rule, f.commit, f.fingerprint]),
  })).digest('hex');
}

/** Scan what `request` would commit or push in the repository `dir` belongs to. */
export async function scanFor(dir: string, input: unknown): Promise<SecretScanReport> {
  const request = scanRequest(input);
  const scope = await scopeOf(dir);
  const read: Read = scope
    ? request.action === 'commit' ? await readCommit(scope.repoRoot, request) : await readPush(scope.repoRoot, request)
    : { kind: 'unreadable', scope: 'this folder', reason: 'it is not a git repository' };
  const scans: PatchScan[] = read.kind === 'patches'
    ? read.patches.map(({ patch, commit }) => scanPatch(patch, { commit, fingerprint }))
    : [];
  const findings = scans.flatMap((s) => s.findings);
  const partial = read.kind === 'patches' ? read.partial : null;
  const unreadable = read.kind === 'unreadable' ? read.reason : null;
  return {
    action: request.action,
    scope: read.scope,
    findings: findings.slice(0, MAX_LISTED_FINDINGS).map(({ fingerprint: _drop, ...view }) => view),
    omitted: Math.max(0, findings.length - MAX_LISTED_FINDINGS),
    suppressed: scans.reduce((n, s) => n + s.suppressed, 0),
    addedLines: scans.reduce((n, s) => n + s.addedLines, 0),
    partial,
    unreadable,
    digest: digestOf(request.action, findings, partial, unreadable),
    needsAcknowledgement: findings.length > 0 || partial !== null || unreadable !== null,
    at: Date.now(),
  };
}

const DONE = { commit: 'committed', push: 'pushed' } as const;
const ANYWAY = { commit: 'Commit anyway', push: 'Push anyway' } as const;

/** The sentence a refused commit or push is thrown with. */
export function refusal(scan: SecretScanReport, stale: boolean): string {
  const act = scan.action;
  const count = scan.findings.length + scan.omitted;
  if (stale) {
    return `What Wanigan found in ${scan.scope} changed after it was shown, so nothing was ${DONE[act]}. Review the list again before choosing ${ANYWAY[act]}.`;
  }
  if (scan.unreadable) {
    return `Wanigan could not check ${scan.scope} for secrets (${scan.unreadable}), so nothing was ${DONE[act]}. Choose ${ANYWAY[act]} to go ahead without the check.`;
  }
  const found = count
    ? `Wanigan found ${plural(count, 'possible secret')} in ${scan.scope}`
    : `Wanigan could not read all of ${scan.scope}`;
  const cut = scan.partial ? ` (${scan.partial})` : '';
  return `${found}${cut}, so nothing was ${DONE[act]}. Review ${count ? 'them' : 'what was skipped'} and choose ${ANYWAY[act]} if ${count ? 'they are not secrets' : 'you accept that'}.`;
}

/**
 * Scan again and go on only if nothing needs acknowledging, or if `acknowledge`
 * is this scan's digest. Main's half of "Commit anyway": the renderer's panel is
 * the explanation, and this is the check.
 */
export async function requireAcknowledged(dir: string, request: ScanRequest, acknowledge: unknown): Promise<SecretScanReport> {
  const scan = await scanFor(dir, request);
  if (!scan.needsAcknowledgement) return scan;
  if (typeof acknowledge === 'string' && acknowledge === scan.digest) return scan;
  throw new Error(refusal(scan, typeof acknowledge === 'string' && acknowledge.length > 0));
}
