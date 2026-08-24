import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const EVIDENCE_CONTRACT_URL = new URL(
  "../docs/acceptance/phase-5-external-evidence-contract.md",
  import.meta.url,
);

type EvidenceBundle = Record<string, unknown>;

async function readEvidenceContract(): Promise<{
  document: string;
  bundle: EvidenceBundle;
}> {
  const document = await readFile(EVIDENCE_CONTRACT_URL, "utf8");
  const jsonBlock = document.match(/```json\n([\s\S]+?)\n```/u)?.[1];
  assert.ok(jsonBlock, "external evidence contract must contain one JSON envelope");
  return { document, bundle: JSON.parse(jsonBlock) as EvidenceBundle };
}

function cloneBundle(bundle: EvidenceBundle): EvidenceBundle {
  return structuredClone(bundle);
}

function validatePendingBundle(bundle: EvidenceBundle): void {
  const authorization = bundle.authorizationRecord as Record<string, unknown>;
  const workflow = bundle.workflowEvidence as Record<string, unknown>;
  const model = bundle.modelEvidence as Record<string, unknown>;
  const benchmark = bundle.benchmarkEvidence as Record<string, unknown>;
  const artifacts = bundle.artifactEvidence as Record<string, unknown>;

  if (authorization.status !== "APPROVAL_REQUIRED") {
    throw new Error(`unexpected authorization status: ${String(authorization.status)}`);
  }
  if (
    workflow.status !== "NOT_EXECUTED" ||
    model.status !== "NOT_EXECUTED" ||
    benchmark.status !== "NOT_EXECUTED"
  ) {
    throw new Error("external evidence cannot claim execution before approval");
  }
  if (
    artifacts.bundleHash !== null ||
    artifacts.manifestHash !== null ||
    (artifacts.externalArtifacts as unknown[]).length !== 0
  ) {
    throw new Error("external artifact evidence must be absent before execution");
  }
  if (bundle.finalDecision !== "EXTERNAL_EXECUTION_PENDING") {
    throw new Error(`unauthorized final decision: ${String(bundle.finalDecision)}`);
  }
}

describe("Phase 5 external execution evidence bundle contract", () => {
  it("freezes the complete evidence envelope schema", async () => {
    const { bundle } = await readEvidenceContract();
    assert.deepEqual(Object.keys(bundle), [
      "executionType",
      "authorizationRecord",
      "requestBudget",
      "tokenCeiling",
      "costLimit",
      "credentialDeclaration",
      "environment",
      "sourceCommit",
      "workflowEvidence",
      "modelEvidence",
      "benchmarkEvidence",
      "artifactEvidence",
      "cleanupEvidence",
      "finalDecision",
    ]);
  });

  it("keeps Hosted CI evidence unexecuted and unguessed", async () => {
    const { bundle } = await readEvidenceContract();
    const workflow = bundle.workflowEvidence as Record<string, unknown>;
    assert.equal(workflow.status, "NOT_EXECUTED");
    assert.equal(workflow.workflowName, "NOT_EXECUTED");
    assert.equal(workflow.runId, null);
    assert.equal(workflow.runUrl, null);
    assert.equal(workflow.triggerTime, null);
    assert.equal(workflow.runnerOS, "UNKNOWN");
    assert.equal(workflow.nodeVersion, "UNKNOWN");
    assert.equal(workflow.pythonVersion, "UNKNOWN");
    assert.equal(workflow.commitSha, null);
    assert.equal(workflow.workflowStatus, "NOT_EXECUTED");
    assert.deepEqual(workflow.artifactHashes, []);
    assert.equal(workflow.logsDigest, null);
  });

  it("separates unexecuted native candidate, verification, and ranking evidence", async () => {
    const { bundle } = await readEvidenceContract();
    const model = bundle.modelEvidence as Record<string, unknown>;
    assert.equal(model.status, "NOT_EXECUTED");
    assert.deepEqual(model.candidateGeneration, {
      candidateCount: 0,
      candidateRequestCount: 0,
      candidateSuccessCount: 0,
      candidateFailureCount: 0,
    });
    assert.deepEqual(model.verification, {
      verificationCount: 0,
      validationFailures: 0,
      timeoutCount: 0,
      cancelCount: 0,
    });
    assert.deepEqual(model.ranking, {
      eligibleCount: 0,
      verifierResultDigest: null,
      winnerSelectionEvidence: null,
    });
  });

  it("keeps Terminal-Bench evidence unexecuted without a synthetic score", async () => {
    const { bundle, document } = await readEvidenceContract();
    const benchmark = bundle.benchmarkEvidence as Record<string, unknown>;
    assert.deepEqual(benchmark, {
      status: "NOT_EXECUTED",
      benchmarkVersion: null,
      taskSetIdentity: null,
      candidateBundleHash: null,
      bridgeSelectionDigest: null,
      directSelectionDigest: null,
      comparisonResult: "NOT_EXECUTED",
      consistencyStatus: "UNKNOWN",
    });
    assert.match(document, /placeholder score, synthetic pass/u);
  });

  it("rejects fabricated artifact evidence before execution", async () => {
    const { bundle } = await readEvidenceContract();
    const fabricated = cloneBundle(bundle);
    const artifacts = fabricated.artifactEvidence as Record<string, unknown>;
    artifacts.bundleHash = "sha256:placeholder";
    assert.throws(
      () => validatePendingBundle(fabricated),
      /external artifact evidence must be absent before execution/u,
    );
  });

  it("rejects fabricated external success before approval", async () => {
    const { bundle } = await readEvidenceContract();
    const fabricated = cloneBundle(bundle);
    const workflow = fabricated.workflowEvidence as Record<string, unknown>;
    workflow.status = "SUCCESS";
    assert.throws(
      () => validatePendingBundle(fabricated),
      /cannot claim execution before approval/u,
    );
  });

  it("rejects an unauthorized final-decision upgrade", async () => {
    const { bundle } = await readEvidenceContract();
    for (const forbiddenDecision of ["RELEASE_READY", "BENCHMARK_VALIDATED"]) {
      const upgraded = cloneBundle(bundle);
      upgraded.finalDecision = forbiddenDecision;
      assert.throws(
        () => validatePendingBundle(upgraded),
        new RegExp(`unauthorized final decision: ${forbiddenDecision}`, "u"),
      );
    }
  });

  it("preserves approval gates, zero cost, and absent credential authority", async () => {
    const { bundle, document } = await readEvidenceContract();
    validatePendingBundle(bundle);
    assert.deepEqual(bundle.costLimit, {
      currency: "USD",
      maximumCost: 0,
      actualCost: 0,
    });
    assert.deepEqual(bundle.credentialDeclaration, {
      status: "NOT_AUTHORIZED",
      credentialName: null,
      credentialValueRecorded: false,
    });
    for (const gate of [
      "Hosted CI",
      "Native Best-of-3",
      "Native Best-of-5",
      "Terminal-Bench",
    ]) {
      assert.match(document, new RegExp(`- ${gate}: APPROVAL REQUIRED`, "u"));
    }
  });
});
