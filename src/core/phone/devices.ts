// Phones paired to this Mac. A pairing code is shown once as a QR code, works
// once, for ten minutes; it becomes a device token, of which only a hash is
// kept. Guessing is slowed: after a run of wrong codes, pairing waits.
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { PAIRING_TTL_MS, phoneName, type PhoneDevice } from '../../shared/phone.ts';
import { CoreError } from '../../shared/protocol.ts';
import type { Ctx } from '../context.ts';
import { hashToken } from '../sessions.ts';

/** No 0/O, 1/I/L: a code read off a screen is typed right. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const WRONG_LIMIT = 10;
const WRONG_WINDOW_MS = 60_000;
/** A phone's last-seen time is written at most this often. */
const SEEN_EVERY_MS = 60_000;

interface Row {
  id: string; name: string; token_hash: string; control: number; paired_at: number; last_seen_at: number | null;
  push_endpoint: string | null; push_p256dh: string | null; push_auth: string | null;
}

export interface PushTarget { deviceId: string; endpoint: string; p256dh: string; auth: string }

const toDevice = (r: Row): PhoneDevice => ({
  id: r.id, name: r.name, control: r.control === 1, pairedAt: r.paired_at, lastSeenAt: r.last_seen_at, push: !!r.push_endpoint,
});

export class PhoneDevices {
  private readonly ctx: Ctx;
  private code: { value: string; expiresAt: number } | null = null;
  private wrong: number[] = [];

  constructor(ctx: Ctx) {
    this.ctx = ctx;
  }

  /** A new pairing code, replacing any earlier one: "ABCD-EF23". */
  newCode(): { code: string; expiresAt: number } {
    const bytes = randomBytes(8);
    const raw = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('');
    this.code = { value: `${raw.slice(0, 4)}-${raw.slice(4)}`, expiresAt: this.ctx.now() + PAIRING_TTL_MS };
    return { code: this.code.value, expiresAt: this.code.expiresAt };
  }

  /** Pair a phone with the code shown on the Mac. The code is spent either way it is used right. */
  pair(code: unknown, name: unknown, control = true): { device: PhoneDevice; token: string } {
    const now = this.ctx.now();
    this.wrong = this.wrong.filter((t) => now - t < WRONG_WINDOW_MS);
    if (this.wrong.length >= WRONG_LIMIT) throw new CoreError('refused', 'Too many wrong pairing codes. Wait a minute, then scan the code on your Mac again.');
    const given = typeof code === 'string' ? code.trim().toUpperCase() : '';
    const live = this.code && this.code.expiresAt > now ? this.code.value : null;
    if (!live || !sameText(given, live)) {
      this.wrong.push(now);
      throw new CoreError('unauthorized', live ? 'That pairing code is not the one on your Mac.' : 'That pairing code has expired. Show a new one in Settings › Phone.');
    }
    this.code = null;
    const token = randomBytes(32).toString('base64url');
    const row: Row = {
      id: randomUUID(), name: phoneName(name), token_hash: hashToken(token), control: control ? 1 : 0, paired_at: now, last_seen_at: now,
      push_endpoint: null, push_p256dh: null, push_auth: null,
    };
    this.ctx.db.prepare('INSERT INTO phone_devices (id, name, token_hash, control, paired_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(row.id, row.name, row.token_hash, row.control, row.paired_at, row.last_seen_at);
    this.ctx.emit('phone', {});
    return { device: toDevice(row), token };
  }

  /** The phone a token belongs to, or null. Notes it was seen. */
  byToken(token: string): PhoneDevice | null {
    if (!token) return null;
    const row = this.ctx.db.prepare('SELECT * FROM phone_devices WHERE token_hash = ?').get(hashToken(token)) as Row | undefined;
    if (!row) return null;
    const now = this.ctx.now();
    if (!row.last_seen_at || now - row.last_seen_at > SEEN_EVERY_MS) {
      this.ctx.db.prepare('UPDATE phone_devices SET last_seen_at = ? WHERE id = ?').run(now, row.id);
      row.last_seen_at = now;
    }
    return toDevice(row);
  }

  list(): PhoneDevice[] {
    return (this.ctx.db.prepare('SELECT * FROM phone_devices ORDER BY paired_at').all() as Row[]).map(toDevice);
  }

  /** Forget a phone: its token stops working at once. */
  forget(id: string): void {
    if (!this.ctx.db.prepare('DELETE FROM phone_devices WHERE id = ?').run(id).changes) throw new CoreError('not_found', 'No such phone.');
    this.ctx.emit('phone', {});
  }

  setControl(id: string, control: boolean): void {
    if (!this.ctx.db.prepare('UPDATE phone_devices SET control = ? WHERE id = ?').run(control ? 1 : 0, id).changes) throw new CoreError('not_found', 'No such phone.');
    this.ctx.emit('phone', {});
  }

  /** Where to send this phone notifications, or null to stop. */
  setPush(id: string, target: { endpoint: string; p256dh: string; auth: string } | null): void {
    this.ctx.db.prepare('UPDATE phone_devices SET push_endpoint = ?, push_p256dh = ?, push_auth = ? WHERE id = ?')
      .run(target?.endpoint ?? null, target?.p256dh ?? null, target?.auth ?? null, id);
    this.ctx.emit('phone', {});
  }

  /** A gone response belongs to the dispatched target, not a later subscription. */
  clearPush(target: PushTarget): void {
    const result = this.ctx.db.prepare(`UPDATE phone_devices SET push_endpoint = NULL, push_p256dh = NULL, push_auth = NULL
      WHERE id = ? AND push_endpoint = ? AND push_p256dh = ? AND push_auth = ?`)
      .run(target.deviceId, target.endpoint, target.p256dh, target.auth);
    if (result.changes) this.ctx.emit('phone', {});
  }

  pushTargets(): PushTarget[] {
    return (this.ctx.db.prepare('SELECT * FROM phone_devices WHERE push_endpoint IS NOT NULL').all() as Row[])
      .map((r) => ({ deviceId: r.id, endpoint: r.push_endpoint!, p256dh: r.push_p256dh!, auth: r.push_auth! }));
  }
}

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
