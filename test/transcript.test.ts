import { expect, test } from 'bun:test';
import { historyFromMessages } from '../src/ui/transcript';
import type { Line } from '../src/ui/transcript';

const kind = (lines: Line[]) => lines.map((l) => l.kind);

test('historyFromMessages maps a saved conversation into transcript lines', () => {
  const lines = historyFromMessages([
    { role: 'user', content: 'fix the pagination test' },
    { role: 'assistant', content: 'Looking at the suite' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Found it.' },
        {
          type: 'tool-call',
          toolCallId: 't1',
          toolName: 'edit_file',
          input: { path: 'test/PageTest.php', oldString: 'a', newString: 'b' },
        },
      ],
    },
    {
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: 't1', toolName: 'edit_file', output: { type: 'text', value: 'Replaced 1 occurrence' } }],
    },
  ]);

  // user + assistant text + assistant text part + tool call + existing call line
  expect(kind(lines)).toEqual(['user', 'assistant', 'assistant', 'tool']);
  const tool = lines.at(-1)!;
  expect(tool.kind).toBe('tool');
  if (tool.kind === 'tool') {
    expect(tool.result).toBe('Replaced 1 occurrence');
    expect(tool.ok).toBe(true);
  }
});

test('historyFromMessages unwraps SDK-wrapped and json-wrapped tool outputs', () => {
  const lines = historyFromMessages([
    {
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: 'g1', toolName: 'grep', input: { pattern: 'TODO' } }],
    },
    {
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: 'g1', toolName: 'grep', output: { type: 'text', value: 'src/a.ts:1: TODO' } }],
    },
  ]);
  const line = lines[0]!;
  expect(line.kind).toBe('tool');
  if (line.kind === 'tool') expect(line.result).toBe('1 hit');
});

test('historyFromMessages marks a tool-error call as failed', () => {
  const lines = historyFromMessages([
    {
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: 'b1', toolName: 'bash', input: { command: 'false' } }],
    },
    {
      role: 'tool',
      content: [{ type: 'tool-error', toolCallId: 'b1', toolName: 'bash', output: { type: 'text', value: 'exit 1' } }],
    },
  ]);
  const line = lines[0]!;
  expect(line.kind).toBe('tool');
  if (line.kind === 'tool') {
    expect(line.ok).toBe(false);
    expect(line.result).toBe('exit 1');
  }
});

test('historyFromMessages drops a tool result with no matching call (pruned lead-in)', () => {
  const lines = historyFromMessages([
    { role: 'user', content: 'continue' },
    {
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: 'gone', toolName: 'grep', output: { type: 'text', value: 'x' } }],
    },
  ]);
  // Only the user line remains; the orphaned result is not floated.
  expect(kind(lines)).toEqual(['user']);
});

test('historyFromMessages skips system and empty messages', () => {
  const lines = historyFromMessages([
    { role: 'system', content: 'You are an agent.' },
    { role: 'user', content: '' },
    { role: 'assistant', content: 'ok' },
  ]);
  expect(kind(lines)).toEqual(['assistant']);
});