// Whether a local site runs, and why its page did not load: ddev's JSON as
// ddev 1.25 writes it, certificates as Node reads them, and the words each
// case gets. Every project, host, person and machine here is made up.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  altNames, certificateOf, covers, day, ddevStatus, diagnose, failureKind, principal, scriptStart, troubleText,
  type LiveCertFile, type LiveCertificate, type LiveFailure, type LivePresented, type LiveRun, type LiveStatus,
} from './live-site.ts';

/* ── ddev, shaped like `ddev describe -j` and `ddev list -j` from ddev v1.25.2 ── */

const describe = (over: Record<string, unknown>): string => JSON.stringify({
  level: 'info',
  msg: '┌──────────────────────────────────────┐\n│ Project: acme ~/Sites/acme https://acme.ddev.site │\n└──────────────────────────────────────┘',
  raw: {
    approot: '/Users/sam/Sites/acme', database_type: 'mariadb', database_version: '10.11',
    dbimg: 'ddev/ddev-dbserver-mariadb-10.11:v1.25.2',
    dbinfo: { database_type: 'mariadb', database_version: '10.11', dbPort: '3306', dbname: 'db', host: 'db', password: 'db', published_port: 0, username: 'db' },
    docroot: '', fail_on_hook_fail: false, hostname: 'acme.ddev.site', hostnames: ['acme.ddev.site'],
    httpURLs: ['http://acme.ddev.site'], httpsURLs: ['https://acme.ddev.site'], httpsurl: 'https://acme.ddev.site', httpurl: 'http://acme.ddev.site',
    mailpit_https_url: 'https://acme.ddev.site:8026', mailpit_url: 'http://acme.ddev.site:8025', mutagen_enabled: true, mutagen_status: 'ok',
    name: 'acme', nodejs_version: '22', performance_mode: 'mutagen', php_version: '8.3', primary_url: 'https://acme.ddev.site',
    router: 'traefik', router_disabled: false, router_http_port: '80', router_https_port: '443', router_status: 'healthy',
    router_status_log: 'container was previously healthy, so sleeping 59 seconds before continuing healthcheck... OK: http://:10999/ping',
    services: {
      db: { status: 'exited', full_name: 'ddev-acme-db', short_name: 'db', image: 'ddev/ddev-dbserver-mariadb-10.11:v1.25.2' },
      web: { status: 'exited', full_name: 'ddev-acme-web', short_name: 'web', image: 'ddev/ddev-webserver:v1.25.2', exposed_ports: '80,443,8025', host_ports: '', host_ports_mapping: [] },
    },
    shortroot: '~/Sites/acme', ssh_agent_status: 'healthy', status: 'paused', status_desc: 'paused', type: 'wordpress',
    urls: ['https://acme.ddev.site', 'http://acme.ddev.site'], webimg: 'ddev/ddev-webserver:v1.25.2', webserver_type: 'nginx-fpm',
    xdebug_enabled: false, xhgui_https_url: 'https://acme.ddev.site:8142', xhgui_status: 'disabled', xhgui_url: 'http://acme.ddev.site:8143', xhprof_mode: 'xhgui',
    ...over,
  },
  time: '2026-10-09T21:14:03-05:00',
});

const LIST = JSON.stringify({
  level: 'info',
  msg: '┌──────┬─────────┬──────────┐\n│ NAME │ STATUS  │ LOCATION │\n└──────┴─────────┴──────────┘',
  raw: [
    { approot: '/Users/sam/Sites/acme', docroot: '', httpsurl: 'https://acme.ddev.site', httpurl: 'http://acme.ddev.site', mailpit_https_url: 'https://acme.ddev.site:8026', mailpit_url: 'http://acme.ddev.site:8025', mutagen_enabled: true, mutagen_status: 'ok', name: 'acme', nodejs_version: '22', primary_url: 'https://acme.ddev.site', router: 'traefik', router_disabled: false, shortroot: '~/Sites/acme', status: 'stopped', status_desc: 'stopped', type: 'wordpress', xhgui_https_url: 'https://acme.ddev.site:8142', xhgui_url: 'http://acme.ddev.site:8143' },
    { approot: '/Users/sam/Sites/northwind', docroot: 'web', httpsurl: 'https://northwind.ddev.site', httpurl: 'http://northwind.ddev.site', mailpit_https_url: 'https://northwind.ddev.site:8026', mailpit_url: 'http://northwind.ddev.site:8025', mutagen_enabled: false, mutagen_status: '', name: 'northwind', nodejs_version: '22', primary_url: 'https://northwind.ddev.site', router: 'traefik', router_disabled: false, shortroot: '~/Sites/northwind', status: 'paused', status_desc: 'db: paused', type: 'drupal11', xhgui_https_url: 'https://northwind.ddev.site:8142', xhgui_url: 'http://northwind.ddev.site:8143' },
  ],
  time: '2026-10-09T21:14:03-05:00',
});

