// Tailscale, through its own CLI (1.102, read from `tailscale serve --help`):
// what state it is in on this Mac, and Wanigan's one mount on the owner's
// private address. Wanigan only ever adds or removes `/wanigan`; anything else
// the owner serves is left exactly as it is.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { PHONE_PATH, serveCommand, type TailscaleState } from '../../shared/phone.ts';
import { CoreError } from '../../shared/protocol.ts';
import { loginPath, which } from '../environment.ts';

/** The app's own CLI, when `tailscale` is not on the login PATH. */
const APP_CLI = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

export type RunTailscale = (bin: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

const runDefault: RunTailscale = (bin, args) => new Promise((resolve) => {
  execFile(bin, args, { timeout: 20_000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
    const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0;
    resolve({ code, stdout: String(stdout), stderr: String(stderr) });
  });
});

export class Tailscale {
  private readonly run: RunTailscale;
  private readonly findBin: () => Promise<string | null>;

  constructor(options: { run?: RunTailscale; bin?: string | null } = {}) {
    this.run = options.run ?? runDefault;
    this.findBin = options.bin !== undefined
      ? async () => options.bin ?? null
      : async () => which('tailscale', await loginPath()) ?? (existsSync(APP_CLI) ? APP_CLI : null);
  }

  /** Installed, running, allowing HTTPS, and whether Wanigan's mount is there for `port`. */
  async state(port: number): Promise<TailscaleState> {
    const bin = await this.findBin();
    if (!bin) return { state: 'missing' };
    const status = parse(await this.run(bin, ['status', '--json']));
    if (status?.BackendState !== 'Running') return { state: 'stopped' };
    const self = status.Self as { DNSName?: unknown } | undefined;
    const dnsName = typeof self?.DNSName === 'string' ? self.DNSName.replace(/\.$/, '') : '';
    if (!dnsName) return { state: 'stopped' };
    const certs = Array.isArray(status.CertDomains) && status.CertDomains.length > 0;
    if (!certs) return { state: 'no-https', dnsName };
    return { state: 'ready', dnsName, serving: await this.serving(bin, dnsName, port) };
  }

  /** Mount Wanigan at the owner's private address: `tailscale serve --bg --https=443 --set-path=/wanigan …`. */
  async serve(port: number): Promise<void> {
    const bin = await this.mustBin();
    const r = await this.run(bin, serveCommand(port));
    if (r.code !== 0) throw new CoreError('refused', `Tailscale did not serve Wanigan: ${lastLine(r.stderr || r.stdout) || `exit ${r.code}`}`);
  }

  /** Remove Wanigan's mount only. */
  async unserve(): Promise<void> {
    const bin = await this.findBin();
    if (!bin) return;
    await this.run(bin, ['serve', '--https=443', `--set-path=${PHONE_PATH}`, 'off']);
  }

  private async serving(bin: string, dnsName: string, port: number): Promise<boolean> {
    const config = parse(await this.run(bin, ['serve', 'status', '--json']));
    const web = (config?.Web ?? {}) as Record<string, { Handlers?: Record<string, { Proxy?: unknown }> }>;
    const handler = web[`${dnsName}:443`]?.Handlers?.[PHONE_PATH];
    return typeof handler?.Proxy === 'string' && handler.Proxy.replace(/\/$/, '') === `http://127.0.0.1:${port}`;
  }

  private async mustBin(): Promise<string> {
    const bin = await this.findBin();
    if (!bin) throw new CoreError('refused', 'Tailscale is not installed on this Mac. Install it from tailscale.com, sign in, then try again.');
    return bin;
  }
}

function parse(r: { code: number; stdout: string }): Record<string, unknown> | null {
  if (r.code !== 0) return null;
  try {
    const v = JSON.parse(r.stdout) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function lastLine(text: string): string {
  return text.trim().split('\n').at(-1)?.slice(0, 300) ?? '';
}
