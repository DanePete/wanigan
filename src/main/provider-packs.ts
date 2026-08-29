import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

/**
 * Provider packs are data first. A manifest can describe a normal CLI without
 * executing JavaScript in Electron. Packs that genuinely need code use the
 * optional v1 capability-probe adapter and stay unavailable until the exact
 * executable digest has been trusted by the user.
 */
export const PROVIDER_PACK_SCHEMA_VERSION = 1 as const;

const MANIFEST_FILE = 'provider-pack.json';
const STATE_FILE = '.provider-packs-state.json';
const TRASH_DIR = '.trash';
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_ADAPTER_BYTES = 128 * 1024 * 1024;
const MAX_PACKS = 200;
const ID_RE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const FIELD_ID_RE = /^[a-z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+)*$/;
/**
 * A data-only provider manifest may launch an installed, dedicated agent CLI,
 * but it may not turn a shell or general-purpose interpreter into unsigned
 * executable glue. Adapter protocol v1 is a bounded capability probe, not a
 * back door for choosing the session executable.
 */
const CODE_LAUNCHERS = new Set([
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh',
  'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe',
  'node', 'nodejs', 'deno', 'bun', 'python', 'python2', 'python3',
  'ruby', 'perl', 'php', 'osascript', 'env', 'xargs', 'npx', 'bunx', 'busybox',
]);

function isGeneralPurposeLauncher(bin: string): boolean {
  const normalized = bin.toLowerCase().replace(/\.exe$/, '');
  return CODE_LAUNCHERS.has(bin.toLowerCase()) || CODE_LAUNCHERS.has(normalized) ||
    /^(?:node|nodejs|python|ruby|perl|php)\d+(?:\.\d+)*$/.test(normalized);
}

const CODE_INJECTION_ENV = new Set([
  'NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'DYLD_FRAMEWORK_PATH',
  'PYTHONPATH', 'PYTHONHOME', 'PYTHONSTARTUP', 'PYTHONINSPECT',
  'RUBYOPT', 'RUBYLIB', 'PERL5OPT', 'PERL5LIB', 'BASH_ENV', 'ENV', 'ZDOTDIR',
  'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS', 'CLASSPATH',
  'PHPRC', 'PHP_INI_SCAN_DIR', 'LUA_PATH', 'LUA_CPATH',
  'DOTNET_STARTUP_HOOKS', 'DOTNET_ADDITIONAL_DEPS', 'DOTNET_SHARED_STORE',
  'GCONV_PATH', 'GTK_PATH', 'GIO_EXTRA_MODULES', 'GDK_PIXBUF_MODULE_FILE',
  'GI_TYPELIB_PATH', 'QT_PLUGIN_PATH', 'QT_QPA_PLATFORM_PLUGIN_PATH',
  'PROMPT_COMMAND',
]);

function forbiddenProviderEnvironment(name: string): boolean {
  const normalized = name.toUpperCase();
  return CODE_INJECTION_ENV.has(normalized) ||
    normalized.startsWith('LD_') || normalized.startsWith('DYLD_') ||
    normalized.startsWith('NIX_LD') || normalized.startsWith('CORECLR_') ||
    normalized.startsWith('COR_') ||
    normalized.startsWith('WANIGAN_') || normalized.startsWith('OTEL_') ||
    normalized.startsWith('ELECTRON_') || normalized.startsWith('CHROME_') ||
    normalized.startsWith('VSCODE_');
}

export type ProviderHarnessId = 'claude-code' | 'codex' | 'generic-cli';
export type ProviderCapabilityState = 'supported' | 'unsupported' | 'probe' | 'unknown';
export type ProviderCapabilityDeclaration = Record<string, ProviderCapabilityState>;

export type ProviderLaunchChoice = {
  value: string;
  label: string;
  description?: string;
};

export type ProviderLaunchFieldSchema = {
  id: string;
  label: string;
  description?: string;
  kind: 'text' | 'select' | 'boolean';
  required?: boolean;
  defaultValue?: string | boolean;
  placeholder?: string;
  choices?: ProviderLaunchChoice[];
  allowCustom?: boolean;
  /**
   * Each item is one argv entry. `{value}` is replaced without invoking a
   * shell, so a value can never turn into a second argument or command.
   */
  argv?: string[];
  trueArgv?: string[];
  falseArgv?: string[];
};

export type ProviderEnvironmentValue =
  | { source: 'literal'; value: string }
  | { source: 'process'; name: string; fallback?: string }
  | { source: 'credential'; id?: string };

export type ProviderCommandManifest = {
  bin: string;
  baseArgs?: string[];
  versionArgs?: string[];
  helpArgs?: string[];
  fallbackPaths?: string[];
  editorExtensions?: Array<{
    prefix: string;
    executablePaths: string[];
  }>;
};

export type ProviderResumeManifest = {
  conversationArgs: string[];
  continueArgs: string[];
};

export type ProviderBackendManifest = {
  id: string;
  label: string;
  description?: string;
  baseUrl?: string;
};

export type ProviderProfileManifest = {
  id: string;
  label: string;
  description?: string;
  harness: ProviderHarnessId;
  backend: ProviderBackendManifest;
  command: ProviderCommandManifest;
  launchFields?: ProviderLaunchFieldSchema[];
  resume?: ProviderResumeManifest;
  environment?: Record<string, ProviderEnvironmentValue>;
  capabilities?: ProviderCapabilityDeclaration;
  headless?: 'claude-json' | 'codex-json' | 'none';
};

export type ProviderProcessAdapterManifest = {
  kind: 'process';
  protocolVersion: 1;
  executable: string;
  args?: string[];
};

export type TrustedProviderProcessAdapter = {
  packId: string;
  profileId: string;
  executable: string;
  args: string[];
  sha256: string;
  cwd: string;
};

export type ProviderPackManifest = {
  schemaVersion: typeof PROVIDER_PACK_SCHEMA_VERSION;
  id: string;
  label: string;
  version: string;
  description?: string;
  publisher?: {
    id: string;
    name: string;
    url?: string;
  };
  adapter?: ProviderProcessAdapterManifest;
  profiles: ProviderProfileManifest[];
};

export type ProviderProfile = ProviderProfileManifest & {
  packId: string;
  packLabel: string;
  packVersion: string;
  source: 'builtin' | 'local';
  enabled: boolean;
  /** Absolute local pack directory. Never expose this as an executable grant. */
  packDir: string | null;
};

export type ProviderPackStatus =
  | 'enabled'
  | 'disabled'
  | 'needs-trust'
  | 'pending-removal'
  | 'invalid'
  | 'removed';

export type ProviderPackRecord = {
  id: string;
  label: string;
  version: string | null;
  source: 'builtin' | 'local';
  sourcePath: string | null;
  manifest: ProviderPackManifest | null;
  status: ProviderPackStatus;
  enabled: boolean;
  errors: string[];
  manifestSha256: string | null;
  trustedManifestSha256: string | null;
  adapterSha256: string | null;
  trustedAdapterSha256: string | null;
  pendingActiveProfileIds: string[];
  removedAt: number | null;
  recoverable: boolean;
};

export type ProviderPackSnapshot = {
  rootDir: string;
  packs: ProviderPackRecord[];
  profiles: ProviderProfile[];
  diagnostics: string[];
  refreshedAt: number;
};

export type ProviderRuntimeDefinition = {
  id: string;
  packId: string;
  label: string;
  bin: string;
  harness: ProviderHarnessId;
  /** Temporary compatibility seam for the current session launcher. */
  cli: 'claude' | 'codex' | 'generic';
  headless: 'claude-json' | 'codex-json' | 'none';
  launchFields: ProviderLaunchFieldSchema[];
  capabilities: ProviderCapabilityDeclaration;
  supports: { model: boolean; effort: boolean; permissionMode: boolean; resume: boolean };
  args: (
    extra: string[],
    values?: Record<string, string | boolean | null | undefined>
  ) => string[];
  resumeArgs: (conversationId: string | null) => string[];
  versionArgs: string[];
  helpArgs: string[];
  env: () => Record<string, string>;
  fallbacks: () => string[];
};

export type ProviderPackRegistryOptions = {
  /** Defaults to Wanigan's platform user-data directory. */
  rootDir?: string;
  builtins?: ProviderPackManifest[];
  credentialResolver?: (id: string) => string | null;
  environment?: NodeJS.ProcessEnv;
  homeDir?: string;
};

