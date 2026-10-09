// Secrets caught before they leave: what a commit would record and what a push
// would publish, read from git and scanned before either one runs. Ported from
// Wanigan 1 (src/main/secret-scan.ts).
//
// The window scans first so it can show the findings, but the commit and push
// methods scan again themselves and go past a finding only when the request
// carries this scan's digest back: a hash of the checked state and every finding,
// fingerprints included. So "Commit anyway" acknowledges exactly the list that
// was on the screen; a different secret staged since produces a different
// digest, and the action is refused again.
//
// Fingerprints are keyed with a secret made fresh in each core, so the digest
// that reaches the window cannot be used to guess a short password back.
//
// Bounded, and the bound is said: a diff past SCAN_LIMITS.bytes is read up to
// that point, a push of more commits than SCAN_LIMITS.commits reads the newest,
// and either needs the same acknowledgement a finding does.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { MAX_LISTED_FINDINGS, scanPatch, type PatchScan, type SecretFinding, type SecretScanReport, type SecretScanRequest } from '../shared/secret-scan.ts';
import { CoreError } from '../shared/protocol.ts';
import { runGit, type GitRun } from './git.ts';
import { pushPlan } from './git-client.ts';

const FINGERPRINT_KEY = randomBytes(32);

export const SCAN_LIMITS = { bytes: 16 * 1024 * 1024, commits: 200, timeoutMs: 60_000 } as const;

/** Repository config cannot make a scan run a filesystem monitor, an external diff or a textconv filter, or drop the path prefixes it reads. */
const SAFE = ['-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false'];
const PATCH_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv', '--no-relative', '-U0', '-M', '--src-prefix=a/', '--dst-prefix=b/'];
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** A publisher that names a branch explicitly must scan that exact destination. */
interface PushTarget { remote: string; branch: string; ref: string }

type Read =
  | { kind: 'patches'; scope: string; patches: { patch: string; commit: string | null }[]; partial: string | null }
  | { kind: 'unreadable'; scope: string; reason: string };

const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

function lastWord(r: GitRun): string {
  if (r.killed) return 'git did not answer in time';
  return r.err.split('\n').map((l) => l.trim()).filter(Boolean).at(-1) ?? 'git gave no reason';
}

/** A patch read up to the byte bound: whole lines only, and a sentence when it stopped early. */
function bounded(r: GitRun, scope: string): { text: string; partial: string | null } | { reason: string } {
  if (r.ok) return { text: r.out, partial: null };
  if (r.truncated) {
    const cut = r.out.lastIndexOf('\n');
    return { text: cut >= 0 ? r.out.slice(0, cut) : '', partial: `${scope} ran past the ${SCAN_LIMITS.bytes / 1024 / 1024} MB Wanigan reads for this check, and what came after that point was not scanned` };
  }
  return { reason: `git could not list ${scope}: ${lastWord(r)}` };
}

const resolves = async (cwd: string, rev: string): Promise<string | null> => {
  const r = await runGit(cwd, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], { timeout: 8_000 });
  return r.ok ? r.out.trim() || null : null;
};

async function readCommit(cwd: string, amend: boolean): Promise<Read> {
  let args: string[];
  let scope: string;
  if (amend) {
    // An amended commit replaces HEAD, so everything it will hold is new against HEAD's parent.
    const parent = await resolves(cwd, 'HEAD^');
    args = ['diff', '--cached', ...PATCH_FLAGS, parent ?? EMPTY_TREE];
    scope = 'the amended commit';
  } else {
    args = ['diff', '--cached', ...PATCH_FLAGS];
    scope = 'the staged changes';
  }
  const r = await runGit(cwd, [...SAFE, ...args], { timeout: SCAN_LIMITS.timeoutMs, maxBuffer: SCAN_LIMITS.bytes });
  const read = bounded(r, scope);
  if ('reason' in read) return { kind: 'unreadable', scope, reason: read.reason };
  return { kind: 'patches', scope, patches: [{ patch: read.text, commit: null }], partial: read.partial };
}

/**
 * What a push would publish: each commit's own patch, not the difference between
 * the ends, because a secret added in one commit and removed in the next is
 * still published by the push. Merges are diffed against their first parent,
 * while traversal still includes every parent: both side commits and a secret
 * introduced only by a merge resolution must be checked.
 */
