// The demo's git story for Northstar Storefront: a history two people made over
// two weeks, a card's branch merged back (NS-8, the CDN move), a release branch
// a teammate moved on since, origin as a bare repository in the demo's own
// folder (so push, pull and fetch really work), a stash, and today's work
// half staged, with a key an agent pasted where it should not be. All of it
// runs with the demo's git environment: none of the owner's config.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DANA = 'Dana Reyes <dana@northstar.example>';
const SAM = 'Sam Okafor <sam@northstar.example>';
const DAY = 86_400;

export interface DemoGitEnv { [key: string]: string }

/** Material for a key-shaped value, made at run time so no scanner reads a key in this file. */
function material(seed: number, length: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let a = seed >>> 0;
  let out = '';
  for (let i = 0; i < length; i++) {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    out += alphabet[Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * alphabet.length)];
  }
  return out;
}

/** A Stripe-shaped live key that is no one's: Wanigan's scanner names it; gitleaks never sees it, because it is never written in source. */
export const demoStripeKey = (): string => ['sk', 'live', `51N${material(7, 40)}`].join('_');

function writer(env: DemoGitEnv) {
  const now = Math.floor(Date.now() / 1000);
  const sh = (cwd: string, command: string, extra: DemoGitEnv = {}): string =>
    execFileSync('/bin/sh', ['-c', command], { cwd, env: { ...process.env, ...env, ...extra }, encoding: 'utf8' });
  /** A commit by `author`, `days` ago (a fraction is hours). */
  const commit = (cwd: string, message: string, author: string, days: number, add = '-A'): void => {
    const when = `${now - Math.round(days * DAY)} -0500`;
    const [name, email] = author.split(' <') as [string, string];
    sh(cwd, `git add ${add} && git commit -q -m ${sq(message)}`, {
      GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email.slice(0, -1), GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email.slice(0, -1),
      GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when,
    });
  };
  const file = (cwd: string, path: string, text: string): void => {
    mkdirSync(join(cwd, path, '..'), { recursive: true });
    writeFileSync(join(cwd, path), text);
  };
  return { sh, commit, file, now };
}

