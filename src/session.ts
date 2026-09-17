import {
  isStepCount,
  generateText,
  streamText,
  APICallError,
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
import { costOf, formatUsd } from './pricing';
import { systemPrompt } from './prompt';
import { detachProviderItems, digestOf, droppedBy, isPrunedSpanSummary, prunedSpanMessage, pruneToFit } from './prune';
import { restore, Snapshots, type TurnSnapshot } from './snapshot';
import { createStepBackTool, type LoopEntry } from './step-back';
import { createSkillTool, renderSkills, type Skill } from './skills';
import { disabledToolNames, onBashOutput, tools as builtinTools, type ToolSetName } from './tools';

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

/** What an undo did, so the UI can say which files moved and which did not. */
export type UndoResult = {
  snapshot: TurnSnapshot;
  restored: string[];
  removed: string[];
  conversationTrimmed: boolean;
};

export type RedoResult = {
  snapshot: TurnSnapshot;
  /** False when files were asked for: only pre-images are ever captured. */
  filesRestored: boolean;
  what: 'both' | 'files' | 'conversation';
};

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
  /** Model id, for pricing the session's spend against the ceiling. */
  modelId?: string;
  /** Subagent model id, when it differs; its spend prices against this. */
  subagentModelId?: string;
  askApproval: (req: ApprovalRequest) => Promise<ApprovalDecision>;
  yolo?: boolean;
  cwd?: string;
  maxSteps?: number;
  /** USD ceiling: warn at 80%, refuse the next turn at 100%. */
  maxSpendUsd?: number;
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
  /** Identical calls to an allowed tool before it is asked about anyway. Default 3. */
  repeatLimit?: number;
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

/**
 * Length-based token estimate for deciding *when to prune*, not for billing.
 * JSON char count / 4 approximates token count closely enough to gate compaction,
 * but real billed tokens come from the SDK's reported usage (`inputTokens`), never
 * from here. `/cost` and the budget ceiling use the SDK figure.
 */
const estimateTokens = (messages: ModelMessage[]) => Math.round(JSON.stringify(messages).length / 4);

/** Estimated tokens at which the wire history is pruned. */
const DEFAULT_COMPACT_THRESHOLD = 120_000;

/** Identical calls in one turn before an allowed tool is asked about anyway. */
const REPEAT_LIMIT = 3;

/**
 * Squashes a tool result into a few characters for the loop trace.
 *
 * The trace is fed back to the model verbatim, so a 30 KB read_file output would
 * fill the reflection with noise. A short string keeps `step_back` honest about
 * what happened without flooding the next context window.
 */
function summarizeToolResult(output: unknown): string {
  if (typeof output === 'string') return output.length <= 80 ? output : `${output.slice(0, 80)}…(${output.length} chars)`;
  try {
    const json = JSON.stringify(output);
    return json.length <= 80 ? json : `${json.slice(0, 80)}…`;
  } catch {
    return String(output);
  }
}

/** Ceiling on an injected span summary, so the summary cannot defeat the compaction. */
const MAX_SPAN_SUMMARY_CHARS = 1_200;

const callKey = (toolName: string, input: unknown) => `${toolName}:${JSON.stringify(input ?? null)}`;

/**
 * The provider rejected an `item_reference` because it no longer holds that item:
 * 404 "Item with id 'msg_...' not found". Retrying the same history repeats it, so
 * this is the one failure that is worth answering by rewriting the history.
 */
const isStaleItemError = (error: unknown): boolean =>
  APICallError.isInstance(error) && /item with id '[^']*' not found/i.test(error.message);

const STALE_ITEM_NOTICE =
  'The provider no longer had part of this session stored. Re-sent the history inline and carried on.';

type ApprovalContext = Pick<ApprovalRequest, 'matchedPattern' | 'suggestedPattern' | 'repeated'>;

