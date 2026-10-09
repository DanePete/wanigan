// A commit message written by Claude Code from the staged diff, on request.
// It runs only when the owner clicks, reads with read-only tools, and uses a
// turn of the account's plan; the window says so before it is clicked. The
// owner edits what comes back; nothing is committed by it.
import type { Account } from '../shared/model.ts';
import { CoreError } from '../shared/protocol.ts';
import { runHeadless } from './headless.ts';
import { recentSubjects, stagedDiff } from './git-client.ts';

const TIMEOUT_MS = 3 * 60_000;
/** The staged diff Claude is shown; past this it is cut and told so. */
const MAX_DIFF = 60_000;

const SCHEMA = {
  type: 'object',
  properties: { subject: { type: 'string' }, body: { type: 'string' } },
  required: ['subject', 'body'],
} as const;

export interface WrittenMessage {
  subject: string;
  body: string;
  costUsd: number | null;
  /** The staged diff was longer than Claude was shown. */
  cut: boolean;
}

export async function writeCommitMessage(options: { cwd: string; account: Account | null; binary: string | null }): Promise<WrittenMessage> {
  const staged = await stagedDiff(options.cwd, MAX_DIFF);
  if (!staged.files) throw new CoreError('refused', 'Nothing is staged, so there is nothing to describe. Stage the changes this commit should hold first.');
  const style = await recentSubjects(options.cwd, 12);
  const prompt = [
    'Write a git commit message for the staged changes below. You can read files in this repository for context; you cannot change anything.',
    '',
    'subject: what the commit does, in the imperative, at most 72 characters (50 or fewer is better), no trailing period.',
    'body: why, and anything a reviewer needs that the diff does not say, wrapped at 72 characters. Empty if the subject says it all.',
    'Describe only what is staged. Do not invent tickets, issue numbers or co-authors.',
    style.length ? `\nRecent subjects in this repository, for its style:\n${style.map((s) => `- ${s}`).join('\n')}` : '',
    '',
    `The staged diff${staged.cut ? ' (cut: it is longer than shown)' : ''}:`,
    '"""',
    staged.diff,
    '"""',
  ].join('\n');
  const run = await runHeadless({ binary: options.binary, prompt, schema: SCHEMA, cwd: options.cwd, account: options.account, timeoutMs: TIMEOUT_MS });
  const result = await run.done;
  if (result.error || !result.answer) throw new CoreError('refused', result.error ?? 'Claude Code wrote no message.');
  const subject = String(result.answer.subject ?? '').replace(/\s+/g, ' ').trim().replace(/\.$/, '').slice(0, 200);
  const body = String(result.answer.body ?? '').replace(/\r\n/g, '\n').trim().slice(0, 8_000);
  if (!subject) throw new CoreError('refused', 'Claude Code wrote no summary line.');
  return { subject, body, costUsd: result.costUsd, cut: staged.cut };
}
