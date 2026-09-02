import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  CandidateExplanation,
  ConsolidationRun,
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
} from '@shared/types';
import { EFFORT_LEVELS } from '@shared/types';
import { ago } from '../components/bits';
import '../styles/learning.css';

type LearningTab = 'overview' | 'inbox' | 'knowledge' | 'context' | 'experiments';

/** The one read state every list on this page shares. All of them are fetched
 * in a single Promise.all, so "in flight", "failed" and "observed" are
 * properties of that one call — and a pane may only assert a count once
 * `observed` is true. Overview's '…' / '—' / '0' treatment is this same rule
 * applied to a single number. */
type Read = {
  phase: 'loading' | 'ok' | 'error';
  /** The read failure, when the newest attempt failed. */
  error: string | null;
  /** True once a read has returned: only then is an empty list an observation. */
  observed: boolean;
  /** When that read returned, so a stale list can say how stale it is. */
  at: number | null;
  retry: () => void;
};

/** Runs one mutation with busy/error handling, then reloads. `done` may derive
 * the notice from the call's real result, so success copy never has to guess. */
type Act = (key: string, fn: () => Promise<unknown>, done: string | ((result: unknown) => string)) => Promise<boolean>;

type ScopeSel = 'all' | 'personal' | 'project';

const SCOPE_KEY = 'wanigan.learning.scope';

/** The single scope→IPC mapper. Main already speaks this tri-state everywhere:
 * undefined = all projects + personal, null = personal-only, id = that project
 * (plus personal artifacts at candidate/knowledge stages). Every learning.*
 * read routes through this one value so no two surfaces can disagree. */
const toScopeParam = (sel: ScopeSel, projectId?: string): string | null | undefined =>
  sel === 'all' ? undefined : sel === 'personal' ? null : projectId;

/** Four tabs, each labelled with the plain-words question it answers. This
 * order is also the pipeline — observed, decided, stored, spent — so the
 * navigation carries the explanation a collapsed prose drawer used to hide. */
const TABS: { id: LearningTab; label: string; hint: string }[] = [
  { id: 'overview', label: 'Overview', hint: 'What has this actually done?' },
  { id: 'inbox', label: 'Inbox', hint: 'What needs my decision?' },
  { id: 'knowledge', label: 'Knowledge', hint: 'What is stored, and what goes into my agent\u2019s prompt?' },
  { id: 'context', label: 'Context', hint: 'What is my context costing me?' },
];

/** Appended only while `learning_experiments` holds at least one row. The table
 * has never had one in this build, and a tab that can only ever be empty
 * teaches a newcomer that they broke something. */
const EXPERIMENTS_TAB: { id: LearningTab; label: string; hint: string } =
  { id: 'experiments', label: 'Experiments', hint: 'Controlled comparisons on record' };

/** Context deep-links with the old tab id; it resolves to the renamed tab
 * rather than silently landing on Overview. */
const TARGET_TAB: Record<string, LearningTab> = {
  overview: 'overview', inbox: 'inbox', knowledge: 'knowledge',
  optimize: 'context', context: 'context',
};

// Consume-once across remounts: the deep-link target lives in App state, so a
// later visit to Learning must not replay a jump this nonce already made.
let consumedTargetNonce = 0;

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


/* ── four distinct read states · the rule every pane below follows ────── */

/** Stamps an absence with the scope it was measured in, and — when the newest
 * refresh failed — with how old the surviving observation actually is. */
const framed = (frame: string, read: Read) =>
  read.phase === 'error' && read.at !== null
    ? `${frame} · observed ${ago(read.at)}; the newest refresh failed`
    : frame;

/** A read in flight. It names what is being read and claims no count, because
 * none has been observed yet. */
function Loading({ what }: { what: string }) {
  return (
    <div className="learning-empty">
      <span aria-hidden="true">◌</span>
      <div>
        <strong>Reading {what}…</strong>
        <p>Counted from stored rows in the local database. Nothing is claimed until the read returns.</p>
      </div>
    </div>
  );
}

/** A failed read. It offers Retry and asserts no number: “none” and “not read”
 * are different facts, and only one of them was ever observed. An error banner
 * over a pane that simultaneously says “none have ever existed” prints a
 * falsehood in the provenance frame of a measurement. */
function ReadFailed({ what, read }: { what: string; read: Read }) {
  return (
    <div className="learning-empty bad">
      <span aria-hidden="true">✕</span>
      <div>
        <strong>Could not read {what}</strong>
        <p>
          {read.error ?? 'The call returned nothing.'} How many exist is unknown — this is not a
          count of zero.
        </p>
        <button className="btn" onClick={read.retry}>Retry</button>
      </div>
    </div>
  );
}

/** Gates a list surface on the shared read: loading and a first-read failure
 * replace the list entirely, so the empty copy inside `children` only ever
 * speaks about a read that actually happened. Once a read has landed, a later
 * failed refresh leaves the last observation on screen — dated by `framed`,
 * not deleted. */
function Pane({ read, what, children }: { read: Read; what: string; children: ReactNode }) {
  if (read.observed) return <>{children}</>;
  return read.phase === 'error' ? <ReadFailed what={what} read={read} /> : <Loading what={what} />;
}

/** A domain noun defined where it is first used, in visible text. A `title`
 * tooltip is not a definition: touch never shows it and a screen reader reads
 * it unreliably. The glossary stays the reference, not the teaching. */
function Define({ term, children }: { term: string; children: ReactNode }) {
  return <p className="define"><b>{term}</b> {children}</p>;
}

