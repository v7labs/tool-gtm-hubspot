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
  extractLatestEmailContent,
  oneLineSummary,
  sortActivitiesChronological,
} from "../timeline.js";
import { formatDatePrefix, wikilink } from "../writer.js";
import { accountHubWikilink } from "./paths.js";

const BRIEF_TITLE = "Brief";
const DEAL_TITLE = "Deal";
const LEARNINGS_TITLE = "Learnings";
const CAPITAL_DYNAMICS_COMPANY_ID = "29053398081";

function dealTags(manifest: DealManifest, extra: string[]): string {
  const tags = ["gtm", "hubspot", ...extra];
  if (manifest.primary_company_id === CAPITAL_DYNAMICS_COMPANY_ID) {
    tags.push("gtm/capital-dynamics");
  }
  return tags.join(", ");
}

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
 * company-nucleus hub. Deal-scoped entity/contact notes carry this so Obsidian
 * clusters everything that belongs to a company around its Account note.
 *
 * The primary company is the nucleus, and its Account note is the one the
 * account rollup guarantees on disk, so associated (non-primary) companies on
 * the deal also pin to the primary hub rather than to a never-synced account
 * (which would dangle). Returns null only when the deal has no primary company.
 */
function accountHubLink(manifest: DealManifest): string | null {
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
  return accountHubWikilink(primaryId, getCompanyName(primaryCompany));
}

export function renderBriefV2(
  manifest: DealManifest,
  timeline: DealTimelineEntry[],
  titleByPath: Map<string, string>,
): string {
  const primaryCompany =
    manifest.companies.find((company) => company.isPrimary) ?? manifest.companies[0];
  const companyLink = primaryCompany
    ? wikilink(entityCompanyTitle(primaryCompany))
    : "—";
  const contactLinks =
    manifest.contacts.map((contact) => wikilink(entityContactTitle(contact))).join(", ") ||
    "—";

  const substantiveTimeline = timeline.filter((entry) => {
    if (entry.kind === "thread") {
      return true;
    }
    return entry.activity.type !== "emails" || !isCalendarSubject(entry.activity.subject);
  });

  const story = buildThirtySecondStory(substantiveTimeline, primaryCompany ? getCompanyName(primaryCompany) : manifest.deal_name);

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
            return `- ${wikilink(title)} — ${entry.summary}`;
          })
          .join("\n")
      : "_No email threads on this deal._";

  const associationBlock = renderAssociationBlockPlain(manifest);

  const primaryCompanyId = manifest.primary_company_id ?? "";

  return `---
type: deal_brief
source: hubspot
hubspot_id: "brief-${manifest.deal_id}"
deal_hubspot_id: "${manifest.deal_id}"
motion: ${manifest.motion}
primary_company_id: "${primaryCompanyId}"
pipeline_label: "${yamlQuote(manifest.pipeline?.label ?? "")}"
stage_label: "${yamlQuote(manifest.stage?.label ?? "")}"
deal_note: "[[${DEAL_TITLE}]]"
hermes_learnings: "[[${LEARNINGS_TITLE}]]"
synced_at: ${manifest.synced_at}
tags: [${dealTags(manifest, ["deal-brief"])}]
---

# ${manifest.deal_name} — Deal Brief

${hubspotSourceBanner()}

> **CRM facts.** Hermes: [[${LEARNINGS_TITLE}]] · Index: [[${DEAL_TITLE}]]

## At a glance

| | |
|---|---|
| **Company** | ${companyLink} |
| **Contacts** | ${contactLinks} |
| **Stage** | ${manifest.stage?.label ?? "—"} |
| **Pipeline** | ${manifest.pipeline?.label ?? "—"} |
| **Motion** | ${manifest.motion} |
| **Amount** | ${manifest.properties.amount || "—"} |
| **Close date** | ${manifest.properties.closedate || "—"} |
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
): string {
  const primaryCompany =
    manifest.companies.find((company) => company.isPrimary) ?? manifest.companies[0];
  const companyLink = primaryCompany ? wikilink(entityCompanyTitle(primaryCompany)) : "—";

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

  return `---
type: deal
source: hubspot
hubspot_id: "${manifest.deal_id}"
hubspot_url: "${manifest.hubspot_url}"
motion: ${manifest.motion}
primary_company_id: "${primaryCompanyId}"
deal_brief: "[[${BRIEF_TITLE}]]"
hermes_learnings: "[[${LEARNINGS_TITLE}]]"
synced_at: ${manifest.synced_at}
stage_label: "${yamlQuote(manifest.stage?.label ?? "")}"
pipeline_label: "${yamlQuote(manifest.pipeline?.label ?? "")}"
tags: [${dealTags(manifest, ["deal"])}]
---

