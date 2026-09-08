export type ToolSetName = 'core' | 'edit-plus' | 'nav' | 'extra' | 'git' | 'net';

export type ToolMeta = { set: ToolSetName; mutating: boolean };

/**
 * Tags a tool with its set and mutating flag at the definition site.
 * `_meta` is consumed only to derive TOOL_SETS and MUTATING_TOOLS.
 */
export function withMeta<T>(meta: ToolMeta, t: T): T & { _meta: ToolMeta } {
  return Object.assign(t as object, { _meta: meta }) as T & { _meta: ToolMeta };
}

export function mutatingNames(tools: Record<string, { _meta?: ToolMeta }>): string[] {
  const out = Object.entries(tools)
    .filter(([, t]) => t._meta?.mutating)
    .map(([name]) => name);
  out.sort();
  return out;
}

export function setsFrom(tools: Record<string, { _meta?: ToolMeta }>): Record<ToolSetName, readonly string[]> {
  const out: Record<ToolSetName, string[]> = { core: [], 'edit-plus': [], nav: [], extra: [], git: [], net: [] };
  for (const [name, t] of Object.entries(tools)) {
    const set = t._meta?.set;
    if (set) out[set].push(name);
  }
  for (const k of Object.keys(out) as ToolSetName[]) out[k].sort();
  return out as Record<ToolSetName, readonly string[]>;
}

export function assertAllToolsInSets(tools: Record<string, unknown>, sets: Record<ToolSetName, readonly string[]>): string[] {
  const covered = new Set((Object.values(sets) as unknown as string[][]).flat());
  return Object.keys(tools).filter((name) => !covered.has(name));
}
