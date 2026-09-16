/** Bounds upstream response bytes before JSON parsing. No upstream error body escapes. */
export async function readProviderJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error('Provider unavailable');
  }
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 131072) throw new Error('Provider response too large');
      chunks.push(next.value);
    }
    signal.throwIfAborted();
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
