import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import type { DockerRuntimeConfig, RuntimeConfig } from "../src/config.ts";
import type { DockerExecutor, RuntimeDependencies } from "../src/contracts.ts";
import { runVerifiedBestOf } from "../src/core.ts";
import {
  type DockerExecutionRequest,
  type DockerExecutionResult,
  type RunDockerContainerCommand,
  runDockerContainer,
} from "../src/docker.ts";
import type { ProcessResult } from "../src/process.ts";
import { runPythonVerifier } from "../src/verifier.ts";

const execFileAsync = promisify(execFile);
const SYNTHETIC_CREDENTIAL = "phase3-sensitive-credential";
const SYNTHETIC_PROXY = "https://proxy-sensitive.example.invalid:9443";
const SYNTHETIC_NO_PROXY = "private.internal.invalid,10.0.0.0/8";
const PROXY_ENVIRONMENT_NAMES = [
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
  "NODE_USE_ENV_PROXY",
] as const;
const SYNTHETIC_DOCKER_CONFIG: DockerRuntimeConfig = {
  image: "registry.test/dsh-runtime:0.1.0",
  digest: `sha256:${"a".repeat(64)}`,
  cpus: 1,
  memory: "1g",
  pidsLimit: 128,
  network: "none",
};

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
    dshExecutable: "dsh",
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
    finishedAt: Date.now(),
    ...overrides,
  };
}

function dockerResult(
  request: DockerExecutionRequest,
  overrides: Partial<DockerExecutionResult> = {},
): DockerExecutionResult {
  return {
    ...processResult(),
    containerId: request.containerName,
    durationMs: 1,
    ...overrides,
  };
}

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

async function withSyntheticProxy<T>(operation: () => Promise<T>): Promise<T> {
  const originalEnvironment = new Map(
    PROXY_ENVIRONMENT_NAMES.map((environmentName) => [environmentName, process.env[environmentName]]),
  );
  for (const environmentName of PROXY_ENVIRONMENT_NAMES) {
    delete process.env[environmentName];
  }
  process.env.HTTPS_PROXY = SYNTHETIC_PROXY;
  process.env.NO_PROXY = SYNTHETIC_NO_PROXY;
  process.env.NODE_USE_ENV_PROXY = "1";
  try {
    return await operation();
  } finally {
    for (const environmentName of PROXY_ENVIRONMENT_NAMES) {
      const originalValue = originalEnvironment.get(environmentName);
      if (originalValue === undefined) {
        delete process.env[environmentName];
      } else {
        process.env[environmentName] = originalValue;
      }
    }
  }
}

async function assertTreeExcludesSensitiveValues(rootPath: string): Promise<void> {
  const sensitiveBuffers = [SYNTHETIC_CREDENTIAL, SYNTHETIC_PROXY, SYNTHETIC_NO_PROXY]
    .map((sensitiveValue) => Buffer.from(sensitiveValue));
  for (const directoryEntry of await readdir(rootPath, { withFileTypes: true })) {
    const entryPath = join(rootPath, directoryEntry.name);
    if (directoryEntry.isDirectory()) {
      await assertTreeExcludesSensitiveValues(entryPath);
    } else if (directoryEntry.isFile()) {
      const fileContents = await readFile(entryPath);
      for (const sensitiveBuffer of sensitiveBuffers) {
        assert.equal(fileContents.includes(sensitiveBuffer), false, `sensitive value found in ${entryPath}`);
      }
    }
  }
}

function candidateNumber(request: DockerExecutionRequest): number {
  const match = /candidate-(\d+)/u.exec(request.workspacePath);
  if (match?.[1] === undefined) {
    throw new Error(`candidate number missing from ${JSON.stringify(request.workspacePath)}`);
  }
  return Number(match[1]);
}

function dependencies(
  dockerExecutor: DockerExecutor,
  runVerifier: RuntimeDependencies["runVerifier"],
): RuntimeDependencies {
  return {
    requestApproval: async () => undefined,
    resolveCredential: async () => SYNTHETIC_CREDENTIAL,
    runVerifier,
    dockerExecutor,
  };
}

