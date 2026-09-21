/**
 * What a valid Wanigan extension is — the one definition, read by three.
 *
 * An extension is a bundle of DECLARATIONS across surfaces that already exist:
 * MCP servers, skills, review gates, instructions, Scout sources. It is never a place to load
 * code, and nothing it ships runs inside Wanigan's process. An extension that
 * needs to compute something does it behind a protocol Wanigan already speaks
 * out of process — an MCP server, or a provider pack's v1 capability adapter.
 * That is the entire reason a stranger's extension can be installed at all, so
 * nothing below may grow a field that names something for Wanigan to execute.
 *
 * The authoring CLI, the installer in the main process and the install dialog
 * in the renderer all answer "is this a valid extension?" from this file.
 * Three copies would be three answers to a question that has to have one: a CLI
 * that accepts what the installer rejects ships a broken extension, and a
 * dialog that summarises less than the installer applies is a consent screen
 * that consents to something else. `src/shared` is pure by construction — no
 * node builtins, no Electron, no fs — which is what lets all three import it
 * and lets the suite beside it answer in under a second.
 *
 * Every string check here is a check on a string. Whether `skills[0].file`
 * actually resolves inside the extension directory is a filesystem question and
 * belongs to the installer; refusing `..` here only means a manifest cannot ask
 * for the escape in the first place.
 */
import type { ExtensionArtifactInfo, ExtensionConsentLine } from './types.ts';

export const EXTENSION_SCHEMA_VERSION = 1;
export const EXTENSION_MANIFEST_FILE = 'wanigan-extension.json';

/**
 * The same shape provider pack ids use. An id becomes part of an owner string,
 * a directory name and a credential name, so the characters that survive all
 * three are the characters allowed here.
 */
const EXTENSION_ID_RE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const MAX_ID = 64;

/** `major.minor.patch`, optionally `-prerelease`. Nothing else is a version. */
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;

/**
 * Copied deliberately from `NAME_RE` in `src/main/mcp/registry.ts`, and it must
 * stay identical to it. The name is not cosmetic: it becomes part of the tool id
 * the agent sees (`mcp__<name>__<tool>`) and the key in the generated config, so
 * a space or a dot produces a server the agent can list and can never call. An
 * extension that installed one would leave a row on screen that looks installed
 * and is dead, which is the failure this whole file exists to make impossible.
 */
const MCP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** A skill name becomes a directory name under the provider's skills root. */
const SKILL_NAME_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `>=x.y.z`, or a bare `x.y.z` meaning the same floor. */
const REQUIRES_RE = /^(?:>=\s*)?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?$/;

const MAX_MCP_SERVERS = 20;
const MAX_SKILLS = 50;
const MAX_GATES = 20;
const MAX_INSTRUCTIONS = 20;
const MAX_SCOUT_SOURCES = 20;
const MAX_STORE_SOURCES = 10;
const MAX_CREDENTIALS = 20;
/** Matches `saveRecipe` in `src/main/review.ts`, which stores at most 20 and refuses one over 2,000 characters. */
const MAX_GATE_COMMANDS = 20;
const MAX_GATE_COMMAND_CHARS = 2_000;
const MAX_ARGS = 50;
const MAX_ENV_ENTRIES = 50;
const MAX_FILE_CHARS = 200;
const MAX_LABEL = 80;
const MAX_DESCRIPTION = 500;
const MAX_URL_CHARS = 2_000;
/**
 * Shorter than MAX_DESCRIPTION because Scout renders it beside the row, not
 * behind a disclosure: a paragraph there pushes the url it describes off the
 * screen it was meant to explain.
 */
const MAX_SCOUT_DESCRIPTION = 200;

/**
 * Environment destinations an extension may not choose.
 *
 * The same reasoning as `forbiddenProviderEnvironment` in
 * `src/main/provider-packs.ts`, for the same reason: these names are not
 * configuration, they are a way to run code. `NODE_OPTIONS`, `BASH_ENV`,
 * `PYTHONPATH` and the `LD_*`/`DYLD_*` loader family each make an unrelated
 * process load a file of the setter's choosing, which turns a declaration-only
 * format into exactly the code-loading one it promises not to be — the MCP
 * server the operator approved would still be the command on the consent line,
 * and it would still execute something else first.
 *
 * `WANIGAN_`, `OTEL_` and `ELECTRON_` are refused for a different reason: they
 * are Wanigan's own namespace and its telemetry and runtime controls. An
 * extension that could set them could redirect where a session's evidence is
 * sent, or change how the app's own process behaves, from inside a bundle whose
 * consent screen says it only adds an MCP server.
 *
 * Like every denylist, this refuses known shapes. It is not proof that a name
 * it does not match is harmless.
 */
const INJECTION_ENV = new Set([
  'NODE_OPTIONS', 'NODE_PATH', 'BASH_ENV', 'ENV', 'ZDOTDIR', 'PROMPT_COMMAND',
  'PYTHONPATH', 'PYTHONHOME', 'PYTHONSTARTUP', 'PYTHONINSPECT',
  'RUBYOPT', 'RUBYLIB', 'PERL5OPT', 'PERL5LIB',
  'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS', 'CLASSPATH',
  'PHPRC', 'PHP_INI_SCAN_DIR', 'LUA_PATH', 'LUA_CPATH',
  'DOTNET_STARTUP_HOOKS', 'DOTNET_ADDITIONAL_DEPS', 'GCONV_PATH',
]);

function forbiddenEnvironmentDestination(name: string): boolean {
  const upper = name.toUpperCase();
  return INJECTION_ENV.has(upper) ||
    upper.startsWith('LD_') || upper.startsWith('DYLD_') || upper.startsWith('NIX_LD') ||
    upper.startsWith('WANIGAN_') || upper.startsWith('OTEL_') || upper.startsWith('ELECTRON_');
}

export type ExtensionCredentialRequest = { id: string; label: string; help?: string };

export type ExtensionEnvValue =
  | { source: 'credential'; id: string }
  | { source: 'literal'; value: string };

export type ExtensionMcpServer = {
  name: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  description?: string;
  scope?: 'global' | 'project';
  env?: Record<string, ExtensionEnvValue>;
};

export type ExtensionSkill = { name: string; file: string; description?: string };
export type ExtensionGate = { label: string; commands: string[] };
export type ExtensionInstruction = { scope: 'project' | 'personal'; title: string; file: string };

/** The same three Improvement Scout already reads; the manifest mirrors the code, not the other way round. */
const SCOUT_SOURCE_KINDS = ['changelog', 'release-notes', 'documentation'] as const;
/**
 * How a store source's url is read. One format today, declared anyway: a catalog
 * read as the wrong shape is a list of entries that are not what they say, and
 * the field is what lets a second format arrive without every existing
 * manifest's meaning changing underneath it.
 */
