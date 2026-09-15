/**
 * Each Wanigan trust level, compiled into Claude Code's auto-mode classifier
 * rules for the settings file Wanigan already injects.
 *
 * Claude Code's auto mode sends tool calls to a classifier whose prose rules
 * come from `autoMode` in user settings, managed settings and the `--settings`
 * flag — and deliberately never from a repository's own .claude/settings.json,
 * so a repo cannot inject its own allow rules. Verified on the installed
 * 2.1.271 binary (2026-09-14): the reader walks exactly
 * `["userSettings","flagSettings","policySettings"]`, warns "settings autoMode
 * in projectSettings ignored", and `flagSettings` is the `--settings` source.
 * The same list is read for `classifyAllShell`. And end to end, with no model
 * call: `claude --settings <file> auto-mode config` on 2.1.271 printed 71
 * soft_deny and 22 environment entries against 70 and 21 without the file, the
 * extra entry last in each, so "$defaults" kept every built-in rule in place.
 *
 * Two rules keep this honest:
 *
 *  - `"$defaults"` is always the first entry of every list written. A list
 *    without it replaces the built-in rules — force-push, `curl | bash`,
 *    exfiltration — and a trust level meant to be stricter would silently be
 *    weaker. The binary splices it once, at the position it appears.
 *  - Nothing is written for a CLI older than the release that introduced a key.
 *    `"$defaults"` arrived in 2.1.118 (changelog: "include "$defaults" in
 *    autoMode.allow, autoMode.soft_deny, or autoMode.environment") and
 *    `classifyAllShell` in 2.1.193. An older or unread version gets no block and
 *    an explicit "not verified" note, the same way hook events are gated.
 *
 * These rules shape a classifier Wanigan does not run. They are a second layer
 * under Wanigan's own gate, not a replacement for it and not containment.
 */

import type { TrustLevel } from './types.ts';

export const AUTO_MODE_GATES = {
  /** "$defaults" splicing in allow / soft_deny / environment. */
  autoMode: { since: '2.1.118', probed: '2.1.271' },
  classifyAllShell: { since: '2.1.193', probed: '2.1.271' },
} as const;

export type AutoModeBlock = {
  environment?: string[];
  allow?: string[];
  soft_deny?: string[];
  classifyAllShell?: boolean;
};

export type CompiledAutoMode = {
  trust: TrustLevel;
  cliVersion: string | null;
  /** `injected`: a block is written. `defaults`: Trusted, nothing to add. `not-verified`: no block, and why. */
  status: 'injected' | 'defaults' | 'not-verified';
  block: AutoModeBlock | null;
  note: string;
};

function parse(v: string | null | undefined): [number, number, number] | null {
  const m = typeof v === 'string' ? /(\d+)\.(\d+)\.(\d+)/.exec(v) : null;
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function atLeast(have: [number, number, number], want: string): boolean {
  const w = parse(want)!;
  for (let i = 0; i < 3; i++) if (have[i] !== w[i]) return have[i] > w[i];
  return true;
}

const ENV_READONLY = 'This Claude Code session was launched by Wanigan at Read only trust for this repository: the user expects reading, searching and explaining, and changes only when they ask for a specific one.';
const ENV_PROJECT = 'This Claude Code session was launched by Wanigan at Project trust for this repository: changes inside the working directory are expected; actions that leave it are not.';

const SOFT_READONLY = [
  'Creating, editing, moving or deleting any file, including inside the working directory, unless the user asked for that exact change in this conversation.',
  'Installing, upgrading or removing packages, dependencies or tools.',
];

const SOFT_PROJECT = [
  'Pushing to any git remote, in any form: git push with or without -C, --force, --mirror or a refspec, and gh or glab commands that push.',
  'Deploying, publishing or releasing: npm, pnpm, yarn or cargo publish, docker push, terraform or pulumi apply, kubectl or helm changes, vercel, netlify, fly, firebase or wrangler deploys, and gh release create.',
  'Reading credential files or secret stores: ~/.ssh, ~/.aws, ~/.config/gh, ~/.npmrc, ~/.netrc, ~/.docker/config.json, ~/.kube/config, .env files, and the macOS keychain through security find-generic-password or find-internet-password.',
];

/** The block for one trust level and one CLI version. Pure; see the file comment for the gates. */
export function compileAutoMode(trust: TrustLevel, cliVersion: string | null | undefined): CompiledAutoMode {
  const version = typeof cliVersion === 'string' && cliVersion.trim() ? cliVersion.trim() : null;
  const have = parse(version);
  const shown = have ? have.join('.') : null;
  if (trust === 'trusted') {
    return {
      trust, cliVersion: version, status: 'defaults', block: null,
      note: 'Trusted adds nothing: the classifier runs on its built-in rules alone, and Wanigan writes no autoMode block.',
    };
  }
  if (!have) {
    return {
      trust, cliVersion: version, status: 'not-verified', block: null,
      note: 'Wanigan did not read this CLI’s version, so it cannot tell whether autoMode rules are accepted and writes none.',
    };
  }
  if (!atLeast(have, AUTO_MODE_GATES.autoMode.since)) {
    return {
      trust, cliVersion: version, status: 'not-verified', block: null,
      note: `Not verified on CLI ${shown}: "$defaults" in autoMode arrived in ${AUTO_MODE_GATES.autoMode.since}, so Wanigan writes no autoMode block for this version.`,
    };
  }
  const shellGate = atLeast(have, AUTO_MODE_GATES.classifyAllShell.since);
  const block: AutoModeBlock = trust === 'readonly'
    ? { environment: ['$defaults', ENV_READONLY], soft_deny: ['$defaults', ...SOFT_READONLY], ...(shellGate ? { classifyAllShell: true } : {}) }
    : { environment: ['$defaults', ENV_PROJECT], soft_deny: ['$defaults', ...SOFT_PROJECT] };
  const note = trust === 'readonly' && !shellGate
    ? `classifyAllShell arrived in ${AUTO_MODE_GATES.classifyAllShell.since}, so CLI ${shown} gets the soft-deny rules without it.`
    : `Accepted from --settings by ${AUTO_MODE_GATES.autoMode.since} and later; the reader was confirmed in the ${AUTO_MODE_GATES.autoMode.probed} binary.`;
  return { trust, cliVersion: version, status: 'injected', block, note };
}
