// Compare: the page the live view shows, on the local site and on a hosted
// environment, taken whole at the same width and laid over each other. The
// two pictures are taken when the owner presses Compare (or changes the width
// or the environment), never otherwise: that is when Wanigan asks the hosted
// site for the page. The viewer itself is CompareViewer.
import { useEffect, useMemo, useState } from 'react';
import type { LiveCompareShot } from '@shared/bridge';
import type { LiveSite } from '@shared/live';
import { COMPARE_WIDTHS, type CompareWidth, type Rect } from '@shared/live-compare';
import { pagePath, samePage, type LiveEnv, type LiveMask } from '@shared/live-envs';
import type { ProjectSummary } from '@shared/model';
import { attempt, call } from '../../lib/api';
import { liveBridge } from '../../lib/live';
import { Button, Dialog, Segmented, useToast } from '../ui';
import { CompareViewer, type CompareSide } from './CompareViewer';
import '../../styles/live-compare.css';

const WIDTH_LABEL: Record<CompareWidth, string> = { 390: 'Phone · 390', 768: 'Tablet · 768', 1440: 'Desktop · 1440' };

type Taken = { shot: Extract<LiveCompareShot, { data: string }>; side: CompareSide } | { error: string };

/** The dialog: which environment, which width, the two pictures, and the viewer over them. */
export function CompareDialog({ project, site, envs, masks, page, shownEnv, width: initialWidth, components, onClose }: {
  project: ProjectSummary;
  site: LiveSite;
  /** The hosted environments kept (at least one). */
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
  const base = site.url as string;
  // The page as it was when Compare was pressed: the view under the dialog does not move it.
  const [opened] = useState(page);
  const [other, setOther] = useState<string>(() => shownEnv ?? envs[envs.length - 1]?.id ?? '');
  const [width, setWidth] = useState<CompareWidth>(initialWidth);
  const [again, setAgain] = useState(0);
  const env = envs.find((e) => e.id === other) ?? envs[envs.length - 1] ?? null;
  const shownBase = envs.find((e) => e.id === shownEnv)?.url ?? base;
  const localUrl = samePage(opened, shownBase, base);
  const hostedUrl = env ? samePage(localUrl, base, env.url) : null;
  const envId = env?.id ?? null;
  const envName = env?.name ?? '';
  const path = pagePath(localUrl, base);
  const [taken, setTaken] = useState<{ a: Taken; b: Taken } | null>(null);

  useEffect(() => {
    if (!live || !envId || !hostedUrl) return undefined;
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
  }, [live, project.id, site.token, localUrl, hostedUrl, envId, envName, width, again]);

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
  const regions = a?.shot.regions ?? [];
  const status = (t: typeof a, name: string): string | null => (t && t.shot.status >= 400 ? `${name} answered ${t.shot.status} for this page, so its picture is that answer.` : null);
  const notes = [status(a, 'Local'), status(b, env?.name ?? ''), a?.shot.cut || b?.shot.cut ? 'A page taller than 8,000 px is compared down to there.' : null].filter(Boolean);
  const host = (() => { try { return hostedUrl ? new URL(hostedUrl).host : ''; } catch { return ''; } })();

  return (
    <Dialog title={env ? `Local and ${env.name}` : 'Compare'} width={1320} onClose={onClose}>
      <div className="cmp-head">
        {envs.length > 1 ? (
          <Segmented<string> size="s" label="Compare Local with" value={env?.id ?? ''} options={envs.map((e) => ({ value: e.id, label: e.name, hint: e.url }))} onChange={setOther} />
        ) : null}
        <Segmented<CompareWidth> size="s" label="Width" value={width} options={COMPARE_WIDTHS.map((w) => ({ value: w, label: WIDTH_LABEL[w], hint: `${w} CSS pixels wide (${COMPARE_WIDTHS.indexOf(w) + 1})` }))} onChange={setWidth} />
        <span className="small cmp-path" title={localUrl}>Page <span className="mono">{path}</span></span>
        <Button size="s" tone="quiet" icon="refresh" disabled={!taken} onClick={() => setAgain((n) => n + 1)}>Take again</Button>
      </div>
      <p className="cmp-note small">
        <strong>Content is not code.</strong> Words, pictures or list items that differ usually mean the local database is older than {env?.name ?? 'the hosted one'}’s,
        not that the code changed. Bring a fresh copy of the database down to compare the code alone.
      </p>
      {!live ? (
        <p className="faint">Comparing needs the Wanigan app: this window cannot take pictures of a page.</p>
      ) : !taken ? (
        <div className="cmp-wait" role="status">
          <p>Taking the page whole at {width} px, on Local and on {env?.name}…</p>
          <p className="faint small">Wanigan is asking {host} for {path} now, because you pressed Compare.</p>
        </div>
      ) : !a || !b ? (
        <div className="cmp-wait" role="alert">
          {'error' in taken.a ? <p>Local: {taken.a.error}</p> : null}
          {'error' in taken.b ? <p>{env?.name}: {taken.b.error}</p> : null}
          <Button size="s" icon="refresh" onClick={() => setAgain((n) => n + 1)}>Try again</Button>
        </div>
      ) : (
        <>
          {notes.length ? <p className="cmp-note small">{notes.join(' ')}</p> : null}
          <CompareViewer a={a.side} b={b.side} width={width} regions={regions} components={components} masks={here}
            onIgnore={(r, l, s) => void ignore(r, l, s)} onUnmask={(m) => void unmask(m)} onWidth={setWidth} />
        </>
      )}
    </Dialog>
  );
}