export const STORE_SOURCE_FORMATS = ['mcp-registry'] as const;
export type ExtensionStoreSourceFormat = typeof STORE_SOURCE_FORMATS[number];
export type ExtensionScoutSourceKind = typeof SCOUT_SOURCE_KINDS[number];

/**
 * A public page Improvement Scout reads on its weekly schedule and proposes
 * product changes from. The five built-in sources are this shape wearing a
 * TypeScript costume, and this is how a sixth arrives without a code change.
 *
 * `description` is required, unlike an MCP server's. Scout shows it beside the
 * row, and a source with no sentence is a url nobody can judge before it is
 * polled on their behalf every week.
 */
export type ExtensionScoutSource = {
  id: string;
  label: string;
  description: string;
  url: string;
  publisher: string;
  kind: ExtensionScoutSourceKind;
};

/**
 * A catalog of installable extensions, declared the same way a Scout source is.
 *
 * The store browses these and nothing else: there is no built-in address and no
 * fallback, so the set of places Wanigan will fetch an extension from is exactly
 * the set some manifest declared and an operator consented to. Wanigan's own
 * catalog is a built-in extension for that reason — a default reachable by a
 * private path would be an extension point nobody has proven works.
 *
 * A source is an index, never a payload. Fetching one yields a list of entries
 * to show; installing one of them still stages a directory and goes through
 * `validateExtensionManifest`, the consent screen and digest trust, exactly as
 * a directory chosen in a picker does.
 */
export type ExtensionStoreSource = {
  id: string;
  label: string;
  description: string;
  /** https, and the index document itself rather than a page describing it. */
  url: string;
  publisher: string;
  format: ExtensionStoreSourceFormat;
};

export type ExtensionManifest = {
  schemaVersion: 1;
  id: string;
  label: string;
  version: string;
  description?: string;
  publisher?: { id: string; name: string; url?: string };
  requires?: { wanigan?: string };
  credentials?: ExtensionCredentialRequest[];
  provides: {
    mcpServers?: ExtensionMcpServer[];
    skills?: ExtensionSkill[];
    gates?: ExtensionGate[];
    instructions?: ExtensionInstruction[];
    scoutSources?: ExtensionScoutSource[];
    storeSources?: ExtensionStoreSource[];
  };
};

export type ExtensionValidation = {
  ok: boolean;
  /** Null whenever `ok` is false: a partly-parsed manifest is not a manifest. */
  manifest: ExtensionManifest | null;
  /** Every reason, never the first. One fix per round trip is how an author gives up. */
  errors: string[];
  warnings: string[];
};

/* ── small parsers ────────────────────────────────────────────────────── */

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Own properties only, so a manifest cannot inherit a field from the prototype. */
function own(value: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
}

function text(value: unknown, where: string, errors: string[], opts: {
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
  let ok = true;
  if (out.length > (opts.max ?? MAX_DESCRIPTION)) {
    errors.push(`${where} is longer than ${opts.max ?? MAX_DESCRIPTION} characters.`);
    ok = false;
  }
  // A NUL truncates a C string and a line break splits one declaration into
  // two: either turns what consent displayed into something else at the point
  // it is written to a config file or handed to a shell.
  if (out.includes('\0') || /[\r\n]/.test(out)) {
    errors.push(`${where} cannot contain line breaks or NUL bytes.`);
    ok = false;
  }
  if (opts.pattern && !opts.pattern.test(out)) {
    errors.push(`${where} is not in the required format.`);
    ok = false;
  }
  return ok ? out : undefined;
}

/**
 * A path an extension may write to, checked as a string only.
 *
 * Absolute paths, `~`, `..` segments and backslashes are the four ways a
 * relative-looking field names a file outside the directory the operator chose
 * to install. The installer still resolves and containment-checks the real
 * path; this refusal means a manifest cannot even ask.
 */
function relativeFile(value: unknown, where: string, errors: string[]): string | undefined {
  const out = text(value, where, errors, { required: true, max: MAX_FILE_CHARS });
  if (out === undefined) return undefined;
  let ok = true;
  if (out.includes('\\')) {
    errors.push(`${where} must use forward slashes; a backslash is a path separator on one platform and a literal character on another.`);
    ok = false;
  }
  if (out.startsWith('/') || /^[A-Za-z]:/.test(out)) {
    errors.push(`${where} must be relative to the extension directory, not an absolute path.`);
    ok = false;
  }
  if (out.startsWith('~')) {
    errors.push(`${where} must be relative to the extension directory; "~" names the operator's home directory.`);
    ok = false;
  }
  if (out.split('/').includes('..')) {
    errors.push(`${where} cannot contain a ".." segment, which would write outside the extension directory.`);
    ok = false;
  }
  return ok ? out : undefined;
}

function argList(value: unknown, where: string, errors: string[], max: number): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    errors.push(`${where} must be an array of strings.`);
    return undefined;
  }
  if (value.length > max) errors.push(`${where} has more than ${max} entries.`);
  const out: string[] = [];
  value.slice(0, max).forEach((entry, i) => {
    // Each entry is one argv entry. An empty string is a real argument, so it
    // is allowed here where `text` would refuse it.
    if (typeof entry !== 'string') {
      errors.push(`${where}[${i}] must be a string.`);
      return;
    }
    if (entry.includes('\0') || /[\r\n]/.test(entry)) {
      errors.push(`${where}[${i}] cannot contain line breaks or NUL bytes.`);
      return;
    }
    if (entry.length > 4_096) {
      errors.push(`${where}[${i}] is longer than 4,096 characters.`);
      return;
    }
    out.push(entry);
  });
  return out;
}

function parseVersion(value: string): { parts: [number, number, number]; prerelease: string | null } | null {
  const match = REQUIRES_RE.exec(value.trim());
  if (!match) return null;
  return {
    parts: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ?? null,
  };
}

/**
 * Whether the running Wanigan satisfies a declared floor.
 *
 * A prerelease of the floor version is below it: `1.4.0-beta.2` is what ships
 * before `1.4.0`, so an extension that requires `>=1.4.0` does not get to run
 * against the build where the thing it needs is still being written.
 */
function meetsFloor(app: string, floor: string): boolean | null {
  const running = parseVersion(app);
  const required = parseVersion(floor);
  if (!running || !required) return null;
  for (let i = 0; i < 3; i += 1) {
    if (running.parts[i] > required.parts[i]) return true;
    if (running.parts[i] < required.parts[i]) return false;
  }
  if (running.prerelease && !required.prerelease) return false;
  return true;
}

