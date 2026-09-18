export type ProviderFailureCode =
  | 'authentication'
  | 'billing'
  | 'permission'
  | 'workspace'
  | 'model_access'
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

function upstreamErrorMessage(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const error = (value as Record<string, unknown>).error;
  if (!error || typeof error !== 'object' || Array.isArray(error)) return undefined;
  const message = (error as Record<string, unknown>).message;
  return typeof message === 'string' ? message.slice(0, 2000).toLowerCase() : undefined;
}

function failureCode(status: number, body?: unknown): ProviderFailureCode {
  if (status === 401) return 'authentication';
  if (status === 402) return 'billing';
  const message = upstreamErrorMessage(body);
  if ((status === 400 || status === 404) && message?.includes('workspace')) return 'workspace';
  if (status === 404 && message?.includes('model')) return 'model_access';
  if (status === 403 || status === 404) return 'permission';
  if (status === 429) return 'rate_limit';
  if (status === 400) return 'invalid_request';
  return 'upstream';
}

/** Bounds upstream response bytes before JSON parsing. No upstream error body escapes. */
export async function readProviderJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new ProviderHttpError(response.status, failureCode(response.status));
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
    const text = Buffer.concat(chunks).toString('utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      if (!response.ok) throw new ProviderHttpError(response.status, failureCode(response.status));
      throw error;
    }
    if (!response.ok)
      throw new ProviderHttpError(response.status, failureCode(response.status, parsed));
    return parsed;
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
