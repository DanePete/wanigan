// The site's component library, in the live view's side panel: what its core
// says it can place, each pictured alone at a phone's and a desktop's width,
// and from there added to the page shown. Design:
// docs/design/2026-10-09-design-layer.md, "The component library".
//
// - The list is the helper's (LiveBridge.library), grouped by kind with each
//   kind's count, and searched by every word typed. Pictures are asked for
//   only for the entries in view, a few at a time (at most PICTURES_AT_ONCE),
//   and kept by the library's hash in Wanigan's data folder.
// - An entry's details: its pictures, where it comes from, its props and
//   slots from its schema, its files (opened in the Code tab when they are in
//   the project's folder), why it has no picture when it has none, where the
//   rest of the site uses it (LiveBridge.libraryUsage: the helper's search of
//   stored data, each place opening in the view where a page shows it, with
//   what the search cannot see), and where the page shown uses it.
// - Adding one goes through the trace's palette and Arrange's placing (the
//   page shows where it can go), never a second way: drag it onto the page,
//   Place and click there, or name the place. An entry the page cannot take
//   says why.
// - When there is no library, it says why in the main process's own words,
//   with the one thing to do: update or install the helper, or ask again.
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MutableRefObject, type RefObject } from 'react';
import type { LiveRegion, LiveSite } from '@shared/live';
import type { PartIndex } from '@shared/live-lens';
import {
  PICTURES_AT_ONCE, PICTURE_WIDTHS, usageWhy,
  type ComponentLibrary, type EntryUsage, type LibraryEntry, type LiveLibraryAnswer, type LiveUsageAnswer, type UsagePlace,
} from '@shared/live-library';
import type { LiveTrace, PaletteEntry } from '@shared/live-trace';
import type { ProjectSummary } from '@shared/model';
import { call } from '../../lib/api';
import { liveBridge } from '../../lib/live';
import {
  KIND_TITLE, USAGE_TITLE, libraryGroups, libraryNext, libraryWhyText, ownerWords, placeAddress, placeDetail, placement, propRows, usageGroups, usageSummary, usesOnPage,
  type PageUse, type Placement,
} from '../../lib/live-library';
import { navigate } from '../../lib/router';
import { openInEditor } from '../../editor/EditButton';
import { Icon } from '../icons';
import { Button, CopyButton, Dialog, Disclosure, IconButton } from '../ui';
import { PlaceBy, type useArrange } from './Arrange';
import { HelperDialog } from './Helper';
import '../../styles/live-library.css';

/** Entries pictured in one call: well under PICTURES_AT_ONCE, so the first pictures come back while the rest are taken. */
const BATCH = Math.min(6, PICTURES_AT_ONCE);
/** Widest first: the desktop, then the phone, side by side at the same scale. */
const WIDTHS = [...PICTURE_WIDTHS].sort((a, b) => b - a);
const WIDTH_NAME: Record<number, string> = { 390: 'Phone', 1440: 'Desktop' };
/** A row's small picture is the phone's: at that size a desktop's is a thin strip. */
const THUMB_WIDTH = Math.min(...PICTURE_WIDTHS);

type Shot = { state: 'asking' } | { state: 'ok'; src: string; height: number | null; cut: boolean } | { state: 'none'; why: string };
const shotKey = (entry: string, width: number): string => `${entry}|${width}`;

