// Settings › Phone: Wanigan on the owner's phone, through their own Tailscale
// network. Says what Tailscale still needs, shows the one command it runs,
// pairs a phone by QR code, and lists the phones that can reach this Mac.
import { useEffect, useRef, useState } from 'react';
import { PHONE_PORT, serveCommand, type PairingCode, type PhoneDevice, type PhoneStatus } from '@shared/phone';
import { attempt, call, useQuery } from '../lib/api';
import { ago, plural } from '../lib/format';
import { QrCode } from './QrCode';
import { Button, useToast } from './ui';

export function PhoneSettings() {
  const toast = useToast();
  const status = useQuery('phone.status', {}, ['phone']);
  const [busy, setBusy] = useState(false);
  const fail = (m: string): void => toast(m, 'error');
  const s = status.data;

  const run = async (method: 'phone.enable' | 'phone.disable'): Promise<void> => {
    setBusy(true);
    await attempt(() => call(method, {}), fail);
    setBusy(false);
    status.reload();
  };

  return (
    <section className="settings-group" aria-labelledby="set-phone">
      <header className="account-group-head">
        <h2 id="set-phone">Phone</h2>
      </header>
      <p className="lede">
        Use Wanigan from your phone: see what needs you and answer it, start a session or type into one, and move cards.
        Your phone reaches this Mac over your own Tailscale network, a private network between your devices: nothing is put
        on the internet, and there is no Wanigan server in between.
      </p>
      {!s ? null : (
        <>
          <TailscaleRow status={s} onCheck={() => status.reload()} />
          <AccessRow status={s} busy={busy} onEnable={() => run('phone.enable')} onDisable={() => run('phone.disable')} />
          {s.url ? <PairRow status={s} /> : null}
          {s.devices.length > 0 ? <Devices devices={s.devices} /> : null}
        </>
      )}
    </section>
  );
}

const TAILSCALE_DNS = 'https://login.tailscale.com/admin/dns';

function TailscaleRow({ status, onCheck }: { status: PhoneStatus; onCheck: () => void }) {
  const t = status.tailscale;
  const check = <Button size="s" icon="refresh" onClick={onCheck}>Check again</Button>;
  if (t.state === 'ready') {
    return <div className="settings-row"><p><span className="settings-label">Tailscale</span> <span className="faint">is connected as {t.dnsName}.</span></p></div>;
  }
  return (
    <div className="settings-row phone-needs">
      <div className="settings-line">
        <span className="settings-label">{t.state === 'missing' ? 'Tailscale is not on this Mac' : t.state === 'stopped' ? 'Tailscale is not connected' : 'Tailscale needs HTTPS turned on'}</span>
        {check}
      </div>
      {t.state === 'missing' ? (
        <ol className="phone-steps">
          <li>Install Tailscale on this Mac from <a href="https://tailscale.com/download" target="_blank" rel="noreferrer">tailscale.com/download</a> and sign in. It is free for personal use.</li>
          <li>Install Tailscale on your phone from the App Store or Google Play, and sign in with the same account.</li>
          <li>Come back here and choose Check again.</li>
        </ol>
      ) : t.state === 'stopped' ? (
        <p className="faint">Open Tailscale on this Mac, sign in and connect, then choose Check again.</p>
      ) : (
        <p className="faint">
          Your phone opens Wanigan at a private https address, and Tailscale only gives one when HTTPS certificates are on for your
          network. Turn them on in <a href={TAILSCALE_DNS} target="_blank" rel="noreferrer">Tailscale’s DNS settings</a> (MagicDNS too,
          if it asks), then choose Check again.
        </p>
      )}
    </div>
  );
}

function AccessRow({ status, busy, onEnable, onDisable }: { status: PhoneStatus; busy: boolean; onEnable: () => void; onDisable: () => void }) {
  const t = status.tailscale;
  const ready = t.state === 'ready';
  const command = <code className="phone-command">tailscale {serveCommand(PHONE_PORT).join(' ')}</code>;
  if (!status.enabled) {
    return (
      <div className="settings-row">
        <div className="settings-line">
          <span className="settings-label">Phone access is off</span>
          <Button size="s" tone="primary" icon="phone" disabled={!ready || busy} onClick={onEnable}>Turn on phone access</Button>
        </div>
        <p className="faint small">
          {ready ? <>This runs {command}, which makes Wanigan reachable at https://{t.dnsName}/wanigan/ from your own devices on Tailscale, and only them. Anything else you serve with Tailscale is left as it is.</>
            : 'Once Tailscale is ready, this turns on in one step.'}
        </p>
      </div>
    );
  }
  const problem = !status.listening ? 'Phone access is on, but it did not start on this Mac.'
    : !ready ? 'Phone access is on, but your phone cannot reach it until Tailscale is ready.'
      : !t.serving ? 'Phone access is on, but Tailscale is no longer serving Wanigan.' : null;
  return (
    <div className="settings-row">
      <div className="settings-line">
        <span className="settings-label">{problem ? 'Phone access needs a look' : 'Phone access is on'}</span>
        <div className="settings-actions">
          {problem && ready ? <Button size="s" tone="primary" disabled={busy} onClick={onEnable}>Start it again</Button> : null}
          <Button size="s" tone="quiet" disabled={busy} onClick={onDisable}>Turn off</Button>
        </div>
      </div>
      <p className="faint small">
        {problem ?? <>At <span className="phone-url">{status.url}</span>, from your devices on Tailscale. Turning it off removes only Wanigan’s address from Tailscale; paired phones stay paired.</>}
      </p>
    </div>
  );
}

