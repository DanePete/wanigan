// Settings › Phone: Wanigan on the owner's phone, through their own Tailscale
// network. Says what Tailscale still needs, shows the one command it runs,
// pairs a phone by QR code, and lists the phones that can reach this computer.
import { useEffect, useRef, useState } from 'react';
import { PHONE_PORT, serveCommand, type PairingCode, type PhoneDevice, type PhoneStatus } from '@shared/phone';
import { attempt, call, useQuery } from '../lib/api';
import { ago, plural } from '../lib/format';
import { useHow } from '../lib/how';
import { HowArrow, HowBox, HowButton, HowDialog, HowLane, HowNote, howNum } from './How';
import { QrCode } from './QrCode';
import { Badge, Button, Dot, NotAnswering, Toggle, useToast } from './ui';
import { SettingRow, SettingsGroup, SettingsPage } from '../views/SettingsPage';

export function PhoneSettings() {
  const toast = useToast();
  const status = useQuery('phone.status', {}, ['phone']);
  const [busy, setBusy] = useState(false);
  const how = useHow('settings');
  const fail = (m: string): void => toast(m, 'error');
  const s = status.data;

  const run = async (method: 'phone.enable' | 'phone.disable'): Promise<void> => {
    setBusy(true);
    await attempt(() => call(method, {}), fail);
    setBusy(false);
    status.reload();
  };

  return (
    <SettingsPage id="set-phone" title="Phone" tools={<HowButton onClick={how.show} />}>
      {status.error ? <NotAnswering error={status.error} onRetry={status.reload} /> : !s ? null : (
        <>
          <SettingsGroup title="Reaching this computer">
            <TailscaleRow status={s} onCheck={() => status.reload()} />
            <AccessRow status={s} busy={busy} onEnable={() => run('phone.enable')} onDisable={() => run('phone.disable')} />
          </SettingsGroup>
          {s.url ? <SettingsGroup title="Pair a phone"><PairRow status={s} /></SettingsGroup> : null}
          {s.devices.length > 0 ? <Devices devices={s.devices} /> : null}
        </>
      )}
      {how.open ? <PhoneHow status={s ?? null} onClose={how.hide} /> : null}
    </SettingsPage>
  );
}

const TAILSCALE_DNS = 'https://login.tailscale.com/admin/dns';

function TailscaleRow({ status, onCheck }: { status: PhoneStatus; onCheck: () => void }) {
  const t = status.tailscale;
  if (t.state === 'ready') {
    return <SettingRow label={<><Dot tone="green" /> Tailscale</>} hint={`Tailscale is connected as ${t.dnsName}.`} />;
  }
  return (
    <SettingRow className="phone-needs"
      label={t.state === 'missing' ? 'Tailscale is not on this computer' : t.state === 'stopped' ? 'Tailscale is not connected' : 'Tailscale needs HTTPS turned on'}
      control={<Button size="s" icon="refresh" onClick={onCheck}>Check again</Button>}>
      {t.state === 'missing' ? (
        <ol className="phone-steps">
          <li>Install Tailscale on this computer from <a href="https://tailscale.com/download" target="_blank" rel="noreferrer">tailscale.com/download</a> and sign in. It is free for personal use.</li>
          <li>Install Tailscale on your phone from the App Store or Google Play, and sign in with the same account.</li>
          <li>Come back here and choose Check again.</li>
        </ol>
      ) : t.state === 'stopped' ? (
        <p className="setting-hint">Open Tailscale on this computer, sign in and connect, then choose Check again.</p>
      ) : (
        <p className="setting-hint">
          Your phone opens Wanigan at a private https address, and Tailscale only gives one when HTTPS certificates are on for your
          network. Turn them on in <a href={TAILSCALE_DNS} target="_blank" rel="noreferrer">Tailscale’s DNS settings</a> (MagicDNS too,
          if it asks), then choose Check again.
        </p>
      )}
    </SettingRow>
  );
}

