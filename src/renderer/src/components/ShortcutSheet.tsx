import { useMemo, useState } from 'react';
import { Icon } from './bits';
import { keymapGroups, type EffectiveKeymap } from '@shared/keymap';
import { BINDING_GROUPS, chordLabels, useKeymap, type BindingGroup } from '../bindings';
import { useDialog } from './useDialog';

/**
 * The cheat sheet is a document, not a config: it lists what the running
 * build actually binds, grouped by where the key works. Its rows are the
 * effective keymap — the binding table and the route table with the operator's
 * rebindings laid over them — which is the record the handlers match against,
 * so a chord this sheet prints is a chord that works, rebound or not. The
 * grouping, the notes and the prose stay hand-written; only the rows are data.
 */

type Row = { keys: string; does: string };
type Group = { title: BindingGroup; note?: string; rows: Row[] };

/**
 * The notes name chords too, and read them from the same map. The interrupt's
 * ⌘. is fixed, so it is written out; the palette's chord can move.
 */
function notes(map: EffectiveKeymap): Partial<Record<BindingGroup, string>> {
  return {
    Anywhere: 'The terminal owns every keystroke while it has focus — ⌘. is the one chord it forwards; click outside it first for the rest. The menu bar prints these chords but does not take them, which is how that stays true. Settings › App › Keyboard changes them.',
    'Destination list': `Tab enters the list once; the arrows walk it. Every view is in it, so ${chordLabels(map, 'palette').glyphs} is a search box rather than the only way to reach two of them.`,
    'Sessions view': 'Click a session and focus goes to its terminal, which is where you want it — and where none of these work. Click the session list or press Tab to step off the terminal first.',
  };
}

/**
 * Anywhere reads: palette, new session, the view routes, then demo and the
 * sheet itself — the order a reader scans, not the order the handlers run.
 * shared/keymap.ts owns that order, so Settings lists the same rows the same way.
 */
function buildGroups(map: EffectiveKeymap): Group[] {
  const prose = notes(map);
  return keymapGroups(map).map((group) => ({
    title: group.title,
    note: prose[group.title],
    rows: group.bindings.map((binding) => ({ keys: chordLabels(map, binding.id).keys, does: binding.does })),
  }));
}

export default function ShortcutSheet({ onClose }: { onClose: () => void }) {
  // The hook portals above the header, traps Tab, answers Escape in the
  // capture phase and hands focus back to whatever opened the sheet.
  const { portal, backdropProps, dialogProps } = useDialog<HTMLDivElement>({ onClose, initialFocus: 'first' });

  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<BindingGroup | 'All'>('All');
  // Re-read when the keymap changes, so a chord rebound while the sheet is
  // open is the chord it prints.
  const { map } = useKeymap();
  const all = useMemo(() => buildGroups(map), [map]);
  const groups = useMemo(() => all.filter(group => scope === 'All' || group.title === scope)
    .map(group => ({ ...group, rows: group.rows.filter(row => `${row.does} ${row.keys} ${group.title}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) }))
    .filter(group => group.rows.length > 0), [all, query, scope]);
  const count = groups.reduce((sum, group) => sum + group.rows.length, 0);
  return portal(
    <div {...backdropProps}>
      <div {...dialogProps} className="shortcut-sheet shortcut-browser" aria-label="Keyboard shortcuts">
        <div className="shortcut-head">
          <h2>Keyboard shortcuts</h2>
          <button type="button" className="btn" onClick={onClose}>Close</button>
        </div>
        <div className="shortcut-search"><Icon name="search" /><input className="field" type="search" aria-label="Find a keyboard shortcut" placeholder="Find an action or a key…" value={query} onChange={event => setQuery(event.target.value)} data-initial-focus /></div>
        <div className="shortcut-layout"><nav className="shortcut-sections" aria-label="Shortcut categories">
          {(['All', ...BINDING_GROUPS] as const).map(title => <button className="btn" type="button" key={title} aria-pressed={scope === title} onClick={() => setScope(title)}>{title === 'All' ? 'All shortcuts' : title}</button>)}
        </nav><div className="shortcut-groups">
          {groups.map((group) => (
            <section key={group.title} className="shortcut-group" aria-label={group.title}>
              <h3>{group.title}</h3>
              {group.note && <p className="faint shortcut-note">{group.note}</p>}
              <table>
                <tbody>
                  {group.rows.map((row) => (
                    <tr key={`${row.keys} ${row.does}`}>
                      <td className="shortcut-keys"><kbd>{row.keys}</kbd></td>
                      <td>{row.does}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ))}
          {count === 0 && <div className="shortcut-empty"><p>No shortcuts match this search. Try the action’s name.</p><button className="btn" onClick={() => { setQuery(''); setScope('All'); }}>Clear search</button></div>}
        </div></div>
        <p className="shortcut-results" role="status">{count} shortcuts shown. Keys apply when focus is outside the terminal, unless noted.</p>
      </div>
    </div>,
  );
}
