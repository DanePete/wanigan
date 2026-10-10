// The live view: a project's local site inside Wanigan, following the agents'
// edits, and the editor laid around it (Studio: docs/design/2026-10-10-studio.md,
// "Live (the editor)"). The app lays its own view over the canvas below
// (lib/live.ts); this file decides what to show around it, when to reload, and
// what to outline.
//
// - One toolbar: the site (which environment, Compare and the settings: one
//   menu), the page (back, forward, reload, the address that opens Go to), the
//   tools (Select, Type, Style, Move | Snap, Record, and Voice's place), then the
//   lens, the widths, the layer's eye, Edits and Make real.
// - Structure on the left (components/live/*): Layers, Add (the site's component
//   library, and what the page itself can take) and Pages (Go to's list).
// - The canvas: the page as a sheet on the canvas colour, the chosen part
//   outlined in the page with its name and its action bar, which the page
//   script draws inside the page (live-page.ts): the window cannot draw over it.
// - The Inspector on the right (live/Inspector.tsx): the chosen part's Design,
//   Made by and Data; the Edits panel (live/Tray.tsx) takes its place when
//   opened (⇧E).
// - What just happened is the frame's status line (StatusLine.tsx): outcomes go
//   through toast(), and the view puts the mode it is in (recording, typing,
//   selecting, placing, comparing, read-only, without the layer) and the dock's
//   tabs at its end (StatusSlot). The dock (Notes, Problems, Request, DevTools,
//   Code: live/Dock.tsx) is closed by default and opens from those tabs or keys.
// - Compare, a snap being marked up and a recording's review are drawn on the
//   canvas, where the page is.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react';
import type { LiveRecording, LiveViewState } from '@shared/bridge';
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
import { isSendKey, liveKey, type LiveGesture, type LiveKeyId } from '@shared/live-keys';
import { length } from '@shared/live-record';
import { attempt, bridge, call, forProject, useQuery } from '../lib/api';
import { liveBridge, useLiveCovered } from '../lib/live';
import { anchorGoTo, isTyping, showingOrigin, useGoToKeys } from '../lib/live-goto';
import { navigate } from '../lib/router';
import { actionable, useNotices, type Notice } from '../lib/notices';
import { plural } from '../lib/format';
import { useAppState } from '../lib/settings';
import { liveFor, type AppSettings } from '@shared/settings';
import { Icon } from './icons';
import { MenuButton, type MenuItem } from './Menu';
import { Panel } from './Panel';
import { StatusSlot } from './StatusLine';
import { Tabs, TabPanel, type TabItem } from './Tabs';
import { ToolGroup, ToolSeparator, Toolbar } from './Toolbar';
import { Inspector, type InspectorTool, type InspectorVerbs, type Selection } from './live/Inspector';
import { ComparePanel } from './live/Compare';
import { EnvironmentSettings, HOSTED_NOTE, SiteMenu, useEnvs } from './live/Environments';
import { HelperOffer, HelperSettings } from './live/Helper';
import { Layers } from './live/Layers';
import { DockTabs, LiveDock, type LiveDockTab } from './live/Dock';
import { DevtoolsTab } from './live/DevTools';
import { EditsList, NoteComposer, NotesTab, draftFor, useNotesSender } from './live/Notes';
import { useNotes, type LiveNote } from './live/note-store';
import { ProblemsTab } from './live/Problems';
import { PaletteTab, useArrange } from './live/Arrange';
import { LibraryPanel } from './live/Library';
import { PagesTab } from './live/Pages';
import { SnapPanel, type SnapShot } from './live/Snap';
import { RecordAnnounce, RecordButton, RecordReview, useRecordEscape, useRecorder } from './live/Record';
import { LayerTray } from './live/Tray';
import { useLayer } from './live/use-layer';
import { pagePath } from '../lib/live-layer';
import { EditSheet, type EditRequest } from './live/EditSheet';
import { LensPicker, LensStrip, usePaintLens } from './live/Lenses';
import { RequestTab } from './live/Request';
import { TraceNote } from './live/TraceNote';
import { SiteTrouble, useSiteStatus } from './live/SiteTrouble';
import { useWriteChecks } from './live/write-checks';
import { HowLiveWorks, useHowLiveWorks } from './live/HowLiveWorks';
import { LIVE_TIP } from './live/keys';
import { Button, Count, Empty, EmptyState, IconButton, Segmented, tipProps, useToast } from './ui';
import { openInEditor, relativeTo } from '../editor/EditButton';
import { stepDock } from '../editor/store';
import { devtoolsChord, showInDevtools } from '../lib/live-devtools';
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
    return site.error
      ? <EmptyState icon="alert" title="The site could not be read">{site.error.message}</EmptyState>
      : <div className="live-loading" role="status"><span className="live-loading-sheet" aria-hidden="true" /><span className="visually-hidden">Looking for the site…</span></div>;
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
    <Empty icon="live" title={kindOff && plural ? `The live view is off for ${plural}` : 'The live view is off'}
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
        : 'It shows this project’s local site and reloads it as the agents edit. It loads nothing until you switch it on, here or in Settings › Live view.'}
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
      <div className="live-setup-sheet">
        <h2 className="live-setup-title">Where is {project.name}’s local site?</h2>
        <p className="live-setup-lede">The site you already run on this computer. Wanigan starts nothing and changes nothing in the project to show it.</p>
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
          <p className="faint small">Nothing in the project names a local address (no .ddev folder, WP_HOME, dev script or .lando.yml). Type it below.</p>
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

/** The Structure panel's tabs: the page's parts, what can be added, the site's pages. Notes, Problems and Request are the dock's. */
type Tab = 'layers' | 'add' | 'pages';
const TABS: readonly TabItem<Tab>[] = [{ value: 'layers', label: 'Layers' }, { value: 'add', label: 'Add', keys: LIVE_TIP.add }, { value: 'pages', label: 'Pages' }];
type AddMode = 'library' | 'page';
const ARRANGE_KEY = 'wanigan.live.arrange';
const STRUCTURE_KEY = 'wanigan.live.structure';
const readArrange = (): boolean => { try { return localStorage.getItem(ARRANGE_KEY) !== '0'; } catch { return true; } };
const readOpen = (key: string): boolean => { try { return localStorage.getItem(key) !== '0'; } catch { return true; } };
const keepOpen = (key: string, open: boolean): void => { try { localStorage.setItem(key, open ? '1' : '0'); } catch { /* lasts this window */ } };
/** Under this width the live view shows one side panel at a time, so the page keeps the most room. */
const NARROW_PX = 1040;

