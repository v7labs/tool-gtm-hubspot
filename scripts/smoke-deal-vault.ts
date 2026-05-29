/**
 * Smoke test: one synced deal folder in the Obsidian vault (v2).
 * Validates structure, source layers, wikilink budget, and graph-noise signals.
 *
 * Usage: tsx scripts/smoke-deal-vault.ts <dealId>
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import { getVaultPath } from "../src/config.js";

const dealId = process.argv[2] ?? "60030766691";
const vaultPath = getVaultPath();

type Finding = {
  severity: "fail" | "warn" | "info";
  code: string;
  message: string;
};

const findings: Finding[] = [];

function fail(code: string, message: string): void {
  findings.push({ severity: "fail", code, message });
}

function warn(code: string, message: string): void {
  findings.push({ severity: "warn", code, message });
}

function info(code: string, message: string): void {
  findings.push({ severity: "info", code, message });
}

function readFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) {
      continue;
    }
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    value = value.replace(/^["']|["']$/g, "");
    out[key] = value;
  }
  return out;
}

function countWikilinks(content: string): number {
  return (content.match(/\[\[[^\]]+\]\]/g) ?? []).length;
}

function extractWikilinkTitles(content: string): string[] {
  return [...content.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)].map((m) => m[1].trim());
}

async function findDealFolder(): Promise<string | null> {
  const dealsRoot = join(vaultPath, "GTM/Deals");
  const entries = await readdir(dealsRoot, { withFileTypes: true });

  const idPrefixed = entries.find(
    (entry) => entry.isDirectory() && entry.name.startsWith(`${dealId} `),
  );
  if (idPrefixed) {
    return join(dealsRoot, idPrefixed.name);
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const folder = join(dealsRoot, entry.name);
    const files = await readdir(folder, { recursive: true });
    for (const file of files) {
      if (typeof file !== "string" || !file.endsWith(".md")) {
        continue;
      }
      const content = await readFile(join(folder, file), "utf8");
      const fm = readFrontmatter(content);
      if (fm.deal_hubspot_id === dealId || fm.hubspot_id === dealId) {
        return folder;
      }
    }
  }
  return null;
}

async function collectMarkdownFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.name.endsWith(".md")) {
        out.push(full);
      }
    }
  }
  await walk(dir);
  return out;
}

async function main(): Promise<void> {
  const dealFolder = await findDealFolder();
  if (!dealFolder) {
    fail("DEAL_FOLDER", `No deal folder found for hubspot id ${dealId}`);
    printReport();
    process.exit(1);
  }

  const folderName = basename(dealFolder);
  info("DEAL_FOLDER", dealFolder.replace(vaultPath + "/", ""));

  if (!folderName.startsWith(`${dealId} `)) {
    warn("V2_FOLDER_NAME", `Deal folder not ID-prefixed: ${folderName}`);
  }

  let manifestRaw = "";
  if (!(await exists(join(dealFolder, "manifest.yaml")))) {
    warn("NO_MANIFEST", "manifest.yaml not present (v2 required)");
  } else {
    manifestRaw = await readFile(join(dealFolder, "manifest.yaml"), "utf8");
    info("MANIFEST", "manifest.yaml present");
    if (!/^motion:\s/m.test(manifestRaw)) {
      fail("MANIFEST_MOTION", "manifest.yaml missing motion field");
    }
  }

  const files = await collectMarkdownFiles(dealFolder);
  const titleToPath = new Map<string, string>();
  for (const file of files) {
    const baseTitle = basename(file, ".md");
    titleToPath.set(baseTitle, file);
    const content = await readFile(file, "utf8");
    const fm = readFrontmatter(content);
    if (fm.aliases) {
      const aliasMatch = content.match(/^aliases:\s*\[(.*)\]/m);
      if (aliasMatch) {
        for (const alias of aliasMatch[1].match(/"([^"]+)"/g) ?? []) {
          titleToPath.set(alias.replace(/"/g, ""), file);
        }
      }
    }
    const heading = content.match(/^# (.+)$/m);
    if (heading) {
      titleToPath.set(heading[1].trim(), file);
    }
  }

  const brief = files.find((f) => basename(f) === "Brief.md");
  const learnings = files.find((f) => f.endsWith("/hermes/Learnings.md"));
  const dealIndex = files.find((f) => basename(f) === "Deal.md");

  if (!brief) {
    fail("MISSING_BRIEF", "Brief.md missing");
  }
  if (!learnings) {
    warn("MISSING_LEARNINGS", "hermes/Learnings.md missing (stub expected after sync)");
  }
  if (!dealIndex) {
    fail("MISSING_DEAL_INDEX", "Deal.md missing");
  }

  let hubspotNotes = 0;
  let hermesNotes = 0;
  let calendarInBrief = 0;
  const duplicateMeetingTimes = new Map<string, string[]>();
  let totalWikilinks = 0;
  let prevNextLinks = 0;
  let rawStageInDeal = false;

  for (const file of files) {
    const content = await readFile(file, "utf8");
    const fm = readFrontmatter(content);
    const links = countWikilinks(content);
    totalWikilinks += links;

    if (fm.source === "hermes") {
      hermesNotes += 1;
    } else if (fm.source === "hubspot") {
      hubspotNotes += 1;
    } else if (!file.includes("/hermes/")) {
      warn("MISSING_SOURCE", `${basename(file)}: no source frontmatter`);
    }

    if (
      file.includes("/engagements/") ||
      file.includes("/threads/") ||
      file.includes("/activities/")
    ) {
      if (fm.prev || fm.next) {
        prevNextLinks += 1;
      }
      if (fm.activity_type === "meeting" && fm.occurred_at) {
        const list = duplicateMeetingTimes.get(fm.occurred_at) ?? [];
        list.push(basename(file, ".md"));
        duplicateMeetingTimes.set(fm.occurred_at, list);
      }
    }

    for (const title of extractWikilinkTitles(content)) {
      if (!titleToPath.has(title)) {
        const globalCandidates = [
          join(vaultPath, "GTM/Accounts", `${title}.md`),
          join(vaultPath, "GTM/Contacts", `${title}.md`),
        ];
        let found = false;
        for (const candidate of globalCandidates) {
          if (await exists(candidate)) {
            found = true;
            break;
          }
        }
        if (!found) {
          warn("BROKEN_WIKILINK", `${basename(file)} → [[${title}]] (no matching note)`);
        }
      }
    }

    if (brief && file === brief) {
      const briefLinks = countWikilinks(content);
      if (briefLinks > 8) {
        fail("BRIEF_LINK_BUDGET", `Brief has ${briefLinks} wikilinks (v2 max: ≤8)`);
      } else {
        info("BRIEF_LINK_BUDGET", `${briefLinks} wikilinks (≤8)`);
      }
      if (!fm.motion) {
        fail("BRIEF_MOTION", "Brief.md missing motion frontmatter");
      }
      if (!fm.stage_label) {
        warn("BRIEF_STAGE_LABEL", "Brief.md missing stage_label frontmatter");
      }
      if (!fm.primary_company_id) {
        warn("BRIEF_PRIMARY_COMPANY", "Brief.md missing primary_company_id frontmatter");
      }
      if (/Accepted:|Declined:|Our meeting in \d+ minutes/i.test(content)) {
        calendarInBrief += 1;
      }
    }

    if (dealIndex && file === dealIndex) {
      if (!fm.motion) {
        fail("DEAL_MOTION", "Deal.md missing motion frontmatter");
      }
      if (links > 30) {
        warn("DEAL_INDEX_LINK_BUDGET", `Deal index has ${links} wikilinks (v2 target: ≤3 + tables)`);
      }
      if (fm.stage_label && /^\d+$/.test(String(fm.stage_label))) {
        rawStageInDeal = true;
      }
      const body = content.split("---").slice(2).join("---");
      if (/Stage \| \d{6,}/.test(body) && !fm.stage_label) {
        rawStageInDeal = true;
      }
    }
  }

  const entityContacts = files.filter((f) => f.includes("/entities/contact-"));
  if (dealId === "60030766691" && entityContacts.length === 0) {
    warn("GLOBAL_CONTACT_BRIDGE", "No deal-local entities/contact-*.md notes");
  }

  const globalContactPath = join(vaultPath, "GTM/Contacts/Andrew Keating.md");
  if (dealId === "60030766691" && (await exists(globalContactPath))) {
    const contactContent = await readFile(globalContactPath, "utf8");
    const dealMentions = (contactContent.match(/KarpReilly/g) ?? []).length;
    if (dealMentions > 0 && entityContacts.length > 0) {
      info("GLOBAL_CONTACT_BRIDGE", "Global contact exists but deal uses local entities/");
    } else if (dealMentions > 0) {
      warn("GLOBAL_CONTACT_BRIDGE", "Contact note links to deal via global GTM/Contacts/");
    }
  }

  for (const [time, meetings] of duplicateMeetingTimes) {
    if (meetings.length > 1) {
      warn("DUPLICATE_MEETINGS", `${time}: ${meetings.length} meeting notes (${meetings.join("; ")})`);
    }
  }

  if (calendarInBrief > 0) {
    warn("CALENDAR_IN_BRIEF", "Brief timeline includes calendar-style activity titles");
  }
  if (prevNextLinks > 0) {
    warn("PREV_NEXT_CHAINS", `${prevNextLinks} activity/thread notes with prev/next wikilink chains`);
  }
  if (rawStageInDeal) {
    warn("RAW_STAGE_ID", "Deal shows numeric stage ID instead of resolved label");
  }

  info("NOTE_COUNTS", `${hubspotNotes} hubspot notes, ${hermesNotes} hermes notes, ${files.length} total md`);
  info("WIKILINK_TOTAL", `${totalWikilinks} wikilinks across deal folder`);

  const substantive = files.filter((f) => f.includes("/engagements/substantive/")).length;
  const calendar = files.filter((f) => f.includes("/engagements/calendar/")).length;
  const legacyActivities = files.filter((f) => f.includes("/activities/")).length;
  const threads = files.filter((f) => f.includes("/threads/")).length;
  const timelineNodes = substantive + threads + legacyActivities;

  info(
    "ENGAGEMENT_COUNTS",
    `${substantive} substantive + ${calendar} calendar + ${threads} threads (${legacyActivities} legacy activities)`,
  );
  if (timelineNodes > 8) {
    warn("TIMELINE_DENSITY", `${timelineNodes} timeline nodes (v2 target: ~4-6 substantive + threads)`);
  }

  if (manifestRaw) {
    const meetingIds = [
      ...manifestRaw.matchAll(/type: meetings, id: "(\d+)"/g),
    ].map((match) => match[1]);
    const gongMeetingEdges = [
      ...manifestRaw.matchAll(
        /from: \{ type: meetings, id: "(\d+)" \}\s+to: \{ type: gong_call/g,
      ),
    ].map((match) => match[1]);
    const gongMarkedMeetings = files
      .filter((f) => f.includes("/engagements/"))
      .map(async (f) => {
        const content = await readFile(f, "utf8");
        return /\[Gong\]/i.test(content) ? basename(f) : null;
      });
    const gongFiles = (await Promise.all(gongMarkedMeetings)).filter(Boolean);

    if (gongFiles.length > 0 && gongMeetingEdges.length === 0) {
      fail(
        "GONG_MANIFEST_EDGES",
        "Meetings mention [Gong] but manifest has no meetings→gong_call edges",
      );
    } else if (meetingIds.length > 0 && gongMeetingEdges.length > 0) {
      info(
        "GONG_MANIFEST_EDGES",
        `${gongMeetingEdges.length} meetings linked to gong_call in manifest`,
      );
    }
  }

  printReport();
  process.exit(findings.some((f) => f.severity === "fail") ? 1 : 0);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function printReport(): void {
  const fails = findings.filter((f) => f.severity === "fail");
  const warns = findings.filter((f) => f.severity === "warn");
  console.log(
    JSON.stringify({ dealId, pass: fails.length === 0, fail: fails.length, warn: warns.length, findings }, null, 2),
  );
}

await main();
