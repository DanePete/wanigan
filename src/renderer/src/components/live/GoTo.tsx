// "Go to": every page of the project's site, found by typing, and gone to.
// Shift+Space in the live view or its page, ⌘⇧Space anywhere in a project, or
// the live view's toolbar button. The site's helper lists its destinations
// (content, admin and structure pages, templates and settings, each with its
// tasks); matching them is instant and local (shared/live-goto.ts), the site
// searches its content as typing pauses, and what the owner chooses often and
// lately rises. Enter opens in the live view, ⌥Enter the edit form, ⌘Enter the
// default browser, → or Tab the destination's tasks, ⌘C copies its address.
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { FindItem, FindResult } from '@shared/live-find';
import {
  addressOf, directJump, frecency, groupRanked, guessKind, hereItem, kindGroup, prepare, rank, withoutNoise,
  type GoToGroup, type Jump, type LiveFindAnswer, type LiveHere, type Match, type Prepared, type Visit,
} from '@shared/live-goto';
import type { LiveSite } from '@shared/live';
import type { ProjectSummary } from '@shared/model';
import { bridge, forProject, useQuery } from '../../lib/api';
import { ago } from '../../lib/format';
import { liveBridge, useCoversLive } from '../../lib/live';
import {
  goToEditor, goWhenShown, keepAnswer, keepSearch, keptAnswer, keptSearch, liveOnScreen, loadVisits, onGoTo, rememberVisit,
} from '../../lib/live-goto';
import { navigate } from '../../lib/router';
import { Icon, type IconName } from '../icons';
import { Button } from '../ui';
import { HelperDialog } from './Helper';
import '../../styles/goto.css';

/* ── the host: what opens and closes it ────────────────────────────────── */

interface Opened { projectId: string; fromPage: boolean; returnTo: HTMLElement | null }
type Closing = 'escape' | 'to-page' | 'away';

/** Wait for the live view to step back in after the launcher stops covering it, then act (focus goes to a shown view only). */
const afterUncover = (fn: () => void): void => {
  requestAnimationFrame(() => requestAnimationFrame(() => { window.setTimeout(fn, 30); }));
};

/** Mounted once in the window: opens Go to for the project on screen when asked, and puts the keyboard back after. */
export function GoToHost({ project }: { project: ProjectSummary | undefined }) {
  const [open, setOpen] = useState<Opened | null>(null);
  const [helper, setHelper] = useState(false);
  const current = useRef(open);
  current.current = open;

  const close = (how: Closing): void => {
    const was = current.current;
    setOpen(null);
    if (!was) return;
    if (how === 'to-page' || (how === 'escape' && was.fromPage)) afterUncover(() => void liveBridge()?.gotoReturn());
    else if (how === 'escape') was.returnTo?.focus?.();
  };

  useEffect(() => onGoTo((req) => {
    if (!project || (req.projectId && req.projectId !== project.id)) return;
    // The same request again closes it: ⌘⇧Space toggles, as ⌘K does.
    if (current.current?.projectId === project.id) { close('escape'); return; }
    const returnTo = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    setOpen({ projectId: project.id, fromPage: req.fromPage, returnTo });
    // A chord pressed while the page had the keyboard: take it, and give it back after.
    if (!req.fromPage) {
      void liveBridge()?.gotoFocus().then((had) => {
        if (had) setOpen((o) => (o && o.projectId === project.id ? { ...o, fromPage: true } : o));
      }).catch(() => {});
    }
  }), [project]); // eslint-disable-line react-hooks/exhaustive-deps

  // Another project on screen: what was open for the last one does not come back with it.
  useEffect(() => { if (current.current && current.current.projectId !== project?.id) setOpen(null); }, [project?.id]);

  if (!project) return null;
  return (
    <>
      {open && open.projectId === project.id ? (
        <GoTo project={project} onClose={close} onHelper={() => { close('away'); setHelper(true); }} />
      ) : null}
      {helper ? <HelperFor project={project} onClose={() => setHelper(false)} /> : null}
    </>
  );
}

/** The helper's setup, offered from Go to: the same plan and yes as the live view's own. */
function HelperFor({ project, onClose }: { project: ProjectSummary; onClose: () => void }) {
  const site = useQuery('live.site', { projectId: project.id }, ['liveSite'], forProject(project.id));
  return site.data ? <HelperDialog site={site.data} project={project} onClose={onClose} /> : null;
}

/* ── rows ──────────────────────────────────────────────────────────────── */

type Source = 'index' | 'search' | 'known' | 'visit' | 'task' | 'jump' | 'search-site';

interface Row {
  key: string;
  item: FindItem;
  source: Source;
  positions: number[];
  via: Match['via'];
  /** A task of the page shown: the destination it is a task of. */
  of: FindItem | null;
  jump: Jump | null;
}

interface Section { group: GoToGroup | 'Search the site'; title: string; rows: Row[]; more: number }