/* ── the pieces of `provides` ─────────────────────────────────────────── */

function parseEnv(
  raw: unknown,
  where: string,
  errors: string[],
  declaredCredentials: Set<string>
): Record<string, ExtensionEnvValue> | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) {
    errors.push(`${where} must be an object.`);
    return undefined;
  }
  const entries = Object.entries(raw);
  if (entries.length > MAX_ENV_ENTRIES) errors.push(`${where} has more than ${MAX_ENV_ENTRIES} entries.`);
  const out: Record<string, ExtensionEnvValue> = {};
  for (const [name, value] of entries.slice(0, MAX_ENV_ENTRIES)) {
    if (!ENV_NAME_RE.test(name)) {
      errors.push(`${where}.${name} is not a valid environment variable name.`);
      continue;
    }
    if (forbiddenEnvironmentDestination(name)) {
      errors.push(
        `${where}.${name} can load code into a process or override Wanigan's own runtime and telemetry controls, and is refused.`
      );
      continue;
    }
    if (!isObject(value)) {
      errors.push(`${where}.${name} must be an object.`);
      continue;
    }
    const source = own(value, 'source');
    if (source === 'literal') {
      const literal = own(value, 'value');
      if (typeof literal !== 'string' || literal.includes('\0') || /[\r\n]/.test(literal)) {
        errors.push(`${where}.${name}.value must be a string without line breaks or NUL bytes.`);
        continue;
      }
      if (literal.length > 4_096) {
        errors.push(`${where}.${name}.value is longer than 4,096 characters.`);
        continue;
      }
      out[name] = { source: 'literal', value: literal };
    } else if (source === 'credential') {
      const id = text(own(value, 'id'), `${where}.${name}.id`, errors, {
        required: true, max: MAX_ID, pattern: EXTENSION_ID_RE,
      });
      if (id === undefined) continue;
      // The credential store this resolves through is one flat id space, so an
      // id alone is not an owner. A manifest that could name a credential it
      // does not declare would read the operator's stored key for some other
      // extension and re-emit it under a destination name of its choosing, at
      // a host of its choosing — the rename, which is the leak.
      if (!declaredCredentials.has(id)) {
        errors.push(
          `${where}.${name}.id is "${id}", which this manifest does not declare in credentials. ` +
          'An extension may only read a credential it asks the operator for itself.'
        );
        continue;
      }
      out[name] = { source: 'credential', id };
    } else {
      errors.push(`${where}.${name}.source must be "credential" or "literal".`);
    }
  }
  return out;
}

function parseMcpServer(
  raw: unknown,
  where: string,
  errors: string[],
  warnings: string[],
  declaredCredentials: Set<string>
): ExtensionMcpServer | null {
  if (!isObject(raw)) {
    errors.push(`${where} must be an object.`);
    return null;
  }
  const name = text(own(raw, 'name'), `${where}.name`, errors, { required: true, max: 64 });
  if (name !== undefined && !MCP_NAME_RE.test(name)) {
    errors.push(
      `${where}.name "${name}" cannot be used as an MCP server name. Use letters, digits, dashes and ` +
      'underscores only: the name becomes part of the tool id the agent calls, so a space or a dot ' +
      'produces a server the agent can list and can never call.'
    );
  }
  const transportRaw = own(raw, 'transport');
  const transport = transportRaw === 'stdio' || transportRaw === 'http' ? transportRaw : null;
  if (!transport) errors.push(`${where}.transport must be "stdio" or "http".`);

  const command = text(own(raw, 'command'), `${where}.command`, errors, { max: 1_000 });
  const args = argList(own(raw, 'args'), `${where}.args`, errors, MAX_ARGS);
  const url = text(own(raw, 'url'), `${where}.url`, errors, { max: MAX_URL_CHARS });
  const description = text(own(raw, 'description'), `${where}.description`, errors, { max: MAX_DESCRIPTION });

  const scopeRaw = own(raw, 'scope');
  let scope: 'global' | 'project' | undefined;
  if (scopeRaw !== undefined) {
    if (scopeRaw !== 'global' && scopeRaw !== 'project') errors.push(`${where}.scope must be "global" or "project".`);
    else scope = scopeRaw;
  }

  if (transport === 'stdio') {
    if (command === undefined) errors.push(`${where}.command is required for a stdio server.`);
    // Refused rather than ignored. A manifest carrying both is one whose author
    // believes something about it that is not true, and silently dropping the
    // url installs a server that talks to nothing the author meant.
    if (own(raw, 'url') !== undefined) errors.push(`${where}.url is not valid for a stdio server; remove it or use transport "http".`);
  }
  if (transport === 'http') {
    if (url === undefined) errors.push(`${where}.url is required for an http server.`);
    if (own(raw, 'command') !== undefined) errors.push(`${where}.command is not valid for an http server; remove it or use transport "stdio".`);
    if (own(raw, 'args') !== undefined) errors.push(`${where}.args is not valid for an http server; remove it or use transport "stdio".`);
  }

  // There is deliberately NO general-purpose-launcher denylist here, and adding
  // one would be a regression rather than a hardening. `provider-packs.ts`
  // refuses `sh`, `node`, `python` and `npx` for a manifest that launches an
  // agent CLI, where a dedicated installed binary is the normal case and an
  // interpreter is the anomaly. MCP servers are the opposite: `npx -y
  // some-mcp`, `node ./server.js` and `python -m something` are what the
  // protocol's own documentation tells people to write, so the same list here
  // would refuse essentially every MCP server that exists while stopping
  // nobody — an author who wanted an interpreter would ship a one-line wrapper
  // binary and pass. The honest control for a stdio server is the consent line
  // below, which shows the exact command and every argument as they will run,
  // plus trust pinned to the manifest digest so those bytes cannot change
  // underneath the approval.
  if (command !== undefined && (command.startsWith('/') || command.startsWith('~') || /^[A-Za-z]:[\\/]/.test(command))) {
    // Not an error: a locally written extension legitimately names a binary by
    // path. It is a warning because a distributed one is naming a file on the
    // author's machine, and the server will simply fail to start on anybody
    // else's.
    warnings.push(`${where}.command is an absolute path, which will only exist on a machine laid out like the author's.`);
  }

  if (transport === 'http' && url !== undefined) validateHttpUrl(url, `${where}.url`, errors);

  const env = parseEnv(own(raw, 'env'), `${where}.env`, errors, declaredCredentials);

  if (name === undefined || !transport) return null;
  return {
    name,
    transport,
    ...(transport === 'stdio' && command !== undefined ? { command } : {}),
    ...(transport === 'stdio' && args ? { args } : {}),
    ...(transport === 'http' && url !== undefined ? { url } : {}),
    ...(description ? { description } : {}),
    ...(scope ? { scope } : {}),
    ...(env ? { env } : {}),
  };
}

