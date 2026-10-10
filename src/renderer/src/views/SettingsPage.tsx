// One of Settings' sections as a page: its name and tools in the bar, then its
// settings in groups, each a small label over one panel of rows. Every section
// (Appearance to Jev, and Accounts, Skills and MCP servers) is drawn from these,
// so they read as one place.
import type { ReactNode } from 'react';
import { Section } from '../components/Panel';

/** The section's bar and its scrolling body. `id` is its heading's, which names the page. */
export function SettingsPage({ id, title, meta, tools, children, width = 'm', className }: {
  id: string;
  title: string;
  /** Beside the title: a count, when it was checked. */
  meta?: ReactNode;
  tools?: ReactNode;
  children: ReactNode;
  /** `m` reads as a column (most settings); `l` for a list with more on each row. */
  width?: 'm' | 'l';
  className?: string;
}) {
  return (
    <section className={`view settings-page${className ? ` ${className}` : ''}`} aria-labelledby={id}>
      <header className="topbar">
        <div className="topbar-title"><h1 id={id}>{title}</h1>{meta}</div>
        {tools ? <div className="topbar-tools">{tools}</div> : null}
      </header>
      <div className="view-body">
        <div className={`settings-body settings-body-${width}`}>{children}</div>
      </div>
    </section>
  );
}

/** A group of settings: its label, and its rows on one panel. `tour` names it for a guided tour's stop. */
export function SettingsGroup({ title, actions, note, children, tour, className }: {
  title: ReactNode;
  actions?: ReactNode;
  /** A line under the label, for what the whole group needs said (why its switches wait). */
  note?: ReactNode;
  children: ReactNode;
  tour?: string;
  className?: string;
}) {
  return (
    <div className={`settings-group${className ? ` ${className}` : ''}`} data-tour={tour}>
      <Section title={title} actions={actions}>
        {note ? <p className="settings-note">{note}</p> : null}
        <div className="settings-list">{children}</div>
      </Section>
    </div>
  );
}

/** One row: what it is (and a quieter line on what it does), and its control at the end. */
export function SettingRow({ label, hint, control, children, className, live }: {
  label?: ReactNode;
  hint?: ReactNode;
  control?: ReactNode;
  /** Under the words: a meter, a list, a command. */
  children?: ReactNode;
  className?: string;
  /** Its hint changes on its own (a check's result): read out when it does. */
  live?: boolean;
}) {
  return (
    <div className={`setting${className ? ` ${className}` : ''}`}>
      {label || hint || children ? (
        <div className="setting-text">
          {label ? <div className="setting-label">{label}</div> : null}
          {hint ? <div className="setting-hint" aria-live={live ? 'polite' : undefined}>{hint}</div> : null}
          {children}
        </div>
      ) : null}
      {control ? <div className="setting-control">{control}</div> : null}
    </div>
  );
}