type PackState = {
  enabled?: boolean;
  pendingRemoval?: boolean;
  trustedManifestSha256?: string;
  trustedAdapterSha256?: string;
  pendingActiveProfileIds?: string[];
  removedAt?: number;
  trashPath?: string;
  sourceName?: string;
  lastLabel?: string;
  lastVersion?: string;
};

type RegistryState = {
  schemaVersion: 1;
  packs: Record<string, PackState>;
};

type ValidationResult =
  | { ok: true; manifest: ProviderPackManifest }
  | { ok: false; errors: string[] };

type LocatedManifest = {
  sourcePath: string;
  manifestPath: string;
  packDir: string;
  expectedId: string;
};

type CompileOptions = {
  credentialResolver?: (id: string) => string | null;
  environment?: NodeJS.ProcessEnv;
  homeDir?: string;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function own(value: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
}

function safeString(value: unknown, where: string, errors: string[], opts: {
  required?: boolean;
  max?: number;
  pattern?: RegExp;
} = {}): string | undefined {
  if (value === undefined && !opts.required) return undefined;
  if (typeof value !== 'string' || !value.trim()) {
    errors.push(`${where} must be a non-empty string.`);
    return undefined;
  }
  const out = value.trim();
  if (out.length > (opts.max ?? 500)) errors.push(`${where} is too long.`);
  if (out.includes('\0') || /[\r\n]/.test(out)) errors.push(`${where} cannot contain line breaks or NUL bytes.`);
  if (opts.pattern && !opts.pattern.test(out)) errors.push(`${where} has an invalid format.`);
  return out;
}

function safeArg(value: unknown, where: string, errors: string[]): string | undefined {
  if (typeof value !== 'string') {
    errors.push(`${where} must be a string.`);
    return undefined;
  }
  if (value.length > 4096) errors.push(`${where} is too long.`);
  if (value.includes('\0') || /[\r\n]/.test(value)) errors.push(`${where} cannot contain line breaks or NUL bytes.`);
  return value;
}

function stringArray(value: unknown, where: string, errors: string[], max = 100): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    errors.push(`${where} must be an array.`);
    return undefined;
  }
  if (value.length > max) errors.push(`${where} has too many entries.`);
  const out: string[] = [];
  value.slice(0, max).forEach((entry, i) => {
    const parsed = safeArg(entry, `${where}[${i}]`, errors);
    if (parsed !== undefined) out.push(parsed);
  });
  return out;
}

function optionalDescription(value: unknown, where: string, errors: string[]): string | undefined {
  if (value === undefined) return undefined;
  return safeString(value, where, errors, { max: 2_000 });
}

function validUrl(value: unknown, where: string, errors: string[]): string | undefined {
  if (value === undefined) return undefined;
  const text = safeString(value, where, errors, { max: 2_000 });
  if (!text) return undefined;
  try {
    const parsed = new URL(text);
    if (!['https:', 'http:'].includes(parsed.protocol)) errors.push(`${where} must use http or https.`);
  } catch {
    errors.push(`${where} must be a valid URL.`);
  }
  return text;
}

function parseLaunchChoice(raw: unknown, where: string, errors: string[]): ProviderLaunchChoice | null {
  if (!isObject(raw)) {
    errors.push(`${where} must be an object.`);
    return null;
  }
  const value = safeString(own(raw, 'value'), `${where}.value`, errors, { required: true, max: 200 });
  const label = safeString(own(raw, 'label'), `${where}.label`, errors, { required: true, max: 200 });
  const description = optionalDescription(own(raw, 'description'), `${where}.description`, errors);
  return value && label ? { value, label, ...(description ? { description } : {}) } : null;
}

function parseLaunchField(raw: unknown, where: string, errors: string[]): ProviderLaunchFieldSchema | null {
  if (!isObject(raw)) {
    errors.push(`${where} must be an object.`);
    return null;
  }
  const id = safeString(own(raw, 'id'), `${where}.id`, errors, { required: true, max: 64, pattern: FIELD_ID_RE });
  const label = safeString(own(raw, 'label'), `${where}.label`, errors, { required: true, max: 100 });
  const kindRaw = own(raw, 'kind');
  const kind = kindRaw === 'text' || kindRaw === 'select' || kindRaw === 'boolean' ? kindRaw : null;
  if (!kind) errors.push(`${where}.kind must be text, select, or boolean.`);
  const required = own(raw, 'required');
  const allowCustom = own(raw, 'allowCustom');
  if (required !== undefined && typeof required !== 'boolean') errors.push(`${where}.required must be boolean.`);
  if (allowCustom !== undefined && typeof allowCustom !== 'boolean') errors.push(`${where}.allowCustom must be boolean.`);
  const description = optionalDescription(own(raw, 'description'), `${where}.description`, errors);
  const placeholder = safeString(own(raw, 'placeholder'), `${where}.placeholder`, errors, { max: 200 });
  const argv = stringArray(own(raw, 'argv'), `${where}.argv`, errors, 20);
  const trueArgv = stringArray(own(raw, 'trueArgv'), `${where}.trueArgv`, errors, 20);
  const falseArgv = stringArray(own(raw, 'falseArgv'), `${where}.falseArgv`, errors, 20);
  const choicesRaw = own(raw, 'choices');
  let choices: ProviderLaunchChoice[] | undefined;
  if (choicesRaw !== undefined) {
    if (!Array.isArray(choicesRaw)) errors.push(`${where}.choices must be an array.`);
    else {
      choices = choicesRaw.slice(0, 100)
        .map((entry, i) => parseLaunchChoice(entry, `${where}.choices[${i}]`, errors))
        .filter((entry): entry is ProviderLaunchChoice => !!entry);
      const values = new Set<string>();
      for (const choice of choices) {
        if (values.has(choice.value)) errors.push(`${where}.choices contains duplicate value "${choice.value}".`);
        values.add(choice.value);
      }
    }
  }
  const defaultValue = own(raw, 'defaultValue');
  if (defaultValue !== undefined && typeof defaultValue !== 'string' && typeof defaultValue !== 'boolean') {
    errors.push(`${where}.defaultValue must be a string or boolean.`);
  }
  if (kind === 'boolean') {
    if (argv) errors.push(`${where}.argv is not valid for a boolean field; use trueArgv and falseArgv.`);
    if (defaultValue !== undefined && typeof defaultValue !== 'boolean') errors.push(`${where}.defaultValue must be boolean.`);
  } else if (kind) {
    if (trueArgv || falseArgv) errors.push(`${where}.trueArgv/falseArgv are only valid for boolean fields.`);
    if (defaultValue !== undefined && typeof defaultValue !== 'string') errors.push(`${where}.defaultValue must be a string.`);
  }
  if (kind === 'select' && (!choices || choices.length === 0)) {
    errors.push(`${where}.choices must contain at least one choice for a select field.`);
  }
  const templates = [...(argv ?? []), ...(trueArgv ?? []), ...(falseArgv ?? [])];
  if (kind !== 'boolean' && templates.length > 0 && !templates.some((entry) => entry.includes('{value}'))) {
    errors.push(`${where}.argv must include a {value} placeholder.`);
  }
  if (!id || !label || !kind) return null;
  return {
    id,
    label,
    kind,
    ...(description ? { description } : {}),
    ...(typeof required === 'boolean' ? { required } : {}),
    ...(defaultValue !== undefined && (typeof defaultValue === 'string' || typeof defaultValue === 'boolean')
      ? { defaultValue }
      : {}),
    ...(placeholder ? { placeholder } : {}),
    ...(choices ? { choices } : {}),
    ...(typeof allowCustom === 'boolean' ? { allowCustom } : {}),
    ...(argv ? { argv } : {}),
    ...(trueArgv ? { trueArgv } : {}),
    ...(falseArgv ? { falseArgv } : {}),
  };
}

