import { getHubSpotMaxRps } from "../config.js";

// Opt-in per-request tracing. Logs go to stderr so they never contaminate the
// JSON/stdout that scripts emit, and are off by default to preserve behavior.
const THROTTLE_LOG =
  process.env.HUBSPOT_THROTTLE_LOG === "1" ||
  process.env.HUBSPOT_THROTTLE_LOG === "true";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Per-call-site instrumentation (off by default).
//
// Every HubSpot request funnels through `scheduleHubSpotRequest`, so tagging
// that one chokepoint with a call-site `label` and counting by label gives an
// exact attribution of where a deal's API volume comes from — the breakdown
// used to find (and prove the fix for) the N+1 fan-out. Counting is opt-in
// (HUBSPOT_CALL_COUNT=1, HUBSPOT_THROTTLE_LOG=1, or `setHubSpotCallCounting`)
// and adds only a Map increment, so the default sync path is unchanged.
// ---------------------------------------------------------------------------
let callCountingEnabled =
  process.env.HUBSPOT_CALL_COUNT === "1" ||
  process.env.HUBSPOT_CALL_COUNT === "true" ||
  THROTTLE_LOG;
const callCounts = new Map<string, number>();

export function setHubSpotCallCounting(enabled: boolean): void {
  callCountingEnabled = enabled;
}

export function resetHubSpotCallCounts(): void {
  callCounts.clear();
}

/** Per-call-site tally since the last reset, sorted high→low for reporting. */
export function getHubSpotCallCounts(): Record<string, number> {
  return Object.fromEntries(
    [...callCounts.entries()].sort((a, b) => b[1] - a[1]),
  );
}

/** Total scheduled requests recorded across all call sites. */
export function getHubSpotCallTotal(): number {
  let total = 0;
  for (const count of callCounts.values()) {
    total += count;
  }
  return total;
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
 *
 * `label` is an optional, stable call-site tag used purely for profiling
 * attribution (see {@link getHubSpotCallCounts}); it has no effect on
 * scheduling.
 */
export function scheduleHubSpotRequest<T>(
  fn: () => Promise<T>,
  label = "unlabeled",
): Promise<T> {
  if (callCountingEnabled) {
    callCounts.set(label, (callCounts.get(label) ?? 0) + 1);
  }
  return getHubSpotRateLimiter().schedule(fn);
}
