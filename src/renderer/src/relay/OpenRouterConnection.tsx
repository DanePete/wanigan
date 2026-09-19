import { useEffect, useRef, useState } from 'react';
import type { OpenRouterConnectionStatus } from '@shared/openrouter-connection';
import { Hint, Note, SectionHead } from '../components/bits';

export default function OpenRouterConnection() {
  const [status, setStatus] = useState<OpenRouterConnectionStatus | null>(null);
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  useEffect(() => {
    let alive = true;
    void window.wanigan.openRouterConnection.status().then(value => { if (alive) setStatus(value); })
      .catch((cause: unknown) => { if (alive) setError(String(cause)); });
    return () => { alive = false; };
  }, []);
  const act = async (run: () => Promise<OpenRouterConnectionStatus>) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(null);
    try { setStatus(await run()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { pending.current = false; setBusy(false); }
  };
  return <div className="rl-connection-options">
    <SectionHead label="Try an OpenRouter model" right={<span className="faint">Experimental · manual sessions</span>} />
    <p>Use the installed Codex CLI with an exact OpenRouter model ID. Hosted open models can reduce token prices; this connection has not yet verified their coding quality or billed cost.</p>
    {error && <Note tone="error" onDismiss={() => setError(null)}>{error}</Note>}
    {status?.hasKey && <Note tone="info">{status.fromEnv ? 'Using your environment credential' : 'Key stored in the OS-protected credential store'}{status.fingerprint ? ` · ${status.fingerprint}` : ''}. Saving a key does not test it or spend money.</Note>}
    {status?.unreadable && <Note tone="warn">The stored key cannot be read on this machine. Save it again to reconnect.</Note>}
    <label><span className="label">OpenRouter API key</span><input className="field" type="password" autoComplete="off" spellCheck={false}
      value={key} disabled={busy || !status?.encryptionAvailable} onChange={event => setKey(event.target.value)} placeholder="Stored securely; never shown again" /></label>
    <div className="row">
      <button className="btn" disabled={busy || !key.trim() || !status?.encryptionAvailable}
        onClick={() => { const value = key; setKey(''); void act(() => window.wanigan.openRouterConnection.setKey(value)); }}>Save key</button>
      {status?.stored && <button className="btn" disabled={busy} onClick={() => void act(() => window.wanigan.openRouterConnection.clearKey())}>Remove stored key</button>}
    </div>
    {status && !status.encryptionAvailable && <Hint>The OS credential store is unavailable, so a key cannot be saved securely.</Hint>}
    <Hint>After saving, choose OpenRouter in New session and enter a model ID from the catalogue. Requests send your session content through OpenRouter to its model provider. Automatic Relay progress is unavailable until execution and cost reporting are verified. Your existing Codex configuration still applies.</Hint>
  </div>;
}
