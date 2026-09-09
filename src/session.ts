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
import { detachProviderItems, droppedSpan, estimateTokens as pruneEstimateTokens, pruneToFit } from './prune';
import { walk } from './ignore';
import { createSkillTool, renderSkills, type Skill } from './skills';
import { suggestSkillsFromTranscript, writeAutoSkill } from './skill-learner';
import { disabledToolNames, onBashOutput, tools as builtinTools, type ToolSetName } from './tools';
import { onBeforeWrite, SnapshotStack, type FileState } from './snapshot';
import { dirname, join, resolve } from 'node:path';
import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs';

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

/** Files a turn changed on disk, for /changes. Absolute paths, classified. */
export type ChangeSummary = {
  added: string[];
  modified: string[];
  deleted: string[];
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
  /** USD ceiling per turn: abort a step if this turn's spend delta crosses it. */
  maxSpendPerTurn?: number;
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
  /** Cheaper model for background learning; falls back to main model. */
  learnerModel?: LanguageModel;
  /** Emit learner notices to the UI. */
  onNotice?: (text: string) => void;
  /** Ignore-aware file list injected into the system prompt at boot; gitignore-respected. */
  workspaceFiles?: readonly string[];
  /** Project-driven workflow: TODO/ROADMAP tracking + verify-before-done nudges. */
  workflow?: {
    /** Master switch. Default true. */
    enabled?: boolean;
    /** Where the project keeps developer docs. Default 'docs'. */
    docsDir?: string;
  };
  /** Disable background auto-learn (tests). */
  disableAutoLearn?: boolean;
};

const estimateTokens = pruneEstimateTokens;

/** Estimated tokens at which the wire history is pruned. */
const DEFAULT_COMPACT_THRESHOLD = 120_000;

/** Identical calls in one turn before an allowed tool is asked about anyway. */
const REPEAT_LIMIT = 3;

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

async function summarizeDiscarded(span: ModelMessage[], model: LanguageModel): Promise<string | undefined> {
  if (span.length === 0) return undefined;
  const excerpt = span
    .map((m) => {
      const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content).slice(0, 2000);
      return `${m.role}: ${c}`;
    })
    .join('\n')
    .slice(0, 6000);
  if (!excerpt.trim()) return undefined;
  try {
    const { text } = await generateText({
      model,
      system: 'Summarize the dropped part of a long coding session so nothing important is lost. Keep: user goals, files touched with paths, decisions and why, tool results that matter, and what remains. One short handover note, 3-6 lines, no preamble.',
      prompt: excerpt,
      maxRetries: 1,
    });
    const t = text.trim();
    return t.length > 0 ? t : undefined;
  } catch {
    return undefined;
  }
}

type ApprovalContext = Pick<ApprovalRequest, 'matchedPattern' | 'suggestedPattern' | 'repeated'>;

async function maybeLearn(
  messages: import('ai').ModelMessage[],
  mainModel: import('ai').LanguageModel,
  learnerModel: import('ai').LanguageModel | undefined,
  memory: import('./memory').Memory | undefined,
  spend: () => { overWarn: boolean },
  onNotice?: (t: string) => void,
): Promise<void> {
  if (spend().overWarn) return;
  const model = learnerModel ?? mainModel;
  if ((model as unknown as { provider?: string }).provider === 'unconfigured') return;
  // project memory: spesifik repo, keep paths — use cheaper learner model when available
  if (memory) {
    try {
      const cands = await memory.suggestFromTranscript(messages as { role: string; content: unknown }[], model);
      // at most 1 per turn to avoid spam; best-effort
      if (cands.length > 0) {
        const c = cands[0]!;
        const added = await memory.add(c.kind, c.text);
        if (added && onNotice) onNotice(`auto-memory: remembered (${c.kind}) ${c.text.slice(0, 80)}`);
      }
    } catch (e) { if (onNotice) onNotice(`auto-memory skipped: ${(e as Error).message?.slice(0, 120)}`); }
  }
  // general skill: universal pattern — write to disk; caller (Session) will hot-reload via loadSkills on next turn if needed
  try {
    const skills = await suggestSkillsFromTranscript(messages as { role: string; content: unknown }[], model);
    for (const c of skills) {
      const p = await writeAutoSkill(c);
      if (p && onNotice) onNotice(`auto-skill: ${c.name} → ${p}`);
    }
  } catch (e) { if (onNotice) onNotice(`auto-skill skipped: ${(e as Error).message?.slice(0, 120)}`); }
}

