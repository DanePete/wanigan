// Whether a project's local site is running, and why a page of it did not
// load. The core asks ddev and reads the certificate files the project keeps;
// the main process sees the certificate Chromium refused; this file decides
// what is true and what to do next, in the words the live view, its
// screenshots and the site helper's requests all use. Pure: no I/O.
// Design: docs/design/2026-10-08-live-view.md.

/* ── what runs the site ────────────────────────────────────────────────── */

export type LiveRunState =
  | 'running' | 'paused' | 'stopped' | 'starting' | 'unhealthy'
  /** Another of ddev's words, kept as it said it (e.g. "project directory missing"). */
  | 'other'
  /** ddev could not reach Docker. */
  | 'docker-down'
  /** The project has a ddev config, and ddev is not installed (or not on the shell's PATH). */
  | 'no-ddev'
  /** ddev failed, said something Wanigan could not read, or did not answer in time. */
  | 'unknown';

/** What runs a project's site, and (for ddev, the one Wanigan asks) what it says now. */
export interface LiveRun {
  /** Found in the project folder for the site's address: ddev, Lando, a dev script in package.json, or nothing known. */
  tool: 'ddev' | 'lando' | 'script' | null;
  /** What ddev says; null for anything Wanigan does not ask. */
  state: LiveRunState | null;
  /** ddev's own words for it (its status_desc, or its error); null when nothing was asked. */
  said: string | null;
  /** The command that starts the site, as the owner would type it in its folder; null when nothing says which. */
  start: string | null;
  /** The folder the site runs from, absolute. */
  folder: string;
  /** ddev's project name. */
  name: string | null;
}

/** A certificate file the project keeps where ddev looks for one. */
export interface LiveCertFile {
  /** Relative to the site's folder, e.g. `.ddev/traefik/certs/northwind.crt`. */
  file: string;
  /** Its key beside it (same name, .key), when there is one. */
  key: string | null;
  /** git tracks it: it came with the project, and removing it is a change to commit. */
  tracked: boolean;
  /** Its first line is ddev's `#ddev-generated` mark. */
  generated: boolean;
  certificate: LiveCertificate;
}

/** `live.siteStatus`: whether the project's site runs, and the certificates it keeps. */
export interface LiveStatus {
  projectId: string;
  run: LiveRun;
  /** The project's ddev hostnames, from its config (empty without ddev). */
  hostnames: string[];
  /** Certificates in the site's .ddev/traefik/certs and .ddev/custom_certs. */
  certificates: LiveCertFile[];
  /** A ddev start or restart Wanigan is running for the owner now, and its last lines. */
  busy: { command: string; output: string[] } | null;
  checkedAt: number;
}

/** What `live.start` did: the command, where, whether it worked, its last lines, and the site's status after. */
export interface LiveStartResult {
  ok: boolean;
  command: string;
  folder: string;
  output: string[];
  status: LiveStatus;
}

/** A ddev start or restart going on: a line it printed, or that it finished. */
export interface LiveRunEvent {
  projectId: string;
  command: string;
  line: string | null;
  done: boolean;
  ok: boolean | null;
}

const DDEV_WORDS: readonly LiveRunState[] = ['running', 'paused', 'stopped', 'starting', 'unhealthy'];

/**
 * What `ddev describe -j` (or `ddev list -j`) says about a project. ddev
 * writes JSON log entries, one a line: the project is the entry whose `raw`
 * holds a `status` (an array of them from `list`, picked by folder or name);
 * a failure is an entry at level fatal or error, on stderr. ddev's own words
 * are kept; a status word other than the five Wanigan knows is `other`.
 */
