import http from 'node:http';
import type { Socket } from 'node:net';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { app, safeStorage } from 'electron';
import { getSetting, setSetting } from './settings';
import type {
  MobileFleetSession,
  MobileFleetSnapshot,
  MobileMonitorConfig,
  MobileMonitorStatus,
} from '../shared/types';

export type {
  MobileFleetSession,
  MobileFleetSnapshot,
  MobileMonitorConfig,
  MobileMonitorStatus,
} from '../shared/types';

/**
 * A read-only phone-sized view of the fleet.
 *
 * This listener intentionally binds to loopback. Reach it from a phone through
 * an operator-owned private reverse proxy (for example Tailscale Serve), not by
 * turning Wanigan into a server on every network the laptop joins. The fixed
 * port makes that proxy stable; the fragment token keeps the credential out of
 * HTTP request logs and Referer headers.
 *
 * The source callback is the privacy boundary. Its type contains no terminal
 * bytes, transcript text, conversation ids, pids, worktrees, or filesystem
 * paths, and the response is rebuilt field-by-field before it leaves main so an
 * accidental extra property on a structurally compatible object is dropped.
 */

export const DEFAULT_MOBILE_PORT = 47_831;
export const MOBILE_PUSH_TIMEOUT_MS = 8_000;

const MAX_SESSIONS = 250;
const MAX_JSON_BYTES = 512 * 1024;
const MAX_TERMINAL_BYTES = 240 * 1024;
const SNAPSHOT_TIMEOUT_MS = 3_000;
const TOKEN_BYTES = 32;
const TOPIC_BYTES = 24;
const PAIR_CODE_MS = 10 * 60_000;

const KEY = {
  dashboardEnabled: 'mobile_dashboard_enabled',
  remoteControlEnabled: 'mobile_remote_control_enabled',
  port: 'mobile_port',
  dashboardUrl: 'mobile_dashboard_url',
  token: 'mobile_token',
  pushEnabled: 'mobile_push_enabled',
  pushServer: 'mobile_push_server',
  pushTopic: 'mobile_push_topic',
} as const;

type MobileSecrets = { token: string; topic: string };
let memorySecrets: MobileSecrets | null = null;
let secretsError: string | null = null;

type SnapshotSource = () => MobileFleetSnapshot | Promise<MobileFleetSnapshot>;
export type MobileControlSource = {
  projects: () => Promise<{ id: string; name: string; branch: string | null }[]>;
  providers: () => Promise<{ id: string; label: string; available: boolean; models: { value: string; label: string }[]; efforts: string[] }[]>;
  launch: (input: { projectId: string; providerId: string; model?: string; effort?: string; prompt: string }) => Promise<{ id: string; title: string }>;
  prompt: (sessionId: string, prompt: string) => Promise<void>;
  interrupt: (sessionId: string) => Promise<boolean>;
  terminal: (sessionId: string) => Promise<{ title: string; running: boolean; text: string }>;
};

export type MobileConfigPatch = Partial<MobileMonitorConfig>;

export type MobilePushInput = {
  title: string;
  body: string;
  urgent?: boolean;
};

export type MobilePushResult = {
  at: number;
  ok: boolean;
  skipped: boolean;
  /** Whether a persistent attention state may safely retry this automatically. */
  retryable: boolean;
  httpStatus: number | null;
  error: string | null;
};

let snapshotSource: SnapshotSource | null = null;
let controlSource: MobileControlSource | null = null;
let server: http.Server | null = null;
let serverPort: number | null = null;
let pendingServer: http.Server | null = null;
let starting: Promise<void> | null = null;
let lifecycleVersion = 0;
let lastServerError: string | null = null;
let pushResult: MobilePushResult | null = null;
const sockets = new Set<Socket>();
const actionTimes: number[] = [];
const pairingAttempts: number[] = [];

const ATTENTION = new Set(['permission', 'error', 'finished', 'idle', 'working']);
const SESSION_STATUS = new Set(['starting', 'running', 'exited']);

function boolSetting(key: string, fallback = false): boolean {
  return getSetting(key, fallback ? '1' : '0') === '1';
}

function portSetting(): number {
  const value = Number(getSetting(KEY.port, String(DEFAULT_MOBILE_PORT)));
  return Number.isInteger(value) && value >= 1_024 && value <= 65_535
    ? value
    : DEFAULT_MOBILE_PORT;
}

function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

function generateTopic(): string {
  return `wanigan-${randomBytes(TOPIC_BYTES).toString('base64url')}`;
}

function tokenLooksStrong(value: string): boolean {
  return /^[A-Za-z0-9_-]{40,128}$/.test(value);
}

function topicLooksStrong(value: string): boolean {
  return /^wanigan-[A-Za-z0-9_-]{30,120}$/.test(value);
}

function secretsFile(): string {
  return path.join(app.getPath('userData'), 'mobile-secrets.bin');
}

function persistSecrets(value: MobileSecrets): void {
  // Smoke runs must be hermetic: probing the real macOS keychain from a
  // temporary Electron profile can block on Keychain UI and never exercises
  // the production encrypted-file path. Test secrets live only in memory.
  if (process.env.WANIGAN_SMOKE === '1') {
    memorySecrets = { ...value };
    secretsError = null;
    return;
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS credential encryption is unavailable.');
  }

  // Encrypt and durably replace the file before changing runtime state. If the
  // keychain or disk write fails, existing paired phones keep using the prior
  // in-memory secret and Settings receives the failure instead of a false
  // success followed by a mysteriously revoked token.
  const file = secretsFile();
  const next = `${file}.next-${process.pid}-${randomBytes(6).toString('hex')}`;
  const encrypted = safeStorage.encryptString(JSON.stringify(value));
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let fd: number | null = null;
  try {
    fd = fs.openSync(next, 'wx', 0o600);
    fs.writeFileSync(fd, encrypted);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = null;
    try { fs.chmodSync(next, 0o600); } catch { /* best effort on odd filesystems */ }
    fs.renameSync(next, file);
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch { /* best effort */ }
    try { fs.rmSync(next, { force: true }); } catch { /* rename already consumed it */ }
  }
  memorySecrets = { ...value };
  secretsError = null;
}

function mobileSecrets(): MobileSecrets {
  if (process.env.WANIGAN_SMOKE === '1') {
    memorySecrets ??= { token: generateToken(), topic: generateTopic() };
    secretsError = null;
    return memorySecrets;
  }
  if (!safeStorage.isEncryptionAvailable()) {
    secretsError = 'OS credential encryption is unavailable, so phone monitoring is paused.';
    memorySecrets ??= { token: generateToken(), topic: generateTopic() };
    return memorySecrets;
  }
  if (memorySecrets && !secretsError) return memorySecrets;

  const file = secretsFile();
  if (fs.existsSync(file)) {
    try {
      const decoded = JSON.parse(safeStorage.decryptString(fs.readFileSync(file))) as Partial<MobileSecrets>;
      if (!tokenLooksStrong(decoded.token ?? '') || !topicLooksStrong(decoded.topic ?? '')) {
        throw new Error('The decrypted credential shape is invalid.');
      }
      memorySecrets = { token: decoded.token!, topic: decoded.topic! };
      secretsError = null;
      return memorySecrets;
    } catch {
      // Never silently replace an unreadable credential while monitoring is
      // configured: doing so breaks every pairing and subscription while the
      // UI continues to claim the old setup is active.
      secretsError = 'Wanigan could not decrypt its phone-monitor credentials. Phone monitoring is paused.';
      memorySecrets ??= { token: generateToken(), topic: generateTopic() };
      return memorySecrets;
    }
  }

  // Migrate the short-lived development format that put these values in the
  // settings table. Empty the legacy rows after the encrypted blob is written,
  // so the pairing credential and ntfy subscription secret are not left in
  // plaintext beside otherwise harmless feature flags.
  const legacyToken = getSetting(KEY.token, '').trim();
  const legacyTopic = getSetting(KEY.pushTopic, '').trim();
  const next = {
    token: tokenLooksStrong(legacyToken) ? legacyToken : generateToken(),
    topic: topicLooksStrong(legacyTopic) ? legacyTopic : generateTopic(),
  };
  try {
    persistSecrets(next);
    setSetting(KEY.token, '');
    setSetting(KEY.pushTopic, '');
  } catch {
    secretsError = 'Wanigan could not persist encrypted phone-monitor credentials. Phone monitoring is paused.';
    memorySecrets ??= next;
  }
  return memorySecrets ?? next;
}

