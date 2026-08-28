import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import type { Project } from '@shared/types';
import { Note, Section, Stat, ago, num, usd } from '../components/bits';

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

type Loads = 'launch' | 'demand' | 'excluded' | 'missing' | 'skipped';

const LOADS: Record<Loads, { glyph: string; word: string; color: string; blurb: string }> = {
  launch:   { glyph: '●', word: 'at launch', color: 'var(--good)',
              blurb: 'In context before the first prompt.' },
  demand:   { glyph: '◑', word: 'on demand', color: 'var(--series-1)',
              blurb: 'Loads only when Claude touches a matching path.' },
  excluded: { glyph: '⊘', word: 'excluded',  color: 'var(--serious)',
              blurb: 'Removed by claudeMdExcludes. It never reaches the agent.' },
  missing:  { glyph: '·', word: 'missing',   color: 'var(--text-faint)',
              blurb: 'Referenced but not on disk.' },
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

function Mark({ glyph, word, color, title }: { glyph: string; word: string; color: string; title?: string }) {
  return (
    <span className="ctx-mark" style={{ color }} title={title}>
      <span className="g" aria-hidden="true">{glyph}</span>{word}
    </span>
  );
}

/**
 * bits.tsx's <Note tone="warn"> reaches for --warn-soft, which the token sheet
 * does not define, so warnings would render on a transparent ground. Warnings
 * are the whole point of this view, so they get a local callout on the
 * --warning / --critical tokens that do exist. Info and ok reuse <Note>.
 */
function Callout({ level = 'warning', title, children }: {
  level?: 'warning' | 'critical'; title: React.ReactNode; children?: React.ReactNode;
}) {
  const m = level === 'critical'
    ? { bg: 'var(--critical-soft)', fg: 'var(--critical)', glyph: '✕' }
    : { bg: 'var(--warning-soft)', fg: 'var(--warning)', glyph: '⚠' };
  return (
    <div style={{ background: m.bg, borderLeft: `3px solid ${m.fg}`, borderRadius: 7,
                  padding: '10px 13px', display: 'flex', gap: 9 }}>
      <span aria-hidden="true" style={{ color: m.fg, fontWeight: 700, lineHeight: 1.4 }}>{m.glyph}</span>
      <div style={{ minWidth: 0 }}>
        <div style={{ color: m.fg, fontWeight: 650, fontSize: 12.5, lineHeight: 1.45 }}>{title}</div>
        {children ? <div className="dim" style={{ fontSize: 12.5, lineHeight: 1.55, marginTop: 5 }}>{children}</div> : null}
      </div>
    </div>
  );
}

function Bullets({ items }: { items: string[] }) {
  if (!items.length) return null;
  return (
    <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 5, marginTop: 4 }}>
      {items.map((t) => (
        <li key={t} className="dim" style={{ display: 'flex', gap: 7, fontSize: 12, lineHeight: 1.5 }}>
          <span className="faint" aria-hidden="true">·</span><span>{t}</span>
        </li>
      ))}
    </ul>
  );
}

/** One failed channel, said in a sentence with the thing to do about it. */
function PanelError({ channel, detail, onRetry }: { channel: string; detail: string; onRetry: () => void }) {
  return (
    <Callout level="critical" title={`Wanigan could not read this. The ${channel} call failed.`}>
      <p className="mono" style={{ fontSize: 11.5, marginTop: 2, wordBreak: 'break-word' }}>{detail}</p>
      <p style={{ marginTop: 6 }}>
        If the message says there is no handler, the main process has not registered{' '}
        <span className="mono">{channel}</span> yet — the reader module exists, the IPC channel does not.
        Otherwise the folder moved or is unreadable: check it still exists, then try again.
      </p>
      <button className="btn" style={{ marginTop: 8 }} onClick={onRetry}>Try again</button>
    </Callout>
  );
}

/* ── file reading ────────────────────────────────────────────────────── */

type Body =
  | { state: 'loading' }
  | { state: 'ok'; text: string; truncated: boolean; bytes: number }
  | { state: 'err'; detail: string };

function FileBody({ path, kind }: { path: string; kind: 'instruction' | 'memory' }) {
  const [b, setB] = useState<Body>({ state: 'loading' });

  useEffect(() => {
    let live = true;
    setB({ state: 'loading' });
    const p = kind === 'memory'
      ? window.wanigan.context.memoryBody(path)
      : window.wanigan.context.read(path);
    p.then((r) => { if (live) setB({ state: 'ok', ...r }); })
     .catch((e) => { if (live) setB({ state: 'err', detail: msg(e) }); });
    return () => { live = false; };
  }, [path, kind]);

  if (b.state === 'loading') return <div className="ctx-read"><pre className="dim">Reading {fileName(path)}…</pre></div>;
  if (b.state === 'err') {
    return (
      <Callout level="warning" title={`Could not read ${fileName(path)}.`}>
        <p className="mono" style={{ fontSize: 11.5, wordBreak: 'break-word' }}>{b.detail}</p>
        <p style={{ marginTop: 5 }}>The chain still lists it, so the file was there when the scan ran. Re-scan to pick up a rename or a deletion.</p>
      </Callout>
    );
  }
  return (
    <div className="ctx-read">
      <div className="ctx-read-head">
        <span className="mono">{path}</span>
        <span style={{ marginLeft: 'auto' }}>{bytes(b.bytes)}</span>
        {b.truncated && <span style={{ color: 'var(--warning)' }}>⚠ truncated for display</span>}
      </div>
      <pre>{b.text}</pre>
    </div>
  );
}

/* ── the six slots, for the empty state ──────────────────────────────── */

type SlotKey = 'chain' | 'rules' | 'agents' | 'memory' | 'config' | 'budget';

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
];

/* ── the view ────────────────────────────────────────────────────────── */

type Errors = Partial<Record<'instructions' | 'memory' | 'config' | 'agents' | 'budget', string>>;

type Data = {
  chain: InstructionChain | null;
  memory: MemoryState | null;
  config: ProjectConfig | null;
  agents: AgentsMd | null;
  budget: ContextBudget | null;
  errors: Errors;
};

