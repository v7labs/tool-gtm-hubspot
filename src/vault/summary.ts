import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DealManifest } from "../hubspot/manifest.js";
import type { AssociatedRecord } from "../hubspot/types.js";
import { getCompanyName, getContactName } from "../hubspot/deals.js";

/**
 * Per-entity "brief" embedded inside each synced note.
 *
 * Two layers, both invisible to the Obsidian graph (they are sections of an
 * existing note, never separate files / nodes):
 *
 *  1. A deterministic `summary` frontmatter line + a `> [!summary] Brief`
 *     callout, built purely from data already on hand at sync time. This always
 *     renders, so a brief is never empty — even for a deal with zero synced
 *     activity.
 *  2. A clearly-marked Hermes/GBrain enrichment region INSIDE that callout.
 *     Hermes overwrites the narrative between the markers; the deterministic
 *     gist above the markers is regenerated on every re-sync. The region is
 *     preserved across re-sync by reading the existing note first — the same
 *     read-existing-then-preserve pattern `account.ts` uses for Bases embeds —
 *     so the deterministic layer never blocks on (or clobbers) Hermes.
 */

export const HERMES_BRIEF_START = "%%gtm:brief:hermes:start%%";
export const HERMES_BRIEF_END = "%%gtm:brief:hermes:end%%";

// Default narrative shown until Hermes/GBrain writes one. Kept as a `>`-quoted
// callout line so the placeholder sits inside the `[!summary]` block. Exported
// because it is part of the load-bearing cross-system wire contract (see the
// golden contract test) — Hermes/GBrain keys off this exact byte string.
export const DEFAULT_HERMES_INNER = "> _Narrative brief — pending Hermes/GBrain enrichment._";

const HERMES_REGION_PATTERN = new RegExp(
  `${escapeRegExp(HERMES_BRIEF_START)}\\n([\\s\\S]*?)\\n>?\\s*${escapeRegExp(
    HERMES_BRIEF_END,
  )}`,
);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function summaryFrontmatterValue(gist: string): string {
  // One-line, double-quote-safe value for the `summary:` frontmatter field.
  return gist.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\s+/g, " ").trim();
}

/**
 * Pull the preserved Hermes/GBrain narrative out of an existing note so a
 * re-sync re-emits it verbatim instead of overwriting it. Returns the raw
 * (`>`-quoted) inner block, or null when the note has no region yet or still
 * carries the default placeholder.
 */
export function extractHermesBrief(content: string): string | null {
  const match = content.match(HERMES_REGION_PATTERN);
  if (!match) {
    return null;
  }
  const inner = match[1].replace(/\s+$/, "");
  // A blank captured region (Hermes cleared it, or only whitespace remains) is
  // "no narrative", NOT an empty narrative — returning "" here would feed `"" `
  // into `preservedInner ?? DEFAULT_HERMES_INNER` and permanently strip the
  // placeholder. Only a real narrative is ever returned non-null.
  const trimmed = inner.trim();
  if (trimmed === "" || trimmed === DEFAULT_HERMES_INNER.trim()) {
    return null;
  }
  return inner;
}

export async function readPreservedHermesBrief(
  vaultPath: string,
  relativePath: string,
): Promise<string | null> {
  try {
    const content = await readFile(join(vaultPath, relativePath), "utf8");
    return extractHermesBrief(content);
  } catch {
    // Missing file on first sync — no narrative to preserve yet.
    return null;
  }
}

/**
 * Build the `> [!summary] Brief` callout: deterministic gist on top, then the
 * marked Hermes/GBrain enrichment region (preserved narrative or the default
 * placeholder). The leading comment is regenerated each sync and documents the
 * hook; it sits OUTSIDE the captured region so it is never duplicated.
 */
export function composeBriefCallout(
  gist: string,
  preservedInner: string | null,
): string {
  const inner = preservedInner ?? DEFAULT_HERMES_INNER;
  // The gist is interpolated raw into a `>`-quoted callout line. A newline or
  // control char in a CRM-derived value (company/contact/deal name, title)
  // would break the `[!summary]` block and push the Hermes markers outside it.
  // Normalize to a single line here so the invariant lives with the renderer.
  const safeGist = gist.replace(/\s+/g, " ").trim();
  return [
    "> [!summary] Brief",
    `> ${safeGist}`,
    ">",
    "> %%Hermes/GBrain enrichment hook — write the narrative brief between the markers below; it survives re-sync. The gist above is deterministic and refreshes each sync.%%",
    `> ${HERMES_BRIEF_START}`,
    inner,
    `> ${HERMES_BRIEF_END}`,
  ].join("\n");
}