function mobileCredentialsReady(): boolean {
  mobileSecrets();
  return process.env.WANIGAN_SMOKE === '1'
    || (safeStorage.isEncryptionAvailable() && secretsError === null);
}

function ensureMobileToken(): string {
  return mobileSecrets().token;
}

function pairingCode(token: string, slot = Math.floor(Date.now() / PAIR_CODE_MS)): string {
  return createHmac('sha256', token).update(`wanigan-mobile-pair:${slot}`).digest('hex').slice(0, 10).toUpperCase();
}

function pairingCodeValid(value: string): boolean {
  const given = value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (!/^[A-F0-9]{10}$/.test(given)) return false;
  const token = ensureMobileToken();
  return [0, -1].some((offset) => {
    const expected = Buffer.from(pairingCode(token, Math.floor(Date.now() / PAIR_CODE_MS) + offset));
    const candidate = Buffer.from(given);
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  });
}

function ensurePushTopic(): string {
  return mobileSecrets().topic;
}

function normaliseHttpsUrl(raw: string, label: string): string {
  const value = raw.trim();
  if (!value) return '';
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a complete HTTPS URL.`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`${label} must use HTTPS.`);
  if (parsed.username || parsed.password) throw new Error(`${label} cannot contain a username or password.`);
  if (parsed.search || parsed.hash) throw new Error(`${label} cannot contain a query string or fragment.`);
  return parsed.toString().replace(/\/+$/, '');
}

/** Register the only source of bytes returned by /api/status. */
export function configureSnapshotSource(fn: SnapshotSource | null): void {
  snapshotSource = fn;
}

/** The desktop main process supplies the small, explicit remote-control bridge. */
export function configureMobileControlSource(source: MobileControlSource | null): void {
  controlSource = source;
}

/** Read the persisted, non-secret monitor configuration. */
export function mobileConfig(): MobileMonitorConfig {
  return {
    dashboardEnabled: boolSetting(KEY.dashboardEnabled),
    remoteControlEnabled: boolSetting(KEY.remoteControlEnabled),
    port: portSetting(),
    dashboardUrl: getSetting(KEY.dashboardUrl, '').trim(),
    pushEnabled: boolSetting(KEY.pushEnabled),
    pushServer: getSetting(KEY.pushServer, 'https://ntfy.sh').trim(),
    pushTopic: ensurePushTopic(),
  };
}

function localUrl(port: number): string {
  return `http://127.0.0.1:${port}/`;
}

function dashboardBase(config: MobileMonitorConfig): string {
  const configured = config.dashboardUrl.trim();
  return configured ? `${configured.replace(/\/+$/, '')}/` : localUrl(config.port);
}

/** Current lifecycle state. The pairing URL is intended for Wanigan's trusted renderer. */
export function mobileStatus(): MobileMonitorStatus {
  const config = mobileConfig();
  const token = ensureMobileToken();
  const credentialIssue = config.dashboardEnabled || config.pushEnabled ? secretsError : null;
  return {
    config,
    running: Boolean(server?.listening && serverPort === config.port),
    localUrl: localUrl(config.port),
    pairingUrl: `${dashboardBase(config)}#token=${encodeURIComponent(token)}`,
    pairingCode: pairingCode(token),
    tokenFingerprint: `${token.slice(0, 8)}…${token.slice(-4)}`,
    error: credentialIssue ?? lastServerError,
    lastPushAt: pushResult?.ok ? pushResult.at : null,
    lastPushError: pushResult && !pushResult.skipped ? pushResult.error : null,
  };
}

/** Persist a validated patch and immediately reconcile the listener. */
export async function setMobileConfig(patch: MobileConfigPatch): Promise<MobileMonitorStatus> {
  const current = mobileConfig();
  const next: MobileMonitorConfig = {
    dashboardEnabled: patch.dashboardEnabled ?? current.dashboardEnabled,
    remoteControlEnabled: patch.remoteControlEnabled ?? current.remoteControlEnabled,
    port: patch.port ?? current.port,
    dashboardUrl: patch.dashboardUrl === undefined
      ? current.dashboardUrl
      : normaliseHttpsUrl(patch.dashboardUrl, 'Dashboard URL'),
    pushEnabled: patch.pushEnabled ?? current.pushEnabled,
    pushServer: patch.pushServer === undefined
      ? current.pushServer
      : normaliseHttpsUrl(patch.pushServer, 'ntfy server'),
    pushTopic: patch.pushTopic ?? current.pushTopic,
  };

  if (!Number.isInteger(next.port) || next.port < 1_024 || next.port > 65_535) {
    throw new Error('Mobile monitor port must be a whole number from 1024 through 65535.');
  }
  if (!topicLooksStrong(next.pushTopic)) {
    throw new Error('The ntfy topic must be the high-entropy topic generated by Wanigan.');
  }
  if (next.pushEnabled && !next.pushServer) {
    throw new Error('Set an HTTPS ntfy server before enabling mobile push.');
  }
  if ((next.dashboardEnabled || next.pushEnabled) && !mobileCredentialsReady()) {
    throw new Error(
      `${secretsError ?? 'Encrypted phone-monitor credentials are unavailable.'} `
      + 'Restore the system keychain or replace the affected credential before turning phone monitoring on.',
    );
  }

  // Persist a changed secret before the non-secret flags. A failed keychain or
  // disk write then leaves the whole previously working configuration intact.
  if (next.pushTopic !== current.pushTopic) {
    const secrets = mobileSecrets();
    persistSecrets({ ...secrets, topic: next.pushTopic });
  }

  // Validate every field before writing any of them, so a rejected patch does
  // not leave half of a configuration behind.
  setSetting(KEY.dashboardEnabled, next.dashboardEnabled ? '1' : '0');
  setSetting(KEY.remoteControlEnabled, next.remoteControlEnabled ? '1' : '0');
  setSetting(KEY.port, String(next.port));
  setSetting(KEY.dashboardUrl, next.dashboardUrl);
  setSetting(KEY.pushEnabled, next.pushEnabled ? '1' : '0');
  setSetting(KEY.pushServer, next.pushServer);
  if (!next.dashboardEnabled || (server && serverPort !== next.port)) stopMobileMonitor();
  return startMobileMonitor();
}

/** Rotate dashboard access immediately; an old fragment/token stops working. */
export async function regenerateMobileToken(): Promise<MobileMonitorStatus> {
  const secrets = mobileSecrets();
  persistSecrets({ ...secrets, token: generateToken() });
  // Credential replacement is also the recovery path for an enabled listener
  // that was paused because the encrypted blob could not be read at startup.
  return startMobileMonitor();
}

/** Rotate the secret ntfy topic independently of dashboard access. */
export async function regenerateMobilePushTopic(): Promise<MobileMonitorStatus> {
  const secrets = mobileSecrets();
  persistSecrets({ ...secrets, topic: generateTopic() });
  return startMobileMonitor();
}

function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  const unwrapped = address.replace(/^::ffff:/, '');
  return unwrapped === '::1' || /^127\.\d+\.\d+\.\d+$/.test(unwrapped);
}

function authorized(req: http.IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!match) return false;

  let expected: string;
  try {
    expected = ensureMobileToken();
  } catch {
    return false;
  }
  const given = Buffer.from(match[1]);
  const wanted = Buffer.from(expected);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

