// This phone: its name and what it may do, notifications, and forgetting it.
// Notifications are Web Push: the browser makes a subscription with the Mac's
// key, and the Mac sends to it, encrypted to this phone.
import { useState } from 'react';
import { Button, useToast } from '../components/ui';
import { attempt, call, useQuery } from '../lib/api';
import type { PhoneLink } from './bridge';

type PushState = 'unsupported' | 'blocked' | 'off' | 'on';

function pushSupport(): PushState {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
  return Notification.permission === 'denied' ? 'blocked' : 'off';
}

export function ThisPhone({ link }: { link: PhoneLink }) {
  const toast = useToast();
  const me = useQuery('phone.me', {}, ['phone']);
  const [push, setPush] = useState<PushState>(pushSupport);
  const device = me.data?.device;
  const on = device?.push && push !== 'blocked' ? 'on' : push;

  const subscribe = async (): Promise<void> => {
    if (!me.data?.pushKey) return;
    if (await Notification.requestPermission() !== 'granted') { setPush('blocked'); return; }
    const registration = await navigator.serviceWorker.ready;
    const sub = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64url(me.data.pushKey) });
    const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
    if (await attempt(() => call('phone.subscribe', { endpoint: json.endpoint, p256dh: json.keys?.p256dh, auth: json.keys?.auth }), (m) => toast(m, 'error'))) {
      setPush('on');
      toast('Notifications are on. Send a test one from Settings › Phone on your Mac.');
      me.reload();
    }
  };
  const unsubscribe = async (): Promise<void> => {
    const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
    await sub?.unsubscribe();
    if (await attempt(() => call('phone.subscribe', {}), (m) => toast(m, 'error'))) { setPush('off'); me.reload(); }
  };

  return (
    <section className="phone-form" aria-labelledby="phone-title">
      <h1 id="phone-title" className="phone-title">This phone</h1>
      {device ? <p><strong>{device.name}</strong>, paired with your Mac. {device.control ? 'It can start and work in sessions and move cards.' : 'It may only read; your Mac can let it act in Settings › Phone.'}</p> : null}
      <h2 className="phone-subtitle">Notifications</h2>
      {on === 'unsupported' ? <p className="faint">This browser cannot take notifications. On an iPhone, add Wanigan to your Home Screen and open it from there.</p> : null}
      {on === 'blocked' ? <p className="faint">Notifications are turned off for Wanigan in this phone’s settings.</p> : null}
      {on === 'off' ? <Button tone="primary" icon="needs" onClick={subscribe}>Turn on notifications</Button> : null}
      {on === 'on' ? <><p>On: this phone is told when something needs you.</p><Button tone="quiet" onClick={unsubscribe}>Turn off</Button></> : null}
      <h2 className="phone-subtitle">Pairing</h2>
      <p className="faint">To stop this phone reaching your Mac, forget it in Settings › Phone on the Mac. Unpairing here only forgets it on this phone.</p>
      <Button tone="danger" onClick={() => link.unpair()}>Unpair here</Button>
    </section>
  );
}

/** The Mac's key as bytes: what every browser takes as applicationServerKey. */
function base64url(text: string): ArrayBuffer {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=');
  return Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)).buffer;
}
