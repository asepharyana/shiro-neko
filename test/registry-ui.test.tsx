import { expect, test } from 'bun:test';
import { render } from 'ink-testing-library';
import React from 'react';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { Session } from '../src/session';
import { App, createApprovalBridge, type AppHooks } from '../src/ui/App';
import { InstallPrompt, RegistryPanel, type RegistryRow } from '../src/ui/Panels';
import { testHooks } from './helpers';

const usage = { inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1 } } as any;

const model = new MockLanguageModelV4({
  doStream: async () =>
    ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'text-start', id: '0' },
          { type: 'text-delta', id: '0', delta: 'reply' },
          { type: 'text-end', id: '0' },
          { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
        ],
        chunkDelayInMs: null,
        initialDelayInMs: null,
      }),
    }) as any,
});

const rows: RegistryRow[] = [
  { name: 'migration', kind: 'skill', description: 'Write a database migration' },
  { name: 'no-secrets', kind: 'plugin', description: 'Refuses credential writes', installed: true },
];

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function mount(over: Partial<AppHooks> = {}) {
  const bridge = createApprovalBridge();
  const session = new Session({ model, askApproval: bridge.ask });
  const app = render(<App session={session} bridge={bridge} header="hdr" hooks={testHooks(over)} />);
  return { app, session };
}

async function run(app: ReturnType<typeof render>, command: string, settle = 400) {
  for (const ch of command) {
    app.stdin.write(ch);
    await wait(30);
  }
  app.stdin.write('\r');
  await wait(settle);
}

test('the registry panel marks skill and plugin differently and flags what is installed', () => {
  const app = render(<RegistryPanel rows={rows} hint="2 available" />);
  const frame = app.lastFrame() ?? '';
  expect(frame).toContain('migration');
  expect(frame).toContain('no-secrets');
  expect(frame).toContain('installed');
  expect(frame).toContain('S skill  P plugin');
  app.unmount();
});

test('an empty registry panel says so rather than rendering an empty box', () => {
  const app = render(<RegistryPanel rows={[]} />);
  expect(app.lastFrame()).toContain('nothing found');
  app.unmount();
});

test('the install prompt shows the body and says what a skill actually is', () => {
  const app = render(
    <InstallPrompt
      name="migration"
      kind="skill"
      url="https://example.com/m.md"
      preview={'Migrations live in db/migrations.'}
    />,
  );
  const frame = app.lastFrame() ?? '';
  expect(frame).toContain('install skill "migration"?');
  expect(frame).toContain('https://example.com/m.md');
  expect(frame).toContain('Migrations live in db/migrations.');
  expect(frame).toContain('joins your system prompt');
  app.unmount();
});

test('the install prompt says a plugin is data, not code', () => {
  const app = render(
    <InstallPrompt name="no-secrets" kind="plugin" url="https://e.com/p.json" preview="- denies write_file" />,
  );
  const frame = app.lastFrame() ?? '';
  expect(frame).toContain('nothing here is executed');
  expect(frame).toContain('denies write_file');
  app.unmount();
});

test('a long body is truncated with a count rather than flooding the screen', () => {
  const preview = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
  const app = render(<InstallPrompt name="x" kind="skill" url="https://e.com/x.md" preview={preview} lines={5} />);
  const frame = app.lastFrame() ?? '';
  expect(frame).toContain('line 4');
  expect(frame).not.toContain('line 20');
  expect(frame).toContain('35 more lines');
  app.unmount();
});

test('/registry lists the index', async () => {
  const { app } = mount({ registry: { ...testHooks().registry, list: async () => rows } });
  await wait(150);

  await run(app, '/registry');

  const frame = app.lastFrame() ?? '';
  expect(frame).toContain('migration');
  expect(frame).toContain('2 of 2 available');

  app.unmount();
}, 20_000);

test('/registry search narrows the list', async () => {
  const { app } = mount({ registry: { ...testHooks().registry, list: async () => rows } });
  await wait(150);

  await run(app, '/registry search migra');

  const frame = app.lastFrame() ?? '';
  expect(frame).toContain('migration');
  expect(frame).not.toContain('no-secrets');
  expect(frame).toContain('1 of 2');

  app.unmount();
}, 20_000);

test('a failing index surfaces the error instead of an empty panel', async () => {
  const { app } = mount({
    registry: {
      ...testHooks().registry,
      list: async () => {
        throw new Error('the registry index is not valid JSON');
      },
    },
  });
  await wait(150);

  await run(app, '/registry');
  expect(app.lastFrame()).toContain('not valid JSON');

  app.unmount();
}, 20_000);

test('/registry add stages, shows the body, and installs only on y', async () => {
  const installed: string[] = [];
  const { app } = mount({
    registry: {
      ...testHooks().registry,
      stage: async (name) => ({
        row: { name, kind: 'skill', description: 'd' },
        url: 'https://example.com/m.md',
        preview: 'Migrations live in db/migrations.',
      }),
      install: async (name) => {
        installed.push(name);
        return `installed skill ${name}`;
      },
    },
  });
  await wait(150);

  await run(app, '/registry add migration');
  expect(app.lastFrame()).toContain('install skill "migration"?');
  expect(installed).toEqual([]);

  app.stdin.write('y');
  await wait(400);

  expect(installed).toEqual(['migration']);
  expect(app.lastFrame()).toContain('installed skill migration');

  app.unmount();
}, 20_000);

test('n cancels the install and nothing is written', async () => {
  const installed: string[] = [];
  const { app } = mount({
    registry: {
      ...testHooks().registry,
      stage: async (name) => ({
        row: { name, kind: 'skill', description: 'd' },
        url: 'https://example.com/m.md',
        preview: 'body',
      }),
      install: async (name) => {
        installed.push(name);
        return 'installed';
      },
    },
  });
  await wait(150);

  await run(app, '/registry add migration');
  app.stdin.write('n');
  await wait(400);

  expect(installed).toEqual([]);
  expect(app.lastFrame()).toContain('install cancelled: migration');

  app.unmount();
}, 20_000);

test('a staging failure never reaches the confirmation prompt', async () => {
  const { app } = mount({
    registry: {
      ...testHooks().registry,
      stage: async () => {
        throw new Error('no registry entry named "nope"');
      },
    },
  });
  await wait(150);

  await run(app, '/registry add nope');

  const frame = app.lastFrame() ?? '';
  expect(frame).toContain('no registry entry named');
  expect(frame).not.toContain('install skill');

  app.unmount();
}, 20_000);

test('/registry remove reports what it removed', async () => {
  const { app } = mount({
    registry: { ...testHooks().registry, remove: async (name) => `removed skill ${name}` },
  });
  await wait(150);

  await run(app, '/registry remove migration');
  expect(app.lastFrame()).toContain('removed skill migration');

  app.unmount();
}, 20_000);

test('/registry installed shows what is already here', async () => {
  const { app } = mount({
    registry: { ...testHooks().registry, installed: async () => [rows[1]!] },
  });
  await wait(150);

  await run(app, '/registry installed');

  const frame = app.lastFrame() ?? '';
  expect(frame).toContain('no-secrets');
  expect(frame).toContain('1 from the registry');

  app.unmount();
}, 20_000);

test('esc dismisses the registry panel', async () => {
  const { app } = mount({ registry: { ...testHooks().registry, list: async () => rows } });
  await wait(150);

  await run(app, '/registry');
  expect(app.lastFrame()).toContain('migration');

  app.stdin.write('\u001B');
  await wait(300);
  expect(app.lastFrame()).not.toContain('S skill  P plugin');

  app.unmount();
}, 20_000);