export default function Learning({ projectId, projects, providers, onPickProject, initialTarget }: {
  projectId?: string;
  projects: Project[];
  providers: ProviderInfo[];
  /** Accepted and unused: Scout is a top-level view now, and the shell may
   * still pass this. Declared so the shell keeps type-checking either way. */
  onOpenGoal?: (id: string) => void;
  /** Picking a project scope here moves the app-global selection with it. */
  onPickProject?: (id: string) => void;
  /** One-shot deep link from Context; consumed by nonce. `optimize` is the
   * pre-rename id and still resolves, so an older caller is not stranded. */
  initialTarget?: { tab: 'overview' | 'inbox' | 'knowledge' | 'optimize' | 'context'; nonce: number } | null;
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
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Kept apart from `error` on purpose: a failed mutation must not make the
  // lists below look unread. Only a failed read may do that.
  const [readErr, setReadErr] = useState<string | null>(null);
  // A read has returned at least once, and when. Until it has, an empty list is
  // "not read yet" — never "there has never been one".
  const [observedAt, setObservedAt] = useState<number | null>(null);
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
  // The glossary opens over the tab in view. Jumping to Overview to read one
  // word cost the reader their place, which is the opposite of a reference.
  const [glossaryOpen, setGlossaryOpen] = useState(false);

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
    // A deliberate re-read clears the last failure so the panes flip back to
    // "reading" — Retry with no visible change is indistinguishable from a
    // dead button. A quiet background refresh leaves the failure standing.
    if (!quiet) { setLoading(true); setReadErr(null); }
    try {
      const [ov, st, sg, cd, kn, dg, ex] = await Promise.all([
        window.wanigan.learning.overview(scopeParam),
        window.wanigan.learning.settings(),
        window.wanigan.learning.signals({ projectId: scopeParam, limit: 80 }),
        window.wanigan.learning.candidates({ projectId: scopeParam, limit: 100 }),
        window.wanigan.learning.knowledge({ projectId: scopeParam, limit: 200 }),
        window.wanigan.learning.diagnostics(scopeParam),
        window.wanigan.learning.experiments({ projectId: scopeParam, limit: 80 }),
      ]);
      setOverview(ov);
      setSettings(st);
      setSignals(sg);
      setCandidates(cd);
      setKnowledge(kn);
      setDiagnostics(dg);
      setExperiments(ex);
      setObservedAt(Date.now());
      setReadErr(null);
      setError(null);
    } catch (e) {
      setReadErr(message(e));
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
    setTab(TARGET_TAB[initialTarget.tab] ?? 'overview');
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

  const retry = useCallback(() => { setRefreshTick((t) => t + 1); void load(); }, [load]);
  // Every list pane below receives this instead of a bare array, so no pane can
  // print "there has never been one" for a read that is still in flight or that
  // failed. `observed` is false until a read has actually returned.
  const read = useMemo<Read>(() => ({
    phase: readErr ? 'error' : observedAt === null ? 'loading' : 'ok',
    error: readErr, observed: observedAt !== null, at: observedAt, retry,
  }), [readErr, observedAt, retry]);

  // Candidate, knowledge, diagnostic, and experiment lists are all-time reads.
  // A failed refresh does not erase the last observation — it dates it.
  const emptyFrame = framed(`scope: ${scopeWords} · all time`, read);

  // Experiments has never had a row in this build; the tab appears only once one
  // exists, and a tab that disappears under the reader hands them back Overview.
  const tabs = experiments.length > 0 ? [...TABS, EXPERIMENTS_TAB] : TABS;
  useEffect(() => {
    if (tab === 'experiments' && experiments.length === 0) setTab('overview');
  }, [tab, experiments.length]);

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
          <Define term="Scope">
            is where an artifact applies — personal (everywhere), one project, or one path inside a
            project. It decides what retrieval may inject, and it frames every count on this page.
          </Define>
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
                     read={read} windowDays={windowDays} onNavigate={navigate} />

      {/* The hint sits beside the tablist rather than inside it: it is the
          question the open tab answers, so it is read out like any other text —
          and a tablist may not hold a focusable child that is not a tab. */}
      <div className="learning-tabs">
        <div className="learning-tablist" role="tablist" aria-label="Learning workspace"
             onKeyDown={(e) => {
               if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
               e.preventDefault();
               const i = tabs.findIndex((t) => t.id === tab);
               const next = e.key === 'Home' ? 0
                 : e.key === 'End' ? tabs.length - 1
                 : e.key === 'ArrowLeft' ? (i - 1 + tabs.length) % tabs.length
                 : (i + 1) % tabs.length;
               setTab(tabs[next].id);
               document.getElementById(`learning-tab-${tabs[next].id}`)?.focus();
             }}>
          {tabs.map((item) => (
            <button key={item.id} role="tab" aria-selected={tab === item.id}
                    id={`learning-tab-${item.id}`} aria-controls={`learning-panel-${item.id}`}
                    tabIndex={tab === item.id ? 0 : -1} title={item.hint}
                    className={tab === item.id ? 'on' : ''} onClick={() => setTab(item.id)}>
              <span>{item.label}</span>
              {item.id === 'inbox' && overview.pending > 0 && <b>{overview.pending}</b>}
            </button>
          ))}
        </div>
        <p className="tab-hint">
          {tabs.find((t) => t.id === tab)?.hint} ·{' '}
          <button className="learning-link" onClick={() => setGlossaryOpen(true)}>glossary</button>
        </p>
      </div>

      {error && <div className="learning-banner error" role="alert">{error}</div>}
      {notice && <div className="learning-banner ok" role="status" key={notice.key}>{notice.text}</div>}

      {/* tabIndex makes the panel focusable, which is what lets a keyboard
          scroll it at all; without it the arrow keys had nothing to act on. */}
      <div className="learning-scroll" tabIndex={0} role="tabpanel" id={`learning-panel-${tab}`} aria-labelledby={`learning-tab-${tab}`}>
        {tab === 'overview' && (
          <Overview overview={overview} settings={settings} pipeline={pipeline} read={read}
                    pipelineErr={pipelineErr} pipelineBusy={pipelineBusy}
                    windowDays={windowDays} onWindow={setWindowDays}
                    candidates={candidates} knowledge={knowledge}
                    scopeSel={scopeSel} scopeParam={scopeParam} busy={busy} act={act}
                    onNavigate={navigate} onRetry={retry} />
        )}
        {tab === 'inbox' && (
          <Inbox candidates={candidates} signals={signals} providers={availableProviders}
                 busy={busy} act={act} initialStatus={inboxPreset} read={read}
                 scoped={scopeSel !== 'all'} onShowAll={() => setScope('all')} emptyFrame={emptyFrame} />
        )}
        {tab === 'knowledge' && (
          <Knowledge items={knowledge} signals={signals} providers={availableProviders}
                     project={scopeSel === 'personal' ? null : project}
                     scopeParam={scopeParam} emptyFrame={emptyFrame} settings={settings}
                     read={read} busy={busy} act={act} refreshTick={refreshTick}
                     onNavigate={navigate} />
        )}
        {tab === 'context' && (
          <ContextTab diagnostics={diagnostics} settings={settings} providers={availableProviders}
                      scopeParam={scopeParam} emptyFrame={emptyFrame} read={read}
                      busy={busy} act={act} onNavigate={navigate} />
        )}
        {tab === 'experiments' && (
          <Experiments experiments={experiments} candidates={candidates} project={project} providers={availableProviders}
                       busy={busy} act={act} read={read} emptyFrame={emptyFrame} />
        )}
      </div>
      {glossaryOpen && <GlossaryModal onClose={() => setGlossaryOpen(false)} />}
    </div>
  );
}

/* ── The five-station spine · shared chrome on every tab ───────────────── */

function PipelineSpine({ overview, pipeline, pipelineBusy, read, windowDays, onNavigate }: {
  overview: LearningOverview;
  pipeline: LearningPipelineStats | null;
  pipelineBusy: boolean;
  /** The store-wide read behind `overview`; the windowed one is `pipelineBusy`. */
  read: Read;
  windowDays: number;
  onNavigate: (tab: LearningTab, inboxStatus?: string) => void;
}) {
  // Windowed flows come from the pipeline read; '…' while it loads and '—' on a
  // failed read keep loading and error visibly distinct from a real zero.
  const flow = (n: number | undefined) =>
    n !== undefined ? n.toLocaleString() : pipelineBusy ? '…' : '—';
  // The two "now" stations come from the store-wide read, which has its own
  // outcome — and its pre-read default is a zero that was never observed.
  const now = (n: number) => read.observed ? n.toLocaleString() : read.phase === 'error' ? '—' : '…';
  const stations: { key: string; label: string; value: string; sub: string; warn?: string; note?: string; go: () => void; title: string }[] = [
    { key: 'observed', label: 'Observed', value: flow(pipeline?.signals), sub: `signals · last ${windowDays}d`,
      go: () => onNavigate('overview'), title: 'Open the Overview — the day chart breaks these down' },
    { key: 'proposed', label: 'Proposed', value: now(overview.pending), sub: 'await your decision · now',
      go: () => onNavigate('inbox', 'open'), title: 'Open the Inbox filtered to proposals needing a decision' },
    { key: 'approved', label: 'Approved', value: now(overview.activeKnowledge), sub: 'active items · now',
      warn: read.observed && overview.quarantined > 0 ? `⚠ ${overview.quarantined} quarantined` : undefined,
      go: () => onNavigate('knowledge'), title: 'Open Knowledge' },
    { key: 'projected', label: 'Projected', value: flow(pipeline?.projectionsApplied), sub: `files written · last ${windowDays}d`,
      // A zero here is not a fault: a briefing is injected at launch and needs
      // no file write, so a store can brief every session and project nothing.
      note: pipeline && pipeline.projectionsApplied === 0 ? 'optional step — a briefing needs no file write' : undefined,
      go: () => onNavigate('knowledge'), title: 'Open Knowledge — projections are listed on each item' },
    { key: 'briefed', label: 'Briefed', value: flow(pipeline?.briefingsServed), sub: `served · last ${windowDays}d`,
      go: () => onNavigate('context'), title: 'Open Context — the briefing inspector previews one' },
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
            {s.note && <small className="spine-note">{s.note}</small>}
          </button>
        </Fragment>
      ))}
    </div>
  );
}

