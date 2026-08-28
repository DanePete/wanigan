import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Project } from '@shared/types';
import { Note, ago } from '../components/bits';

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

const LANE_C = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--accent)', 'var(--claude)'];
const ROW = 34, LANE_W = 13, X0 = 12;

/** Colour-blind safe by construction: every status letter is shown as itself. */
const STAT_TONE: Record<string, string> = {
  M: 'var(--series-1)', A: 'var(--good)', D: 'var(--bad)',
  R: 'var(--series-3)', C: 'var(--series-3)', U: 'var(--warning)', '?': 'var(--warning)',
};

function Diff({ text }: { text: string }) {
  const lines = useMemo(() => text.split('\n').slice(0, 4000), [text]);
  return (
    <div className="gt-diff">
      {lines.map((l, i) => {
        const cls = l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff ') || l.startsWith('index ')
          ? 'meta' : l.startsWith('@@') ? 'hunk' : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : '';
        return <div key={i} className={cls}>{l || ' '}</div>;
      })}
    </div>
  );
}

export default function Git({ projects }: { projects: Project[] }) {
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '');
  const project = projects.find((p) => p.id === projectId) ?? projects[0] ?? null;
  const root = project?.path ?? '';

  const [st, setSt] = useState<Status | null>(null);
  const [commits, setCommits] = useState<Commit[]>([]);
  const [brs, setBrs] = useState<Branch[]>([]);
  const [stash, setStash] = useState<Stash[]>([]);
  const [sel, setSel] = useState<{ kind: 'commit'; hash: string } | { kind: 'file'; path: string; staged: boolean } | null>(null);
  const [detail, setDetail] = useState<{ title: string; patch: string } | null>(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(true);
  const [pane, setPane] = useState<'changes' | 'branches' | 'stash'>('changes');
  const [confirm, setConfirm] = useState<{ what: string; run: () => Promise<void> } | null>(null);

  const load = useCallback(async () => {
    if (!root) return;
    try {
      const s = await window.foreman.git.status(root);
      setSt(s);
      if (!s.isRepo) { setCommits([]); setBrs([]); setStash([]); return; }
      const [l, b, sh] = await Promise.all([
        window.foreman.git.log(s.root, { limit: 150, all: showAll }),
        window.foreman.git.branches(s.root),
        window.foreman.git.stashes(s.root),
      ]);
      setCommits(l as Commit[]); setBrs(b as Branch[]); setStash(sh as Stash[]);
      setErr(null);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }, [root, showAll]);

  useEffect(() => { void load(); const t = setInterval(load, 8000); return () => clearInterval(t); }, [load]);

  async function act(label: string, fn: () => Promise<unknown>, note?: string) {
    setBusy(label); setErr(null); setOk(null);
    try {
      const r = await fn();
      setOk(note ?? (typeof r === 'string' && r ? r : `${label} done.`));
      await load();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  async function openCommit(c: Commit) {
    setSel({ kind: 'commit', hash: c.hash });
    try {
      const d = await window.foreman.git.commitDiff(st!.root, c.hash);
      setDetail({ title: `${c.short} · ${c.subject}`, patch: d.patch });
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }

  async function openFile(f: GFile, staged: boolean) {
    setSel({ kind: 'file', path: f.path, staged });
    if (f.untracked) { setDetail({ title: f.path, patch: 'Untracked — this file is not in git yet, so there is nothing to diff against.' }); return; }
    try {
      const d = await window.foreman.git.fileDiff(st!.root, f.path, staged);
      setDetail({ title: f.path, patch: d || 'No textual diff (binary, or a mode change only).' });
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }

  if (!projects.length) {
    return <div className="pane"><p className="dim">Add a project first — Git works on the repo you have open.</p></div>;
  }

  const bar = (
    <div className="gt-bar">
      <select className="field" style={{ width: 'auto', fontSize: 12 }} value={projectId}
              onChange={(e) => { setProjectId(e.target.value); setSel(null); setDetail(null); }}>
        {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      {st?.isRepo && (
        <>
          <span className="gt-branch">{st.detached ? 'HEAD (detached)' : st.branch ?? '—'}</span>
          <span className="gt-track">
            {st.upstream ? <>↑<span className="a">{st.ahead}</span> ↓<span className="b">{st.behind}</span> {st.upstream}</>
              : 'no upstream'}
          </span>
          {st.operation && <span className="gt-op">⚠ {st.operation} in progress</span>}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            <button className="btn" disabled={!!busy} onClick={() => void act('Fetch', () => window.foreman.git.fetch(st.root))}>
              {busy === 'Fetch' ? '…' : 'Fetch'}
            </button>
            <button className="btn" disabled={!!busy || st.behind === 0}
                    title={st.behind ? `Fast-forward ${st.behind} commit${st.behind > 1 ? 's' : ''}` : 'Nothing to pull'}
                    onClick={() => void act('Pull', () => window.foreman.git.pull(st.root))}>
              Pull{st.behind ? ` ${st.behind}` : ''}
            </button>
            <button className="btn btn-primary" disabled={!!busy || (st.ahead === 0 && !!st.upstream)}
                    onClick={() => setConfirm({
                      what: st.upstream
                        ? `Push ${st.ahead} commit${st.ahead > 1 ? 's' : ''} to ${st.upstream}. This leaves your machine.`
                        : `Push ${st.branch} and set origin as its upstream. This leaves your machine.`,
                      run: () => act('Push', () => window.foreman.git.push(st.root,
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
      <div className="pane">
        {bar}
        <div className="empty"><div>
          <h1 style={{ fontSize: 18, fontWeight: 600 }}>Not a git repository</h1>
          <p className="dim" style={{ marginTop: 6, maxWidth: '52ch', lineHeight: 1.55 }}>
            {project?.path} has no <span className="mono">.git</span>. Foreman reads and writes git for projects that
            are repositories; everything else in the app works either way.
          </p>
        </div></div>
      </div>
    );
  }

  const rowIndex = new Map(commits.map((c, i) => [c.hash, i]));

  return (
    <div className="pane" style={{ padding: 0, display: 'flex', flexDirection: 'column' }}>
      {bar}
      {err && <div style={{ padding: '8px 12px' }}><Note tone="error">{err}</Note></div>}
      {ok && <div style={{ padding: '8px 12px' }}><Note tone="ok">{ok}</Note></div>}
      {confirm && (
        <div style={{ padding: '8px 12px' }}>
          <Note tone="warn">
            {confirm.what}
            <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
              <button className="btn btn-primary" disabled={!!busy}
                      onClick={() => { const r = confirm.run; setConfirm(null); void r(); }}>Do it</button>
              <button className="btn" onClick={() => setConfirm(null)}>Cancel</button>
            </div>
          </Note>
        </div>
      )}

      <div className="gt" style={{ flex: 1, minHeight: 0 }}>
        {/* ── the graph ─────────────────────────────────────────────── */}
        <div className="gt-col">
          <div className="gt-sec-h">
            <span className="t">History</span>
            <span className="c">{commits.length}</span>
            <div className="sp">
              <button className={`gt-chip${showAll ? ' on' : ''}`} onClick={() => setShowAll((v) => !v)}>
                {showAll ? 'all branches' : 'this branch'}
              </button>
            </div>
          </div>
          <div className="gt-scroll">
            {commits.map((c, i) => (
              <div key={c.hash} className={`gt-row${sel && sel.kind === 'commit' && sel.hash === c.hash ? ' on' : ''}`}
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
              </div>
            ))}
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
                            onClick={() => void act('Unstage', () => window.foreman.git.unstage(st.root, st.staged.map((f) => f.path)))}>
                      unstage all
                    </button>
                  </div>
                </div>
                {st.staged.map((f) => (
                  <button key={f.path} className={`gt-file${sel?.kind === 'file' && sel.path === f.path && sel.staged ? ' on' : ''}`}
                          onClick={() => void openFile(f, true)}>
                    <span className="st" style={{ color: STAT_TONE[f.index] ?? 'var(--text-dim)' }}>{f.index}</span>
                    <span className="p">{f.path}</span>
                    <span className="go" onClick={(e) => { e.stopPropagation(); void act('Unstage', () => window.foreman.git.unstage(st.root, [f.path])); }}>−</span>
                  </button>
                ))}
                {!st.staged.length && <p className="faint" style={{ padding: '4px 12px', fontSize: 11.5 }}>Nothing staged.</p>}
              </div>

              <div className="gt-sec">
                <div className="gt-sec-h">
                  <span className="t">Changed</span><span className="c">{st.unstaged.length + st.untracked.length}</span>
                  <div className="sp">
                    <button className="gt-chip" disabled={!st.unstaged.length && !st.untracked.length}
                            onClick={() => void act('Stage', () => window.foreman.git.stage(st.root,
                              [...st.unstaged, ...st.untracked].map((f) => f.path)))}>stage all</button>
                    <button className="gt-chip" disabled={!st.unstaged.length && !st.untracked.length}
                            onClick={() => setConfirm({
                              what: `Discard changes to ${st.unstaged.length} file${st.unstaged.length === 1 ? '' : 's'}` +
                                    (st.untracked.length ? ` and delete ${st.untracked.length} untracked file${st.untracked.length === 1 ? '' : 's'}` : '') +
                                    '. Untracked files cannot be recovered.',
                              run: () => act('Discard', () => window.foreman.git.discard(st.root,
                                st.unstaged.map((f) => f.path), st.untracked.map((f) => f.path))),
                            })}>discard all</button>
                  </div>
                </div>
                {[...st.unstaged, ...st.untracked].map((f) => (
                  <button key={f.path + String(f.untracked)}
                          className={`gt-file${sel?.kind === 'file' && sel.path === f.path && !sel.staged ? ' on' : ''}`}
                          onClick={() => void openFile(f, false)}>
                    <span className="st" style={{ color: STAT_TONE[f.untracked ? '?' : f.work] ?? 'var(--text-dim)' }}>
                      {f.untracked ? '?' : f.work}
                    </span>
                    <span className="p">{f.path}</span>
                    <span className="go" onClick={(e) => { e.stopPropagation(); void act('Stage', () => window.foreman.git.stage(st.root, [f.path])); }}>+</span>
                  </button>
                ))}
                {st.clean && <p className="faint" style={{ padding: '4px 12px', fontSize: 11.5 }}>Working tree clean.</p>}
              </div>

              <div className="gt-commit">
                <textarea value={msg} placeholder="Commit message" onChange={(e) => setMsg(e.target.value)} />
                <div style={{ display: 'flex', gap: 6 }}>
                  <button className="btn btn-primary" disabled={!!busy || !msg.trim() || !st.staged.length}
                          onClick={() => void act('Commit', async () => {
                            const r = await window.foreman.git.commit(st.root, msg);
                            setMsg(''); return r;
                          })}>
                    Commit {st.staged.length ? `${st.staged.length} file${st.staged.length > 1 ? 's' : ''}` : ''}
                  </button>
                  <button className="btn" disabled={!!busy || !st.unstaged.length}
                          title="Stage every tracked change and commit in one step"
                          onClick={() => void act('Commit', async () => {
                            const r = await window.foreman.git.commit(st.root, msg, { all: true });
                            setMsg(''); return r;
                          })}>Stage all &amp; commit</button>
                </div>
                {!st.staged.length && !st.clean && (
                  <span className="faint" style={{ fontSize: 11 }}>Stage something, or use “Stage all &amp; commit”.</span>
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
                    {(b.ahead || b.behind) ? <span className="faint" style={{ marginLeft: 6, fontSize: 10.5 }}>↑{b.ahead} ↓{b.behind}</span> : null}
                  </span>
                  <span className="go" style={{ display: 'flex', gap: 5 }}>
                    {!b.current && (
                      <button className="gt-chip" disabled={!!busy}
                              onClick={() => void act('Checkout', () => window.foreman.git.checkout(st.root, b.name.replace(/^origin\//, '')))}>
                        checkout
                      </button>
                    )}
                    {!b.current && !b.remote && (
                      <>
                        <button className="gt-chip" disabled={!!busy}
                                onClick={() => setConfirm({ what: `Merge ${b.name} into ${st.branch}.`,
                                  run: () => act('Merge', () => window.foreman.git.merge(st.root, b.name)) })}>merge</button>
                        <button className="gt-chip" disabled={!!busy}
                                onClick={() => setConfirm({ what: `Delete branch ${b.name}. Unmerged work on it would be lost.`,
                                  run: () => act('Delete', () => window.foreman.git.deleteBranch(st.root, b.name, true)) })}>delete</button>
                      </>
                    )}
                  </span>
                </div>
              ))}
              <div className="gt-commit">
                <NewBranch busy={!!busy} onCreate={(name) => void act('Branch', () => window.foreman.git.checkout(st.root, name, true))} />
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
                    <button className="gt-chip" onClick={() => void act('Apply', () => window.foreman.git.stashApply(st.root, s.index, false))}>apply</button>
                    <button className="gt-chip" onClick={() => void act('Pop', () => window.foreman.git.stashApply(st.root, s.index, true))}>pop</button>
                    <button className="gt-chip" onClick={() => setConfirm({ what: `Drop ${s.label}. It cannot be recovered.`,
                      run: () => act('Drop', () => window.foreman.git.stashDrop(st.root, s.index)) })}>drop</button>
                  </span>
                </div>
              ))}
              {!stash.length && <p className="faint" style={{ padding: 12, fontSize: 12 }}>No stashes.</p>}
              <div className="gt-commit">
                <button className="btn" disabled={!!busy || st.clean}
                        onClick={() => void act('Stash', () => window.foreman.git.stashSave(st.root, msg))}>
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