test('ddev describe -j: the project’s status, in ddev’s own words', () => {
  assert.deepEqual(ddevStatus(describe({}), ''), { state: 'paused', said: 'paused', name: 'acme' });
  assert.deepEqual(ddevStatus(describe({ status: 'running', status_desc: 'running' }), ''), { state: 'running', said: 'running', name: 'acme' });
  assert.deepEqual(ddevStatus(describe({ status: 'stopped', status_desc: 'stopped' }), ''), { state: 'stopped', said: 'stopped', name: 'acme' });
  assert.equal(ddevStatus(describe({ status: 'project directory missing', status_desc: 'project directory missing' }), '').state, 'other', 'a word Wanigan does not know is kept, not guessed');
  assert.equal(ddevStatus(describe({ status: 'project directory missing', status_desc: 'project directory missing' }), '').said, 'project directory missing');
  const warned = `${JSON.stringify({ level: 'warning', msg: 'Your ddev is out of date', time: 'x' })}\n${describe({ status: 'unhealthy', status_desc: 'web: unhealthy' })}`;
  assert.deepEqual(ddevStatus(warned, ''), { state: 'unhealthy', said: 'web: unhealthy', name: 'acme' }, 'other log lines are passed over');
});

test('ddev list -j: the project is picked by its folder, or its name', () => {
  assert.deepEqual(ddevStatus(LIST, '', { folder: '/Users/sam/Sites/northwind' }), { state: 'paused', said: 'db: paused', name: 'northwind' });
  assert.deepEqual(ddevStatus(LIST, '', { name: 'acme' }), { state: 'stopped', said: 'stopped', name: 'acme' });
  assert.equal(ddevStatus(LIST, '', { name: 'harbor' }).state, 'unknown', 'a project ddev does not list is not guessed at');
});

test('ddev’s failures: Docker unreachable, a project it cannot find, and output that is not ddev’s', () => {
  const docker = JSON.stringify({ level: 'fatal', msg: 'Could not connect to Docker. Please ensure Docker is installed and running.', time: 'x' });
  assert.equal(ddevStatus('', docker).state, 'docker-down');
  const missing = JSON.stringify({ level: 'fatal', msg: "Failed to describe project(s): could not find requested project 'harbor', you may need to use \"ddev start\" to add it to the project catalog", time: 'x' });
  const read = ddevStatus('', missing);
  assert.equal(read.state, 'unknown');
  assert.match(read.said, /could not find requested project 'harbor'/);
  assert.equal(ddevStatus('Segmentation fault', '').state, 'unknown');
  assert.equal(ddevStatus('', '').said, 'ddev said nothing Wanigan could read.');
});

test('the command that starts a dev script is the one its lock file names, or none', () => {
  assert.equal(scriptStart('dev', ['package-lock.json']), 'npm run dev');
  assert.equal(scriptStart('start', ['package-lock.json']), 'npm start');
  assert.equal(scriptStart('dev', ['pnpm-lock.yaml']), 'pnpm run dev');
  assert.equal(scriptStart('dev', ['yarn.lock']), 'yarn dev');
  assert.equal(scriptStart('dev', ['bun.lockb']), 'bun run dev');
  assert.equal(scriptStart('dev', []), null, 'no lock file: no guess');
});

/* ── certificates, as Node's X509Certificate writes them ── */

