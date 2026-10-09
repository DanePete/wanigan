// Commit history, card attribution and bounded commit diffs.
import { cardKeyOfMerge, parseRefs, refProblem, splitMessage, type CommitDetail, type CommitFile, type GitLog, type LogCommit } from '../shared/git.ts';
import { CoreError } from '../shared/protocol.ts';
import { changedFiles, runGit } from './git.ts';
import { DIFF_CONFIG, EMPTY_TREE, MAX_TOTAL_DIFF, PLAIN, SEP, literal, must, remotesContaining, resolves } from './git-commands.ts';

const MAX_FILE_DIFF = 200_000;
const MAX_DIFF_FILES = 200;
/** Commits searched for a filter; past this the search says it stopped. */
const MAX_SEARCHED = 20_000;

/* ── history ─────────────────────────────────────────────────────────────── */

const LOG_FORMAT = ['%H', '%h', '%P', '%an', '%ae', '%at', '%D', '%s'].join(SEP);

function parseLog(out: string, withBody: boolean): (LogCommit & { body: string })[] {
  return out.split('\0').map((b) => b.replace(/^\n/, '')).filter((b) => b.trim()).map((b) => {
    const f = b.split(SEP);
    return {
      hash: f[0] ?? '', short: f[1] ?? '', parents: (f[2] ?? '').trim() ? (f[2] as string).trim().split(' ') : [],
      author: f[3] ?? '', email: f[4] ?? '', at: Number(f[5] ?? 0) * 1000, refs: parseRefs(f[6] ?? ''), subject: f[7] ?? '',
      body: withBody ? f.slice(8).join(SEP) : '', cardKey: null,
    };
  });
}

/** History, newest first: this branch or every branch, optionally only commits whose message or author holds `query`. */
export async function log(cwd: string, options: { all: boolean; query: string; limit: number }): Promise<GitLog> {
  if (!(await resolves(cwd, 'HEAD'))) return { commits: [], more: false, searched: null };
  const revs = options.all ? ['--branches', '--remotes', '--tags', 'HEAD'] : ['HEAD'];
  const q = options.query.trim().toLowerCase();
  if (!q) {
    const out = await must(cwd, ['log', '--date-order', '--decorate=full', `--format=${LOG_FORMAT}`, '-z', `--max-count=${options.limit + 1}`, ...revs, '--'], 'the history', { timeout: 60_000 });
    const all = parseLog(out, false);
    return { commits: all.slice(0, options.limit).map(({ body: _b, ...c }) => c), more: all.length > options.limit, searched: null };
  }
  // git ANDs --grep with --author; a filter here means either, so the history is read and matched here, bounded.
  const out = await must(cwd, ['log', '--date-order', '--decorate=full', `--format=${LOG_FORMAT}${SEP}%b`, '-z', `--max-count=${MAX_SEARCHED}`, ...revs, '--'], 'the history', { timeout: 60_000 });
  const read = parseLog(out, true);
  const hits = read.filter((c) => `${c.subject}\n${c.body}`.toLowerCase().includes(q) || `${c.author} ${c.email}`.toLowerCase().includes(q) || c.hash.startsWith(q));
  return {
    commits: hits.slice(0, options.limit).map(({ body: _b, ...c }) => c),
    more: hits.length > options.limit,
    searched: { read: read.length, all: read.length < MAX_SEARCHED },
  };
}

/**
 * Which commits belong to which card: those on a card's own branch that its
 * base does not have, and those a merge of a card's branch brought in (read
 * from git's own "Merge wanigan/ns-3" subject). Bounded per card.
 */
