// Jev in the interface: a quiet chip on a card, its full read in the drawer, a
// strip on each board, and its settings. Jev is advice: it is drawn in neutral
// ink, never in water (Wanigan) or amber (needs you).
import { useState, type ReactElement } from 'react';
import {
  JEV_ACTION_LABEL, JEV_ACTION_NAMES, JEV_ACTIONS, JEV_MODES, JEV_SEVERITY, jevDuplicate, severityLabel,
  type JevMode, type JevRead, type JevStatus,
} from '@shared/jev';
import type { CardDetail, CardSummary, ProjectSummary } from '@shared/model';
import { attempt, call, useQuery } from '../lib/api';
import { ago } from '../lib/format';
import { href, openCard } from '../lib/router';
import { Button, IconButton, Segmented, useToast } from './ui';

const pct = (p: number | null): string => (p === null ? '' : `${Math.round(p * 100)}%`);

export const JEV_MODE_LABEL: Record<JevMode, string> = { off: 'Off', read: 'Reads', accept: 'Reads and accepts' };
const JEV_MODE_HINT: Record<JevMode, string> = {
  off: 'Jev reads nothing in this project.',
  read: 'Jev reads every new card and suggests; it changes nothing.',
  accept: 'Jev also moves a confident “ready” to Ready, when the card already has acceptance criteria.',
};

/** Four small steps: how much a card matters, by Jev's score. */
export function SeverityMeter({ severity }: { severity: number }) {
  const level = Math.round(severity);
  return (
    <span className="sev" role="img" aria-label={`Jev: ${severityLabel(severity)}`} title={`Jev: ${severityLabel(severity)} (${severity.toFixed(1)} of 3)`}>
      {JEV_SEVERITY.map((_, i) => <span key={i} className={i <= level ? 'on' : ''} />)}
    </span>
  );
}

/** The chip on a board card: what Jev suggests while it is in the Inbox, and how much it matters. */
export function JevChip({ card }: { card: CardSummary }): ReactElement | null {
  const read = card.jev;
  if (!read) return null;
  if (read.outcome === 'failed') return <span className="jev-chip jev-failed" title={read.error ?? 'Jev did not answer'}>Jev ✕</span>;
  const dup = jevDuplicate(read);
  const suggestion = card.status === 'inbox'
    ? dup ? `Same as ${dup}` : read.action ? `${JEV_ACTION_LABEL[read.action]} ${pct(read.confidence)}` : null
    : null;
  return (
    <>
      {suggestion ? (
        <span className="jev-chip" title={`Jev suggests: ${dup ? `a duplicate of ${dup} (${pct(read.duplicateP)})` : read.action ? JEV_ACTIONS[read.action] : ''}`}>
          <span className="jev-mark" aria-hidden="true">J</span>{suggestion}
        </span>
      ) : null}
      {read.severity !== null ? <SeverityMeter severity={read.severity} /> : null}
    </>
  );
}

