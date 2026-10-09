// Wanigan's hooks in a Codex session, trusted by hash for that launch only.
//
// Codex runs a hook only once it is trusted, and keeps that trust in the
// account's config.toml — which Wanigan never writes. What was verified against
// codex-cli 0.155.1, with a throwaway CODEX_HOME and no model call:
// - Hooks given as `--config hooks.<Event>=[…]` list in the app-server's
//   `hooks/list` as `source: sessionFlags`, keyed
//   `/<session-flags>/config.toml:<snake_event>:<group>:<handler>`, untrusted.
// - `--config hooks.state={"<key>"={enabled=true,trusted_hash="sha256:…"}}` in
//   the same invocation makes each one `trusted`. The hash covers the command,
//   matcher, timeout and event (not the folder or the CODEX_HOME), and is read
//   from `hooks/list`'s `currentHash`, never computed here.
// - A trusted hook's command runs through a shell with the TUI's environment
//   (WANIGAN_TOKEN and WANIGAN_HOOK_SOCKET included), so the relay Claude Code
//   uses works unchanged and no token goes into argv.
// - An unknown event name, or `[features] hooks = false`, gives a normal
//   session with no hooks and no error. Only `hooks/list` says what took.
// Asking costs two short app-server starts in a throwaway home, so the answer is
// kept per Codex version and hook definition. Anything short of every hook
// listed as trusted means Codex starts exactly as it did before, on OSC 9
// notifications alone, and the session's timeline says why.
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listCodexHooks, type ListedHook } from './codex-server.ts';
import { CODEX_EVENTS, codexHookArgs, relayCommand } from './hooks.ts';

export interface CodexHookProbe {
  /** What `codex --version` says, or null when it says nothing usable. */
  version(bin: string, path: string): Promise<string | null>;
  /** The hooks Codex lists with these `--config` flags, asked in a throwaway CODEX_HOME. */
  list(bin: string, path: string, args: readonly string[]): Promise<ListedHook[]>;
}

/** The flags to launch with, or why there are none. */
export type CodexHookLaunch = { args: string[]; why: null } | { args: null; why: string };

const VERSION_TIMEOUT_MS = 5_000;
const KEEP_ENV = ['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL'];

/** The installed CLI, asked without a login, a thread or a model call. */
export const installedCodexProbe: CodexHookProbe = {
  version: (bin, path) => new Promise((resolve) => {
    const env: Record<string, string> = { PATH: path };
    for (const k of KEEP_ENV) { const v = process.env[k]; if (v !== undefined) env[k] = v; }
    execFile(bin, ['--version'], { env, timeout: VERSION_TIMEOUT_MS }, (error, stdout) => {
      const line = String(stdout ?? '').trim().split('\n')[0]?.trim() ?? '';
      resolve(!error && /\d+\.\d+\.\d+/.test(line) ? line.slice(0, 80) : null);
    });
  }),
  async list(bin, path, args) {
    const home = mkdtempSync(join(tmpdir(), 'wanigan-codex-hooks-'));
    try {
      return await listCodexHooks(bin, home, path, args, home);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
};

/** `--config` flags that trust these hooks by their hashes, for this launch only. */
export function codexTrustArgs(hooks: readonly Pick<ListedHook, 'key' | 'currentHash'>[]): string[] {
  const entries = hooks.map((h) => `${JSON.stringify(h.key)}={enabled=true,trusted_hash=${JSON.stringify(h.currentHash)}}`);
  return ['--config', `hooks.state={${entries.join(',')}}`];
}

/** `SessionStart` → `sessionStart`, as `hooks/list` names events. */
const listedName = (event: string): string => `${event[0]?.toLowerCase() ?? ''}${event.slice(1)}`;

export class CodexHooks {
  private readonly relay: string;
  private readonly probe: CodexHookProbe;
  /** Answers by Codex version and hook definition. A probe that failed outright is asked again next time. */
  private readonly known = new Map<string, Promise<CodexHookLaunch & { retry?: boolean }>>();

  constructor(relay: string, probe: CodexHookProbe = installedCodexProbe) {
    this.relay = relay;
    this.probe = probe;
  }

  /** The hook and trust flags for launching this Codex, or why it launches without them. */
  async prepare(bin: string, path: string): Promise<CodexHookLaunch> {
    const version = await this.probe.version(bin, path).catch(() => null);
    if (!version) return { args: null, why: 'Wanigan could not read which version of Codex this is.' };
    const hooks = codexHookArgs(this.relay);
    const key = `${version}\n${hooks.join('\n')}`;
    let answer = this.known.get(key);
    if (!answer) {
      answer = this.learn(bin, path, version, hooks);
      this.known.set(key, answer);
    }
    const { retry, ...launch } = await answer;
    if (retry) this.known.delete(key);
    return launch;
  }

  private async learn(bin: string, path: string, version: string, hooks: string[]): Promise<CodexHookLaunch & { retry?: boolean }> {
    try {
      const listed = await this.probe.list(bin, path, hooks);
      const ours: ListedHook[] = [];
      for (const event of CODEX_EVENTS) {
        const command = relayCommand(this.relay, event);
        const hook = listed.find((h) => h.source === 'sessionFlags' && h.eventName === listedName(event) && h.command === command);
        if (!hook) return { args: null, why: `${version} did not list Wanigan’s ${event} hook, so its hooks may be off or named differently.` };
        ours.push(hook);
      }
      const trust = codexTrustArgs(ours);
      const again = await this.probe.list(bin, path, [...hooks, ...trust]);
      for (const hook of ours) {
        const status = again.find((h) => h.key === hook.key)?.trustStatus ?? 'missing';
        if (status !== 'trusted') return { args: null, why: `${version} listed Wanigan’s hooks as ${status}, not trusted.` };
      }
      return { args: [...hooks, ...trust], why: null };
    } catch (error) {
      return { args: null, why: `Codex could not be asked about its hooks (${(error as Error).message}).`, retry: true };
    }
  }
}
