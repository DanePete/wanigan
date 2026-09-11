import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CodexAgentsChain, KnowledgeProjection, LearningOverview, LearningSettings, Project,
} from '@shared/types';
import { Chip, EmptyState, Explainer, Icon, Mark as SharedMark, Note, PageHead, Pill, Reading, SectionHead, Stat, ago, num, usd, type Tone } from '../components/bits';
import ContextWorkspace, { ContextFileLink } from '../components/ContextWorkspace';
import { useViewMemory } from '../components/viewMemory';

/**
 * "What will my agent actually know when it starts?"
 *
 * Everything here is a prediction read from disk before a session exists: the
 * CLAUDE.md chain in load order, the rules that will and will not fire, the
 * memory index and where it gets cut, the settings layer that won each key, the
 * hooks that will run, and what carrying all of it costs per session.
 *
 * Colour rules that are load-bearing, not taste:
 *  - Every status mark is a GLYPH plus a WORD; colour only reinforces. A rule
 *    that matches nothing and an AGENTS.md that never loads have to survive
 *    being read in greyscale.
 *  - Categorical chart colour is assigned by SLOT in fixed order (--series-1..4)
 *    and never reordered to suit meaning.
 *  - Every chart has a table under it, so identity never depends on colour.
 */

/* ── shapes ──────────────────────────────────────────────────────────────
   Mirrors of the exported types in src/main/context/{instructions,memory,
   config}.ts. The renderer cannot import from src/main, so they are
   re-declared here; if those modules change shape, change these with them. */

type InstructionScope = 'managed' | 'user' | 'ancestor' | 'project' | 'local' | 'rule' | 'import';

type InstructionFile = {
  path: string;
  scope: InstructionScope;
  exists: boolean;
  bytes: number;
  lines: number;
  order: number;
  depth: number;
  importedBy: string | null;
  external: boolean;
  conditional: { kind: 'paths'; globs: string[]; matchingFiles: number } | null;
  /** A second reference to content already counted once — its bytes never load again. */
  duplicate: boolean;
  warnings: string[];
  excludedBy: string | null;
};

type InstructionChain = {
  files: InstructionFile[];
  totalBytes: number;
  totalLines: number;
  atLaunch: InstructionFile[];
  onDemand: InstructionFile[];
  notes: string[];
  root: string;
  isGitRepo: boolean;
};

type MemoryKind = 'user' | 'feedback' | 'project' | 'reference' | 'unknown';

type MemoryFile = {
  name: string;
  path: string;
  kind: MemoryKind;
  description: string;
  bytes: number;
  lines: number;
  modified: number;
  modifiedFrontmatter: string | null;
  links: { name: string; exists: boolean }[];
  isIndex: boolean;
};

type IndexBudget = {
  lines: number; lineLimit: number;
  bytes: number; byteLimit: number;
  loadedLines: number; droppedLines: number;
  overBudget: boolean; note: string;
};

type MemoryState = {
  dir: string;
  exists: boolean;
  enabled: boolean;
  derivedFrom: 'git-repo' | 'project-root' | 'setting-override';
  index: MemoryFile | null;
  indexBudget: IndexBudget | null;
  files: MemoryFile[];
  counts: Record<MemoryKind, number>;
  danglingLinks: string[];
  orphans: string[];
  notes: string[];
};

type SettingsLayer = 'user' | 'project' | 'local' | 'managed';

type ResolvedSetting = {
  key: string;
  value: unknown;
  from: SettingsLayer;
  shadowed: { from: SettingsLayer; value: unknown }[];
};

type HookEntry = {
  event: string; matcher: string | null; type: string;
  summary: string; from: SettingsLayer | 'plugin'; source: string;
};

type McpEntry = { name: string; transport: string; target: string; from: 'project' | 'user'; source: string };

type AgentEntry = {
  name: string; description: string; path: string;
  scope: 'user' | 'project'; tools: string[]; model: string | null;
};

type CommandEntry = {
  name: string; description: string; path: string;
  scope: 'user' | 'project'; invoke: string;
};

type ProjectConfig = {
  settings: ResolvedSetting[];
  layers: { layer: SettingsLayer; path: string; exists: boolean; keys: number }[];
  hooks: HookEntry[];
  mcp: McpEntry[];
  agents: AgentEntry[];
  commands: CommandEntry[];
  permissions: { allow: string[]; deny: string[]; ask: string[]; from: SettingsLayer }[];
  notes: string[];
};

type ContextBudget = {
  files: { path: string; label: string; bytes: number; estTokens: number }[];
  totalBytes: number;
  /** Bytes on disk that do NOT load — past the 4 MiB skip. Kept out of totalBytes. */
  skippedBytes: number;
  estTokens: number;
  usdPerSession: number | null;
  model: string | null;
  note: string;
};

type AgentsMd = { present: boolean; imported: boolean; symlinked: boolean; note: string };

/* ── formatting ──────────────────────────────────────────────────────── */

const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)'];

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

const plural = (n: number, one: string, many = one + 's') => `${num(n)} ${n === 1 ? one : many}`;

const sep = (p: string) => Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
const fileName = (p: string) => (sep(p) < 0 ? p : p.slice(sep(p) + 1));
const dirName = (p: string) => (sep(p) < 0 ? '' : p.slice(0, sep(p) + 1));

const fullDate = (ts: number) =>
  new Date(ts).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });

/* ── marks: glyph + word + colour, in that order of importance ───────── */

const SCOPE: Record<InstructionScope, { glyph: string; word: string; color: string; blurb: string }> = {
  managed:  { glyph: '⛨', word: 'managed',  color: 'var(--serious)',
              blurb: 'Set by machine policy. It cannot be excluded or edited from here.' },
  user:     { glyph: '⌂', word: 'user',     color: 'var(--series-1)',
              blurb: 'From your home directory. It loads in every project you open, not just this one.' },
  ancestor: { glyph: '↑', word: 'ancestor', color: 'var(--warning)',
              blurb: 'From a directory ABOVE this project. It loads before the project’s own memory — this is the file people forget is there.' },
  project:  { glyph: '◆', word: 'project',  color: 'var(--series-3)',
              blurb: 'Committed to the repository. Everyone who clones it gets this.' },
  local:    { glyph: '○', word: 'local',    color: 'var(--series-4)',
              blurb: 'A .local file. Yours, on this machine, not shared.' },
  rule:     { glyph: '§', word: 'rule',     color: 'var(--series-2)',
              blurb: 'A file in a rules directory.' },
  import:   { glyph: '↳', word: 'import',   color: 'var(--text-dim)',
              blurb: 'Pulled in by an @import from another instruction file.' },
};

type Loads = 'launch' | 'demand' | 'excluded' | 'missing' | 'duplicate' | 'skipped';

const LOADS: Record<Loads, { glyph: string; word: string; color: string; blurb: string }> = {
  launch:   { glyph: '●', word: 'at launch', color: 'var(--good)',
              blurb: 'In context before the first prompt.' },
  demand:   { glyph: '◑', word: 'on demand', color: 'var(--series-1)',
              blurb: 'Loads only when Claude touches a matching path.' },
  excluded: { glyph: '⊘', word: 'excluded',  color: 'var(--serious)',
              blurb: 'Removed by claudeMdExcludes. It never reaches the agent.' },
  missing:  { glyph: '·', word: 'missing',   color: 'var(--text-faint)',
              blurb: 'Referenced but not on disk.' },
  duplicate:{ glyph: '◇', word: 'duplicate', color: 'var(--text-faint)',
              blurb: 'A second listing of content already loaded once. Inert — it never loads again.' },
  skipped:  { glyph: '✕', word: 'skipped',   color: 'var(--critical)',
              blurb: 'Over the 4 MiB ceiling, so it is skipped whole — not truncated.' },
};

const LAYER: Record<SettingsLayer | 'plugin', { glyph: string; word: string; color: string }> = {
  user:    { glyph: '⌂', word: 'user',    color: 'var(--series-1)' },
  project: { glyph: '◆', word: 'project', color: 'var(--series-3)' },
  local:   { glyph: '○', word: 'local',   color: 'var(--series-4)' },
  managed: { glyph: '⛨', word: 'managed', color: 'var(--serious)' },
  plugin:  { glyph: '⧉', word: 'plugin',  color: 'var(--series-2)' },
};

