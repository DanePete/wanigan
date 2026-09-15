import { useState } from 'react';
import type { DiagnosticsPreview } from '@shared/diagnostics';
import type { DoctorReport } from '@shared/codex-doctor';
import { Mark, Note, Section, ago, size } from './bits';
import '../styles/runtime.css';

/**
 * Per-account health and the diagnostics bundle, both on demand from Settings.
 */

function msg(e: unknown): string {
  return e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e);
}

type DoctorRun = { ranAt: number; durationMs: number; exitCode: number | null; report: DoctorReport };

/** `codex doctor --json` for one Codex account, showing failing checks by name. */
export function CodexDoctorPanel({ accountId, label }: { accountId: string; label: string }) {
  const [run, setRun] = useState<DoctorRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    setBusy(true); setError(null);
    try { setRun(await window.wanigan.codexDoctor.run(accountId)); }
    catch (e) { setError(msg(e)); }
    finally { setBusy(false); }
  };
  const report = run?.report;
  return (
    <div className="doctor-panel" data-doctor-account={accountId}>
      <div className="doctor-head">
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void go()}
                aria-label={`Run codex doctor for ${label}`}>
          {busy ? 'Running codex doctor…' : run ? 'Run codex doctor again' : 'Run codex doctor'}
        </button>
        <span className="proc-reading">
          Reads this account&rsquo;s CODEX_HOME and checks that OpenAI&rsquo;s endpoints answer. It sends no prompt.
        </span>
      </div>
      {error && <Note tone="error">{error}</Note>}
      {run && report?.state === 'report' && (
        <div className="doctor-result">
          <p className="proc-reading">
            {report.codexVersion ? `Codex ${report.codexVersion} · ` : ''}{report.checks.length} checks · overall {report.overall}
            {' · '}ran {ago(run.ranAt)} in {Math.round(run.durationMs / 100) / 10}s
          </p>
          {report.failing.length === 0 && report.warnings.length === 0 && (
            <Mark glyph="✓" word="every check passed" tone="ok" />
          )}
          {[...report.failing, ...report.warnings].length > 0 && (
            <ul className="doctor-checks" aria-label="Checks that did not pass">
              {[...report.failing, ...report.warnings].map((check) => (
                <li key={check.id}>
                  <Mark glyph={check.status === 'warning' || check.status === 'warn' ? '!' : '✕'}
                        word={check.status} tone={check.status === 'warning' || check.status === 'warn' ? 'warn' : 'serious'} />
                  <code>{check.id}</code>
                  <span>{check.summary}</span>
                  {check.remediation && <span className="doctor-fix">{check.remediation}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {run && report?.state === 'unreadable' && <Note tone="warn" role="none">Could not read the doctor report: {report.reason}</Note>}
      {run && report?.state === 'summary-text' && (
        <div className="doctor-result">
          <p className="proc-reading">{report.note}</p>
          <pre className="doctor-text">{report.text}</pre>
        </div>
      )}
    </div>
  );
}

/** Export diagnostics: the exact file list first, then the native save dialog. */
export function DiagnosticsExport() {
  const [preview, setPreview] = useState<DiagnosticsPreview | null>(null);
  const [busy, setBusy] = useState<'preview' | 'save' | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const look = async () => {
    setBusy('preview'); setError(null); setSaved(null);
    try { setPreview(await window.wanigan.diagnostics.preview()); }
    catch (e) { setError(msg(e)); }
    finally { setBusy(null); }
  };
  const save = async () => {
    if (!preview) return;
    setBusy('save'); setError(null);
    try {
      const where = await window.wanigan.diagnostics.save(preview.files.map((f) => f.name));
      if (where) setSaved(where);
    } catch (e) { setError(msg(e)); }
    finally { setBusy(null); }
  };
  return (
    <Section title="Export diagnostics"
             hint="A zip you save yourself, for someone helping you. Wanigan sends nothing anywhere; you see every file before it is written.">
      <div className="diag-actions">
        <button type="button" className="btn" disabled={busy !== null} onClick={() => void look()}>
          {busy === 'preview' ? 'Preparing…' : preview ? 'Refresh the file list' : 'Export diagnostics…'}
        </button>
        {preview && (
          <button type="button" className="btn btn-primary" disabled={busy !== null} onClick={() => void save()}>
            {busy === 'save' ? 'Saving…' : `Save these ${preview.files.length} files as a zip…`}
          </button>
        )}
      </div>
      {error && <Note tone="error">{error}</Note>}
      {saved && <Note tone="ok">Saved to <code>{saved}</code>.</Note>}
      {preview && (
        <>
          <ul className="diag-files" aria-label="Files in the diagnostics bundle">
            {preview.files.map((file) => (
              <li key={file.name}>
                <code>{file.name}</code>
                <span className="diag-size">{size(file.bytes)}</span>
                <span className="diag-describes">{file.describes}</span>
              </li>
            ))}
          </ul>
          <p className="proc-reading">Not included: {preview.excluded.join('; ')}.</p>
        </>
      )}
    </Section>
  );
}