# ${manifest.deal_name}

${hubspotSourceBanner()}

> [[${BRIEF_TITLE}]] · [[${LEARNINGS_TITLE}]]

## Outcome snapshot

| Field | Value |
|-------|-------|
| Stage | ${manifest.stage?.label ?? manifest.stage?.id ?? ""} |
| Pipeline | ${manifest.pipeline?.label ?? ""} |
| Motion | ${manifest.motion} |
| Amount | ${manifest.properties.amount ?? ""} |
| Close date | ${manifest.properties.closedate ?? ""} |
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

function escapeYamlAlias(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
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

export function renderCompanyEntityV2(
  company: AssociatedRecord,
  manifest: DealManifest,
): string {
  const name = getCompanyName(company);
  const role = company.isPrimary
    ? "Primary company"
    : company.associationLabels.join(", ") || "Associated company";

  const hubLink = accountHubLink(manifest);
  const accountBlock = hubLink
    ? `## Account

- ${hubLink}

`
    : "";

  return `---
type: company
source: hubspot
hubspot_id: "${company.id}"
aliases: ["${escapeYamlAlias(name)}"]
association_labels: [${company.associationLabels.map((label) => `"${label}"`).join(", ")}]
is_primary: ${company.isPrimary ? "true" : "false"}
deal_hubspot_id: "${manifest.deal_id}"
synced_at: ${manifest.synced_at}
tags: [${dealTags(manifest, ["company"])}]
---

# ${name}

${hubspotSourceBanner()}

| Field | Value |
|-------|-------|
| Domain | ${company.properties.domain ?? ""} |
| Industry | ${company.properties.industry ?? ""} |
| Association | ${role} |

${accountBlock}## Deal

- [[${BRIEF_TITLE}]] · [[${DEAL_TITLE}]]
`;
}

export function renderContactEntityV2(
  contact: AssociatedRecord,
  manifest: DealManifest,
  relatedTitles: string[],
): string {
  const name = getContactName(contact);

  const hubLink = accountHubLink(manifest);
  const companyBlock = hubLink
    ? `## Company

- ${hubLink}

`
    : "";

  return `---
type: contact
source: hubspot
hubspot_id: "${contact.id}"
aliases: ["${escapeYamlAlias(name)}"]
association_labels: [${contact.associationLabels.map((label) => `"${label}"`).join(", ")}]
deal_hubspot_id: "${manifest.deal_id}"
synced_at: ${manifest.synced_at}
tags: [${dealTags(manifest, ["contact"])}]
---

# ${name}

${hubspotSourceBanner()}

| Field | Value |
|-------|-------|
| Email | ${contact.properties.email ?? ""} |
| Title | ${contact.properties.jobtitle ?? ""} |
| Deal role | ${contact.associationLabels.join(", ") || "Deal contact"} |

${companyBlock}## Deal

- [[${BRIEF_TITLE}]] · [[${DEAL_TITLE}]]

## Associated activities (HubSpot)

${relatedTitles.length > 0 ? relatedTitles.map((title, index) => `${index + 1}. ${wikilink(title)}`).join("\n") : "_No associated activities._"}
`;
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

  return `---
type: activity
source: hubspot
activity_type: ${activityTypeLabel(activity.type)}
engagement_class: ${activity.engagementClass}
hubspot_id: "${activity.id}"
deal_hubspot_id: "${manifest.deal_id}"
deal_brief: "[[${BRIEF_TITLE}]]"
sequence: ${sequence}${alsoIds}
associated_contact_ids: [${activity.associatedContactIds.map((id) => `"${id}"`).join(", ")}]
occurred_at: ${activity.timestamp ?? ""}
synced_at: ${manifest.synced_at}
tags: [${dealTags(manifest, ["activity", "deal"])}]
---

# ${title}

${hubspotSourceBanner()}

> [[${BRIEF_TITLE}]]

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

  return `---
type: email_thread
source: hubspot
thread_key: "${thread.threadKey.replace(/"/g, "")}"
deal_hubspot_id: "${manifest.deal_id}"
deal_brief: "[[${BRIEF_TITLE}]]"
sequence: ${sequence}
message_count: ${thread.messages.length}
hubspot_message_ids: [${messageIds.map((id) => `"${id}"`).join(", ")}]
synced_at: ${manifest.synced_at}
tags: [${dealTags(manifest, ["email-thread", "deal"])}]
---

# ${thread.displaySubject}

${hubspotSourceBanner()}

> [[${BRIEF_TITLE}]]

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
