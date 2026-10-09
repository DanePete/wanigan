// Skills, MCP configuration and agent transcripts for the demo's (and so the UI sweep's) pretend home and
// projects. Realistic enough to look at; never the owner's real files.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { claudeSlug } from './history.ts';
import { crc32, deflateSync } from 'node:zlib';

const ORG = '5b2c1e0a-1111-4c2d-9e3f-000000000001';
const ACCT = '5b2c1e0a-2222-4c2d-9e3f-000000000002';

function skill(dir: string, name: string, description: string, body: string, extra = ''): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n${body.trim()}\n`);
}

const DEBUGGING = `
# Systematic debugging

Find the cause before you change anything. A fix you cannot explain is a guess.

## The loop

1. **Reproduce** it with the smallest input you can. Write the steps down.
2. **Read** the error and the code it points at — the whole function, not the line.
3. **Form one hypothesis**, and say what would prove it wrong.
4. **Test it** with a print, a breakpoint or a failing test. Change one thing at a time.

## When you are stuck

- Check what changed: \`git log -p --since="2 days ago" -- src/\`
- Bisect when the history is long:

\`\`\`sh
git bisect start
git bisect bad HEAD
git bisect good v2.3.0
\`\`\`

> If three hypotheses in a row were wrong, stop and write down what you know.

| Symptom | Look first at |
|---|---|
| Works locally, fails in CI | environment, versions, time zones |
| Fails only sometimes | ordering, caches, shared state |
`;

const VERIFY = `
# Verify before you say it is done

Run the command that proves it, read its output, then make the claim.

- [x] Tests pass, and you saw them pass
- [ ] The change does what the card asked, checked by hand
- [ ] Nothing unrelated changed (\`git diff --stat\`)
`;

