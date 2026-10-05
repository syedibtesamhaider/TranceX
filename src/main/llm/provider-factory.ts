/**
 * Builds the configured provider. The only place that knows which adapters
 * exist — adding a backend means one entry here.
 *
 * The API key is resolved from the environment first and the settings file
 * second, so it is possible to run without the key ever touching disk:
 *
 *     $env:OVERLAY_LLM_API_KEY = "sk-..."
 */
import { AnthropicProvider } from './anthropic-provider';
import { OpenAICompatibleProvider } from './openai-compatible-provider';
import type { LLMProvider, LLMProviderConfig } from './provider';
import type { LookupConfig } from '../../shared/types';

export const API_KEY_ENV = 'OVERLAY_LLM_API_KEY';

export function resolveApiKey(config: LookupConfig): string {
  return (process.env[API_KEY_ENV] || config.apiKey || '').trim();
}

/** True when the key came from the environment rather than config.json. */
export function apiKeyFromEnv(): boolean {
  return Boolean((process.env[API_KEY_ENV] || '').trim());
}

export function createProvider(config: LookupConfig): LLMProvider {
  const providerConfig: LLMProviderConfig = {
    baseUrl: config.baseUrl,
    model: config.model,
    apiKey: resolveApiKey(config),
    maxTokens: config.maxTokens,
    timeoutMs: config.timeoutMs,
  };

  switch (config.provider) {
    case 'anthropic':
      return new AnthropicProvider(providerConfig);
    case 'openai_compatible':
      return new OpenAICompatibleProvider(providerConfig);
    default: {
      // Exhaustiveness guard: a new provider id must be handled here.
      const unreachable: never = config.provider;
      throw new Error(`unknown provider "${String(unreachable)}"`);
    }
  }
}