const FOREIGN_CA = 'O=mkcert development CA\nOU=pat@northwind-laptop.local (Pat Example)\nCN=mkcert pat@northwind-laptop.local';
const LOCAL_CA = 'O=mkcert development CA\nOU=sam@acme-mac.local (Sam Sample)\nCN=mkcert sam@acme-mac.local';
const LOCAL = principal(LOCAL_CA);

function cert(over: Partial<{ issuer: string; san: string; from: string; to: string; fp: string }> = {}): LiveCertificate {
  return certificateOf({
    subject: 'O=mkcert development certificate\nOU=pat@northwind-laptop.local (Pat Example)',
    issuer: over.issuer ?? FOREIGN_CA,
    subjectAltName: over.san ?? 'DNS:*.ddev.site, DNS:localhost, DNS:*.ddev.local, DNS:ddev-router, DNS:northwind.ddev.site, IP Address:127.0.0.1',
    validFrom: over.from ?? 'Mar  1 00:00:00 2023 GMT',
    validTo: over.to ?? 'Jun  1 00:00:00 2025 GMT',
    fingerprint256: over.fp ?? '03:88:4E:A9:BA:CC:69:13:FF:07:D9:D8:E1:4C:75:30:02:67:F5:81:CC:75:FB:53:A0:3F:57:03:F1:08:17:83',
  });
}

test('a certificate as Node reads it: who issued it, what it covers, when', () => {
  const c = cert();
  assert.deepEqual(c.issuer, { cn: 'mkcert pat@northwind-laptop.local', o: 'mkcert development CA', ou: 'pat@northwind-laptop.local (Pat Example)' });
  assert.deepEqual(c.names, ['*.ddev.site', 'localhost', '*.ddev.local', 'ddev-router', 'northwind.ddev.site', '127.0.0.1']);
  assert.equal(c.validTo, Date.UTC(2025, 5, 1));
  assert.equal(day(c.validTo), '1 Jun 2025');
  assert.deepEqual(altNames('DNS:"odd,name.example.test", DNS:acme.ddev.site'), ['odd,name.example.test', 'acme.ddev.site'], 'a quoted name keeps its comma');
  assert.deepEqual(principal('CN=Acme Root\\, Internal\nO=Acme'), { cn: 'Acme Root, Internal', o: 'Acme', ou: null });
  const bare = certificateOf({ subject: 'CN=acme.ddev.site', issuer: 'CN=acme.ddev.site', validFrom: 'x', validTo: 'y', fingerprint256: 'ab' });
  assert.deepEqual(bare.names, ['acme.ddev.site'], 'no alternative names: its common name');
});

test('a wildcard covers one label, as browsers match it', () => {
  const names = ['*.ddev.site', 'northwind.ddev.site'];
  assert.equal(covers(names, 'northwind.ddev.site'), 'exact');
  assert.equal(covers(names, 'acme.ddev.site'), 'wildcard');
  assert.equal(covers(names, 'ACME.ddev.site.'), 'wildcard');
  assert.equal(covers(names, 'shop.acme.ddev.site'), null, 'two labels are not one');
  assert.equal(covers(names, 'ddev.site'), null);
  assert.equal(covers(names, 'acme.lndo.site'), null);
});

test('which failures are certificates, which are nobody answering', () => {
  assert.equal(failureKind({ code: -202, description: 'ERR_CERT_AUTHORITY_INVALID' }), 'certificate');
  assert.equal(failureKind({ code: 0, description: 'net::ERR_CERT_DATE_INVALID' }), 'certificate', 'a fetch’s error says it the same way');
  assert.equal(failureKind({ code: -107, description: 'ERR_SSL_PROTOCOL_ERROR' }), 'other', 'https to a plain http server is not a certificate problem');
  assert.equal(failureKind({ code: -102, description: 'ERR_CONNECTION_REFUSED' }), 'no-answer');
  assert.equal(failureKind({ code: -105, description: 'ERR_NAME_NOT_RESOLVED' }), 'no-answer');
});

/* ── what each case says ── */

const NOW = Date.UTC(2026, 9, 9, 21);
const DDEV_RUN: LiveRun = { tool: 'ddev', state: 'running', said: 'running', start: 'ddev start', folder: '/Users/sam/Sites/acme', name: 'acme' };

