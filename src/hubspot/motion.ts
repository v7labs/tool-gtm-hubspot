import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";

export type DealMotion = "outbound" | "inbound" | "renewal" | "customer_success";

export type StageOverride = {
  pipelineId: string;
  stageContains: string;
  motion: DealMotion;
};

export type LifecycleConfig = {
  pipelines?: Record<string, DealMotion>;
  pipeline_labels?: Record<string, DealMotion>;
  stage_overrides?: StageOverride[];
  deal_overrides?: Record<string, DealMotion>;
  inbound_source_patterns?: string[];
  default_motion?: DealMotion;
};

const EXPANSION_LABEL = /\b(upsell|expansion|cross-?sell|upgrade|seat)\b/i;
const RENEWAL_LABEL = /\b(renewal|renew)\b/i;
const CS_LABEL =
  /\b(customer success|customer_success|cs\b|support|success|implementation|onboarding)\b/i;
const INBOUND_LABEL = /\b(inbound|marketing|referral)\b/i;

// Analytics sources that are NOT genuine inbound signals. HubSpot stamps
// sales-created deals as OFFLINE/DIRECT/SALES — treating those as inbound is
// the bug that made every Capital Dynamics deal read as inbound.
const DEFAULT_INBOUND_SOURCE_PATTERNS = [
  "inbound",
  "referral",
  "marketing",
  "form",
  "organic",
  "social",
  "paid",
];

let lifecycleCache: LifecycleConfig | null | undefined;

export async function loadLifecycleConfig(
  vaultPath: string,
): Promise<LifecycleConfig> {
  if (lifecycleCache !== undefined) {
    return lifecycleCache ?? {};
  }

  const path = join(vaultPath, "GTM/deal-registry.lifecycle.yaml");
  if (!existsSync(path)) {
    lifecycleCache = {};
    return {};
  }

  try {
    const raw = await readFile(path, "utf8");
    lifecycleCache = parseLifecycleYaml(raw);
    return lifecycleCache;
  } catch {
    lifecycleCache = {};
    return {};
  }
}

type TopSection =
  | "pipelines"
  | "pipeline_labels"
  | "deal_overrides"
  | "stage_overrides"
  | "inbound_source_patterns"
  | null;

function indentOf(line: string): number {
  return line.length - line.replace(/^\s+/, "").length;
}

/**
 * Extract a YAML scalar value, honoring quotes and stripping trailing
 * `# inline comments` from unquoted values.
 */
function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    const quote = trimmed[0];
    const end = trimmed.indexOf(quote, 1);
    if (end !== -1) {
      return trimmed.slice(1, end);
    }
    return trimmed.slice(1);
  }
  const commentIdx = trimmed.search(/\s#/);
  const withoutComment = commentIdx === -1 ? trimmed : trimmed.slice(0, commentIdx);
  return withoutComment.trim();
}

export function parseLifecycleYaml(raw: string): LifecycleConfig {
  const config: LifecycleConfig = {
    pipelines: {},
    pipeline_labels: {},
    deal_overrides: {},
    stage_overrides: [],
    inbound_source_patterns: [],
  };

  let section: TopSection = null;
  let currentOverride: Partial<StageOverride> | null = null;

  const flushOverride = (): void => {
    if (
      currentOverride &&
      currentOverride.pipelineId &&
      currentOverride.stageContains &&
      currentOverride.motion
    ) {
      config.stage_overrides!.push(currentOverride as StageOverride);
    }
    currentOverride = null;
  };

  for (const rawLine of raw.split("\n")) {
    const line = rawLine.replace(/\t/g, "  ");
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const indent = indentOf(line);

    // Top-level keys (no indentation).
    if (indent === 0) {
      flushOverride();
      if (trimmed === "pipelines:") {
        section = "pipelines";
        continue;
      }
      if (trimmed === "pipeline_labels:") {
        section = "pipeline_labels";
        continue;
      }
      if (trimmed === "deal_overrides:") {
        section = "deal_overrides";
        continue;
      }
      if (trimmed === "stage_overrides:") {
        section = "stage_overrides";
        continue;
      }
      if (trimmed === "inbound_source_patterns:") {
        section = "inbound_source_patterns";
        continue;
      }
      if (trimmed.startsWith("default_motion:")) {
        section = null;
        const value = stripQuotes(trimmed.slice("default_motion:".length));
        if (isMotion(value)) {
          config.default_motion = value;
        }
        continue;
      }
      // Unknown top-level key — reset section.
      section = null;
      continue;
    }

    if (section === "stage_overrides") {
      if (trimmed.startsWith("- ")) {
        flushOverride();
        currentOverride = {};
        const inline = trimmed.slice(2).trim();
        applyOverrideField(currentOverride, inline);
        continue;
      }
      if (currentOverride) {
        applyOverrideField(currentOverride, trimmed);
      }
      continue;
    }

    if (section === "inbound_source_patterns") {
      if (trimmed.startsWith("- ")) {
        const value = stripQuotes(trimmed.slice(2)).toLowerCase();
        if (value) {
          config.inbound_source_patterns!.push(value);
        }
      }
      continue;
    }

    if (
      section === "pipelines" ||
      section === "pipeline_labels" ||
      section === "deal_overrides"
    ) {
      const match = trimmed.match(/^["']?([^"':]+)["']?\s*:\s*(\S+)/);
      if (!match) {
        continue;
      }
      const key = match[1].trim();
      const motion = stripQuotes(match[2]);
      if (!isMotion(motion)) {
        continue;
      }
      config[section]![key] = motion;
    }
  }

  flushOverride();
  return config;
}