interface Act { key: string; label: string; icon: IconName; keys: string[] | null; run: () => void }

const PREPARED = new WeakMap<FindItem, Prepared>();
const prepared = (item: FindItem): Prepared => {
  let p = PREPARED.get(item);
  if (!p) { p = prepare(item); PREPARED.set(item, p); }
  return p;
};

/** A path compared as the site would: without a trailing slash, any case. */
const norm = (path: string): string => {
  const [p = '', q = ''] = path.split('?');
  return `${(p.length > 1 ? p.replace(/\/+$/, '') : p).toLowerCase()}${q ? `?${q}` : ''}`;
};

const KIND_ICON: Record<FindItem['kind'], IconName> = {
  content: 'content', term: 'pieces', user: 'account', media: 'image', admin: 'menu', structure: 'layers', template: 'file', setting: 'settings', view: 'list',
};

function taskIcon(label: string): IconName {
  if (/^edit/i.test(label)) return 'pencil';
  if (/layout/i.test(label)) return 'layers';
  if (/revision|history/i.test(label)) return 'history';
  if (/delete|trash|remove/i.test(label)) return 'trash';
  if (/view|preview/i.test(label)) return 'eye';
  return 'chevron';
}

function rowIcon(row: Row): IconName {
  if (row.source === 'jump') return 'chevron';
  if (row.source === 'search-site') return 'search';
  if (row.source === 'task') return taskIcon(row.item.label);
  if (row.source === 'known') return 'link';
  return KIND_ICON[row.item.kind];
}

const STATUS_WORD: Record<NonNullable<FindItem['status']>, string | null> = { published: null, draft: 'Draft', private: 'Private', scheduled: 'Scheduled', trash: 'In the trash' };

/** The label with the matched letters marked. */
function Marked({ text, at }: { text: string; at: number[] }) {
  if (!at.length) return <>{text}</>;
  const out: ReactNode[] = [];
  const on = new Set(at);
  let run = '';
  let marked = false;
  const flush = (i: number): void => {
    if (!run) return;
    out.push(marked ? <mark key={i}>{run}</mark> : run);
    run = '';
  };
  for (let i = 0; i < text.length; i++) {
    const m = on.has(i);
    if (m !== marked) { flush(i); marked = m; }
    run += text[i];
  }
  flush(text.length);
  return <>{out}</>;
}

/* ── the launcher ──────────────────────────────────────────────────────── */

