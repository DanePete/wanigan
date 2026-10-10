// Settings › Accounts: one place for every agent account. Each is a folder the
// CLI keeps its sign-in in; who it is signed in as comes from the CLI itself.
import { useEffect, useState } from 'react';
import { ACCOUNT_PROVIDERS, type Account, type AccountProvider, type ProjectSummary } from '@shared/model';
import { resetWords } from '../components/LimitsLeft';
import type { AccountUsage } from '@shared/usage';
import { attempt, call, useQuery } from '../lib/api';
import { ago } from '../lib/format';
import { useHow } from '../lib/how';
import { Badge, Button, Dialog, Dot, Field, NotAnswering, ProjectMark, useSingleFlight, useToast } from '../components/ui';
import { HowArrow, HowBox, HowButton, HowDialog, HowLane, HowNote, howNum } from '../components/How';
import { Icon } from '../components/icons';
import { MenuButton } from '../components/Menu';
import { Terminal } from '../components/Terminal';
import { InstallHint } from '../components/Install';
import { SettingRow, SettingsGroup, SettingsPage } from './SettingsPage';

const AGENT: Record<AccountProvider, string> = { claude: 'Claude Code', codex: 'Codex' };

export function AccountsView({ projects }: { projects: ProjectSummary[] | undefined }) {
  const accounts = useQuery('accounts.list', {}, ['accounts']);
  const toast = useToast();
  const how = useHow('accounts');
  const [checking, setChecking] = useState(false);
  const [adding, setAdding] = useState<AccountProvider | null>(null);
  const [signingIn, setSigningIn] = useState<Account | null>(null);
  const checked = Math.max(0, ...(accounts.data ?? []).map((a) => a.checkedAt ?? 0));

  const check = async (): Promise<void> => {
    setChecking(true);
    const again = { action: { label: 'Retry', run: () => void check() } };
    const who = await attempt(() => call('accounts.refresh', {}), (m) => toast(m, 'error', again));
    const limits = await attempt(() => call('accounts.refreshUsage', { force: true }), (m) => toast(m, 'error', again));
    setChecking(false);
    if (who && limits) toast('Checked every account with its agent.', 'done');
  };

  // Limits move fast; read any that are stale when the page opens.
  useEffect(() => { void call('accounts.refreshUsage', {}).catch(() => {}); }, []);

  return (
    <SettingsPage id="accounts-title" title="Accounts" width="l"
      meta={<span className="settings-meta" aria-live="polite">{checking ? 'Asking each agent…' : checked ? `Checked ${ago(checked)}` : ''}</span>}
      tools={(
        <>
          <HowButton onClick={how.show} />
          <Button size="s" icon="refresh" onClick={() => check()} disabled={checking} data-tour="accounts-check">Check again</Button>
        </>
      )}>
      {accounts.error ? <NotAnswering error={accounts.error} onRetry={accounts.reload} /> : ACCOUNT_PROVIDERS.map((provider, i) => {
        const list = (accounts.data ?? []).filter((a) => a.provider === provider);
        return (
          <SettingsGroup key={provider} title={AGENT[provider]} className={`account-group account-group-${provider}`} tour={i === 0 ? 'accounts-list' : undefined}
            actions={<Button size="s" tone="quiet" icon="plus" className="account-add" onClick={() => setAdding(provider)} data-tour={i === 0 ? 'accounts-add' : undefined}>Add account</Button>}>
            {list.length ? list.map((a, j) => (
              <AccountRow key={a.id} account={a} projects={projects} onSignIn={() => setSigningIn(a)} tour={i === 0 && j === 0} />
            )) : accounts.data ? <SettingRow hint={`No ${AGENT[provider]} accounts yet. Add one to sign in with its own folder.`} /> : null}
          </SettingsGroup>
        );
      })}
      {adding ? (
        <AddAccountDialog provider={adding} onClose={() => setAdding(null)} onAdded={(a) => { setAdding(null); setSigningIn(a); }} />
      ) : null}
      {signingIn ? <SignInDialog account={signingIn} onClose={() => setSigningIn(null)} /> : null}
      {how.open ? <AccountsHow accounts={accounts.data ?? null} projects={projects ?? null} onClose={how.hide} /> : null}
    </SettingsPage>
  );
}