function status(run: Partial<LiveRun> = {}, certificates: LiveCertFile[] = [], hostnames = ['acme.ddev.site']): LiveStatus {
  return { projectId: 'p1', run: { ...DDEV_RUN, ...run }, hostnames, certificates, busy: null, checkedAt: NOW };
}

function refused(c: LiveCertificate, over: Partial<LivePresented> = {}, host = 'acme.ddev.site'): LiveFailure {
  return {
    code: -202, description: 'ERR_CERT_AUTHORITY_INVALID', url: `https://${host}/`,
    certificate: { certificate: c, local: false, authority: LOCAL, caroot: '/Users/sam/Library/Application Support/mkcert', verdict: 'net::ERR_CERT_AUTHORITY_INVALID', ...over },
  };
}

const everything = (t: ReturnType<typeof diagnose>): string => JSON.stringify(t);

test('the evening it went wrong: a paused WordPress site, and ddev’s router answering with another project’s expired wildcard', () => {
  const t = diagnose({ host: 'acme.ddev.site', status: status({ state: 'paused', said: 'paused' }), failure: refused(cert()), now: NOW });
  assert.ok(t);
  assert.equal(t.kind, 'not-running');
  assert.equal(t.title, 'This site isn’t running');
  assert.equal(t.lines[0], 'ddev says it is paused.');
  assert.match(t.lines[1] ?? '', /not this site’s: with no route to acme\.ddev\.site, ddev’s router answered with a wildcard certificate for \*\.ddev\.site, localhost, \*\.ddev\.local and 3 more, issued by the mkcert authority of “pat@northwind-laptop\.local \(Pat Example\)”\. Starting the site puts its own certificate back\./);
  assert.equal(t.action, 'start');
  assert.match(t.steps[0] ?? '', /ddev start in \/Users\/sam\/Sites\/acme/);
  assert.equal(t.chromium, null, 'no certificate error is shown for a site that is not running');
  assert.doesNotMatch(everything(t), /mkcert -install|does not trust/);
  assert.equal(troubleText(t).split('. ')[0], 'This site isn’t running');
});

test('a paused or stopped site is said before the page loads, and a router 404 is named for what it is', () => {
  const before = diagnose({ host: 'acme.ddev.site', status: status({ state: 'stopped', said: 'stopped' }), failure: null, now: NOW });
  assert.equal(before?.kind, 'not-running');
  assert.deepEqual(before?.lines, ['ddev says it is stopped.']);
  const notFound = diagnose({ host: 'acme.ddev.site', status: status({ state: 'paused', said: 'db: paused' }), failure: null, httpStatus: 404, now: NOW });
  assert.equal(notFound?.lines[0], 'ddev says it is paused (db: paused).');
  assert.match(notFound?.lines[1] ?? '', /\(404\) was ddev’s router/);
  assert.equal(diagnose({ host: 'acme.ddev.site', status: status(), failure: null, httpStatus: 404, now: NOW }), null, 'a running site’s own 404 is its page');
  assert.equal(diagnose({ host: 'acme.ddev.site', status: status(), failure: null, now: NOW }), null);
});

test('until ddev answers, a failure is not explained', () => {
  const t = diagnose({ host: 'acme.ddev.site', status: null, failure: refused(cert()), now: NOW });
  assert.equal(t?.kind, 'checking');
  assert.doesNotMatch(everything(t), /mkcert|certificate was made/);
});

test('ddev’s other states: starting, unhealthy, a word Wanigan does not know, and Docker not running', () => {
  assert.equal(diagnose({ host: 'acme.ddev.site', status: status({ state: 'starting', said: 'starting' }), failure: null, now: NOW })?.title, 'This site is starting');
  const sick = diagnose({ host: 'acme.ddev.site', status: status({ state: 'unhealthy', said: 'web: unhealthy' }), failure: null, now: NOW });
  assert.equal(sick?.lines[0], 'ddev says it is unhealthy (web: unhealthy).');
  assert.equal(sick?.action, 'restart');
  const odd = diagnose({ host: 'acme.ddev.site', status: status({ state: 'other', said: 'project directory missing' }), failure: null, now: NOW });
  assert.deepEqual([odd?.title, odd?.lines[0], odd?.action], ['ddev doesn’t say this site is running', 'ddev says “project directory missing”.', null]);
  const docker = diagnose({ host: 'acme.ddev.site', status: status({ state: 'docker-down', said: 'Could not connect to Docker.' }), failure: refused(cert()), now: NOW });
  assert.deepEqual([docker?.kind, docker?.action], ['docker-down', null]);
});

