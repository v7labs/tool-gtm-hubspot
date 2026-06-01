import { syncDealMap, type SyncDealMapResult } from "./sync.js";

export const DEFAULT_BULK_CONCURRENCY = 4;
export const DEFAULT_PER_DEAL_TIMEOUT_MS = 90_000;
// Upper guards: HubSpot tolerates only modest fan-out before rate-limiting, and
// setTimeout silently fires immediately for delays above the 32-bit signed max.
const MAX_BULK_CONCURRENCY = 32;
const MAX_TIMEOUT_MS = 2_147_483_647;

export type BulkSyncProgress = {
  dealId: string;
  status: "ok" | "error" | "timeout";
  index: number; // 1-based completion order
  total: number;
  durationMs: number;
};

export type BulkSyncOptions = {
  /** Max deals synced in parallel. Defaults to DEFAULT_BULK_CONCURRENCY. */
  concurrency?: number;
  /** Per-deal wall-clock cap; on breach the deal is recorded as a timeout and
   *  the worker moves on so one hang cannot stall the whole batch. */
  perDealTimeoutMs?: number;
  /** Called once per deal as it settles (for progress logging). */
  onProgress?: (progress: BulkSyncProgress) => void;
};

export type BulkSyncFailure = {
  dealId: string;
  reason: string;
  timedOut: boolean;
};

export type BulkSyncResult = {
  total: number;
  ok: number;
  failed: number;
  timedOut: number;
  results: SyncDealMapResult[];
  failures: BulkSyncFailure[];
};

export class DealSyncTimeoutError extends Error {
  constructor(
    public readonly dealId: string,
    public readonly timeoutMs: number,
  ) {
    super(`syncDealMap for ${dealId} exceeded ${timeoutMs}ms`);
    this.name = "DealSyncTimeoutError";
  }
}

/**
 * Race a promise against a timeout, clearing the timer when the work settles so
 * a pending timer never keeps the event loop alive (no dangling-timer leak).
 *
 * NOTE: a timeout rejects the race but does NOT cancel the underlying
 * `syncDealMap` — the HubSpot SDK calls are not AbortSignal-wired. The orphaned
 * work continues to completion in the background; that is safe because
 * `syncDealMap` is idempotent (upsert by hubspot_id). The timeout's job is to
 * free the worker slot, not to abort I/O.
 */
function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  dealId: string,
): Promise<T> {
  // If the timeout wins the race, `work` is left running and would surface a
  // late rejection with no listener -> unhandledRejection (can crash the
  // process). Attach a no-op catch so the orphan is always "handled". This does
  // not affect the race, which observes `work`'s settlement independently and
  // still rejects with the real error when `work` loses BEFORE timing out.
  void work.catch(() => {});

  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new DealSyncTimeoutError(dealId, timeoutMs)),
      timeoutMs,
    );
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Sync many deals into the vault with bounded concurrency and a per-deal
 * timeout. Input ids are de-duplicated (preserving first-seen order). One
 * failing or hanging deal never aborts the batch; failures are collected and
 * returned. Idempotent: re-running upserts by hubspot_id.
 */
export async function syncDealsBulk(
  vaultPath: string,
  dealIds: string[],
  options: BulkSyncOptions = {},
): Promise<BulkSyncResult> {
  const concurrency = Math.min(
    MAX_BULK_CONCURRENCY,
    Math.max(1, Math.floor(options.concurrency ?? DEFAULT_BULK_CONCURRENCY)),
  );
  const perDealTimeoutMs = Math.min(
    MAX_TIMEOUT_MS,
    Math.max(1, options.perDealTimeoutMs ?? DEFAULT_PER_DEAL_TIMEOUT_MS),
  );

  const queue = [...new Set(dealIds)];
  const total = queue.length;
  const results: SyncDealMapResult[] = [];
  const failures: BulkSyncFailure[] = [];
  let ok = 0;
  let timedOut = 0;
  let cursor = 0;
  let completed = 0;

  async function worker(): Promise<void> {
    // `cursor++` is atomic relative to other workers (single-threaded event
    // loop; the read+increment is synchronous), so each index is claimed once.
    while (cursor < queue.length) {
      const dealId = queue[cursor];
      cursor += 1;
      const startedAt = Date.now();
      try {
        const result = await withTimeout(
          syncDealMap(vaultPath, dealId),
          perDealTimeoutMs,
          dealId,
        );
        results.push(result);
        ok += 1;
        completed += 1;
        options.onProgress?.({
          dealId,
          status: "ok",
          index: completed,
          total,
          durationMs: Date.now() - startedAt,
        });
      } catch (error) {
        const isTimeout = error instanceof DealSyncTimeoutError;
        if (isTimeout) {
          timedOut += 1;
        }
        failures.push({
          dealId,
          reason: error instanceof Error ? error.message : String(error),
          timedOut: isTimeout,
        });
        completed += 1;
        options.onProgress?.({
          dealId,
          status: isTimeout ? "timeout" : "error",
          index: completed,
          total,
          durationMs: Date.now() - startedAt,
        });
      }
    }
  }

  const workerCount = Math.min(concurrency, total);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return {
    total,
    ok,
    failed: failures.length,
    timedOut,
    results,
    failures,
  };
}
