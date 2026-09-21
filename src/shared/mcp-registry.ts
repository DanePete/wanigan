import { validateExtensionManifest } from './extension-manifest.ts';
import type {
  ExtensionCredentialRequest, ExtensionEnvValue, ExtensionManifest, ExtensionMcpServer,
} from './extension-manifest.ts';

/**
 * The official MCP Registry (registry.modelcontextprotocol.io), read as a store
 * catalog and translated into extension manifests.
 *
 * Everything here is pure. It takes the registry's JSON as untrusted input and
 * returns either a manifest Wanigan's own validator has already accepted, or a
 * sentence saying why an entry cannot be offered. It never fetches: the main
 * process does that, and lists the host in the egress report.
 *
 * The renderer only ever holds a `StoreEntry` — a description to show, never a
 * manifest to install. Installing sends a registry name and version back to the
 * main process, which fetches that exact version itself and translates it here
 * again. A renderer that lied about an entry changes what it displays and
 * nothing it installs.
 *
 * What the registry does and does not vouch for is the fact every screen that
 * shows its entries has to carry: it verifies that a publisher controls the
 * namespace a name is published under. It does not review what a server does.
 * Neither does this file, and neither does the consent screen — which is why
 * the consent screen shows the exact command.
 */

/** How an entry would run once installed, or why it cannot be offered. */
export type StoreInstall =
  | { kind: 'npm' | 'pypi' | 'oci'; runtime: 'npx' | 'uvx' | 'docker'; package: string; version: string }
  | { kind: 'remote'; url: string }
  | { kind: 'unsupported'; reason: string };

export type StoreEntry = {
  sourceId: string;
  /** The registry's own key, `<reverse-DNS namespace>/<server>`. Everything else is derived from it. */
  name: string;
  /** The part before the slash: what the registry verified the publisher controls. */
  namespace: string;
  title: string;
  description: string;
  /** The registry's version string, exactly as published. */
  version: string;
  /** The manifest version installing this would record, for comparing against what is installed. */
  installsAs: string;
  /** The extension id installing this would create — stable across versions, so a newer one is an update. */
  extensionId: string;
  install: StoreInstall;
  /** What installing would ask the operator for: every secret, and any required setting without a default. */
  asks: string[];
  deprecated: boolean;
  publishedAt: number | null;
  updatedAt: number | null;
  websiteUrl: string | null;
  repositoryUrl: string | null;
};

export type StorePage = {
  entries: StoreEntry[];
  nextCursor: string | null;
  /** Rows the registry returned that were not shaped like a server and were left out. Counted, never hidden. */
  dropped: number;
  /** Names the publisher withdrew. An incremental sync removes these from the local index. */
  withdrawn: string[];
};

/** A catalog the store can browse, as the renderer is allowed to see it: the host, never a path to fetch. */
export type StoreSourceInfo = {
  /** `<extension id>:<source id>` — unique across extensions, and the only handle the renderer sends back. */
  key: string;
  extensionId: string;
  label: string;
  description: string;
  publisher: string;
  host: string;
};

/** An installed store extension with a newer version published. */
export type StoreUpdate = { sourceKey: string; extensionId: string; name: string; title: string; installed: string; latest: string };

export type StoreTranslation =
  | { ok: true; entry: StoreEntry; manifest: ExtensionManifest }
  | { ok: false; entry: StoreEntry | null; reason: string };

/* ── limits ───────────────────────────────────────────────────────────── */

const MAX_PAGE_ENTRIES = 100;
const MAX_NAME = 200;
const MAX_CURSOR = 500;
const MAX_TITLE = 80;
const MAX_DESCRIPTION = 500;
const MAX_ARG = 1_000;
const MAX_SERVER_NAME = 48;
const MAX_ID = 64;
/*
 * An extension id is clipped well short of the manifest's 64 because every
 * credential it asks for must be named `<extension id>.<name>` — the rule that
 * stops one extension reading another's secret — and that whole string has to
 * fit in 64 as well.
 */
const MAX_EXTENSION_ID = 44;

