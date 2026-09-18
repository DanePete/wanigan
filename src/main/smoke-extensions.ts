import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { db } from './db';
import * as registry from './mcp/registry';
import * as extensions from './extensions/store';
import * as builtin from './extensions/builtin';
import { EXTENSION_MANIFEST_FILE, ownerExtensionId, scoutFingerprint } from '../shared/extension-manifest';
import type { ExtensionInfo, ExtensionInspection } from '../shared/types';

type Check = (ok: boolean, label: string, detail?: unknown) => void;

type Manifest = Record<string, unknown>;

/** Real extension directories on disk, installed into the real tables. */
export async function runExtensionsSmoke(check: Check, say: (text: string) => void): Promise<void> {
  say('── extensions · declared, applied, and taken back');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-extensions-'));

  const write = (where: string, manifest: Manifest, files: Record<string, string> = {}): string => {
    const root = path.join(dir, where);
    fs.mkdirSync(root, { recursive: true });
    for (const [file, body] of Object.entries(files)) {
      const target = path.join(root, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, body);
    }
    fs.writeFileSync(path.join(root, EXTENSION_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
    return root;
  };
  const refused = (action: () => unknown): string => {
    try { action(); return ''; } catch (error) { return String(error); }
  };
  const listing = (root: string): string =>
    (fs.readdirSync(root, { recursive: true }) as string[]).slice().sort().join('\n');
  const serverRow = (name: string) =>
    db().prepare('SELECT * FROM mcp_servers WHERE name = ?').get(name) as {
      id: string; name: string; command: string | null; args: string | null;
      enabled: number; env: string | null; owner: string | null;
    } | undefined;
  const artifact = (info: ExtensionInfo | ExtensionInspection | null, ref: string) =>
    info?.artifacts.find((a) => a.ref === ref) ?? null;
  type SourceRow = {
    id: string; label: string; description: string; url: string; publisher: string; kind: string;
    official: number; enabled: number; owner: string | null; last_status: string | null; updated_at: number;
  };
  const sourceRow = (id: string) =>
    db().prepare('SELECT * FROM improvement_scout_sources WHERE id = ?').get(id) as SourceRow | undefined;
  const sourceArtifacts = (pluginId: string) =>
    db().prepare("SELECT id, ref, fingerprint FROM plugin_artifacts WHERE plugin_id = ? AND kind = 'scout-source' AND removed_at IS NULL ORDER BY ref")
      .all(pluginId) as { id: string; ref: string; fingerprint: string | null }[];

  // The five rows db.ts seeds. The built-in adopts them below, so their state
  // is taken here and put back in `finally` — the rest of the suite reads them.
  const shippedIds = [
    'openai-release-notes', 'claude-code-changelog', 'anthropic-platform-release-notes',
    'github-changelog', 'github-releases-rest-docs',
  ];
  const shippedBefore = new Map(shippedIds.map((id) => [id, sourceRow(id)]));
  const BUILTIN_ID = 'wanigan.scout-sources';

  const alphaManifest: Manifest = {
    schemaVersion: 1,
    id: 'smoke-ext-alpha',
    label: 'Smoke Alpha',
    version: '1.0.0',
    description: 'Two MCP servers and three declarations Wanigan does not install.',
    credentials: [{ id: 'smoke-ext-alpha.token', label: 'Smoke token' }],
    provides: {
      mcpServers: [
        {
          name: 'smoke-ext-fs', transport: 'stdio', command: 'echo', args: ['alpha'],
          env: { SMOKE_EXT_TOKEN: { source: 'credential', id: 'smoke-ext-alpha.token' } },
        },
        { name: 'smoke-ext-two', transport: 'stdio', command: 'echo', args: ['two'] },
      ],
      skills: [{ name: 'smoke-ext-skill', file: 'skills/smoke.md', description: 'A skill this install will not write.' }],
      gates: [{ label: 'Smoke gate', commands: ['true'] }],
      instructions: [{ scope: 'project', title: 'Smoke rule', file: 'rules/smoke.md' }],
    },
  };

  try {
    const alpha = write('alpha', alphaManifest, {
      'skills/smoke.md': '# smoke skill\n',
      'rules/smoke.md': '# smoke rule\n',
    });
    const before = listing(alpha);

    const first = extensions.inspectExtension(alpha);
    check(first.ok && first.id === 'smoke-ext-alpha' && /^[0-9a-f]{64}$/.test(first.manifestSha256 ?? '')
      && first.installedVersion === null,
    'inspecting a directory reads it as an extension and names the exact digest a person would be approving, without installing it', first.errors);

    const undone = first.artifacts.filter((a) => a.kind !== 'mcp-server');
    check(undone.length === 3 && undone.every((a) => !a.applied && !!a.note && a.note.length > 40)
      && undone.some((a) => a.kind === 'gate' && /saveRecipeWithConsent/.test(a.note ?? ''))
      && undone.some((a) => a.kind === 'skill' && /review inbox/.test(a.note ?? '')),
    'skills, gates and instructions are listed as declared rather than quietly dropped, each with a note naming the consented path it still needs', undone);

    // The whole reason the digest is handed back to install: the operator read
    // a list of commands produced from these exact bytes.
    fs.writeFileSync(
      path.join(alpha, EXTENSION_MANIFEST_FILE),
      `${JSON.stringify({ ...alphaManifest, description: 'Edited after it was shown.' }, null, 2)}\n`
    );
    const stale = refused(() => extensions.installExtension(alpha, first.manifestSha256 ?? ''));
    check(/changed on disk/.test(stale) && !extensions.listExtensions().some((e) => e.id === 'smoke-ext-alpha'),
      'a manifest edited between the consent dialog and the click is refused, so nobody grants permissions they were never shown', stale);

    const shown = extensions.inspectExtension(alpha);
    const installed = extensions.installExtension(alpha, shown.manifestSha256 ?? '');
    const info = installed.find((e) => e.id === 'smoke-ext-alpha') ?? null;
    const fsRow = serverRow('smoke-ext-fs');
    check(info?.status === 'enabled' && !!fsRow && ownerExtensionId(fsRow.owner ?? null) === 'smoke-ext-alpha'
      && fsRow.command === 'echo' && artifact(info, 'smoke-ext-fs')?.applied === true,
    'installing applies the MCP servers it declared and stamps each row with the extension that owns it, which is the only thing that makes an uninstall exact', fsRow);

    check(fsRow?.enabled === 0 && /trust its exact command/i.test(artifact(info, 'smoke-ext-fs')?.note ?? ''),
      'an installed stdio server arrives switched off with a note naming the approval it still needs, because enabling one is a standing grant to run that command at every launch');

    check(fsRow?.env === JSON.stringify({ SMOKE_EXT_TOKEN: { source: 'credential', id: 'smoke-ext-alpha.token' } }),
      'a declared environment is stored as the destination and the credential it names, so the row survives a backup or a support dump carrying no secret', fsRow?.env);

    check(listing(alpha) === before,
      'installing writes nothing back into the extension directory it read');

    // A string check on "skills/leak.md" passes; the file is a symlink out of
    // the extension and into the home directory.
    fs.writeFileSync(path.join(dir, 'outside.md'), 'private\n');
    const escape = write('escape', {
      schemaVersion: 1, id: 'smoke-ext-escape', label: 'Smoke Escape', version: '1.0.0',
      provides: { skills: [{ name: 'leak', file: 'skills/leak.md' }] },
    });
    fs.mkdirSync(path.join(escape, 'skills'), { recursive: true });
    fs.symlinkSync(path.join(dir, 'outside.md'), path.join(escape, 'skills', 'leak.md'));
    const escaped = extensions.inspectExtension(escape);
    const escapeRefused = refused(() => extensions.installExtension(escape, escaped.manifestSha256 ?? ''));
    check(!escaped.ok && escaped.errors.some((e) => /outside the extension directory/.test(e)) && !!escapeRefused,
      'a file reference whose resolved real path leaves the extension is refused on inspection and on install, so a symbolic link cannot quote a private key out of the home directory', escaped.errors);

    // Somebody else's server, added by hand before any extension existed.
    const taken = registry.upsertServer({
      projectId: null, name: 'smoke-ext-taken', transport: 'stdio',
      command: 'mine', args: 'do-not-touch', enabled: false,
    });
    const beta = write('beta', {
      schemaVersion: 1, id: 'smoke-ext-beta', label: 'Smoke Beta', version: '1.0.0',
      provides: {
        mcpServers: [
          { name: 'smoke-ext-taken', transport: 'stdio', command: 'theirs', args: ['overwrite'] },
          { name: 'smoke-ext-beta-ok', transport: 'stdio', command: 'echo', args: ['beta'] },
        ],
      },
    });
    const betaShown = extensions.inspectExtension(beta);
    const betaInfo = extensions.installExtension(beta, betaShown.manifestSha256 ?? '')
      .find((e) => e.id === 'smoke-ext-beta') ?? null;
    const takenRow = serverRow('smoke-ext-taken');
    check(takenRow?.id === taken.id && takenRow?.command === 'mine' && takenRow?.owner === null
      && artifact(betaInfo, 'smoke-ext-taken')?.applied === false
      && /already registered/.test(artifact(betaInfo, 'smoke-ext-taken')?.note ?? ''),
    'a declared server whose name is already taken is reported unapplied and named, never overwritten — two extensions cannot take turns winning one server name', takenRow);
    check(artifact(betaInfo, 'smoke-ext-beta-ok')?.applied === true && !!serverRow('smoke-ext-beta-ok'),
      'a collision on one declaration does not stop the rest of the extension being applied');

    // Disabling is not a quiet uninstall, so the rows have to still be there
    // afterwards — including one the operator had approved and switched on.
    const review = registry.reviewServer(serverRow('smoke-ext-fs')?.id ?? '');
    registry.trustServer(review?.id ?? '', review?.sha256 ?? '');
    registry.setServerEnabled(review?.id ?? '', true);
    const disabled = extensions.setExtensionEnabled('smoke-ext-alpha', false)
      .find((e) => e.id === 'smoke-ext-alpha') ?? null;
    const afterDisable = serverRow('smoke-ext-fs');
    check(disabled?.status === 'disabled' && !!afterDisable && afterDisable.enabled === 0
      && !!serverRow('smoke-ext-two') && artifact(disabled, 'smoke-ext-fs')?.applied === true,
    'disabling an extension stops its servers being handed to sessions and leaves every row in place, because a toggle is not an uninstall', afterDisable);

    // The row a person made their own: same owner stamp, different arguments.
    // The owner is carried back through the save on purpose — a disowned row is
    // already outside every uninstall, and what is under test here is the row
    // that is still attributed and no longer matches.
    const edited = serverRow('smoke-ext-two');
    registry.upsertServer({
      id: edited?.id, projectId: null, name: 'smoke-ext-two', transport: 'stdio',
      command: 'echo', args: 'mine now', enabled: false, owner: edited?.owner ?? undefined,
    });
    const removal = extensions.uninstallExtension('smoke-ext-alpha');
    const survivor = serverRow('smoke-ext-two');
    check(removal.removed.length === 1 && removal.removed[0]?.ref === 'smoke-ext-fs' && !serverRow('smoke-ext-fs'),
      'uninstalling removes the rows that still match the shape the extension installed', removal);
    check(removal.kept.length === 1 && removal.kept[0]?.ref === 'smoke-ext-two' && !!survivor
      && survivor.args === 'mine now' && survivor.owner === null && /"smoke-ext-two"/.test(removal.detail),
    'a server edited after install survives the uninstall, is named in the summary, and is disowned rather than reverted — silently undoing somebody’s own change is what stops people uninstalling anything', removal.detail);

    const reinstalled = extensions.installExtension(alpha, extensions.inspectExtension(alpha).manifestSha256 ?? '')
      .find((e) => e.id === 'smoke-ext-alpha') ?? null;
    check(serverRow('smoke-ext-two')?.owner === null && serverRow('smoke-ext-two')?.args === 'mine now'
      && artifact(reinstalled, 'smoke-ext-two')?.applied === false
      && /already registered/.test(artifact(reinstalled, 'smoke-ext-two')?.note ?? ''),
    'reinstalling does not re-adopt the server the operator kept: it reads as a name collision, exactly as another extension’s row would', serverRow('smoke-ext-two'));

    const exportable = extensions.exportableConfiguration();
    check(exportable.mcpServers.some((s) => s.name === 'smoke-ext-taken')
      && !exportable.mcpServers.some((s) => s.name === 'smoke-ext-beta-ok'),
    'a save-as-extension offers the servers a person added themselves and withholds the ones another extension owns', exportable);

    const saved = extensions.exportExtension({
      directory: path.join(dir, 'saved'), id: 'smoke-ext-saved', label: 'Saved configuration',
      mcpServerIds: exportable.mcpServers.filter((s) => s.name === 'smoke-ext-taken').map((s) => s.id),
    });
    check(saved.ok && saved.id === 'smoke-ext-saved' && artifact(saved, 'smoke-ext-taken')?.applied === false,
      'an exported directory reads back as a valid extension, and reports its one server as already taken by the row it was exported from', saved.errors);
    check(!!refused(() => extensions.exportExtension({
      directory: path.join(dir, 'saved'), id: 'smoke-ext-saved', label: 'Saved configuration',
      mcpServerIds: ['mcp_not_offered'],
    })), 'an export refuses a server id it never offered, rather than quietly writing a smaller extension');

    say('── extensions · scout sources: applied, adopted, and taken back');

    // Four declarations: one clean, one edited later, one whose id Wanigan
    // ships, one whose page Wanigan already reads under another id.
    const gammaSources = [
      {
        id: 'smoke-ext-source', label: 'Smoke changelog', description: 'A page the smoke suite never fetches.',
        url: 'https://smoke.invalid/changelog', publisher: 'Smoke', kind: 'changelog',
      },
      {
        id: 'smoke-ext-edited', label: 'Smoke notes', description: 'A page the operator will edit after install.',
        url: 'https://smoke.invalid/release-notes', publisher: 'Smoke', kind: 'release-notes',
      },
      {
        id: 'claude-code-changelog', label: 'Not the real one', description: 'A third party claiming a shipped id.',
        url: 'https://smoke.invalid/claude', publisher: 'Smoke', kind: 'changelog',
      },
      {
        id: 'smoke-ext-url-dup', label: 'Same page again', description: 'A different id for a page already read.',
        url: 'https://code.claude.com/docs/en/changelog', publisher: 'Smoke', kind: 'changelog',
      },
    ];
    const gamma = write('gamma', {
      schemaVersion: 1, id: 'smoke-ext-gamma', label: 'Smoke Gamma', version: '1.0.0',
      provides: { scoutSources: gammaSources },
    });
    const gammaShown = extensions.inspectExtension(gamma);
    const gammaInfo = extensions.installExtension(gamma, gammaShown.manifestSha256 ?? '')
      .find((e) => e.id === 'smoke-ext-gamma') ?? null;
    const applied = sourceRow('smoke-ext-source');
    const appliedArtifact = sourceArtifacts('smoke-ext-gamma').find((a) => a.ref === 'smoke-ext-source');
    check(!!applied && ownerExtensionId(applied.owner) === 'smoke-ext-gamma' && applied.enabled === 1
      && applied.official === 0 && artifact(gammaInfo, 'smoke-ext-source')?.applied === true
      && appliedArtifact?.fingerprint === scoutFingerprint({ ...gammaSources[0]!, kind: 'changelog' }),
    'a declared Scout source becomes a row Scout will read, stamped with its owner and recorded under the fingerprint uninstall will compare — an unowned or unfingerprinted row is one no uninstall can be exact about', { applied, appliedArtifact });

    const shipped = sourceRow('claude-code-changelog');
    // Owned by the built-in by now — startServices() seeds before anything
    // else runs, and this suite is started the same way — and still not by
    // the stranger, which is the property: the row is untouched.
    check(shipped?.url === 'https://code.claude.com/docs/en/changelog' && ownerExtensionId(shipped.owner) === BUILTIN_ID
      && artifact(gammaInfo, 'claude-code-changelog')?.applied === false
      && /already registered/.test(artifact(gammaInfo, 'claude-code-changelog')?.note ?? ''),
    'a third party declaring a shipped source id is reported unapplied and the shipped row is untouched: only a built-in may adopt an unowned row, or a stranger could take over Anthropic’s changelog by naming it', shipped);

    check(!sourceRow('smoke-ext-url-dup') && artifact(gammaInfo, 'smoke-ext-url-dup')?.applied === false
      && /"claude-code-changelog"/.test(artifact(gammaInfo, 'smoke-ext-url-dup')?.note ?? ''),
    'a different id declaring a page some row already reads is left out with a note naming that row, so a person learns why instead of reading a UNIQUE constraint error', artifact(gammaInfo, 'smoke-ext-url-dup'));

    // One shipped source switched off by hand before the built-in arrives.
    db().prepare('UPDATE improvement_scout_sources SET enabled = 0 WHERE id = ?').run('github-releases-rest-docs');
    builtin.installBuiltinExtensions();
    const builtinInfo = extensions.listExtensions().find((e) => e.id === BUILTIN_ID) ?? null;
    const builtinRow = db().prepare('SELECT * FROM plugins WHERE id = ?').get(BUILTIN_ID) as {
      origin: string; source_path: string | null; manifest_sha256: string; trusted_sha256: string | null; updated_at: number;
    } | undefined;
    check(builtinInfo?.origin === 'builtin' && builtinInfo.status === 'enabled' && builtinRow?.source_path === null
      && builtinRow.trusted_sha256 === builtinRow.manifest_sha256 && sourceArtifacts(BUILTIN_ID).length === 5,
    'the built-in is recorded in the same table as a folder install, with no path and a digest that is its own approval, so an edit to the shipped bundle reads as needs-trust like anybody else’s', builtinRow);

    const adopted = shippedIds.map((id) => sourceRow(id));
    const offOne = sourceRow('github-releases-rest-docs');
    check(adopted.every((row) => !!row && ownerExtensionId(row.owner) === BUILTIN_ID && row.official === 1)
      && offOne?.enabled === 0
      && adopted.every((row) => !!row && row.last_status === shippedBefore.get(row.id)?.last_status),
    'the built-in adopts the five rows Wanigan seeded before extensions existed — setting the owner and leaving a source the operator had switched off switched off, with its last-read history intact', adopted);

    check(artifact(extensions.listExtensions().find((e) => e.id === 'smoke-ext-gamma') ?? null, 'claude-code-changelog')?.note
      ?.includes(`"${BUILTIN_ID}"`) === true,
    'once adopted, the collision note names the built-in as the row’s owner rather than calling a shipped source hand-added');

    const artifactsBefore = sourceArtifacts(BUILTIN_ID).map((a) => a.id).join(',');
    builtin.installBuiltinExtensions();
    const builtinAgain = db().prepare('SELECT updated_at FROM plugins WHERE id = ?').get(BUILTIN_ID) as { updated_at: number };
    check(builtinAgain.updated_at === builtinRow?.updated_at
      && sourceArtifacts(BUILTIN_ID).map((a) => a.id).join(',') === artifactsBefore,
    'installing the built-ins a second time with the same digest changes nothing, so a start is not an install');

    const builtinRefused = refused(() => extensions.uninstallExtension(BUILTIN_ID));
    check(/ships with Wanigan/.test(builtinRefused) && !!db().prepare('SELECT id FROM plugins WHERE id = ?').get(BUILTIN_ID),
      'a built-in cannot be uninstalled — it would be back at the next start, so the refusal says to disable it instead', builtinRefused);

    const builtinDisabled = extensions.setExtensionEnabled(BUILTIN_ID, false).find((e) => e.id === BUILTIN_ID) ?? null;
    check(builtinDisabled?.status === 'disabled' && shippedIds.every((id) => sourceRow(id)?.enabled === 0)
      && shippedIds.every((id) => !!sourceRow(id)),
    'disabling the built-in switches off every source it owns and leaves the rows where they are, because a toggle is not an uninstall');
    extensions.setExtensionEnabled(BUILTIN_ID, true);
    check(shippedIds.every((id) => sourceRow(id)?.enabled === 0),
      'enabling an extension does not switch its sources back on: Wanigan did not record which were on, and five weekly unattended fetches are a grant given one at a time');

    // The row a person made their own: same owner, different sentence.
    db().prepare('UPDATE improvement_scout_sources SET description = ? WHERE id = ?')
      .run('Rewritten by hand.', 'smoke-ext-edited');
    const gammaRemoval = extensions.uninstallExtension('smoke-ext-gamma');
    const survivorSource = sourceRow('smoke-ext-edited');
    check(!sourceRow('smoke-ext-source') && gammaRemoval.removed.some((a) => a.kind === 'scout-source' && a.ref === 'smoke-ext-source'),
      'uninstalling removes the Scout source that still matches what the extension installed', gammaRemoval);
    check(!!survivorSource && survivorSource.owner === null && survivorSource.description === 'Rewritten by hand.'
      && gammaRemoval.kept.some((a) => a.ref === 'smoke-ext-edited') && /"smoke-ext-edited"/.test(gammaRemoval.detail),
    'a source edited after install survives the uninstall, is named in the summary, and is disowned rather than reverted', gammaRemoval.detail);

    const exportableSources = extensions.exportableConfiguration().scoutSources;
    check(exportableSources.some((s) => s.id === 'smoke-ext-edited') && !exportableSources.some((s) => s.id === 'claude-code-changelog'),
      'a save-as-extension offers the sources nobody owns and withholds the ones the built-in adopted', exportableSources);
    const savedSources = extensions.exportExtension({
      directory: path.join(dir, 'saved-scout'), id: 'smoke-ext-saved-scout', label: 'Saved sources',
      mcpServerIds: [], scoutSourceIds: ['smoke-ext-edited'],
    });
    const savedManifest = JSON.parse(fs.readFileSync(path.join(dir, 'saved-scout', EXTENSION_MANIFEST_FILE), 'utf8')) as {
      provides: { scoutSources?: { id: string; url: string; description: string }[] };
    };
    check(savedSources.ok && savedManifest.provides.scoutSources?.[0]?.id === 'smoke-ext-edited'
      && savedManifest.provides.scoutSources[0].url === survivorSource?.url
      && savedManifest.provides.scoutSources[0].description === 'Rewritten by hand.'
      && artifact(savedSources, 'smoke-ext-edited')?.kind === 'scout-source'
      && artifact(savedSources, 'smoke-ext-edited')?.applied === false,
    'an exported Scout source round-trips as the row stands and reads back as a valid extension whose source is already taken by the row it came from', savedSources.errors);
  } catch (error) {
    check(false, 'extensions smoke completed', String(error));
  } finally {
    for (const name of ['smoke-ext-fs', 'smoke-ext-two', 'smoke-ext-taken', 'smoke-ext-beta-ok']) {
      const row = db().prepare('SELECT id FROM mcp_servers WHERE name = ?').get(name) as { id: string } | undefined;
      if (row) registry.removeServer(row.id);
    }
    db().prepare("DELETE FROM improvement_scout_sources WHERE id LIKE 'smoke-ext-%'").run();
    // The shipped five go back to how this suite found them; the built-in row
    // is removed so the next suite reads a database no startup has touched.
    const restore = db().prepare('UPDATE improvement_scout_sources SET owner = ?, enabled = ?, updated_at = ? WHERE id = ?');
    for (const [id, before] of shippedBefore) {
      if (before) restore.run(before.owner, before.enabled, before.updated_at, id);
    }
    db().prepare("DELETE FROM plugin_artifacts WHERE plugin_id LIKE 'smoke-ext-%' OR plugin_id = ?").run(BUILTIN_ID);
    db().prepare("DELETE FROM plugins WHERE id LIKE 'smoke-ext-%' OR id = ?").run(BUILTIN_ID);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
