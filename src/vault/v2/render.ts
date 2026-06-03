import type { DealManifest } from "../../hubspot/manifest.js";
import type { ClassifiedActivity } from "../../hubspot/engagements.js";
import { activityTypeLabel, substantiveActivities } from "../../hubspot/engagements.js";
import { getCompanyName, getContactName } from "../../hubspot/deals.js";
import type { AssociatedRecord } from "../../hubspot/types.js";
import {
  summarizeThread,
  renderThreadConversation,
  type DealTimelineEntry,
} from "../threads.js";
import { buildThirtySecondStory } from "../brief.js";
import { hubspotSourceBanner } from "../learnings.js";
import {
  composeBriefCallout,
  dealBriefGist,
  summaryFrontmatterValue,
} from "../summary.js";
import {
  extractLatestEmailContent,
  oneLineSummary,
  sortActivitiesChronological,
} from "../timeline.js";
import { formatDatePrefix } from "../writer.js";
import {
  accountHubWikilink,
  briefNoteAlias,
  briefNoteRef,
  contactHubWikilink,
  dealFolderPathV2,
} from "./paths.js";
import { dateOnly, deriveDealTags, mergeTags } from "./tags.js";

const BRIEF_TITLE = "Brief";
const DEAL_TITLE = "Deal";
const LEARNINGS_TITLE = "Learnings";
const CAPITAL_DYNAMICS_COMPANY_ID = "29053398081";

