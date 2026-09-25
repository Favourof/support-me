/**
 * A minimal in-process, fixed-window rate limiter, no external dependency
 * (no Redis, no express-rate-limit) — appropriate for a single-instance
 * API, mirroring the TtlCache decision in the leaderboard endpoint (#16).
 *
 * Used to rate-limit magic-link requests per email (#15's "Rate-limit
 * link requests per email to prevent abuse").
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly maxRequests: number,
    private readonly windowMs: number
  ) {}

  /**
   * Records a request attempt for `key` and returns whether it's allowed
   * under the limit. Old timestamps outside the current window are
   * pruned on every call, so the map never grows unbounded for a key that
   * stops being used.
   */
  attempt(key: string): boolean {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    const existing = (this.hits.get(key) ?? []).filter((t) => t > windowStart);

    if (existing.length >= this.maxRequests) {
      this.hits.set(key, existing);
      return false;
    }

    existing.push(now);
    this.hits.set(key, existing);
    return true;
  }

  clear(): void {
    this.hits.clear();
  }
}