export function seedSkills(home: string, projects: { northstar: string; orbit: string }): void {
  const claude = join(home, '.claude');
  skill(join(claude, 'skills', 'systematic-debugging'), 'systematic-debugging',
    'Use when a test fails or something behaves unexpectedly, before proposing a fix.', DEBUGGING);
  mkdirSync(join(claude, 'skills', 'systematic-debugging', 'scripts'), { recursive: true });
  writeFileSync(join(claude, 'skills', 'systematic-debugging', 'scripts', 'bisect-run.sh'), '#!/bin/sh\ngit bisect run "$@"\n', { mode: 0o755 });
  skill(join(claude, 'skills', 'verify-before-done'), 'verify-before-done',
    'Use before claiming work is complete: run the proof and read it first.', VERIFY);
  skill(join(claude, 'skills', 'drupal-config-sync'), 'drupal-config-sync',
    'Export, review and import Drupal configuration without losing changes made on production.',
    '# Drupal config sync\n\nAlways `drush cex` on production first and commit it before importing anything.\n\n```sh\ndrush cex -y\ngit add config/sync && git commit -m "Config from production"\ndrush cim -y\n```\n',
    'allowed-tools:\n  - Bash(drush:*)\n  - Read\n');

  // Synced from claude.ai for the default account.
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { organizationUuid: ORG, accountUuid: ACCT, emailAddress: 'you@example.com' } }, null, 2));
  skill(join(claude, 'skills', 'synced', `${ORG}_${ACCT}`, 'morning'), 'morning', 'Render the morning brief: calendar, inbox and what is due.', '# Morning brief\n\nSummarise today in five lines.\n');

  // One installed plugin, switched on.
  const plugin = join(claude, 'plugins', 'cache', 'claude-plugins-official', 'frontend-design', '1.4.0');
  skill(join(plugin, 'skills', 'frontend-design'), 'frontend-design',
    'Guidance for distinctive, intentional visual design when building or reshaping UI.', '# Frontend design\n\nPick a direction and commit to it.\n');
  mkdirSync(join(plugin, '.claude-plugin'), { recursive: true });
  writeFileSync(join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'frontend-design' }));
  writeFileSync(join(claude, 'plugins', 'installed_plugins.json'), JSON.stringify({
    version: 2, plugins: { 'frontend-design@claude-plugins-official': [{ scope: 'user', installPath: plugin, version: '1.4.0' }] },
  }));
  writeFileSync(join(claude, 'settings.json'), JSON.stringify({ enabledPlugins: { 'frontend-design@claude-plugins-official': true } }));

  skill(join(home, '.claude_work', 'skills', 'agency-handoff'), 'agency-handoff',
    'Write the client handoff note: what shipped, how to check it, what is left.', '# Client handoff\n\nThree sections, plain words, no jargon.\n');

  // Codex: shared by every account, and one account's own.
  skill(join(home, '.agents', 'skills', 'systematic-debugging'), 'systematic-debugging',
    'Use when a test fails or something behaves unexpectedly, before proposing a fix.', DEBUGGING);
  skill(join(home, '.codex', 'skills', 'release-notes'), 'release-notes',
    'Draft release notes from merged pull requests since the last tag.', '# Release notes\n\nGroup by feature, fix and chore. Link each PR.\n');

  // Gemini CLI: its own folder (it reads ~/.agents/skills too, beside Codex).
  skill(join(home, '.gemini', 'skills', 'storefront-copy'), 'storefront-copy',
    'Write product copy in the Northstar voice: short, concrete, no superlatives.', '# Storefront copy\n\nOne sentence of what it is, one of why it matters.\n');

  // Projects.
  skill(join(projects.northstar, '.claude', 'skills', 'checkout-a11y'), 'checkout-a11y',
    'Audit the checkout flow with axe and fix what it finds, one violation per commit.',
    '# Checkout accessibility\n\nRun `pnpm exec axe http://localhost:3000/checkout` and fix violations in order of impact.\n\n- Every control has an accessible name\n- Focus order follows the visual order\n');
  skill(join(projects.northstar, '.agents', 'skills', 'checkout-a11y'), 'checkout-a11y',
    'Audit the checkout flow with axe and fix what it finds, one violation per commit.', '# Checkout accessibility\n\nRun axe on /checkout.\n');
  skill(join(projects.orbit, '.claude', 'skills', 'api-contract'), 'api-contract',
    'Check an endpoint change against the OpenAPI contract before it merges.', '# API contract\n\n`pnpm run openapi:diff` must report no breaking changes.\n');
}

/** MCP configuration for the pretend accounts and projects. Secrets are fake, and hidden by the page. */
export function seedMcp(home: string, projects: { northstar: string; orbit: string }): void {
  const stateFile = join(home, '.claude.json');
  const state = JSON.parse(readFileSync(stateFile, 'utf8')) as Record<string, unknown>;
  state.mcpServers = {
    linear: { type: 'http', url: 'https://mcp.linear.app/mcp' },
    playwright: { type: 'stdio', command: 'npx', args: ['@playwright/mcp@latest'], env: {} },
    'drupal-db': {
      type: 'stdio', command: 'npx', args: ['-y', '@acme/drupal-mcp', '--db', 'mysql://drupal:not-a-real-password-9f3a@127.0.0.1/northstar'],
      env: { DRUPAL_ROOT: '/var/www/northstar/web', ACME_API_KEY: 'acme_demo_not_a_real_key' },
    },
  };
  state.projects = {
    [projects.orbit]: {
      mcpServers: { 'orbit-staging-api': { type: 'http', url: 'https://staging.orbit.example/mcp', headers: { Authorization: 'Bearer fake_staging_token_8f2e1d0c9b' } } },
    },
  };
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
  writeFileSync(join(home, '.claude_work', '.claude.json'), JSON.stringify({ mcpServers: { sentry: { type: 'http', url: 'https://mcp.sentry.dev/mcp' } } }, null, 2));
  writeFileSync(join(projects.northstar, '.mcp.json'), JSON.stringify({ mcpServers: { figma: { type: 'http', url: 'https://mcp.figma.com/mcp' } } }, null, 2));
  writeFileSync(join(home, '.codex', 'config.toml'), [
    'model = "gpt-5"',
    '',
    '[mcp_servers.context7]',
    'command = "npx"',
    'args = ["-y", "@upstash/context7-mcp"]',
    '',
    '[mcp_servers.github]',
    'url = "https://api.githubcopilot.com/mcp/"',
    'bearer_token_env_var = "GITHUB_PAT_TOKEN"',
    '',
  ].join('\n'));
  writeFileSync(join(home, '.codex_personal', 'config.toml'), 'model = "gpt-5"\n');
}

