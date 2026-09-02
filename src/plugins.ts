import type { ToolSet } from 'ai';

export type ToolCallContext = {
  toolName: string;
  input: unknown;
  cwd: string;
};

/** Returning a string blocks the call; the string is handed to the model as the reason. */
export type BeforeToolCall = (ctx: ToolCallContext) => string | undefined | Promise<string | undefined>;

export type Plugin = {
  name: string;
  description: string;
  /** Extra tools contributed by this plugin. */
  tools?: ToolSet;
  /** Tool names that should never prompt for approval. */
  autoApprove?: readonly string[];
  beforeToolCall?: BeforeToolCall;
  afterTurn?: () => void | Promise<void>;
  /** Text appended to the system prompt. */
  appendix?: string;
};

export type PluginHost = {
  plugins: Plugin[];
  tools: ToolSet;
  autoApprove: string[];
  appendix: string;
  /** Runs every beforeToolCall hook; the first block wins. */
  guard: BeforeToolCall;
  afterTurn: () => Promise<void>;
  errors: { plugin: string; message: string }[];
};

export function createHost(plugins: Plugin[], errors: PluginHost['errors'] = []): PluginHost {
  const tools: ToolSet = {};
  const autoApprove: string[] = [];
  const appendices: string[] = [];

  for (const p of plugins) {
    for (const [name, t] of Object.entries(p.tools ?? {})) tools[name] = t;
    autoApprove.push(...(p.autoApprove ?? []));
    if (p.appendix) appendices.push(p.appendix);
  }

  return {
    plugins,
    tools,
    autoApprove,
    appendix: appendices.length > 0 ? `\n${appendices.join('\n')}` : '',
    errors,
    guard: async (ctx) => {
      for (const p of plugins) {
        if (!p.beforeToolCall) continue;
        try {
          const blocked = await p.beforeToolCall(ctx);
          if (blocked) return `Blocked by the ${p.name} plugin: ${blocked}`;
        } catch (e) {
          // A broken hook must not take the agent down, but it must not silently
          // allow the call either: treat a throwing guard as a block.
          return `The ${p.name} plugin failed while checking this call: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
      return undefined;
    },
    afterTurn: async () => {
      for (const p of plugins) {
        try {
          await p.afterTurn?.();
        } catch {
          continue;
        }
      }
    },
  };
}
