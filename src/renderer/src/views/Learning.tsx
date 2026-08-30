import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  ForgedSkill,
  KnowledgeCandidate,
  KnowledgeItem,
  LearningExperiment,
  LearningOverview,
  LearningSettings,
  LearningSignal,
  OptimizerDiagnostic,
  Project,
  ProviderInfo,
  ProviderPackInfo,
  SkillDiagnostic,
} from '@shared/types';
import { EFFORT_LEVELS } from '@shared/types';
import ImprovementScout from './ImprovementScout';
import '../styles/learning.css';

type LearningTab = 'overview' | 'scout' | 'inbox' | 'knowledge' | 'skills' | 'map' | 'optimize' | 'experiments';

const TABS: { id: LearningTab; label: string; hint: string }[] = [
  { id: 'overview', label: 'Overview', hint: 'health and controls' },
  { id: 'scout', label: 'Scout', hint: 'source-backed product ideas' },
  { id: 'inbox', label: 'Inbox', hint: 'review proposed learning' },
  { id: 'knowledge', label: 'Knowledge', hint: 'canonical, cited facts' },
  { id: 'skills', label: 'Skills', hint: 'forge reusable workflows' },
  { id: 'map', label: 'Project Map', hint: 'how this repository works' },
  { id: 'optimize', label: 'Optimize', hint: 'spend less context' },
  { id: 'experiments', label: 'Experiments', hint: 'prove what helps' },
];

const EMPTY_OVERVIEW: LearningOverview = {
  pending: 0,
  activeKnowledge: 0,
  quarantined: 0,
  activeSkills: 0,
  experiments: 0,
  signals: 0,
  projectedTokenDelta: 0,
};

const DEFAULT_SETTINGS: LearningSettings = {
  enabled: true,
  contentMode: 'local-same-provider',
  automation: 'hybrid',
  allowModelAssistance: false,
  monthlyBudgetUsd: 0,
  briefingMaxTokens: 1_200,
  consolidationEnabled: true,
};

const message = (e: unknown) => e instanceof Error ? e.message : String(e);
const when = (at: number | null) => at ? new Date(at).toLocaleString() : 'never';
const tokens = (n: number) => `${n > 0 ? '+' : ''}${Math.round(n).toLocaleString()} tokens`;
const confidence = (n: number) => `${Math.round(Math.max(0, Math.min(1, n)) * 100)}%`;

export default function Learning({ projectId, projects, providers, onOpenGoal }: {
  projectId?: string;
  projects: Project[];
  providers: ProviderInfo[];
  /** Moves a Scout-created Goal into Control instead of leaving a bare hash. */
  onOpenGoal?: (id: string) => void;
}) {
  const [tab, setTab] = useState<LearningTab>('overview');
  const [overview, setOverview] = useState<LearningOverview>(EMPTY_OVERVIEW);
  const [settings, setSettings] = useState<LearningSettings>(DEFAULT_SETTINGS);
  const [signals, setSignals] = useState<LearningSignal[]>([]);
  const [candidates, setCandidates] = useState<KnowledgeCandidate[]>([]);
  const [knowledge, setKnowledge] = useState<KnowledgeItem[]>([]);
  const [diagnostics, setDiagnostics] = useState<OptimizerDiagnostic[]>([]);
  const [experiments, setExperiments] = useState<LearningExperiment[]>([]);
  const [packs, setPacks] = useState<ProviderPackInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [ov, st, sg, cd, kn, dg, ex, pk] = await Promise.all([
        window.wanigan.learning.overview(projectId ?? null),
        window.wanigan.learning.settings(),
        window.wanigan.learning.signals({ projectId: projectId ?? null, limit: 80 }),
        window.wanigan.learning.candidates({ projectId: projectId ?? null, limit: 100 }),
        window.wanigan.learning.knowledge({ projectId: projectId ?? null, limit: 200 }),
        window.wanigan.learning.diagnostics(projectId ?? null),
        window.wanigan.learning.experiments({ projectId: projectId ?? null, limit: 80 }),
        window.wanigan.providerPacks.list(true),
      ]);
      setOverview(ov);
      setSettings(st);
      setSignals(sg);
      setCandidates(cd);
      setKnowledge(kn);
      setDiagnostics(dg);
      setExperiments(ex);
      setPacks(pk);
      setError(null);
    } catch (e) {
      setError(message(e));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  const act = useCallback(async (key: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      setNotice(done);
      await load();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(null);
    }
  }, [load]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 6_000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const project = projects.find((p) => p.id === projectId) ?? null;
  const availableProviders = providers.filter((p) => p.path);

  return (
    <div className="learning-view">
      <div className="learning-head">
        <div>
          <span className="label">Wanigan Compound</span>
          <h1>Learning</h1>
          <p>
            Reuse what your agents prove, keep the evidence, and load only what this task needs.
            {project ? <> Scoped to <strong>{project.name}</strong>.</> : ' Showing personal knowledge.'}
          </p>
        </div>
        <div className="learning-head-actions">
          <button className="btn" disabled={loading || busy !== null} onClick={() => void load()}>
            {loading ? 'Reading…' : 'Refresh'}
          </button>
          <TeachButton project={project} providers={availableProviders} busy={busy}
                       onRun={(fn) => act('teach', fn, 'Added to the Learning Inbox with its source attached.')} />
        </div>
      </div>

      <div className="learning-tabs" role="tablist" aria-label="Learning workspace">
        {TABS.map((item) => (
          <button key={item.id} role="tab" aria-selected={tab === item.id}
                  className={tab === item.id ? 'on' : ''} onClick={() => setTab(item.id)}>
            <span>{item.label}</span><small>{item.hint}</small>
            {item.id === 'inbox' && overview.pending > 0 && <b>{overview.pending}</b>}
          </button>
        ))}
      </div>

      {error && <div className="learning-banner error" role="alert">{error}</div>}
      {notice && <div className="learning-banner ok" role="status">{notice}</div>}

      <div className="learning-scroll">
        {tab === 'overview' && (
          <Overview overview={overview} settings={settings} packs={packs} providers={providers}
                    projectId={projectId ?? null}
                    busy={busy} act={act} />
        )}
        {tab === 'scout' && <ImprovementScout projects={projects} onOpenGoal={onOpenGoal} />}
        {tab === 'inbox' && (
          <Inbox candidates={candidates} signals={signals} providers={availableProviders}
                 busy={busy} act={act} />
        )}
        {tab === 'knowledge' && (
          <Knowledge items={knowledge} projectId={projectId ?? null} busy={busy} act={act} />
        )}
        {tab === 'skills' && (
          <SkillForge project={project} providers={availableProviders} busy={busy} act={act} />
        )}
        {tab === 'map' && <ProjectMap project={project} items={knowledge} signals={signals} />}
        {tab === 'optimize' && (
          <Optimize diagnostics={diagnostics} settings={settings} busy={busy} act={act} />
        )}
        {tab === 'experiments' && (
          <Experiments experiments={experiments} candidates={candidates} project={project} providers={availableProviders}
                       busy={busy} act={act} />
        )}
      </div>
    </div>
  );
}

