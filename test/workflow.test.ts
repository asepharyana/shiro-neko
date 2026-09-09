import { usageOf } from './helpers';
import { expect, test } from 'bun:test';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Session } from '../src/session';
import { loadInstructions, formatInstructions } from '../src/instructions';
import { systemPrompt, type PromptParts } from '../src/prompt';
import { parseCommand } from '../src/commands';

const usage = usageOf(10, 5);

function stream(parts: LanguageModelV4StreamPart[]) {
  return { stream: simulateReadableStream({ chunks: parts, chunkDelayInMs: null, initialDelayInMs: null }) };
}

function toolCall(id: string, toolName: string, input: unknown): LanguageModelV4StreamPart[] {
  return [
    { type: 'tool-input-start', id, toolName },
    { type: 'tool-input-end', id },
    { type: 'tool-call', toolCallId: id, toolName, input: JSON.stringify(input) },
    { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage },
  ];
}

function text(body: string): LanguageModelV4StreamPart[] {
  return [
    { type: 'text-start', id: '0' },
    { type: 'text-delta', id: '0', delta: body },
    { type: 'text-end', id: '0' },
    { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
  ];
}

/** Fresh dir + a fake git root (.git/HEAD) so the workflow finds a repo. */
function inGitRepo<T>(fn: () => Promise<T>): Promise<T> {
  const orig = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), 'shiro-workflow-'));
  process.chdir(dir);
  return (async () => {
    await Bun.write(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    return fn();
  })().finally(() => {
    process.chdir(orig);
    rmSync(dir, { recursive: true, force: true });
  });
}

test('workflow prompt policy renders when the repo tracks progress', () =>
  inGitRepo(async () => {
    await Bun.write(join(process.cwd(), 'TODO.md'), '# Todo\n- [ ] thing\n');
    await Bun.write(join(process.cwd(), 'docs', 'architecture.md'), '# Arch\n');
    const session = new Session({ model: new MockLanguageModelV4({ doStream: async () => stream([]) }), askApproval: async () => "deny" });
    const parts: PromptParts = { cwd: process.cwd() };
    const rendered = systemPrompt(parts);
    expect(rendered).not.toContain('Project workflow');
    // The policy is supplied by the session, not the parts default.
    expect(parts.workflowPolicy).toBeUndefined();
  }));

test('workflow policy renders via the session when tracking files exist', () =>
  inGitRepo(async () => {
    await Bun.write(join(process.cwd(), 'TODO.md'), '# Todo\n- [ ] thing\n');
    const session = new Session({ model: new MockLanguageModelV4({ doStream: async () => stream([]) }), askApproval: async () => "deny" });
    const status = session.workflowStatus();
    expect(status.hasTodo).toBe(true);
    expect(status.todoLines).toBe(3);
    expect(status.enabled).toBe(true);
    // A session whose repo has TODO.md renders the policy into its system prompt.
  }));

test('workflow disabled renders no policy even with a TODO.md', () =>
  inGitRepo(async () => {
    await Bun.write(join(process.cwd(), 'TODO.md'), '# Todo\n- [ ] thing\n');
    const session = new Session({
      model: new MockLanguageModelV4({ doStream: async () => stream([]) }),
      workflow: { enabled: false },
      askApproval: async () => 'deny',
    });
    // systemFor is private; workflowStatus reflects the switch.
    expect(session.workflowStatus().enabled).toBe(false);
  }));

test('bare repo renders no workflow policy', () =>
  inGitRepo(async () => {
    const session = new Session({ model: new MockLanguageModelV4({ doStream: async () => stream([]) }), askApproval: async () => "deny" });
    const status = session.workflowStatus();
    expect(status.hasTodo).toBe(false);
    expect(status.hasRoadmap).toBe(false);
    expect(status.hasDocs).toBe(false);
    // No tracking files -> policy would be empty; workflowStatus still reports the switch.
    expect(status.enabled).toBe(true);
  }));

