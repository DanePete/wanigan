// The live view: a project's local site inside Wanigan, following the agents'
// edits. The app lays its own view over the stage below (lib/live.ts); this
// file decides what to show around it, when to reload, and what to outline.
// The side panel's parts are in components/live/.
// Design: docs/design/2026-10-08-live-view.md.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { LiveViewState } from '@shared/bridge';
import {
  inFolder, isStylesheet, regionMadeBy, sameRegion, sameSite,
  type LiveCandidate, type LiveEdit, type LiveEvent, type LivePlatform, type LiveProblem, type LiveRegion, type LiveSite,
} from '@shared/live';
import type { CompareWidth } from '@shared/live-compare';
import { samePage } from '@shared/live-envs';
import { nameOf, themeOf } from '@shared/live-names';
import type { ProjectSummary } from '@shared/model';
import { attempt, bridge, call, forProject, useQuery } from '../lib/api';
import { liveBridge, useLiveCovered } from '../lib/live';
import { navigate } from '../lib/router';
import { useAppState } from '../lib/settings';
import { liveFor, type AppSettings } from '@shared/settings';
import { Icon } from './icons';
import { Inspector, type Selection } from './live/Inspector';
import { CompareDialog } from './live/Compare';
import { EnvTabs, EnvironmentSettings, HOSTED_NOTE, useEnvs } from './live/Environments';
import { HelperOffer, HelperSettings } from './live/Helper';
import { Layers } from './live/Layers';
import { NoteComposer, NotesTab, draftFor } from './live/Notes';
import { useNotes, type LiveNote } from './live/note-store';
import { ProblemsTab } from './live/Problems';
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

