import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useMaterial } from '../lib/material';
import type { Need, ProjectSummary } from '@shared/model';
import { shortcutFor, shortcutText, type CommandId } from '@shared/shortcuts';
import { bridge, useCoreStatus } from '../lib/api';
import { href, type Location } from '../lib/router';
import { setTheme, useTheme, type ThemeChoice } from '../lib/theme';
import { Icon } from '../components/icons';
import { Orb, signalFor } from '../components/Orb';
import { Button, KeyCaps, ProjectMark, useToast } from '../components/ui';
import { useAppState } from '../lib/settings';

/**
 * The rail: brand, the two primary actions, Needs you and Running, every
 * project, and the footer. Folded (⌘\), it is icons and project marks only:
 * every label stays for screen readers, and pointing at or focusing an item
 * names it beside the rail.
 */
export function Rail({ projects, needs, location, collapsed, onToggle, onNewSession, onNewCard, onAddProject, onPalette }: {
  projects: ProjectSummary[] | undefined;
  needs: Need[] | undefined;
  location: Location;
  collapsed: boolean;
  onToggle: () => void;
  onNewSession: () => void;
  onNewCard: () => void;
  onAddProject: () => void;
  onPalette: () => void;
}) {
  const material = useMaterial();
  const status = useCoreStatus();
  const { choice } = useTheme();
  const mac = bridge().platform === 'darwin';
  const nav = useRef<HTMLElement>(null);
  const route = location.route;
  const running = projects?.reduce((n, p) => n + p.liveSessions, 0) ?? 0;
  const needCount = needs?.length ?? 0;
  const activeKey = route.name === 'project' || route.name === 'session' ? route.projectKey : null;
  /** What a folded item says when pointed at: its name and, from the shortcut table, its keys. */
  const tip = (label: string, command?: CommandId): Record<string, string> => {
    if (!collapsed) return {};
    const keys = command ? shortcutFor(command) : undefined;
    return { 'data-tip': label, ...(keys ? { 'data-tip-keys': shortcutText(keys, mac) } : {}) };
  };
  const keys = (command: CommandId): ReactNode => {
    const s = shortcutFor(command);
    return s ? <KeyCaps shortcut={s} mac={mac} /> : null;
  };
  const toggleLabel = collapsed ? 'Expand the sidebar' : 'Collapse the sidebar';

  return (
    <nav className={`rail${collapsed ? ' collapsed' : ''}`} aria-label="Wanigan" ref={nav}>
      <div className="rail-brand">
        <a className="rail-orb" href={href({ name: 'needs' })} aria-label="Wanigan: what needs you" {...tip('Wanigan: what needs you')}>
          <Orb size={collapsed ? 36 : 40} signal={signalFor(needs, running)} material={material} />
        </a>
        <span className="rail-name">Wanigan</span>
      </div>

      <div className="rail-actions">
        <button type="button" className="rail-action primary" onClick={onNewSession} {...tip('New session', 'new-session')}>
          <Icon name="terminal" /><span className="rail-label">New session</span>{keys('new-session')}
        </button>
        <button type="button" className="rail-action" onClick={onNewCard} disabled={!projects?.length} {...tip('New card', 'new-card')}>
          <Icon name="plus" /><span className="rail-label">New card</span>{keys('new-card')}
        </button>
      </div>

      <ul className="rail-nav">
        <li>
          <a href={href({ name: 'needs' })} className={route.name === 'needs' ? 'active' : ''} aria-current={route.name === 'needs' ? 'page' : undefined}
            {...tip(needCount ? `Needs you: ${needCount}` : 'Needs you', 'go-needs')}>
            <Icon name="needs" /><span className="rail-label">Needs you</span>
            {needCount ? <span key={needCount} className="count hot bump">{needCount}</span> : null}
          </a>
        </li>
        <li>
          <a href={href({ name: 'running' })} className={route.name === 'running' ? 'active' : ''} aria-current={route.name === 'running' ? 'page' : undefined}
            {...tip(running ? `Running: ${running}` : 'Running', 'go-running')}>
            <Icon name="running" /><span className="rail-label">Running</span>
            {running ? <span key={running} className="count bump">{running}</span> : null}
          </a>
        </li>
      </ul>

      <div className="rail-section">
        <h2 className="rail-label">Projects</h2>
        <button type="button" className="rail-add" onClick={onAddProject} aria-label="Open a project" title={collapsed ? undefined : 'Open a project'} {...tip('Open a project')}>
          <Icon name="plus" size={14} />
        </button>
      </div>
      <ul className="rail-projects">
        {projects?.map((p, i) => {
          const notes = [!p.pathOk ? 'folder missing' : null, p.pausedAt ? 'paused' : null, p.needsYou ? `needs you: ${p.needsYou}` : p.liveSessions ? `${p.liveSessions} live` : null].filter(Boolean);
          return (
            <li key={p.id}>
              <a
                href={href({ name: 'project', projectKey: p.key, view: 'board' })}
                className={`${activeKey === p.key ? 'active' : ''}${!p.pathOk ? ' missing' : ''}${p.pausedAt ? ' paused' : ''}`}
                aria-current={activeKey === p.key ? 'page' : undefined}
                title={collapsed ? undefined : `${p.path}${i < 9 ? `  (${shortcutText(shortcutFor(`project-${i + 1}` as CommandId)!, mac)})` : ''}`}
                {...tip(notes.length ? `${p.name} · ${notes.join(' · ')}` : p.name, i < 9 ? `project-${i + 1}` as CommandId : undefined)}
              >
                <ProjectMark projectKey={p.key} size="s" />
                <span className="rail-project-name rail-label">{p.name}</span>
                {!p.pathOk ? <span className="rail-warn rail-label" title="This folder is missing">missing</span> : null}
                {p.pausedAt ? <span className="rail-paused" title="Paused"><Icon name="pause" size={13} /><span className="visually-hidden">Paused</span></span> : null}
                {p.needsYou ? <span key={p.needsYou} className="count hot bump">{p.needsYou}</span> : p.liveSessions ? <span className="live-dot" title={`${p.liveSessions} live`} /> : null}
              </a>
            </li>
          );
        })}
        {projects && !projects.length ? (
          <li className="rail-empty">
            <button type="button" onClick={onAddProject} {...tip('Open your first project')}>
              {collapsed ? <Icon name="folder" /> : null}<span className="rail-label">Open your first project</span>
            </button>
          </li>
        ) : null}
      </ul>

      <div className="rail-foot">
        <UpdateNews collapsed={collapsed} tip={tip} />
        <a className={`rail-search${route.name === 'accounts' ? ' active' : ''}`} href={href({ name: 'accounts' })} aria-current={route.name === 'accounts' ? 'page' : undefined} {...tip('Accounts')}>
          <Icon name="account" /><span className="rail-label">Accounts</span>
        </a>
        <a className={`rail-search${route.name === 'skills' ? ' active' : ''}`} href={href({ name: 'skills' })} aria-current={route.name === 'skills' ? 'page' : undefined} {...tip('Skills')}>
          <Icon name="skill" /><span className="rail-label">Skills</span>
        </a>
        <a className={`rail-search${route.name === 'mcp' ? ' active' : ''}`} href={href({ name: 'mcp' })} aria-current={route.name === 'mcp' ? 'page' : undefined} {...tip('MCP servers')}>
          <Icon name="plug" /><span className="rail-label">MCP servers</span>
        </a>
        <a className={`rail-search${route.name === 'settings' ? ' active' : ''}`} href={href({ name: 'settings' })} aria-current={route.name === 'settings' ? 'page' : undefined} {...tip('Settings', 'settings')}>
          <Icon name="settings" /><span className="rail-label">Settings</span>
        </a>
        <button type="button" className="rail-search" onClick={onPalette} {...tip('Search', 'palette')}>
          <Icon name="search" /><span className="rail-label">Search</span>{keys('palette')}
        </button>
        <div className="rail-foot-row">
          <span className={`core-status core-${status}`} title={collapsed ? undefined : statusText(status)} {...tip(statusText(status))}>
            <span className="core-dot" aria-hidden="true" /><span className="rail-label">{statusText(status)}</span>
          </span>
          <ThemeSwitch choice={choice} tip={tip} collapsed={collapsed} />
          <button type="button" className="rail-toggle" onClick={onToggle} aria-label={toggleLabel}
            title={collapsed ? undefined : `${toggleLabel} (${shortcutText(shortcutFor('toggle-rail')!, mac)})`} {...tip(toggleLabel, 'toggle-rail')}>
            <Icon name="sidebar" size={15} />
          </button>
        </div>
      </div>
      {collapsed ? <RailTip rail={nav} /> : null}
    </nav>
  );
}