const sq = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`;

/**
 * The history, from files already written: the storefront first, then the
 * checkout module, then the pay button (each committed separately, in that
 * order), and what came after. `checkout` and `payButton` are the paths that
 * belong to the second and third commits. Returns the commit NS-13's branch
 * forks from, so its merge of main meets changes made since.
 */
export function seedGitHistory(repo: string, base: string, env: DemoGitEnv, paths: { checkout: string; payButton: string }): string {
  const { sh, commit, file } = writer(env);
  sh(repo, 'git init -q -b main');
  // Everything but the checkout module and the pay button: the storefront as it was two weeks ago.
  sh(repo, `git add -A && git reset -q -- ${sq(paths.checkout)} ${sq(paths.payButton)}`);
  commit(repo, 'Storefront: product grid, cart and checkout pages', DANA, 13.2, '-u');
  commit(repo, 'Add the checkout module: pay button route, template and styles', SAM, 11.6, sq(paths.checkout));
  commit(repo, 'Pay button with a lock icon', DANA, 10.1, sq(paths.payButton));

  // NS-8, the CDN move, on its own branch, merged back as Wanigan merges a card.
  sh(repo, 'git switch -q -c wanigan/ns-8');
  file(repo, 'src/products/images.ts', "export const imageUrl = (id: string, width: number): string =>\n  `https://cdn.northstar.example/products/${id}?w=${width}`;\n");
  commit(repo, 'Serve product images from the CDN', DANA, 7.4);
  file(repo, 'config/redirects.yml', "# Old image paths keep working: each answers with a 301 to the CDN.\n- from: /sites/default/files/products/(.*)\n  to: https://cdn.northstar.example/products/$1\n  status: 301\n");
  commit(repo, 'Redirect old image paths with a 301', DANA, 7.1);
  sh(repo, 'git switch -q main');
  file(repo, 'src/cart/copy.ts', cartCopy({}));
  commit(repo, 'Holiday copy for the cart page', SAM, 6.3);
  const when = `${Math.floor(Date.now() / 1000) - Math.round(5.8 * DAY)} -0500`;
  sh(repo, "git merge -q --no-ff --no-edit -m 'Merge wanigan/ns-8' wanigan/ns-8", { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when, GIT_AUTHOR_NAME: 'Dana Reyes', GIT_COMMITTER_NAME: 'Dana Reyes', GIT_AUTHOR_EMAIL: 'dana@northstar.example', GIT_COMMITTER_EMAIL: 'dana@northstar.example' });
  sh(repo, 'git branch -q -d wanigan/ns-8');
  file(repo, 'src/checkout/steps.ts', "/** The checkout's steps, named as screen readers announce them. */\nexport const STEPS = ['Cart', 'Shipping', 'Payment', 'Review'] as const;\n");
  commit(repo, 'Name the checkout steps for screen readers', DANA, 3.9);
  // Where NS-13's branch forked: Sam's copy change and the totals came after it, and both meet it there.
  const fork = sh(repo, 'git rev-parse HEAD').trim();
  file(repo, 'src/cart/settings.ts', 'export const FREE_SHIPPING_OVER = 75;\n');
  file(repo, 'src/cart/copy.ts', cartCopy({
    imports: "import { FREE_SHIPPING_OVER } from './settings';",
    empty: 'Nothing in your cart yet.',
    shipping: '`Free shipping on orders over $${FREE_SHIPPING_OVER}.`',
    last: "checkout: 'Check out',",
  }));
  commit(repo, 'Cart copy: a shorter empty cart, and the threshold from settings', SAM, 3.2);

  // origin: a bare repository beside the projects, pushed to as far as this.
  const origin = join(base, 'origin.git');
  rmSync(origin, { recursive: true, force: true });
  sh(base, `git init -q --bare -b main ${sq(origin)}`);
  sh(repo, `git remote add origin ${sq(origin)} && git push -q -u origin main`);
  // The October release, which a teammate has moved on since: one commit behind here.
  sh(repo, 'git branch release/2026.10 && git push -q -u origin release/2026.10');
  const teammate = join(base, 'teammate');
  rmSync(teammate, { recursive: true, force: true });
  sh(base, `git clone -q --branch release/2026.10 ${sq(origin)} ${sq(teammate)}`);
  file(teammate, 'RELEASE.md', '# October release\n\nFrozen on the 14th. Only fixes from here.\n');
  commit(teammate, 'Freeze the October release', SAM, 2.6);
  sh(teammate, 'git push -q');
  rmSync(teammate, { recursive: true, force: true });
  sh(repo, 'git fetch -q origin');

  // Two commits not pushed yet.
  file(repo, 'src/cart/totals.ts', "/** Cart totals, rounded to the cent once, at the end. */\nexport const total = (lines: { price: number; qty: number }[]): number =>\n  Math.round(lines.reduce((sum, l) => sum + l.price * l.qty, 0) * 100) / 100;\n");
  commit(repo, 'Round cart totals to the cent once, at the end', DANA, 1.2);
  file(repo, 'src/checkout/timing.ts', "export const marks = new Map<string, number>();\n\nexport function mark(step: string): void {\n  marks.set(step, performance.now());\n}\n");
  commit(repo, 'Time each checkout step', DANA, 0.4);

  // A stash: a sticky order summary, put aside half done.
  file(repo, 'src/cart/StickySummary.tsx', "export function StickySummary({ total }: { total: number }) {\n  return <aside className=\"sticky-summary\">Total {formatMoney(total)}</aside>;\n}\n");
  file(repo, 'src/cart/totals.ts', "/** Cart totals, rounded to the cent once, at the end. */\nexport const total = (lines: { price: number; qty: number }[]): number =>\n  Math.round(lines.reduce((sum, l) => sum + l.price * l.qty, 0) * 100) / 100;\n\nexport const itemCount = (lines: { qty: number }[]): number => lines.reduce((n, l) => n + l.qty, 0);\n");
  sh(repo, "git stash push -q -u -m 'Sticky order summary on mobile (half done)'");
  return fork;
}