type Width = 'full' | 'tablet' | 'phone';
/** Narrowest first, as Compare lists them: 1, 2 and 3 are the same widths there. */
const WIDTHS: Record<Width, { px: number | null; label: string; icon: 'desktop' | 'tablet' | 'phone'; compare: CompareWidth; keys: typeof LIVE_TIP.phone }> = {
  phone: { px: 390, label: 'Phone, 390 pixels wide', icon: 'phone', compare: 390, keys: LIVE_TIP.phone },
  tablet: { px: 768, label: 'Tablet, 768 pixels wide', icon: 'tablet', compare: 768, keys: LIVE_TIP.tablet },
  full: { px: null, label: 'Full width', icon: 'desktop', compare: 1440, keys: LIVE_TIP.full },
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

/** The width the live view is given, for showing one side panel at a time when it is narrow. */
function useNarrow(ref: RefObject<HTMLElement | null>): boolean {
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = (): void => setNarrow(el.getBoundingClientRect().width < NARROW_PX);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return narrow;
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
  const notices = useNotices();
  // The latest outcome the status line says, for a write's read-back to carry its Undo on.
  const latest = useRef<{ notice: Notice | null; dismiss: (id: number) => void }>({ notice: null, dismiss: () => {} });
  latest.current = { notice: notices.latest, dismiss: notices.dismiss };
  const live = liveBridge() as NonNullable<ReturnType<typeof liveBridge>>;
  // Components and templates are Drupal's own; other kinds of site have none to map.
  const siteParts = useQuery('live.parts', site.platform === 'drupal' ? { projectId: project.id } : null, ['liveSite'], forProject(project.id));
  const notes = useNotes(project.id);
  const [view, setView] = useState<LiveViewState | null>(null);
  const [regions, setRegions] = useState<LiveRegion[]>([]);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [picking, setPicking] = useState(false);
  const [hasScript, setHasScript] = useState(true);
  const [tab, setTab] = useState<Tab>('layers');
  /** The Add tab: the site's library, or what this page itself can take (the trace's palette). */
  const [addMode, setAddMode] = useState<AddMode>('library');
  /** The tab before Add, for ⇧B to go back to. */
  const beforeAdd = useRef<Tab>('layers');
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
  /** A snap being marked up (its first picture), and a stopped recording's review: each drawn in the stage. */
  const [snap, setSnap] = useState<SnapShot | null>(null);
  const [review, setReview] = useState<LiveRecording | null>(null);
  const rec = useRecorder(project.id, setReview);
  useRecordEscape(rec, compact || !!snap || !!review);
  const recording = useRef(false);
  recording.current = rec.on && !compact;
  // Leaving the live view stops a recording of it: a recording is never on where it cannot be seen. (Only the project's
  // own live view records; a session's split beside its terminal has no Record.)
  useEffect(() => () => { if (recording.current) void liveBridge()?.recordStop(); }, []);
  /** The design layer's edits (the Edits panel) take the Inspector's place while open. */
  const [tray, setTray] = useState(false);
  /** The side panels: Structure is the owner's to close (kept on this computer); the Inspector closes until a part is chosen. */
  const liveRef = useRef<HTMLDivElement>(null);
  const narrow = useNarrow(liveRef);
  const [structureWide, setStructureWide] = useState(() => readOpen(STRUCTURE_KEY));
  const [structureNarrow, setStructureNarrow] = useState(false);
  const structure = narrow ? structureNarrow : structureWide;
  const setStructure = (open: boolean): void => {
    if (narrow) setStructureNarrow(open);
    else { setStructureWide(open); keepOpen(STRUCTURE_KEY, open); }
  };
  const [inspector, setInspector] = useState(true);
  /** The Inspector's tool in use on the chosen part: trying a style, or moving it. */
  const [tool, setTool] = useState<InspectorTool>(null);
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
  const how = useHowLiveWorks(project.id, !compact);

  /** Say what just happened in the status line (and the tray): a file changed, the page reloaded. */
  const say = useCallback((b: Banner): void => {
    const text = bannerText(b);
    if (b.kind === 'waiting') toast(text, 'info', { action: { label: 'Reload', run: () => void liveBridge()?.reload(true) } });
    else toast(text);
  }, [toast]);
  // Every write is read back once the page reloads with it (live/write-checks.ts).
  const traceIdRef = useRef<string | null>(null);
  traceIdRef.current = traceData?.id ?? null;
  const currentTraceId = useCallback(() => traceIdRef.current, []);
  /**
   * A write read back: in red when it needs the owner, in green when the site holds it. A read-back that confirms a
   * move or a removal carries on its Undo (the save said it first), so the status line goes on offering it.
   */
  const sayWrite = useCallback((text: string, warn: boolean, now: boolean): void => {
    if (warn) { toast(text, 'error'); return; }
    // What the site's AI did is said at once (`now`), as news; a read-back that found the write in place is a check passed.
    if (now) { toast(text); return; }
    const { notice, dismiss } = latest.current;
    const undo = notice && notice.tone !== 'error' && notice.action && actionable(notice) ? notice.action : null;
    toast(text, 'done', undo ? { action: undo } : undefined);
    if (undo && notice) dismiss(notice.id);
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
  // live view's own keys the same way (P selects…), and its action bar's buttons; `runKey` is what they do.
  const runKey = useRef<(id: LiveKeyId | LiveGesture) => void>(() => {});
  const goTo = useGoToKeys(project.id, (id) => runKey.current(id));
  const sender = useNotesSender(project, components, follow);
  const sendAll = useRef(sender.sendAll);
  sendAll.current = sender.sendAll;

  useEffect(() => { void live.hasScript().then(setHasScript); }, [live]);
  useEffect(() => { setOnly(null); }, [lens]);
  // What needs the page itself (picking, placing, an edit sheet beside a part) brings it back from Compare, a snap and a review.
  useEffect(() => { if (picking || editing || arrange.placing) { setComparing(false); setSnap(null); setReview(null); } }, [picking, editing, arrange.placing]);

  // Escape, in the window or in the page, takes a lens away (and stops placing a palette entry).
  useEffect(() => {
    if (lens === 'structure' && !arrange.placing) return undefined;
    const back = (): void => { setLens('structure'); arrange.setPlacing(null); };
    const key = (e: KeyboardEvent): void => {
      // Compare's Escape is its own: it goes back to the page, the lens with it.
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('.scrim, .live-sheet, .live-stage-compare, .live-stage-snap')) return;
      const t = e.target as Element | null;
      if (t?.closest?.('input, textarea, select, .sel-list') || (t && t !== document.body && !t.closest?.('.live, .live-docked, .status-line'))) return;
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

  /** What a part is called on its name chip in the page: its name (the helper's, when the trace has one). */
  const labelOf = useCallback((r: LiveRegion): string => {
    const part = partsRef.current.byRegion.get(r.index);
    return nameOf(r, r.component ? componentsRef.current.get(r.component)?.name ?? null : null, part ? { label: part.label, kind: part.kind } : null).title;
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
      say({ kind: 'outlined', file: fileName(paths[0] as string), count: hits.length });
      return;
    }
    if (paths.length) say({ kind: 'not-here', file: fileName(paths[0] as string) });
    if (next?.region) await live.outline([next.region.index], labelOf(next.region), 'pick');
  }, [live, madeBy, labelOf, say]);

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
    if (!paths.length) say({ kind: 'reloaded' });
  }, [live, scanAndOutline, say]);

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
      if (!inside.length) { say({ kind: 'elsewhere', file: fileName(e.paths[0] ?? '') }); return; }
      if (!following) { say({ kind: 'waiting', file: fileName(inside[0] as string) }); return; }
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
  }), [project.id, follow, root, flush, following, site.helper, say]);

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
          if (recent.length > CONTENT_RELOADS_A_MINUTE) { stopped = true; say({ kind: 'restless' }); return; }
          outlineAfterLoad.current = [];
          void live.reload(true);
          say({ kind: 'content', cms: site.platform === 'wordpress' ? 'WordPress' : 'Drupal' });
        }
        last = n;
      });
    }, CONTENT_EVERY_MS);
    return () => window.clearInterval(timer);
  }, [site.helper, site.token, site.platform, following, live, env, say]);

  useEffect(() => () => {
    const t = queue.current.timer;
    if (t !== null) window.clearTimeout(t);
    if (late.current.timer !== null) window.clearTimeout(late.current.timer);
  }, []);

  /** The chosen part's details come forward: the Inspector opens (in place of Edits), and Structure gives way when narrow. */
  const showPart = (): void => {
    setTray(false);
    setInspector(true);
    if (narrow) setStructureNarrow(false);
  };

  /** Select on the page, from the chosen part when there is one (else the page's main content), so the keyboard can walk at once. */
  const pick = async (): Promise<void> => {
    if (picking) { await live.cancelPick(); return; }
    setPicking(true);
    await live.disarm();
    const p = await live.pick(selected.current?.region?.index ?? null);
    setPicking(false);
    if (!p) return;
    showPart();
    setSelection({ region: p.regions[0] ?? null, pick: p, how: 'pick' });
    const inner = p.regions[0];
    if (inner) await live.outline([inner.index], labelOf(inner), 'pick'); else await live.clear();
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
    else toast(`${site.platform === 'wordpress' ? 'WordPress' : 'Drupal'} saved changes while its form was open: reloaded.`, 'done');
  }), [live, checks, site.platform, toast]);
  const point = (indexes: number[] | null): void => { if (indexes) void live.outline(indexes.slice(0, 200), null, 'hover'); else hover(null); };
  const flipArrange = (): void => {
    setArrangeOn((v) => {
      try { localStorage.setItem(ARRANGE_KEY, v ? '0' : '1'); } catch { /* lasts this window */ }
      return !v;
    });
  };

  /**
   * Choose a part from the tree (or the crumbs, or where the library says it is used). Its element becomes the picked
   * one, so it offers what a pick offers: retyping its words, trying a style. How a part was chosen does not change
   * what can be done to it.
   */
  const select = (region: LiveRegion): void => {
    showPart();
    setSelection({ region, pick: null, how: 'tree' });
    void live.outline([region.index], labelOf(region), 'pick');
    void live.choose(region.index).then((p) => {
      if (p) setSelection((s) => (s?.region?.index === region.index && !s.pick ? { ...s, pick: p } : s));
    }).catch(() => {});
  };
  const hover = (list: LiveRegion[] | null, label: string | null = null): void => {
    if (list) { void live.outline(list.map((r) => r.index), label, 'hover'); return; }
    const kept = selection?.region;
    if (kept) void live.outline([kept.index], labelOf(kept), 'pick'); else void live.clear();
  };
  const unselect = (): void => { setSelection(null); setTool(null); void live.clear(); };
  /** Nothing chosen any more: the keyboard goes to the tree's row for the part when it was on the part's details. */
  const backToTree = (): void => {
    const fromPart = !!document.activeElement?.closest('.live-inspector');
    unselect();
    if (fromPart) {
      if (!structure) setStructure(true);
      setTab('layers');
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => document.querySelector<HTMLElement>('.live-tree [tabindex="0"]')?.focus()));
    }
  };
  const showNote = (n: LiveNote | null): void => {
    const r = n?.regions[0];
    const same = r ? regions.filter((x) => sameRegion(r, [r], [x])) : [];
    if (same.length === 1) void live.outline([same[0]!.index], null, 'hover'); else hover(null);
  };
  /** The Edits panel, in the Inspector's place. */
  const openTray = (open: boolean): void => {
    setTray(open);
    if (open) { setInspector(true); if (narrow) setStructureNarrow(false); }
  };
  /** Structure's tabs: Add opens on what was asked (⇧B toggles back to the tab before it). */
  const showTab = (next: Tab): void => {
    if (next === 'add' && tab !== 'add') beforeAdd.current = tab;
    setTab(next);
    if (!structure) setStructure(true);
  };

  /** Show the same page on another environment (null: the local site). */
  const switchTo = (next: string | null): void => {
    const to = envs.find((e) => e.id === next) ?? null;
    setStageUrl(samePage(view?.url ?? stageUrl, env?.url ?? url, to?.url ?? url));
    setEnvId(to?.id ?? null);
    setSelection(null);
    setRegions([]);
  };
  // Go to opens the same path on the environment shown, as the address field always did.
  useEffect(() => {
    let origin: string | null = null;
    try { origin = env ? new URL(env.url).origin : null; } catch { origin = null; }
    showingOrigin(project.id, origin);
    return () => showingOrigin(project.id, null);
  }, [project.id, env]);

  // The page's own DevTools: its tab in the dock, Chrome's chord for this platform, and pointing it at a part.
  const chord = devtoolsChord(bridge().platform === 'darwin');
  /** Show in DevTools: a region from the last scan, or the picked element (null); DevTools' inspector at its centre. */
  const inspectIn = async (target: number | null): Promise<void> => {
    const why = await showInDevtools(live, target);
    if (why) toast(why);
  };
  const inspectChosen = (): void => {
    const s = selected.current;
    if (!s) { toast('Choose a part first: P selects one on the page, or choose it in Layers.'); return; }
    void inspectIn(s.pick ? null : s.region?.index ?? null);
  };

  const errors = problems?.filter((p) => p.level === 'error').length ?? 0;
  /** The view shows one piece alone (the helper's page), and which kind. */
  const alone = (() => {
    try { return /^\/_wanigan\/piece\/([a-z]+)\//.exec(new URL(view?.url ?? '').pathname)?.[1] ?? null; } catch { return null; }
  })();
  const palette = traceData?.palette ?? [];
  const shownAdd: AddMode = palette.length ? addMode : 'library';
  /** The live view's tabs in the dock beneath the page, beside Code. */
  const docked: { id: LiveDockTab; label: string; hint?: string; count?: number; tone?: 'water' | 'red' | 'sunk' }[] = [
    { id: 'notes', label: 'Notes', count: notes.length, tone: 'water', hint: 'Notes for an agent, sent together' },
    { id: 'problems', label: 'Problems', count: problems?.length ?? 0, tone: errors ? 'red' : 'sunk', hint: 'What the page reports: its errors, warnings and console' },
    ...(helperSite ? [{ id: 'request' as const, label: 'Request', hint: 'The hooks, queries, assets and logs behind this page' }] : []),
    { id: 'devtools', label: 'DevTools', hint: 'The page’s own DevTools: elements, console, network, sources, application, performance' },
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
  /** Snap: the view's picture is taken first (a covered view draws nothing), then the snap is drawn over it. Again closes it. */
  const startSnap = async (): Promise<void> => {
    if (snap) { setSnap(null); return; }
    if (picking) await live.cancelPick();
    setComparing(false);
    setReview(null);
    const got = await live.snap('view');
    if (!got || 'error' in got) { toast(got ? got.error : 'The view shows nothing to picture yet.', 'error'); return; }
    setSnap(got);
  };
  const toggleRecord = (): void => {
    // A recording is of the page itself: what covers it steps aside first.
    setSnap(null);
    setReview(null);
    setComparing(false);
    void rec.toggle();
  };
  const consoleErrors = useMemo(() => (problems ?? []).filter((p) => p.source === 'console' && p.level === 'error').map((p) => p.text), [problems]);
  const needPart = (): void => toast(tray ? 'Close Edits first (⇧E): the chosen part’s details are under it.' : 'Choose a part first: P selects one on the page, or choose it in Layers.');
  /** A verb of the chosen part (the Inspector's), from a key, a tool or the page's action bar. */
  const verb = (id: keyof InspectorVerbs): void => {
    if (compact) return;
    if (!selected.current || tray || !verbs.current) { needPart(); return; }
    verbs.current[id]();
  };

  /* Make real, from the bar: every draft on this page made real where the site can save it, or verified. */
  const pageNow = env ? '' : pagePath(view?.url ?? url);
  const pageEdits = (layer.snapshot?.edits ?? []).filter((e) => e.page === pageNow);
  const drafts = pageEdits.filter((e) => e.state === 'draft');
  const made = pageEdits.filter((e) => e.state === 'implemented');
  const makeAllReal = async (): Promise<void> => {
    let ok = 0;
    let first: string | null = null;
    const left: string[] = [];
    for (const e of drafts) {
      const a = await layer.task(e.id, 'real', () => layer.change(() => live.layerImplement(e.id)));
      if (a?.ok) ok++;
      else { left.push(e.label); if (!first && a && !a.ok) first = a.why; }
    }
    if (!left.length) { toast(`Saved ${plural(ok, 'edit')} in the site. Verify compares the site with the design.`, 'done'); return; }
    // What the site could not take waits in Edits, where each one says why and what it needs (a template, an agent).
    openTray(true);
    toast(`${ok ? `Saved ${plural(ok, 'edit')} in the site. ` : ''}${plural(left.length, 'edit')} need${left.length === 1 ? 's' : ''} you in Edits${first ? `: ${first}` : '.'}`, ok ? 'info' : 'error');
  };
  const verifyAll = async (): Promise<void> => {
    for (const e of made) await layer.verify(e.id);
    const now = await layer.fresh();
    const after = (now.snapshot?.edits ?? []).filter((e) => made.some((m) => m.id === e.id));
    const passed = after.filter((e) => e.state === 'verified').length;
    if (passed === made.length) toast(`Verified ${plural(passed, 'edit')} at 390 and 1440 px: the site renders ${passed === 1 ? 'it' : 'them'} as designed.`, 'done');
    else { openTray(true); toast(`${passed} of ${plural(made.length, 'edit')} verified. Edits says what differs.`, 'error'); }
  };

  // The live view's own keys (shared/live-keys.ts), here and from the page, and the page's action bar: each does what
  // its control does. While Compare is drawn, 1 2 3 are its widths.
  runKey.current = (id: LiveKeyId | LiveGesture): void => {
    // A snap or a recording's review has the stage: its own keys are its; Snap and Record still answer.
    if ((snap || review) && id !== 'snap' && id !== 'record') return;
    switch (id) {
      case 'snap': if (!compact && hasScript) void startSnap(); return;
      case 'record': if (!compact) toggleRecord(); return;
      // A double-click on the chosen part's words in the page: typed on there, as E does.
      case 'retype': if (!compact && selected.current && !tray) verbs.current?.retype(); return;
      // The page's action bar: the window takes the keyboard, where the part's details are.
      case 'style': case 'ask':
        void live.focusWindow().then(() => verb(id));
        return;
      case 'pick': if (hasScript) void pick(); return;
      case 'lens': if (!compact && hasScript) lensOpen.current?.(); return;
      case 'width-phone': if (!compact && !comparing) setWidth('phone'); return;
      case 'width-tablet': if (!compact && !comparing) setWidth('tablet'); return;
      case 'width-full': if (!compact && !comparing) setWidth('full'); return;
      case 'tab-previous':
      case 'tab-next': {
        if (compact) return;
        const at = TABS.findIndex((t) => t.value === tab);
        const next = TABS[(at + (id === 'tab-next' ? 1 : -1) + TABS.length) % TABS.length];
        if (next) showTab(next.value);
        return;
      }
      case 'dock-previous':
      case 'dock-next':
        if (!compact) stepDock(id === 'dock-next' ? 1 : -1);
        return;
      case 'compare': if (!compact) { if (comparing) setComparing(false); else openCompare(); } return;
      case 'library':
        if (compact) return;
        if (tab === 'add' && structure) setTab(beforeAdd.current === 'add' ? 'layers' : beforeAdd.current); else showTab('add');
        return;
      case 'edits': if (!compact) openTray(!tray); return;
      // ⇧D: the chosen part in DevTools (a row of the tree with the keyboard takes it first: Layers.tsx).
      case 'devtools-show': if (!compact) inspectChosen(); return;
      case 'move':
      case 'take-out':
        // From the page's action bar the keyboard comes to the window first, where Move takes it.
        void live.focusWindow().catch(() => {});
        verb(id);
        return;
      case 'edit':
      case 'code':
      case 'alone':
        verb(id);
    }
  };
  // In the window: while the live view (or nothing) has the keyboard, nothing is typed into, and nothing is open over it.
  useEffect(() => {
    const mac = bridge().platform === 'darwin';
    let afterG = 0;
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.repeat || e.isComposing) return;
      const t = e.target instanceof Element ? e.target : null;
      // The live view, its tabs in the dock beneath the page, and its tabs waiting in the status line.
      if (!t || !(t === document.body || t.closest('.live, .live-docked, .dock-tabs, .status-line'))) return;
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
      if (t.closest('.live-stage-snap') && id !== 'snap' && id !== 'record') return;
      e.preventDefault();
      runKey.current(id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Escape in the window while words are typed on the page puts them back, as it does in the page.
  const endTyping = layer.endTyping;
  useEffect(() => {
    if (!layer.typing) return undefined;
    const key = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('[aria-modal="true"], .sel-list, [role="menu"]')) return;
      e.preventDefault();
      e.stopPropagation();
      endTyping(false);
    };
    document.addEventListener('keydown', key, true);
    return () => document.removeEventListener('keydown', key, true);
  }, [layer.typing, endTyping]);

  /** The mode the view is in, at the status line's end: said while it lasts, with the one thing to do about it. */
  const mode: { text: ReactNode; className: string; icon: 'record' | 'text' | 'plus' | 'pick' | 'compare' | 'alone' | 'open' | 'eye'; action?: ReactNode; detail?: string } | null = rec.on ? {
    // Always said while it records, before anything else: a recording is never on unseen.
    className: 'live-recording', icon: 'record',
    text: <>Recording the live view <time className="live-record-time">{length(rec.elapsed)}</time> <span className="faint">of {length(rec.state.limitMs)}</span></>,
    action: <Button size="s" tone="quiet" icon="stop" keys={LIVE_TIP.stop} onClick={() => void rec.stop()}>Stop</Button>,
  } : rec.saving ? {
    className: 'live-recording', icon: 'record', text: 'Saving the recording: its clip, key frames and step log.',
  } : layer.typing ? {
    className: 'live-typing', icon: 'text', text: 'Typing on the page',
    action: (
      <span className="live-status-actions">
        <Button size="s" tone="quiet" icon="check" keys={LIVE_TIP.keep} onClick={() => layer.endTyping(true)}>Keep</Button>
        <Button size="s" tone="quiet" icon="undo" keys={LIVE_TIP.putBack} onClick={() => layer.endTyping(false)}>Put back</Button>
      </span>
    ),
  } : arrange.placing ? {
    className: 'live-placing', icon: 'plus',
    text: <>Placing <strong>{arrange.placing.label}</strong>: click where it goes</>,
    action: <IconButton icon="close" size="s" label="Stop placing" keys={LIVE_TIP.stop} onClick={() => arrange.setPlacing(null)} />,
  } : picking ? {
    className: 'live-picking', icon: 'pick', text: 'Selecting: point at a part, or walk with the arrows and press Enter',
    action: <Button size="s" tone="quiet" keys={LIVE_TIP.stop} onClick={() => void live.cancelPick()}>Stop</Button>,
  } : comparing && envs.length ? {
    className: 'live-comparing', icon: 'compare', text: 'Comparing: the page waits under it as it was',
    action: <Button size="s" tone="quiet" icon="back" onClick={() => setComparing(false)}>Back to the page</Button>,
  } : alone ? {
    className: 'live-alone', icon: 'alone', text: `One piece alone${alone === 'sample' || alone === 'component' ? ', with sample content' : ''}`,
    action: <Button size="s" tone="quiet" icon="back" onClick={() => void live.back()}>Back to the page</Button>,
  } : env ? {
    className: 'live-hosted', icon: 'open', text: <><strong>{env.name}</strong> is read-only</>,
    detail: `Point at parts and tell an agent, but nothing in this view can change it, and it does not follow the agents’ edits. ${HOSTED_NOTE}`,
  } : !layer.on ? {
    className: 'live-layer-off', icon: 'eye', text: 'Showing the page without the design layer',
    action: <Button size="s" tone="quiet" icon="eye" onClick={() => layer.show(true)}>Show the layer</Button>,
  } : null;

  const following_ = site.platform === 'drupal' ? 'Drupal' : site.platform === 'wordpress' ? 'WordPress' : 'Site';
  const where = `${following_} · ${env ? `${env.name}, read-only` : follow ? 'following this session' : `following every session in ${project.name}`}`;
  const siteState: 'green' | 'red' | 'muted' = view?.error ? 'red' : view && !view.loading && !env ? 'green' : 'muted';
  const showStructure = !compact && structure;
  const right = !compact && inspector && (tray || !!selection || !narrow);

  return (
    <div ref={liveRef} className={`live${compact ? ' live-compact' : ''}${rec.on ? ' recording' : ''}`}>
      <Toolbar label="Live view" className="live-bar">
        <div className="live-bar-start">
          {!compact ? (
            <IconButton icon="sidebar" label={showStructure ? 'Hide Structure: layers, add, pages' : 'Show Structure: layers, add, pages'} aria-expanded={showStructure}
              onClick={() => setStructure(!structure)} />
          ) : null}
          <SiteMenu envs={compact ? [] : envs} shown={env} onShow={switchTo} compare={compare} onCompare={openCompare} onSettings={onEdit} compact={compact}
            state={siteState} where={where} />
          <span className="live-nav">
            <IconButton icon="back" label="Back" disabled={!view?.canGoBack} onClick={() => void live.back()} />
            <IconButton icon="forward" label="Forward" disabled={!view?.canGoForward} onClick={() => void live.forward()} />
            <IconButton icon="refresh" label={view?.loading ? 'Loading…' : 'Reload (hold Shift to skip the cache)'}
              onClick={(e) => void live.reload(e.shiftKey)} data-loading={view?.loading ? '' : undefined} />
          </span>
          <AddressField projectId={project.id} url={view?.url ?? (env ? env.url : stageUrl)} title={view?.title ?? null} onOpen={goTo} />
        </div>
        <ToolGroup label="Tools" className="live-tools">
          <IconButton icon="pick" label={picking ? 'Selecting… (P or Escape stops)' : 'Select a part on the page'} keys={LIVE_TIP.select} pressed={picking}
            disabled={!hasScript} onClick={() => void pick()} />
          {!compact ? (
            <>
              <IconButton icon="text" label="Type on the page" keys={LIVE_TIP.type} pressed={layer.typing} disabled={!selection || !!env}
                onClick={() => (layer.typing ? layer.endTyping(true) : verb('type'))} />
              <IconButton icon="brush" label="Style" pressed={tool === 'style'} disabled={!selection?.pick || !!env} onClick={() => verb('style')} />
              <IconButton icon="move" label="Move" keys={LIVE_TIP.move} pressed={tool === 'move' || (!!arrange.pending && arrange.pending.region === selection?.region?.index)}
                disabled={!selection || !!env} onClick={() => verb('move')} />
              <ToolSeparator />
              <IconButton icon="camera" label="Snap" keys={LIVE_TIP.snap} pressed={!!snap} disabled={!hasScript || !!view?.error} onClick={() => void startSnap()} />
              <RecordButton rec={rec} disabled={!!view?.error} onToggle={toggleRecord} />
              {/* Voice lands here next (another branch): speaking instead of typing. A place, not a control, until it does. */}
              <span className="tool-slot" data-slot="voice" />
            </>
          ) : null}
        </ToolGroup>
        <div className="live-bar-end">
          {!compact ? <LensPicker lens={lens} onChange={setLens} disabled={!hasScript} openRef={lensOpen} /> : null}
          {!compact ? (
            <div className="live-widths" role="radiogroup" aria-label="Width" onKeyDown={(e) => {
              // A radio group keeps its own arrows (the toolbar's skip it): they move to the next width and choose it.
              const order = Object.keys(WIDTHS) as Width[];
              const at = order.indexOf(width);
              const to = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? order[(at + 1) % order.length]
                : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? order[(at + order.length - 1) % order.length] : null;
              if (!to) return;
              e.preventDefault();
              const box = e.currentTarget;
              setWidth(to);
              window.requestAnimationFrame(() => box.querySelector<HTMLElement>('[aria-checked="true"]')?.focus());
            }}>
              {(Object.keys(WIDTHS) as Width[]).map((w) => (
                <IconButton key={w} icon={WIDTHS[w].icon} label={WIDTHS[w].label} keys={WIDTHS[w].keys} role="radio" aria-checked={width === w}
                  tabIndex={width === w ? 0 : -1} onClick={() => setWidth(w)} />
              ))}
            </div>
          ) : null}
          {!compact ? (
            <IconButton icon="eye" label="Show the page without the layer" pressed={!layer.on} disabled={!!env || !live} onClick={() => void layer.show(!layer.on)} />
          ) : null}
          {!compact ? (
            <Button size="s" className="live-edits-btn" aria-pressed={tray} keys={LIVE_TIP.edits} {...tipProps('Your edits to the page, in the design layer', LIVE_TIP.edits)}
              aria-label={`Edits${layer.drafts ? `, ${plural(layer.drafts, 'draft')}` : ''}: the design layer`} onClick={() => openTray(!tray)}>
              <span className="live-edits-name">Edits</span>{layer.drafts ? <Count n={layer.drafts} tone={tray ? 'sunk' : 'water'} /> : null}
            </Button>
          ) : null}
          {!compact ? (
            <MenuButton className="btn-primary btn-s live-real" label={`Make real: ${drafts.length ? plural(drafts.length, 'draft') : 'nothing'} on this page`} align="end" width={340}
              disabled={!!env || (!drafts.length && !made.length)} tip={env ? 'A hosted environment is read-only' : !drafts.length && !made.length ? 'Nothing on this page waits to be made real or verified' : 'Save this page’s edits in the site, or verify them'}
              items={[
                { id: 'real', icon: 'check', label: drafts.length ? `Make ${plural(drafts.length, 'edit')} on this page real` : 'Nothing on this page to make real', disabled: !drafts.length,
                  detail: 'Words are saved through the site’s own core; a style goes to an agent as a brief, on your click in Edits', run: () => void makeAllReal() },
                { id: 'verify', icon: 'compare', label: made.length ? `Verify ${plural(made.length, 'edit')} on this page` : 'Nothing on this page to verify', disabled: !made.length,
                  detail: 'Renders the page with and without the layer at 390 and 1440 px, and compares', run: () => void verifyAll() },
                { id: 'edits', icon: 'brush', label: 'Open Edits', keys: ['Shift', 'E'], detail: 'Every edit, each with its reach, state and what it needs', run: () => openTray(true) },
              ]}>
              <span>Make real</span><Icon name="down" size={12} />
            </MenuButton>
          ) : null}
          <MoreMenu compact={compact} arrangeOn={arrangeOn} canArrange={hasScript} onArrange={flipArrange} onBrowser={() => void live.open()} shot={shot} />
          {!compact ? <IconButton icon="question" label="How the live editor works" className="live-how" onClick={how.open} /> : null}
        </div>
      </Toolbar>
      {!compact ? (
        <LensStrip view={lensed} only={only} onOnly={setOnly} onHover={point} onClose={() => setLens('structure')}
          note={<TraceNote compact answer={trace} site={site} project={project} />} />
      ) : null}
      <div className="visually-hidden" role="status" aria-live="polite">{arrange.said}</div>
      {!compact ? <RecordAnnounce rec={rec} /> : null}
      {arrange.asking}
      <div className="live-main">
        {showStructure ? (
          <Panel side="left" label="Structure" className="live-structure" resizable sizeKey="live-structure" minSize={220} maxSize={420}
            size={tab === 'add' ? 320 : undefined}
            tabs={<Tabs id="live-structure" label="Structure" value={tab} onChange={showTab} tabs={TABS} />}>
            <TabPanel tabs="live-structure" value={tab} className="live-structure-body">
              {tab === 'layers' ? (
                <>
                  {/* A helper another Wanigan set up ignores this one: said first, where the owner looks, with the way out. */}
                  {!env && trace?.state === 'other' ? <TraceNote answer={trace} site={site} project={project} /> : null}
                  {regions.length ? (
                    <Layers regions={regions} components={components} selected={selection?.region?.index ?? null}
                      changed={changed} onHover={hover} onSelect={select} partName={partName} onDevtools={(r) => void inspectIn(r.index)} />
                  ) : (
                    <NothingMarked platform={env ? null : site.platform} loading={!!view?.loading} hosted={!!env} />
                  )}
                  {env || trace?.state === 'other' ? null : <HelperOffer site={site} project={project} />}
                </>
              ) : tab === 'add' ? (
                <div className="live-add">
                  {palette.length ? (
                    <Segmented<AddMode> size="s" label="Add from" value={shownAdd} onChange={setAddMode}
                      options={[{ value: 'library', label: 'Library', hint: 'What the site can place, pictured' }, { value: 'page', label: 'This page', count: palette.length, hint: 'What this page itself can take, by its trace' }]} />
                  ) : null}
                  {shownAdd === 'page' ? <PaletteTab arrange={arrange} trace={traceData} /> : (
                    <LibraryPanel project={project} site={site} trace={env ? null : traceData} parts={parts} regions={regions} arrange={arrange} readOnly={!!env}
                      onClose={() => setTab(beforeAdd.current === 'add' ? 'layers' : beforeAdd.current)} onSelect={select} onHover={hover} />
                  )}
                </div>
              ) : (
                <PagesTab project={project} page={view?.url ?? null} origin={env?.url ?? null} onGoTo={() => goTo({})} />
              )}
            </TabPanel>
          </Panel>
        ) : null}
        <LiveStage project={project} url={env || sameSite(stageUrl, url) ? stageUrl : url} token={env ? null : site.token} env={env?.id ?? null} view={view} width={WIDTHS[width].px}
          onReload={() => void live.reload(true)} onEdit={onEdit} stageRef={stageRef} deviceRef={deviceRef} compact={compact}>
          {/* A hosted environment is read-only: no edit sheet opens over it. */}
          {editing && !env ? (
            <EditSheet request={editing} stage={stageRef} device={deviceRef} cms={cms} onClose={() => setEditing(null)} trace={traceData} onSaved={editSaved} />
          ) : null}
          {/* Compare, where the page is: the page waits under it, as it was. */}
          {comparing && envs.length && !compact ? (
            <ComparePanel project={project} site={site} envs={envs} masks={envData?.masks ?? []} page={view?.url ?? stageUrl} shownEnv={env?.id ?? null}
              width={WIDTHS[width].compare} components={componentNames} onClose={() => setComparing(false)} />
          ) : null}
          {/* A snap being marked up, and a stopped recording's review: drawn where the page is, the page waiting under them. */}
          {snap && !compact ? (
            <SnapPanel first={snap} project={project} regions={regions} traceParts={parts.parts} traced={!!traceData} components={components}
              componentName={(id) => components.get(id)?.name ?? null} errors={consoleErrors} prefer={follow} onClose={() => setSnap(null)} />
          ) : null}
          {review && !snap && !compact ? (
            <RecordReview project={project} recording={review} partName={partName} components={components} prefer={follow} onClose={() => setReview(null)} />
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
        ) : right ? (
          <Panel side="right" label={tray ? 'Edits' : selection ? 'The chosen part' : 'Inspector'} className="live-inspector-panel" resizable sizeKey="live-inspector" minSize={260} maxSize={520}>
            {tray ? (
              <LayerTray project={project} layer={layer} page={pageNow} siteUrl={url} trace={env ? null : traceData} parts={parts} regions={regions}
                components={components} prefer={follow} readOnly={!!env} onClose={() => setTray(false)} onReload={() => { outlineAfterLoad.current = []; void live.reload(); }} />
            ) : selection ? (
              <Inspector project={project} platform={site.platform} selection={selection} regions={regions} components={components} docroot={siteParts.data?.docroot ?? null}
                theme={theme} page={view?.url ?? url} prefer={follow} helper={!!site.helper && !env} readOnly={!!env} onSelect={select} onClose={backToTree}
                site={site} answer={env ? null : trace} trace={env ? null : traceData} parts={parts} arrange={arrange} onEdit={openEdit} verbs={verbs}
                siteAi={env ? null : siteAi} onSiteAiRefresh={readSiteAi} layer={layer} onTray={() => openTray(true)} onDevtools={inspectChosen}
                tool={tool} onTool={setTool} />
            ) : (
              <div className="live-inspector-empty">
                <div className="live-panel-head">
                  <h2 className="live-panel-title">Inspector</h2>
                  <IconButton icon="close" size="s" label="Close the inspector" onClick={() => setInspector(false)} />
                </div>
                <EmptyState icon="pick" title="Nothing chosen" action={<Button size="s" icon="pick" keys={LIVE_TIP.select} disabled={!hasScript} onClick={() => void pick()}>Select on the page</Button>}>
                  Select a part on the page, or choose one in Layers, to see its design, what made it and its data.
                </EmptyState>
              </div>
            )}
          </Panel>
        ) : null}
      </div>
      {/* Notes, Problems, Request and the page's DevTools, in the dock beneath the page beside the code editor. */}
      {!compact ? (
        <LiveDock tabs={docked}>
          {(t) => (t === 'notes' ? (
            <>
              <NotesTab project={project} components={components} sender={sender} onShow={showNote} />
              <EditsList project={project} layer={layer.snapshot} />
            </>
          ) : t === 'problems' ? (
            <ProblemsTab problems={problems} project={project} url={view?.url ?? url} onRefresh={() => void refreshProblems()} />
          ) : t === 'devtools' ? (
            <DevtoolsTab project={project} keyed={!env && !!site.token} />
          ) : (
            <RequestTab answer={trace} site={site} project={project} parts={parts} onPoint={point} />
          ))}
        </LiveDock>
      ) : null}
      {/* The mode the view is in, and the dock's tabs waiting, at the end of the frame's status line. */}
      {!compact ? (
        <StatusSlot>
          <span className="live-status">
            <span className={`live-status-said${mode ? ` ${mode.className}` : ''}`} role="status">
              {mode ? (
                <>
                  {mode.icon === 'record' ? <span className="live-status-rec" aria-hidden="true" /> : <Icon name={mode.icon} size={14} />}
                  <span className="live-status-text">{mode.text}</span>
                  {mode.detail ? <span className="visually-hidden">: {mode.detail}</span> : null}
                </>
              ) : null}
            </span>
            {mode?.detail ? <IconButton icon="question" size="s" label={`About ${env?.name ?? 'this environment'}, read-only`} data-tip={mode.detail} className="live-status-about" /> : null}
            {mode?.action}
          </span>
          <DockTabs projectId={project.id} tabs={docked} chord={chord} />
        </StatusSlot>
      ) : null}
      {how.shown ? (
        <HowLiveWorks project={project} layer={layer.snapshot} drafts={layer.drafts} helper={!!site.helper} cms={helperSite ? cms : null}
          onClose={how.close} onEdits={() => { how.close(); openTray(true); }} onSelect={() => { how.close(); void pick(); }} />
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
    <button ref={ref} type="button" className="live-address" aria-haspopup="dialog"
      aria-label={`Go to a page of ${parts.host || 'the site'}, or type its address. Shown: ${url}`}
      {...tipProps(title ? `${title} · Go to a page, or type an address` : 'Go to a page, or type an address', LIVE_TIP.goto, 'bottom')}
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
    <MenuButton className="btn-quiet btn-icon live-more" label="More: drag handles, the default browser, before and after" tip="More" items={items} align="end" width={320}>
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
  if (loading) {
    return (
      <div className="live-skeleton" role="status" aria-label="Loading the page…">
        {[0, 1, 2, 1, 1, 0, 1].map((depth, i) => <span key={i} className="live-skeleton-row" style={{ marginLeft: `calc(${depth} * var(--space-4))` }} />)}
      </div>
    );
  }
  return (
    <EmptyState icon="layers" title="Nothing on this page says what made it">
      {hosted ? 'A hosted site rarely does (its Twig debug is off, and it has no helper). Select a part to point an agent at it anyway.'
        : platform === 'drupal' ? 'Drupal marks every template while Twig debug is on (Configuration › Development › Development settings). Select a part to point an agent at it anyway.'
          : platform === 'wordpress' ? 'Blocks and Elementor elements mark themselves; classic theme templates do not. Select a part to point an agent at it anyway.'
            : 'Select a part to point an agent at it anyway.'}
    </EmptyState>
  );
}

/**
 * The placeholder the app lays its view over: the page as a sheet on the
 * canvas. It reports where it is as it moves, steps the view aside while
 * something covers it (showing the last frame instead), narrows to a device's
 * width, and, when the site is not shown, says why: what runs the site is asked
 * as the view opens and again when a page fails, so a site that is not running
 * is said as that, never as the certificate ddev's router answered with.
 */
function LiveStage({ project, url, token, env, view, width, onReload, onEdit, stageRef, deviceRef, compact, children }: {
  project: ProjectSummary; url: string; token: string | null;
  /** A hosted environment's id: shown read-only in its own session. Null: the local site. */
  env: string | null;
  view: LiveViewState | null; width: number | null; onReload: () => void; onEdit: () => void;
  stageRef: RefObject<HTMLDivElement | null>; deviceRef: RefObject<HTMLDivElement | null>;
  compact: boolean;
  /** What sits over the page: an edit sheet beside a part, Compare, a snap, a recording's review. */
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
    <div className={`live-stage${width ? ' narrow' : ''}${compact ? ' compact' : ''}`} ref={stageRef} aria-label="The page" role="region">
      {width ? <span className="live-device-size" aria-hidden="true">{width} px</span> : null}
      <div className={`live-device${view?.loading && !frame ? ' loading' : ''}`} ref={device} style={width ? { width } : undefined}>
        {frame && !trouble ? <img className="live-frame" src={frame} alt="" /> : null}
      </div>
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
            : nobody ? 'Check the environment’s address in the site settings, and that this computer is online.' : 'Chromium gave this reason:'}
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

