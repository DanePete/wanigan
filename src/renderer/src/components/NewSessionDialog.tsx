import { useEffect, useMemo, useRef, useState } from 'react';
import type { AccountResolution, AgentAccount, LaunchModelCatalogue, LaunchOptions, Project, ProviderId, ProviderInfo, Session, TrustLevel } from '@shared/types';
import { TRUST_LEVELS, permissionModeCopy, trustCopy, trustGlyph } from '@shared/types';
import { intersectChoices, launchFieldChoices, type LaunchChoice } from '@shared/launch-fields';
import { providerTint } from '@shared/provider-status';
import { Hint, Note } from './bits';
import { useDialog } from './useDialog';

/** Same filled progression the session header uses: ◇ → ◈ → ◆ reads in greyscale. */

/**
 * What Wanigan is missing, grouped by the command it actually runs.
 *
 * Two profiles can need the same executable — GLM and DeepSeek are the Claude
 * Code binary pointed at another endpoint — so the answer to "what do I have to
 * install" is a list of commands, not a list of profiles. Built from whatever
 * profiles are loaded: hardcoding claude and codex here was already wrong the
 * day the DeepSeek and GLM profiles shipped, and a provider pack can add more.
 */
function missingCommands(providers: ProviderInfo[]): { bin: string; labels: string[] }[] {
  const byBin = new Map<string, string[]>();
  for (const p of providers) {
    if (p.path) continue;
    const bin = p.bin?.trim() || p.id;
    byBin.set(bin, [...(byBin.get(bin) ?? []), p.label]);
  }
  return [...byBin.entries()].map(([bin, labels]) => ({ bin, labels }));
}

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

/**
 * A launch field the profile leaves open: free text, with whatever it did name
 * offered as suggestions rather than as the whole set.
 *
 * A manifest select that sets `allowCustom` is saying its list is a starting
 * point, not a contract — the launch compiler only rejects an unlisted value
 * when `allowCustom` is false. Rendering it as a closed picker made the pack's
 * own escape hatch unreachable. A native datalist keeps the suggestions
 * without adding a second control to tab through.
 */
