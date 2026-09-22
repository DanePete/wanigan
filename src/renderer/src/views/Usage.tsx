import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AccountLimits, BankedResetOutcome, ConsumptionPoint, LimitWindow, ModelConsumption, Project, ProviderInfo, UsageSnapshot } from '@shared/types';
import { harnessLabel } from '@shared/types';
import type { ObservedLimitsReport } from '@shared/status-line';
import { ConfirmNote, EmptyState, Note, PageHead, Pill, SectionHead, Stat } from '../components/bits';
import { ObservedLimits } from '../components/ObservedLimits';
import { useViewMemory } from '../components/viewMemory';
import '../styles/usage.css';

/**
 * What is left, and what was spent — kept visibly apart.
 *
 * The two halves of this screen come from different places and carry different
 * weight. The limit windows are a live reading from the provider, because a
 * token counter on this machine cannot answer "what is left": compaction,
 * cached input and plan-specific limits make every such calculation a guess.
 * The consumption below is Wanigan's own exact record of what happened. Showing
 * them in one continuous run of charts would invite the reader to treat the
 * second as evidence for the first, which is the error the whole screen exists
 * to avoid — so they are separated, labelled, and never share an axis.
 */

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const fmt = new Intl.NumberFormat();

/**
 * The consumption windows the picker offers, and the one the page opens on.
 *
 * Fourteen days is the main process's own default — usage.ts DEFAULT_DAYS — so
 * it has to appear on this list. It did not: the page opened on 14 while the
 * picker offered 7, 30 and 90, and a <select> whose value matches no <option>
 * renders with nothing selected. The screen then showed a blank picker above a
 * heading that read "last 14 days", so neither half could be trusted to say
 * which window the figures below it covered. Keep the default a member of this
 * list, and keep the list in step with usage.ts.
 */
const WINDOWS = [7, 14, 30, 90];
const DEFAULT_WINDOW = 14;

/**
 * The four themed series tokens, worn as classes.
 *
 * The daily chart used to draw from --accent, --codex and four raw hex
 * literals. Three faults in one array: the accent is this app's mark for
 * something you can act on and a model is not that, the hexes were the dark
 * values in both themes, and a chart that carries meaning in colour alone
 * carries it for no one who cannot separate those hues. These are the same
 * tokens every other chart in Wanigan reads, and as classes they let the bar
 * segment and the legend swatch share one definition.
 */
const SERIES = ['u-s1', 'u-s2', 'u-s3', 'u-s4'];

const compact = (n: number): string =>
  n >= 1_000_000_000 ? `${(n / 1_000_000_000).toFixed(1)}B`
    : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M`
      : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k`
        : String(Math.round(n));

/** A colour per window severity: status tokens for the two bands that mean
 *  something, a data hue for the rest. The accent marks actionable things and a
 *  quiet reading is not one; the old --danger token was never defined. */
function tone(percent: number): string {
  if (percent >= 95) return 'is-critical';
  if (percent >= 75) return 'is-warning';
  return 'is-normal';
}

/**
 * "resets in 2h 14m", the provider's own words when the date did not parse, or
 * nothing at all when it named no reset — which is what a window with nothing
 * used yet looks like. An empty string is the honest answer there; inventing
 * "resets soon" would be a claim the agent did not make.
 *
 * The verbatim text is never discarded, so a countdown is a bonus rather than
 * something the screen depends on being able to compute.
 */
function resetLabel(window: LimitWindow, now: number): string {
  if (window.resetsAtText === null && window.resetsAt === null) return '';
  if (window.resetsAt === null) return `resets ${window.resetsAtText}`;
  const left = window.resetsAt - now;
  if (left <= 0) return 'Reset time passed · refresh to check';
  const hours = Math.floor(left / 3_600_000);
  const minutes = Math.floor((left % 3_600_000) / 60_000);
  const days = Math.floor(hours / 24);
  if (days >= 1) return `resets in ${days}d ${hours % 24}h`;
  if (hours >= 1) return `resets in ${hours}h ${minutes}m`;
  return `resets in ${minutes}m`;
}

function windowTitle(window: LimitWindow): string {
  const kind = window.kind === 'session' ? 'Session' : window.kind === 'week' ? 'This week' : window.kind;
  return window.scope ? `${kind} · ${window.scope}` : kind;
}