/* Kind is categorical, so its colours are assigned by slot in a fixed order. */
const KIND: Record<MemoryKind, { glyph: string; word: string; color: string }> = {
  user:      { glyph: '⌂', word: 'user',      color: SERIES[0] },
  feedback:  { glyph: '✎', word: 'feedback',  color: SERIES[1] },
  project:   { glyph: '◆', word: 'project',   color: SERIES[2] },
  reference: { glyph: '❖', word: 'reference', color: SERIES[3] },
  unknown:   { glyph: '·', word: 'unknown',   color: 'var(--text-faint)' },
};

function Mark({glyph,word,color,title}: {glyph:string;word:string;color:string;title?:string}) {
  const tones: Record<string,Tone> = {'var(--good)':'ok','var(--warning)':'warn','var(--serious)':'serious','var(--critical)':'bad'};
  return <SharedMark glyph={glyph} word={word} tone={tones[color] ?? 'quiet'} title={title}/>;
}

function ManagedChip() {
  return <Pill status="Wanigan-managed" tone="quiet" reason="Written by an approved knowledge projection. Hash-guarded and reversible from Learning."/>;
}

function Callout({level='warning',title,children}: {level?:'warning'|'critical';title:React.ReactNode;children?:React.ReactNode}) {
  return <Note tone={level==='critical'?'error':'warn'}><div className="ctx-callout"><strong>{title}</strong>{children&&<div>{children}</div>}</div></Note>;
}

function Bullets({ items }: { items: string[] }) {
  if (!items.length) return null;
  return (
    <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 5, marginTop: 4 }}>
      {items.map((t) => (
        <li key={t} className="dim" style={{ display: 'flex', gap: 7, fontSize: 'var(--t-small)', lineHeight: 1.5 }}>
          <span className="faint" aria-hidden="true">·</span><span>{t}</span>
        </li>
      ))}
    </ul>
  );
}

/** One failed channel, said in a sentence with the thing to do about it. */
function PanelError({channel,detail,onRetry}: {channel:string;detail:string;onRetry:()=>void}) {
  return <Callout level="critical" title="This part of the context could not be read.">
    <p>{detail}</p><p>Check that the project folder is available, then re-scan.</p>
    <button className="btn" type="button" onClick={onRetry} aria-label={`Retry ${channel}`}>Try again</button>
  </Callout>;
}

/* ── the seven slots, for the empty state ────────────────────────────── */

type SlotKey = 'chain' | 'rules' | 'agents' | 'memory' | 'config' | 'budget' | 'learning';

const SLOTS: { n: number; key: SlotKey; title: string; what: string; how: string }[] = [
  { n: 1, key: 'chain', title: 'CLAUDE.md',
    what: 'The instructions every session in this repo starts with, plus anything inherited from directories above it and from your home directory.',
    how: 'Run /init in a session to write one from what is actually in the repo, or create CLAUDE.md at the repo root by hand.' },
  { n: 2, key: 'rules', title: '.claude/rules/',
    what: 'Rules that load only when Claude touches matching paths — the way to give a subsystem its own instructions without paying for them in every session.',
    how: 'Add .claude/rules/<name>.md with a paths: key in its front matter. Without paths: it loads at launch like any other memory.' },
  { n: 3, key: 'agents', title: 'AGENTS.md',
    what: 'The cross-tool instruction file. Claude Code does not read it on its own — it reaches context only through an import or a symlink.',
    how: 'If you keep one, add a line reading @AGENTS.md to CLAUDE.md, or make CLAUDE.md a symlink to it.' },
  { n: 4, key: 'memory', title: 'MEMORY.md and memories',
    what: 'What Claude carries between sessions. The index is capped at 200 lines / 25 KB and the tail past the cut is dropped silently.',
    how: 'Claude Code writes these itself the first time it saves a memory for this project. Nothing to create by hand.' },
  { n: 5, key: 'config', title: '.claude/settings.json',
    what: 'Settings, permissions, hooks, MCP servers, subagents and slash commands — everything a project injects besides prose.',
    how: 'Create .claude/settings.json for shared settings, .claude/settings.local.json for machine-only ones.' },
  { n: 6, key: 'budget', title: 'Startup budget',
    what: 'Estimated tokens and cost of carrying all of the above at the start of every single session.',
    how: 'Fills in on its own as soon as anything above it exists.' },
  { n: 7, key: 'learning', title: 'Learning briefing',
    what: 'A token-bounded, cited capsule of approved knowledge retrieved per task.',
    how: 'Approve proposals in the Learning Inbox; sessions then receive relevant items automatically.' },
];

/* ── the view ────────────────────────────────────────────────────────── */

type Errors = Partial<Record<'instructions' | 'memory' | 'config' | 'agents' | 'budget', string>>;

type Data = {
  readAt: number;
  chain: InstructionChain | null;
  memory: MemoryState | null;
  config: ProjectConfig | null;
  agents: AgentsMd | null;
  /** The Codex compiler's AGENTS.md targets. Null when the read failed — the block hides. */
  codexAgents: CodexAgentsChain | null;
  budget: ContextBudget | null;
  /** Applied knowledge projections keyed by targetPath. Empty when the read failed — the badge simply does not show. */
  managed: Map<string, KnowledgeProjection>;
  /** Learning engine reads are non-fatal: null means "not read this scan", never "zero". */
  learn: { settings: LearningSettings | null; overview: LearningOverview | null };
  errors: Errors;
};

export default function Context(props: Parameters<typeof ContextProject>[0]) {
  const project = props.projects.find(row=>row.id===props.projectId) ?? props.projects[0];
  return <ContextProject key={project ? `${project.id}:${project.path}` : 'no-project'} {...props}/>;
}

