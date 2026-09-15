import { useEffect, useState } from 'react';
import type { CodexImportOutcome, CodexImportPlan } from '@shared/codex-import';
import type { PastSession } from '@shared/types';
import { Mark, Note, size } from './bits';
import { useDialog } from './useDialog';
import '../styles/runtime.css';

/**
 * Continue a Claude conversation in Codex: consent, import, then resume.
 *
 * The dialog shows exactly what Codex will receive before anything runs — the
 * one transcript file, the one Codex account and its CODEX_HOME — and every
 * part of a Claude setup it will not receive. Importing starts no turn and
 * spends nothing; resuming is a separate button that opens `codex resume` on
 * the new thread through Wanigan's normal recovery path, which is where tokens
 * would start to be spent.
 */

function msg(e: unknown): string {
  return e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e);
}

export default function ContinueInCodexDialog({ past, onClose, onResumed, onError }: {
  past: PastSession;
  onClose: () => void;
  onResumed: (sessionId: string) => void;
  onError: (message: string) => void;
}) {
  const [accountId, setAccountId] = useState<string | null>(null);
  const [plan, setPlan] = useState<CodexImportPlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'import' | 'resume' | null>(null);
  const [outcome, setOutcome] = useState<CodexImportOutcome | null>(null);
  const { portal, backdropProps, dialogProps } = useDialog<HTMLElement>({ onClose, initialFocus: 'least-destructive' });

  useEffect(() => {
    let live = true;
    setPlan(null);
    window.wanigan.codexImport.plan(past.id, accountId)
      .then((next) => { if (live) { setPlan(next); setPlanError(null); } })
      .catch((e) => { if (live) setPlanError(msg(e)); });
    return () => { live = false; };
  }, [past.id, accountId]);

  const runImport = async () => {
    if (!plan?.transcript || !plan.codex) return;
    setBusy('import');
    try { setOutcome(await window.wanigan.codexImport.run(plan.sessionId, plan.codex.accountId, plan.transcript.path)); }
    catch (e) { setOutcome({ ok: false, error: msg(e) }); }
    finally { setBusy(null); }
  };

  const resume = async () => {
    if (!outcome?.ok || !outcome.projectId) return;
    setBusy('resume');
    try {
      const session = await window.wanigan.sessions.recoverExactCodex({ threadId: outcome.threadId, projectId: outcome.projectId });
      onResumed(session.id);
      onClose();
    } catch (e) {
      onError(msg(e));
      setBusy(null);
    }
  };

  return portal(
    <div {...backdropProps}>
      <section {...dialogProps} className="modal codex-continue" aria-labelledby="codex-continue-title">
        <h2 id="codex-continue-title" className="codex-continue-title">Continue in Codex</h2>
        <p className="codex-continue-lead">
          Codex imports this Claude Code conversation with its own importer and files it as a new Codex thread.
          Importing starts no turn and spends nothing.
        </p>
        {planError && <Note tone="error">{planError}</Note>}
        {!plan && !planError && <p className="proc-reading">Reading what would be imported…</p>}
        {plan && (
          <dl className="codex-continue-facts">
            <dt>Transcript Codex will import</dt>
            <dd><code data-codex-transcript>{plan.transcript?.path ?? 'not found'}</code>{plan.transcript ? ` · ${size(plan.transcript.bytes)}` : ''}</dd>
            <dt>Codex account</dt>
            <dd>
              {plan.codexAccounts.length > 1 ? (
                <select className="field" aria-label="Codex account to import into" value={plan.codex?.accountId ?? ''}
                        disabled={busy !== null || outcome !== null}
                        onChange={(e) => setAccountId(e.target.value)}>
                  {plan.codexAccounts.map((a) => <option key={a.accountId} value={a.accountId}>{a.label}</option>)}
                </select>
              ) : <span>{plan.codex?.label ?? 'none configured'}</span>}
              {plan.codex && <span className="codex-continue-home">CODEX_HOME <code>{plan.codex.home}</code></span>}
            </dd>
            <dt>Filed under</dt>
            <dd><code>{plan.cwd}</code></dd>
            <dt>Only the conversation</dt>
            <dd>
              Not imported: {plan.notImported.join(', ')}. Codex&rsquo;s importer can carry those too; Wanigan sends a
              single conversation item and nothing else, so Claude&rsquo;s setup never becomes Codex&rsquo;s.
            </dd>
            {plan.codexVersion && <><dt>Codex</dt><dd>{plan.codexVersion}</dd></>}
          </dl>
        )}
        {plan?.refusal && (
          <div className="codex-continue-refusal">
            <Mark glyph="⊘" word="cannot import" tone="serious" />
            <span>{plan.refusal}</span>
          </div>
        )}
        {outcome && (outcome.ok ? (
          <Note tone="ok">
            Imported as Codex thread <code>{outcome.threadId}</code>
            {outcome.ledgerConfirmed ? ', confirmed in Codex’s import ledger.' : '. Codex’s import ledger did not list it, so only the importer’s reply names it.'}
            {' '}Resuming opens <code>codex resume</code> on it, which is when Codex starts spending.
          </Note>
        ) : <Note tone="error">The import did not complete: {outcome.error}</Note>)}
        <div className="codex-continue-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy !== null}>{outcome?.ok ? 'Close' : 'Cancel'}</button>
          {outcome?.ok ? (
            <button type="button" className="btn btn-primary" disabled={busy !== null || !outcome.projectId} onClick={() => void resume()}>
              {busy === 'resume' ? 'Opening…' : 'Resume in Codex'}
            </button>
          ) : (
            <button type="button" className="btn btn-primary" disabled={!plan || !!plan.refusal || busy !== null || outcome !== null}
                    onClick={() => void runImport()}>
              {busy === 'import' ? 'Importing…' : 'Import this conversation'}
            </button>
          )}
        </div>
      </section>
    </div>,
  );
}
