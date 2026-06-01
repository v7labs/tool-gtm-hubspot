import { AsyncLocalStorage } from "node:async_hooks";
import type { DealManifest } from "./manifest.js";
import type { HubSpotRecord } from "./types.js";

/**
 * Seed-independent inputs for an account rollup. These are identical no matter
 * which sibling deal triggered the rollup, so they are memoized per company for
 * the lifetime of a run.
 */
export type CompanyRollupInputs = {
  company: HubSpotRecord;
  dealIds: string[];
};

/**
 * Per-run memoization for the dominant bulk-sync costs. A single bulk sweep
 * triggers, for every deal, an account rollup that (today) rebuilds a FULL
 * manifest for every sibling deal of the company — O(deals²) manifest builds
 * within a company. This cache makes each deal's manifest (and each company's
 * rollup inputs) build AT MOST ONCE per run.
 *
 * Promises (not resolved values) are cached so concurrent callers racing for
 * the same deal/company coalesce onto one in-flight build rather than each
 * kicking off their own. A rejected build is evicted so a later retry can
 * rebuild instead of replaying the failure.
 *
 * The cache is intentionally NOT a process-global: it lives only for the
 * duration of a `runWithManifestCache` scope (see below), so the long-lived MCP
 * server never serves a manifest stale across separate sync invocations.
 */
export class ManifestRunCache {
  private readonly manifests = new Map<string, Promise<DealManifest>>();
  private readonly companyInputs = new Map<string, Promise<CompanyRollupInputs>>();

  manifestBuilds = 0;
  manifestHits = 0;
  companyBuilds = 0;
  companyHits = 0;

  getOrBuildManifest(
    dealId: string,
    build: () => Promise<DealManifest>,
  ): Promise<DealManifest> {
    const cached = this.manifests.get(dealId);
    if (cached) {
      this.manifestHits += 1;
      return cached;
    }

    this.manifestBuilds += 1;
    const pending = build();
    this.manifests.set(dealId, pending);
    pending.catch(() => this.manifests.delete(dealId));
    return pending;
  }

  getOrLoadCompanyInputs(
    companyId: string,
    load: () => Promise<CompanyRollupInputs>,
  ): Promise<CompanyRollupInputs> {
    const cached = this.companyInputs.get(companyId);
    if (cached) {
      this.companyHits += 1;
      return cached;
    }

    this.companyBuilds += 1;
    const pending = load();
    this.companyInputs.set(companyId, pending);
    pending.catch(() => this.companyInputs.delete(companyId));
    return pending;
  }

  summary(): {
    manifestBuilds: number;
    manifestHits: number;
    companyBuilds: number;
    companyHits: number;
  } {
    return {
      manifestBuilds: this.manifestBuilds,
      manifestHits: this.manifestHits,
      companyBuilds: this.companyBuilds,
      companyHits: this.companyHits,
    };
  }
}

const storage = new AsyncLocalStorage<ManifestRunCache>();

/**
 * Establish (or reuse) a run-scoped manifest cache for the duration of `fn`.
 *
 * Re-entrant: if a cache is already active in the current async context, the
 * SAME instance is reused and `fn` runs inside it. This is what lets a bulk
 * sweep share ONE cache across all of its concurrent deal-sync workers while a
 * standalone `syncDealMap` (e.g. a single MCP/CLI call) still gets a fresh,
 * self-contained cache that is discarded when it returns.
 */
export function runWithManifestCache<T>(
  fn: (cache: ManifestRunCache) => Promise<T>,
): Promise<T> {
  const existing = storage.getStore();
  if (existing) {
    return fn(existing);
  }

  const cache = new ManifestRunCache();
  return storage.run(cache, () => fn(cache));
}

/** The cache active in the current async context, if any. */
export function getManifestRunCache(): ManifestRunCache | undefined {
  return storage.getStore();
}
