import { useCallback, useEffect, useState } from 'react';
import { splitMermaid } from '@shared/copy-helpers';
import { useAnnounce } from './announce';
import { ContextMenu, quoteIntoMessage, type MenuItem } from './TerminalMenu';
import '../styles/helper-ux.css';

/**
 * The transcript reader's helpers: a turn's text with its mermaid blocks shown
 * as what they are, Copy as Markdown, and quoting a selection into the message
 * box of the session that continues this conversation.
 */

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * A turn's text. Fenced ```mermaid blocks are pulled out and shown as their
 * source under a label that says so: Wanigan adds no dependency, so it draws no
 * diagram, and a block of graph syntax with no label reads as a rendering bug.
 */
export function TranscriptTurnText({ text }: { text: string }) {
  const { announce } = useAnnounce();
  const segments = splitMermaid(text);
  if (segments.length === 1 && segments[0].kind === 'text') return <pre>{text}</pre>;
  return (
    <>
      {segments.map((seg, i) => seg.kind === 'text'
        ? (seg.text.trim() ? <pre key={i}>{seg.text}</pre> : null)
        : (
          <figure key={i} className="ux-mermaid" aria-label="Mermaid diagram (source)">
            <figcaption className="ux-mermaid-head">
              <span className="ux-mermaid-title">Mermaid diagram (source)</span>
              <button type="button" className="btn btn-sm"
                      onClick={() => {
                        window.wanigan.ux.copyText(seg.source)
                          .then(() => announce({ tone: 'ok', text: 'Copied the diagram source.' }))
                          .catch((e: unknown) => announce({ tone: 'error', text: `Could not copy the diagram source: ${msg(e)}` }));
                      }}>
                Copy
              </button>
            </figcaption>
            <pre className="ux-mermaid-source">{seg.source}</pre>
            <p className="ux-mermaid-note">
              Rendering is not available: drawing diagrams would need a library Wanigan does not ship.
              {!seg.closed && ' This block was never closed, so it may be cut off.'}
            </p>
          </figure>
        ))}
    </>
  );
}

/** The selected text, if the selection sits inside `root`. */
function selectionWithin(root: Element | null): string {
  const selection = window.getSelection();
  if (!root || !selection || selection.isCollapsed || selection.rangeCount === 0) return '';
  const range = selection.getRangeAt(0);
  return root.contains(range.commonAncestorContainer) ? selection.toString() : '';
}

/**
 * Quote a transcript selection into a live session's message box. Main says
 * which open session continues this conversation; when none does, nothing is
 * written, because a draft under a session id no composer will mount is a
 * draft nobody reads.
 */
export async function quoteTranscriptSelection(archivedSessionId: string, selection: string): Promise<string> {
  if (!selection.trim()) return 'Select text in the transcript first.';
  const target = await window.wanigan.ux.liveSessionFor(archivedSessionId);
  if (!target) {
    throw new Error('No open session continues this conversation, so there is no message box to quote into. Resume it first.');
  }
  return quoteIntoMessage(target.sessionId, selection, `the transcript into “${target.title}”`) ?? 'There was nothing to quote.';
}

/** Copy as Markdown and Quote selection, for the reader's head, plus its right-click menu. */
export function TranscriptReaderActions({ sessionId, readerRef }: {
  sessionId: string;
  readerRef: React.RefObject<HTMLElement | null>;
}) {
  const { announce } = useAnnounce();
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; selection: string } | null>(null);
  const [hasSelection, setHasSelection] = useState(false);
  const close = useCallback(() => setMenu(null), []);

  useEffect(() => {
    const onChange = () => setHasSelection(!!selectionWithin(readerRef.current).trim());
    document.addEventListener('selectionchange', onChange);
    return () => document.removeEventListener('selectionchange', onChange);
  }, [readerRef]);

  useEffect(() => {
    const root = readerRef.current;
    if (!root) return;
    const onContext = (e: MouseEvent) => {
      const text = selectionWithin(root);
      if (!text.trim()) return;
      e.preventDefault();
      setMenu({ x: e.clientX, y: e.clientY, selection: text });
    };
    root.addEventListener('contextmenu', onContext);
    return () => root.removeEventListener('contextmenu', onContext);
  }, [readerRef]);

  const quote = (selection: string) => {
    quoteTranscriptSelection(sessionId, selection)
      .then((said) => announce({ tone: 'ok', text: said }))
      .catch((e: unknown) => announce({ tone: 'error', text: msg(e) }));
  };

  const copyMarkdown = async () => {
    setBusy(true);
    try {
      const r = await window.wanigan.ux.copyTranscriptMarkdown(sessionId);
      announce({
        tone: 'ok',
        text: `Copied ${r.turns.toLocaleString('en-US')} turns as Markdown, ${r.chars.toLocaleString('en-US')} characters. Tool steps are one line each and tool output is left out.`
          + (r.redacted ? ' Something shaped like a credential was redacted.' : ' Nothing shaped like a credential was found to redact.')
          + (r.note ? ` ${r.note}` : ''),
      });
    } catch (e) {
      announce({ tone: 'error', text: `Nothing was copied: ${msg(e)}` });
    } finally {
      setBusy(false);
    }
  };

  const items: MenuItem[] = menu ? [
    {
      kind: 'item', label: 'Copy selection',
      run: () => {
        window.wanigan.ux.copyText(menu.selection)
          .then(() => announce({ tone: 'ok', text: 'Copied the selection.' }))
          .catch((e: unknown) => announce({ tone: 'error', text: `Could not copy: ${msg(e)}` }));
      },
    },
    { kind: 'item', label: 'Quote into message', kbd: '⌘>', run: () => quote(menu.selection) },
  ] : [];

  return (
    <span className="ux-reader-actions">
      <button type="button" className="btn" disabled={busy} onClick={() => void copyMarkdown()}>
        {busy ? 'Copying…' : 'Copy as Markdown'}
      </button>
      <button type="button" className="btn" disabled={!hasSelection}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => quote(selectionWithin(readerRef.current))}>
        Quote selection into message
      </button>
      {menu && <ContextMenu x={menu.x} y={menu.y} label="Transcript selection" items={items} onClose={close} />}
    </span>
  );
}
