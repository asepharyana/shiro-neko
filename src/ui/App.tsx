import { Box, Static, Text, useApp, useInput, useStdout } from 'ink';
import SelectInput from 'ink-select-input';
import Spinner from 'ink-spinner';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { parseCommand, matchCommands, type CommandSpec } from '../commands';
import { THINKING_LEVELS, VARIANTS } from '../agents';
import { completePath, matchPaths, pathToken } from '../complete';
import type { Config } from '../config';
import { TODO_MARK, type NotebookState } from '../notebook';
import { costOf, formatUsd, usageLine } from '../pricing';
import type { ApprovalDecision, ApprovalRequest, Session } from '../session';
import type { SubagentEvent } from '../subagent';
import { interruptBash, toolSetOf } from '../tools';
import { AskPanel, type AskBridge, type AskPending } from './Ask';
import { Diff } from './Diff';
import { Markdown } from './Markdown';
import { Onboard, type OnboardResult } from './Onboard';
import { InfoPanel, OutputPanel, QueuePanel, StatusBar, SubagentPanel, ThinkingPanel, TodoPanel, ActiveTool, FileMenu, type SubagentView } from './Panels';
import { PromptInput } from './PromptInput';

type Line =
  | { key: string; kind: 'user'; text: string }
  | { key: string; kind: 'assistant'; text: string }
  | { key: string; kind: 'tool'; name: string; summary: string; ok: boolean }
  | { key: string; kind: 'info'; text: string }
  | { key: string; kind: 'error'; text: string };

type NewLine = Line extends infer T ? (T extends Line ? Omit<T, 'key'> : never) : never;

type Pending = { req: ApprovalRequest; resolve: (d: ApprovalDecision) => void };

/** Bridges Session's promise-based approval callback into React state. */
export type ApprovalBridge = {
  bind: (fn: (p: Pending | undefined) => void) => void;
  ask: (req: ApprovalRequest) => Promise<ApprovalDecision>;
};

export function createApprovalBridge(): ApprovalBridge {
  let setter: ((p: Pending | undefined) => void) | undefined;
  return {
    bind(fn) {
      setter = fn;
    },
    ask(req) {
      return new Promise((resolve) => {
        if (!setter) return resolve('deny'); // UI not mounted: fail closed
        setter({
          req,
          resolve: (d) => {
            setter?.(undefined);
            resolve(d);
          },
        });
      });
    },
  };
}

/** One-way channel for out-of-band notices, e.g. an endpoint fallback. */
export type NoticeBus = {
  bind: (fn: (text: string) => void) => void;
  emit: (text: string) => void;
};

export function createNoticeBus(): NoticeBus {
  const queued: string[] = [];
  let sink: ((text: string) => void) | undefined;
  return {
    bind(fn) {
      sink = fn;
      for (const text of queued.splice(0)) fn(text);
    },
    emit(text) {
      if (sink) sink(text);
      else queued.push(text);
    },
  };
}

/** Subagent progress, from the task tool to the panel. */
export type SubagentBus = {
  bind: (fn: (event: SubagentEvent) => void) => void;
  emit: (event: SubagentEvent) => void;
};

export function createSubagentBus(): SubagentBus {
  const queued: SubagentEvent[] = [];
  let sink: ((event: SubagentEvent) => void) | undefined;
  return {
    bind(fn) {
      sink = fn;
      for (const event of queued.splice(0)) fn(event);
    },
    emit(event) {
      if (sink) sink(event);
      else queued.push(event);
    },
  };
}

/** Folds a subagent event into the panel's view, keeping finished agents visible. */
export function applySubagentEvent(current: SubagentView[], event: SubagentEvent): SubagentView[] {
  switch (event.type) {
    case 'start':
      return [
        ...current,
        { id: event.id, kind: event.kind, description: event.description, steps: [], status: 'running' },
      ];
    case 'step':
      return current.map((a) =>
        a.id === event.id ? { ...a, steps: [...a.steps, { tool: event.tool, summary: event.summary }] } : a,
      );
    case 'end':
      return current.map((a) => (a.id === event.id ? { ...a, status: event.ok ? 'done' : 'failed' } : a));
    case 'error':
      return current.map((a) => (a.id === event.id ? { ...a, status: 'failed', error: event.message } : a));
  }
}

