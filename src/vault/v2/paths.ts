import { sanitizeFilename } from "../writer.js";

export function dealFolderPathV2(dealId: string, dealName: string): string {
  const slug = sanitizeFilename(dealName).slice(0, 60);
  return `GTM/Deals/${dealId} ${slug}`;
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