export function ddevStatus(stdout: string, stderr: string, want: { folder?: string; name?: string } = {}): { state: LiveRunState; said: string; name: string | null } {
  const entries: Record<string, unknown>[] = [];
  for (const line of `${stdout}\n${stderr}`.split('\n')) {
    const text = line.trim();
    if (!text.startsWith('{')) continue;
    try {
      const value = JSON.parse(text) as unknown;
      if (value && typeof value === 'object' && !Array.isArray(value)) entries.push(value as Record<string, unknown>);
    } catch { /* not a log entry */ }
  }
  for (const entry of entries) {
    const raw = entry.raw;
    const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : [];
    const projects = list.filter((p): p is Record<string, unknown> => !!p && typeof p === 'object' && typeof (p as { status?: unknown }).status === 'string');
    const project = projects.length === 1 && !Array.isArray(raw) ? projects[0]
      : projects.find((p) => (want.folder && p.approot === want.folder) || (want.name && p.name === want.name));
    if (!project) continue;
    const word = String(project.status).trim().toLowerCase();
    const desc = typeof project.status_desc === 'string' && project.status_desc.trim() ? project.status_desc.trim() : word;
    return {
      state: (DDEV_WORDS as readonly string[]).includes(word) ? word as LiveRunState : 'other',
      said: desc.slice(0, 300),
      name: typeof project.name === 'string' ? project.name : null,
    };
  }
  const failed = entries.find((e) => ['fatal', 'error', 'panic'].includes(String(e.level)) && typeof e.msg === 'string');
  const said = (typeof failed?.msg === 'string' ? failed.msg : `${stderr || stdout}`).trim().split('\n').slice(-3).join(' ').slice(0, 300);
  if (/docker/i.test(said) && /could not connect|cannot connect|not running|ensure docker|docker daemon|docker provider/i.test(said)) {
    return { state: 'docker-down', said, name: null };
  }
  return { state: 'unknown', said: said || 'ddev said nothing Wanigan could read.', name: null };
}

/**
 * The command that starts a dev script, from the lock file beside package.json
 * (the one tool it names); null when no lock file says which tool.
 */
export function scriptStart(script: 'dev' | 'start', lockfiles: readonly string[]): string | null {
  const has = (name: string): boolean => lockfiles.includes(name);
  if (has('pnpm-lock.yaml')) return script === 'start' ? 'pnpm start' : 'pnpm run dev';
  if (has('yarn.lock')) return script === 'start' ? 'yarn start' : 'yarn dev';
  if (has('bun.lock') || has('bun.lockb')) return `bun run ${script}`;
  if (has('package-lock.json')) return script === 'start' ? 'npm start' : 'npm run dev';
  return null;
}

/* ── certificates ──────────────────────────────────────────────────────── */

/** A certificate's subject or issuer, as it states them. */
export interface LivePrincipal { cn: string | null; o: string | null; ou: string | null }

export interface LiveCertificate {
  subject: LivePrincipal;
  issuer: LivePrincipal;
  /** The names it covers: its DNS names as written (`*.ddev.site`), and its IP addresses. */
  names: string[];
  validFrom: number;
  validTo: number;
  /** SHA-256 of the certificate, colon-separated hex, as Node writes it. */
  fingerprint: string;
}

/** The certificate a site presented and Chromium refused, as the main process saw it. */
export interface LivePresented {
  certificate: LiveCertificate;
  /** Issued by this Mac's mkcert authority: its issuer is that authority's subject, and its signature checks out with its key. */
  local: boolean;
  /** This Mac's mkcert authority; null when there is none. */
  authority: LivePrincipal | null;
  /** Where mkcert's authority was looked for ($CAROOT, or mkcert's own folder). */
  caroot: string;
  /** Chromium's verdict, e.g. `net::ERR_CERT_AUTHORITY_INVALID`. */
  verdict: string;
}

/** Why a page (or a request to the site) did not load, as the main process saw it. */
export interface LiveFailure {
  code: number;
  /** Chromium's own words, e.g. ERR_CERT_AUTHORITY_INVALID. */
  description: string;
  url: string;
  /** The certificate the site presented, when Chromium refused one. */
  certificate: LivePresented | null;
}

