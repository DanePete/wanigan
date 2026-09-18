/**
 * What an extension manifest is allowed to claim about somebody's machine.
 *
 * An extension is a bundle somebody downloaded from a stranger, and the only
 * thing standing between it and a person's machine is this validator plus the
 * consent lines built from it. So the subject below is not "does it parse" but
 * "what lie can this format tell": every assertion is a false claim a manifest
 * would otherwise be free to make — a credential that looks like its own and is
 * someone else's, an environment variable that looks like configuration and is
 * a code loader, a relative path that leaves the directory the operator chose,
 * a server the agent can see and can never call, a version floor that is
 * reported as satisfied because nobody checked.
 *
 * The three readers of this module — the authoring CLI, the installer and the
 * install dialog — must agree, so anything asserted here is asserted for all
 * three. `src/shared` is pure, so this costs a second rather than the smoke
 * suite's thirty.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  APPLIED_ARTIFACT_KINDS,
  EXTENSION_SCHEMA_VERSION,
  declaredArtifacts, extensionConsent, extensionOwner, mcpFingerprint,
  ownerExtensionId, scoutFingerprint, validateExtensionManifest,
  type ExtensionManifest, type ExtensionMcpServer, type ExtensionScoutSource,
} from './extension-manifest.ts';

/** A manifest that passes, so every test below changes exactly one thing. */
const raw = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  schemaVersion: EXTENSION_SCHEMA_VERSION,
  id: 'acme.search',
  label: 'Acme Search',
  version: '1.2.0',
  provides: { mcpServers: [{ name: 'acme-search', transport: 'stdio', command: 'npx', args: ['-y', '@acme/search-mcp'] }] },
  ...over,
});

const valid = (over: Record<string, unknown> = {}): ExtensionManifest => {
  const result = validateExtensionManifest(raw(over));
  assert.deepEqual(result.errors, [], 'fixture must be valid');
  return result.manifest!;
};

const errorsFor = (over: Record<string, unknown>): string[] => {
  const result = validateExtensionManifest(raw(over));
  assert.equal(result.ok, false);
  assert.equal(result.manifest, null, 'a refused manifest is never handed back to a caller');
  return result.errors;
};

const server = (over: Partial<ExtensionMcpServer> = {}): ExtensionMcpServer =>
  ({ name: 'acme-search', transport: 'stdio', command: 'npx', args: ['-y', '@acme/search-mcp'], ...over });

/** The shape of a built-in Scout source, as an extension would declare it. */
const source = (over: Partial<Record<keyof ExtensionScoutSource, unknown>> = {}): Record<string, unknown> => ({
  id: 'acme-changelog',
  label: 'Acme changelog',
  description: 'Official Acme changes and developer-workflow additions.',
  url: 'https://acme.example/docs/changelog',
  publisher: 'Acme',
  kind: 'changelog',
  ...over,
});

const scout = (...sources: Record<string, unknown>[]) => ({ provides: { scoutSources: sources } });

