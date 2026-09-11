import { Box, Static, Text, useApp, useInput, useStdout } from 'ink';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { parseCommand, matchCommands } from '../commands';
import { expandCommand, type CustomCommand } from '../custom-commands';
import { THINKING_LEVELS, VARIANTS } from '../agents';
import { completePath, matchPaths, pathToken } from '../complete';
import type { Config } from '../config';
import { type NotebookState } from '../notebook';
import { costOf, formatUsd, usageLine } from '../pricing';
import type { Session } from '../session';
import { interruptBash, toolSetOf } from '../tools';
import { diagStart, diagStop, diagStatus } from '../diagnostics';
import { AskPanel, type AskBridge, type AskPending } from './Ask';
import { Approval, createApprovalBridge, type ApprovalBridge, type Pending } from './Approval';
import { applySubagentEvent, createNoticeBus, createSubagentBus, type NoticeBus, type SubagentBus } from './buses';
import { Markdown } from './Markdown';
import { McpAdd, type McpAddResult } from './McpAdd';
import { Onboard, type OnboardResult } from './Onboard';
import {
  InfoPanel,
  OutputPanel,
  QueuePanel,
  RegistryPanel,
  DiagnosticsPanel,
  Footer,
  InputStatus,
  StatusBar,
  SubagentPanel,
  ThinkingPanel,
  TodoPanel,
  ActiveTool,
  FileMenu,
  Working,
  type RegistryRow,
  type SubagentView,
} from './Panels';
import { CommandMenu, InstallConfirm, Picker } from './Pickers';
import { contextPanel, costPanel, todosPanel, toolsPanel, changesPanel, diffPanel, diffReviewPanel, workflowPanel } from './panel-bodies';
import { PromptInput } from './PromptInput';
import { accent, glyph } from './theme';
import { nextKey, resultSummary, toolDetail, withResult, type Line, type NewLine } from './transcript';

export { createApprovalBridge, createNoticeBus, createSubagentBus, applySubagentEvent };
export type { ApprovalBridge, NoticeBus, SubagentBus };

/** Everything the slash commands need from the outside world. */
export type AppHooks = {
  sessionId: string;
  /** Session title for the welcome dashboard; absent in tests. */
  title?: string;
  config: () => Config;
  switchModel: (id: string) => string;
  switchAgent: (name: string) => string;
  switchThinking: (level: string) => string;
  agentName: () => string;
  thinkingLevel: () => string;
  applyProvider: (result: OnboardResult) => Promise<string>;
  listModels: () => Promise<{ models: string[]; warning?: string }>;
  listSessions: () => Promise<string>;
  /** Full-text search over saved sessions; returns a formatted panel body or ''. */
  searchSessions: (query: string) => Promise<string>;
  /** Fork the current session at the last turn boundary; returns a resume hint. */
  forkSession: () => Promise<string>;
  listSkills: () => string;
  listPlugins: () => string;
  listMemory: () => Promise<string>;
  summarizeMemory: () => Promise<string>;
  resumeSession: (idOrPrefix: string) => Promise<string>;
  saveSession: () => Promise<string>;
  /** Loaded AGENTS.md-style files, for /context. */
  instructionFiles: () => string[];
  /** Ignore-aware workspace paths for `@` completion, loaded on first use and invalidated when files change. */
  listPaths: () => Promise<string[]>;
  /** Monotonically increments when the workspace changes — lets the `@` completer know to re-walk. */
  fileChangeSeq: () => number;
  /** Custom slash commands from markdown files, for the menu and the parser. */
  customCommands?: () => readonly CustomCommand[];
  /** Registry index, installed set, and the install/remove actions. */
  registry: {
    list: () => Promise<RegistryRow[]>;
    installed: () => Promise<RegistryRow[]>;
    /** Fetches and validates without writing, so the body can be shown first. */
    stage: (name: string) => Promise<{ row: RegistryRow; url: string; preview: string }>;
    install: (name: string) => Promise<string>;
    remove: (name: string) => Promise<string>;
  };
  /** Configured MCP servers, and the add/remove actions that write config.json. */
  mcp: {
    names: () => string[];
    list: () => string;
    add: (result: McpAddResult) => Promise<string>;
    remove: (name: string) => Promise<string>;
  };
  /** Prompt to hand the model for /init. */
  initPrompt: string;
  /** Directly scaffold TODO.md / ROADMAP.md / docs/ when they are missing; returns what was written. */
  scaffoldWorkflow: () => string[];
  /** Background commands started with bash background: true — list, stop one, stop all. */
  backgroundCommands: {
    list: () => string;
    stop: (handle: number) => Promise<string>;
    stopAll: () => Promise<string>;
  };
  history: string[];
  recordPrompt: (text: string) => void;
};