function formatDateOnly(value: string | undefined | null): string | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value.slice(0, 10) || null;
  }
  return date.toISOString().slice(0, 10);
}

function formatAmount(value: string | undefined | null): string | null {
  if (value === undefined || value === null || value.trim() === "") {
    return null;
  }
  const numeric = Number(value);
  if (Number.isNaN(numeric)) {
    return `$${value.trim()}`;
  }
  return `$${numeric.toLocaleString("en-US")}`;
}

/** Deterministic gist for a deal Brief — never empty, even with no activity. */
export function dealBriefGist(
  manifest: DealManifest,
  touchpointCount: number,
): string {
  const primaryCompany =
    manifest.companies.find((company) => company.isPrimary) ?? manifest.companies[0];
  const company = primaryCompany ? getCompanyName(primaryCompany) : manifest.deal_name;
  const stage = manifest.stage?.label?.trim();
  const pipeline = manifest.pipeline?.label?.trim();
  const amount = formatAmount(manifest.properties.amount);
  const close = formatDateOnly(manifest.properties.closedate);

  const parts: string[] = [];
  const stagePiece = stage
    ? `${manifest.motion} deal at **${stage}**${pipeline ? ` (${pipeline})` : ""}`
    : `${manifest.motion} deal`;
  parts.push(`**${company}** — ${stagePiece}.`);

  const facts: string[] = [];
  facts.push(amount ? amount : "amount n/a");
  if (close) {
    facts.push(`close ${close}`);
  }
  facts.push(
    touchpointCount > 0
      ? `${touchpointCount} substantive touchpoint${touchpointCount === 1 ? "" : "s"}`
      : "no substantive activity synced yet",
  );
  parts.push(`${facts.join(" · ")}.`);

  return parts.join(" ");
}

/** Deterministic gist for a deal-scoped company entity note. */
export function companyEntityGist(
  company: AssociatedRecord,
  manifest: DealManifest,
): string {
  const name = getCompanyName(company);
  const industry = company.properties.industry?.trim();
  const domain = company.properties.domain?.trim();
  const role = company.isPrimary
    ? "Primary company"
    : company.associationLabels.join(", ") || "Associated company";
  const stage = manifest.stage?.label?.trim();
  const amount = formatAmount(manifest.properties.amount);

  const lead = `**${name}**${industry ? ` — ${industry.replace(/_/g, " ").toLowerCase()}` : ""}${
    domain ? ` (${domain})` : ""
  }.`;
  const dealPiece = `${role} on **${manifest.deal_name}**${stage ? ` (${stage}${amount ? `, ${amount}` : ""})` : ""}.`;
  return `${lead} ${dealPiece}`;
}

/** Deterministic gist for a deal-scoped contact entity note. */
export function contactEntityGist(
  contact: AssociatedRecord,
  manifest: DealManifest,
): string {
  const name = getContactName(contact);
  const title = contact.properties.jobtitle?.trim();
  const email = contact.properties.email?.trim();
  const role = contact.associationLabels.join(", ") || "Deal contact";
  const stage = manifest.stage?.label?.trim();

  const lead = `**${name}**${title ? `, ${title}` : ""}.`;
  const dealPiece = `${role} on **${manifest.deal_name}**${stage ? ` (${stage})` : ""}.`;
  return `${lead} ${dealPiece}${email ? ` ${email}.` : ""}`;
}

export type AccountSummaryInput = {
  companyName: string;
  companyDomain: string;
  deals: Array<{ motion: string; amount: string; stageLabel: string }>;
};

/** Deterministic gist for an Account.md rollup (the company nucleus). */
export function accountGist(input: AccountSummaryInput): string {
  const dealCount = input.deals.length;
  const total = input.deals.reduce((sum, deal) => {
    const numeric = Number(deal.amount);
    return Number.isNaN(numeric) ? sum : sum + numeric;
  }, 0);
  const motions = [...new Set(input.deals.map((deal) => deal.motion).filter(Boolean))];

  const lead = `**${input.companyName}**${input.companyDomain ? ` (${input.companyDomain})` : ""} — ${dealCount} deal${
    dealCount === 1 ? "" : "s"
  }.`;
  const facts: string[] = [];
  if (total > 0) {
    facts.push(`$${total.toLocaleString("en-US")} total pipeline`);
  }
  if (motions.length > 0) {
    facts.push(`motions: ${motions.join(", ")}`);
  }
  return facts.length > 0 ? `${lead} ${facts.join(" · ")}.` : lead;
}