export class Session {
  readonly messages: ModelMessage[];
  tools: ToolSet;
  readonly notebook: Notebook;
  inputTokens = 0;
  outputTokens = 0;
  /** Subagent token use, priced against the subagent's own model id in /cost. */
  subagentInputTokens = 0;
  subagentOutputTokens = 0;
  private model: LanguageModel;
  private variant: AgentVariant;
  private permissions: Permissions;
  private currentSkills: Skill[];
  private pluginHost: PluginHost | undefined;
  private pendingSkills: Skill[] | undefined;
  private pendingHost: PluginHost | undefined;
  /** Calls seen this turn, for the repeat guard. Cleared per turn, not per step. */
  private readonly seen = new Map<string, number>();
  /** One stale-item repair per turn, so a repeating 404 cannot loop the run. */
  private staleItemsRepaired = false;
  /** The 80% spend warning is shown once, not on every turn past the line. */
  private warnedSpend = false;
  private controller: AbortController | undefined;
  private readonly snapshots = new SnapshotStack();
  private turnBeforeLen = 0;
  private turnBeforeFiles = new Map<string, FileState>();
  private learnTurns = 0;
  private lastLearnLen = 0;
  /** Versions of the volatile prompt parts; a change busts the system-prompt cache. */
  private readonly versions = { notebook: 0, memory: 0, skills: 0, plugins: 0, tools: 0, workspace: 0, workflow: 0 };
  private promptCache: { key: string; text: string } | undefined;
  private readonly cacheStats = { hits: 0, misses: 0 };
  /** Current ignore-aware file list; refreshed at turn boundaries after writes. */
  private workspaceFiles: readonly string[] | undefined;
  private lastWalkSeq = 0;
  /** USD at the start of the current turn, for the per-turn cap. */
  private turnStartUsd: number | undefined;
  /** One notice per turn when the per-turn cap trips, so a capped turn is not silent. */
  private turnCappedNotice: string | undefined;
  /** Did the current turn call todo_write? Gates the workflow nudge. */
  private todoWrittenThisTurn = false;
  /** Fired at most once per session: an agent that edits without updating the task list. */
  private workflowNudged = false;
  /** Line count of TODO.md at last check, for /workflow. */
  private workflowTodoLines = 0;
  private workflowRoadmapLines = 0;
  private workflowDocsFiles = 0;
  private workflowHasTodo = false;
  private workflowHasRoadmap = false;
  private workflowHasDocs = false;

  constructor(private readonly opts: SessionOptions) {
    this.messages = opts.messages ?? [];
    // The notebook's onChange is wrapped so a todo_write mid-turn bumps the
    // prompt-cache version: the task list is part of the system prompt, so a
    // stale cached prompt would keep serving an outdated plan.
    this.notebook = new Notebook((state) => {
      this.opts.onNotebookChange?.(state);
      this.bump('notebook');
    });
    this.notebook.restore(opts.notebook);
    this.model = opts.model;
    this.variant = opts.agent ?? DEFAULT_VARIANT;
    this.currentSkills = opts.skills ?? [];
    this.pluginHost = opts.plugins;
    this.workspaceFiles = opts.workspaceFiles;
    this.lastWalkSeq = this.fileChangeSeq;
    // remember/recall/forget change what memory.render() prints next turn, so
    // they must invalidate the cached prompt.
    this.opts.memory?.setOnChange?.(() => this.bump('memory'));
    const built = this.buildSessionTools();
    this.tools = built.tools;
    this.permissions = built.permissions;
  }

