/**
 * The main process accepts a bounded amount of data per PTY IPC message. A
 * paste can legitimately be larger than that boundary, so split it in the
 * renderer without ever cutting a UTF-16 surrogate pair (and therefore a
 * UTF-8 code point) in half. IPC preserves sends from one renderer in order.
 */
export const MAX_TERMINAL_INPUT_CHUNK_BYTES = 128 * 1024;

function utf8BytesForCodePoint(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

export function splitTerminalInput(data: string, maxBytes = MAX_TERMINAL_INPUT_CHUNK_BYTES): string[] {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 4) {
    throw new Error('Terminal input chunks must allow one complete UTF-8 code point.');
  }
  if (!data) return [];

  const chunks: string[] = [];
  let start = 0;
  let cursor = 0;
  let bytes = 0;

  while (cursor < data.length) {
    const codePoint = data.codePointAt(cursor)!;
    const width = codePoint > 0xffff ? 2 : 1;
    const byteLength = utf8BytesForCodePoint(codePoint);
    if (bytes > 0 && bytes + byteLength > maxBytes) {
      chunks.push(data.slice(start, cursor));
      start = cursor;
      bytes = 0;
    }
    bytes += byteLength;
    cursor += width;
  }

  chunks.push(data.slice(start));
  return chunks;
}
