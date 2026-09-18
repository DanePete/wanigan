import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { app } from 'electron';
import { db } from '../db';
import { removeServer, setServerEnabled, upsertServer } from '../mcp/registry';
import {
  EXTENSION_MANIFEST_FILE, declaredArtifacts, extensionConsent, extensionOwner,
  mcpFingerprint, ownerExtensionId, scoutFingerprint, validateExtensionManifest,
} from '../../shared/extension-manifest';
import type {
  ExtensionManifest, ExtensionMcpServer, ExtensionScoutSource, ExtensionScoutSourceKind,
} from '../../shared/extension-manifest';
import type {
  ExtensionArtifactInfo, ExtensionInfo, ExtensionInspection, ExtensionOrigin,
  ExtensionRemoval, ExtensionStatus,
} from '../../shared/types';

/**
 * Installing an extension: reading a directory, applying what Wanigan has a
 * real path for, and taking back only what it still owns.
 *
 * Nothing here loads code. An extension is a manifest plus the files it points
 * at, and it reaches two surfaces: the MCP registry and Improvement Scout's
 * source table. Every other declaration is listed with `applied: false` and a
 * note naming the consented path it still needs. A partial installer that says
 * so is honest; one that writes a skill file out of a stranger's manifest
 * because the manifest asked is the thing this refuses to be.
 *
 * A built-in extension goes through exactly this file. It has no directory and
 * no private path — `installBuiltinExtension` hands a manifest to the same
 * transaction a folder install runs — so the defaults Wanigan ships are proof
 * the extension point works rather than a special case beside it.
 *
 * The tables are `plugins` and `plugin_artifacts` while the concept is called
 * an extension everywhere else: renaming a shipped table is a destructive
 * migration bought for nothing a user can see. Noted once, here.
 */

/** The same ceiling provider-packs.ts puts on a manifest, for the same reason. */
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_PATH_CHARS = 4096;
const SHA256_RE = /^[0-9a-f]{64}$/;
/** Mirrors the manifest's id rule, so an id this file accepts is one that could exist. */
const EXTENSION_ID_RE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const EXPORT_VERSION = '1.0.0';

/* ── what v1 does not apply, and what it would take ──────────────────── */

const SKILL_NOTE =
  'Declared, not installed. A skill is a SKILL.md under .claude/skills or .agents/skills, and Wanigan writes ' +
  'one only as a reversible projection of an approved knowledge item through the review inbox — never straight ' +
  'out of a manifest. Read the file in the extension directory; nothing was written.';

const GATE_NOTE =
  'Declared, not installed. A gate’s commands run a shell on this machine, so they go through ' +
  'review.saveRecipeWithConsent, which needs a window and a person reading the exact command lines. There is no ' +
  'window during an install, so the commands are shown and left unsaved.';

const INSTRUCTION_NOTE =
  'Declared, not installed. An instruction projects into CLAUDE.md, AGENTS.md or a rules file inside a ' +
  'repository, and Wanigan writes those only through the review inbox’s projection, which pins the base hash so ' +
  'the write can be undone. An installer cannot promise that.';

/**
 * Why a declared MCP server cannot be registered as declared.
 *
 * Both are gaps in Wanigan rather than in the manifest, so the note names what
 * Wanigan is missing rather than blaming the author. Registering the server
 * anyway — re-scoped to every repository, or with an argument the stored
 * command line cannot carry back out — is the tempting failure: the operator
 * would get a server that is not the one they read and approved.
 */
function mcpUnsupported(server: ExtensionMcpServer): string | null {
  if (server.scope === 'project') {
    return `Declared for one project, and an install chooses no project. Registering it globally would hand ` +
      `"${server.name}" to every repository instead of one, so it was left unregistered. Add it by hand in ` +
      'Settings → Connections → MCP servers, scoped to the project you mean.';
  }
  // The registry stores args as one string and splits them back out with a
  // shell-like splitter. A double quote inside an argument cannot survive that
  // round trip, so the argv the agent's CLI would spawn is not the argv that
  // was declared — and a silently different command line is exactly what the
  // MCP trust digest exists to prevent.
  const quoted = (server.args ?? []).find((arg) => arg.includes('"'));
  if (quoted !== undefined) {
    return `An argument contains a double quote (${quoted}), which Wanigan’s stored command line cannot carry ` +
      'back out unchanged. Nothing was registered rather than registering a different command.';
  }
  return null;
}

/* ── rows ────────────────────────────────────────────────────────────── */

type PluginRow = {
  id: string; label: string; version: string; origin: string; source_path: string | null;
  manifest_json: string; manifest_sha256: string; trusted_sha256: string | null;
  enabled: number; installed_at: number; updated_at: number;
};

type ServerRow = {
  id: string; project_id: string | null; name: string; transport: string;
  command: string | null; args: string | null; url: string | null;
  enabled: number; env: string | null; owner: string | null;
};

type ArtifactRow = {
  id: string; plugin_id: string; kind: string; ref: string; project_id: string | null;
  detail: string | null; fingerprint: string | null; created_at: number; removed_at: number | null;
};

/**
 * One row of `improvement_scout_sources`. `owner` is NULL on the rows db.ts
 * seeded before extensions existed and on any row an uninstall disowned;
 * `last_*` are what Scout recorded the last time it read the page, and are the
 * operator's history rather than anything an install may rewrite.
 */
type SourceRow = {
  id: string; label: string; description: string; url: string; publisher: string; kind: string;
  official: number; enabled: number; owner: string | null;
  created_at: number; updated_at: number;
  last_checked_at: number | null; last_status: string | null; last_detail: string | null;
};

function pluginRow(id: string): PluginRow | null {
  return (db().prepare('SELECT * FROM plugins WHERE id = ?').get(id) as PluginRow | undefined) ?? null;
}

function serverRowsNamed(name: string): ServerRow[] {
  return db().prepare('SELECT * FROM mcp_servers WHERE name = ? ORDER BY project_id IS NOT NULL')
    .all(name) as ServerRow[];
}

function sourceRowById(id: string): SourceRow | null {
  return (db().prepare('SELECT * FROM improvement_scout_sources WHERE id = ?').get(id) as SourceRow | undefined) ?? null;
}