  private buildSessionTools(): { tools: ToolSet; permissions: Permissions } {
    // skill tool reads live currentSkills so hot-reload is visible next turn
    const skillTool: ToolSet = this.currentSkills.length > 0 ? { skill: this.createLiveSkillTool() } : {};
    const sessionTools: ToolSet = {
      ...this.notebook.tools(),
      ...(this.opts.memory ? this.opts.memory.tools() : {}),
      ...skillTool,
      ...(this.opts.ask ? { ask: createAskTool(this.opts.ask) } : {}),
    };
    const tools: ToolSet = { ...builtinTools, ...sessionTools, ...(this.pluginHost?.tools ?? {}), ...(this.opts.extraTools ?? {}) };
    const permissions = new Permissions({
      ...(this.opts.permissions ? { config: this.opts.permissions } : {}),
      ...(this.opts.yolo ? { yolo: true } : {}),
      autoApprove: [
        ...(this.opts.autoApprove ?? []),
        ...(this.pluginHost?.autoApprove ?? []),
        ...Object.keys(sessionTools),
      ],
    });
    return { tools, permissions };
  }

  private createLiveSkillTool() {
    const getSkills = () => this.currentSkills;
    // keep description static at create time to satisfy tool() typing, but lookup is live
    const names = getSkills().map(s=>s.name).join(', ') || 'none';
    // use imported tool/z directly so types stay clean
    const { tool: mkTool } = require('ai') as unknown as { tool: typeof import('ai').tool };
    const zod = require('zod') as unknown as typeof import('zod');
    return mkTool({
      description: 'Load a skill: detailed instructions for one kind of task. Call it as soon as a skill description matches what you are about to do, then follow what it says. Available: ' + names + '.',
      inputSchema: zod.z.object({ name: zod.z.string().describe('Skill name from the list in your instructions') }),
      execute: async ({ name }: { name: string }) => {
        const skills = getSkills();
        const skill = skills.find(s => s.name === name.trim().toLowerCase());
        if (!skill) throw new Error(`No skill named "${name}". Available: ${skills.map(s=>s.name).join(', ') || 'none'}`);
        return `Skill "${skill.name}" (${skill.origin}). Follow these instructions for this task.\n\n${skill.body}`;
      },
    });
  }

  private rebuild(): void {
    const built = this.buildSessionTools();
    this.tools = built.tools;
    this.permissions = built.permissions;
    this.bump('tools');
  }