/** `<namespace>/<server>`, the shape the registry itself enforces on publish. */
const REGISTRY_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9.-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Safe to splice into `pkg@version`: no whitespace, no leading dash, nothing a CLI reads as a flag. */
const REGISTRY_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/;
/** Must stay identical to VERSION_RE in extension-manifest.ts. The validator below is the backstop if it drifts. */
const MANIFEST_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/*
 * Package identifiers per registry. None may begin with a dash: an identifier is
 * spliced into argv, and one that reads as a flag (`--network=host`) would turn
 * a package name into an option passed to npx, uvx or docker.
 */
const NPM_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const PYPI_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/**
 * A container image reference: `[host[:port]/]path[/path…][:tag][@sha256:digest]`.
 * Captures the name, the tag and the digest separately, because the registry
 * publishes the pin inside the identifier (`ghcr.io/acme/tool:0.10.0`) with
 * `version` empty — reading it as one opaque string refused every container.
 */
const OCI_REF_RE = /^((?:[A-Za-z0-9][A-Za-z0-9.-]*(?::[0-9]{1,5})?\/)?[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*)(?::([A-Za-z0-9_][A-Za-z0-9_.-]{0,127}))?(?:@(sha256:[a-f0-9]{64}))?$/;

/**
 * Leaves that say nothing about the server. `ac.inference.sh/mcp` installing as
 * a server named "mcp" is a tool id (`mcp__mcp__run`) nobody can read, and the
 * first of many that would collide on it.
 */
const GENERIC_LEAVES = new Set(['mcp', 'server', 'mcp-server', 'mcpserver', 'api', 'remote', 'main', 'app']);

/* ── reading untrusted JSON ───────────────────────────────────────────── */

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function own(value: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
}

/** A single-line string within `max`, or null. Refused outright when too long: used for keys. */
function field(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) return null;
  return text;
}

