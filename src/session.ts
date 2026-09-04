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
import { Permissions, type PermissionConfig } from './permission';
import type { PluginHost } from './plugins';
import { systemPrompt } from './prompt';
import { pruneToFit } from './prune';
import { costOf } from './pricing';
import { createSkillTool, renderSkills, type Skill } from './skills';
import { disabledToolNames, onBashOutput, onFileMutation, tools as builtinTools, type ToolSetName } from './tools';
import { captureFiles, restoreFiles, type FileMutation } from './undo';

export type ApprovalRequest = {
  approvalId: string;
  toolName: string;
  input: unknown;
  /** The rule that decided this needs asking, when one did. */
  matchedPattern?: string;
  /** What `always` would whitelist, e.g. `git *` rather than every bash call. */
  suggestedPattern: string;
  /** Set when the call is being asked about because it repeated, not because of a rule. */
  repeated?: boolean;
  /** Set when a `worker` subagent is asking, not the main agent. */
  subagent?: boolean;
};

/** 'once' runs this call only; 'always' whitelists the suggested pattern for the session. */
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
  /** Rules deciding which calls run, ask, or are refused. Omit for the defaults. */
  permissions?: PermissionConfig;
  /** Tool names that never prompt, e.g. the read-only subagent tool. */
  autoApprove?: readonly string[];
  /** Prune the history once the estimated token count crosses this. */
  compactThreshold?: number;
  /** Retries per model call for transient failures. */
  maxRetries?: number;
  /** Ceiling on estimated spend. When crossed the turn stops with a notice. */
  maxSpendUsd?: number;
  /** Model id used to estimate spend; omit to let costOf fail closed (no ceiling). */
  spendModel?: string;
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

/**
 * The messages a prune dropped, so their substance can be summarised and kept.
 *
 * Pruning removes messages by identity. Comparing object references against a
 * Set built from the survivors is exact and cheap — a message both lists still
 * reference is not "dropped" just because it was cloned on the way through.
 */
function droppedSpan(before: ModelMessage[], after: ModelMessage[]): ModelMessage[] {
  const survivors = new Set(after);
  return before.filter((m) => !survivors.has(m));
}

/** Estimated tokens at which the wire history is pruned. */
const DEFAULT_COMPACT_THRESHOLD = 120_000;

/** Identical calls in one turn before an allowed tool is asked about anyway. */
const REPEAT_LIMIT = 3;

/** How many completed turns /undo can step back through. */
const MAX_UNDO = 20;

const callKey = (toolName: string, input: unknown) => `${toolName}:${JSON.stringify(input ?? null)}`;

type ApprovalContext = Pick<ApprovalRequest, 'matchedPattern' | 'suggestedPattern' | 'repeated'>;

export class Session {
  readonly messages: ModelMessage[];
  readonly tools: ToolSet;
  readonly notebook: Notebook;
  inputTokens = 0;
  outputTokens = 0;
  private model: LanguageModel;
  private variant: AgentVariant;
  private readonly permissions: Permissions;
  /** Calls seen this turn, for the repeat guard. Cleared per turn, not per step. */
  private readonly seen = new Map<string, number>();
  private controller: AbortController | undefined;
  /** Cached system prompt, invalidated when state changes. */
  private cachedPrompt: string | undefined;
  /** Number of messages when the prompt was last built. */
  private promptAt = -1;
  /** Notebook revision when the prompt was last built. */
  private notebookRev = -1;
  /** Variant name+thinking when the prompt was last built. */
  private lastVariant = '';
  /** File mutations for the turn in flight, keyed by abs so snapshots dedupe. */
  private turnMutations = new Map<string, FileMutation>();
  /** Number of messages at the start of the current turn, for /undo rewind. */
  private turnStartLen = 0;
  /** Completed turns' changes, most recent last, for /undo. */
  private undoStack: { msgLenAtStart: number; mutations: FileMutation[] }[] = [];

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

