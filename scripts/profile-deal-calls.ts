/**
 * Profile the HubSpot API call volume of a single deal sync, attributed by
 * call site. Reads-only on HubSpot (it runs the normal idempotent sync, which
 * only reads from HubSpot and writes to the local vault).
 *
 *   npx tsx scripts/profile-deal-calls.ts <dealId>
 *
 * Prints a per-call-site breakdown, the grand total, and the wall-clock time —
 * the evidence used to locate (and prove the reduction of) the N+1 fan-out.
 */
import {
  getHubSpotCallCounts,
  getHubSpotCallTotal,
  resetHubSpotCallCounts,
  setHubSpotCallCounting,
} from "../src/hubspot/rate-limiter.js";
import { syncDealMap } from "../src/vault/sync.js";
import { getVaultPath } from "../src/config.js";

const dealId = process.argv[2];
if (!dealId) {
  console.error("Usage: profile-deal-calls.ts <dealId>");
  process.exit(1);
}

setHubSpotCallCounting(true);
resetHubSpotCallCounts();

const startedAt = Date.now();
const result = await syncDealMap(getVaultPath(), dealId);
const elapsedMs = Date.now() - startedAt;

const counts = getHubSpotCallCounts();
const total = getHubSpotCallTotal();

console.log(`\n=== HubSpot call breakdown for deal ${dealId} ===`);
for (const [label, count] of Object.entries(counts)) {
  console.log(`${String(count).padStart(6)}  ${label}`);
}
console.log("-----------------------------------------------");
console.log(`${String(total).padStart(6)}  TOTAL`);
console.log(`\nwall time: ${(elapsedMs / 1000).toFixed(1)}s`);
console.log(
  `output: ${result.dealFolder} (substantive=${result.substantiveCount}, ` +
    `calendar=${result.calendarCount}, threads=${result.threadCount})`,
);

process.stdout.write("", () => process.exit(0));
