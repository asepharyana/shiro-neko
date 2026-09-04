import { tool } from 'ai';
import { z } from 'zod';

export type TodoStatus = 'pending' | 'in_progress' | 'done' | 'blocked';
export type Todo = { content: string; status: TodoStatus; note?: string };

export type NotebookState = { todos: Todo[] };

const MARK: Record<TodoStatus, string> = {
  pending: '[ ]',
  in_progress: '[~]',
  done: '[x]',
  blocked: '[!]',
};

const STATUSES = ['pending', 'in_progress', 'done', 'blocked'] as const;

const renderTodo = (t: Todo) => `${MARK[t.status]} ${t.content}${t.note?.trim() ? `  (${t.note.trim()})` : ''}`;

function isTodo(value: unknown): value is Todo {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v['content'] === 'string' && (STATUSES as readonly string[]).includes(String(v['status']));
}

/**
 * The task list for the current session.
 *
 * Both `pruneMessages` and `/compact` destroy tool results and older turns, so a plan
 * recorded only in the transcript is lost exactly when a long task needs it. This is
 * re-rendered into the system prompt on every step instead, so it survives both.
 * Anything that should outlive the session belongs in Memory, not here.
 */
export class Notebook {
  private todos: Todo[] = [];
  private rev = 0;

  constructor(private readonly onChange?: (state: NotebookState) => void) {}

  state(): NotebookState {
    return { todos: this.todos.map((t) => ({ ...t })) };
  }

  /** Monotonically increasing counter bumped on every mutation. */
  revision(): number {
    return this.rev;
  }

  restore(state: Partial<NotebookState> | undefined): void {
    if (Array.isArray(state?.todos)) {
      this.todos = state.todos.filter(isTodo);
      this.rev++;
    }
  }

  clear(): void {
    if (this.todos.length === 0) return;
    this.todos = [];
    this.rev++;
    this.onChange?.(this.state());
  }

  progress(): { done: number; total: number; blocked: number; current?: Todo } {
    const current = this.todos.find((t) => t.status === 'in_progress');
    return {
      done: this.todos.filter((t) => t.status === 'done').length,
      total: this.todos.length,
      blocked: this.todos.filter((t) => t.status === 'blocked').length,
      ...(current ? { current } : {}),
    };
  }

  render(): string {
    if (this.todos.length === 0) return '';
    const { done, total, blocked } = this.progress();
    const header = `\nYour task list (${done}/${total} done${blocked > 0 ? `, ${blocked} blocked` : ''}). Keep it current with todo_write:`;
    return `${header}\n${this.todos.map(renderTodo).join('\n')}`;
  }

  tools() {
    return {
      todo_write: tool({
        description:
          'Record or update your task list for a multi-step job. Send the whole list every time; it replaces the ' +
          'previous one. Exactly one task should be in_progress. Mark a task done the moment it is finished, not in ' +
          'a batch at the end. Use blocked with a note when something outside your control stops you. The list is ' +
          'shown to the user and survives context compaction, so it is where your plan lives. ' +
          'Skip it entirely for single-step work.',
        inputSchema: z.object({
          todos: z
            .array(
              z.object({
                content: z
                  .string()
                  .describe('One concrete action with a verifiable outcome, e.g. "add limit/offset to listUsers()"'),
                status: z.enum(STATUSES),
                note: z
                  .string()
                  .optional()
                  .describe('Required for blocked: what is blocking it. Otherwise a short finding worth keeping.'),
              }),
            )
            .describe('The complete list, in the order you will do them'),
        }),
        execute: async ({ todos }) => {
          this.todos = todos;
          this.rev++;
          this.onChange?.(this.state());

          const active = todos.filter((t) => t.status === 'in_progress');
          const blocked = todos.filter((t) => t.status === 'blocked');
          const { done, total } = this.progress();

          const warnings: string[] = [];
          if (active.length > 1) warnings.push(`${active.length} tasks are in_progress; keep it to one.`);
          if (active.length === 0 && done < total && blocked.length < total - done) {
            warnings.push('nothing is in_progress; mark what you are working on.');
          }
          for (const t of blocked) {
            if (!t.note?.trim()) warnings.push(`"${t.content}" is blocked with no note saying why.`);
          }

          const lines = [`Task list updated: ${done}/${total} done.`, ...todos.map(renderTodo)];
          if (warnings.length > 0) lines.push(`Warning: ${warnings.join(' ')}`);
          return lines.join('\n');
        },
      }),
    };
  }
}

export { MARK as TODO_MARK, STATUSES };
