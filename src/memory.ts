import { tool, type LanguageModel } from 'ai';
import { generateText } from 'ai';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

export type MemoryKind = 'fact' | 'decision' | 'gotcha' | 'command';

export type MemoryEntry = {
  id: string;
  kind: MemoryKind;
  text: string;
  createdAt: string;
  /** Bumped on each recall so summarisation can keep what gets used. */
  hits: number;
};

const MAX_ENTRIES = 300;
const MAX_TEXT = 400;
const BOOT_ENTRIES = 20;
const SEARCH_HITS = 15;
/** Summarise once the store passes this, so the boot block stays small. */
const SUMMARISE_AT = 60;

const root = () => join(process.env['SHIRO_HOME'] ?? homedir(), '.shiro-neko', 'memory');

/** One file per project directory; the path is hashed because it is not filename-safe. */
const fileFor = (cwd: string) => join(root(), `${createHash('sha256').update(cwd).digest('hex').slice(0, 16)}.json`);

const KIND_LABEL: Record<MemoryKind, string> = {
  fact: 'fact',
  decision: 'decision',
  gotcha: 'gotcha',
  command: 'command',
};

/**
 * Durable per-project memory, separate from the session transcript.
 *
 * The transcript is destroyed by compaction and discarded when a session ends.
 * Anything worth knowing on the next run has to live here instead.
 */
export class Memory {
  private entries: MemoryEntry[] = [];
  private loaded = false;

  constructor(
    private readonly cwd = process.cwd(),
    private readonly model?: LanguageModel,
  ) {}

  async load(): Promise<MemoryEntry[]> {
    if (this.loaded) return this.entries;
    this.loaded = true;
    const f = Bun.file(fileFor(this.cwd));
    if (await f.exists()) {
      try {
        const parsed: unknown = await f.json();
        if (Array.isArray(parsed)) this.entries = parsed.filter(isEntry);
      } catch {
        this.entries = [];
      }
    }
    return this.entries;
  }

  all(): MemoryEntry[] {
    return [...this.entries];
  }

  private async persist(): Promise<void> {
    this.entries = this.entries.slice(-MAX_ENTRIES);
    await Bun.write(fileFor(this.cwd), JSON.stringify(this.entries, null, 2));
  }

  async add(kind: MemoryKind, text: string): Promise<MemoryEntry | undefined> {
    await this.load();
    const clean = text.trim().slice(0, MAX_TEXT);
    if (!clean) throw new Error('memory text is empty');
    if (this.entries.some((e) => e.text === clean)) return undefined;

    const entry: MemoryEntry = {
      id: Bun.randomUUIDv7(),
      kind,
      text: clean,
      createdAt: new Date().toISOString(),
      hits: 0,
    };
    this.entries.push(entry);
    await this.persist();
    return entry;
  }