function PairRow({ status }: { status: PhoneStatus }) {
  const toast = useToast();
  const [code, setCode] = useState<PairingCode | null>(null);
  const [now, setNow] = useState(Date.now());
  const paired = useRef(status.devices.length);

  // A new phone in the list while the code is showing is the phone that used it.
  useEffect(() => {
    if (code && status.devices.length > paired.current) {
      const newest = [...status.devices].sort((a, b) => b.pairedAt - a.pairedAt)[0];
      toast(`${newest?.name ?? 'Your phone'} is paired.`);
      setCode(null);
    }
    paired.current = status.devices.length;
  }, [status.devices, code, toast]);
  useEffect(() => {
    if (!code) return undefined;
    const tick = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(tick);
  }, [code]);

  const show = async (): Promise<void> => {
    const next = await attempt(() => call('phone.pairCode', {}), (m) => toast(m, 'error'));
    if (next) { setCode(next); setNow(Date.now()); }
  };
  const left = code ? Math.ceil((code.expiresAt - now) / 60_000) : 0;

  if (!code) {
    return (
      <div className="settings-row">
        <div className="settings-line">
          <span className="settings-label">Pair a phone</span>
          <Button size="s" tone="primary" icon="phone" onClick={show}>Show a pairing code</Button>
        </div>
        <p className="faint small">A code works once, for ten minutes. Your phone needs Tailscale on, signed in to the same account as this Mac.</p>
      </div>
    );
  }
  return (
    <div className="settings-row phone-pairing" aria-live="polite">
      <div className="phone-pairing-body">
        {code.url && left > 0 ? <QrCode text={code.url} label={`QR code that opens Wanigan on your phone with the code ${code.code}`} /> : null}
        <div className="phone-pairing-text">
          {left > 0 ? (
            <>
              <ol className="phone-steps">
                <li>With Tailscale on, point your phone’s camera at this code and open the link. Or open <span className="phone-url">{status.url}</span> and enter the code.</li>
                <li>On an iPhone, tap Share, then Add to Home Screen, open Wanigan from your Home Screen, and enter the code there. iPhones only send notifications to apps on the Home Screen.</li>
                <li>Name the phone and tap Pair.</li>
              </ol>
              <p className="phone-pair-code" aria-label={`Pairing code ${code.code.split('').join(' ')}`}>{code.code}</p>
              <p className="faint small">Works once, for {plural(left, 'more minute')}.</p>
            </>
          ) : <p>That code has expired. Show a new one to pair a phone.</p>}
          <div className="settings-actions">
            <Button size="s" onClick={show}>New code</Button>
            <Button size="s" tone="quiet" onClick={() => setCode(null)}>Done</Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Devices({ devices }: { devices: PhoneDevice[] }) {
  const toast = useToast();
  const [forgetting, setForgetting] = useState<string | null>(null);
  const fail = (m: string): void => toast(m, 'error');
  const pushing = devices.filter((d) => d.push).length;

  const test = async (): Promise<void> => {
    const r = await attempt(() => call('phone.testPush', {}), fail);
    if (!r) return;
    if (r.sent === pushing) toast(`Sent to ${plural(r.sent, 'phone')}. It should arrive within a few seconds.`);
    else fail(`Sent to ${r.sent} of ${plural(pushing, 'phone')}. A phone that did not take it may need its notifications turned on again.`);
  };

  return (
    <>
      <h3 className="settings-sub">Paired phones</h3>
      <ul className="phone-devices">
        {devices.map((d) => (
          <li key={d.id} className="settings-row">
            <div className="settings-line">
              <span>
                <span className="settings-label">{d.name}</span>{' '}
                <span className="tag">{d.push ? 'Notifications on' : 'No notifications'}</span>
              </span>
              <div className="settings-actions">
                <CanAct device={d} />
                {forgetting === d.id ? null : <Button size="s" tone="quiet" onClick={() => setForgetting(d.id)}>Forget</Button>}
              </div>
            </div>
            <p className="faint small">
              Paired {ago(d.pairedAt)}; {d.lastSeenAt ? `last here ${ago(d.lastSeenAt)}` : 'not back since'}.{' '}
              {d.control ? 'It can start and type into sessions, answer what needs you, and move cards.' : 'It can only read.'}
            </p>
            {forgetting === d.id ? (
              <div className="settings-line phone-forget" role="alert">
                <span>Forget {d.name}? It stops reaching this Mac at once, and needs a new code to pair again.</span>
                <div className="settings-actions">
                  <Button size="s" tone="danger" onClick={() => { setForgetting(null); void attempt(() => call('phone.forget', { id: d.id }), fail); }}>Forget</Button>
                  <Button size="s" tone="quiet" onClick={() => setForgetting(null)}>Keep</Button>
                </div>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      <div className="settings-line phone-test">
        <span className="faint small">
          {pushing ? `A phone with notifications on is told when something needs you, like this Mac’s banners.`
            : 'No paired phone has notifications on yet. On the phone, open This phone and tap Turn on notifications.'}
        </span>
        <Button size="s" icon="needs" disabled={!pushing} onClick={test}>Send a test notification</Button>
      </div>
    </>
  );
}

/** Whether a phone may act: changes at once, and goes back if the Mac refuses. */
function CanAct({ device }: { device: PhoneDevice }) {
  const toast = useToast();
  const [on, setOn] = useState(device.control);
  useEffect(() => { setOn(device.control); }, [device.control]);
  const change = async (control: boolean): Promise<void> => {
    setOn(control);
    if (!(await attempt(() => call('phone.setControl', { id: device.id, control }), (m) => toast(m, 'error')))) setOn(device.control);
  };
  return (
    <label className="check-row">
      <input type="checkbox" checked={on} onChange={(e) => void change(e.target.checked)} />
      <span>Can act</span>
    </label>
  );
}