/** Everything the slash commands need from the outside world. */
export type AppHooks = {
  sessionId: string;
  config: () => Config;
  switchModel: (id: string) => string;
  switchAgent: (name: string) => string;
  switchThinking: (level: string) => string;
  agentName: () => string;
  thinkingLevel: () => string;
  applyProvider: (result: OnboardResult) => Promise<string>;
  listModels: () => Promise<{ models: string[]; warning?: string }>;
  listSessions: () => Promise<string>;
  listSkills: () => string;
  listPlugins: () => string;
  listMemory: () => Promise<string>;
  summarizeMemory: () => Promise<string>;
  resumeSession: (idOrPrefix: string) => Promise<string>;
  saveSession: () => Promise<string>;
  /** Loaded AGENTS.md-style files, for /context. */
  instructionFiles: () => string[];
  /** Ignore-aware workspace paths for `@` completion, loaded on first use. */
  listPaths: () => Promise<string[]>;
  /** Prompt to hand the model for /init. */
  initPrompt: string;
  history: string[];
  recordPrompt: (text: string) => void;
};

let seq = 0;
const nextKey = () => `l${seq++}`;

function preview(input: unknown): string {
  if (input === null || typeof input !== 'object') return String(input);
  const o = input as Record<string, unknown>;
  const first = o['command'] ?? o['path'] ?? o['pattern'] ?? o['description'] ?? o['question'] ?? o['name'];
  if (typeof first === 'string') return first.length > 90 ? `${first.slice(0, 90)}...` : first;

  // A tool with no obvious label, e.g. todo_write, gets a shape rather than a
  // JSON dump; the panels below already show the content.
  const todos = o['todos'];
  if (Array.isArray(todos)) return `${todos.length} task${todos.length === 1 ? '' : 's'}`;
  const keys = Object.keys(o);
  return keys.length === 0 ? '' : keys.slice(0, 3).join(', ');
}

function ApprovalDetail({ name, input }: { name: string; input: unknown }) {
  const o = (input ?? {}) as Record<string, unknown>;
  if (name === 'bash') return <Text dimColor>{String(o['command'] ?? '')}</Text>;
  if (name === 'write_file') {
    const content = String(o['content'] ?? '');
    return <Diff before="" after={content} path={`${String(o['path'])} (new content)`} />;
  }
  if (name === 'edit_file') {
    return <Diff before={String(o['oldString'] ?? '')} after={String(o['newString'] ?? '')} path={String(o['path'])} />;
  }
  return <Text dimColor>{JSON.stringify(input, null, 2)}</Text>;
}

function Approval({ pending }: { pending: Pending }) {
  useInput((input, key) => {
    const c = input.toLowerCase();
    if (c === 'y' || key.return) pending.resolve('once');
    else if (c === 'a') pending.resolve('always');
    else if (c === 'n' || key.escape) pending.resolve('deny');
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text color="yellow" bold>
        {pending.req.toolName} wants to run
      </Text>
      <ApprovalDetail name={pending.req.toolName} input={pending.req.input} />
      <Text>
        <Text color="green">y</Text> allow once | <Text color="green">a</Text> always allow {pending.req.toolName} |{' '}
        <Text color="red">n</Text> deny
      </Text>
    </Box>
  );
}

function CommandMenu({ matches, index }: { matches: CommandSpec[]; index: number }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      {matches.map((c, i) => (
        <Text key={c.name} color={i === index ? 'cyan' : undefined} dimColor={i !== index}>
          {i === index ? '> ' : '  '}
          {`/${c.name}${c.arg ? ` ${c.arg}` : ''}`.padEnd(18)} {c.summary}
        </Text>
      ))}
      <Text dimColor>up/down move | tab complete | enter run | esc dismiss</Text>
    </Box>
  );
}

