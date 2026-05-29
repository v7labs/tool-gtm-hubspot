/**
 * Migrate a deal from v1 name-folder to v2 ID-prefixed folder.
 * Runs v2 sync, then removes legacy folder if a different path exists.
 *
 * Usage: tsx scripts/migrate-deal-folder.ts <dealId>
 */
import { readdir, readFile, rm } from "node:fs/promises";
import { join, basename } from "node:path";
import { syncDealMap, dealFolderPathV2 } from "../src/vault/v2/sync.js";
import { getVaultPath } from "../src/config.js";
import { buildDealManifest } from "../src/hubspot/manifest.js";

const dealId = process.argv[2];
if (!dealId) {
  console.error("Usage: migrate-deal-folder.ts <dealId>");
  process.exit(1);
}

const vaultPath = getVaultPath();

async function findLegacyFolders(): Promise<string[]> {
  const dealsRoot = join(vaultPath, "GTM/Deals");
  const entries = await readdir(dealsRoot, { withFileTypes: true });
  const legacy: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (entry.name.startsWith(`${dealId} `)) {
      continue;
    }

    const folder = join(dealsRoot, entry.name);
    const files = await readdir(folder, { recursive: true });
    for (const file of files) {
      if (typeof file !== "string" || !file.endsWith(".md")) {
        continue;
      }
      const content = await readFile(join(folder, file), "utf8");
      if (content.includes(`deal_hubspot_id: "${dealId}"`) || content.includes(`hubspot_id: "${dealId}"`)) {
        legacy.push(folder);
        break;
      }
    }
  }

  return legacy;
}

const manifest = await buildDealManifest(dealId);
const v2Folder = dealFolderPathV2(dealId, manifest.deal_name);
const result = await syncDealMap(vaultPath, dealId);

const legacyFolders = await findLegacyFolders();
const removed: string[] = [];

for (const folder of legacyFolders) {
  if (folder === join(vaultPath, v2Folder)) {
    continue;
  }
  await rm(folder, { recursive: true, force: true });
  removed.push(folder.replace(`${vaultPath}/`, ""));
}

console.log(
  JSON.stringify(
    {
      dealId,
      v2Folder,
      sync: result,
      removedLegacyFolders: removed,
    },
    null,
    2,
  ),
);
