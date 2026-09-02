import { isStepCount, streamText, tool, type LanguageModel, type ToolSet } from 'ai';
import { z } from 'zod';
import { globTool, grepTool, readFileTool } from './tools';

export type SubagentKind = 'explore' | 'review';

export type SubagentEvent =
  | { type: 'start'; id: string; kind: SubagentKind; description: string }
  | { type: 'step'; id: string; tool: string; summary: string }
  | { type: 'end'; id: string; ok: boolean; steps: number }
  | { type: 'error'; id: string; message: string };

export type SubagentReporter = (event: SubagentEvent) => void;

const READ_ONLY: ToolSet = { read_file: readFileTool, glob: globTool, grep: grepTool };

const PROMPTS: Record<SubagentKind, (cwd: string) => string> = {
  explore: (cwd) => `You are a research subagent inside a coding agent.

Workspace root: ${cwd}
Tools: read_file, glob, grep. You cannot write files, run commands, or ask questions.

Find what was asked and report once. Rules:
- Give file paths with line numbers, plus a short quote where the quote is the answer.
- Report what you actually read. If you could not determine something, say so; do not fill the gap.
- No preamble, no restating the task, no offers of further help.
- Aim for under 30 lines. The parent agent pays for every line you write.`,

  review: (cwd) => `You are a review subagent inside a coding agent.

Workspace root: ${cwd}
Tools: read_file, glob, grep. You cannot write files, run commands, or ask questions.

Review what was asked and report once. Severity order: incorrect behaviour, missing validation at
trust boundaries, security, resource handling, then clarity. For each finding give file, line, what
breaks, and the fix. Say plainly when something is correct. Do not invent findings to look thorough.`,
};

const summarize = (input: unknown): string => {
  if (input === null || typeof input !== 'object') return String(input);
  const o = input as Record<string, unknown>;
  const first = o['pattern'] ?? o['path'] ?? o['include'];
  return typeof first === 'string' ? first : JSON.stringify(o).slice(0, 80);
};

let counter = 0;

/**
 * Read-only child agent.
 *
 * It runs its own tool loop and returns one message, so the parent pays for the
 * findings rather than the whole search transcript. No write, bash, or ask tool is
 * passed in, which is also why a subagent can never trigger an approval prompt.
 */
export function createTaskTool(opts: {
  model: LanguageModel;
  cwd?: string;
  maxSteps?: number;
  report?: SubagentReporter;
}) {
  return tool({
    description:
      'Delegate a read-only investigation to a subagent that can read, glob, and grep. Use it for questions ' +
      'spanning many files ("where is auth handled", "every caller of X") and to keep a long search out of your ' +
      'own context. The subagent sees none of this conversation, so its prompt must be self-contained. ' +
      'It returns one text report. Do not delegate something you can answer with a single grep.',
    inputSchema: z.object({
      description: z.string().describe('Short label shown to the user, 3-6 words'),
      prompt: z.string().describe('Self-contained instructions: what to find, where to look, what to return'),
      kind: z
        .enum(['explore', 'review'])
        .optional()
        .describe('explore: find and report. review: critique code for defects. Default explore.'),
    }),
    execute: async ({ description, prompt, kind }, { abortSignal }) => {
      const id = `sub${++counter}`;
      const flavour: SubagentKind = kind ?? 'explore';
      const report = opts.report;
      report?.({ type: 'start', id, kind: flavour, description });

      let steps = 0;
      let text = '';

      try {
        const result = streamText({
          model: opts.model,
          system: PROMPTS[flavour](opts.cwd ?? process.cwd()),
          messages: [{ role: 'user', content: prompt }],
          tools: READ_ONLY,
          stopWhen: isStepCount(opts.maxSteps ?? 20),
          ...(abortSignal ? { abortSignal } : {}),
        });

        const sink = () => {};
        void result.responseMessages.then(undefined, sink);
        void result.usage.then(undefined, sink);
        void result.steps.then(undefined, sink);
        void result.finalStep.then(undefined, sink);
        void result.finishReason.then(undefined, sink);

        for await (const part of result.stream) {
          if (part.type === 'tool-call') {
            steps++;
            report?.({ type: 'step', id, tool: part.toolName, summary: summarize(part.input) });
          } else if (part.type === 'text-delta') {
            text += part.text;
          } else if (part.type === 'error') {
            // A provider failure arrives as a stream part, not a throw, so it has to
            // be rethrown here or the subagent silently returns nothing.
            const message = part.error instanceof Error ? part.error.message : String(part.error);
            throw part.error instanceof Error ? part.error : new Error(message);
          }
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        report?.({ type: 'error', id, message });
        throw e;
      }

      const trimmed = text.trim();
      report?.({ type: 'end', id, ok: trimmed.length > 0, steps });
      return trimmed || 'Subagent returned no findings.';
    },
  });
}

export const TASK_TOOL_NAME = 'task';
