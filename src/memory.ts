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
  /** Last time this entry was recalled; falls back to createdAt when absent. */
  lastHitAt?: string;
};

const MAX_ENTRIES = 300;
const MAX_TEXT = 800;
const BOOT_ENTRIES = 20;
const SEARCH_HITS = 15;
/** Summarise once the store passes this, so the boot block stays small. */
const SUMMARISE_AT = 60;
/** Entries with 0 hits older than this are pruned (lifelong: drop stale cruft). */
const TTL_DAYS = 90;
const TTL_MS = TTL_DAYS * 24 * 60 * 60 * 1000;

const root = () => join(process.env['SHIRO_HOME'] ?? homedir(), '.shiro-neko', 'memory');

/** One file per project directory; the path is hashed because it is not filename-safe. */
const fileFor = (cwd: string) => join(root(), `${createHash('sha256').update(cwd).digest('hex').slice(0, 16)}.json`);
const globalFile = () => join(root(), '_global.json');

const KIND_LABEL: Record<MemoryKind, string> = {
  fact: 'fact',
  decision: 'decision',
  gotcha: 'gotcha',
  command: 'command',
};

/** Normalize for dedup and tolerant matching: lower, collapse whitespace, strip leading/trailing punct. */
function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ').replace(/^[\p{P}\s]+|[\p{P}\s]+$/gu, '');
}

