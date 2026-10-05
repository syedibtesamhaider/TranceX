/**
 * The LLM provider seam.
 *
 * Everything above this interface — the question filter, the rate limiter, the
 * trigger path, the UI — is provider-agnostic. Adding a new backend means one
 * new file implementing `LLMProvider` plus one line in provider-factory.ts;
 * nothing else in the app changes.
 *
 * Providers run in the main process only. The renderer has a
 * `default-src 'none'` CSP and could not make these requests even if it wanted
 * to, and the API key must never cross the IPC boundary.
 */

export interface LLMProviderConfig {
  /** Base URL, used by the openai_compatible adapter. Ignored by anthropic. */
  baseUrl: string;
  model: string;
  apiKey: string;
  /** Upper bound on generated tokens. */
  maxTokens: number;
  /** Whole-request timeout in ms. */
  timeoutMs: number;
}

export interface LLMProvider {
  /** Identifier shown in settings and logs. */
  readonly id: string;

  /** Human-readable target, e.g. "api.anthropic.com · claude-haiku-4-5". */
  readonly describe: string;

  /**
   * Streams the answer as it is generated.
   *
   * Yields text fragments in order. Must respect `signal` promptly — a newer
   * question cancels an in-flight one rather than stacking. Throws on transport
   * or API errors; callers surface the message on the affected entry and move
   * on without retrying.
   */
  stream(
    systemPrompt: string,
    userText: string,
    signal: AbortSignal,
  ): AsyncIterable<string>;
}

export class LLMError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'LLMError';
  }
}

/**
 * Shared SSE line reader.
 *
 * Both wire formats are `data: {...}` lines separated by blank lines, so the
 * framing is parsed once here and each adapter only decides what a payload
 * means.
 */
export async function* readSSE(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      if (signal.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trimEnd();
        buffer = buffer.slice(newline + 1);
        if (line.startsWith('data:')) {
          const payload = line.slice(5).trim();
          if (payload && payload !== '[DONE]') yield payload;
        }
        newline = buffer.indexOf('\n');
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }
}

/** Wraps fetch with the provider timeout, chained to the caller's signal. */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason);
  if (signal.aborted) controller.abort(signal.reason);
  else signal.addEventListener('abort', onAbort, { once: true });

  const timer = setTimeout(
    () => controller.abort(new LLMError(`timed out after ${timeoutMs} ms`)),
    timeoutMs,
  );

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

/** Reads an error body without letting a huge payload into the log. */
export async function errorDetail(response: Response): Promise<string> {
  try {
    const text = (await response.text()).slice(0, 400);
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string }; message?: string };
      return parsed.error?.message ?? parsed.message ?? text;
    } catch {
      return text;
    }
  } catch {
    return response.statusText;
  }
}
