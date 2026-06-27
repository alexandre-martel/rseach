/**
 * Simple per-domain rate limiter.
 *
 * Ensures that at most one request is made per `intervalMs` milliseconds for
 * a given domain key. Callers `await limiter.acquire(domain)` before issuing
 * their HTTP request; the promise resolves once the minimum interval has
 * elapsed since the last request to that domain.
 */
export class RateLimiter {
  /** domain -> timestamp of the last request */
  private readonly lastRequestTime = new Map<string, number>();

  /**
   * @param defaultIntervalMs Default minimum interval between requests (ms).
   * @param domainIntervals   Optional per-domain overrides (domain -> ms).
   */
  constructor(
    private readonly defaultIntervalMs: number = 3_000,
    private readonly domainIntervals: Map<string, number> = new Map(),
  ) {}

  /**
   * Wait until the rate limit window for `domain` has passed, then record
   * the current timestamp so subsequent calls will be throttled.
   *
   * @param domain  A key identifying the target (e.g. "arxiv", "semanticscholar").
   * @param signal  Optional AbortSignal to cancel the wait.
   */
  async acquire(domain: string, signal?: AbortSignal): Promise<void> {
    const interval = this.domainIntervals.get(domain) ?? this.defaultIntervalMs;
    const last = this.lastRequestTime.get(domain) ?? 0;
    const elapsed = Date.now() - last;

    if (elapsed < interval) {
      const waitMs = interval - elapsed;
      await this.sleep(waitMs, signal);
    }

    this.lastRequestTime.set(domain, Date.now());
  }

  /**
   * Register a custom interval for a specific domain.
   */
  setDomainInterval(domain: string, intervalMs: number): void {
    this.domainIntervals.set(domain, intervalMs);
  }

  /**
   * Reset tracking for a domain (useful in tests).
   */
  reset(domain?: string): void {
    if (domain) {
      this.lastRequestTime.delete(domain);
    } else {
      this.lastRequestTime.clear();
    }
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new DOMException('Aborted', 'AbortError'));
        },
        { once: true },
      );
    });
  }
}
