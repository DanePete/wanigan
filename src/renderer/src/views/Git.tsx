import { useCallback, useEffect, useMemo, useState } from 'react';
import type { GhPr, GhStatusReport, Project } from '@shared/types';
import { ConfirmNote, EmptyState, Note, PageHead, ago } from '../components/bits';
import ReviewGate from '../components/ReviewGate';

type GFile = { path: string; index: string; work: string; staged: boolean; untracked: boolean; conflicted: boolean };
type Status = {
  isRepo: boolean; root: string; branch: string | null; detached: boolean;
  upstream: string | null; ahead: number; behind: number;
  staged: GFile[]; unstaged: GFile[]; untracked: GFile[]; conflicted: GFile[];
  clean: boolean; operation: string | null;
};
type Commit = {
  hash: string; short: string; parents: string[]; author: string; at: number;
  subject: string; body: string; refs: string[]; head: boolean; lane: number; color: number;
};
type Branch = { name: string; current: boolean; remote: boolean; upstream: string | null; ahead: number; behind: number; at: number | null; subject: string | null };
type Stash = { index: number; label: string; at: number | null; subject: string };
/** What the detail pane is showing. It is named at module level because two
    places have to agree on it now: the click that opens a diff, and the
    reconcile that runs after a git action has moved the file underneath it. */
type Sel =
  | { kind: 'commit'; hash: string }
  | { kind: 'file'; path: string; staged: boolean }
  | null;

const LANE_C = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--accent)', 'var(--claude)'];
const ROW = 34, LANE_W = 13, X0 = 12;

/** Colour-blind safe by construction: every status letter is shown as itself. */
const STAT_TONE: Record<string, string> = {
  M: 'var(--series-1)', A: 'var(--good)', D: 'var(--bad)',
  R: 'var(--series-3)', C: 'var(--series-3)', U: 'var(--warning)', '?': 'var(--warning)',
};

/** Rendering an unbounded diff hangs the pane, so it is cut — and says so. */
const DIFF_LINES = 4000;

const PR_TONE: Record<GhPr['state'], string> = {
  open: 'var(--accent)', draft: 'var(--text-dim)', merged: 'var(--good)', closed: 'var(--bad)',
};
const REVIEW_LABEL = { approved: 'approved', changes_requested: 'changes requested', review_required: 'review needed' } as const;

function checksLabel(c: NonNullable<GhPr['checks']>): string {
  if (c.fail > 0) return `✕ ${c.fail} of ${c.total} checks failing`;
  if (c.pending > 0) return `… ${c.pass}/${c.total} checks`;
  return `✓ ${c.total} check${c.total > 1 ? 's' : ''}`;
}

/** Every arm of GhPrStatus rendered as itself; absence is shown, not faked. */
function PrChip({ report, onRefresh }: { report: GhStatusReport | null; onRefresh: () => void }) {
  if (!report) return null;
  const s = report.status;
  if (s.kind === 'no-branch') return null;
  const refresh = (
    <button className="gt-chip" onClick={onRefresh}
            title={`PR status checked ${ago(report.checkedAt)}${report.gh ? ` · gh ${report.gh.version ?? '?'} at ${report.gh.path}` : ''}. Click to check again — this asks your GitHub host through gh.`}>
      ↻
    </button>
  );
  if (s.kind === 'missing') {
    return (
      <span className="faint" style={{ fontSize: 'var(--t-small)' }}
            title="Install GitHub's gh CLI and sign in with `gh auth login` to see pull requests here. Wanigan runs the gh you install; it never stores GitHub credentials itself.">
        PRs: gh not installed
      </span>
    );
  }
  if (s.kind === 'unauthenticated') {
    return <><span className="faint" style={{ fontSize: 'var(--t-small)' }} title={s.detail}>PRs: gh not signed in</span>{refresh}</>;
  }
  if (s.kind === 'error') {
    return <><span className="faint" style={{ fontSize: 'var(--t-small)' }} title={s.detail}>PRs: unavailable</span>{refresh}</>;
  }
  if (s.kind === 'none') return refresh;
  const pr = s.pr;
  const bits = [pr.state,
    ...(pr.checks ? [checksLabel(pr.checks)] : []),
    ...(pr.reviewDecision ? [REVIEW_LABEL[pr.reviewDecision]] : [])];
  return (
    <>
      <button className="gt-chip" style={{ color: PR_TONE[pr.state] }} disabled={!pr.url}
              title={`${pr.title} — into ${pr.base}. ${pr.url ? 'Click to open on GitHub.' : 'gh returned no usable link.'}`}
              onClick={() => { if (pr.url) void window.wanigan.shell.openExternal(pr.url); }}>
        PR #{pr.number} · {bits.join(' · ')}
      </button>
      {refresh}
    </>
  );
}

