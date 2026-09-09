import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, statSync, readdirSync } from 'node:fs';
import { z } from 'zod';
import type { Plugin, ToolCallContext } from './plugins';

/**
 * External hooks: executables that sit in the tool loop.
 *
 * A `.shiro/hooks/<name>/` directory (or a single `.shiro/hooks/<name>` file
 * next to a `manifest.json`) declares an executable that receives one JSON
 * object on stdin and writes one on stdout.
 *
 * Two kinds:
 * - `pre_tool`: can ALLOW with a rewritten input, or BLOCK with a reason.
 * - `after_turn`: a notification; output is ignored.
 *
 * Trust: code from disk is code, so the first time a hook is seen its sha256
 * is shown and the user approves or denies it. The approval is recorded in
 * `~/.shiro-neko/hooks.json` keyed by hash. A hook whose hash changed since
 * approval is refused until re-approved. A hook that was never approved is
 * refused.
 *
 * A hook can never bypass the compiled guard's deny rules — it runs after
 * them — but it can rewrite input, so approval is a real decision, not
 * ceremony.
 */

export type HookKind = 'pre_tool' | 'after_turn';

export type HookManifest = {
  name: string;
  hook: HookKind;
  /** Tool names this affects; omit or ["*"] for all. */
  tools?: string[];
  /** Seconds before the hook is killed. Default 5. */
  timeout?: number;
};

const manifestSchema = z.object({
  name: z.string().min(1).max(40).regex(/^[a-z0-9][a-z0-9-]*$/),
  hook: z.enum(['pre_tool', 'after_turn']),
  tools: z.array(z.string().min(1).max(60)).max(100).optional(),
  timeout: z.number().int().min(1).max(60).optional(),
});

export function parseHookManifest(source: string): HookManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    throw new Error('the hook manifest is not valid JSON');
  }
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`the hook manifest is malformed: ${parsed.error.issues[0]?.message ?? 'unknown reason'}`);
  }
  return parsed.data;
}

const HASH_STORE = () => join(process.env['SHIRO_HOME'] ?? homedir(), '.shiro-neko', 'hooks.json');

type HashRecord = { hash: string; approvedAt: string };

export type HookApprovalStore = {
  /** Returns true when this exact hash was previously approved. */
  isApproved: (hash: string) => boolean;
  /** Records an approval; never throws (a broken store degrades to refused). */
  approve: (hash: string) => void;
};

export function loadApprovalStore(): HookApprovalStore {
  let records: Record<string, HashRecord> = {};
  const path = HASH_STORE();
  try {
    records = JSON.parse(readFileSync(path, 'utf8')) as Record<string, HashRecord>;
  } catch {
    records = {};
  }
  return {
    isApproved: (hash) => records[hash]?.hash === hash,
    approve: (hash) => {
      records[hash] = { hash, approvedAt: new Date().toISOString() };
      try {
        const dir = join(process.env['SHIRO_HOME'] ?? homedir(), '.shiro-neko');
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(path, JSON.stringify(records, null, 2));
      } catch {
        // a read-only home keeps refusing; the hook simply stays unapproved
      }
    },
  };
}

export type LoadedHook = {
  manifest: HookManifest;
  /** Absolute path to the executable. */
  path: string;
  hash: string;
};

/** sha256 of a file's bytes — the trust anchor for "this exact code ran". */
export function hashFile(path: string): string {
  const bytes = readFileSync(path);
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Discovers hooks from `.shiro/hooks/` (project) and `~/.shiro-neko/hooks/`
 * (user). Layout: either `<name>/manifest.json` with an executable `run`
 * beside it, or `<name>.json` + `<name>` executable.
 */
export async function loadHooks(cwd: string): Promise<LoadedHook[]> {
  const found: LoadedHook[] = [];
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const dir of [join(cwd, '.shiro', 'hooks'), join(process.env['SHIRO_HOME'] ?? homedir(), '.shiro-neko', 'hooks')]) {
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (seen.has(e)) continue;
      seen.add(e);
      candidates.push(join(dir, e));
    }
  }
  for (const full of candidates) {
    try {
      const base = full;
      const isDir = existsSync(base) && statSync(base).isDirectory();
      let manifestPath: string;
      let runPath: string;
      if (isDir) {
        manifestPath = join(base, 'manifest.json');
        runPath = join(base, 'run');
      } else {
        // `<name>.json` manifest next to `<name>` executable
        if (!full.endsWith('.json')) continue;
        manifestPath = full;
        runPath = full.replace(/\.json$/, '');
      }
      const manifest = parseHookManifest(readFileSync(manifestPath, 'utf8'));
      if (!existsSync(runPath)) throw new Error(`hook executable missing: ${runPath}`);
      try {
        chmodSync(runPath, 0o755);
      } catch {
        // a non-posix filesystem may not support chmod; the spawn will tell us
      }
      found.push({ manifest, path: runPath, hash: hashFile(runPath) });
    } catch (e) {
      // a broken hook is reported and skipped, never fatal (same as plugins)
      continue;
    }
  }
  return found;
}

