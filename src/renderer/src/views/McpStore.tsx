import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ExtensionInfo, McpServerReview } from '@shared/types';
import type { StoreEntry, StoreInstall, StoreSourceInfo, StoreUpdate } from '@shared/mcp-registry';
import { STORE_DOWNLOADS_FRESH_MS, STORE_NPM_REQUESTS_PER_SECOND } from '@shared/store-query';
import ExtensionCredentials from './ExtensionCredentials';
import type {
  StoreDownloadsStatus, StorePublisher, StoreResults, StoreRuns, StoreRuntime, StoreSort, StoreState,
} from '@shared/store-query';
import {
  Chip, ConfirmNote, EmptyState, Explainer, Hint, Mark, Note, Reading, SectionHead, Segmented, ago, num, type Tone,
} from '../components/bits';

/*
 * The store half of Extensions: MCP servers from the catalogs installed
 * extensions declare, searched live and reviewed one at a time.
 *
 * This component never installs. "Review" hands a catalog key, a name and a
 * version up to Extensions, which asks the main process to fetch that exact
 * version and write it out as an extension directory; what comes back is an
 * ordinary inspection shown in the ordinary consent panel. The store is a way to
 * find a server — deciding to run one stays where it always was.
 *
 * What a card can honestly say about trust is what the registry verifies, and
 * no more: who controls the namespace an entry is published under. So the card
 * leads with that, in words, and never shows a badge the registry did not grant.
 */

const SEARCH_DELAY_MS = 250;
const PAGE = 30;

/** The registry verified this namespace, so it is the one fact about the publisher worth leading with. */
function publisherReading(namespace: string): string {
  const github = /^io\.github\.(.+)$/i.exec(namespace);
  if (github) return `GitHub @${github[1]}`;
  // Reverse-DNS, as the registry requires: `com.acme` was verified as acme.com.
  return `domain ${namespace.split('.').reverse().join('.')}`;
}

function runsAs(install: StoreInstall): { glyph: string; word: string; tone: Tone } {
  switch (install.kind) {
    case 'npm': return { glyph: '▸', word: 'Runs on this machine with npx', tone: 'quiet' };
    case 'pypi': return { glyph: '▸', word: 'Runs on this machine with uvx', tone: 'quiet' };
    case 'oci': return { glyph: '▸', word: 'Runs on this machine in Docker', tone: 'quiet' };
    case 'remote': {
      let host = install.url;
      try { host = new URL(install.url).host; } catch { /* shown as published */ }
      return { glyph: '↗', word: `Hosted by ${host}`, tone: 'quiet' };
    }
    default: return { glyph: '–', word: 'Not installable in Wanigan yet', tone: 'quiet' };
  }
}

