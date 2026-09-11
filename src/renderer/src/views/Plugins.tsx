import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EmptyState, Mark, Note, PageHead, Reading, SectionHead, Segmented, ago, num, type Tone } from '../components/bits';
import { useDialog } from '../components/useDialog';
import { useLiveViewMemory } from '../components/planningMemory';
import { useRememberedScrollRef } from '../components/viewMemory';

/* Shapes mirror src/main/plugins.ts; the renderer cannot import from main. */
type Component = { kind: 'skill' | 'command' | 'agent'; name: string; path: string };
type Installed = {
  id: string; name: string; marketplace: string; version: string; scope: string;
  installedAt: number | null; lastUpdated: number | null; path: string;
  description: string | null; author: string | null; homepage: string | null;
  skills: Component[]; commands: Component[]; agents: Component[];
  hookEvents: string[]; mcpServers: string[]; hasReadme: boolean; present: boolean; bytes: number;
  /** What settings.json says, or null when it does not mention this plugin. */
  enabledInSettings: boolean | null;
};
type Src = { kind: string; origin: string; local: boolean; subpath: string | null; pinned: string | null };
type Available = { id: string; name: string; marketplace: string; description: string | null; installed: boolean; path: string; source: Src | null };
type CatalogItem = { id: string; name: string; marketplace: string; description: string; installed: boolean; enabled: boolean | null; source: Src | null };
type Action = { ok: boolean; output: string; error: string | null };
type Market = { name: string; source: string; installLocation: string; lastUpdated: number | null; present: boolean };
type State = {
  installed: Installed[]; available: Available[]; marketplaces: Market[];
  roots: { label: string; path: string; exists: boolean }[]; notes: string[]; scannedAt: number;
};

const kb = (b: number) => (b < 1024 ? `${b} B` : b < 1048576 ? `${Math.round(b / 1024)} KB` : `${(b / 1048576).toFixed(1)} MB`);

function origin(s: Src | null, marketplace: string) {
  if (!s) {
    return <>Nothing in the <span className="mono">{marketplace}</span> manifest records where this
      plugin comes from, so Wanigan cannot name what installing it will fetch.</>;
  }
  if (s.local) {
    return <>Recorded source: <span className="mono">{s.origin}</span> — a path inside the{' '}
      <span className="mono">{marketplace}</span> checkout, not a remote of its own.</>;
  }
  return <>Recorded source: <span className="mono">{s.origin}</span>
    {s.subpath && <>, directory <span className="mono">{s.subpath}</span></>}
    {s.pinned && <>, pinned at <span className="mono">{s.pinned}</span></>}.</>;
}


type Enablement = 'unread' | 'on-settings' | 'off-settings' | 'on' | 'off' | 'absent' | 'unlisted';
function enablementOf(id: string, cat: CatalogItem[] | null, fromSettings: boolean | null): Enablement {
  if (!cat) return fromSettings === true ? 'on-settings' : fromSettings === false ? 'off-settings' : 'unread';
  const row = cat.find(c => c.id === id);
  if (!row) return 'unlisted';
  if (!row.installed) return 'absent';
  return typeof row.enabled !== 'boolean' ? 'unread' : row.enabled ? 'on' : 'off';
}
const ENABLEMENT: Record<Enablement, { glyph: string; word: string; tone: Tone; blurb: string }> = {
  unread: { glyph: '?', word: 'State not read', tone: 'quiet', blurb: 'Enablement is not reported. Ask the CLI to read its current plugin list.' },
  'on-settings': { glyph: '●', word: 'Enabled in settings', tone: 'ok', blurb: 'This account’s settings switch this plugin on. Existing sessions may have loaded an earlier configuration.' },
  'off-settings': { glyph: '○', word: 'Disabled in settings', tone: 'quiet', blurb: 'This account’s settings switch this plugin off. Existing sessions may have loaded an earlier configuration.' },
  on: { glyph: '●', word: 'Enabled', tone: 'ok', blurb: 'The CLI reports this plugin enabled. Changes apply when Claude Code next loads its plugins.' },
  off: { glyph: '○', word: 'Disabled', tone: 'quiet', blurb: 'The CLI reports this plugin disabled. Existing sessions may still hold its earlier configuration.' },
  absent: { glyph: '!', word: 'Registration differs', tone: 'warn', blurb: 'Registered on disk, but the CLI does not list it as installed. Check the registration in Claude Code before using it.' },
  unlisted: { glyph: '?', word: 'Not in CLI catalog', tone: 'quiet', blurb: 'The CLI catalog has no entry for this registration. The local scan remains available below.' },
};
type Area = 'installed' | 'catalog' | 'marketplaces';
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);

