// Two versions of a file side by side: what someone else's change did, or the
// owner's text against the file as it is now on disk, to merge. In a merge the
// right side is the result: arrows between them take a change from the left,
// and anything can be typed; Save merged writes it over the version on disk.
import { useEffect, useRef } from 'react';
import { MergeView } from '@codemirror/merge';
import { EditorState, StateEffect } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { Button } from '../../components/ui';
import { languageOf } from './languages';
import { comparisonExtensions } from './setup';
import type { Comparison as Shown } from './controller';

export function Comparison({ comparison, path, onSave, onTheirs, onClose }: {
  comparison: Shown; path: string; onSave: (text: string) => void; onTheirs: () => void; onClose: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const merge = useRef<MergeView | null>(null);
  useEffect(() => {
    const parent = host.current;
    if (!parent) return undefined;
    let gone = false;
    const side = (doc: string, editable: boolean, label: string) => ({
      doc,
      extensions: [
        comparisonExtensions(),
        EditorState.readOnly.of(!editable),
        EditorView.editable.of(editable),
        EditorView.contentAttributes.of({ 'aria-label': `${label}: ${path}` }),
      ],
    });
    const view = new MergeView({
      a: side(comparison.left.text, false, comparison.left.label),
      b: side(comparison.right.text, comparison.merge, comparison.right.label),
      parent,
      ...(comparison.merge ? { revertControls: 'a-to-b' as const } : {}),
      highlightChanges: true,
      gutter: true,
      collapseUnchanged: { margin: 3, minSize: 6 },
    });
    merge.current = view;
    const lang = languageOf(path);
    if (lang) {
      void lang.load().then((ext) => {
        if (gone) return;
        for (const v of [view.a, view.b]) v.dispatch({ effects: StateEffect.appendConfig.of(ext) });
      }).catch(() => {});
    }
    return () => { gone = true; view.destroy(); merge.current = null; };
  }, [comparison, path]);

  return (
    <section className="compare" aria-label={comparison.title}>
      <header className="compare-head">
        <p className="compare-title">{comparison.title}</p>
        <div className="compare-actions">
          {comparison.merge ? (
            <>
              <Button size="s" tone="quiet" onClick={onTheirs}>Use theirs</Button>
              <Button size="s" tone="quiet" onClick={onClose}>Back to my text</Button>
              <Button size="s" tone="primary" icon="save" onClick={() => onSave(merge.current?.b.state.doc.toString() ?? comparison.right.text)}>Save merged</Button>
            </>
          ) : <Button size="s" tone="quiet" icon="close" onClick={onClose}>Close the comparison</Button>}
        </div>
      </header>
      <div className="compare-labels" aria-hidden="true">
        <span>{comparison.left.label}</span>
        <span>{comparison.right.label}</span>
      </div>
      <div className="compare-body" ref={host} />
      {comparison.merge ? <p className="compare-hint faint small">The arrows take a change from the left. Edit the right side freely: it is what gets saved.</p> : null}
    </section>
  );
}
