// A size check on a pathname is not a limit on the following read: an agent
// or editor can grow or replace it in between. Read one verified descriptor,
// at most its initial size plus one byte, and refuse a file changed meanwhile.
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';

export function readBoundedFile(path: string, limit: number, followLinks = false, admit?: (bytes: number) => void): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (followLinks ? 0 : constants.O_NOFOLLOW));
  let failed = false;
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile()) throw new Error('Not a regular file.');
    if (before.size > BigInt(limit)) throw new Error('The file is too large to read.');
    admit?.(Number(before.size));
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let size = 0;
    while (size < bytes.length) {
      const n = readSync(fd, bytes, size, bytes.length - size, null);
      if (!n) break;
      size += n;
    }
    const after = fstatSync(fd, { bigint: true });
    if (BigInt(size) !== before.size || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
      throw new Error('The file changed while it was being read.');
    }
    return bytes.subarray(0, size);
  } catch (error) { failed = true; throw error; }
  finally {
    try { closeSync(fd); } catch (error) { if (!failed) throw error; }
  }
}
