import type { Pool } from 'pg';
import { adminRuntimeContext } from './admin.context.js';
import type { Logger } from 'pino';
import { composePrompt } from './admin.prompt-config.js';

async function boundedPayload(response: Response, maxBytes: number) {
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) {
        void reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  } finally {
    reader.releaseLock();
  }
}
export function adminAiFetch(
  db: Pool,
  operation: string,
  logger: Logger,
  fetchImpl: typeof fetch = fetch,
): typeof fetch {
  return async (input, init) => {
    const context = adminRuntimeContext.getStore();
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    if (!context || url.origin !== 'https://api.openai.com') return fetchImpl(input, init);
    const prompt = context.prompts[operation];
    let options = init;
    let body: Record<string, unknown> | undefined;
    if (typeof init?.body === 'string') {
      try {
        const parsed = JSON.parse(init.body);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed;
      } catch {
        /* Non-JSON provider bodies pass through unchanged. */
      }
    }
    const requestedModel =
      typeof body?.model === 'string'
        ? body.model
        : body?.session &&
            typeof body.session === 'object' &&
            'model' in body.session &&
            typeof body.session.model === 'string'
          ? body.session.model
          : null;
    // lesson-live is composed before session creation so all response.create
    // directives use the same immutable revision, including opening and closing.
    if (prompt && body && operation !== 'lesson-live') {
      if (typeof body.instructions === 'string') body.instructions = composePrompt(body.instructions, prompt);
      else if (body.session && typeof body.session === 'object' && 'instructions' in body.session && typeof body.session.instructions === 'string')
        body.session.instructions = composePrompt(body.session.instructions, prompt);
      else if (Array.isArray(body.messages)) {
        const systemMessages = body.messages.filter(m => m?.role === 'system' || m?.role === 'developer');
        const base = systemMessages.map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n\n');
        body.messages = [{ role: 'system', content: composePrompt(base, prompt) }, ...body.messages.filter(m => m?.role !== 'system' && m?.role !== 'developer')];
      } else if (typeof body.prompt === 'string') body.prompt = composePrompt(body.prompt, prompt);
      options = { ...init, body: JSON.stringify(body) };
    }
    let response: Response;
    try {
      response = await fetchImpl(input, options);
    } catch (error) {
      await record(undefined, false);
      throw error;
    }
    const payload = await boundedPayload(
      response.clone(),
      operation === 'image-generation' ? 6500000 : 1048576,
    );
    await record(payload, response.ok, response.headers.get('x-request-id') ?? undefined);
    return response;
    async function record(
      payload: Record<string, unknown> | undefined,
      ok: boolean,
      requestId?: string,
    ) {
      const usage = payload?.usage as Record<string, unknown> | undefined;
      const integer = (value: unknown) =>
        typeof value === 'number' &&
        Number.isSafeInteger(value) &&
        value >= 0 &&
        value <= 2147483647
          ? value
          : null;
      const inTokens = integer(usage?.input_tokens ?? usage?.prompt_tokens),
        outTokens = integer(usage?.output_tokens ?? usage?.completion_tokens);
      const cached = integer(
        (usage?.input_tokens_details as Record<string, unknown> | undefined)?.cached_tokens,
      );
      const model =
        typeof payload?.model === 'string'
          ? payload.model.slice(0, 200)
          : (requestedModel?.slice(0, 200) ?? null);
      try {
        await db.query(
          `INSERT INTO product_gotit.ai_usage_events(application_id,application_user_id,operation,operation_id,provider,model,provider_response_id,prompt_revision_id,input_tokens,output_tokens,cached_input_tokens,status) VALUES($1,$2,$3,$4,'openai',$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(application_id,provider,provider_response_id) DO NOTHING`,
          [
            context!.applicationId,
            context!.applicationUserId,
            operation,
            context!.requestId,
            model,
            typeof payload?.id === 'string'
              ? payload.id.slice(0, 200)
              : (requestId?.slice(0, 200) ?? null),
            prompt?.id ?? null,
            inTokens,
            outTokens,
            cached,
            ok ? (inTokens === null ? 'unmeasured' : 'completed') : 'failed',
          ],
        );
      } catch {
        logger.warn({ operation }, 'AI usage measurement could not be persisted');
      }
    }
  };
}
