import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ForgedSkill, Project, ProviderInfo, SkillDiagnostic, SkillInstallResult } from '@shared/types';
import { Chip, EmptyState, Hint, Icon, Mark, Note, PageHead, Reading, Section, SectionHead, Segmented, ago, num } from '../components/bits';
import { useRememberedScrollRef, useViewMemory } from '../components/viewMemory';
import '../styles/skills.css';

/**
 * The skills on this machine, as a catalogue you can fire into a running agent
 * rather than one you read.
 *
 * Three things here are load-bearing rather than decorative:
 *
 *  - Ranking is shown, not asserted. Every match paints the characters it
 *    matched with <mark>, so "vbc → verification-before-completion" is visibly
 *    a subsequence hit and not a coincidence. A ranking you cannot see is a
 *    ranking you cannot trust.
 *  - Source is a categorical encoding: fixed slot order (--series-1..4) plus a
 *    glyph plus the word. Hue never carries it alone.
 *  - A filter that would return nothing is DISABLED, never hidden. A control
 *    that vanishes cannot be told apart from one that never existed.
 *
 * Writing a skill lives here too, next to the catalogue it adds a row to. It
 * used to be a separate destination also called "Skills", inside Learning,
 * which meant the place you browsed skills and the place you wrote one shared
 * a name and nothing else. It is hand-authoring and says so: see SkillWriter.
 */

type SkillSource = 'user' | 'project' | 'plugin' | 'builtin';

type SkillInfo = {
  name: string;
  description: string;
  source: SkillSource;
  path: string;
  dir: string;
  invoke: string;
  plugin: string | null;
  marketplace: string | null;
  projectId: string | null;
  allowedTools: string[];
  extras: number;
  bytes: number;
  modified: number;
};

type SkillRoot = { source: SkillSource; path: string; exists: boolean; note: string | null };

type Catalogue = {
  skills: SkillInfo[];
  counts: Record<SkillSource, number>;
  roots: SkillRoot[];
  scannedAt: number;
};

/** Slot order IS the colourblind-safety mechanism — never reordered to suit meaning. */
const SOURCES: { id: SkillSource; word: string; glyph: string; color: string; blurb: string }[] = [
  { id: 'user',    word: 'user',     glyph: '◆', color: 'var(--series-1)', blurb: 'yours, on this machine' },
  { id: 'project', word: 'project',  glyph: '■', color: 'var(--series-2)', blurb: 'stored in this repository' },
  { id: 'plugin',  word: 'plugin',   glyph: '▲', color: 'var(--series-3)', blurb: 'installed by a plugin' },
  { id: 'builtin', word: 'built-in', glyph: '○', color: 'var(--series-4)', blurb: 'bundled with Claude Code' },
];
const SRC = Object.fromEntries(SOURCES.map((s) => [s.id, s])) as Record<SkillSource, (typeof SOURCES)[number]>;

const OPT_ID = (i: number) => `skills-opt-${i}`;
const MAX_SUGGESTIONS = 8;

/* ── matching ────────────────────────────────────────────────────────── */

/** Lower is better. The tiers are the promise the <mark>s have to keep. */
const TIER = {
  namePrefix: 0,
  nameSubstring: 1,
  nameSubsequence: 2,
  description: 3,
  unfiltered: 4,
} as const;

const TIER_WORD = [
  'name starts with it',
  'name contains it',
  'letters in order',
  'in the description',
  '',
];

type Hit = {
  skill: SkillInfo;
  tier: number;
  score: number;
  nameHits: number[] | null;
  descHits: number[] | null;
};

const run = (at: number, len: number) => Array.from({ length: len }, (_, i) => at + i);

/**
 * Indices are found against the lowercased string and painted onto the original.
 * For a handful of scripts toLowerCase() changes length, which would slide every
 * mark sideways — in that case mark nothing rather than mark the wrong letters.
 */
const alignable = (s: string) => s.toLowerCase().length === s.length;

/**
 * Letters in order. The forward pass proves a match exists; the backward pass
 * re-matches from that end point to find the tightest one, so "vbc" lands on
 * the three word starts of verification-before-completion instead of three
 * letters scattered through it.
 */
function subsequence(hay: string, needle: string): number[] | null {
  let from = 0;
  let end = -1;
  for (const ch of needle) {
    const at = hay.indexOf(ch, from);
    if (at === -1) return null;
    from = at + 1;
    end = at;
  }
  const out = new Array<number>(needle.length);
  let limit = end;
  for (let k = needle.length - 1; k >= 0; k--) {
    while (limit >= 0 && hay[limit] !== needle[k]) limit--;
    out[k] = limit;
    limit--;
  }
  return out;
}

/** A compact match that lands on word starts reads as intentional; a smeared one is noise. */
function tightness(hay: string, hits: number[]): number {
  const span = hits[hits.length - 1] - hits[0] + 1;
  let bonus = 0;
  for (const i of hits) if (i === 0 || !/[a-z0-9]/.test(hay[i - 1])) bonus += 9;
  return bonus - span - hits[0] / 4;
}

