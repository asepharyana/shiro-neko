export type Rate = { inputPerMTok: number; outputPerMTok: number };

/**
 * USD per million tokens. Prefix match on the model id, longest first, so
 * `claude-sonnet-4-5-20250929` resolves via `claude-sonnet-4-5`. Published rates
 * drift, so this is a best-effort estimate rather than a billing source.
 */
const RATES: Record<string, Rate> = {
  'claude-opus-4': { inputPerMTok: 15, outputPerMTok: 75 },
  'claude-sonnet-4': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-haiku-4': { inputPerMTok: 1, outputPerMTok: 5 },
  'claude-3-5-haiku': { inputPerMTok: 0.8, outputPerMTok: 4 },
  'gpt-5-mini': { inputPerMTok: 0.25, outputPerMTok: 2 },
  'gpt-5-nano': { inputPerMTok: 0.05, outputPerMTok: 0.4 },
  'gpt-5': { inputPerMTok: 1.25, outputPerMTok: 10 },
  'gpt-4o-mini': { inputPerMTok: 0.15, outputPerMTok: 0.6 },
  'gpt-4o': { inputPerMTok: 2.5, outputPerMTok: 10 },
  'o4-mini': { inputPerMTok: 1.1, outputPerMTok: 4.4 },
  'deepseek-chat': { inputPerMTok: 0.27, outputPerMTok: 1.1 },
  'deepseek-reasoner': { inputPerMTok: 0.55, outputPerMTok: 2.19 },
  'grok-4': { inputPerMTok: 3, outputPerMTok: 15 },
};

/** Strips a provider prefix such as `anthropic/` that OpenRouter-style ids carry. */
const bare = (modelId: string) => modelId.toLowerCase().split('/').at(-1) ?? modelId.toLowerCase();

export function rateFor(modelId: string): Rate | undefined {
  const id = bare(modelId);
  const key = Object.keys(RATES)
    .filter((k) => id.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  return key ? RATES[key] : undefined;
}

export function costOf(modelId: string, inputTokens: number, outputTokens: number): number | undefined {
  const rate = rateFor(modelId);
  if (!rate) return undefined;
  return (inputTokens / 1_000_000) * rate.inputPerMTok + (outputTokens / 1_000_000) * rate.outputPerMTok;
}

export function formatUsd(amount: number): string {
  if (amount === 0) return '$0.00';
  if (amount < 0.01) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}

/** One-line token and cost summary, omitting the cost when the model is unpriced. */
export function usageLine(modelId: string, inputTokens: number, outputTokens: number): string {
  const tokens = `${inputTokens} in / ${outputTokens} out tokens`;
  const cost = costOf(modelId, inputTokens, outputTokens);
  return cost === undefined ? `${tokens} (${modelId} is unpriced)` : `${tokens} - ${formatUsd(cost)}`;
}
