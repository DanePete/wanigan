// Compare: the page the live view shows, on the local site and on a hosted
// environment, or as it was before (a picture Wanigan kept of it on this site,
// for a site with no hosted environment: one being built, or with only a dev
// copy), taken whole at the same width and laid over each other. The
// two pictures are taken when the owner presses Compare (or changes the width
// or the environment), never otherwise: that is when Wanigan asks the hosted
// site for the page. The viewer itself is CompareViewer.
//
// It is drawn in the stage, where the page is: the bar, the side panel and the
// dock stay as they were. The site's own view steps aside while it shows (as it
// does for a dialog), without loading anything, so leaving Compare (Escape, or
// its close button) puts the live page back exactly as it was.
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { LiveCompareShot, LiveKeptPage } from '@shared/bridge';
import type { LiveSite } from '@shared/live';
import { COMPARE_WIDTHS, type CompareWidth, type Rect } from '@shared/live-compare';
import { pagePath, samePage, type LiveEnv, type LiveMask } from '@shared/live-envs';
import type { ProjectSummary } from '@shared/model';
import { attempt, call } from '../../lib/api';
import { ago } from '../../lib/format';
import { liveBridge, useCoversLive } from '../../lib/live';
import { Button, EmptyState, IconButton, Segmented, useToast } from '../ui';
import { CompareViewer, type CompareSide } from './CompareViewer';
import { Select } from '../Select';
import '../../styles/live-compare.css';

const WIDTH_LABEL: Record<CompareWidth, string> = { 390: 'Phone · 390', 768: 'Tablet · 768', 1440: 'Desktop · 1440' };

type Taken = { shot: Extract<LiveCompareShot, { data: string }>; side: CompareSide } | { error: string };

/** Compare's other side when it is the page as it was: a picture Wanigan kept of it on this site. */
const BEFORE = 'before';
/** The widths pages are kept at (Verify's): Before is compared at these. */
const KEPT_WIDTHS = [390, 1440] as const;
const keptWords = (k: LiveKeptPage): string => (k.why === 'made-real' ? `${k.label ?? 'An edit'} made real, ${ago(k.at)}` : `Kept by you, ${ago(k.at)}`);