function Diff({ text }: { text: string }) {
  const { lines, total } = useMemo(() => {
    const all = text.split('\n');
    return { lines: all.slice(0, DIFF_LINES), total: all.length };
  }, [text]);
  return (
    <div className="gt-diff">
      {lines.map((l, i) => {
        const cls = l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff ') || l.startsWith('index ')
          ? 'meta' : l.startsWith('@@') ? 'hunk' : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : '';
        return <div key={i} className={cls}>{l || ' '}</div>;
      })}
      {/* A diff that stops without saying so reads as a complete diff, and the
          missing part is exactly the part nobody reviews. */}
      {total > DIFF_LINES && (
        <div className="meta">
          — showing {DIFF_LINES.toLocaleString('en-US')} of {total.toLocaleString('en-US')} lines.
          The remaining {(total - DIFF_LINES).toLocaleString('en-US')} are not displayed.
        </div>
      )}
    </div>
  );
}

/** Unstaged, untracked and conflicted read as one side: everything git knows
    about that is not in the index. */
function workingSide(status: Status): GFile[] {
  return [...status.unstaged, ...status.untracked, ...status.conflicted];
}

/** Where a path sits in a freshly read status, or nothing when git no longer
    lists it anywhere — which is what a commit or a discard does to it, and is
    the case that has to empty the pane instead of leaving a patch up for a
    file that is gone. */
function findFile(status: Status, path: string): { file: GFile; staged: boolean } | null {
  const staged = status.staged.find((f) => f.path === path);
  if (staged) return { file: staged, staged: true };
  const work = workingSide(status).find((f) => f.path === path);
  return work ? { file: work, staged: false } : null;
}

