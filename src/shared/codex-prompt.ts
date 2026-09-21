/**
 * Fallback for a Codex picker that cannot receive a positional initial prompt.
 * Only the latest readable output can authorize typing. This is deliberately
 * conservative, not a terminal emulator: an unfamiliar redraw asks the person
 * to submit the task instead of treating old scrollback as a current composer.
 */
const READY = 'Ask Codex to do anything';
export type CodexPromptState = { ready: boolean; partial: string };

export function codexPromptOutput(previous: CodexPromptState, data: string): CodexPromptState {
  const plain = data
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  const erased = /\x1b\[[0-?]*[JK]/.test(data);
  if (!plain.trim()) return { ready: erased ? false : previous.ready, partial: erased ? '' : previous.partial };
  const line = (previous.partial + plain).split(/[\r\n]/).filter(value => value.trim()).at(-1) ?? '';
  // A quoted welcome message or a marker followed by a menu is not a prompt.
  const ready = /^(?:[›❯>]\s*)?Ask Codex to do anything$/.test(line.trim());
  let partial = '';
  for (let length = Math.min(READY.length - 1, line.length); length > 0; length--) {
    if (line.endsWith(READY.slice(0, length))) { partial = READY.slice(0, length); break; }
  }
  return { ready, partial };
}