function ContextProject({ projectId, projects, projectsRead, onReloadProjects, onOpenLearning, onPickProject }: {
  projectId?: string;
  onPickProject: (id: string) => void;
  projects: Project[];
  /** False until the shell's project list has come back at least once. An
   *  empty array on its own cannot tell "you have no projects" from "the read
   *  failed", and this view states one of those as fact. Git takes the same
   *  flag for the same reason. */
  projectsRead: boolean;
  onReloadProjects: () => Promise<void>;
  onOpenLearning: (tab: 'overview' | 'inbox' | 'knowledge' | 'optimize') => void;
}) {
  const project = useMemo(() => projects.find((p) => p.id === projectId) ?? projects[0] ?? null, [projects, projectId]);
  const setPinned = (id: string | null) => { if (id) onPickProject(id); };

  const [d, setD] = useState<Data | null>(null);
  const read = useRef(0);
  const alive = useRef(true);
  const sending = useRef(false);
  const [initBusy,setInitBusy] = useState(false);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;read.current+=1;};},[]);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [initMsg, setInitMsg] = useState<{ tone: 'ok' | 'info'; text: string } | null>(null);

  /* The empty state's escape hatch: ask App to re-read the saved project list.
     A failure keeps the last-good (empty) list rather than raising a banner. */
  const checkProjects = useCallback(async () => {
    setChecking(true);
    try { await onReloadProjects(); } catch { /* ignore */ }
    setChecking(false);
  }, [onReloadProjects]);

  const path = project?.path;
  const pid = project?.id;

  const load = useCallback(async (rescan: boolean) => {
    if (!path) { setD(null); return; }
    const mine=++read.current;
    setBusy(true);
    // A stale cache is not worth an error banner of its own.
    if (rescan) { try { await window.wanigan.context.refresh(path); } catch { /* ignore */ } }

    if(mine!==read.current || !alive.current)return;
    const errors: Errors = {};
    // The three learning reads are additive colour on this view, not its
    // subject, so they degrade silently: a failure hides the badge or section
    // instead of raising a banner.
    const [ri, rm, rc, ra, rcx, rp, rls, rlo] = await Promise.allSettled([
      window.wanigan.context.instructions(path),
      window.wanigan.context.memory(path),
      window.wanigan.context.config(path),
      window.wanigan.context.agentsMd(path),
      // The Codex half of this section. Degrades silently like the learning
      // reads below: it is additional colour on a view whose subject is the
      // Claude Code loader, and a failure should hide it rather than raise a
      // banner about a harness the operator may not even use here.
      window.wanigan.context.codexAgents(pid ?? null, path),
      window.wanigan.learning.projections({ status: 'applied', limit: 500 }),
      window.wanigan.learning.settings(),
      window.wanigan.learning.overview(pid ?? null),
    ]);

    if(mine!==read.current || !alive.current)return;
    const chain = ri.status === 'fulfilled' ? (ri.value as InstructionChain) : null;
    if (ri.status === 'rejected') errors.instructions = msg(ri.reason);
    const memory = rm.status === 'fulfilled' ? (rm.value as MemoryState) : null;
    if (rm.status === 'rejected') errors.memory = msg(rm.reason);
    const config = rc.status === 'fulfilled' ? (rc.value as ProjectConfig) : null;
    if (rc.status === 'rejected') errors.config = msg(rc.reason);
    const agents = ra.status === 'fulfilled' ? (ra.value as AgentsMd) : null;
    if (ra.status === 'rejected') errors.agents = msg(ra.reason);
    const codexAgents = rcx.status === 'fulfilled' ? (rcx.value as CodexAgentsChain) : null;

    const applied = rp.status === 'fulfilled' ? (rp.value as KnowledgeProjection[]) : [];
    const managed = new Map(applied.map((p) => [p.targetPath, p] as const));
    const learn = {
      settings: rls.status === 'fulfilled' ? (rls.value as LearningSettings) : null,
      overview: rlo.status === 'fulfilled' ? (rlo.value as LearningOverview) : null,
    };

    // The budget prices exactly what loads at launch, at whatever model the
    // settings chain actually selected — not a default we invented. Files the
    // scanner found but marked skipped-whole (over the 4 MiB ceiling — present
    // in chain.files, absent from atLaunch/onDemand) ride along too: the main
    // process prices them at 0 tokens and reports their size as skippedBytes,
    // so the "Skipped whole" tile can actually fire.
    let budget: ContextBudget | null = null;
    if (chain) {
      const loads = new Set([...chain.atLaunch, ...chain.onDemand].map((f) => f.order));
      const skippedWhole = chain.files.filter(
        (f) => f.exists && !f.excludedBy && !f.duplicate && !loads.has(f.order),
      );
      if (chain.atLaunch.length || skippedWhole.length) {
        const picked = config?.settings.find((s) => s.key === 'model' && typeof s.value === 'string');
        const model = picked ? String(picked.value) : undefined;
        const files = [...chain.atLaunch, ...skippedWhole]
          .map((f) => ({ path: f.path, label: `${SCOPE[f.scope].word} · ${fileName(f.path)}` }));
        try { budget = (await window.wanigan.context.budget(path, files, model)) as ContextBudget; }
        catch (e) { errors.budget = msg(e); }
      }
    }

    if(mine!==read.current || !alive.current)return;
    setD({ readAt:Date.now(), chain, memory, config, agents, codexAgents, budget, managed, learn, errors });
    setBusy(false);
  }, [path, pid]);

  useEffect(() => { setD(null); setInitMsg(null); void load(false); }, [load]);

  /* Section 7 follows the engine live: a learningChanged push re-reads ONLY
     the learning settings/overview and swaps them into the current render —
     no re-scan of the chain, no loading flash. A failed quiet read keeps the
     last-good values rather than flashing the section away. */
  useEffect(() => {
    let live = true;
    let timer: number | undefined;
    const refetch = async () => {
      const [rls, rlo] = await Promise.allSettled([
        window.wanigan.learning.settings(),
        window.wanigan.learning.overview(pid ?? null),
      ]);
      if (!live) return;
      setD((prev) => prev === null ? prev : {
        ...prev,
        learn: {
          settings: rls.status === 'fulfilled' ? (rls.value as LearningSettings) : prev.learn.settings,
          overview: rlo.status === 'fulfilled' ? (rlo.value as LearningOverview) : prev.learn.overview,
        },
      });
    };
    const off = window.wanigan.on.learningChanged(() => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => { timer = undefined; void refetch(); }, 1000);
    });
    return () => { live = false; off(); if (timer !== undefined) window.clearTimeout(timer); };
  }, [pid]);

  async function runInit() {
    if (!project || sending.current) return;
    sending.current=true;setInitBusy(true);
    try {
      const list = await window.wanigan.sessions.list();
      if(!alive.current)return;
      // The session must be on the Claude Code harness: /init is its command,
      // and skills:send refuses every other harness by name. Picking the first
      // running session regardless meant a project whose only live agent was
      // Codex failed with a message about skill invocation forms.
      const s = list.find((x) => x.projectId === project.id && x.status === 'running'
        && (x.harnessId ?? x.providerProfile?.harness) === 'claude-code');
      if (!s) {
        setInitMsg({ tone: 'info', text:
          `No Claude Code session is running in ${project.name}. /init is Claude Code's own command, so it needs one: open Sessions, start one with ⌘T, then come back — this button types /init into a live session, it does not start one.` });
        return;
      }
      await window.wanigan.skills.send(s.id, '/init');
      setInitMsg({ tone: 'ok', text:
        `Typed /init into the running session in ${project.name}. Switch to Sessions and press Enter to run it — it writes a CLAUDE.md from what is actually in the repo, and you review the diff before it lands.` });
    } catch (e) {
      setInitMsg({ tone: 'info', text: `Could not reach a session: ${msg(e)}. Run /init yourself in a session in ${project.name}.` });
    } finally {sending.current=false;setInitBusy(false);}
  }

  /* Empty: no projects at all. Not the same as a project with nothing in it —
     and "reading the list right now" is a third state, not a claim of empty.
     So is "the read failed", which is a fourth: `checking` is only true while
     this view's own Check for projects button is in flight, so a shell read
     that never came back left the branch below stating "No projects yet" as
     fact. That is the one sentence this view must not invent — it is the
     answer to "what is Wanigan configured to work on". */
  if (projects.length === 0 || !project) {
    /* One heading and one paragraph, picked from the three states, rather than
       three copies of the same two elements: the card looked identical in each
       branch and only the words differed. */
    const empty = checking
      ? {
          title: 'Reading projects…',
          body: <>
            Asking the main process for the saved project list. Anything added in Sessions since
            this view loaded will show up here.
          </>,
        }
      : !projectsRead
        ? {
            title: 'Your project list has not been read yet',
            body: <>
              This is not a count of your projects. Wanigan reads the list when the window opens and
              again when it regains focus; if that read failed, the message at the bottom of the window
              carries the error and the button that runs it again.
            </>,
          }
        : {
            title: 'No projects yet',
            body: <>
              This view reads a project folder from disk and shows what a session launched in it would
              be told before you type anything. Add a folder in Sessions and it appears here.
            </>,
          };
    return (
      <div className="pane wide ctx ctx-view">
        <Head project={null} projects={projects} onPick={setPinned}
              onRescan={() => load(true)} busy={busy} />
        <EmptyState posture={!projectsRead?'could-not-read':'nothing-yet'} title={empty.title} cue={empty.body}
          action={<button className="btn" type="button" disabled={checking} onClick={()=>void checkProjects()}>
            {checking?'Reading projects…':'Check for projects'}</button>}/>

      </div>
    );
  }

  /* Loading: a real state, not an empty one. */
  if (!d) {
    return (
      <div className="pane wide ctx ctx-view">
        <Head project={project} projects={projects} onPick={setPinned}
              onRescan={() => load(true)} busy={busy} />
        <Reading what="the instruction chain, memory and settings"/>

      </div>
    );
  }

  const e = d.errors;
  const allFailed = !d.chain && !d.memory && !d.config && !d.agents;

  if (allFailed) {
    return (
      <div className="pane wide ctx ctx-view" key={project.id}>
        <Head project={project} projects={projects} onPick={setPinned}
              onRescan={() => load(true)} busy={busy} />
        <Callout level="critical" title={`Wanigan could not read anything about ${project.name}.`}>
          <p>
            Check that the project folder is still available and readable. Choose another project,
            or try the scan again.
          </p>
          <ul style={{ listStyle: 'none', marginTop: 8, display: 'flex', flexDirection: 'column', gap: 3 }}>
            {([['context:instructions', e.instructions], ['context:memory', e.memory],
               ['context:config', e.config], ['context:agentsMd', e.agents]] as const).map(([ch, detail]) => (
              <li key={ch} className="mono" style={{ fontSize: 'var(--t-small)', wordBreak: 'break-word' }}>
                <span className="faint">{ch}</span> — {detail ?? 'no detail'}
              </li>
            ))}
          </ul>
          <button className="btn" style={{ marginTop: 10 }} onClick={() => load(true)} disabled={busy}>
            {busy ? 'Re-scanning…' : 'Try again'}
          </button>
        </Callout>
      </div>
    );
  }

  const chain = d.chain;
  const rules = chain ? chain.files.filter((f) => f.scope === 'rule' || f.conditional) : [];

  const inProject = (p: string) =>
    p === project.path || p.startsWith(project.path + '/') || p.startsWith(project.path + '\\');

  /* The learning section shows when this project has any learning data, or the
     engine is on and would inject a briefing. Failed reads leave both null, so
     the section quietly stays away rather than showing invented zeros. */
  const ov = d.learn.overview;
  const hasLearning = (!!ov && (ov.activeKnowledge > 0 || ov.quarantined > 0 || ov.pending > 0
      || ov.signals > 0 || ov.activeSkills > 0)) || !!d.learn.settings?.enabled;

  /* A panel shows when it has anything to say — inherited files included, because
     "a CLAUDE.md in your home directory is loading into this repo" is exactly the
     kind of thing this view exists to surface. */
  const shows: Record<SlotKey, boolean> = {
    chain:  !!chain && chain.files.length > 0,
    rules:  rules.length > 0,
    agents: !!d.agents?.present,
    memory: !!d.memory && d.memory.exists && (d.memory.files.length > 0 || !!d.memory.index),
    config: !!d.config && (d.config.settings.length > 0 || d.config.hooks.length > 0 || d.config.mcp.length > 0
            || d.config.agents.length > 0 || d.config.commands.length > 0 || d.config.layers.some((l) => l.exists)),
    budget: !!d.budget && d.budget.files.length > 0,
    learning: hasLearning,
  };

  /* A SLOT is filled only by something this project owns. Inheriting a memory
     file from your home directory is not the same as the repo having one, and
     offering /init is the whole point of saying so. */
  const filled: Record<SlotKey, boolean> = {
    chain:  !!chain && chain.files.some((f) => f.exists && (f.scope === 'project' || f.scope === 'local') && inProject(f.path)),
    rules:  rules.some((r) => inProject(r.path)),
    agents: !!d.agents?.present,
    memory: shows.memory,
    config: !!d.config && (
      d.config.layers.some((l) => l.exists && (l.layer === 'project' || l.layer === 'local'))
      || d.config.hooks.some((h) => h.from === 'project' || h.from === 'local')
      || d.config.mcp.some((m) => m.from === 'project')
      || d.config.agents.some((a) => a.scope === 'project')
      || d.config.commands.some((x) => x.scope === 'project')),
    budget: shows.budget,
    learning: hasLearning,
  };
  const errored: Record<SlotKey, string | undefined> = {
    chain: e.instructions, rules: e.instructions, agents: e.agents,
    memory: e.memory, config: e.config, budget: e.budget, learning: undefined,
  };
  const unfilled = SLOTS.filter((s) => !filled[s.key] && !errored[s.key]);

  const emptyArea = (key:SlotKey) => <Setup project={project} slots={SLOTS.filter(slot=>slot.key===key)}
    onInit={runInit} initMsg={initMsg} busy={initBusy}/>;
  const panels = {
    chain:e.instructions?<PanelError channel="instructions" detail={e.instructions} onRetry={()=>load(true)}/>
      :shows.chain&&chain?<InstructionsPanel chain={chain} managed={d.managed}/>:emptyArea('chain'),
    rules:e.instructions?<PanelError channel="rules" detail={e.instructions} onRetry={()=>load(true)}/>
      :shows.rules?<RulesPanel rules={rules} root={project.path} managed={d.managed} chain={chain!}/>:emptyArea('rules'),
    agents:<>{e.agents?<PanelError channel="AGENTS.md" detail={e.agents} onRetry={()=>load(true)}/>
      :d.agents?.present?<AgentsPanel a={d.agents} managed={d.managed} root={project.path}/>:emptyArea('agents')}
      {d.codexAgents&&<CodexAgentsPanel c={d.codexAgents}/>}</>,
    memory:e.memory?<PanelError channel="memory" detail={e.memory} onRetry={()=>load(true)}/>
      :shows.memory&&d.memory?<MemoryPanel m={d.memory}/>:emptyArea('memory'),
    config:e.config?<PanelError channel="settings" detail={e.config} onRetry={()=>load(true)}/>
      :shows.config&&d.config?<ConfigPanel c={d.config}/>:emptyArea('config'),
    budget:e.instructions?<PanelError channel="instructions for the budget" detail={e.instructions} onRetry={()=>load(true)}/>
      :e.budget?<PanelError channel="budget" detail={e.budget} onRetry={()=>load(true)}/>
      :shows.budget&&d.budget?<BudgetPanel b={d.budget}/>:emptyArea('budget'),
    learning:<LearningPanel settings={d.learn.settings} overview={d.learn.overview} onOpenLearning={onOpenLearning}/>,
  };
  const knownSources=[...(chain?.files.filter(file=>file.exists).map(file=>file.path)??[]),
    ...(d.memory?.files.map(file=>file.path)??[]),...(d.memory?.index?[d.memory.index.path]:[])];
  return <div className="pane wide ctx ctx-view">
    <Head project={project} projects={projects} onPick={setPinned} onRescan={()=>load(true)} busy={busy}/>
    <ContextWorkspace projectId={project.id} panels={panels} scan={d.readAt} knownSources={knownSources}
      hints={{chain:'The Claude Code instruction chain, in the order it is resolved.',
        rules:'Which instructions load at launch, and which wait for matching files.',
        agents:'How AGENTS.md reaches Claude Code, plus Wanigan’s Codex compiler targets.',
        memory:'Claude Code’s launch index and the topic files it leads to. This is a read-only view.',
        config:'Claude Code’s winning settings, their source layers, and commands that can run.',
        budget:'Estimated instruction-file input for Claude Code. These figures are not measured usage.',
        learning:'Approved knowledge available to the launch-time briefing.'}}
      counts={{chain:chain?.files.length,rules:chain?rules.length:undefined,
        memory:d.memory?.files.length,config:d.config?.settings.length}}
      issues={{chain:!!e.instructions||!!chain?.files.some(file=>file.warnings.length),
        rules:!!e.instructions||rules.some(rule=>rule.conditional?.matchingFiles===0),
        agents:!!e.agents||!!(d.agents?.present&&!d.agents.imported&&!d.agents.symlinked),
        memory:!!e.memory||!!d.memory?.indexBudget?.overBudget,
        config:!!e.config,budget:!!e.budget||!!e.instructions}}
      guide={<Explainer id="context-reading-guide" title="About this reading" defaultHidden>
        This predicts the Claude Code loader from local files, including profiles that use that harness.
        It does not measure a running session. Codex’s launch order is not predicted here.
        Readers may use a short-lived cache; Re-scan requests a fresh reading.
        {unfilled.length>0&&<p>{unfilled.length} areas have no project-owned content. Select an area for its setup guidance.</p>}
      </Explainer>}/>
  </div>;
}

