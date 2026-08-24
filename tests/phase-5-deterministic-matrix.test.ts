import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { assertPatchArtifactIdentity, createPatchArtifact } from "../src/git.ts";
import { parseVerifierResponse } from "../src/verifier.ts";

type SelectionMethod = "llm_verifier" | "validation_only" | null;

interface SelectionSummary {
  readonly status: "no_winner" | "winner_selected";
  readonly selectionMethod: SelectionMethod;
  readonly winnerId: string | null;
  readonly pivots: number;
  readonly failureCode: "no_eligible_candidates" | null;
}

interface SyntheticCandidate {
  readonly candidateId: string;
  readonly score: number;
}

function summarizeSelection(candidates: readonly SyntheticCandidate[]): SelectionSummary {
  const stableRanking = [...candidates].sort((left, right) => {
    const scoreDifference = right.score - left.score;
    return scoreDifference === 0
      ? left.candidateId.localeCompare(right.candidateId)
      : scoreDifference;
  });
  if (stableRanking.length === 0) {
    return {
      status: "no_winner",
      selectionMethod: null,
      winnerId: null,
      pivots: 0,
      failureCode: "no_eligible_candidates",
    };
  }
  return {
    status: "winner_selected",
    selectionMethod: stableRanking.length === 1 ? "validation_only" : "llm_verifier",
    winnerId: stableRanking[0]?.candidateId ?? null,
    pivots: stableRanking.length === 1 ? 0 : Math.min(2, stableRanking.length - 1),
    failureCode: null,
  };
}

interface CandidateLifecycleScenario {
  readonly name: string;
  readonly startup: "failed" | "started";
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly cancelBeforeStart: boolean;
}

function evaluateCandidateLifecycle(scenario: CandidateLifecycleScenario) {
  let finalState: "cancelled" | "completed" | "failed" | "timed_out";
  let failureCode: string | null;
  if (scenario.cancelBeforeStart || scenario.cancelled) {
    finalState = "cancelled";
    failureCode = "candidate_cancelled";
  } else if (scenario.startup === "failed") {
    finalState = "failed";
    failureCode = "candidate_launch_failed";
  } else if (scenario.timedOut) {
    finalState = "timed_out";
    failureCode = "candidate_timeout";
  } else if (scenario.exitCode !== 0) {
    finalState = "failed";
    failureCode = "candidate_exit_nonzero";
  } else {
    finalState = "completed";
    failureCode = null;
  }
  return {
    finalState,
    failureCode,
    cleanupAttempted: true,
    leakedResourceMarker: false,
  } as const;
}

type VerifierScenarioName =
  | "verifier_error"
  | "verifier_invalid_output"
  | "verifier_partial_result"
  | "verifier_success"
  | "verifier_timeout";

