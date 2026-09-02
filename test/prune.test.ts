import { expect, test } from 'bun:test';
import type { ModelMessage } from 'ai';
import { dropOrphanedItems, dropOrphanedResults, prunePreservingItems } from '../src/prune';

const kinds = (messages: ModelMessage[]) =>
  messages.map((m) => (Array.isArray(m.content) ? `${m.role}:${m.content.map((p) => p.type).join('+')}` : m.role));

/** An assistant turn as the OpenAI responses API returns it. */
const reasoningTurn = (rs: string, msg: string, text = 'answer'): ModelMessage => ({
  role: 'assistant',
  content: [
    { type: 'reasoning', text: 'thinking', providerOptions: { openai: { itemId: rs } } },
    { type: 'text', text, providerOptions: { openai: { itemId: msg } } },
  ],
});

const toolTurn = (rs: string, call: string): ModelMessage => ({
  role: 'assistant',
  content: [
    { type: 'reasoning', text: 'deciding', providerOptions: { openai: { itemId: rs } } },
    {
      type: 'tool-call',
      toolCallId: 'tc1',
      toolName: 'grep',
      input: { pattern: 'x' },
      providerOptions: { openai: { itemId: call } },
    },
  ],
});

test('a message left without its reasoning item is dropped', () => {
  const before = [{ role: 'user' as const, content: 'q' }, reasoningTurn('rs_1', 'msg_1')];
  const after = [{ role: 'user' as const, content: 'q' }, { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'answer', providerOptions: { openai: { itemId: 'msg_1' } } }] }];

  const cleaned = dropOrphanedItems(before, after);
  expect(JSON.stringify(cleaned)).not.toContain('msg_1');
  expect(kinds(cleaned)).toEqual(['user']);
});

test('a tool call left without its reasoning item is dropped too', () => {
  const before = [{ role: 'user' as const, content: 'q' }, toolTurn('rs_1', 'fc_1')];
  const after = [
    { role: 'user' as const, content: 'q' },
    {
      role: 'assistant' as const,
      content: [
        {
          type: 'tool-call' as const,
          toolCallId: 'tc1',
          toolName: 'grep',
          input: { pattern: 'x' },
          providerOptions: { openai: { itemId: 'fc_1' } },
        },
      ],
    },
  ];

  expect(JSON.stringify(dropOrphanedItems(before, after))).not.toContain('fc_1');
});

test('a turn whose reasoning survived is left alone', () => {
  const messages = [{ role: 'user' as const, content: 'q' }, reasoningTurn('rs_1', 'msg_1')];
  expect(dropOrphanedItems(messages, messages)).toEqual(messages);
});

test('nothing is touched when no reasoning was removed', () => {
  const before: ModelMessage[] = [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: 'plain answer' },
  ];
  expect(dropOrphanedItems(before, before)).toEqual(before);
});

test('parts with no provider itemId are always kept', () => {
  const before = [reasoningTurn('rs_1', 'msg_1')];
  const after: ModelMessage[] = [{ role: 'assistant', content: [{ type: 'text', text: 'no item id here' }] }];
  expect(dropOrphanedItems(before, after)).toEqual(after);
});

test('user and tool messages are never affected', () => {
  const before = [{ role: 'user' as const, content: 'q' }, reasoningTurn('rs_1', 'msg_1')];
  const after: ModelMessage[] = [
    { role: 'user', content: 'q' },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 't1', toolName: 'grep', output: { type: 'text', value: 'hit' } }] },
  ];
  expect(dropOrphanedItems(before, after)).toEqual(after);
});

test('one orphaned turn does not take a healthy one with it', () => {
  const before = [
    { role: 'user' as const, content: 'q1' },
    reasoningTurn('rs_1', 'msg_1', 'old answer'),
    { role: 'user' as const, content: 'q2' },
    reasoningTurn('rs_2', 'msg_2', 'new answer'),
  ];
  const after: ModelMessage[] = [
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: [{ type: 'text', text: 'old answer', providerOptions: { openai: { itemId: 'msg_1' } } }] },
    { role: 'user', content: 'q2' },
    reasoningTurn('rs_2', 'msg_2', 'new answer'),
  ];

  const cleaned = dropOrphanedItems(before, after);
  const json = JSON.stringify(cleaned);
  expect(json).not.toContain('msg_1');
  expect(json).toContain('msg_2');
  expect(json).toContain('rs_2');
});

test('prunePreservingItems leaves no orphan behind on a real prune', () => {
  const messages: ModelMessage[] = [];
  for (let i = 0; i < 6; i++) {
    messages.push({ role: 'user', content: `question ${i} ${'x'.repeat(3000)}` });
    messages.push(reasoningTurn(`rs_${i}`, `msg_${i}`, `answer ${i}`));
  }

  const pruned = prunePreservingItems({
    messages,
    reasoning: 'all',
    toolCalls: 'before-last-3-messages',
    emptyMessages: 'remove',
  });

  // Every surviving text part must either have no item id or belong to a turn
  // whose reasoning also survived. Since reasoning: 'all' removes them all, no
  // itemId-bearing assistant part may remain.
  const survivingIds = JSON.stringify(pruned);
  for (let i = 0; i < 6; i++) expect(survivingIds).not.toContain(`msg_${i}`);
  expect(pruned.filter((m) => m.role === 'user')).toHaveLength(6);
});

