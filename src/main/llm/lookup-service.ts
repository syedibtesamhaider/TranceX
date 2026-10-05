/**
 * Auto-answer orchestration: trigger, filter, rate limit, cancellation, streaming.
 *
 * Runs entirely in the Electron main process, on its own async path. The
 * recognizer is in a *separate process*, so a lookup cannot slow transcription
 * down: the only thing this feature adds to the transcript path is one extra
 * event emitted by the sidecar's segmenter when a segment closes (a queue put,
 * off the inference worker).
 *
 * Nothing here is written to disk. Entries live in renderer memory and in the
 * `inFlight` handle below, and both die with the process.
 */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createProvider, resolveApiKey } from './provider-factory';
import { classify, materiallyDifferent } from './question-filter';
import { RateLimiter, type RateLimitState } from './rate-limiter';
import type { LLMProvider } from './provider';
import type { LookupConfig } from '../../shared/types';

const WINDOW_MS = 60 * 60 * 1000;

/** Marker the model puts on its first line so the UI can show the guess. */
export const INTERPRETATION_PREFIX = 'INTERPRETED:';

/**
 * System prompt.
 *
 * The recogniser is imperfect, so the model is told to treat its input as noisy
 * and repair it before answering — "scalable application" arriving as "SK label"
 * is a transcription failure, not a question about SK.
 *
 * The INTERPRETED: line is an addition to the requested wording: without a
 * machine-readable marker there is no way to show the model's guess separately
 * above the answer, which was also asked for.
 *
 * The uncertainty clause is the reconstructed "last line" from an earlier brief —
 * no filler hedging, but explicit uncertainty marks are mandatory.
 */
export function buildSystemPrompt(bulletCount: string): string {
  return [
    'The following is imperfect speech-to-text output from a live meeting, so words may be misheard.',
    'First infer what the speaker most likely actually asked, then answer that.',
    'If the text is too garbled to interpret confidently, reply with only: unclear',
    '',
    `Start your reply with a single line "${INTERPRETATION_PREFIX} <the question as you understood it>".`,
    `Then answer in ${bulletCount} bullet points, most relevant on top.`,
    'Plain factual tone. No preamble, no hedging, no offers of further help.',
    'State uncertainty explicitly: prefix any bullet you are not confident about with "uncertain:",',
    'and if you do not know the answer, say so plainly instead of guessing.',
  ].join('\n');
}

export type LookupSource = 'auto' | 'manual';

export interface LookupStartedEvent {
  id: string;
  question: string;
  source: LookupSource;
  at: number;
  provider: string;
}

export interface LookupChunkEvent {
  id: string;
  text: string;
  /** ms from trigger to first token; present on the first chunk only. */
  firstTokenMs?: number;
}

export interface LookupDoneEvent {
  id: string;
  totalMs: number;
  cancelled?: boolean;
}

export interface LookupErrorEvent {
  id: string;
  message: string;
}

interface InFlight {
  id: string;
  controller: AbortController;
  question: string;
  segmentId: number | null;
  startedAt: number;
}

/**
 * How long an interim must stop changing before it is treated as a finished
 * thought.
 *
 * Two values, because the confidence differs. A partial that already ends in a
 * question mark is a complete question by itself: the service has heard the
 * whole thing and is only waiting on silence to commit it, so waiting longer
 * adds pure delay. Anything else might still be half a sentence, and firing on
 * it wastes a call and a rate-limit slot.
 *
 * This is the one place where real time can be bought back. The transcription
 * floor is the service's own emission cadence — measured at ~1.25 s median from
 * word spoken to word received, unchanged across 20/50/100 ms chunk sizes — so
 * the only way the answer arrives sooner is to start generating it before the
 * question has been committed.
 */
const SETTLE_COMPLETE_MS = 150;
const SETTLE_PARTIAL_MS = 600;