/** The `url` column is UNIQUE, so at most one row can hold a page. */
function sourceRowByUrl(url: string): SourceRow | null {
  return (db().prepare('SELECT * FROM improvement_scout_sources WHERE url = ?').get(url) as SourceRow | undefined) ?? null;
}

/**
 * Rows this extension owns, matched through `ownerExtensionId` rather than on
 * the owner string itself: the stamp carries the version that installed the
 * row, so an update to 1.1.0 would otherwise disown everything 1.0.0 applied.
 */
function ownedRows(extensionId: string): ServerRow[] {
  const rows = db().prepare('SELECT * FROM mcp_servers WHERE owner IS NOT NULL ORDER BY name').all() as ServerRow[];
  return rows.filter((row) => ownerExtensionId(row.owner) === extensionId);
}

function ownedSourceRows(extensionId: string): SourceRow[] {
  const rows = db().prepare('SELECT * FROM improvement_scout_sources WHERE owner IS NOT NULL ORDER BY id')
    .all() as SourceRow[];
  return rows.filter((row) => ownerExtensionId(row.owner) === extensionId);
}

/**
 * How many pieces of Scout evidence cite a source. The evidence table keeps its
 * source (`ON DELETE RESTRICT`), because an excerpt whose page nobody can name
 * is not evidence — so a cited source cannot be deleted, and uninstall has to
 * know that before it tries rather than surfacing a constraint error.
 */
function evidenceCiting(sourceId: string): number {
  const row = db().prepare('SELECT COUNT(*) AS n FROM improvement_scout_evidence WHERE source_id = ?')
    .get(sourceId) as { n: number };
  return row.n;
}

function liveArtifacts(extensionId: string, kind?: string): ArtifactRow[] {
  const rows = db().prepare(
    'SELECT * FROM plugin_artifacts WHERE plugin_id = ? AND removed_at IS NULL ORDER BY created_at'
  ).all(extensionId) as ArtifactRow[];
  return kind ? rows.filter((row) => row.kind === kind) : rows;
}

/* ── argument round trip ─────────────────────────────────────────────── */

/**
 * A copy of the splitter in mcp/registry.ts, kept here because that module does
 * not export it and a fingerprint has to be computed the same way on both sides
 * of an install. If the two drift, uninstall stops recognising its own rows and
 * starts reporting them as edited by the operator.
 */
function splitArgs(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** Quote anything the splitter above would otherwise tear into two arguments. */
function joinArgs(args: readonly string[]): string {
  return args.map((arg) => (/[\s'"]/.test(arg) ? `"${arg}"` : arg)).join(' ');
}

/**
 * The environment stored on a row, read back as the manifest declared it.
 *
 * `complete` is false when an entry cannot be expressed as a declaration again.
 * Nothing in Wanigan writes such a row today, but the column is JSON in a
 * database file, and a half-understood environment must never be re-emitted as
 * though it were the whole one.
 */
function parseServerEnv(raw: string | null): { env: ExtensionMcpServer['env']; complete: boolean } {
  if (!raw) return { env: undefined, complete: true };
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { env: undefined, complete: false }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { env: undefined, complete: false };

  const env: NonNullable<ExtensionMcpServer['env']> = {};
  let complete = true;
  for (const [destination, value] of Object.entries(parsed as Record<string, unknown>)) {
    const entry = value as { source?: unknown; id?: unknown; value?: unknown } | null;
    if (entry && entry.source === 'credential' && typeof entry.id === 'string') {
      env[destination] = { source: 'credential', id: entry.id };
    } else if (entry && entry.source === 'literal' && typeof entry.value === 'string') {
      env[destination] = { source: 'literal', value: entry.value };
    } else {
      complete = false;
    }
  }
  return { env: Object.keys(env).length ? env : undefined, complete };
}

/**
 * The declared shape of a server as it stands in the database right now.
 *
 * Both halves of the ownership test go through here: the fingerprint recorded
 * at install is computed from the row that was written, and the one compared at
 * uninstall from the row as it is. Anything the row cannot hold — a description
 * — is absent from both, so it cannot make a fingerprint differ by itself.
 */
function shapeOf(row: ServerRow): ExtensionMcpServer {
  const { env } = parseServerEnv(row.env);
  return {
    name: row.name,
    transport: row.transport === 'http' ? 'http' : 'stdio',
    ...(row.command ? { command: row.command } : {}),
    ...(row.args ? { args: splitArgs(row.args) } : {}),
    ...(row.url ? { url: row.url } : {}),
    scope: row.project_id ? 'project' : 'global',
    ...(env ? { env } : {}),
  };
}

function liveFingerprint(row: ServerRow): string {
  return mcpFingerprint(shapeOf(row));
}

function describeServer(row: ServerRow): string {
  return row.transport === 'http'
    ? `http · ${row.url ?? ''}`.trim()
    : `stdio · ${[row.command ?? '', row.args ?? ''].join(' ').trim()}`;
}

/* ── scout sources as the table holds them ───────────────────────────── */

/**
 * The declared shape of a Scout source as it stands in the table right now.
 * Every column the manifest can set is in it, so the fingerprint of a freshly
 * written row equals the fingerprint of the declaration that wrote it.
 *
 * `kind` is carried across unchecked on purpose. A row whose kind is not one of
 * the three the manifest allows was edited by something other than this file,
 * and the fingerprint it produces matches no declaration — which is the right
 * answer, since "edited, keep it" is what uninstall does with a mismatch.
 */
function sourceShapeOf(row: SourceRow): ExtensionScoutSource {
  return {
    id: row.id,
    label: row.label,
    description: row.description,
    url: row.url,
    publisher: row.publisher,
    kind: row.kind as ExtensionScoutSourceKind,
  };
}

function liveSourceFingerprint(row: SourceRow): string {
  return scoutFingerprint(sourceShapeOf(row));
}

function describeSource(row: SourceRow): string {
  return `${row.publisher} · ${row.label} · ${row.url}`;
}

/** Who holds a source row, in the words the artifact notes use. */
function heldBy(owner: string | null): string {
  const by = ownerExtensionId(owner);
  return by ? `by the extension "${by}"` : 'by hand';
}

/* ── argument validation ─────────────────────────────────────────────── */
// Every exported function below is reachable from an IPC handler, so ids, paths
// and digests are renderer-supplied strings until this file says otherwise.

function requireText(value: unknown, what: string, max = 200): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${what} is required.`);
  if (value.length > max) throw new Error(`${what} is longer than ${max} characters.`);
  return value.trim();
}

function requireExtensionId(value: unknown): string {
  const id = requireText(value, 'An extension id', 64);
  if (!EXTENSION_ID_RE.test(id)) {
    throw new Error(
      `"${id}" cannot be an extension id. Use lowercase letters, digits, dots, dashes and underscores — the id ` +
      'is a primary key and the owner stamp on every row the extension applies.'
    );
  }
  return id;
}

function requireDigest(value: unknown): string {
  if (typeof value !== 'string' || !SHA256_RE.test(value)) {
    throw new Error('An approved manifest digest must be 64 lowercase hex characters.');
  }
  return value;
}

/**
 * An absolute path, because a relative one would resolve against whatever
 * directory this Electron process happens to have — which is not a directory
 * the operator chose in a picker.
 */
function requireDirectory(value: unknown): string {
  const raw = requireText(value, 'A directory', MAX_PATH_CHARS);
  if (!path.isAbsolute(raw)) throw new Error(`"${raw}" is not an absolute path.`);
  return path.resolve(raw);
}

function within(parent: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * The validator compares `requires.wanigan` against this. Outside a running
 * app there is nothing to compare, and inventing a version would turn "needs a
 * newer Wanigan" into a silent pass.
 */
function appVersion(): string | undefined {
  try { return app.getVersion(); } catch { return undefined; }
}

/* ── reading a directory ─────────────────────────────────────────────── */

type ReadResult = {
  ok: boolean;
  /** The real path of the directory, once it is known to be one. */
  root: string | null;
  manifest: ExtensionManifest | null;
  /** sha256 of the exact manifest bytes that were read, not of a re-serialisation. */
  sha256: string | null;
  errors: string[];
  warnings: string[];
};

function readManifestBytes(file: string): Buffer {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${EXTENSION_MANIFEST_FILE} must be a regular file, not a symbolic link.`);
  }
  if (stat.size > MAX_MANIFEST_BYTES) {
    throw new Error(`${EXTENSION_MANIFEST_FILE} is larger than ${MAX_MANIFEST_BYTES} bytes.`);
  }
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  const fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile()) throw new Error(`${EXTENSION_MANIFEST_FILE} must be a regular file.`);
    if (opened.size > MAX_MANIFEST_BYTES) {
      throw new Error(`${EXTENSION_MANIFEST_FILE} is larger than ${MAX_MANIFEST_BYTES} bytes.`);
    }
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (read === 0) throw new Error(`${EXTENSION_MANIFEST_FILE} changed while it was being read.`);
      offset += read;
    }
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Every `file` a manifest points at, checked as a resolved real path.
 *
 * A string test is not enough: `skills/notes.md` can be a symbolic link to
 * ~/.ssh/id_rsa, and an extension whose file references are shown to the
 * operator — or read by anything downstream — would then be quoting a private
 * key out of the home directory. Resolving first and containing second is the
 * only order that catches it.
 */