/**
 * An http MCP server's address.
 *
 * Plain http is refused off the loopback interface because the session's
 * requests to that server carry whatever the env block put in them, including a
 * credential the operator was asked for by name. Loopback is allowed because
 * the traffic never leaves the machine and a locally run server has nowhere to
 * get a certificate from.
 *
 * Userinfo is refused outright: `https://token@host/` is a secret pasted into a
 * field that consent renders, that logs record and that no store can redact,
 * and it reaches the host regardless of what the credential block declares.
 */
function validateHttpUrl(value: string, where: string, errors: string[]): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    errors.push(`${where} must be a valid URL.`);
    return;
  }
  const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' ||
    parsed.hostname === '::1' || parsed.hostname === '[::1]';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    errors.push(`${where} must use https, except on 127.0.0.1 or localhost.`);
  }
  if (parsed.username || parsed.password) {
    errors.push(`${where} carries a username or password in the URL. Declare a credential instead; a secret in a URL is shown, logged and never redacted.`);
  }
}

/**
 * A Scout source's address, and deliberately not `validateHttpUrl`.
 *
 * The loopback exception above exists because a session reaches an MCP server
 * while a person is running that session. Scout fetches a source unattended,
 * on a schedule, with nobody watching: a loopback source here is a way for an
 * extension to make Wanigan poll something on the machine every Saturday, from
 * a bundle whose consent screen says it reads a changelog. So there is no
 * exception — a source is a public page over https, or it is not a source.
 *
 * Userinfo is refused for the reason the MCP rule gives, and a source has no
 * credential block to point at instead: a public changelog needs no secret.
 */
function validateScoutUrl(value: string, where: string, errors: string[]): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    errors.push(`${where} must be a valid URL.`);
    return;
  }
  if (parsed.protocol !== 'https:') {
    errors.push(`${where} must use https. Scout fetches a source unattended on a schedule, so there is no loopback exception here.`);
  }
  if (parsed.username || parsed.password) {
    errors.push(`${where} carries a username or password in the URL. A Scout source is a public page and takes no secret; one in the URL is shown, logged and never redacted.`);
  }
}

function parseScoutSource(raw: unknown, where: string, errors: string[]): ExtensionScoutSource | null {
  if (!isObject(raw)) {
    errors.push(`${where} must be an object.`);
    return null;
  }
  const id = text(own(raw, 'id'), `${where}.id`, errors, { required: true, max: MAX_ID, pattern: EXTENSION_ID_RE });
  const label = text(own(raw, 'label'), `${where}.label`, errors, { required: true, max: MAX_LABEL });
  const description = text(own(raw, 'description'), `${where}.description`, errors, { required: true, max: MAX_SCOUT_DESCRIPTION });
  const url = text(own(raw, 'url'), `${where}.url`, errors, { required: true, max: MAX_URL_CHARS });
  const publisher = text(own(raw, 'publisher'), `${where}.publisher`, errors, { required: true, max: MAX_LABEL });
  const kindRaw = own(raw, 'kind');
  const kind = (SCOUT_SOURCE_KINDS as readonly unknown[]).includes(kindRaw) ? kindRaw as ExtensionScoutSourceKind : null;
  if (!kind) errors.push(`${where}.kind must be ${SCOUT_SOURCE_KINDS.map((entry) => `"${entry}"`).join(', ')}.`);
  if (url !== undefined) validateScoutUrl(url, `${where}.url`, errors);
  if (id === undefined || label === undefined || description === undefined || url === undefined || publisher === undefined || !kind) {
    return null;
  }
  return { id, label, description, url, publisher, kind };
}

function parseStoreSource(raw: unknown, where: string, errors: string[]): ExtensionStoreSource | null {
  if (!isObject(raw)) {
    errors.push(`${where} must be an object.`);
    return null;
  }
  const id = text(own(raw, 'id'), `${where}.id`, errors, { required: true, max: MAX_ID, pattern: EXTENSION_ID_RE });
  const label = text(own(raw, 'label'), `${where}.label`, errors, { required: true, max: MAX_LABEL });
  const description = text(own(raw, 'description'), `${where}.description`, errors, { required: true, max: MAX_DESCRIPTION });
  const url = text(own(raw, 'url'), `${where}.url`, errors, { required: true, max: MAX_URL_CHARS });
  const publisher = text(own(raw, 'publisher'), `${where}.publisher`, errors, { required: true, max: MAX_LABEL });
  // The same rule a Scout source gets, for the same reason: this url is fetched
  // without a person watching, so plain http and an embedded credential are both
  // refused rather than warned about.
  if (url !== undefined) validateScoutUrl(url, `${where}.url`, errors);
  const formatRaw = own(raw, 'format');
  const format = (STORE_SOURCE_FORMATS as readonly unknown[]).includes(formatRaw) ? formatRaw as ExtensionStoreSourceFormat : null;
  if (!format) errors.push(`${where}.format must be ${STORE_SOURCE_FORMATS.map((entry) => `"${entry}"`).join(', ')}.`);
  if (id === undefined || label === undefined || description === undefined || url === undefined || publisher === undefined || !format) {
    return null;
  }
  return { id, label, description, url, publisher, format };
}

function parseSkill(raw: unknown, where: string, errors: string[]): ExtensionSkill | null {
  if (!isObject(raw)) {
    errors.push(`${where} must be an object.`);
    return null;
  }
  const name = text(own(raw, 'name'), `${where}.name`, errors, { required: true, max: 64, pattern: SKILL_NAME_RE });
  const file = relativeFile(own(raw, 'file'), `${where}.file`, errors);
  const description = text(own(raw, 'description'), `${where}.description`, errors, { max: MAX_DESCRIPTION });
  if (name === undefined || file === undefined) return null;
  return { name, file, ...(description ? { description } : {}) };
}

function parseGate(raw: unknown, where: string, errors: string[]): ExtensionGate | null {
  if (!isObject(raw)) {
    errors.push(`${where} must be an object.`);
    return null;
  }
  const label = text(own(raw, 'label'), `${where}.label`, errors, { required: true, max: MAX_LABEL });
  const commandsRaw = own(raw, 'commands');
  let commands: string[] | null = null;
  if (!Array.isArray(commandsRaw) || commandsRaw.length === 0) {
    errors.push(`${where}.commands must contain at least one command.`);
  } else {
    if (commandsRaw.length > MAX_GATE_COMMANDS) errors.push(`${where}.commands has more than ${MAX_GATE_COMMANDS} entries.`);
    commands = [];
    commandsRaw.slice(0, MAX_GATE_COMMANDS).forEach((entry, i) => {
      // These are stored as review recipe commands and handed to a shell by
      // `runCommand`, from more than one surface and often with nobody
      // watching. The limits are review.ts's own, so a manifest cannot declare
      // a gate the store would then refuse and leave half applied.
      const command = text(entry, `${where}.commands[${i}]`, errors, { max: MAX_GATE_COMMAND_CHARS });
      if (command !== undefined) commands!.push(command);
    });
  }
  if (label === undefined || !commands || !commands.length) return null;
  return { label, commands };
}