/** Display text: whitespace folded to single spaces, other control bytes removed, clipped rather than refused. */
function prose(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const text = value.replace(/[\t\r\n]+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '').replace(/ {2,}/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function httpsUrl(value: unknown): string | null {
  const text = field(value, 2_000);
  if (!text) return null;
  try {
    const parsed = new URL(text);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password ? text : null;
  } catch { return null; }
}

function time(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

/* ── deterministic names ──────────────────────────────────────────────── */

/** FNV-1a, 32 bits. Not security: a stable, dependency-free suffix that keeps a clipped id unique. */
function fnv(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Lowercase, separators collapsed, so the result satisfies the manifest's id pattern. */
function slug(text: string): string {
  return text.toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/[._-]{2,}/g, (run) => run[0]!)
    .replace(/^[^a-z]+/, '')
    .replace(/[._-]+$/, '');
}

function clip(id: string, key: string, max: number): string {
  if (id.length <= max) return id;
  return `${id.slice(0, max - 9).replace(/[._-]+$/, '')}-${fnv(key)}`;
}

/**
 * The extension id for a registry name. It depends on the name alone — never
 * the version — so installing a newer version of the same server replaces the
 * installed extension instead of sitting beside it, and the consent dialog
 * reads "update".
 */
export function extensionIdFor(name: string): string {
  return clip(`mcp.${slug(name.replace('/', '.'))}`, name, MAX_EXTENSION_ID);
}

function publisherIdFor(namespace: string): string {
  const id = slug(namespace) || 'publisher';
  return clip(id, namespace, MAX_ID);
}

function serverNameFor(name: string, title: string): string {
  const leaf = name.slice(name.indexOf('/') + 1);
  const clean = (text: string) => text.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/[-_]{2,}/g, (run) => run[0]!)
    .replace(/^[-_]+/, '').replace(/[-_]+$/, '');
  let base = clean(leaf);
  if (GENERIC_LEAVES.has(base.toLowerCase()) && clean(title)) base = clean(title);
  base = base.slice(0, MAX_SERVER_NAME).replace(/[-_]+$/, '');
  return base || 'server';
}

/**
 * The manifest wants `x.y.z`. Most registry versions are; the ones that are not
 * (`v1.2`, `2026.09.01`, `latest`) are recorded as a prerelease of 0.0.0 so the
 * id stays stable and the original string still pins the package.
 */
export function manifestVersion(version: string): string {
  if (MANIFEST_VERSION_RE.test(version)) return version;
  const bare = version.replace(/^v(?=\d)/, '');
  if (MANIFEST_VERSION_RE.test(bare)) return bare;
  const tail = version.replace(/[^0-9A-Za-z.-]+/g, '-').replace(/^[^0-9A-Za-z]+/, '').slice(0, 50).replace(/[.-]+$/, '');
  return tail ? `0.0.0-${tail}` : '0.0.0';
}

/**
 * `<extension id>.<variable>`, lowercased. The manifest refuses a credential
 * named outside the extension's own id, so this is not a style choice: it is
 * what makes the secret this extension's alone.
 */
function credentialIdFor(envName: string, extensionId: string, taken: Set<string>): string {
  const room = MAX_ID - extensionId.length - 1;
  let leaf = envName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/_{2,}/g, '_').replace(/^[^a-z0-9]+/, '').replace(/_+$/, '') || 'value';
  if (leaf.length > room) leaf = `${leaf.slice(0, room - 7).replace(/_+$/, '')}_${fnv(envName).slice(0, 6)}`;
  let id = `${extensionId}.${leaf}`;
  for (let n = 2; taken.has(id); n += 1) id = `${extensionId}.${leaf.slice(0, room - 3)}_${n}`;
  taken.add(id);
  return id;
}

/* ── the registry's server.json ───────────────────────────────────────── */

type Server = {
  name: string;
  namespace: string;
  title: string;
  description: string;
  version: string;
  websiteUrl: string | null;
  repositoryUrl: string | null;
  packages: Record<string, unknown>[];
  remotes: Record<string, unknown>[];
  deprecated: boolean;
  deleted: boolean;
  publishedAt: number | null;
  updatedAt: number | null;
};

/** One `{ server, _meta }` row, or null when it is not shaped like a server at all. */
function readRow(raw: unknown): Server | null {
  if (!isObject(raw)) return null;
  const server = own(raw, 'server');
  if (!isObject(server)) return null;
  const name = field(own(server, 'name'), MAX_NAME);
  const version = field(own(server, 'version'), 100);
  if (!name || !REGISTRY_NAME_RE.test(name) || !version || !REGISTRY_VERSION_RE.test(version)) return null;

  const metaRoot = own(raw, '_meta');
  const official = isObject(metaRoot) ? own(metaRoot, 'io.modelcontextprotocol.registry/official') : undefined;
  const meta = isObject(official) ? official : {};
  const status = own(meta, 'status');

  const repository = own(server, 'repository');
  const listOf = (key: string) => {
    const value = own(server, key);
    return Array.isArray(value) ? value.filter(isObject).slice(0, 20) : [];
  };
  return {
    name,
    namespace: name.slice(0, name.indexOf('/')),
    title: prose(own(server, 'title'), MAX_TITLE) || name.slice(name.indexOf('/') + 1),
    description: prose(own(server, 'description'), MAX_DESCRIPTION),
    version,
    websiteUrl: httpsUrl(own(server, 'websiteUrl')),
    repositoryUrl: isObject(repository) ? httpsUrl(own(repository, 'url')) : null,
    packages: listOf('packages'),
    remotes: listOf('remotes'),
    deprecated: status === 'deprecated',
    deleted: status === 'deleted',
    publishedAt: time(own(meta, 'publishedAt')),
    updatedAt: time(own(meta, 'updatedAt')),
  };
}

/* ── planning an install ──────────────────────────────────────────────── */

type Plan =
  | { ok: true; install: StoreInstall; server: ExtensionMcpServer; credentials: ExtensionCredentialRequest[]; asks: string[] }
  | { ok: false; reason: string };

/**
 * Environment variables a package declares. A secret, or a required setting
 * with no default, becomes a credential the operator is asked for at install —
 * the only channel Wanigan has for a value it must not invent. A fixed value or
 * a default is passed through literally. Anything optional with neither is left
 * out, because the server does not need it and asking would be noise.
 */
function planEnv(raw: unknown, extensionId: string): {
  ok: true; env: Record<string, ExtensionEnvValue>; credentials: ExtensionCredentialRequest[]; asks: string[];
} | { ok: false; reason: string } {
  const env: Record<string, ExtensionEnvValue> = {};
  const credentials: ExtensionCredentialRequest[] = [];
  const asks: string[] = [];
  const taken = new Set<string>();
  const list = Array.isArray(raw) ? raw.filter(isObject) : [];
  for (const variable of list) {
    const name = field(own(variable, 'name'), 128);
    if (!name || !ENV_NAME_RE.test(name)) return { ok: false, reason: 'It declares an environment variable whose name no shell accepts.' };
    const secret = own(variable, 'isSecret') === true;
    const required = own(variable, 'isRequired') === true;
    const fixed = field(own(variable, 'value'), MAX_ARG);
    const fallback = field(own(variable, 'default'), MAX_ARG);
    const literal = fixed ?? fallback;
    if (!secret && literal && !literal.includes('{')) {
      env[name] = { source: 'literal', value: literal };
    } else if (secret || required) {
      const id = credentialIdFor(name, extensionId, taken);
      credentials.push({ id, label: name.slice(0, 80), help: prose(own(variable, 'description'), 500) || undefined });
      env[name] = { source: 'credential', id };
      asks.push(name);
    }
  }
  for (const credential of credentials) if (credential.help === undefined) delete credential.help;
  return { ok: true, env, credentials, asks };
}

/** Literal package arguments only. A required one waiting for a value Wanigan cannot ask for is a refusal. */
function planArgs(raw: unknown): { ok: true; args: string[] } | { ok: false; reason: string } {
  const args: string[] = [];
  const list = Array.isArray(raw) ? raw.filter(isObject) : [];
  for (const arg of list) {
    const required = own(arg, 'isRequired') === true;
    const value = field(own(arg, 'value'), MAX_ARG) ?? field(own(arg, 'default'), MAX_ARG);
    const usable = value !== null && !value.includes('{');
    if (own(arg, 'type') === 'named') {
      const flag = field(own(arg, 'name'), 200);
      if (!flag) return { ok: false, reason: 'It declares a named argument with no name.' };
      if (usable) args.push(flag, value);
      else if (required && value === null) args.push(flag);
      else if (required) return { ok: false, reason: `It needs a value for ${flag} that Wanigan cannot ask for yet.` };
    } else if (usable) {
      args.push(value);
    } else if (required) {
      return { ok: false, reason: 'It needs a command-line value that Wanigan cannot ask for yet.' };
    }
  }
  return { ok: true, args };
}

function planPackage(pkg: Record<string, unknown>, server: Server, serverName: string): Plan {
  const transport = own(pkg, 'transport');
  if (!isObject(transport) || own(transport, 'type') !== 'stdio') {
    return { ok: false, reason: 'Its package runs as a network service rather than over stdio.' };
  }
  const type = own(pkg, 'registryType');
  const identifier = field(own(pkg, 'identifier'), 300);
  const declared = field(own(pkg, 'version'), 100);
  const version = declared && REGISTRY_VERSION_RE.test(declared) ? declared : null;
  if (!identifier) return { ok: false, reason: 'Its package has no identifier.' };
  // Unpinned, `npx -y pkg` runs whatever is newest on every launch: the code
  // changes while the approved digest stays the same. npm and PyPI must carry a
  // version; a container carries its pin in the image reference, checked below.
  const unpinned: Plan = { ok: false, reason: 'Its package does not pin a version, so what runs could change after you approve it.' };
  if ((type === 'npm' || type === 'pypi') && !version) return unpinned;

  const runtimeArgs = own(pkg, 'runtimeArguments');
  if (Array.isArray(runtimeArgs) && runtimeArgs.some((a) => isObject(a) && own(a, 'isRequired') === true)) {
    return { ok: false, reason: 'It needs runtime options that Wanigan cannot ask for yet.' };
  }
  const args = planArgs(own(pkg, 'packageArguments'));
  if (!args.ok) return args;
  const env = planEnv(own(pkg, 'environmentVariables'), extensionIdFor(server.name));
  if (!env.ok) return env;

  let command: string;
  let argv: string[];
  let install: StoreInstall;
  if (type === 'npm') {
    if (!NPM_RE.test(identifier)) return { ok: false, reason: 'Its npm package name is not one npm accepts.' };
    command = 'npx';
    argv = ['-y', `${identifier}@${version!}`, ...args.args];
    install = { kind: 'npm', runtime: 'npx', package: identifier, version: version! };
  } else if (type === 'pypi') {
    if (!PYPI_RE.test(identifier)) return { ok: false, reason: 'Its PyPI package name is not one PyPI accepts.' };
    command = 'uvx';
    argv = [`${identifier}==${version!}`, ...args.args];
    install = { kind: 'pypi', runtime: 'uvx', package: identifier, version: version! };
  } else if (type === 'oci') {
    const ref = OCI_REF_RE.exec(identifier);
    if (!ref) return { ok: false, reason: 'Its container image name is not one Docker accepts.' };
    const [, image, tag, digest] = ref as unknown as [string, string, string | undefined, string | undefined];
    // A digest is immutable; a release tag is the publisher's pin. `latest`, or
    // no tag and no version, means whatever the image is on the day it is pulled.
    const pinTag = tag ?? (version && /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(version) ? version : undefined);
    if (!digest && (!pinTag || pinTag === 'latest')) return unpinned;
    const reference = `${image}${pinTag ? `:${pinTag}` : ''}${digest ? `@${digest}` : ''}`;
    // `-e NAME` with no value hands the variable through from the environment
    // Wanigan launches docker with, so a secret never appears in argv.
    const envFlags = Object.keys(env.env).flatMap((name) => ['-e', name]);
    command = 'docker';
    argv = ['run', '-i', '--rm', ...envFlags, reference, ...args.args];
    install = { kind: 'oci', runtime: 'docker', package: image, version: digest ?? pinTag! };
  } else {
    return { ok: false, reason: `It ships as a ${typeof type === 'string' ? type : 'kind of'} package, which Wanigan does not run yet.` };
  }
  if (argv.length > 50) return { ok: false, reason: 'It needs more arguments than an extension can carry.' };

  return {
    ok: true,
    install,
    asks: env.asks,
    credentials: env.credentials,
    server: {
      name: serverName,
      transport: 'stdio',
      command,
      args: argv,
      description: `${server.name} ${server.version}, from the official MCP Registry.`,
      scope: 'global',
      ...(Object.keys(env.env).length ? { env: env.env } : {}),
    },
  };
}

function planRemote(remote: Record<string, unknown>, server: Server, serverName: string): Plan {
  const type = own(remote, 'type');
  // Wanigan's http servers speak streamable HTTP. SSE is the older transport and
  // a different wire protocol; offering it would install a server that never connects.
  if (type !== 'streamable-http') return { ok: false, reason: 'Its hosted endpoint uses the older SSE transport, which Wanigan does not speak.' };
  const url = httpsUrl(own(remote, 'url'));
  if (!url || url.includes('{')) return { ok: false, reason: 'Its hosted endpoint is not a fixed https address.' };
  const headers = own(remote, 'headers');
  if (Array.isArray(headers) && headers.some((h) => isObject(h) && (own(h, 'isRequired') === true || own(h, 'isSecret') === true))) {
    return { ok: false, reason: 'Its hosted endpoint needs a request header, which Wanigan cannot set for a store install yet.' };
  }
  return {
    ok: true,
    install: { kind: 'remote', url },
    asks: [],
    credentials: [],
    server: {
      name: serverName,
      transport: 'http',
      url,
      description: `${server.name} ${server.version}, from the official MCP Registry.`,
      scope: 'global',
    },
  };
}

/**
 * A package that runs locally is preferred over a hosted endpoint when both
 * exist: a local server's traffic stays on this machine unless it chooses
 * otherwise, while a hosted one receives every tool call by construction.
 */
function plan(server: Server): Plan {
  const serverName = serverNameFor(server.name, server.title);
  let first: string | null = null;
  for (const pkg of server.packages) {
    const planned = planPackage(pkg, server, serverName);
    if (planned.ok) return planned;
    first ??= planned.reason;
  }
  for (const remote of server.remotes) {
    const planned = planRemote(remote, server, serverName);
    if (planned.ok) return planned;
    first ??= planned.reason;
  }
  return { ok: false, reason: first ?? 'It declares neither a package nor a hosted endpoint.' };
}

function entryOf(server: Server, sourceId: string, planned: Plan): StoreEntry {
  return {
    sourceId,
    name: server.name,
    namespace: server.namespace,
    title: server.title,
    description: server.description,
    version: server.version,
    installsAs: manifestVersion(server.version),
    extensionId: extensionIdFor(server.name),
    install: planned.ok ? planned.install : { kind: 'unsupported', reason: planned.reason },
    asks: planned.ok ? planned.asks : [],
    deprecated: server.deprecated,
    publishedAt: server.publishedAt,
    updatedAt: server.updatedAt,
    websiteUrl: server.websiteUrl,
    repositoryUrl: server.repositoryUrl,
  };
}

/* ── public entry points ──────────────────────────────────────────────── */

/**
 * One registry row as a manifest Wanigan's validator has accepted.
 *
 * The validator is the last step, not a formality: every name and argument
 * above is built to satisfy it, and if a rule there ever tightens past what
 * this file produces, the entry becomes "unsupported" with the validator's own
 * reasons rather than a manifest that fails at install.
 */
export function translateRegistryEntry(raw: unknown, sourceId: string): StoreTranslation {
  const server = readRow(raw);
  if (!server) return { ok: false, entry: null, reason: 'The catalog returned something that is not shaped like a server.' };
  if (server.deleted) return { ok: false, entry: null, reason: `The publisher has withdrawn ${server.name} from the registry.` };
  const planned = plan(server);
  const entry = entryOf(server, sourceId, planned);
  if (!planned.ok) return { ok: false, entry, reason: planned.reason };

  const manifest: ExtensionManifest = {
    schemaVersion: 1,
    id: entry.extensionId,
    label: server.title.slice(0, 80),
    version: entry.installsAs,
    ...(server.description ? { description: server.description } : {}),
    publisher: {
      id: publisherIdFor(server.namespace),
      name: server.namespace.slice(0, 80),
      ...(server.websiteUrl ?? server.repositoryUrl ? { url: (server.websiteUrl ?? server.repositoryUrl)!.slice(0, 500) } : {}),
    },
    ...(planned.credentials.length ? { credentials: planned.credentials } : {}),
    provides: { mcpServers: [planned.server] },
  };
  const checked = validateExtensionManifest(manifest);
  if (!checked.ok || !checked.manifest) {
    const reason = `Wanigan could not express it as a valid extension: ${checked.errors.join(' ')}`;
    return { ok: false, entry: { ...entry, install: { kind: 'unsupported', reason } }, reason };
  }
  return { ok: true, entry, manifest: checked.manifest };
}

/**
 * One page of `GET /v0.1/servers`. A malformed row is dropped and counted; a
 * withdrawn one is left out silently, because the registry itself no longer
 * lists it as available. Anything that is not a page at all is an error.
 */
export function parseRegistryPage(raw: unknown, sourceId: string): StorePage {
  if (!isObject(raw) || !Array.isArray(own(raw, 'servers'))) {
    throw new Error('The catalog did not return a list of servers.');
  }
  const rows = (own(raw, 'servers') as unknown[]).slice(0, MAX_PAGE_ENTRIES);
  const entries: StoreEntry[] = [];
  const withdrawn: string[] = [];
  let dropped = 0;
  for (const row of rows) {
    const translated = translateRegistryEntry(row, sourceId);
    if (translated.entry) entries.push(translated.entry);
    else {
      const gone = readRow(row);
      if (gone?.deleted) withdrawn.push(gone.name);
      else dropped += 1;
    }
  }
  const metadata = own(raw, 'metadata');
  const nextCursor = isObject(metadata) ? field(own(metadata, 'nextCursor'), MAX_CURSOR) : null;
  return { entries, nextCursor, dropped, withdrawn };
}

/** Whether a string is a registry name the main process may put in a request path. */
export function isRegistryName(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_NAME && REGISTRY_NAME_RE.test(value);
}

/** Whether a string is a registry version the main process may put in a request path. */
export function isRegistryVersion(value: unknown): value is string {
  return typeof value === 'string' && REGISTRY_VERSION_RE.test(value);
}