function Overview({ overview, settings, packs, providers, projectId, busy, act }: {
  overview: LearningOverview;
  settings: LearningSettings;
  packs: ProviderPackInfo[];
  providers: ProviderInfo[];
  projectId: string | null;
  busy: string | null;
  act: (key: string, fn: () => Promise<unknown>, done: string) => Promise<void>;
}) {
  const stat = [
    ['Inbox', overview.pending, 'waiting for your decision'],
    ['Knowledge', overview.activeKnowledge, 'active canonical items'],
    ['Skills', overview.activeSkills, 'reusable workflows'],
    ['Signals', overview.signals, 'bounded observations'],
    ['Quarantine', overview.quarantined, 'stale or contradictory'],
    ['Experiments', overview.experiments, 'measured comparisons'],
  ] as const;
  return (
    <div className="learning-stack">
      <section className="learning-stat-grid">
        {stat.map(([label, value, detail]) => (
          <article className="card learning-stat" key={label}>
            <span className="label">{label}</span><strong>{value.toLocaleString()}</strong><small>{detail}</small>
          </article>
        ))}
      </section>

      <section className="learning-grid two">
        <article className="card learning-card">
          <div className="learning-card-head"><div><span className="label">Retrieval</span><h2>Don’t Re-Research</h2></div>
            <span className={`learning-status ${settings.enabled ? 'good' : 'muted'}`}>
              {settings.enabled ? '✓ active' : '○ paused'}
            </span>
          </div>
          <p>Before a task begins, Wanigan retrieves a cited, token-bounded briefing for that project and path. Quarantined knowledge never enters it.</p>
          <div className="learning-meter" aria-label={`${overview.projectedTokenDelta} projected token delta`}>
            <span style={{ width: `${Math.min(100, Math.abs(overview.projectedTokenDelta) / 100)}%` }} />
          </div>
          <p className="faint">Projected context change: <span className="mono">{tokens(overview.projectedTokenDelta)}</span>. Savings stay labelled estimated until an A/B run proves them.</p>
          <button className="btn btn-primary" disabled={busy !== null || !settings.enabled}
                  onClick={() => void act('consolidate', () => window.wanigan.learning.consolidate(projectId),
                    'Consolidation finished. New proposals are in the Inbox; no project file was auto-applied.')}>
            {busy === 'consolidate' ? 'Consolidating…' : 'Consolidate now'}
          </button>
        </article>

        <article className="card learning-card">
          <div className="learning-card-head"><div><span className="label">Privacy boundary</span><h2>Local, same-backend content</h2></div><span className="learning-status good">⌂ local</span></div>
          <p>Operational outcomes can improve every adapter. Semantic content is eligible only on this machine and only for the frozen model backend that produced it; changing a profile’s backend cannot broaden access. Consolidation uses bounded signals and explicit teaching, not copied transcripts.</p>
          <ul className="learning-checks">
            <li><span>✓</span> No raw cross-provider transcript sharing</li>
            <li><span>✓</span> Current consolidation is deterministic and makes no model call</li>
            <li><span>✓</span> Project rules, skills, hooks, and settings always require approval</li>
            <li><span>✓</span> Codex-owned generated memories remain read-only</li>
          </ul>
        </article>
      </section>

      <section className="card learning-card">
        <div className="learning-card-head">
          <div><span className="label">Provider architecture</span><h2>Harnesses + model backends</h2></div>
          <button className="btn" disabled={busy !== null}
                  onClick={() => void act('packs-refresh', () => window.wanigan.providerPacks.refresh(), 'Provider manifests re-read from disk.')}>
            Refresh packs
          </button>
        </div>
        <p>Profiles combine a CLI harness with a model backend. Packs can be added or removed without changing the learning schema; live sessions keep their frozen launch snapshot.</p>
        <div className="provider-pack-grid">
          {packs.length === 0 && <Empty title="No provider packs were found" body="Built-in Claude, Codex, and GLM profiles should appear after a refresh." />}
          {packs.map((pack) => {
            const state = String(pack.status ?? pack.state ?? (pack.enabled ? 'enabled' : 'disabled'));
            return (
              <article className="provider-pack" key={pack.id}>
                <div><strong>{pack.label ?? pack.name ?? pack.id}</strong><span className="mono">{pack.id}@{pack.version}</span></div>
                <span className={`learning-status ${pack.enabled ? 'good' : 'muted'}`}>{state}</span>
                <p>{pack.description ?? 'Manifest-defined provider profiles.'}</p>
                <div className="provider-pack-meta">
                  <span>{pack.source === 'builtin' || pack.builtIn ? 'Built in' : pack.recoverable ? 'Recoverable' : 'Installed'}</span>
                  <span>{pack.adapterSha256 ? (pack.trustedAdapterSha256 === pack.adapterSha256 ? 'adapter digest trusted' : 'adapter untrusted') : 'manifest only'}</span>
                </div>
                {pack.manifestSha256 && state === 'needs-trust' && <code className="pack-digest" title={String(pack.manifestSha256)}>manifest {String(pack.manifestSha256).slice(0, 16)}…</code>}
                {pack.adapterSha256 && pack.trustedAdapterSha256 !== pack.adapterSha256 && state === 'needs-trust' ? (
                  <button className="btn" disabled={busy !== null} onClick={() => void act(`pack-${pack.id}`, async () => {
                    const inspected = await window.wanigan.providerPacks.inspectAdapter(pack.id);
                    if (!inspected.sha256 || !inspected.path) throw new Error('This adapter could not be inspected.');
                    const ok = window.confirm(`Trust this exact provider adapter digest?\n\n${inspected.path}\nArguments: ${inspected.args.join(' ') || '(none)'}\nSHA-256 ${inspected.sha256}\n\nAdapter v1 runs only a bounded capability probe in a separate process. It cannot select the session executable. This is not an OS sandbox.`);
                    if (!ok) throw new Error('Adapter trust was not changed.');
                    await window.wanigan.providerPacks.trustAdapter(pack.id, inspected.sha256);
                  }, 'The exact adapter digest is trusted. Enable remains a separate action.')}>Inspect & trust adapter</button>
                ) : state === 'removed' ? (
                  <button className="btn" disabled={busy !== null || pack.recoverable === false}
                          onClick={() => void act(`pack-${pack.id}`, () => window.wanigan.providerPacks.restore(pack.id), 'Provider pack restored disabled; review it before enabling.')}>Restore</button>
                ) : (
                  <button className="btn" disabled={busy !== null || state === 'pending-removal' || state === 'invalid'}
                          onClick={() => void act(`pack-${pack.id}`, async () => {
                            if (!pack.enabled && state === 'needs-trust') {
                              const inspected = await window.wanigan.providerPacks.inspectManifest(pack.id);
                              const commands = inspected.commands.map((command) => {
                                const launch = [command.bin, ...command.baseArgs].join(' ');
                                const probes = `\n  automatic version probe: ${command.bin} ${command.versionArgs.join(' ')}` +
                                  `\n  automatic help probe: ${command.bin} ${command.helpArgs.join(' ')}`;
                                const fields = command.launchFields.length
                                  ? `\n  launch-field argv: ${command.launchFields.map((field) => {
                                      const templates = [
                                        field.argv.length ? `value=[${field.argv.join(', ')}]` : '',
                                        field.trueArgv.length ? `true=[${field.trueArgv.join(', ')}]` : '',
                                        field.falseArgv.length ? `false=[${field.falseArgv.join(', ')}]` : '',
                                      ].filter(Boolean).join(' ');
                                      return `${field.label} (${field.id}/${field.kind}) ${templates || '(no argv)'}`;
                                    }).join('; ')}` : '';
                                const resume = command.resume
                                  ? `\n  resume argv: conversation=[${command.resume.conversationArgs.join(', ')}]; continue=[${command.resume.continueArgs.join(', ')}]`
                                  : '\n  resume argv: (none)';
                                const env = command.environment.length
                                  ? `\n  environment: ${command.environment.map((entry) => {
                                      if (entry.source === 'literal') {
                                        return `${entry.name} ← literal ${JSON.stringify(entry.value ?? '')}`;
                                      }
                                      if (entry.source === 'process') {
                                        return `${entry.name} ← process ${entry.processName ?? '(missing)'}` +
                                          (entry.fallback !== null ? ` fallback ${JSON.stringify(entry.fallback)}` : ' (no fallback)');
                                      }
                                      return `${entry.name} ← stored credential ${entry.credentialId ?? '(profile default)'} (value redacted)`;
                                    }).join('; ')}` : '';
                                const fallbacks = command.fallbackPaths.length
                                  ? `\n  bundled fallbacks: ${command.fallbackPaths.join(', ')}` : '';
                                const extensions = command.editorExtensions.length
                                  ? `\n  editor lookup: ${command.editorExtensions.map((entry) => `${entry.prefix} → ${entry.executablePaths.join(', ')}`).join('; ')}` : '';
                                const backend = command.declaredBackendId === command.backendId
                                  ? command.backendId
                                  : `${command.backendId} (declared ${command.declaredBackendId}; isolated by pack)`;
                                return `${command.profileLabel} (${command.harness}/${command.headless} → ${backend})` +
                                  `\n  launch: ${launch}${probes}${fields}${resume}${fallbacks}${extensions}${env}`;
                              }).join('\n\n');
                              const adapter = inspected.adapter
                                ? `\nAdapter probe: ${inspected.adapter.executable} ${inspected.adapter.args.join(' ')}\nAdapter SHA-256: ${inspected.adapter.sha256 ?? 'unavailable'}\n`
                                : '';
                              const ok = window.confirm(
                                `Trust this exact provider manifest and enable it?\n\n` +
                                `${inspected.label}@${inspected.version ?? 'unknown'}\n` +
                                `SHA-256 ${inspected.sha256 ?? 'unavailable'}\n` +
                                `${inspected.publisher ? `Publisher: ${inspected.publisher}\n` : ''}\n` +
                                `${commands}${adapter}\n${inspected.warning}`
                              );
                              if (!ok) throw new Error('Provider manifest trust was not changed.');
                              if (!inspected.sha256) throw new Error('The provider manifest has no verifiable digest.');
                              await window.wanigan.providerPacks.trustManifest(pack.id, inspected.sha256);
                            }
                            return window.wanigan.providerPacks.setEnabled(pack.id, !pack.enabled);
                          }, `${pack.label ?? pack.id} ${pack.enabled ? 'disabled' : 'enabled'}.`)}>
                    {pack.enabled ? 'Disable new launches' : state === 'needs-trust' ? 'Trust manifest & enable' : 'Enable'}
                  </button>
                )}
                {pack.source !== 'builtin' && state !== 'removed' && (
                  <button className="btn btn-danger" disabled={busy !== null || state === 'pending-removal'}
                          onClick={() => {
                            if (!window.confirm(`Remove ${pack.label ?? pack.id}? Live sessions keep their frozen profile; history, knowledge, credentials, and artifacts stay.`)) return;
                            void act(`remove-${pack.id}`, () => window.wanigan.providerPacks.remove(pack.id), 'Provider pack disabled for new launches and moved to recoverable trash when live sessions finish.');
                          }}>Remove pack</button>
                )}
              </article>
            );
          })}
        </div>
        <p className="faint">Detected launch profiles: {providers.map((p) => p.label).join(', ') || 'none'}.</p>
      </section>
    </div>
  );
}

