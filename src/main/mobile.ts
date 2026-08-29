import http from 'node:http';
import type { Socket } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
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
const SNAPSHOT_TIMEOUT_MS = 3_000;
const TOKEN_BYTES = 32;
const TOPIC_BYTES = 24;

const KEY = {
  dashboardEnabled: 'mobile_dashboard_enabled',
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
let server: http.Server | null = null;
let serverPort: number | null = null;
let pendingServer: http.Server | null = null;
let starting: Promise<void> | null = null;
let lifecycleVersion = 0;
let lastServerError: string | null = null;
let pushResult: MobilePushResult | null = null;
const sockets = new Set<Socket>();

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
  if (!safeStorage.isEncryptionAvailable()) {
    if (process.env.WANIGAN_SMOKE === '1') {
      memorySecrets = { ...value };
      secretsError = null;
      return;
    }
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
  try {
    fs.writeFileSync(next, encrypted, { mode: 0o600, flag: 'wx' });
    try { fs.chmodSync(next, 0o600); } catch { /* best effort on odd filesystems */ }
    fs.renameSync(next, file);
  } finally {
    try { fs.rmSync(next, { force: true }); } catch { /* rename already consumed it */ }
  }
  memorySecrets = { ...value };
  secretsError = null;
}

function mobileSecrets(): MobileSecrets {
  if (!safeStorage.isEncryptionAvailable()) {
    if (process.env.WANIGAN_SMOKE === '1') {
      memorySecrets ??= { token: generateToken(), topic: generateTopic() };
      secretsError = null;
      return memorySecrets;
    }
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

/** Read the persisted, non-secret monitor configuration. */
export function mobileConfig(): MobileMonitorConfig {
  return {
    dashboardEnabled: boolSetting(KEY.dashboardEnabled),
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

function dashboardHtml(nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="color-scheme" content="dark">
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
    <section id="pair" class="notice hidden"><strong>This phone is not paired.</strong>Open the fresh pairing link from Wanigan Settings.</section>
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

      function tokenFromFragment() {
        const raw = location.hash.slice(1);
        if (!raw) return;
        const params = new URLSearchParams(raw);
        let token = params.get('token');
        if (!token && !raw.includes('=')) {
          try { token = decodeURIComponent(raw); } catch { token = ''; }
        }
        if (token && /^[A-Za-z0-9_-]{40,128}$/.test(token)) localStorage.setItem(KEY, token);
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
      void poll();
      setInterval(() => { void poll(); }, 3000);
      document.addEventListener('visibilitychange', () => { if (!document.hidden) void poll(); });
    })();
  </script>
</body>
</html>`;
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!isLoopback(req.socket.remoteAddress)) {
    req.socket.destroy();
    return;
  }

  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (req.method !== 'GET') {
    json(res, 405, { error: 'The mobile monitor is read-only.' }, { allow: 'GET' });
    return;
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    // The shell carries no fleet data and cannot authenticate a top-level
    // navigation: URL fragments are deliberately never sent over HTTP. The
    // bearer-protected API below is the authenticated dashboard boundary.
    const nonce = randomBytes(18).toString('base64');
    send(res, 200, 'text/html; charset=utf-8', dashboardHtml(nonce), nonce);
    return;
  }

  if (url.pathname === '/api/status') {
    if (!authorized(req)) {
      json(res, 401, { error: 'Missing or invalid mobile monitor token.' }, {
        'www-authenticate': 'Bearer realm="wanigan-mobile"',
      });
      return;
    }
    await serveStatus(res);
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
