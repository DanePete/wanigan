/**
 * Asking a live session a side question, the pure half: which harness has a
 * verified command for it, what exactly gets typed, and when.
 *
 * Both commands were read out of the installed binaries on 2026-09-14, not the
 * docs:
 *
 *  - Claude Code 2.1.271 registers `name:"btw"` with the description "Ask a
 *    quick side question without interrupting the main conversation" and
 *    `argumentHint:"[question]"`, and its side-question system prompt tells the
 *    answering agent it "share[s] the conversation context" and cannot run
 *    tools. So `/btw <question>` on one line is the verified shape.
 *  - Codex 0.154.0 lists `side` (and `btw`) among its slash-command names, with
 *    the description "start a side conversation in an ephemeral fork", and
 *    prints "'/side' is unavailable until the current conversation has
 *    started". Whether it takes the question on the same line was NOT found in
 *    the binary. If it does not, text after `/side` could go to the main thread
 *    as a prompt — the very pollution a side question exists to avoid — so for
 *    Codex Wanigan types `/side` alone and the operator asks in the fork.
 *
 * The version gate is the probed version. A command typed into an older CLI
 * that lacks it is not something Wanigan has seen handled, so an older or
 * unreported version is refused with the reason rather than tried.
 */

export type SideQuestionSupport =
  | {
    supported: true;
    command: '/btw' | '/side';
    /** True when the question is typed on the command line itself. */
    inlineQuestion: boolean;
    /** The sentence the control carries, said the same way wherever it appears. */
    label: string;
    probed: string;
  }
  | { supported: false; reason: string };

export const CLAUDE_BTW_PROBED = '2.1.271';
export const CODEX_SIDE_PROBED = '0.154.0';

/** Longest side question typed into a PTY. */
export const SIDE_QUESTION_MAX_CHARS = 2_000;

function parseVersion(line: string | null | undefined): [number, number, number] | null {
  const m = typeof line === 'string' ? /(\d+)\.(\d+)\.(\d+)/.exec(line) : null;
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function versionAtLeast(have: string | null | undefined, want: string): boolean {
  const a = parseVersion(have);
  const b = parseVersion(want);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

export function sideQuestionSupport(harness: string | null | undefined, cliVersion: string | null | undefined): SideQuestionSupport {
  if (harness === 'claude-code') {
    if (!versionAtLeast(cliVersion, CLAUDE_BTW_PROBED)) {
      return {
        supported: false,
        reason: cliVersion
          ? `Side questions were verified on Claude Code ${CLAUDE_BTW_PROBED}; this CLI reports ${cliVersion.trim().slice(0, 40)}. Update Claude Code to use them here.`
          : `Side questions were verified on Claude Code ${CLAUDE_BTW_PROBED}, and this CLI did not report a version.`,
      };
    }
    return {
      supported: true, command: '/btw', inlineQuestion: true, probed: CLAUDE_BTW_PROBED,
      label: "Claude answers from the session's context without adding it to the conversation (Claude Code /btw).",
    };
  }
  if (harness === 'codex') {
    if (!versionAtLeast(cliVersion, CODEX_SIDE_PROBED)) {
      return {
        supported: false,
        reason: cliVersion
          ? `Side conversations were verified on Codex ${CODEX_SIDE_PROBED}; this CLI reports ${cliVersion.trim().slice(0, 40)}.`
          : `Side conversations were verified on Codex ${CODEX_SIDE_PROBED}, and this CLI did not report a version.`,
      };
    }
    return {
      supported: true, command: '/side', inlineQuestion: false, probed: CODEX_SIDE_PROBED,
      label: 'Codex opens a side conversation in a temporary fork of this one (Codex /side). Type your question there; Ctrl+C returns to the main thread.',
    };
  }
  return { supported: false, reason: 'Side questions are not available for this harness: Wanigan has verified one only for Claude Code (/btw) and Codex (/side).' };
}

/**
 * The line typed into the PTY, or null when there is nothing safe to type. The
 * question is flattened to one line: a newline inside it would submit the
 * command early and send the rest as an ordinary prompt.
 */
export function sideQuestionLine(support: SideQuestionSupport, question: string): string | null {
  if (!support.supported) return null;
  if (!support.inlineQuestion) return support.command;
  const flat = question.replace(/\s+/g, ' ').trim();
  if (!flat || flat.length > SIDE_QUESTION_MAX_CHARS) return null;
  return `${support.command} ${flat}`;
}
