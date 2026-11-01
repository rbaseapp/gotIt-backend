/**
 * A small in-memory cache for answers from another service. Concurrent requests for the same key
 * share one call, an entry lives until its own expiry, and the oldest entries are dropped once the
 * cache is full. Failures are never cached.
 */
export class TtlCache<T> {
  private readonly entries = new Map<string, { value: T; expiresAt: number }>();
  private readonly pending = new Map<string, Promise<T>>();

  constructor(
    private readonly maxEntries: number,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * The cached value for `key`, or the result of `load`. `ttlFor` decides from the value how long
   * to keep it in milliseconds; zero or less keeps nothing.
   */
  async get(key: string, load: () => Promise<T>, ttlFor: (value: T) => number): Promise<T> {
    const cached = this.entries.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.value;
    if (cached) this.entries.delete(key);
    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;
    const request = load()
      .then((value) => {
        const ttl = ttlFor(value);
        if (ttl > 0) this.set(key, value, ttl);
        return value;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, request);
    return request;
  }

  private set(key: string, value: T, ttl: number) {
    this.entries.delete(key);
    if (this.entries.size >= this.maxEntries) {
      // Make room with entries that have already expired before dropping live ones.
      const now = this.now();
      for (const [oldKey, entry] of this.entries)
        if (entry.expiresAt <= now) this.entries.delete(oldKey);
    }
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
    this.entries.set(key, { value, expiresAt: this.now() + ttl });
  }
}
