import { getHubSpotClient } from "./client.js";
import { getOwnerName } from "./client.js";
import { scheduleHubSpotRequest } from "./rate-limiter.js";

export type PipelineStage = { id: string; label: string; isClosed: boolean };
type Pipeline = { id: string; label: string; stages: PipelineStage[] };

let pipelineCache: Pipeline[] | null = null;

export async function loadDealPipelines(): Promise<Pipeline[]> {
  if (pipelineCache) {
    return pipelineCache;
  }

  const hubspot = getHubSpotClient();
  const response = await scheduleHubSpotRequest(
    () => hubspot.crm.pipelines.pipelinesApi.getAll("deals"),
    "pipelines.getAll",
  );
  pipelineCache = (response.results ?? []).map((pipeline) => ({
    id: pipeline.id,
    label: pipeline.label,
    stages: (pipeline.stages ?? []).map((stage) => ({
      id: stage.id,
      label: stage.label,
      isClosed:
        (stage.metadata as Record<string, string> | undefined)?.isClosed ===
        "true",
    })),
  }));
  return pipelineCache;
}

export async function resolvePipelineStage(
  pipelineId: string | null | undefined,
  stageId: string | null | undefined,
): Promise<{ pipeline: Pipeline | null; stage: PipelineStage | null }> {
  const pipelines = await loadDealPipelines();
  const pipeline = pipelines.find((item) => item.id === pipelineId) ?? null;
  const stage =
    pipeline?.stages.find((item) => item.id === stageId) ??
    (stageId ? { id: stageId, label: stageId, isClosed: false } : null);
  return { pipeline, stage };
}

export async function resolveOwnerName(
  ownerId: string | null | undefined,
): Promise<string | null> {
  return getOwnerName(ownerId);
}

export function getHubSpotPortalId(): string {
  return process.env.HUBSPOT_PORTAL_ID ?? "19912923";
}

export function dealRecordUrl(dealId: string): string {
  return `https://app.hubspot.com/contacts/${getHubSpotPortalId()}/record/0-3/${dealId}`;
}
