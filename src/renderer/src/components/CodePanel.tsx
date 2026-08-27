import { useCallback, useEffect, useMemo, useState } from 'react';

type Editor = { id: string; label: string; path: string };
type Changed = { path: string; index: string; work: string; staged: boolean; untracked: boolean };
type Entry = { name: string; rel: string; dir: boolean; size: number };

/**
 * A code view next to the terminal. The default tab is Changes, not Files:
 * while an agent is working, the question is almost never "what is in this
 * repo" — it is "what did it just touch". Editing stays in a real editor; two
 * writers on one file while an agent is mid-edit is a merge conflict waiting
 * to happen, so everything here is read-only.
 */
export default function CodePanel({ projectPath, projectName }: { projectPath: string; projectName: string }) {
  const [tab, setTab] = useState<'changes' | 'files'>('changes');
  const [editors, setEditors] = useState<Editor[]>([]);
  const [changes, setChanges] = useState<{ isRepo: boolean; branch: string | null; files: Changed[] }>({ isRepo: false, branch: null, files: [] });
  const [sel, setSel] = useState<string | null>(null);
  const [diff, setDiff] = useState<string>('');
  const [dir, setDir] = useState('');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [file, setFile] = useState<{ rel: string; text: string; truncated: boolean; binary: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { window.foreman.code.editors().then(setEditors).catch(() => {}); }, []);

  const loadChanges = useCallback(() => {
    window.foreman.code.changes(projectPath).then(setChanges).catch(() => {});
  }, [projectPath]);

  // Poll while an agent is working — the whole point is watching edits land.
  useEffect(() => {
    loadChanges();
    const t = setInterval(loadChanges, 4000);
    return () => clearInterval(t);
  }, [loadChanges]);

  useEffect(() => { setSel(null); setDiff(''); setFile(null); setDir(''); }, [projectPath]);

  useEffect(() => {
    if (tab !== 'files') return;
    window.foreman.code.list(projectPath, dir).then(setEntries).catch((e) => setErr(String(e.message ?? e)));
  }, [tab, dir, projectPath]);

  async function openDiff(p: string) {
    setSel(p); setFile(null);
    try { setDiff(await window.foreman.code.diff(projectPath, p)); }
    catch (e) { setDiff(''); setErr(e instanceof Error ? e.message : String(e)); }
  }

  async function openFile(rel: string) {
    try {
      const f = await window.foreman.code.read(projectPath, rel);
      setFile({ rel, ...f }); setSel(null); setDiff('');
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }

  const editor = editors[0] ?? null;
  const target = sel ?? file?.rel;

  const crumbs = useMemo(() => {
    const parts = dir ? dir.split('/') : [];
    return [{ label: projectName, rel: '' }, ...parts.map((p, i) => ({ label: p, rel: parts.slice(0, i + 1).join('/') }))];
  }, [dir, projectName]);

  return (
    <div className="code-panel">
      <div className="code-head">
        <button className={tab === 'changes' ? 'code-tab on' : 'code-tab'} onClick={() => setTab('changes')}>
          Changes{changes.files.length ? ` (${changes.files.length})` : ''}
        </button>
        <button className={tab === 'files' ? 'code-tab on' : 'code-tab'} onClick={() => setTab('files')}>Files</button>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
          {changes.branch && <span className="faint mono" style={{ fontSize: 10.5 }}>{changes.branch}</span>}
          <button className="btn" style={{ padding: '3px 9px', fontSize: 11.5 }}
                  title={editor ? `Open in ${editor.label}` : 'No editor CLI found — opens in Finder'}
                  onClick={() => window.foreman.code.open(
                    editor?.path ?? null,
                    target ? `${projectPath}/${target}` : projectPath
                  )}>
            {editor ? `Open in ${editor.label}` : 'Reveal'}
          </button>
        </div>
      </div>

      {err && <div className="code-err" onClick={() => setErr(null)}>{err} — click to dismiss</div>}

      <div className="code-body">
        {tab === 'changes' ? (
          <>
            <div className="code-list">
              {!changes.isRepo && <p className="faint" style={{ padding: 10, fontSize: 11.5 }}>Not a git repository.</p>}
              {changes.isRepo && !changes.files.length && (
                <p className="faint" style={{ padding: 10, fontSize: 11.5 }}>No changes yet. Edits appear here as the agent makes them.</p>
              )}
              {changes.files.map((f) => (
                <button key={f.path} className={`code-file${sel === f.path ? ' on' : ''}`} onClick={() => openDiff(f.path)}>
                  <span className="stat" title={f.untracked ? 'untracked' : f.staged ? 'staged' : 'modified'}
                        style={{ color: f.untracked ? 'var(--warning)' : f.staged ? 'var(--good)' : 'var(--series-1)' }}>
                    {f.untracked ? '?' : (f.index !== ' ' ? f.index : f.work)}
                  </span>
                  <span className="trunc" title={f.path}>{f.path}</span>
                </button>
              ))}
            </div>
            <div className="code-view">
              {sel ? <Diff text={diff} /> : <p className="faint code-hint">Select a changed file to see its diff.</p>}
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
    </div>
  );
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n}b`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}k`;
  return `${(n / 1048576).toFixed(1)}m`;
}

/**
 * The +/- character carries the meaning, not the colour. Red/green alone is
 * unreadable for red-green colourblind users; the prefix is always present.
 */
function Diff({ text }: { text: string }) {
  if (!text.trim()) return <p className="faint code-hint">No textual diff (binary file, or the change is already committed).</p>;
  const lines = text.split('\n');
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
