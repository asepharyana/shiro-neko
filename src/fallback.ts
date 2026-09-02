import { APICallError } from 'ai';
import type { LanguageModelV4 } from '@ai-sdk/provider';

export type FallbackEvent = {
  from: string;
  to: string;
  reason: string;
};

/** Marks a model built by withFallback, so callers can assert the chain is active. */
export const FALLBACK_CHAIN = Symbol.for('shiro.fallbackChain');

export const fallbackChainOf = (model: unknown): string[] | undefined =>
  (model as Record<symbol, string[] | undefined>)[FALLBACK_CHAIN];

/**
 * Status codes that mean "this endpoint cannot serve this request", as opposed to
 * "try again later". Only these justify switching to a different API shape;
 * 401/403/429/5xx are either permanent or the SDK's own retry territory.
 */
const SHAPE_MISMATCH = new Set([400, 404, 405, 415, 422, 501]);

function shouldFallback(error: unknown): string | undefined {
  if (!APICallError.isInstance(error)) return undefined;
  if (error.isRetryable) return undefined;
  if (error.statusCode === undefined || !SHAPE_MISMATCH.has(error.statusCode)) return undefined;
  return `${error.statusCode}: ${error.message}`;
}

const label = (m: LanguageModelV4) => `${m.provider}/${m.modelId}`;

/**
 * Presents several models as one, walking the list when an endpoint rejects the
 * request shape. Built for OpenAI models that only accept function tools on
 * /v1/responses, not /v1/chat/completions.
 *
 * ponytail: only a rejected doStream/doGenerate triggers the switch, not an error
 * emitted mid-stream, since tokens already delivered to the UI cannot be unsent.
 * Revisit if a provider starts returning 400s inside the stream body.
 */
export function withFallback(models: LanguageModelV4[], onFallback?: (e: FallbackEvent) => void): LanguageModelV4 {
  const [primary] = models;
  if (!primary) throw new Error('withFallback needs at least one model');
  if (models.length === 1) return primary;

  // Sticky: once an endpoint rejects the request shape it will reject every later
  // step too, so start from the one that worked instead of re-probing each time.
  let start = 0;
  const reported = new Set<string>();

  async function attempt<T>(op: (model: LanguageModelV4) => PromiseLike<T>): Promise<T> {
    let lastError: unknown;
    for (let i = start; i < models.length; i++) {
      const model = models[i]!;
      try {
        return await op(model);
      } catch (error) {
        const reason = shouldFallback(error);
        const next = models[i + 1];
        if (!reason || !next) throw error;
        lastError = error;
        start = i + 1;
        const key = `${label(model)}->${label(next)}`;
        if (!reported.has(key)) {
          reported.add(key);
          onFallback?.({ from: label(model), to: label(next), reason });
        }
      }
    }
    throw lastError;
  }

  const wrapped: LanguageModelV4 = {
    specificationVersion: 'v4',
    provider: primary.provider,
    modelId: primary.modelId,
    supportedUrls: primary.supportedUrls,
    doGenerate: (options) => attempt((m) => m.doGenerate(options)),
    doStream: (options) => attempt((m) => m.doStream(options)),
  };
  Object.defineProperty(wrapped, FALLBACK_CHAIN, { value: models.map(label), enumerable: false });
  return wrapped;
}