function Head({project,projects,onPick,onRescan,busy}: {
  project:Project|null;projects:Project[];onPick:(id:string)=>void;onRescan:()=>void;busy:boolean;
}) {
  return <PageHead compact title="Context" lead="The files and knowledge behind your next session."
    actions={<>{project&&<select className="field field-inline" aria-label="Context project" value={project.id}
      onChange={event=>onPick(event.target.value)}>{projects.map(row=><option key={row.id} value={row.id}>{row.name}</option>)}</select>}
      {project&&<button className="btn" type="button" disabled={busy} onClick={onRescan}><Icon name="clock"/>{busy?'Re-scanning…':'Re-scan'}</button>}</>}/>;
}

/* ── 1 · instructions ────────────────────────────────────────────────── */

function fileLoad(chain:InstructionChain,file:InstructionFile):Loads {
  return chain.atLaunch.some(row=>row.order===file.order)?'launch'
    :chain.onDemand.some(row=>row.order===file.order)?'demand'
    :file.excludedBy?'excluded':!file.exists?'missing':file.duplicate?'duplicate':'skipped';
}

function InstructionsPanel({chain,managed}: {chain:InstructionChain;managed:Map<string,KnowledgeProjection>}) {
  const [q,setQ]=useViewMemory(`${chain.root}/query`,'');
  const [only,setOnly]=useViewMemory<'all'|Loads>(`${chain.root}/load-state`,'all');
  const ordered=[...chain.files].sort((a,b)=>a.order-b.order);
  const present=(Object.keys(LOADS) as Loads[]).filter(key=>ordered.some(file=>fileLoad(chain,file)===key));
  const shown=ordered.filter(file=>(only==='all'||fileLoad(chain,file)===only)&&file.path.toLowerCase().includes(q.trim().toLowerCase()));
  const ancestors=ordered.filter(file=>file.scope==='ancestor').length;
  return <>
    <div className="stat-grid">
      <Stat label="At launch" value={num(chain.atLaunch.length)} sub={`of ${plural(chain.files.length,'file')} found`}/>
      <Stat label="Lines" value={num(chain.totalLines)} sub="loaded at launch"/>
      <Stat label="Size" value={bytes(chain.totalBytes)} sub="loaded at launch"/>
      <Stat label="Inherited" value={num(ancestors)} sub="from parent directories"/>
    </div>
    {ancestors>0&&<Callout title={`${plural(ancestors,'ancestor file')} load before this project’s instructions.`}>
      These files apply to projects below their directory. Review their scope before changing them.
    </Callout>}
    <div className="ctx-search"><Icon name="search"/><input className="field" type="search" value={q}
      placeholder="Find an instruction file" aria-label="Filter instruction files by path" onChange={event=>setQ(event.target.value)}/></div>
    <div className="ctx-filters" role="group" aria-label="Instruction load states">
      <Chip pressed={only==='all'} count={ordered.length} onToggle={()=>setOnly('all')}>All files</Chip>
      {present.map(key=><Chip key={key} pressed={only===key} count={ordered.filter(file=>fileLoad(chain,file)===key).length}
        onToggle={()=>setOnly(only===key?'all':key)}>{LOADS[key].word}</Chip>)}
    </div>
    <SectionHead label="Load order" count={shown.length}/>
    {!shown.length?<EmptyState posture="nothing-in-scope" title="No instruction files match."
      cue="The full chain is still available." action={<button className="btn" type="button" onClick={()=>{setQ('');setOnly('all');}}>Clear the filter</button>}/>
      :<ol className="ctx-file-list">{shown.map(file=><li key={file.path+file.order} className="ctx-instruction-row">
        <span className="ctx-ord" aria-label={`Position ${ordered.indexOf(file)+1}`}>{ordered.indexOf(file)+1}</span>
        <div><ContextFileLink path={file.path} disabled={!file.exists}>
          <strong>{fileName(file.path)}</strong><small>{dirName(file.path)}</small>
        </ContextFileLink>
        <div className="ctx-file-meta"><Mark {...LOADS[fileLoad(chain,file)]} title={LOADS[fileLoad(chain,file)].blurb}/>
          <Mark {...SCOPE[file.scope]} title={SCOPE[file.scope].blurb}/>
          {file.exists&&<span>{file.bytes>4*1024*1024?'Lines not counted':plural(file.lines,'line')} · {bytes(file.bytes)}</span>}
          {managed.has(file.path)&&<ManagedChip/>}
        </div>
        <div className="ctx-file-meta">
          {file.importedBy&&<span>Imported by {fileName(file.importedBy)} · depth {file.depth}</span>}
          {file.external&&<Pill status="External import" tone="warn"/>}
          {file.excludedBy&&<Pill status={`Excluded by ${file.excludedBy}`} tone="serious"/>}
          {file.conditional&&<span className="mono">{file.conditional.globs.join(', ')}</span>}
        </div>
        {file.warnings.map(warning=><p className="ctx-warn" key={warning}><span aria-hidden="true">!</span>{warning}</p>)}
        </div>
      </li>)}</ol>}
    {(only!=='all'||q)&&shown.length>0&&<p className="ctx-fine faint">Showing {shown.length} of {ordered.length}. Positions keep the full load order.</p>}
    {chain.notes.length>0&&<details className="ctx-disclosure"><summary>Scan notes</summary><Bullets items={chain.notes}/></details>}
  </>;
}

