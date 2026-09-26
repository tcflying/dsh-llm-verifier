import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";

import { captureCandidateChanges, inspectRepository, literalPathspec, pathsKnownToHead, readNumstatRecords, removeWorktree, runGit } from "../src/git.ts";

const execFileAsync = promisify(execFile);

/** git writes exactly one `"event":"start"` line per invocation under GIT_TRACE2_EVENT. */
async function countGitStarts(tracePath: string): Promise<number> {
  try {
    return ((await readFile(tracePath, "utf8")).match(/"event":"start"/gu) ?? []).length;
  } catch {
    return 0;
  }
}

// The guard this locks is on a call that DESTROYS work: rollback restores recorded paths with
// `git checkout HEAD -- <spec>` and unstages them with `git reset -- <spec>`. git reads a bracketed
// path as a pattern unless told not to, so a run that touched `src/probe-[x].ts` would otherwise
// reach the innocent tracked sibling `src/probe-x.ts` and throw the user's uncommitted edit away.
// Measured on git 2.55.0.windows.5: the bare spec clobbers the sibling (rc 0, no warning), the
// `:(top,literal)` spec refuses ("did not match any file(s)"). Both halves are asserted below, because
// the first one is the premise that makes the second one mean anything.
describe("literal pathspecs on a destructive git call", () => {
  it("keeps a bracketed recorded path from clobbering its glob sibling's uncommitted work", async () => {
    const repositoryPath = await createCleanRepository();
    try {
      await mkdir(join(repositoryPath, "src"), { recursive: true });
      await writeFile(join(repositoryPath, "src/probe-[x].ts"), "recorded path\n");
      await writeFile(join(repositoryPath, "src/probe-x.ts"), "committed sibling\n");
      await execFileAsync("git", ["add", "--all"], { cwd: repositoryPath });
      await execFileAsync("git", ["commit", "--quiet", "-m", "two siblings"], { cwd: repositoryPath });
      const dirty = "the user's uncommitted work\n";
      const sibling = join(repositoryPath, "src/probe-x.ts");
      const readSibling = async () => (await readFile(sibling, "utf8")).replaceAll("\r\n", "\n");

      await writeFile(sibling, dirty);
      await runGit(repositoryPath, ["checkout", "HEAD", "--", "src/probe-[x].ts"]);
      assert.equal(await readSibling(), "committed sibling\n", "前提：裸路径规格确实会把兄弟文件的未提交改动冲掉");

      await writeFile(sibling, dirty);
      await runGit(repositoryPath, ["checkout", "HEAD", "--", literalPathspec("src/probe-[x].ts")]);
      assert.equal(await readSibling(), dirty, "加字面路径规格后，未被记录的那份工作必须原样留着");
    } finally {
      await rm(repositoryPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});

describe("HEAD-knowledge lookup spawn shape", () => {
  it("asks git in batches of 100 rather than once per path", async () => {
    const repositoryPath = await createCleanRepository();
    const tracePath = join(tmpdir(), `dsh-t7-${Date.now()}.jsonl`);
    const paths: string[] = [];
    for (let index = 0; index < 120; index += 1) {
      paths.push(`src/file-${index}.ts`);
    }
    await mkdir(join(repositoryPath, "src"), { recursive: true });
    for (const path of paths) {
      await writeFile(join(repositoryPath, path), `export const n = 1;\n`);
    }
    // Nobody asked for src/probe-x.ts: it is the "tracked but unqueried" witness, so the batched
    // answer is checked for over-inclusion and not just for size. (It is NOT a glob-leak witness:
    // measured on git 2.55, `git ls-tree -- ':(top)src/probe-[x].ts'` returns nothing at all, so no
    // fixture can make the literal flag observable here. That flag is pinned where it actually bites
    // — a destructive `git checkout` — in "literal pathspecs on a destructive git call" above.)
    await writeFile(join(repositoryPath, "src/probe-x.ts"), "export const n = 2;\n");
    paths.push("src/probe-[x].ts");
    await execFileAsync("git", ["add", "--all"], { cwd: repositoryPath });
    await execFileAsync("git", ["commit", "--quiet", "-m", "120 files"], { cwd: repositoryPath });
    process.env.GIT_TRACE2_EVENT = tracePath;
    try {
      let seen = await countGitStarts(tracePath);
      const started = performance.now();
      const known = await pathsKnownToHead(repositoryPath, paths);
      const batchedMs = performance.now() - started;
      const batchedSpawns = (await countGitStarts(tracePath)) - seen;
      assert.equal(known.size, 120, `a globbed path leaked in: ${[...known].filter((path) => path.includes("probe")).join(",")}`);
      assert.equal(known.has("src/probe-x.ts"), false);
      assert.equal(batchedSpawns, 2, `121 queried paths owe ceil(121/100)=2 git spawns, saw ${batchedSpawns}`);

      // The instrument proves it can count: the loop this replaced is 120 spawns.
      seen = await countGitStarts(tracePath);
      const loopStarted = performance.now();
      for (const path of paths) {
        await runGit(repositoryPath, ["ls-tree", "-r", "--name-only", "-z", "HEAD", "--", `:(top,literal)${path}`]);
      }
      const loopMs = performance.now() - loopStarted;
      const loopSpawns = (await countGitStarts(tracePath)) - seen;
      assert.equal(loopSpawns, paths.length, `counter is dead: saw ${loopSpawns} of ${paths.length}`);
      console.log(`[T-F7] batched=${batchedSpawns} spawns ${batchedMs.toFixed(0)}ms | per-path=${loopSpawns} spawns ${loopMs.toFixed(0)}ms | ${loopMs > 0 ? (batchedMs / loopMs).toFixed(3) : "n/a"} of the loop cost`);
    } finally {
      delete process.env.GIT_TRACE2_EVENT;
      await rm(tracePath, { force: true });
      await rm(repositoryPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});

async function createCleanRepository(): Promise<string> {
  const repositoryPath = await mkdtemp(join(tmpdir(), "dsh-llm-verifier-git-"));
  await execFileAsync("git", ["init", "--quiet", repositoryPath]);
  await execFileAsync("git", ["config", "user.email", "tests@example.invalid"], { cwd: repositoryPath });
  await execFileAsync("git", ["config", "user.name", "Verifier Tests"], { cwd: repositoryPath });
  await writeFile(join(repositoryPath, "README.md"), "fixture\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: repositoryPath });
  await execFileAsync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: repositoryPath });
  return repositoryPath;
}

describe("repository preflight", () => {
  it("accepts a clean repository root and rejects later modifications", async () => {
    const repositoryPath = await createCleanRepository();
    try {
      const snapshot = await inspectRepository(repositoryPath);
      const { stdout: expectedCommit } = await execFileAsync("git", ["rev-parse", "HEAD"], {
        cwd: repositoryPath,
      });
      assert.equal(snapshot.repositoryPath, await realpath(repositoryPath));
      assert.equal(snapshot.baseCommit, expectedCommit.trim());

      await writeFile(join(repositoryPath, "README.md"), "changed\n");
      await assert.rejects(
        inspectRepository(repositoryPath),
        /repository must be clean; git status reported: M README\.md/,
      );
    } finally {
      await rm(repositoryPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("refuses a sparse checkout in every spelling git itself reads as enabled", async () => {
    // An enabled sparse checkout is the state where `git status --porcelain`
    // answers clean while HEAD-known files are simply missing from the tree, so
    // the preflight that exists to catch a partial tree has to see git's own
    // answer rather than compare one spelling of "true".
    const repositoryPath = await createCleanRepository();
    try {
      for (const enabled of ["true", "yes", "on", "1"]) {
        await execFileAsync("git", ["config", "core.sparseCheckout", enabled], { cwd: repositoryPath });
        await assert.rejects(
          inspectRepository(repositoryPath),
          /sparse checkout is enabled/u,
          `core.sparseCheckout=${enabled} must be refused`,
        );
      }
      for (const disabled of ["false", "no", "off", "0"]) {
        await execFileAsync("git", ["config", "core.sparseCheckout", disabled], { cwd: repositoryPath });
        await assert.doesNotReject(inspectRepository(repositoryPath), `core.sparseCheckout=${disabled} is a normal repository`);
      }
      await execFileAsync("git", ["config", "--unset", "core.sparseCheckout"], { cwd: repositoryPath });
      await assert.doesNotReject(inspectRepository(repositoryPath), "an unset core.sparseCheckout is a normal repository");
    } finally {
      await rm(repositoryPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});

describe("numstat walk", () => {
  it("yields the changed paths and the binary set from one diff", () => {
    const parsed = readNumstatRecords("1\t0\tREADME.md\u0000-\t-\tlogo.bin\u00000\t2\tgone.txt\u0000");
    assert.deepEqual(parsed.changedFiles, ["README.md", "logo.bin", "gone.txt"]);
    assert.deepEqual([...parsed.binaryPaths], ["logo.bin"]);
    // The trailing separator of the last record is not a record.
    assert.deepEqual(readNumstatRecords("").changedFiles, []);
  });

  it("refuses a rename record instead of guessing at the path list", () => {
    // What git writes when rename detection is on: an empty path field and both
    // names in the records that follow it. Parsed leniently that is a change set
    // missing the deleted source, so rollback `rm`s the destination instead of
    // restoring both sides of the rename.
    assert.throws(
      () => readNumstatRecords("0\t0\t\u0000victim.txt\u0000renamed.txt\u0000"),
      /"victim\.txt","renamed\.txt"\].*rename and copy records are not supported/s,
    );
    // A path containing a tab is the other way a record ends up with more fields
    // than the format allows, and it must not be silently rejoined either.
    assert.throws(
      () => readNumstatRecords("1\t0\twe\tird.txt\u0000"),
      /rename and copy records are not supported/,
    );
  });

  it("captures one text, one binary and one deleted path in a single candidate", async () => {
    const repositoryPath = await createCleanRepository();
    const scratch = await mkdtemp(join(tmpdir(), "dsh-llm-verifier-numstat-"));
    try {
      // A second tracked file, so the candidate can delete one instead of only
      // adding and modifying.
      await writeFile(join(repositoryPath, "gone.txt"), "gone\n");
      await execFileAsync("git", ["add", "gone.txt"], { cwd: repositoryPath });
      await execFileAsync("git", ["commit", "--quiet", "-m", "second fixture file"], { cwd: repositoryPath });
      const snapshot = await inspectRepository(repositoryPath);
      const worktreePath = join(scratch, "wt");
      await execFileAsync("git", ["worktree", "add", "--detach", worktreePath, snapshot.baseCommit], {
        cwd: repositoryPath,
      });
      await writeFile(join(worktreePath, "README.md"), "fixture\nedited\n");
      await writeFile(join(worktreePath, "logo.bin"), Buffer.from([0, 1, 2, 0xff, 0xfe]));
      await rm(join(worktreePath, "gone.txt"));
      const changes = await captureCandidateChanges(
        worktreePath,
        snapshot.baseCommit,
        join(scratch, "artifacts"),
        "",
      );
      assert.deepEqual([...changes.changedFiles].sort(), ["README.md", "gone.txt", "logo.bin"]);
      // Binary detection reads the same records: `-<TAB>-<TAB>path`, and only that
      // shape, so the deleted text file must not show up here.
      assert.deepEqual(
        changes.binaryFiles.map((binaryFile) => [binaryFile.path, binaryFile.state, binaryFile.sizeBytes]),
        [["logo.bin", "present", 5]],
      );

      const targetPath = join(scratch, "target");
      await execFileAsync("git", ["worktree", "add", "--detach", targetPath, snapshot.baseCommit], {
        cwd: repositoryPath,
      });
      const { spawnSync } = await import("node:child_process");
      const check = spawnSync("git", ["apply", "--check", "--binary", changes.patchPath], { cwd: targetPath });
      assert.equal(check.status, 0, `git apply --check failed: ${check.stderr?.toString()}`);
    } finally {
      await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      await rm(repositoryPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});

describe("candidate patch capture", () => {
  it("round-trips a non-UTF-8 binary patch so it stays appliable", async () => {
    // A GBK-encoded text edit makes raw bytes git treats as binary. Decoding
    // the diff as utf8 would replace those bytes with U+FFFD and produce a
    // permanently unappliable patch whose hash only matches itself.
    const repositoryPath = await createCleanRepository();
    const scratch = await mkdtemp(join(tmpdir(), "dsh-llm-verifier-capture-"));
    try {
      const snapshot = await inspectRepository(repositoryPath);
      const worktreePath = join(scratch, "wt");
      await execFileAsync("git", ["worktree", "add", "--detach", worktreePath, snapshot.baseCommit], {
        cwd: repositoryPath,
      });
      // 0xC4 0xE3 is "你" in GBK: invalid as a UTF-8 sequence.
      const gbkBytes = Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x20, 0xc4, 0xe3, 0xa1, 0xa4]);
      await writeFile(join(worktreePath, "README.md"), gbkBytes);
      const changes = await captureCandidateChanges(
        worktreePath,
        snapshot.baseCommit,
        join(scratch, "artifacts"),
        "",
      );
      const patchBytes = await readFile(changes.patchPath);
      assert.ok(
        patchBytes.includes(Buffer.from([0xc4, 0xe3, 0xa1, 0xa4])) || /GIT binary patch/u.test(patchBytes.toString("latin1")),
        "patch must preserve the original bytes or encode them as a git binary literal",
      );

      // The captured patch must apply cleanly to a second detached worktree and
      // reproduce the edited file byte-for-byte.
      const targetPath = join(scratch, "target");
      await execFileAsync("git", ["worktree", "add", "--detach", targetPath, snapshot.baseCommit], {
        cwd: repositoryPath,
      });
      const { spawnSync } = await import("node:child_process");
      const applied = spawnSync("git", ["apply", "--binary", "-"], { cwd: targetPath, input: patchBytes });
      assert.equal(applied.status, 0, `git apply failed: ${applied.stderr?.toString()}`);
      assert.deepEqual(await readFile(join(targetPath, "README.md")), gbkBytes);
    } finally {
      await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      await rm(repositoryPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});

describe("worktree removal", () => {
  it("removes a worktree left `locked initializing` by an interrupted add", async () => {
    // What a killed `git worktree add` actually leaves behind: git locks the
    // registration for the duration of the checkout and never unlocks it. A
    // single `--force` is refused there ("use 'remove -f -f' to override or
    // unlock first"), so a run that was told about the path still could not
    // reclaim it, and `git worktree prune` will not touch a registration whose
    // working tree exists.
    const repositoryPath = await createCleanRepository();
    const scratch = await mkdtemp(join(tmpdir(), "dsh-llm-verifier-locked-wt-"));
    const worktreePath = join(scratch, "candidate-1");
    try {
      await execFileAsync("git", ["worktree", "add", "--detach", worktreePath, "HEAD"], { cwd: repositoryPath });
      await execFileAsync("git", ["worktree", "lock", "--reason", "initializing", worktreePath], { cwd: repositoryPath });
      await removeWorktree(repositoryPath, worktreePath);
      const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"], { cwd: repositoryPath });
      const listed = stdout.split(/\r?\n/u).filter((line) => line.startsWith("worktree "));
      assert.equal(listed.length, 1, `the locked registration survived remove:\n${stdout}`);
    } finally {
      await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      await rm(repositoryPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});
