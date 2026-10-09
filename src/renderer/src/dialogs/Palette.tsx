// ⌘K: every place, project, card, live session and command by typing, and,
// from three characters, what agents said in their sessions. Results are
// grouped; the arrow keys move across groups and Enter runs the one chosen.
// Key caps come from the shortcut table, the same one the keys obey.
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { LIVE_STATES, type ProjectSummary } from '@shared/model';
import { PALETTE_GROUPS, PER_GROUP, arrange, step, type PaletteGroup } from '@shared/palette';
import { SAID_MIN_QUERY, saidCutText, type SaidHit, type SaidSearch } from '@shared/said';
import { GIT_COMMANDS, keyLabel, shortcutFor, type CommandId, type GitCommandId } from '@shared/shortcuts';
import { bridge, call, useQuery } from '../lib/api';
import { PROJECT_VIEWS, navigate, type ProjectView } from '../lib/router';
import { setTheme } from '../lib/theme';
import { STATE_LABEL, ago } from '../lib/format';
import { Icon, type IconName } from '../components/icons';
import { KeyCaps } from '../components/ui';
import type { DialogState } from '../App';
import { useCoversLive } from '../lib/live';

interface Item {
  id: string;
  group: PaletteGroup;
  label: string;
  detail?: string;
  icon: IconName;
  /** Runs through the app's one command table, and shows that command's keys. */
  command?: CommandId;
  run?: () => void;
  whenTyped?: boolean;
  /** A match the core found in a session's title or output. */
  said?: SaidHit;
}

const GIT_ICON: Record<GitCommandId, IconName> = {
  'git-commit': 'commit', 'git-push': 'push', 'git-pull': 'pull', 'git-fetch': 'refresh', 'git-switch': 'branch', 'git-branch': 'branch', 'git-stash': 'stash',
};

const VIEW_ICON: Record<ProjectView, IconName> = {
  board: 'board', list: 'list', sessions: 'sessions', history: 'history', changes: 'file', decisions: 'decisions', activity: 'activity', live: 'live',
};

/** What agents said, searched by the core once three characters are typed and typing pauses. */
function useSaid(query: string): { result: SaidSearch | null; error: string | null; pending: boolean } {
  const q = query.trim();
  const asked = q.length >= SAID_MIN_QUERY;
  const [answer, setAnswer] = useState<{ q: string; result: SaidSearch | null; error: string | null }>({ q: '', result: null, error: null });
  useEffect(() => {
    if (!asked) return;
    let current = true;
    const timer = setTimeout(() => {
      call('sessions.search', { query: q, limit: PER_GROUP }).then(
        (result) => { if (current) setAnswer({ q, result, error: null }); },
        (error: Error) => { if (current) setAnswer({ q, result: null, error: error.message }); },
      );
    }, 220);
    return () => { current = false; clearTimeout(timer); };
  }, [q, asked]);
  const now = asked && answer.q === q;
  return { result: now ? answer.result : null, error: now ? answer.error : null, pending: asked && !now };
}

