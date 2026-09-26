import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, it } from "node:test";

import type { Context } from "@deepseek-ai/cordis";
import {
  registerVerifierSettings,
  resolveRunSettings,
  SETTINGS_NAMESPACE,
  type RunSettings,
} from "../src/settings.ts";
import { applyVerifiedWinner, runVerifiedBestOf, selectVerifiedCandidate } from "../src/core.ts";

const execFileAsync = promisify(execFile);
const testDirectory = dirname(fileURLToPath(import.meta.url));
const IS_WINDOWS = process.platform === "win32";

/**
 * Writes a fake `dsh` executable whose behavior is implemented by the shared
 * Node helper in fixtures/fake-dsh.mjs, wrapped in the platform shell so
 * runProcess can execute it directly on macOS, Linux, and Windows.
 */
async function writeFakeDsh(fixtureRoot: string, spec: Record<string, unknown>): Promise<string> {
  const specPath = join(fixtureRoot, "fake-dsh-spec.json");
  await writeFile(specPath, JSON.stringify(spec));
  const helperPath = join(testDirectory, "fixtures", "fake-dsh.mjs");
  if (IS_WINDOWS) {
    const wrapperPath = join(fixtureRoot, "fake-dsh.cmd");
    await writeFile(wrapperPath, `@echo off\r\nnode "${helperPath}" "${specPath}"\r\n`);
    return wrapperPath;
  }
  const wrapperPath = join(fixtureRoot, "fake-dsh.sh");
  await writeFile(wrapperPath, `#!/bin/sh\nexec node "${helperPath}" "${specPath}"\n`, { mode: 0o755 });
  await chmod(wrapperPath, 0o755);
  return wrapperPath;
}

function validationFileExists(paths: readonly string[]): string {
  return IS_WINDOWS
    ? paths.map((path) => `if not exist ${path} exit 1`).join(" && ")
    : paths.map((path) => `test -f ${path}`).join(" && ");
}

async function createCleanRepository(repositoryPath: string): Promise<void> {
  await mkdir(repositoryPath, { recursive: true });
  await execFileAsync("git", ["init", "--quiet", repositoryPath]);
  await execFileAsync("git", ["config", "user.email", "tests@example.invalid"], { cwd: repositoryPath });
  await execFileAsync("git", ["config", "user.name", "Verifier Tests"], { cwd: repositoryPath });
  await writeFile(join(repositoryPath, "README.md"), "fixture\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: repositoryPath });
  await execFileAsync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: repositoryPath });
}

async function assertTreeDoesNotContain(rootPath: string, forbiddenText: string): Promise<void> {
  const directoryEntries = await readdir(rootPath, { withFileTypes: true });
  for (const directoryEntry of directoryEntries) {
    const entryPath = join(rootPath, directoryEntry.name);
    if (directoryEntry.isDirectory()) {
      await assertTreeDoesNotContain(entryPath, forbiddenText);
    } else if (directoryEntry.isFile()) {
      assert.equal(
        (await readFile(entryPath)).includes(Buffer.from(forbiddenText)),
        false,
        `secret found in ${entryPath}`,
      );
    }
  }
}

function createRuntimeConfig(stateDirectory: string, dshExecutable: string): RunSettings {
  return {
    enabled: true,
    defaultCandidateCount: 3,
    maxConcurrentCandidates: 3,
    candidateProfile: "headless",
    reviewMode: "deepseek_verifier",
    reviewerProvider: "",
    reviewerModel: "",
    reviewerReasoningEffort: "",
    reviewerMaxTokens: 4_096,
    reviewerTimeoutMs: 30_000,
    reviewSingleEligible: false,
    reviewFailurePolicy: "stop",
    validationMode: "auto",
    validationCommands: [],
    credentialRef: "DEEPSEEK_API_KEY",
    verifierModel: "deepseek-v4-flash",
    nEvaluations: 2,
    maxVerifierWorkers: 8,
    verifierEffort: "high",
    verifierMaxTokens: 32_768,
    // Every step here is a real subprocess (fake dsh is a real `node`, apply is a real `git`), so this
    // budget is patience with the *machine*, not an asserted behavior — production defaults are
    // 20/10/45 minutes (src/settings.ts:167-169). At 10/10/30 s the final gate went red twice (waves 22b
    // and 26) with nothing wrong but slow spawns on a box whose spare CPU was under one core.
    candidateTimeoutMs: 60_000,
    validationTimeoutMs: 60_000,
    runTimeoutMs: 180_000,
    maxVerifierTraceBytes: 512 * 1024,
    stateDirectory,
    dshExecutable,
  };
}