/* ── Overview · the legibility surface ─────────────────────────────────── */

function Overview({ overview, settings, pipeline, read, pipelineErr, pipelineBusy, windowDays, onWindow, candidates, knowledge, scopeSel, scopeParam, busy, act, onNavigate, onRetry }: {
  overview: LearningOverview;
  settings: LearningSettings;
  pipeline: LearningPipelineStats | null;
  /** The store-wide read; the windowed pipeline read is reported separately. */
  read: Read;
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
  onNavigate: (tab: LearningTab, inboxStatus?: string) => void;
  onRetry: () => void;
}) {
  // Loading is not empty; a fatal read failure is not either. This page
  // summarises two reads — the windowed pipeline and the store-wide counts —
  // and every card below would otherwise print the pre-read zeros as observed.
  if (!read.observed && read.phase === 'error') {
    return <div className="learning-stack"><ReadFailed what="the learning ledger" read={read} /></div>;
  }
  if (!read.observed || (!pipeline && pipelineBusy)) {
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
        <HowItWorks pipeline={pipeline} windowDays={windowDays} onNavigate={onNavigate} />
        <AutoPromotion pipeline={pipeline} windowDays={windowDays} onNavigate={onNavigate} />
        <NeedsAttention overview={overview} settings={settings} candidates={candidates} onNavigate={onNavigate} />
        <PrivacyCard />
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

      <HowItWorks pipeline={pipeline} windowDays={windowDays} onNavigate={onNavigate} />

      <Define term="Signal">
        is one bounded, credential-redacted record of something a session did — a tool result, a
        gate outcome, a turn ending. Shell command text is discarded: a signal is a summary plus
        structured detail, never a transcript. Every bar below counts stored signal rows.
      </Define>

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
    </div>
  );
}

