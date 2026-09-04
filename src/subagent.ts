import { isStepCount, streamText, tool, type LanguageModel, type ToolSet } from 'ai';
import { z } from 'zod';
import {
  applyPatchTool,
  bashTool,
  editFileTool,
  globTool,
  grepTool,
  listDirTool,
  multiEditTool,
  readFileTool,
  readManyFilesTool,
  writeFileTool,
} from './tools';
import { gitTools } from './tools-git';

export type SubagentKind = 'explore' | 'review' | 'worker';

export type SubagentEvent =
  | { type: 'start'; id: string; kind: SubagentKind; description: string }
  | { type: 'step'; id: string; tool: string; summary: string }
  | { type: 'result'; id: string; tool: string; summary: string; ok: boolean }
  | { type: 'end'; id: string; ok: boolean; steps: number }
  | { type: 'error'; id: string; message: string };

export type SubagentReporter = (event: SubagentEvent) => void;

/** A single empty (or nearly empty) report triggers a retry before giving up. */
const MAX_EMPTY_RETRIES = 1;

/**
 * A subagent's approval callback, supplied by the parent.
 *
 * The parent owns the gate. A subagent that could approve its own writes would be
 * a way to launder a tool call past the user, so `worker` routes every gated call
 * back through the same rules and the same prompt as a direct call.
 */
export type SubagentApproval = (req: { toolName: string; input: unknown }) => Promise<boolean>;

const READ_TOOLS: ToolSet = {
  read_file: readFileTool,
  read_many_files: readManyFilesTool,
  glob: globTool,
  grep: grepTool,
  list_dir: listDirTool,
  ...gitTools,
};

/**
 * `worker` adds the mutating tools. Every one of them is gated by the parent, so
 * the extra capability is capability to *ask*, not capability to write unasked.
 */
const WRITE_TOOLS: ToolSet = {
  write_file: writeFileTool,
  edit_file: editFileTool,
  multi_edit: multiEditTool,
  apply_patch: applyPatchTool,
  bash: bashTool,
};

const TOOLS: Record<SubagentKind, ToolSet> = {
  explore: READ_TOOLS,
  review: READ_TOOLS,
  worker: { ...READ_TOOLS, ...WRITE_TOOLS },
};

export const subagentToolNames = (kind: SubagentKind): string[] => Object.keys(TOOLS[kind]);

const PROMPTS: Record<SubagentKind, (cwd: string) => string> = {
  explore: (cwd) => `You are a research subagent inside a coding agent.

Workspace root: ${cwd}
You can read, search, and inspect git history. You cannot write files, run commands, or ask questions.

Find what was asked and report once. Rules:
- Give file paths with line numbers, plus a short quote where the quote is the answer.
- Report what you actually read. If you could not determine something, say so; do not fill the gap.
- No preamble, no restating the task, no offers of further help.
- Aim for under 30 lines. The parent agent pays for every line you write.`,

  review: (cwd) => `You are a review subagent inside a coding agent.

Workspace root: ${cwd}
You can read, search, and inspect git history. You cannot write files, run commands, or ask questions.

Review what was asked and report once. Severity order: incorrect behaviour, missing validation at
trust boundaries, security, resource handling, then clarity. For each finding give file, line, what
breaks, and the fix. Say plainly when something is correct. Do not invent findings to look thorough.`,

  worker: (cwd) => `You are an implementation subagent inside a coding agent.

Workspace root: ${cwd}
You can read, search, edit files, and run commands. Every write and every command is approved by the
user through the parent agent, so a denial is the user's decision: stop and report it, do not work
around it.

You cannot ask questions. If the task is ambiguous, do the smaller reading of it and say in your
report which reading you took and what the alternative was.

Rules:
- Do only what was asked. Do not tidy neighbouring code, rename things, or add abstraction.
- Read before you write. Match the file's existing style rather than inventing one.
- Verify: run the project's tests or build after changing code. "Should work" is not verification.
  Report the actual command and its outcome.
- Report once, and make it a handover: every file you changed with its path, what you ran and what
  it said, and anything you could not finish. The parent cannot see your transcript.`,
};

/** One line of detail for the panel: the argument that identifies the call. */
const summarize = (input: unknown): string => {
  if (input === null || typeof input !== 'object') return String(input);
  const o = input as Record<string, unknown>;
  const first = o['command'] ?? o['path'] ?? o['pattern'] ?? o['ref'] ?? o['include'];
  if (typeof first === 'string') return first.length > 80 ? `${first.slice(0, 80)}...` : first;

  const files = o['files'];
  if (Array.isArray(files)) return `${files.length} file${files.length === 1 ? '' : 's'}`;
  const edits = o['edits'];
  if (Array.isArray(edits)) return `${edits.length} edit${edits.length === 1 ? '' : 's'}`;
  return JSON.stringify(o).slice(0, 80);
};