describe("Best-of orchestration", () => {
  it("reports the actual DSH reviewer instead of unused DeepSeek defaults", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-reviewer-report-"));
    try {
      const repositoryPath = join(fixtureRoot, "repository");
      await createCleanRepository(repositoryPath);
      const fakeDshPath = await writeFakeDsh(fixtureRoot, { mode: "basename-result" });
      const config: RunSettings = {
        ...createRuntimeConfig(join(fixtureRoot, "state"), fakeDshPath),
        reviewMode: "dsh_model",
        reviewerProvider: "configured-provider",
        reviewerModel: "configured-model",
        reviewerReasoningEffort: "high",
        maxVerifierTraceBytes: 64,
      };
      const result = await runVerifiedBestOf({
        task: "Create result.txt",
        candidateCount: 2,
        validationCommands: [validationFileExists(["result.txt"])],
        repositoryPath,
      }, config, {
        requestApproval: async () => undefined,
        resolveCredential: async () => "",
        runVerifier: async () => { throw new Error("DeepSeek must not run"); },
        reviewCandidates: async (request) => {
          assert.equal(request.reasoningEffort, "high");
          // The prompt used to inline each candidate's whole patch with no cap,
          // while the deepseek path capped its trace at maxVerifierTraceBytes.
          for (const candidate of request.candidates) {
            assert.ok(
              candidate.diffText.length < 400,
              `diffText was not capped: ${candidate.diffText.length} characters`,
            );
            assert.match(candidate.diffText, /complete input retained locally/);
          }
          return {
            method: "dsh_model", provider: "receipt-provider", model: "receipt-model",
            selectedId: "candidate-1", scores: { "candidate-1": 95, "candidate-2": 90 },
            evidence: { "candidate-1": "best", "candidate-2": "acceptable" },
            risks: "none", rawResponseLength: 100, durationMs: 10,
          };
        },
      });
      assert.equal(result.status, "winner_selected");
      const report = await readFile(result.reportPath, "utf8");
      assert.match(report, /Reviewer provider: `receipt-provider`/);
      assert.match(report, /Reviewer model: `receipt-model`/);
      assert.match(report, /Configured reviewer reasoning effort: `high`/);
      assert.doesNotMatch(report, /deepseek-v4-flash|Verifier repetitions|configured-model/);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("fails loudly on a reviewMode this build does not implement", async () => {
    // src/settings.ts:113 hands back the host settings document as RunSettings with an unchecked
    // cast, so a typo'd or stale reviewMode in the persisted file is live input, not a type error.
    const fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-review-mode-"));
    try {
      const repositoryPath = join(fixtureRoot, "repository");
      await createCleanRepository(repositoryPath);
      const fakeDshPath = await writeFakeDsh(fixtureRoot, { mode: "matrix", total: 2, eligible: 2 });
      const config: RunSettings = {
        ...createRuntimeConfig(join(fixtureRoot, "state"), fakeDshPath),
        reviewMode: "auto" as unknown as RunSettings["reviewMode"],
      };
      const result = await runVerifiedBestOf({
        task: "Create result.txt",
        candidateCount: 2,
        validationCommands: [validationFileExists(["result.txt"])],
        repositoryPath,
      }, config, {
        requestApproval: async () => undefined,
        resolveCredential: async () => "",
        runVerifier: async () => { throw new Error("verifier must not run for an unknown mode"); },
        reviewCandidates: async () => { throw new Error("reviewer must not run for an unknown mode"); },
      });
      // Before the branch existed this fell through to status "no_winner" with failure: none,
      // which reads to the host exactly like "the candidates ran and none of them qualified".
      assert.equal(result.status, "failed");
      assert.match(result.failure ?? "", /unknown reviewMode "auto"/);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("refuses an unknown validationMode instead of silently auto-detecting", async () => {
    // N18's sibling: settings.ts:113 casts the host settings document to RunSettings unchecked, and
    // this field is read as `validationMode === "configured" && …` — anything else took the
    // auto-detect branch, so an operator's configured validation commands never ran and the manifest
    // said nothing about being skipped.
    const fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-validation-mode-"));
    try {
      const repositoryPath = join(fixtureRoot, "repository");
      await createCleanRepository(repositoryPath);
      const fakeDshPath = await writeFakeDsh(fixtureRoot, { mode: "winner" });
      const config: RunSettings = {
        ...createRuntimeConfig(join(fixtureRoot, "state"), fakeDshPath),
        validationMode: "configuredd" as unknown as RunSettings["validationMode"],
        validationCommands: ["node -e 0"],
      };
      await assert.rejects(
        runVerifiedBestOf({ task: "Create result.txt", repositoryPath }, config, {
          requestApproval: async () => undefined,
          resolveCredential: async () => "",
          runVerifier: async () => { throw new Error("must not reach the verifier"); },
        }),
        /invalid validationMode "configuredd"/,
      );
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("keeps an already-selected winner when the run aborts during review", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-abort-after-selection-"));
    try {
      const repositoryPath = join(fixtureRoot, "repository");
      await createCleanRepository(repositoryPath);
      const fakeDshPath = await writeFakeDsh(fixtureRoot, { mode: "matrix", total: 2, eligible: 2 });
      const controller = new AbortController();
      const config: RunSettings = {
        ...createRuntimeConfig(join(fixtureRoot, "state"), fakeDshPath),
        reviewMode: "dsh_model",
        reviewerProvider: "stub-provider",
        reviewerModel: "stub-model",
      };
      const result = await runVerifiedBestOf({
        task: "Create result.txt",
        candidateCount: 2,
        validationCommands: [validationFileExists(["result.txt"])],
        repositoryPath,
        signal: controller.signal,
      }, config, {
        requestApproval: async () => undefined,
        resolveCredential: async () => "",
        runVerifier: async () => { throw new Error("DeepSeek must not run"); },
        reviewCandidates: async () => {
          // The cancel lands while the reviewer is in flight, over a pool that already ran to
          // completion. Erasing the verdict here also skipped the winner.patch write, so the run
          // threw away applyable work and reported a bare failure.
          controller.abort(new Error("host cancelled the run"));
          return {
            method: "dsh_model", provider: "stub-provider", model: "stub-model",
            selectedId: "candidate-1", scores: { "candidate-1": 95, "candidate-2": 90 },
            evidence: { "candidate-1": "best", "candidate-2": "acceptable" },
            risks: "none", rawResponseLength: 10, durationMs: 5,
          };
        },
      });
      assert.equal(result.status, "winner_selected");
      assert.equal(result.winnerId, "candidate-1");
      assert.equal(result.failure, null);
      assert.match(await readFile(result.winnerPatchPath ?? "", "utf8"), /result\.txt/);
      // Truncation stays disclosed: the winner is only as broad as the pool that finished.
      assert.match(await readFile(result.reportPath, "utf8"), /aborted after a winner was selected/);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("keeps the source unchanged until a second approval applies the validated winner", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-llm-verifier-core-"));
    const repositoryPath = join(fixtureRoot, "repository");
    const stateDirectory = join(fixtureRoot, "state");
    const fakeDshPath = await writeFakeDsh(fixtureRoot, { mode: "permission-and-winner" });
    const credentialValue = "test-secret-that-must-not-be-written";
    await createCleanRepository(repositoryPath);
    await writeFile(join(repositoryPath, "README.md"), `${credentialValue}\n`);
    await execFileAsync("git", ["add", "README.md"], { cwd: repositoryPath });
    await execFileAsync("git", ["commit", "--quiet", "--amend", "--no-edit"], { cwd: repositoryPath });

    const approvalReasons: string[] = [];
    try {
      const result = await runVerifiedBestOf(
        {
          task: "Create result.txt",
          candidateCount: 3,
          validationCommands: [
            IS_WINDOWS
              ? "type README.md && if not exist result.txt exit 1"
              : "cat README.md && test -f result.txt",
          ],
          repositoryPath,
        },
        createRuntimeConfig(stateDirectory, fakeDshPath),
        {
          requestApproval: async (reason) => {
            approvalReasons.push(reason);
          },
          resolveCredential: async () => credentialValue,
          runVerifier: async () => {
            throw new Error("verifier must not run with one eligible candidate");
          },
        },
      );

      assert.equal(result.status, "winner_selected");
      assert.equal(result.selectionMethod, "validation_only");
      assert.equal(result.winnerId, "candidate-1");
      assert.equal(result.eligibleCandidateCount, 1);
      assert.match(approvalReasons[0] ?? "", /3 isolated DeepSeek Harness candidates/);
      assert.equal(await readFile(result.winnerPatchPath ?? "", "utf8").then((patch) => patch.includes("result.txt")), true);
      await assert.rejects(access(join(repositoryPath, "result.txt")));

      const { stdout: statusOutput } = await execFileAsync(
        "git",
        ["status", "--porcelain=v1", "--untracked-files=all"],
        { cwd: repositoryPath },
      );
      assert.equal(statusOutput, "");
      const { stdout: worktreeOutput } = await execFileAsync("git", ["worktree", "list", "--porcelain"], {
        cwd: repositoryPath,
      });
      assert.doesNotMatch(worktreeOutput, /candidate-[123]/);

      const report = await readFile(result.reportPath, "utf8");
      assert.doesNotMatch(report, /test-secret-that-must-not-be-written/);
      await assertTreeDoesNotContain(stateDirectory, credentialValue);

      const dirtyMarkerPath = join(repositoryPath, "local-uncommitted.txt");
      await writeFile(dirtyMarkerPath, "do not overwrite\n");
      await assert.rejects(
        applyVerifiedWinner(
          { runId: result.runId, repositoryPath },
          createRuntimeConfig(stateDirectory, fakeDshPath),
          {
            requestApproval: async () => undefined,
            resolveCredential: async () => credentialValue,
          },
        ),
        /repository must be clean/,
      );
      await rm(dirtyMarkerPath);

      const winnerPatchPath = result.winnerPatchPath ?? "";
      const originalWinnerPatch = await readFile(winnerPatchPath);
      await writeFile(winnerPatchPath, Buffer.concat([originalWinnerPatch, Buffer.from("tampered\n")]));
      await assert.rejects(
        applyVerifiedWinner(
          { runId: result.runId, repositoryPath },
          createRuntimeConfig(stateDirectory, fakeDshPath),
          {
            requestApproval: async () => undefined,
            resolveCredential: async () => credentialValue,
          },
        ),
        /winner patch hash changed/,
      );
      await writeFile(winnerPatchPath, originalWinnerPatch);

      const winnerPatchBackupPath = `${winnerPatchPath}.backup`;
      await rename(winnerPatchPath, winnerPatchBackupPath);
      if (IS_WINDOWS) {
        // A directory at the patch path exercises the same not-a-regular-file
        // guard without needing symlink privileges.
        await mkdir(winnerPatchPath);
      } else {
        await symlink(winnerPatchBackupPath, winnerPatchPath);
      }
      await assert.rejects(
        applyVerifiedWinner(
          { runId: result.runId, repositoryPath },
          createRuntimeConfig(stateDirectory, fakeDshPath),
          {
            requestApproval: async () => undefined,
            resolveCredential: async () => credentialValue,
          },
        ),
        /winner patch must be a regular file/,
      );
      await rm(winnerPatchPath, { recursive: true });
      await rename(winnerPatchBackupPath, winnerPatchPath);

      const applyResult = await applyVerifiedWinner(
        { runId: result.runId, repositoryPath },
        createRuntimeConfig(stateDirectory, fakeDshPath),
        {
          requestApproval: async (reason) => {
            approvalReasons.push(reason);
            await writeFile(
              winnerPatchPath,
              Buffer.concat([originalWinnerPatch, Buffer.from("changed after approval\\n")]),
            );
          },
          resolveCredential: async () => credentialValue,
        },
      );
      assert.equal(applyResult.status, "applied");
      // Windows git checkouts may materialize CRLF; compare line-normalized.
      assert.equal(
        (await readFile(join(repositoryPath, "result.txt"), "utf8")).replaceAll("\r\n", "\n"),
        "winner\n",
      );
      await assertTreeDoesNotContain(stateDirectory, credentialValue);
      assert.equal(approvalReasons.length, 2);
      const { stdout: stagedChanges } = await execFileAsync("git", ["diff", "--cached", "--name-only"], {
        cwd: repositoryPath,
      });
      assert.equal(stagedChanges, "");
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("runs five isolated candidates and uses two verifier pivots", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-llm-verifier-best-five-"));
    const repositoryPath = join(fixtureRoot, "repository");
    const stateDirectory = join(fixtureRoot, "state");
    const fakeDshPath = await writeFakeDsh(fixtureRoot, { mode: "basename-result" });
    await createCleanRepository(repositoryPath);

    let receivedCandidateCount = 0;
    let receivedPivots = 0;
    try {
      const result = await runVerifiedBestOf(
        {
          task: "Create result.txt",
          candidateCount: 5,
          validationCommands: [validationFileExists(["result.txt"])],
          repositoryPath,
        },
        createRuntimeConfig(stateDirectory, fakeDshPath),
        {
          requestApproval: async () => undefined,
          resolveCredential: async () => "test-secret",
          runVerifier: async (request) => {
            receivedCandidateCount = request.candidates.length;
            receivedPivots = request.pivots;
            return {
              winnerIndex: 4,
              scores: [0.1, 0.2, 0.3, 0.4, 0.9],
              ranking: [4, 3, 2, 1, 0],
              requestCount: 72,
              tokenUsage: { calls: 72 },
            };
          },
        },
      );

      assert.equal(result.status, "winner_selected");
      assert.equal(result.selectionMethod, "llm_verifier");
      assert.equal(result.winnerId, "candidate-5");
      assert.equal(result.eligibleCandidateCount, 5);
      assert.equal(result.verifierRequestCount, 72);
      assert.equal(receivedCandidateCount, 5);
      assert.equal(receivedPivots, 2);
      const verifierLogPath = join(dirname(result.reportPath), "verifier.log");
      assert.match(await readFile(verifierLogPath, "utf8"), /"calls": 72/);
      assert.match(
        await readFile(result.reportPath, "utf8"),
        new RegExp(verifierLogPath.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&")),
      );
      const { stdout: statusOutput } = await execFileAsync(
        "git",
        ["status", "--porcelain=v1", "--untracked-files=all"],
        { cwd: repositoryPath },
      );
      assert.equal(statusOutput, "");
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("handles every Best-of-3 and Best-of-5 eligible-candidate count", async () => {
    const matrix = [
      ...[0, 1, 2, 3].map((eligibleCandidateCount) => ({
        candidateCount: 3 as const,
        eligibleCandidateCount,
      })),
      ...[0, 1, 2, 3, 4, 5].map((eligibleCandidateCount) => ({
        candidateCount: 5 as const,
        eligibleCandidateCount,
      })),
    ];

    for (const matrixCase of matrix) {
      const fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-llm-verifier-matrix-"));
      const repositoryPath = join(fixtureRoot, "repository");
      const stateDirectory = join(fixtureRoot, "state");
      const fakeDshPath = await writeFakeDsh(fixtureRoot, {
        mode: "matrix",
        eligible: matrixCase.eligibleCandidateCount,
        total: matrixCase.candidateCount,
      });
      await createCleanRepository(repositoryPath);

      let verifierCallCount = 0;
      let receivedPivots: number | null = null;
      try {
        const result = await runVerifiedBestOf(
          {
            task: "Create result.txt",
            candidateCount: matrixCase.candidateCount,
            validationCommands: [validationFileExists(["result.txt"])],
            repositoryPath,
          },
          createRuntimeConfig(stateDirectory, fakeDshPath),
          {
            requestApproval: async () => undefined,
            resolveCredential: async () => "matrix-test-secret",
            runVerifier: async (request) => {
              verifierCallCount += 1;
              receivedPivots = request.pivots;
              const ranking = Array.from(
                { length: matrixCase.eligibleCandidateCount },
                (_, candidateIndex) => matrixCase.eligibleCandidateCount - candidateIndex - 1,
              );
              return {
                winnerIndex: matrixCase.eligibleCandidateCount - 1,
                scores: Array.from(
                  { length: matrixCase.eligibleCandidateCount },
                  (_, candidateIndex) => candidateIndex + 1,
                ),
                ranking,
                requestCount: 1,
                tokenUsage: { calls: 1 },
              };
            },
          },
        );

        assert.equal(result.requestedCandidateCount, matrixCase.candidateCount);
        assert.equal(result.completedCandidateCount, matrixCase.eligibleCandidateCount);
        assert.equal(result.eligibleCandidateCount, matrixCase.eligibleCandidateCount);
        if (matrixCase.eligibleCandidateCount === 0) {
          assert.equal(result.status, "no_winner");
          assert.equal(result.selectionMethod, null);
          assert.equal(result.winnerId, null);
          assert.equal(verifierCallCount, 0);
        } else if (matrixCase.eligibleCandidateCount === 1) {
          assert.equal(result.status, "winner_selected");
          assert.equal(result.selectionMethod, "validation_only");
          assert.equal(result.winnerId, "candidate-1");
          assert.equal(verifierCallCount, 0);
        } else {
          assert.equal(result.status, "winner_selected");
          assert.equal(result.selectionMethod, "llm_verifier");
          assert.equal(
            result.winnerId,
            `candidate-${matrixCase.eligibleCandidateCount}`,
          );
          assert.equal(result.ranking[0]?.candidateId, result.winnerId);
          assert.equal(verifierCallCount, 1);
          assert.equal(receivedPivots, Math.min(2, matrixCase.eligibleCandidateCount - 1));
        }
      } finally {
        await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      }
    }
  });

  it("reports complete logs, truncation, patch hashes, and binary metadata", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-llm-verifier-report-"));
    const repositoryPath = join(fixtureRoot, "repository");
    const stateDirectory = join(fixtureRoot, "state");
    const fakeDshPath = await writeFakeDsh(fixtureRoot, { mode: "large-and-binary" });
    await createCleanRepository(repositoryPath);
    const runtimeConfig = {
      ...createRuntimeConfig(stateDirectory, fakeDshPath),
      maxVerifierTraceBytes: 256,
    };
    const fullVerifierInputPaths: string[] = [];

    try {
      const result = await runVerifiedBestOf(
        {
          task: "Create a large text file and a binary file",
          candidateCount: 3,
          validationCommands: [validationFileExists(["large.txt", "binary.bin"])],
          repositoryPath,
        },
        runtimeConfig,
        {
          requestApproval: async () => undefined,
          resolveCredential: async () => "report-test-secret",
          runVerifier: async (request) => {
            for (const candidate of request.candidates) {
              assert.match(candidate.trajectory, /complete input retained locally/);
              assert.doesNotMatch(candidate.trajectory, /complete local file:/);
            }
            return {
              winnerIndex: 0,
              scores: [0.9, 0.5, 0.1],
              ranking: [0, 1, 2],
              requestCount: 36,
              tokenUsage: { calls: 36 },
            };
          },
        },
      );

      for (const candidateNumber of [1, 2, 3]) {
        const fullVerifierInputPath = join(
          stateDirectory,
          "runs",
          result.runId,
          "artifacts",
          `candidate-${candidateNumber}`,
          "verifier-input.full.txt",
        );
        fullVerifierInputPaths.push(fullVerifierInputPath);
        const fullVerifierInput = await readFile(fullVerifierInputPath, "utf8");
        assert.match(fullVerifierInput, /Binary files \(metadata only; no binary content\)/);
        assert.match(fullVerifierInput, /binary\.bin/);
        assert.match(fullVerifierInput, /gitObjectHash=[0-9a-f]{40,64}/);
      }

      assert.equal(fullVerifierInputPaths.length, 3);
      const report = await readFile(result.reportPath, "utf8");
      assert.match(report, /Plugin version: `0\.2\.0`/);
      assert.match(report, /Completed candidates: 3/);
      assert.match(report, /Candidates entered into ranking: 3/);
      assert.match(report, /Winner patch SHA-256: `[0-9a-f]{64}`/);
      assert.match(report, /Complete logs/);
      assert.match(report, /verifier input was truncated/);
      assert.match(report, /path="binary\.bin", size=3 bytes, hash=[0-9a-f]{40,64}/);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("does not rank a candidate that claims success but fails validation", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-llm-verifier-false-success-"));
    const repositoryPath = join(fixtureRoot, "repository");
    const stateDirectory = join(fixtureRoot, "state");
    const fakeDshPath = await writeFakeDsh(fixtureRoot, { mode: "false-success" });
    await createCleanRepository(repositoryPath);

    try {
      const result = await runVerifiedBestOf(
        {
          task: "Create required.txt",
          candidateCount: 3,
          validationCommands: [validationFileExists(["required.txt"])],
          repositoryPath,
        },
        createRuntimeConfig(stateDirectory, fakeDshPath),
        {
          requestApproval: async () => undefined,
          resolveCredential: async () => "false-success-secret",
          runVerifier: async () => {
            throw new Error("verifier must not run for a validation failure");
          },
        },
      );

      assert.equal(result.status, "no_winner");
      assert.equal(result.eligibleCandidateCount, 0);
      const falseSuccessCandidate = result.ranking.find(
        (candidate) => candidate.candidateId === "candidate-1",
      );
      assert.equal(falseSuccessCandidate?.executionStatus, "completed");
      assert.equal(falseSuccessCandidate?.validationStatus, "failed");
      assert.equal(falseSuccessCandidate?.score, null);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("the run's own total deadline aborts a candidate pool that never settles", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-run-deadline-"));
    const repositoryPath = join(fixtureRoot, "repository");
    const stateDirectory = join(fixtureRoot, "state");
    const fakeDshPath = await writeFakeDsh(fixtureRoot, { mode: "hang", startedPath: join(fixtureRoot, "started") });
    await createCleanRepository(repositoryPath);
    try {
      // Nothing else can fire here: the candidates hang, and the per-candidate and per-validation budgets
      // are 15x larger than the run budget, so this is the ONLY test that makes the product's own
      // `run timed out after` path happen. Wave 26 raised the fixture budgets without noticing that the
      // 30 s run budget was the one place that path had ever been exercised (under load, by accident).
      const result = await runVerifiedBestOf(
        {
          task: "Create result.txt",
          candidateCount: 2,
          validationCommands: [validationFileExists(["result.txt"])],
          repositoryPath,
        },
        { ...createRuntimeConfig(stateDirectory, fakeDshPath), runTimeoutMs: 4_000 },
        {
          requestApproval: async () => undefined,
          resolveCredential: async () => "",
          runVerifier: async () => {
            throw new Error("verifier must not run for a pool the deadline cancelled");
          },
        },
      );
      const statuses = result.ranking.map((c) => `${c.candidateId} ${c.executionStatus}/${c.validationStatus}`).join(" | ");
      assert.equal(result.status, "failed", `${statuses} -> ${result.failure ?? "no failure text"}`);
      assert.match(result.failure ?? "", /run timed out after 4000 ms/);
      assert.equal(result.winnerId, null, statuses);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("cancels running candidate process groups and removes their worktrees", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-llm-verifier-cancel-"));
    const repositoryPath = join(fixtureRoot, "repository");
    const stateDirectory = join(fixtureRoot, "state");
    const candidateStartedPath = join(fixtureRoot, "candidate-started");
    const fakeDshPath = await writeFakeDsh(fixtureRoot, { mode: "hang", startedPath: candidateStartedPath });
    await createCleanRepository(repositoryPath);
    const abortController = new AbortController();

    try {
      const resultPromise = runVerifiedBestOf(
        {
          task: "Create result.txt",
          candidateCount: 3,
          validationCommands: [validationFileExists(["result.txt"])],
          repositoryPath,
          signal: abortController.signal,
        },
        createRuntimeConfig(stateDirectory, fakeDshPath),
        {
          requestApproval: async () => undefined,
          resolveCredential: async () => "cancel-test-secret",
          runVerifier: async () => {
            throw new Error("verifier must not run after cancellation");
          },
        },
      );
      // No iteration cap: a fixed 200x10 ms was a machine-speed budget in disguise. The shipped hang
      // fixture's cold `node` start measures 58-247 ms on this box, and wave 26 measured a ~14x
      // contention factor for this suite inside the gate, so 247 ms x 14 = 3.5 s would throw here with
      // nothing wrong but a busy machine. Poll until it lands; `--test-timeout` on the gate's TS stage
      // is the ceiling allowed to fire instead.
      const startedBy = Date.now() + 60_000;
      for (;;) {
        try {
          await access(candidateStartedPath);
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          if (Date.now() > startedBy) throw error;
          await new Promise<void>((resolve) => setTimeout(resolve, 25));
        }
      }
      abortController.abort(new Error("test cancellation"));
      const result = await resultPromise;

      assert.equal(result.status, "failed");
      assert.match(result.failure ?? "", /cancelled|timeout/);
      assert.equal(
        result.ranking.every((candidate) => candidate.executionStatus === "cancelled"),
        true,
      );
      const { stdout: worktreeOutput } = await execFileAsync(
        "git",
        ["worktree", "list", "--porcelain"],
        { cwd: repositoryPath },
      );
      assert.doesNotMatch(worktreeOutput, /candidate-[123]/);
    } finally {
      abortController.abort();
      await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("rejects a candidate that writes the resolved credential into a changed file", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-llm-verifier-secret-"));
    const repositoryPath = join(fixtureRoot, "repository");
    const stateDirectory = join(fixtureRoot, "state");
    const fakeDshPath = await writeFakeDsh(fixtureRoot, { mode: "leak-key" });
    const credentialValue = "credential-must-never-persist";
    await createCleanRepository(repositoryPath);

    try {
      const result = await runVerifiedBestOf(
        {
          task: "Create a safe file",
          candidateCount: 3,
          validationCommands: [validationFileExists(["leaked.bin"])],
          repositoryPath,
        },
        createRuntimeConfig(stateDirectory, fakeDshPath),
        {
          requestApproval: async () => undefined,
          resolveCredential: async () => credentialValue,
          runVerifier: async () => {
            throw new Error("verifier must not run without eligible candidates");
          },
        },
      );

      assert.equal(result.status, "no_winner");
      assert.equal(result.eligibleCandidateCount, 0);
      assert.match(
        result.ranking.find((candidate) => candidate.candidateId === "candidate-1")?.failure ?? "",
        /contains the resolved credential/,
      );
      await assertTreeDoesNotContain(stateDirectory, credentialValue);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("reports verifier API failure without inventing a winner", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-llm-verifier-api-failure-"));
    const repositoryPath = join(fixtureRoot, "repository");
    const stateDirectory = join(fixtureRoot, "state");
    const fakeDshPath = await writeFakeDsh(fixtureRoot, { mode: "basename-result" });
    await createCleanRepository(repositoryPath);

    try {
      const result = await runVerifiedBestOf(
        {
          task: "Create result.txt",
          candidateCount: 3,
          validationCommands: [validationFileExists(["result.txt"])],
          repositoryPath,
        },
        createRuntimeConfig(stateDirectory, fakeDshPath),
        {
          requestApproval: async () => undefined,
          resolveCredential: async () => "test-secret",
          runVerifier: async () => {
            throw new Error("verifier service unavailable");
          },
        },
      );

      assert.equal(result.status, "failed");
      assert.equal(result.winnerId, null);
      assert.equal(result.winnerPatchPath, null);
      assert.match(result.failure ?? "", /verifier service unavailable/);
      assert.match(await readFile(result.reportPath, "utf8"), /verifier service unavailable/);
      assert.match(
        await readFile(join(dirname(result.reportPath), "verifier.log"), "utf8"),
        /verifier service unavailable/,
      );
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("hands off to the parent agent with the reviewer's actual cause", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-llm-verifier-handoff-"));
    const repositoryPath = join(fixtureRoot, "repository");
    const stateDirectory = join(fixtureRoot, "state");
    const fakeDshPath = await writeFakeDsh(fixtureRoot, { mode: "basename-result" });
    await createCleanRepository(repositoryPath);

    try {
      const result = await runVerifiedBestOf(
        {
          task: "Create result.txt",
          candidateCount: 2,
          validationCommands: [validationFileExists(["result.txt"])],
          repositoryPath,
        },
        {
          ...createRuntimeConfig(stateDirectory, fakeDshPath),
          reviewFailurePolicy: "parent_agent",
        },
        {
          requestApproval: async () => undefined,
          resolveCredential: async () => "handoff-test-secret",
          runVerifier: async () => {
            throw new Error("verifier service unavailable");
          },
        },
      );

      // A handoff caused by a broken reviewer has to say so: review_pending with
      // `failure: none` reads as an ordinary parent-agent choice.
      assert.equal(result.status, "review_pending");
      assert.match(result.failure ?? "", /verifier service unavailable/);
      assert.match(await readFile(result.reportPath, "utf8"), /verifier service unavailable/);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("keeps the run artifacts when the verifier answers with a rejected ranking", async () => {
    // A verifier (an LLM) returning `ranking[0] !== winnerIndex` is a routine
    // event, and it is caught *after* `verifier.log` was already written. Logging
    // that failure must not then throw EEXIST out of the run: the captured patch
    // is only applicable through the manifest and report written further down.
    const fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-llm-verifier-rejected-ranking-"));
    const repositoryPath = join(fixtureRoot, "repository");
    const stateDirectory = join(fixtureRoot, "state");
    const fakeDshPath = await writeFakeDsh(fixtureRoot, { mode: "basename-result" });
    await createCleanRepository(repositoryPath);

    try {
      const result = await runVerifiedBestOf(
        {
          task: "Create result.txt",
          candidateCount: 2,
          validationCommands: [validationFileExists(["result.txt"])],
          repositoryPath,
        },
        createRuntimeConfig(stateDirectory, fakeDshPath),
        {
          requestApproval: async () => undefined,
          resolveCredential: async () => "rejected-ranking-secret",
          runVerifier: async () => ({
            winnerIndex: 0,
            scores: [0.9, 0.5],
            ranking: [1, 0],
            requestCount: 8,
            tokenUsage: { calls: 8 },
          }),
        },
      );

      assert.equal(result.status, "failed");
      assert.equal(result.winnerId, null);
      assert.match(result.failure ?? "", /invalid verifier winner/u);
      assert.doesNotMatch(result.failure ?? "", /EEXIST|EPERM|EBUSY/u);
      const runDirectory = dirname(result.reportPath);
      const verifierLog = await readFile(join(runDirectory, "verifier.log"), "utf8");
      // Read back, not just "the write succeeded": the log has to name the
      // failure while keeping the rejected payload it is evidence about.
      assert.match(verifierLog, /"failure": "invalid verifier winner/u);
      assert.match(verifierLog, /winnerIndex 0 does not match ranking\[0\] 1/u);
      assert.match(verifierLog, /"requestCount": 8/u);
      assert.doesNotMatch(verifierLog, /rejected-ranking-secret/u);
      const manifest = JSON.parse(await readFile(join(runDirectory, "manifest.json"), "utf8")) as {
        result: { status: string, failure: string | null };
      };
      assert.equal(manifest.result.status, "failed");
      assert.match(manifest.result.failure ?? "", /invalid verifier winner/u);
      assert.match(await readFile(result.reportPath, "utf8"), /invalid verifier winner/u);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("rewrites the successful verifier payload with the failure it hides", async () => {
    // Under the parent-agent policy the same rewrite used to be swallowed by a
    // `.catch(() => {})`, leaving a `verifier.log` that claimed the reviewer
    // succeeded for a run that actually fell back to the parent agent.
    const fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-llm-verifier-rejected-ranking-handoff-"));
    const repositoryPath = join(fixtureRoot, "repository");
    const stateDirectory = join(fixtureRoot, "state");
    const fakeDshPath = await writeFakeDsh(fixtureRoot, { mode: "basename-result" });
    await createCleanRepository(repositoryPath);

    try {
      const result = await runVerifiedBestOf(
        {
          task: "Create result.txt",
          candidateCount: 2,
          validationCommands: [validationFileExists(["result.txt"])],
          repositoryPath,
        },
        {
          ...createRuntimeConfig(stateDirectory, fakeDshPath),
          reviewFailurePolicy: "parent_agent",
        },
        {
          requestApproval: async () => undefined,
          resolveCredential: async () => "handoff-ranking-secret",
          runVerifier: async () => ({
            winnerIndex: 0,
            scores: [0.9],
            ranking: [0, 1],
            requestCount: 8,
            tokenUsage: { calls: 8 },
          }),
        },
      );

      assert.equal(result.status, "review_pending");
      assert.match(result.failure ?? "", /invalid verifier scores/u);
      const runDirectory = dirname(result.reportPath);
      const verifierLog = await readFile(join(runDirectory, "verifier.log"), "utf8");
      assert.match(verifierLog, /"failure": "invalid verifier scores/u);
      assert.match(verifierLog, /expected 2 finite scores, got \[0\.9\]/u);
      // The handoff must not be disclosed only in a log the run overwrote: the
      // rewrite failing would leave the success payload as the whole record.
      const manifest = JSON.parse(await readFile(join(runDirectory, "manifest.json"), "utf8")) as {
        warnings: string[];
      };
      assert.ok(
        manifest.warnings.every((warning) => !/does not record the review failure/u.test(warning)),
        `verifier.log rewrite failed: ${JSON.stringify(manifest.warnings)}`,
      );
      assert.match(await readFile(result.reportPath, "utf8"), /invalid verifier scores/u);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("refuses to apply a winner that was re-selected while it awaited approval", async () => {
    // selection.json is the durable audit record. Apply read it, then waited for
    // a human, then applied the bytes of the candidate it read first; a second
    // session's selection during that wait made the record and the tree disagree.
    const fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-llm-verifier-selection-race-"));
    const repositoryPath = join(fixtureRoot, "repository");
    const stateDirectory = join(fixtureRoot, "state");
    const fakeDshPath = await writeFakeDsh(fixtureRoot, { mode: "basename-result" });
    await createCleanRepository(repositoryPath);
    const config: RunSettings = {
      ...createRuntimeConfig(stateDirectory, fakeDshPath),
      reviewMode: "parent_agent",
    };

    try {
      const run = await runVerifiedBestOf(
        {
          task: "Create result.txt",
          candidateCount: 2,
          validationCommands: [validationFileExists(["result.txt"])],
          repositoryPath,
        },
        config,
        {
          requestApproval: async () => undefined,
          resolveCredential: async () => "selection-race-secret",
          runVerifier: async () => {
            throw new Error("verifier must not run in parent-agent review mode");
          },
        },
      );
      assert.equal(run.status, "review_pending");
      const runDirectory = dirname(run.reportPath);
      const applyDependencies = {
        requestApproval: async () => undefined,
        resolveCredential: async () => "",
      };

      // Selecting is a read-modify-write on the run, so it waits for the same
      // repository lock apply and rollback take. Plant a live holder's record.
      const canonicalRepositoryPath = await realpath(repositoryPath);
      const lockPath = join(
        stateDirectory,
        "locks",
        `${createHash("sha256").update(canonicalRepositoryPath).digest("hex")}.lock`,
      );
      await writeFile(lockPath, `${JSON.stringify({
        repositoryPath: canonicalRepositoryPath,
        pid: process.pid,
        hostname: hostname(),
        createdAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
      })}\n`);
      await assert.rejects(
        selectVerifiedCandidate(
          { runId: run.runId, repositoryPath, candidateId: "candidate-1", reason: "blocked by a peer" },
          config,
        ),
        /another verifier operation is running/u,
      );
      // Blocked means nothing was recorded, not "recorded anyway".
      await assert.rejects(readFile(join(runDirectory, "selection.json")), /ENOENT/u);
      await rm(lockPath, { force: true });

      const firstChoice = await selectVerifiedCandidate(
        { runId: run.runId, repositoryPath, candidateId: "candidate-1", reason: "smallest diff" },
        config,
      );
      assert.equal(firstChoice.candidateId, "candidate-1");
      assert.equal(
        (JSON.parse(await readFile(join(runDirectory, "selection.json"), "utf8")) as {
          candidateId: string;
        }).candidateId,
        "candidate-1",
      );

      await assert.rejects(
        applyVerifiedWinner(
          { runId: run.runId, repositoryPath },
          config,
          {
            ...applyDependencies,
            // The peer session selects again while this apply sits on the
            // approval prompt; `apply` must notice before it mutates anything.
            requestApproval: async () => {
              await selectVerifiedCandidate(
                { runId: run.runId, repositoryPath, candidateId: "candidate-2", reason: "changed my mind" },
                config,
              );
            },
          },
        ),
        /selection changed to "candidate-2" while run .* awaited approval, but "candidate-1" was prepared/u,
      );
      await assert.rejects(readFile(join(runDirectory, "apply-state.json")));
      const { stdout: statusOutput } = await execFileAsync(
        "git",
        ["status", "--porcelain=v1", "--untracked-files=all"],
        { cwd: repositoryPath },
      );
      assert.equal(statusOutput, "");

      const applied = await applyVerifiedWinner(
        { runId: run.runId, repositoryPath },
        config,
        applyDependencies,
      );
      assert.equal(applied.status, "applied");
      assert.deepEqual(applied.changedFiles, ["result.txt"]);
      assert.equal(
        (await readFile(join(repositoryPath, "result.txt"), "utf8")).replaceAll("\r\n", "\n"),
        "candidate-2\n",
      );
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("names the install step when the auto-detected JavaScript validation fails", async () => {
    // Auto-detection has to produce a command that works in a fresh worktree
    // with no node_modules, and when it cannot, the reason has to say "install"
    // instead of reading as "no candidate passed validation".
    const fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-llm-verifier-autoinstall-"));
    const repositoryPath = join(fixtureRoot, "repository");
    const stateDirectory = join(fixtureRoot, "state");
    const fakeDshPath = await writeFakeDsh(fixtureRoot, { mode: "winner" });
    await createCleanRepository(repositoryPath);
    await writeFile(
      join(repositoryPath, "package.json"),
      JSON.stringify({ scripts: { test: "node --version" }, dependencies: { "left-pad": "^1.3.0" } }),
    );
    await writeFile(join(repositoryPath, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\nsettings: {}\nimporters:\n  .: {}\n");
    await execFileAsync("git", ["add", "package.json", "pnpm-lock.yaml"], { cwd: repositoryPath });
    await execFileAsync("git", ["commit", "--quiet", "-m", "javascript fixture"], { cwd: repositoryPath });

    try {
      const result = await runVerifiedBestOf(
        { task: "Create result.txt", candidateCount: 1, repositoryPath },
        createRuntimeConfig(stateDirectory, fakeDshPath),
        {
          requestApproval: async () => undefined,
          resolveCredential: async () => "autoinstall-test-secret",
          runVerifier: async () => { throw new Error("verifier must not run"); },
        },
      );

      assert.equal(result.status, "no_winner");
      assert.equal(result.ranking[0]?.validationStatus, "failed");
      assert.match(result.ranking[0]?.failure ?? "", /pnpm install --frozen-lockfile/);
      // The install step ran in the candidate's own worktree, where a bare
      // checkout has no node_modules to test against.
      const worktreeValidationLog = await readFile(
        join(stateDirectory, "runs", result.runId, "artifacts", "candidate-1", "validation-1.log"),
        "utf8",
      );
      assert.match(worktreeValidationLog, /^\$ pnpm install --frozen-lockfile$/mu);
      // and it is not part of the command list the post-apply revalidation runs
      // inside the user's repository, where an install would wipe their
      // node_modules, may rewrite the lockfile, and is never undone by rollback.
      const manifest = JSON.parse(await readFile(
        join(stateDirectory, "runs", result.runId, "manifest.json"),
        "utf8",
      )) as { validationCommands: string[] };
      assert.deepEqual(manifest.validationCommands, ["pnpm test"]);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("keeps the applied patch when post-apply validation fails", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-llm-verifier-post-apply-"));
    const repositoryPath = join(fixtureRoot, "repository");
    const stateDirectory = join(fixtureRoot, "state");
    const fakeDshPath = await writeFakeDsh(fixtureRoot, { mode: "winner" });
    await createCleanRepository(repositoryPath);
    const runtimeConfig = createRuntimeConfig(stateDirectory, fakeDshPath);
    const winnerOnlyValidationCommand = IS_WINDOWS
      ? `echo %CD% | findstr /C:candidate-1 >NUL && exit /b 0 || exit /b 1`
      : `case "$PWD" in *candidate-1) exit 0 ;; *) exit 1 ;; esac`;

    try {
      const selectionResult = await runVerifiedBestOf(
        {
          task: "Create result.txt",
          candidateCount: 3,
          validationCommands: [winnerOnlyValidationCommand],
          repositoryPath,
        },
        runtimeConfig,
        {
          requestApproval: async () => undefined,
          resolveCredential: async () => "test-secret",
          runVerifier: async () => {
            throw new Error("verifier must not run with one eligible candidate");
          },
        },
      );
      const applyResult = await applyVerifiedWinner(
        { runId: selectionResult.runId, repositoryPath },
        runtimeConfig,
        {
          requestApproval: async () => undefined,
          resolveCredential: async () => "test-secret",
        },
      );

      assert.equal(applyResult.status, "applied_validation_failed");
      assert.equal(applyResult.validationStatus, "failed");
      assert.match(applyResult.failure ?? "", /post-apply validation failed/);
      assert.equal(
        (await readFile(join(repositoryPath, "result.txt"), "utf8")).replaceAll("\r\n", "\n"),
        "winner\n",
      );
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});

describe("Windows command line and interrupted worktrees", () => {
  const reviewDependencies = {
    requestApproval: async () => undefined,
    resolveCredential: async () => "",
    runVerifier: async () => {
      throw new Error("verifier must not run");
    },
  };

  it("refuses cmd-unsafe run values before any repository work", { skip: !IS_WINDOWS && "Windows cmd.exe command line" }, async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-cmd-guard-"));
    const stateDirectory = join(fixtureRoot, "state");
    // Not a repository at all: a guard that did not fire gets a `git rev-parse`
    // failure instead, so each assertion below also proves the refusal happened
    // at the boundary rather than after the run started.
    const notARepository = join(fixtureRoot, "not-a-repository");
    await assert.rejects(
      runVerifiedBestOf(
        { task: 'x" & echo PWNED & "y', repositoryPath: notARepository },
        createRuntimeConfig(stateDirectory, "dsh"),
        reviewDependencies,
      ),
      /invalid task.*cmd\.exe reinterprets/s,
    );
    await assert.rejects(
      runVerifiedBestOf(
        { task: "Create result.txt", repositoryPath: notARepository },
        { ...createRuntimeConfig(stateDirectory, "dsh"), candidateProfile: 'head"less' },
        reviewDependencies,
      ),
      /invalid candidateProfile.*cmd\.exe reinterprets/s,
    );
    await assert.rejects(
      runVerifiedBestOf(
        { task: "Create result.txt", repositoryPath: notARepository },
        createRuntimeConfig(stateDirectory, "C:\\Program Files\\dsh\\dsh.cmd"),
        reviewDependencies,
      ),
      /invalid dshExecutable.*whitespace/s,
    );
    await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("names the missing harness binary in the failure instead of cmd.exe's message", { skip: !IS_WINDOWS && "Windows cmd.exe resolution" }, async () => {
    // The default `dshExecutable: "dsh"` on a host without the harness: the
    // direct spawn ENOENTs, cmd.exe retries, and its "is not recognized" was
    // recorded as a candidate failure — a fake model outcome the report then
    // asked the model to explain.
    const fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-missing-harness-"));
    const repositoryPath = join(fixtureRoot, "repository");
    await createCleanRepository(repositoryPath);
    try {
      const run = await runVerifiedBestOf(
        {
          task: "Create result.txt",
          candidateCount: 1,
          validationCommands: [validationFileExists(["result.txt"])],
          repositoryPath,
        },
        createRuntimeConfig(join(fixtureRoot, "state"), "dsh-never-installed-on-this-host"),
        reviewDependencies,
      );
      // The status vocabulary is unchanged: this is still a failed candidate.
      assert.equal(run.status, "no_winner");
      assert.equal(run.eligibleCandidateCount, 0);
      assert.equal(run.ranking[0]?.executionStatus, "failed");
      assert.match(run.ranking[0]?.failure ?? "", /could not be launched/u);
      assert.match(run.ranking[0]?.failure ?? "", /dsh-never-installed-on-this-host/u);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("cleans up a worktree whose checkout failed after git registered it", async () => {
    // `git worktree add` registers the worktree, checks it out, then runs the
    // repository's `post-checkout` hook and dies on its exit status. The
    // registration and a half-valid directory therefore outlive the failed
    // command, and `git worktree prune` will not touch a registration whose
    // working tree exists — only the run's own cleanup loop can remove it, and
    // it can only do that if it learned the path before the await rejected.
    const fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-worktree-interrupt-"));
    const repositoryPath = join(fixtureRoot, "repository");
    await createCleanRepository(repositoryPath);
    await writeFile(join(repositoryPath, ".git", "hooks", "post-checkout"), "#!/bin/sh\nexit 1\n");
    try {
      await assert.rejects(
        runVerifiedBestOf(
          {
            task: "Create result.txt",
            candidateCount: 3,
            validationCommands: [validationFileExists(["result.txt"])],
            repositoryPath,
          },
          createRuntimeConfig(join(fixtureRoot, "state"), await writeFakeDsh(fixtureRoot, { mode: "basename-result" })),
          reviewDependencies,
        ),
        /git worktree failed/u,
      );
      const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"], { cwd: repositoryPath });
      const listed = stdout.split(/\r?\n/u).filter((line) => line.startsWith("worktree "));
      assert.equal(listed.length, 1, `failed worktree add left a registration behind:\n${stdout}`);
      // And no half-created directory kept on disk: the run recorded nothing
      // about the candidate it never got to, so a leak here is invisible to the
      // report and piles up one directory per refused run.
      const runDirectories = await readdir(join(fixtureRoot, "state", "runs")).catch(() => [] as string[]);
      assert.equal(runDirectories.length > 0, true, "the refused run recorded nothing at all");
      for (const runId of runDirectories) {
        const remaining = await readdir(join(fixtureRoot, "state", "runs", runId, "worktrees")).catch(() => [] as string[]);
        assert.deepEqual(remaining, [], `candidate worktrees left behind in run ${runId}`);
      }
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("records a selection for a review_pending run whose tree the user kept editing", async () => {
    // selection.json is metadata about the run; it changes no tracked file. The
    // clean-tree requirement belongs to apply, which is where the tree is
    // mutated, and holding the recording hostage made every edit after a
    // review_pending run cost the user their recorded winner.
    const fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-select-dirty-tree-"));
    const repositoryPath = join(fixtureRoot, "repository");
    await createCleanRepository(repositoryPath);
    try {
      const config: RunSettings = {
        ...createRuntimeConfig(join(fixtureRoot, "state"), await writeFakeDsh(fixtureRoot, { mode: "basename-result" })),
        reviewMode: "parent_agent",
      };
      const run = await runVerifiedBestOf(
        {
          task: "Create result.txt",
          candidateCount: 2,
          validationCommands: [validationFileExists(["result.txt"])],
          repositoryPath,
        },
        config,
        reviewDependencies,
      );
      assert.equal(run.status, "review_pending");
      await writeFile(join(repositoryPath, "my-own-work.txt"), "the user kept coding\n");
      const selection = await selectVerifiedCandidate(
        { runId: run.runId, repositoryPath, candidateId: "candidate-1", reason: "smallest diff" },
        config,
      );
      assert.equal(selection.candidateId, "candidate-1");
      // Apply still requires the clean tree: relaxing selection must not relax
      // the one place a mutation happens.
      await assert.rejects(
        applyVerifiedWinner({ runId: run.runId, repositoryPath }, config, {
          requestApproval: async () => undefined,
          resolveCredential: async () => "",
        }),
        /repository must be clean/u,
      );
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});

describe("host settings document as run settings", () => {
  /**
   * The `dsh-settings` seam, driven the way the web host drives it: register()
   * hands back the scope a run reads, describe() the namespace revisions.
   * `settings.ts` casts `scope.get()` to RunSettings unchecked, so whatever this
   * returns is live input to every tool, and until now nothing in this suite ever
   * put a scope behind it: the N18/N27 guards were only ever fed hand-built
   * configs, never their real producer.
   */
  function registerSettingsScope(section: RunSettings, described: unknown): void {
    const context = {
      inject(_services: string[], callback: (scoped: never) => void) {
        callback({
          settings: {
            register: () => ({ get: () => section }),
            describe: () => described,
          },
        } as never);
      },
    };
    registerVerifierSettings(context as unknown as Context, section);
  }

  it("runs on the registered document, and refuses its unknown reviewMode by name", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-scope-review-mode-"));
    try {
      const repositoryPath = join(fixtureRoot, "repository");
      await createCleanRepository(repositoryPath);
      const fakeDshPath = await writeFakeDsh(fixtureRoot, { mode: "matrix", total: 2, eligible: 2 });
      const fallback = createRuntimeConfig(join(fixtureRoot, "state"), fakeDshPath);
      // A persisted document this build cannot honor: a stale or typo'd mode, plus
      // one field only the document carries, to prove which one the run read.
      const document: RunSettings = {
        ...fallback,
        candidateProfile: "scope-profile",
        reviewMode: "auto" as unknown as RunSettings["reviewMode"],
      };
      registerSettingsScope(document, [{ ns: SETTINGS_NAMESPACE, revision: 41 }]);
      const { section, settingsRevision } = resolveRunSettings(fallback);
      // The scope wins over the headless fallback, in both directions.
      assert.equal(section.candidateProfile, "scope-profile");
      assert.equal(section.reviewMode, "auto");
      assert.equal(settingsRevision, 41);
      const result = await runVerifiedBestOf({
        task: "Create result.txt",
        candidateCount: 2,
        validationCommands: [validationFileExists(["result.txt"])],
        repositoryPath,
        settingsRevision,
      }, section, {
        requestApproval: async () => undefined,
        resolveCredential: async () => "",
        runVerifier: async () => { throw new Error("the fallback's deepseek_verifier mode must not run"); },
        reviewCandidates: async () => { throw new Error("the fallback's reviewer must not run"); },
      });
      assert.match(
        result.failure ?? "",
        /unknown reviewMode "auto": this build implements parent_agent, dsh_model and deepseek_verifier/,
        "an out-of-vocabulary reviewMode from the host document must be the run's stated failure",
      );
      assert.equal(result.status, "failed");
      // And the record says so too, rather than the manifest describing a run
      // that never happened.
      const manifest = JSON.parse(await readFile(join(fixtureRoot, "state", "runs", result.runId, "manifest.json"), "utf8")) as {
        resolvedConfig: Record<string, string | number | boolean | string[]>;
        settingsRevision: number | null;
      };
      assert.equal(manifest.resolvedConfig["candidateProfile"], "scope-profile");
      assert.equal(manifest.settingsRevision, 41);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("refuses the document's unknown validationMode instead of auto-detecting", async () => {
    const fallback = createRuntimeConfig(join(tmpdir(), "dsh-scope-unused-state"), "dsh");
    const document: RunSettings = {
      ...fallback,
      validationMode: "configuredd" as unknown as RunSettings["validationMode"],
      validationCommands: ["node -e 0"],
    };
    // The other `describe()` shape the host can answer with.
    registerSettingsScope(document, { namespaces: [{ ns: "other", revision: 1 }, { ns: SETTINGS_NAMESPACE, revision: 7 }] });
    const { section, settingsRevision } = resolveRunSettings(fallback);
    assert.equal(settingsRevision, 7);
    // The refusal is what a run answers with; the fallback's valid "auto" would
    // have started candidates from a document nobody asked for.
    await assert.rejects(
      runVerifiedBestOf(
        { task: "Create result.txt", repositoryPath: "not-a-repository" },
        section,
        {
          requestApproval: async () => undefined,
          resolveCredential: async () => "",
          runVerifier: async () => { throw new Error("must not reach the verifier"); },
        },
      ),
      /invalid validationMode "configuredd": this build implements "auto" and "configured"/,
    );
  });

  it("reports no revision when the host describes no namespace for it", () => {
    const fallback = createRuntimeConfig(join(tmpdir(), "dsh-scope-unused-state"), "dsh");
    registerSettingsScope(fallback, { namespaces: [{ ns: "other", revision: 3 }] });
    assert.equal(resolveRunSettings(fallback).settingsRevision, null);
    registerSettingsScope(fallback, []);
    assert.equal(resolveRunSettings(fallback).settingsRevision, null);
  });
});
