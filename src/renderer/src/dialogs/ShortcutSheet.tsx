// ? or ⌘/: every keyboard shortcut, searchable, read from the same table the
// key handler and the app menu use (shared/shortcuts.ts). One Dialog: a search
// that narrows as you type, then each group as a label over its rows, each
// row's keys as caps at its end, this platform's own.
import { useMemo, useState } from 'react';
import { SHORTCUTS, SHORTCUT_GROUPS, keyLabel, keySets, shortcutText, type Shortcut } from '@shared/shortcuts';
import { bridge } from '../lib/api';
import { plural } from '../lib/format';
import { Dialog, EmptyState } from '../components/ui';
import { Icon } from '../components/icons';

export function ShortcutSheet({ onClose }: { onClose: () => void }) {
  const mac = bridge().platform === 'darwin';
  const [query, setQuery] = useState('');
  const groups = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const hit = (s: Shortcut): boolean => {
      const text = `${s.label} ${s.group} ${shortcutText(s, mac)} ${keySets(s, mac).flat().join(' ')}`.toLowerCase();
      return words.every((w) => text.includes(w));
    };
    return SHORTCUT_GROUPS.map((group) => ({ group, items: SHORTCUTS.filter((s) => s.group === group && hit(s)) })).filter((g) => g.items.length);
  }, [query, mac]);
  const found = groups.reduce((n, g) => n + g.items.length, 0);

  return (
    <Dialog title="Keyboard shortcuts" onClose={onClose} width={640}>
      <div className="shortcuts">
        <div className="shortcuts-find">
          <label className="search-field">
            <Icon name="search" size={14} />
            <input
              className="shortcuts-search"
              type="search"
              aria-label="Search shortcuts"
              aria-describedby="shortcuts-found"
              placeholder="Search by what it does, or by a key"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              data-autofocus
            />
          </label>
          <span id="shortcuts-found" className="shortcuts-found" aria-live="polite">{query ? plural(found, 'shortcut') : ''}</span>
        </div>
        {groups.length ? groups.map(({ group, items }) => (
          <section key={group} className="shortcuts-group" aria-label={group}>
            <h3>{group}</h3>
            <dl>
              {items.map((s) => (
                <div key={`${s.group}-${s.label}`} className="shortcut">
                  <dt>{s.label}</dt>
                  <dd><Keys s={s} mac={mac} /></dd>
                </div>
              ))}
            </dl>
          </section>
        )) : <EmptyState title="No shortcut matches" icon="search">Nothing is called “{query}”. Try a word for what it does, or a key.</EmptyState>}
        <p className="shortcuts-note">{keyLabel('Mod', mac)} shortcuts work even while a terminal has focus; single keys work when nothing is being typed.</p>
      </div>
    </Dialog>
  );
}

function Keys({ s, mac }: { s: Shortcut; mac: boolean }) {
  // This platform's keys: Chrome's DevTools chord is ⌥⌘I on a Mac and Ctrl+Shift+I elsewhere.
  const sets = keySets(s, mac);
  return (
    <span className="shortcut-keys" aria-label={shortcutText(s, mac)}>
      {sets.map((keys, i) => (
        <span key={keys.join()} className="shortcut-set keycaps" aria-hidden="true">
          {i ? <span className="shortcut-or">or</span> : null}
          {keys.map((k, j) => (
            <span key={k} className="shortcut-key">
              {j && s.sequence ? <span className="shortcut-then">then</span> : null}
              <kbd>{keyLabel(k, mac)}</kbd>
            </span>
          ))}
        </span>
      ))}
    </span>
  );
}