function AccountRow({ account: a, projects, onSignIn, tour }: { account: Account; projects: ProjectSummary[] | undefined; onSignIn: () => void; tour: boolean }) {
  const toast = useToast();
  const fail = (m: string): void => toast(m, 'error');
  const [renaming, setRenaming] = useState(false);
  const [label, setLabel] = useState(a.label);
  const usedBy = (projects ?? []).filter((p) => p.accounts[a.provider] === a.id || (a.isDefault && !p.accounts[a.provider]));
  // Not installed is a step not taken yet, not a fault: a neutral mark, never a green one.
  const status = !a.installed ? { tone: 'faint', text: `${AGENT[a.provider]} is not installed` }
    : !a.folderOk ? { tone: 'red', text: 'Folder missing' }
    : a.signedIn === 'yes' ? { tone: 'green', text: [a.identity, a.plan && `${a.plan} plan`].filter(Boolean).join(' · ') || 'Signed in' }
      : a.signedIn === 'no' ? { tone: usedBy.length ? 'amber' : 'faint', text: usedBy.length ? 'Signed out, and a project uses it' : 'Signed out' }
        : { tone: 'faint', text: a.checkedAt ? 'Could not tell whether this account is signed in' : 'Checking…' };
  const dot = status.tone === 'green' ? 'green' : status.tone === 'red' ? 'red' : status.tone === 'amber' ? 'amber' : 'muted';
  const remove = (): void => {
    void attempt(() => call('accounts.remove', { id: a.id }), fail).then((r) => { if (r) toast(`${a.label} removed. Its folder ${a.displayDir} was left as it is.`); });
  };

  return (
    <SettingRow className="account"
      label={renaming ? (
        <form className="account-rename" onSubmit={(e) => { e.preventDefault(); void attempt(() => call('accounts.rename', { id: a.id, label }), fail).then((r) => { if (r) setRenaming(false); }); }}>
          <label className="visually-hidden" htmlFor={`rename-${a.id}`}>Account name</label>
          <input id={`rename-${a.id}`} value={label} onChange={(e) => setLabel(e.target.value)} autoFocus onKeyDown={(e) => { if (e.key === 'Escape') { setRenaming(false); setLabel(a.label); } }} />
          <Button size="s" tone="primary" type="submit">Save</Button>
          <Button size="s" tone="quiet" onClick={() => { setRenaming(false); setLabel(a.label); }}>Cancel</Button>
        </form>
      ) : (
        <span className="account-name"><Dot tone={dot} />{a.label}{a.isDefault ? <Badge>Default</Badge> : null}</span>
      )}
      hint={<span className={`account-status status-${status.tone}`}>{status.text}</span>}
      control={(
        <span className="account-actions">
          {a.installed ? (
            <Button size="s" tone={a.signedIn === 'no' && usedBy.length ? 'attention' : 'plain'} onClick={onSignIn} data-tour={tour ? 'accounts-signin' : undefined}>
              {a.signedIn === 'yes' ? 'Open sign-in' : 'Sign in'}
            </Button>
          ) : null}
          {!a.isDefault ? <Button size="s" tone="quiet" onClick={() => attempt(() => call('accounts.makeDefault', { id: a.id }), fail)}>Make default</Button> : null}
          <MenuButton className="btn-quiet btn-icon btn-icon-s account-more" label={`More for ${a.label}`} tip="More" align="end" width={240}
            items={[
              { id: 'rename', label: 'Rename', icon: 'pencil', run: () => setRenaming(true) },
              ...(!a.isDefault ? [{ id: 'remove', label: 'Remove from Wanigan', detail: 'Its folder is left as it is', icon: 'trash' as const, run: remove }] : []),
            ]}>
            <Icon name="more" size={14} />
          </MenuButton>
        </span>
      )}>
      {!a.installed ? <p className="small"><InstallHint cli={a.provider} /> Then press Check again.</p> : null}
      {a.sameLoginAs ? <p className="small account-twin">Same login as {a.sameLoginAs}: they share one set of limits.</p> : null}
      {a.usage ? <UsageMeters usage={a.usage} /> : null}
      <p className="account-dir mono">{a.displayDir}</p>
      {usedBy.length ? (
        <p className="account-used">Used by {usedBy.map((p) => <ProjectMark key={p.id} projectKey={p.key} size="s" />)}</p>
      ) : null}
    </SettingRow>
  );
}

