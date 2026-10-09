// Telling paired phones that something needs the owner: Web Push, encrypted to
// each phone (webpush-crypto.ts), by the same rules and in the same words as
// the Mac's own notifications (shared/notifications.ts). Apple's or Google's
// push service carries it and cannot read it.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { Need } from '../../shared/model.ts';
import { ALERT_KINDS, nativeBatch, needKey, notificationFor } from '../../shared/notifications.ts';
import { encryptPushPayload, generateVapidKeys, vapidAuthorization, vapidKeysValid, type VapidKeys } from './webpush-crypto.ts';
import type { PhoneDevices, PushTarget } from './devices.ts';

/** Who sends: the project, never anything of the owner's (Apple refuses a token without one). */
const SUBJECT = 'https://github.com/DanePete/wanigan';
/** A notification about a need older than this is not worth waking a phone for. */
const TTL_SECONDS = 60 * 60;

export type PushFetch = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: Buffer }) => Promise<{ status: number }>;

export class PhonePush {
  private keys: VapidKeys | null = null;
  private announced = new Set<string>();
  private readonly keysFile: string;
  private readonly devices: PhoneDevices;
  private readonly fetch: PushFetch;
  private readonly log: (line: string) => void;

  constructor(options: { keysFile: string; devices: PhoneDevices; fetch?: PushFetch; log?: (line: string) => void }) {
    this.keysFile = options.keysFile;
    this.devices = options.devices;
    this.fetch = options.fetch ?? ((url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(15_000) }));
    this.log = options.log ?? (() => {});
  }

  /** This Mac's push key, the phone's applicationServerKey; made once and kept owner-only. */
  publicKey(): string {
    return this.vapid().publicKey;
  }

  /**
   * Announce what newly needs the owner. The first call only learns what is
   * already open, so phones are not woken for old news when the core starts.
   */
  async announce(needs: readonly Need[], first = false): Promise<void> {
    const open = needs.filter((n) => ALERT_KINDS.has(n.kind));
    const fresh = first ? [] : open.filter((n) => !this.announced.has(needKey(n)));
    this.announced = new Set(open.map(needKey));
    if (!fresh.length) return;
    const targets = this.devices.pushTargets();
    if (!targets.length) return;
    const { single, rest } = nativeBatch(fresh);
    const messages = [...single.map((n) => ({ ...notificationFor(n), tag: needKey(n) })), ...(rest ? [{ ...rest, tag: 'more' }] : [])];
    for (const message of messages) await Promise.all(targets.map((t) => this.send(t, message)));
  }

  /** A test notification to every phone that takes them; how many the push services accepted. */
  async test(): Promise<number> {
    const results = await Promise.all(this.devices.pushTargets().map((t) => this.send(t, { title: 'Wanigan', body: 'Notifications reach this phone.', tag: 'test' })));
    return results.filter(Boolean).length;
  }

  /** One notification to one phone; whether the service took it. A subscription it says is gone is forgotten. */
  private async send(target: PushTarget, message: { title: string; body: string; tag: string }): Promise<boolean> {
    // Clipped before it is JSON: even three-byte characters stay inside one record.
    const payload = Buffer.from(JSON.stringify({ title: message.title.slice(0, 120), body: message.body.slice(0, 600), tag: message.tag.slice(0, 200) }), 'utf8');
    try {
      const body = encryptPushPayload(payload, { p256dh: target.p256dh, auth: target.auth });
      const res = await this.fetch(target.endpoint, {
        method: 'POST',
        headers: {
          Authorization: vapidAuthorization(this.vapid(), target.endpoint, SUBJECT),
          'Content-Encoding': 'aes128gcm',
          'Content-Type': 'application/octet-stream',
          TTL: String(TTL_SECONDS),
          Urgency: 'high',
        },
        body,
      });
      if (res.status === 404 || res.status === 410) this.devices.clearPush(target);
      else if (res.status >= 400) this.log(`phone push refused: ${res.status}`);
      return res.status < 300;
    } catch (error) {
      this.log(`phone push failed: ${(error as Error).message}`);
      return false;
    }
  }

  private vapid(): VapidKeys {
    if (this.keys) return this.keys;
    try {
      const saved = existsSync(this.keysFile) ? JSON.parse(readFileSync(this.keysFile, 'utf8')) as unknown : null;
      if (vapidKeysValid(saved)) return (this.keys = saved);
    } catch { /* unreadable: made again, and phones subscribe again */ }
    const keys = generateVapidKeys();
    const tmp = `${this.keysFile}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(keys), { mode: 0o600 });
    renameSync(tmp, this.keysFile);
    return (this.keys = keys);
  }
}
