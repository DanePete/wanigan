import { useEffect, useRef, useState } from 'react';
import { MAX_IMPROVED_PROMPT_CHARS, MAX_PROMPT_IMPROVE_CHARS } from '@shared/prompt-improve';
import type { PromptImproveResult, PromptImproveStatus } from '@shared/prompt-improve';
import { Hint, Note, PageHead, SectionHead } from '../components/bits';
import { useDialog } from '../components/useDialog';
import type { PromptActionContext } from './registry';
import '../styles/prompt-improve.css';

/** A draft action only. The originating composer still owns every send. */
export function ImprovePromptAction(context: PromptActionContext) {
  const [original, setOriginal] = useState<string | null>(null);
  const tooLong = context.value.length > MAX_PROMPT_IMPROVE_CHARS;
  return <>
    <span className="prompt-action">
      <button type="button" className="btn btn-sm prompt-improve-trigger"
        disabled={context.disabled || !context.value.trim() || tooLong}
        onClick={() => { if (context.isCurrent(context.value)) setOriginal(context.value); }}>
        Improve prompt
      </button>
      {tooLong && <span className="faint">Improve up to {MAX_PROMPT_IMPROVE_CHARS.toLocaleString()} characters at a time.</span>}
    </span>
    {original !== null && <ImprovementDialog {...context} original={original} onClose={() => setOriginal(null)} />}
  </>;
}

