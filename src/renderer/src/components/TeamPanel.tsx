import { useCallback, useEffect, useState } from 'react';
import { ago, num } from './bits';

type Member = { name: string; agentId: string | null; agentType: string | null; isLead: boolean };
type Task = { id: string; title: string; status: string; assignee: string | null; dependsOn: string[]; blocked: boolean; updatedAt: number | null };
type Msg = { to: string; from: string | null; at: number | null; kind: string; preview: string };
type Team = {
  name: string; configPath: string; members: Member[]; tasks: Task[]; pending: Msg[];
  counts: { pending: number; inProgress: number; completed: number; blocked: number };
  updatedAt: number | null;
};

/**
 * Agent teams, seen from outside.
 *
 * Inside a terminal you see one agent's view. The shared task list and the
 * mailboxes are the only place the team exists as a team, and they are plain
 * files — so this needs no protocol and no cooperation from the CLI.
 */
export default function TeamPanel() {
  const [state, setState] = useState<{ teams: Team[]; enabled: boolean; note: string | null } | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try { setState(await window.foreman.teams.read()); } catch { /* absent is the normal case */ }
  }, []);
  useEffect(() => { void load(); const t = setInterval(load, 6000); return () => clearInterval(t); }, [load]);

  // Nothing running and teams switched off: stay out of the way entirely.
  if (!state || (state.teams.length === 0 && !state.enabled)) return null;

  const total = state.teams.reduce((a, t) => a + t.tasks.length, 0);
  const blocked = state.teams.reduce((a, t) => a + t.counts.blocked, 0);
  const waiting = state.teams.reduce((a, t) => a + t.pending.length, 0);

  return (
    <div className="card" style={{ padding: 13, marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <h3 style={{ fontSize: 13, fontWeight: 600 }}>
          {state.teams.length === 1 ? 'Agent team' : `Agent teams (${state.teams.length})`}
        </h3>
        <span className="faint" style={{ fontSize: 11.5, fontVariantNumeric: 'tabular-nums' }}>
          {num(total)} task{total === 1 ? '' : 's'}
          {blocked > 0 && <> · <span style={{ color: 'var(--warning)' }}>{blocked} blocked</span></>}
          {waiting > 0 && <> · {waiting} message{waiting === 1 ? '' : 's'} waiting</>}
        </span>
        {state.teams.length > 0 && (
          <button className="btn" style={{ marginLeft: 'auto', fontSize: 11.5, padding: '3px 9px' }}
                  aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            {open ? 'Hide' : 'Show tasks'}
          </button>
        )}
      </div>

      {state.note && (
        <p className="dim" style={{ fontSize: 12, marginTop: 6, lineHeight: 1.5, maxWidth: '76ch' }}>{state.note}</p>
      )}

      {open && state.teams.map((t) => (
        <div key={t.name} style={{ marginTop: 12, borderTop: '1px solid var(--line)', paddingTop: 10 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'baseline' }}>
            <span className="mono" style={{ fontSize: 12 }}>{t.name}</span>
            {t.members.map((m) => (
              <span key={m.name} className="pill"
                    style={m.isLead
                      ? { background: 'var(--accent-soft)', color: 'var(--accent)' }
                      : { background: 'var(--bg-sunk)', color: 'var(--text-dim)' }}>
                {m.isLead ? '◆ ' : '◇ '}{m.name}{m.agentType && !m.isLead ? ` · ${m.agentType}` : ''}
              </span>
            ))}
            {t.updatedAt && <span className="faint" style={{ fontSize: 11 }}>updated {ago(t.updatedAt)}</span>}
          </div>

          {t.tasks.length === 0 ? (
            <p className="faint" style={{ fontSize: 12, marginTop: 8 }}>
              No shared tasks. Teammates without the Task tools coordinate by message instead.
            </p>
          ) : (
            <table className="viz-table" style={{ marginTop: 8 }}>
              <thead>
                <tr><th>Task</th><th>Status</th><th>Claimed by</th></tr>
              </thead>
              <tbody>
                {t.tasks.slice(0, 24).map((task) => (
                  <tr key={task.id}>
                    <td style={{ maxWidth: 420 }}>
                      {task.title}
                      {/* The single most useful thing here: a pending task whose
                          dependency has not completed cannot be claimed, and a
                          stalled team usually has exactly one. */}
                      {task.blocked && (
                        <span style={{ color: 'var(--warning)', marginLeft: 7, fontSize: 11 }}>
                          <span aria-hidden="true">⚠ </span>blocked by {task.dependsOn.length} unfinished
                        </span>
                      )}
                    </td>
                    <td style={{ whiteSpace: 'nowrap',
                                 color: task.status.startsWith('complet') ? 'var(--good)'
                                   : task.status.includes('progress') ? 'var(--accent)' : 'var(--text-dim)' }}>
                      <span aria-hidden="true" style={{ marginRight: 5 }}>
                        {task.status.startsWith('complet') ? '✓' : task.status.includes('progress') ? '▶' : '○'}
                      </span>
                      {task.status}
                    </td>
                    <td className="mono" style={{ fontSize: 11 }}>{task.assignee ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {t.pending.length > 0 && (
            <>
              <div className="label" style={{ marginTop: 10 }}>Messages waiting in inboxes</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 4 }}>
                {t.pending.slice(0, 8).map((m, i) => (
                  <div key={i} style={{ fontSize: 12, color: 'var(--text-dim)', display: 'flex', gap: 8 }}>
                    <span className="mono" style={{ fontSize: 11, flex: 'none', color: 'var(--accent)' }}>
                      {m.from ?? '?'} → {m.to}
                    </span>
                    <span className="trunc" style={{ maxWidth: 520 }}>{m.preview}</span>
                    {m.at && <span className="faint" style={{ fontSize: 10.5, marginLeft: 'auto' }}>{ago(m.at)}</span>}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