/** The cart page's words, as each side of NS-13's merge has them. */
function cartCopy(edit: { imports?: string; empty?: string; shipping?: string; last?: string }): string {
  return [
    ...(edit.imports ? [edit.imports, ''] : []),
    '// Words on the cart page. Keep them short: they wrap on phones.',
    'export const CART_COPY = {',
    `  empty: '${edit.empty ?? 'Your cart is empty. The good stuff is one click away.'}',`,
    "  browse: 'Browse the shop',",
    `  shipping: ${edit.shipping ?? "'Free shipping on orders over $75.'"},`,
    "  shippingReached: 'You get free shipping.',",
    "  remove: 'Remove',",
    "  undo: 'Undo',",
    ...(edit.last ? [`  ${edit.last}`] : []),
    '};',
    '',
  ].join('\n');
}

/**
 * NS-13's branch, forked before Sam's copy change and the rounded totals: it
 * writes both its own way, then brings main in, which stops in conflicts in
 * the card's worktree (a content conflict in three places, and a file both
 * sides added) for the owner to resolve there. Its session has stopped, so
 * nothing is at work in that folder.
 */
export function seedConflictedMerge(worktree: string, fork: string, env: DemoGitEnv): void {
  const { sh, file, commit } = writer(env);
  sh(worktree, `git reset -q --hard ${fork}`);
  file(worktree, 'src/cart/money.ts', [
    'export interface Money {',
    '  amount: number;',
    '  currency: string;',
    '}',
    '',
    'export const formatMoney = (m: Money): string =>',
    "  new Intl.NumberFormat(undefined, { style: 'currency', currency: m.currency }).format(m.amount);",
    '',
  ].join('\n'));
  file(worktree, 'src/cart/totals.ts', [
    "import type { Money } from './money';",
    '',
    '/** Cart totals in the customer’s currency, never mixed. */',
    'export const total = (lines: { price: Money; qty: number }[], currency: string): Money => ({',
    '  amount: lines.reduce((sum, l) => sum + l.price.amount * l.qty, 0),',
    '  currency,',
    '});',
    '',
  ].join('\n'));
  file(worktree, 'src/cart/copy.ts', cartCopy({
    imports: "import { formatMoney, type Money } from './money';",
    shipping: '(over: Money) => `Free shipping on orders over ${formatMoney(over)}.`',
    last: 'total: (sum: Money) => `Total ${formatMoney(sum)}`,',
  }));
  commit(worktree, 'Cart totals and copy in the customer’s currency', DANA, 2.1);
  // Expected to stop: the conflicts are the point.
  sh(worktree, 'git merge --no-edit main >/dev/null 2>&1 || true');
}

/**
 * Today's work in the folder, once its files are written: the pay button and
 * its test staged, with a payment client an agent wrote that carries a live
 * key as a fallback (also staged: the scanner stops the commit); the checkout
 * module's changes not yet staged; an audit note never added.
 */
export function seedTodaysWork(repo: string, env: DemoGitEnv): void {
  const { sh, file } = writer(env);
  file(repo, 'src/checkout/stripe.ts', [
    "import Stripe from 'stripe';",
    '',
    '// The key comes from the environment; the fallback is for local testing.',
    `export const stripe = new Stripe(process.env.STRIPE_KEY ?? '${demoStripeKey()}', {`,
    "  apiVersion: '2026-08-01',",
    '});',
    '',
  ].join('\n'));
  file(repo, 'docs/a11y-audit-2026-09.md', '# Accessibility audit, September\n\n- Pay button has no accessible name (NS-6)\n- Coupon errors are not announced\n');
  sh(repo, 'git add src/checkout/PayButton.tsx src/checkout/PayButton.test.tsx src/checkout/stripe.ts');
}

/** NS-3's branch: a second commit, pushed, so its pull request can be asked about. */
export function seedCardBranch(worktree: string, repo: string, env: DemoGitEnv): void {
  const { sh, file, commit } = writer(env);
  file(worktree, 'src/orders/Reorder.ts', "/** Puts every in-stock item of an order back in the cart. */\nexport const reorder = (order: Order, cart: Cart): void => {\n  for (const line of order.lines) if (line.product.stock > 0) cart.add(line.product, line.qty);\n};\n");
  commit(worktree, 'Reorder adds every in-stock item back to the cart', DANA, 0.05);
  const branch = sh(worktree, 'git branch --show-current').trim();
  sh(repo, `git push -q -u origin ${sq(branch)}`);
}