/** Provider percentages are reported values, not estimates from local tokens. */
function Meter({ window, now }: { window: LimitWindow; now: number }) {
  const severity = tone(window.usedPercent);
  const reset = resetLabel(window, now);
  return (
    <div className={`u-meter ${severity}`}>
      <span className="u-window-name">{windowTitle(window)}</span>
      <div className="u-window-value">
        <strong>{window.usedPercent}%</strong>
        <span>{window.usedPercent >= 100 ? 'used up' : 'used'}</span>
      </div>
      <svg className="u-meter-track" viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true">
        <rect className="u-meter-empty" x="0" y="0" width="100" height="4" rx="2" />
        <rect className="u-meter-fill" x="0" y="0" width={Math.max(0, Math.min(100, window.usedPercent))} height="4" rx="2" />
      </svg>
      <span className="u-reset">{reset || 'Reset not reported'}</span>
    </div>
  );
}

function checkedLabel(at: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** "by Oct 12 (in 20d)", or the provider's own silence when it named no expiry. */
function expiryLabel(at: number | null, now: number): string {
  if (at === null) return 'no expiry reported';
  const day = new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric' });
  const left = at - now;
  if (left <= 0) return `expired ${day}`;
  const days = Math.floor(left / 86_400_000);
  const hours = Math.floor((left % 86_400_000) / 3_600_000);
  return `use by ${day} (in ${days >= 1 ? `${days}d` : `${hours}h`})`;
}

/**
 * The provider's verdict on a reset, quoted, with what Wanigan can honestly add.
 *
 * Whether the account can run again is what the re-read beside it says: an
 * outcome of "reset" says a window was refilled, and nothing more.
 */
function outcomeSentence(outcome: BankedResetOutcome['outcome']): string {
  switch (outcome) {
    case 'reset': return 'Codex answered “reset”: a banked reset was used. The limits shown are re-read from Codex just now.';
    case 'nothingToReset': return 'Codex answered “nothingToReset”: there was no limit to refill.';
    case 'noCredit': return 'Codex answered “noCredit”: this account has no banked reset to use.';
    case 'alreadyRedeemed': return 'Codex answered “alreadyRedeemed”: that reset had already been used.';
  }
}

/**
 * Banked resets, per account, with the one button that spends one.
 *
 * Codex reports the bank through the same app-server read that reports the
 * windows, so the count and each credit's expiry are the backend's words and
 * the button is enabled only when it counted one. Claude Code reports its bank
 * only inside a session — `/limit-reset` is the CLI's own offer, gated and
 * confirmed by the CLI — so for a Claude account the button opens a session
 * on that account and types the command; Wanigan never touches the credential
 * and never claims a count it cannot read.
 */
function BankedResets({ limits, now, onLimits, handoff }: {
  limits: AccountLimits; now: number;
  onLimits: (next: AccountLimits) => void;
  handoff: { ready: boolean; why: string | null; run: (accountId: string) => Promise<void> } | null;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  // A new reading resets the conversation: what was said about the old one no
  // longer describes what is on screen.
  useEffect(() => { setSaid(null); setConfirming(false); }, [limits.fetchedAt]);

  if (limits.harness === 'claude-code') {
    if (limits.state !== 'ok' || !handoff) return null;
    const run = async () => {
      setBusy(true); setSaid(null);
      try { await handoff.run(limits.accountId); }
      catch (e) { setSaid({ tone: 'error', text: msg(e) }); }
      finally { setBusy(false); }
    };
    return (
      <div className="u-bank">
        <span className="u-bank-head">Banked resets</span>
        <p className="u-bank-line">
          Claude Code reports a banked reset only inside a session, and uses one only after its own confirmation.
          This opens a session on this account and runs <code>/limit-reset</code>; the CLI says what it has.
        </p>
        <div className="u-bank-actions">
          <button type="button" className="btn btn-sm" disabled={busy || !handoff.ready} onClick={() => void run()}
                  aria-description={handoff.why ?? undefined}>
            {busy ? 'Opening a session…' : 'Check for a Claude reset'}
          </button>
          {handoff.why && <span className="u-bank-why">{handoff.why}</span>}
        </div>
        {said && <Note tone={said.tone}>{said.text}</Note>}
      </div>
    );
  }

  const bank = limits.bankedResets;
  if (limits.state !== 'ok' || bank === undefined) return null;
  const available = (bank.credits ?? []).filter((c) => c.status === 'available');
  const canUse = bank.availableCount > 0;
  const use = async () => {
    setBusy(true); setSaid(null);
    try {
      const result = await window.wanigan.usage.useBankedReset(limits.accountId);
      setConfirming(false);
      onLimits(result.limits);
      setSaid({ tone: result.outcome === 'reset' ? 'ok' : 'error', text: outcomeSentence(result.outcome) });
    } catch (e) {
      setSaid({ tone: 'error', text: msg(e) });
    } finally { setBusy(false); }
  };
  return (
    <div className="u-bank">
      <span className="u-bank-head">Banked resets</span>
      <p className="u-bank-line">
        {bank.availableCount === 0
          ? 'Codex reports none banked on this account.'
          : `Codex reports ${bank.availableCount} banked reset${bank.availableCount === 1 ? '' : 's'} available.`}
        {bank.credits === null && bank.availableCount > 0 && ' It listed no detail for them.'}
      </p>
      {available.length > 0 && (
        <ul className="u-bank-list">
          {available.map((c) => (
            <li key={c.id}>
              <span>{c.title ?? c.resetType ?? 'Reset'}</span>
              <span className="u-bank-expiry">{expiryLabel(c.expiresAt, now)}</span>
              {c.description && <span className="u-bank-desc">{c.description}</span>}
            </li>
          ))}
        </ul>
      )}
      {confirming ? (
        <ConfirmNote verb="Use one reset" busy={busy} onRun={use} onCancel={() => setConfirming(false)}
          what={<>Use a banked reset on {limits.accountLabel}? Codex picks the next available one and refills the window it covers. This cannot be undone, and the weekly reset day stays where it is.</>} />
      ) : (
        <div className="u-bank-actions">
          <button type="button" className="btn btn-sm" disabled={!canUse || busy} onClick={() => setConfirming(true)}>
            Use a banked reset
          </button>
        </div>
      )}
      {said && <Note tone={said.tone} onDismiss={() => setSaid(null)}>{said.text}</Note>}
    </div>
  );
}

function LimitRow({ limits, now, selected, onSelect, onLimits, handoff }: {
  limits: AccountLimits; now: number; selected: boolean; onSelect: () => void;
  onLimits: (next: AccountLimits) => void;
  handoff: { ready: boolean; why: string | null; run: (accountId: string) => Promise<void> } | null;
}) {
  const stale = limits.state === 'stale' || (limits.fetchedAt !== null && now - limits.fetchedAt > 10 * 60_000);
  const status = limits.state === 'signed-out' ? 'Signed out'
    : limits.state === 'unsupported' ? 'Unavailable'
      : limits.state === 'unreadable' ? 'Could not read'
        : stale ? 'Older reading' : 'Read';
  const shared = limits.identityEvidence?.sharedWith ?? [];
  const savedLogins = shared.filter((account) => account.basis === 'saved-login');
  const directories = shared.filter((account) => account.basis === 'configuration-directory');
  return (
    <tr className={selected ? 'u-selected' : undefined}>
      <th scope="row" className="u-account-cell">
        <button type="button" className="u-account-select" aria-pressed={selected} onClick={onSelect}
                aria-label={`Show local records for ${limits.accountLabel}, ${harnessLabel(limits.harness)}`}>
          <strong>{limits.accountLabel}</strong>
          <span className="u-select-cue">{selected ? 'Viewing records' : 'View records'}</span>
        </button>
        <div className="u-account-meta">
          <span>{harnessLabel(limits.harness)}</span>
          {limits.plan && <Pill status={limits.plan} tone="quiet" />}
        </div>
        <div className="u-identity">
          {limits.identity?.email ?? limits.identity?.orgName ?? (limits.state === 'signed-out' ? 'No provider login' : 'Provider login not reported')}
          {limits.identity?.email && limits.identity.orgName && <span>{limits.identity.orgName}</span>}
        </div>
        {shared.length > 0 && <div className="u-identity-evidence">
          {savedLogins.length > 0 && <p>Same saved login as {savedLogins.map((account) => account.accountLabel).join(', ')}.</p>}
          {directories.length > 0 && <p>Same configuration directory as {directories.map((account) => account.accountLabel).join(', ')}.</p>}
        </div>}
      </th>
      <td className="u-windows-cell">
        {limits.state === 'ok' && limits.windows.length > 0 ? (
          <div className="u-windows">
            {limits.windows.map((window) => <Meter key={`${window.kind}:${window.scope ?? 'all'}`} window={window} now={now} />)}
          </div>
        ) : <p className="u-reading-empty">{limits.detail ?? 'No limit reading available.'}</p>}
        {limits.state === 'ok' && limits.windows.length > 0 && limits.detail && <p className="u-reading-detail">{limits.detail}</p>}
        <BankedResets limits={limits} now={now} onLimits={onLimits} handoff={handoff} />
      </td>
      <td className="u-freshness">
        {status !== 'Read' && <Pill status={status} tone={limits.state === 'unreadable' || stale ? 'warn' : 'quiet'} />}
        {limits.fetchedAt === null ? <span>Not checked</span> : (
          <>
            <span>{checkedLabel(limits.fetchedAt, now)}</span>
            <time dateTime={new Date(limits.fetchedAt).toISOString()}>
              {new Date(limits.fetchedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
            </time>
          </>
        )}
      </td>
    </tr>
  );
}

/**
 * Tokens per day, stacked by model, one column per day.
 *
 * Drawn from one scale so every column is comparable, with the axis labelled by
 * a value the chart actually reaches rather than a rounded ceiling nothing
 * touches.
 *
 * The picture is the summary, not the record. Day is the one dimension that
 * reaches this screen nowhere else, and it used to be readable only by hovering
 * a fourteen-pixel column with a mouse — so the same figures are laid out as a
 * table underneath, and the bars carry a name for a reader who never sees them.
 */
function DailyChart({ points, account }: {
  points: ConsumptionPoint[];
  account: { id: string | null; label: string; harness: string | null };
}) {
  const accountLabel = account.label;
  // Matched on the account's id where it has one: the label is not an identity.
  const mine = points.filter((p) => (account.id ? p.accountId === account.id : p.accountId === null && p.accountLabel === account.label));
  const days = [...new Set(mine.map((p) => p.day))].sort();
  const models = [...new Set(mine.map((p) => p.model))].sort();
  const byDay = new Map<string, Map<string, number>>();
  for (const point of mine) {
    if (!byDay.has(point.day)) byDay.set(point.day, new Map());
    const bucket = byDay.get(point.day)!;
    bucket.set(point.model, (bucket.get(point.model) ?? 0) + point.tokens);
  }
  const totals = days.map((day) => [...(byDay.get(day)?.values() ?? [])].reduce((a, b) => a + b, 0));
  const peak = Math.max(0, ...totals);

  if (!days.length) {
    return <p className="faint u-empty">No recorded requests for {accountLabel} in this window.</p>;
  }
  const span = days.length === 1 ? days[0] : `${days[0]} to ${days[days.length - 1]}`;
  return (
    <div className="u-chart">
      {/* A stack of coloured rectangles is not a name. Unlabelled, this was a
          group of empty divs to anything that could not see it, and the colour
          was the only thing telling one model from another. The label says what
          the picture is; the table below says what it is drawn from. */}
      <div className="u-bars" role="img"
           aria-label={`Tokens per day for ${accountLabel}, ${span}, stacked by model. `
             + `Peak ${compact(peak)} reported tokens in a day. The day-by-day figures are in the table below.`}>
        {days.map((day, dayIndex) => {
          const bucket = byDay.get(day) ?? new Map();
          const total = totals[dayIndex];
          return (
            <div key={day} className="u-col" title={`${day} · ${fmt.format(total)} reported tokens`}>
              {models.map((model, modelIndex) => {
                const value = bucket.get(model) ?? 0;
                if (!value) return null;
                return (
                  <div key={model} className={SERIES[modelIndex % SERIES.length]}
                       style={{ height: `${(value / Math.max(1, peak)) * 100}%` }} />
                );
              })}
            </div>
          );
        })}
      </div>
      <div className="u-axis">
        <span className="faint mono">{days[0]}</span>
        <span className="faint mono">peak {compact(peak)} reported tokens/day</span>
        <span className="faint mono">{days[days.length - 1]}</span>
      </div>
      {/* .legend and its two children are already in index.css and are what
          Insights uses; a second swatch family here would be the same thing
          under a different name. Past the fourth model the hues repeat, which
          is the other reason the table exists — it names every model in text. */}
      <div className="legend">
        {models.map((model, index) => (
          <span key={model} className="legend-item">
            <span className={`legend-swatch ${SERIES[index % SERIES.length]}`} />
            {model}
          </span>
        ))}
      </div>
      <details className="u-days">
        <summary>Day by day</summary>
        <div className="u-scroll">
          <table className="viz-table">
            <caption className="u-cap">
              Reported tokens by model, per day, for {accountLabel}. A dash is a day with no token reading for that model.
            </caption>
            <thead>
              <tr>
                <th>Day</th>
                {models.map((model) => <th key={model} className="u-th-r">{model}</th>)}
                <th className="u-th-r">Total</th>
              </tr>
            </thead>
            <tbody>
              {days.map((day, dayIndex) => (
                <tr key={day}>
                  <td className="mono">{day}</td>
                  {models.map((model) => {
                    const value = byDay.get(day)?.get(model);
                    return <td key={model} className="n">{value === undefined ? '—' : fmt.format(value)}</td>;
                  })}
                  <td className="n">{fmt.format(totals[dayIndex])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

function consumptionTokens(value: number, row: ModelConsumption): string {
  if (!row.unmeteredRequests) return compact(value);
  return value > 0 ? `≥${compact(value)}` : '—';
}

function consumptionCost(row: ModelConsumption): string {
  if (row.costStatus !== 'unreported') return `${row.costStatus === 'partial' ? '≥' : ''}$${row.costUsd.toFixed(2)}`;
  if (row.estimatedCostUsd === undefined) return '—';
  const estimate = row.estimatedCostUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 9 });
  return `~$${estimate} estimated`;
}

function ConsumptionTable({ rows }: { rows: ModelConsumption[] }) {
  if (!rows.length) return <p className="faint u-empty">Nothing recorded in this window.</p>;
  return (
    <div className="u-scroll">
      <table className="u-consumption-table" aria-label="Consumption by model">
        <thead>
          <tr>
            {['Account', 'Model', 'Requests', 'Input', 'Output', 'Cached', 'Cost'].map((head) => (
              <th scope="col" key={head}>{head}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.accountId ?? `label:${row.accountLabel}`}:${row.model}`}>
              <td>
                {row.accountLabel}
                {row.harness && <span className="faint u-row-harness">{harnessLabel(row.harness)}</span>}
              </td>
              <td className="mono">{row.model}</td>
              <td>{fmt.format(row.requests)}</td>
              <td>{consumptionTokens(row.inTokens, row)}</td>
              <td>{consumptionTokens(row.outTokens, row)}</td>
              <td>{row.source === 'service' ? '—' : compact(row.cacheRead)}</td>
              <td>
                {consumptionCost(row)}
                <span className="sr-only">
                  {row.costStatus === 'reported' ? ' Every request carried a provider cost.'
                    : row.costStatus === 'partial' ? ' Some requests carried no provider cost, so this total is a floor.'
                    : row.estimatedCostUsd !== undefined ? ' Estimated from reported token usage at the rate saved for each call. This is not a provider bill.'
                      : ' This provider reported no cost.'}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Usage({ projectId, projects = [], providers = [], onOpenSession }: {
  /** The project a Claude reset check opens its session in. Undefined: no project yet. */
  projectId?: string;
  projects?: Project[];
  providers?: ProviderInfo[];
  onOpenSession?: (id: string) => void;
} = {}) {
  const [snap, setSnap] = useState<UsageSnapshot | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The chosen window is view memory rather than local state. App mounts one
  // view at a time, so a trip to Sessions and back re-mounted this page at
  // DEFAULT_WINDOW and quietly re-read a different span than the one the
  // operator had picked — and the heading below, which reports what main
  // answered, agreed with the new span, so nothing on screen said the
  // selection had been dropped.
  const [days, setDays] = useViewMemory<number>('days', DEFAULT_WINDOW);
  const [now, setNow] = useState(Date.now());
  const [accountKey, setAccountKey] = useViewMemory<string>('account', 'all');
  const request = useRef(0);
  const consumptionSection = useRef<HTMLElement>(null);
  useEffect(() => () => { request.current += 1; }, []);

  const load = useCallback((force: boolean) => {
    const current = ++request.current;
    setBusy(true); setErr(null);
    window.wanigan.usage.snapshot({ days, force })
      .then((next) => { if (current === request.current) { setSnap(next); setNow(Date.now()); } })
      .catch((e) => { if (current === request.current) setErr(msg(e)); })
      .finally(() => { if (current === request.current) setBusy(false); });
  }, [days]);

  useEffect(() => { load(false); }, [load]);

  /** One row re-read after a reset: replace it, leave every other account's reading alone. */
  const replaceLimits = useCallback((next: AccountLimits) => {
    setSnap((current) => current && { ...current, limits: current.limits.map((row) => row.accountId === next.accountId ? next : row) });
    setNow(Date.now());
  }, []);

  /**
   * Where a Claude reset check can open. The command is the CLI's own, so the
   * session is a real one on the chosen account, in the project the shell
   * has selected; without a project there is nowhere to open it.
   */
  const claudeHandoff = useMemo(() => {
    if (!onOpenSession) return null;
    const provider = providers.find((p) => p.harnessId === 'claude-code' && p.path) ?? providers.find((p) => p.id === 'claude' && p.path);
    const project = projectId && projects.some((p) => p.id === projectId) ? projectId : null;
    const why = !provider ? 'Claude Code is not installed, so there is no session to open.'
      : !project ? 'Add a project first: the session needs a repository to open in.' : null;
    return {
      ready: why === null, why,
      run: async (accountId: string) => {
        if (!provider || !project) throw new Error(why ?? 'Nowhere to open a session.');
        const session = await window.wanigan.sessions.create({ providerId: provider.id, projectId: project, accountId, initialPrompt: '/limit-reset' });
        onOpenSession(session.id);
      },
    };
  }, [onOpenSession, providers, projectId, projects]);

  // What running sessions' status lines reported. A database read, so unlike
  // the probe it is allowed on a timer.
  const [observed, setObserved] = useState<ObservedLimitsReport | null>(null);
  const [observedErr, setObservedErr] = useState<string | null>(null);
  const readObserved = useCallback(() => {
    window.wanigan.usage.observed()
      .then((next) => { setObserved(next); setObservedErr(null); })
      .catch((e) => setObservedErr(msg(e)));
  }, []);
  useEffect(() => { readObserved(); }, [readObserved]);

  // Only the countdown and that local read tick on their own. Re-probing on a
  // timer would start a real CLI process behind the operator's back, so a fresh
  // probe reading is always something they asked for.
  useEffect(() => {
    const timer = setInterval(() => { setNow(Date.now()); readObserved(); }, 30_000);
    return () => clearInterval(timer);
  }, [readObserved]);

  /**
   * One entry per account, keyed by id rather than by label.
   *
   * `accounts.seed` names the first account of every harness 'Personal', so a
   * machine with Claude Code and Codex has two of them by default — and
   * grouping by label summed both agents' tokens into one chart and produced
   * two table rows nothing on screen could tell apart, while the limit cards
   * above distinguished the same pair by harness pill.
   */
  const accountSeries = useMemo(() => {
    const seen = new Map<string, { id: string | null; label: string; harness: string | null; source?: ModelConsumption['source'] }>();
    for (const l of snap?.limits ?? []) {
      seen.set(l.accountId ?? `label:${l.accountLabel}`, { id: l.accountId, label: l.accountLabel, harness: l.harness });
    }
    for (const c of snap?.consumption ?? []) {
      const key = c.accountId ?? `label:${c.accountLabel}`;
      if (!seen.has(key)) seen.set(key, { id: c.accountId, label: c.accountLabel, harness: c.harness, source: c.source });
    }
    return [...seen.values()];
  }, [snap]);
  const keyOf = (a: { id: string | null; label: string }) => a.id ? `account:${a.id}` : `label:${a.label}`;
  const selected = accountKey === 'all' ? null
    : accountSeries.find((a) => keyOf(a) === accountKey) ?? null;
  const matches = (row: { accountId: string | null; accountLabel: string }) => !selected
    || (selected.id ? row.accountId === selected.id : row.accountId === null && row.accountLabel === selected.label);
  const limits = snap?.limits ?? [];
  const detailLimits = limits.filter(matches);
  const consumption = (snap?.consumption ?? []).filter(matches);
  const series = selected ? [selected] : accountSeries;
  const requests = consumption.reduce((n, r) => n + r.requests, 0);
  const tokens = consumption.reduce((n, r) => n + r.inTokens + r.outTokens, 0);
  const unmetered = consumption.reduce((n, r) => n + (r.unmeteredRequests ?? 0), 0);
  const selectAccount = (id: string) => {
    setAccountKey(`account:${id}`);
    requestAnimationFrame(() => {
      const section = consumptionSection.current;
      if (!section) return;
      section.focus({ preventScroll: true });
      const pane = section.closest<HTMLElement>('.usage-view');
      if (!pane) return;
      const head = pane.querySelector<HTMLElement>(':scope > .pane-head');
      // Scroll only the pane. scrollIntoView also moves the outer document,
      // which can push the app bar away and leave space below the dock.
      pane.scrollTop += section.getBoundingClientRect().top - pane.getBoundingClientRect().top - (head?.offsetHeight ?? 0);
    });
  };

  return (
    <div className="pane wide usage-view">
      <PageHead title="Usage" lead="Compare account limits. See what ran in Wanigan." actions={(
        <button className="btn btn-primary" disabled={busy} onClick={() => { load(true); readObserved(); }}>
          {busy ? 'Reading accounts…' : 'Refresh limits'}
        </button>
      )} />

      {err && (
        <Note tone="error" action={{ label: busy ? 'Reading…' : 'Try again', run: () => load(true) }}>
          {err}
        </Note>
      )}

      <section className="u-capacity" aria-label="Provider account limits" aria-busy={busy}>
        <SectionHead label="Account limits" count={limits.length} right={<span className="u-section-aside">Read from your providers</span>} />
        <p className="u-provenance">Each account’s login and plan, with the limits its provider reported. Refresh to check for changes.</p>
        {snap === null && !err && <p className="faint">Reading each account…</p>}
        {snap === null && err && <EmptyState posture="could-not-read" title="Could not read your accounts" cue={err} />}
        {limits.length > 0 && (
          <div className="u-comparison-wrap">
            <table className="u-comparison">
              <caption className="sr-only">Provider limits for every configured account. Select an account to filter the local consumption below.</caption>
              <thead>
                <tr><th scope="col">Account &amp; provider login</th><th scope="col">Reported limits</th><th scope="col">Last checked</th></tr>
              </thead>
              <tbody>
                {limits.map((limit) => (
                  <LimitRow key={limit.accountId} limits={limit} now={now} onLimits={replaceLimits} handoff={claudeHandoff}
                    selected={selected?.id === limit.accountId} onSelect={() => selectAccount(limit.accountId)} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {snap && limits.length === 0 && <EmptyState posture="nothing-yet" title="No provider accounts configured" cue="Add an account in Settings to read its provider limits. Recorded service calls still appear below." />}
      </section>

      <section className="u-consumption" aria-label="Recorded consumption" ref={consumptionSection} tabIndex={-1}>
        <SectionHead label="Recorded in Wanigan" right={(
          <div className="u-actions">
            <select className="field" value={selected ? keyOf(selected) : 'all'}
                    aria-label="Account for recorded consumption" onChange={(e) => setAccountKey(e.target.value)}>
              <option value="all">All accounts &amp; services</option>
              {accountSeries.map((a) => <option key={keyOf(a)} value={keyOf(a)}>{a.label} — {a.harness ? harnessLabel(a.harness) : a.source === 'service' ? 'API service' : 'Unknown harness'}</option>)}
            </select>
            <select className="field" value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Consumption window">
              {WINDOWS.map((value) => <option key={value} value={value}>Last {value} days</option>)}
            </select>
          </div>
        )} />
        <p className="u-provenance">
          {selected ? `${selected.label} across all projects.` : 'All accounts and services across all projects.'} Session and service records for the last {snap?.days ?? days} days. These counts do not measure remaining quota.
        </p>
        {selected?.source === 'service' && <Note role="none">This API service has no provider limit reading. Its recorded calls appear here.</Note>}
        {snap === null && err ? (
          <EmptyState posture="could-not-read" title="Could not read local consumption" cue={err} />
        ) : snap === null ? (
          <p className="faint">Reading Wanigan’s records for the last {days} days…</p>
        ) : consumption.length === 0 ? (
          <EmptyState posture="nothing-yet" title="No recorded requests in this window"
            cue="Sessions outside Wanigan or without telemetry leave no row here. Provider limit readings are independent." />
        ) : (
          <>
            <div className="u-totals">
              <Stat label="Requests" value={fmt.format(requests)} sub="recorded in Wanigan" />
              <Stat label="Tokens" value={unmetered ? tokens > 0 ? `≥${compact(tokens)}` : '—' : compact(tokens)} sub="reported input + output" />
              <p className="u-cost-note">Costs appear when reported. Estimates are labeled separately and are not a provider bill.</p>
            </div>
            {unmetered > 0 && <Note>{fmt.format(unmetered)} {unmetered === 1 ? 'request did' : 'requests did'} not report complete token counts. Totals show reported tokens; estimates cover reported input only.</Note>}
            <div className="u-charts">
              {series.filter((a) => (snap?.daily ?? []).some((point) => (
                a.id ? point.accountId === a.id : point.accountId === null && point.accountLabel === a.label)))
                .map((a) => (
                  <div className="u-daily" key={keyOf(a)}>
                    <h3>{selected ? 'Daily activity' : `${a.label}${a.harness ? ` · ${harnessLabel(a.harness)}` : ''}`}</h3>
                    <DailyChart points={snap?.daily ?? []} account={a} />
                  </div>
                ))}
            </div>
            <ConsumptionTable rows={consumption} />
          </>
        )}
      </section>

      <details className="u-details">
        <summary>Session observations &amp; provider details</summary>
        <p className="u-provenance">Earlier status line readings from sessions, kept separate from the account checks above. They may describe a different point in the quota window.</p>
        <div className="u-observations">
          {detailLimits.filter((limit) => limit.harness === 'claude-code').map((limit) => (
            <div key={limit.accountId}>
              <h3>{limit.accountLabel}</h3>
              <ObservedLimits label={limit.accountLabel} account={observed?.accounts.find((a) => a.accountId === limit.accountId)}
                report={observed} error={observedErr} />
            </div>
          ))}
          {!selected && (observed?.accounts ?? [])
            .filter((a) => a.readings > 0 && !limits.some((l) => l.accountId === a.accountId))
            .map((a) => (
              <div key={`observed:${a.accountId ?? 'none'}`}>
                <h3>{a.accountLabel}</h3>
                <ObservedLimits label={a.accountLabel} account={a} report={observed} error={null} />
              </div>
            ))}
          {selected && !detailLimits.some((limit) => limit.harness === 'claude-code') && <p className="faint u-empty">No status line observations are available for this account.</p>}
        </div>
        {detailLimits.some((limit) => limit.factors.length > 0) && (
          <div className="u-factors">
            <SectionHead label="Provider breakdown" />
            <p className="u-provenance">The provider’s approximate, local-only explanation, quoted as given. It excludes other devices and claude.ai.</p>
            <div className="u-factor-list">
              {detailLimits.flatMap((limit) => limit.factors.map((period) => (
                <div key={`${limit.accountId}:${period.label}`} className="sunk u-factor">
                  <h3>{limit.accountLabel} · {period.label}</h3>
                  <p className="faint">
                    {[period.requests !== null ? `${fmt.format(period.requests)} requests` : null,
                      period.sessions !== null ? `${fmt.format(period.sessions)} sessions` : null].filter(Boolean).join(' · ')}
                  </p>
                  <ul>{period.lines.map((line) => <li key={line}>{line}</li>)}</ul>
                </div>
              )))}
            </div>
          </div>
        )}
      </details>
    </div>
  );
}
