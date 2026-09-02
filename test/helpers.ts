import type { AppHooks } from '../src/ui/App';

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
    initPrompt: 'write AGENTS.md',
    history: [],
    recordPrompt: () => {},
    ...over,
  };
}
