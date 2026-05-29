import { syncDealMap } from "../src/vault/sync.js";
import { getVaultPath } from "../src/config.js";

const dealId = process.argv[2];

if (!dealId) {
  console.error("Usage: sync-deal-map.ts <dealId>");
  process.exit(1);
}

const result = await syncDealMap(getVaultPath(), dealId);
console.log(JSON.stringify(result, null, 2));