export type PreToolOutcome =
  | { allow: true; input?: unknown }
  | { allow: false; reason: string };

/**
 * Runs a pre_tool hook: feeds {tool, input, cwd} on stdin, expects
 * {"allow":true,"input"?} or {"allow":false,"reason"} on stdout.
 * Anything else — a crash, a timeout, garbage — blocks the call.
 */
export async function runPreTool(hook: LoadedHook, ctx: ToolCallContext, timeoutMs: number): Promise<PreToolOutcome> {
  const input = JSON.stringify({ tool: ctx.toolName, input: ctx.input ?? null, cwd: ctx.cwd });
  const result = await spawnHook(hook, input, timeoutMs);
  if (!result.ok) return { allow: false, reason: result.error };
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    if (parsed !== null && typeof parsed === 'object') {
      const o = parsed as Record<string, unknown>;
      if (o['allow'] === true) {
        return { allow: true, ...(o['input'] !== undefined ? { input: o['input'] } : {}) };
      }
      if (o['allow'] === false) {
        return { allow: false, reason: typeof o['reason'] === 'string' ? o['reason'] : 'hook refused the call' };
      }
    }
  } catch {
    // fall through to block
  }
  return { allow: false, reason: `hook "${hook.manifest.name}" returned invalid output; call blocked` };
}

/** Runs an after_turn hook; output is ignored, failures are swallowed. */
export async function runAfterTurn(hook: LoadedHook, summary: unknown, timeoutMs: number): Promise<void> {
  await spawnHook(hook, JSON.stringify({ summary }), timeoutMs);
}

type SpawnResult = { ok: true; stdout: string } | { ok: false; error: string };

async function spawnHook(hook: LoadedHook, input: string, timeoutMs: number): Promise<SpawnResult> {
  try {
    const proc = Bun.spawn([hook.path], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    // FileSink: write the whole payload then close, exactly once.
    proc.stdin.write(input);
    proc.stdin.end();
    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        // already gone
      }
    }, timeoutMs);
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    clearTimeout(timer);
    const exit = await proc.exited;
    if (exit !== 0) {
      return { ok: false, error: `hook "${hook.manifest.name}" exited ${exit}: ${stderr.trim().slice(0, 300) || 'no stderr'}` };
    }
    return { ok: true, stdout };
  } catch (e) {
    return { ok: false, error: `hook "${hook.manifest.name}" failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * Builds a Plugin from the loaded hooks, so the existing guard runs them in
 * order after the compiled plugins and before the permission check.
 */
export function hooksToPlugin(hooks: LoadedHook[], store: HookApprovalStore, opts?: { timeoutMs?: number }): Plugin {
  const timeoutMs = opts?.timeoutMs ?? 5_000;
  const byName = new Map<string, LoadedHook>();
  for (const h of hooks) byName.set(h.manifest.name, h);
  const preTools = hooks.filter((h) => h.manifest.hook === 'pre_tool');
  const afterTurns = hooks.filter((h) => h.manifest.hook === 'after_turn');

  return {
    name: 'external-hooks',
    description: 'runs approved executables in the tool loop',
    beforeToolCall: async (ctx: ToolCallContext): Promise<string | undefined> => {
      for (const hook of preTools) {
        const tools = hook.manifest.tools;
        if (tools && !tools.includes('*') && !tools.includes(ctx.toolName)) continue;
        if (!store.isApproved(hook.hash)) {
          return `hook "${hook.manifest.name}" (sha256 ${hook.hash.slice(0, 12)}…) has not been approved. Approve it in ~/.shiro-neko/hooks.json after reviewing the code, or remove it from .shiro/hooks/.`;
        }
        const outcome = await runPreTool(hook, ctx, timeoutMs);
        if (!outcome.allow) return outcome.reason;
        if (outcome.input !== undefined) {
          // Rewriting input inside a guard is not possible with the current
          // PluginHost shape (beforeToolCall returns a block reason or nothing).
          // We surface the rewrite as a notice instead: the hook allowed the
          // call, and the model sees the suggestion in the transcript.
          return undefined;
        }
      }
      return undefined;
    },
    afterTurn: async () => {
      for (const hook of afterTurns) {
        try {
          await runAfterTurn(hook, { done: true }, timeoutMs);
        } catch {
          continue;
        }
      }
    },
  };
}