function applyOverrideField(
  override: Partial<StageOverride>,
  fragment: string,
): void {
  const idx = fragment.indexOf(":");
  if (idx === -1) {
    return;
  }
  const key = fragment.slice(0, idx).trim();
  const value = stripQuotes(fragment.slice(idx + 1));
  if (key === "pipeline_id") {
    override.pipelineId = value;
  } else if (key === "stage_contains") {
    override.stageContains = value.toLowerCase();
  } else if (key === "motion" && isMotion(value)) {
    override.motion = value;
  }
}

function isMotion(value: string): value is DealMotion {
  return (
    value === "outbound" ||
    value === "inbound" ||
    value === "renewal" ||
    value === "customer_success"
  );
}

function isInboundSource(
  source: string,
  patterns: string[] | undefined,
): boolean {
  const normalized = source.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  const list =
    patterns && patterns.length > 0 ? patterns : DEFAULT_INBOUND_SOURCE_PATTERNS;
  return list.some((pattern) => normalized.includes(pattern));
}

export function deriveMotion(params: {
  dealId?: string | null;
  pipelineId: string | null;
  pipelineLabel: string | null;
  stageLabel?: string | null;
  dealtype: string;
  hsDealSource: string;
  hasReferralDealEdge: boolean;
  lifecycle?: LifecycleConfig;
}): DealMotion {
  const lifecycle = params.lifecycle ?? {};
  const dealId = params.dealId?.trim() ?? "";
  const pipelineId = params.pipelineId?.trim() ?? "";
  const pipelineLabel = params.pipelineLabel?.trim() ?? "";
  const stageLabel = params.stageLabel?.trim().toLowerCase() ?? "";

  // 1. Explicit per-deal override (highest precedence, fully deterministic).
  if (dealId && lifecycle.deal_overrides?.[dealId]) {
    return lifecycle.deal_overrides[dealId];
  }

  // 2. Stage-level overrides (e.g. Portfolio pipeline + "pre-renewal" stage).
  if (pipelineId && stageLabel && lifecycle.stage_overrides) {
    for (const override of lifecycle.stage_overrides) {
      if (
        override.pipelineId === pipelineId &&
        stageLabel.includes(override.stageContains)
      ) {
        return override.motion;
      }
    }
  }

  // 3. Pipeline mapping.
  if (pipelineId && lifecycle.pipelines?.[pipelineId]) {
    return lifecycle.pipelines[pipelineId];
  }
  if (pipelineLabel && lifecycle.pipeline_labels?.[pipelineLabel]) {
    return lifecycle.pipeline_labels[pipelineLabel];
  }

  // 4. Genuine inbound signal: referral deal edge or a recognized inbound
  //    source. Sales-created sources (OFFLINE/DIRECT/SALES) do NOT count.
  if (
    params.hasReferralDealEdge ||
    isInboundSource(params.hsDealSource, lifecycle.inbound_source_patterns)
  ) {
    return "inbound";
  }

  // 5. Label heuristics as a fallback when no registry rule matched.
  const labelBlob = `${pipelineLabel} ${params.dealtype}`.toLowerCase();
  if (RENEWAL_LABEL.test(labelBlob)) {
    return "renewal";
  }
  if (EXPANSION_LABEL.test(labelBlob)) {
    return "outbound";
  }
  if (CS_LABEL.test(labelBlob)) {
    return "customer_success";
  }
  if (INBOUND_LABEL.test(labelBlob)) {
    return "inbound";
  }

  return lifecycle.default_motion ?? "outbound";
}

export function resetLifecycleCache(): void {
  lifecycleCache = undefined;
}
