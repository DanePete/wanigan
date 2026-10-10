// The design layer's tray, in the live view's side panel (Edits, ⇧E): every
// edit of the project, grouped by the page it was made on, the page shown
// first. Design: docs/design/2026-10-09-design-layer.md, "Where it lives" and
// "Phase 1, as contracted".
//
// - Each edit says what it is, before → after, what it reaches in words, its
//   state (and the last verification's verdict), and plainly when it is
//   fragile or orphaned, with why.
// - Per edit: Discard (a draft or an orphaned one), Make it real (words through
//   the site; when nothing the site stores holds them, the template that rendered
//   the element, as its own action that says its reach first: TemplateSave.tsx; a
//   style or token goes to an agent as intent, through the note the Inspector
//   writes, never by starting a session), Verify (the site against the design
//   and the page as it was before, with the step that failed, each difference,
//   what was left out and why, what was held still, how far down a long page
//   was compared, and the pictures), Retire (verified).
// - Undo and redo say what they would do; the page can be shown without the
//   layer, to compare. After every change the log is read again and the layer
//   applied to the page again (use-layer.ts).
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { LayerEdit, LayerImplemented, LayerVerdict } from '@shared/design-layer';
import type { LiveComponent, LiveEdit, LiveRegion } from '@shared/live';
import type { PartIndex } from '@shared/live-lens';
import { identityKey, type LiveTrace } from '@shared/live-trace';
import { ancestors } from '@shared/live-tree';
import type { ProjectSummary } from '@shared/model';
import { call, useQuery } from '../../lib/api';
import { ago } from '../../lib/format';
import {
  STATE_WORDS, alsoChangedWords, beforeWords, byPage, cardDetail, cardLines, cardState, cardVerdict, cardsOf, cutWords, differenceWords, elementWords, failedWords, fragileOf, heldWords, maskWords,
  noiseWords, orphanWhy, reachWords, redoLabel, templateOf, templateOffered, undoLabel, verdictHeadline,
} from '../../lib/live-layer';
import { liveBridge } from '../../lib/live';
import { Button, Dialog, EmptyState, IconButton, useSingleFlight, useToast } from '../ui';
import { LIVE_TIP } from './keys';
import { NoteComposer } from './Notes';
import { TemplateSave, TemplateWrittenNote, type TemplateWritten } from './TemplateSave';
import type { LayerApi } from './use-layer';
import '../../styles/live-layer.css';

interface TrayContext {
  project: ProjectSummary;
  layer: LayerApi;
  /** The path of the page shown (empty when it is not a page of the local site). */
  page: string;
  /** The local site's address, for an edit's page as a note names it. */
  siteUrl: string;
  trace: LiveTrace | null;
  parts: PartIndex;
  regions: LiveRegion[];
  components: Map<string, LiveComponent>;
  prefer: string | null;
  /** A hosted environment is shown: the layer is the local site's, so nothing here acts on the page. */
  readOnly: boolean;
  /** Load the page again (after words were saved to a template). */
  onReload: () => void;
  /** Words saved by hand to the project's templates (Notes › Saved by hand): an edit whose words one wrote reaches every page that uses it. */
  saved?: LiveEdit[] | null;
}

