// Words saved to the owner's own template, from the tray (components/live/Tray.tsx), when making an edit real found
// nothing the site stores holding them. It is its own action, never a fallback after any refusal, and it is bounded:
//
// - Offered only after the main process answered that nothing the site stores holds the words (templateOffered): a
//   field that no longer holds them, several things holding them, or any other refusal means the words are stored, or
//   that Wanigan cannot tell, and no template is written for them.
// - Only the template that rendered the element itself: the file of its own innermost region, read from the element
//   picked on the page, which must be the edit's (sameTarget, ownTemplate). Never a template around it: a page or
//   region template holding the same words elsewhere is not the element's.
// - Its reach is said before the save: a template change shows on every page that uses that template, not only on
//   this element.
// - Just before writing, the edit is read again: still a draft, and still shown on the page (templateSaveRefused).
// - A write is always said (a toast, and the page reloaded), even when the layer then refuses to mark the edit
//   implemented; that refusal is said beside it. While the layer holds the edit as in the site, Notes › Saved by hand
//   offers no Put back for it (Live.tsx EditsList, heldInLayer): the core never takes an edit in the site back out of the
//   layer, so putting the words back would leave the layer saying the site has them.
import { useState } from 'react';
import type { LayerEdit } from '@shared/design-layer';
import type { ProjectSummary } from '@shared/model';
import { call } from '../../lib/api';
import { liveBridge } from '../../lib/live';
import { ownTemplate, sameTarget, templateSaveRefused } from '../../lib/live-layer';
import { Button, useSingleFlight, useToast } from '../ui';
import type { LayerApi } from './use-layer';

type Look =
  | { state: 'idle' }
  | { state: 'looking' }
  | { state: 'none'; why: string }
  | { state: 'found'; file: string; line: number | null };

/** A template save that wrote: where, and why the layer would not mark the edit implemented (null when it did). */
export interface TemplateWritten { file: string; line: number; refused: string | null }

const fileName = (path: string): string => path.split('/').pop() ?? path;

/** What a template save wrote, said in the edit's row when the layer would not record it: the site has the words all the same. */
export function TemplateWrittenNote({ written: w }: { written: TemplateWritten }) {
  if (!w.refused) return null;
  return (
    <p className="small live-tray-why" role="alert">
      Saved to {fileName(w.file)}, line {w.line}: the site has the new words. The layer could not mark this edit implemented: {w.refused} Do not save it
      again; Notes › Saved by hand can put the words back.
    </p>
  );
}

export function TemplateSave({ edit: e, project, layer, onReload, onWritten }: {
  edit: LayerEdit; project: ProjectSummary; layer: LayerApi;
  /** Load the page again: it shows what the template now says. */
  onReload: () => void;
  /** The template was written: said in the edit's row, whatever the layer then recorded. */
  onWritten: (written: TemplateWritten) => void;
}) {
  const live = liveBridge();
  const toast = useToast();
  const once = useSingleFlight();
  const [look, setLook] = useState<Look>({ state: 'idle' });
  const name = `“${e.label}”`;
  const before = e.before.text ?? '';
  const value = e.change.type === 'text' ? e.change.value : '';

  /** The template that rendered the element picked now, when the pick is this edit's element, and the words' one place in it. */
  const find = (): Promise<unknown> => once(async () => {
    if (!live) return;
    setLook({ state: 'looking' });
    const picked = await live.layerTarget().catch(() => null);
    if (!picked || !sameTarget(picked.target, e.target)) {
      setLook({ state: 'none', why: 'Pick this element on the page first (P), then open Edits and look again: Wanigan writes to a template only when it can see which one rendered the element.' });
      return;
    }
    const own = ownTemplate((await live.picked().catch(() => null))?.regions ?? []);
    if ('why' in own) { setLook({ state: 'none', why: own.why }); return; }
    const at = await call('live.findText', { projectId: project.id, file: own.file, text: before }).catch((err: Error) => ({ count: 0, line: null, refused: err.message }));
    if (at.refused || at.count !== 1) {
      setLook({ state: 'none', why: at.refused ?? `Those words are not written once in ${fileName(own.file)}, the template that rendered this element.` });
      return;
    }
    setLook({ state: 'found', file: own.file, line: at.line });
  });

  const save = (file: string): Promise<unknown> => once(async () => {
    // Read again just before writing: the edit may have been undone, discarded, orphaned or made real meanwhile.
    const { snapshot, applied } = await layer.fresh();
    const refused = templateSaveRefused(snapshot?.edits.find((x) => x.id === e.id), applied);
    if (refused) { setLook({ state: 'none', why: refused }); return; }
    let line: number;
    try {
      line = (await call('live.saveText', { projectId: project.id, file, before, after: value })).line;
    } catch (err) {
      setLook({ state: 'none', why: (err as Error).message });
      return;
    }
    // Written: said, and the page reloaded, whatever the layer records next.
    toast(`Saved ${name} to ${fileName(file)} (line ${line}): every page that uses that template shows the new words. Notes › Saved by hand lists it.`);
    const markRefused = await call('live.layerMark', { projectId: project.id, id: e.id, state: 'implemented' }).then(() => null, (err: Error) => err.message);
    onReload();
    await layer.refresh();
    onWritten({ file, line, refused: markRefused });
  });

  if (look.state === 'idle') {
    return (
      <div className="live-actions">
        <Button size="s" tone="quiet" icon="file" onClick={find} disabled={!live}>Look in its template…</Button>
      </div>
    );
  }
  if (look.state === 'looking') return <p className="faint small">Looking in the template that rendered this element…</p>;
  if (look.state === 'none') {
    return (
      <div className="live-tray-template">
        <p className="small" role="status">{look.why}</p>
        <div className="live-actions"><Button size="s" tone="quiet" icon="file" onClick={find}>Look again</Button></div>
      </div>
    );
  }
  const label = `Save to ${fileName(look.file)}${look.line ? `, line ${look.line}` : ''}`;
  return (
    <div className="live-tray-template">
      <p className="small">Your words are written once in <span className="mono">{look.file}</span>{look.line ? `, line ${look.line}` : ''}: the template that rendered this element.</p>
      <p className="small live-tray-template-reach">
        Saving changes that template, so every page that uses it shows the new words, not only this element. Verify compares this page only.
      </p>
      <div className="live-actions">
        <Button size="s" tone="primary" icon="check" onClick={() => save(look.file)} aria-label={`${label}: ${name}, in ${look.file}`}>{label}</Button>
      </div>
    </div>
  );
}