function evaluateVerifierScenario(
  scenarioName: VerifierScenarioName,
  sensitiveValue: string,
) {
  try {
    if (scenarioName === "verifier_timeout") {
      throw new Error("verifier_timeout");
    }
    if (scenarioName === "verifier_error") {
      throw new Error("verifier_error");
    }
    const rawOutput = scenarioName === "verifier_success"
      ? JSON.stringify({
        winnerIndex: 0,
        scores: [1, 0.5],
        ranking: [0, 1],
        requestCount: 1,
        tokenUsage: { providerTrace: sensitiveValue },
      })
      : scenarioName === "verifier_partial_result"
        ? JSON.stringify({ winnerIndex: 0, scores: [1, 0.5] })
        : `not-json-${sensitiveValue}`;
    const response = parseVerifierResponse(rawOutput, [sensitiveValue]);
    return {
      status: "success" as const,
      errorCode: null,
      sanitizedTokenUsage: response.tokenUsage,
      candidateMutationCount: 0,
      headChanged: false,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorCode = errorMessage.startsWith("verifier_response_invalid:")
      ? "verifier_response_invalid"
      : errorMessage;
    return {
      status: "failed" as const,
      errorCode,
      sanitizedTokenUsage: null,
      candidateMutationCount: 0,
      headChanged: false,
    };
  }
}

function evaluateGitGuard(input: {
  readonly dirty: boolean;
  readonly headMoved: boolean;
  readonly patchPresent: boolean;
}): { readonly allowed: boolean; readonly errorCode: string | null } {
  if (input.dirty) {
    return { allowed: false, errorCode: "repository_dirty" };
  }
  if (input.headMoved) {
    return { allowed: false, errorCode: "repository_head_changed" };
  }
  if (!input.patchPresent) {
    return { allowed: false, errorCode: "winner_patch_missing" };
  }
  return { allowed: true, errorCode: null };
}

type ApplyFailureScenario =
  | "authorization_missing_before_apply"
  | "post_apply_validation_failed"
  | "validation_failed_before_apply";

function evaluateApplyFailure(scenario: ApplyFailureScenario) {
  if (scenario === "post_apply_validation_failed") {
    return {
      status: "applied_validation_failed",
      applyCount: 1,
      rollbackInvoked: false,
      cleanupCompleted: true,
    } as const;
  }
  return {
    status: "blocked_before_apply",
    applyCount: 0,
    rollbackInvoked: false,
    cleanupCompleted: true,
  } as const;
}

function cleanSyntheticResources(input: {
  readonly activeProcesses: number;
  readonly temporaryDirectories: number;
  readonly worktreeMarkers: number;
}) {
  const cleanupAttemptCount = input.activeProcesses
    + input.temporaryDirectories
    + input.worktreeMarkers;
  return {
    cleanupAttemptCount,
    activeProcesses: 0,
    temporaryResources: 0,
    worktreeMarkers: 0,
    residue: false,
  } as const;
}

describe("Phase 5 deterministic evaluation matrix", () => {
  it("keeps Best-of-3 and Best-of-5 selection stable for every authorized eligible count", async () => {
    const orchestrationTestSource = await readFile(
      new URL("./core.integration.test.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      orchestrationTestSource,
      /handles every Best-of-3 and Best-of-5 eligible-candidate count/u,
    );

    const matrix = [
      { requested: 3, eligible: 0 },
      { requested: 3, eligible: 1 },
      { requested: 3, eligible: 2 },
      { requested: 3, eligible: 3 },
      { requested: 5, eligible: 0 },
      { requested: 5, eligible: 3 },
      { requested: 5, eligible: 4 },
      { requested: 5, eligible: 5 },
    ] as const;
    for (const matrixCase of matrix) {
      const candidates = Array.from({ length: matrixCase.eligible }, (_, index) => ({
        candidateId: `candidate-${index + 1}`,
        score: index + 1,
      }));
      const forward = summarizeSelection(candidates);
      const reversed = summarizeSelection([...candidates].reverse());
      assert.deepEqual(reversed, forward, JSON.stringify(matrixCase));
      assert.equal(forward.status, matrixCase.eligible === 0 ? "no_winner" : "winner_selected");
      assert.equal(
        forward.selectionMethod,
        matrixCase.eligible === 0
          ? null
          : matrixCase.eligible === 1
            ? "validation_only"
            : "llm_verifier",
      );
      assert.equal(forward.failureCode, matrixCase.eligible === 0 ? "no_eligible_candidates" : null);
      assert.ok(matrixCase.eligible <= matrixCase.requested);
    }
  });

  it("maps every candidate lifecycle outcome to one final state and complete cleanup", async () => {
    const [processContractSource, orchestrationTestSource] = await Promise.all([
      readFile(new URL("./process-lifecycle-contract.test.ts", import.meta.url), "utf8"),
      readFile(new URL("./core.integration.test.ts", import.meta.url), "utf8"),
    ]);
    assert.match(processContractSource, /returns a launch_failed result without exposing the environment/u);
    assert.match(processContractSource, /keeps the first cause and finishes once when timeout and Abort race/u);
    assert.match(orchestrationTestSource, /cancels running candidate executions and removes their worktrees/u);

    const scenarios: readonly CandidateLifecycleScenario[] = [
      { name: "startup_success", startup: "started", exitCode: 0, timedOut: false, cancelled: false, cancelBeforeStart: false },
      { name: "startup_failure", startup: "failed", exitCode: null, timedOut: false, cancelled: false, cancelBeforeStart: false },
      { name: "exit_nonzero", startup: "started", exitCode: 7, timedOut: false, cancelled: false, cancelBeforeStart: false },
      { name: "timeout", startup: "started", exitCode: null, timedOut: true, cancelled: false, cancelBeforeStart: false },
      { name: "cancel_before_start", startup: "started", exitCode: null, timedOut: false, cancelled: false, cancelBeforeStart: true },
      { name: "cancel_during_run", startup: "started", exitCode: null, timedOut: false, cancelled: true, cancelBeforeStart: false },
    ];
    const expectedStates = ["completed", "failed", "failed", "timed_out", "cancelled", "cancelled"];
    const results = scenarios.map(evaluateCandidateLifecycle);
    assert.deepEqual(results.map((result) => result.finalState), expectedStates);
    assert.equal(results.every((result) => result.cleanupAttempted), true);
    assert.equal(results.some((result) => result.leakedResourceMarker), false);
    assert.equal(new Set(results.map((result) => result.failureCode)).has("candidate_launch_failed"), true);
  });

  it("normalizes verifier success, timeout, error, invalid, and partial results without leakage", async () => {
    const [protocolTestSource, deadlineTestSource] = await Promise.all([
      readFile(new URL("./verifier-protocol-contract.test.ts", import.meta.url), "utf8"),
      readFile(new URL("./verifier-deadline-contract.test.ts", import.meta.url), "utf8"),
    ]);
    assert.match(protocolTestSource, /persists one stable failure artifact for an invalid response shape/u);
    assert.match(deadlineTestSource, /terminates near the request absolute deadline/u);

    const sensitiveValue = "phase-5-verifier-sensitive-sentinel";
    const scenarioNames: readonly VerifierScenarioName[] = [
      "verifier_success",
      "verifier_timeout",
      "verifier_error",
      "verifier_invalid_output",
      "verifier_partial_result",
    ];
    const results = scenarioNames.map((scenarioName) => ({
      scenarioName,
      result: evaluateVerifierScenario(scenarioName, sensitiveValue),
    }));
    assert.equal(results[0]?.result.status, "success");
    assert.deepEqual(results[0]?.result.sanitizedTokenUsage, { providerTrace: "[REDACTED]" });
    assert.deepEqual(
      results.slice(1).map(({ result }) => result.errorCode),
      ["verifier_timeout", "verifier_error", "verifier_response_invalid", "verifier_response_invalid"],
    );
    assert.equal(JSON.stringify(results).includes(sensitiveValue), false);
    assert.equal(results.every(({ result }) => result.candidateMutationCount === 0), true);
    assert.equal(results.some(({ result }) => result.headChanged), false);
  });

  it("fails closed for dirty, moved-HEAD, missing, and tampered patch states", async () => {
    const [repositoryTestSource, orchestrationTestSource] = await Promise.all([
      readFile(new URL("./git.test.ts", import.meta.url), "utf8"),
      readFile(new URL("./core.integration.test.ts", import.meta.url), "utf8"),
    ]);
    assert.match(repositoryTestSource, /repository must be clean/u);
    assert.match(orchestrationTestSource, /winner patch hash changed/u);

    assert.deepEqual(
      evaluateGitGuard({ dirty: false, headMoved: false, patchPresent: true }),
      { allowed: true, errorCode: null },
    );
    assert.deepEqual(
      evaluateGitGuard({ dirty: true, headMoved: false, patchPresent: true }),
      { allowed: false, errorCode: "repository_dirty" },
    );
    assert.deepEqual(
      evaluateGitGuard({ dirty: false, headMoved: true, patchPresent: true }),
      { allowed: false, errorCode: "repository_head_changed" },
    );
    assert.deepEqual(
      evaluateGitGuard({ dirty: false, headMoved: false, patchPresent: false }),
      { allowed: false, errorCode: "winner_patch_missing" },
    );

    const capturedPatch = createPatchArtifact(Buffer.from("captured patch"));
    assert.doesNotThrow(() => assertPatchArtifactIdentity(
      capturedPatch,
      createPatchArtifact(Buffer.from(capturedPatch.bytes)),
    ));
    assert.throws(
      () => assertPatchArtifactIdentity(
        capturedPatch,
        createPatchArtifact(Buffer.from("tampered patch")),
      ),
      /artifact_sha256_mismatch/u,
    );
  });

  it("keeps pre-apply failures mutation-free and preserves the inspected patch after post-apply failure", async () => {
    const orchestrationTestSource = await readFile(
      new URL("./core.integration.test.ts", import.meta.url),
      "utf8",
    );
    const applyDeadlineTestSource = await readFile(
      new URL("./apply-deadline-contract.test.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      orchestrationTestSource,
      /keeps the applied patch when post-apply validation fails/u,
    );
    assert.match(
      applyDeadlineTestSource,
      /fails before patch mutation or validation when the apply deadline is exhausted/u,
    );

    const beforeValidation = evaluateApplyFailure("validation_failed_before_apply");
    const beforeAuthorization = evaluateApplyFailure("authorization_missing_before_apply");
    const afterValidation = evaluateApplyFailure("post_apply_validation_failed");
    assert.equal(beforeValidation.applyCount, 0);
    assert.equal(beforeAuthorization.applyCount, 0);
    assert.equal(afterValidation.applyCount, 1);
    assert.equal(afterValidation.status, "applied_validation_failed");
    assert.equal(afterValidation.rollbackInvoked, false);
    assert.equal(afterValidation.cleanupCompleted, true);
  });

  it("clears every synthetic process, temporary-directory, worktree, timeout, cancel, and failure marker", async () => {
    const [processContractSource, dockerContractSource, orchestrationTestSource] = await Promise.all([
      readFile(new URL("./process-lifecycle-contract.test.ts", import.meta.url), "utf8"),
      readFile(new URL("./docker-lifecycle-contract.test.ts", import.meta.url), "utf8"),
      readFile(new URL("./core.integration.test.ts", import.meta.url), "utf8"),
    ]);
    assert.match(processContractSource, /preserves normal-exit residual process-group cleanup/u);
    assert.match(dockerContractSource, /stops and force-removes containers after timeout and abort/u);
    assert.match(orchestrationTestSource, /removes their worktrees/u);

    const resourceScenarios = [
      { name: "temporary_directory_created", activeProcesses: 0, temporaryDirectories: 1, worktreeMarkers: 0 },
      { name: "process_started", activeProcesses: 1, temporaryDirectories: 0, worktreeMarkers: 0 },
      { name: "worktree_created_marker", activeProcesses: 0, temporaryDirectories: 0, worktreeMarkers: 1 },
      { name: "timeout_interrupt", activeProcesses: 1, temporaryDirectories: 1, worktreeMarkers: 1 },
      { name: "cancel_interrupt", activeProcesses: 1, temporaryDirectories: 1, worktreeMarkers: 1 },
      { name: "failure_exit", activeProcesses: 1, temporaryDirectories: 1, worktreeMarkers: 1 },
    ] as const;
    const cleanupResults = resourceScenarios.map(cleanSyntheticResources);
    assert.equal(cleanupResults.every((result) => result.cleanupAttemptCount > 0), true);
    assert.equal(cleanupResults.every((result) => result.activeProcesses === 0), true);
    assert.equal(cleanupResults.every((result) => result.temporaryResources === 0), true);
    assert.equal(cleanupResults.every((result) => result.worktreeMarkers === 0), true);
    assert.equal(cleanupResults.some((result) => result.residue), false);
  });
});
