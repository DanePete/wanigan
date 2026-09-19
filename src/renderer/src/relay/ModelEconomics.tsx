import { useEffect, useRef, useState } from 'react';
import type { ModelEconomicsQuote, ModelEconomicsStatus } from '@shared/model-economics';
import { Explainer, Hint, Note, SectionHead } from '../components/bits';
import OpenRouterConnection from './OpenRouterConnection';

/** Public metadata is fetched only on a press or an explicitly enabled daily refresh. */
export default function ModelEconomics() {
  const [status, setStatus] = useState<ModelEconomicsStatus | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [model, setModel] = useState('');
  const [input, setInput] = useState('50000');
  const [output, setOutput] = useState('5000');
  const [cached, setCached] = useState('0');
  const [quotes, setQuotes] = useState<ModelEconomicsQuote[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  useEffect(() => {
    let alive = true;
    void window.wanigan.modelEconomics.status().then(next => {
      if (alive) { setStatus(next); setSelected(next.selectedModelIds); }
    }).catch((cause: unknown) => { if (alive) setError(String(cause)); });
    return () => { alive = false; };
  }, []);
  const act = async (run: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(null);
    try { await run(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { pending.current = false; setBusy(false); }
  };
  const compare = async () => {
    setQuotes(await window.wanigan.modelEconomics.quote({
      modelIds: selected,
      workload: { inputTokens: Number(input), outputTokens: Number(output), cachedInputTokens: Number(cached), cacheWriteTokens: 0, requests: 1 },
      requirements: { tools: true, effort: null, toolChoice: null },
    }));
  };
  return <Explainer id="relay-model-prices" title="Compare hosted model prices" defaultHidden>
    <SectionHead label="OpenRouter price explorer" />
    <p>Compare published prices for the same sample request, including hosted open models. No API key or model call is needed.</p>
    {error && <Note tone="error" onDismiss={() => setError(null)}>{error}</Note>}
    {status?.lastError && <Note tone="warn">{status.lastError}</Note>}
    <div className="row">
      <button className="btn" disabled={busy} onClick={() => void act(async () => {
        setStatus(await window.wanigan.modelEconomics.refresh({ modelIds: selected })); setQuotes(null);
      })}>{busy ? 'Working…' : status?.catalogue ? 'Refresh prices' : 'Get model prices'}</button>
      <label><input type="checkbox" checked={status?.settings.automaticRefresh ?? false} disabled={busy || !status}
        onChange={event => { const automaticRefresh = event.target.checked; void act(async () => {
          setStatus(await window.wanigan.modelEconomics.setSettings({ automaticRefresh }));
        }); }} /> Keep prices current daily</label>
    </div>
    <Hint>{status?.catalogue
      ? `${status.catalogue.rows.length} models · ${status.endpointCoverage.fresh} models with fresh hosting details · updated ${new Date(status.catalogue.fetchedAt).toLocaleString()}${status.stale ? ' · refresh needed' : ''}`
      : 'Opening this section reads saved data only. Refresh contacts OpenRouter’s public catalogue.'}</Hint>
    {status?.catalogue && <>
      <div className="row2">
        <label><span className="label">Model to compare</span>
          <select className="field" value={model} disabled={busy} onChange={event => setModel(event.target.value)}>
            <option value="">Choose from the catalogue</option>
            {status.catalogue.rows.filter(row => row.supportedParameters.includes('tools')).map(row =>
              <option key={row.id} value={row.id}>{row.name} · {row.id}</option>)}
          </select>
        </label>
        <button className="btn" disabled={busy || !model || selected.includes(model) || selected.length >= 12}
          onClick={() => { setSelected(rows => [...rows, model]); setQuotes(null); }}>Add to comparison</button>
      </div>
      {selected.length > 0 && <>
        <ul>{selected.map(id => <li key={id}>{id} <button className="btn btn-sm" disabled={busy}
          aria-label={`Remove ${id} from comparison`} onClick={() => { setSelected(rows => rows.filter(row => row !== id)); setQuotes(null); }}>Remove</button></li>)}</ul>
        <Hint>Compare up to 12 models. Refresh prices after changing this list to retrieve each hosting provider’s details.</Hint>
        <div className="row2">
          <label><span className="label">Input tokens per request</span><input className="field" type="number" min="1" step="1" value={input} disabled={busy}
            onChange={event => { setInput(event.target.value); setQuotes(null); }} /></label>
          <label><span className="label">Output tokens, including reasoning</span><input className="field" type="number" min="1" step="1" value={output} disabled={busy}
            onChange={event => { setOutput(event.target.value); setQuotes(null); }} /></label>
          <label><span className="label">Input tokens read from cache</span><input className="field" type="number" min="0" step="1" value={cached} disabled={busy}
            onChange={event => { setCached(event.target.value); setQuotes(null); }} /></label>
        </div>
        <button className="btn" disabled={busy} onClick={() => void act(compare)}>Compare sample cost</button>
      </>}
    </>}
    {quotes && <>
      <div className="rl-price-results" tabIndex={0} role="region" aria-label="Hosting price comparison"><table>
        <caption>Published sample request estimates, lowest eligible price first</caption>
        <thead><tr><th scope="col">Model / hosting provider</th><th scope="col">Sample cost</th><th scope="col">Price and capability checks</th></tr></thead>
        <tbody>{quotes.slice(0, 40).map(row => <tr key={`${row.modelId}:${row.endpointTag}`}>
          <td>{row.name}<br /><span className="faint">{row.endpointTag ?? 'Hosting details not loaded'}{row.quantization ? ` · ${row.quantization}` : ''}</span></td>
          <td>{row.estimateUsd === null ? 'Unknown' : row.estimateUsd > 0 && row.estimateUsd < 0.000001 ? '<$0.000001' : `$${row.estimateUsd.toFixed(6)}`}</td>
          <td>{row.eligible ? 'Published requirements match' : row.reasons.join(' ')}<br /><span className="faint">Excludes: {row.excludedCharges.join('; ')}.</span></td>
        </tr>)}</tbody>
      </table></div>
      {quotes.length > 40 && <Hint>Showing the first 40 hosting options. Reduce the comparison list to inspect the others.</Hint>}
      {!quotes.length && <Hint>No saved prices match this comparison yet. Refresh the selected models.</Hint>}
    </>}
    <Hint>These are price estimates, not measured coding results or a task budget. A model still needs a compatible, tested coding assistant before Relay can run it.</Hint>
    <OpenRouterConnection />
  </Explainer>;
}
