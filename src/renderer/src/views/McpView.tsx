// MCP servers: what each account has, and a small store of well-known ones.
// Everything here is read from the agents' own files. A change runs the agent's
// own CLI only when you click, after you have seen the exact command.
import { Select } from '../components/Select';
import { useEffect, useMemo, useState } from 'react';
import type { Account, ProjectSummary } from '@shared/model';
import type { McpAgent, McpCatalogEntry, McpCheck, McpCheckResult, McpGroup, McpPlan, McpServer } from '@shared/mcp';
import { attempt, call, useQuery } from '../lib/api';
import { ago, plural } from '../lib/format';
import { navigate } from '../lib/router';
import { Button, Dialog, Empty, Segmented, useToast } from '../components/ui';
import '../styles/library.css';

const AGENT: Record<McpAgent, string> = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI' };
/** Gemini CLI has one sign-in, so it is picked as itself rather than as an account. */
const GEMINI = 'gemini';
const AUTH: Record<McpCatalogEntry['auth'], string> = { none: 'No sign-in', oauth: 'Signs in with your browser', key: 'Needs a key you provide' };
type Tab = 'installed' | 'store';
type Filter = 'all' | McpAgent;

export function McpView({ projects }: { projects: ProjectSummary[] | undefined }) {
  const listing = useQuery('mcp.list', {}, ['mcp', 'projects', 'accounts']);
  const catalog = useQuery('mcp.catalog', {}, []);
  const accounts = useQuery('accounts.list', {}, ['accounts']);
  const [tab, setTab] = useState<Tab>('installed');
  const [filter, setFilter] = useState<Filter>('all');
  const [adding, setAdding] = useState<McpCatalogEntry | null>(null);
  const total = listing.data?.groups.reduce((n, g) => n + g.servers.length, 0) ?? 0;

  return (
    <section className="view" aria-labelledby="mcp-title">
      <header className="topbar">
        <div className="topbar-title">
          <h1 id="mcp-title">MCP servers</h1>
          {listing.data ? <span className="faint small">{plural(total, 'server')} found</span> : null}
        </div>
        <div className="topbar-tools">
          {tab === 'installed' ? (
            <Segmented size="s" label="Agent" value={filter} onChange={setFilter}
              options={[{ value: 'all', label: 'All' }, { value: 'claude', label: 'Claude Code' }, { value: 'codex', label: 'Codex' }, { value: 'gemini', label: 'Gemini CLI' }]} />
          ) : null}
          <Segmented size="s" label="Show" value={tab} onChange={setTab}
            options={[{ value: 'installed', label: 'Installed' }, { value: 'store', label: 'Store' }]} />
        </div>
      </header>
      <div className="view-body">
        <div className="view-pad mcp">
          {listing.error ? <p className="error-text">{listing.error.message}</p> : null}
          {tab === 'installed' ? (
            <Installed groups={(listing.data?.groups ?? []).filter((g) => filter === 'all' || g.agent === filter)}
              checks={listing.data?.checks ?? []} projects={projects ?? []} loaded={!!listing.data}
              empty={(listing.data?.empty ?? []).filter((e) => filter === 'all' || e.agent === filter)} notes={listing.data?.notes ?? []}
              onStore={() => setTab('store')} />
          ) : (
            <Store catalog={catalog.data ?? []} groups={listing.data?.groups ?? []} accounts={accounts.data ?? []} projects={projects ?? []} onAdd={setAdding} />
          )}
        </div>
      </div>
      {adding ? (
        <AddDialog entry={adding} accounts={accounts.data ?? []} projects={projects ?? []} onClose={() => setAdding(null)} />
      ) : null}
    </section>
  );
}

/* ── installed ─────────────────────────────────────────────────────────── */

