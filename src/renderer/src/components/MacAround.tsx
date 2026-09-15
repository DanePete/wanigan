import { useCallback, useEffect, useState } from 'react';
import type { MacSettings } from '@shared/mac-presence';
import type { AutomationLedgerRow, AutomationStatus } from '@shared/automation-protocol';
import type { McpToolGrant, McpToolInfo } from '@shared/mcp-tool-grants';
import type { Project, ProviderInfo } from '@shared/types';
import { previewNames, templateProblems, type NamingTemplates } from '@shared/naming-templates';
import { Mark, Note, Section, Segmented, ago } from './bits';
import { useAnnounce } from './announce';
import { appendToComposerDraft } from './Composer';
import '../styles/mac-around.css';

/**
 * Settings for the Mac around the app (helper sweep · P8): the Dock badge, the
 * menu-bar session list, and the local automation socket.
 *
 * A file of its own rather than more of Settings.tsx, which several packages
 * change at once. Every switch here reads and writes through `mac:*`, which
 * main validates, and each one says what turning it on does before anyone
 * turns it on.
 */

function msg(e: unknown): string {
  return e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e);
}

export function P8Switch({ on, title, busy, onChange, children }: {
  on: boolean; title: string; busy?: boolean; onChange: (next: boolean) => void; children: React.ReactNode;
}) {
  return (
    <div className="set-row">
      <div className="txt">
        <h4>{title}</h4>
        <p>{children}</p>
      </div>
      <button type="button" role="switch" aria-checked={on} aria-label={title}
              className="set-switch" disabled={busy} onClick={() => onChange(!on)}>
        <span className="set-state p8-switch-state" data-on={on}>
          <span aria-hidden="true">{on ? '✓' : '○'}</span> {on ? 'On' : 'Off'}
        </span>
        <span className="set-track"><span className="set-knob" /></span>
      </button>
    </div>
  );
}

/** One read of the four switches, shared by the sections that show them. */
export function useMacSettings(): {
  settings: MacSettings | null; error: string | null; busy: keyof MacSettings | null;
  set: (key: keyof MacSettings, value: boolean) => void;
} {
  const [settings, setSettings] = useState<MacSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<keyof MacSettings | null>(null);
  useEffect(() => {
    let live = true;
    window.wanigan.mac.settings().then((s) => { if (live) setSettings(s); }, (e) => { if (live) setError(msg(e)); });
    return () => { live = false; };
  }, []);
  const set = (key: keyof MacSettings, value: boolean) => {
    setBusy(key);
    setError(null);
    window.wanigan.mac.setSetting(key, value)
      .then(setSettings, (e) => setError(msg(e)))
      .finally(() => setBusy(null));
  };
  return { settings, error, busy, set };
}

export function DockAndMenuBarSettings() {
  const { settings, error, busy, set } = useMacSettings();
  return (
    <Section title="Dock and menu bar"
             hint="Whether anything needs you, readable without the window in front. Both are off until you turn them on.">
      {error && <Note tone="error">{error}</Note>}
      {settings && (
        <div className="p8-switches">
          <P8Switch title="Count on the Dock icon" on={settings.dockBadge} busy={busy === 'dockBadge'}
                    onChange={(v) => set('dockBadge', v)}>
            A number on Wanigan’s Dock icon: sessions asking for permission or stopped on an error, plus sessions whose
            finished work is waiting on review. A snoozed session is not counted. It is a count only — no colour, no names —
            and it disappears when nothing needs you.
          </P8Switch>
          <P8Switch title="Sessions in the menu bar" on={settings.menuBarSessions} busy={busy === 'menuBarSessions'}
                    onChange={(v) => set('menuBarSessions', v)}>
            A menu-bar item listing each live session by its state word, how long it has been in that state, and its
            project. Choosing one brings Wanigan forward on that session; “Halt all agents…” opens the header’s own
            two-step confirmation rather than stopping anything itself. The glyph is a hollow ring while nothing needs you.
            The menu never shows what a session was asked, its title, or a path, because it opens over whatever else is
            on your screen.
          </P8Switch>
        </div>
      )}
    </Section>
  );
}

/* ── the automation socket ───────────────────────────────────────────── */