function fileReferenceErrors(root: string, manifest: ExtensionManifest): string[] {
  const errors: string[] = [];
  const refs: { label: string; file: string }[] = [
    ...(manifest.provides.skills ?? []).map((s) => ({ label: `Skill "${s.name}"`, file: s.file })),
    ...(manifest.provides.instructions ?? []).map((i) => ({ label: `Instruction "${i.title}"`, file: i.file })),
  ];
  for (const ref of refs) {
    if (typeof ref.file !== 'string' || !ref.file) {
      errors.push(`${ref.label} names no file.`);
      continue;
    }
    if (path.isAbsolute(ref.file)) {
      errors.push(`${ref.label} names an absolute path (${ref.file}). An extension may only carry its own files.`);
      continue;
    }
    let real: string;
    try {
      real = fs.realpathSync(path.resolve(root, ref.file));
    } catch {
      errors.push(`${ref.label} names a file that is not in the extension: ${ref.file}`);
      continue;
    }
    if (!within(root, real)) {
      errors.push(`${ref.label} resolves to ${real}, outside the extension directory. A file reference may not leave the extension.`);
      continue;
    }
    if (!fs.statSync(real).isFile()) errors.push(`${ref.label} (${ref.file}) is not a regular file.`);
  }
  return errors;
}

function readExtensionDirectory(directory: string): ReadResult {
  const resolved = requireDirectory(directory);
  const blank: ReadResult = { ok: false, root: null, manifest: null, sha256: null, errors: [], warnings: [] };

  let root: string;
  try {
    root = fs.realpathSync(resolved);
    if (!fs.statSync(root).isDirectory()) {
      return { ...blank, errors: [`${resolved} is not a directory.`] };
    }
  } catch {
    return { ...blank, errors: [`There is no directory at ${resolved}.`] };
  }

  let bytes: Buffer;
  try {
    bytes = readManifestBytes(path.join(root, EXTENSION_MANIFEST_FILE));
  } catch (error) {
    return {
      ...blank, root,
      errors: [`${root} is not an extension: ${error instanceof Error ? error.message : String(error)}`],
    };
  }

  const sha256 = createHash('sha256').update(bytes).digest('hex');
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    return { ...blank, root, sha256, errors: [`${EXTENSION_MANIFEST_FILE} is not valid JSON: ${String(error)}`] };
  }

  const result = validateExtensionManifest(raw, { appVersion: appVersion() });
  if (!result.ok || !result.manifest) {
    return { ok: false, root, manifest: null, sha256, errors: result.errors, warnings: result.warnings };
  }
  const fileErrors = fileReferenceErrors(root, result.manifest);
  return {
    ok: fileErrors.length === 0,
    root,
    manifest: fileErrors.length === 0 ? result.manifest : null,
    sha256,
    errors: [...result.errors, ...fileErrors],
    warnings: result.warnings,
  };
}

/* ── what a manifest declared, and what became of it ─────────────────── */

/**
 * Recomputed from the manifest and the live rows every time it is asked for,
 * never read back from a stored summary. An artifact row records that Wanigan
 * handed a server over; whether that server still exists, and whether it is
 * still this extension's, is a question only the current database can answer.
 */
