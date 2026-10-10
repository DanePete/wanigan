// The design layer's tray, in the live view's side panel (Edits, ⇧E): every
// edit of the project, grouped by the page it was made on, the page shown
// first. Design: docs/design/2026-10-09-design-layer.md, "Where it lives" and
// "Phase 1, as contracted".
//
// - Each edit says what it is, before → after, what it reaches in words, its
//   state (and the last verification's verdict), and plainly when it is
//   fragile or orphaned, with why.
// - Per edit: Discard (a draft or an orphaned one), Make it real (words through
//   the site helper, or the owner's own template when the helper cannot; a style
//   or token goes to an agent as intent, through the note the Inspector writes,
//   never by starting a session), Verify (the site against the design, with
//   the step that failed, each difference and the pictures), Retire (verified).
// - Undo and redo say what they would do; the page can be shown without the
//   layer, to compare. After every change the log is read again and the layer
//   applied to the page again (use-layer.ts).
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { LayerEdit, LayerImplemented, LayerVerdict } from '@shared/design-layer';
import type { LiveComponent, LiveFound, LiveRegion } from '@shared/live';
import type { PartIndex } from '@shared/live-lens';
import { identityKey, type LiveTrace } from '@shared/live-trace';
import { ancestors } from '@shared/live-tree';
import type { ProjectSummary } from '@shared/model';
import { call } from '../../lib/api';
import {
  STATE_DETAIL, STATE_WORDS, byPage, changeLines, differenceWords, failedWords, isFragile, noiseWords, orphanWhy, reachWords, redoLabel,
  undoLabel, verdictHeadline,
} from '../../lib/live-layer';
import { liveBridge } from '../../lib/live';
import { Button, Dialog, IconButton, useToast } from '../ui';
import { NoteComposer } from './Notes';
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
}