function Installed({ groups, checks, projects, loaded, empty, notes, onStore }: {
  groups: McpGroup[]; checks: McpCheck[]; projects: ProjectSummary[]; loaded: boolean;
  empty: { agent: McpAgent; where: string }[]; notes: string[]; onStore: () => void;
}) {
  if (loaded && !groups.length) {
    return (
      <Empty title="No MCP servers here" action={<Button tone="primary" onClick={onStore}>Browse the store</Button>}>
        Servers you add to Claude Code, Codex or Gemini CLI, by hand or from the store, appear here.
      </Empty>
    );
  }
  return (
    <>
      <p className="lede">
        Read from each agent’s own settings. Values that look like keys or tokens are hidden. Changes go through the agent’s own command, only when you click.
      </p>
      {groups.map((g) => {
        const check = g.check ? checks.find((c) => c.accountId === g.check?.accountId && c.projectId === g.check?.projectId) ?? null : null;
        return <GroupSection key={g.id} group={g} check={check} project={projects.find((p) => p.id === g.projectId)} />;
      })}
      <div className="lib-foot mcp-foot">
        {empty.length ? <p><span className="faint">No servers in:</span> {empty.map((e, i) => <span key={e.where} className="mono">{i ? ', ' : ''}{e.where}</span>)}</p> : null}
        {notes.map((n) => <p key={n} className="faint">{n}</p>)}
      </div>
    </>
  );
}

function GroupSection({ group, check, project }: { group: McpGroup; check: McpCheck | null; project: ProjectSummary | undefined }) {
  const toast = useToast();
  const [checking, setChecking] = useState(false);
  const [removing, setRemoving] = useState<McpServer | null>(null);
  const extra = check ? check.results.filter((r) => !group.servers.some((s) => s.name === r.name)) : [];

  const runCheck = async (): Promise<void> => {
    if (!group.check) return;
    setChecking(true);
    await attempt(() => call('mcp.check', { accountId: group.check!.accountId, projectId: group.check!.projectId }), (m) => toast(m, 'error'));
    setChecking(false);
  };

  return (
    <section className="mcp-group" aria-labelledby={`mcp-${group.id}`}>
      <header className="mcp-group-head">
        <div className="mcp-group-text">
          <h2 id={`mcp-${group.id}`}>
            {project ? <span className="pmark pmark-s" aria-hidden="true">{project.key}</span> : null}
            {group.title}{group.account ? <span className="faint"> · {group.account}</span> : null}
            {group.projectId ? <span className="lib-agent-inline">{AGENT[group.agent]}</span> : null}
          </h2>
          <p className="lib-where mono">{group.where}</p>
        </div>
        {group.check ? (
          <div className="mcp-check">
            <span className="faint small">{checking ? 'Asking Claude Code…' : check ? `Checked ${ago(check.at)}` : ''}</span>
            <Button size="s" tone="quiet" icon="refresh" disabled={checking} onClick={() => runCheck()}
              title="Runs claude mcp list as this account. It starts each server to see whether it answers.">Check connections</Button>
          </div>
        ) : null}
      </header>
      {group.note ? <p className="mcp-note">{group.note}</p> : null}
      {check?.error ? <p className="error-text small">{check.error}</p> : null}
      <ul className="mcp-list">
        {group.servers.map((s) => (
          <ServerRow key={s.id} server={s} result={check?.results.find((r) => r.name === s.name) ?? null} project={project}
            onRemove={() => setRemoving(s)} />
        ))}
      </ul>
      {extra.length ? (
        <div className="mcp-extra">
          <p className="faint small">Claude Code also reported these, from outside the files above (claude.ai, plugins, policy):</p>
          <ul>{extra.map((r) => <li key={r.name}><StatusDot result={r} /><span>{r.name}</span><span className="faint">{r.status}</span></li>)}</ul>
        </div>
      ) : null}
      {removing ? <RemoveDialog server={removing} onClose={() => setRemoving(null)} /> : null}
    </section>
  );
}

