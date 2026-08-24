import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const APPROVAL_TEMPLATE_URL = new URL(
  "../docs/acceptance/phase-5-external-approval-template.md",
  import.meta.url,
);
const EXTERNAL_PREFLIGHT_URL = new URL(
  "../docs/acceptance/phase-5-external-preflight.md",
  import.meta.url,
);

type ExperimentType =
  | "native-best-of-3"
  | "native-best-of-5"
  | "terminal-bench-best-of-5";

interface RequestEstimateInput {
  readonly experimentType: ExperimentType;
  readonly tasksCount: number;
  readonly verifierCount: number;
  readonly selectionCount: number;
  readonly benchmarkCases: number;
  readonly bridgeRequests: number;
  readonly directVerifierRequests: number;
  readonly retryAllowance: number;
}

interface TokenEstimateInput {
  readonly candidateRequests: number;
  readonly verifierRequests: number;
  readonly estimatedInputTokensPerCandidate: number;
  readonly estimatedOutputTokensPerCandidate: number;
  readonly verifierTokenEstimate: number;
  readonly retryAllowance: number;
  readonly hardTokenCeiling: number;
}

const REQUIRED_STOP_CONDITIONS = [
  "token ceiling exceeded",
  "cost limit exceeded",
  "unexpected credential usage detected",
  "request count exceeded",
  "benchmark artifact mismatch",
  "evidence hash mismatch",
] as const;

