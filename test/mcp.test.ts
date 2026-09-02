import { expect, test } from 'bun:test';
import type { ToolSet } from 'ai';
import { join } from 'node:path';
import { connectMcp } from '../src/mcp';

const STUB = join(import.meta.dir, 'fixtures', 'mcp-stub.ts');

const stdioServer = () => ({ command: process.execPath, args: ['run', STUB] });

/** MCP tools are dynamic, so their input type is only known at runtime. */
const call = async (tools: ToolSet, name: string, input: Record<string, unknown>) => {
  const tool = tools[name];
  if (!tool?.execute) throw new Error(`tool ${name} is not executable`);
  return tool.execute(input as never, { toolCallId: 'x', messages: [] } as never);
};

test('a stdio server contributes its tools under an mcp__ namespace', async () => {
  const mcp = await connectMcp({ stub: stdioServer() });
  try {
    expect(Object.keys(mcp.tools).sort()).toEqual(['mcp__stub__ping', 'mcp__stub__search']);
    expect(mcp.errors).toEqual([]);
  } finally {
    await mcp.close();
  }
}, 30_000);

test('an mcp tool actually executes against the server', async () => {
  const mcp = await connectMcp({ stub: stdioServer() });
  try {
    const out = await call(mcp.tools, 'mcp__stub__ping', { note: 'hello' });
    expect(JSON.stringify(out)).toContain('pong: hello');
  } finally {
    await mcp.close();
  }
}, 30_000);

test('two servers exposing the same tool name do not shadow each other', async () => {
  const mcp = await connectMcp({ a: stdioServer(), b: stdioServer() });
  try {
    expect(Object.keys(mcp.tools).sort()).toEqual([
      'mcp__a__ping',
      'mcp__a__search',
      'mcp__b__ping',
      'mcp__b__search',
    ]);
  } finally {
    await mcp.close();
  }
}, 30_000);

test('a server that fails to start is reported, not fatal', async () => {
  const mcp = await connectMcp({
    ok: stdioServer(),
    broken: { command: 'definitely-not-a-real-binary-xyz' },
  });
  try {
    expect(Object.keys(mcp.tools)).toEqual(['mcp__ok__ping', 'mcp__ok__search']);
    expect(mcp.errors.map((e) => e.server)).toEqual(['broken']);
    expect(mcp.errors[0]?.message).toBeTruthy();
  } finally {
    await mcp.close();
  }
}, 30_000);

test('no configured servers yields no tools and no errors', async () => {
  const mcp = await connectMcp({});
  expect(mcp.tools).toEqual({});
  expect(mcp.errors).toEqual([]);
  await mcp.close();
});

test('close is safe to call twice', async () => {
  const mcp = await connectMcp({ stub: stdioServer() });
  await mcp.close();
  await mcp.close();
});

test('an http server config is attempted and its failure reported', async () => {
  const mcp = await connectMcp({ remote: { url: 'http://127.0.0.1:1/mcp', type: 'http' } });
  expect(Object.keys(mcp.tools)).toEqual([]);
  expect(mcp.errors.map((e) => e.server)).toEqual(['remote']);
  await mcp.close();
}, 30_000);