function parseInstruction(raw: unknown, where: string, errors: string[]): ExtensionInstruction | null {
  if (!isObject(raw)) {
    errors.push(`${where} must be an object.`);
    return null;
  }
  const scopeRaw = own(raw, 'scope');
  const scope = scopeRaw === 'project' || scopeRaw === 'personal' ? scopeRaw : null;
  if (!scope) errors.push(`${where}.scope must be "project" or "personal".`);
  const title = text(own(raw, 'title'), `${where}.title`, errors, { required: true, max: MAX_LABEL });
  const file = relativeFile(own(raw, 'file'), `${where}.file`, errors);
  if (!scope || title === undefined || file === undefined) return null;
  return { scope, title, file };
}

function parseCredential(raw: unknown, where: string, errors: string[], extensionId: string | undefined): ExtensionCredentialRequest | null {
  if (!isObject(raw)) {
    errors.push(`${where} must be an object.`);
    return null;
  }
  const id = text(own(raw, 'id'), `${where}.id`, errors, { required: true, max: MAX_ID, pattern: EXTENSION_ID_RE });
  const label = text(own(raw, 'label'), `${where}.label`, errors, { required: true, max: MAX_LABEL });
  const help = text(own(raw, 'help'), `${where}.help`, errors, { max: MAX_DESCRIPTION });
  // The credential namespace is the extension id. Without this an extension
  // could declare the id another provider already stores the operator's key
  // under, and the operator would be asked for nothing while the key they
  // already gave Wanigan was handed to this extension's server.
  if (id !== undefined && extensionId !== undefined && id !== extensionId && !id.startsWith(`${extensionId}.`)) {
    errors.push(
      `${where}.id must be "${extensionId}" or start with "${extensionId}.". ` +
      'An extension may not name another extension\'s credential.'
    );
    return null;
  }
  if (id === undefined || label === undefined) return null;
  return { id, label, ...(help ? { help } : {}) };
}

/* ── the validator ────────────────────────────────────────────────────── */

