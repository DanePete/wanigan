// The live view: a project's local site inside Wanigan, following the agents'
// edits. The app lays its own view over the stage below (lib/live.ts); this
// file decides what to show around it, when to reload, and what to outline.
// The side panel's parts are in components/live/. With the site helper's
// trace it also colours the page through lenses, edits parts where they show,
// moves them by hand, and lays out the request behind the page.
// Design: docs/design/2026-10-08-live-view.md.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react';
import type { LiveViewState } from '@shared/bridge';
import {
  inFolder, isStylesheet, regionMadeBy, sameRegion,
  type LiveCandidate, type LiveEdit, type LiveEvent, type LivePlatform, type LiveProblem, type LiveRegion, type LiveSite,
} from '@shared/live';
import { nameOf, themeOf } from '@shared/live-names';
import { lensView, partIndex, type LensId, type LiveTraceAnswer } from '@shared/live-lens';
import type { EditTarget } from '@shared/live-trace';
import { layersOf } from '@shared/live-tree';
import type { ProjectSummary } from '@shared/model';
import { attempt, bridge, call, forProject, useQuery } from '../lib/api';
import { liveBridge, useLiveCovered } from '../lib/live';
import { navigate } from '../lib/router';
import { useAppState } from '../lib/settings';
import { liveFor } from '@shared/settings';
import { Icon } from './icons';
import { Inspector, type Selection } from './live/Inspector';
import { HelperOffer, HelperSettings } from './live/Helper';
import { Layers } from './live/Layers';
import { NoteComposer, NotesTab, draftFor } from './live/Notes';
import { useNotes, type LiveNote } from './live/note-store';
import { ProblemsTab } from './live/Problems';
import { PaletteTab, useArrange } from './live/Arrange';
import { EditSheet, type EditRequest } from './live/EditSheet';
import { LensPicker, LensStrip, usePaintLens } from './live/Lenses';
import { RequestTab } from './live/Request';
import { TraceNote } from './live/TraceNote';
import { Button, Empty, IconButton, Segmented, useToast } from './ui';
import '../styles/live.css';

const PLATFORMS: readonly { value: LivePlatform; label: string; hint: string }[] = [
  { value: 'drupal', label: 'Drupal', hint: 'Twig debug comments and components say what made each part' },
  { value: 'wordpress', label: 'WordPress', hint: 'Blocks and Elementor elements say what they are' },
  { value: 'site', label: 'Another site', hint: 'Any address: it reloads as the agents edit' },
];

export function LivePane({ project, follow = null, card = null, compact = false, outlineFirst = null }: {
  project: ProjectSummary;
  /** Follow only this session's edits (a session's split view); null follows the whole project. */
  follow?: string | null;
  /** The followed session's card: its screenshots can be of the page shown. */
  card?: { id: string; key: string } | null;
  compact?: boolean;
  /** Files whose parts to outline once the page first loads (a session's "See it"). */
  outlineFirst?: string[] | null;
}) {
  const { state } = useAppState();
  const site = useQuery('live.site', { projectId: project.id }, ['liveSite', 'projects'], forProject(project.id));
  const [editing, setEditing] = useState(false);
  if (state && !state.settings.liveView) return <LiveOff />;
  const platform = site.data?.platform ?? null;
  if (state && site.data?.url && !editing && !liveFor(state.settings, platform)) {
    return <LiveOff kind={PLATFORMS.find((p) => p.value === platform)?.label ?? null} onChange={() => setEditing(true)} />;
  }
  if (!site.data) {
    return site.error ? <p className="error-text live-pad">{site.error.message}</p> : <p className="faint live-pad">Looking for the site…</p>;
  }
  if (!site.data.url || editing) {
    return <LiveSetup site={site.data} project={project} onDone={() => setEditing(false)} canCancel={!!site.data.url} />;
  }
  if (!liveBridge()) {
    return <Empty title="The live view needs the Wanigan app">It shows {site.data.url} in a view of the app’s own, which this window does not have.</Empty>;
  }
  return (
    <LiveShown key={site.data.url} site={site.data} url={site.data.url} project={project} follow={follow} card={card} compact={compact}
      following={state?.settings.liveFollow ?? true} shots={state?.settings.liveShots ?? false} outlineFirst={outlineFirst} onEdit={() => setEditing(true)} />
  );
}

/** The live view is off, or off for this kind of site. */
function LiveOff({ kind = null, onChange }: { kind?: string | null; onChange?: () => void }) {
  return (
    <Empty title={kind ? `The live view is off for ${kind === 'Another site' ? 'other sites' : `${kind} sites`}` : 'The live view is off'}
      action={(
        <>
          <Button tone="primary" icon="settings" onClick={() => navigate({ name: 'settings' })}>Open Settings</Button>
          {kind && onChange ? <Button tone="quiet" onClick={onChange}>Change the site</Button> : null}
        </>
      )}>
      {kind
        ? 'Switch that kind of site on in Settings › Live view, or point this project at another address.'
        : 'Switch it on in Settings › Live view to see each project’s local site here, changing as the agents change it.'}
    </Empty>
  );
}

/* ── choosing the site ─────────────────────────────────────────────────── */

