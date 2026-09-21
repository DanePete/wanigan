import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { db } from './db';
import { addProject } from './store';
import * as control from './control';
import * as relay from './relay';
import * as delivery from './relay-delivery';
import * as review from './review';
import type { RelayRead } from '../shared/types';

type Check = (ok: boolean, label: string, detail?: unknown) => void;
type Say = (message: string) => void;

/** Real temporary repositories, checks and local shell commands; no provider or deployment service. */
export async function runRelayDeliverySmoke(check: Check, say: Say): Promise<void> {
  say('── relay delivery · accepted checkout, explicit commit, project command and recorded outcomes');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-delivery-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const refused = async (run: () => unknown | Promise<unknown>) => {
    try {
      const result = await run() as { commit?: { status: string; detail: string | null }; deploy?: { status: string; detail: string | null } } | undefined;
      return [result?.commit, result?.deploy].find(stage => stage?.status === 'failed' || stage?.status === 'interrupted')?.detail ?? '';
    } catch (error) { return error instanceof Error ? error.message : String(error); }
  };
  try {
    git('init', '-q'); git('config', 'user.email', 'delivery@wanigan.test'); git('config', 'user.name', 'Delivery smoke');
    fs.writeFileSync(path.join(root, 'README.md'), '# Delivery\n');
    git('add', '.'); git('commit', '-qm', 'Base');
    const project = await addProject(root);
    review.saveRecipe(project.id, ['git diff --check']);
    const create = (intent: string, enabled = true) => relay.createRelay({ projectId: project.id, intent, providerId: 'claude', delivery: enabled });
    const settled = async (id: string) => {
      const deadline = Date.now() + 10_000;
      while (relay.readRelay(id).delivery!.deploy.status === 'running' && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      return relay.readRelay(id).delivery!;
    };
    const node = (read: RelayRead, kind: string) => read.docket.nodes.find(value => value.kind === kind)!;
    const finishWork = (read: RelayRead) => {
      db().prepare("UPDATE work_nodes SET status='completed',ended_at=?,session_id=NULL WHERE docket_id=? AND kind IN ('plan','estimate','implement')").run(Date.now(), read.docket.id);
    };
    const approve = async (read: RelayRead) => {
      // No agent is simulated: seed finished work, then use the actual verification and approval boundary.
      finishWork(read);
      if (node(relay.readRelay(read.docket.id), 'review').status === 'completed') {
        const before = relay.readRelay(read.docket.id);
        await delivery.reopenDeliveryReview(read.docket.id);
        const reopened = relay.readRelay(read.docket.id);
        check(node(reopened, 'verify').status === 'ready' && node(reopened, 'review').status !== 'completed'
          && !reopened.docket.autopilot.enabled && !reopened.docket.nodes.some(value => value.sessionId)
          && before.docket.proofs.every(proof => reopened.docket.proofs.some(value => value.id === proof.id)),
        'delivery recovery preserves evidence and reopens verification/review without launching work');
      }
      await control.runProof(node(read, 'verify').id);
      await control.completeNode(node(read, 'verify').id, {});
      await control.completeNode(node(read, 'review').id, { decision: 'approve' });
    };

    const legacy = await create('An older review-only relay', false);
    check(legacy.delivery === null, 'review-only relays retain their historical endpoint until delivery is explicitly added');
    const opted = delivery.enableDelivery(legacy.docket.id);
    check(opted.commit.status === 'pending' && opted.deploy.status === 'pending', 'adding delivery records two pending stages without executing anything');
    const plain = control.createDocket({ projectId: project.id, title: 'Ordinary goal', objective: 'Keep ordinary goals independent.', acceptance: ['No Relay delivery stages are added.'] });
    check(!!await refused(() => delivery.enableDelivery(plain.id)), 'ordinary Goals cannot acquire Relay delivery through its IPC-facing service');

    const read = await create('Deliver a reviewed new file');
    check(read.delivery?.commit.status === 'pending' && read.delivery.deploy.status === 'pending', 'new relays include commit and deploy records without widening the Control task graph');
    check(read.docket.nodes.length === 5, 'delivery does not change the five Control node kinds or review dependency contract');
    check(!!await refused(() => delivery.previewDelivery(read.docket.id, 'commit')), 'commit preview refuses a relay without human approval');
    check(!!await refused(() => delivery.previewDelivery(read.docket.id, 'deploy')), 'deployment refuses to run before a recorded commit');
    fs.writeFileSync(path.join(root, 'feature.txt'), 'approved feature\n');
    await approve(read);
    const preview = await delivery.previewDelivery(read.docket.id, 'commit');
    check(preview.files.includes('feature.txt') && !preview.existingCommit && !!preview.token, 'commit preview names the reviewed new file and requires its main-issued token');
    check(git('status', '--porcelain').startsWith('??'), 'a preview neither stages files nor commits');
    check(!!await refused(() => delivery.commitDelivery(read.docket.id, { token: 'forged-token', message: 'No' })), 'a forged preview token cannot start a commit');
    fs.writeFileSync(path.join(root, 'feature.txt'), 'changed after preview\n');
    check(!!await refused(() => delivery.commitDelivery(read.docket.id, { token: preview.token, message: 'Feature' })), 'a changed checkout invalidates the commit preview');
    await control.runProof(node(read, 'verify').id);
    check(!!await refused(() => delivery.previewDelivery(read.docket.id, 'commit')), 'new passing checks do not replace human approval of changed content');
    await approve(read);
    const current = await delivery.previewDelivery(read.docket.id, 'commit');
    const committed = await delivery.commitDelivery(read.docket.id, { token: current.token, message: 'Deliver the reviewed feature' });
    const sha = git('rev-parse', 'HEAD');
    check(committed.commit.status === 'completed' && committed.commit.receipt?.commitHash === sha, 'commit completion records the actual Git revision');
    check(git('status', '--porcelain') === '' && git('show', 'HEAD:feature.txt') === 'changed after preview', 'the reviewed new file is committed and the checkout is clean');
    check(!!await refused(() => delivery.commitDelivery(read.docket.id, { token: current.token, message: 'Duplicate' })), 'a consumed token cannot create another commit');
    check(!!await refused(() => delivery.previewDelivery(read.docket.id, 'deploy')), 'an absent deployment command is an explicit blocker');

    const config = { command: 'printf "delivery smoke command\\n"', timeoutMs: 30_000 };
    delivery.saveDeployConfig(read.docket.id, config);
    check(relay.readRelay(legacy.docket.id).delivery?.config.command === config.command, 'the deployment command is saved per project and shared by its relays');
    const deployPreview = await delivery.previewDelivery(read.docket.id, 'deploy');
    check(deployPreview.head === sha && deployPreview.command === config.command, 'deployment preview names the exact recorded commit and configured command');
    delivery.saveDeployConfig(read.docket.id, { ...config, command: 'printf "changed command\\n"' });
    check(!!await refused(() => delivery.deployDelivery(read.docket.id, { token: deployPreview.token })), 'changing the project command invalidates an already displayed deployment preview');
    delivery.saveDeployConfig(read.docket.id, { ...config, command: 'printf "intentional failure\\n"; exit 7' });
    const failurePreview = await delivery.previewDelivery(read.docket.id, 'deploy');
    await refused(() => delivery.deployDelivery(read.docket.id, { token: failurePreview.token }));
    await settled(read.docket.id);
    const failed = relay.readRelay(read.docket.id).delivery!.deploy;
    check(failed.status === 'failed' && failed.attempts.some(attempt => attempt.exitCode === 7 && attempt.output.includes('intentional failure')), 'a failing local command preserves its real exit code and output');
    delivery.saveDeployConfig(read.docket.id, config);
    const retryPreview = await delivery.previewDelivery(read.docket.id, 'deploy');
    await delivery.deployDelivery(read.docket.id, { token: retryPreview.token });
    const deployed = await settled(read.docket.id);
    check(deployed.deploy.status === 'completed' && deployed.deploy.receipt?.exitCode === 0
      && deployed.deploy.receipt.output.includes('delivery smoke command'), 'a deliberate retry records successful command execution');
    check(deployed.deploy.attempts.some(attempt => attempt.exitCode === 7), 'successful retries retain prior failure evidence');
    check(!!await refused(() => delivery.deployDelivery(read.docket.id, { token: retryPreview.token })), 'a completed deployment cannot repeat from the same request');

    const clean = await create('Record the already committed reviewed checkout');
    await approve(clean);
    const cleanPreview = await delivery.previewDelivery(clean.docket.id, 'commit');
    check(cleanPreview.existingCommit && cleanPreview.files.length === 0, 'a clean approved checkout offers an explicit existing-commit receipt');
    const cleanCommit = await delivery.commitDelivery(clean.docket.id, { token: cleanPreview.token, message: '' });
    check(cleanCommit.commit.receipt?.commitHash === sha && git('rev-parse', 'HEAD') === sha, 'recording an existing commit creates no empty or duplicate Git commit');
    const pinned = await delivery.previewDelivery(clean.docket.id, 'deploy');
    fs.appendFileSync(path.join(root, 'README.md'), 'after approval\n');
    check(!!await refused(() => delivery.deployDelivery(clean.docket.id, { token: pinned.token })), 'deployment refuses checkout edits after its commit receipt');
    fs.writeFileSync(path.join(root, 'README.md'), '# Delivery\n');

    const sibling = await create('Another relay sharing the checkout');
    await approve(sibling);
    const siblingCommit = await delivery.previewDelivery(sibling.docket.id, 'commit');
    await delivery.commitDelivery(sibling.docket.id, { token: siblingCommit.token, message: '' });
    delivery.saveDeployConfig(clean.docket.id, { command: 'sleep 20', timeoutMs: 30_000 });
    const cancelPreview = await delivery.previewDelivery(clean.docket.id, 'deploy');
    const concurrentPreview = await delivery.previewDelivery(sibling.docket.id, 'deploy');
    const running = delivery.deployDelivery(clean.docket.id, { token: cancelPreview.token });
    const result = running.catch(() => null);
    const deadline = Date.now() + 5_000;
    while (relay.readRelay(clean.docket.id).delivery?.deploy.status !== 'running' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    check(relay.readRelay(clean.docket.id).delivery?.deploy.status === 'running', 'a command attempt is persisted while the real process runs');
    check(!!await refused(() => delivery.deployDelivery(sibling.docket.id, { token: concurrentPreview.token })), 'different relays cannot run delivery concurrently in the same checkout');
    delivery.cancelDeploy(clean.docket.id);
    await result;
    await settled(clean.docket.id);
    const canceled = relay.readRelay(clean.docket.id).delivery!.deploy;
    check(canceled.status !== 'completed' && canceled.status !== 'running', 'canceling the deployment stops its process and records an unsuccessful outcome');

    delivery.saveDeployConfig(clean.docket.id, { command: 'sleep 20 & exit 0', timeoutMs: 1_000 });
    const timeoutPreview = await delivery.previewDelivery(clean.docket.id, 'deploy');
    await delivery.deployDelivery(clean.docket.id, { token: timeoutPreview.token });
    const timedOut = (await settled(clean.docket.id)).deploy;
    check(timedOut.status === 'interrupted' && timedOut.attempts.some(attempt => /timeout|exceeded/i.test(attempt.error ?? '')),
      'timeout terminates descendants even after the deployment shell has exited');

    const previous = db().prepare('SELECT * FROM relay_delivery_attempts WHERE docket_id=? ORDER BY rowid DESC LIMIT 1').get(clean.docket.id) as {
      attempt_json: string; binding_json: string; checkout: string;
    };
    const interrupted = { ...JSON.parse(previous.attempt_json), id: 'delivery-crash-fixture', status: 'running', endedAt: null, error: null };
    db().prepare('INSERT INTO relay_delivery_attempts (id,docket_id,kind,status,checkout,owner_pid,attempt_json,binding_json) VALUES (?,?,?,?,?,?,?,?)')
      .run(interrupted.id, clean.docket.id, 'deploy', 'running', previous.checkout, 2147483647, JSON.stringify(interrupted), previous.binding_json);
    check(delivery.recoverDelivery() === 1 && relay.readRelay(clean.docket.id).delivery?.deploy.status === 'interrupted',
      'a crashed owner becomes interrupted evidence without rerunning its command');

    const hooked = await create('Reject a hook that changes the reviewed tree');
    fs.appendFileSync(path.join(root, 'README.md'), 'approved hook test\n');
    await approve(hooked);
    const hookPreview = await delivery.previewDelivery(hooked.docket.id, 'commit');
    const hook = path.join(root, '.git', 'hooks', 'pre-commit');
    fs.writeFileSync(hook, '#!/bin/sh\nprintf "unreviewed hook edit\\n" >> README.md\ngit add README.md\n', { mode: 0o755 });
    const hookResult = await delivery.commitDelivery(hooked.docket.id, { token: hookPreview.token, message: 'Hook-mutated commit' });
    check(hookResult.commit.status === 'failed' && !hookResult.commit.receipt && git('status', '--porcelain') === '',
      'a hook-created clean commit with different content is not accepted as the reviewed delivery commit');
    check(!!await refused(() => delivery.previewDelivery(hooked.docket.id, 'deploy')), 'a hook-mutated commit cannot authorize deployment');
    fs.rmSync(hook);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
