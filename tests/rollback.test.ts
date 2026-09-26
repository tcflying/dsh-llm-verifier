import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, describe, it } from "node:test";

import type { RuntimeDependencies } from "../src/contracts.ts";
import type { RunSettings } from "../src/settings.ts";
import { applyVerifiedWinner, patchTouchedFiles, rollbackVerifiedWinner, runVerifiedBestOf } from "../src/core.ts";

const execFileAsync = promisify(execFile);
const testDirectory = dirname(fileURLToPath(import.meta.url));
const IS_WINDOWS = process.platform === "win32";
const createdFixtureRoots: string[] = [];

after(async () => {
  for (const path of createdFixtureRoots.splice(0)) {
    await rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

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
  return wrapperPath;
}

function validationFileExists(paths: readonly string[]): string {
  return IS_WINDOWS
    ? paths.map((path) => `if not exist ${path} exit 1`).join(" && ")
    : paths.map((path) => `test -f ${path}`).join(" && ");
}

type FixtureMode = "winner" | "modify-and-add" | "rename" | "long-file";

const fixtureValidationCommand: Record<FixtureMode, string> = {
  winner: validationFileExists(["result.txt"]),
  "modify-and-add": validationFileExists(["added-by-winner.txt"]),
  rename: validationFileExists(["renamed-victim.txt"]),
  "long-file": IS_WINDOWS
    ? "findstr /C:winner-line notes.md >NUL"
    : "grep -q winner-line notes.md",
};

const fixtureBaseFiles: Partial<Record<FixtureMode, Record<string, string>>> = {
  rename: { "victim.txt": "victim content\n" },
  "long-file": {
    "notes.md": `${Array.from({ length: 60 }, (_, index) => `line-${index + 1}`).join("\n")}\n`,
  },
};

async function createCleanRepository(
  repositoryPath: string,
  extraFiles: Record<string, string> = {},
): Promise<void> {
  await execFileAsync("git", ["init", "--quiet", repositoryPath]);
  await execFileAsync("git", ["config", "user.email", "tests@example.invalid"], { cwd: repositoryPath });
  await execFileAsync("git", ["config", "user.name", "Verifier Tests"], { cwd: repositoryPath });
  await writeFile(join(repositoryPath, "README.md"), "fixture\n");
  for (const [name, contents] of Object.entries(extraFiles)) {
    await writeFile(join(repositoryPath, name), contents);
  }
  await execFileAsync("git", ["add", "--all"], { cwd: repositoryPath });
  await execFileAsync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: repositoryPath });
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
    // and 26) with nothing wrong but slow spawns on a box whose spare CPU was under one core. The
    // timeout machinery is still under test elsewhere with its own tiny budgets (process.test.ts:63,
    // reviewer.test.ts:98, core.integration.test.ts:720), and the N31 deadline group below injects its
    // own abort, so none of those depend on these three numbers.
    candidateTimeoutMs: 60_000,
    validationTimeoutMs: 60_000,
    runTimeoutMs: 180_000,
    maxVerifierTraceBytes: 512 * 1024,
    stateDirectory,
    dshExecutable,
  };
}

async function porcelain(repositoryPath: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { cwd: repositoryPath },
  );
  return stdout.replaceAll("\r\n", "\n");
}

const applyDependencies = {
  requestApproval: async () => undefined,
  resolveCredential: async () => "",
};

/** Runs a fixture to completion; its winner is not applied yet. */
async function fixtureRun(label: string, mode: FixtureMode): Promise<{
  readonly repositoryPath: string;
  readonly stateDirectory: string;
  readonly config: RunSettings;
  readonly runId: string;
  readonly runDirectory: string;
}> {
  const fixtureRoot = await mkdtemp(join(tmpdir(), label));
  createdFixtureRoots.push(fixtureRoot);
  const repositoryPath = join(fixtureRoot, "repository");
  const stateDirectory = join(fixtureRoot, "state");
  const fakeDshPath = await writeFakeDsh(fixtureRoot, { mode });
  await createCleanRepository(repositoryPath, fixtureBaseFiles[mode] ?? {});
  const config = createRuntimeConfig(stateDirectory, fakeDshPath);
  const run = await runVerifiedBestOf(
    {
      task: "Fix the fixture",
      candidateCount: 3,
      validationCommands: [fixtureValidationCommand[mode]],
      repositoryPath,
    },
    config,
    { ...applyDependencies, runVerifier: async () => { throw new Error("verifier must not run"); } },
  );
  assert.equal(
    run.status,
    "winner_selected",
    `ranking: ${run.ranking.map((candidate) => `${candidate.candidateId} ${candidate.executionStatus}/${candidate.validationStatus} ${candidate.failure ?? "none"}`).join(" | ")}`,
  );
  return { repositoryPath, stateDirectory, config, runId: run.runId, runDirectory: join(stateDirectory, "runs", run.runId) };
}

/** Runs a fixture to completion and applies its winner. */
async function applyFixtureRun(label: string, mode: FixtureMode): Promise<{
  readonly repositoryPath: string;
  readonly stateDirectory: string;
  readonly config: RunSettings;
  readonly runId: string;
  readonly runDirectory: string;
}> {
  const fixture = await fixtureRun(label, mode);
  const applied = await applyVerifiedWinner(
    { runId: fixture.runId, repositoryPath: fixture.repositoryPath },
    fixture.config,
    applyDependencies,
  );
  assert.equal(applied.status, "applied", `validation ${applied.validationStatus}: ${applied.failure ?? "none"}`);
  return fixture;
}

/**
 * Simulates a host killed between the `applying` record and its completion:
 * status downgraded, post-apply hashes dropped, exactly what the real
 * interrupted apply leaves in `apply-state.json`.
 */
async function markRecordApplying(runDirectory: string): Promise<void> {
  const statePath = join(runDirectory, "apply-state.json");
  const record = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
  await writeFile(statePath, `${JSON.stringify({ ...record, status: "applying", appliedFileSha256: {} }, null, 2)}\n`);
}

async function readText(repositoryPath: string, path: string): Promise<string> {
  return (await readFile(join(repositoryPath, path), "utf8")).replaceAll("\r\n", "\n");
}

/**
 * Blocks until `path` exists. No iteration cap: the only correct exit is the file
 * landing, and a budget counted from test start would give up on a loaded box and
 * report a red that is really just a slow box — node:test's own per-test timeout is
 * the ceiling allowed to fire instead.
 */
async function waitForFile(path: string): Promise<void> {
  for (;;) {
    try {
      await stat(path);
      return;
    } catch {
      await new Promise((resolve) => {
        setTimeout(resolve, 5);
      });
    }
  }
}

/**
 * The run's validation command, committed to the fixture repository so it is present
 * in the candidate worktrees and in the repository itself. Both phases run one
 * command string: in a worktree it is the run's own check, in the repository it is
 * the post-apply revalidation, and only that second one has to hold the lock open so
 * a test can knock on it.
 */
const applyBlockerSource = [
  'import { existsSync, writeFileSync } from "node:fs";',
  'import { basename } from "node:path";',
  'if (!existsSync("result.txt")) {',
  "  process.exit(1);",
  "}",
  'if (basename(process.cwd()).startsWith("candidate-")) {',
  "  process.exit(0);",
  "}",
  'writeFileSync("../apply-witness", "");',
  'while (!existsSync("../apply-release")) {',
  "  await new Promise((resolve) => {",
  "    setTimeout(resolve, 20);",
  "  });",
  "}",
].join("\n");

