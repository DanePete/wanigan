// What every tab of the git workbench shares: which checkout it shows, the
// marks for refs, cards and the sessions that changed a file, the secret-scan
// findings panel, and a confirm dialog that says plainly what an act does.
import { type ReactNode } from 'react';
import type { Attribution, CheckoutAgent, GitStatus, RefName } from '@shared/git';
import type { SecretScanReport } from '@shared/secret-scan';
import { SECRET_RULE_LABEL } from '@shared/secret-scan';
import type { GitWhere } from '@shared/protocol';
import { openCard } from '../../lib/router';
import { PROVIDER_LABEL, plural } from '../../lib/format';
import { Icon } from '../../components/icons';
import { Button, Dialog } from '../../components/ui';

export type Where = GitWhere & { cardId: string | null };

/** "Claude Code (NS-6, Checkout button has no accessible name)". */
export function agentName(a: Pick<CheckoutAgent, 'provider' | 'title' | 'cardKey'>): string {
  return `${PROVIDER_LABEL[a.provider]} (${a.cardKey ? `${a.cardKey}, ` : ''}${a.title})`;
}

/** Where the checkout is, in words: "the project folder", "NS-3’s worktree". */
export const placeOf = (status: Pick<GitStatus, 'cardKey'>): string => (status.cardKey ? `${status.cardKey}’s worktree` : 'the project folder');

/** A branch or commit name, set as code. */
export function Ref({ name, kind = 'branch', current = false }: { name: string; kind?: RefName['kind']; current?: boolean }) {
  return (
    <span className={`ref ref-${kind}${current ? ' ref-current' : ''}`} title={current ? `${name}: checked out here` : kind === 'remote' ? `${name}: where the remote is` : kind === 'tag' ? `Tag ${name}` : name}>
      {kind === 'tag' ? <span aria-hidden="true">#</span> : null}
      {name}
      {current ? <span className="visually-hidden"> (checked out)</span> : null}
    </span>
  );
}

/** A card's key, stamped like its mark on the board; it opens the card. */
export function CardBadge({ cardKey }: { cardKey: string }) {
  return (
    <button type="button" className="card-key-badge" title={`Made for ${cardKey}: open the card`} onClick={(e) => { e.stopPropagation(); openCard(cardKey); }}>
      {cardKey}
    </button>
  );
}

/** "turn 3", "turns 1–3", "turns 1, 4". */
function turnsText(turns: number[]): string {
  if (!turns.length) return '';
  if (turns.length === 1) return `turn ${turns[0]}`;
  const run = turns.every((t, i) => i === 0 || t === (turns[i - 1] as number) + 1);
  return run ? `turns ${turns[0]}–${turns.at(-1)}` : `turns ${turns.join(', ')}`;
}

/** Who changed a file, from Wanigan's own record: a small mark per session, the card's key where it has one. */
export function WhoMarks({ who }: { who: Attribution[] }) {
  if (!who.length) return null;
  const [first, ...rest] = who;
  if (!first) return null;
  const line = (a: Attribution): string => `${PROVIDER_LABEL[a.provider]} · ${a.title}${a.turns.length ? `, ${turnsText(a.turns)}` : a.live ? ', this turn so far' : ''}${a.shared ? ' (another session shared the folder then)' : ''}`;
  return (
    <span className={`who${first.live ? ' who-live' : ''}`} title={`Changed by ${who.map(line).join('; ')}`}>
      <Icon name={first.provider === 'shell' ? 'terminal' : first.provider} size={12} />
      <span>{first.cardKey ?? PROVIDER_LABEL[first.provider]}</span>
      {rest.length ? <span className="who-more">+{rest.length}</span> : null}
      <span className="visually-hidden">changed by {who.map(line).join('; ')}</span>
    </span>
  );
}

/** The same, said in a sentence under a file's header. */
export function WhoLine({ who }: { who: Attribution[] }) {
  if (!who.length) return null;
  return (
    <span className="who-line">
      {who.map((a, i) => (
        <span key={a.sessionId}>
          {i ? '; ' : 'Changed by '}
          <strong>{PROVIDER_LABEL[a.provider]}</strong>{a.cardKey ? <> on <CardBadge cardKey={a.cardKey} /></> : null}
          {a.turns.length ? ` in ${turnsText(a.turns)}` : a.live ? ' in the turn under way' : ''}
          {a.shared ? ', while another session shared the folder' : ''}
        </span>
      ))}
    </span>
  );
}

/**
 * What a secret scan found, and the acknowledgement that lets the act go ahead:
 * a box to tick that says the list was read. Nothing a finding shows is the
 * secret itself; the core sends only redacted excerpts.
 */
export function SecretFindings({ report, acknowledged, onAcknowledge }: { report: SecretScanReport; acknowledged: boolean; onAcknowledge: (v: boolean) => void }) {
  const n = report.findings.length + report.omitted;
  const act = report.action === 'commit' ? 'committed' : 'pushed';
  return (
    <div className="secret-findings" role="alert">
      <p className="secret-head">
        <Icon name="alert" size={15} />
        <strong>{n ? `${plural(n, 'possible secret')} in ${report.scope}.` : report.unreadable ? `Wanigan could not check ${report.scope}.` : `Part of ${report.scope} was not checked.`}</strong>
        <span> Nothing has been {act}.</span>
      </p>
      {report.unreadable ? <p className="small">{report.unreadable}.</p> : null}
      {report.findings.length ? (
        <ul className="secret-list">
          {report.findings.map((f, i) => (
            <li key={i}>
              <span className="secret-where mono">{f.file}:{f.line}{f.commit ? <span className="faint"> in {f.commit.slice(0, 7)}</span> : null}</span>
              <span className="secret-rule">{SECRET_RULE_LABEL[f.rule]}</span>
              <code className="secret-excerpt">{f.excerpt}</code>
            </li>
          ))}
        </ul>
      ) : null}
      {report.omitted ? <p className="small faint">And {plural(report.omitted, 'more finding')}, not listed.</p> : null}
      {report.partial ? <p className="small">Not checked: {report.partial}.</p> : null}
      {report.suppressed ? <p className="small faint">{plural(report.suppressed, 'line')} marked <code>wanigan:allow-secret</code> {report.suppressed === 1 ? 'was' : 'were'} not reported.</p> : null}
      <label className="secret-ack">
        <input type="checkbox" checked={acknowledged} onChange={(e) => onAcknowledge(e.target.checked)} />
        <span>I have read {n ? (n === 1 ? 'it' : 'them') : 'this'}, and {n ? `none is a real credential` : 'I accept the gap'}.</span>
      </label>
    </div>
  );
}

/**
 * A confirm that says what an act does and what it costs. `danger` is for an
 * act that loses work; the button then says so in red.
 */
export function Confirm({ title, children, act, onAct, onClose, danger = false, busy = false, width = 520, disabled = false }: {
  title: string; children: ReactNode; act: string; onAct: () => void | Promise<unknown>; onClose: () => void;
  danger?: boolean; busy?: boolean; width?: number; disabled?: boolean;
}) {
  return (
    <Dialog title={title} onClose={onClose} width={width} footer={(
      <>
        <Button tone="quiet" onClick={onClose}>Cancel</Button>
        <Button tone={danger ? 'danger' : 'primary'} disabled={busy || disabled} onClick={onAct} data-autofocus={danger ? undefined : true}>{act}</Button>
      </>
    )}>
      {children}
    </Dialog>
  );
}
