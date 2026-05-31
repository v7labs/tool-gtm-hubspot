import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

import { getVaultPath } from "./config.js";
import { getDealActivities } from "./hubspot/activities.js";
import { getDeal } from "./hubspot/deals.js";
import { getDealStageHistory } from "./hubspot/stage-history.js";
import { getCompany, discoverCompanyGraph } from "./hubspot/company.js";
import { getDealGraph } from "./hubspot/graph.js";
import { ACTIVITY_TYPES } from "./hubspot/types.js";
import { syncDealMap } from "./vault/sync.js";

const server = new McpServer({
  name: "gtm-hubspot",
  version: "1.0.0",
});

server.registerTool(
  "hubspot_get_deal",
  {
    description: "Fetch a HubSpot deal by ID with core properties.",
    inputSchema: {
      dealId: z.string().describe("HubSpot deal object ID"),
    },
  },
  async ({ dealId }) => {
    const deal = await getDeal(dealId);
    return {
      content: [{ type: "text", text: JSON.stringify(deal, null, 2) }],
    };
  },
);

server.registerTool(
  "get_deal_stage_history",
  {
    description:
      "Fetch per-stage dwell times, pipeline-transition timeline, and disqualification reason for a HubSpot deal. Returns stage occupancy (enteredAt/exitedAt/durationDays), total age, closed-lost & disqualification reasons, whether it passed a Disqualified stage, the cross-pipeline history, and movedToPipeline (the most recent pipeline the deal moved into, null if it never changed pipelines).",
    inputSchema: {
      dealId: z.string().describe("HubSpot deal object ID"),
    },
  },
  async ({ dealId }) => {
    const history = await getDealStageHistory(dealId);
    return {
      content: [{ type: "text", text: JSON.stringify(history, null, 2) }],
    };
  },
);

server.registerTool(
  "hubspot_get_deal_activities",
  {
    description:
      "Fetch normalized activity timeline for a deal (notes, tasks, calls, emails, meetings).",
    inputSchema: {
      dealId: z.string().describe("HubSpot deal object ID"),
      types: z
        .array(z.enum(ACTIVITY_TYPES))
        .optional()
        .describe("Activity types to include"),
      since: z
        .string()
        .optional()
        .describe("ISO date — only include activities on or after this date"),
      limit: z.number().int().positive().max(200).optional(),
      includeBody: z.boolean().optional(),
    },
  },
  async ({ dealId, types, since, limit, includeBody }) => {
    const activities = await getDealActivities(dealId, {
      types,
      since,
      limit,
      includeBody,
    });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ dealId, activityCount: activities.length, activities }, null, 2),
        },
      ],
    };
  },
);

server.registerTool(
  "hubspot_get_company",
  {
    description:
      "Fetch a HubSpot company by ID with core properties and HubSpot record URL.",
    inputSchema: {
      companyId: z.string().describe("HubSpot company object ID"),
    },
  },
  async ({ companyId }) => {
    const company = await getCompany(companyId);
    return {
      content: [{ type: "text", text: JSON.stringify(company, null, 2) }],
    };
  },
);

server.registerTool(
  "hubspot_discover_company_graph",
  {
    description:
      "Recursively discover company CRM graph (deals, contacts, activity counts, gong ids) for hubspot-inventory.yaml.",
    inputSchema: {
      companyId: z.string().describe("HubSpot company object ID"),
    },
  },
  async ({ companyId }) => {
    const inventory = await discoverCompanyGraph(companyId);
    return {
      content: [{ type: "text", text: JSON.stringify(inventory, null, 2) }],
    };
  },
);

server.registerTool(
  "hubspot_get_deal_graph",
  {
    description:
      "Fetch a deal with associated companies, contacts, and full activity timeline.",
    inputSchema: {
      dealId: z.string().describe("HubSpot deal object ID"),
    },
  },
  async ({ dealId }) => {
    const graph = await getDealGraph(dealId);
    return {
      content: [{ type: "text", text: JSON.stringify(graph, null, 2) }],
    };
  },
);

server.registerTool(
  "vault_sync_deal_map",
  {
    description:
      "Sync a deal knowledge map into the Obsidian vault with company, contacts, and deal activities.",
    inputSchema: {
      dealId: z.string().describe("HubSpot deal object ID"),
    },
  },
  async ({ dealId }) => {
    const vaultPath = getVaultPath();
    const result = await syncDealMap(vaultPath, dealId);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  console.error("gtm-hubspot MCP failed:", error);
  process.exit(1);
});