/** A `winner` run whose persisted validation command blocks the post-apply pass. */
async function blockerFixtureRun(label: string): Promise<{
  readonly repositoryPath: string;
  readonly config: RunSettings;
  readonly runId: string;
  readonly witnessPath: string;
  readonly releasePath: string;
}> {
  const fixtureRoot = await mkdtemp(join(tmpdir(), label));
  createdFixtureRoots.push(fixtureRoot);
  const repositoryPath = join(fixtureRoot, "repository");
  const stateDirectory = join(fixtureRoot, "state");
  const fakeDshPath = await writeFakeDsh(fixtureRoot, { mode: "winner" });
  await createCleanRepository(repositoryPath, { "apply-blocker.mjs": `${applyBlockerSource}\n` });
  const config = createRuntimeConfig(stateDirectory, fakeDshPath);
  const run = await runVerifiedBestOf(
    {
      task: "Fix the fixture",
      candidateCount: 3,
      validationCommands: ["node apply-blocker.mjs"],
      repositoryPath,
    },
    config,
    { ...applyDependencies, runVerifier: async () => { throw new Error("verifier must not run"); } },
  );
  assert.equal(
    run.status,
    "winner_selected",
    `ranking: ${run.ranking.map((candidate) => `${candidate.candidateId} ${candidate.executionStatus}/${candidate.validationStatus} ${candidate.failure ?? "none"}`).join(" | ")}`,
  );
  return {
    repositoryPath,
    config,
    runId: run.runId,
    witnessPath: join(fixtureRoot, "apply-witness"),
    releasePath: join(fixtureRoot, "apply-release"),
  };
}

describe("rollback of an applied winner", () => {
  it("restores the tree when the winner patch adds a new file", async () => {
    const { repositoryPath, stateDirectory, config, runId, runDirectory } = await applyFixtureRun("dsh-rb-add-", "winner");
    assert.deepEqual((await porcelain(repositoryPath)).trim(), "?? result.txt");
    // The applied patch creates an untracked file, so the tree is dirty here.
    assert.equal(await readText(repositoryPath, "result.txt"), "winner\n");

    const rollback = await rollbackVerifiedWinner({ runId, repositoryPath }, config);
    assert.equal(rollback.status, "rolled_back");
    assert.deepEqual(rollback.changedFiles, ["result.txt"]);
    assert.equal(await porcelain(repositoryPath), "");
    await assert.rejects(readFile(join(repositoryPath, "result.txt")));
    assert.equal(
      (await readFile(join(stateDirectory, "runs", runId, "rollback-result.json"), "utf8")).length > 0,
      true,
    );
    await assert.rejects(readFile(join(runDirectory, "apply-state.json")));
  });

  it("reverts a modified HEAD-known file and deletes an added file in one patch", async () => {
    // B1's partition, both halves: `git checkout HEAD --` for the modified
    // README.md and `rm` for the file the patch added (unknown to HEAD).
    const { repositoryPath, config, runId } = await applyFixtureRun("dsh-rb-mixed-", "modify-and-add");
    assert.deepEqual(
      (await porcelain(repositoryPath)).trim().split(/\r?\n/).map((line) => line.trim()).sort(),
      ["?? added-by-winner.txt", "M README.md"],
    );

    const rollback = await rollbackVerifiedWinner({ runId, repositoryPath }, config);
    assert.equal(rollback.status, "rolled_back");
    assert.deepEqual(rollback.changedFiles.sort(), ["README.md", "added-by-winner.txt"]);
    assert.equal(await porcelain(repositoryPath), "");
    assert.equal(await readText(repositoryPath, "README.md"), "fixture\n");
    await assert.rejects(readFile(join(repositoryPath, "added-by-winner.txt")));
  });

  it("restores both sides of a rename and leaves the tree identical to HEAD", async () => {
    // Git reports a rename as one path when rename detection is on, so a
    // changed-files list built that way knows only the destination: `rm` deletes
    // it and the source stays deleted, losing both files.
    const { repositoryPath, config, runId } = await applyFixtureRun("dsh-rb-rename-", "rename");
    assert.deepEqual(
      (await porcelain(repositoryPath)).trim().split(/\r?\n/).map((line) => line.trim()).sort(),
      ["?? renamed-victim.txt", "D victim.txt"],
    );

    const rollback = await rollbackVerifiedWinner({ runId, repositoryPath }, config);
    assert.equal(rollback.status, "rolled_back");
    assert.deepEqual(rollback.changedFiles.sort(), ["renamed-victim.txt", "victim.txt"]);
    assert.equal(await porcelain(repositoryPath), "");
    assert.equal(await readText(repositoryPath, "victim.txt"), "victim content\n");
    await assert.rejects(readFile(join(repositoryPath, "renamed-victim.txt")));
  });

  it("refuses to revert an interrupted apply over the user's own work", async () => {
    const { repositoryPath, config, runId, runDirectory } = await applyFixtureRun("dsh-rb-interrupt-edit-", "modify-and-add");
    await markRecordApplying(runDirectory);
    await writeFile(join(repositoryPath, "README.md"), "MY OWN UNCOMMITTED WORK\n");

    await assert.rejects(
      rollbackVerifiedWinner({ runId, repositoryPath }, config),
      /matches neither the recorded patch nor HEAD/,
    );
    // The refusal has to be the outcome: HEAD content here means data loss.
    assert.equal(await readText(repositoryPath, "README.md"), "MY OWN UNCOMMITTED WORK\n");
    assert.ok((await readFile(join(runDirectory, "apply-state.json"), "utf8")).length > 0);
  });

  it("reverse-applies the verified patch for an interrupted apply, keeping edits outside its hunks", async () => {
    const { repositoryPath, config, runId, runDirectory } = await applyFixtureRun("dsh-rb-interrupt-reverse-", "long-file");
    await markRecordApplying(runDirectory);
    // An edit far from the patch's single trailing hunk: reversing the patch
    // removes only the patch's own line, restoring HEAD would remove both.
    const notes = await readText(repositoryPath, "notes.md");
    await writeFile(join(repositoryPath, "notes.md"), notes.replace("line-5\n", "MY OWN UNCOMMITTED WORK\n"));

    const rollback = await rollbackVerifiedWinner({ runId, repositoryPath }, config);
    assert.equal(rollback.status, "rolled_back");
    assert.match(rollback.failure ?? "", /reverse-applying the hash-verified patch/);
    const restored = await readText(repositoryPath, "notes.md");
    assert.match(restored, /MY OWN UNCOMMITTED WORK\n/);
    assert.doesNotMatch(restored, /winner-line/);
    assert.equal(restored.split("\n").filter((line) => line.length > 0).length, 60);
    assert.ok((await readFile(join(runDirectory, "rollback-result.json"), "utf8")).length > 0);
  });

  it("rolls back an interrupted apply that wrote nothing and can be applied again", async () => {
    // `git apply` is all-or-nothing: a refused apply leaves the tree untouched,
    // so the abandoned record must not wedge the run or need deleting by hand.
    const { repositoryPath, config, runId, runDirectory } = await applyFixtureRun("dsh-rb-interrupt-noop-", "winner");
    await markRecordApplying(runDirectory);
    await rm(join(repositoryPath, "result.txt"));
    assert.equal(await porcelain(repositoryPath), "");

    const rollback = await rollbackVerifiedWinner({ runId, repositoryPath }, config);
    assert.equal(rollback.status, "rolled_back");
    assert.match(rollback.failure ?? "", /nothing had to be reverted/);
    await assert.rejects(readFile(join(runDirectory, "apply-state.json")));

    const reapplied = await applyVerifiedWinner({ runId, repositoryPath }, config, applyDependencies);
    assert.equal(reapplied.status, "applied");
    assert.equal(await readText(repositoryPath, "result.txt"), "winner\n");
  });

  it("restores the index as well as the working tree", async () => {
    const { repositoryPath, config, runId } = await applyFixtureRun("dsh-rb-index-", "winner");
    // A staged add surviving into the origin repo: without unstaging, the path
    // is left as `AD result.txt` and the tool still reports rolled_back.
    await execFileAsync("git", ["add", "result.txt"], { cwd: repositoryPath });
    assert.equal((await porcelain(repositoryPath)).trim(), "A  result.txt");

    const rollback = await rollbackVerifiedWinner({ runId, repositoryPath }, config);
    assert.equal(rollback.status, "rolled_back");
    assert.equal(await porcelain(repositoryPath), "");
    const { stdout: diffCached } = await execFileAsync("git", ["diff", "--cached", "--name-only"], {
      cwd: repositoryPath,
    });
    assert.equal(diffCached, "");
  });

  it("refuses to delete a patch-added file the user wrote into after an interrupted apply", async () => {
    // `git diff --quiet HEAD -- <path>` is vacuously true for a path HEAD does
    // not know, so an untracked file holding only the user's own content read as
    // "matches HEAD" and the fallback deleted it: silent data loss in a file the
    // verifier was never asked to touch.
    const { repositoryPath, config, runId, runDirectory } = await applyFixtureRun("dsh-rb-untracked-edit-", "winner");
    await markRecordApplying(runDirectory);
    await writeFile(join(repositoryPath, "result.txt"), "MY OWN UNCOMMITTED FILE\n");

    await assert.rejects(
      rollbackVerifiedWinner({ runId, repositoryPath }, config),
      /matches neither the recorded patch nor HEAD/,
    );
    assert.equal(await readText(repositoryPath, "result.txt"), "MY OWN UNCOMMITTED FILE\n");
    assert.deepEqual((await porcelain(repositoryPath)).trim(), "?? result.txt");
    // The record is what a human follows up with; a refused rollback keeps it.
    assert.ok((await readFile(join(runDirectory, "apply-state.json"), "utf8")).length > 0);
    await assert.rejects(readFile(join(runDirectory, "rollback-result.json")));
  });

  it("refuses to trust a record whose stored patch bytes changed", async () => {
    const { repositoryPath, config, runId, runDirectory } = await applyFixtureRun("dsh-rb-patchhash-", "winner");
    await writeFile(join(runDirectory, "winner.patch"), "not the recorded patch\n");

    await assert.rejects(
      rollbackVerifiedWinner({ runId, repositoryPath }, config),
      /no longer hashes to the patch recorded/,
    );
    // Nothing was reverted, so the applied file is still there for the user.
    assert.equal(await readText(repositoryPath, "result.txt"), "winner\n");
  });

  it("refuses to roll back after the applied patch was committed", async () => {
    const { repositoryPath, config, runId } = await applyFixtureRun("dsh-rb-committed-", "winner");
    await execFileAsync("git", ["add", "result.txt"], { cwd: repositoryPath });
    await execFileAsync("git", ["commit", "--quiet", "-m", "took the patch"], { cwd: repositoryPath });

    await assert.rejects(
      rollbackVerifiedWinner({ runId, repositoryPath }, config),
      /rollback refused: HEAD is/,
    );
    // The committed content must stay untouched.
    assert.equal(await readText(repositoryPath, "result.txt"), "winner\n");
  });
});