function match(skill: SkillInfo, q: string): Hit | null {
  const name = skill.name.toLowerCase();
  const nameOk = alignable(skill.name);
  const hit = (tier: number, score: number, nameHits: number[] | null, descHits: number[] | null): Hit =>
    ({ skill, tier, score, nameHits: nameOk ? nameHits : null, descHits });

  if (name.startsWith(q)) return hit(TIER.namePrefix, 100 - name.length / 10, run(0, q.length), null);

  const at = name.indexOf(q);
  if (at > -1) return hit(TIER.nameSubstring, 60 - at, run(at, q.length), null);

  const seq = subsequence(name, q.replace(/\s+/g, ''));
  if (seq) return hit(TIER.nameSubsequence, tightness(name, seq), seq, null);

  // Descriptions are matched as a substring only. A subsequence over a
  // paragraph of prose matches nearly every skill, which would make the tiers
  // above meaningless and the <mark>s untrustable.
  const desc = skill.description.toLowerCase();
  const dAt = desc.indexOf(q);
  if (dAt > -1) {
    return hit(TIER.description, 20 - Math.min(20, dAt / 60), null,
               alignable(skill.description) ? run(dAt, q.length) : null);
  }
  return null;
}

/* ── formatting ──────────────────────────────────────────────────────── */

function fileSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/* ── view ────────────────────────────────────────────────────────────── */

export default function Skills({ projectId, providers, activeSessionId }: {
  projectId?: string; providers: ProviderInfo[]; activeSessionId?: string | null;
}) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [projectsErr, setProjectsErr] = useState<string | null>(null);
  const [projectRead, setProjectRead] = useState(0);
  const [pinned, setPinned] = useViewMemory<string | null>('project-pin', null);
  useEffect(() => {
    let live = true;
    window.wanigan.projects.list().then(list => { if (live) { setProjects(list); setProjectsErr(null); } })
      .catch(error => { if (live) setProjectsErr(msg(error)); });
    return () => { live = false; };
  }, [projectRead]);
  const pinnedLive = pinned !== null && (pinned === '' || projects === null || projects.some(p => p.id === pinned));
  const scopeId = pinnedLive ? pinned || undefined : projectId;
  const project = projects?.find(p => p.id === scopeId) ?? null;
  return <SkillsWorkspace key={scopeId ?? 'personal'} scopeId={scopeId} project={project} projects={projects}
    projectsErr={projectsErr} retryProjects={() => setProjectRead(n => n + 1)} providers={providers}
    activeSessionId={activeSessionId} pinned={pinnedLive && pinned !== projectId} onPin={setPinned} />;
}

type SkillsArea = 'library' | 'write' | 'sources';

