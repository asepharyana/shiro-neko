import {
  isStepCount,
  generateText,
  streamText,
  type LanguageModel,
  type ModelMessage,
  type ToolApprovalResponse,
  type ToolSet,
} from 'ai';
import { DEFAULT_VARIANT, sdkReasoning, renderAgent, type AgentVariant } from './agents';
import { createAskTool, type AskFn } from './ask';
import type { Instructions } from './instructions';
import type { Memory } from './memory';
import { Notebook, type NotebookState } from './notebook';
import type { PluginHost } from './plugins';
import { systemPrompt } from './prompt';
import { prunePreservingItems } from './prune';
import { createSkillTool, renderSkills, type Skill } from './skills';
import {
  MUTATING_TOOLS,
  disabledToolNames,
  onBashOutput,
  tools as builtinTools,
  type ToolSetName,
} from './tools';

export type ApprovalRequest = {
  approvalId: string;
  toolName: string;
  input: unknown;
};

/** 'once' runs this call only; 'always' whitelists the tool for the rest of the session. */
export type ApprovalDecision = 'once' | 'always' | 'deny';

export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool-start'; id: string; name: string }
  | { type: 'tool-call'; id: string; name: string; input: unknown }
  | { type: 'tool-output'; id: string; chunk: string }
  | { type: 'tool-result'; id: string; name: string; output: unknown }
  | { type: 'tool-error'; id: string; name: string; error: unknown }
  | { type: 'tool-denied'; name: string }
  | { type: 'compacted'; before: number; after: number }
  | { type: 'notice'; text: string }
  | { type: 'error'; error: unknown }
  | { type: 'done'; inputTokens?: number; outputTokens?: number };

export type SessionOptions = {
  model: LanguageModel;
  askApproval: (req: ApprovalRequest) => Promise<ApprovalDecision>;
  yolo?: boolean;
  cwd?: string;
  maxSteps?: number;
  /** MCP and subagent tools merged on top of the built-ins. */
  extraTools?: ToolSet;
  /** Tool sets offered this session; omit for all of them. `core` is always on. */
  toolSets?: readonly ToolSetName[];
  /** Tool names that never prompt, e.g. the read-only subagent tool. */
  autoApprove?: readonly string[];
  /** Prune the history once the estimated token count crosses this. */
  compactThreshold?: number;
  /** Retries per model call for transient failures. */
  maxRetries?: number;
  /** AGENTS.md-style files appended to the system prompt. */
  instructions?: Instructions;
  /** Task list restored from a resumed session. */
  notebook?: NotebookState;
  /** Thinking level, tool restrictions, and behaviour appendix. */
  agent?: AgentVariant;
  skills?: Skill[];
  memory?: Memory;
  plugins?: PluginHost;
  /** Where an `ask` tool call goes. Omit in headless runs. */
  ask?: AskFn;
  messages?: ModelMessage[];
  onChange?: (messages: ModelMessage[]) => void;
  /** Live stdout/stderr from bash, for a UI that wants progress. */
  onToolOutput?: (id: string, chunk: string) => void;
  onNotebookChange?: (state: NotebookState) => void;
};

const estimateTokens = (messages: ModelMessage[]) => Math.round(JSON.stringify(messages).length / 4);

/** Estimated tokens at which the wire history is pruned. */
const DEFAULT_COMPACT_THRESHOLD = 120_000;

export class Session {
  readonly messages: ModelMessage[];
  readonly tools: ToolSet;
  readonly notebook: Notebook;
  inputTokens = 0;
  outputTokens = 0;
  private model: LanguageModel;
  private variant: AgentVariant;
  private readonly alwaysAllow = new Set<string>();
  private controller: AbortController | undefined;

  constructor(private readonly opts: SessionOptions) {
    this.messages = opts.messages ?? [];
    this.notebook = new Notebook(opts.onNotebookChange);
    this.notebook.restore(opts.notebook);
    this.model = opts.model;
    this.variant = opts.agent ?? DEFAULT_VARIANT;

    const sessionTools = {
      ...this.notebook.tools(),
      ...(opts.memory ? opts.memory.tools() : {}),
      ...(opts.skills && opts.skills.length > 0 ? { skill: createSkillTool(opts.skills) } : {}),
      ...(opts.ask ? { ask: createAskTool(opts.ask) } : {}),
    };
    this.tools = { ...builtinTools, ...sessionTools, ...(opts.plugins?.tools ?? {}), ...(opts.extraTools ?? {}) };

    for (const name of [
      ...(opts.autoApprove ?? []),
      ...(opts.plugins?.autoApprove ?? []),
      ...Object.keys(sessionTools),
    ]) {
      this.alwaysAllow.add(name);
    }
  }

  setModel(model: LanguageModel): void {
    this.model = model;
  }

  setAgent(variant: AgentVariant): void {
    this.variant = variant;
  }

  agent(): AgentVariant {
    return this.variant;
  }