function AccessRow({ status, busy, onEnable, onDisable }: { status: PhoneStatus; busy: boolean; onEnable: () => void; onDisable: () => void }) {
  const t = status.tailscale;
  const ready = t.state === 'ready';
  const command = <code className="phone-command">tailscale {serveCommand(PHONE_PORT).join(' ')}</code>;
  if (!status.enabled) {
    return (
      <SettingRow label="Phone access is off"
        hint={ready ? <>This runs {command}, which makes Wanigan reachable at https://{t.dnsName}/wanigan/ from your own devices on Tailscale, and only them. Anything else you serve with Tailscale is left as it is.</>
          : 'Once Tailscale is ready, this turns on in one step.'}
        control={<Button size="s" tone="primary" icon="phone" disabled={!ready || busy} onClick={onEnable}>Turn on phone access</Button>} />
    );
  }
  const problem = !status.listening ? 'Phone access is on, but it did not start on this computer.'
    : !ready ? 'Phone access is on, but your phone cannot reach it until Tailscale is ready.'
      : !t.serving ? 'Phone access is on, but Tailscale is no longer serving Wanigan.' : null;
  return (
    <SettingRow className={problem ? 'phone-needs' : undefined}
      label={problem ? <>{status.listening ? null : <Dot tone="red" />} Phone access needs a look</> : <><Dot tone="green" /> Phone access is on</>}
      hint={problem ?? <>At <span className="phone-url">{status.url}</span>, from your devices on Tailscale. Turning it off removes only Wanigan’s address from Tailscale; paired phones stay paired.</>}
      control={(
        <span className="settings-actions">
          {problem && ready ? <Button size="s" tone="primary" disabled={busy} onClick={onEnable}>Start it again</Button> : null}
          <Button size="s" tone="quiet" disabled={busy} onClick={onDisable}>Turn off</Button>
        </span>
      )} />
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
      toast(`${newest?.name ?? 'Your phone'} is paired.`, 'done');
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
      <SettingRow label="Pair a phone" hint="A code works once, for ten minutes. Your phone needs Tailscale on, signed in to the same account as this computer."
        control={<Button size="s" icon="phone" onClick={show}>Show a pairing code</Button>} />
    );
  }
  return (
    <SettingRow className="phone-pairing">
      <div className="phone-pairing-body" aria-live="polite">
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
              <p className="setting-hint">Works once, for {plural(left, 'more minute')}.</p>
            </>
          ) : <p>That code has expired. Show a new one to pair a phone.</p>}
          <div className="settings-actions">
            <Button size="s" onClick={show}>New code</Button>
            <Button size="s" tone="quiet" onClick={() => setCode(null)}>Done</Button>
          </div>
        </div>
      </div>
    </SettingRow>
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
    if (r.sent === pushing) toast(`Sent to ${plural(r.sent, 'phone')}. It should arrive within a few seconds.`, 'done');
    else fail(`Sent to ${r.sent} of ${plural(pushing, 'phone')}. A phone that did not take it may need its notifications turned on again.`);
  };

  return (
    <SettingsGroup title="Paired phones" className="phone-devices"
      actions={<Button size="s" tone="quiet" icon="bell" disabled={!pushing} onClick={test}>Send a test notification</Button>}
      note={pushing ? 'A phone with notifications on is told when something needs you, as this computer’s banners are.'
        : 'No paired phone has notifications on yet. On the phone, open This phone and tap Turn on notifications.'}>
      {devices.map((d) => (
        <SettingRow key={d.id}
          label={<span className="phone-device-name">{d.name}<Badge tone={d.push ? 'water' : 'neutral'}>{d.push ? 'Notifications on' : 'No notifications'}</Badge></span>}
          hint={`Paired ${ago(d.pairedAt)}; ${d.lastSeenAt ? `last here ${ago(d.lastSeenAt)}` : 'not back since'}. ${d.control ? 'It can start and type into sessions, answer what needs you, and move cards.' : 'It can only read.'}`}
          control={(
            <span className="settings-actions">
              <CanAct device={d} />
              {forgetting === d.id ? null : <Button size="s" tone="quiet" onClick={() => setForgetting(d.id)}>Forget</Button>}
            </span>
          )}>
          {forgetting === d.id ? (
            <div className="phone-forget" role="alert">
              <span>Forget {d.name}? It stops reaching this computer at once, and needs a new code to pair again.</span>
              <span className="settings-actions">
                <Button size="s" tone="danger" onClick={() => { setForgetting(null); void attempt(() => call('phone.forget', { id: d.id }), fail); }}>Forget</Button>
                <Button size="s" tone="quiet" onClick={() => setForgetting(null)}>Keep</Button>
              </span>
            </div>
          ) : null}
        </SettingRow>
      ))}
    </SettingsGroup>
  );
}