function ServerRow({ server: s, result, project, onRemove }: { server: McpServer; result: McpCheckResult | null; project: ProjectSummary | undefined; onRemove: () => void }) {
  const scope = s.scope === 'local' ? `local · ${project?.key ?? s.folder ?? ''}` : s.scope;
  const pairs = [...s.env.map((e) => `${e.key}=${e.value}`), ...s.headers.map((h) => `${h.key}: ${h.value}`)];
  return (
    <li className={`mcp-row${s.enabled ? '' : ' off'}`}>
      <StatusDot result={result} />
      <div className="mcp-main">
        <p className="mcp-name">
          <span>{s.name}</span>
          <span className="lib-tag">{s.transport === 'unknown' ? '?' : s.transport}</span>
          <span className="lib-tag" title={scopeHint(s)}>{scope}</span>
          {!s.enabled ? <span className="lib-tag">off</span> : null}
          {s.notInWanigan ? <span className="lib-tag">not in Wanigan’s sessions</span> : null}
        </p>
        <p className="mcp-target mono" title={s.target}>{s.target}</p>
        {pairs.length ? <p className="mcp-pairs mono">{pairs.join('   ')}</p> : null}
        {result ? <p className={`mcp-status tone-${result.tone}`}>{result.status}{result.issue ? <span className="faint"> — {result.issue}</span> : null}</p> : null}
        {s.note ? <p className="faint small">{s.note}</p> : null}
        {s.notInWanigan ? <p className="mcp-elsewhere small">{s.notInWanigan}</p> : null}
        {s.scope === 'local' && s.folder && !project ? <p className="faint small">For <span className="mono">{s.folder}</span></p> : null}
      </div>
      <div className="mcp-actions">
        {s.removable ? <Button size="s" tone="quiet" onClick={onRemove}>Remove…</Button> : null}
      </div>
    </li>
  );
}

function StatusDot({ result }: { result: McpCheckResult | null }) {
  const tone = result?.tone ?? 'none';
  return <span className={`mcp-dot dot-${tone}`} role="img" aria-label={result ? result.status : 'Not checked'} title={result ? result.status : 'Not checked'} />;
}

function scopeHint(s: McpServer): string {
  if (s.agent === 'gemini') {
    return s.scope === 'user'
      ? 'User scope: in ~/.gemini/settings.json, for every folder Gemini trusts. Wanigan’s Gemini sessions get a copy as they start.'
      : 'In the project’s .gemini/settings.json. Gemini loads it once it trusts the folder.';
  }
  if (s.scope === 'user') return 'User scope: every project, for this account.';
  if (s.scope === 'local') return 'Local scope: only this folder, for this account.';
  if (s.scope === 'project') return s.agent === 'claude' ? 'Project scope: in the repository’s .mcp.json, for everyone who opens it.' : 'In the project’s .codex/config.toml.';
  return 'Comes with a plugin.';
}

function RemoveDialog({ server, onClose }: { server: McpServer; onClose: () => void }) {
  const toast = useToast();
  const [plan, setPlan] = useState<McpPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void call('mcp.remove', { id: server.id, preview: true }).then((r) => setPlan(r.plan), (e: Error) => setError(e.message));
  }, [server.id]);
  const remove = async (): Promise<void> => {
    setBusy(true);
    const r = await attempt(() => call('mcp.remove', { id: server.id }), setError);
    setBusy(false);
    if (r?.done) { toast(`Removed ${server.name}.`); onClose(); }
  };
  return (
    <Dialog title={`Remove ${server.name}?`} onClose={onClose} width={600}
      footer={<><Button tone="quiet" onClick={onClose}>Cancel</Button><Button tone="danger" disabled={!plan || busy} onClick={() => remove()}>{busy ? 'Removing…' : 'Remove'}</Button></>}>
      {plan ? (
        <div className="plan">
          <p>{plan.effect}</p>
          <p className="faint small">Wanigan runs:</p>
          <pre className="plan-command">{plan.command}</pre>
        </div>
      ) : null}
      {error ? <p className="error-text" role="alert">{error}</p> : null}
    </Dialog>
  );
}

/* ── the store ─────────────────────────────────────────────────────────── */

