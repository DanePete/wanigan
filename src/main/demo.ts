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

function walk<T>(v: T, fn: (s: string) => string, depth = 0): T {
  if (depth > 12) return v;
  if (typeof v === 'string') return fn(v) as unknown as T;
  if (Array.isArray(v)) return v.map((x) => walk(x, fn, depth + 1)) as unknown as T;
  if (v && typeof v === 'object') {
    // Buffers and dates are data, not text; rebuilding them loses what they are.
    if (v instanceof Date || Buffer.isBuffer(v)) return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = walk(x, fn, depth + 1);
    return out as unknown as T;
  }
  return v;
}

export function maskOut<T>(v: T): T {
  return demoOn() ? walk(v, maskString) : v;
}
export function unmaskIn<T>(v: T): T {
  return demoOn() ? walk(v, unmaskString) : v;
}

/** Shown in Settings so the mapping is inspectable rather than mysterious. */
export function demoMap(): { real: string; fake: string }[] {
  if (!demoOn()) return [];
  return pairs().filter((p) => p.real.startsWith('/')).map((p) => ({ real: p.real, fake: p.fake }));
}
