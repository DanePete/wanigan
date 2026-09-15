import * as gitOps from './git';
import { trailersForCommit } from './assisted-by';
import { requireAcknowledged } from './secret-scan';

/**
 * The commit and the push the Git view asks for, with the checks main makes
 * before either runs. The IPC handlers are one line each and call these, so the
 * smoke suite exercises exactly the path a renderer reaches.
 *
 * The renderer shows findings and trailers before anything happens, but it is
 * not the enforcement: it is one caller, and anything that can send this IPC
 * can send it without the panel. So the scan runs again here, and a finding is
 * gone past only when the request carries back the digest of the findings as
 * they are now; and the trailers are derived again here, and must equal the
 * list the commit box displayed.
 *
 * What is left between the check and the act is the time git takes to start. An
 * agent that stages a secret in that gap is not caught by this; one that staged
 * it any earlier is.
 */

/** Digests are 64 hex digits. The bound only keeps a renderer from handing main a megabyte to compare. */
const MAX_ACKNOWLEDGEMENT = 128;
/** One line per agent and model that worked here since the last commit; past this nobody reviewed the list. */
const MAX_TRAILERS = 32;

type CommitOptions = { amend: boolean; all: boolean; acknowledge: string | null; trailers: string[] | null };
type PushOptions = { setUpstream: boolean; branch: string | null; acknowledge: string | null };

function record(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
}

function acknowledgement(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > MAX_ACKNOWLEDGEMENT) {
    throw new Error('An acknowledgement is the digest of the findings that were shown, and this was not one.');
  }
  return value;
}

function commitOptions(input: unknown): CommitOptions {
  const body = record(input);
  let trailers: string[] | null = null;
  if (body.trailers !== undefined && body.trailers !== null) {
    if (!Array.isArray(body.trailers) || body.trailers.length > MAX_TRAILERS
      || !body.trailers.every((line) => typeof line === 'string' && line.length <= 400)) {
      throw new Error('Assisted-by trailers arrive as a short list of lines.');
    }
    trailers = body.trailers as string[];
  }
  return { amend: body.amend === true, all: body.all === true, acknowledge: acknowledgement(body.acknowledge), trailers };
}

function pushOptions(input: unknown): PushOptions {
  const body = record(input);
  const branch = typeof body.branch === 'string' && body.branch ? body.branch : null;
  return { setUpstream: body.setUpstream === true, branch, acknowledge: acknowledgement(body.acknowledge) };
}

/** Commit what the Git view showed, or refuse and say why. */
export async function commitChecked(dir: string, message: unknown, input: unknown): Promise<string> {
  if (typeof message !== 'string') throw new Error('A commit message arrives as text.');
  const opts = commitOptions(input);
  if (!message.trim() && !opts.amend) throw new Error('A commit needs a message.');
  // A subdirectory project or a folder that is not a repository is refused by
  // the commit itself; asking first keeps that refusal from arriving dressed as
  // a secret scan that could not run.
  await gitOps.acting(dir, 'commit');
  await requireAcknowledged(dir, { action: 'commit', all: opts.all, amend: opts.amend }, opts.acknowledge);
  const trailers = await trailersForCommit(dir, { amend: opts.amend }, opts.trailers);
  return gitOps.commit(dir, message, { amend: opts.amend, all: opts.all, trailers });
}

/** Push what the scan read, or refuse and say why. */
export async function pushChecked(dir: string, input: unknown): Promise<string> {
  const opts = pushOptions(input);
  await gitOps.acting(dir, 'push');
  await requireAcknowledged(dir, { action: 'push', setUpstream: opts.setUpstream, branch: opts.branch }, opts.acknowledge);
  return gitOps.push(dir, { setUpstream: opts.setUpstream, branch: opts.branch ?? undefined });
}