function parseEnvironment(raw: unknown, where: string, errors: string[]): Record<string, ProviderEnvironmentValue> | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) {
    errors.push(`${where} must be an object.`);
    return undefined;
  }
  const out: Record<string, ProviderEnvironmentValue> = {};
  const entries = Object.entries(raw);
  if (entries.length > 100) errors.push(`${where} has too many entries.`);
  for (const [name, value] of entries.slice(0, 100)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      errors.push(`${where}.${name} is not a valid environment variable name.`);
      continue;
    }
    if (forbiddenProviderEnvironment(name)) {
      errors.push(
        `${where}.${name} may inject code or override Wanigan's process/privacy controls and is refused.`
      );
      continue;
    }
    if (!isObject(value)) {
      errors.push(`${where}.${name} must be an object.`);
      continue;
    }
    const source = own(value, 'source');
    if (source === 'literal') {
      const literal = safeArg(own(value, 'value'), `${where}.${name}.value`, errors);
      if (literal !== undefined) out[name] = { source, value: literal };
    } else if (source === 'process') {
      const envName = safeString(own(value, 'name'), `${where}.${name}.name`, errors, { required: true, max: 200 });
      if (envName && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) errors.push(`${where}.${name}.name is invalid.`);
      const fallback = own(value, 'fallback');
      const safeFallback = fallback === undefined
        ? undefined
        : safeArg(fallback, `${where}.${name}.fallback`, errors);
      if (envName) out[name] = { source, name: envName, ...(safeFallback !== undefined ? { fallback: safeFallback } : {}) };
    } else if (source === 'credential') {
      const credentialId = safeString(own(value, 'id'), `${where}.${name}.id`, errors, { max: 100, pattern: ID_RE });
      out[name] = { source, ...(credentialId ? { id: credentialId } : {}) };
    } else {
      errors.push(`${where}.${name}.source must be literal, process, or credential.`);
    }
  }
  return out;
}

function parseCommand(raw: unknown, where: string, errors: string[]): ProviderCommandManifest | null {
  if (!isObject(raw)) {
    errors.push(`${where} must be an object.`);
    return null;
  }
  const bin = safeString(own(raw, 'bin'), `${where}.bin`, errors, { required: true, max: 1_000 });
  if (bin && (path.isAbsolute(bin) || bin.includes('/') || bin.includes('\\'))) {
    errors.push(`${where}.bin must be an installed command name, not a path.`);
  }
  if (bin && isGeneralPurposeLauncher(bin)) {
    errors.push(`${where}.bin cannot be a shell or general-purpose interpreter. Install a dedicated provider CLI command instead.`);
  }
  const baseArgs = stringArray(own(raw, 'baseArgs'), `${where}.baseArgs`, errors);
  const versionArgs = stringArray(own(raw, 'versionArgs'), `${where}.versionArgs`, errors, 20);
  const helpArgs = stringArray(own(raw, 'helpArgs'), `${where}.helpArgs`, errors, 20);
  const fallbackPaths = stringArray(own(raw, 'fallbackPaths'), `${where}.fallbackPaths`, errors, 100);
  const extensionsRaw = own(raw, 'editorExtensions');
  let editorExtensions: NonNullable<ProviderCommandManifest['editorExtensions']> | undefined;
  if (extensionsRaw !== undefined) {
    if (!Array.isArray(extensionsRaw)) errors.push(`${where}.editorExtensions must be an array.`);
    else {
      editorExtensions = [];
      extensionsRaw.slice(0, 20).forEach((entry, i) => {
        const at = `${where}.editorExtensions[${i}]`;
        if (!isObject(entry)) {
          errors.push(`${at} must be an object.`);
          return;
        }
        const prefix = safeString(own(entry, 'prefix'), `${at}.prefix`, errors, { required: true, max: 200 });
        const executablePaths = stringArray(own(entry, 'executablePaths'), `${at}.executablePaths`, errors, 20);
        if (prefix && executablePaths?.length) editorExtensions!.push({ prefix, executablePaths });
      });
    }
  }
  if (!bin) return null;
  return {
    bin,
    ...(baseArgs ? { baseArgs } : {}),
    ...(versionArgs ? { versionArgs } : {}),
    ...(helpArgs ? { helpArgs } : {}),
    ...(fallbackPaths ? { fallbackPaths } : {}),
    ...(editorExtensions ? { editorExtensions } : {}),
  };
}

function parseResume(raw: unknown, where: string, errors: string[]): ProviderResumeManifest | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) {
    errors.push(`${where} must be an object.`);
    return undefined;
  }
  const conversationArgs = stringArray(own(raw, 'conversationArgs'), `${where}.conversationArgs`, errors, 20);
  const continueArgs = stringArray(own(raw, 'continueArgs'), `${where}.continueArgs`, errors, 20);
  if (!conversationArgs || !continueArgs) return undefined;
  return { conversationArgs, continueArgs };
}

function parseCapabilities(raw: unknown, where: string, errors: string[]): ProviderCapabilityDeclaration | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) {
    errors.push(`${where} must be an object.`);
    return undefined;
  }
  const out: ProviderCapabilityDeclaration = {};
  const entries = Object.entries(raw);
  if (entries.length > 200) errors.push(`${where} has too many entries.`);
  for (const [id, value] of entries.slice(0, 200)) {
    if (!FIELD_ID_RE.test(id)) {
      errors.push(`${where}.${id} has an invalid capability id.`);
      continue;
    }
    if (value !== 'supported' && value !== 'unsupported' && value !== 'probe' && value !== 'unknown') {
      errors.push(`${where}.${id} must be supported, unsupported, probe, or unknown.`);
      continue;
    }
    out[id] = value;
  }
  return out;
}

function parseProfile(raw: unknown, where: string, errors: string[]): ProviderProfileManifest | null {
  if (!isObject(raw)) {
    errors.push(`${where} must be an object.`);
    return null;
  }
  const id = safeString(own(raw, 'id'), `${where}.id`, errors, { required: true, max: 100, pattern: ID_RE });
  const label = safeString(own(raw, 'label'), `${where}.label`, errors, { required: true, max: 100 });
  const description = optionalDescription(own(raw, 'description'), `${where}.description`, errors);
  const harnessRaw = own(raw, 'harness');
  const harness = harnessRaw === 'claude-code' || harnessRaw === 'codex' || harnessRaw === 'generic-cli'
    ? harnessRaw
    : null;
  if (!harness) errors.push(`${where}.harness must be claude-code, codex, or generic-cli.`);
  const backendRaw = own(raw, 'backend');
  let backend: ProviderBackendManifest | null = null;
  if (!isObject(backendRaw)) errors.push(`${where}.backend must be an object.`);
  else {
    const backendId = safeString(own(backendRaw, 'id'), `${where}.backend.id`, errors, { required: true, max: 100, pattern: ID_RE });
    const backendLabel = safeString(own(backendRaw, 'label'), `${where}.backend.label`, errors, { required: true, max: 100 });
    const backendDescription = optionalDescription(own(backendRaw, 'description'), `${where}.backend.description`, errors);
    const baseUrl = validUrl(own(backendRaw, 'baseUrl'), `${where}.backend.baseUrl`, errors);
    if (backendId && backendLabel) backend = {
      id: backendId,
      label: backendLabel,
      ...(backendDescription ? { description: backendDescription } : {}),
      ...(baseUrl ? { baseUrl } : {}),
    };
  }
  const command = parseCommand(own(raw, 'command'), `${where}.command`, errors);
  const fieldsRaw = own(raw, 'launchFields');
  let launchFields: ProviderLaunchFieldSchema[] | undefined;
  if (fieldsRaw !== undefined) {
    if (!Array.isArray(fieldsRaw)) errors.push(`${where}.launchFields must be an array.`);
    else {
      launchFields = fieldsRaw.slice(0, 100)
        .map((field, i) => parseLaunchField(field, `${where}.launchFields[${i}]`, errors))
        .filter((field): field is ProviderLaunchFieldSchema => !!field);
      const ids = new Set<string>();
      for (const field of launchFields) {
        if (ids.has(field.id)) errors.push(`${where}.launchFields contains duplicate id "${field.id}".`);
        ids.add(field.id);
      }
    }
  }
  const resume = parseResume(own(raw, 'resume'), `${where}.resume`, errors);
  const environment = parseEnvironment(own(raw, 'environment'), `${where}.environment`, errors);
  const capabilities = parseCapabilities(own(raw, 'capabilities'), `${where}.capabilities`, errors);
  const headlessRaw = own(raw, 'headless');
  let headless: ProviderProfileManifest['headless'];
  if (headlessRaw !== undefined) {
    if (headlessRaw === 'claude-json' || headlessRaw === 'codex-json' || headlessRaw === 'none') headless = headlessRaw;
    else errors.push(`${where}.headless must be claude-json, codex-json, or none.`);
  }
  if (harness === 'generic-cli' && headless && headless !== 'none') {
    errors.push(`${where}.headless must be none for a generic-cli profile.`);
  }
  if (harness === 'claude-code' && headless === 'codex-json') {
    errors.push(`${where}.headless cannot use the Codex protocol with the Claude Code harness.`);
  }
  if (harness === 'codex' && headless === 'claude-json') {
    errors.push(`${where}.headless cannot use the Claude protocol with the Codex harness.`);
  }
  if (!id || !label || !harness || !backend || !command) return null;
  return {
    id,
    label,
    harness,
    backend,
    command,
    ...(description ? { description } : {}),
    ...(launchFields ? { launchFields } : {}),
    ...(resume ? { resume } : {}),
    ...(environment ? { environment } : {}),
    ...(capabilities ? { capabilities } : {}),
    ...(headless ? { headless } : {}),
  };
}