describe("user edits after an apply", () => {
  it("refuses to revert files the user edited after the apply", async () => {
    const { repositoryPath, config, runId } = await applyFixtureRun("dsh-rb-useredit-", "winner");
    await writeFile(join(repositoryPath, "result.txt"), "winner\nplus my own edit\n");

    await assert.rejects(
      rollbackVerifiedWinner({ runId, repositoryPath }, config),
      /rollback refused/,
    );
    // The user's edit must survive the refused rollback.
    assert.equal(await readText(repositoryPath, "result.txt"), "winner\nplus my own edit\n");
  });

  it("applies, rolls back, and applies again in the same run", async () => {
    const { repositoryPath, stateDirectory, config, runId, runDirectory } = await applyFixtureRun("dsh-rb-reapply-", "winner");
    const rollback = await rollbackVerifiedWinner({ runId, repositoryPath }, config);
    assert.equal(rollback.status, "rolled_back");

    const reapplied = await applyVerifiedWinner({ runId, repositoryPath }, config, applyDependencies);
    assert.equal(reapplied.status, "applied");
    assert.equal(await readText(repositoryPath, "result.txt"), "winner\n");

    // A second apply without an intervening rollback must be refused before it
    // mutates anything (clean-tree guard fires first, record guard is behind it).
    await assert.rejects(
      applyVerifiedWinner({ runId, repositoryPath }, config, applyDependencies),
      /already applied|repository must be clean/,
    );
    assert.equal((await readFile(join(stateDirectory, "runs", runId, "apply-result.json"), "utf8")).length > 0, true);
    assert.ok((await readFile(join(runDirectory, "apply-state.json"), "utf8")).length > 0);
  });
});

