// A view that throws shows a calm panel in its place, never a blank window: what
// went wrong, a way to load the view again, and the details to pass on. The rest
// of the window keeps working, and nothing in the core is touched: sessions run
// there, not here.
import { Component, useId, useState, type ErrorInfo, type ReactNode } from 'react';
import { Icon } from './icons';
import { Button } from './ui';

interface Props {
  /** What this boundary holds, in words: "Running", "the card drawer". */
  name: string;
  /** Changing it (a new route, another card) clears a crash: it was about what was shown before. */
  resetKey?: string;
  /** A small panel for a narrow place (the rail, the drawer). */
  compact?: boolean;
  /** Where the panel goes when what crashed was positioned (a drawer, a dialog); null shows nothing. */
  frame?: (panel: ReactNode) => ReactNode;
  /** Offer to close what crashed, for a drawer or dialog. */
  onClose?: () => void;
  children: ReactNode;
}

interface State {
  error: Error | null;
  componentStack: string | null;
  /** Bumped by "Reload this view", so the view mounts afresh and refetches. */
  attempt: number;
  resetKey: string | undefined;
}

export class ViewBoundary extends Component<Props, State> {
  override state: State = { error: null, componentStack: null, attempt: 0, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (props.resetKey === state.resetKey) return null;
    return { resetKey: props.resetKey, error: null, componentStack: null };
  }

  override componentDidCatch(_error: unknown, info: ErrorInfo): void {
    this.setState({ componentStack: info.componentStack ?? null });
  }

  private readonly reload = (): void => {
    this.setState((s) => ({ error: null, componentStack: null, attempt: s.attempt + 1 }));
  };

  override render(): ReactNode {
    const { error, componentStack, attempt } = this.state;
    if (!error) return <Keyed key={attempt}>{this.props.children}</Keyed>;
    const panel = (
      <ViewCrash name={this.props.name} error={error} componentStack={componentStack} compact={!!this.props.compact}
        onReload={this.reload} onClose={this.props.onClose} />
    );
    return this.props.frame ? this.props.frame(panel) : panel;
  }
}

function Keyed({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

/** Everything someone would need to know what broke, as plain text. */
export function crashDetails(name: string, error: Error, componentStack: string | null): string {
  return [
    `Wanigan: ${name} stopped working`,
    `When: ${new Date().toISOString()}`,
    `Where: ${location.hash || '#/'}`,
    `Browser: ${navigator.userAgent}`,
    '',
    `${error.name}: ${error.message}`,
    error.stack ?? '',
    componentStack ? `\nComponents:${componentStack}` : '',
  ].join('\n').trim();
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Without clipboard permission (or focus), the old way still works.
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

function ViewCrash({ name, error, componentStack, compact, onReload, onClose }: {
  name: string;
  error: Error;
  componentStack: string | null;
  compact: boolean;
  onReload: () => void;
  onClose: (() => void) | undefined;
}) {
  const [copied, setCopied] = useState<'yes' | 'no' | null>(null);
  const titleId = useId();
  return (
    <div className={`view-crash${compact ? ' view-crash-compact' : ''}`} role="alert" aria-labelledby={titleId}>
      <div className="view-crash-box">
        <span className="view-crash-icon" aria-hidden="true"><Icon name="alert" size={18} /></span>
        <h2 id={titleId}>{name} stopped working</h2>
        <p className="view-crash-lede">
          This view could not be displayed. Sessions and data are managed by Wanigan’s core. Check the core status in the sidebar before continuing.
        </p>
        <pre className="view-crash-error">{`${error.name}: ${error.message}`}</pre>
        <div className="view-crash-actions">
          <Button tone="primary" icon="refresh" onClick={onReload}>Reload this view</Button>
          <Button onClick={() => copy(crashDetails(name, error, componentStack)).then((ok) => setCopied(ok ? 'yes' : 'no'))}>
            Copy details
          </Button>
          {onClose ? <Button tone="quiet" onClick={onClose}>Close</Button> : null}
          <span className="faint small" role="status">{copied === 'yes' ? 'Copied.' : copied === 'no' ? 'Could not copy.' : ''}</span>
        </div>
      </div>
    </div>
  );
}