function LiveSetup({ site, project, onDone, canCancel }: { site: LiveSite; project: ProjectSummary; onDone: () => void; canCancel: boolean }) {
  const toast = useToast();
  const first = site.candidates[0];
  const [url, setUrl] = useState(site.url ?? first?.url ?? '');
  const [platform, setPlatform] = useState<LivePlatform>(site.platform ?? first?.platform ?? 'site');
  const [busy, setBusy] = useState(false);
  const save = async (next: { url: string | null; platform: LivePlatform }): Promise<void> => {
    setBusy(true);
    const done = await attempt(() => call('live.setSite', { projectId: project.id, url: next.url, platform: next.platform }), (m) => toast(m, 'error'));
    setBusy(false);
    if (done) onDone();
  };
  const choose = (c: LiveCandidate): void => { setUrl(c.url); setPlatform(c.platform); void save(c); };
  const submit = (e: FormEvent): void => { e.preventDefault(); void save({ url, platform }); };
  return (
    <div className="live-setup">
      <h2 className="section-title">Where is {project.name}’s local site?</h2>
      <p className="lede">
        The live view opens the site you already run on this Mac and reloads it as the agents edit. Wanigan starts nothing and
        changes nothing in the project to do this.
      </p>
      {site.candidates.length ? (
        <ul className="live-candidates" aria-label="Addresses found in the project">
          {site.candidates.map((c) => (
            <li key={c.url} className="live-candidate">
              <div className="live-candidate-text">
                <span className="mono">{c.url}</span>
                <span className="faint small">{PLATFORMS.find((p) => p.value === c.platform)?.label} · {c.why}</span>
              </div>
              <Button size="s" tone={c.url === site.url ? 'quiet' : 'plain'} disabled={busy || c.url === site.url} onClick={() => choose(c)}>
                {c.url === site.url ? 'In use' : 'Use this'}
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="faint">Nothing in the project names a local address (no .ddev folder, WP_HOME, dev script or .lando.yml). Type it below.</p>
      )}
      <form className="live-typed" onSubmit={submit}>
        <label className="field-label" htmlFor="live-url">Address</label>
        <input id="live-url" className="mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mysite.ddev.site" spellCheck={false} autoComplete="off" />
        <span className="field-label">Runs on</span>
        <Segmented<LivePlatform> size="s" label="Runs on" value={platform} options={PLATFORMS} onChange={setPlatform} />
        <div className="live-typed-actions">
          {canCancel ? <Button tone="quiet" onClick={onDone}>Cancel</Button> : null}
          {site.url ? <Button tone="quiet" disabled={busy} onClick={() => void save({ url: null, platform })}>Forget this site</Button> : null}
          <Button type="submit" tone="primary" disabled={busy || !url.trim()}>{busy ? 'Saving…' : 'Open it'}</Button>
        </div>
      </form>
      {site.url ? <HelperSettings site={site} project={project} /> : null}
    </div>
  );
}


/* ── the site ──────────────────────────────────────────────────────────── */

/** Quiet time after an edit before reloading: an agent writing several files reloads once. */
const SETTLE_MS = 400;
/** Sass, Less and the like are compiled by the project's own watcher: give it a moment before fetching the CSS. */
const COMPILE_MS = 1_200;
/**
 * PHP's opcode cache looks at a changed file again only every couple of
 * seconds (ddev's PHP-FPM: opcache.revalidate_freq 2): a reload sooner can show
 * the code from before the edit.
 */
const PHP_MS = 2_400;
const PHP_FILE = /\.(php|module|inc|theme|install|engine)$/i;
/** After a load, how often and how long to look for parts the page adds late (AJAX, lazy blocks). */
const LATE_EVERY_MS = 1_500;
const LATE_TRIES = 6;
/** How often to ask the site helper whether content changed; and how many reloads in a minute before deciding the site changes on its own. */
const CONTENT_EVERY_MS = 2_000;
const CONTENT_RELOADS_A_MINUTE = 4;

type Tab = 'layers' | 'notes' | 'problems' | 'request' | 'add';
const ARRANGE_KEY = 'wanigan.live.arrange';
const readArrange = (): boolean => { try { return localStorage.getItem(ARRANGE_KEY) !== '0'; } catch { return true; } };
type Width = 'full' | 'tablet' | 'phone';
const WIDTHS: Record<Width, { px: number | null; label: string; icon: 'desktop' | 'tablet' | 'phone' }> = {
  full: { px: null, label: 'Full width', icon: 'desktop' },
  tablet: { px: 768, label: 'Tablet, 768 pixels wide', icon: 'tablet' },
  phone: { px: 390, label: 'Phone, 390 pixels wide', icon: 'phone' },
};

type Banner =
  | { kind: 'outlined'; file: string; count: number }
  | { kind: 'not-here'; file: string }
  | { kind: 'elsewhere'; file: string }
  | { kind: 'waiting'; file: string }
  | { kind: 'reloaded' }
  | { kind: 'content'; cms: string }
  | { kind: 'restless' };

const fileName = (path: string): string => path.split('/').pop() ?? path;

function bannerText(n: Banner): string {
  switch (n.kind) {
    case 'outlined': return `${n.file} changed: ${n.count === 1 ? 'outlined the part' : `outlined the ${n.count} parts`} of this page it makes.`;
    case 'not-here': return `${n.file} changed, and nothing on this page says it came from it. Reloaded anyway.`;
    case 'elsewhere': return `${n.file} changed in another checkout, which this site is not serving. Nothing reloaded.`;
    case 'waiting': return `${n.file} changed. Reload to see it (following the agents’ edits is off in Settings).`;
    case 'reloaded': return 'A turn ended without editing a file: reloaded, in case it changed content.';
    case 'content': return `Content changed in ${n.cms}: reloaded.`;
    case 'restless': return 'The site keeps changing its content on its own, so reloading for content changes has stopped until the page is reloaded.';
  }
}

function LiveShown({ site, url, project, follow, card, compact, following, shots, outlineFirst, onEdit }: {
  site: LiveSite; url: string; project: ProjectSummary; follow: string | null; card: { id: string; key: string } | null; compact: boolean;
  /** Reload as the agents edit (Settings › Live view); off, an edit only leaves a note. */
  following: boolean;
  /** Before and after screenshots are on (Settings › Live view). */
  shots: boolean;
  outlineFirst: string[] | null; onEdit: () => void;
}) {
  const toast = useToast();
  const live = liveBridge() as NonNullable<ReturnType<typeof liveBridge>>;
  // Components and templates are Drupal's own; other kinds of site have none to map.
  const siteParts = useQuery('live.parts', site.platform === 'drupal' ? { projectId: project.id } : null, ['liveSite'], forProject(project.id));
  const notes = useNotes(project.id);
  const [view, setView] = useState<LiveViewState | null>(null);
  const [regions, setRegions] = useState<LiveRegion[]>([]);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [picking, setPicking] = useState(false);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [address, setAddress] = useState(url);
  const [hasScript, setHasScript] = useState(true);
  const [tab, setTab] = useState<Tab>('layers');
  const [width, setWidth] = useState<Width>('full');
  const [changed, setChanged] = useState<ReadonlySet<number>>(new Set());
  const [problems, setProblems] = useState<LiveProblem[] | null>(null);
  const queue = useRef<{ paths: Set<string>; timer: number | null }>({ paths: new Set(), timer: null });
  /** Files to outline once the load in flight has finished. */
  const outlineAfterLoad = useRef<string[] | null>(outlineFirst);
  const late = useRef<{ timer: number | null; seen: number; tries: number }>({ timer: null, seen: -1, tries: 0 });
  const root = site.servedPath ?? project.path;
  const components = useMemo(() => new Map((siteParts.data?.components ?? []).map((c) => [c.id, c])), [siteParts.data]);
  const componentsRef = useRef(components);
  const partsRef = useRef(partIndex([], null));
  componentsRef.current = components;
  const scanned = useRef<LiveRegion[]>([]);
  const selected = useRef<Selection | null>(null);
  selected.current = selection;
  const theme = useMemo(() => themeOf(regions), [regions]);
  /* The site helper's trace of the page shown, and what is built on it. */
  const [trace, setTrace] = useState<LiveTraceAnswer | null>(null);
  const traceData = trace?.state === 'ok' ? trace.trace : null;
  const parts = useMemo(() => partIndex(regions, traceData), [regions, traceData]);
  partsRef.current = parts;
  const partName = useCallback((id: string) => { const p = parts.parts.get(id); return p ? { label: p.label, kind: p.kind } : null; }, [parts]);
  const layers = useMemo(() => layersOf(regions, { componentName: (id) => components.get(id)?.name ?? null, partName }), [regions, components, partName]);
  const [lens, setLens] = useState<LensId>('structure');
  const [only, setOnly] = useState<string | null>(null);
  const [saved, setSaved] = useState(() => ({ ids: new Set<string>(), labels: new Set<string>(), parts: new Set<string>() }));
  const lensed = useMemo(() => lensView(lens, { regions, trace: traceData, changed, saved }), [lens, regions, traceData, changed, saved]);
  usePaintLens(lensed, only);
  const [editing, setEditing] = useState<EditRequest | null>(null);
  const [arrangeOn, setArrangeOn] = useState(readArrange);
  const stageRef = useRef<HTMLDivElement>(null);
  const deviceRef = useRef<HTMLDivElement>(null);
  const arrange = useArrange({
    project, platform: site.platform, trace: traceData, parts, regions, layers, page: view?.url ?? url,
    enabled: arrangeOn && hasScript && !compact && !picking && !editing && !view?.loading && !view?.error,
    onSaved: (label) => setSaved((was) => ({ ...was, parts: new Set([...was.parts, label.replace(/^(Moved|Added) /, '').split(',')[0] as string]) })),
  });
  const helperSite = site.platform === 'drupal' || site.platform === 'wordpress';
  const fetchTrace = useCallback(async (): Promise<void> => {
    if (!helperSite) { setTrace(null); return; }
    if (!site.helper || !site.token) { setTrace({ state: 'no-helper' }); return; }
    setTrace(await live.trace());
  }, [live, helperSite, site.helper, site.token]);

  useEffect(() => { void live.hasScript().then(setHasScript); }, [live]);
  useEffect(() => { setOnly(null); }, [lens]);

  // Escape, in the window or in the page, takes a lens away (and stops placing a palette entry).
  useEffect(() => {
    if (lens === 'structure' && !arrange.placing) return undefined;
    const back = (): void => { setLens('structure'); arrange.setPlacing(null); };
    const key = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('.scrim, .live-sheet')) return;
      const t = e.target as Element | null;
      if (t?.closest?.('input, textarea, select, .sel-list') || (t && t !== document.body && !t.closest?.('.live'))) return;
      e.preventDefault();
      back();
    };
    document.addEventListener('keydown', key, true);
    const off = live.onKey(back);
    return () => { document.removeEventListener('keydown', key, true); off(); };
  }, [lens, arrange.placing, live]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Whether a part of the page was made by an edited file: its template, or a file in its component's folder. */
  const madeBy = useCallback((r: LiveRegion, path: string): boolean => {
    if (regionMadeBy(r.file, path)) return true;
    const c = r.component ? componentsRef.current.get(r.component) : undefined;
    return !!c && inFolder(c.dir, path);
  }, []);

  /** What a part is called on the page's outline: its name (the helper's, when the trace has one), and the file that made it. */
  const labelOf = useCallback((r: LiveRegion): string => {
    const part = partsRef.current.byRegion.get(r.index);
    const name = nameOf(r, r.component ? componentsRef.current.get(r.component)?.name ?? null : null, part ? { label: part.label, kind: part.kind } : null).title;
    return r.file ? `${name} · ${fileName(r.file)}` : r.component ? `${name} · ${r.component}` : name;
  }, []);

  const refreshProblems = useCallback(async (): Promise<void> => { setProblems(await live.problems()); }, [live]);

  const scanAndOutline = useCallback(async (paths: string[], reloaded: boolean): Promise<void> => {
    const before = scanned.current;
    const found = await live.scan();
    scanned.current = found;
    setRegions(found);
    // What the owner had chosen stays chosen, if the page still has it. A reload loses the picked element itself.
    const kept = selected.current;
    const region = kept?.region ? sameRegion(kept.region, before, found) : null;
    const next = kept && (region || (!reloaded && kept.pick)) ? { region, pick: reloaded ? null : kept.pick } : null;
    setSelection(next);
    const hits = paths.length ? found.filter((r) => paths.some((p) => madeBy(r, p))) : [];
    if (paths.length) setChanged(new Set(hits.map((h) => h.index)));
    if (hits.length) {
      await live.outline(hits.map((h) => h.index), null, 'edit');
      setBanner({ kind: 'outlined', file: fileName(paths[0] as string), count: hits.length });
      return;
    }
    if (paths.length) setBanner({ kind: 'not-here', file: fileName(paths[0] as string) });
    if (next?.region) await live.outline([next.region.index], labelOf(next.region), 'edit');
  }, [live, madeBy, labelOf]);

  /** Parts a page adds after it loads (a banner fetched by AJAX) are found by looking again while it changes. */
  const watchLate = useCallback((): void => {
    const l = late.current;
    if (l.timer !== null) window.clearTimeout(l.timer);
    l.tries = 0;
    l.seen = -1;
    const tick = async (): Promise<void> => {
      l.timer = null;
      const now = await live.mutations();
      if (l.seen >= 0 && now !== l.seen) await scanAndOutline([], false);
      l.seen = now;
      if (++l.tries < LATE_TRIES) l.timer = window.setTimeout(() => void tick(), LATE_EVERY_MS);
    };
    l.timer = window.setTimeout(() => void tick(), LATE_EVERY_MS);
  }, [live, scanAndOutline]);

  useEffect(() => live.onState((s) => {
    if (s.projectId !== project.id) return;
    setView(s);
    if (s.url) setAddress(s.url);
    if (s.loading) { setProblems(null); setTrace((t) => (t ? { state: 'none' } : t)); return; }
    if (!s.error) {
      const wanted = outlineAfterLoad.current;
      outlineAfterLoad.current = null;
      void scanAndOutline(wanted ?? [], true).then(() => { watchLate(); void fetchTrace(); return refreshProblems(); });
    }
  }), [live, project.id, scanAndOutline, watchLate, refreshProblems, fetchTrace]);

  useEffect(() => { if (view && !view.loading) void refreshProblems(); }, [view?.logged, refreshProblems]); // eslint-disable-line react-hooks/exhaustive-deps

  const flush = useCallback(async (): Promise<void> => {
    const q = queue.current;
    q.timer = null;
    const paths = [...q.paths];
    q.paths.clear();
    if (paths.length && paths.every(isStylesheet)) {
      await live.css();
      window.setTimeout(() => void scanAndOutline(paths, false), 250);
      return;
    }
    outlineAfterLoad.current = paths;
    // Past the browser's cache: a script or a page sent with max-age would otherwise come back as it was.
    await live.reload(true);
    if (!paths.length) setBanner({ kind: 'reloaded' });
  }, [live, scanAndOutline]);

  // The agents' edits: reload once things go quiet, and outline what the edited files made. A turn that edited no
  // file may still have changed content with a command (drush, wp-cli): its end reloads, unless the helper is
  // already watching content.
  const edited = useRef(new Set<string>());
  useEffect(() => bridge().on((event, data) => {
    if (event !== 'live') return;
    const e = data as LiveEvent;
    if (e.projectId !== project.id || (follow && e.sessionId !== follow)) return;
    if (e.kind === 'turn-start') { edited.current.delete(e.sessionId); return; }
    if (e.kind !== 'edit' && e.kind !== 'turn-end') return;
    const q = queue.current;
    if (e.kind === 'edit') {
      const inside = e.paths.filter((p) => p === root || p.startsWith(`${root}/`));
      if (!inside.length) { setBanner({ kind: 'elsewhere', file: fileName(e.paths[0] ?? '') }); return; }
      if (!following) { setBanner({ kind: 'waiting', file: fileName(inside[0] as string) }); return; }
      edited.current.add(e.sessionId);
      for (const p of inside) q.paths.add(p);
    } else {
      const reloadedForEdits = edited.current.delete(e.sessionId);
      if (!following || reloadedForEdits || site.helper) return;
    }
    if (q.timer !== null) window.clearTimeout(q.timer);
    const compiling = [...q.paths].some((p) => /\.(scss|sass|less)$/i.test(p));
    const php = [...q.paths].some((p) => PHP_FILE.test(p));
    q.timer = window.setTimeout(() => void flush(), php ? PHP_MS : compiling ? COMPILE_MS : SETTLE_MS);
  }), [project.id, follow, root, flush, following, site.helper]);

  // The helper's token arrived (or changed): load the page again so it carries the helper's marks, once the helper
  // answers (a site's PHP sees a newly written file only after its opcode cache looks again, every couple of seconds).
  const token = useRef(site.token);
  useEffect(() => {
    if (token.current === site.token) return;
    token.current = site.token;
    let stopped = false;
    void (async () => {
      for (let i = 0; i < 20 && site.token && !stopped; i++) {
        if ((await live.helperChanged()) !== null) break;
        await new Promise((done) => window.setTimeout(done, 500));
      }
      if (stopped) return;
      outlineAfterLoad.current = [];
      void live.reload(true);
    })();
    return () => { stopped = true; };
  }, [site.token, live]);

  // Content saved in Drupal changes the page without touching a file: the helper counts it, and the view follows.
  useEffect(() => {
    if (!site.helper || !site.token || !following) return;
    let last: number | null = null;
    let recent: number[] = [];
    let stopped = false;
    const timer = window.setInterval(() => {
      if (stopped || queue.current.timer !== null) return;
      void live.helperChanged().then((n) => {
        if (n === null || n < 0) return;
        if (last !== null && n !== last) {
          recent = [...recent.filter((t) => Date.now() - t < 60_000), Date.now()];
          if (recent.length > CONTENT_RELOADS_A_MINUTE) { stopped = true; setBanner({ kind: 'restless' }); return; }
          outlineAfterLoad.current = [];
          void live.reload(true);
          setBanner({ kind: 'content', cms: site.platform === 'wordpress' ? 'WordPress' : 'Drupal' });
        }
        last = n;
      });
    }, CONTENT_EVERY_MS);
    return () => window.clearInterval(timer);
  }, [site.helper, site.token, site.platform, following, live]);

  useEffect(() => () => {
    const t = queue.current.timer;
    if (t !== null) window.clearTimeout(t);
    if (late.current.timer !== null) window.clearTimeout(late.current.timer);
  }, []);

  const pick = async (): Promise<void> => {
    if (picking) { await live.cancelPick(); return; }
    setPicking(true);
    await live.disarm();
    const p = await live.pick();
    setPicking(false);
    if (!p) return;
    setTab('layers');
    setSelection({ region: p.regions[0] ?? null, pick: p });
    const inner = p.regions[0];
    if (inner) await live.outline([inner.index], labelOf(inner), 'edit'); else await live.clear();
    // The keyboard comes back to the window, to the part's details: Alt+arrows move it from there.
    await live.focusWindow();
    window.requestAnimationFrame(() => document.querySelector<HTMLElement>('.live-inspector .live-side-title')?.focus());
  };

  const openEdit = (target: EditTarget, region: LiveRegion | null): void => {
    void live.cancelEdit();
    setEditing({ target, region });
  };
  const editSaved = (target: EditTarget, revision: string | null): void => {
    setEditing(null);
    setSaved((was) => ({ ...was, ids: new Set([...was.ids, target.id]), labels: new Set([...was.labels, target.label]) }));
    toast(`Saved ${target.label}${revision ? `, as revision ${revision}` : ''}. The page shows it now.`);
  };
  const point = (indexes: number[] | null): void => { if (indexes) void live.outline(indexes.slice(0, 200), null, 'hover'); else hover(null); };
  const flipArrange = (): void => {
    setArrangeOn((v) => {
      try { localStorage.setItem(ARRANGE_KEY, v ? '0' : '1'); } catch { /* lasts this window */ }
      return !v;
    });
  };

  const select = (region: LiveRegion): void => {
    setSelection({ region, pick: null });
    void live.outline([region.index], labelOf(region), 'edit');
  };
  const hover = (list: LiveRegion[] | null, label: string | null = null): void => {
    if (list) { void live.outline(list.map((r) => r.index), label, 'hover'); return; }
    const kept = selection?.region;
    if (kept) void live.outline([kept.index], labelOf(kept), 'edit'); else void live.clear();
  };
  const unselect = (): void => { setSelection(null); void live.cancelEdit(); void live.clear(); };
  const showNote = (n: LiveNote | null): void => {
    const r = n?.regions[0];
    const same = r ? regions.filter((x) => sameRegion(r, [r], [x])) : [];
    if (same.length === 1) void live.outline([same[0]!.index], null, 'hover'); else hover(null);
  };
  const wordsSaved = (): void => {
    outlineAfterLoad.current = [];
    void live.reload();
  };

  const go = (e: FormEvent): void => {
    e.preventDefault();
    void live.go(address).then((ok) => {
      if (!ok) toast('That is another site. Change the address in the site settings (the gear) to open it.', 'error');
    });
  };

  const errors = problems?.length ?? 0;
  /** The view shows one piece alone (the helper's page), and which kind. */
  const alone = (() => {
    try { return /^\/_wanigan\/piece\/([a-z]+)\//.exec(new URL(view?.url ?? '').pathname)?.[1] ?? null; } catch { return null; }
  })();
  const tabs: { value: Tab; label: string; hint?: string }[] = [
    { value: 'layers', label: 'Layers' },
    { value: 'notes', label: notes.length ? `Notes ${notes.length}` : 'Notes' },
    { value: 'problems', label: errors ? `Problems ${errors}` : 'Problems' },
    ...(helperSite ? [{ value: 'request' as const, label: 'Request', hint: 'The hooks, queries, assets and logs behind this page' }] : []),
    ...(traceData?.palette?.length ? [{ value: 'add' as const, label: 'Add', hint: 'What the site can add to this page' }] : []),
  ];
  const shownTab: Tab = tabs.some((t) => t.value === tab) ? tab : 'layers';
  const cms = site.platform === 'wordpress' ? 'WordPress' : 'Drupal';

  return (
    <div className={`live${compact ? ' live-compact' : ''}`}>
      <form className="live-bar" onSubmit={go} aria-label="Live view">
        <IconButton icon="back" label="Back" disabled={!view?.canGoBack} onClick={() => void live.back()} />
        <IconButton icon="chevron" label="Forward" disabled={!view?.canGoForward} onClick={() => void live.forward()} />
        <IconButton icon="refresh" label={view?.loading ? 'Loading…' : 'Reload (hold Shift to skip the cache)'}
          onClick={(e) => void live.reload(e.shiftKey)} data-loading={view?.loading ? '' : undefined} />
        <label className="live-address">
          <span className="visually-hidden">Address</span>
          <input className="mono" value={address} onChange={(e) => setAddress(e.target.value)} spellCheck={false} autoComplete="off" />
        </label>
        <div className="live-widths" role="group" aria-label="Width">
          {(Object.keys(WIDTHS) as Width[]).map((w) => (
            <IconButton key={w} icon={WIDTHS[w].icon} label={WIDTHS[w].label} aria-pressed={width === w} data-on={width === w ? '' : undefined} onClick={() => setWidth(w)} />
          ))}
        </div>
        {!compact ? <LensPicker lens={lens} onChange={setLens} disabled={!hasScript} /> : null}
        {!compact ? (
          <IconButton icon="pieces" label={arrangeOn ? 'Moving parts by dragging is on: a handle shows on the part under the pointer' : 'Moving parts by dragging is off'}
            aria-pressed={arrangeOn} data-on={arrangeOn ? '' : undefined} onClick={flipArrange} disabled={!hasScript} />
        ) : null}
        <Button size="s" tone={picking ? 'primary' : 'quiet'} icon="pick" onClick={() => void pick()} disabled={!hasScript}
          title={hasScript ? 'Point at something on the page to see what made it: ↑ and ↓ walk out and in, Enter picks, Escape stops' : 'This build of Wanigan has no page script'} aria-pressed={picking}>
          {picking ? 'Picking…' : 'Pick'}
        </Button>
        {card && shots ? <ShotPage card={card} page={view?.url ?? null} /> : null}
        <IconButton icon="open" label="Open in the default browser" onClick={() => void live.open()} />
        <IconButton icon="settings" label="Site settings" onClick={onEdit} />
      </form>
      {!compact ? (
        <LensStrip view={lensed} only={only} onOnly={setOnly} onHover={point} onClose={() => setLens('structure')}
          note={<TraceNote compact answer={trace} site={site} project={project} />} />
      ) : null}
      {arrange.placing ? (
        <div className="live-lens" role="region" aria-label="Placing">
          <span className="live-lens-name">Placing {arrange.placing.label}</span>
          <span className="small">The page shows where it would go: click there to add it. Escape stops.</span>
          <span className="live-lens-esc" />
          <IconButton icon="close" label="Stop placing (Escape)" onClick={() => arrange.setPlacing(null)} />
        </div>
      ) : null}
      <div className="visually-hidden" role="status" aria-live="polite">{arrange.said}</div>
      {arrange.asking}
      <div className="live-main">
        <LiveStage project={project} url={url} token={site.token} view={view} width={WIDTHS[width].px} onReload={() => void live.reload(true)} onEdit={onEdit}
          stageRef={stageRef} deviceRef={deviceRef}>
          {editing ? (
            <EditSheet request={editing} stage={stageRef} device={deviceRef} cms={cms} onClose={() => setEditing(null)} onSaved={editSaved} />
          ) : null}
        </LiveStage>
        {compact ? (
          selection?.pick ? (
            <div className="live-strip">
              <span className="live-strip-what">
                <span className="live-made-title">{selection.region ? selectionTitle(selection, components) : `<${selection.pick.tag}>`}</span>
                <span className="mono small faint">{selection.region?.component ?? selection.region?.file ?? selection.pick.selector}</span>
              </span>
              <NoteComposer compact project={project} components={components} prefer={follow}
                draft={draftFor(view?.url ?? url, { regions: selection.pick.regions, pick: selection.pick })} onDone={unselect} />
              <IconButton icon="close" label="Clear the pick" onClick={unselect} />
            </div>
          ) : null
        ) : (
          <aside className={`live-side${shownTab === 'request' ? ' wide' : ''}`} aria-label="What is on this page">
            <Segmented<Tab> size="s" label="Show" value={shownTab} options={tabs} onChange={setTab} />
            {alone ? (
              <p className="live-note live-alone small" role="status">
                <span>Showing one piece alone{alone === 'sample' || alone === 'component' ? ', with sample content' : ''}.</span>
                <Button size="s" tone="quiet" icon="back" onClick={() => void live.back()}>Back to the page</Button>
              </p>
            ) : null}
            {banner && shownTab === 'layers' && !alone ? <p className="live-note small" role="status">{bannerText(banner)}</p> : null}
            {shownTab === 'layers' ? (
              selection ? (
                <Inspector project={project} platform={site.platform} selection={selection} regions={regions} components={components} docroot={siteParts.data?.docroot ?? null}
                  theme={theme} page={view?.url ?? url} prefer={follow} helper={!!site.helper} onSelect={select} onClose={unselect} onSaved={wordsSaved}
                  site={site} answer={trace} trace={traceData} parts={parts} arrange={arrange} onEdit={openEdit} />
              ) : (
                <>
                  {regions.length ? (
                    <Layers regions={regions} components={components} selected={null} changed={changed} onHover={hover} onSelect={select} partName={partName} />
                  ) : (
                    <NothingMarked platform={site.platform} loading={!!view?.loading} />
                  )}
                  <HelperOffer site={site} project={project} />
                </>
              )
            ) : shownTab === 'request' ? (
              <RequestTab answer={trace} site={site} project={project} parts={parts} onPoint={point} />
            ) : shownTab === 'add' ? (
              <PaletteTab arrange={arrange} trace={traceData} />
            ) : shownTab === 'notes' ? (
              <>
                <NotesTab project={project} components={components} prefer={follow} onShow={showNote} />
                <EditsList project={project} />
              </>
            ) : (
              <ProblemsTab problems={problems} project={project} url={view?.url ?? url} onRefresh={() => void refreshProblems()} />
            )}
            <p className="live-side-foot faint small">
              {site.platform === 'drupal' ? 'Drupal' : site.platform === 'wordpress' ? 'WordPress' : 'Site'} · {follow ? 'following this session' : `following every session in ${project.name}`}
            </p>
          </aside>
        )}
      </div>
    </div>
  );
}

/** Which page a card's before and after are of: the site's address unless the owner chose this one. */
function ShotPage({ card, page }: { card: { id: string; key: string }; page: string | null }) {
  const toast = useToast();
  const chosen = useQuery('live.page', { cardId: card.id }, ['liveShots']);
  const here = !!page && chosen.data?.url === page;
  const flip = async (): Promise<void> => {
    if (!page) return;
    const done = await attempt(() => call('live.setPage', { cardId: card.id, url: here ? null : page }), (m) => toast(m, 'error'));
    if (!done) return;
    void chosen.reload();
    toast(here ? `${card.key}’s screenshots are of the site’s own address again.` : `${card.key}’s before and after will be of this page.`);
  };
  return (
    <IconButton icon="camera" label={here ? `${card.key}’s screenshots are of this page (click for the site’s address)` : `Take ${card.key}’s before and after of this page`}
      aria-pressed={here} data-on={here ? '' : undefined} onClick={flip} />
  );
}

function selectionTitle(s: Selection, components: Map<string, { name: string }>): string {
  const r = s.region;
  if (!r) return s.pick?.tag ?? 'Part';
  return r.component ? components.get(r.component)?.name ?? r.component : r.file ? fileName(r.file) : r.entity ?? r.block ?? r.view ?? 'Part';
}

function NothingMarked({ platform, loading }: { platform: LivePlatform | null; loading: boolean }) {
  if (loading) return <p className="faint small live-side-block">Loading the page…</p>;
  return (
    <div className="live-side-block">
      <p className="small">Nothing on this page says what made it. Pick a part to point an agent at it anyway.</p>
      {platform === 'drupal' ? (
        <p className="faint small">
          Drupal marks every template and component while Twig debug is on: Configuration › Development › Development settings, “Twig development mode”
          with debug on and caching off. Components carry their id either way.
        </p>
      ) : platform === 'wordpress' ? (
        <p className="faint small">Blocks and Elementor elements mark themselves; classic theme templates do not say which file made them.</p>
      ) : null}
    </div>
  );
}

/** Words saved by hand to templates, newest first, each put back with one click while the file is as it left it. */
function EditsList({ project }: { project: ProjectSummary }) {
  const toast = useToast();
  const edits = useQuery('live.edits', { projectId: project.id }, ['liveEdits'], (_e, d) => (d as { projectId?: string }).projectId === project.id);
  const list = (edits.data ?? []).slice(0, 8);
  if (!list.length) return null;
  const revert = async (e: LiveEdit): Promise<void> => {
    const done = await attempt(() => call('live.revert', { id: e.id }), (m) => toast(m, 'error'));
    if (done) { toast(`Put back “${e.before}”.`); void liveBridge()?.reload(); }
  };
  return (
    <div className="live-side-block live-edits">
      <h3 className="live-section-title">Saved by hand</h3>
      <ul className="live-made">
        {list.map((e) => (
          <li key={e.id}>
            <span className="small">“{e.before}” → “{e.after}”</span>
            <span className="mono small faint" title={e.path}>{fileName(e.path)}:{e.line}</span>
            {e.revertedAt ? <span className="faint small">Put back</span>
              : e.revertable ? <Button size="s" tone="quiet" icon="undo" onClick={() => revert(e)}>Put back</Button>
                : <span className="faint small">Changed since: put back by hand</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The placeholder the app lays its view over. It reports where it is as it
 * moves, steps the view aside while something covers it (showing the last
 * frame instead), narrows to a device's width, and shows why a page did not load.
 */
function LiveStage({ project, url, token, view, width, onReload, onEdit, stageRef, deviceRef, children }: {
  project: ProjectSummary; url: string; token: string | null; view: LiveViewState | null; width: number | null; onReload: () => void; onEdit: () => void;
  stageRef: RefObject<HTMLDivElement | null>; deviceRef: RefObject<HTMLDivElement | null>;
  /** What sits over the page: an edit sheet beside a part. */
  children?: ReactNode;
}) {
  const live = liveBridge() as NonNullable<ReturnType<typeof liveBridge>>;
  const device = deviceRef;
  const covered = useLiveCovered();
  const [frame, setFrame] = useState<string | null>(null);
  const error = view?.error ?? null;
  const hidden = covered || !!error;

  useLayoutEffect(() => {
    const el = device.current;
    if (!el) return;
    const rect = (): { x: number; y: number; width: number; height: number } => {
      const b = el.getBoundingClientRect();
      return { x: b.left, y: b.top, width: b.width, height: b.height };
    };
    void live.show(project.id, url, rect(), token);
    let raf = 0;
    const moved = (): void => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => live.bounds(rect())); };
    const observer = new ResizeObserver(moved);
    observer.observe(el);
    window.addEventListener('resize', moved);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      window.removeEventListener('resize', moved);
      void live.hide();
    };
  }, [live, project.id, url, token]);

  useEffect(() => {
    let current = true;
    if (hidden) void live.cover(true).then((f) => { if (current && covered) setFrame(f); });
    else { setFrame(null); void live.cover(false); }
    return () => { current = false; };
  }, [hidden, covered, live]);

  return (
    <div className={`live-stage${width ? ' narrow' : ''}`} ref={stageRef}>
      <div className="live-device" ref={device} style={width ? { width } : undefined}>
        {frame && !error ? <img className="live-frame" src={frame} alt="" /> : null}
      </div>
      {width ? <span className="live-device-size faint small" aria-hidden="true">{width} px</span> : null}
      {error ? <LoadProblem error={error} url={url} onReload={onReload} onEdit={onEdit} /> : null}
      {children}
    </div>
  );
}

function LoadProblem({ error, url, onReload, onEdit }: { error: NonNullable<LiveViewState['error']>; url: string; onReload: () => void; onEdit: () => void }) {
  const host = (() => { try { return new URL(error.url || url).host; } catch { return url; } })();
  const certificate = /CERT|SSL/i.test(error.description);
  const nobody = /CONNECTION_REFUSED|NAME_NOT_RESOLVED|ADDRESS_UNREACHABLE|CONNECTION_FAILED|TIMED_OUT/i.test(error.description);
  return (
    <div className="live-problem" role="alert">
      <Icon name="alert" size={18} />
      <div>
        <p className="live-problem-title">
          {certificate ? `This Mac does not trust ${host}’s certificate` : nobody ? `Nothing answered at ${host}` : `${host} did not load`}
        </p>
        <p className="small">
          {certificate
            ? 'Wanigan trusts certificates from this Mac’s own mkcert authority (ddev’s). This one is from somewhere else, or mkcert has no authority here yet: run mkcert -install, then reload.'
            : nobody
              ? 'Start the site first (for ddev: ddev start in the project folder), then reload.'
              : 'Chromium gave this reason:'}
          {' '}<span className="mono faint">{error.description}</span>
        </p>
        <div className="live-problem-actions">
          <Button size="s" icon="refresh" onClick={onReload}>Reload</Button>
          <Button size="s" tone="quiet" onClick={onEdit}>Change the address</Button>
        </div>
      </div>
    </div>
  );
}
