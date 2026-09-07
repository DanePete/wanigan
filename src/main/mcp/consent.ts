import type { McpServerReview } from '../../shared/types';

/**
 * The text of the MCP stdio trust question, built in the main process.
 *
 * An enabled stdio MCP server is a standing grant to execute a local command:
 * the CLI spawns it from the generated config at every launch in scope, for as
 * long as the row exists. That is the same class of grant as a provider pack's
 * manifest, so it is asked the same way and for the same reason — the Settings
 * page that shows the command is drawn by the renderer, and a renderer that has
 * been compromised can simply decline to draw it. pack-consent.ts states the
 * rule for the pack half; this is the MCP half.
 *
 * A server row is renderer-supplied data, so everything here is flattened,
 * clipped and counted the way pack-consent.ts clips a manifest: an argument
 * list carries no length limit of its own, and a dialog can be padded until its
 * buttons are the only thing left on screen.
 *
 * This module imports nothing from Electron, so the smoke suite can read the
 * exact question an operator would be shown without opening a dialog.
 */
export type McpTrustPrompt = { title: string; message: string; detail: string };

const MAX_FIELD_CHARS = 96;
const MAX_ARGS_SHOWN = 12;
const MAX_DETAIL_CHARS = 2_000;

const CLOSING =
  'Wanigan hands this command to the agent’s CLI, which runs it. Approve only a command you would run by hand.';

/**
 * One field, flattened to a single bounded line. Control characters fold to
 * spaces before the length cut: this text goes into a dialog, not a terminal,
 * and a newline inside an argument is a way to push the rest of the question
 * out of view.
 */
function clip(value: string | null | undefined, max = MAX_FIELD_CHARS): string {
  const flat = (typeof value === 'string' ? value : '')
    .replace(/[\u0000-\u001F\u007F-\u009F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (flat === '') return '(empty)';
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * One line per argument, numbered and never joined. Joining them would let a
 * single argument containing a space read as two, which is the one distinction
 * a reviewer of a command line has to be able to make.
 */
function argvLines(args: string[]): string[] {
  const shown = args.slice(0, MAX_ARGS_SHOWN).map((a, i) => `  argv[${i + 1}] ${clip(a)}`);
  if (args.length > MAX_ARGS_SHOWN) {
    shown.push(`  +${args.length - MAX_ARGS_SHOWN} argument(s) not listed here; the digest above covers all of them.`);
  }
  return shown;
}

/**
 * Assembles the detail inside MAX_DETAIL_CHARS and elides only the argv list.
 * `head` and `foot` are sentences Wanigan wrote — the digest, the scope, the
 * classification warning, the note that trusting does not enable. Cutting one
 * long string from the end would drop exactly those, so the server with enough
 * arguments to overflow the dialog would be the one whose warnings went missing.
 */
function assemble(head: string[], body: string[], foot: string[]): string {
  const whole = [...head, ...body, ...foot].join('\n');
  if (whole.length <= MAX_DETAIL_CHARS) return whole;
  const tail = '  … argument list truncated. The digest above covers every argument, listed or not.';
  const fixed = [...head, tail, ...foot].join('\n');
  const room = MAX_DETAIL_CHARS - fixed.length - 1;
  const kept: string[] = [];
  let used = 0;
  for (const line of body) {
    if (used + line.length + 1 > room) break;
    kept.push(line);
    used += line.length + 1;
  }
  return [...head, ...kept, tail, ...foot].join('\n').slice(0, MAX_DETAIL_CHARS);
}

/**
 * The question asked before trustServer records a digest. An HTTP server gets
 * the negative branch rather than an empty command list, because an empty argv
 * reads as a server that runs nothing.
 */
export function mcpTrustPrompt(review: McpServerReview): McpTrustPrompt {
  const title = 'Trust this MCP server command?';
  const message = `${clip(review.name, 48)} — ${review.scope === 'project' ? 'one project' : 'every project'}`;

  if (review.transport !== 'stdio') {
    return {
      title,
      message,
      detail: [
        'This is an HTTP MCP server. It runs no local command, so there is nothing here to trust.',
        `Endpoint ${clip(review.url, 160)}`,
        'Nothing was trusted.',
      ].join('\n'),
    };
  }

  const head = [
    `SHA-256 ${clip(review.sha256, 80)}`,
    `argv[0] ${clip(review.command, 160)}`,
    `${review.args.length} argument(s):`,
  ];
  const body = argvLines(review.args);
  const foot: string[] = [];

  if (review.resolvesPerProject) {
    foot.push(review.resolvedFor
      ? `{{PROJECT_PATH}} becomes ${clip(review.resolvedFor.projectPath, 120)} at launch.`
      : 'This command contains {{PROJECT_PATH}} and the server is global, so the arguments differ in every repository Wanigan launches a session in.');
  }
  foot.push(review.scope === 'project'
    ? 'Scope: every session Wanigan launches for this one project, until you switch it off.'
    : 'Scope: every session Wanigan launches, in every repository, until you switch it off.');
  foot.push(review.approved && review.trustedSha256 && review.trustedSha256 !== review.sha256
    ? `This replaces an earlier approval of: ${clip(`${review.approved.command} ${review.approved.args}`, 120)}`
    : 'Nothing is approved for this server yet.');
  foot.push('Read and write are decided by each tool’s name, never by what the call did, so a server may name a mutating tool "get_everything" and have it allowed without asking at read-only trust.');
  foot.push('Trusting does not enable. The server stays switched off until you switch it on.');
  foot.push(CLOSING);

  return { title, message, detail: assemble(head, body, foot) };
}

export const __test = { clip, argvLines, MAX_ARGS_SHOWN, MAX_DETAIL_CHARS, MAX_FIELD_CHARS };