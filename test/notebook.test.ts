import { expect, test } from 'bun:test';
import type { ToolSet } from 'ai';
import { Notebook } from '../src/notebook';
import { systemPrompt } from '../src/prompt';

const call = (tools: ToolSet, name: string, input: Record<string, unknown>) => {
  const t = tools[name];
  if (!t?.execute) throw new Error(`${name} is not executable`);
  return Promise.resolve(t.execute(input as never, { toolCallId: 'x', messages: [] } as never)) as Promise<string>;
};

test('a fresh notebook renders nothing so the prompt is unchanged', () => {
  const nb = new Notebook();
  expect(nb.render()).toBe('');
  expect(nb.state()).toEqual({ todos: [] });
});

test('todo_write stores the list and reports progress', async () => {
  const nb = new Notebook();
  const out = await call(nb.tools(), 'todo_write', {
    todos: [
      { content: 'read the config', status: 'done' },
      { content: 'add the flag', status: 'in_progress' },
      { content: 'write a test', status: 'pending' },
    ],
  });

  expect(out).toContain('1/3 done');
  expect(out).toContain('[x] read the config');
  expect(out).toContain('[~] add the flag');
  expect(out).toContain('[ ] write a test');
  expect(nb.state().todos).toHaveLength(3);
});

test('todo_write replaces the previous list rather than appending', async () => {
  const nb = new Notebook();
  await call(nb.tools(), 'todo_write', { todos: [{ content: 'first', status: 'pending' }] });
  await call(nb.tools(), 'todo_write', { todos: [{ content: 'second', status: 'pending' }] });
  expect(nb.state().todos.map((t) => t.content)).toEqual(['second']);
});

test('todo_write warns when more than one task is in_progress', async () => {
  const nb = new Notebook();
  const out = await call(nb.tools(), 'todo_write', {
    todos: [
      { content: 'a', status: 'in_progress' },
      { content: 'b', status: 'in_progress' },
    ],
  });
  expect(out).toContain('Warning');
  expect(out).toContain('2 tasks are in_progress');
});

test('the task list is re-rendered into the system prompt', async () => {
  const nb = new Notebook();
  await call(nb.tools(), 'todo_write', { todos: [{ content: 'wire up the parser', status: 'in_progress' }] });

  const prompt = systemPrompt({ cwd: '/repo', notebook: nb.render() });
  expect(prompt).toContain('[~] wire up the parser');
  expect(prompt).toContain('todo_write');
});

test('onChange fires so the UI and autosave stay current', async () => {
  const seen: number[] = [];
  const nb = new Notebook((s) => seen.push(s.todos.length));
  await call(nb.tools(), 'todo_write', { todos: [{ content: 'a', status: 'pending' }] });
  await call(nb.tools(), 'todo_write', {
    todos: [
      { content: 'a', status: 'done' },
      { content: 'b', status: 'pending' },
    ],
  });
  expect(seen).toEqual([1, 2]);
});

test('restore rebuilds a resumed session and clear empties it', () => {
  const nb = new Notebook();
  nb.restore({ todos: [{ content: 'carried over', status: 'in_progress' }] });
  expect(nb.render()).toContain('carried over');

  nb.clear();
  expect(nb.state()).toEqual({ todos: [] });
});

test('restore ignores malformed persisted state instead of throwing', () => {
  const nb = new Notebook();
  nb.restore({ todos: [{ content: 'ok', status: 'pending' }, { bogus: true }, null] as never });
  expect(nb.state()).toEqual({ todos: [{ content: 'ok', status: 'pending' }] });
});

test('restore of undefined is a no-op', () => {
  const nb = new Notebook();
  nb.restore(undefined);
  expect(nb.state()).toEqual({ todos: [] });
});
