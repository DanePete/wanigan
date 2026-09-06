import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { shellPath } from './providers';
import type { TailnetStatus } from '../shared/types';

const exec = promisify(execFile);

/**
 * Wanigan's phone dashboard binds to loopback on purpose, so reaching it from
 * an iPad means putting a private HTTPS proxy in front of it.  Settings used to
 * print a `tailscale serve` command for the operator to copy into a terminal,
 * and then ask for the resulting URL to be pasted back — two hand-offs Wanigan
 * could neither perform nor observe, which is why the panel could only ever
 * describe the transport instead of reporting on it.  This module runs the CLI
 * itself and answers with what it saw.
 *
 * Every state it reports is a different next action: install Tailscale, sign in
 * to Tailscale, press Serve, here is your URL, and this probe failed.  Collapse
 * any two and the screen tells the operator to do the wrong one — a person who
 * is signed out reading "press Serve" gets an IPN-state error from a CLI they
 * never ran.  So the states stay separate and none of them is inferred: a
 * status is only ever what a probe actually returned.
 *
 * Nothing here builds a shell string.  A MagicDNS name, a proxy target and a
 * port all arrive from other programs, and execFile with an argv array is what
 * keeps them arguments rather than syntax.
 */

/**
 * Where a Mac keeps the tailscale CLI.  The App Store build installs no binary
 * into a bin directory at all — its command line *is* the app executable, which
 * Tailscale's own setup instructions tell people to alias — so that path comes
 * first, and the open-source and Homebrew locations follow.  On this machine
 * /usr/local/bin/tailscale turned out to be a two-line shell wrapper around the
 * app executable, which is exactly why the list is ordered rather than scored:
 * any entry that answers is the CLI.
 */
const CANDIDATES = [
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  '/usr/local/bin/tailscale',
  '/opt/homebrew/bin/tailscale',
];

/** Local IPC to a running daemon; when it is slow, something is already wrong. */
const PROBE_TIMEOUT_MS = 8_000;
/**
 * Starting Serve for the first time can wait on a fresh TLS certificate for the
 * MagicDNS name, which is a network round trip through Let's Encrypt rather
 * than a local call.  A probe timeout here would report a failure for work that
 * was still succeeding.
 */
const ACTION_TIMEOUT_MS = 45_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
/** A status line for a person, not a log: enough to act on, bounded on purpose. */
const MESSAGE_CAP = 300;

type Probe =
  | { ok: true; text: string }
  | { ok: false; message: string; missing: boolean };

/**
 * What a read-only probe needs, and nothing else.  Handing a child the whole of
 * process.env passes every credential the launching shell exported to something
 * that reads two JSON documents, which is the opposite of what every other
 * spawn in main does.  HOME is not optional: the App Store build authenticates
 * to its own daemon through a token file under the user's Library container, so
 * a HOME-less probe reports "not signed in" about a signed-in machine.
 * TS_SOCKET survives because a person who moved their tailscaled socket has to
 * be able to reach it here too.
 */