/** Node's distinguished name (`O=…\nOU=…\nCN=…`) as its common name, organisation and unit. */
export function principal(dn: string): LivePrincipal {
  const out: LivePrincipal = { cn: null, o: null, ou: null };
  for (const line of dn.split('\n')) {
    const m = /^\s*(CN|O|OU)=(.*)$/.exec(line);
    if (!m) continue;
    const key = (m[1] as string).toLowerCase() as keyof LivePrincipal;
    out[key] ??= (m[2] as string).replace(/\\(.)/g, '$1').trim().slice(0, 200) || null;
  }
  return out;
}

/** Node's subjectAltName (`DNS:*.ddev.site, IP Address:127.0.0.1`) as the names it covers. */
export function altNames(san: string | undefined | null): string[] {
  if (!san) return [];
  const out: string[] = [];
  const re = /(?:^|,\s*)(DNS|IP Address):("(?:[^"\\]|\\.)*"|[^,]*)/g;
  for (let m = re.exec(san); m && out.length < 200; m = re.exec(san)) {
    let value = (m[2] as string).trim();
    if (value.startsWith('"')) { try { value = JSON.parse(value) as string; } catch { continue; } }
    if (value) out.push(value);
  }
  return out;
}

/** A certificate as Node's X509Certificate reads it, in the terms the live view uses. */
export function certificateOf(x: { subject: string; issuer: string; subjectAltName?: string | null; validFrom: string; validTo: string; fingerprint256: string }): LiveCertificate {
  const subject = principal(x.subject);
  const names = altNames(x.subjectAltName);
  return {
    subject,
    issuer: principal(x.issuer),
    names: names.length ? names : subject.cn ? [subject.cn] : [],
    validFrom: Date.parse(x.validFrom),
    validTo: Date.parse(x.validTo),
    fingerprint: x.fingerprint256.toUpperCase(),
  };
}

/** Whether a certificate's names cover a host: by name, by a wildcard (one label, as browsers match it), or not at all. */
export function covers(names: readonly string[], host: string): 'exact' | 'wildcard' | null {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (names.some((n) => n.toLowerCase() === h)) return 'exact';
  for (const name of names) {
    const m = /^\*\.(.+)$/.exec(name.toLowerCase());
    if (!m) continue;
    const parent = m[1] as string;
    const label = h.endsWith(`.${parent}`) ? h.slice(0, -(parent.length + 1)) : '';
    if (label && !label.includes('.')) return 'wildcard';
  }
  return null;
}

/** mkcert made this authority (or this certificate's): its organisation, or its common name, says so. */
const isMkcert = (p: LivePrincipal): boolean => /^mkcert development (CA|certificate)$/i.test(p.o ?? '') || /^mkcert /i.test(p.cn ?? '');

/** Which kind of failure Chromium's words describe. */
export function failureKind(f: { code: number; description: string }): 'certificate' | 'no-answer' | 'other' {
  if (/ERR_CERT_/.test(f.description) || (f.code <= -200 && f.code > -300)) return 'certificate';
  if (/ERR_(CONNECTION_REFUSED|CONNECTION_FAILED|CONNECTION_RESET|CONNECTION_CLOSED|CONNECTION_TIMED_OUT|TIMED_OUT|NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED|ADDRESS_UNREACHABLE|EMPTY_RESPONSE|INTERNET_DISCONNECTED)\b/.test(f.description)) return 'no-answer';
  return 'other';
}

/* ── what to say ───────────────────────────────────────────────────────── */

export type LiveTroubleKind = 'checking' | 'not-running' | 'starting' | 'unhealthy' | 'ddev-other' | 'docker-down' | 'no-answer' | 'certificate' | 'failed';

export type LiveCertCause =
  /** This Mac has no mkcert authority. */
  | 'no-authority'
  /** A file the project keeps is the certificate presented, and another machine's mkcert made it. */
  | 'committed'
  /** ddev's router answered with a wildcard that is not this project's. */
  | 'router'
  /** Another machine's mkcert authority issued it. */
  | 'other-mkcert'
  | 'expired'
  | 'not-yet-valid'
  | 'wrong-name'
  /** An authority this Mac does not trust, and not mkcert's. */
  | 'untrusted'
  /** Nothing Wanigan can see is wrong with it: Chromium's reason is its own. */
  | 'refused'
  /** Chromium refused a certificate Wanigan did not see. */
  | 'unseen';