function artifactState(manifest: ExtensionManifest, builtin = false): ExtensionArtifactInfo[] {
  const installed = pluginRow(manifest.id) !== null;
  const declared = new Map((manifest.provides.mcpServers ?? []).map((s) => [s.name, s]));
  const declaredSources = new Map((manifest.provides.scoutSources ?? []).map((s) => [s.id, s]));

  return declaredArtifacts(manifest).map((info): ExtensionArtifactInfo => {
    if (info.kind === 'scout-source') {
      const source = declaredSources.get(info.ref);
      if (!source) return { ...info, applied: false, note: info.note ?? 'The manifest no longer declares this source.' };
      return sourceState(manifest, source, info, installed, builtin);
    }

    if (info.kind !== 'mcp-server') {
      const note = info.note
        ?? (info.kind === 'skill' ? SKILL_NOTE : info.kind === 'gate' ? GATE_NOTE : INSTRUCTION_NOTE);
      return { ...info, applied: false, note };
    }

    const server = declared.get(info.ref);
    if (!server) return { ...info, applied: false, note: info.note ?? 'The manifest no longer declares this server.' };

    const unsupported = mcpUnsupported(server);
    if (unsupported) return { ...info, applied: false, note: unsupported };

    const rows = serverRowsNamed(info.ref);
    const mine = rows.find((row) => ownerExtensionId(row.owner) === manifest.id);
    if (mine) {
      return {
        ...info,
        projectId: mine.project_id,
        detail: describeServer(mine),
        applied: true,
        note: mine.enabled === 1
          ? null
          : 'Registered and switched off. An enabled stdio server is a command the agent’s CLI runs at every ' +
            'launch, so trust its exact command in Settings → Connections → MCP servers, then enable it.',
      };
    }

    const taken = rows[0];
    if (taken) {
      const by = ownerExtensionId(taken.owner);
      return {
        ...info,
        detail: describeServer(taken),
        applied: false,
        note: `An MCP server called "${info.ref}" is already registered ${by ? `by the extension "${by}"` : 'by hand'}` +
          `${taken.project_id ? ' for one project' : ' globally'}, and was left exactly as it is. Rename one of ` +
          'them — a generated config cannot carry the same server name twice.',
      };
    }

    return {
      ...info,
      applied: false,
      note: installed
        ? `No MCP server called "${info.ref}" is registered any more. It was removed after this extension was installed.`
        : 'Installing this extension registers it, switched off, for you to trust and enable.',
    };
  });
}

/**
 * What became of one declared Scout source. Mirrors the MCP branch above: the
 * row this extension owns is applied, a row somebody else holds is named and
 * left alone, and — the one case with no MCP counterpart — a page some other
 * row already reads is named too, because `url` is UNIQUE and the schema would
 * refuse the insert; the note is so a person learns why instead of seeing a
 * constraint error.
 */
function sourceState(
  manifest: ExtensionManifest, source: ExtensionScoutSource, info: ExtensionArtifactInfo,
  installed: boolean, builtin: boolean,
): ExtensionArtifactInfo {
  const byId = sourceRowById(source.id);
  if (byId && ownerExtensionId(byId.owner) === manifest.id) {
    return {
      ...info,
      detail: describeSource(byId),
      applied: true,
      note: byId.enabled === 1
        ? null
        : 'Registered and switched off. Improvement Scout reads a source every week unattended, so turn it on ' +
          'in Improvement Scout → Sources yourself; the extension does not do that for you.',
    };
  }
  if (byId) {
    if (byId.owner === null && builtin && !installed) {
      return {
        ...info,
        detail: describeSource(byId),
        applied: false,
        note: 'Installing adopts the row Wanigan seeded before extensions existed, keeping whether you had it on ' +
          'and what Scout last read.',
      };
    }
    return {
      ...info,
      detail: describeSource(byId),
      applied: false,
      note: `A Scout source with the id "${source.id}" is already registered ${heldBy(byId.owner)}, and was left ` +
        'exactly as it is. Give this one a different id — a source id is the key every piece of evidence cites.',
    };
  }
  const byUrl = sourceRowByUrl(source.url);
  if (byUrl) {
    return {
      ...info,
      applied: false,
      note: `${source.url} is already read as the source "${byUrl.id}", registered ${heldBy(byUrl.owner)}. Scout ` +
        'reads each page once, so this declaration was left out: drop it, or point it at a different page.',
    };
  }
  return {
    ...info,
    applied: false,
    note: installed
      ? `No Scout source "${source.id}" is registered any more. It was removed after this extension was installed.`
      : 'Installing this extension adds it to Improvement Scout’s weekly read, switched on.',
  };
}

function toOrigin(value: string): ExtensionOrigin {
  return value === 'builtin' || value === 'development' || value === 'export' ? value : 'folder';
}

function toInfo(row: PluginRow): ExtensionInfo {
  // The stored manifest is revalidated rather than trusted. It is a JSON string
  // in a file on disk: a row edited by hand, or written by an older schema, must
  // read as invalid instead of being acted on.
  let manifest: ExtensionManifest | null = null;
  let errors: string[] = [];
  try {
    const result = validateExtensionManifest(JSON.parse(row.manifest_json) as unknown, { appVersion: appVersion() });
    manifest = result.ok ? result.manifest : null;
    errors = result.errors;
  } catch (error) {
    errors = [`The stored manifest is not readable: ${String(error)}`];
  }

  const status: ExtensionStatus = !manifest
    ? 'invalid'
    : row.trusted_sha256 !== row.manifest_sha256
      ? 'needs-trust'
      : row.enabled === 1 ? 'enabled' : 'disabled';

  return {
    id: row.id,
    label: manifest?.label ?? row.label,
    version: manifest?.version ?? row.version,
    description: manifest?.description ?? null,
    publisher: manifest?.publisher
      ? { id: manifest.publisher.id, name: manifest.publisher.name, url: manifest.publisher.url ?? null }
      : null,
    origin: toOrigin(row.origin),
    status,
    enabled: row.enabled === 1,
    errors: status === 'invalid' ? errors : [],
    manifestSha256: row.manifest_sha256,
    trustedSha256: row.trusted_sha256,
    sourcePath: row.source_path,
    installedAt: row.installed_at,
    updatedAt: row.updated_at,
    artifacts: manifest ? artifactState(manifest, row.origin === 'builtin') : [],
    consent: manifest ? extensionConsent(manifest) : [],
  };
}

