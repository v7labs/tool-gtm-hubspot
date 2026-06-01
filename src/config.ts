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

// Global ceiling (requests/sec) for ALL HubSpot API traffic in this process.
// HubSpot enforces a per-10s burst limit (~100 req/10s on most plans); the
// daily budget is rarely the constraint. Even, slightly-conservative spacing at
// ~8 rps keeps a multi-pipeline sweep under that burst ceiling with headroom.
// Override via HUBSPOT_MAX_RPS. Clamped to a sane range so a typo can't either
// disable throttling or stall the process.
const DEFAULT_HUBSPOT_MAX_RPS = 8;
const HUBSPOT_MAX_RPS_CEILING = 50;

export function getHubSpotMaxRps(): number {
  const raw = process.env.HUBSPOT_MAX_RPS;
  if (!raw) {
    return DEFAULT_HUBSPOT_MAX_RPS;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_HUBSPOT_MAX_RPS;
  }

  return Math.min(parsed, HUBSPOT_MAX_RPS_CEILING);
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
