import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildDealManifest,
  serializeManifestYaml,
} from "../../hubspot/manifest.js";
import {
  activityTypeLabel,
  calendarActivities,
  type ClassifiedActivity,
} from "../../hubspot/engagements.js";
import { getContactName } from "../../hubspot/deals.js";
import type { AssociatedRecord } from "../../hubspot/types.js";
import {
  buildDealTimeline,
  threadSyntheticHubspotId,
  type DealTimelineEntry,
} from "../threads.js";
import type { ActivityPathEntry } from "../timeline.js";
import {
  deleteVaultNoteByHubspotId,
  formatDatePrefix,
  noteTitleFromPath,
  sanitizeFilename,
  upsertVaultNote,
} from "../writer.js";
import {
  dealFolderPathV2,
  briefFileName,
  dealIndexFileName,
  manifestFileName,
  entityCompanyPath,
  entityContactPath,
  engagementPath,
} from "./paths.js";
import {
  renderBriefV2,
  renderDealIndexV2,
  renderCompanyEntityV2,
  renderContactEntityV2,
  renderActivityV2,
  renderThreadV2,
  buildSubstantiveTimelineActivities,
  entityCompanyTitle,
  entityContactTitle,
  briefNoteTitle,
  learningsNoteTitle,
} from "./render.js";
import { ensureHermesLearningsNoteV2 } from "../learnings-v2.js";
import { syncAccountRollup } from "./account.js";
import { runWithManifestCache } from "../../hubspot/manifest-cache.js";

export type SyncDealMapResult = {
  dealId: string;
  vaultPath: string;
  accountPath: string | null;
  dealFolder: string;
  manifestPath: string;
  manifestPathAbsolute: string;
  briefPath: string;
  briefPathAbsolute: string;
  dealPath: string;
  dealPathAbsolute: string;
  companyPaths: string[];
  companyPathsAbsolute: string[];
  contactPaths: string[];
  contactPathsAbsolute: string[];
  activityPaths: string[];
  activityPathsAbsolute: string[];
  calendarPaths: string[];
  threadPaths: string[];
  threadPathsAbsolute: string[];
  learningsPath: string;
  learningsPathAbsolute: string;
  learningsCreated: boolean;
  substantiveCount: number;
  calendarCount: number;
  threadCount: number;
  staleRemoved: number;
};

function absolutePaths(vaultPath: string, relativePaths: string[]): string[] {
  return relativePaths.map((relativePath) => join(vaultPath, relativePath));
}

export function syncDealMap(
  vaultPath: string,
  dealId: string,
): Promise<SyncDealMapResult> {
  // Establish (or join, when called from a bulk sweep) a run-scoped manifest
  // cache so sibling-deal manifests built by the account rollup are reused
  // rather than rebuilt per deal.
  return runWithManifestCache(() => syncDealMapInner(vaultPath, dealId));
}

