/**
 * Anthropic Messages API adapter.
 *
 * POST https://api.anthropic.com/v1/messages with `stream: true`.
 * Auth is `x-api-key` (not a bearer token) plus the `anthropic-version` header.
 *
 * The SSE stream carries several event types; only `content_block_delta` with a
 * `text_delta` contains answer text. `message_stop` ends it. Errors can also
 * arrive mid-stream as an `error` event after a 200, so those are surfaced too
 * rather than silently truncating the answer.
 */
import {
  LLMError,
  errorDetail,
  fetchWithTimeout,
  readSSE,
  type LLMProvider,
  type LLMProviderConfig,
} from './provider';

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

interface AnthropicEvent {
  type: string;
  delta?: { type?: string; text?: string };
  error?: { message?: string; type?: string };
}

export class AnthropicProvider implements LLMProvider {
  readonly id = 'anthropic';

  constructor(private readonly config: LLMProviderConfig) {}

  get describe(): string {
    return `api.anthropic.com · ${this.config.model}`;
  }

  async *stream(
    systemPrompt: string,
    userText: string,
    signal: AbortSignal,
  ): AsyncIterable<string> {
    if (!this.config.apiKey) throw new LLMError('no auto-answer API key (separate from the speech-to-text key)');

    const response = await fetchWithTimeout(
      ENDPOINT,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.config.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model: this.config.model,
          max_tokens: this.config.maxTokens,
          system: systemPrompt,
          messages: [{ role: 'user', content: userText }],
          stream: true,
        }),
      },
      this.config.timeoutMs,
      signal,
    );

    if (!response.ok) {
      throw new LLMError(
        `Anthropic ${response.status}: ${await errorDetail(response)}`,
        response.status,
      );
    }
    if (!response.body) throw new LLMError('Anthropic returned an empty body');

    for await (const payload of readSSE(response.body, signal)) {
      let event: AnthropicEvent;
      try {
        event = JSON.parse(payload) as AnthropicEvent;
      } catch {
        continue;
      }

      if (event.type === 'error') {
        throw new LLMError(`Anthropic stream error: ${event.error?.message ?? 'unknown'}`);
      }
      if (event.type === 'message_stop') return;
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        const text = event.delta.text;
        if (text) yield text;
      }
    }
  }
}