test('a certificate this project keeps, made on another machine: which file, and what to do with it', () => {
  const file: LiveCertFile = { file: '.ddev/traefik/certs/northwind.crt', key: '.ddev/traefik/certs/northwind.key', tracked: true, generated: true, certificate: cert() };
  const t = diagnose({ host: 'northwind.ddev.site', status: status({}, [file], ['northwind.ddev.site']), failure: refused(cert(), {}, 'northwind.ddev.site'), now: NOW });
  assert.equal(t?.cause, 'committed');
  assert.equal(t?.title, 'This project keeps a certificate made on another machine');
  assert.match(t?.lines[0] ?? '', /^\.ddev\/traefik\/certs\/northwind\.crt is the certificate presented for northwind\.ddev\.site, and git tracks it\. It was issued by the mkcert authority of “pat@northwind-laptop\.local \(Pat Example\)”, not by this Mac’s, and it expired on 1 Jun 2025\.$/);
  assert.match(t?.steps[0] ?? '', /^Remove \.ddev\/traefik\/certs\/northwind\.crt and \.ddev\/traefik\/certs\/northwind\.key from the project \(git tracks it, so that is a change to commit\), then restart the site \(ddev restart\)/);
  assert.equal(t?.action, 'restart');
  assert.deepEqual(t?.facts.map((f) => f.label), ['Issued by', 'Issuer’s unit', 'Covers', 'Expired', 'File', 'This Mac’s authority']);
  assert.equal(t?.facts.find((f) => f.label === 'This Mac’s authority')?.value, 'mkcert sam@acme-mac.local');
  assert.equal(t?.chromium, 'ERR_CERT_AUTHORITY_INVALID');
});

test('another machine’s mkcert, not kept in the project: the issuer named as it states itself', () => {
  const c = cert({ san: 'DNS:northwind.ddev.site', to: 'Jan  1 00:00:00 2028 GMT' });
  const keptElsewhere: LiveCertFile = { file: '.ddev/custom_certs/old.crt', key: null, tracked: true, generated: false, certificate: cert({ fp: 'AA:BB' }) };
  const t = diagnose({ host: 'northwind.ddev.site', status: status({}, [keptElsewhere], ['northwind.ddev.site']), failure: refused(c, {}, 'northwind.ddev.site'), now: NOW });
  assert.equal(t?.cause, 'other-mkcert');
  assert.equal(t?.title, 'This certificate was made on another machine');
  assert.equal(t?.lines[0], 'It was issued by the mkcert authority of “pat@northwind-laptop.local (Pat Example)”, another machine’s; this Mac’s is the mkcert authority of “sam@acme-mac.local (Sam Sample)”.');
  assert.equal(t?.lines[1], 'This project also keeps .ddev/custom_certs/old.crt, issued by the mkcert authority of “pat@northwind-laptop.local (Pat Example)”.');
  assert.deepEqual(t?.facts.slice(0, 2), [{ label: 'Issued by', value: 'mkcert pat@northwind-laptop.local' }, { label: 'Issuer’s unit', value: 'pat@northwind-laptop.local (Pat Example)' }]);
  assert.equal(t?.action, 'restart');
});

test('a running ddev site answered by the router’s wildcard: the route is lost, so restart', () => {
  const t = diagnose({ host: 'acme.ddev.site', status: status(), failure: refused(cert()), now: NOW });
  assert.equal(t?.cause, 'router');
  assert.match(t?.lines[1] ?? '', /ddev says this site is running, so the router has lost its route to it\./);
  assert.equal(t?.action, 'restart');
  const unasked = diagnose({ host: 'acme.ddev.site', status: status({ state: 'unknown', said: 'timed out' }), failure: refused(cert()), now: NOW });
  assert.equal(unasked?.action, 'start', 'when ddev could not say, starting it is what helps if it is not running');
  assert.ok(unasked?.lines.includes('ddev did not say whether the site is running: timed out.'));
});

