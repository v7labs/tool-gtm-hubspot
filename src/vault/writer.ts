import { mkdir, readdir, readFile, unlink, writeFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, join } from "node:path";

export function sanitizeFilename(name: string): string {
  return name
    .replace(/[\[\]]/g, "")
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

export function formatDatePrefix(timestamp: string | null): string {
  if (!timestamp) {
    return "undated";
  }

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "undated";
  }

  return date.toISOString().slice(0, 10);
}

export function formatIsoTimestamp(date = new Date()): string {
  return date.toISOString();
}

export async function findVaultFileByHubspotId(
  vaultPath: string,
  hubspotId: string,
  scopeDir?: string,
): Promise<string | null> {
  // scopeDir restricts the search to one subtree. The v3 model is "deal-scoped
  // entity views" — the same company/contact hubspot_id legitimately appears in
  // multiple deal folders — so callers writing deal-scoped notes pass the deal
  // folder to keep dedup/move-on-rename local instead of collapsing every copy
  // (and the account rollup, whose id is the company id, into one file).
  const root = scopeDir ? join(vaultPath, scopeDir) : vaultPath;
  try {
    const matches = await collectMatches(root, hubspotId);
    return matches[0] ?? null;
  } catch (err) {
    // scopeDir may not exist yet on a first sync — treat ENOENT as no match.
    // Rethrow everything else (EACCES/EMFILE/etc) instead of masking it.
    if (err && typeof err === "object" && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

async function collectMatches(dir: string, hubspotId: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const matches: string[] = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === ".git" || entry.name === "node_modules") {
        continue;
      }
      matches.push(...(await collectMatches(fullPath, hubspotId)));
      continue;
    }

    if (!entry.name.endsWith(".md")) {
      continue;
    }

    const content = await readFile(fullPath, "utf8");
    const id = readFrontmatterValue(content, "hubspot_id");
    if (id === hubspotId) {
      matches.push(fullPath);
    }
  }

  return matches;
}

export function readFrontmatterValue(content: string, key: string): string | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    return null;
  }

  const line = match[1]
    .split("\n")
    .find((entry) => entry.startsWith(`${key}:`));
  if (!line) {
    return null;
  }

  return line
    .slice(key.length + 1)
    .trim()
    .replace(/^["']|["']$/g, "");
}

export async function upsertVaultNote(
  vaultPath: string,
  relativePath: string,
  content: string,
  hubspotId: string,
  opts?: { dedupScope?: string },
): Promise<{ path: string; created: boolean }> {
  const targetPath = join(vaultPath, relativePath);
  await mkdir(dirname(targetPath), { recursive: true });

  const existingPath = await findVaultFileByHubspotId(vaultPath, hubspotId, opts?.dedupScope);
  const created = !existingPath;

  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, content, "utf8");

  if (existingPath && existingPath !== targetPath) {
    await unlink(existingPath);
  }

  return { path: relativePath, created };
}

export async function ensureVaultNoteIfMissing(
  vaultPath: string,
  relativePath: string,
  content: string,
): Promise<{ path: string; created: boolean }> {
  const targetPath = join(vaultPath, relativePath);

  try {
    await access(targetPath, constants.F_OK);
    return { path: relativePath, created: false };
  } catch {
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, content, "utf8");
    return { path: relativePath, created: true };
  }
}

export async function deleteVaultNoteByHubspotId(
  vaultPath: string,
  hubspotId: string,
): Promise<boolean> {
  const existingPath = await findVaultFileByHubspotId(vaultPath, hubspotId);
  if (!existingPath) {
    return false;
  }

  await unlink(existingPath);
  return true;
}

export function wikilink(title: string): string {
  return `[[${title.replace(/\]/g, "")}]]`;
}

export function noteTitleFromPath(relativePath: string): string {
  return basename(relativePath, ".md");
}
