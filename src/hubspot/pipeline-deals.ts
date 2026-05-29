import { getHubSpotClient } from "./client.js";
import { loadDealPipelines } from "./pipelines.js";
import { FilterOperatorEnum } from "@hubspot/api-client/lib/codegen/crm/deals/models/Filter.js";

export async function listOpenDealIdsInPipeline(
  pipelineId: string,
  limit = 200,
): Promise<string[]> {
  const hubspot = getHubSpotClient();
  const pipelines = await loadDealPipelines();
  const pipeline = pipelines.find((item) => item.id === pipelineId);
  const closedStageIds = new Set(
    (pipeline?.stages ?? [])
      .filter((stage) => /closed|won|lost/i.test(stage.label))
      .map((stage) => stage.id),
  );

  const response = await hubspot.crm.deals.searchApi.doSearch({
    filterGroups: [
      {
        filters: [
          {
            propertyName: "pipeline",
            operator: FilterOperatorEnum.Eq,
            value: pipelineId,
          },
        ],
      },
    ],
    properties: ["dealname", "dealstage", "pipeline"],
    limit,
  });

  return (response.results ?? [])
    .filter((deal) => !closedStageIds.has(deal.properties.dealstage ?? ""))
    .map((deal) => deal.id);
}
