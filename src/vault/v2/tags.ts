/**
 * Frontmatter-derived tag taxonomy. Tags are DERIVED from synced properties
 * (never hand-authored) so they survive every re-sync and keep graph
 * lenses/Bases stable. Mirrors `scripts/derive-deal-tags.mjs` slug rule exactly:
 * lowercase, any run of non-alphanumeric → single `-`, trim leading/trailing `-`.
 */
export function slugifyTag(value: string): string {
  return (value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Derive the deal-entry (`… (Brief)`) taxonomy tags from a deal's motion /
 * pipeline / stage. Empty inputs are skipped. Returns bare tags (no `#`) for the
 * frontmatter `tags:` list.
 */
export function deriveDealTags(
  motion: string,
  pipelineLabel: string,
  stageLabel: string,
): string[] {
  const tags: string[] = [];
  if (motion) {
    tags.push(`gtm/motion/${slugifyTag(motion)}`);
  }
  if (pipelineLabel) {
    tags.push(`gtm/pipeline/${slugifyTag(pipelineLabel)}`);
  }
  if (stageLabel) {
    tags.push(`gtm/stage/${slugifyTag(stageLabel)}`);
  }
  return tags;
}

/** Derive the account (`… (Account)`) cluster tags from company industry/country. */
export function deriveAccountTags(industry: string, country: string): string[] {
  const tags: string[] = [];
  if (industry) {
    tags.push(`gtm/industry/${slugifyTag(industry)}`);
  }
  if (country) {
    tags.push(`gtm/geo/${slugifyTag(country)}`);
  }
  return tags;
}

/** Merge tag lists preserving order, de-duplicating. */
export function mergeTags(...lists: string[][]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const tag of list) {
      if (tag && !seen.has(tag)) {
        seen.add(tag);
        out.push(tag);
      }
    }
  }
  return out;
}

/**
 * Format an ISO/HubSpot timestamp as a date-only `YYYY-MM-DD` string so
 * Obsidian's Bases `date()` parses it (ISO + `Z` breaks it — VAULT-v3-SPEC #3).
 * Returns "" for empty/unparseable input.
 */
export function dateOnly(value: string | null | undefined): string {
  if (!value) {
    return "";
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) {
    // Already date-only or unknown format: keep the leading YYYY-MM-DD if present.
    const match = trimmed.match(/^\d{4}-\d{2}-\d{2}/);
    return match ? match[0] : "";
  }
  return date.toISOString().slice(0, 10);
}