/** `appVersion` is Wanigan's own version, for the `requires.wanigan` floor. */
export function validateExtensionManifest(value: unknown, opts: { appVersion?: string } = {}): ExtensionValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isObject(value)) {
    return { ok: false, manifest: null, errors: [`${EXTENSION_MANIFEST_FILE} must contain a JSON object.`], warnings };
  }

  if (own(value, 'schemaVersion') !== EXTENSION_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${EXTENSION_SCHEMA_VERSION}.`);
  }
  const id = text(own(value, 'id'), 'id', errors, { required: true, max: MAX_ID, pattern: EXTENSION_ID_RE });
  const label = text(own(value, 'label'), 'label', errors, { required: true, max: MAX_LABEL });
  const version = text(own(value, 'version'), 'version', errors, { required: true, max: 64, pattern: VERSION_RE });
  const description = text(own(value, 'description'), 'description', errors, { max: MAX_DESCRIPTION });

  let publisher: ExtensionManifest['publisher'];
  const publisherRaw = own(value, 'publisher');
  if (publisherRaw !== undefined) {
    if (!isObject(publisherRaw)) errors.push('publisher must be an object.');
    else {
      const publisherId = text(own(publisherRaw, 'id'), 'publisher.id', errors, { required: true, max: MAX_ID, pattern: EXTENSION_ID_RE });
      const publisherName = text(own(publisherRaw, 'name'), 'publisher.name', errors, { required: true, max: MAX_LABEL });
      const url = text(own(publisherRaw, 'url'), 'publisher.url', errors, { max: 500 });
      // A publisher url is a link a person clicks from the install dialog to
      // decide whether to trust a stranger. Over plain http it is a link an
      // attacker on the same network chooses the destination of.
      if (url !== undefined && !url.startsWith('https://')) errors.push('publisher.url must use https.');
      if (publisherId !== undefined && publisherName !== undefined) {
        publisher = { id: publisherId, name: publisherName, ...(url && url.startsWith('https://') ? { url } : {}) };
      }
    }
  }

  let requires: ExtensionManifest['requires'];
  const requiresRaw = own(value, 'requires');
  if (requiresRaw !== undefined) {
    if (!isObject(requiresRaw)) errors.push('requires must be an object.');
    else {
      const floor = text(own(requiresRaw, 'wanigan'), 'requires.wanigan', errors, { max: 64 });
      if (floor !== undefined) {
        if (!REQUIRES_RE.test(floor)) errors.push('requires.wanigan must be ">=x.y.z" or "x.y.z".');
        else {
          requires = { wanigan: floor };
          const met = opts.appVersion === undefined ? null : meetsFloor(opts.appVersion, floor);
          if (met === false) {
            errors.push(`This extension requires Wanigan ${floor}, and this is Wanigan ${opts.appVersion}.`);
          } else if (met === null) {
            // The authoring CLI has no running app to check against. Saying
            // nothing would let an author read a clean validation as proof the
            // floor is satisfied somewhere, which is not something this call
            // can know.
            warnings.push(`requires.wanigan is "${floor}" and was not checked: no running Wanigan version was supplied.`);
          }
        }
      }
    }
  }

  const credentials: ExtensionCredentialRequest[] = [];
  const credentialsRaw = own(value, 'credentials');
  if (credentialsRaw !== undefined) {
    if (!Array.isArray(credentialsRaw)) errors.push('credentials must be an array.');
    else {
      if (credentialsRaw.length > MAX_CREDENTIALS) errors.push(`credentials has more than ${MAX_CREDENTIALS} entries.`);
      credentialsRaw.slice(0, MAX_CREDENTIALS).forEach((entry, i) => {
        const parsed = parseCredential(entry, `credentials[${i}]`, errors, id);
        if (parsed) credentials.push(parsed);
      });
      const seen = new Set<string>();
      for (const credential of credentials) {
        if (seen.has(credential.id)) errors.push(`credentials declares "${credential.id}" twice.`);
        seen.add(credential.id);
      }
    }
  }
  const declaredCredentials = new Set(credentials.map((credential) => credential.id));

  const provides: ExtensionManifest['provides'] = {};
  const providesRaw = own(value, 'provides');
  if (!isObject(providesRaw)) {
    errors.push('provides must be an object.');
  } else {
    const mcpServersRaw = own(providesRaw, 'mcpServers');
    if (mcpServersRaw !== undefined) {
      if (!Array.isArray(mcpServersRaw)) errors.push('provides.mcpServers must be an array.');
      else {
        if (mcpServersRaw.length > MAX_MCP_SERVERS) errors.push(`provides.mcpServers has more than ${MAX_MCP_SERVERS} entries.`);
        const servers: ExtensionMcpServer[] = [];
        mcpServersRaw.slice(0, MAX_MCP_SERVERS).forEach((entry, i) => {
          const parsed = parseMcpServer(entry, `provides.mcpServers[${i}]`, errors, warnings, declaredCredentials);
          if (parsed) servers.push(parsed);
        });
        // Two rows with one name are one tool id, and the second one wins in
        // whatever config is generated last.
        const seen = new Set<string>();
        for (const server of servers) {
          if (seen.has(server.name)) errors.push(`provides.mcpServers declares "${server.name}" twice.`);
          seen.add(server.name);
        }
        if (servers.length) provides.mcpServers = servers;
      }
    }

    const skillsRaw = own(providesRaw, 'skills');
    if (skillsRaw !== undefined) {
      if (!Array.isArray(skillsRaw)) errors.push('provides.skills must be an array.');
      else {
        if (skillsRaw.length > MAX_SKILLS) errors.push(`provides.skills has more than ${MAX_SKILLS} entries.`);
        const skills: ExtensionSkill[] = [];
        skillsRaw.slice(0, MAX_SKILLS).forEach((entry, i) => {
          const parsed = parseSkill(entry, `provides.skills[${i}]`, errors);
          if (parsed) skills.push(parsed);
        });
        const seen = new Set<string>();
        for (const skill of skills) {
          if (seen.has(skill.name)) errors.push(`provides.skills declares "${skill.name}" twice.`);
          seen.add(skill.name);
        }
        if (skills.length) provides.skills = skills;
      }
    }

    const gatesRaw = own(providesRaw, 'gates');
    if (gatesRaw !== undefined) {
      if (!Array.isArray(gatesRaw)) errors.push('provides.gates must be an array.');
      else {
        if (gatesRaw.length > MAX_GATES) errors.push(`provides.gates has more than ${MAX_GATES} entries.`);
        const gates: ExtensionGate[] = [];
        gatesRaw.slice(0, MAX_GATES).forEach((entry, i) => {
          const parsed = parseGate(entry, `provides.gates[${i}]`, errors);
          if (parsed) gates.push(parsed);
        });
        if (gates.length) provides.gates = gates;
      }
    }

    const instructionsRaw = own(providesRaw, 'instructions');
    if (instructionsRaw !== undefined) {
      if (!Array.isArray(instructionsRaw)) errors.push('provides.instructions must be an array.');
      else {
        if (instructionsRaw.length > MAX_INSTRUCTIONS) errors.push(`provides.instructions has more than ${MAX_INSTRUCTIONS} entries.`);
        const instructions: ExtensionInstruction[] = [];
        instructionsRaw.slice(0, MAX_INSTRUCTIONS).forEach((entry, i) => {
          const parsed = parseInstruction(entry, `provides.instructions[${i}]`, errors);
          if (parsed) instructions.push(parsed);
        });
        const seen = new Set<string>();
        for (const instruction of instructions) {
          const key = `${instruction.scope}:${instruction.file}`;
          if (seen.has(key)) errors.push(`provides.instructions writes "${instruction.file}" twice.`);
          seen.add(key);
        }
        if (instructions.length) provides.instructions = instructions;
      }
    }

    const scoutSourcesRaw = own(providesRaw, 'scoutSources');
    if (scoutSourcesRaw !== undefined) {
      if (!Array.isArray(scoutSourcesRaw)) errors.push('provides.scoutSources must be an array.');
      else {
        if (scoutSourcesRaw.length > MAX_SCOUT_SOURCES) errors.push(`provides.scoutSources has more than ${MAX_SCOUT_SOURCES} entries.`);
        const sources: ExtensionScoutSource[] = [];
        scoutSourcesRaw.slice(0, MAX_SCOUT_SOURCES).forEach((entry, i) => {
          const parsed = parseScoutSource(entry, `provides.scoutSources[${i}]`, errors);
          if (parsed) sources.push(parsed);
        });
        // The id is what Scout's enable/disable setting and a proposal's
        // `sources` citation both name. Two rows with one id are one switch
        // and one citation pointing at whichever url was registered last.
        const seen = new Set<string>();
        for (const source of sources) {
          if (seen.has(source.id)) errors.push(`provides.scoutSources declares "${source.id}" twice.`);
          seen.add(source.id);
        }
        if (sources.length) provides.scoutSources = sources;
      }
    }

    const storeSourcesRaw = own(providesRaw, 'storeSources');
    if (storeSourcesRaw !== undefined) {
      if (!Array.isArray(storeSourcesRaw)) errors.push('provides.storeSources must be an array.');
      else {
        if (storeSourcesRaw.length > MAX_STORE_SOURCES) errors.push(`provides.storeSources has more than ${MAX_STORE_SOURCES} entries.`);
        const sources: ExtensionStoreSource[] = [];
        storeSourcesRaw.slice(0, MAX_STORE_SOURCES).forEach((entry, i) => {
          const parsed = parseStoreSource(entry, `provides.storeSources[${i}]`, errors);
          if (parsed) sources.push(parsed);
        });
        const seen = new Set<string>();
        for (const source of sources) {
          if (seen.has(source.id)) errors.push(`provides.storeSources declares "${source.id}" twice.`);
          seen.add(source.id);
        }
        if (sources.length) provides.storeSources = sources;
      }
    }

    // An extension that declares nothing installs nothing, and an install
    // dialog with an empty consent list is a dialog that cannot be answered
    // honestly: there is no wording for "this will do nothing" that a person
    // would read as anything other than a bug.
    if (!Object.keys(provides).length && !errors.some((entry) => entry.startsWith('provides.'))) {
      errors.push('provides must declare at least one MCP server, skill, gate, instruction, Scout source or store source.');
    }
  }

  // Asked for and never read. Not an error — an author mid-edit has one of
  // these and does not need to be stopped — but the operator would otherwise be
  // asked to paste a secret that nothing in the extension consumes.
  const referenced = new Set<string>();
  for (const server of provides.mcpServers ?? []) {
    for (const spec of Object.values(server.env ?? {})) {
      if (spec.source === 'credential') referenced.add(spec.id);
    }
  }
  for (const credential of credentials) {
    if (!referenced.has(credential.id)) {
      warnings.push(`credentials declares "${credential.id}", which nothing in this extension reads.`);
    }
  }

  if (errors.length || id === undefined || label === undefined || version === undefined) {
    return { ok: false, manifest: null, errors, warnings };
  }
  return {
    ok: true,
    manifest: {
      schemaVersion: EXTENSION_SCHEMA_VERSION,
      id,
      label,
      version,
      ...(description ? { description } : {}),
      ...(publisher ? { publisher } : {}),
      ...(requires ? { requires } : {}),
      ...(credentials.length ? { credentials } : {}),
      provides,
    },
    errors,
    warnings,
  };
}

/* ── consent ──────────────────────────────────────────────────────────── */

/** An omitted scope is global; the two say the same thing and must read the same everywhere. */
function serverScope(server: ExtensionMcpServer): 'global' | 'project' {
  return server.scope ?? 'global';
}

function commandText(server: ExtensionMcpServer): string {
  return [server.command ?? '', ...(server.args ?? [])].join(' ').trim();
}

/**
 * Every line the operator must be shown before installing, in the operator's
 * words. Order: command, host, credential, file, note.
 *
 * One line per thing that outlives the click. A review gate command is in here
 * with the stdio servers, and not because the brief listed it: the gate text is
 * handed to a shell by `runCommand` from surfaces nobody is watching, so an
 * extension that could add one without showing it would be the single largest
 * thing this format could do to a machine with no line on the screen about it.
 */
/**
 * The artifact kinds this build of Wanigan actually installs.
 *
 * Exported because three surfaces were each about to decide it for themselves —
 * the installer, the authoring CLI's preview and the consent screen — and the
 * one thing worse than partial support is three answers about which part. When
 * gates and skills gain an installed path, this constant grows and every
 * surface changes with it.
 */
// 'scout-source' joined once extensions/store.ts applied it and its smoke suite proved the row.
export const APPLIED_ARTIFACT_KINDS: readonly ExtensionArtifactInfo['kind'][] = ['mcp-server', 'scout-source'];

const applies = (kind: ExtensionArtifactInfo['kind']) => APPLIED_ARTIFACT_KINDS.includes(kind);

export function extensionConsent(manifest: ExtensionManifest): ExtensionConsentLine[] {
  const commands: ExtensionConsentLine[] = [];
  const hosts: ExtensionConsentLine[] = [];
  const credentialLines: ExtensionConsentLine[] = [];
  const files: ExtensionConsentLine[] = [];
  const notes: ExtensionConsentLine[] = [];

  const servers = manifest.provides.mcpServers ?? [];
  for (const server of servers) {
    if (server.transport === 'stdio') {
      const literals = Object.entries(server.env ?? {})
        .filter((entry): entry is [string, { source: 'literal'; value: string }] => entry[1].source === 'literal')
        .map(([name, spec]) => `${name}=${spec.value}`);
      const suffix = literals.length ? ` It starts with ${literals.join(' and ')} in its environment.` : '';
      commands.push({
        kind: 'command',
        text: `The MCP server "${server.name}" runs ${commandText(server)} on this machine whenever a session uses it.${suffix}`,
      });
    } else if (server.url) {
      // The hostname, not the whole url: a path and a query string are where a
      // long url hides which machine it actually reaches.
      let host = server.url;
      try { host = new URL(server.url).host; } catch { host = server.url; }
      hosts.push({
        kind: 'host',
        text: `The MCP server "${server.name}" sends this machine's requests to ${host}.`,
      });
    }
  }

  // A Scout source is a url Wanigan will fetch on a schedule with nobody
  // watching, which is exactly what a `host` line is for. The line says when
  // as well as where: "sends requests to" would let a person picture a fetch
  // they trigger, and the truth is a fetch that happens every week on its own.
  // The hostname only, for the MCP line's reason — a path is where a long url
  // hides which machine it reaches.
  for (const source of manifest.provides.scoutSources ?? []) {
    let host = source.url;
    try { host = new URL(source.url).host; } catch { host = source.url; }
    hosts.push({
      kind: 'host',
      text: `Wanigan will fetch ${host} on Scout's weekly schedule to look for changes, for the source “${source.label}”.`,
    });
  }

  // A store source is fetched when the operator opens the store, not on a
  // schedule — so the line says "when you browse" rather than borrowing Scout's
  // "on its own". What it must not hide is that browsing a catalog is already a
  // request to a stranger's machine, before anything is installed.
  for (const source of manifest.provides.storeSources ?? []) {
    let host = source.url;
    try { host = new URL(source.url).host; } catch { host = source.url; }
    hosts.push({
      kind: 'host',
      text: `Wanigan will fetch ${host} when you browse the store, for the catalog “${source.label}”.`,
    });
  }

  // A gate's commands reach `$SHELL -lc`, which makes them the largest thing
  // this format can do to a machine — so they are never left off this screen.
  // But installing does not apply a gate in this build, and a consent line that
  // says a command "runs" when nothing will run it is the way a consent screen
  // stops being read: over-warning and under-warning damage it equally. The
  // line therefore states what the extension asks for and what installing
  // actually does, and it only becomes a command line when it becomes true.
  for (const gate of manifest.provides.gates ?? []) {
    for (const command of gate.commands) {
      if (applies('gate')) {
        commands.push({
          kind: 'command',
          text: `The review gate "${gate.label}" runs ${command} in your project every time that gate runs.`,
        });
      } else {
        notes.push({
          kind: 'note',
          text: `This extension asks for a review gate "${gate.label}" that would run ${command} in your project. Installing records it and does not run it: a gate is added in Changes, where its commands are approved on their own.`,
        });
      }
    }
  }

  for (const credential of manifest.credentials ?? []) {
    const destinations: string[] = [];
    for (const server of servers) {
      for (const [name, spec] of Object.entries(server.env ?? {})) {
        if (spec.source === 'credential' && spec.id === credential.id) destinations.push(`"${server.name}" as ${name}`);
      }
    }
    credentialLines.push({
      kind: 'credential',
      text: destinations.length
        ? `Wanigan will ask you for ${credential.label} and give it to the MCP server ${destinations.join(', and to ')}.`
        : `Wanigan will ask you for ${credential.label}, and nothing in this extension reads it.`,
    });
    if (!destinations.length) {
      notes.push({
        kind: 'note',
        text: `${credential.label} is asked for but never used, so installing this will not make it reach anything.`,
      });
    }
  }

  // Same rule for anything written to disk: a `file` line is a promise that a
  // file appears, so it is only made when installing makes one.
  for (const skill of manifest.provides.skills ?? []) {
    if (applies('skill')) {
      files.push({ kind: 'file', text: `The skill "${skill.name}" is written from ${skill.file}.` });
    } else {
      notes.push({
        kind: 'note',
        text: `This extension carries a skill "${skill.name}" in ${skill.file}. Installing records it and writes no file: a skill reaches an agent through Wanigan's own reversible projection, which is approved separately.`,
      });
    }
  }
  for (const instruction of manifest.provides.instructions ?? []) {
    if (applies('instruction')) {
      files.push({
        kind: 'file',
        text: instruction.scope === 'project'
          ? `The instruction "${instruction.title}" is written into the project you choose, from ${instruction.file}.`
          : `The instruction "${instruction.title}" is written into your personal instructions, from ${instruction.file}, for every project.`,
      });
    } else {
      notes.push({
        kind: 'note',
        text: `This extension carries an instruction "${instruction.title}" in ${instruction.file}. Installing records it and writes no file.`,
      });
    }
  }

  // Project scope is the one thing the manifest genuinely cannot answer: it
  // names no project, so a person reading "adds an MCP server" would otherwise
  // be entitled to believe it arrives everywhere.
  const projectServers = servers.filter((server) => serverScope(server) === 'project');
  if (projectServers.length) {
    notes.push({
      kind: 'note',
      text: projectServers.length === 1
        ? `The MCP server "${projectServers[0]!.name}" is added to the one project you choose while installing, and to no other.`
        : `${projectServers.length} of these MCP servers are added to the one project you choose while installing, and to no other.`,
    });
  }
  const projectInstructions = applies('instruction')
    ? (manifest.provides.instructions ?? []).filter((entry) => entry.scope === 'project')
    : [];
  if (projectInstructions.length) {
    notes.push({
      kind: 'note',
      text: `${projectInstructions.length === 1 ? 'One instruction file is' : `${projectInstructions.length} instruction files are`} written into the one project you choose while installing, and into no other.`,
    });
  }
  if (applies('gate') && manifest.provides.gates?.length) {
    notes.push({
      kind: 'note',
      text: 'Review gate commands are stored against the project you choose and run there, not in your other projects.',
    });
  }

  return [...commands, ...hosts, ...credentialLines, ...files, ...notes];
}