function securityHeaders(nonce?: string): Record<string, string> {
  const script = nonce ? `'nonce-${nonce}'` : "'none'";
  const style = nonce ? `'nonce-${nonce}'` : "'none'";
  return {
    'cache-control': 'no-store, max-age=0',
    pragma: 'no-cache',
    expires: '0',
    'content-security-policy':
      `default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; ` +
      `script-src ${script}; style-src ${style}; connect-src 'self'; img-src 'self' data:`,
    'x-frame-options': 'DENY',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'cross-origin-resource-policy': 'same-origin',
  };
}

function send(
  res: http.ServerResponse,
  status: number,
  contentType: string,
  body: string,
  nonce?: string,
  extra: Record<string, string> = {},
): void {
  res.writeHead(status, {
    ...securityHeaders(nonce),
    'content-type': contentType,
    'content-length': String(Buffer.byteLength(body)),
    ...extra,
  });
  res.end(body);
}

function json(res: http.ServerResponse, status: number, body: unknown, extra?: Record<string, string>): void {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(body), undefined, extra);
}

function safeString(value: unknown, max: number, fallback = ''): string {
  if (typeof value !== 'string') return fallback;
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function finite(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function count(value: unknown): number {
  return Math.max(0, Math.round(finite(value)));
}

function money(value: unknown): number {
  return Math.max(0, finite(value));
}

/**
 * Structural typing permits callers to hold extra properties even when the
 * function says MobileFleetSnapshot. Rebuild the response from an allow-list
 * so those properties never cross the HTTP boundary.
 */
function privacyFilterSnapshot(input: MobileFleetSnapshot): MobileFleetSnapshot {
  const value = input as MobileFleetSnapshot & Record<string, unknown>;
  const rows = Array.isArray(value.sessions) ? value.sessions.slice(0, MAX_SESSIONS) : [];
  const sessions: MobileFleetSession[] = rows.map((raw) => {
    const row = raw as MobileFleetSession & Record<string, unknown>;
    const attention = row.attention as MobileFleetSession['attention'] | undefined;
    const usage = row.usage as MobileFleetSession['usage'] | undefined;
    const kind = ATTENTION.has(attention?.kind ?? '')
      ? attention!.kind
      : 'idle';
    const status = SESSION_STATUS.has(row.status ?? '') ? row.status : 'exited';
    return {
      id: safeString(row.id, 160),
      projectName: safeString(row.projectName, 160, 'Unknown project'),
      title: safeString(row.title, 200, 'Agent session'),
      providerId: safeString(row.providerId, 100, 'unknown'),
      model: row.model === null ? null : safeString(row.model, 120) || null,
      status,
      createdAt: finite(row.createdAt),
      endedAt: row.endedAt === null ? null : finite(row.endedAt) || null,
      attention: {
        kind,
        label: safeString(attention?.label, 40, kind),
        since: finite(attention?.since),
      },
      usage: {
        costUsd: money(usage?.costUsd),
        costStatus: usage?.costStatus === 'unavailable' ? 'unavailable' : 'reported',
        inTokens: count(usage?.inTokens),
        outTokens: count(usage?.outTokens),
        linesAdded: count(usage?.linesAdded),
        linesRemoved: count(usage?.linesRemoved),
        requests: count(usage?.requests),
        errors: count(usage?.errors),
        lastAt: usage?.lastAt === null ? null : finite(usage?.lastAt) || null,
      },
    };
  });

  const providedTotals = value.totals as MobileFleetSnapshot['totals'] | undefined;
  return {
    generatedAt: finite(value.generatedAt, Date.now()),
    host: safeString(value.host, 160, 'Wanigan'),
    version: safeString(value.version, 80),
    totals: {
      sessions: count(providedTotals?.sessions),
      running: count(providedTotals?.running),
      permission: count(providedTotals?.permission),
      error: count(providedTotals?.error),
      finished: count(providedTotals?.finished),
      idle: count(providedTotals?.idle),
      working: count(providedTotals?.working),
      costUsd: money(providedTotals?.costUsd),
      costUnavailable: providedTotals?.costUnavailable === true,
      inTokens: count(providedTotals?.inTokens),
      outTokens: count(providedTotals?.outTokens),
      linesAdded: count(providedTotals?.linesAdded),
      linesRemoved: count(providedTotals?.linesRemoved),
      requests: count(providedTotals?.requests),
      errors: count(providedTotals?.errors),
    },
    sessions,
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('snapshot timed out')), ms);
    timer.unref?.();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

async function serveStatus(res: http.ServerResponse): Promise<void> {
  const source = snapshotSource;
  if (!source) {
    json(res, 503, { error: 'The mobile snapshot source is not configured.' });
    return;
  }
  try {
    const snapshot = privacyFilterSnapshot(await withTimeout(Promise.resolve().then(source), SNAPSHOT_TIMEOUT_MS));
    const body = JSON.stringify(snapshot);
    if (Buffer.byteLength(body) > MAX_JSON_BYTES) {
      json(res, 503, { error: 'The mobile fleet snapshot is too large to serve safely.' });
      return;
    }
    send(res, 200, 'application/json; charset=utf-8', body);
  } catch {
    // Source errors can contain local paths or database details. The dashboard
    // needs to know the read failed, not which local byte made it fail.
    json(res, 503, { error: 'Wanigan could not build the mobile fleet snapshot.' });
  }
}

function controlAllowed(): boolean {
  return mobileConfig().dashboardEnabled && mobileConfig().remoteControlEnabled && controlSource !== null;
}

function actionRateAllowed(): boolean {
  const since = Date.now() - 60_000;
  while (actionTimes.length && actionTimes[0] < since) actionTimes.shift();
  if (actionTimes.length >= 20) return false;
  actionTimes.push(Date.now());
  return true;
}

async function requestJson(req: http.IncomingMessage, limit = 16_384): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += piece.length;
    if (bytes > limit) throw new Error('Request is too large.');
    chunks.push(piece);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

async function servePair(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (req.method !== 'POST') { json(res, 405, { error: 'Method not allowed.' }, { allow: 'POST' }); return; }
  const cutoff = Date.now() - 60_000;
  while (pairingAttempts.length && pairingAttempts[0] < cutoff) pairingAttempts.shift();
  if (pairingAttempts.length >= 8) { json(res, 429, { error: 'Too many pairing attempts. Wait a minute and try again.' }); return; }
  pairingAttempts.push(Date.now());
  const body = await requestJson(req, 1024);
  const code = typeof body?.code === 'string' ? body.code : '';
  if (!pairingCodeValid(code)) { json(res, 401, { error: 'That pairing code is invalid or expired.' }); return; }
  json(res, 200, { token: ensureMobileToken() });
}

function actionText(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} is required.`);
  const text = value.trim();
  if (!text || text.length > 8_000 || /\u0000/.test(text)) throw new Error(`${label} must be 1–8000 characters.`);
  return text;
}

function optionalLaunchValue(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.trim().length > 120 || /[\u0000-\u001f\x7f]/.test(value)) throw new Error(`${label} is invalid.`);
  return value.trim();
}

/**
 * The desktop terminal has an ANSI parser. The mobile view deliberately uses
 * a plain, inert <pre>, so terminal escape sequences must never be sent to it
 * verbatim. Apart from making colour codes visible as garbage, OSC sequences
 * can contain arbitrary terminal metadata. This produces a readable snapshot
 * while keeping the remote page incapable of interpreting terminal controls.
 */
export function readableTerminal(value: string): string {
  // This is deliberately a small *display* parser, not an xterm replacement.
  // Stripping every CSI sequence made carriage-return redraws leave the old
  // characters behind ("working…\rDone" became "Doneing…" on iPad). Handling
  // the common cursor and erase controls keeps normal CLI output legible while
  // the remote page remains an inert `<pre>` with no terminal escape handling.
  const input = value
    // OSC may carry titles, hyperlinks, or clipboard data; DCS/APC/PM/SOS are
    // equally out-of-band control strings. None belongs in a remote plain-text
    // transcript, even as harmless-looking printable payload.
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[P_^X][\s\S]*?\x1b\\/g, '');
  const lines = [''];
  const MAX_ROWS = 10_000;
  const MAX_COLUMNS = 2_000;
  let row = 0;
  let column = 0;
  let saved: { row: number; column: number } | null = null;

  const setRow = (next: number) => {
    row = Math.max(0, Math.min(MAX_ROWS, Math.round(next) || 0));
    while (lines.length <= row) lines.push('');
  };
  const setColumn = (next: number) => { column = Math.max(0, Math.min(MAX_COLUMNS, Math.round(next) || 0)); };
  const number = (params: string[], index: number, fallback = 1) => {
    const raw = params[index] ?? '';
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? Math.min(10_000, Math.floor(parsed)) : fallback;
  };
  const put = (char: string) => {
    const line = lines[row] ?? '';
    lines[row] = column < line.length
      ? `${line.slice(0, column)}${char}${line.slice(column + 1)}`
      : `${line}${' '.repeat(Math.max(0, column - line.length))}${char}`;
    setColumn(column + 1);
  };
  const eraseLine = (mode: number) => {
    const line = lines[row] ?? '';
    if (mode === 2) { lines[row] = ''; column = 0; return; }
    if (mode === 1) { lines[row] = `${' '.repeat(column)}${line.slice(column)}`; return; }
    lines[row] = line.slice(0, column);
  };

  for (let i = 0; i < input.length;) {
    const char = input[i++];
    if (char === '\x1b') {
      const next = input[i];
      if (next === ']' || next === 'P' || next === '_' || next === '^' || next === 'X') {
        // A complete OSC was stripped above. An incomplete one must not leak
        // opaque terminal metadata into the remote display.
        break;
      }
      if (next === '[') {
        i++;
        const begin = i;
        while (i < input.length && !/[@-~]/.test(input[i])) i++;
        if (i >= input.length) break;
        const command = input[i++];
        const raw = input.slice(begin, i - 1).replace(/^[?>!]/, '');
        const params = raw ? raw.split(/[;:]/) : [];
        const n = number(params, 0);
        switch (command) {
          case 'A': setRow(row - n); break;
          case 'B': setRow(row + n); break;
          case 'C': setColumn(column + n); break;
          case 'D': setColumn(column - n); break;
          case 'E': setRow(row + n); column = 0; break;
          case 'F': setRow(row - n); column = 0; break;
          case 'G': setColumn(n - 1); break;
          case 'H':
          case 'f': setRow(number(params, 0) - 1); setColumn(number(params, 1) - 1); break;
          case 'J': {
            const mode = Number(params[0] || '0');
            if (mode === 2 || mode === 3) { lines.splice(0, lines.length, ''); row = 0; column = 0; }
            else if (mode === 0) { lines.splice(row + 1); eraseLine(0); }
            else if (mode === 1) { lines.splice(0, row); row = 0; eraseLine(1); }
            break;
          }
          case 'K': eraseLine(Number(params[0] || '0')); break;
          case 's': saved = { row, column }; break;
          case 'u': if (saved) { setRow(saved.row); setColumn(saved.column); } break;
          // SGR and the remaining terminal controls are styling, reports, or
          // private mode switches. They are deliberately discarded.
          default: break;
        }
        continue;
      }
      if (next === '7') { saved = { row, column }; i++; continue; }
      if (next === '8') { if (saved) { setRow(saved.row); setColumn(saved.column); } i++; continue; }
      if (next === 'c') { lines.splice(0, lines.length, ''); row = 0; column = 0; i++; continue; }
      // Charset selectors and all remaining two-byte escape forms.
      if (next !== undefined) i++;
      continue;
    }
    if (char === '\n') { setRow(row + 1); column = 0; continue; }
    if (char === '\r') { column = 0; continue; }
    if (char === '\b') { setColumn(column - 1); continue; }
    if (char === '\t') { setColumn(column + (2 - (column % 2))); continue; }
    if (char < ' ' || char === '\x7f') continue;
    put(char);
  }
  return lines.join('\n').replace(/\n{4,}/g, '\n\n\n');
}

async function serveControl(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  const source = controlSource;
  if (!controlAllowed() || !source) { json(res, 403, { error: 'Remote control is disabled in Wanigan Settings.' }); return; }
  if (req.method === 'GET' && url.pathname === '/api/control') {
    const [projects, providers] = await Promise.all([source.projects(), source.providers()]);
    json(res, 200, { projects, providers });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/terminal') {
    const sessionId = safeString(url.searchParams.get('session'), 160);
    if (!sessionId) { json(res, 400, { error: 'Choose a session.' }); return; }
    const terminal = await source.terminal(sessionId);
    json(res, 200, {
      title: safeString(terminal.title, 200),
      running: terminal.running,
      text: readableTerminal(terminal.text).slice(-MAX_TERMINAL_BYTES),
    });
    return;
  }
  if (req.method !== 'POST' || url.pathname !== '/api/action') {
    json(res, 405, { error: 'Unsupported control operation.' }, { allow: 'GET, POST' }); return;
  }
  if (!actionRateAllowed()) { json(res, 429, { error: 'Too many remote actions. Wait a minute and try again.' }); return; }
  const body = await requestJson(req);
  const action = typeof body?.action === 'string' ? body.action : '';
  try {
    if (action === 'launch') {
      const session = await source.launch({ projectId: actionText(body?.projectId, 'Project'), providerId: actionText(body?.providerId, 'Provider'), model: optionalLaunchValue(body?.model, 'Model'), effort: optionalLaunchValue(body?.effort, 'Effort'), prompt: actionText(body?.prompt, 'Prompt') });
      json(res, 201, { ok: true, session: { id: safeString(session.id, 160), title: safeString(session.title, 200) } }); return;
    }
    if (action === 'prompt') {
      await source.prompt(actionText(body?.sessionId, 'Session'), actionText(body?.prompt, 'Prompt'));
      json(res, 200, { ok: true }); return;
    }
    if (action === 'interrupt') {
      const interrupted = await source.interrupt(actionText(body?.sessionId, 'Session'));
      json(res, interrupted ? 200 : 409, { ok: interrupted }); return;
    }
    json(res, 400, { error: 'Unknown remote action.' });
  } catch (error) {
    json(res, 400, { error: safeString(error instanceof Error ? error.message : String(error), 240, 'Remote action was refused.') });
  }
}

function dashboardHtml(nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="color-scheme" content="dark">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="mobile-web-app-capable" content="yes">
  <link rel="manifest" href="manifest.webmanifest">
  <link rel="apple-touch-icon" href="icon.svg">
  <title>Wanigan Mobile</title>
  <style nonce="${nonce}">
    :root { color-scheme: dark; --bg:#090b0f; --panel:#11151c; --line:#252b35; --ink:#edf0f4; --dim:#929cab; --faint:#667080; --accent:#e1a651; --critical:#ff7167; --serious:#ef9b6b; --good:#70ca91; --blue:#73a8e8; }
    * { box-sizing:border-box; }
    html { background:var(--bg); }
    body { margin:0; min-height:100vh; color:var(--ink); background:radial-gradient(circle at 80% -10%,#252015 0,transparent 34rem),var(--bg); font:15px/1.45 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    main { width:min(980px,100%); margin:0 auto; padding:max(20px,env(safe-area-inset-top)) max(16px,env(safe-area-inset-right)) max(30px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left)); }
    header { display:flex; align-items:flex-end; justify-content:space-between; gap:16px; margin:2px 0 20px; }
    h1 { margin:0; font-size:clamp(25px,7vw,40px); letter-spacing:-.04em; font-weight:760; }
    h2 { margin:25px 0 10px; font-size:13px; color:var(--dim); text-transform:uppercase; letter-spacing:.12em; }
    p { margin:0; }
    .eyebrow { color:var(--accent); font-size:11px; letter-spacing:.18em; text-transform:uppercase; font-weight:750; }
    .connection { display:flex; align-items:center; gap:7px; color:var(--dim); font-size:12px; white-space:nowrap; }
    .dot { width:8px; height:8px; border-radius:50%; background:var(--faint); box-shadow:0 0 0 3px #ffffff0a; }
    .dot.live { background:var(--good); }
    .dot.bad { background:var(--critical); }
    .stats { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:9px; }
    .stat,.card,.notice { border:1px solid var(--line); background:linear-gradient(145deg,#151a22,#0e1218); border-radius:13px; box-shadow:0 12px 35px #0003; }
    .stat { padding:13px; min-height:82px; }
    .stat strong { display:block; font-size:clamp(19px,5vw,28px); letter-spacing:-.03em; font-variant-numeric:tabular-nums; }
    .stat span { color:var(--dim); font-size:11px; text-transform:uppercase; letter-spacing:.08em; }
    .grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; }
    .card { padding:14px; min-width:0; }
    .card.tap { cursor:pointer; touch-action:manipulation; }
    .card.tap:active { transform:scale(.985); border-color:var(--accent); }
    .tap-hint { color:var(--accent); font-size:11px; font-weight:700; margin-top:10px; }
    .card-top { display:flex; align-items:center; justify-content:space-between; gap:10px; }
    .name { font-weight:720; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .provider { color:var(--dim); font-size:12px; margin-top:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .badge { flex:none; border-radius:999px; padding:3px 8px; font-size:11px; font-weight:760; border:1px solid currentColor; }
    .badge.permission,.badge.error { color:var(--critical); background:#ff716714; }
    .badge.finished { color:var(--good); background:#70ca9112; }
    .badge.working { color:var(--blue); background:#73a8e812; }
    .badge.idle { color:var(--dim); background:#929cab0d; }
    .meta { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; border-top:1px solid var(--line); margin-top:12px; padding-top:10px; }
    .metric strong { display:block; font-size:13px; font-variant-numeric:tabular-nums; }
    .metric span { display:block; color:var(--faint); font-size:10px; text-transform:uppercase; letter-spacing:.06em; }
    .notice { padding:18px; color:var(--dim); }
    .notice strong { color:var(--ink); display:block; margin-bottom:4px; }
    .hidden { display:none; }
    .controls { margin-top:20px; }
    .control-card { border:1px solid var(--line); border-radius:13px; background:linear-gradient(145deg,#151a22,#0e1218); padding:14px; margin-top:10px; }
    .control-card h3 { margin:0 0 4px; font-size:15px; }
    .control-card p { color:var(--dim); font-size:12px; margin-bottom:10px; }
    .fields { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; }
    select,textarea,button { font:inherit; }
    select,textarea { width:100%; color:var(--ink); background:#0a0e14; border:1px solid var(--line); border-radius:9px; padding:10px; font-size:16px; }
    textarea { min-height:78px; resize:vertical; grid-column:1 / -1; }
    button { border:1px solid #d89b43; background:#e1a651; color:#17110a; font-weight:760; border-radius:9px; min-height:42px; padding:8px 12px; touch-action:manipulation; }
    button.secondary { color:var(--ink); background:transparent; border-color:var(--line); }
    button:disabled { opacity:.55; }
    .control-result { color:var(--dim); min-height:20px; font-size:12px; margin-top:8px; }
    .terminal { margin-top:10px; min-height:180px; max-height:58vh; overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; padding:13px; border-radius:10px; background:#06080c; border:1px solid var(--line); color:#edf2f7; font:13px/1.58 ui-monospace,SFMono-Regular,Menlo,monospace; -webkit-text-size-adjust:100%; }
    .terminal-head { display:flex; align-items:center; justify-content:space-between; gap:10px; }
    footer { color:var(--faint); font-size:11px; margin-top:24px; text-align:center; }
    @media (max-width:680px) { .stats { grid-template-columns:repeat(2,minmax(0,1fr)); } .grid { grid-template-columns:1fr; } header { align-items:flex-start; flex-direction:column; gap:8px; } }
    @media (prefers-reduced-motion:no-preference) { .dot.live { animation:pulse 2.4s ease-in-out infinite; } @keyframes pulse { 50% { box-shadow:0 0 0 6px #70ca9114; } } }
  </style>
</head>
<body>
  <main>
    <header>
      <div><div class="eyebrow">Read-only fleet monitor</div><h1 id="host">Wanigan</h1></div>
      <div class="connection"><span id="dot" class="dot"></span><span id="connection">Connecting…</span></div>
    </header>
    <section id="pair" class="notice hidden"><strong>This Wanigan app is not paired yet.</strong><p style="margin-top:6px">On the Mac, open Wanigan Settings → Phone monitor and type its ten-character pairing code here.</p><form id="pair-form" style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap"><input id="pair-token" aria-label="Pairing code" autocomplete="one-time-code" autocapitalize="characters" placeholder="Pairing code" maxlength="12" style="flex:1;min-width:220px"><button>Pair this app</button></form></section>
    <section id="error" class="notice hidden"><strong>Could not read Wanigan.</strong><span id="error-text">The next poll will retry.</span></section>
    <section id="dashboard" class="hidden">
      <div class="stats">
        <div class="stat"><strong id="needs">0</strong><span>Needs you</span></div>
        <div class="stat"><strong id="running">0</strong><span>Running</span></div>
        <div class="stat"><strong id="cost">$0.00</strong><span>Fleet spend</span></div>
        <div class="stat"><strong id="tokens">0</strong><span>Output tokens</span></div>
      </div>
      <h2>Sessions</h2>
      <div id="sessions" class="grid"></div>
      <div id="empty" class="notice hidden"><strong>No session panes are open.</strong>Start one in Wanigan and it will appear on the next poll.</div>
      <section id="controls" class="controls hidden">
        <h2>iPad control</h2>
        <div class="control-card">
          <h3>Start an agent</h3><p>Launches a normal Wanigan session on your Mac. The prompt is sent to the selected provider.</p>
          <form id="launch-form" class="fields"><select id="project" aria-label="Project"></select><select id="provider" aria-label="Provider"></select><select id="model" aria-label="Model"></select><select id="effort" aria-label="Reasoning effort"></select><textarea id="launch-prompt" aria-label="Task for the new agent" maxlength="8000" required placeholder="What should this agent do?"></textarea><button>Start session</button></form>
        </div>
        <div class="control-card">
          <h3>Chat with this agent</h3><p>Type the next instruction for the selected session, or interrupt its current turn. Permission decisions still stay at the Mac.</p>
          <form id="prompt-form" class="fields"><select id="session" aria-label="Running session"></select><textarea id="session-prompt" aria-label="Message for the selected agent" maxlength="8000" required placeholder="Type a message to this agent…"></textarea><button>Send message</button><button id="interrupt" type="button" class="secondary">Interrupt turn</button></form>
        </div>
        <div class="control-card"><div class="terminal-head"><div><h3 id="terminal-title">Live terminal</h3><p>Latest terminal output from the selected session.</p></div><button id="terminal-refresh" type="button" class="secondary">Refresh</button></div><pre id="terminal" class="terminal">Choose a running session to open its terminal.</pre></div>
        <div id="control-result" class="control-result" role="status"></div>
      </section>
    </section>
    <footer id="updated">No fleet data yet.</footer>
  </main>
  <script nonce="${nonce}">
    (() => {
      'use strict';
      const KEY = 'wanigan.mobile.token';
      const byId = (id) => document.getElementById(id);
      const pair = byId('pair');
      const error = byId('error');
      const dashboard = byId('dashboard');
      const dot = byId('dot');
      const connection = byId('connection');
      let busy = false;
      // Remote actions start real local processes. A mobile browser can emit
      // two taps before the first request returns, so never turn one intended
      // launch or instruction into duplicate agents or duplicate prompts.
      let actionBusy = false;
      let controlOptions = null;
      let visibleSessions = [];
      let terminalBusy = false;
      let requestedSessionId = '';
      const control = byId('controls');
      const controlResult = byId('control-result');

      function syncActionButtons() {
        const launch = byId('launch-form').querySelector('button');
        const prompt = byId('prompt-form').querySelector('button');
        const interrupt = byId('interrupt');
        launch.disabled = actionBusy || !byId('project').value || !byId('provider').value || !byId('launch-prompt').value.trim();
        prompt.disabled = actionBusy || !byId('session').value || !byId('session-prompt').value.trim();
        interrupt.disabled = actionBusy || !byId('session').value;
      }

      function setActionBusy(next) {
        actionBusy = next;
        syncActionButtons();
      }

      async function api(path, init) {
        const token = localStorage.getItem(KEY);
        const endpoint = new URL(path, location.href); endpoint.hash = '';
        const response = await fetch(endpoint, Object.assign({ headers: { authorization: 'Bearer ' + token }, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' }, init || {}));
        if (response.status === 401) { localStorage.removeItem(KEY); throw new Error('Pairing expired.'); }
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || ('Wanigan returned HTTP ' + response.status + '.'));
        return data;
      }
      function option(value, label) { const out = node('option', '', label); out.value = value; return out; }
      function restoreValue(select, value) {
        if ([...select.options].some((item) => item.value === value)) select.value = value;
      }
      function renderLaunchChoices(previous) {
        const provider = (controlOptions && controlOptions.providers || []).find((value) => value.id === byId('provider').value);
        const model = byId('model'), effort = byId('effort');
        model.replaceChildren(option('', 'Provider default model'), ...((provider && provider.models) || []).map((value) => option(value.value, value.label)));
        effort.replaceChildren(option('', 'Provider default effort'), ...((provider && provider.efforts) || []).map((value) => option(value, value)));
        restoreValue(model, previous && previous.model || model.value);
        restoreValue(effort, previous && previous.effort || effort.value);
        model.disabled = !provider || !(provider.models || []).length;
        effort.disabled = !provider || !(provider.efforts || []).length;
      }
      async function loadTerminal() {
        const select = byId('session'); const sessionId = select.value;
        const output = byId('terminal');
        if (!sessionId) {
          byId('terminal-title').textContent = 'Live terminal';
          output.textContent = 'Choose a running session to open its terminal.';
          return;
        }
        if (terminalBusy) return;
        terminalBusy = true;
        const follow = output.scrollTop + output.clientHeight >= output.scrollHeight - 24;
        try {
          const detail = await api('api/terminal?session=' + encodeURIComponent(sessionId));
          byId('terminal-title').textContent = detail.title + (detail.running ? ' · live' : ' · ended');
          output.textContent = detail.text || 'No terminal output yet.';
          if (follow) output.scrollTop = output.scrollHeight;
        } catch (error) { output.textContent = error instanceof Error ? error.message : 'Could not read this terminal.'; }
        finally { terminalBusy = false; }
      }
      function openSession(sessionId) {
        requestedSessionId = sessionId;
        void renderControls(visibleSessions).then(() => byId('prompt-form').scrollIntoView({ behavior: 'smooth', block: 'start' }));
      }
      async function renderControls(sessions) {
        visibleSessions = sessions.filter((session) => session.status !== 'exited');
        try {
          if (!controlOptions) controlOptions = await api('api/control');
          const project = byId('project'), provider = byId('provider'), session = byId('session');
          const selected = {
            project: project.value,
            provider: provider.value,
            model: byId('model').value,
            effort: byId('effort').value,
            session: session.value,
          };
          project.replaceChildren(...(controlOptions.projects || []).map((value) => option(value.id, value.name + (value.branch ? ' · ' + value.branch : ''))));
          provider.replaceChildren(...(controlOptions.providers || []).filter((value) => value.available).map((value) => option(value.id, value.label)));
          restoreValue(project, selected.project);
          restoreValue(provider, selected.provider);
          renderLaunchChoices(selected);
          const selectedSession = requestedSessionId || selected.session;
          session.replaceChildren(...visibleSessions.map((value) => option(value.id, value.title + ' · ' + value.projectName)));
          if ([...session.options].some((value) => value.value === selectedSession)) {
            session.value = selectedSession;
            requestedSessionId = '';
          }
          syncActionButtons();
          control.classList.remove('hidden');
          void loadTerminal();
        } catch (error) {
          control.classList.add('hidden');
          if (error instanceof Error && !/disabled/.test(error.message)) controlResult.textContent = error.message;
        }
      }

      function pairingToken(rawValue) {
        let raw = String(rawValue || '').trim();
        if (raw.includes('://')) {
          try { raw = new URL(raw).hash.slice(1); } catch { return ''; }
        }
        if (!raw) return;
        const params = new URLSearchParams(raw);
        let token = params.get('token');
        if (!token && !raw.includes('=')) {
          try { token = decodeURIComponent(raw); } catch { token = ''; }
        }
        return token && /^[A-Za-z0-9_-]{40,128}$/.test(token) ? token : '';
      }
      function tokenFromFragment() {
        const token = pairingToken(location.hash.slice(1));
        if (token) localStorage.setItem(KEY, token);
        history.replaceState(null, '', location.pathname + location.search);
      }

      function text(id, value) { byId(id).textContent = String(value); }
      function number(value) { return Math.max(0, Number(value) || 0).toLocaleString(); }
      function dollars(value) { return '$' + Math.max(0, Number(value) || 0).toFixed(2); }
      function ago(value) {
        const seconds = Math.max(0, Math.round((Date.now() - Number(value || Date.now())) / 1000));
        if (seconds < 60) return seconds + 's';
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return minutes + 'm';
        return Math.floor(minutes / 60) + 'h ' + (minutes % 60) + 'm';
      }
      function node(tag, className, value) {
        const out = document.createElement(tag);
        if (className) out.className = className;
        if (value !== undefined) out.textContent = String(value);
        return out;
      }

      function metric(label, value) {
        const wrap = node('div', 'metric');
        wrap.append(node('strong', '', value), node('span', '', label));
        return wrap;
      }

      function card(session) {
        const out = node('article', 'card');
        const top = node('div', 'card-top');
        const identity = node('div', '');
        const title = session.title || session.projectName || 'Agent session';
        const secondary = [];
        if (session.projectName && session.projectName !== title) secondary.push(session.projectName);
        secondary.push(session.providerId || 'agent');
        if (session.model) secondary.push(session.model);
        identity.append(node('div', 'name', title), node('div', 'provider', secondary.join(' · ')));
        const badge = node('span', 'badge ' + session.attention.kind,
          session.attention.label + ' · ' + ago(session.attention.since));
        top.append(identity, badge);
        const meta = node('div', 'meta');
        meta.append(metric('Spend', session.usage.costStatus === 'unavailable' ? 'Not reported' : dollars(session.usage.costUsd)),
          metric('Requests', number(session.usage.requests)),
          metric('Output', number(session.usage.outTokens)));
        out.append(top, meta);
        if (session.status !== 'exited') {
          out.classList.add('tap'); out.setAttribute('role', 'button'); out.tabIndex = 0;
          out.append(node('div', 'tap-hint', 'Tap to open terminal & reply'));
          out.addEventListener('click', () => openSession(session.id));
          out.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openSession(session.id); } });
        }
        return out;
      }

      function render(snapshot) {
        const totals = snapshot.totals || {};
        const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
        text('host', snapshot.host || 'Wanigan');
        text('needs', number((totals.permission || 0) + (totals.error || 0) + (totals.finished || 0)));
        text('running', number(totals.running));
        text('cost', totals.costUnavailable ? (totals.costUsd > 0 ? dollars(totals.costUsd) + ' + unpriced' : 'Not reported') : dollars(totals.costUsd));
        text('tokens', number(totals.outTokens));
        const list = byId('sessions');
        list.replaceChildren(...sessions.map(card));
        byId('empty').classList.toggle('hidden', sessions.length !== 0);
        text('updated', 'Updated ' + new Date(snapshot.generatedAt || Date.now()).toLocaleTimeString() +
          (snapshot.version ? ' · Wanigan ' + snapshot.version : ''));
        void renderControls(sessions);
      }

      function state(kind, label) {
        dot.className = 'dot' + (kind ? ' ' + kind : '');
        connection.textContent = label;
      }

      async function poll() {
        if (busy || document.hidden) return;
        const token = localStorage.getItem(KEY);
        if (!token) {
          pair.classList.remove('hidden'); dashboard.classList.add('hidden'); error.classList.add('hidden');
          state('bad', 'Pairing required'); return;
        }
        busy = true;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        try {
          const endpoint = new URL('api/status', location.href);
          endpoint.hash = '';
          const response = await fetch(endpoint, {
            headers: { authorization: 'Bearer ' + token },
            cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer',
            signal: controller.signal
          });
          if (response.status === 401) {
            localStorage.removeItem(KEY);
            pair.classList.remove('hidden'); dashboard.classList.add('hidden'); error.classList.add('hidden');
            state('bad', 'Pairing expired'); return;
          }
          if (!response.ok) throw new Error('Wanigan returned HTTP ' + response.status + '.');
          render(await response.json());
          pair.classList.add('hidden'); error.classList.add('hidden'); dashboard.classList.remove('hidden');
          state('live', 'Live · polling every 3s');
        } catch (failure) {
          text('error-text', failure instanceof Error ? failure.message : 'The next poll will retry.');
          error.classList.remove('hidden');
          state('bad', 'Disconnected');
        } finally { clearTimeout(timeout); busy = false; }
      }

      tokenFromFragment();
      byId('pair-form').addEventListener('submit', (event) => {
        event.preventDefault();
        const token = pairingToken(byId('pair-token').value);
        if (token) { byId('pair-token').setCustomValidity(''); localStorage.setItem(KEY, token); byId('pair-token').value = ''; void poll(); return; }
        const code = String(byId('pair-token').value || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
        fetch(new URL('api/pair', location.href), { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({ code }), cache:'no-store', credentials:'omit', referrerPolicy:'no-referrer' })
          .then((response) => response.json().then((body) => ({ response, body })))
          .then(({ response, body }) => { if (!response.ok || !body.token) throw new Error(body.error || 'Pairing failed.'); localStorage.setItem(KEY, body.token); byId('pair-token').value = ''; void poll(); })
          .catch((error) => { byId('pair-token').setCustomValidity(error instanceof Error ? error.message : 'Pairing failed.'); byId('pair-token').reportValidity(); });
      });
      byId('provider').addEventListener('change', () => { renderLaunchChoices(); syncActionButtons(); });
      byId('project').addEventListener('change', syncActionButtons);
      byId('launch-prompt').addEventListener('input', syncActionButtons);
      byId('session-prompt').addEventListener('input', syncActionButtons);
      byId('session').addEventListener('change', () => { syncActionButtons(); byId('terminal').textContent = 'Loading terminal…'; void loadTerminal(); });
      byId('terminal-refresh').addEventListener('click', () => void loadTerminal());
      byId('launch-form').addEventListener('submit', async (event) => {
        event.preventDefault(); controlResult.textContent = 'Starting session…';
        if (actionBusy) return;
        setActionBusy(true);
        try {
          const result = await api('api/action', { method:'POST', headers:{ 'content-type':'application/json', authorization:'Bearer ' + localStorage.getItem(KEY) }, body:JSON.stringify({ action:'launch', projectId:byId('project').value, providerId:byId('provider').value, model:byId('model').value, effort:byId('effort').value, prompt:byId('launch-prompt').value }) });
          byId('launch-prompt').value = ''; syncActionButtons(); controlResult.textContent = 'Started ' + result.session.title + '.';
          requestedSessionId = result.session.id; await poll(); openSession(result.session.id);
        } catch (error) { controlResult.textContent = error instanceof Error ? error.message : 'Could not start the session.'; }
        finally { setActionBusy(false); }
      });
      byId('prompt-form').addEventListener('submit', async (event) => {
        event.preventDefault(); controlResult.textContent = 'Sending instruction…';
        if (actionBusy) return;
        setActionBusy(true);
        try { await api('api/action', { method:'POST', headers:{ 'content-type':'application/json', authorization:'Bearer ' + localStorage.getItem(KEY) }, body:JSON.stringify({ action:'prompt', sessionId:byId('session').value, prompt:byId('session-prompt').value }) }); byId('session-prompt').value = ''; syncActionButtons(); controlResult.textContent = 'Instruction sent.'; void loadTerminal(); }
        catch (error) { controlResult.textContent = error instanceof Error ? error.message : 'Could not send instruction.'; }
        finally { setActionBusy(false); }
      });
      byId('interrupt').addEventListener('click', async () => {
        controlResult.textContent = 'Interrupting…';
        if (actionBusy) return;
        setActionBusy(true);
        try { await api('api/action', { method:'POST', headers:{ 'content-type':'application/json', authorization:'Bearer ' + localStorage.getItem(KEY) }, body:JSON.stringify({ action:'interrupt', sessionId:byId('session').value }) }); controlResult.textContent = 'Interrupt sent.'; void loadTerminal(); }
        catch (error) { controlResult.textContent = error instanceof Error ? error.message : 'Could not interrupt the session.'; }
        finally { setActionBusy(false); }
      });
      void poll();
      setInterval(() => { void poll(); }, 3000);
      setInterval(() => { if (!document.hidden) void loadTerminal(); }, 1500);
      document.addEventListener('visibilitychange', () => { if (!document.hidden) void poll(); });
    })();
  </script>
</body>
</html>`;
}

function dashboardManifest(): string {
  return JSON.stringify({ name: 'Wanigan Remote', short_name: 'Wanigan', display: 'standalone', start_url: './', background_color: '#090b0f', theme_color: '#090b0f', icons: [{ src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }] });
}

function dashboardIcon(): string {
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192"><rect width="192" height="192" rx="42" fill="#11151c"/><path d="M45 46h102v100H45z" fill="#e1a651"/><path d="M61 68h70v16H61zm0 30h70v16H61zm0 30h45v16H61z" fill="#17110a"/></svg>';
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!isLoopback(req.socket.remoteAddress)) {
    req.socket.destroy();
    return;
  }

  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/' || url.pathname === '/index.html') {
    if (req.method !== 'GET') { json(res, 405, { error: 'Method not allowed.' }, { allow: 'GET' }); return; }
    // The shell carries no fleet data and cannot authenticate a top-level
    // navigation: URL fragments are deliberately never sent over HTTP. The
    // bearer-protected API below is the authenticated dashboard boundary.
    const nonce = randomBytes(18).toString('base64');
    send(res, 200, 'text/html; charset=utf-8', dashboardHtml(nonce), nonce);
    return;
  }

  if (url.pathname === '/manifest.webmanifest') {
    if (req.method !== 'GET') { json(res, 405, { error: 'Method not allowed.' }, { allow: 'GET' }); return; }
    send(res, 200, 'application/manifest+json; charset=utf-8', dashboardManifest());
    return;
  }
  if (url.pathname === '/icon.svg') {
    if (req.method !== 'GET') { json(res, 405, { error: 'Method not allowed.' }, { allow: 'GET' }); return; }
    send(res, 200, 'image/svg+xml; charset=utf-8', dashboardIcon());
    return;
  }

  if (url.pathname === '/api/status') {
    if (req.method !== 'GET') { json(res, 405, { error: 'Method not allowed.' }, { allow: 'GET' }); return; }
    if (!authorized(req)) {
      json(res, 401, { error: 'Missing or invalid mobile monitor token.' }, {
        'www-authenticate': 'Bearer realm="wanigan-mobile"',
      });
      return;
    }
    await serveStatus(res);
    return;
  }

  if (url.pathname === '/api/pair') {
    await servePair(req, res);
    return;
  }

  if (url.pathname === '/api/control' || url.pathname === '/api/action' || url.pathname === '/api/terminal') {
    if (!authorized(req)) {
      json(res, 401, { error: 'Missing or invalid mobile monitor token.' }, { 'www-authenticate': 'Bearer realm="wanigan-mobile"' });
      return;
    }
    await serveControl(req, res, url);
    return;
  }

  json(res, 404, { error: 'Not found.' });
}