export function LayerTray({ onClose, ...ctx }: TrayContext & { onClose: () => void }) {
  const { layer, page, readOnly } = ctx;
  const once = useSingleFlight();
  const title = useRef<HTMLHeadingElement>(null);
  const savedByHand = useQuery('live.edits', { projectId: ctx.project.id }, ['liveEdits'], (_e, d) => (d as { projectId?: string }).projectId === ctx.project.id);
  const snap = layer.snapshot;
  const edits = snap?.edits ?? [];
  const groups = useMemo(() => byPage(edits, page), [edits, page]);
  // Opened: the log is read and the page asked what the layer shows on it, and the keyboard goes to the tray. Closed,
  // it goes back to what opened it (the bar's Edits, Open Edits), or to the bar's Edits when that is gone, unless
  // something else took it meanwhile.
  useEffect(() => {
    const active = document.activeElement;
    const opener = active instanceof HTMLElement && active !== document.body ? active : null;
    void layer.refresh();
    window.requestAnimationFrame(() => title.current?.focus());
    return () => {
      window.requestAnimationFrame(() => {
        const now = document.activeElement;
        if (now && now !== document.body && now.isConnected) return;
        (opener?.isConnected ? opener : document.querySelector<HTMLElement>('.live-bar button[aria-keyshortcuts="Shift+E"]'))?.focus();
      });
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const keys = (e: KeyboardEvent): void => {
    if (e.defaultPrevented || e.key !== 'Escape' || (e.target as Element).closest('input, textarea, select, [role="menu"], .sel-list')) return;
    e.preventDefault();
    onClose();
  };
  // Counted by card, one per element, as the tray shows them.
  const states = cardsOf(edits).map(cardState);
  const counts = (['draft', 'implemented', 'verified', 'orphaned'] as const)
    .map((s) => [s, states.filter((x) => x === s).length] as const).filter(([, n]) => n > 0)
    .map(([s, n]) => `${n} ${s === 'draft' ? (n === 1 ? 'draft' : 'drafts') : s === 'implemented' ? 'in the site, not verified' : s}`);

  return (
    <div className="live-tray" onKeyDown={keys}>
      <header className="live-panel-head">
        <div className="live-panel-title-row">
          <h2 className="live-side-title" tabIndex={-1} ref={title}>Edits</h2>
          {counts.length ? <span className="live-kind live-tray-counts">{counts.join(' · ')}</span> : null}
          <span className="live-panel-actions">
            <IconButton icon="close" size="s" label="Close the edits" keys={LIVE_TIP.edits} tipSide="bottom" onClick={onClose} />
          </span>
        </div>
      </header>
      <div className="live-tray-body">
      {readOnly ? <p className="small live-tray-note">A hosted environment is shown. The layer is your local site’s: show Local to see it on the page, or to make an edit real.</p> : null}
      <div className="live-tray-tools" role="group" aria-label="The layer">
        {/* While words are being saved to the site, the log waits: undo and redo never land between the save and its mark. */}
        <Button size="s" tone="quiet" icon="undo" disabled={!snap?.undo || layer.writing} onClick={() => once(layer.undo)}
          data-tip="Undo takes back the newest add or discard; an edit already in the site is never taken out of the layer">
          {undoLabel(snap)}
        </Button>
        <Button size="s" tone="quiet" icon="redo" disabled={!snap?.redo || layer.writing} onClick={() => once(layer.redo)}>
          {redoLabel(snap)}
        </Button>
      </div>
      {!layer.on ? (
        <p className="small live-tray-note" role="status">The page shows the site as it renders it, without the layer. Switch the eye in the toolbar back to see your edits.</p>
      ) : null}
      {layer.writing ? <p className="faint small" role="status">Saving to the site: undo, redo and discard wait until the layer has recorded it.</p> : null}
      {!snap ? (
        <div className="live-skeleton" role="status" aria-label="Reading the layer…">{[0, 1, 2].map((i) => <span key={i} className="live-skeleton-row tall" />)}</div>
      ) : !edits.length ? (
        <EmptyState icon="brush" title="Nothing in the layer">
          Choose a part, then type on its words or try a style: the change shows on the page at once, and waits here until you make it real.
        </EmptyState>
      ) : groups.map((g) => (
        <section key={g.page} className="live-tray-page" aria-label={`Edits made on ${g.page}`}>
          <h3 className="live-section-title">{g.page === '/' ? 'The front page, /' : g.page}{g.here ? <span className="live-tray-here"> · this page</span> : null}</h3>
          <ul className="live-tray-edits">
            {cardsOf(g.edits).map((c) => <TrayCard key={c[0]!.id} edits={c} here={g.here} ctx={{ ...ctx, saved: savedByHand.data }} />)}
          </ul>
        </section>
      ))}
      </div>
    </div>
  );
}

/**
 * One element's card: every edit made on it, however many, as one thing. One Make it real (its words through the
 * site, then its styles to an agent in one brief), one Verify (every edit of it in the same renders), one verdict.
 */
function TrayCard({ edits: card, here, ctx }: { edits: LayerEdit[]; here: boolean; ctx: TrayContext }) {
  const { project, layer, readOnly } = ctx;
  const live = liveBridge();
  const toast = useToast();
  const once = useSingleFlight();
  // The card is named and keyed by the first edit made on its element.
  const e = card[0]!;
  const state = cardState(card);
  const text = card.find((m) => m.change.type === 'text') ?? null;
  const drafts = card.filter((m) => m.state === 'draft');
  /** A style or token draft: made in the theme outside Wanigan (an agent from its brief, or by hand); Verify finds it there. */
  const outside = (m: LayerEdit): boolean => m.state === 'draft' && (m.change.type === 'style' || m.change.type === 'token');
  // Verify asks about one edit, and main checks every edit of its element with it: the one in the site, else a style.
  const verifyId = (card.find((m) => m.state === 'implemented') ?? card.find(outside))?.id ?? null;
  /** What runs for this card now (kept by the layer, so closing the tray loses nothing and never starts it twice). */
  const busy = layer.running[e.id] ?? (verifyId ? layer.running[verifyId] : undefined);
  const [answers, setAnswers] = useState<LayerImplemented[]>([]);
  const [noting, setNoting] = useState(false);
  const [written, setWritten] = useState<TemplateWritten | null>(null);
  const lines = cardLines(card);
  const reach = reachWords(e, ctx.trace, layer.applied);
  // Words a template save wrote: the edit reaches every page that uses that template, not only this element.
  const inTemplate = text ? templateOf(text, ctx.saved) : null;
  const fragile = fragileOf(e);
  const orphan = card.find((m) => m.state === 'orphaned') ?? null;
  const verdict = cardVerdict(card);
  const name = `“${e.label}”`;
  // What making it real said that is not a save: the words' answer first (a template to offer, why not), then a style's.
  const textAnswer = text ? answers.find((a) => a.id === text.id) ?? null : null;
  const answer = (textAnswer && !textAnswer.ok ? textAnswer : null) ?? answers.find((a) => !a.ok) ?? null;
  // The regions on the page shown that are this element's part, and what they sit in: what a note to an agent points at.
  const regions = useMemo(() => {
    const part = e.target.part;
    if (!here || !part) return [];
    const key = identityKey(part);
    const ids = ctx.trace?.parts.filter((p) => p.identity && identityKey(p.identity) === key).map((p) => p.id) ?? [];
    const first = ids.flatMap((id) => ctx.parts.regionsOf.get(id) ?? [])[0];
    const r = first === undefined ? undefined : ctx.regions.find((x) => x.index === first);
    return r ? [r, ...ancestors(ctx.regions, r.index)] : [];
  }, [e.target.part, here, ctx.trace, ctx.parts, ctx.regions]);

  // The card made real at once: its words saved through the site first, then every style handed over in one brief.
  const real = (): Promise<unknown> => layer.task(e.id, 'real', async () => {
    if (!live) return;
    const got: LayerImplemented[] = [];
    for (const m of [...drafts.filter((x) => x.change.type === 'text'), ...drafts.filter((x) => x.change.type !== 'text')]) {
      const a = await layer.change(() => live.layerImplement(m.id));
      if (!a) break;
      got.push(a);
      if (a.ok) toast(`Saved ${name} in the site${a.revision ? `, as revision ${a.revision}` : ''}. Verify compares the site with the design.`);
    }
    setAnswers(got);
    if (got.some((a) => !a.ok && a.route === 'agent')) setNoting(true);
  });
  // Kept by the layer per edit: closed and opened again, the tray still says it runs, and never starts it twice.
  const verifying = !!verifyId && layer.running[verifyId] === 'verify';
  const verify = (): Promise<unknown> => (verifyId ? layer.verify(verifyId) : Promise.resolve());
  // What stopped the last verification, said only while the card is still waiting for one.
  const failure = verifyId && state !== 'verified' ? layer.failures[verifyId] ?? null : null;
  const discard = (): Promise<unknown> => once(async () => {
    for (const m of card) if (m.state === 'draft' || m.state === 'orphaned') await layer.discard(m.id);
  });
  const retire = (): Promise<unknown> => once(async () => {
    let done = false;
    for (const m of card) if (m.state === 'verified') done = !!(await layer.change(() => call('live.layerMark', { projectId: project.id, id: m.id, state: 'retired' }))) || done;
    if (done) toast(`Retired ${name}: archived, and out of the tray.`);
  });
  // The brief: the element's own page, as the site names it, and a picture only when the view shows that page. Words
  // only when they go to the agent too; the style is every style of the card still to be made.
  const styleDrafts = drafts.filter((m) => m.change.type !== 'text');
  const noteDraft = {
    url: (() => { try { return new URL(e.page, ctx.siteUrl).toString(); } catch { return e.page; } })(),
    regions, pick: null,
    words: text && textAnswer && !textAnswer.ok && textAnswer.route === 'agent' && text.change.type === 'text'
      ? { before: text.before.text ?? '', after: text.change.value, file: null } : null,
    style: cardLines(styleDrafts.length ? styleDrafts : card.filter((m) => m.change.type !== 'text')).map((l) => ({ property: l.what, from: l.before, to: l.after })),
    layer: {
      label: e.label, reach, element: elementWords(e),
      noPicture: here ? null : `it was made on ${e.page}, and the live view shows ${ctx.page || 'another page'}`,
      // What making it real found (the template and line that write its words, a string's text domain): the agent's start.
      why: answer ? answer.why : null,
    },
  };

  return (
    <li className="live-tray-edit" data-edit={e.id} data-edits={card.length > 1 ? card.map((m) => m.id).join(' ') : undefined} data-state={state}>
      <div className="live-tray-edit-head">
        <span className="live-tray-label">{e.label}</span>
        <span className={`live-tray-state ${state}`}>{STATE_WORDS[state]}</span>
      </div>
      <p className="faint small live-tray-state-detail">{cardDetail(card)}</p>
      <ul className="live-layer-lines" aria-label="Before and after">
        {lines.map((l) => (
          <li key={l.what} className="small">
            <span className="mono faint">{l.what}</span> <span className="live-change-before">{l.before}</span> → <span className="live-change-after">{l.after}</span>
          </li>
        ))}
      </ul>
      {inTemplate ? (
        <p className="small live-tray-reach">
          For every page that uses <span className="mono">{inTemplate.path.split('/').pop()}</span>: its words were saved to that template, line {inTemplate.line}, not only
          to this element. Verify compares this page only.
        </p>
      ) : <p className="small live-tray-reach">For {reach}.{card.some((m) => m.by === 'agent') ? <span className="faint"> Made by an agent.</span> : null}</p>}
      {fragile ? <p className="small live-layer-fragile">Fragile: {fragile}</p> : null}
      {orphan ? <p className="small live-tray-why">Orphaned: {orphanWhy(orphan, layer.applied)} It is not shown, and never put on whatever is there now.</p> : null}
      {written ? <TemplateWrittenNote written={written} /> : null}
      {verdict ? <Verdict verdict={verdict} /> : null}
      {failure ? <p className="small live-tray-why" role="alert">Not verified: {failure}</p> : null}
      {answer ? (
        <div className="live-tray-answer">
          <p className="small" role="status">{answer.why}</p>
          {text && textAnswer && templateOffered(text, textAnswer) ? (
            <TemplateSave edit={text} project={project} layer={layer} onReload={ctx.onReload} onWritten={(w) => { setAnswers((a) => a.filter((x) => x.id !== text.id)); setWritten(w); }} />
          ) : null}
          {!noting ? (
            <div className="live-actions"><Button size="s" tone="quiet" icon="note" onClick={() => setNoting(true)}>Tell an agent…</Button></div>
          ) : (
            <NoteComposer project={project} components={ctx.components} prefer={ctx.prefer} draft={noteDraft} picture={here} onDone={() => setNoting(false)} />
          )}
        </div>
      ) : null}
      <div className="live-actions">
        {drafts.length ? (
          <Button size="s" icon="check" disabled={readOnly || !live || !!busy} onClick={real} aria-label={`Make it real: ${name}`}
            data-tip={drafts.every((m) => m.change.type === 'text') ? 'Save the words in the site, through the site helper'
              : drafts.some((m) => m.change.type === 'text') ? 'Save the words in the site, and hand the style to an agent as intent, on your click'
                : 'Goes to an agent as intent, on your click'}>Make it real</Button>
        ) : null}
        {verifyId ? (
          <Button size="s" icon="compare" disabled={readOnly || !live || verifying} onClick={verify} aria-label={`${verifying ? 'Verifying…' : 'Verify'}: ${name}`}
            data-tip={card.some(outside) ? 'Once an agent, or you, has put the style in the theme: render the site without the layer and compare it with the design'
              : 'Render the site without the layer and compare it with the design, at a phone’s and a desktop’s width'}>
            {verifying ? 'Verifying…' : 'Verify'}
          </Button>
        ) : null}
        {state === 'verified' ? <Button size="s" tone="quiet" icon="check" onClick={retire} aria-label={`Retire: ${name}`}>Retire</Button> : null}
        {card.some((m) => m.state === 'draft' || m.state === 'orphaned') ? (
          <Button size="s" tone="quiet" icon="trash" onClick={discard} disabled={layer.writing} aria-label={`Discard: ${name}`}>Discard</Button>
        ) : null}
      </div>
      {busy === 'real' ? <p className="faint small" role="status">{drafts.every((m) => m.change.type === 'text') ? 'Saving the words in the site…'
        : drafts.some((m) => m.change.type === 'text') ? 'Saving the words in the site, then writing the brief for the style…'
          : 'Keeping the page as it is now, for Verify, and writing the brief…'}</p> : null}
      {busy === 'template' ? <p className="faint small" role="status">Saving the words to the template…</p> : null}
      {verifying ? <p className="faint small" role="status">Rendering the page with and without the layer, twice for the noise floor, at each width…</p> : null}
    </li>
  );
}

/**
 * What the last verification said: the headline, the step that failed, each difference; then what it says whatever
 * it decided (whether step 3 compared the page as it was before, where else the saved words changed, how far down a
 * long page was compared, what was held still), what was left out of the pixel steps and why, the noise floor, and
 * the pictures.
 */
function Verdict({ verdict: v }: { verdict: LayerVerdict }) {
  const failed = failedWords(v);
  const said = [beforeWords(v), ...(v.reach ?? []).map(alsoChangedWords), ...(v.cut ?? []).map(cutWords), heldWords(v)].filter((x): x is string => !!x);
  const masked = v.masked ?? [];
  return (
    <div className={`live-tray-verdict${v.ok ? ' ok' : ' failed'}`}>
      <p className="small live-tray-verdict-head">{verdictHeadline(v)}</p>
      {failed ? <p className="small live-tray-failed">{failed}</p> : null}
      {v.differences.length ? (
        <ul className="live-tray-differences" aria-label="What differs">
          {v.differences.map((d, i) => <li key={i} className="small">{differenceWords(d)}</li>)}
        </ul>
      ) : null}
      {said.length ? (
        <ul className="live-tray-said" aria-label="How it was compared">
          {said.map((w) => <li key={w} className="small">{w}</li>)}
        </ul>
      ) : null}
      {masked.length ? (
        <div className="live-tray-masked">
          <p className="small">Left out of the pixel comparison, because the site says they change from one render to the next:</p>
          <ul className="live-tray-differences" aria-label="Left out of the pixel comparison">
            {masked.map((m) => <li key={`${m.label}|${m.why}`} className="small">{maskWords(m)}</li>)}
          </ul>
        </div>
      ) : null}
      <p className="faint small">{noiseWords(v)}</p>
      <p className="faint small">Checked {ago(v.at)}.</p>
      {v.pictures.length ? <Pictures pictures={v.pictures} at={v.at} /> : null}
    </div>
  );
}

/**
 * Pictures read back once per verification (a later one writes its pictures to the same paths), the most recently
 * shown kept: each is a whole page as a PNG, so the window keeps a few verdicts' worth, not every one it has shown.
 */
const KEPT_PICTURES = 24;
const kept = new Map<string, Promise<string | null>>();
const picture = (path: string, at: number): Promise<string | null> => {
  const key = `${at}|${path}`;
  let p = kept.get(key);
  if (p) kept.delete(key);
  else p = liveBridge()?.layerPicture(path).catch(() => null) ?? Promise.resolve(null);
  kept.set(key, p);
  for (const old of kept.keys()) { if (kept.size <= KEPT_PICTURES) break; kept.delete(old); }
  return p;
};

const KINDS = [['before', 'The page before'], ['design', 'The design'], ['result', 'The site'], ['diff', 'Difference']] as const;

/** The page as it was before it was made real (where one was kept), the design, the site and their difference, at each width; each opens larger. */
function Pictures({ pictures, at }: { pictures: LayerVerdict['pictures']; at: number }) {
  const [srcs, setSrcs] = useState<Record<string, string | null>>({});
  const [large, setLarge] = useState<{ src: string; alt: string } | null>(null);
  // Read again only when the verdict's pictures change: every read of the log brings a new array holding the same paths.
  const paths = pictures.flatMap((p) => [p.before, p.design, p.result, p.diff]).filter((x): x is string => !!x);
  const key = paths.join('\n');
  useEffect(() => {
    let current = true;
    setSrcs({});
    for (const path of key ? key.split('\n') : []) {
      void picture(path, at).then((data) => { if (current) setSrcs((s) => ({ ...s, [path]: data ? `data:image/png;base64,${data}` : null })); });
    }
    return () => { current = false; };
  }, [key, at]);
  return (
    <div className="live-tray-pictures">
      {pictures.map((p) => (
        <div key={p.width} className="live-tray-picture-row" role="group" aria-label={`At ${p.width} px`}>
          {KINDS.filter(([kind]) => kind !== 'before' || p.before !== undefined).map(([kind, label]) => {
            const path = p[kind] ?? null;
            const alt = `${label} at ${p.width} px`;
            const src = path ? srcs[path] : null;
            return (
              <figure key={kind} className="live-tray-picture">
                {src ? (
                  <button type="button" className="live-tray-picture-open" aria-label={`${alt}, larger`} onClick={() => setLarge({ src, alt })}>
                    <img src={src} alt={alt} />
                  </button>
                ) : <span className="live-tray-picture-none faint small">{!path ? (kind === 'before' ? 'None kept' : 'No difference') : path in srcs ? 'Not readable' : '…'}</span>}
                <figcaption className="faint small">{label} · {p.width} px</figcaption>
              </figure>
            );
          })}
        </div>
      ))}
      {large ? (
        <Dialog title={large.alt} onClose={() => setLarge(null)} width={960}>
          <div className="live-tray-large"><img src={large.src} alt={large.alt} /></div>
        </Dialog>
      ) : null}
    </div>
  );
}

