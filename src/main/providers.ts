import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ProviderId, ProviderInfo } from '../shared/types';
import { getProviderKey } from './keys';

const exec = promisify(execFile);

type ProviderDef = {
  id: ProviderId;
  label: string;
  bin: string;
  /** Args to launch an interactive session in `cwd`. */
  args: (extra: string[], opts?: { model?: string; effort?: string; permissionMode?: string }) => string[];
  /** Which of the shared options this CLI actually accepts. */
  supports: { model: boolean; effort: boolean; permissionMode: boolean; resume: boolean };
  /**
   * Args to resume. Claude can be handed a conversation id we chose at launch;
   * Codex only offers "the last one", via a subcommand rather than a flag.
   */
  resumeArgs: (conversationId: string | null) => string[];
  versionArgs: string[];
  /**
   * Environment a provider needs beyond the shared agent env. This exists
   * because a provider is not always a different binary: GLM is the Claude
   * Code binary pointed at a different API, which is configuration rather
   * than a program. Returns {} when the provider is not configured, so a
   * session still launches and fails with the CLI's own message rather than
   * silently talking to the wrong endpoint.
   */
  env?: () => Record<string, string>;
  /**
   * Where to look when the CLI is not on PATH. Both Claude Code and Codex ship
   * inside their editor extensions under a versioned directory, so a plain PATH
   * lookup finds nothing even though the agent is installed and working.
   */
  fallbacks: () => string[];
};

const EDITOR_EXT_DIRS = [
  path.join(os.homedir(), '.vscode', 'extensions'),
  path.join(os.homedir(), '.vscode-insiders', 'extensions'),
  path.join(os.homedir(), '.cursor', 'extensions'),
  path.join(os.homedir(), '.windsurf', 'extensions'),
];

/**
 * Extension folders are named `publisher.name-<version>-<platform>`. Return the
 * matching ones newest-first so an upgrade is picked up without any config.
 */
function editorExtensions(prefix: string): string[] {
  const out: string[] = [];
  for (const base of EDITOR_EXT_DIRS) {
    let entries: string[];
    try { entries = fs.readdirSync(base); } catch { continue; }
    out.push(
      ...entries
        .filter((e) => e.startsWith(prefix))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
        .map((e) => path.join(base, e))
    );
  }
  return out;
}

/** First existing executable among the candidates, or null. */
function firstExecutable(candidates: string[]): string | null {
  for (const c of candidates) {
    try { fs.accessSync(c, fs.constants.X_OK); return c; } catch { /* next */ }
  }
  return null;
}

/**
 * Adding a provider is this object and nothing else — the session manager and
 * the UI both read from here.
 */
/*
 * Z.ai ships new GLM models faster than a hardcoded default survives — this
 * file said glm-4.6 while the coding plan had moved to 5.3. So these are only
 * the fallback for when the catalog cannot be fetched, and both are
 * overridable from the environment.
 */
export const GLM_DEFAULT = 'glm-5.3';
export const GLM_SMALL = 'glm-5.3-flash';