function requireNonNegative(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name}_invalid: ${value}`);
  }
}

function estimateRequests(input: RequestEstimateInput): {
  readonly baseRequests: number;
  readonly consistencyComparisonCount: number;
  readonly maxModelRequests: number;
} {
  for (const [name, value] of Object.entries(input)) {
    if (name !== "experimentType") {
      requireNonNegative(name, value as number);
    }
  }

  let baseRequests: number;
  let consistencyComparisonCount = 0;
  if (input.experimentType === "native-best-of-3") {
    baseRequests = input.tasksCount * (3 + input.verifierCount + input.selectionCount);
  } else if (input.experimentType === "native-best-of-5") {
    baseRequests = input.tasksCount * (5 + input.verifierCount + input.selectionCount);
  } else {
    baseRequests =
      (5 * input.benchmarkCases)
      + input.bridgeRequests
      + input.directVerifierRequests;
    consistencyComparisonCount = input.benchmarkCases;
  }

  return {
    baseRequests,
    consistencyComparisonCount,
    maxModelRequests: Math.ceil(baseRequests * (1 + input.retryAllowance)),
  };
}

function estimateTokenCeiling(input: TokenEstimateInput): {
  readonly baseTotalTokens: number;
  readonly tokenCeiling: number;
} {
  for (const [name, value] of Object.entries(input)) {
    requireNonNegative(name, value);
  }
  const candidateTokens = input.candidateRequests * (
    input.estimatedInputTokensPerCandidate
    + input.estimatedOutputTokensPerCandidate
  );
  const verifierTokens = input.verifierRequests * input.verifierTokenEstimate;
  const baseTotalTokens = candidateTokens + verifierTokens;
  const tokenCeiling = Math.ceil(baseTotalTokens * (1 + input.retryAllowance));
  if (tokenCeiling > input.hardTokenCeiling) {
    throw new Error(
      `hard_token_ceiling_too_low: estimated ${tokenCeiling}, configured ${input.hardTokenCeiling}`,
    );
  }
  return { baseTotalTokens, tokenCeiling };
}

function estimateCostCeiling(input: {
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly inputTokenPrice?: number;
  readonly outputTokenPrice?: number;
}): number | "COST_ESTIMATE_UNAVAILABLE" {
  if (input.inputTokenPrice === undefined || input.outputTokenPrice === undefined) {
    return "COST_ESTIMATE_UNAVAILABLE";
  }
  return (input.maxInputTokens * input.inputTokenPrice)
    + (input.maxOutputTokens * input.outputTokenPrice);
}

function externalExecutionDecision(input: {
  readonly approvalGranted: boolean;
  readonly credentialUsageAuthorized: boolean;
}): "AUTHORIZED" | "APPROVAL REQUIRED" | "CREDENTIAL AUTHORIZATION REQUIRED" {
  if (!input.approvalGranted) {
    return "APPROVAL REQUIRED";
  }
  if (!input.credentialUsageAuthorized) {
    return "CREDENTIAL AUTHORIZATION REQUIRED";
  }
  return "AUTHORIZED";
}

describe("Phase 5 external execution preflight contract", () => {
  it("freezes every required approval input and output field", async () => {
    const approvalTemplate = await readFile(APPROVAL_TEMPLATE_URL, "utf8");
    for (const requiredField of [
      "experimentType",
      "candidateCount",
      "tasksCount",
      "estimatedInputTokensPerCandidate",
      "estimatedOutputTokensPerCandidate",
      "verifierTokenEstimate",
      "retryAllowance",
      "failureRetryPolicy",
      "maxModelRequests",
      "maxInputTokens",
      "maxOutputTokens",
      "maxTotalTokens",
      "estimatedCostCeiling",
      "hardStopCondition",
      "approvalRequired=true",
    ]) {
      assert.match(approvalTemplate, new RegExp(requiredField, "u"));
    }
  });

  it("refuses external execution without approval and credential authorization", () => {
    assert.equal(
      externalExecutionDecision({ approvalGranted: false, credentialUsageAuthorized: false }),
      "APPROVAL REQUIRED",
    );
    assert.equal(
      externalExecutionDecision({ approvalGranted: true, credentialUsageAuthorized: false }),
      "CREDENTIAL AUTHORIZATION REQUIRED",
    );
  });

  it("estimates native and Terminal-Bench request ceilings deterministically", () => {
    const sharedInput = {
      tasksCount: 2,
      verifierCount: 1,
      selectionCount: 1,
      benchmarkCases: 5,
      bridgeRequests: 5,
      directVerifierRequests: 5,
      retryAllowance: 0.25,
    } as const;
    assert.deepEqual(
      estimateRequests({ ...sharedInput, experimentType: "native-best-of-3" }),
      { baseRequests: 10, consistencyComparisonCount: 0, maxModelRequests: 13 },
    );
    assert.deepEqual(
      estimateRequests({ ...sharedInput, experimentType: "native-best-of-5" }),
      { baseRequests: 14, consistencyComparisonCount: 0, maxModelRequests: 18 },
    );
    assert.deepEqual(
      estimateRequests({ ...sharedInput, experimentType: "terminal-bench-best-of-5" }),
      { baseRequests: 35, consistencyComparisonCount: 5, maxModelRequests: 44 },
    );
  });

  it("calculates one deterministic token ceiling and fails above the hard ceiling", () => {
    const estimateInput = {
      candidateRequests: 3,
      verifierRequests: 2,
      estimatedInputTokensPerCandidate: 100,
      estimatedOutputTokensPerCandidate: 50,
      verifierTokenEstimate: 25,
      retryAllowance: 0.2,
    } as const;
    assert.deepEqual(
      estimateTokenCeiling({ ...estimateInput, hardTokenCeiling: 600 }),
      { baseTotalTokens: 500, tokenCeiling: 600 },
    );
    assert.throws(
      () => estimateTokenCeiling({ ...estimateInput, hardTokenCeiling: 599 }),
      /hard_token_ceiling_too_low: estimated 600, configured 599/u,
    );
  });

  it("fails closed when either explicit price input is missing", () => {
    assert.equal(
      estimateCostCeiling({ maxInputTokens: 100, maxOutputTokens: 50 }),
      "COST_ESTIMATE_UNAVAILABLE",
    );
    assert.equal(
      estimateCostCeiling({
        maxInputTokens: 100,
        maxOutputTokens: 50,
        inputTokenPrice: 1,
        outputTokenPrice: 2,
      }),
      200,
    );
  });

  it("freezes the complete hard-stop set", async () => {
    const approvalTemplate = await readFile(APPROVAL_TEMPLATE_URL, "utf8");
    for (const stopCondition of REQUIRED_STOP_CONDITIONS) {
      assert.match(approvalTemplate, new RegExp(stopCondition, "u"));
    }
  });

  it("keeps Hosted CI untriggered and remote state unchanged by default", async () => {
    const preflight = await readFile(EXTERNAL_PREFLIGHT_URL, "utf8");
    assert.match(preflight, /workflowExpected=true/u);
    assert.match(preflight, /triggered=false/u);
    assert.match(preflight, /remoteMutation=false/u);
    assert.match(preflight, /credentialProvided=false/u);
    assert.match(preflight, /runId=null/u);
    assert.match(preflight, /commitSha=ce06d928d495b865920aa0b24907a3b8d3ead669/u);
  });

  it("contains no fabricated hosted, model, benchmark, or image evidence", async () => {
    const documents = (await Promise.all([
      readFile(APPROVAL_TEMPLATE_URL, "utf8"),
      readFile(EXTERNAL_PREFLIGHT_URL, "utf8"),
    ])).join("\n");
    assert.doesNotMatch(documents, /Hosted (?:CI|workflow)[^\n]*(?:SUCCESS|SUCCEEDED)/iu);
    assert.doesNotMatch(documents, /runId\s*[=:|]\s*[1-9][0-9]*/u);
    assert.doesNotMatch(documents, /imageDigest[^\n]*sha256:[0-9a-f]{64}/u);
    assert.doesNotMatch(documents, /(?:benchmark|model)[^\n]*score\s*[=:|]\s*[-+0-9.]+/iu);
  });
});