function TeachButton({ project, providers, busy, onRun }: {
  project: Project | null;
  providers: ProviderInfo[];
  busy: string | null;
  onRun: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [scope, setScope] = useState<'personal' | 'project' | 'path'>(project ? 'project' : 'personal');
  const [kind, setKind] = useState<'memory' | 'instruction' | 'rule' | 'skill' | 'project-map'>('memory');
  const [providerId, setProviderId] = useState(providers[0]?.id ?? '');
  const [pathScope, setPathScope] = useState('');
  const submit = async () => {
    if (!title.trim() || !text.trim()) return;
    await onRun(() => window.wanigan.learning.teach({
      projectId: scope === 'personal' ? null : project?.id ?? null,
      projectPath: scope === 'personal' ? null : project?.path ?? null,
      providerId: providerId || null,
      scope,
      pathScope: scope === 'path' ? pathScope.trim() || null : null,
      kind,
      title: title.trim(),
      text: text.trim(),
      outcome: 'preference',
    }));
    setOpen(false); setTitle(''); setText('');
  };
  return (
    <>
      <button className="btn btn-primary" onClick={() => setOpen(true)}>Teach Wanigan</button>
      {open && (
        <div className="learning-modal-backdrop" onMouseDown={() => setOpen(false)}>
          <section className="learning-modal card" role="dialog" aria-modal="true" aria-label="Teach Wanigan"
                   onMouseDown={(e) => e.stopPropagation()}>
            <div className="learning-card-head"><div><span className="label">Explicit signal</span><h2>Teach Wanigan</h2></div><button className="btn" onClick={() => setOpen(false)}>Close</button></div>
            <p>This creates a cited Inbox proposal. It does not edit a skill, memory, or project file yet.</p>
            <label><span className="label">Title</span><input className="field" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What should be remembered?" /></label>
            <label><span className="label">Knowledge</span><textarea className="field" rows={7} value={text} onChange={(e) => setText(e.target.value)} placeholder="State the reusable fact, preference, rule, or procedure…" /></label>
            <div className="learning-form-grid">
              <label><span className="label">Scope</span><select className="field" value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}><option value="personal">My knowledge</option>{project && <option value="project">This project</option>}{project && <option value="path">Project path</option>}</select></label>
              <label><span className="label">Kind</span><select className="field" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}><option value="memory">Memory</option><option value="instruction">Instruction</option><option value="rule">Rule</option><option value="skill">Skill seed</option><option value="project-map">Project map</option></select></label>
              <label><span className="label">Source profile</span><select className="field" value={providerId} onChange={(e) => setProviderId(e.target.value)}><option value="">Provider-neutral</option>{providers.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select></label>
            </div>
            {scope === 'path' && <label><span className="label">Path pattern</span><input className="field mono" value={pathScope} onChange={(e) => setPathScope(e.target.value)} placeholder="src/payments/**" /></label>}
            <div className="learning-actions"><button className="btn btn-primary" disabled={busy !== null || !title.trim() || !text.trim()} onClick={() => void submit()}>{busy === 'teach' ? 'Adding…' : 'Add to Inbox'}</button></div>
          </section>
        </div>
      )}
    </>
  );
}

