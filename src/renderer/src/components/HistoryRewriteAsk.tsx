import { useEffect, useState } from 'react';
import type { Project } from '@shared/types';
import { Note, SectionHead } from './bits';
import '../styles/depth.css';

/**
 * Per project: "Always ask before history-rewriting git commands, even at
 * Trusted". Off by default. The gate reads it on every call, so a change binds
 * running sessions at once, and the change itself is a ledger row.
 */
export function HistoryRewriteAskPanel({ projects }: { projects: Project[] }) {
  const [rows, setRows] = useState<Record<string, boolean> | null | 'error'>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    window.wanigan.depth.historyRewriteAsk()
      .then((list) => { if (live) setRows(Object.fromEntries(list.map((r) => [r.projectId, r.enabled]))); })
      .catch(() => { if (live) setRows('error'); });
    return () => { live = false; };
  }, [projects.length]);
  const save = async (projectId: string, on: boolean) => {
    setSaving(projectId); setProblem(null);
    try {
      const next = await window.wanigan.depth.setHistoryRewriteAsk(projectId, on);
      setRows((prev) => (prev && prev !== 'error' ? { ...prev, [projectId]: next } : prev));
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally { setSaving(null); }
  };
  return (
    <section className="dp-rewrite-ask" aria-label="Always ask before history-rewriting git commands">
      <SectionHead label="Always ask before history-rewriting git commands, even at Trusted" />
      <p className="dim dp-fine dp-rewrite-rule">
        With this on for a project, a force push (or a push that deletes a remote branch), <code>reset --hard</code>, <code>branch -D</code>,
        a tag or ref delete, <code>filter-branch</code> or <code>filter-repo</code> is put to you as a question at every trust level, read through
        wrappers like <code>bash -c</code> the same way every other rule is. Rebase and <code>commit --amend</code> are not asked about: they are
        routine, and the reflog keeps what they replace. An unattended run has nobody to ask, so there the question becomes a denial. Every decision
        is a ledger row, and so is turning this on or off.
      </p>
      {rows === null ? <p className="faint dp-fine">Reading the setting…</p>
        : rows === 'error' ? <Note tone="error">Wanigan could not read this setting.</Note>
          : !projects.length ? <p className="faint dp-fine">No projects yet.</p>
            : (
              <ul className="dp-rewrite-list">
                {projects.map((p) => (
                  <li key={p.id}>
                    <label className="dp-check">
                      <input type="checkbox" checked={rows[p.id] === true} disabled={saving === p.id}
                             onChange={(e) => void save(p.id, e.target.checked)} />
                      {p.name}
                    </label>
                    <span className="faint dp-fine">{rows[p.id] ? 'asks' : 'follows the trust level'}</span>
                  </li>
                ))}
              </ul>
            )}
      {problem && <Note tone="error">{problem}</Note>}
    </section>
  );
}