describe("proxy and credential redaction", () => {
  it("redacts verifier process failures before they cross the error boundary", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-proxy-redaction-error-"));
    const syntheticUvPath = join(fixtureRoot, "synthetic-uv");
    await writeFile(
      syntheticUvPath,
      `#!/bin/sh\nprintf '%s\\n' '${SYNTHETIC_PROXY} ${SYNTHETIC_NO_PROXY} ${SYNTHETIC_CREDENTIAL}' >&2\nexit 1\n`,
    );
    await chmod(syntheticUvPath, 0o755);

    try {
      await withSyntheticProxy(async () => {
        await assert.rejects(
          runPythonVerifier({
            task: "select a candidate",
            candidates: [{ candidateId: "candidate-1", trajectory: "safe" }],
            pivots: 0,
            model: "deepseek-v4-flash",
            nEvaluations: 2,
            maxWorkers: 8,
            cachePath: join(fixtureRoot, "cache.json"),
            deadlineAt: Date.now() + 10_000,
            timeoutMs: 10_000,
            signal: new AbortController().signal,
          }, {
            config: runtimeConfig(join(fixtureRoot, "state")),
            credentialValue: SYNTHETIC_CREDENTIAL,
            uvExecutable: syntheticUvPath,
          }),
          (error: unknown) => {
            const errorMessage = error instanceof Error ? error.message : String(error);
            assert.match(errorMessage, /\[REDACTED\]/u);
            assert.doesNotMatch(errorMessage, new RegExp(SYNTHETIC_CREDENTIAL, "u"));
            assert.doesNotMatch(errorMessage, new RegExp(SYNTHETIC_PROXY, "u"));
            assert.doesNotMatch(errorMessage, new RegExp(SYNTHETIC_NO_PROXY, "u"));
            return true;
          },
        );
      });
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("redacts candidate and validation output from results, reports, and state", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-proxy-redaction-state-"));
    const repositoryPath = join(fixtureRoot, "repository");
    const stateDirectory = join(fixtureRoot, "state");
    await createCleanRepository(repositoryPath);
    const dockerExecutor: DockerExecutor = {
      preflight: async (config) => ({
        daemonVersion: "test-daemon",
        imageReference: `${config.image}@${config.digest}`,
      }),
      run: async (request) => {
        const rawOutput = `${SYNTHETIC_PROXY} ${SYNTHETIC_NO_PROXY} ${SYNTHETIC_CREDENTIAL}`;
        if (request.executionKind === "candidate") {
          if (candidateNumber(request) === 1) {
            await writeFile(join(request.workspacePath, "result.txt"), "safe candidate result\n");
            return dockerResult(request, { stdout: rawOutput, stderr: rawOutput });
          }
          if (candidateNumber(request) === 2) {
            await writeFile(join(request.workspacePath, "leak.txt"), `${SYNTHETIC_PROXY}\n`);
            return dockerResult(request, { stdout: rawOutput, stderr: rawOutput });
          }
          return dockerResult(request, { exitCode: 2, stdout: rawOutput, stderr: rawOutput });
        }
        return dockerResult(request, { stdout: rawOutput, stderr: rawOutput });
      },
    };

    try {
      await withSyntheticProxy(async () => {
        const result = await runVerifiedBestOf({
          task: "Create result.txt",
          candidateCount: 3,
          validationCommands: ["test -f result.txt"],
          repositoryPath,
        }, runtimeConfig(stateDirectory), dependencies(dockerExecutor, async () => {
          throw new Error("verifier must not run with one eligible candidate");
        }));
        const serializedResult = JSON.stringify(result);
        assert.equal(result.status, "winner_selected");
        assert.match(await readFile(result.reportPath, "utf8"), /\[REDACTED\]/u);
        for (const sensitiveValue of [SYNTHETIC_CREDENTIAL, SYNTHETIC_PROXY, SYNTHETIC_NO_PROXY]) {
          assert.equal(serializedResult.includes(sensitiveValue), false);
        }
        await assertTreeExcludesSensitiveValues(stateDirectory);
      });
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("sends only redacted candidate traces to the verifier and sanitizes its response", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-proxy-redaction-verifier-"));
    const repositoryPath = join(fixtureRoot, "repository");
    const stateDirectory = join(fixtureRoot, "state");
    await createCleanRepository(repositoryPath);
    let serializedVerifierRequest = "";
    const dockerExecutor: DockerExecutor = {
      preflight: async (config) => ({
        daemonVersion: "test-daemon",
        imageReference: `${config.image}@${config.digest}`,
      }),
      run: async (request) => {
        const rawOutput = `${SYNTHETIC_PROXY} ${SYNTHETIC_NO_PROXY} ${SYNTHETIC_CREDENTIAL}`;
        if (request.executionKind === "candidate") {
          await writeFile(
            join(request.workspacePath, `result-${candidateNumber(request)}.txt`),
            "safe candidate result\n",
          );
        }
        return dockerResult(request, { stdout: rawOutput, stderr: rawOutput });
      },
    };

    try {
      await withSyntheticProxy(async () => {
        const result = await runVerifiedBestOf({
          task: "Create a result file",
          candidateCount: 3,
          validationCommands: ["true"],
          repositoryPath,
        }, runtimeConfig(stateDirectory), dependencies(dockerExecutor, async (request) => {
          serializedVerifierRequest = JSON.stringify(request);
          return {
            winnerIndex: 0,
            scores: [3, 2, 1],
            ranking: [0, 1, 2],
            requestCount: 1,
            tokenUsage: {
              [SYNTHETIC_PROXY]: SYNTHETIC_CREDENTIAL,
              bypass: SYNTHETIC_NO_PROXY,
            },
            diagnostics: `${SYNTHETIC_PROXY} ${SYNTHETIC_CREDENTIAL}`,
          };
        }));
        assert.equal(result.status, "winner_selected");
        for (const sensitiveValue of [SYNTHETIC_CREDENTIAL, SYNTHETIC_PROXY, SYNTHETIC_NO_PROXY]) {
          assert.equal(serializedVerifierRequest.includes(sensitiveValue), false);
          assert.equal(JSON.stringify(result).includes(sensitiveValue), false);
        }
        await assertTreeExcludesSensitiveValues(stateDirectory);
      });
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("redacts direct Docker results and thrown execution errors", async () => {
    const request: DockerExecutionRequest = {
      executionKind: "candidate",
      readonlyRootfs: false,
      runtimeConfig: SYNTHETIC_DOCKER_CONFIG,
      containerName: "proxy-redaction-container",
      repositoryPath: "/tmp/proxy-redaction-repository",
      workspacePath: "/tmp/proxy-redaction-workspace",
      homePath: "/tmp/proxy-redaction-home",
      dshHomePath: "/tmp/proxy-redaction-dsh-home",
      command: ["dsh", "--profile", "headless", "safe task"],
      environment: {
        HTTPS_PROXY: SYNTHETIC_PROXY,
        NO_PROXY: SYNTHETIC_NO_PROXY,
        NODE_USE_ENV_PROXY: "1",
        DEEPSEEK_API_KEY: SYNTHETIC_CREDENTIAL,
        HOME: "/home",
        DSH_HOME: "/dsh-home",
        TMPDIR: "/tmp",
        DSH_PERMISSION_MODE: "workspace-write",
      },
      timeoutMs: 10_000,
      deadlineAt: Date.now() + 60_000,
      signal: new AbortController().signal,
    };
    const rawOutput = `${SYNTHETIC_PROXY} ${SYNTHETIC_NO_PROXY} ${SYNTHETIC_CREDENTIAL}`;
    const successfulCommand: RunDockerContainerCommand = async (arguments_) => {
      return arguments_[0] === "run"
        ? processResult({ stdout: rawOutput, stderr: rawOutput })
        : processResult();
    };
    const result = await runDockerContainer(request, { runDockerCommand: successfulCommand });
    assert.match(`${result.stdout}${result.stderr}`, /\[REDACTED\]/u);
    assert.equal(`${result.stdout}${result.stderr}`.includes(SYNTHETIC_CREDENTIAL), false);
    assert.equal(`${result.stdout}${result.stderr}`.includes(SYNTHETIC_PROXY), false);
    assert.equal(`${result.stdout}${result.stderr}`.includes(SYNTHETIC_NO_PROXY), false);

    const failingCommand: RunDockerContainerCommand = async (arguments_) => {
      if (arguments_[0] === "run") {
        throw new Error(rawOutput);
      }
      return processResult();
    };
    await assert.rejects(
      runDockerContainer(request, { runDockerCommand: failingCommand }),
      (error: unknown) => {
        const errorMessage = error instanceof Error ? error.message : String(error);
        assert.match(errorMessage, /\[REDACTED\]/u);
        assert.equal(errorMessage.includes(SYNTHETIC_CREDENTIAL), false);
        assert.equal(errorMessage.includes(SYNTHETIC_PROXY), false);
        assert.equal(errorMessage.includes(SYNTHETIC_NO_PROXY), false);
        return true;
      },
    );
  });
});
