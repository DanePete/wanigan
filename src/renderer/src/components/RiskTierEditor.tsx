import { useEffect, useState } from 'react';
import type { RiskRule, RiskTier } from '@shared/risk-tiers';
import { Note } from './bits';
import '../styles/review-work.css';

/**
 * The project's risk tiers: path globs that make a file high or medium tier.
 * Stored in Wanigan's database for this project, never in the repository. The
 * defaults are offered here and written only when the operator saves them.
 */
export default function RiskTierEditor({ projectId, projectName }: { projectId: string; projectName?: string }) {
  const [saved, setSaved] = useState<RiskRule[] | null>(null);
  const [rows, setRows] = useState<RiskRule[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setSaved(null); setRows([]); setErr(null); setOk(null);
    if (!projectId) return () => { live = false; };
    window.wanigan.riskTiers.list(projectId)
      .then((r) => { if (live) { setSaved(r); setRows(r); } })
      .catch((e) => { if (live) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [projectId]);

  const dirty = JSON.stringify(rows) !== JSON.stringify(saved ?? []);
  const update = (i: number, patch: Partial<RiskRule>) => { setOk(null); setRows((current) => current.map((r, j) => (j === i ? { ...r, ...patch } : r))); };
  const offerDefaults = async () => {
    setErr(null); setOk(null);
    try {
      const defaults = await window.wanigan.riskTiers.defaults();
      setRows((current) => [...current, ...defaults.filter((d) => !current.some((c) => c.pattern === d.pattern))]);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };
  const save = async () => {
    setBusy(true); setErr(null); setOk(null);
    try {
      const next = await window.wanigan.riskTiers.save(projectId, rows.map((r) => ({ pattern: r.pattern.trim(), tier: r.tier })).filter((r) => r.pattern));
      setSaved(next); setRows(next);
      setOk(next.length ? `Saved ${next.length} rule${next.length === 1 ? '' : 's'} for ${projectName ?? 'this project'}.` : 'Saved: no risk tiers for this project.');
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="rw-tiers">
      <p className="rw-because">
        A file matching a high-tier pattern needs an explicit approval in the session's code rail before its worktree can be merged.
        Patterns read like .gitignore: no slash matches a name at any depth, <span className="mono">**</span> crosses folders.
        Kept in Wanigan, not in the repository.
      </p>
      {err && <Note tone="error">{err}</Note>}
      {ok && <Note tone="ok" onDismiss={() => setOk(null)}>{ok}</Note>}
      {saved === null && !err && <p className="faint">Reading the rules…</p>}
      {saved !== null && rows.length === 0 && <p className="faint">No risk tiers yet, so every file is treated alike and no merge waits on an approval.</p>}
      <ul className="rw-tier-list">
        {rows.map((r, i) => (
          <li key={i} className="rw-tier-row">
            <input className="field rw-tier-pattern" value={r.pattern} aria-label={`Path pattern ${i + 1}`} placeholder=".github/workflows/**"
                   onChange={(e) => update(i, { pattern: e.target.value })} />
            <select className="field rw-tier-select" value={r.tier} aria-label={`Tier for pattern ${i + 1}`}
                    onChange={(e) => update(i, { tier: e.target.value as RiskTier })}>
              <option value="high">high</option>
              <option value="medium">medium</option>
            </select>
            <button type="button" className="btn btn-sm" aria-label={`Remove pattern ${r.pattern || i + 1}`}
                    onClick={() => { setOk(null); setRows((current) => current.filter((_, j) => j !== i)); }}>Remove</button>
          </li>
        ))}
      </ul>
      <div className="rw-actions">
        <button type="button" className="btn btn-sm" onClick={() => { setOk(null); setRows((current) => [...current, { pattern: '', tier: 'high' }]); }}>Add pattern</button>
        <button type="button" className="btn btn-sm" onClick={() => void offerDefaults()}>Offer defaults</button>
        <button type="button" className="btn btn-sm btn-primary" disabled={busy || !dirty} onClick={() => void save()}>{busy ? 'Saving…' : 'Save tiers'}</button>
        {dirty && <span className="faint rw-because">Unsaved changes.</span>}
      </div>
    </div>
  );
}
