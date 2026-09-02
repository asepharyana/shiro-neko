import { pruneMessages, type ModelMessage } from 'ai';

type Part = {
  type: string;
  toolCallId?: string;
  providerOptions?: Record<string, Record<string, unknown>>;
};

function itemId(part: Part): string | undefined {
  for (const options of Object.values(part.providerOptions ?? {})) {
    const id = options['itemId'];
    if (typeof id === 'string') return id;
  }
  return undefined;
}

const partsOf = (message: ModelMessage): Part[] =>
  message.role === 'assistant' && Array.isArray(message.content) ? (message.content as Part[]) : [];

/** The part again, with every provider `itemId` removed. */
function withoutItemId(part: Part): Part {
  const providerOptions: Record<string, Record<string, unknown>> = {};
  for (const [provider, options] of Object.entries(part.providerOptions ?? {})) {
    const { itemId: _dropped, ...rest } = options;
    if (Object.keys(rest).length > 0) providerOptions[provider] = rest;
  }
  const next: Part = { ...part };
  if (Object.keys(providerOptions).length > 0) next.providerOptions = providerOptions;
  else delete next.providerOptions;
  return next;
}

/**
 * Detaches assistant parts from reasoning items that pruning removed.
 *
 * A part carrying a provider `itemId` is not sent inline. The OpenAI responses
 * provider serialises it as `{ type: 'item_reference', id }`, pointing at an item
 * stored on their side, and that stored item depends on the `reasoning` item from
 * the same response. Send the reference without the reasoning and the request is
 * rejected with 400 "was provided without its required 'reasoning' item".
 *
 * The repair is to drop the `itemId`, not the part. Without it the same content is
 * serialised inline — a plain assistant message, a plain `function_call` — which
 * carries no dependency on anything stored. Verified against the provider's own
 * serialiser: `text` with an itemId goes out as `item_reference`, and the identical
 * part without one goes out as `output_text`.
 *
 * Dropping the part instead, which is what this used to do, cost the model its
 * memory of the turn: after compaction it could no longer see the tool results it
 * had just collected, so it called the same tools again until it hit the step limit.
 */
export function detachOrphanedItems(before: ModelMessage[], after: ModelMessage[]): ModelMessage[] {
  const survivingReasoning = new Set<string>();
  for (const message of after) {
    for (const part of partsOf(message)) {
      if (part.type !== 'reasoning') continue;
      const id = itemId(part);
      if (id) survivingReasoning.add(id);
    }
  }

  const orphaned = new Set<string>();
  for (const message of before) {
    const parts = partsOf(message);
    const reasoning = parts.filter((p) => p.type === 'reasoning').map(itemId);
    if (reasoning.length === 0) continue;
    if (reasoning.some((id) => id !== undefined && survivingReasoning.has(id))) continue;

    for (const part of parts) {
      const id = itemId(part);
      if (id) orphaned.add(id);
    }
  }

  if (orphaned.size === 0) return after;

  return after.map((message) => {
    const parts = partsOf(message);
    if (parts.length === 0) return message;

    let changed = false;
    const next = parts.map((part) => {
      const id = itemId(part);
      if (id === undefined || !orphaned.has(id)) return part;
      changed = true;
      return withoutItemId(part);
    });

    return changed ? ({ ...message, content: next } as ModelMessage) : message;
  });
}

export type PruneOptions = Parameters<typeof pruneMessages>[0];

const ANSWER_PARTS = new Set(['tool-result', 'tool-error']);

const anyParts = (message: ModelMessage): Part[] =>
  Array.isArray(message.content) ? (message.content as Part[]) : [];

/**
 * Drops tool results whose tool call is gone.
 *
 * The OpenAI responses API rejects a `function_call_output` with no `function_call`
 * carrying the same call id: 400 "No tool call found for function call output with
 * call_id ...". `pruneMessages({ toolCalls: 'before-last-3-messages' })` counts
 * messages, so the cut can land between an assistant tool-call and the tool message
 * answering it.
 *
 * The reverse pairing is left alone on purpose: a call still awaiting its result is
 * exactly what a suspended approval looks like, and dropping it would break resume.
 */
export function dropOrphanedResults(messages: ModelMessage[]): ModelMessage[] {
  const calls = new Set<string>();
  for (const message of messages) {
    for (const part of anyParts(message)) {
      if (part.type === 'tool-call' && part.toolCallId) calls.add(part.toolCallId);
    }
  }

  const cleaned: ModelMessage[] = [];
  for (const message of messages) {
    const parts = anyParts(message);
    if (parts.length === 0) {
      cleaned.push(message);
      continue;
    }

    const kept = parts.filter(
      (part) => !ANSWER_PARTS.has(part.type) || part.toolCallId === undefined || calls.has(part.toolCallId),
    );

    if (kept.length === parts.length) cleaned.push(message);
    else if (kept.length > 0) cleaned.push({ ...message, content: kept } as ModelMessage);
  }

  return cleaned;
}

/** pruneMessages, then repair the provider-item dependencies it breaks. */
export function prunePreservingItems(options: PruneOptions): ModelMessage[] {
  const pruned = pruneMessages(options);
  return dropOrphanedResults(detachOrphanedItems(options.messages, pruned));
}
