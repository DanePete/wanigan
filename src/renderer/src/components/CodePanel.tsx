import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Note } from './bits';

type Editor = { id: string; label: string; path: string };
type Changed = { path: string; index: string; work: string; staged: boolean; untracked: boolean; preexisting?: boolean; committed?: boolean };
type Entry = { name: string; rel: string; dir: boolean; size: number };

/**
 * A code view next to the terminal. The default tab is Changes, not Files:
 * while an agent is working, the question is almost never "what is in this
 * repo" — it is "what did it just touch". Editing stays in a real editor; two
 * writers on one file while an agent is mid-edit is a merge conflict waiting
 * to happen, so everything here is read-only.
 */
export default function CodePanel({ projectPath, projectName, sessionId, onSendToBatch }: {
  projectPath: string; projectName: string; sessionId?: string;
  onSendToBatch?: (files: string[]) => void;
}) {
  const [tab, setTab] = useState<'changes' | 'files'>('changes');
  // Default to this session's work. "All" exists because pre-existing dirt is
  // still worth seeing — it just isn't the agent's doing.
  const [scope, setScope] = useState<'session' | 'all'>('session');
  const [editors, setEditors] = useState<Editor[]>([]);
  const [changes, setChanges] = useState<{ isRepo: boolean; branch: string | null; files: Changed[]; headMoved: boolean; commits: number }>(
    { isRepo: false, branch: null, files: [], headMoved: false, commits: 0 });
  const [sel, setSel] = useState<string | null>(null);
  const [diff, setDiff] = useState<string>('');
  const [dir, setDir] = useState('');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [file, setFile] = useState<{ rel: string; text: string; truncated: boolean; binary: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /*
   * Live follow. PostToolUse fires after every Write/Edit/MultiEdit/NotebookEdit
   * and already carries the paths it touched, so watching an agent work costs
   * nothing new — the events are being broadcast to this renderer already.
   * Note "after": this is the change as it lands, not a preview of one the
   * agent is about to make. The diff is what is on disk, which is the honest
   * thing to show.
   */
  const [follow, setFollow] = useState(true);
  const [touched, setTouched] = useState<Record<string, number>>({});
  const [lastEdit, setLastEdit] = useState<{ path: string; at: number } | null>(null);
  /*
   * Reverting one file to the commit this session started from. /rewind cannot
   * do this — it explicitly does not track files a bash command changed, or
   * edits a background subagent made. The baseline is a git commit, so git
   * sees both, which makes this the honest undo rather than a second one.
   */
  const [baseHead, setBaseHead] = useState<string | null>(null);
  const [plan, setPlan] = useState<{ file: string; action: string; detail: string; safe: boolean } | null>(null);
  const [reverting, setReverting] = useState(false);
  const [reverted, setReverted] = useState<string | null>(null);
  /*
   * Undo everything this session did, in one act. File-by-file was the only
   * route, which is not much of an undo when an agent has touched forty files.
   * It is deliberately a two-step: the confirmation counts the files first,
   * because five hundred reverts is a different act from one.
   */
  const [bulk, setBulk] = useState<{ files: Changed[]; preexisting: number } | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkResult, setBulkResult] = useState<{ reverted: number; failed: { file: string; detail: string }[] } | null>(null);
  const [inspector, setInspector] = useState(false);

  useEffect(() => { window.wanigan.code.editors().then(setEditors).catch(() => {}); }, []);

  useEffect(() => {
    if (!sessionId) { setBaseHead(null); return; }
    window.wanigan.sessions.baseline(sessionId)
      .then((b) => setBaseHead(b?.head ?? null))
      .catch(() => setBaseHead(null));
  }, [sessionId]);

  const loadChanges = useCallback(() => {
    window.wanigan.code.changes(projectPath, sessionId).then(setChanges).catch(() => {});
  }, [projectPath, sessionId]);

  // Poll while an agent is working — the whole point is watching edits land.
  // Not while the window is hidden: this runs git status every four seconds and
  // nobody is watching the result. The visibility handler catches up at once,
  // so coming back never shows a stale list.
  useEffect(() => {
    loadChanges();
    const t = setInterval(() => { if (!document.hidden) loadChanges(); }, 4000);
    const onVis = () => { if (!document.hidden) loadChanges(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVis); };
  }, [loadChanges]);

  useEffect(() => { setSel(null); setDiff(''); setFile(null); setDir(''); }, [projectPath]);

  // Absolute from the hook payload, repo-relative in the changes list.
  const toRel = useCallback((abs: string) => {
    const root = projectPath.endsWith('/') ? projectPath : projectPath + '/';
    return abs.startsWith(root) ? abs.slice(root.length) : abs;
  }, [projectPath]);

  useEffect(() => {
    if (!sessionId) return;
    let timer: number | undefined;
    const off = window.wanigan.on.sessionEvent((e) => {
      if (e.sessionId !== sessionId || !e.paths?.length) return;
      const rels = e.paths.map(toRel);
      const at = Date.now();
      setTouched((t) => { const n = { ...t }; for (const r of rels) n[r] = at; return n; });
      setLastEdit({ path: rels[rels.length - 1], at });
      // A MultiEdit lands as several events in a burst; refresh once for the
      // burst rather than firing a git status per file.
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        loadChanges();
        if (follow && tab === 'changes') void openDiff(rels[rels.length - 1]);
      }, 180);
    });
    return () => { off(); window.clearTimeout(timer); };
  }, [sessionId, follow, tab, toRel, loadChanges]);

  // Recency fades, so "just edited" means it. A marker that never expires is
  // just a second selection colour.
  useEffect(() => {
    if (!Object.keys(touched).length) return;
    const t = setInterval(() => {
      const cut = Date.now() - 30_000;
      setTouched((cur) => {
        const next = Object.fromEntries(Object.entries(cur).filter(([, at]) => at > cut));
        return Object.keys(next).length === Object.keys(cur).length ? cur : next;
      });
    }, 5000);
    return () => clearInterval(t);
  }, [touched]);

  useEffect(() => {
    if (tab !== 'files') return;
    window.wanigan.code.list(projectPath, dir).then(setEntries).catch((e) => setErr(String(e.message ?? e)));
  }, [tab, dir, projectPath]);

  async function askRevert(p: string) {
    const f = changes.files.find((x) => x.path === p);
    try {
      setPlan(await window.wanigan.revert.plan(projectPath, p, baseHead, f?.preexisting === true));
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }

  async function doRevert() {
    if (!plan) return;
    setReverting(true);
    try {
      const f = changes.files.find((x) => x.path === plan.file);
      const r = await window.wanigan.revert.file(projectPath, plan.file, baseHead, f?.preexisting === true);
      setReverted(r.detail);
      setPlan(null);
      if (r.ok) { loadChanges(); if (sel === plan.file) { setSel(null); setDiff(''); } }
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setReverting(false); }
  }

  async function doRevertAll() {
    if (!bulk) return;
    setBulkBusy(true);
    try {
      const r = await window.wanigan.revert.all(
        projectPath,
        bulk.files.map((f) => ({ path: f.path, preexisting: f.preexisting === true })),
        baseHead,
      );
      setBulkResult({ reverted: r.reverted.length, failed: r.failed });
      setBulk(null);
      // A file that is gone has no diff left to show.
      if (sel && r.reverted.includes(sel)) { setSel(null); setDiff(''); }
      loadChanges();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBulk(null);
    } finally { setBulkBusy(false); }
  }

  async function openDiff(p: string) {
    setSel(p); setFile(null); setPlan(null); setReverted(null);
    try { setDiff(await window.wanigan.code.diff(projectPath, p)); }
    catch (e) { setDiff(''); setErr(e instanceof Error ? e.message : String(e)); }
  }

  async function openFile(rel: string) {
    try {
      const f = await window.wanigan.code.read(projectPath, rel);
      setFile({ rel, ...f }); setSel(null); setDiff('');
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }

  const editor = editors[0] ?? null;
  const target = sel ?? file?.rel;
  const inspectorText = sel ? diff : file?.text ?? '';

  const visible = useMemo(
    () => (scope === 'session' ? changes.files.filter((f) => !f.preexisting) : changes.files),
    [changes.files, scope]
  );
  const preexistingCount = changes.files.filter((f) => f.preexisting).length;

  const crumbs = useMemo(() => {
    const parts = dir ? dir.split('/') : [];
    return [{ label: projectName, rel: '' }, ...parts.map((p, i) => ({ label: p, rel: parts.slice(0, i + 1).join('/') }))];
  }, [dir, projectName]);

  return (
    <div className="code-panel">
      <div className="code-head">
        <button className={tab === 'changes' ? 'code-tab on' : 'code-tab'} onClick={() => setTab('changes')}>
          Changes{visible.length ? ` (${visible.length})` : ''}
        </button>
        <button className={tab === 'files' ? 'code-tab on' : 'code-tab'} onClick={() => setTab('files')}>Files</button>
        {sessionId && (
          <button
            className="pill"
            aria-pressed={follow}
            title={follow
              ? 'Following the agent: the diff jumps to each file as it is written'
              : 'Not following: the list still updates, but the diff stays where you put it'}
            onClick={() => setFollow((f) => !f)}
            style={follow
              ? { background: 'var(--accent-soft)', color: 'var(--accent)', marginLeft: 6 }
              : { background: 'var(--bg-sunk)', color: 'var(--text-faint)', marginLeft: 6 }}
          >
            {follow ? '◉ following' : '○ follow'}
          </button>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
          {tab === 'changes' && sessionId && preexistingCount > 0 && (
            <button className="pill" title={`${preexistingCount} file(s) were already modified when this session started`}
                    onClick={() => setScope(scope === 'session' ? 'all' : 'session')}
                    style={scope === 'session'
                      ? { background: 'var(--accent-soft)', color: 'var(--accent)' }
                      : { background: 'var(--bg-sunk)', color: 'var(--text-dim)' }}>
              {scope === 'session' ? 'this session' : `all (+${preexistingCount} pre-existing)`}
            </button>
          )}
          {tab === 'changes' && visible.length > 0 && sessionId && baseHead && (
            <button className="btn" style={{ padding: '3px 9px', fontSize: 'var(--t-small)' }}
                    disabled={bulkBusy || bulk !== null}
                    title={`Restore all ${visible.length} listed file(s) to ${baseHead.slice(0, 8)}, the commit this session started from`}
                    onClick={() => {
                      setBulkResult(null);
                      setBulk({ files: visible, preexisting: visible.filter((f) => f.preexisting).length });
                    }}>
              Revert {visible.length}…
            </button>
          )}
          {tab === 'changes' && visible.length > 0 && onSendToBatch && (
            <button className="btn" style={{ padding: '3px 9px', fontSize: 'var(--t-small)' }}
                    title="Run one prompt across these files as a batch"
                    onClick={() => onSendToBatch(visible.map((f) => f.path))}>
              Send {visible.length} to batch
            </button>
          )}
          {changes.branch && <span className="faint mono" style={{ fontSize: 'var(--t-micro)' }}>{changes.branch}</span>}
          <button className="btn" style={{ padding: '3px 9px', fontSize: 'var(--t-small)' }}
                  title={editor ? `Open in ${editor.label}` : 'No editor CLI found — opens in Finder'}
                  onClick={() => window.wanigan.code.open(
                    editor?.path ?? null,
                    target ? `${projectPath}/${target}` : projectPath
                  )}>
            {editor ? `Open in ${editor.label}` : 'Reveal'}
          </button>
          <button className="btn" style={{ padding: '3px 9px', fontSize: 'var(--t-small)' }}
                  disabled={!target}
                  title={target ? 'Open this file or diff in Wanigan’s full-height code inspector' : 'Select a file first'}
                  onClick={() => setInspector(true)}>
            Pop out
          </button>
        </div>
      </div>

      {err && <div className="code-err" onClick={() => setErr(null)}>{err} — click to dismiss</div>}

      {bulk && (
        <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--line)' }}>
          <Note tone="warn">
            <strong>
              Revert {bulk.files.length} file{bulk.files.length === 1 ? '' : 's'} to {baseHead?.slice(0, 8)}?
            </strong>
            <div style={{ marginTop: 4, lineHeight: 1.5 }}>
              Every listed file goes back to the commit this session started from; files that did not
              exist then are deleted. Uncommitted work in them is not recoverable from git afterwards.
              {bulk.preexisting > 0 && (
                <> {bulk.preexisting} of them {bulk.preexisting === 1 ? 'was' : 'were'} already modified
                  before this session started, so reverting {bulk.preexisting === 1 ? 'it' : 'them'} discards
                  your own earlier changes too.</>
              )}
            </div>
            <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
              <button className="btn btn-danger" style={{ fontSize: 'var(--t-small)', padding: '3px 9px' }}
                      disabled={bulkBusy} onClick={() => void doRevertAll()}>
                {bulkBusy ? 'Reverting…' : `Revert ${bulk.files.length} file${bulk.files.length === 1 ? '' : 's'}`}
              </button>
              <button className="btn" style={{ fontSize: 'var(--t-small)', padding: '3px 9px' }}
                      disabled={bulkBusy} onClick={() => setBulk(null)}>Cancel</button>
            </div>
          </Note>
        </div>
      )}

      {bulkResult && (
        <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--line)' }}>
          <Note tone={bulkResult.failed.length ? 'warn' : 'ok'}>
            {/* Counted, not summarised: "done" over a batch that half failed is
                the reason you would not notice the half that failed. */}
            Reverted {bulkResult.reverted} file{bulkResult.reverted === 1 ? '' : 's'}.
            {bulkResult.failed.length > 0 && <> {bulkResult.failed.length} could not be reverted:</>}
            {bulkResult.failed.length > 0 && (
              <ul style={{ margin: '4px 0 0', paddingLeft: 18, lineHeight: 1.45 }}>
                {bulkResult.failed.slice(0, 8).map((f) => (
                  <li key={f.file || f.detail}>
                    {f.file && <span className="mono">{f.file}</span>}{f.file ? ' — ' : ''}{f.detail}
                  </li>
                ))}
                {bulkResult.failed.length > 8 && (
                  <li className="faint">and {bulkResult.failed.length - 8} more, still listed above.</li>
                )}
              </ul>
            )}
            <div style={{ marginTop: 6 }}>
              <button className="btn" style={{ fontSize: 'var(--t-small)', padding: '3px 9px' }}
                      onClick={() => setBulkResult(null)}>Dismiss</button>
            </div>
          </Note>
        </div>
      )}

      <div className="code-body">
        {tab === 'changes' ? (
          <>
            <div className="code-list">
              {!changes.isRepo && <p className="faint" style={{ padding: 10, fontSize: 'var(--t-small)' }}>Not a git repository.</p>}
              {changes.isRepo && !visible.length && (
                <p className="faint" style={{ padding: 10, fontSize: 'var(--t-small)' }}>
                  {scope === 'session' && preexistingCount > 0
                    ? `Nothing from this session yet — ${preexistingCount} file(s) were already modified before it started.`
                    : 'No changes yet. Edits appear here as the agent makes them.'}
                </p>
              )}
              {changes.headMoved && (
                <p className="faint" style={{ padding: '6px 10px', fontSize: 'var(--t-micro)' }}>
                  {changes.commits} commit{changes.commits === 1 ? '' : 's'} since this session started.
                </p>
              )}
              {visible.map((f) => (
                <button key={f.path} className={`code-file${sel === f.path ? ' on' : ''}`} onClick={() => openDiff(f.path)}>
                  <span className="stat"
                        title={f.committed ? 'committed during this session'
                          : f.untracked ? 'untracked' : f.staged ? 'staged' : 'modified'}
                        style={{ color: f.committed ? 'var(--series-3)' : f.untracked ? 'var(--warning)'
                          : f.staged ? 'var(--good)' : 'var(--series-1)' }}>
                    {f.committed ? '●' : f.untracked ? '?' : (f.index !== ' ' ? f.index : f.work)}
                  </span>
                  <span className="trunc" title={f.path}
                        style={f.preexisting ? { color: 'var(--text-faint)' } : undefined}>{f.path}</span>
                  {touched[f.path] && (
                    // Word as well as colour: the dot alone would be one more
                    // thing that means nothing to a colourblind reader.
                    <span className="mono" style={{ marginLeft: 'auto', fontSize: 'var(--t-micro)', color: 'var(--accent)', flex: 'none' }}>
                      ● just now
                    </span>
                  )}
                </button>
              ))}
            </div>
            <div className="code-view">
              {sel && baseHead && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 9px',
                              borderBottom: '1px solid var(--line)', flexWrap: 'wrap' }}>
                  <span className="faint" style={{ fontSize: 'var(--t-micro)' }}>
                    against <span className="mono">{baseHead.slice(0, 8)}</span>
                  </span>
                  <button className="btn" style={{ fontSize: 'var(--t-micro)', padding: '2px 8px', marginLeft: 'auto' }}
                          onClick={() => void askRevert(sel)}>Revert this file…</button>
                </div>
              )}
              {plan && (
                <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--line)' }}>
                  <Note tone={plan.action === 'delete' ? 'warn' : 'info'}>
                    {plan.detail}
                    <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                      <button className="btn btn-danger" style={{ fontSize: 'var(--t-small)', padding: '3px 9px' }}
                              disabled={reverting || !plan.safe} onClick={() => void doRevert()}>
                        {reverting ? 'Reverting…' : plan.action === 'delete' ? 'Delete it' : 'Revert it'}
                      </button>
                      <button className="btn" style={{ fontSize: 'var(--t-small)', padding: '3px 9px' }}
                              onClick={() => setPlan(null)}>Cancel</button>
                    </div>
                  </Note>
                </div>
              )}
              {reverted && (
                <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--line)' }}>
                  <Note tone="ok">{reverted}</Note>
                </div>
              )}
              {sel ? <Diff text={diff} /> : (
                <p className="faint code-hint">
                  {lastEdit
                    ? <>The agent last wrote <span className="mono">{lastEdit.path}</span>. Select a file to see its diff.</>
                    : 'Select a changed file to see its diff.'}
                </p>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="code-list">
              <div className="crumbs">
                {crumbs.map((c, i) => (
                  <span key={c.rel}>
                    {i > 0 && <span className="faint"> / </span>}
                    <button className="crumb" onClick={() => setDir(c.rel)}>{c.label}</button>
                  </span>
                ))}
              </div>
              {dir && (
                <button className="code-file" onClick={() => setDir(dir.split('/').slice(0, -1).join('/'))}>
                  <span className="stat faint">↑</span><span>..</span>
                </button>
              )}
              {entries.map((e) => (
                <button key={e.rel} className={`code-file${file?.rel === e.rel ? ' on' : ''}`}
                        onClick={() => (e.dir ? setDir(e.rel) : openFile(e.rel))}>
                  <span className="stat faint">{e.dir ? '▸' : ' '}</span>
                  <span className="trunc">{e.name}</span>
                  {!e.dir && <span className="faint mono size">{fmtSize(e.size)}</span>}
                </button>
              ))}
            </div>
            <div className="code-view">
              {file ? <FileView file={file} /> : <p className="faint code-hint">Select a file to view it.</p>}
            </div>
          </>
        )}
      </div>
      {inspector && target && (
        <CodeInspector
          title={target}
          text={inspectorText}
          kind={sel ? 'diff' : 'file'}
          truncated={file?.truncated === true}
          onClose={() => setInspector(false)}
          onExternal={() => void window.wanigan.code.open(editor?.path ?? null, `${projectPath}/${target}`)}
        />
      )}
    </div>
  );
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n}b`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}k`;
  return `${(n / 1048576).toFixed(1)}m`;
}