async function syncDealMapInner(
  vaultPath: string,
  dealId: string,
): Promise<SyncDealMapResult> {
  const baseManifest = await buildDealManifest(dealId, { vaultPath });
  // Re-stamp `synced_at` so this deal's own on-disk files record the instant of
  // ITS sync — matching pre-cache behavior — even when the structural manifest
  // was first built earlier in the run (as another deal's sibling). The rollup
  // never reads `synced_at`, and the cached copy is left untouched; this shallow
  // clone shares the now-immutable arrays, which downstream code only reads.
  const manifest = { ...baseManifest, synced_at: new Date().toISOString() };
  const folder = dealFolderPathV2(dealId, manifest.deal_name);
  const manifestRelative = `${folder}/${manifestFileName()}`;

  await mkdir(join(vaultPath, folder), { recursive: true });
  await writeFile(
    join(vaultPath, manifestRelative),
    serializeManifestYaml(manifest),
    "utf8",
  );

  const substantive = buildSubstantiveTimelineActivities(manifest);
  const calendar = calendarActivities(manifest.activities);

  const usedPaths = new Set<string>();
  const draftEntries: ActivityPathEntry[] = substantive.map((activity) => {
    const path = engagementRelativePath(activity, "substantive", usedPaths, folder);
    return {
      activity,
      path,
      title: noteTitleFromPath(path),
    };
  });

  const { timeline, mergedEmailIds } = buildDealTimeline(
    draftEntries,
    usedPaths,
    folder,
  );

  const mergedEmailIdSet = new Set(mergedEmailIds);
  const standaloneEntries = draftEntries.filter(
    (entry) => !mergedEmailIdSet.has(entry.activity.id),
  );

  const keptHubspotIds = new Set<string>([
    manifest.deal_id,
    `brief-${dealId}`,
    ...manifest.companies.map((company) => company.id),
    ...manifest.contacts.map((contact) => contact.id),
    ...manifest.engagement_contacts.map((contact) => contact.id),
    ...substantive.map((activity) => activity.id),
    ...calendar.map((activity) => activity.id),
  ]);

  for (const activity of substantive) {
    for (const alsoId of activity.alsoHubspotIds ?? []) {
      keptHubspotIds.add(alsoId);
    }
  }

  const titleByPath = new Map<string, string>();
  const activityPaths: string[] = [];
  const calendarPaths: string[] = [];

  for (const entry of standaloneEntries) {
    const timelineIndex = timeline.findIndex(
      (item) => item.kind === "activity" && item.activity.id === entry.activity.id,
    );
    const sequence = timelineIndex >= 0 ? timelineIndex + 1 : 0;
    const contactTitles = contactTitlesForActivity(
      entry.activity as ClassifiedActivity,
      manifest.contacts,
    );

    const saved = await upsertVaultNote(
      vaultPath,
      entry.path,
      renderActivityV2(
        entry.activity as ClassifiedActivity,
        manifest,
        entry.title,
        sequence,
        contactTitles,
      ),
      entry.activity.id,
      { dedupScope: folder },
    );
    activityPaths.push(saved.path);
    titleByPath.set(saved.path, noteTitleFromPath(saved.path));
  }

  for (const emailId of mergedEmailIds) {
    await deleteVaultNoteByHubspotId(vaultPath, emailId);
  }

  const threadPaths: string[] = [];
  for (const threadEntry of timeline) {
    if (threadEntry.kind !== "thread") {
      continue;
    }

    const timelineIndex = timeline.indexOf(threadEntry);
    const sequence = timelineIndex + 1;
    const syntheticId = threadSyntheticHubspotId(dealId, threadEntry.thread.threadKey);
    keptHubspotIds.add(syntheticId);

    const contactTitles = manifest.contacts
      .filter((contact) =>
        threadEntry.thread.messages.some((message) =>
          message.activity.associatedContactIds.includes(contact.id),
        ),
      )
      .map((contact) => entityContactTitle(contact));

    const saved = await upsertVaultNote(
      vaultPath,
      threadEntry.path,
      renderThreadV2(
        threadEntry as DealTimelineEntry & { kind: "thread" },
        manifest,
        threadEntry.title,
        sequence,
        contactTitles,
      ),
      syntheticId,
      { dedupScope: folder },
    );
    threadPaths.push(saved.path);
    titleByPath.set(saved.path, noteTitleFromPath(saved.path));
    threadEntry.title = noteTitleFromPath(saved.path);
  }

  for (const activity of calendar) {
    const path = engagementRelativePath(activity, "calendar", usedPaths, folder);
    const title = noteTitleFromPath(path);
    titleByPath.set(`calendar:${activity.id}`, title);

    const saved = await upsertVaultNote(
      vaultPath,
      path,
      renderCalendarActivityV2(activity, manifest),
      activity.id,
      { dedupScope: folder },
    );
    calendarPaths.push(saved.path);
    titleByPath.set(saved.path, title);
  }

  const companyPaths: string[] = [];
  for (const company of manifest.companies) {
    const relative = `${folder}/${entityCompanyPath(company.id)}`;
    const saved = await upsertVaultNote(
      vaultPath,
      relative,
      renderCompanyEntityV2(company, manifest),
      company.id,
      { dedupScope: folder },
    );
    companyPaths.push(saved.path);
    titleByPath.set(saved.path, entityCompanyTitle(company));
  }

  const contactPaths: string[] = [];
  for (const contact of manifest.contacts) {
    const relatedTitles = relatedActivityTitlesForContact(
      contact.id,
      timeline,
      titleByPath,
    );
    const relative = `${folder}/${entityContactPath(contact.id)}`;
    const saved = await upsertVaultNote(
      vaultPath,
      relative,
      renderContactEntityV2(contact, manifest, relatedTitles),
      contact.id,
      { dedupScope: folder },
    );
    contactPaths.push(saved.path);
    titleByPath.set(saved.path, entityContactTitle(contact));
  }

  // Engagement participants (meeting/email/call contacts not directly tied to
  // the deal). Rendered as entity pages so the link graph can resolve
  // activity→contact edges; not added to the deal's direct-contact glance.
  for (const contact of manifest.engagement_contacts) {
    const relatedTitles = relatedActivityTitlesForContact(
      contact.id,
      timeline,
      titleByPath,
    );
    const relative = `${folder}/${entityContactPath(contact.id)}`;
    const saved = await upsertVaultNote(
      vaultPath,
      relative,
      renderContactEntityV2(contact, manifest, relatedTitles),
      contact.id,
      { dedupScope: folder },
    );
    contactPaths.push(saved.path);
    titleByPath.set(saved.path, entityContactTitle(contact));
  }

  for (const entry of timeline) {
    titleByPath.set(entry.path, noteTitleFromPath(entry.path));
  }
  for (const entry of standaloneEntries) {
    titleByPath.set(entry.path, noteTitleFromPath(entry.path));
  }

  const learnings = await ensureHermesLearningsNoteV2(
    vaultPath,
    folder,
    dealId,
    manifest.deal_name,
  );

  const briefRelative = `${folder}/${briefFileName()}`;
  const briefPath = (
    await upsertVaultNote(
      vaultPath,
      briefRelative,
      renderBriefV2(manifest, timeline, titleByPath),
      `brief-${dealId}`,
      { dedupScope: folder },
    )
  ).path;

  const dealRelative = `${folder}/${dealIndexFileName()}`;
  const dealPath = (
    await upsertVaultNote(
      vaultPath,
      dealRelative,
      renderDealIndexV2(manifest, timeline, calendar, titleByPath),
      manifest.deal_id,
      { dedupScope: folder },
    )
  ).path;

  const keptRelativePaths = new Set<string>([
    manifestRelative,
    briefRelative,
    dealRelative,
    learnings.path,
    ...companyPaths,
    ...contactPaths,
    ...activityPaths,
    ...calendarPaths,
    ...threadPaths,
  ]);

  const staleRemoved = await removeStaleDealNotes(
    vaultPath,
    folder,
    keptHubspotIds,
    keptRelativePaths,
  );

  let accountPath: string | null = null;
  if (manifest.primary_company_id) {
    const account = await syncAccountRollup(
      vaultPath,
      manifest.primary_company_id,
      manifest,
    );
    accountPath = account.path;
  }

  return {
    dealId,
    vaultPath,
    accountPath,
    dealFolder: folder,
    manifestPath: manifestRelative,
    manifestPathAbsolute: join(vaultPath, manifestRelative),
    briefPath,
    briefPathAbsolute: join(vaultPath, briefPath),
    dealPath,
    dealPathAbsolute: join(vaultPath, dealPath),
    companyPaths,
    companyPathsAbsolute: absolutePaths(vaultPath, companyPaths),
    contactPaths,
    contactPathsAbsolute: absolutePaths(vaultPath, contactPaths),
    activityPaths,
    activityPathsAbsolute: absolutePaths(vaultPath, activityPaths),
    calendarPaths,
    threadPaths,
    threadPathsAbsolute: absolutePaths(vaultPath, threadPaths),
    learningsPath: learnings.path,
    learningsPathAbsolute: learnings.absolutePath,
    learningsCreated: learnings.created,
    substantiveCount: activityPaths.length + threadPaths.length,
    calendarCount: calendarPaths.length,
    threadCount: threadPaths.length,
    staleRemoved,
  };
}

