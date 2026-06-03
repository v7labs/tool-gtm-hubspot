import { sanitizeFilename } from "../writer.js";

/**
 * Shared slug rules. `dealSlug`/`companySlug` reuse `sanitizeFilename` (capped at
 * 60) so the folder name and the self-describing note filename inside it can
 * never drift. Mirrors `scripts/dedup-entities-to-hubs.mjs` (folder slug) and the
 * v3 rename that produced the current vault.
 */
export function dealSlug(dealName: string): string {
  return sanitizeFilename(dealName).slice(0, 60).trim();
}

export function companySlug(companyName: string): string {
  return sanitizeFilename(companyName).slice(0, 60).trim();
}

/**
 * Contact-hub filename slug. Mirrors `dedup-entities-to-hubs.mjs` `sanitizeName`
 * EXACTLY (illegal/link chars → space, collapse, trim, cap 60) so the writer and
 * every back-link resolve to the same `GTM/Contacts/{id} {slug}.md`.
 */
export function contactHubSlug(name: string): string {
  return (name || "")
    .replace(/[\\/:*?"<>|#^[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60)
    .trim();
}

export function dealFolderPathV2(dealId: string, dealName: string): string {
  return `GTM/Deals/${dealId} ${dealSlug(dealName)}`;
}

/**
 * Vault-root-relative folder for a company's Account note. Single source of
 * truth for the `{companyId} {slug}` shape so the account writer and every
 * note that links back to the account hub derive an identical path.
 */
export function accountFolderPathV2(companyId: string, companyName: string): string {
  return `GTM/Accounts/${companyId} ${companySlug(companyName)}`;
}

/** Display alias / bare-link target carried on the renamed account note. */
export function accountNoteTitle(): string {
  return "Account";
}

/** Display alias / bare-link target carried on the renamed deal entry note. */
export function briefNoteAlias(): string {
  return "Brief";
}

/**
 * Self-describing deal-entry filename: `{deal-slug} (Brief).md`. Obsidian labels
 * graph nodes by filename, so this is what makes a deal node read like
 * "Acme - Jane (Brief)" instead of a generic "Brief". The note carries
 * `aliases: ["Brief"]` so legacy bare `[[Brief]]` links (hermes) still resolve.
 */
export function briefFileName(dealName: string): string {
  return `${dealSlug(dealName)} (Brief).md`;
}

/** Vault-root-relative wikilink target (no extension) for a deal's Brief note. */
export function briefNoteRef(dealId: string, dealName: string): string {
  return `${dealFolderPathV2(dealId, dealName)}/${dealSlug(dealName)} (Brief)`;
}

/** Path-qualified, self-labeled wikilink to a deal's Brief note. */
export function briefHubWikilink(dealId: string, dealName: string): string {
  const alias = dealName.replace(/[[\]|]/g, "").trim() || `Deal ${dealId}`;
  return `[[${briefNoteRef(dealId, dealName)}|${alias}]]`;
}

/** Self-describing account filename: `{company-slug} (Account).md`. */
export function accountFileName(companyName: string): string {
  return `${companySlug(companyName)} (Account).md`;
}

/**
 * Vault-root-relative wikilink target (no extension) for a company's Account note.
 * `noteBasename` (without `.md`) is the EXISTING on-disk note name when known, so
 * links never drift from a live account note; it falls back to the computed
 * `{slug} (Account)` only for brand-new accounts with no note yet.
 */
export function accountNoteRef(
  companyId: string,
  companyName: string,
  noteBasename?: string,
): string {
  const base = noteBasename ?? `${companySlug(companyName)} (Account)`;
  return `${accountFolderPathV2(companyId, companyName)}/${base}`;
}

/**
 * Path-qualified wikilink to a company's Account note (the company-nucleus hub).
 * Resolves to exactly one node and clusters the company's deals/contacts around
 * it. Pass the existing note's basename so a re-sync never renames a live account.
 */
export function accountHubWikilink(
  companyId: string,
  companyName: string,
  noteBasename?: string,
): string {
  const alias = companyName.replace(/[[\]|]/g, "").trim() || `Company ${companyId}`;
  return `[[${accountNoteRef(companyId, companyName, noteBasename)}|${alias}]]`;
}

/** Canonical contact-hub folder (vault-level, one node per real person). */
export function contactsHubFolder(): string {
  return "GTM/Contacts";
}

export function contactHubFileName(contactId: string, name: string): string {
  return `${contactId} ${contactHubSlug(name)}.md`;
}

/** Vault-root-relative path to a canonical contact hub. */
export function contactHubPath(contactId: string, name: string): string {
  return `${contactsHubFolder()}/${contactHubFileName(contactId, name)}`;
}

/** Vault-root-relative wikilink target (no extension) for a contact hub. */
export function contactHubRef(contactId: string, name: string): string {
  return `${contactsHubFolder()}/${contactId} ${contactHubSlug(name)}`;
}

/** Path-qualified, self-labeled wikilink to a canonical contact hub. */
export function contactHubWikilink(contactId: string, name: string): string {
  const alias = name.replace(/[[\]|]/g, "").trim() || `Contact ${contactId}`;
  return `[[${contactHubRef(contactId, name)}|${alias}]]`;
}

export function dealIndexFileName(): string {
  return "Deal.md";
}

export function manifestFileName(): string {
  return "manifest.yaml";
}

export function engagementPath(
  engagementClass: "substantive" | "calendar",
  fileName: string,
): string {
  return `engagements/${engagementClass}/${fileName}.md`;
}

export function threadPath(fileName: string): string {
  return `threads/${fileName}.md`;
}

export function hermesLearningsPath(): string {
  return `hermes/Learnings.md`;
}

export function noteTitleFromEngagementPath(relativePath: string): string {
  const base = relativePath.split("/").pop() ?? relativePath;
  return base.replace(/\.md$/, "");
}