function closeServer(target: http.Server | null): void {
  if (!target) return;
  try { target.closeAllConnections(); } catch { /* older Node or already closed */ }
  try { target.close(); } catch { /* never reached listen */ }
}

/** Start the fixed-port loopback dashboard when its opt-in setting is on. */
export async function startMobileMonitor(): Promise<MobileMonitorStatus> {
  const config = mobileConfig();
  if (!config.dashboardEnabled) {
    stopMobileMonitor();
    lastServerError = null;
    return mobileStatus();
  }
  if (!mobileCredentialsReady()) {
    stopMobileMonitor();
    lastServerError = secretsError
      ?? 'Encrypted phone-monitor credentials are unavailable, so the listener was not started.';
    return mobileStatus();
  }

  if (server?.listening && serverPort === config.port) {
    lastServerError = null;
    return mobileStatus();
  }

  if (starting) {
    await starting.catch(() => {});
    if (server?.listening && serverPort === config.port) return mobileStatus();
  }

  stopMobileMonitor();
  const version = ++lifecycleVersion;
  const candidate = http.createServer((req, res) => {
    void handle(req, res).catch(() => {
      try { json(res, 500, { error: 'Wanigan could not answer the mobile monitor request.' }); }
      catch { /* socket already gone */ }
    });
  });
  pendingServer = candidate;
  candidate.keepAliveTimeout = 2_000;
  candidate.headersTimeout = 5_000;
  candidate.requestTimeout = 5_000;
  candidate.maxHeadersCount = 32;
  candidate.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  const task = new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      reject(new Error(
        error.code === 'EADDRINUSE'
          ? `Port ${config.port} is already in use. Choose another mobile monitor port.`
          : `The mobile monitor could not bind 127.0.0.1:${config.port}: ${error.message}`
      ));
    };
    candidate.once('error', onError);
    candidate.listen(config.port, '127.0.0.1', () => {
      candidate.off('error', onError);
      resolve();
    });
  });
  starting = task;

  try {
    await task;
    if (version !== lifecycleVersion || !mobileConfig().dashboardEnabled) {
      closeServer(candidate);
    } else {
      server = candidate;
      serverPort = config.port;
      pendingServer = null;
      lastServerError = null;
      // Post-bind socket noise must not take the app or the monitor down.
      candidate.on('error', (error) => { lastServerError = safeString(error.message, 240, 'Socket error.'); });
    }
  } catch (error) {
    closeServer(candidate);
    pendingServer = null;
    if (version === lifecycleVersion) {
      lastServerError = safeString(
        error instanceof Error ? error.message : String(error),
        300,
        'The mobile monitor could not start.',
      );
    }
  } finally {
    if (starting === task) starting = null;
  }

  return mobileStatus();
}