async function readPush(cwd: string, target?: PushTarget): Promise<Read> {
  const plan = target
    ? { remote: target.remote, remoteBranch: target.branch, total: 0, refusal: null }
    : await pushPlan(cwd);
  if (plan.refusal && !plan.total) return { kind: 'patches', scope: 'this push', patches: [], partial: null };
  if (!plan.remote || !plan.remoteBranch) return { kind: 'unreadable', scope: 'this push', reason: plan.refusal ?? 'there is nowhere to push' };
  const tracking = `refs/remotes/${plan.remote}/${plan.remoteBranch}`;
  const head = target?.ref ?? 'HEAD';
  const [fetchUrl, pushUrls] = await Promise.all([
    runGit(cwd, ['remote', 'get-url', '--', plan.remote]),
    runGit(cwd, ['remote', 'get-url', '--push', '--all', '--', plan.remote]),
  ]);
  if (!fetchUrl.ok || !pushUrls.ok) return { kind: 'unreadable', scope: 'this push', reason: 'git could not identify the fetch and push destinations' };
  // Remote-tracking refs describe the fetch repository. A distinct push URL
  // may publish to a new repository that has none of that history. Conservatively
  // scan the full reachable history, still under the same stated bounds.
  const separateDestination = pushUrls.out.trim().split('\n').some((url) => url !== fetchUrl.out.trim());
  const range = separateDestination ? [head]
    : (await resolves(cwd, tracking)) ? [`${tracking}..${head}`] : [head, '--not', `--remotes=${plan.remote}`];
  if (target || separateDestination) {
    const count = await runGit(cwd, ['rev-list', '--count', ...range, '--']);
    if (!count.ok) return { kind: 'unreadable', scope: 'this push', reason: `git could not list the commits to publish: ${lastWord(count)}` };
    plan.total = Number(count.out.trim());
  }
  const scope = `the ${plan.total === 1 ? 'commit' : `${plan.total} commits`} going to ${plan.remote}/${plan.remoteBranch}`;
  if (!plan.total) return { kind: 'patches', scope, patches: [], partial: null };
  const r = await runGit(cwd, [
    ...SAFE, 'log', '--reverse', `--max-count=${SCAN_LIMITS.commits}`, '--format=%x1e%H', '--no-show-signature', '-p', '--diff-merges=first-parent', ...PATCH_FLAGS, ...range, '--',
  ], { timeout: SCAN_LIMITS.timeoutMs, maxBuffer: SCAN_LIMITS.bytes });
  const read = bounded(r, scope);
  if ('reason' in read) return { kind: 'unreadable', scope, reason: read.reason };
  const patches = read.text.split('\x1e').filter((chunk) => chunk.trim()).map((chunk) => {
    const nl = chunk.indexOf('\n');
    return { commit: (nl < 0 ? chunk : chunk.slice(0, nl)).trim(), patch: nl < 0 ? '' : chunk.slice(nl + 1) };
  });
  const skipped = Math.max(0, plan.total - SCAN_LIMITS.commits);
  const partial = [
    // --max-count takes the newest before --reverse orders them.
    skipped ? `only the newest ${plural(SCAN_LIMITS.commits, 'commit')} of ${plural(plan.total, 'commit')} were read, so ${plural(skipped, 'older commit')} ${skipped === 1 ? 'was' : 'were'} not scanned` : null,
    read.partial,
  ].filter(Boolean).join('; ') || null;
  return { kind: 'patches', scope, patches, partial };
}

const fingerprint = (secret: string): string => createHmac('sha256', FINGERPRINT_KEY).update(secret).digest('hex');

function digestOf(state: string, action: SecretScanRequest['action'], findings: readonly SecretFinding[], partial: string | null, unreadable: string | null): string {
  return createHash('sha256').update(JSON.stringify({
    v: 2, state, action, partial, unreadable, findings: findings.map((f) => [f.file, f.line, f.rule, f.commit, f.fingerprint]),
  })).digest('hex');
}

