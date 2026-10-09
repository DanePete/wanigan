// Phone access, as Settings › Phone switches it: the gateway on loopback,
// Tailscale's mount on the owner's private address, paired devices, and
// notifications. Off until the owner turns it on; kept on across restarts.
import { join } from 'node:path';
import type { Need } from '../../shared/model.ts';
import { PHONE_PATH, PHONE_PORT, type PairingCode, type PhoneDevice, type PhoneStatus } from '../../shared/phone.ts';
import { CoreError } from '../../shared/protocol.ts';
import type { Ctx } from '../context.ts';
import { PhoneDevices } from './devices.ts';
import { Gateway } from './gateway.ts';
import { PhonePush, type PushFetch } from './push.ts';
import { Tailscale } from './tailscale.ts';

const ENABLED = 'phone_enabled';

export interface PhoneOptions {
  dataDir: string;
  /** The built renderer, holding phone.html; null where there is none (a core run from source). */
  rendererDir: string | null;
  port?: number;
  tailscale?: Tailscale;
  pushFetch?: PushFetch;
  /** One core method, called as a paired phone. */
  call: (device: PhoneDevice, method: string, params: unknown) => Promise<unknown>;
  onEvent: (listener: (event: string, data: unknown) => void) => () => void;
  onData: (listener: (sessionId: string, seq: number, data: string) => void) => () => void;
  needs: () => Need[];
  log?: (line: string) => void;
}

export class Phone {
  readonly devices: PhoneDevices;
  private readonly ctx: Ctx;
  private readonly options: PhoneOptions;
  private readonly gateway: Gateway;
  private readonly tailscale: Tailscale;
  private readonly push: PhonePush;
  private readonly port: number;
  private hostName: string | null = null;
  private offNeeds: (() => void) | null = null;
  private needsTimer: NodeJS.Timeout | null = null;
  private generation = 0;
  private closed = false;
  private localChanges: Promise<void> = Promise.resolve();
  private mountChanges: Promise<void> = Promise.resolve();

  constructor(ctx: Ctx, options: PhoneOptions) {
    this.ctx = ctx;
    this.options = options;
    this.port = options.port ?? PHONE_PORT;
    this.devices = new PhoneDevices(ctx);
    this.tailscale = options.tailscale ?? new Tailscale();
    this.push = new PhonePush({
      keysFile: join(options.dataDir, 'phone-push.json'), devices: this.devices,
      ...(options.pushFetch ? { fetch: options.pushFetch } : {}), ...(options.log ? { log: options.log } : {}),
    });
    this.gateway = new Gateway({
      rendererDir: options.rendererDir,
      device: (token) => this.devices.byToken(token),
      pair: (code, name) => this.devices.pair(code, name),
      call: options.call,
      onEvent: options.onEvent,
      onData: options.onData,
      hostName: () => this.hostName,
    });
  }

  /** Where the page listens now, for a test that asked for any free port. */
  get listeningPort(): number | null {
    return this.gateway.port;
  }

  /** The owner turned it on, so the core stays up for phones while the Mac app is closed. */
  get enabled(): boolean {
    return (this.ctx.db.prepare('SELECT value FROM meta WHERE key = ?').get(ENABLED) as { value: string } | undefined)?.value === '1';
  }

  /** At core start: back on if it was on. A listener that cannot start is logged, never fatal. */
  async start(): Promise<void> {
    this.current(this.generation);
    if (!this.enabled) return;
    const generation = ++this.generation;
    try { await this.listen(generation); }
    catch (error) { if (!this.closed && generation === this.generation) this.options.log?.(`phone access did not start: ${(error as Error).message}`); }
  }

  async stop(): Promise<void> {
    this.closed = true;
    ++this.generation;
    // Shutdown invalidates pending On work, but keeps the owner's saved intent.
    await this.closeLocal();
  }

  async status(generation = this.generation): Promise<PhoneStatus> {
    this.current(generation);
    const tailscale = await this.tailscale.state(this.port);
    this.current(generation);
    this.hostName = tailscale.state === 'ready' || tailscale.state === 'no-https' ? tailscale.dnsName : null;
    return {
      enabled: this.enabled,
      listening: this.gateway.listening,
      tailscale,
      url: tailscale.state === 'ready' && tailscale.serving ? `https://${tailscale.dnsName}${PHONE_PATH}/` : null,
      devices: this.devices.list(),
    };
  }