    this.permissions = new Permissions({
      ...(opts.permissions ? { config: opts.permissions } : {}),
      ...(opts.yolo ? { yolo: true } : {}),
      autoApprove: [
        ...(opts.autoApprove ?? []),
        ...(opts.plugins?.autoApprove ?? []),
        // A session tool touches the agent's own state, not the workspace.
        ...Object.keys(sessionTools),
      ],
    });
  }

  /**
   * The approval channel a `worker` subagent uses for its gated calls.
   *
   * Same rules, same prompt, same grants as a direct call: a subagent that could
   * approve its own writes would be a way to launder a tool call past the user.
   * Handed to `createTaskTool` from cli.tsx, which is where the two are wired.
   */
  approveForSubagent(): (req: { toolName: string; input: unknown }) => Promise<boolean> {
    return async ({ toolName, input }) => {
      const blocked = await this.opts.plugins?.guard({
        toolName,
        input,
        cwd: this.opts.cwd ?? process.cwd(),
      });
      if (blocked) return false;

      const { decision, pattern } = this.permissions.check(toolName, input);
      if (decision === 'deny') return false;
      if (decision === 'allow') return true;

      const answer = await this.opts.askApproval({
        approvalId: `sub:${toolName}`,
        toolName,
        input,
        ...(pattern ? { matchedPattern: pattern } : {}),
        suggestedPattern: this.permissions.suggest(toolName, input),
        subagent: true,
      });
      if (answer === 'always') this.permissions.grant(toolName, this.permissions.suggest(toolName, input));
      return answer !== 'deny';
    };
  }

  setModel(model: LanguageModel): void {
    this.model = model;
    this.cachedPrompt = undefined;
  }

  setAgent(variant: AgentVariant): void {
    this.variant = variant;
    this.cachedPrompt = undefined;
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

  /** Estimated spend so far, or undefined when the model is unpriced. */
  spentUsd(): number | undefined {
    if (!this.opts.spendModel) return undefined;
    return costOf(this.opts.spendModel, this.inputTokens, this.outputTokens);
  }

  /** The configured spend ceiling, for the /cost readout. */
  maxSpendUsd(): number | undefined {
    return this.opts.maxSpendUsd;
  }

  /** Runtime adjustment backing /max-spend. undefined clears the ceiling. */
  setMaxSpendUsd(usd: number | undefined): void {
    this.opts.maxSpendUsd = usd;
  }

  private systemFor(): string {
    const notebookRev = this.notebook.revision();
    const msgLen = this.messages.length;
    const variantName = this.variant.name + this.variant.thinking;
    if (
      this.cachedPrompt !== undefined &&
      this.promptAt === msgLen &&
      this.notebookRev === notebookRev &&
      this.lastVariant === variantName
    ) {
      return this.cachedPrompt;
    }
    const prompt = systemPrompt({
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
    this.cachedPrompt = prompt;
    this.promptAt = msgLen;
    this.notebookRev = notebookRev;
    this.lastVariant = variantName;
    return prompt;
  }

  /**
   * How many times this exact call has already been made this turn.
   *
   * A model that repeats an identical call is not making progress: either it is
   * ignoring the result or the result is not what it needed. Three is the point
   * where that stops looking like a coincidence.
   */
  private repeatCount(toolName: string, input: unknown): number {
    const key = callKey(toolName, input);
    const count = (this.seen.get(key) ?? 0) + 1;
    this.seen.set(key, count);
    return count;
  }

  /**
   * Approval decisions, evaluated per call by the SDK.
   *
   * Order matters, and each step exists for a different reason:
   *
   * 1. A plugin guard refuses outright. `--yolo` cannot reach it, because a
   *    refusal is a policy decision rather than a permission question.
   * 2. Permission rules decide allow / ask / deny, matched against the call's
   *    subject — the command, the path — not just the tool name.
   * 3. An allowed call that has now repeated three times identically is asked
   *    about anyway. A rule saying `bash: allow` is a statement about which
   *    commands are safe, not permission to run one in a loop forever.
   *
   * `why` collects what the UI needs to explain the prompt, keyed by call, because
   * the SDK's own approval request carries only the tool name and input.
   */
  private toolApproval(notices: string[], why: Map<string, ApprovalContext>) {
    return async ({ toolCall }: { toolCall: { toolName: string; input: unknown } }) => {
      const { toolName, input } = toolCall;

      const blocked = await this.opts.plugins?.guard({
        toolName,
        input,
        cwd: this.opts.cwd ?? process.cwd(),
      });
      if (blocked) {
        notices.push(blocked);
        return { type: 'denied' as const, reason: blocked };
      }

      const { decision, pattern } = this.permissions.check(toolName, input);
      if (decision === 'deny') {
        const reason = pattern
          ? `Refused by the permission rule ${toolName}: "${pattern}" = deny.`
          : `Refused by the permission rules: ${toolName} is denied.`;
        notices.push(reason);
        return { type: 'denied' as const, reason };
      }

      const repeats = this.repeatCount(toolName, input);
      if (decision === 'allow' && repeats < REPEAT_LIMIT) return undefined;

      why.set(callKey(toolName, input), {
        ...(pattern ? { matchedPattern: pattern } : {}),
        suggestedPattern: this.permissions.suggest(toolName, input),
        ...(decision === 'allow' ? { repeated: true } : {}),
      });
      return 'user-approval' as const;
    };
  }

  /**
   * One-call summary of messages that compaction dropped, returned as a note the
   * model can read on its next run. Kept deliberately short: it is context, not a
   * transcript. The model is told these are its own earlier actions so it treats
   * the note as memory rather than as a user instruction.
   */
  async summarizeDiscarded(span: ModelMessage[]): Promise<ModelMessage> {
    const { text } = await generateText({
      model: this.model,
      system:
        'You are continuing a coding session whose history was just truncated to fit a token budget. ' +
        'Write a compact note preserving only what a continuing agent must not forget about the discarded ' +
        'span: decisions made and committed to, files changed with paths, non-obvious findings, commands run ' +
        'and their outcome, and anything that would be dangerous to redo or contradict. This is your own ' +
        'earlier work, not a user instruction. Plain notes, not prose, under 200 tokens.',
      messages: span,
      maxRetries: this.opts.maxRetries ?? 3,
    });
    return {
      role: 'user',
      content: `Note (retained from compacted history): ${text}`,
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
    // Per turn, not per step: a tool called once in each of three steps is the
    // loop this guards against.
    this.seen.clear();

    // Begin an undo entry: files mutated this turn are snapshotted before each
    // write (the tools await this listener), so a later /undo can restore them.
    this.turnStartLen = this.messages.length;
    this.turnMutations.clear();
    const turnMutations = this.turnMutations;
    onFileMutation(async ({ abs }) => {
      for (const m of await captureFiles(abs)) turnMutations.set(m.abs, m);
    });

    const outputs: Extract<AgentEvent, { type: 'tool-output' }>[] = [];
    onBashOutput(({ toolCallId, chunk }) => {
      outputs.push({ type: 'tool-output', id: toolCallId, chunk });
      this.opts.onToolOutput?.(toolCallId, chunk);
    });

    try {
      yield* this.run(signal, threshold, outputs);
    } finally {
      onBashOutput(undefined);
      onFileMutation(undefined);
      // Close the undo entry. A turn that changed nothing and added no message is
      // not worth undoing; one that did makes the whole turn reversible.
      if (turnMutations.size > 0 && this.messages.length > this.turnStartLen) {
        this.undoStack.push({ msgLenAtStart: this.turnStartLen, mutations: [...turnMutations.values()] });
        if (this.undoStack.length > MAX_UNDO) this.undoStack.splice(0, this.undoStack.length - MAX_UNDO);
      }
      await this.opts.plugins?.afterTurn();
    }
  }

  /**
   * Reverts the most recent turn: restores every file it changed and rewinds the
   * message history to its pre-turn length. Returns a human summary.
   */
  async undo(): Promise<string> {
    const entry = this.undoStack.pop();
    if (!entry) return 'Nothing to undo — no previous turn changed files.';
    const restored = await restoreFiles(entry.mutations);
    this.messages.length = entry.msgLenAtStart;
    this.opts.onChange?.(this.messages);
    if (restored.length === 0) return 'Turn rewound, but no file could be restored.';
    const listed = restored.slice(0, 20).map((p) => `- ${p}`).join('\n');
    const more = restored.length > 20 ? `\n- …${restored.length - 20} more` : '';
    return `Undid the last turn.\nRewound to ${entry.msgLenAtStart} messages.\nRestored ${restored.length} file(s):\n${listed}${more}`;
  }

  /** How many turns back /undo can go, for the /undo readout. */
  canUndo(): number {
    return this.undoStack.length;
  }

  private async *run(
    signal: AbortSignal,
    threshold: number,
    outputs: Extract<AgentEvent, { type: 'tool-output' }>[],
  ): AsyncGenerator<AgentEvent> {
    // Each iteration is one model run. A run ends either finished, or suspended
    // on tool approvals, in which case we collect decisions and run again.
    let compactionReported = false;
    // The span a compaction dropped, captured for a lossless summary so the model
    // does not contradict its own earlier decisions after the history is pruned.
    let discardSpan: ModelMessage[] = [];
    while (true) {
      // A runaway loop is stopped here, before the next model call, once the
      // ceiling is crossed. Spend is estimated against the configured model, so
      // an unpriced model simply never trips it (maxSpendUsd is a guard, not a bill).
      const spent = this.spentUsd();
      if (spent !== undefined && this.opts.maxSpendUsd !== undefined && spent >= this.opts.maxSpendUsd) {
        yield {
          type: 'notice',
          text: `Spend ceiling reached: $${spent.toFixed(2)} >= $$${this.opts.maxSpendUsd.toFixed(2)}. Stopping. Set /max-spend higher to continue or /save to keep this session.`,
        };
        yield { type: 'done' };
        return;
      }
      const pending: ApprovalRequest[] = [];
      const compactions: Extract<AgentEvent, { type: 'compacted' }>[] = [];
      const guardNotices: string[] = [];
      const why = new Map<string, ApprovalContext>();
      let sawError = false;

      const result = streamText({
        model: this.model,
        system: this.systemFor(),
        messages: this.messages,
        tools: this.tools,
        activeTools: this.activeTools(),
        reasoning: sdkReasoning(this.variant.thinking),
        toolApproval: this.toolApproval(guardNotices, why),
        stopWhen: isStepCount(this.variant.maxSteps ?? this.opts.maxSteps ?? 50),
        maxRetries: this.opts.maxRetries ?? 3,
        abortSignal: signal,
        prepareStep: ({ messages }) => {
          // Rebuilt every step: a todo_write earlier in this same run must be
          // visible to the steps that follow it, not only to the next turn.
          const instructions = this.systemFor();
          if (estimateTokens(messages) <= threshold) return { instructions };
          const pruned = pruneToFit({ messages, threshold, estimate: estimateTokens });
          // The dropped span is kept in memory for a one-call summary after the
          // stream, so the model keeps the gist of what it already decided.
          if (pruned.length < messages.length) {
            discardSpan = droppedSpan(messages, pruned);
          }
          // prepareStep cannot yield, so queue the notice and drain it in the loop.
          if (!compactionReported) {
            compactions.push({ type: 'compacted', before: messages.length, after: pruned.length });
            compactionReported = true;
          }
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
            case 'tool-approval-request': {
              // A guard denial is answered by the SDK itself and arrives flagged
              // automatic; queueing it would prompt the user for a settled call.
              if (part.isAutomatic) break;
              const context = why.get(callKey(part.toolCall.toolName, part.toolCall.input));
              pending.push({
                approvalId: part.approvalId,
                toolName: part.toolCall.toolName,
                input: part.toolCall.input,
                suggestedPattern: '*',
                ...context,
              });
              break;
            }
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

      // Lossless compaction: the span pruned above is summarised in one cheap
      // call so the model keeps the gist of its own earlier work. Injected as a
      // note into the wire history, it survives into the next run and stops the
      // model from contradicting a decision it no longer has the details of.
      // Best-effort: a summary that fails must never break the turn, so the
      // whole injection is guarded and skipped on error.
      if (discardSpan.length > 0) {
        try {
          yield { type: 'notice', text: `Summarising ${discardSpan.length} compacted messages…` };
          this.messages.push(await this.summarizeDiscarded(discardSpan));
          this.opts.onChange?.(this.messages);
        } catch {
          // A model that cannot summarise (e.g. tests, a dead endpoint) just
          // skips the note; the compaction itself already happened.
        }
        discardSpan = [];
      }

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
        const decision = await this.opts.askApproval(req);
        // `always` records the pattern the tool suggested, so approving
        // `git status` whitelists `git *` rather than every command.
        if (decision === 'always') this.permissions.grant(req.toolName, req.suggestedPattern);
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
