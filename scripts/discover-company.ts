/**
 * Recursive HubSpot discovery for a company → hubspot-inventory.yaml
 *
 * Usage: npm run discover-company -- <companyId>
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getVaultPath } from "../src/config.js";
import {
  discoverCompanyGraph,
  serializeCompanyInventoryYaml,
  getCompany,
} from "../src/hubspot/company.js";
import { getCompanyName } from "../src/hubspot/deals.js";
import { accountFolderPath } from "../src/vault/v2/account.js";
const companyId = process.argv[2];

if (!companyId) {
  console.error("Usage: discover-company.ts <companyId>");
  process.exit(1);
}

const vaultPath = getVaultPath();
const inventory = await discoverCompanyGraph(companyId, { vaultPath });
const company = await getCompany(companyId);
const folder = accountFolderPath(companyId, getCompanyName(company));
const outputRelative = `${folder}/hubspot-inventory.yaml`;
const outputAbsolute = join(vaultPath, outputRelative);

await mkdir(join(vaultPath, folder), { recursive: true });
await writeFile(outputAbsolute, serializeCompanyInventoryYaml(inventory), "utf8");

console.log(
  JSON.stringify(
    {
      companyId,
      companyName: inventory.company_name,
      dealCount: inventory.deals.length,
      contactCount: inventory.contacts.length,
      outputPath: outputRelative,
      outputPathAbsolute: outputAbsolute,
    },
    null,
    2,
  ),
);