/** How long npm will take to answer this many requests at the pace it allows one machine. */
function readTime(requests: number, perSecond: number = STORE_NPM_REQUESTS_PER_SECOND): string {
  const minutes = Math.ceil(requests / Math.max(0.05, perSecond) / 60);
  if (minutes <= 1) return 'under a minute';
  if (minutes < 60) return `about ${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  const rest = Math.round((minutes % 60) / 5) * 5;
  return `about ${hours} hour${hours === 1 ? '' : 's'}${rest ? ` ${rest} minutes` : ''}`;
}

/** The exact line an enabled stdio server runs, as the registry stores it. */
function commandLine(server: McpServerReview): string {
  return [server.command ?? '', ...server.args].join(' ').trim();
}

function hostOf(url: string | null): string {
  if (!url) return 'its host';
  try { return new URL(url).host; } catch { return url; }
}

/** The MCP server an installed store extension registered, if it registered one. */
function serverOf(extension: ExtensionInfo | undefined, servers: McpServerReview[]): McpServerReview | null {
  const artifact = extension?.artifacts.find((a) => a.kind === 'mcp-server' && a.applied);
  if (!artifact) return null;
  return servers.find((s) => s.name === artifact.ref && s.projectId === artifact.projectId) ?? null;
}

/**
 * The second approval, where the operator already is. Installing registered the
 * server switched off; turning it on is its own decision, and this says exactly
 * what that decision grants. For a stdio server it trusts the command digest the
 * operator is looking at — the main process refuses to enable one whose exact
 * command line was not approved, and refuses a digest that no longer matches — so
 * the store cannot shortcut the gate Settings enforces, only put it in view.
 */
function TurnOnConfirm({ server, busy, onRun, onCancel }: {
  server: McpServerReview; busy: boolean; onRun: () => Promise<void>; onCancel: () => void;
}) {
  const local = server.transport === 'stdio';
  return (
    <ConfirmNote
      busy={busy}
      verb={busy ? 'Turning on…' : local && server.trust !== 'trusted' ? 'Trust and turn on' : 'Turn on'}
      onRun={onRun}
      onCancel={onCancel}
      what={local ? (
        <>
          <strong>Turn on {server.name}?</strong> Every session that uses it will start this command on this
          machine, as you, with your files: <span className="mono">{commandLine(server)}</span>
        </>
      ) : (
        <>
          <strong>Turn on {server.name}?</strong> Every session that uses it will send its tool calls
          to <span className="mono">{hostOf(server.url)}</span>.
        </>
      )}
    />
  );
}

export default function McpStore({ installed, busy, justInstalled, onDismissInstalled, onReview, onExtensions }: {
  installed: ExtensionInfo[];
  /** A fresh extension list, after a credential is saved or removed here. */
  onExtensions: (list: ExtensionInfo[]) => void;
  busy: string | null;
  /** The extension the operator just installed from the store, so its outcome is read out here. */
  justInstalled: ExtensionInfo | null;
  onDismissInstalled: () => void;
  onReview: (sourceKey: string, name: string, version: string) => void;
}) {
  const [sources, setSources] = useState<StoreSourceInfo[] | null>(null);
  const [sourceKey, setSourceKey] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [settled, setSettled] = useState('');
  const [sort, setSort] = useState<StoreSort>('best');
  const [runs, setRuns] = useState<StoreRuns[]>([]);
  const [runtimes, setRuntimes] = useState<StoreRuntime[]>([]);
  const [publishers, setPublishers] = useState<StorePublisher[]>([]);
  const [states, setStates] = useState<StoreState[]>([]);
  const [noSetup, setNoSetup] = useState(false);
  const [everything, setEverything] = useState(false);
  const [deprecated, setDeprecated] = useState(false);
  const [results, setResults] = useState<StoreResults | null>(null);
  const [more, setMore] = useState<StoreEntry[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [sync, setSync] = useState<{ phase: 'idle' | 'syncing' | 'done' | 'error'; error?: string }>({ phase: 'idle' });
  const [syncTick, setSyncTick] = useState(0);
  const [updates, setUpdates] = useState<StoreUpdate[] | null>(null);
  const [servers, setServers] = useState<McpServerReview[]>([]);
  const [confirming, setConfirming] = useState<{ serverId: string; where: 'note' | 'card' } | null>(null);
  const [turning, setTurning] = useState(false);
  const [turned, setTurned] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [downloads, setDownloads] = useState<StoreDownloadsStatus | null>(null);
  const [downloadsTick, setDownloadsTick] = useState(0);
  // Every query is numbered, and only the newest may write results: a slow
  // answer to an older filter must not replace the current one.
  const generation = useRef(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    void (async () => {
      try {
        const found = await window.wanigan.store.sources();
        if (!alive.current) return;
        setSources(found);
        setSourceKey((current) => current ?? found[0]?.key ?? null);
      } catch (e) {
        if (alive.current) { setSources([]); setSync({ phase: 'error', error: e instanceof Error ? e.message : String(e) }); }
      }
    })();
    return () => { alive.current = false; };
  }, []);

  // One sync per visit, and on Refresh. Whatever the index already holds is shown
  // at once; the sync only brings it current, reading what changed since last time.
  const resync = useCallback(async (key: string) => {
    setSync({ phase: 'syncing' });
    try {
      await window.wanigan.store.sync(key);
      if (!alive.current) return;
      setSync({ phase: 'done' });
      setSyncTick((n) => n + 1);
      setUpdates(await window.wanigan.store.updates());
    } catch (e) {
      if (alive.current) setSync({ phase: 'error', error: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  useEffect(() => { if (sourceKey) void resync(sourceKey); }, [sourceKey, resync]);

  useEffect(() => {
    const timer = setTimeout(() => setSettled(text.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [text]);

  const spec = useMemo(
    () => ({ text: settled, sort, runs, runtimes, publishers, states, noSetup, everything, deprecated }),
    [settled, sort, runs, runtimes, publishers, states, noSetup, everything, deprecated],
  );
  // What is installed changes what "Installed" and "Update available" mean, so
  // an install from this page re-reads it rather than leaving a stale badge.
  const installedKey = useMemo(() => installed.map((x) => `${x.id}@${x.version}`).join('|'), [installed]);

  useEffect(() => {
    if (!sourceKey) return;
    const mine = ++generation.current;
    void window.wanigan.store.query(sourceKey, { ...spec, offset: 0, limit: PAGE })
      .then((r) => { if (alive.current && mine === generation.current) { setResults(r); setMore([]); } })
      .catch((e: unknown) => {
        if (alive.current && mine === generation.current) setSync({ phase: 'error', error: e instanceof Error ? e.message : String(e) });
      });
  }, [sourceKey, spec, syncTick, installedKey, downloadsTick]);

  // Most downloaded reads npm's counts, a second host, so the store asks first.
  // Choosing the sort only reads where things stand and what a read would cost.
  useEffect(() => {
    if (sort !== 'downloads') return;
    void window.wanigan.store.downloads().then((d) => { if (alive.current) setDownloads(d); }).catch(() => {});
  }, [sort]);

  // While a read runs, follow it and let the ranking fill in as counts arrive.
  useEffect(() => {
    if (downloads?.phase !== 'running') return;
    const timer = setInterval(() => {
      void window.wanigan.store.downloads().then((d) => {
        if (!alive.current) return;
        setDownloads(d);
        setDownloadsTick((n) => n + 1);
      }).catch(() => {});
    }, 1500);
    return () => clearInterval(timer);
  }, [downloads?.phase]);

  async function readDownloads() {
    try {
      const d = await window.wanigan.store.fetchDownloads();
      if (alive.current) setDownloads(d);
    } catch (e) {
      if (alive.current) setDownloads((d) => d && { ...d, phase: 'error', error: e instanceof Error ? e.message : String(e) });
    }
  }

  // The servers installed store extensions registered, for whether each is on.
  // Read through the same call Settings uses; nothing here writes except turnOn.
  const reloadServers = useCallback(async () => {
    try {
      const rows = await window.wanigan.mcp.review();
      if (alive.current) setServers(rows);
    } catch { /* the cards fall back to showing no switch at all */ }
  }, []);
  useEffect(() => { void reloadServers(); }, [installedKey, reloadServers]);

  async function turnOn(server: McpServerReview) {
    setTurning(true);
    setTurned(null);
    try {
      // The digest passed back is the one on screen. If the command changed in
      // between, the main process refuses it and nothing is trusted.
      if (server.transport === 'stdio' && server.trust !== 'trusted') await window.wanigan.mcp.trust(server.id, server.sha256);
      await window.wanigan.mcp.setEnabled(server.id, true);
      if (!alive.current) return;
      setConfirming(null);
      setTurned({ tone: 'ok', text: `${server.name} is on. Sessions started from now on can use it; one already running picks it up when it restarts.` });
      await reloadServers();
    } catch (e) {
      if (alive.current) setTurned({ tone: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      if (alive.current) setTurning(false);
    }
  }

  async function showMore() {
    if (!sourceKey || !results || loadingMore) return;
    const mine = generation.current;
    setLoadingMore(true);
    try {
      const r = await window.wanigan.store.query(sourceKey, { ...spec, offset: results.entries.length + more.length, limit: PAGE });
      if (alive.current && mine === generation.current) setMore((m) => [...m, ...r.entries]);
    } finally {
      if (alive.current) setLoadingMore(false);
    }
  }

  function clearFilters() {
    setRuns([]); setRuntimes([]); setPublishers([]); setStates([]);
    setNoSetup(false); setEverything(false); setDeprecated(false);
  }

  const byId = useMemo(() => new Map(installed.map((x) => [x.id, x])), [installed]);
  const source = sources?.find((s) => s.key === sourceKey) ?? null;
  const shown = results ? [...results.entries, ...more] : [];
  const facets = results?.facets ?? null;
  const filterCount = runs.length + runtimes.length + publishers.length + states.length + Number(noSetup);
  const firstSync = !!results && results.syncedAt === null;
  const locked = busy !== null;

  if (sources === null) return <Reading what="the catalogs your extensions declare" />;

  if (sources.length === 0) {
    return (
      <EmptyState
        posture="nothing-yet"
        title="No catalog is switched on"
        cue={'The store browses catalogs that extensions declare. The built-in “MCP Registry catalog” extension is '
          + 'the default one — switch it back on under Installed to browse it again. With none on, the store '
          + 'contacts nobody.'}
      />
    );
  }

  const heading = settled ? `Matching “${settled}”`
    : sort === 'name' ? 'All servers, A–Z'
      : sort === 'downloads' ? 'Most downloaded on npm'
        : 'Recently updated';
  const countsStale = !!downloads?.fetchedAt && Date.now() - downloads.fetchedAt > STORE_DOWNLOADS_FRESH_MS;

  return (
    <section className="ex-group" aria-label="MCP server store">
      <Explainer id="mcp-store-how" title="How the store works" compact>
        <p className="ex-lead">
          Browse MCP servers published to {source ? `the ${source.label} (${source.host})` : 'your catalogs'}.
          Wanigan keeps a copy of the catalog on this machine and brings it up to date when you open the store, so
          searching, sorting and filtering happen here and nothing you type is sent. The registry verifies who
          publishes under each name — shown on every card as a GitHub account or a domain. It does <strong>not</strong> review
          what a server does, and neither does Wanigan, so there are no ratings here: nobody publishes any. Reviewing
          an entry fetches that exact version and shows the command it will run, the host it will reach and anything
          it will ask you for. Nothing installs until you press the button, and an update is never applied for you.
        </p>
      </Explainer>

      {justInstalled && (() => {
        // The installer's own words, not a paraphrase: it knows whether a server
        // came in switched on, and a store that said "installed" and nothing else
        // would leave a local server off with nobody told why.
        const notes = justInstalled.artifacts.map((a) => a.note).filter((n): n is string => !!n);
        const current = byId.get(justInstalled.id) ?? justInstalled;
        const server = serverOf(current, servers);
        const off = !!server && !server.enabled;
        const missing = current.credentials.filter((c) => !c.present);
        return (
          <>
            <Note tone={off ? 'info' : 'ok'} role="status" onDismiss={onDismissInstalled}
                  action={off && confirming?.serverId !== server.id
                    ? { label: 'Turn on here', run: () => setConfirming({ serverId: server.id, where: 'note' }) }
                    : undefined}>
              <strong>{justInstalled.label} is installed.</strong>{' '}
              {missing.length > 0 && `It needs ${missing.map((c) => c.label).join(' and ')} before it can work — add ${missing.length === 1 ? 'it' : 'them'} below. `}
              {off ? 'It is switched off: installing never turns a server on for you. Turn it on here, or later in Settings → Connections → MCP servers.' : notes.join(' ')}
            </Note>
            {missing.length > 0 && <ExtensionCredentials extension={current} onChanged={onExtensions} />}
            {off && confirming?.serverId === server.id && confirming.where === 'note' && (
              <TurnOnConfirm server={server} busy={turning} onRun={() => turnOn(server)} onCancel={() => setConfirming(null)} />
            )}
          </>
        );
      })()}

      {turned && <Note tone={turned.tone} role="status" onDismiss={() => setTurned(null)}>{turned.text}</Note>}

      {updates && updates.length > 0 && (
        <Note tone="info" role="status">
          <strong>
            {num(updates.length)} installed {updates.length === 1 ? 'server has' : 'servers have'} a newer version.
          </strong>{' '}
          Each is a new command, so it goes back through review before it runs.
          {updates.map((u) => (
            <div className="ex-actions" key={u.extensionId}>
              <span className="ex-meta">{u.title} · <span className="mono">{u.installed} → {u.latest}</span></span>
              <button type="button" className="btn btn-sm" disabled={locked}
                      onClick={() => onReview(u.sourceKey, u.name, u.latest)}>
                {busy === `stage:${u.name}` ? 'Fetching…' : 'Review update'}
              </button>
            </div>
          ))}
        </Note>
      )}

      {sync.phase === 'error' && sync.error && (
        <Note tone="error" onDismiss={() => setSync({ phase: 'idle' })}>
          {results?.catalogSize ? `Showing the copy from ${ago(results.syncedAt)}. ` : ''}{sync.error}
        </Note>
      )}

      <div className="ex-toolbar">
        {sources.length > 1 && (
          <div className="ex-search">
            <label className="label" htmlFor="store-source">Catalog</label>
            <select id="store-source" className="field" value={sourceKey ?? ''}
                    onChange={(e) => { setResults(null); setSourceKey(e.target.value); }}>
              {sources.map((s) => <option key={s.key} value={s.key}>{s.label} — {s.host}</option>)}
            </select>
          </div>
        )}
        <div className="ex-search">
          <label className="label" htmlFor="store-search">Search the catalog</label>
          <input
            id="store-search"
            type="search"
            className="field"
            value={text}
            placeholder="A service, a tool, a publisher — github, postgres, playwright…"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); setText(''); } }}
          />
          <Hint>Searched on this machine against its copy of the catalog. Nothing you type is sent.</Hint>
        </div>
        <Segmented<StoreSort>
          label="Sort servers"
          value={sort}
          onChange={setSort}
          options={[
            { value: 'best', label: 'Best match', title: 'Closest to your search; newest first when you have not searched' },
            { value: 'updated', label: 'Recently updated' },
            { value: 'name', label: 'Name' },
            { value: 'downloads', label: 'Most downloaded', title: 'By npm’s weekly download counts. Only npm packages have them.' },
          ]}
        />
      </div>

      {sort === 'downloads' && downloads && (
        downloads.phase === 'running' ? (
          <Note tone="info" role="status">
            Reading npm&rsquo;s weekly download counts: {num(downloads.done)} of {num(downloads.total)} packages,
            {' '}{readTime(downloads.requests, downloads.observedPerSecond ?? undefined)} to go
            {downloads.observedPerSecond ? ' at the pace npm is answering' : ' at the pace npm allows'}. The ranking fills in as they arrive, and it
            keeps reading if you leave this page.
            {downloads.pausedUntil && downloads.pausedUntil > Date.now() && (
              <> npm asked Wanigan to slow down, so it is waiting {Math.ceil((downloads.pausedUntil - Date.now()) / 1000)}s before carrying on.</>
            )}
          </Note>
        ) : downloads.phase === 'error' ? (
          <Note tone="error" action={{ label: 'Read again', run: () => void readDownloads() }}>{downloads.error}</Note>
        ) : downloads.fetchedAt === null ? (
          <Note tone="info" action={{ label: 'Read download counts', run: () => void readDownloads() }}>
            <strong>Most downloaded needs npm&rsquo;s own download counts, which Wanigan has not read.</strong>{' '}
            That is {num(downloads.requests)} requests to api.npmjs.org for {num(downloads.total)} npm packages. npm lets one
            machine ask about forty-five times a minute, so it takes {readTime(downloads.requests)}: unscoped packages
            arrive in seconds, the rest fill in as they come. It keeps reading if you leave this page, picks up where it
            stopped if Wanigan quits, and is kept for a week. Only npm packages have counts — hosted, PyPI and Docker
            servers are listed after them, never ranked as zero.
          </Note>
        ) : (
          <div className="ex-active">
            <span className="sub">
              npm weekly downloads as of {ago(downloads.fetchedAt)} · npm packages only; the rest follow, unranked
            </span>
            {countsStale && (
              <button type="button" className="btn btn-sm" onClick={() => void readDownloads()}>Read again</button>
            )}
          </div>
        )
      )}

      {facets && results && results.catalogSize > 0 && (
        <div className="ex-facets">
          <div className="ex-facet-row">
            <span className="sub">Runs</span>
            <Chip pressed={runs.includes('local')} count={facets.runs.local} zero={facets.runs.local === 0}
                  onToggle={() => setRuns((v) => flip(v, 'local'))}>On this machine</Chip>
            <Chip pressed={runs.includes('hosted')} count={facets.runs.hosted} zero={facets.runs.hosted === 0}
                  onToggle={() => setRuns((v) => flip(v, 'hosted'))}>Hosted</Chip>
            <span className="sub">with</span>
            {(['npx', 'uvx', 'docker'] as const).map((r) => (
              <Chip key={r} pressed={runtimes.includes(r)} count={facets.runtimes[r]} zero={facets.runtimes[r] === 0}
                    onToggle={() => setRuntimes((v) => flip(v, r))}>{r === 'docker' ? 'Docker' : r}</Chip>
            ))}
          </div>
          <div className="ex-facet-row">
            <span className="sub">Publisher</span>
            <Chip pressed={publishers.includes('github')} count={facets.publishers.github} zero={facets.publishers.github === 0}
                  title="Published under an io.github.* name: the registry verified the GitHub account"
                  onToggle={() => setPublishers((v) => flip(v, 'github'))}>GitHub account</Chip>
            <Chip pressed={publishers.includes('domain')} count={facets.publishers.domain} zero={facets.publishers.domain === 0}
                  title="Published under a reverse-DNS name: the registry verified control of the domain"
                  onToggle={() => setPublishers((v) => flip(v, 'domain'))}>Verified domain</Chip>
            <span className="sub">Setup</span>
            <Chip pressed={noSetup} count={facets.noSetup} zero={facets.noSetup === 0}
                  title="Installs without asking you for a key, token or setting"
                  onToggle={() => setNoSetup((v) => !v)}>Asks for nothing</Chip>
          </div>
          <div className="ex-facet-row">
            <span className="sub">Here</span>
            <Chip pressed={states.includes('installed')} count={facets.states.installed} zero={facets.states.installed === 0}
                  onToggle={() => setStates((v) => flip(v, 'installed'))}>Installed</Chip>
            <Chip pressed={states.includes('update')} count={facets.states.update} zero={facets.states.update === 0}
                  onToggle={() => setStates((v) => flip(v, 'update'))}>Update available</Chip>
            <Chip pressed={states.includes('not-installed')} count={facets.states['not-installed']} zero={facets.states['not-installed'] === 0}
                  onToggle={() => setStates((v) => flip(v, 'not-installed'))}>Not installed</Chip>
            <span className="sub">Also show</span>
            <Chip pressed={everything} count={facets.unsupported} zero={facets.unsupported === 0}
                  title="Entries Wanigan cannot install yet, each with the reason"
                  onToggle={() => setEverything((v) => !v)}>Not installable yet</Chip>
            <Chip pressed={deprecated} count={facets.deprecated} zero={facets.deprecated === 0}
                  onToggle={() => setDeprecated((v) => !v)}>Deprecated</Chip>
          </div>
        </div>
      )}

      {results && results.catalogSize > 0 && (
        <div className="ex-active">
          <span className="sub">
            {num(results.catalogSize)} servers in the {source?.label ?? 'catalog'} ·{' '}
            {sync.phase === 'syncing' ? 'checking for changes…' : `up to date as of ${ago(results.syncedAt)}`}
          </span>
          <button type="button" className="btn btn-sm" disabled={sync.phase === 'syncing' || !sourceKey}
                  onClick={() => sourceKey && void resync(sourceKey)}>
            {sync.phase === 'syncing' ? 'Checking…' : 'Check now'}
          </button>
          {filterCount > 0 && (
            <button type="button" className="btn btn-sm" onClick={clearFilters}>Clear {num(filterCount)} filter{filterCount === 1 ? '' : 's'}</button>
          )}
        </div>
      )}

      {!results || (firstSync && sync.phase === 'syncing') ? (
        <Reading what={`the ${source?.label ?? 'catalog'} for the first time — every server it lists, once, so that searching and sorting can happen on this machine`} />
      ) : shown.length === 0 ? (
        <EmptyState
          posture="nothing-in-scope"
          title={settled ? <>Nothing matches “{settled}”</> : 'Nothing matches these filters'}
          cue={facets && facets.unsupported > 0 && !everything
            ? `${num(facets.unsupported)} ${facets.unsupported === 1 ? 'entry matches' : 'entries match'} but Wanigan cannot install ${facets.unsupported === 1 ? 'it' : 'them'} yet. Show them to see why.`
            : 'Try fewer words, or clear a filter.'}
          action={filterCount > 0
            ? <button type="button" className="btn" onClick={clearFilters}>Clear filters</button>
            : facets && facets.unsupported > 0 && !everything
              ? <button type="button" className="btn" onClick={() => setEverything(true)}>Show them</button>
              : undefined}
        />
      ) : (
        <>
          <SectionHead label={heading} count={results.total} />
          <div className="ex-grid">
            {shown.map((entry) => (
              <StoreCard
                key={`${entry.sourceId}|${entry.name}`}
                entry={entry}
                have={byId.get(entry.extensionId) ?? null}
                server={serverOf(byId.get(entry.extensionId), servers)}
                downloads={results.downloads[entry.name]}
                busy={busy}
                confirming={confirming?.where === 'card' ? confirming.serverId : null}
                turning={turning}
                onReview={() => onReview(entry.sourceId, entry.name, entry.version)}
                onAskTurnOn={(id) => setConfirming({ serverId: id, where: 'card' })}
                onTurnOn={turnOn}
                onCancelTurnOn={() => setConfirming(null)}
                onExtensions={onExtensions}
              />
            ))}
          </div>
          {shown.length < results.total && (
            <div className="ex-actions">
              <button type="button" className="btn" disabled={loadingMore} onClick={() => void showMore()}>
                {loadingMore ? 'Reading…' : `Show ${num(Math.min(PAGE, results.total - shown.length))} more of ${num(results.total - shown.length)}`}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function flip<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

/** One catalog entry: who published it, how it runs, what it asks for, and where it stands on this machine. */
function StoreCard({
  entry, have, server, downloads, busy, confirming, turning, onReview, onAskTurnOn, onTurnOn, onCancelTurnOn, onExtensions,
}: {
  entry: StoreEntry;
  have: ExtensionInfo | null;
  /** npm weekly downloads, when this is an npm package and a count has been read. */
  downloads?: number;
  /** The server this entry's installed extension registered, when it is installed. */
  server: McpServerReview | null;
  busy: string | null;
  confirming: string | null;
  turning: boolean;
  onReview: () => void;
  onAskTurnOn: (serverId: string) => void;
  onTurnOn: (server: McpServerReview) => Promise<void>;
  onCancelTurnOn: () => void;
  onExtensions: (list: ExtensionInfo[]) => void;
}) {
  const [keysOpen, setKeysOpen] = useState(false);
  const missing = have?.credentials.filter((c) => !c.present) ?? [];
  const locked = busy !== null;
  const fetching = busy === `stage:${entry.name}`;
  const runs = runsAs(entry.install);
  const state = !have ? 'available' : have.version === entry.installsAs ? 'installed' : 'update';
  const link = entry.repositoryUrl ?? entry.websiteUrl;

  return (
    <article className="ex-card">
      <div className="ex-card-head">
        <div className="ex-identity">
          <h3 className="ex-title">{entry.title}</h3>
          <span className="ex-ver mono">{entry.version}</span>
          {state === 'installed' && <Mark glyph="✓" word="Installed" tone="ok" />}
          {have && server && (server.enabled
            ? <Mark glyph="●" word="On" tone="ok" />
            : <Mark glyph="○" word="Switched off" tone="quiet" />)}
          {state === 'update' && <Mark glyph="↑" word={`Installed ${have!.version}, update available`} tone="accent" />}
          {entry.deprecated && <Mark glyph="!" word="Deprecated by its publisher" tone="warn" />}
        </div>
        <div className="ex-card-actions">
          {link && (
            <button type="button" className="btn btn-sm" onClick={() => void window.wanigan.shell.openExternal(link)}>
              {entry.repositoryUrl ? 'Source' : 'Website'}
            </button>
          )}
          {server && !server.enabled && confirming !== server.id && (
            <button type="button" className="btn btn-sm" disabled={locked || turning} onClick={() => onAskTurnOn(server.id)}>
              Turn on…
            </button>
          )}
          {entry.install.kind !== 'unsupported' && state !== 'installed' && (
            <button type="button" className="btn btn-sm btn-primary" disabled={locked} onClick={onReview}>
              {fetching ? 'Fetching…' : state === 'update' ? 'Review update' : 'Review & install'}
            </button>
          )}
        </div>
      </div>

      <p className="ex-sub">{entry.description || 'Its publisher gave no description.'}</p>
      <p className="ex-meta">
        {publisherReading(entry.namespace)} · <span className="mono">{entry.name}</span>
        {entry.publishedAt ? ` · published ${ago(entry.updatedAt ?? entry.publishedAt)}` : ''}
      </p>

      <div className="ex-provides">
        <Mark glyph={runs.glyph} word={runs.word} tone={runs.tone} />
        {downloads !== undefined && (
          <Mark glyph="↓" word={`${num(downloads)} npm downloads last week`} tone="quiet" />
        )}
        {entry.asks.length > 0 && !have && (
          <Mark glyph="!" word={`Asks for ${entry.asks.join(', ')}`} tone="warn" />
        )}
        {have && missing.length > 0 && (
          <Mark glyph="!" word={`Needs ${missing.map((c) => c.label).join(', ')}`} tone="warn" />
        )}
        {have && have.credentials.length > 0 && missing.length === 0 && (
          <Mark glyph="✓" word="Keys saved" tone="ok" />
        )}
        {have && have.credentials.length > 0 && (
          <button type="button" className="btn btn-sm" onClick={() => setKeysOpen((v) => !v)}>
            {keysOpen ? 'Hide keys' : missing.length ? 'Add key…' : 'Keys…'}
          </button>
        )}
      </div>

      {have && keysOpen && <ExtensionCredentials extension={have} onChanged={onExtensions} />}

      {entry.install.kind === 'unsupported' && <p className="ex-blurb">{entry.install.reason}</p>}

      {server && confirming === server.id && (
        <TurnOnConfirm server={server} busy={turning} onRun={() => onTurnOn(server)} onCancel={onCancelTurnOn} />
      )}
    </article>
  );
}