export function listExtensions(): ExtensionInfo[] {
  const rows = db().prepare('SELECT * FROM plugins ORDER BY label').all() as PluginRow[];
  return rows.map(toInfo);
}

/* ── inspect ─────────────────────────────────────────────────────────── */

/** Read a directory as an extension. Nothing is installed and nothing is written. */
export function inspectExtension(directory: string): ExtensionInspection {
  const read = readExtensionDirectory(directory);
  const manifest = read.manifest;
  const installed = manifest ? pluginRow(manifest.id) : null;
  return {
    ok: read.ok,
    path: read.root ?? requireDirectory(directory),
    id: manifest?.id ?? null,
    label: manifest?.label ?? null,
    version: manifest?.version ?? null,
    description: manifest?.description ?? null,
    publisher: manifest?.publisher
      ? { id: manifest.publisher.id, name: manifest.publisher.name, url: manifest.publisher.url ?? null }
      : null,
    manifestSha256: read.sha256,
    errors: read.errors,
    warnings: read.warnings,
    consent: manifest ? extensionConsent(manifest) : [],
    artifacts: manifest ? artifactState(manifest) : [],
    installedVersion: installed?.version ?? null,
  };
}

/* ── install ─────────────────────────────────────────────────────────── */

function recordArtifact(
  extensionId: string, kind: string, ref: string, projectId: string | null,
  detail: string | null, fingerprint: string | null,
): void {
  db().prepare(`
    INSERT INTO plugin_artifacts (id, plugin_id, kind, ref, project_id, detail, fingerprint, created_at, removed_at)
    VALUES (?,?,?,?,?,?,?,?,NULL)
  `).run(`pa_${randomUUID().slice(0, 12)}`, extensionId, kind, ref, projectId, detail, fingerprint, Date.now());
}

function closeArtifacts(extensionId: string, at: number): void {
  db().prepare('UPDATE plugin_artifacts SET removed_at = ? WHERE plugin_id = ? AND removed_at IS NULL')
    .run(at, extensionId);
}

/**
 * Install the extension in `directory`, having been approved as `approvedSha256`.
 *
 * The digest is passed back in rather than re-read because that is the whole
 * point of showing one: the operator read a list of commands, hosts and
 * credentials produced from those exact bytes. If the file changed between the
 * dialog and the click — a watched directory, a git pull, an author pushing a
 * new version — the permissions on screen are not the permissions being
 * granted, so the install is refused and the new manifest has to be read again.
 *
 * All of it is one transaction. A half-installed extension owns rows nothing
 * lists, which is the state uninstall cannot reason about.
 */
export function installExtension(directory: string, approvedSha256: string): ExtensionInfo[] {
  const approved = requireDigest(approvedSha256);
  const read = readExtensionDirectory(directory);
  if (!read.ok || !read.manifest || !read.root || !read.sha256) {
    throw new Error(
      `${requireDirectory(directory)} cannot be installed as an extension:\n${read.errors.join('\n') || 'no manifest was readable.'}`
    );
  }
  if (read.sha256 !== approved) {
    throw new Error(
      `"${read.manifest.label}" changed on disk after its permissions were shown. Nothing was installed. Read the ` +
      'new manifest — the commands, hosts and credentials it asks for may not be the ones you approved.'
    );
  }

  applyManifest({ manifest: read.manifest, origin: 'folder', sourcePath: read.root, sha256: read.sha256 });
  return listExtensions();
}

/**
 * Record a shipped manifest as installed, and apply it.
 *
 * The digest is over the canonical JSON — the same bytes `applyManifest` stores
 * in `manifest_json` — because there is no file to hash. It is written to both
 * digest columns: a built-in is approved by being shipped, and recording what
 * was approved is what makes an edit to the bundle show up as `needs-trust` on
 * the next start, exactly as a stranger's would.
 *
 * Idempotent on the digest. The same manifest twice changes nothing, so a
 * start is not an install; a manifest that differs — a new Wanigan version
 * changing a source — re-applies through the one path a folder uses.
 */
export function installBuiltinExtension(manifest: ExtensionManifest): { changed: boolean; sha256: string } {
  const json = JSON.stringify(manifest);
  const sha256 = createHash('sha256').update(json).digest('hex');
  const existing = pluginRow(manifest.id);
  if (existing && existing.origin === 'builtin' && existing.manifest_sha256 === sha256) {
    return { changed: false, sha256 };
  }
  applyManifest({ manifest, origin: 'builtin', sourcePath: null, sha256 });
  return { changed: true, sha256 };
}

type ApplyInput = {
  manifest: ExtensionManifest;
  origin: ExtensionOrigin;
  /** The directory a folder install read; null for a built-in, which has none. */
  sourcePath: string | null;
  /** sha256 of the exact bytes being installed — the file's, or the canonical JSON's. */
  sha256: string;
};

/**
 * The one transaction every install runs: the plugin row, the closed artifact
 * history, then each surface in turn. Folder installs and built-ins both land
 * here, which is what makes "no private path" a fact rather than a promise.
 */
function applyManifest({ manifest, origin, sourcePath, sha256 }: ApplyInput): void {
  db().transaction(() => {
    const now = Date.now();
    const owner = extensionOwner(manifest.id, manifest.version);
    // On a folder reinstall `enabled` goes back to 1: a person clicked install,
    // and install means on. A built-in re-applies when a Wanigan update changed
    // it, and an update that switches back on something the operator turned
    // off is the same silent re-enable db.ts's seed comment refuses — so a
    // built-in keeps whatever the row already says.
    db().prepare(`
      INSERT INTO plugins (id, label, version, origin, source_path, manifest_json, manifest_sha256,
                           trusted_sha256, enabled, installed_at, updated_at)
      VALUES (@id,@label,@version,@origin,@source,@json,@sha,@sha,1,@now,@now)
      ON CONFLICT(id) DO UPDATE SET
        label=excluded.label, version=excluded.version, origin=excluded.origin,
        source_path=excluded.source_path, manifest_json=excluded.manifest_json,
        manifest_sha256=excluded.manifest_sha256, trusted_sha256=excluded.trusted_sha256,
        enabled=CASE WHEN excluded.origin = 'builtin' THEN plugins.enabled ELSE 1 END,
        updated_at=excluded.updated_at
    `).run({
      id: manifest.id, label: manifest.label, version: manifest.version, origin,
      source: sourcePath, json: JSON.stringify(manifest), sha: sha256, now,
    });

    // An update re-applies from the new manifest, so the previous install's
    // artifact rows stop describing anything. They are closed, not deleted: the
    // record of what was handed over and when is what stops a reinstall
    // adopting a server the operator has since made their own.
    closeArtifacts(manifest.id, now);

    applyMcpServers(manifest, owner);
    applyScoutSources(manifest, owner, origin === 'builtin', now);
  })();
}