/** Stop accepting requests and destroy keep-alive sockets immediately. */
export function stopMobileMonitor(): void {
  lifecycleVersion++;
  closeServer(pendingServer);
  pendingServer = null;
  closeServer(server);
  server = null;
  serverPort = null;
  for (const socket of sockets) {
    try { socket.destroy(); } catch { /* already closed */ }
  }
  sockets.clear();
}

function pushText(value: unknown, max: number): string {
  const flat = safeString(value, max);
  // Push payloads leave the machine. Refuse the two common absolute-path
  // shapes even if a caller accidentally hands over an attention detail.
  return flat
    .replace(/(^|\s)(?:~\/|\/(?!\/))[^\s]+/g, '$1[local path]')
    .replace(/(^|\s)[A-Za-z]:\\[^\s]+/g, '$1[local path]');
}

async function responseSnippet(response: Response, limit = 4_096): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let out = '';
  try {
    while (size < limit) {
      const item = await reader.read();
      if (item.done) break;
      const take = item.value.subarray(0, Math.max(0, limit - size));
      size += take.length;
      out += decoder.decode(take, { stream: size < limit });
      if (take.length < item.value.length) break;
    }
  } finally {
    try { await reader.cancel(); } catch { /* response already ended */ }
  }
  return safeString(out, limit);
}

