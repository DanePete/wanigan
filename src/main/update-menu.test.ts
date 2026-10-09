import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createUpdateMenu } from './update-menu.ts';
import type { UpdateStatus } from '../shared/updates.ts';

test('repeated menu activation shares the entire check and dialog, then permits another check', async () => {
  let finish!: (status: UpdateStatus) => void;
  let dismiss!: () => void;
  let requests = 0;
  let dialogs = 0;
  const result = new Promise<UpdateStatus>((resolve) => { finish = resolve; });
  const menu = createUpdateMenu({
    check: () => { requests++; return result; },
    show: async () => { dialogs++; await new Promise<void>((resolve) => { dismiss = resolve; }); return { response: 0 }; },
    version: () => '2.0.0',
    open: () => assert.fail('there is no update to open'),
  });
  const first = menu();
  const second = menu();
  finish({ state: 'current', checkedAt: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests, 1);
  assert.equal(dialogs, 1);
  const third = menu();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(dialogs, 1, 'activating while the dialog is open does not stack another');
  dismiss();
  await Promise.all([first, second, third]);
  const later = menu();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests, 2);
  assert.equal(dialogs, 2);
  dismiss();
  await later;
});
