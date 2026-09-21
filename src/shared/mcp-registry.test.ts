/**
 * The registry translator. Fixtures are shaped like live rows from
 * registry.modelcontextprotocol.io/v0.1/servers (schema 2025-12-11), trimmed to
 * the fields each test is about. Nothing here touches the network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extensionIdFor, isRegistryName, isRegistryVersion, manifestVersion, parseRegistryPage,
  translateRegistryEntry,
} from './mcp-registry.ts';
import { validateExtensionManifest } from './extension-manifest.ts';

const META = { 'io.modelcontextprotocol.registry/official': {
  status: 'active', isLatest: true, publishedAt: '2026-06-17T03:55:54Z', updatedAt: '2026-06-18T00:00:00Z',
} };

const row = (server: Record<string, unknown>, meta: Record<string, unknown> = META) => ({
  server: { name: 'com.acme/widgets', version: '1.2.3', description: 'Widgets for agents.', ...server },
  _meta: meta,
});

const npm = (over: Record<string, unknown> = {}) => ({
  registryType: 'npm', identifier: 'acme-widgets-mcp', version: '1.2.3', transport: { type: 'stdio' }, ...over,
});

const ok = (raw: unknown) => {
  const result = translateRegistryEntry(raw, 'mcp-registry');
  assert.equal(result.ok, true, result.ok ? '' : result.reason);
  if (!result.ok) throw new Error('unreachable');
  // Every manifest this file emits must be one the installer's own validator accepts.
  assert.equal(validateExtensionManifest(result.manifest).ok, true);
  return result;
};

const refused = (raw: unknown, pattern: RegExp) => {
  const result = translateRegistryEntry(raw, 'mcp-registry');
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('unreachable');
  assert.match(result.reason, pattern);
  // Refused is not hidden: the entry still exists, so the store can say why.
  if (result.entry) assert.equal(result.entry.install.kind, 'unsupported');
  return result;
};

test('an npm package installs as a pinned npx command, and a secret becomes a credential', () => {
  const { manifest, entry } = ok(row({ packages: [npm({
    environmentVariables: [
      { name: 'ACME_TOKEN', description: 'Your Acme API token.', isSecret: true, isRequired: true },
      { name: 'ACME_REGION', default: 'us-east-1' },
      { name: 'ACME_DEBUG' },
    ],
  })] }));
  const server = manifest.provides.mcpServers![0]!;
  assert.equal(server.transport, 'stdio');
  assert.equal(server.command, 'npx');
  // Pinned: unpinned, npx fetches whatever is newest on every launch and the
  // code changes underneath the approved digest.
  assert.deepEqual(server.args, ['-y', 'acme-widgets-mcp@1.2.3']);
  assert.deepEqual(server.env, {
    // Namespaced under the extension's own id: the manifest refuses a
    // credential named anywhere else, so no extension can read another's secret.
    ACME_TOKEN: { source: 'credential', id: 'mcp.com.acme.widgets.acme_token' },
    ACME_REGION: { source: 'literal', value: 'us-east-1' },
  });
  // Optional, no default: the server does not need it and asking would be noise.
  assert.equal(server.env!.ACME_DEBUG, undefined);
  assert.deepEqual(manifest.credentials, [{ id: 'mcp.com.acme.widgets.acme_token', label: 'ACME_TOKEN', help: 'Your Acme API token.' }]);
  assert.deepEqual(entry.asks, ['ACME_TOKEN']);
  assert.deepEqual(entry.install, { kind: 'npm', runtime: 'npx', package: 'acme-widgets-mcp', version: '1.2.3' });
  assert.equal(manifest.publisher!.name, 'com.acme');
});

test('pypi runs through uvx and a container through docker, secrets never in argv', () => {
  const py = ok(row({ packages: [npm({ registryType: 'pypi', identifier: 'acme_widgets' })] }));
  assert.equal(py.manifest.provides.mcpServers![0]!.command, 'uvx');
  assert.deepEqual(py.manifest.provides.mcpServers![0]!.args, ['acme_widgets==1.2.3']);

  const oci = ok(row({ packages: [npm({
    registryType: 'oci', identifier: 'ghcr.io/acme/widgets',
    environmentVariables: [{ name: 'ACME_TOKEN', isSecret: true }],
  })] }));
  const server = oci.manifest.provides.mcpServers![0]!;
  assert.equal(server.command, 'docker');
  // `-e NAME` with no value passes it through from the environment; the token
  // itself is in env, never in the argument list shown in process tables.
  assert.deepEqual(server.args, ['run', '-i', '--rm', '-e', 'ACME_TOKEN', 'ghcr.io/acme/widgets:1.2.3']);
  assert.ok(!server.args!.some((a) => /token/i.test(a) && a !== 'ACME_TOKEN'));
});

test('a container carries its pin in the image reference, as the registry publishes it', () => {
  // The live shape: tag inside the identifier, version null.
  const tagged = ok(row({ packages: [npm({ registryType: 'oci', identifier: 'ghcr.io/dinglebear-ai/soma:0.10.0', version: null })] }));
  assert.deepEqual(tagged.manifest.provides.mcpServers![0]!.args, ['run', '-i', '--rm', 'ghcr.io/dinglebear-ai/soma:0.10.0']);
  assert.deepEqual(tagged.entry.install, { kind: 'oci', runtime: 'docker', package: 'ghcr.io/dinglebear-ai/soma', version: '0.10.0' });

  // A registry host with a port is not mistaken for a tag.
  const port = ok(row({ packages: [npm({ registryType: 'oci', identifier: 'registry.acme.example:5000/team/tool:1.4.2', version: null })] }));
  assert.equal(port.entry.install.kind === 'oci' && port.entry.install.package, 'registry.acme.example:5000/team/tool');

  // A digest is the strongest pin there is.
  const sha = `sha256:${'a'.repeat(64)}`;
  const digested = ok(row({ packages: [npm({ registryType: 'oci', identifier: `docker.io/acme/tool@${sha}`, version: null })] }));
  assert.ok(digested.manifest.provides.mcpServers![0]!.args!.includes(`docker.io/acme/tool@${sha}`));

  // No tag, or `latest`, is whatever the image is on the day it is pulled.
  refused(row({ packages: [npm({ registryType: 'oci', identifier: 'docker.io/acme/tool', version: null })] }), /pin a version/);
  refused(row({ packages: [npm({ registryType: 'oci', identifier: 'docker.io/acme/tool:latest', version: null })] }), /pin a version/);
  // An untagged image with a separate version is pinned to that version.
  const split = ok(row({ packages: [npm({ registryType: 'oci', identifier: 'ghcr.io/acme/widgets', version: '2.0.0' })] }));
  assert.ok(split.manifest.provides.mcpServers![0]!.args!.includes('ghcr.io/acme/widgets:2.0.0'));
});

test('a hosted streamable-http endpoint installs as an http server', () => {
  const { manifest, entry } = ok(row({ remotes: [{ type: 'streamable-http', url: 'https://mcp.acme.example/v1' }] }));
  const server = manifest.provides.mcpServers![0]!;
  assert.equal(server.transport, 'http');
  assert.equal(server.url, 'https://mcp.acme.example/v1');
  assert.equal(server.command, undefined);
  assert.deepEqual(entry.install, { kind: 'remote', url: 'https://mcp.acme.example/v1' });
});

test('a local package is preferred over a hosted endpoint when both are published', () => {
  const { entry } = ok(row({
    remotes: [{ type: 'streamable-http', url: 'https://mcp.acme.example/v1' }],
    packages: [npm()],
  }));
  assert.equal(entry.install.kind, 'npm');
});

test('what cannot be installed honestly is refused with a reason, not guessed at', () => {
  refused(row({ remotes: [{ type: 'sse', url: 'https://mcp.acme.example/sse' }] }), /SSE/);
  refused(row({ remotes: [{ type: 'streamable-http', url: 'https://mcp.acme.example/v1',
    headers: [{ name: 'Authorization', isRequired: true, value: '{scheme} {token}' }] }] }), /several values/);
  refused(row({ remotes: [{ type: 'streamable-http', url: 'https://mcp.acme.example/v1',
    headers: [{ name: 'Host', isRequired: true, value: 'evil.example' }] }] }), /only the transport may set/);
  refused(row({ packages: [npm({ packageArguments: [{ type: 'positional', value: 'say "hi"' }] })] }), /double quote/);
  refused(row({ remotes: [{ type: 'streamable-http', url: 'http://mcp.acme.example/v1' }] }), /fixed https/);
  refused(row({ remotes: [{ type: 'streamable-http', url: 'https://{tenant}.acme.example/v1' }] }), /fixed https/);
  refused(row({ packages: [npm({ version: undefined })] }), /pin a version/);
  refused(row({ packages: [npm({ registryType: 'nuget' })] }), /nuget package/);
  refused(row({ packages: [npm({ transport: { type: 'streamable-http' } })] }), /network service/);
  refused(row({ packages: [npm({ packageArguments: [{ type: 'positional', isRequired: true, valueHint: 'directory' }] })] }),
    /cannot ask for/);
  refused(row({}), /neither a package nor a hosted endpoint/);
});

test('a package name cannot smuggle a flag into npx, uvx or docker', () => {
  refused(row({ packages: [npm({ identifier: '--registry=https://evil.example' })] }), /not one npm accepts/);
  refused(row({ packages: [npm({ registryType: 'pypi', identifier: '--index-url=https://evil.example' })] }), /not one PyPI accepts/);
  refused(row({ packages: [npm({ registryType: 'oci', identifier: '--privileged' })] }), /not one Docker accepts/);
  // And a version cannot either, because it is spliced into `pkg@version`.
  assert.equal(translateRegistryEntry(row({ version: '--help', packages: [npm()] }), 's').ok, false);
});

test('literal package arguments are kept; a named flag with no value is passed bare', () => {
  const { manifest } = ok(row({ packages: [npm({ packageArguments: [
    { type: 'named', name: '--mode', value: 'read-only' },
    { type: 'named', name: '--stdio', isRequired: true },
    { type: 'positional', value: 'serve' },
    { type: 'named', name: '--port', valueHint: 'port' },
  ] })] }));
  assert.deepEqual(manifest.provides.mcpServers![0]!.args,
    ['-y', 'acme-widgets-mcp@1.2.3', '--mode', 'read-only', '--stdio', 'serve']);
});

test('the extension id depends on the name alone, so a newer version is an update', () => {
  const one = ok(row({ version: '1.0.0', packages: [npm({ version: '1.0.0' })] }));
  const two = ok(row({ version: '2.0.0', packages: [npm({ version: '2.0.0' })] }));
  assert.equal(one.manifest.id, two.manifest.id);
  assert.equal(one.manifest.id, 'mcp.com.acme.widgets');
  assert.notEqual(one.manifest.version, two.manifest.version);

  // Long names are clipped to the manifest's 64 and kept unique by a hash of the full name.
  const long = (leaf: string) => extensionIdFor(`io.github.someone-with-a-long-handle/${leaf}`);
  const a = long('an-extremely-descriptive-server-name-number-one');
  const b = long('an-extremely-descriptive-server-name-number-two');
  // 44, not 64: a credential is `<id>.<name>` and that has to fit in 64 too.
  assert.ok(a.length <= 44 && b.length <= 44, `${a} / ${b}`);
  assert.notEqual(a, b);
  assert.equal(a, long('an-extremely-descriptive-server-name-number-one'));
  assert.match(a, /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/);
});

test('a leaf that names nothing borrows the title, so tool ids stay readable', () => {
  const { manifest } = ok(row({ name: 'ac.inference.sh/mcp', title: 'inference.sh',
    remotes: [{ type: 'streamable-http', url: 'https://api.inference.sh/mcp' }] }));
  assert.equal(manifest.provides.mcpServers![0]!.name, 'inference-sh');
  const plain = ok(row({ name: 'com.pulsemcp/playwright-stealth', packages: [npm()] }));
  assert.equal(plain.manifest.provides.mcpServers![0]!.name, 'playwright-stealth');
});

test('a version the manifest cannot hold is recorded as a prerelease; the package stays pinned to the original', () => {
  assert.equal(manifestVersion('1.2.3'), '1.2.3');
  assert.equal(manifestVersion('v1.2.3'), '1.2.3');
  // Three numeric parts is already a valid x.y.z to the manifest, calendar or not.
  assert.equal(manifestVersion('2026.09.01'), '2026.09.01');
  assert.equal(manifestVersion('1.0'), '0.0.0-1.0');
  assert.equal(manifestVersion('latest'), '0.0.0-latest');
  const { manifest } = ok(row({ version: '1.0', packages: [npm({ version: '1.0' })] }));
  assert.equal(manifest.version, '0.0.0-1.0');
  assert.deepEqual(manifest.provides.mcpServers![0]!.args, ['-y', 'acme-widgets-mcp@1.0']);
});

test('a page drops and counts what is malformed, skips what was withdrawn, and carries the cursor', () => {
  const page = parseRegistryPage({
    servers: [
      row({ packages: [npm()] }),
      row({ name: 'com.acme/gone', packages: [npm()] }, { 'io.modelcontextprotocol.registry/official': { status: 'deleted' } }),
      row({ name: 'com.acme/old', packages: [npm()] }, { 'io.modelcontextprotocol.registry/official': { status: 'deprecated' } }),
      row({ name: 'com.acme/sse-only', remotes: [{ type: 'sse', url: 'https://acme.example/sse' }] }),
      { server: { name: 'not a registry name', version: '1.0.0' } },
      'garbage',
    ],
    metadata: { nextCursor: 'com.acme/widgets:1.2.3', count: 6 },
  }, 'mcp-registry');
  assert.deepEqual(page.entries.map((e) => e.name), ['com.acme/widgets', 'com.acme/old', 'com.acme/sse-only']);
  assert.equal(page.dropped, 2);
  // Withdrawn is reported by name, so an incremental sync can remove it locally.
  assert.deepEqual(page.withdrawn, ['com.acme/gone']);
  assert.equal(page.nextCursor, 'com.acme/widgets:1.2.3');
  assert.equal(page.entries[1]!.deprecated, true);
  // Unsupported entries are listed with their reason, not silently removed.
  assert.equal(page.entries[2]!.install.kind, 'unsupported');
  assert.throws(() => parseRegistryPage({ nope: true }, 's'), /did not return a list of servers/);
});

test('names and versions a renderer sends back are checked before they reach a request path', () => {
  assert.equal(isRegistryName('com.acme/widgets'), true);
  for (const bad of ['../etc/passwd', 'com.acme/widgets/../../x', 'com.acme', '/widgets', 'com.acme/wid gets', 7, null]) {
    assert.equal(isRegistryName(bad), false, String(bad));
  }
  assert.equal(isRegistryVersion('1.2.3'), true);
  for (const bad of ['', '-1', '1.2.3/../x', '1 2', null]) assert.equal(isRegistryVersion(bad), false, String(bad));
});

test('display text from a stranger is folded to one line and clipped, never trusted as markup-free', () => {
  const { entry } = ok(row({ title: 'Widgets\n\u0007Pro', description: `Line one\r\n\tline two ${'x'.repeat(600)}`,
    packages: [npm()] }));
  assert.equal(entry.title, 'Widgets Pro');
  assert.ok(!/[\u0000-\u001f]/.test(entry.description));
  assert.ok(entry.description.length <= 500);
  assert.ok(entry.description.endsWith('…'));
});

test('a long id still leaves every credential valid and distinct', () => {
  const { manifest } = ok(row({
    name: 'io.github.someone-with-a-long-handle/an-extremely-descriptive-server-name',
    packages: [npm({ environmentVariables: [
      { name: 'A_VERY_LONG_ENVIRONMENT_VARIABLE_NAME_FOR_THE_PRIMARY_TOKEN', isSecret: true },
      { name: 'A_VERY_LONG_ENVIRONMENT_VARIABLE_NAME_FOR_THE_SECONDARY_TOKEN', isSecret: true },
    ] })],
  }));
  const ids = manifest.credentials!.map((c) => c.id);
  assert.equal(new Set(ids).size, 2, ids.join(' / '));
  for (const id of ids) {
    assert.ok(id.length <= 64, id);
    assert.ok(id.startsWith(`${manifest.id}.`), id);
  }
});

test('a hosted endpoint that needs a header asks for it, in the three shapes the registry uses', () => {
  const { manifest, entry } = ok(row({ remotes: [{ type: 'streamable-http', url: 'https://mcp.acme.example/v1', headers: [
    // The whole value is the secret; the description says what to paste.
    { name: 'X-API-Key', isRequired: true, isSecret: true, description: 'Your Acme key.' },
    // A template with a literal prefix and one variable.
    { name: 'Authorization', isRequired: true, value: 'Bearer {api_key}',
      variables: { api_key: { description: 'From the Acme dashboard.', isSecret: true } } },
    // A fixed value, sent as given.
    { name: 'Accept', isRequired: true, value: 'application/json, text/event-stream' },
    // Optional, even secret: left off, because the server works without it.
    { name: 'X-Tenant', isSecret: true, description: 'Optional.' },
  ] }] }));
  const server = manifest.provides.mcpServers![0]!;
  assert.deepEqual(server.headers, {
    'X-API-Key': { source: 'credential', id: 'mcp.com.acme.widgets.x_api_key' },
    Authorization: { source: 'credential', id: 'mcp.com.acme.widgets.api_key', prefix: 'Bearer ' },
    Accept: { source: 'literal', value: 'application/json, text/event-stream' },
  });
  assert.deepEqual(manifest.credentials, [
    { id: 'mcp.com.acme.widgets.x_api_key', label: 'X-API-Key', help: 'Your Acme key.' },
    { id: 'mcp.com.acme.widgets.api_key', label: 'api_key', help: 'From the Acme dashboard.' },
  ]);
  assert.deepEqual(entry.asks, ['X-API-Key', 'api_key']);
  assert.equal(entry.install.kind, 'remote');
});

