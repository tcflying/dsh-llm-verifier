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
  digest: `sha256:${"a".repeat(64)}`,
  cpus: 1,
  memory: "1g",
  pidsLimit: 128,
  network: "none",
};

function request(
  containerName: string,
  signal = new AbortController().signal,
): DockerExecutionRequest {
  return {
    executionKind: "candidate",
    readonlyRootfs: false,
    runtimeConfig: SYNTHETIC_DOCKER_CONFIG,
    containerName,
    repositoryPath: "/tmp/source-repository",
    workspacePath: `/tmp/${containerName}/workspace`,
    homePath: `/tmp/${containerName}/home`,
    dshHomePath: `/tmp/${containerName}/dsh-home`,
    command: ["dsh", "--profile", "headless", "implement the task"],
    environment: {
      HOME: "/home",
      DSH_HOME: "/dsh-home",
      TMPDIR: "/tmp",
    },
    timeoutMs: 10_000,
    deadlineAt: Date.now() + 60_000,
    signal,
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
    finishedAt: 0,
    ...overrides,
  };
}

function assertCleanupError(error: unknown, expectedDetail: RegExp): boolean {
  assert.ok(error instanceof DockerContractError);
  assert.equal(error.code, "docker_cleanup_failed");
  assert.match(error.message, /^docker_cleanup_failed:/u);
  assert.match(error.message, expectedDetail);
  return true;
}

describe("Docker container lifecycle", () => {
  it("stops and force-removes containers after timeout and abort using an independent signal", async () => {
    for (const terminationMode of ["timeout", "abort"] as const) {
      const requestAbortController = new AbortController();
      if (terminationMode === "abort") {
        requestAbortController.abort(new Error("synthetic abort"));
      }
      const dockerCommands: string[][] = [];
      const cleanupSignals: AbortSignal[] = [];
      const runDockerCommand: RunDockerContainerCommand = async (
        arguments_,
        _environment,
        _timeoutMs,
        signal,
      ) => {
        dockerCommands.push([...arguments_]);
        if (arguments_[0] === "run") {
          return processResult({
            exitCode: null,
            timedOut: terminationMode === "timeout",
            aborted: terminationMode === "abort",
          });
        }
        cleanupSignals.push(signal);
        return processResult();
      };

      const result = await runDockerContainer(
        request(`lifecycle-${terminationMode}`, requestAbortController.signal),
        { runDockerCommand },
      );

      assert.equal(result.timedOut, terminationMode === "timeout");
      assert.equal(result.aborted, terminationMode === "abort");
      assert.deepEqual(dockerCommands.slice(1), [
        ["stop", "--timeout", "1", `lifecycle-${terminationMode}`],
        ["rm", "--force", `lifecycle-${terminationMode}`],
      ]);
      assert.equal(cleanupSignals.length, 2);
      assert.equal(cleanupSignals.every((signal) => !signal.aborted), true);
      assert.equal(
        cleanupSignals.every((signal) => signal !== requestAbortController.signal),
        true,
      );
    }
  });

  it("reports a force-remove failure with a stable code and container identifier", async () => {
    const runDockerCommand: RunDockerContainerCommand = async (arguments_) => {
      if (arguments_[0] === "rm") {
        return processResult({ exitCode: 1, stderr: "synthetic remove failure" });
      }
      return processResult();
    };

    await assert.rejects(
      runDockerContainer(request("cleanup-remove-failure"), { runDockerCommand }),
      (error: unknown) => assertCleanupError(
        error,
        /containerId="cleanup-remove-failure".*errorCode=docker_remove_failed.*synthetic remove failure/u,
      ),
    );
  });

  it("accepts the exact already-absent response produced after --rm cleanup", async () => {
    const runDockerCommand: RunDockerContainerCommand = async (arguments_) => {
      if (arguments_[0] === "run") {
        return processResult();
      }
      return processResult({
        exitCode: 1,
        stderr: "Error response from daemon: No such container: already-removed",
      });
    };

    const result = await runDockerContainer(request("already-removed"), { runDockerCommand });

    assert.equal(result.exitCode, 0);
    assert.equal(result.containerId, "already-removed");
  });

  it("preserves the execution error when cleanup also fails", async () => {
    const executionError = new Error("synthetic Docker execution failure");
    const runDockerCommand: RunDockerContainerCommand = async (arguments_) => {
      if (arguments_[0] === "run") {
        throw executionError;
      }
      if (arguments_[0] === "stop") {
        return processResult({ exitCode: 1, stderr: "synthetic stop failure" });
      }
      if (arguments_[0] === "rm") {
        return processResult({ exitCode: 1, stderr: "synthetic cleanup failure" });
      }
      return processResult();
    };

    await assert.rejects(
      runDockerContainer(request("execution-and-cleanup-failure"), { runDockerCommand }),
      (error: unknown) => {
        assertCleanupError(
          error,
          /containerId="execution-and-cleanup-failure".*errorCode=docker_stop_and_remove_failed/u,
        );
        assert.match((error as Error).message, /synthetic Docker execution failure/u);
        assert.match((error as Error).message, /synthetic stop failure/u);
        assert.match((error as Error).message, /synthetic cleanup failure/u);
        assert.equal((error as Error).cause, executionError);
        return true;
      },
    );
  });

  it("keeps concurrent container names unique through run and cleanup", async () => {
    const runContainerNames: string[] = [];
    const removedContainerNames: string[] = [];
    const runDockerCommand: RunDockerContainerCommand = async (arguments_) => {
      if (arguments_[0] === "run") {
        const nameIndex = arguments_.indexOf("--name");
        const containerName = arguments_[nameIndex + 1];
        if (containerName === undefined) {
          throw new Error(`container name missing from ${JSON.stringify(arguments_)}`);
        }
        runContainerNames.push(containerName);
      }
      if (arguments_[0] === "rm") {
        const containerName = arguments_[2];
        if (containerName === undefined) {
          throw new Error(`cleanup container name missing from ${JSON.stringify(arguments_)}`);
        }
        removedContainerNames.push(containerName);
      }
      return processResult();
    };
    const containerNames = Array.from(
      { length: 5 },
      (_, index) => `lifecycle-candidate-${index + 1}`,
    );

    await Promise.all(containerNames.map((containerName) =>
      runDockerContainer(request(containerName), { runDockerCommand })));

    assert.equal(new Set(runContainerNames).size, 5);
    assert.deepEqual([...runContainerNames].sort(), [...containerNames].sort());
    assert.deepEqual([...removedContainerNames].sort(), [...containerNames].sort());
  });
});