/** Pictures of the entries asked for, a batch at a time, in the order they came into view (the latest first). */
function usePictures(projectId: string, lib: ComponentLibrary | null): { shots: ReadonlyMap<string, Shot>; want: (ids: string[]) => void } {
  const live = liveBridge();
  const [shots, setShots] = useState<ReadonlyMap<string, Shot>>(new Map());
  const asked = useRef(new Set<string>());
  const queue = useRef<string[]>([]);
  const busy = useRef(false);
  const hash = useRef<string | null>(null);
  const libRef = useRef(lib);
  libRef.current = lib;
  useEffect(() => {
    // A new hash means the definitions or their files changed: every picture is asked for again.
    hash.current = lib?.hash ?? null;
    asked.current = new Set();
    queue.current = [];
    setShots(new Map());
  }, [lib?.hash, projectId]);

  const pump = useCallback(async (): Promise<void> => {
    if (busy.current || !live) return;
    busy.current = true;
    try {
      while (queue.current.length) {
        const at = hash.current;
        const batch = queue.current.splice(0, BATCH);
        const answer = await live.libraryPictures(projectId, batch).catch((e: Error) => ({ ok: false as const, error: e.message || 'The pictures could not be taken.' }));
        if (at !== hash.current) return;
        const next: [string, Shot][] = [];
        if (!answer.ok) {
          for (const id of batch) for (const w of WIDTHS) next.push([shotKey(id, w), { state: 'none', why: answer.error }]);
        } else {
          for (const s of answer.shots) {
            if (!s.path) { next.push([shotKey(s.entry, s.width), { state: 'none', why: s.error ?? 'No picture was kept.' }]); continue; }
            const data = await live.libraryPicture(projectId, s.entry, s.width).catch(() => null);
            next.push([shotKey(s.entry, s.width), data
              ? { state: 'ok', src: `data:image/png;base64,${data}`, height: s.height, cut: s.cut }
              : { state: 'none', why: 'The picture was taken, but it could not be read back.' }]);
          }
        }
        if (at !== hash.current) return;
        setShots((was) => { const m = new Map(was); for (const [k, v] of next) m.set(k, v); return m; });
      }
    } finally { busy.current = false; }
  }, [live, projectId]);

  const want = useCallback((ids: string[]): void => {
    const now = libRef.current;
    if (!now) return;
    const fresh = ids.filter((id) => !asked.current.has(id) && now.entries.find((e) => e.id === id)?.picture.from !== 'none');
    if (!fresh.length) return;
    for (const id of fresh) asked.current.add(id);
    queue.current.unshift(...fresh);
    setShots((was) => { const m = new Map(was); for (const id of fresh) for (const w of WIDTHS) if (!m.has(shotKey(id, w))) m.set(shotKey(id, w), { state: 'asking' }); return m; });
    void pump();
  }, [pump]);
  return { shots, want };
}

export function LibraryPanel({ project, site, trace, parts, regions, arrange, readOnly, focusSearch = true, onClose, onSelect, onHover }: {
  project: ProjectSummary;
  site: LiveSite;
  /** The page shown's trace: what it takes, and what on it is which entry. */
  trace: LiveTrace | null;
  parts: PartIndex;
  regions: LiveRegion[];
  arrange: ReturnType<typeof useArrange>;
  /** A hosted environment is shown: nothing can be added to it. */
  readOnly: boolean;
  /** Opened by its key: the keyboard goes to its search once the list is there (stepping the tabs with [ and ] leaves it where it was). */
  focusSearch?: boolean;
  onClose: () => void;
  /** Choose a part of the page (where it is used): it opens in the panel's Layers. */
  onSelect: (region: LiveRegion) => void;
  onHover: (regions: LiveRegion[] | null, label?: string | null) => void;
}) {
  const live = liveBridge();
  const [answer, setAnswer] = useState<LiveLibraryAnswer | null>(null);
  const [asking, setAsking] = useState(false);
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<string | null>(null);
  const ask = useCallback(async (refresh: boolean): Promise<void> => {
    if (!live) return;
    setAsking(true);
    const a = await live.library(project.id, refresh ? { refresh: true } : undefined).catch((e: Error) => ({ state: 'down' as const, error: e.message || 'no answer' }));
    setAnswer(a);
    setAsking(false);
  }, [live, project.id]);
  useEffect(() => { void ask(false); }, [ask]);
  const lib = answer?.state === 'ok' ? answer.library : null;
  const pictures = usePictures(project.id, lib);
  const entry = lib && chosen ? lib.entries.find((e) => e.id === chosen) ?? null : null;
  // Opened from its tab or its key, the keyboard goes to the search once the list is there; back from an entry, to its row.
  const searchRef = useRef<HTMLInputElement>(null);
  const searchFirst = useRef(focusSearch);
  const back = (): void => {
    const was = chosen;
    setChosen(null);
    window.requestAnimationFrame(() => {
      const row = was ? document.querySelector<HTMLElement>(`.live-library-entry[data-entry="${CSS.escape(was)}"] .live-library-open`) : null;
      (row ?? searchRef.current)?.focus();
    });
  };
  const keys = (e: KeyboardEvent): void => {
    if (e.defaultPrevented || e.key !== 'Escape' || (e.target as Element).closest('input, textarea, select, [role="menu"], .sel-list')) return;
    e.preventDefault();
    if (entry) back(); else onClose();
  };

  return (
    <div className="live-library" onKeyDown={keys}>
      {entry && lib ? (
        <EntryDetail entry={entry} lib={lib} project={project} site={site} trace={trace} parts={parts} regions={regions} arrange={arrange} readOnly={readOnly}
          pictures={pictures} onBack={back} onSelect={onSelect} onHover={onHover} />
      ) : !answer ? (
        <div className="live-skeleton" role="status" aria-label="Asking the site what it can place…">
          {[0, 1, 2, 3].map((i) => <span key={i} className="live-skeleton-row tall" />)}
        </div>
      ) : answer.state !== 'ok' ? <LibraryTrouble answer={answer} site={site} project={project} onRetry={() => ask(true)} />
        : <LibraryList lib={answer.library} query={query} setQuery={setQuery} searchRef={searchRef} searchFirst={searchFirst} trace={trace} readOnly={readOnly}
          arrange={arrange} pictures={pictures} onChoose={setChosen} asking={asking} onAsk={() => ask(true)} />}
    </div>
  );
}