/** Validate and clone an untrusted JSON value into the supported manifest shape. */
export function validateProviderPackManifest(raw: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isObject(raw)) return { ok: false, errors: ['Manifest must be a JSON object.'] };
  if (own(raw, 'schemaVersion') !== PROVIDER_PACK_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${PROVIDER_PACK_SCHEMA_VERSION}.`);
  }
  const id = safeString(own(raw, 'id'), 'id', errors, { required: true, max: 100, pattern: ID_RE });
  const label = safeString(own(raw, 'label'), 'label', errors, { required: true, max: 100 });
  const version = safeString(own(raw, 'version'), 'version', errors, { required: true, max: 100 });
  const description = optionalDescription(own(raw, 'description'), 'description', errors);
  let publisher: ProviderPackManifest['publisher'];
  const publisherRaw = own(raw, 'publisher');
  if (publisherRaw !== undefined) {
    if (!isObject(publisherRaw)) errors.push('publisher must be an object.');
    else {
      const publisherId = safeString(own(publisherRaw, 'id'), 'publisher.id', errors, { required: true, max: 100, pattern: ID_RE });
      const publisherName = safeString(own(publisherRaw, 'name'), 'publisher.name', errors, { required: true, max: 100 });
      const url = validUrl(own(publisherRaw, 'url'), 'publisher.url', errors);
      if (publisherId && publisherName) publisher = { id: publisherId, name: publisherName, ...(url ? { url } : {}) };
    }
  }
  let adapter: ProviderProcessAdapterManifest | undefined;
  const adapterRaw = own(raw, 'adapter');
  if (adapterRaw !== undefined) {
    if (!isObject(adapterRaw)) errors.push('adapter must be an object.');
    else {
      if (own(adapterRaw, 'kind') !== 'process') errors.push('adapter.kind must be process.');
      if (own(adapterRaw, 'protocolVersion') !== 1) errors.push('adapter.protocolVersion must be 1.');
      const executable = safeString(own(adapterRaw, 'executable'), 'adapter.executable', errors, { required: true, max: 1_000 });
      const args = stringArray(own(adapterRaw, 'args'), 'adapter.args', errors, 100);
      if (executable) adapter = { kind: 'process', protocolVersion: 1, executable, ...(args ? { args } : {}) };
    }
  }
  const profilesRaw = own(raw, 'profiles');
  const profiles: ProviderProfileManifest[] = [];
  if (!Array.isArray(profilesRaw) || profilesRaw.length === 0) errors.push('profiles must contain at least one profile.');
  else {
    if (profilesRaw.length > 100) errors.push('profiles has too many entries.');
    profilesRaw.slice(0, 100).forEach((profile, i) => {
      const parsed = parseProfile(profile, `profiles[${i}]`, errors);
      if (parsed) profiles.push(parsed);
    });
    const ids = new Set<string>();
    for (const profile of profiles) {
      if (ids.has(profile.id)) errors.push(`profiles contains duplicate id "${profile.id}".`);
      ids.add(profile.id);
    }
  }
  if (errors.length || !id || !label || !version || !profiles.length) return { ok: false, errors };
  return {
    ok: true,
    manifest: {
      schemaVersion: PROVIDER_PACK_SCHEMA_VERSION,
      id,
      label,
      version,
      profiles,
      ...(description ? { description } : {}),
      ...(publisher ? { publisher } : {}),
      ...(adapter ? { adapter } : {}),
    },
  };
}

const CLAUDE_CAPABILITIES: ProviderCapabilityDeclaration = {
  hooks: 'supported', telemetry: 'supported', mcp: 'supported', policy: 'supported',
  transcript: 'supported', 'resume.named': 'supported', 'headless.json': 'supported',
  skills: 'supported', 'instructions.project': 'supported', 'memory.native': 'supported',
};

const CODEX_CAPABILITIES: ProviderCapabilityDeclaration = {
  hooks: 'probe', telemetry: 'probe', mcp: 'probe', policy: 'probe', transcript: 'probe',
  'resume.named': 'probe', 'headless.json': 'supported', skills: 'supported',
  'instructions.project': 'supported', 'memory.native': 'supported',
};

const CLAUDE_COMMAND: ProviderCommandManifest = {
  bin: 'claude',
  versionArgs: ['--version'],
  helpArgs: ['--help'],
  fallbackPaths: ['{home}/.claude/local/claude'],
  editorExtensions: [{
    prefix: 'anthropic.claude-code-',
    executablePaths: ['resources/native-binary/claude'],
  }],
};

const CLAUDE_FIELDS: ProviderLaunchFieldSchema[] = [
  { id: 'model', label: 'Model', kind: 'text', placeholder: 'CLI default', argv: ['--model', '{value}'] },
  {
    id: 'effort', label: 'Effort', kind: 'select', allowCustom: false, argv: ['--effort', '{value}'],
    choices: ['low', 'medium', 'high', 'xhigh', 'max'].map((value) => ({ value, label: value })),
  },
  {
    id: 'permissionMode', label: 'Permission mode', kind: 'select', allowCustom: false,
    argv: ['--permission-mode', '{value}'],
    choices: ['manual', 'acceptEdits', 'auto', 'plan', 'dontAsk', 'bypassPermissions']
      .map((value) => ({ value, label: value })),
  },
];

export const BUILTIN_PROVIDER_PACKS: ProviderPackManifest[] = [
  {
    schemaVersion: 1,
    id: 'wanigan.claude',
    label: 'Claude Code',
    version: '1',
    description: 'Claude Code using Anthropic authentication and models.',
    publisher: { id: 'wanigan', name: 'Wanigan' },
    profiles: [{
      id: 'claude',
      label: 'Claude Code',
      harness: 'claude-code',
      backend: { id: 'anthropic', label: 'Anthropic' },
      command: CLAUDE_COMMAND,
      launchFields: CLAUDE_FIELDS,
      resume: { conversationArgs: ['--resume', '{conversationId}'], continueArgs: ['--continue'] },
      capabilities: CLAUDE_CAPABILITIES,
      headless: 'claude-json',
    }],
  },
  {
    schemaVersion: 1,
    id: 'wanigan.codex',
    label: 'Codex',
    version: '1',
    description: 'OpenAI Codex CLI.',
    publisher: { id: 'wanigan', name: 'Wanigan' },
    profiles: [{
      id: 'codex',
      label: 'Codex',
      harness: 'codex',
      backend: { id: 'openai', label: 'OpenAI' },
      command: {
        bin: 'codex',
        versionArgs: ['--version'],
        helpArgs: ['--help'],
        editorExtensions: [{
          prefix: 'openai.chatgpt-',
          executablePaths: [
            'bin/{arch}/codex',
            'bin/macos-aarch64/codex',
            'bin/macos-x86_64/codex',
            'bin/linux-x86_64/codex',
            'bin/linux-aarch64/codex',
          ],
        }],
      },
      launchFields: [
        { id: 'model', label: 'Model', kind: 'text', placeholder: 'CLI default', argv: ['--model', '{value}'] },
        {
          id: 'effort', label: 'Reasoning effort', kind: 'select', allowCustom: false,
          argv: ['--config', 'model_reasoning_effort="{value}"'],
          choices: ['low', 'medium', 'high', 'xhigh', 'max'].map((value) => ({ value, label: value })),
        },
      ],
      resume: { conversationArgs: ['resume', '{conversationId}'], continueArgs: ['resume'] },
      capabilities: CODEX_CAPABILITIES,
      headless: 'codex-json',
    }],
  },
  {
    schemaVersion: 1,
    id: 'wanigan.glm',
    label: 'GLM · Z.ai',
    version: '1',
    description: 'Claude Code harness connected to Z.ai\'s Anthropic-compatible API.',
    publisher: { id: 'wanigan', name: 'Wanigan' },
    profiles: [{
      id: 'glm',
      label: 'GLM · Z.ai',
      harness: 'claude-code',
      backend: { id: 'zai', label: 'Z.ai', baseUrl: 'https://api.z.ai/api/anthropic' },
      command: CLAUDE_COMMAND,
      launchFields: CLAUDE_FIELDS.filter((field) => field.id !== 'effort'),
      resume: { conversationArgs: ['--resume', '{conversationId}'], continueArgs: ['--continue'] },
      environment: {
        ANTHROPIC_BASE_URL: {
          source: 'process', name: 'WANIGAN_GLM_BASE_URL', fallback: 'https://api.z.ai/api/anthropic',
        },
        ANTHROPIC_AUTH_TOKEN: { source: 'credential', id: 'glm' },
        ANTHROPIC_DEFAULT_OPUS_MODEL: { source: 'process', name: 'WANIGAN_GLM_MODEL', fallback: 'glm-5.3' },
        ANTHROPIC_DEFAULT_SONNET_MODEL: { source: 'process', name: 'WANIGAN_GLM_MODEL', fallback: 'glm-5.3' },
        ANTHROPIC_DEFAULT_HAIKU_MODEL: { source: 'process', name: 'WANIGAN_GLM_SMALL_MODEL', fallback: 'glm-5.3-flash' },
      },
      capabilities: CLAUDE_CAPABILITIES,
      headless: 'claude-json',
    }],
  },
  {
    schemaVersion: 1,
    id: 'wanigan.deepseek',
    label: 'DeepSeek',
    version: '1',
    description: 'Claude Code harness connected to DeepSeek’s Anthropic-compatible API.',
    publisher: { id: 'wanigan', name: 'Wanigan' },
    profiles: [{
      id: 'deepseek', label: 'DeepSeek', harness: 'claude-code',
      backend: { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/anthropic' },
      command: CLAUDE_COMMAND,
      launchFields: CLAUDE_FIELDS.filter((field) => field.id !== 'effort'),
      resume: { conversationArgs: ['--resume', '{conversationId}'], continueArgs: ['--continue'] },
      environment: {
        ANTHROPIC_BASE_URL: { source: 'process', name: 'WANIGAN_DEEPSEEK_BASE_URL', fallback: 'https://api.deepseek.com/anthropic' },
        ANTHROPIC_AUTH_TOKEN: { source: 'credential', id: 'deepseek' },
        ANTHROPIC_DEFAULT_OPUS_MODEL: { source: 'process', name: 'WANIGAN_DEEPSEEK_MODEL', fallback: 'deepseek-v4-pro' },
        ANTHROPIC_DEFAULT_SONNET_MODEL: { source: 'process', name: 'WANIGAN_DEEPSEEK_MODEL', fallback: 'deepseek-v4-pro' },
        ANTHROPIC_DEFAULT_HAIKU_MODEL: { source: 'process', name: 'WANIGAN_DEEPSEEK_SMALL_MODEL', fallback: 'deepseek-v4-flash' },
      },
      capabilities: CLAUDE_CAPABILITIES,
      headless: 'claude-json',
    }],
  },
];

export function defaultProviderPacksRoot(userDataDir?: string): string {
  if (userDataDir) return path.join(path.resolve(userDataDir), 'provider-packs');
  if (process.env.WANIGAN_PROVIDER_PACKS_DIR) return path.resolve(process.env.WANIGAN_PROVIDER_PACKS_DIR);
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'wanigan', 'provider-packs');
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'wanigan', 'provider-packs');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'wanigan', 'provider-packs');
}

function substitute(template: string, variables: Record<string, string>): string {
  return template.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (full, key: string) => variables[key] ?? full);
}

function editorExtensionRoots(homeDir: string): string[] {
  return [
    path.join(homeDir, '.vscode', 'extensions'),
    path.join(homeDir, '.vscode-insiders', 'extensions'),
    path.join(homeDir, '.cursor', 'extensions'),
    path.join(homeDir, '.windsurf', 'extensions'),
  ];
}

function expandFallbacks(profile: ProviderProfile, homeDir: string): string[] {
  const variables = {
    home: homeDir,
    packDir: profile.packDir ?? '',
    arch: process.arch,
    platform: process.platform,
  };
  const out: string[] = [];
  for (const extension of profile.command.editorExtensions ?? []) {
    for (const root of editorExtensionRoots(homeDir)) {
      let entries: string[];
      try { entries = fs.readdirSync(root); } catch { continue; }
      for (const directory of entries
        .filter((entry) => entry.startsWith(extension.prefix))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) {
        const extensionDir = path.join(root, directory);
        for (const executable of extension.executablePaths) {
          const candidate = path.resolve(extensionDir, substitute(executable, variables));
          // `executablePaths` is relative to the selected extension. An entry
          // cannot climb out and borrow an unrelated executable.
          if (within(extensionDir, candidate)) out.push(candidate);
        }
      }
    }
  }
  for (const entry of profile.command.fallbackPaths ?? []) {
    const expanded = substitute(entry, variables);
    if (profile.source === 'local') {
      // Local fallback executables are refused during discovery; retain the
      // fail-closed behavior if a caller compiles an ad-hoc profile directly.
      continue;
    } else {
      out.push(expanded);
    }
  }
  return [...new Set(out.filter(Boolean))];
}

function fieldArgs(field: ProviderLaunchFieldSchema, value: string | boolean | null | undefined): string[] {
  if (value === undefined || value === null || value === '') {
    if (field.required) throw new Error(`${field.label} is required.`);
    return [];
  }
  if (field.kind === 'boolean') {
    if (typeof value !== 'boolean') throw new Error(`${field.label} must be true or false.`);
    return [...(value ? field.trueArgv ?? [] : field.falseArgv ?? [])];
  }
  if (typeof value !== 'string') throw new Error(`${field.label} must be text.`);
  if (field.kind === 'select' && field.allowCustom !== true) {
    const allowed = new Set((field.choices ?? []).map((choice) => choice.value));
    if (!allowed.has(value)) throw new Error(`${field.label} has an unsupported value.`);
  }
  return (field.argv ?? []).map((entry) => entry.replaceAll('{value}', value));
}

/** Compile a serializable profile into main-process-only spawn behavior. */
export function compileProviderProfile(
  profile: ProviderProfile,
  options: CompileOptions = {}
): ProviderRuntimeDefinition {
  const environment = options.environment ?? process.env;
  const credentialResolver = options.credentialResolver ?? (() => null);
  const homeDir = options.homeDir ?? os.homedir();
  const fields = profile.launchFields ?? [];
  const capabilities = profile.capabilities ?? {};
  return {
    id: profile.id,
    packId: profile.packId,
    label: profile.label,
    bin: profile.command.bin,
    harness: profile.harness,
    cli: profile.harness === 'claude-code' ? 'claude' : profile.harness === 'codex' ? 'codex' : 'generic',
    headless: profile.headless ?? 'none',
    launchFields: fields,
    capabilities,
    supports: {
      model: fields.some((field) => field.id === 'model'),
      effort: fields.some((field) => field.id === 'effort'),
      permissionMode: fields.some((field) => field.id === 'permissionMode'),
      resume: !!profile.resume,
    },
    args: (extra, values = {}) => [
      ...(profile.command.baseArgs ?? []),
      ...fields.flatMap((field) => fieldArgs(field, values[field.id])),
      ...extra,
    ],
    resumeArgs: (conversationId) => {
      if (!profile.resume) return [];
      const template = conversationId ? profile.resume.conversationArgs : profile.resume.continueArgs;
      return template.map((entry) => entry.replaceAll('{conversationId}', conversationId ?? ''));
    },
    versionArgs: [...(profile.command.versionArgs ?? ['--version'])],
    helpArgs: [...(profile.command.helpArgs ?? ['--help'])],
    env: () => {
      const out: Record<string, string> = {};
      let missingCredential = false;
      for (const [name, spec] of Object.entries(profile.environment ?? {})) {
        let value: string | null | undefined;
        if (spec.source === 'literal') value = spec.value;
        else if (spec.source === 'process') value = environment[spec.name] ?? spec.fallback;
        else {
          value = credentialResolver(spec.id ?? profile.id);
          if (!value) missingCredential = true;
        }
        if (value !== undefined && value !== null && value !== '') out[name] = value;
      }
      // A backend redirection and its credential are one atomic configuration.
      // Returning only the base URL or model aliases can make a shared harness
      // authenticate to an unintended account using ambient credentials.
      return missingCredential ? {} : out;
    },
    fallbacks: () => expandFallbacks(profile, homeDir),
  };
}

function within(parent: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function manifestLocations(rootDir: string): { locations: LocatedManifest[]; diagnostics: string[] } {
  const locations: LocatedManifest[] = [];
  const diagnostics: string[] = [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(rootDir, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      diagnostics.push(`Could not read provider pack directory: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { locations, diagnostics };
  }
  for (const entry of entries.slice(0, MAX_PACKS)) {
    if (entry.name.startsWith('.')) continue;
    const sourcePath = path.join(rootDir, entry.name);
    if (entry.isSymbolicLink()) {
      diagnostics.push(`${entry.name}: symbolic-link provider packs are refused.`);
      continue;
    }
    if (entry.isDirectory()) {
      locations.push({
        sourcePath,
        manifestPath: path.join(sourcePath, MANIFEST_FILE),
        packDir: sourcePath,
        expectedId: entry.name,
      });
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      locations.push({
        sourcePath,
        manifestPath: sourcePath,
        packDir: rootDir,
        expectedId: entry.name.slice(0, -'.json'.length),
      });
    }
  }
  if (entries.length > MAX_PACKS) diagnostics.push(`Only the first ${MAX_PACKS} provider pack entries were inspected.`);
  return { locations, diagnostics };
}

