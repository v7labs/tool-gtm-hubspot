/**
 * Offline validation for the HubSpot throttle + within-run manifest cache.
 *
 * Touches NO HubSpot APIs — it drives the RateLimiter and ManifestRunCache
 * directly so it can run safely while a live discovery/sweep competes for the
 * real rate budget. Exits non-zero on any failed assertion.
 *
 *   npx tsx scripts/throttle-cache-check.ts
 */
import assert from "node:assert/strict";
import type { DealManifest } from "../src/hubspot/manifest.js";
import { RateLimiter } from "../src/hubspot/rate-limiter.js";
import {
  ManifestRunCache,
  runWithManifestCache,
} from "../src/hubspot/manifest-cache.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function checkRateLimiterSpacing(): Promise<void> {
  const rps = 8;
  const limiter = new RateLimiter(rps);
  const intervalMs = 1000 / rps; // 125ms
  const count = 8;

  const starts: number[] = [];
  const t0 = Date.now();
  await Promise.all(
    Array.from({ length: count }, () =>
      limiter.schedule(async () => {
        starts.push(Date.now() - t0);
      }),
    ),
  );

  starts.sort((a, b) => a - b);
  const gaps = starts.slice(1).map((t, i) => t - starts[i]);
  const minGap = Math.min(...gaps);
  const span = starts[starts.length - 1] - starts[0];

  console.log("[limiter] target rps         :", rps, `(interval ${intervalMs}ms)`);
  console.log("[limiter] request start offs :", starts.map((t) => `${t}ms`).join(", "));
  console.log("[limiter] min gap between reqs:", `${minGap}ms`);
  console.log("[limiter] span first→last    :", `${span}ms`);
  console.log("[limiter] metrics            :", limiter.metrics());

  // Spacing is enforced: successive starts are paced by ~interval (allow timer
  // jitter on the low side), and 8 requests cannot all fire in a burst.
  assert.ok(
    minGap >= intervalMs * 0.8,
    `expected >=${intervalMs * 0.8}ms between requests, saw ${minGap}ms`,
  );
  assert.ok(
    span >= intervalMs * (count - 1) * 0.8,
    `expected the 8-request burst to be spread over >=${(intervalMs * (count - 1) * 0.8).toFixed(0)}ms, saw ${span}ms`,
  );
  assert.equal(limiter.metrics().completed, count);
  console.log("[limiter] PASS — concurrent burst was serialized/spaced\n");
}

async function checkIdleNoLatency(): Promise<void> {
  const limiter = new RateLimiter(8);
  const t0 = Date.now();
  await limiter.schedule(async () => {});
  const elapsed = Date.now() - t0;
  console.log("[limiter] idle single-call latency:", `${elapsed}ms`);
  assert.ok(elapsed < 20, `idle call should add ~0 latency, saw ${elapsed}ms`);
  console.log("[limiter] PASS — no added latency when idle\n");
}

function fakeManifest(dealId: string): DealManifest {
  return { deal_id: dealId, synced_at: new Date().toISOString() } as DealManifest;
}

async function checkManifestCacheDedup(): Promise<void> {
  const N = 17; // company size from the reported worst case
  const dealIds = Array.from({ length: N }, (_, i) => `deal-${i}`);

  // Today's pattern: every deal sync builds its own seed manifest AND its
  // rollup rebuilds each sibling (the seed is reused via seedManifest).
  let buildsToday = 0;
  const buildToday = async (id: string) => {
    buildsToday += 1;
    await sleep(0);
    return fakeManifest(id);
  };
  for (const deal of dealIds) {
    await buildToday(deal); // seed (syncDealMap)
    for (const sibling of dealIds) {
      if (sibling !== deal) {
        await buildToday(sibling); // rollup sibling
      }
    }
  }

  // With the run cache shared across concurrent workers.
  let buildsCached = 0;
  const buildCached = async (id: string) => {
    buildsCached += 1;
    await sleep(0);
    return fakeManifest(id);
  };
  const summary = await runWithManifestCache(async (cache: ManifestRunCache) => {
    await Promise.all(
      dealIds.map(async (deal) => {
        await cache.getOrBuildManifest(deal, () => buildCached(deal)); // seed
        for (const sibling of dealIds) {
          if (sibling !== deal) {
            await cache.getOrBuildManifest(sibling, () => buildCached(sibling));
          }
        }
      }),
    );
    return cache.summary();
  });

  console.log("[cache] company size         :", N, "deals");
  console.log("[cache] manifest builds TODAY :", buildsToday, `(≈ N² = ${N * N})`);
  console.log("[cache] manifest builds CACHED:", buildsCached, "(≈ N)");
  console.log("[cache] cache summary        :", summary);

  assert.equal(buildsToday, N * N, "today's pattern should be O(deals²)");
  assert.equal(buildsCached, N, "cached run should build each manifest exactly once");
  assert.equal(summary.manifestBuilds, N);
  assert.equal(summary.manifestHits, N * N - N);
  console.log("[cache] PASS — each manifest built at most once per run\n");
}

async function checkConcurrentCoalescing(): Promise<void> {
  // Concurrent callers racing for the same deal must coalesce onto one build.
  const cache = new ManifestRunCache();
  let builds = 0;
  const slowBuild = async () => {
    builds += 1;
    await sleep(20);
    return fakeManifest("deal-X");
  };
  const results = await Promise.all(
    Array.from({ length: 25 }, () =>
      cache.getOrBuildManifest("deal-X", slowBuild),
    ),
  );
  console.log("[cache] 25 concurrent requests for one deal → builds:", builds);
  assert.equal(builds, 1, "concurrent requests for one deal should build once");
  assert.ok(results.every((r) => r === results[0]), "all callers share one manifest");
  console.log("[cache] PASS — concurrent requests coalesce\n");
}

async function checkNoCacheOutsideRun(): Promise<void> {
  // Outside a run scope there is no ambient cache, so independent operations
  // never reuse a stale manifest (important for the long-lived MCP server).
  const { getManifestRunCache } = await import("../src/hubspot/manifest-cache.js");
  assert.equal(getManifestRunCache(), undefined, "no ambient cache outside a run");
  console.log("[cache] PASS — no ambient cache leaks outside runWithManifestCache\n");
}

async function main(): Promise<void> {
  await checkRateLimiterSpacing();
  await checkIdleNoLatency();
  await checkManifestCacheDedup();
  await checkConcurrentCoalescing();
  await checkNoCacheOutsideRun();
  console.log("ALL CHECKS PASSED");
}

main().catch((error) => {
  console.error("CHECK FAILED:", error);
  process.exit(1);
});