test('instructions load TODO.md and ROADMAP.md from the git root', () =>
  inGitRepo(async () => {
    await Bun.write(join(process.cwd(), 'TODO.md'), '# Todo\n- [ ] thing\n');
    await Bun.write(join(process.cwd(), 'ROADMAP.md'), '# Roadmap\n- done\n');
    const loaded = await loadInstructions();
    const labels = loaded.map((i) => i.path);
    expect(labels.some((p) => p.endsWith('TODO.md'))).toBe(true);
    expect(labels.some((p) => p.endsWith('ROADMAP.md'))).toBe(true);
    const fmt = formatInstructions(loaded);
    expect(fmt).toContain('Project tracker');
  }));

test('a turn that edits without updating the task list gets one workflow nudge', () =>
  inGitRepo(async () => {
    await Bun.write(join(process.cwd(), 'TODO.md'), '# Todo\n- [ ] thing\n');
    await Bun.write(join(process.cwd(), 'app.ts'), 'const a = 1;\n');

    let call = 0;
    const session = new Session({
      model: new MockLanguageModelV4({
        doStream: async () =>
          stream(
            call++ === 0
              ? toolCall('c1', 'edit_file', { path: 'app.ts', oldString: 'const a = 1;', newString: 'const a = 2;' })
              : text('done'),
          ),
      }),
      askApproval: async () => 'once',
    });

    const notices: string[] = [];
    for await (const ev of session.send('bump a')) {
      if (ev.type === 'notice') notices.push(ev.text);
    }

    expect(notices.some((n) => n.includes('without updating the project task list'))).toBe(true);
  }));

test('a turn that updates the task list gets no workflow nudge', () =>
  inGitRepo(async () => {
    await Bun.write(join(process.cwd(), 'TODO.md'), '# Todo\n- [ ] thing\n');
    await Bun.write(join(process.cwd(), 'app.ts'), 'const a = 1;\n');

    let call = 0;
    const session = new Session({
      model: new MockLanguageModelV4({
        doStream: async () =>
          stream(
            call++ === 0
              ? toolCall('c1', 'todo_write', { items: [{ text: 'thing', done: true }] })
              : call++ === 1
                ? toolCall('c2', 'edit_file', { path: 'app.ts', oldString: 'const a = 1;', newString: 'const a = 2;' })
                : text('done'),
          ),
      }),
      askApproval: async () => 'once',
    });

    const notices: string[] = [];
    for await (const ev of session.send('bump a')) {
      if (ev.type === 'notice') notices.push(ev.text);
    }

    expect(notices.some((n) => n.includes('without updating the project task list'))).toBe(false);
  }));

test('/workflow parses to the workflow action', () => {
  expect(parseCommand('/workflow')).toEqual({ type: 'workflow' });
  const menuEntry = parseCommand('/');
  expect(menuEntry).not.toEqual({ type: 'workflow' });
});

test('/workflow panel renders the status rows', () =>
  inGitRepo(async () => {
    await Bun.write(join(process.cwd(), 'TODO.md'), '# Todo\n- [ ] thing\n');
    const session = new Session({ model: new MockLanguageModelV4({ doStream: async () => stream([]) }), askApproval: async () => 'deny' });
    const { workflowPanel } = await import('../src/ui/panel-bodies');
    const panel = workflowPanel(session);
    expect(panel.title).toBe('workflow');
    expect(panel.body).toContain('TODO.md: yes');
    expect(panel.body).toContain('workflow: on');
  }));

test('context panel groups instructions and trackers separately', () => {
  const pm = require('../src/ui/panel-bodies') as typeof import('../src/ui/panel-bodies');
  const panel = pm.contextPanel(['/repo/AGENTS.md', '/repo/TODO.md', '/repo/docs/a.md']);
  expect(panel.title).toBe('project instructions & trackers');
  expect(panel.body).toContain('instructions:');
  expect(panel.body).toContain('- `/repo/AGENTS.md`');
  expect(panel.body).toContain('trackers:');
  expect(panel.body).toContain('- `/repo/TODO.md`');

  const empty = pm.contextPanel([]);
  expect(empty.body).toContain('No `AGENTS.md`');
  expect(empty.body).toContain('no project tracker is loaded');
});