describe("repository lock", () => {
  async function lockPath(stateDirectory: string, repositoryPath: string): Promise<string> {
    const canonicalRepository = await realpath(repositoryPath);
    return join(
      stateDirectory,
      "locks",
      `${createHash("sha256").update(canonicalRepository).digest("hex")}.lock`,
    );
  }

  async function writeLockRecord(
    stateDirectory: string,
    repositoryPath: string,
    record: Record<string, unknown>,
  ): Promise<string> {
    const path = await lockPath(stateDirectory, repositoryPath);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, `${JSON.stringify(record)}\n`);
    return path;
  }

  it("reclaims a lock whose heartbeat stopped even though its pid still answers", async () => {
    // A Windows pid gets reused, so `kill(pid, 0)` answers "alive" forever for a
    // lock whose owner died; the heartbeat is what says otherwise.
    const { repositoryPath, stateDirectory, config, runId } = await applyFixtureRun("dsh-lock-stale-", "winner");
    await writeLockRecord(stateDirectory, repositoryPath, {
      repositoryPath,
      pid: process.pid,
      hostname: "this-host",
      createdAt: new Date(Date.now() - 600_000).toISOString(),
      heartbeatAt: new Date(Date.now() - 600_000).toISOString(),
    });

    const rollback = await rollbackVerifiedWinner({ runId, repositoryPath }, config);
    assert.equal(rollback.status, "rolled_back");
  });

  it("never probes a foreign host's pid to steal a live lock", async () => {
    // A second host sharing this state directory records a pid that means
    // nothing here: an ESRCH probe on it would reclaim a running peer's lock.
    const { repositoryPath, stateDirectory, config, runId } = await applyFixtureRun("dsh-lock-remote-", "winner");
    const path = await writeLockRecord(stateDirectory, repositoryPath, {
      repositoryPath,
      pid: 2_000_000_000,
      hostname: "other-host.invalid",
      createdAt: new Date(Date.now() - 1_000).toISOString(),
      heartbeatAt: new Date().toISOString(),
    });

    await assert.rejects(
      rollbackVerifiedWinner({ runId, repositoryPath }, config),
      /other-host\.invalid.*still heartbeating/s,
    );
    assert.equal(await readText(repositoryPath, "result.txt"), "winner\n");
    assert.ok((await readFile(path, "utf8")).includes("other-host.invalid"));
  });

  it("does not reclaim a live holder's lock while its record is mid-rewrite", async () => {
    // The holder rewrites the record every 5 s with `writeFile`, which truncates
    // before it writes: a peer reading inside that window sees "" or half a JSON
    // document. Parsing that as "no record" let a peer delete a running
    // operation's lock and apply on top of it.
    const { repositoryPath, stateDirectory, config, runId } = await applyFixtureRun("dsh-lock-midwrite-", "winner");
    const path = await lockPath(stateDirectory, repositoryPath);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, '{"repositoryPath":"');
    const mtime = await stat(path);

    await assert.rejects(
      rollbackVerifiedWinner({ runId, repositoryPath }, config),
      (error: unknown) => {
        const message = String(error);
        assert.match(message, /another verifier operation is running/u);
        // The refusal says why the record could not be trusted, instead of
        // quietly treating an unreadable lock as nobody's.
        assert.match(message, /could not be read/u);
        return true;
      },
    );
    // Refused means the record is left for its holder and nothing was reverted.
    assert.equal(await readFile(path, "utf8"), '{"repositoryPath":"');
    assert.equal((await stat(path)).mtimeMs, mtime.mtimeMs, "the refused operation must not touch the lock");
    assert.equal(await readText(repositoryPath, "result.txt"), "winner\n");

    // Fail closed is not fail forever: with a mtime past the stale window the
    // abandoned lock is reclaimed, so a host that never recovers from a crash
    // does not lock the repository permanently.
    await utimes(path, mtime.atime, new Date(mtime.mtimeMs - 600_000));
    const rollback = await rollbackVerifiedWinner({ runId, repositoryPath }, config);
    assert.equal(rollback.status, "rolled_back");
  });

  it("never lets two peers take over one crashed lock", async () => {
    // The stale verdict and the `rm` that acted on it were separate steps: two
    // peers that both judged one crashed lock stale could each remove the
    // other's freshly written lock and both sit down, so both rolled back the
    // same run. Every lock test above has a single acquirer, which is why this
    // survived them.
    const { repositoryPath, stateDirectory, config, runId, runDirectory } = await applyFixtureRun("dsh-lock-takeover-", "winner");
    const statePath = join(runDirectory, "apply-state.json");
    const original = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
    // Roll back once for real, so the tree is clean and every round below re-runs
    // against an interrupted apply that wrote nothing: the same lock path, without
    // rebuilding the fixture 20 times.
    await rollbackVerifiedWinner({ runId, repositoryPath }, config);
    assert.equal(await porcelain(repositoryPath), "");
    const armed = JSON.stringify({ ...original, status: "applying", appliedFileSha256: {} }, null, 2);
    let reportedLiveHolder = 0;

    for (let round = 0; round < 20; round += 1) {
      await writeFile(statePath, `${armed}\n`);
      // A crashed peer, and a record big enough that reading and parsing it takes
      // tens of milliseconds: that is the window the defect lived in. Both peers
      // judge this stale, the fast one then takes the lock and starts reverting,
      // and the slow one's removal - decided before that - lands on the fresh
      // lock. Its host name is one no live holder could ever write, so a refusal
      // naming it means the loser excused itself with the dead record instead of
      // reporting the peer that had seated itself.
      await writeLockRecord(stateDirectory, repositoryPath, {
        repositoryPath,
        pid: process.pid,
        hostname: "crashed-peer.invalid",
        createdAt: new Date(Date.now() - 600_000).toISOString(),
        heartbeatAt: new Date(Date.now() - 600_000).toISOString(),
        stalledLog: "x".repeat(32 * 1024 * 1024),
      });
      const outcomes = await Promise.allSettled(
        Array.from({ length: 2 }, () => rollbackVerifiedWinner({ runId, repositoryPath }, config)),
      );
      const seated = outcomes.filter((outcome) => outcome.status === "fulfilled");
      const refused = outcomes.filter((outcome) => outcome.status === "rejected");
      const reasons = outcomes.map((outcome) => (
        outcome.status === "fulfilled" ? `seated: ${outcome.value.status}` : String(outcome.reason)
      ));
      assert.equal(
        seated.length,
        1,
        `round ${round}: two peers took over the same crashed lock: ${JSON.stringify(reasons)}`,
      );
      for (const outcome of refused) {
        if (outcome.status !== "rejected") {
          continue;
        }
        const reason = String(outcome.reason);
        // A peer stops at the lock, or at the record the lock was protecting: the
        // "nothing to rollback" case is a legitimate acquisition made after the
        // holder finished. Anything else means it walked into the repository
        // beside a peer that was still inside it.
        assert.match(
          reason,
          /another verifier operation|cannot take the lock|nothing to rollback/u,
          `round ${round}: a peer got past the lock without being refused by it: ${reason}`,
        );
        assert.doesNotMatch(reason, /crashed-peer\.invalid/u, `round ${round}: a peer reported the stale record, not the live holder: ${reason}`);
        if (/another verifier operation is running/u.test(reason)) {
          reportedLiveHolder += 1;
        }
      }
      assert.equal(await porcelain(repositoryPath), "", `round ${round} dirtied the tree`);
    }
    // And the loser does report the holder: at least one refusal in this race named
    // the peer that had just seated itself, rather than the crashed record.
    assert.ok(
      reportedLiveHolder > 0,
      "no refused peer ever reported the live holder that seated itself",
    );
  });

  it("lets only one of two concurrent applies touch the run state", async () => {
    // The record guard, the HEAD re-check and the `git apply --check` all sat
    // outside the lock, so two applies of one runId both passed every guard and
    // both reached the mutation: the loser then overwrote the winner's rollback
    // handle with its own `applying` record and lost the post-apply hashes.
    const { repositoryPath, config, runId, runDirectory } = await fixtureRun("dsh-lock-concurrent-apply-", "winner");
    let arrivals = 0;
    let credentialsResolved = 0;
    let bothArrived!: () => void;
    const arrived = new Promise<void>((resolve) => {
      bothArrived = resolve;
    });
    const concurrentDependencies = {
      requestApproval: async () => {
        arrivals += 1;
        if (arrivals === 2) {
          bothArrived();
          return;
        }
        // A peer refused before it ever asked must not hang this one forever.
        await Promise.race([
          arrived,
          new Promise<void>((resolve) => {
            setTimeout(resolve, 5_000);
          }),
        ]);
      },
      // The second caller is held one step longer than the first, so it reaches
      // the post-approval guards after the first has already mutated: that is the
      // interleaving the guards must survive.
      resolveCredential: async () => {
        credentialsResolved += 1;
        if (credentialsResolved === 2) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 2_000);
          });
        }
        return "";
      },
    };
    const outcomes = await Promise.allSettled([
      applyVerifiedWinner({ runId, repositoryPath }, config, concurrentDependencies),
      applyVerifiedWinner({ runId, repositoryPath }, config, concurrentDependencies),
    ]);
    const rejectedCount = outcomes.filter((outcome) => outcome.status === "rejected").length;
    assert.equal(
      rejectedCount,
      1,
      `expected exactly one apply to be refused: ${outcomes.map((outcome) => JSON.stringify(outcome)).join(" | ")}`,
    );
    // Refused by a guard inside the lock, not by luck: while the guards sat
    // outside it the loser could walk all the way to the mutation, and an error
    // from the clean-tree check or from `git apply` is what this asserts against.
    const refusal = outcomes.find((outcome) => outcome.status === "rejected") as PromiseRejectedResult;
    assert.match(
      String(refusal.reason),
      /already applied to this repository|another verifier operation is running/,
    );
    assert.equal((await readText(repositoryPath, "result.txt")).trim(), "winner");
    assert.deepEqual((await porcelain(repositoryPath)).trim(), "?? result.txt");
    const record = JSON.parse(await readFile(join(runDirectory, "apply-state.json"), "utf8")) as {
      status: string;
      appliedFileSha256: Record<string, string | null>;
    };
    assert.equal(record.status, "applied");
    assert.deepEqual(Object.keys(record.appliedFileSha256), ["result.txt"]);
    assert.equal(
      record.appliedFileSha256["result.txt"],
      createHash("sha256").update(await readFile(join(repositoryPath, "result.txt"))).digest("hex"),
    );
  });

  it("holds the lock across the apply's post-apply validation and receipts", async () => {
    // The critical section used to end at the mutation, so a second call could take
    // the lock while the run's validation commands were still executing in the user's
    // repository and roll the patch back underneath an apply that was about to report
    // `applied` — and the apply then wrote its own receipts over the rollback's.
    const { repositoryPath, config, runId, witnessPath, releasePath } = await blockerFixtureRun("dsh-lock-apply-window-");
    const applyAttempt = Promise.allSettled([
      applyVerifiedWinner({ runId, repositoryPath }, config, applyDependencies),
    ]);
    // The witness is written by the validation command itself, so it can only appear
    // once that command is running: exactly the window the lock used to be out of.
    await waitForFile(witnessPath);
    const rollbackAttempt = Promise.allSettled([
      rollbackVerifiedWinner({ runId, repositoryPath }, config),
    ]);
    await writeFile(releasePath, "");
    const [applied] = await applyAttempt;
    const [rollback] = await rollbackAttempt;

    if (applied.status !== "fulfilled") {
      assert.fail(`the apply failed instead of waiting on the lock: ${String(applied.reason)}`);
    }
    assert.equal(applied.value.status, "applied");
    // This lock refuses a contended acquire instead of queueing, so the honest proof
    // that the rollback could not enter is a refusal naming the holder — and the
    // holder it names is this process, still inside the apply.
    if (rollback.status !== "rejected") {
      assert.fail(`rollback entered while the apply was still validating: ${rollback.value.status}`);
    }
    assert.match(String(rollback.reason), /another verifier operation is running/u);
    assert.ok(
      String(rollback.reason).includes(`pid ${String(process.pid)}`),
      `the refusal did not name the apply that holds the lock: ${String(rollback.reason)}`,
    );
    // Coherent on disk: the tree still carries the patch, the handle still says so,
    // and no rollback receipt was written under it and then overwritten.
    assert.equal(await readText(repositoryPath, "result.txt"), "winner\n");
    const handle = JSON.parse(await readFile(join(config.stateDirectory, "runs", runId, "apply-state.json"), "utf8")) as {
      status: string;
    };
    assert.equal(handle.status, "applied");
    await assert.rejects(
      readFile(join(config.stateDirectory, "runs", runId, "rollback-result.json"), "utf8"),
      /ENOENT/u,
    );
    // And the widened section is still released: a rollback after the apply returns
    // gets the lock and reverts.
    const rollbackAfter = await rollbackVerifiedWinner({ runId, repositoryPath }, config);
    assert.equal(rollbackAfter.status, "rolled_back");
    assert.equal(await porcelain(repositoryPath), "");
  });

  it("refuses an apply whose lock was taken over during post-apply validation", async () => {
    // The heartbeat is `void writeLockRecord().catch(() => {})`: a refresh that
    // fails is neither retried nor disclosed, and once LOCK_STALE_AFTER_MS of silence
    // passes a peer may seat itself on this repository while the apply is still
    // working - then report `applied` for a tree a second operation owns. Seat that
    // foreign holder while the validation command is parked and the apply has to
    // notice it before it records anything as a verdict.
    const { repositoryPath, config, runId, witnessPath, releasePath } = await blockerFixtureRun("dsh-lock-taken-over-");
    const applyAttempt = Promise.allSettled([
      applyVerifiedWinner({ runId, repositoryPath }, config, applyDependencies),
    ]);
    await waitForFile(witnessPath);
    const lockDirectory = join(config.stateDirectory, "locks");
    const lockFile = (await readdir(lockDirectory)).find((name) => name.endsWith(".lock"));
    assert.ok(lockFile !== undefined, `the apply left no lock record under ${lockDirectory}`);
    await writeFile(join(lockDirectory, lockFile), `${JSON.stringify({
      repositoryPath,
      pid: 4_200_000,
      hostname: "some-other-host",
      createdAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    })}\n`);
    await writeFile(releasePath, "");
    const [outcome] = await applyAttempt;

    if (outcome.status !== "fulfilled") {
      assert.fail(`the takeover escaped as a bare error instead of a verdict: ${String(outcome.reason)}`);
    }
    const applied = outcome.value;
    assert.equal(applied.status, "applied_validation_failed", JSON.stringify(applied));
    assert.match(applied.failure ?? "", /no longer this process's/u);
    assert.match(applied.failure ?? "", /some-other-host/u);
    // The truth the message owes the operator: the tree is changed, rollback undoes it.
    assert.match(applied.failure ?? "", /the patch is applied/u);
    assert.match(applied.failure ?? "", /rollback_verified_winner/u);
    assert.equal(await readText(repositoryPath, "result.txt"), "winner\n");
    const rollback = await rollbackVerifiedWinner({ runId, repositoryPath }, config);
    assert.equal(rollback.status, "rolled_back");
  });
});

