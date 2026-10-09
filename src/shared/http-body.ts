/** Read a bounded HTTP body, cancelling oversized declared or chunked replies. */
export async function readHttpBody(
  reply: { headers: { get(name: string): string | null }; body: ReadableStream<Uint8Array> | null },
  limit: number,
  tooLarge: () => Error,
): Promise<Uint8Array> {
  if (Number(reply.headers.get('content-length')) > limit) {
    await reply.body?.cancel();
    throw tooLarge();
  }
  if (!reply.body) return new Uint8Array();
  const reader = reply.body.getReader();
  // One allocation also bounds overhead when a peer sends one byte at a time.
  const bytes = new Uint8Array(limit);
  let size = 0;
  let done = false;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) { done = true; break; }
      if (part.value.byteLength > limit - size) throw tooLarge();
      bytes.set(part.value, size);
      size += part.value.byteLength;
    }
  } finally {
    if (!done) await reader.cancel();
    reader.releaseLock();
  }
  return bytes.subarray(0, size);
}