/* ── artifacts and attribution ────────────────────────────────────────── */

/**
 * What this manifest declares, before anything has been installed.
 *
 * `applied` is false and `note` is null on every row, and that is not a
 * placeholder to be tidied away: this function can see a manifest and nothing
 * else. Whether a row was written, and what stopped it, is a fact only the
 * installer holds, and a `true` invented here would be the exact lie
 * `ExtensionArtifactInfo` was shaped to prevent. `projectId` is null for the
 * same reason — a project-scoped declaration names no project until an operator
 * picks one.
 */
export function declaredArtifacts(manifest: ExtensionManifest): ExtensionArtifactInfo[] {
  const out: ExtensionArtifactInfo[] = [];
  const row = (kind: ExtensionArtifactInfo['kind'], ref: string, detail: string | null): ExtensionArtifactInfo =>
    ({ kind, ref, projectId: null, detail, applied: false, note: null });

  for (const server of manifest.provides.mcpServers ?? []) {
    out.push(row('mcp-server', server.name, server.transport === 'stdio' ? commandText(server) : (server.url ?? null)));
  }
  for (const skill of manifest.provides.skills ?? []) out.push(row('skill', skill.name, skill.file));
  for (const gate of manifest.provides.gates ?? []) {
    out.push(row('gate', gate.label, gate.commands.length === 1 ? '1 command' : `${gate.commands.length} commands`));
  }
  for (const instruction of manifest.provides.instructions ?? []) {
    out.push(row('instruction', instruction.title, instruction.file));
  }
  for (const source of manifest.provides.scoutSources ?? []) {
    out.push(row('scout-source', source.id, `${source.publisher} · ${source.label}`));
  }
  return out;
}