  /**
   * Tool names offered this turn. A read-only variant hides the mutating tools;
   * a disabled tool set is withheld from the wire and from the prompt, since a
   * prompt that names an absent tool teaches calls that cannot succeed.
   */
  activeTools(): string[] {
    const withheld = new Set(disabledToolNames(this.opts.toolSets));
    const all = Object.keys(this.tools).filter((name) => !withheld.has(name));
    if (!this.variant.allowTools) return all;
    return all.filter((name) => this.variant.allowTools!.includes(name));
  }

  reset(): void {
    this.messages.length = 0;
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.notebook.clear();
    this.opts.onChange?.(this.messages);
  }

  replace(messages: ModelMessage[]): void {
    this.messages.length = 0;
    this.messages.push(...messages);
    this.opts.onChange?.(this.messages);
  }

  abort(): void {
    this.controller?.abort();
  }

  estimatedTokens(): number {
    return estimateTokens(this.messages);
  }

  /** Where compaction kicks in, so the status bar can show how close it is. */
  compactThreshold(): number {
    return this.opts.compactThreshold ?? DEFAULT_COMPACT_THRESHOLD;
  }

  private systemFor(): string {
    return systemPrompt({
      cwd: this.opts.cwd ?? process.cwd(),
      instructions: this.opts.instructions ?? [],
      notebook: this.notebook.render(),
      memory: this.opts.memory?.render() ?? '',
      skills: renderSkills(this.opts.skills ?? []),
      agent: renderAgent(this.variant),
      plugins: this.opts.plugins?.appendix ?? '',
      availableTools: this.activeTools(),
      canAsk: this.opts.ask !== undefined && this.activeTools().includes('ask'),
    });
  }

  /** Tools that mutate the workspace, plus every externally provided MCP tool. */
  private needsApproval(name: string): boolean {
    return (MUTATING_TOOLS as readonly string[]).includes(name) || name.startsWith('mcp__');
  }

  /**
   * Approval decisions, evaluated per call by the SDK.
   *
   * A plugin guard denies outright and is checked before anything else, so `--yolo`
   * cannot bypass it. Only after the guard passes does yolo or the mutating-tool
   * rule decide whether the user is asked.
   */
  private toolApproval(notices: string[]) {
    return async ({ toolCall }: { toolCall: { toolName: string; input: unknown } }) => {
      const blocked = await this.opts.plugins?.guard({
        toolName: toolCall.toolName,
        input: toolCall.input,
        cwd: this.opts.cwd ?? process.cwd(),
      });
      if (blocked) {
        notices.push(blocked);
        return { type: 'denied' as const, reason: blocked };
      }
      if (this.opts.yolo) return undefined;
      if (!this.needsApproval(toolCall.toolName)) return undefined;
      if (this.alwaysAllow.has(toolCall.toolName)) return undefined;
      return 'user-approval' as const;
    };
  }

  /** Replaces the history with a model-written summary. Backs the /compact command. */
  async summarize(): Promise<{ before: number; after: number }> {
    const before = this.messages.length;
    if (before === 0) return { before, after: 0 };

    const { text } = await generateText({
      model: this.model,
      system:
        'Summarize this coding session for use as the sole context of a fresh session. ' +
        'Keep: the user goal, files touched with paths, decisions made, commands run and their outcome, ' +
        'and what remains to be done. Drop pleasantries and full file contents. Write it as notes, not prose.',
      messages: this.messages,
      maxRetries: this.opts.maxRetries ?? 3,
    });

    this.messages.length = 0;
    this.messages.push({ role: 'user', content: `Summary of the session so far:\n\n${text}` });
    this.opts.onChange?.(this.messages);
    return { before, after: this.messages.length };
  }

  async *send(userText: string): AsyncGenerator<AgentEvent> {
    this.messages.push({ role: 'user', content: userText });
    this.opts.onChange?.(this.messages);
    this.controller = new AbortController();
    const signal = this.controller.signal;
    const threshold = this.compactThreshold();

    const outputs: Extract<AgentEvent, { type: 'tool-output' }>[] = [];
    onBashOutput(({ toolCallId, chunk }) => {
      outputs.push({ type: 'tool-output', id: toolCallId, chunk });
      this.opts.onToolOutput?.(toolCallId, chunk);
    });

    try {
      yield* this.run(signal, threshold, outputs);
    } finally {
      onBashOutput(undefined);
      await this.opts.plugins?.afterTurn();
    }
  }