export class Session {
  readonly messages: ModelMessage[];
  readonly tools: ToolSet;
  readonly notebook: Notebook;
  /** Pre-images of files this session's turns have changed, newest last. */
  readonly snapshots: Snapshots;
  inputTokens = 0;
  outputTokens = 0;
  /** Subagent token use, priced against the subagent's own model id in /cost. */
  subagentInputTokens = 0;
  subagentOutputTokens = 0;
  private model: LanguageModel;
  private variant: AgentVariant;
  private readonly permissions: Permissions;
  /** Calls seen this turn, for the repeat guard. Cleared per turn, not per step. */
  private readonly seen = new Map<string, number>();
  /** One stale-item repair per turn, so a repeating 404 cannot loop the run. */
  private staleItemsRepaired = false;
  /** The 80% spend warning is shown once, not on every turn past the line. */
  private warnedSpend = false;
  private controller: AbortController | undefined;
  /** Tools this turn used that no snapshot can cover, reported when the turn ends. */
  private readonly uncoveredTools = new Set<string>();
  /** The snapshot the last undo removed, so `/redo` can put it back. */
  private lastUndone: TurnSnapshot | undefined;
  /** Every tool call this turn, input + outcome, for the loop-detection tool to reflect on. */
  private readonly loopTrace: LoopEntry[] = [];
  /** toolCallId -> { toolName, input }, so a result can be paired with its call. */
  private readonly callInputs = new Map<string, { toolName: string; input: string }>();