export function App({
  session,
  bridge,
  header,
  headerNode,
  version,
  hooks,
  notices,
  askBridge,
  subagents,
  needsProvider = false,
}: {
  session: Session;
  bridge: ApprovalBridge;
  header: string;
  /** Rich welcome screen; when present it replaces the plain `header` string. */
  headerNode?: React.ReactNode;
  /** Build version, shown in the welcome dashboard's meta panel. */
  version?: string;
  hooks: AppHooks;
  notices?: NoticeBus;
  askBridge?: AskBridge;
  subagents?: SubagentBus;
  needsProvider?: boolean;
}) {
  const { exit } = useApp();
  const { write, stdout } = useStdout();
  // The footer splits hints left from context/cost right, and the input box and
  // dashboards lay out against the real terminal width, so it is tracked and
  // kept current on resize rather than read once.
  const [termWidth, setTermWidth] = useState(stdout?.columns ?? 80);
  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setTermWidth(stdout.columns ?? 80);
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);
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
  const [active, setActive] = useState<{ name: string; detail?: string[] } | undefined>();
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
  /** Live diagnostics runner: command + start time, so the panel can re-read /diagnostics state on a timer. */
  const [diag, setDiag] = useState<{ command: string; startedAt: number } | undefined>();
  const [registry, setRegistry] = useState<{ title: string; hint?: string; rows: RegistryRow[] } | undefined>();
  const [installing, setInstalling] = useState<
    { row: RegistryRow; url: string; preview: string } | undefined
  >();
  const [addingMcp, setAddingMcp] = useState(false);
  const [seconds, setElapsed] = useState(0);
  const startedAt = useRef<number | undefined>(undefined);

  const modal =
    pending !== undefined || asking !== undefined || onboarding || installing !== undefined || addingMcp;
  const anyPicker = modelPicker !== undefined || agentPicker || thinkPicker;
  const matches = matchCommands(draft, hooks.customCommands?.() ?? []);
  const menuOpen = matches.length > 0 && !menuDismissed && !busy && !modal && !anyPicker && !panel;
  const highlighted = matches[Math.min(menuIndex, matches.length - 1)];

  const token = pathToken(draft, cursor);
  const fileOpen = token !== undefined && !fileDismissed && !modal && !anyPicker;
  const fileMatches = token && paths ? matchPaths(paths, token.query) : [];
  const highlightedPath = fileMatches[Math.min(fileIndex, Math.max(0, fileMatches.length - 1))];

  // The walk costs a full ignore-aware traversal, so it happens on the first `@`
  // rather than at startup, and re-runs when files change (listPaths is cached
  // in hook, but App keeps seq so a stale `paths` is dropped).
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

  // A file mutated this turn: drop the cached walk so next `@` re-walks.
  const seq = hooks.fileChangeSeq();
  useEffect(() => {
    setPaths(undefined);
  }, [seq]); // eslint-disable-line react-hooks/exhaustive-deps

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
    setElapsed(0);
    startedAt.current = value ? Date.now() : undefined;
  }, []);

  // One tick per second while busy, so a long turn reports how long it has been
  // going. Derived from a timestamp rather than counted, because Ink's render loop
  // is not a clock and a dropped tick would drift.
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => {
      const from = startedAt.current;
      if (from !== undefined) setElapsed(Math.floor((Date.now() - from) / 1000));
    }, 1000);
    return () => clearInterval(t);
  }, [busy]);

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
  // in cli.tsx rather than left to race with this. When a background command is
  // running (started by the model with bash background: true) and nothing
  // foreground is in flight, ctrl-c stops the most recently started one instead
  // of quitting — an accidental quit killing a dev server the user still wants.
  useInput(async (input, key) => {
    if (!key.ctrl || input !== 'c') return;
    const killed = interruptBash();
    if (killed.length > 0) {
      push({ kind: 'info', text: `interrupted: ${killed.join(', ')}` });
      return;
    }
    const handles = hooks.backgroundCommands.list();
    if (handles.trim() !== '' && handles.trim() !== 'no background commands') {
      const lines = handles.split('\n').map((l) => l.trim()).filter(Boolean);
      const first = lines[0]?.match(/^(\d+):/)?.[1];
      if (first) {
        const msg = await hooks.backgroundCommands.stop(Number(first));
        push({ kind: 'info', text: `ctrl-c: no foreground command; ${msg}` });
        return;
      }
    }
    return exit();
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
      if (key.escape && registry) {
        setRegistry(undefined);
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
    [draft, fileMatches.length, fileOpen, highlighted, highlightedPath, matches.length, menuOpen, panel, registry, token],
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
            setActive({ name: ev.name, detail: toolDetail(ev.name, ev.input) });
            push({ kind: 'tool', name: ev.name, detail: toolDetail(ev.name, ev.input), ok: true });
            break;
          case 'tool-output':
            setToolOutput((s) => `${s}${ev.chunk}`.slice(-2000));
            break;
          case 'tool-error':
            setActive(undefined);
            // Attaches to the call rather than pushing a second line, so the
            // transcript reads as one entry per call with its outcome.
            setHistory((h) => withResult(h, ev.name, String(ev.error), false));
            break;
          case 'tool-result':
            setActive(undefined);
            setToolOutput('');
            setHistory((h) => withResult(h, ev.name, resultSummary(ev.name, ev.output), true));
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
                  text: `${usageLine(hooks.config().model, ev.inputTokens, ev.outputTokens ?? 0)}  (~${session.estimatedTokens()} est. in context)`,
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
      setRegistry(undefined);

      // Enter on an open menu runs the highlighted entry, so `/mo` + enter works.
      const chosen = menuOpen && highlighted ? `/${highlighted.name}` : raw;
      const action = parseCommand(chosen, hooks.customCommands?.() ?? []);

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
          setPanel(toolsPanel(session));
          return;
        case 'cost':
          push({ kind: 'user', text: chosen.trim() });
          setPanel(
            costPanel(session, {
              sessionId: hooks.sessionId,
              model: hooks.config().model,
              agent: hooks.agentName(),
              thinking: hooks.thinkingLevel(),
              ...(hooks.config().subagentModel ? { subagentModel: hooks.config().subagentModel! } : {}),
            }),
          );
          return;
        case 'context':
          push({ kind: 'user', text: chosen.trim() });
          setPanel(contextPanel(hooks.instructionFiles()));
          return;
        case 'todos':
          push({ kind: 'user', text: chosen.trim() });
          setPanel(todosPanel(session));
          return;
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
        case 'registry': {
          push({ kind: 'user', text: chosen.trim() });
          setWorking(true);
          try {
            if (action.action === 'add') {
              // Staged, not installed: nothing is written until the prompt is answered.
              setInstalling(await hooks.registry.stage(action.arg!));
              return;
            }
            if (action.action === 'remove') {
              push({ kind: 'info', text: await hooks.registry.remove(action.arg!) });
              return;
            }
            if (action.action === 'installed') {
              const rows = await hooks.registry.installed();
              setRegistry({
                title: 'installed',
                hint: rows.length === 0 ? 'nothing installed yet' : `${rows.length} from the registry`,
                rows,
              });
              return;
            }

            const all = await hooks.registry.list();
            const rows =
              action.action === 'search' && action.arg
                ? all.filter(
                    (r) =>
                      r.name.includes(action.arg!.toLowerCase()) ||
                      r.description.toLowerCase().includes(action.arg!.toLowerCase()),
                  )
                : all;
            setRegistry({
              title: action.arg ? `registry: ${action.arg}` : 'registry',
              hint: `${rows.length} of ${all.length} available`,
              rows,
            });
          } catch (e) {
            push({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
          } finally {
            setWorking(false);
          }
          return;
        }
        case 'mcp': {
          push({ kind: 'user', text: chosen.trim() });
          if (action.action === 'add') {
            setAddingMcp(true);
            return;
          }
          if (action.action === 'remove') {
            try {
              push({ kind: 'info', text: await hooks.mcp.remove(action.arg!) });
            } catch (e) {
              push({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
            }
            return;
          }
          setPanel({ title: 'mcp servers', hint: '/mcp add to add one', body: hooks.mcp.list() });
          return;
        }
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
        case 'init': {
          push({ kind: 'user', text: chosen.trim() });
          const written = hooks.scaffoldWorkflow();
          if (written.length > 0) push({ kind: 'info', text: `scaffolded ${written.join(', ')}` });
          await runTurn(hooks.initPrompt);
          return;
        }
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
        case 'undo': {
          push({ kind: 'user', text: chosen.trim() });
          setWorking(true);
          try {
            push({ kind: 'info', text: await session.undo() });
          } catch (e) {
            push({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
          }
          setWorking(false);
          return;
        }
        case 'redo': {
          push({ kind: 'user', text: chosen.trim() });
          setWorking(true);
          try {
            push({ kind: 'info', text: await session.redo() });
          } catch (e) {
            push({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
          }
          setWorking(false);
          return;
        }
        case 'changes': {
          push({ kind: 'user', text: chosen.trim() });
          setPanel(changesPanel(session));
          return;
        }
        case 'diff': {
          push({ kind: 'user', text: chosen.trim() });
          setPanel(action.action === 'review' ? diffReviewPanel(session) : diffPanel(session));
          return;
        }
        case 'search': {
          push({ kind: 'user', text: chosen.trim() });
          setWorking(true);
          try {
            const results = await hooks.searchSessions(action.query);
            if (results === '') {
              push({ kind: 'info', text: 'no sessions match that phrase' });
            } else {
              setPanel({ title: `sessions: ${action.query}`, body: results });
            }
          } catch (e) {
            push({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
          }
          setWorking(false);
          return;
        }
        case 'fork': {
          push({ kind: 'user', text: chosen.trim() });
          try {
            push({ kind: 'info', text: await hooks.forkSession() });
          } catch (e) {
            push({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
          }
          return;
        }
        case 'workflow': {
          push({ kind: 'user', text: chosen.trim() });
          setPanel(workflowPanel(session));
          return;
        }
        case 'bash': {
          push({ kind: 'user', text: chosen.trim() });
          if (action.action === 'list') {
            push({ kind: 'info', text: hooks.backgroundCommands.list() });
            return;
          }
          setWorking(true);
          try {
            const text =
              action.action === 'stop-all'
                ? await hooks.backgroundCommands.stopAll()
                : await hooks.backgroundCommands.stop(Number(action.arg));
            push({ kind: 'info', text });
          } catch (e) {
            push({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
          }
          setWorking(false);
          return;
        }
        case 'diagnostics': {
          push({ kind: 'user', text: chosen.trim() });
          if (action.action === 'start') {
            const command = action.command!;
            try {
              const res = diagStart(command);
              setDiag({ command, startedAt: Date.now() });
              push({ kind: 'info', text: `diagnostics: ${res.command} (UI only, not in model context)` });
            } catch (e) {
              push({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
            }
            return;
          }
          if (action.action === 'stop') {
            const res = diagStop();
            setDiag(undefined);
            push({ kind: 'info', text: res.stopped ? `diagnostics stopped: ${res.command}` : 'no diagnostics running' });
            return;
          }
          const snap = diagStatus();
          if (!snap.running && snap.exit === null && !snap.command) {
            push({ kind: 'info', text: 'no diagnostics running — /diagnostics start <command>' });
            return;
          }
          push({ kind: 'info', text: snap.command ? `${snap.command}: ${snap.running ? 'running' : `exit ${snap.exit}`}` : 'no diagnostics running' });
          return;
        }
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
        case 'custom': {
          const typed = chosen.trim();
          push({ kind: 'user', text: typed });
          setWorking(true);
          try {
            // A command may pin an agent; it runs the prompt under that variant
            // and restores afterwards, so one command does not leak its agent into
            // the rest of the session.
            const previous = hooks.agentName();
            if (action.command.agent && action.command.agent !== previous) {
              try {
                hooks.switchAgent(action.command.agent);
              } catch (e) {
                push({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
              }
            }
            const prompt = await expandCommand(action.command, action.args);
            await runTurn(prompt);
            if (action.command.agent && action.command.agent !== previous) {
              try {
                hooks.switchAgent(previous);
              } catch {
                // Restoring the agent is best-effort; the next /agent sets it explicitly.
              }
            }
          } catch (e) {
            push({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
          }
          setWorking(false);
          return;
        }
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
            {line.kind === 'user' && (
              <Text color={accent.user} bold>
                {`${glyph.user} ${line.text}`}
              </Text>
            )}
            {line.kind === 'assistant' && (
              <Box>
                <Text color={accent.ok}>{`${glyph.assistant} `}</Text>
                <Box flexGrow={1} flexDirection="column">
                  <Markdown text={line.text} />
                </Box>
              </Box>
            )}
            {line.kind === 'tool' && (
              <Box flexDirection="column">
                <Box>
                  <Text color={line.ok ? accent.tool : accent.err}>{line.ok ? glyph.toolOk : glyph.toolErr} </Text>
                  <Text color={line.ok ? accent.tool : accent.err} bold>
                    {line.name}
                  </Text>
                  {line.detail[0] !== undefined && <Text dimColor>{`  ${line.detail[0]}`}</Text>}
                </Box>
                {line.detail.slice(1).map((d, i) => (
                  <Text key={i} dimColor>
                    {`    ${d}`}
                  </Text>
                ))}
                {line.result !== undefined && line.result.length > 0 && (
                  <Text color={line.ok ? undefined : accent.err} dimColor={line.ok}>
                    {`    ${line.ok ? glyph.result : glyph.err} ${line.result}`}
                  </Text>
                )}
              </Box>
            )}
            {line.kind === 'info' && <Text dimColor>{`${glyph.info} ${line.text}`}</Text>}
            {line.kind === 'error' && <Text color={accent.err}>{`${glyph.err} ${line.text}`}</Text>}
          </Box>
        )}
      </Static>

      {history.length === 0 &&
        (headerNode !== undefined ? (
          headerNode
        ) : (
          <Box flexDirection="column" marginBottom={1}>
            <Text dimColor>{header}</Text>
          </Box>
        ))}

      {agents.length > 0 && <SubagentPanel agents={agents} />}

      {diag && <DiagnosticsPanel command={diag.command} startedAt={diag.startedAt} />}

      {notebook.todos.length > 0 && <TodoPanel todos={notebook.todos} />}

      {live.length > 0 && (
        <Box marginBottom={1}>
          <Markdown text={live} />
        </Box>
      )}

      {panel && (
        <InfoPanel title={panel.title} {...(panel.hint ? { hint: panel.hint } : {})} lines={panel.body} />
      )}

      {registry && (
        <RegistryPanel title={registry.title} {...(registry.hint ? { hint: registry.hint } : {})} rows={registry.rows} />
      )}

      {installing && (
        <InstallConfirm
          staged={installing}
          onDone={async (yes) => {
            const staged = installing;
            setInstalling(undefined);
            if (!yes) {
              push({ kind: 'info', text: `install cancelled: ${staged.row.name}` });
              return;
            }
            try {
              push({ kind: 'info', text: await hooks.registry.install(staged.row.name) });
            } catch (e) {
              push({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
            }
          }}
        />
      )}

      {asking && <AskPanel pending={asking} />}

      {addingMcp && (
        <McpAdd
          existing={hooks.mcp.names()}
          onCancel={() => {
            setAddingMcp(false);
            push({ kind: 'info', text: 'mcp setup cancelled' });
          }}
          onDone={async (result) => {
            setAddingMcp(false);
            try {
              push({ kind: 'info', text: await hooks.mcp.add(result) });
            } catch (e) {
              push({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
            }
          }}
        />
      )}

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
        <Picker
          title={`Choose a model (${modelPicker.length} available)`}
          options={modelPicker.map((m) => ({ value: m, label: m }))}
          current={hooks.config().model}
          onSelect={(value) => {
            setModelPicker(undefined);
            try {
              push({ kind: 'info', text: hooks.switchModel(value) });
            } catch (e) {
              push({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
            }
          }}
        />
      )}

      {agentPicker && (
        <Picker
          title="Choose an agent"
          options={VARIANTS.map((v) => ({ value: v.name, label: `${v.name.padEnd(8)} ${v.summary}` }))}
          current={hooks.agentName()}
          limit={8}
          onSelect={(value) => {
            setAgentPicker(false);
            try {
              push({ kind: 'info', text: hooks.switchAgent(value) });
            } catch (e) {
              push({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
            }
          }}
        />
      )}

      {thinkPicker && (
        <Picker
          title="Thinking level"
          hint="higher costs more and is slower"
          options={THINKING_LEVELS.map((l) => ({ value: l, label: l }))}
          current={hooks.thinkingLevel()}
          limit={8}
          onSelect={(value) => {
            setThinkPicker(false);
            try {
              push({ kind: 'info', text: hooks.switchThinking(value) });
            } catch (e) {
              push({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
            }
          }}
        />
      )}

      {busy && !modal && (
        <Box flexDirection="column">
          <ThinkingPanel text={thinking} expanded={thinkingOpen} />
          {active && <ActiveTool name={active.name} {...(active.detail ? { detail: active.detail } : {})} />}
          <OutputPanel text={toolOutput} />
          <Working seconds={seconds} />
        </Box>
      )}

      {!modal && !anyPicker && (
        <Box flexDirection="column" marginTop={1} width={termWidth}>
          <QueuePanel prompts={queue} />
          <Box
            flexDirection="column"
            width={termWidth}
            borderStyle="round"
            borderColor={accent.mute}
            borderLeftColor={busy ? accent.warn : accent.user}
            paddingLeft={1}
            paddingRight={1}
          >
            <Box>
              <Text color={accent.user} bold>
                {`${glyph.user} `}
              </Text>
              <PromptInput
                key={inputGeneration}
                value={draft}
                initialCursor={inputCursor}
                onChange={onDraftChange}
                onSubmit={submit}
                history={recall}
                onKey={handleInputKey}
                placeholder={busy ? 'type to queue for the next turn…' : 'ask shiro-neko…  (/ commands, @ files)'}
              />
            </Box>
            <InputStatus
              agent={hooks.agentName()}
              model={hooks.config().model}
              right={`${hooks.thinkingLevel()} ${glyph.info} ${session.activeTools().length} tools`}
              width={termWidth - 6}
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
          <Footer
            busy={busy}
            width={termWidth}
            contextTokens={session.estimatedTokens()}
            contextLimit={session.compactThreshold()}
            cost={(() => {
              const spend = costOf(hooks.config().model, session.inputTokens, session.outputTokens);
              return spend === undefined ? 'unpriced' : formatUsd(spend);
            })()}
          />
        </Box>
      )}
    </Box>
  );
}
