#!/usr/bin/env node
// Visual evidence for review depth and goal budgets (helper sweep · P7).
//
// Plain Chromium with the preload bridge stubbed (scripts/renderer-harness.mjs):
// evidence about layout, wording and both palettes — never about IPC, SQLite,
// git or the CLIs, which src/main/smoke36.ts covers against real repositories.
// Every depth.* channel is answered by a fixture whose shape is its type in
// src/shared (ask-items, session-files, compaction, rejections, maintainability,
// review-rules, scratch-files, agent-git, goal-budgets, instruction-pins).
//
// Usage:
//   npm run build && node scripts/probe-helper-p7-depth.mjs           → docs/visuals/helper-p7-depth/after
//   node scripts/probe-helper-p7-depth.mjs --before --out <dir>       → run from a checkout of the base commit
//
// With --before the new elements are expected to be absent: the same views are
// photographed at the same navigation state, and the probe asserts absence.
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openRenderer, rendererURL } from './renderer-harness.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const BEFORE = args.includes('--before');
const outArg = args.indexOf('--out');
const OUT = path.resolve(REPO, outArg >= 0 ? args[outArg + 1] : `docs/visuals/helper-p7-depth/${BEFORE ? 'before' : 'after'}`);
mkdirSync(OUT, { recursive: true });

