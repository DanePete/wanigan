/** Invocation-scoped prompt delivery for CLIs that accept a positional prompt. */
export function compileInitialPromptArgv(template: readonly string[], raw: string): string[] {
  if (typeof raw !== 'string' || raw.length > 32_768 || raw.includes('\0')) {
    throw new Error('The initial prompt must be text of at most 32,768 characters without NUL bytes.');
  }
  const prompt = raw.trim();
  if (!prompt) return [];
  return template.map(entry => entry.replaceAll('{prompt}', () => prompt));
}
