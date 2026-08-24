import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import type { DockerRuntimeConfig, RuntimeConfig } from "../src/config.ts";
import type { DockerExecutor, RuntimeDependencies } from "../src/contracts.ts";
import { runVerifiedBestOf } from "../src/core.ts";
import {
  DockerContractError,
  type DockerExecutionRequest,
  type DockerExecutionResult,
} from "../src/docker.ts";

const execFileAsync = promisify(execFile);
const SYNTHETIC_DOCKER_CONFIG: DockerRuntimeConfig = {
  image: "registry.test/dsh-runtime:0.1.0",
  digest: `sha256:${"a".repeat(64)}`,
  cpus: 1.5,
  memory: "1536m",
  pidsLimit: 192,
  network: "none",
};

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

function runtimeConfig(
  stateDirectory: string,
  forbiddenHostExecutable: string,
  includeDockerConfig = true,
): RuntimeConfig {
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
    dshExecutable: forbiddenHostExecutable,
    ...(includeDockerConfig ? { docker: SYNTHETIC_DOCKER_CONFIG } : {}),
  };
}

function successfulDockerResult(request: DockerExecutionRequest): DockerExecutionResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: "candidate completed\n",
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
    containerId: request.containerName,
    durationMs: 1,
  };
}

function dependencies(dockerExecutor: DockerExecutor): RuntimeDependencies {
  return {
    requestApproval: async () => undefined,
    resolveCredential: async () => "synthetic-test-credential",
    runVerifier: async (request) => ({
      winnerIndex: 0,
      scores: request.candidates.map((_, index) => request.candidates.length - index),
      ranking: request.candidates.map((_, index) => index),
      requestCount: 1,
      tokenUsage: { calls: 1 },
    }),
    dockerExecutor,
  };
}

async function createHostSpawnSentinel(fixtureRoot: string): Promise<{
  readonly executablePath: string;
  readonly markerPath: string;
}> {
  const markerPath = join(fixtureRoot, "host-candidate-spawned");
  const executablePath = join(fixtureRoot, "forbidden-host-candidate.sh");
  await writeFile(
    executablePath,
    `#!/bin/sh\nprintf 'spawned\\n' > "${markerPath}"\nexit 99\n`,
  );
  await chmod(executablePath, 0o755);
  return { executablePath, markerPath };
}

