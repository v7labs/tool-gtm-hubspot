import type { DealTimelineEntry, EmailThreadGroup } from "./threads.js";
import { formatDatePrefix, sanitizeFilename } from "./writer.js";
import type { DealGraph } from "../hubspot/types.js";
import { getCompanyName, getContactName } from "../hubspot/deals.js";
import { activityTypeLabel, oneLineSummary } from "./timeline.js";
import { hubspotSourceBanner } from "./learnings.js";
import { summarizeThread } from "./threads.js";

export function dealFolderPath(dealName: string): string {
  return `GTM/Deals/${sanitizeFilename(dealName)}`;
}

export function buildThirtySecondStory(
  timeline: DealTimelineEntry[],
  companyName: string,
): string {
  if (timeline.length === 0) {
    return `No synced activity yet for ${companyName}.`;
  }

  const beats = timeline.map((entry) => {
    const date = formatDatePrefix(entry.timestamp);
    const label =
      entry.kind === "thread"
        ? `email thread (${entry.thread.messages.length} messages)`
        : activityTypeLabel(entry.activity.type);
    const hint = entry.summary.slice(0, 80);
    return `${date}: ${label} — ${hint}`;
  });

  const thread = timeline.find((entry) => entry.kind === "thread");
  const latest = timeline[timeline.length - 1];
  const opening = `**${companyName}** — ${beats.length} touchpoints on this deal.`;
  const arc = beats.slice(0, 4).join(" → ");
  const suffix =
    thread && thread.kind === "thread"
      ? ` Latest: ${summarizeThread(thread.thread).slice(0, 120)}.`
      : latest.kind === "activity"
        ? ` Latest: ${oneLineSummary(latest.activity).slice(0, 120)}.`
        : "";

  return `${opening}\n\n${arc}${beats.length > 4 ? " → …" : ""}.${suffix}`;
}

export function renderDealBrief(
  graph: DealGraph,
  dealName: string,
  syncedAt: string,
  timeline: DealTimelineEntry[],
  dealNoteTitle: string,
  learningsTitle: string,
): string {
  const company = graph.companies.find((item) => item.isPrimary) ?? graph.companies[0];
  const companyName = company ? getCompanyName(company) : "Unknown account";
  const companyLink = company
    ? `[[${companyName}]]${company.isPrimary ? " (Primary)" : ""}`
    : "—";
  const contacts =
    graph.contacts
      .map((c) => {
        const labels = c.associationLabels.join(", ");
        return `[[${getContactName(c)}]]${labels ? ` (${labels})` : ""}`;
      })
      .join(", ") || "—";
  const story = buildThirtySecondStory(timeline, companyName);

  const flowBullets = timeline
    .map((entry, index) => {
      const date = formatDatePrefix(entry.timestamp);
      return `${index + 1}. **${date}** — [[${entry.title}]] — ${entry.summary}`;
    })
    .join("\n");

  const threadBlock =
    timeline.filter((e) => e.kind === "thread").length > 0
      ? timeline
          .filter((e) => e.kind === "thread")
          .map((e) => `- [[${e.title}]] — ${e.summary}`)
          .join("\n")
      : "_No email threads on this deal._";

  return `---
type: deal_brief
source: hubspot
hubspot_id: "brief-${graph.deal.id}"
deal_hubspot_id: "${graph.deal.id}"
deal_note: "[[${dealNoteTitle}]]"
hermes_learnings: "[[${learningsTitle}]]"
company: "${companyLink}"
synced_at: ${syncedAt}
tags: [gtm, hubspot, deal-brief]
---

# ${dealName} — Deal Brief

${hubspotSourceBanner()}

> **Start here for CRM facts.** Hermes interpretation: [[${learningsTitle}]]. Technical index: [[${dealNoteTitle}]].

## At a glance

| | |
|---|---|
| **Company** | ${companyLink} |
| **Contacts** | ${contacts} |
| **Amount** | ${graph.deal.properties.amount ?? "—"} |
| **Close date** | ${graph.deal.properties.closedate ?? "—"} |
| **Touchpoints** | ${timeline.length} |

## What happened (30 seconds)

${story}

## Timeline

${flowBullets || "_No activities._"}

## Key email threads

${threadBlock}

## CRM associations (from HubSpot schema)

${renderBriefAssociations(graph)}

## Hermes learnings

Agent analysis (separate from CRM sync): [[${learningsTitle}]]

## HubSpot

[Open deal in HubSpot](${graph.deal.url ?? ""})
`;
}

export function latestThreadResolution(thread: EmailThreadGroup): string {
  const last = thread.messages[thread.messages.length - 1];
  if (!last) {
    return "";
  }
  const excerpt = last.excerpt.split("\n").find((line) => line.trim())?.trim() ?? "";
  const signer = last.signer ? `${last.signer}` : "Contact";
  return `${signer}: ${excerpt.slice(0, 160)}`;
}

function renderBriefAssociations(graph: DealGraph): string {
  const companies = graph.companies
    .map((company) => {
      const role = company.isPrimary
        ? "Primary company"
        : company.associationLabels.join(", ") || "Associated company";
      return `- **Company:** [[${getCompanyName(company)}]] — ${role}`;
    })
    .join("\n");

  const contacts = graph.contacts
    .map((contact) => {
      const role = contact.associationLabels.join(", ") || "Deal contact";
      return `- **Contact:** [[${getContactName(contact)}]] — ${role}`;
    })
    .join("\n");

  return `${companies}\n${contacts}\n\nActivities link to contacts via HubSpot \`activity → contact\` associations (not email text matching).`;
}
