import { pruneMessages, type ModelMessage } from 'ai';

type Part = {
  type: string;
  toolCallId?: string;
  providerOptions?: Record<string, Record<string, unknown>>;
};

/** Parts the OpenAI responses API refuses to accept without their reasoning item. */
const DEPENDENT = new Set(['text', 'tool-call']);

function itemId(part: Part): string | undefined {
  for (const options of Object.values(part.providerOptions ?? {})) {
    const id = options['itemId'];
    if (typeof id === 'string') return id;
  }
  return undefined;
}

const partsOf = (message: ModelMessage): Part[] =>
  message.role === 'assistant' && Array.isArray(message.content) ? (message.content as Part[]) : [];

/**
 * Drops assistant parts left orphaned by reasoning removal.
 *
 * The OpenAI responses API treats a `message` item as a dependent of the `reasoning`
 * item from the same response: send the message without its reasoning and the request
 * is rejected with 400 "was provided without its required 'reasoning' item".
 * `pruneMessages({ reasoning: 'all' })` strips the reasoning and keeps the message,
 * producing exactly that request.
 *
 * The two carry different item ids, so they cannot be matched by id. What links them
 * is the assistant message they arrived in: one message is one response, and its
 * reasoning item covers every other item in it.
 *
 * Reasoning only disappears from turns pruning is already discarding, so dropping the
 * orphaned text costs nothing pruning was not already spending.
 */
export function dropOrphanedItems(before: ModelMessage[], after: ModelMessage[]): ModelMessage[] {
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
      if (!DEPENDENT.has(part.type)) continue;
      const id = itemId(part);
      if (id) orphaned.add(id);
    }
  }

  if (orphaned.size === 0) return after;

  const cleaned: ModelMessage[] = [];
  for (const message of after) {
    const parts = partsOf(message);
    if (parts.length === 0) {
      cleaned.push(message);
      continue;
    }

    const kept = parts.filter((part) => {
      const id = itemId(part);
      return id === undefined || !orphaned.has(id);
    });

    if (kept.length > 0) cleaned.push({ ...message, content: kept } as ModelMessage);
  }

  return cleaned;
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
 * call_id ...". Two things strand a result that way, and both happen on a long turn:
 * `pruneMessages({ toolCalls: 'before-last-3-messages' })` counts messages, so the
 * cut can land between an assistant tool-call and the tool message answering it, and
 * `dropOrphanedItems` removes a tool-call whose reasoning item did not survive while
 * the result sits in a separate message it never looks at.
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
  return dropOrphanedResults(dropOrphanedItems(options.messages, pruned));
}