describe("operator kill switch", () => {
  it("refuses an apply whose approval wait ended after the switch was flipped", async () => {
    // `applies: "live"` settings: the handler's own check and the mutation are
    // separated by an approval wait that takes as long as the human answering.
    // Every guard that gates a mutation is re-read inside the repository lock,
    // and `enabled` is one of them.
    const { repositoryPath, config, runId, runDirectory } = await fixtureRun("dsh-apply-disabled-", "winner");
    let disabled = false;
    await assert.rejects(
      applyVerifiedWinner({ runId, repositoryPath }, config, {
        requestApproval: async () => {
          disabled = true;
        },
        resolveCredential: async () => "",
        isDisabled: () => disabled,
      }),
      /apply_verified_winner is disabled by the llm-verifier settings \(enabled: false\)/u,
    );
    // Refused inside the critical section means no mutation and no rollback
    // handle: the next operator finds an unapplied run, not an `applying` record.
    await assert.rejects(readFile(join(runDirectory, "apply-state.json")), /ENOENT/u);
    await assert.rejects(readFile(join(repositoryPath, "result.txt")), /ENOENT/u);
    assert.equal(await porcelain(repositoryPath), "");

    // And a run that was never disabled still applies.
    const applied = await applyVerifiedWinner({ runId, repositoryPath }, config, applyDependencies);
    assert.equal(applied.status, "applied");
  });
});

