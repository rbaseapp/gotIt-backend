export type ProviderFailureCode =
  | 'authentication'
  | 'billing'
  | 'permission'
  | 'rate_limit'
  | 'invalid_request'
  | 'timeout'
  | 'invalid_response'
  | 'upstream';

export class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    readonly failureCode: ProviderFailureCode,
  ) {
    super(`Provider request failed (${failureCode})`);
    this.name = 'ProviderHttpError';
  }
}

export function providerFailureCode(error: unknown): ProviderFailureCode | undefined {
  return error instanceof ProviderHttpError ? error.failureCode : undefined;
}

function failureCode(status: number): ProviderFailureCode {
  if (status === 401) return 'authentication';
  if (status === 402) return 'billing';
  // Anthropic deliberately returns 404 for an inaccessible or incorrect
  // workspace/model, so surface it as an actionable permission problem.
  if (status === 403 || status === 404) return 'permission';
  if (status === 429) return 'rate_limit';
  if (status === 400) return 'invalid_request';
  return 'upstream';
}

/** Bounds upstream response bytes before JSON parsing. No upstream error body escapes. */
export async function readProviderJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new ProviderHttpError(response.status, failureCode(response.status));
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
