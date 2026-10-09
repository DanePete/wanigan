// What must never be seen in public footage, and how to look for it. The terms
// are gathered on this machine when needed (the user name, the git identity,
// account folder names, what each CLI says its account is) and held in memory:
// nothing personal is written into the repository, a take or a log.
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { homedir, hostname, userInfo } from 'node:os';
import { basename } from 'node:path';

/** Words in account folder names and identities that say nothing about anyone. */
const GENERIC = new Set(['claude', 'codex', 'work', 'real', 'temp', 'temp2', 'temporary', 'personal', 'default', 'account', 'example', 'com', 'org', 'net', 'mail', 'local', 'chatgpt']);

/** Public on purpose: the repository's own address. */
const PUBLIC = [/github\.com\/DanePete\/wanigan\b/gi, /DanePete\/wanigan\b/gi];

const words = (s) => String(s).split(/[\s@._\-/]+/).filter((w) => w.length >= 4 && !GENERIC.has(w.toLowerCase()));

/**
 * The private terms for this machine. `accounts` is what the running core
 * listed (identity, label, configDir), when there is one.
 */
export function privateTerms({ accounts = [] } = {}) {
  const terms = new Set();
  const add = (v, split = true) => {
    if (!v || typeof v !== 'string') return;
    const t = v.trim();
    if (t.length >= 4 && !GENERIC.has(t.toLowerCase())) terms.add(t);
    if (split) for (const w of words(t)) terms.add(w);
  };
  add(userInfo().username);
  add(homedir(), false);
  add(hostname().replace(/\.local$/, ''));
  for (const key of ['user.email', 'user.name']) {
    try { add(execFileSync('git', ['config', '--global', key], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })); } catch { /* not set */ }
  }
  // Account folders are named after their logins (".claude_you_example_com"): their names only, never their contents.
  try {
    for (const name of readdirSync(homedir())) {
      const m = name.match(/^\.(claude|codex)[-_](.+)$/);
      if (m) add(m[2].replace(/_/g, ' '));
    }
  } catch { /* no home to list */ }
  for (const a of accounts) {
    if (a.identity && a.identity !== 'ChatGPT') add(a.identity);
    if (a.label && a.label !== 'Default') add(a.label);
    if (a.configDir) add(basename(a.configDir).replace(/^\.(claude|codex)[-_]?/, '').replace(/_/g, ' '));
  }
  return [...terms].filter((t) => t.length >= 4);
}

const CHECKS = [
  ['email', /[A-Z0-9._%+-]+@[A-Z0-9-]+(\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi, (m) => !/@(example\.com|agency\.example)$/i.test(m)],
  ['home folder', /\/Users\/[^/\s'"]+/g, (m) => !/\/Users\/Shared$/i.test(m)],
  ['plan name', /Claude (Max|Pro|Team|Enterprise)\b/g, () => true],
];

/** The kinds of private detail in `text` (never the detail itself). */
export function findPrivate(text, terms) {
  let t = text;
  for (const re of PUBLIC) t = t.replace(re, '');
  const kinds = new Set();
  for (const [kind, re, real] of CHECKS) for (const m of t.match(re) ?? []) if (real(m)) kinds.add(kind);
  const lower = t.toLowerCase();
  for (const term of terms) {
    const needle = term.toLowerCase();
    let i = lower.indexOf(needle);
    while (i >= 0) {
      // A short term only counts as a whole word ("dane", not "mundane").
      const before = lower[i - 1] ?? ' ';
      const after = lower[i + needle.length] ?? ' ';
      if (needle.length > 6 || (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after))) { kinds.add('name or account'); break; }
      i = lower.indexOf(needle, i + 1);
    }
  }
  return [...kinds];
}