const OUTCOME_MARK: Record<string, { glyph: string; tone: 'ok' | 'warn' | 'bad' | 'quiet' }> = {
  answered: { glyph: '✓', tone: 'ok' }, drafted: { glyph: '✎', tone: 'ok' }, 'drafted-held': { glyph: '✎', tone: 'quiet' },
  sent: { glyph: '↵', tone: 'warn' }, 'sent-from-queue': { glyph: '↵', tone: 'warn' }, queued: { glyph: '◷', tone: 'quiet' },
  started: { glyph: '▶', tone: 'warn' }, asked: { glyph: '?', tone: 'quiet' }, declined: { glyph: '✕', tone: 'quiet' },
  refused: { glyph: '✕', tone: 'bad' }, 'queue-dropped': { glyph: '✕', tone: 'quiet' }, 'queue-expired': { glyph: '✕', tone: 'quiet' },
  'write-failed': { glyph: '!', tone: 'bad' }, 'launch-failed': { glyph: '!', tone: 'bad' },
};

export function AutomationSocketSettings() {
  const { settings, error, busy, set } = useMacSettings();
  const [status, setStatus] = useState<AutomationStatus | null>(null);
  const [ledger, setLedger] = useState<AutomationLedgerRow[]>([]);
  const [readError, setReadError] = useState<string | null>(null);
  const reload = useCallback(() => {
    Promise.all([window.wanigan.automation.status(), window.wanigan.automation.ledger(20)])
      .then(([s, rows]) => { setStatus(s); setLedger(rows); setReadError(null); }, (e) => setReadError(msg(e)));
  }, []);
  useEffect(() => { reload(); }, [reload, settings?.automationSocket, settings?.automationSend]);

  return (
    <Section title="Automation socket"
             hint="A local door for your own scripts: list sessions, draft into a composer, and — only if you allow it — send. Off by default.">
      {(error || readError) && <Note tone="error">{error ?? readError}</Note>}
      {settings && (
        <div className="p8-switches">
          <P8Switch title="Local automation socket" on={settings.automationSocket} busy={busy === 'automationSocket'}
                    onChange={(v) => set('automationSocket', v)}>
            Opens a Unix domain socket in Wanigan’s own data folder, in a directory only your user can enter, with a fresh
            token beside it each time it starts. A script that reads the token can list sessions, read one session’s state,
            and put text into a session’s composer as a draft you still send yourself. Asking for a new session raises an
            approval dialog here, refused after five minutes. Every call is written to the ledger below with the process
            that made it.
          </P8Switch>
          <P8Switch title="Allow scripts to send" on={settings.automationSend} busy={busy === 'automationSend' || !settings.automationSocket}
                    onChange={(v) => set('automationSend', v)}>
            Lets a script’s <span className="mono">send</span> type into a session’s prompt. Even then the text reaches the
            agent only while it is idle or has finished its turn — the same rule the composer uses — and never answers a
            permission prompt; otherwise the send waits in a queue for up to an hour. With this off, a send is refused and
            the script is told to draft instead.
          </P8Switch>
        </div>
      )}
      {status && (
        <div className="p8-socket-state">
          <div className="p8-socket-line">
            {status.listening
              ? <Mark glyph="✓" word="listening" tone="ok" />
              : status.enabled
                ? <Mark glyph="!" word="not listening" tone="bad" />
                : <Mark glyph="○" word="off" tone="quiet" />}
            <code className="mono p8-path">{status.socketPath}</code>
          </div>
          {status.error && <Note tone="error">{status.error}</Note>}
          <p className="p8-fine">
            Token: <code className="mono p8-path">{status.tokenPath}</code> — never shown in this window. The reference
            client is <code className="mono">npm run cli -- socket list</code>; see <code className="mono">socket help</code>.
            {status.queued > 0 ? ` ${status.queued} send${status.queued === 1 ? '' : 's'} waiting for an agent to reach its prompt.` : ''}
          </p>
        </div>
      )}
      <div className="set-sub">Ledger</div>
      {ledger.length === 0 ? (
        <p className="p8-fine">No calls recorded. Every call the socket receives — answered, refused or queued — appears here.</p>
      ) : (
        <div className="p8-scroll">
          <table className="grid p8-ledger">
            <thead><tr><th>When</th><th>Verb</th><th>Outcome</th><th>Peer</th><th>Detail</th></tr></thead>
            <tbody>
              {ledger.map((row) => {
                const mark = OUTCOME_MARK[row.outcome] ?? { glyph: '·', tone: 'quiet' as const };
                return (
                  <tr key={row.id}>
                    <td className="p8-when">{ago(row.at)}</td>
                    <td className="mono">{row.verb}</td>
                    <td><Mark glyph={mark.glyph} word={row.outcome} tone={mark.tone} /></td>
                    <td className="mono p8-path">{row.peerPid ? `${row.peerCommand} · pid ${row.peerPid}` : 'unknown peer'}</td>
                    <td className="p8-fine">{row.detail ?? ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

/* ── naming templates, per project ───────────────────────────────────── */

const SAMPLE_PROMPT = 'JIRA-123 Fix the checkout total rounding on refunds';

export function NamingTemplateSettings({ projects }: { projects: Project[] }) {
  const [projectId, setProjectId] = useState<string>(projects[0]?.id ?? '');
  const [title, setTitle] = useState('');
  const [branch, setBranch] = useState('');
  const [sample, setSample] = useState(SAMPLE_PROMPT);
  const [saved, setSaved] = useState<NamingTemplates | null>(null);
  const [note, setNote] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const project = projects.find((p) => p.id === projectId) ?? null;

  useEffect(() => {
    if (!projectId) return;
    let live = true;
    window.wanigan.naming.get(projectId).then((t) => {
      if (!live) return;
      setSaved(t); setTitle(t.title ?? ''); setBranch(t.branch ?? ''); setNote(null);
    }, (e) => { if (live) setNote({ tone: 'error', text: msg(e) }); });
    return () => { live = false; };
  }, [projectId]);

  const draft: NamingTemplates = { title: title.trim() || null, branch: branch.trim() || null };
  const problems = templateProblems(draft);
  const preview = project ? previewNames(draft, {
    prompt: sample, projectName: project.name, projectBranch: project.branch, sessionId: 's_preview_a1b2c3', now: Date.now(),
  }) : null;
  const dirty = !saved || saved.title !== draft.title || saved.branch !== draft.branch;

  if (!projects.length) {
    return (
      <Section title="Session names and branches" hint="A title format and a worktree branch format, per project.">
        <p className="p8-fine">Add a project first.</p>
      </Section>
    );
  }
  return (
    <Section title="Session names and branches"
             hint="A format for the title Wanigan derives from a launch prompt and for the branch an isolated worktree is cut on. Stored in Wanigan, never in the repository; no model is asked anything.">
      <div className="p8-naming">
        <label className="p8-field">
          <span className="label">Project</span>
          <select className="field" aria-label="Project to name sessions for" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label className="p8-field">
          <span className="label">Title format</span>
          <input className="field mono" aria-label="Session title format" value={title} placeholder="{summary}  (the default)"
                 spellCheck={false} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="p8-field">
          <span className="label">Branch format</span>
          <input className="field mono" aria-label="Worktree branch format" value={branch} placeholder="wanigan/{project}-{short}  (the default)"
                 spellCheck={false} onChange={(e) => setBranch(e.target.value)} />
        </label>
        <p className="p8-fine">
          Tokens: <code className="mono">{'{summary}'}</code> the prompt’s first line, <code className="mono">{'{ticket}'}</code> the first
          key like ABC-123 in the prompt or the checkout’s branch, <code className="mono">{'{project}'}</code>, <code className="mono">{'{date}'}</code>, and
          in a branch <code className="mono">{'{short}'}</code>, the session’s id fragment — added at the end when a branch format leaves it out, so two
          sessions never share a branch.
        </p>
        <label className="p8-field">
          <span className="label">Preview with this prompt</span>
          <input className="field" aria-label="Sample launch prompt for the preview" value={sample} onChange={(e) => setSample(e.target.value)} />
        </label>
        {preview && (
          <dl className="p8-preview" aria-live="polite">
            <dt>Title</dt><dd>{preview.title ?? <span className="p8-fine">no title — the prompt is empty</span>}</dd>
            <dt>Branch</dt>
            <dd>
              <code className="mono">{preview.branch}</code>{' '}
              {preview.branchProblem ? <Mark glyph="✕" word={preview.branchProblem} tone="bad" /> : <Mark glyph="✓" word="valid git ref" tone="ok" />}
            </dd>
            <dt>Ticket</dt><dd>{preview.ticket ?? <span className="p8-fine">none found — {'{ticket}'} renders empty and its separator is dropped</span>}</dd>
          </dl>
        )}
        {problems.map((p) => <Note key={p.field + p.message} tone="error">{p.field === 'title' ? 'Title' : 'Branch'}: {p.message}</Note>)}
        {note && <Note tone={note.tone}>{note.text}</Note>}
        <div className="p8-dialog-foot">
          <button type="button" className="btn btn-primary" disabled={!dirty || problems.length > 0 || !project}
                  onClick={() => {
                    window.wanigan.naming.set(projectId, draft).then((t) => {
                      setSaved(t);
                      setNote({ tone: 'ok', text: `Saved for ${project?.name}. New sessions and worktrees use it; running ones keep their names.` });
                    }, (e) => setNote({ tone: 'error', text: msg(e) }));
                  }}>
            Save formats
          </button>
        </div>
      </div>
    </Section>
  );
}

/* ── Wanigan's own MCP tools, per provider profile ───────────────────── */

export function McpToolGrantsSettings({ providers }: { providers: ProviderInfo[] }) {
  const [catalogue, setCatalogue] = useState<McpToolInfo[]>([]);
  const [grants, setGrants] = useState<Record<string, McpToolGrant>>({});
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const ids = providers.map((p) => p.id).join('|');
  useEffect(() => {
    let live = true;
    window.wanigan.mcpTools.state(ids ? ids.split('|') : [])
      .then((s) => { if (live) { setCatalogue(s.catalogue); setGrants(s.grants); } }, (e) => { if (live) setError(msg(e)); });
    return () => { live = false; };
  }, [ids]);
  const save = (profileId: string, grant: McpToolGrant) => {
    setError(null);
    window.wanigan.mcpTools.set(profileId, grant)
      .then((g) => setGrants((prev) => ({ ...prev, [profileId]: g })), (e) => setError(msg(e)));
  };

  return (
    <Section title="Wanigan tools per provider"
             hint="Which of Wanigan’s own MCP tools each provider profile’s sessions receive. Applies to sessions launched after a change; the server also refuses any tool a running session’s profile is no longer granted.">
      {error && <Note tone="error">{error}</Note>}
      <div className="p8-grants">
        {providers.map((p) => {
          const grant = grants[p.id];
          if (!grant) return null;
          const count = grant.mode === 'all' ? catalogue.length : grant.mode === 'none' ? 0 : grant.tools.length;
          return (
            <div key={p.id} className="p8-grant">
              <div className="p8-grant-head">
                <strong>{p.label}</strong>
                <span className="mono p8-fine">{p.id}</span>
                {!p.capabilities.mcp && <Mark glyph="○" word="MCP not detected in this CLI" tone="quiet" />}
                <span className="p8-fine">{count} of {catalogue.length} tools</span>
              </div>
              <Segmented label={`Wanigan tools for ${p.label}`} value={grant.mode}
                options={[{ value: 'all', label: 'All tools' }, { value: 'none', label: 'None' }, { value: 'some', label: 'Selected' }]}
                onChange={(mode) => {
                  if (mode === 'some') { setOpen(p.id); save(p.id, { mode: 'some', tools: grant.mode === 'all' ? catalogue.map((t) => t.name) : grant.tools }); }
                  else save(p.id, { mode, tools: [] });
                }} />
              {grant.mode === 'none' && <p className="p8-fine">Sessions from this profile get no Wanigan server in their MCP config at all.</p>}
              {grant.mode === 'some' && (
                <details className="p8-grant-tools" open={open === p.id}>
                  <summary>Choose tools</summary>
                  <ul>
                    {catalogue.map((t) => {
                      const checked = grant.tools.includes(t.name);
                      return (
                        <li key={t.name}>
                          <label className="p8-check">
                            <input type="checkbox" checked={checked}
                                   onChange={() => save(p.id, { mode: 'some', tools: checked ? grant.tools.filter((x) => x !== t.name) : [...grant.tools, t.name] })} />
                            <span className="mono">{t.name}</span>
                            <span className="p8-fine">{t.title}{t.readOnly ? ' · read-only' : ''}</span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </details>
              )}
            </div>
          );
        })}
      </div>
    </Section>
  );
}

/**
 * Where a script's draft lands: the session's composer, unsent, with a line in
 * the polite region that says where it came from. Rendered once by App.
 */
export function AutomationDraftLanding({ openSession }: { openSession: (id: string) => void }) {
  const { announce } = useAnnounce();
  useEffect(() => {
    const land = (sessionId: string, text: string) => {
      appendToComposerDraft(sessionId, text, 'A script put this in the draft through the automation socket. Nothing is sent until you press Send.');
      announce({ tone: 'info', text: 'A script drafted a message into a session’s composer. It is unsent.', action: { label: 'Open', run: () => openSession(sessionId) } });
    };
    const off = window.wanigan.automation.onDraft(({ sessionId, text }) => land(sessionId, text));
    window.wanigan.automation.takeDrafts()
      .then((held) => { for (const d of held) land(d.sessionId, d.text); })
      .catch(() => {});
    return () => { off(); };
  }, [announce, openSession]);
  return null;
}
