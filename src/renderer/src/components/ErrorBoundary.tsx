import { Component, Fragment } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

/**
 * This window is the only visible surface of agents whose processes live in
 * the main process. When a render throw reaches the React root the entire tree
 * unmounts, so a live PTY keeps running with nothing on screen to read it,
 * answer its permission prompt, or stop it — a white window over a working
 * agent, which is worse than an error message.
 *
 * The boundary is therefore mounted around the view body alone. The header,
 * the nav rail, the global shortcuts and the command palette all survive a
 * view that cannot render, so the failure costs one surface rather than the
 * session.
 *
 * React routes only errors thrown during render, in a lifecycle method, or in
 * a constructor below this point. An event handler or a rejected promise still
 * has to report through the shell's own error surface.
 */

type Props = {
  /** Identity of the surface below. A change clears a stale fallback. */
  view: string;
  /** What the operator calls this surface; the fallback has to name it. */
  label: string;
  children: ReactNode;
};

type State = { error: Error | null; stack: string | null; attempt: number };

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, stack: null, attempt: 0 };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    // A thrown non-Error still has to produce a readable sentence.
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    // The console is the only sink a renderer crash has here — there is no
    // log IPC channel — and dropping the stack would leave the fallback's one
    // sentence as the sole record of a bug that reproduces once a week.
    console.error(`[wanigan] the ${this.props.label} view failed to render`, error, info.componentStack);
    this.setState({ stack: info.componentStack ?? null });
  }

  componentDidUpdate(prev: Props): void {
    // Leaving a broken view is itself a recovery. Keeping the fallback after
    // the operator navigated away would blame the next view for the last one.
    if (prev.view !== this.props.view && this.state.error !== null) {
      this.setState({ error: null, stack: null });
    }
  }

  /** A new key remounts the subtree, so a view that broke on its own stale
   *  state gets a genuinely new instance rather than the same one re-rendered. */
  private reload = (): void => {
    this.setState((s) => ({ error: null, stack: null, attempt: s.attempt + 1 }));
  };

  render(): ReactNode {
    const { error, stack, attempt } = this.state;
    if (!error) return <Fragment key={attempt}>{this.props.children}</Fragment>;
    return (
      <section className="empty" role="alert">
        <div style={{ maxWidth: 520, textAlign: 'left' }}>
          <h1 style={{ fontSize: 'var(--t-title)', fontWeight: 600 }}>
            The {this.props.label} view stopped rendering
          </h1>
          <p className="dim" style={{ marginTop: 6, lineHeight: 1.55 }}>
            {error.message || 'The view threw while rendering and has no message.'}
          </p>
          <p className="faint" style={{ marginTop: 6, lineHeight: 1.5 }}>
            Only this view is affected. Agent processes run outside the window, so a session that
            was running is still running and its terminal reattaches with its scrollback. Reload
            the view, or move to another one and come back.
          </p>
          {stack && (
            <details style={{ marginTop: 10 }}>
              <summary className="faint" style={{ fontSize: 'var(--t-small)', cursor: 'pointer' }}>
                Component stack
              </summary>
              <pre className="mono faint" style={{
                marginTop: 6, maxHeight: 180, overflow: 'auto', whiteSpace: 'pre-wrap',
                fontSize: 'var(--t-micro)', lineHeight: 1.45,
              }}>{stack.trim()}</pre>
            </details>
          )}
        </div>
        <button className="btn btn-primary" type="button" onClick={this.reload}>Reload view</button>
      </section>
    );
  }
}
