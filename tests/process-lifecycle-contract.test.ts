import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it } from "node:test";

import { runProcess, sanitizedEnvironment, type ProcessResult } from "../src/process.ts";

function processRequest(
  executable: string,
  arguments_: readonly string[],
  timeoutMs: number,
  signal: AbortSignal = new AbortController().signal,
) {
  return {
    executable,
    arguments: arguments_,
    cwd: "/tmp",
    env: sanitizedEnvironment(process.env),
    timeoutMs,
    signal,
  };
}

function killDetachedProcessGroup(processId: number): void {
  try {
    process.kill(-processId, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw error;
    }
  }
}

async function runTerminationRace(
  abortAfterMs: number,
  timeoutMs: number,
): Promise<{ readonly result: ProcessResult; readonly finishCount: number }> {
  const abortController = new AbortController();
  const resultPromise = runProcess(processRequest(
    "/bin/sh",
    ["-lc", "trap '' TERM; while :; do sleep 1; done"],
    timeoutMs,
    abortController.signal,
  ));
  let finishCount = 0;
  void resultPromise.then(() => {
    finishCount += 1;
  });
  const abortTimer = setTimeout(() => abortController.abort(), abortAfterMs);
  const result = await resultPromise;
  clearTimeout(abortTimer);
  await delay(25);
  return { result, finishCount };
}

describe("process lifecycle contract", () => {
  it("finishes after bounded drain when an escaped descendant keeps stdio open", async () => {
    const descendantScript = [
      "const { spawn } = require('node:child_process');",
      "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {",
      "  detached: true,",
      "  stdio: ['ignore', process.stdout, process.stderr],",
      "});",
      "process.stdout.write(`${child.pid}\\n`);",
      "child.unref();",
    ].join("\n");
    let descendantProcessId: number | undefined;
    const startedAt = Date.now();
    try {
      const result = await runProcess(processRequest(
        process.execPath,
        ["-e", descendantScript],
        2_000,
      ));
      const durationMs = Date.now() - startedAt;
      descendantProcessId = Number.parseInt(result.stdout.trim(), 10);
      assert.ok(Number.isInteger(descendantProcessId));
      assert.equal(result.terminationReason, "completed");
      assert.equal(result.drainCompleted, false);
      assert.equal(result.drainTimedOut, true);
      assert.ok(durationMs >= 200, `drain returned too early after ${durationMs} ms`);
      assert.ok(durationMs < 1_500, `drain exceeded its bound at ${durationMs} ms`);
      assert.ok(result.finishedAt >= startedAt);
    } finally {
      if (descendantProcessId !== undefined) {
        killDetachedProcessGroup(descendantProcessId);
      }
    }
  });

  it("force-kills a process group that ignores SIGTERM", async () => {
    const startedAt = Date.now();
    const result = await runProcess(processRequest(
      "/bin/sh",
      ["-lc", "trap '' TERM; while :; do sleep 1; done"],
      50,
    ));
    const durationMs = Date.now() - startedAt;
    assert.equal(result.terminationReason, "timeout");
    assert.equal(result.timedOut, true);
    assert.equal(result.signal, "SIGKILL");
    assert.equal(result.residualProcessGroupRemaining, false);
    assert.ok(durationMs >= 900, `SIGKILL grace was skipped after ${durationMs} ms`);
    assert.ok(durationMs < 2_500, `forced termination exceeded its bound at ${durationMs} ms`);
  });

  it("keeps the first cause and finishes once when timeout and Abort race", async () => {
    const timeoutFirst = await runTerminationRace(75, 25);
    assert.equal(timeoutFirst.result.terminationReason, "timeout");
    assert.equal(timeoutFirst.result.timedOut, true);
    assert.equal(timeoutFirst.result.aborted, true);
    assert.equal(timeoutFirst.finishCount, 1);

    const abortFirst = await runTerminationRace(25, 75);
    assert.equal(abortFirst.result.terminationReason, "aborted");
    assert.equal(abortFirst.result.aborted, true);
    assert.equal(abortFirst.result.timedOut, true);
    assert.equal(abortFirst.finishCount, 1);
  });

  it("uses the unified termination path when output exceeds the safety limit", async () => {
    const result = await runProcess(processRequest(
      process.execPath,
      [
        "-e",
        "process.stdout.write(Buffer.alloc(17 * 1024 * 1024, 'x')); setInterval(() => {}, 60000);",
      ],
      5_000,
    ));
    assert.equal(result.terminationReason, "output_limit_exceeded");
    assert.equal(result.outputLimitExceeded, true);
    assert.equal(result.timedOut, false);
    assert.equal(result.aborted, false);
    assert.equal(result.residualProcessGroupRemaining, false);
    assert.ok(Buffer.byteLength(result.stdout) <= 16 * 1024 * 1024);
  });

  it("returns a launch_failed result without exposing the environment", async () => {
    const syntheticPrivateValue = "synthetic-private-environment-value";
    const startedAt = Date.now();
    const result = await runProcess({
      ...processRequest("/definitely/missing/dsh-process-fixture", [], 1_000),
      env: { SYNTHETIC_PRIVATE_VALUE: syntheticPrivateValue },
    });
    assert.equal(result.exitCode, null);
    assert.equal(result.terminationReason, "launch_failed");
    assert.match(result.stderr, /process launch failed/u);
    assert.match(result.stderr, /dsh-process-fixture/u);
    assert.equal(result.stderr.includes(syntheticPrivateValue), false);
    assert.ok(Date.now() - startedAt < 1_000);
  });

  it("preserves normal-exit residual process-group cleanup", async () => {
    const startedAt = Date.now();
    const result = await runProcess(processRequest(
      "/bin/sh",
      [
        "-lc",
        "sleep 60 </dev/null >/dev/null 2>&1 & child_pid=$!; printf '%s\\n' \"$child_pid\"",
      ],
      2_000,
    ));
    const childProcessId = Number.parseInt(result.stdout.trim(), 10);
    assert.ok(Number.isInteger(childProcessId));
    assert.equal(result.terminationReason, "completed");
    assert.equal(result.drainCompleted, true);
    assert.equal(result.drainTimedOut, false);
    assert.equal(result.residualProcessGroupDetected, true);
    assert.equal(result.residualProcessGroupRemaining, false);
    assert.ok(Date.now() - startedAt < 1_000);
    assert.throws(
      () => process.kill(childProcessId, 0),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
    );
  });
});