function engagementRelativePath(
  activity: ClassifiedActivity,
  engagementClass: "substantive" | "calendar",
  usedPaths: Set<string>,
  dealFolder: string,
): string {
  const date = formatDatePrefix(activity.timestamp);
  const label = activityTypeLabel(activity.type);
  const subject = sanitizeFilename(activity.subject ?? activity.id);
  const base = `${date} ${label} — ${subject}`;
  let relative = `${dealFolder}/${engagementPath(engagementClass, base)}`;
  let suffix = 2;

  while (usedPaths.has(relative)) {
    relative = `${dealFolder}/${engagementPath(engagementClass, `${base} (${suffix})`)}`;
    suffix += 1;
  }

  usedPaths.add(relative);
  return relative;
}

function contactTitlesForActivity(
  activity: ClassifiedActivity,
  contacts: AssociatedRecord[],
): string[] {
  const byId = new Map(contacts.map((contact) => [contact.id, contact]));
  return activity.associatedContactIds
    .map((id) => byId.get(id))
    .filter((contact): contact is AssociatedRecord => contact !== undefined)
    .map((contact) => entityContactTitle(contact));
}

function relatedActivityTitlesForContact(
  contactId: string,
  timeline: DealTimelineEntry[],
  titleByPath: Map<string, string>,
): string[] {
  const titles: string[] = [];

  for (const entry of timeline) {
    if (entry.kind === "thread") {
      const involves = entry.thread.messages.some((message) =>
        message.activity.associatedContactIds.includes(contactId),
      );
      if (involves) {
        titles.push(titleByPath.get(entry.path) ?? entry.title);
      }
      continue;
    }

    if (entry.activity.associatedContactIds.includes(contactId)) {
      titles.push(titleByPath.get(entry.path) ?? entry.title);
    }
  }

  return titles.slice(0, 1);
}