describe("candidate Docker boundary", () => {
  it("fails every candidate when Docker config is missing without invoking Docker or host dsh", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-candidate-docker-missing-"));
    const repositoryPath = join(fixtureRoot, "repository");
    const stateDirectory = join(fixtureRoot, "state");
    const sentinel = await createHostSpawnSentinel(fixtureRoot);
    await createCleanRepository(repositoryPath);
    let preflightCalls = 0;
    let runCalls = 0;
    const dockerExecutor: DockerExecutor = {
      preflight: async () => {
        preflightCalls += 1;
        throw new Error("preflight must not run without Docker config");
      },
      run: async (request) => {
        runCalls += 1;
        return successfulDockerResult(request);
      },
    };

    try {
      const result = await runVerifiedBestOf(
        {
          task: "Do not execute a host candidate",
          candidateCount: 3,
          validationCommands: ["true"],
          repositoryPath,
        },
        runtimeConfig(stateDirectory, sentinel.executablePath, false),
        dependencies(dockerExecutor),
      );

      assert.equal(result.status, "no_winner");
      assert.equal(preflightCalls, 0);
      assert.equal(runCalls, 0);
      assert.equal(
        result.ranking.every((candidate) =>
          candidate.failure?.startsWith("docker_runtime_config_missing:") === true),
        true,
      );
      await assert.rejects(access(sentinel.markerPath));
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("passes the configured image, digest, resources, network, and private paths to Docker", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-candidate-docker-request-"));
    const repositoryPath = join(fixtureRoot, "repository");
    const stateDirectory = join(fixtureRoot, "state");
    const sentinel = await createHostSpawnSentinel(fixtureRoot);
    await createCleanRepository(repositoryPath);
    const preflightConfigs: DockerRuntimeConfig[] = [];
    const requests: DockerExecutionRequest[] = [];
    const dockerExecutor: DockerExecutor = {
      preflight: async (config) => {
        preflightConfigs.push(config);
        return {
          daemonVersion: "test-daemon",
          imageReference: `${config.image}@${config.digest}`,
        };
      },
      run: async (request) => {
        requests.push(request);
        if (request.executionKind === "candidate") {
          await writeFile(join(request.workspacePath, "result.txt"), "container result\n");
        } else {
          await access(join(request.workspacePath, "result.txt"));
        }
        return successfulDockerResult(request);
      },
    };

    try {
      const result = await runVerifiedBestOf(
        {
          task: "Create result.txt",
          candidateCount: 3,
          validationCommands: ["test -f result.txt"],
          repositoryPath,
        },
        runtimeConfig(stateDirectory, sentinel.executablePath),
        dependencies(dockerExecutor),
      );

      assert.equal(result.status, "winner_selected");
      assert.equal(preflightConfigs.length, 3);
      const candidateRequests = requests.filter((request) => request.executionKind === "candidate");
      const validationRequests = requests.filter((request) => request.executionKind === "validation");
      assert.equal(candidateRequests.length, 3);
      assert.equal(validationRequests.length, 3);
      for (const request of candidateRequests) {
        assert.equal(request.readonlyRootfs, false);
        assert.deepEqual(request.runtimeConfig, SYNTHETIC_DOCKER_CONFIG);
        assert.notEqual(request.workspacePath, repositoryPath);
        assert.match(request.workspacePath, /worktrees\/candidate-[123]$/u);
        assert.match(request.homePath, /artifacts\/candidate-[123]\/runtime\/home$/u);
        assert.match(request.dshHomePath, /artifacts\/candidate-[123]\/runtime\/dsh-home$/u);
        assert.notEqual(request.homePath, request.dshHomePath);
        assert.equal(request.environment.HOME, "/home");
        assert.equal(request.environment.DSH_HOME, "/dsh-home");
        assert.equal(request.environment.TMPDIR, "/tmp");
        assert.equal(request.environment.DEEPSEEK_API_KEY, "synthetic-test-credential");
        assert.equal(request.command[0], sentinel.executablePath);
      }
      for (const request of validationRequests) {
        assert.equal(request.readonlyRootfs, true);
        assert.match(request.workspacePath, /artifacts\/candidate-[123]\/validation-runtime\/workspace$/u);
        assert.deepEqual(request.environment, {
          HOME: "/home",
          DSH_HOME: "/dsh-home",
          TMPDIR: "/tmp",
        });
        assert.equal(request.command[0], "/bin/sh");
      }
      await assert.rejects(access(sentinel.markerPath));
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("turns a Docker preflight failure into candidate failures without fallback", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-candidate-docker-failure-"));
    const repositoryPath = join(fixtureRoot, "repository");
    const stateDirectory = join(fixtureRoot, "state");
    const sentinel = await createHostSpawnSentinel(fixtureRoot);
    await createCleanRepository(repositoryPath);
    let runCalls = 0;
    const dockerExecutor: DockerExecutor = {
      preflight: async () => {
        throw new DockerContractError(
          "docker_runtime_unavailable",
          "synthetic daemon failure",
        );
      },
      run: async (request) => {
        runCalls += 1;
        return successfulDockerResult(request);
      },
    };

    try {
      const result = await runVerifiedBestOf(
        {
          task: "Do not fall back to a host candidate",
          candidateCount: 3,
          validationCommands: ["true"],
          repositoryPath,
        },
        runtimeConfig(stateDirectory, sentinel.executablePath),
        dependencies(dockerExecutor),
      );

      assert.equal(result.status, "no_winner");
      assert.equal(runCalls, 0);
      assert.equal(
        result.ranking.every((candidate) =>
          candidate.failure?.startsWith("docker_runtime_unavailable:") === true),
        true,
      );
      await assert.rejects(access(sentinel.markerPath));
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("assigns a unique container name to every candidate", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-candidate-docker-names-"));
    const repositoryPath = join(fixtureRoot, "repository");
    const stateDirectory = join(fixtureRoot, "state");
    const sentinel = await createHostSpawnSentinel(fixtureRoot);
    await createCleanRepository(repositoryPath);
    const candidateContainerNames: string[] = [];
    const validationContainerNames: string[] = [];
    const dockerExecutor: DockerExecutor = {
      preflight: async (config) => ({
        daemonVersion: "test-daemon",
        imageReference: `${config.image}@${config.digest}`,
      }),
      run: async (request) => {
        if (request.executionKind === "candidate") {
          candidateContainerNames.push(request.containerName);
          await writeFile(join(request.workspacePath, "result.txt"), "candidate result\n");
        } else {
          validationContainerNames.push(request.containerName);
        }
        return successfulDockerResult(request);
      },
    };

    try {
      await runVerifiedBestOf(
        {
          task: "Capture unique container names",
          candidateCount: 5,
          validationCommands: ["true"],
          repositoryPath,
        },
        runtimeConfig(stateDirectory, sentinel.executablePath),
        dependencies(dockerExecutor),
      );

      assert.equal(candidateContainerNames.length, 5);
      assert.equal(validationContainerNames.length, 5);
      const allContainerNames = [...candidateContainerNames, ...validationContainerNames];
      assert.equal(new Set(allContainerNames).size, 10);
      assert.equal(
        candidateContainerNames.every((containerName) =>
          /^dsh-llm-verifier-candidate-[1-5]-[0-9a-f-]{36}$/u.test(containerName)),
        true,
      );
      assert.equal(
        validationContainerNames.every((containerName) =>
          /^dsh-llm-verifier-candidate-[1-5]-validation-1-[0-9a-f-]{36}$/u.test(containerName)),
        true,
      );
      await assert.rejects(access(sentinel.markerPath));
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});
