// "Edit" wherever a file is shown (Changes, a turn's diff, a part in the live
// view): it opens in the code editor. Any surface can use openInEditor
// directly; this is the button they share.
import type { ButtonHTMLAttributes } from 'react';
import { Button } from '../components/ui';
import { openInEditor, type EditorTarget } from './store';

export { openInEditor, type EditorTarget } from './store';

/** A path inside `root` as the editor names it (relative, with /), or null when it is not inside. */
export function relativeTo(root: string, path: string): string | null {
  const base = root.replace(/\/+$/, '');
  return path.startsWith(`${base}/`) ? path.slice(base.length + 1) : null;
}

export function EditButton({ target, label = 'Edit', tone = 'quiet', ...rest }: {
  target: EditorTarget; label?: string; tone?: 'plain' | 'quiet' | 'primary';
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'>) {
  const name = target.path.split('/').pop() ?? target.path;
  return (
    <Button size="s" tone={tone} icon="code" title={`Open ${target.path} in the code editor`} aria-label={label === 'Edit' ? `Edit ${name}` : undefined}
      {...rest} onClick={() => openInEditor(target)}>
      {label}
    </Button>
  );
}
