import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { app } from 'electron';
import { db } from './db';

type Check = (ok: boolean, label: string, detail?: unknown) => void;
type Say = (s: string) => void;

/*
 * Helper sweep · P11 — dependencies, finished. Real repositories, real git and
 * real per-turn checkpoints for which turn added a package; a loopback HTTP
 * server standing in for OSV and the two registries for the advisory lookup.
 * Nothing here reaches the network, and no agent runs.
 */

function repoFixture(prefix: string) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' }).toString();
  const write = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'smoke@wanigan.test');
  git('config', 'user.name', 'Smoke');
  return { dir, git, write };
}

function insertSession(id: string, projectId: string, projectPath: string, base: string) {
  const now = Date.now();
  db().prepare(`INSERT INTO session_log (id, conversation_id, provider_id, harness_id, project_id, project_path, project_name, started_at, ended_at, exit_code, worktree, baseline_head, baseline_dirty_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, null, 'claude', 'claude-code', projectId, projectPath, path.basename(projectPath),
    now - 60_000, now - 1_000, 0, null, base, JSON.stringify([]));
}

function bash(sessionId: string, command: string, ok = 1) {
  db().prepare('INSERT INTO session_events (session_id, at, event, tool_name, summary, duration_ms, ok, paths_json) VALUES (?,?,?,?,?,?,?,?)')
    .run(sessionId, Date.now(), 'PostToolUse', 'Bash', command, null, ok, null);
}

const tick = () => new Promise((r) => setTimeout(r, 12));
const pkg = (deps: Record<string, string>) => JSON.stringify({ name: 'app', version: '1.0.0', dependencies: deps }, null, 2) + '\n';

/** Item 1: which turn added each package, from real checkpoints in a real repository. */
export async function runDependencyTurnsSmoke(check: Check, say: Say): Promise<void> {
  say('── dependencies · which turn added each package');
  const repo = repoFixture('wanigan-dep-turns-');
  const checkpoints = await import('./checkpoints');
  const work = await import('./review-work');
  const { addProject, removeProject } = await import('./store');
  const sid = `p11-turns-${Date.now()}`;
  try {
    repo.write('package.json', pkg({ react: '^19.0.0' }));
    repo.write('README.md', '# app\n');
    repo.git('add', '-A'); repo.git('commit', '-qm', 'base');
    const base = repo.git('rev-parse', 'HEAD').trim();
    const project = await addProject(repo.dir);
    insertSession(sid, project.id, repo.dir, base);

    // Before launch: the operator's own uncommitted edit adds left-pad.
    repo.write('package.json', pkg({ react: '^19.0.0', 'left-pad': '1.3.0' }));
    checkpoints.__test.registerSessionCheckpoints({ sessionId: sid, cwd: repo.dir, hooksCapable: true, gitHead: base });
    await checkpoints.__test.awaitIdle(sid);

    // Turn 1 touches the README and runs an install that is not the one turn 2 needs.
    checkpoints.__test.enqueueBoundary(sid, 'turn-start');
    await checkpoints.__test.awaitIdle(sid); await tick();
    bash(sid, 'pip install requests');
    repo.write('README.md', '# app\n\nNow with retries.\n');
    await tick();
    checkpoints.__test.enqueueBoundary(sid, 'turn-end');
    await checkpoints.__test.awaitIdle(sid); await tick();

    // Turn 2 adds p-retry with an install command.
    checkpoints.__test.enqueueBoundary(sid, 'turn-start');
    await checkpoints.__test.awaitIdle(sid); await tick();
    bash(sid, 'npm install p-retry@6.2.0');
    repo.write('package.json', pkg({ react: '^19.0.0', 'left-pad': '1.3.0', 'p-retry': '6.2.0' }));
    await tick();
    checkpoints.__test.enqueueBoundary(sid, 'turn-end');
    await checkpoints.__test.awaitIdle(sid); await tick();
    await checkpoints.__test.finalizeSessionCheckpoints(sid);

    // After the last snapshot: zod, by hand, and a test run that is no install.
    repo.write('package.json', pkg({ react: '^19.0.0', 'left-pad': '1.3.0', 'p-retry': '6.2.0', zod: '3.23.8' }));
    bash(sid, 'npm test', 0);

    const rows = checkpoints.listCheckpoints(sid);
    check(rows.filter((r) => r.commitHash).length >= 5 && rows.some((r) => r.turn === 2 && r.kind === 'turn-end'),
      'the session captured a launch snapshot and a start and end snapshot for each of two turns', rows.map((r) => `${r.turn}:${r.kind}:${r.status}`));

    const deps = await work.dependencyReview(sid);
    const manifest = deps.manifests.find((m) => m.path === 'package.json');
    const byName = Object.fromEntries((manifest?.changes ?? []).map((c, i) => [c.name, manifest?.attributions?.[i] ?? null]));
    check(!!manifest && manifest.changes.map((c) => c.name).sort().join() === 'left-pad,p-retry,zod',
      'the branch diff finds three added packages', manifest?.changes);
    const pRetry = byName['p-retry'];
    const turn2Start = rows.find((r) => r.turn === 2 && r.kind === 'turn-start');
    const turn2End = rows.find((r) => r.turn === 2 && r.kind === 'turn-end');
    check(pRetry?.state === 'turn' && pRetry.turn === 2 && pRetry.fromCheckpoint === turn2Start?.id && pRetry.toCheckpoint === turn2End?.id,
      'p-retry is attributed to turn 2, between the two checkpoints the Turns tab opens for turn 2', pRetry);
    check(pRetry?.state === 'turn' && pRetry.install.state === 'ran' && pRetry.install.commands.length === 1
      && pRetry.install.commands[0].command === 'npm install p-retry@6.2.0',
      'turn 2 records that its own install command ran, and not turn 1\'s pip install', pRetry?.state === 'turn' ? pRetry.install : null);
    check(byName['left-pad']?.state === 'before-first-checkpoint',
      'left-pad, already in the working tree at launch, is "before the first checkpoint", not turn 1', byName['left-pad']);
    check(byName.zod?.state === 'outside-turns' && /since the last snapshot, after turn 2/.test(byName.zod.detail),
      'zod, added after the last snapshot, is "outside the recorded turns" and says where', byName.zod);

    const lean = await work.dependencyReview(sid, { turns: false });
    check(lean.manifests.every((m) => m.attributions === null), 'the advisory lookup reads the same review without paying for attribution');

    // A session with no checkpoints names no turn.
    const bare = `p11-bare-${Date.now()}`;
    insertSession(bare, project.id, repo.dir, base);
    const none = await work.dependencyReview(bare);
    check(none.manifests[0]?.attributions?.every((a) => a.state === 'no-checkpoints') === true,
      'a session with no checkpoints says so on every row instead of guessing a turn', none.manifests[0]?.attributions);

    // A snapshot whose manifest is broken stops the search rather than skipping past it.
    const broken = `p11-broken-${Date.now()}`;
    repo.write('package.json', pkg({ react: '^19.0.0' }));
    repo.git('add', '-A'); repo.git('commit', '-qm', 'reset');
    const base2 = repo.git('rev-parse', 'HEAD').trim();
    insertSession(broken, project.id, repo.dir, base2);
    checkpoints.__test.registerSessionCheckpoints({ sessionId: broken, cwd: repo.dir, hooksCapable: true, gitHead: base2 });
    await checkpoints.__test.awaitIdle(broken);
    checkpoints.__test.enqueueBoundary(broken, 'turn-start'); await checkpoints.__test.awaitIdle(broken); await tick();
    repo.write('package.json', '{ "dependencies": ');
    checkpoints.__test.enqueueBoundary(broken, 'turn-end'); await checkpoints.__test.awaitIdle(broken); await tick();
    checkpoints.__test.enqueueBoundary(broken, 'turn-start'); await checkpoints.__test.awaitIdle(broken); await tick();
    repo.write('package.json', pkg({ react: '^19.0.0', ms: '2.1.3' }));
    checkpoints.__test.enqueueBoundary(broken, 'turn-end'); await checkpoints.__test.awaitIdle(broken);
    await checkpoints.__test.finalizeSessionCheckpoints(broken);
    const unreadable = await work.dependencyReview(broken);
    const ms = unreadable.manifests[0]?.attributions?.[0];
    check(ms?.state === 'unknown' && /could not be read at the turn-end snapshot of turn 1/.test(ms.detail),
      'a manifest that could not be parsed at turn 1\'s end makes turn 2 unknown rather than first', ms);

    for (const id of [sid, bare, broken]) checkpoints.forgetSessionCheckpoints(id);
    removeProject(project.id);
  } catch (error) {
    check(false, 'the dependency-turn checks ran without throwing', error instanceof Error ? error.stack : String(error));
  } finally {
    try { fs.rmSync(repo.dir, { recursive: true, force: true }); } catch { /* temp */ }
  }
}

type Seen = { method: string; url: string; body: string };

/** Item 2: the opt-in advisory lookup, against a loopback stand-in for OSV, npm and PyPI. */
export async function runDependencyAdvisorySmoke(check: Check, say: Say): Promise<void> {
  say('── dependencies · advisory lookup (loopback stub)');
  const repo = repoFixture('wanigan-dep-advisories-');
  const advisories = await import('./dependency-advisories');
  const { addProject, removeProject } = await import('./store');
  const { egressReport } = await import('./egress');
  const seen: Seen[] = [];
  let mode: 'ok' | 'rate-limit' | 'slow' | 'short' | 'redirect' = 'ok';
  const HOUR = 3600_000;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', body });
      const json = (status: number, value: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(value));
      };
      if (mode === 'slow') return; // never answers; the client's timeout has to end it
      if (mode === 'rate-limit') return json(429, { error: 'slow down' }, { 'retry-after': '30' });
      if (mode === 'redirect') { res.writeHead(302, { location: 'http://203.0.113.9/elsewhere' }); res.end(); return; }
      if (req.url === '/osv/v1/querybatch' && req.method === 'POST') {
        const queries = (JSON.parse(body) as { queries: { package: { ecosystem: string; name: string }; version: string }[] }).queries;
        if (mode === 'short') return json(200, { results: [] });
        return json(200, { results: queries.map((q) => {
          if (q.package.name === 'flatmap-stream') return { vulns: [{ id: 'GHSA-mh6f-8j2x-4483', modified: '2021-09-15T20:08:26Z' }, { id: 'MAL-2025-20690', modified: '2025-08-14T18:52:04Z' }] };
          if (q.package.name === 'lodash') return { vulns: [{ id: 'GHSA-35jh-r3h4-6jhm', modified: '2026-09-10T03:49:04Z' }] };
          if (q.package.name === 'requests') return { vulns: [{ id: 'PYSEC-2018-28', modified: '2024-01-01T00:00:00Z' }] };
          return {};
        }) });
      }
      if (req.url?.startsWith('/npm/')) {
        const name = decodeURIComponent(req.url.slice('/npm/'.length));
        const times: Record<string, Record<string, string>> = {
          'flatmap-stream': { '0.1.1': '2018-09-05T00:00:00.000Z' },
          lodash: { '4.17.15': '2019-07-19T02:28:46.584Z' },
          'left-pad': { '1.3.0': '2018-04-09T01:10:45.796Z' },
          'fresh-pkg': { '2.0.0': new Date(Date.now() - 2 * HOUR).toISOString() },
        };
        return times[name] ? json(200, { name, time: times[name] }) : json(404, { error: 'Not found' });
      }
      if (req.url === '/pypi/requests/2.19.0/json') return json(200, { info: {}, urls: [{ upload_time_iso_8601: '2018-06-12T14:46:15.289074Z' }] });
      return json(404, {});
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  const sid = `p11-adv-${Date.now()}`;
  try {
    repo.write('package.json', pkg({ react: '^19.0.0' }));
    repo.write('requirements.txt', 'flask==3.0.3\n');
    repo.write('Cargo.toml', '[package]\nname = "app"\n[dependencies]\nanyhow = "1"\n');
    repo.git('add', '-A'); repo.git('commit', '-qm', 'base');
    const base = repo.git('rev-parse', 'HEAD').trim();
    const project = await addProject(repo.dir);
    insertSession(sid, project.id, repo.dir, base);
    repo.write('package.json', pkg({ react: '^19.0.0', 'flatmap-stream': '0.1.1', lodash: '^4.17.15', 'left-pad': '1.3.0', 'fresh-pkg': '2.0.0' }));
    repo.write('package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'app' }, 'node_modules/lodash': { version: '4.17.15' } } }));
    repo.write('requirements.txt', 'flask==3.0.3\nrequests==2.19.0\n');
    repo.write('Cargo.toml', '[package]\nname = "app"\n[dependencies]\nanyhow = "1"\nserde = "1.0"\n');

    advisories.__test.setEndpoints({ osv: `http://127.0.0.1:${port}/osv/v1/querybatch`, npm: `http://127.0.0.1:${port}/npm/`, pypi: `http://127.0.0.1:${port}/pypi/` });
    advisories.__test.clearCache();
    advisories.setAdvisoryLookupEnabled(false);

    // Off by default, and off means no request at all.
    check(advisories.advisoryLookupEnabled() === false, 'advisory lookups are off until the operator turns them on');
    let refused = '';
    try { await advisories.dependencyAdvisories(sid, { lookup: true }); } catch (e) { refused = String(e); }
    check(/Advisory lookups are off/.test(refused) && seen.length === 0, 'a lookup while the switch is off is refused in main, and nothing is sent', refused);
    const cold = await advisories.dependencyAdvisories(sid, { lookup: false });
    check(cold.mode === 'cache-only' && seen.length === 0 && cold.packages.every((p) => p.checkedAt === null),
      'opening the section reads the cache only: no request, and no package claims to have been checked', cold.packages.map((p) => [p.name, p.status]));
    let badToggle = '';
    try { advisories.setAdvisoryLookupEnabled('yes'); } catch (e) { badToggle = String(e); }
    check(/either on or off/.test(badToggle), 'the switch accepts a boolean and nothing else from the renderer');

    const egressOff = egressReport().hosts.filter((h) => ['api.osv.dev', 'registry.npmjs.org', 'pypi.org'].includes(h.host));
    check(egressOff.length === 3 && egressOff.every((h) => h.activeNow === false && /Check advisories/.test(h.when)),
      'the egress report lists api.osv.dev, registry.npmjs.org and pypi.org, inactive while the switch is off', egressOff.map((h) => [h.host, h.activeNow]));

    // On: one batch to OSV with exact versions only, one registry read per npm or PyPI package.
    advisories.setAdvisoryLookupEnabled(true);
    const report = await advisories.dependencyAdvisories(sid, { lookup: true });
    const posts = seen.filter((s) => s.method === 'POST');
    const sent = posts[0] ? JSON.parse(posts[0].body) as { queries: Record<string, unknown>[] } : { queries: [] };
    check(posts.length === 1 && posts[0].url === '/osv/v1/querybatch', 'the check sends one batch to OSV', seen.map((s) => `${s.method} ${s.url}`));
    const queried = sent.queries.map((q) => `${(q.package as { ecosystem: string; name: string }).ecosystem}:${(q.package as { name: string }).name}@${q.version as string}`).sort();
    check(JSON.stringify(queried) === JSON.stringify(['PyPI:requests@2.19.0', 'npm:flatmap-stream@0.1.1', 'npm:fresh-pkg@2.0.0', 'npm:left-pad@1.3.0', 'npm:lodash@4.17.15']),
      'OSV is asked about exact versions only — lodash from the lockfile, not the ^range — and not about the Cargo "1.0" requirement', queried);
    check(sent.queries.every((q) => Object.keys(q).sort().join() === 'package,version' && Object.keys(q.package as object).sort().join() === 'ecosystem,name'),
      'each query carries the ecosystem, name and version and nothing else');
    const gets = seen.filter((s) => s.method === 'GET').map((s) => s.url).sort();
    check(JSON.stringify(gets) === JSON.stringify(['/npm/flatmap-stream', '/npm/fresh-pkg', '/npm/left-pad', '/npm/lodash', '/pypi/requests/2.19.0/json']),
      'publish times are read for npm and PyPI packages only, one request each', gets);
    check(report.packages[0]?.name === 'flatmap-stream' && report.packages[0].advisories[0]?.id === 'MAL-2025-20690' && report.packages[0].malware === 1,
      'the package with a malware advisory is listed first, and its MAL- id comes before its GHSA id', report.packages.map((p) => p.name));
    const byName = Object.fromEntries(report.packages.map((p) => [p.name, p]));
    check(byName['fresh-pkg']?.published.state === 'read' && byName['fresh-pkg'].published.isNew === true
      && byName['left-pad']?.published.state === 'read' && byName['left-pad'].published.isNew === false,
      'a version published two hours ago is flagged new from the publish time actually read; an old one is not', [byName['fresh-pkg']?.published, byName['left-pad']?.published]);
    check(byName['left-pad']?.status === 'none-listed' && byName.serde?.status === 'not-exact' && byName.serde.published.state === 'not-covered',
      'nothing listed stays "none listed", a Cargo requirement is not looked up, and crates.io claims no publish time', [byName['left-pad']?.status, byName.serde?.status]);
    const cov = Object.fromEntries(report.coverage.map((c) => [c.ecosystem, c]));
    check(cov.npm?.advisories === 'covered' && cov.npm.publishTime === 'covered' && cov['crates.io']?.publishTime === 'not covered' && cov.PyPI?.advisories === 'covered',
      'coverage is reported per ecosystem', report.coverage.map((c) => [c.ecosystem, c.advisories, c.publishTime]));
    check(report.requests.reduce((n, r) => n + r.count, 0) === 6, 'the report counts the six requests it sent', report.requests);
    const stored = db().prepare('SELECT COUNT(*) AS n FROM dependency_lookup_cache').get() as { n: number };
    check(stored.n === 10, 'five advisory answers and five publish times are cached by ecosystem, name and version', stored.n);

    // The cache answers a second check with its age, and sends nothing.
    seen.length = 0;
    const again = await advisories.dependencyAdvisories(sid, { lookup: true });
    check(seen.length === 0 && again.packages.filter((p) => p.version).every((p) => p.status === 'not-exact' || p.fromCache) && again.requests.length === 0,
      'a second check within a day is answered from the cache, and no request is sent', seen.map((s) => s.url));
    advisories.__test.ageCache(25 * HOUR);
    seen.length = 0;
    const stale = await advisories.dependencyAdvisories(sid, { lookup: true });
    check(seen.filter((s) => s.method === 'POST').length === 1 && seen.filter((s) => s.method === 'GET').length === 0 && stale.packages.some((p) => p.checkedAt !== null && !p.fromCache),
      'a day-old advisory answer is asked again; a publish time, which cannot change, is not', seen.map((s) => `${s.method} ${s.url}`));

    // Failures, each with its reason, and none of them cached over an answer.
    mode = 'rate-limit';
    const limited = await advisories.dependencyAdvisories(sid, { lookup: true, refresh: true });
    const lp = limited.packages.find((p) => p.name === 'left-pad');
    check(lp?.status === 'error' && /HTTP 429/.test(lp.reason ?? '') && /wait 30 s/.test(lp.reason ?? '') && limited.coverage.find((c) => c.ecosystem === 'npm')?.advisories === 'error',
      'a rate limit is an error with its reason and the wait OSV asked for, and npm coverage reads error', lp?.reason);
    const afterLimit = await advisories.dependencyAdvisories(sid, { lookup: false });
    check(afterLimit.packages.find((p) => p.name === 'flatmap-stream')?.malware === 1,
      'the failed check did not overwrite the stored answers');
    mode = 'slow';
    advisories.__test.setTimeoutMs(300);
    const slow = await advisories.dependencyAdvisories(sid, { lookup: true, refresh: true });
    check(/did not answer within 300 ms/.test(slow.packages.find((p) => p.name === 'lodash')?.reason ?? ''), 'a timeout is reported as one', slow.packages.find((p) => p.name === 'lodash')?.reason);
    advisories.__test.setTimeoutMs(null);
    mode = 'short';
    const short = await advisories.dependencyAdvisories(sid, { lookup: true, refresh: true });
    check(/0 results for 5 packages/.test(short.packages.find((p) => p.name === 'lodash')?.reason ?? ''), 'an answer that does not match the batch is refused whole', short.packages.find((p) => p.name === 'lodash')?.reason);
    mode = 'redirect';
    const redirected = await advisories.dependencyAdvisories(sid, { lookup: true, refresh: true });
    check(redirected.packages.find((p) => p.name === 'lodash')?.status === 'error' && !seen.some((s) => s.url === '/elsewhere'),
      'a redirect is refused rather than followed to a host the Settings text did not name', redirected.packages.find((p) => p.name === 'lodash')?.reason);
    mode = 'ok';

    // The hosts are main's.
    const src = fs.readFileSync(path.join(app.getAppPath(), 'src/main/dependency-advisories.ts'), 'utf8');
    check(/osv: 'https:\/\/api\.osv\.dev\/v1\/querybatch'/.test(src) && /handle\('deps:advisories', \(sessionId: unknown, opts: unknown\) => dependencyAdvisories\(sessionId, opts\)\)/.test(src)
      && !/endpoint|url|host/i.test(src.slice(src.indexOf('export async function dependencyAdvisories'), src.indexOf('const lookup ='))),
      'the production URL is a constant and the channel takes a session id and options, never a host');
    const saved = process.env.WANIGAN_SMOKE;
    process.env.WANIGAN_SMOKE = '0';
    let fixed = '';
    try { advisories.__test.setEndpoints({ osv: 'http://evil.invalid', npm: 'http://evil.invalid', pypi: 'http://evil.invalid' }); } catch (e) { fixed = String(e); }
    process.env.WANIGAN_SMOKE = saved;
    check(/fixed outside the smoke suite/.test(fixed), 'the endpoint override refuses outside a smoke run');

    removeProject(project.id);
  } catch (error) {
    check(false, 'the advisory lookup checks ran without throwing', error instanceof Error ? error.stack : String(error));
  } finally {
    try { advisories.__test.setEndpoints(null); advisories.__test.setTimeoutMs(null); advisories.setAdvisoryLookupEnabled(false); } catch { /* reset */ }
    server.closeAllConnections?.();
    server.close();
    try { fs.rmSync(repo.dir, { recursive: true, force: true }); } catch { /* temp */ }
  }
}
