import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { DockerRuntimeConfig } from "../src/config.ts";
import {
  DockerContractError,
  type DockerExecutionRequest,
  type RunDockerContainerCommand,
  runDockerContainer,
} from "../src/docker.ts";
import type { ProcessResult } from "../src/process.ts";

const SYNTHETIC_DOCKER_CONFIG: DockerRuntimeConfig = {
  image: "registry.test/dsh-runtime:0.1.0",
  digest: `sha256:${"c".repeat(64)}`,
  cpus: 1,
  memory: "1g",
  pidsLimit: 128,
  network: "none",
};

function request(deadlineAt: number): DockerExecutionRequest {
  return {
    executionKind: "candidate",
    readonlyRootfs: false,
    runtimeConfig: SYNTHETIC_DOCKER_CONFIG,
    containerName: "docker-deadline-contract",
    repositoryPath: "/tmp/docker-deadline-source",
    workspacePath: "/tmp/docker-deadline/workspace",
    homePath: "/tmp/docker-deadline/home",
    dshHomePath: "/tmp/docker-deadline/dsh-home",
    command: ["dsh", "--profile", "headless", "implement the task"],
    environment: {
      HOME: "/home",
      DSH_HOME: "/dsh-home",
      TMPDIR: "/tmp",
    },
    timeoutMs: 400,
    deadlineAt,
    signal: new AbortController().signal,
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

describe("Docker cleanup deadline contract", () => {
  it("limits each cleanup command to the remaining run budget", async () => {
    const cleanupTimeouts: number[] = [];
    const runDockerCommand: RunDockerContainerCommand = async (
      arguments_,
      _environment,
      timeoutMs,
    ) => {
      if (arguments_[0] !== "run") {
        cleanupTimeouts.push(timeoutMs);
      }
      return processResult();
    };

    await runDockerContainer(request(Date.now() + 500), { runDockerCommand });

    assert.equal(cleanupTimeouts.length, 2);
    assert.ok(cleanupTimeouts.every((timeoutMs) => timeoutMs > 0 && timeoutMs <= 500));
    assert.equal(cleanupTimeouts.includes(10_000), false);
  });

  it("still attempts stop and remove with one millisecond after the deadline", async () => {
    const cleanupCalls: Array<{ readonly arguments_: string[]; readonly timeoutMs: number }> = [];
    const runDockerCommand: RunDockerContainerCommand = async (
      arguments_,
      _environment,
      timeoutMs,
    ) => {
      if (arguments_[0] !== "run") {
        cleanupCalls.push({ arguments_: [...arguments_], timeoutMs });
      }
      return processResult();
    };

    const result = await runDockerContainer(request(Date.now() - 1), { runDockerCommand });

    assert.deepEqual(cleanupCalls.map((call) => call.arguments_), [
      ["stop", "--timeout", "1", "docker-deadline-contract"],
      ["rm", "--force", "docker-deadline-contract"],
    ]);
    assert.deepEqual(cleanupCalls.map((call) => call.timeoutMs), [1, 1]);
    assert.match(result.stderr, /docker cleanup deadline_exceeded/u);
  });

  it("keeps cleanup failure identity and deadline diagnostics", async () => {
    const runDockerCommand: RunDockerContainerCommand = async (arguments_) => {
      if (arguments_[0] === "run") {
        return processResult();
      }
      return processResult({
        exitCode: 1,
        stderr: `synthetic ${arguments_[0]} cleanup failure`,
      });
    };

    await assert.rejects(
      runDockerContainer(request(Date.now() - 1), { runDockerCommand }),
      (error: unknown) => {
        assert.ok(error instanceof DockerContractError);
        assert.equal(error.code, "docker_cleanup_failed");
        assert.match(error.message, /containerId="docker-deadline-contract"/u);
        assert.match(error.message, /errorCode=docker_stop_and_remove_failed/u);
        assert.match(error.message, /deadline_exceeded/u);
        assert.match(error.message, /synthetic stop cleanup failure/u);
        assert.match(error.message, /synthetic rm cleanup failure/u);
        return true;
      },
    );
  });

  it("preserves normal stop, force-remove, and already-absent semantics", async () => {
    const dockerCommands: string[][] = [];
    const runDockerCommand: RunDockerContainerCommand = async (arguments_) => {
      dockerCommands.push([...arguments_]);
      if (arguments_[0] === "stop" || arguments_[0] === "rm") {
        return processResult({
          exitCode: 1,
          stderr: "Error response from daemon: No such container: docker-deadline-contract",
        });
      }
      return processResult();
    };

    const result = await runDockerContainer(request(Date.now() + 5_000), { runDockerCommand });

    assert.equal(result.exitCode, 0);
    assert.deepEqual(dockerCommands.slice(1), [
      ["stop", "--timeout", "1", "docker-deadline-contract"],
      ["rm", "--force", "docker-deadline-contract"],
    ]);
  });
});