function AddAccountDialog({ provider, onClose, onAdded }: { provider: AccountProvider; onClose: () => void; onAdded: (a: Account) => void }) {
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const once = useSingleFlight();
  const add = (): Promise<void> => once(async () => {
    const account = await attempt(() => call('accounts.add', { provider, label }), setError);
    if (account) onAdded(account);
  });
  return (
    <Dialog title={`Add a ${AGENT[provider]} account`} onClose={onClose}
      footer={<><Button tone="quiet" onClick={onClose}>Cancel</Button><Button tone="primary" onClick={() => add()} disabled={!label.trim()}>Add and sign in</Button></>}>
      <p className="faint">Wanigan makes a new folder in your home for this account, then opens {AGENT[provider]} there so you can sign in.</p>
      <Field label="Name" hint="Something you will recognise, like “Work” or “Client: Northstar”." error={error}>{(id) => (
        <input id={id} value={label} onChange={(e) => { setLabel(e.target.value); setError(null); }} onKeyDown={(e) => { if (e.key === 'Enter') void add(); }} />
      )}</Field>
    </Dialog>
  );
}

function SignInDialog({ account, onClose }: { account: Account; onClose: () => void }) {
  const toast = useToast();
  const [terminal, setTerminal] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    // The sign-in terminal lives exactly as long as this dialog, however it closes.
    let gone = false;
    let id: string | null = null;
    const stop = (): void => { if (id) void call('sessions.stop', { id }).catch(() => {}); };
    void attempt(() => call('accounts.signIn', { id: account.id, cols: 100, rows: 26 }), setFailed).then((r) => {
      if (!r) return;
      id = r.terminalId;
      if (gone) stop(); else setTerminal(id);
    });
    return () => { gone = true; stop(); };
  }, [account.id]);
  const close = (): void => {
    void call('accounts.refresh', {}).catch(() => {});
    onClose();
  };
  return (
    <Dialog title={`Sign in: ${account.label}`} onClose={close} width={820}
      footer={<><span className="dialog-hint mono">{account.displayDir}</span><Button tone="primary" onClick={() => { toast('Checking the account again.'); close(); }}>Done</Button></>}>
      <p className="faint small">
        {account.provider === 'claude'
          ? 'Claude Code is running with this account’s folder. Follow its prompts, or type /login. Your browser opens to finish signing in.'
          : 'Codex is signing in with this account’s folder. Your browser opens to finish; this terminal closes when it is done.'}
      </p>
      {failed ? <p className="error-text" role="alert">{failed}</p> : null}
      <div className="signin-terminal">{terminal ? <Terminal sessionId={terminal} live /> : <p className="faint signin-wait">Starting {account.provider === 'claude' ? 'Claude Code' : 'Codex'}…</p>}</div>
    </Dialog>
  );
}