test('this Mac has no mkcert authority: mkcert -install, then restart', () => {
  const t = diagnose({ host: 'acme.ddev.site', status: status(), failure: refused(cert({ san: 'DNS:acme.ddev.site' }), { authority: null }), now: NOW });
  assert.equal(t?.cause, 'no-authority');
  assert.match(t?.lines[0] ?? '', /there is none in \/Users\/sam\/Library\/Application Support\/mkcert/);
  assert.match(t?.steps[0] ?? '', /^Run mkcert -install in a terminal, then restart the site \(ddev restart\)/);
  assert.equal(t?.facts.at(-1)?.value, 'none in /Users/sam/Library/Application Support/mkcert');
});

test('this Mac’s own certificate, expired, for another name, not yet valid, or refused for Chromium’s own reason', () => {
  const own = (over: Parameters<typeof cert>[0]): LiveCertificate => cert({ issuer: LOCAL_CA, ...over });
  const expired = diagnose({ host: 'acme.ddev.site', status: status(), failure: refused(own({ san: 'DNS:acme.ddev.site' }), { local: true }), now: NOW });
  assert.deepEqual([expired?.cause, expired?.title, expired?.action], ['expired', 'acme.ddev.site’s certificate expired on 1 Jun 2025', 'restart']);
  assert.match(expired?.lines[0] ?? '', /this Mac’s own mkcert authority/);

  const later = { from: 'Jan  1 00:00:00 2026 GMT', to: 'Jan  1 00:00:00 2028 GMT' };
  const named = diagnose({ host: 'shop.acme.ddev.site', status: status({}, [], ['acme.ddev.site', 'shop.acme.ddev.site']), failure: refused(own({ san: 'DNS:*.ddev.site, DNS:acme.ddev.site', ...later }), { local: true }, 'shop.acme.ddev.site'), now: NOW });
  assert.deepEqual([named?.cause, named?.action], ['wrong-name', 'restart']);
  assert.match(named?.steps[0] ?? '', /one of the project’s ddev hostnames: restart the site/);
  const stranger = diagnose({ host: 'shop.acme.ddev.site', status: status(), failure: refused(own({ san: 'DNS:acme.ddev.site', ...later }), { local: true }, 'shop.acme.ddev.site'), now: NOW });
  assert.deepEqual([stranger?.cause, stranger?.action], ['wrong-name', null]);
  assert.match(stranger?.steps[0] ?? '', /not one of the project’s ddev hostnames \(acme\.ddev\.site\)/);

  const early = diagnose({ host: 'acme.ddev.site', status: status(), failure: refused(own({ san: 'DNS:acme.ddev.site', from: 'Jan  1 00:00:00 2027 GMT', to: 'Jan  1 00:00:00 2029 GMT' }), { local: true }), now: NOW });
  assert.deepEqual([early?.cause, early?.title], ['not-yet-valid', 'acme.ddev.site’s certificate is not valid until 1 Jan 2027']);

  const fine = diagnose({ host: 'acme.ddev.site', status: status(), failure: { ...refused(own({ san: 'DNS:acme.ddev.site', ...later }), { local: true }), description: 'ERR_CERT_REVOKED', code: -201 }, now: NOW });
  assert.equal(fine?.cause, 'refused');
  assert.equal(troubleText(fine!), 'Chromium refused acme.ddev.site’s certificate. It was issued by this Mac’s mkcert authority, is in date and covers this address, so the reason is Chromium’s own: ERR_CERT_REVOKED.');
});