type Tab = 'layers' | 'notes' | 'problems';
type Width = 'full' | 'tablet' | 'phone';
const WIDTHS: Record<Width, { px: number | null; label: string; icon: 'desktop' | 'tablet' | 'phone'; compare: CompareWidth }> = {
  full: { px: null, label: 'Full width', icon: 'desktop', compare: 1440 },
  tablet: { px: 768, label: 'Tablet, 768 pixels wide', icon: 'tablet', compare: 768 },
  phone: { px: 390, label: 'Phone, 390 pixels wide', icon: 'phone', compare: 390 },
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
  const parts = useQuery('live.parts', site.platform === 'drupal' ? { projectId: project.id } : null, ['liveSite'], forProject(project.id));
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
  const queue = useRef<{ paths: Set<string>; timer: number | null }>({ paths: new Set(), timer: null });
  /** Files to outline once the load in flight has finished. */
  const outlineAfterLoad = useRef<string[] | null>(outlineFirst);
  const late = useRef<{ timer: number | null; seen: number; tries: number }>({ timer: null, seen: -1, tries: 0 });
  const root = site.servedPath ?? project.path;
  const components = useMemo(() => new Map((parts.data?.components ?? []).map((c) => [c.id, c])), [parts.data]);
  const componentNames = useMemo(() => new Map([...components].map(([id, c]) => [id, c.name])), [components]);
  const componentsRef = useRef(components);
  componentsRef.current = components;
  const scanned = useRef<LiveRegion[]>([]);
  const selected = useRef<Selection | null>(null);
  selected.current = selection;
  const theme = useMemo(() => themeOf(regions), [regions]);

  useEffect(() => { void live.hasScript().then(setHasScript); }, [live]);

  /** Whether a part of the page was made by an edited file: its template, or a file in its component's folder. */
  const madeBy = useCallback((r: LiveRegion, path: string): boolean => {
    if (regionMadeBy(r.file, path)) return true;
    const c = r.component ? componentsRef.current.get(r.component) : undefined;
    return !!c && inFolder(c.dir, path);
  }, []);

  /** What a part is called on the page's outline: its name, and the file that made it. */
  const labelOf = useCallback((r: LiveRegion): string => {
    const name = nameOf(r, r.component ? componentsRef.current.get(r.component)?.name ?? null : null).title;
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
    if (s.projectId !== project.id || (s.env ?? null) !== hostedRef.current) return;
    setView(s);
    if (s.url) setAddress(s.url);
    if (s.loading) { setProblems(null); return; }
    if (!s.error) {
      const wanted = outlineAfterLoad.current;
      outlineAfterLoad.current = null;
      void scanAndOutline(wanted ?? [], true).then(() => { watchLate(); return refreshProblems(); });
    }
  }), [live, project.id, scanAndOutline, watchLate, refreshProblems]);

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

  const pick = async (): Promise<void> => {
    if (picking) { await live.cancelPick(); return; }
    setPicking(true);
    const p = await live.pick();
    setPicking(false);
    if (!p) return;
    setTab('layers');
    setSelection({ region: p.regions[0] ?? null, pick: p });
    const inner = p.regions[0];
    if (inner) await live.outline([inner.index], labelOf(inner), 'edit'); else await live.clear();
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
  const saved = (): void => {
    outlineAfterLoad.current = [];
    void live.reload();
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
  const tabs: { value: Tab; label: string }[] = [
    { value: 'layers', label: 'Layers' },
    { value: 'notes', label: notes.length ? `Notes ${notes.length}` : 'Notes' },
    { value: 'problems', label: errors ? `Problems ${errors}` : 'Problems' },
  ];

  return (
    <div className={`live${compact ? ' live-compact' : ''}`}>
      <form className="live-bar" onSubmit={go} aria-label="Live view">
        {!compact && envs.length ? <EnvTabs envs={envs} value={env?.id ?? null} onChange={switchTo} /> : null}
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
        <Button size="s" tone={picking ? 'primary' : 'quiet'} icon="pick" onClick={() => void pick()} disabled={!hasScript}
          title={hasScript ? 'Point at something on the page to see what made it: ↑ and ↓ walk out and in, Enter picks, Escape stops' : 'This build of Wanigan has no page script'} aria-pressed={picking}>
          {picking ? 'Picking…' : 'Pick'}
        </Button>
        {!compact ? (
          <Button size="s" tone="quiet" icon="compare" disabled={!envs.length || !!view?.loading} onClick={() => setComparing(true)}
            title={envs.length ? `Lay this page on Local over the same page on ${env?.name ?? envs[envs.length - 1]?.name}: wipe, onion skin, difference, flip, side by side`
              : envData?.candidates.length ? `${envData.candidates.length} hosted environments are named in the project’s files: keep them in the site settings (the gear) to compare with them`
                : 'Add a hosted environment (Dev, Test, Live) in the site settings (the gear) to compare with it'}>
            Compare
          </Button>
        ) : null}
        {card && shots && !env ? <ShotPage card={card} page={view?.url ?? null} /> : null}
        <IconButton icon="open" label="Open in the default browser" onClick={() => void live.open()} />
        <IconButton icon="settings" label="Site settings" onClick={onEdit} />
      </form>
      <div className="live-main">
        <LiveStage project={project} url={env || sameSite(stageUrl, url) ? stageUrl : url} token={env ? null : site.token} env={env?.id ?? null} view={view} width={WIDTHS[width].px}
          onReload={() => void live.reload(true)} onEdit={onEdit} />
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
          <aside className="live-side" aria-label="What is on this page">
            <Segmented<Tab> size="s" label="Show" value={tab} options={tabs} onChange={setTab} />
            {alone ? (
              <p className="live-note live-alone small" role="status">
                <span>Showing one piece alone{alone === 'sample' || alone === 'component' ? ', with sample content' : ''}.</span>
                <Button size="s" tone="quiet" icon="back" onClick={() => void live.back()}>Back to the page</Button>
              </p>
            ) : null}
            {env ? (
              <div className="live-note live-hosted small" role="status">
                <span><strong>{env.name}</strong> is read-only here: point at parts and tell an agent, but nothing in this view can change it, and it does not follow the agents’ edits.</span>
                <span className="faint">{HOSTED_NOTE}</span>
              </div>
            ) : null}
            {banner && tab === 'layers' && !alone && !env ? <p className="live-note small" role="status">{bannerText(banner)}</p> : null}
            {tab === 'layers' ? (
              selection ? (
                <Inspector project={project} platform={site.platform} selection={selection} regions={regions} components={components} docroot={parts.data?.docroot ?? null}
                  theme={theme} page={view?.url ?? url} prefer={follow} helper={!!site.helper && !env} readOnly={!!env} onSelect={select} onClose={unselect} onSaved={saved} />
              ) : (
                <>
                  {regions.length ? (
                    <Layers regions={regions} components={components} selected={null} changed={changed} onHover={hover} onSelect={select} />
                  ) : (
                    <NothingMarked platform={env ? null : site.platform} loading={!!view?.loading} hosted={!!env} />
                  )}
                  {env ? null : <HelperOffer site={site} project={project} />}
                </>
              )
            ) : tab === 'notes' ? (
              <>
                <NotesTab project={project} components={components} prefer={follow} onShow={showNote} />
                <EditsList project={project} />
              </>
            ) : (
              <ProblemsTab problems={problems} project={project} url={view?.url ?? url} onRefresh={() => void refreshProblems()} />
            )}
            <p className="live-side-foot faint small">
              {site.platform === 'drupal' ? 'Drupal' : site.platform === 'wordpress' ? 'WordPress' : 'Site'} · {env ? `${env.name}, read-only` : follow ? 'following this session' : `following every session in ${project.name}`}
            </p>
          </aside>
        )}
      </div>
      {comparing && envs.length ? (
        <CompareDialog project={project} site={site} envs={envs} masks={envData?.masks ?? []} page={view?.url ?? stageUrl} shownEnv={env?.id ?? null}
          width={WIDTHS[width].compare} components={componentNames} onClose={() => setComparing(false)} />
      ) : null}
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
function LiveStage({ project, url, token, env, view, width, onReload, onEdit }: {
  project: ProjectSummary; url: string; token: string | null;
  /** A hosted environment's id: shown read-only in its own session. Null: the local site. */
  env: string | null;
  view: LiveViewState | null; width: number | null; onReload: () => void; onEdit: () => void;
}) {
  const live = liveBridge() as NonNullable<ReturnType<typeof liveBridge>>;
  const device = useRef<HTMLDivElement>(null);
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
    <div className={`live-stage${width ? ' narrow' : ''}`}>
      <div className="live-device" ref={device} style={width ? { width } : undefined}>
        {frame && !error ? <img className="live-frame" src={frame} alt="" /> : null}
      </div>
      {width ? <span className="live-device-size faint small" aria-hidden="true">{width} px</span> : null}
      {error ? <LoadProblem error={error} url={url} hosted={!!env} onReload={onReload} onEdit={onEdit} /> : null}
    </div>
  );
}

function LoadProblem({ error, url, hosted, onReload, onEdit }: { error: NonNullable<LiveViewState['error']>; url: string; hosted: boolean; onReload: () => void; onEdit: () => void }) {
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
          {certificate && hosted
            ? 'A hosted environment’s certificate is checked as any browser checks it, and Wanigan makes no exception for it.'
            : certificate
              ? 'Wanigan trusts certificates from this Mac’s own mkcert authority (ddev’s). This one is from somewhere else, or mkcert has no authority here yet: run mkcert -install, then reload.'
              : nobody
                ? hosted ? 'Check the environment’s address in the site settings, and that this Mac is online.' : 'Start the site first (for ddev: ddev start in the project folder), then reload.'
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
