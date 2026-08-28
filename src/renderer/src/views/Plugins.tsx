import { useCallback, useEffect, useMemo, useState } from 'react';
import { Note, Stat, ago, num } from '../components/bits';

/* Shapes mirror src/main/plugins.ts; the renderer cannot import from main. */
type Component = { kind: 'skill' | 'command' | 'agent'; name: string; path: string };
type Installed = {
  id: string; name: string; marketplace: string; version: string; scope: string;
  installedAt: number | null; lastUpdated: number | null; path: string;
  description: string | null; author: string | null; homepage: string | null;
  skills: Component[]; commands: Component[]; agents: Component[];
  hookEvents: string[]; mcpServers: string[]; hasReadme: boolean; present: boolean; bytes: number;
};
type Available = { id: string; name: string; marketplace: string; description: string | null; installed: boolean; path: string };
type CatalogItem = { id: string; name: string; marketplace: string; description: string; installed: boolean; enabled: boolean; source: string | null };
type Action = { ok: boolean; output: string; error: string | null };
type Market = { name: string; source: string; installLocation: string; lastUpdated: number | null; present: boolean };
type State = {
  installed: Installed[]; available: Available[]; marketplaces: Market[];
  roots: { label: string; path: string; exists: boolean }[]; notes: string[]; scannedAt: number;
};

const kb = (b: number) => (b < 1024 ? `${b} B` : b < 1048576 ? `${Math.round(b / 1024)} KB` : `${(b / 1048576).toFixed(1)} MB`);