export default function Plugins() {
  const [st, setSt] = useLiveViewMemory<State | null>('scan', null);
  const [err, setErr] = useLiveViewMemory<string | null>('scan-error', null);
  const [busy, setBusy] = useLiveViewMemory('scanning', false);
  const [area, setArea] = useLiveViewMemory<Area>('area', 'installed');
  const [q, setQ] = useLiveViewMemory('query', '');
  const [chosen, setChosen] = useLiveViewMemory('selection', '');
  const [filter, setFilter] = useLiveViewMemory('filter', 'all');
  const [cat, setCat] = useLiveViewMemory<CatalogItem[] | null>('catalog', null);
  const [catNote, setCatNote] = useLiveViewMemory<string | null>('catalog-note', null);
  const [catBusy, setCatBusy] = useLiveViewMemory('catalog-pending', false);
  const [working, setWorking] = useLiveViewMemory<string | null>('working', null);
  const [result, setResult] = useLiveViewMemory<{ id: string; ok: boolean; text: string } | null>('result', null);
  const [cost, setCost] = useLiveViewMemory<Record<string, number | null>>('cost', {});
  const [market, setMarket] = useLiveViewMemory('market-source', '');
  const [reading, setReading] = useState<{ title: string; text: string; truncated: boolean } | null>(null);
  const [confirming, setConfirming] = useState<CatalogItem | null>(null);
  const [readBusy, setReadBusy] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const mounted = useRef(false), readSeq = useRef(0), current = useRef('');
  const listRef = useRememberedScrollRef('library');
  const inspector = useRef<HTMLElement>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; readSeq.current++; }; }, []);

  const load = useCallback(async (refresh = false) => {
    let claimed = false;
    setBusy(pending => { if (!pending) claimed = true; return true; });
    if (!claimed) return;
    try { setSt(refresh ? await window.wanigan.plugins.refresh() : await window.wanigan.plugins.list()); setErr(null); }
    catch (e) { setErr(errorText(e)); }
    finally { setBusy(false); }
  }, [setBusy, setSt, setErr]);
  useEffect(() => { void load(); }, [load]);
  const loadCatalog = useCallback(async () => {
    let claimed = false;
    setCatBusy(pending => { if (!pending) claimed = true; return true; });
    if (!claimed) return;
    try {
      const r = await window.wanigan.plugins.catalog();
      // A failed CLI read cannot stand in for a successful empty catalog.
      setCat(r.note ? null : (r.plugins as CatalogItem[]));
      setCatNote(r.note);
    } catch (e) { setCat(null); setCatNote(errorText(e)); }
    finally { setCatBusy(false); }
  }, [setCatBusy, setCat, setCatNote]);

  const catalog = useMemo(() => {
    const rows: CatalogItem[] = cat ?? (st?.available ?? []).map(a => ({
      id: a.id, name: a.name, marketplace: a.marketplace,
      description: a.description ?? '', installed: a.installed, enabled: null, source: a.source,
    }));
    return rows;
  }, [st, cat]);
  const installed = st?.installed ?? [];
  const query = q.trim().toLowerCase();
  const rows = (area === 'catalog' ? catalog : installed).filter(p => {
    if (![p.name, p.description, p.marketplace].some(t => t?.toLowerCase().includes(query))) return false;
    if (area !== 'installed' || filter === 'all') return true;
    const item = p as Installed, state = enablementOf(item.id, cat, item.enabledInSettings);
    return filter === 'attention' ? !item.present || ['unread', 'absent', 'unlisted'].includes(state)
      : filter === 'enabled' ? ['on', 'on-settings'].includes(state) : ['off', 'off-settings'].includes(state);
  });
  const selected = rows.find(p => p.id === chosen) ?? rows[0];
  const plugin = selected ? installed.find(p => p.id === selected.id) : undefined;
  const offer = selected ? catalog.find(p => p.id === selected.id) : undefined;
  const selectionKey = `${area}/${selected?.id ?? ''}`;
  current.current = selectionKey;
  useEffect(() => {
    readSeq.current++; setReading(null); setReadError(null); setReadBusy(false); setConfirming(null);
    inspector.current?.scrollTo({ top: 0 });
  }, [selectionKey]);
  const locked = Boolean(working || busy || err || catBusy);
  const state = plugin ? enablementOf(plugin.id, cat, plugin.enabledInSettings) : null;

  async function act(id: string, fn: () => Promise<Action>) {
    if (locked) return;
    let claimed = false;
    setWorking(previous => { if (!previous) claimed = true; return previous ?? id; });
    if (!claimed) return;
    setResult(null);
    try {
      const r = await fn();
      setResult({ id, ok: r.ok, text: r.ok ? r.output || 'Done.' : r.error || 'The CLI did not complete this action.' });
      if (r.ok) {
        if (mounted.current) setConfirming(null);
        if (id === 'market-add') setMarket('');
      }
      await load(true);
      if (cat !== null) await loadCatalog();
    } catch (e) { setResult({ id, ok: false, text: errorText(e) }); }
    finally { setWorking(null); }
  }
  async function read(title: string, request: () => Promise<{ text: string; truncated: boolean }>) {
    const seq = ++readSeq.current, key = current.current;
    setReadBusy(true); setReadError(null);
    try {
      const r = await request();
      if (mounted.current && readSeq.current === seq && current.current === key) setReading({ title, ...r });
    } catch (e) { if (mounted.current && readSeq.current === seq) setReadError(errorText(e)); }
    finally { if (mounted.current && readSeq.current === seq) setReadBusy(false); }
  }
  function showCost(p: Installed) {
    void read(`${p.name} — inventory and cost`, async () => {
      const d = await window.wanigan.plugins.details(p.name);
      if (d.error) throw new Error(d.error);
      setCost(previous => ({ ...previous, [p.id]: d.alwaysOnTokens }));
      return { text: d.text || 'The CLI returned no detail text.', truncated: false };
    });
  }
  function changeArea(next: Area) {
    setArea(next); setQ(''); setChosen(''); setConfirming(null);
    if (next === 'catalog' && cat === null && catNote === null) void loadCatalog();
  }

  return (
    <div className="pane pg-wrap">
      <PageHead title="Plugins" lead="A library of skills, commands, and tools for Claude Code."
        actions={<button className="btn" disabled={busy || Boolean(working)} onClick={() => void load(true)}>{busy ? 'Scanning…' : 'Rescan'}</button>} />
      <div className="pg-toolbar">
        <Segmented<Area> label="Plugin library" value={area} onChange={changeArea} options={[
          { value: 'installed', label: `Installed${st ? ` (${installed.length})` : ''}` },
          { value: 'catalog', label: 'Catalog' }, { value: 'marketplaces', label: 'Marketplaces' },
        ]} />
        <span className="pg-scan">{st ? `Scanned ${ago(st.scannedAt)}` : 'Reading local registrations'}</span>
      </div>
      {err && <Note tone="error" action={{ label: 'Try again', run: () => load(true) }}>The plugin scan could not refresh. {err}{st && ' Showing the last scan; changes are paused.'}</Note>}
      {result && <Note tone={result.ok ? 'ok' : 'error'} onDismiss={() => setResult(null)}><strong>{result.id}</strong><div className="pg-receipt">{result.text}</div></Note>}
      {!st ? !err && <Reading what="your plugins" /> : area === 'marketplaces' ? (
        <div className="pg-markets">
          <section className="pg-market-list" aria-label="Registered marketplaces">
            <div className="pg-intro"><h2>Your sources</h2><p>Marketplaces offer plugins. Each plugin’s own recorded origin appears before installation.</p></div>
            <SectionHead label="Registered marketplaces" count={st.marketplaces.length} right={<button className="btn btn-sm" disabled={locked} onClick={() => void act('market-update', () => window.wanigan.plugins.marketUpdate())}>Update marketplaces</button>} />
            {st.marketplaces.length === 0 && <EmptyState posture="nothing-in-scope" title="Add your first marketplace" cue="Use the source field to register a marketplace with Claude Code." />}
            {st.marketplaces.map(m => <article className="pg-market" key={m.name}>
              <div className="pg-inline"><strong>{m.name}</strong><Mark glyph={m.present ? '●' : '!'} word={m.present ? 'On disk' : 'Directory missing'} tone={m.present ? 'quiet' : 'warn'} /></div>
              <p className="pg-path">{m.source || 'Source not recorded'}</p><p className="pg-path faint">{m.installLocation}</p><small className="faint">{m.lastUpdated ? `Updated ${ago(m.lastUpdated)}` : 'Update time not recorded'}</small>
            </article>)}
            <details className="pg-disclosure"><summary>Where Claude Code keeps this library</summary>
              {st.roots.map(r => <div className="pg-root" key={r.path}><strong>{r.label}</strong><span>{r.exists ? 'Present' : 'Not found'}</span><code>{r.path}</code></div>)}
            </details>
            {st.notes.map((note, i) => <Note key={i} tone="warn" role="none">{note}</Note>)}
          </section>
          <aside className="pg-add-market">
            <h2>Add a marketplace</h2><p>Paste a GitHub owner/repository, Git URL, or local directory. Claude Code will register this source for its plugin catalog.</p>
            <label className="pg-field"><span className="label">Marketplace source</span><input className="field" value={market} disabled={Boolean(working)} onChange={e => setMarket(e.target.value)} placeholder="owner/repository" /></label>
            <button className="btn btn-primary" disabled={locked || !market.trim()} onClick={() => void act('market-add', () => window.wanigan.plugins.marketAdd(market.trim()))}>{working === 'market-add' ? 'Adding…' : 'Add marketplace'}</button>
            <p className="faint">Wanigan asks you to confirm this source before it is added. Adding a marketplace does not install its plugins.</p>
          </aside>
        </div>
      ) : (
        <div className="pg-workspace">
          <section className="pg-library" aria-label={area === 'installed' ? 'Installed plugins' : 'Plugin catalog'}>
            <label className="pg-search"><span className="sr-only">Search plugins</span><input type="search" className="field" placeholder="Find a plugin or marketplace…" value={q} onChange={e => setQ(e.target.value)} /></label>
            {area === 'installed' && <label className="pg-filter"><span>Show</span><select className="field" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">All installed</option><option value="enabled">Enabled</option><option value="disabled">Disabled</option><option value="attention">Needs a look</option></select></label>}
            <div className="pg-library-meta"><span>{num(rows.length)} {area === 'catalog' ? 'available' : 'registered'}</span><span>{area === 'catalog' ? cat ? 'CLI catalog' : 'Local catalog' : 'Local scan'}</span></div>
            <div className="pg-entries" ref={listRef}>
              {rows.slice(0, 200).map(p => {
                const local = installed.find(item => item.id === p.id);
                const status = local ? ENABLEMENT[enablementOf(local.id, cat, local.enabledInSettings)] : null;
                return <button className={`pg-entry${p.id === selected?.id ? ' on' : ''}`} key={p.id} data-plugin-id={p.id} aria-pressed={p.id === selected?.id} onClick={() => setChosen(p.id)}>
                  <span className="pg-monogram" aria-hidden="true">{p.name.slice(0, 1).toUpperCase()}</span>
                  <span className="pg-entry-copy"><strong>{p.name}</strong><small>{p.marketplace}</small><span className="pg-entry-summary">{p.description || 'No description supplied.'}</span>
                    {local && !local.present ? <Mark glyph="!" word="Directory missing" tone="warn" /> : status ? <Mark {...status} /> : <span className="faint">{(p as CatalogItem).installed ? 'CLI reports installed' : 'Available to install'}</span>}
                  </span>
                </button>;
              })}
              {rows.length > 200 && <p className="pg-cue">Showing 200 of {num(rows.length)} matches. Refine your search to see the rest.</p>}
              {rows.length === 0 && <EmptyState posture="nothing-in-scope" title={query || filter !== 'all' && area === 'installed' ? 'No matching plugins' : area === 'installed' ? 'Room for a few new skills' : 'No catalog entries yet'} cue={area === 'installed' && !query && filter === 'all' ? 'Browse the catalog to see what Claude Code can add.' : 'Try another search, or refresh the catalog from the CLI.'} />}
            </div>
            {(q || filter !== 'all') && <button className="btn btn-sm" onClick={() => { setQ(''); setFilter('all'); }}>Clear filters</button>}
          </section>
          <section className="pg-inspector" ref={inspector} aria-label="Plugin details">
            <div className="pg-catalog-status">
              <span>{catBusy ? 'Reading the CLI catalog…' : catNote ? 'CLI unavailable. Using the local scan.' : cat ? 'Enablement read from the CLI.' : 'Enablement comes from account settings where recorded.'}</span>
              <button className="btn btn-sm" disabled={catBusy || Boolean(working)} onClick={() => void loadCatalog()}>{catBusy ? 'Reading…' : cat ? 'Refresh CLI catalog' : 'Ask the CLI'}</button>
            </div>
            {catNote && <Note tone="warn">{catNote}</Note>}
            {selected ? <div className="pg-selection" key={selectionKey}>
              <div className="pg-identity"><span className="pg-monogram pg-monogram-large" aria-hidden="true">{selected.name.slice(0, 1).toUpperCase()}</span><div><h2>{selected.name}</h2><p>{selected.marketplace}{plugin?.version && ` · ${plugin.version}`}</p></div></div>
              <p className="pg-description">{selected.description || 'This plugin has no description in its manifest.'}</p>
              {plugin && state && <>
                <div className="pg-enablement"><Mark {...ENABLEMENT[state]} /><p>{ENABLEMENT[state].blurb}</p></div>
                {!plugin.present && <Note tone="warn">The registered directory is missing. Its components cannot be read from this scan.</Note>}
                <div className="pg-actions">
                  {!['on', 'on-settings'].includes(state) && <button className="btn btn-primary" disabled={locked || !plugin.present} onClick={() => void act(plugin.id, () => window.wanigan.plugins.setEnabled(plugin.id, true))}>Enable plugin</button>}
                  {!['off', 'off-settings'].includes(state) && <button className="btn" disabled={locked} onClick={() => void act(plugin.id, () => window.wanigan.plugins.setEnabled(plugin.id, false))}>Disable plugin</button>}
                  <button className="btn" disabled={readBusy || Boolean(working)} onClick={() => showCost(plugin)}>Read context cost</button>
                  {plugin.hasReadme && <button className="btn" disabled={!plugin.present || readBusy} onClick={() => void read(plugin.name, () => window.wanigan.plugins.file(`${plugin.path}/README.md`))}>Readme</button>}
                </div>
                {Object.hasOwn(cost, plugin.id) && <p className="pg-cue">{cost[plugin.id] === null ? 'The CLI did not report an always-on token estimate.' : `~${num(cost[plugin.id]!)} estimated always-on tokens. Actual context depends on the session.`}</p>}
                {readBusy && <Reading what="plugin details" />}
                {readError && <Note tone="error" onDismiss={() => setReadError(null)}>{readError}</Note>}
                <SectionHead label="What it adds" count={plugin.skills.length + plugin.commands.length + plugin.agents.length} />
                <div className="pg-capabilities">
                  {[...plugin.skills, ...plugin.commands, ...plugin.agents].map(c => <button className="pg-component" key={`${c.kind}/${c.path}`} disabled={!plugin.present || readBusy} onClick={() => void read(c.name, () => window.wanigan.plugins.file(c.path))}><span>{c.kind}</span><strong>{c.name}</strong><span aria-hidden="true">↗</span></button>)}
                  {plugin.skills.length + plugin.commands.length + plugin.agents.length === 0 && <p className="pg-cue">No skills, commands, or agents in this scan.</p>}
                </div>
                <div className="pg-integrations"><div><SectionHead label="Hook events" count={plugin.hookEvents.length} /><p>{plugin.hookEvents.join(', ') || 'None recorded'}</p></div><div><SectionHead label="MCP servers" count={plugin.mcpServers.length} /><p>{plugin.mcpServers.join(', ') || 'None recorded'}</p></div></div>
                <details className="pg-disclosure"><summary>Installation details</summary><dl className="pg-facts"><dt>Scope</dt><dd>{plugin.scope}</dd><dt>Author</dt><dd>{plugin.author || 'Not recorded'}</dd><dt>Size</dt><dd>{kb(plugin.bytes)}</dd><dt>Updated</dt><dd>{plugin.lastUpdated ? ago(plugin.lastUpdated) : 'Not recorded'}</dd><dt>Directory</dt><dd className="pg-path">{plugin.path}</dd></dl></details>
              </>}
              {offer && <div className="pg-source"><SectionHead label="Recorded origin" /><p>{origin(offer.source, offer.marketplace)}</p>
                {!plugin && !offer.installed && !confirming && <button className="btn btn-primary" disabled={locked} onClick={() => setConfirming(offer)}>Review installation</button>}
                {!plugin && offer.installed && <Note tone="info">The CLI reports this plugin installed. Rescan to read its local components.</Note>}
              </div>}
              {confirming && confirming.id === selected.id && <Note tone="warn" role="none">
                <strong>Install {confirming.name}?</strong><p>A plugin may include hooks, MCP servers, or an LSP that runs code on this machine.</p>
                <p>{origin(confirming.source, confirming.marketplace)}</p>
                <p>Installation uses the CLI’s -y option, accepting any marketplace-declared install command. This confirmation is that prompt.</p>
                <div className="pg-actions"><button className="btn btn-primary" disabled={locked} onClick={() => void act(confirming.id, () => window.wanigan.plugins.install(confirming.id))}>{working === confirming.id ? 'Installing…' : `Install ${confirming.name}`}</button><button className="btn" disabled={Boolean(working)} onClick={() => setConfirming(null)}>Cancel</button></div>
              </Note>}
            </div> : <EmptyState posture="nothing-in-scope" title="Choose a plugin" cue="Its components, configuration, and recorded origin will appear here." />}
          </section>
        </div>
      )}
      {reading && (
        <ReaderDialog title={reading.title} text={reading.text} truncated={reading.truncated} onClose={() => setReading(null)} />
      )}
    </div>
  );
}

function ReaderDialog({ title, text, truncated, onClose }: { title: string; text: string; truncated: boolean; onClose: () => void }) {
  const { portal, backdropProps, dialogProps } = useDialog<HTMLDivElement>({ onClose, initialFocus: 'least-destructive' });
  return portal(
    <div {...backdropProps} className="overlay-backdrop pg-reader">
      <div {...dialogProps} className="pg-reader-in" aria-label={title}>
        <div className="pg-reader-h"><strong>{title}</strong>{truncated && <span className="faint">Truncated at 200 KB</span>}<button className="btn" onClick={onClose}>Close</button></div>
        <div className="pg-reader-b" tabIndex={0}>{text}</div>
      </div>
    </div>,
  );
}