export function LayerTray({ onClose, ...ctx }: TrayContext & { onClose: () => void }) {
  const { layer, page, readOnly } = ctx;
  const live = liveBridge();
  const title = useRef<HTMLHeadingElement>(null);
  const snap = layer.snapshot;
  const edits = snap?.edits ?? [];
  const groups = useMemo(() => byPage(edits, page), [edits, page]);
  // Opened: the log is read and the page asked what the layer shows on it, and the keyboard goes to the tray.
  useEffect(() => {
    void layer.refresh();
    window.requestAnimationFrame(() => title.current?.focus());
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const keys = (e: KeyboardEvent): void => {
    if (e.defaultPrevented || e.key !== 'Escape' || (e.target as Element).closest('input, textarea, select, [role="menu"], .sel-list')) return;
    e.preventDefault();
    onClose();
  };
  const counts = (['draft', 'implemented', 'verified', 'orphaned'] as const)
    .map((s) => [s, edits.filter((e) => e.state === s).length] as const).filter(([, n]) => n > 0)
    .map(([s, n]) => `${n} ${s === 'draft' ? (n === 1 ? 'draft' : 'drafts') : s === 'implemented' ? 'in the site, not verified' : s}`);

  return (
    <div className="live-tray" onKeyDown={keys}>
      <div className="live-side-head">
        <h2 className="live-side-title" tabIndex={-1} ref={title}>Edits</h2>
        <IconButton icon="close" label="Close the edits (⇧E)" onClick={onClose} />
      </div>
      <p className="small">
        Your changes to the page, kept by Wanigan and shown on it until each is made real in the site and verified.
        {counts.length ? <span className="faint"> {counts.join(', ')}.</span> : null}
      </p>
      {readOnly ? <p className="small live-tray-note">A hosted environment is shown. The layer is your local site’s: show Local to see it on the page, or to make an edit real.</p> : null}
      <div className="live-tray-tools" role="group" aria-label="The layer">
        <Button size="s" tone="quiet" icon="undo" disabled={!snap?.undo} onClick={() => layer.change(() => call('live.layerUndo', { projectId: ctx.project.id }))}
          title="Undo takes back the newest add or discard; an edit already in the site is never taken out of the layer">
          {undoLabel(snap)}
        </Button>
        <Button size="s" tone="quiet" icon="forward" disabled={!snap?.redo} onClick={() => layer.change(() => call('live.layerRedo', { projectId: ctx.project.id }))}>
          {redoLabel(snap)}
        </Button>
        <Button size="s" tone={layer.on ? 'quiet' : 'primary'} icon="eye" aria-pressed={!layer.on} disabled={!live || readOnly} onClick={() => layer.show(!layer.on)}>
          Show the page without the layer
        </Button>
      </div>
      {!layer.on ? (
        <p className="small live-tray-note" role="status">The page shows the site as it renders it, without the layer. Switch it back to see your edits.</p>
      ) : null}
      {!snap ? <p className="faint small">Reading the layer…</p> : !edits.length ? (
        <p className="faint small">
          Nothing in the layer. Choose a part, then Edit ▾ › Retype the words or Try a style: the change shows on the page at once, and waits here until you
          make it real.
        </p>
      ) : groups.map((g) => (
        <section key={g.page} className="live-tray-page" aria-label={`Edits made on ${g.page}`}>
          <h3 className="live-section-title">{g.page === '/' ? 'The front page, /' : g.page}{g.here ? <span className="live-tray-here"> · this page</span> : null}</h3>
          <ul className="live-tray-edits">
            {g.edits.map((e) => <TrayEdit key={e.id} edit={e} here={g.here} ctx={ctx} />)}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** Words of a text edit: where the owner's own template writes them once, when the helper cannot save them. */
type Template = { state: 'looking' } | { state: 'none' } | { state: 'found'; file: string; at: LiveFound };

function TrayEdit({ edit: e, here, ctx }: { edit: LayerEdit; here: boolean; ctx: TrayContext }) {
  const { project, layer, readOnly } = ctx;
  const live = liveBridge();
  const toast = useToast();
  const [answer, setAnswer] = useState<LayerImplemented | null>(null);
  const [noting, setNoting] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [template, setTemplate] = useState<Template | null>(null);
  const lines = changeLines(e);
  const reach = reachWords(e, ctx.trace, layer.applied);
  const fragile = isFragile(e);
  const name = `“${e.label}”`;
  // The regions on the page shown that are this edit's part: what a note points at, and where its words are written.
  const regions = useMemo(() => {
    const part = e.target.part;
    if (!here || !part) return [];
    const key = identityKey(part);
    const ids = ctx.trace?.parts.filter((p) => p.identity && identityKey(p.identity) === key).map((p) => p.id) ?? [];
    const first = ids.flatMap((id) => ctx.parts.regionsOf.get(id) ?? [])[0];
    const r = first === undefined ? undefined : ctx.regions.find((x) => x.index === first);
    return r ? [r, ...ancestors(ctx.regions, r.index)] : [];
  }, [e.target.part, here, ctx.trace, ctx.parts, ctx.regions]);

  const real = async (): Promise<void> => {
    if (!live) return;
    setFailure(null);
    const a = await layer.change(() => live.layerImplement(e.id));
    if (!a) return;
    setAnswer(a);
    if (a.ok) { toast(`Saved ${name} in the site${a.revision ? `, as revision ${a.revision}` : ''}. Verify compares the site with the design.`); return; }
    if (a.route === 'agent') setNoting(true);
    if (e.change.type === 'text' && a.route === 'none') void findTemplate();
  };
  // The helper could not save the words: the owner's own template may write them, once.
  const findTemplate = async (): Promise<void> => {
    const before = e.before.text;
    const files = [...new Set(regions.map((r) => r.file).filter((f): f is string => !!f))].slice(0, 6);
    if (!before || !files.length) { setTemplate({ state: 'none' }); return; }
    setTemplate({ state: 'looking' });
    for (const file of files) {
      const at = await call('live.findText', { projectId: project.id, file, text: before }).catch(() => null);
      if (at && at.count > 0) { setTemplate({ state: 'found', file, at }); return; }
    }
    setTemplate({ state: 'none' });
  };
  const saveTemplate = async (file: string): Promise<void> => {
    if (e.change.type !== 'text' || !e.before.text) return;
    const value = e.change.value;
    const before = e.before.text;
    const saved = await layer.change(async () => {
      const done = await call('live.saveText', { projectId: project.id, file, before, after: value });
      await call('live.layerMark', { projectId: project.id, id: e.id, state: 'implemented' });
      return done;
    });
    if (!saved) return;
    setAnswer(null);
    setTemplate(null);
    toast(`Saved to ${file.split('/').pop()} (line ${saved.line}); Notes › Saved by hand puts it back. Verify compares the site with the design.`);
    ctx.onReload();
  };
  const verify = async (): Promise<void> => {
    if (!live) return;
    setVerifying(true);
    setFailure(null);
    try {
      await live.layerVerify(e.id);
    } catch (err) {
      setFailure((err as Error).message);
    } finally {
      setVerifying(false);
      await layer.refresh();
    }
  };
  const discard = (): Promise<unknown> => layer.change(() => call('live.layerDiscard', { projectId: project.id, id: e.id }));
  const retire = async (): Promise<void> => {
    const done = await layer.change(() => call('live.layerMark', { projectId: project.id, id: e.id, state: 'retired' }));
    if (done) toast(`Retired ${name}: archived, and out of the tray.`);
  };
  const noteDraft = {
    url: (() => { try { return new URL(e.page, ctx.siteUrl).toString(); } catch { return e.page; } })(),
    regions, pick: null,
    words: e.change.type === 'text' ? { before: e.before.text ?? '', after: e.change.value, file: template?.state === 'found' ? template.file : null } : null,
    style: e.change.type === 'text' ? [] : lines.map((l) => ({ property: l.what, from: l.before, to: l.after })),
    layer: { label: e.label, reach },
  };

  return (
    <li className="live-tray-edit" data-edit={e.id} data-state={e.state}>
      <div className="live-tray-edit-head">
        <span className="live-tray-label">{e.label}</span>
        <span className={`live-tray-state ${e.state}`} title={STATE_DETAIL[e.state]}>{STATE_WORDS[e.state]}</span>
      </div>
      <ul className="live-layer-lines" aria-label="Before and after">
        {lines.map((l) => (
          <li key={l.what} className="small">
            <span className="mono faint">{l.what}</span> <span className="live-change-before">{l.before}</span> → <span className="live-change-after">{l.after}</span>
          </li>
        ))}
      </ul>
      <p className="small live-tray-reach">For {reach}.{e.by === 'agent' ? <span className="faint"> Made by an agent.</span> : null}</p>
      {fragile ? (
        <p className="small live-layer-fragile">Fragile: no part of the site names its element, so it is kept by where it sits in the page.</p>
      ) : null}
      {e.state === 'orphaned' ? <p className="small live-tray-why">Orphaned: {orphanWhy(e, layer.applied)} It is not shown, and never put on whatever is there now.</p> : null}
      {e.verdict ? <Verdict verdict={e.verdict} /> : null}
      {failure ? <p className="small live-tray-why" role="alert">Not verified: {failure}</p> : null}
      {answer && !answer.ok ? (
        <div className="live-tray-answer" role="status">
          <p className="small">{answer.why}</p>
          {template?.state === 'looking' ? <p className="faint small">Looking for where your templates write those words…</p> : null}
          {template?.state === 'found' && !template.at.refused ? (
            <div className="live-actions">
              <Button size="s" tone="primary" icon="check" onClick={() => saveTemplate(template.file)} aria-label={`Save ${name} to ${template.file}`}>
                Save to {template.file.split('/').pop()}, line {template.at.line}
              </Button>
            </div>
          ) : template?.state === 'found' && template.at.refused ? <p className="faint small">{template.at.refused}</p> : null}
          {!noting ? (
            <div className="live-actions"><Button size="s" tone="quiet" icon="note" onClick={() => setNoting(true)}>Tell an agent…</Button></div>
          ) : (
            <NoteComposer project={project} components={ctx.components} prefer={ctx.prefer} draft={noteDraft} onDone={() => setNoting(false)} />
          )}
        </div>
      ) : null}
      <div className="live-actions">
        {e.state === 'draft' ? (
          <Button size="s" tone="primary" icon="check" disabled={readOnly || !live} onClick={real} aria-label={`Make ${name} real`}
            title={e.change.type === 'text' ? 'Save the words in the site, through the site helper' : 'Goes to an agent as intent, on your click'}>Make it real</Button>
        ) : null}
        {e.state === 'implemented' ? (
          <Button size="s" tone="primary" icon="compare" disabled={readOnly || !live || verifying} onClick={verify} aria-label={`Verify ${name}`}
            title="Render the site without the layer and compare it with the design, at a phone’s and a desktop’s width">
            {verifying ? 'Verifying…' : 'Verify'}
          </Button>
        ) : null}
        {e.state === 'verified' ? <Button size="s" tone="quiet" icon="check" onClick={retire} aria-label={`Retire ${name}`}>Retire</Button> : null}
        {e.state === 'draft' || e.state === 'orphaned' ? <Button size="s" tone="quiet" icon="trash" onClick={discard} aria-label={`Discard ${name}`}>Discard</Button> : null}
      </div>
      {verifying ? <p className="faint small" role="status">Rendering the page with and without the layer, twice for the noise floor, at each width…</p> : null}
    </li>
  );
}

/** What the last verification said: the headline, the step that failed, each difference, the noise floor, and the pictures. */
function Verdict({ verdict: v }: { verdict: LayerVerdict }) {
  const failed = failedWords(v);
  return (
    <div className={`live-tray-verdict${v.ok ? ' ok' : ' failed'}`}>
      <p className="small live-tray-verdict-head">{verdictHeadline(v)}</p>
      {failed ? <p className="small live-tray-failed">{failed}</p> : null}
      {v.differences.length ? (
        <ul className="live-tray-differences" aria-label="What differs">
          {v.differences.map((d, i) => <li key={i} className="small">{differenceWords(d)}</li>)}
        </ul>
      ) : null}
      <p className="faint small">{noiseWords(v)}</p>
      {v.pictures.length ? <Pictures pictures={v.pictures} at={v.at} /> : null}
    </div>
  );
}

/** Pictures read back once per verification: a later one writes its pictures to the same paths. */
const kept = new Map<string, Promise<string | null>>();
const picture = (path: string, at: number): Promise<string | null> => {
  const key = `${at}|${path}`;
  let p = kept.get(key);
  if (!p) { p = liveBridge()?.layerPicture(path).catch(() => null) ?? Promise.resolve(null); kept.set(key, p); }
  return p;
};

const KINDS = [['design', 'The design'], ['result', 'The site'], ['diff', 'Difference']] as const;

/** The design, the site and their difference, at each width; each opens larger. */
function Pictures({ pictures, at }: { pictures: LayerVerdict['pictures']; at: number }) {
  const [srcs, setSrcs] = useState<Record<string, string | null>>({});
  const [large, setLarge] = useState<{ src: string; alt: string } | null>(null);
  useEffect(() => {
    let current = true;
    setSrcs({});
    for (const p of pictures) for (const path of [p.design, p.result, p.diff]) {
      if (!path) continue;
      void picture(path, at).then((data) => { if (current) setSrcs((s) => ({ ...s, [path]: data ? `data:image/png;base64,${data}` : null })); });
    }
    return () => { current = false; };
  }, [pictures, at]);
  return (
    <div className="live-tray-pictures">
      {pictures.map((p) => (
        <div key={p.width} className="live-tray-picture-row" role="group" aria-label={`At ${p.width} px`}>
          {KINDS.map(([kind, label]) => {
            const path = p[kind];
            const alt = `${label} at ${p.width} px`;
            const src = path ? srcs[path] : null;
            return (
              <figure key={kind} className="live-tray-picture">
                {src ? (
                  <button type="button" className="live-tray-picture-open" aria-label={`${alt}, larger`} onClick={() => setLarge({ src, alt })}>
                    <img src={src} alt={alt} />
                  </button>
                ) : <span className="live-tray-picture-none faint small">{!path ? 'No difference' : path in srcs ? 'Not readable' : '…'}</span>}
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

