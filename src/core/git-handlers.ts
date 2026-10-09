// The git workbench's methods: which checkout (the project folder, or a card's
// worktree), who is working in it, and every act logged and announced.
//
// The rule about agents: anything that changes the branch checked out or the
// files of a checkout where an agent session is live is refused, with the
// reason, because the agent would carry on editing files that are no longer
// what it read. Staging only touches the index, and fetching and pushing touch
// neither, so those go ahead; a commit there needs the owner to say they know.
import { realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { conflictCount, type ConflictCode } from '../shared/conflict.ts';
import { DIFF_AREAS, refProblem, type Attribution, type CheckoutAgent, type DiffArea, type GitStatus, type StatusEntry } from '../shared/git.ts';
import { OWNER, type CardSummary, type Project, type Provider, type Session } from '../shared/model.ts';
import type { LinePick } from '../shared/patch.ts';
import { CoreError, type GitWhere, type Method, type Params, type Result } from '../shared/protocol.ts';
import type { Accounts } from './accounts.ts';
import type { Board } from './board.ts';
import type { Checkpoints } from './checkpoints.ts';
import type { Ctx } from './context.ts';
import { writeCommitMessage } from './commit-message.ts';
import { problemText, readUntracked, repoProblem, runGit } from './git.ts';
import * as client from './git-client.ts';
import { withGitMutation } from './git-lock.ts';
import type { Resolution } from './git-client.ts';
import { acknowledgement, requireAcknowledged, scanFor } from './git-secrets.ts';
import { branchPullRequest, defaultBase, findGh, openBranchPullRequest } from './pulls.ts';
import type { Sessions } from './sessions.ts';

type GitMethod = Extract<Method, `git.${string}`>;
type GitHandlers = { [M in GitMethod]: (params: Params<M>) => Result<M> | Promise<Result<M>> };

interface Checkout {
  project: Project;
  card: CardSummary | null;
  path: string;
  /** For a card: the branch it forked from. */
  base: string | null;
}

const MAX_PATHS = 2_000;
/** Conflicted files whose conflicts status counts from git's own versions (each is a few git calls). */
const MAX_MERGED_COUNTS = 30;
const PROVIDER_NAME: Record<Provider, string> = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', shell: 'A shell' };

const inside = (path: string, root: string): boolean => {
  try { path = realpathSync(path); root = realpathSync(root); } catch { /* compare the recorded paths */ }
  return path === root || path.startsWith(`${root}/`);
};

/** Agent sessions live in `path` now (a shell is the owner's own). */
function agentsAt(sessions: Sessions, path: string): CheckoutAgent[] {
  return sessions.list({ live: true })
    .filter((s) => s.provider !== 'shell' && s.cwd && inside(s.cwd, path))
    .map((s) => ({ sessionId: s.id, title: s.title, provider: s.provider, state: s.state, cardKey: s.cardKey }));
}

const placeOf = (card: { key: string } | null): string => (card ? `${card.key}’s worktree` : 'the project folder');

function named(agents: CheckoutAgent[]): string {
  const [first] = agents;
  if (!first) return '';
  const one = `${PROVIDER_NAME[first.provider]} (${first.cardKey ? `${first.cardKey}, ` : ''}${first.title})`;
  return agents.length === 1 ? `${one} is` : `${one} and ${agents.length - 1} other agent session${agents.length === 2 ? '' : 's'} are`;
}

/**
 * Refused while an agent works in `path` (the project folder, or `card`'s
 * worktree): `what` would change the files it is reading and editing.
 */
export function refuseBesideAgents(sessions: Sessions, _projectId: string, path: string, card: { key: string } | null, what: string): void {
  const agents = agentsAt(sessions, path);
  if (!agents.length) return;
  throw new CoreError('refused', `${named(agents)} running in ${placeOf(card)}, so Wanigan will not ${what} there: it would change the files under ${agents.length === 1 ? 'it' : 'them'}. Stop ${agents.length === 1 ? 'the session' : 'them'}, or wait until ${agents.length === 1 ? 'it ends' : 'they end'}, then try again.`);
}

export function gitHandlers(ctx: Ctx, board: Board, sessions: Sessions, accounts: Accounts, checkpoints: Checkpoints,
  info: { claudeBinary: string | null; ghBinary?: string | null }): GitHandlers {
  /** The checkout a call names: the project folder, or the card's own worktree. */
  const where = (p: GitWhere): Checkout => {
    if (!p || typeof p.id !== 'string' || !p.id) throw new CoreError('invalid', 'Which project?');
    const project = board.project(p.id);
    if (!p.cardId) return { project, card: null, path: project.path, base: null };
    if (typeof p.cardId !== 'string') throw new CoreError('invalid', 'Which card?');
    const card = board.card(p.cardId);
    if (card.projectId !== project.id) throw new CoreError('invalid', 'That card belongs to another project.');
    if (!card.worktree) throw new CoreError('refused', `${card.key} has no branch of its own; its sessions work in the project folder.`);
    return { project, card, path: card.worktree.path, base: card.worktree.base };
  };
  /** A checkout git can act on, or a refusal that says why not. */
  const ready = async (p: GitWhere): Promise<Checkout> => {
    const w = where(p);
    const problem = await repoProblem(w.path);
    if (problem) throw new CoreError('refused', problemText(problem, w.path));
    return w;
  };
  /** Agent sessions live in this checkout now. */
  const agentsIn = (w: Checkout): CheckoutAgent[] => agentsAt(sessions, w.path);
  const place = (w: Checkout): string => placeOf(w.card);
  /** Refused while an agent works here: `what` would change the files it is reading and editing. */
  const quiet = (w: Checkout, what: string): void => refuseBesideAgents(sessions, w.project.id, w.path, w.card, what);
  const changed = (w: Checkout, verb: string, detail: string | null = null): void => {
    board.log({ projectId: w.project.id, cardId: w.card?.id ?? null, actor: OWNER, verb, detail });
    ctx.emit('git', { projectId: w.project.id });
  };
  const paths = (v: unknown): string[] => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v) || v.length > MAX_PATHS || !v.every((x) => typeof x === 'string')) throw new CoreError('invalid', 'Files are listed by path.');
    return v as string[];
  };
  const text = (v: unknown, field: string, max = 20_000): string => {
    if (typeof v !== 'string') throw new CoreError('invalid', `Missing ${field}.`);
    if (v.length > max) throw new CoreError('invalid', `The ${field} is too long.`);
    return v;
  };
  const area = (v: unknown): DiffArea => {
    if (!DIFF_AREAS.includes(v as DiffArea)) throw new CoreError('invalid', `The area must be one of ${DIFF_AREAS.join(', ')}.`);
    return v as DiffArea;
  };
  const files = (n: number): string => `${n} file${n === 1 ? '' : 's'}`;

  /** Who changed each file since the last commit, where checkpoints and tool calls say. */
  const attribution = async (w: Checkout): Promise<Map<string, Attribution[]>> => {
    const out = new Map<string, Attribution[]>();
    const head = await runGit(w.path, ['log', '-1', '--format=%ct', 'HEAD', '--']);
    const since = head.ok ? Number(head.out.trim()) * 1000 || 0 : 0;
    const touched = await checkpoints.touched(w.path, since).catch(() => new Map<string, { sessionId: string; turn: number; shared: boolean }[]>());
    const known = new Map<string, Session | null>();
    const session = (id: string): Session | null => {
      if (!known.has(id)) { try { known.set(id, sessions.get(id)); } catch { known.set(id, null); } }
      return known.get(id) ?? null;
    };
    const add = (path: string, sessionId: string, turn: number | null, shared: boolean): void => {
      const s = session(sessionId);
      if (!s || s.provider === 'shell') return;
      const list = out.get(path) ?? [];
      let a = list.find((x) => x.sessionId === sessionId);
      if (!a) {
        a = { sessionId, title: s.title, provider: s.provider, cardKey: s.cardKey, live: s.endedAt === null, turns: [], shared: false };
        list.push(a);
        out.set(path, list);
      }
      if (turn !== null && !a.turns.includes(turn)) a.turns.push(turn);
      a.shared ||= shared;
    };
    for (const [path, turns] of touched) for (const t of turns) add(path, t.sessionId, t.turn, t.shared);
    // A turn still under way has no checkpoint yet; what its tools wrote says what it touched so far.
    const live = agentsIn(w).map((a) => a.sessionId);
    if (live.length) {
      const rows = ctx.db.prepare(`SELECT session_id, path FROM session_events WHERE path IS NOT NULL AND at >= ? AND session_id IN (${live.map(() => '?').join(',')})`)
        .all(since, ...live) as { session_id: string; path: string }[];
      for (const r of rows) {
        const rel = relative(w.path, r.path);
        if (!rel.startsWith('..') && !rel.startsWith('/')) add(rel, r.session_id, null, false);
      }
    }
    for (const list of out.values()) for (const a of list) a.turns.sort((x, y) => x - y);
    return out;
  };

  const handlers: GitHandlers = {
    'git.status': async (p) => {
      const w = where(p);
      const empty: GitStatus = {
        problem: null, path: w.path, cardKey: w.card?.key ?? null, branch: null, head: null, detached: false, unborn: false, upstream: null,
        upstreamGone: false, ahead: 0, behind: 0, operation: null, operationOf: null, operationMessage: null,
        conflicted: [], staged: [], changed: [], untracked: [], omitted: 0, committed: [], forkedFrom: w.base, remotes: [], stashes: 0, agents: [],
      };
      const problem = await repoProblem(w.path);
      if (problem) return { ...empty, problem };
      const [s, who, fork] = await Promise.all([client.readStatus(w.path), attribution(w), forkOf(w)]);
      const committed = fork ? await client.committedSince(w.path, fork) : [];
      const entry = (path: string, status: StatusEntry['status'], counts: { add: number | null; del: number | null; binary: boolean } | null | undefined, extra: Partial<StatusEntry> = {}): StatusEntry => ({
        path, status, additions: counts?.add ?? null, deletions: counts?.del ?? null, binary: counts?.binary ?? false, who: who.get(path) ?? [], ...extra,
      });
      // In the order a person reads a list of files, not git's byte order (where README.md comes before app.ts).
      const sorted = (list: StatusEntry[]): StatusEntry[] => list.sort((a, b) => a.path.localeCompare(b.path));
      return {
        ...empty,
        branch: s.branch, head: s.head, detached: s.detached, unborn: s.unborn, upstream: s.upstream, upstreamGone: s.upstreamGone,
        ahead: s.ahead, behind: s.behind, operation: s.operation, operationOf: s.operationOf, operationMessage: s.operationMessage,
        conflicted: sorted(await Promise.all(s.conflicted.map(async (c) => entry(c.path, 'U', null, {
          // Counted as the resolver will show them; past a few dozen files, as the files hold them now.
          conflict: c.conflict, code: c.code as ConflictCode,
          hunks: s.conflicted.length <= MAX_MERGED_COUNTS ? await client.conflictHunks(w.path, c.path) : await conflictsIn(join(w.path, c.path)),
        })))),
        staged: sorted(s.staged.map((f) => entry(f.path, f.status, s.counts.staged.get(f.path), f.from ? { from: f.from } : {}))),
        changed: sorted(s.changed.map((f) => entry(f.path, f.status, s.counts.changed.get(f.path)))),
        untracked: sorted(s.untracked.map((path) => entry(path, '?', s.counts.untracked.get(path)))),
        committed: sorted(committed.map((f) => entry(f.path, f.status, { add: f.additions, del: f.deletions, binary: f.binary }, f.from ? { from: f.from } : {}))),
        omitted: s.omitted, remotes: s.remotes, stashes: s.stashes, agents: agentsIn(w),
      };
    },
    'git.diff': async (p) => {
      const w = await ready(p);
      const which = area(p.area);
      const base = which === 'branch' ? await forkOf(w) : null;
      if (which === 'branch' && !base) throw new CoreError('refused', 'Only a card’s worktree has commits of its own to show.');
      return client.areaDiff(w.path, text(p.path, 'path', 4096), which, { from: typeof p.from === 'string' ? p.from : null, base });
    },
    'git.stage': async (p) => {
      const w = await ready(p);
      const list = paths(p.paths);
      await client.stage(w.path, list);
      ctx.emit('git', { projectId: w.project.id });
      return { ok: true };
    },
    'git.unstage': async (p) => {
      const w = await ready(p);
      await client.unstage(w.path, paths(p.paths));
      ctx.emit('git', { projectId: w.project.id });
      return { ok: true };
    },
    'git.discard': async (p) => {
      const w = await ready(p);
      const tracked = paths(p.paths);
      const untracked = paths(p.untracked);
      if (!tracked.length && !untracked.length) return { ok: true };
      quiet(w, 'discard changes');
      await client.discard(w.path, tracked, untracked);
      changed(w, `discarded changes to ${files(tracked.length + untracked.length)}`, [...tracked, ...untracked].slice(0, 5).join(', '));
      return { ok: true };
    },
    'git.applyPart': async (p) => {
      const w = await ready(p);
      const action = p.action === 'stage' || p.action === 'unstage' || p.action === 'discard' ? p.action : (() => { throw new CoreError('invalid', 'Stage, unstage or discard?'); })();
      if (action === 'discard') quiet(w, 'discard changes');
      const pick = linePick(p.pick);
      const result = await client.applyPart(w.path, { file: text(p.path, 'path', 4096), area: area(p.area), action, pick, digest: text(p.digest, 'digest', 64) });
      if (action === 'discard') changed(w, `discarded ${result.lines} line${result.lines === 1 ? '' : 's'} of ${p.path}`);
      else ctx.emit('git', { projectId: w.project.id });
      return result;
    },
    'git.scan': async (p) => {
      const w = await ready(p);
      return scanFor(w.path, p.action === 'push' ? { action: 'push' } : { action: 'commit', amend: p.amend === true });
    },
    'git.lastCommit': async (p) => client.lastCommit((await ready(p)).path),
    'git.commit': async (p) => {
      const w = await ready(p);
      const message = text(p.message, 'message', 100_000);
      const amend = p.amend === true;
      if (!message.trim() && !amend) throw new CoreError('invalid', 'Write a summary for the commit.');
      const s = await client.readStatus(w.path);
      if (s.conflicted.length) throw new CoreError('refused', `${files(s.conflicted.length)} still conflict${s.conflicted.length === 1 ? 's' : ''}. Resolve and mark ${s.conflicted.length === 1 ? 'it' : 'them'} resolved first, or abort the ${s.operation ?? 'merge'}.`);
      if (!s.staged.length && !amend && s.operation !== 'merge') throw new CoreError('refused', 'Nothing is staged, so there is nothing to commit. Stage the changes this commit should hold.');
      const agents = agentsIn(w);
      if (agents.length && p.agentsAcknowledged !== true) {
        throw new CoreError('refused', `${named(agents)} working in ${place(w)}. Its edits may be half done; commit only what you have checked is staged, and say so to go ahead.`);
      }
      await requireAcknowledged(w.path, { action: 'commit', amend }, acknowledgement(p.acknowledge));
      const made = await client.commit(w.path, message, amend);
      changed(w, amend ? 'amended the last commit' : 'committed', `${made.short} ${made.subject}`);
      return made;
    },
    'git.writeMessage': async (p) => {
      const w = await ready(p);
      const account = accounts.resolve(w.project.id, 'claude', typeof p.accountId === 'string' && p.accountId ? p.accountId : null);
      const written = await writeCommitMessage({ cwd: w.path, account, binary: info.claudeBinary });
      board.log({ projectId: w.project.id, cardId: w.card?.id ?? null, actor: OWNER, verb: 'asked Claude for a commit message', detail: written.subject });
      return written;
    },
    'git.log': async (p) => {
      const w = await ready(p);
      const limit = typeof p.limit === 'number' && Number.isInteger(p.limit) ? Math.max(1, Math.min(p.limit, 2_000)) : 300;
      const read = await client.log(w.path, { all: p.all === true, query: typeof p.query === 'string' ? p.query.slice(0, 200) : '', limit });
      const owners = await client.cardCommits(w.path, read.commits, projectCards(w.project.id));
      return { ...read, commits: read.commits.map((c) => ({ ...c, cardKey: owners.get(c.hash) ?? null })) };
    },
    'git.show': async (p) => {
      const w = await ready(p);
      const detail = await client.showCommit(w.path, p.hash);
      const owners = await client.cardCommits(w.path, [{ ...detail, cardKey: null }, ...await client.cardMerges(w.path)], projectCards(w.project.id));
      return { ...detail, cardKey: owners.get(detail.hash) ?? null };
    },
    'git.branches': async (p) => {
      const w = await ready(p);
      return client.branches(w.path, w.path);
    },
    'git.switch': async (p) => {
      const w = await ready(p);
      quiet(w, 'switch branches');
      const r = await client.switchBranch(w.path, text(p.branch, 'branch', 300), p.remote === true);
      changed(w, `switched to ${r.branch}`);
      return r;
    },
    'git.createBranch': async (p) => {
      const w = await ready(p);
      const checkout = p.checkout !== false;
      if (checkout) quiet(w, 'switch branches');
      const r = await client.createBranch(w.path, text(p.name, 'name', 300), typeof p.from === 'string' && p.from ? p.from : null, checkout);
      changed(w, checkout ? `made and switched to ${r.branch}` : `made the branch ${r.branch}`);
      return r;
    },
    'git.deleteBranch': async (p) => {
      const w = await ready(p);
      const name = text(p.name, 'branch', 300);
      const r = await client.deleteBranch(w.path, name, p.force === true);
      changed(w, `deleted the branch ${name}`, p.force === true && r.lost ? `with ${r.lost} unmerged commit${r.lost === 1 ? '' : 's'}` : null);
      return r;
    },
    'git.mergePreview': async (p) => client.mergePreview((await ready(p)).path, text(p.branch, 'branch', 300)),
    'git.merge': async (p) => {
      const w = await ready(p);
      quiet(w, 'merge');
      const s = await client.readStatus(w.path);
      if (s.operation) throw new CoreError('refused', `A ${s.operation} is already in progress here. Finish or abort it first.`);
      if (s.staged.length || s.conflicted.length || s.changed.length) throw new CoreError('refused', 'This checkout has uncommitted changes to tracked files. Commit or stash them before merging, so the merge cannot mix with them.');
      const branch = text(p.branch, 'branch', 300);
      const r = await client.merge(w.path, branch);
      changed(w, r.outcome === 'conflict' ? `started merging ${branch}, which conflicted` : `merged ${branch}`, r.outcome === 'conflict' ? r.conflicts.slice(0, 5).join(', ') : r.commit);
      return r;
    },
    'git.abort': async (p) => {
      const w = await ready(p);
      quiet(w, 'abort it');
      const s = await client.readStatus(w.path);
      if (!s.operation) throw new CoreError('refused', 'Nothing is in progress here to abort.');
      await client.abort(w.path, s.operation);
      changed(w, `aborted the ${s.operation}`, s.operationOf);
      return { ok: true };
    },
    'git.conflict': async (p) => {
      const w = await ready(p);
      const s = await client.readStatus(w.path);
      const theirs = s.operationOf ?? (s.operation === 'rebase' ? 'the commit being replayed' : 'theirs');
      return client.conflictFile(w.path, text(p.path, 'path', 4096), { ours: s.branch ?? 'HEAD', theirs });
    },
    'git.resolve': async (p) => {
      const w = await ready(p);
      quiet(w, 'resolve conflicts');
      const path = text(p.path, 'path', 4096);
      const how: Resolution = p.remove === true ? { remove: true }
        : p.side === 'ours' || p.side === 'theirs' ? { side: p.side }
          : typeof p.content === 'string' ? { content: p.content, keepMarkers: p.keepMarkers === true }
            : p.asIs === true ? { asIs: true, keepMarkers: p.keepMarkers === true }
              : (() => { throw new CoreError('invalid', 'Resolve it with a side, written text, the file as it is, or by removing it.'); })();
      const r = await client.resolveConflict(w.path, path, how, p.digest);
      const said = 'remove' in how ? 'removed it' : 'side' in how ? `took ${how.side === 'ours' ? 'our' : 'their'} side`
        : 'asIs' in how ? 'as edited by hand' : how.keepMarkers && conflictCount(how.content) ? 'kept its conflict markers' : 'as written in the resolver';
      changed(w, `resolved ${path}`, said);
      return r;
    },
    'git.continue': async (p) => {
      const w = await ready(p);
      quiet(w, 'continue it');
      const s = await client.readStatus(w.path);
      if (!s.operation) throw new CoreError('refused', 'Nothing is in progress here to continue.');
      if (s.operation === 'merge') throw new CoreError('refused', 'A merge is finished by committing it: the commit box shows the message git prepared, and checks it for secrets first.');
      if (s.conflicted.length) throw new CoreError('refused', `${files(s.conflicted.length)} still conflict${s.conflicted.length === 1 ? 's' : ''}. Resolve ${s.conflicted.length === 1 ? 'it' : 'them'} first.`);
      await client.continueOperation(w.path, s.operation);
      changed(w, `continued the ${s.operation}`, s.operationOf);
      return { ok: true };
    },
    'git.stashes': async (p) => client.stashes((await ready(p)).path),
    'git.stashShow': async (p) => client.stashFiles((await ready(p)).path, p.index, p.sha),
    'git.stashSave': async (p) => {
      const w = await ready(p);
      quiet(w, 'put the changes aside');
      const message = typeof p.message === 'string' ? p.message.slice(0, 500) : '';
      await client.stashSave(w.path, message, p.untracked !== false);
      changed(w, 'stashed changes', message || null);
      return { ok: true };
    },
    'git.stashApply': async (p) => {
      const w = await ready(p);
      quiet(w, p.pop === true ? 'pop a stash' : 'apply a stash');
      const r = await client.stashApply(w.path, p.index, p.sha, p.pop === true);
      changed(w, `${p.pop === true ? 'popped' : 'applied'} a stash${r.conflicts.length ? ', which conflicted' : ''}`, r.conflicts.slice(0, 5).join(', ') || null);
      return r;
    },
    'git.stashDrop': async (p) => {
      const w = await ready(p);
      await client.stashDrop(w.path, p.index, p.sha);
      changed(w, 'dropped a stash');
      return { ok: true };
    },
    'git.fetch': async (p) => {
      const w = await ready(p);
      const r = await client.fetch(w.path);
      ctx.emit('git', { projectId: w.project.id });
      return r;
    },
    'git.pull': async (p) => {
      const w = await ready(p);
      quiet(w, 'pull');
      const r = await client.pull(w.path, p.merge === true);
      if (r.outcome === 'conflict') changed(w, `started merging ${r.from}, which conflicted`, r.conflicts.slice(0, 5).join(', '));
      else if (r.pulled) changed(w, `${r.outcome === 'merged' ? 'merged' : 'pulled'} ${r.pulled} commit${r.pulled === 1 ? '' : 's'} from ${r.from}`);
      else ctx.emit('git', { projectId: w.project.id });
      return r;
    },
    'git.pushPlan': async (p) => client.pushPlan((await ready(p)).path),
    'git.push': async (p) => {
      const w = await ready(p);
      await requireAcknowledged(w.path, { action: 'push' }, acknowledgement(p.acknowledge));
      const r = await client.push(w.path, p.head, p.planDigest);
      changed(w, `pushed ${r.pushed} commit${r.pushed === 1 ? '' : 's'} to ${r.to}`);
      return r;
    },
    'git.pullRequest': async (p) => {
      const w = await ready(p);
      const s = await client.readStatus(w.path);
      return branchPullRequest(w.path, s.branch, await findGh(info.ghBinary));
    },
    'git.pullRequestDraft': async (p) => draft(await ready(p)),
    'git.openPullRequest': async (p) => {
      const w = await ready(p);
      const d = await draft(w);
      if (d.refusal || !d.branch) throw new CoreError('refused', d.refusal ?? 'There is no branch to propose.');
      const title = text(p.title, 'title', 300).trim();
      if (!title) throw new CoreError('invalid', 'A pull request needs a title.');
      const base = client.ref(text(p.base, 'base branch', 300));
      if (base === d.branch) throw new CoreError('invalid', 'A pull request cannot go into the branch it comes from.');
      const r = await openBranchPullRequest(w.path, { branch: d.branch, base, title, body: text(p.body, 'description', 60_000) }, await findGh(info.ghBinary));
      changed(w, `opened a pull request for ${d.branch}`, r.url);
      return r;
    },
  };

  const mutations: GitMethod[] = [
    'git.stage', 'git.unstage', 'git.discard', 'git.applyPart', 'git.commit', 'git.switch', 'git.createBranch', 'git.deleteBranch',
    'git.merge', 'git.abort', 'git.resolve', 'git.continue', 'git.stashSave', 'git.stashApply', 'git.stashDrop',
    'git.fetch', 'git.pull', 'git.push', 'git.openPullRequest',
  ];
  const serialize = <M extends GitMethod>(method: M): void => {
    const handle = handlers[method];
    handlers[method] = ((params: Params<M>) => withGitMutation(where(params).path, () => handle(params))) as GitHandlers[M];
  };
  for (const method of mutations) serialize(method);
  return handlers;

  /** Where a card's worktree forked from its base: the point its own commits are measured from. Null for the project folder. */
  async function forkOf(w: Checkout): Promise<string | null> {
    if (!w.card || !w.base || refProblem(w.base)) return null;
    const r = await runGit(w.path, ['merge-base', w.base, 'HEAD', '--']);
    return r.ok ? r.out.trim() || null : null;
  }

  /** Every card the project has had, with its branch: archived and done ones still own their commits. */
  function projectCards(projectId: string): { key: string; branch: string | null; base: string | null }[] {
    return (ctx.db.prepare('SELECT key, worktree_branch, worktree_base FROM cards WHERE project_id = ?').all(projectId) as { key: string; worktree_branch: string | null; worktree_base: string | null }[])
      .map((r) => ({ key: r.key, branch: r.worktree_branch, base: r.worktree_base }));
  }

  /** The pull request a branch would get: the last commit's words, into the remote's main branch, refused until it is pushed. */
  async function draft(w: Checkout): Promise<Result<'git.pullRequestDraft'>> {
    const s = await client.readStatus(w.path);
    const last = await client.lastCommit(w.path);
    const remote = s.upstream?.split('/')[0] ?? (s.remotes.includes('origin') ? 'origin' : s.remotes[0] ?? null);
    const base = remote ? await defaultBase(w.path, remote) : null;
    const out = { branch: s.branch, base, title: last?.subject ?? '', body: last?.body ?? '', remote, refusal: null as string | null };
    if (w.card) {
      out.title = `${w.card.key} ${w.card.title}`;
      out.body = w.card.body;
    }
    out.refusal = !s.branch ? 'HEAD is detached. Switch to a branch first.'
      : !remote ? 'This repository has no remote, so there is nowhere for a pull request.'
        : !s.upstream || s.upstreamGone ? `${s.branch} is not on ${remote} yet. Push it first (with set upstream).`
          : s.ahead ? `${s.ahead} commit${s.ahead === 1 ? ' is' : 's are'} not pushed yet. Push first, so the pull request has them.`
            : base === s.branch ? `${s.branch} is ${remote}’s main branch; a pull request goes from another branch into it.`
              : null;
    return out;
  }
}

/** How many conflicts a file's text holds now; null when it has no text (gone, binary, too large). */
async function conflictsIn(path: string): Promise<number | null> {
  const read = await readUntracked(path).catch(() => null);
  return read && 'text' in read ? conflictCount(read.text) : null;
}

/** A pick from the window: removed lines by old number, added lines by new number, bounded. */
function linePick(v: unknown): LinePick {
  const o = v && typeof v === 'object' ? v as Record<string, unknown> : {};
  const nums = (x: unknown): number[] => {
    if (!Array.isArray(x) || x.length > 100_000 || !x.every((n) => Number.isSafeInteger(n) && (n as number) > 0)) throw new CoreError('invalid', 'Lines are picked by number.');
    return x as number[];
  };
  return { old: nums(o.old ?? []), new: nums(o.new ?? []) };
}
