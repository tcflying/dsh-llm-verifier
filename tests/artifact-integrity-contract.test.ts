import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import type { DockerRuntimeConfig, RuntimeConfig } from "../src/config.ts";
import type { DockerExecutor } from "../src/contracts.ts";
import { applyVerifiedWinner, runVerifiedBestOf } from "../src/core.ts";
import type { DockerExecutionRequest, DockerExecutionResult } from "../src/docker.ts";
import { assertPatchArtifactIdentity, createPatchArtifact } from "../src/git.ts";
import type { ProcessResult } from "../src/process.ts";

const execFileAsync = promisify(execFile);
const SYNTHETIC_CREDENTIAL = "phase4-artifact-credential";
const SYNTHETIC_DOCKER_CONFIG: DockerRuntimeConfig = {
  image: "registry.test/dsh-runtime:0.1.0",
  digest: `sha256:${"a".repeat(64)}`,
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

function dockerResult(
  request: DockerExecutionRequest,
  overrides: Partial<DockerExecutionResult> = {},
): DockerExecutionResult {
  return {
    ...processResult(),
    containerId: request.containerName,
    durationMs: 1,
    ...overrides,
  };
}

function candidateNumber(request: DockerExecutionRequest): number {
  const match = /candidate-(\d+)/u.exec(request.workspacePath);
  if (match?.[1] === undefined) {
    throw new Error(`candidate number missing from ${JSON.stringify(request.workspacePath)}`);
  }
  return Number(match[1]);
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

async function runSingleEligibleCandidate(
  fixtureRoot: string,
  executeCandidate: (request: DockerExecutionRequest) => Promise<void>,
  executeValidation: (request: DockerExecutionRequest) => Promise<void>,
) {
  const repositoryPath = join(fixtureRoot, "repository");
  const stateDirectory = join(fixtureRoot, "state");
  await createCleanRepository(repositoryPath);
  const dockerExecutor: DockerExecutor = {
    preflight: async (config) => ({
      daemonVersion: "test-daemon",
      imageReference: `${config.image}@${config.digest}`,
    }),
    run: async (request) => {
      if (request.executionKind === "validation") {
        await executeValidation(request);
        return dockerResult(request);
      }
      if (candidateNumber(request) === 1) {
        await executeCandidate(request);
        return dockerResult(request);
      }
      return dockerResult(request, { exitCode: 2, stderr: "synthetic candidate failure" });
    },
  };
  const config = runtimeConfig(stateDirectory);
  const result = await runVerifiedBestOf({
    task: "Produce the requested fixture change",
    candidateCount: 3,
    validationCommands: ["true"],
    repositoryPath,
  }, config, {
    requestApproval: async () => undefined,
    resolveCredential: async () => SYNTHETIC_CREDENTIAL,
    runVerifier: async () => {
      throw new Error("verifier must not run with one eligible candidate");
    },
    dockerExecutor,
  });
  return { config, repositoryPath, result, stateDirectory };
}

async function applyFixtureWinner(
  repositoryPath: string,
  config: RuntimeConfig,
  runId: string,
) {
  return applyVerifiedWinner({ runId, repositoryPath }, config, {
    requestApproval: async () => undefined,
    resolveCredential: async () => SYNTHETIC_CREDENTIAL,
  });
}

describe("immutable patch artifact contract", () => {
  it("creates a byte-owned artifact whose hash and size come from the captured bytes", () => {
    const sourceBytes = Buffer.from([0, 255, 254, 253, 128, 10]);
    const artifact = createPatchArtifact(sourceBytes);
    sourceBytes.fill(1);

    assert.deepEqual(artifact.bytes, Buffer.from([0, 255, 254, 253, 128, 10]));
    assert.equal(artifact.size, 6);
    assert.equal(
      artifact.sha256,
      createHash("sha256").update(artifact.bytes).digest("hex"),
    );
  });

  it("records one SHA-256 for capture, validation input, winner, and apply", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-artifact-sha-chain-"));
    const expectedBinary = Buffer.from([0, 255, 254, 253, 128, 64, 32, 16, 8, 4, 2, 1]);
    let candidateWorkspacePath = "";
    try {
      const fixture = await runSingleEligibleCandidate(
        fixtureRoot,
        async (request) => {
          candidateWorkspacePath = request.workspacePath;
          await writeFile(join(request.workspacePath, "asset.bin"), expectedBinary);
        },
        async (request) => {
          await writeFile(join(candidateWorkspacePath, "asset.bin"), Buffer.from("later mutation"));
          assert.deepEqual(await readFile(join(request.workspacePath, "asset.bin")), expectedBinary);
        },
      );
      assert.equal(fixture.result.status, "winner_selected");
      const manifest = JSON.parse(await readFile(
        join(dirname(fixture.result.reportPath), "manifest.json"),
        "utf8",
      )) as {
        winnerPatchSha256: string;
        candidateRuns: Array<{
          candidateId: string;
          patchSha256: string | null;
          validationInputPatchSha256: string | null;
        }>;
      };
      const winnerRun = manifest.candidateRuns.find((run) => run.candidateId === "candidate-1");
      const winnerPatch = await readFile(fixture.result.winnerPatchPath ?? "");
      const winnerPatchSha256 = createHash("sha256").update(winnerPatch).digest("hex");
      assert.equal(winnerRun?.patchSha256, winnerPatchSha256);
      assert.equal(winnerRun?.validationInputPatchSha256, winnerPatchSha256);
      assert.equal(manifest.winnerPatchSha256, winnerPatchSha256);

      const applyResult = await applyFixtureWinner(
        fixture.repositoryPath,
        fixture.config,
        fixture.result.runId,
      );
      assert.equal(applyResult.patchSha256, winnerPatchSha256);
      assert.deepEqual(await readFile(join(fixture.repositoryPath, "asset.bin")), expectedBinary);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("rejects a later regenerated patch with a stable mismatch code", () => {
    const capturedArtifact = createPatchArtifact(Buffer.from("captured patch bytes"));
    const regeneratedArtifact = createPatchArtifact(Buffer.from("different patch bytes"));
    assert.throws(
      () => assertPatchArtifactIdentity(capturedArtifact, regeneratedArtifact),
      /artifact_sha256_mismatch/u,
    );
  });

  it("rejects a validation command that exits zero after changing a tracked file", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-artifact-validation-mutation-"));
    try {
      const fixture = await runSingleEligibleCandidate(
        fixtureRoot,
        async (request) => writeFile(join(request.workspacePath, "result.txt"), "candidate result\n"),
        async (request) => writeFile(join(request.workspacePath, "README.md"), "validation mutation\n"),
      );
      assert.equal(fixture.result.status, "no_winner");
      assert.equal(fixture.result.winnerPatchPath, null);
      assert.match(
        fixture.result.ranking.find((candidate) => candidate.candidateId === "candidate-1")?.failure ?? "",
        /artifact_sha256_mismatch/u,
      );
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("round-trips non-UTF-8 artifact bytes without converting them to text", () => {
    const capturedArtifact = createPatchArtifact(Buffer.from([0, 255, 254, 253, 128, 0, 10]));
    const storedArtifact = createPatchArtifact(Buffer.from(capturedArtifact.bytes));
    assertPatchArtifactIdentity(capturedArtifact, storedArtifact);
    assert.deepEqual(storedArtifact.bytes, Buffer.from([0, 255, 254, 253, 128, 0, 10]));
  });
});