  constructor(private readonly opts: SessionOptions) {
    this.messages = opts.messages ?? [];
    this.notebook = new Notebook(opts.onNotebookChange);
    this.notebook.restore(opts.notebook);
    this.model = opts.model;
    this.variant = opts.agent ?? DEFAULT_VARIANT;
    this.snapshots = new Snapshots(opts.cwd ?? process.cwd());

    const sessionTools = {
      ...this.notebook.tools(),
      ...(opts.memory ? opts.memory.tools() : {}),
      // Always registered, even with no skills, so a mid-session install of the
      // first skill is callable next turn without a session rebuild. The tool's
      // description reads the live list and says "none" when it is empty.
      skill: createSkillTool(() => this.opts.skills ?? []),
      ...(opts.ask ? { ask: createAskTool(opts.ask) } : {}),
      step_back: createStepBackTool({
        trace: () => this.loopTrace,
      }),
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
    this.subagentInputTokens = 0;
    this.subagentOutputTokens = 0;
    this.warnedSpend = false;
    this.notebook.clear();
    this.opts.onChange?.(this.messages);
  }

  /** A subagent's finished run, folded into the session's spend and the /cost split. */
  recordSubagentUsage(usage: { inputTokens: number; outputTokens: number }): void {
    this.subagentInputTokens += usage.inputTokens;
    this.subagentOutputTokens += usage.outputTokens;
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

  /**
   * The session's spend so far and the configured ceiling, for the UI's status
   * and the refuse-the-next-turn check. Unpriced models report no spend: a
   * ceiling cannot be enforced against a model we cannot price.
   */
  spend(): { usd?: number; ceiling?: number; overWarn: boolean; overLimit: boolean } {
    const ceiling = this.opts.maxSpendUsd;
    const parent = costOf(this.opts.modelId ?? '', this.inputTokens, this.outputTokens);
    const sub =
      this.subagentInputTokens + this.subagentOutputTokens > 0
        ? costOf(this.opts.subagentModelId ?? this.opts.modelId ?? '', this.subagentInputTokens, this.subagentOutputTokens)
        : 0;
    // Spend is only knowable when every part is priced; an unpriced piece means
    // the total is a lower bound, so the ceiling is not enforced against it.
    const usd = parent === undefined || sub === undefined ? undefined : parent + sub;
    if (ceiling === undefined || usd === undefined) {
      return { ...(usd !== undefined ? { usd } : {}), ...(ceiling !== undefined ? { ceiling } : {}), overWarn: false, overLimit: false };
    }
    return { usd, ceiling, overWarn: usd >= ceiling * 0.8, overLimit: usd >= ceiling };
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
   * Appends a completed tool call to the loop trace, pairing it with its input.
   *
   * The SDK streams `tool-result` without the input that produced it, so the input is
   * kept alongside on the `tool-call` part. A `step_back` call needs this pairing to
   * say *which* call produced *which* outcome.
   */
  private recordTrace(toolCallId: string, result: string): void {
    const call = this.callInputs.get(toolCallId);
    this.callInputs.delete(toolCallId);
    if (!call) return;
    this.loopTrace.push({
      step: this.loopTrace.length + 1,
      toolName: call.toolName,
      input: call.input,
      result,
      at: new Date().toISOString(),
    });
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

      // Before anything else, because the guard may deny the call and because a
      // later hook must not be able to move the capture after the write.
      const { covered } = await this.snapshots.captureFor(toolName, input);
      if (!covered) this.uncoveredTools.add(toolName);

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
      const limit = this.opts.repeatLimit ?? REPEAT_LIMIT;
      if (decision === 'allow' && repeats < limit) return undefined;

      if (decision === 'allow') {
        // Repeated three times with a permission that says `allow`: the model is
        // looping, not asking, and it should stop and look at the trace rather than
        // burn another approval. This is the point the step_back tool exists for.
        notices.push(
          `You have called ${toolName} with the same input ${repeats + 1} times this turn. It is not making progress. ` +
            `Use step_back to reflect on what changed between attempts, then try a different approach or stop.`,
        );
      }

      why.set(callKey(toolName, input), {
        ...(pattern ? { matchedPattern: pattern } : {}),
        suggestedPattern: this.permissions.suggest(toolName, input),
        ...(decision === 'allow' ? { repeated: true } : {}),
      });
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

  /**
   * Walks the last turn back: files, conversation, or both.
   *
   * The three-way split is the point. Restoring files without the conversation leaves
   * the model believing edits are on disk that are not, so its next turn is built on a
   * state that no longer exists — it re-reads a file expecting its own change and finds
   * the original, which reads to the model as the change having been rejected. Restoring
   * the conversation without the files is the mirror: the model forgets it made an edit
   * that is still there. So the default is both, and the caller can narrow it.
   *
   * Returns undefined when there is nothing to undo, which the UI reports as such
   * rather than as a failure.
   */
  async undo(what: 'both' | 'files' | 'conversation' = 'both'): Promise<UndoResult | undefined> {
    const snap = this.snapshots.pop();
    if (!snap) return undefined;

    const files = what === 'conversation' ? { restored: [], removed: [] } : await restore(snap, this.snapshots.cwdOf());
    if (what !== 'files') this.trimTo(snap.messageCount);

    this.lastUndone = snap;
    return { snapshot: snap, ...files, conversationTrimmed: what !== 'files' };
  }

  /**
   * Puts back what `undo` took, without a second snapshot.
   *
   * A redo cannot restore file content from the session, because the content that
   * existed after the turn was never captured — only the pre-image was. So a redo of
   * the files is declined honestly rather than approximated: the whole point of undo
   * is that the user trusts what it says it did. The conversation is restored from the
   * snapshot's own record, which is exact.
   */
  redo(what: 'both' | 'files' | 'conversation' = 'conversation'): RedoResult | undefined {
    const snap = this.lastUndone;
    if (!snap) return undefined;

    this.snapshots.push(snap);
    this.lastUndone = undefined;
    return { snapshot: snap, filesRestored: false, what };
  }

  undoable(): readonly TurnSnapshot[] {
    return this.snapshots.list();
  }

  private trimTo(length: number): void {
    if (this.messages.length <= length) return;
    this.messages.length = Math.max(0, length);
    this.opts.onChange?.(this.messages);
  }

  /**
   * Closes the open snapshot and reports what the turn could not cover.
   *
   * Called before every `done`, not from `send`'s `finally`, because a notice that
   * arrives after `done` is a notice the UI has already stopped listening for —
   * `done` is what a consumer treats as the end of the turn and stops on.
   *
   * Two reasons to speak, and the second does not depend on the first: a turn with no
   * snapshotted edits can still have run `bash` and changed the tree, which is exactly
   * when the warning matters most.
   */
  private *closingNotices(): Generator<AgentEvent> {
    const snapshot = this.snapshots.commit();
    const uncovered = [...this.uncoveredTools];
    if (uncovered.length === 0) return;
    const covered = snapshot ? `${snapshot.files.length} file(s) changed this turn and can be undone with /undo. ` : '';
    yield {
      type: 'notice',
      text: `${covered}${uncovered.join(', ')} ran this turn and cannot be snapshotted, so any changes it made will not be undone.`,
    };
  }

  /**
   * Swaps the live skill list at a turn boundary.
   *
   * The `skill` tool and the system-prompt catalogue both read the list on each
   * call, so replacing it here is atomic across the two and takes effect on the
   * next turn with no session rebuild. The caller is responsible for only doing
   * this between turns — a turn in flight already holds its rules.
   */
  setSkills(skills: Skill[]): void {
    this.opts.skills = skills;
  }

  async *send(userText: string): AsyncGenerator<AgentEvent> {
    // The ceiling is checked before the model is: a turn started past the limit
    // would spend money the caller said not to. An unpriced model cannot be
    // measured, so it is never refused here — the ceiling simply cannot see it.
    const spend = this.spend();
    if (spend.overLimit) {
      yield {
        type: 'error',
        error: new Error(
          `spend ceiling reached: ${formatUsd(spend.usd ?? 0)} of ${formatUsd(spend.ceiling ?? 0)} used. Raise maxSpendUsd or start a new session.`,
        ),
      };
      yield { type: 'done' };
      return;
    }

    this.messages.push({ role: 'user', content: userText });
    this.opts.onChange?.(this.messages);
    this.controller = new AbortController();
    const signal = this.controller.signal;
    const threshold = this.compactThreshold();
    // Per turn, not per step: a tool called once in each of three steps is the
    // loop this guards against.
    this.seen.clear();
    this.uncoveredTools.clear();
    this.loopTrace.length = 0;
    this.staleItemsRepaired = false;
    // Opened before the model runs and closed after it stops, so every write the
    // turn makes lands in one snapshot the user can walk back to.
    this.snapshots.begin(userText, this.messages.length);

    const outputs: Extract<AgentEvent, { type: 'tool-output' }>[] = [];
    onBashOutput(({ toolCallId, chunk }) => {
      outputs.push({ type: 'tool-output', id: toolCallId, chunk });
      this.opts.onToolOutput?.(toolCallId, chunk);
    });

    try {
      yield* this.run(signal, threshold, outputs);
    } finally {
      onBashOutput(undefined);
      // Belt and braces: closingNotices runs before every `done`, but an aborted turn
      // can return through a path that never reached it, and an uncommitted snapshot
      // would then be silently dropped rather than kept.
      this.snapshots.commit();
      await this.opts.plugins?.afterTurn();
    }
  }

  /**
   * Rewrites the history so nothing points at provider-side storage, once per turn.
   *
   * The 404 repeats for every reference in the request, and a repair that could run
   * twice would retry a request that cannot be made to work.
   */
  private repairStaleItems(): boolean {
    if (this.staleItemsRepaired) return false;
    this.staleItemsRepaired = true;
    this.replace(detachProviderItems(this.messages));
    return true;
  }

  /**
   * Prunes the canonical history once a run has landed.
   *
   * prepareStep only trims the wire copy for the next request; without this write-back
   * the stored history keeps growing, the context meter pins at 100%, and every later
   * turn re-prunes the same messages from scratch.
   */
  private async compactCanonical(threshold: number): Promise<{ before: number; after: number } | null> {
    const before = this.messages.length;
    if (estimateTokens(this.messages) <= threshold) return null;
    const pruned = pruneToFit({ messages: this.messages, threshold, estimate: estimateTokens });
    if (pruned.length === before) return null;
    const dropped = droppedBy(this.messages, pruned);
    const summary = await this.summarizeSpan(dropped.filter((m) => !isPrunedSpanSummary(m)));
    this.replace(this.withSummarizedSpan(summary, pruned, dropped));
    return { before, after: this.messages.length };
  }

  /**
   * Puts a summary of the discarded span at the head of the history it was dropped from.
   *
   * Without this the model is told which tool results to keep and nothing about what
   * was dropped, so it states a decision it made forty messages ago as though it had
   * never made it.
   *
   * The summary is bounded two ways because a summary that grows with the session
   * defeats the point of compacting at all: the input is capped at the span's own
   * digest, and the output is capped by instruction and by hard truncation. A failed
   * or empty call falls back to the digest, which costs nothing and still carries
   * which tool touched which path — the part a contradiction is usually built from.
   */
  private async summarizeSpan(dropped: readonly ModelMessage[]): Promise<string | undefined> {
    const digest = digestOf(dropped);
    if (!digest) return undefined;
    try {
      const { text } = await generateText({
        model: this.model,
        system:
          'These lines are the condensed record of an earlier part of a coding session that has been ' +
          'compacted out of the conversation. Write at most 120 words of notes capturing decisions made, ' +
          'files touched, commands run and their outcome, and anything still pending. State only what the ' +
          'lines support; do not invent detail and do not address the reader.',
        messages: [{ role: 'user', content: digest }],
        maxRetries: this.opts.maxRetries ?? 3,
      });
      const trimmed = text.trim();
      return trimmed ? trimmed.slice(0, MAX_SPAN_SUMMARY_CHARS) : undefined;
    } catch {
      // A summarizer that cannot run must not cost the turn its compaction: the
      // digest is a worse record, not an absent one.
      return undefined;
    }
  }

  private withSummarizedSpan(summary: string | undefined, pruned: ModelMessage[], dropped: readonly ModelMessage[]): ModelMessage[] {
    const worthSummarizing = dropped.filter((m) => !isPrunedSpanSummary(m));
    if (worthSummarizing.length === 0) return pruned;

    const prior = dropped.filter(isPrunedSpanSummary);
    const spanMessage = prunedSpanMessage(summary, worthSummarizing);
    if (!spanMessage) return pruned;
    return [...prior, spanMessage, ...pruned];
  }

  private async *run(
    signal: AbortSignal,
    threshold: number,
    outputs: Extract<AgentEvent, { type: 'tool-output' }>[],
  ): AsyncGenerator<AgentEvent> {
    // Each iteration is one model run. A run ends either finished, or suspended
    // on tool approvals, in which case we collect decisions and run again.
    let compactionReported = false;
    while (true) {
      const pending: ApprovalRequest[] = [];
      const compactions: Extract<AgentEvent, { type: 'compacted' }>[] = [];
      const guardNotices: string[] = [];
      const why = new Map<string, ApprovalContext>();
      let sawError = false;
      let delivered = false;
      let staleRetry = false;

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
              delivered = true;
              yield { type: 'text', text: part.text };
              break;
            case 'reasoning-delta':
              delivered = true;
              yield { type: 'reasoning', text: part.text };
              break;
            case 'tool-input-start':
              // Arrives before the arguments finish streaming, so the UI can name
              // the tool while the model is still writing its input.
              delivered = true;
              yield { type: 'tool-start', id: part.id, name: part.toolName };
              break;
            case 'tool-call':
              this.callInputs.set(part.toolCallId, { toolName: part.toolName, input: JSON.stringify(part.input ?? null) });
              yield { type: 'tool-call', id: part.toolCallId, name: part.toolName, input: part.input };
              break;
            case 'tool-result':
              this.recordTrace(part.toolCallId, summarizeToolResult(part.output));
              yield { type: 'tool-result', id: part.toolCallId, name: part.toolName, output: part.output };
              break;
            case 'tool-error':
              this.recordTrace(part.toolCallId, `error: ${part.error instanceof Error ? part.error.message : String(part.error)}`);
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
              yield* this.closingNotices();
              yield { type: 'done' };
              return;
            case 'error':
              // A stale item is rejected before generation starts, so nothing has
              // been said yet and the request can be rebuilt. Once output is on
              // screen it cannot be unsent, and a retry would repeat it.
              if (!delivered && isStaleItemError(part.error) && this.repairStaleItems()) {
                yield { type: 'notice', text: STALE_ITEM_NOTICE };
                staleRetry = true;
                break;
              }
              sawError = true;
              yield { type: 'error', error: part.error };
              break;
            default:
              break;
          }
        }
      } catch (error) {
        if (signal.aborted) {
          yield* this.closingNotices();
          yield { type: 'done' };
          return;
        }
        if (!delivered && isStaleItemError(error) && this.repairStaleItems()) {
          yield { type: 'notice', text: STALE_ITEM_NOTICE };
          continue;
        }
        yield { type: 'error', error };
        return;
      }

      // The history was rewritten under this run, so its promise-shaped results
      // describe a request that no longer stands. Run again rather than read them.
      if (staleRetry) continue;

      // A stream that ended in an error has no response messages or usage to
      // await; touching them would throw NoOutputGeneratedError.
      if (sawError) return;

      while (compactions.length > 0) yield compactions.shift()!;
      while (outputs.length > 0) yield outputs.shift()!;
      while (guardNotices.length > 0) yield { type: 'notice', text: guardNotices.shift()! };

      this.messages.push(...(await result.responseMessages));

      // prepareStep already emits `compacted` at the same threshold crossing, and
      // replace() fires onChange on the fold path; both would double up otherwise.
      if (!(await this.compactCanonical(threshold))) this.opts.onChange?.(this.messages);

      if (pending.length === 0) {
        const usage = await result.usage;
        this.inputTokens += usage.inputTokens ?? 0;
        this.outputTokens += usage.outputTokens ?? 0;
        // Warn as the ceiling comes into view, once, so a long session is not
        // surprised by a refusal it never saw coming.
        const spend = this.spend();
        if (spend.overWarn && !this.warnedSpend) {
          this.warnedSpend = true;
          yield {
            type: 'notice',
            text: `approaching spend ceiling: ${formatUsd(spend.usd ?? 0)} of ${formatUsd(spend.ceiling ?? 0)} used`,
          };
        }
        yield* this.closingNotices();
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
