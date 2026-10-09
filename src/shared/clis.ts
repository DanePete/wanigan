// The command-line tools Wanigan runs, and how each is installed. Whatever says
// one is missing (an error, Readiness, Accounts, the New session dialog) names
// the official install command from here, so they never disagree.

export type Cli = 'claude' | 'codex' | 'gemini' | 'gh' | 'git';

export const CLI_NAME: Record<Cli, string> = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', gh: 'GitHub’s gh command', git: 'git' };

/** The official install commands, the usual one first. */
export const INSTALL: Record<Cli, readonly string[]> = {
  claude: ['npm install -g @anthropic-ai/claude-code', 'curl -fsSL https://claude.ai/install.sh | bash'],
  codex: ['npm install -g @openai/codex', 'brew install --cask codex'],
  gemini: ['npm install -g @google/gemini-cli', 'brew install gemini-cli'],
  gh: ['brew install gh'],
  // On a Mac, git comes with Apple's command line tools.
  git: ['xcode-select --install'],
};

/** "Install it with `…`, or `…`." */
export function installHint(cli: Cli): string {
  const [first, ...rest] = INSTALL[cli].map((c) => `\`${c}\``);
  return `Install it with ${first}${rest.length ? `, or ${rest.join(', or ')}` : ''}.`;
}

export function notInstalledMessage(cli: Cli): string {
  return `${CLI_NAME[cli]} is not installed, or not on your login shell’s PATH. ${installHint(cli)}`;
}