function ImprovementDialog({ original, onClose, ...context }: PromptActionContext & {
  original: string; onClose: () => void;
}) {
  const [status, setStatus] = useState<PromptImproveStatus | null>(null);
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);
  const [settingBusy, setSettingBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<PromptImproveResult | null>(null);
  const [proposed, setProposed] = useState('');
  const active = useRef<string | null>(null);
  const mounted = useRef(true);
  const maximum = Math.min(context.maxLength ?? MAX_IMPROVED_PROMPT_CHARS, MAX_IMPROVED_PROMPT_CHARS);
  const stale = context.value !== original || context.disabled;
  const { portal, backdropProps, dialogProps } = useDialog<HTMLElement>({ onClose, initialFocus: 'least-destructive' });

  useEffect(() => {
    mounted.current = true;
    void window.wanigan.promptImprove.status().then(value => {
      if (!mounted.current) return;
      setStatus(value); setModel(value.defaultModel);
    }).catch(() => {
      if (mounted.current) setError('Prompt improvement is unavailable. Your draft is unchanged.');
    });
    return () => {
      mounted.current = false;
      const id = active.current;
      active.current = null;
      if (id) void window.wanigan.promptImprove.cancel(id).catch(() => {});
    };
  }, []);

  const toggle = async (enabled: boolean) => {
    if (settingBusy || busy) return;
    setSettingBusy(true); setError('');
    try {
      const next = await window.wanigan.promptImprove.setEnabled(enabled);
      if (mounted.current) setStatus(next);
    } catch {
      if (mounted.current) setError('The preference could not be saved. Please try again.');
    } finally { if (mounted.current) setSettingBusy(false); }
  };

  const generate = async () => {
    if (active.current || !status?.available || settingBusy || !context.isCurrent(original)) return;
    const id = crypto.randomUUID();
    active.current = id; setBusy(true); setError(''); setResult(null); setProposed('');
    try {
      const answer = await window.wanigan.promptImprove.improve({
        requestId: id, draft: original, purpose: context.purpose, maxLength: maximum, model,
      });
      if (!mounted.current || active.current !== id) return;
      if (answer.requestId !== id) throw new Error('The suggestion did not match this draft. Try again.');
      setResult(answer); setProposed(answer.prompt);
    } catch (failure) {
      if (mounted.current && active.current === id) {
        setError(failure instanceof Error ? failure.message : 'The suggestion could not be generated. Your draft is unchanged.');
      }
    } finally {
      if (mounted.current && active.current === id) { active.current = null; setBusy(false); }
    }
  };

  const apply = () => {
    if (!result || busy || !proposed.trim() || proposed.length > maximum) return;
    if (!context.isCurrent(original)) {
      setError('The original draft changed or is no longer editable. Close this preview and improve the current draft.');
      return;
    }
    context.onValueChange(proposed);
    onClose();
  };

  return portal(<div {...backdropProps}>
    <section {...dialogProps} className="modal pane prompt-improve" aria-label="Improve prompt" aria-busy={busy}
      onKeyDown={event => event.stopPropagation()}>
      <PageHead compact eyebrow="Prompt helper" title="Improve prompt"
        lead="Turn a rough draft into clear instructions. Review the suggestion before using it."
        actions={<button type="button" className="btn" data-initial-focus onClick={onClose}>Keep original</button>} />
      <div className="prompt-improve-body">
        {status ? <>
          <div className="prompt-improve-controls">
            <label>Rewrite model
              <select className="field" aria-label="Rewrite model" value={model} disabled={busy || settingBusy || !status.enabled}
                onChange={event => setModel(event.currentTarget.value)}>
                {status.models.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
              </select>
            </label>
            <label className="prompt-improve-switch">
              <input type="checkbox" checked={status.enabled} disabled={busy || settingBusy}
                onChange={event => void toggle(event.currentTarget.checked)} />
              Enable prompt improvement
            </label>
          </div>
          <Note role="none">Uses {status.models.find(option => option.id === model)?.label ?? model} through {status.providerLabel}.
            {' '}Billed to your configured API key, separately from any CLI subscription. Sends the draft and the kind of prompt you’re writing.</Note>
          {!status.available && <Note tone="warn">{status.reason ?? 'Prompt improvement is unavailable.'}</Note>}
        </> : !error && <p role="status">Loading prompt improvement…</p>}
        {error && <Note tone="error">{error}</Note>}
        {stale && <Note tone="warn">The original draft changed or is no longer editable. Close this preview and improve the current draft.</Note>}
        <div className="prompt-improve-drafts" data-preview={!!result}>
          <label>Original prompt
            <textarea className="field" aria-label="Original prompt" readOnly value={original} rows={8} />
          </label>
          {result && <label>Suggested prompt
            <textarea className="field" aria-label="Suggested prompt" value={proposed} rows={8} maxLength={maximum}
              onChange={event => setProposed(event.currentTarget.value)} />
          </label>}
        </div>
        {result && <>
          {result.questions.length > 0 && <section aria-label="Details to clarify">
            <SectionHead label="Details to clarify" />
            <p className="dim">These details were missing. Add any answers you know to the suggestion before using it.</p>
            <ul className="prompt-improve-questions">{result.questions.map((question, index) => <li key={index}>{question}</li>)}</ul>
          </section>}
          <Hint>{status?.models.find(option => option.id === result.model)?.label ?? result.model}
            {' · '}{result.inputTokens === null ? 'Input tokens unreported' : `${result.inputTokens.toLocaleString()} input tokens`}
            {' · '}{result.outputTokens === null ? 'Output tokens unreported' : `${result.outputTokens.toLocaleString()} output tokens`}
            {' · '}{result.estimatedCostUsd === null ? 'Cost unknown' : `Estimated $${result.estimatedCostUsd.toFixed(4)}`}</Hint>
        </>}
        <div className="prompt-improve-actions">
          <button type="button" className={`btn ${result ? '' : 'btn-primary'}`}
            disabled={!status?.available || busy || settingBusy || stale}
            onClick={() => void generate()}>{busy ? 'Improving…' : result ? 'Try another suggestion' : 'Generate suggestion'}</button>
          {result && <button type="button" className="btn btn-primary"
            disabled={busy || stale || !proposed.trim() || proposed.length > maximum}
            onClick={apply}>Use suggestion</button>}
          {busy && <span role="status" className="dim">Your original draft is safe. Keep original stops waiting; API billing may still apply.</span>}
          {!busy && <span className="dim">You decide when to send.</span>}
        </div>
      </div>
    </section>
  </div>);
}
