// Settings › MCP servers: what each account has, and a small store of
// well-known ones. Everything here is read from the agents' own files. A change
// runs the agent's own CLI only when you click, after you have seen the exact command.
import { Select } from '../components/Select';
import { useEffect, useMemo, useState } from 'react';
import type { Account, ProjectSummary } from '@shared/model';
import type { McpAgent, McpCatalogEntry, McpCheck, McpCheckResult, McpGroup, McpPlan, McpServer } from '@shared/mcp';
import { attempt, call, useQuery } from '../lib/api';
import { ago, plural } from '../lib/format';
import { navigate } from '../lib/router';
import { useHow } from '../lib/how';
import { Badge, Button, Count, Dialog, EmptyState, NotAnswering, ProjectMark, Segmented, tipProps, useToast } from '../components/ui';
import { HowArrow, HowBox, HowButton, HowDialog, HowLane, HowNote, howNum } from '../components/How';
import { TabPanel, Tabs } from '../components/Tabs';
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
  const how = useHow('mcp');

  return (
    <section className="view" aria-labelledby="mcp-title">
      <header className="topbar">
        <div className="topbar-title">
          <h1 id="mcp-title">MCP servers</h1>
          {listing.data ? <Count n={total} label={`${plural(total, 'server')} found`} /> : null}
        </div>
        <div className="topbar-tools">
          {tab === 'installed' ? (
            <span data-tour="mcp-filter">
              <Segmented size="s" label="Agent" value={filter} onChange={setFilter}
                options={[{ value: 'all', label: 'All' }, { value: 'claude', label: 'Claude Code' }, { value: 'codex', label: 'Codex' }, { value: 'gemini', label: 'Gemini CLI' }]} />
            </span>
          ) : null}
          <span data-tour="mcp-tabs">
            <Tabs id="mcp-show" label="Show" form="pill" size="s" value={tab} onChange={setTab}
              tabs={[{ value: 'installed', label: 'Installed', ...(listing.data ? { count: total } : {}) }, { value: 'store', label: 'Store' }]} />
          </span>
          <HowButton onClick={how.show} />
        </div>
      </header>
      <div className="view-body">
        <TabPanel tabs="mcp-show" value={tab} className="settings-body settings-body-l mcp">
          {listing.error ? <NotAnswering error={listing.error} onRetry={listing.reload} /> : tab === 'installed' ? (
            <Installed groups={(listing.data?.groups ?? []).filter((g) => filter === 'all' || g.agent === filter)}
              checks={listing.data?.checks ?? []} projects={projects ?? []} loaded={!!listing.data}
              empty={(listing.data?.empty ?? []).filter((e) => filter === 'all' || e.agent === filter)} notes={listing.data?.notes ?? []}
              onStore={() => setTab('store')} />
          ) : (
            <Store catalog={catalog.data ?? []} groups={listing.data?.groups ?? []} accounts={accounts.data ?? []} projects={projects ?? []} onAdd={setAdding} />
          )}
        </TabPanel>
      </div>
      {adding ? (
        <AddDialog entry={adding} accounts={accounts.data ?? []} projects={projects ?? []} onClose={() => setAdding(null)} />
      ) : null}
      {how.open ? <McpHow total={listing.data ? total : null} store={catalog.data?.length ?? null} onClose={how.hide} onStore={() => setTab('store')} /> : null}
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
      <EmptyState title="No MCP servers here" icon="plug" action={<Button tone="primary" onClick={onStore}>Browse the store</Button>}>
        Servers you add to Claude Code, Codex or Gemini CLI, by hand or from the store, appear here.
      </EmptyState>
    );
  }
  return (
    <>
      {groups.map((g, i) => {
        const check = g.check ? checks.find((c) => c.accountId === g.check?.accountId && c.projectId === g.check?.projectId) ?? null : null;
        return <GroupSection key={g.id} group={g} check={check} project={projects.find((p) => p.id === g.projectId)} first={i === 0} />;
      })}
      <div className="settings-foot mcp-foot">
        <p>Read from each agent’s own settings. Values that look like keys or tokens are hidden. Changes go through the agent’s own command, only when you click.</p>
        {empty.length ? <p>No servers in: {empty.map((e, i) => <span key={e.where} className="mono">{i ? ', ' : ''}{e.where}</span>)}</p> : null}
        {notes.map((n) => <p key={n}>{n}</p>)}
      </div>
    </>
  );
}

