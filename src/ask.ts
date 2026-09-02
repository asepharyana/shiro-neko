import { tool } from 'ai';
import { z } from 'zod';

export type AskRequest = {
  question: string;
  options?: { label: string; detail?: string }[];
  multiple: boolean;
};

/** Set by the UI. Absent means nothing can answer, so asking is an error. */
export type AskFn = (req: AskRequest) => Promise<string[] | undefined>;

const MAX_OPTIONS = 8;

/**
 * Lets the model stop and ask rather than guess.
 *
 * Without this a model facing two materially different readings of a request picks
 * one and writes code for it. The cost of a wrong guess is a whole wasted turn plus
 * the user's correction, so one question is almost always cheaper.
 */
export function createAskTool(ask: AskFn | undefined) {
  return tool({
    description:
      'Ask the user a question and wait for the answer. Use it when the request has two or more readings that ' +
      'lead to materially different work, when a required detail is missing, or to confirm an approach before a ' +
      'large change. Offer concrete options when you can; omit them for an open question. ' +
      'Do not use it for things you can determine by reading the code, and do not ask twice about the same thing.',
    inputSchema: z.object({
      question: z.string().describe('One specific question. State what you already know, then what you need.'),
      options: z
        .array(
          z.object({
            label: z.string().describe('Short choice, a few words'),
            detail: z.string().optional().describe('What choosing this implies, including any tradeoff'),
          }),
        )
        .max(MAX_OPTIONS)
        .optional()
        .describe('Concrete choices. Put your recommendation first. Omit for an open question.'),
      multiple: z.boolean().optional().describe('Allow more than one option to be chosen'),
    }),
    execute: async ({ question, options, multiple }) => {
      if (!ask) {
        throw new Error(
          'No one is available to answer: this session is running headless. Decide yourself and state the assumption.',
        );
      }
      const answers = await ask({ question, ...(options ? { options } : {}), multiple: multiple ?? false });
      if (!answers || answers.length === 0) return 'The user dismissed the question without answering. Proceed with your best judgement and say what you assumed.';
      return `The user answered: ${answers.join(', ')}`;
    },
  });
}

export const ASK_TOOL_NAME = 'ask';