  async forget(idOrPrefix: string): Promise<number> {
    await this.load();
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => !e.id.startsWith(idOrPrefix));
    if (this.entries.length !== before) await this.persist();
    return before - this.entries.length;
  }

  async clear(): Promise<void> {
    await this.load();
    this.entries = [];
    await this.persist();
  }

  /** Every term must appear. Matching entries get a hit, which protects them from summarisation. */
  async search(query: string): Promise<MemoryEntry[]> {
    await this.load();
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) throw new Error('query is empty');

    const found = this.entries.filter((e) => {
      const lower = e.text.toLowerCase();
      return terms.every((t) => lower.includes(t));
    });
    for (const e of found) e.hits += 1;
    if (found.length > 0) await this.persist();
    return found.slice(-SEARCH_HITS).reverse();
  }

  /** The block injected at boot: most-used first, then most recent. */
  render(limit = BOOT_ENTRIES): string {
    if (this.entries.length === 0) return '';
    const ranked = [...this.entries]
      .sort((a, b) => b.hits - a.hits || b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
    return [
      '',
      'What you learned about this project in earlier sessions. Trust it, but verify anything',
      'that contradicts what you can see in the code now:',
      ...ranked.map((e) => `- (${KIND_LABEL[e.kind]}) ${e.text}`),
    ].join('\n');
  }

  needsSummary(): boolean {
    return this.entries.length >= SUMMARISE_AT;
  }

  /**
   * Collapses the store into fewer, denser entries using the model. Unused entries
   * are the ones that get merged away; anything recalled at least once is kept verbatim.
   */
  async summarize(): Promise<{ before: number; after: number }> {
    await this.load();
    const before = this.entries.length;
    if (!this.model) throw new Error('no model available to summarize memory');
    if (before === 0) return { before, after: 0 };

    const used = this.entries.filter((e) => e.hits > 0);
    const unused = this.entries.filter((e) => e.hits === 0);
    if (unused.length < 2) return { before, after: before };

    const { text } = await generateText({
      model: this.model,
      system:
        'You are compacting an agent\'s notes about one codebase. Merge duplicates and near-duplicates, ' +
        'drop anything that is no longer useful or was only true of one past task, and keep the rest verbatim ' +
        'where you can. Output one note per line, each prefixed with its kind in brackets: ' +
        '[fact], [decision], [gotcha], or [command]. No preamble, no numbering, no blank lines.',
      prompt: unused.map((e) => `[${e.kind}] ${e.text}`).join('\n'),
      maxRetries: 2,
    });

    const merged = text
      .split('\n')
      .map((line) => /^\s*\[(fact|decision|gotcha|command)\]\s*(.+?)\s*$/i.exec(line))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => ({
        id: Bun.randomUUIDv7(),
        kind: m[1]!.toLowerCase() as MemoryKind,
        text: m[2]!.slice(0, MAX_TEXT),
        createdAt: new Date().toISOString(),
        hits: 0,
      }));

    // A model that returned nothing parseable must not wipe the store.
    if (merged.length === 0) return { before, after: before };

    this.entries = [...used, ...merged];
    await this.persist();
    return { before, after: this.entries.length };
  }

  tools() {
    return {
      remember: tool({
        description:
          'Record something about this project that will still be true next session: a decision and its reason, ' +
          'a command that works, a constraint, a trap you hit. Persisted across sessions and shown to you at start. ' +
          'Do not use it for narration or for anything specific to the current task only.',
        inputSchema: z.object({
          kind: z
            .enum(['fact', 'decision', 'gotcha', 'command'])
            .describe('fact: how it is. decision: what was chosen and why. gotcha: a trap. command: an invocation that works'),
          text: z.string().describe('One self-contained line, understandable with no other context'),
        }),
        execute: async ({ kind, text }) => {
          const entry = await this.add(kind, text);
          if (!entry) return `Already recorded: ${text.trim()}`;
          return `Remembered as ${entry.kind} (${this.entries.length} stored): ${entry.text}`;
        },
      }),

      recall: tool({
        description:
          'Search what you recorded about this project in earlier sessions. Use it before investigating anything ' +
          'that might already be known, and when the user refers to past work.',
        inputSchema: z.object({
          query: z.string().describe('Words that would appear in the note'),
        }),
        execute: async ({ query }) => {
          const found = await this.search(query);
          if (found.length === 0) return `Nothing recorded about "${query}".`;
          return found.map((e) => `(${e.kind}) ${e.text}`).join('\n');
        },
      }),

      forget: tool({
        description:
          'Remove a memory that turned out to be wrong or is now obsolete. Search with recall first to get its text.',
        inputSchema: z.object({
          text: z.string().describe('Exact text of the memory to remove, or a distinctive part of it'),
        }),
        execute: async ({ text }) => {
          await this.load();
          const needle = text.trim().toLowerCase();
          const before = this.entries.length;
          this.entries = this.entries.filter((e) => !e.text.toLowerCase().includes(needle));
          const removed = before - this.entries.length;
          if (removed > 0) await this.persist();
          return removed > 0 ? `Forgot ${removed} memor${removed === 1 ? 'y' : 'ies'}.` : `No memory matches "${text}".`;
        },
      }),
    };
  }
}

export { fileFor as memoryFileFor, root as memoryDir, KIND_LABEL };

function isEntry(value: unknown): value is MemoryEntry {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['id'] === 'string' &&
    typeof v['text'] === 'string' &&
    typeof v['createdAt'] === 'string' &&
    typeof v['hits'] === 'number' &&
    ['fact', 'decision', 'gotcha', 'command'].includes(String(v['kind']))
  );
}
