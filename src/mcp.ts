import { createMCPClient, type MCPClient } from '@ai-sdk/mcp';
import { Experimental_StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
import type { ToolSet } from 'ai';

export type McpServerConfig =
  | { command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
  | { url: string; type?: 'http' | 'sse'; headers?: Record<string, string> };

export type McpHandle = {
  tools: ToolSet;
  errors: { server: string; message: string }[];
  close: () => Promise<void>;
};

const isRemote = (c: McpServerConfig): c is Extract<McpServerConfig, { url: string }> => 'url' in c;

/**
 * Connects every configured server and namespaces its tools as `mcp__<server>__<tool>`
 * so two servers exposing `search` cannot silently shadow each other.
 * A server that fails to start is reported, never fatal.
 */
export async function connectMcp(servers: Record<string, McpServerConfig>): Promise<McpHandle> {
  const clients: MCPClient[] = [];
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
        clients.push(client);
        for (const [toolName, tool] of Object.entries(await client.tools())) {
          tools[`mcp__${name}__${toolName}`] = tool;
        }
      } catch (e) {
        errors.push({ server: name, message: e instanceof Error ? e.message : String(e) });
      }
    }),
  );

  return {
    tools,
    errors,
    close: async () => {
      await Promise.all(clients.map((c) => c.close().catch(() => {})));
    },
  };
}