export class LookupService extends EventEmitter {
  private config: LookupConfig;
  private provider: LLMProvider | null = null;
  private limiter: RateLimiter;

  private inFlight: InFlight | null = null;
  /** Latest interim text per open segment, used to fire before finalization. */
  private readonly interimBySegment = new Map<number, string>();
  /** Segment ids we already fired on, so the final does not double-fire. */
  private readonly firedSegments = new Map<number, { id: string; text: string }>();
  private lastAccepted = 0;
  /** Debounce for the settled-interim trigger; see noteInterim(). */
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private pausedUntil = 0;

  constructor(config: LookupConfig) {
    super();
    this.config = config;
    this.limiter = new RateLimiter(config.callsPerHour, WINDOW_MS, config.minSpacingMs);
  }

  updateConfig(config: LookupConfig): void {
    const limitsChanged =
      config.callsPerHour !== this.config.callsPerHour ||
      config.minSpacingMs !== this.config.minSpacingMs;
    this.config = config;
    this.provider = null; // rebuilt lazily with the new settings
    if (limitsChanged) {
      this.limiter = new RateLimiter(config.callsPerHour, WINDOW_MS, config.minSpacingMs);
    }
    this.emitStatus();
  }

  get hasApiKey(): boolean {
    // A local Ollama needs no key; everything else does.
    if (this.config.provider === 'openai_compatible' && /localhost|127\.0\.0\.1/.test(this.config.baseUrl)) {
      return true;
    }
    return resolveApiKey(this.config).length > 0;
  }

  get paused(): boolean {
    return Date.now() < this.pausedUntil;
  }

  status(): {
    enabled: boolean;
    hasApiKey: boolean;
    paused: boolean;
    pausedForMs: number;
    provider: string;
    rate: RateLimitState;
  } {
    return {
      enabled: this.config.autoAnswer,
      hasApiKey: this.hasApiKey,
      paused: this.paused,
      pausedForMs: Math.max(0, this.pausedUntil - Date.now()),
      provider: this.describeProvider(),
      rate: this.limiter.state(),
    };
  }

  private describeProvider(): string {
    try {
      return this.ensureProvider().describe;
    } catch {
      return this.config.provider;
    }
  }

  private ensureProvider(): LLMProvider {
    if (!this.provider) this.provider = createProvider(this.config);
    return this.provider;
  }

  private emitStatus(): void {
    this.emit('status', this.status());
  }

  /** Toggles the 5-minute pause. Returns the new paused state. */
  togglePause(): boolean {
    this.pausedUntil = this.paused ? 0 : Date.now() + this.config.pauseMinutes * 60 * 1000;
    console.log(
      this.paused
        ? `[lookup] paused for ${this.config.pauseMinutes} minutes`
        : '[lookup] pause cleared',
    );
    this.emitStatus();
    return this.paused;
  }

  // -- trigger path ---------------------------------------------------------