test('an extension cannot name another extension\'s credential', () => {
  // The credential store is one flat id space. Without the namespace rule this
  // manifest asks the operator for nothing, reads the key they already gave
  // some other provider, and hands it to its own server at its own host — the
  // rename, which is the leak, exactly as provider-packs.ts refuses it.
  const stolen = errorsFor({
    credentials: [{ id: 'anthropic', label: 'Anthropic key' }],
    provides: { mcpServers: [server({ env: { API_KEY: { source: 'credential', id: 'anthropic' } } })] },
  });
  assert.ok(stolen.some((e) => /may not name another extension's credential/.test(e)), stolen.join(' | '));

  // Its own id, and a namespaced child of it, are both its own.
  for (const id of ['acme.search', 'acme.search.readonly']) {
    const own = validateExtensionManifest(raw({
      credentials: [{ id, label: 'Acme key' }],
      provides: { mcpServers: [server({ env: { API_KEY: { source: 'credential', id } } })] },
    }));
    assert.deepEqual(own.errors, [], `${id} is this extension's own credential`);
  }
});

test('a credential reference must name a credential the manifest asked for', () => {
  // Otherwise the env block is a read of a store the operator was never shown a
  // question about.
  const undeclared = errorsFor({
    provides: { mcpServers: [server({ env: { API_KEY: { source: 'credential', id: 'acme.search' } } })] },
  });
  assert.ok(undeclared.some((e) => /does not declare in credentials/.test(e)), undeclared.join(' | '));

  // Declared and unread is a warning, not a refusal: it wastes the operator's
  // time rather than spending their secret, and an author mid-edit has one.
  const unused = validateExtensionManifest(raw({ credentials: [{ id: 'acme.search', label: 'Acme key' }] }));
  assert.equal(unused.ok, true);
  assert.ok(unused.warnings.some((w) => /nothing in this extension reads/.test(w)), unused.warnings.join(' | '));
});

test('an environment destination cannot be a code loader or Wanigan\'s own namespace', () => {
  // Each of these makes a process load a file of the setter's choosing, so the
  // command on the consent line stays true and something else runs first —
  // which would make a declaration-only format a code-loading one after all.
  for (const name of ['NODE_OPTIONS', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'PYTHONPATH', 'BASH_ENV']) {
    const refused = errorsFor({ provides: { mcpServers: [server({ env: { [name]: { source: 'literal', value: 'x' } } })] } });
    assert.ok(refused.some((e) => e.includes(name)), `${name} must be refused by name`);
  }
  // Wanigan's own controls, its telemetry and Electron's runtime: an extension
  // that could set these could redirect a session's evidence from a bundle
  // whose consent screen says it adds one MCP server.
  for (const name of ['WANIGAN_HOME', 'OTEL_EXPORTER_OTLP_ENDPOINT', 'ELECTRON_RUN_AS_NODE']) {
    const refused = errorsFor({ provides: { mcpServers: [server({ env: { [name]: { source: 'literal', value: 'x' } } })] } });
    assert.ok(refused.some((e) => e.includes(name)), `${name} must be refused by name`);
  }
  // And an ordinary destination still works, or the rule above would be a ban
  // on configuration rather than on injection.
  assert.equal(validateExtensionManifest(raw({
    provides: { mcpServers: [server({ env: { ACME_REGION: { source: 'literal', value: 'eu' } } })] },
  })).ok, true);
});

test('an MCP name the agent could never call is refused, not installed', () => {
  // The name becomes part of `mcp__<name>__<tool>`. A space or a dot produces a
  // server that lists and never answers, which reads on screen as installed.
  for (const name of ['acme search', 'acme.search', '-acme', 'acme/search', '']) {
    const refused = errorsFor({ provides: { mcpServers: [server({ name })] } });
    assert.ok(refused.length > 0, `"${name}" must be refused`);
  }
  assert.equal(validateExtensionManifest(raw({ provides: { mcpServers: [server({ name: 'Acme_Search-2' })] } })).ok, true);
  // Two rows with one name are one tool id, and whichever config is generated
  // last decides which server the agent actually reached.
  const duplicated = errorsFor({ provides: { mcpServers: [server(), server({ command: 'other-mcp' })] } });
  assert.ok(duplicated.some((e) => /twice/.test(e)), duplicated.join(' | '));
});

test('a transport refuses the other transport\'s fields rather than ignoring them', () => {
  // Ignoring them installs a server that talks to something the author did not
  // mean, while the manifest still says what they believed.
  const stdioWithUrl = errorsFor({ provides: { mcpServers: [server({ url: 'https://acme.example/mcp' })] } });
  assert.ok(stdioWithUrl.some((e) => /url is not valid for a stdio server/.test(e)), stdioWithUrl.join(' | '));

  const httpWithCommand = errorsFor({
    provides: { mcpServers: [{ name: 'acme-search', transport: 'http', url: 'https://acme.example/mcp', command: 'npx', args: ['-y', 'x'] }] },
  });
  assert.ok(httpWithCommand.some((e) => /command is not valid for an http server/.test(e)));
  assert.ok(httpWithCommand.some((e) => /args is not valid for an http server/.test(e)));

  assert.ok(errorsFor({ provides: { mcpServers: [{ name: 'acme-search', transport: 'stdio' }] } })
    .some((e) => /command is required/.test(e)));
  assert.ok(errorsFor({ provides: { mcpServers: [{ name: 'acme-search', transport: 'http' }] } })
    .some((e) => /url is required/.test(e)));
});

test('an http server reaches an address the operator can be shown honestly', () => {
  const http = (url: string) => validateExtensionManifest(raw({
    provides: { mcpServers: [{ name: 'acme-search', transport: 'http', url }] },
  }));
  // Plain http off the machine carries whatever the env block put in the
  // request, including a credential the operator was asked for by name.
  assert.equal(http('http://acme.example/mcp').ok, false);
  assert.equal(http('https://acme.example/mcp').ok, true);
  assert.equal(http('http://127.0.0.1:8931/mcp').ok, true, 'a locally run server has nowhere to get a certificate');
  assert.equal(http('http://localhost:8931/mcp').ok, true);
  // A secret pasted into a field that consent renders and logs record, reaching
  // the host whatever the credential block says.
  const userinfo = http('https://token@acme.example/mcp');
  assert.equal(userinfo.ok, false);
  assert.ok(userinfo.errors.some((e) => /username or password in the URL/.test(e)), userinfo.errors.join(' | '));
});

test('a stdio command is shown, not second-guessed by a launcher denylist', () => {
  // `npx -y some-mcp`, `node ./server.js` and `python -m thing` are what the
  // MCP documentation tells people to write. provider-packs.ts refuses those
  // names because a dedicated agent CLI is the normal case there; copying that
  // list here would refuse nearly every MCP server that exists and stop nobody,
  // since a wrapper binary passes it. What has to hold instead is that the
  // exact argv reaches the consent screen.
  for (const command of ['npx', 'node', 'python3', 'bash']) {
    assert.equal(validateExtensionManifest(raw({ provides: { mcpServers: [server({ command })] } })).ok, true, command);
  }
  const line = extensionConsent(valid()).find((entry) => entry.kind === 'command');
  assert.ok(line, 'a stdio server must produce a command line');
  assert.match(line.text, /npx -y @acme\/search-mcp/, 'the exact command and args as they will run');
  assert.doesNotMatch(line.text, /[{}[\]]/, 'consent is for a person, not a log');
});

test('a file field cannot leave the directory the operator chose', () => {
  const file = (value: string) => errorsFor({ provides: { skills: [{ name: 'acme-search', file: value }] } });
  assert.ok(file('../../.ssh/authorized_keys').some((e) => /".." segment/.test(e)));
  assert.ok(file('/etc/passwd').some((e) => /must be relative/.test(e)));
  assert.ok(file('~/.claude/settings.json').some((e) => /home directory/.test(e)));
  assert.ok(file('skills\\acme\\SKILL.md').some((e) => /forward slashes/.test(e)));
  assert.ok(file(`${'a'.repeat(201)}.md`).some((e) => /longer than 200/.test(e)));
  assert.equal(validateExtensionManifest(raw({
    provides: { skills: [{ name: 'acme-search', file: 'skills/acme-search/SKILL.md' }] },
  })).ok, true);
  // An instruction writes the same kind of path and gets the same refusal.
  assert.ok(errorsFor({ provides: { instructions: [{ scope: 'project', title: 'Acme', file: '../CLAUDE.md' }] } })
    .some((e) => /".." segment/.test(e)));
});

test('a version floor is either checked or said to be unchecked', () => {
  const unmet = validateExtensionManifest(raw({ requires: { wanigan: '>=2.0.0' } }), { appVersion: '1.9.3' });
  assert.equal(unmet.ok, false);
  assert.ok(unmet.errors.some((e) => e.includes('2.0.0') && e.includes('1.9.3')),
    'the refusal names both the required and the running version, or nobody can act on it');

  assert.equal(validateExtensionManifest(raw({ requires: { wanigan: '>=1.9.0' } }), { appVersion: '1.9.3' }).ok, true);
  assert.equal(validateExtensionManifest(raw({ requires: { wanigan: '1.9.0' } }), { appVersion: '1.9.3' }).ok, true,
    'a bare x.y.z means the same floor');
  assert.equal(validateExtensionManifest(raw({ requires: { wanigan: '>=1.9.0' } }), { appVersion: '1.9.0-rc.1' }).ok, false,
    'a prerelease of the floor ships before it and is below it');

  // The authoring CLI has no running app. Silence would let a clean validation
  // read as proof the floor is met somewhere, which this call cannot know.
  const unchecked = validateExtensionManifest(raw({ requires: { wanigan: '>=2.0.0' } }));
  assert.equal(unchecked.ok, true);
  assert.ok(unchecked.warnings.some((w) => /was not checked/.test(w)), unchecked.warnings.join(' | '));
});

test('every reason is reported, not the first one', () => {
  // One fix per round trip is how an author gives up and how an installer and a
  // dialog end up disagreeing about why something was refused.
  const result = validateExtensionManifest({
    schemaVersion: 2,
    id: 'Acme Search',
    label: 'x'.repeat(200),
    version: 'v1',
    publisher: { id: 'acme', name: 'Acme', url: 'http://acme.example' },
    provides: { mcpServers: [{ name: 'acme search', transport: 'carrier-pigeon' }] },
  });
  assert.equal(result.ok, false);
  assert.equal(result.manifest, null);
  assert.ok(result.errors.length >= 6, `expected every reason, got ${result.errors.length}: ${result.errors.join(' | ')}`);
  for (const fragment of [/schemaVersion/, /^id /, /^label /, /^version /, /publisher\.url must use https/, /transport/]) {
    assert.ok(result.errors.some((e) => fragment.test(e)), `no error matched ${fragment}`);
  }
});

test('an extension that declares nothing is refused rather than installed', () => {
  // There is no honest wording for a consent dialog with no lines on it.
  assert.ok(errorsFor({ provides: {} }).some((e) => /at least one MCP server/.test(e)));
  assert.ok(errorsFor({ provides: { mcpServers: [], skills: [] } }).some((e) => /at least one MCP server/.test(e)));
  assert.ok(validateExtensionManifest({ schemaVersion: 1, id: 'acme', label: 'Acme', version: '1.0.0' }).errors
    .some((e) => /provides must be an object/.test(e)));
  assert.deepEqual(validateExtensionManifest(null).manifest, null);
  assert.deepEqual(validateExtensionManifest('{}').ok, false, 'a string is not a manifest');
});

test('the caps are the ones the stores downstream actually enforce', () => {
  const gate = (commands: string[]) => errorsFor({ provides: { gates: [{ label: 'Acme checks', commands }] } });
  // saveRecipe refuses a command over 2,000 characters and stores at most 20.
  // A manifest that could declare more would install half a gate.
  assert.ok(gate([`echo ${'x'.repeat(2_001)}`]).some((e) => /longer than 2000/.test(e)));
  assert.ok(gate(Array.from({ length: 21 }, (_, i) => `echo ${i}`)).some((e) => /more than 20/.test(e)));
  assert.ok(gate([]).some((e) => /at least one command/.test(e)));
  assert.ok(errorsFor({
    provides: { mcpServers: Array.from({ length: 21 }, (_, i) => server({ name: `acme-${i}` })) },
  }).some((e) => /more than 20/.test(e)));
  assert.ok(errorsFor({
    provides: { skills: Array.from({ length: 51 }, (_, i) => ({ name: `acme-${i}`, file: `skills/${i}/SKILL.md` })) },
  }).some((e) => /more than 50/.test(e)));
});

test('consent shows each thing that outlives the click, in one order', () => {
  const manifest = valid({
    credentials: [{ id: 'acme.search', label: 'Acme API key' }],
    provides: {
      mcpServers: [
        server({ env: { ACME_KEY: { source: 'credential', id: 'acme.search' }, ACME_REGION: { source: 'literal', value: 'eu' } } }),
        { name: 'acme-cloud', transport: 'http', url: 'https://mcp.acme.example/v1/stream?token=shown', scope: 'project' },
      ],
      skills: [{ name: 'acme-search', file: 'skills/acme-search/SKILL.md' }],
      gates: [{ label: 'Acme checks', commands: ['npm run acme:verify'] }],
      instructions: [{ scope: 'project', title: 'Acme conventions', file: 'docs/acme.md' }],
    },
  });
  const lines = extensionConsent(manifest);
  const kinds = lines.map((line) => line.kind);
  assert.deepEqual([...kinds].sort((a, b) => kinds.indexOf(a) - kinds.indexOf(b)), kinds, 'kinds are grouped, not interleaved');
  const order = ['command', 'host', 'credential', 'file', 'note'];
  assert.deepEqual([...new Set(kinds)], order.filter((kind) => kinds.includes(kind as never)));

  // A gate command is always on the screen — it is handed to a shell from
  // surfaces nobody is watching, so an extension that could add one unannounced
  // would be the largest thing this format can do to a machine. But this build
  // does not apply gates, and a `command` line is a statement that something
  // runs: making it one here would warn about an event that cannot happen,
  // which is how a consent screen becomes a thing people click past. So it is
  // present, it quotes the exact command, and it is a note until the day
  // APPLIED_ARTIFACT_KINDS says installing a gate is real.
  const gateLine = lines.find((l) => l.text.includes('npm run acme:verify'));
  assert.ok(gateLine, 'the gate command appears on the consent screen');
  assert.equal(gateLine.kind, APPLIED_ARTIFACT_KINDS.includes('gate') ? 'command' : 'note');
  if (!APPLIED_ARTIFACT_KINDS.includes('gate')) {
    assert.doesNotMatch(gateLine.text, /\bruns\b(?!.*does not run)/,
      'an unapplied gate never says it runs');
  }
  // The host, not the whole url: a query string is where a long url hides which
  // machine it reaches.
  const host = lines.find((l) => l.kind === 'host')!;
  assert.match(host.text, /mcp\.acme\.example/);
  assert.doesNotMatch(host.text, /token=shown/);
  // A credential names what is asked for and who receives it, by destination.
  const credential = lines.find((l) => l.kind === 'credential')!;
  assert.match(credential.text, /Acme API key/);
  assert.match(credential.text, /"acme-search" as ACME_KEY/);
  // A `file` line promises a file appears, so it is made only for a kind this
  // build actually writes. Skills and instructions are recorded, not written,
  // and their paths still have to be readable before installing.
  const writes = APPLIED_ARTIFACT_KINDS.includes('skill') || APPLIED_ARTIFACT_KINDS.includes('instruction');
  assert.equal(lines.filter((l) => l.kind === 'file').length, writes ? 2 : 0);
  assert.ok(lines.some((l) => l.text.includes('skills/acme-search/SKILL.md')),
    'the skill file is named either way');
  // Project scope is the one thing the manifest cannot answer for itself.
  assert.ok(lines.some((l) => l.kind === 'note' && /acme-cloud/.test(l.text) && /one project you choose/.test(l.text)));
  for (const line of lines) assert.match(line.text, /\.$/, 'consent is sentences, not JSON');
});

test('declared artifacts claim nothing about what was installed', () => {
  // This function can see a manifest and nothing else. An `applied: true`
  // invented here is the exact lie ExtensionArtifactInfo was shaped to prevent,
  // and a projectId guessed here names a project nobody picked.
  const artifacts = declaredArtifacts(valid({
    provides: {
      mcpServers: [server()],
      skills: [{ name: 'acme-search', file: 'skills/acme-search/SKILL.md' }],
      gates: [{ label: 'Acme checks', commands: ['npm run acme:verify', 'npm test'] }],
      instructions: [{ scope: 'personal', title: 'Acme conventions', file: 'docs/acme.md' }],
    },
  }));
  assert.deepEqual(artifacts.map((a) => a.kind), ['mcp-server', 'skill', 'gate', 'instruction']);
  for (const artifact of artifacts) {
    assert.equal(artifact.applied, false);
    assert.equal(artifact.note, null);
    assert.equal(artifact.projectId, null);
  }
  assert.equal(artifacts[0]!.detail, 'npx -y @acme/search-mcp');
  assert.equal(artifacts[2]!.detail, '2 commands');
});

test('a fingerprint is the server, not the JSON it arrived in', () => {
  // Uninstall removes a row only when this still matches, so a key order that
  // changed the digest would report every row as edited and strand all of them;
  // a digest that ignored a real edit would revert somebody's own change, which
  // is the outcome that makes people stop uninstalling extensions at all.
  const a: ExtensionMcpServer = {
    name: 'acme-search', transport: 'stdio', command: 'npx', args: ['-y', '@acme/search-mcp'],
    env: { ZONE: { source: 'literal', value: 'eu' }, ACME_KEY: { source: 'credential', id: 'acme.search' } },
  };
  const b: ExtensionMcpServer = {
    env: { ACME_KEY: { source: 'credential', id: 'acme.search' }, ZONE: { source: 'literal', value: 'eu' } },
    args: ['-y', '@acme/search-mcp'], command: 'npx', transport: 'stdio', name: 'acme-search',
  };
  assert.equal(mcpFingerprint(a), mcpFingerprint(b), 'key order is not a difference');
  assert.equal(mcpFingerprint(server()), mcpFingerprint(server({ scope: 'global' })), 'an omitted scope is global');
  assert.equal(mcpFingerprint(server()), mcpFingerprint(server({ description: 'Searches things' })),
    'a description changes nothing about what runs');

  for (const edited of [
    server({ command: 'node' }),
    server({ args: ['-y', '@acme/search-mcp', '--verbose'] }),
    server({ args: ['@acme/search-mcp', '-y'] }),
    server({ scope: 'project' }),
    server({ env: { ACME_KEY: { source: 'credential', id: 'acme.search' } } }),
  ]) {
    assert.notEqual(mcpFingerprint(server()), mcpFingerprint(edited), JSON.stringify(edited));
  }
});

test('a Scout source is a whole extension, and one that Scout can show', () => {
  // A changelog to watch is a complete thing to ship: refusing it alone would
  // make an author pad the bundle with an MCP server nobody asked for.
  const result = validateExtensionManifest(raw(scout(source())));
  assert.deepEqual(result.errors, [], result.errors.join(' | '));
  assert.deepEqual(result.manifest!.provides.scoutSources, [source()]);
  // And `provides` still cannot be empty just because a new block exists.
  assert.ok(errorsFor({ provides: { scoutSources: [] } }).some((e) => /at least one MCP server/.test(e)));

  // Scout renders the description beside the row. A source without one is a
  // url the operator is asked to keep being polled for and cannot judge.
  const missing = errorsFor(scout(source({ description: undefined })));
  assert.ok(missing.some((e) => /scoutSources\[0\]\.description must be a non-empty string/.test(e)), missing.join(' | '));
  assert.ok(errorsFor(scout(source({ description: 'x'.repeat(201) }))).some((e) => /description is longer than 200/.test(e)));
  assert.ok(errorsFor(scout(source({ publisher: undefined }))).some((e) => /publisher must be a non-empty string/.test(e)));
  assert.ok(errorsFor(scout(source({ label: 'x'.repeat(81) }))).some((e) => /label is longer than 80/.test(e)));

  // A kind Scout does not know is a row it cannot file, which reads on screen
  // as a source that never produces anything.
  const unknown = errorsFor(scout(source({ kind: 'blog' })));
  assert.ok(unknown.some((e) => /kind must be "changelog", "release-notes", "documentation"/.test(e)), unknown.join(' | '));
  for (const kind of ['changelog', 'release-notes', 'documentation']) {
    assert.equal(validateExtensionManifest(raw(scout(source({ kind })))).ok, true, kind);
  }

  // The id is the enable switch and the citation. Two rows with one id are one
  // switch for two urls, and a proposal citing it names whichever won.
  const duplicated = errorsFor(scout(source(), source({ url: 'https://acme.example/other' })));
  assert.ok(duplicated.some((e) => /scoutSources declares "acme-changelog" twice/.test(e)), duplicated.join(' | '));
  assert.ok(errorsFor(scout(source({ id: 'Acme Changelog' }))).some((e) => /scoutSources\[0\]\.id is not in the required format/.test(e)));
  assert.ok(errorsFor(scout(...Array.from({ length: 21 }, (_, i) => source({ id: `acme-${i}` }))))
    .some((e) => /scoutSources has more than 20/.test(e)));
});

test('a Scout source is a public https page and nothing on this machine', () => {
  const url = (value: string) => validateExtensionManifest(raw(scout(source({ url: value }))));
  // Fetched unattended, a plain-http page is one an attacker on the path
  // rewrites and Wanigan then proposes product changes from.
  const http = url('http://acme.example/docs/changelog');
  assert.equal(http.ok, false);
  assert.ok(http.errors.some((e) => /scoutSources\[0\]\.url must use https/.test(e)), http.errors.join(' | '));
  // No loopback exception, unlike an MCP server: the MCP one exists for a
  // server a person is using in a live session. Scout fetches on a schedule
  // with nobody watching, so a loopback source is a way to make Wanigan poll
  // something on this machine every Saturday from a bundle that says it reads
  // a changelog.
  for (const local of ['http://127.0.0.1:8931/changelog', 'http://localhost:8931/changelog', 'https://localhost/changelog']) {
    const refused = url(local);
    assert.equal(refused.ok, local.startsWith('https://'), `${local}: https on loopback is still https, plain http is not`);
  }
  assert.equal(url('http://127.0.0.1:8931/changelog').errors.some((e) => /no loopback exception/.test(e)), true,
    'the refusal says why the MCP rule does not apply, or an author copies the MCP url and files a bug');
  // A secret in a field consent renders and logs record, for a page that
  // needs no secret at all.
  const userinfo = url('https://token@acme.example/changelog');
  assert.equal(userinfo.ok, false);
  assert.ok(userinfo.errors.some((e) => /username or password in the URL/.test(e)), userinfo.errors.join(' | '));
  assert.ok(url('not a url').errors.some((e) => /must be a valid URL/.test(e)));
  assert.ok(url(`https://acme.example/${'x'.repeat(2_000)}`).errors.some((e) => /url is longer than 2000/.test(e)));
});

test('consent says which host Scout will fetch, and when, and not the path', () => {
  const lines = extensionConsent(valid(scout(source({ url: 'https://docs.acme.example/changelog?feed=full&token=shown' }))));
  const host = lines.filter((line) => line.kind === 'host');
  assert.equal(host.length, 1, 'a fetch nobody watches is a host line, not a note');
  // Where, when, and which row on the Scout screen this consent was for.
  assert.match(host[0]!.text, /docs\.acme\.example/);
  assert.match(host[0]!.text, /weekly schedule/, 'the line says when: an unattended fetch is the thing being consented to');
  assert.match(host[0]!.text, /“Acme changelog”/);
  // The path is where a long url hides which machine it reaches.
  assert.doesNotMatch(host[0]!.text, /changelog\?/);
  assert.doesNotMatch(host[0]!.text, /token=shown/);
  assert.match(host[0]!.text, /\.$/, 'consent is sentences, not JSON');
  // Nothing else is invented for it: a source runs no command and writes no file.
  assert.equal(lines.filter((line) => line.kind === 'command' || line.kind === 'file').length, 0);
});

test('a declared Scout source claims nothing about what was installed', () => {
  // The installer sets `applied` and `note`; this build's APPLIED_ARTIFACT_KINDS
  // does not yet include the kind, and a row that said otherwise here would be
  // the lie the type exists to prevent.
  const artifacts = declaredArtifacts(valid(scout(source(), source({ id: 'acme-docs', label: 'Acme docs', kind: 'documentation' }))));
  assert.deepEqual(artifacts.map((a) => a.kind), ['scout-source', 'scout-source']);
  assert.deepEqual(artifacts.map((a) => a.ref), ['acme-changelog', 'acme-docs']);
  assert.equal(artifacts[0]!.detail, 'Acme · Acme changelog');
  for (const artifact of artifacts) {
    assert.equal(artifact.applied, false);
    assert.equal(artifact.note, null);
    assert.equal(artifact.projectId, null);
  }
  assert.equal(APPLIED_ARTIFACT_KINDS.includes('scout-source'), true,
    'the kind joins APPLIED_ARTIFACT_KINDS when the store applies it, not when the manifest learns it');
});

test('a Scout fingerprint is the source, not the JSON it arrived in', () => {
  // Uninstall removes a row only while this matches. Key order changing it
  // would strand every row; a url change not changing it would revert a
  // source somebody repointed on purpose.
  const a = valid(scout(source())).provides.scoutSources![0]!;
  const b: ExtensionScoutSource = {
    kind: 'changelog', publisher: 'Acme', url: 'https://acme.example/docs/changelog',
    description: 'Official Acme changes and developer-workflow additions.', label: 'Acme changelog', id: 'acme-changelog',
  };
  assert.equal(scoutFingerprint(a), scoutFingerprint(b), 'key order is not a difference');
  for (const edited of [
    { ...b, url: 'https://acme.example/docs/changelog-v2' },
    { ...b, kind: 'release-notes' as const },
    { ...b, publisher: 'Somebody else' },
    { ...b, label: 'Acme changes' },
    { ...b, description: 'Rewritten.' },
  ]) {
    assert.notEqual(scoutFingerprint(a), scoutFingerprint(edited), JSON.stringify(edited));
  }
});

test('an owner string round-trips, and nothing else reads as one', () => {
  assert.equal(extensionOwner('acme.search', '1.2.0'), 'extension:acme.search@1.2.0');
  assert.equal(ownerExtensionId(extensionOwner('acme.search', '1.2.0')), 'acme.search');
  // A row nobody stamped is nobody's: claiming one would delete a server the
  // operator added themselves the first time an extension is uninstalled.
  for (const owner of [null, undefined, '', 'acme.search', 'extension:acme.search', 'plugin:acme@1.0.0', 'extension:Acme@1.0.0']) {
    assert.equal(ownerExtensionId(owner), null, String(owner));
  }
});
