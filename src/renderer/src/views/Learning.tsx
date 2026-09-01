import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  CandidateExplanation,
  ConsolidationRun,
  ForgedSkill,
  FreshnessReport,
  KnowledgeBriefing,
  KnowledgeCandidate,
  KnowledgeItem,
  KnowledgeRelation,
  KnowledgeStatus,
  LearningExperiment,
  LearningOverview,
  LearningPipelineStats,
  LearningSettings,
  LearningSignal,
  OptimizerDiagnostic,
  Project,
  ProviderInfo,
  ProviderPackInfo,
  SkillDiagnostic,
  SkillInstallResult,
} from '@shared/types';
import { EFFORT_LEVELS } from '@shared/types';
import { ago } from '../components/bits';
import ImprovementScout from './ImprovementScout';
import '../styles/learning.css';

type LearningTab = 'overview' | 'inbox' | 'knowledge' | 'optimize' | 'skills' | 'scout' | 'experiments' | 'providers';

/** Runs one mutation with busy/error handling, then reloads. `done` may derive
 * the notice from the call's real result, so success copy never has to guess. */
type Act = (key: string, fn: () => Promise<unknown>, done: string | ((result: unknown) => string)) => Promise<boolean>;

type ScopeSel = 'all' | 'personal' | 'project';

const SCOPE_KEY = 'wanigan.learning.scope';
const MECHANISM_KEY = 'wanigan.learning.mechanism';

/** The single scope→IPC mapper. Main already speaks this tri-state everywhere:
 * undefined = all projects + personal, null = personal-only, id = that project
 * (plus personal artifacts at candidate/knowledge stages). Every learning.*
 * read routes through this one value so no two surfaces can disagree. */
const toScopeParam = (sel: ScopeSel, projectId?: string): string | null | undefined =>
  sel === 'all' ? undefined : sel === 'personal' ? null : projectId;

// Pipeline group first, tools after the divider; the divider sits before `skills`.
const TABS: { id: LearningTab; label: string; hint: string; toolsStart?: boolean }[] = [
  { id: 'overview', label: 'Overview', hint: 'what the engine did' },
  { id: 'inbox', label: 'Inbox', hint: 'review proposed learning' },
  { id: 'knowledge', label: 'Knowledge', hint: 'canonical, cited facts' },
  { id: 'optimize', label: 'Optimize', hint: 'spend less context' },
  { id: 'skills', label: 'Skills', hint: 'forge reusable workflows', toolsStart: true },
  { id: 'scout', label: 'Scout', hint: 'source-backed product ideas' },
  { id: 'experiments', label: 'Experiments', hint: 'prove what helps' },
  { id: 'providers', label: 'Providers', hint: 'packs & harnesses' },
];

// Consume-once across remounts: the deep-link target lives in App state, so a
// later visit to Learning must not replay a jump this nonce already made.
let consumedTargetNonce = 0;
// The same rule for the glossary link in the tab strip.
let consumedGlossaryNonce = 0;

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

const WINDOWS = [7, 30, 90];

const message = (e: unknown) => e instanceof Error ? e.message : String(e);
const when = (at: number | null) => at ? new Date(at).toLocaleString() : 'never';
/* Token deltas come from the bytes÷4 heuristic, so they always wear the mark and the word. */
const estTokens = (n: number) => `~${n > 0 ? '+' : ''}${Math.round(n).toLocaleString()} est. tokens`;
/* Confidence is a deterministic rule-derived heuristic, never a model output — shown as a plain 0–1 value, never a headline percentage. */
const ruleConf = (n: number) => Math.max(0, Math.min(1, n)).toFixed(2);
const pl = (n: number) => n === 1 ? '' : 's';

/** Two shapes retrieval refuses to inject, named the way they are stored: the
 * canonical text repeats the title, or it is only a locator. Both are observed
 * properties of the row — never a quality score — and the test is kept in step
 * with `isUnsynthesized` in briefing.ts. */
const unsynthesizedMark = (title: string, text: string): string | null => {
  const trimmed = text.trim();
  if (!trimmed) return 'text is empty';
  if (trimmed === title.trim()) return 'text is identical to title';
  // Rooted at a POSIX root, a home shortcut, a Windows drive or a UNC share,
  // and containing no whitespace at all.
  return /^(?:\/|~\/|[A-Za-z]:[\\/]|\\\\)\S*$/.test(trimmed) ? 'text is a bare filesystem path' : null;
};

/** Held-back items, by reason. Retrieval counts four of them because they have
 * four different fixes — re-cite the item, raise the token ceiling, raise the
 * freshness-check quota, or repair the candidate — so they are never summed
 * into one number here. The two newer counters are read defensively: a build
 * that does not report one leaves it null and it is stated as unaccounted,
 * rather than printed as an observed zero. */
type HeldBack = {
  stale: number; budget: number;
  unsynthesized: number | null; unverified: number | null;
  unaccounted: number;
};
const readHeldBack = (briefing: KnowledgeBriefing): HeldBack => {
  const extra = briefing as unknown as Record<string, unknown>;
  const reported = (key: string): number | null => {
    const value = extra[key];
    return typeof value === 'number' ? value : null;
  };
  const unsynthesized = reported('omittedUnsynthesized');
  const unverified = reported('omittedUnverified');
  const named = briefing.omittedStale + briefing.omittedBudget + (unsynthesized ?? 0) + (unverified ?? 0);
  return {
    stale: briefing.omittedStale, budget: briefing.omittedBudget, unsynthesized, unverified,
    unaccounted: Math.max(0, briefing.omitted - named),
  };
};

/** True when retrieval had a task query or a path to be relevant to. Null when
 * this build did not report it, so the caller can fall back to what it asked
 * for instead of asserting. */
const readQueryProvided = (briefing: KnowledgeBriefing): boolean | null => {
  const value = (briefing as unknown as Record<string, unknown>)['queryProvided'];
  return typeof value === 'boolean' ? value : null;
};