function Inbox({ candidates, signals, providers, busy, act }: {
  candidates: KnowledgeCandidate[];
  signals: LearningSignal[];
  providers: ProviderInfo[];
  busy: string | null;
  act: (key: string, fn: () => Promise<unknown>, done: string) => Promise<void>;
}) {
  const [status, setStatus] = useState('open');
  const visible = candidates.filter((c) => status === 'all'
    || (status === 'open' ? ['pending', 'approved', 'snoozed', 'failed'].includes(c.status) : c.status === status));
  return (
    <div className="learning-stack">
      <section className="learning-toolbar card">
        <div><span className="label">Learning Inbox</span><strong>{visible.length} proposal{visible.length === 1 ? '' : 's'}</strong></div>
        <label><span className="label">Status</span><select className="field" value={status} onChange={(e) => setStatus(e.target.value)}><option value="open">Needs a decision</option><option value="pending">Pending</option><option value="approved">Approved</option><option value="snoozed">Snoozed</option><option value="rejected">Rejected</option><option value="all">All</option></select></label>
      </section>
      {visible.length === 0 && <Empty title="The Inbox is clear" body="Teach Wanigan directly, run a review gate, or consolidate repeated operational signals to create a proposal." />}
      <div className="candidate-list">
        {visible.map((candidate) => <CandidateCard key={candidate.id} candidate={candidate} providers={providers} busy={busy} act={act} />)}
      </div>
      <section className="card learning-card">
        <div className="learning-card-head"><div><span className="label">Recent evidence stream</span><h2>Operational signals</h2></div><span className="learning-status muted">content bounded</span></div>
        <div className="signal-list">
          {signals.slice(0, 20).map((signal) => <div key={signal.id}><span className="mono">{signal.kind}</span><strong>{signal.summary}</strong><small>{signal.providerId ?? 'provider-neutral'} · {when(signal.createdAt)} · {signal.semanticEligible ? 'same-provider eligible' : 'operational only'}</small></div>)}
          {signals.length === 0 && <p className="faint">No learning signals have been recorded for this scope yet.</p>}
        </div>
      </section>
    </div>
  );
}