/**
 * Rendering an unbounded diff hangs the pane, so it is cut — and says so. The
 * same limit and the same admission as the Git view's own diff.
 */
const DIFF_LINES = 4000;

/**
 * The +/- character carries the meaning, not the colour. Red/green alone is
 * unreadable for red-green colourblind users; the prefix is always present.
 */
function Diff({ text }: { text: string }) {
  const all = useMemo(() => text.split('\n'), [text]);
  if (!text.trim()) return <p className="faint code-hint">No textual diff (binary file, or the change is already committed).</p>;
  const lines = all.slice(0, DIFF_LINES);
  return (
    <pre className="diff">
      {lines.map((l, i) => {
        let cls = 'ctx';
        if (l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff ') || l.startsWith('index ')) cls = 'meta';
        else if (l.startsWith('@@')) cls = 'hunk';
        else if (l.startsWith('+')) cls = 'add';
        else if (l.startsWith('-')) cls = 'del';
        return <div key={i} className={`dl ${cls}`}>{l || ' '}</div>;
      })}
      {/* A diff that stops without saying so reads as a complete diff, and the
          missing part is exactly the part nobody reviews. Pop out reads the
          same text, so the count is where to go, not a dead end. */}
      {all.length > DIFF_LINES && (
        <div className="dl meta">
          — showing {DIFF_LINES.toLocaleString('en-US')} of {all.length.toLocaleString('en-US')} lines.
          The remaining {(all.length - DIFF_LINES).toLocaleString('en-US')} are not displayed.
        </div>
      )}
    </pre>
  );
}

function FileView({ file }: { file: { rel: string; text: string; truncated: boolean; binary: boolean } }) {
  if (file.binary) return <p className="faint code-hint">Binary file.</p>;
  const lines = file.text.split('\n');
  return (
    <>
      {file.truncated && <div className="code-err">Truncated for display — open in your editor for the whole file.</div>}
      <pre className="filepre">
        {lines.map((l, i) => (
          <div key={i} className="fl">
            <span className="ln">{i + 1}</span>
            <span className="lt">{l || ' '}</span>
          </div>
        ))}
      </pre>
    </>
  );
}

/** A full-height reading surface for a file or review diff. */
function CodeInspector({ title, text, kind, truncated, onClose, onExternal }: {
  title: string; text: string; kind: 'diff' | 'file'; truncated: boolean;
  onClose: () => void; onExternal: () => void;
}) {
  const [query, setQuery] = useState('');
  const [wrap, setWrap] = useState(false);
  const body = useRef<HTMLPreElement>(null);
  const lines = useMemo(() => text.split('\n'), [text]);
  const needle = query.trim().toLocaleLowerCase();
  const matches = useMemo(() => needle
    ? lines.map((line, i) => line.toLocaleLowerCase().includes(needle) ? i : -1).filter((i) => i >= 0)
    : [], [lines, needle]);

  const panel = useRef<HTMLElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      // aria-modal="true" promises the rest of the app is inert, but nothing
      // was holding focus: Tab walked straight out into the view behind and
      // left a screen reader outside a dialog it had been told was modal.
      if (e.key !== 'Tab' || !panel.current) return;
      const focusable = [...panel.current.querySelectorAll<HTMLElement>(
        'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      )].filter((el) => !el.hasAttribute('disabled'));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (!panel.current.contains(active)) { e.preventDefault(); first.focus(); return; }
      if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  // Focus starts inside the dialog rather than wherever the opener left it.
  useEffect(() => {
    panel.current?.querySelector<HTMLElement>('input, button')?.focus();
  }, []);

  const jump = (where: 'top' | 'bottom' | 'match') => {
    const el = body.current;
    if (!el) return;
    if (where === 'top') { el.scrollTop = 0; return; }
    if (where === 'bottom') { el.scrollTop = el.scrollHeight; return; }
    el.querySelector<HTMLElement>('[data-match="true"]')?.scrollIntoView({ block: 'center' });
  };

  return (
    <div className="code-inspector-backdrop" role="presentation" onMouseDown={onClose}>
      <section ref={panel} className="code-inspector" role="dialog" aria-modal="true" aria-label={`Code inspector: ${title}`}
               onMouseDown={(e) => e.stopPropagation()}>
        <header className="code-inspector-head">
          <div style={{ minWidth: 0 }}>
            <div className="label">{kind === 'diff' ? 'Diff inspector' : 'File inspector'}</div>
            <strong className="mono trunc" title={title}>{title}</strong>
          </div>
          <span className="faint mono">{lines.length.toLocaleString()} lines</span>
          <div className="code-inspector-actions">
            <input className="field" value={query} onChange={(e) => setQuery(e.target.value)}
                   placeholder="Find in code" aria-label="Find in code" />
            {needle && <button className="btn" onClick={() => jump('match')}>{matches.length} match{matches.length === 1 ? '' : 'es'}</button>}
            <button className="btn" aria-pressed={wrap} onClick={() => setWrap((v) => !v)}>{wrap ? 'Wrapped' : 'No wrap'}</button>
            <button className="btn" onClick={() => jump('top')}>Top</button>
            <button className="btn" onClick={() => jump('bottom')}>Bottom</button>
            <button className="btn" onClick={onExternal}>Open externally</button>
            <button className="btn" onClick={onClose}>Close <span className="faint">Esc</span></button>
          </div>
        </header>
        {truncated && <div className="code-err">This file is truncated for display. Open it externally for the complete contents.</div>}
        <pre ref={body} className={`code-inspector-body${wrap ? ' wrap' : ''}`} tabIndex={0}>
          {lines.map((line, i) => {
            const match = needle !== '' && line.toLocaleLowerCase().includes(needle);
            let cls = '';
            if (kind === 'diff') {
              if (line.startsWith('+') && !line.startsWith('+++')) cls = ' add';
              else if (line.startsWith('-') && !line.startsWith('---')) cls = ' del';
              else if (line.startsWith('@@')) cls = ' hunk';
              else if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('+++') || line.startsWith('---')) cls = ' meta';
            }
            return <span className={`code-inspector-line${cls}${match ? ' match' : ''}`} data-match={match || undefined} key={i}>
              <span className="ln">{i + 1}</span><span>{line || ' '}</span>
            </span>;
          })}
        </pre>
      </section>
    </div>
  );
}
