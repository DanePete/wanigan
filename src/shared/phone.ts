// Wanigan on your phone: what a paired phone is, what it may do, and what the
// window is told about phone access. The phone reaches the Mac through the
// owner's own Tailscale network; Wanigan listens on loopback only.

/** Where the phone page listens on this Mac (loopback only). Wanigan 1's companion has 47831. */
export const PHONE_PORT = 47_832;
/** Where Tailscale mounts it on the owner's private address, beside anything else they serve. */
export const PHONE_PATH = '/wanigan';
/** How long a pairing code shown as a QR code can be used. */
export const PAIRING_TTL_MS = 10 * 60_000;

/**
 * What a phone may call only when it was allowed to act. Everything else a
 * phone may call only reads. A phone never reaches settings, accounts, git,
 * skills, MCP, files on the Mac, Jev's key, or pairing.
 */
export const PHONE_ACTS: ReadonlySet<string> = new Set([
  'sessions.start', 'sessions.resume', 'sessions.input', 'sessions.queue', 'sessions.stop', 'sessions.resize',
  'cards.create', 'cards.move', 'cards.approve', 'cards.sendBack', 'cards.comment',
]);

export interface PhoneDevice {
  id: string;
  /** What the owner called it when pairing: "Dane's iPhone". */
  name: string;
  /** It may act (start, type, reply, stop, move cards), not only read. */
  control: boolean;
  pairedAt: number;
  lastSeenAt: number | null;
  /** It will be told when something needs the owner. */
  push: boolean;
}

/** What Wanigan knows of Tailscale on this Mac, from its own CLI. */
export type TailscaleState =
  | { state: 'missing' }
  | { state: 'stopped' }
  | { state: 'no-https'; dnsName: string }
  | { state: 'ready'; dnsName: string; serving: boolean };

export interface PhoneStatus {
  /** The owner turned phone access on. */
  enabled: boolean;
  /** The phone page is listening on loopback. */
  listening: boolean;
  tailscale: TailscaleState;
  /** The private address a phone opens, once Tailscale serves it. */
  url: string | null;
  devices: PhoneDevice[];
}

export interface PairingCode {
  code: string;
  /** The address with the code in its fragment: what the QR code holds. Null until Tailscale serves it. */
  url: string | null;
  expiresAt: number;
}

/** What Wanigan runs to mount itself on the owner's private address: shown to them first, exactly. */
export const serveCommand = (port: number): string[] => ['serve', '--bg', '--https=443', `--set-path=${PHONE_PATH}`, `http://127.0.0.1:${port}`];

/** A phone in Activity: "phone:Dane's iPhone", shown as "You, from Dane's iPhone". */
export const phoneActor = (name: string): string => `phone:${name}`;

/** A name for a phone: printable, short, trimmed; never empty. */
export function phoneName(raw: unknown): string {
  const text = typeof raw === 'string' ? raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40) : '';
  return text || 'Phone';
}