  /** Listen, and have Tailscale serve it when it can. Tailscale not ready is said in the status, not refused. */
  async enable(): Promise<PhoneStatus> {
    this.current(this.generation);
    const generation = ++this.generation;
    await this.listen(generation);
    this.current(generation);
    this.ctx.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(ENABLED, '1');
    // Read mount state after earlier mutations settle, without putting this
    // read-only query in the lane that Off needs to remove the mount.
    await this.mountChanges;
    this.current(generation);
    const tailscale = await this.tailscale.state(this.port);
    this.current(generation);
    await this.changeMount(async () => {
      this.current(generation);
      if (tailscale.state === 'ready' && !tailscale.serving) await this.tailscale.serve(this.port);
    });
    this.current(generation);
    this.ctx.emit('phone', {});
    return this.status(generation);
  }

  async disable(): Promise<PhoneStatus> {
    this.current(this.generation);
    const generation = ++this.generation;
    this.ctx.db.prepare('DELETE FROM meta WHERE key = ?').run(ENABLED);
    // Stop local access before waiting on an external command that may stall
    // or reject. Its error still reaches the owner, with Phone already off.
    const closed = this.closeLocal();
    // Reserve cleanup now: a later On must observe this mutation before it
    // decides whether the mount already serves its listener.
    const unmounted = this.changeMount(async () => {
      await closed;
      if (generation === this.generation && !this.closed) await this.tailscale.unserve();
    });
    await closed;
    if (generation === this.generation && !this.closed) this.ctx.emit('phone', {});
    await unmounted;
    this.current(generation);
    return this.status(generation);
  }

  /** A pairing code, and the address a phone opens with it in the fragment (never sent to a server). */
  async pairCode(): Promise<PairingCode> {
    if (!this.gateway.listening) throw new CoreError('refused', 'Turn phone access on first.');
    const { url } = await this.status();
    const { code, expiresAt } = this.devices.newCode();
    return { code, url: url ? `${url}#pair=${code}` : null, expiresAt };
  }

  /** Forget a phone, and end what it has open. */
  forget(id: string): void {
    this.devices.forget(id);
    this.gateway.drop(id);
  }

  pushKey(): string {
    return this.push.publicKey();
  }

  /** A test notification to every phone that takes them: how many were sent. */
  testPush(): Promise<number> {
    return this.push.test();
  }

  /** Where to send a phone notifications, from its browser's push subscription; nothing given stops them. */
  subscribe(deviceId: string, params: { endpoint?: unknown; p256dh?: unknown; auth?: unknown }): void {
    if (params.endpoint === undefined) { this.devices.setPush(deviceId, null); return; }
    let endpoint: URL;
    try { endpoint = new URL(String(params.endpoint)); } catch { throw new CoreError('invalid', 'That is not a push address.'); }
    if (endpoint.protocol !== 'https:' || typeof params.p256dh !== 'string' || typeof params.auth !== 'string') {
      throw new CoreError('invalid', 'A push subscription needs an https address and its keys.');
    }
    this.devices.setPush(deviceId, { endpoint: endpoint.href, p256dh: params.p256dh, auth: params.auth });
  }

  private current(generation: number): void {
    if (this.closed) throw new CoreError('refused', 'The core is shutting down; phone access cannot change.');
    if (generation !== this.generation) throw new CoreError('refused', 'Phone access changed while this request was pending. Check its current status.');
  }

  private changeLocal(work: () => Promise<void>): Promise<void> {
    const next = this.localChanges.then(work);
    this.localChanges = next.catch(() => {});
    return next;
  }

  private changeMount(work: () => Promise<void>): Promise<void> {
    const next = this.mountChanges.then(work);
    this.mountChanges = next.catch(() => {});
    return next;
  }

  private closeLocal(): Promise<void> {
    return this.changeLocal(async () => {
      this.offNeeds?.();
      this.offNeeds = null;
      if (this.needsTimer) clearTimeout(this.needsTimer);
      this.needsTimer = null;
      this.hostName = null;
      await this.gateway.close();
    });
  }

  private async listen(generation: number): Promise<void> {
    await this.changeLocal(async () => {
      this.current(generation);
      try {
        await this.gateway.listen(this.port);
      } catch (error) {
        if ((error as { code?: unknown }).code !== 'EADDRINUSE') throw error;
        throw new CoreError('refused', `Something else on this Mac is using port ${this.port}, so the phone page cannot listen. Quit it and try again.`);
      }
      this.current(generation);
      if (this.offNeeds) return;
      // Notifications: what needs the owner, looked at once things settle after each change.
      void this.push.announce(this.options.needs(), true);
      this.offNeeds = this.options.onEvent((event) => {
        if (event !== 'needs' || this.needsTimer) return;
        this.needsTimer = setTimeout(() => {
          this.needsTimer = null;
          void this.push.announce(this.options.needs());
        }, 1_000);
        this.needsTimer.unref();
      });
    });
    this.current(generation);
    await this.status(generation);
  }
}