function GroupSection({ group, check, project, first }: { group: McpGroup; check: McpCheck | null; project: ProjectSummary | undefined; first: boolean }) {
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
    <section className="mcp-group" aria-labelledby={`mcp-${group.id}`} data-tour={first ? 'mcp-list' : undefined}>
      <header className="mcp-group-head">
        <div className="mcp-group-text">
          <h2 id={`mcp-${group.id}`}>
            {project ? <ProjectMark projectKey={project.key} size="s" /> : null}
            <span>{group.title}{group.account ? <span className="faint"> · {group.account}</span> : null}</span>
            {group.projectId ? <Badge>{AGENT[group.agent]}</Badge> : null}
          </h2>
          <p className="lib-where mono">{group.where}</p>
        </div>
        {group.check ? (
          <div className="mcp-check" data-tour={first ? 'mcp-check' : undefined}>
            <span className="settings-meta" aria-live="polite">{checking ? 'Asking Claude Code…' : check ? `Checked ${ago(check.at)}` : ''}</span>
            <Button size="s" tone="quiet" icon="refresh" disabled={checking} onClick={() => runCheck()}
              {...tipProps('Runs claude mcp list as this account. It starts each server to see whether it answers.')}>Check connections</Button>
          </div>
        ) : null}
      </header>
      {group.note ? <p className="mcp-note">{group.note}</p> : null}
      {check?.error ? <p className="error-text small" role="alert">{check.error}</p> : null}
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
          <Badge>{s.transport === 'unknown' ? '?' : s.transport}</Badge>
          <span className="mcp-scope" {...tipProps(scopeHint(s))}><Badge>{scope}</Badge></span>
          {!s.enabled ? <Badge>off</Badge> : null}
          {s.notInWanigan ? <Badge>not in Wanigan’s sessions</Badge> : null}
        </p>
        <p className="mcp-target mono" data-tip={s.target}>{s.target}</p>
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
  return <span className={`mcp-dot dot-${tone}`} role="img" aria-label={result ? result.status : 'Not checked'} data-tip={result ? result.status : 'Not checked'} />;
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
      <ul className="store" data-tour="mcp-store">
        {catalog.map((e) => (
          <li key={e.id} className="store-item">
            <div className="store-head">
              <p className="store-name">{e.name}</p>
              <p className="faint small">{e.publisher}</p>
            </div>
            <p className="store-purpose">{e.purpose}</p>
            <p className="store-facts">
              <Badge>{e.transport === 'http' ? 'remote' : 'runs locally'}</Badge>
              <Badge>{AUTH[e.auth]}</Badge>
              {!e.claude ? <Badge>Codex only</Badge> : !e.codex ? <Badge>Claude Code only</Badge> : null}
            </p>
            {e.needs ? <p className="faint small">Needs {e.needs}.</p> : null}
            {installed.get(e.id) ? <p className="store-added small"><Badge tone="green">Added</Badge> for {installed.get(e.id)?.join(', ')}</p> : null}
            <div className="store-foot">
              <span className="store-source mono" data-tip={e.source}>{e.source.replace(/^https:\/\//, '')}</span>
              <Button size="s" onClick={() => onAdd(e)} aria-label={`Add ${e.name}`}>Add…</Button>
            </div>
          </li>
        ))}
      </ul>
      <p className="settings-foot">
        Well-known servers, with install commands checked against each publisher’s own documentation. Adding one runs the agent’s own command, as the account you pick.
        Wanigan never asks for or keeps a key.
      </p>
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

/** How MCP servers work here, as a picture: every sentence is a rule the core's MCP reader and planner enforce. */
function McpHow({ total, store, onClose, onStore }: { total: number | null; store: number | null; onClose: () => void; onStore: () => void }) {
  return (
    <HowDialog place="mcp" title="How MCP servers work" onClose={onClose}
      intro={<><strong>The tools your agents can reach, read from their own settings.</strong> Wanigan changes them only through each agent’s own command, when you click, after you have seen it.</>}
      side={(
        <>
          <HowNote title="Where a server is kept" tone="quiet">
            <ul>
              <li><strong>User:</strong> every project, for that account.</li>
              <li><strong>Local:</strong> one folder, for that account.</li>
              <li><strong>Project:</strong> in the repository, for everyone who clones it.</li>
              <li><strong>Plugin:</strong> comes with a plugin.</li>
            </ul>
          </HowNote>
          <HowNote title="Keys">
            <ul>
              <li>Values that look like keys or tokens are never shown.</li>
              <li>Wanigan never asks for or keeps a key: a server that needs one is finished in a terminal, or in your own.</li>
            </ul>
          </HowNote>
        </>
      )}>
      <HowLane n={1} title="What is there" actor="wanigan">
        <HowBox actor="wanigan" title="Read from each agent’s files" num={howNum(total, 'server found', 'servers found')}>
          Claude Code’s, Codex’s and Gemini CLI’s own settings, for every account and open project.
        </HowBox>
        <HowArrow label="you ask" />
        <HowBox actor="agents" title="Check connections">
          Runs claude mcp list as that account, which starts each server to see whether it answers, and lists any it found elsewhere.
        </HowBox>
      </HowLane>
      <HowLane n={2} title="Adding and removing" actor="you">
        <HowBox actor="you" title="From the store" num={howNum(store, 'well-known server', 'well-known servers')} onClick={() => { onClose(); onStore(); }} hint="Show the store">
          Install commands checked against each publisher’s documentation. Choose the account and where it is kept.
        </HowBox>
        <HowArrow />
        <HowBox actor="agents" title="The agent’s own command">
          You see the exact command first; Wanigan runs it with no shell, as the account you chose. Remove works the same way.
        </HowBox>
      </HowLane>
    </HowDialog>
  );
}
