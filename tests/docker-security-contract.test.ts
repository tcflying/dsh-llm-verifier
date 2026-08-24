import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import type { DockerRuntimeConfig, RuntimeConfig } from "../src/config.ts";
import type { DockerExecutor, RuntimeDependencies } from "../src/contracts.ts";
import { runVerifiedBestOf } from "../src/core.ts";
import {
  DockerContractError,
  buildDockerRunArguments,
  type DockerExecutionRequest,
  type DockerExecutionResult,
  type RunDockerContainerCommand,
  runDockerContainer,
} from "../src/docker.ts";
import type { ProcessResult } from "../src/process.ts";

const execFileAsync = promisify(execFile);
const SYNTHETIC_CREDENTIAL = "synthetic-candidate-secret";
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

function dockerResult(
  request: DockerExecutionRequest,
  overrides: Partial<DockerExecutionResult> = {},
): DockerExecutionResult {
  return {
    ...processResult({ stdout: `${request.executionKind} completed\n` }),
    containerId: request.containerName,
    durationMs: 1,
    ...overrides,
  };
}

function baseDockerRequest(
  executionKind: DockerExecutionRequest["executionKind"] = "candidate",
): DockerExecutionRequest {
  const runtimeRoot = `/tmp/security-${executionKind}`;
  return {
    executionKind,
    readonlyRootfs: executionKind === "validation",
    runtimeConfig: SYNTHETIC_DOCKER_CONFIG,
    containerName: `security-${executionKind}`,
    repositoryPath: "/tmp/security-repository",
    workspacePath: `${runtimeRoot}/workspace`,
    homePath: `${runtimeRoot}/home`,
    dshHomePath: `${runtimeRoot}/dsh-home`,
    command: executionKind === "candidate"
      ? ["dsh", "--profile", "headless", "implement the task"]
      : ["/bin/sh", "-lc", "test -f result.txt"],
    environment: executionKind === "candidate"
      ? {
        DEEPSEEK_API_KEY: SYNTHETIC_CREDENTIAL,
        HOME: "/home",
        DSH_HOME: "/dsh-home",
        TMPDIR: "/tmp",
        DSH_PERMISSION_MODE: "workspace-write",
      }
      : {
        HOME: "/home",
        DSH_HOME: "/dsh-home",
        TMPDIR: "/tmp",
    },
    timeoutMs: 10_000,
    deadlineAt: Date.now() + 60_000,
    signal: new AbortController().signal,
  };
}

