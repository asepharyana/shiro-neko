import type { ProviderName } from './config';

export type ProviderPreset = {
  id: string;
  label: string;
  /** Which wire protocol to speak. */
  kind: ProviderName;
  baseURL: string;
  /** Env var checked before asking for a key. */
  envKey?: string;
  /** Servers that ignore auth, e.g. a local Ollama. */
  keyless?: boolean;
  keyHint?: string;
  fallbackModels?: string[];
};

export const PRESETS: ProviderPreset[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    kind: 'anthropic',
    baseURL: 'https://api.anthropic.com/v1',
    envKey: 'ANTHROPIC_API_KEY',
    keyHint: 'sk-ant-...',
    fallbackModels: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5'],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    kind: 'openai',
    baseURL: 'https://api.openai.com/v1',
    envKey: 'OPENAI_API_KEY',
    keyHint: 'sk-...',
    fallbackModels: ['gpt-5', 'gpt-5-mini', 'o4-mini'],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter (many models, one key)',
    kind: 'openai',
    baseURL: 'https://openrouter.ai/api/v1',
    envKey: 'OPENROUTER_API_KEY',
    keyHint: 'sk-or-...',
  },
  {
    id: 'groq',
    label: 'Groq',
    kind: 'openai',
    baseURL: 'https://api.groq.com/openai/v1',
    envKey: 'GROQ_API_KEY',
    keyHint: 'gsk_...',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    kind: 'openai',
    baseURL: 'https://api.deepseek.com/v1',
    envKey: 'DEEPSEEK_API_KEY',
    keyHint: 'sk-...',
  },
  {
    id: 'xai',
    label: 'xAI (Grok)',
    kind: 'openai',
    baseURL: 'https://api.x.ai/v1',
    envKey: 'XAI_API_KEY',
    keyHint: 'xai-...',
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    kind: 'openai',
    baseURL: 'http://localhost:11434/v1',
    keyless: true,
  },
  {
    id: 'lmstudio',
    label: 'LM Studio (local)',
    kind: 'openai',
    baseURL: 'http://localhost:1234/v1',
    keyless: true,
  },
  {
    id: 'custom-openai',
    label: 'Custom OpenAI-compatible endpoint',
    kind: 'openai',
    baseURL: '',
  },
  {
    id: 'custom-anthropic',
    label: 'Custom Anthropic-compatible endpoint',
    kind: 'anthropic',
    baseURL: '',
  },
];

export const presetById = (id: string) => PRESETS.find((p) => p.id === id);

export type ModelListResult = { models: string[]; source: 'api' | 'fallback'; warning?: string };

type ModelsResponse = { data?: unknown };

/**
 * Both OpenAI- and Anthropic-compatible servers expose `GET /v1/models` with a
 * `data[].id` shape, only the auth header differs. A server that does not
 * implement it is not fatal: the caller can still type a model id by hand.
 */
export async function fetchModels(
  preset: Pick<ProviderPreset, 'kind' | 'baseURL' | 'fallbackModels'>,
  apiKey: string,
  timeoutMs = 15_000,
): Promise<ModelListResult> {
  const url = `${preset.baseURL.replace(/\/+$/, '')}/models`;
  const headers: Record<string, string> =
    preset.kind === 'anthropic'
      ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
      : { authorization: `Bearer ${apiKey}` };

  const fallback = (warning: string): ModelListResult => ({
    models: preset.fallbackModels ?? [],
    source: 'fallback',
    warning,
  });

  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 200);
      return fallback(`${url} returned ${res.status}. ${body}`.trim());
    }
    const json = (await res.json()) as ModelsResponse;
    const models = Array.isArray(json.data)
      ? json.data
          .map((m) => (m && typeof m === 'object' ? (m as { id?: unknown }).id : undefined))
          .filter((id): id is string => typeof id === 'string')
      : [];
    if (models.length === 0) return fallback(`${url} listed no models.`);
    return { models: models.sort(), source: 'api' };
  } catch (e) {
    return fallback(e instanceof Error ? e.message : String(e));
  }
}
