import { getHubSpotMaxRps } from "../config.js";

// Opt-in per-request tracing. Logs go to stderr so they never contaminate the
// JSON/stdout that scripts emit, and are off by default to preserve behavior.
const THROTTLE_LOG =
  process.env.HUBSPOT_THROTTLE_LOG === "1" ||
  process.env.HUBSPOT_THROTTLE_LOG === "true";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type RateLimiterMetrics = {
  /** Requests that have reserved a slot (admitted to the limiter). */
  scheduled: number;
  /** Requests whose underlying call has settled. */
  completed: number;
  /** Minimum spacing between successive request starts, in ms. */
  intervalMs: number;
  /** Mean wait imposed before a request was allowed to start. */
  avgWaitMs: number;
  /** Largest single wait imposed (depth of the backlog at its peak). */
  maxWaitMs: number;
};

/**
 * Even-spacing (leaky-bucket) limiter. Every admitted request reserves the next
 * `intervalMs` slot, so the *start* of API calls is paced to at most `rps`
 * regardless of how many callers fan out concurrently. When the limiter is idle
 * (`now` has already passed the reserved slot) the wait is zero, so single, low
 * rate operations incur no added latency — the spacing only engages once
 * requests queue up, which is exactly when HubSpot's per-10s burst limit bites.
 *
 * This is the FIRST layer of defense; the SDK's own 429/5xx retry/backoff
 * (numberOfApiCallRetries) remains the second layer for the rare burst that
 * still slips through.
 */
export class RateLimiter {
  private readonly intervalMs: number;
  private nextSlotMs = 0;
  private scheduled = 0;
  private completed = 0;
  private waitTotalMs = 0;
  private maxWaitMs = 0;

  constructor(requestsPerSecond: number) {
    const rps =
      Number.isFinite(requestsPerSecond) && requestsPerSecond > 0
        ? requestsPerSecond
        : 8;
    this.intervalMs = 1000 / rps;
  }

  /** Reserve the next evenly-spaced slot and resolve once it is due. */
  async acquire(): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, this.nextSlotMs);
    this.nextSlotMs = slot + this.intervalMs;
    const seq = (this.scheduled += 1);
    const waitMs = slot - now;
    this.waitTotalMs += Math.max(0, waitMs);
    this.maxWaitMs = Math.max(this.maxWaitMs, waitMs);

    if (THROTTLE_LOG) {
      console.error(
        `[hubspot-throttle] req #${seq} wait=${Math.round(waitMs)}ms ` +
          `interval=${this.intervalMs.toFixed(1)}ms`,
      );
    }

    if (waitMs > 0) {
      await sleep(waitMs);
    }
  }

  /** Pace the start of `fn`, then run it (its result/rejection passes through). */
  async schedule<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.completed += 1;
    }
  }

  metrics(): RateLimiterMetrics {
    return {
      scheduled: this.scheduled,
      completed: this.completed,
      intervalMs: this.intervalMs,
      avgWaitMs: this.scheduled > 0 ? this.waitTotalMs / this.scheduled : 0,
      maxWaitMs: this.maxWaitMs,
    };
  }
}

// One shared limiter per process so concurrent deal syncs are paced against a
// single global budget rather than each carving out its own quota.
let shared: RateLimiter | null = null;

export function getHubSpotRateLimiter(): RateLimiter {
  if (!shared) {
    shared = new RateLimiter(getHubSpotMaxRps());
  }
  return shared;
}

/**
 * Funnel a single HubSpot API call through the shared limiter. EVERY HubSpot
 * request (batch read, search, pipelines, associations, owners, …) should be
 * wrapped in this so the global spacing holds.
 */
export function scheduleHubSpotRequest<T>(fn: () => Promise<T>): Promise<T> {
  return getHubSpotRateLimiter().schedule(fn);
}