/** Even an incomplete scan's acknowledgement names the exact content and destination. */
async function checkedState(cwd: string, request: SecretScanRequest, target?: PushTarget): Promise<string> {
  const hash = createHash('sha256').update(JSON.stringify(request));
  const read = async (args: string[], missing = false): Promise<string> => {
    const result = await runGit(cwd, [...SAFE, ...args], { maxBuffer: SCAN_LIMITS.bytes, timeout: SCAN_LIMITS.timeoutMs });
    if (!result.ok && !(missing && result.code === 1 && !result.killed && !result.truncated)) {
      throw new CoreError('refused', 'Git could not identify the exact work for this secret check. Nothing was committed or pushed; try the check again.');
    }
    return result.ok ? result.out : '';
  };
  if (request.action === 'commit') {
    hash.update(await read(['rev-parse', '--verify', '--quiet', 'HEAD'], true));
    // Full object ids include files beyond the patch byte cap, with no blob reads
    // or writes to the index. Working-tree edits are deliberately not included.
    hash.update(await read(['ls-files', '--stage', '-z']));
  } else {
    const plan = target ?? await pushPlan(cwd);
    const remote = plan.remote;
    hash.update(JSON.stringify(plan));
    hash.update(await read(['rev-parse', '--verify', '--quiet', target?.ref ?? 'HEAD'], true));
    if (remote) {
      hash.update(await read(['remote', 'get-url', '--push', '--all', '--', remote]));
      hash.update(await read(['for-each-ref', '--format=%(refname)%00%(objectname)', `refs/remotes/${remote}/`]));
    }
  }
  return hash.digest('hex');
}

/** Scan what `request` would commit or push in the checkout `cwd`. */
export async function scanFor(cwd: string, request: SecretScanRequest, target?: PushTarget): Promise<SecretScanReport> {
  const state = await checkedState(cwd, request, target);
  const read = request.action === 'commit' ? await readCommit(cwd, request.amend === true) : await readPush(cwd, target);
  const scans: PatchScan[] = read.kind === 'patches' ? read.patches.map(({ patch, commit }) => scanPatch(patch, { commit, fingerprint })) : [];
  const findings = scans.flatMap((s) => s.findings);
  const partial = read.kind === 'patches' ? read.partial : null;
  const unreadable = read.kind === 'unreadable' ? read.reason : null;
  if (state !== await checkedState(cwd, request, target)) {
    throw new CoreError('refused', 'The work or destination changed during its secret check. Nothing was committed or pushed; review it again.');
  }
  return {
    action: request.action,
    scope: read.scope,
    findings: findings.slice(0, MAX_LISTED_FINDINGS).map(({ fingerprint: _drop, ...view }) => view),
    omitted: Math.max(0, findings.length - MAX_LISTED_FINDINGS),
    suppressed: scans.reduce((n, s) => n + s.suppressed, 0),
    addedLines: scans.reduce((n, s) => n + s.addedLines, 0),
    partial,
    unreadable,
    digest: digestOf(state, request.action, findings, partial, unreadable),
    needsAcknowledgement: findings.length > 0 || partial !== null || unreadable !== null,
    at: Date.now(),
  };
}

const DONE = { commit: 'committed', push: 'pushed' } as const;
const ANYWAY = { commit: 'Commit anyway', push: 'Push anyway' } as const;

/** The sentence a refused commit or push is thrown with. */
export function refusal(scan: SecretScanReport, stale: boolean): string {
  const act = scan.action;
  const n = scan.findings.length + scan.omitted;
  if (stale) return `What Wanigan found in ${scan.scope} changed after it was shown, so nothing was ${DONE[act]}. Review the list again before choosing ${ANYWAY[act]}.`;
  if (scan.unreadable) return `Wanigan could not check ${scan.scope} for secrets (${scan.unreadable}), so nothing was ${DONE[act]}. Choose ${ANYWAY[act]} to go ahead without the check.`;
  const found = n ? `Wanigan found ${plural(n, 'possible secret')} in ${scan.scope}` : `Wanigan could not read all of ${scan.scope}`;
  const cut = scan.partial ? ` (${scan.partial})` : '';
  return `${found}${cut}, so nothing was ${DONE[act]}. Review ${n ? 'them' : 'what was skipped'} and choose ${ANYWAY[act]} if ${n ? 'they are not secrets' : 'you accept that'}.`;
}

/** An acknowledgement from the window: the digest that was shown, or nothing. */
export function acknowledgement(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 128) throw new CoreError('invalid', 'An acknowledgement is the digest of the findings that were shown, and this was not one.');
  return value;
}

/**
 * Scan again, and go on only if nothing needs acknowledging, or if `acknowledge`
 * is this scan's digest. The window's panel is the explanation; this is the check.
 */
export async function requireAcknowledged(cwd: string, request: SecretScanRequest, acknowledge: string | null, target?: PushTarget): Promise<SecretScanReport> {
  const scan = await scanFor(cwd, request, target);
  if (!scan.needsAcknowledgement) return scan;
  if (acknowledge !== null && acknowledge === scan.digest) return scan;
  throw new CoreError('refused', refusal(scan, acknowledge !== null));
}
