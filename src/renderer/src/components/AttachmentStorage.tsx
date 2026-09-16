import { useEffect, useState } from 'react';
import type { AttachmentReclaimPlan, AttachmentReclaimReport } from '@shared/types';
import { Note, SectionHead } from './bits';
import '../styles/attachment-storage.css';

const size = (bytes: number) => `${bytes.toLocaleString()} bytes`;

export default function AttachmentStorage() {
  const [days, setDays] = useState('30');
  const [savedDays, setSavedDays] = useState<number | null>(null);
  const [plan, setPlan] = useState<AttachmentReclaimPlan | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [report, setReport] = useState<AttachmentReclaimReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const valid = /^\d+$/.test(days) && Number(days) <= 3650;
  useEffect(() => {
    let active = true;
    void window.wanigan.attachmentStorage.settings().then(value => {
      if (!active) return;
      setSavedDays(value.days);
      setDays(String(value.days || 30));
    }).catch(reason => { if (active) setError(String(reason)); });
    return () => { active = false; };
  }, []);

  async function action(kind: 'save' | 'preview' | 'reclaim') {
    setBusy(true); setError(null); setNote(null); setReport(null);
    try {
      if (kind === 'save') {
        const setting = await window.wanigan.attachmentStorage.setDays(Number(days));
        setSavedDays(setting.days);
        setNote(setting.enabled ? 'Window saved. Cleanup runs only when you select files and confirm removal.' : 'Cleanup disabled. All files are kept.');
      } else if (kind === 'preview') {
        const next = await window.wanigan.attachmentStorage.preview(Number(days));
        setPlan(next); setSelected(next.candidates.map(item => item.sessionId));
      } else {
        const result = await window.wanigan.attachmentStorage.reclaim(selected);
        if (result) { setReport(result); setPlan(null); setSelected([]); }
        else setNote('Cleanup canceled. Files were kept.');
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }

  return (
    <div className="attachment-storage">
      <SectionHead label="Session attachment directories" />
      <p className="dim">Saved conversations can link to reports and generated images in these directories. Backups include them. Cleanup keeps generated or changed files, referenced attachments, live sessions and recent continuations. Older files without a recorded original content hash are kept too.</p>
      <div className="attachment-storage-controls">
        <label>Ended more than
          <input className="field mono" type="number" aria-label="Attachment cleanup age in days" min={0} max={3650} step={1}
                 value={days} disabled={busy} onChange={event => { setDays(event.target.value); setPlan(null); setSelected([]); }} />
          days ago
        </label>
        <button className="btn" disabled={busy || !valid} onClick={() => void action('preview')}>Preview cleanup</button>
        <button className="btn" disabled={busy || !valid || Number(days) === savedDays} onClick={() => void action('save')}>Save window</button>
      </div>
      <p className="faint">{savedDays === null ? 'Reading saved window…' : savedDays === 0 ? 'Cleanup is disabled.' : `Saved window: ${savedDays} days.`} Set 0 to keep everything. Nothing is removed automatically.</p>
      {error && <Note tone="error">{error}</Note>}
      {note && <Note tone="info">{note}</Note>}
      {plan && <>
        <Note tone="info">{plan.scanned} directories checked. {plan.candidates.length} eligible, {size(plan.bytesEligible)}; {plan.skipped.length} protected or unavailable.</Note>
        {plan.candidates.length > 0 && <>
          <div className="set-scroll">
            <table className="grid"><thead><tr><th>Select</th><th>Session</th><th>Files</th><th>Size</th></tr></thead>
              <tbody>{plan.candidates.map(item => <tr key={item.sessionId}>
                <td><input type="checkbox" aria-label={`Clean unused attachments for ${item.sessionId}`} disabled={busy}
                           checked={selected.includes(item.sessionId)} onChange={event => setSelected(prior => event.target.checked ? [...prior, item.sessionId] : prior.filter(id => id !== item.sessionId))} /></td>
                <td className="set-path set-wrap">{item.sessionId}</td><td>{item.files}</td><td>{size(item.bytes)}</td>
              </tr>)}</tbody>
            </table>
          </div>
          <button className="btn btn-danger" disabled={busy || !selected.length || savedDays !== plan.windowDays || savedDays === 0}
                  onClick={() => void action('reclaim')}>Remove selected unused files…</button>
          {savedDays !== plan.windowDays && <Note tone="info">Save this window before removing files. Removal asks for confirmation and checks eligibility again.</Note>}
        </>}
        {plan.skipped.length > 0 && <details><summary>Why directories are kept</summary>
          <ul className="set-list">{plan.skipped.map(item => <li key={item.sessionId}><strong>{item.sessionId}</strong>: {item.detail}</li>)}</ul>
        </details>}
      </>}
      {report && <>
        <Note tone={report.errors.length ? 'warn' : 'ok'}>{report.filesRemoved} files removed; {size(report.bytesFreed)} freed. Across the scan, {report.skipped.length} directories protected or unavailable.</Note>
        {report.errors.map(item => <Note key={item.sessionId} tone="error">{item.sessionId}: {item.message}</Note>)}
      </>}
    </div>
  );
}
