import { useEffect, useMemo, useState } from 'react';
import type { LaunchOptions, Project, ProviderId, ProviderInfo, TrustLevel } from '@shared/types';
import { EFFORT_LEVELS, PERMISSION_MODES, TRUST_COPY, TRUST_LEVELS } from '@shared/types';

const TINT: Record<ProviderId, string> = { claude: 'var(--claude)', codex: 'var(--codex)', glm: 'var(--glm)' };

/** Same filled progression the session header uses: ◇ → ◈ → ◆ reads in greyscale. */
const TRUST_GLYPH: Record<TrustLevel, string> = { readonly: '◇', project: '◈', trusted: '◆' };

/**
 * index.css owns the global focus styles and this dialog does not; the buttons
 * it hand-styles therefore carry their own ring. :focus-visible is asked of the
 * element, so a click never draws one and a Tab always does.
 */
function FocusBtn({ style, onFocus, onBlur, children, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const [ring, setRing] = useState(false);
  return (
    <button
      {...rest}
      onFocus={(e) => { setRing(e.currentTarget.matches(':focus-visible')); onFocus?.(e); }}
      onBlur={(e) => { setRing(false); onBlur?.(e); }}
      style={ring ? { ...style, outline: '2px solid var(--accent)', outlineOffset: 1 } : style}
    >
      {children}
    </button>
  );
}

export default function NewSessionDialog({
  providers, projects, defaultProjectId, onClose, onCreate, onAddProject,
}: {
  providers: ProviderInfo[];
  projects: Project[];
  defaultProjectId?: string;
  onClose: () => void;
  onCreate: (opts: LaunchOptions) => Promise<void>;
  onAddProject: () => Promise<void>;
}) {
  const installed = providers.filter((p) => p.path);
  const [providerId, setProviderId] = useState<ProviderId>(installed[0]?.id ?? 'claude');
  const provider = providers.find((p) => p.id === providerId);
  const [projectId, setProjectId] = useState(defaultProjectId ?? projects[0]?.id ?? '');
  /*
   * A folder you have not added yet was unreachable from here: the select only
   * offered projects that already existed, so starting an agent somewhere new
   * meant leaving the dialog, adding the folder, and coming back. Browsing adds
   * it and selects it in one step; `picked` holds it until the parent's list
   * catches up, so the option is selectable on the very next frame.
   */
  const [picked, setPicked] = useState<Project[]>([]);
  const [browsing, setBrowsing] = useState(false);
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [permissionMode, setPermissionMode] = useState('');
  const [extraArgs, setExtraArgs] = useState('');
  const [initialPrompt, setInitialPrompt] = useState('');
  const [isolate, setIsolate] = useState(false);
  const [trust, setTrust] = useState<TrustLevel | null>(null);
  const [trustDefault, setTrustDefault] = useState<TrustLevel | null>(null);
  const [trustErr, setTrustErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const options = useMemo(() => {
    const seen = new Set(projects.map((p) => p.id));
    return [...projects, ...picked.filter((p) => !seen.has(p.id))];
  }, [projects, picked]);

  async function browseForFolder() {
    setBrowsing(true);
    try {
      const p = await window.wanigan.projects.pick();
      if (p) { setPicked((x) => [...x, p]); setProjectId(p.id); }
    } catch { /* the dialog was cancelled, or the folder vanished */ }
    finally { setBrowsing(false); }
  }

  const project = options.find((p) => p.id === projectId) ?? null;
  const isRepo = !!project?.branch;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void go();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // What this project's agents may do is decided before launch, not discovered
  // afterwards from a denial in the terminal.
  useEffect(() => {
    let live = true;
    setTrust(null); setTrustErr(null);
    Promise.all([
      window.wanigan.policy.trust(projectId || null),
      window.wanigan.policy.defaultTrust(),
    ])
      .then(([t, d]) => { if (live) { setTrust(t); setTrustDefault(d); } })
      .catch((e) => { if (live) setTrustErr(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [projectId]);

  // A folder that is not a git repo has no worktree to cut.
  useEffect(() => { if (!isRepo) setIsolate(false); }, [isRepo]);

  async function go() {
    if (!projectId || busy) return;
    setBusy(true); setErr(null);
    try {
      await onCreate({ providerId, projectId, model, effort, permissionMode, extraArgs, initialPrompt, isolate });
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  const elevated = !!trust && !!trustDefault
    && TRUST_LEVELS.indexOf(trust) > TRUST_LEVELS.indexOf(trustDefault);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 14 }}>New session</h2>

        <div className="label">Agent</div>
        <div style={{ display: 'flex', gap: 8, margin: '6px 0 14px' }}>
          {providers.map((p) => {
            const on = providerId === p.id;
            return (
              <FocusBtn
                key={p.id}
                disabled={!p.path}
                onClick={() => setProviderId(p.id)}
                className="btn"
                style={{
                  flex: 1, flexDirection: 'column', alignItems: 'flex-start', gap: 2, padding: '9px 11px',
                  borderColor: on ? TINT[p.id] : 'var(--line)',
                  background: on ? 'var(--bg-sunk)' : 'var(--bg-soft)',
                }}
                title={p.path ?? `${p.bin} not found on PATH`}
              >
                <span style={{ fontWeight: 600, color: on ? TINT[p.id] : undefined }}>{p.label}</span>
                <span className="faint mono" style={{ fontSize: 10.5 }}>
                  {p.path ? (p.version ?? 'installed') : 'not installed'}
                </span>
              </FocusBtn>
            );
          })}
        </div>

        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span className="label">Project</span>
          <FocusBtn className="faint" style={{ fontSize: 11.5, marginLeft: 'auto', borderRadius: 5 }}
                    disabled={browsing} onClick={browseForFolder}>
            {browsing ? 'choosing…' : '+ choose a folder…'}
          </FocusBtn>
        </div>
        {options.length ? (
          <div style={{ display: 'flex', gap: 6, margin: '6px 0 14px' }}>
            <select className="field" style={{ flex: 1, minWidth: 0 }}
                    value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              {options.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}{p.branch ? ` — ${p.branch}` : ''}
                </option>
              ))}
            </select>
            <FocusBtn className="btn" style={{ flex: 'none' }} disabled={browsing}
                      title="Start a session in a folder that is not on the list yet"
                      onClick={browseForFolder}>Browse…</FocusBtn>
          </div>
        ) : (
          <div style={{ margin: '6px 0 14px' }}>
            <FocusBtn className="btn btn-primary" disabled={browsing} onClick={browseForFolder}>
              {browsing ? 'Choosing…' : 'Choose a folder to work in'}
            </FocusBtn>
            <p className="faint" style={{ marginTop: 6 }}>
              Any folder works. It is added to your projects so batches and Context can see it too.
            </p>
          </div>
        )}

        {/* ── P19 · what this project's agents are allowed to do ───────── */}
        <div className="label">Trust</div>
        <div className="sunk" style={{ margin: '6px 0 14px', padding: '9px 11px' }}>
          {trustErr ? (
            <p style={{ color: 'var(--bad)', fontSize: 12, lineHeight: 1.45 }}>
              <span aria-hidden="true" style={{ fontWeight: 700, marginRight: 6 }}>✕</span>
              Wanigan could not read this project's trust level: {trustErr} The session will still start
              under whatever the main process decides — close this dialog and reopen it to read again.
            </p>
          ) : !trust ? (
            <p className="faint" style={{ fontSize: 12 }}>Reading the trust level…</p>
          ) : (
            <>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 7 }}>
                <span aria-hidden="true"
                      style={{ color: elevated ? 'var(--warning)' : 'var(--text-dim)', fontWeight: 700 }}>
                  {TRUST_GLYPH[trust]}
                </span>
                <span style={{ fontWeight: 650, fontSize: 12.5,
                               color: elevated ? 'var(--warning)' : 'var(--text)' }}>
                  {TRUST_COPY[trust].label}
                </span>
                {trustDefault && (
                  <span className="faint" style={{ fontSize: 11, marginLeft: 'auto' }}>
                    {trust === trustDefault
                      ? 'your default'
                      : `default is ${TRUST_COPY[trustDefault].label} ${TRUST_GLYPH[trustDefault]}`}
                  </span>
                )}
              </div>
              <p className="dim" style={{ fontSize: 12, marginTop: 3, lineHeight: 1.45 }}>
                {TRUST_COPY[trust].detail}
              </p>
              {elevated && (
                <p style={{ color: 'var(--warning)', fontSize: 11.5, marginTop: 5, lineHeight: 1.45 }}>
                  <span aria-hidden="true" style={{ fontWeight: 700, marginRight: 5 }}>⚠</span>
                  Above your default. The session header says so for as long as this session runs.
                </p>
              )}
              <p className="faint" style={{ fontSize: 11, marginTop: 5, lineHeight: 1.45 }}>
                Trust is set per project and applies to every session in it.
              </p>
            </>
          )}
        </div>

        <div className="label">Model <span style={{ textTransform: 'none' }}>— blank uses the CLI default</span></div>
        <div style={{ display: 'flex', gap: 5, margin: '6px 0 14px', flexWrap: 'wrap' }}>
          {['', 'opus', 'sonnet', 'haiku', 'fable'].map((m) => (
            <FocusBtn key={m || 'default'} className="pill" onClick={() => setModel(m)}
                      aria-pressed={model === m}
                      style={model === m ? { background: 'var(--accent)', color: '#0c0e12' }
                                         : { background: 'var(--bg-sunk)', color: 'var(--text-dim)' }}>
              {m || 'default'}
            </FocusBtn>
          ))}
        </div>

        {provider?.supports.effort && (
          <>
            <div className="label">Effort <span style={{ textTransform: 'none' }}>— governs thinking depth, tool calls and length</span></div>
            <div style={{ display: 'flex', gap: 5, margin: '6px 0 14px', flexWrap: 'wrap' }}>
              {['', ...EFFORT_LEVELS].map((l) => (
                <FocusBtn key={l || 'default'} className="pill" onClick={() => setEffort(l)}
                          aria-pressed={effort === l}
                          style={effort === l ? { background: 'var(--accent)', color: '#0c0e12' }
                                              : { background: 'var(--bg-sunk)', color: 'var(--text-dim)' }}>
                  {l || 'default'}
                </FocusBtn>
              ))}
            </div>
          </>
        )}

        {provider?.supports.permissionMode && (
          <>
            <div className="label">Permission mode</div>
            <select className="field" style={{ margin: '6px 0 14px' }} value={permissionMode}
                    onChange={(e) => setPermissionMode(e.target.value)}>
              <option value="">default</option>
              {PERMISSION_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            {(permissionMode === 'bypassPermissions' || permissionMode === 'dontAsk') && (
              <p style={{ color: 'var(--warn)', fontSize: 11, marginTop: -8, marginBottom: 12, lineHeight: 1.45 }}>
                This session will not ask before running commands or editing files. Only use it in a
                repo you can throw away or fully revert.
              </p>
            )}
          </>
        )}

        {/* ── P9 · isolation ───────────────────────────────────────────── */}
        <div className="label">Working tree</div>
        <label className="sunk"
               style={{ display: 'flex', gap: 9, alignItems: 'flex-start', margin: '6px 0 14px',
                        padding: '9px 11px', cursor: isRepo ? 'pointer' : 'not-allowed' }}>
          <input type="checkbox" checked={isolate} disabled={!isRepo}
                 onChange={(e) => setIsolate(e.target.checked)}
                 style={{ marginTop: 2, accentColor: 'var(--accent)', width: 14, height: 14, flex: 'none' }} />
          <span style={{ minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: 12.5, fontWeight: 600 }}>
              <span aria-hidden="true" style={{ color: 'var(--accent)', marginRight: 6 }}>⑂</span>
              Isolate in a worktree
            </span>
            {isRepo ? (
              <span className="dim" style={{ display: 'block', fontSize: 11.5, marginTop: 3, lineHeight: 1.45 }}>
                Cuts a branch and a private checkout for this session, so two agents in {project?.name} stop
                overwriting each other's files. Merge or discard it from the session header when the work
                is done; a worktree with nothing uncommitted is cleaned up on exit.
              </span>
            ) : (
              <span className="faint" style={{ display: 'block', fontSize: 11.5, marginTop: 3, lineHeight: 1.45 }}>
                {project
                  ? `${project.name} is not a git repository, so there is no worktree to cut. Run "git init" in it, or leave this off and the session runs in the folder itself.`
                  : 'Pick a project first — isolation needs a git repository.'}
              </span>
            )}
          </span>
        </label>

        <div className="label">First message <span style={{ textTransform: 'none' }}>(optional)</span></div>
        <textarea className="field mono" rows={3} style={{ margin: '6px 0 4px', resize: 'vertical' }}
                  placeholder="Typed into the session once it is up."
                  value={initialPrompt} onChange={(e) => setInitialPrompt(e.target.value)} />

        <details style={{ margin: '10px 0 4px' }}>
          <summary className="faint" style={{ cursor: 'pointer', fontSize: 11.5 }}>Extra CLI flags</summary>
          <input className="field mono" style={{ marginTop: 6 }}
                 placeholder="--resume    --permission-mode plan"
                 value={extraArgs} onChange={(e) => setExtraArgs(e.target.value)} />
        </details>

        {err && (
          <div style={{ background: 'var(--bad-soft)', color: 'var(--bad)', border: '1px solid var(--bad)',
                        borderRadius: 6, padding: '7px 10px', margin: '10px 0', fontSize: 12, lineHeight: 1.45 }}>
            <span aria-hidden="true" style={{ fontWeight: 700, marginRight: 6 }}>✕</span>
            <span style={{ fontWeight: 650 }}>The session did not start. </span>{err}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <FocusBtn className="btn" onClick={onClose} style={{ marginLeft: 'auto' }}>Cancel</FocusBtn>
          <FocusBtn className="btn btn-primary" onClick={go} disabled={!projectId || busy}>
            {busy ? 'Starting…' : isolate ? 'Start in a worktree' : 'Start session'}
          </FocusBtn>
        </div>
        <p className="faint" style={{ fontSize: 11, marginTop: 8, textAlign: 'right' }}>⌘↵ to start</p>
      </div>
    </div>
  );
}