function applyMcpServers(manifest: ExtensionManifest, owner: string): void {
  for (const server of manifest.provides.mcpServers ?? []) {
    if (mcpUnsupported(server)) continue;

    const rows = serverRowsNamed(server.name);
    const mine = rows.find((row) => ownerExtensionId(row.owner) === manifest.id);
    // A name already taken by somebody else's row is never overwritten. Two
    // extensions both declaring "figma" would otherwise take turns winning,
    // and the loser's tools would vanish from an agent's list with nothing on
    // screen to explain it. artifactState reports the collision by name.
    if (!mine && rows.length > 0) continue;

    const applied = upsertServer({
      id: mine?.id,
      projectId: null,
      name: server.name,
      transport: server.transport,
      command: server.command,
      args: server.args?.length ? joinArgs(server.args) : undefined,
      url: server.url,
      // Destination names and where each value comes from, never a value: the
      // secret is resolved out of the keychain when a session's config is
      // written, so this row survives a backup or a support dump carrying no
      // credential.
      // '' rather than undefined when a version declares no environment: the
      // installer is the only caller that knows the whole truth about this
      // field, so it states it either way. undefined would mean "leave what is
      // there", which on an update that dropped a variable would keep handing
      // the old credential to a server that no longer asks for it.
      env: server.env && Object.keys(server.env).length ? JSON.stringify(server.env) : '',
      // The attribution uninstall reads. Without it, removing an extension is
      // a guess at which rows were its.
      owner,
      // Never enabled by the installer. An enabled stdio server is a standing
      // grant to run a command at every session launch, and the registry
      // refuses to enable one whose exact command line has not been approved.
      enabled: false,
    });

    const stored = db().prepare('SELECT * FROM mcp_servers WHERE id = ?').get(applied.id) as ServerRow;
    if (ownerExtensionId(stored.owner) !== manifest.id) {
      // A row Wanigan cannot attribute is a row no uninstall may touch, so
      // the install fails here rather than leaving an orphan behind.
      throw new Error(`"${server.name}" could not be attributed to this extension, so nothing was installed.`);
    }
    recordArtifact(
      manifest.id, 'mcp-server', stored.name, stored.project_id,
      describeServer(stored), liveFingerprint(stored),
    );
  }
}

/**
 * Register each declared Scout source, the way `applyMcpServers` registers a
 * server: a row this extension already owns is brought up to date, a row it
 * does not own is left exactly as it is, and a page some other row already
 * reads is left out. Nothing is written for a collision; `sourceState` names
 * it so a person learns why rather than seeing a UNIQUE constraint error.
 *
 * Adoption is the one asymmetry. A row with `owner` NULL is either one db.ts
 * seeded before extensions existed or one an uninstall disowned, and the
 * built-in extension declaring the same id takes it over — setting the owner
 * and refreshing the copy, leaving `enabled` and the `last_*` columns alone
 * because those are the operator's history. Only a built-in may adopt: a third
 * party declaring `claude-code-changelog` would be taking over a page the
 * operator trusts under Anthropic's name, and its uninstall would then delete a
 * row Wanigan shipped. For a stranger the same row is a collision, by name.
 */
function applyScoutSources(manifest: ExtensionManifest, owner: string, builtin: boolean, now: number): void {
  const update = db().prepare(`
    UPDATE improvement_scout_sources
    SET label=@label, description=@description, url=@url, publisher=@publisher, kind=@kind,
        official=@official, owner=@owner, updated_at=@now
    WHERE id=@id
  `);
  const insert = db().prepare(`
    INSERT INTO improvement_scout_sources
      (id, label, description, url, publisher, kind, official, enabled, owner, created_at, updated_at)
    VALUES (@id, @label, @description, @url, @publisher, @kind, @official, 1, @owner, @now, @now)
  `);

  for (const source of manifest.provides.scoutSources ?? []) {
    const byId = sourceRowById(source.id);
    const mine = byId !== null && ownerExtensionId(byId.owner) === manifest.id;
    const adoptable = byId !== null && byId.owner === null && builtin;
    if (byId && !mine && !adoptable) continue;

    // `url` is UNIQUE. The check is here rather than left to the schema so
    // that one colliding page leaves the rest of the manifest applying, and so
    // an adoption whose row was pointed elsewhere by hand does not fail the
    // whole transaction over a page another row now holds.
    const holder = sourceRowByUrl(source.url);
    if (holder && holder.id !== source.id) continue;

    // `official` is what Scout shows as Wanigan's own allow-list, so only a
    // manifest Wanigan ships may set it. A new row arrives switched on: a Scout
    // source is a public page read once a week, not a command run at every
    // launch, and the consent line for the host was already shown at install.
    // An existing row keeps its `enabled`, on the same rule as db.ts's seed —
    // a refreshed copy must never re-enable a source the operator turned off.
    const params = {
      id: source.id, label: source.label, description: source.description, url: source.url,
      publisher: source.publisher, kind: source.kind, official: builtin ? 1 : 0, owner, now,
    };
    if (byId) update.run(params); else insert.run(params);

    const stored = sourceRowById(source.id);
    if (!stored || ownerExtensionId(stored.owner) !== manifest.id) {
      // A row Wanigan cannot attribute is a row no uninstall may touch, so
      // the install fails here rather than leaving an orphan behind.
      throw new Error(`Scout source "${source.id}" could not be attributed to this extension, so nothing was installed.`);
    }
    recordArtifact(manifest.id, 'scout-source', stored.id, null, describeSource(stored), liveSourceFingerprint(stored));
  }
}

/* ── enable / disable ────────────────────────────────────────────────── */