function Store({ catalog, groups, accounts, projects, onAdd }: {
  catalog: McpCatalogEntry[]; groups: McpGroup[]; accounts: Account[]; projects: ProjectSummary[]; onAdd: (e: McpCatalogEntry) => void;
}) {
  const installed = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const s of groups.flatMap((g) => g.servers)) {
      if (!s.catalogId) continue;
      const who = s.accountId
        ? accounts.find((a) => a.id === s.accountId)?.label ?? 'an account'
        : s.agent === 'gemini' && s.scope === 'user' ? 'every project'
          : projects.find((p) => p.id === s.projectId)?.name ?? 'a project';
      const label = `${AGENT[s.agent]} · ${who}`;
      map.set(s.catalogId, [...new Set([...(map.get(s.catalogId) ?? []), label])]);
    }
    return map;
  }, [groups, accounts, projects]);
  return (
    <>
      <p className="lede">
        Well-known servers, with install commands checked against each publisher’s own documentation. Adding one runs the agent’s own command, as the account you pick.
        Wanigan never asks for or keeps a key.
      </p>
      <ul className="store">
        {catalog.map((e) => (
          <li key={e.id} className="store-card">
            <div className="store-head">
              <p className="store-name">{e.name}</p>
              <p className="faint small">{e.publisher}</p>
            </div>
            <p className="store-purpose">{e.purpose}</p>
            <p className="store-facts">
              <span className="lib-tag">{e.transport === 'http' ? 'remote' : 'runs locally'}</span>
              <span className={`lib-tag${e.auth === 'key' ? ' tag-key' : ''}`}>{AUTH[e.auth]}</span>
              {!e.claude ? <span className="lib-tag">Codex only</span> : !e.codex ? <span className="lib-tag">Claude Code only</span> : null}
            </p>
            {e.needs ? <p className="faint small">Needs {e.needs}.</p> : null}
            {installed.get(e.id) ? <p className="store-added small">Added for {installed.get(e.id)?.join(', ')}</p> : null}
            <div className="store-foot">
              <span className="store-source mono" title={e.source}>{e.source.replace(/^https:\/\//, '')}</span>
              <Button size="s" onClick={() => onAdd(e)}>Add…</Button>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

function AddDialog({ entry, accounts, projects, onClose }: { entry: McpCatalogEntry; accounts: Account[]; projects: ProjectSummary[]; onClose: () => void }) {
  const toast = useToast();
  const usable = accounts.filter((a) => entry[a.provider]);
  // An account's id, or Gemini CLI itself.
  const [accountId, setAccountId] = useState(() => (usable.find((a) => a.isDefault && a.provider === 'claude') ?? usable[0])?.id ?? (entry.gemini ? GEMINI : ''));
  const gemini = accountId === GEMINI;
  const account = usable.find((a) => a.id === accountId);
  const [scope, setScope] = useState<'user' | 'local' | 'project'>('user');
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '');
  const [plan, setPlan] = useState<McpPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const effectiveScope = account?.provider === 'codex' || (gemini && scope === 'local') ? 'user' : scope;
  const params = {
    catalogId: entry.id, ...(gemini ? { agent: 'gemini' as const } : { accountId }),
    scope: effectiveScope, projectId: effectiveScope === 'user' ? null : projectId || null,
  };
  const spec = gemini ? entry.gemini : account ? entry[account.provider] : null;

  useEffect(() => {
    let live = true;
    setPlan(null);
    setError(null);
    if (!accountId || (effectiveScope !== 'user' && !projectId)) return;
    void call('mcp.add', { ...params, preview: true }).then((r) => { if (live) setPlan(r.plan); }, (e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [accountId, effectiveScope, projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  const add = async (): Promise<void> => {
    setBusy(true);
    const r = await attempt(() => call('mcp.add', params), setError);
    setBusy(false);
    if (r?.done) { toast(`Added ${entry.name} to ${AGENT[r.plan.agent]}${account ? ` as ${account.label}` : ''}.`); onClose(); }
  };
  const openTerminal = async (): Promise<void> => {
    setBusy(true);
    const session = await attempt(() => call('mcp.terminal', { ...params, hostProjectId: projectId || null }), setError);
    setBusy(false);
    const project = session ? projects.find((p) => p.id === session.projectId) : undefined;
    if (session && project) { onClose(); navigate({ name: 'session', projectKey: project.key, sessionId: session.id }); }
  };
  const copy = async (): Promise<void> => {
    if (!plan) return;
    try { await navigator.clipboard.writeText(plan.command); toast('Copied the command.'); } catch { toast('Could not copy. Select the command and copy it yourself.', 'error'); }
  };

  return (
    <Dialog title={`Add ${entry.name}`} onClose={onClose} width={640}
      footer={<>
        <Button tone="quiet" onClick={onClose}>Cancel</Button>
        {plan?.mode === 'terminal' ? (
          <>
            <Button onClick={() => copy()} disabled={!plan}>Copy command</Button>
            <Button tone="primary" icon="terminal" onClick={() => openTerminal()} disabled={!plan || plan.exists || busy || !projects.length}>Open in a terminal</Button>
          </>
        ) : (
          <Button tone="primary" onClick={() => add()} disabled={!plan || plan.exists || busy}>{busy ? 'Adding…' : 'Add'}</Button>
        )}
      </>}>
      <p className="faint">{entry.purpose} <span className="mono small">{entry.source}</span></p>
      <div className="field">
        <label htmlFor="mcp-account">Add to</label>
        <Select id="mcp-account" value={accountId} onChange={setAccountId}
          options={[
            ...(['claude', 'codex'] as const).flatMap((agent) => usable.filter((a) => a.provider === agent)
              .map((a) => ({ value: a.id, label: a.label, group: AGENT[agent], ...(a.identity ? { detail: a.identity } : {}) }))),
            ...(entry.gemini ? [{ value: GEMINI, label: 'Gemini CLI', group: AGENT.gemini, detail: 'One sign-in' }] : []),
          ]} />
      </div>
      {account?.provider === 'claude' ? (
        <div className="field">
          <span className="field-label">Where</span>
          <Segmented size="s" label="Where" value={scope} onChange={setScope}
            options={[
              { value: 'user', label: 'Every project', hint: 'User scope, in this account’s settings' },
              { value: 'local', label: 'One project, just you', hint: 'Local scope, in this account’s settings' },
              { value: 'project', label: 'The repository (.mcp.json)', hint: 'Project scope, shared with everyone who clones it' },
            ]} />
        </div>
      ) : gemini ? (
        <div className="field">
          <span className="field-label">Where</span>
          <Segmented size="s" label="Where" value={effectiveScope === 'project' ? 'project' : 'user'} onChange={setScope}
            options={[
              { value: 'user', label: 'Every project', hint: 'User scope, in ~/.gemini/settings.json' },
              { value: 'project', label: 'The repository (.gemini/settings.json)', hint: 'Project scope, shared with everyone who clones it' },
            ]} />
        </div>
      ) : null}
      {effectiveScope !== 'user' ? (
        <div className="field">
          <label htmlFor="mcp-project">Project</label>
          <Select id="mcp-project" value={projectId} onChange={setProjectId} options={projects.map((p) => ({ value: p.id, label: p.name }))} />
        </div>
      ) : null}
      {error ? <p className="error-text" role="alert">{error}</p> : null}
      {plan ? (
        <div className="plan">
          <p>{plan.effect}</p>
          {plan.exists ? <p className="error-text">A server called {entry.server} is already there.</p> : null}
          <p className="faint small">{plan.mode === 'terminal' ? 'The command, typed into a new terminal for you to finish:' : 'Wanigan runs exactly this, with no shell:'}</p>
          <pre className="plan-command">{plan.command}</pre>
          {plan.mode === 'terminal' && plan.why ? (
            <div className="plan-warn" role="note">
              <p>{plan.why}</p>
              {entry.key ? <p className="small">A Wanigan terminal keeps its scrollback, and your shell keeps its history. If you’d rather the key stayed out of both, copy the command into your own terminal.</p> : null}
            </div>
          ) : null}
          {plan.after ? <p className="faint small">{plan.after}</p> : null}
          {spec && !spec.documented ? (
            <p className="faint small">
              {gemini
                ? `Wanigan’s translation for Gemini CLI, run against Gemini CLI 0.46 to see what it writes; not checked against ${entry.publisher}’s own docs.`
                : `${entry.publisher}’s docs give this setup as configuration; the command is Wanigan’s translation of it.`}
            </p>
          ) : null}
          {entry.note ? <p className="faint small">{entry.note}</p> : null}
        </div>
      ) : !error ? <p className="faint">Working out the command…</p> : null}
    </Dialog>
  );
}
