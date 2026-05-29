import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadEnvLocal(): void {
  const envPath = join(projectRoot, ".env.local");
  if (!existsSync(envPath)) {
    return;
  }

  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separator = trimmed.indexOf("=");
    if (separator === -1) {
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

loadEnvLocal();

export function getHubSpotAccessToken(): string {
  const token =
    process.env.HUBSPOT_ACCESS_TOKEN ??
    process.env.HUBSPOT_SERVICE_KEY ??
    process.env.HUBSPOT_PERSONAL_ACCESS_TOKEN;

  if (!token) {
    throw new Error(
      "Missing HubSpot token. Set HUBSPOT_ACCESS_TOKEN or HUBSPOT_SERVICE_KEY.",
    );
  }

  return token;
}

export function getVaultPath(): string {
  const vaultPath =
    process.env.OBSIDIAN_VAULT_PATH ??
    "/Users/franciscoterpolilli/Projects/tool-gtm-vault";

  if (!existsSync(vaultPath)) {
    throw new Error(`Obsidian vault not found at ${vaultPath}`);
  }

  return vaultPath;
}
