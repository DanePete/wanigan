import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentAccount, DocketNode, DocketNodeKind, Project, ProviderInfo, RelayForecast, RelayRead, RelayRouteInput,
  SessionEvent, WorkDocket, RelayPreview,
} from '@shared/types';
import { DEFAULT_FILL, DEFAULT_SPACING, rigLayout } from '@shared/relay-rig';
import { SEDIMENT_CAP } from '@shared/relay';
import { ConfirmNote, Hint, Note, PageHead, Section, SectionHead, Stat, dur, usd } from '../components/bits';
import { DEFAULT_MIN_CONFIDENCE } from '@shared/relay-route';
import { AGENT_KINDS, KIND_WORD, grainCounts, phasesOf, returnOn, type Phase } from '../relay/facts';
import { rigShapes, tagPlacement } from '../relay/rig-svg';
import { useFluidTier } from '../relay/useFluidTier';
import { mountFluid, type FluidMount } from '../relay/fluid';
import '../styles/relay.css';

/**
 * Relay — one intent, five phases, and the water that runs between them.
 *
 * The rail is a rig: five open vessels with funnel floors stacked down the
 * page, each with a gated drain into a pipe that feeds the next. What the rig
 * SAYS — which phase is live, whether its gate is open, how fast it breathes,
 * how much silt is on its floor, the one word in its pill — is derived in
 * `relay/facts.ts` from recorded rows and nothing else. What it LOOKS like is
 * one of three tiers decided by `useFluidTier`: the companion's solver
 * against the rig (the fluid module), the rig's own animated level, or every
 * value with no movement. Exactly one draws the water.
 *
 * Nothing here moves because time passed. A gate opens on a recorded status;
 * a grain settles on a recorded tool call; a level breathes at a measured
 * interval and stops when the interval does. The first read establishes a
 * baseline and animates nothing, so opening the view never replays history.
 *
 * Geometry reaches the stylesheet through custom properties written on refs
 * — the channel the spec keeps for measured values — never an inline style.
 */

type Props = {
  projects: Project[];
  projectId: string | null;
  providers: ProviderInfo[];
  openSession: (id: string) => void;
  openGoal: (id: string, taskId?: string) => void;
};

/** How often the rail re-reads its docket; Board's cadence, for the same reason. */
const POLL_MS = 5_000;
/** How often the cadence is re-judged against the clock between reads. */
const CLOCK_MS = 2_000;
/** Completions kept per node between reads. Main keeps the durable record. */
const EXTRA_CAP = 64;
/** The vessel a hand-back pours back into. */
const RETURN_INTO = 2;

const PHASE_KINDS: readonly DocketNodeKind[] = ['plan', 'estimate', 'implement', 'verify', 'review'];

/**
 * '' means "whatever the relay says"; INHERIT_NONE is the operator saying this
 * one stage resolves its account the ordinary way even though the relay pinned
 * one. Two different intentions that a single empty string cannot carry.
 */
const INHERIT_NONE = '\u0000none';

type RouteDraft = Record<string, { providerId: string; model: string; effort: string; accountId: string }>;

const emptyDraft = (providerId: string): RouteDraft =>
  Object.fromEntries(AGENT_KINDS.map((kind) => [kind, { providerId, model: '', effort: '', accountId: '' }]));

function toRoutes(draft: RouteDraft, fallback: string): RelayRouteInput {
  const routes: RelayRouteInput = {};
  for (const kind of AGENT_KINDS) {
    const row = draft[kind];
    if (!row) continue;
    const entry: { providerId?: string; model?: string; effort?: string; accountId?: string | null } = {};
    if (row.providerId && row.providerId !== fallback) entry.providerId = row.providerId;
    // null is sent deliberately: it is the one way to say "not the relay's
    // account" without naming a different one.
    if (row.accountId === INHERIT_NONE) entry.accountId = null;
    else if (row.accountId) entry.accountId = row.accountId;
    if (row.model.trim()) entry.model = row.model.trim();
    if (row.effort.trim()) entry.effort = row.effort.trim();
    if (Object.keys(entry).length) routes[kind] = entry;
  }
  return routes;
}