/**
 * Updates, at the foot of the rail: once, whether to check GitHub daily (it is
 * never done without a yes), and after that, a new version when one is out.
 * Not in the demo, which never asks the network.
 */
function UpdateNews({ collapsed, tip }: { collapsed: boolean; tip: (label: string) => Record<string, string> }) {
  const { state, update } = useAppState();
  const toast = useToast();
  if (!state?.updates) return null;
  const fail = (e: unknown): void => toast((e as Error)?.message ?? String(e), 'error');
  if (state.updates.state === 'available') {
    const label = `Wanigan ${state.updates.release.version} is available`;
    return (
      <a className="rail-search rail-update" href={href({ name: 'settings' })} title={collapsed ? undefined : label} {...tip(label)}>
        <Icon name="pull" /><span className="rail-label">Update available</span>
      </a>
    );
  }
  if (state.settings.updateChecks !== 'ask' || collapsed) return null;
  return (
    <div className="rail-update-ask" role="group" aria-labelledby="rail-update-q">
      <p id="rail-update-q">Check for new versions once a day?</p>
      <p className="faint">GitHub receives normal connection metadata, but no project or conversation data. You can change this in Settings.</p>
      <div className="rail-update-answers">
        <Button size="s" onClick={() => update({ updateChecks: 'daily' }).catch(fail)}>Check daily</Button>
        <Button size="s" tone="quiet" onClick={() => update({ updateChecks: 'off' }).catch(fail)}>Not now</Button>
      </div>
    </div>
  );
}

