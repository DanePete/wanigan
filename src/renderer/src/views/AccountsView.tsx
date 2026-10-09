// One place for every agent account. Each is a folder the CLI keeps its sign-in
// in; who it is signed in as comes from the CLI itself.
import { useEffect, useState } from 'react';
import { ACCOUNT_PROVIDERS, type Account, type AccountProvider, type ProjectSummary } from '@shared/model';
import { resetWords } from '../components/LimitsLeft';
import type { AccountUsage } from '@shared/usage';
import { attempt, call, useQuery } from '../lib/api';
import { ago } from '../lib/format';
import { Button, Dialog, Empty, Field, NotAnswering, ProjectMark, useSingleFlight, useToast } from '../components/ui';
import { Terminal } from '../components/Terminal';
import { InstallHint } from '../components/Install';

const AGENT: Record<AccountProvider, string> = { claude: 'Claude Code', codex: 'Codex' };

export function AccountsView({ projects }: { projects: ProjectSummary[] | undefined }) {
  const accounts = useQuery('accounts.list', {}, ['accounts']);
  const toast = useToast();
  const [checking, setChecking] = useState(false);
  const [adding, setAdding] = useState<AccountProvider | null>(null);
  const [signingIn, setSigningIn] = useState<Account | null>(null);
  const checked = Math.max(0, ...(accounts.data ?? []).map((a) => a.checkedAt ?? 0));

  const check = async (): Promise<void> => {
    setChecking(true);
    const again = { action: { label: 'Retry', run: () => void check() } };
    await attempt(() => call('accounts.refresh', {}), (m) => toast(m, 'error', again));
    await attempt(() => call('accounts.refreshUsage', { force: true }), (m) => toast(m, 'error', again));
    setChecking(false);
  };

  // Limits move fast; read any that are stale when the page opens.
  useEffect(() => { void call('accounts.refreshUsage', {}).catch(() => {}); }, []);

  return (
    <section className="view" aria-labelledby="accounts-title">
      <header className="topbar">
        <div className="topbar-title"><h1 id="accounts-title">Accounts</h1></div>
        <div className="topbar-tools">
          <span className="faint small">{checking ? 'Checking…' : checked ? `Checked ${ago(checked)}` : ''}</span>
          <Button tone="quiet" icon="refresh" onClick={() => check()} disabled={checking}>Check again</Button>
        </div>
      </header>
      <div className="view-body">
        <div className="view-pad accounts">
          <p className="lede">
            Each account is a folder your agent keeps its sign-in in. Wanigan asks the agent who it is signed in as; it never sees a password or a token.
            Choose which account a project uses in that project’s settings.
          </p>
          {accounts.error ? <NotAnswering error={accounts.error} onRetry={accounts.reload} /> : ACCOUNT_PROVIDERS.map((provider) => {
            const list = (accounts.data ?? []).filter((a) => a.provider === provider);
            return (
              <section key={provider} className="account-group" aria-labelledby={`acct-${provider}`}>
                <header className="account-group-head">
                  <h2 id={`acct-${provider}`}>{AGENT[provider]}</h2>
                  <Button size="s" icon="plus" onClick={() => setAdding(provider)}>Add account</Button>
                </header>
                {list.length ? (
                  <ul className="account-list">
                    {list.map((a) => <AccountRow key={a.id} account={a} projects={projects} onSignIn={() => setSigningIn(a)} />)}
                  </ul>
                ) : accounts.data ? <Empty title={`No ${AGENT[provider]} accounts`} /> : null}
              </section>
            );
          })}
        </div>
      </div>
      {adding ? (
        <AddAccountDialog provider={adding} onClose={() => setAdding(null)} onAdded={(a) => { setAdding(null); setSigningIn(a); }} />
      ) : null}
      {signingIn ? <SignInDialog account={signingIn} onClose={() => setSigningIn(null)} /> : null}
    </section>
  );
}