function theme(): 'dark' | 'light' {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

export default function Relay({ projects, projectId, providers, openSession, openGoal }: Props) {
  const rig = useMemo(() => rigLayout(PHASE_KINDS.length), []);
  const shapes = useMemo(() => rigShapes(rig, RETURN_INTO), [rig]);
  const tier = useFluidTier();

  const [relays, setRelays] = useState<WorkDocket[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [read, setRead] = useState<RelayRead | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [intent, setIntent] = useState('');
  /** What the suggester would do with this intent. Cleared the moment the intent or profile changes, because a stale guess is a wrong one. */
  const [preview, setPreview] = useState<RelayPreview | null>(null);
  const [providerId, setProviderId] = useState<string>(providers[0]?.id ?? '');
  const [draft, setDraft] = useState<RouteDraft>(() => emptyDraft(providers[0]?.id ?? ''));
  const [accountId, setAccountId] = useState('');
  const [accountOptions, setAccountOptions] = useState<AgentAccount[] | null>(null);
  const [extras, setExtras] = useState<Record<string, number[]>>({});
  const [clock, setClock] = useState(() => Date.now());
  const [holdDismissed, setHoldDismissed] = useState<string | null>(null);

  const rigEl = useRef<HTMLDivElement>(null);
  const canvasEl = useRef<HTMLCanvasElement>(null);
  const tagEls = useRef<(HTMLDivElement | null)[]>([]);
  const levelEls = useRef<(SVGPathElement | null)[]>([]);
  const fluid = useRef<FluidMount | null>(null);
  const frame = useRef(0);
  const baseline = useRef<Record<string, number>>({});
  const baselineFor = useRef<string | null>(null);
  const sessionIndex = useRef<Map<string, number>>(new Map());

  const project = projects.find((p) => p.id === projectId) ?? null;

  /* ── reads ──────────────────────────────────────────────────────────── */

  const loadList = useCallback(async () => {
    if (!projectId) { setRelays([]); return; }
    try {
      const rows = await window.wanigan.relay.list(projectId, 50);
      setRelays(rows);
      setSelected((cur) => cur && rows.some((r) => r.id === cur) ? cur : (rows[0]?.id ?? null));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [projectId]);

  const loadRead = useCallback(async () => {
    if (!selected) { setRead(null); return; }
    try {
      const next = await window.wanigan.relay.read(selected);
      // The first read of a relay is the baseline: its grains are already on
      // the floor, and nothing that was true before the view opened animates.
      if (baselineFor.current !== selected) {
        baseline.current = grainCounts(next);
        baselineFor.current = selected;
      }
      setRead(next);
      setExtras({});
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [selected]);

  useEffect(() => { void loadList(); }, [loadList]);
  useEffect(() => { void loadRead(); }, [loadRead]);

  useEffect(() => {
    const again = () => { if (!document.hidden) void loadRead(); };
    const timer = setInterval(again, POLL_MS);
    document.addEventListener('visibilitychange', again);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', again); };
  }, [loadRead]);

  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), CLOCK_MS);
    return () => clearInterval(timer);
  }, []);

  /* ── the facts ─────────────────────────────────────────────────────── */

  const phases: Phase[] = useMemo(() => (read ? phasesOf(read, extras, clock) : []), [read, extras, clock]);

  useEffect(() => {
    const map = new Map<string, number>();
    for (const phase of phases) if (phase.node.sessionId) map.set(phase.node.sessionId, phase.index);
    sessionIndex.current = map;
  }, [phases]);

  // A completed tool call between reads: one more grain, one impulse. Main
  // keeps the durable list; this is only what arrived since the last read.
  useEffect(() => {
    const off = window.wanigan.on.sessionEvent((event: SessionEvent) => {
      if (event.event !== 'PostToolUse') return;
      const index = sessionIndex.current.get(event.sessionId);
      if (index === undefined) return;
      const nodeId = phases[index]?.node.id;
      if (!nodeId) return;
      setExtras((cur) => {
        const list = [...(cur[nodeId] ?? []), event.at].slice(-EXTRA_CAP);
        return { ...cur, [nodeId]: list };
      });
      fluid.current?.impulse(index, event.id);
    });
    return () => { off(); };
  }, [phases]);

  /* ── geometry into the stylesheet, on refs ──────────────────────────── */

  useEffect(() => {
    const el = rigEl.current;
    if (!el) return;
    el.style.setProperty('--rl-w', String(rig.width));
    el.style.setProperty('--rl-h', String(rig.height));
    tagEls.current.forEach((tag, i) => {
      if (tag) tag.style.setProperty('--rl-y', String(tagPlacement(rig, i).y));
    });
  }, [rig, phases.length]);

  // The level breathes only while a cadence was measured, at that period.
  useEffect(() => {
    levelEls.current.forEach((level, i) => {
      if (!level) return;
      const phase = phases[i];
      if (phase && phase.cadence.kind === 'swelling' && tier.tier === 'simple') {
        level.dataset.flow = 'live';
        level.style.setProperty('--mo-period', `${Math.round(phase.cadence.periodMs)}ms`);
      } else {
        delete level.dataset.flow;
        level.style.removeProperty('--mo-period');
      }
    });
  }, [phases, tier.tier]);

  /* ── the fluid tier ────────────────────────────────────────────────── */

  // Mount once per relay and tier: a new relay is a new body of water, a tier
  // change is a new mount. `hasRead` rather than `read` so a poll that returns
  // the same docket does not tear the water down and pour it again.
  const hasRead = read !== null;
  useEffect(() => {
    const canvas = canvasEl.current;
    if (tier.tier !== 'fluid' || !canvas || !hasRead) return;
    const mount = mountFluid(canvas, rig, { spacing: DEFAULT_SPACING, fill: DEFAULT_FILL });
    if (!mount) return;
    fluid.current = mount;
    const loop = (now: number) => {
      mount.tick(now, theme());
      frame.current = requestAnimationFrame(loop);
    };
    frame.current = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(frame.current);
      mount.dispose();
      fluid.current = null;
    };
  }, [tier.tier, rig, selected, hasRead]);

  useEffect(() => {
    const mount = fluid.current;
    if (!mount) return;
    phases.forEach((phase) => mount.setGate(phase.index, phase.gateOpen));
  }, [phases]);

  /* ── actions ───────────────────────────────────────────────────────── */

  const act = useCallback(async (key: string, run: () => Promise<void>) => {
    setBusy(key);
    try { await run(); setError(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(null); }
  }, []);

  // The accounts this profile could actually launch as, from the same call the
  // New session dialog uses. A profile whose harness has no switchable
  // configuration directory answers with none, and the picker says so rather
  // than offering a choice that cannot be honoured.
  useEffect(() => {
    if (!providerId) { setAccountOptions([]); return; }
    let live = true;
    setAccountOptions(null);
    void window.wanigan.accounts.listForProvider(providerId)
      .then((rows) => { if (live) setAccountOptions(rows); })
      .catch(() => { if (live) setAccountOptions([]); });
    return () => { live = false; };
  }, [providerId]);

  // A press, never a keystroke: when the suggester is on this spends. The
  // guess it returns fills the placeholders below as a guess — the fields stay
  // empty, so Start relay sends no operator choice unless you type one, and
  // the relay records the route as suggested rather than chosen.
  const suggest = () => act('preview', async () => {
    setPreview(await window.wanigan.relay.preview({ intent: intent.trim(), providerId, routes: toRoutes(draft, providerId) }));
  });

  const guessFor = (kind: DocketNodeKind, field: 'model' | 'effort'): string => {
    const g = preview?.routes[kind];
    if (!g) return 'profile default';
    const value = g.route[field];
    if (!value) return 'profile default';
    return g.route.source === 'suggested' && g.route.confidence !== null
      ? `${value} — suggested, ${g.route.confidence.toFixed(2)}`
      : `${value} — profile default`;
  };

  const create = () => act('create', async () => {
    if (!projectId) throw new Error('Choose a project before starting a relay.');
    const next = await window.wanigan.relay.create({
      projectId, intent: intent.trim(), providerId, routes: toRoutes(draft, providerId),
      accountId: accountId || undefined,
    });
    setIntent('');
    setPreview(null);
    await loadList();
    setSelected(next.docket.id);
  });

  const startPhase = (node: DocketNode) => act(`start-${node.id}`, async () => {
    const provider = node.providerId ?? providerId;
    await window.wanigan.control.start(node.id, {
      providerId: provider, model: node.model ?? undefined, effort: undefined,
    });
    await loadRead();
  });

  const runEstimate = () => act('estimate', async () => {
    if (!selected) return;
    const next = await window.wanigan.relay.estimate(selected);
    setRead(next);
  });

  const decide = (node: DocketNode, decision: 'approve' | 'request_changes' | 'reject') =>
    act(`decide-${node.id}-${decision}`, async () => {
      await window.wanigan.control.complete(node.id, { decision });
      await loadRead();
    });

  /* ── derived surface state ─────────────────────────────────────────── */

  const byKind = (kind: DocketNodeKind) => phases.find((p) => p.node.kind === kind) ?? null;
  const plan = byKind('plan'), estimate = byKind('estimate'), implement = byKind('implement'), review = byKind('review');
  const forecast: RelayForecast | null = read?.forecast ?? null;
  const returnLineOn = returnOn(phases);
  const holdKey = read ? `${read.docket.id}:${implement?.node.status ?? ''}` : null;
  const holdOpen = !!(read && estimate?.node.status === 'completed' && implement?.node.status !== 'running'
    && implement?.node.status !== 'completed' && holdDismissed !== holdKey);

  /* ── render ────────────────────────────────────────────────────────── */

  return (
    <main className="pane">
      <PageHead
        eyebrow={project ? project.name : 'No project'}
        title="Relay"
        lead="One intent, five phases, and the handoffs between them. Each phase runs on its own profile; the water runs between them when a phase lets go."
      />
      {error && <Note tone="warn" onDismiss={() => setError(null)}>{error}</Note>}

      <div className="row2">
        <div>
          <SectionHead label="The sluice" right={
            <span className="rl-tier" data-rl-tier={tier.tier}>
              <i className="rl-tier-dot" aria-hidden="true" />
              {tier.tier === 'fluid' ? 'Fluid module' : tier.tier === 'simple' ? 'Animated level' : 'Every value, no movement'}
            </span>
          } />
          {!read && (
            <Hint>{relays.length ? 'Choose a relay to watch.' : 'No relay yet for this project. Start one on the right.'}</Hint>
          )}
          <div className="rl-rig" ref={rigEl} data-rl-tier={tier.tier}>
            <svg viewBox={shapes.viewBox} xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              {shapes.basins.map((b, i) => (
                <g key={i}>
                  <path className="rl-vessel" d={b.vessel} />
                  <path
                    className="rl-level"
                    d={b.level}
                    data-rl-on={phases[i]?.live ? 'true' : 'false'}
                    ref={(el) => { levelEls.current[i] = el; }}
                  />
                  <path className="rl-wall" d={b.wall} />
                  {b.pipe && <rect className="rl-vessel" x={b.pipe.x} y={b.pipe.y} width={b.pipe.width} height={b.pipe.height} />}
                  <path className="rl-wall-soft" d={b.pipeWall} />
                  {b.stream && (
                    <rect className="rl-stream" x={b.stream.x} y={b.stream.y} width={b.stream.width} height={b.stream.height}
                      data-rl-on={phases[i]?.streamOn ? 'true' : 'false'} />
                  )}
                  <rect className="rl-gate" x={b.gate.x} y={b.gate.y} width={b.gate.width} height={b.gate.height} rx={b.gate.rx}
                    data-rl-open={phases[i]?.gateOpen ? 'true' : 'false'} />
                </g>
              ))}
              <path className="rl-return" d={shapes.returnLine} data-rl-on={returnLineOn ? 'true' : 'false'} />
            </svg>
            <canvas ref={canvasEl} hidden={tier.tier !== 'fluid'} aria-hidden="true" />
            <div className="rl-hud">
              {PHASE_KINDS.map((kind, i) => {
                const phase = phases[i];
                const grains = phase ? Math.min(phase.sediment.grains, SEDIMENT_CAP) : 0;
                const before = phase ? (baseline.current[phase.node.id] ?? 0) : 0;
                return (
                  <div key={kind} className="rl-tag" ref={(el) => { tagEls.current[i] = el; }}>
                    <span className="rl-tag-name">{KIND_WORD[kind]}</span>
                    <span className="rl-tag-route">{phase?.routeText ?? ''}</span>
                    {phase?.gauge && <progress value={phase.gauge.value} max={phase.gauge.max} aria-label={`${KIND_WORD[kind]} steps`} />}
                    {phase && AGENT_KINDS.includes(kind) && (
                      <span className="rl-tag-grains">{phase.completed} tool call{phase.completed === 1 ? '' : 's'}</span>
                    )}
                    {phase && <span className="rl-tag-state" data-rl-v={phase.state.value}>{phase.state.word}</span>}
                    {phase && AGENT_KINDS.includes(kind) && grains > 0 && (
                      <div className="rl-silt" data-rl-seed={phase.seed} aria-hidden="true">
                        {Array.from({ length: grains }, (_, g) => (
                          <i key={g} className="rl-grain" data-rl-i={g} data-rl-arrived={g < before ? 'before' : 'now'} />
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div>
          <Section n={1} title="Start a relay" hint="The planner proposes, the forecast prices it, and you decide before anything is built.">
            <label>
              <span className="label">What should this relay accomplish?</span>
              <textarea className="field" aria-label="What should this relay accomplish" value={intent}
                onChange={(e) => { setIntent(e.target.value); setPreview(null); }} rows={3}
                placeholder="First line becomes the title. Say what done looks like." disabled={busy !== null} />
            </label>
            <label>
              <span className="label">Profile</span>
              <select className="field" aria-label="Profile for this relay" value={providerId}
                onChange={(e) => {
                  setProviderId(e.target.value);
                  setDraft(emptyDraft(e.target.value)); setPreview(null);
                  // The account belonged to the old profile's harness; keeping
                  // it would offer a pin the new one cannot honour.
                  setAccountId('');
                }} disabled={busy !== null}>
                {providers.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            </label>
            {/* Which account pays. Five phases start hours apart, so leaving
                this to whatever the project defaults to by then is how a relay
                bills an account nobody chose — under a forecast whose whole
                purpose is knowing the cost first. */}
            {accountOptions === null ? (
              <p className="faint">Reading the accounts this profile can use…</p>
            ) : accountOptions.length === 0 ? (
              <Hint>This profile’s harness has no configuration directory Wanigan can switch, so every phase runs on the credential it already has.</Hint>
            ) : (
              <label>
                <span className="label">Account</span>
                <select className="field" aria-label="Account every phase of this relay launches as" value={accountId}
                  onChange={(e) => setAccountId(e.target.value)} disabled={busy !== null}>
                  <option value="">This project’s account, then the default</option>
                  {accountOptions.map((row) => (
                    <option key={row.id} value={row.id}>{row.label}{row.isDefault ? ' (default)' : ''}</option>
                  ))}
                </select>
              </label>
            )}
            {AGENT_KINDS.map((kind) => (
              <div key={kind} className="row2">
                <label>
                  <span className="label">{KIND_WORD[kind]} model</span>
                  <input className="field" aria-label={`${KIND_WORD[kind]} model override`} value={draft[kind]?.model ?? ''}
                    onChange={(e) => setDraft((d) => ({ ...d, [kind]: { ...d[kind], model: e.target.value } }))}
                    placeholder={guessFor(kind, 'model')} disabled={busy !== null} />
                </label>
                <label>
                  <span className="label">{KIND_WORD[kind]} effort</span>
                  <input className="field" aria-label={`${KIND_WORD[kind]} effort override`} value={draft[kind]?.effort ?? ''}
                    onChange={(e) => setDraft((d) => ({ ...d, [kind]: { ...d[kind], effort: e.target.value } }))}
                    placeholder={guessFor(kind, 'effort')} disabled={busy !== null} />
                </label>
                {accountOptions !== null && accountOptions.length > 0 && (
                  <label>
                    <span className="label">{KIND_WORD[kind]} account</span>
                    <select className="field" aria-label={`${KIND_WORD[kind]} account override`}
                      value={draft[kind]?.accountId ?? ''}
                      onChange={(e) => setDraft((d) => ({ ...d, [kind]: { ...d[kind], accountId: e.target.value } }))}
                      disabled={busy !== null}>
                      <option value="">{accountId ? 'Same as the relay' : 'This project’s account'}</option>
                      {accountId && <option value={INHERIT_NONE}>Not the relay’s — resolve normally</option>}
                      {accountOptions.map((row) => (
                        <option key={row.id} value={row.id}>{row.label}</option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
            ))}
            <Hint>A guess is shown as a guess: an override outside the profile's declared set is refused with a reason, never clamped.</Hint>
            <button className={busy === 'preview' ? 'btn rl-guess-asking' : 'btn'} onClick={suggest}
                    disabled={busy !== null || !intent.trim() || !providerId}>
              {busy === 'preview' ? 'Asking…' : 'Suggest routes'}
            </button>

            {preview && !preview.asked && (
              <Note tone="info">
                No suggester is switched on, so these are the profile’s own defaults rather than guesses.
                Settings › Connections › Routing suggester turns one on.
              </Note>
            )}

            {preview?.asked && (
              <div className="rl-guess">
                <div className="rl-guess-head">
                  <span className="rl-guess-run">Would run {preview.phases.map((p) => KIND_WORD[p]).join(' → ')}</span>
                  <span className="rl-guess-meta">
                    {preview.pipeline ? `${preview.pipeline.pipeline} · ` : ''}${preview.estimatedUsd.toFixed(6)}
                  </span>
                </div>

                <ol className="rl-guess-list">
                  {AGENT_KINDS.map((kind) => {
                    const row = preview.routes[kind];
                    const dropped = !preview.phases.includes(kind);
                    const proposed = row?.suggested ?? null;
                    const taken = row?.route.source === 'suggested';
                    const verdict = proposed ? (taken ? 'taken' : 'short') : undefined;
                    const shown = row?.route.model ?? null;
                    return (
                      <li key={kind} className="rl-guess-row" data-verdict={verdict} data-dropped={dropped || undefined}>
                        <span className="rl-guess-stage">{KIND_WORD[kind]}</span>
                        <span className="rl-guess-pick">
                          {dropped ? 'not run' : shown ?? 'profile default'}
                          {!dropped && row?.route.effort && <em> · {row.route.effort} effort</em>}
                        </span>
                        {proposed ? (
                          <>
                            <progress value={proposed.confidence} max={1}
                              aria-label={`${KIND_WORD[kind]} suggestion confidence`} />
                            <span className="rl-guess-num">{proposed.confidence.toFixed(2)}</span>
                          </>
                        ) : <><span /><span className="rl-guess-num">—</span></>}
                        {/* The router's own sentence, which says who decided and
                            why — including a proposal it declined. */}
                        {row && <p className="rl-guess-why">{row.route.reason}</p>}
                        {dropped && preview.pipeline && (
                          <p className="rl-guess-why">
                            Proposed away by “{preview.pipeline.pipeline}” at confidence {preview.pipeline.confidence.toFixed(2)}.
                            The stages that check the work cannot be proposed away.
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ol>

                <p className="rl-guess-foot">
                  A bar at or above {DEFAULT_MIN_CONFIDENCE.toFixed(2)} was taken; below it the profile’s own default stands and
                  the number is shown anyway, because an answer that fell short is the one worth looking at.
                  Nothing here has been started, every stage is still yours to override, and starting the relay asks
                  again and records that answer as the evidence.
                </p>
              </div>
            )}
            <button className="btn btn-primary" onClick={create} disabled={busy !== null || !intent.trim() || !providerId || !projectId}>
              {busy === 'create' ? 'Starting…' : 'Start relay'}
            </button>
          </Section>

          {relays.length > 0 && (
            <Section n={2} title="Relays" hint="This project's relays, newest first.">
              <div className="control-steps">
                {relays.map((r) => (
                  <button key={r.id} className={r.id === selected ? 'on' : ''} aria-pressed={r.id === selected}
                    onClick={() => { setSelected(r.id); setHoldDismissed(null); }}>{r.title}</button>
                ))}
              </div>
            </Section>
          )}

          {read && (
            <Section n={3} title="Now" hint="What the rail is waiting on, and the one decision that is yours.">
              {plan?.node.status === 'pending' || plan?.node.status === 'ready' ? (
                <ConfirmNote what={`Start planning on ${plan.routeText}`} verb="Start planning" busy={busy === `start-${plan.node.id}`}
                  onRun={() => startPhase(plan.node)} onCancel={() => setSelected(null)} />
              ) : null}
              {estimate?.node.status === 'ready' && (
                <ConfirmNote what="Price the plan from this project's recorded history. Local, free, and always an estimate." verb="Run the forecast"
                  busy={busy === 'estimate'} onRun={runEstimate} onCancel={() => undefined} />
              )}
              {holdOpen && implement && (
                <ConfirmNote
                  what={forecast && forecast.totalMs !== null
                    ? `Build it on ${implement.routeText}. The forecast says about ${dur(forecast.totalMs)} and ${usd(forecast.totalUsd ?? 0)} (from ${forecast.n} recorded phases).`
                    : `Build it on ${implement.routeText}. There is not enough history to price it yet.`}
                  verb="Start implement" busy={busy === `start-${implement.node.id}`}
                  onRun={() => startPhase(implement.node)} onCancel={() => setHoldDismissed(holdKey)} tone="warn" />
              )}
              {review?.node.status === 'ready' && (
                <ConfirmNote what={`Start the review on ${review.routeText}`} verb="Start review" busy={busy === `start-${review.node.id}`}
                  onRun={() => startPhase(review.node)} onCancel={() => undefined} />
              )}
              {review?.node.status === 'running' && review.node.sessionId && (
                <div className="control-review-actions">
                  <button className="btn btn-primary" onClick={() => decide(review.node, 'approve')} disabled={busy !== null}>Approve</button>
                  <button className="btn" onClick={() => decide(review.node, 'request_changes')} disabled={busy !== null}>
                    Request changes{implement ? ` (hand-back ${implement.handbacks} of ${read.handbackLimit})` : ''}
                  </button>
                  <button className="btn btn-danger" onClick={() => decide(review.node, 'reject')} disabled={busy !== null}>Reject</button>
                </div>
              )}
              {phases.some((p) => p.node.sessionId) && (
                <div className="control-inline">
                  {phases.filter((p) => p.node.sessionId).map((p) => (
                    <button key={p.node.id} className="btn btn-sm" onClick={() => openSession(p.node.sessionId!)}>
                      Open {KIND_WORD[p.node.kind].toLowerCase()} session
                    </button>
                  ))}
                  <button className="btn btn-sm" onClick={() => openGoal(read.docket.id)}>Open in Review</button>
                </div>
              )}
            </Section>
          )}

          {read && (
            <Section n={4} title="Forecast" hint="Median duration and cost of this project's recorded phases at each route. An estimate, with its evidence beside it.">
              {forecast && forecast.n > 0 && forecast.totalMs !== null ? (
                <div className="stat-grid">
                  <Stat label="Time" value={dur(forecast.totalMs)} sub={`${forecast.n} recorded · ${forecast.evidenceLevel}`} />
                  <Stat label="Cost" value={forecast.totalUsd === null ? '—' : usd(forecast.totalUsd)} sub={`${forecast.priced} priced`} />
                </div>
              ) : (
                <Note>Not enough recorded history to price this relay yet. A number from one sample would be invented progress wearing a currency symbol.</Note>
              )}
              {forecast && forecast.n > 0 && (
                <>
                  <SectionHead label="Per phase" />
                  {forecast.perPhase.map((p) => (
                    <Hint key={p.nodeId}>
                      {KIND_WORD[p.kind]}: {p.medianMs === null ? 'no basis' : `${dur(p.medianMs)} · ${p.medianUsd === null ? 'unpriced' : usd(p.medianUsd)}`}
                      {' '}({p.n} on {p.basis === 'none' ? 'nothing comparable' : `the same ${p.basis}`})
                    </Hint>
                  ))}
                </>
              )}
            </Section>
          )}

          {read && phases.some((p) => p.route.reason) && (
            <Section n={5} title="Routes" hint="Why each phase runs where it runs. Recorded as evidence when the relay was created.">
              {phases.filter((p) => p.route.reason).map((p) => (
                <div key={p.node.id}>
                  <SectionHead label={KIND_WORD[p.node.kind]} />
                  <Hint>{p.route.reason}</Hint>
                </div>
              ))}
            </Section>
          )}
        </div>
      </div>
    </main>
  );
}
