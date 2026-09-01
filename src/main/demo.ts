import os from 'node:os';
import { getSetting, setSetting } from './settings';
import { listProjects } from './store';

/**
 * Demo mode: real names out, plausible ones in.
 *
 * Masking in each view would mean finding every place a path is printed, and
 * missing one is the entire failure — a screenshot is not partially private.
 * So this sits at the IPC boundary instead, where every response already
 * passes through one function.
 *
 * The map is BIJECTIVE and applied in both directions: responses are masked on
 * the way out, and arguments are unmasked on the way back in. Without the
 * return trip the renderer would hand a fake path to git and every operation
 * would fail — a demo mode that breaks the app is one nobody dares turn on
 * with an audience watching.
 */

const NAMES = [
  'acme-storefront', 'orbit-api', 'northwind', 'lighthouse', 'harbourview',
  'tandem', 'basalt', 'foundry-web', 'cascade', 'meridian', 'ironwood', 'tinderbox',
];
const DEMO_USER = 'demo';
const DEMO_AUTHOR = 'Alex Rivera';
const DEMO_EMAIL = 'alex@example.com';

export function demoOn(): boolean {
  return getSetting('demo_mode', '0') === '1';
}
export function setDemo(on: boolean): boolean {
  setSetting('demo_mode', on ? '1' : '0');
  cache = null;
  return on;
}

type Pair = { real: string; fake: string };
let cache: { at: number; pairs: Pair[] } | null = null;

/**
 * Longest-first, so `/Users/dane/Projects/foo` is replaced before the home
 * directory inside it turns the tail into a half-masked path.
 */
function pairs(): Pair[] {
  if (cache && Date.now() - cache.at < 5_000) return cache.pairs;
  const home = os.homedir();
  const user = home.split('/').filter(Boolean).pop() ?? 'user';
  const out: Pair[] = [];

  listProjects().forEach((p, i) => {
    const fake = NAMES[i % NAMES.length] + (i >= NAMES.length ? `-${Math.floor(i / NAMES.length) + 1}` : '');
    out.push({ real: p.path, fake: `/Users/${DEMO_USER}/Projects/${fake}` });
    out.push({ real: p.name, fake });
  });
  // After the projects, so a project path inside home is masked as a whole.
  out.push({ real: home, fake: `/Users/${DEMO_USER}` });
  out.push({ real: user, fake: DEMO_USER });

  out.sort((a, b) => b.real.length - a.real.length);
  cache = { at: Date.now(), pairs: out };
  return out;
}

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
/** Git author names are free text; only the ones git reports get replaced. */
let authorNames: string[] = [];
export function noteAuthors(names: string[]) {
  authorNames = [...new Set([...authorNames, ...names.filter(Boolean)])].slice(0, 50);
}

function maskString(s: string): string {
  let out = s;
  for (const { real, fake } of pairs()) {
    if (real && out.includes(real)) out = out.split(real).join(fake);
  }
  out = out.replace(EMAIL, DEMO_EMAIL);
  for (const n of authorNames) {
    if (n && n !== DEMO_AUTHOR && out.includes(n)) out = out.split(n).join(DEMO_AUTHOR);
  }
  return out;
}

function unmaskString(s: string): string {
  let out = s;
  // Reverse the longest fake first, for the same reason as above.
  for (const { real, fake } of [...pairs()].sort((a, b) => b.fake.length - a.fake.length)) {
    if (fake && out.includes(fake)) out = out.split(fake).join(real);
  }
  return out;
}

/** Deep enough for every payload that carries text, shallow enough that a
 *  structure which nests without end cannot turn one IPC reply into a hang. */
const MAX_DEPTH = 12;
/** Stands in for text the walk was not allowed to read. It keeps no name, no
 *  path and no length, so nothing about the original survives it. */
const TOO_DEEP = '[hidden · demo mode]';

/**
 * What is left where the walk stops descending.
 *
 * The depth limit is there to bound work; this decides whether reaching it is
 * a hole in the guarantee at the top of this file. Returning the value
 * untouched was exactly that hole — Learning and Control payloads nest well
 * past MAX_DEPTH, so a screenshot showed masked names at the top and real
 * project names, paths and usernames underneath. That is the partially private
 * screenshot this module exists to make impossible, so the unread end fails
 * closed instead.
 *
 * Text is replaced and containers are emptied rather than dropped, because the
 * renderer is written against a shape and an absent field crashes it where an
 * empty one does not. Numbers, booleans and null carry no name to leak.
 */
function blank<T>(v: T): T {
  if (typeof v === 'string') return TOO_DEEP as unknown as T;
  if (Array.isArray(v)) return [] as unknown as T;
  if (v && typeof v === 'object') {
    // Same reason as in walk: these are data, not text.
    if (v instanceof Date || Buffer.isBuffer(v)) return v;
    return {} as unknown as T;
  }
  return v;
}

/** Identity, for the inbound trip. See unmaskIn for why it is safe there. */
function keep<T>(v: T): T {
  return v;
}

function walk<T>(v: T, fn: (s: string) => string, beyond: <U>(x: U) => U, depth = 0): T {
  if (depth > MAX_DEPTH) return beyond(v);
  if (typeof v === 'string') return fn(v) as unknown as T;
  if (Array.isArray(v)) return v.map((x) => walk(x, fn, beyond, depth + 1)) as unknown as T;
  if (v && typeof v === 'object') {
    // Buffers and dates are data, not text; rebuilding them loses what they are.
    if (v instanceof Date || Buffer.isBuffer(v)) return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = walk(x, fn, beyond, depth + 1);
    return out as unknown as T;
  }
  return v;
}

export function maskOut<T>(v: T): T {
  // Fails closed past the depth limit: this is the value that reaches a screen.
  return demoOn() ? walk(v, maskString, blank) : v;
}
export function unmaskIn<T>(v: T): T {
  // Fails open past the same limit, and has to. Nothing here is on its way to a
  // display — these are arguments the renderer is handing back, already masked
  // when it received them, so a deep value cannot reveal anything it was not
  // already shown. Blanking one would only replace a path git can still act on
  // with a placeholder it cannot.
  return demoOn() ? walk(v, unmaskString, keep) : v;
}

/** Shown in Settings so the mapping is inspectable rather than mysterious. */
export function demoMap(): { real: string; fake: string }[] {
  if (!demoOn()) return [];
  return pairs().filter((p) => p.real.startsWith('/')).map((p) => ({ real: p.real, fake: p.fake }));
}