function statusText(status: string): string {
  return status === 'connected' ? 'Core running' : status === 'connecting' ? 'Connecting…' : 'Core unavailable';
}

function ThemeSwitch({ choice, tip, collapsed }: { choice: ThemeChoice; tip: (label: string) => Record<string, string>; collapsed: boolean }) {
  const next: Record<ThemeChoice, ThemeChoice> = { system: 'dark', dark: 'light', light: 'system' };
  const icon = choice === 'system' ? 'auto' : choice === 'dark' ? 'moon' : 'sun';
  const label = `Theme: ${choice === 'system' ? 'match the system' : choice}`;
  return (
    <button type="button" className="theme-switch" onClick={() => setTheme(next[choice])} aria-label={`${label}. Change theme`} title={collapsed ? undefined : label} {...tip(label)}>
      <Icon name={icon} size={15} />
    </button>
  );
}

/**
 * The name of whatever is pointed at or focused in the folded rail, beside it.
 * One element for the whole rail, outside it, so a scrolling project list
 * cannot clip it. It repeats what each item's own label already says to a
 * screen reader, so it is hidden from one.
 */
function RailTip({ rail }: { rail: RefObject<HTMLElement | null> }) {
  const [shown, setShown] = useState<{ label: string; keys: string | null; top: number; left: number } | null>(null);
  useEffect(() => {
    const el = rail.current;
    if (!el) return;
    const show = (e: Event): void => {
      const target = (e.target as Element | null)?.closest?.<HTMLElement>('[data-tip]');
      if (!target || !el.contains(target)) { setShown(null); return; }
      const box = target.getBoundingClientRect();
      setShown({ label: target.dataset.tip ?? '', keys: target.dataset.tipKeys ?? null, top: box.top + box.height / 2, left: box.right });
    };
    const hide = (e: Event): void => {
      const next = (e as FocusEvent | PointerEvent).relatedTarget as Element | null;
      if (!next?.closest?.('[data-tip]') || !el.contains(next)) setShown(null);
    };
    const away = (): void => setShown(null);
    el.addEventListener('pointerover', show);
    el.addEventListener('focusin', show);
    el.addEventListener('pointerout', hide);
    el.addEventListener('focusout', hide);
    el.addEventListener('scroll', away, true);
    el.addEventListener('click', away);
    return () => {
      el.removeEventListener('pointerover', show);
      el.removeEventListener('focusin', show);
      el.removeEventListener('pointerout', hide);
      el.removeEventListener('focusout', hide);
      el.removeEventListener('scroll', away, true);
      el.removeEventListener('click', away);
    };
  }, [rail]);
  if (!shown) return null;
  return createPortal(
    <div className="rail-tip" aria-hidden="true" style={{ top: shown.top, left: shown.left }}>
      <span>{shown.label}</span>
      {shown.keys ? <span className="rail-tip-keys">{shown.keys}</span> : null}
    </div>,
    document.body,
  );
}