/** Why a page of the site is not shown, in words, with what is true and what to do next. */
export interface LiveTrouble {
  kind: LiveTroubleKind;
  cause: LiveCertCause | null;
  title: string;
  /** What is true, in sentences. */
  lines: string[];
  /** The certificate presented, described as it states itself. */
  facts: { label: string; value: string }[];
  /** What to do next, true for this case. Wanigan does none of it without a click. */
  steps: string[];
  /** The ddev command Wanigan can run in the site's folder, on the owner's click. */
  action: 'start' | 'restart' | null;
  /** Chromium's own words, when it gave any. */
  chromium: string | null;
}

export interface LiveTroubleInput {
  /** The host of the page that did not load. */
  host: string;
  /** What `live.siteStatus` said; null until it answers. */
  status: LiveStatus | null;
  failure: LiveFailure | null;
  /** The page's HTTP status, when one loaded. */
  httpStatus?: number | null;
  now: number;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A date as the live view writes it: 1 Jun 2025 (UTC, as certificates state them). */
export function day(ms: number): string {
  const d = new Date(ms);
  return Number.isFinite(ms) ? `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}` : 'an unreadable date';
}

/** An authority by the name it states: its common name, else its organisation. */
const nameOf = (p: LivePrincipal): string => p.cn ?? p.o ?? 'an authority with no name';

/**
 * An authority as its certificate states it, for a sentence. mkcert writes the
 * user, the machine and the person's name in its unit, so that is quoted; any
 * other authority by its common name.
 */
const fullName = (p: LivePrincipal): string => (isMkcert(p) && p.ou ? `the mkcert authority of “${p.ou}”` : `“${nameOf(p)}”`);

const listOf = (names: readonly string[], max = 6): string =>
  names.length <= max ? names.join(', ') : `${names.slice(0, max).join(', ')} and ${names.length - max} more`;

const NOT_RUNNING: readonly LiveRunState[] = ['paused', 'stopped'];

/**
 * Why the site's page is not shown, or null when nothing says it should not
 * be. What ddev says comes first: a site that is not running is never
 * reported as a certificate problem, whatever certificate ddev's router
 * answered with. A failure is not explained until `live.siteStatus` has answered.
 */
export function diagnose(input: LiveTroubleInput): LiveTrouble | null {
  const { status, failure, host } = input;
  const run = status?.run ?? null;
  if (run?.tool === 'ddev' && run.state && run.state !== 'running' && run.state !== 'no-ddev' && run.state !== 'unknown') {
    return ddevTrouble(run, host, failure, input.httpStatus ?? null);
  }
  if (!failure) return null;
  if (!status) {
    // Not even Chromium's words yet: a certificate error shown for a site that turns out not to be running misleads.
    return trouble('checking', `Finding out why ${host} did not load`, ['Asking what runs the site whether it is running…']);
  }
  const kind = failureKind(failure);
  if (kind === 'certificate') return certificateTrouble(input, status, failure);
  if (kind === 'no-answer') return noAnswer(host, status, failure);
  // Chromium's words are its error's name; anything else is Wanigan's own (a screenshot that never finished loading).
  const chromiums = /^(net::)?ERR_/.test(failure.description);
  return trouble('failed', `${host} did not load`, [chromiums ? 'Chromium gave this reason:' : `${failure.description}.`, ...askedNote(status.run)], { chromium: chromiums ? failure.description : null });
}

/** One paragraph for a toast or a card: the title, what is true, and Chromium's words where they were the reason given. */
export function troubleText(t: LiveTrouble): string {
  let said = false;
  const lines = t.lines.map((l) => {
    if (!l.endsWith(':')) return l;
    said = !!t.chromium;
    return t.chromium ? `${l} ${t.chromium}.` : `${l.slice(0, -1)}.`;
  });
  return [`${t.title}.`, ...lines, t.chromium && !said && t.kind !== 'not-running' ? `(${t.chromium})` : ''].filter(Boolean).join(' ');
}

function trouble(kind: LiveTroubleKind, title: string, lines: string[], more: Partial<Omit<LiveTrouble, 'kind' | 'title' | 'lines'>> = {}): LiveTrouble {
  return { kind, cause: null, title, lines, facts: [], steps: [], action: null, chromium: null, ...more };
}

/** ddev says the site is not running (or starting, or unhealthy, or can't reach Docker). */
function ddevTrouble(run: LiveRun, host: string, failure: LiveFailure | null, httpStatus: number | null): LiveTrouble {
  const said = run.said && run.said !== run.state ? ` (${run.said})` : '';
  if (run.state === 'docker-down') {
    return trouble('docker-down', 'Docker isn’t running', ['ddev could not connect to Docker, so no ddev site can run.'], {
      steps: ['Start Docker (the provider you use with ddev), then start the site.'],
      chromium: failure?.description ?? null,
    });
  }
  if (run.state === 'starting') {
    return trouble('starting', 'This site is starting', [`ddev says it is starting${said}.`], { steps: ['Reload when it has started.'], chromium: failure?.description ?? null });
  }
  if (run.state === 'unhealthy') {
    return trouble('unhealthy', 'This site isn’t healthy', [`ddev says it is unhealthy${said}.`], {
      steps: ['Restart it (ddev restart). If it stays unhealthy, ddev logs in its folder says why.'],
      action: 'restart', chromium: failure?.description ?? null,
    });
  }
  if (run.state && !NOT_RUNNING.includes(run.state)) {
    return trouble('ddev-other', 'ddev doesn’t say this site is running', [`ddev says “${run.said ?? run.state}”.`], {
      steps: ['ddev describe in the site’s folder says more.'], chromium: failure?.description ?? null,
    });
  }
  const lines = [`ddev says it is ${run.state}${said}.`];
  const presented = failure?.certificate?.certificate;
  if (presented && covers(presented.names, host) === 'wildcard') {
    lines.push(`The certificate Chromium refused is not this site’s: with no route to ${host}, ddev’s router answered with a wildcard certificate for ${listOf(presented.names, 3)}, issued by ${fullName(presented.issuer)}. Starting the site puts its own certificate back.`);
  } else if (!failure && httpStatus !== null && httpStatus >= 400) {
    lines.push(`The page that loaded (${httpStatus}) was ddev’s router, which has no route to a site that isn’t running.`);
  }
  return trouble('not-running', 'This site isn’t running', lines, {
    steps: [`Start it: Wanigan runs ddev start in ${run.folder}, shows what it says, then loads the page.`],
    action: 'start',
    chromium: null,
  });
}

/** When Wanigan could not ask ddev, the trouble says so, rather than guess whether it runs. */
function askedNote(run: LiveRun): string[] {
  if (run.tool !== 'ddev') return [];
  if (run.state === 'no-ddev') return ['This project has a ddev config, and ddev is not on your shell’s PATH, so Wanigan could not ask whether the site is running.'];
  if (run.state === 'unknown') return [`ddev did not say whether the site is running: ${run.said ?? 'no answer'}.`];
  return [];
}

function noAnswer(host: string, status: LiveStatus, failure: LiveFailure): LiveTrouble {
  const run = status.run;
  const title = `Nothing answered at ${host}`;
  const chromium = failure.description;
  if (run.tool === 'ddev' && run.state === 'running') {
    return trouble('no-answer', title, ['ddev says the site is running, but nothing answered at this address.'], {
      steps: ['Restart it (ddev restart), then reload.'], action: 'restart', chromium,
    });
  }
  if (run.tool === 'ddev') {
    return trouble('no-answer', title, askedNote(run), {
      steps: [`Start it (ddev start in ${run.folder}), then reload.`], action: run.state === 'no-ddev' ? null : 'start', chromium,
    });
  }
  if (run.tool === 'lando') {
    return trouble('no-answer', title, ['This project runs on Lando (.lando.yml).'], { steps: [`Start it with lando start in ${run.folder}, then reload.`], chromium });
  }
  if (run.tool === 'script') {
    return trouble('no-answer', title, ['This address is served by the dev script in package.json.'], {
      steps: [run.start ? `Start it with ${run.start} in ${run.folder}, then reload.` : `Start the dev script in ${run.folder}, then reload.`], chromium,
    });
  }
  return trouble('no-answer', title, ['Nothing in the project says how this site is started.'], { steps: ['Start it the way you usually do, then reload.'], chromium });
}

function certificateTrouble(input: LiveTroubleInput, status: LiveStatus, failure: LiveFailure): LiveTrouble {
  const { host, now } = input;
  const run = status.run;
  const ddev = run.tool === 'ddev' && run.state !== 'no-ddev';
  const chromium = failure.description;
  const presented = failure.certificate;
  if (!presented) {
    return { ...trouble('certificate', `Chromium refused ${host}’s certificate`, ['Wanigan did not see the certificate itself, so it cannot say why.', ...askedNote(run)], { chromium }), cause: 'unseen' };
  }
  const cert = presented.certificate;
  const issuer = cert.issuer;
  const cover = covers(cert.names, host);
  const expired = now > cert.validTo;
  const early = now < cert.validFrom;
  const match = status.certificates.find((f) => f.certificate.fingerprint === cert.fingerprint) ?? null;
  /** Other certificates the project keeps that this Mac's authority did not issue. */
  const otherFiles = status.certificates.filter((f) => f !== match && !isLocal(f, presented));
  const facts = [
    { label: 'Issued by', value: nameOf(issuer) },
    ...(issuer.ou && issuer.ou !== issuer.cn ? [{ label: 'Issuer’s unit', value: issuer.ou }] : []),
    { label: 'Covers', value: cert.names.length ? listOf(cert.names) : 'no names' },
    { label: expired ? 'Expired' : early ? 'Valid from' : 'Expires', value: day(expired ? cert.validTo : early ? cert.validFrom : cert.validTo) },
    ...(match ? [{ label: 'File', value: match.file }] : []),
    { label: 'This Mac’s authority', value: presented.authority ? nameOf(presented.authority) : `none in ${presented.caroot}` },
  ];
  const restartStep = 'restart the site (ddev restart) so ddev makes its certificate with this Mac’s authority.';
  const base = { facts, chromium };
  const certTrouble = (cause: LiveCertCause, title: string, lines: string[], steps: string[], action: LiveTrouble['action']): LiveTrouble =>
    ({ ...trouble('certificate', title, [...lines, ...askedNote(run)], { ...base, steps, action }), cause });
  const removeStep = (f: LiveCertFile): string => `Remove ${f.file}${f.key ? ` and ${f.key}` : ''} from the project${f.tracked ? ' (git tracks it, so that is a change to commit)' : ''}, then ${restartStep}`;
  const fromMatch = match ? [`It is ${match.file} in this project${match.tracked ? ', which git tracks' : ''}.`] : [];

  if (!presented.authority) {
    return certTrouble('no-authority', 'This Mac has no mkcert authority yet', [
      `ddev makes its sites’ certificates with mkcert’s local authority, and there is none in ${presented.caroot}. This certificate was issued by ${fullName(issuer)}.`, ...fromMatch,
    ], ddev ? [`Run mkcert -install in a terminal, then ${restartStep}`] : ['Run mkcert -install in a terminal, then make the site’s certificate again with mkcert.'], ddev ? 'restart' : null);
  }
  if (match && !presented.local) {
    return certTrouble('committed', 'This project keeps a certificate made on another machine', [
      `${match.file} is the certificate presented for ${host}${match.tracked ? ', and git tracks it' : ''}. It was issued by ${fullName(issuer)}, not by this Mac’s${expired ? `, and it expired on ${day(cert.validTo)}` : ''}.`,
    ], [removeStep(match)], ddev ? 'restart' : null);
  }
  if (!presented.local && cover === 'wildcard' && run.tool === 'ddev') {
    return certTrouble('router', 'ddev’s router answered with another project’s certificate', [
      `It covers ${listOf(cert.names, 3)}, was issued by ${fullName(issuer)}${expired ? ` and expired on ${day(cert.validTo)}` : ''}. ddev’s router hands a certificate like this to an address it has no route to.`,
      ...(run.state === 'running' ? ['ddev says this site is running, so the router has lost its route to it.'] : []),
    ], [run.state === 'running' ? 'Restart the site (ddev restart) so the router has its route and its certificate again.' : 'Start the site (ddev start) so the router has its route and its certificate.'],
    run.state === 'running' ? 'restart' : ddev ? 'start' : null);
  }
  if (!presented.local && isMkcert(issuer)) {
    return certTrouble('other-mkcert', 'This certificate was made on another machine', [
      `It was issued by ${fullName(issuer)}, another machine’s; this Mac’s is ${fullName(presented.authority)}.${expired ? ` It also expired on ${day(cert.validTo)}.` : ''}`,
      ...otherFiles.slice(0, 3).map((f) => `This project also keeps ${f.file}, issued by ${fullName(f.certificate.issuer)}.`),
    ], ddev ? [`Restart the site (ddev restart) so ddev makes its certificate with this Mac’s authority.`] : ['Make the certificate again on this Mac with mkcert.'], ddev ? 'restart' : null);
  }
  if (expired) {
    return certTrouble('expired', `${host}’s certificate expired on ${day(cert.validTo)}`, [
      `It was issued by ${fullName(issuer)}${presented.local ? ', this Mac’s own mkcert authority' : ''}.`, ...fromMatch,
    ], ddev && presented.local ? [`Restart the site (ddev restart) so ddev makes its certificate again.`] : ['The site needs a new certificate.'], ddev && presented.local ? 'restart' : null);
  }
  if (early) {
    return certTrouble('not-yet-valid', `${host}’s certificate is not valid until ${day(cert.validFrom)}`, ['Check this Mac’s date and time.'], [], null);
  }
  if (!cover) {
    const own = status.hostnames.map((h) => h.toLowerCase()).includes(host.toLowerCase());
    return certTrouble('wrong-name', `${host}’s certificate does not cover this address`, [`It covers ${cert.names.length ? listOf(cert.names) : 'no names at all'}.`],
      ddev && own ? ['This address is one of the project’s ddev hostnames: restart the site (ddev restart) so ddev makes a certificate that names it.']
        : ddev ? [`This address is not one of the project’s ddev hostnames (${listOf(status.hostnames)}). Use one of those, or add it to .ddev/config.yaml and restart the site.`]
          : ['Use an address the certificate covers.'],
      ddev && own ? 'restart' : null);
  }
  if (!presented.local) {
    return certTrouble('untrusted', `This Mac does not trust ${host}’s certificate`, [
      `It was issued by ${fullName(issuer)}, an authority this Mac does not trust and not this Mac’s mkcert authority.`,
    ], [], null);
  }
  return certTrouble('refused', `Chromium refused ${host}’s certificate`, [
    'It was issued by this Mac’s mkcert authority, is in date and covers this address, so the reason is Chromium’s own:',
  ], ddev ? ['Reload; if Chromium still refuses it, restart the site (ddev restart).'] : ['Reload.'], ddev ? 'restart' : null);
}

/** A kept certificate this Mac's authority issued, by the name it states (the presented one's signature was checked; a file's is not). */
function isLocal(f: LiveCertFile, presented: LivePresented): boolean {
  const a = presented.authority;
  return !!a && f.certificate.issuer.cn === a.cn && f.certificate.issuer.ou === a.ou;
}
