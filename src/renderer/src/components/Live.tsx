// The live view: a project's local site inside Wanigan, following the agents'
// edits. The app lays its own view over the stage below (lib/live.ts); this
// file decides what to show around it, when to reload, and what to outline.
// The side panel's parts are in components/live/. With the site helper's
// trace it also colours the page through lenses, edits parts where they show,
// moves them by hand, and lays out the request behind the page.
//
// The bar is three groups: the site (which environment, Compare, the
// settings: one menu), the page (back, forward, reload, the address field
// that opens Go to, the width, the lens), and the tools (Pick, and a menu of
// the rarely used). One status line under the page says what just happened
// and which keys work now; the keys themselves are shared/live-keys.ts. The
// tools' Library opens the site's component library in the side panel
// (components/live/Library.tsx), and Edits the design layer's tray
// (components/live/Tray.tsx): the page's edits, made real and verified there.
//
// The side panel's Layers tab keeps the tree beside a chosen part's details
// (components/live/LayersPane.tsx). Notes, Problems and Request are tabs of
// the dock beneath the page, beside the code editor (components/live/Dock.tsx).
// Compare is drawn in the stage, where the page is (components/live/Compare.tsx).
// Design: docs/design/2026-10-08-live-view.md.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react';
import type { LiveViewState } from '@shared/bridge';
import {
  inFolder, isStylesheet, regionMadeBy, sameRegion, sameSite,
  type LiveCandidate, type LiveEvent, type LivePlatform, type LiveProblem, type LiveRegion, type LiveSite,
} from '@shared/live';
import type { CompareWidth } from '@shared/live-compare';
import { samePage } from '@shared/live-envs';
import { diagnose, type LiveStatus } from '@shared/live-site';
import { nameOf, themeOf } from '@shared/live-names';
import { lensView, partIndex, type LensId, type LiveTraceAnswer } from '@shared/live-lens';
import type { LiveSiteAiAnswer, SaveAi } from '@shared/live-ai';
import type { WriteCheck } from '@shared/live-check';
import type { EditTarget } from '@shared/live-trace';
import { layersOf } from '@shared/live-tree';
import type { ProjectSummary } from '@shared/model';
import { isSendKey, liveKey, type LiveKeyId } from '@shared/live-keys';
import { attempt, bridge, call, forProject, useQuery } from '../lib/api';
import { liveBridge, useLiveCovered } from '../lib/live';
import { anchorGoTo, isTyping, showingOrigin, useGoToKeys } from '../lib/live-goto';
import { navigate } from '../lib/router';
import { useAppState } from '../lib/settings';
import { liveFor, type AppSettings } from '@shared/settings';
import { Icon } from './icons';
import { MenuButton, type MenuItem } from './Menu';
import { Inspector, type InspectorVerbs, type Selection } from './live/Inspector';
import { ComparePanel } from './live/Compare';
import { EnvironmentSettings, HOSTED_NOTE, SiteMenu, useEnvs } from './live/Environments';
import { HelperOffer, HelperSettings } from './live/Helper';
import { Layers } from './live/Layers';
import { LayersPane, focusTree, useTreeBeside } from './live/LayersPane';
import { LiveDock, type LiveDockTab } from './live/Dock';
import { EditsList, NoteComposer, NotesTab, draftFor, useNotesSender } from './live/Notes';
import { useNotes, type LiveNote } from './live/note-store';
import { ProblemsTab } from './live/Problems';
import { PaletteTab, useArrange } from './live/Arrange';
import { LibraryPanel } from './live/Library';
import { LayerTray } from './live/Tray';
import { useLayer } from './live/use-layer';
import { pagePath } from '../lib/live-layer';
import { EditSheet, type EditRequest } from './live/EditSheet';
import { LensPicker, LensStrip, usePaintLens } from './live/Lenses';
import { RequestTab } from './live/Request';
import { TraceNote } from './live/TraceNote';
import { SiteTrouble, useSiteStatus } from './live/SiteTrouble';
import { useWriteChecks } from './live/write-checks';
import { Button, Empty, IconButton, Segmented, useToast } from './ui';
import { openInEditor, relativeTo } from '../editor/EditButton';
import { stepDock } from '../editor/store';
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
  if (state && !state.settings.liveView) return <LiveOff platform={site.data?.platform ?? null} />;
  const platform = site.data?.platform ?? null;
  if (state && site.data?.url && !editing && !liveFor(state.settings, platform)) {
    return <LiveOff platform={platform} kindOff onChange={() => setEditing(true)} />;
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

/** The setting that switches each kind of site on. */
const KIND_SETTING: Record<LivePlatform, 'liveDrupal' | 'liveWordpress' | 'liveSites'> = { drupal: 'liveDrupal', wordpress: 'liveWordpress', site: 'liveSites' };

/**
 * The live view is off, or off for this kind of site. The tab is always there,
 * so this is where it is found: switching it on here is the same switch as in
 * Settings › Live view, and nothing is loaded until it is pressed.
 */
function LiveOff({ platform = null, kindOff = false, onChange }: { platform?: LivePlatform | null; kindOff?: boolean; onChange?: () => void }) {
  const { update } = useAppState();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const kind = platform ? PLATFORMS.find((p) => p.value === platform)?.label ?? null : null;
  const plural = kind === 'Another site' ? 'other sites' : kind ? `${kind} sites` : null;
  const switchOn = async (): Promise<void> => {
    setBusy(true);
    // The view and this kind of site together: one press is enough to see the page.
    const patch: Partial<AppSettings> = platform ? { liveView: true, [KIND_SETTING[platform]]: true } : { liveView: true };
    await update(patch).catch((e: Error) => toast(e.message, 'error'));
    setBusy(false);
  };
  return (
    <Empty title={kindOff && plural ? `The live view is off for ${plural}` : 'The live view is off'}
      action={(
        <>
          <Button tone="primary" icon="live" disabled={busy} onClick={() => void switchOn()}>
            {kindOff && plural ? `Switch it on for ${plural}` : 'Switch on the live view'}
          </Button>
          <Button tone="quiet" icon="settings" onClick={() => navigate({ name: 'settings' })}>Settings</Button>
          {kindOff && onChange ? <Button tone="quiet" onClick={onChange}>Change the site</Button> : null}
        </>
      )}>
      {kindOff
        ? 'Switch that kind of site on, or point this project at another address.'
        : 'The live view shows this project’s local site inside Wanigan and reloads it as the agents edit, outlining what each change made. It loads only your local site, and only once you switch it on; it is the same switch as in Settings › Live view.'}
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
      {site.url ? <EnvironmentSettings site={site} project={project} /> : null}
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

/** The side panel's tabs. Notes, Problems and Request are the dock's (components/live/Dock.tsx). */
type Tab = 'layers' | 'add';
const ARRANGE_KEY = 'wanigan.live.arrange';
const readArrange = (): boolean => { try { return localStorage.getItem(ARRANGE_KEY) !== '0'; } catch { return true; } };
type Width = 'full' | 'tablet' | 'phone';
/** Narrowest first, as Compare lists them: 1, 2 and 3 are the same widths there. */
const WIDTHS: Record<Width, { px: number | null; label: string; icon: 'desktop' | 'tablet' | 'phone'; compare: CompareWidth; key: string }> = {
  phone: { px: 390, label: 'Phone, 390 pixels wide', icon: 'phone', compare: 390, key: '1' },
  tablet: { px: 768, label: 'Tablet, 768 pixels wide', icon: 'tablet', compare: 768, key: '2' },
  full: { px: null, label: 'Full width', icon: 'desktop', compare: 1440, key: '3' },
};

type Banner =
  | { kind: 'outlined'; file: string; count: number }
  | { kind: 'not-here'; file: string }
  | { kind: 'elsewhere'; file: string }
  | { kind: 'waiting'; file: string }
  | { kind: 'reloaded' }
  | { kind: 'content'; cms: string }
  | { kind: 'restless' }
  /** A write read back after its reload, or what the site's AI did during it: `warn` when it needs the owner. */
  | { kind: 'write'; text: string; warn: boolean };

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
    case 'write': return n.text;
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
  const [hasScript, setHasScript] = useState(true);
  const [tab, setTab] = useState<Tab>('layers');
  const [width, setWidth] = useState<Width>('full');
  const [changed, setChanged] = useState<ReadonlySet<number>>(new Set());
  const [problems, setProblems] = useState<LiveProblem[] | null>(null);
  // A hosted environment (Dev, Test, Live) in place of the local site: read-only, and it does not follow the agents.
  const envData = useEnvs(project.id, !compact);
  const envs = envData?.envs ?? [];
  const [envId, setEnvId] = useState<string | null>(null);
  const env = envs.find((e) => e.id === envId) ?? null;
  const hostedRef = useRef<string | null>(null);
  hostedRef.current = env?.id ?? null;
  /** The page the stage opens: the site's address, or the same page on the environment switched to. */
  const [stageUrl, setStageUrl] = useState(url);
  const [comparing, setComparing] = useState(false);
  /** The component library takes the side panel while it is open; so does the design layer's tray. */
  const [library, setLibrary] = useState(false);
  const [tray, setTray] = useState(false);
  const layer = useLayer(project.id, !env && !compact);
  const layerLoaded = useRef(layer.loaded);
  layerLoaded.current = layer.loaded;
  /** What the chosen part's verbs do, and what opens the lens list: for the keys. */
  const verbs = useRef<InspectorVerbs | null>(null);
  const lensOpen = useRef<(() => void) | null>(null);
  const queue = useRef<{ paths: Set<string>; timer: number | null }>({ paths: new Set(), timer: null });
  /** Files to outline once the load in flight has finished. */
  const outlineAfterLoad = useRef<string[] | null>(outlineFirst);
  const late = useRef<{ timer: number | null; seen: number; tries: number }>({ timer: null, seen: -1, tries: 0 });
  const root = site.servedPath ?? project.path;
  const components = useMemo(() => new Map((siteParts.data?.components ?? []).map((c) => [c.id, c])), [siteParts.data]);
  const componentNames = useMemo(() => new Map([...components].map(([id, c]) => [id, c.name])), [components]);
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
  // Every write is read back once the page reloads with it (live/write-checks.ts).
  const traceIdRef = useRef<string | null>(null);
  traceIdRef.current = traceData?.id ?? null;
  const currentTraceId = useCallback(() => traceIdRef.current, []);
  const sayWrite = useCallback((text: string, warn: boolean, toastIt: boolean): void => {
    setBanner({ kind: 'write', text, warn });
    if (toastIt) toast(text, warn ? 'error' : 'info');
  }, [toast]);
  /** Until when the site's change counter moving is the live view's own write, not someone else's. */
  const ownWriteUntil = useRef(0);
  const wrote = useCallback(() => { ownWriteUntil.current = Date.now() + 8_000; }, []);
  const checks = useWriteChecks({ live, scan: scanned, traceId: currentTraceId, say: sayWrite, written: wrote });
  /** What an edit sheet's parts showed when it opened: the save is read back against it. */
  const editCheck = useRef<Promise<WriteCheck> | null>(null);
  const arrange = useArrange({
    project, platform: site.platform, trace: traceData, parts, regions, layers, page: view?.url ?? url, checks,
    enabled: hasScript && !compact && !picking && !editing && !view?.loading && !view?.error, handles: arrangeOn,
    onSaved: (label) => setSaved((was) => ({ ...was, parts: new Set([...was.parts, label.replace(/^(Moved|Added) /, '').split(',')[0] as string]) })),
  });
  const helperSite = site.platform === 'drupal' || site.platform === 'wordpress';
  const fetchTrace = useCallback(async (): Promise<void> => {
    if (!helperSite) { setTrace(null); return; }
    // A helper another Wanigan set up says so, rather than that there is none.
    if (!site.helper || !site.token) { setTrace(site.found ? { state: 'other' } : { state: 'no-helper' }); return; }
    const answer = await live.trace();
    setTrace(answer);
    await checks.traced(answer);
  }, [live, helperSite, site.helper, site.token, checks]);
  // The site's AI as its core reports it, read once the helper has traced a page (the view is up by then).
  const [siteAi, setSiteAi] = useState<LiveSiteAiAnswer | null>(null);
  const readSiteAi = useCallback((): void => { void live.siteAi().then(setSiteAi); }, [live]);
  useEffect(() => { setSiteAi(null); }, [site.token]);
  useEffect(() => { if (trace?.state === 'ok' && !siteAi && !envId) readSiteAi(); }, [trace?.state, siteAi, envId, readSiteAi]);
  // Go to: Shift+Space here or in the page, and the address field (components/live/GoTo.tsx). The page answers the
  // live view's own keys the same way (P picks…); `runKey` is what they do.
  const runKey = useRef<(id: LiveKeyId) => void>(() => {});
  const goTo = useGoToKeys(project.id, (id) => runKey.current(id));
  const sender = useNotesSender(project, components, follow);
  const sendAll = useRef(sender.sendAll);
  sendAll.current = sender.sendAll;

  useEffect(() => { void live.hasScript().then(setHasScript); }, [live]);
  useEffect(() => { setOnly(null); }, [lens]);
  // What needs the page itself (picking, placing, an edit sheet beside a part) brings it back from Compare.
  useEffect(() => { if (picking || editing || arrange.placing) setComparing(false); }, [picking, editing, arrange.placing]);

  // Escape, in the window or in the page, takes a lens away (and stops placing a palette entry).
  useEffect(() => {
    if (lens === 'structure' && !arrange.placing) return undefined;
    const back = (): void => { setLens('structure'); arrange.setPlacing(null); };
    const key = (e: KeyboardEvent): void => {
      // Compare's Escape is its own: it goes back to the page, the lens with it.
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('.scrim, .live-sheet, .live-stage-compare')) return;
      const t = e.target as Element | null;
      if (t?.closest?.('input, textarea, select, .sel-list') || (t && t !== document.body && !t.closest?.('.live, .live-docked'))) return;
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
    const next: Selection | null = kept && (region || (!reloaded && kept.pick)) ? { region, pick: reloaded ? null : kept.pick, how: reloaded ? 'tree' : kept.how } : null;
    setSelection(next);
    // The part stays chosen through a reload, and its element stands for it again: what can be done to it stays the same.
    if (next?.region && !next.pick) {
      const at = next.region.index;
      void live.choose(at).then((p) => { if (p) setSelection((s) => (s?.region?.index === at && !s.pick ? { ...s, pick: p } : s)); }).catch(() => {});
    }
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
    if (s.projectId !== project.id || (s.env ?? null) !== hostedRef.current) return;
    setView(s);
    if (s.loading) { setProblems(null); setTrace((t) => (t ? { state: 'none' } : t)); checks.loading(); return; }
    if (!s.error) {
      const wanted = outlineAfterLoad.current;
      outlineAfterLoad.current = null;
      void scanAndOutline(wanted ?? [], true).then(() => { watchLate(); void fetchTrace(); layerLoaded.current(); return refreshProblems(); });
    }
  }), [live, project.id, scanAndOutline, watchLate, refreshProblems, fetchTrace, checks]);

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
    if (event !== 'live' || hostedRef.current) return;
    const e = data as LiveEvent;
    // A session's view follows that session, and the owner's own saves in the code editor (no session).
    if (e.projectId !== project.id || (follow && e.sessionId !== null && e.sessionId !== follow)) return;
    if (e.kind === 'turn-start') { if (e.sessionId) edited.current.delete(e.sessionId); return; }
    if (e.kind !== 'edit' && e.kind !== 'turn-end') return;
    const q = queue.current;
    if (e.kind === 'edit') {
      const inside = e.paths.filter((p) => p === root || p.startsWith(`${root}/`));
      if (!inside.length) { setBanner({ kind: 'elsewhere', file: fileName(e.paths[0] ?? '') }); return; }
      if (!following) { setBanner({ kind: 'waiting', file: fileName(inside[0] as string) }); return; }
      if (e.sessionId) edited.current.add(e.sessionId);
      for (const p of inside) q.paths.add(p);
    } else {
      const reloadedForEdits = !!e.sessionId && edited.current.delete(e.sessionId);
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
    if (hostedRef.current) return;
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
    if (!site.helper || !site.token || !following || env) return;
    let last: number | null = null;
    let recent: number[] = [];
    let stopped = false;
    const timer = window.setInterval(() => {
      if (stopped || queue.current.timer !== null) return;
      void live.helperChanged().then((n) => {
        if (n === null || n < 0) return;
        // The live view's own write moved the counter: that page reloaded already, and its read-back is said.
        if (Date.now() < ownWriteUntil.current) { last = n; return; }
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
  }, [site.helper, site.token, site.platform, following, live, env]);

  useEffect(() => () => {
    const t = queue.current.timer;
    if (t !== null) window.clearTimeout(t);
    if (late.current.timer !== null) window.clearTimeout(late.current.timer);
  }, []);

  /** Pick on the page, from the chosen part when there is one (else the page's main content), so the keyboard can walk at once. */
  const pick = async (): Promise<void> => {
    if (picking) { await live.cancelPick(); return; }
    setPicking(true);
    await live.disarm();
    const p = await live.pick(selected.current?.region?.index ?? null);
    setPicking(false);
    if (!p) return;
    setTab('layers');
    setLibrary(false);
    setTray(false);
    setSelection({ region: p.regions[0] ?? null, pick: p, how: 'pick' });
    const inner = p.regions[0];
    if (inner) await live.outline([inner.index], labelOf(inner), 'edit'); else await live.clear();
    // The keyboard comes back to the window, to the part's details: Alt+arrows move it from there, and E M . ⇧A act on it.
    await live.focusWindow();
    window.requestAnimationFrame(() => document.querySelector<HTMLElement>('.live-inspector .live-side-title')?.focus());
  };

  const openEdit = (target: EditTarget, region: LiveRegion | null): void => {
    setEditing({ target, region });
    // What the parts it changes show now: the page does not change while the sheet is open over it.
    const shown = [...parts.parts.values()].filter((p) => p.edits?.includes(target.id)).flatMap((p) => parts.regionsOf.get(p.id) ?? []);
    const watched = regions.filter((r) => shown.includes(r.index) || (!shown.length && region?.index === r.index));
    editCheck.current = checks.prepare(target.via === 'schema' ? 'edit' : 'form', target.label, watched,
      target.via === 'schema' ? { id: target.id, sent: undefined, old: target.value } : undefined);
  };
  const editSaved = (target: EditTarget, revision: string | null, ai: SaveAi | null = null, sent: unknown = undefined): void => {
    setEditing(null);
    setSaved((was) => ({ ...was, ids: new Set([...was.ids, target.id]), labels: new Set([...was.labels, target.label]) }));
    toast(`Saved ${target.label}${revision ? `, as revision ${revision}` : ''}. Reloading to check the page shows it.`);
    const prepared = editCheck.current;
    editCheck.current = null;
    if (prepared) void prepared.then((c) => checks.settle(c.target ? { ...c, target: { ...c.target, sent } } : c, { ok: true, ai }));
  };
  // A site's own form that saved without leaving the page (WordPress's block editor): the page reloaded when it closed.
  useEffect(() => live.onEdited((e) => {
    if (!e.changed) return;
    const prepared = editCheck.current;
    editCheck.current = null;
    setSaved((was) => ({ ...was, labels: new Set([...was.labels, e.label]) }));
    if (prepared) void prepared.then((c) => checks.settle(c, { ok: true }));
    else setBanner({ kind: 'write', text: `${site.platform === 'wordpress' ? 'WordPress' : 'Drupal'} saved changes while its form was open: reloaded.`, warn: false });
  }), [live, checks, site.platform]);
  const point = (indexes: number[] | null): void => { if (indexes) void live.outline(indexes.slice(0, 200), null, 'hover'); else hover(null); };
  const flipArrange = (): void => {
    setArrangeOn((v) => {
      try { localStorage.setItem(ARRANGE_KEY, v ? '0' : '1'); } catch { /* lasts this window */ }
      return !v;
    });
  };

  /**
   * Choose a part from the tree (or the crumbs). Its element becomes the
   * picked one, so it offers what a pick offers: retyping its words, trying a
   * style. How a part was chosen does not change what can be done to it.
   */
  const select = (region: LiveRegion): void => {
    setLibrary(false);
    setTray(false);
    setTab('layers');
    setSelection({ region, pick: null, how: 'tree' });
    void live.outline([region.index], labelOf(region), 'edit');
    void live.choose(region.index).then((p) => {
      if (p) setSelection((s) => (s?.region?.index === region.index && !s.pick ? { ...s, pick: p } : s));
    }).catch(() => {});
  };
  const hover = (list: LiveRegion[] | null, label: string | null = null): void => {
    if (list) { void live.outline(list.map((r) => r.index), label, 'hover'); return; }
    const kept = selection?.region;
    if (kept) void live.outline([kept.index], labelOf(kept), 'edit'); else void live.clear();
  };
  const unselect = (): void => { setSelection(null); void live.clear(); };
  /** Back to the tree alone: the keyboard goes to the tree's row for the part when it was on the part's details. */
  const backToTree = (): void => {
    const fromPart = !!document.activeElement?.closest('.live-split-part');
    unselect();
    if (fromPart) focusTree();
  };
  const treeBeside = useTreeBeside();
  const showNote = (n: LiveNote | null): void => {
    const r = n?.regions[0];
    const same = r ? regions.filter((x) => sameRegion(r, [r], [x])) : [];
    if (same.length === 1) void live.outline([same[0]!.index], null, 'hover'); else hover(null);
  };
  /** The tray of the design layer's edits, in the side panel in place of the library. */
  const openTray = (open: boolean): void => {
    setTray(open);
    if (open) setLibrary(false);
  };

  /** Show the same page on another environment (null: the local site). */
  const switchTo = (next: string | null): void => {
    const to = envs.find((e) => e.id === next) ?? null;
    setStageUrl(samePage(view?.url ?? stageUrl, env?.url ?? url, to?.url ?? url));
    setEnvId(to?.id ?? null);
    setSelection(null);
    setRegions([]);
    setBanner(null);
  };
  // Go to opens the same path on the environment shown, as the address field always did.
  useEffect(() => {
    let origin: string | null = null;
    try { origin = env ? new URL(env.url).origin : null; } catch { origin = null; }
    showingOrigin(project.id, origin);
    return () => showingOrigin(project.id, null);
  }, [project.id, env]);

  const errors = problems?.length ?? 0;
  /** The view shows one piece alone (the helper's page), and which kind. */
  const alone = (() => {
    try { return /^\/_wanigan\/piece\/([a-z]+)\//.exec(new URL(view?.url ?? '').pathname)?.[1] ?? null; } catch { return null; }
  })();
  const tabs: { value: Tab; label: string; hint?: string }[] = [
    { value: 'layers', label: 'Layers' },
    ...(traceData?.palette?.length ? [{ value: 'add' as const, label: 'Add', hint: 'What the site can add to this page' }] : []),
  ];
  const shownTab: Tab = tabs.some((t) => t.value === tab) ? tab : 'layers';
  /** The live view's tabs in the dock beneath the page, beside Code. */
  const docked: { id: LiveDockTab; label: string; hint?: string }[] = [
    { id: 'notes', label: notes.length ? `Notes ${notes.length}` : 'Notes' },
    { id: 'problems', label: errors ? `Problems ${errors}` : 'Problems' },
    ...(helperSite ? [{ id: 'request' as const, label: 'Request', hint: 'The hooks, queries, assets and logs behind this page' }] : []),
  ];
  const cms = site.platform === 'wordpress' ? 'WordPress' : 'Drupal';
  const compare = envs.length
    ? { can: !view?.loading, why: 'Wait for the page to load', with: env?.name ?? envs[envs.length - 1]?.name ?? null }
    : {
      can: false, with: null,
      why: envData?.candidates.length ? `${envData.candidates.length} hosted environments are named in the project’s files: keep one in Site settings to compare with it`
        : 'Add a hosted environment (Dev, Test, Live) in Site settings to compare with it',
    };
  const openCompare = (): void => {
    if (compare.can) setComparing(true); else toast(`${compare.why}.`);
  };
  const shot = useShotPage(card && shots && !env ? card : null, view?.url ?? null);

  // The live view's own keys (shared/live-keys.ts), here and from the page: each does what its control does. While
  // Compare is drawn, 1 2 3 are its widths.
  runKey.current = (id: LiveKeyId): void => {
    switch (id) {
      case 'pick': if (hasScript) void pick(); return;
      case 'lens': if (!compact && hasScript) lensOpen.current?.(); return;
      case 'width-phone': if (!compact && !comparing) setWidth('phone'); return;
      case 'width-tablet': if (!compact && !comparing) setWidth('tablet'); return;
      case 'width-full': if (!compact && !comparing) setWidth('full'); return;
      case 'tab-previous':
      case 'tab-next': {
        if (compact) return;
        setLibrary(false);
        setTray(false);
        const at = tabs.findIndex((t) => t.value === shownTab);
        const next = tabs[(at + (id === 'tab-next' ? 1 : -1) + tabs.length) % tabs.length];
        if (next) setTab(next.value);
        return;
      }
      case 'dock-previous':
      case 'dock-next':
        if (!compact) stepDock(id === 'dock-next' ? 1 : -1);
        return;
      case 'compare': if (!compact) { if (comparing) setComparing(false); else openCompare(); } return;
      case 'library': if (!compact) { setTray(false); setLibrary(!library); } return;
      case 'edits': if (!compact) openTray(!tray); return;
      case 'edit':
      case 'move':
      case 'code':
      case 'alone':
      case 'take-out':
        if (compact) return;
        if (!selected.current || shownTab !== 'layers' || library || tray) { toast('Choose a part first: P picks one on the page, or choose it in Layers.'); return; }
        verbs.current?.[id]();
    }
  };
  // In the window: while the live view (or nothing) has the keyboard, nothing is typed into, and nothing is open over it.
  useEffect(() => {
    const mac = bridge().platform === 'darwin';
    let afterG = 0;
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.repeat || e.isComposing) return;
      const t = e.target instanceof Element ? e.target : null;
      // The live view, and its tabs in the dock beneath the page.
      if (!t || !(t === document.body || t.closest('.live, .live-docked, .dock-tabs'))) return;
      if (t.closest('.live-sheet') || document.querySelector('[aria-modal="true"], .sel-list')) return;
      const typing = isTyping(t) && !(t instanceof HTMLInputElement && /^(checkbox|radio|button|submit|reset)$/.test(t.type));
      if (isSendKey(e, mac)) {
        // In the note box it sends that note (Notes.tsx); anywhere else, the notes waiting.
        if (!typing) { e.preventDefault(); void sendAll.current(); }
        return;
      }
      if (typing) return;
      // G then a letter goes somewhere (the window's own keys): that letter is not the live view's.
      if (e.key === 'g' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) { afterG = Date.now(); return; }
      if (Date.now() - afterG < 1200) { afterG = 0; return; }
      const id = liveKey(e);
      if (!id) return;
      // In Compare its own keys work, and ⇧C goes back to the page; the page's keys wait for the page.
      if (t.closest('.live-stage-compare') && id !== 'compare') return;
      e.preventDefault();
      runKey.current(id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /** The one line under the page that says what is going on: what was just done, or the state the view is in. */
  const status: { text: ReactNode; className?: string; action?: ReactNode; warn?: boolean } | null = arrange.placing ? {
    className: 'live-placing',
    text: <>Placing <strong>{arrange.placing.label}</strong>: the page shows where it would go. Click there to add it; Escape stops.</>,
    action: <IconButton icon="close" label="Stop placing (Escape)" onClick={() => arrange.setPlacing(null)} />,
  } : picking ? {
    text: 'Picking: point at a part, or walk with ↑ ↓ ← → and press Enter. P or Escape stops.',
  } : comparing && envs.length ? {
    className: 'live-comparing',
    text: 'Comparing. The page waits under it as it was.',
    action: <Button size="s" tone="quiet" icon="back" onClick={() => setComparing(false)}>Back to the page</Button>,
  } : alone ? {
    className: 'live-alone',
    text: `Showing one piece alone${alone === 'sample' || alone === 'component' ? ', with sample content' : ''}.`,
    action: <Button size="s" tone="quiet" icon="back" onClick={() => void live.back()}>Back to the page</Button>,
  } : env ? {
    className: 'live-hosted',
    text: <><strong>{env.name}</strong> is read-only here: point at parts and tell an agent, but nothing in this view can change it, and it does not follow the agents’ edits. <span className="faint">{HOSTED_NOTE}</span></>,
  } : banner ? {
    // A later notice (a file changed, a write) is said even while the layer is off, and the layer's switch stays at hand.
    text: layer.on ? bannerText(banner) : <>{bannerText(banner)} <span className="faint">Showing the page without the design layer.</span></>,
    warn: banner.kind === 'write' && banner.warn,
    action: layer.on ? undefined : <Button size="s" tone="quiet" icon="eye" onClick={() => layer.show(true)}>Show the layer</Button>,
  } : !layer.on ? {
    className: 'live-layer-off',
    text: 'Showing the page without the design layer: as the site renders it, without your edits.',
    action: <Button size="s" tone="quiet" icon="eye" onClick={() => layer.show(true)}>Show the layer</Button>,
  } : null;
  const keysNow: [string[], string][] = picking ? []
    : comparing && envs.length && !compact ? [[['J', 'K'], 'changes'], [['S', 'O', 'D', 'T'], 'how'], [['1', '2', '3'], 'width'], [['Esc'], 'back to the page']]
    : library && !compact ? [[['P'], 'pick'], [['Esc'], 'back'], [['⇧', 'B'], 'close the library']]
    : tray && !compact ? [[['P'], 'pick'], [['Esc'], 'back'], [['⇧', 'E'], 'close the edits']]
    : selection && shownTab === 'layers' && !compact ? [[['E'], 'edit'], [['M'], 'move'], [['.'], 'code'], [['⇧', 'A'], 'alone'], [['⇧', 'X'], 'take out'], [['P'], 'pick'], [['Esc'], 'back']]
      : [[['P'], 'pick'], [['⇧', 'Space'], 'go to'], [['⇧', 'L'], 'lens'], [['1', '2', '3'], 'width'], [['[', ']'], 'tabs'], [['⇧', '[', ']'], 'dock'], [['?'], 'all keys']];

  return (
    <div className={`live${compact ? ' live-compact' : ''}`}>
      <div className="live-bar" role="group" aria-label="Live view">
        <div className="live-bar-group live-bar-site" role="group" aria-label="The site">
          <SiteMenu envs={compact ? [] : envs} shown={env} onShow={switchTo} compare={compare} onCompare={openCompare} onSettings={onEdit} compact={compact} />
        </div>
        <div className="live-bar-group live-bar-page" role="group" aria-label="The page">
          <IconButton icon="back" label="Back" disabled={!view?.canGoBack} onClick={() => void live.back()} />
          <IconButton icon="chevron" label="Forward" disabled={!view?.canGoForward} onClick={() => void live.forward()} />
          <IconButton icon="refresh" label={view?.loading ? 'Loading…' : 'Reload (hold Shift to skip the cache)'}
            onClick={(e) => void live.reload(e.shiftKey)} data-loading={view?.loading ? '' : undefined} />
          <AddressField projectId={project.id} url={view?.url ?? (env ? env.url : stageUrl)} title={view?.title ?? null} onOpen={goTo} />
          <div className="live-widths" role="group" aria-label="Width">
            {(Object.keys(WIDTHS) as Width[]).map((w) => (
              <IconButton key={w} icon={WIDTHS[w].icon} label={`${WIDTHS[w].label} (${WIDTHS[w].key})`} aria-keyshortcuts={WIDTHS[w].key}
                aria-pressed={width === w} data-on={width === w ? '' : undefined} onClick={() => setWidth(w)} />
            ))}
          </div>
          {!compact ? <LensPicker lens={lens} onChange={setLens} disabled={!hasScript} openRef={lensOpen} /> : null}
        </div>
        <div className="live-bar-group live-bar-tools" role="group" aria-label="Tools">
          {/* Named by aria-label too: in a narrow bar the names give way to the icons (live.css), never the accessible name. */}
          <Button size="s" tone={picking ? 'primary' : 'quiet'} icon="pick" onClick={() => void pick()} disabled={!hasScript} aria-keyshortcuts="P"
            aria-label={picking ? 'Picking… (P or Escape stops)' : 'Pick (P)'}
            title={hasScript ? 'Point at something on the page to see what made it, or walk the page with the arrows: Enter picks, P or Escape stops (P)' : 'This build of Wanigan has no page script'} aria-pressed={picking}>
            <span className="live-tool-name">{picking ? 'Picking…' : 'Pick'}</span><kbd className="live-key" aria-hidden="true">P</kbd>
          </Button>
          {!compact ? (
            <Button size="s" tone={library ? 'primary' : 'quiet'} icon="pieces" onClick={() => setLibrary(!library)} aria-keyshortcuts="Shift+B" aria-pressed={library}
              aria-label="Library (⇧B)" title="The site’s component library: what it can place, pictured, and added to the page from there (⇧B)">
              <span className="live-tool-name">Library</span><kbd className="live-key" aria-hidden="true">⇧B</kbd>
            </Button>
          ) : null}
          {!compact ? (
            <Button size="s" tone={tray ? 'primary' : 'quiet'} icon="brush" onClick={() => openTray(!tray)} aria-keyshortcuts="Shift+E" aria-pressed={tray}
              aria-label={`Edits${layer.drafts ? `, ${layer.drafts} ${layer.drafts === 1 ? 'draft' : 'drafts'}` : ''}: the design layer (⇧E)`}
              title="Your edits to the page, kept in Wanigan’s design layer: made real in the site and verified from here (⇧E)">
              <span className="live-tool-name">Edits</span>{layer.drafts ? <span className="live-layer-count" aria-hidden="true">{layer.drafts}</span> : null}<kbd className="live-key" aria-hidden="true">⇧E</kbd>
            </Button>
          ) : null}
          <MoreMenu compact={compact} arrangeOn={arrangeOn} canArrange={hasScript} onArrange={flipArrange} onBrowser={() => void live.open()} shot={shot} />
        </div>
      </div>
      {!compact ? (
        <LensStrip view={lensed} only={only} onOnly={setOnly} onHover={point} onClose={() => setLens('structure')}
          note={<TraceNote compact answer={trace} site={site} project={project} />} />
      ) : null}
      <div className="visually-hidden" role="status" aria-live="polite">{arrange.said}</div>
      {arrange.asking}
      <div className="live-main">
        <LiveStage project={project} url={env || sameSite(stageUrl, url) ? stageUrl : url} token={env ? null : site.token} env={env?.id ?? null} view={view} width={WIDTHS[width].px}
          onReload={() => void live.reload(true)} onEdit={onEdit} stageRef={stageRef} deviceRef={deviceRef}>
          {/* A hosted environment is read-only: no edit sheet opens over it. */}
          {editing && !env ? (
            <EditSheet request={editing} stage={stageRef} device={deviceRef} cms={cms} onClose={() => setEditing(null)} trace={traceData} onSaved={editSaved} />
          ) : null}
          {/* Compare, where the page is: the page waits under it, as it was. */}
          {comparing && envs.length && !compact ? (
            <ComparePanel project={project} site={site} envs={envs} masks={envData?.masks ?? []} page={view?.url ?? stageUrl} shownEnv={env?.id ?? null}
              width={WIDTHS[width].compare} components={componentNames} onClose={() => setComparing(false)} />
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
              {selection.region?.file && siteParts.data?.docroot && relativeTo(project.path, `${siteParts.data.docroot}/${selection.region.file}`) ? (
                <IconButton icon="code" label="Edit its template in the code editor"
                  onClick={() => openInEditor({ projectId: project.id, path: relativeTo(project.path, `${siteParts.data!.docroot}/${selection.region!.file}`) as string, find: selection.pick?.text ?? null })} />
              ) : null}
              <IconButton icon="close" label="Clear the pick" onClick={unselect} />
            </div>
          ) : null
        ) : (
          <aside className={`live-side${library || tray ? ' wide' : ''}${!library && !tray && shownTab === 'layers' && selection ? ' with-part' : ''}`}
            aria-label={tray ? 'The design layer’s edits' : library ? 'The site’s component library' : 'What is on this page'}>
            {tray ? (
              <LayerTray project={project} layer={layer} page={env ? '' : pagePath(view?.url ?? url)} siteUrl={url} trace={env ? null : traceData} parts={parts} regions={regions}
                components={components} prefer={follow} readOnly={!!env} onClose={() => setTray(false)} onReload={() => { outlineAfterLoad.current = []; void live.reload(); }} />
            ) : library ? (
              <LibraryPanel project={project} site={site} trace={env ? null : traceData} parts={parts} regions={regions} arrange={arrange} readOnly={!!env}
                onClose={() => setLibrary(false)} onSelect={select} onHover={hover} />
            ) : (<>
            {tabs.length > 1 ? <Segmented<Tab> size="s" label="Show" value={shownTab} options={tabs} onChange={setTab} /> : null}
            {shownTab === 'layers' ? (
              // The tree stays with a chosen part: above its details, folded to its branch, or beside them when there is room.
              <LayersPane onBack={backToTree}
                part={selection ? (
                  <Inspector project={project} platform={site.platform} selection={selection} regions={regions} components={components} docroot={siteParts.data?.docroot ?? null}
                    theme={theme} page={view?.url ?? url} prefer={follow} helper={!!site.helper && !env} readOnly={!!env} onSelect={select} onClose={backToTree}
                    site={site} answer={env ? null : trace} trace={env ? null : traceData} parts={parts} arrange={arrange} onEdit={openEdit} verbs={verbs}
                    siteAi={env ? null : siteAi} onSiteAiRefresh={readSiteAi} layer={layer} onTray={() => openTray(true)} />
                ) : null}
                // A helper another Wanigan set up ignores this one: said first, where the owner looks, with the way out.
                before={!env && trace?.state === 'other' ? <TraceNote answer={trace} site={site} project={project} /> : null}
                tree={regions.length ? (
                  <Layers regions={regions} components={components} selected={selection?.region?.index ?? null} fold={!!selection && !treeBeside}
                    changed={changed} onHover={hover} onSelect={select} partName={partName} />
                ) : (
                  <NothingMarked platform={env ? null : site.platform} loading={!!view?.loading} hosted={!!env} />
                )}
                after={env || trace?.state === 'other' ? null : <HelperOffer site={site} project={project} />} />
            ) : (
              <PaletteTab arrange={arrange} trace={traceData} />
            )}
            </>)}
          </aside>
        )}
      </div>
      {/* Notes, Problems and Request, in the dock beneath the page beside the code editor. */}
      {!compact ? (
        <LiveDock tabs={docked}>
          {(t) => (t === 'notes' ? (
            <>
              <NotesTab project={project} components={components} sender={sender} onShow={showNote} />
              <EditsList project={project} layer={layer.snapshot} />
            </>
          ) : t === 'problems' ? (
            <ProblemsTab problems={problems} project={project} url={view?.url ?? url} onRefresh={() => void refreshProblems()} />
          ) : (
            <RequestTab answer={trace} site={site} project={project} parts={parts} onPoint={point} />
          ))}
        </LiveDock>
      ) : null}
      {!compact ? (
        <div className="live-status">
          {status ? (
            <span className={`live-status-said${status.className ? ` ${status.className}` : ''}${status.warn ? ' warn' : ''}`} role={status.warn ? 'alert' : 'status'}>
              <Icon name={env && !alone && !picking && !arrange.placing ? 'open' : 'live'} size={14} />
              <span className="live-status-text">{status.text}</span>
              {status.action}
            </span>
          ) : <span className="live-status-said" role="status" />}
          <span className="live-status-where faint">
            {site.platform === 'drupal' ? 'Drupal' : site.platform === 'wordpress' ? 'WordPress' : 'Site'} · {env ? `${env.name}, read-only` : follow ? 'following this session' : `following every session in ${project.name}`}
          </span>
          {keysNow.length ? (
            <span className="live-status-keys faint" aria-label="Keys that work now">
              {keysNow.map(([keys, what]) => <span key={what}>{keys.map((k) => <kbd key={k}>{k}</kbd>)} {what}</span>)}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Where a page is typed: it shows the page the view is on, and opens Go to
 * over itself, with that address chosen (typing replaces it; Enter goes
 * there), or with what was typed into it. Shift+Space and ⌘⇧Space open it too.
 */
function AddressField({ projectId, url, title, onOpen }: {
  projectId: string; url: string; title: string | null;
  onOpen: (from?: { address?: string | null; query?: string | null }) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => (ref.current ? anchorGoTo(projectId, ref.current) : undefined), [projectId]);
  const parts = (() => { try { const u = new URL(url); return { host: u.host, path: `${u.pathname}${u.search}` }; } catch { return { host: '', path: url }; } })();
  return (
    <button ref={ref} type="button" className="live-address" aria-haspopup="dialog" aria-keyshortcuts="Shift+Space"
      aria-label={`Go to a page of ${parts.host || 'the site'}, or type its address. Shown: ${url}`} title={title ? `${title} · ${url}` : url}
      onClick={() => onOpen({ address: url })}
      onKeyDown={(e) => {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        // Space opens it as a click does; Shift+Space opens Go to with nothing typed, as it does anywhere in the view.
        if (e.key === ' ') { e.preventDefault(); onOpen(e.shiftKey ? {} : { address: url }); return; }
        // Typing into the field starts the search.
        if (e.key.length === 1) { e.preventDefault(); onOpen({ query: e.key }); }
      }}>
      <Icon name="search" size={14} />
      <span className="live-address-text mono">
        <span className="live-address-host">{parts.host}</span>
        <span className="live-address-path">{parts.path}</span>
      </span>
      <span className="live-address-hint" aria-hidden="true">Type a title, path or id <kbd>⇧</kbd><kbd>Space</kbd></span>
    </button>
  );
}

/** What is used rarely, in one menu at the end of the bar: dragging parts, the default browser, a card's before and after. */
function MoreMenu({ compact, arrangeOn, canArrange, onArrange, onBrowser, shot }: {
  compact: boolean; arrangeOn: boolean; canArrange: boolean; onArrange: () => void; onBrowser: () => void; shot: MenuItem | null;
}) {
  const items: MenuItem[] = [];
  if (!compact) {
    items.push({
      id: 'drag', kind: 'check', checked: arrangeOn, disabled: !canArrange, label: 'Drag handles on the page',
      detail: arrangeOn ? 'A handle shows on the part under the pointer, to move it by dragging' : 'Off: parts move from their details (Move) instead', run: onArrange,
    });
  }
  items.push({ id: 'browser', icon: 'open', label: 'Open in the default browser', detail: 'This page, without the helper’s token', run: onBrowser });
  if (shot) items.push(shot);
  return (
    <MenuButton className="btn-quiet btn-icon live-more" label="More: drag handles, the default browser, before and after" items={items} align="end" width={320}>
      <Icon name="more" />
    </MenuButton>
  );
}

/** Which page a card's before and after are of, as a switch in the More menu: the site's address unless the owner chose this one. */
function useShotPage(card: { id: string; key: string } | null, page: string | null): MenuItem | null {
  const toast = useToast();
  const chosen = useQuery('live.page', card ? { cardId: card.id } : null, ['liveShots']);
  if (!card) return null;
  const here = !!page && chosen.data?.url === page;
  const flip = async (): Promise<void> => {
    if (!page) return;
    const done = await attempt(() => call('live.setPage', { cardId: card.id, url: here ? null : page }), (m) => toast(m, 'error'));
    if (!done) return;
    void chosen.reload();
    toast(here ? `${card.key}’s screenshots are of the site’s own address again.` : `${card.key}’s before and after will be of this page.`);
  };
  return {
    id: 'shots', kind: 'check', checked: here, icon: 'camera', disabled: !page,
    label: `${card.key}’s before and after of this page`, detail: here ? 'On: off goes back to the site’s own address' : 'Off: they are of the site’s own address',
    run: () => void flip(),
  };
}

function selectionTitle(s: Selection, components: Map<string, { name: string }>): string {
  const r = s.region;
  if (!r) return s.pick?.tag ?? 'Part';
  return r.component ? components.get(r.component)?.name ?? r.component : r.file ? fileName(r.file) : r.entity ?? r.block ?? r.view ?? 'Part';
}

function NothingMarked({ platform, loading, hosted = false }: { platform: LivePlatform | null; loading: boolean; hosted?: boolean }) {
  if (loading) return <p className="faint small live-side-block">Loading the page…</p>;
  if (hosted) {
    return (
      <div className="live-side-block">
        <p className="small">Nothing on this page says what made it: a hosted site rarely does (its Twig debug is off, and it has no helper). Pick a part to point an agent at it anyway.</p>
      </div>
    );
  }
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

/**
 * The placeholder the app lays its view over. It reports where it is as it
 * moves, steps the view aside while something covers it (showing the last
 * frame instead), narrows to a device's width, and, when the site is not
 * shown, says why: what runs the site is asked as the view opens and again
 * when a page fails, so a site that is not running is said as that, never as
 * the certificate ddev's router answered with.
 */
function LiveStage({ project, url, token, env, view, width, onReload, onEdit, stageRef, deviceRef, children }: {
  project: ProjectSummary; url: string; token: string | null;
  /** A hosted environment's id: shown read-only in its own session. Null: the local site. */
  env: string | null;
  view: LiveViewState | null; width: number | null; onReload: () => void; onEdit: () => void;
  stageRef: RefObject<HTMLDivElement | null>; deviceRef: RefObject<HTMLDivElement | null>;
  /** What sits over the page: an edit sheet beside a part. */
  children?: ReactNode;
}) {
  const live = liveBridge() as NonNullable<ReturnType<typeof liveBridge>>;
  const device = deviceRef;
  const covered = useLiveCovered();
  const [frame, setFrame] = useState<string | null>(null);
  const status = useSiteStatus(project.id);
  const error = view?.error ?? null;
  const host = (() => { try { return new URL(error?.url || view?.url || url).hostname; } catch { return url; } })();
  // When the core could not say (it refused or failed), the failure is still explained, from the certificate alone.
  const known: LiveStatus | null = status.data ?? (status.error ? {
    projectId: project.id, run: { tool: null, state: null, said: null, start: null, folder: project.path, name: null }, hostnames: [], certificates: [], busy: null, checkedAt: 0,
  } : null);
  const trouble = diagnose({ host, status: known, failure: error, httpStatus: view?.loading ? null : view?.status ?? null, now: Date.now() });
  const hidden = covered || !!trouble;

  // A page that failed, or a ddev site that answered with an error page: ask again whether it runs.
  const ddev = status.data?.run.tool === 'ddev';
  const failedAt = error ? `${error.code} ${error.url}` : ddev && (view?.status ?? 0) >= 400 && !view?.loading ? `http ${view?.status} ${view?.url}` : null;
  const reloadStatus = status.reload;
  useEffect(() => { if (failedAt) reloadStatus(); }, [failedAt, reloadStatus]);

  useLayoutEffect(() => {
    const el = device.current;
    if (!el) return;
    const rect = (): { x: number; y: number; width: number; height: number } => {
      const b = el.getBoundingClientRect();
      return { x: b.left, y: b.top, width: b.width, height: b.height };
    };
    void live.show(project.id, url, rect(), token, env);
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
  }, [live, project.id, url, token, env]);

  useEffect(() => {
    let current = true;
    if (hidden) void live.cover(true).then((f) => { if (current && covered) setFrame(f); });
    else { setFrame(null); void live.cover(false); }
    return () => { current = false; };
  }, [hidden, covered, live]);

  return (
    <div className={`live-stage${width ? ' narrow' : ''}`} ref={stageRef}>
      <div className="live-device" ref={device} style={width ? { width } : undefined}>
        {frame && !trouble ? <img className="live-frame" src={frame} alt="" /> : null}
      </div>
      {width ? <span className="live-device-size faint small" aria-hidden="true">{width} px</span> : null}
      {/* A hosted environment's failure is its own: never diagnosed with the local site's ddev status. */}
      {env && error ? <HostedProblem error={error} url={url} onReload={onReload} onEdit={onEdit} /> : null}
      {!env && trouble ? (
        <SiteTrouble trouble={trouble} status={known} projectId={project.id} onReload={onReload} onCheck={reloadStatus}
          onStarted={() => { reloadStatus(); onReload(); }} onEdit={onEdit} />
      ) : null}
      {children}
    </div>
  );
}

/** A hosted environment that did not load: checked as any browser checks it, with no exception made. */
function HostedProblem({ error, url, onReload, onEdit }: { error: NonNullable<LiveViewState['error']>; url: string; onReload: () => void; onEdit: () => void }) {
  const host = (() => { try { return new URL(error.url || url).host; } catch { return url; } })();
  const certificate = /CERT|SSL/i.test(error.description);
  const nobody = /CONNECTION_REFUSED|NAME_NOT_RESOLVED|ADDRESS_UNREACHABLE|CONNECTION_FAILED|TIMED_OUT/i.test(error.description);
  return (
    <div className="live-problem" role="alert">
      <Icon name="alert" size={18} />
      <div>
        <p className="live-problem-title">
          {certificate ? `Chromium does not trust ${host}’s certificate` : nobody ? `Nothing answered at ${host}` : `${host} did not load`}
        </p>
        <p className="small">
          {certificate
            ? 'A hosted environment’s certificate is checked as any browser checks it, and Wanigan makes no exception for it.'
            : nobody ? 'Check the environment’s address in the site settings, and that this Mac is online.' : 'Chromium gave this reason:'}
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
