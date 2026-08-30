import { useEffect, useMemo, useRef, useState } from 'react';
import type { LaunchOptions, Project, ProviderId, ProviderInfo, TrustLevel } from '@shared/types';
import { EFFORT_LEVELS, PERMISSION_MODES, TRUST_COPY, TRUST_LEVELS } from '@shared/types';

const TINT: Record<ProviderId, string> = { claude: 'var(--claude)', codex: 'var(--codex)', glm: 'var(--glm)', deepseek: 'var(--series-4)' };

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
  const [providerOptions, setProviderOptions] = useState<Record<string, string | boolean>>({});
  const [isolate, setIsolate] = useState(false);
  const [trust, setTrust] = useState<TrustLevel | null>(null);
  const [trustDefault, setTrustDefault] = useState<TrustLevel | null>(null);
  const [trustErr, setTrustErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const [codexModels, setCodexModels] = useState([
    { value: '', label: 'Auto (default)', description: 'Codex current default', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
    { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', description: 'Latest frontier agentic coding model', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
    { value: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', description: 'Balanced agentic coding model', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
    { value: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', description: 'Fast, affordable agentic coding model', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { value: 'gpt-5.5', label: 'GPT-5.5', description: null, efforts: ['low', 'medium', 'high', 'xhigh'] },
    { value: 'gpt-5.4', label: 'GPT-5.4', description: null, efforts: ['low', 'medium', 'high', 'xhigh'] },
  ]);

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
  // Do not offer Claude aliases to a Codex process.  Empty deliberately means
  // Codex's Auto/default route; its live /model picker offers the full dynamic
  // catalog and reasoning choices once the session is running.
  const codexHarness = provider?.harnessId === 'codex' || providerId === 'codex';
  const genericHarness = provider?.harnessId === 'generic-cli';
  const zaiBackend = provider?.backendId === 'zai' || providerId === 'glm';
  const deepseekBackend = provider?.backendId === 'deepseek' || providerId === 'deepseek';
  const manifestModelField = provider?.launchFields?.find((field) => field.id === 'model');
  const modelChoices = genericHarness
    ? (manifestModelField?.options ?? [])
    : codexHarness
    ? codexModels
    : zaiBackend
      ? [{ value: 'glm-5.3', label: 'GLM 5.3' }, { value: 'glm-5.3-flash', label: 'GLM 5.3 Flash' }, { value: 'glm-5.2', label: 'GLM 5.2' }, { value: '', label: 'Provider default' }]
      : deepseekBackend
        ? [{ value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' }, { value: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' }, { value: '', label: 'Provider default' }]
    : [{ value: '', label: 'default' }, { value: 'opus', label: 'opus' }, { value: 'sonnet', label: 'sonnet' }, { value: 'haiku', label: 'haiku' }, { value: 'fable', label: 'fable' }];

  useEffect(() => {
    setModel((current) => modelChoices.some((choice) => choice.value === current) ? current : '');
  // A provider switch is the only event that can make an otherwise valid
  // model alias invalid; modelChoices is derived wholly from it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId]);

  useEffect(() => {
    const next: Record<string, string | boolean> = {};
    for (const field of provider?.launchFields ?? []) {
      if (['model', 'effort', 'permissionMode'].includes(field.id)) continue;
      if (field.defaultValue !== undefined) next[field.id] = field.defaultValue;
    }
    setProviderOptions(next);
  }, [providerId, provider?.launchFields]);

  useEffect(() => {
    if (!codexHarness) return;
    let live = true;
    window.wanigan.codex.models().then((catalog) => {
      if (!live || !catalog.models.length) return;
      setCodexModels([
        { value: '', label: 'Auto (default)', description: 'Codex current default', efforts: catalog.models.find((m) => m.isDefault)?.reasoningEfforts ?? ['low', 'medium', 'high', 'xhigh', 'max'] },
        ...catalog.models.map((m) => ({ value: m.id, label: m.label, description: m.description, efforts: m.reasoningEfforts })),
      ]);
    }).catch(() => { /* static current-model fallback remains usable */ });
    return () => { live = false; };
  }, [codexHarness]);

  const effortChoices = useMemo(() => codexHarness
    ? (codexModels.find((choice) => choice.value === model)?.efforts ?? ['low', 'medium', 'high', 'xhigh', 'max'])
    : [...EFFORT_LEVELS], [codexHarness, model, codexModels]);

  useEffect(() => {
    if (!codexHarness) return;
    setEffort((current) => effortChoices.includes(current) ? current : '');
  }, [codexHarness, model, codexModels]);

  useEffect(() => {
    const priorFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = requestAnimationFrame(() => {
      dialogRef.current?.querySelector<HTMLElement>('button:not(:disabled), select:not(:disabled), input:not(:disabled), textarea:not(:disabled)')?.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
      priorFocus?.focus?.();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void go();
      if (e.key === 'Tab') {
        const dialog = dialogRef.current;
        if (!dialog) return;
        const focusable = [...dialog.querySelectorAll<HTMLElement>(
          'button:not(:disabled), select:not(:disabled), input:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])'
        )].filter((node) => !node.hasAttribute('hidden'));
        if (!focusable.length) return;
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
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
    const missing = (provider?.launchFields ?? []).find((field) => {
      if (!field.required) return false;
      const value = field.id === 'model' ? model
        : field.id === 'effort' ? effort
          : field.id === 'permissionMode' ? permissionMode : providerOptions[field.id];
      return value === undefined || value === null || value === '';
    });
    if (missing) { setErr(`${missing.label} is required by this provider profile.`); return; }
    setBusy(true); setErr(null);
    try {
      await onCreate({ providerId, projectId, model, effort, permissionMode, providerOptions, extraArgs, initialPrompt, isolate });
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
      <div className="modal" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="new-session-title"
           onClick={(e) => e.stopPropagation()}>
        <h2 id="new-session-title" style={{ fontSize: 'var(--t-lead)', fontWeight: 600, marginBottom: 14 }}>New session</h2>

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
                  borderColor: on ? (TINT[p.id] ?? 'var(--accent)') : 'var(--line)',
                  background: on ? 'var(--bg-sunk)' : 'var(--bg-soft)',
                }}
                title={p.path ?? `${p.bin} not found on PATH`}
              >
                <span style={{ fontWeight: 600, color: on ? (TINT[p.id] ?? 'var(--accent)') : undefined }}>{p.label}</span>
                <span className="faint mono" style={{ fontSize: 'var(--t-micro)' }}>
                  {p.path ? (p.version ?? 'installed') : 'not installed'}
                </span>
              </FocusBtn>
            );
          })}
        </div>

        {provider?.capabilities && (
          <p className={provider.capabilities.hooks ? 'faint' : 'dim'}
             style={{ margin: '-8px 0 14px', fontSize: 'var(--t-micro)', lineHeight: 1.45 }}>
            {provider.capabilities.hooks
              ? '✓ Timeline, policy, MCP and telemetry are available for this session.'
              : '△ Terminal-only observation for this provider: no injected timeline, policy, MCP or transcript archive yet.'}
            {provider.capabilities.probed ? '' : ' CLI capability probe was unavailable.'}
          </p>
        )}

        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span className="label">Project</span>
          <FocusBtn className="faint" style={{ fontSize: 'var(--t-small)', marginLeft: 'auto', borderRadius: 'var(--r-sm)' }}
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
            <p style={{ color: 'var(--bad)', fontSize: 'var(--t-small)', lineHeight: 1.45 }}>
              <span aria-hidden="true" style={{ fontWeight: 700, marginRight: 6 }}>✕</span>
              Wanigan could not read this project's trust level: {trustErr} The session will still start
              under whatever the main process decides — close this dialog and reopen it to read again.
            </p>
          ) : !trust ? (
            <p className="faint" style={{ fontSize: 'var(--t-small)' }}>Reading the trust level…</p>
          ) : (
            <>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 7 }}>
                <span aria-hidden="true"
                      style={{ color: elevated ? 'var(--warning)' : 'var(--text-dim)', fontWeight: 700 }}>
                  {TRUST_GLYPH[trust]}
                </span>
                <span style={{ fontWeight: 650, fontSize: 'var(--t-small)',
                               color: elevated ? 'var(--warning)' : 'var(--text)' }}>
                  {TRUST_COPY[trust].label}
                </span>
                {trustDefault && (
                  <span className="faint" style={{ fontSize: 'var(--t-micro)', marginLeft: 'auto' }}>
                    {trust === trustDefault
                      ? 'your default'
                      : `default is ${TRUST_COPY[trustDefault].label} ${TRUST_GLYPH[trustDefault]}`}
                  </span>
                )}
              </div>
              <p className="dim" style={{ fontSize: 'var(--t-small)', marginTop: 3, lineHeight: 1.45 }}>
                {TRUST_COPY[trust].detail}
              </p>
              {elevated && (
                <p style={{ color: 'var(--warning)', fontSize: 'var(--t-small)', marginTop: 5, lineHeight: 1.45 }}>
                  <span aria-hidden="true" style={{ fontWeight: 700, marginRight: 5 }}>⚠</span>
                  Above your default. The session header says so for as long as this session runs.
                </p>
              )}
              <p className="faint" style={{ fontSize: 'var(--t-micro)', marginTop: 5, lineHeight: 1.45 }}>
                Trust is set per project and applies to every session in it.
              </p>
            </>
          )}
        </div>

        {provider?.supports.model && <>
          <div className="label">Model <span style={{ textTransform: 'none' }}>— {codexHarness ? 'Auto uses Codex’s current default' : 'blank uses the CLI default'}</span></div>
          {genericHarness && manifestModelField?.kind !== 'select' ? (
            <input className="field mono" style={{ margin: '6px 0 14px' }} value={model}
                   placeholder={manifestModelField?.required ? 'Required by provider' : 'Provider default'}
                   onChange={(e) => setModel(e.target.value)} />
          ) : (
            <div style={{ display: 'flex', gap: 5, margin: '6px 0 14px', flexWrap: 'wrap' }}>
              {!manifestModelField?.required && genericHarness && (
                <FocusBtn className="pill" onClick={() => setModel('')} aria-pressed={model === ''}
                          style={model === '' ? { background: 'var(--accent)', color: 'var(--accent-ink)' } : { background: 'var(--bg-sunk)', color: 'var(--text-dim)' }}>
                  Provider default
                </FocusBtn>
              )}
              {modelChoices.map((choice) => (
                <FocusBtn key={choice.value || 'default'} className="pill" onClick={() => setModel(choice.value)}
                          aria-pressed={model === choice.value}
                          style={model === choice.value ? { background: 'var(--accent)', color: 'var(--accent-ink)' }
                                             : { background: 'var(--bg-sunk)', color: 'var(--text-dim)' }}>
                  <span title={(choice as { description?: string | null }).description ?? undefined}>{choice.label}</span>
                </FocusBtn>
              ))}
            </div>
          )}
        </>}

        {provider?.supports.effort && (
          <>
            <div className="label">Effort <span style={{ textTransform: 'none' }}>— governs thinking depth, tool calls and length</span></div>
            <div style={{ display: 'flex', gap: 5, margin: '6px 0 14px', flexWrap: 'wrap' }}>
              {['', ...effortChoices].map((l) => (
                <FocusBtn key={l || 'default'} className="pill" onClick={() => setEffort(l)}
                          aria-pressed={effort === l}
                          style={effort === l ? { background: 'var(--accent)', color: 'var(--accent-ink)' }
                                              : { background: 'var(--bg-sunk)', color: 'var(--text-dim)' }}>
                  {l || 'default'}
                </FocusBtn>
              ))}
            </div>
          </>
        )}

        {codexHarness && (
          <div className="sunk" style={{ margin: '6px 0 14px', padding: '9px 11px' }}>
            <div className="label" style={{ color: 'var(--codex)', marginBottom: 4 }}>Codex session controls</div>
            <p className="dim" style={{ fontSize: 'var(--t-small)', lineHeight: 1.45 }}>
              Start with a model here if you know it; after launch, Wanigan shows <span className="mono">Model &amp; effort…</span>
              {' '}and <span className="mono">Plan mode</span> directly above the terminal. The first opens Codex’s own
              picker, including its Auto choices and reasoning levels.
            </p>
            <p className="faint" style={{ fontSize: 'var(--t-micro)', marginTop: 5, lineHeight: 1.4 }}>
              Codex uses its own controls — Claude permission and effort fields do not apply to it.
            </p>
          </div>
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
              <p style={{ color: 'var(--warn)', fontSize: 'var(--t-micro)', marginTop: -8, marginBottom: 12, lineHeight: 1.45 }}>
                This session will not ask before running commands or editing files. Only use it in a
                repo you can throw away or fully revert.
              </p>
            )}
          </>
        )}

        {(provider?.launchFields ?? []).filter((field) => !['model', 'effort', 'permissionMode'].includes(field.id)).map((field) => (
          <label key={field.id} className="sunk" style={{ display: 'flex', flexDirection: 'column', gap: 6, margin: '6px 0 14px', padding: '9px 11px' }}>
            <span className="label">{field.label}{field.required ? ' · required' : ''}</span>
            {field.description && <span className="faint" style={{ fontSize: 'var(--t-micro)', lineHeight: 1.4 }}>{field.description}</span>}
            {field.kind === 'boolean' ? (
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input type="checkbox" checked={providerOptions[field.id] === true}
                       onChange={(e) => setProviderOptions((old) => ({ ...old, [field.id]: e.target.checked }))} />
                {providerOptions[field.id] === true ? 'Enabled' : 'Disabled'}
              </span>
            ) : field.kind === 'select' ? (
              <select className="field" value={String(providerOptions[field.id] ?? '')}
                      onChange={(e) => setProviderOptions((old) => ({ ...old, [field.id]: e.target.value }))}>
                {!field.required && <option value="">Provider default</option>}
                {(field.options ?? []).map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
              </select>
            ) : (
              <input className="field mono" type={field.kind === 'secret' ? 'password' : 'text'}
                     value={String(providerOptions[field.id] ?? '')}
                     onChange={(e) => setProviderOptions((old) => ({ ...old, [field.id]: e.target.value }))} />
            )}
          </label>
        ))}

        {/* ── P9 · isolation ───────────────────────────────────────────── */}
        <div className="label">Working tree</div>
        <label className="sunk"
               style={{ display: 'flex', gap: 9, alignItems: 'flex-start', margin: '6px 0 14px',
                        padding: '9px 11px', cursor: isRepo ? 'pointer' : 'not-allowed' }}>
          <input type="checkbox" checked={isolate} disabled={!isRepo}
                 onChange={(e) => setIsolate(e.target.checked)}
                 style={{ marginTop: 2, accentColor: 'var(--accent)', width: 14, height: 14, flex: 'none' }} />
          <span style={{ minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: 'var(--t-small)', fontWeight: 600 }}>
              <span aria-hidden="true" style={{ color: 'var(--accent)', marginRight: 6 }}>⑂</span>
              Isolate in a worktree
            </span>
            {isRepo ? (
              <span className="dim" style={{ display: 'block', fontSize: 'var(--t-small)', marginTop: 3, lineHeight: 1.45 }}>
                Cuts a branch and a private checkout for this session, so two agents in {project?.name} stop
                overwriting each other's files. Merge or discard it from the session header when the work
                is done; a worktree with nothing uncommitted is cleaned up on exit.
              </span>
            ) : (
              <span className="faint" style={{ display: 'block', fontSize: 'var(--t-small)', marginTop: 3, lineHeight: 1.45 }}>
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
          <summary className="faint" style={{ cursor: 'pointer', fontSize: 'var(--t-small)' }}>Extra CLI flags</summary>
          <input className="field mono" style={{ marginTop: 6 }}
                 placeholder="--resume    --permission-mode plan"
                 value={extraArgs} onChange={(e) => setExtraArgs(e.target.value)} />
        </details>

        {err && (
          <div style={{ background: 'var(--bad-soft)', color: 'var(--bad)', border: '1px solid var(--bad)',
                        borderRadius: 'var(--r-sm)', padding: '7px 10px', margin: '10px 0', fontSize: 'var(--t-small)', lineHeight: 1.45 }}>
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
        <p className="faint" style={{ fontSize: 'var(--t-micro)', marginTop: 8, textAlign: 'right' }}>⌘↵ to start</p>
      </div>
    </div>
  );
}
