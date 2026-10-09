// Notes the owner leaves on lines of a diff, gathered into one message for the
// agent: each with its file, its line and the code it is about, so the agent
// can find the place without asking. Pure, so the wording is tested.

export interface ReviewNote {
  file: string;
  /** The line number in the new file, or in the old one for a removed line. */
  line: number;
  /** Which side the number counts: the file as changed, or as it was. */
  side: 'new' | 'old';
  /** The line's text, quoted so the agent can find it even if numbers move. */
  quote: string;
  text: string;
}

const MAX_QUOTE = 200;

export function reviewMessage(notes: readonly ReviewNote[], scope: string): string {
  const sorted = [...notes].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  const parts = sorted.map((n) => {
    const where = `${n.file}:${n.line}${n.side === 'old' ? ' (a removed line)' : ''}`;
    const quote = n.quote.trim() ? `> ${n.quote.trim().slice(0, MAX_QUOTE)}\n` : '';
    return `${where}\n${quote}${n.text.trim()}`;
  });
  const count = notes.length === 1 ? 'one note' : `${notes.length} notes`;
  return `Review notes on ${scope}, from the owner (${count}). Please address each, then say what you changed.\n\n${parts.join('\n\n')}`;
}
