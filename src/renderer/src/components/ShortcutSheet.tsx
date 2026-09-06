import { TAB_SHORTCUTS, VIEW_SHORTCUT_ORDER, labelForTab } from '@shared/routes';
import { BINDINGS, BINDING_GROUPS, type Binding, type BindingGroup } from '../bindings';
import { useDialog } from './useDialog';

/**
 * The cheat sheet is a document, not a config: it lists what the running
 * build actually binds, grouped by where the key works. The view rows derive
 * from the same route table the key handler reads (shared/routes.ts) and the
 * rest from the bindings table the handlers match against (bindings.ts), so
 * a chord this sheet prints is a chord that works — the promise the old
 * hand-written list made and did not keep once ⌘⇧I and ⌘⇧U arrived. The
 * grouping, the note and the prose stay hand-written; only the rows are data.
 */

type Row = { keys: string; does: string };
type Group = { title: BindingGroup; note?: string; rows: Row[] };

const NOTES: Partial<Record<BindingGroup, string>> = {
  Anywhere: 'The terminal owns every keystroke while it has focus — ⌘. is the one chord it forwards; click outside it first for the rest. The menu bar prints these chords but does not take them, which is how that stays true.',
  'Destination list': 'Tab enters the list once; the arrows walk it. Every view is in it, so ⌘K is a search box rather than the only way to reach two of them.',
  'Sessions view': 'Click a session and focus goes to its terminal, which is where you want it — and where none of these work. Click the session list or press Tab to step off the terminal first.',
};

/** ⌘1 Sessions … ⌘0 Runs, ⌘, Settings, then the named chords. */
function viewRows(): Row[] {
  return VIEW_SHORTCUT_ORDER.map((id) => ({ keys: TAB_SHORTCUTS[id].label, does: labelForTab(id) }));
}

function rowOf(binding: Binding): Row {
  return { keys: binding.keys, does: binding.does };
}

/**
 * Anywhere reads: palette, new session, the view routes, then demo and the
 * sheet itself — the order a reader scans, not the order the handlers run.
 */
function buildGroups(): Group[] {
  return BINDING_GROUPS.map((title) => {
    const own = BINDINGS.filter((b) => b.group === title);
    let rows: Row[];
    if (title === 'Anywhere') {
      const before = own.filter((b) => b.id === 'palette' || b.id === 'new-session').map(rowOf);
      const after = own.filter((b) => b.id !== 'palette' && b.id !== 'new-session').map(rowOf);
      rows = [...before, ...viewRows(), ...after];
    } else {
      rows = own.map(rowOf);
    }
    return { title, note: NOTES[title], rows };
  }).filter((group) => group.rows.length > 0);
}

const GROUPS: Group[] = buildGroups();

export default function ShortcutSheet({ onClose }: { onClose: () => void }) {
  // The hook portals above the header, traps Tab, answers Escape in the
  // capture phase and hands focus back to whatever opened the sheet.
  const { portal, backdropProps, dialogProps } = useDialog<HTMLDivElement>({ onClose, initialFocus: 'first' });

  return portal(
    <div {...backdropProps}>
      <div {...dialogProps} className="shortcut-sheet" aria-label="Keyboard shortcuts">
        <div className="shortcut-head">
          <h2>Keyboard shortcuts</h2>
          <button type="button" className="btn" onClick={onClose}>Close</button>
        </div>
        <div className="shortcut-groups">
          {GROUPS.map((group) => (
            <section key={group.title} className="shortcut-group" aria-label={group.title}>
              <h3>{group.title}</h3>
              {group.note && <p className="faint shortcut-note">{group.note}</p>}
              <table>
                <tbody>
                  {group.rows.map((row) => (
                    <tr key={`${row.keys} ${row.does}`}>
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
    </div>,
  );
}
