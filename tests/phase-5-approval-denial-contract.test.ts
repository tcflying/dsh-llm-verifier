import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import type { RuntimeConfig } from "../src/config.ts";
import type { DockerExecutor } from "../src/contracts.ts";
import { applyVerifiedWinner, runVerifiedBestOf } from "../src/core.ts";

const execFileAsync = promisify(execFile);
const RUN_ID = "55555555-5555-4555-8555-555555555555";
const WINNER_PATCH = [
  "diff --git a/result.txt b/result.txt",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/result.txt",
  "@@ -0,0 +1 @@",
  "+winner",
  "",
].join("\n");

interface ApprovalFixture {
  readonly fixtureRoot: string;
  readonly repositoryPath: string;
  readonly stateDirectory: string;
  readonly baseCommit: string;
  readonly winnerPatchPath: string;
}

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
    docker: {
      image: "registry.test/dsh-runtime:0.1.0",
      digest: `sha256:${"a".repeat(64)}`,
      cpus: 1,
      memory: "1g",
      pidsLimit: 128,
      network: "none",
    },
  };
}

async function gitOutput(repositoryPath: string, arguments_: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...arguments_], { cwd: repositoryPath });
  return stdout.trim();
}

async function createCleanRepository(repositoryPath: string): Promise<string> {
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
  return gitOutput(repositoryPath, ["rev-parse", "HEAD"]);
}

async function createApprovalFixture(): Promise<ApprovalFixture> {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-phase-5-approval-"));
  const repositoryPath = join(fixtureRoot, "repository");
  const stateDirectory = join(fixtureRoot, "state");
  const runDirectory = join(stateDirectory, "runs", RUN_ID);
  const baseCommit = await createCleanRepository(repositoryPath);
  await mkdir(runDirectory, { recursive: true });
  const canonicalRunDirectory = await realpath(runDirectory);
  const winnerPatchPath = join(canonicalRunDirectory, "winner.patch");
  await writeFile(winnerPatchPath, WINNER_PATCH);
  await writeFile(join(canonicalRunDirectory, "manifest.json"), `${JSON.stringify({
    schemaVersion: 1,
    repositoryPath,
    baseCommit,
    validationCommands: ["test -f result.txt"],
    winnerPatchSha256: createHash("sha256").update(WINNER_PATCH).digest("hex"),
    result: {
      runId: RUN_ID,
      status: "winner_selected",
      winnerId: "candidate-1",
      winnerPatchPath,
      ranking: [{ candidateId: "candidate-1", changedFiles: ["result.txt"] }],
    },
  }, null, 2)}\n`);
  return { fixtureRoot, repositoryPath, stateDirectory, baseCommit, winnerPatchPath };
}

async function assertRepositoryUnchanged(fixture: ApprovalFixture): Promise<void> {
  assert.equal(await gitOutput(fixture.repositoryPath, ["rev-parse", "HEAD"]), fixture.baseCommit);
  assert.equal(await gitOutput(
    fixture.repositoryPath,
    ["status", "--porcelain=v1", "--untracked-files=all"],
  ), "");
  await assert.rejects(access(join(fixture.repositoryPath, "result.txt")), { code: "ENOENT" });
}

describe("Phase 5 approval denial contract", () => {
  it("stops after the first approval denial without resolving credentials or launching Docker", async () => {
    const fixture = await createApprovalFixture();
    let credentialResolutionCount = 0;
    let dockerPreflightCount = 0;
    let dockerRunCount = 0;
    const dockerExecutor: DockerExecutor = {
      preflight: async () => {
        dockerPreflightCount += 1;
        throw new Error("Docker preflight must not run after approval denial");
      },
      run: async () => {
        dockerRunCount += 1;
        throw new Error("Docker execution must not run after approval denial");
      },
    };

    try {
      await assert.rejects(
        runVerifiedBestOf({
          task: "Create result.txt",
          candidateCount: 3,
          validationCommands: ["test -f result.txt"],
          repositoryPath: fixture.repositoryPath,
        }, runtimeConfig(fixture.stateDirectory), {
          requestApproval: async () => {
            throw new Error("first approval denied");
          },
          resolveCredential: async () => {
            credentialResolutionCount += 1;
            return "credential-must-not-be-resolved";
          },
          runVerifier: async () => {
            throw new Error("verifier must not run after approval denial");
          },
          dockerExecutor,
        }),
        /first approval denied/u,
      );

      assert.equal(credentialResolutionCount, 0);
      assert.equal(dockerPreflightCount, 0);
      assert.equal(dockerRunCount, 0);
      await assertRepositoryUnchanged(fixture);
    } finally {
      await rm(fixture.fixtureRoot, { recursive: true, force: true });
    }
  });

  it("stops after the second approval denial without resolving credentials or applying the patch", async () => {
    const fixture = await createApprovalFixture();
    let credentialResolutionCount = 0;

    try {
      await assert.rejects(
        applyVerifiedWinner({
          runId: RUN_ID,
          repositoryPath: fixture.repositoryPath,
        }, runtimeConfig(fixture.stateDirectory), {
          requestApproval: async () => {
            throw new Error("second approval denied");
          },
          resolveCredential: async () => {
            credentialResolutionCount += 1;
            return "credential-must-not-be-resolved";
          },
        }),
        /second approval denied/u,
      );

      assert.equal(credentialResolutionCount, 0);
      await assertRepositoryUnchanged(fixture);
      assert.equal(await readFile(fixture.winnerPatchPath, "utf8"), WINNER_PATCH);
      await assert.rejects(
        access(join(dirname(fixture.winnerPatchPath), "apply-result.json")),
        { code: "ENOENT" },
      );
    } finally {
      await rm(fixture.fixtureRoot, { recursive: true, force: true });
    }
  });

  it("rejects a changed HEAD before requesting the second approval", async () => {
    const fixture = await createApprovalFixture();
    let approvalRequestCount = 0;

    try {
      await writeFile(join(fixture.repositoryPath, "README.md"), "new committed state\n");
      await execFileAsync("git", ["add", "README.md"], { cwd: fixture.repositoryPath });
      await execFileAsync("git", ["commit", "--quiet", "-m", "change head"], {
        cwd: fixture.repositoryPath,
      });

      await assert.rejects(
        applyVerifiedWinner({
          runId: RUN_ID,
          repositoryPath: fixture.repositoryPath,
        }, runtimeConfig(fixture.stateDirectory), {
          requestApproval: async () => {
            approvalRequestCount += 1;
          },
          resolveCredential: async () => "credential-must-not-be-resolved",
        }),
        /repository HEAD changed/u,
      );

      assert.equal(approvalRequestCount, 0);
      assert.equal(await gitOutput(
        fixture.repositoryPath,
        ["status", "--porcelain=v1", "--untracked-files=all"],
      ), "");
      await assert.rejects(access(join(fixture.repositoryPath, "result.txt")), { code: "ENOENT" });
    } finally {
      await rm(fixture.fixtureRoot, { recursive: true, force: true });
    }
  });
});
