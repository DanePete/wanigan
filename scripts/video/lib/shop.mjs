// The throwaway test site a real take works on: a small shop page with a cart,
// a `node --test` suite, a few days of git history and a local bare "origin"
// (pushing there reaches nothing outside this folder). Made fresh for each take.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The repository's own identity: commits made on camera never show the owner's name or email. */
const GIT_IDENTITY = { name: 'Corner Shop', email: 'shop@example.com' };

const FILES_1 = {
  'README.md': '# Corner Shop\n\nA small shop page: products, a cart and its total.\n\n```sh\nnpm test\n```\n',
  'index.html': `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Corner Shop</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <header><h1>Corner Shop</h1></header>
  <main>
    <section id="products" class="grid"></section>
    <aside id="cart">
      <h2>Your cart</h2>
      <ul id="cart-items"></ul>
      <p class="total">Total <strong id="cart-total">$0.00</strong></p>
    </aside>
  </main>
  <script type="module" src="src/page.js"></script>
</body>
</html>
`,
  'styles.css': `body { font-family: system-ui, sans-serif; margin: 0; color: #1d2329; }
header { padding: 16px 24px; border-bottom: 1px solid #e3e6e8; }
main { display: grid; grid-template-columns: 1fr 280px; gap: 24px; padding: 24px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 16px; }
.product { border: 1px solid #e3e6e8; border-radius: 8px; padding: 12px; }
#cart { border-left: 1px solid #e3e6e8; padding-left: 24px; }
`,
};

const CART_V1 = `// The cart: what is in it, and what it comes to. Prices are in cents.

export const PRODUCTS = [
  { id: 'mug', name: 'Enamel mug', price: 1800, stock: 12 },
  { id: 'tote', name: 'Canvas tote', price: 2400, stock: 0 },
  { id: 'beans', name: 'Coffee beans, 1 lb', price: 1650, stock: 30 },
  { id: 'cards', name: 'Note cards', price: 900, stock: 4 },
];

/** 1650 -> "$16.50" */
export function formatMoney(cents) {
  return \`$\${(cents / 100).toFixed(2)}\`;
}

/** The total of the cart's lines, in cents. */
export function cartTotal(items) {
  return items.reduce((sum, item) => sum + item.price * item.quantity, 0);
}
`;

const PAGE_JS = `import { PRODUCTS, cartTotal, formatMoney } from './cart.js';

const cart = [];

function render() {
  document.getElementById('products').innerHTML = PRODUCTS.map((p) => \`
    <article class="product">
      <h3>\${p.name}</h3>
      <p>\${formatMoney(p.price)}</p>
      <button data-id="\${p.id}">Add to cart</button>
    </article>\`).join('');
  document.getElementById('cart-items').innerHTML = cart.map((i) => \`<li>\${i.quantity} × \${i.name}</li>\`).join('');
  document.getElementById('cart-total').textContent = formatMoney(cartTotal(cart));
}

document.addEventListener('click', (e) => {
  const id = e.target.dataset?.id;
  const product = PRODUCTS.find((p) => p.id === id);
  if (!product) return;
  const line = cart.find((i) => i.id === id);
  if (line) line.quantity += 1;
  else cart.push({ ...product, quantity: 1 });
  render();
});

render();
`;

const TEST_V1 = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cartTotal, formatMoney } from '../src/cart.js';

test('formats cents as dollars', () => {
  assert.equal(formatMoney(1650), '$16.50');
  assert.equal(formatMoney(0), '$0.00');
});

test('adds up the cart', () => {
  assert.equal(cartTotal([{ price: 1800, quantity: 2 }, { price: 900, quantity: 1 }]), 4500);
  assert.equal(cartTotal([]), 0);
});
`;

/**
 * Claude Code in this project: the board commands, reads and file edits need
 * no prompt, and anything else in a shell (running the tests) asks, so the take
 * has the permission prompt Needs you catches. The mode is set here because a
 * user's own default (auto mode, say) would otherwise decide whether it asks at all.
 */
const CLAUDE_SETTINGS = {
  permissions: {
    defaultMode: 'default',
    allow: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash(wanigan:*)', 'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(ls:*)'],
  },
};

function git(cwd, args, date) {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    env: {
      ...process.env,
      // None of the owner's git config: no signing prompt, no global hooks, no identity.
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: GIT_IDENTITY.name, GIT_AUTHOR_EMAIL: GIT_IDENTITY.email,
      GIT_COMMITTER_NAME: GIT_IDENTITY.name, GIT_COMMITTER_EMAIL: GIT_IDENTITY.email,
      ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}),
    },
  });
}

function write(dir, files) {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
}

/** Build the shop at `dir` (replacing anything there) with `origin` as its bare remote. */
export function makeShop(dir, origin) {
  rmSync(dir, { recursive: true, force: true });
  rmSync(origin, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const day = (n, hour) => {
    const d = new Date(Date.now() - n * 86_400_000);
    d.setHours(hour, 12, 0, 0);
    return d.toISOString();
  };
  git(dir, ['init', '-q', '-b', 'main']);
  // Commits made later, in the app (by the owner or an agent), use the shop's identity too.
  git(dir, ['config', 'user.name', GIT_IDENTITY.name]);
  git(dir, ['config', 'user.email', GIT_IDENTITY.email]);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['config', 'tag.gpgsign', 'false']);
  write(dir, { ...FILES_1, '.gitignore': 'node_modules/\ntest-output.txt\n' });
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'Shop page with a product grid'], day(5, 10));
  write(dir, { 'src/cart.js': CART_V1, 'src/page.js': PAGE_JS });
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'Cart with a total in dollars and cents'], day(4, 15));
  write(dir, {
    'package.json': `${JSON.stringify({ name: 'corner-shop', private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2)}\n`,
    'test/cart.test.js': TEST_V1,
  });
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'Tests for the cart total and money format'], day(3, 11));
  write(dir, { '.claude/settings.json': `${JSON.stringify(CLAUDE_SETTINGS, null, 2)}\n` });
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'Let Claude Code use the board without asking'], day(2, 16));
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { stdio: 'ignore', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  git(dir, ['remote', 'add', 'origin', origin]);
  git(dir, ['push', '-q', '-u', 'origin', 'main']);
  // Check the suite passes before anyone works on it.
  execFileSync(process.execPath, ['--test'], { cwd: dir, stdio: 'ignore' });
}

/** The cards a real take works, and the ones that make the board look lived in. */
export const SHOP_CARDS = {
  /** Made on camera, worked by Claude Code. */
  main: {
    type: 'feature',
    title: 'Free shipping note in the cart',
    body: 'Orders of $50 or more ship free, but the cart never says so. Under $50, tell the customer how much more gets free shipping.',
    criteria: ['Under $50 the cart says how much more gets free shipping', 'At $50 or more it says shipping is free', 'npm test passes, with tests for both'],
  },
  /** Already in Ready, worked by Codex on its own branch. */
  side: {
    type: 'feature',
    title: 'Sold out label on products',
    body: 'A product with no stock still shows an Add to cart button. Show “Sold out” instead.',
    criteria: ['A product with no stock says Sold out', 'npm test passes'],
  },
  done: [
    { type: 'feature', title: 'Product grid on the home page' },
    { type: 'task', title: 'Cart total in dollars and cents' },
  ],
  ready: [{ type: 'feature', title: 'Search box above the product grid', priority: 3 }],
  inbox: [{ type: 'bug', title: 'Product photos have no alt text', priority: 1 }],
};