function probeEnv(PATH: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH };
  for (const name of ['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'TS_SOCKET']) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/** First existing executable among the candidates, or null — providers.ts idiom. */
function firstExecutable(candidates: string[]): string | null {
  for (const c of candidates) {
    try { fs.accessSync(c, fs.constants.X_OK); return c; } catch { /* next */ }
  }
  return null;
}

/**
 * A path is a candidate, never a verdict.  An executable file at one of these
 * locations is not proof that Tailscale is installed and working — that claim
 * belongs to a probe that exited — so this only answers "what would we run".
 */
async function resolveTailscale(): Promise<string | null> {
  const onDisk = firstExecutable(CANDIDATES);
  if (onDisk) return onDisk;
  // A GUI app inherits launchd's PATH rather than the shell's, which is why
  // providers.ts resolves CLIs through the login shell's PATH; an unusual
  // install location is invisible without it.
  const PATH = await shellPath();
  return firstExecutable(PATH.split(':').filter(Boolean).map((d) => path.join(d, 'tailscale')));
}

function firstLine(text: string): string {
  return text.split('\n').map((line) => line.trim()).find((line) => line.length > 0) ?? '';
}

/**
 * execFile rather than a hand-rolled spawn, for the reason codex-status.ts
 * records: its callback fires once stdout and stderr have closed, not on
 * `exit`, and settling on `exit` can drop the last chunk of a reply and then
 * blame a timeout for a child that answered.  The timeout kills the child, so a
 * daemon that never responds ends as a sentence on screen rather than a panel
 * that spins forever.
 */
async function run(bin: string, args: string[], timeoutMs: number): Promise<Probe> {
  const PATH = await shellPath();
  try {
    const { stdout } = await exec(bin, args, {
      timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, env: probeEnv(PATH),
    });
    return { ok: true, text: stdout };
  } catch (e) {
    const err = e as { code?: unknown; killed?: boolean; stderr?: unknown; message?: unknown };
    const missing = err.code === 'ENOENT' || err.code === 'EACCES';
    if (err.killed === true) {
      return {
        ok: false, missing,
        message: `\`tailscale ${args.join(' ')}\` did not answer within ${Math.round(timeoutMs / 1000)} seconds.`,
      };
    }
    // The CLI's own words beat a wrapper's: "failed to connect to local
    // tailscaled" is actionable, "Command failed with exit code 1" is not.
    const said = firstLine(typeof err.stderr === 'string' ? err.stderr : '')
      || (typeof err.message === 'string' ? firstLine(err.message) : '');
    return {
      ok: false, missing,
      message: said ? said.slice(0, MESSAGE_CAP) : `\`tailscale ${args.join(' ')}\` failed without saying why.`,
    };
  }
}

function base(port: number): { port: number; checkedAt: number } {
  return { port, checkedAt: Date.now() };
}

function failed(port: number, message: string): TailnetStatus {
  return { ...base(port), state: 'error', message: message.slice(0, MESSAGE_CAP) };
}

/** Bounded, quoted evidence for a reply Wanigan could not read. */
function unreadable(port: number, what: string, text: string): TailnetStatus {
  const sample = text.trim().slice(0, 160);
  return failed(port, sample
    ? `Wanigan could not read ${what}: ${sample}`
    : `${what} came back empty.`);
}

function asObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch { return null; }
}

/**
 * A MagicDNS name is about to be rendered as a link and stored as a dashboard
 * URL, and it reaches us from another program.  Only the characters a DNS name
 * can contain survive; anything else is reported as no name rather than
 * smuggled into a URL.
 */
function hostName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().replace(/\.$/, '');
  return /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(value) ? value : null;
}

/**
 * Why one state covers every not-Running backend.  The sentences differ and the
 * screen prints the sentence, but the fix is the same in all of them and none
 * of it is Wanigan's: `tailscale serve` needs a signed-in, running daemon.  The
 * raw BackendState travels alongside so the panel can name the actual
 * condition — telling someone whose machine is waiting on admin approval to
 * "sign in" sends them to a login page that will not help.
 */
const NOT_CONNECTED: Record<string, string> = {
  NeedsLogin: 'Tailscale is installed but not signed in.',
  NoState: 'Tailscale is installed but has not started.',
  NeedsMachineAuth: 'This machine is signed in and waiting for approval by a tailnet admin.',
  Stopped: 'Tailscale is signed in but switched off.',
  Starting: 'Tailscale is still connecting.',
};

type Backend =
  | { kind: 'status'; status: TailnetStatus }
  | { kind: 'connected'; magicDnsName: string | null };

/** Pure half of the first probe: `tailscale status --json` in, a state out. */
function readBackend(port: number, status: Probe): Backend {
  if (!status.ok) {
    return {
      kind: 'status',
      // A binary that vanished between resolution and execution is the same
      // fact as one that was never there; anything else is a real failure and
      // keeps the CLI's own words.
      status: status.missing ? { ...base(port), state: 'absent' } : failed(port, status.message),
    };
  }
  const parsed = asObject(status.text);
  if (!parsed) return { kind: 'status', status: unreadable(port, 'the Tailscale status reply', status.text) };
  const backendState = typeof parsed.BackendState === 'string' ? parsed.BackendState : '';
  if (!backendState) {
    return { kind: 'status', status: unreadable(port, 'the Tailscale status reply', status.text) };
  }
  const self = parsed.Self && typeof parsed.Self === 'object' ? parsed.Self as Record<string, unknown> : {};
  const magicDnsName = hostName(self.DNSName);
  if (backendState !== 'Running') {
    return {
      kind: 'status',
      status: {
        ...base(port),
        state: 'logged-out',
        backendState,
        message: NOT_CONNECTED[backendState] ?? `Tailscale is not connected; it reports ${backendState}.`,
      },
    };
  }
  return { kind: 'connected', magicDnsName };
}

/**
 * The shape of `tailscale serve status --json`, which is Tailscale's own
 * ServeConfig.  Only the parts Wanigan needs are named, and every one of them
 * is `unknown` until checked: this is another program's document, read on the
 * strength of a version that may not be the one installed.
 */
type RawServe = {
  Web?: unknown;
  AllowFunnel?: unknown;
  Foreground?: unknown;
};

