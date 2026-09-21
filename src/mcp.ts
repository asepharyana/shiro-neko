import { createMCPClient, type MCPClient } from '@ai-sdk/mcp';
import { Experimental_StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';

export type McpServerConfig =
  | ({ command: string; args?: string[]; env?: Record<string, string>; cwd?: string } & { expose?: 'direct' | 'meta' })
  | ({ url: string; type?: 'http' | 'sse'; headers?: Record<string, string> } & { expose?: 'direct' | 'meta' });

/**
 * How a server's tools reach the model.
 *
 * `eager` registers every tool with its schema up front — cheap for a two-tool
 * server, a tax for one that exposes twenty. `lazy` registers only the three
 * meta-tools below and fetches a server's tools on demand via `mcp_call`, so a
 * configured server costs almost nothing in the request until a tool is actually
 * invoked.
 */
export type McpMode = 'eager' | 'lazy';

export type McpHandle = {
  /** Live clients keyed by server name — only for servers that connected. */
  clients: Map<string, MCPClient>;
  /** Original configs for /mcp display and prompt. */
  configs: Record<string, McpServerConfig>;
  /** Tools to merge into the session: direct mcp__* + 3 meta tools when any server exists. */
  tools: ToolSet;
  errors: { server: string; message: string }[];
  /** Server names, for the prompt's MCP line. Empty when the mode is eager. */
  servers: string[];
  close: () => Promise<void>;
};

const isRemote = (c: McpServerConfig): c is Extract<McpServerConfig, { url: string }> => 'url' in c;
const isDirect = (c: McpServerConfig) => (c as { expose?: string }).expose === 'direct';

function textOf(result: unknown): string {
  if (!result || typeof result !== 'object') return JSON.stringify(result);
  const r = result as { content?: Array<{ type: string; text?: string; [k: string]: unknown }>; [k: string]: unknown };
  if (Array.isArray(r.content)) {
    const parts = r.content.map((c) => (typeof c.text === 'string' ? c.text : JSON.stringify(c))).join('\n');
    if (parts.trim()) return parts;
  }
  return JSON.stringify(result, null, 2);
}

type ListToolsResult = Awaited<ReturnType<MCPClient['listTools']>>;

const toolCache = new WeakMap<McpHandle, Map<string, ListToolsResult>>();
let guardGetter: WeakMap<McpHandle, () => { guard: (a: { toolName: string; input: unknown; cwd: string }) => string | Promise<string | undefined> | undefined } | undefined> = new WeakMap();
let cwdGetter: WeakMap<McpHandle, () => string> = new WeakMap();

export function bindMcpGuard(
  handle: McpHandle,
  getHost: () => { guard: (a: { toolName: string; input: unknown; cwd: string }) => string | Promise<string | undefined> | undefined } | undefined,
  getCwd: () => string = () => process.cwd(),
): void {
  guardGetter.set(handle, getHost);
  cwdGetter.set(handle, getCwd);
}

async function cachedList(handle: McpHandle, server: string): Promise<ListToolsResult> {
  const cache = toolCache.get(handle);
  if (cache?.has(server)) return cache.get(server)!;
  const client = handle.clients.get(server);
  if (!client) throw new Error(`No MCP server named "${server}". Available: ${[...handle.clients.keys()].join(', ') || 'none'}`);
  const defs = await client.listTools();
  cache?.set(server, defs);
  return defs;
}

export function createMcpMetaTools(handle: McpHandle): ToolSet {
  const mcp_list = tool({
    description: 'List MCP servers, or the tools one server exposes. Use it to discover what an MCP server can do before calling. No schemas are in the prompt until you ask.',
    inputSchema: z.object({ server: z.string().optional().describe('Server name to list tools for. Omit to list all servers.') }),
    execute: async ({ server }: { server?: string }) => {
      if (server) {
        const defs = await cachedList(handle, server);
        const tools = (defs as { tools?: Array<{ name: string; description?: string }> }).tools ?? [];
        if (tools.length === 0) return `Server "${server}" has no tools.`;
        return tools.map((t) => `- ${t.name}: ${t.description ?? '(no description)'}`).join('\n');
      }
      const names = Object.keys(handle.configs);
      if (names.length === 0) return 'No MCP servers configured.';
      const lines: string[] = [];
      for (const name of names) {
        if (handle.clients.has(name)) {
          try {
            const defs = await cachedList(handle, name);
            const tools = (defs as { tools?: Array<{ name: string }> }).tools ?? [];
            lines.push(`- ${name}: ${tools.length} tools — ${tools.map((t) => t.name).join(', ') || '(none)'} — use mcp_inspect for schemas, mcp_call to run`);
          } catch (e) {
            lines.push(`- ${name}: error listing tools — ${(e as Error).message}`);
          }
        } else {
          const err = handle.errors.find((x) => x.server === name);
          lines.push(`- ${name}: not connected${err ? ` — ${err.message}` : ''}`);
        }
      }
      return lines.join('\n');
    },
  });

  const mcp_inspect = tool({
    description: 'Show the JSON input schema for one MCP tool so you can call it correctly. Call mcp_list first if you do not know the tool name.',
    inputSchema: z.object({ server: z.string().describe('Server name'), tool: z.string().describe('Tool name on that server') }),
    execute: async ({ server, tool: toolName }: { server: string; tool: string }) => {
      const defs = await cachedList(handle, server);
      const tools = (defs as { tools?: Array<{ name: string; description?: string; inputSchema?: unknown }> }).tools ?? [];
      const found = tools.find((t) => t.name === toolName);
      if (!found) throw new Error(`No tool "${toolName}" on server "${server}". Available: ${tools.map((t) => t.name).join(', ') || 'none'}`);
      return JSON.stringify({ name: found.name, description: found.description ?? '', inputSchema: (found as { inputSchema?: unknown }).inputSchema ?? {} }, null, 2);
    },
  });

  const mcp_call = tool({
    description: 'Call an MCP tool by server and name. Discover it first with mcp_list then mcp_inspect for its arguments. Calls go through the same permission guard as a built-in.',
    inputSchema: z.object({
      server: z.string().describe('Server name'),
      tool: z.string().describe('Tool name on that server'),
      arguments: z.record(z.string(), z.unknown()).optional().describe('Arguments for the tool, matching its inputSchema'),
    }),
    execute: async ({ server, tool: toolName, arguments: args }: { server: string; tool: string; arguments?: Record<string, unknown> }) => {
      const input = args ?? {};
      const getHost = guardGetter.get(handle);
      const getCwd = cwdGetter.get(handle);
      const host = getHost?.();
      const cwd = getCwd?.() ?? process.cwd();
      if (host) {
        const blocked = await host.guard({ toolName: `mcp__${server}__${toolName}`, input, cwd });
        if (blocked) throw new Error(blocked as string);
      }
      const client = handle.clients.get(server);
      if (!client) {
        const err = handle.errors.find((e) => e.server === server);
        throw new Error(err ? `Server "${server}" failed to connect: ${err.message}` : `No MCP server named "${server}". Available: ${[...handle.clients.keys()].join(', ') || 'none'}`);
      }
      try {
        const defs = await cachedList(handle, server);
        const tools = (defs as { tools?: Array<{ name: string }> }).tools ?? [];
        if (!tools.some((t) => t.name === toolName)) throw new Error(`No tool "${toolName}" on server "${server}". Available: ${tools.map((t) => t.name).join(', ') || 'none'}`);
      } catch (e) {
        if ((e as Error).message.startsWith('No tool')) throw e;
      }
      const result = await client.callTool({ name: toolName, arguments: input });
      return textOf(result);
    },
  });

  return { mcp_list, mcp_inspect, mcp_call };
}

/**
 * Connects every configured server. Servers marked `expose: 'direct'` register
 * their tools as `mcp__<server>__<tool>` directly; all others are accessed
 * through the 3 meta-tools so their schemas cost nothing until used.
 * A server that fails to start is reported, never fatal.
 */
export async function connectMcp(
  servers: Record<string, McpServerConfig>,
  mode: McpMode = 'lazy',
): Promise<McpHandle> {
  const clients = new Map<string, MCPClient>();
  const tools: ToolSet = {};
  const errors: McpHandle['errors'] = [];

  await Promise.all(
    Object.entries(servers).map(async ([name, cfg]) => {
      try {
        const client = await createMCPClient({
          transport: isRemote(cfg)
            ? { type: cfg.type ?? 'http', url: cfg.url, ...(cfg.headers ? { headers: cfg.headers } : {}) }
            : new Experimental_StdioMCPTransport({
                command: cfg.command,
                ...(cfg.args ? { args: cfg.args } : {}),
                ...(cfg.env ? { env: cfg.env } : {}),
                ...(cfg.cwd ? { cwd: cfg.cwd } : {}),
              }),
        });
clients.set(name, client);
        if (mode === 'eager' || isDirect(cfg)) {
          for (const [toolName, t] of Object.entries(await client.tools())) {
            tools[`mcp__${name}__${toolName}`] = t;
          }
        }
      } catch (e) {
        errors.push({ server: name, message: e instanceof Error ? e.message : String(e) });
      }
    }),
  );

const handle: McpHandle = {
    clients,
    configs: servers,
    tools,
    errors,
    servers: mode === 'eager' ? [] : [...clients.keys()],
    close: async () => {
      await Promise.all([...clients.values()].map((c) => c.close().catch(() => {})));
    },
  };
  toolCache.set(handle, new Map());

  const hasAnyServer = Object.keys(servers).length > 0;
  // The three meta-tools are always registered: a session with servers whose
  // connection failed can still call mcp_list and be told why, and a direct
  // server's own tools land alongside them.
  const meta = createMcpMetaTools(handle);
  Object.assign(tools, meta);
  if (hasAnyServer) {
    Object.defineProperty(tools, '__mcpServerNames', { value: Object.keys(servers), enumerable: false, writable: true, configurable: true });
  }

  return handle;
}