function readManifest(location: LocatedManifest): { result: ValidationResult; sha256: string | null } {
  let fd: number | null = null;
  try {
    const stat = fs.lstatSync(location.manifestPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return { result: { ok: false, errors: ['Manifest must be a regular file, not a symbolic link.'] }, sha256: null };
    }
    const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
    fd = fs.openSync(location.manifestPath, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(fd);
    if (!opened.isFile()) {
      return { result: { ok: false, errors: ['Manifest must be a regular file.'] }, sha256: null };
    }
    if (opened.size > MAX_MANIFEST_BYTES) {
      return { result: { ok: false, errors: [`Manifest exceeds ${MAX_MANIFEST_BYTES} bytes.`] }, sha256: null };
    }
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw new Error('Manifest changed while it was being read.');
      offset += count;
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const raw = JSON.parse(bytes.toString('utf8')) as unknown;
    const result = validateProviderPackManifest(raw);
    if (result.ok && result.manifest.id !== location.expectedId) {
      return {
        result: { ok: false, errors: [`Manifest id "${result.manifest.id}" must match its file or directory name "${location.expectedId}".`] },
        sha256,
      };
    }
    return { result, sha256 };
  } catch (error) {
    return {
      result: { ok: false, errors: [error instanceof Error ? error.message : String(error)] },
      sha256: null,
    };
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

function adapterPath(record: ProviderPackRecord): string | null {
  const executable = record.manifest?.adapter?.executable;
  if (!executable || !record.sourcePath) return null;
  // An executable adapter must live in a directory pack. A stand-alone JSON
  // manifest has no private directory, so treating the whole packs root as its
  // sandbox would let it point into a neighboring pack.
  if (!fs.statSync(record.sourcePath).isDirectory()) return null;
  const base = record.sourcePath;
  const resolved = path.resolve(base, executable);
  if (!within(base, resolved)) return null;
  return resolved;
}

function fileSha256(file: string, purpose: 'manifest' | 'adapter'): string {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${purpose === 'adapter' ? 'Adapter executable' : 'Manifest'} must be a regular file, not a symbolic link.`);
  const max = purpose === 'adapter' ? MAX_ADAPTER_BYTES : MAX_MANIFEST_BYTES;
  if (stat.size > max) throw new Error(`${purpose === 'adapter' ? 'Adapter executable' : 'Manifest'} exceeds ${max} bytes.`);
  if (purpose === 'adapter') fs.accessSync(file, fs.constants.X_OK);
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function freshState(): RegistryState {
  return { schemaVersion: 1, packs: {} };
}

function readState(rootDir: string): { state: RegistryState; diagnostic: string | null } {
  const file = path.join(rootDir, STATE_FILE);
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_MANIFEST_BYTES) {
      return { state: freshState(), diagnostic: 'Provider pack state was invalid and was ignored.' };
    }
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (!isObject(raw) || raw.schemaVersion !== 1 || !isObject(raw.packs)) {
      return { state: freshState(), diagnostic: 'Provider pack state used an unsupported format and was ignored.' };
    }
    const packs: Record<string, PackState> = {};
    for (const [id, value] of Object.entries(raw.packs)) {
      if (!ID_RE.test(id) || !isObject(value)) continue;
      packs[id] = {
        ...(typeof value.enabled === 'boolean' ? { enabled: value.enabled } : {}),
        ...(typeof value.pendingRemoval === 'boolean' ? { pendingRemoval: value.pendingRemoval } : {}),
        ...(typeof value.trustedManifestSha256 === 'string' ? { trustedManifestSha256: value.trustedManifestSha256 } : {}),
        ...(typeof value.trustedAdapterSha256 === 'string' ? { trustedAdapterSha256: value.trustedAdapterSha256 } : {}),
        ...(Array.isArray(value.pendingActiveProfileIds)
          ? { pendingActiveProfileIds: value.pendingActiveProfileIds.filter((v): v is string => typeof v === 'string') }
          : {}),
        ...(typeof value.removedAt === 'number' ? { removedAt: value.removedAt } : {}),
        ...(typeof value.trashPath === 'string' ? { trashPath: value.trashPath } : {}),
        ...(typeof value.sourceName === 'string' ? { sourceName: value.sourceName } : {}),
        ...(typeof value.lastLabel === 'string' ? { lastLabel: value.lastLabel } : {}),
        ...(typeof value.lastVersion === 'string' ? { lastVersion: value.lastVersion } : {}),
      };
    }
    return { state: { schemaVersion: 1, packs }, diagnostic: null };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: freshState(), diagnostic: null };
    return {
      state: freshState(),
      diagnostic: `Provider pack state could not be read and was ignored: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function writeState(rootDir: string, state: RegistryState): void {
  fs.mkdirSync(rootDir, { recursive: true, mode: 0o700 });
  const file = path.join(rootDir, STATE_FILE);
  const temp = path.join(rootDir, `${STATE_FILE}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  try { fs.renameSync(temp, file); }
  catch (error) {
    try { fs.unlinkSync(temp); } catch { /* best effort */ }
    throw error;
  }
}

function localPackDirectory(record: ProviderPackRecord): string | null {
  if (record.source !== 'local' || !record.sourcePath) return null;
  try { return fs.statSync(record.sourcePath).isDirectory() ? record.sourcePath : null; }
  catch { return null; }
}

function publicProfile(manifest: ProviderPackManifest, profile: ProviderProfileManifest, record: ProviderPackRecord): ProviderProfile {
  return {
    ...profile,
    packId: manifest.id,
    packLabel: manifest.label,
    packVersion: manifest.version,
    source: record.source,
    enabled: record.enabled && record.status === 'enabled',
    // Stand-alone JSON manifests have no private directory and therefore no
    // right to name neighboring executable fallbacks.
    packDir: localPackDirectory(record),
  };
}

export class ProviderPackRegistry {
  readonly rootDir: string;
  private readonly builtins: ProviderPackManifest[];
  private readonly credentialResolver: (id: string) => string | null;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly homeDir: string;
  private current: ProviderPackSnapshot;

  constructor(options: ProviderPackRegistryOptions = {}) {
    this.rootDir = path.resolve(options.rootDir ?? defaultProviderPacksRoot());
    this.builtins = options.builtins ?? BUILTIN_PROVIDER_PACKS;
    this.credentialResolver = options.credentialResolver ?? (() => null);
    this.environment = options.environment ?? process.env;
    this.homeDir = options.homeDir ?? os.homedir();
    this.current = { rootDir: this.rootDir, packs: [], profiles: [], diagnostics: [], refreshedAt: 0 };
    this.refresh();
  }

  refresh(): ProviderPackSnapshot {
    const stateResult = readState(this.rootDir);
    const state = stateResult.state;
    const diagnostics = stateResult.diagnostic ? [stateResult.diagnostic] : [];
    const records: ProviderPackRecord[] = [];
    const seenPackIds = new Set<string>();

    for (const raw of this.builtins) {
      const result = validateProviderPackManifest(raw);
      if ('errors' in result) {
        diagnostics.push(`Built-in provider pack is invalid: ${result.errors.join(' ')}`);
        continue;
      }
      const manifest = result.manifest;
      if (seenPackIds.has(manifest.id)) {
        diagnostics.push(`Duplicate built-in provider pack id "${manifest.id}".`);
        continue;
      }
      seenPackIds.add(manifest.id);
      const packState = state.packs[manifest.id] ?? {};
      const enabled = packState.enabled !== false;
      records.push({
        id: manifest.id,
        label: manifest.label,
        version: manifest.version,
        source: 'builtin',
        sourcePath: null,
        manifest,
        status: enabled ? 'enabled' : 'disabled',
        enabled,
        errors: [],
        manifestSha256: null,
        trustedManifestSha256: null,
        adapterSha256: null,
        trustedAdapterSha256: null,
        pendingActiveProfileIds: [],
        removedAt: null,
        recoverable: false,
      });
    }

    const locationsResult = manifestLocations(this.rootDir);
    diagnostics.push(...locationsResult.diagnostics);
    for (const location of locationsResult.locations) {
      const manifestRead = readManifest(location);
      const result = manifestRead.result;
      if ('errors' in result) {
        records.push({
          id: `invalid.${location.expectedId.replace(/[^a-z0-9._-]+/gi, '-').toLowerCase()}`,
          label: location.expectedId,
          version: null,
          source: 'local',
          sourcePath: location.sourcePath,
          manifest: null,
          status: 'invalid',
          enabled: false,
          errors: result.errors,
          manifestSha256: null,
          trustedManifestSha256: null,
          adapterSha256: null,
          trustedAdapterSha256: null,
          pendingActiveProfileIds: [],
          removedAt: null,
          recoverable: false,
        });
        continue;
      }
      const manifest = result.manifest;
      if (seenPackIds.has(manifest.id)) {
        records.push({
          id: manifest.id,
          label: manifest.label,
          version: manifest.version,
          source: 'local',
          sourcePath: location.sourcePath,
          manifest,
          status: 'invalid',
          enabled: false,
          errors: [`Pack id "${manifest.id}" conflicts with an installed pack.`],
          manifestSha256: null,
          trustedManifestSha256: null,
          adapterSha256: null,
          trustedAdapterSha256: null,
          pendingActiveProfileIds: [],
          removedAt: null,
          recoverable: false,
        });
        continue;
      }
      seenPackIds.add(manifest.id);
      const packState = state.packs[manifest.id] ?? {};
      const manifestSha256 = manifestRead.sha256;
      let adapterSha256: string | null = null;
      const errors: string[] = [];
      for (const profile of manifest.profiles) {
        if (profile.command.fallbackPaths?.length) {
          errors.push(
            `${profile.id}: local packs cannot declare executable fallbackPaths. ` +
            'Install the dedicated provider CLI on PATH instead.'
          );
        }
        if (profile.harness !== 'generic-cli' && !manifest.adapter) {
          errors.push(
            `${profile.id}: local packs that claim the ${profile.harness} harness require a separately ` +
            'trusted capability-probe adapter. Use generic-cli for a manifest-only provider.'
          );
        }
      }
      if (!manifestSha256) errors.push('Manifest digest could not be bound to the parsed bytes.');
      if (manifest.adapter) {
        try {
          const provisional: ProviderPackRecord = {
            id: manifest.id, label: manifest.label, version: manifest.version, source: 'local',
            sourcePath: location.sourcePath, manifest, status: 'needs-trust', enabled: false, errors: [],
            manifestSha256, trustedManifestSha256: null, adapterSha256: null, trustedAdapterSha256: null,
            pendingActiveProfileIds: [], removedAt: null,
            recoverable: false,
          };
          const executable = adapterPath(provisional);
          if (!executable) throw new Error('Adapter executable escapes its provider pack directory.');
          adapterSha256 = fileSha256(executable, 'adapter');
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
        }
      }
      const manifestTrusted = !!manifestSha256 && packState.trustedManifestSha256 === manifestSha256;
      const adapterTrusted = !manifest.adapter || (!!adapterSha256 && packState.trustedAdapterSha256 === adapterSha256);
      const pending = packState.pendingRemoval === true;
      // Local discovery is not installation consent. A new or changed manifest
      // starts unavailable until setEnabled(true) records the exact reviewed
      // digest. This also prevents an enabled pack from silently changing argv.
      const enabled = !pending && packState.enabled === true && manifestTrusted && adapterTrusted && errors.length === 0;
      const status: ProviderPackStatus = errors.length
        ? 'invalid'
        : pending
          ? 'pending-removal'
          : !manifestTrusted || !adapterTrusted
            ? 'needs-trust'
            : enabled
              ? 'enabled'
              : 'disabled';
      records.push({
        id: manifest.id,
        label: manifest.label,
        version: manifest.version,
        source: 'local',
        sourcePath: location.sourcePath,
        manifest,
        status,
        enabled,
        errors,
        manifestSha256,
        trustedManifestSha256: packState.trustedManifestSha256 ?? null,
        adapterSha256,
        trustedAdapterSha256: packState.trustedAdapterSha256 ?? null,
        pendingActiveProfileIds: packState.pendingActiveProfileIds ?? [],
        removedAt: null,
        recoverable: false,
      });
    }

    for (const [id, packState] of Object.entries(state.packs)) {
      if (!packState.removedAt || seenPackIds.has(id)) continue;
      const trashPath = packState.trashPath ? path.resolve(this.rootDir, packState.trashPath) : null;
      records.push({
        id,
        label: packState.lastLabel ?? id,
        version: packState.lastVersion ?? null,
        source: 'local',
        sourcePath: null,
        manifest: null,
        status: 'removed',
        enabled: false,
        errors: [],
        manifestSha256: null,
        trustedManifestSha256: packState.trustedManifestSha256 ?? null,
        adapterSha256: null,
        trustedAdapterSha256: packState.trustedAdapterSha256 ?? null,
        pendingActiveProfileIds: [],
        removedAt: packState.removedAt,
        recoverable: !!trashPath && within(path.join(this.rootDir, TRASH_DIR), trashPath) && fs.existsSync(trashPath),
      });
    }

    const profiles: ProviderProfile[] = [];
    const seenProfileIds = new Set<string>();
    for (const record of records) {
      if (!record.manifest || record.status === 'invalid' || record.status === 'removed') continue;
      const conflict = record.manifest.profiles.find((profile) => seenProfileIds.has(profile.id));
      if (conflict) {
        record.errors.push(`Profile id "${conflict.id}" conflicts with another installed profile.`);
        record.status = 'invalid';
        record.enabled = false;
        continue;
      }
      for (const profile of record.manifest.profiles) {
        seenProfileIds.add(profile.id);
        profiles.push(publicProfile(record.manifest, profile, record));
      }
    }

    this.current = {
      rootDir: this.rootDir,
      packs: records.sort((a, b) => a.label.localeCompare(b.label)),
      profiles: profiles.sort((a, b) => a.label.localeCompare(b.label)),
      diagnostics,
      refreshedAt: Date.now(),
    };
    return this.snapshot();
  }

  snapshot(): ProviderPackSnapshot {
    // Snapshot data is deliberately JSON-only because it crosses Electron IPC.
    // A JSON clone also keeps the registry usable in the older Node runtime a
    // developer shell may have selected, even though packaged Wanigan is newer.
    return JSON.parse(JSON.stringify(this.current)) as ProviderPackSnapshot;
  }

  listPacks(options: { includeRemoved?: boolean } = {}): ProviderPackRecord[] {
    return this.snapshot().packs.filter((pack) => options.includeRemoved || pack.status !== 'removed');
  }

  listProfiles(options: { includeDisabled?: boolean } = {}): ProviderProfile[] {
    return this.snapshot().profiles.filter((profile) => options.includeDisabled || profile.enabled);
  }

  profileById(id: string): ProviderProfile | undefined {
    return this.listProfiles().find((profile) => profile.id === id);
  }

  runtimeById(id: string): ProviderRuntimeDefinition | undefined {
    const profile = this.profileById(id);
    return profile ? compileProviderProfile(profile, {
      credentialResolver: this.credentialResolver,
      environment: this.environment,
      homeDir: this.homeDir,
    }) : undefined;
  }

  /**
   * Returns an adapter only when its pack and exact executable digest are both
   * currently trusted and enabled. The caller must hash again immediately
   * before spawning; this lookup is authorization context, not a TOCTOU-safe
   * executable handle.
   */
  trustedAdapterForProfile(profileId: string): TrustedProviderProcessAdapter | null {
    const profile = this.profileById(profileId);
    if (!profile?.enabled || profile.source !== 'local') return null;
    const pack = this.current.packs.find((entry) => entry.id === profile.packId);
    if (!pack?.enabled || pack.status !== 'enabled' || !pack.manifest?.adapter) return null;
    if (!pack.adapterSha256 || pack.adapterSha256 !== pack.trustedAdapterSha256) return null;
    const executable = adapterPath(pack);
    if (!executable) return null;
    return {
      packId: pack.id,
      profileId,
      executable,
      args: [...(pack.manifest.adapter.args ?? [])],
      sha256: pack.adapterSha256,
      cwd: path.dirname(executable),
    };
  }

  setEnabled(packId: string, enabled: boolean): ProviderPackSnapshot {
    const pack = this.current.packs.find((entry) => entry.id === packId && entry.status !== 'removed');
    if (!pack) throw new Error(`Provider pack "${packId}" is not installed.`);
    if (pack.status === 'invalid') throw new Error(`Provider pack "${packId}" is invalid and cannot be enabled.`);
    if (enabled && pack.source === 'local' && pack.manifestSha256 !== pack.trustedManifestSha256) {
      throw new Error('Trust this exact provider manifest digest before enabling it.');
    }
    if (enabled && pack.manifest?.adapter && pack.adapterSha256 !== pack.trustedAdapterSha256) {
      throw new Error('Trust this pack\'s executable adapter before enabling it.');
    }
    if (enabled && pack.status === 'pending-removal') throw new Error('Restore this provider pack before enabling it.');
    const { state } = readState(this.rootDir);
    const prior = state.packs[packId] ?? {};
    state.packs[packId] = {
      ...prior,
      enabled,
    };
    writeState(this.rootDir, state);
    return this.refresh();
  }

  trustManifest(packId: string, sha256: string): ProviderPackSnapshot {
    const pack = this.current.packs.find((entry) => entry.id === packId && entry.source === 'local');
    if (!pack?.manifest || !pack.manifestSha256) throw new Error(`Provider pack "${packId}" has no inspectable manifest.`);
    if (pack.manifestSha256 !== sha256) {
      throw new Error('The provider manifest changed after inspection. Review the new digest before trusting it.');
    }
    const { state } = readState(this.rootDir);
    const prior = state.packs[packId] ?? {};
    state.packs[packId] = { ...prior, trustedManifestSha256: sha256, enabled: false };
    writeState(this.rootDir, state);
    return this.refresh();
  }

  inspectAdapter(packId: string): { executable: string; sha256: string } | null {
    const pack = this.current.packs.find((entry) => entry.id === packId);
    if (!pack?.manifest?.adapter || !pack.adapterSha256) return null;
    const executable = adapterPath(pack);
    return executable ? { executable, sha256: pack.adapterSha256 } : null;
  }

  trustAdapter(packId: string, sha256: string): ProviderPackSnapshot {
    const pack = this.current.packs.find((entry) => entry.id === packId && entry.source === 'local');
    if (!pack?.manifest?.adapter || !pack.adapterSha256) throw new Error(`Provider pack "${packId}" has no inspectable adapter.`);
    if (pack.adapterSha256 !== sha256) throw new Error('The adapter changed after it was inspected. Review the new digest before trusting it.');
    const { state } = readState(this.rootDir);
    const prior = state.packs[packId] ?? {};
    state.packs[packId] = {
      ...prior,
      trustedAdapterSha256: sha256,
      enabled: false,
    };
    writeState(this.rootDir, state);
    return this.refresh();
  }

  revokeAdapterTrust(packId: string): ProviderPackSnapshot {
    const { state } = readState(this.rootDir);
    const prior = state.packs[packId] ?? {};
    state.packs[packId] = { ...prior, trustedAdapterSha256: undefined, enabled: false };
    writeState(this.rootDir, state);
    return this.refresh();
  }

  requestUninstall(packId: string, activeProfileIds: Iterable<string> = []): ProviderPackSnapshot {
    const pack = this.current.packs.find((entry) => entry.id === packId && entry.status !== 'removed');
    if (!pack) throw new Error(`Provider pack "${packId}" is not installed.`);
    if (pack.source === 'builtin') throw new Error('Built-in provider packs can be disabled but not uninstalled.');
    const profileIds = new Set(pack.manifest?.profiles.map((profile) => profile.id) ?? []);
    const active = [...new Set(activeProfileIds)].filter((id) => profileIds.has(id));
    const { state } = readState(this.rootDir);
    const prior = state.packs[packId] ?? {};
    state.packs[packId] = {
      ...prior,
      enabled: false,
      pendingRemoval: active.length > 0,
      pendingActiveProfileIds: active,
      lastLabel: pack.label,
      lastVersion: pack.version ?? undefined,
      sourceName: pack.sourcePath ? path.basename(pack.sourcePath) : undefined,
    };
    writeState(this.rootDir, state);
    if (active.length === 0) this.moveToTrash(packId);
    return this.refresh();
  }

  finalizePendingRemovals(activeProfileIds: Iterable<string> = []): ProviderPackSnapshot {
    const active = new Set(activeProfileIds);
    const pending = this.current.packs.filter((pack) => pack.status === 'pending-removal');
    for (const pack of pending) {
      const profileIds = pack.manifest?.profiles.map((profile) => profile.id) ?? [];
      if (!profileIds.some((id) => active.has(id))) this.moveToTrash(pack.id);
    }
    return this.refresh();
  }

  restore(packId: string): ProviderPackSnapshot {
    const { state } = readState(this.rootDir);
    const prior = state.packs[packId];
    if (!prior?.removedAt || !prior.trashPath) throw new Error(`Provider pack "${packId}" has no recoverable removal.`);
    const trashRoot = path.join(this.rootDir, TRASH_DIR);
    const source = path.resolve(this.rootDir, prior.trashPath);
    if (!within(trashRoot, source) || !fs.existsSync(source)) throw new Error('The recoverable provider pack is no longer in Wanigan\'s trash.');
    const sourceName = prior.sourceName ?? packId;
    if (path.basename(sourceName) !== sourceName || sourceName.startsWith('.')) {
      throw new Error('The saved provider pack restore name is invalid.');
    }
    const target = path.join(this.rootDir, sourceName);
    if (!within(this.rootDir, target) || fs.existsSync(target)) throw new Error('A provider pack already occupies the restore location.');
    fs.renameSync(source, target);
    try {
      state.packs[packId] = {
        ...prior,
        enabled: false,
        pendingRemoval: false,
        pendingActiveProfileIds: [],
        removedAt: undefined,
        trashPath: undefined,
      };
      writeState(this.rootDir, state);
    } catch (error) {
      // The state record and filesystem move are one logical operation. If the
      // durable record fails, put the pack back where the record still says it
      // is instead of leaving an invisible orphan.
      try { fs.renameSync(target, source); } catch { /* surfaced by the original error */ }
      throw error;
    }
    return this.refresh();
  }

  private moveToTrash(packId: string): void {
    const pack = this.current.packs.find((entry) => entry.id === packId && entry.source === 'local');
    if (!pack?.sourcePath) throw new Error(`Provider pack "${packId}" has no removable source.`);
    if (!within(this.rootDir, pack.sourcePath)) throw new Error('Provider pack source is outside the managed pack directory.');
    const stat = fs.lstatSync(pack.sourcePath);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error('Provider pack source is not a regular file or directory.');
    const trashRoot = path.join(this.rootDir, TRASH_DIR);
    fs.mkdirSync(trashRoot, { recursive: true, mode: 0o700 });
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const target = path.join(trashRoot, `${packId}-${suffix}`);
    fs.renameSync(pack.sourcePath, target);
    try {
      const { state } = readState(this.rootDir);
      const prior = state.packs[packId] ?? {};
      state.packs[packId] = {
        ...prior,
        enabled: false,
        pendingRemoval: false,
        pendingActiveProfileIds: [],
        removedAt: Date.now(),
        trashPath: path.relative(this.rootDir, target),
        lastLabel: pack.label,
        lastVersion: pack.version ?? undefined,
        sourceName: path.basename(pack.sourcePath),
      };
      writeState(this.rootDir, state);
    } catch (error) {
      try { fs.renameSync(target, pack.sourcePath); } catch { /* surfaced by the original error */ }
      throw error;
    }
  }
}

export function createDefaultProviderPackRegistry(options: ProviderPackRegistryOptions = {}): ProviderPackRegistry {
  return new ProviderPackRegistry(options);
}