type Mapping = {
  /** The `host:port` key Serve filed this under; it is also the public origin. */
  hostPort: string;
  mountPath: string;
  url: string;
  funnel: boolean;
  /**
   * False when the mapping belongs to a `tailscale serve` still running in
   * someone's terminal.  Such a mapping disappears when that command does, and
   * an `off` aimed at the background config would not touch it.
   */
  background: boolean;
};

/**
 * Which local port a Serve handler forwards to, when that port is on this
 * machine.  Serve records a target as a URL and accepts one without a scheme,
 * so both are normalised before parsing.  A handler pointing somewhere other
 * than loopback is not Wanigan's listener no matter which port it names, and
 * claiming it would put someone else's URL on our screen.
 */
function loopbackProxyPort(proxy: unknown): number | null {
  if (typeof proxy !== 'string' || !proxy.trim()) return null;
  const value = proxy.trim();
  const withScheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value) ? value : `http://${value}`;
  let url: URL;
  try { url = new URL(withScheme); } catch { return null; }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const loopback = host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
  if (!loopback) return null;
  const parsed = Number(url.port);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : null;
}

/**
 * The browsable URL for a Serve mount.  The host and port come from the config
 * key rather than from the MagicDNS name in `status`, because the key is what
 * the proxy actually answers on; 443 is left implicit the way the CLI prints
 * it.  A key that does not parse into a plain hostname and port yields no URL
 * at all — a half-built link is worse than reporting that we could not read it.
 */