export const PROVIDERS: ProviderDef[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    bin: 'claude',
    args: (extra, o) => [
      ...(o?.model ? ['--model', o.model] : []),
      ...(o?.effort ? ['--effort', o.effort] : []),
      ...(o?.permissionMode ? ['--permission-mode', o.permissionMode] : []),
      ...extra,
    ],
    supports: { model: true, effort: true, permissionMode: true, resume: true },
    resumeArgs: (id) => (id ? ['--resume', id] : ['--continue']),
    versionArgs: ['--version'],
    fallbacks: () => [
      ...editorExtensions('anthropic.claude-code-')
        .map((d) => path.join(d, 'resources', 'native-binary', 'claude')),
      path.join(os.homedir(), '.claude', 'local', 'claude'),
    ],
  },
  {
    id: 'codex',
    label: 'Codex',
    bin: 'codex',
    // Codex takes a model but not Claude's effort or permission-mode flags;
    // passing them would make it exit immediately on an unknown option.
    args: (extra, o) => [...(o?.model ? ['--model', o.model] : []), ...extra],
    supports: { model: true, effort: false, permissionMode: false, resume: true },
    // `codex resume --last` is a subcommand, not a flag, and cannot target a
    // specific conversation the way Claude can.
    resumeArgs: () => ['resume', '--last'],
    versionArgs: ['--version'],
    fallbacks: () => editorExtensions('openai.chatgpt-').flatMap((d) => {
      const binDir = path.join(d, 'bin');
      try {
        return fs.readdirSync(binDir).map((arch) => path.join(binDir, arch, 'codex'));
      } catch { return []; }
    }),
  },
  {
    id: 'glm',
    label: 'GLM · Z.ai',
    // Deliberately the same binary. Z.ai serves an Anthropic-compatible API,
    // so GLM is Claude Code with its base URL and credentials redirected —
    // there is no glm binary to find, and inventing one would just fail to
    // resolve. Everything Wanigan builds on the CLI (telemetry, hooks, the
    // policy gate, transcripts) keeps working unchanged for exactly this
    // reason.
    bin: 'claude',
    args: (extra, o) => [
      ...(o?.model ? ['--model', o.model] : []),
      ...(o?.permissionMode ? ['--permission-mode', o.permissionMode] : []),
      ...extra,
    ],
    // No effort: it is an Anthropic API parameter, and the proxy does not
    // accept it. Passing it would make the CLI exit on an unknown option.
    supports: { model: true, effort: false, permissionMode: true, resume: true },
    resumeArgs: (id) => (id ? ['--resume', id] : ['--continue']),
    versionArgs: ['--version'],
    fallbacks: () => [
      ...editorExtensions('anthropic.claude-code-')
        .map((d) => path.join(d, 'resources', 'native-binary', 'claude')),
      path.join(os.homedir(), '.claude', 'local', 'claude'),
    ],
    env: (): Record<string, string> => {
      const key = getProviderKey('glm');
      if (!key) return {};
      return {
        ANTHROPIC_BASE_URL: process.env.WANIGAN_GLM_BASE_URL || 'https://api.z.ai/api/anthropic',
        ANTHROPIC_AUTH_TOKEN: key,
        // The CLI asks for a tier by name; the endpoint maps the tier to a
        // GLM model. Without these every request asks for a Claude model the
        // proxy has never heard of.
        ANTHROPIC_DEFAULT_OPUS_MODEL: process.env.WANIGAN_GLM_MODEL || GLM_DEFAULT,
        ANTHROPIC_DEFAULT_SONNET_MODEL: process.env.WANIGAN_GLM_MODEL || GLM_DEFAULT,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: process.env.WANIGAN_GLM_SMALL_MODEL || GLM_SMALL,
      };
    },
  },
];

export function providerById(id: ProviderId): ProviderDef | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/**
 * A GUI app inherits launchd's PATH, not the shell's, so `claude` installed via
 * nvm or homebrew is invisible unless we go looking. This resolves the CLI the
 * way a login shell would.
 */
let cachedShellPath: string | null = null;

export async function shellPath(): Promise<string> {
  if (cachedShellPath) return cachedShellPath;
  const shell = process.env.SHELL || '/bin/zsh';
  try {
    const { stdout } = await exec(shell, ['-lic', 'printf %s "$PATH"'], { timeout: 8000 });
    cachedShellPath = stdout.trim() || process.env.PATH || '';
  } catch {
    cachedShellPath = process.env.PATH || '';
  }
  // Always include the usual suspects, in case the login shell is unusual.
  const extras = [
    '/opt/homebrew/bin', '/usr/local/bin', `${os.homedir()}/.local/bin`,
    ...nvmBinDirs(),
  ];
  const parts = cachedShellPath.split(':').filter(Boolean);
  for (const e of extras) if (!parts.includes(e) && fs.existsSync(e)) parts.push(e);
  cachedShellPath = parts.join(':');
  return cachedShellPath;
}

function nvmBinDirs(): string[] {
  const base = path.join(os.homedir(), '.nvm', 'versions', 'node');
  try {
    return fs.readdirSync(base)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((v) => path.join(base, v, 'bin'))
      .filter((d) => fs.existsSync(d));
  } catch { return []; }
}

async function which(def: ProviderDef): Promise<string | null> {
  const p = await shellPath();
  const onPath = firstExecutable(p.split(':').filter(Boolean).map((d) => path.join(d, def.bin)));
  return onPath ?? firstExecutable(def.fallbacks());
}

export async function detectProviders(): Promise<ProviderInfo[]> {
  const p = await shellPath();
  return Promise.all(
    PROVIDERS.map(async (def): Promise<ProviderInfo> => {
      const resolved = await which(def);
      let version: string | null = null;
      if (resolved) {
        try {
          const { stdout } = await exec(resolved, def.versionArgs, {
            timeout: 10_000,
            env: { ...process.env, PATH: p },
          });
          version = stdout.trim().split('\n')[0] || null;
        } catch { version = null; }
      }
      return { id: def.id, label: def.label, bin: def.bin, path: resolved, version, supports: def.supports };
    })
  );
}