  /** Hot-reload: skills/plugins take effect next turn; in-flight turn is untouched. */
  updateSkills(skills: Skill[]): void {
    this.bump('skills');
    if (this.controller) { this.pendingSkills = skills; return; }
    this.currentSkills = skills;
    this.rebuild();
  }
  updatePlugins(host: PluginHost): void {
    this.bump('plugins');
    if (this.controller) { this.pendingHost = host; return; }
    this.pluginHost = host;
    this.rebuild();
  }
  private drainPendingHotReload(): void {
    let changed = false;
    if (this.pendingSkills !== undefined) { this.currentSkills = this.pendingSkills; this.pendingSkills = undefined; changed = true; }
    if (this.pendingHost !== undefined) { this.pluginHost = this.pendingHost; this.pendingHost = undefined; changed = true; }
    if (changed) this.rebuild();
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
      const blocked = await (this.pluginHost ?? this.opts.plugins)?.guard({
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
    this.bump('tools');
  }

  setAgent(variant: AgentVariant): void {
    this.variant = variant;
    this.bump('skills');
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
    // __mcpServerNames is bookkeeping, not a tool
    const all = Object.keys(this.tools).filter((name) => name !== '__mcpServerNames' && !withheld.has(name));
    if (!this.variant.allowTools) return all;
    return all.filter((name) => this.variant.allowTools!.includes(name));
  }

  private bump(part: keyof Session['versions']): void {
    this.versions[part] += 1;
    this.promptCache = undefined;
  }

  /** Cache hit rate for the system prompt, surfaced in /cost. */
  promptCacheStats(): { hits: number; misses: number } {
    return { ...this.cacheStats };
  }

  /**
   * The git root of the workspace, walking up like instructions.ts does.
   * Returns undefined outside a repo (bare dirs get no project workflow).
   * Sync: called on the hot path (systemFor), must not block, so it uses
   * Node's existsSync over Bun.file(...).exists().
   */
  private gitRoot(): string | undefined {
    try {
      let dir = resolve(this.opts.cwd ?? process.cwd());
      while (true) {
        if (existsSync(join(dir, '.git', 'HEAD'))) return dir;
        const parent = dirname(dir);
        if (parent === dir) return undefined;
        dir = parent;
      }
    } catch {
      return undefined;
    }
  }

  /**
   * Rendered only when the project tracks its own progress (TODO.md/ROADMAP.md
   * or a docs dir), so a bare repo gets no noise. The policy is guidance, not
   * a gate: the agent stays in control, but it knows this project expects
   * task tracking, docs-driven dev, tests, and verification.
   */
  private workflowPolicy(): string {
    if (this.opts.workflow?.enabled === false) return '';
    const root = this.gitRoot();
    if (!root) return '';
    if (!this.workflowChecked) {
      try {
        this.workflowChecked = true;
        const todoPath = join(root, 'TODO.md');
        const roadmapPath = join(root, 'ROADMAP.md');
        this.workflowHasTodo = existsSync(todoPath);
        this.workflowHasRoadmap = existsSync(roadmapPath);
        if (this.workflowHasTodo) {
          try {
            this.workflowTodoLines = readFileSync(todoPath, 'utf8').split('\n').length;
          } catch {
            this.workflowTodoLines = 0;
          }
        }
        if (this.workflowHasRoadmap) {
          try {
            this.workflowRoadmapLines = readFileSync(roadmapPath, 'utf8').split('\n').length;
          } catch {
            this.workflowRoadmapLines = 0;
          }
        }
        const docsDir = join(root, this.opts.workflow?.docsDir ?? 'docs');
        try {
          if (existsSync(docsDir) && statSync(docsDir).isDirectory()) {
            this.workflowHasDocs = true;
            let count = 0;
            try {
              const walkDir = (d: string): void => {
                for (const e of readdirSync(d, { withFileTypes: true })) {
                  if (count > 200) return;
                  const p = join(d, e.name);
                  if (e.isDirectory()) walkDir(p);
                  else count += 1;
                }
              };
              walkDir(docsDir);
            } catch {}
            this.workflowDocsFiles = count;
          }
        } catch {}
      } catch {}
    }
    if (!this.workflowHasTodo && !this.workflowHasRoadmap && !this.workflowHasDocs) return '';
    const lines = [
      'This repo tracks its own progress. When you start real work here:',
      '- read TODO.md (task list) before starting and keep it current as you go: mark what you did',
      '- keep ROADMAP.md current when you ship a milestone',
      '- for anything non-trivial, write a short plan first (spec-first), then code',
      '- add tests alongside code; this project expects complete unit tests, not just happy paths',
      '- verify with the project\'s check commands (tests/typecheck/build) before declaring done',
    ];
    return lines.join('\n');
  }

  private workflowChecked = false;
  private checkWorkflowState(_root: string): void {
    // kept for backwards compat — logic now in workflowPolicy()
  }

  /**
   * One soft line after a turn that wrote files without touching the task
   * list. Not a stop — it keeps the agent moving while reminding it the
   * project expects the plan kept current. Fires at most once per session.
   */
  private workflowNudge(): string | undefined {
    if (this.opts.workflow?.enabled === false) return undefined;
    if (this.workflowNudged) return undefined;
    const root = this.gitRoot();
    if (!root) return undefined;
    if (!this.workflowChecked) this.workflowPolicy();
    if (!this.workflowHasTodo && !this.workflowHasRoadmap) return undefined;
    if (this.todoWrittenThisTurn) return undefined;
    // fileChangeSeq bump lives in onBeforeWrite (async), but lastWalkSeq is
    // refreshed after the turn; compare at turn end: if no onBeforeWrite
    // fired, this turn changed nothing — no nudge.
    if (this.fileChangeSeq <= this.lastWalkSeq && this.fileChangeSeq === 0) return undefined;
    // Only when onBeforeWrite actually fired (a write succeeded) and no todo_write
    const hasWrites = this.turnBeforeFiles?.size > 0;
    if (!hasWrites) return undefined;
    this.workflowNudged = true;
    return 'reminder: you modified files without updating the project task list (TODO.md). Keep it current: mark what you did.';
  }

  /**
   * A deep, independent copy of the session's messages up to a turn boundary —
   * the messages strictly before the most recent user prompt. The current
   * session is untouched: /fork builds a fresh session elsewhere from the copy,
   * so trying a different approach costs nothing and the original survives.
   */
  fork(atIndex?: number): ModelMessage[] {
    const idx = atIndex ?? this.turnBeforeLen;
    const slice = this.messages.slice(0, Math.max(0, Math.min(idx, this.messages.length)));
    return JSON.parse(JSON.stringify(slice)) as ModelMessage[];
  }

  /** Re-walks the workspace file list when files changed this turn, bounded at 5000. */
  async refreshWorkspaceFiles(force = false): Promise<void> {
    if (!force && this.fileChangeSeq <= this.lastWalkSeq) return;
    this.lastWalkSeq = this.fileChangeSeq;
    const found: string[] = [];
    try {
      for await (const rel of walk({ limit: 5000 })) found.push(rel);
    } catch {
      return; // an unreadable workspace keeps the last list; a walk must not break a turn
    }
    this.workspaceFiles = found;
    this.bump('workspace');
  }

  /** The current ignore-aware workspace list, for tests and the /changes surface. */
  workspaceList(): readonly string[] {
    return this.workspaceFiles ?? [];
  }

  reset(): void {
    this.messages.length = 0;
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.subagentInputTokens = 0;
    this.subagentOutputTokens = 0;
    this.warnedSpend = false;
    this.notebook.clear();
    this.snapshots.clear();
    this.opts.onChange?.(this.messages);
  }

  /**
   * Project workflow state for /workflow: what the repo tracks, whether the
   * policy is rendered, and how much of the workflow the session exercised.
   */
  workflowStatus(): {
    enabled: boolean;
    hasTodo: boolean;
    todoLines: number;
    hasRoadmap: boolean;
    roadmapLines: number;
    hasDocs: boolean;
    docsFiles: number;
    nudged: boolean;
  } {
    const root = this.gitRoot();
    if (!this.workflowChecked && root) this.workflowPolicy();
    return {
      enabled: this.opts.workflow?.enabled !== false,
      hasTodo: this.workflowHasTodo,
      todoLines: this.workflowTodoLines,
      hasRoadmap: this.workflowHasRoadmap,
      roadmapLines: this.workflowRoadmapLines,
      hasDocs: this.workflowHasDocs,
      docsFiles: this.workflowDocsFiles,
      nudged: this.workflowNudged,
    };
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

  maxSpendPerTurn(): number | undefined {
    return this.opts.maxSpendPerTurn;
  }

  canUndo(): boolean { return this.snapshots.canUndo(); }
  canRedo(): boolean { return this.snapshots.canRedo(); }

  /** Monotonically increments when a file is first touched in a turn — lets the `@` completer know its cache is stale. */
  fileChangeSeq = 0;

  async undo(): Promise<string> {
    const snap = this.snapshots.popForUndo();
    if (!snap) throw new Error('nothing to undo');
    await this.restoreFiles(snap.beforeFiles);
    // truncate messages to beforeLen; the tail is kept inside snap for redo
    this.messages.length = snap.beforeLen;
    this.opts.onChange?.(this.messages);
    const n = snap.beforeFiles.size;
    const filesNote = n === 0 ? 'no files to restore' : `${n} file(s) restored`;
    const msgNote = snap.afterLen > snap.beforeLen ? `${snap.afterLen - snap.beforeLen} message(s) removed` : 'no messages to remove';
    return `undone: ${filesNote}, ${msgNote} (bash effects, if any, were not snapshotted)`;
  }

  async redo(): Promise<string> {
    const snap = this.snapshots.popForRedo();
    if (!snap) throw new Error('nothing to redo');
    await this.restoreFiles(snap.afterFiles);
    // redo replays the tail that undo removed; stored in afterFiles? we also need messages tail.
    // The messages tail is the slice that was removed on undo; reconstruct by re-inserting from stored span is not enough
    // because snapshots hold beforeLen/afterLen but not the actual messages content.
    // We store the removed tail inside the snapshot at push time as an extra field via (snap as any)._tail.
    const tail = (snap as unknown as { _tail?: import('ai').ModelMessage[] })._tail;
    if (tail && tail.length > 0) {
      this.messages.push(...tail);
      this.opts.onChange?.(this.messages);
    }
    const n = snap.afterFiles.size;
    const filesNote = n === 0 ? 'no files to restore' : `${n} file(s) restored`;
    return `redone: ${filesNote} (bash effects, if any, were not snapshotted)`;
  }

  private async restoreFiles(state: Map<string, FileState>): Promise<void> {
    for (const [abs, st] of state) {
      try {
        if (!st.existed) {
          if (await Bun.file(abs).exists()) await Bun.file(abs).delete();
        } else {
          await Bun.write(abs, st.content ?? '');
        }
        this.fileChangeSeq += 1;
      } catch {
        // best-effort per file; one failure should not stop the rest
      }
    }
  }

  /**
   * What the most recent turn changed on disk, derived from the undo snapshot's
   * before/after file states. Bash effects are not included, exactly as with
   * /undo — a shell command's effects cannot be diffed from a snapshot.
   */
  lastTurnSummary(): ChangeSummary | undefined {
    const snap = this.snapshots.peek();
    if (!snap) return undefined;
    const added: string[] = [];
    const modified: string[] = [];
    const deleted: string[] = [];
    for (const [abs, before] of snap.beforeFiles) {
      const after = snap.afterFiles.get(abs);
      if (!after) continue; // not captured after (write failed); skip
      if (!before.existed && after.existed) added.push(abs);
      else if (before.existed && !after.existed) deleted.push(abs);
      else if (before.content !== after.content) modified.push(abs);
    }
    // Files created and listed in afterFiles but absent from beforeFiles are
    // brand-new; the hook only records touched paths, so they always appear.
    for (const [abs, after] of snap.afterFiles) {
      if (!snap.beforeFiles.has(abs) && after.existed) added.push(abs);
    }
    if (added.length === 0 && modified.length === 0 && deleted.length === 0) return undefined;
    return { added, modified, deleted };
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

  private mcpServerNamesForPrompt(): string[] | undefined {
    const hasMeta = this.tools['mcp_list'] !== undefined;
    if (!hasMeta) return undefined;
    const marker = (this.tools as Record<string, unknown>)['__mcpServerNames'];
    if (Array.isArray(marker) && marker.length > 0) return [...marker].sort() as string[];
    // fallback: derive from direct if marker missing (tests that inject tools manually)
    const direct = Object.keys(this.tools).filter((n) => n.startsWith('mcp__'));
    if (direct.length === 0) return undefined;
    const names = new Set<string>();
    for (const n of direct) {
      const m = /^mcp__([^_]+(?:_[^_]+)*)__/.exec(n);
      if (m) names.add(m[1]!);
    }
    return names.size > 0 ? [...names].sort() : undefined;
  }

  private systemFor(): string {
    const versionKey = [
      `nb:${this.versions.notebook}`,
      `mem:${this.versions.memory}`,
      `sk:${this.versions.skills}`,
      `pl:${this.versions.plugins}`,
      `tl:${this.versions.tools}`,
      `ws:${this.versions.workspace}`,
      `wf:${this.versions.workflow ?? 0}`,
    ].join('|');
    if (this.promptCache && this.promptCache.key === versionKey) {
      this.cacheStats.hits += 1;
      return this.promptCache.text;
    }
    this.cacheStats.misses += 1;

    const mem = this.opts.memory;
    const memoryBlock = mem ? mem.render() : '';
    const text = systemPrompt({
      cwd: this.opts.cwd ?? process.cwd(),
      instructions: this.opts.instructions ?? [],
      notebook: this.notebook.render(),
      memory: memoryBlock,
      skills: renderSkills(this.currentSkills),
      agent: renderAgent(this.variant),
      plugins: this.pluginHost?.appendix ?? '',
      availableTools: this.activeTools(),
      canAsk: this.opts.ask !== undefined && this.activeTools().includes('ask'),
      ...(this.mcpServerNamesForPrompt() ? { mcpServers: this.mcpServerNamesForPrompt() } : {}),
      ...(this.workspaceFiles && this.workspaceFiles.length > 0 ? { workspaceFiles: this.workspaceFiles } : {}),
      ...(this.workflowPolicy() ? { workflowPolicy: this.workflowPolicy() } : {}),
    });
    this.promptCache = { key: versionKey, text };
    return text;
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

      const blocked = await (this.pluginHost ?? this.opts.plugins)?.guard({
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

    // snapshot boundary: remember messages length before this turn and arm file capture
    this.turnBeforeLen = this.messages.length;
    this.turnBeforeFiles = new Map<string, FileState>();
    this.turnStartUsd = this.spend().usd;
    this.turnCappedNotice = undefined;
    this.todoWrittenThisTurn = false;
    onBeforeWrite(async (abs: string) => {
      if (this.turnBeforeFiles.has(abs)) return;
      const exists = await Bun.file(abs).exists();
      let content: string | null = null;
      if (exists) {
        try { content = await Bun.file(abs).text(); } catch { content = null; }
      }
      this.turnBeforeFiles.set(abs, { existed: exists, content });
      this.fileChangeSeq += 1;
    });
    this.messages.push({ role: 'user', content: userText });
    this.opts.onChange?.(this.messages);
    this.controller = new AbortController();
    const signal = this.controller.signal;
    const threshold = this.compactThreshold();
    // Per turn, not per step: a tool called once in each of three steps is the
    // loop this guards against.
    this.seen.clear();
    this.staleItemsRepaired = false;

    const outputs: Extract<AgentEvent, { type: 'tool-output' }>[] = [];
    onBashOutput(({ toolCallId, chunk }) => {
      outputs.push({ type: 'tool-output', id: toolCallId, chunk });
      this.opts.onToolOutput?.(toolCallId, chunk);
    });

    let turnFailed = false;
    try {
      yield* this.run(signal, threshold, outputs);
    } catch (e) {
      turnFailed = true;
      throw e;
    } finally {
      onBeforeWrite(undefined);
      // finalize snapshot only for turns that actually ran (even if they errored after writing files,
      // the file state is still worth snapshotting so undo can revert a half-failed turn)
      try {
        if (this.turnBeforeFiles.size > 0 || this.messages.length > this.turnBeforeLen) {
          const afterFiles = new Map<string, FileState>();
          for (const abs of this.turnBeforeFiles.keys()) {
            const exists = await Bun.file(abs).exists();
            let content: string | null = null;
            if (exists) { try { content = await Bun.file(abs).text(); } catch { content = null; } }
            afterFiles.set(abs, { existed: exists, content });
          }
          // tail for redo: the messages added by this turn
          const tail = this.messages.slice(this.turnBeforeLen).map((m) => ({ ...m, content: typeof m.content === 'string' ? m.content : JSON.parse(JSON.stringify(m.content)) } as import('ai').ModelMessage));
          const snap: import('./snapshot').TurnSnapshot & { _tail?: import('ai').ModelMessage[] } = {
            beforeLen: this.turnBeforeLen,
            afterLen: this.messages.length,
            beforeFiles: new Map(this.turnBeforeFiles),
            afterFiles,
          };
          (snap as unknown as { _tail?: import('ai').ModelMessage[] })._tail = tail;
          // even failed turns push so undo can revert the file side; empty no-op turns are skipped above
          if (!turnFailed || this.turnBeforeFiles.size > 0) this.snapshots.push(snap);
        }
      } catch {}
      this.turnBeforeFiles = new Map<string, FileState>();
      this.controller = undefined;
      this.drainPendingHotReload();
      // Files written this turn are now on disk; re-walk so the next prompt's
      // workspace list shows them without a restart.
      try { await this.refreshWorkspaceFiles(); } catch {}
      onBashOutput(undefined);
      await (this.pluginHost ?? this.opts.plugins)?.afterTurn();
      if (!this.opts.disableAutoLearn && this.messages.length >= 6) {
        this.learnTurns += 1;
        const delta = this.messages.length - this.lastLearnLen;
        const throttled = this.learnTurns % 3 !== 0 && delta < 8;
        if (!throttled) {
          this.lastLearnLen = this.messages.length;
          try {
            await maybeLearn(this.messages, this.model, this.opts.learnerModel, this.opts.memory, () => this.spend(), this.opts.onNotice);
          } catch {}
          // periodic TTL prune so long session doesn't bloat
          if (this.learnTurns % 6 === 0 && this.opts.memory) { try { await this.opts.memory.pruneExpired(); } catch {} }
        }
      }
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

  /** True once a step has pushed this turn's spend past its per-turn cap. */
  private turnOverCap(): boolean {
    const cap = this.opts.maxSpendPerTurn;
    if (cap === undefined || cap <= 0) return false;
    const usd = this.spend().usd;
    const delta = usd !== undefined && this.turnStartUsd !== undefined ? usd - this.turnStartUsd : undefined;
    return delta !== undefined && delta > cap;
  }

  private async *run(
    signal: AbortSignal,
    threshold: number,
    outputs: Extract<AgentEvent, { type: 'tool-output' }>[],
  ): AsyncGenerator<AgentEvent> {
    // Each iteration is one model run. A run ends either finished, or suspended
    // on tool approvals, in which case we collect decisions and run again.
    let compactionReported = false;
    let compactionSpan: ModelMessage[] | undefined;
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
          // Capture what was dropped by reference identity — the lossless note is built after the stream.
          if (!compactionReported && pruned.length < messages.length) {
            compactionSpan = droppedSpan(messages, pruned);
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
              if (part.toolName === 'todo_write') this.todoWrittenThisTurn = true;
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

      // Project workflow: a turn that changed files without touching the task
      // list gets one soft reminder. Keep it below the fold — a nag that
      // repeats would train the model to ignore it.
      const nudge = this.workflowNudge();
      if (nudge) yield { type: 'notice', text: nudge };

      while (compactions.length > 0) yield compactions.shift()!;
      while (outputs.length > 0) yield outputs.shift()!;
      while (guardNotices.length > 0) yield { type: 'notice', text: guardNotices.shift()! };

      this.messages.push(...(await result.responseMessages));
      this.opts.onChange?.(this.messages);

      // Lossless compaction: summarize what the wire pruned so future turns keep it.
      if (compactionSpan && compactionSpan.length > 0) {
        const retained = await summarizeDiscarded(compactionSpan, this.model);
        if (retained) {
          this.messages.push({ role: 'user', content: `Note (retained from compacted history):\n${retained}` });
          this.opts.onChange?.(this.messages);
        }
        compactionSpan = undefined;
      }

      if (pending.length === 0) {
        const usage = await result.usage;
        this.inputTokens += usage.inputTokens ?? 0;
        this.outputTokens += usage.outputTokens ?? 0;
        // Per-turn cap: a `deep` turn that ran away is refusable at a step
        // boundary even when the session ceiling is far away.
        if (this.turnOverCap()) {
          if (!this.turnCappedNotice) {
            const cap = this.opts.maxSpendPerTurn;
            this.turnCappedNotice = `per-turn spend cap reached: this turn used more than ${formatUsd(cap ?? 0)}. Turn stopped.`;
            yield { type: 'notice', text: this.turnCappedNotice };
          }
          yield { type: 'done', inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
          return;
        }
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
