// ? or ⌘/: every keyboard shortcut, searchable, read from the same table the
// key handler and the app menu use (shared/shortcuts.ts).
import { useMemo, useState } from 'react';
import { SHORTCUTS, SHORTCUT_GROUPS, keyLabel, shortcutText, type Shortcut } from '@shared/shortcuts';
import { bridge } from '../lib/api';
import { Dialog } from '../components/ui';

export function ShortcutSheet({ onClose }: { onClose: () => void }) {
  const mac = bridge().platform === 'darwin';
  const [query, setQuery] = useState('');
  const groups = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const hit = (s: Shortcut): boolean => {
      const text = `${s.label} ${s.group} ${shortcutText(s, mac)} ${[s.keys, ...(s.alt ?? [])].flat().join(' ')}`.toLowerCase();
      return words.every((w) => text.includes(w));
    };
    return SHORTCUT_GROUPS.map((group) => ({ group, items: SHORTCUTS.filter((s) => s.group === group && hit(s)) })).filter((g) => g.items.length);
  }, [query, mac]);

  return (
    <Dialog title="Keyboard shortcuts" onClose={onClose} width={620}>
      <div className="shortcuts">
        <input
          className="shortcuts-search"
          type="search"
          aria-label="Search shortcuts"
          placeholder="Search shortcuts"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          data-autofocus
        />
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
        )) : <p className="faint">No shortcut matches “{query}”.</p>}
        <p className="faint small">{keyLabel('Mod', mac)} shortcuts work even while a terminal has focus; single keys work when nothing is being typed.</p>
      </div>
    </Dialog>
  );
}

function Keys({ s, mac }: { s: Shortcut; mac: boolean }) {
  const sets = [s.keys, ...(s.alt ?? [])];
  return (
    <span className="shortcut-keys" aria-label={shortcutText(s, mac)}>
      {sets.map((keys, i) => (
        <span key={keys.join()} className="shortcut-set" aria-hidden="true">
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