export async function cardCommits(cwd: string, commits: readonly LogCommit[], cards: readonly { key: string; branch: string | null; base: string | null }[]): Promise<Map<string, string>> {
  const owner = new Map<string, string>();
  const known = new Set(cards.map((c) => c.key));
  const add = (hashes: string, key: string): void => { for (const h of hashes.split('\n').filter(Boolean)) if (!owner.has(h)) owner.set(h, key); };
  for (const card of cards) {
    if (!card.branch || refProblem(card.branch) || (card.base && refProblem(card.base))) continue;
    if (!(await resolves(cwd, `refs/heads/${card.branch}`))) continue;
    const r = await runGit(cwd, ['rev-list', '--max-count=500', `refs/heads/${card.branch}`, ...(card.base ? ['--not', card.base] : []), '--']);
    if (r.ok) add(r.out, card.key);
  }
  for (const c of commits) {
    const key = cardKeyOfMerge(c.subject);
    if (!key || !known.has(key) || c.parents.length < 2) continue;
    owner.set(c.hash, key);
    const r = await runGit(cwd, ['rev-list', '--max-count=500', c.parents[1] as string, '--not', c.parents[0] as string, '--']);
    if (r.ok) add(r.out, key);
  }
  return owner;
}

/** The merges of card branches anywhere in the repository (newest 500), for naming the card of a commit read on its own. */
export async function cardMerges(cwd: string): Promise<LogCommit[]> {
  const r = await runGit(cwd, ['log', '--branches', '--remotes', 'HEAD', '--merges', '--fixed-strings', '--grep=wanigan/', '--max-count=500', `--format=${LOG_FORMAT}`, '-z', '--']);
  return r.ok ? parseLog(r.out, false).map(({ body: _b, ...c }) => c) : [];
}

/** One commit: who, when, its message, and each file it changed with its diff (against its first parent). */
export async function showCommit(cwd: string, hash: unknown): Promise<CommitDetail> {
  if (typeof hash !== 'string' || !/^[0-9a-f]{4,64}$/i.test(hash)) throw new CoreError('invalid', 'That is not a commit.');
  const full = await resolves(cwd, hash);
  if (!full) throw new CoreError('not_found', `No commit ${hash} in this repository.`);
  const meta = await must(cwd, ['show', '-s', '--decorate=full', `--format=%H${SEP}%h${SEP}%P${SEP}%an${SEP}%ae${SEP}%at${SEP}%cn${SEP}%ct${SEP}%D${SEP}%B`, full, '--'], 'the commit');
  const f = meta.split(SEP);
  const parents = (f[2] ?? '').trim() ? (f[2] as string).trim().split(' ') : [];
  const { subject, body } = splitMessage(f.slice(9).join(SEP));
  const base = parents[0] ?? EMPTY_TREE;
  const [names, numstat] = await Promise.all([
    must(cwd, [...DIFF_CONFIG, 'diff', '--name-status', '-z', '-M', ...PLAIN, base, full, '--'], 'the commit’s files'),
    must(cwd, [...DIFF_CONFIG, 'diff', '--numstat', '-z', '-M', ...PLAIN, base, full, '--'], 'the commit’s files'),
  ]);
  const listed = changedFiles(names, numstat);
  let budget = MAX_TOTAL_DIFF;
  const files: CommitFile[] = [];
  for (const [i, file] of listed.entries()) {
    let diff: string | null = null;
    let truncated = false;
    if (!file.binary && i < MAX_DIFF_FILES && budget > 0) {
      const specs = [literal(file.path), ...(file.from ? [literal(file.from)] : [])];
      const r = await runGit(cwd, [...DIFF_CONFIG, 'diff', '-M', ...PLAIN, base, full, '--', ...specs]);
      if (r.ok) {
        const limit = Math.min(MAX_FILE_DIFF, budget);
        truncated = r.out.length > limit;
        diff = truncated ? r.out.slice(0, limit) : r.out;
        budget -= diff.length;
      }
    }
    files.push({ ...file, diff, truncated });
  }
  const pushedTo = await remotesContaining(cwd, full);
  return {
    hash: full, short: f[1] ?? full.slice(0, 7), parents, author: f[3] ?? '', email: f[4] ?? '', at: Number(f[5] ?? 0) * 1000,
    committer: f[6] ?? '', committedAt: Number(f[7] ?? 0) * 1000, refs: parseRefs(f[8] ?? ''), subject, body, cardKey: null, files,
    additions: files.reduce((n, x) => n + (x.additions ?? 0), 0), deletions: files.reduce((n, x) => n + (x.deletions ?? 0), 0),
    pushedTo,
  };
}
