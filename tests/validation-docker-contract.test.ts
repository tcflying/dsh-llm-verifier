import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import type { DockerRuntimeConfig, RuntimeConfig } from "../src/config.ts";
import type { DockerExecutor, RuntimeDependencies } from "../src/contracts.ts";
import { runVerifiedBestOf } from "../src/core.ts";
import type { DockerExecutionRequest, DockerExecutionResult } from "../src/docker.ts";

const execFileAsync = promisify(execFile);
const SYNTHETIC_DOCKER_CONFIG: DockerRuntimeConfig = {
  image: "registry.test/dsh-runtime:0.1.0",
  digest: `sha256:${"a".repeat(64)}`,
  cpus: 1,
  memory: "1g",
  pidsLimit: 128,
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
    dshExecutable: "/forbidden-host-candidate-dsh",
    docker: SYNTHETIC_DOCKER_CONFIG,
  };
}

function dockerResult(
  request: DockerExecutionRequest,
  overrides: Partial<DockerExecutionResult> = {},
): DockerExecutionResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: `${request.executionKind} completed\n`,
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
    ...overrides,
  };
}

function dependencies(dockerExecutor: DockerExecutor): RuntimeDependencies {
  return {
    requestApproval: async () => undefined,
    resolveCredential: async () => "candidate-only-secret",
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

function preflightResult(config: DockerRuntimeConfig): {
  readonly daemonVersion: string;
  readonly imageReference: string;
} {
  return {
    daemonVersion: "test-daemon",
    imageReference: `${config.image}@${config.digest}`,
  };
}

describe("validation Docker boundary", () => {
  it("reports validation failure without executing the validation command in a host shell", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-validation-docker-failure-"));
    const repositoryPath = join(fixtureRoot, "repository");
    const stateDirectory = join(fixtureRoot, "state");
    const hostShellMarkerPath = join(fixtureRoot, "host-shell-ran");
    await createCleanRepository(repositoryPath);
    const dockerExecutor: DockerExecutor = {
      preflight: async (config) => preflightResult(config),
      run: async (request) => {
        if (request.executionKind === "candidate") {
          await writeFile(join(request.workspacePath, "result.txt"), "candidate result\n");
          return dockerResult(request);
        }
        return dockerResult(request, { exitCode: 17, stderr: "synthetic validation failure" });
      },
    };

    try {
      const result = await runVerifiedBestOf(
        {
          task: "Create result.txt",
          candidateCount: 3,
          validationCommands: [`printf 'host shell ran\\n' > "${hostShellMarkerPath}"`],
          repositoryPath,
        },
        runtimeConfig(stateDirectory),
        dependencies(dockerExecutor),
      );

      assert.equal(result.status, "no_winner");
      assert.equal(
        result.ranking.every((candidate) =>
          candidate.executionStatus === "completed"
          && candidate.validationStatus === "failed"
          && candidate.failure?.includes("exit code 17") === true),
        true,
      );
      await assert.rejects(access(hostShellMarkerPath));
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("uses a copied workspace, private homes, readonly rootfs, tmpfs contract, and no network", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-validation-docker-request-"));
    const repositoryPath = join(fixtureRoot, "repository");
    const stateDirectory = join(fixtureRoot, "state");
    await createCleanRepository(repositoryPath);
    const requests: DockerExecutionRequest[] = [];
    const dockerExecutor: DockerExecutor = {
      preflight: async (config) => preflightResult(config),
      run: async (request) => {
        requests.push(request);
        if (request.executionKind === "candidate") {
          await writeFile(join(request.workspacePath, "result.txt"), "candidate result\n");
        } else {
          await access(join(request.workspacePath, "result.txt"));
        }
        return dockerResult(request);
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
        runtimeConfig(stateDirectory),
        dependencies(dockerExecutor),
      );

      assert.equal(result.status, "winner_selected");
      const candidateRequests = requests.filter((request) => request.executionKind === "candidate");
      const validationRequests = requests.filter((request) => request.executionKind === "validation");
      assert.equal(candidateRequests.length, 3);
      assert.equal(validationRequests.length, 3);
      for (const validationRequest of validationRequests) {
        assert.equal(validationRequest.readonlyRootfs, true);
        assert.equal(validationRequest.runtimeConfig.network, "none");
        assert.match(validationRequest.workspacePath, /validation-runtime\/workspace$/u);
        assert.match(validationRequest.homePath, /validation-runtime\/home$/u);
        assert.match(validationRequest.dshHomePath, /validation-runtime\/dsh-home$/u);
        assert.notEqual(validationRequest.workspacePath, repositoryPath);
        assert.equal(
          candidateRequests.some((candidateRequest) =>
            candidateRequest.workspacePath === validationRequest.workspacePath
            || candidateRequest.homePath === validationRequest.homePath
            || candidateRequest.dshHomePath === validationRequest.dshHomePath),
          false,
        );
        assert.equal(validationRequest.environment.TMPDIR, "/tmp");
      }
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("does not copy host credentials, proxies, SSH agent, or host paths into validation env", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-validation-docker-env-"));
    const repositoryPath = join(fixtureRoot, "repository");
    const stateDirectory = join(fixtureRoot, "state");
    await createCleanRepository(repositoryPath);
    const environmentNames = [
      "DEEPSEEK_API_KEY",
      "OPENAI_API_KEY",
      "SSH_AUTH_SOCK",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "DSH_HOME",
    ] as const;
    const originalValues = Object.fromEntries(
      environmentNames.map((environmentName) => [environmentName, process.env[environmentName]]),
    );
    for (const environmentName of environmentNames) {
      process.env[environmentName] = environmentName === "HTTP_PROXY"
        ? "http://proxy.example.test:8080"
        : environmentName === "HTTPS_PROXY"
          ? "https://proxy.example.test:8443"
          : `forbidden-${environmentName.toLowerCase()}`;
    }
    const validationEnvironments: Readonly<Record<string, string>>[] = [];
    const dockerExecutor: DockerExecutor = {
      preflight: async (config) => preflightResult(config),
      run: async (request) => {
        if (request.executionKind === "candidate") {
          await writeFile(join(request.workspacePath, "result.txt"), "candidate result\n");
        } else {
          validationEnvironments.push(request.environment);
        }
        return dockerResult(request);
      },
    };

    try {
      await runVerifiedBestOf(
        {
          task: "Create result.txt",
          candidateCount: 3,
          validationCommands: ["test -f result.txt"],
          repositoryPath,
        },
        runtimeConfig(stateDirectory),
        dependencies(dockerExecutor),
      );

      assert.equal(validationEnvironments.length, 3);
      for (const validationEnvironment of validationEnvironments) {
        assert.deepEqual(validationEnvironment, {
          HOME: "/home",
          DSH_HOME: "/dsh-home",
          TMPDIR: "/tmp",
        });
        assert.notEqual(validationEnvironment.HOME, homedir());
        for (const environmentName of environmentNames) {
          if (environmentName !== "DSH_HOME") {
            assert.equal(environmentName in validationEnvironment, false);
          }
        }
      }
    } finally {
      for (const environmentName of environmentNames) {
        const originalValue = originalValues[environmentName];
        if (originalValue === undefined) {
          delete process.env[environmentName];
        } else {
          process.env[environmentName] = originalValue;
        }
      }
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("uses distinct container identifiers for candidate and validation executions", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-validation-docker-container-"));
    const repositoryPath = join(fixtureRoot, "repository");
    const stateDirectory = join(fixtureRoot, "state");
    await createCleanRepository(repositoryPath);
    const candidateContainerIds: string[] = [];
    const validationContainerIds: string[] = [];
    const dockerExecutor: DockerExecutor = {
      preflight: async (config) => preflightResult(config),
      run: async (request) => {
        const containerId = `${request.executionKind}:${request.containerName}`;
        if (request.executionKind === "candidate") {
          candidateContainerIds.push(containerId);
          await writeFile(join(request.workspacePath, "result.txt"), "candidate result\n");
        } else {
          validationContainerIds.push(containerId);
        }
        return dockerResult(request, { containerId });
      },
    };

    try {
      await runVerifiedBestOf(
        {
          task: "Create result.txt",
          candidateCount: 3,
          validationCommands: ["test -f result.txt"],
          repositoryPath,
        },
        runtimeConfig(stateDirectory),
        dependencies(dockerExecutor),
      );

      assert.equal(candidateContainerIds.length, 3);
      assert.equal(validationContainerIds.length, 3);
      assert.equal(
        candidateContainerIds.some((containerId) => validationContainerIds.includes(containerId)),
        false,
      );
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});