export default function Plugins() {
  const [st, setSt] = useState<State | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [q, setQ] = useState('');
  const [showCatalog, setShowCatalog] = useState(false);
  const [reading, setReading] = useState<{ title: string; text: string; truncated: boolean } | null>(null);
  const [cat, setCat] = useState<CatalogItem[] | null>(null);
  const [catNote, setCatNote] = useState<string | null>(null);
  const [catBusy, setCatBusy] = useState(false);
  const [confirming, setConfirming] = useState<CatalogItem | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [result, setResult] = useState<{ id: string; ok: boolean; text: string } | null>(null);
  const [cost, setCost] = useState<Record<string, number | null>>({});
  const [market, setMarket] = useState('');

  const load = useCallback(async (refresh = false) => {
    setBusy(true);
    try {
      setSt(refresh ? await window.wanigan.plugins.refresh() : await window.wanigan.plugins.list());
      setErr(null);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function read(c: Component) {
    try {
      const f = await window.wanigan.plugins.file(c.path);
      setReading({ title: c.name, text: f.text, truncated: f.truncated });
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }

  // 285 in the real catalog against the 54 cloned to disk — the CLI knows the
  // full index, so it is fetched on demand rather than guessed from the tree.
  const loadCatalog = useCallback(async () => {
    setCatBusy(true);
    try {
      const r = await window.wanigan.plugins.catalog();
      setCat(r.plugins as CatalogItem[]);
      setCatNote(r.note);
    } catch (e) { setCatNote(e instanceof Error ? e.message : String(e)); }
    finally { setCatBusy(false); }
  }, []);

  async function act(id: string, fn: () => Promise<Action>) {
    setWorking(id); setResult(null);
    try {
      const r = await fn();
      setResult({ id, ok: r.ok, text: r.ok ? (r.output || 'Done.') : (r.error ?? 'It failed.') });
      await load(true);
      if (cat) await loadCatalog();
    } catch (e) { setResult({ id, ok: false, text: e instanceof Error ? e.message : String(e) }); }
    finally { setWorking(null); setConfirming(null); }
  }

  async function showCost(name: string) {
    setCost((c) => ({ ...c, [name]: c[name] ?? null }));
    try {
      const d = await window.wanigan.plugins.details(name);
      setCost((c) => ({ ...c, [name]: d.alwaysOnTokens }));
      if (d.text) setReading({ title: `${name} — inventory and cost`, text: d.text, truncated: false });
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }

  const catalog = useMemo(() => {
    const s = q.trim().toLowerCase();
    const rows: CatalogItem[] = cat ?? (st?.available ?? []).map((a) => ({
      id: a.id, name: a.name, marketplace: a.marketplace,
      description: a.description ?? '', installed: a.installed, enabled: false, source: null,
    }));
    if (!s) return rows;
    return rows.filter((a) => a.name.toLowerCase().includes(s) || a.description.toLowerCase().includes(s));
  }, [st, cat, q]);

  if (err && !st) {
    return (
      <div className="pg-wrap">
        <Note tone="error">{err}</Note>
        <button className="btn" style={{ marginTop: 10 }} onClick={() => void load(true)}>Try again</button>
      </div>
    );
  }
  if (!st) return <div className="pg-wrap"><p className="dim">Reading your plugins…</p></div>;

  const missing = st.installed.filter((p) => !p.present);

  return (
    <div className="pg-wrap">
      <div className="pg-head">
        <h1>Plugins</h1>
        <span className="pg-count">{st.installed.length} installed · {st.available.length} in the catalog</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button className="btn" disabled={busy} onClick={() => void load(true)}>
            {busy ? 'Scanning…' : 'Rescan'}
          </button>
        </div>
      </div>

      {/* The distinction the directory layout makes easy to get wrong. */}
      {st.notes.map((n, i) => (
        <div key={i} style={{ marginTop: 8 }}><Note tone="info">{n}</Note></div>
      ))}
      {missing.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <Note tone="warn">
            <span aria-hidden="true">⚠ </span>
            {missing.length} registered plugin{missing.length > 1 ? 's are' : ' is'} missing from disk
            ({missing.map((p) => p.name).join(', ')}). Claude Code skips {missing.length > 1 ? 'them' : 'it'} silently.
          </Note>
        </div>
      )}

      <div className="stat-grid" style={{ marginTop: 12 }}>
        <Stat label="Installed" value={num(st.installed.length)} sub={`${st.marketplaces.length} marketplace${st.marketplaces.length === 1 ? '' : 's'}`} />
        <Stat label="Skills" value={num(st.installed.reduce((a, p) => a + p.skills.length, 0))} sub="from plugins" />
        <Stat label="Commands" value={num(st.installed.reduce((a, p) => a + p.commands.length, 0))} sub="slash commands" />
        <Stat label="Hooks" value={num(st.installed.reduce((a, p) => a + p.hookEvents.length, 0))}
              sub="events plugins register"
              tone={st.installed.some((p) => p.hookEvents.length) ? 'var(--warning)' : undefined} />
      </div>

      <div className="pg-sec">
        <div className="pg-sec-h"><h2>Installed</h2><span className="n">{st.installed.length}</span></div>
        {st.installed.length === 0 ? (
          <p className="dim" style={{ maxWidth: '62ch', lineHeight: 1.55 }}>
            No plugins installed. The catalog below lists what the marketplaces offer —
            install one with <span className="mono">/plugin install &lt;name&gt;</span> in any session.
          </p>
        ) : (
          <div className="pg-grid">
            {st.installed.map((p) => {
              const items = [...p.skills, ...p.commands, ...p.agents];
              const isOpen = open[p.id];
              return (
                <article key={p.id} className={`pg-card${p.present ? '' : ' gone'}`}>
                  <div className="pg-top">
                    <span className="pg-name">{p.name}</span>
                    <span className="pg-ver mono">{p.version}</span>
                  </div>
                  {p.description
                    ? <p className="pg-desc">{p.description}</p>
                    : <p className="pg-none">No manifest — this plugin ships no plugin.json, which is allowed.</p>}

                  <div className="pg-provides">
                    {p.skills.length > 0 && <span className="pg-chip"><b>{p.skills.length}</b> skills</span>}
                    {p.commands.length > 0 && <span className="pg-chip"><b>{p.commands.length}</b> commands</span>}
                    {p.agents.length > 0 && <span className="pg-chip"><b>{p.agents.length}</b> agents</span>}
                    {/* Hooks run code on your machine — worth seeing without expanding. */}
                    {p.hookEvents.length > 0 && (
                      <span className="pg-chip hook" title={p.hookEvents.join(', ')}>
                        <span aria-hidden="true">⚑</span> hooks: {p.hookEvents.join(', ')}
                      </span>
                    )}
                    {p.mcpServers.length > 0 && (
                      <span className="pg-chip mcp">MCP: {p.mcpServers.join(', ')}</span>
                    )}
                    {items.length === 0 && p.hookEvents.length === 0 && p.mcpServers.length === 0 && (
                      <span className="pg-none">Provides nothing Wanigan can see from disk.</span>
                    )}
                  </div>

                  {items.length > 0 && (
                    <button className="pg-expand" aria-expanded={!!isOpen}
                            onClick={() => setOpen((o) => ({ ...o, [p.id]: !o[p.id] }))}>
                      {isOpen ? '▾ hide what it provides' : `▸ show ${items.length} item${items.length > 1 ? 's' : ''}`}
                    </button>
                  )}
                  {isOpen && (
                    <div className="pg-items">
                      {items.map((c) => (
                        <button key={c.path} className="pg-item" onClick={() => void read(c)}
                                title={`Open ${c.path}`}>
                          <span className="k">{c.kind}</span>
                          <span className="n mono">{c.name}</span>
                        </button>
                      ))}
                    </div>
                  )}

                  <div className="pg-meta" style={{ marginTop: 'auto' }}>
                    <span>{p.marketplace}</span>
                    <span>{p.scope}</span>
                    {p.author && <span>{p.author}</span>}
                    {p.present && <span>{kb(p.bytes)}</span>}
                    <span>{p.lastUpdated ? `updated ${ago(p.lastUpdated)}` : 'no date'}</span>
                    {!p.present && <span style={{ color: 'var(--warning)' }}>✕ missing</span>}
                    {cost[p.name] != null && (
                      <span style={{ color: 'var(--accent)' }}>~{num(cost[p.name] as number)} tok every session</span>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <button className="btn" style={{ fontSize: 11.5, padding: '3px 9px' }}
                            disabled={working === p.id}
                            onClick={() => void act(p.id, () => window.wanigan.plugins.setEnabled(p.id, false))}>
                      {working === p.id ? 'working…' : 'Disable'}
                    </button>
                    <button className="btn" style={{ fontSize: 11.5, padding: '3px 9px' }}
                            title="What this plugin adds to every session's context"
                            onClick={() => void showCost(p.name)}>Cost</button>
                    {p.hasReadme && (
                      <button className="btn" style={{ fontSize: 11.5, padding: '3px 9px' }}
                              onClick={() => void read({ kind: 'skill', name: `${p.name} readme`, path: `${p.path}/README.md` })}>
                        Readme
                      </button>
                    )}
                  </div>
                  {result && result.id === p.id && (
                    <Note tone={result.ok ? 'ok' : 'error'}>{result.text.slice(0, 400)}</Note>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </div>

      <div className="pg-sec">
        <div className="pg-sec-h">
          <h2>Catalog</h2>
          <span className="n">{st.available.length} available</span>
          <button className="pg-expand" style={{ marginLeft: 'auto' }}
                  aria-expanded={showCatalog}
                  onClick={() => { const v = !showCatalog; setShowCatalog(v); if (v && !cat) void loadCatalog(); }}>
            {showCatalog ? '▾ hide' : '▸ search and install'}
          </button>
        </div>
        {showCatalog && (
          <>
            <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
              <input className="field" style={{ flex: 1, minWidth: 220 }} value={q} type="text"
                     placeholder={catBusy ? 'Reading the catalog…' : `Search ${catalog.length} plugins…`}
                     onChange={(e) => setQ(e.target.value)} />
              <button className="btn" disabled={catBusy} onClick={() => void loadCatalog()}>
                {catBusy ? 'Loading…' : 'Refresh'}
              </button>
              <button className="btn" disabled={!!working}
                      onClick={() => void act('__market', () => window.wanigan.plugins.marketUpdate())}>
                Update marketplaces
              </button>
            </div>
            <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
              <input className="field" style={{ flex: 1 }} value={market} type="text"
                     placeholder="Add a marketplace — a GitHub repo, URL or path"
                     onChange={(e) => setMarket(e.target.value)} />
              <button className="btn" disabled={!market.trim() || !!working}
                      onClick={() => void act('__market', () => window.wanigan.plugins.marketAdd(market.trim()))}>Add</button>
            </div>
            {catNote && <div style={{ marginBottom: 10 }}><Note tone="warn">{catNote}</Note></div>}
            {result && result.id === '__market' && (
              <div style={{ marginBottom: 10 }}>
                <Note tone={result.ok ? 'ok' : 'error'}>{result.text.slice(0, 500)}</Note>
              </div>
            )}
            {confirming && (
              <div style={{ marginBottom: 10 }}>
                <Note tone="warn">
                  <strong>Install {confirming.name}?</strong> A plugin can ship hooks, an MCP server or an LSP —
                  code that runs on this machine. Wanigan has no terminal to answer the CLI's own prompt, so it
                  passes <span className="mono">-y</span>, which accepts the marketplace-declared install command
                  on your behalf. This dialog is that prompt.
                  <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                    <button className="btn btn-primary" disabled={!!working}
                            onClick={() => void act(confirming.id, () => window.wanigan.plugins.install(confirming.id))}>
                      {working ? 'Installing…' : `Install ${confirming.name}`}
                    </button>
                    <button className="btn" onClick={() => setConfirming(null)}>Cancel</button>
                  </div>
                </Note>
              </div>
            )}
            {catalog.length === 0 ? (
              <p className="faint">Nothing in the catalog matches “{q}”.</p>
            ) : (
              <div className="pg-cat">
                {catalog.slice(0, 200).map((a) => (
                  <div key={a.id} className="pg-cat-row">
                    <div className="t">
                      <span>{a.name}</span>
                      {a.installed
                        ? <span className="pg-yes">✓ {a.enabled ? 'installed' : 'disabled'}</span>
                        : (
                          <button className="btn" style={{ marginLeft: 'auto', fontSize: 11, padding: '2px 8px' }}
                                  disabled={!!working}
                                  onClick={() => setConfirming(a)}>Install</button>
                        )}
                    </div>
                    {a.description && <div className="d">{a.description}</div>}
                    {result && result.id === a.id && (
                      <div className="d" style={{ color: result.ok ? 'var(--good)' : 'var(--bad)' }}>
                        {result.text.slice(0, 200)}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
            {catalog.length > 200 && (
              <p className="faint" style={{ marginTop: 8 }}>
                Showing 200 of {num(catalog.length)}. Narrow the search rather than scrolling.
              </p>
            )}
          </>
        )}
      </div>

      <div className="pg-sec">
        <div className="pg-sec-h"><h2>Where this comes from</h2></div>
        <table className="viz-table">
          <tbody>
            {st.roots.map((r) => (
              <tr key={r.path}>
                <td style={{ width: 90 }}>{r.label}</td>
                <td className="mono" style={{ fontSize: 11 }}>{r.path}</td>
                <td className="n" style={{ width: 70 }}>
                  {r.exists ? <span style={{ color: 'var(--good)' }}>✓ found</span>
                            : <span className="faint">absent</span>}
                </td>
              </tr>
            ))}
            {st.marketplaces.map((m) => (
              <tr key={m.name}>
                <td>marketplace</td>
                <td className="mono" style={{ fontSize: 11 }}>{m.name} — {m.source}</td>
                <td className="n" style={{ width: 70 }}>{m.lastUpdated ? ago(m.lastUpdated) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {reading && (
        <div className="pg-reader" role="dialog" aria-modal="true" aria-label={reading.title}
             onMouseDown={(e) => { if (e.target === e.currentTarget) setReading(null); }}>
          <div className="pg-reader-in">
            <div className="pg-reader-h">
              <strong style={{ fontSize: 14 }}>{reading.title}</strong>
              {reading.truncated && <span className="faint" style={{ fontSize: 11 }}>truncated at 200 KB</span>}
              <button className="btn" style={{ marginLeft: 'auto' }} onClick={() => setReading(null)}>Close</button>
            </div>
            <div className="pg-reader-b">{reading.text}</div>
          </div>
        </div>
      )}
    </div>
  );
}
