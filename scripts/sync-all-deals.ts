import { readFileSync } from "node:fs";
import { join } from "node:path";
import { syncDealMap } from "../src/vault/sync.js";
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

function parseArgs(): { pipelineId: string | null; registryOnly: boolean } {
  const pipelineFlagIndex = process.argv.indexOf("--pipeline");
  if (pipelineFlagIndex >= 0) {
    const pipelineId = process.argv[pipelineFlagIndex + 1];
    if (!pipelineId) {
      throw new Error("Usage: sync-all-deals.ts [--pipeline <pipelineId>] [--registry-only]");
    }
    return { pipelineId, registryOnly: false };
  }

  if (process.env.GTM_PIPELINE_ID) {
    return { pipelineId: process.env.GTM_PIPELINE_ID, registryOnly: false };
  }

  return { pipelineId: null, registryOnly: process.argv.includes("--registry-only") };
}

const vaultPath = getVaultPath();
const { pipelineId, registryOnly } = parseArgs();

let dealIds: string[];

if (pipelineId && !registryOnly) {
  console.error(`Fetching open deals in pipeline ${pipelineId}…`);
  dealIds = await listOpenDealIdsInPipeline(pipelineId);
  console.error(`Found ${dealIds.length} open deals`);
} else {
  dealIds = loadRegistry(vaultPath).deals.map((deal) => deal.id);
}

const results = [];

for (const dealId of dealIds) {
  console.error(`Syncing deal ${dealId}…`);
  results.push(await syncDealMap(vaultPath, dealId));
}

console.log(
  JSON.stringify(
    {
      vaultPath,
      pipelineId,
      synced: results.length,
      results,
    },
    null,
    2,
  ),
);