function AccountRow({ account: a, projects, onSignIn }: { account: Account; projects: ProjectSummary[] | undefined; onSignIn: () => void }) {
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

  return (
    <li className="account">
      <span className={`account-dot dot-${status.tone}`} aria-hidden="true" />
      <div className="account-main">
        {renaming ? (
          <form className="account-rename" onSubmit={(e) => { e.preventDefault(); void attempt(() => call('accounts.rename', { id: a.id, label }), fail).then((r) => { if (r) setRenaming(false); }); }}>
            <label className="visually-hidden" htmlFor={`rename-${a.id}`}>Account name</label>
            <input id={`rename-${a.id}`} value={label} onChange={(e) => setLabel(e.target.value)} autoFocus onKeyDown={(e) => { if (e.key === 'Escape') { setRenaming(false); setLabel(a.label); } }} />
            <Button size="s" tone="primary" type="submit">Save</Button>
          </form>
        ) : (
          <p className="account-name">{a.label}{a.isDefault ? <span className="badge">Default</span> : null}</p>
        )}
        <p className={`account-status status-${status.tone}`}>{status.text}</p>
        {!a.installed ? <p className="small"><InstallHint cli={a.provider} /> Then press Check again.</p> : null}
        {a.sameLoginAs ? <p className="small account-twin">Same login as {a.sameLoginAs}: they share one set of limits.</p> : null}
        {a.usage ? <UsageMeters usage={a.usage} /> : null}
        <p className="account-dir mono faint">{a.displayDir}</p>
        {usedBy.length ? (
          <p className="account-used faint">Used by {usedBy.map((p) => <ProjectMark key={p.id} projectKey={p.key} size="s" />)}</p>
        ) : null}
      </div>
      <div className="account-actions">
        {a.installed ? <Button size="s" tone={a.signedIn === 'no' && usedBy.length ? 'attention' : 'plain'} onClick={onSignIn}>{a.signedIn === 'yes' ? 'Open sign-in' : 'Sign in'}</Button> : null}
        {!a.isDefault ? <Button size="s" tone="quiet" onClick={() => attempt(() => call('accounts.makeDefault', { id: a.id }), fail)}>Make default</Button> : null}
        <Button size="s" tone="quiet" onClick={() => setRenaming(true)}>Rename</Button>
        {!a.isDefault ? <Button size="s" tone="quiet" onClick={() => attempt(() => call('accounts.remove', { id: a.id }), fail).then((r) => { if (r) toast(`${a.label} removed. Its folder ${a.displayDir} was left as it is.`); })}>Remove</Button> : null}
      </div>
    </li>
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
      <Field label="Name" hint="Something you will recognise, like “Work” or “Client: Northstar”.">{(id) => (
        <input id={id} value={label} onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void add(); }} />
      )}</Field>
      {error ? <p className="error-text" role="alert">{error}</p> : null}
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
      footer={<><span className="dialog-hint">{account.displayDir}</span><Button tone="primary" onClick={() => { toast('Checking the account again.'); close(); }}>Done</Button></>}>
      <p className="faint small">
        {account.provider === 'claude'
          ? 'Claude Code is running with this account’s folder. Follow its prompts, or type /login. Your browser opens to finish signing in.'
          : 'Codex is signing in with this account’s folder. Your browser opens to finish; this terminal closes when it is done.'}
      </p>
      {failed ? <p className="error-text" role="alert">{failed}</p> : null}
      <div className="signin-terminal">{terminal ? <Terminal sessionId={terminal} live /> : <p className="faint">Starting…</p>}</div>
    </Dialog>
  );
}

/** What the account has left, as the CLI reported it. One row per limit window. */
function UsageMeters({ usage }: { usage: AccountUsage }) {
  if (usage.state === 'signed-out') return null;
  if (usage.state === 'unreadable') return <p className="faint small">Could not read its limits. {usage.note}</p>;
  return (
    <div className="meters" title={usage.note ?? undefined}>
      {usage.windows.map((w) => (
        <div key={`${w.kind}-${w.scope ?? 'all'}`} className={`meter${w.usedPercent >= 100 ? ' full' : ''}`}>
          <span className="meter-label">{w.kind === 'session' ? 'Session' : 'Week'}{w.scope ? ` (${w.scope})` : ''}</span>
          <span className="meter-bar" role="meter" aria-valuenow={w.usedPercent} aria-valuemin={0} aria-valuemax={100}
            aria-label={`${w.kind}${w.scope ? ` ${w.scope}` : ''} ${w.usedPercent}% used`}>
            <span style={{ width: `${w.usedPercent}%` }} />
          </span>
          <span className="meter-value">{w.usedPercent >= 100 ? 'used up' : `${Math.round(w.usedPercent)}% used`}</span>
          <span className="meter-reset faint">{w.resetsAt ? `resets ${resetWords(w.resetsAt)}` : w.resetsAtText ? `resets ${w.resetsAtText}` : ''}</span>
        </div>
      ))}
      <span className="faint meter-checked">read {ago(usage.checkedAt)}{usage.note ? `. ${usage.note}` : ''}</span>
    </div>
  );
}