  /**
   * Latest interim text for an open segment.
   *
   * On the realtime path the service only commits a sentence once it hears
   * silence, so a person who keeps talking produces no `final` at all and the
   * auto-answer would sit idle through the entire question. Instead we treat an
   * interim that has stopped changing as good enough to act on: if the text has
   * been stable for SETTLE_MS it goes down the normal trigger path, where the
   * question filter still has to accept it.
   *
   * Nothing is duplicated by this: onFinal() records what was fired per segment
   * and only re-issues when the committed text differs materially.
   */
  noteInterim(segmentId: number, text: string): void {
    const previous = this.interimBySegment.get(segmentId);
    this.interimBySegment.set(segmentId, text);
    if (!this.config.autoAnswer || text === previous) return;

    if (this.settleTimer) clearTimeout(this.settleTimer);
    const delay = text.trimEnd().endsWith('?') ? SETTLE_COMPLETE_MS : SETTLE_PARTIAL_MS;
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      const settled = this.interimBySegment.get(segmentId);
      // Only act once per segment here; a later, longer interim that is also a
      // question will differ materially and be re-issued by the same guard.
      if (settled && settled === text && !this.firedSegments.has(segmentId)) {
        this.consider(settled, segmentId, 'auto');
      }
    }, delay);
  }

  /**
   * End-of-speech. Fires off the *interim* text so the API call overlaps with
   * the final transcription, exactly as specified.
   *
   * Note this only helps when interim passes are actually running. They are
   * skipped whenever decoding is slower than ~0.6x real time, which on a CPU
   * setup is most of the time — there the fallback below (fire on final) is
   * what runs.
   */
  onSegmentClosed(segmentId: number): void {
    if (!this.config.autoAnswer) return;
    const interim = this.interimBySegment.get(segmentId);
    if (!interim) return; // no interim available; onFinal will handle it
    this.consider(interim, segmentId, 'auto');
  }

  /** Finalized segment. Fires if we did not already, re-issues if it changed. */
  onFinal(segmentId: number, text: string): void {
    this.clearSettleTimer();
    this.interimBySegment.delete(segmentId);
    if (!this.config.autoAnswer) return;

    const already = this.firedSegments.get(segmentId);
    if (already) {
      if (!materiallyDifferent(already.text, text)) return;
      console.log(
        `[lookup] final differs from interim, re-issuing\n  interim: ${already.text}\n  final:   ${text}`,
      );
      this.cancelInFlight('superseded by corrected transcript');
      this.firedSegments.delete(segmentId);
    }
    this.consider(text, segmentId, 'auto');
  }

  /**
   * Opens the connection to the provider ahead of the first question.
   *
   * DNS, TCP and TLS to a fresh host cost a few hundred ms, and without this
   * the very first answer of a session pays all of it on top of generation.
   * The request is deliberately the smallest the API accepts and its output is
   * discarded; undici keeps the socket pooled for the real calls that follow.
   *
   * Only ever runs when auto-answer is on and transcription has been started by
   * the user, so it never reaches the network unprompted. Failures are ignored:
   * this is an optimisation, and the real lookup reports its own errors.
   */
  async prewarm(): Promise<void> {
    if (!this.config.autoAnswer || !this.config.apiKey) return;
    try {
      const provider = this.ensureProvider();
      const controller = new AbortController();
      // Aborted at the first token: the handshake is what we came for, and
      // stopping there keeps the generation cost to almost nothing.
      for await (const _chunk of provider.stream('Reply with "ok".', 'ok', controller.signal)) {
        break;
      }
      controller.abort();
      console.log(`[lookup] connection warmed (${provider.describe})`);
    } catch {
      // Nothing to report: the next real lookup surfaces any genuine problem.
    }
  }

  /** Manual lookup: bypasses the question filter, the toggle and the pause. */
  manual(text: string): void {
    const trimmed = (text ?? '').trim();
    if (!trimmed) {
      console.log('[lookup] manual lookup skipped: no transcript line available');
      return;
    }
    this.dispatch(trimmed, null, 'manual');
  }

  private consider(text: string, segmentId: number, source: LookupSource): void {
    if (this.paused) {
      console.log(`[lookup] rejected (paused): ${text.slice(0, 60)}`);
      return;
    }

    const verdict = classify(text, this.lastAccepted);
    if (!verdict.accepted) {
      console.log(`[lookup] rejected (${verdict.reason}: ${verdict.detail}): ${text.slice(0, 80)}`);
      return;
    }

    console.log(`[lookup] accepted (${verdict.matched}): ${verdict.question}`);
    this.lastAccepted = Date.now();
    this.firedSegments.set(segmentId, { id: '', text });
    // Keep the map from growing across a long meeting.
    if (this.firedSegments.size > 32) {
      const oldest = this.firedSegments.keys().next().value;
      if (oldest !== undefined) this.firedSegments.delete(oldest);
    }
    this.dispatch(verdict.question, segmentId, source);
  }

  private dispatch(question: string, segmentId: number | null, source: LookupSource): void {
    if (!this.hasApiKey) {
      this.emit('error', { id: randomUUID(), message: 'no auto-answer API key — set it in Settings → Auto-answer, or OVERLAY_LLM_API_KEY' });
      return;
    }

    const denial = this.limiter.tryAcquire();
    if (denial) {
      // Skip silently — never queue.
      console.log(`[lookup] skipped (${denial}): ${question.slice(0, 60)}`);
      this.emitStatus();
      return;
    }

    // A newer question always wins; the old request is aborted, not stacked.
    this.cancelInFlight('superseded by a newer question');

    const id = randomUUID();
    const controller = new AbortController();
    const startedAt = Date.now();
    this.inFlight = { id, controller, question, segmentId, startedAt };
    if (segmentId !== null) this.firedSegments.set(segmentId, { id, text: question });

    this.emit('started', {
      id,
      question,
      source,
      at: startedAt,
      provider: this.describeProvider(),
    } satisfies LookupStartedEvent);
    this.emitStatus();

    void this.run(id, question, controller, startedAt);
  }

  private async run(
    id: string,
    question: string,
    controller: AbortController,
    startedAt: number,
  ): Promise<void> {
    let firstToken = true;
    try {
      const provider = this.ensureProvider();
      const systemPrompt = buildSystemPrompt(this.config.bulletCount);

      for await (const chunk of provider.stream(systemPrompt, question, controller.signal)) {
        if (controller.signal.aborted) break;
        const event: LookupChunkEvent = { id, text: chunk };
        if (firstToken) {
          firstToken = false;
          event.firstTokenMs = Date.now() - startedAt;
        }
        this.emit('chunk', event);
      }

      if (controller.signal.aborted) {
        this.emit('done', { id, totalMs: Date.now() - startedAt, cancelled: true });
      } else {
        this.emit('done', { id, totalMs: Date.now() - startedAt } satisfies LookupDoneEvent);
      }
    } catch (err) {
      if (controller.signal.aborted) {
        this.emit('done', { id, totalMs: Date.now() - startedAt, cancelled: true });
      } else {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[lookup] ${message}`);
        this.emit('error', { id, message } satisfies LookupErrorEvent);
      }
    } finally {
      if (this.inFlight?.id === id) this.inFlight = null;
      this.emitStatus();
    }
  }

  private clearSettleTimer(): void {
    if (this.settleTimer) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
  }

  private cancelInFlight(reason: string): void {
    if (!this.inFlight) return;
    console.log(`[lookup] cancelling ${this.inFlight.id}: ${reason}`);
    this.inFlight.controller.abort(new Error(reason));
    this.inFlight = null;
  }

  /** One trivial request, for the settings "Test connection" button. */
  async testConnection(): Promise<{ ok: boolean; latencyMs: number; detail: string }> {
    const startedAt = Date.now();
    if (!this.hasApiKey) {
      return { ok: false, latencyMs: 0, detail: 'no auto-answer API key — set it in Settings → Auto-answer, or OVERLAY_LLM_API_KEY' };
    }
    const controller = new AbortController();
    try {
      const provider = this.ensureProvider();
      let received = '';
      for await (const chunk of provider.stream('Reply with the single word: ok', 'ping', controller.signal)) {
        received += chunk;
        if (received.length > 16) break; // enough to prove the stream works
      }
      controller.abort();
      return {
        ok: true,
        latencyMs: Date.now() - startedAt,
        detail: `${this.describeProvider()} replied "${received.trim().slice(0, 24) || '(empty)'}"`,
      };
    } catch (err) {
      controller.abort();
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Privacy: drop everything held in memory. */
  dispose(): void {
    this.clearSettleTimer();
    this.cancelInFlight('shutting down');
    this.interimBySegment.clear();
    this.firedSegments.clear();
  }
}
