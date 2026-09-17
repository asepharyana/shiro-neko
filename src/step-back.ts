import { tool } from 'ai';
import { z } from 'zod';

/**
 * A visible escape hatch for the loop a coding agent dies in.
 *
 * The repeat guard stops an *identical* call after three tries, but the deeper loop
 * is the model making *different* calls that all amount to the same stalled attempt —
 * re-reading the same file expecting a different answer, retrying a failing command
 * with a tweaked flag, re-sending a prompt it has already asked. No equal-input
 * detector fires on any of that, so the model burns the step budget on motions that
 * never move.
 *
 * `step_back` exists so the model has a *named* way out instead of only a guard it
 * cannot see. The session records each completed tool call (input + outcome) into a
 * loop trace; the tool returns a scripted reflection prompt built from that trace,
 * so the model is told in concrete terms that it is going in circles and is steered
 * to change direction.
 */

export type LoopEntry = {
  step: number;
  toolName: string;
  input: string;
  result: string;
  at: string;
};

function recentTrace(entries: readonly LoopEntry[], window = 8): LoopEntry[] {
  return entries.slice(-window);
}

function renderTrace(entries: readonly LoopEntry[], maxLines = 12): string {
  return entries.slice(-maxLines).map((e) => `step ${e.step}: ${e.toolName} ${e.input} -> ${e.result}`.slice(0, 200)).join('\n');
}

/**
 * Builds a `step_back` tool bound to a session's loop trace.
 *
 * The tool is meant to be called when the model is not making progress — a trap it
 * cannot always see while it is inside it. The returned reflection names the recent
 * steps so the model can tell, from its own calls, that it is going in circles, and
 * gives it the one thing a stuck agent is usually missing: permission to stop,
 * say what it learned, and change direction rather than try harder.
 */
export function createStepBackTool(opts: { trace: () => readonly LoopEntry[] }) {
  return tool({
    description:
      'Use when you are stuck: the same file is not changing, a command keeps failing, or you have done several steps with no visible progress. ' +
      'Records your recent steps and returns a reflection prompt to help you change direction instead of repeating the attempt.',
    inputSchema: z.object({
      note: z.string().optional().describe('A sentence in your own words about what you were trying to do.'),
    }),
    execute: async ({ note }) => {
      const trace = recentTrace(opts.trace());
      if (trace.length === 0) {
        return (
          'No recent steps to reflect on. This is an early call of step_back — it is only useful when you have ' +
          'attempted something several times. Describe what you are stuck on in `note`.'
        );
      }

      return [
        'You have run threadbare over the last steps and are stuck. Here is what you actually did:',
        '```',
        renderTrace(trace),
        '```',
        '',
        'Before your next tool call, answer these three questions in your reasoning:',
        '1. What exactly is wrong — the input, the tool, or the expectation?',
        '2. What have you tried, and why did each fail?',
        '3. What is ONE different thing you can do that is not "try the same thing a little harder"?',
        '',
        'Then take that different action. If the failure is a command, read the actual error and fix its cause — ',
        'do not rerun the command. If a file is not what you expect, suspect your assumption about it and re-read it fresh.',
        note?.trim() ? `\nYour note: ${note.trim()}` : '',
      ].join('\n');
    },
  });
}