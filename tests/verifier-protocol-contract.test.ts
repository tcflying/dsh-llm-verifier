import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import type { DockerRuntimeConfig, RuntimeConfig } from "../src/config.ts";
import type {
  DockerExecutor,
  VerifierRequest,
  VerifierResponse,
} from "../src/contracts.ts";
import { runVerifiedBestOf } from "../src/core.ts";
import type { DockerExecutionRequest, DockerExecutionResult } from "../src/docker.ts";
import type { ProcessResult } from "../src/process.ts";
import { parseVerifierResponse } from "../src/verifier.ts";

const execFileAsync = promisify(execFile);
const SYNTHETIC_CREDENTIAL = "verifier-protocol-secret";
const SYNTHETIC_DOCKER_CONFIG: DockerRuntimeConfig = {
  image: "registry.test/dsh-runtime:0.1.0",
  digest: `sha256:${"c".repeat(64)}`,
  cpus: 1,
  memory: "1g",
  pidsLimit: 128,
  network: "none",
};

function runtimeConfig(stateDirectory: string): RuntimeConfig {
  return {
    candidateProfile: "headless",
    credentialRef: "DEEPSEEK_API_KEY",
    verifierModel: "deepseek-v4-flash",
    nEvaluations: 2,
    maxVerifierWorkers: 8,
    verifierEffort: "high",
    verifierMaxTokens: 32_768,
    candidateTimeoutMs: 10_000,
    validationTimeoutMs: 10_000,
    runTimeoutMs: 30_000,
    maxVerifierTraceBytes: 512 * 1_024,
    stateDirectory,
    dshExecutable: "dsh",
    docker: SYNTHETIC_DOCKER_CONFIG,
  };
}

function processResult(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: "",
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
    ...overrides,
  };
}

function dockerResult(request: DockerExecutionRequest): DockerExecutionResult {
  return {
    ...processResult(),
    containerId: request.containerName,
    durationMs: 1,
  };
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

function fakeDockerExecutor(): DockerExecutor {
  return {
    preflight: async (config) => ({
      daemonVersion: "test-daemon",
      imageReference: `${config.image}@${config.digest}`,
    }),
    run: async (request) => {
      if (request.executionKind === "candidate") {
        await writeFile(join(request.workspacePath, "result.txt"), "candidate result\n");
      }
      return dockerResult(request);
    },
  };
}

async function runFixture(
  fixtureRoot: string,
  runVerifier: (request: VerifierRequest) => Promise<VerifierResponse>,
) {
  const repositoryPath = join(fixtureRoot, "repository");
  const stateDirectory = join(fixtureRoot, "state");
  await createCleanRepository(repositoryPath);
  const result = await runVerifiedBestOf({
    task: "Create result.txt",
    candidateCount: 3,
    validationCommands: ["test -f result.txt"],
    repositoryPath,
  }, runtimeConfig(stateDirectory), {
    requestApproval: async () => undefined,
    resolveCredential: async () => SYNTHETIC_CREDENTIAL,
    runVerifier,
    dockerExecutor: fakeDockerExecutor(),
  });
  return {
    result,
    verifierLogPath: join(dirname(result.reportPath), "verifier.log"),
  };
}

async function readVerifierLog(verifierLogPath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(verifierLogPath, "utf8")) as Record<string, unknown>;
}