/**
 * Where the pretend agents have worked: Claude transcripts and Codex rollouts in
 * the pretend home, each dated by its modification time, for "Folders your
 * agents have worked in". One folder is older than the window and one is gone,
 * so neither is offered.
 */
export function seedAgentFolders(home: string, projects: string): void {
  const DAY = 86_400_000;
  let n = 0;
  const id = (): string => `00000000-0000-4000-9000-${String(++n).padStart(12, '0')}`;
  const put = (file: string, lines: object[], daysAgo: number): void => {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
    const at = (Date.now() - daysAgo * DAY) / 1000;
    utimesSync(file, at, at);
  };
  const claude = (account: string, cwd: string, daysAgo: number): void => {
    const conversation = id();
    const at = new Date(Date.now() - daysAgo * DAY).toISOString();
    put(join(home, account, 'projects', claudeSlug(cwd), `${conversation}.jsonl`), [
      { type: 'file-history-snapshot', messageId: conversation, snapshot: { trackedFileBackups: {} } },
      { parentUuid: null, isSidechain: false, type: 'user', message: { role: 'user', content: 'Pick up where we left off.' }, uuid: id(), timestamp: at, userType: 'external', entrypoint: 'cli', cwd, sessionId: conversation, version: '2.1.292', gitBranch: 'main' },
    ], daysAgo);
  };
  const codex = (cwd: string, daysAgo: number): void => {
    const when = new Date(Date.now() - daysAgo * DAY);
    const day = [String(when.getFullYear()), String(when.getMonth() + 1).padStart(2, '0'), String(when.getDate()).padStart(2, '0')];
    put(join(home, '.codex', 'sessions', ...day, `rollout-${when.toISOString().slice(0, 19).replace(/:/g, '-')}-${id()}.jsonl`), [
      { timestamp: when.toISOString(), type: 'session_meta', payload: { id: id(), timestamp: when.toISOString(), cwd, originator: 'codex_cli_rs', cli_version: '0.155.1', source: 'cli', model_provider: 'openai' } },
      { timestamp: when.toISOString(), type: 'event_msg', payload: { type: 'user_message', message: 'Pick up where we left off.' } },
    ], daysAgo);
  };
  const folder = (name: string, git: boolean): string => {
    const dir = join(projects, name);
    mkdirSync(dir, { recursive: true });
    if (git && !existsSync(join(dir, '.git'))) execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
    return dir;
  };

  const ledger = folder('ledger-service', true);
  for (const d of [0.1, 0.5, 1, 2, 4, 9, 15]) claude('.claude', ledger, d);
  for (const d of [1, 6]) claude('.claude_work', ledger, d);
  for (const d of [0.3, 3, 12]) codex(ledger, d);
  const marketing = folder('marketing-site', true);
  for (const d of [1, 2, 3, 8, 20]) claude('.claude', marketing, d);
  const infra = folder('infra-terraform', true);
  for (const d of [3, 5, 10, 22]) codex(infra, d);
  const mobile = folder('mobile-app', true);
  for (const d of [2, 7, 11]) claude('.claude_work', mobile, d);
  const tokens = folder('design-tokens', false);
  for (const d of [6, 13]) claude('.claude_work', tokens, d);
  claude('.claude', folder('scratch', false), 12);
  codex(folder('ops-runbooks', false), 18);
  for (const d of [45, 52, 60]) claude('.claude', folder('old-prototype', true), d);
  claude('.claude', join(projects, 'spike-since-deleted'), 2);
}