/** First line of a tool result, so the panel can show an outcome rather than just a call. */
const outcome = (output: unknown): string => {
  const text = typeof output === 'string' ? output : JSON.stringify(output ?? '');
  const line = text.split('\n').find((l) => l.trim().length > 0) ?? '';
  return line.length > 70 ? `${line.slice(0, 70)}...` : line;
};

let counter = 0;

/**
 * Child agent with its own context window.
 *
 * It runs its own tool loop and returns one message, so the parent pays for the
 * findings rather than the whole transcript.
 *
 * `explore` and `review` hold no mutating tool, so they cannot reach the approval
 * gate at all — that is structural, not policy. `worker` does hold them, and every
 * one is routed back through the parent's `approve` callback. Without a callback,
 * `worker` is refused rather than silently downgraded to read-only: a caller that
 * asked for a worker and got an explorer would be told the task failed for the
 * wrong reason.
 */
export function createTaskTool(opts: {
  model: LanguageModel;
  cwd?: string;
  maxSteps?: number;
  report?: SubagentReporter;
  /** Parent-owned approval for a worker's gated calls. Omit to disable `worker`. */
  approve?: SubagentApproval;
}) {
  const canWrite = opts.approve !== undefined;

  return tool({
    description:
      'Delegate work to a subagent with its own context window. It sees none of this conversation, so its ' +
      'prompt must be self-contained, and it returns one text report.\n' +
      'explore: find and report, read-only. review: critique code for defects, read-only.' +
      (canWrite
        ? '\nworker: read, edit, and run commands to carry out a change. Its writes and commands are approved by ' +
          'the user exactly as yours are. Use it for a self-contained task whose intermediate steps you do not ' +
          'need to see; keep work you must supervise step by step in your own turn.'
        : '') +
      '\nDo not delegate something you can answer with a single grep.',
    inputSchema: z.object({
      description: z.string().describe('Short label shown to the user, 3-6 words'),
      prompt: z.string().describe('Self-contained instructions: what to do, where, and what to report'),
      kind: z
        .enum(canWrite ? ['explore', 'review', 'worker'] : ['explore', 'review'])
        .optional()
        .describe(
          canWrite
            ? 'explore: read-only research. review: read-only critique. worker: makes changes. Default explore.'
            : 'explore: find and report. review: critique code for defects. Default explore.',
        ),
    }),
    execute: async ({ description, prompt, kind }, { abortSignal }) => {
      const flavour: SubagentKind = kind ?? 'explore';
      if (flavour === 'worker' && !opts.approve) {
        throw new Error('The worker kind needs an approval channel, which this session has not provided.');
      }

      const id = `sub${++counter}`;
      const report = opts.report;
      report?.({ type: 'start', id, kind: flavour, description });

      const run = async (prompt: string): Promise<{ text: string; steps: number }> => {
        let steps = 0;
        let text = '';

        try {
          const result = streamText({
            model: opts.model,
            system: PROMPTS[flavour](opts.cwd ?? process.cwd()),
            messages: [{ role: 'user', content: prompt }],
            tools: TOOLS[flavour],
            stopWhen: isStepCount(opts.maxSteps ?? 20),
            ...(opts.approve
              ? {
                  toolApproval: async ({ toolCall }: { toolCall: { toolName: string; input: unknown } }) => {
                    const approved = await opts.approve!(toolCall);
                    return approved
                      ? undefined
                      : { type: 'denied' as const, reason: 'The user denied this call. Stop and report it.' };
                  },
                }
              : {}),
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
            } else if (part.type === 'tool-result') {
              report?.({ type: 'result', id, tool: part.toolName, summary: outcome(part.output), ok: true });
            } else if (part.type === 'tool-error') {
              const message = part.error instanceof Error ? part.error.message : String(part.error);
              report?.({ type: 'result', id, tool: part.toolName, summary: outcome(message), ok: false });
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

        return { text: text.trim(), steps };
      };

      let { text: trimmed, steps } = await run(prompt);

      // A completely blank report — no tool steps and no text — is almost always a
      // transient failure (a swallowed stream error or an API hiccup), not a
      // genuine "nothing found". Retry once with an explicit nudge. A run that did
      // real tool work but produced no final answer is not that: retrying it would
      // simply repeat the work, so it is reported as-is.
      for (let retry = 0; retry < MAX_EMPTY_RETRIES && trimmed.length === 0 && steps === 0; retry++) {
        const retryPrompt = `${prompt}\n\nYour previous attempt produced no report. Respond now with what you found, or explicitly state that you found nothing.`;
        report?.({ type: 'result', id, tool: '(retry)', summary: 'previous report was empty; retrying once', ok: true });
        const again = await run(retryPrompt);
        trimmed = again.text;
        steps += again.steps;
      }

      report?.({ type: 'end', id, ok: trimmed.length > 0, steps });
      return trimmed || 'Subagent returned no findings.';
    },
  });
}

export const TASK_TOOL_NAME = 'task';
