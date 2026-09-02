import type { AgentEvent, Session } from './session';

export type HeadlessOptions = {
  session: Session;
  prompt: string;
  /** 'text' streams assistant text only; 'json' emits one event object per line. */
  format?: 'text' | 'json';
  out?: (chunk: string) => void;
};

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * JSON.stringify turns an Error into `{}`, which would make --json useless for
 * diagnosing a failure, so error payloads are flattened to a message string.
 */
function serialize(ev: AgentEvent): string {
  if (ev.type === 'error') return JSON.stringify({ type: 'error', error: message(ev.error) });
  if (ev.type === 'tool-error') {
    return JSON.stringify({ type: 'tool-error', id: ev.id, name: ev.name, error: message(ev.error) });
  }
  return JSON.stringify(ev);
}

/**
 * Non-interactive run for pipes and CI. There is no terminal to prompt on, so the
 * Session must already be constructed with yolo or every mutating call gets denied.
 * Returns a process exit code.
 */
export async function runHeadless({ session, prompt, format = 'text', out }: HeadlessOptions): Promise<number> {
  const write = out ?? ((s: string) => process.stdout.write(s));
  let failed = false;

  for await (const ev of session.send(prompt)) {
    if (format === 'json') {
      write(`${serialize(ev)}\n`);
      if (ev.type === 'error') failed = true;
      continue;
    }

    switch (ev.type) {
      case 'text':
        write(ev.text);
        break;
      case 'tool-call':
        process.stderr.write(`[tool] ${ev.name} ${JSON.stringify(ev.input)}\n`);
        break;
      case 'tool-denied':
        process.stderr.write(`[denied] ${ev.name} (run with --yolo to allow tool use in headless mode)\n`);
        break;
      case 'tool-error':
        process.stderr.write(`[tool-error] ${ev.name}: ${message(ev.error)}\n`);
        break;
      case 'notice':
        process.stderr.write(`[notice] ${ev.text}\n`);
        break;
      case 'compacted':
        process.stderr.write(`[compacted] ${ev.before} messages pruned to ${ev.after}\n`);
        break;
      case 'error':
        process.stderr.write(`[error] ${message(ev.error)}\n`);
        failed = true;
        break;
      case 'done':
        write('\n');
        break;
      default:
        break;
    }
  }

  return failed ? 1 : 0;
}

export async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  return (await Bun.stdin.text()).trim();
}