function CandidateCard({ candidate, providers, busy, act }: {
  candidate: KnowledgeCandidate;
  providers: ProviderInfo[];
  busy: string | null;
  act: (key: string, fn: () => Promise<unknown>, done: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(candidate.title);
  const [text, setText] = useState(candidate.proposedText);
  const [target, setTarget] = useState(candidate.providerId ?? providers[0]?.id ?? 'claude');
  const key = `candidate-${candidate.id}`;
  const approve = () => act(key, async () => {
    await window.wanigan.learning.reviewCandidate(candidate.id, 'approve');
    await window.wanigan.learning.promoteCandidate(candidate.id);
  }, 'Approved into canonical knowledge. Provider files are still unchanged.');
  const save = () => act(key, () => window.wanigan.learning.updateCandidate(candidate.id, { title: title.trim(), proposedText: text.trim() }), 'Proposal updated; its evidence and review history were preserved.');
  return (
    <article className={`card candidate-card status-${candidate.status}`}>
      <div className="candidate-top">
        <div>
          <span className="label">{candidate.targetKind} · {candidate.scope}{candidate.pathScope ? ` · ${candidate.pathScope}` : ''}</span>
          {editing ? <input className="field" value={title} onChange={(e) => setTitle(e.target.value)} /> : <h2>{candidate.title}</h2>}
        </div>
        <span className={`learning-status ${candidate.status === 'failed' ? 'bad' : candidate.status === 'approved' ? 'good' : 'muted'}`}>{candidate.status}</span>
      </div>
      <div className="candidate-proof">
        <span><b>{confidence(candidate.confidence)}</b> confidence</span>
        <span><b>{candidate.evidenceCount}</b> evidence</span>
        <span><b>{candidate.taskCount}</b> independent tasks</span>
        <span><b>{tokens(candidate.estimatedTokenDelta)}</b> projected</span>
      </div>
      <p className="candidate-rationale">{candidate.rationale}</p>
      {editing ? <textarea className="field mono" rows={9} value={text} onChange={(e) => setText(e.target.value)} /> : <pre className="candidate-patch">{candidate.proposedText}</pre>}
      {candidate.conflicts.length > 0 && <div className="candidate-conflicts"><strong>Conflicts to resolve</strong>{candidate.conflicts.map((c) => <p key={`${c.itemId}-${c.relation}`}>{c.relation}: {c.title} — {c.reason}</p>)}</div>}
      <div className="candidate-targets">
        <div><span className="label">Provider targets</span><select className="field" value={target} onChange={(e) => setTarget(e.target.value)}>{providers.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select></div>
        <p><span className="label">Activation</span><br />Canonical after approval; written to the selected provider only after Apply. New sessions see it after validation.</p>
      </div>
      <div className="learning-actions">
        {editing ? <><button className="btn btn-primary" disabled={busy !== null || !title.trim() || !text.trim()} onClick={() => void save()}>Save edit</button><button className="btn" onClick={() => setEditing(false)}>Cancel</button></>
          : <button className="btn" disabled={busy !== null || !['pending', 'snoozed'].includes(candidate.status)} onClick={() => setEditing(true)}>Edit</button>}
        {candidate.status !== 'promoted' && candidate.status !== 'applied' && <button className="btn btn-primary" disabled={busy !== null || candidate.conflicts.length > 0} onClick={() => void approve()}>{busy === key ? 'Working…' : 'Approve to knowledge'}</button>}
        {['instruction', 'rule', 'skill'].includes(candidate.targetKind) && ['approved', 'promoted'].includes(candidate.status) && <button className="btn btn-primary" disabled={busy !== null || !target} onClick={() => void act(key, () => window.wanigan.learning.applyCandidate(candidate.id, target), 'Validated and applied. The exact prior content is available for Undo.')}>Apply to {providers.find((p) => p.id === target)?.label ?? target}</button>}
        <button className="btn" disabled={busy !== null || candidate.status === 'snoozed'} onClick={() => void act(key, () => window.wanigan.learning.reviewCandidate(candidate.id, 'snooze'), 'Proposal snoozed; its evidence remains.')}>Snooze</button>
        <button className="btn btn-danger" disabled={busy !== null || candidate.status === 'rejected'} onClick={() => void act(key, () => window.wanigan.learning.reviewCandidate(candidate.id, 'reject'), 'Proposal rejected; the decision remains in its audit history.')}>Reject</button>
      </div>
    </article>
  );
}

function Knowledge({ items, projectId, busy, act }: {
  items: KnowledgeItem[];
  projectId: string | null;
  busy: string | null;
  act: (key: string, fn: () => Promise<unknown>, done: string) => Promise<void>;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<KnowledgeItem[] | null>(null);
  const [selected, setSelected] = useState<KnowledgeItem | null>(null);
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof window.wanigan.learning.item>> | null>(null);
  const search = async () => {
    if (!query.trim()) { setResults(null); return; }
    const found = await window.wanigan.learning.search(query.trim(), { projectId, limit: 80 });
    setResults(found.map((r) => r.item));
  };
  const choose = async (item: KnowledgeItem) => {
    setSelected(item);
    setDetail(await window.wanigan.learning.item(item.id));
  };
  const visible = results ?? items;
  return (
    <div className="learning-split">
      <section className="learning-list-pane">
        <div className="learning-search card"><input className="field" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void search(); }} placeholder="Search canonical knowledge and path scopes…" /><button className="btn" onClick={() => void search()}>Search</button></div>
        {visible.length === 0 && <Empty title="No canonical knowledge yet" body="Approve an Inbox proposal to create the first versioned item." />}
        {visible.map((item) => <button key={item.id} className={`knowledge-row card ${selected?.id === item.id ? 'on' : ''}`} onClick={() => void choose(item)}><span className="label">{item.kind} · {item.scope}</span><strong>{item.title}</strong><p>{item.canonicalText.slice(0, 170)}</p><small>{confidence(item.confidence)} · v{item.currentVersion} · {item.sourceCount} sources · {item.status}</small></button>)}
      </section>
      <aside className="learning-detail card">
        {!selected || !detail ? <Empty title="Select a knowledge item" body="Its full text, evidence, versions, projections, and measured ROI will appear here." /> : <>
          <div className="learning-card-head"><div><span className="label">{selected.kind} · {selected.scope}</span><h2>{selected.title}</h2></div><span className={`learning-status ${selected.status === 'active' ? 'good' : 'bad'}`}>{selected.status}</span></div>
          <pre className="candidate-patch">{selected.canonicalText}</pre>
          <div className="detail-stats"><span><b>{detail.versions.length}</b> versions</span><span><b>{detail.evidence.length}</b> citations</span><span><b>{detail.projections.length}</b> projections</span><span><b>{detail.roi.samples}</b> ROI samples</span></div>
          <h3>Evidence</h3><div className="evidence-list">{detail.evidence.map((e) => <div key={e.id}><strong>{e.citation}</strong><small>{e.sourceType} · {when(e.observedAt)} · weight {e.weight}</small></div>)}{detail.evidence.length === 0 && <p className="faint">No evidence rows are attached.</p>}</div>
          <h3>Projection history</h3><div className="evidence-list">{detail.projections.map((p) => <div key={p.id}><strong>{p.providerId} → <span className="mono">{p.targetPath}</span></strong><small>{p.status} · {when(p.appliedAt ?? p.createdAt)}</small>{p.status === 'applied' && <button className="btn" disabled={busy !== null} onClick={() => void act(`undo-${p.id}`, () => window.wanigan.learning.undoProjection(p.id), 'Projection undone because the applied hash still matched. Canonical knowledge remains.')}>Undo</button>}</div>)}</div>
          <p className="faint">ROI: {detail.roi.evidenceLevel} evidence · {detail.roi.tokensSaved.toLocaleString()} tokens saved · {detail.roi.successfulUses} successful uses. Only causal experiments are labelled verified.</p>
        </>}
      </aside>
    </div>
  );
}

function SkillForge({ project, providers, busy, act }: {
  project: Project | null;
  providers: ProviderInfo[];
  busy: string | null;
  act: (key: string, fn: () => Promise<unknown>, done: string) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [trigger, setTrigger] = useState('');
  const [steps, setSteps] = useState('Inspect the relevant files\nMake the smallest safe change\nRun the project review gate');
  const [verification, setVerification] = useState('Run the relevant tests\nReview the final diff');
  const [scope, setScope] = useState<'personal' | 'project'>(project ? 'project' : 'personal');
  const [targets, setTargets] = useState<string[]>(providers.map((p) => p.id));
  const [forged, setForged] = useState<ForgedSkill | null>(null);
  const [doctor, setDoctor] = useState<SkillDiagnostic[]>([]);
  const forge = async () => {
    const value = await window.wanigan.learning.forgeSkill({
      name: name.trim(), description: description.trim(), trigger: trigger.trim(), scope,
      steps: steps.split('\n').map((instruction, i) => ({ title: `Step ${i + 1}`, instruction: instruction.trim() })).filter((s) => s.instruction),
      verification: verification.split('\n').map((s) => s.trim()).filter(Boolean),
      providerIds: targets,
    });
    setForged(value);
    setDoctor(await window.wanigan.learning.doctorSkill(value.skillMd, project?.path));
  };
  return (
    <div className="learning-grid skill-grid">
      <section className="card learning-card">
        <div><span className="label">Skill Forge</span><h2>Turn a repeated win into a portable skill</h2></div>
        <p>The common body follows the Agent Skills shape. Claude and Codex receive provider-specific paths and overlays only when their harness needs one.</p>
        <label><span className="label">Skill name</span><input className="field mono" value={name} onChange={(e) => setName(e.target.value)} placeholder="verification-before-completion" /></label>
        <label><span className="label">Description</span><input className="field" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this workflow reliably accomplishes" /></label>
        <label><span className="label">Trigger</span><textarea className="field" rows={3} value={trigger} onChange={(e) => setTrigger(e.target.value)} placeholder="When should an agent discover and use it?" /></label>
        <label><span className="label">Steps · one per line</span><textarea className="field mono" rows={7} value={steps} onChange={(e) => setSteps(e.target.value)} /></label>
        <label><span className="label">Verification · one per line</span><textarea className="field mono" rows={4} value={verification} onChange={(e) => setVerification(e.target.value)} /></label>
        <div className="learning-form-grid"><label><span className="label">Scope</span><select className="field" value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}><option value="personal">My skill</option>{project && <option value="project">Project skill</option>}</select></label><fieldset><legend className="label">Provider targets</legend>{providers.map((p) => <label className="learning-check" key={p.id}><input type="checkbox" checked={targets.includes(p.id)} onChange={(e) => setTargets((old) => e.target.checked ? [...old, p.id] : old.filter((id) => id !== p.id))} /> {p.label}</label>)}</fieldset></div>
        <button className="btn btn-primary" disabled={busy !== null || !name.trim() || !description.trim() || !trigger.trim()} onClick={() => void act('forge', forge, 'Skill draft forged and checked. Review its exact SKILL.md before installation.')}>{busy === 'forge' ? 'Forging…' : 'Forge and diagnose'}</button>
      </section>
      <aside className="card learning-card skill-preview">
        <div className="learning-card-head"><div><span className="label">Preview</span><h2>{forged?.name ?? 'SKILL.md'}</h2></div>{forged && <span className="learning-status muted">≈ {forged.estimatedTokens} tokens</span>}</div>
        {forged ? <><pre className="candidate-patch">{forged.skillMd}</pre><div className="doctor-list">{doctor.length === 0 ? <p className="learning-status good">✓ Skill Doctor found no issues</p> : doctor.map((d, i) => <p key={`${d.code}-${i}`} className={d.severity}><strong>{d.code}</strong> {d.message}{d.line ? ` · line ${d.line}` : ''}</p>)}</div><button className="btn btn-primary" disabled={busy !== null || doctor.some((d) => d.severity === 'error') || targets.length === 0} onClick={() => void act('install-skill', () => window.wanigan.learning.installSkill(forged, targets, scope === 'project' ? project?.id ?? null : null), 'Skill projections applied to the selected provider paths. No git commit was created.')}>Install approved skill</button><p className="faint">Project: Claude <span className="mono">.claude/skills/{forged.name}</span> · Codex <span className="mono">.agents/skills/{forged.name}</span>. Personal skills use the matching home-directory roots.</p></> : <Empty title="No skill draft yet" body="Describe the trigger, workflow, and checks. The Forge generates a reviewable provider-neutral body; it never invents an installation silently." />}
      </aside>
    </div>
  );
}

function ProjectMap({ project, items, signals }: { project: Project | null; items: KnowledgeItem[]; signals: LearningSignal[] }) {
  const mapped = items.filter((i) => ['project-map', 'instruction', 'rule', 'gate', 'mission'].includes(i.kind));
  const groups = useMemo(() => {
    const map = new Map<string, KnowledgeItem[]>();
    for (const item of mapped) {
      const key = item.pathScope || (item.scope === 'personal' ? 'Personal' : 'Repository-wide');
      map.set(key, [...(map.get(key) ?? []), item]);
    }
    return [...map.entries()];
  }, [mapped]);
  return (
    <div className="learning-stack">
      <section className="card learning-card project-map-hero"><div><span className="label">Living Project Map</span><h2>{project?.name ?? 'Choose a project'}</h2><p className="mono">{project?.path ?? 'Personal scope has no repository tree.'}</p></div><div><b>{groups.length}</b><small>mapped scopes</small></div><div><b>{mapped.length}</b><small>active facts</small></div><div><b>{signals.filter((s) => s.kind === 'gate-passed').length}</b><small>gate passes seen</small></div></section>
      {groups.length === 0 && <Empty title="This project has not mapped itself yet" body="Approve project-map, instruction, rule, mission, and review-gate proposals. Wanigan will group them by path without loading every rule into every session." />}
      <div className="map-tree">{groups.map(([path, entries]) => <section className="card map-branch" key={path}><div className="map-path"><span aria-hidden="true">⌁</span><strong className="mono">{path}</strong></div>{entries.map((item) => <div className="map-item" key={item.id}><span className="learning-status muted">{item.kind}</span><div><strong>{item.title}</strong><p>{item.canonicalText}</p><small>{confidence(item.confidence)} · {item.sourceCount} citations · checked {when(item.lastValidatedAt)}</small></div></div>)}</section>)}</div>
    </div>
  );
}

function Optimize({ diagnostics, settings, busy, act }: {
  diagnostics: OptimizerDiagnostic[];
  settings: LearningSettings;
  busy: string | null;
  act: (key: string, fn: () => Promise<unknown>, done: string) => Promise<void>;
}) {
  const save = (patch: Partial<LearningSettings>) => act('learning-settings', () => window.wanigan.learning.setSettings(patch), 'Learning controls updated. New sessions use the new retrieval policy.');
  return (
    <div className="learning-stack">
      <section className="learning-grid two">
        <article className="card learning-card"><span className="label">Adaptive context router</span><h2>Load less, later</h2><p>Structured project/path scope and full-text ranking run locally first. Progressive skills and mission briefings receive a hard token ceiling.</p><label><span className="label">Briefing ceiling · tokens</span><input className="field" type="number" min={200} max={8000} value={settings.briefingMaxTokens} onChange={(e) => void save({ briefingMaxTokens: Number(e.target.value) })} /></label><label className="learning-check"><input type="checkbox" checked={settings.consolidationEnabled} onChange={(e) => void save({ consolidationEnabled: e.target.checked })} /> Consolidate while Wanigan or its daemon is active</label></article>
        <article className="card learning-card"><span className="label">Learning budget governor</span><h2>Deterministic-only today</h2><p>Classification, hashing, routing, and diagnostics run locally without a model call. The stored opt-in and monthly ceiling reserve an explicit boundary for a future model-assisted consolidator; they do not spend or launch one in this build.</p><label className="learning-check"><input type="checkbox" checked={settings.allowModelAssistance} disabled /> Model-assisted extraction (not connected yet)</label><label><span className="label">Reserved monthly ceiling · USD</span><input className="field" type="number" min={0} step="0.25" value={settings.monthlyBudgetUsd} disabled /></label><p className="faint">Wanigan will not imply this control is active before usage metering and provider-specific consent are wired end to end.</p></article>
      </section>
      <section className="card learning-card"><div className="learning-card-head"><div><span className="label">Context Budget Doctor · Cache Guardian · Garbage Collector</span><h2>{diagnostics.length} finding{diagnostics.length === 1 ? '' : 's'}</h2></div><span className="learning-status muted">diagnosis only</span></div><div className="diagnostic-list">{diagnostics.length === 0 && <Empty title="No context debt detected" body="Duplicate, contradictory, expired, oversized, unused, drifting, or volatile artifacts will appear here." />}{diagnostics.map((d, i) => <article key={`${d.kind}-${i}`} className={`diagnostic ${d.severity}`}><span aria-hidden="true">{d.severity === 'error' ? '✕' : d.severity === 'warning' ? '!' : 'i'}</span><div><strong>{d.title}</strong><p>{d.detail}</p><small>{d.kind} · {tokens(d.estimatedTokenDelta)} · {d.itemIds.length} item{d.itemIds.length === 1 ? '' : 's'}</small></div></article>)}</div></section>
      <p className="faint">These numbers are estimated until a controlled Context A/B experiment proves a causal saving. Wanigan does not call fewer tokens “better” unless the same evaluation still passes.</p>
    </div>
  );
}

function Experiments({ experiments, candidates, project, providers, busy, act }: {
  experiments: LearningExperiment[];
  candidates: KnowledgeCandidate[];
  project: Project | null;
  providers: ProviderInfo[];
  busy: string | null;
  act: (key: string, fn: () => Promise<unknown>, done: string) => Promise<void>;
}) {
  const [name, setName] = useState('Context briefing A/B');
  const [providerId, setProviderId] = useState(providers[0]?.id ?? '');
  const [candidateId, setCandidateId] = useState(candidates[0]?.id ?? '');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('default');
  useEffect(() => {
    if (!candidateId && candidates[0]) setCandidateId(candidates[0].id);
  }, [candidateId, candidates]);
  const create = async () => {
    const commits = project ? await window.wanigan.git.log(project.path, { limit: 1 }) : [];
    const commitHash = typeof commits?.[0]?.hash === 'string' ? commits[0].hash : 'personal-no-repository';
    const pinnedModel = model.trim() || 'provider default';
    const pinnedEffort = effort === 'default' ? null : effort;
    return window.wanigan.learning.createExperiment({
      name: name.trim(), projectId: project?.id ?? null, candidateId, providerId,
      model: pinnedModel, effort: pinnedEffort, commitHash,
      config: {
        variable: 'one context artifact',
        evidence: 'causal only after controlled completion',
        baseline: { providerId, model: pinnedModel, effort: pinnedEffort, commitHash, artifact: false },
        candidate: { providerId, model: pinnedModel, effort: pinnedEffort, commitHash, artifact: true },
      },
    });
  };
  return (
    <div className="learning-grid experiment-grid">
      <section className="card learning-card"><span className="label">Context A/B Lab</span><h2>Register a controlled comparison</h2><p>Pin the provider, model, effort, exact commit, evaluation, and one changed artifact. This release records the protocol and outcome; it does not yet launch paired workloads or ingest their metrics automatically. A closed manual run therefore remains an estimate.</p><label><span className="label">Name</span><input className="field" value={name} onChange={(e) => setName(e.target.value)} /></label><label><span className="label">Candidate artifact</span><select className="field" value={candidateId} onChange={(e) => setCandidateId(e.target.value)}><option value="">Choose a candidate…</option>{candidates.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.title} · {candidate.status}</option>)}</select></label><label><span className="label">Provider</span><select className="field" value={providerId} onChange={(e) => { setProviderId(e.target.value); setEffort('default'); }}>{providers.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select></label><label><span className="label">Model</span><input className="field mono" value={model} onChange={(e) => setModel(e.target.value)} placeholder="provider default" /></label><label><span className="label">Effort</span><select className="field" value={effort} disabled={!providers.find((p) => p.id === providerId)?.supports.effort} onChange={(e) => setEffort(e.target.value)}><option value="default">Provider default</option>{EFFORT_LEVELS.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>{candidates.length === 0 && <p className="faint">Create a Learning Inbox candidate first; an A/B test needs exactly one artifact to vary.</p>}<button className="btn btn-primary" disabled={busy !== null || !name.trim() || !providerId || !candidateId} onClick={() => void act('experiment-create', create, 'Experiment registered as a draft. No model call or run was started.')}>Create draft</button></section>
      <section className="experiment-list">{experiments.length === 0 && <Empty title="No experiments yet" body="Create a draft to pin the comparison. Wanigan will keep estimated and causal metrics visibly separate." />}{experiments.map((e) => <article className="card experiment-card" key={e.id}><div className="learning-card-head"><div><span className="label">{e.providerId} · {e.model}</span><h2>{e.name}</h2></div><span className={`learning-status ${e.status === 'completed' ? 'good' : e.status === 'failed' ? 'bad' : 'muted'}`}>{e.status}</span></div><p className="mono">commit {e.commitHash || 'un-pinned'} · effort {e.effort ?? 'default'}</p><small>Created {when(e.createdAt)} · started {when(e.startedAt)} · ended {when(e.endedAt)}</small><div className="learning-actions">{e.status === 'draft' && <button className="btn btn-primary" disabled={busy !== null} onClick={() => void act(`experiment-${e.id}`, () => window.wanigan.learning.setExperimentStatus(e.id, 'start'), 'Experiment marked running. Execute its pinned baseline and candidate workloads.')}>Start</button>}{e.status === 'running' && <button className="btn btn-primary" disabled={busy !== null} onClick={() => void act(`experiment-${e.id}`, () => window.wanigan.learning.setExperimentStatus(e.id, 'complete', { evidenceLevel: 'estimate', note: 'Closed from the workspace; paired metrics have not been ingested.' }), 'Experiment closed. Savings remain estimated until paired evaluation metrics prove a causal result.')}>Close run</button>}{['draft', 'running'].includes(e.status) && <button className="btn" disabled={busy !== null} onClick={() => void act(`experiment-${e.id}`, () => window.wanigan.learning.setExperimentStatus(e.id, 'cancel'), 'Experiment cancelled; its history remains.')}>Cancel</button>}</div></article>)}</section>
    </div>
  );
}

function Empty({ title, body }: { title: string; body: string }) {
  return <div className="learning-empty"><span aria-hidden="true">◇</span><div><strong>{title}</strong><p>{body}</p></div></div>;
}
