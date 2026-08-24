import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import type { DockerRuntimeConfig, RuntimeConfig } from "../src/config.ts";
import type { RuntimeDependencies, VerifierRequest } from "../src/contracts.ts";
import {
  remainingMs,
  RunDeadlineExceededError,
  runVerifiedBestOf,
} from "../src/core.ts";
import type { DockerExecutionRequest, DockerExecutionResult } from "../src/docker.ts";

const execFileAsync = promisify(execFile);
const DOCKER_CONFIG: DockerRuntimeConfig = {
  image: "registry.test/dsh-runtime:0.1.0",
  digest: `sha256:${"b".repeat(64)}`,
  cpus: 1,
  memory: "1g",
  pidsLimit: 128,
  network: "none",
};

interface DeadlineScenario {
  readonly candidateRequests: DockerExecutionRequest[];
  readonly validationRequests: DockerExecutionRequest[];
  readonly verifierRequests: VerifierRequest[];
  readonly resultStatus: string;
}

async function createCleanRepository(repositoryPath: string): Promise<void> {
  await mkdir(repositoryPath, { recursive: true });
  await execFileAsync("git", ["init", "--quiet", repositoryPath]);
  await execFileAsync("git", ["config", "user.email", "tests@example.invalid"], {
    cwd: repositoryPath,
  });
  await execFileAsync("git", ["config", "user.name", "Verifier Tests"], {
    cwd: repositoryPath,
  });
  await writeFile(join(repositoryPath, "README.md"), "fixture\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: repositoryPath });
  await execFileAsync("git", ["commit", "--quiet", "-m", "fixture"], {
    cwd: repositoryPath,
  });
}

function runtimeConfig(stateDirectory: string, runTimeoutMs: number): RuntimeConfig {
  return {
    candidateProfile: "headless",
    credentialRef: "DEEPSEEK_API_KEY",
    verifierModel: "deepseek-v4-flash",
    nEvaluations: 2,
    maxVerifierWorkers: 8,
    verifierEffort: "high",
    verifierMaxTokens: 32_768,
    candidateTimeoutMs: 5_000,
    validationTimeoutMs: 5_000,
    runTimeoutMs,
    maxVerifierTraceBytes: 512 * 1_024,
    stateDirectory,
    dshExecutable: "/container/dsh",
    docker: DOCKER_CONFIG,
  };
}

function dockerResult(request: DockerExecutionRequest): DockerExecutionResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: `${request.executionKind} completed\n`,
    stderr: "",
    timedOut: false,
    aborted: false,
    outputLimitExceeded: false,
    residualProcessGroupDetected: false,
    residualProcessGroupRemaining: false,
    terminationReason: "completed",
    drainCompleted: true,
    drainTimedOut: false,
    finishedAt: Date.now(),
    containerId: request.containerName,
    durationMs: 1,
  };
}

async function runDeadlineScenario(
  runTimeoutMs: number,
  candidateDelayMs: number,
): Promise<DeadlineScenario> {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-core-deadline-"));
  const repositoryPath = join(fixtureRoot, "repository");
  const stateDirectory = join(fixtureRoot, "state");
  await createCleanRepository(repositoryPath);
  const candidateRequests: DockerExecutionRequest[] = [];
  const validationRequests: DockerExecutionRequest[] = [];
  const verifierRequests: VerifierRequest[] = [];
  const dependencies: RuntimeDependencies = {
    requestApproval: async () => undefined,
    resolveCredential: async () => "synthetic-deadline-credential",
    dockerExecutor: {
      preflight: async (config) => ({
        daemonVersion: "test-daemon",
        imageReference: `${config.image}@${config.digest}`,
      }),
      run: async (request) => {
        if (request.executionKind === "candidate") {
          candidateRequests.push(request);
          await delay(candidateDelayMs);
          await writeFile(join(request.workspacePath, "result.txt"), "candidate\n");
        } else {
          validationRequests.push(request);
          await access(join(request.workspacePath, "result.txt"));
        }
        return dockerResult(request);
      },
    },
    runVerifier: async (request) => {
      const observedRemainingMs = remainingMs(request.deadlineAt, Date.now());
      assert.ok(request.timeoutMs >= observedRemainingMs);
      assert.ok(request.timeoutMs - observedRemainingMs < 100);
      verifierRequests.push(request);
      return {
        winnerIndex: 0,
        scores: request.candidates.map((_, index) => request.candidates.length - index),
        ranking: request.candidates.map((_, index) => index),
        requestCount: 1,
        tokenUsage: { calls: 1 },
      };
    },
  };

  try {
    const result = await runVerifiedBestOf(
      {
        task: "Create result.txt",
        candidateCount: 3,
        validationCommands: ["test -f result.txt"],
        repositoryPath,
      },
      runtimeConfig(stateDirectory, runTimeoutMs),
      dependencies,
    );
    return {
      candidateRequests,
      validationRequests,
      verifierRequests,
      resultStatus: result.status,
    };
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

describe("core absolute deadline contract", () => {
  it("computes exact remaining budget and fails fast after the deadline", () => {
    assert.equal(remainingMs(1_000, 400), 600);
    assert.throws(
      () => remainingMs(1_000, 1_000),
      (error: unknown) => {
        assert.ok(error instanceof RunDeadlineExceededError);
        assert.equal(error.code, "deadline_exceeded");
        assert.match(error.message, /deadlineAt=1000, now=1000/u);
        return true;
      },
    );
  });

  it("gives validation only the budget left after candidate execution", async () => {
    const scenario = await runDeadlineScenario(2_000, 400);
    assert.equal(scenario.resultStatus, "winner_selected");
    assert.equal(scenario.candidateRequests.length, 3);
    assert.equal(scenario.validationRequests.length, 3);
    const smallestCandidateBudget = Math.min(
      ...scenario.candidateRequests.map((request) => request.timeoutMs),
    );
    const largestValidationBudget = Math.max(
      ...scenario.validationRequests.map((request) => request.timeoutMs),
    );
    assert.ok(smallestCandidateBudget < 2_000);
    assert.ok(largestValidationBudget < smallestCandidateBudget - 300);
    assert.ok(largestValidationBudget > 0);
  });

  it("shares one deadline across concurrent candidates", async () => {
    const scenario = await runDeadlineScenario(2_000, 50);
    assert.equal(scenario.candidateRequests.length, 3);
    const candidateBudgets = scenario.candidateRequests.map((request) => request.timeoutMs);
    assert.ok(Math.max(...candidateBudgets) - Math.min(...candidateBudgets) < 100);
    assert.ok(candidateBudgets.every((budgetMs) => budgetMs < 2_000 && budgetMs > 0));
  });

  it("does not start validation after the shared deadline expires", async () => {
    const scenario = await runDeadlineScenario(600, 700);
    assert.equal(scenario.candidateRequests.length, 3);
    assert.equal(scenario.validationRequests.length, 0);
    assert.equal(scenario.verifierRequests.length, 0);
    assert.equal(scenario.resultStatus, "failed");
  });

  it("propagates remaining budget to verifier instead of a fresh run timeout", async () => {
    const scenario = await runDeadlineScenario(2_000, 250);
    assert.equal(scenario.verifierRequests.length, 1);
    const verifierRequest = scenario.verifierRequests[0];
    assert.ok(verifierRequest !== undefined);
    assert.ok(verifierRequest.timeoutMs > 0);
    assert.ok(verifierRequest.timeoutMs < 2_000);
    assert.ok(verifierRequest.deadlineAt > verifierRequest.timeoutMs);
    assert.ok(verifierRequest.deadlineAt - Date.now() <= verifierRequest.timeoutMs);
  });
});