function RulesPanel({rules,root,managed,chain}: {
  rules:InstructionFile[];root:string;managed:Map<string,KnowledgeProjection>;chain:InstructionChain;
}) {
  const rel=(path:string)=>path.startsWith(root+'/')||path.startsWith(root+'\\')?path.slice(root.length+1):path;
  return <>{[false,true].map(conditional=>{
    const group=rules.filter(file=>!!file.conditional===conditional);
    return <section className="ctx-rule-group" key={String(conditional)}>
      <SectionHead label={conditional?'Path-scoped rules':'Unscoped rules'} count={group.length}/>
      {!group.length?<p className="dim">No {conditional?'path-scoped':'unscoped'} rules were found.</p>
        :<ul className="ctx-file-list">{group.map(file=><li key={file.path+file.order}>
          <ContextFileLink path={file.path} disabled={!file.exists}><strong>{fileName(file.path)}</strong><small>{rel(file.path)}</small></ContextFileLink>
          <div className="ctx-file-meta"><Mark {...LOADS[fileLoad(chain,file)]}/><Mark {...SCOPE[file.scope]}/>
            {managed.has(file.path)&&<ManagedChip/>}<span>{plural(file.lines,'line')} · {bytes(file.bytes)}</span></div>
          {file.conditional&&<div className="ctx-rule-matches"><code>{file.conditional.globs.join(', ')}</code>
            {file.conditional.matchingFiles===0?<Pill status="Matches 0 files" tone="warn"/>:<span>{plural(file.conditional.matchingFiles,'matching file')}</span>}</div>}
          {file.excludedBy&&<p className="ctx-warn">Excluded by {file.excludedBy}</p>}
          {file.warnings.map(warning=><p className="ctx-warn" key={warning}>{warning}</p>)}
        </li>)}</ul>}
    </section>;
  })}<p className="ctx-fine faint">Matching-file counts come from the project scan, which skips dependency folders, Git metadata and build output. Load labels follow the resolved instruction chain.</p></>;
}

/* ── 3 · AGENTS.md ───────────────────────────────────────────────────── */

/**
 * What Wanigan's Codex compiler writes, and whether Codex will read it.
 *
 * Deliberately not a prediction of Codex's load order — `agentsChain()` says so
 * in as many words, and this heading matches: these are the files Wanigan
 * writes to, not the files Codex loads. Wanigan never consulted Codex's loader,
 * and a list captioned "what Codex reads" would be a claim it cannot support.
 *
 * The note is the reason this panel exists. When the compiler's personal target
 * and this account's Codex home disagree, Wanigan has written an instruction to
 * a file nothing will ever read — a failure whose only other symptom is an
 * agent quietly ignoring a rule you are sure you set.
 */
function CodexAgentsPanel({ c }: { c: CodexAgentsChain }) {
  const written = c.files.filter((f) => f.exists);
  const mismatch = c.note.includes('does not read');
  return (
    <div className="ctx-codex">
      <SectionHead label="Codex — the AGENTS.md files Wanigan writes to"/>
      {mismatch && (
        <Callout level="critical" title="Wanigan is writing personal Codex instructions somewhere Codex will not read them.">
          {c.note}
        </Callout>
      )}
      {written.length === 0
        ? (
          <p className="dim ctx-fine">
            None of them exist yet. Wanigan writes one only when a learned instruction is approved
            and compiled for Codex, so an empty list here means nothing has been projected — not
            that Codex is unconfigured.
          </p>
        )
        : (
          <ul className="ctx-codex-list">
            {written.map((file) => (
              <li key={file.path} className="ctx-codex-row">
                <span className="ctx-codex-scope">{file.scope}</span>
                <code className="ctx-codex-path">{file.path}</code>
                <span className="ctx-codex-bytes">{file.bytes === null ? '' : `${file.bytes} B`}</span>
                {file.managed && <ManagedChip />}
              </li>
            ))}
          </ul>
        )}
      {!mismatch && <p className="faint ctx-fine">{c.note}</p>}
    </div>
  );
}