/** Why there is no library, as the main process says it, and the one thing to do here. */
function LibraryTrouble({ answer, site, project, onRetry }: { answer: Exclude<LiveLibraryAnswer, { state: 'ok' }>; site: LiveSite; project: ProjectSummary; onRetry: () => Promise<void> }) {
  const [helper, setHelper] = useState(false);
  const next = libraryNext(answer);
  const canHelp = !!site.helperPlan && !site.helperPlan.refused;
  return (
    <div className="live-trace-note live-library-trouble" role="status">
      <div className="live-trace-note-text">
        <p className="live-trace-note-title">{libraryWhyText(answer)}</p>
        {next === 'update-helper' ? <p className="small faint">Helpers before version 4 have no library: updating it adds the list and the pictures, and changes nothing else in the site.</p> : null}
      </div>
      {next === 'update-helper' && canHelp && site.helper ? <Button size="s" icon="plug" onClick={() => setHelper(true)}>Update the helper…</Button>
        : next === 'install-helper' && canHelp ? <Button size="s" icon="plug" onClick={() => setHelper(true)}>Set up the helper…</Button>
          : next === 'settings' ? <Button size="s" icon="settings" onClick={() => navigate({ name: 'settings', section: 'live' })}>Settings</Button>
            : next === 'retry' ? <Button size="s" icon="refresh" onClick={onRetry}>Ask again</Button> : null}
      {helper ? <HelperDialog site={site} project={project} onClose={() => setHelper(false)} /> : null}
    </div>
  );
}

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one.toLowerCase() : many.toLowerCase()}`;

function LibraryList({ lib, query, setQuery, searchRef, searchFirst, trace, readOnly, arrange, pictures, onChoose, asking, onAsk }: {
  lib: ComponentLibrary; query: string; setQuery: (q: string) => void; searchRef: RefObject<HTMLInputElement | null>; searchFirst: MutableRefObject<boolean>;
  trace: LiveTrace | null; readOnly: boolean; arrange: ReturnType<typeof useArrange>;
  pictures: ReturnType<typeof usePictures>; onChoose: (id: string) => void;
  /** Asking the site again, and its button. */
  asking: boolean; onAsk: () => void;
}) {
  const groups = useMemo(() => libraryGroups(lib, query), [lib, query]);
  useEffect(() => {
    if (!searchFirst.current) return;
    searchFirst.current = false;
    searchRef.current?.focus();
  }, [searchFirst, searchRef]);
  const platform = lib.platform === 'drupal' ? 'Drupal' : 'WordPress';
  const totals = groups.filter((g) => g.total > 0).map((g) => count(g.total, KIND_TITLE[g.kind].one, KIND_TITLE[g.kind].many));
  const matched = groups.reduce((n, g) => n + g.entries.length, 0);
  // Entries come into view: their pictures are asked for, a few at a time.
  const want = useRef(pictures.want);
  want.current = pictures.want;
  const watched = useRef(new Map<Element, string>());
  const observer = useMemo(() => (typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver((seen) => {
    const ids = seen.filter((s) => s.isIntersecting).map((s) => watched.current.get(s.target)).filter((id): id is string => !!id);
    if (ids.length) want.current(ids);
  }, { rootMargin: '120px 0px' })), []);
  useEffect(() => () => observer?.disconnect(), [observer]);
  const watch = useCallback((el: Element, id: string): (() => void) => {
    watched.current.set(el, id);
    observer?.observe(el);
    return () => { observer?.unobserve(el); watched.current.delete(el); };
  }, [observer]);

  return (
    <div className="live-library-list">
      <p className="small">
        What this {platform} site can place, as its core lists it: {totals.length ? totals.join(', ') : 'nothing'}.
        {lib.theme ? <span className="faint"> Pictured in the {lib.theme} theme.</span> : null}
      </p>
      {lib.truncated ? <p className="faint small">The helper listed the first {lib.entries.length}; the site has more. Search narrows what is listed.</p> : null}
      {lib.skipped ? <p className="faint small">Left out: {Object.entries(lib.skipped).map(([why, n]) => `${n} ${why}`).join(', ')}.</p> : null}
      <div className="live-library-find">
        <label className="search-field live-library-search">
          <Icon name="search" size={14} />
          <span className="visually-hidden">Search the library</span>
          <input ref={searchRef} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Name, provider or category" />
        </label>
        <IconButton icon="refresh" size="s" label={asking ? 'Asking the site…' : 'Ask the site again'} disabled={asking} onClick={onAsk} data-loading={asking ? '' : undefined} />
      </div>
      {query.trim() ? <p className="faint small" role="status">{matched === 1 ? '1 entry matches' : `${matched} entries match`}.</p> : null}
      {groups.map((g) => {
        const placed = g.entries.map((e) => placement(e, lib.platform, trace, readOnly));
        // The same reason for every entry of a kind (Drupal places no component alone) is said once, under its heading.
        const shared = placed.length > 1 && placed.every((p) => !p.ok && p.why === (placed[0] as { why: string }).why) ? (placed[0] as { why: string }).why : null;
        return (
          <section key={g.kind} className="live-library-group" aria-label={g.title}>
            <h3 className="live-section-title">{g.title} <span className="live-library-count">{g.total}</span></h3>
            {shared ? <p className="faint small">{shared}</p> : null}
            <ul className="live-library-entries">
              {g.entries.map((e, i) => (
                <EntryRow key={e.id} entry={e} place={placed[i] as Placement} quiet={!!shared} platform={lib.platform}
                  thumb={pictures.shots.get(shotKey(e.id, THUMB_WIDTH)) ?? null} arrange={arrange} watch={watch} onChoose={onChoose} />
              ))}
            </ul>
          </section>
        );
      })}
      {!groups.length ? <p className="faint small">{query.trim() ? 'Nothing in the library matches that.' : 'The site’s core lists nothing it can place.'}</p> : null}
    </div>
  );
}

function EntryRow({ entry, place, quiet, platform, thumb, arrange, watch, onChoose }: {
  entry: LibraryEntry; place: Placement;
  /** Its kind's heading already says why it cannot be placed. */
  quiet: boolean;
  platform: 'drupal' | 'wordpress';
  thumb: Shot | null; arrange: ReturnType<typeof useArrange>;
  watch: (el: Element, id: string) => () => void;
  onChoose: (id: string) => void;
}) {
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => (ref.current ? watch(ref.current, entry.id) : undefined), [watch, entry.id]);
  const placing = place.ok && arrange.placing?.id === place.palette.id;
  const owner = ownerWords(entry.owner, platform);
  // "core · WordPress core" says it twice: the provider is left out when it is core itself.
  const who = [entry.by === 'core' && entry.owner === 'core' ? null : entry.by, owner, entry.status && entry.status !== 'stable' ? entry.status : null].filter(Boolean).join(' · ');
  return (
    <li ref={ref} className="live-library-entry" data-entry={entry.id} draggable={place.ok}
      onDragStart={(e) => { if (!place.ok) return; e.dataTransfer.setData('text/plain', entry.label); e.dataTransfer.effectAllowed = 'copy'; arrange.setPlacing(place.palette); }}>
      <button type="button" className="live-library-open" aria-label={`${entry.label}, ${KIND_TITLE[entry.kind].one.toLowerCase()}: its details`} onClick={() => onChoose(entry.id)}>
        <Thumb entry={entry} shot={thumb} />
        <span className="live-library-what">
          <span className="live-library-name">{entry.label}</span>
          {who ? <span className="faint small">{who}</span> : null}
          {entry.description ? <span className="small live-library-desc">{entry.description}</span> : null}
          {!place.ok && !quiet ? <span className="faint small live-library-cannot">Not placeable here</span> : null}
        </span>
      </button>
      {place.ok ? (
        <Button size="s" tone={placing ? 'primary' : 'plain'} icon="plus" aria-pressed={placing} aria-label={`Place ${entry.label}: click where it goes on the page`}
          onClick={() => arrange.setPlacing(placing ? null : place.palette)}>{placing ? 'Placing…' : 'Place'}</Button>
      ) : null}
    </li>
  );
}

/** A small picture of an entry at a phone's width, or what stands in for it. */
function Thumb({ entry, shot }: { entry: LibraryEntry; shot: Shot | null }) {
  if (entry.picture.from === 'none') return <span className="live-library-thumb none" data-tip={entry.picture.why}><Icon name="pieces" size={16} /></span>;
  if (shot?.state === 'ok') return <span className="live-library-thumb"><img src={shot.src} alt="" /></span>;
  return <span className={`live-library-thumb${shot?.state === 'none' ? ' none' : ' waiting'}`} data-tip={shot?.state === 'none' ? shot.why : 'Being pictured'}><Icon name="pieces" size={16} /></span>;
}

/* ── one entry ─────────────────────────────────────────────────────────── */

function EntryDetail({ entry, lib, project, site, trace, parts, regions, arrange, readOnly, pictures, onBack, onSelect, onHover }: {
  entry: LibraryEntry; lib: ComponentLibrary; project: ProjectSummary; site: LiveSite; trace: LiveTrace | null; parts: PartIndex; regions: LiveRegion[];
  arrange: ReturnType<typeof useArrange>; readOnly: boolean; pictures: ReturnType<typeof usePictures>;
  onBack: () => void; onSelect: (region: LiveRegion) => void; onHover: (regions: LiveRegion[] | null, label?: string | null) => void;
}) {
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => { title.current?.focus(); pictures.want([entry.id]); }, [entry.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const place = placement(entry, lib.platform, trace, readOnly);
  const uses = usesOnPage(entry, lib.platform, trace, regions, parts);
  const props = propRows(entry);
  const owner = ownerWords(entry.owner, lib.platform);
  return (
    <div className="live-library-detail">
      <div className="live-library-detail-head">
        <IconButton icon="back" label="Back to the library" onClick={onBack} />
        <div className="live-library-detail-title">
          <h2 className="live-side-title" tabIndex={-1} ref={title}>{entry.label}</h2>
          <p className="faint small">{KIND_TITLE[entry.kind].one}{entry.by && !(entry.by === 'core' && entry.owner === 'core') ? ` · ${entry.by}` : ''}{owner ? ` · ${owner}` : ''}</p>
        </div>
      </div>

      <Pictures entry={entry} shots={pictures.shots} theme={lib.theme ?? null} />
      {entry.description ? <p className="small">{entry.description}</p> : null}
      <dl className="live-library-facts small">
        <dt>Id</dt>
        <dd className="live-library-id"><span className="mono">{entry.id}</span><CopyButton text={entry.id} label="Copy its id" what="the id" /></dd>
        {entry.category ? <><dt>Category</dt><dd>{entry.category}</dd></> : null}
        {entry.status ? <><dt>Status</dt><dd>{entry.status}</dd></> : null}
        {entry.blocks?.length ? <><dt>{entry.kind === 'block' ? 'Sits inside' : 'For'}</dt><dd className="mono">{entry.blocks.join(', ')}</dd></> : null}
        {entry.needs?.length ? <><dt>Takes from the page</dt><dd className="mono">{entry.needs.join(', ')}</dd></> : null}
      </dl>

      <section className="live-section" aria-label="Add it to this page">
        <h3 className="live-section-title">Add it to this page</h3>
        <AddIt place={place} arrange={arrange} trace={trace} />
      </section>

      <SiteUses entry={entry} project={project} site={site} readOnly={readOnly} />

      <section className="live-section" aria-label="On this page">
        <h3 className="live-section-title">On this page</h3>
        <Uses uses={uses} regions={regions} label={entry.label} onSelect={onSelect} onHover={onHover} />
      </section>

      {props.length ? (
        <section className="live-section" aria-label="Its props">
          <h3 className="live-section-title">{entry.kind === 'block' && lib.platform === 'wordpress' ? 'Attributes' : 'Props'}</h3>
          <ul className="live-library-props small">
            {props.map((p) => (
              <li key={p.name} className="live-library-prop">
                <span className="live-prop">
                  <span className="mono">{p.name}{p.required ? <span className="faint" aria-label="required"> *</span> : null}</span>
                  <span className="lib-tag mono">{p.type}</span>
                  {p.title ? <span className="faint">{p.title}</span> : null}
                </span>
                {p.description ? <span className="faint">{p.description}</span> : null}
                {p.default !== null || p.choices.length ? (
                  <span className="faint">
                    {p.default !== null ? <>Default <span className="mono">{p.default}</span></> : null}
                    {p.default !== null && p.choices.length ? ' · ' : null}
                    {p.choices.length ? <>One of <span className="mono">{p.choices.join(', ')}</span></> : null}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          {props.some((p) => p.required) ? <p className="faint small">* required</p> : null}
        </section>
      ) : null}

      {entry.slots?.length ? (
        <section className="live-section" aria-label="Its slots">
          <h3 className="live-section-title">Slots</h3>
          <ul className="live-library-props small">
            {entry.slots.map((s) => (
              <li key={s.name} className="live-library-prop">
                <span className="live-prop"><span className="mono">{s.name}</span>{s.title ? <span className="faint">{s.title}</span> : null}</span>
                {s.description ? <span className="faint">{s.description}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {entry.files?.length ? (
        <section className="live-section" aria-label="Its files">
          <h3 className="live-section-title">Files</h3>
          <Files files={entry.files} project={project} site={site} />
        </section>
      ) : null}
    </div>
  );
}

/** The entry at a desktop's width and a phone's, side by side at the same scale; or why there is no picture. */
function Pictures({ entry, shots, theme }: { entry: LibraryEntry; shots: ReadonlyMap<string, Shot>; theme: string | null }) {
  const [large, setLarge] = useState<{ width: number; src: string } | null>(null);
  if (entry.picture.from === 'none') {
    return (
      <div className="live-library-nopicture">
        <Icon name="pieces" size={16} />
        <p className="small"><span className="live-made-title">No picture.</span> {entry.picture.why}</p>
      </div>
    );
  }
  const from = entry.picture.from === 'as-written' ? 'as it is written' : entry.picture.from === 'settings' ? 'with its default settings'
    : entry.picture.from === 'example' ? 'with its own example' : entry.picture.from === 'defaults' ? 'with its props’ defaults' : 'with a placeholder for each required prop';
  return (
    <figure className="live-library-pictures">
      <div className="live-library-shots" style={{ gridTemplateColumns: WIDTHS.map((w) => `minmax(0, ${w}fr)`).join(' ') }}>
        {WIDTHS.map((w) => {
          const s = shots.get(shotKey(entry.id, w));
          const name = `${WIDTH_NAME[w] ?? 'At'} ${w} px`;
          return (
            <div key={w} className="live-library-shot">
              {s?.state === 'ok' ? (
                <button type="button" className="live-library-shot-open" aria-label={`${entry.label} at ${w} pixels wide: see it larger`} onClick={() => setLarge({ width: w, src: s.src })}>
                  <img src={s.src} alt={`${entry.label}, rendered alone ${w} pixels wide`} />
                </button>
              ) : s?.state === 'none' ? <p className="faint small live-library-shot-why">{s.why}</p>
                : <p className="faint small live-library-shot-why">Picturing…</p>}
              <span className="faint small">{name}{s?.state === 'ok' && s.cut ? ', cut at the bottom' : ''}</span>
            </div>
          );
        })}
      </div>
      <figcaption className="faint small">Rendered alone by the site {from}{theme ? `, in the ${theme} theme` : ''}.</figcaption>
      {large ? (
        <Dialog title={`${entry.label}, ${large.width} px wide`} onClose={() => setLarge(null)} width={960}>
          <div className="live-library-large"><img src={large.src} alt={`${entry.label}, rendered alone ${large.width} pixels wide`} style={{ width: Math.min(large.width, 900) }} /></div>
        </Dialog>
      ) : null}
    </figure>
  );
}

/** Adding an entry to the page shown: through the trace's palette and Arrange's placing; or why it cannot be. */
function AddIt({ place, arrange, trace }: { place: Placement; arrange: ReturnType<typeof useArrange>; trace: LiveTrace | null }) {
  const [where, setWhere] = useState(false);
  if (!place.ok) return <p className="small live-library-why">{place.why}</p>;
  const palette: PaletteEntry = place.palette;
  const placing = arrange.placing?.id === palette.id;
  const shared = place.into.some((c) => c.changes === 'configuration');
  return (
    <div className="live-library-add">
      <p className="small">Into {place.into.map((c) => c.label).join(', ')}. Drag it onto the page, or Place it and click where it goes.</p>
      {shared ? <p className="faint small">Adding it there changes configuration every page with that place shares: it says so and asks before it saves.</p> : null}
      <div className="live-actions">
        <Button size="s" tone={placing ? 'primary' : 'plain'} icon="plus" aria-pressed={placing} onClick={() => arrange.setPlacing(placing ? null : palette)}>
          {placing ? 'Placing…' : 'Place'}
        </Button>
        <Button size="s" tone="quiet" aria-expanded={where} onClick={() => setWhere((v) => !v)}>Choose where…</Button>
      </div>
      {where ? (
        <PlaceBy entry={palette} into={place.into} labelOf={(id) => trace?.parts.find((x) => x.id === id)?.label ?? id}
          onPlace={(i) => { setWhere(false); void arrange.saveInsert(i); }} />
      ) : null}
    </div>
  );
}

/**
 * Where the rest of the site uses an entry, as the helper's search of what the site has stored says: how many places,
 * each by kind with where in it and what it is reached through, opening in the view where a page shows it (or the
 * site's own page for changing it); what the search could not read; and, always, what no search of stored data sees.
 */
function SiteUses({ entry, project, site, readOnly }: { entry: LibraryEntry; project: ProjectSummary; site: LiveSite; readOnly: boolean }) {
  const live = liveBridge();
  const [answer, setAnswer] = useState<LiveUsageAnswer | null>(null);
  const [asking, setAsking] = useState(false);
  const asked = useRef(0);
  const ask = useCallback(async (refresh: boolean): Promise<void> => {
    if (!live) return;
    const n = ++asked.current;
    setAsking(true);
    const a = await live.libraryUsage(project.id, entry.id, refresh ? { refresh: true } : undefined).catch((e: Error) => ({ state: 'down' as const, error: e.message || 'no answer' }));
    // Another entry, or a newer ask, was chosen meanwhile: this answer is not its.
    if (n !== asked.current) return;
    setAnswer(a);
    setAsking(false);
  }, [live, project.id, entry.id]);
  useEffect(() => { setAnswer(null); void ask(false); }, [ask]);
  return (
    <section className="live-section live-library-site" aria-label="Across the site" aria-busy={asking}>
      <div className="live-library-site-head">
        <h3 className="live-section-title">Across the site</h3>
        <IconButton icon="refresh" label={asking ? 'Searching the site…' : 'Search the site again'} disabled={asking} onClick={() => ask(true)} data-loading={asking ? '' : undefined} />
      </div>
      {!answer ? <p className="faint small" role="status">Searching what the site has stored…</p>
        : answer.state !== 'ok' ? (
          <div className="live-library-site-why">
            <p className="small live-library-why">{usageWhy(answer)}</p>
            {answer.state === 'down' || answer.state === 'unreadable' ? <Button size="s" icon="refresh" onClick={() => ask(true)}>Search again</Button> : null}
          </div>
        ) : <UsageList usage={answer.usage} site={site} readOnly={readOnly} />}
    </section>
  );
}

function UsageList({ usage, site, readOnly }: { usage: EntryUsage; site: LiveSite; readOnly: boolean }) {
  const live = liveBridge();
  const [said, setSaid] = useState<string | null>(null);
  const groups = usageGroups(usage);
  const open = (address: string, label: string): void => {
    if (!live) return;
    setSaid(null);
    void live.go(address).then((ok) => { if (!ok) setSaid(`The live view could not open ${label}.`); });
  };
  const opens = !readOnly && usage.places.some((p) => p.url || p.edit);
  const seconds = usage.ms >= 1000 ? `${(usage.ms / 1000).toFixed(1)} s` : `${usage.ms} ms`;
  return (
    <div className="live-library-site-list">
      <p className="small">{usageSummary(usage)}</p>
      {usage.gaps.length ? (
        <ul className="live-library-gaps small">{usage.gaps.map((g) => <li key={g}>{g}</li>)}</ul>
      ) : null}
      {groups.map((g) => (
        <div key={g.kind} className="live-library-usegroup" role="group" aria-label={g.title}>
          <h4 className="live-library-usehead">{g.title} <span className="live-library-count">{g.places.length}</span></h4>
          <ul className="live-library-places">
            {g.places.map((p, i) => <Place key={`${i}:${p.label}`} place={p} site={site} readOnly={readOnly} onOpen={open} />)}
          </ul>
        </div>
      ))}
      {said ? <p className="small live-library-why" role="status">{said}</p> : null}
      {readOnly && usage.places.some((p) => p.url || p.edit) ? <p className="faint small">A hosted environment is shown: show Local to open these on the local site.</p> : null}
      {!opens && usage.places.length && !readOnly ? <p className="faint small">None of these has a page that is sure to show it.</p> : null}
      <div className="live-library-unseen">
        <p className="small"><span className="live-made-title">What this search cannot see</span></p>
        <ul className="faint small">{usage.unseen.map((u) => <li key={u}>{u}</li>)}</ul>
      </div>
      <Disclosure title="What it searched" summary={`${usage.searched.length} ${usage.searched.length === 1 ? 'source' : 'sources'}, ${seconds}`} className="live-library-searched">
        <ul className="faint small">{usage.searched.map((x) => <li key={x}>{x}</li>)}</ul>
      </Disclosure>
    </div>
  );
}

function Place({ place, site, readOnly, onOpen }: { place: UsagePlace; site: LiveSite; readOnly: boolean; onOpen: (address: string, label: string) => void }) {
  const page = readOnly ? null : placeAddress(place.url, site.url);
  const edit = readOnly ? null : placeAddress(place.edit, site.url);
  const detail = placeDetail(place);
  const what = USAGE_TITLE[place.kind].one.toLowerCase();
  return (
    <li className="live-library-place">
      <span className="live-library-place-name">
        {page ? (
          <button type="button" className="live-library-place-open" data-tip={place.url} aria-label={`${place.label}, ${what}: open its page in the live view`} onClick={() => onOpen(page, place.label)}>{place.label}</button>
        ) : <span className="small">{place.label}</span>}
        {place.count ? <span className="live-library-count">×{place.count}</span> : null}
      </span>
      {detail ? <span className="faint small live-library-place-detail">{detail}</span> : null}
      {place.file ? <span className="lib-tag mono live-library-place-file">{place.file}</span> : null}
      {edit ? (
        <Button size="s" tone="quiet" icon="pencil" className="live-library-place-edit" aria-label={`${place.label}: open the site’s own page for changing it`} onClick={() => onOpen(edit, place.label)}>
          Change it
        </Button>
      ) : null}
    </li>
  );
}

/** Where the page shown uses an entry, as the trace names its parts. */
function Uses({ uses, regions, label, onSelect, onHover }: {
  uses: ReturnType<typeof usesOnPage>; regions: LiveRegion[]; label: string;
  onSelect: (region: LiveRegion) => void; onHover: (regions: LiveRegion[] | null, label?: string | null) => void;
}) {
  if (!uses.known) return <p className="small faint">{uses.why}</p>;
  const at = new Map(regions.map((r) => [r.index, r]));
  const shown = (u: PageUse): LiveRegion[] => u.regions.map((i) => at.get(i)).filter((r): r is LiveRegion => !!r);
  return (
    <>
      {uses.uses.length ? (
        <ul className="live-library-uses">
          {uses.uses.map((u) => {
            const rs = shown(u);
            return (
              <li key={`${u.part ?? ''}:${u.regions.join(',')}`}>
                <button type="button" className="live-library-use" disabled={!rs.length}
                  onMouseEnter={() => onHover(rs, u.label)} onMouseLeave={() => onHover(null)} onFocus={() => onHover(rs, u.label)} onBlur={() => onHover(null)}
                  onClick={() => { const r = rs[0]; if (r) { onHover(null); onSelect(r); } }}>
                  {u.label}
                </button>
              </li>
            );
          })}
        </ul>
      ) : <p className="small">Nothing on this page is {label}.</p>}
      <p className="faint small">The page shown, as its trace names its parts. Across the site, above, is what the site has stored.</p>
    </>
  );
}

/** Its files: each opens in the Code tab when it is in the folder the site serves; otherwise it is only named. */
function Files({ files, project, site }: { files: string[]; project: ProjectSummary; site: LiveSite }) {
  // The helper names them relative to the site's project root, which is the folder it serves: a card's checkout, or the project's.
  const root = useMemo(() => ({ projectId: project.id, cardId: site.servedCard ?? null }), [project.id, site.servedCard]);
  const [here, setHere] = useState<ReadonlyMap<string, boolean>>(new Map());
  useEffect(() => {
    let current = true;
    void Promise.all(files.map(async (f) => [f, await call('files.stat', { ...root, path: f }).then((s) => s.hash !== null, () => false)] as const))
      .then((found) => { if (current) setHere(new Map(found)); });
    return () => { current = false; };
  }, [files, root]);
  // Said once when none of them is here (the site serves another checkout, or its root is not the project's).
  const allAway = files.length > 1 && files.every((f) => here.has(f) && !here.get(f));
  return (
    <ul className="live-library-files">
      {files.map((f) => (
        <li key={f}>
          <span className="live-library-file">
            {here.get(f) ? (
              <button type="button" className="lib-tag mono live-file-open" data-tip={`Open ${f} in the code editor`}
                onClick={() => openInEditor({ projectId: root.projectId, cardId: root.cardId, path: f })}>{f}</button>
            ) : <span className="lib-tag mono">{f}</span>}
            <CopyButton text={f} label={`Copy ${f.split('/').pop()}’s path`} what="the path" />
          </span>
          {!allAway && here.has(f) && !here.get(f) ? <span className="faint small">Not in the folder this project’s site serves, so it cannot open here.</span> : null}
        </li>
      ))}
      {allAway ? <li className="faint small">None of these is in the folder this project’s site serves, so they cannot open here.</li> : null}
    </ul>
  );
}
