import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import type { RuntimeConfig } from "../src/config.ts";
import { applyVerifiedWinner, RunDeadlineExceededError } from "../src/core.ts";

const execFileAsync = promisify(execFile);
const RUN_ID = "11111111-1111-4111-8111-111111111111";
const WINNER_PATCH = [
  "diff --git a/result.txt b/result.txt",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/result.txt",
  "@@ -0,0 +1 @@",
  "+winner",
  "",
].join("\n");

interface ApplyFixture {
  readonly fixtureRoot: string;
  readonly repositoryPath: string;
  readonly stateDirectory: string;
}

async function createApplyFixture(validationCommands: readonly string[]): Promise<ApplyFixture> {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-apply-deadline-"));
  const repositoryPath = join(fixtureRoot, "repository");
  const stateDirectory = join(fixtureRoot, "state");
  const runDirectory = join(stateDirectory, "runs", RUN_ID);
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
  const { stdout: baseCommitOutput } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryPath,
  });
  const baseCommit = baseCommitOutput.trim();
  await mkdir(runDirectory, { recursive: true });
  const canonicalRunDirectory = await realpath(runDirectory);
  const winnerPatchPath = join(canonicalRunDirectory, "winner.patch");
  await writeFile(winnerPatchPath, WINNER_PATCH);
  const winnerPatchSha256 = createHash("sha256").update(WINNER_PATCH).digest("hex");
  await writeFile(join(runDirectory, "manifest.json"), `${JSON.stringify({
    schemaVersion: 1,
    repositoryPath,
    baseCommit,
    validationCommands,
    winnerPatchSha256,
    result: {
      runId: RUN_ID,
      status: "winner_selected",
      winnerId: "candidate-1",
      winnerPatchPath,
      ranking: [{ candidateId: "candidate-1", changedFiles: ["result.txt"] }],
    },
  }, null, 2)}\n`);
  return { fixtureRoot, repositoryPath, stateDirectory };
}

function runtimeConfig(
  stateDirectory: string,
  runTimeoutMs: number,
  validationTimeoutMs = 2_000,
): RuntimeConfig {
  return {
    candidateProfile: "headless",
    credentialRef: "DEEPSEEK_API_KEY",
    verifierModel: "deepseek-v4-flash",
    nEvaluations: 2,
    maxVerifierWorkers: 8,
    verifierEffort: "high",
    verifierMaxTokens: 32_768,
    candidateTimeoutMs: 2_000,
    validationTimeoutMs,
    runTimeoutMs,
    maxVerifierTraceBytes: 512 * 1_024,
    stateDirectory,
    dshExecutable: "/container/dsh",
  };
}

function dependencies(approvalReasons: string[] = []) {
  return {
    requestApproval: async (reason: string) => {
      approvalReasons.push(reason);
    },
    resolveCredential: async () => "synthetic-apply-credential",
  };
}

describe("apply operation deadline contract", () => {
  it("bounds apply and validation by one operation budget smaller than the stage limit", async () => {
    const fixture = await createApplyFixture([
      "node -e \"setTimeout(() => {}, 2000)\"",
    ]);
    const approvalReasons: string[] = [];
    try {
      const startedAt = Date.now();
      const result = await applyVerifiedWinner(
        { runId: RUN_ID, repositoryPath: fixture.repositoryPath },
        runtimeConfig(fixture.stateDirectory, 300),
        dependencies(approvalReasons),
      );
      const elapsedMs = Date.now() - startedAt;

      assert.equal(result.status, "applied_validation_failed");
      assert.equal(result.validationStatus, "timed_out");
      assert.ok(elapsedMs < 1_000, `apply operation reset the 2000 ms stage limit: ${elapsedMs}`);
      assert.equal(await readFile(join(fixture.repositoryPath, "result.txt"), "utf8"), "winner\n");
      assert.match(approvalReasons[0] ?? "", /share a 300 ms deadline/u);
      assert.match(approvalReasons[0] ?? "", /only the remaining operation budget/u);
    } finally {
      await rm(fixture.fixtureRoot, { recursive: true, force: true });
    }
  });

  it("fails before patch mutation or validation when the apply deadline is exhausted", async () => {
    const validationMarkerPath = join(tmpdir(), `dsh-apply-validation-${Date.now()}.marker`);
    const fixture = await createApplyFixture([`touch ${validationMarkerPath}`]);
    const delayedGitDirectory = join(fixture.fixtureRoot, "delayed-git");
    const originalPath = process.env.PATH;
    try {
      await mkdir(delayedGitDirectory);
      await writeFile(
        join(delayedGitDirectory, "git"),
        "#!/bin/sh\nsleep 2\nexec /usr/bin/git \"$@\"\n",
        { mode: 0o700 },
      );
      const applyDependencies = {
        ...dependencies(),
        resolveCredential: async () => {
          process.env.PATH = `${delayedGitDirectory}:${originalPath ?? ""}`;
          return "synthetic-apply-credential";
        },
      };
      await assert.rejects(
        applyVerifiedWinner(
          { runId: RUN_ID, repositoryPath: fixture.repositoryPath },
          runtimeConfig(fixture.stateDirectory, 500),
          applyDependencies,
        ),
        (error: unknown) => {
          assert.ok(error instanceof RunDeadlineExceededError);
          assert.equal(error.code, "deadline_exceeded");
          return true;
        },
      );
      await assert.rejects(access(join(fixture.repositoryPath, "result.txt")), { code: "ENOENT" });
      await assert.rejects(access(validationMarkerPath), { code: "ENOENT" });
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
      await rm(fixture.fixtureRoot, { recursive: true, force: true });
      await rm(validationMarkerPath, { force: true });
    }
  });

  it("gives later post-apply validation only the budget left by earlier work", async () => {
    const fixture = await createApplyFixture([
      "node -e \"setTimeout(() => {}, 180)\"",
      "node -e \"setTimeout(() => {}, 2000)\"",
    ]);
    try {
      const startedAt = Date.now();
      const result = await applyVerifiedWinner(
        { runId: RUN_ID, repositoryPath: fixture.repositoryPath },
        runtimeConfig(fixture.stateDirectory, 500),
        dependencies(),
      );
      const elapsedMs = Date.now() - startedAt;

      assert.equal(result.validationStatus, "timed_out");
      assert.equal(result.validationLogPaths.length, 2);
      assert.ok(elapsedMs >= 400, `validation did not consume the shared budget: ${elapsedMs}`);
      assert.ok(elapsedMs < 1_100, `validation received a fresh stage timeout: ${elapsedMs}`);
    } finally {
      await rm(fixture.fixtureRoot, { recursive: true, force: true });
    }
  });

  it("does not reset the deadline for each post-apply validation command", async () => {
    const fixture = await createApplyFixture([
      "node -e \"setTimeout(() => {}, 140)\"",
      "node -e \"setTimeout(() => {}, 140)\"",
      "node -e \"setTimeout(() => {}, 2000)\"",
    ]);
    try {
      const startedAt = Date.now();
      const result = await applyVerifiedWinner(
        { runId: RUN_ID, repositoryPath: fixture.repositoryPath },
        runtimeConfig(fixture.stateDirectory, 900, 2_000),
        dependencies(),
      );
      const elapsedMs = Date.now() - startedAt;

      assert.equal(result.validationStatus, "timed_out");
      assert.equal(result.validationLogPaths.length, 3);
      assert.ok(elapsedMs < 1_500, `validation timeout reset for each command: ${elapsedMs}`);
    } finally {
      await rm(fixture.fixtureRoot, { recursive: true, force: true });
    }
  });
});
