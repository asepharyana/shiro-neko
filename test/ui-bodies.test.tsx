import { expect, test } from 'bun:test';
import { MockLanguageModelV4 } from 'ai/test';
import { Session } from '../src/session';
import type { SubagentEvent } from '../src/subagent';
import { applySubagentEvent, createNoticeBus, createSubagentBus } from '../src/ui/buses';
import { contextPanel, costPanel, todosPanel, toolsPanel } from '../src/ui/panel-bodies';
import type { SubagentView } from '../src/ui/Panels';

/**
 * `panel-bodies.ts` and `buses.ts` are the two UI modules with no test of their own.
 * The panel bodies are pure functions of session and hook state, so they are
 * exercised here without mounting Ink; the buses are driven directly.
 *
 * The panel functions only read counters, so the mock model's stream is never run.
 */
const model = new MockLanguageModelV4({ doStream: async () => ({ stream: new ReadableStream() }) });

type SessionOverrides = Partial<ConstructorParameters<typeof Session>[0]>;

const makeSession = (over: SessionOverrides = {}) =>
  new Session({ model, askApproval: async () => 'deny', ...over });

const COST_INFO = { sessionId: 'abc12345', model: 'gpt-5', agent: 'default', thinking: 'medium' };

test('the tools panel lists what is offered and names each tool set', () => {
  const session = makeSession();
  const panel = toolsPanel(session);
  const offered = session.activeTools();

  expect(panel.title).toBe('tools');
  expect(panel.hint).toBe(`${offered.length} offered this turn of ${Object.keys(session.tools).length} registered`);
  expect(panel.body).toContain('- `read_file`');
  expect(panel.body).toContain('- `bash`  core');
  expect(panel.body).toContain('- `git_diff`  git');
});

test('a read-only agent narrows the panel to the tools it may call', () => {
  const session = makeSession();
  session.setAgent({ name: 'plan', summary: '', thinking: 'high', appendix: '', allowTools: ['read_file', 'grep'] });

  const panel = toolsPanel(session);
  expect(panel.body).toContain('`read_file`');
  expect(panel.body).toContain('`grep`');
  expect(panel.body).not.toContain('`write_file`');
  expect(panel.body).not.toContain('`bash`');
});

test('a panel hint counts offered against registered', () => {
  const session = makeSession();
  session.setAgent({ name: 'plan', summary: '', thinking: 'high', appendix: '', allowTools: ['read_file'] });
  expect(toolsPanel(session).hint).toBe(`1 offered this turn of ${Object.keys(session.tools).length} registered`);
});

test('the cost panel reports a priced turn, context, and the agent', () => {
  const session = makeSession({ modelId: 'gpt-5' });
  session.inputTokens = 1000;
  session.outputTokens = 500;

  const panel = costPanel(session, COST_INFO);
  expect(panel.title).toBe('cost');
  expect(panel.hint).toBe('session abc12345');
  expect(panel.body).toContain('- model: `gpt-5`');
  expect(panel.body).toContain('- billed: 1000 in / 500 out');
  expect(panel.body).toMatch(/- spend: \$\d/);
  expect(panel.body).not.toContain('unpriced model');
  expect(panel.body).toContain('- context: ~');
  expect(panel.body).toContain('- agent: `default` thinking `medium`');
});

test('an unknown model is reported as unpriced rather than guessed', () => {
  const session = makeSession({ modelId: 'llama-3.3-70b' });
  session.inputTokens = 4210;
  session.outputTokens = 88;

  const panel = costPanel(session, { ...COST_INFO, model: 'llama-3.3-70b' });
  expect(panel.body).toContain('- spend: unpriced model');
});

test('subagent spend is its own line and priced against the subagent model', () => {
  const session = makeSession({ modelId: 'gpt-5', subagentModelId: 'gpt-5-nano' });
  session.inputTokens = 1000;
  session.outputTokens = 100;
  session.recordSubagentUsage({ inputTokens: 800, outputTokens: 200 });

  const panel = costPanel(session, { ...COST_INFO, subagentModel: 'gpt-5-nano' });
  expect(panel.body).toContain('- subagents: 800 in / 200 out (`gpt-5-nano`)');
});

