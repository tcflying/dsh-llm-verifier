import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RuntimeConfig } from "../src/config.ts";
import { createApprovalReason } from "../src/core.ts";

function runtimeConfig(runTimeoutMs: number): RuntimeConfig {
  return {
    candidateProfile: "headless",
    credentialRef: "DEEPSEEK_API_KEY",
    verifierModel: "deepseek-v4-flash",
    nEvaluations: 2,
    maxVerifierWorkers: 8,
    verifierEffort: "high",
    verifierMaxTokens: 32_768,
    candidateTimeoutMs: 10_000,
    validationTimeoutMs: 5_000,
    runTimeoutMs,
    maxVerifierTraceBytes: 512 * 1_024,
    stateDirectory: "/tmp/dsh-approval-contract-state",
    dshExecutable: "/container/dsh",
  };
}

function approvalReason(runTimeoutMs: number): string {
  return createApprovalReason(
    {
      repositoryPath: "/tmp/dsh-approval-contract-repository",
      baseCommit: "a".repeat(40),
    },
    3,
    ["pnpm test"],
    runtimeConfig(runTimeoutMs),
  );
}

describe("approval deadline visibility contract", () => {
  it("shows the total budget and the shared deadline policy before approval", () => {
    const reason = approvalReason(30_000);
    assert.match(
      reason,
      /Total run deadline budget after approval and credential resolution: 30000 ms\./u,
    );
    assert.match(reason, /Candidate time policy:.*remaining shared run budget/u);
    assert.match(reason, /Validation time policy:.*remaining shared run budget/u);
    assert.match(reason, /Verifier time policy:.*remaining shared run budget/u);
    assert.match(reason, /Cleanup grace policy:.*unavailable/u);
  });

  it("describes stage limits as caps instead of fixed allocations", () => {
    const reason = approvalReason(30_000);
    assert.match(reason, /Candidate time policy: each candidate is capped at 10000 ms/u);
    assert.match(reason, /Validation time policy: each validation command is capped at 5000 ms/u);
    assert.doesNotMatch(reason, /(?:candidate|validation) exactly \d+ ms/iu);
    assert.match(reason, /Verifier time policy:.*does not receive a fresh full timeout/u);
  });

  it("updates the approval text when the configured run deadline changes", () => {
    const thirtySecondReason = approvalReason(30_000);
    const fortyFiveSecondReason = approvalReason(45_000);
    assert.match(thirtySecondReason, /deadline budget.*30000 ms/u);
    assert.doesNotMatch(thirtySecondReason, /deadline budget.*45000 ms/u);
    assert.match(fortyFiveSecondReason, /deadline budget.*45000 ms/u);
    assert.doesNotMatch(fortyFiveSecondReason, /deadline budget.*30000 ms/u);
  });
});
