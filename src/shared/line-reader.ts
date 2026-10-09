// Newline-delimited text, scanned only as each chunk arrives. Joining a growing
// buffer and searching it from the start makes a fragmented large line quadratic.
export class LineReader {
  private parts: string[] = [];
  private length = 0;

  /** False means the current line exceeded the limit. A consumer can stop early. */
  read(chunk: string, limit: () => number, consume: (line: string) => boolean): boolean {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf('\n', start);
      const end = newline < 0 ? chunk.length : newline;
      const part = chunk.slice(start, end);
      this.length += part.length;
      if (this.length > limit()) { this.parts = []; this.length = 0; return false; }
      this.parts.push(part);
      if (newline < 0) return true;
      const line = this.parts.join('');
      this.parts = [];
      this.length = 0;
      if (!consume(line)) return true;
      start = newline + 1;
    }
    return true;
  }
}