export default function Context({ projectId, projects }: { projectId?: string; projects: Project[] }) {
  const [chosen, setChosen] = useState<string | undefined>(projectId);
  useEffect(() => { if (projectId) setChosen(projectId); }, [projectId]);

  const project = useMemo(
    () => projects.find((p) => p.id === chosen) ?? projects.find((p) => p.id === projectId) ?? projects[0] ?? null,
    [projects, chosen, projectId],
  );

  const [d, setD] = useState<Data | null>(null);
  const [busy, setBusy] = useState(false);
  const [initMsg, setInitMsg] = useState<{ tone: 'ok' | 'info'; text: string } | null>(null);

  const path = project?.path;

  const load = useCallback(async (rescan: boolean) => {
    if (!path) { setD(null); return; }
    setBusy(true);
    // A stale cache is not worth an error banner of its own.
    if (rescan) { try { await window.wanigan.context.refresh(path); } catch { /* ignore */ } }

    const errors: Errors = {};
    const [ri, rm, rc, ra] = await Promise.allSettled([
      window.wanigan.context.instructions(path),
      window.wanigan.context.memory(path),
      window.wanigan.context.config(path),
      window.wanigan.context.agentsMd(path),
    ]);

    const chain = ri.status === 'fulfilled' ? (ri.value as InstructionChain) : null;
    if (ri.status === 'rejected') errors.instructions = msg(ri.reason);
    const memory = rm.status === 'fulfilled' ? (rm.value as MemoryState) : null;
    if (rm.status === 'rejected') errors.memory = msg(rm.reason);
    const config = rc.status === 'fulfilled' ? (rc.value as ProjectConfig) : null;
    if (rc.status === 'rejected') errors.config = msg(rc.reason);
    const agents = ra.status === 'fulfilled' ? (ra.value as AgentsMd) : null;
    if (ra.status === 'rejected') errors.agents = msg(ra.reason);

    // The budget prices exactly what loads at launch, at whatever model the
    // settings chain actually selected — not a default we invented.
    let budget: ContextBudget | null = null;
    if (chain && chain.atLaunch.length) {
      const picked = config?.settings.find((s) => s.key === 'model' && typeof s.value === 'string');
      const model = picked ? String(picked.value) : undefined;
      const files = chain.atLaunch.map((f) => ({ path: f.path, label: `${SCOPE[f.scope].word} · ${fileName(f.path)}` }));
      try { budget = (await window.wanigan.context.budget(path, files, model)) as ContextBudget; }
      catch (e) { errors.budget = msg(e); }
    }

    setD({ chain, memory, config, agents, budget, errors });
    setBusy(false);
  }, [path]);

  useEffect(() => { setD(null); setInitMsg(null); void load(false); }, [load]);

  async function runInit() {
    if (!project) return;
    try {
      const list = await window.wanigan.sessions.list();
      const s = list.find((x) => x.projectId === project.id && x.status === 'running');
      if (!s) {
        setInitMsg({ tone: 'info', text:
          `No session is running in ${project.name}. Open Sessions, start one there with ⌘T, then come back — this button types /init into a live session, it does not start one.` });
        return;
      }
      await window.wanigan.skills.send(s.id, '/init');
      setInitMsg({ tone: 'ok', text:
        `Typed /init into the running session in ${project.name}. Switch to Sessions and press Enter to run it — it writes a CLAUDE.md from what is actually in the repo, and you review the diff before it lands.` });
    } catch (e) {
      setInitMsg({ tone: 'info', text: `Could not reach a session: ${msg(e)}. Run /init yourself in a session in ${project.name}.` });
    }
  }

  /* Empty: no projects at all. Not the same as a project with nothing in it. */
  if (projects.length === 0 || !project) {
    return (
      <div className="pane ctx">
        <Head project={null} projects={projects} onPick={setChosen} onRescan={() => load(true)} busy={busy} />
        <div className="card" style={{ padding: 18 }}>
          <h2 style={{ fontSize: 14, fontWeight: 600 }}>No projects yet</h2>
          <p className="dim" style={{ fontSize: 12.5, lineHeight: 1.55, marginTop: 6, maxWidth: 560 }}>
            This view reads a project folder from disk and shows what a session launched in it would
            be told before you type anything. Add a folder in Sessions and it appears here.
          </p>
        </div>
      </div>
    );
  }

  /* Loading: a real state, not an empty one. */
  if (!d) {
    return (
      <div className="pane ctx">
        <Head project={project} projects={projects} onPick={setChosen} onRescan={() => load(true)} busy={busy} />
        <div className="card chart-empty">
          Reading the instruction chain, memory and settings for <span className="mono">{project.path}</span>…
        </div>
      </div>
    );
  }

  const e = d.errors;
  const allFailed = !d.chain && !d.memory && !d.config && !d.agents;

  if (allFailed) {
    return (
      <div className="pane ctx" key={project.id}>
        <Head project={project} projects={projects} onPick={setChosen} onRescan={() => load(true)} busy={busy} />
        <Callout level="critical" title={`Wanigan could not read anything about ${project.name}.`}>
          <p>
            All four context readers failed. If every message below says there is no handler, the main
            process modules are present but their IPC channels are not registered yet — that is a wiring
            gap, not a broken project. If they name a path instead, the folder moved: re-add the project
            in Sessions, or pick the folder you actually launch sessions in.
          </p>
          <ul style={{ listStyle: 'none', marginTop: 8, display: 'flex', flexDirection: 'column', gap: 3 }}>
            {([['context:instructions', e.instructions], ['context:memory', e.memory],
               ['context:config', e.config], ['context:agentsMd', e.agents]] as const).map(([ch, detail]) => (
              <li key={ch} className="mono" style={{ fontSize: 11.5, wordBreak: 'break-word' }}>
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
  };
  const errored: Record<SlotKey, string | undefined> = {
    chain: e.instructions, rules: e.instructions, agents: e.agents,
    memory: e.memory, config: e.config, budget: e.budget,
  };
  const unfilled = SLOTS.filter((s) => !filled[s.key] && !errored[s.key]);
  const nothing = !Object.values(shows).some(Boolean) && Object.keys(e).length === 0;

  return (
    <div className="pane ctx" key={project.id}>
      <Head project={project} projects={projects} onPick={setChosen} onRescan={() => load(true)} busy={busy} />

      {nothing ? (
        <Setup full project={project} slots={SLOTS} onInit={runInit} initMsg={initMsg} />
      ) : (
        <>
          {(shows.chain || errored.chain) && (
            <Section n={1} title="Instructions"
                     hint="The CLAUDE.md chain in load order. Everything above the project is loaded before it."
                     right={chain ? <span className="ctx-chip">{plural(chain.atLaunch.length, 'file')} at launch</span> : undefined}>
              {e.instructions
                ? <PanelError channel="context:instructions" detail={e.instructions} onRetry={() => load(true)} />
                : chain && <InstructionsPanel chain={chain} />}
            </Section>
          )}

          {shows.rules && chain && (
            <Section n={2} title="Rules"
                     hint="What loads at launch, and what waits for a matching path. A rule that matches nothing never loads at all.">
              <RulesPanel rules={rules} root={project.path} />
            </Section>
          )}

          {(shows.agents || errored.agents) && (
            <Section n={3} title="AGENTS.md"
                     hint="Claude Code does not read AGENTS.md on its own — it reaches context only by import or symlink.">
              {e.agents
                ? <PanelError channel="context:agentsMd" detail={e.agents} onRetry={() => load(true)} />
                : d.agents && <AgentsPanel a={d.agents} />}
            </Section>
          )}

          {(shows.memory || errored.memory) && (
            <Section n={4} title="Memory"
                     hint="MEMORY.md is an index and only its head is loaded: the first 200 lines or 25 KB, whichever comes first."
                     right={d.memory ? <span className="ctx-chip">{plural(d.memory.files.length, 'file')}</span> : undefined}>
              {e.memory
                ? <PanelError channel="context:memory" detail={e.memory} onRetry={() => load(true)} />
                : d.memory && <MemoryPanel m={d.memory} />}
            </Section>
          )}

          {(shows.config || errored.config) && (
            <Section n={5} title="Settings and hooks"
                     hint="Four layers stack up. Every key names the layer that won it and the layers it beat.">
              {e.config
                ? <PanelError channel="context:config" detail={e.config} onRetry={() => load(true)} />
                : d.config && <ConfigPanel c={d.config} />}
            </Section>
          )}

          {(shows.budget || errored.budget) && (
            <Section n={6} title="Startup budget"
                     hint="What carrying all of that costs at the start of every session. An estimate, not a measurement."
                     right={<span className="ctx-chip">≈ estimate</span>}>
              {e.budget
                ? <PanelError channel="context:budget" detail={e.budget} onRetry={() => load(true)} />
                : d.budget && <BudgetPanel b={d.budget} />}
            </Section>
          )}

          {unfilled.length > 0 && (
            <Setup project={project} slots={unfilled} onInit={runInit} initMsg={initMsg} />
          )}
        </>
      )}
    </div>
  );
}

function Head({ project, projects, onPick, onRescan, busy }: {
  project: Project | null; projects: Project[];
  onPick: (id: string) => void; onRescan: () => void; busy: boolean;
}) {
  return (
    <div className="pane-head">
      <div>
        <h1>Context</h1>
        <p className="dim">
          {project
            ? <>What a session launched in <span className="mono">{project.path}</span> is told before you type anything.</>
            : <>What a session is told before you type anything.</>}
        </p>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {projects.length > 1 && project && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className="label">Project</span>
            <select className="field" style={{ width: 'auto' }} value={project.id}
                    onChange={(ev) => onPick(ev.target.value)}>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
        )}
        <button className="btn" onClick={onRescan} disabled={busy || !project}>
          {busy ? 'Re-scanning…' : 'Re-scan'}
        </button>
      </div>
    </div>
  );
}

/* ── 1 · instructions ────────────────────────────────────────────────── */

function InstructionsPanel({ chain }: { chain: InstructionChain }) {
  const [q, setQ] = useState('');
  const [only, setOnly] = useState<'all' | Loads>('all');
  const [open, setOpen] = useState<string | null>(null);

  const ordered = useMemo(() => [...chain.files].sort((a, b) => a.order - b.order), [chain]);
  const loadsOf = useMemo(() => {
    const launch = new Set(chain.atLaunch.map((f) => f.order));
    const demand = new Set(chain.onDemand.map((f) => f.order));
    return (f: InstructionFile): Loads =>
      launch.has(f.order) ? 'launch'
        : demand.has(f.order) ? 'demand'
        : f.excludedBy ? 'excluded'
        : !f.exists ? 'missing'
        : 'skipped';
  }, [chain]);

  const present = useMemo(() => {
    const seen = new Set<Loads>();
    for (const f of ordered) seen.add(loadsOf(f));
    return (['launch', 'demand', 'excluded', 'missing', 'skipped'] as Loads[]).filter((k) => seen.has(k));
  }, [ordered, loadsOf]);

  const rank = useMemo(() => new Map(ordered.map((f, i) => [f, i + 1])), [ordered]);

  const shown = ordered.filter((f) =>
    (only === 'all' || loadsOf(f) === only) &&
    (!q.trim() || f.path.toLowerCase().includes(q.trim().toLowerCase())));

  const ancestors = ordered.filter((f) => f.scope === 'ancestor').length;
  const filtering = only !== 'all' || !!q.trim();

  return (
    <>
      <div className="stat-grid">
        <Stat label="Loads at launch" value={num(chain.atLaunch.length)}
              sub={`of ${plural(chain.files.length, 'file')} found`} />
        <Stat label="Lines at launch" value={num(chain.totalLines)} sub="before anyone types a word" />
        <Stat label="Bytes at launch" value={bytes(chain.totalBytes)} sub="loaded in full, every session" />
        <Stat label="From above this project" value={num(ancestors)}
              tone={ancestors ? 'var(--warning)' : undefined}
              sub={ancestors ? 'ancestor files load first' : 'nothing inherited from parents'} />
      </div>

      {ancestors > 0 && (
        <div style={{ marginTop: 12 }}>
          <Callout level="warning" title={`${plural(ancestors, 'instruction file')} from directories ABOVE this project load before its own.`}>
            They are marked <Mark {...SCOPE.ancestor} /> below. They apply to every project under that
            directory, so a rule written for one repo is being read in all of them. Remove them with{' '}
            <span className="mono">claudeMdExcludes</span>, or move them down into the repo that needs them.
          </Callout>
        </div>
      )}

      <div className="ctx-filters" style={{ marginTop: 14 }}>
        <button className={`ctx-filter${only === 'all' ? ' on' : ''}`} onClick={() => setOnly('all')}>
          All {ordered.length}
        </button>
        {present.map((k) => (
          <button key={k} className={`ctx-filter${only === k ? ' on' : ''}`} onClick={() => setOnly(k)}
                  title={LOADS[k].blurb}>
            <span aria-hidden="true">{LOADS[k].glyph}</span> {LOADS[k].word}{' '}
            {ordered.filter((f) => loadsOf(f) === k).length}
          </button>
        ))}
        <input className="field" style={{ width: 200, marginLeft: 'auto' }} value={q}
               placeholder="Filter by path" aria-label="Filter instruction files by path"
               onChange={(ev) => setQ(ev.target.value)} />
      </div>

      <div className="ctx-scroll" style={{ marginTop: 10 }}>
        <table className="grid">
          <thead>
            <tr>
              <th className="ctx-ord">#</th>
              <th>Loads</th>
              <th>Scope</th>
              <th>File</th>
              <th className="r">Lines</th>
              <th className="r">Size</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((f) => {
              const l = LOADS[loadsOf(f)];
              const s = SCOPE[f.scope];
              const isOpen = open === f.path;
              return (
                <Fragment key={f.path + f.order}>
                  <tr>
                    <td className="ctx-ord">{rank.get(f)}</td>
                    <td><Mark {...l} title={l.blurb} /></td>
                    <td><Mark {...s} title={s.blurb} /></td>
                    <td>
                      <div style={{ paddingLeft: Math.min(f.depth, 4) * 16 }}>
                        <button className="ctx-open" aria-expanded={isOpen}
                                onClick={() => setOpen(isOpen ? null : f.path)}>
                          <span className="caret" aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
                          <span className="ctx-path">
                            {f.depth > 0 && <span className="ctx-dir" aria-hidden="true">↳ </span>}
                            <span className="ctx-dir">{dirName(f.path)}</span>{fileName(f.path)}
                          </span>
                        </button>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 4 }}>
                          {f.depth > 0 && <span className="ctx-chip faint">import depth {f.depth}</span>}
                          {f.importedBy && (
                            <span className="ctx-chip faint">imported by {fileName(f.importedBy)}</span>
                          )}
                          {f.external && (
                            <span className="ctx-chip" style={{ color: 'var(--warning)', borderColor: 'var(--warning)' }}
                                  title="This import resolves outside the project directory, so what is in context is not what the repo appears to contain.">
                              ⚠ external import
                            </span>
                          )}
                          {f.excludedBy && (
                            <span className="ctx-chip" style={{ color: 'var(--serious)', borderColor: 'var(--serious)' }}>
                              ⊘ excluded by {f.excludedBy}
                            </span>
                          )}
                          {f.conditional && (
                            <span className="ctx-chip faint mono">{f.conditional.globs.join(', ')}</span>
                          )}
                        </div>
                        {f.warnings.map((w) => (
                          <div className="ctx-warn" key={w}><span className="g" aria-hidden="true">⚠</span><span>{w}</span></div>
                        ))}
                      </div>
                    </td>
                    <td className="r">{f.exists ? num(f.lines) : '—'}</td>
                    <td className="r">{f.exists ? bytes(f.bytes) : '—'}</td>
                  </tr>
                  {isOpen && (
                    <tr>
                      <td colSpan={6}><FileBody path={f.path} kind="instruction" /></td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {shown.length === 0 && (
              <tr>
                <td colSpan={6} className="center">
                  <p className="dim">
                    No file in the chain matches {q.trim() ? <>“<span className="mono">{q.trim()}</span>”</> : 'this filter'}
                    {only !== 'all' && <> in the <strong>{LOADS[only].word}</strong> set</>}.
                    {' '}All {plural(ordered.length, 'file')} are still loaded.
                  </p>
                  <button className="btn" style={{ marginTop: 10 }}
                          onClick={() => { setQ(''); setOnly('all'); }}>Clear the filter</button>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {filtering && shown.length > 0 && (
        <p className="faint" style={{ fontSize: 11.5, marginTop: 6 }}>
          Showing {shown.length} of {ordered.length}. Numbers are positions in the full load order.
        </p>
      )}

      {chain.notes.length > 0 && (
        <>
          <h3 className="ctx-sub">What the scan found</h3>
          <Bullets items={chain.notes} />
        </>
      )}
    </>
  );
}

/* ── 2 · rules ───────────────────────────────────────────────────────── */

function RulesPanel({ rules, root }: { rules: InstructionFile[]; root: string }) {
  const [open, setOpen] = useState<string | null>(null);
  const launch = rules.filter((r) => !r.conditional);
  const demand = rules.filter((r) => r.conditional);
  const dead = demand.filter((r) => (r.conditional?.matchingFiles ?? 0) === 0);
  const max = Math.max(1, ...demand.map((r) => r.conditional?.matchingFiles ?? 0));
  const rel = (p: string) => (p.startsWith(root) ? p.slice(root.length + 1) : p);

  return (
    <>
      {dead.length > 0 && (
        <Callout level="warning"
                 title={`${plural(dead.length, 'path-scoped rule')} match no file in this project, so ${dead.length === 1 ? 'it never loads' : 'they never load'}.`}>
          A rule only enters context when Claude touches a file its globs match. Zero matches means the
          instructions in it have never been read and never will be. Check each glob against the paths that
          actually exist — a leading <span className="mono">./</span>, a missing{' '}
          <span className="mono">**/</span>, or a directory that was renamed are the usual causes.
        </Callout>
      )}

      <h3 className="ctx-sub">Loads at launch — {plural(launch.length, 'file')}</h3>
      {launch.length === 0 ? (
        <p className="dim" style={{ fontSize: 12.5, lineHeight: 1.5 }}>
          No rule loads at launch. Every rule here is path-scoped, so none of them costs anything until
          Claude opens a matching file.
        </p>
      ) : (
        <>
          <p className="dim" style={{ fontSize: 12.5, lineHeight: 1.5 }}>
            These have no <span className="mono">paths:</span> key, so they are part of every prompt in this
            project, exactly like a CLAUDE.md.
          </p>
          <div className="ctx-scroll" style={{ marginTop: 8 }}>
            <table className="grid">
              <thead><tr><th>Scope</th><th>File</th><th className="r">Lines</th><th className="r">Size</th></tr></thead>
              <tbody>
                {launch.map((r) => (
                  <tr key={r.path}>
                    <td><Mark {...SCOPE[r.scope]} title={SCOPE[r.scope].blurb} /></td>
                    <td><span className="ctx-path">{rel(r.path)}</span></td>
                    <td className="r">{num(r.lines)}</td>
                    <td className="r">{bytes(r.bytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <h3 className="ctx-sub">Loads on demand — {plural(demand.length, 'file')}</h3>
      {demand.length === 0 ? (
        <p className="dim" style={{ fontSize: 12.5, lineHeight: 1.5 }}>
          Nothing is path-scoped in this project. Everything above is paid for on every session.
        </p>
      ) : (
        <>
          <div className="ctx-bars" style={{ marginTop: 10 }}>
            {demand.map((r) => {
              const n = r.conditional?.matchingFiles ?? 0;
              const pct = (n / max) * 100;
              return (
                <div key={r.path}>
                  <div className="ctx-bar-label">
                    <span className="ctx-path">{rel(r.path)}</span>
                    <span className="v">
                      {n === 0
                        ? <Mark glyph="⚠" word="matches 0 files" color="var(--warning)" />
                        : `${plural(n, 'file')} match`}
                    </span>
                  </div>
                  <div style={{ height: 7, borderRadius: 4, background: 'var(--bg-sunk)', overflow: 'hidden' }}>
                    <div style={{ width: `${Math.max(pct, n > 0 ? 1 : 0)}%`, height: '100%',
                                  borderRadius: 4, background: SERIES[0] }} />
                  </div>
                </div>
              );
            })}
          </div>

          <div className="ctx-scroll" style={{ marginTop: 12 }}>
            <table className="grid">
              <thead>
                <tr>
                  <th>Scope</th><th>File</th><th>Globs</th>
                  <th className="r">Matches</th><th className="r">Lines</th><th className="r">Size</th>
                </tr>
              </thead>
              <tbody>
                {demand.map((r) => {
                  const n = r.conditional?.matchingFiles ?? 0;
                  const isOpen = open === r.path;
                  return (
                    <Fragment key={r.path}>
                      <tr>
                        <td><Mark {...SCOPE[r.scope]} title={SCOPE[r.scope].blurb} /></td>
                        <td>
                          <button className="ctx-open" aria-expanded={isOpen}
                                  onClick={() => setOpen(isOpen ? null : r.path)}>
                            <span className="caret" aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
                            <span className="ctx-path">{rel(r.path)}</span>
                          </button>
                        </td>
                        <td className="mono" style={{ fontSize: 11.5 }}>
                          {(r.conditional?.globs ?? []).join(', ')}
                        </td>
                        <td className="r">
                          {n === 0
                            ? <Mark glyph="⚠" word="0 — never loads" color="var(--warning)" />
                            : num(n)}
                        </td>
                        <td className="r">{num(r.lines)}</td>
                        <td className="r">{bytes(r.bytes)}</td>
                      </tr>
                      {isOpen && (
                        <tr>
                          <td colSpan={6}><FileBody path={r.path} kind="instruction" /></td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="faint" style={{ fontSize: 11.5, marginTop: 6, lineHeight: 1.5 }}>
            Match counts come from a walk of the project that skips node_modules, .git and build output,
            so they count the files a rule would realistically fire on.
          </p>
        </>
      )}
    </>
  );
}

/* ── 3 · AGENTS.md ───────────────────────────────────────────────────── */

function AgentsPanel({ a }: { a: AgentsMd }) {
  if (a.imported || a.symlinked) {
    return (
      <Note tone="ok">
        <strong>✓ AGENTS.md is loaded.</strong> {a.note}
      </Note>
    );
  }
  return (
    <>
      <Callout level="critical" title="Claude Code will NOT read this project’s AGENTS.md.">
        Nothing imports it and no CLAUDE.md is a symlink to it, so not one line of it reaches the agent.
        Whatever it says about this repo is being ignored on every single session.
      </Callout>
      <h3 className="ctx-sub">Two fixes, either one is enough</h3>
      <ol style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 9 }}>
        <li className="sunk" style={{ padding: '10px 13px' }}>
          <div style={{ fontSize: 12.5, fontWeight: 600 }}>1 · Import it — keeps both files</div>
          <p className="dim" style={{ fontSize: 12.5, lineHeight: 1.5, marginTop: 3 }}>
            Add one line to <span className="mono">CLAUDE.md</span>:
          </p>
          <pre className="mono" style={{ fontSize: 11.5, marginTop: 5, color: 'var(--text)' }}>@AGENTS.md</pre>
        </li>
        <li className="sunk" style={{ padding: '10px 13px' }}>
          <div style={{ fontSize: 12.5, fontWeight: 600 }}>2 · Symlink it — one file, both tools</div>
          <p className="dim" style={{ fontSize: 12.5, lineHeight: 1.5, marginTop: 3 }}>
            Replace CLAUDE.md with a link, so Claude Code and every other tool read the same file:
          </p>
          <pre className="mono" style={{ fontSize: 11.5, marginTop: 5, color: 'var(--text)' }}>ln -s AGENTS.md CLAUDE.md</pre>
        </li>
      </ol>
    </>
  );
}

/* ── 4 · memory ──────────────────────────────────────────────────────── */

function MemoryPanel({ m }: { m: MemoryState }) {
  const [open, setOpen] = useState<string | null>(null);
  const topics = m.files.filter((f) => !f.isIndex);
  const WHERE: Record<MemoryState['derivedFrom'], string> = {
    'git-repo': 'keyed off the git repository, so every worktree and subdirectory shares it',
    'project-root': 'keyed off this directory, because it is not inside a git repository',
    'setting-override': 'set by autoMemoryDirectory in your settings',
  };

  return (
    <>
      <div className="stat-2">
        <Stat label="Memory directory" value={<span className="mono" style={{ fontSize: 12 }}>{m.dir}</span>}
              sub={WHERE[m.derivedFrom]} />
        <Stat label="Auto memory"
              value={m.enabled
                ? <Mark glyph="●" word="enabled" color="var(--good)" />
                : <Mark glyph="○" word="disabled" color="var(--text-faint)" />}
              sub={m.enabled ? 'Claude saves and reads memories here' : 'nothing here is loaded into a session'} />
      </div>

      <h3 className="ctx-sub">MEMORY.md budget</h3>
      {m.indexBudget ? <IndexMeter b={m.indexBudget} /> : (
        <Note tone="info">
          There is no MEMORY.md in this directory, so nothing indexes the memories below. Claude reads
          the index first — an unindexed memory is only found if something names it directly.
        </Note>
      )}

      {m.danglingLinks.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <Callout level="warning" title={`${plural(m.danglingLinks.length, 'link')} point at a memory that does not exist.`}>
            <span className="mono">{m.danglingLinks.map((l) => `[[${l}]]`).join('  ')}</span>
            <p style={{ marginTop: 5 }}>
              Claude follows links out of the index. A dead one costs a read to discover and returns
              nothing. Either write the memory or take the link out.
            </p>
          </Callout>
        </div>
      )}

      {m.orphans.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <Note tone="info">
            <strong>{plural(m.orphans.length, 'memory', 'memories')} nothing links to:</strong>{' '}
            <span className="mono">{m.orphans.join(', ')}</span>. They are on disk but the index does not
            lead to them, so they load only if Claude already knows the name.
          </Note>
        </div>
      )}

      <h3 className="ctx-sub">Topic files — {plural(topics.length, 'file')}</h3>
      {topics.length === 0 ? (
        <p className="dim" style={{ fontSize: 12.5, lineHeight: 1.5 }}>
          No topic files yet. Claude writes them as it learns things worth keeping; the index above stays
          small because the detail lives out here.
        </p>
      ) : (
        <div className="ctx-scroll" style={{ marginTop: 8 }}>
          <table className="grid">
            <thead>
              <tr>
                <th>Kind</th><th>Memory</th>
                <th className="r">Lines</th><th className="r">Size</th>
                <th className="r">Modified</th><th className="r">Links</th>
              </tr>
            </thead>
            <tbody>
              {topics.map((f) => {
                const k = KIND[f.kind] ?? KIND.unknown;
                const isOpen = open === f.path;
                const broken = f.links.filter((l) => !l.exists).length;
                return (
                  <Fragment key={f.path}>
                    <tr>
                      <td><Mark {...k} /></td>
                      <td>
                        <button className="ctx-open" aria-expanded={isOpen}
                                onClick={() => setOpen(isOpen ? null : f.path)}>
                          <span className="caret" aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
                          <span style={{ minWidth: 0 }}>
                            <span className="ctx-path" style={{ display: 'block' }}>{f.name}</span>
                            {f.description && (
                              <span className="dim" style={{ fontSize: 11.5, lineHeight: 1.45, display: 'block', marginTop: 2 }}>
                                {f.description}
                              </span>
                            )}
                          </span>
                        </button>
                      </td>
                      <td className="r">{num(f.lines)}</td>
                      <td className="r">{bytes(f.bytes)}</td>
                      <td className="r" title={fullDate(f.modified)}>{ago(f.modified)}</td>
                      <td className="r">
                        {broken > 0
                          ? <Mark glyph="⚠" word={`${broken} dead`} color="var(--warning)" />
                          : num(f.links.length)}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td colSpan={6}><FileBody path={f.path} kind="memory" /></td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {m.notes.length > 0 && (
        <>
          <h3 className="ctx-sub">What the scan found</h3>
          <Bullets items={m.notes} />
        </>
      )}
    </>
  );
}

/**
 * The index budget as a meter, not a number. The tick is the limit; a bar that
 * runs past it is over, and the part past it is what gets dropped — silently,
 * on every session, which is why it is called out in words too.
 */
function IndexMeter({ b }: { b: IndexBudget }) {
  const rows = [
    { key: 'Lines', used: b.lines, limit: b.lineLimit,
      loaded: b.loadedLines, dropped: b.droppedLines, fmt: (n: number) => num(n) },
    { key: 'Bytes', used: b.bytes, limit: b.byteLimit,
      loaded: Math.min(b.bytes, b.byteLimit), dropped: Math.max(0, b.bytes - b.byteLimit), fmt: bytes },
  ];

  return (
    <>
      <div className="ctx-bars">
        {rows.map((r) => {
          const max = Math.max(r.limit, r.used, 1);
          const w = (n: number) => (n / max) * 100;
          return (
            <div key={r.key} className="ctx-meter">
              <div className="ctx-meter-head">
                <strong>{r.key}</strong>
                <span className="dim">{r.fmt(r.used)} used</span>
                {r.dropped > 0
                  ? <Mark glyph="⚠" word={`${r.fmt(r.dropped)} dropped`} color="var(--warning)" />
                  : <Mark glyph="●" word="fits" color="var(--good)" />}
                <span className="cap">limit {r.fmt(r.limit)}</span>
              </div>
              <svg className="chart-svg" viewBox="0 0 100 10" style={{ marginTop: 0 }} role="img"
                   aria-label={`${r.key}: ${r.fmt(r.used)} used of a ${r.fmt(r.limit)} limit, ${r.fmt(r.dropped)} dropped`}>
                <rect x="0" y="2" width="100" height="6" rx="3" fill="var(--bg-sunk)" />
                <rect x="0" y="2" width={Math.max(0.5, w(r.loaded))} height="6" rx="3" fill={SERIES[0]}>
                  <title>{`${r.fmt(r.loaded)} reaches the model`}</title>
                </rect>
                {r.dropped > 0 && (
                  <rect x={w(r.loaded)} y="2" width={w(r.dropped)} height="6" fill="var(--warning)">
                    <title>{`${r.fmt(r.dropped)} never reaches the model`}</title>
                  </rect>
                )}
                <line x1={w(r.limit)} x2={w(r.limit)} y1="0" y2="10" stroke="var(--text)" strokeWidth="0.4" />
              </svg>
            </div>
          );
        })}
      </div>

      <table className="viz-table">
        <thead>
          <tr>
            <th>Measure</th>
            <th style={{ textAlign: 'right' }}>In the file</th>
            <th style={{ textAlign: 'right' }}>Limit</th>
            <th style={{ textAlign: 'right' }}>Loads</th>
            <th style={{ textAlign: 'right' }}>Dropped</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td>{r.key}</td>
              <td className="n">{r.fmt(r.used)}</td>
              <td className="n">{r.fmt(r.limit)}</td>
              <td className="n">{r.fmt(r.loaded)}</td>
              <td className="n" style={{ color: r.dropped > 0 ? 'var(--warning)' : 'var(--text-dim)' }}>
                {r.dropped > 0 ? `⚠ ${r.fmt(r.dropped)}` : '0'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ marginTop: 10 }}>
        {b.overBudget
          ? <Callout level="warning" title="MEMORY.md is over budget.">{b.note}</Callout>
          : <Note tone="info">{b.note}</Note>}
      </div>
    </>
  );
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
      <h3 className="ctx-sub">The layers, lowest precedence first</h3>
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

      <h3 className="ctx-sub">Which layer won each key</h3>
      {c.settings.length === 0 ? (
        <p className="dim" style={{ fontSize: 12.5, lineHeight: 1.5 }}>
          No settings are set in any layer, so Claude Code runs on its own defaults here.
        </p>
      ) : (
        <div className="ctx-scroll">
          <table className="grid">
            <thead><tr><th>Key</th><th>Value in force</th><th>Won by</th><th>Shadowed</th></tr></thead>
            <tbody>
              {c.settings.map((s) => (
                <tr key={s.key}>
                  <td className="mono" style={{ fontSize: 11.5 }}>{s.key}</td>
                  <td className="mono" style={{ fontSize: 11.5, wordBreak: 'break-word' }}>{fmtValue(s.value)}</td>
                  <td><Mark {...LAYER[s.from]} /></td>
                  <td>
                    {s.shadowed.length === 0
                      ? <span className="faint" style={{ fontSize: 11.5 }}>nothing</span>
                      : s.shadowed.map((sh, i) => (
                          <div key={sh.from + i} style={{ fontSize: 11, lineHeight: 1.5 }}>
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

      <h3 className="ctx-sub">Hooks — {plural(c.hooks.length, 'hook')}</h3>
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
        <p className="dim" style={{ fontSize: 12.5, lineHeight: 1.5 }}>
          No hooks in any layer. Nothing runs automatically around your tool calls.
        </p>
      ) : (
        <div className="ctx-scroll">
          <table className="grid">
            <thead><tr><th>Event</th><th>Matcher</th><th>From</th><th>Runs</th><th>Defined in</th></tr></thead>
            <tbody>
              {c.hooks.map((h, i) => (
                <tr key={h.event + h.source + i}>
                  <td className="mono" style={{ fontSize: 11.5 }}>{h.event}</td>
                  <td className="mono faint" style={{ fontSize: 11.5 }}>{h.matcher ?? 'any'}</td>
                  <td>
                    {h.from === 'project'
                      ? <Mark glyph="⚠" word="project (shared)" color="var(--warning)"
                              title="Committed to the repository. It came from whoever wrote the repo, and it runs on your machine." />
                      : <Mark {...LAYER[h.from]} />}
                  </td>
                  <td className="mono" style={{ fontSize: 11.5, wordBreak: 'break-word' }}>
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
        <p className="faint" style={{ fontSize: 11.5, marginTop: 6, lineHeight: 1.5 }}>
          {plural(projectHooks.length, 'hook')} are defined inside this project rather than in your home
          directory. Moving one to <span className="mono">~/.claude/settings.json</span> keeps it off other
          people’s machines; moving it to <span className="mono">.claude/settings.local.json</span> keeps it
          out of the commit.
        </p>
      )}

      {c.permissions.length > 0 && (
        <>
          <h3 className="ctx-sub">Permission rules</h3>
          <div className="ctx-scroll">
            <table className="grid">
              <thead><tr><th>Layer</th><th className="r">Allow</th><th className="r">Ask</th><th className="r">Deny</th><th>Denied</th></tr></thead>
              <tbody>
                {c.permissions.map((p) => (
                  <tr key={p.from}>
                    <td><Mark {...LAYER[p.from]} /></td>
                    <td className="r">{num(p.allow.length)}</td>
                    <td className="r">{num(p.ask.length)}</td>
                    <td className="r">{num(p.deny.length)}</td>
                    <td className="mono faint" style={{ fontSize: 11.5, wordBreak: 'break-word' }}>
                      {p.deny.length === 0 ? '—' : p.deny.slice(0, 6).join(', ') + (p.deny.length > 6 ? ` +${p.deny.length - 6} more` : '')}
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
          <h3 className="ctx-sub">Also injected — {plural(also.length, 'entry', 'entries')}</h3>
          <div className="ctx-scroll">
            <table className="grid">
              <thead><tr><th>Kind</th><th>Name</th><th>Scope</th><th>Detail</th></tr></thead>
              <tbody>
                {also.map((x, i) => (
                  <tr key={x.kind + x.name + i}>
                    <td>{x.kind}</td>
                    <td className="mono" style={{ fontSize: 11.5 }}>{x.name}</td>
                    <td><Mark {...LAYER[x.scope === 'project' ? 'project' : 'user']} /></td>
                    <td className="dim trunc" title={`${x.detail}\n${x.source}`}>{x.detail || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {c.notes.length > 0 && (
        <>
          <h3 className="ctx-sub">What the scan found</h3>
          <Bullets items={c.notes} />
        </>
      )}
    </>
  );
}

/* ── 6 · budget ──────────────────────────────────────────────────────── */

function BudgetPanel({ b }: { b: ContextBudget }) {
  const rows = [...b.files].sort((x, y) => y.estTokens - x.estTokens);
  const total = rows.reduce((n, r) => n + r.estTokens, 0);
  const W = 100, GAP = 0.4;
  let x = 0;

  return (
    <>
      <div className="stat-grid">
        <Stat label="Estimated startup tokens" value={num(b.estTokens)} sub="read in full, every session" />
        <Stat label="Estimated cost per session"
              value={b.usdPerSession === null ? '—' : usd(b.usdPerSession)}
              sub={b.usdPerSession === null
                ? 'no price for the selected model'
                : <>{usd(b.usdPerSession * 100)} per 100 sessions{b.model ? <> · {b.model}</> : null}</>} />
        <Stat label="Files counted" value={num(b.files.length)} sub="everything that loads at launch" />
        <Stat label="On disk" value={bytes(b.totalBytes)} sub="before tokenising" />
      </div>

      {total > 0 && (
        <>
          <svg className="chart-svg" viewBox={`0 0 ${W} 14`} role="img"
               aria-label={rows.map((r) => `${r.label} ${num(r.estTokens)} tokens`).join(', ')}>
            {rows.map((r, i) => {
              const w = (r.estTokens / total) * W;
              const seg = (
                <rect key={r.path} x={x} y="0" width={Math.max(0, w - GAP)} height="10" rx="2"
                      fill={SERIES[i % SERIES.length]}>
                  <title>{`${r.label}: ${num(r.estTokens)} tokens (${((r.estTokens / total) * 100).toFixed(1)}%)`}</title>
                </rect>
              );
              x += w;
              return seg;
            })}
          </svg>
          <div className="legend">
            {rows.slice(0, 8).map((r, i) => (
              <span key={r.path} className="legend-item">
                <span className="legend-swatch" style={{ background: SERIES[i % SERIES.length] }} />
                {r.label} <span className="mono" style={{ color: 'var(--text-faint)' }}>{num(r.estTokens)}</span>
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
              <th style={{ textAlign: 'right' }}>Est. tokens</th>
              <th style={{ textAlign: 'right' }}>Share</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.path}>
                <td className="mono" style={{ fontSize: 11.5, wordBreak: 'break-all' }} title={r.path}>
                  {fileName(r.path)}
                </td>
                <td className="dim">{r.label.split(' · ')[0]}</td>
                <td className="n">{bytes(r.bytes)}</td>
                <td className="n">{num(r.estTokens)}</td>
                <td className="n" style={{ color: 'var(--text-dim)' }}>
                  {total > 0 ? `${((r.estTokens / total) * 100).toFixed(1)}%` : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 12 }}>
        <Note tone="info"><strong>Estimate, not a measurement.</strong> {b.note}</Note>
      </div>
    </>
  );
}

/* ── the empty state ─────────────────────────────────────────────────── */

function Setup({ full, project, slots, onInit, initMsg }: {
  full?: boolean;
  project: Project;
  slots: typeof SLOTS;
  onInit: () => void;
  initMsg: { tone: 'ok' | 'info'; text: string } | null;
}) {
  const offerInit = slots.some((s) => s.key === 'chain');
  return (
    <section className="card" style={{ padding: 16 }}>
      <h2 style={{ fontSize: 14, fontWeight: 600 }}>
        {full ? `Nothing is loaded in ${project.name} yet` : 'Slots that are still empty'}
      </h2>
      <p className="dim" style={{ fontSize: 12.5, lineHeight: 1.55, marginTop: 5, maxWidth: 660 }}>
        {full
          ? <>A session started here right now would begin with no project instructions, no memories and no
              project settings — only what your home directory and machine policy contribute. Here is what
              each slot would do once it exists.</>
          : <>Each panel above shows what is actually loading. These slots have nothing of{' '}
              <strong>this project’s</strong> own in them yet — a panel above may still be showing what the
              repo inherits from your home directory or a parent folder.</>}
      </p>

      <div className="ctx-slots" style={{ marginTop: 12 }}>
        {slots.map((s) => (
          <div key={s.key} className="ctx-slot">
            <span style={{ marginTop: 1, width: 19, height: 19, flex: 'none', borderRadius: 999,
                           display: 'grid', placeItems: 'center', fontSize: 11, fontWeight: 700,
                           background: 'var(--bg-sunk)', color: 'var(--text-faint)' }}>{s.n}</span>
            <h4 className="mono">{s.title}</h4>
            <div style={{ minWidth: 0 }}>
              <p>{s.what}</p>
              <p className="how">{s.how}</p>
            </div>
          </div>
        ))}
      </div>

      {offerInit && (
        <>
          <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
            <button className="btn btn-primary" onClick={onInit}>Type /init into a session</button>
          </div>
          <p className="faint" style={{ fontSize: 11.5, lineHeight: 1.5, marginTop: 7, maxWidth: 660 }}>
            /init reads the repository and drafts a CLAUDE.md from what is actually in it. Wanigan types the
            command into a running session in {project.name} and stops there — you press Enter, and you review
            the file it writes.
          </p>
        </>
      )}
      {initMsg && (
        <div style={{ marginTop: 10 }}>
          <Note tone={initMsg.tone === 'ok' ? 'ok' : 'info'}>{initMsg.text}</Note>
        </div>
      )}
    </section>
  );
}