export default function Git({ projects }: { projects: Project[] }) {
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '');
  // A folder picked from the empty state below. The shell owns the project list
  // and re-reads it on window focus; merging it here as well is what makes this
  // view usable in the frame after the dialog closes rather than one refresh later.
  const [picked, setPicked] = useState<Project[]>([]);
  const options = useMemo(() => {
    const seen = new Set(projects.map((p) => p.id));
    return [...projects, ...picked.filter((p) => !seen.has(p.id))];
  }, [projects, picked]);
  const project = options.find((p) => p.id === projectId) ?? options[0] ?? null;
  const root = project?.path ?? '';

  const [st, setSt] = useState<Status | null>(null);
  const [commits, setCommits] = useState<Commit[]>([]);
  const [brs, setBrs] = useState<Branch[]>([]);
  const [stash, setStash] = useState<Stash[]>([]);
  const [sel, setSel] = useState<Sel>(null);
  // A filter over the commits already in memory: no new gh or git process
  // runs for a keystroke, and the footer says how many rows it searched.
  const [commitFilter, setCommitFilter] = useState('');
  const [detail, setDetail] = useState<{ title: string; patch: string } | null>(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(true);
  const [pane, setPane] = useState<'changes' | 'branches' | 'stash'>('changes');
  // Five acts share this one confirm — push, discard all, merge, delete branch,
  // drop stash — so it carries the verb as well as the sentence. It used to
  // render a single button reading “Do it”, which is the T2 tier's own failure
  // case (bits.tsx): the second read exists to say what is about to happen, and
  // a generic button is exactly what a habit-clicker skips.
  const [confirm, setConfirm] = useState<{ what: string; verb: string; run: () => Promise<void> } | null>(null);
  const [adding, setAdding] = useState(false);
  const [pr, setPr] = useState<GhStatusReport | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ title: '', body: '', draft: false, base: '' });

  // Hands the status back as well as storing it. A caller that has just run a
  // git action has to read the result in the same tick to reconcile the diff
  // pane against it: `st` in that caller's closure is still the status from
  // before the action, and a setState does not arrive in time to help.
  const load = useCallback(async (): Promise<Status | null> => {
    if (!root) return null;
    try {
      const s: Status = await window.wanigan.git.status(root);
      setSt(s);
      if (!s.isRepo) { setCommits([]); setBrs([]); setStash([]); return s; }
      const [l, b, sh] = await Promise.all([
        window.wanigan.git.log(s.root, { limit: 150, all: showAll }),
        window.wanigan.git.branches(s.root),
        window.wanigan.git.stashes(s.root),
      ]);
      setCommits(l as Commit[]); setBrs(b as Branch[]); setStash(sh as Stash[]);
      setErr(null);
      return s;
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); return null; }
  }, [root, showAll]);

  useEffect(() => { void load(); const t = setInterval(load, 8000); return () => clearInterval(t); }, [load]);

  // PR state is asked for on open, on branch change and on the explicit ↻ —
  // never from the 8-second poll above, which stays local-only. The main
  // process adds a 60s cache so re-renders cannot become gh spawns.
  const loadPr = useCallback(async (force = false) => {
    if (!root) { setPr(null); return; }
    try { setPr(await window.wanigan.gh.prStatus(root, force)); } catch { setPr(null); }
  }, [root]);
  const branch = st?.branch ?? null;
  useEffect(() => { void loadPr(); }, [loadPr, branch]);

  async function act(label: string, fn: () => Promise<unknown>, note?: string) {
    setBusy(label); setErr(null); setOk(null);
    try {
      const r = await fn();
      setOk(note ?? (typeof r === 'string' && r ? r : `${label} done.`));
      await syncSelection(await load());
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  async function openCommit(c: Commit) {
    setSel({ kind: 'commit', hash: c.hash });
    try {
      const d = await window.wanigan.git.commitDiff(st!.root, c.hash);
      setDetail({ title: `${c.short} · ${c.subject}`, patch: d.patch });
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }

  // The repository root is a parameter because the reconcile below runs the
  // instant a git action returns, holding the root from the status that action
  // produced, while `st` in this closure is still the one read before it. It is
  // deliberately not called `root`: that name is the selected project's path in
  // this scope, and shadowing it here would be invisible at the call sites.
  async function openFile(f: GFile, staged: boolean, repoRoot: string = st?.root ?? '') {
    if (!repoRoot) return;
    setSel({ kind: 'file', path: f.path, staged });
    if (f.untracked) { setDetail({ title: f.path, patch: 'Untracked — this file is not in git yet, so there is nothing to diff against.' }); return; }
    try {
      const d = await window.wanigan.git.fileDiff(repoRoot, f.path, staged);
      setDetail({ title: f.path, patch: d || 'No textual diff (binary, or a mode change only).' });
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }

  // A git action changes the tree under whatever the diff pane is showing, so
  // the selection is re-resolved against the status that action produced. A
  // file changes sides when it is staged or unstaged and leaves the status
  // entirely when it is committed or discarded; in both cases the pane was
  // left holding a patch for a state the repository is no longer in.
  async function syncSelection(status: Status | null) {
    if (!status || sel?.kind !== 'file') return;
    // The side it was already on wins while the path is still listed on both:
    // a file can be staged and then edited again, and staging some other file
    // should not silently swap which half of this one is being read.
    const stillThere = (sel.staged ? status.staged : workingSide(status)).find((f) => f.path === sel.path);
    const hit = stillThere ? { file: stillThere, staged: sel.staged } : findFile(status, sel.path);
    if (!hit) { setSel(null); setDetail(null); return; }
    await openFile(hit.file, hit.staged, status.root);
  }

  async function createPr() {
    if (!st?.isRepo) return;
    setBusy('Create PR'); setErr(null); setOk(null);
    try {
      const r = await window.wanigan.gh.createPr(st.root, {
        title: form.title, body: form.body, draft: form.draft, base: form.base.trim() || undefined,
      });
      setOk(r.url ? `Pull request created: ${r.url}` : `Pull request created. ${r.detail}`);
      setCreating(false);
      await loadPr(true);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  async function addProject() {
    setAdding(true); setErr(null);
    try {
      const p = await window.wanigan.projects.pick();
      if (p) { setPicked((x) => (x.some((q) => q.id === p.id) ? x : [...x, p])); setProjectId(p.id); }
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setAdding(false); }
  }

  // Git was the only .pane route that never named itself: three states, no h1,
  // and the rail was the sole thing on screen saying which view you were in.
  // The same head opens all three so the answer does not depend on whether the
  // selected project happens to be a repository. Compact, because what sits
  // under it is a dense working surface rather than a page of prose.
  const head = (
    <PageHead
      compact
      title="Git"
      lead="One project's repository: history, working tree, branches, stashes and the review gate. Wanigan only reads it until you press a button here." />
  );

  if (!options.length) {
    return (
      <div className="pane gt-view">
        {head}
        {err && <div className="gt-notice"><Note tone="error">{err}</Note></div>}
        <EmptyState
          posture="nothing-yet"
          title="No project to read git from"
          cue="Add a folder and this opens on that repository."
          action={(
            <button className="btn btn-primary" disabled={adding} onClick={() => void addProject()}>
              {adding ? 'Choosing…' : 'Add your first project'}
            </button>
          )} />
      </div>
    );
  }

  const bar = (
    <div className="gt-bar">
      <select className="field" style={{ width: 'auto', fontSize: 'var(--t-small)' }} value={projectId}
              onChange={(e) => {
                // The message box is a draft about this repository's changes;
                // carrying it to another project offers to commit the wrong
                // sentence against the wrong tree.
                setProjectId(e.target.value); setSel(null); setDetail(null); setMsg('');
              }}>
        {options.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      {st?.isRepo && (
        <>
          <span className="gt-branch">{st.detached ? 'HEAD (detached)' : st.branch ?? '—'}</span>
          <span className="gt-track">
            {st.upstream ? <>↑<span className="a">{st.ahead}</span> ↓<span className="b">{st.behind}</span> {st.upstream}</>
              : 'no upstream'}
          </span>
          <PrChip report={pr} onRefresh={() => void loadPr(true)} />
          {st.operation && <span className="gt-op">⚠ {st.operation} in progress</span>}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            {pr?.status.kind === 'none' && (
              <button className="btn" disabled={!!busy || creating || !st.upstream}
                      title={st.upstream
                        ? `Open a pull request for ${st.branch} with gh`
                        : 'A pull request needs the branch on the remote — push it first.'}
                      onClick={() => {
                        setForm({ title: commits.find((c) => c.head)?.subject ?? '', body: '', draft: false, base: '' });
                        setCreating(true);
                      }}>
                Create PR
              </button>
            )}
            <button className="btn" disabled={!!busy} onClick={() => void act('Fetch', () => window.wanigan.git.fetch(st.root))}>
              {busy === 'Fetch' ? '…' : 'Fetch'}
            </button>
            <button className="btn" disabled={!!busy || st.behind === 0}
                    title={st.behind ? `Fast-forward ${st.behind} commit${st.behind > 1 ? 's' : ''}` : 'Nothing to pull'}
                    onClick={() => void act('Pull', () => window.wanigan.git.pull(st.root))}>
              Pull{st.behind ? ` ${st.behind}` : ''}
            </button>
            <button className="btn btn-primary" disabled={!!busy || (st.ahead === 0 && !!st.upstream)}
                    onClick={() => setConfirm({
                      what: st.upstream
                        ? `Push ${st.ahead} commit${st.ahead > 1 ? 's' : ''} to ${st.upstream}. This leaves your machine.`
                        : `Push ${st.branch} and set origin as its upstream. This leaves your machine.`,
                      verb: st.upstream ? `Push to ${st.upstream}` : 'Push and set upstream',
                      run: () => act('Push', () => window.wanigan.git.push(st.root,
                        st.upstream ? {} : { setUpstream: true, branch: st.branch ?? undefined })),
                    })}>
              Push{st.ahead ? ` ${st.ahead}` : ''}
            </button>
          </div>
        </>
      )}
    </div>
  );

  if (st && !st.isRepo) {
    return (
      <div className="pane gt-view">
        {head}
        {bar}
        <EmptyState
          posture="nothing-in-scope"
          title="Not a git repository"
          cue={<>
            {project?.path} has no <span className="mono">.git</span>. Wanigan reads and writes git for projects that
            are repositories; everything else in the app works either way.
          </>} />
      </div>
    );
  }

  const rowIndex = new Map(commits.map((c, i) => [c.hash, i]));
  const commitNeedle = commitFilter.trim().toLowerCase();
  const shownCommits = commitNeedle === '' ? commits
    : commits.filter((c) => c.subject.toLowerCase().includes(commitNeedle) || c.author.toLowerCase().includes(commitNeedle));

  return (
    <div className="pane gt-view">
      {head}
      {bar}
      {err && <div className="gt-notice"><Note tone="error">{err}</Note></div>}
      {ok && <div className="gt-notice"><Note tone="ok">{ok}</Note></div>}
      {confirm && (
        <div className="gt-confirm">
          <ConfirmNote tone="warn" what={confirm.what} verb={confirm.verb} busy={!!busy}
                       onCancel={() => setConfirm(null)}
                       onRun={() => { const run = confirm.run; setConfirm(null); return run(); }} />
        </div>
      )}
      {creating && st?.isRepo && (
        <div className="gt-notice">
          <Note tone="warn">
            Open a pull request for <span className="mono">{st.branch}</span> through gh. Creating it publishes on your GitHub host — this leaves your machine.
            <div style={{ display: 'grid', gap: 6, marginTop: 8 }}>
              <input className="field" placeholder="Title" maxLength={300} value={form.title}
                     onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} />
              <textarea className="field" placeholder="Body (optional)" rows={4} value={form.body}
                        onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))} />
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <label style={{ display: 'flex', gap: 5, alignItems: 'center', fontSize: 'var(--t-small)' }}>
                  <input type="checkbox" checked={form.draft}
                         onChange={(e) => setForm((f) => ({ ...f, draft: e.target.checked }))} />
                  draft
                </label>
                <input className="field" style={{ width: 200 }} placeholder="Base (repo default if empty)" value={form.base}
                       onChange={(e) => setForm((f) => ({ ...f, base: e.target.value }))} />
                <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                  <button className="btn btn-primary" disabled={!!busy || !form.title.trim()} onClick={() => void createPr()}>
                    {busy === 'Create PR' ? 'Creating…' : 'Create PR on GitHub'}
                  </button>
                  <button className="btn" disabled={!!busy} onClick={() => setCreating(false)}>Cancel</button>
                </div>
              </div>
            </div>
          </Note>
        </div>
      )}

      <ReviewGate projectId={projectId} />

      <div className="gt" style={{ flex: 1, minHeight: 0 }}>
        {/* ── the graph ─────────────────────────────────────────────── */}
        <div className="gt-col">
          <div className="gt-sec-h">
            <span className="t">History</span>
            <span className="c">{commits.length}</span>
            <div className="sp">
              <input className="field gt-filter" value={commitFilter} placeholder="Filter message or author"
                     aria-label="Filter the loaded commits" onChange={(e) => setCommitFilter(e.target.value)} />
              <button className={`gt-chip${showAll ? ' on' : ''}`} onClick={() => setShowAll((v) => !v)}>
                {showAll ? 'all branches' : 'this branch'}
              </button>
            </div>
          </div>
          {/* Arrow keys move through the loaded log and Enter opens the
              highlighted commit; opening is an IPC round trip, so movement
              alone never fetches a diff. */}
          <div className="gt-scroll" onKeyDown={(e) => {
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
            e.preventDefault();
            const rows = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button.gt-row'));
            if (!rows.length) return;
            const at = rows.indexOf(document.activeElement as HTMLButtonElement);
            const next = e.key === 'Home' ? 0
              : e.key === 'End' ? rows.length - 1
                : e.key === 'ArrowDown' ? Math.min(rows.length - 1, at + 1)
                  : Math.max(0, at <= 0 ? 0 : at - 1);
            rows[next]?.focus();
          }}>
            {shownCommits.map((c, i) => (
              <button key={c.hash} type="button" className={`gt-row${sel && sel.kind === 'commit' && sel.hash === c.hash ? ' on' : ''}`}
                      aria-pressed={!!(sel && sel.kind === 'commit' && sel.hash === c.hash)}
                      onClick={() => void openCommit(c)}>
                <svg className="gt-graph" viewBox={`0 0 92 ${ROW}`} aria-hidden="true">
                  {/* Lines to each parent. Drawn per row so the graph scrolls
                      without needing one enormous SVG behind the list. */}
                  {c.parents.map((p) => {
                    const pi = rowIndex.get(p);
                    if (pi === undefined) return null;
                    const px = X0 + (commits[pi].lane * LANE_W);
                    const cx = X0 + c.lane * LANE_W;
                    const down = pi > i;
                    return (
                      <path key={p} d={`M${cx},${ROW / 2} C${cx},${ROW} ${px},${0} ${px},${down ? ROW : 0}`}
                            stroke={LANE_C[commits[pi].color % LANE_C.length]} strokeWidth="1.5" fill="none" />
                    );
                  })}
                  <circle cx={X0 + c.lane * LANE_W} cy={ROW / 2} r={c.head ? 5 : 3.5}
                          fill={LANE_C[c.color % LANE_C.length]}
                          stroke={c.head ? 'var(--text)' : 'none'} strokeWidth="1.5" />
                </svg>
                <span className="gt-msg">
                  {c.refs.map((r) => (
                    <span key={r} className={`gt-ref${r.includes('HEAD') ? ' head' : r.includes('/') ? ' remote' : ''}`}>
                      {r.replace('HEAD -> ', '')}
                    </span>
                  ))}
                  {c.subject}
                </span>
                <span className="gt-who">{c.author.split(' ')[0]} · {ago(c.at)}</span>
              </button>
            ))}
            {commitFilter.trim() !== '' && (
              <p className="faint gt-filter-note">
                {shownCommits.length === 0
                  ? `Nothing in the ${commits.length} loaded commits matches “${commitFilter.trim()}”.`
                  : `${shownCommits.length} of the ${commits.length} loaded commits match. The filter runs over what is loaded, not the whole history.`}
              </p>
            )}
            {!commits.length && <p className="faint" style={{ padding: 14 }}>No commits yet.</p>}
          </div>
        </div>

        {/* ── right panel ───────────────────────────────────────────── */}
        <div className="gt-col">
          <div className="gt-sec-h">
            {(['changes', 'branches', 'stash'] as const).map((p) => (
              <button key={p} className={`gt-chip${pane === p ? ' on' : ''}`} onClick={() => setPane(p)}>
                {p}{p === 'changes' && st ? ` ${st.staged.length + st.unstaged.length + st.untracked.length}` : ''}
                {p === 'stash' ? ` ${stash.length}` : ''}
              </button>
            ))}
          </div>

          {pane === 'changes' && st && (
            <div className="gt-scroll">
              {st.conflicted.length > 0 && (
                <div className="gt-sec">
                  <div className="gt-sec-h"><span className="t" style={{ color: 'var(--bad)' }}>Conflicted</span><span className="c">{st.conflicted.length}</span></div>
                  {st.conflicted.map((f) => (
                    <button key={f.path} className="gt-file" onClick={() => void openFile(f, false)}>
                      <span className="st" style={{ color: 'var(--bad)' }}>U</span><span className="p">{f.path}</span>
                    </button>
                  ))}
                </div>
              )}

              <div className="gt-sec">
                <div className="gt-sec-h">
                  <span className="t">Staged</span><span className="c">{st.staged.length}</span>
                  <div className="sp">
                    <button className="gt-chip" disabled={!st.staged.length}
                            onClick={() => void act('Unstage', () => window.wanigan.git.unstage(st.root, st.staged.map((f) => f.path)))}>
                      unstage all
                    </button>
                  </div>
                </div>
                {st.staged.map((f) => (
                  <div key={f.path} className="gt-file-row">
                  <button type="button" className={`gt-file${sel?.kind === 'file' && sel.path === f.path && sel.staged ? ' on' : ''}`}
                          onClick={() => void openFile(f, true)}>
                    <span className="st" style={{ color: STAT_TONE[f.index] ?? 'var(--text-dim)' }}>{f.index}</span>
                    <span className="p">{f.path}</span>
                  </button>
                  {/* A sibling control, not a span inside the button: nested
                      interactive content is unreachable by keyboard and VoiceOver. */}
                  <button type="button" className="gt-go" aria-label={`Unstage ${f.path}`}
                          onClick={() => void act('Unstage', () => window.wanigan.git.unstage(st.root, [f.path]))}>−</button>
                  </div>
                ))}
                {!st.staged.length && <p className="faint" style={{ padding: '4px 12px', fontSize: 'var(--t-small)' }}>Nothing staged.</p>}
              </div>

              <div className="gt-sec">
                <div className="gt-sec-h">
                  <span className="t">Changed</span><span className="c">{st.unstaged.length + st.untracked.length}</span>
                  <div className="sp">
                    <button className="gt-chip" disabled={!st.unstaged.length && !st.untracked.length}
                            onClick={() => void act('Stage', () => window.wanigan.git.stage(st.root,
                              [...st.unstaged, ...st.untracked].map((f) => f.path)))}>stage all</button>
                    <button className="gt-chip" disabled={!st.unstaged.length && !st.untracked.length}
                            onClick={() => setConfirm({
                              what: `Discard changes to ${st.unstaged.length} file${st.unstaged.length === 1 ? '' : 's'}` +
                                    (st.untracked.length ? ` and delete ${st.untracked.length} untracked file${st.untracked.length === 1 ? '' : 's'}` : '') +
                                    '. Untracked files cannot be recovered.',
                              verb: 'Discard changes',
                              run: () => act('Discard', () => window.wanigan.git.discard(st.root,
                                st.unstaged.map((f) => f.path), st.untracked.map((f) => f.path))),
                            })}>discard all</button>
                  </div>
                </div>
                {[...st.unstaged, ...st.untracked].map((f) => (
                  <div key={f.path + String(f.untracked)} className="gt-file-row">
                  <button type="button" className={`gt-file${sel?.kind === 'file' && sel.path === f.path && !sel.staged ? ' on' : ''}`}
                          onClick={() => void openFile(f, false)}>
                    <span className="st" style={{ color: STAT_TONE[f.untracked ? '?' : f.work] ?? 'var(--text-dim)' }}>
                      {f.untracked ? '?' : f.work}
                    </span>
                    <span className="p">{f.path}</span>
                  </button>
                  <button type="button" className="gt-go" aria-label={`Stage ${f.path}`}
                          onClick={() => void act('Stage', () => window.wanigan.git.stage(st.root, [f.path]))}>+</button>
                  </div>
                ))}
                {st.clean && <p className="faint" style={{ padding: '4px 12px', fontSize: 'var(--t-small)' }}>Working tree clean.</p>}
              </div>

              <div className="gt-commit">
                <textarea value={msg} placeholder="Commit message" onChange={(e) => setMsg(e.target.value)} />
                <div style={{ display: 'flex', gap: 6 }}>
                  <button className="btn btn-primary" disabled={!!busy || !msg.trim() || !st.staged.length}
                          onClick={() => void act('Commit', async () => {
                            const r = await window.wanigan.git.commit(st.root, msg);
                            setMsg(''); return r;
                          })}>
                    Commit {st.staged.length ? `${st.staged.length} file${st.staged.length > 1 ? 's' : ''}` : ''}
                  </button>
                  {/* Same message check as Commit: without it this button is
                      enabled only to fail in the main process on an empty message. */}
                  <button className="btn" disabled={!!busy || !msg.trim() || !st.unstaged.length}
                          title="Stage every tracked change and commit in one step"
                          onClick={() => void act('Commit', async () => {
                            const r = await window.wanigan.git.commit(st.root, msg, { all: true });
                            setMsg(''); return r;
                          })}>Stage all &amp; commit</button>
                </div>
                {!st.staged.length && !st.clean && (
                  <span className="faint" style={{ fontSize: 'var(--t-micro)' }}>Stage something, or use “Stage all &amp; commit”.</span>
                )}
              </div>
            </div>
          )}

          {pane === 'branches' && st && (
            <div className="gt-scroll">
              {brs.map((b) => (
                <div key={b.name} className="gt-file" style={{ cursor: 'default' }}>
                  <span className="st" style={{ color: b.current ? 'var(--good)' : 'var(--text-faint)' }}>
                    {b.current ? '●' : b.remote ? '☁' : '○'}
                  </span>
                  <span className="p" title={b.subject ?? ''}>
                    {b.name}
                    {(b.ahead || b.behind) ? <span className="faint" style={{ marginLeft: 6, fontSize: 'var(--t-micro)' }}>↑{b.ahead} ↓{b.behind}</span> : null}
                  </span>
                  <span className="go" style={{ display: 'flex', gap: 5 }}>
                    {!b.current && (
                      <button className="gt-chip" disabled={!!busy}
                              onClick={() => void act('Checkout', () => window.wanigan.git.checkout(st.root, b.name.replace(/^origin\//, '')))}>
                        checkout
                      </button>
                    )}
                    {!b.current && !b.remote && (
                      <>
                        <button className="gt-chip" disabled={!!busy}
                                onClick={() => setConfirm({ what: `Merge ${b.name} into ${st.branch}.`,
                                  verb: `Merge into ${st.branch}`,
                                  run: () => act('Merge', () => window.wanigan.git.merge(st.root, b.name)) })}>merge</button>
                        <button className="gt-chip" disabled={!!busy}
                                onClick={() => setConfirm({ what: `Delete branch ${b.name}. Unmerged work on it would be lost.`,
                                  verb: `Delete ${b.name}`,
                                  run: () => act('Delete', () => window.wanigan.git.deleteBranch(st.root, b.name, true)) })}>delete</button>
                      </>
                    )}
                  </span>
                </div>
              ))}
              <div className="gt-commit">
                <NewBranch busy={!!busy} onCreate={(name) => void act('Branch', () => window.wanigan.git.checkout(st.root, name, true))} />
              </div>
            </div>
          )}

          {pane === 'stash' && st && (
            <div className="gt-scroll">
              {stash.map((s) => (
                <div key={s.index} className="gt-file" style={{ cursor: 'default' }}>
                  <span className="st">≡</span>
                  <span className="p" title={s.subject}>{s.subject}</span>
                  <span className="go" style={{ display: 'flex', gap: 5 }}>
                    <button className="gt-chip" onClick={() => void act('Apply', () => window.wanigan.git.stashApply(st.root, s.index, false))}>apply</button>
                    <button className="gt-chip" onClick={() => void act('Pop', () => window.wanigan.git.stashApply(st.root, s.index, true))}>pop</button>
                    <button className="gt-chip" onClick={() => setConfirm({ what: `Drop ${s.label}. It cannot be recovered.`,
                      verb: 'Drop this stash',
                      run: () => act('Drop', () => window.wanigan.git.stashDrop(st.root, s.index)) })}>drop</button>
                  </span>
                </div>
              ))}
              {!stash.length && <p className="faint" style={{ padding: 12, fontSize: 'var(--t-small)' }}>No stashes.</p>}
              <div className="gt-commit">
                <button className="btn" disabled={!!busy || st.clean}
                        onClick={() => void act('Stash', () => window.wanigan.git.stashSave(st.root, msg))}>
                  Stash everything{msg.trim() ? ' with that message' : ''}
                </button>
              </div>
            </div>
          )}

          {detail && (
            <div style={{ borderTop: '1px solid var(--line)', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
              <div className="gt-sec-h"><span className="t" style={{ textTransform: 'none', letterSpacing: 0 }}>{detail.title}</span></div>
              <Diff text={detail.patch} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function NewBranch({ busy, onCreate }: { busy: boolean; onCreate: (name: string) => void }) {
  const [name, setName] = useState('');
  return (
    <div style={{ display: 'flex', gap: 6 }}>
      <input className="field" style={{ flex: 1 }} value={name} placeholder="new-branch-name"
             onChange={(e) => setName(e.target.value)} />
      <button className="btn" disabled={busy || !name.trim()}
              onClick={() => { onCreate(name.trim()); setName(''); }}>Create &amp; switch</button>
    </div>
  );
}
