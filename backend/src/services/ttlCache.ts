/**
 * A minimal in-process TTL cache, with no external dependency (no Redis,
 * no cache library) — appropriate for a single-instance API. Used by the
 * leaderboard endpoint (#16), whose aggregation scans every donation row
 * and gets more expensive as donation volume grows, but whose result
 * tolerates being a few seconds stale.
 *
 * Not shared across processes: if this API ever runs with more than one
 * instance behind a load balancer, each instance caches independently
 * (harmless here since it only shortens the window in which two
 * instances might disagree, no worse than a single instance racing two
 * requests).
 */
export class TtlCache<T> {
  private readonly store = new Map<string, { value: T; expiresAt: number }>();

  constructor(private readonly ttlMs: number) {}

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  /** Returns the cached value, or computes, caches, and returns a fresh one. */
  async getOrSet(key: string, compute: () => Promise<T>): Promise<T> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;

    const value = await compute();
    this.set(key, value);
    return value;
  }

  clear(): void {
    this.store.clear();
  }
}