/** Stand-ins for `claude` and `codex`: a canned `claude mcp list`, and nothing else ever changes. */
export function fakeMcpBinaries(base: string): { claude: string; codex: string } {
  const claude = join(base, 'fake-mcp-claude');
  writeFileSync(claude, [
    '#!/bin/sh',
    'if [ "$1 $2" = "mcp list" ]; then',
    '  printf "Checking MCP server health…\\n\\n"',
    '  echo "linear: https://mcp.linear.app/mcp (HTTP) - ✓ Connected"',
    '  echo "playwright: npx @playwright/mcp@latest - ✓ Connected"',
    '  echo "drupal-db: npx -y @acme/drupal-mcp - ✘ Failed to connect — Connection closed"',
    '  echo "claude.ai Google Drive: https://drivemcp.googleapis.com/mcp/v1 - ! Needs authentication"',
    '  exit 0',
    'fi',
    'echo "The UI sweep’s stand-in changes nothing." >&2',
    'exit 1',
  ].join('\n'), { mode: 0o755 });
  const codex = join(base, 'fake-mcp-codex');
  writeFileSync(codex, '#!/bin/sh\necho "The UI sweep’s stand-in changes nothing." >&2\nexit 1\n', { mode: 0o755 });
  return { claude, codex };
}

/*
 * Northstar's checkout module, so the Changes view has real Drupal work to
 * show in every language it colours: PHP, YAML, Twig, JavaScript and CSS.
 * `before` is what is committed; `after` is the agent's uncommitted edit on
 * NS-6, giving the pay button an accessible name.
 */
const MODULE = 'web/modules/custom/northstar_checkout';

const CONTROLLER = (after: boolean): string => `<?php

namespace Drupal\\northstar_checkout\\Controller;

use Drupal\\Core\\Controller\\ControllerBase;
use Drupal\\commerce_order\\Entity\\OrderInterface;

/**
 * Renders the pay step of checkout.
 */
final class CheckoutController extends ControllerBase {

  /**
   * Builds the pay button for an order.
   *
   * @param \\Drupal\\commerce_order\\Entity\\OrderInterface $order
   *   The order being paid for.
   *
   * @return array
   *   A render array.
   */
  public function build(OrderInterface $order): array {
    $total = $order->getTotalPrice();
${after ? `    // Screen readers announced only "button": name it, with the amount.
    $label = $this->t('Pay @amount', [
      '@amount' => \\Drupal::service('commerce_price.currency_formatter')->format($total->getNumber(), $total->getCurrencyCode()),
    ]);
` : ''}    return [
      '#theme' => 'northstar_pay_button',
      '#total' => $total,
${after ? `      '#label' => $label,
` : ''}      '#attached' => ['library' => ['northstar_checkout/pay-button']],
      '#cache' => ['max-age' => ${after ? '0' : '3600'}],
    ];
  }

  /**
   * Whether the order can be paid now.
   *
   * An order in checkout is a draft until it is placed. Orders held for
   * validation by the fraud check may be paid too, once released.
   *
   * @param \\Drupal\\commerce_order\\Entity\\OrderInterface $order
   *   The order.
   *
   * @return bool
   *   TRUE when the pay button should show.
   */
  public function access(OrderInterface $order): bool {
${after ? `    return in_array($order->getState()->getId(), ['draft', 'validation'], TRUE);` : `    return $order->getState()->getId() === 'draft';`}
  }

}
`;

const ROUTING = (after: boolean): string => `northstar_checkout.pay:
  path: '/checkout/{commerce_order}/pay'
  defaults:
    _controller: '\\Drupal\\northstar_checkout\\Controller\\CheckoutController::build'
    _title: ${after ? "'Pay for your order'" : "'Pay'"}
  requirements:
    _custom_access: '\\Drupal\\northstar_checkout\\Controller\\CheckoutController::access'
${after ? `    # Anonymous checkout is off on this store.
    _permission: 'access checkout'
` : ''}  options:
    parameters:
      commerce_order:
        type: entity:commerce_order
${after ? `    no_cache: true
` : ''}`;

