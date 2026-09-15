import { useEffect } from 'react';
import { bindingMatches, modalOpen } from '../bindings';
import { useAnnounce } from './announce';
import { terminalSelection } from './TerminalPane';
import { quoteIntoMessage } from './TerminalMenu';
import { quoteTranscriptSelection } from './TranscriptExtras';

/**
 * The quote chord, rendered once inside App's announce provider.
 *
 * A selection inside an open transcript reader wins, because it is what the
 * operator is looking at when that view is on screen; otherwise the active
 * session's terminal selection is quoted. Capture phase like the shell's other
 * chords, and bindingMatches refuses it while a terminal has focus: the PTY
 * owns its keystrokes, and a terminal selection is quoted from its right-click
 * menu there.
 */
export default function HelperUxKeys({ activeSessionId }: { activeSessionId: string | null }) {
  const { announce } = useAnnounce();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (modalOpen() || !bindingMatches(e, 'quote-into-message')) return;
      e.preventDefault();
      const selection = window.getSelection();
      const range = selection && !selection.isCollapsed && selection.rangeCount ? selection.getRangeAt(0) : null;
      const anchor = range ? (range.commonAncestorContainer instanceof Element ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement) : null;
      const reader = anchor?.closest<HTMLElement>('[data-transcript-session]') ?? null;
      if (reader?.dataset.transcriptSession && selection) {
        quoteTranscriptSelection(reader.dataset.transcriptSession, selection.toString())
          .then((said) => announce({ tone: 'ok', text: said }))
          .catch((err: unknown) => announce({ tone: 'error', text: err instanceof Error ? err.message : String(err) }));
        return;
      }
      const text = activeSessionId ? terminalSelection(activeSessionId) : '';
      const said = activeSessionId && text ? quoteIntoMessage(activeSessionId, text, 'the terminal selection') : null;
      announce(said
        ? { tone: 'ok', text: said }
        : { tone: 'info', text: 'Select text in a terminal or an archived transcript first, then press ⌘> with focus outside the terminal.' });
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [activeSessionId, announce]);
  return null;
}