function renderCalendarActivityV2(
  activity: ClassifiedActivity,
  manifest: Awaited<ReturnType<typeof buildDealManifest>>,
): string {
  const title = activity.subject ?? activityTypeLabel(activity.type);

  return `---
type: activity
source: hubspot
activity_type: ${activityTypeLabel(activity.type)}
engagement_class: calendar
hubspot_id: "${activity.id}"
deal_hubspot_id: "${manifest.deal_id}"
deal_brief: "[[${briefNoteTitle()}]]"
occurred_at: ${activity.timestamp ?? ""}
synced_at: ${manifest.synced_at}
tags: [gtm, hubspot, activity, calendar]
---

# ${title}

> Calendar/system engagement — listed in [[${briefNoteTitle()}]] deal index only.

| Field | Value |
|-------|-------|
| Type | ${activity.type} |
| Class | calendar |
| Occurred | ${activity.timestamp ?? ""} |
`;
}

async function removeStaleDealNotes(
  vaultPath: string,
  dealFolder: string,
  keptHubspotIds: Set<string>,
  keptRelativePaths: Set<string>,
): Promise<number> {
  // Stale removal (and the dedupScope passed to upsertVaultNote above) is
  // scoped to this deal's folder. Trade-off: if the deal-folder slug is renamed
  // out of band, the old-slug folder's entity notes are left orphaned here
  // rather than cleaned up. `npm run migrate-deal-folder` is the sanctioned
  // rename path that relocates the folder and its notes.
  const dealRoot = join(vaultPath, dealFolder);
  let removed = 0;

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "hermes") {
          continue;
        }
        await walk(fullPath);
        continue;
      }

      if (!entry.name.endsWith(".md")) {
        continue;
      }

      const relativePath = fullPath.replace(`${vaultPath}/`, "");
      if (keptRelativePaths.has(relativePath)) {
        continue;
      }

      const content = await readFile(fullPath, "utf8");
      const hubspotId = readFrontmatterHubspotId(content);
      const source = readFrontmatterSource(content);

      if (source === "hermes") {
        continue;
      }

      if (!hubspotId || !keptHubspotIds.has(hubspotId)) {
        await unlink(fullPath);
        removed += 1;
      }
    }
  }

  await walk(dealRoot);
  return removed;
}

function readFrontmatterHubspotId(content: string): string | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    return null;
  }
  const line = match[1].split("\n").find((entry) => entry.startsWith("hubspot_id:"));
  if (!line) {
    return null;
  }
  return line.slice("hubspot_id:".length).trim().replace(/^["']|["']$/g, "");
}

function readFrontmatterSource(content: string): string | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    return null;
  }
  const line = match[1].split("\n").find((entry) => entry.startsWith("source:"));
  if (!line) {
    return null;
  }
  return line.slice("source:".length).trim();
}

export { briefNoteTitle, learningsNoteTitle, dealFolderPathV2 };
