import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertBatchFileLaunchable,
  assertCommandSafeValue,
  isBatchFileExecutable,
  isProcessRejection,
  runProcess,
  sanitizedEnvironment,
  type ResidualProcessTree,
} from "../src/process.ts";

const IS_WINDOWS = process.platform === "win32";
const scratchDirectory = tmpdir();
const testDirectory = dirname(fileURLToPath(import.meta.url));

describe("process isolation", () => {
  it("passes only explicitly allowed host environment values", () => {
    const environment = sanitizedEnvironment({
      PATH: "/usr/bin:/bin",
      LANG: "en_US.UTF-8",
      DATABASE_URL: "postgres://private.example/database",
      SSH_AUTH_SOCK: "/private/ssh-agent.sock",
      CI_JOB_JWT: "private-job-token",
    }, {
      DSH_PERMISSION_MODE: "workspace-write",
    });

    assert.deepEqual(environment, {
      PATH: "/usr/bin:/bin",
      LANG: "en_US.UTF-8",
      DSH_PERMISSION_MODE: "workspace-write",
    });
  });

  it("keeps a mixed-case Windows environment block that a GUI host hands over", { skip: !IS_WINDOWS && "Windows environment names are case-insensitive" }, () => {
    const environment = sanitizedEnvironment({
      Path: "C:\\Windows\\System32",
      SystemRoot: "C:\\Windows",
      ComSpec: "C:\\Windows\\system32\\cmd.exe",
      PaThToNowhere: "C:\\nope",
    });

    assert.equal(environment.Path, "C:\\Windows\\System32");
    assert.equal(environment.SystemRoot, "C:\\Windows");
    assert.equal(environment.ComSpec, "C:\\Windows\\system32\\cmd.exe");
    assert.equal(environment.PaThToNowhere, undefined);
  });

  it("kills the complete process group when a command times out", { skip: IS_WINDOWS && "POSIX process groups" }, async () => {
    const abortController = new AbortController();
    const startedAt = Date.now();
    const result = await runProcess({
      executable: "/bin/sh",
      arguments: ["-lc", "sleep 60 & child_pid=$!; printf '%s\\n' \"$child_pid\"; wait \"$child_pid\""],
      cwd: scratchDirectory,
      env: sanitizedEnvironment(process.env),
      timeoutMs: 100,
      signal: abortController.signal,
    });

    assert.equal(result.timedOut, true);
    assert.equal((await result.residualProcessGroup).remaining, false);
    assert.ok(Date.now() - startedAt < 3_000);
    const childProcessId = Number.parseInt(result.stdout.trim(), 10);
    assert.ok(Number.isInteger(childProcessId));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.throws(
      () => process.kill(childProcessId, 0),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
    );
  });

  it("force-kills the spawned process tree when a command times out on Windows", { skip: !IS_WINDOWS && "Windows tree kill" }, async () => {
    // Two locks that hold without WMI answering in time (this box takes 15-65s for
    // a process-table walk roughly as often as it takes 1.1s):
    //   1. runProcess resolves as soon as the child is gone — the observation is a
    //      handed-over promise, not a toll charged to the stage clock;
    //   2. the detached orphan is dead, proven by pid, which needs no enumeration.
    const helperPath = join(testDirectory, "fixtures", "orphan-child.mjs");
    const startedAt = Date.now();
    const result = await runProcess({
      executable: process.execPath,
      arguments: [helperPath, "60000"],
      cwd: scratchDirectory,
      env: sanitizedEnvironment(process.env),
      timeoutMs: 1_000,
      signal: new AbortController().signal,
      // Without the flag no walk runs, the tree is never enumerated, and the
      // `remaining === false` below passes for free.
      detectResidualTree: true,
    });
    const resolvedMs = Date.now() - startedAt;

    assert.equal(result.timedOut, true);
    assert.ok(resolvedMs < 4_000, `超时后必须当场返回，实耗 ${resolvedMs}ms（观测又压回 resolve 路径了）`);
    const orphanProcessId = Number.parseInt(result.stdout.trim(), 10);
    assert.ok(Number.isInteger(orphanProcessId) && orphanProcessId > 0, result.stdout);
    const killedTree = await result.residualProcessGroup;
    const observedMs = Date.now() - startedAt;
    // The deferral itself, measured rather than bounded: if `settle` went back to
    // awaiting the walk, these two timestamps collapse to ~0 ms apart no matter how
    // fast the machine is. `remaining === false` alone is NOT the lock — a walk that
    // never ran also answers `remaining:false` (as `unknown`).
    assert.ok(observedMs - resolvedMs >= 200,
      `观测没被交接出去：resolve ${resolvedMs}ms、观测完成 ${observedMs}ms，差值 < 200ms`);
    assert.equal(killedTree.remaining, false);
    assert.throws(
      () => process.kill(orphanProcessId, 0),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
      `超时杀树没有带走还活着的孤儿子进程 ${orphanProcessId}`,
    );
  });

  it("detects and kills what a normally-exiting command leaves behind", async () => {
    // Windows has no process-group reparenting and keeps naming the dead root as
    // an orphan's parent, so the tree is walkable from the still-valid handle at
    // exit time instead of being given up on.
    const helperPath = join(testDirectory, "fixtures", "orphan-child.mjs");
    const result = await runProcess({
      executable: process.execPath,
      arguments: [helperPath],
      cwd: scratchDirectory,
      env: sanitizedEnvironment(process.env),
      timeoutMs: 20_000,
      signal: new AbortController().signal,
      detectResidualTree: true,
    });

    assert.equal(result.exitCode, 0);
    const orphanProcessId = Number.parseInt(result.stdout.trim(), 10);
    assert.ok(Number.isInteger(orphanProcessId) && orphanProcessId > 0, result.stdout);
    assert.equal((await result.residualProcessGroup).detected, true);
    assert.equal((await result.residualProcessGroup).remaining, false);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.throws(
      () => process.kill(orphanProcessId, 0),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
    );
  });

  it("does not probe for a residual tree unless the caller asked", async () => {
    const result = await runProcess({
      executable: process.execPath,
      arguments: ["-e", "process.stdout.write('quick')"],
      cwd: scratchDirectory,
      env: sanitizedEnvironment(process.env),
      timeoutMs: 20_000,
      signal: new AbortController().signal,
    });
    assert.equal(result.exitCode, 0);
    const unaskedTree = await result.residualProcessGroup;
    // "not observed" is the proof the probe did not run: `detected:false` alone
    // would also be returned by a walk that ran and found nothing.
    assert.equal(unaskedTree.unknown, true);
    assert.equal(unaskedTree.detected, false);
    assert.equal(unaskedTree.remaining, false);
  });

  it("reports an unenumerable Windows process tree as unknown, not as clean", { skip: !IS_WINDOWS && "Windows process tree walk" }, async () => {
    // The residual probe shells out to PowerShell. A host without it — blocked,
    // uninstalled, off PATH — must not get the same answer as a host with
    // nothing left running: `return []` on a failed walk restored the orphan
    // bug the probe exists to catch.
    const originalPath = process.env.PATH;
    process.env.PATH = dirname(process.execPath);
    try {
      const result = await runProcess({
        executable: process.execPath,
        arguments: ["-e", "process.stdout.write('quick')"],
        cwd: scratchDirectory,
        env: sanitizedEnvironment(process.env),
        timeoutMs: 20_000,
        signal: new AbortController().signal,
        detectResidualTree: true,
      });
      assert.equal(result.exitCode, 0);
      assert.equal((await result.residualProcessGroup).unknown, true);
      assert.equal((await result.residualProcessGroup).detected, false);
      assert.equal((await result.residualProcessGroup).remaining, false);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("hands the residual-process observation over on both the resolve and the reject path", async () => {
    // A candidate that never reads its prompt makes the parent's stdin write fail
    // after the child already ran, and `runProcess` rejects: the result, and with
    // it the observation, used to be thrown away. Then the run registers nothing,
    // and cleanup deletes the worktree a surviving grandchild is sitting in.
    const helperPath = join(testDirectory, "fixtures", "orphan-and-closes-stdin.mjs");
    const fixtureRoot = await mkdtemp(join(scratchDirectory, "dsh-observation-"));
    const pidPath = join(fixtureRoot, "orphan-pid.txt");
    // Both paths must leave the same trace: a leftover tree that was either walked
    // (and its survivor killed) or disclosed as unenumerable — never a silent
    // "nothing happened", which is the shape that lets a live worktree be deleted.
    const assertObservation = (tree: ResidualProcessTree): void => {
      assert.ok(tree.detected || tree.unknown, JSON.stringify(tree));
      assert.equal(tree.remaining, false);
    };
    try {
      // How every candidate is spawned: no `input`, so the parent's empty `end()`
      // lands before the child can close the pipe and the run resolves normally.
      const resolved = await runProcess({
        executable: process.execPath,
        arguments: [helperPath, pidPath],
        cwd: scratchDirectory,
        env: sanitizedEnvironment(process.env),
        timeoutMs: 20_000,
        signal: new AbortController().signal,
        detectResidualTree: true,
      });
      assert.equal(resolved.exitCode, 0);
      assertObservation(await resolved.residualProcessGroup);

      let failure: unknown;
      try {
        await runProcess({
          executable: process.execPath,
          arguments: [helperPath, pidPath],
          cwd: scratchDirectory,
          env: sanitizedEnvironment(process.env),
          // Bigger than any pipe buffer, so a child that closes its read end while
          // the write is still queued fails that write.
          input: Buffer.alloc(4 * 1024 * 1024, 0x78),
          timeoutMs: 20_000,
          signal: new AbortController().signal,
          detectResidualTree: true,
        });
      } catch (error) {
        failure = error;
      }
      if (!isProcessRejection(failure)) {
        throw new Error(`expected a rejection carrying the observation, got ${String(failure)}`);
      }
      assert.match(failure.message, /failed to write stdin for/);
      const tree = await failure.residualProcessGroup;
      assertObservation(tree);
      if (tree.detected && !tree.unknown) {
        const orphanProcessId = Number.parseInt((await readFile(pidPath, "utf8")).trim(), 10);
        assert.ok(Number.isInteger(orphanProcessId) && orphanProcessId > 0, `bad orphan pid ${orphanProcessId}`);
        assert.throws(
          () => process.kill(orphanProcessId, 0),
          (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
          `the rejecting path left the orphan ${orphanProcessId} alive`,
        );
      }
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("detects and terminates a background process left after a successful exit", { skip: IS_WINDOWS && "POSIX process groups" }, async () => {
    const result = await runProcess({
      executable: "/bin/sh",
      arguments: [
        "-lc",
        "sleep 60 </dev/null >/dev/null 2>&1 & child_pid=$!; printf '%s\\n' \"$child_pid\"",
      ],
      cwd: scratchDirectory,
      env: sanitizedEnvironment(process.env),
      timeoutMs: 2_000,
      signal: new AbortController().signal,
    });

    assert.equal(result.exitCode, 0);
    assert.equal((await result.residualProcessGroup).detected, true);
    assert.equal((await result.residualProcessGroup).remaining, false);
    const childProcessId = Number.parseInt(result.stdout.trim(), 10);
    assert.ok(Number.isInteger(childProcessId));
    assert.throws(
      () => process.kill(childProcessId, 0),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
    );
  });
});

describe("cmd.exe command-line boundary", () => {
  it("refuses every character cmd.exe reinterprets inside its quoted argument", { skip: !IS_WINDOWS && "Windows cmd.exe" }, () => {
    for (const character of ["\"", "%", "&", "|", "^", "<", ">"]) {
      assert.throws(
        () => assertCommandSafeValue(`read ${character} and continue`, "candidateProfile"),
        (error: unknown) => {
          const message = String(error);
          assert.match(message, /cmd\.exe reinterprets/u);
          // The refusal has to name what was found, or an agent cannot tell the
          // caller which character to strip from a 500-line task.
          assert.ok(message.includes(JSON.stringify(character)), `${character} must be named: ${message}`);
          assert.match(message, /candidateProfile/u);
          return true;
        },
      );
    }
    // The two shapes the review wave actually measured: cmd running the task's
    // own text, and cmd expanding the credential variable onto the argv.
    assert.throws(() => assertCommandSafeValue("x\" & echo PWNED & \"y", "task"), /cmd\.exe reinterprets/u);
    assert.throws(() => assertCommandSafeValue("key=%DEEPSEEK_API_KEY%", "task"), /cmd\.exe reinterprets/u);
  });

  it("refuses a value that cannot fit a cmd.exe command line at all", { skip: !IS_WINDOWS && "Windows cmd.exe" }, () => {
    // Measured on this box: cmd refuses a `cmd /d /s /c` line longer than 8191 characters with
    // "The file name or extension is too long" and exit 1 — the harness is never launched, so an
    // unbounded task produced a launch failure blamed on the harness. 8000 is the declared ceiling;
    // the control below keeps the guard from being able to widen past a value that still works.
    assert.throws(
      () => assertCommandSafeValue("a".repeat(8_001), "task"),
      /exceeds the 8000 this build allows inside a cmd\.exe command line/u,
    );
    assert.doesNotThrow(() => assertCommandSafeValue("a".repeat(8_000), "task"));
    assert.throws(() => assertCommandSafeValue("b".repeat(9_000), "dshExecutable"), /invalid dshExecutable/u);
  });

  it("keeps accepting the text a working run already sends", { skip: !IS_WINDOWS && "Windows cmd.exe" }, () => {
    // Newlines are load-bearing: the isolation contract appended to every
    // candidate prompt is multi-line, and they are inert inside cmd's quoted
    // region. A guard that rejected them would break every working run.
    const workingTask = [
      "Fix the slugify function",
      "",
      "ISOLATION CONTRACT (mandatory, overrides any conflicting instruction above):",
      "- Your current working directory IS the isolated Git worktree for this task.",
      "- Do not commit or push. Finish with a concise summary.",
      "Paths like C:\\repo\\file.txt and 'quotes' or dashes - are fine.",
    ].join("\n");
    assert.doesNotThrow(() => assertCommandSafeValue(workingTask, "task"));
    assert.doesNotThrow(() => assertCommandSafeValue("headless", "candidateProfile"));
  });

  it("refuses a batch harness whose path contains whitespace", { skip: !IS_WINDOWS && "Windows cmd.exe" }, () => {
    assert.throws(
      () => assertBatchFileLaunchable("C:\\Program Files\\dsh\\dsh.cmd"),
      (error: unknown) => {
        const message = String(error);
        assert.match(message, /invalid dshExecutable/u);
        // The workaround has to be spelled out: the operator's other option is
        // the short path, and `dir /x` is how they find it.
        assert.match(message, /dir \/x/u);
        return true;
      },
    );
    // An .exe path keeps its argument intact when spawned directly, so the
    // wrapper's quote stripping never sees it: no refusal.
    assert.doesNotThrow(() => assertBatchFileLaunchable("C:\\Program Files\\dsh\\dsh.exe"));
    assert.doesNotThrow(() => assertBatchFileLaunchable("C:\\Program Files\\dsh\\dsh"));
    assert.doesNotThrow(() => assertBatchFileLaunchable("C:\\tools\\dsh.cmd"));
    assert.equal(isBatchFileExecutable("C:\\tools\\dsh.CMD"), true);
    assert.equal(isBatchFileExecutable("C:\\tools\\dsh.ps1"), false);
  });

  it("says whether the child is the cmd.exe retry of a missing executable", { skip: !IS_WINDOWS && "Windows cmd.exe resolution" }, async () => {
    // What the default `dshExecutable: "dsh"` does on a host without the harness:
    // ENOENT, then a cmd.exe retry that exits 1 with "is not recognized" without
    // throwing. Without this flag the run files that as a candidate failure and
    // the model gets blamed for a missing binary.
    const missing = await runProcess({
      executable: "dsh-never-installed-on-this-host",
      arguments: ["--profile", "headless", "task"],
      cwd: scratchDirectory,
      env: sanitizedEnvironment(process.env),
      timeoutMs: 20_000,
      signal: new AbortController().signal,
    });
    assert.equal(missing.usedCommandResolution, true);
    assert.notEqual(missing.exitCode, 0);
    // The control: a child that spawned directly is not a resolution retry, and
    // a `.cmd` harness that went through cmd.exe on its first attempt is not one
    // either (that path is the documented normal case, not a missing binary).
    const direct = await runProcess({
      executable: process.execPath,
      arguments: ["-e", "process.stdout.write('quick')"],
      cwd: scratchDirectory,
      env: sanitizedEnvironment(process.env),
      timeoutMs: 20_000,
      signal: new AbortController().signal,
    });
    assert.equal(direct.usedCommandResolution, false);
  });
});