function yamlQuote(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function briefNoteTitle(): string {
  return BRIEF_TITLE;
}

export function dealNoteTitle(): string {
  return DEAL_TITLE;
}

export function learningsNoteTitle(): string {
  return LEARNINGS_TITLE;
}

export function entityCompanyTitle(company: AssociatedRecord): string {
  return getCompanyName(company);
}

export function entityContactTitle(contact: AssociatedRecord): string {
  return getContactName(contact);
}

/**
 * Path-qualified wikilink to the deal's primary-company Account note — the
 * company-nucleus hub. Associated (non-primary) companies on the deal pin to the
 * primary hub rather than to a never-synced account (which would dangle). Returns
 * null only when the deal has no primary company.
 */
function accountHubLink(manifest: DealManifest, accountNoteBasename?: string): string | null {
  const primaryId = manifest.primary_company_id;
  if (!primaryId) {
    return null;
  }
  const primaryCompany =
    manifest.companies.find((company) => company.isPrimary) ??
    manifest.companies.find((company) => company.id === primaryId) ??
    manifest.companies[0];
  if (!primaryCompany) {
    return null;
  }
  return accountHubWikilink(primaryId, getCompanyName(primaryCompany), accountNoteBasename);
}

function contactHubLinks(manifest: DealManifest): string {
  return (
    manifest.contacts
      .map((contact) => contactHubWikilink(contact.id, getContactName(contact)))
      .join(", ") || "—"
  );
}

/** Path-qualified self-link to this deal's own `Deal.md` index (graph-excluded). */
function dealIndexLink(manifest: DealManifest): string {
  const folder = dealFolderPathV2(manifest.deal_id, manifest.deal_name);
  return `[[${folder}/${DEAL_TITLE}|${DEAL_TITLE}]]`;
}

function pilotTag(manifest: DealManifest): string[] {
  return manifest.primary_company_id === CAPITAL_DYNAMICS_COMPANY_ID
    ? ["gtm/capital-dynamics"]
    : [];
}

/**
 * Zero-API-cost enrichment frontmatter promoted from `manifest.properties` /
 * `manifest.owner` (already fetched). Emitted as proper YAML scalars so Bases
 * can sum/filter: `amount` numeric & unquoted, `close_date` date-only.
 */
function enrichmentFrontmatterLines(manifest: DealManifest): string[] {
  const lines: string[] = [];
  const amount = manifest.properties.amount?.trim();
  if (amount) {
    lines.push(`amount: ${amount}`);
  }
  const closeDate = dateOnly(manifest.properties.closedate);
  if (closeDate) {
    lines.push(`close_date: ${closeDate}`);
  }
  const dealType = manifest.properties.dealtype?.trim();
  if (dealType) {
    lines.push(`deal_type: "${yamlQuote(dealType)}"`);
  }
  if (manifest.owner.name) {
    lines.push(`deal_owner: "${yamlQuote(manifest.owner.name)}"`);
  }
  if (manifest.owner.id) {
    lines.push(`deal_owner_id: "${manifest.owner.id}"`);
  }
  const source = manifest.properties.hs_analytics_source?.trim();
  if (source) {
    lines.push(`hs_analytics_source: "${yamlQuote(source)}"`);
    lines.push(`lead_source: "${yamlQuote(source)}"`);
  }
  return lines;
}

export function renderBriefV2(
  manifest: DealManifest,
  timeline: DealTimelineEntry[],
  titleByPath: Map<string, string>,
  preservedBrief?: string | null,
  accountNoteBasename?: string,
): string {
  const primaryCompany =
    manifest.companies.find((company) => company.isPrimary) ?? manifest.companies[0];
  const companyLink = accountHubLink(manifest, accountNoteBasename) ?? "—";
  const contactLinks = contactHubLinks(manifest);

  const substantiveTimeline = timeline.filter((entry) => {
    if (entry.kind === "thread") {
      return true;
    }
    return entry.activity.type !== "emails" || !isCalendarSubject(entry.activity.subject);
  });

  const story = buildThirtySecondStory(
    substantiveTimeline,
    primaryCompany ? getCompanyName(primaryCompany) : manifest.deal_name,
  );

  const briefGist = dealBriefGist(manifest, substantiveTimeline.length);
  const briefCallout = composeBriefCallout(briefGist, preservedBrief ?? null);

  const flowBullets = substantiveTimeline
    .slice(0, 6)
    .map((entry, index) => {
      const date = formatDatePrefix(entry.timestamp);
      const title = titleByPath.get(entry.path) ?? entry.title;
      return `${index + 1}. **${date}** — ${title} — ${entry.summary}`;
    })
    .join("\n");

  const threadEntries = substantiveTimeline.filter((entry) => entry.kind === "thread");
  const threadBlock =
    threadEntries.length > 0
      ? threadEntries
          .map((entry) => {
            const title = titleByPath.get(entry.path) ?? entry.title;
            return `- ${wikilinkPlain(title)} — ${entry.summary}`;
          })
          .join("\n")
      : "_No email threads on this deal._";

  const associationBlock = renderAssociationBlockPlain(manifest);
  const primaryCompanyId = manifest.primary_company_id ?? "";

  const tags = mergeTags(
    ["gtm", "hubspot", "deal-brief"],
    pilotTag(manifest),
    deriveDealTags(
      manifest.motion,
      manifest.pipeline?.label ?? "",
      manifest.stage?.label ?? "",
    ),
  );

  const frontmatter = [
    "type: deal_brief",
    `aliases: ["${briefNoteAlias()}"]`,
    "source: hubspot",
    `hubspot_id: "brief-${manifest.deal_id}"`,
    `deal_hubspot_id: "${manifest.deal_id}"`,
    `motion: ${manifest.motion}`,
    `primary_company_id: "${primaryCompanyId}"`,
    `pipeline_label: "${yamlQuote(manifest.pipeline?.label ?? "")}"`,
    `stage_label: "${yamlQuote(manifest.stage?.label ?? "")}"`,
    ...enrichmentFrontmatterLines(manifest),
    `summary: "${summaryFrontmatterValue(briefGist)}"`,
    `deal_note: "${dealIndexLink(manifest)}"`,
    `hermes_learnings: "[[${LEARNINGS_TITLE}]]"`,
    `synced_at: ${manifest.synced_at}`,
    `tags: [${tags.join(", ")}]`,
  ].join("\n");

  return `---
${frontmatter}
---

# ${manifest.deal_name} — Deal Brief

${hubspotSourceBanner()}

${briefCallout}

> **CRM facts.** Hermes: [[${LEARNINGS_TITLE}]] · Index: ${dealIndexLink(manifest)}

## At a glance

| | |
|---|---|
| **Company** | ${companyLink} |
| **Contacts** | ${contactLinks} |
| **Stage** | ${manifest.stage?.label ?? "—"} |
| **Pipeline** | ${manifest.pipeline?.label ?? "—"} |
| **Motion** | ${manifest.motion} |
| **Amount** | ${manifest.properties.amount || "—"} |
| **Close date** | ${dateOnly(manifest.properties.closedate) || "—"} |
| **Owner** | ${manifest.owner.name ?? manifest.owner.id ?? "—"} |
| **Touchpoints** | ${substantiveTimeline.length} substantive |

## What happened (30 seconds)

${story}

## Timeline (substantive)

${flowBullets || "_No substantive activities._"}

## Key email threads

${threadBlock}

## CRM associations

${associationBlock}

## HubSpot

[Open deal in HubSpot](${manifest.hubspot_url})
`;
}

export function renderDealIndexV2(
  manifest: DealManifest,
  timeline: DealTimelineEntry[],
  calendarItems: ClassifiedActivity[],
  titleByPath: Map<string, string>,
  accountNoteBasename?: string,
): string {
  const companyLink = accountHubLink(manifest, accountNoteBasename) ?? "—";

  const tableRows = timeline.map((entry) => {
    const date = formatDatePrefix(entry.timestamp);
    const label = entry.kind === "thread" ? "thread" : activityTypeLabel(entry.activity.type);
    const title = titleByPath.get(entry.path) ?? entry.title;
    return `| ${date} | ${label} | ${title.replace(/\|/g, "\\|")} | ${entry.summary.replace(/\|/g, "\\|")} |`;
  });

  const calendarRows = calendarItems.map((item) => {
    const date = formatDatePrefix(item.timestamp);
    const title = titleByPath.get(`calendar:${item.id}`) ?? item.subject ?? item.type;
    return `| ${date} | ${activityTypeLabel(item.type)} | ${title.replace(/\|/g, "\\|")} |`;
  });

  const primaryCompanyId = manifest.primary_company_id ?? "";
  const briefLink = briefSelfLink(manifest);

  // Deal.md is the technical index — kept on disk but EXCLUDED from the graph via
  // the `gtm/deal-index` tag, so each deal shows exactly ONE node (its Brief).
  const tags = mergeTags(["gtm", "hubspot", "deal", "gtm/deal-index"], pilotTag(manifest));

  const frontmatter = [
    "type: deal",
    "source: hubspot",
    `hubspot_id: "${manifest.deal_id}"`,
    `hubspot_url: "${manifest.hubspot_url}"`,
    `motion: ${manifest.motion}`,
    `primary_company_id: "${primaryCompanyId}"`,
    `pipeline_label: "${yamlQuote(manifest.pipeline?.label ?? "")}"`,
    `stage_label: "${yamlQuote(manifest.stage?.label ?? "")}"`,
    ...enrichmentFrontmatterLines(manifest),
    `deal_brief: "${briefLink}"`,
    `hermes_learnings: "[[${LEARNINGS_TITLE}]]"`,
    `synced_at: ${manifest.synced_at}`,
    `tags: [${tags.join(", ")}]`,
  ].join("\n");

  return `---
${frontmatter}
---

# ${manifest.deal_name}

${hubspotSourceBanner()}

> ${briefLink} · [[${LEARNINGS_TITLE}]]

## Outcome snapshot

| Field | Value |
|-------|-------|
| Stage | ${manifest.stage?.label ?? manifest.stage?.id ?? ""} |
| Pipeline | ${manifest.pipeline?.label ?? ""} |
| Motion | ${manifest.motion} |
| Amount | ${manifest.properties.amount ?? ""} |
| Close date | ${dateOnly(manifest.properties.closedate)} |
| Company | ${companyLink} |
| Owner | ${manifest.owner.name ?? manifest.owner.id} |

## Contacts

${manifest.contacts.map((contact) => `- ${entityContactTitle(contact)}`).join("\n") || "_none_"}

## Substantive timeline (table — no wikilinks)

| Date | Type | Note | Summary |
|------|------|------|---------|
${tableRows.join("\n") || "| — | — | — | — |"}

## Calendar / system engagements

| Date | Type | Note |
|------|------|------|
${calendarRows.join("\n") || "| — | — | — |"}

## HubSpot associations

${renderAssociationBlockPlain(manifest)}

## HubSpot

[Open in HubSpot](${manifest.hubspot_url})
`;
}

/** Path-qualified self-link from Deal.md → its own renamed Brief note. */
function briefSelfLink(manifest: DealManifest): string {
  return `[[${briefNoteRef(manifest.deal_id, manifest.deal_name)}|${BRIEF_TITLE}]]`;
}

/** Plain wikilink to a note basename (for in-deal thread links). */
function wikilinkPlain(title: string): string {
  return `[[${title.replace(/\]/g, "")}]]`;
}

function renderAssociationBlockPlain(manifest: DealManifest): string {
  const companyLines = manifest.companies.map((company) => {
    const role = company.isPrimary
      ? "**Primary**"
      : company.associationLabels.join(", ") || "Associated";
    return `- ${entityCompanyTitle(company)} — ${role}`;
  });
  const contactLines = manifest.contacts.map((contact) => {
    return `- ${entityContactTitle(contact)} — ${contact.associationLabels.join(", ") || "Deal contact"}`;
  });
  return `${companyLines.join("\n")}\n${contactLines.join("\n")}\n\n_Edges sourced from manifest.yaml._`;
}

export function renderActivityV2(
  activity: ClassifiedActivity,
  manifest: DealManifest,
  noteTitle: string,
  sequence: number,
  contactTitles: string[],
): string {
  const title = activity.subject ?? activityTypeLabel(activity.type);
  const body =
    activity.type === "emails"
      ? extractLatestEmailContent(activity.body)
      : activity.body;

  const alsoIds =
    activity.alsoHubspotIds?.length
      ? `\nalso_hubspot_ids: [${activity.alsoHubspotIds.map((id) => `"${id}"`).join(", ")}]`
      : "";

  // NOTE: no `deal_brief` wikilink and no `> [[Brief]]` body backlink.
  // Engagements are RECORDS indexed by Deal.md tables + the `deal_hubspot_id`
  // frontmatter — emitting a Brief backlink per engagement is the ~7.9k-edge
  // radial hairball this sync intentionally avoids.
  return `---
type: activity
source: hubspot
activity_type: ${activityTypeLabel(activity.type)}
engagement_class: ${activity.engagementClass}
hubspot_id: "${activity.id}"
deal_hubspot_id: "${manifest.deal_id}"
sequence: ${sequence}${alsoIds}
associated_contact_ids: [${activity.associatedContactIds.map((id) => `"${id}"`).join(", ")}]
occurred_at: ${activity.timestamp ?? ""}
synced_at: ${manifest.synced_at}
tags: [${mergeTags(["gtm", "hubspot", "activity"], pilotTag(manifest)).join(", ")}]
---

# ${title}

${hubspotSourceBanner()}

## Context

| Field | Value |
|-------|-------|
| Sequence | ${sequence} |
| Type | ${activity.type} |
| Class | ${activity.engagementClass} |
| Contacts | ${contactTitles.join(", ") || "—"} |
| Owner | ${activity.ownerName ?? activity.ownerId ?? ""} |

## Body

${body ?? "_No body_"}
`;
}

export function renderThreadV2(
  entry: DealTimelineEntry & { kind: "thread" },
  manifest: DealManifest,
  noteTitle: string,
  sequence: number,
  contactTitles: string[],
): string {
  const thread = entry.thread;
  const messageIds = thread.messages.map((message) => message.activity.id);

  // No `deal_brief`/`> [[Brief]]` backlink — threads are records (Deal.md table).
  return `---
type: email_thread
source: hubspot
thread_key: "${thread.threadKey.replace(/"/g, "")}"
deal_hubspot_id: "${manifest.deal_id}"
sequence: ${sequence}
message_count: ${thread.messages.length}
hubspot_message_ids: [${messageIds.map((id) => `"${id}"`).join(", ")}]
synced_at: ${manifest.synced_at}
tags: [${mergeTags(["gtm", "hubspot", "email-thread"], pilotTag(manifest)).join(", ")}]
---

# ${thread.displaySubject}

${hubspotSourceBanner()}

## Thread summary

${summarizeThread(thread)}

| Field | Value |
|-------|-------|
| Messages | ${thread.messages.length} |
| Contacts | ${contactTitles.join(", ") || "—"} |

## Conversation (oldest → newest)

${renderThreadConversation(thread.messages)}
`;
}

function isCalendarSubject(subject: string | null): boolean {
  if (!subject) {
    return false;
  }
  return /^(Accepted:|Declined:|Tentatively Accepted:)/i.test(subject) ||
    /^Our meeting in \d+ minutes/i.test(subject);
}

export function buildSubstantiveTimelineActivities(
  manifest: DealManifest,
): ClassifiedActivity[] {
  return substantiveActivities(manifest.activities).filter(
    (item) => item.engagementClass !== "duplicate",
  );
}

export { sortActivitiesChronological };