test('a ceiling with both numbers priced reports what is spent against it', () => {
  const session = makeSession({ modelId: 'gpt-5', maxSpendUsd: 10 });
  session.inputTokens = 1_000_000;

  const spend = session.spend();
  expect(spend.ceiling).toBe(10);
  expect(spend.usd).toBeCloseTo(1.25, 5);
  expect(spend.overWarn).toBe(false);
  expect(spend.overLimit).toBe(false);

  const panel = costPanel(session, COST_INFO);
  expect(panel.body).toContain('- ceiling: $1.25 of $10.00');
});

test('a ceiling is not enforced against an unpriced model', () => {
  const session = makeSession({ modelId: 'llama-3.3-70b', maxSpendUsd: 1 });
  session.inputTokens = 9_999_999;

  const spend = session.spend();
  expect(spend.usd).toBeUndefined();
  expect(spend.ceiling).toBe(1);
  expect(spend.overWarn).toBe(false);
  expect(spend.overLimit).toBe(false);
});

test('crossing the ceiling flags warn at 80% and limit at 100%', () => {
  // $1.25/M in and $10/M out for gpt-5: 8M in is $10 exactly, so warn and limit land together.
  const session = makeSession({ modelId: 'gpt-5', maxSpendUsd: 10 });
  session.inputTokens = 8_000_000;

  const spend = session.spend();
  expect(spend.usd).toBeCloseTo(10, 5);
  expect(spend.overWarn).toBe(true);
  expect(spend.overLimit).toBe(true);
});

test('the context panel lists instruction files, and points at /init when there are none', () => {
  const loaded = contextPanel(['AGENTS.md', '.shiro/skills/extra.md']);
  expect(loaded.title).toBe('project instructions');
  expect(loaded.body).toContain('- `AGENTS.md`');
  expect(loaded.body).toContain('- `.shiro/skills/extra.md`');

  const empty = contextPanel([]);
  expect(empty.body).toContain('No `AGENTS.md`');
  expect(empty.body).toContain('/init');
});

test('the todos panel renders the notebook state', async () => {
  const session = makeSession();
  expect(todosPanel(session).body).toBe('No task list yet.');

  const write = session.notebook.tools()['todo_write']!;
  await write.execute!(
    {
      todos: [
        { content: 'first task', status: 'done' },
        { content: 'second task', status: 'in_progress', note: 'halfway' },
      ],
    },
    { toolCallId: 't', messages: [], context: {} },
  );

  const panel = todosPanel(session);
  expect(panel.title).toBe('task list');
  expect(panel.body).toContain('first task');
  expect(panel.body).toContain('second task');
  expect(panel.body).toContain('halfway');
});

test('a notice emitted before a sink is bound is delivered on bind, in order', () => {
  const bus = createNoticeBus();
  const seen: string[] = [];

  bus.emit('first');
  bus.emit('second');
  expect(seen).toEqual([]);

  bus.bind((text) => seen.push(text));
  expect(seen).toEqual(['first', 'second']);

  bus.emit('third');
  expect(seen).toEqual(['first', 'second', 'third']);
});

test('a notice emitted after a bind goes straight through', () => {
  const bus = createNoticeBus();
  const seen: string[] = [];
  bus.bind((t) => seen.push(t));
  bus.emit('only');
  expect(seen).toEqual(['only']);
});

test('a rebind takes over and the queue is not replayed twice', () => {
  const bus = createNoticeBus();
  const first: string[] = [];
  const second: string[] = [];

  bus.emit('queued');
  bus.bind((t) => first.push(t));
  bus.bind((t) => second.push(t));

  expect(first).toEqual(['queued']);
  expect(second).toEqual([]);

  bus.emit('later');
  expect(first).toEqual(['queued']);
  expect(second).toEqual(['later']);
});

