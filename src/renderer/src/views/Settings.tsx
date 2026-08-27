import { useEffect, useState } from 'react';
import type { Project, ProviderInfo } from '@shared/types';
import { Note, Section } from '../components/bits';

type KeyStatus = { present: boolean; fingerprint: string | null; encryptionAvailable: boolean; fromEnv: boolean; workspaceId: string | null };

export default function Settings({ providers, projects, onKeyChange, onRemoveProject, onAddProject }: {
  providers: ProviderInfo[];
  projects: Project[];
  onKeyChange: () => void;
  onRemoveProject: (id: string) => void;
  onAddProject: () => void;
}) {
  const [status, setStatus] = useState<KeyStatus | null>(null);
  const [input, setInput] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');
  const [showWorkspace, setShowWorkspace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const load = () => window.foreman.key.status().then((st) => {
    setStatus(st);
    if (st.workspaceId) { setWorkspaceId(st.workspaceId); setShowWorkspace(true); }
  });
  useEffect(() => { void load(); }, []);

  async function save() {
    setBusy(true); setMsg(null);
    try {
      const r = await window.foreman.key.set(input.trim(), workspaceId.trim() || undefined);
      setInput('');
      setMsg({ tone: 'ok', text: `${r.detail}${r.batches ? ' · Batches API reachable.' : ' · Batches API NOT reachable for this workspace.'}` });
      await load(); onKeyChange();
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      // Identity-linked keys need the workspace named; reveal the field rather
      // than making the user find a setting they have not been shown.
      if (text.includes('identity-linked') || text.includes('workspace')) setShowWorkspace(true);
      setMsg({ tone: 'error', text });
    } finally { setBusy(false); }
  }

  async function verify() {
    setBusy(true); setMsg(null);
    const r = await window.foreman.key.verify();
    setMsg({ tone: r.ok ? 'ok' : 'error', text: r.detail + (r.ok && !r.batches ? ' · Batches API NOT reachable.' : '') });
    setBusy(false);
  }

  async function clear() {
    await window.foreman.key.clear();
    setMsg(null); await load(); onKeyChange();
  }

  return (
    <div className="pane" style={{ maxWidth: 780 }}>
      <div className="pane-head"><div><h1>Settings</h1></div></div>

      <Section title="Claude Platform API key"
               hint="Needed for Batches — estimating, dry runs, and submitting. Agent sessions do not use it; they authenticate through their own CLI.">
        {status?.fromEnv && (
          <div style={{ marginBottom: 11 }}>
            <Note tone="info">
              <code className="mono">ANTHROPIC_API_KEY</code> is set in the environment and takes precedence
              over anything stored here.
            </Note>
          </div>
        )}

        {status?.present ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: 11 }}>
            <span className="pill" style={{ background: 'var(--ok-soft)', color: 'var(--ok)' }}>key installed</span>
            <span className="mono faint">{status.fingerprint}</span>
            {status.workspaceId && (
              <span className="pill mono" style={{ background: 'var(--bg-sunk)', color: 'var(--text-dim)' }}
                    title="anthropic-workspace-id sent on every request">{status.workspaceId}</span>
            )}
            <button className="btn" style={{ marginLeft: 'auto' }} onClick={verify} disabled={busy}>Verify</button>
            <button className="btn btn-danger" onClick={clear} disabled={busy}>Remove</button>
          </div>
        ) : (
          <div style={{ marginBottom: 11 }}>
            <Note tone="warn">
              No key stored. Batches cannot estimate or submit without one.
            </Note>
          </div>
        )}

        <label className="label">{status?.present ? 'Replace key' : 'Paste your key'}</label>
        <div style={{ display: 'flex', gap: 7, marginTop: 4 }}>
          <input className="field mono" type="password" placeholder="sk-ant-api03-…" value={input}
                 autoComplete="off" spellCheck={false}
                 onChange={(e) => setInput(e.target.value)}
                 onKeyDown={(e) => { if (e.key === 'Enter' && input.trim()) void save(); }} />
          <button className="btn btn-primary" onClick={save} disabled={busy || !input.trim()}>
            {busy ? 'Verifying…' : 'Save'}
          </button>
        </div>

        {showWorkspace ? (
          <div style={{ marginTop: 11 }}>
            <label className="label">
              Workspace ID
              <span className="faint" style={{ textTransform: 'none' }}> — required for identity-linked keys</span>
            </label>
            <input className="field mono" style={{ marginTop: 4 }} placeholder="wrkspc_…"
                   value={workspaceId} spellCheck={false}
                   onChange={(e) => setWorkspaceId(e.target.value)}
                   onKeyDown={(e) => { if (e.key === 'Enter' && input.trim()) void save(); }} />
            <p className="faint" style={{ fontSize: 11, marginTop: 4, lineHeight: 1.45 }}>
              Console → Settings → Workspaces. Sent as the{' '}
              <span className="mono">anthropic-workspace-id</span> header on every request.
              Plain API keys ignore it, so leaving it set is harmless.
            </p>
          </div>
        ) : (
          <button className="faint" style={{ fontSize: 11.5, marginTop: 8 }}
                  onClick={() => setShowWorkspace(true)}>
            + add a Workspace ID (needed for identity-linked keys)
          </button>
        )}

        {msg && <div style={{ marginTop: 11 }}><Note tone={msg.tone === 'ok' ? 'ok' : 'error'}>{msg.text}</Note></div>}

        <div className="sunk" style={{ padding: '10px 12px', marginTop: 14, fontSize: 12, lineHeight: 1.55 }}>
          <p>
            <strong>This is not your Claude Code subscription.</strong> The Batches API bills per token
            against a Claude Platform account with its own credit balance. Get a key at{' '}
            <button className="link" onClick={() => window.open('https://console.anthropic.com/settings/keys')}>
              console.anthropic.com/settings/keys
            </button>. A Claude Code OAuth token is rejected.
          </p>
          <p className="dim" style={{ marginTop: 8 }}>
            The key is verified against the live API before it is saved, then encrypted with{' '}
            {status?.encryptionAvailable ? 'your macOS Keychain' : 'the OS credential store'} — it is never
            written to a plaintext file, never logged, and never sent to the renderer.
          </p>
          <p className="dim" style={{ marginTop: 8 }}>
            <strong>Identity-linked keys need a Workspace ID.</strong> If your organisation issues keys
            tied to an identity, the API returns a 400 until every request names the workspace it acts in.
            Foreman sends it as the <span className="mono">anthropic-workspace-id</span> header.
            <br /><br />
            <strong>Workload identity federation is a different thing</strong> and does not apply here: it
            exchanges a short-lived JWT from a cloud or CI identity provider, so it only works on GCP, AWS,
            Azure or GitHub Actions. A local desktop app has nothing to federate from.
          </p>
        </div>
      </Section>

      <Section title="Agents" hint="Resolved from your login shell's PATH, then from editor extension directories.">
        {providers.map((p) => (
          <div key={p.id} style={{ display: 'flex', gap: 11, alignItems: 'center', padding: '7px 0',
                                   borderTop: '1px solid var(--line-soft)' }}>
            <span style={{ fontWeight: 600, minWidth: 110 }}>{p.label}</span>
            {p.path ? (
              <>
                <span className="pill" style={{ background: 'var(--ok-soft)', color: 'var(--ok)' }}>{p.version ?? 'installed'}</span>
                <span className="faint mono trunc" style={{ fontSize: 10.5, flex: 1 }} title={p.path}>{p.path}</span>
              </>
            ) : (
              <span className="faint">not found — <code className="mono">{p.bin}</code> is not on PATH or in an editor extension</span>
            )}
          </div>
        ))}
      </Section>

      <Section title="Projects" hint="Shared by both views — an agent session and a batch run target the same repo."
               right={<button className="btn" onClick={onAddProject}>+ Add project</button>}>
        {!projects.length && <p className="dim">No projects yet.</p>}
        {projects.map((p) => (
          <div key={p.id} style={{ display: 'flex', gap: 11, alignItems: 'center', padding: '7px 0',
                                   borderTop: '1px solid var(--line-soft)' }}>
            <span style={{ fontWeight: 500 }}>{p.name}</span>
            {p.branch && <span className="pill mono" style={{ background: 'var(--bg-sunk)', color: 'var(--text-dim)' }}>{p.branch}</span>}
            <span className="faint mono trunc" style={{ fontSize: 10.5, flex: 1 }} title={p.path}>{p.path}</span>
            <button className="faint" style={{ fontSize: 11.5 }} onClick={() => onRemoveProject(p.id)}>remove</button>
          </div>
        ))}
      </Section>
    </div>
  );
}
