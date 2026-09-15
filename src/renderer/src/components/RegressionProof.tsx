import { useEffect, useState } from 'react';
import type { RegressionProofRecord } from '@shared/review-work';
import type { ProofRun, ProofVerdict } from '@shared/regression-proof';
import { Mark, Note, SectionHead, ago, type Tone } from './bits';
import '../styles/review-work.css';

/**
 * Fails before, passes after, for a verify task. The operator names one test
 * command, which main stores only after a confirmation dialog; running it
 * checks out the goal's base commit in a scratch worktree, runs the command
 * there and at head, and records both. No model call.
 */

const VERDICT: Record<ProofVerdict, { glyph: string; tone: Tone }> = {
  'proved': { glyph: '✓', tone: 'ok' },
  'not-a-regression-proof': { glyph: '○', tone: 'warn' },
  'still-failing': { glyph: '✕', tone: 'bad' },
  'could-not-run-before': { glyph: '?', tone: 'warn' },
  'could-not-run-after': { glyph: '?', tone: 'warn' },
};

function RunLine({ label, run }: { label: string; run: ProofRun }) {
  return (
    <details className="rw-section">
      <summary>{label} <span className="faint">
        {run.notRun ? 'did not run' : run.exitCode === null ? 'no exit code' : `exit ${run.exitCode}`}
        {run.commit ? ` · ${run.commit.slice(0, 8)}` : ''}{run.notRun ? '' : ` · ${(run.durationMs / 1000).toFixed(1)}s`}
      </span></summary>
      {run.notRun && <p className="rw-section-empty">{run.notRun}</p>}
      {run.outputTail && <pre className="diff rw-stage-patch">{run.outputTail}</pre>}
      {!run.notRun && !run.outputTail && <p className="faint rw-section-empty">The command printed nothing.</p>}
    </details>
  );
}

export default function RegressionProof({ nodeId, disabled }: { nodeId: string; disabled: boolean }) {
  const [command, setCommand] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [latest, setLatest] = useState<RegressionProofRecord | null>(null);
  const [busy, setBusy] = useState<'save' | 'run' | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setCommand(null); setDraft(''); setLatest(null); setErr(null);
    Promise.all([window.wanigan.proof.regressionCommand(nodeId), window.wanigan.proof.latestRegression(nodeId)])
      .then(([c, l]) => { if (!live) return; setCommand(c.command); setDraft(c.command ?? ''); setLatest(l); })
      .catch((e) => { if (live) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [nodeId]);

  const save = async () => {
    setBusy('save'); setErr(null);
    try { const saved = await window.wanigan.proof.saveRegressionCommand(nodeId, draft); setCommand(saved.command); setDraft(saved.command); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  };
  const run = async () => {
    setBusy('run'); setErr(null);
    try { setLatest(await window.wanigan.proof.runRegression(nodeId)); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  };

  return (
    <section className="rw-proof" aria-label="Regression proof">
      <SectionHead label="Regression proof" right={<span className="faint">optional</span>} />
      <p className="rw-because">
        Name one test that should fail before this change and pass after it. Wanigan runs it at the goal's base commit, in a scratch checkout it removes afterwards, and again at head.
      </p>
      <div className="rw-tier-row">
        <input className="field rw-tier-pattern" value={draft} aria-label="Regression proof test command" placeholder="npm test -- checkout.retry"
               onChange={(e) => setDraft(e.target.value)} disabled={busy !== null} />
        <button type="button" className="btn btn-sm" disabled={busy !== null || !draft.trim() || draft.trim() === command} onClick={() => void save()}>
          {busy === 'save' ? 'Confirming…' : command ? 'Change command…' : 'Save command…'}
        </button>
        <button type="button" className="btn btn-sm btn-primary" disabled={busy !== null || disabled || !command || draft.trim() !== command} onClick={() => void run()}>
          {busy === 'run' ? 'Running twice…' : 'Run regression proof'}
        </button>
      </div>
      {err && <Note tone="error">{err}</Note>}
      {latest && (
        <div className="rw-proof-result">
          <div className="rw-summary-line">
            <Mark glyph={VERDICT[latest.verdict].glyph} word={latest.label} tone={VERDICT[latest.verdict].tone} />
            <span className="faint">{ago(latest.createdAt)} · <span className="mono">{latest.command}</span></span>
          </div>
          <p className="rw-because">{latest.because}{latest.linked.length ? ` The base checkout linked ${latest.linked.join(', ')} from the repository.` : ''}</p>
          <RunLine label="Before (base commit)" run={latest.before} />
          <RunLine label="After (head)" run={latest.after} />
        </div>
      )}
    </section>
  );
}