  private async *run(
    signal: AbortSignal,
    threshold: number,
    outputs: Extract<AgentEvent, { type: 'tool-output' }>[],
  ): AsyncGenerator<AgentEvent> {
    // Each iteration is one model run. A run ends either finished, or suspended
    // on tool approvals, in which case we collect decisions and run again.
    while (true) {
      const pending: ApprovalRequest[] = [];
      const compactions: Extract<AgentEvent, { type: 'compacted' }>[] = [];
      const guardNotices: string[] = [];
      let sawError = false;

      const result = streamText({
        model: this.model,
        system: this.systemFor(),
        messages: this.messages,
        tools: this.tools,
        activeTools: this.activeTools(),
        reasoning: sdkReasoning(this.variant.thinking),
        toolApproval: this.toolApproval(guardNotices),
        stopWhen: isStepCount(this.variant.maxSteps ?? this.opts.maxSteps ?? 50),
        maxRetries: this.opts.maxRetries ?? 3,
        abortSignal: signal,
        prepareStep: ({ messages }) => {
          // Rebuilt every step: a todo_write earlier in this same run must be
          // visible to the steps that follow it, not only to the next turn.
          const instructions = this.systemFor();
          if (estimateTokens(messages) <= threshold) return { instructions };
          const pruned = prunePreservingItems({
            messages,
            reasoning: 'all',
            toolCalls: 'before-last-3-messages',
            emptyMessages: 'remove',
          });
          // prepareStep cannot yield, so queue the notice and drain it in the loop.
          compactions.push({ type: 'compacted', before: messages.length, after: pruned.length });
          return { instructions, messages: pruned };
        },
      });

      // Every promise-shaped accessor settles independently of the stream. Any one
      // left without a rejection sink surfaces as an unhandled rejection on abort
      // or API failure, which scribbles over the Ink render.
      const sink = () => {};
      void result.responseMessages.then(undefined, sink);
      void result.usage.then(undefined, sink);
      void result.steps.then(undefined, sink);
      void result.finalStep.then(undefined, sink);
      void result.text.then(undefined, sink);
      void result.finishReason.then(undefined, sink);

      try {
        for await (const part of result.stream) {
          while (compactions.length > 0) yield compactions.shift()!;
          while (outputs.length > 0) yield outputs.shift()!;
          while (guardNotices.length > 0) yield { type: 'notice', text: guardNotices.shift()! };
          switch (part.type) {
            case 'text-delta':
              yield { type: 'text', text: part.text };
              break;
            case 'reasoning-delta':
              yield { type: 'reasoning', text: part.text };
              break;
            case 'tool-input-start':
              // Arrives before the arguments finish streaming, so the UI can name
              // the tool while the model is still writing its input.
              yield { type: 'tool-start', id: part.id, name: part.toolName };
              break;
            case 'tool-call':
              yield { type: 'tool-call', id: part.toolCallId, name: part.toolName, input: part.input };
              break;
            case 'tool-result':
              yield { type: 'tool-result', id: part.toolCallId, name: part.toolName, output: part.output };
              break;
            case 'tool-error':
              yield { type: 'tool-error', id: part.toolCallId, name: part.toolName, error: part.error };
              break;
            case 'tool-approval-request':
              // A guard denial is answered by the SDK itself and arrives flagged
              // automatic; queueing it would prompt the user for a settled call.
              if (part.isAutomatic) break;
              pending.push({
                approvalId: part.approvalId,
                toolName: part.toolCall.toolName,
                input: part.toolCall.input,
              });
              break;
            case 'tool-approval-response':
              if (!part.approved) yield { type: 'tool-denied', name: part.toolCall.toolName };
              break;
            case 'tool-output-denied':
              yield { type: 'tool-denied', name: part.toolName };
              break;
            case 'abort':
              yield { type: 'done' };
              return;
            case 'error':
              sawError = true;
              yield { type: 'error', error: part.error };
              break;
            default:
              break;
          }
        }
      } catch (error) {
        if (signal.aborted) {
          yield { type: 'done' };
          return;
        }
        yield { type: 'error', error };
        return;
      }

      // A stream that ended in an error has no response messages or usage to
      // await; touching them would throw NoOutputGeneratedError.
      if (sawError) return;

      while (compactions.length > 0) yield compactions.shift()!;
      while (outputs.length > 0) yield outputs.shift()!;
      while (guardNotices.length > 0) yield { type: 'notice', text: guardNotices.shift()! };

      this.messages.push(...(await result.responseMessages));
      this.opts.onChange?.(this.messages);

      if (pending.length === 0) {
        const usage = await result.usage;
        this.inputTokens += usage.inputTokens ?? 0;
        this.outputTokens += usage.outputTokens ?? 0;
        yield { type: 'done', inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
        return;
      }

      const responses: ToolApprovalResponse[] = [];
      for (const req of pending) {
        const decision = this.alwaysAllow.has(req.toolName) ? 'always' : await this.opts.askApproval(req);
        if (decision === 'always') this.alwaysAllow.add(req.toolName);
        responses.push({
          type: 'tool-approval-response',
          approvalId: req.approvalId,
          approved: decision !== 'deny',
          ...(decision === 'deny' ? { reason: 'User denied this tool call.' } : {}),
        });
      }
      this.messages.push({ role: 'tool', content: responses });
    }
  }
}
