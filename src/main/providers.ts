import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import type { ProviderCapabilities, ProviderId, ProviderInfo } from '../shared/types';
import { getProviderKey } from './keys';
import { probeProviderAdapter } from './provider-adapter';
import {
  createDefaultProviderPackRegistry,
  type ProviderCapabilityDeclaration,
  type ProviderLaunchFieldSchema,
  type ProviderPackSnapshot,
  type ProviderRuntimeDefinition,
} from './provider-packs';

const exec = promisify(execFile);

export type ProviderDef = {
  id: string;
  label: string;
  bin: string;
  /**
   * Which CLI a session actually runs. Not a duplicate of `bin`: `bin` is what
   * to execute, this is whose flags, config files and side-effects the session
   * will produce. Two providers share the claude binary, so every test written
   * as `id === 'claude'` silently excludes GLM — that is how GLM sessions came
   * to have telemetry but no archived transcript. Ask this, never the id.
   */
  cli: 'claude' | 'codex' | 'generic';
  /** Provider-neutral harness identity. Branch on this, never profile id/bin. */
  harness: 'claude-code' | 'codex' | 'generic-cli';
  /** Supported unattended invocation protocol, if any. */
  headless: 'claude-json' | 'codex-json' | 'none';
  /** Frozen manifest identity. Stored with sessions so upgrades cannot rewrite history. */
  packId: string;
  packVersion: string;
  backendId: string;
  /** Built-ins are Wanigan-reviewed; local profiles need adapter proof for harness capabilities. */
  source: 'builtin' | 'local';
  /** Exact frozen profile identity used to invalidate probes and revalidate launches. */
  profileFingerprint: string;
  launchFields: ProviderLaunchFieldSchema[];
  declaredCapabilities: ProviderCapabilityDeclaration;
  /** Args to launch an interactive session in `cwd`. */
  args: (extra: string[], opts?: { model?: string; effort?: string; permissionMode?: string }) => string[];
  /** Full manifest-driven launcher used once dynamic fields cross the IPC API. */
  launchArgs: (
    extra: string[],
    values?: Record<string, string | boolean | null | undefined>
  ) => string[];
  /** Which of the shared options this CLI actually accepts. */
  supports: { model: boolean; effort: boolean; permissionMode: boolean; resume: boolean };
  /**
   * Args to resume. Claude can be handed a conversation id we chose at launch;
   * Codex only offers "the last one", via a subcommand rather than a flag.
   */
  resumeArgs: (conversationId: string | null) => string[];
  versionArgs: string[];
  helpArgs: string[];
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
export const DEEPSEEK_DEFAULT = 'deepseek-v4-pro';
export const DEEPSEEK_SMALL = 'deepseek-v4-flash';

const LEGACY_BUILTINS: ProviderDef[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    bin: 'claude',
    cli: 'claude',
    harness: 'claude-code',
    headless: 'claude-json',
    packId: 'wanigan.claude',
    packVersion: '1',
    backendId: 'anthropic',
    source: 'builtin',
    profileFingerprint: 'legacy:claude',
    launchFields: [],
    declaredCapabilities: {},
    args: (extra, o) => [
      ...(o?.model ? ['--model', o.model] : []),
      ...(o?.effort ? ['--effort', o.effort] : []),
      ...(o?.permissionMode ? ['--permission-mode', o.permissionMode] : []),
      ...extra,
    ],
    launchArgs: (extra, o) => [
      ...(typeof o?.model === 'string' && o.model ? ['--model', o.model] : []),
      ...(typeof o?.effort === 'string' && o.effort ? ['--effort', o.effort] : []),
      ...(typeof o?.permissionMode === 'string' && o.permissionMode ? ['--permission-mode', o.permissionMode] : []),
      ...extra,
    ],
    supports: { model: true, effort: true, permissionMode: true, resume: true },
    resumeArgs: (id) => (id ? ['--resume', id] : ['--continue']),
    versionArgs: ['--version'],
    helpArgs: ['--help'],
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
    cli: 'codex',
    harness: 'codex',
    headless: 'codex-json',
    packId: 'wanigan.codex',
    packVersion: '1',
    backendId: 'openai',
    source: 'builtin',
    profileFingerprint: 'legacy:codex',
    launchFields: [],
    declaredCapabilities: {},
    // Codex takes a model but not Claude's effort or permission-mode flags;
    // passing them would make it exit immediately on an unknown option.
    args: (extra, o) => [
      ...(o?.model ? ['--model', o.model] : []),
      // Codex exposes reasoning effort as a typed config value, not Claude's
      // --effort flag. Each argv item is passed directly (never through a
      // shell), and quoting makes the value valid TOML for every CLI version.
      ...(o?.effort ? ['--config', `model_reasoning_effort="${o.effort}"`] : []),
      ...extra,
    ],
    launchArgs: (extra, o) => [
      ...(typeof o?.model === 'string' && o.model ? ['--model', o.model] : []),
      ...(typeof o?.effort === 'string' && o.effort
        ? ['--config', `model_reasoning_effort="${o.effort}"`]
        : []),
      ...extra,
    ],
    supports: { model: true, effort: true, permissionMode: false, resume: true },
    // Current Codex accepts an exact saved thread UUID. Falling back to the
    // picker is deliberate: `--last` can silently open a different thread —
    // or collide with its live writer — when the user chose an older row.
    resumeArgs: (id) => (id ? ['resume', id] : ['resume']),
    versionArgs: ['--version'],
    helpArgs: ['--help'],
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
    // resolve.
    //
    // What that buys is real but conditional: everything Wanigan builds on the
    // CLI (telemetry, hooks, the policy gate, the transcript on disk) works for
    // GLM only where the caller tests `cli` instead of `id`. It did not, and a
    // GLM session ran with telemetry and nothing else. runsClaudeCli() below is
    // that test; adding a fourth provider on this binary needs nothing more.
    //
    // Spend is the one thing that stays wrong on purpose. A session banks the
    // cost figure the CLI hands it, and neither otel.ts nor spend.ts knows a
    // Z.ai coding plan is a flat monthly fee, so a GLM session's dollars are
    // the CLI's arithmetic about a model it is not billing for — not a bill.
    bin: 'claude',
    cli: 'claude',
    harness: 'claude-code',
    headless: 'claude-json',
    packId: 'wanigan.glm',
    packVersion: '1',
    backendId: 'zai',
    source: 'builtin',
    profileFingerprint: 'legacy:glm',
    launchFields: [],
    declaredCapabilities: {},
    args: (extra, o) => [
      ...(o?.model ? ['--model', o.model] : []),
      ...(o?.permissionMode ? ['--permission-mode', o.permissionMode] : []),
      ...extra,
    ],
    launchArgs: (extra, o) => [
      ...(typeof o?.model === 'string' && o.model ? ['--model', o.model] : []),
      ...(typeof o?.permissionMode === 'string' && o.permissionMode ? ['--permission-mode', o.permissionMode] : []),
      ...extra,
    ],
    // No effort: it is an Anthropic API parameter, and the proxy does not
    // accept it. Passing it would make the CLI exit on an unknown option.
    supports: { model: true, effort: false, permissionMode: true, resume: true },
    resumeArgs: (id) => (id ? ['--resume', id] : ['--continue']),
    versionArgs: ['--version'],
    helpArgs: ['--help'],
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
  {
    id: 'deepseek',
    label: 'DeepSeek',
    // DeepSeek publishes an Anthropic-compatible endpoint, so it can use the
    // same reviewed Claude Code harness as GLM without a proxy or key shim.
    bin: 'claude', cli: 'claude', harness: 'claude-code', headless: 'claude-json',
    packId: 'wanigan.deepseek', packVersion: '1', backendId: 'deepseek', source: 'builtin',
    profileFingerprint: 'legacy:deepseek', launchFields: [], declaredCapabilities: {},
    args: (extra, o) => [
      ...(o?.model ? ['--model', o.model] : []),
      ...(o?.permissionMode ? ['--permission-mode', o.permissionMode] : []), ...extra,
    ],
    launchArgs: (extra, o) => [
      ...(typeof o?.model === 'string' && o.model ? ['--model', o.model] : []),
      ...(typeof o?.permissionMode === 'string' && o.permissionMode ? ['--permission-mode', o.permissionMode] : []), ...extra,
    ],
    supports: { model: true, effort: false, permissionMode: true, resume: true },
    resumeArgs: (id) => (id ? ['--resume', id] : ['--continue']),
    versionArgs: ['--version'], helpArgs: ['--help'],
    fallbacks: () => [
      ...editorExtensions('anthropic.claude-code-').map((d) => path.join(d, 'resources', 'native-binary', 'claude')),
      path.join(os.homedir(), '.claude', 'local', 'claude'),
    ],
    env: (): Record<string, string> => {
      const key = getProviderKey('deepseek');
      if (!key) return {};
      return {
        ANTHROPIC_BASE_URL: process.env.WANIGAN_DEEPSEEK_BASE_URL || 'https://api.deepseek.com/anthropic',
        ANTHROPIC_AUTH_TOKEN: key,
        ANTHROPIC_DEFAULT_OPUS_MODEL: process.env.WANIGAN_DEEPSEEK_MODEL || DEEPSEEK_DEFAULT,
        ANTHROPIC_DEFAULT_SONNET_MODEL: process.env.WANIGAN_DEEPSEEK_MODEL || DEEPSEEK_DEFAULT,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: process.env.WANIGAN_DEEPSEEK_SMALL_MODEL || DEEPSEEK_SMALL,
      };
    },
  },
];

export const providerPackRegistry = createDefaultProviderPackRegistry({ credentialResolver: getProviderKey });

/** Stable array identity for older callers; contents are refreshed in place. */
export const PROVIDERS: ProviderDef[] = [];

function fromRuntime(
  runtime: ProviderRuntimeDefinition,
  packVersion: string,
  backendId: string,
  source: 'builtin' | 'local',
  profileFingerprint: string,
): ProviderDef {
  return {
    id: runtime.id,
    label: runtime.label,
    bin: runtime.bin,
    cli: runtime.cli,
    harness: runtime.harness,
    headless: runtime.headless,
    packId: runtime.packId,
    packVersion,
    backendId,
    source,
    profileFingerprint,
    launchFields: runtime.launchFields,
    declaredCapabilities: runtime.capabilities,
    args: (extra, opts) => runtime.args(extra, opts),
    launchArgs: runtime.args,
    supports: runtime.supports,
    resumeArgs: runtime.resumeArgs,
    versionArgs: runtime.versionArgs,
    helpArgs: runtime.helpArgs,
    env: runtime.env,
    fallbacks: runtime.fallbacks,
  };
}

/**
 * Local manifests cannot claim the privacy identity of a built-in backend by
 * writing `backend.id: "anthropic"`. The stable pack id is the trust namespace;
 * profiles inside one pack may share a backend, but another pack cannot inherit
 * their semantic memory without a future explicit linking consent.
 */
export function effectiveProviderBackendId(
  profile: { source: 'builtin' | 'local'; packId: string; backend: { id: string } }
): string {
  return profile.source === 'local' ? `${profile.packId}:${profile.backend.id}` : profile.backend.id;
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function synchronizeProviderDefinitions(refreshPacks = false): ProviderPackSnapshot {
  const snapshot = refreshPacks ? providerPackRegistry.refresh() : providerPackRegistry.snapshot();
  const active = snapshot.profiles.filter((profile) => profile.enabled);
  const definitions = active.map((profile): ProviderDef => {
    const profileFingerprint = fingerprint(profile);
    const legacy = LEGACY_BUILTINS.find((candidate) => candidate.id === profile.id && profile.source === 'builtin');
    const runtime = providerPackRegistry.runtimeById(profile.id);
    if (!runtime) throw new Error(`Provider profile "${profile.id}" could not be compiled.`);
    if (!legacy) {
      return fromRuntime(
        runtime,
        profile.packVersion,
        effectiveProviderBackendId(profile),
        profile.source,
        profileFingerprint,
      );
    }
    // The hand-written launch functions are retained for the built-ins during
    // migration, while all routing metadata comes from the same manifests that
    // third-party packs use. This makes the change behavior-preserving today.
    return {
      ...legacy,
      packId: profile.packId,
      packVersion: profile.packVersion,
      backendId: effectiveProviderBackendId(profile),
      source: profile.source,
      profileFingerprint,
      harness: profile.harness,
      headless: profile.headless ?? 'none',
      launchFields: profile.launchFields ?? [],
      declaredCapabilities: profile.capabilities ?? {},
      launchArgs: runtime.args,
    };
  });
  PROVIDERS.splice(0, PROVIDERS.length, ...definitions);
  return snapshot;
}

synchronizeProviderDefinitions();

/** Re-scan Application Support after install/enable/disable/uninstall. */
export function refreshProviderPacks(): ProviderPackSnapshot {
  return synchronizeProviderDefinitions(true);
}

export function providerById(id: ProviderId | string): ProviderDef | undefined {
  synchronizeProviderDefinitions();
  return PROVIDERS.find((p) => p.id === id);
}

/**
 * True when this provider launches the Claude Code binary rather than a CLI of
 * its own. The question behind every caller is the same one: will this session
 * take --settings and --mcp-config, accept a --session-id we chose, and leave a
 * transcript in ~/.claude/projects. GLM answers yes to all four; Codex is a
 * different program that exits on an unknown flag and writes no such file.
 *
 * Takes an id as well as a definition because the callers on the database side
 * only ever have the provider_id string a session was logged with. An id this
 * build does not recognise is not Claude — a session logged by a future or
 * removed provider must not inherit Claude's transcript on a guess.
 */
export function runsClaudeCli(p: ProviderDef | string | null | undefined): boolean {
  if (!p) return false;
  const def = typeof p === 'string' ? providerById(p) : p;
  return def?.cli === 'claude';
}

const capabilityCache = new Map<string, ProviderCapabilities>();

/**
 * The flags a provider definition knows are not necessarily the flags in the
 * binary the user has installed.  Keep the launch contract conservative, but
 * report the actual capability boundary before a session starts.
 */
async function capabilitiesFor(def: ProviderDef, resolved: string | null, PATH: string): Promise<ProviderCapabilities> {
  const declared = (id: string, fallback: boolean): boolean => {
    const state = def.declaredCapabilities[id];
    // A manifest may narrow a built-in harness, but it cannot turn a claim
    // into observed support. Generic packs need an adapter probe before these
    // booleans may become true; until then the safe harness fallback wins.
    if (def.source === 'local') return false;
    if (state === 'supported') return fallback;
    if (state === 'unsupported' || state === 'unknown' || state === 'probe') return false;
    return fallback;
  };
  const isClaude = def.harness === 'claude-code';
  const base: ProviderCapabilities = {
    probed: false,
    hooks: declared('hooks', isClaude),
    telemetry: declared('telemetry', isClaude),
    mcp: declared('mcp', isClaude),
    policy: declared('policy', isClaude),
    transcript: declared('transcript', isClaude),
    namedResume: declared('resume.named', isClaude),
    headlessJson: declared('headless.json', def.headless !== 'none'),
    note: isClaude
      ? 'Wanigan injects hooks, MCP configuration, policy and telemetry into this CLI.'
      : def.harness === 'codex'
        ? 'Terminal and declared Codex capabilities are available; Claude-specific injection is not used.'
        : 'Generic terminal sessions work. Additional capabilities remain unavailable until this provider adapter proves them.',
  };
  if (!resolved) return { ...base, note: `${def.label} is not installed.` };
  const adapter = providerPackRegistry.trustedAdapterForProfile(def.id);
  const profile = providerPackRegistry.profileById(def.id);
  const key = [
    resolved, def.id, def.packId, def.packVersion, def.backendId, def.harness, def.headless,
    def.profileFingerprint, JSON.stringify(def.versionArgs), JSON.stringify(def.helpArgs),
    JSON.stringify(def.declaredCapabilities), adapter?.sha256 ?? '',
  ].join(':');
  const prior = capabilityCache.get(key);
  if (prior) return prior;
  let observed: ProviderCapabilities;
  try {
    const { stdout, stderr } = await exec(resolved, def.helpArgs, {
      timeout: 8_000, maxBuffer: 512 * 1024, env: providerProbeEnvironment(PATH),
    });
    const help = `${stdout}\n${stderr}`.toLowerCase();
    let resumeHelp = '';
    if (def.source === 'builtin' && def.harness === 'codex' && help.includes('resume')) {
      try {
        const result = await exec(resolved, ['resume', '--help'], {
          timeout: 8_000, maxBuffer: 512 * 1024, env: providerProbeEnvironment(PATH),
        });
        resumeHelp = `${result.stdout}\n${result.stderr}`.toLowerCase();
      } catch { /* the capability remains unproven */ }
    }
    const probed: ProviderCapabilities = {
      ...base,
      // Local harness capability comes only from its separately trusted
      // adapter below. Running an approved CLI's --help is discovery, not
      // proof that Wanigan's Claude/Codex integration contract is present.
      probed: def.source === 'builtin',
      namedResume: base.namedResume || (def.source === 'builtin' && (
        def.harness === 'claude-code'
          ? help.includes('resume')
          : def.harness === 'codex' && /session[_ -]id/.test(resumeHelp)
      )),
      headlessJson: base.headlessJson || (def.source === 'builtin' &&
        def.harness === 'codex' && help.includes('exec') && help.includes('--json')
      ),
      note: base.note,
    };
    observed = probed;
  } catch {
    observed = { ...base, note: `${base.note ?? ''} CLI help could not be inspected.`.trim() };
  }

  if (adapter && profile) {
    try {
      const proof = await probeProviderAdapter(adapter, profile);
      const declarationFor: Record<keyof typeof proof.capabilities, string> = {
        hooks: 'hooks', telemetry: 'telemetry', mcp: 'mcp', policy: 'policy',
        transcript: 'transcript', namedResume: 'resume.named', headlessJson: 'headless.json',
      };
      const accepted: Partial<ProviderCapabilities> = {};
      for (const [name, value] of Object.entries(proof.capabilities) as Array<[
        keyof typeof proof.capabilities, boolean
      ]>) {
        // Only an explicit `probe` declaration delegates this fact to code.
        // Unsupported/unknown remains fail-closed even if the adapter asserts it.
        if (def.declaredCapabilities[declarationFor[name]] === 'probe') accepted[name] = value;
      }
      observed = {
        ...observed,
        ...accepted,
        probed: true,
        note: [observed.note, proof.note ? `Adapter: ${proof.note}` : 'Trusted adapter probe passed.']
          .filter(Boolean).join(' '),
      };
    } catch (error) {
      observed = {
        ...observed,
        note: `${observed.note ?? ''} Trusted adapter probe failed closed: ${
          error instanceof Error ? error.message : String(error)
        }`.trim(),
      };
    }
  }
  capabilityCache.set(key, observed);
  return observed;
}

function providerProbeEnvironment(PATH: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH };
  for (const name of ['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'SHELL']) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
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
  const onPath = path.isAbsolute(def.bin)
    ? firstExecutable([def.bin])
    : firstExecutable(p.split(':').filter(Boolean).map((d) => path.join(d, def.bin)));
  return onPath ?? firstExecutable(def.fallbacks());
}

export async function detectProviders(): Promise<ProviderInfo[]> {
  refreshProviderPacks();
  const p = await shellPath();
  return Promise.all(
    PROVIDERS.map(async (def): Promise<ProviderInfo> => {
      const resolved = await which(def);
      let version: string | null = null;
      if (resolved) {
        try {
          const { stdout } = await exec(resolved, def.versionArgs, {
            timeout: 10_000,
            env: providerProbeEnvironment(p),
          });
          version = stdout.trim().split('\n')[0] || null;
        } catch { version = null; }
      }
      const capabilities = await capabilitiesFor(def, resolved, p);
      return {
        id: def.id,
        label: def.label,
        bin: def.bin,
        path: resolved,
        version,
        supports: def.supports,
        capabilities,
        packId: def.packId,
        packVersion: def.packVersion,
        profileFingerprint: def.profileFingerprint,
        harnessId: def.harness,
        backendId: def.backendId,
        launchFields: def.launchFields.map((field) => ({
          id: field.id,
          label: field.label,
          kind: field.kind,
          required: field.required,
          description: field.description,
          options: field.choices,
          defaultValue: field.defaultValue,
        })),
      };
    })
  );
}