describe("a cancel that lands after the apply, and a run that throws after its pool", () => {
  it("reports the patch as applied when the host cancels before validation can launch", async () => {
    // The apply itself is deliberately not interruptible, so a cancel arriving after
    // `git apply` has landed reaches `runProcess` on a dead signal, and it throws
    // `process aborted before launch` rather than reporting an aborted run. That used
    // to escape as a bare shell error: no apply-result.json, no rollback pointer, and
    // the host never told that the tree is already changed.
    const { repositoryPath, config, runId, runDirectory } = await fixtureRun("dsh-apply-cancel-", "winner");
    const controller = new AbortController();
    const applyAttempt = Promise.allSettled([
      applyVerifiedWinner({ runId, repositoryPath, signal: controller.signal }, config, applyDependencies),
    ]);
    // The `"applying"` handle is the last signal-consuming write before the apply, so
    // an abort taken from here lands after the patch and before any validation launch.
    await waitForFile(join(runDirectory, "apply-state.json"));
    controller.abort(new Error("test: the host cancelled after the patch landed"));
    const [outcome] = await applyAttempt;

    if (outcome.status !== "fulfilled") {
      assert.fail(`the cancel escaped as a bare error instead of a result: ${String(outcome.reason)}`);
    }
    const applied = outcome.value;
    assert.equal(applied.status, "applied_validation_failed");
    assert.equal(applied.validationStatus, "timed_out");
    // The launch-time throw, not the in-flight kill: an aborted command that already
    // ran reports "timed out or was cancelled" and would prove nothing here.
    assert.match(applied.failure ?? "", /aborted before launch/u);
    assert.match(applied.failure ?? "", /the patch is applied/u);
    assert.match(applied.failure ?? "", /rollback_verified_winner/u);
    assert.equal(await readText(repositoryPath, "result.txt"), "winner\n");
    const receipt = JSON.parse(await readFile(join(runDirectory, "apply-result.json"), "utf8")) as {
      status: string;
      validationStatus: string;
    };
    assert.equal(receipt.status, "applied_validation_failed");
    assert.equal(receipt.validationStatus, "timed_out");
    // The handle is there for the rollback the message points at.
    const handle = JSON.parse(await readFile(join(runDirectory, "apply-state.json"), "utf8")) as { status: string };
    assert.equal(handle.status, "applied");
    const rollback = await rollbackVerifiedWinner({ runId, repositoryPath }, config);
    assert.equal(rollback.status, "rolled_back");
    assert.equal(await porcelain(repositoryPath), "");
  });

  it("reports the patch as applied when the host cancels while a validation command runs", async () => {
    // The branch above takes the launch-time throw. A cancel that lands while a
    // command is running comes back as an aborted result, and the in-loop verdict
    // used to read only `post-apply validation timed out or was cancelled: <cmd>` -
    // the same two on-disk states (patch on the tree, handle "applied"), one of them
    // told the host nothing about how to undo it. The sentence is shared now.
    const { repositoryPath, config, runId, witnessPath } = await blockerFixtureRun("dsh-apply-cancel-inflight-");
    const controller = new AbortController();
    const applyAttempt = Promise.allSettled([
      applyVerifiedWinner({ runId, repositoryPath, signal: controller.signal }, config, applyDependencies),
    ]);
    await waitForFile(witnessPath);
    controller.abort(new Error("test: the host cancelled during the validation command"));
    const [outcome] = await applyAttempt;

    if (outcome.status !== "fulfilled") {
      assert.fail(`the cancel escaped as a bare error instead of a result: ${String(outcome.reason)}`);
    }
    const applied = outcome.value;
    assert.equal(applied.status, "applied_validation_failed");
    assert.equal(applied.validationStatus, "timed_out");
    // The in-flight branch, not the launch-time throw.
    assert.match(applied.failure ?? "", /timed out or was cancelled/u);
    assert.doesNotMatch(applied.failure ?? "", /aborted before launch/u);
    assert.match(applied.failure ?? "", /the patch is applied/u);
    assert.match(applied.failure ?? "", /rollback_verified_winner/u);
    assert.equal(await readText(repositoryPath, "result.txt"), "winner\n");
    const handle = JSON.parse(await readFile(join(config.stateDirectory, "runs", runId, "apply-state.json"), "utf8")) as {
      status: string;
    };
    assert.equal(handle.status, "applied");
    const rollback = await rollbackVerifiedWinner({ runId, repositoryPath }, config);
    assert.equal(rollback.status, "rolled_back");
    assert.equal(await porcelain(repositoryPath), "");
  });

  it("persists a manifest and report when the run throws after the candidate pool", async () => {
    // Two throws reachable after the model spend (the worktree creation and the
    // winner-patch stage) had no catch above them, and the manifest and report sat
    // after the `finally`: the run directory kept no manifest.json, so apply, select
    // and rollback all refused on ENOENT and the paid-for candidate results were
    // unreachable. `winner.patch` is armed as a directory, which makes the run's own
    // write of it throw EISDIR after every candidate has settled.
    const fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-run-record-"));
    createdFixtureRoots.push(fixtureRoot);
    const repositoryPath = join(fixtureRoot, "repository");
    const stateDirectory = join(fixtureRoot, "state");
    const fakeDshPath = await writeFakeDsh(fixtureRoot, { mode: "winner" });
    await createCleanRepository(repositoryPath);
    const config = createRuntimeConfig(stateDirectory, fakeDshPath);
    const armedRunId = (async (): Promise<string> => {
      for (;;) {
        const runIds = await readdir(join(stateDirectory, "runs")).catch(() => [] as string[]);
        const runId = runIds[0];
        if (runId !== undefined) {
          await mkdir(join(stateDirectory, "runs", runId, "winner.patch"));
          return runId;
        }
        await new Promise((resolve) => {
          setTimeout(resolve, 5);
        });
      }
    })();
    const runAttempt = Promise.allSettled([
      runVerifiedBestOf(
        {
          task: "Fix the fixture",
          candidateCount: 3,
          validationCommands: [fixtureValidationCommand.winner],
          repositoryPath,
        },
        config,
        { ...applyDependencies, runVerifier: async () => { throw new Error("verifier must not run"); } },
      ),
    ]);
    const runId = await armedRunId;
    const [run] = await runAttempt;

    if (run.status !== "rejected") {
      assert.fail(`arming winner.patch as a directory did not make the run throw: ${run.value.status}`);
    }
    assert.match(String(run.reason), /EISDIR|winner\.patch/u);
    const manifest = JSON.parse(await readFile(join(stateDirectory, "runs", runId, "manifest.json"), "utf8")) as {
      result: {
        status: string;
        failure: string | null;
        winnerPatchPath: string | null;
        winnerId: string | null;
        selectionMethod: string | null;
      };
      candidateRuns: Array<{ candidateId: string; executionStatus: string; validationStatus: string }>;
    };
    assert.equal(manifest.result.status, "failed");
    assert.match(manifest.result.failure ?? "", /EISDIR|winner\.patch/u);
    assert.equal(manifest.result.winnerPatchPath, null);
    // A `failed` run names no winner: the host renders `Winner: <id>` for every
    // status, so a record that kept the selection would advertise a run apply,
    // select and rollback all refuse.
    assert.equal(manifest.result.winnerId, null);
    assert.equal(manifest.result.selectionMethod, null);
    // The record is worth having because the pool it carries already ran: this
    // fixture has one eligible winner among the three, and the selection that threw
    // was made from exactly these results.
    assert.equal(manifest.candidateRuns.length, 3);
    assert.ok(
      manifest.candidateRuns.some(
        (candidate) => candidate.executionStatus === "completed" && candidate.validationStatus === "passed",
      ),
      JSON.stringify(manifest.candidateRuns),
    );
    assert.match(await readFile(join(stateDirectory, "runs", runId, "report.md"), "utf8"), /Status: `failed`/u);
    // A verdict-bearing refusal, not an ENOENT the host cannot act on.
    await assert.rejects(
      applyVerifiedWinner({ runId, repositoryPath }, config, applyDependencies),
      /has no applicable winner; status is "failed"/u,
    );
  });

  it("leaves the record a run already wrote alone when the failure path tries again", async () => {
    // The fence this pins is exclusive-create: when a throw lands after the
    // manifest has landed, the catch's second `persistRunRecord(null, null)` cannot
    // reach the record the completing path wrote. Rewrite that write with
    // `replacePrivateTextFile` and N31 is back — `failed` with no winner over a run
    // that had already picked one. `report.md` armed as a directory is the throw
    // that comes after the manifest, in the same serialization.
    const fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-run-record-fence-"));
    createdFixtureRoots.push(fixtureRoot);
    const repositoryPath = join(fixtureRoot, "repository");
    const stateDirectory = join(fixtureRoot, "state");
    const fakeDshPath = await writeFakeDsh(fixtureRoot, { mode: "winner" });
    await createCleanRepository(repositoryPath);
    const config = createRuntimeConfig(stateDirectory, fakeDshPath);
    const armedRunId = (async (): Promise<string> => {
      for (;;) {
        const runIds = await readdir(join(stateDirectory, "runs")).catch(() => [] as string[]);
        const runId = runIds[0];
        if (runId !== undefined) {
          await mkdir(join(stateDirectory, "runs", runId, "report.md"));
          return runId;
        }
        await new Promise((resolve) => {
          setTimeout(resolve, 5);
        });
      }
    })();
    const runAttempt = Promise.allSettled([
      runVerifiedBestOf(
        {
          task: "Fix the fixture",
          candidateCount: 3,
          validationCommands: [fixtureValidationCommand.winner],
          repositoryPath,
        },
        config,
        { ...applyDependencies, runVerifier: async () => { throw new Error("verifier must not run"); } },
      ),
    ]);
    const runId = await armedRunId;
    const [run] = await runAttempt;

    if (run.status !== "rejected") {
      assert.fail(`arming report.md as a directory did not make the run throw: ${run.value.status}`);
    }
    assert.match(String(run.reason), /EISDIR|report\.md/u);
    // The run still rejects, and what is on disk is still the decided record.
    const manifest = JSON.parse(await readFile(join(stateDirectory, "runs", runId, "manifest.json"), "utf8")) as {
      result: { status: string; winnerId: string | null; selectionMethod: string | null; winnerPatchPath: string | null };
    };
    assert.equal(manifest.result.status, "winner_selected");
    assert.ok(manifest.result.winnerId !== null, JSON.stringify(manifest.result));
    assert.ok(manifest.result.selectionMethod !== null, JSON.stringify(manifest.result));
    assert.match(manifest.result.winnerPatchPath ?? "", /winner\.patch$/u);
  });
});

