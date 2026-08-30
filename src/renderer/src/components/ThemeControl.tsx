import { useState } from 'react';
import type { ThemeSetting } from '@shared/types';
import type { ResolvedTheme } from '../theme-boot';

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
