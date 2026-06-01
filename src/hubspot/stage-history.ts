import { getHubSpotClient } from "./client.js";
import { scheduleHubSpotRequest } from "./rate-limiter.js";
import { loadDealPipelines, resolvePipelineStage } from "./pipelines.js";
import type { PipelineStage } from "./pipelines.js";

const STAGE_HISTORY_PROPERTIES = [
  "dealstage",
  "pipeline",
  "createdate",
  "hs_lastmodifieddate",
  "hs_closed_lost_reason",
  "closed_lost_reason",
  // Lead-management pipelines record a disqualification reason in a custom
  // property distinct from closed-lost (verified 2026-05-31: the property is
  // `disqualified_reason`, e.g. "No Project").
  "disqualified_reason",
];

// Request history for both `dealstage` AND `pipeline` so cross-pipeline
// journeys (e.g. lead-mgmt → New Business) are captured, not just stage jumps.
const STAGE_HISTORY_WITH_HISTORY = ["dealstage", "pipeline"];

const MS_PER_DAY = 1000 * 60 * 60 * 24;

const DISQUALIFIED_LABEL = /disqualif/i;

export type StageOccupancy = {
  stageId: string;
  label: string;
  enteredAt: string;
  exitedAt: string | null;
  durationDays: number;
};

export type PipelineOccupancy = {
  pipelineId: string;
  label: string | null;
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
  // Lead-mgmt disqualification reason (custom property), surfaced alongside
  // closedLostReason since a Disqualified stage may not be a closed-lost stage.
  disqualificationReason: string | null;
  // True when the deal occupied a Disqualified stage at any point, even if the
  // CURRENT stage's metadata doesn't flag it as closed.
  passedDisqualifiedStage: boolean;
  totalAgeDays: number;
  hasStageHistory: boolean;
  stages: StageOccupancy[];
  // Pipeline-change timeline (one entry per distinct pipeline occupied).
  pipelineHistory: PipelineOccupancy[];
  // The pipeline the deal moved INTO when it crossed pipelines (e.g. the
  // qualified → New Business `689928` move). Null when the deal never changed
  // pipeline. First-class so the WIN signal is directly detectable.
  movedToPipeline: { id: string; label: string | null; at: string } | null;
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

  const deal = await scheduleHubSpotRequest(
    () =>
      hubspot.crm.deals.basicApi.getById(
        dealId,
        STAGE_HISTORY_PROPERTIES,
        STAGE_HISTORY_WITH_HISTORY,
      ),
    "deal.getById.withHistory",
  );

  const properties = deal.properties ?? {};
  const pipelineId = properties.pipeline ?? null;
  const currentStageId = properties.dealstage ?? null;
  const closedLostReason =
    properties.hs_closed_lost_reason ?? properties.closed_lost_reason ?? null;
  const disqualificationReason = properties.disqualified_reason ?? null;

  const { pipeline, stage: currentStage } = await resolvePipelineStage(
    pipelineId,
    currentStageId,
  );

  // Resolve stage AND pipeline labels across EVERY pipeline (not just the
  // current one) so historical stages from a deal's prior pipeline — e.g. the
  // lead-mgmt stages of a deal now in New Business — still resolve to labels
  // instead of falling back to raw ids. Pure cache lookups post-load.
  const allPipelines = await loadDealPipelines();
  // Assumes HubSpot deal-stage ids are unique per portal (true on this portal):
  // a single global stageById/disqualifiedStageIds is built across ALL
  // pipelines, so a stage id colliding between two pipelines would clobber.
  const stageById = new Map<string, PipelineStage>();
  const pipelineLabelById = new Map<string, string>();
  const disqualifiedStageIds = new Set<string>();
  for (const p of allPipelines) {
    pipelineLabelById.set(p.id, p.label);
    for (const s of p.stages) {
      if (stageById.has(s.id)) {
        // Duplicate stage id across pipelines — last wins; see comment above.
      }
      stageById.set(s.id, s);
      if (DISQUALIFIED_LABEL.test(s.label)) {
        disqualifiedStageIds.add(s.id);
      }
    }
  }

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

  // Pipeline-change timeline. Parse the `pipeline` property history the same
  // defensive way as dealstage, then collapse consecutive identical values into
  // occupancy spans (one entry per distinct pipeline the deal sat in).
  const rawPipeline = propertiesWithHistory.pipeline;
  const pipelineEvents = (Array.isArray(rawPipeline) ? rawPipeline : [])
    .filter((entry): entry is { value: string; timestamp: string | Date } =>
      Boolean(entry && entry.value && entry.timestamp) &&
      isValidTimestamp(entry.timestamp as string | Date),
    )
    .map((entry) => ({ value: entry.value, timestamp: entry.timestamp }))
    .sort((a, b) => toMillis(a.timestamp) - toMillis(b.timestamp));

  const collapsedPipeline = pipelineEvents.filter(
    (entry, index) => index === 0 || entry.value !== pipelineEvents[index - 1].value,
  );

  const pipelineHistory: PipelineOccupancy[] = collapsedPipeline.map((entry, index) => {
    const enteredMs = toMillis(entry.timestamp);
    const nextEntry = collapsedPipeline[index + 1];
    const exitedMs = nextEntry ? toMillis(nextEntry.timestamp) : now;
    return {
      pipelineId: entry.value,
      label: pipelineLabelById.get(entry.value) ?? null,
      enteredAt: toIso(entry.timestamp),
      exitedAt: nextEntry ? toIso(nextEntry.timestamp) : null,
      durationDays: roundDays(exitedMs - enteredMs),
    };
  });

  // The deal crossed pipelines when it occupied more than one distinct
  // pipeline; the WIN signal is the final pipeline it moved into.
  const lastPipeline = pipelineHistory[pipelineHistory.length - 1];
  const movedToPipeline =
    pipelineHistory.length > 1 && lastPipeline
      ? {
          id: lastPipeline.pipelineId,
          label: lastPipeline.label,
          at: lastPipeline.enteredAt,
        }
      : null;

  const passedDisqualifiedStage = stages.some((occupancy) =>
    disqualifiedStageIds.has(occupancy.stageId),
  );

  return {
    dealId,
    pipelineId,
    pipelineLabel: pipeline?.label ?? null,
    currentStageId,
    currentStageLabel: currentStage?.label ?? null,
    isClosed: currentStage?.isClosed ?? false,
    closedLostReason,
    disqualificationReason,
    passedDisqualifiedStage,
    totalAgeDays,
    hasStageHistory,
    stages,
    pipelineHistory,
    movedToPipeline,
  };
}