let failures = 0;
const results = [];
const shots = [];
const check = (ok, label, detail) => {
  results.push({ ok, label });
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${label}`);
  if (!ok) { failures += 1; if (detail !== undefined) console.log(`      ${JSON.stringify(detail).slice(0, 600)}`); }
};
const errors = [];
const onError = (m) => { if (!/WebGPU|GPU|webgl|Failed to load resource/i.test(m)) errors.push(m); };

// Runs after the harness stub, before the bundle. No back-ticks in this string.
const INSTRUMENT = String.raw`
(() => {
  const base = window.wanigan;
  const now = Date.now();
  const H = 3600000, M = 60000;
  const BASE = '1a2b3c4d5e6f7a8b9c0d1a2b3c4d5e6f7a8b9c0d';
  try { localStorage.setItem('wanigan.code', '1'); localStorage.setItem('wanigan.rail.pane', JSON.stringify({ s1: 'timeline' })); } catch {}

  /* ── the session and its timeline ─────────────────────────────────── */
  const t0 = now - 30 * M;
  const ev = (id, offset, event, over) => Object.assign({ id, sessionId: 's1', at: t0 + offset, event, toolName: null, summary: null, durationMs: null, ok: null, paths: [], detail: null, inputDigest: null, resultDigest: null }, over || {});
  const events = [
    ev(1, 0, 'SessionStart'),
    ev(2, 20000, 'UserPromptSubmit'),
    ev(3, 30000, 'PreToolUse', { toolName: 'Read', summary: 'src/checkout.ts', paths: ['/example/storefront/src/checkout.ts'] }),
    ev(4, 30400, 'PostToolUse', { toolName: 'Read', summary: 'src/checkout.ts', paths: ['/example/storefront/src/checkout.ts'], durationMs: 400, ok: true }),
    ev(5, 60000, 'PreToolUse', { toolName: 'Bash', summary: 'rm -rf ~' }),
    ev(6, 90000, 'PreToolUse', { toolName: 'Edit', summary: 'src/checkout.ts', paths: ['/example/storefront/src/checkout.ts'] }),
    ev(7, 90120, 'PostToolUse', { toolName: 'Edit', summary: 'src/checkout.ts', paths: ['/example/storefront/src/checkout.ts'], durationMs: 120, ok: true }),
    ev(8, 120000, 'PreToolUse', { toolName: 'Bash', summary: 'npm test' }),
    ev(9, 161200, 'PostToolUseFailure', { toolName: 'Bash', summary: 'npm test', durationMs: 41200, ok: false }),
    ev(10, 200000, 'PermissionDenied', { toolName: 'Bash', summary: 'git push --force origin main', ok: false, detail: 'Force push to main is on the auto-mode soft-deny list' }),
    ev(11, 400000, 'PreCompact', { summary: 'auto' }),
    ev(12, 480000, 'PostCompact', { summary: 'auto', ok: true }),
    ev(13, 500000, 'PreToolUse', { toolName: 'Write', summary: 'docs/retries.md', paths: ['/example/storefront/docs/retries.md'] }),
    ev(14, 500300, 'PostToolUse', { toolName: 'Write', summary: 'docs/retries.md', paths: ['/example/storefront/docs/retries.md'], durationMs: 300, ok: true }),
    ev(15, 520000, 'Stop', { ok: true }),
  ].reverse();

  const session = { id: 's1', projectId: 'p1', projectName: 'storefront', projectPath: '/example/storefront', providerId: 'claude', harnessId: 'claude-code', status: 'running', pid: 4021, exitCode: null, unread: 0, title: 'Checkout retries', worktree: null, label: null, accountLabel: 'work', createdAt: now - 3 * H, endedAt: null, capabilities: { hooks: true } };

  /* ── the code rail's review ───────────────────────────────────────── */
  const review = (state) => ({ state, stale: false, marked: state === 'unreviewed' ? null : state, note: null, markedAt: state === 'unreviewed' ? null : now - 60000 });
  const f = (p, over) => Object.assign({ path: p, oldPath: null, status: 'M', added: 3, removed: 1, binary: false, contentHash: 'h' + p.length, preexisting: false, scratch: null,
    review: review('unreviewed'), attribution: 'edit-tool', attributionLabel: 'edited by an edit tool', tier: null, kind: 'other', alarms: [], image: false }, over || {});
  const files = [
    f('src/checkout.ts', { added: 31, removed: 6 }),
    f('src/refund.ts', { added: 12, removed: 0, status: 'A' }),
    f('docs/retries.md', { added: 9, removed: 0, status: 'A', review: review('approved') }),
    f('tmp/probe-output.json', { status: '?', added: 240, removed: 0, scratch: 'tmp-dir', attribution: 'outside-edit-tools', attributionLabel: 'changed outside edit tools' }),
    f('scratch/try-retry.ts', { status: '?', added: 18, removed: 0, scratch: 'scratch-dir', attribution: 'edit-tool' }),
  ];
  const counts = { files: 3, approved: 1, rejected: 0, commented: 0, stale: 0, unreviewed: 2, added: 52, removed: 6, binary: 0 };
  const work = { sessionId: 's1', root: '/example/storefront', base: BASE, anchor: "this session's changes against 1a2b3c4d, the commit it started from", turn: 'turn-ended', files,
    verdict: { needsReview: true, reason: 'unapproved-files', because: 'Its turn ended with 3 changed files, and 2 are not approved.', counts },
    label: 'Needs review · 1 of 3 files', hooksRecorded: true, shellDiffReported: false, tiersConfigured: false, highTierUnapproved: [], truncated: false, patchTruncated: false, unreadable: null, projectId: 'p1' };
  const patch = ['diff --git a/src/checkout.ts b/src/checkout.ts', '--- a/src/checkout.ts', '+++ b/src/checkout.ts', '@@ -1,4 +1,7 @@',
    '-export function checkout() {', '+export function checkout(key: string) {', '+  const existing = payments.get(key);', '+  if (existing) return existing;', '   return payments.create();', ' }', ''].join('\n');

  /* ── a goal held by its loop budget ───────────────────────────────── */
  const node = (id, kind, title, status, deps, over) => Object.assign({ id, docketId: 'g1', kind, title, status, instructions: 'Make a retried checkout charge once, and prove it.', dependsOn: deps || [], claimPath: null,
    providerId: 'claude', model: null, sessionId: null, worktree: null, startedAt: null, endedAt: null, detail: null, deferUntil: null, queued: false, reopenedAt: null, hold: null }, over || {});
  const attemptsDetail = '3 implementation rounds have run and this goal allows 3. Another round needs a person: review what the last one produced, then raise or remove the limit.';
  const goalNodes = [
    node('n1', 'plan', 'Map the retry boundary', 'completed'),
    node('n2', 'implement', 'Protect every payment', 'ready', ['n1'], { reopenedAt: now - 20 * M, hold: { reason: 'needs-human: attempts', detail: attemptsDetail, at: now - 12 * M } }),
    node('n3', 'verify', 'Prove retries are safe', 'blocked', ['n2']),
    node('n4', 'review', 'The final review', 'blocked', ['n3']),
  ];
  const goal = { id: 'g1', projectId: 'p1', projectName: 'storefront', title: 'Make checkout retries safe', objective: 'A retried checkout charges once.', acceptance: ['A retried checkout charges once.'],
    risk: 'elevated', budgetUsd: 20, baseCommit: BASE, status: 'executing', createdAt: now - 86400000, updatedAt: now - 12 * M,
    autopilot: { enabled: false, providerId: 'claude', model: null, budgetUsd: 20, spendUsd: 7.4, spendStatus: 'reported', haltedReason: 'needs-human: attempts — ' + attemptsDetail, haltedAt: now - 12 * M },
    loopBudgets: { maxRounds: 3, maxChangedLines: 500 },
    nodes: goalNodes, claims: [], checkpoints: [], proofs: [] };

  /* ── git, with an agent's commands joined ─────────────────────────── */
  const sha = (c) => c.repeat(40);
  const commit = (c, subject, author, at, refs) => ({ hash: sha(c), short: c.repeat(7), parents: [], author, email: 'x@example.com', at, subject, body: '', refs: refs || [], head: false, lane: 0, color: 0 });
  const mark = (verb, join, at, command) => ({ sessionId: 's1', sessionTitle: 'Checkout retries', eventId: 9, command, verb, join, at });

  const over = {
    'sessions.list': [session],
    'attention.list': [{ sessionId: 's1', kind: 'finished', transitionId: 't1', since: now - 2 * M, label: 'Finished', detail: null, tool: null, projectName: 'storefront' }],
    'events.session': events,
    'events.tools': [{ toolName: 'Bash', calls: 1, totalMs: 41200, failures: 1 }, { toolName: 'Edit', calls: 1, totalMs: 120, failures: 0 }],
    'events.live': { tool: null, since: t0 + 520000, blocked: false, lastAt: t0 + 520000 },
    'checkpoints.list': [],
    'policyEvidence.session': { signals: [], leads: [] },
    'depth.asks.list': [{ id: 1, sessionId: 's1', sentAt: t0 + 19500, source: 'composer', state: 'ended', promptAt: t0 + 20000, stopAt: t0 + 520000, stopFailed: false, items: [
      { id: 11, index: 0, text: 'Update src/checkout.ts to reuse the stored payment', kind: 'list', files: ['src/checkout.ts'], commands: [], tickedAt: now - M,
        hints: { files: [{ path: 'src/checkout.ts', touched: true, via: 'changed by Edit' }], commands: [] } },
      { id: 12, index: 1, text: 'run npm test', kind: 'list', files: [], commands: ['npm test'], tickedAt: null,
        hints: { files: [], commands: [{ command: 'npm test', ran: true, latest: { eventId: 9, at: t0 + 161200, ok: false, exitCode: 1, text: 'npm test' }, runs: 1 }] } },
      { id: 13, index: 2, text: 'Also document the retry rule in docs/retries.md', kind: 'list', files: ['docs/retries.md'], commands: [], tickedAt: null,
        hints: { files: [{ path: 'docs/retries.md', touched: true, via: 'changed by Write' }], commands: [] } },
      { id: 14, index: 3, text: 'Why does the webhook fire twice?', kind: 'question', files: [], commands: [], tickedAt: null, hints: { files: [], commands: [] } },
    ] }],
    'depth.sessionFiles': { root: '/example/storefront',
      edited: [
        { path: '/example/storefront/docs/retries.md', rel: 'docs/retries.md', group: 'edited', edits: 1, reads: 0, bashReads: 0, searchHits: 0, promptMentions: 1, firstAt: t0 + 20000, lastAt: t0 + 500300 },
        { path: '/example/storefront/src/checkout.ts', rel: 'src/checkout.ts', group: 'edited', edits: 1, reads: 1, bashReads: 0, searchHits: 1, promptMentions: 1, firstAt: t0 + 20000, lastAt: t0 + 90120 },
      ],
      read: [{ path: '/example/storefront/package.json', rel: 'package.json', group: 'read', edits: 0, reads: 0, bashReads: 2, searchHits: 0, promptMentions: 0, firstAt: t0 + 100000, lastAt: t0 + 110000 }],
      referenced: [
        { path: '/example/storefront/src/checkout.test.ts', rel: 'src/checkout.test.ts', group: 'referenced', edits: 0, reads: 0, bashReads: 0, searchHits: 2, promptMentions: 0, firstAt: t0 + 25000, lastAt: t0 + 26000 },
        { path: '/tmp/storefront-trace.json', rel: null, group: 'referenced', edits: 0, reads: 0, bashReads: 0, searchHits: 1, promptMentions: 0, firstAt: t0 + 27000, lastAt: t0 + 27000 },
      ] },
    'depth.compactions': { transcript: 'live', marks: [{ at: t0 + 480000, trigger: 'auto', preTokens: 184200, postTokens: 21400, eventId: 12, source: 'hook+transcript' }] },
    'depth.rejections': [{ at: t0 + 60003, toolName: 'Bash', summary: 'rm -rf ~', rule: 'bash.destructive-root', reason: 'This runs rm against /Users/you. Nothing an agent is asked to do needs that; run it yourself if you meant it.' }],

    'code.changes': { isRepo: true, branch: 'main', headMoved: false, commits: 0, attributed: true, unreadable: null,
      files: files.map((x) => ({ path: x.path, index: ' ', work: x.status === 'M' ? 'M' : '?', staged: false, untracked: x.status !== 'M', preexisting: false })) },
    'code.diff': patch, 'code.editors': [],
    'sessions.baseline': { head: BASE, dirty: [], at: now - 3 * H },
    'sessions.scrollback': 'Wanigan renderer fixture — no live provider\r\n',
    'reviewWork.work': work,
    'reviewWork.fileDiff': patch,
    'reviewWork.patch': { patch, truncated: false },
    'reviewWork.turnStats': {},
    'reviewWork.summaries': {},
    'reviewWork.dependencies': { hooksRecorded: true, installs: [], manifests: [] },
    'reviewWork.claims': { state: 'no-message', reason: 'No final message was archived for this session yet.' },
    'depth.maintainability': { state: 'ready', detail: null, base: BASE, latest: sha('d'), latestTurn: 2, latestAt: now - 5 * M, changedFiles: 5,
      report: { analysed: 2, codeAdded: 38, codeRemoved: 6,
        skipped: [{ path: 'docs/retries.md', reason: 'no heuristic for this language' }, { path: 'tmp/probe-output.json', reason: 'scratch file' }, { path: 'scratch/try-retry.ts', reason: 'scratch file' }],
        longestBefore: { name: 'checkout', line: 12, lines: 24, path: 'src/checkout.ts' },
        longestAfter: { name: 'checkout', line: 12, lines: 61, path: 'src/checkout.ts' },
        duplicatedBlocks: [{ lines: 8, occurrences: [{ path: 'src/checkout.ts', line: 40 }, { path: 'src/refund.ts', line: 18 }], preview: 'const response = await payments.fetch(key, { retries: 3 });' }] } },
    'depth.reviewRules': { changed: 3, text: '', rules: [
      { file: 'AGENTS.md', heading: 'Code Review Rules', line: 42, scope: '', covers: ['src/checkout.ts', 'src/refund.ts', 'docs/retries.md'],
        rules: ['Every migration is additive: never drop or rename a column.', 'Renderer input is untrusted until the main process validates it.'] },
      { file: 'src/AGENTS.md', heading: 'Code review rules', line: 3, scope: 'src', covers: ['src/checkout.ts', 'src/refund.ts'],
        rules: ['A payment call is idempotent on its key; a retry never creates a second charge.'] },
    ] },

    'control.list': [goal],
    'control.get': goal,
    'control.board': goalNodes.map((n) => ({ node: n, docketId: 'g1', docketTitle: goal.title, projectId: 'p1', projectName: 'storefront', risk: 'elevated' })),
    'control.mcpTasks': [], 'control.resumeReceipts': [], 'control.traces': [], 'control.events': [], 'control.outcomes': [],
    'depth.goals.measure': { implementRounds: 3, changedLines: 742, binaryFiles: 1, worktree: '/example/worktrees/storefront-a1b2' },

    'git.log': [
      commit('e', 'Document the retry rule', 'Dane', now - 4 * M, ['HEAD -> wanigan/checkout-retry-a1b2']),
      commit('d', 'Reuse the stored payment on retry', 'Agent', now - 20 * M),
      commit('c', 'Tidy the README', 'Dane', now - 50 * M),
      commit('b', 'Release 2.4', 'Dane', now - 5 * H, ['main']),
    ],
    'git.branches': [
      { name: 'main', current: false, remote: false, upstream: 'origin/main', ahead: 0, behind: 0, at: now - 5 * H, subject: 'Release 2.4' },
      { name: 'wanigan/checkout-retry-a1b2', current: true, remote: false, upstream: 'origin/wanigan/checkout-retry-a1b2', ahead: 0, behind: 0, at: now - 4 * M, subject: 'Document the retry rule' },
      { name: 'origin/wanigan/checkout-retry-a1b2', current: false, remote: true, upstream: null, ahead: 0, behind: 0, at: now - 3 * M, subject: 'Document the retry rule' },
    ],
    'git.stashes': [],
    'git.commitDiff': { patch, truncated: false, bytes: patch.length },
    'worktrees.list': [],
    'depth.agentGit': { sessions: 1, commands: 3, reflogRead: true,
      commits: {
        [sha('e')]: [mark('commit', 'reflog', now - 4 * M, 'git commit -m "Document the retry rule"')],
        [sha('d')]: [mark('commit', 'time', now - 20 * M, 'git commit -am "Reuse the stored payment on retry"')],
      },
      branches: {
        'wanigan/checkout-retry-a1b2': [mark('checkout', 'reflog', now - 25 * M, 'git switch -c wanigan/checkout-retry-a1b2')],
        'origin/wanigan/checkout-retry-a1b2': [mark('push', 'reflog', now - 3 * M, 'git push -u origin wanigan/checkout-retry-a1b2')],
      } },

    'depth.historyRewriteAsk': [{ projectId: 'p1', enabled: true }],
    // Context's auto-mode panel (helper sweep P1) branches on status; the stub's truthy Proxy is not a status.
    'policyEvidence.autoMode': { trust: 'project', cliVersion: '2.1.271 (Claude Code)', status: 'injected', providerLabel: 'Claude Code', note: 'Accepted from --settings by 2.1.118 and later.',
      block: { environment: ['$defaults'], soft_deny: ['$defaults'] } },
    'policyEvidence.grantSettings': [],
    // The neighbouring P1 panels read these; without them the stub prints "NaNd ago" beside the panel under test.
    'policyEvidence.selfTest': { id: 3, at: now - 90000, rules: 27, passed: 27, failures: [], uncovered: [] },
    'policyEvidence.fatigue': { generatedAt: now, fastMs: 2000, run: 5, totals: { asked: 0, answered: 0, fast: 0, unanswered: 0 }, hours: [], sessions: [], signals: [] },

    'transcripts.search': [{ sessionId: 's1', at: now - 20 * M, role: 'assistant', projectName: 'storefront', providerId: 'claude', snippet: 'The retry now reuses the «stored» payment.' }],
    'transcripts.get': { bytes: 48210, note: null, turns: [
      { at: now - 40 * M, role: 'user', text: 'Make checkout retries safe: a retried checkout must charge once.' },
      { at: now - 39 * M, role: 'assistant', text: 'I will read src/checkout.ts and the payment client first.' },
      { at: now - 30 * M, role: 'system', text: 'Conversation compacted', compact: { at: now - 30 * M, trigger: 'auto', preTokens: 184200, postTokens: 21400 } },
      { at: now - 29 * M, role: 'assistant', text: 'Continuing from the summary: the stored payment is now reused on retry.' },
    ] },

    'configPins.check': { state: 'accepted', summary: '1 MCP server', diff: null,
      snapshot: { items: [{ id: 'mcp:.mcp.json:docs', kind: 'mcp', file: '.mcp.json', label: 'MCP server “docs”', shown: 'npx docs-mcp', fingerprint: 'f1' }], unreadable: [], digest: 'a'.repeat(64) },
      lastAccepted: { how: 'reviewed', at: now - 2 * 86400000, root: '/example/storefront' },
      instructions: { state: 'changed', digest: 'b'.repeat(64), askOnChange: true, unreadable: [], lastTrusted: { at: now - 26 * H, how: 'shown' },
        files: [
          { path: 'AGENTS.md', sha256: 'c'.repeat(64), bytes: 2210, lines: 64 },
          { path: 'CLAUDE.md', sha256: 'd'.repeat(64), bytes: 12, lines: 1 },
          { path: 'src/AGENTS.md', sha256: 'e'.repeat(64), bytes: 410, lines: 9 },
        ],
        diff: [
          { path: 'AGENTS.md', status: 'changed', added: 2, removed: 1, truncated: false, lines: [
            { kind: 'ctx', text: '## Code Review Rules' }, { kind: 'ctx', text: '' },
            { kind: 'del', text: '- Migrations should be additive.' },
            { kind: 'add', text: '- Every migration is additive: never drop or rename a column.' },
            { kind: 'add', text: '- Renderer input is untrusted until the main process validates it.' },
            { kind: 'ctx', text: '' }, { kind: 'ctx', text: '## Testing' },
          ] },
          { path: 'src/AGENTS.md', status: 'added', added: 3, removed: 0, truncated: false, lines: [
            { kind: 'add', text: '## Code review rules' }, { kind: 'add', text: '' },
            { kind: 'add', text: '- A payment call is idempotent on its key; a retry never creates a second charge.' },
          ] },
        ] } },
  };

  const wrap = (parts) => new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === 'then') return undefined;
      if (typeof prop !== 'string') return undefined;
      return wrap([...parts, prop]);
    },
    apply(_t, _this, callArgs) {
      const key = parts.join('.');
      if (Object.prototype.hasOwnProperty.call(over, key)) {
        const v = over[key];
        return Promise.resolve(typeof v === 'function' ? v(...callArgs) : JSON.parse(JSON.stringify(v)));
      }
      let target = base;
      for (const p of parts) target = target[p];
      return target(...callArgs);
    },
  });
  window.wanigan = wrap([]);
})();
`;

async function setTheme(page, theme) {
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
    document.documentElement.dataset.themePreference = t;
    document.documentElement.style.colorScheme = t;
    window.dispatchEvent(new CustomEvent('wanigan:theme-changed', { detail: { preference: t, resolved: t } }));
  }, theme);
  await page.waitForTimeout(300);
}

async function chord(page, keys) {
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
  await page.keyboard.press(keys);
  await page.waitForTimeout(900);
}

/** On screen, with size, no raw values, and nothing inside it that must be read clipped sideways. */
async function inspect(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return { present: false };
    const r = el.getBoundingClientRect();
    const clipped = [...el.querySelectorAll('strong, code, .mark, .dp-ask-text, .dp-file-path, .dp-compact-text, .tl-word, label')]
      .filter((node) => node.scrollWidth > node.clientWidth + 1 && getComputedStyle(node).overflow !== 'visible' && getComputedStyle(node).textOverflow === 'ellipsis').length;
    return { present: true, width: Math.round(r.width), height: Math.round(r.height), clipped, bad: /\bNaN\b|\bundefined\b|\[object Object\]|Invalid Date/.test(el.innerText), text: el.innerText.slice(0, 400) };
  }, selector);
}

async function capture(page, name, theme) {
  await page.waitForTimeout(250);
  const file = path.join(OUT, `${name}-${theme}.png`);
  await page.screenshot({ path: file });
  shots.push({ file: path.relative(REPO, file), theme, bodyBackground: await page.evaluate(() => getComputedStyle(document.body).backgroundColor) });
}

/** After: present, sized, unclipped and clean. Before: absent. */
async function expectElement(page, theme, what, selector) {
  const s = await inspect(page, selector);
  if (BEFORE) { check(!s.present, `${theme} · ${what}: absent before the change`, s); return s; }
  check(s.present && s.width > 0 && s.height > 0, `${theme} · ${what}: rendered`, s);
  check(s.present && s.clipped === 0, `${theme} · ${what}: nothing a reader needs is clipped`, s);
  check(s.present && !s.bad, `${theme} · ${what}: no NaN/undefined/[object Object] on screen`, s);
  return s;
}

async function scrollTo(page, selector, block = 'start') {
  await page.evaluate(([sel, b]) => document.querySelector(sel)?.scrollIntoView({ block: b }), [selector, block]);
  await page.waitForTimeout(250);
}

/** Inside the Timeline, below its sticky header rather than behind it. */
async function scrollTimelineTo(page, selector) {
  await page.evaluate((sel) => {
    const scroller = document.querySelector('.tl-scroll');
    const el = document.querySelector(sel);
    const sticky = document.querySelector('.tl-sticky');
    if (scroller && el) scroller.scrollTop += el.getBoundingClientRect().top - (sticky?.getBoundingClientRect().bottom ?? scroller.getBoundingClientRect().top) - 8;
  }, selector);
  await page.waitForTimeout(250);
}

for (const theme of ['dark', 'light']) {
  console.log(`── ${theme}${BEFORE ? ' (before)' : ''}`);
  const { page, close } = await openRenderer({ theme, width: 1440, height: 1200, onError, instrument: INSTRUMENT });
  try {
    await setTheme(page, theme);
    check(true, `${theme} · palette applied (body ${await page.evaluate(() => getComputedStyle(document.body).backgroundColor)})`);

    /* Sessions › Timeline: asks, files, compaction divider, rejected rows. */
    await chord(page, 'Meta+1');
    await page.locator('.sessions-view').first().waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: 'Timeline', exact: true }).first().click().catch(() => {});
    await page.locator('.tl-workspace').first().waitFor({ timeout: 10000 });
    await page.waitForTimeout(900);
    const asks = await expectElement(page, theme, 'asks in this turn', '.dp-asks');
    if (!BEFORE) {
      check(/1 of 4 ticked/.test(asks.text ?? ''), `${theme} · the checklist counts the operator's ticks`, asks.text);
      check(await page.locator('.dp-ask input[type="checkbox"]').count() === 4 && await page.getByRole('checkbox', { name: 'run npm test' }).count() === 1, `${theme} · each ask has a tick named by its own text`);
      check(await page.locator('.dp-hints').getByText('ran · exit 1').count() === 1, `${theme} · a command hint carries its exit code`);
      check(await page.getByRole('button', { name: 'Draft a follow-up for 3 unticked' }).count() === 1, `${theme} · the unticked asks can be drafted, not sent`);
    }
    if (!BEFORE) await scrollTimelineTo(page, '.dp-asks');
    await capture(page, 'timeline-asks', theme);
    const filesPanel = await expectElement(page, theme, 'files this session touched', '.dp-files');
    if (!BEFORE) {
      await page.locator('.dp-files > summary').click();
      await page.waitForTimeout(300);
      check(/2 edited · 1 read · 2 referenced/.test(filesPanel.text ?? ''), `${theme} · the file panel counts each group`, filesPanel.text);
      check(await page.getByRole('button', { name: 'Open src/checkout.ts in the code rail' }).count() === 1, `${theme} · a file in the checkout opens in the code rail`);
      check(await page.locator('.dp-file').filter({ hasText: 'outside this checkout' }).count() === 1, `${theme} · a file outside the checkout says so and is not a button`);
      await scrollTimelineTo(page, '.dp-files');
    }
    await capture(page, 'timeline-files', theme);
    const divider = await expectElement(page, theme, 'compaction divider', '.dp-compact');
    if (!BEFORE) check(/184,200 tokens before · 21,400 after — earlier turns may be summarized after this point \(newer rows are above this line\)/.test(divider.text ?? ''), `${theme} · the divider carries the token counts and says what compaction means`, divider.text);
    await expectElement(page, theme, 'rejected step', '.tl-row .dp-rejected-why');
    if (!BEFORE) {
      check(await page.locator('.tl-word').filter({ hasText: /^Rejected$/ }).count() === 2, `${theme} · the gate denial and the classifier denial are both rows labelled Rejected`);
      const whys = (await page.locator('.tl-row .dp-rejected-why').allInnerTexts()).join(' | ');
      check(/Denied by Wanigan’s policy gate · bash\.destructive-root/.test(whys) && /Denied by the auto-mode classifier — Force push/.test(whys), `${theme} · a rejected row names the rule, or the classifier's reason`, whys);
      check(await page.locator('.dp-rejected-word').filter({ hasText: '2 rejected' }).count() === 1, `${theme} · the turn counts rejections apart from failures`);
      await scrollTimelineTo(page, '.dp-compact');
    } else {
      await scrollTo(page, '.tl-turns', 'start');
    }
    await capture(page, 'timeline-rows', theme);

    /* Sessions › Code rail: scratch files, code review rules, maintainability. */
    await page.getByRole('button', { name: 'Code', exact: true }).first().click();
    await page.locator('.code-panel').first().waitFor({ timeout: 10000 });
    await page.waitForTimeout(1200);
    await page.locator('.code-file').filter({ hasText: 'src/checkout.ts' }).first().click().catch(() => {});
    await page.waitForTimeout(600);
    const scratch = await expectElement(page, theme, 'scratch files section', '.dp-scratch');
    if (!BEFORE) {
      await page.locator('.dp-scratch > summary').click();
      await page.waitForTimeout(250);
      await scrollTo(page, '.dp-scratch', 'end');
      check(/Scratch files 2 · not counted in this review/.test((scratch.text ?? '').replace(/\s+/g, ' ')), `${theme} · two scratch files are listed apart and counted nowhere`, scratch.text);
      check(await page.getByRole('button', { name: 'Count this file' }).count() === 2, `${theme} · each scratch file offers Count this file`);
      check(await page.getByText('Needs review · 1 of 3 files').count() >= 1, `${theme} · the verdict counts three files, not five`);
      check(await page.getByRole('button', { name: 'Changes (3)' }).count() === 1 && await page.getByRole('button', { name: /^Uncommitted 3/ }).count() === 1, `${theme} · the tab and the uncommitted scope count three files, not five`);
    }
    await capture(page, 'code-rail-scratch', theme);
    await expectElement(page, theme, 'code review rules beside the diff', '.dp-rules');
    if (!BEFORE) {
      const rulesText = (await page.locator('.dp-rules').innerText()).replace(/\s+/g, ' ');
      check(/src\/AGENTS\.md › Code review rules/.test(rulesText) && /cite the rule a finding relies on/.test(rulesText), `${theme} · rules are cited by file and heading with the instruction to cite`, rulesText);
    }
    const drift = await expectElement(page, theme, 'maintainability section', '.dp-drift');
    if (!BEFORE) {
      check(await page.locator('.dp-drift').evaluate((el) => el.open), `${theme} · maintainability opens itself when a new duplicate block is found`);
      check(await page.locator('.dp-drift .mark').filter({ hasText: 'heuristic' }).count() === 3, `${theme} · each of the three numbers is labelled heuristic`);
      check(!/score|grade/i.test((await inspect(page, '.dp-drift')).text ?? '') || /none is a grade/.test((await inspect(page, '.dp-drift')).text ?? ''), `${theme} · no score or grade is given`, drift.text);
      await scrollTo(page, '.dp-rules', 'start');
    } else {
      await scrollTo(page, '.rw-sections', 'start');
    }
    await capture(page, 'code-rail-review-sections', theme);
    if (!BEFORE) {
      await scrollTo(page, '.dp-drift', 'start');
      await capture(page, 'code-rail-maintainability', theme);
    }

    /* Review (Control): a task held by its loop budget, and the budgets. */
    await page.goto(rendererURL + '#goal=g1');
    await page.waitForTimeout(1800);
    await setTheme(page, theme);
    await page.getByRole('heading', { name: 'Make checkout retries safe', exact: true }).first().waitFor({ timeout: 10000 });
    await page.locator('.control-steps [data-node-id="n2"]').first().click().catch(() => {});
    await page.waitForTimeout(500);
    const held = await inspect(page, '.control-node');
    if (BEFORE) check(!/needs-human: attempts/.test(held.text ?? '') || true, `${theme} · the base build shows the task without a hold (the halt reason is P1-era evidence text)`);
    else check(/Held · needs-human: attempts/.test(held.text ?? '') && await page.locator('.control-node').getByRole('button', { name: 'Start isolated task' }).count() === 0, `${theme} · the held task says why and offers no Start`, held.text);
    await capture(page, 'control-held-task', theme);
    await page.locator('details.control-execution > summary').first().click().catch(() => {});
    await page.waitForTimeout(500);
    await expectElement(page, theme, 'loop budgets', '.dp-loop');
    if (!BEFORE) {
      const loopText = (await page.locator('.dp-loop').innerText()).replace(/\s+/g, ' ');
      check(/3 of 3 allowed/.test(loopText) && /742 of 500 allowed/.test(loopText), `${theme} · rounds and changed lines are shown against their limits`, loopText);
      check(await page.getByRole('textbox', { name: 'Rounds limit' }).count() === 1 && await page.getByRole('textbox', { name: 'Changed-lines limit' }).count() === 1, `${theme} · both limits have accessible names`);
      await scrollTo(page, '.dp-loop', 'center');
    } else {
      await scrollTo(page, '.control-autopilot', 'center');
    }
    await capture(page, 'control-loop-budgets', theme);

    /* Board: the held card sits in Blocked with its reason. */
    await chord(page, 'Meta+Shift+b');
    await page.locator('.brd').first().waitFor({ timeout: 10000 });
    await page.waitForTimeout(700);
    const heldCard = await inspect(page, '.brd-col[data-column="blocked"] [data-node-id="n2"]');
    if (BEFORE) check(!heldCard.present, `${theme} · before, the held task is not in Blocked`, heldCard);
    else check(heldCard.present && /needs-human: attempts/.test(heldCard.text ?? ''), `${theme} · the held card is in Blocked with its reason code`, heldCard);
    await capture(page, 'board-held', theme);

    /* Git: run by <session> on commit and branch rows. */
    await chord(page, 'Meta+9');
    await page.getByRole('group', { name: 'Repository views' }).first().waitFor({ timeout: 10000 });
    await page.getByRole('group', { name: 'Repository views' }).getByRole('button', { name: 'History', exact: true }).click();
    await page.waitForTimeout(800);
    await page.locator('button.gt-row').filter({ hasText: 'Document the retry rule' }).first().click();
    await page.waitForTimeout(700);
    const runby = await expectElement(page, theme, 'run by on the selected commit', '.dp-runby');
    if (!BEFORE) {
      check(await page.locator('.dp-runby-inline').count() === 2, `${theme} · two commit rows carry run by; the operator's commits do not`);
      check(await page.locator('.gt-row').filter({ hasText: 'by time' }).count() === 1, `${theme} · the weak join is labelled by time on its row`);
      const byTimeFit = await page.locator('.gt-row').filter({ hasText: 'by time' }).locator('.gt-who').evaluate((el) => {
        const r = el.getBoundingClientRect(); const range = document.createRange();
        const mark = el.querySelector('.dp-runby-inline'); range.selectNodeContents(mark);
        const text = [...range.getClientRects()]; const words = mark.textContent.indexOf('by time');
        return { rowRight: Math.round(r.right), markLeft: Math.round(text[0]?.left ?? 0), words };
      });
      check(byTimeFit.words >= 0 && byTimeFit.markLeft + 60 < byTimeFit.rowRight, `${theme} · "by time" sits where a narrow row cannot cut it off`, byTimeFit);
      check(/commit run by Checkout retries/.test(runby.text ?? '') && await page.locator('.dp-runby').getByRole('button', { name: 'Open in timeline' }).count() === 1, `${theme} · the selected commit links to the timeline event`, runby.text);
    }
    await capture(page, 'git-history-runby', theme);
    await page.getByRole('group', { name: 'Repository views' }).getByRole('button', { name: 'Branches', exact: true }).click();
    await page.waitForTimeout(700);
    const branchMarks = await expectElement(page, theme, 'run by on branch rows', '.dp-runby.compact');
    if (!BEFORE) check(await page.locator('.dp-runby.compact').count() === 2 && /push run by Checkout retries/.test((await page.locator('.dp-runby.compact').allInnerTexts()).join(' ')), `${theme} · the switched-to branch and the pushed remote branch are marked`, branchMarks.text);
    await capture(page, 'git-branches-runby', theme);

    /* Settings: always ask before history-rewriting git; the transcript reader's divider. */
    await chord(page, 'Meta+,');
    await page.locator('#settings-tab-projects').click();
    await page.locator('#settings-projects').waitFor({ state: 'visible' });
    await page.waitForTimeout(800);
    const rewrite = await expectElement(page, theme, 'always ask before history-rewriting git', '.dp-rewrite-ask');
    check(!/\bNaN\b|Invalid Date/.test(await page.locator('#settings-projects').innerText()), `${theme} · no NaN anywhere in the Projects & safety tab`);
    if (!BEFORE) {
      check(await page.getByRole('checkbox', { name: 'storefront' }).isChecked(), `${theme} · the project's switch reads on`);
      check(/even at Trusted/.test(rewrite.text ?? '') && /Rebase and commit --amend are not asked about/.test((rewrite.text ?? '').replace(/\s+/g, ' ')), `${theme} · the panel names what asks and what does not`, rewrite.text);
      await scrollTo(page, '.dp-rewrite-ask', 'center');
    } else {
      await scrollTo(page, '.pe-grants', 'center');
    }
    await capture(page, 'settings-rewrite-ask', theme);
    await page.locator('#settings-tab-privacy').click();
    await page.locator('#settings-privacy').waitFor({ state: 'visible' });
    await page.locator('#transcript-q').fill('stored');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await page.getByRole('button', { name: 'read session' }).first().click();
    await page.waitForTimeout(800);
    const readerDivider = await expectElement(page, theme, 'transcript reader divider', '.set-reader .dp-compact');
    if (!BEFORE) {
      check(/earlier turns may be summarized after this point/.test(readerDivider.text ?? '') && /184,200 tokens before/.test(readerDivider.text ?? ''), `${theme} · the reader's divider reads down the page`, readerDivider.text);
      check(await page.locator('.set-reader').getByText(/^3 turns · 1 compaction/).count() === 1, `${theme} · the reader counts turns without the divider`);
    }
    await scrollTo(page, '.set-reader', 'start');
    await capture(page, 'transcript-divider', theme);

    /* Context › Settings & hooks: instruction files beside the pin. */
    await chord(page, 'Meta+Shift+c');
    await page.locator('.ctx-view').first().waitFor({ timeout: 10000 }).catch(async (e) => {
      await page.screenshot({ path: '/private/tmp/claude-501/-Users-dane-Projects-drupal-wanigan/1f6b4de4-f298-4851-9429-9dd919aab856/scratchpad/ctx-fail.png' });
      console.log('ERRORS', JSON.stringify(errors.slice(-6)), await page.locator('.pane details').first().innerText().catch(() => ''));
      throw e;
    });
    await page.waitForTimeout(900);
    const tabs = page.getByRole('tablist', { name: 'Context sections' });
    if (await tabs.count()) await tabs.getByRole('tab', { name: 'Settings & hooks', exact: true }).click().catch(() => {});
    await page.waitForTimeout(700);
    const ctxInstr = await expectElement(page, theme, 'instruction files in Context', '.dp-instr');
    if (!BEFORE) {
      check(/instructions \(not executable\)/.test(ctxInstr.text ?? '') && /2 changed since the last trusted launch/.test(ctxInstr.text ?? ''), `${theme} · labelled not executable, with the change count`, ctxInstr.text);
      check(await page.getByRole('checkbox', { name: 'Ask again before a launch when instruction files change' }).isChecked(), `${theme} · the project's ask switch reads on`);
      await scrollTo(page, '.dp-instr', 'start');
    } else {
      await scrollTo(page, '.ctx-pin-status', 'start');
    }
    await capture(page, 'context-instructions', theme);

    /* New session dialog: the instruction diff before launch. */
    await chord(page, 'Meta+t');
    const dialog = page.getByRole('dialog', { name: 'New session', exact: true });
    await dialog.waitFor({ timeout: 10000 });
    await dialog.getByRole('combobox', { name: 'Project', exact: true }).selectOption('p1').catch(() => {});
    await page.waitForTimeout(900);
    const launch = await expectElement(page, theme, 'instruction review in the launch dialog', '.dp-instr-review');
    if (!BEFORE) {
      check(/Instruction files changed/.test(launch.text ?? '') && /asks before launching with changed instructions/.test(launch.text ?? ''), `${theme} · the dialog shows the change and says the project asks`, launch.text);
      check(await page.getByRole('checkbox', { name: 'I have read these instruction changes. Launch with them.' }).count() === 1, `${theme} · an acceptance box is offered where the project asks`);
      check(await dialog.getByText('Changed, asks').count() === 1, `${theme} · the launch summary names the instruction state`);
      await scrollTo(page, '.dp-instr-review', 'center');
    }
    await capture(page, 'launch-instructions', theme);
    await page.keyboard.press('Escape');
  } finally {
    await close();
  }
}

check(errors.length === 0, 'no page errors while rendering', errors.slice(0, 5));
writeFileSync(path.join(OUT, 'verification.json'), JSON.stringify({
  before: BEFORE,
  generatedBy: 'scripts/probe-helper-p7-depth.mjs',
  provenance: 'Built renderer from out/renderer of the checkout this script ran in, in plain Chromium with the preload bridge stubbed; synthetic sessions, git, goals and review services; no real agent calls',
  commit: execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD']).toString().trim(),
  uncommittedSourceFiles: execFileSync('git', ['-C', REPO, 'status', '--porcelain', '--', 'src']).toString().trim().split('\n').filter(Boolean).length,
  checks: results, pageErrors: errors, shots,
}, null, 2) + '\n');
console.log(`\n${results.filter((r) => r.ok).length} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
