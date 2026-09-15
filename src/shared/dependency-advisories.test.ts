/**
 * The advisory report's honesty rules, held without a network: unknown is never
 * safe, coverage is per ecosystem, a version is "new" only when a publish time
 * was read, malware comes first, and OSV's real answer shape — including its
 * empty-object zero case — is read exactly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADVISORY_EGRESS_TEXT, ECOSYSTEM_OF, ageLabel, assembleAdvisoryReport, exactVersion, isNewVersion, queryBatchBody,
  readNpmPublishTime, readPypiPublishTime, readQueryBatch, statusPhrase, type LookupRow,
} from './dependency-advisories.ts';

const NOW = Date.parse('2026-09-15T12:00:00Z');
const src = (manifest: string, spec: string) => [{ manifest, section: 'dependencies', change: 'added' as const, spec }];

test('only an exact version is looked up; ranges, references and platform requirements say why not', () => {
  assert.deepEqual(exactVersion('npm', 'lodash', '4.17.15'), { exact: '4.17.15' });
  assert.deepEqual(exactVersion('npm', 'lodash', 'v4.17.15'), { exact: '4.17.15' });
  assert.ok('notExact' in exactVersion('npm', 'lodash', '^4.17.15'));
  assert.ok('notExact' in exactVersion('npm', 'x', 'npm:lodash@4.17.15'));
  assert.ok('notExact' in exactVersion('npm', 'x', 'github:a/b'));
  assert.deepEqual(exactVersion('PyPI', 'requests', '==2.19.0'), { exact: '2.19.0' });
  assert.ok('notExact' in exactVersion('PyPI', 'requests', '>=2.19'));
  assert.ok('notExact' in exactVersion('PyPI', 'requests', '==2.*'));
  assert.deepEqual(exactVersion('Go', 'golang.org/x/text', 'v0.3.0'), { exact: 'v0.3.0' });
  assert.ok('notExact' in exactVersion('crates.io', 'serde', '1.0'), 'Cargo reads a bare version as a caret requirement');
  assert.deepEqual(exactVersion('crates.io', 'time', '=0.1.0'), { exact: '0.1.0' });
  const php = exactVersion('Packagist', 'php', '8.3.0');
  assert.ok('notExact' in php && /platform requirement/.test(php.notExact), 'composer\'s php requirement is not a package');
  assert.deepEqual(exactVersion('Packagist', 'drupal/core', '8.0.0'), { exact: '8.0.0' });
  assert.deepEqual(exactVersion('RubyGems', 'rails', '4.0.0'), { exact: '4.0.0' });
  assert.ok('notExact' in exactVersion('RubyGems', 'rails', '~> 7.2'));
  assert.ok('notExact' in exactVersion('npm', 'x', null));
});

test('every manifest kind maps to an OSV ecosystem name, and the request carries ecosystem, name and version only', () => {
  assert.deepEqual([...new Set(Object.values(ECOSYSTEM_OF))].sort(), ['Go', 'Packagist', 'PyPI', 'RubyGems', 'crates.io', 'npm']);
  const body = queryBatchBody([{ ecosystem: 'npm', name: 'lodash', version: '4.17.15' }]);
  assert.deepEqual(body, { queries: [{ package: { ecosystem: 'npm', name: 'lodash' }, version: '4.17.15' }] });
  assert.deepEqual(Object.keys(body.queries[0]).sort(), ['package', 'version']);
  assert.deepEqual(Object.keys(body.queries[0].package).sort(), ['ecosystem', 'name']);
  for (const host of ['api.osv.dev', 'registry.npmjs.org', 'pypi.org']) assert.ok(ADVISORY_EGRESS_TEXT.includes(host), host);
  assert.match(ADVISORY_EGRESS_TEXT, /ecosystem, name and version .* nothing else/);
});

test('OSV\'s real batch answer is read, with {} as "none listed" and next_page_token as "more"', () => {
  // Shapes from a real POST to api.osv.dev/v1/querybatch on 2026-09-15.
  const answer = readQueryBatch({ results: [
    { vulns: [{ id: 'GHSA-9x64-5r7x-2q53', modified: '2021-10-01T13:30:04Z' }, { id: 'MAL-2025-20690', modified: '2025-08-14T18:52:04Z' }] },
    {},
    { vulns: [{ id: 'DRUPAL-CORE-2018-001', modified: '2025-12-10T23:33:37.916235Z' }], next_page_token: 'abc' },
  ] }, 3);
  assert.ok(Array.isArray(answer));
  if (!Array.isArray(answer)) return;
  assert.equal(answer[0].advisories.length, 2);
  assert.deepEqual(answer[1], { advisories: [], more: false });
  assert.equal(answer[2].more, true);
  assert.match((readQueryBatch({ results: [{}] }, 2) as { error: string }).error, /1 results for 2 packages/);
  assert.match((readQueryBatch({ code: 3, message: 'invalid ecosystem' }, 1) as { error: string }).error, /without a result list/);
  assert.match((readQueryBatch({ results: [{ vulns: [{ id: '<script>' }] }] }, 1) as { error: string }).error, /no valid id/);
});

test('publish times are read from the registry documents\' real fields, and their absence is not a date', () => {
  assert.equal((readNpmPublishTime({ time: { '1.3.0': '2018-04-09T01:10:45.796Z' } }, '1.3.0') as { at: number }).at, Date.parse('2018-04-09T01:10:45.796Z'));
  assert.ok('notRead' in readNpmPublishTime({ time: {} }, '1.3.0'));
  assert.ok('notRead' in readNpmPublishTime({}, '1.3.0'));
  assert.equal((readPypiPublishTime({ urls: [{ upload_time_iso_8601: '2018-06-12T14:46:17.223245Z' }, { upload_time_iso_8601: '2018-06-12T14:46:15.289074Z' }] }) as { at: number }).at,
    Date.parse('2018-06-12T14:46:15.289074Z'), 'the earliest file is when the version was published');
  assert.ok('notRead' in readPypiPublishTime({ urls: [] }));
  assert.equal(isNewVersion(NOW - 71 * 3600_000, NOW), true);
  assert.equal(isNewVersion(NOW - 73 * 3600_000, NOW), false);
});

const row = (over: Partial<LookupRow> & Pick<LookupRow, 'name'>): LookupRow => ({
  ecosystem: 'npm', version: { exact: '1.0.0' }, sources: src('package-lock.json', '1.0.0'),
  osv: { state: 'answered', answer: { advisories: [], more: false }, checkedAt: NOW - 60_000, fromCache: false },
  publish: { state: 'read', at: NOW - 400 * 86_400_000 },
  ...over,
});

test('malware first, then advisories, then a new version; unknown and nothing-listed are never worded as safe', () => {
  const report = assembleAdvisoryReport({ mode: 'lookup', enabled: true, now: NOW, requests: [], notes: [], rows: [
    row({ name: 'left-pad' }),
    row({ name: 'lodash', version: { exact: '4.17.15' }, osv: { state: 'answered', answer: { advisories: [{ id: 'GHSA-35jh-r3h4-6jhm', modified: null }], more: false }, checkedAt: NOW, fromCache: false } }),
    row({ name: 'fresh-pkg', publish: { state: 'read', at: NOW - 3600_000 } }),
    row({ name: 'flatmap-stream', version: { exact: '0.1.1' }, osv: { state: 'answered', answer: { advisories: [{ id: 'GHSA-mh6f-8j2x-4483', modified: null }, { id: 'MAL-2025-20690', modified: null }], more: false }, checkedAt: NOW, fromCache: true } }),
    row({ name: 'offline', osv: { state: 'failed', reason: 'OSV did not answer within 15 s' }, publish: { state: 'failed', reason: 'registry.npmjs.org could not be reached' } }),
    row({ name: 'ranged', version: { notExact: 'a range, not an exact version' }, osv: { state: 'not-asked', reason: 'not an exact version' }, publish: { state: 'not-asked', reason: 'not an exact version' } }),
    row({ name: 'serde', ecosystem: 'crates.io', version: { exact: '1.0.200' }, publish: { state: 'not-covered' } }),
  ] });
  assert.deepEqual(report.packages.map((p) => p.name), ['flatmap-stream', 'lodash', 'fresh-pkg', 'offline', 'ranged', 'left-pad', 'serde']);
  const mal = report.packages[0];
  assert.deepEqual(mal.advisories.map((a) => a.id), ['MAL-2025-20690', 'GHSA-mh6f-8j2x-4483'], 'within a package the malware id is listed first');
  assert.equal(mal.malware, 1);
  assert.match(statusPhrase(mal), /^1 malware advisory and 1 advisory listed by OSV$/);
  assert.equal(report.packages[2].published.state === 'read' && report.packages[2].published.isNew, true);
  for (const p of report.packages) assert.doesNotMatch(statusPhrase(p), /(?<!not a finding that it is )\bsafe\b|\bclean\b|\bsecure\b/, p.name);
  assert.match(statusPhrase(report.packages.find((p) => p.name === 'left-pad')!), /not a finding that it is safe, or even that the package exists/);
  assert.match(statusPhrase(report.packages.find((p) => p.name === 'offline')!), /^unknown: OSV did not answer within 15 s$/);
  assert.equal(report.packages.find((p) => p.name === 'serde')!.published.state, 'not-covered', 'no publish time is claimed where none was read');

  const npm = report.coverage.find((c) => c.ecosystem === 'npm')!;
  assert.equal(npm.advisories, 'error');
  assert.equal(npm.advisoriesDetail, 'OSV did not answer within 15 s');
  assert.equal(npm.publishTime, 'error');
  const crates = report.coverage.find((c) => c.ecosystem === 'crates.io')!;
  assert.equal(crates.advisories, 'covered');
  assert.equal(crates.publishTime, 'not covered');
  assert.match(crates.publishDetail ?? '', /no version here is flagged as new/);
});

test('a version whose publish time was not read is never flagged new', () => {
  const report = assembleAdvisoryReport({ mode: 'lookup', enabled: true, now: NOW, requests: [], notes: [], rows: [
    row({ name: 'huge', publish: { state: 'not-read', reason: 'the registry document is over 32 MB' } }),
  ] });
  assert.deepEqual(report.packages[0].published, { state: 'not-read', reason: 'the registry document is over 32 MB' });
  assert.equal(ageLabel(NOW - 30_000, NOW), 'checked just now');
  assert.equal(ageLabel(NOW - 3 * 3600_000, NOW), 'checked 3 h ago');
  assert.equal(ageLabel(NOW - 26 * 3600_000, NOW), 'checked 1 day ago');
});