describe("verifier response and single-write log contract", () => {
  it("persists one failure artifact for invalid JSON without exposing the raw response", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-verifier-invalid-json-"));
    try {
      const fixture = await runFixture(fixtureRoot, async () => {
        return parseVerifierResponse(`not-json-${SYNTHETIC_CREDENTIAL}`, [SYNTHETIC_CREDENTIAL]);
      });
      const verifierLog = await readVerifierLog(fixture.verifierLogPath);

      assert.equal(fixture.result.status, "failed");
      assert.match(fixture.result.failure ?? "", /^verifier_response_invalid:/u);
      assert.equal(verifierLog.status, "failure");
      assert.equal("response" in verifierLog, false);
      assert.doesNotMatch(JSON.stringify(verifierLog), /not-json|verifier-protocol-secret/u);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("persists one stable failure artifact for an invalid response shape", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-verifier-invalid-shape-"));
    try {
      const fixture = await runFixture(fixtureRoot, async () => {
        return parseVerifierResponse(JSON.stringify({
          winnerIndex: "zero",
          scores: [0.9, 0.5, 0.1],
          ranking: [0, 1, 2],
          requestCount: 1,
          tokenUsage: null,
        }), []);
      });
      const verifierLog = await readVerifierLog(fixture.verifierLogPath);

      assert.match(fixture.result.failure ?? "", /^verifier_response_invalid: winnerIndex/u);
      assert.equal(verifierLog.status, "failure");
      assert.equal("response" in verifierLog, false);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("rejects non-finite scores with the stable response error code", () => {
    assert.throws(
      () => parseVerifierResponse(
        '{"winnerIndex":0,"scores":[1e400,0.5],"ranking":[0,1],"requestCount":1,"tokenUsage":null}',
        [],
      ),
      /^Error: verifier_response_invalid: scores must contain finite numbers/u,
    );
  });

  it("logs candidate-count and ranking mismatch once while preserving the validation error", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-verifier-ranking-mismatch-"));
    try {
      const fixture = await runFixture(fixtureRoot, async () => ({
        winnerIndex: 0,
        scores: [0.9, 0.5, 0.1],
        ranking: [0, 1],
        requestCount: 1,
        tokenUsage: null,
      }));
      const verifierLog = await readVerifierLog(fixture.verifierLogPath);

      assert.match(fixture.result.failure ?? "", /^verifier_response_invalid: ranking must contain each/u);
      assert.equal(verifierLog.status, "failure");
      assert.equal(verifierLog.failure, fixture.result.failure);
      assert.equal("response" in verifierLog, false);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("writes only a failure artifact when winnerIndex disagrees with ranking", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-verifier-winner-mismatch-"));
    try {
      const fixture = await runFixture(fixtureRoot, async () => ({
        winnerIndex: 1,
        scores: [0.9, 0.5, 0.1],
        ranking: [0, 1, 2],
        requestCount: 1,
        tokenUsage: null,
      }));
      const verifierLog = await readVerifierLog(fixture.verifierLogPath);

      assert.match(fixture.result.failure ?? "", /^verifier_response_invalid: winnerIndex must equal ranking\[0\]/u);
      assert.equal(verifierLog.status, "failure");
      assert.equal("response" in verifierLog, false);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("persists one success artifact only after a valid response", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-verifier-valid-response-"));
    try {
      const fixture = await runFixture(fixtureRoot, async () => ({
        winnerIndex: 0,
        scores: [0.9, 0.5, 0.1],
        ranking: [0, 1, 2],
        requestCount: 1,
        tokenUsage: { calls: 1 },
      }));
      const verifierLog = await readVerifierLog(fixture.verifierLogPath);

      assert.equal(fixture.result.status, "winner_selected");
      assert.equal(verifierLog.status, "success");
      assert.equal("response" in verifierLog, true);
      assert.equal("failure" in verifierLog, false);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("preserves an initial EEXIST write failure without retrying the verifier log", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-verifier-log-eexist-"));
    let verifierLogPath = "";
    try {
      await assert.rejects(
        runFixture(fixtureRoot, async (request) => {
          verifierLogPath = join(dirname(request.cachePath), "verifier.log");
          await writeFile(verifierLogPath, "preexisting-log\n", { flag: "wx" });
          return {
            winnerIndex: 0,
            scores: [0.9, 0.5, 0.1],
            ranking: [0, 1, 2],
            requestCount: 1,
            tokenUsage: null,
          };
        }),
        /EEXIST|file already exists/u,
      );
      assert.equal(await readFile(verifierLogPath, "utf8"), "preexisting-log\n");
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});
