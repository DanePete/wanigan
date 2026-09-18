import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { db } from './db';
import * as registry from './mcp/registry';
import * as extensions from './extensions/store';
import { EXTENSION_MANIFEST_FILE, ownerExtensionId } from '../shared/extension-manifest';
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
  } catch (error) {
    check(false, 'extensions smoke completed', String(error));
  } finally {
    for (const name of ['smoke-ext-fs', 'smoke-ext-two', 'smoke-ext-taken', 'smoke-ext-beta-ok']) {
      const row = db().prepare('SELECT id FROM mcp_servers WHERE name = ?').get(name) as { id: string } | undefined;
      if (row) registry.removeServer(row.id);
    }
    db().prepare("DELETE FROM plugin_artifacts WHERE plugin_id LIKE 'smoke-ext-%'").run();
    db().prepare("DELETE FROM plugins WHERE id LIKE 'smoke-ext-%'").run();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
