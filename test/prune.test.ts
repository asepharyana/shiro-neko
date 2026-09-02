import { expect, test } from 'bun:test';
import type { ModelMessage } from 'ai';
import { dropOrphanedItems, prunePreservingItems } from '../src/prune';

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
