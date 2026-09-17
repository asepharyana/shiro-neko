import { createMCPClient, type MCPClient } from '@ai-sdk/mcp';
import { Experimental_StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';

export type McpServerConfig =
  | { command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
  | { url: string; type?: 'http' | 'sse'; headers?: Record<string, string> };

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
  tools: ToolSet;
  errors: { server: string; message: string }[];
  /** Server names, for the prompt's MCP line. Empty when the mode is eager. */
  servers: string[];
  close: () => Promise<void>;
};

const isRemote = (c: McpServerConfig): c is Extract<McpServerConfig, { url: string }> => 'url' in c;

/**
 * Connects every configured server and exposes its tools.
 *
 * In `eager` mode the tools land in the returned set as `mcp__<server>__<tool>`, so
 * two servers exposing `search` cannot silently shadow each other. In `lazy` mode the
 * set holds only the three meta-tools and `servers` names the configured servers; a
 * server that fails to start is reported, never fatal, in either mode.
 */
export async function connectMcp(
  servers: Record<string, McpServerConfig>,
  mode: McpMode = 'lazy',
): Promise<McpHandle> {
  const clients: MCPClient[] = [];
  const byName = new Map<string, MCPClient>();
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
        clients.push(client);
        byName.set(name, client);
      } catch (e) {
        errors.push({ server: name, message: e instanceof Error ? e.message : String(e) });
      }
    }),
  );

  return {
    tools: mode === 'eager' ? await eagerTools(byName) : lazyTools(byName),
    errors,
    servers: mode === 'eager' ? [] : [...byName.keys()],
    close: async () => {
      await Promise.all(clients.map((c) => c.close().catch(() => {})));
    },
  };
}

/** Eager: every server tool gets an AI tool registered with its schema. */
async function eagerTools(byName: Map<string, MCPClient>): Promise<ToolSet> {
  const tools: ToolSet = {};
  await Promise.all(
    [...byName.entries()].map(async ([name, client]) => {
      for (const [toolName, t] of Object.entries(await client.tools())) {
        tools[`mcp__${name}__${toolName}`] = t;
      }
    }),
  );
  return tools;
}

/**
 * Cache of each client's AI tools, so `mcp_call` does not re-list on every call.
 * The WeakMap drops entries when a client (and its session) is closed and collected.
 */
const clientToolsCache = new WeakMap<MCPClient, ToolSet>();

/** Fetches a server's AI tools, or returns the cached set from a prior call. */
async function cachedClientTools(client: MCPClient): Promise<ToolSet> {
  const cached = clientToolsCache.get(client);
  if (cached) return cached;
  const tools = await client.tools();
  clientToolsCache.set(client, tools);
  return tools;
}

/**
 * Lazy: three meta-tools instead of every server schema.
 *
 * `mcp_list` names a server's tools from their definitions (cheap, no schema).
 * `mcp_inspect` reads one tool's schema so the model knows its inputs.
 * `mcp_call` executes one tool on its server, making the server's tools available
 * only from the moment they are actually invoked.
 */
function lazyTools(byName: Map<string, MCPClient>): ToolSet {
  const connectionError = (name: string) =>
    byName.has(name) ? undefined : `unknown server "${name}". Configured: ${[...byName.keys()].join(', ') || 'none'}`;

  return {
    mcp_list: tool({
      description: `List the tools exposed by an MCP server. Servers: ${[...byName.keys()].join(', ') || 'none'}.`,
      inputSchema: z.object({ server: z.string().describe('Server name from your instructions') }),
      execute: async ({ server }) => {
        const err = connectionError(server);
        if (err) throw new Error(err);
        const client = byName.get(server)!;
        const defs = await client.listTools();
        return defs.tools.length === 0
          ? `server "${server}" exposes no tools`
          : defs.tools.map((d) => `- ${d.name}: ${d.description ?? 'no description'}`).join('\n');
      },
    }),
    mcp_inspect: tool({
      description: `Inspect one tool's input schema on an MCP server. Servers: ${[...byName.keys()].join(', ') || 'none'}.`,
      inputSchema: z.object({
        server: z.string().describe('Server name from your instructions'),
        toolName: z.string().describe('Tool name, as listed by mcp_list'),
      }),
      execute: async ({ server, toolName }) => {
        const err = connectionError(server);
        if (err) throw new Error(err);
        const client = byName.get(server)!;
        const defs = await client.listTools();
        const def = defs.tools.find((d) => d.name === toolName);
        if (!def) throw new Error(`No tool "${toolName}" on "${server}". List first with mcp_list.`);
        return def.inputSchema ? JSON.stringify(def.inputSchema, null, 2) : `tool "${toolName}" declares no input schema`;
      },
    }),
    mcp_call: tool({
      description:
        `Call one tool on an MCP server. Inspect its schema with mcp_inspect first. ` +
        `Servers: ${[...byName.keys()].join(', ') || 'none'}.`,
      inputSchema: z.object({
        server: z.string().describe('Server name from your instructions'),
        toolName: z.string().describe('Tool name, as listed by mcp_list'),
        args: z.record(z.string(), z.unknown()).describe('Arguments the tool expects, from mcp_inspect'),
      }),
      execute: async ({ server, toolName, args }) => {
        const err = connectionError(server);
        if (err) throw new Error(err);
        const client = byName.get(server)!;
        const serverTools = await cachedClientTools(client);
        const aiTool = serverTools[toolName];
        if (!aiTool)
          throw new Error(
            `No tool "${toolName}" on "${server}". List first with mcp_list (server exposes: ${Object.keys(serverTools).join(', ') || 'none'}).`,
          );
        return aiTool.execute!(args, { toolCallId: 'mcp_call', messages: [] } as never);
      },
    }),
  };
}