/** The pipeline, stated as the four tabs themselves — so the navigation is the
 * explanation. It replaced a collapsed wall of prose whose disclosure was
 * inverted: it defaulted open on an empty store and closed once there was data,
 * hiding the explanation from the only reader who needed it. The observed
 * sub-stage counts stay, because each one is the row count of the tab beside
 * it. Each is a count over stored rows for the window, never a score. */
function HowItWorks({ pipeline, windowDays, onNavigate }: {
  pipeline: LearningPipelineStats;
  windowDays: number;
  onNavigate: (tab: LearningTab, inboxStatus?: string) => void;
}) {
  const p = pipeline;
  const toReview = Math.max(0, p.candidatesCreated - p.autoPromoted);
  const w = `last ${windowDays}d`;
  const steps: {
    tab: LearningTab; label: string; body: ReactNode;
    stats: { n: number; text: string; go: () => void; title: string }[];
  }[] = [
    {
      tab: 'overview', label: 'Overview',
      body: <>A session records bounded, credential-redacted <strong>signals</strong> — a tool result, a
        gate outcome, a turn ending. Shell command text is discarded.</>,
      stats: [
        { n: p.signals, text: `signals recorded · ${w}`, go: () => onNavigate('overview'), title: 'The day chart below breaks these down' },
        { n: p.eligibleSignals, text: `eligible for consolidation · ${w}`, go: () => onNavigate('inbox'), title: 'Open the Inbox — recent signals are listed at its foot' },
      ],
    },
    {
      tab: 'inbox', label: 'Inbox',
      body: <>A deterministic pass every 5 minutes groups repeats — at least 2 observations across 2
        independent sessions or tasks — into <strong>candidates</strong>. A candidate changes nothing
        until you decide on it. One narrow lane can auto-apply reversible personal memory, and nothing
        derived from a session qualifies for it.</>,
      stats: [
        { n: p.candidatesCreated, text: `candidates created · ${w}`, go: () => onNavigate('inbox', 'all'), title: 'Open the Inbox filtered to every proposal' },
        { n: toReview, text: `awaiting a decision · ${w}`, go: () => onNavigate('inbox', 'open'), title: 'Open the Inbox filtered to proposals needing a decision' },
        { n: p.reviewed, text: `decided · ${w}`, go: () => onNavigate('inbox', 'decided'), title: 'Open the Inbox filtered to decided proposals' },
        { n: p.autoPromoted, text: `auto-applied · ${w}`, go: () => onNavigate('knowledge'), title: 'Open Knowledge — the auto-apply lane lands there' },
      ],
    },
    {
      tab: 'knowledge', label: 'Knowledge',
      body: <>An approved candidate becomes a versioned <strong>knowledge item</strong> carrying its
        evidence. Its text is what retrieval may inject. Writing an item into a provider file is a
        separate, reversible step, and an optional one.</>,
      stats: [
        { n: p.itemsPromoted, text: `items created · ${w}`, go: () => onNavigate('knowledge'), title: 'Open Knowledge' },
        { n: p.projectionsApplied, text: `projections written · ${w} · optional`, go: () => onNavigate('knowledge'), title: 'Open Knowledge — projections are listed on each item' },
      ],
    },
    {
      tab: 'context', label: 'Context',
      body: <>At launch, retrieval assembles a token-bounded, cited <strong>briefing</strong> from the
        items that ranked for that task and hands it to the CLI. Nothing is stored inside the agent.</>,
      stats: [
        { n: p.briefingsServed, text: `briefings served · ${w}`, go: () => onNavigate('context'), title: 'Open Context — the briefing inspector previews one' },
      ],
    },
  ];
  return (
    <section className="card learning-card">
      <div className="learning-card-head">
        <div><span className="label">How this works</span><h2>The four tabs are the four stages</h2></div>
      </div>
      <ol className="how-steps">
        {steps.map((step, i) => (
          <li key={step.tab}>
            <button className="how-step-tab" onClick={() => onNavigate(step.tab)}
                    title={`Open the ${step.label} tab`}>
              <span aria-hidden="true">{i + 1}</span> {step.label}
            </button>
            <p>{step.body}</p>
            <div className="mech-stages">
              {step.stats.map((stat) => (
                <button className="pipeline-substage" key={stat.text} onClick={stat.go} title={stat.title}>
                  <b>{stat.n.toLocaleString()}</b><span>{stat.text}</span>
                </button>
              ))}
            </div>
          </li>
        ))}
      </ol>
      <p className="faint">
        Every figure is a count over stored rows for this window and this scope. A zero under
        “projections written” is not a fault: a briefing is delivered at launch and needs no file write.
      </p>
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

/** The stored trigger is an enum; printing “(timer)” hands a newcomer a raw
 * column value and asks them to guess. Unknown values are shown verbatim rather
 * than guessed at. */
const triggerWords = (trigger: ConsolidationRun['trigger']): string =>
  trigger === 'timer' ? 'started by the 5-minute timer'
    : trigger === 'manual' ? 'started by “Consolidate now”'
    : `trigger recorded as “${trigger}”`;

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
            Consolidation last ran <strong>{ago(latest.at)}</strong>, {triggerWords(latest.trigger)} ·
            consumed <strong>{latest.processed.toLocaleString()}</strong> signal{pl(latest.processed)} into candidates ·
            produced <strong>{latest.candidates.toLocaleString()}</strong> candidate{pl(latest.candidates)} ·
            auto-applied <strong>{latest.autoApplied.toLocaleString()}</strong>.
          </p>
          <div className="heartbeat-strip" role="img"
               aria-label={`${runs.length} recorded consolidation pass${runs.length === 1 ? '' : 'es'}; the most recent produced ${latest.candidates} candidate${pl(latest.candidates)}.`}>
            {strip.map((r) => (
              <span key={r.id} className={r.candidates > 0 ? 'hit' : ''}
                    style={{ height: `${4 + Math.round((r.candidates / maxC) * 18)}px` }}
                    title={`${when(r.at)} · ${triggerWords(r.trigger)} · consumed ${r.processed} · ${r.candidates} candidate${pl(r.candidates)} · auto-applied ${r.autoApplied} · ${r.durationMs}ms`} />
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
      <Define term="Briefing">
        is the token-bounded capsule retrieval assembles at session launch: the knowledge items that
        ranked for that task, with their citations, passed to the CLI as extra instructions. It is
        built per launch and stored nowhere inside the agent. Knowledge shows its literal text.
      </Define>
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
      <button className="btn" onClick={() => onNavigate('context')}>Inspect a briefing in Context</button>
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
          text: 'Signals are recorded and briefings are served at session launch.', tab: 'context', action: 'Open Context' }
      : { key: 'e', ok: false, word: 'learning paused',
          text: 'No new signals are recorded and no briefings are served while learning is off.',
          tab: 'context', action: 'Open Context' },
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

/** Opened from the tab strip, over whatever tab is in view. It used to jump to
 * Overview and scroll, which cost the reader their place to look up one word —
 * the opposite of a reference. The nouns on the decision path are also defined
 * inline where they are first used; this is the fallback, not the teaching. */
function GlossaryModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="learning-modal-backdrop" onMouseDown={onClose}>
      <section className="learning-modal card" role="dialog" aria-modal="true" aria-label="Glossary"
               onMouseDown={(e) => e.stopPropagation()}>
        <div className="learning-card-head">
          <div>
            <span className="label">Reference · your tab is unchanged</span>
            <h2>Glossary</h2>
          </div>
          <button className="btn" autoFocus onClick={onClose}>Close</button>
        </div>
        <dl className="glossary-list">
          {GLOSSARY.map((entry) => (
            <div key={entry.term}>
              <dt>{entry.term}</dt>
              <dd>{entry.body}</dd>
            </div>
          ))}
        </dl>
        <p className="faint">
          Nothing here is a setting — it is what these words mean in this app.
        </p>
      </section>
    </div>
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

function Inbox({ candidates, signals, providers, busy, act, initialStatus, read, scoped, onShowAll, emptyFrame }: {
  candidates: KnowledgeCandidate[];
  signals: LearningSignal[];
  providers: ProviderInfo[];
  busy: string | null;
  act: Act;
  /** Loading, failed and observed are kept apart here: neither list below may
   * claim a proposal has never existed for a read that never returned. */
  read: Read;
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
        {/* '…' while the read is in flight, '—' when it failed, a count only
            once one was observed — the same treatment Overview gives a number. */}
        <div><span className="label">Learning Inbox</span><strong>
          {read.observed ? `${visible.length} proposal${pl(visible.length)}`
            : read.phase === 'error' ? '— proposals, not read' : '… reading proposals'}
        </strong></div>
        {historyLine && <small className="inbox-history-line" title="Counted from stored candidate reviews.">{historyLine}</small>}
        <label><span className="label">Status</span><select className="field" value={status} onChange={(e) => setStatus(e.target.value)}><option value="open">Needs a decision</option><option value="decided">Decided</option><option value="pending">Pending</option><option value="approved">Approved</option><option value="snoozed">Snoozed</option><option value="rejected">Rejected</option><option value="promoted">Promoted</option><option value="applied">Applied</option><option value="all">All</option></select></label>
      </section>
      <Define term="Candidate">
        is a proposal, and nothing more: consolidation writes one when an observation repeats across
        independent tasks, and “Teach Wanigan” writes one from your own words. A candidate is
        inert until you approve it. Its <b>evidence</b> is the stored signals, files and commits it
        came from — what lets its claim be checked again later.
      </Define>
      <Pane read={read} what="the proposal list">
        <>
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
        </>
      </Pane>
      <section className="card learning-card">
        <div className="learning-card-head"><div><span className="label">Recent evidence stream</span><h2>Operational signals</h2></div><span className="learning-status muted">content bounded</span></div>
        <Pane read={read} what="the signal stream">
          <>
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
          </>
        </Pane>
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

/** The literal bytes that reach the next session. This is the one place the
 * payload is visible before a launch, so the string is taken from the briefing
 * IPC verbatim (`briefing.ts` composes `text`) rather than rebuilt here: a
 * renderer-side copy of the format would drift from what is actually injected.
 * Nothing here mutates anything — a preview never quarantines a stale item. */
function PayloadPanel({ providers, scopeParam, settings, items, read, onNavigate }: {
  providers: ProviderInfo[];
  scopeParam: string | null | undefined;
  settings: LearningSettings;
  /** Only used to tell “the store is empty” from “retrieval matched nothing”. */
  items: KnowledgeItem[];
  read: Read;
  onNavigate: (tab: LearningTab, inboxStatus?: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [providerId, setProviderId] = useState(providers[0]?.id ?? '');
  const [running, setRunning] = useState(providers.length > 0);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<KnowledgeBriefing | null>(null);
  // What this preview asked for, kept beside what retrieval reported: a build
  // that does not report `queryProvided` still must not claim a query was used.
  const [askedWithQuery, setAskedWithQuery] = useState(false);
  useEffect(() => {
    if (!providerId && providers[0]) setProviderId(providers[0].id);
  }, [providerId, providers]);

  const run = useCallback(async (task: string) => {
    if (!providerId) return;
    setRunning(true); setErr(null); setAskedWithQuery(task.length > 0);
    try {
      setResult(await window.wanigan.learning.briefing({ query: task, providerId, projectId: scopeParam }));
    } catch (e) {
      setErr(message(e));
    } finally {
      setRunning(false);
    }
  }, [providerId, scopeParam]);
  // A prompt-less launch is the default because it needs no input to be true,
  // and it is what a session started from the Sessions list actually receives.
  useEffect(() => { if (providerId) void run(''); }, [providerId, run]);

  const profile = providers.find((p) => p.id === providerId) ?? null;
  const harness = profile?.harnessId ?? null;
  // Routed by the declared harness, never by a profile id. Session launch
  // injects a briefing for exactly these two harnesses; anything else carries
  // none, and saying so is better than implying an integration.
  const delivery = harness === 'codex'
    ? { flag: '--config developer_instructions=<JSON-encoded text>', words: 'Codex receives it as an invocation-scoped developer instruction; the value above is JSON-encoded on the command line.' }
    : harness === 'claude-code'
      ? { flag: '--append-system-prompt <text>', words: 'Claude Code receives it appended to the system prompt for that invocation only. No file in your repository is written.' }
      : null;

  const queryUsed = result ? readQueryProvided(result) ?? askedWithQuery : null;
  const storeEmpty = read.observed && items.every((item) => item.status !== 'active');
  // Four different facts, four different fixes. They are ordered by how early
  // they cut the pipeline: an empty store, then an ineligible retrieval, then
  // items that ranked and were held, then a retrieval that simply matched none.
  const nothingBecause = !result || result.entries.length > 0 ? null
    : storeEmpty
      ? { title: 'Nothing would be injected — this scope stores no active knowledge item',
          body: 'Retrieval had nothing to rank. Approve a proposal in the Inbox to create the first item.' }
      : queryUsed === false
        ? { title: 'Nothing would be injected — retrieval ran without a task query',
            body: askedWithQuery
              ? 'Nothing in your text survived as a search term and no path could be inferred from it, so only standing artifacts (mission-kind items) were eligible — and none is active in this scope.'
              : 'A launch with no initial prompt has nothing to be relevant to, so only standing artifacts (mission-kind items) are eligible. Project- and path-scoped knowledge is not swept in.' }
        : result.omitted > 0
          ? { title: 'Nothing would be injected — everything that ranked was held back',
              body: 'Items matched this query and none of them shipped. The reasons are listed below, and each has its own fix.' }
          : { title: 'Nothing would be injected — retrieval ran and matched nothing',
              body: 'No active knowledge ranked for this query in this scope. That is a recorded outcome, not an error — a broader query or a wider scope may match.' };

  return (
    <section className="card learning-card">
      <div className="learning-card-head">
        <div>
          <span className="label">Injected payload · verbatim</span>
          <h2>What lands in the next session’s prompt</h2>
        </div>
        {result && (
          <span className="learning-status muted">
            {result.entries.length} entr{result.entries.length === 1 ? 'y' : 'ies'}
          </span>
        )}
      </div>
      <p>
        This is the same retrieval a session launch runs, against the scope selected above. The text
        below is the exact string, not a summary of it. Which flag carries it depends on the
        profile’s harness, stated underneath.
      </p>
      <div className="inspector-form">
        <input className="field" value={query} onChange={(e) => setQuery(e.target.value)}
               onKeyDown={(e) => { if (e.key === 'Enter') void run(query.trim()); }}
               placeholder="The task a session would start with — or leave empty for a prompt-less launch…" />
        <select className="field" value={providerId} onChange={(e) => setProviderId(e.target.value)} aria-label="Provider profile">
          {providers.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
        <button className="btn btn-primary" disabled={running || !providerId} onClick={() => void run(query.trim())}>
          {running ? 'Retrieving…' : 'Show the payload'}
        </button>
      </div>
      {providers.length === 0 && (
        <p className="faint">No launch profile was detected, so there is no provider to compose a payload for.</p>
      )}
      {err && <p className="learning-status bad">✕ {err}</p>}
      {!result && !err && (running
        ? <Loading what="the composed payload" />
        : providers.length > 0 ? <p className="faint">Choose a profile to compose the payload.</p> : null)}
      {result && (result.text
        ? (
          <>
            <pre className="payload-text">{result.text}</pre>
            <p className="faint">
              {/* The character count is observed; the token figure is the
                  bytes÷4 heuristic and keeps the mark and the word. */}
              {result.text.length.toLocaleString()} characters · ~{result.estimatedTokens.toLocaleString()} est.
              tokens of the {settings.briefingMaxTokens.toLocaleString()}-token ceiling.{' '}
              {queryUsed === false && 'Retrieval ran with no task query, so only standing artifacts were eligible.'}
            </p>
          </>
        )
        : nothingBecause && (
          <Empty title={nothingBecause.title} body={nothingBecause.body} />
        ))}
      {result && result.omitted > 0 && <HeldBackList briefing={result} />}
      {delivery
        ? (
          <div className="payload-delivery">
            <span className="label">Delivered as</span>
            <code className="mono">{delivery.flag}</code>
            <p className="faint">{delivery.words}</p>
          </div>
        )
        : (
          <p className="faint">
            {profile
              ? <>This profile declares the harness <span className="mono">{harness ?? 'none'}</span>. Wanigan injects a
                  briefing only for the Claude Code and Codex harnesses, so a session on this profile receives
                  none — the payload above is what retrieval composed, not what it would deliver.</>
              : 'No profile is selected, so which flag would carry the payload is unknown.'}
          </p>
        )}
      <p className="faint">
        Previewing changes nothing: only a real launch quarantines a stale-cited item.{' '}
        <button className="learning-link" onClick={() => onNavigate('context')}>
          Open Context
        </button>{' '}
        for the per-entry cost and the token ceiling that shaped this.
      </p>
    </section>
  );
}

function Knowledge({ items, signals, providers, project, scopeParam, emptyFrame, settings, read, busy, act, refreshTick, onNavigate }: {
  items: KnowledgeItem[];
  signals: LearningSignal[];
  providers: ProviderInfo[];
  /** For the by-path grouping's hero; null under Personal-only scope. */
  project: Project | null;
  scopeParam: string | null | undefined;
  emptyFrame: string;
  settings: LearningSettings;
  /** Gates every list below: an unread store is not an empty one. */
  read: Read;
  busy: string | null;
  act: Act;
  onNavigate: (tab: LearningTab, inboxStatus?: string) => void;
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
    <div className="knowledge-tab">
      <Define term="Knowledge item">
        is a canonical, versioned record with its evidence — the source of truth. Provider files are
        reversible copies of it, never a second database. Retirement is a status change, not a
        deletion: a <b>retired</b> item keeps every version, citation and projection, and simply
        stops being retrieved and injected.
      </Define>
      <PayloadPanel providers={providers} scopeParam={scopeParam} settings={settings}
                    items={items} read={read} onNavigate={onNavigate} />
      <div className="learning-split">
      <section className="learning-list-pane">
        <div className="knowledge-groupbar card" role="group" aria-label="Group knowledge">
          <span className="label">Group</span>
          <div className="learning-seg">
            <button type="button" aria-pressed={grouping === 'list'} onClick={() => setGrouping('list')}>List</button>
            <button type="button" aria-pressed={grouping === 'path'} onClick={() => { setGrouping('path'); setPicked([]); }}>By path</button>
          </div>
        </div>
        {!read.observed ? (
          read.phase === 'error'
            ? <ReadFailed what="the knowledge store" read={read} />
            : <Loading what="the knowledge store" />
        ) : grouping === 'path' ? (
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
        {!sel ? <Empty title="Select a knowledge item" body="Its full text, evidence, versions and freshness appear here. Relations, projection history and measured ROI appear only once that item has any — they are optional records, not missing ones." />
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

          {/* Both wings below appear only when they hold rows. A permanent
              “no projections were written for this item” reads as a defect in
              the item, when projecting is an optional step nobody has taken;
              the same for a never-measured metric printed as a measured zero. */}
          {detail.projections.length > 0 && (
            <>
              <h3>Projection history</h3>
              <div className="evidence-list">{detail.projections.map((p) => <div key={p.id}><strong>{p.providerId} → <span className="mono">{p.targetPath}</span></strong><small>{p.status} · {when(p.appliedAt ?? p.createdAt)}</small>{p.status === 'applied' && <button className="btn" disabled={busy !== null} onClick={() => void act(`undo-${p.id}`, () => window.wanigan.learning.undoProjection(p.id), 'Projection undone because the applied hash still matched. Canonical knowledge remains.')}>Undo</button>}</div>)}</div>
              {detail.projections.length === 100 && <p className="faint">Showing the newest 100 projections — older ones are not listed here.</p>}
            </>
          )}

          {detail.roi.samples > 0 && (
            <>
              <h3>Measured ROI</h3>
              {/* metricCounts gates each figure: 0 rows means "never measured", and a never-measured metric must not print as a measured zero. */}
              <p className="faint">
                {detail.roi.samples} recorded sample{pl(detail.roi.samples)}
                {detail.roi.metricCounts.tokensLoaded > 0 && <> · tokens loaded ~{detail.roi.tokensLoaded.toLocaleString()} est.</>}
                {detail.roi.metricCounts.uses > 0 && <> · {detail.roi.successfulUses} successful use{pl(detail.roi.successfulUses)} · {detail.roi.failedUses} failed</>}
                {detail.roi.metricCounts.tokensSaved > 0 && <> · tokens saved{' '}
                  {detail.roi.evidenceLevel === 'causal'
                    ? detail.roi.tokensSaved.toLocaleString()
                    : `~${detail.roi.tokensSaved.toLocaleString()} est.`}</>}
                {(detail.roi.metricCounts.uses === 0 || detail.roi.metricCounts.tokensSaved === 0) && <> · no use outcomes or savings recorded yet</>}
                {' '}· evidence <span className="mini-badge">{detail.roi.evidenceLevel}</span> — only causal experiments are labelled verified.
              </p>
            </>
          )}
        </>}
      </aside>
      </div>
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

/* ── Context · what retrieval costs, and the controls that bound it ───── */

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

function BriefingInspector({ providers, scopeParam, settings, onNavigate }: {
  providers: ProviderInfo[];
  scopeParam: string | null | undefined;
  settings: LearningSettings;
  onNavigate: (tab: LearningTab, inboxStatus?: string) => void;
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
      <p className="faint">
        Previewing never changes an item’s status; only a real launch quarantines stale items.{' '}
        <button className="learning-link" onClick={() => onNavigate('knowledge')}>Knowledge</button>{' '}
        shows the same retrieval as the literal text a session receives.
      </p>
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

function ContextTab({ diagnostics, settings, providers, scopeParam, emptyFrame, read, busy, act, onNavigate }: {
  diagnostics: OptimizerDiagnostic[];
  settings: LearningSettings;
  providers: ProviderInfo[];
  scopeParam: string | null | undefined;
  emptyFrame: string;
  read: Read;
  busy: string | null;
  act: Act;
  onNavigate: (tab: LearningTab, inboxStatus?: string) => void;
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
  // 'unused' fires whenever an item is older than the window and no
  // invocation/use_success/use_failure row exists for it. Nothing in this build
  // writes those rows — the only production writer of artifact_metrics records
  // tokens_loaded — so the rule reduces to age and is not evidence of disuse.
  // It is counted rather than listed: a prominent false finding is worse than
  // no finding, and it was the most prominent one here.
  const unusedCount = diagnostics.filter((d) => d.kind === 'unused').length;
  const findings = diagnostics.filter((d) => d.kind !== 'unused');
  return (
    <div className="learning-stack">
      <BriefingInspector providers={providers} scopeParam={scopeParam} settings={settings}
                         onNavigate={onNavigate} />

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

      <section className="learning-grid two">
        <article className="card learning-card"><span className="label">Adaptive context router</span><h2>Load less, later</h2><p>Structured project/path scope and full-text ranking run locally first. Progressive skills and mission briefings receive a hard token ceiling.</p><label><span className="label">Briefing ceiling · tokens</span><input className="field" type="number" min={200} max={8000} value={ceilingDraft} onChange={(e) => setCeilingDraft(e.target.value)} onBlur={commitCeiling} onKeyDown={(e) => { if (e.key === 'Enter') commitCeiling(); }} /></label><label className="learning-check"><input type="checkbox" className="learning-switch" checked={settings.consolidationEnabled} onChange={(e) => void save({ consolidationEnabled: e.target.checked })} /> Consolidate while Wanigan or its daemon is active</label></article>
        <article className="card learning-card"><span className="label">Learning budget governor</span><h2>Deterministic-only today</h2><p>Classification, hashing, routing, and diagnostics run locally without a model call. The stored opt-in and monthly ceiling reserve an explicit boundary for a future model-assisted consolidator; they do not spend or launch one in this build.</p><label className="learning-check"><input type="checkbox" className="learning-switch" checked={settings.allowModelAssistance} disabled /> Model-assisted extraction (not connected yet)</label><label><span className="label">Reserved monthly ceiling · USD</span><input className="field" type="number" min={0} step="0.25" value={settings.monthlyBudgetUsd} disabled /></label><p className="faint">Wanigan will not imply this control is active before usage metering and provider-specific consent are wired end to end.</p></article>
      </section>

      {/* Diagnosis sits below the controls it cannot change. It reads the same
          rows as everything else on this page, so it shares the same read. */}
      <section className="card learning-card">
        <div className="learning-card-head">
          <div>
            <span className="label">Context Budget Doctor · Cache Guardian · Garbage Collector</span>
            <h2>
              {read.observed ? `${findings.length} finding${pl(findings.length)}`
                : read.phase === 'error' ? '— findings, not read' : '… reading findings'}
            </h2>
          </div>
          <span className="learning-status muted">diagnosis only</span>
        </div>
        <Pane read={read} what="the context diagnostics">
          <div className="diagnostic-list">
            {findings.length === 0 && <Empty title="No context debt detected" body="Duplicate, contradictory, expired, oversized, drifting, or volatile artifacts will appear here." frame={emptyFrame} />}
            {findings.map((d, i) => <article key={`${d.kind}-${i}`} className={`diagnostic ${d.severity}`}><span aria-hidden="true">{d.severity === 'error' ? '✕' : d.severity === 'warning' ? '!' : 'i'}</span><div><strong>{d.title}</strong><p>{d.detail}</p><small>{d.kind} · {estTokens(d.estimatedTokenDelta)} · {d.itemIds.length} item{pl(d.itemIds.length)}</small></div></article>)}
          </div>
        </Pane>
        {read.observed && unusedCount > 0 && (
          <p className="faint">
            {unusedCount} item{pl(unusedCount)} also matched the “no recorded use” rule and {unusedCount === 1 ? 'is' : 'are'} not
            listed. Nothing in this build records a knowledge item being used, so that rule fires on
            age alone — it is not evidence that anything is unused.
          </p>
        )}
      </section>
      <p className="faint">These numbers are estimated until a controlled Context A/B experiment proves a causal saving. Wanigan does not call fewer tokens “better” unless the same evaluation still passes.</p>
    </div>
  );
}

function Experiments({ experiments, candidates, project, providers, busy, act, read, emptyFrame }: {
  experiments: LearningExperiment[];
  candidates: KnowledgeCandidate[];
  project: Project | null;
  providers: ProviderInfo[];
  busy: string | null;
  act: Act;
  read: Read;
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
      <section className="experiment-list"><Pane read={read} what="the experiment register"><>{experiments.length === 0 && <Empty title="No experiments yet" body="Create a draft to pin the comparison. Estimated and causal metrics stay visibly separate." frame={emptyFrame} />}{experiments.map((e) => <article className="card experiment-card" key={e.id}><div className="learning-card-head"><div><span className="label">{e.providerId} · {e.model}</span><h2>{e.name}</h2></div><span className={`learning-status ${e.status === 'completed' ? 'good' : e.status === 'failed' ? 'bad' : 'muted'}`}>{e.status}</span></div><p className="mono">commit {e.commitHash || 'un-pinned'} · effort {e.effort ?? 'default'}</p><small>Created {when(e.createdAt)} · started {when(e.startedAt)} · ended {when(e.endedAt)}</small><div className="learning-actions">{e.status === 'draft' && <button className="btn btn-primary" disabled={busy !== null} onClick={() => void act(`experiment-${e.id}`, () => window.wanigan.learning.setExperimentStatus(e.id, 'start'), 'Experiment marked running. Execute its pinned baseline and candidate workloads.')}>Start</button>}{e.status === 'running' && <button className="btn btn-primary" disabled={busy !== null} onClick={() => void act(`experiment-${e.id}`, () => window.wanigan.learning.setExperimentStatus(e.id, 'complete', { evidenceLevel: 'estimate', note: 'Closed from the workspace; paired metrics have not been ingested.' }), 'Experiment closed. Savings remain estimated until paired evaluation metrics prove a causal result.')}>Close run</button>}{['draft', 'running'].includes(e.status) && <button className="btn" disabled={busy !== null} onClick={() => void act(`experiment-${e.id}`, () => window.wanigan.learning.setExperimentStatus(e.id, 'cancel'), 'Experiment cancelled; its history remains.')}>Cancel</button>}</div></article>)}</></Pane></section>
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
