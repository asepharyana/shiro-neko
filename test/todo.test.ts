import { expect, test } from 'bun:test';
import { Notebook, TODO_MARK } from '../src/notebook';
import type { ToolSet } from 'ai';

const call = (tools: ToolSet, todos: unknown) =>
  Promise.resolve(
    tools['todo_write']!.execute!({ todos } as never, { toolCallId: 'x', messages: [] } as never),
  ) as Promise<string>;

test('all four statuses have distinct markers', () => {
  expect(new Set(Object.values(TODO_MARK)).size).toBe(4);
  expect(TODO_MARK.blocked).toBe('[!]');
});

test('progress counts done, total, blocked, and the current task', async () => {
  const nb = new Notebook();
  await call(nb.tools(), [
    { content: 'a', status: 'done' },
    { content: 'b', status: 'in_progress' },
    { content: 'c', status: 'blocked', note: 'waiting on review' },
    { content: 'd', status: 'pending' },
  ]);

  const p = nb.progress();
  expect(p).toMatchObject({ done: 1, total: 4, blocked: 1 });
  expect(p.current?.content).toBe('b');
});

test('a blocked task carries its note into the render', async () => {
  const nb = new Notebook();
  await call(nb.tools(), [{ content: 'deploy', status: 'blocked', note: 'no credentials' }]);
  expect(nb.render()).toContain('[!] deploy  (no credentials)');
  expect(nb.render()).toContain('1 blocked');
});

test('blocked with no note is called out', async () => {
  const nb = new Notebook();
  const out = await call(nb.tools(), [{ content: 'deploy', status: 'blocked' }]);
  expect(out).toContain('blocked with no note');
});

test('nothing in progress while work remains is called out', async () => {
  const nb = new Notebook();
  const out = await call(nb.tools(), [
    { content: 'a', status: 'done' },
    { content: 'b', status: 'pending' },
  ]);
  expect(out).toContain('nothing is in_progress');
});

test('a fully done list draws no warning', async () => {
  const nb = new Notebook();
  const out = await call(nb.tools(), [
    { content: 'a', status: 'done' },
    { content: 'b', status: 'done' },
  ]);
  expect(out).not.toContain('Warning');
  expect(out).toContain('2/2 done');
});

test('an all-blocked list draws no in_progress warning', async () => {
  const nb = new Notebook();
  const out = await call(nb.tools(), [{ content: 'a', status: 'blocked', note: 'upstream is down' }]);
  expect(out).not.toContain('nothing is in_progress');
});

test('two in_progress tasks are still flagged', async () => {
  const nb = new Notebook();
  const out = await call(nb.tools(), [
    { content: 'a', status: 'in_progress' },
    { content: 'b', status: 'in_progress' },
  ]);
  expect(out).toContain('2 tasks are in_progress');
});

test('the header reports blocked count only when there is one', async () => {
  const nb = new Notebook();
  await call(nb.tools(), [{ content: 'a', status: 'in_progress' }]);
  expect(nb.render()).not.toContain('blocked');
});

test('state is a copy, so a caller cannot mutate the notebook', async () => {
  const nb = new Notebook();
  await call(nb.tools(), [{ content: 'original', status: 'pending' }]);
  const snapshot = nb.state();
  snapshot.todos[0]!.content = 'tampered';
  expect(nb.state().todos[0]?.content).toBe('original');
});

test('a restored blocked task keeps its note', () => {
  const nb = new Notebook();
  nb.restore({ todos: [{ content: 'x', status: 'blocked', note: 'kept' }] });
  expect(nb.state().todos[0]?.note).toBe('kept');
});

test('an unknown status is filtered out on restore', () => {
  const nb = new Notebook();
  nb.restore({ todos: [{ content: 'ok', status: 'pending' }, { content: 'bad', status: 'sideways' }] as never });
  expect(nb.state().todos).toEqual([{ content: 'ok', status: 'pending' }]);
});