const fmtBytes = (n: number) => n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB`
  : n >= 1_024 ? `${Math.round(n / 1_024)} KB` : `${n} B`;

/** Every word below is otherwise taught only in a hover title, which touch
 * never shows and a screen reader reads unreliably. Defined once, in text. */
const GLOSSARY: { term: string; body: string }[] = [
  { term: 'Signal', body: 'One bounded, credential-redacted record of something a session did — a tool result, a gate outcome, a turn ending. Shell command text is discarded: a signal is a summary plus structured detail, never a transcript.' },
  { term: 'Candidate', body: 'A proposal in the Inbox. Consolidation writes one when an observation repeats across independent tasks; “Teach Wanigan” writes one from your own words. A candidate changes nothing until you decide on it.' },
  { term: 'Claim', body: 'The sentence a candidate proposes — what its evidence is said to mean. A candidate that counted observations without stating a sentence is a nomination, and promoting it is refused until someone writes one.' },
  { term: 'Proof', body: 'The observed counts printed on a candidate: distinct observations, and how many independent tasks they came from. Counts over stored rows, not a score.' },
  { term: 'Evidence', body: 'The citations attached to a candidate or item — the signal, file, or commit it came from. Evidence is what lets a claim be checked again later.' },
  { term: 'Knowledge item', body: 'A canonical, versioned record with its evidence. Items are the source of truth; provider files are copies of them.' },
  { term: 'Projection', body: 'A reversible write of an item into a provider file (CLAUDE.md, .claude/rules/, AGENTS.md, a skill directory). It stores the prior bytes, and Undo restores them while the applied hash still matches. Nothing is ever committed for you.' },
  { term: 'Briefing', body: 'The token-bounded capsule retrieval assembles at session launch: the items that ranked for that task, with their citations. Built per launch, not stored inside the agent.' },
  { term: 'Quarantine', body: 'The state an item enters when a citation it rests on is missing, changed, or outside an allowed root. It stays stored, and stops being injected until its citations are re-validated.' },
  { term: 'Retired', body: 'A status, not a deletion. A retired item keeps every version, citation, and projection, and stops being retrieved and injected.' },
  { term: 'Scope', body: 'Where an artifact applies: personal (everywhere), project (one repository), or path (a subtree of one repository). Scope decides retrieval, and at the automation gate it decides whether review is required.' },
  { term: 'Harness', body: 'The CLI a session actually runs — its process, flags, and resume behavior. Wanigan routes by what a harness declares, never by its name.' },
  { term: 'Backend', body: 'The model behind a profile. Semantic content stays with the backend that produced it; operational counts cross providers freely, content does not.' },
  { term: 'Pack', body: 'A provider manifest contributing profiles (harness + backend + launch configuration). Packs are untrusted data until their exact digest is trusted.' },
  { term: 'Confidence', body: 'A rule, not a measurement and not a model’s opinion. For a machine-derived candidate it follows the count of independent tasks alone, and is capped below the auto-apply minimum by construction. The Inbox’s “Why this needs review” panel prints the policy numbers each candidate is compared against.' },
];

const fmtDur = (ms: number) => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
};

/** 'YYYY-MM-DD' → 'Aug 27', parsed as a local date so it cannot slip a day. */
const fmtDay = (day: string) => {
  const [y, m, d] = day.split('-').map(Number);
  if (!y || !m || !d) return day;
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

/** A round axis top, so the tick labels are numbers a person would say. */
const niceMax = (v: number) => {
  if (!(v > 0)) return 1;
  const base = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10]) if (v <= m * base) return m * base;
  return 10 * base;
};

/** Measured chart width in CSS pixels (the Insights idiom), so strokes and type keep their size. */
function useWidth() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [w, setW] = useState(720);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const next = Math.max(240, Math.round(entries[0]?.contentRect.width ?? 720));
      setW((prev) => (Math.abs(prev - next) > 1 ? next : prev));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

export default function Learning({ projectId, projects, providers, onOpenGoal, onPickProject, initialTarget }: {
  projectId?: string;
  projects: Project[];
  providers: ProviderInfo[];
  /** Moves a Scout-created Goal into Control instead of leaving a bare hash. */
  onOpenGoal?: (id: string) => void;
  /** Picking a project scope here moves the app-global selection with it. */
  onPickProject?: (id: string) => void;
  /** One-shot deep link from Context; consumed by nonce. */
  initialTarget?: { tab: 'overview' | 'inbox' | 'knowledge' | 'optimize'; nonce: number } | null;
}) {
  const [tab, setTab] = useState<LearningTab>('overview');
  const [scopeSel, setScopeSel] = useState<ScopeSel>(() => {
    try {
      const stored = localStorage.getItem(SCOPE_KEY);
      if (stored === 'all' || stored === 'personal' || stored === 'project') return stored;
    } catch { /* storage unavailable — fall through to the derived default */ }
    // Default to the app-derived project when one exists, never silently personal-only.
    return projectId ? 'project' : 'all';
  });
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
  // Keyed by a nonce so repeating the same action restarts the 6s timer and
  // re-announces, instead of the second toast silently inheriting the first's clock.
  const [notice, setNotice] = useState<{ text: string; key: number } | null>(null);
  const noticeSeq = useRef(0);
  const [windowDays, setWindowDays] = useState(30);
  const [pipeline, setPipeline] = useState<LearningPipelineStats | null>(null);
  const [pipelineErr, setPipelineErr] = useState<string | null>(null);
  const [pipelineBusy, setPipelineBusy] = useState(true);
  const [refreshTick, setRefreshTick] = useState(0);
  // A funnel click carries intent: the target Inbox filter rides along, keyed by
  // a nonce so a repeat click re-applies it even when the value is unchanged.
  const [inboxPreset, setInboxPreset] = useState<{ status: string; key: number } | null>(null);
  const presetSeq = useRef(0);
  // The glossary lives at the foot of Overview; a bumped nonce opens and scrolls
  // to it even when Overview is already the tab in view.
  const [glossaryNonce, setGlossaryNonce] = useState(0);

  // Project scope with no project left (all projects removed) degrades visibly
  // to Everything rather than silently narrowing to personal-only.
  useEffect(() => {
    if (scopeSel === 'project' && !projectId) setScopeSel('all');
  }, [scopeSel, projectId]);

  const setScope = useCallback((next: ScopeSel) => {
    setScopeSel(next);
    try { localStorage.setItem(SCOPE_KEY, next); } catch { /* storage unavailable */ }
  }, []);

  // The one scope value every read below shares — overview, signals, candidates,
  // knowledge, diagnostics, experiments, pipeline, search, and briefing preview.
  const scopeParam = toScopeParam(scopeSel, projectId);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const [ov, st, sg, cd, kn, dg, ex, pk] = await Promise.all([
        window.wanigan.learning.overview(scopeParam),
        window.wanigan.learning.settings(),
        window.wanigan.learning.signals({ projectId: scopeParam, limit: 80 }),
        window.wanigan.learning.candidates({ projectId: scopeParam, limit: 100 }),
        window.wanigan.learning.knowledge({ projectId: scopeParam, limit: 200 }),
        window.wanigan.learning.diagnostics(scopeParam),
        window.wanigan.learning.experiments({ projectId: scopeParam, limit: 80 }),
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
  }, [scopeParam]);

  useEffect(() => { void load(); }, [load]);

  // Pipeline counts are windowed, so they fetch on their own dependency set —
  // but through the same scopeParam as every other read, by construction.
  useEffect(() => {
    let cancelled = false;
    setPipelineBusy(true);
    void window.wanigan.learning.pipeline({ projectId: scopeParam, windowDays })
      .then((p) => { if (!cancelled) { setPipeline(p); setPipelineErr(null); } })
      .catch((e) => { if (!cancelled) setPipelineErr(message(e)); })
      .finally(() => { if (!cancelled) setPipelineBusy(false); });
    return () => { cancelled = true; };
  }, [scopeParam, windowDays, refreshTick]);

  // One-shot deep link from Context — the nonce marks the jump as consumed, and
  // a module-level record keeps a remount from replaying it.
  useEffect(() => {
    if (!initialTarget || initialTarget.nonce === consumedTargetNonce) return;
    consumedTargetNonce = initialTarget.nonce;
    setTab(initialTarget.tab);
  }, [initialTarget]);

  // Background activity (a live session's signal, a consolidation pass) pushes a
  // quiet reload — data updates in place, no loading state is flashed.
  useEffect(() => {
    const off = window.wanigan.on.learningChanged(() => {
      setRefreshTick((t) => t + 1);
      void load(true);
    });
    return () => { off(); };
  }, [load]);

  const act = useCallback<Act>(async (key, fn, done) => {
    setBusy(key);
    setError(null);
    try {
      const result = await fn();
      setNotice({ text: typeof done === 'function' ? done(result) : done, key: ++noticeSeq.current });
      setRefreshTick((t) => t + 1);
      await load(true);
      return true;
    } catch (e) {
      setError(message(e));
      return false;
    } finally {
      setBusy(null);
    }
  }, [load]);

  const openGlossary = useCallback(() => {
    setTab('overview');
    setGlossaryNonce((n) => n + 1);
  }, []);

  const navigate = useCallback((next: LearningTab, inboxStatus?: string) => {
    if (inboxStatus) setInboxPreset({ status: inboxStatus, key: ++presetSeq.current });
    setTab(next);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 6_000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const project = projects.find((p) => p.id === projectId) ?? null;
  const availableProviders = providers.filter((p) => p.path);
  const scopeWords = scopeSel === 'all' ? 'Everything'
    : scopeSel === 'personal' ? 'Personal only'
    : `${project?.name ?? 'project'} + personal`;
  // Candidate, knowledge, diagnostic, and experiment lists are all-time reads.
  const emptyFrame = `scope: ${scopeWords} · all time`;

  return (
    <div className="learning-view">
      <div className="learning-head">
        <div>
          <span className="label">Wanigan Compound</span>
          <h1>Learning</h1>
          <p>
            Reuse what your agents prove, keep the evidence, and load only what this task needs.{' '}
            {scopeSel === 'all' && 'Showing everything — every project plus personal knowledge.'}
            {scopeSel === 'personal' && 'Showing personal knowledge only — items that apply in every project.'}
            {scopeSel === 'project' && <>Showing <strong>{project?.name ?? 'this project'}</strong> plus personal items. Signals and briefings count this project only.</>}
          </p>
        </div>
        <div className="learning-head-actions">
          <label className="learning-scope">
            <span className="label">Scope</span>
            <select className="field" value={scopeSel === 'project' ? `p:${projectId ?? ''}` : scopeSel}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === 'all' || v === 'personal') { setScope(v); return; }
                      setScope('project');
                      onPickProject?.(v.slice(2));
                    }}>
              <option value="all">Everything — all projects + personal</option>
              <option value="personal">Personal only</option>
              {projects.map((p) => <option key={p.id} value={`p:${p.id}`}>{p.name}</option>)}
            </select>
          </label>
          <button className="btn" disabled={loading || busy !== null} onClick={() => { setRefreshTick((t) => t + 1); void load(); }}>
            {loading ? 'Reading…' : 'Refresh'}
          </button>
          <TeachButton project={project} providers={availableProviders} busy={busy}
                       onRun={(fn) => act('teach', fn, 'Added to the Learning Inbox with its source attached.')} />
        </div>
      </div>

      <PipelineSpine overview={overview} pipeline={pipeline} pipelineBusy={pipelineBusy}
                     windowDays={windowDays} onNavigate={navigate} />

      {/* The hint sits beside the tablist rather than inside it: it is the only
          gloss on eight terse labels, so it is read out like any other text —
          and a tablist may not hold a focusable child that is not a tab. */}
      <div className="learning-tabs">
        <div className="learning-tablist" role="tablist" aria-label="Learning workspace"
             onKeyDown={(e) => {
               if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
               e.preventDefault();
               const i = TABS.findIndex((t) => t.id === tab);
               const next = e.key === 'Home' ? 0
                 : e.key === 'End' ? TABS.length - 1
                 : e.key === 'ArrowLeft' ? (i - 1 + TABS.length) % TABS.length
                 : (i + 1) % TABS.length;
               setTab(TABS[next].id);
               document.getElementById(`learning-tab-${TABS[next].id}`)?.focus();
             }}>
          {TABS.map((item) => (
            <Fragment key={item.id}>
              {item.toolsStart && <span className="tab-gap" aria-hidden="true" />}
              <button role="tab" aria-selected={tab === item.id}
                      id={`learning-tab-${item.id}`} aria-controls={`learning-panel-${item.id}`}
                      tabIndex={tab === item.id ? 0 : -1} title={item.hint}
                      className={tab === item.id ? 'on' : ''} onClick={() => setTab(item.id)}>
                <span>{item.label}</span>
                {item.id === 'inbox' && overview.pending > 0 && <b>{overview.pending}</b>}
              </button>
            </Fragment>
          ))}
        </div>
        <p className="tab-hint">
          {TABS.find((t) => t.id === tab)?.hint} ·{' '}
          <button className="learning-link" onClick={openGlossary}>glossary</button>
        </p>
      </div>

      {error && <div className="learning-banner error" role="alert">{error}</div>}
      {notice && <div className="learning-banner ok" role="status" key={notice.key}>{notice.text}</div>}

      {/* tabIndex makes the panel focusable, which is what lets a keyboard
          scroll it at all; without it the arrow keys had nothing to act on. */}
      <div className="learning-scroll" tabIndex={0} role="tabpanel" id={`learning-panel-${tab}`} aria-labelledby={`learning-tab-${tab}`}>
        {tab === 'overview' && (
          <Overview overview={overview} settings={settings} pipeline={pipeline}
                    pipelineErr={pipelineErr} pipelineBusy={pipelineBusy}
                    windowDays={windowDays} onWindow={setWindowDays}
                    candidates={candidates} knowledge={knowledge}
                    scopeSel={scopeSel} scopeParam={scopeParam} busy={busy} act={act}
                    glossaryNonce={glossaryNonce}
                    onNavigate={navigate} onRetry={() => setRefreshTick((t) => t + 1)} />
        )}
        {tab === 'scout' && <ImprovementScout projects={projects} onOpenGoal={onOpenGoal} />}
        {tab === 'inbox' && (
          <Inbox candidates={candidates} signals={signals} providers={availableProviders}
                 busy={busy} act={act} initialStatus={inboxPreset}
                 scoped={scopeSel !== 'all'} onShowAll={() => setScope('all')} emptyFrame={emptyFrame} />
        )}
        {tab === 'knowledge' && (
          <Knowledge items={knowledge} signals={signals}
                     project={scopeSel === 'personal' ? null : project}
                     scopeParam={scopeParam} emptyFrame={emptyFrame}
                     busy={busy} act={act} refreshTick={refreshTick} />
        )}
        {tab === 'skills' && (
          <SkillForge project={project} providers={availableProviders} busy={busy} act={act} />
        )}
        {tab === 'optimize' && (
          <Optimize diagnostics={diagnostics} settings={settings} providers={availableProviders}
                    scopeParam={scopeParam} emptyFrame={emptyFrame} busy={busy} act={act} />
        )}
        {tab === 'experiments' && (
          <Experiments experiments={experiments} candidates={candidates} project={project} providers={availableProviders}
                       busy={busy} act={act} emptyFrame={emptyFrame} />
        )}
        {tab === 'providers' && (
          <Providers packs={packs} providers={providers} busy={busy} act={act} />
        )}
      </div>
    </div>
  );
}

/* ── The five-station spine · shared chrome on every tab ───────────────── */

function PipelineSpine({ overview, pipeline, pipelineBusy, windowDays, onNavigate }: {
  overview: LearningOverview;
  pipeline: LearningPipelineStats | null;
  pipelineBusy: boolean;
  windowDays: number;
  onNavigate: (tab: LearningTab, inboxStatus?: string) => void;
}) {
  // Windowed flows come from the pipeline read; '…' while it loads and '—' on a
  // failed read keep loading and error visibly distinct from a real zero.
  const flow = (n: number | undefined) =>
    n !== undefined ? n.toLocaleString() : pipelineBusy ? '…' : '—';
  const stations: { key: string; label: string; value: string; sub: string; warn?: string; go: () => void; title: string }[] = [
    { key: 'observed', label: 'Observed', value: flow(pipeline?.signals), sub: `signals · last ${windowDays}d`,
      go: () => onNavigate('overview'), title: 'Open the Overview — the day chart breaks these down' },
    { key: 'proposed', label: 'Proposed', value: overview.pending.toLocaleString(), sub: 'await your decision · now',
      go: () => onNavigate('inbox', 'open'), title: 'Open the Inbox filtered to proposals needing a decision' },
    { key: 'approved', label: 'Approved', value: overview.activeKnowledge.toLocaleString(), sub: 'active items · now',
      warn: overview.quarantined > 0 ? `⚠ ${overview.quarantined} quarantined` : undefined,
      go: () => onNavigate('knowledge'), title: 'Open Knowledge' },
    { key: 'projected', label: 'Projected', value: flow(pipeline?.projectionsApplied), sub: `files written · last ${windowDays}d`,
      go: () => onNavigate('knowledge'), title: 'Open Knowledge — projections are listed on each item' },
    { key: 'briefed', label: 'Briefed', value: flow(pipeline?.briefingsServed), sub: `served · last ${windowDays}d`,
      go: () => onNavigate('optimize'), title: 'Open Optimize — the briefing inspector previews one' },
  ];
  return (
    <div className="pipeline-spine" role="group" aria-label="Learning pipeline">
      {stations.map((s, i) => (
        <Fragment key={s.key}>
          {i > 0 && <span className="spine-arrow" aria-hidden="true">→</span>}
          <button className="spine-station" onClick={s.go} title={s.title}>
            <span className="label">{s.label}</span>
            <b className={s.value === '0' ? 'zero' : ''}>{s.value}</b>
            <small>{s.sub}</small>
            {s.warn && <small className="spine-warn">{s.warn}</small>}
          </button>
        </Fragment>
      ))}
    </div>
  );
}

/* ── Overview · the legibility surface ─────────────────────────────────── */

function Overview({ overview, settings, pipeline, pipelineErr, pipelineBusy, windowDays, onWindow, candidates, knowledge, scopeSel, scopeParam, busy, act, glossaryNonce, onNavigate, onRetry }: {
  overview: LearningOverview;
  settings: LearningSettings;
  pipeline: LearningPipelineStats | null;
  pipelineErr: string | null;
  pipelineBusy: boolean;
  windowDays: number;
  onWindow: (d: number) => void;
  candidates: KnowledgeCandidate[];
  knowledge: KnowledgeItem[];
  scopeSel: ScopeSel;
  scopeParam: string | null | undefined;
  busy: string | null;
  act: Act;
  /** Bumped by the tab-strip link; opens and scrolls to the glossary. */
  glossaryNonce: number;
  onNavigate: (tab: LearningTab, inboxStatus?: string) => void;
  onRetry: () => void;
}) {
  // Loading is not empty; a fatal read failure is not either.
  if (!pipeline && pipelineBusy) {
    return (
      <div className="learning-stack">
        <div className="learning-empty">
          <span aria-hidden="true">◌</span>
          <div>
            <strong>Reading the learning ledger…</strong>
            <p>Pipeline counts, per-day signals, and consolidation runs are read from the local database.</p>
          </div>
        </div>
      </div>
    );
  }
  if (!pipeline) {
    return (
      <div className="learning-stack">
        <section className="card learning-card">
          <span className="learning-status bad">✕ read failed</span>
          <h2>Could not read the learning pipeline</h2>
          <p>{pipelineErr ?? 'The pipeline call returned nothing.'}</p>
          <div className="learning-actions">
            <button className="btn btn-primary" onClick={onRetry}>Retry</button>
          </div>
        </section>
      </div>
    );
  }

  const hasAnyEver = overview.signals > 0 || overview.activeKnowledge > 0 || overview.pending > 0
    || candidates.length > 0 || knowledge.length > 0 || pipeline.signals > 0
    || pipeline.briefingsServed > 0 || pipeline.consolidationRuns.length > 0;

  const windowControl = (
    <div className="learning-window">
      <span className="label">Window</span>
      <div className="learning-seg" role="group" aria-label="Pipeline window in days">
        {WINDOWS.map((d) => (
          <button key={d} type="button" aria-pressed={d === windowDays} onClick={() => onWindow(d)}>
            {d} days
          </button>
        ))}
      </div>
      <span className="faint">
        Scopes the pipeline, the day chart, and briefings served.{' '}
        {scopeSel === 'all' && 'All projects and personal scope.'}
        {scopeSel === 'personal' && 'Personal scope only.'}
        {scopeSel === 'project' && 'Signals and briefings: this project only. Candidate and knowledge stages also count personal-scope items, which apply everywhere.'}
      </span>
    </div>
  );

  if (!hasAnyEver) {
    return (
      <div className="learning-stack">
        <section className="card learning-card">
          <div><span className="label">Nothing recorded yet</span><h2>What fills this page</h2></div>
          <p>
            Every number here is a count over stored rows, so the page stays empty until something
            has been recorded. Three actions produce data, and any one is enough:
          </p>
          <ul className="learning-checks">
            <li><span aria-hidden="true">·</span> <strong>Run a session.</strong> Tool activity records bounded signals — Claude Code sessions record per-tool events via hooks; Codex sessions record turn-complete and approval events.</li>
            <li><span aria-hidden="true">·</span> <strong>Teach Wanigan directly.</strong> The button above creates a cited Inbox proposal from your own words.</li>
            <li><span aria-hidden="true">·</span> <strong>Run a review gate.</strong> Gate passes and failures are recorded as signals with their citations.</li>
          </ul>
          <p className="faint">Repeated observations across independent tasks are consolidated into proposals every 5 minutes while Wanigan is open.</p>
        </section>
        <MechanismDisclosure pipeline={pipeline} windowDays={windowDays} onNavigate={onNavigate} />
        <AutoPromotion pipeline={pipeline} windowDays={windowDays} onNavigate={onNavigate} />
        <NeedsAttention overview={overview} settings={settings} candidates={candidates} onNavigate={onNavigate} />
        <PrivacyCard />
        <Glossary openNonce={glossaryNonce} />
      </div>
    );
  }

  return (
    <div className="learning-stack">
      {windowControl}
      {pipelineErr && (
        <p className="faint">
          These counts may be stale — the last refresh failed: {pipelineErr}{' '}
          <button className="learning-link" onClick={onRetry}>Retry</button>
        </p>
      )}

      <MechanismDisclosure pipeline={pipeline} windowDays={windowDays} onNavigate={onNavigate} />

      <SignalsPerDay pipeline={pipeline} windowDays={windowDays}
                     onWiden={windowDays < 90 ? () => onWindow(90) : null} />

      <section className="learning-grid two">
        <Heartbeat runs={pipeline.consolidationRuns} settings={settings} scopeParam={scopeParam}
                   busy={busy} act={act} />
        <RetrievalCard settings={settings} pipeline={pipeline} windowDays={windowDays}
                       candidates={candidates} onNavigate={onNavigate} />
      </section>

      <AutoPromotion pipeline={pipeline} windowDays={windowDays} onNavigate={onNavigate} />

      <NeedsAttention overview={overview} settings={settings} candidates={candidates} onNavigate={onNavigate} />

      <PrivacyCard />

      <Glossary openNonce={glossaryNonce} />
    </div>
  );
}

/** The mechanism prose plus the detailed sub-stages the spine displaced — one
 * collapsed line normally, expanded by default only on a never-recorded store. */
function MechanismDisclosure({ pipeline, windowDays, onNavigate }: {
  pipeline: LearningPipelineStats;
  windowDays: number;
  onNavigate: (tab: LearningTab, inboxStatus?: string) => void;
}) {
  const [open, setOpen] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem(MECHANISM_KEY);
      if (stored === 'open') return true;
      if (stored === 'closed') return false;
    } catch { /* storage unavailable */ }
    return pipeline.signalsAllTime === 0;
  });
  const toggle = () => {
    const next = !open;
    setOpen(next);
    try { localStorage.setItem(MECHANISM_KEY, next ? 'open' : 'closed'); } catch { /* storage unavailable */ }
  };
  const p = pipeline;
  const toReview = Math.max(0, p.candidatesCreated - p.autoPromoted);
  return (
    <section className="card learning-card">
      <button className="drawer-toggle" aria-expanded={open} onClick={toggle}>
        {open ? '▾' : '▸'} How signals become briefings: events → bounded signals → 5-min consolidation → your review → versioned knowledge → reversible projections → cited briefings
      </button>
      {open && (
        <>
          <p>
            Session events become bounded, credential-redacted signals — shell command text is discarded.
            A deterministic pass every 5 minutes groups repeats (at least 2 observations across 2 independent
            sessions or tasks) into candidates for the review Inbox; one narrow lane can auto-apply reversible
            personal memory, and nothing derived from a session qualifies for it. Approved
            candidates become versioned knowledge items, projected reversibly into provider files, and
            served back as token-bounded, cited briefings at session launch.
          </p>
          <div className="mech-stages">
            <button className="pipeline-substage" onClick={() => onNavigate('inbox')} title="Open the Inbox — recent signals are listed at its foot">
              <b>{p.eligibleSignals.toLocaleString()}</b><span>eligible for consolidation · last {windowDays}d</span>
            </button>
            <button className="pipeline-substage" onClick={() => onNavigate('inbox', 'all')} title="Open the Inbox filtered to every proposal">
              <b>{p.candidatesCreated.toLocaleString()}</b><span>candidates created · last {windowDays}d</span>
            </button>
            <button className="pipeline-substage" onClick={() => onNavigate('knowledge')} title="Open Knowledge — the auto-apply lane lands there">
              <b>{p.autoPromoted.toLocaleString()}</b><span><span aria-hidden="true">✓</span> auto-applied · last {windowDays}d</span>
            </button>
            <button className="pipeline-substage" onClick={() => onNavigate('inbox', 'open')} title="Open the Inbox filtered to proposals needing a decision">
              <b>{toReview.toLocaleString()}</b><span>to review · last {windowDays}d</span>
            </button>
            <button className="pipeline-substage" onClick={() => onNavigate('inbox', 'decided')} title="Open the Inbox filtered to decided proposals">
              <b>{p.reviewed.toLocaleString()}</b><span>reviewed · last {windowDays}d</span>
            </button>
            <button className="pipeline-substage" onClick={() => onNavigate('knowledge')} title="Open Knowledge">
              <b>{p.itemsPromoted.toLocaleString()}</b><span>knowledge items created · last {windowDays}d</span>
            </button>
          </div>
          <p className="faint">
            Every figure is a count over stored rows for this window. Signals and candidates live in the
            Inbox tab; items and projections in Knowledge; briefings in Optimize.
          </p>
        </>
      )}
    </section>
  );
}

function SignalsPerDay({ pipeline, windowDays, onWiden }: {
  pipeline: LearningPipelineStats;
  windowDays: number;
  onWiden: (() => void) | null;
}) {
  const [ref, w] = useWidth();
  const rows = pipeline.signalsByDay;
  const total = rows.reduce((a, r) => a + r.total, 0);
  const failures = rows.reduce((a, r) => a + r.failures, 0);
  const teachings = rows.reduce((a, r) => a + r.teachings, 0);
  const other = Math.max(0, total - failures - teachings);

  // A young store shows only its recorded span (at least 7 days), not a window
  // of empty gridlines; the caption states the clip as an observed fact.
  const firstIdx = rows.findIndex((r) => r.total > 0);
  const span = firstIdx >= 0 ? rows.length - firstIdx : 0;
  const shownDays = total > 0 ? Math.min(rows.length, Math.max(span, 7)) : rows.length;
  const shown = shownDays < rows.length ? rows.slice(-shownDays) : rows;
  const clipNote = total > 0 && shown.length < rows.length
    ? `Recording began ${fmtDay(rows[firstIdx].day)} — showing ${shown.length} of the ${windowDays}-day window; earlier days had no signals.`
    : null;
  const zeroWords = total > 0
    ? [other === 0 ? 'no other' : null, failures === 0 ? 'no failures' : null, teachings === 0 ? 'no teachings' : null]
        .filter((s): s is string => s !== null).join(', ')
    : '';

  const H = 120, PAD_T = 8, PAD_B = 20, PAD_L = 30, PAD_R = 6;
  const plotW = Math.max(60, w - PAD_L - PAD_R);
  const plotH = H - PAD_T - PAD_B;
  // Counts are integers, so the axis top and midpoint snap to integers too.
  const max = Math.ceil(niceMax(Math.max(...shown.map((r) => r.total), 0)));
  const step = shown.length ? plotW / shown.length : plotW;
  const bw = Math.max(1.5, Math.min(28, step * 0.7));
  const ticks = max >= 4 ? [0, Math.ceil(max / 2), max] : [0, max];

  return (
    <section className="card learning-card">
      <div className="learning-card-head">
        <div><span className="label">Signals per day</span><h2>Observed activity · last {windowDays} days</h2></div>
      </div>
      <div className="signal-chart" ref={ref}>
      {total === 0 ? (
        <div className="chart-empty">
          <p>No signals were recorded in the last {windowDays} days.</p>
          {pipeline.signalsAllTime > pipeline.signals && (
            <p className="faint" style={{ marginTop: 5 }}>
              Signals were recorded before this window.{' '}
              {onWiden
                ? <button className="learning-link" onClick={onWiden}>Widen it to 90 days</button>
                : 'Ninety days is the widest window here.'}
            </p>
          )}
        </div>
      ) : (
        <>
          <svg className="chart-svg" viewBox={`0 0 ${w} ${H}`} height={H} role="img"
               aria-label={`Stacked bars of learning signals per day over the ${shown.length < rows.length ? `last ${shown.length} recorded days of the ${windowDays}-day window` : `last ${windowDays} days`}: ${total} signal${pl(total)} in total, of which ${failures} recorded failure${pl(failures)} and ${teachings} explicit teaching${pl(teachings)}, counted from stored learning signals.`}>
            {ticks.map((v) => {
              const y = PAD_T + plotH - (v / max) * plotH;
              return (
                <g key={v}>
                  <line x1={PAD_L} y1={y} x2={w - PAD_R} y2={y} stroke="var(--grid)" strokeWidth="1" />
                  <text x={PAD_L - 6} y={y + 3.5} fontSize="10" textAnchor="end"
                        fill="var(--text-faint)" style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {v}
                  </text>
                </g>
              );
            })}
            {shown.map((r, i) => {
              const x = PAD_L + i * step + (step - bw) / 2;
              const dayOther = Math.max(0, r.total - r.failures - r.teachings);
              // Fixed slot order, bottom to top: other (1), failures (2), teachings (3).
              const stack: { v: number; fill: string }[] = [
                { v: dayOther, fill: 'var(--series-1)' },
                { v: r.failures, fill: 'var(--series-2)' },
                { v: r.teachings, fill: 'var(--series-3)' },
              ];
              let y = PAD_T + plotH;
              return (
                <g key={r.day}>
                  {stack.map((s, j) => {
                    if (s.v <= 0) return null;
                    const h = (s.v / max) * plotH;
                    y -= h;
                    return <rect key={j} x={x} y={y} width={bw} height={Math.max(1, h - 1)} rx={Math.min(2, bw / 2)} fill={s.fill} />;
                  })}
                </g>
              );
            })}
            {shown.map((r, i) => (
              <rect key={`hit-${r.day}`} x={PAD_L + i * step} y={PAD_T} width={Math.max(step, 1)} height={plotH} fill="transparent">
                <title>
                  {`${fmtDay(r.day)} — ${r.total} signal${pl(r.total)}: ${r.failures} failure${pl(r.failures)}, ${r.teachings} teaching${pl(r.teachings)}, ${Math.max(0, r.total - r.failures - r.teachings)} other`}
                </title>
              </rect>
            ))}
            <line x1={PAD_L} y1={PAD_T + plotH} x2={w - PAD_R} y2={PAD_T + plotH} stroke="var(--line)" strokeWidth="1" />
            {shown.length > 0 && (
              <>
                <text x={PAD_L} y={H - 6} fontSize="10" fill="var(--text-faint)">{fmtDay(shown[0].day)}</text>
                <text x={w - PAD_R} y={H - 6} fontSize="10" textAnchor="end" fill="var(--text-faint)">{fmtDay(shown[shown.length - 1].day)}</text>
              </>
            )}
          </svg>
          <div className="legend">
            {/* Fixed slot order and colors; a series with nothing in the window is
                named in the caption instead of holding an empty legend slot. */}
            {other > 0 && <span className="legend-item"><span className="legend-swatch" style={{ background: 'var(--series-1)' }} />Other <span className="mono">{other.toLocaleString()}</span></span>}
            {failures > 0 && <span className="legend-item"><span className="legend-swatch" style={{ background: 'var(--series-2)' }} />Failures <span className="mono">{failures.toLocaleString()}</span></span>}
            {teachings > 0 && <span className="legend-item"><span className="legend-swatch" style={{ background: 'var(--series-3)' }} />Teachings <span className="mono">{teachings.toLocaleString()}</span></span>}
            <span className="legend-item">Total <span className="mono">{total.toLocaleString()}</span></span>
          </div>
          {(clipNote || zeroWords) && (
            <p className="faint">
              {clipNote}{clipNote && zeroWords ? ' ' : ''}{zeroWords ? `In this window: ${zeroWords}.` : ''}
            </p>
          )}
        </>
      )}
      </div>
      <p className="faint">
        Counted from stored learning signals. Claude Code sessions record per-tool events via hooks;
        Codex sessions record only turn-complete and approval lifecycle events, so their days count fewer signals.
      </p>
    </section>
  );
}

function Heartbeat({ runs, settings, scopeParam, busy, act }: {
  runs: ConsolidationRun[];
  settings: LearningSettings;
  scopeParam: string | null | undefined;
  busy: string | null;
  act: Act;
}) {
  const latest = runs[0] ?? null;
  const strip = useMemo(() => [...runs].reverse(), [runs]); // oldest → newest, left to right
  const maxC = Math.max(...runs.map((r) => r.candidates), 1);
  const consolidateButton = (
    <button className="btn btn-primary" disabled={busy !== null || !settings.enabled}
            onClick={() => void act('consolidate', () => window.wanigan.learning.consolidate(scopeParam),
              // The notice reports what this pass actually did — zeros included.
              (result) => {
                const r = result as { processed: number; candidates: number; autoApplied: number };
                return r.candidates > 0
                  ? `Consolidation finished: ${r.candidates} candidate${pl(r.candidates)} from ${r.processed} consumed signal${pl(r.processed)}, ${r.autoApplied} auto-applied.`
                  : 'Consolidation finished: no new candidates — nothing repeated across enough independent sessions yet.';
              })}>
      {busy === 'consolidate' ? 'Consolidating…' : 'Consolidate now'}
    </button>
  );
  return (
    <article className="card learning-card">
      <div className="learning-card-head">
        <div><span className="label">Automation heartbeat</span><h2>Consolidation passes</h2></div>
        {latest && <span className="learning-status muted">{runs.length} recorded</span>}
      </div>
      {latest ? (
        <>
          <p>
            Consolidation last ran <strong>{ago(latest.at)}</strong> ({latest.trigger}) ·
            consumed <strong>{latest.processed.toLocaleString()}</strong> signal{pl(latest.processed)} into candidates ·
            produced <strong>{latest.candidates.toLocaleString()}</strong> candidate{pl(latest.candidates)} ·
            auto-applied <strong>{latest.autoApplied.toLocaleString()}</strong>.
          </p>
          <div className="heartbeat-strip" role="img"
               aria-label={`${runs.length} recorded consolidation pass${runs.length === 1 ? '' : 'es'}; the most recent produced ${latest.candidates} candidate${pl(latest.candidates)}.`}>
            {strip.map((r) => (
              <span key={r.id} className={r.candidates > 0 ? 'hit' : ''}
                    style={{ height: `${4 + Math.round((r.candidates / maxC) * 18)}px` }}
                    title={`${when(r.at)} · ${r.trigger} · consumed ${r.processed} · ${r.candidates} candidate${pl(r.candidates)} · auto-applied ${r.autoApplied} · ${r.durationMs}ms`} />
            ))}
          </div>
          {consolidateButton}
        </>
      ) : (
        <>
          <Empty title="No consolidation pass has been recorded yet"
                 body="The 5-minute timer runs while Wanigan is open, and “Consolidate now” records a manual pass. Each pass is stored here — including one that finds nothing new." />
          {consolidateButton}
        </>
      )}
      <p className="faint">
        Runs every 5 minutes while Wanigan is open. Every pass is recorded — an empty pass means it
        ran and found nothing new. Counted from stored consolidation runs.
      </p>
    </article>
  );
}

function RetrievalCard({ settings, pipeline, windowDays, candidates, onNavigate }: {
  settings: LearningSettings;
  pipeline: LearningPipelineStats;
  windowDays: number;
  candidates: KnowledgeCandidate[];
  onNavigate: (tab: LearningTab) => void;
}) {
  const pending = candidates.filter((c) => c.status === 'pending');
  const pendingEst = pending.reduce((a, c) => a + c.estimatedTokenDelta, 0);
  return (
    <article className="card learning-card">
      <div className="learning-card-head">
        <div><span className="label">Retrieval</span><h2>Briefings at launch</h2></div>
        <span className={`learning-status ${settings.enabled ? 'good' : 'muted'}`}>
          {settings.enabled ? '✓ active' : '○ paused'}
        </span>
      </div>
      <p>
        <strong>{pipeline.briefingsServed.toLocaleString()} briefing{pl(pipeline.briefingsServed)} served</strong>{' '}
        in the last {windowDays} days — counted from stored briefing records.
      </p>
      <p>
        Each briefing is retrieved per task, query-scoped to the project and path, and capped at{' '}
        {settings.briefingMaxTokens.toLocaleString()} tokens (user-set, 200–8,000). Items whose file
        citations changed are quarantined at retrieval, before injection.
      </p>
      <p>
        A launch that carries no initial prompt has nothing to rank against, so retrieval admits only
        standing artifacts — mission-kind items. Project- and path-scoped knowledge is not swept in,
        so such a launch can receive no briefing at all.
      </p>
      {pending.length > 0 && (
        <p className="faint">
          {estTokens(pendingEst)} across {pending.length} pending proposal{pl(pending.length)} (bytes÷4 heuristic) — decided in the Inbox.
        </p>
      )}
      <button className="btn" onClick={() => onNavigate('optimize')}>Inspect a briefing in Optimize</button>
    </article>
  );
}

function NeedsAttention({ overview, settings, candidates, onNavigate }: {
  overview: LearningOverview;
  settings: LearningSettings;
  candidates: KnowledgeCandidate[];
  onNavigate: (tab: LearningTab) => void;
}) {
  const pending = candidates.filter((c) => c.status === 'pending');
  const oldest = pending.length ? Math.min(...pending.map((c) => c.createdAt)) : null;
  const rows: { key: string; ok: boolean; word: string; text: string; tab: LearningTab; action: string }[] = [
    overview.quarantined > 0
      ? { key: 'q', ok: false, word: `${overview.quarantined} quarantined`,
          text: `${overview.quarantined} knowledge item${pl(overview.quarantined)} ${overview.quarantined === 1 ? 'is' : 'are'} excluded from every briefing until re-validated.`,
          tab: 'knowledge', action: 'Open Knowledge' }
      : { key: 'q', ok: true, word: 'none quarantined',
          text: 'Every active knowledge item is eligible for briefings.', tab: 'knowledge', action: 'Open Knowledge' },
    pending.length > 0
      ? { key: 'p', ok: false, word: `${pending.length} waiting`,
          text: pending.length === 1
            ? `1 proposal waits in the Inbox — it has waited ${fmtDur(Date.now() - (oldest ?? Date.now()))}. Evidence waits for your decision.`
            : `${pending.length} proposals wait in the Inbox — the oldest has waited ${fmtDur(Date.now() - (oldest ?? Date.now()))}. Evidence waits for your decision.`,
          tab: 'inbox', action: 'Open Inbox' }
      : { key: 'p', ok: true, word: 'inbox clear',
          text: 'Nothing waits for a decision.', tab: 'inbox', action: 'Open Inbox' },
    settings.enabled
      ? { key: 'e', ok: true, word: 'learning on',
          text: 'Signals are recorded and briefings are served at session launch.', tab: 'optimize', action: 'Open Optimize' }
      : { key: 'e', ok: false, word: 'learning paused',
          text: 'No new signals are recorded and no briefings are served while learning is off.',
          tab: 'optimize', action: 'Open Optimize' },
  ];
  return (
    <section className="card learning-card">
      <div className="learning-card-head">
        <div><span className="label">Needs attention</span><h2>Observed states, not a score</h2></div>
      </div>
      <div className="attention-list">
        {rows.map((r) => (
          <div key={r.key} className={`attention-row ${r.ok ? 'ok' : 'warn'}`}>
            <span className="attention-mark"><span aria-hidden="true">{r.ok ? '✓' : '⚠'}</span> {r.word}</span>
            <p>{r.text}</p>
            <button className="btn" onClick={() => onNavigate(r.tab)}>{r.action}</button>
          </div>
        ))}
      </div>
    </section>
  );
}

/** The hybrid gate is real code, and no session-derived candidate can satisfy
 * it. An armed-looking switch here would imply a capability this build does not
 * have, so the state is written out as text instead. */
function AutoPromotion({ pipeline, windowDays, onNavigate }: {
  pipeline: LearningPipelineStats;
  windowDays: number;
  onNavigate: (tab: LearningTab, inboxStatus?: string) => void;
}) {
  return (
    <section className="card learning-card">
      <div className="learning-card-head">
        <div><span className="label">Automatic promotion</span><h2>Cannot fire for session-derived signals</h2></div>
        <span className="learning-status muted">○ inert</span>
      </div>
      <p>
        The single automatic lane admits reversible personal memory and nothing else. Every session
        signal carries the project it was recorded in, so a candidate consolidated from session
        evidence resolves to project or path scope and arrives in the Inbox for your decision.
      </p>
      <ul className="learning-checks">
        <li><span aria-hidden="true">·</span> Consolidation refuses to promote when project-attributed evidence produced a personal-scope candidate — it declines rather than re-scoping.</li>
        <li><span aria-hidden="true">·</span> Machine-derived confidence is capped below the gate’s minimum by construction, so no amount of repetition carries a derived claim through.</li>
        <li><span aria-hidden="true">·</span> Project and path artifacts, skills, instructions, rules, gates, missions, maps, and evals always require approval. “Teach Wanigan” also creates a proposal; it never applies itself.</li>
      </ul>
      <p className="faint">
        {pipeline.autoPromoted > 0
          ? `Observed: ${pipeline.autoPromoted.toLocaleString()} candidate${pl(pipeline.autoPromoted)} auto-applied in the last ${windowDays} days.`
          : `Observed: no candidate was auto-applied in the last ${windowDays} days.`}
        {' '}Counted from stored candidate rows.{' '}
        <button className="learning-link" onClick={() => onNavigate('inbox', 'open')}>Open the Inbox</button>{' '}
        to read the exact gate checks on any proposal.
      </p>
    </section>
  );
}

/** Linked from the tab strip. The nonce opens it and scrolls it into view, so a
 * term can be looked up from any tab without hunting for the section. */
function Glossary({ openNonce }: { openNonce: number }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLElement | null>(null);
  useEffect(() => {
    // Consume-once across remounts, the same way the Context deep link is:
    // returning to Overview later must not replay a jump already made.
    if (openNonce === 0 || openNonce === consumedGlossaryNonce) return;
    consumedGlossaryNonce = openNonce;
    setOpen(true);
    // Scroll after the expanded list has laid out; scrolling in this tick lands
    // on where the collapsed header was.
    const frame = requestAnimationFrame(() => ref.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
    return () => cancelAnimationFrame(frame);
  }, [openNonce]);
  return (
    <section className="card learning-card" id="learning-glossary" ref={ref}>
      <button className="drawer-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {open ? '▾' : '▸'} Glossary — every word this workspace uses, defined once
      </button>
      {open && (
        <>
          <dl className="glossary-list">
            {GLOSSARY.map((entry) => (
              <div key={entry.term}>
                <dt>{entry.term}</dt>
                <dd>{entry.body}</dd>
              </div>
            ))}
          </dl>
          <p className="faint">
            These are the terms the tabs and cards above use. Nothing here is a setting — it is what
            the words mean in this app.
          </p>
        </>
      )}
    </section>
  );
}

function PrivacyCard() {
  return (
    <article className="card learning-card">
      <div className="learning-card-head">
        <div><span className="label">Privacy boundary</span><h2>Local, same-backend content</h2></div>
        <span className="learning-status good">⌂ local</span>
      </div>
      <p>
        Operational outcomes can improve every adapter. Semantic content is eligible only on this
        machine and only for the frozen model backend that produced it — changing a profile’s backend
        cannot broaden access. Consolidation reads bounded signals and explicit teaching, never
        copied transcripts.
      </p>
      <ul className="learning-checks">
        <li><span>✓</span> No raw cross-provider transcript sharing</li>
        <li><span>✓</span> Consolidation is deterministic and makes no model call</li>
        <li><span>✓</span> Project rules, skills, hooks, and settings always require approval</li>
        <li><span>✓</span> Codex-owned generated memories remain read-only</li>
      </ul>
    </article>
  );
}

/* ── Providers · packs & harnesses (moved from Overview, unchanged) ────── */

function Providers({ packs, providers, busy, act }: {
  packs: ProviderPackInfo[];
  providers: ProviderInfo[];
  busy: string | null;
  act: Act;
}) {
  return (
    <div className="learning-stack">
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
  onRun: (fn: () => Promise<unknown>) => Promise<boolean>;
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
    const ok = await onRun(() => window.wanigan.learning.teach({
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
    if (!ok) return; // a failed teach keeps the modal and the typed knowledge
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

/* ── Inbox ─────────────────────────────────────────────────────────────── */

const DECIDED_STATUSES = ['approved', 'rejected', 'promoted', 'applied', 'superseded'];

function Inbox({ candidates, signals, providers, busy, act, initialStatus, scoped, onShowAll, emptyFrame }: {
  candidates: KnowledgeCandidate[];
  signals: LearningSignal[];
  providers: ProviderInfo[];
  busy: string | null;
  act: Act;
  /** Filter carried by a funnel click; the nonce key re-applies repeat clicks. */
  initialStatus: { status: string; key: number } | null;
  /** True when the Learning scope is narrower than Everything. */
  scoped: boolean;
  /** Widens the Learning scope to Everything. */
  onShowAll: () => void;
  emptyFrame: string;
}) {
  const [status, setStatus] = useState(initialStatus?.status ?? 'open');
  useEffect(() => { if (initialStatus) setStatus(initialStatus.status); }, [initialStatus]);
  const visible = candidates.filter((c) => status === 'all'
    || (status === 'open' ? ['pending', 'approved', 'snoozed', 'failed'].includes(c.status)
      : status === 'decided' ? DECIDED_STATUSES.includes(c.status)
      : c.status === status));

  // A narrow scope must never impersonate an empty engine: with nothing open in
  // this scope, one all-scope probe (no projectId key) checks for proposals elsewhere.
  const openEmpty = !candidates.some((c) => ['pending', 'approved', 'snoozed', 'failed'].includes(c.status));
  const [elsewhere, setElsewhere] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setElsewhere(false);
    if (!scoped || !openEmpty) return;
    window.wanigan.learning.candidates({ status: ['pending', 'approved', 'snoozed'], limit: 1 })
      .then((rows) => { if (!cancelled) setElsewhere(rows.length > 0); })
      .catch(() => { /* the hint is best-effort; the stamped frame still tells the truth */ });
    return () => { cancelled = true; };
  }, [scoped, openEmpty, candidates]);
  const elsewhereHint = elsewhere
    ? <button className="learning-link" onClick={onShowAll}>Proposals exist outside this scope — switch to Everything</button>
    : null;

  const decided = useMemo(() => candidates
    .filter((c) => c.reviewedAt != null)
    .sort((a, b) => (b.reviewedAt ?? 0) - (a.reviewedAt ?? 0))
    .slice(0, 20), [candidates]);
  const approvedN = decided.filter((c) => ['approved', 'promoted', 'applied'].includes(c.status)).length;
  const rejectedN = decided.filter((c) => c.status === 'rejected').length;
  const otherN = decided.length - approvedN - rejectedN;
  const median = useMemo(() => {
    const times = decided.map((c) => (c.reviewedAt ?? 0) - c.createdAt).filter((t) => t >= 0).sort((a, b) => a - b);
    return times.length ? times[Math.floor(times.length / 2)] : null;
  }, [decided]);
  const historyLine = useMemo(() => {
    if (decided.length === 0) return null;
    if (decided.length === 1) {
      const c = decided[0];
      const outcome = ['approved', 'promoted', 'applied'].includes(c.status) ? 'approved'
        : c.status === 'rejected' ? 'rejected' : c.status;
      const t = Math.max(0, (c.reviewedAt ?? 0) - c.createdAt);
      return `Last decision: ${outcome} · decided in ${t < 60_000 ? 'under 1 min' : fmtDur(t)}`;
    }
    const parts = [
      approvedN > 0 ? `${approvedN} approved` : null,
      rejectedN > 0 ? `${rejectedN} rejected` : null,
      otherN > 0 ? `${otherN} other` : null,
    ].filter(Boolean).join(' · ');
    const typical = decided.length >= 3 && median !== null
      ? ` · typical time to decision ${median < 60_000 ? 'under 1 min' : fmtDur(median)} (median)`
      : '';
    return `Last ${decided.length} decisions: ${parts}${typical}`;
  }, [decided, approvedN, rejectedN, otherN, median]);

  return (
    <div className="learning-stack">
      <section className="learning-toolbar card">
        <div><span className="label">Learning Inbox</span><strong>{visible.length} proposal{pl(visible.length)}</strong></div>
        {historyLine && <small className="inbox-history-line" title="Counted from stored candidate reviews.">{historyLine}</small>}
        <label><span className="label">Status</span><select className="field" value={status} onChange={(e) => setStatus(e.target.value)}><option value="open">Needs a decision</option><option value="decided">Decided</option><option value="pending">Pending</option><option value="approved">Approved</option><option value="snoozed">Snoozed</option><option value="rejected">Rejected</option><option value="promoted">Promoted</option><option value="applied">Applied</option><option value="all">All</option></select></label>
      </section>
      {visible.length === 0 && (candidates.length === 0
        ? <Empty title="No proposals have ever been created in this scope"
                 body="Run a session — tool activity records signals, and repeats across independent tasks become proposals here. Teach Wanigan directly for an immediate proposal, or run a review gate."
                 frame={emptyFrame}>{elsewhereHint}</Empty>
        : status === 'open'
          ? <Empty title="The Inbox is clear" body="Nothing needs a decision in this scope. Decided proposals stay reachable through the status filter."
                   frame={emptyFrame}>{elsewhereHint}</Empty>
          : <Empty title="No proposals match this filter" body="Proposals exist in other states — another status filter will show them."
                   frame={emptyFrame} />)}
      <div className="candidate-list">
        {visible.map((candidate) => <CandidateCard key={candidate.id} candidate={candidate} providers={providers} busy={busy} act={act} />)}
      </div>
      {candidates.length === 100 && (
        <p className="faint">Showing the newest 100 proposals — older ones are not listed here.</p>
      )}
      <section className="card learning-card">
        <div className="learning-card-head"><div><span className="label">Recent evidence stream</span><h2>Operational signals</h2></div><span className="learning-status muted">content bounded</span></div>
        {signals.length === 0
          ? <Empty title="No learning signals have been recorded for this scope yet"
                   body="Tool activity in a session records them." frame={emptyFrame} />
          : (
            <div className="signal-list">
              {signals.slice(0, 20).map((signal) => <div key={signal.id}><span className="mono">{signal.kind}</span><strong>{signal.summary}{signal.detail['summaryRedacted'] === true && <span className="mini-badge">redacted</span>}</strong><small>{signal.providerId ?? 'provider-neutral'} · {when(signal.createdAt)} · {signal.semanticEligible ? 'same-provider eligible' : 'operational only'}</small></div>)}
            </div>
          )}
        {signals.length > 20 && (
          <p className="faint">Showing the newest 20 of {signals.length === 80 ? 'at least 80' : signals.length} signals — older ones are not listed here.</p>
        )}
      </section>
    </div>
  );
}

const REJECT_REASONS = ['Wrong', 'Duplicate', "True but don't store", 'Too broad'];

function CandidateCard({ candidate, providers, busy, act }: {
  candidate: KnowledgeCandidate;
  providers: ProviderInfo[];
  busy: string | null;
  act: Act;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(candidate.title);
  const [text, setText] = useState(candidate.proposedText);
  const [target, setTarget] = useState(candidate.providerId ?? providers[0]?.id ?? 'claude');
  const [whyOpen, setWhyOpen] = useState(false);
  const [why, setWhy] = useState<CandidateExplanation | null>(null);
  const [whyErr, setWhyErr] = useState<string | null>(null);
  const [evOpen, setEvOpen] = useState(false);
  const [ev, setEv] = useState<LearningSignal[] | null>(null);
  const [evErr, setEvErr] = useState<string | null>(null);
  const key = `candidate-${candidate.id}`;
  const undecided = ['pending', 'snoozed'].includes(candidate.status);

  const toggleWhy = () => {
    const next = !whyOpen;
    setWhyOpen(next);
    if (next && !why && !whyErr) {
      window.wanigan.learning.candidateExplain(candidate.id)
        .then(setWhy).catch((e) => setWhyErr(message(e)));
    }
  };
  const toggleEv = () => {
    const next = !evOpen;
    setEvOpen(next);
    if (next && !ev && !evErr) {
      window.wanigan.learning.candidateSignals(candidate.id)
        .then(setEv).catch((e) => setEvErr(message(e)));
    }
  };

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
      {/* Observed facts lead; the rule-derived confidence heuristic is secondary. */}
      <div className="candidate-proof">
        <span><b>{candidate.evidenceCount}</b> observation{pl(candidate.evidenceCount)}</span>
        <span><b>{candidate.taskCount}</b> independent task{pl(candidate.taskCount)}</span>
        <span><b>{estTokens(candidate.estimatedTokenDelta)}</b> projected · bytes÷4</span>
        <span><b>{ruleConf(candidate.confidence)}</b> confidence · rule-derived</span>
      </div>
      <p className="candidate-rationale">{candidate.rationale}</p>
      {undecided && (
        <button className="drawer-toggle" aria-expanded={whyOpen} onClick={toggleWhy}>
          {whyOpen ? '▾' : '▸'} Why this needs review
        </button>
      )}
      {undecided && whyOpen && (
        why ? (
          <div className="why-panel">
            <p><strong>{why.decision}</strong> — {why.reason}</p>
            <div className="why-checks">
              {why.checks.map((c) => (
                <div key={c.label} className={c.ok ? 'ok' : 'off'}>
                  <span aria-hidden="true">{c.ok ? '✓' : '·'}</span>
                  <span>{c.label}</span>
                  <span className="mono">{c.actual} <em>(required {c.required})</em></span>
                </div>
              ))}
            </div>
            <p className="faint">The automation gate is deterministic — these checks are the whole decision.</p>
          </div>
        ) : whyErr
          ? <p className="learning-status bad">✕ {whyErr}</p>
          : <p className="faint">Reading the gate decision…</p>
      )}
      <button className="drawer-toggle" aria-expanded={evOpen} onClick={toggleEv}>
        {evOpen ? '▾' : '▸'} Evidence ({candidate.evidenceCount})
      </button>
      {evOpen && (
        ev ? (
          <div className="evidence-drawer">
            <p className="faint">
              {candidate.evidenceCount} distinct observation{pl(candidate.evidenceCount)} across {candidate.taskCount} independent
              task{pl(candidate.taskCount)} — signals are content-hash deduplicated, so these are distinct observations, not raw repeats.
            </p>
            <div className="signal-list">
              {ev.map((s) => (
                <div key={s.id}>
                  <span className="mono">{s.kind}</span>
                  <strong>{s.summary}{s.detail['summaryRedacted'] === true && <span className="mini-badge">redacted</span>}</strong>
                  <small>{s.sessionId ? <>session <span className="mono">{s.sessionId.slice(0, 8)}…</span> · </> : null}{ago(s.createdAt)}</small>
                </div>
              ))}
              {ev.length === 0 && <p className="faint">No stored signals are linked to this proposal — a direct teaching carries its own citation instead.</p>}
            </div>
          </div>
        ) : evErr
          ? <p className="learning-status bad">✕ {evErr}</p>
          : <p className="faint">Reading the stored signals…</p>
      )}
      {editing ? <textarea className="field mono" rows={9} value={text} onChange={(e) => setText(e.target.value)} /> : <pre className="candidate-patch">{candidate.proposedText}</pre>}
      {candidate.conflicts.length > 0 && <div className="candidate-conflicts"><strong>Conflicts to resolve</strong>{candidate.conflicts.map((c) => <p key={`${c.itemId}-${c.relation}`}>{c.relation}: {c.title} — {c.reason}</p>)}</div>}
      <div className="candidate-targets">
        <div><span className="label">Provider targets</span><select className="field" value={target} onChange={(e) => setTarget(e.target.value)}>{providers.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select></div>
        <p><span className="label">Activation</span><br />Canonical after approval; written to the selected provider only after Apply. New sessions see it after validation.</p>
      </div>
      <div className="learning-actions">
        {editing ? <><button className="btn btn-primary" disabled={busy !== null || !title.trim() || !text.trim()} onClick={() => void save()}>Save edit</button><button className="btn" onClick={() => setEditing(false)}>Cancel</button></>
          : <button className="btn" disabled={busy !== null || !undecided} onClick={() => setEditing(true)}>Edit</button>}
        {candidate.status !== 'promoted' && candidate.status !== 'applied' && <button className="btn btn-primary" disabled={busy !== null || candidate.conflicts.length > 0} onClick={() => void approve()}>{busy === key ? 'Working…' : 'Approve to knowledge'}</button>}
        {['instruction', 'rule', 'skill'].includes(candidate.targetKind) && ['approved', 'promoted'].includes(candidate.status) && <button className="btn btn-primary" disabled={busy !== null || !target} onClick={() => void act(key, () => window.wanigan.learning.applyCandidate(candidate.id, target), 'Validated and applied. The exact prior content is available for Undo.')}>Apply to {providers.find((p) => p.id === target)?.label ?? target}</button>}
        <button className="btn" disabled={busy !== null || candidate.status === 'snoozed'} onClick={() => void act(key, () => window.wanigan.learning.reviewCandidate(candidate.id, 'snooze'), 'Proposal snoozed; its evidence remains.')}>Snooze</button>
        <button className="btn btn-danger" disabled={busy !== null || candidate.status === 'rejected'} onClick={() => void act(key, () => window.wanigan.learning.reviewCandidate(candidate.id, 'reject'), 'Proposal rejected; the decision remains in its audit history.')}>Reject</button>
        {['rejected', 'snoozed'].includes(candidate.status) && (
          <button className="btn" disabled={busy !== null} onClick={() => void act(key, () => window.wanigan.learning.reviewCandidate(candidate.id, 'reopen'), 'Proposal reopened for a fresh decision; its evidence and review history remain.')}>Reopen</button>
        )}
      </div>
      {undecided && (
        <div className="reject-chips">
          <span className="label">Reject as</span>
          {REJECT_REASONS.map((reason) => (
            <button key={reason} className="chip" disabled={busy !== null}
                    onClick={() => void act(key, () => window.wanigan.learning.reviewCandidate(candidate.id, 'reject', reason),
                      `Rejected as “${reason}”; the decision remains in its audit history.`)}>
              {reason}
            </button>
          ))}
        </div>
      )}
    </article>
  );
}

/* ── Knowledge ─────────────────────────────────────────────────────────── */

const K_MARK: Record<KnowledgeStatus, { glyph: string; word: string; color: string }> = {
  active:      { glyph: '●', word: 'active',      color: 'var(--good)' },
  quarantined: { glyph: '⚠', word: 'quarantined', color: 'var(--warning)' },
  retired:     { glyph: '·', word: 'retired',     color: 'var(--text-faint)' },
};

const REL_MARK: Record<KnowledgeRelation['relation'], { glyph: string; color: string }> = {
  supports:    { glyph: '＋', color: 'var(--good)' },
  contradicts: { glyph: '≠', color: 'var(--serious)' },
  supersedes:  { glyph: '↦', color: 'var(--text-dim)' },
  duplicates:  { glyph: '≡', color: 'var(--warning)' },
};

const FRESH_GLYPH: Record<string, string> = {
  missing: '✕', changed: 'Δ', 'outside-root': '⊘', unverifiable: '?',
};

function KMark({ status }: { status: KnowledgeStatus }) {
  const m = K_MARK[status];
  return <span className="knowledge-mark" style={{ color: m.color }}><span aria-hidden="true">{m.glyph}</span> {m.word}</span>;
}

function Knowledge({ items, signals, project, scopeParam, emptyFrame, busy, act, refreshTick }: {
  items: KnowledgeItem[];
  signals: LearningSignal[];
  /** For the by-path grouping's hero; null under Personal-only scope. */
  project: Project | null;
  scopeParam: string | null | undefined;
  emptyFrame: string;
  busy: string | null;
  act: Act;
  /** Bumped by every successful act() and every learningChanged push. */
  refreshTick: number;
}) {
  const [grouping, setGrouping] = useState<'list' | 'path'>('list');
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | KnowledgeStatus>('all');
  const [onlyUnsynthesized, setOnlyUnsynthesized] = useState(false);
  // Ids, not items: the picked rows are re-read from the reloaded list so a
  // selection can never act on a stale snapshot of an item.
  const [picked, setPicked] = useState<string[]>([]);
  const [retiring, setRetiring] = useState<KnowledgeItem[] | null>(null);
  const [results, setResults] = useState<KnowledgeItem[] | null>(null);
  const [selected, setSelected] = useState<KnowledgeItem | null>(null);
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof window.wanigan.learning.item>> | null>(null);
  const [relations, setRelations] = useState<KnowledgeRelation[] | null>(null);
  const [freshness, setFreshness] = useState<FreshnessReport | null>(null);
  const [freshBusy, setFreshBusy] = useState(false);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  // Monotonic fetch id: a stale response (selection switched) is dropped.
  const seq = useRef(0);
  const search = async () => {
    if (!query.trim()) { setResults(null); return; }
    const found = await window.wanigan.learning.search(query.trim(), { projectId: scopeParam, limit: 80 });
    setResults(found.map((r) => r.item));
  };
  /** Fetches detail + relations through the seq guard without clearing what is
   * on screen, so a background refresh never flashes the pane empty. */
  const refetch = useCallback(async (itemId: string) => {
    const mine = ++seq.current;
    try {
      const [d, rel] = await Promise.all([
        window.wanigan.learning.item(itemId),
        window.wanigan.learning.relations(itemId),
      ]);
      if (seq.current !== mine) return;
      setDetail(d); setRelations(rel); setDetailErr(null);
    } catch (e) {
      if (seq.current !== mine) return;
      setDetailErr(message(e));
    }
  }, []);
  const choose = (item: KnowledgeItem) => {
    setSelected(item); setDetail(null); setRelations(null); setFreshness(null); setFreshBusy(false); setDetailErr(null);
    void refetch(item.id);
  };
  // After any successful act() or a learningChanged push, silently re-read the
  // open item so Undo, status, and versions stay truthful without a reselect.
  // Deliberately keyed on refreshTick alone: selection changes fetch via choose().
  useEffect(() => {
    const id = selected?.id;
    if (!id) return;
    void refetch(id);
  }, [refreshTick]); // eslint-disable-line react-hooks/exhaustive-deps
  const recheck = async () => {
    if (!selected) return;
    const mine = ++seq.current; // a later choose() invalidates this check too
    setFreshBusy(true);
    try {
      const report = await window.wanigan.learning.freshness(selected.id);
      if (seq.current !== mine) return;
      setFreshness(report);
    } catch (e) {
      if (seq.current !== mine) return;
      setDetailErr(message(e));
    } finally {
      if (seq.current === mine) setFreshBusy(false);
    }
  };
  const titleOf = (id: string) => items.find((i) => i.id === id)?.title ?? id;
  const listed = results ?? items;
  // Retirement is the point of the count, so it counts what is still injectable:
  // a retired item in the same shape is already out of circulation.
  const activeListed = listed.filter((item) => item.status === 'active');
  const unsynthesized = activeListed.filter((item) => unsynthesizedMark(item.title, item.canonicalText) !== null);
  const visible = listed.filter((item) =>
    (statusFilter === 'all' || item.status === statusFilter)
    && (!onlyUnsynthesized || unsynthesizedMark(item.title, item.canonicalText) !== null));
  const pickedItems = picked
    .map((id) => items.find((item) => item.id === id))
    .filter((item): item is KnowledgeItem => item !== undefined);
  const toggle = (id: string, on: boolean) =>
    setPicked((old) => on ? (old.includes(id) ? old : [...old, id]) : old.filter((other) => other !== id));

  /** One reason, however many items. Each call is a separate IPC, so one
   * failure must not hide the retirements that did land: failures are reported
   * beside the count instead of replacing it. act() reloads the list and
   * re-reads the pipeline, so no count on this page can lag the change. */
  const retire = async (reason: string, targets: KnowledgeItem[]) => {
    const ok = await act('retire', async () => {
      const failures: string[] = [];
      let retired = 0;
      for (const item of targets) {
        try {
          await window.wanigan.learning.retireItem(item.id, reason);
          retired++;
        } catch (e) {
          failures.push(`“${item.title}”: ${message(e)}`);
        }
      }
      // Nothing changed: that is an error, not a partial success.
      if (retired === 0) throw new Error(`Nothing was retired. ${failures.join(' · ')}`);
      return { retired, failures };
    }, (result) => {
      const r = result as { retired: number; failures: string[] };
      const done = `${r.retired} item${pl(r.retired)} retired — a status change, not a deletion. `
        + 'Their versions, citations, and projections are kept; they stop being retrieved and stop being injected.';
      return r.failures.length ? `${done} ${r.failures.length} could not be retired: ${r.failures.join(' · ')}` : done;
    });
    if (!ok) return; // a failed call keeps the dialog and the typed reason
    setRetiring(null);
    setPicked([]);
  };
  // The reloaded list is fresher than the click-time snapshot: status and text
  // shown in the detail header follow it, not the stale selection object.
  const sel = selected ? items.find((i) => i.id === selected.id) ?? selected : null;
  return (
    <div className="learning-split">
      <section className="learning-list-pane">
        <div className="knowledge-groupbar card" role="group" aria-label="Group knowledge">
          <span className="label">Group</span>
          <div className="learning-seg">
            <button type="button" aria-pressed={grouping === 'list'} onClick={() => setGrouping('list')}>List</button>
            <button type="button" aria-pressed={grouping === 'path'} onClick={() => { setGrouping('path'); setPicked([]); }}>By path</button>
          </div>
        </div>
        {grouping === 'path' ? (
          <ProjectMap project={project} items={items} signals={signals} onSelect={(item) => void choose(item)} />
        ) : (
          <>
            <div className="learning-search card"><input className="field" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void search(); }} placeholder="Search canonical knowledge and path scopes…" /><button className="btn" onClick={() => void search()}>Search</button></div>
            <div className="knowledge-filterbar card">
              <label className="knowledge-filter-status">
                <span className="label">Status</span>
                <select className="field" value={statusFilter}
                        onChange={(e) => setStatusFilter(e.target.value as 'all' | KnowledgeStatus)}>
                  <option value="all">All statuses</option>
                  <option value="active">Active</option>
                  <option value="quarantined">Quarantined</option>
                  <option value="retired">Retired</option>
                </select>
              </label>
              <label className="learning-check">
                <input type="checkbox" checked={onlyUnsynthesized}
                       onChange={(e) => setOnlyUnsynthesized(e.target.checked)} />
                {' '}Only text identical to title, or a bare path
              </label>
              {/* An observed property of the stored row, stated plainly. No
                  score is derived from it and none is shown. */}
              <p className="faint">
                {unsynthesized.length > 0
                  ? <>
                      {unsynthesized.length} of {activeListed.length} active item{pl(activeListed.length)}{' '}
                      {results ? 'in these search results' : 'in this scope'}{' '}
                      {unsynthesized.length === 1 ? 'has' : 'have'} canonical text identical to the title, or text
                      that is only a filesystem path. Retrieval refuses to inject an item in either shape.{' '}
                      <button className="learning-link"
                              onClick={() => setPicked(unsynthesized.map((item) => item.id))}>
                        Select {unsynthesized.length === 1 ? 'it' : `all ${unsynthesized.length}`}
                      </button>
                    </>
                  : <>No active item {results ? 'in these search results' : 'in this scope'} has canonical text identical to its title, or text that is only a filesystem path.</>}
              </p>
            </div>
            {pickedItems.length > 0 && (
              <div className="knowledge-bulkbar card">
                <strong>{pickedItems.length} selected</strong>
                <button className="btn btn-danger" disabled={busy !== null}
                        onClick={() => setRetiring(pickedItems)}>
                  Retire selected…
                </button>
                <button className="btn" onClick={() => setPicked([])}>Clear selection</button>
                <small className="faint">The selection follows the items, not the filters above.</small>
              </div>
            )}
            {results && results.length === 0
              ? <Empty title="This search matched nothing"
                       body="Search reads the full-text index, and only active items are indexed — a retired or quarantined item will not appear here even when it exists."
                       frame={emptyFrame} />
              : items.length === 0
                ? <Empty title="No canonical knowledge yet" body="Approve an Inbox proposal to create the first versioned item." frame={emptyFrame} />
                : visible.length === 0
                  ? <Empty title="No item matches these filters"
                           body="Items exist in this scope; the status filter or the text filter above is hiding all of them."
                           frame={emptyFrame} />
                  : null}
            {visible.map((item) => {
              const mark = unsynthesizedMark(item.title, item.canonicalText);
              return (
                <div key={item.id} className="knowledge-row-wrap">
                  <input type="checkbox" className="knowledge-pick" checked={picked.includes(item.id)}
                         aria-label={`Select “${item.title}” to retire`}
                         onChange={(e) => toggle(item.id, e.target.checked)} />
                  <button className={`knowledge-row card ${selected?.id === item.id ? 'on' : ''}`} onClick={() => void choose(item)}>
                    <span className="label">{item.kind} · {item.scope}</span>
                    <strong>{item.title}</strong>
                    <p>{item.canonicalText.slice(0, 170)}</p>
                    {mark && <span className="mini-badge">{mark}</span>}
                    <small>
                      <KMark status={item.status} /> · v{item.currentVersion} · {item.sourceCount} source{pl(item.sourceCount)} ·
                      confidence {ruleConf(item.confidence)} rule-derived · {item.lastValidatedAt ? `checked ${ago(item.lastValidatedAt)}` : 'never validated'}
                    </small>
                  </button>
                </div>
              );
            })}
            {!results && items.length === 200 && (
              <p className="faint">Showing the newest 200 items — older ones are not listed here.</p>
            )}
          </>
        )}
      </section>
      <aside className="learning-detail card">
        {!sel ? <Empty title="Select a knowledge item" body="Its full text, evidence, versions, relations, freshness, projections, and measured ROI will appear here." />
          : detailErr && !detail ? (
            <>
              <span className="learning-status bad">✕ read failed</span>
              <p>{detailErr}</p>
              <button className="btn" onClick={() => choose(sel)}>Retry</button>
            </>
          ) : !detail ? <p className="faint">Reading the item…</p> : <>
          <div className="learning-card-head">
            <div><span className="label">{sel.kind} · {sel.scope}</span><h2>{sel.title}</h2></div>
            <KMark status={sel.status} />
          </div>
          <pre className="candidate-patch">{sel.canonicalText}</pre>
          {unsynthesizedMark(sel.title, sel.canonicalText) && (
            <p className="faint">
              Observed: {unsynthesizedMark(sel.title, sel.canonicalText)}. Retrieval refuses to inject an item
              in this shape — it spends tokens without stating anything a session can act on. That is a
              property of the stored text, not a judgement about its subject.
            </p>
          )}
          <div className="detail-stats"><span><b>{detail.versions.length}</b> version{pl(detail.versions.length)}</span><span><b>{detail.evidence.length}</b> citation{pl(detail.evidence.length)}</span><span><b>{detail.projections.length}</b> projection{pl(detail.projections.length)}</span><span><b>{detail.roi.samples}</b> ROI sample{pl(detail.roi.samples)}</span></div>
          {detailErr && <p className="learning-status bad">✕ {detailErr}</p>}

          <div className="learning-actions">
            <button className="btn btn-danger" disabled={busy !== null || sel.status === 'retired'}
                    onClick={() => setRetiring([sel])}>
              {sel.status === 'retired' ? 'Already retired' : 'Retire this item…'}
            </button>
            <span className="faint">
              {sel.status === 'retired'
                ? 'Retired: kept in full, no longer retrieved or injected.'
                : 'A status change, not a deletion — versions, citations, and projections are kept.'}
            </span>
          </div>

          <h3>Evidence</h3>
          <div className="evidence-list">{detail.evidence.map((e) => <div key={e.id}><strong>{e.citation}</strong><small>{e.sourceType} · {when(e.observedAt)} · weight {e.weight}</small></div>)}{detail.evidence.length === 0 && <p className="faint">No evidence rows are attached.</p>}</div>
          {detail.evidence.length === 200 && <p className="faint">Showing the newest 200 citations — older ones are not listed here.</p>}

          <h3>Version history</h3>
          <div className="evidence-list">
            {[...detail.versions].sort((a, b) => b.version - a.version).map((v) => (
              <div key={v.id}>
                <strong><span className="mono">v{v.version}</span> · {v.createdBy}</strong>
                <small>{ago(v.createdAt)}{v.previousVersionId ? '' : ' · first version'}</small>
              </div>
            ))}
            {detail.versions.length === 0 && <p className="faint">No versions are recorded.</p>}
          </div>
          {detail.versions.length === 50 && <p className="faint">Showing the newest 50 versions — older versions are not listed here.</p>}

          {relations && relations.length > 0 && (
            <>
              <h3>Relations</h3>
              <div className="evidence-list">
                {relations.map((r) => {
                  const m = REL_MARK[r.relation];
                  const fromThis = r.fromItemId === sel.id;
                  const other = titleOf(fromThis ? r.toItemId : r.fromItemId);
                  const reason = typeof r.evidence['reason'] === 'string' ? r.evidence['reason'] : null;
                  return (
                    <div key={`${r.fromItemId}-${r.relation}-${r.toItemId}`}>
                      <strong>
                        <span aria-hidden="true" style={{ color: m.color }}>{m.glyph}</span>{' '}
                        {fromThis ? `this item ${r.relation} “${other}”` : `“${other}” ${r.relation} this item`}
                      </strong>
                      <small>
                        {r.resolvedAt ? `✓ resolved ${ago(r.resolvedAt)}` : '· unresolved'}
                        {reason ? ` — ${reason}` : ''} · confidence {ruleConf(r.confidence)} rule-derived
                      </small>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          <h3>Freshness</h3>
          <div className="learning-actions">
            <button className="btn" disabled={freshBusy} onClick={() => void recheck()}>
              {freshBusy ? 'Checking…' : 'Re-check citations now'}
            </button>
            <span className="faint">Report-only: checking never changes the item’s status.</span>
          </div>
          {freshness && (freshness.fresh
            ? (freshness.checked > 0
              ? <p className="learning-status good">
                  ✓ {freshness.checked} file-backed citation{pl(freshness.checked)} verified just now
                  {freshness.skipped > 0 ? `; ${freshness.skipped} not file-backed — carried, not checkable` : ''}
                </p>
              : <p className="faint">No file-backed citations to verify — nothing was checked.</p>)
            : (
              <>
                <div className="evidence-list">
                  {freshness.issues.map((issue) => (
                    <div key={issue.evidenceId}>
                      <strong><span aria-hidden="true">{FRESH_GLYPH[issue.kind] ?? '·'}</span> {issue.kind} · <span className="mono">{issue.sourceId}</span></strong>
                      <small>{issue.detail}</small>
                    </div>
                  ))}
                </div>
                <p className="faint">
                  Retrieval quarantines stale-cited items before injection — this is why the item may
                  be excluded from briefings until its citations are re-validated.
                </p>
              </>
            ))}

          <h3>Projection history</h3>
          <div className="evidence-list">{detail.projections.map((p) => <div key={p.id}><strong>{p.providerId} → <span className="mono">{p.targetPath}</span></strong><small>{p.status} · {when(p.appliedAt ?? p.createdAt)}</small>{p.status === 'applied' && <button className="btn" disabled={busy !== null} onClick={() => void act(`undo-${p.id}`, () => window.wanigan.learning.undoProjection(p.id), 'Projection undone because the applied hash still matched. Canonical knowledge remains.')}>Undo</button>}</div>)}{detail.projections.length === 0 && <p className="faint">No projections were written for this item.</p>}</div>
          {detail.projections.length === 100 && <p className="faint">Showing the newest 100 projections — older ones are not listed here.</p>}

          <h3>Measured ROI</h3>
          {/* metricCounts gates each figure: 0 rows means "never measured", and a never-measured metric must not print as a measured zero. */}
          {detail.roi.samples === 0
            ? <p className="faint">No measurements yet — nothing has recorded this item’s use.</p>
            : <p className="faint">
                {detail.roi.samples} recorded sample{pl(detail.roi.samples)}
                {detail.roi.metricCounts.tokensLoaded > 0 && <> · tokens loaded ~{detail.roi.tokensLoaded.toLocaleString()} est.</>}
                {detail.roi.metricCounts.uses > 0 && <> · {detail.roi.successfulUses} successful use{pl(detail.roi.successfulUses)} · {detail.roi.failedUses} failed</>}
                {detail.roi.metricCounts.tokensSaved > 0 && <> · tokens saved{' '}
                  {detail.roi.evidenceLevel === 'causal'
                    ? detail.roi.tokensSaved.toLocaleString()
                    : `~${detail.roi.tokensSaved.toLocaleString()} est.`}</>}
                {(detail.roi.metricCounts.uses === 0 || detail.roi.metricCounts.tokensSaved === 0) && <> · no use outcomes or savings recorded yet</>}
                {' '}· evidence <span className="mini-badge">{detail.roi.evidenceLevel}</span> — only causal experiments are labelled verified.
              </p>}
        </>}
      </aside>
      {retiring && (
        <RetireDialog items={retiring} busy={busy}
                      onCancel={() => setRetiring(null)}
                      onConfirm={(reason) => void retire(reason, retiring)} />
      )}
    </div>
  );
}

/** One reason for every item being retired at once. The channel requires a
 * non-empty reason per call, so it is collected here rather than invented — and
 * the list names each item, because a bulk action whose targets are off-screen
 * is how rubber-stamping starts. */
function RetireDialog({ items, busy, onCancel, onConfirm }: {
  items: KnowledgeItem[];
  busy: string | null;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  return (
    <div className="learning-modal-backdrop" onMouseDown={onCancel}>
      <section className="learning-modal card" role="dialog" aria-modal="true"
               aria-label={`Retire ${items.length} knowledge item${pl(items.length)}`}
               onMouseDown={(e) => e.stopPropagation()}>
        <div className="learning-card-head">
          <div>
            <span className="label">Status change · nothing is deleted</span>
            <h2>Retire {items.length} item{pl(items.length)}</h2>
          </div>
          <button className="btn" onClick={onCancel}>Close</button>
        </div>
        <p>
          Retiring changes an item’s status. Every version, citation, and projection is kept, and the
          reason and the actor are recorded as an operational signal. A retired item stops being
          retrieved and stops being injected into an agent’s context. This build has no in-app action
          that makes a retired item active again.
        </p>
        <ul className="retire-list">
          {items.map((item) => {
            const mark = unsynthesizedMark(item.title, item.canonicalText);
            return (
              <li key={item.id}>
                <strong>{item.title}</strong>
                <small>{item.kind} · {item.scope} · {item.status}{mark ? ` · ${mark}` : ''}</small>
              </li>
            );
          })}
        </ul>
        <label>
          <span className="label">Reason · required</span>
          <textarea className="field" rows={3} autoFocus value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="Why is this being taken out of circulation?" />
        </label>
        <p className="faint">
          “Who removed this, and why” is the part that outlives the removal, so an empty reason is
          refused. The same words are recorded against every item listed above.
        </p>
        <BackupLink />
        <div className="learning-actions">
          <button className="btn btn-danger" disabled={busy !== null || !reason.trim()}
                  onClick={() => onConfirm(reason.trim())}>
            {busy === 'retire' ? 'Retiring…' : `Retire ${items.length} item${pl(items.length)}`}
          </button>
          <button className="btn" onClick={onCancel}>Cancel</button>
        </div>
      </section>
    </div>
  );
}

/** Settings owns backup, verify, and restore. This is a link to the same
 * create action from the one place in Learning where a snapshot is worth
 * having first — not a second copy of that surface. */
function BackupLink() {
  const [phase, setPhase] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [note, setNote] = useState<string | null>(null);
  const run = async () => {
    setPhase('running'); setNote(null);
    try {
      const summary = await window.wanigan.backup.create();
      // A cancelled folder dialog returns null: nothing was written, and saying
      // so is not an error.
      if (!summary) { setPhase('idle'); setNote('No folder was chosen, so nothing was written.'); return; }
      setPhase('done');
      setNote(`Backup written to ${summary.dir} — database ${fmtBytes(summary.database.bytes)}, `
        + `${summary.transcripts.files.toLocaleString()} transcript file${pl(summary.transcripts.files)}.`);
    } catch (e) {
      setPhase('error'); setNote(message(e));
    }
  };
  return (
    <div className="retire-backup">
      <button className="btn" disabled={phase === 'running'} onClick={() => void run()}>
        {phase === 'running' ? 'Backing up…' : 'Back up first…'}
      </button>
      <div>
        <p className="faint">
          Copies the database and recorded transcripts to a folder you pick. Verify and restore live
          in Settings → Backup.
        </p>
        {note && (phase === 'error'
          ? <p className="learning-status bad">✕ {note}</p>
          : <p className="faint">{note}</p>)}
      </div>
    </div>
  );
}

function SkillForge({ project, providers, busy, act }: {
  project: Project | null;
  providers: ProviderInfo[];
  busy: string | null;
  act: Act;
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
  // Per-provider install outcomes: a failed provider never hides one that applied.
  const [installed, setInstalled] = useState<SkillInstallResult[] | null>(null);
  const installLine = (r: SkillInstallResult) => r.error ? `✕ ${r.providerId}: ${r.error}` : `✓ ${r.providerId} applied`;
  const forge = async () => {
    setInstalled(null);
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
        <div className="learning-card-head"><div><span className="label">Preview</span><h2>{forged?.name ?? 'SKILL.md'}</h2></div>{forged && <span className="learning-status muted">~{forged.estimatedTokens} est. tokens</span>}</div>
        {forged ? <><pre className="candidate-patch">{forged.skillMd}</pre><div className="doctor-list">{doctor.length === 0 ? <p className="learning-status good">✓ Skill Doctor found no issues</p> : doctor.map((d, i) => <p key={`${d.code}-${i}`} className={d.severity}><strong>{d.code}</strong> {d.message}{d.line ? ` · line ${d.line}` : ''}</p>)}</div><button className="btn btn-primary" disabled={busy !== null || doctor.some((d) => d.severity === 'error') || targets.length === 0} onClick={() => void act('install-skill', async () => {
          const results = await window.wanigan.learning.installSkill(forged, targets, scope === 'project' ? project?.id ?? null : null);
          setInstalled(results);
          return results;
        }, (r) => `${(r as SkillInstallResult[]).map(installLine).join(' · ')}. No git commit was created.`)}>Install approved skill</button>{installed && (
          <div className="doctor-list">
            {installed.map((r) => (
              <p key={r.providerId} className={r.error ? 'error' : ''}>
                {installLine(r)}{!r.error && r.projection ? <> · <span className="mono">{r.projection.targetPath}</span></> : null}
              </p>
            ))}
          </div>
        )}<p className="faint">Project: Claude <span className="mono">.claude/skills/{forged.name}</span> · Codex <span className="mono">.agents/skills/{forged.name}</span>. Personal skills use the matching home-directory roots.</p></> : <Empty title="No skill draft yet" body="Describe the trigger, workflow, and checks. The Forge generates a reviewable provider-neutral body; it never invents an installation silently." />}
      </aside>
    </div>
  );
}

function ProjectMap({ project, items, signals, onSelect }: {
  project: Project | null;
  items: KnowledgeItem[];
  signals: LearningSignal[];
  /** Opens the shared Knowledge detail pane for a picked item. */
  onSelect?: (item: KnowledgeItem) => void;
}) {
  // Every item List mode shows is reachable here too — grouping, not filtering.
  const groups = useMemo(() => {
    const map = new Map<string, KnowledgeItem[]>();
    for (const item of items) {
      const key = item.pathScope || (item.scope === 'personal' ? 'Personal' : 'Repository-wide');
      map.set(key, [...(map.get(key) ?? []), item]);
    }
    return [...map.entries()];
  }, [items]);
  const gatePasses = signals.filter((s) => s.kind === 'gate-passed').length;
  return (
    <div className="learning-stack">
      <section className="card learning-card project-map-hero"><div><span className="label">Living Project Map</span><h2>{project?.name ?? 'Choose a project'}</h2>{project ? <p className="mono">{project.path}</p> : <p>Personal scope has no repository tree.</p>}</div><div><b>{groups.length}</b><small>mapped scope{pl(groups.length)}</small></div><div><b>{items.length}</b><small>stored fact{pl(items.length)}</small></div><div><b>{gatePasses}</b><small>{gatePasses === 1 ? 'gate pass seen' : 'gate passes seen'}</small></div></section>
      {groups.length === 0 && <Empty title="This project has not mapped itself yet" body="Approve project-map, instruction, rule, mission, and review-gate proposals. They are grouped by path so no session loads every rule." />}
      <div className="map-tree">{groups.map(([path, entries]) => <section className="card map-branch" key={path}><div className="map-path"><span aria-hidden="true">⌁</span><strong className="mono">{path}</strong></div>{entries.map((item) => <button type="button" className="map-item" key={item.id} onClick={() => onSelect?.(item)}><span className="learning-status muted">{item.kind}</span><div><strong>{item.title}</strong><p>{item.canonicalText}</p><small>confidence {ruleConf(item.confidence)} rule-derived · {item.sourceCount} citation{pl(item.sourceCount)} · checked {when(item.lastValidatedAt)}</small></div></button>)}</section>)}</div>
    </div>
  );
}

/* ── Optimize ──────────────────────────────────────────────────────────── */

/** Four reasons an item ranked and still did not ship, with the fix each one
 * implies. They stay four rows because raising the token ceiling fixes exactly
 * one of them. */
function HeldBackList({ briefing }: { briefing: KnowledgeBriefing }) {
  const held = readHeldBack(briefing);
  const rows: { key: string; n: number; text: string }[] = [];
  if (held.stale > 0) rows.push({ key: 'stale', n: held.stale,
    text: 'quarantined at retrieval — a file citation is missing, changed, or outside an allowed root. Re-check that item’s citations in Knowledge.' });
  if (held.budget > 0) rows.push({ key: 'budget', n: held.budget,
    text: 'cut by the token ceiling — they ranked, and nothing was left of the budget. Raising the briefing ceiling admits these.' });
  if (held.unverified !== null && held.unverified > 0) rows.push({ key: 'unverified', n: held.unverified,
    text: 'never verified — the per-launch freshness-check quota was spent before they were reached. Not the same as stale, and a bigger token ceiling does not admit them.' });
  if (held.unsynthesized !== null && held.unsynthesized > 0) rows.push({ key: 'unsynthesized', n: held.unsynthesized,
    text: 'refused as unsynthesized — the item’s text is its own title, or a bare filesystem path. The fix is the item itself: edit it, or retire it in Knowledge.' });
  if (held.unaccounted > 0) rows.push({ key: 'unaccounted', n: held.unaccounted,
    text: 'held back for a reason this build did not report separately.' });
  if (rows.length === 0) return null;
  return (
    <div className="held-back">
      <span className="label">Held back · separate reasons, separate fixes</span>
      <ul>
        {rows.map((row) => <li key={row.key}><b>{row.n.toLocaleString()}</b>{row.text}</li>)}
      </ul>
    </div>
  );
}

function BriefingInspector({ providers, scopeParam, settings }: {
  providers: ProviderInfo[];
  scopeParam: string | null | undefined;
  settings: LearningSettings;
}) {
  const [query, setQuery] = useState('');
  const [providerId, setProviderId] = useState(providers[0]?.id ?? '');
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<KnowledgeBriefing | null>(null);
  // What this preview asked for, kept beside what retrieval reported: a build
  // that does not report `queryProvided` still must not claim a query was used.
  const [askedWithQuery, setAskedWithQuery] = useState(true);
  useEffect(() => {
    if (!providerId && providers[0]) setProviderId(providers[0].id);
  }, [providerId, providers]);
  const run = async () => {
    if (!providerId) return;
    const task = query.trim();
    setRunning(true); setErr(null); setAskedWithQuery(task.length > 0);
    try {
      setResult(await window.wanigan.learning.briefing({ query: task, providerId, projectId: scopeParam }));
    } catch (e) {
      setErr(message(e));
    } finally {
      setRunning(false);
    }
  };
  const max = Math.max(1, settings.briefingMaxTokens);
  // Retrieval's own answer wins; the local record only fills in for a build
  // that did not report one.
  const queryUsed = result ? readQueryProvided(result) ?? askedWithQuery : null;
  return (
    <section className="card learning-card">
      <div className="learning-card-head">
        <div><span className="label">Briefing inspector</span><h2>Preview a launch briefing</h2></div>
      </div>
      <p>
        This is the same retrieval a session launch runs, using your text as the task. Token counts
        are the bytes÷4 heuristic — always estimates.
      </p>
      <p className="faint">Previewing never changes an item’s status; only a real launch quarantines stale items.</p>
      <div className="inspector-form">
        <input className="field" value={query} onChange={(e) => setQuery(e.target.value)}
               onKeyDown={(e) => { if (e.key === 'Enter') void run(); }}
               placeholder="Describe the task a session would start with — or leave empty…" />
        <select className="field" value={providerId} onChange={(e) => setProviderId(e.target.value)} aria-label="Provider profile">
          {providers.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
        <button className="btn btn-primary" disabled={running || !providerId} onClick={() => void run()}>
          {running ? 'Retrieving…' : query.trim() ? 'Preview retrieval' : 'Preview a prompt-less launch'}
        </button>
      </div>
      <p className="faint">
        Leaving the box empty previews what a session launched with no initial prompt receives: only
        standing artifacts are eligible, so it is a different retrieval, not a smaller one.
      </p>
      {providers.length === 0 && <p className="faint">No launch profiles were detected, so there is no provider to preview with.</p>}
      {err && <p className="learning-status bad">✕ {err}</p>}
      {result && (
        <>
          {/* Length-only magnitude; the printed numbers carry the meaning. */}
          <div className="inspector-meter" aria-hidden="true">
            <span style={{ width: `${Math.min(100, (result.estimatedTokens / max) * 100)}%` }} />
          </div>
          <p className="faint">
            ~{result.estimatedTokens.toLocaleString()} est. tokens of the {settings.briefingMaxTokens.toLocaleString()}-token budget.
          </p>
          {queryUsed === false && (
            <p className="faint">
              {askedWithQuery
                ? 'Retrieval ran without a usable task query: nothing in your text survived as a search term, and no path could be inferred from it.'
                : 'Retrieval ran without a task query, exactly as a prompt-less launch does.'}
              {' '}Only standing artifacts (mission-kind items) were eligible; project- and path-scoped
              knowledge was not considered.
            </p>
          )}
          <HeldBackList briefing={result} />
          {result.entries.length === 0
            ? (queryUsed === false
              ? <Empty title="Nothing would be injected" body="Retrieval ran with no task query, so only standing artifacts were eligible and none is active in this scope. A launch like this receives no briefing at all — a different outcome from a query that ranked nothing." />
              : <Empty title="Retrieval ran and matched nothing" body="No active knowledge ranked for this query in this scope. That is a recorded outcome, not an error — a broader query or a different project scope may match." />)
            : (
              <div className="signal-list">
                {result.entries.map((en) => (
                  <div key={en.itemId}>
                    <span className="mono">{en.kind}</span>
                    <strong>{en.title}</strong>
                    <small>~{en.estimatedTokens.toLocaleString()} est. tokens · {en.citations.length} citation{pl(en.citations.length)}</small>
                  </div>
                ))}
              </div>
            )}
        </>
      )}
    </section>
  );
}

function Optimize({ diagnostics, settings, providers, scopeParam, emptyFrame, busy, act }: {
  diagnostics: OptimizerDiagnostic[];
  settings: LearningSettings;
  providers: ProviderInfo[];
  scopeParam: string | null | undefined;
  emptyFrame: string;
  busy: string | null;
  act: Act;
}) {
  const save = (patch: Partial<LearningSettings>) => act('learning-settings', () => window.wanigan.learning.setSettings(patch), 'Learning controls updated. New sessions use the new retrieval policy.');
  // Draft-then-commit: main rejects values outside 200–8000, so per-keystroke saves would fail mid-typing.
  const [ceilingDraft, setCeilingDraft] = useState(String(settings.briefingMaxTokens));
  useEffect(() => { setCeilingDraft(String(settings.briefingMaxTokens)); }, [settings.briefingMaxTokens]);
  const commitCeiling = () => {
    const n = Number(ceilingDraft);
    if (Number.isFinite(n) && n >= 200 && n <= 8000 && n !== settings.briefingMaxTokens) void save({ briefingMaxTokens: n });
    else setCeilingDraft(String(settings.briefingMaxTokens));
  };
  return (
    <div className="learning-stack">
      <section className="card learning-card">
        <div className="learning-card-head">
          <div><span className="label">Master switch</span><h2>Learning</h2></div>
          <span className={`learning-status ${settings.enabled ? 'good' : 'muted'}`}>
            {settings.enabled ? '✓ active — recording and briefing' : '○ paused — nothing recorded, nothing deleted'}
          </span>
        </div>
        <label className="learning-check">
          <input type="checkbox" className="learning-switch" checked={settings.enabled} disabled={busy !== null}
                 onChange={(e) => {
                   const enabled = e.target.checked;
                   void act('learning-enabled',
                     () => window.wanigan.learning.setSettings({ enabled }),
                     enabled
                       ? 'Learning active. New sessions record signals and receive briefings.'
                       : 'Learning paused. Nothing was deleted; resume any time.');
                 }} />
          {' '}Record signals, consolidate, and inject briefings
        </label>
        <p className="faint learning-switch-note">
          Pausing stops recording, consolidation, and injection; nothing is deleted.
        </p>
      </section>
      <BriefingInspector providers={providers} scopeParam={scopeParam} settings={settings} />
      <section className="learning-grid two">
        <article className="card learning-card"><span className="label">Adaptive context router</span><h2>Load less, later</h2><p>Structured project/path scope and full-text ranking run locally first. Progressive skills and mission briefings receive a hard token ceiling.</p><label><span className="label">Briefing ceiling · tokens</span><input className="field" type="number" min={200} max={8000} value={ceilingDraft} onChange={(e) => setCeilingDraft(e.target.value)} onBlur={commitCeiling} onKeyDown={(e) => { if (e.key === 'Enter') commitCeiling(); }} /></label><label className="learning-check"><input type="checkbox" className="learning-switch" checked={settings.consolidationEnabled} onChange={(e) => void save({ consolidationEnabled: e.target.checked })} /> Consolidate while Wanigan or its daemon is active</label></article>
        <article className="card learning-card"><span className="label">Learning budget governor</span><h2>Deterministic-only today</h2><p>Classification, hashing, routing, and diagnostics run locally without a model call. The stored opt-in and monthly ceiling reserve an explicit boundary for a future model-assisted consolidator; they do not spend or launch one in this build.</p><label className="learning-check"><input type="checkbox" className="learning-switch" checked={settings.allowModelAssistance} disabled /> Model-assisted extraction (not connected yet)</label><label><span className="label">Reserved monthly ceiling · USD</span><input className="field" type="number" min={0} step="0.25" value={settings.monthlyBudgetUsd} disabled /></label><p className="faint">Wanigan will not imply this control is active before usage metering and provider-specific consent are wired end to end.</p></article>
      </section>
      <section className="card learning-card"><div className="learning-card-head"><div><span className="label">Context Budget Doctor · Cache Guardian · Garbage Collector</span><h2>{diagnostics.length} finding{pl(diagnostics.length)}</h2></div><span className="learning-status muted">diagnosis only</span></div><div className="diagnostic-list">{diagnostics.length === 0 && <Empty title="No context debt detected" body="Duplicate, contradictory, expired, oversized, unused, drifting, or volatile artifacts will appear here." frame={emptyFrame} />}{diagnostics.map((d, i) => <article key={`${d.kind}-${i}`} className={`diagnostic ${d.severity}`}><span aria-hidden="true">{d.severity === 'error' ? '✕' : d.severity === 'warning' ? '!' : 'i'}</span><div><strong>{d.title}</strong><p>{d.detail}</p><small>{d.kind} · {estTokens(d.estimatedTokenDelta)} · {d.itemIds.length} item{pl(d.itemIds.length)}</small></div></article>)}</div></section>
      <p className="faint">These numbers are estimated until a controlled Context A/B experiment proves a causal saving. Wanigan does not call fewer tokens “better” unless the same evaluation still passes.</p>
    </div>
  );
}

function Experiments({ experiments, candidates, project, providers, busy, act, emptyFrame }: {
  experiments: LearningExperiment[];
  candidates: KnowledgeCandidate[];
  project: Project | null;
  providers: ProviderInfo[];
  busy: string | null;
  act: Act;
  emptyFrame: string;
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
      <section className="experiment-list">{experiments.length === 0 && <Empty title="No experiments yet" body="Create a draft to pin the comparison. Estimated and causal metrics stay visibly separate." frame={emptyFrame} />}{experiments.map((e) => <article className="card experiment-card" key={e.id}><div className="learning-card-head"><div><span className="label">{e.providerId} · {e.model}</span><h2>{e.name}</h2></div><span className={`learning-status ${e.status === 'completed' ? 'good' : e.status === 'failed' ? 'bad' : 'muted'}`}>{e.status}</span></div><p className="mono">commit {e.commitHash || 'un-pinned'} · effort {e.effort ?? 'default'}</p><small>Created {when(e.createdAt)} · started {when(e.startedAt)} · ended {when(e.endedAt)}</small><div className="learning-actions">{e.status === 'draft' && <button className="btn btn-primary" disabled={busy !== null} onClick={() => void act(`experiment-${e.id}`, () => window.wanigan.learning.setExperimentStatus(e.id, 'start'), 'Experiment marked running. Execute its pinned baseline and candidate workloads.')}>Start</button>}{e.status === 'running' && <button className="btn btn-primary" disabled={busy !== null} onClick={() => void act(`experiment-${e.id}`, () => window.wanigan.learning.setExperimentStatus(e.id, 'complete', { evidenceLevel: 'estimate', note: 'Closed from the workspace; paired metrics have not been ingested.' }), 'Experiment closed. Savings remain estimated until paired evaluation metrics prove a causal result.')}>Close run</button>}{['draft', 'running'].includes(e.status) && <button className="btn" disabled={busy !== null} onClick={() => void act(`experiment-${e.id}`, () => window.wanigan.learning.setExperimentStatus(e.id, 'cancel'), 'Experiment cancelled; its history remains.')}>Cancel</button>}</div></article>)}</section>
    </div>
  );
}

function Empty({ title, body, frame, children }: {
  title: string;
  body: string;
  /** Names the scope and window this absence was measured in, e.g.
   * 'scope: Everything · all time' — a count with no frame is how the scope
   * schism hid. */
  frame?: string;
  children?: ReactNode;
}) {
  return (
    <div className="learning-empty">
      <span aria-hidden="true">◇</span>
      <div>
        <strong>{title}</strong>
        <p>{body}</p>
        {children}
        {frame && <small className="learning-empty-frame">{frame}</small>}
      </div>
    </div>
  );
}