/**
 * Disabling stops the extension's servers being handed to sessions and its
 * Scout sources being read, and leaves every row exactly where it is — it is
 * not a quiet uninstall.
 *
 * Enabling deliberately does not switch those servers or sources back on.
 * Wanigan does not record which of them the operator had running, and an
 * extension toggle that starts an HTTP endpoint, asks the registry to spawn a
 * command, or puts five pages back on a weekly unattended fetch is the kind of
 * grant this app makes people give one at a time. The artifact note names the
 * switch to use.
 */
export function setExtensionEnabled(extensionId: string, enabled: boolean): ExtensionInfo[] {
  const id = requireExtensionId(extensionId);
  if (typeof enabled !== 'boolean') throw new Error('Enabled must be true or false.');
  if (!pluginRow(id)) throw new Error(`No extension "${id}" is installed.`);

  db().transaction(() => {
    const now = Date.now();
    db().prepare('UPDATE plugins SET enabled = ?, updated_at = ? WHERE id = ?').run(enabled ? 1 : 0, now, id);
    if (!enabled) {
      for (const row of ownedRows(id)) setServerEnabled(row.id, false);
      const off = db().prepare('UPDATE improvement_scout_sources SET enabled = 0, updated_at = ? WHERE id = ?');
      for (const row of ownedSourceRows(id)) off.run(now, row.id);
    }
  })();

  return listExtensions();
}

/* ── uninstall ───────────────────────────────────────────────────────── */

/**
 * Remove the extension and exactly the rows it still owns.
 *
 * A row whose live shape no longer matches the fingerprint recorded at install
 * is one somebody changed on purpose, so it is kept, named in the summary, and
 * disowned — `owner` goes to NULL, which is both what it now is and what stops a
 * reinstall adopting it again. Silently reverting a person's own edit is the one
 * outcome that would teach people never to uninstall anything.
 *
 * A Scout source that evidence cites is kept the same way even when it still
 * matches: the evidence table keeps its source, so deleting the row is not on
 * offer, and the note says so rather than the constraint.
 *
 * A built-in is refused. It ships with Wanigan and would be back at the next
 * start, so "uninstalled" would be a lie for one restart; disabling is the
 * honest verb, and it works.
 */
export function uninstallExtension(extensionId: string): ExtensionRemoval {
  const id = requireExtensionId(extensionId);
  const row = pluginRow(id);
  if (!row) throw new Error(`No extension "${id}" is installed.`);
  if (row.origin === 'builtin') {
    throw new Error(
      `"${row.label}" ships with Wanigan and cannot be uninstalled — it would be back at the next start. ` +
      'Disable it instead, which switches off everything it registered and leaves it there.'
    );
  }

  const removed: ExtensionArtifactInfo[] = [];
  const kept: ExtensionArtifactInfo[] = [];

  db().transaction(() => {
    const fingerprintsOf = (kind: string) => new Set(
      liveArtifacts(id, kind).map((artifact) => artifact.fingerprint).filter((f): f is string => !!f)
    );
    const installedServers = fingerprintsOf('mcp-server');
    const installedSources = fingerprintsOf('scout-source');

    for (const server of ownedRows(id)) {
      const base = {
        kind: 'mcp-server' as const,
        ref: server.name,
        projectId: server.project_id,
        detail: describeServer(server),
      };
      if (installedServers.has(liveFingerprint(server))) {
        removeServer(server.id);
        removed.push({ ...base, applied: false, note: 'Removed with the extension; it was still exactly as installed.' });
      } else {
        db().prepare('UPDATE mcp_servers SET owner = NULL WHERE id = ?').run(server.id);
        kept.push({
          ...base,
          detail: `${base.detail} — edited after it was installed`,
          applied: true,
          note: 'Kept. Its command, name or scope no longer matches what the extension installed, so it is yours ' +
            'now: the extension is gone and this row is not.',
        });
      }
    }

    const disown = db().prepare('UPDATE improvement_scout_sources SET owner = NULL, updated_at = ? WHERE id = ?');
    for (const source of ownedSourceRows(id)) {
      const base = {
        kind: 'scout-source' as const,
        ref: source.id,
        projectId: null,
        detail: describeSource(source),
      };
      const cited = evidenceCiting(source.id);
      if (cited === 0 && installedSources.has(liveSourceFingerprint(source))) {
        db().prepare('DELETE FROM improvement_scout_sources WHERE id = ?').run(source.id);
        removed.push({ ...base, applied: false, note: 'Removed with the extension; it was still exactly as installed.' });
      } else {
        disown.run(Date.now(), source.id);
        kept.push({
          ...base,
          detail: `${base.detail} — ${cited ? 'cited by Scout evidence' : 'edited after it was installed'}`,
          applied: true,
          note: cited
            ? `Kept. ${cited === 1 ? 'One piece' : `${cited} pieces`} of Scout evidence cite this source, and evidence ` +
              'keeps its source, so the row stays and is yours now: switch it off in Improvement Scout → Sources if ' +
              'you do not want the page read again.'
            : 'Kept. Its page, label or sentence no longer matches what the extension installed, so it is yours now: ' +
              'the extension is gone and this row is not.',
        });
      }
    }

    closeArtifacts(id, Date.now());
    db().prepare('DELETE FROM plugins WHERE id = ?').run(id);
  })();

  const count = (list: ExtensionArtifactInfo[], kind: ExtensionArtifactInfo['kind']) =>
    list.filter((entry) => entry.kind === kind).length;
  const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
  const took = [
    plural(count(removed, 'mcp-server'), 'MCP server'),
    plural(count(removed, 'scout-source'), 'Scout source'),
  ].join(' and ');
  const keptNames = kept.map((k) => `"${k.ref}"`).join(', ');
  const detail = kept.length
    ? `Removed ${took}. Kept ${keptNames}: edited after install or cited by evidence, so ` +
      `${kept.length === 1 ? 'it is' : 'they are'} yours now and owned by no extension.`
    : `Removed ${took}. Skills, gates and instructions were only ever declared, so there was nothing of theirs ` +
      'to take back.';

  return { pluginId: id, removed, kept, detail };
}

/* ── export ──────────────────────────────────────────────────────────── */

/**
 * Live configuration that "Save as extension" could include.
 *
 * Global rows that no extension owns. A project-scoped row cannot be carried:
 * an extension names no project, so the install on the other side would have
 * nowhere faithful to put it. A row another extension owns is left out too —
 * re-exporting it under a new id is a way to launder ownership of somebody
 * else's server.
 */
