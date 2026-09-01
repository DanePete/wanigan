import { useEffect, useRef } from 'react';

/**
 * The cheat sheet is a document, not a config: it lists what the running
 * build actually binds, grouped by where the key works. When a binding
 * changes in code, this table is part of the same change.
 */

type Row = { keys: string; does: string };
type Group = { title: string; note?: string; rows: Row[] };

const GROUPS: Group[] = [
  {
    title: 'Anywhere',
    note: 'The terminal owns every keystroke while it has focus — click outside it first.',
    rows: [
      { keys: '⌘K', does: 'Command palette — views, projects, live sessions' },
      { keys: '⌘T', does: 'New session' },
      { keys: '⌘1–9', does: 'Switch view (Sessions, Fleet, Control, …)' },
      { keys: '⌘0', does: 'Runs view' },
      { keys: '⌘,', does: 'Settings' },
      { keys: '⌘⇧S', does: 'Skills' },
      { keys: '⌘⇧C', does: 'Context' },
      { keys: '⌘⇧D', does: 'Demo mode (masks names, asks first)' },
      { keys: '?  ·  ⌘/', does: 'This cheat sheet' },
    ],
  },
  {
    title: 'Sessions view',
    rows: [
      { keys: '⌘B', does: 'Toggle the side panel (Code / Timeline / Learning)' },
      { keys: '⌘E', does: 'Toggle and focus the composer' },
      { keys: '⌘W', does: 'Close the active exited session tab' },
      { keys: '⌘.', does: 'Interrupt the running agent — works even while the terminal has focus' },
    ],
  },
  {
    title: 'Composer',
    rows: [
      { keys: 'Enter', does: 'Send — or queue, when the agent is busy' },
      { keys: '⇧Enter', does: 'New line' },
      { keys: '⌘S', does: 'Stash the draft for later' },
      { keys: '$', does: 'Insert a skill — type to filter, Enter to accept' },
    ],
  },
  {
    title: 'Command palette',
    rows: [
      { keys: '↑ ↓', does: 'Move the highlight' },
      { keys: 'Enter', does: 'Run the highlighted item' },
      { keys: 'Esc', does: 'Close' },
    ],
  },
];

export default function ShortcutSheet({ onClose }: { onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div className="shortcut-sheet" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts"
           onMouseDown={(e) => e.stopPropagation()}>
        <div className="shortcut-head">
          <h2>Keyboard shortcuts</h2>
          <button ref={closeRef} type="button" className="btn" onClick={onClose}>Close</button>
        </div>
        <div className="shortcut-groups">
          {GROUPS.map((group) => (
            <section key={group.title} className="shortcut-group" aria-label={group.title}>
              <h3>{group.title}</h3>
              {group.note && <p className="faint shortcut-note">{group.note}</p>}
              <table>
                <tbody>
                  {group.rows.map((row) => (
                    <tr key={row.keys}>
                      <td className="mono shortcut-keys">{row.keys}</td>
                      <td>{row.does}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