/** Compare, in the stage: which environment, which width, the two pictures, and the viewer over them. */
export function ComparePanel({ project, site, envs, masks, page, shownEnv, width: initialWidth, components, onClose }: {
  project: ProjectSummary;
  site: LiveSite;
  /** The hosted environments kept (none for a site with no hosted one: Compare is with Before). */
  envs: readonly LiveEnv[];
  /** Every ignored area of the site; the ones for this page and width apply. */
  masks: readonly LiveMask[];
  /** The page the view shows, local or hosted. */
  page: string;
  /** The hosted environment the view shows, or null for the local site. */
  shownEnv: string | null;
  width: CompareWidth;
  components?: ReadonlyMap<string, string>;
  onClose: () => void;
}) {
  const toast = useToast();
  const live = liveBridge();
  const titleId = useId();
  const base = site.url as string;
  // The site's view steps aside while Compare is drawn where it was; nothing is loaded again when it comes back.
  useCoversLive(true);
  // Escape, in Compare or with nothing focused, goes back to the page; the keyboard goes back where it was.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
      const t = e.target instanceof Element ? e.target : null;
      if (t && t !== document.body && !t.closest('.live-stage-compare')) return;
      if (t?.closest('textarea, select, [role="menu"], .sel-list') || document.querySelector('[aria-modal="true"], .sel-list')) return;
      e.preventDefault();
      close.current();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (before?.isConnected && (!document.activeElement || document.activeElement === document.body)) before.focus({ preventScroll: true });
    };
  }, []);
  // The page as it was when Compare was pressed: the view under it does not move it.
  const [opened] = useState(page);
  const [other, setOther] = useState<string>(() => shownEnv ?? envs[envs.length - 1]?.id ?? BEFORE);
  const [width, setWidth] = useState<CompareWidth>(initialWidth);
  const [again, setAgain] = useState(0);
  const before = other === BEFORE || !envs.length;
  const env = before ? null : envs.find((e) => e.id === other) ?? envs[envs.length - 1] ?? null;
  // Before: the pictures kept of this page, newest first, which one, and at a width it was kept at.
  const [kept, setKept] = useState<LiveKeptPage[] | null>(null);
  const [keptId, setKeptId] = useState<string | null>(null);
  const [keeping, setKeeping] = useState(false);
  const keptWidth = width === 390 ? 390 : 1440;
  const chosen = kept?.find((k) => k.id === keptId) ?? null;
  const shownBase = envs.find((e) => e.id === shownEnv)?.url ?? base;
  const localUrl = samePage(opened, shownBase, base);
  const hostedUrl = env ? samePage(localUrl, base, env.url) : null;
  const envId = env?.id ?? null;
  const envName = env?.name ?? '';
  const path = pagePath(localUrl, base);
  const [taken, setTaken] = useState<{ a: Taken; b: Taken } | null>(null);

  useEffect(() => {
    if (!live || before || !envId || !hostedUrl) return undefined;
    let current = true;
    const hosted = { id: envId, name: envName };
    setTaken(null);
    const take = async (url: string, from: { id: string } | null, label: string): Promise<Taken> => {
      const shot = await live.compareShot({ projectId: project.id, url, env: from?.id ?? null, width, token: from ? null : site.token, scan: !from })
        .catch((e: Error) => ({ error: e.message }));
      return 'error' in shot ? shot : { shot, side: { label, src: `data:image/png;base64,${shot.data}` } };
    };
    void Promise.all([take(localUrl, null, 'Local'), take(hostedUrl, hosted, hosted.name)]).then(([a, b]) => { if (current) setTaken({ a, b }); });
    return () => { current = false; };
    // By id and name, not the object: the list is fetched again when an area is ignored, and that must not take the pictures again.
  }, [live, before, project.id, site.token, localUrl, hostedUrl, envId, envName, width, again]);

  // Before: what is kept of this page, read when Compare opens on it and after a page is kept.
  useEffect(() => {
    if (!live || !before) return undefined;
    let current = true;
    void live.layerKept().then((list) => {
      if (!current) return;
      setKept(list);
      setKeptId((id) => (id && list.some((k) => k.id === id) ? id : list[0]?.id ?? null));
    }, () => { if (current) setKept([]); });
    return () => { current = false; };
  }, [live, before, again]);
  // And the two pictures: the one kept, and the page as it renders now, the same way, held at the same time.
  useEffect(() => {
    if (!live || !before || !keptId) return undefined;
    let current = true;
    setTaken(null);
    const label = kept?.find((k) => k.id === keptId);
    void live.layerKeptShot(keptId, keptWidth).then((r) => {
      if (!current) return;
      if ('error' in r) { setTaken({ a: { error: r.error }, b: { error: r.error } }); return; }
      const side = (shot: LiveCompareShot, name: string): Taken => ('error' in shot ? shot : { shot, side: { label: name, src: `data:image/png;base64,${shot.data}` } });
      setTaken({ a: side(r.before, label ? `Before · ${ago(label.at)}` : 'Before'), b: side(r.now, 'Now') });
    }, (e: Error) => { if (current) setTaken({ a: { error: e.message }, b: { error: e.message } }); });
    return () => { current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- by id: the list read again must not take the pictures again
  }, [live, before, keptId, keptWidth, again]);
  const keepNow = async (): Promise<void> => {
    if (!live || keeping) return;
    setKeeping(true);
    try {
      const got = await live.layerKeep().catch((e: Error) => ({ error: e.message }));
      if ('error' in got) { toast(got.error, 'error'); return; }
      toast(`Kept ${path} as it is now, at ${got.widths.join(' and ')} px: change it, then compare with Before.`, 'done');
      setKeptId(got.id);
      setAgain((n) => n + 1);
    } finally {
      setKeeping(false);
    }
  };

  const here = useMemo(() => masks.filter((m) => m.width === width && (m.path === null || m.path === path)), [masks, width, path]);
  const ignore = async (rect: Rect, label: string | null, scope: 'page' | 'site'): Promise<void> => {
    const done = await attempt(() => call('live.mask', { projectId: project.id, path: scope === 'page' ? path : null, width, rect, label }), (m) => toast(m, 'error'));
    if (done) toast(`${label ?? 'That area'} is left out of comparisons at ${width} px, ${scope === 'page' ? 'on this page' : 'on every page'}.`);
  };
  const unmask = async (mask: LiveMask): Promise<void> => {
    await attempt(() => call('live.unmask', { projectId: project.id, id: mask.id }), (m) => toast(m, 'error'));
  };

  const a = taken && 'shot' in taken.a ? taken.a : null;
  const b = taken && 'shot' in taken.b ? taken.b : null;
  const regions = (before ? b?.shot.regions : a?.shot.regions) ?? [];
  const status = (t: typeof a, name: string): string | null => (t && t.shot.status >= 400 ? `${name} answered ${t.shot.status} for this page, so its picture is that answer.` : null);
  const notes = [status(a, before ? 'Before' : 'Local'), status(b, before ? 'Now' : env?.name ?? ''),
    a?.shot.cut || b?.shot.cut ? `A page taller than ${before ? '6,000' : '8,000'} px is compared down to there.` : null].filter(Boolean);
  const host = (() => { try { return hostedUrl ? new URL(hostedUrl).host : ''; } catch { return ''; } })();

  return (
    <section className="live-stage-compare" aria-labelledby={titleId}>
      <div className="cmp-head">
        <h2 className="live-stage-compare-title" id={titleId}>{before ? 'Before and now' : env ? `Local and ${env.name}` : 'Compare'}</h2>
        {envs.length ? (
          <Segmented<string> size="s" label="Compare Local with" value={before ? BEFORE : env?.id ?? ''} onChange={setOther}
            options={[...envs.map((e) => ({ value: e.id, label: e.name, hint: e.url })), { value: BEFORE, label: 'Before', hint: 'A picture Wanigan kept of this page on this site' }]} />
        ) : null}
        {before && kept?.length ? (
          <Select<string> size="s" label="Which picture of the page" value={keptId ?? ''} onChange={setKeptId}
            options={kept.map((k) => ({ value: k.id, label: keptWords(k), detail: `At ${k.widths.join(' and ')} px` }))} />
        ) : null}
        <Segmented<CompareWidth> size="s" label="Width" value={before ? keptWidth : width} onChange={setWidth}
          options={(before ? COMPARE_WIDTHS.filter((w) => (KEPT_WIDTHS as readonly number[]).includes(w)) : COMPARE_WIDTHS).map((w) => ({ value: w, label: WIDTH_LABEL[w], hint: `${w} CSS pixels wide (${COMPARE_WIDTHS.indexOf(w) + 1})` }))} />
        {before ? <Button size="s" tone="quiet" icon="camera" disabled={!live || keeping} onClick={() => void keepNow()} data-tip="Keep this page as it is now, to compare with after it changes">{keeping ? 'Keeping…' : 'Keep this page'}</Button> : null}
        <span className="small cmp-path" data-tip={localUrl}>Page <span className="mono">{path}</span></span>
        <Button size="s" tone="quiet" icon="refresh" disabled={!taken} onClick={() => setAgain((n) => n + 1)}>Take again</Button>
        <IconButton icon="close" label="Back to the page (Escape)" onClick={onClose} />
      </div>
      {before ? (
        <p className="cmp-note small">
          {chosen ? <><strong>Before</strong> is this page as Wanigan kept it on this site: {keptWords(chosen)}. <strong>Now</strong> is the page as it renders now, without the layer, held at the same time.</>
            : <>No hosted environment is needed: <strong>Before</strong> is a picture Wanigan keeps of this page on this site, when a card is made real or when you keep one.</>}
        </p>
      ) : (
        <p className="cmp-note small">
          <strong>Content is not code.</strong> Words, pictures or list items that differ usually mean the local database is older than {env?.name ?? 'the hosted one'}’s,
          not that the code changed. Bring a fresh copy of the database down to compare the code alone.
        </p>
      )}
      {!live ? (
        <p className="faint">Comparing needs the Wanigan app: this window cannot take pictures of a page.</p>
      ) : before && kept && !kept.length ? (
        <EmptyState icon="compare" title="Nothing kept of this page yet"
          action={<Button size="s" icon="camera" disabled={keeping} onClick={() => void keepNow()}>{keeping ? 'Keeping the page…' : 'Keep this page as it is'}</Button>}>
          Wanigan keeps this page as it was each time a card on it is made real. Keep it now, change it (or let an agent change it), then compare.
        </EmptyState>
      ) : !taken ? (
        <div className="cmp-wait" role="status">
          {before ? <p>Rendering {path} as it is now at {keptWidth} px, to lay over the picture kept {chosen ? ago(chosen.at) : 'before'}…</p> : (
            <>
              <p>Taking the page whole at {width} px, on Local and on {env?.name}…</p>
              <p className="faint small">Wanigan is asking {host} for {path} now, because you pressed Compare.</p>
            </>
          )}
        </div>
      ) : !a || !b ? (
        <div className="cmp-wait" role="alert">
          {before ? ('error' in taken.a ? <p>{taken.a.error}</p> : null) : (
            <>
              {'error' in taken.a ? <p>Local: {taken.a.error}</p> : null}
              {'error' in taken.b ? <p>{env?.name}: {taken.b.error}</p> : null}
            </>
          )}
          <Button size="s" icon="refresh" onClick={() => setAgain((n) => n + 1)}>Try again</Button>
        </div>
      ) : (
        <>
          {notes.length ? <p className="cmp-note small">{notes.join(' ')}</p> : null}
          <CompareViewer a={a.side} b={b.side} width={before ? keptWidth : width} regions={regions} components={components} masks={here} keysWithin=".live-stage-compare"
            onIgnore={(r, l, s) => void ignore(r, l, s)} onUnmask={(m) => void unmask(m)} onWidth={setWidth} />
        </>
      )}
    </section>
  );
}