function AgentsPanel({ a, managed, root }: {
  a: AgentsMd; managed: Map<string, KnowledgeProjection>; root: string;
}) {
  // Same provenance mark the chain rows carry: an applied projection whose
  // target is this project's AGENTS.md means Wanigan wrote (part of) it.
  const isManaged = managed.has(root + '/AGENTS.md') || managed.has(root + '\\AGENTS.md');
  if (a.imported || a.symlinked) {
    return (
      <Note tone="ok">
        <strong>✓ AGENTS.md is loaded.</strong> {a.note}
        {isManaged && <span style={{ marginLeft: 6 }}><ManagedChip /></span>}
      </Note>
    );
  }
  return (
    <>
      {isManaged && (
        <div style={{ marginBottom: 8 }}><ManagedChip /></div>
      )}
      {/* Scoped, because it is only true of one harness. Codex reads AGENTS.md
          on its own, and instructions.ts rewrote its own note to say so
          precisely because the unscoped sentence was false for every Codex
          session in the project. */}
      <Callout level="critical" title="Claude Code will NOT read this project’s AGENTS.md.">
        Nothing imports it and no CLAUDE.md is a symlink to it, so not one line of it reaches a
        Claude Code session. Codex reads AGENTS.md natively, so this is about Claude Code, GLM and
        DeepSeek sessions only.
      </Callout>
      <SectionHead label="Two fixes, either one is enough"/>
      <ol style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 9 }}>
        <li className="sunk" style={{ padding: '10px 13px' }}>
          <div style={{ fontSize: 'var(--t-small)', fontWeight: 600 }}>1 · Import it — keeps both files</div>
          <p className="dim" style={{ fontSize: 'var(--t-small)', lineHeight: 1.5, marginTop: 3 }}>
            Add one line to <span className="mono">CLAUDE.md</span>:
          </p>
          <pre className="mono" style={{ fontSize: 'var(--t-small)', marginTop: 5, color: 'var(--text)' }}>@AGENTS.md</pre>
        </li>
        <li className="sunk" style={{ padding: '10px 13px' }}>
          <div style={{ fontSize: 'var(--t-small)', fontWeight: 600 }}>2 · Symlink it — one file, both tools</div>
          <p className="dim" style={{ fontSize: 'var(--t-small)', lineHeight: 1.5, marginTop: 3 }}>
            Replace CLAUDE.md with a link, so Claude Code and every other tool read the same file:
          </p>
          <pre className="mono" style={{ fontSize: 'var(--t-small)', marginTop: 5, color: 'var(--text)' }}>ln -s AGENTS.md CLAUDE.md</pre>
        </li>
      </ol>
    </>
  );
}

/* ── 4 · memory ──────────────────────────────────────────────────────── */

function MemoryPanel({m}: {m:MemoryState}) {
  const topics=m.files.filter(file=>!file.isIndex);
  const where={'git-repo':'Shared by this repository’s worktrees','project-root':'Scoped to this project directory','setting-override':'Set by autoMemoryDirectory'};
  return <>
    <div className="ctx-memory-location"><Mark glyph={m.enabled?'●':'○'} word={m.enabled?'Auto memory enabled':'Auto memory disabled'} color={m.enabled?'var(--good)':'var(--text-faint)'}/>
      <p className="ctx-path">{m.dir}</p><p className="ctx-fine faint">{where[m.derivedFrom]}</p></div>
    <SectionHead label="Launch index"/>
    {m.index?<div className="ctx-index-file"><ContextFileLink path={m.index.path} kind="memory"><strong>{m.index.name}</strong><small>Read the index, including content beyond the launch limit</small></ContextFileLink>
      <div className="ctx-file-meta"><span>{plural(m.index.lines,'line')} · {bytes(m.index.bytes)}</span><span title={fullDate(m.index.modified)}>Modified {ago(m.index.modified)}</span></div></div>
      :<Note tone="info">No MEMORY.md index was found. Topic files can still exist, but no launch index leads to them.</Note>}
    {m.indexBudget&&<IndexMeter b={m.indexBudget}/>}
    {m.danglingLinks.length>0&&<Callout title={`${plural(m.danglingLinks.length,'link')} point to missing memories.`}>{m.danglingLinks.join(', ')}</Callout>}
    {m.orphans.length>0&&<Note tone="info"><strong>Not linked from the index:</strong> {m.orphans.join(', ')}</Note>}
    <SectionHead label="Topic files" count={topics.length}/>
    {!topics.length?<p className="dim">No topic files have been recorded.</p>:<ul className="ctx-file-list">
      {topics.map(file=><li key={file.path}><ContextFileLink path={file.path} kind="memory"><strong>{file.name}</strong><small>{file.description}</small></ContextFileLink>
        <div className="ctx-file-meta"><Mark {...(KIND[file.kind]??KIND.unknown)}/><span>{plural(file.lines,'line')} · {bytes(file.bytes)}</span>
          <span title={fullDate(file.modified)}>Modified {ago(file.modified)}</span><span>{plural(file.links.length,'link')}</span>
          {file.links.some(link=>!link.exists)&&<Pill status={`${file.links.filter(link=>!link.exists).length} missing links`} tone="warn"/>}</div>
      </li>)}
    </ul>}
    {m.notes.length>0&&<details className="ctx-disclosure"><summary>Scan notes</summary><Bullets items={m.notes}/></details>}
  </>;
}

/**
 * The index budget as a meter, not a number. The tick is the limit; a bar that
 * runs past it is over, and the part past it is what gets dropped — silently,
 * on every session, which is why it is called out in words too.
 */
function IndexMeter({b}: {b:IndexBudget}) {
  const scale=Math.max(b.lines,b.lineLimit,1);
  return <div className="ctx-index-budget">
    <div className="ctx-meter-head"><strong>{num(b.loadedLines)} lines load</strong>
      {b.droppedLines>0?<Mark glyph="!" word={`${num(b.droppedLines)} lines dropped`} color="var(--warning)"/>
        :<Mark glyph="✓" word="Within the limit" color="var(--good)"/>}</div>
    <svg className="ctx-index-meter" viewBox="0 0 100 6" preserveAspectRatio="none" role="img" aria-label={`${b.loadedLines} lines load and ${b.droppedLines} lines are dropped`}>
      <rect width="100" height="6" rx="3" fill="var(--bg-sunk)"/>
      <rect width={b.loadedLines/scale*100} height="6" rx="3" fill="var(--series-1)"/>
      {b.droppedLines>0&&<rect x={b.loadedLines/scale*100} width={b.droppedLines/scale*100} height="6" fill="var(--warning)"/>}
    </svg>
    <table className="viz-table"><thead><tr><th>Measure</th><th className="r">In the file</th><th className="r">Limit</th></tr></thead>
      <tbody><tr><td>Lines</td><td className="n">{num(b.lines)}</td><td className="n">{num(b.lineLimit)}</td></tr>
        <tr><td>Bytes</td><td className="n">{bytes(b.bytes)}</td><td className="n">{bytes(b.byteLimit)}</td></tr></tbody></table>
    {b.overBudget?<Callout title="The index exceeds its launch budget.">{b.note}</Callout>:<Note tone="info">{b.note}</Note>}
  </div>;
}

/* ── 5 · settings and hooks ──────────────────────────────────────────── */

function fmtValue(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || v === null) return String(v);
  try {
    const s = JSON.stringify(v);
    return s.length > 160 ? s.slice(0, 157) + '…' : s;
  } catch { return String(v); }
}

