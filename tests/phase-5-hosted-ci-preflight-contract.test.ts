import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const HOSTED_CI_PREFLIGHT_URL = new URL(
  "../docs/acceptance/phase-5-hosted-ci-preflight.md",
  import.meta.url,
);

type HostedCiState =
  | "LOCAL_PREPARED"
  | "APPROVAL_REQUIRED"
  | "HOSTED_EXECUTION_ALLOWED";

interface HostedCiEvidence {
  readonly workflowName: string | null;
  readonly runId: string | null;
  readonly commitSha: string;
  readonly runnerOS: string;
  readonly nodeVersion: string;
  readonly pythonVersion: string;
  readonly dependencyInstallMode: string;
  readonly testCommand: string | null;
  readonly result: "NOT_EXECUTED" | "SUCCESS" | "FAILURE";
  readonly artifactHashes: readonly string[] | null;
  readonly duration: number | null;
  readonly cleanupStatus: "NOT_EXECUTED" | "COMPLETE" | "FAILED";
  readonly credentialUsage: "NOT AUTHORIZED" | "NONE";
}

const EXPECTED_COMMIT_SHA = "ce06d928d495b865920aa0b24907a3b8d3ead669";

function triggerDecision(input: {
  readonly state: HostedCiState;
  readonly approvalGranted: boolean;
}): "HOSTED_EXECUTION_ALLOWED" | "HOSTED_CI_NOT_AUTHORIZED" {
  if (input.state !== "APPROVAL_REQUIRED" || !input.approvalGranted) {
    return "HOSTED_CI_NOT_AUTHORIZED";
  }
  return "HOSTED_EXECUTION_ALLOWED";
}

function validatePreExecutionEvidence(evidence: HostedCiEvidence): void {
  if (evidence.runId !== null) {
    throw new Error(`hosted_run_id_before_execution: ${evidence.runId}`);
  }
  if (evidence.result !== "NOT_EXECUTED") {
    throw new Error(`hosted_result_before_execution: ${evidence.result}`);
  }
  if (evidence.artifactHashes !== null) {
    throw new Error(`hosted_artifacts_before_execution: ${evidence.artifactHashes.length}`);
  }
  if (evidence.cleanupStatus !== "NOT_EXECUTED") {
    throw new Error(`hosted_cleanup_before_execution: ${evidence.cleanupStatus}`);
  }
}

function unexecutedEvidence(): HostedCiEvidence {
  return {
    workflowName: null,
    runId: null,
    commitSha: EXPECTED_COMMIT_SHA,
    runnerOS: "UNKNOWN",
    nodeVersion: "UNKNOWN",
    pythonVersion: "UNKNOWN",
    dependencyInstallMode: "UNKNOWN",
    testCommand: null,
    result: "NOT_EXECUTED",
    artifactHashes: null,
    duration: null,
    cleanupStatus: "NOT_EXECUTED",
    credentialUsage: "NOT AUTHORIZED",
  };
}

describe("Phase 5 Hosted CI preflight contract", () => {
  it("keeps the default Hosted CI state approval-gated", async () => {
    const preflight = await readFile(HOSTED_CI_PREFLIGHT_URL, "utf8");
    assert.match(preflight, /^Status: APPROVAL_REQUIRED$/mu);
    assert.match(preflight, /workflowConfigured=expected/u);
    assert.match(preflight, /workflowTriggered=false/u);
    assert.match(preflight, /credentialProvided=false/u);
  });

  it("rejects every trigger intent without explicit approval", () => {
    assert.equal(
      triggerDecision({ state: "LOCAL_PREPARED", approvalGranted: false }),
      "HOSTED_CI_NOT_AUTHORIZED",
    );
    assert.equal(
      triggerDecision({ state: "APPROVAL_REQUIRED", approvalGranted: false }),
      "HOSTED_CI_NOT_AUTHORIZED",
    );
  });

  it("does not generate a run identifier before execution", async () => {
    const preflight = await readFile(HOSTED_CI_PREFLIGHT_URL, "utf8");
    assert.match(preflight, /runId=null/u);
    assert.match(preflight, /runUrl=null/u);
    assert.equal(unexecutedEvidence().runId, null);
  });

  it("rejects fabricated success evidence before a hosted run", () => {
    const fabricatedSuccess: HostedCiEvidence = {
      ...unexecutedEvidence(),
      result: "SUCCESS",
    };
    assert.throws(
      () => validatePreExecutionEvidence(fabricatedSuccess),
      /hosted_result_before_execution: SUCCESS/u,
    );
  });

  it("freezes remote mutation and artifact state as absent", async () => {
    const preflight = await readFile(HOSTED_CI_PREFLIGHT_URL, "utf8");
    assert.match(preflight, /remoteMutation=false/u);
    assert.match(preflight, /artifactDigest=null/u);
    assert.equal(unexecutedEvidence().artifactHashes, null);
  });

  it("keeps the complete future evidence schema unexecuted", async () => {
    const preflight = await readFile(HOSTED_CI_PREFLIGHT_URL, "utf8");
    for (const evidenceField of [
      "workflowName",
      "runId",
      "commitSha",
      "runnerOS",
      "nodeVersion",
      "pythonVersion",
      "dependencyInstallMode",
      "testCommand",
      "result",
      "artifactHashes",
      "duration",
      "cleanupStatus",
      "credentialUsage",
    ]) {
      assert.match(preflight, new RegExp(`\\| \`${evidenceField}\` \\|`, "u"));
    }
    assert.doesNotThrow(() => validatePreExecutionEvidence(unexecutedEvidence()));
    assert.doesNotMatch(preflight, /runId[^\n]*[1-9][0-9]+/u);
    assert.doesNotMatch(preflight, /https:\/\/github\.com\/[^\s]+\/actions\/runs\//u);
    assert.doesNotMatch(preflight, /artifactDigest[^\n]*sha256:[0-9a-f]{64}/u);
  });
});