const TEMPLATE = (after: boolean): string => `{#
/**
 * @file
 * The pay button at the end of checkout.
 *
 * Available variables:
 * - total: The order total, formatted.
${after ? ` * - label: The button's accessible name, with the amount.
` : ''} */
#}
<button{{ attributes.addClass('pay-button')${after ? ".setAttribute('aria-label', label)" : ''} }} type="submit">
  <span class="pay-button__icon" aria-hidden="true">{{ icon }}</span>
${after ? `  <span class="visually-hidden">{{ label }}</span>
  {% if total %}{{ 'Pay @total'|t({'@total': total}) }}{% else %}{{ 'Pay'|t }}{% endif %}` : `  {{ 'Pay'|t }}`}
</button>
`;

const BEHAVIOR = (after: boolean): string => `/**
 * @file
 * Disables the pay button while the payment is sent.
 */
(function (Drupal, once) {
  Drupal.behaviors.northstarPayButton = {
    attach(context) {
      once('pay-button', '.pay-button', context).forEach((button) => {
        button.form.addEventListener('submit', () => {
          button.disabled = true;
${after ? `          button.setAttribute('aria-busy', 'true');
          Drupal.announce(Drupal.t('Sending your payment…'));
` : ''}        });
      });
    },
  };
})(Drupal, once);
`;

const STYLES = (after: boolean): string => `/* The pay button, last step of checkout. */
.pay-button {
  display: inline-flex;
  gap: 8px;
  padding: 12px 20px;
  background: #0b5394;
  color: #fff;
}

.pay-button:hover {
  background: #073763;
}
${after ? `
.pay-button:focus-visible {
  outline: 3px solid #ffbf47;
  outline-offset: 2px;
}

.pay-button[aria-busy='true'] {
  cursor: progress;
  opacity: 0.7;
}
` : ''}`;

export function seedCheckoutModule(repo: string, stage: 'before' | 'after'): void {
  const after = stage === 'after';
  for (const [file, text] of [
    ['src/Controller/CheckoutController.php', CONTROLLER(after)],
    ['northstar_checkout.routing.yml', ROUTING(after)],
    ['templates/northstar-pay-button.html.twig', TEMPLATE(after)],
    ['js/pay-button.js', BEHAVIOR(after)],
    ['css/pay-button.css', STYLES(after)],
  ] as const) {
    const path = join(repo, MODULE, file);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, text);
  }
}

/**
 * A small screenshot of the storefront with its free-shipping banner, drawn
 * here as plain shapes so the demo can show an image waiting in a composer.
 */
export function demoScreenshot(): Buffer {
  const width = 360;
  const height = 220;
  type Rgb = [number, number, number];
  const rgb = (hex: number): Rgb => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
  const page = rgb(0xf6f4ef);
  const fills: [number, number, number, number, Rgb][] = [
    [0, 0, width, 26, rgb(0x1f2a33)],
    [14, 9, 60, 8, rgb(0xe8e6e1)],
    [300, 8, 46, 10, rgb(0x63b3e4)],
    [0, 34, width, 30, rgb(0x2f7fb8)],
    [96, 45, 168, 8, rgb(0xffffff)],
    ...[0, 1, 2].flatMap((i): [number, number, number, number, Rgb][] => [
      [14 + i * 114, 78, 104, 126, rgb(0xe2ded6)],
      [20 + i * 114, 84, 92, 70, rgb(0xcfc8bb)],
      [20 + i * 114, 162, 70, 7, rgb(0x8c939a)],
      [20 + i * 114, 176, 40, 7, rgb(0x1f2a33)],
      [76 + i * 114, 186, 36, 12, rgb(0x2f7fb8)],
    ]),
  ];
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) {
      let color = page;
      for (const [fx, fy, fw, fh, c] of fills) if (x >= fx && x < fx + fw && y >= fy && y < fy + fh) color = c;
      row.set(color, 1 + x * 3);
    }
    rows.push(row);
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0)),
  ]);
}