export function Palette({ projects, currentProject, onClose, setDialog, runCommand }: {
  projects: ProjectSummary[];
  currentProject: ProjectSummary | undefined;
  onClose: () => void;
  setDialog: (d: DialogState) => void;
  /** The app's command table (App.tsx), so a command here does exactly what its keys do. */
  runCommand: (id: CommandId) => boolean;
}) {
  const mac = bridge().platform === 'darwin';
  useCoversLive();
  const [query, setQuery] = useState('');
  const [activeId, setActiveId] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const q = query.trim();
  const cards = useQuery('cards.list', currentProject ? { projectId: currentProject.id } : null, ['board']);
  const everywhere = useQuery('cards.search', q.length >= 2 ? { query: q } : null, ['board']);
  const sessions = useQuery('sessions.list', { live: true }, ['sessions']);
  const said = useSaid(query);

  const items = useMemo<Item[]>(() => {
    const keyed = (id: CommandId, group: PaletteGroup, icon: IconName, label = shortcutFor(id)?.label ?? id, detail?: string): Item =>
      ({ id, group, label, icon, command: id, ...(detail ? { detail } : {}) });
    const out: Item[] = [
      keyed('go-needs', 'Go to', 'needs', 'Needs you'),
      keyed('go-running', 'Go to', 'running', 'Running'),
      // G then a letter, in the open project: shown here so the chords can be found.
      ...(currentProject ? PROJECT_VIEWS.map((v) => keyed(`go-${v.view}` as CommandId, 'Go to', VIEW_ICON[v.view], v.label)) : []),
      keyed('go-accounts', 'Go to', 'account', 'Accounts'),
      { id: 'go-skills', group: 'Go to', label: 'Skills', icon: 'skill', run: () => navigate({ name: 'skills' }) },
      { id: 'go-mcp', group: 'Go to', label: 'MCP servers', icon: 'plug', run: () => navigate({ name: 'mcp' }) },
      keyed('settings', 'Go to', 'settings', 'Settings'),
    ];
    projects.forEach((p, i) => {
      out.push({
        id: `p-${p.id}`, group: 'Projects', label: p.name, detail: p.key, icon: 'folder',
        ...(i < 9 ? { command: `project-${i + 1}` as CommandId } : { run: () => navigate({ name: 'project', projectKey: p.key, view: 'board' }) }),
      });
      for (const v of PROJECT_VIEWS) {
        out.push({ id: `p-${p.id}-${v.view}`, group: 'Projects', label: `${p.name}: ${v.label}`, detail: p.key, icon: VIEW_ICON[v.view], whenTyped: true,
          run: () => navigate({ name: 'project', projectKey: p.key, view: v.view }) });
      }
    });
    const seen = new Set<string>();
    for (const c of [...(cards.data ?? []), ...(everywhere.data ?? [])]) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      const key = projects.find((p) => p.id === c.projectId)?.key ?? '';
      out.push({
        id: `c-${c.id}`, group: 'Cards', label: `${c.key} ${c.title}`, detail: c.projectId === currentProject?.id ? c.status : `${c.status} in ${key}`, icon: 'board',
        run: () => navigate({ name: 'project', projectKey: key, view: 'board' }, c.key),
      });
    }
    for (const s of sessions.data ?? []) {
      const p = projects.find((x) => x.id === s.projectId);
      if (p) out.push({ id: `s-${s.id}`, group: 'Sessions', label: s.title, detail: `${STATE_LABEL[s.state]} in ${p.key}`, icon: 'terminal', run: () => navigate({ name: 'session', projectKey: p.key, sessionId: s.id }) });
    }
    out.push(keyed('new-session', 'Commands', 'terminal'));
    if (projects.length) out.push(keyed('new-card', 'Commands', 'plus'));
    // Git, in the open project's Changes view: found by typing ("push", "commit", "git").
    if (currentProject) for (const c of GIT_COMMANDS) out.push({ ...keyed(c.id, 'Commands', GIT_ICON[c.id], `Git: ${c.label}`, currentProject.key), whenTyped: true });
    out.push(
      { id: 'open-project', group: 'Commands', label: 'Open a project…', icon: 'folder', run: () => setDialog({ kind: 'project' }) },
      ...(currentProject ? [keyed('history', 'Commands', 'history')] : []),
      keyed('toggle-rail', 'Commands', 'sidebar'),
      keyed('shortcuts', 'Commands', 'question'),
      { id: 'theme-dark', group: 'Commands', label: 'Theme: dark', icon: 'moon', run: () => setTheme('dark') },
      { id: 'theme-light', group: 'Commands', label: 'Theme: light', icon: 'sun', run: () => setTheme('light') },
      { id: 'theme-system', group: 'Commands', label: 'Theme: match the system', icon: 'auto', run: () => setTheme('system') },
    );
    for (const [i, hit] of (said.result?.hits ?? []).entries()) {
      const text = `${hit.snippet.before}${hit.snippet.match}${hit.snippet.after}`;
      out.push({ id: `said-${hit.sessionId}-${i}`, group: 'Said in sessions', label: text, icon: 'terminal', said: hit,
        run: () => navigate({ name: 'session', projectKey: hit.projectKey, sessionId: hit.sessionId }) });
    }
    return out;
  }, [projects, currentProject, cards.data, everywhere.data, sessions.data, said.result, setDialog]);

  const groups = useMemo(() => arrange(items.map((i) => ({ ...i, text: `${i.label} ${i.detail ?? ''}`, found: !!i.said })), query), [items, query]);
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const activeIndex = Math.max(0, flat.findIndex((i) => i.id === activeId));
  const active = flat[activeIndex];
  const optionId = (id: string): string => `pal-${uid}-${id.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  const saidNote = said.error ?? (said.result ? saidCutText(said.result.cut) : null);
  const saidShown = groups.some((g) => g.group === 'Said in sessions');

  useEffect(() => { input.current?.focus(); }, []);
  // Keep the chosen result in view; the first of a group brings its heading too.
  useEffect(() => {
    if (!active) return;
    const el = document.getElementById(optionId(active.id));
    const first = el?.previousElementSibling?.classList.contains('palette-group-head') ? el.previousElementSibling : null;
    (first ?? el)?.scrollIntoView({ block: 'nearest' });
    if (first) el?.scrollIntoView({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id]);

  const choose = (item: Item | undefined): void => {
    if (!item) return;
    onClose();
    if (item.run) item.run();
    else if (item.command) runCommand(item.command);
  };

  const onKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = flat[step(flat.length ? activeIndex : -1, e.key === 'ArrowDown' ? 1 : -1, flat.length)];
      if (next) setActiveId(next.id);
    } else if (e.key === 'Enter') { e.preventDefault(); choose(active); }
    else if (e.key === 'Tab') e.preventDefault(); // one field: focus stays in it
  };

  const count = flat.length;
  const announce = said.pending ? '' : `${count ? `${count} result${count === 1 ? '' : 's'}` : 'No results'}.${saidNote ? ` ${saidNote}` : ''}`;
  const placeholder = currentProject ? `Search ${currentProject.name}, every project, what agents said, and actions` : 'Search projects, sessions, what agents said, and actions';

  return createPortal(
    <div className="scrim scrim-top" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Search and commands" onKeyDown={onKey}>
        <div className="palette-input">
          <Icon name="search" />
          <input
            ref={input}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActiveId(null); }}
            placeholder={placeholder}
            aria-label="Search"
            role="combobox"
            aria-expanded="true"
            aria-autocomplete="list"
            aria-controls={`pal-${uid}-list`}
            aria-activedescendant={active ? optionId(active.id) : undefined}
            spellCheck={false}
          />
        </div>
        <div className="palette-results" id={`pal-${uid}-list`} role="listbox" aria-label="Results" ref={list}>
          {groups.map(({ group, items: rows }) => (
            <div key={group} className="palette-group" role="group" aria-labelledby={`pal-${uid}-g${PALETTE_GROUPS.indexOf(group)}`}>
              <div className="palette-group-head" id={`pal-${uid}-g${PALETTE_GROUPS.indexOf(group)}`} role="presentation">{group}</div>
              {rows.map((item) => (
                <div
                  key={item.id}
                  id={optionId(item.id)}
                  role="option"
                  aria-selected={item.id === active?.id}
                  className={`palette-option${item.id === active?.id ? ' active' : ''}${item.said ? ' palette-said' : ''}`}
                  title={item.said ? saidWhen(item.said) : undefined}
                  onMouseMove={() => { if (item.id !== active?.id) setActiveId(item.id); }}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(item)}
                >
                  <Icon name={item.icon} size={15} />
                  {item.said ? <SaidRow hit={item.said} /> : (
                    <>
                      <span className="palette-label">{item.label}</span>
                      {item.detail ? <span className="palette-detail">{item.detail}</span> : null}
                    </>
                  )}
                  {item.command ? <Keys id={item.command} mac={mac} /> : null}
                </div>
              ))}
              {group === 'Said in sessions' && saidNote ? <div className={`palette-note${said.error ? ' error-text' : ''}`} role="presentation">{saidNote}</div> : null}
            </div>
          ))}
          {!saidShown && (said.pending || saidNote) ? (
            <div className="palette-group" role="presentation">
              <div className="palette-group-head" role="presentation">Said in sessions</div>
              <div className={`palette-note${said.error ? ' error-text' : ''}`} role="presentation">
                {said.pending ? 'Searching what agents said…' : saidNote}
              </div>
            </div>
          ) : null}
          {!count && !said.pending ? <div className="palette-empty" role="presentation">Nothing matches “{q}”.</div> : null}
        </div>
        <div className="palette-foot" aria-hidden="true">
          <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
          <span><kbd>{keyLabel('Enter', mac)}</kbd> open</span>
          <span><kbd>esc</kbd> close</span>
          {q.length && q.length < SAID_MIN_QUERY ? <span className="palette-foot-end">Type {SAID_MIN_QUERY} letters to search what agents said</span> : null}
        </div>
        <div className="visually-hidden" aria-live="polite">{announce}</div>
      </div>
    </div>,
    document.body,
  );
}

function Keys({ id, mac }: { id: CommandId; mac: boolean }): ReactNode {
  const s = shortcutFor(id);
  return s ? <KeyCaps shortcut={s} mac={mac} /> : null;
}

/** One match from a session: the words around it, then where and when. */
function SaidRow({ hit }: { hit: SaidHit }) {
  const live = LIVE_STATES.has(hit.state);
  return (
    <span className="palette-stack">
      <span className={`palette-label ${hit.in === 'output' ? 'palette-snippet' : 'palette-said-title'}`}>
        {hit.snippet.before}<mark>{hit.snippet.match}</mark>{hit.snippet.after}
      </span>
      <span className="palette-detail">
        {hit.projectKey} · {hit.in === 'title' ? 'session title' : hit.sessionTitle} · {live ? 'live' : hit.endedAt ? `ended ${ago(hit.endedAt)}` : STATE_LABEL[hit.state].toLowerCase()}
      </span>
    </span>
  );
}

/** When a match was said, as far as is known: terminal output carries no times. */
function saidWhen(hit: SaidHit): string {
  const at = (t: number): string => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  if (hit.in === 'title') return `The title of a session in ${hit.projectName}.`;
  const when = hit.lastOutputAt ? `between ${at(hit.startedAt)} and ${at(hit.lastOutputAt)}` : `after ${at(hit.startedAt)}`;
  return `Said in “${hit.sessionTitle}” (${hit.projectName}) ${when}. Terminal output is recorded without times.`;
}