test('an authority that is not mkcert, and a certificate Wanigan never saw', () => {
  const lando = certificateOf({ subject: 'CN=harbor.lndo.site', issuer: 'CN=Lando Development CA\nO=Lando', subjectAltName: 'DNS:*.lndo.site', validFrom: 'Jan  1 00:00:00 2025 GMT', validTo: 'Jan  1 00:00:00 2030 GMT', fingerprint256: 'CC' });
  const run: LiveRun = { tool: 'lando', state: null, said: null, start: 'lando start', folder: '/Users/sam/Sites/harbor', name: null };
  const t = diagnose({ host: 'harbor.lndo.site', status: { ...status(), run, hostnames: [] }, failure: refused(lando, {}, 'harbor.lndo.site'), now: NOW });
  assert.deepEqual([t?.cause, t?.title, t?.action], ['untrusted', 'This Mac does not trust harbor.lndo.site’s certificate', null]);
  const unseen = diagnose({ host: 'acme.ddev.site', status: status(), failure: { ...refused(cert()), certificate: null }, now: NOW });
  assert.equal(unseen?.cause, 'unseen');
  assert.doesNotMatch(everything(unseen), /mkcert/);
});

test('nothing answering: how the site is started, from what the project says, and nothing guessed', () => {
  const refusedConn: LiveFailure = { code: -102, description: 'ERR_CONNECTION_REFUSED', url: 'http://localhost:5173/', certificate: null };
  const script = (start: string | null): LiveStatus => ({ ...status(), run: { tool: 'script', state: null, said: null, start, folder: '/Users/sam/code/acme-web', name: null }, hostnames: [] });
  const npm = diagnose({ host: 'localhost', status: script('npm run dev'), failure: refusedConn, now: NOW });
  assert.deepEqual([npm?.title, npm?.steps[0], npm?.action], ['Nothing answered at localhost', 'Start it with npm run dev in /Users/sam/code/acme-web, then reload.', null]);
  assert.equal(diagnose({ host: 'localhost', status: script(null), failure: refusedConn, now: NOW })?.steps[0], 'Start the dev script in /Users/sam/code/acme-web, then reload.');
  const lando = diagnose({ host: 'harbor.lndo.site', status: { ...status(), run: { tool: 'lando', state: null, said: null, start: 'lando start', folder: '/Users/sam/Sites/harbor', name: null } }, failure: refusedConn, now: NOW });
  assert.deepEqual([lando?.lines[0], lando?.steps[0]], ['This project runs on Lando (.lando.yml).', 'Start it with lando start in /Users/sam/Sites/harbor, then reload.']);
  const none = diagnose({ host: 'example.test', status: { ...status(), run: { tool: null, state: null, said: null, start: null, folder: '/Users/sam/x', name: null } }, failure: refusedConn, now: NOW });
  assert.equal(none?.lines[0], 'Nothing in the project says how this site is started.');
  const running = diagnose({ host: 'acme.ddev.site', status: status(), failure: refusedConn, now: NOW });
  assert.deepEqual([running?.lines[0], running?.action], ['ddev says the site is running, but nothing answered at this address.', 'restart']);
  const noDdev = diagnose({ host: 'acme.ddev.site', status: status({ state: 'no-ddev', said: null }), failure: refusedConn, now: NOW });
  assert.equal(noDdev?.action, null, 'ddev is not there to run');
  assert.match(noDdev?.lines[0] ?? '', /ddev is not on your shell’s PATH/);
});

test('any other failure gives Chromium’s reason, and nothing more', () => {
  const t = diagnose({ host: 'acme.ddev.site', status: status(), failure: { code: -107, description: 'ERR_SSL_PROTOCOL_ERROR', url: 'https://acme.ddev.site/', certificate: null }, now: NOW });
  assert.deepEqual([t?.kind, t?.title, t?.chromium], ['failed', 'acme.ddev.site did not load', 'ERR_SSL_PROTOCOL_ERROR']);
  assert.equal(troubleText(t!), 'acme.ddev.site did not load. Chromium gave this reason: ERR_SSL_PROTOCOL_ERROR.');
});

test('a failure that is Wanigan’s own words is not put in Chromium’s mouth', () => {
  const t = diagnose({ host: 'acme.ddev.site', status: status(), failure: { code: -7, description: 'The page did not finish loading within 30 seconds', url: 'https://acme.ddev.site/', certificate: null }, now: NOW });
  assert.deepEqual([t?.kind, t?.lines[0], t?.chromium], ['failed', 'The page did not finish loading within 30 seconds.', null]);
  assert.equal(troubleText(t!), 'acme.ddev.site did not load. The page did not finish loading within 30 seconds.');
});