function GoTo({ project, onClose, onHelper }: { project: ProjectSummary; onClose: (how: Closing) => void; onHelper: () => void }) {
  useCoversLive();
  const mac = bridge().platform === 'darwin';
  const live = liveBridge();
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const input = useRef<HTMLInputElement>(null);
  const site = useQuery('live.site', { projectId: project.id }, ['liveSite'], forProject(project.id));
  const [query, setQuery] = useState('');
  const [answer, setAnswer] = useState<LiveFindAnswer | null>(() => keptAnswer(project.id));
  const [loading, setLoading] = useState(!!live);
  const [attempt, setAttempt] = useState(0);
  const [here, setHere] = useState<LiveHere | null>(null);
  const [hereFound, setHereFound] = useState<FindItem | null>(null);
  const [visits, setVisits] = useState<Visit[]>(() => loadVisits(project.id));
  const [search, setSearch] = useState<{ q: string; result: FindResult | null; error: string | null } | null>(null);
  /** The site's search asked for by hand (one letter, or again after it failed). */
  const [asked, setAsked] = useState<{ q: string; n: number } | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [acting, setActing] = useState<{ row: Row; index: number } | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [announce, setAnnounce] = useState('');

  const q = query.trim();
  const ready = answer?.state === 'ready';
  const origin = answer?.origin ?? (() => { try { return site.data?.url ? new URL(site.data.url).origin : null; } catch { return null; } })();
  const platform = answer?.platform ?? site.data?.platform ?? null;
  const host = origin ? new URL(origin).host : null;
  const shown = liveOnScreen(project.id);

  useEffect(() => { input.current?.focus(); }, []);

  // The index (kept from the last time, then fresh) and, when the view shows this site, what the page is.
  useEffect(() => {
    if (!live) return undefined;
    let current = true;
    setLoading(true);
    live.find(project.id, '', attempt > 0 ? { refresh: true } : undefined).then((a) => {
      if (!current) return;
      keepAnswer(project.id, a);
      setAnswer(a);
      setLoading(false);
    }, (error: Error) => {
      if (!current) return;
      setAnswer({ state: 'failed', result: null, known: [], origin: null, platform: null, message: error.message });
      setLoading(false);
    });
    if (liveOnScreen(project.id)) void live.findHere(project.id).then((h) => { if (current) setHere(h); }).catch(() => {});
    return () => { current = false; };
  }, [live, project.id, attempt]);

  const index = useMemo(() => (ready ? answer?.result?.items ?? [] : []), [ready, answer]);
  const indexIds = useMemo(() => new Set(index.map((i) => i.id)), [index]);
  const byUrl = useMemo(() => new Map(index.map((i) => [norm(i.url), i])), [index]);

  // The page shown, when the index does not list it (older content): ask the site for it by its heading.
  const hereInIndex = useMemo(() => hereItem(index, here), [index, here]);
  useEffect(() => {
    if (!live || !ready || !here || hereInIndex || !here.ids.length) return undefined;
    const name = here.heading || here.title.split(/\s[|–—-]\s/)[0]?.trim() || '';
    if (name.length < 2) return undefined;
    let current = true;
    void live.find(project.id, name).then((a) => { if (current) setHereFound(hereItem(a.result?.items ?? [], here)); }).catch(() => {});
    return () => { current = false; };
  }, [live, ready, here, hereInIndex, project.id]);
  const thisPage = hereInIndex ?? hereFound;

  // The site's own search, once typing pauses: content beyond the index's recent pages.
  const jump = useMemo(() => directJump(q, platform, origin), [q, platform, origin]);
  useEffect(() => {
    if (!live || !ready || !q || (q.length < 2 && asked?.q !== q) || q.startsWith('/')) return undefined;
    const kept = keptSearch(project.id, q);
    if (kept) { setSearch({ q, result: kept, error: null }); return undefined; }
    let current = true;
    const timer = window.setTimeout(() => {
      live.find(project.id, q).then((a) => {
        if (!current) return;
        if (a.state === 'ready' && a.result) { keepSearch(project.id, q, a.result); setSearch({ q, result: a.result, error: null }); }
        else setSearch({ q, result: null, error: a.message ?? 'The site did not search.' });
      }, (error: Error) => { if (current) setSearch({ q, result: null, error: error.message }); });
    }, 160);
    return () => { current = false; window.clearTimeout(timer); };
  }, [live, ready, q, asked, project.id]);
  const searched = search?.q === q ? search : null;
  const searching = !!live && ready && !!q && !searched && (q.length >= 2 || asked?.q === q) && !q.startsWith('/');

  /* ── what to show ── */

  const { sections, total, matched } = useMemo(() => {
    const now = Date.now();
    const visitMap = new Map<string, Visit>();
    for (const v of visits) visitMap.set(v.id, v);
    const seenUrls = new Set(byUrl.keys());
    const known: FindItem[] = [];
    const sourceOf = new Map<FindItem, Source>();
    for (const k of answer?.known ?? []) {
      const key = norm(k.url);
      if (seenUrls.has(key)) continue;
      seenUrls.add(key);
      const item: FindItem = { id: `path:${k.url}`, kind: guessKind(k.url), label: k.label, url: k.url };
      known.push(item);
      sourceOf.set(item, 'known');
    }
    const fromVisits: FindItem[] = [];
    for (const v of visits) {
      if (indexIds.has(v.id) || seenUrls.has(norm(v.url)) || v.id.startsWith('task:')) continue;
      seenUrls.add(norm(v.url));
      const item: FindItem = { id: v.id, kind: v.kind, label: v.label, url: v.url };
      fromVisits.push(item);
      sourceOf.set(item, 'visit');
    }
    const fromSearch = (searched?.result?.items ?? []).filter((i) => !indexIds.has(i.id));
    for (const i of fromSearch) sourceOf.set(i, 'search');
    const tasks: FindItem[] = [];
    if (thisPage) {
      const add = (label: string, url: string): void => {
        const t: FindItem = { id: `task:${thisPage.id}:${label.toLowerCase()}`, kind: thisPage.kind, label, url };
        // A task is found by its name ("rev" is Revisions), not by its address, which every task of the page shares.
        PREPARED.set(t, prepare({ label, url: '' }));
        tasks.push(t);
        sourceOf.set(t, 'task');
      };
      if (thisPage.edit) add('Edit', thisPage.edit);
      for (const a of thisPage.actions ?? []) if (!/^edit$/i.test(a.label) || !thisPage.edit) add(a.label, a.url);
    }
    const row = (item: FindItem, source: Source, match?: Match): Row => ({
      key: `${source}:${item.id}`, item, source, positions: match?.positions ?? [], via: match?.via ?? null,
      of: source === 'task' ? thisPage : null, jump: null,
    });
    // A path typed is matched against addresses as words: "/admin/str" finds Structure's pages.
    const words = q.startsWith('/') ? q.replace(/[/?=&_.+-]+/g, ' ').trim() : q;
    const all = [...index, ...fromSearch, ...known, ...fromVisits];
    const out: Section[] = [];

    if (!q) {
      // This page's own tasks, where the owner has been, and what the owner goes to most.
      if (tasks.length) out.push({ group: 'This page', title: `This page · ${thisPage?.label ?? ''}`, rows: tasks.slice(0, 7).map((t) => row(t, 'task')), more: 0 });
      const hereKey = here ? norm(here.path) : null;
      const taken = new Set<string>();
      const take = (url: string): boolean => { const k = norm(url); if (taken.has(k)) return false; taken.add(k); return true; };
      if (hereKey) taken.add(hereKey);
      if (thisPage) taken.add(norm(thisPage.url));
      const resolve = (v: Visit): FindItem | undefined => index.find((i) => i.id === v.id) ?? fromVisits.find((i) => i.id === v.id);
      // The most used first (chosen at least twice), so where the owner has just been does not crowd them out.
      const used: Row[] = [];
      for (const v of [...visits].filter((x) => x.count >= 2 && !x.id.startsWith('task:')).sort((a, b) => frecency(b, now) - frecency(a, now))) {
        if (used.length >= 5) break;
        const item = resolve(v);
        if (item && take(item.url)) used.push(row(item, sourceOf.get(item) ?? 'index'));
      }
      // Then where the owner has been: the view's own history, newest first, then what was chosen here lately.
      const recent: Row[] = [];
      for (const k of (answer?.known ?? []).filter((x) => x.from === 'history')) {
        if (recent.length >= 4) break;
        const item = byUrl.get(norm(k.url)) ?? known.find((x) => x.url === k.url) ?? { id: `path:${k.url}`, kind: guessKind(k.url), label: k.label, url: k.url };
        if (take(item.url)) recent.push(row(item, sourceOf.get(item) ?? 'index'));
      }
      for (const v of [...visits].sort((a, b) => b.last - a.last)) {
        if (recent.length >= 4) break;
        const item = v.id.startsWith('task:') ? undefined : resolve(v);
        if (item && take(item.url)) recent.push(row(item, sourceOf.get(item) ?? 'index'));
      }
      if (recent.length) out.push({ group: 'Recent', title: 'Recent', rows: recent, more: 0 });
      if (used.length) out.push({ group: 'Most used', title: 'Most used', rows: used, more: 0 });
      if (!ready) {
        // Without the helper, the pages this page links to are most of what there is to go to.
        const links = known.filter((i) => !taken.has(norm(i.url)));
        if (links.length) out.push({ group: 'Pages', title: 'Pages the live view knows', rows: links.slice(0, 8).map((i) => row(i, 'known')), more: Math.max(0, links.length - 8) });
      } else if (!used.length) {
        // Nothing chosen often yet: the site's top-level admin.
        const start = index.filter((i) => i.kind === 'admin' && (i.trail?.length ?? 0) <= 1 && !taken.has(norm(i.url))).slice(0, 8);
        if (start.length) out.push({ group: 'Admin', title: 'Admin', rows: start.map((i) => row(i, sourceOf.get(i) ?? 'index')), more: 0 });
      }
      const count = out.reduce((n, s) => n + s.rows.length, 0);
      return { sections: out, total: all.length, matched: count };
    }

    // Typed: a path or an id first, then everything that matches, grouped, the best group first.
    if (jump) {
      // Exactly what was typed opens (node/12/edit is the edit form); what it names gives the title, edit form and tasks.
      const found = all.find((i) => jump.ids.includes(i.id)) ?? byUrl.get(norm(jump.url)) ?? null;
      const item: FindItem = found ? { ...found, url: jump.url } : { id: `path:${jump.url}`, kind: guessKind(jump.url), label: jump.url, url: jump.url };
      out.push({ group: 'Go to', title: 'Go to', rows: [{ key: `jump:${jump.url}`, item, source: 'jump', positions: [], via: null, of: found, jump }], more: 0 });
    }
    const ranked = words ? withoutNoise(rank([...tasks, ...all], words, { prepared, visits: visitMap, now })) : [];
    const groupOf = (item: FindItem): GoToGroup => {
      const s = sourceOf.get(item);
      if (s === 'task') return 'This page';
      if (s === 'known') return 'Pages';
      return kindGroup(item.kind);
    };
    for (const g of groupRanked(ranked, (r) => groupOf(r.item))) {
      out.push({ group: g.group, title: g.group === 'This page' && thisPage ? `This page · ${thisPage.label}` : g.group === 'Pages' ? 'Pages the live view knows' : g.group,
        rows: g.rows.map((r) => row(r.item, sourceOf.get(r.item) ?? 'index', r.match)), more: g.more });
    }
    // The site's own search, offered last when it has not been asked for these words (one letter) or it failed.
    if (ready && !q.startsWith('/') && !searching && (searched ? !!searched.error : q.length < 2)) {
      out.push({ group: 'Search the site', title: 'Search the site', more: 0, rows: [{
        key: 'search-site', item: { id: 'search-site', kind: 'content', label: `Search ${host ?? 'the site'} for “${q}”`, url: '/' },
        source: 'search-site', positions: [], via: null, of: null, jump: null,
      }] });
    }
    const serverMore = searched?.result && typeof searched.result.total === 'number' ? Math.max(0, searched.result.total - searched.result.items.length) : 0;
    return { sections: out, total: all.length, matched: ranked.length + (jump ? 1 : 0) + serverMore };
  }, [q, jump, index, indexIds, byUrl, answer, visits, searched, searching, thisPage, here, ready, host]);

  const flat = useMemo(() => sections.flatMap((s) => s.rows), [sections]);
  const active = flat.find((r) => r.key === activeKey) ?? flat[0] ?? null;
  const optionId = (key: string): string => `goto-${uid}-${key.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  const shownCount = flat.filter((r) => r.source !== 'search-site').length;

  // Keep the chosen row in view; the first of a group brings its heading.
  useEffect(() => {
    const key = acting ? `act-${acting.index}` : active?.key;
    if (!key) return;
    const el = document.getElementById(optionId(key));
    const head = el?.parentElement?.firstElementChild?.classList.contains('goto-group-head') && el.parentElement.children[1] === el ? el.parentElement.firstElementChild : null;
    (head ?? el)?.scrollIntoView({ block: 'nearest' });
    if (head) el?.scrollIntoView({ block: 'nearest' });
  }, [active?.key, acting]); // eslint-disable-line react-hooks/exhaustive-deps

  // A count for screen readers, once typing settles.
  useEffect(() => {
    const t = window.setTimeout(() => {
      setAnnounce(searching ? 'Searching the site…' : shownCount ? `${shownCount} result${shownCount === 1 ? '' : 's'}${matched > shownCount ? ` of ${matched}` : ''}.` : q ? 'No results.' : '');
    }, 350);
    return () => window.clearTimeout(t);
  }, [shownCount, matched, searching, q]);

  useEffect(() => {
    if (!flash) return undefined;
    const t = window.setTimeout(() => setFlash(null), 2200);
    return () => window.clearTimeout(t);
  }, [flash]);

  /* ── acting ── */

  const remember = (item: FindItem, label = item.label): void => {
    setVisits(rememberVisit(project.id, { id: item.id, label, url: item.url, kind: item.kind }));
  };

  const where = (row: Row): FindItem => row.item;

  const openInView = async (url: string): Promise<void> => {
    const full = addressOf(origin, url);
    if (!live || !full) { setFlash('That is not an address of this site.'); return; }
    if (liveOnScreen(project.id)) {
      const ok = await live.go(full);
      if (!ok) { setFlash('The live view could not open that address.'); return; }
      onClose('to-page');
      return;
    }
    // From elsewhere in the project: the live view opens, then goes there.
    goWhenShown(project.id, full);
    onClose('away');
    navigate({ name: 'project', projectKey: project.key, view: 'live' });
  };

  const open = (row: Row): void => {
    if (row.source === 'search-site') { setAsked((a) => ({ q, n: (a?.n ?? 0) + 1 })); setSearch(null); return; }
    const item = where(row);
    // What frecency remembers: a task with its page's name, a jump as what it names (or the path), the rest as is.
    if (row.source === 'task' && row.of) remember(item, `${item.label} · ${row.of.label}`);
    else remember(row.source === 'jump' && row.of ? row.of : item);
    void openInView(item.url);
  };

  const editOf = (row: Row): FindItem | null => {
    const item = row.of ?? where(row);
    return item.edit ? item : null;
  };

  const edit = (row: Row): void => {
    const item = editOf(row);
    if (!item?.edit) { setFlash('This one has no edit form you can open.'); return; }
    remember(item);
    const url = addressOf(origin, item.edit);
    if (url && goToEditor()?.({ projectId: project.id, item, url })) { onClose('away'); return; }
    void openInView(item.edit);
  };

  const inBrowser = async (row: Row, path = where(row).url): Promise<void> => {
    if (row.source === 'search-site' || !live) return;
    remember(row.source === 'jump' && row.of ? row.of : where(row));
    const ok = await live.openInBrowser(project.id, path);
    if (ok) onClose('away'); else setFlash('The default browser could not be asked to open that.');
  };

  const copy = (row: Row, path = where(row).url): void => {
    const full = addressOf(origin, path);
    if (!full || row.source === 'search-site') return;
    void navigator.clipboard.writeText(full).then(() => setFlash(`Copied ${full}`), () => setFlash('The clipboard refused the address.'));
  };

  const actsFor = (row: Row): Act[] => {
    const item = where(row);
    const acts: Act[] = [{ key: 'open', label: shown ? 'Open in the live view' : 'Open in the live view (opens it)', icon: 'live', keys: ['Enter'], run: () => open(row) }];
    const editable = editOf(row);
    if (editable) acts.push({ key: 'edit', label: 'Edit', icon: 'pencil', keys: ['Alt', 'Enter'], run: () => edit(row) });
    for (const a of item.actions ?? []) {
      if (/^edit$/i.test(a.label) && editable) continue;
      acts.push({ key: `a-${a.label}-${a.url}`, label: a.label, icon: taskIcon(a.label), keys: null, run: () => { remember(item); void openInView(a.url); } });
    }
    acts.push({ key: 'browser', label: 'Open in the default browser', icon: 'open', keys: ['Mod', 'Enter'], run: () => void inBrowser(row) });
    acts.push({ key: 'copy', label: 'Copy the address', icon: 'copy', keys: ['Mod', 'C'], run: () => copy(row) });
    return acts;
  };

  const acts = acting ? actsFor(acting.row) : [];

  const move = (by: number): void => {
    if (acting) {
      if (!acts.length) return;
      setActing({ ...acting, index: (acting.index + by + acts.length) % acts.length });
      return;
    }
    if (!flat.length) return;
    const at = Math.max(0, flat.findIndex((r) => r.key === active?.key));
    setActiveKey((flat[(at + by + flat.length) % flat.length] as Row).key);
  };

  const showActs = (): boolean => {
    if (!active || active.source === 'search-site') return false;
    setActing({ row: active, index: 0 });
    return true;
  };

  const onKey = (e: ReactKeyboardEvent): void => {
    const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
    const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (acting) setActing(null); else onClose('escape');
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || (mac && e.ctrlKey && !e.metaKey && (e.key === 'n' || e.key === 'p'))) {
      e.preventDefault();
      move(e.key === 'ArrowDown' || e.key === 'n' ? 1 : -1);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.nativeEvent.isComposing) return;
      if (acting) { acts[acting.index]?.run(); return; }
      if (!active) return;
      if (e.altKey && !e.metaKey && !e.ctrlKey) edit(active);
      else if (mod) void inBrowser(active);
      else if (plain || e.shiftKey) open(active);
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      if (acting) { if (e.shiftKey) setActing(null); } else if (!e.shiftKey) showActs();
      return;
    }
    if (e.key === 'ArrowRight' && plain && !acting) {
      const el = input.current;
      // Only from the end of what is typed: elsewhere → moves the caret.
      if (el && el.selectionStart === el.value.length && el.selectionEnd === el.value.length && showActs()) e.preventDefault();
      return;
    }
    if (e.key === 'ArrowLeft' && plain && acting) { e.preventDefault(); setActing(null); return; }
    if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'c') {
      const el = input.current;
      // Selected words copy as words; otherwise ⌘C copies the address.
      if (el && el.selectionStart !== el.selectionEnd) return;
      const row = acting?.row ?? active;
      if (!row) return;
      e.preventDefault();
      copy(row);
    }
  };

  /* ── drawing ── */

  const state = live ? answer?.state ?? null : null;
  const blocked = !live || state === 'off' || state === 'no-site';
  const plan = site.data?.helperPlan ?? null;
  const helperWord = plan?.kind === 'wordpress' ? 'WordPress' : 'Drupal';
  const notice = noticeFor({ live: !!live, state, answer, loading, host, plan: plan && !plan.refused ? plan : null, helperWord, site: site.data ?? null,
    onHelper, onRetry: () => setAttempt((n) => n + 1), onSetUp: () => { onClose('away'); navigate({ name: 'project', projectKey: project.key, view: 'live' }); },
    onSettings: () => { onClose('away'); navigate({ name: 'settings' }); } });
  const placeholder = blocked ? 'Go to a page of the site' : `Go to a page of ${host ?? project.name}: a title, an admin page, a path or an id`;
  const activeId = acting ? optionId(`act-${acting.index}`) : active ? optionId(active.key) : undefined;
  const editKey = active && editOf(active);
  const actsKey = active && active.source !== 'search-site';

  return createPortal(
    <div className="scrim scrim-top" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose('escape'); }}>
      <div className="goto" role="dialog" aria-modal="true" aria-label={`Go to a page of ${host ?? 'the site'}`} onKeyDown={onKey}>
        <div className="goto-input">
          <Icon name="search" />
          <input
            ref={input}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActiveKey(null); setActing(null); }}
            placeholder={placeholder}
            aria-label={`Go to a page of ${host ?? 'the site'}`}
            role="combobox"
            aria-expanded="true"
            aria-autocomplete="list"
            aria-controls={`goto-${uid}-list`}
            aria-activedescendant={activeId}
            aria-describedby={`goto-${uid}-keys`}
            spellCheck={false}
            autoComplete="off"
          />
          {host ? <span className="goto-host mono" title={origin ?? undefined}>{host}</span> : null}
        </div>
        {notice}
        <div className="goto-results" id={`goto-${uid}-list`} role="listbox" aria-label={acting ? `What to do with ${where(acting.row).label}` : 'Pages'}>
          {acting ? (
            <div className="goto-group" role="group" aria-labelledby={`goto-${uid}-acts`}>
              <div className="goto-group-head goto-acts-head" id={`goto-${uid}-acts`} role="presentation">
                <Icon name="back" size={14} />
                <span className="goto-acts-title">{acting.row.of ? `${acting.row.item.label} · ${acting.row.of.label}` : where(acting.row).label}</span>
              </div>
              {acts.map((a, i) => (
                <div key={a.key} id={optionId(`act-${i}`)} role="option" aria-selected={i === acting.index}
                  className={`goto-row goto-act${i === acting.index ? ' active' : ''}`}
                  onMouseMove={() => { if (i !== acting.index) setActing({ ...acting, index: i }); }}
                  onMouseDown={(e) => e.preventDefault()} onClick={() => a.run()}>
                  <Icon name={a.icon} size={16} />
                  <span className="goto-main"><span className="goto-label">{a.label}</span></span>
                  {a.keys ? <Keys keys={a.keys} mac={mac} /> : null}
                </div>
              ))}
            </div>
          ) : blocked ? null : (
            <>
              {sections.map((s) => (
                <div key={s.group} className="goto-group" role="group" aria-labelledby={`goto-${uid}-g-${s.group.replace(/\W/g, '')}`}>
                  <div className="goto-group-head" id={`goto-${uid}-g-${s.group.replace(/\W/g, '')}`} role="presentation">{s.title}</div>
                  {s.rows.map((r) => (
                    <ResultRow key={r.key} row={r} id={optionId(r.key)} active={r.key === active?.key}
                      onHover={() => { if (r.key !== active?.key) setActiveKey(r.key); }}
                      onChoose={(how) => { if (how === 'edit') edit(r); else if (how === 'browser') void inBrowser(r); else open(r); }} mac={mac} />
                  ))}
                  {s.more ? <div className="goto-more" role="presentation">{s.more} more: type more to narrow</div> : null}
                </div>
              ))}
              {!sections.length && q && !searching ? (
                <div className="goto-empty" role="presentation">
                  Nothing {ready ? 'on the site' : 'the live view knows'} matches “{q}”.
                  {ready ? null : ' With the helper, Go to searches the whole site.'}
                </div>
              ) : null}
              {!sections.length && !q && !loading && !notice ? <div className="goto-empty" role="presentation">Nothing to go to yet. Type a path, like /about.</div> : null}
            </>
          )}
        </div>
        <div className="goto-foot" id={`goto-${uid}-keys`}>
          <span className="goto-keys">
            {acting ? (
              <>
                <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
                <span><kbd>{mac ? '↩' : 'Enter'}</kbd> do it</span>
                <span><kbd>←</kbd><kbd>esc</kbd> back</span>
              </>
            ) : (
              <>
                <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
                <span className={active ? undefined : 'off'}><kbd>{mac ? '↩' : 'Enter'}</kbd> open</span>
                <span className={editKey ? undefined : 'off'}><kbd>{mac ? '⌥↩' : 'Alt+Enter'}</kbd> edit</span>
                <span className={actsKey ? undefined : 'off'}><kbd>{mac ? '⌘↩' : 'Ctrl+Enter'}</kbd> browser</span>
                <span className={actsKey ? undefined : 'off'}><kbd>→</kbd> actions</span>
                <span className={actsKey ? undefined : 'off'}><kbd>{mac ? '⌘C' : 'Ctrl+C'}</kbd> copy</span>
                <span><kbd>esc</kbd> close</span>
              </>
            )}
          </span>
          <span className="goto-count" aria-hidden="true">
            {flash ?? (acting ? `${acts.length} things to do` : searching ? 'Searching the site…' : blocked || !shownCount ? '' : `Displaying ${shownCount} of ${q ? matched : total}`)}
          </span>
        </div>
        <div className="visually-hidden" aria-live="polite">{flash ?? announce}</div>
      </div>
    </div>,
    document.body,
  );
}

function Keys({ keys, mac }: { keys: string[]; mac: boolean }) {
  const cap = (k: string): string => (k === 'Mod' ? (mac ? '⌘' : 'Ctrl') : k === 'Alt' ? (mac ? '⌥' : 'Alt') : k === 'Enter' ? (mac ? '↩' : 'Enter') : k);
  return <span className="keycaps">{keys.map((k) => <kbd key={k}>{cap(k)}</kbd>)}</span>;
}

function ResultRow({ row, id, active, onHover, onChoose, mac }: {
  row: Row; id: string; active: boolean; mac: boolean;
  onHover: () => void; onChoose: (how: 'open' | 'edit' | 'browser') => void;
}) {
  const { item } = row;
  const status = item.status ? STATUS_WORD[item.status] : null;
  const meta: ReactNode[] = [];
  if (row.source === 'jump' && row.jump) meta.push(<span key="why">{row.jump.why}</span>);
  if (item.type && row.source !== 'task') meta.push(<span key="type">{item.type}</span>);
  else if ((item.trail?.length ?? 0) > 0 && row.source !== 'task' && !(item.trail?.length === 1 && item.trail[0] === item.label)) meta.push(<span key="trail">{item.trail?.join(' › ')}</span>);
  if (row.via && row.via.text && row.via.field === 'tags') meta.push(<span key="via" className="goto-via">matches “{row.via.text}”</span>);
  if (row.source !== 'search-site') meta.push(<span key="path" className="mono goto-path">{item.url}</span>);
  return (
    <div id={id} role="option" aria-selected={active} className={`goto-row${row.source === 'task' ? ' goto-compact' : ''}${active ? ' active' : ''}`}
      onMouseMove={onHover} onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => onChoose(e.altKey ? 'edit' : (mac ? e.metaKey : e.ctrlKey) ? 'browser' : 'open')}>
      <Icon name={rowIcon(row)} size={16} />
      <span className="goto-main">
        <span className="goto-label"><Marked text={item.label} at={row.positions} /></span>
        {meta.length ? <span className="goto-meta">{meta.map((m, i) => <span key={i} className="goto-meta-part">{m}</span>)}</span> : null}
      </span>
      <span className="goto-side">
        {status ? <span className="goto-status">{status}</span> : null}
        {item.changed ? <span className="goto-when" title={new Date(item.changed).toLocaleString()}>{ago(item.changed)}</span> : null}
        {active && ((item.actions?.length ?? 0) > 0 || item.edit) ? <Icon name="chevron" size={14} /> : null}
      </span>
    </div>
  );
}

/** What stands between the owner and the whole site, said plainly, with the one thing that fixes it. */
function noticeFor(o: {
  live: boolean; state: LiveFindAnswer['state'] | null; answer: LiveFindAnswer | null; loading: boolean; host: string | null;
  plan: LiveSite['helperPlan']; helperWord: string; site: LiveSite | null;
  onHelper: () => void; onRetry: () => void; onSetUp: () => void; onSettings: () => void;
}): ReactNode {
  const box = (icon: IconName, title: string, body: ReactNode, action: ReactNode = null): ReactNode => (
    <div className="goto-notice" role="status">
      <Icon name={icon} size={16} />
      <div className="goto-notice-text">
        <p className="goto-notice-title">{title}</p>
        {body ? <p className="goto-notice-body">{body}</p> : null}
      </div>
      {action ? <div className="goto-notice-action">{action}</div> : null}
    </div>
  );
  if (!o.live) return box('live', 'Go to needs the Wanigan app', 'It finds pages through the live view, which this window does not have.');
  if (!o.state) return o.loading ? <p className="goto-reading" role="status">Reading {o.host ?? 'the site'}’s pages…</p> : null;
  switch (o.state) {
    case 'ready': return null;
    case 'off': return box('live', 'The live view is off', 'Switch it on in Settings › Live view, for this kind of site too.',
      <Button size="s" icon="settings" onClick={o.onSettings}>Open Settings</Button>);
    case 'no-site': return box('live', 'This project has no site in the live view yet', 'Choose the address of its local site first.',
      <Button size="s" tone="primary" onClick={o.onSetUp}>Choose the site</Button>);
    case 'no-helper': return box('plug', o.site?.platform === 'site' ? 'Only the pages the live view has seen' : 'Search the whole site with the helper',
      o.site?.platform === 'site' ? 'Sites other than Drupal and WordPress have no helper, so Go to knows the pages the view has been to and the links on the page it shows.'
        : `Without Wanigan’s ${o.helperWord} helper, Go to knows only the pages the live view has been to and the links on the page it shows.`,
      o.plan ? <Button size="s" icon="plug" onClick={o.onHelper}>Set up the {o.helperWord} helper…</Button> : null);
    case 'outdated': return box('plug', 'This site’s helper is older than this Wanigan', 'Update it to search the whole site; until then Go to knows the pages the live view has seen.',
      o.plan ? <Button size="s" icon="plug" onClick={o.onHelper}>Update the helper…</Button> : null);
    case 'log-in': return box('account', 'Log in to search the whole site', `The ${o.helperWord} helper lists the pages a logged-in user may open. Log in in the live view; until then Go to knows the pages the live view has seen.`);
    case 'refused': return box('plug', 'The site refused the helper', o.answer?.message ?? null,
      o.plan ? <Button size="s" icon="plug" onClick={o.onHelper}>Set the helper up again…</Button> : null);
    case 'down': return box('alert', `Nothing answered at ${o.host ?? 'the site'}`, 'Start the site (for ddev: ddev start in the project folder), then try again. Pages the live view has seen are still here.',
      <Button size="s" icon="refresh" onClick={o.onRetry}>Try again</Button>);
    case 'failed': return box('alert', 'The site’s helper did not answer as expected', o.answer?.message ?? null,
      <Button size="s" icon="refresh" onClick={o.onRetry}>Try again</Button>);
  }
}
