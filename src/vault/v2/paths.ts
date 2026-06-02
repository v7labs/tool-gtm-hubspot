import { sanitizeFilename } from "../writer.js";

export function dealFolderPathV2(dealId: string, dealName: string): string {
  const slug = sanitizeFilename(dealName).slice(0, 60);
  return `GTM/Deals/${dealId} ${slug}`;
}

/**
 * Vault-root-relative folder for a company's Account note. Single source of
 * truth for the `{companyId} {slug}` shape so the account writer and every
 * note that links back to the account hub derive an identical path (and the
 * wikilink always resolves).
 */
export function accountFolderPathV2(companyId: string, companyName: string): string {
  const slug = sanitizeFilename(companyName).slice(0, 60);
  return `GTM/Accounts/${companyId} ${slug}`;
}

export function accountNoteTitle(): string {
  return "Account";
}

/**
 * Path-qualified wikilink to a company's Account note (the company-nucleus hub).
 *
 * Bare `[[Account]]` is ambiguous — every account folder holds an `Account.md`,
 * and many deal-scoped company entities alias the same display name — so the
 * link is fully qualified to the vault-root path and resolves to exactly one
 * note. This is what makes Obsidian's graph cluster every deal-scoped entity
 * around its company.
 */
export function accountHubWikilink(companyId: string, companyName: string): string {
  const folder = accountFolderPathV2(companyId, companyName);
  const alias = companyName.replace(/[\[\]|]/g, "").trim() || `Company ${companyId}`;
  return `[[${folder}/${accountNoteTitle()}|${alias}]]`;
}

export function briefFileName(): string {
  return "Brief.md";
}

export function dealIndexFileName(): string {
  return "Deal.md";
}

export function manifestFileName(): string {
  return "manifest.yaml";
}

export function entityCompanyPath(companyId: string): string {
  return `entities/company-${companyId}.md`;
}

export function entityContactPath(contactId: string): string {
  return `entities/contact-${contactId}.md`;
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
