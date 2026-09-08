import { expect, test } from 'bun:test';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { Session } from '../src/session';
import { createHost } from '../src/plugins';
import { guardPlugin } from '../src/plugins-builtin';
import type { Skill } from '../src/skills';

const usage = { inputTokens: { total: 1 }, outputTokens: { total: 1 } } as any;
const stream = (parts: LanguageModelV4StreamPart[]) => ({
  stream: simulateReadableStream({ chunks: parts, chunkDelayInMs: null, initialDelayInMs: null }),
});
const text = (body: string): LanguageModelV4StreamPart[] => [
  { type: 'text-start', id: '0' },
  { type: 'text-delta', id: '0', delta: body },
  { type: 'text-end', id: '0' },
  { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
];
const toolCall = (id: string, toolName: string, input: unknown): LanguageModelV4StreamPart[] => [
  { type: 'tool-input-start', id, toolName },
  { type: 'tool-input-end', id },
  { type: 'tool-call', toolCallId: id, toolName, input: JSON.stringify(input) },
  { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage },
];

function skill(name: string, body = `do ${name}`): Skill {
  return { name, description: `${name} skill`, body, origin: 'registry' };
}

test('a skill installed mid-session is callable next turn without restart', async () => {
  let call = 0;
  const session = new Session({
    model: new MockLanguageModelV4({
      doStream: async (o) => {
        // first turn: whatever prompt, return alpha; second turn: return beta
        const prompt = JSON.stringify(o.prompt);
        // after hot-reload, next send contains "beta"
        if (prompt.includes('beta')) return stream(toolCall('c2', 'skill', { name: 'beta' }));
        // first turn returns alpha on first step, text on second
        if (call++ === 0) return stream(toolCall('c1', 'skill', { name: 'alpha' }));
        return stream(text('done alpha'));
      },
    }),
    askApproval: async () => 'deny',
    skills: [skill('alpha')],
  });

  // turn 1: alpha exists
  for await (const _ of session.send('use alpha')) void _;
  expect(JSON.stringify(session.messages)).toContain('do alpha');

  // hot-reload: beta added
  session.updateSkills([skill('alpha'), skill('beta')]);

  // next turn: beta is now callable — should succeed as tool-result, not error
  call = 0;
  // need a model that will handle the beta tool then text
  let step = 0;
  (session as any).model = new MockLanguageModelV4({
    doStream: async () => {
      if (step++ === 0) return stream(toolCall('c2', 'skill', { name: 'beta' }));
      return stream(text('done beta'));
    },
  });
  const events: string[] = [];
  for await (const ev of session.send('use beta')) events.push(ev.type);
  expect(events).toContain('tool-result');
  expect(events).not.toContain('tool-error');
  expect(JSON.stringify(session.messages)).toContain('do beta');
});

test('hot-reload during a turn is deferred until the turn ends', async () => {
  const session = new Session({
    model: new MockLanguageModelV4({ doStream: async () => stream(text('ok')) }),
    askApproval: async () => 'deny',
    skills: [skill('alpha')],
  });

  // simulate in-flight turn
  (session as any).controller = new AbortController();
  session.updateSkills([skill('alpha'), skill('beta')]);
  expect((session as any).pendingSkills).toBeDefined();
  expect((session as any).currentSkills.map((s: Skill) => s.name)).toEqual(['alpha']);

  // drain at turn boundary
  (session as any).controller = undefined;
  (session as any).drainPendingHotReload();
  expect((session as any).currentSkills.map((s: Skill) => s.name)).toEqual(['alpha', 'beta']);
  expect((session as any).pendingSkills).toBeUndefined();
});

test('a plugin installed mid-session is enforced next turn', async () => {
  let n = 0;
  const session = new Session({
    model: new MockLanguageModelV4({
      doStream: async () => (n++ === 0 ? stream(toolCall('c1', 'bash', { command: 'rm -rf /' })) : stream(text('ok'))),
    }),
    askApproval: async () => 'once' as const,
    plugins: createHost([]),
  });

  // install guard mid-session
  session.updatePlugins(createHost([guardPlugin]));
  const events: string[] = [];
  const notices: string[] = [];
  for await (const ev of session.send('clean')) {
    events.push(ev.type);
    if (ev.type === 'notice') notices.push(ev.text);
  }
  expect(events).toContain('tool-denied');
  expect(notices.join()).toContain('recursive or forced delete');
});