/** What the account has left, as the CLI reported it. One row per limit window. */
function UsageMeters({ usage }: { usage: AccountUsage }) {
  if (usage.state === 'signed-out') return null;
  if (usage.state === 'unreadable') return <p className="small account-twin">Could not read its limits. {usage.note}</p>;
  return (
    <div className="meters">
      {usage.windows.map((w) => (
        <div key={`${w.kind}-${w.scope ?? 'all'}`} className={`meter${w.usedPercent >= 100 ? ' full' : ''}`}>
          <span className="meter-label">{w.kind === 'session' ? 'Session' : 'Week'}{w.scope ? ` (${w.scope})` : ''}</span>
          <span className="meter-bar" role="meter" aria-valuenow={w.usedPercent} aria-valuemin={0} aria-valuemax={100}
            aria-label={`${w.kind}${w.scope ? ` ${w.scope}` : ''} ${w.usedPercent}% used`}>
            <span style={{ width: `${Math.min(100, w.usedPercent)}%` }} />
          </span>
          <span className="meter-value">{w.usedPercent >= 100 ? 'used up' : `${Math.round(w.usedPercent)}% used`}</span>
          <span className="meter-reset">{w.resetsAt ? `resets ${resetWords(w.resetsAt)}` : w.resetsAtText ? `resets ${w.resetsAtText}` : ''}</span>
        </div>
      ))}
      <span className="meter-checked">read {ago(usage.checkedAt)}{usage.note ? `. ${usage.note}` : ''}</span>
    </div>
  );
}

/** How accounts work, as a picture: every sentence is a rule the core enforces (core/accounts.ts, sessions, limits). */
function AccountsHow({ accounts, projects, onClose }: { accounts: Account[] | null; projects: ProjectSummary[] | null; onClose: () => void }) {
  const signedIn = accounts ? accounts.filter((a) => a.signedIn === 'yes').length : null;
  const own = projects ? projects.filter((p) => Object.values(p.accounts).some(Boolean)).length : null;
  return (
    <HowDialog place="accounts" title="How accounts work" onClose={onClose}
      intro={<><strong>An account is a folder your agent keeps its sign-in in.</strong> Wanigan asks the agent who it is signed in as; it never holds, reads or copies a password or a token.</>}
      side={(
        <>
          <HowNote title="What each agent reads" tone="quiet">
            <ul>
              <li><strong>Claude Code:</strong> the folder is its <code>CLAUDE_CONFIG_DIR</code>. Your usual one, <code>~/.claude</code>, sets nothing at all.</li>
              <li><strong>Codex:</strong> the folder is its <code>CODEX_HOME</code>.</li>
              <li>A variable your shell exported is taken out for the session, so it runs as the account you chose.</li>
            </ul>
          </HowNote>
          <HowNote title="Needs you, in amber" tone="needs">
            <ul>
              <li><strong>Signed out, and a project uses it:</strong> sign in before that project’s next session; Sign in is amber on its row.</li>
            </ul>
          </HowNote>
        </>
      )}>
      <HowLane n={1} title="Which accounts" actor="you">
        <HowBox actor="you" title="Found, or added" num={howNum(accounts?.length, 'account', 'accounts')}>
          Your agents’ usual folders are found by themselves. Add account makes a new folder in your home and opens the agent there to sign in.
        </HowBox>
        <HowArrow />
        <HowBox actor="agents" title="Who it is" num={howNum(signedIn, 'signed in', 'signed in')}>
          Asked of the agent itself, with its plan and what its limits have left. Two folders on one login share one set of limits, and say so.
        </HowBox>
      </HowLane>
      <HowLane n={2} title="Which one a session uses" actor="board">
        <HowBox actor="you" title="The project’s choice" num={howNum(own, 'project chooses', 'projects choose')}>
          Set in the project’s settings, from its name’s menu. You can still pick another when you start a session.
        </HowBox>
        <HowArrow label="else" />
        <HowBox actor="board" title="Your default">
          Every project that has not chosen uses the default. Make default changes it for sessions that start after.
        </HowBox>
        <HowArrow />
        <HowBox actor="agents" title="The session runs as it">
          The agent starts with that account’s folder. A running session keeps the account it started with.
        </HowBox>
      </HowLane>
      <HowLane n={3} title="When one runs out" actor="needs">
        <HowBox actor="needs" title="Out of its limit">
          A Claude Code conversation can carry on under another account with room; a Codex conversation stays in the account it lives in.
        </HowBox>
      </HowLane>
    </HowDialog>
  );
}

