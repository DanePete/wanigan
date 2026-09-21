import { useCallback, useEffect, useState } from 'react';
import type { RecoveryInspection, RecoveryPreview } from '@shared/recovery';
import { EmptyState, Note, PageHead, Reading, SectionHead } from '../components/bits';
import '../styles/recovery.css';

export default function Recovery() {
  const [reading, setReading] = useState<RecoveryInspection | null>(null);
  const [preview, setPreview] = useState<RecoveryPreview | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    try { setReading(await window.wanigan.recovery.inspect()); setError(''); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  const review = async (key: string) => {
    setBusy(true); setPreview(null); setNotice('');
    try { setPreview(await window.wanigan.recovery.preview(key)); setError(''); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const apply = async () => {
    if (!preview) return;
    setBusy(true);
    const token = preview.token;
    setPreview(null);
    try { const result = await window.wanigan.recovery.apply(token); await refresh(); setNotice(result.decision); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return <main className="pane recovery">
    <PageHead eyebrow="Manage · required module" title="Recovery"
      lead="Review the evidence behind blocked execution. Checkout ownership and financial exposure are separate decisions."
      actions={<button className="btn" disabled={busy} onClick={() => { setPreview(null); void refresh(); }}>Refresh evidence</button>} />
    {error && <Note tone="error">{error}</Note>}
    {notice && <Note tone="ok">{notice}</Note>}
    {!reading && !error && <Reading what="recovery evidence" />}
    {reading && <>
      <SectionHead label="Database generation" right={<span>{reading.storageMode}</span>} />
      <p className="recovery-path">{reading.generation}</p>
      <Note tone={reading.storageMode === 'active' ? 'info' : 'warn'}>{reading.storageReason}</Note>
      {reading.storageOperation && <section className="recovery-entry" aria-label="Restore journal">
        <SectionHead label={`Restore journal · ${reading.storageOperation.phase}`} />
        <p className="recovery-path">Operation {reading.storageOperation.id}</p>
        <p className="recovery-path">Source generation: {reading.storageOperation.sourceGeneration}</p>
        <p className="recovery-path">Destination generation: {reading.storageOperation.destinationGeneration}</p>
        <p className="recovery-path">Retained originals: {reading.storageOperation.retainedDir}</p>
        <p className="recovery-path">Staged files: {reading.storageOperation.stagingDir}</p>
        {reading.storageOperation.detail && <p>{reading.storageOperation.detail}</p>}
      </section>}
      {reading.unavailable && <Note tone="error">{reading.unavailable}</Note>}
      <SectionHead label="Execution and billing claims" count={reading.observations.length} />
      {!reading.unavailable && reading.observations.length === 0 && <EmptyState posture="nothing-yet" title="No unresolved claims recorded"
        cue="This describes Wanigan’s recorded evidence. Independent processes and unreported remote charges are outside this reading." />}
      {reading.observations.map(row => <section className="recovery-entry" key={row.key}>
        <SectionHead label={`${row.module} · ${row.operationId}`} right={<span>{row.execution}</span>} />
        <p className="recovery-path">{row.cwd ?? 'No checkout claimed by this record'}</p>
        <dl className="recovery-facts">
          <div><dt>Checkout</dt><dd>{row.checkout}</dd></div>
          <div><dt>Billing</dt><dd>{row.billing === 'unresolved' ? 'Unresolved liability' : 'Independent; unchanged by recovery'}</dd></div>
          <div><dt>Evidence source</dt><dd>{row.source}</dd></div>
          <div><dt>Observed</dt><dd>{row.observedAt === null ? 'Time unknown' : new Date(row.observedAt).toLocaleString()}</dd></div>
        </dl>
        <p>{row.reason}</p>
        {row.canReconcile
          ? <button className="btn" disabled={busy || reading.storageMode !== 'active'} onClick={() => void review(row.key)}>Review supported release</button>
          : <p className="muted">{row.billing === 'unresolved'
            ? 'Billing reconciliation is unavailable. The recorded liability remains held.'
            : 'Release unavailable: completion evidence is insufficient. Stop requests belong to the runtime that still owns the child.'}</p>}
      </section>)}
      {preview && <section className="recovery-entry" aria-label="Review recovery release">
        <SectionHead label="Review this exact release" />
        <p>{preview.observation.operationId} · {preview.observation.cwd}</p>
        <Note tone="warn">{preview.decision}</Note>
        <p>Valid until {new Date(preview.expiresAt).toLocaleTimeString()}. Changed evidence or checkout identity requires another review.</p>
        <div className="recovery-actions">
          <button className="btn" disabled={busy} onClick={() => setPreview(null)}>Cancel</button>
          <button className="btn primary" disabled={busy} onClick={() => void apply()}>Apply reviewed release</button>
        </div>
      </section>}
      <SectionHead label="Recorded resolutions" count={reading.resolutions.length} />
      {reading.resolutions.map(row => <div className="recovery-entry" key={row.id}>
        <p>{row.module} · {row.operationId} · {new Date(row.at).toLocaleString()}</p>
        <p>{row.decision}</p>
        <p className="recovery-path">Generation {row.generation}</p>
      </div>)}
    </>}
  </main>;
}
