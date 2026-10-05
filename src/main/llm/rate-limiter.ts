/**
 * Hard rate limit: N per window, plus a minimum spacing between calls.
 *
 * Over the limit, calls are *skipped*, never queued — a question answered two
 * minutes late is worse than no answer, and a queue would also defeat the
 * cancel-on-new-question rule.
 */

export interface RateLimitState {
  /** Calls left in the rolling window. */
  remaining: number;
  limit: number;
  /** ms until the spacing rule allows another call, 0 if allowed now. */
  spacingWaitMs: number;
  /** ms until the oldest call leaves the window, 0 if the window is not full. */
  windowResetMs: number;
}

export class RateLimiter {
  private readonly timestamps: number[] = [];
  private lastCall = 0;

  constructor(
    private readonly perWindow: number,
    private readonly windowMs: number,
    private readonly minSpacingMs: number,
  ) {}

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.timestamps.length > 0 && this.timestamps[0]! <= cutoff) {
      this.timestamps.shift();
    }
  }

  state(now = Date.now()): RateLimitState {
    this.prune(now);
    const sinceLast = now - this.lastCall;
    return {
      remaining: Math.max(0, this.perWindow - this.timestamps.length),
      limit: this.perWindow,
      spacingWaitMs:
        this.lastCall === 0 || sinceLast >= this.minSpacingMs
          ? 0
          : this.minSpacingMs - sinceLast,
      windowResetMs:
        this.timestamps.length >= this.perWindow
          ? Math.max(0, this.timestamps[0]! + this.windowMs - now)
          : 0,
    };
  }

  /** Consumes a slot if one is free. Returns null when allowed, else a reason. */
  tryAcquire(now = Date.now()): string | null {
    const state = this.state(now);
    if (state.spacingWaitMs > 0) {
      return `rate limit: ${Math.ceil(state.spacingWaitMs / 1000)}s until next call allowed`;
    }
    if (state.remaining <= 0) {
      return `rate limit: ${this.perWindow}/hour used, resets in ${Math.ceil(
        state.windowResetMs / 60000,
      )} min`;
    }
    this.timestamps.push(now);
    this.lastCall = now;
    return null;
  }

  /** Returns a consumed slot, e.g. when the request was cancelled before firing. */
  refund(): void {
    this.timestamps.pop();
    this.lastCall = 0;
  }
}