/** Jev's read in the card drawer, with the moves it suggests one click away. */
export function JevSection({ card, mode }: { card: CardDetail; mode: JevMode }) {
  const toast = useToast();
  const status = useQuery('jev.status', {}, ['projects']);
  const read: JevRead | null = card.jev;
  const fail = (m: string): void => toast(m, 'error');
  const again = (): void => { void attempt(() => call('jev.read', { cardId: card.id }), fail).then((r) => { if (r) toast('Jev is reading it again.'); }); };
  if (!status.data?.configured && !read) return null;
  const dup = read ? jevDuplicate(read) : null;
  const inbox = card.status === 'inbox';

  return (
    <section className="drawer-section jev-section">
      <h3><span className="jev-mark" aria-hidden="true">J</span>Jev’s read {read && read.outcome !== 'failed' ? <span className="faint">{ago(read.at)}</span> : null}</h3>
      {!read ? (
        <p className="faint small">{mode === 'off' ? 'Jev is off for this project.' : 'Not read yet.'}</p>
      ) : read.outcome === 'failed' ? (
        <p className="error-text small">{read.error}</p>
      ) : (
        <div className="jev-read">
          {read.action ? (
            <p className="jev-line">
              <strong>{read.outcome === 'accepted' ? 'Accepted it to Ready' : `Suggests: ${JEV_ACTION_LABEL[read.action]}`}</strong>
              <span className="faint"> {pct(read.confidence)} sure. {JEV_ACTIONS[read.action]}.</span>
            </p>
          ) : null}
          {dup ? (
            <p className="jev-line">
              Probably the same as <a href={href({ name: 'project', projectKey: card.key.split('-')[0] ?? '', view: 'board' }, dup)} onClick={(e) => { e.preventDefault(); openCard(dup); }}>{dup}</a>
              <span className="faint"> ({pct(read.duplicateP)})</span>
            </p>
          ) : null}
          {read.severity !== null ? (
            <p className="jev-line"><SeverityMeter severity={read.severity} /> <span>{severityLabel(read.severity)}</span></p>
          ) : null}
          {read.probabilities && Object.keys(read.probabilities).length > 1 ? (
            <ul className="jev-odds" aria-label="Jev’s probabilities">
              {JEV_ACTION_NAMES.filter((a) => (read.probabilities?.[a] ?? 0) >= 0.02).map((a) => (
                <li key={a}>
                  <span className="jev-odds-name">{JEV_ACTION_LABEL[a]}</span>
                  <span className="jev-odds-bar"><span style={{ width: `${Math.round((read.probabilities?.[a] ?? 0) * 100)}%` }} /></span>
                  <span className="jev-odds-p">{pct(read.probabilities?.[a] ?? 0)}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
      <div className="row-gap">
        {inbox && read?.action === 'ready' ? (
          <Button size="s" tone="primary" onClick={() => attempt(() => call('cards.move', { id: card.id, status: 'ready' }), fail)}>Accept to Ready</Button>
        ) : null}
        {inbox && dup ? (
          <Button size="s" onClick={() => attempt(async () => {
            await call('cards.comment', { id: card.id, body: `Duplicate of ${dup} (Jev ${pct(read?.duplicateP ?? null)}, confirmed by the owner).` });
            return call('cards.move', { id: card.id, status: 'archived' });
          }, fail)}>Archive as a duplicate</Button>
        ) : null}
        {status.data?.configured && mode !== 'off' ? <Button size="s" tone="quiet" icon="refresh" onClick={again}>Read again</Button> : null}
      </div>
      <p className="faint small">Jev is TypeSafe’s decision model. It reads card fields, which may include code you entered. It does not read project files or transcripts. Its read is advice{mode === 'accept' ? ', except that it may accept a confident card that has criteria' : ''}.</p>
    </section>
  );
}

/** The setup hint, once hidden, stays hidden in this window: a per-viewer convenience. */
const HINT_KEY = 'wanigan.hint.jev';

function hintHidden(): boolean {
  try { return localStorage.getItem(HINT_KEY) === 'hidden'; } catch { return false; }
}

/** One line on a board: whether Jev is working here, what it has cost, and the project's Jev mode. */
export function JevStrip({ project }: { project: ProjectSummary }) {
  const toast = useToast();
  const status = useQuery('jev.status', {}, ['projects', 'board']);
  const [hidden, setHidden] = useState(hintHidden);
  const s = status.data;
  if (!s) return null;
  if (!s.configured) {
    if (hidden) return null;
    const hide = (): void => {
      try { localStorage.setItem(HINT_KEY, 'hidden'); } catch { /* convenience only */ }
      setHidden(true);
    };
    return (
      <div className="jev-strip">
        <span className="jev-mark" aria-hidden="true">J</span>
        <span className="faint">Jev can read each new card for you: what to do with it, how much it matters, and whether it repeats another.</span>
        <span className="jev-strip-end">
          <a href={href({ name: 'settings' })}>Set up Jev</a>
          <IconButton icon="close" label="Hide this hint" onClick={hide} />
        </span>
      </div>
    );
  }
  const readAll = (): Promise<void> => attempt(() => call('jev.readAll', { projectId: project.id }), (m) => toast(m, 'error')).then((r) => {
    if (r) toast(r.queued ? `Jev is reading ${r.queued} card${r.queued === 1 ? '' : 's'}.` : 'Jev has read every card here.');
  });
  return (
    <div className="jev-strip">
      <span className="jev-mark" aria-hidden="true">J</span>
      <JevHealth status={s} />
      <span className="jev-strip-end">
        {project.jev !== 'off' ? <Button size="s" tone="quiet" onClick={readAll}>Read unread cards</Button> : null}
        <JevModePicker project={project} />
      </span>
    </div>
  );
}

function JevHealth({ status: s }: { status: JevStatus }) {
  if (!s.online) {
    return <span className="jev-health"><span className="jev-dot off" aria-hidden="true" />{s.lastError ? `Jev is not answering: ${s.lastError}` : 'Jev has not been asked yet.'}</span>;
  }
  return (
    <span className="jev-health">
      <span className="jev-dot" aria-hidden="true" />
      <span>Jev online</span>
      {s.latencyP50 !== null ? <span className="faint">{s.latencyP50} ms</span> : null}
      <span className="faint">{s.callsToday} today</span>
      <span className="faint" title={`${s.calls} calls in all, ${s.errors} failed. ${s.unknownUsageCalls ? `${s.unknownUsageCalls} successful calls have no usable token count. ` : ''}Estimated from reported input-token usage, not a bill.`}>
        {s.costUsd === null ? 'Cost unknown' : `$${s.costUsd.toFixed(4)} estimated`}
      </span>
    </span>
  );
}

export function JevModePicker({ project }: { project: ProjectSummary }) {
  const toast = useToast();
  return (
    <Segmented<JevMode>
      label={`Jev in ${project.name}`}
      size="s"
      value={project.jev}
      onChange={(jev) => void attempt(() => call('projects.update', { id: project.id, jev }), (m) => toast(m, 'error'))}
      options={JEV_MODES.map((m) => ({ value: m, label: JEV_MODE_LABEL[m], hint: JEV_MODE_HINT[m] }))}
    />
  );
}

/** Settings: the key, the connection, and each project's mode. */
export function JevSettings({ projects }: { projects: ProjectSummary[] | undefined }) {
  const toast = useToast();
  const status = useQuery('jev.status', {}, ['projects']);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const s = status.data;
  const fail = (m: string): void => toast(m, 'error');

  const save = async (): Promise<void> => {
    setBusy(true);
    const saved = await attempt(() => call('jev.setKey', { key }), fail);
    if (saved) {
      setKey('');
      const tested = await attempt(() => call('jev.test', {}), fail);
      toast(tested?.online ? 'Jev answered. It will read new cards from now on.' : `Saved, but Jev did not answer${tested?.lastError ? `: ${tested.lastError}` : '.'}`, tested?.online ? 'info' : 'error');
    }
    setBusy(false);
    status.reload();
  };
  const test = async (): Promise<void> => {
    setBusy(true);
    const tested = await attempt(() => call('jev.test', {}), fail);
    if (tested) toast(tested.online ? `Jev answered in ${tested.latencyP50 ?? '?'} ms.` : `Jev did not answer${tested.lastError ? `: ${tested.lastError}` : '.'}`, tested.online ? 'info' : 'error');
    setBusy(false);
    status.reload();
  };

  return (
    <section className="settings-group" aria-labelledby="set-jev">
      <header className="account-group-head">
        <h2 id="set-jev">Jev</h2>
        {s ? <JevHealth status={s} /> : null}
      </header>
      <p className="lede">
        Jev is TypeSafe’s decision model. It reads each new card and suggests what to do with it, how much it matters,
        and whether it repeats another card. It receives the project name, card key, type, title, description, priority and criteria,
        plus keys, titles and statuses of possible duplicates. Project files and transcripts are not included.
        Cost is estimated from reported input-token usage; it is not a bill. Missing or invalid token counts leave the total unknown.
      </p>

      <div className="settings-row">
        {s?.configured === 'env' ? (
          <p>Using <code>TYPESAFE_API_KEY</code> from your shell.</p>
        ) : s?.configured === 'saved' ? (
          <p>A key is saved for Wanigan’s core, readable by your user only. It is never shown again.</p>
        ) : (
          <form className="jev-key" onSubmit={(e) => { e.preventDefault(); if (key.trim()) void save(); }}>
            <label htmlFor="jev-key">TypeSafe API key</label>
            <div className="row-gap">
              <input id="jev-key" type="password" autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} placeholder="Paste your key" />
              <Button tone="primary" type="submit" disabled={!key.trim() || busy}>Save and test</Button>
            </div>
            <p className="field-hint">Get one at <a href="https://console.typesafe.ai/keys" target="_blank" rel="noreferrer">console.typesafe.ai/keys</a>, or export <code>TYPESAFE_API_KEY</code> in your shell.</p>
          </form>
        )}
        {s?.configured ? (
          <div className="row-gap">
            <Button size="s" onClick={() => test()} disabled={busy}>Test the connection</Button>
            {s.configured === 'saved' ? <Button size="s" tone="quiet" onClick={() => attempt(() => call('jev.forgetKey', {}), fail).then(() => status.reload())}>Forget the key</Button> : null}
          </div>
        ) : null}
        {s && s.calls ? (
          <p className="faint small">
            {s.calls} calls so far, {s.errors} failed{s.model ? `, model ${s.model}` : ''}.{' '}
            {s.costUsd === null ? <>
              Total cost unknown. {s.knownCostUsd === null ? 'The recorded subtotal is unavailable.' : `$${s.knownCostUsd.toFixed(4)} estimated from calls with usable token counts.`}{' '}
              {s.unknownUsageCalls ? `${s.unknownUsageCalls} successful call${s.unknownUsageCalls === 1 ? ' has' : 's have'} no usable token count.` : null}
            </> : `$${s.costUsd.toFixed(4)} estimated from reported usage in all.`}
          </p>
        ) : null}
      </div>

      {projects?.length ? (
        <>
          <h3 className="settings-sub">In each project</h3>
          <ul className="settings-projects">
            {projects.map((p) => (
              <li key={p.id}>
                <span className="settings-project-name">{p.name}</span>
                <JevModePicker project={p} />
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