const OWNER_RE = /^extension:([a-z][a-z0-9]*(?:[._-][a-z0-9]+)*)@(.+)$/;

/**
 * The attribution written onto every row an extension creates.
 *
 * Uninstall removes what an extension owns, and without this it would be
 * guessing at which rows were its — a guess that either strands rows forever or
 * deletes somebody else's.
 */
export function extensionOwner(id: string, version: string): string {
  return `extension:${id}@${version}`;
}

/** The extension id in an owner string, or null: a row nobody stamped is nobody's. */
export function ownerExtensionId(owner: string | null | undefined): string | null {
  if (typeof owner !== 'string') return null;
  const match = OWNER_RE.exec(owner.trim());
  return match ? match[1]! : null;
}

/**
 * A stable, digest-able string of an MCP server exactly as the extension
 * declared it.
 *
 * Uninstall compares the live row against this: equal means the row is still
 * what was installed and Wanigan may remove it, different means a person edited
 * it and it stays. Both halves matter — silently reverting somebody's own edit
 * is the one outcome that would make uninstalling an extension something people
 * stop doing — so the comparison must not depend on anything that can change
 * without the server changing. JSON key order is exactly such a thing: the same
 * server read back from a config file is the same server, whatever order its
 * keys arrived in, which is why the env block is sorted and every field is
 * written in one fixed order here rather than stringified as it was received.
 *
 * `description` is deliberately not in it. It changes nothing about what runs
 * or where it connects, and including it would strand a row over a typo fix.
 */
export function mcpFingerprint(server: ExtensionMcpServer): string {
  const env = Object.entries(server.env ?? {})
    .map(([name, spec]): [string, string] =>
      [name, spec.source === 'credential' ? `credential:${spec.id}` : `literal:${spec.value}`])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return JSON.stringify({
    v: EXTENSION_SCHEMA_VERSION,
    name: server.name,
    transport: server.transport,
    scope: serverScope(server),
    command: server.command ?? null,
    args: server.args ?? [],
    url: server.url ?? null,
    env,
  });
}

/**
 * The Scout-source counterpart of `mcpFingerprint`, compared on uninstall the
 * same way and for the same reason: a row that still matches was installed and
 * may go, a row that differs was edited and stays.
 *
 * Every field is in it, `description` included. For an MCP server the
 * description changes nothing about what runs; for a Scout source it is the
 * sentence a person reads to decide whether to keep being polled, so a source
 * whose sentence was rewritten is no longer the one the extension declared.
 */
export function scoutFingerprint(source: ExtensionScoutSource): string {
  return JSON.stringify({
    v: EXTENSION_SCHEMA_VERSION,
    id: source.id,
    label: source.label,
    description: source.description,
    url: source.url,
    publisher: source.publisher,
    kind: source.kind,
  });
}