test('prunePreservingItems is a no-op when nothing needs pruning', () => {
  const messages: ModelMessage[] = [
    { role: 'user', content: 'small' },
    { role: 'assistant', content: 'reply' },
  ];
  expect(prunePreservingItems({ messages, reasoning: 'none', emptyMessages: 'keep' })).toEqual(messages);
});

test('a provider other than openai is handled the same way', () => {
  const before: ModelMessage[] = [
    {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 't', providerOptions: { someProvider: { itemId: 'r1' } } },
        { type: 'text', text: 'a', providerOptions: { someProvider: { itemId: 'm1' } } },
      ],
    },
  ];
  const after: ModelMessage[] = [
    { role: 'assistant', content: [{ type: 'text', text: 'a', providerOptions: { someProvider: { itemId: 'm1' } } }] },
  ];
  expect(dropOrphanedItems(before, after)).toEqual([]);
});

/** The assistant tool-call plus the tool message answering it, as one exchange. */
const callAndResult = (call: string, rs?: string): ModelMessage[] => [
  {
    role: 'assistant',
    content: [
      ...(rs ? [{ type: 'reasoning' as const, text: 'deciding', providerOptions: { openai: { itemId: rs } } }] : []),
      { type: 'tool-call', toolCallId: call, toolName: 'grep', input: { pattern: 'x' } },
    ],
  },
  {
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId: call, toolName: 'grep', output: { type: 'text', value: 'hit' } }],
  },
];

test('a tool result left without its tool call is dropped', () => {
  const [, resultMessage] = callAndResult('call_A');
  const cleaned = dropOrphanedResults([{ role: 'user', content: 'q' }, resultMessage!]);
  expect(JSON.stringify(cleaned)).not.toContain('call_A');
  expect(kinds(cleaned)).toEqual(['user']);
});

test('a tool result keeps its place while the call is still there', () => {
  const messages: ModelMessage[] = [{ role: 'user', content: 'q' }, ...callAndResult('call_A')];
  expect(dropOrphanedResults(messages)).toEqual(messages);
});

test('a tool call awaiting its result survives, since that is a suspended approval', () => {
  const [callMessage] = callAndResult('call_A');
  const messages: ModelMessage[] = [{ role: 'user', content: 'q' }, callMessage!];
  expect(dropOrphanedResults(messages)).toEqual(messages);
});

test('a tool-error is treated as a result and dropped with its call', () => {
  const messages: ModelMessage[] = [
    { role: 'user', content: 'q' },
    {
      role: 'tool',
      content: [{ type: 'tool-error', toolCallId: 'call_A', toolName: 'grep', error: 'boom' } as never],
    },
  ];
  expect(JSON.stringify(dropOrphanedResults(messages))).not.toContain('call_A');
});

test('only the orphaned result is dropped, not a healthy one beside it', () => {
  const messages: ModelMessage[] = [
    { role: 'user', content: 'q' },
    ...callAndResult('call_LIVE'),
    {
      role: 'tool',
      content: [
        { type: 'tool-result', toolCallId: 'call_LIVE', toolName: 'grep', output: { type: 'text', value: 'a' } },
        { type: 'tool-result', toolCallId: 'call_GONE', toolName: 'grep', output: { type: 'text', value: 'b' } },
      ],
    },
  ];

  const json = JSON.stringify(dropOrphanedResults(messages));
  expect(json).toContain('call_LIVE');
  expect(json).not.toContain('call_GONE');
});

/**
 * The 400 this guards against: "No tool call found for function call output with
 * call_id ...". Pruning counts messages, so its cut lands between the assistant
 * tool-call and the tool message answering it, stranding the result on the wire.
 */
test('prunePreservingItems never strands a tool result on the wire', () => {
  const messages: ModelMessage[] = [{ role: 'user', content: `q ${'x'.repeat(4000)}` }];
  for (let i = 0; i < 5; i++) {
    messages.push(...callAndResult(`call_${i}`, `rs_${i}`));
    messages.push({ role: 'user', content: `follow up ${i} ${'y'.repeat(4000)}` });
  }

  const pruned = prunePreservingItems({
    messages,
    reasoning: 'all',
    toolCalls: 'before-last-3-messages',
    emptyMessages: 'remove',
  });

  const calls = new Set<string>();
  for (const m of pruned) {
    if (!Array.isArray(m.content)) continue;
    for (const p of m.content as { type: string; toolCallId?: string }[]) {
      if (p.type === 'tool-call' && p.toolCallId) calls.add(p.toolCallId);
    }
  }
  for (const m of pruned) {
    if (!Array.isArray(m.content)) continue;
    for (const p of m.content as { type: string; toolCallId?: string }[]) {
      if (p.type === 'tool-result' || p.type === 'tool-error') expect(calls.has(p.toolCallId!)).toBe(true);
    }
  }
});
