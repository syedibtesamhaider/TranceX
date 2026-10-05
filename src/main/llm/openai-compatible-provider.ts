/**
 * Generic /v1/chat/completions adapter.
 *
 * One code path for every backend that speaks the OpenAI wire format — Groq,
 * Gemini's OpenAI-compatible endpoint, OpenRouter, Together, LM Studio, and a
 * local Ollama. Only `baseUrl`, `model` and `apiKey` differ; see PROVIDERS.md
 * for the exact settings block per backend.
 *
 * The system prompt is sent as a `system` role message rather than a separate
 * field, which is what this format expects.
 */
import {
  LLMError,
  errorDetail,
  fetchWithTimeout,
  readSSE,
  type LLMProvider,
  type LLMProviderConfig,
} from './provider';

interface ChatChunk {
  choices?: Array<{
    delta?: { content?: string | null };
    finish_reason?: string | null;
  }>;
  error?: { message?: string };
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly id = 'openai_compatible';

  constructor(private readonly config: LLMProviderConfig) {}

  private get endpoint(): string {
    // Tolerate a trailing slash, and a baseUrl given with or without /v1.
    const base = this.config.baseUrl.replace(/\/+$/, '');
    if (base.endsWith('/chat/completions')) return base;
    return `${base}/chat/completions`;
  }

  get describe(): string {
    let host = this.config.baseUrl;
    try {
      host = new URL(this.config.baseUrl).host;
    } catch {
      /* show the raw string if it is not a valid URL */
    }
    return `${host} · ${this.config.model}`;
  }

  async *stream(
    systemPrompt: string,
    userText: string,
    signal: AbortSignal,
  ): AsyncIterable<string> {
    if (!this.config.baseUrl) throw new LLMError('no base URL configured');

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    // A local Ollama needs no key; everything else does.
    if (this.config.apiKey) headers.authorization = `Bearer ${this.config.apiKey}`;

    const response = await fetchWithTimeout(
      this.endpoint,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: this.config.model,
          max_tokens: this.config.maxTokens,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userText },
          ],
          stream: true,
        }),
      },
      this.config.timeoutMs,
      signal,
    );

    if (!response.ok) {
      throw new LLMError(
        `${this.describe} ${response.status}: ${await errorDetail(response)}`,
        response.status,
      );
    }
    if (!response.body) throw new LLMError('provider returned an empty body');

    for await (const payload of readSSE(response.body, signal)) {
      let chunk: ChatChunk;
      try {
        chunk = JSON.parse(payload) as ChatChunk;
      } catch {
        continue;
      }

      if (chunk.error) {
        throw new LLMError(`stream error: ${chunk.error.message ?? 'unknown'}`);
      }
      const choice = chunk.choices?.[0];
      const text = choice?.delta?.content;
      if (text) yield text;
      if (choice?.finish_reason) return;
    }
  }
}
