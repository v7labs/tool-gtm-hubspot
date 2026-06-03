/**
 * Re-sync ONLY the deals that already have a vault folder (the materialized set).
 *
 * Unlike `sync-all-deals` (which pulls from the registry or an open-pipeline
 * query), this enumerates `GTM/Deals/{id} …` folders and re-syncs exactly those
 * deals — never the un-synced "ghost" deals that account rollups reference but
 * that were never materialized. This is the safe full re-sweep for durability /
 * enrichment: it reproduces structure for exactly what exists, nothing more.
 *
 *   npm run resync-existing-deals -- [--concurrency N] [--timeout S] [--max N] [--dry]
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
  syncDealsBulk,
  DEFAULT_BULK_CONCURRENCY,
  DEFAULT_PER_DEAL_TIMEOUT_MS,
} from "../src/vault/bulk-sync.js";
import { getVaultPath } from "../src/config.js";

function flagValue(flag: string): string | undefined {
  const inline = process.argv.find((arg) => arg.startsWith(`${flag}=`));
  if (inline) return inline.slice(flag.length + 1);
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
  return value;
}

function positiveInt(raw: string | undefined, label: string): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
    throw new Error(`${label} must be a positive integer (got "${raw}")`);
  }
  return value;
}

const vaultPath = getVaultPath();
const concurrency = positiveInt(flagValue("--concurrency"), "--concurrency") ?? DEFAULT_BULK_CONCURRENCY;
const perDealTimeoutMs =
  (positiveInt(flagValue("--timeout"), "--timeout") ?? DEFAULT_PER_DEAL_TIMEOUT_MS / 1000) * 1000;
const max = positiveInt(flagValue("--max"), "--max");
const dryRun = process.argv.includes("--dry");

const dealsDir = join(vaultPath, "GTM/Deals");
const ids: string[] = [];
for (const entry of readdirSync(dealsDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const m = entry.name.match(/^(\d+)\s/);
  if (m) ids.push(m[1]);
}
let dealIds = [...new Set(ids)].sort();
if (max !== undefined) dealIds = dealIds.slice(0, max);

console.error(`Found ${dealIds.length} materialized deal folders in ${dealsDir}`);
if (dryRun) {
  console.error(`(dry run) first 5: ${dealIds.slice(0, 5).join(", ")}`);
  process.exit(0);
}
console.error(
  `Re-syncing ${dealIds.length} existing deals (concurrency=${concurrency}, ` +
    `timeout=${Math.round(perDealTimeoutMs / 1000)}s/deal)…`,
);

let done = 0;
const summary = await syncDealsBulk(vaultPath, dealIds, {
  concurrency,
  perDealTimeoutMs,
  onProgress: ({ dealId, status, index, total, durationMs }) => {
    done = index;
    if (status !== "ok" || index % 25 === 0 || index === total) {
      console.error(`[${index}/${total}] ${status.toUpperCase()} ${dealId} (${durationMs}ms)`);
    }
  },
});

process.stdout.write(
  `${JSON.stringify(
    {
      vaultPath,
      total: summary.total,
      synced: summary.ok,
      failed: summary.failed,
      timedOut: summary.timedOut,
      failures: summary.failures.slice(0, 20),
    },
    null,
    2,
  )}\n`,
  () => process.exit(summary.failed > 0 ? 1 : 0),
);