/** Tokenize query/entry for scoring: split on non-alnum, drop empties. Underscore/hyphen are separators. */
function tokensOf(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function isExpired(e: MemoryEntry, now: number): boolean {
  if (e.hits > 0) return false;
  const ts = Date.parse(e.createdAt);
  if (Number.isNaN(ts)) return false;
  return now - ts > TTL_MS;
}

/**
 * Durable per-project memory, separate from the session transcript.
 *
 * The transcript is destroyed by compaction and discarded when a session ends.
 * Anything worth knowing on the next run has to live here instead.
 */
export class Memory {
  private entries: MemoryEntry[] = [];
  private globalEntries: MemoryEntry[] = [];
  private loaded = false;
  private globalLoaded = false;

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
    // TTL pruning on load (only drops stale 0-hit cruft)
    const now = Date.now();
    const beforeLen = this.entries.length;
    this.entries = this.entries.filter((e) => !isExpired(e, now));
    if (this.entries.length !== beforeLen) await this.persist();
    return this.entries;
  }

  async loadGlobal(): Promise<MemoryEntry[]> {
    if (this.globalLoaded) return this.globalEntries;
    this.globalLoaded = true;
    const f = Bun.file(globalFile());
    if (await f.exists()) {
      try {
        const parsed: unknown = await f.json();
        if (Array.isArray(parsed)) this.globalEntries = parsed.filter(isEntry);
      } catch {
        this.globalEntries = [];
      }
    }
    return this.globalEntries;
  }

  all(): MemoryEntry[] {
    return [...this.entries];
  }

  allWithGlobal(): MemoryEntry[] {
    return [...this.globalEntries, ...this.entries];
  }

  private async persist(): Promise<void> {
    this.entries = this.entries.slice(-MAX_ENTRIES);
    await Bun.write(fileFor(this.cwd), JSON.stringify(this.entries, null, 2));
  }

  private async persistGlobal(): Promise<void> {
    this.globalEntries = this.globalEntries.slice(-MAX_ENTRIES);
    await Bun.write(globalFile(), JSON.stringify(this.globalEntries, null, 2));
  }

  async add(kind: MemoryKind, text: string): Promise<MemoryEntry | undefined> {
    await this.load();
    const clean = text.trim().slice(0, MAX_TEXT);
    if (!clean) throw new Error('memory text is empty');
    const norm = normalize(clean);
    if (this.entries.some((e) => normalize(e.text) === norm)) return undefined;

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

  /** Add to global layer (cross-project pattern). */
  async addGlobal(kind: MemoryKind, text: string): Promise<MemoryEntry | undefined> {
    await this.loadGlobal();
    const clean = text.trim().slice(0, MAX_TEXT);
    if (!clean) throw new Error('memory text is empty');
    const norm = normalize(clean);
    if (this.globalEntries.some((e) => normalize(e.text) === norm)) return undefined;
    const entry: MemoryEntry = {
      id: Bun.randomUUIDv7(),
      kind,
      text: clean,
      createdAt: new Date().toISOString(),
      hits: 0,
    };
    this.globalEntries.push(entry);
    await this.persistGlobal();
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

  /** Prune stale 0-hit entries older than TTL. Returns count removed. */
  async pruneExpired(): Promise<number> {
    await this.load();
    const before = this.entries.length;
    const now = Date.now();
    this.entries = this.entries.filter((e) => !isExpired(e, now));
    const removed = before - this.entries.length;
    if (removed > 0) await this.persist();
    return removed;
  }

  /**
   * Every term must appear (compat). Scoring adds hits + recency + exact-phrase bonus,
   * so the best entries surface first instead of arbitrary file order.
   */
  async search(query: string): Promise<MemoryEntry[]> {
    await this.load();
    const terms = tokensOf(query);
    if (terms.length === 0) throw new Error('query is empty');

    const now = Date.now();
    const scored: { e: MemoryEntry; score: number }[] = [];
    for (const e of this.entries) {
      const lower = e.text.toLowerCase();
      const entryTokens = new Set(tokensOf(e.text));
      // every query token must appear as substring or token (keeps compat with "snake_case" queries)
      const allPresent = terms.every((t) => lower.includes(t) || entryTokens.has(t));
      if (!allPresent) continue;
      // scoring: hits weight + recency + phrase bonus
      const lastHit = e.lastHitAt ? Date.parse(e.lastHitAt) : Date.parse(e.createdAt);
      const ageDays = Number.isNaN(lastHit) ? 999 : (now - lastHit) / (24 * 60 * 60 * 1000);
      const recency = Math.max(0, 10 - ageDays * 0.1); // ~10 pts fresh, decays over 100d
      const phraseBonus = lower.includes(query.toLowerCase().trim()) ? 5 : 0;
      const score = e.hits * 3 + recency + phraseBonus;
      scored.push({ e, score });
    }
    scored.sort((a, b) => b.score - a.score || b.e.hits - a.e.hits || b.e.createdAt.localeCompare(a.e.createdAt));
    const found = scored.map((s) => s.e);
    const nowIso = new Date().toISOString();
    for (const e of found) {
      e.hits += 1;
      e.lastHitAt = nowIso;
    }
    if (found.length > 0) await this.persist();
    return found.slice(0, SEARCH_HITS);
  }

  /**
   * The block injected at boot: diverse mix of most-used + most-recent, so a few
   * stale high-hit entries cannot evict fresh decisions.
   */
  render(limit = BOOT_ENTRIES): string {
    if (this.entries.length === 0) return '';
    // ensure global is loaded synchronously if already loaded; otherwise project-only
    const pool = this.entries;
    const byHits = [...pool].sort((a, b) => b.hits - a.hits || b.createdAt.localeCompare(a.createdAt));
    const byRecent = [...pool].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    const seen = new Set<string>();
    const ranked: MemoryEntry[] = [];
    // interleave: take from hits, then recent, until limit
    let hi = 0;
    let ri = 0;
    while (ranked.length < limit && (hi < byHits.length || ri < byRecent.length)) {
      if (hi < byHits.length) {
        const e = byHits[hi++]!;
        if (!seen.has(e.id)) {
          seen.add(e.id);
          ranked.push(e);
        }
        if (ranked.length >= limit) break;
      }
      if (ri < byRecent.length) {
        const e = byRecent[ri++]!;
        if (!seen.has(e.id)) {
          seen.add(e.id);
          ranked.push(e);
        }
      }
    }
    // recency bonus visible in ordering already via interleave; keep hits bias slightly by stable sort
    // final sort by composite score for determinism: hits*2 + recency
    const now = Date.now();
    ranked.sort((a, b) => {
      const aRec = Math.max(0, 10 - (now - Date.parse(a.lastHitAt ?? a.createdAt)) / (24 * 60 * 60 * 1000) * 0.1);
      const bRec = Math.max(0, 10 - (now - Date.parse(b.lastHitAt ?? b.createdAt)) / (24 * 60 * 60 * 1000) * 0.1);
      return b.hits * 2 + bRec - (a.hits * 2 + aRec) || b.createdAt.localeCompare(a.createdAt);
    });

    return [
      '',
      'What you learned about this project in earlier sessions. Trust it, but verify anything',
      'that contradicts what you can see in the code now:',
      ...ranked.slice(0, limit).map((e) => `- (${KIND_LABEL[e.kind]}) ${e.text}`),
    ].join('\n');
  }

  /** Render including global entries (for prompt). Falls back to project-only when global empty. */
  renderWithGlobal(limit = BOOT_ENTRIES): string {
    const hasGlobal = this.globalEntries.length > 0;
    if (!hasGlobal) return this.render(limit);
    const merged = [...this.globalEntries, ...this.entries];
    if (merged.length === 0) return '';
    const byHits = [...merged].sort((a, b) => b.hits - a.hits || b.createdAt.localeCompare(a.createdAt));
    const byRecent = [...merged].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const seen = new Set<string>();
    const ranked: MemoryEntry[] = [];
    let hi = 0;
    let ri = 0;
    while (ranked.length < limit && (hi < byHits.length || ri < byRecent.length)) {
      if (hi < byHits.length) {
        const e = byHits[hi++]!;
        if (!seen.has(e.id)) {
          seen.add(e.id);
          ranked.push(e);
        }
        if (ranked.length >= limit) break;
      }
      if (ri < byRecent.length) {
        const e = byRecent[ri++]!;
        if (!seen.has(e.id)) {
          seen.add(e.id);
          ranked.push(e);
        }
      }
    }
    return [
      '',
      'What you learned about this project in earlier sessions (project + global). Trust but verify:',
      ...ranked.slice(0, limit).map((e) => `- (${KIND_LABEL[e.kind]}) ${e.text}`),
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

  /**
   * Suggest 1-3 memory candidates from a transcript. Used as afterTurn hook for
   * lifelong learning; caller decides whether to persist (via add/addGlobal).
   */
  async suggestFromTranscript(
    messages: { role: string; content: unknown }[],
  ): Promise<{ kind: MemoryKind; text: string }[]> {
    if (!this.model) return [];
    if (messages.length < 4) return [];
    try {
      const slice = messages.slice(-20);
      const transcript = slice
        .map((m) => {
          const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content).slice(0, 2000);
          return `${m.role}: ${c}`;
        })
        .join('\n')
        .slice(0, 8000);
      const { text } = await generateText({
        model: this.model,
        system:
          'Extract 0-3 durable learnings from this coding session that will still be true next session. ' +
          'Only decisions with reason, traps, or working commands — not narration. ' +
          'Output one per line as [fact|decision|gotcha|command] text, or empty if nothing durable.',
        prompt: transcript,
        maxRetries: 1,
      });
      return text
        .split('\n')
        .map((line) => /^\s*\[(fact|decision|gotcha|command)\]\s*(.+?)\s*$/i.exec(line))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => ({ kind: m[1]!.toLowerCase() as MemoryKind, text: m[2]!.trim().slice(0, MAX_TEXT) }))
        .slice(0, 3);
    } catch {
      return [];
    }
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
          scope: z.enum(['project', 'global']).optional().describe('project (default) or global (cross-project pattern)'),
        }),
        execute: async ({ kind, text, scope }) => {
          if (scope === 'global') {
            const entry = await this.addGlobal(kind, text);
            if (!entry) return `Already recorded globally: ${text.trim()}`;
            return `Remembered globally as ${entry.kind} (${this.globalEntries.length} global): ${entry.text}`;
          }
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

export { fileFor as memoryFileFor, root as memoryDir, KIND_LABEL, globalFile as globalMemoryFile };

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
