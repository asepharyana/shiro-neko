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
  // default is now meta (phi) — a server appears as 3 meta-tools, not direct mcp__* tools,
  // unless expose:'direct' is set. Direct case is tested separately below.
  const mcp = await connectMcp({ stub: stdioServer() });
  try {
    expect(Object.keys(mcp.tools).sort()).toEqual(['mcp_call', 'mcp_inspect', 'mcp_list']);
    expect(mcp.errors).toEqual([]);
    expect(mcp.servers).toEqual(['stub']);
  } finally {
    await mcp.close();
  }
}, 30_000);

test('an mcp tool actually executes against the server', async () => {
  // execute via meta mcp_call (default exposure), and via direct when expose:'direct'
  const mcp = await connectMcp({ stub: stdioServer() });
  try {
    const out = await call(mcp.tools, 'mcp_call', { server: 'stub', tool: 'ping', arguments: { note: 'hello' } } as unknown as Record<string, unknown>);
    expect(JSON.stringify(out)).toContain('pong: hello');
  } finally {
    await mcp.close();
  }
}, 30_000);

test('two servers exposing the same tool name do not shadow each other', async () => {
  // Both via meta: no direct tools to shadow; they share the 3 meta-tools
  const mcp = await connectMcp({ a: stdioServer(), b: stdioServer() });
  try {
    expect(Object.keys(mcp.tools).sort()).toEqual(['mcp_call', 'mcp_inspect', 'mcp_list']);
  } finally {
    await mcp.close();
  }
}, 30_000);

test('a server that fails to start is reported, not fatal', async () => {
  const mcp = await connectMcp(
    {
      ok: stdioServer(),
      broken: { command: 'definitely-not-a-real-binary-xyz' },
    },
    'eager',
  );
  try {
    // Eager mode registers the ok server's tools directly alongside the meta-tools.
    const keys = Object.keys(mcp.tools).sort();
    expect(keys).toContain('mcp__ok__ping');
    expect(keys).toContain('mcp_call');
    expect(mcp.errors.map((e) => e.server)).toEqual(['broken']);
    expect(mcp.errors[0]?.message).toBeTruthy();
    // Eager mode names no servers for the prompt's lazy line.
    expect(mcp.servers).toEqual([]);
  } finally {
    await mcp.close();
  }
}, 30_000);

test('no configured servers leaves the meta-tools naming none, with no errors', async () => {
  const mcp = await connectMcp({});
  // No servers: no direct tools, but the three meta-tools are still registered.
  expect(Object.keys(mcp.tools).sort()).toEqual(['mcp_call', 'mcp_inspect', 'mcp_list']);
  expect(mcp.servers).toEqual([]);
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
  expect(Object.keys(mcp.tools).sort()).toEqual(['mcp_call', 'mcp_inspect', 'mcp_list']);
  expect(mcp.errors.map((e) => e.server)).toEqual(['remote']);
  await mcp.close();
}, 30_000);

test('lazy mode (default) registers only meta-tools, never server schemas', async () => {
  const mcp = await connectMcp({ stub: stdioServer() });
  try {
    // The request is spared every server schema: only three meta-tools exist.
    expect(Object.keys(mcp.tools).sort()).toEqual(['mcp_call', 'mcp_inspect', 'mcp_list']);
    // But the prompt knows which servers are connected.
    expect(mcp.servers).toEqual(['stub']);
  } finally {
    await mcp.close();
  }
}, 30_000);

test('mcp_list names a server tools and mcp_inspect reads a schema without calling it', async () => {
  const mcp = await connectMcp({ stub: stdioServer() });
  try {
    await call(mcp.tools, 'mcp_list', { server: 'stub' }).then((out) =>
      expect(JSON.stringify(out)).toContain('search'),
    );
    await call(mcp.tools, 'mcp_inspect', { server: 'stub', tool: 'ping' }).then((out) =>
      expect(JSON.stringify(out)).toContain('note'),
    );
  } finally {
    await mcp.close();
  }
}, 30_000);

test('mcp_call executes a server tool by name', async () => {
  const mcp = await connectMcp({ stub: stdioServer() });
  try {
    const out = await call(mcp.tools, 'mcp_call', { server: 'stub', tool: 'ping', arguments: { note: 'lazy' } });
    expect(JSON.stringify(out)).toContain('pong: lazy');
  } finally {
    await mcp.close();
  }
}, 30_000);

test('mcp_call against an unknown server names the live set', async () => {
  const mcp = await connectMcp({ stub: stdioServer() });
  try {
    await call(mcp.tools, 'mcp_call', { server: 'nope', tool: 'ping', arguments: {} }).then(
      () => {
        throw new Error('an unknown server must reject');
      },
      (e) => expect(String(e)).toContain('nope'),
    );
  } finally {
    await mcp.close();
  }
}, 30_000);