/** Whether a phone may act: changes at once, and goes back if this computer refuses. */
function CanAct({ device }: { device: PhoneDevice }) {
  const toast = useToast();
  const [on, setOn] = useState(device.control);
  useEffect(() => { setOn(device.control); }, [device.control]);
  const change = async (control: boolean): Promise<void> => {
    setOn(control);
    if (!(await attempt(() => call('phone.setControl', { id: device.id, control }), (m) => toast(m, 'error')))) setOn(device.control);
  };
  return <Toggle className="phone-can-act" checked={on} onChange={(c) => void change(c)} label="Can act" />;
}

/** How the phone works, as a picture: every sentence is a rule the core's phone gateway enforces. */
function PhoneHow({ status, onClose }: { status: PhoneStatus | null; onClose: () => void }) {
  const acting = status ? status.devices.filter((d) => d.control).length : null;
  return (
    <HowDialog place="settings" title="How the phone works" onClose={onClose}
      intro={<><strong>Wanigan on your phone, from this computer, over your own Tailscale network.</strong> Nothing is put on the internet, and there is no Wanigan server in between.</>}
      side={(
        <>
          <HowNote title="What a phone can do">
            <ul>
              <li><strong>Can act:</strong> see what needs you and answer it, start a session or type into one, and move cards.</li>
              <li><strong>Read only:</strong> sees the same, and is told why it cannot act.</li>
              <li>Forget a phone and it stops reaching this computer at once.</li>
            </ul>
          </HowNote>
          <HowNote title="Reading the picture" tone="quiet">
            <ul>
              <li>Numbers are live. A missing number means the core has not answered.</li>
            </ul>
          </HowNote>
        </>
      )}>
      <HowLane n={1} title="Reaching this computer" actor="you">
        <HowBox actor="you" title="Tailscale, on both" num={status ? (status.tailscale.state === 'ready' ? 'connected' : 'not ready') : null}>
          This computer and your phone on the same Tailscale account, with HTTPS certificates on for your network.
        </HowBox>
        <HowArrow label="you turn it on" />
        <HowBox actor="wanigan" title="One command" num={status ? (status.enabled ? 'on' : 'off') : null}>
          Wanigan runs tailscale serve for its own address only, under /wanigan/; anything else you serve is left as it is.
        </HowBox>
      </HowLane>
      <HowLane n={2} title="Pairing" actor="you">
        <HowBox actor="you" title="A code, once">
          Show a pairing code: it works once, for ten minutes, by its QR code or typed in.
        </HowBox>
        <HowArrow />
        <HowBox actor="you" title="The phone is paired" num={status ? howNum(status.devices.length, 'phone paired', 'phones paired') : null}>
          Named on the phone, listed here. Each can act unless you switch Can act off.
        </HowBox>
        <HowArrow />
        <HowBox actor="needs" title="Told when you are needed" num={status ? howNum(status.devices.filter((d) => d.push).length, 'with notifications', 'with notifications') : null}>
          A phone with notifications on is told when something needs you. On an iPhone, from the Home Screen app only.
        </HowBox>
      </HowLane>
      <HowLane n={3} title="Acting" actor="agents">
        <HowBox actor="you" title="From the phone" num={howNum(acting, 'can act', 'can act')}>
          Answer what needs you, start a session, type into a terminal, accept a card: the same rules as this window, enforced by the core.
        </HowBox>
      </HowLane>
    </HowDialog>
  );
}