function ConfigPanel({ c }: { c: ProjectConfig }) {
  const projectHooks = c.hooks.filter((h) => h.from === 'project' || h.from === 'local');
  const shared = c.hooks.filter((h) => h.from === 'project');
  const also = [
    ...c.mcp.map((s) => ({ kind: 'MCP server', name: s.name, scope: s.from, detail: `${s.transport} · ${s.target}`, source: s.source })),
    ...c.agents.map((a) => ({ kind: 'Subagent', name: a.name, scope: a.scope, detail: a.description || (a.model ? `model ${a.model}` : ''), source: a.path })),
    ...c.commands.map((s) => ({ kind: 'Command', name: s.invoke, scope: s.scope, detail: s.description, source: s.path })),
  ];

  return (
    <>
      <SectionHead label="The layers, lowest precedence first"/>
      <div className="ctx-scroll">
        <table className="grid">
          <thead><tr><th>Layer</th><th>File</th><th>On disk</th><th className="r">Keys</th></tr></thead>
          <tbody>
            {c.layers.map((l) => (
              <tr key={l.layer}>
                <td><Mark {...LAYER[l.layer]} /></td>
                <td><span className="ctx-path">{l.path}</span></td>
                <td>{l.exists
                  ? <Mark glyph="●" word="present" color="var(--good)" />
                  : <Mark glyph="·" word="absent" color="var(--text-faint)" />}</td>
                <td className="r">{l.exists ? num(l.keys) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <SectionHead label="Which layer won each key"/>
      {c.settings.length === 0 ? (
        <p className="dim" style={{ fontSize: 'var(--t-small)', lineHeight: 1.5 }}>
          No settings are set in any layer, so Claude Code runs on its own defaults here.
        </p>
      ) : (
        <div className="ctx-scroll">
          <table className="grid">
            <thead><tr><th>Key</th><th>Value in force</th><th>Won by</th><th>Shadowed</th></tr></thead>
            <tbody>
              {c.settings.map((s) => (
                <tr key={s.key}>
                  <td className="mono" style={{ fontSize: 'var(--t-small)' }}>{s.key}</td>
                  <td className="mono" style={{ fontSize: 'var(--t-small)', wordBreak: 'break-word' }}>{fmtValue(s.value)}</td>
                  <td><Mark {...LAYER[s.from]} /></td>
                  <td>
                    {s.shadowed.length === 0
                      ? <span className="faint" style={{ fontSize: 'var(--t-small)' }}>nothing</span>
                      : s.shadowed.map((sh, i) => (
                          <div key={sh.from + i} style={{ fontSize: 'var(--t-micro)', lineHeight: 1.5 }}>
                            <span style={{ color: LAYER[sh.from].color }} aria-hidden="true">{LAYER[sh.from].glyph}</span>{' '}
                            <span className="faint">{LAYER[sh.from].word}</span>{' '}
                            <s className="faint mono">{fmtValue(sh.value)}</s>
                          </div>
                        ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <SectionHead label="Hooks" count={c.hooks.length}/>
      {shared.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <Callout level="warning"
                   title={`${plural(shared.length, 'hook')} come from files committed to this repository.`}>
            A hook is a shell command Claude Code runs for you when its event fires. These ones were written
            by whoever committed <span className="mono">.claude/settings.json</span>, and they run on your
            machine with your permissions. Read the commands below before you trust them.
          </Callout>
        </div>
      )}
      {c.hooks.length === 0 ? (
        <p className="dim" style={{ fontSize: 'var(--t-small)', lineHeight: 1.5 }}>
          No hooks in any layer. Nothing runs automatically around your tool calls.
        </p>
      ) : (
        <div className="ctx-scroll">
          <table className="grid">
            <thead><tr><th>Event</th><th>Matcher</th><th>From</th><th>Runs</th><th>Defined in</th></tr></thead>
            <tbody>
              {c.hooks.map((h, i) => (
                <tr key={h.event + h.source + i}>
                  <td className="mono" style={{ fontSize: 'var(--t-small)' }}>{h.event}</td>
                  <td className="mono faint" style={{ fontSize: 'var(--t-small)' }}>{h.matcher ?? 'any'}</td>
                  <td>
                    {h.from === 'project'
                      ? <Mark glyph="⚠" word="project (shared)" color="var(--warning)"
                              title="Committed to the repository. It came from whoever wrote the repo, and it runs on your machine." />
                      : <Mark {...LAYER[h.from]} />}
                  </td>
                  <td className="mono" style={{ fontSize: 'var(--t-small)', wordBreak: 'break-word' }}>
                    {h.summary}
                    <span className="faint"> · {h.type}</span>
                  </td>
                  <td><span className="ctx-path faint">{h.source}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {projectHooks.length > 0 && (
        <p className="faint" style={{ fontSize: 'var(--t-small)', marginTop: 6, lineHeight: 1.5 }}>
          {plural(projectHooks.length, 'hook')} are defined inside this project rather than in your home
          directory. Moving one to <span className="mono">~/.claude/settings.json</span> keeps it off other
          people’s machines; moving it to <span className="mono">.claude/settings.local.json</span> keeps it
          out of the commit.
        </p>
      )}

      {c.permissions.length > 0 && (
        <>
          <SectionHead label="Permission rules"/>
          <div className="ctx-scroll">
            <table className="grid">
              <thead><tr><th>Layer</th><th className="r">Allow</th><th className="r">Ask</th><th className="r">Deny</th><th>Rule details</th></tr></thead>
              <tbody>
                {c.permissions.map((p) => (
                  <tr key={p.from}>
                    <td><Mark {...LAYER[p.from]} /></td>
                    <td className="r">{num(p.allow.length)}</td>
                    <td className="r">{num(p.ask.length)}</td>
                    <td className="r">{num(p.deny.length)}</td>
                    <td className="mono faint" style={{ fontSize: 'var(--t-small)', wordBreak: 'break-word' }}>
                      <details className="ctx-disclosure"><summary>View rules</summary>
                        {(['allow','ask','deny'] as const).map(kind=><div key={kind}><strong>{kind}</strong>
                          <ul>{p[kind].length?p[kind].map(rule=><li key={rule}>{rule}</li>):<li>None</li>}</ul></div>)}
                      </details>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {also.length > 0 && (
        <>
          <SectionHead label="Also injected" count={also.length}/>
          <div className="ctx-scroll">
            <table className="grid">
              <thead><tr><th>Kind</th><th>Name</th><th>Scope</th><th>Detail</th></tr></thead>
              <tbody>
                {also.map((x, i) => (
                  <tr key={x.kind + x.name + i}>
                    <td>{x.kind}</td>
                    <td className="mono" style={{ fontSize: 'var(--t-small)' }}>{x.name}</td>
                    <td><Mark {...LAYER[x.scope === 'project' ? 'project' : 'user']} /></td>
                    <td className="dim trunc" title={`${x.detail}\n${x.source}`}>{x.detail || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Skills are the one thing a project puts in front of an agent that this
          panel does not read — they are catalogued in their own view, which is
          off the nav rail and reached by chord. Naming it here, where its
          neighbours are listed, is the only place someone would look for it. */}
      <p className="faint" style={{ fontSize: 'var(--t-small)', lineHeight: 1.55, marginTop: 11 }}>
        Skills are not in this table. Everything under <span className="mono">.claude/skills</span> in this
        repo, in your home directory and in every installed plugin is catalogued in the Skills view:{' '}
        <span className="mono">⌘⇧S</span>, or ⌘K → Skills.
      </p>

      {c.notes.length > 0 && (
        <>
          <SectionHead label="What the scan found"/>
          <Bullets items={c.notes} />
        </>
      )}
    </>
  );
}

/* ── 6 · budget ──────────────────────────────────────────────────────── */

/**
 * The one notation for an estimated number: a tilde on the value and the word
 * est. beside it. Observed values — bytes on disk, a file count, a line count —
 * render plain, so the two are told apart at a glance instead of by reading the
 * label. This wraps the value rather than the label because the label is what
 * gets truncated, repeated in a tooltip, or read aloud on its own.
 */
function Est({ children }: { children: React.ReactNode }) {
  return (
    <>~{children} <span style={{ fontSize: 'var(--t-small)', fontWeight: 400 }}>est.</span></>
  );
}

function BudgetPanel({ b }: { b: ContextBudget }) {
  // The main process prices an over-4 MiB file at 0 tokens and moves its bytes
  // to skippedBytes; those rows are provenance for the tile, not launch cost.
  const isSkipped = (r: ContextBudget['files'][number]) =>
    r.estTokens === 0 && r.bytes > 4 * 1024 * 1024;
  const rows = [...b.files].sort((x, y) => y.estTokens - x.estTokens);
  const loaded = rows.filter((r) => !isSkipped(r));
  const skippedCount = rows.length - loaded.length;
  const total = loaded.reduce((n, r) => n + r.estTokens, 0);
  const W = 100, GAP = 0.4;
  let x = 0;

  return (
    <>
      <div className="stat-grid">
        {/* Tokens and dollars are estimated, so they carry the mark. The file
            count and the size on disk were read off the filesystem, so they do
            not — an observed number wearing a tilde is its own kind of lie. */}
        <Stat label="Startup tokens" value={<Est>{num(b.estTokens)}</Est>} sub="read in full, every session" />
        <Stat label="Cost per session"
              value={b.usdPerSession === null ? '—' : <Est>{usd(b.usdPerSession)}</Est>}
              sub={b.usdPerSession === null
                ? 'no price for the selected model'
                : <>~{usd(b.usdPerSession * 100)} est. per 100 sessions{b.model ? <> · {b.model}</> : null}</>} />
        <Stat label="Files counted" value={num(loaded.length)} sub="everything that loads at launch" />
        <Stat label="On disk" value={bytes(b.totalBytes)} sub="before tokenising" />
        {b.skippedBytes > 0 && (
          <Stat label="Skipped whole" value={bytes(b.skippedBytes)} tone="var(--critical)"
                sub={`${skippedCount > 0 ? plural(skippedCount, 'file') + ' ' : ''}over the 4 MiB ceiling — never loads`} />
        )}
      </div>

      {total > 0 && (
        <>
          <svg className="chart-svg" viewBox={`0 0 ${W} 14`} role="img"
               aria-label={loaded.map((r) => `${r.label} about ${num(r.estTokens)} estimated tokens`).join(', ')}>
            {loaded.map((r, i) => {
              const w = (r.estTokens / total) * W;
              const seg = (
                <rect key={r.path} x={x} y="0" width={Math.max(0, w - GAP)} height="10" rx="2"
                      fill={SERIES[i % SERIES.length]}>
                  <title>{`${r.label}: ~${num(r.estTokens)} est. tokens (~${((r.estTokens / total) * 100).toFixed(1)}%)`}</title>
                </rect>
              );
              x += w;
              return seg;
            })}
          </svg>
          <div className="legend">
            {loaded.slice(0, 8).map((r, i) => (
              <span key={r.path} className="legend-item">
                <span className="legend-swatch" style={{ background: SERIES[i % SERIES.length] }} />
                {r.label} <span className="mono" style={{ color: 'var(--text-faint)' }}>~{num(r.estTokens)}</span>
              </span>
            ))}
          </div>
        </>
      )}

      <div className="ctx-scroll">
        <table className="viz-table">
          <thead>
            <tr>
              <th>File</th><th>Scope</th>
              <th style={{ textAlign: 'right' }}>Size</th>
              {/* "est." belongs in the header once rather than on forty rows;
                  every value under these two still carries its own tilde. */}
              <th style={{ textAlign: 'right' }}>Est. tokens</th>
              <th style={{ textAlign: 'right' }}>Est. share</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.path}>
                <td className="mono" style={{ fontSize: 'var(--t-small)', wordBreak: 'break-all' }} title={r.path}>
                  {fileName(r.path)}
                </td>
                <td className="dim">{r.label.split(' · ')[0]}</td>
                <td className="n">{bytes(r.bytes)}</td>
                <td className="n">
                  {isSkipped(r)
                    ? <Mark glyph="✕" word="skipped whole" color="var(--critical)"
                            title="Over the 4 MiB ceiling, so Claude Code skips this file entirely — 0 of its bytes load." />
                    : `~${num(r.estTokens)}`}
                </td>
                <td className="n" style={{ color: 'var(--text-dim)' }}>
                  {isSkipped(r) || total === 0 ? '—' : `~${((r.estTokens / total) * 100).toFixed(1)}%`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* The counts come from the one estimator in src/shared/tokens.ts, which
          the main process calls for this panel and the learning engine calls
          for its own ledger. That is worth one sentence here: for a while a
          file could be priced two different ways depending on which panel you
          were looking at, and a number that contradicts its sibling is worse
          than either of them. */}
      <div style={{ marginTop: 12 }}>
        <Note tone="info">
          <strong>Estimate, not a measurement.</strong> {b.note} A tilde and the word est. mark every number
          here that was estimated; sizes and counts were read off disk and carry neither. The same estimator
          prices the Learning ledger, so a given file counts the same in both places.
        </Note>
      </div>
    </>
  );
}

/* ── 7 · learning briefing ───────────────────────────────────────────── */

/**
 * The one launch-time input that is not a file on disk: a cited capsule of
 * approved knowledge, retrieved per task. Counts are read from stored
 * knowledge rows; a failed read renders as "not read", never as zero.
 */
function LearningPanel({ settings, overview, onOpenLearning }: {
  settings: LearningSettings | null; overview: LearningOverview | null;
  onOpenLearning: (tab: 'knowledge' | 'optimize') => void;
}) {
  return (
    <>
      <div className="stat-grid">
        <Stat label="Eligible knowledge"
              value={overview ? num(overview.activeKnowledge) : '—'}
              sub={overview ? 'active items retrieval can draw from' : 'count not read this scan'} />
        <Stat label="Quarantined"
              value={overview ? num(overview.quarantined) : '—'}
              tone={overview && overview.quarantined > 0 ? 'var(--warning)' : undefined}
              sub={overview ? 'excluded until re-validated' : 'count not read this scan'} />
        {/* This is a configured ceiling; only calculated estimates wear ~. */}
        <Stat label="Budget ceiling"
              value={settings ? num(settings.briefingMaxTokens) : '—'}
              sub={settings ? 'configured limit in estimated tokens' : 'settings not read this scan'} />
        <Stat label="Briefing"
              value={!settings ? '—'
                : settings.enabled
                  ? <Mark glyph="●" word="on" color="var(--good)" />
                  : <Mark glyph="○" word="paused" color="var(--text-faint)" />}
              sub={!settings ? 'settings not read this scan'
                : settings.enabled ? 'retrieval enabled for supported launches'
                : 'no briefing will be injected'} />
      </div>

      {settings && !settings.enabled && (
        <div style={{ marginTop: 12 }}>
          <Note tone="info">
            Learning is paused, so no briefing will be injected at launch. Everything in the sections
            above still loads exactly as shown.
          </Note>
        </div>
      )}

      <p className="dim" style={{ fontSize: 'var(--t-small)', lineHeight: 1.55, marginTop: 12, maxWidth: 660 }}>
        Retrieval uses the optional New Session prompt at launch. An empty prompt provides an empty
        query. Matching items and their citations fit under the configured limit; stale citations are
        quarantined before delivery. Briefings are delivered only through supported harnesses and
        do not edit instruction files in this repository.
      </p>
      <p className="faint" style={{ fontSize: 'var(--t-small)', lineHeight: 1.5, marginTop: 5 }}>
        Counts are read from stored knowledge items.
      </p>
      <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        <button className="btn" onClick={() => onOpenLearning('knowledge')}
                title="The stored knowledge rows behind the counts above.">
          Open Knowledge
        </button>
        <button className="btn" onClick={() => onOpenLearning('optimize')}
                title="Retrieval settings, including the per-task budget ceiling.">
          Open Learning › Context
        </button>
      </div>
    </>
  );
}

/* ── the empty state ─────────────────────────────────────────────────── */

function Setup({project,slots,onInit,initMsg,busy}: {
  project:Project;slots:typeof SLOTS;onInit:()=>void;initMsg:{tone:'ok'|'info';text:string}|null;busy:boolean;
}) {
  const offerInit=slots.some(slot=>slot.key==='chain');
  return <div className="ctx-setup">
    <EmptyState posture="nothing-yet" title={offerInit?'No instruction files were found.':'Nothing recorded in this area.'}
      cue={`This reading is for ${project.name}. Files inherited from outside the project are included when the scanner finds them.`}
      action={offerInit?<button className="btn btn-primary" type="button" disabled={busy} onClick={onInit}>{busy?'Finding a session…':'Type /init into a session'}</button>:undefined}/>
    {offerInit&&<p className="ctx-fine dim">This types /init into a running Claude Code session. You press Enter to run it and review any file changes.</p>}
    {initMsg&&offerInit&&<Note tone={initMsg.tone}>{initMsg.text}</Note>}
    {slots.map(slot=><details key={slot.key} className="ctx-disclosure"><summary>{slot.title}</summary><p>{slot.what}</p><p>{slot.how}</p></details>)}
  </div>;
}