function OpenField({ id, label, value, choices, placeholder, onChange }: {
  id: string;
  /** The field's own name. `id` above names the datalist, not the input, so
   *  without this the control reached a screen reader as an unlabelled box. */
  label: string;
  value: string;
  choices: LaunchChoice[];
  placeholder?: string;
  onChange: (next: string) => void;
}) {
  return (
    <>
      <input className="field mono" aria-label={label} style={{ margin: '6px 0 14px' }} value={value} placeholder={placeholder}
             list={choices.length ? id : undefined} onChange={(e) => onChange(e.target.value)} />
      {choices.length > 0 && (
        <datalist id={id}>
          {choices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
        </datalist>
      )}
    </>
  );
}

export default function NewSessionDialog({
  providers, projects, defaultProjectId, liveSessions, onClose, onCreate, onAddProject,
}: {
  providers: ProviderInfo[];
  projects: Project[];
  defaultProjectId?: string;
  /** The session list as Sessions.tsx holds it, so this dialog can say what is already open. */
  liveSessions: Session[];
  onClose: () => void;
  onCreate: (opts: LaunchOptions) => Promise<void>;
  onAddProject: () => Promise<void>;
}) {
  /*
   * The dialog re-resolves providers itself when you ask it to, because the
   * moment you fix a missing CLI is the moment you are standing here. The
   * override is dropped as soon as the shell hands down a fresher list.
   */
  const [rechecked, setRechecked] = useState<ProviderInfo[] | null>(null);
  useEffect(() => { setRechecked(null); }, [providers]);
  const list = rechecked ?? providers;

  const installed = useMemo(() => list.filter((p) => p.path), [list]);
  /*
   * Nothing installed means nothing selected. This used to fall back to
   * 'claude', so on a machine that had never installed it the dialog opened
   * with a disabled provider chosen and Start session live — and the launch
   * failed with the main process's "disabled, changed, or no longer installed.
   * Refresh providers and try again", which is wrong three times over for a
   * first run and names a control this app does not have.
   */
  const [providerId, setProviderId] = useState<ProviderId>(installed[0]?.id ?? '');
  // Detection is asynchronous, so a provider can finish resolving after this
  // dialog opened; adopt it rather than making the person reopen.
  useEffect(() => {
    setProviderId((current) => (installed.some((p) => p.id === current) ? current : installed[0]?.id ?? ''));
  }, [installed]);
  const provider = list.find((p) => p.id === providerId);
  const missing = useMemo(() => missingCommands(list), [list]);

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
  const [browseErr, setBrowseErr] = useState<string | null>(null);
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [permissionMode, setPermissionMode] = useState('');
  const [extraArgs, setExtraArgs] = useState('');
  const [initialPrompt, setInitialPrompt] = useState('');
  const [providerOptions, setProviderOptions] = useState<Record<string, string | boolean>>({});
  const [isolate, setIsolate] = useState(false);
  // null means "whatever this project resolves to" rather than a chosen account,
  // so the row keeps following the project default until you actually override.
  const [accountId, setAccountId] = useState<string | null>(null);
  const [accountList, setAccountList] = useState<AgentAccount[]>([]);
  const [accountRes, setAccountRes] = useState<AccountResolution | null>(null);
  /*
   * What this launch would use if nothing were chosen here, resolved on its own.
   * `accountRes` follows the CURRENT selection, so the moment you pick an
   * account its source is 'explicit' — and the follow option was reading that
   * resolution back out and calling your deliberate choice "the default", for an
   * account that may not be the default at all. Which account a project is
   * pinned to is a main-process fact, so the honest answer costs a second ask.
   */
  const [followRes, setFollowRes] = useState<AccountResolution | null>(null);
  const [trust, setTrust] = useState<TrustLevel | null>(null);
  const [trustDefault, setTrustDefault] = useState<TrustLevel | null>(null);
  const [trustErr, setTrustErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /*
   * What the selected profile can actually launch, read once from main.
   *
   * This dialog used to hold four hardcoded model tables — Codex, GLM, DeepSeek
   * and Claude — chosen by branching on harness and profile ids, which is the
   * shape CLAUDE.md forbids and one a provider pack could never join. Two of
   * those backends already had live fetchers in main that nothing here called.
   * `null` is "not read yet", which is a different thing from an empty list,
   * and the two states say different words below.
   */
  const [catalogue, setCatalogue] = useState<LaunchModelCatalogue | null>(null);
  const [catalogueErr, setCatalogueErr] = useState<string | null>(null);

  const options = useMemo(() => {
    const seen = new Set(projects.map((p) => p.id));
    return [...projects, ...picked.filter((p) => !seen.has(p.id))];
  }, [projects, picked]);

  async function browseForFolder() {
    setBrowsing(true);
    setBrowseErr(null);
    try {
      const p = await window.wanigan.projects.pick();
      if (p) { setPicked((x) => [...x, p]); setProjectId(p.id); }
    } catch (e) {
      /*
       * Cancelling resolves with null; anything that throws is a real failure —
       * the project could not be written, the folder is unreadable, the
       * database is in recovery. Swallowing all of it meant picking a folder
       * did nothing at all, silently, forever. App.tsx's addProject reports
       * the same way.
       */
      setBrowseErr(e instanceof Error ? e.message : String(e));
    }
    finally { setBrowsing(false); }
  }

  const project = options.find((p) => p.id === projectId) ?? null;
  const isRepo = !!project?.branch;

  /*
   * Which live sessions are already sitting in the checkout this launch would
   * enter — and only that, because only that is observed.
   *
   * The comparison is checkout to checkout, not project to project. A session's
   * working directory is its worktree when it has one and its project path when
   * it does not, so an isolated session on this very project is correctly not
   * counted (it has its own checkout, which is the whole point of the control
   * below), and a session filed under another project whose worktree happens to
   * be this folder correctly is. The launch being configured lands in
   * `project.path` unless `isolate` is ticked, which is why that flag hides the
   * warning rather than the warning blocking the launch.
   *
   * It compares recorded path strings, not filesystem identity: a symlinked
   * alias or a differently-cased volume path gives two strings for one
   * directory and this misses it. Equal strings always name the same directory,
   * so the error runs one way — it can under-report, it cannot invent.
   *
   * The docket claim system was checked and is not a better answer here.
   * `work_claims` rows are written only through control.ts's claimPath(), whose
   * two callers (startNode and claimForSession) both require a docket node, and
   * startNode launches every node with `isolate: true` — so a claim can never
   * describe a session running in the project's own checkout. A claim is also a
   * declared relative path, not an observed write, and no preload API lists the
   * live ones. What is stated below is therefore the session fact, and it is
   * described as a session fact.
   */
  const sharing = useMemo(() => {
    const root = project?.path;
    if (!root) return [];
    return liveSessions.filter((s) => s.status !== 'exited' && (s.worktree ?? s.projectPath) === root);
  }, [liveSessions, project]);
  // Do not offer Claude aliases to a Codex process.  Empty deliberately means
  /**
   * Which account this launch will use, asked of the main process rather than
   * worked out here. Whether an account applies at all depends on the profile's
   * resolved environment — a GLM profile runs the Claude harness but
   * authenticates elsewhere — and that is not a fact the renderer holds.
   */
  useEffect(() => {
    let live = true;
    if (!providerId) { setAccountList([]); setAccountRes(null); setFollowRes(null); return; }
    void (async () => {
      try {
        const [rows, resolution, follow] = await Promise.all([
          window.wanigan.accounts.listForProvider(providerId),
          window.wanigan.accounts.resolveForLaunch(providerId, projectId || null, accountId),
          // With nothing chosen the two questions have the same answer, so only
          // an explicit choice pays for the extra round trip.
          accountId ? window.wanigan.accounts.resolveForLaunch(providerId, projectId || null, null) : null,
        ]);
        if (!live) return;
        setAccountList(rows);
        setAccountRes(resolution);
        setFollowRes(follow ?? resolution);
      } catch {
        // A removed account or an uninstalled provider: show no picker rather
        // than a stale one naming a login this launch would not use.
        if (live) { setAccountList([]); setAccountRes(null); setFollowRes(null); }
      }
    })();
    return () => { live = false; };
  }, [providerId, projectId, accountId]);

  // A saved override cannot survive a provider change: the account belongs to a
  // harness, and carrying it across would submit an id the launch must refuse.
  useEffect(() => { setAccountId(null); }, [providerId]);

  // Only the Codex explainer below reads this now; the model and effort
  // pickers route by what the profile declares and what its backend reports,
  // never by a harness or profile id.
  const codexHarness = provider?.harnessId === 'codex' || providerId === 'codex';
  const modelField = launchFieldChoices(provider, 'model');
  const effortField = launchFieldChoices(provider, 'effort');
  const permissionField = launchFieldChoices(provider, 'permissionMode');
  /*
   * main already intersected the profile's declaration with its backend's
   * catalogue, so these rows are the whole offer and this component adds no
   * list of its own. A closed declared set arrives already narrowed; an open
   * one arrives as whatever the backend reported.
   */
  const modelChoices: LaunchChoice[] = (catalogue?.rows ?? [])
    .map((row) => ({ value: row.value, label: row.label, description: row.description }));
  /*
   * Free text only where there is nothing to offer and the profile accepts a
   * value it never listed. Where rows exist they are what Wanigan can vouch
   * for, and typing past them would be a promise nobody made.
   */
  const modelOpen = modelField.custom && modelChoices.length === 0;
  /*
   * A free-text control appears only where the profile's own declaration is
   * the whole story: it declared a list and opened it with `allowCustom`, or
   * it named nothing and Wanigan has no list to stand in with. Where the
   * choices below are Wanigan's fallback, the picker is what Wanigan can
   * actually vouch for and typing past it would be a promise nobody made.
   */
  const openField = (field: typeof modelField) =>
    field.custom && (field.declared || field.choices.length === 0);

  /*
   * A provider switch re-seeds these three from the new profile's own declared
   * defaults. They used to be carried across untouched — the model alias was
   * dropped only when the new list did not contain it, effort only for Codex,
   * and the permission mode never at all, so a Claude `plan` followed you onto
   * a profile that had never heard of it. `defaultValue` is a manifest field
   * the Headless page already honours and this dialog ignored.
   */
  useEffect(() => {
    setModel(modelField.defaultValue);
    setEffort(effortField.defaultValue);
    setPermissionMode(permissionField.defaultValue);
  // Derived wholly from the selected profile. The three field objects are
  // rebuilt on every render, so naming them here would restart this each time.
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

  /*
   * One read per selected profile, for every backend rather than only Codex.
   * Nothing else on this form waits on it: effort, permission mode and Start
   * render immediately, because the Codex catalogue is read through a CLI probe
   * that main allows twelve seconds to answer. Both pieces of state reset
   * first, so switching profiles never shows the previous profile's models.
   */
  useEffect(() => {
    setCatalogue(null);
    setCatalogueErr(null);
    if (!providerId) return;
    let live = true;
    window.wanigan.providers.modelCatalogue(providerId)
      .then((next) => { if (live) setCatalogue(next); })
      .catch((e) => { if (live) setCatalogueErr(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [providerId]);

  /*
   * Two claims about one launch, so the offer is where they agree: the profile
   * says which efforts it will compile, and the backend's catalogue says which
   * ones the chosen model accepts. Reading only the catalogue is how 'ultra'
   * reached this picker for a profile that declares low…max, and the launch it
   * armed died in the compiler with "unsupported value". The intersection now
   * runs for every profile whose catalogue reports a per-model range, not only
   * for Codex — it can only ever narrow the declared contract, never widen it.
   */
  const effortChoices = useMemo(
    () => intersectChoices(
      launchFieldChoices(provider, 'effort').choices,
      catalogue?.rows.find((row) => row.value === model)?.efforts ?? null,
    ),
    [provider, catalogue, model],
  );

  // An effort the current offer no longer contains cannot be launched, so it is
  // dropped rather than sent: moving Codex to a model with a narrower reasoning
  // range used to leave the wider level selected and armed.
  useEffect(() => {
    setEffort((current) => (!current || effortChoices.some((choice) => choice.value === current) ? current : ''));
  }, [effortChoices]);

  // ⌘↵ submits from anywhere in the form. Everything else this listener used to
  // do — Escape, the Tab trap, restoring focus to the opener — is useDialog's,
  // so only the one binding this dialog actually adds is left.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
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

  /*
   * The one sentence standing between here and a running session, or null. It
   * gates the button AND is rendered next to it: a disabled primary action with
   * its only explanation in a `title` is a dead end for anyone not holding a
   * mouse, which is how a first run reached a raw ENOENT instead of "install
   * the CLI first".
   */
  const blocker = list.length === 0
    ? 'Wanigan has not loaded any agent profiles yet, so there is nothing to launch.'
    : !provider?.path
      ? (installed.length === 0
        ? 'No agent CLI is installed yet. Wanigan starts a session by running one of the commands above.'
        : 'Choose an installed agent above.')
      : !projectId
        ? 'Choose the folder this session works in.'
        : null;

  async function go() {
    if (blocker || busy) return;
    const missingField = (provider?.launchFields ?? []).find((field) => {
      if (!field.required) return false;
      const value = field.id === 'model' ? model
        : field.id === 'effort' ? effort
          : field.id === 'permissionMode' ? permissionMode : providerOptions[field.id];
      return value === undefined || value === null || value === '';
    });
    if (missingField) { setErr(`${missingField.label} is required by this provider profile.`); return; }
    setBusy(true); setErr(null);
    try {
      await onCreate({ providerId, projectId, model, effort, permissionMode, providerOptions, extraArgs, initialPrompt, isolate, accountId });
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  const elevated = !!trust && !!trustDefault
    && TRUST_LEVELS.indexOf(trust) > TRUST_LEVELS.indexOf(trustDefault);

  const { portal, backdropProps, dialogProps } = useDialog<HTMLDivElement>({ onClose, initialFocus: 'first' });

  // onClick on the backdrop discarded the whole form when a text-selection drag
  // that started inside the dialog happened to release outside it: the click
  // event fires on the common ancestor, which is the backdrop. useDialog closes
  // on mousedown for exactly that reason, and owns Escape, the Tab trap and
  // handing focus back to the control that opened this.
  return portal(
    <div {...backdropProps}>
      <div {...dialogProps} className="modal" aria-labelledby="new-session-title">
        <h2 id="new-session-title" style={{ fontSize: 'var(--t-lead)', fontWeight: 600, marginBottom: 14 }}>New session</h2>

        <div className="label">Agent</div>
        <div style={{ display: 'flex', gap: 8, margin: '6px 0 14px' }}>
          {list.map((p) => {
            const on = providerId === p.id;
            return (
              <FocusBtn
                key={p.id}
                disabled={!p.path}
                onClick={() => setProviderId(p.id)}
                className="btn"
                style={{
                  flex: 1, flexDirection: 'column', alignItems: 'flex-start', gap: 2, padding: '9px 11px',
                  borderColor: on ? providerTint(p.id) : 'var(--line)',
                  background: on ? 'var(--bg-sunk)' : 'var(--bg-soft)',
                }}
                title={p.path ?? `${p.bin} was not found on the PATH Wanigan resolved`}
              >
                <span style={{ fontWeight: 600, color: on ? providerTint(p.id) : undefined }}>{p.label}</span>
                {/* The reason a button is disabled is on the button, not in a
                    title: a tooltip is unreachable by keyboard and touch, and
                    this is the sentence a first run turns on. */}
                <span className="faint mono" style={{ fontSize: 'var(--t-micro)' }}>
                  {p.path ? (p.version ?? 'installed') : `no ${p.bin} command`}
                </span>
              </FocusBtn>
            );
          })}
        </div>

        {missing.length > 0 && (
          <InstallGuidance missing={missing} anyInstalled={installed.length > 0}
                           onProviders={setRechecked} />
        )}

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
            <select className="field" aria-label="Project" style={{ flex: 1, minWidth: 0 }}
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

        {browseErr && (
          <div role="alert" style={{ background: 'var(--bad-soft)', color: 'var(--bad)', border: '1px solid var(--bad)',
                        borderRadius: 'var(--r-sm)', padding: '7px 10px', margin: '-8px 0 14px',
                        fontSize: 'var(--t-small)', lineHeight: 1.45 }}>
            <span aria-hidden="true" style={{ fontWeight: 700, marginRight: 6 }}>✕</span>
            <span style={{ fontWeight: 650 }}>That folder was not added. </span>{browseErr}
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
                  {trustGlyph(trust)}
                </span>
                <span style={{ fontWeight: 650, fontSize: 'var(--t-small)',
                               color: elevated ? 'var(--warning)' : 'var(--text)' }}>
                  {trustCopy(trust).label}
                </span>
                {trustDefault && (
                  <span className="faint" style={{ fontSize: 'var(--t-micro)', marginLeft: 'auto' }}>
                    {trust === trustDefault
                      ? 'your default'
                      : `default is ${trustCopy(trustDefault).label} ${trustGlyph(trustDefault)}`}
                  </span>
                )}
              </div>
              <p className="dim" style={{ fontSize: 'var(--t-small)', marginTop: 3, lineHeight: 1.45 }}>
                {trustCopy(trust).detail}
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

        {modelField.supported && <>
          <div className="label">{modelField.label} <span style={{ textTransform: 'none' }}>— blank leaves the model to the CLI</span></div>
          {/* "Not read yet" and "read, and there is nothing" are different
              facts, and only the second one may be stated as an absence. */}
          {catalogue === null && catalogueErr === null && (
            <p className="faint">Reading what {provider?.label ?? 'this profile'} offers…</p>
          )}
          {catalogueErr !== null && (
            <Note tone="warn">Wanigan could not read what models this profile offers, so type one or leave it blank for the CLI’s own default.</Note>
          )}
          {modelOpen ? (
            <OpenField id="new-session-model" label={modelField.label} value={model} choices={modelChoices}
                       placeholder={modelField.required ? 'Required by provider' : 'Provider default'}
                       onChange={setModel} />
          ) : (
            <div style={{ display: 'flex', gap: 5, margin: '6px 0 14px', flexWrap: 'wrap' }}>
              {/* A declared list that never names the empty value has no way
                  back to the CLI default; the built-in profiles carry one of
                  their own, so this appears only for a pack that does not. */}
              {!modelField.required && !modelChoices.some((choice) => choice.value === '') && (
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
                  <span title={choice.description ?? undefined}>{choice.label}</span>
                </FocusBtn>
              ))}
            </div>
          )}
          {/* Both live fetchers answer with Wanigan's local list and a note
              when the service cannot be reached. The note is the difference
              between a catalogue and a guess, so it is shown, not dropped. */}
          {catalogue?.note && <p className="faint">{catalogue.note}</p>}
        </>}

        {effortField.supported && (
          <>
            <div className="label">{effortField.label} <span style={{ textTransform: 'none' }}>— governs thinking depth, tool calls and length</span></div>
            {openField(effortField) ? (
              <OpenField id="new-session-effort" label={effortField.label} value={effort} choices={effortChoices}
                         placeholder={effortField.required ? 'Required by provider' : 'Provider default'}
                         onChange={setEffort} />
            ) : (
              <div style={{ display: 'flex', gap: 5, margin: '6px 0 14px', flexWrap: 'wrap' }}>
                {/*
                  * A profile may declare this field required, and for that one
                  * "default" is not a value at all: the launch compiler throws
                  * "… is required." on an empty string. Offering the row anyway
                  * is the same defect as offering a reasoning level the profile
                  * never declared — a control whose value the profile has no
                  * way to accept, which go() then refuses before the launch.
                  * The model picker above guards its own default row for
                  * exactly this reason.
                  */}
                {[
                  ...(effortField.required ? [] : [{ value: '', label: 'default' }]),
                  ...effortChoices.filter((choice) => choice.value !== ''),
                ].map((choice) => (
                  <FocusBtn key={choice.value || 'default'} className="pill" onClick={() => setEffort(choice.value)}
                            aria-pressed={effort === choice.value}
                            style={effort === choice.value ? { background: 'var(--accent)', color: 'var(--accent-ink)' }
                                                : { background: 'var(--bg-sunk)', color: 'var(--text-dim)' }}>
                    {choice.label}
                  </FocusBtn>
                ))}
              </div>
            )}
            {/*
              * Symmetry with the permission block below, and for the same
              * reason: with the default row gone there is nothing selected and
              * nothing on screen saying why. A fact about this form, not a
              * claim about the profile.
              */}
            {effortField.required && effort === '' && (
              <Hint>This profile requires an effort level, and nothing is chosen yet.</Hint>
            )}
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
            {/*
              * This line used to read "Claude permission and effort fields do
              * not apply to it", which stopped being true the day the effort
              * picker started reading the profile: the shipped Codex profile
              * declares an effort field, so that picker renders directly above
              * this box and the reader has just used it.
              *
              * Each clause reads both facts its own picker renders from —
              * whether the profile takes the field at all, and whether what the
              * control offers is the profile's declaration or Wanigan's
              * fallback list. Those are different facts: `supports.effort` can
              * be true for a field that names no levels, and the pills above
              * are then Wanigan's fallback set, so a clause gated on support
              * alone told a pack profile its own declaration was on screen
              * when it was not.
              *
              * Neither clause says the value reaches Codex. `argv` is optional
              * on a launch field and fieldArgs compiles `(field.argv ?? [])`,
              * and the renderer is never handed it — launchFieldsFor() in
              * providers.ts projects no argv — so delivery is not a fact this
              * surface holds. Provenance is, and provenance is what it states.
              *
              * Both sentences also stand alone. "So is the permission mode
              * below." rendered as an orphan for a codex-harness profile that
              * declares a permission mode and no effort field: the clause it
              * pointed back to was never on screen.
              */}
            <p className="faint" style={{ fontSize: 'var(--t-micro)', marginTop: 5, lineHeight: 1.4 }}>
              {effortField.supported && (effortField.declared
                ? 'The effort control above comes from this profile’s own declaration. '
                : 'This profile takes an effort level but declares no levels of its own, so the control above comes from Wanigan’s fallback list rather than from this profile. ')}
              {permissionField.supported
                ? (permissionField.declared
                  ? 'The permission mode below comes from this profile’s own declaration.'
                  : 'This profile takes a permission mode but declares no modes of its own, so the list below comes from Wanigan’s fallback set of Claude modes.')
                : 'A permission mode is a Claude flag, and this profile declares none, so Wanigan offers no picker for one.'}
            </p>
          </div>
        )}

        {permissionField.supported && (
          <>
            <div className="label">{permissionField.label}</div>
            {openField(permissionField) ? (
              <OpenField id="new-session-permission-mode" label={permissionField.label} value={permissionMode} choices={permissionField.choices}
                         placeholder={permissionField.required ? 'Required by provider' : 'Provider default'}
                         onChange={setPermissionMode} />
            ) : (
              <select className="field" aria-label={permissionField.label} style={{ margin: '6px 0 5px' }} value={permissionMode}
                      onChange={(e) => setPermissionMode(e.target.value)}>
                {/*
                  * The guard the effort pills above already keep, one field
                  * over: a profile that declares this field required has no
                  * default to fall back on, so "default" is not a row it may
                  * offer — choosing it only earns a refusal. This dialog gives
                  * that refusal itself, before anything is launched: go() walks
                  * the profile's required launch fields and stops on the first
                  * one still empty, naming it. fieldArgs would refuse it too,
                  * but nothing from this surface reaches it. The row becomes a
                  * disabled placeholder rather than disappearing, because a
                  * select holding a value no row matches has nothing to draw
                  * and renders blank; the Hint below says what the placeholder
                  * means: nothing chosen yet.
                  */}
                {permissionField.required
                  ? <option value="" disabled>Required by provider</option>
                  : <option value="">default</option>}
                {permissionField.choices.filter((choice) => choice.value !== '').map((choice) => {
                  /*
                   * The words belong to the mode, not to whichever profile
                   * declared it. Every built-in profile builds these choices as
                   * `[...].map((value) => ({ value, label: value }))`, so what
                   * arrives here is the raw identifier — and an identifier is
                   * not a word for the one control that decides how much an
                   * agent may do without asking.
                   *
                   * Relabelled here rather than in the manifest on purpose:
                   * fingerprint() hashes the whole profile object, so editing
                   * those labels would change every built-in profile's
                   * profileFingerprint and make a fan-out queued before the
                   * update fail with "… changed after this fan-out was
                   * queued". Nothing about the launch changes; only the word.
                   *
                   * A mode this build has never seen keeps whatever the profile
                   * called it. Prettifying `foo_bar` into "Foo bar" would be
                   * inventing a meaning for a permission.
                   */
                  const copy = permissionModeCopy(choice.value);
                  return (
                    <option key={choice.value} value={choice.value}>
                      {copy.known ? copy.label : choice.label}
                    </option>
                  );
                })}
              </select>
            )}
            {/*
              * What the mode permits, said before it is chosen rather than
              * discovered afterwards — the same shape the Trust block above
              * uses. The blank option is not a mode: permissionModeCopy('')
              * correctly reports one it does not recognise, and printing that
              * over 'default' would accuse the CLI's own default of being
              * something Wanigan cannot describe.
              */}
            <Hint>
              {permissionMode !== ''
                ? permissionModeCopy(permissionMode).detail
                : permissionField.required
                  // A profile may declare this field required with no default,
                  // and for that one the blank row is not a default at all —
                  // the launch compiler refuses it. Saying "the CLI's own
                  // default applies" there would be the false half of the same
                  // sentence.
                  ? 'This profile requires a permission mode, and nothing is chosen yet.'
                  : 'Wanigan passes no permission flag, so the CLI’s own default applies.'}
            </Hint>
            {(permissionMode === 'bypassPermissions' || permissionMode === 'dontAsk') && (
              <p style={{ color: 'var(--warn)', fontSize: 'var(--t-micro)', marginTop: 5, marginBottom: 12, lineHeight: 1.45 }}>
                <span aria-hidden="true">⚠ </span>
                {/* One sentence for two modes said the same strong thing about
                    both. It is only established for one of them: headless.ts
                    reaches for bypassPermissions where nothing is denied, and
                    nothing in this repository establishes what dontAsk still
                    holds back. So the mode Wanigan can vouch for keeps the
                    strong sentence, and the one it cannot says exactly that. */}
                {permissionMode === 'bypassPermissions'
                  ? 'This session will not ask before running commands or editing files. Only use it in a '
                    + 'repo you can throw away or fully revert.'
                  : 'Wanigan has not verified what this mode still asks about, so treat it as unrestricted: '
                    + 'only use it in a repo you can throw away or fully revert.'}
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
            ) : field.kind === 'select' && !field.allowCustom ? (
              <select className="field" value={String(providerOptions[field.id] ?? '')}
                      onChange={(e) => setProviderOptions((old) => ({ ...old, [field.id]: e.target.value }))}>
                {/* Same shape as the permission select above, for the same
                    reason: a required field has no default to offer, and a
                    select holding a value no row matches renders blank rather
                    than showing what it holds. The placeholder is disabled, so
                    it names the empty state without being choosable. */}
                {field.required
                  ? <option value="" disabled>Required by provider</option>
                  : <option value="">Provider default</option>}
                {(field.options ?? []).map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
              </select>
            ) : (
              // A select the manifest opened is a suggestion list, not a set;
              // its options stay reachable through the datalist.
              <>
                <input className="field mono" type={field.kind === 'secret' ? 'password' : 'text'}
                       list={field.options?.length ? `new-session-field-${field.id}` : undefined}
                       value={String(providerOptions[field.id] ?? '')}
                       onChange={(e) => setProviderOptions((old) => ({ ...old, [field.id]: e.target.value }))} />
                {!!field.options?.length && (
                  <datalist id={`new-session-field-${field.id}`}>
                    {field.options.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
                  </datalist>
                )}
              </>
            )}
          </label>
        ))}

        {/* ── P32 · which account ──────────────────────────────────────── */}
        {accountList.length > 0 && (
          <>
            <div className="label">Account</div>
            <select className="field" aria-label="Account" value={accountId ?? ''}
                    onChange={(e) => setAccountId(e.target.value || null)}
                    style={{ marginBottom: 6 }}>
              {/* This option is the absence of a choice, so it describes the
                  fallback and never the row above it: naming whatever the
                  project or the app default currently resolves to, so choosing
                  an account tells you what you are leaving behind. */}
              <option value="">
                {followRes?.account
                  ? `Follow ${followRes.source === 'project' ? 'this project' : 'your default'} — ${followRes.account.label}`
                  : 'Follow this project or your default'}
              </option>
              {accountList.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.label}{row.isDefault ? ' · default' : ''}{row.present ? '' : ' · directory missing'}
                </option>
              ))}
            </select>
            <div className="dim" style={{ fontSize: 'var(--t-small)', lineHeight: 1.45, margin: '0 0 6px' }}>
              {accountRes?.account
                ? <>Signs in as <strong>{accountRes.account.label}</strong>
                    {accountRes.source === 'explicit' ? ' — chosen for this session only.'
                      : accountRes.source === 'project' ? ` — ${project?.name ?? 'this project'} is set to it.`
                        : ' — your default account.'}
                    {accountRes.account.signedIn === 'unknown' && (
                      <> Wanigan cannot see whether this directory is signed in — on macOS the credential is in the
                        Keychain. If the session asks, run <code>/login</code> once.</>
                    )}
                  </>
                : accountRes?.reason}
            </div>
            {accountRes?.override && (
              <div className="sunk" style={{ padding: '8px 10px', margin: '0 0 14px', fontSize: 'var(--t-small)', lineHeight: 1.45 }}>
                <strong>{accountRes.override}</strong> is set in Wanigan's environment. The agent ranks it above a
                stored login, so this session authenticates with that credential and the account above is not
                what it uses. Unset it to launch as {accountRes.account?.label ?? 'the chosen account'}.
              </div>
            )}
          </>
        )}

        {/* ── P9 · isolation ───────────────────────────────────────────── */}
        {/* Sits above the control it is the reason for, and disappears the moment
            isolation is ticked — the hazard is gone, so the warning is. It never
            touches `blocker` or `go()`: the operator may well have a reason, and a
            state Wanigan can show is worth more than a click it refuses. */}
        {sharing.length > 0 && !isolate && (
          <Note tone="warn">
            <span aria-hidden="true">⚠ </span>
            <strong>
              {sharing.length === 1 ? 'One session is' : `${sharing.length} sessions are`} already open on
              the same checkout
            </strong>
            {' — '}
            {sharing.map((s) => s.displayTitle || s.title).join(', ')}. Wanigan can see that they are running
            in {project?.name ?? 'this folder'}; it does not watch what they write, so it cannot say whether
            they are editing anything right now. Started as configured, this session runs in that same
            directory rather than one of its own.
            {isRepo
              ? ' Tick “Isolate in a worktree” below to give it a private checkout instead.'
              : ' This folder is not a git repository, so there is no worktree to cut.'}
          </Note>
        )}
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
        <textarea className="field mono" aria-label="First message" rows={3} style={{ margin: '6px 0 4px', resize: 'vertical' }}
                  placeholder="Typed into the session once it is up."
                  value={initialPrompt} onChange={(e) => setInitialPrompt(e.target.value)} />

        <details style={{ margin: '10px 0 4px' }}>
          <summary className="faint" style={{ cursor: 'pointer', fontSize: 'var(--t-small)' }}>Extra CLI flags</summary>
          <input className="field mono" aria-label="Extra CLI flags" style={{ marginTop: 6 }}
                 placeholder="--resume    --permission-mode plan"
                 value={extraArgs} onChange={(e) => setExtraArgs(e.target.value)} />
        </details>

        {err && (
          // role="alert" because this text appears where nothing was, after a
          // button press that a screen reader otherwise reports as silence.
          <div role="alert" style={{ background: 'var(--bad-soft)', color: 'var(--bad)', border: '1px solid var(--bad)',
                        borderRadius: 'var(--r-sm)', padding: '7px 10px', margin: '10px 0', fontSize: 'var(--t-small)', lineHeight: 1.45 }}>
            <span aria-hidden="true" style={{ fontWeight: 700, marginRight: 6 }}>✕</span>
            <span style={{ fontWeight: 650 }}>The session did not start. </span>{err}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 16, alignItems: 'center' }}>
          {blocker && (
            <p id="new-session-blocked" className="dim"
               style={{ fontSize: 'var(--t-small)', lineHeight: 1.45, minWidth: 0 }}>
              {blocker}
            </p>
          )}
          <FocusBtn className="btn" onClick={onClose} style={{ marginLeft: 'auto' }}>Cancel</FocusBtn>
          <FocusBtn className="btn btn-primary" onClick={go} disabled={!!blocker || busy}
                    aria-describedby={blocker ? 'new-session-blocked' : undefined}>
            {busy ? 'Starting…' : isolate ? 'Start in a worktree' : 'Start session'}
          </FocusBtn>
        </div>
        <p className="faint" style={{ fontSize: 'var(--t-micro)', marginTop: 8, textAlign: 'right' }}>⌘↵ to start</p>
      </div>
    </div>,
  );
}

/**
 * The one hard dependency, said out loud.
 *
 * Wanigan does not ship, bundle or install an agent CLI, and it will not
 * pretend to know how yours is packaged — a provider pack can name any
 * installed command. So this states exactly what is missing, exactly what
 * Wanigan does about it, and the one command you can run yourself to check.
 * Anything more specific would be a guess dressed as an instruction.
 */
function InstallGuidance({ missing, anyInstalled, onProviders }: {
  missing: { bin: string; labels: string[] }[];
  anyInstalled: boolean;
  onProviders: (providers: ProviderInfo[]) => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function recheck() {
    setBusy(true);
    setError(null);
    try {
      onProviders(await window.wanigan.providers.list());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  const copy = (bin: string) => {
    navigator.clipboard.writeText(`command -v ${bin}`)
      .then(() => {
        setCopied(bin);
        window.setTimeout(() => setCopied((c) => (c === bin ? null : c)), 2500);
      })
      .catch(() => { /* clipboard can be denied; the command is on screen to type */ });
  };

  // With something already installed this is a footnote, not the first thing
  // you read: you can start a session, just not with these.
  if (anyInstalled) {
    return (
      <details style={{ margin: '-8px 0 14px' }}>
        <summary className="faint" style={{ cursor: 'pointer', fontSize: 'var(--t-small)' }}>
          {missing.length === 1
            ? `1 agent is unavailable: no ${missing[0].bin} command`
            : `${missing.length} agents are unavailable`}
        </summary>
        <ul className="faint" style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 'var(--t-micro)', lineHeight: 1.5 }}>
          {missing.map((m) => (
            <li key={m.bin}>
              <span className="mono">{m.bin}</span> is not on the PATH Wanigan resolved — needed by {m.labels.join(', ')}.
            </li>
          ))}
        </ul>
      </details>
    );
  }

  return (
    <div className="sunk" style={{ margin: '-6px 0 14px', padding: '10px 12px' }}>
      <div className="label" style={{ color: 'var(--warning)', marginBottom: 4 }}>Nothing to launch yet</div>
      <p className="dim" style={{ fontSize: 'var(--t-small)', lineHeight: 1.5 }}>
        A session is a real terminal running a real CLI, so one has to be installed first. Wanigan does
        not bundle or install them.
      </p>
      <ul style={{ margin: '8px 0 0', paddingLeft: 0, listStyle: 'none',
                   display: 'flex', flexDirection: 'column', gap: 7 }}>
        {missing.map((m) => (
          <li key={m.bin} style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
            <span className="mono" style={{ fontSize: 'var(--t-small)', fontWeight: 650 }}>{m.bin}</span>
            <span className="faint" style={{ fontSize: 'var(--t-micro)', lineHeight: 1.45, minWidth: 0 }}>
              runs {m.labels.join(', ')}
            </span>
            <FocusBtn className="faint" style={{ marginLeft: 'auto', fontSize: 'var(--t-micro)', borderRadius: 'var(--r-sm)' }}
                      title={`Copy "command -v ${m.bin}" — run it in your terminal to see whether the CLI is installed and where`}
                      onClick={() => copy(m.bin)}>
              {copied === m.bin ? 'copied' : `copy command -v ${m.bin}`}
            </FocusBtn>
          </li>
        ))}
      </ul>
      <p className="faint" style={{ fontSize: 'var(--t-micro)', marginTop: 9, lineHeight: 1.45 }}>
        Install a CLI from its own vendor's instructions, then check again. Wanigan looks for these
        commands on the PATH your login shell reported when it started, plus the usual Homebrew, nvm and
        <span className="mono"> ~/.local/bin </span> locations. If <span className="mono">command -v</span> finds it
        in your terminal but Check again does not, it was installed somewhere that PATH did not cover —
        quit and reopen Wanigan so it reads your shell's PATH again.
      </p>
      <div style={{ display: 'flex', gap: 8, marginTop: 9, alignItems: 'center' }}>
        <FocusBtn className="btn" disabled={busy} onClick={() => void recheck()}>
          {busy ? 'Checking…' : 'Check again'}
        </FocusBtn>
        {error && (
          <span role="alert" style={{ color: 'var(--bad)', fontSize: 'var(--t-micro)', lineHeight: 1.4, minWidth: 0 }}>
            <span aria-hidden="true" style={{ fontWeight: 700, marginRight: 5 }}>✕</span>
            The check did not run: {error}
          </span>
        )}
      </div>
    </div>
  );
}