function serveUrl(hostPort: string, mountPath: string): string | null {
  const cut = hostPort.lastIndexOf(':');
  if (cut <= 0) return null;
  const host = hostName(hostPort.slice(0, cut));
  const port = Number(hostPort.slice(cut + 1));
  if (!host || !Number.isInteger(port) || port < 1 || port > 65_535) return null;
  const origin = port === 443 ? `https://${host}` : `https://${host}:${port}`;
  const mount = mountPath.startsWith('/') ? mountPath : `/${mountPath}`;
  return `${origin}${mount}`;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** The first handler in one ServeConfig that proxies to `port` on loopback. */
function mappingIn(config: RawServe, port: number, background: boolean): Mapping | null {
  const funnels = record(config.AllowFunnel);
  for (const [hostPort, web] of Object.entries(record(config.Web))) {
    const handlers = record(record(web).Handlers);
    for (const [mountPath, handler] of Object.entries(handlers)) {
      if (loopbackProxyPort(record(handler).Proxy) !== port) continue;
      const url = serveUrl(hostPort, mountPath);
      if (!url) continue;
      return { hostPort, mountPath, url, funnel: funnels[hostPort] === true, background };
    }
  }
  return null;
}

/**
 * A foreground `tailscale serve` files its mapping under its own session id
 * instead of in the background config.  Reporting only the background half
 * would show "not serving" while the URL works, so both are read — and the
 * mapping remembers which half it came from, because only one of them can be
 * turned off by a command.
 */
function findMapping(config: RawServe, port: number): Mapping | null {
  const inBackground = mappingIn(config, port, true);
  if (inBackground) return inBackground;
  for (const session of Object.values(record(config.Foreground))) {
    const found = mappingIn(record(session) as RawServe, port, false);
    if (found) return found;
  }
  return null;
}

/** Pure half of the second probe: `tailscale serve status --json` in, a state out. */
function readServe(port: number, magicDnsName: string | null, serve: Probe): TailnetStatus {
  if (!serve.ok) return failed(port, serve.message);
  // An empty serve config prints `{}` and exits 0, so "nothing is served" is a
  // successful read.  Output that is not a JSON object at all is not: reporting
  // that as a cheerful "ready" would hide a CLI whose output changed shape.
  const parsed = asObject(serve.text);
  if (!parsed) return unreadable(port, 'the Tailscale serve configuration', serve.text);
  const mapping = findMapping(parsed as RawServe, port);
  if (!mapping) return { ...base(port), state: 'ready', magicDnsName };
  return {
    ...base(port),
    state: 'serving',
    url: mapping.url,
    magicDnsName,
    funnel: mapping.funnel,
    background: mapping.background,
  };
}

/**
 * The renderer's number never reaches argv unchecked, and neither does main's:
 * this is the last gate before a port is stringified into an argument list.
 * The range matches the phone monitor's own validation, so a port Wanigan
 * refuses to listen on is also one it refuses to publish.
 */
function assertPort(port: number): number {
  if (!Number.isInteger(port) || port < 1_024 || port > 65_535) {
    throw new Error('Wanigan can only serve a whole port number from 1024 through 65535.');
  }
  return port;
}

/** `tailscale serve --bg <port>`: background, so it outlives the child we spawn. */
function serveArgv(port: number): string[] {
  return ['serve', '--bg', String(assertPort(port))];
}

/**
 * The off form, aimed at the mapping Wanigan actually found.  Tailscale
 * documents `off` as a trailing positional and requires the original flags
 * alongside it, and `off` removes whatever is mounted at that HTTPS port and
 * path regardless of the target named — which is precisely why the port here is
 * the one read back from `serve status` rather than an assumed 443.  Guessing
 * would let Wanigan delete a Serve mapping it never created.
 */
function unserveArgv(port: number, hostPort: string, mountPath: string): string[] {
  const httpsPort = Number(hostPort.slice(hostPort.lastIndexOf(':') + 1));
  if (!Number.isInteger(httpsPort) || httpsPort < 1 || httpsPort > 65_535) {
    throw new Error('Tailscale reported a serve mapping Wanigan could not address.');
  }
  const argv = ['serve', `--https=${httpsPort}`];
  if (mountPath !== '/') argv.push(`--set-path=${mountPath}`);
  argv.push(String(assertPort(port)), 'off');
  return argv;
}

/** What Wanigan can observe about Tailscale for one loopback port, right now. */
export async function tailnetStatus(port: number): Promise<TailnetStatus> {
  const validated = assertPort(port);
  const bin = await resolveTailscale();
  if (!bin) return { ...base(validated), state: 'absent' };
  const backend = readBackend(validated, await run(bin, ['status', '--json'], PROBE_TIMEOUT_MS));
  if (backend.kind === 'status') return backend.status;
  return readServe(validated, backend.magicDnsName, await run(bin, ['serve', 'status', '--json'], PROBE_TIMEOUT_MS));
}

/**
 * Start serving, but only from the one state where serving is the next step.
 * Running `serve` at a signed-out daemon produces an IPN-state error about a
 * command the operator never typed; returning the state we read instead keeps
 * the instruction on screen truthful, and re-reading afterwards means the URL
 * is Tailscale's answer rather than one Wanigan assembled from a hostname.
 */
export async function tailnetServe(port: number): Promise<TailnetStatus> {
  const validated = assertPort(port);
  const before = await tailnetStatus(validated);
  if (before.state !== 'ready') return before;
  const bin = await resolveTailscale();
  if (!bin) return { ...base(validated), state: 'absent' };
  const started = await run(bin, serveArgv(validated), ACTION_TIMEOUT_MS);
  if (!started.ok) return failed(validated, started.message);
  return tailnetStatus(validated);
}

/**
 * Stop serving.  Tailscale's Serve mapping outlives Wanigan — the Settings copy
 * has always warned that turning the dashboard off leaves the proxy up — and
 * this is what makes that removable rather than advice.  It removes only a
 * mapping it just read pointing at our own loopback port, so an unrelated Serve
 * on the same machine survives.
 */
export async function tailnetUnserve(port: number): Promise<TailnetStatus> {
  const validated = assertPort(port);
  const bin = await resolveTailscale();
  if (!bin) return { ...base(validated), state: 'absent' };
  const serve = await run(bin, ['serve', 'status', '--json'], PROBE_TIMEOUT_MS);
  if (!serve.ok) return failed(validated, serve.message);
  const parsed = asObject(serve.text);
  if (!parsed) return unreadable(validated, 'the Tailscale serve configuration', serve.text);
  const mapping = findMapping(parsed as RawServe, validated);
  // Nothing of ours is mapped, so there is nothing to remove; report what is
  // actually true instead of an outcome.
  if (!mapping) return tailnetStatus(validated);
  if (!mapping.background) {
    return failed(validated, `${mapping.url} is served by a \`tailscale serve\` running in a terminal. `
      + 'It stops when that command does, and Wanigan will not end someone else\'s process.');
  }
  const stopped = await run(bin, unserveArgv(validated, mapping.hostPort, mapping.mountPath), ACTION_TIMEOUT_MS);
  if (!stopped.ok) return failed(validated, stopped.message);
  return tailnetStatus(validated);
}

/**
 * The parse and argv seams, exported the way codex-status.ts exports its own.
 * A transport panel that reads a renamed field as "not serving", or an unread
 * reply as "not installed", would tell the operator to install software they
 * already have — so the classification is asserted against captured CLI output
 * rather than against a binary that may not exist on the machine running the
 * suite.
 */
export const __test = {
  readBackend, readServe, serveArgv, unserveArgv, findMapping, loopbackProxyPort, serveUrl,
};
