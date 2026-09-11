import { useState } from 'react';
import type { ThemeSetting } from '@shared/types';
import type { ResolvedTheme } from '../theme-boot';
import { Icon } from './bits';

const THEMES = ['system', 'light', 'dark'] as const;

/** A compact, native control: keyboard-, touch-, and screen-reader-friendly. */
export default function ThemeControl({
  preference,
  resolved,
  onChange,
  variant = 'compact',
}: {
  preference: ThemeSetting;
  resolved: ResolvedTheme;
  onChange: (preference: ThemeSetting) => Promise<ThemeSetting>;
  variant?: 'compact' | 'card';
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function choose(value: string) {
    if (value !== 'system' && value !== 'light' && value !== 'dark') return;
    if (saving || value === preference) return;
    setSaving(true);
    setError(null);
    try {
      await onChange(value);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  const effective = resolved === 'dark' ? 'dark' : 'light';
  if (variant === 'card') return (
    <fieldset className="theme-gallery" disabled={saving}>
      <legend className="sr-only">Colour theme</legend>
      <div className="theme-choices" role="radiogroup" aria-label="Colour theme">
        {THEMES.map((theme, index) => <button key={theme} type="button" role="radio"
          aria-checked={preference === theme} aria-label={theme[0].toUpperCase() + theme.slice(1)}
          tabIndex={preference === theme ? 0 : -1} className="theme-choice" data-appearance={theme}
          onClick={() => void choose(theme)} onKeyDown={event => {
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? THEMES.length - 1
              : ['ArrowRight', 'ArrowDown'].includes(event.key) ? (index + 1) % THEMES.length
              : ['ArrowLeft', 'ArrowUp'].includes(event.key) ? (index + THEMES.length - 1) % THEMES.length : null;
            if (next === null) return;
            event.preventDefault();
            const group = event.currentTarget.parentElement;
            void choose(THEMES[next]).then(() => group?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus());
          }}>
          <span className="theme-preview" aria-hidden="true">
            <span className="theme-preview-bar"><i /><i /><i /></span>
            <span className="theme-preview-rail"><i /><i /><i /></span>
            <span className="theme-preview-body"><i /><i /><i /></span>
            <span className="theme-preview-dock"><i /><i /><i /></span>
          </span>
          <span className="theme-choice-label"><Icon name={theme === 'system' ? 'panel' : theme === 'light' ? 'sun' : 'moon'} />
            {theme[0].toUpperCase() + theme.slice(1)}<span className="theme-choice-check" aria-hidden="true">✓</span>
          </span>
        </button>)}
      </div>
      <p className="theme-gallery-status" role="status">{error ? `Theme was not saved: ${error}`
        : saving ? 'Saving appearance…' : preference === 'system' ? `Following your Mac. Currently ${effective}.` : `${preference === 'dark' ? 'Dark' : 'Light'} appearance is selected.`}</p>
    </fieldset>
  );
  return (
    <label className={`theme-control theme-control-${variant}`} title="Choose light, dark, or your Mac’s appearance">
      <span className="theme-control-glyph" aria-hidden="true">{effective === 'dark' ? '◐' : '◑'}</span>
      <span className="theme-control-label">Theme</span>
      <select value={preference} disabled={saving} onChange={(event) => void choose(event.currentTarget.value)}
              aria-label={`Colour theme: ${preference}; currently ${effective}`}>
        <option value="system">System ({effective})</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
      {error && <span className="theme-control-error" role="status">Theme was not saved: {error}</span>}
    </label>
  );
}