test('a subagent event before a bind is delivered on bind', () => {
  const bus = createSubagentBus();
  const seen: SubagentEvent[] = [];
  const event: SubagentEvent = { type: 'start', id: 'a', kind: 'explore', description: 'find auth' };

  bus.emit(event);
  expect(seen).toEqual([]);

  bus.bind((e) => seen.push(e));
  expect(seen).toEqual([event]);
});

const started = (id: string, kind: 'explore' | 'review' | 'worker' = 'explore'): SubagentEvent => ({
  type: 'start',
  id,
  kind,
  description: `${kind} task`,
});

test('a result attaches to the step it answers instead of appending a step', () => {
  let view: SubagentView[] = [];
  view = applySubagentEvent(view, started('a'));
  view = applySubagentEvent(view, { type: 'step', id: 'a', tool: 'grep', summary: 'login' });
  view = applySubagentEvent(view, { type: 'result', id: 'a', tool: 'grep', summary: '2 hits', ok: true });

  expect(view).toHaveLength(1);
  expect(view[0]!.steps).toHaveLength(1);
  expect(view[0]!.steps[0]).toEqual({ tool: 'grep', summary: 'login', outcome: '2 hits', ok: true });
});

test('a result for a tool that is not the pending step is ignored', () => {
  let view: SubagentView[] = [];
  view = applySubagentEvent(view, started('a'));
  view = applySubagentEvent(view, { type: 'step', id: 'a', tool: 'grep', summary: 'login' });
  view = applySubagentEvent(view, { type: 'result', id: 'a', tool: 'read_file', summary: 'nope', ok: true });

  expect(view[0]!.steps).toEqual([{ tool: 'grep', summary: 'login' }]);
});

test('a second result for the same step does not overwrite the first', () => {
  let view: SubagentView[] = [];
  view = applySubagentEvent(view, started('a'));
  view = applySubagentEvent(view, { type: 'step', id: 'a', tool: 'grep', summary: 'login' });
  view = applySubagentEvent(view, { type: 'result', id: 'a', tool: 'grep', summary: 'first', ok: true });
  view = applySubagentEvent(view, { type: 'result', id: 'a', tool: 'grep', summary: 'second', ok: false });

  expect(view[0]!.steps[0]!.outcome).toBe('first');
});

test('an end event flips the status, and an error event carries its message', () => {
  const base = applySubagentEvent([], started('a'));

  expect(applySubagentEvent(base, { type: 'end', id: 'a', ok: true, steps: 2 })[0]!.status).toBe('done');
  expect(applySubagentEvent(base, { type: 'end', id: 'a', ok: false, steps: 2 })[0]!.status).toBe('failed');

  const errored = applySubagentEvent(base, { type: 'error', id: 'a', message: 'model refused' });
  expect(errored[0]!.status).toBe('failed');
  expect(errored[0]!.error).toBe('model refused');
});

test('an event naming no known agent leaves the view untouched', () => {
  const base = applySubagentEvent([], started('a'));
  const view = applySubagentEvent(base, { type: 'end', id: 'ghost', ok: true, steps: 0 });

  expect(view).toHaveLength(1);
  expect(view[0]!.id).toBe('a');
  expect(view[0]!.status).toBe('running');
});

test('two agents interleave without crossing their steps', () => {
  let view: SubagentView[] = [];
  view = applySubagentEvent(view, started('a'));
  view = applySubagentEvent(view, started('b', 'review'));
  view = applySubagentEvent(view, { type: 'step', id: 'b', tool: 'read_file', summary: 'b.ts' });
  view = applySubagentEvent(view, { type: 'step', id: 'a', tool: 'grep', summary: 'a.ts' });

  expect(view).toHaveLength(2);
  expect(view[0]!.steps.map((s) => s.tool)).toEqual(['grep']);
  expect(view[1]!.steps.map((s) => s.tool)).toEqual(['read_file']);
});
