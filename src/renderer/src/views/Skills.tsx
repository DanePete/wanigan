import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Project } from '@shared/types';
import { Note, Section, Stat, ago, num } from '../components/bits';

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
  { id: 'project', word: 'project',  glyph: '■', color: 'var(--series-2)', blurb: 'checked into the repo' },
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

const listWords = (xs: string[]) =>
  xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;

/** "user or plugin" — a negative sentence needs "or", not "and", to stay true. */
const orWords = (xs: string[]) =>
  xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} or ${xs[xs.length - 1]}`;

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/* ── view ────────────────────────────────────────────────────────────── */

export default function Skills({ projectId, activeSessionId }: {
  projectId?: string; activeSessionId?: string | null;
}) {
  const [cat, setCat] = useState<Catalogue | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);

  /* Which repository's `.claude/skills` this catalogue includes.
     `projectId` is the app's derived project, and its only setters are opening
     a session, adding a project and Learning's scope picker — so pointing this
     view at another repository used to mean going to Learning, changing the
     scope there, and coming back. `pinned` is this view's own answer and wins
     once it is set: a choice made here must not be undone by a session
     starting somewhere else. `projects` is read over IPC rather than taken as
     a prop, because the shell does not pass one to this view.

     `null` means "follow whatever the app is pointed at" — an absence of a
     choice, which is not the same statement as the empty string, which is
     someone deliberately asking for no project skills at all. */
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [projectsErr, setProjectsErr] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    window.wanigan.projects.list()
      .then((list) => { if (live) { setProjects(list); setProjectsErr(null); } })
      .catch((e) => { if (live) { setProjects(null); setProjectsErr(msg(e)); } });
    return () => { live = false; };
  }, []);

  // A pin whose project has been removed is not a scope, it is a dangling id,
  // so it falls back to following rather than silently scanning nothing.
  const pinnedLive = pinned !== null
    && (pinned === '' || projects === null || projects.some((p) => p.id === pinned));
  const scopeId = pinnedLive ? (pinned || undefined) : projectId;
  const scope = projects?.find((p) => p.id === scopeId) ?? null;

  const [q, setQ] = useState('');
  const [sources, setSources] = useState<Set<SkillSource>>(new Set());
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [selected, setSelected] = useState<SkillInfo | null>(null);
  const [flash, setFlash] = useState<{ name: string; tone: 'ok' | 'error'; text: string } | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const popRef = useRef<HTMLUListElement>(null);
  const optRefs = useRef<(HTMLLIElement | null)[]>([]);

  const load = useCallback(async (rescan?: boolean) => {
    setScanning(true);
    try {
      if (rescan) await window.wanigan.skills.refresh();
      setCat((await window.wanigan.skills.list(scopeId)) as Catalogue);
      setLoadErr(null);
    } catch (e) {
      setLoadErr(msg(e));
    } finally {
      setScanning(false);
    }
  }, [scopeId]);

  useEffect(() => { void load(); }, [load]);

  // A confirmation that never leaves is a badge, not a confirmation.
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 6000);
    return () => clearTimeout(t);
  }, [flash]);

  const query = q.trim().toLowerCase();

  /** Everything the search kept, before the source chips get a say. */
  const matched = useMemo<Hit[]>(() => {
    if (!cat) return [];
    if (!query) {
      return cat.skills.map((skill) => ({ skill, tier: TIER.unfiltered, score: 0, nameHits: null, descHits: null }));
    }
    const hits: Hit[] = [];
    for (const skill of cat.skills) {
      const m = match(skill, query);
      if (m) hits.push(m);
    }
    hits.sort((a, b) => a.tier - b.tier || b.score - a.score || a.skill.name.localeCompare(b.skill.name));
    return hits;
  }, [cat, query]);

  /**
   * Facet counts are computed against the search but NOT against the source
   * chips, so each chip answers "how many would I add?" rather than "how many
   * are showing?" — the count a user is actually asking for.
   */
  const facets = useMemo(() => {
    const c: Record<SkillSource, number> = { user: 0, project: 0, plugin: 0, builtin: 0 };
    for (const h of matched) c[h.skill.source]++;
    return c;
  }, [matched]);

  const visible = useMemo(
    () => (sources.size === 0 ? matched : matched.filter((h) => sources.has(h.skill.source))),
    [matched, sources],
  );

  // The typeahead offers what the page below is already showing — a suggestion
  // the source chips have excluded would be a promise the list cannot keep.
  const suggestions = useMemo(
    () => (query ? visible.slice(0, MAX_SUGGESTIONS) : []),
    [visible, query],
  );

  // aria-activedescendant moves the VIRTUAL cursor; the browser scrolls nothing
  // for it. Without this the active option walks off the bottom of the popup —
  // and at 150% browser zoom it walks off after the second item.
  useEffect(() => {
    if (!open || active < 0) return;
    const list = popRef.current;
    const el = optRefs.current[active];
    if (!list || !el) return;
    const top = el.offsetTop;
    const bottom = top + el.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
  }, [active, open, suggestions.length]);

  useEffect(() => { if (active >= suggestions.length) setActive(suggestions.length - 1); }, [suggestions.length, active]);

  function choose(h: Hit) {
    setSelected(h.skill);
    setQ(h.skill.name);
    setOpen(false);
    setActive(-1);
    inputRef.current?.focus();
  }

  /** W3C APG combobox: arrows move, Enter selects, Escape closes then clears — and DOM focus never leaves the input. */
  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    const n = suggestions.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!n) return;
      e.preventDefault();
      if (!open) { setOpen(true); setActive(e.key === 'ArrowDown' ? 0 : n - 1); return; }
      setActive((i) => (e.key === 'ArrowDown' ? (i + 1) % n : (i <= 0 ? n - 1 : i - 1)));
      return;
    }
    if (e.key === 'Home' && open && n) { e.preventDefault(); setActive(0); return; }
    if (e.key === 'End' && open && n) { e.preventDefault(); setActive(n - 1); return; }
    if (e.key === 'Enter') {
      if (open && active >= 0 && suggestions[active]) { e.preventDefault(); choose(suggestions[active]); }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      if (open) { setOpen(false); setActive(-1); }
      else if (q) setQ('');
      return;
    }
    if (e.key === 'Tab' && open) { setOpen(false); setActive(-1); }
  }

  async function send(s: SkillInfo) {
    if (!activeSessionId) return;
    try {
      await window.wanigan.skills.send(activeSessionId, s.invoke);
      setFlash({ name: s.name, tone: 'ok',
                 text: `✓ Typed ${s.invoke} into the live session. It is not submitted — switch to Sessions and press Enter to run it.` });
    } catch (e) {
      setFlash({ name: s.name, tone: 'error',
                 text: `✕ Could not type into that session: ${msg(e)}. It has probably exited — open a session in Sessions, then send again.` });
    }
  }

  async function copy(s: SkillInfo) {
    try {
      await navigator.clipboard.writeText(s.invoke);
      setFlash({ name: s.name, tone: 'ok', text: `✓ Copied ${s.invoke} to the clipboard.` });
    } catch (e) {
      setFlash({ name: s.name, tone: 'error',
                 text: `✕ The clipboard refused the write (${msg(e)}). Select ${s.invoke} above and copy it by hand.` });
    }
  }

  /* ── states ────────────────────────────────────────────────────────── */

  if (loadErr) {
    return (
      <div className="skills-view">
        <div className="pane">
          <div className="pane-head"><div><h1>Skills</h1></div></div>
          <div className="card skills-state">
            <h2>The skill scan did not finish</h2>
            <p>
              Wanigan could not read the skill directories: <span className="mono">{loadErr}</span>.
              The catalogue is read straight off disk, so this is usually a permissions problem on
              <span className="mono"> ~/.claude/skills</span>. Fix that, then scan again.
            </p>
            <button className="btn btn-primary" onClick={() => void load(true)}>Scan again</button>
          </div>
        </div>
      </div>
    );
  }

  if (!cat) {
    return (
      <div className="skills-view">
        <div className="pane">
          <div className="pane-head"><div><h1>Skills</h1></div></div>
          <div className="card skills-state">
            <h2>Scanning for skills…</h2>
            <p>Reading SKILL.md frontmatter from your skills folder, this project, and every installed plugin.</p>
          </div>
        </div>
      </div>
    );
  }

  const total = cat.skills.length;
  const searching = query.length > 0;
  const chosen = SOURCES.filter((s) => sources.has(s.id));
  const filtered = sources.size > 0;
  const cutByQuery = total - matched.length;
  const cutBySource = matched.length - visible.length;
  const sourcesPresent = SOURCES.filter((s) => cat.counts[s.id] > 0);
  const helperFiles = cat.skills.reduce((a, s) => a + s.extras, 0);

  return (
    <div className={`skills-view${selected ? ' reading' : ''}`}>
      <div className="pane">
        <div className="pane-head">
          <div>
            <h1>Skills</h1>
            <p className="dim">
              Every skill this machine can run — searchable, and firable straight into a live agent.
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            {/* This view's own scope control. Only the project source depends on
                it — user, plugin and built-in skills are the same whichever
                repository is picked — so the label says what it changes rather
                than implying the whole catalogue swaps. */}
            {projects && projects.length > 0 && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span className="label">Project skills from</span>
                <select className="field" style={{ width: 'auto' }} value={scopeId ?? ''}
                        aria-label="Which repository's project skills to include"
                        onChange={(ev) => setPinned(ev.target.value)}>
                  <option value="">No repository</option>
                  {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </label>
            )}
            <span className="faint" style={{ fontSize: 'var(--t-small)', fontVariantNumeric: 'tabular-nums' }}>
              scanned {ago(cat.scannedAt)}
            </span>
            <button className="btn" onClick={() => void load(true)} disabled={scanning}>
              {scanning ? 'Scanning…' : 'Rescan disk'}
            </button>
          </div>
        </div>

        {/* The project list has three answers and they are not one: not read
            yet (no picker, and nothing claimed about repositories), read and
            empty (there are none to pick), and read but failed (the picker is
            missing for a reason, and the reason is said out loud). */}
        {projectsErr && (
          <Note tone="warn">
            <strong>⚠ The project list could not be read</strong> ({projectsErr}), so this view cannot offer a
            repository picker. Project skills are still scanned for{' '}
            {projectId ? 'whichever repository the app is pointed at' : 'nothing — no project is selected'}.
          </Note>
        )}
        {projects !== null && projects.length === 0 && (
          <Note tone="info">
            No repositories registered, so nothing under a{' '}
            <span className="mono">.claude/skills</span> directory in a repo is in this catalogue. Add a folder
            in Sessions and it becomes pickable here.
          </Note>
        )}
        {pinnedLive && projectId && pinned !== projectId && (
          <p className="faint" style={{ fontSize: 'var(--t-small)', lineHeight: 1.5 }}>
            {pinned === ''
              ? <>Project skills are excluded here by choice. </>
              : <>Pinned to <strong>{scope?.name ?? pinned}</strong> on this view. </>}
            The rest of Wanigan is still pointed at another project, and this pick does not move it.{' '}
            <button className="link" onClick={() => setPinned(null)}>Follow the app's project instead</button>
          </p>
        )}

        <div className="stat-grid">
          <Stat label="Skills catalogued" value={num(total)}
                sub={`${total === 1 ? 'skill' : 'skills'}, after name shadowing`} />
          <Stat label="Sources with skills" value={`${sourcesPresent.length} of 4`}
                sub={sourcesPresent.length ? listWords(sourcesPresent.map((s) => s.word)) : 'nothing found yet'} />
          <Stat label="Helper files" value={num(helperFiles)}
                sub={`${helperFiles === 1 ? 'file' : 'files'} shipped alongside the SKILL.md`} />
          <Stat label="Send target"
                value={activeSessionId ? '◉ ready' : '○ none'}
                tone={activeSessionId ? 'var(--good)' : 'var(--text-faint)'}
                sub={activeSessionId ? 'one live session is selected' : 'no live session selected'} />
        </div>

        {!activeSessionId && (
          <Note tone="info">
            <strong>○ No live session, so sending is off.</strong> Wanigan types an invocation
            straight into a running agent's terminal, so there has to be a terminal — open one in
            Sessions and come back. Search, reading and copying all work without one.
          </Note>
        )}

        {/* A search box over an empty catalogue is furniture, so it only
            appears once there is something to search. */}
        {total > 0 && (
          <Section title="Find a skill"
                   hint="Names rank first: prefix, then substring, then letters in order (vbc finds verification-before-completion). Descriptions rank last. Matched characters are marked so you can see why a result placed where it did.">
            <div className="skills-search-wrap">
              <span className="skills-search-glyph" aria-hidden="true">⌕</span>
              <input
                ref={inputRef}
                className="field skills-search"
                type="text"
                role="combobox"
                aria-expanded={open && suggestions.length > 0}
                aria-controls="skills-typeahead"
                aria-autocomplete="list"
                aria-activedescendant={open && active >= 0 ? OPT_ID(active) : undefined}
                aria-label="Search skills by name or description"
                autoComplete="off"
                spellCheck={false}
                placeholder="Search skills — try “vbc”"
                value={q}
                onChange={(e) => { setQ(e.target.value); setOpen(true); setActive(-1); }}
                onKeyDown={onKey}
                onFocus={() => { if (q) setOpen(true); }}
                onBlur={() => { setOpen(false); setActive(-1); }}
              />
              {q && (
                <button className="skills-search-clear" onClick={() => { setQ(''); setOpen(false); setActive(-1); inputRef.current?.focus(); }}>
                  clear ⎋
                </button>
              )}
              <ul
                id="skills-typeahead"
                className="skills-pop"
                role="listbox"
                aria-label="Skill matches"
                ref={popRef}
                hidden={!open || suggestions.length === 0}
              >
                {suggestions.map((h, i) => (
                  <li
                    key={h.skill.path}
                    id={OPT_ID(i)}
                    role="option"
                    aria-selected={i === active}
                    className={`skills-opt${i === active ? ' on' : ''}`}
                    ref={(el) => { optRefs.current[i] = el; }}
                    // Focus must stay in the input for aria-activedescendant to
                    // mean anything, so the mousedown never gets to move it.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => choose(h)}
                  >
                    <span aria-hidden="true" style={{ color: SRC[h.skill.source].color, fontSize: 'var(--t-micro)' }}>
                      {SRC[h.skill.source].glyph}
                    </span>
                    <span className="skills-opt-name mono">
                      <Marked text={h.skill.name} hits={h.nameHits} />
                    </span>
                    <span className="skills-opt-why">{TIER_WORD[h.tier]} · {SRC[h.skill.source].word}</span>
                  </li>
                ))}
              </ul>
            </div>
            <p className="skills-sr" role="status">
              {open && suggestions.length ? `${suggestions.length} suggestions, use arrow keys` : ''}
            </p>

            <div className="skills-chips" style={{ marginTop: 11 }}>
              {SOURCES.map((s) => {
                const n = facets[s.id];
                const on = sources.has(s.id);
                return (
                  <button
                    key={s.id}
                    className={`skills-chip${on ? ' on' : ''}`}
                    aria-pressed={on}
                    disabled={n === 0 && !on}
                    title={n === 0
                      ? `No ${s.word} skills in the current search, so this filter would empty the list.`
                      : `${on ? 'Stop showing' : 'Show'} the ${n} ${s.word} ${n === 1 ? 'skill' : 'skills'} — ${s.blurb}.`}
                    onClick={() => setSources((prev) => {
                      const next = new Set(prev);
                      if (next.has(s.id)) next.delete(s.id); else next.add(s.id);
                      return next;
                    })}
                  >
                    <span aria-hidden="true" style={{ color: s.color, fontSize: 'var(--t-micro)' }}>{s.glyph}</span>
                    {s.word}
                    <span className="n">{num(n)}</span>
                  </button>
                );
              })}
              <button className="skills-chip-clear" disabled={!filtered && !q}
                      onClick={() => { setSources(new Set()); setQ(''); setOpen(false); setActive(-1); }}>
                Clear all
              </button>
            </div>

            <p className="skills-count" aria-live="polite" style={{ marginTop: 10 }}>
              {!searching && !filtered && <>All <strong>{num(total)}</strong> skills. Nothing is filtered out.</>}
              {searching && !filtered && (
                <>Showing <strong>{num(visible.length)}</strong> of <strong>{num(total)}</strong> skills:
                  {' '}the search for “{q.trim()}” excluded <strong>{num(cutByQuery)}</strong>.</>
              )}
              {!searching && filtered && (
                <>Showing <strong>{num(visible.length)}</strong> of <strong>{num(total)}</strong> skills:
                  {' '}keeping only {listWords(chosen.map((s) => s.word))} hid <strong>{num(cutBySource)}</strong>.</>
              )}
              {searching && filtered && (
                <>Showing <strong>{num(visible.length)}</strong> of <strong>{num(total)}</strong> skills:
                  {' '}“{q.trim()}” matched <strong>{num(matched.length)}</strong>, then keeping only
                  {' '}{listWords(chosen.map((s) => s.word))} removed <strong>{num(cutBySource)}</strong> of those.</>
              )}
            </p>
          </Section>
        )}

        {total === 0 ? (
          <div className="card skills-state">
            <h2>No skills on this machine yet</h2>
            <p>
              Nothing exists to catalogue — not in your skills folder, this project, or any plugin.
              Start one by creating <span className="mono">~/.claude/skills/&lt;name&gt;/SKILL.md</span> with
              a <span className="mono">name</span> and <span className="mono">description</span> in its
              frontmatter; it shows up here on the next scan. Skills committed under a project's
              <span className="mono"> .claude/skills</span> travel with the repo.
            </p>
            <button className="btn" onClick={() => void load(true)}>Scan again</button>
          </div>
        ) : visible.length === 0 ? (
          <div className="card skills-state">
            {matched.length === 0 ? (
              <>
                <h2>Nothing matches “{q.trim()}”</h2>
                <p>
                  All <strong>{num(total)}</strong> skills were excluded by the search: no name
                  contains those letters in order, and no description contains that text.
                </p>
                <button className="btn btn-primary" onClick={() => { setQ(''); setOpen(false); setActive(-1); inputRef.current?.focus(); }}>
                  Clear the search and show all {num(total)}
                </button>
              </>
            ) : (
              <>
                <h2>Your source filter excluded every match</h2>
                <p>
                  {!searching ? (
                    <>No skill comes from {orWords(chosen.map((s) => s.word))}.</>
                  ) : matched.length === 1 ? (
                    <>“{q.trim()}” matched one skill and it is
                      a <strong>{SRC[matched[0].skill.source].word}</strong> skill, while the filter
                      keeps only {orWords(chosen.map((s) => s.word))}.</>
                  ) : (
                    <>“{q.trim()}” matched <strong>{num(matched.length)}</strong> skills, and none of
                      them are {orWords(chosen.map((s) => s.word))} skills.</>
                  )}
                </p>
                <button className="btn btn-primary" onClick={() => setSources(new Set())}>
                  Show all sources again
                </button>
              </>
            )}
          </div>
        ) : (
          <div className="skills-list">
            {visible.map((h) => (
              <SkillCard
                key={h.skill.path}
                hit={h}
                selected={selected?.path === h.skill.path}
                canSend={Boolean(activeSessionId)}
                flash={flash && flash.name === h.skill.name ? flash : null}
                onRead={() => setSelected((prev) => (prev?.path === h.skill.path ? null : h.skill))}
                onSend={() => void send(h.skill)}
                onCopy={() => void copy(h.skill)}
              />
            ))}
          </div>
        )}

        <Roots cat={cat} />
      </div>

      {selected && <Reader skill={selected} onClose={() => setSelected(null)} />}
    </div>
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
  if (!hits || hits.length === 0) return <p className="skill-desc clamp">{text}</p>;
  if (text.length <= 220) return <p className="skill-desc"><Marked text={text} hits={hits} /></p>;

  const start = Math.max(0, hits[0] - 60);
  const end = Math.min(text.length, Math.max(hits[hits.length - 1] + 1, start + 170) + 50);
  const slice = text.slice(start, end);
  const shifted = hits.map((h) => h - start).filter((h) => h >= 0 && h < slice.length);
  return (
    <p className="skill-desc">
      {start > 0 && <span className="faint">… </span>}
      <Marked text={slice} hits={shifted} />
      {end < text.length && <span className="faint"> …</span>}
    </p>
  );
}

function SkillCard({ hit, selected, canSend, flash, onRead, onSend, onCopy }: {
  hit: Hit; selected: boolean; canSend: boolean;
  flash: { tone: 'ok' | 'error'; text: string } | null;
  onRead: () => void; onSend: () => void; onCopy: () => void;
}) {
  const s = hit.skill;
  const src = SRC[s.source];
  return (
    <article className={`skill-card${selected ? ' sel' : ''}`} style={{ borderLeftColor: src.color }}>
      <div className="skill-head">
        <button className="skill-name mono" onClick={onRead}
                title={selected ? 'Close the reading pane' : `Read ${s.name}/SKILL.md`}>
          <Marked text={s.name} hits={hit.nameHits} />
        </button>
        <span className="skill-src" style={{ color: src.color }}>
          <span aria-hidden="true">{src.glyph}</span>{src.word}
        </span>
        <span className="skill-invoke mono" style={{ marginLeft: 'auto' }}>{s.invoke}</span>
      </div>

      <Description text={s.description} hits={hit.descHits} />

      <div className="skill-meta">
        <span>{src.blurb}</span>
        {s.plugin && <span>plugin {s.plugin}{s.marketplace ? ` · ${s.marketplace}` : ''}</span>}
        <span>{num(s.extras)} helper {s.extras === 1 ? 'file' : 'files'}</span>
        <span>{fileSize(s.bytes)}</span>
        <span>edited {ago(s.modified)}</span>
      </div>

      {s.allowedTools.length > 0 && (
        <div className="skill-tools">
          <span className="faint" style={{ fontSize: 'var(--t-micro)' }}>allowed tools:</span>
          {s.allowedTools.map((t) => <span key={t} className="skill-tool mono">{t}</span>)}
        </div>
      )}

      <div className="skill-actions">
        <button
          className="btn btn-primary skills-btn-sm"
          disabled={!canSend}
          title={canSend
            ? `Type ${s.invoke} into the selected live session`
            : 'There is no live session to type into — open one in Sessions first'}
          onClick={onSend}
        >
          {canSend ? 'Send to session' : 'Send needs a live session'}
        </button>
        <button className="btn skills-btn-sm" onClick={onCopy} title={`Copy ${s.invoke} to the clipboard`}>
          Copy <span className="mono">{s.invoke}</span>
        </button>
        <button className="btn skills-btn-sm" onClick={onRead}>
          {selected ? 'Close SKILL.md' : 'Read SKILL.md'}
        </button>
      </div>

      {flash && <Note tone={flash.tone === 'ok' ? 'ok' : 'error'}>{flash.text}</Note>}
    </article>
  );
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
    <Section title="Where these came from"
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
    </Section>
  );
}

function Reader({ skill, onClose }: { skill: SkillInfo; onClose: () => void }) {
  const [body, setBody] = useState<{ text: string; truncated: boolean; bytes: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setBody(null);
    setErr(null);
    window.wanigan.skills.body(skill.path)
      .then((b) => { if (live) setBody(b); })
      .catch((e) => { if (live) setErr(msg(e)); });
    return () => { live = false; };
  }, [skill.path]);

  const src = SRC[skill.source];

  return (
    <aside className="skills-reader" aria-label={`${skill.name} SKILL.md`}>
      <div className="skills-reader-head">
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span className="mono" style={{ fontSize: 'var(--t-body)', fontWeight: 600 }}>{skill.name}</span>
          <span className="skill-src" style={{ color: src.color }}>
            <span aria-hidden="true">{src.glyph}</span>{src.word}
          </span>
          <button className="faint" style={{ marginLeft: 'auto', fontSize: 'var(--t-lead)', lineHeight: 1 }}
                  title="Close the reading pane" onClick={onClose}>×</button>
        </div>
        <div className="skills-path mono" title={skill.path}>{skill.path}</div>
        <div className="skill-meta">
          <span className="mono">{skill.invoke}</span>
          <span>{fileSize(skill.bytes)}</span>
          <span>edited {ago(skill.modified)}</span>
          <button className="link" style={{ fontSize: 'var(--t-micro)' }}
                  onClick={() => { window.wanigan.browse.reveal(skill.dir).catch(() => {}); }}>
            reveal folder
          </button>
        </div>
      </div>

      <div className="skills-reader-body">
        {err ? (
          <Note tone="error">
            ✕ Could not read this SKILL.md: {err}. The file may have been moved or deleted since the
            last scan — press “Rescan disk” to rebuild the catalogue.
          </Note>
        ) : !body ? (
          <p className="dim" style={{ fontSize: 'var(--t-small)' }}>Reading {skill.name}/SKILL.md…</p>
        ) : (
          <>
            {body.truncated && (
              <div style={{ marginBottom: 10 }}>
                <Note tone="warn">
                  ⚠ Showing the first 200 KB of a {fileSize(body.bytes)} file. Open the folder to read the rest.
                </Note>
              </div>
            )}
            <div className="skills-md">{body.text}</div>
          </>
        )}
      </div>
    </aside>
  );
}
