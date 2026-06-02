import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  DEFAULT_HERMES_INNER,
  HERMES_BRIEF_END,
  HERMES_BRIEF_START,
  composeBriefCallout,
  extractHermesBrief,
} from "./summary.js";

/**
 * GOLDEN CROSS-SYSTEM CONTRACT (H1).
 *
 * `tool-gtm-hubspot/src/vault/summary.ts` and
 * `tool-gtm-gong/src/vault/brief-summary.ts` carry byte-identical copies of the
 * Hermes/GBrain wire contract (markers, default placeholder, region pattern,
 * extract/compose). Hermes/GBrain targets these markers in notes from BOTH
 * tools, so byte-identity is load-bearing: if either repo drifts, enrichment
 * silently breaks vault-wide.
 *
 * The repos are independent npm packages (no monorepo / shared `@gtm/*`
 * package), so instead of cross-repo publishing infra this identical test lives
 * in each repo. Any drift in the marker bytes, the default placeholder, or the
 * compose→extract round-trip fails CI on the side that drifted. Keep this file
 * and its fixture in lockstep with the Gong sibling.
 */

// The exact wire bytes. These literals are duplicated (not imported) on purpose:
// the test pins the contract independently of the module under test, so a typo
// in the source constant is caught rather than mirrored.
const EXPECTED_START = "%%gtm:brief:hermes:start%%";
const EXPECTED_END = "%%gtm:brief:hermes:end%%";
const EXPECTED_DEFAULT_INNER = "> _Narrative brief — pending Hermes/GBrain enrichment._";

const fixtureUrl = new URL("./__fixtures__/brief-contract.fixture.md", import.meta.url);

const EXPECTED_FIXTURE_INNER = [
  "> Acme is a mid-market logistics platform evaluating a replacement for their legacy TMS.",
  ">",
  "> Champion is the VP Ops; primary risk is a competing incumbent renewal in Q3.",
].join("\n");

test("contract: marker + default placeholder bytes are exactly as Hermes/GBrain expects", () => {
  assert.equal(HERMES_BRIEF_START, EXPECTED_START);
  assert.equal(HERMES_BRIEF_END, EXPECTED_END);
  assert.equal(DEFAULT_HERMES_INNER, EXPECTED_DEFAULT_INNER);
});

test("contract: extract pulls the verbatim multi-line, blank-line narrative from a real note", async () => {
  const note = await readFile(fileURLToPath(fixtureUrl), "utf8");
  const extracted = extractHermesBrief(note);
  assert.equal(extracted, EXPECTED_FIXTURE_INNER);
});

test("contract: compose -> extract round-trips a >-quoted multi-line narrative verbatim", () => {
  const gist = "**Acme Corp** (acme.io) — 2 deals. $50,000 total pipeline.";
  const callout = composeBriefCallout(gist, EXPECTED_FIXTURE_INNER);

  // Markers survive composition and stay byte-identical.
  assert.ok(callout.includes(`> ${EXPECTED_START}`));
  assert.ok(callout.includes(`> ${EXPECTED_END}`));

  // The narrative (including its embedded blank `>` line) re-extracts verbatim.
  assert.equal(extractHermesBrief(callout), EXPECTED_FIXTURE_INNER);
});

test("contract: an empty captured region restores the placeholder (M1)", () => {
  // Hermes cleared the narrative, leaving a blank region between the markers.
  const cleared = [
    "> [!summary] Brief",
    "> **Acme Corp** (acme.io) — 2 deals.",
    ">",
    `> ${EXPECTED_START}`,
    "",
    `> ${EXPECTED_END}`,
  ].join("\n");

  // A blank region is "no narrative", not an empty one.
  assert.equal(extractHermesBrief(cleared), null);

  // Re-composing with the absent narrative restores the default placeholder
  // verbatim, and that placeholder is itself still treated as "absent".
  const restored = composeBriefCallout("**Acme Corp** (acme.io) — 2 deals.", null);
  assert.ok(restored.includes(DEFAULT_HERMES_INNER));
  assert.equal(extractHermesBrief(restored), null);
});

test("contract: a newline-laden gist cannot break the callout or eject markers (M3)", () => {
  const dirtyGist = "**Acme\nCorp**\t— 2 deals.\r\nmulti-line CRM value";
  const callout = composeBriefCallout(dirtyGist, EXPECTED_FIXTURE_INNER);

  // The gist line is a single `>`-quoted line (no raw newline leaked in).
  const gistLine = callout.split("\n")[1];
  assert.equal(gistLine, "> **Acme Corp** — 2 deals. multi-line CRM value");

  // Markers stay inside the callout and the narrative still round-trips.
  assert.ok(callout.includes(`> ${EXPECTED_START}`));
  assert.equal(extractHermesBrief(callout), EXPECTED_FIXTURE_INNER);
});