function SkillsWorkspace({ scopeId, project, projects, projectsErr, retryProjects, providers, activeSessionId, pinned, onPin }: {
  scopeId?: string; project: Project | null; projects: Project[] | null; projectsErr: string | null; retryProjects: () => void;
  providers: ProviderInfo[]; activeSessionId?: string | null; pinned: boolean; onPin: (id: string | null) => void;
}) {
  const [area, setArea] = useViewMemory<SkillsArea>('area', 'library');
  const [cat, setCat] = useState<Catalogue | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [q, setQ] = useViewMemory(`catalogue/${scopeId}/query`, '');
  const [sources, setSources] = useViewMemory<Set<SkillSource>>(`catalogue/${scopeId}/sources`, new Set());
  const [selectedPath, setSelectedPath] = useViewMemory<string | null>(`catalogue/${scopeId}/selected`, null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [sending, setSending] = useState(false);
  const [flash, setFlash] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const popRef = useRef<HTMLUListElement>(null);
  const optRefs = useRef<(HTMLLIElement | null)[]>([]);
  const alive = useRef(true), sequence = useRef(0), sendLock = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; sequence.current++; }; }, []);
  const load = useCallback(async (rescan = false) => {
    const mine = ++sequence.current;
    setScanning(true);
    try {
      if (rescan) await window.wanigan.skills.refresh();
      const next = await window.wanigan.skills.list(scopeId) as Catalogue;
      if (alive.current && mine === sequence.current) { setCat(next); setLoadErr(null); }
    } catch (error) { if (alive.current && mine === sequence.current) setLoadErr(msg(error)); }
    finally { if (alive.current && mine === sequence.current) setScanning(false); }
  }, [scopeId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (!flash) return; const timer = setTimeout(() => setFlash(null), 6000); return () => clearTimeout(timer); }, [flash]);
  const query = q.trim().toLowerCase();
  const matched = useMemo<Hit[]>(() => {
    if (!cat) return [];
    if (!query) return cat.skills.map(skill => ({ skill, tier:TIER.unfiltered, score:0, nameHits:null, descHits:null }));
    return cat.skills.map(skill => match(skill, query)).filter((hit): hit is Hit => hit !== null)
      .sort((a,b) => a.tier - b.tier || b.score - a.score || a.skill.name.localeCompare(b.skill.name));
  }, [cat, query]);
  const facets = useMemo(() => { const counts: Record<SkillSource, number> = {user:0, project:0, plugin:0, builtin:0}; for (const hit of matched) counts[hit.skill.source]++; return counts; }, [matched]);
  const visible = useMemo(() => sources.size ? matched.filter(hit => sources.has(hit.skill.source)) : matched, [matched, sources]);
  const suggestions = query ? visible.slice(0, MAX_SUGGESTIONS) : [];
  const selected = visible.find(hit => hit.skill.path === selectedPath)?.skill ?? visible[0]?.skill ?? null;
  const total = cat?.skills.length ?? 0;
  const panelRef = useRememberedScrollRef(`skills/${scopeId}/${area}`);
  useEffect(() => {
    if (!open || active < 0) return;
    const list = popRef.current, el = optRefs.current[active];
    if (!list || !el) return;
    if (el.offsetTop < list.scrollTop) list.scrollTop = el.offsetTop;
    else if (el.offsetTop + el.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = el.offsetTop + el.offsetHeight - list.clientHeight;
  }, [active, open, suggestions.length]);
  useEffect(() => { if (active >= suggestions.length) setActive(suggestions.length - 1); }, [suggestions.length, active]);
  const clear = () => { setQ(''); setSources(new Set()); setOpen(false); setActive(-1); };
  const choose = (hit: Hit) => { setSelectedPath(hit.skill.path); setOpen(false); setActive(-1); inputRef.current?.focus(); };
  const onKey = (event: React.KeyboardEvent<HTMLInputElement>) => {
    const n = suggestions.length;
    if (['ArrowDown','ArrowUp'].includes(event.key) && n) {
      event.preventDefault();
      if (!open) { setOpen(true); setActive(event.key === 'ArrowDown' ? 0 : n - 1); }
      else setActive(i => event.key === 'ArrowDown' ? (i + 1) % n : (i <= 0 ? n - 1 : i - 1));
    } else if (['Home','End'].includes(event.key) && open && n) { event.preventDefault(); setActive(event.key === 'Home' ? 0 : n - 1); }
    else if (event.key === 'Enter' && open && active >= 0 && suggestions[active]) { event.preventDefault(); choose(suggestions[active]); }
    else if (event.key === 'Escape') { event.preventDefault(); if (open) { setOpen(false); setActive(-1); } else setQ(''); }
    else if (event.key === 'Tab') { setOpen(false); setActive(-1); }
  };
  const send = async (skill: SkillInfo) => {
    if (!activeSessionId || sendLock.current || loadErr) return;
    sendLock.current = true; setSending(true);
    try {
      await window.wanigan.skills.send(activeSessionId, skill.invoke);
      if (alive.current) setFlash({tone:'ok',text:`Typed ${skill.invoke} into the selected session. It is not submitted; press Enter in that session to run it.`});
    } catch (error) { if (alive.current) setFlash({tone:'error',text:`Could not type ${skill.invoke}: ${msg(error)}`}); }
    finally { sendLock.current = false; if (alive.current) setSending(false); }
  };
  const copy = async (skill: SkillInfo) => {
    try { await navigator.clipboard.writeText(skill.invoke); if (alive.current) setFlash({tone:'ok',text:`Copied ${skill.invoke}.`}); }
    catch (error) { if (alive.current) setFlash({tone:'error',text:`The clipboard could not be written: ${msg(error)}. Select the invocation and copy it manually.`}); }
  };

  return <div className="pane wide skills-view">
    <PageHead compact title="Skills" lead="Find the right workflow. Keep the craft close." actions={<>
      {projects && projects.length > 0 && <select className="field skills-project" aria-label="Which repository's project skills to include" value={scopeId ?? ''} onChange={event => onPin(event.target.value)}>
        <option value="">No repository</option>{projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>}
      <button className="btn" disabled={scanning} onClick={() => void load(true)}>{scanning ? 'Scanning…' : 'Rescan disk'}</button>
      <button className="btn btn-primary" onClick={() => setArea('write')}><Icon name="plus" />Write a skill</button>
    </>} />
    {projectsErr && <Note tone="warn">The project list could not be read: {projectsErr}. <button className="link" onClick={retryProjects}>Retry project list</button></Note>}
    {pinned && <div className="skills-pin"><Hint>{scopeId ? `Project skills from ${project?.name ?? scopeId}.` : 'Project skills excluded.'} This choice stays within Skills.</Hint><button className="link" onClick={() => onPin(null)}>Follow the app’s project</button></div>}
    {flash && <Note tone={flash.tone} onDismiss={() => setFlash(null)}>{flash.text}</Note>}
    <div className="skills-workspace">
      <div className="skills-navigation"><Segmented label="Skills workspace" value={area} onChange={setArea} options={[{value:'library',label:'Library'},{value:'write',label:'Write'},{value:'sources',label:'Sources'}]} /><Hint>{cat ? `${num(total)} Claude Code skills · scanned ${ago(cat.scannedAt)}` : 'Claude Code catalogue'}</Hint></div>
      <div className="skills-scroll" data-area={area} ref={panelRef} tabIndex={0} aria-label={`${area === 'library' ? 'Skill library' : area === 'write' ? 'Skill writer' : 'Skill sources'}`}>
        {loadErr && <Note tone="error">The skill scan did not finish: {loadErr}.{cat ? ' The last successful scan is still shown.' : ' No catalogue has been read.'} <button className="link" disabled={scanning} onClick={() => void load(true)}>Scan again</button></Note>}
        {area === 'library' && (!cat ? !loadErr && <Reading what="skill directories" /> : <div className="skills-library">
          <aside className="skills-directory" aria-label="Skill catalogue">
            <SectionHead label="Your workflows" count={visible.length} />
            <div className="skills-search-wrap">
              <input ref={inputRef} className="field skills-search" role="combobox" type="text" aria-label="Search skills by name or description" aria-expanded={open && suggestions.length > 0} aria-controls="skills-typeahead" aria-autocomplete="list" aria-activedescendant={open && active >= 0 ? OPT_ID(active) : undefined} autoComplete="off" spellCheck={false} placeholder="Find a skill…" value={q} onChange={event => { setQ(event.target.value); setOpen(true); setActive(-1); }} onKeyDown={onKey} onFocus={() => { if (q) setOpen(true); }} onBlur={() => { setOpen(false); setActive(-1); }} />
              <ul id="skills-typeahead" className="skills-pop" role="listbox" aria-label="Skill matches" ref={popRef} hidden={!open || !suggestions.length}>{suggestions.map((hit,i) => <li key={hit.skill.path} id={OPT_ID(i)} role="option" aria-selected={active === i} className={`skills-opt${active === i ? ' on' : ''}`} ref={el => { optRefs.current[i] = el; }} onMouseDown={event => event.preventDefault()} onClick={() => choose(hit)}><strong><Marked text={hit.skill.name} hits={hit.nameHits} /></strong><small>{TIER_WORD[hit.tier]} · {SRC[hit.skill.source].word}</small></li>)}</ul>
            </div>
            <div className="skills-filters">{SOURCES.map(source => <Chip key={source.id} pressed={sources.has(source.id)} count={facets[source.id]} disabled={!facets[source.id] && !sources.has(source.id)} onToggle={() => setSources(previous => { const next = new Set(previous); if (next.has(source.id)) next.delete(source.id); else next.add(source.id); return next; })}><span aria-hidden="true" style={{color:source.color}}>{source.glyph}</span>{source.word}</Chip>)}</div>
            <div className="skills-count" role="status">{q || sources.size ? <><span>{visible.length} of {total} skills match</span><button className="link" onClick={clear}>Clear filters</button></> : <span>Names first, then descriptions. Matched letters are highlighted.</span>}</div>
            {total === 0 ? <EmptyState posture="nothing-yet" title="No Claude Code skills found" cue="Write a skill, or check Sources to see which directories were scanned." action={<button className="btn" onClick={() => setArea('write')}>Write a skill</button>} />
              : visible.length === 0 ? <EmptyState posture="nothing-in-scope" title={matched.length ? 'Sources hide every match' : 'No skill matches this search'} cue={matched.length ? 'Choose another source or clear the filters.' : 'Try part of a name, its initials, or a phrase from the description.'} action={<button className="btn" onClick={clear}>Clear filters</button>} />
              : <div className="skills-list">{visible.map(hit => <SkillEntry key={hit.skill.path} hit={hit} selected={selected?.path === hit.skill.path} onRead={() => setSelectedPath(hit.skill.path)} />)}</div>}
            <Hint>Project files take precedence over user and plugin skills with the same invocation. Built-ins show only those seen on disk.</Hint>
          </aside>
          {selected ? <Reader key={selected.path} skill={selected} scanAt={cat.scannedAt} canSend={!!activeSessionId && !loadErr} sending={sending} onSend={() => void send(selected)} onCopy={() => void copy(selected)} /> : <div className="skills-reader-empty"><EmptyState posture="nothing-in-scope" title="A workflow, in full" cue="Choose a skill to read its instructions, source, and invocation here." /></div>}
        </div>)}
        <div hidden={area !== 'write'}>{scopeId && !project
          ? projects === null && !projectsErr ? <Reading what="project details" />
            : <EmptyState posture="could-not-read" title="This repository is unavailable" cue="Choose an available repository, or choose No repository to write a personal skill." action={<button className="btn" onClick={retryProjects}>Retry project list</button>} />
          : <SkillWriter key={project?.id ?? 'personal'} project={project} providers={providers} onInstalled={() => void load(true)} />}</div>
        {area === 'sources' && (cat ? <Roots cat={cat} /> : !loadErr && <Reading what="skill sources" />)}
      </div>
    </div>
  </div>;
}

/* ── writing one ─────────────────────────────────────────────────────── */

/**
 * A form that writes a SKILL.md.
 *
 * The honesty constraint is the whole design here. Nothing on this panel reads
 * your sessions, signals or transcripts: `learning.forgeSkill` renders the
 * words you type into the Agent Skills document shape, and `installSkill`
 * writes that exact reviewed text to a provider directory. A sibling helper
 * that claimed to derive a skill from recorded signals never had a caller and
 * is gone; this panel must not inherit its vocabulary. So: no "learned", no
 * "forged from your work", and the generated body is on screen in full before
 * anything is written.
 *
 * The preview has four states and they are not each other — no draft yet,
 * building one, a build that failed, and a draft you can read. Install has its
 * own three, per provider, because a directory that refused the write must not
 * be hidden by one that accepted it.
 */


type Draft =
  | { s: 'none' }
  | { s: 'building' }
  | { s: 'err'; message: string }
  | { s: 'ok'; skill: ForgedSkill; diagnostics: SkillDiagnostic[] };

type Install =
  | { s: 'idle' }
  | { s: 'writing' }
  | { s: 'err'; message: string; results: SkillInstallResult[] }
  | { s: 'done'; results: SkillInstallResult[] };

const SEVERITY_MARK: Record<SkillDiagnostic['severity'], { glyph: string; color: string }> = {
  error:   { glyph: '✕', color: 'var(--bad)' },
  warning: { glyph: '⚠', color: 'var(--warn)' },
  info:    { glyph: '·', color: 'var(--text-dim)' },
};

function SkillWriter({ project, providers, onInstalled }: {
  /** The repository this view is scoped to — the same one whose project
   *  skills are in the catalogue above, so a project skill written here
   *  appears in it on the rescan rather than somewhere you are not looking. */
  project: Project | null;
  providers: ProviderInfo[];
  onInstalled: () => void;
}) {
  const [name, setName] = useViewMemory(`writer/${project?.id}/name`, '');
  const [description, setDescription] = useViewMemory(`writer/${project?.id}/description`, '');
  const [trigger, setTrigger] = useViewMemory(`writer/${project?.id}/trigger`, '');
  const [steps, setSteps] = useViewMemory(`writer/${project?.id}/steps`, 'Inspect the relevant files\nMake the smallest safe change\nRun the project review gate');
  const [verification, setVerification] = useViewMemory(`writer/${project?.id}/verification`, 'Run the relevant tests\nReview the final diff');
  const [scope, setScope] = useViewMemory<'personal' | 'project'>(`writer/${project?.id}/scope`, 'personal');
  const [draft, setDraft] = useState<Draft>({ s: 'none' });
  const [install, setInstall] = useState<Install>({ s: 'idle' });

  /* Which providers get the file. `null` is "every runtime that was detected",
     which is not the same answer as a list that happens to contain all of them
     — it is the absence of a choice, and it has to survive the shell handing
     this view a fresh `providers` array on every window focus. Keying the seed
     to that array identity would tick a deliberately cleared checkbox back on
     every time you switched apps and came back. */
  const [chosen, setChosen] = useViewMemory<string[] | null>(`writer/${project?.id}/targets`, null);
  const detected = providers.map((p) => p.id);
  const detectedKey = detected.join('\u0000');
  useEffect(() => {
    // A provider that disappeared is not a target any more; a choice that is
    // still valid is left exactly as it was made.
    setChosen((prev) => (prev === null
      ? null
      : prev.filter((id) => detectedKey.split('\u0000').includes(id))));
  }, [detectedKey]);
  const targets = chosen ?? detected;
  const setTargets = setChosen;

  // Losing the repository (removed, or the pin changed) must not leave a
  // "Project skill" selection pointing at nothing.
  useEffect(() => { if (!project) setScope('personal'); }, [project]);

  const revision = useRef(0), writing = useRef(false), live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; revision.current++; }; }, []);
  useEffect(() => { revision.current++; setDraft({s:'none'}); }, [project?.id, detectedKey]);
  const named = name.trim();
  const ready = named !== '' && description.trim() !== '' && trigger.trim() !== '';

  // A draft belongs to the words that produced it. Any edit invalidates it,
  // rather than leaving a stale preview beside a changed form.
  const edit = <T,>(set: (v: T) => void) => (v: T) => {
    revision.current++;
    set(v);
    setDraft((d) => (d.s === 'none' ? d : { s: 'none' }));
    setInstall({ s: 'idle' });
  };

  async function build() {
    if (writing.current) return;
    const mine = ++revision.current;
    setInstall({ s: 'idle' });
    setDraft({ s: 'building' });
    try {
      const skill = await window.wanigan.learning.forgeSkill({
        name: named,
        description: description.trim(),
        trigger: trigger.trim(),
        scope,
        steps: steps.split('\n')
          .map((instruction, i) => ({ title: `Step ${i + 1}`, instruction: instruction.trim() }))
          .filter((step) => step.instruction),
        verification: verification.split('\n').map((line) => line.trim()).filter(Boolean),
        providerIds: targets,
      });
      // Checked against the repository so a path-sensitive diagnostic can be
      // real rather than generic.
      if (!live.current || mine !== revision.current) return;
      const diagnostics = await window.wanigan.learning.doctorSkill(skill.skillMd, project?.path);
      if (live.current && mine === revision.current) setDraft({ s: 'ok', skill, diagnostics });
    } catch (e) {
      if (live.current && mine === revision.current) setDraft({ s: 'err', message: msg(e) });
    }
  }

  async function write(skill: ForgedSkill) {
    if (writing.current || draft.s !== 'ok' || blocking || !targets.length) return;
    const prior = install.s === 'done' || install.s === 'err' ? install.results : [];
    const retryTargets = prior.length ? targets.filter(id => !prior.some(result => result.providerId === id && !result.error)) : targets;
    if (!retryTargets.length) return;
    writing.current = true;
    setInstall({ s: 'writing' });
    try {
      const results = await window.wanigan.learning.installSkill(
        skill, retryTargets, scope === 'project' ? project?.id ?? null : null);
      const merged = [...prior.filter(result => !retryTargets.includes(result.providerId)), ...results];
      if (live.current) setInstall({ s: 'done', results: merged });
      // The catalogue above is now out of date by exactly this file.
      onInstalled();
    } catch (e) {
      if (live.current) setInstall({ s: 'err', message: msg(e), results: prior });
    } finally { writing.current = false; }
  }

  const blocking = draft.s === 'ok' && draft.diagnostics.some((d) => d.severity === 'error');

  return (
    <section className="skills-authoring">
      <div className="skills-authoring-intro"><SectionHead label="Write a workflow" /><h2>Your method. Ready to reuse.</h2><p>Write the instructions, review the exact SKILL.md, then choose where to install it. Wanigan formats your words locally; this form does not read sessions or ask a model.</p></div>
      <div id="skills-writer">
        {providers.length === 0 ? (
          <Note tone="warn">
            <strong>⚠ No agent runtime was detected</strong>, so there is no provider skills directory to
            write into. Install a CLI (Settings › Agents &amp; providers lists what Wanigan looked for),
            then come back — the form is otherwise unchanged.
          </Note>
        ) : (
          <div className="skills-writer">
            <fieldset className="skills-writer-form" disabled={install.s === 'writing'}>
              <legend className="sr-only">Skill instructions and destinations</legend>
              <label>
                <span className="label">Skill name</span>
                <input className="field mono" value={name} placeholder="verification-before-completion"
                       autoComplete="off" spellCheck={false}
                       onChange={(e) => edit(setName)(e.target.value)} />
              </label>
              <label>
                <span className="label">Description</span>
                <input className="field" value={description} placeholder="What this workflow reliably accomplishes"
                       onChange={(e) => edit(setDescription)(e.target.value)} />
              </label>
              <label>
                <span className="label">Trigger</span>
                <textarea className="field" rows={3} value={trigger}
                          placeholder="When should an agent discover and use it?"
                          onChange={(e) => edit(setTrigger)(e.target.value)} />
              </label>
              <label>
                <span className="label">Steps · one per line</span>
                <textarea className="field mono" rows={6} value={steps}
                          onChange={(e) => edit(setSteps)(e.target.value)} />
              </label>
              <label>
                <span className="label">Verification · one per line</span>
                <textarea className="field mono" rows={4} value={verification}
                          onChange={(e) => edit(setVerification)(e.target.value)} />
              </label>

              <div className="skills-writer-row">
                <label>
                  <span className="label">Where it lives</span>
                  <select className="field" value={scope} disabled={!project}
                          onChange={(e) => edit(setScope)(e.target.value as 'personal' | 'project')}>
                    <option value="personal">My skills — this machine only</option>
                    {project && <option value="project">Project skill — {project.name}</option>}
                  </select>
                </label>
                <fieldset className="skills-writer-targets">
                  <legend className="label">Write it for</legend>
                  {providers.map((p) => (
                    <label key={p.id}>
                      <input type="checkbox" checked={targets.includes(p.id)}
                             onChange={(e) => edit(setTargets)(e.target.checked
                               ? [...targets, p.id]
                               : targets.filter((id) => id !== p.id))} />
                      {p.label}
                    </label>
                  ))}
                </fieldset>
              </div>

              {!project && (
                <p className="faint" style={{ fontSize: 'var(--t-micro)', lineHeight: 1.5 }}>
                  No repository is picked above, so only a personal skill can be written. Pick one in
                  “Project skills from” to write into a repo instead.
                </p>
              )}

              <button className="btn btn-primary" type="button"
                      disabled={!ready || draft.s === 'building' || targets.length === 0 || install.s === 'writing'}
                      onClick={() => void build()}>
                {draft.s === 'building' ? 'Building…' : 'Build the SKILL.md'}
              </button>
              {!ready && (
                <p className="faint" style={{ fontSize: 'var(--t-micro)' }}>
                  Wanigan needs all three to write a useful file. The spec itself requires none of
                  them — a skill with no frontmatter takes its name from the directory — but
                  description and when-to-use are the only text an agent reads while deciding
                  whether to load the skill at all.
                </p>
              )}
              {ready && targets.length === 0 && (
                <p className="faint" style={{ fontSize: 'var(--t-micro)' }}>
                  Pick at least one provider. Each one is written independently, into its own directory.
                </p>
              )}
            </fieldset>

            <aside className="skills-writer-preview">
              <div className="label">
                Preview
                {draft.s === 'ok' && (
                  <span className="faint" style={{ marginLeft: 8, textTransform: 'none', letterSpacing: 0 }}>
                    ~{num(draft.skill.estimatedTokens)} est. tokens
                  </span>
                )}
              </div>

              {draft.s === 'none' && (
                <p className="dim">
                  No draft yet. Fill the form and press <strong>Build the SKILL.md</strong> — the exact file
                  that would be written appears here, in full, before anything touches disk.
                </p>
              )}
              {draft.s === 'building' && <p className="dim">Building the document and checking it…</p>}
              {draft.s === 'err' && (
                <Note tone="error">
                  <strong>✕ The draft could not be built.</strong> {draft.message}
                </Note>
              )}

              {draft.s === 'ok' && (
                <>
                  <pre className="skills-writer-md mono">{draft.skill.skillMd}</pre>

                  {draft.diagnostics.length === 0 ? (
                    <p style={{ color: 'var(--good)', fontSize: 'var(--t-small)' }}>
                      <span aria-hidden="true">✓</span> The checker found nothing to report.
                    </p>
                  ) : (
                    <ul className="skills-writer-doctor">
                      {draft.diagnostics.map((d, i) => {
                        const m = SEVERITY_MARK[d.severity];
                        return (
                          <li key={`${d.code}-${i}`} style={{ color: m.color }}>
                            <span aria-hidden="true">{m.glyph}</span>{' '}
                            <span className="mono">{d.code}</span> {d.message}
                            {d.line ? ` · line ${d.line}` : ''}
                          </li>
                        );
                      })}
                    </ul>
                  )}

                  <button className="btn btn-primary" type="button"
                          disabled={blocking || install.s === 'writing' || (install.s === 'done' && install.results.length > 0 && install.results.every(result => !result.error)) || targets.length === 0}
                          onClick={() => void write(draft.skill)}>
                    {install.s === 'writing' ? 'Writing…' : install.s === 'done' && install.results.length > 0 && install.results.every(result => !result.error) ? 'Installed' : (install.s === 'done' || (install.s === 'err' && install.results.length > 0)) ? 'Retry failed providers' : `Write ${draft.skill.name} to disk`}
                  </button>
                  {blocking && (
                    <p style={{ color: 'var(--bad)', fontSize: 'var(--t-micro)', lineHeight: 1.5 }}>
                      An error-level check has to be fixed in the form above first.
                    </p>
                  )}

                  {install.s === 'err' && (
                    <Note tone="error"><strong>The write did not complete.</strong> {install.message}</Note>
                  )}
                  {(install.s === 'done' || install.s === 'err') && install.results.length > 0 && (
                    <ul className="skills-writer-doctor">
                      {install.results.map((r) => (
                        <li key={r.providerId} style={{ color: r.error ? 'var(--bad)' : 'var(--good)' }}>
                          <span aria-hidden="true">{r.error ? '✕' : '✓'}</span>{' '}
                          {r.error
                            ? <>{r.providerId}: {r.error}</>
                            : <>{r.providerId} · <span className="mono">{r.projection?.targetPath ?? 'written'}</span></>}
                        </li>
                      ))}
                    </ul>
                  )}
                  {(install.s === 'done' || install.s === 'err') && install.results.some((r) => !r.error) && (
                    <WriteAftermath results={install.results} />
                  )}

                  <p className="faint" style={{ fontSize: 'var(--t-micro)', lineHeight: 1.5 }}>
                    Project: Claude <span className="mono">.claude/skills/{draft.skill.name}</span> · Codex{' '}
                    <span className="mono">.agents/skills/{draft.skill.name}</span>. Personal skills use the
                    matching directories under your home folder.
                  </p>
                </>
              )}
            </aside>
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * What actually happened, per path.
 *
 * The catalogue on this page scans `.claude/skills` roots and nothing else, so
 * a file written to a Codex `.agents/skills` directory exists on disk and will
 * never appear in the list above. Saying "rescanned" without saying that would
 * be an implied capability, and the missing row would read as a failed write.
 */
function WriteAftermath({ results }: { results: SkillInstallResult[] }) {
  const written = results.filter((r) => !r.error);
  const unlisted = written.filter((r) => !(r.projection?.targetPath ?? '').includes('/.claude/skills/'));
  return (
    <p className="faint" style={{ fontSize: 'var(--t-micro)', lineHeight: 1.5 }}>
      The catalogue above has been rescanned.
      {unlisted.length > 0 && (
        <> It reads <span className="mono">.claude/skills</span> roots only, so{' '}
          {unlisted.length === 1 ? 'one of these files' : `${num(unlisted.length)} of these files`} is on
          disk but will not appear in the list — {unlisted.map((r) => r.providerId).join(', ')}.</>
      )}
      {' '}No git commit was made. Review any project changes before committing them.
    </p>
  );
}

/* ── pieces ──────────────────────────────────────────────────────────── */

/** Paints the matched characters. The ranking is only trustable if it is visible. */
function Marked({ text, hits }: { text: string; hits: number[] | null }) {
  if (!hits || hits.length === 0) return <>{text}</>;
  const on = new Set(hits);
  const out: React.ReactNode[] = [];
  let buf = '';
  let marking = false;
  const flush = (at: number) => {
    if (!buf) return;
    out.push(marking ? <mark key={at}>{buf}</mark> : <span key={at}>{buf}</span>);
    buf = '';
  };
  for (let i = 0; i < text.length; i++) {
    const m = on.has(i);
    if (m !== marking) { flush(i); marking = m; }
    buf += text[i];
  }
  flush(text.length);
  return <>{out}</>;
}

/**
 * A description hit deep in a long paragraph would be clipped away by the line
 * clamp, hiding the very characters that explain the result. So a matched
 * description is windowed around its hit instead of clamped.
 */
function Description({ text, hits }: { text: string; hits: number[] | null }) {
  if (!hits || hits.length === 0) return <span className="skill-desc clamp">{text}</span>;
  if (text.length <= 220) return <span className="skill-desc"><Marked text={text} hits={hits} /></span>;

  const start = Math.max(0, hits[0] - 60);
  const end = Math.min(text.length, Math.max(hits[hits.length - 1] + 1, start + 170) + 50);
  const slice = text.slice(start, end);
  const shifted = hits.map((h) => h - start).filter((h) => h >= 0 && h < slice.length);
  return (
    <span className="skill-desc">
      {start > 0 && <span className="faint">… </span>}
      <Marked text={slice} hits={shifted} />
      {end < text.length && <span className="faint"> …</span>}
    </span>
  );
}

function SkillEntry({ hit, selected, onRead }: { hit: Hit; selected: boolean; onRead: () => void }) {
  const skill = hit.skill, source = SRC[skill.source];
  return <button type="button" className="skills-entry" aria-current={selected ? 'true' : undefined} data-skill-path={skill.path} onClick={onRead}>
    <span className="skills-origin"><span aria-hidden="true" style={{color:source.color}}>{source.glyph}</span>{source.word}{skill.plugin ? ` · ${skill.plugin}` : ''}</span>
    <strong><Marked text={skill.name} hits={hit.nameHits} /></strong>
    <Description text={skill.description} hits={hit.descHits} />
    <span className="skills-entry-meta"><code>{skill.invoke}</code><span>{skill.extras} helper {skill.extras === 1 ? 'file' : 'files'}</span></span>
  </button>;
}

/**
 * Where the catalogue came from, including the part that is honestly
 * incomplete. Hiding the built-in caveat would make a partial list look total.
 */
function Roots({ cat }: { cat: Catalogue }) {
  const total = cat.skills.length;
  let x = 0;
  const W = 100;

  return (
    <div className="skills-sources"><Section title="Where these came from"
             hint="A project skill shadows a user skill of the same name, which shadows a plugin's — only the file that actually runs is listed here.">
      {total > 0 && (
        <>
          <svg className="chart-svg" viewBox={`0 0 ${W} 14`} role="img"
               aria-label={SOURCES.map((s) => `${s.word} ${cat.counts[s.id]}`).join(', ')}>
            {SOURCES.map((s) => {
              const w = (cat.counts[s.id] / total) * W;
              const seg = (
                <rect key={s.id} x={x} y="0" width={Math.max(0, w - 0.5)} height="10" rx="2" fill={s.color}>
                  <title>{`${s.word}: ${cat.counts[s.id]} of ${total} skills`}</title>
                </rect>
              );
              x += w;
              return seg;
            })}
          </svg>
          <div className="legend">
            {SOURCES.map((s) => (
              <span key={s.id} className="legend-item">
                <span className="legend-swatch" style={{ background: s.color }} />
                <span aria-hidden="true" style={{ color: s.color }}>{s.glyph}</span>
                {s.word}
                <span className="mono" style={{ color: 'var(--text-faint)', fontVariantNumeric: 'tabular-nums' }}>
                  {num(cat.counts[s.id])}
                </span>
              </span>
            ))}
          </div>
        </>
      )}

      <div className="skills-roots-wrap">
        <table className="viz-table skills-roots">
          <thead>
            <tr>
              <th>Source</th>
              <th style={{ textAlign: 'right' }}>Skills</th>
              <th>Directory</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {cat.roots.map((r) => {
              const s = SRC[r.source];
              return (
                <tr key={r.source}>
                  <td>
                    <span aria-hidden="true" style={{ color: s.color, marginRight: 7 }}>{s.glyph}</span>
                    {s.word}
                  </td>
                  <td className="n">{num(cat.counts[r.source])}</td>
                  <td className="path mono">
                    <span className="skills-root-path" title={r.path}>{r.path}</span>
                  </td>
                  <td style={{ color: r.exists ? 'var(--good)' : 'var(--text-faint)' }}>
                    {r.exists ? '✓ found' : '○ not present'}
                  </td>
                  <td>
                    {r.exists && r.path !== '—' && (
                      <button className="link" style={{ fontSize: 'var(--t-micro)' }}
                              onClick={() => { window.wanigan.browse.reveal(r.path).catch(() => {}); }}>
                        reveal
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {cat.roots.filter((r) => r.note).map((r) => (
        <div key={r.source} style={{ marginTop: 9 }}>
          <Note tone={r.source === 'builtin' ? 'warn' : 'info'}>
            <strong>{r.source === 'builtin' ? '⚠' : 'ℹ'} {SRC[r.source].word}:</strong> {r.note}
          </Note>
        </div>
      ))}

      {/* A skill is one of several things a repository puts in front of an
          agent, and this view only knows about skills. The surface that reads
          the rest of them is a keyboard chord away and almost nobody finds it,
          so it is named here where its subject is being discussed. */}
      <p className="faint" style={{ fontSize: 'var(--t-small)', lineHeight: 1.55, marginTop: 11 }}>
        The rest of what a session in these repositories is told before you type anything — the CLAUDE.md
        chain, memory, rules, settings and hooks, and what carrying them costs per session — is the Context
        view: <span className="mono">⌘⇧C</span>, or ⌘K → Context.
      </p>
    </Section></div>
  );
}

function Reader({ skill, scanAt, canSend, sending, onSend, onCopy }: {
  skill: SkillInfo; scanAt: number; canSend: boolean; sending: boolean; onSend: () => void; onCopy: () => void;
}) {
  const [body, setBody] = useState<{text:string; truncated:boolean; bytes:number} | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [area, setArea] = useViewMemory<'document' | 'details'>('reader-area', 'document');
  const [revealErr, setRevealErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true; setBody(null); setErr(null);
    window.wanigan.skills.body(skill.path).then(next => { if (live) setBody(next); }).catch(error => { if (live) setErr(msg(error)); });
    return () => { live = false; };
  }, [skill.path, scanAt, retry]);
  const source = SRC[skill.source];
  return <aside className="skills-reader" aria-label={`${skill.name} SKILL.md`}>
    <div className="skills-reader-intro">
      <SectionHead label="Selected workflow" right={<Mark glyph={source.glyph} word={source.word} tone="quiet" />} />
      <h2>{skill.name}</h2><p>{skill.description}</p>
      <div className="skills-invocation"><code>{skill.invoke}</code><button className="btn btn-sm" onClick={onCopy}>Copy invocation</button>{canSend && <button className="btn btn-primary btn-sm" disabled={sending} onClick={onSend}>{sending ? 'Typing…' : 'Type into session'}</button>}</div>
      <Hint>{canSend ? 'Types into the selected session without pressing Enter. Review it there before running.' : 'Copy the invocation to use it in a session. Reading and copying work here at any time.'}</Hint>
    </div>
    <Segmented label="Skill reader section" value={area} onChange={setArea} options={[{value:'document',label:'SKILL.md'},{value:'details',label:'Details'}]} />
    <div className="skills-reader-content" key={area}>
      {area === 'document' ? err ? <EmptyState posture="could-not-read" title="This skill could not be read" cue={err} action={<button className="btn" onClick={() => setRetry(n => n + 1)}>Retry reading</button>} /> : !body ? <Reading what="SKILL.md" /> : <>
        {body.truncated && <Note tone="warn">Showing the first 200 KB of a {fileSize(body.bytes)} file. Reveal its folder to read the rest.</Note>}
        <pre className="skills-md">{body.text}</pre>
      </> : <div className="skills-details">
        <SectionHead label="On disk" />
        <dl><div><dt>Source</dt><dd>{source.word} · {source.blurb}</dd></div><div><dt>File</dt><dd><code>{skill.path}</code></dd></div><div><dt>Size</dt><dd>{fileSize(skill.bytes)}</dd></div><div><dt>Modified</dt><dd>{ago(skill.modified)}</dd></div><div><dt>Helper files</dt><dd>{skill.extras}</dd></div>{skill.plugin && <div><dt>Plugin</dt><dd>{skill.plugin}{skill.marketplace ? ` · ${skill.marketplace}` : ''}</dd></div>}</dl>
        {skill.allowedTools.length > 0 && <><SectionHead label="Declared tools" /><div className="skills-tools">{skill.allowedTools.map(tool => <code key={tool}>{tool}</code>)}</div></>}
        {source.id === 'builtin' && <Note tone="info">This is an extracted built-in observed on disk. The catalogue does not list every skill bundled with Claude Code.</Note>}
      </div>}
    </div>
    <div className="skills-reader-footer"><Hint>Read from disk · {fileSize(body?.bytes ?? skill.bytes)}</Hint><button className="link" onClick={() => { setRevealErr(null); void window.wanigan.browse.reveal(skill.dir).catch(error => setRevealErr(msg(error))); }}>Reveal folder</button></div>
    {revealErr && <Note tone="error">Could not reveal the folder: {revealErr}</Note>}
  </aside>;
}
