import { getHubSpotClient } from "./client.js";
import { scheduleHubSpotRequest } from "./rate-limiter.js";
import { loadDealPipelines } from "./pipelines.js";
import { FilterOperatorEnum } from "@hubspot/api-client/lib/codegen/crm/deals/models/Filter.js";

const SEARCH_PAGE_SIZE = 200; // HubSpot search API hard max per page.
// HubSpot's Search API refuses to page past 10,000 total results (it throws
// once the `after` offset would exceed 10k). 60 pages * 200 covers that ceiling
// with headroom and also bounds against a pathological never-ending cursor.
// Open-deal cohorts are far below 10k, so this is purely defensive.
const HARD_PAGE_CAP = 60;

export type ListOpenDealsOptions = {
  /** Stop after collecting this many ids. Defaults to all open deals. */
  maxResults?: number;
};

/**
 * List the ids of all OPEN deals in a pipeline.
 *
 * "Open" is determined by the pipeline stage's `isClosed` metadata flag (the
 * authoritative HubSpot signal), NOT a label regex — in this portal closed
 * holding stages such as "Nurture" and "Disqualified" do not contain the words
 * closed/won/lost, so a label heuristic silently misclassifies them.
 *
 * Results are gathered by filtering the search to the open stage ids and paging
 * through the full result set via the `after` cursor, so the count is not capped
 * at a single 200-deal page.
 */
export async function listOpenDealIdsInPipeline(
  pipelineId: string,
  options: ListOpenDealsOptions = {},
): Promise<string[]> {
  const maxResults = options.maxResults ?? Number.POSITIVE_INFINITY;
  if (maxResults <= 0) {
    return [];
  }

  const hubspot = getHubSpotClient();
  const pipelines = await loadDealPipelines();
  const pipeline = pipelines.find((item) => item.id === pipelineId);
  if (!pipeline) {
    throw new Error(
      `Pipeline ${pipelineId} not found among HubSpot deal pipelines`,
    );
  }

  const openStageIds = pipeline.stages
    .filter((stage) => !stage.isClosed)
    .map((stage) => stage.id);
  if (openStageIds.length === 0) {
    return [];
  }

  const ids: string[] = [];
  let after: string | undefined;

  for (let page = 0; page < HARD_PAGE_CAP; page += 1) {
    const remaining = maxResults - ids.length;
    if (remaining <= 0) {
      break;
    }

    const response = await scheduleHubSpotRequest(
      () =>
        hubspot.crm.deals.searchApi.doSearch({
        filterGroups: [
          {
            filters: [
              {
                propertyName: "pipeline",
                operator: FilterOperatorEnum.Eq,
                value: pipelineId,
              },
              {
                propertyName: "dealstage",
                operator: FilterOperatorEnum.In,
                values: openStageIds,
              },
            ],
          },
        ],
        properties: ["dealname", "dealstage"],
        limit: Math.min(SEARCH_PAGE_SIZE, remaining),
        after,
      }),
      "deals.search",
    );

    for (const deal of response.results ?? []) {
      ids.push(deal.id);
    }

    after = response.paging?.next?.after;
    if (!after) {
      break;
    }
  }

  return ids;
}
