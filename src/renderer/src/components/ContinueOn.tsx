// A session stopped by its account's usage limit: carry its conversation on
// under another account with room, or wait for the reset. The accounts offered
// are the ones the core would accept (shared/limits.ts decides both).
import { Select } from './Select';
import { useEffect, useState } from 'react';
import { continueTargets } from '@shared/limits';
import { attempt, call, useQuery } from '../lib/api';
import { navigate } from '../lib/router';
import { Button, useToast } from './ui';

export function ContinueOn({ sessionId, accountId, projectKey }: { sessionId: string; accountId: string | null; projectKey: string }) {
  const toast = useToast();
  const accounts = useQuery('accounts.list', {}, ['accounts']);
  const [chosen, setChosen] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  // Reads only the limits that are out of date; a reading is not a model turn.
  useEffect(() => { void call('accounts.refreshUsage', {}).catch(() => {}); }, []);

  const targets = continueTargets(accounts.data ?? [], accountId);
  const target = targets.find((t) => t.account.id === chosen) ?? targets[0];
  const wait = (): Promise<void> => attempt(() => call('sessions.seen', { id: sessionId }), (m) => toast(m, 'error'))
    .then((r) => { if (r) toast('Left to wait. Claude carries on by itself after the reset if it can; otherwise press Enter in its terminal.'); });

  if (accounts.error) {
    return (
      <>
        <span className="small error-text">Wanigan could not list your accounts: {accounts.error.message}</span>
        <Button size="s" tone="quiet" icon="refresh" onClick={accounts.reload}>Retry</Button>
        <Button size="s" tone="quiet" onClick={wait}>Wait for the reset</Button>
      </>
    );
  }
  if (!accounts.data) return null;
  if (!target) {
    return (
      <>
        <span className="faint small">No other Claude account has room.</span>
        <Button size="s" tone="quiet" onClick={wait}>Wait for the reset</Button>
      </>
    );
  }
  if (confirming) {
    return (
      <>
        <span className="small continue-confirm">Stop this session and carry the conversation on as {target.account.label}? All of it is sent again, on that account.</span>
        <Button size="s" tone="primary" disabled={busy} onClick={() => {
          setBusy(true);
          void attempt(() => call('sessions.continueOn', { id: sessionId, accountId: target.account.id }), (m) => toast(m, 'error'))
            .then((s) => { setBusy(false); setConfirming(false); if (s) navigate({ name: 'session', projectKey, sessionId: s.id }); });
        }}>Continue</Button>
        <Button size="s" tone="quiet" onClick={() => setConfirming(false)}>Cancel</Button>
      </>
    );
  }
  return (
    <>
      {targets.length > 1 ? (
        <Select className="continue-pick" label="Account to continue on" size="s" value={target.account.id} onChange={setChosen}
          options={targets.map((t) => ({ value: t.account.id, label: t.account.label, detail: t.room }))} />
      ) : null}
      <Button size="s" tone="primary" icon="resume" title={target.room} onClick={() => setConfirming(true)}>Continue on {target.account.label}</Button>
      <Button size="s" tone="quiet" onClick={wait}>Wait for the reset</Button>
    </>
  );
}