function dependencies(dockerExecutor: DockerExecutor): RuntimeDependencies {
  return {
    requestApproval: async () => undefined,
    resolveCredential: async () => SYNTHETIC_CREDENTIAL,
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

async function captureExecutionRequests(
  fixtureRoot: string,
): Promise<{
  readonly requests: DockerExecutionRequest[];
  readonly stateDirectory: string;
}> {
  const repositoryPath = join(fixtureRoot, "repository");
  const stateDirectory = join(fixtureRoot, "state");
  await createCleanRepository(repositoryPath);
  const requests: DockerExecutionRequest[] = [];
  const dockerExecutor: DockerExecutor = {
    preflight: async (config) => ({
      daemonVersion: "test-daemon",
      imageReference: `${config.image}@${config.digest}`,
    }),
    run: async (request) => {
      requests.push(request);
      if (request.executionKind === "candidate") {
        await writeFile(join(request.workspacePath, "result.txt"), "candidate result\n");
        return dockerResult(request, {
          stdout: `candidate stdout ${SYNTHETIC_CREDENTIAL}\n`,
          stderr: `candidate stderr ${SYNTHETIC_CREDENTIAL}\n`,
        });
      }
      await access(join(request.workspacePath, "result.txt"));
      return dockerResult(request);
    },
  };

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
  return { requests, stateDirectory };
}

async function assertTreeDoesNotContain(rootPath: string, forbiddenText: string): Promise<void> {
  const entries = await readdir(rootPath, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = join(rootPath, entry.name);
    if (entry.isDirectory()) {
      await assertTreeDoesNotContain(entryPath, forbiddenText);
    } else if (entry.isFile()) {
      assert.equal(
        (await readFile(entryPath)).includes(Buffer.from(forbiddenText)),
        false,
        `secret found in ${entryPath}`,
      );
    }
  }
}

function mountedSources(request: DockerExecutionRequest): Set<string> {
  return new Set([request.workspacePath, request.homePath, request.dshHomePath]);
}

describe("Docker execution security contract", () => {
  it("rejects host HOME, host DSH_HOME, repository root, and Docker socket mounts before run", async () => {
    const hostDshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");
    const maliciousRequests = [
      { ...baseDockerRequest(), homePath: homedir() },
      { ...baseDockerRequest(), dshHomePath: hostDshHome },
      { ...baseDockerRequest(), workspacePath: "/tmp/security-repository" },
      { ...baseDockerRequest(), dshHomePath: "/var/run/docker.sock" },
    ];
    let dockerCommandCalls = 0;
    const runDockerCommand: RunDockerContainerCommand = async () => {
      dockerCommandCalls += 1;
      return processResult();
    };

    for (const maliciousRequest of maliciousRequests) {
      await assert.rejects(
        runDockerContainer(maliciousRequest, { runDockerCommand }),
        (error: unknown) => {
          assert.ok(error instanceof DockerContractError);
          assert.equal(error.code, "docker_runtime_config_invalid");
          return true;
        },
      );
    }
    assert.equal(dockerCommandCalls, 0);
  });

  it("keeps every candidate and validation workspace, HOME, DSH_HOME, and name disjoint", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-docker-security-mounts-"));
    try {
      const { requests } = await captureExecutionRequests(fixtureRoot);
      const candidateRequests = requests.filter((request) => request.executionKind === "candidate");
      const validationRequests = requests.filter((request) => request.executionKind === "validation");
      assert.equal(candidateRequests.length, 3);
      assert.equal(validationRequests.length, 3);
      const allRequests = [...candidateRequests, ...validationRequests];
      assert.equal(new Set(allRequests.map((request) => request.containerName)).size, 6);
      for (const [requestIndex, request] of allRequests.entries()) {
        const currentSources = mountedSources(request);
        for (const otherRequest of allRequests.slice(requestIndex + 1)) {
          const sharedSources = [...currentSources]
            .filter((sourcePath) => mountedSources(otherRequest).has(sourcePath));
          assert.deepEqual(sharedSources, []);
        }
      }
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("injects only the configured candidate credential and keeps its value out of args, mounts, and logs", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-docker-security-candidate-env-"));
    try {
      const { requests, stateDirectory } = await captureExecutionRequests(fixtureRoot);
      const candidateRequests = requests.filter((request) => request.executionKind === "candidate");
      assert.equal(candidateRequests.length, 3);
      for (const candidateRequest of candidateRequests) {
        assert.deepEqual(
          Object.keys(candidateRequest.environment).sort(),
          ["DEEPSEEK_API_KEY", "DSH_HOME", "DSH_PERMISSION_MODE", "HOME", "TMPDIR"],
        );
        assert.equal(candidateRequest.environment.DEEPSEEK_API_KEY, SYNTHETIC_CREDENTIAL);
        assert.equal(candidateRequest.environment.DSH_PERMISSION_MODE, "workspace-write");
        for (const forbiddenName of [
          "OPENAI_API_KEY",
          "SSH_AUTH_SOCK",
          "HTTP_PROXY",
          "HTTPS_PROXY",
          "AWS_ACCESS_KEY_ID",
        ]) {
          assert.equal(forbiddenName in candidateRequest.environment, false);
        }
        const dockerArguments = buildDockerRunArguments(candidateRequest);
        assert.equal(dockerArguments.includes(SYNTHETIC_CREDENTIAL), false);
        assert.equal(
          [...mountedSources(candidateRequest)].some((path) => path.includes(SYNTHETIC_CREDENTIAL)),
          false,
        );
      }
      await assertTreeDoesNotContain(stateDirectory, SYNTHETIC_CREDENTIAL);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("keeps validation environment credential-free despite forbidden host variables", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-docker-security-validation-env-"));
    const environmentNames = [
      "DEEPSEEK_API_KEY",
      "OPENAI_API_KEY",
      "SSH_AUTH_SOCK",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "AWS_ACCESS_KEY_ID",
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
    try {
      const { requests } = await captureExecutionRequests(fixtureRoot);
      const validationRequests = requests.filter((request) => request.executionKind === "validation");
      assert.equal(validationRequests.length, 3);
      for (const validationRequest of validationRequests) {
        assert.deepEqual(validationRequest.environment, {
          HOME: "/home",
          DSH_HOME: "/dsh-home",
          TMPDIR: "/tmp",
        });
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

  it("pins every execution to network none and rejects host, bridge, and custom networks", async () => {
    for (const executionKind of ["candidate", "validation"] as const) {
      const arguments_ = buildDockerRunArguments(baseDockerRequest(executionKind));
      const networkIndex = arguments_.indexOf("--network");
      assert.notEqual(networkIndex, -1);
      assert.equal(arguments_[networkIndex + 1], "none");
      assert.equal(arguments_.some((argument) => argument.includes("docker.sock")), false);
    }
    let dockerCommandCalls = 0;
    const runDockerCommand: RunDockerContainerCommand = async () => {
      dockerCommandCalls += 1;
      return processResult();
    };
    for (const forbiddenNetwork of ["host", "bridge", "candidate-network"]) {
      const maliciousRequest: DockerExecutionRequest = {
        ...baseDockerRequest(),
        runtimeConfig: {
          ...SYNTHETIC_DOCKER_CONFIG,
          network: forbiddenNetwork as DockerRuntimeConfig["network"],
        },
      };
      await assert.rejects(
        runDockerContainer(maliciousRequest, { runDockerCommand }),
        (error: unknown) => {
          assert.ok(error instanceof DockerContractError);
          assert.equal(error.code, "docker_runtime_config_invalid");
          return true;
        },
      );
    }
    assert.equal(dockerCommandCalls, 0);
  });

  it("cleans a simulated background process before the next container runs", async () => {
    const runningContainers = new Set<string>();
    const backgroundProcesses = new Set<string>();
    const dockerCommands: string[][] = [];
    const runDockerCommand: RunDockerContainerCommand = async (arguments_) => {
      dockerCommands.push([...arguments_]);
      if (arguments_[0] === "run") {
        const nameIndex = arguments_.indexOf("--name");
        const containerName = arguments_[nameIndex + 1];
        if (containerName === undefined) {
          throw new Error(`container name missing from ${JSON.stringify(arguments_)}`);
        }
        assert.equal(runningContainers.size, 0, "a previous container was not removed");
        assert.equal(backgroundProcesses.size, 0, "a background process survived cleanup");
        runningContainers.add(containerName);
        backgroundProcesses.add(containerName);
      } else if (arguments_[0] === "stop") {
        const containerName = arguments_[3];
        if (containerName !== undefined) {
          backgroundProcesses.delete(containerName);
        }
      } else if (arguments_[0] === "rm") {
        const containerName = arguments_[2];
        if (containerName !== undefined) {
          runningContainers.delete(containerName);
        }
      }
      return processResult();
    };

    await runDockerContainer(
      { ...baseDockerRequest(), containerName: "background-candidate-1" },
      { runDockerCommand },
    );
    await runDockerContainer(
      { ...baseDockerRequest(), containerName: "background-candidate-2" },
      { runDockerCommand },
    );

    assert.equal(runningContainers.size, 0);
    assert.equal(backgroundProcesses.size, 0);
    assert.deepEqual(
      dockerCommands.filter((arguments_) => arguments_[0] !== "run"),
      [
        ["stop", "--timeout", "1", "background-candidate-1"],
        ["rm", "--force", "background-candidate-1"],
        ["stop", "--timeout", "1", "background-candidate-2"],
        ["rm", "--force", "background-candidate-2"],
      ],
    );
  });
});
