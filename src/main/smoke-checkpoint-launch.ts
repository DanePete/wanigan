import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runGit } from './git';
import { addProject } from './store';
import { registerSessionCheckpoints, finalizeSessionCheckpoints, forgetSessionCheckpoints, listCheckpoints } from './checkpoints';
import { acquireCheckoutActivity } from './checkout-activity';

type Check = (ok: boolean, label: string, detail?: unknown) => void;

/** Public launch barrier and filesystem evidence. No provider or synthetic hook delivery. */
export async function runCheckpointLaunchSmoke(check: Check, say: (text: string) => void): Promise<void> {
  say('── checkpoint launch · capture completes before the caller can start editing');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-checkpoint-launch-')));
  const session = `launch-checkpoint-${randomUUID()}`;
  const git = async (args: string[]) => {
    const result = await runGit(root, args);
    if (!result.ok) throw new Error(result.err);
    return result.out.trim();
  };
  try {
    await git(['init']);
    fs.writeFileSync(path.join(root, 'work.txt'), 'committed\n');
    await git(['add', '.']);
    await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'baseline']);
    const head = await git(['rev-parse', 'HEAD']);
    await addProject(root);
    fs.writeFileSync(path.join(root, 'work.txt'), 'dirty before launch\n');
    await registerSessionCheckpoints({ sessionId: session, cwd: root, hooksCapable: true, gitHead: head });
    // This edit is the first thing a caller can do after registration resolves.
    fs.writeFileSync(path.join(root, 'work.txt'), 'first agent edit\n');
    await finalizeSessionCheckpoints(session);
    const first = listCheckpoints(session).find(row => row.kind === 'session-start');
    check(Boolean(first?.commitHash) && await git(['show', `${first!.commitHash}:work.txt`]) === 'dirty before launch',
      'awaited registration preserves pre-agent dirty bytes even when the next statement edits them');
    check(await git(['rev-parse', 'HEAD']) === head && await git(['show', ':work.txt']) === 'committed',
      'the launch barrier leaves HEAD and the real index unchanged');

    const nested = path.join(root, 'nested'); fs.mkdirSync(nested);
    const release = acquireCheckoutActivity(nested, 'session', session);
    let refused = false;
    try { acquireCheckoutActivity(root, 'restore', 'restore-parent'); } catch { refused = true; }
    check(refused, 'a writer in a nested directory prevents a restore of its containing checkout');
    release();
    const done = acquireCheckoutActivity(root, 'restore', 'restore-parent');
    let writerRefused = false;
    try { acquireCheckoutActivity(nested, 'headless', 'new-writer'); } catch { writerRefused = true; }
    check(writerRefused, 'an acquired restore prevents a new overlapping writer before it starts');
    done();
  } finally {
    await finalizeSessionCheckpoints(session);
    forgetSessionCheckpoints(session);
    fs.rmSync(root, { recursive: true, force: true });
  }
}
