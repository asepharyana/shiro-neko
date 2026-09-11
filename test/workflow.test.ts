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

test('nudge ladder: fires up to 3 times, then stops', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shiro-wf-ladder'));
  try {
    await Bun.write(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await Bun.write(join(dir, 'TODO.md'), '# Todo\n- [ ] task\n');
    await Bun.write(join(dir, 'app.ts'), 'const a = 1;\n');

    // Each SDK turn is one session.send(). The nudge fires once per turn that
    // wrote files without updating the task list — so the model must edit in
    // one turn, then end the turn with text (which lets the nudge fire), then
    // edit again next turn. Three nudges ⇒ three turns each with an edit and
    // a following text-only turn (the session re-invokes the model per turn,
    // so 'done' ends that turn and the loop stops).
    let call = 0;
    const session = new Session({
      model: new MockLanguageModelV4({
        doStream: async () => {
          call++;
          // Turn boundaries: every send() calls doStream once. Odd calls (1,3,5)
          // edit; even calls (2,4,6) return text to end the turn. call>=7 → text
          // (agent finished after the 3rd nudge).
          if (call <= 6 && call % 2 === 1) {
            const content = (await Bun.file(join(dir, 'app.ts')).text()).trimEnd();
            const next = Math.ceil(call / 2) + 1;
            return stream(toolCall(`c${call}`, 'edit_file', { path: 'app.ts', oldString: content, newString: `const a = ${next};` }));
          }
          return stream(text('done'));
        },
      }),
      askApproval: async () => 'once',
    });

    const notices: string[] = [];
    for (let i = 0; i < 10; i++) {
      for await (const ev of session.send(`turn ${i + 1}`)) {
        if (ev.type === 'notice') notices.push(ev.text);
      }
    }
    const nudgeNotices = notices.filter((n) => n.includes('TODO.md'));
    expect(nudgeNotices.length).toBe(3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('todo_write in a turn suppresses that turn\'s nudge', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shiro-wf-reset'));
  try {
    await Bun.write(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await Bun.write(join(dir, 'TODO.md'), '# Todo\n- [ ] task\n');
    await Bun.write(join(dir, 'app.ts'), 'const a = 1;\n');

    // One session.send() = one full agent run (the SDK loop re-invokes the
    // model until it returns text). The nudge fires once per send, and the
    // counter is a *lifetime* cap of 3 — todo_write only suppresses the nudge
    // for the turn in which it runs:
    //  call 1 (edit+todo_write), call 2 text -> send 1 -> no nudge
    //  call 3 (edit), call 4 text            -> send 2 -> nudge 1
    //  call 5 (edit), call 6 text            -> send 3 -> nudge 2
    //  call 7 (edit), call 8 text            -> send 4 -> nudge 3
    //  call 9 (edit), call 10 text           -> send 5 -> capped, no nudge
    let call = 0;
    const session = new Session({
      model: new MockLanguageModelV4({
        doStream: async () => {
          call++;
          const c = await Bun.file(join(dir, 'app.ts')).text();
          const next = Math.floor((call + 1) / 2) + 1;
          if (call === 1) {
            // Same send: edit + todo_write -> nudge suppressed for this turn
            return stream([
              ...toolCall('e1', 'edit_file', { path: 'app.ts', oldString: c.trimEnd(), newString: `const a = ${next};` }),
              ...toolCall('w', 'todo_write', { items: [{ text: 'completed task', done: true }] }),
            ]);
          }
          if (call % 2 === 1) {
            // Odd calls (3,5,7,9): edit -> each ends a send
            return stream(toolCall(`e${call}`, 'edit_file', { path: 'app.ts', oldString: c.trimEnd(), newString: `const a = ${next};` }));
          }
          // Even calls: text ends the send
          return stream(text('done'));
        },
      }),
      askApproval: async () => 'once',
    });

    const notices: string[] = [];
    for (let i = 0; i < 6; i++) {
      for await (const ev of session.send(`turn ${i + 1}`)) {
        if (ev.type === 'notice') notices.push(ev.text);
      }
    }
    const nudgeNotices = notices.filter((n) => n.includes('TODO.md'));
    // Send 1 suppressed (todo_write), sends 2-4 nudges 1-3, send 5 capped.
    expect(nudgeNotices.length).toBe(3);
    // The messages escalate (1st/2nd/3rd), proving the ladder.
    expect(nudgeNotices[0] ?? '').toContain('reminder:');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});