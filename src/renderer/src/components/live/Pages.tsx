// The Structure panel's Pages tab: Go to's list of the site's pages, to walk
// rather than type. The same index Go to searches (LiveBridge.find: the site
// helper's destinations, kept from the last time it was read), grouped as Go to
// groups it, filtered by every word typed, the page shown marked. Choosing one
// opens it in the view, and Go to remembers it as chosen. Without the helper
// it lists the pages the view has seen and the page shown links to, and says
// why there are no more, with Go to (which offers the helper) one press away.
import { useEffect, useMemo, useState } from 'react';
import type { FindItem } from '@shared/live-find';
import { addressOf, kindGroup, prepare, rank, type GoToGroup, type LiveFindAnswer, type Prepared } from '@shared/live-goto';
import type { ProjectSummary } from '@shared/model';
import { liveBridge } from '../../lib/live';
import { keepAnswer, keptAnswer, loadVisits, rememberVisit } from '../../lib/live-goto';
import { Icon, type IconName } from '../icons';
import { Button, EmptyState, IconButton, tipProps } from '../ui';
import { LIVE_TIP } from './keys';

const ORDER: readonly GoToGroup[] = ['Content', 'Admin', 'Structure', 'Templates', 'Settings'];
const KIND_ICON: Record<FindItem['kind'], IconName> = {
  content: 'content', term: 'pieces', user: 'account', media: 'image', admin: 'menu', structure: 'layers', template: 'file', setting: 'settings', view: 'list',
};
/** How many of a group show before More: a big site's index runs to thousands. */
const FIRST = 40;

const prepared = new WeakMap<FindItem, Prepared>();
const prep = (item: FindItem): Prepared => {
  let p = prepared.get(item);
  if (!p) { p = prepare(item); prepared.set(item, p); }
  return p;
};

/** A path as the site compares it: without a trailing slash, any case. */
const norm = (path: string): string => {
  const [p = '', q = ''] = path.split('?');
  return `${(p.length > 1 ? p.replace(/\/+$/, '') : p).toLowerCase()}${q ? `?${q}` : ''}`;
};

export function PagesTab({ project, page, origin: hosted, onGoTo }: {
  project: ProjectSummary;
  /** The address the view shows: its page is marked. */
  page: string | null;
  /** A hosted environment's address, when the view shows one: pages open there, as Go to opens them. */
  origin: string | null;
  /** Open Go to (it searches the site, and offers the helper where there is none). */
  onGoTo: () => void;
}) {
  const live = liveBridge();
  const [answer, setAnswer] = useState<LiveFindAnswer | null>(() => keptAnswer(project.id));
  const [asking, setAsking] = useState(false);
  const [query, setQuery] = useState('');
  const [more, setMore] = useState<ReadonlySet<GoToGroup>>(new Set());
  const ask = async (refresh: boolean): Promise<void> => {
    if (!live) return;
    setAsking(true);
    const a = await live.find(project.id, '', refresh ? { refresh: true } : undefined)
      .catch((e: Error): LiveFindAnswer => ({ state: 'failed', result: null, known: [], origin: null, platform: null, message: e.message }));
    keepAnswer(project.id, a);
    setAnswer(a);
    setAsking(false);
  };
  useEffect(() => { void ask(false); }, [project.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const items = useMemo<FindItem[]>(() => {
    if (!answer) return [];
    if (answer.state === 'ready') return answer.result?.items ?? [];
    // Without the helper's index: what the view has seen, and what the page shown links to.
    return answer.known.map((k) => ({ id: `path:${k.url}`, kind: 'content' as const, label: k.label, url: k.url }));
  }, [answer]);
  const q = query.trim();
  const shown = useMemo(() => {
    if (!q) return items;
    const visits = new Map(loadVisits(project.id).map((v) => [v.id, v]));
    return rank(items, q, { prepared: prep, visits, now: Date.now() }).map((r) => r.item);
  }, [items, q, project.id]);
  const groups = useMemo(() => {
    const by = new Map<GoToGroup, FindItem[]>();
    for (const item of shown) {
      const g = answer?.state === 'ready' ? kindGroup(item.kind) : 'Pages';
      by.set(g, [...(by.get(g) ?? []), item]);
    }
    return [...by.entries()].sort((a, b) => (ORDER.indexOf(a[0]) + 99) % 99 - (ORDER.indexOf(b[0]) + 99) % 99);
  }, [shown, answer?.state]);
  const here = (() => { try { return page ? norm(`${new URL(page).pathname}${new URL(page).search}`) : null; } catch { return null; } })();
  const base = hosted ?? answer?.origin ?? null;

  const open = (item: FindItem): void => {
    const full = addressOf((() => { try { return base ? new URL(base).origin : null; } catch { return null; } })(), item.url);
    if (!live || !full) return;
    rememberVisit(project.id, { id: item.id, label: item.label, url: item.url, kind: item.kind });
    void live.go(full);
  };

  if (!answer) {
    return (
      <div className="live-skeleton" role="status" aria-label="Reading the site’s pages…">
        {[0, 1, 2, 3, 4, 5].map((i) => <span key={i} className="live-skeleton-row" />)}
      </div>
    );
  }
  const why = answer.state === 'ready' ? null : answer.message ?? (answer.state === 'no-helper'
    ? 'Without the site helper the live view knows only the pages it has shown and the links on the page shown.'
    : 'The site did not list its pages.');
  return (
    <div className="live-pages">
      <div className="live-library-find">
        <label className="search-field">
          <Icon name="search" size={14} />
          <span className="visually-hidden">Filter the pages</span>
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Title, path or type" />
        </label>
        <IconButton icon="refresh" size="s" label={asking ? 'Reading the site…' : 'Read the site’s pages again'} disabled={asking} onClick={() => ask(true)}
          data-loading={asking ? '' : undefined} />
      </div>
      {why ? (
        <div className="live-pages-why" role="status">
          <p className="small">{why}</p>
          <Button size="s" icon="search" keys={LIVE_TIP.goto} onClick={onGoTo}>Go to a page…</Button>
        </div>
      ) : null}
      {q ? <p className="faint small" role="status">{shown.length === 1 ? '1 page matches' : `${shown.length} pages match`}.</p> : null}
      {groups.map(([group, list]) => {
        const all = more.has(group) || q;
        const rows = all ? list : list.slice(0, FIRST);
        return (
          <section key={group} className="live-pages-group" aria-label={group}>
            <h3 className="section-label">{group} <span className="tab-count">{list.length}</span></h3>
            <ul className="live-pages-list">
              {rows.map((item) => {
                const current = here !== null && norm(item.url) === here;
                return (
                  <li key={item.id}>
                    <button type="button" className={`live-page-row${current ? ' on' : ''}`} aria-current={current ? 'page' : undefined} onClick={() => open(item)}
                      {...tipProps(item.url, null, 'right')}>
                      <Icon name={KIND_ICON[item.kind]} size={14} />
                      <span className="live-page-label">{item.label}</span>
                      {item.status && item.status !== 'published' ? <span className="live-page-meta">{item.status}</span>
                        : item.type ? <span className="live-page-meta">{item.type}</span> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
            {rows.length < list.length ? (
              <Button size="s" tone="quiet" onClick={() => setMore((m) => new Set([...m, group]))}>{`Show all ${list.length}`}</Button>
            ) : null}
          </section>
        );
      })}
      {!groups.length ? (
        <EmptyState icon="live" title={q ? 'No page matches' : 'No pages yet'}>
          {q ? 'Go to also searches the site’s content as you type.' : 'Pages the view shows are listed here as you go.'}
        </EmptyState>
      ) : null}
    </div>
  );
}
