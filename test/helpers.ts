import { simulateReadableStream } from 'ai/test';
import type {
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
  LanguageModelV4Usage,
} from '@ai-sdk/provider';
import type { AppHooks } from '../src/ui/App';

/**
 * A `usage` chunk for `simulateReadableStream`, typed so the cast goes away.
 *
 * The same object was copied verbatim into 17 test files with `as any`, one per
 * stream finish. This builds the real `LanguageModelV4Usage` shape with the
 * numbers a test cares about and the cache fields zeroed.
 */
export function usageOf(input: number, output = 1): LanguageModelV4Usage {
  return {
    inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: output, text: output, reasoning: 0 },
  };
}

/**
 * A `doStream` return value built from `simulateReadableStream` chunks.
 *
 * Written out as `{ stream: simulateReadableStream(...) } as any` in most UI test
 * files, because the SDK's `ReadableStream` and `simulateReadableStream`'s type do
 * not unify. This is the one place that difference is absorbed.
 */
export function streamOf(chunks: LanguageModelV4StreamPart[]): LanguageModelV4StreamResult {
  return {
    stream: simulateReadableStream({
      chunks,
      chunkDelayInMs: null,
      initialDelayInMs: null,
    }),
  } as unknown as LanguageModelV4StreamResult;
}

/** The text and finish chunks that make a stream say one thing and stop. */
export function textChunks(body: string, usage: LanguageModelV4Usage = usageOf(1)): LanguageModelV4StreamPart[] {
  return [
    { type: 'text-start', id: '0' },
    { type: 'text-delta', id: '0', delta: body },
    { type: 'text-end', id: '0' },
    { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
  ];
}

/**
 * A `doGenerate` return value. `warnings` is required by the SDK type but empty in
 * every test, so it is filled here rather than repeated at each call site.
 */
export function generateResult(body: string, usage: LanguageModelV4Usage = usageOf(1)): LanguageModelV4GenerateResult {
  return {
    content: [{ type: 'text', text: body }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage,
    warnings: [],
  };
}

/** Default AppHooks for UI tests; override only what a test cares about. */
export function testHooks(over: Partial<AppHooks> = {}): AppHooks {
  return {
    sessionId: 'test1234',
    config: () => ({ provider: 'openai', model: 'gpt-5' }),
    switchModel: (id) => `model is now ${id}`,
    switchAgent: (name) => `agent is now ${name}`,
    switchThinking: (level) => `thinking is now ${level}`,
    agentName: () => 'default',
    thinkingLevel: () => 'medium',
    applyProvider: async () => 'configured',
    listModels: async () => ({ models: [] }),
    listSessions: async () => 'no saved sessions',
    listSkills: () => 'no skills loaded',
    listPlugins: () => 'no plugins active',
    listMemory: async () => 'nothing remembered yet',
    summarizeMemory: async () => 'nothing to compact',
    resumeSession: async () => 'resumed',
    saveSession: async () => 'saved',
    instructionFiles: () => [],
    listPaths: async () => [],
    registry: {
      list: async () => [],
      installed: async () => [],
      stage: async () => {
        throw new Error('no registry in tests unless a test provides one');
      },
      install: async () => 'installed',
      remove: async () => 'removed',
    },
    mcp: {
      names: () => [],
      list: () => 'no mcp servers configured',
      add: async (result) => `added ${result.name}`,
      remove: async (name) => `removed ${name}`,
    },
    initPrompt: 'write AGENTS.md',
    history: [],
    recordPrompt: () => {},
    ...over,
  };
}
