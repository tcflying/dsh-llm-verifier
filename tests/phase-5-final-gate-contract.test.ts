import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const ACCEPTANCE_URL = new URL("../docs/acceptance/phase-5.md", import.meta.url);
const FINAL_GATE_URL = new URL(
  "../docs/acceptance/phase-5-final-gate.md",
  import.meta.url,
);
const SECURITY_REPORT_URL = new URL(
  "../docs/acceptance/phase-5-security-report.md",
  import.meta.url,
);

async function readFinalGateDocuments(): Promise<{
  readonly acceptance: string;
  readonly finalGate: string;
  readonly securityReport: string;
}> {
  const [acceptance, finalGate, securityReport] = await Promise.all([
    readFile(ACCEPTANCE_URL, "utf8"),
    readFile(FINAL_GATE_URL, "utf8"),
    readFile(SECURITY_REPORT_URL, "utf8"),
  ]);
  return { acceptance, finalGate, securityReport };
}

describe("Phase 5 final gate contract", () => {
  it("covers the complete local scope without a premature completion claim", async () => {
    const { acceptance } = await readFinalGateDocuments();
    for (const requiredScope of [
      "CI baseline",
      "Deterministic matrix",
      "Security/privacy",
      "Documentation",
      "Hosted CI",
      "APPROVAL REQUIRED",
    ]) {
      assert.match(acceptance, new RegExp(requiredScope, "u"));
    }
    assert.doesNotMatch(acceptance, /\bPhase 5 complete\b/iu);
    assert.doesNotMatch(acceptance, /\bproduction ready\b/iu);
    assert.doesNotMatch(acceptance, /\bexternally validated\b/iu);
  });

  it("uses one consistent allowed status for each final external item", async () => {
    const { finalGate } = await readFinalGateDocuments();
    const expectedStatusLines = [
      "Hosted CI run — NOT EXECUTED",
      "Real native Best-of-N — APPROVAL REQUIRED",
      "Terminal-Bench bridge — APPROVAL REQUIRED",
    ] as const;
    for (const expectedStatusLine of expectedStatusLines) {
      assert.equal(finalGate.split(expectedStatusLine).length - 1, 1);
    }
    assert.doesNotMatch(
      finalGate,
      /(?:Hosted CI|Best-of-N|Terminal-Bench)[^\n]*(?:NOT EXECUTED|APPROVAL REQUIRED)[^\n]*\bPASS\b/iu,
    );
    assert.doesNotMatch(
      finalGate,
      /(?:Hosted CI|Best-of-N|Terminal-Bench)[^\n]*\bPASS\b[^\n]*(?:NOT EXECUTED|APPROVAL REQUIRED)/iu,
    );
  });

  it("keeps real evaluation at the explicit zero-cost approval gate", async () => {
    const { acceptance } = await readFinalGateDocuments();
    for (const gateLine of [
      "DeepSeek requests: 0",
      "Native Best-of-N executions: 0",
      "Terminal-Bench executions: 0",
      "Cost: 0",
      "Status: approval required",
    ]) {
      assert.match(acceptance, new RegExp(gateLine, "u"));
    }
  });

  it("keeps worktree, container, and model-data isolation claims bounded", async () => {
    const { acceptance } = await readFinalGateDocuments();
    for (const boundary of ["Git worktree", "Docker/container", "model execution data"]) {
      assert.match(acceptance, new RegExp(boundary.replace("/", "\\/"), "u"));
    }
    assert.match(acceptance, /cannot prove model quality/u);
    assert.match(acceptance, /require evaluation approval/u);
  });

  it("freezes runtime, test, cleanup, privacy, and image evidence", async () => {
    const { finalGate } = await readFinalGateDocuments();
    for (const runtimeVersion of [
      "Node 24.14.0",
      "pnpm 11.7.0",
      "uv 0.11.6",
      "Python 3.13.13",
      "DeepSeek Harness 0.1.0-rc.7",
    ]) {
      assert.match(finalGate, new RegExp(runtimeVersion, "u"));
    }
    assert.match(finalGate, /160\/160 local tests passed/u);
    assert.match(finalGate, /cleanup completed with no resource residue/u);
    assert.match(finalGate, /no credential values accessed/u);
    assert.match(finalGate, /no model responses collected/u);
    assert.match(finalGate, /no external data uploaded/u);
    assert.match(finalGate, /`imageDigest: N\/A` because no evaluation image ran/u);
  });

  it("contains no fabricated external model, benchmark, image, or hosted-CI result", async () => {
    const documents = Object.values(await readFinalGateDocuments()).join("\n");
    assert.doesNotMatch(documents, /(?:benchmark|Terminal-Bench)[^\n]*(?:score|result)\s*[:=|]\s*\d/iu);
    assert.doesNotMatch(documents, /model response sample\s*[:=]/iu);
    assert.doesNotMatch(documents, /imageDigest[^\n]*sha256:[0-9a-f]{64}/u);
    assert.doesNotMatch(documents, /Hosted (?:CI|workflow)[^\n]*(?:PASS|SUCCESS|SUCCEEDED)/iu);
  });
});