describe("a run deadline that expires while the run is cleaning up", () => {
  // The red this helper reproduces was measured, not simulated: on a loaded box the cleanup phase
  // (residual process-tree reads + three `git worktree remove`) took 52 s, the 30 s run timeout
  // fired inside that window while all three candidates had settled 50 s earlier, and the selection
  // — reading the live flag — reported `failed` and never wrote winner.patch. `RuntimeDependencies`
  // has no seam after the candidate pool, so the deadline is triggered off the run's own artefact:
  // process-tree.log is written inside cleanup (core.ts:1461), after every candidate returned and
  // before the selection at core.ts:1510.
  async function settleBeforeDeadline(
    label: string,
    adjust: (config: RunSettings) => RunSettings = (config) => config,
    dependencies: Partial<RuntimeDependencies> = {},
  ): Promise<{ run: Awaited<ReturnType<typeof runVerifiedBestOf>>; statuses: string }> {
    const fixtureRoot = await mkdtemp(join(tmpdir(), label));
    createdFixtureRoots.push(fixtureRoot);
    const repositoryPath = join(fixtureRoot, "repository");
    const stateDirectory = join(fixtureRoot, "state");
    const fakeDshPath = await writeFakeDsh(fixtureRoot, { mode: "modify-and-add" });
    await createCleanRepository(repositoryPath);
    const controller = new AbortController();
    let runSettled = false;
    const abortDuringCleanup = (async (): Promise<boolean> => {
      // No iteration cap: the only correct exit is the run settling. A budget counted from test
      // start would give up on a slow box and report a red that is really just a slow box —
      // node:test's own per-test timeout is the ceiling that is allowed to fire instead.
      for (; !runSettled; ) {
        const runIds = await readdir(join(stateDirectory, "runs")).catch(() => [] as string[]);
        for (const runId of runIds) {
          try {
            await readFile(join(stateDirectory, "runs", runId, "artifacts", "process-tree.log"));
          } catch {
            continue;
          }
          controller.abort(new Error("test: the run total timeout expired during cleanup"));
          return true;
        }
        await new Promise((resolve) => {
          setTimeout(resolve, 5);
        });
      }
      return false;
    })();
    let run: Awaited<ReturnType<typeof runVerifiedBestOf>>;
    try {
      run = await runVerifiedBestOf(
        {
          task: "Fix the fixture",
          candidateCount: 3,
          validationCommands: [fixtureValidationCommand["modify-and-add"]],
          repositoryPath,
          signal: controller.signal,
        },
        adjust(createRuntimeConfig(stateDirectory, fakeDshPath)),
        { ...applyDependencies, runVerifier: async () => { throw new Error("verifier must not run"); }, ...dependencies },
      );
    } finally {
      // The rejection path too: a poller left spinning 5 ms timers past a failed run holds the
      // event loop and can abort a run that is already gone.
      runSettled = true;
    }
    const statuses = run.ranking.map((candidate) => `${candidate.candidateId} ${candidate.executionStatus}/${candidate.validationStatus}`).join(" | ");
    assert.equal(await abortDuringCleanup, true, "the abort never landed between the candidate pool and the selection, so this test proved nothing");
    // The premise, checked not assumed: a candidate the deadline actually killed reports "cancelled",
    // and then failing the run is correct. This fixture must reach the selection with none of them.
    assert.equal(run.ranking.filter((candidate) => candidate.executionStatus === "cancelled").length, 0, `the deadline truncated the pool: ${statuses}`);
    return { run, statuses };
  }

  it("keeps the winner the candidates already decided, and still writes winner.patch", async () => {
    const { run, statuses } = await settleBeforeDeadline("dsh-rb-deadline-");
    assert.equal(run.status, "winner_selected", `${statuses} -> ${run.failure ?? "failure: none"}`);
    assert.notEqual(run.winnerPatchPath, null, "the discarded winner left no patch behind");
    await assert.doesNotReject(readFile(run.winnerPatchPath ?? "", "utf8"));
  });

  it("leaves a review_pending run selectable, which is the shipped default configuration", async () => {
    // `settings.ts:144` defaults reviewSingleEligible to true and `:216` defaults reviewMode to
    // parent_agent, so the path a real host takes is: pool settles, the run waits for the parent
    // agent, and the deadline expires during cleanup. Erasing review_pending to "failed" was the
    // same data loss as erasing a winner and worse: `select_verified_candidate` refuses every
    // status but review_pending, so the host is left with no move at all.
    const { run, statuses } = await settleBeforeDeadline("dsh-rb-deadline-pa-", (config) => ({
      ...config,
      reviewSingleEligible: true,
      reviewMode: "parent_agent",
    }));
    assert.equal(run.status, "review_pending", `${statuses} -> ${run.failure ?? "failure: none"}`);
    assert.equal(run.eligibleCandidateCount, 1, `the pool had a candidate to offer: ${statuses}`);
  });

  it("does not launch a paid review on a budget the run has already spent", async () => {
    // The deepseek leg is safe by construction (`process.ts:315` refuses before spawning), but
    // `dsh_model` hands the host an already-aborted controller and then relies on the host
    // honouring it — src/reviewer.ts:133 documents "a host that ignores `signal`" as expected. So
    // the guard has to be here: an operator pressing cancel must not be answered with a full,
    // paid-for review of candidates that are already sitting on disk.
    let reviewCalls = 0;
    const { run, statuses } = await settleBeforeDeadline(
      "dsh-rb-deadline-rv-",
      (config) => ({ ...config, reviewMode: "dsh_model", reviewSingleEligible: true, reviewFailurePolicy: "stop" }),
      {
        reviewCandidates: async () => {
          reviewCalls += 1;
          throw new Error("the reviewer must not be reached on a spent budget");
        },
      },
    );
    assert.equal(reviewCalls, 0, `${statuses} -> the reviewer was called with an aborted signal`);
    assert.equal(run.status, "failed", `${statuses} -> ${run.failure ?? "failure: none"}`);
    assert.match(run.failure ?? "", /no review was launched/u);
  });

  it("hands the budget-starved review off to the parent agent WITH the reason", async () => {
    // Same guard, the other policy cell. `review_pending` with `failure: none` reads as an ordinary
    // parent-agent choice, which is why the two sibling handoffs (:1629, :1712) also set
    // `selectionFailure` — and why core.integration.test.ts:843 pins that for a broken reviewer.
    // Before wave 23 this cell was the one place that handoff was silent.
    const { run, statuses } = await settleBeforeDeadline(
      "dsh-rb-deadline-ph-",
      (config) => ({ ...config, reviewMode: "dsh_model", reviewSingleEligible: true, reviewFailurePolicy: "parent_agent" }),
      {
        reviewCandidates: async () => {
          throw new Error("the reviewer must not be reached on a spent budget");
        },
      },
    );
    assert.equal(run.status, "review_pending", `${statuses} -> ${run.failure ?? "failure: none"}`);
    assert.match(run.failure ?? "", /no review was launched/u, "handoff must carry its cause, not read as a routine parent-agent pick");
  });
});