function rememberPush(result: MobilePushResult): MobilePushResult {
  pushResult = result;
  return { ...result };
}

/** Most recent ntfy attempt, including skips; no secret or response body is retained. */
export function lastMobilePushResult(): MobilePushResult | null {
  return pushResult ? { ...pushResult } : null;
}

/**
 * Publish one privacy-bounded notification through ntfy.
 *
 * The function never rejects. Notification delivery is commentary on the work
 * and cannot be allowed to abort a hook handler, poll cycle, or session exit.
 */
export async function sendMobilePush(input: MobilePushInput, force = false): Promise<MobilePushResult> {
  const at = Date.now();
  try {
    const config = mobileConfig();
    if (!force && !config.pushEnabled) {
      return rememberPush({ at, ok: false, skipped: true, retryable: true, httpStatus: null, error: null });
    }
    if (!mobileCredentialsReady()) {
      return rememberPush({
        at,
        ok: false,
        skipped: false,
        retryable: true,
        httpStatus: null,
        error: secretsError ?? 'Encrypted phone-monitor credentials are unavailable.',
      });
    }
    if (!config.pushServer) {
      return rememberPush({
        at, ok: false, skipped: false, retryable: false, httpStatus: null,
        error: 'Mobile push is enabled but no HTTPS ntfy server is configured.',
      });
    }

    const serverUrl = normaliseHttpsUrl(config.pushServer, 'ntfy server');
    const title = pushText(input.title, 200);
    const message = pushText(input.body, 1_200);
    if (!title || !message) {
      return rememberPush({
        at, ok: false, skipped: false, retryable: false, httpStatus: null,
        error: 'A mobile push needs both a title and a message.',
      });
    }

    const payload: Record<string, unknown> = {
      topic: config.pushTopic,
      title,
      message,
      priority: input.urgent ? 5 : 3,
    };
    // Do not attach the private dashboard URL as ntfy's click target. A
    // tailnet hostname is still network-identifying metadata, and the alert
    // needs only enough information to decide whether to open the separately
    // paired dashboard.

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MOBILE_PUSH_TIMEOUT_MS);
    timer.unref?.();
    try {
      const response = await fetch(serverUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
        redirect: 'error',
        referrerPolicy: 'no-referrer',
      });
      if (!response.ok) {
        const detail = await responseSnippet(response);
        return rememberPush({
          at,
          ok: false,
          skipped: false,
          retryable: response.status === 408 || response.status === 425
            || response.status === 429 || response.status >= 500,
          httpStatus: response.status,
          error: safeString(
            `ntfy returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
            500,
          ),
        });
      }
      // Drain a bounded prefix so the connection can be reused without ever
      // retaining ntfy's response payload.
      await responseSnippet(response);
      return rememberPush({
        at, ok: true, skipped: false, retryable: false, httpStatus: response.status, error: null,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'AbortError';
    return rememberPush({
      at,
      ok: false,
      skipped: false,
      retryable: true,
      httpStatus: null,
      error: timedOut
        ? `ntfy did not answer within ${Math.round(MOBILE_PUSH_TIMEOUT_MS / 1_000)} seconds.`
        : safeString(error instanceof Error ? error.message : String(error), 500, 'Mobile push failed.'),
    });
  }
}

/** Send a recognisable, non-urgent notification from Settings. */
export function testMobilePush(): Promise<MobilePushResult> {
  return sendMobilePush({
    title: 'Wanigan mobile test',
    body: 'Notifications are connected. Wanigan will use this channel only when configured to do so.',
    urgent: false,
  }, true);
}
