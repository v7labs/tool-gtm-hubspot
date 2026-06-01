/**
 * Bulk-sync deals into the vault.
 *
 * Flags (all optional):
 *   --pipeline <id>     Sync open deals in a pipeline (else the deal registry).
 *   --registry-only     Force the registry source even when --pipeline is set.
 *   --concurrency <n>   Deals synced in parallel (default 4, max 32).
 *   --timeout <seconds> Per-deal wall-clock cap (default 90s).
 *   --max <n>           Cap the number of deals processed.
 *
 * Recommended full-sweep invocation
 * ---------------------------------
 * After the manifest-cache + account-rollup fixes, a heavy deal costs ~34
 * HubSpot calls / ~30s (was ~1,267 / ~10min), so the old 90s default timeout is
 * now ample, but a margin keeps a pathological deal from being recorded as a
 * timeout. Run serially against the shared 8 rps budget to stay well under
 * HubSpot's per-10s burst ceiling:
 *
 *   npm run sync-all-deals -- --concurrency 1 --timeout 600
 *
 * Projected cost for the 822-deal sweep at the new rate: ~28k calls
 * (822 × ~34), comfortably within the remaining daily API budget (~978k).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  syncDealsBulk,
  DEFAULT_BULK_CONCURRENCY,
  DEFAULT_PER_DEAL_TIMEOUT_MS,
} from "../src/vault/bulk-sync.js";
import { listOpenDealIdsInPipeline } from "../src/hubspot/pipeline-deals.js";
import { getVaultPath } from "../src/config.js";

type DealRegistryEntry = {
  id: string;
  name?: string;
  pilot?: boolean;
};

type DealRegistry = {
  deals: DealRegistryEntry[];
};

function loadRegistry(vaultPath: string): DealRegistry {
  const registryPath = join(vaultPath, "GTM/deal-registry.yaml");
  const raw = readFileSync(registryPath, "utf8");
  const deals: DealRegistryEntry[] = [];

  for (const line of raw.split("\n")) {
    const match = line.match(/^\s*-\s+id:\s*"?([^"\n]+)"?\s*$/);
    if (match) {
      deals.push({ id: match[1] });
    }
  }

  if (deals.length === 0) {
    throw new Error(`No deal IDs found in ${registryPath}`);
  }

  return { deals };
}

type ParsedArgs = {
  pipelineId: string | null;
  registryOnly: boolean;
  concurrency: number;
  perDealTimeoutMs: number;
  maxResults: number | undefined;
};

function flagValue(flag: string): string | undefined {
  // Support both `--flag value` and `--flag=value`.
  const inline = process.argv.find((arg) => arg.startsWith(`${flag}=`));
  if (inline) {
    return inline.slice(flag.length + 1);
  }
  const index = process.argv.indexOf(flag);
  if (index < 0) {
    return undefined;
  }
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function parsePositiveInt(raw: string | undefined, label: string): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
    throw new Error(`${label} must be a positive integer (got "${raw}")`);
  }
  return value;
}

function parseArgs(): ParsedArgs {
  const pipelineId = flagValue("--pipeline") ?? process.env.GTM_PIPELINE_ID ?? null;
  return {
    pipelineId,
    registryOnly: process.argv.includes("--registry-only"),
    concurrency: parsePositiveInt(flagValue("--concurrency"), "--concurrency") ?? DEFAULT_BULK_CONCURRENCY,
    perDealTimeoutMs:
      (parsePositiveInt(flagValue("--timeout"), "--timeout") ?? DEFAULT_PER_DEAL_TIMEOUT_MS / 1000) * 1000,
    maxResults: parsePositiveInt(flagValue("--max"), "--max"),
  };
}

const vaultPath = getVaultPath();
const args = parseArgs();

let dealIds: string[];

if (args.pipelineId && !args.registryOnly) {
  console.error(`Fetching open deals in pipeline ${args.pipelineId}…`);
  dealIds = await listOpenDealIdsInPipeline(args.pipelineId, {
    maxResults: args.maxResults,
  });
  console.error(`Found ${dealIds.length} open deals`);
} else {
  dealIds = loadRegistry(vaultPath).deals.map((deal) => deal.id);
  if (args.maxResults !== undefined) {
    dealIds = dealIds.slice(0, args.maxResults);
  }
}

console.error(
  `Syncing ${dealIds.length} deals (concurrency=${args.concurrency}, ` +
    `timeout=${Math.round(args.perDealTimeoutMs / 1000)}s/deal)…`,
);

const summary = await syncDealsBulk(vaultPath, dealIds, {
  concurrency: args.concurrency,
  perDealTimeoutMs: args.perDealTimeoutMs,
  onProgress: ({ dealId, status, index, total, durationMs }) => {
    console.error(`[${index}/${total}] ${status.toUpperCase()} ${dealId} (${durationMs}ms)`);
  },
});

const summaryJson = JSON.stringify(
  {
    vaultPath,
    pipelineId: args.pipelineId,
    total: summary.total,
    synced: summary.ok,
    failed: summary.failed,
    timedOut: summary.timedOut,
    failures: summary.failures.slice(0, 20),
  },
  null,
  2,
);

// Exit explicitly: a deal that hit the per-deal timeout leaves its underlying
// (un-cancellable) HubSpot promise running, which would otherwise keep the
// event loop alive long after the batch is done. Flush stdout first (the write
// callback fires after the buffer drains) so the summary is never truncated.
process.stdout.write(`${summaryJson}\n`, () => {
  process.exit(summary.failed > 0 ? 1 : 0);
});