describe("rollback and re-apply around a moved HEAD or a leftover handle", () => {
  it("rolls back when HEAD moved but no commit in between touches a recorded path", async () => {
    const { repositoryPath, config, runId, runDirectory } = await applyFixtureRun("dsh-rb-headsafe-", "winner");
    await writeFile(join(repositoryPath, "unrelated.txt"), "someone else's work\n");
    await execFileAsync("git", ["add", "unrelated.txt"], { cwd: repositoryPath });
    await execFileAsync("git", ["commit", "--quiet", "-m", "unrelated work"], { cwd: repositoryPath });

    const rollback = await rollbackVerifiedWinner({ runId, repositoryPath }, config);
    assert.equal(rollback.status, "rolled_back");
    assert.match(rollback.failure ?? "", /no commit in between touches a recorded path/u);
    await assert.rejects(readFile(join(repositoryPath, "result.txt")), /ENOENT/u);
    assert.equal(await readText(repositoryPath, "unrelated.txt"), "someone else's work\n");
    await assert.rejects(readFile(join(runDirectory, "apply-state.json")), /ENOENT/u);
    const { stdout: log } = await execFileAsync("git", ["log", "--oneline"], { cwd: repositoryPath });
    assert.match(log, /unrelated work/u);
  });

  it("still refuses when the committed range touches the patched path", async () => {
    const { repositoryPath, config, runId } = await applyFixtureRun("dsh-rb-headtouch-", "winner");
    await execFileAsync("git", ["add", "result.txt"], { cwd: repositoryPath });
    await execFileAsync("git", ["commit", "--quiet", "-m", "committed the winner"], { cwd: repositoryPath });
    await assert.rejects(
      rollbackVerifiedWinner({ runId, repositoryPath }, config),
      /those commits touch the patched paths \(result\.txt\)/u,
    );
    assert.equal(await readText(repositoryPath, "result.txt"), "winner\n");
  });

  it("re-applies over a handle predating the rollback receipt, and refuses over a live one", async () => {
    const { repositoryPath, config, runId, runDirectory } = await applyFixtureRun("dsh-rb-stalehandle-", "winner");
    const statePath = join(runDirectory, "apply-state.json");
    const receiptPath = join(runDirectory, "rollback-result.json");
    const live = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
    // The end state of a rollback whose handle delete failed: tree restored,
    // receipt written, handle still on disk. Reproducing the failing delete
    // itself needs an OS lock (measured: neither a held fd nor the read-only
    // attribute blocks `rm` on Windows), so the state is armed directly.
    await rollbackVerifiedWinner({ runId, repositoryPath }, config);
    await writeFile(statePath, `${JSON.stringify(live, null, 2)}\n`);
    const receiptMtime = (await stat(receiptPath)).mtime;
    await utimes(statePath, receiptMtime, new Date(receiptMtime.getTime() - 5_000));

    const reapplied = await applyVerifiedWinner({ runId, repositoryPath }, config, applyDependencies);
    assert.equal(reapplied.status, "applied", `validation: ${reapplied.failure ?? "none"}`);
    assert.deepEqual((await readdir(runDirectory)).filter((name) => name.endsWith(".tmp")), []);

    await rollbackVerifiedWinner({ runId, repositoryPath }, config);
    await writeFile(statePath, `${JSON.stringify(live, null, 2)}\n`);
    const secondReceipt = (await stat(receiptPath)).mtime;
    await utimes(statePath, secondReceipt, new Date(secondReceipt.getTime() + 5_000));
    await assert.rejects(
      applyVerifiedWinner({ runId, repositoryPath }, config, applyDependencies),
      /already applied to this repository; roll it back/u,
    );
    await assert.rejects(readFile(join(repositoryPath, "result.txt")), /ENOENT/u);
  });

  it("keeps both disclosures when the apply was interrupted and HEAD also moved", async () => {
    // Two independent notes are written into the one `failure` string. Whichever
    // site assigns instead of appending silently erases the other, and only this
    // combination reaches both branches.
    const { repositoryPath, config, runId, runDirectory } = await applyFixtureRun("dsh-rb-twonotes-", "winner");
    await writeFile(join(repositoryPath, "unrelated.txt"), "other work\n");
    await execFileAsync("git", ["add", "unrelated.txt"], { cwd: repositoryPath });
    await execFileAsync("git", ["commit", "--quiet", "-m", "unrelated work"], { cwd: repositoryPath });
    await markRecordApplying(runDirectory);

    const rollback = await rollbackVerifiedWinner({ runId, repositoryPath }, config);
    assert.equal(rollback.status, "rolled_back");
    assert.match(rollback.failure ?? "", /no commit in between touches a recorded path/u);
    assert.match(rollback.failure ?? "", /reverted by reverse-applying the hash-verified patch/u);
    await assert.rejects(readFile(join(repositoryPath, "result.txt")), /ENOENT/u);
    assert.equal(await readText(repositoryPath, "unrelated.txt"), "other work\n");
  });
});

describe("patchTouchedFiles understands every git header form it will meet", () => {
  it("unquotes a C-quoted path so the HEAD proof can intersect the -z name list", () => {
    // measured on git 2.55.0.windows.5, core.quotepath left at its default, filename 中文.py
    const quoted = 'diff --git "a/\\344\\270\\255\\346\\226\\207.py" "b/\\344\\270\\255\\346\\226\\207.py"\n--- a/x\n';
    assert.deepEqual(patchTouchedFiles(quoted), ["中文.py"]);
    // a quoted name may carry a literal space, which is why the quoted branch is [^"]* not \S*
    assert.deepEqual(patchTouchedFiles('diff --git "a/my file.txt" "b/my file.txt"\n'), ["my file.txt"]);
    assert.deepEqual(patchTouchedFiles("diff --git a/result.txt b/result.txt\ndiff --git a/other.py b/other.py\n"), [
      "result.txt",
      "other.py",
    ]);
  });

  it("returns null rather than a narrower set when a header is not a path pair", () => {
    assert.equal(patchTouchedFiles("diff --git a/only-one-side\n"), null);
    assert.equal(patchTouchedFiles("diff --git x/wrong b/prefix\n"), null);
    // no header at all is not "unparseable": it is an empty patch, and an empty scope must stay empty
    assert.deepEqual(patchTouchedFiles("--- a/result.txt\n+++ b/result.txt\n"), []);
  });

  it("refuses a quoted run it cannot decode instead of inventing a name", () => {
    // \400 is not a byte, and Buffer.from masks it to 0x00. The result is a WRONG path rather than an
    // unknown one, which shrinks the set the HEAD proof intersects — the fail-open direction.
    assert.equal(patchTouchedFiles('diff --git "a/\\400b.py" "b/\\400b.py"'), null);
    // core.quotepath=false is a legitimate config that answers with raw bytes inside the quotes.
    assert.equal(patchTouchedFiles('diff --git "a/中.py" "b/中.py"'), null);
  });
});
