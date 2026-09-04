import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { withFallback, type FallbackEvent } from './fallback';
import type { McpServerConfig } from './mcp';
import { parsePermissions, type PermissionConfig } from './permission';
import { readClaudeCodeSettings } from './providers';
import { isToolSetName, type ToolSetName } from './tools';

export type ProviderName = 'anthropic' | 'openai';

export type Config = {
  provider: ProviderName;
  model: string;
  baseURL?: string;
  apiKey?: string;
  /** Preset id from providers.ts, kept so /provider can show what is configured. */
  presetId?: string;
  /** Retries per model call for transient failures. SDK default is 2. */
  maxRetries?: number;
  /** Default agent variant name. */
  agent?: string;
  /** Default thinking level. */
  thinking?: string;
  /** Plugin names to enable; omit for the default set. */
  plugins?: string[];
  /** Optional tool sets to offer beyond `core`; omit for all of them. */
  toolSets?: ToolSetName[];
  /** Which tool calls run, ask, or are refused. Omit for the defaults. */
  permission?: PermissionConfig;
  /** Model used for subagent (task tool) calls. Omit to use the parent's model. */
  subagentModel?: string;
  /** Bag optional max estimated USD spend for one session/run. Stops a runaway run. */
  maxSpendUsd?: number;
  /** Index for `/registry`. Omit for the default one. */
  registryUrl?: string;
  mcpServers?: Record<string, McpServerConfig>;
};

const configPath = () => join(process.env['SHIRO_HOME'] ?? homedir(), '.shiro-neko', 'config.json');

const DEFAULT_MODEL: Record<ProviderName, string> = {
  anthropic: 'claude-sonnet-4-5',
  openai: 'gpt-5',
};

const DEFAULT_BASE_URL: Record<ProviderName, string> = {
  anthropic: 'https://api.anthropic.com/v1',
  openai: 'https://api.openai.com/v1',
};

/** Env key checked per provider when no explicit apiKey is configured. */
const ENV_KEY: Record<ProviderName, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
};

function isProvider(v: unknown): v is ProviderName {
  return v === 'anthropic' || v === 'openai';
}

/** Raw file contents, without env overlay. Used when rewriting the file. */
export async function readConfigFile(): Promise<Partial<Config>> {
  const f = Bun.file(configPath());
  if (!(await f.exists())) return {};
  try {
    const parsed: unknown = await f.json();
    return parsed && typeof parsed === 'object' ? (parsed as Partial<Config>) : {};
  } catch {
    throw new Error(`${configPath()} is not valid JSON`);
  }
}

/** Merges patch into the config file, preserving unrelated keys such as mcpServers. */
export async function writeConfigFile(patch: Partial<Config>): Promise<string> {
  const merged = { ...(await readConfigFile()), ...patch };
  await writeAtomic(configPath(), JSON.stringify(merged, null, 2));
  return configPath();
}

/** File config, then env overrides. Env wins so `SHIRO_MODEL=x shiro` works. */
export async function loadConfig(): Promise<Config> {
  const file = await readConfigFile();

  const envProvider = process.env['SHIRO_PROVIDER'];
  const provider = isProvider(envProvider) ? envProvider : isProvider(file.provider) ? file.provider : 'anthropic';

  // When using the claude-code preset, read from ~/.claude/settings.json
  const isClaudeCode = file.presetId === 'claude-code';
  const claudeSettings = isClaudeCode ? await readClaudeCodeSettings() : {};

  return {
    provider,
    model: process.env['SHIRO_MODEL'] ?? file.model ?? DEFAULT_MODEL[provider],
    baseURL:
      process.env['SHIRO_BASE_URL'] ??
      file.baseURL ??
      claudeSettings.baseURL ??
      DEFAULT_BASE_URL[provider],
    apiKey:
      process.env['SHIRO_API_KEY'] ??
      file.apiKey ??
      claudeSettings.apiKey ??
      process.env[ENV_KEY[provider]],
    ...(file.presetId ? { presetId: file.presetId } : {}),
    ...(file.maxRetries !== undefined ? { maxRetries: file.maxRetries } : {}),
    ...(file.agent ? { agent: file.agent } : {}),
    ...(file.thinking ? { thinking: file.thinking } : {}),
    ...(Array.isArray(file.plugins) ? { plugins: file.plugins } : {}),
    ...(Array.isArray(file.toolSets) ? { toolSets: file.toolSets.filter(isToolSetName) } : {}),
    ...(() => {
      const permission = parsePermissions(file.permission);
      return permission ? { permission } : {};
    })(),
    ...(typeof file.registryUrl === 'string' ? { registryUrl: file.registryUrl } : {}),
    ...(file.mcpServers ? { mcpServers: file.mcpServers } : {}),
    ...(typeof file.subagentModel === 'string' ? { subagentModel: file.subagentModel } : {}),
    ...(typeof file.maxSpendUsd === 'number' && file.maxSpendUsd > 0 ? { maxSpendUsd: file.maxSpendUsd } : {}),
  };
}

export function missingKeyMessage(provider: ProviderName): string {
  return `No API key for provider "${provider}". Run shiro and use /provider to set one, or set ${ENV_KEY[provider]} / SHIRO_API_KEY, or add "apiKey" to ${configPath()}`;
}

/**
 * Resolves a subagent model from config. Returns undefined when no override is
 * configured, so callers fall back to the parent model.
 */
export function resolveSubagentModel(
  cfg: Config,
  onFallback?: (e: FallbackEvent) => void,
): LanguageModel | undefined {
  if (!cfg.subagentModel || !cfg.apiKey) return undefined;
  // Build a temporary config with just the subagent model swapped in.
  const sub: Config = { ...cfg, model: cfg.subagentModel };
  try {
    return resolveModel(sub, onFallback);
  } catch {
    return undefined;
  }
}

/**
 * Writes a file atomically: write to a temp file, then rename. Prevents a
 * half-written config on crash or concurrent write.
 */
async function writeAtomic(path: string, content: string): Promise<void> {
  const tmp = `${path}.tmp.${process.pid}`;
  await Bun.write(tmp, `${content}\n`);
  const { renameSync } = await import('node:fs');
  renameSync(tmp, path);
}

const isOfficialOpenAI = (baseURL: string | undefined) =>
  !baseURL || /^https:\/\/api\.openai\.com(\/|$)/.test(baseURL);

/**
 * Newer OpenAI reasoning models refuse function tools on /v1/chat/completions and
 * demand /v1/responses. Rather than guess per model id, build both and let
 * withFallback switch when the endpoint rejects the request shape.
 */
export function resolveModel(cfg: Config, onFallback?: (e: FallbackEvent) => void): LanguageModel {
  if (!cfg.apiKey) throw new Error(missingKeyMessage(cfg.provider));

  if (cfg.provider === 'anthropic') {
    return createAnthropic({ apiKey: cfg.apiKey, baseURL: cfg.baseURL })(cfg.model);
  }

  const chat = createOpenAICompatible({
    name: 'openai',
    apiKey: cfg.apiKey,
    baseURL: cfg.baseURL ?? DEFAULT_BASE_URL.openai,
  })(cfg.model);

  if (!isOfficialOpenAI(cfg.baseURL)) return chat;

  const openai = createOpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL });
  return withFallback([chat, openai.responses(cfg.model)], onFallback);
}

export { configPath, ENV_KEY };
