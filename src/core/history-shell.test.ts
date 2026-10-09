// Claude Code records a `!` shell-mode command as <bash-input>…</bash-input>,
// and its output as <bash-stdout>/<bash-stderr>. Found in the real-app
// scenario run: History showed "<bash-input>wanigan claim CS-3; wanigan
// status</bash-input>" as a conversation's first prompt.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { claudeSlug } from './history.ts';
import { testCore } from './test-support.ts';

const ID = '9a9a9a9a-0000-4000-8000-000000000001';

// Talk to Wanigan runs Claude Code in the project's folder, so its conversations
// are in History too. Found in the real-app scenario run: one showed as
// "<wanigan-state> Wanigan's state at …", untagged among the agents' work.
test('a Talk to Wanigan conversation says so, and shows the owner’s question, not Wanigan’s state', async () => {
  const t = await testCore();
  try {
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const folder = join(t.dir, 'home', '.claude', 'projects', claudeSlug(project.path));
    mkdirSync(folder, { recursive: true });
    const chat = '9a9a9a9a-0000-4000-8000-000000000002';
    const line = (type: 'user' | 'assistant', content: unknown, n: number) => JSON.stringify({
      type, uuid: `c${n}`, isSidechain: false, sessionId: chat, cwd: project.path, gitBranch: 'main', entrypoint: 'sdk-cli',
      timestamp: new Date(Date.now() - (10 - n) * 1000).toISOString(),
      message: type === 'user' ? { role: 'user', content } : { role: 'assistant', model: 'claude-opus-5-5', content },
    });
    const asked = (q: string) => `<wanigan-state>\nWanigan's state at Wed Oct 7, 11:16, covering the project.\n\nNeeds you: nothing.\n</wanigan-state>\n\nThe owner asks:\n${q}`;
    writeFileSync(join(folder, `${chat}.jsonl`), [
      line('user', asked('What needs me here right now?'), 1),
      line('assistant', [{ type: 'text', text: 'Nothing needs you right now.' }], 2),
      line('user', [{ type: 'text', text: asked('Summarize what the agents did today.') }], 3),
    ].join('\n') + '\n');

    const [item] = await t.owner.call('history.list', { projectId: project.id });
    assert.equal(item?.via, 'Talk to Wanigan');
    assert.equal(item?.firstPrompt, 'What needs me here right now?');
    const read = await t.owner.call('history.read', { id: item!.id });
    assert.deepEqual(read.turns.map((x) => `${x.role}: ${x.text}`), [
      'user: What needs me here right now?', 'assistant: Nothing needs you right now.', 'user: Summarize what the agents did today.',
    ]);
  } finally {
    await t.close();
  }
});

test('a shell-mode command reads as the owner typed it, and its output is not a prompt', async () => {
  const t = await testCore();
  try {
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const folder = join(t.dir, 'home', '.claude', 'projects', claudeSlug(project.path));
    mkdirSync(folder, { recursive: true });
    const line = (type: 'user' | 'assistant', content: unknown, n: number) => JSON.stringify({
      type, uuid: `u${n}`, isSidechain: false, sessionId: ID, cwd: project.path, gitBranch: 'main', entrypoint: 'cli',
      timestamp: new Date(Date.now() - (10 - n) * 1000).toISOString(),
      message: type === 'user' ? { role: 'user', content } : { role: 'assistant', model: 'claude-sonnet-5-5', content },
    });
    writeFileSync(join(folder, `${ID}.jsonl`), [
      line('user', '<bash-input>wanigan claim CS-3; wanigan status</bash-input>', 1),
      line('user', '<bash-stdout>wanigan: This card is in the Inbox.</bash-stdout><bash-stderr></bash-stderr>', 2),
      line('assistant', [{ type: 'text', text: 'CS-3 is still in the Inbox.' }], 3),
      line('user', 'fix the cart subtotal', 4),
    ].join('\n') + '\n');

    const [item] = await t.owner.call('history.list', { projectId: project.id });
    assert.ok(item, 'the conversation is listed');
    const shown = JSON.stringify(item);
    assert.doesNotMatch(shown, /<bash-/, 'no CLI markup on the row');
    assert.match(shown, /! wanigan claim CS-3; wanigan status/);

    const read = await t.owner.call('history.read', { id: item.id });
    const turns = read.turns.map((x) => `${x.role}: ${x.text}`);
    assert.deepEqual(turns, ['user: ! wanigan claim CS-3; wanigan status', 'assistant: CS-3 is still in the Inbox.', 'user: fix the cart subtotal']);
  } finally {
    await t.close();
  }
});