export function App({
  session,
  bridge,
  header,
  hooks,
  notices,
  askBridge,
  subagents,
  needsProvider = false,
}: {
  session: Session;
  bridge: ApprovalBridge;
  header: string;
  hooks: AppHooks;
  notices?: NoticeBus;
  askBridge?: AskBridge;
  subagents?: SubagentBus;
  needsProvider?: boolean;
}) {
  const { exit } = useApp();
  const { write } = useStdout();
  const [history, setHistory] = useState<Line[]>([]);
  const [draft, setDraft] = useState('');
  const [live, setLive] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | undefined>();
  const [asking, setAsking] = useState<AskPending | undefined>();
  const [onboarding, setOnboarding] = useState(needsProvider);
  const [unconfigured, setUnconfigured] = useState(needsProvider);
  const [modelPicker, setModelPicker] = useState<string[] | undefined>();
  const [agentPicker, setAgentPicker] = useState(false);
  const [thinkPicker, setThinkPicker] = useState(false);
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [inputGeneration, setInputGeneration] = useState(0);
  const [inputCursor, setInputCursor] = useState(0);
  const [toolOutput, setToolOutput] = useState('');
  const [active, setActive] = useState<{ name: string; summary?: string } | undefined>();
  const [thinking, setThinking] = useState('');
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const [queue, setQueue] = useState<string[]>([]);
  const [cursor, setCursor] = useState(0);
  const [paths, setPaths] = useState<string[] | undefined>();
  const [fileIndex, setFileIndex] = useState(0);
  const [fileDismissed, setFileDismissed] = useState(false);
  const [recall, setRecall] = useState<string[]>(hooks.history);
  const [notebook, setNotebook] = useState<NotebookState>(session.notebook.state());
  const [agents, setAgents] = useState<SubagentView[]>([]);
  const [panel, setPanel] = useState<{ title: string; hint?: string; body: string } | undefined>();

  const modal = pending !== undefined || asking !== undefined || onboarding;
  const anyPicker = modelPicker !== undefined || agentPicker || thinkPicker;
  const matches = matchCommands(draft);
  const menuOpen = matches.length > 0 && !menuDismissed && !busy && !modal && !anyPicker && !panel;
  const highlighted = matches[Math.min(menuIndex, matches.length - 1)];

  const token = pathToken(draft, cursor);
  const fileOpen = token !== undefined && !fileDismissed && !modal && !anyPicker;
  const fileMatches = token && paths ? matchPaths(paths, token.query) : [];
  const highlightedPath = fileMatches[Math.min(fileIndex, Math.max(0, fileMatches.length - 1))];

  // The walk costs a full ignore-aware traversal, so it happens on the first `@`
  // rather than at startup, and only once.
  useEffect(() => {
    if (token === undefined || paths !== undefined) return;
    let live = true;
    void hooks.listPaths().then((all) => {
      if (live) setPaths(all);
    });
    return () => {
      live = false;
    };
  }, [hooks, paths, token]);

  useEffect(() => bridge.bind(setPending), [bridge]);
  useEffect(() => askBridge?.bind(setAsking), [askBridge]);

  useEffect(
    () =>
      subagents?.bind((event) => {
        setAgents((current) => applySubagentEvent(current, event));
      }),
    [subagents],
  );

  // Ink re-renders the whole tree per setState, so deltas accumulate in refs
  // and are flushed on a timer instead of once per token.
  const text = useRef('');
  const reasoning = useRef('');
  useEffect(() => {
    const t = setInterval(() => {
      setLive((s) => (s === text.current ? s : text.current));
      setThinking((s) => (s === reasoning.current ? s : reasoning.current));
    }, 60);
    return () => clearInterval(t);
  }, []);

  // The queue is a ref as well as state: runTurn drains it synchronously as the
  // turn ends, and a stale closure over the array would lose a prompt.
  const queued = useRef<string[]>([]);
  const busyRef = useRef(false);
  const submitRef = useRef<((raw: string) => Promise<void>) | undefined>(undefined);

  // Kept in step with busy, since the queue drain reads it synchronously between
  // renders and a state read there would be one turn stale.
  const setWorking = useCallback((value: boolean) => {
    busyRef.current = value;
    setBusy(value);
  }, []);

  const push = useCallback((line: NewLine) => {
    setHistory((h) => [...h, { ...line, key: nextKey() }]);
  }, []);

  useEffect(() => notices?.bind((text) => push({ kind: 'info', text })), [notices, push]);

  useInput(
    (input, key) => {
      // esc drops the queue too: interrupting and then watching two more prompts
      // fire anyway is not what anyone means by interrupt.
      if (key.escape) {
        queued.current.length = 0;
        setQueue([]);
        session.abort();
        return;
      }
      if (key.ctrl && input === 'r') setThinkingOpen((o) => !o);
    },
    { isActive: busy && !modal },
  );

  // ctrl-c kills only the command in flight, leaving the turn alive so the model
  // gets a tool error and can decide what to do. With nothing running it keeps its
  // usual meaning and quits, which is why Ink's own ctrl-c handling is turned off
  // in cli.tsx rather than left to race with this.
  useInput((input, key) => {
    if (!key.ctrl || input !== 'c') return;
    const killed = interruptBash();
    if (killed.length === 0) return exit();
    push({ kind: 'info', text: `interrupted: ${killed.join(', ')}` });
  });

  useInput(
    (_input, key) => {
      if (!key.escape) return;
      setModelPicker(undefined);
      setAgentPicker(false);
      setThinkPicker(false);
    },
    { isActive: anyPicker },
  );

  // PromptInput hands up/down/tab/esc to us first, so the menus and any open panel
  // can claim them before the input treats them as editing keys.
  const handleInputKey = useCallback(
    (_input: string, key: { upArrow: boolean; downArrow: boolean; tab: boolean; escape: boolean; return: boolean }) => {
      if (key.escape && panel) {
        setPanel(undefined);
        return true;
      }

      // The file picker gets first refusal: while an `@` token is open its keys
      // mean navigation, not history recall or command completion.
      if (fileOpen) {
        if (key.escape) {
          setFileDismissed(true);
          return true;
        }
        if (fileMatches.length > 0) {
          if (key.upArrow) {
            setFileIndex((i) => (i - 1 + fileMatches.length) % fileMatches.length);
            return true;
          }
          if (key.downArrow) {
            setFileIndex((i) => (i + 1) % fileMatches.length);
            return true;
          }
          if ((key.tab || key.return) && highlightedPath && token) {
            const next = completePath(draft, token, highlightedPath);
            setDraft(next.value);
            setCursor(next.cursor);
            setFileIndex(0);
            setInputCursor(next.cursor);
            setInputGeneration((g) => g + 1);
            return true;
          }
        }
      }

      if (!menuOpen) return false;
      if (key.escape) {
        setMenuDismissed(true);
        return true;
      }
      if (key.upArrow) {
        setMenuIndex((i) => (i - 1 + matches.length) % matches.length);
        return true;
      }
      if (key.downArrow) {
        setMenuIndex((i) => (i + 1) % matches.length);
        return true;
      }
      if (key.tab && highlighted) {
        const value = highlighted.arg ? `/${highlighted.name} ` : `/${highlighted.name}`;
        setDraft(value);
        setCursor(value.length);
        setMenuIndex(0);
        setMenuDismissed(true);
        setInputCursor(value.length);
        setInputGeneration((g) => g + 1);
        return true;
      }
      return false;
    },
    [draft, fileMatches.length, fileOpen, highlighted, highlightedPath, matches.length, menuOpen, panel, token],
  );

  const onDraftChange = useCallback((value: string, at: number) => {
    setDraft(value);
    setCursor(at);
    setMenuIndex(0);
    setMenuDismissed(false);
    setFileIndex(0);
    setFileDismissed(false);
  }, []);

  const runTurn = useCallback(
    async (value: string) => {
      setWorking(true);
      text.current = '';
      reasoning.current = '';
      setThinking('');

      for await (const ev of session.send(value)) {
        switch (ev.type) {
          case 'text':
            text.current += ev.text;
            break;
          case 'reasoning':
            reasoning.current += ev.text;
            break;
          case 'tool-start':
            setActive({ name: ev.name });
            break;
          case 'tool-call':
            setActive({ name: ev.name, summary: preview(ev.input) });
            push({ kind: 'tool', name: ev.name, summary: preview(ev.input), ok: true });
            break;
          case 'tool-output':
            setToolOutput((s) => `${s}${ev.chunk}`.slice(-2000));
            break;
          case 'tool-error':
            setActive(undefined);
            push({ kind: 'tool', name: ev.name, summary: String(ev.error), ok: false });
            break;
          case 'tool-result':
            setActive(undefined);
            setToolOutput('');
            setNotebook(session.notebook.state());
            break;
          case 'tool-denied':
            setActive(undefined);
            push({ kind: 'info', text: `denied ${ev.name}` });
            break;
          case 'notice':
            push({ kind: 'info', text: ev.text });
            break;
          case 'compacted':
            push({ kind: 'info', text: `context compacted: ${ev.before} messages pruned to ${ev.after} on the wire` });
            break;
          case 'error':
            push({ kind: 'error', text: ev.error instanceof Error ? ev.error.message : String(ev.error) });
            break;
          case 'done': {
            const full = text.current.trim();
            text.current = '';
            // Reasoning is progress, not the answer, so it leaves with the turn.
            reasoning.current = '';
            setThinking('');
            setLive('');
            setActive(undefined);
            setToolOutput('');
            setAgents([]);
            setHistory((h) => {
              const merged: Line[] = [...h];
              if (full) merged.push({ kind: 'assistant', text: full, key: nextKey() });
              if (ev.inputTokens !== undefined) {
                merged.push({
                  kind: 'info',
                  text: `${usageLine(hooks.config().model, ev.inputTokens, ev.outputTokens ?? 0)}  (~${session.estimatedTokens()} in context)`,
                  key: nextKey(),
                });
              }
              return merged;
            });
            break;
          }
          default:
            break;
        }
      }

      setWorking(false);

      // Drain one queued prompt per finished turn, in order. Going back through
      // submit means a queued slash command behaves exactly as if typed now, and
      // its own turn drains the next one.
      const next = queued.current.shift();
      if (next !== undefined) {
        setQueue([...queued.current]);
        await submitRef.current?.(next);
      }
    },
    [hooks, push, session, setWorking],
  );

  const submit = useCallback(
    async (raw: string) => {
      setDraft('');
      setCursor(0);
      setMenuIndex(0);
      setMenuDismissed(false);
      setFileIndex(0);
      setFileDismissed(false);
      setPanel(undefined);

      // Enter on an open menu runs the highlighted entry, so `/mo` + enter works.
      const chosen = menuOpen && highlighted ? `/${highlighted.name}` : raw;
      const action = parseCommand(chosen);

      switch (action.type) {
        case 'none':
          return;
        case 'exit':
          return exit();
        default:
          break;
      }

      // Typed during a turn: queue it whole, including a slash command, and let
      // the drain replay it once the model is free. Losing the thought to a
      // swallowed keystroke is the thing this exists to prevent.
      if (busyRef.current) {
        queued.current.push(chosen);
        setQueue([...queued.current]);
        return;
      }

      // Nothing can reach the model until a provider is configured.
      if (unconfigured && action.type !== 'provider' && action.type !== 'info') {
        push({ kind: 'user', text: chosen.trim() });
        push({ kind: 'error', text: 'no provider configured yet - run /provider' });
        return;
      }

      switch (action.type) {
        case 'clear':
          session.reset();
          setHistory([]);
          setNotebook(session.notebook.state());
          // <Static> lines are already committed to the scrollback, so clearing
          // React state alone leaves them on screen. Wipe screen + scrollback.
          write('\u001B[2J\u001B[3J\u001B[H');
          return;
        case 'info':
          push({ kind: 'user', text: chosen.trim() });
          setPanel({ title: 'commands', hint: 'type / for the menu', body: action.text });
          return;
        case 'unknown':
          push({ kind: 'user', text: chosen.trim() });
          push({ kind: 'error', text: `unknown command /${action.name} - try /help` });
          return;
        case 'tools':
          push({ kind: 'user', text: chosen.trim() });
          setPanel({
            title: 'tools',
            hint: `${session.activeTools().length} offered this turn of ${Object.keys(session.tools).length} registered`,
            body: session
              .activeTools()
              .sort()
              .map((t) => {
                const set = toolSetOf(t);
                return `- \`${t}\`${set ? `  ${set}` : ''}`;
              })
              .join('\n'),
          });
          return;
        case 'cost': {
          push({ kind: 'user', text: chosen.trim() });
          const model = hooks.config().model;
          const spend = costOf(model, session.inputTokens, session.outputTokens);
          setPanel({
            title: 'cost',
            hint: `session ${hooks.sessionId}`,
            body: [
              `- model: \`${model}\``,
              `- billed: ${session.inputTokens} in / ${session.outputTokens} out`,
              `- spend: ${spend === undefined ? 'unpriced model' : formatUsd(spend)}`,
              `- context: ~${session.estimatedTokens()} tokens`,
              `- agent: \`${hooks.agentName()}\` thinking \`${hooks.thinkingLevel()}\``,
            ].join('\n'),
          });
          return;
        }
        case 'context': {
          push({ kind: 'user', text: chosen.trim() });
          const files = hooks.instructionFiles();
          setPanel({
            title: 'project instructions',
            body: files.length
              ? files.map((f) => `- \`${f}\``).join('\n')
              : 'No `AGENTS.md`, `CLAUDE.md`, or `.shiro.md` found. Run `/init` to write one.',
          });
          return;
        }
        case 'todos': {
          push({ kind: 'user', text: chosen.trim() });
          const { todos } = session.notebook.state();
          setPanel({
            title: 'task list',
            body: todos.length
              ? todos.map((t) => `- ${TODO_MARK[t.status]} ${t.content}${t.note ? ` (${t.note})` : ''}`).join('\n')
              : 'No task list yet.',
          });
          return;
        }
        case 'notes': {
          push({ kind: 'user', text: chosen.trim() });
          setPanel({ title: 'project memory', body: await hooks.listMemory() });
          return;
        }
        case 'agent': {
          push({ kind: 'user', text: chosen.trim() });
          if (action.agent) {
            try {
              push({ kind: 'info', text: hooks.switchAgent(action.agent) });
            } catch (e) {
              push({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
            }
            return;
          }
          setAgentPicker(true);
          return;
        }
        case 'think': {
          push({ kind: 'user', text: chosen.trim() });
          if (action.level) {
            try {
              push({ kind: 'info', text: hooks.switchThinking(action.level) });
            } catch (e) {
              push({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
            }
            return;
          }
          setThinkPicker(true);
          return;
        }
        case 'skills':
          push({ kind: 'user', text: chosen.trim() });
          setPanel({ title: 'skills', hint: 'the agent loads one with the skill tool', body: hooks.listSkills() });
          return;
        case 'plugins':
          push({ kind: 'user', text: chosen.trim() });
          setPanel({ title: 'plugins', body: hooks.listPlugins() });
          return;
        case 'memory': {
          push({ kind: 'user', text: chosen.trim() });
          setWorking(true);
          try {
            push({ kind: 'info', text: await hooks.summarizeMemory() });
          } catch (e) {
            push({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
          }
          setWorking(false);
          return;
        }
        case 'init':
          push({ kind: 'user', text: chosen.trim() });
          await runTurn(hooks.initPrompt);
          return;
        case 'model':
          push({ kind: 'user', text: chosen.trim() });
          try {
            push({ kind: 'info', text: hooks.switchModel(action.model) });
          } catch (e) {
            push({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
          }
          return;
        case 'sessions':
          push({ kind: 'user', text: chosen.trim() });
          push({ kind: 'info', text: await hooks.listSessions() });
          return;
        case 'save':
          push({ kind: 'user', text: chosen.trim() });
          push({ kind: 'info', text: await hooks.saveSession() });
          return;
        case 'resume':
          push({ kind: 'user', text: chosen.trim() });
          try {
            const msg = await hooks.resumeSession(action.id);
            setHistory([]);
            push({ kind: 'info', text: msg });
          } catch (e) {
            push({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
          }
          return;
        case 'provider':
          push({ kind: 'user', text: chosen.trim() });
          setOnboarding(true);
          return;
        case 'models': {
          push({ kind: 'user', text: chosen.trim() });
          setWorking(true);
          const { models, warning } = await hooks.listModels();
          setWorking(false);
          if (warning) push({ kind: 'info', text: `could not list models: ${warning}` });
          if (models.length === 0) {
            push({ kind: 'error', text: 'no models to choose from - use /model <id> or /provider' });
            return;
          }
          setModelPicker(models);
          return;
        }
        case 'compact': {
          push({ kind: 'user', text: chosen.trim() });
          setWorking(true);
          try {
            const { before, after } = await session.summarize();
            push({ kind: 'info', text: `compacted ${before} messages into ${after}` });
          } catch (e) {
            push({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
          }
          setWorking(false);
          return;
        }
        case 'prompt':
          push({ kind: 'user', text: action.text });
          hooks.recordPrompt(action.text);
          setRecall((h) => (h.at(-1) === action.text ? h : [...h, action.text]));
          await runTurn(action.text);
          return;
      }
    },
    [exit, highlighted, hooks, menuOpen, push, runTurn, session, setWorking, unconfigured, write],
  );

  useEffect(() => {
    submitRef.current = submit;
  }, [submit]);

  return (
    <Box flexDirection="column">
      <Static items={history}>
        {(line) => (
          <Box key={line.key} flexDirection="column" marginBottom={1}>
            {line.kind === 'user' && <Text color="cyan">{`> ${line.text}`}</Text>}
            {line.kind === 'assistant' && <Markdown text={line.text} />}
            {line.kind === 'tool' && (
              <Text color={line.ok ? 'magenta' : 'red'}>
                {line.ok ? '*' : 'x'} {line.name}({line.summary})
              </Text>
            )}
            {line.kind === 'info' && <Text dimColor>{line.text}</Text>}
            {line.kind === 'error' && <Text color="red">error: {line.text}</Text>}
          </Box>
        )}
      </Static>

      {history.length === 0 && (
        <Box marginBottom={1}>
          <Text dimColor>{header}</Text>
        </Box>
      )}

      {agents.length > 0 && <SubagentPanel agents={agents} />}

      {notebook.todos.length > 0 && <TodoPanel todos={notebook.todos} />}

      {live.length > 0 && (
        <Box marginBottom={1}>
          <Markdown text={live} />
        </Box>
      )}

      {panel && (
        <InfoPanel title={panel.title} {...(panel.hint ? { hint: panel.hint } : {})} lines={panel.body} />
      )}

      {asking && <AskPanel pending={asking} />}

      {pending && <Approval pending={pending} />}

      {onboarding && (
        <Onboard
          current={hooks.config()}
          onCancel={() => {
            setOnboarding(false);
            push({ kind: 'info', text: 'provider setup cancelled' });
          }}
          onDone={async (result) => {
            setOnboarding(false);
            try {
              push({ kind: 'info', text: await hooks.applyProvider(result) });
              setUnconfigured(false);
            } catch (e) {
              push({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
            }
          }}
        />
      )}

      {modelPicker && (
        <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
          <Text color="cyan" bold>
            Choose a model ({modelPicker.length} available)
          </Text>
          <Text dimColor>enter to select, esc to cancel</Text>
          <SelectInput
            items={modelPicker.map((m) => ({ key: m, label: m, value: m }))}
            limit={10}
            initialIndex={Math.max(0, modelPicker.indexOf(hooks.config().model))}
            onSelect={(item) => {
              setModelPicker(undefined);
              try {
                push({ kind: 'info', text: hooks.switchModel(item.value) });
              } catch (e) {
                push({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
              }
            }}
          />
        </Box>
      )}

      {agentPicker && (
        <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
          <Text color="cyan" bold>
            Choose an agent
          </Text>
          <Text dimColor>enter to select, esc to cancel</Text>
          <SelectInput
            items={VARIANTS.map((v) => ({
              key: v.name,
              label: `${v.name.padEnd(8)} ${v.summary}`,
              value: v.name,
            }))}
            limit={8}
            initialIndex={Math.max(
              0,
              VARIANTS.findIndex((v) => v.name === hooks.agentName()),
            )}
            onSelect={(item) => {
              setAgentPicker(false);
              try {
                push({ kind: 'info', text: hooks.switchAgent(item.value) });
              } catch (e) {
                push({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
              }
            }}
          />
        </Box>
      )}

      {thinkPicker && (
        <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
          <Text color="cyan" bold>
            Thinking level
          </Text>
          <Text dimColor>higher costs more and is slower; enter to select, esc to cancel</Text>
          <SelectInput
            items={THINKING_LEVELS.map((l) => ({ key: l, label: l, value: l }))}
            limit={8}
            initialIndex={Math.max(0, THINKING_LEVELS.indexOf(hooks.thinkingLevel() as (typeof THINKING_LEVELS)[number]))}
            onSelect={(item) => {
              setThinkPicker(false);
              try {
                push({ kind: 'info', text: hooks.switchThinking(item.value) });
              } catch (e) {
                push({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
              }
            }}
          />
        </Box>
      )}

      {busy && !modal && (
        <Box flexDirection="column">
          <ThinkingPanel text={thinking} expanded={thinkingOpen} />
          {active && <ActiveTool name={active.name} {...(active.summary ? { summary: active.summary } : {})} />}
          <OutputPanel text={toolOutput} />
          <Text color="yellow">
            <Spinner type="dots" /> <Text dimColor>working... esc to interrupt</Text>
          </Text>
        </Box>
      )}

      {!modal && !anyPicker && (
        <Box flexDirection="column">
          <QueuePanel prompts={queue} />
          <Box>
            <Text color="cyan">{'> '}</Text>
            <PromptInput
              key={inputGeneration}
              value={draft}
              initialCursor={inputCursor}
              onChange={onDraftChange}
              onSubmit={submit}
              history={recall}
              onKey={handleInputKey}
              placeholder={busy ? 'type to queue for the next turn...' : 'ask shiro-neko... (/ commands, @ files)'}
            />
          </Box>
          {fileOpen ? (
            <FileMenu
              paths={fileMatches}
              index={Math.min(fileIndex, Math.max(0, fileMatches.length - 1))}
              query={token?.query ?? ''}
              loading={paths === undefined}
            />
          ) : (
            menuOpen && <CommandMenu matches={matches} index={Math.min(menuIndex, matches.length - 1)} />
          )}
          <StatusBar
            model={hooks.config().model}
            agent={hooks.agentName()}
            thinking={hooks.thinkingLevel()}
            contextTokens={session.estimatedTokens()}
            cost={(() => {
              const spend = costOf(hooks.config().model, session.inputTokens, session.outputTokens);
              return spend === undefined ? 'unpriced' : formatUsd(spend);
            })()}
            toolCount={session.activeTools().length}
          />
        </Box>
      )}
    </Box>
  );
}