export function exportableConfiguration(): {
  mcpServers: { id: string; name: string; detail: string }[];
  scoutSources: { id: string; label: string; detail: string }[];
} {
  const rows = db().prepare(
    'SELECT * FROM mcp_servers WHERE project_id IS NULL AND owner IS NULL ORDER BY name'
  ).all() as ServerRow[];
  // The same ownership rule for Scout sources. Once the built-in has adopted
  // the shipped five they are owned and withheld — and would collide on url
  // wherever the export was installed anyway.
  const sources = db().prepare(
    'SELECT * FROM improvement_scout_sources WHERE owner IS NULL ORDER BY id'
  ).all() as SourceRow[];
  return {
    mcpServers: rows.map((row) => ({ id: row.id, name: row.name, detail: describeServer(row) })),
    scoutSources: sources.map((row) => ({ id: row.id, label: row.label, detail: describeSource(row) })),
  };
}

/**
 * Refuse to write inside a repository, at the directory or any parent.
 *
 * Wanigan does not put generated files in somebody's working tree: they land in
 * `git status`, an agent told to commit everything commits them, and the
 * operator gets a diff they never wrote.
 */
function repositoryRootAbove(directory: string): string | null {
  let current = directory;
  for (;;) {
    try {
      if (fs.existsSync(path.join(current, '.git'))) return current;
    } catch { /* unreadable parent; keep walking */ }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Write this Wanigan's own configuration out as an extension directory, then
 * read it back so the caller sees exactly what any other install would see.
 */
export function exportExtension(
  input: { directory: string; id: string; label: string; mcpServerIds: string[]; scoutSourceIds?: string[] },
): ExtensionInspection {
  if (!input || typeof input !== 'object') throw new Error('An export needs a directory, an id, a label and a selection.');
  const directory = requireDirectory(input.directory);
  const id = requireExtensionId(input.id);
  const label = requireText(input.label, 'A label', 120);
  if (!Array.isArray(input.mcpServerIds) || input.mcpServerIds.length > 100) {
    throw new Error('Select up to 100 MCP servers to save into the extension.');
  }
  // Optional so a caller that predates Scout sources still exports what it
  // asked for; a manifest with no sources declares none.
  const scoutSourceIds = input.scoutSourceIds ?? [];
  if (!Array.isArray(scoutSourceIds) || scoutSourceIds.length > 100) {
    throw new Error('Select up to 100 Scout sources to save into the extension.');
  }

  // Resolved against what is exportable rather than against the whole table, so
  // a renderer that sends an id it was never offered is refused by name instead
  // of quietly exporting a project-scoped or extension-owned row.
  const offered = new Map(
    (db().prepare('SELECT * FROM mcp_servers WHERE project_id IS NULL AND owner IS NULL').all() as ServerRow[])
      .map((row) => [row.id, row])
  );
  const chosen = input.mcpServerIds.map((serverId) => {
    const row = offered.get(requireText(serverId, 'An MCP server id', 120));
    if (!row) throw new Error(`No MCP server ${String(serverId)} can be saved into an extension. Nothing was written.`);
    return row;
  });
  const offeredSources = new Map(
    (db().prepare('SELECT * FROM improvement_scout_sources WHERE owner IS NULL').all() as SourceRow[])
      .map((row) => [row.id, row])
  );
  const chosenSources = scoutSourceIds.map((sourceId) => {
    const row = offeredSources.get(requireText(sourceId, 'A Scout source id', 120));
    if (!row) throw new Error(`No Scout source ${String(sourceId)} can be saved into an extension. Nothing was written.`);
    return row;
  });

  // A manifest may only read a credential it asks for itself, so the ones the
  // chosen rows reference are declared here. The id is all Wanigan knows — the
  // author writes a label a stranger can act on before sharing this.
  const credentialIds = [...new Set(
    chosen.flatMap((row) => Object.values(parseServerEnv(row.env).env ?? {})
      .flatMap((value) => (value.source === 'credential' ? [value.id] : [])))
  )].sort();

  const manifest: ExtensionManifest = {
    schemaVersion: 1,
    id,
    label,
    version: EXPORT_VERSION,
    description: `Saved from this Wanigan's own configuration on ${new Date().toISOString().slice(0, 10)}.`,
    ...(credentialIds.length ? { credentials: credentialIds.map((cid) => ({ id: cid, label: cid })) } : {}),
    provides: {
      mcpServers: chosen.map((row): ExtensionMcpServer => {
        // An environment this file cannot describe again is refused rather than
        // written out short: an extension that quietly drops a variable is one
        // whose server fails on the machine it is shared with.
        if (!parseServerEnv(row.env).complete) {
          throw new Error(`"${row.name}" has an environment that cannot be written back as a manifest. Nothing was written.`);
        }
        return shapeOf(row);
      }),
      // A row whose kind the manifest does not allow is caught by the
      // validation below, before a byte is written, rather than here.
      ...(chosenSources.length ? { scoutSources: chosenSources.map(sourceShapeOf) } : {}),
    },
  };

  // Validated before a byte is written. An export that produces a directory the
  // installer then refuses is worse than a refusal here, because the operator
  // believes they have something to share.
  const check = validateExtensionManifest(manifest, { appVersion: appVersion() });
  if (!check.ok) throw new Error(`This configuration cannot be saved as an extension:\n${check.errors.join('\n')}`);

  const repository = repositoryRootAbove(directory);
  if (repository) {
    throw new Error(
      `${directory} is inside the repository at ${repository}. Wanigan does not write into a working tree — ` +
      'choose a directory outside it.'
    );
  }

  fs.mkdirSync(directory, { recursive: true });
  if (!fs.statSync(directory).isDirectory()) throw new Error(`${directory} is not a directory.`);

  const file = path.join(directory, EXTENSION_MANIFEST_FILE);
  if (fs.existsSync(file)) {
    // Overwriting your own export again is saving; overwriting a different
    // extension that happens to live here is losing someone's work.
    const existing = readExtensionDirectory(directory);
    if (existing.manifest && existing.manifest.id !== id) {
      throw new Error(`${directory} already holds the extension "${existing.manifest.id}". Nothing was written.`);
    }
  }
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);

  return inspectExtension(directory);
}
