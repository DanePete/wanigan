/**
 * The vectors below are the real ones. `fb80c14b…` is a conversation Wanigan
 * recorded on 2026-09-18 for a session that ran eleven minutes in an isolated
 * worktree and never took a turn: no tool events, no archived transcript, and
 * no `.jsonl` under any account root. Wanigan offered it as resumable anyway,
 * and `claude --resume fb80c14b-3698-4846-807c-4f43ffe7de60` answered
 * "No conversation found with session ID" and exited 1 — three times, each
 * attempt building and discarding a fresh worktree on the way.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conversationProof, mintsIdentityAtLaunch } from './resumable.ts';

const claude = {
  harness: 'claude-code',
  conversationId: 'fb80c14b-3698-4846-807c-4f43ffe7de60',
  transcriptOnDisk: false,
  transcriptArchived: false,
};

test('an id the harness minted at launch is not by itself proof of a conversation', () => {
  const proof = conversationProof(claude);
  assert.equal(proof.resumable, false);
  assert.equal(proof.reason, 'never_turned');
});

test('the transcript on disk is what makes a minted id resumable', () => {
  const proof = conversationProof({ ...claude, transcriptOnDisk: true });
  assert.equal(proof.resumable, true);
  assert.equal(proof.reason, 'transcript_present');
});

test('an archived copy is history, not a resumable conversation', () => {
  // Wanigan's archive is its own copy under its own data directory. The CLI
  // cannot resume from it, so a row whose original file has since been cleaned
  // up is honest about which of the two is missing rather than claiming the
  // session never started.
  const proof = conversationProof({ ...claude, transcriptArchived: true });
  assert.equal(proof.resumable, false);
  assert.equal(proof.reason, 'transcript_gone');
});

test('a harness that reports its identity after the first turn needs no transcript', () => {
  // Codex writes no .jsonl, and Wanigan learns its thread id only once the
  // conversation exists. So the id being present is itself the proof, and
  // absence of a Claude transcript says nothing about it.
  const proof = conversationProof({
    harness: 'codex',
    conversationId: '0199c0de-1111-4222-8333-444444444444',
    transcriptOnDisk: false,
    transcriptArchived: false,
  });
  assert.equal(proof.resumable, true);
  assert.equal(proof.reason, 'identity_reported');
});

test('no id is the case the classifier already handled, and keeps handling', () => {
  const proof = conversationProof({ ...claude, conversationId: null });
  assert.equal(proof.resumable, false);
  assert.equal(proof.reason, 'no_identity');
});

test('every refusal says which of the three it is, in a sentence a person can act on', () => {
  const reasons = new Set<string>();
  for (const evidence of [
    claude,
    { ...claude, transcriptArchived: true },
    { ...claude, conversationId: null },
  ]) {
    const proof = conversationProof(evidence);
    assert.equal(proof.resumable, false);
    assert.ok(proof.detail.length > 20, `bare detail for ${proof.reason}`);
    assert.ok(proof.detail.endsWith('.'), `unfinished detail for ${proof.reason}`);
    // A refusal that hedges is a refusal nobody can act on. Wanigan knows
    // which of the three this is; it does not say "may".
    assert.ok(!/\bmay\b|\bmight\b|\bprobably\b/.test(proof.detail), `hedged detail for ${proof.reason}`);
    reasons.add(proof.reason);
  }
  assert.equal(reasons.size, 3);
});

test('only a harness Wanigan names the conversation for mints its identity at launch', () => {
  // Wanigan passes --session-id to the Claude CLI, so the id exists before the
  // conversation does. Everything else reports an id it already has.
  assert.equal(mintsIdentityAtLaunch('claude-code'), true);
  assert.equal(mintsIdentityAtLaunch('codex'), false);
  assert.equal(mintsIdentityAtLaunch('provider:generic-cli'), false);
});
