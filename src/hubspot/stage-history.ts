import { getHubSpotClient } from "./client.js";
import { loadDealPipelines, resolvePipelineStage } from "./pipelines.js";

const STAGE_HISTORY_PROPERTIES = [
  "dealstage",
  "pipeline",
  "createdate",
  "hs_lastmodifieddate",
  "hs_closed_lost_reason",
  "closed_lost_reason",
];

const STAGE_HISTORY_WITH_HISTORY = ["dealstage"];

const MS_PER_DAY = 1000 * 60 * 60 * 24;

export type StageOccupancy = {
  stageId: string;
  label: string;
  enteredAt: string;
  exitedAt: string | null;
  durationDays: number;
};

export type DealStageHistory = {
  dealId: string;
  pipelineId: string | null;
  pipelineLabel: string | null;
  currentStageId: string | null;
  currentStageLabel: string | null;
  isClosed: boolean;
  closedLostReason: string | null;
  totalAgeDays: number;
  hasStageHistory: boolean;
  stages: StageOccupancy[];
};

type HistoryEntry = { value?: string; timestamp?: string | Date };

function roundDays(milliseconds: number): number {
  return Math.round((milliseconds / MS_PER_DAY) * 10) / 10;
}

function toIso(timestamp: string | Date): string {
  return new Date(timestamp).toISOString();
}

function toMillis(timestamp: string | Date): number {
  return new Date(timestamp).getTime();
}

function isValidTimestamp(timestamp: string | Date): boolean {
  return Number.isFinite(new Date(timestamp).getTime());
}

export async function getDealStageHistory(dealId: string): Promise<DealStageHistory> {
  const hubspot = getHubSpotClient();
  await loadDealPipelines();

  const deal = await hubspot.crm.deals.basicApi.getById(
    dealId,
    STAGE_HISTORY_PROPERTIES,
    STAGE_HISTORY_WITH_HISTORY,
  );

  const properties = deal.properties ?? {};
  const pipelineId = properties.pipeline ?? null;
  const currentStageId = properties.dealstage ?? null;
  const closedLostReason =
    properties.hs_closed_lost_reason ?? properties.closed_lost_reason ?? null;

  const { pipeline, stage: currentStage } = await resolvePipelineStage(
    pipelineId,
    currentStageId,
  );

  // Resolve stage labels via one in-memory map rather than re-entering
  // resolvePipelineStage per entry (it's a pure cache lookup post-load).
  const stageById = new Map((pipeline?.stages ?? []).map((s) => [s.id, s] as const));

  // propertiesWithHistory is outside the SDK's typed return shape, so it's
  // cast — but never trusted: guard against a missing/non-array dealstage and
  // drop entries whose timestamp won't parse (truthy-but-invalid dates would
  // otherwise throw in toIso or yield NaN durations).
  const propertiesWithHistory =
    (deal as { propertiesWithHistory?: Record<string, HistoryEntry[]> })
      .propertiesWithHistory ?? {};
  const rawDealstage = propertiesWithHistory.dealstage;
  const rawHistory: HistoryEntry[] = Array.isArray(rawDealstage) ? rawDealstage : [];

  const history = rawHistory
    .filter((entry): entry is { value: string; timestamp: string | Date } =>
      Boolean(entry && entry.value && entry.timestamp) &&
      isValidTimestamp(entry.timestamp as string | Date),
    )
    .map((entry) => ({ value: entry.value, timestamp: entry.timestamp }))
    .sort((a, b) => toMillis(a.timestamp) - toMillis(b.timestamp));

  const now = Date.now();
  const hasStageHistory = history.length > 0;

  let stages: StageOccupancy[];
  let totalAgeDays: number;

  // Age anchors to createdate when it's earlier than the first stage entry (a
  // deal can exist before entering the pipeline); guarded for parseability.
  const createMs = properties.createdate ? toMillis(properties.createdate) : NaN;

  if (hasStageHistory) {
    stages = history.map((entry, index) => {
      const enteredMs = toMillis(entry.timestamp);
      const nextEntry = history[index + 1];
      const exitedMs = nextEntry ? toMillis(nextEntry.timestamp) : now;
      return {
        stageId: entry.value,
        label: stageById.get(entry.value)?.label ?? entry.value,
        enteredAt: toIso(entry.timestamp),
        exitedAt: nextEntry ? toIso(nextEntry.timestamp) : null,
        durationDays: roundDays(exitedMs - enteredMs),
      };
    });
    const firstMs = toMillis(history[0].timestamp);
    const anchorMs = Number.isFinite(createMs) ? Math.min(firstMs, createMs) : firstMs;
    totalAgeDays = roundDays(now - anchorMs);
  } else {
    const enteredMs = Number.isFinite(createMs) ? createMs : now;
    stages = [
      {
        stageId: currentStageId ?? "unknown",
        label: currentStage?.label ?? currentStageId ?? "unknown",
        enteredAt: new Date(enteredMs).toISOString(),
        exitedAt: null,
        durationDays: roundDays(now - enteredMs),
      },
    ];
    totalAgeDays = roundDays(now - enteredMs);
  }

  return {
    dealId,
    pipelineId,
    pipelineLabel: pipeline?.label ?? null,
    currentStageId,
    currentStageLabel: currentStage?.label ?? null,
    isClosed: currentStage?.isClosed ?? false,
    closedLostReason,
    totalAgeDays,
    hasStageHistory,
    stages,
  };
}
