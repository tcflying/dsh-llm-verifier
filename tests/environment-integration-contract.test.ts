import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import type { DockerRuntimeConfig, RuntimeConfig } from "../src/config.ts";
import type { DockerExecutor, RuntimeDependencies } from "../src/contracts.ts";
import { runVerifiedBestOf } from "../src/core.ts";
import type { DockerExecutionRequest, DockerExecutionResult } from "../src/docker.ts";
import { runGit } from "../src/git.ts";
import type { ProcessResult } from "../src/process.ts";
import { runPythonVerifier } from "../src/verifier.ts";

const execFileAsync = promisify(execFile);
const SYNTHETIC_CREDENTIAL = "synthetic-phase3-credential";
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

function dockerResult(request: DockerExecutionRequest): DockerExecutionResult {
  return {
    ...processResult(),
    containerId: request.containerName,
    durationMs: 1,
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

function parseCapturedEnvironment(capturedEnvironment: string): Record<string, string> {
  return Object.fromEntries(capturedEnvironment.trim().split("\n").map((line) => {
    const separatorIndex = line.indexOf("=");
    if (separatorIndex < 1) {
      throw new Error(`captured environment line is invalid: ${JSON.stringify(line)}`);
    }
    return [line.slice(0, separatorIndex), line.slice(separatorIndex + 1)];
  }));
}

async function withSyntheticEnvironment<T>(
  environmentUpdates: Readonly<Record<string, string | undefined>>,
  operation: () => Promise<T>,
): Promise<T> {
  const environmentNames = new Set<string>([
    ...PROXY_ENVIRONMENT_NAMES,
    ...Object.keys(environmentUpdates),
  ]);
  const originalEnvironment = new Map(
    [...environmentNames].map((environmentName) => [environmentName, process.env[environmentName]]),
  );
  for (const environmentName of environmentNames) {
    delete process.env[environmentName];
  }
  for (const [environmentName, environmentValue] of Object.entries(environmentUpdates)) {
    if (environmentValue !== undefined) {
      process.env[environmentName] = environmentValue;
    }
  }
  try {
    return await operation();
  } finally {
    for (const environmentName of environmentNames) {
      const originalValue = originalEnvironment.get(environmentName);
      if (originalValue === undefined) {
        delete process.env[environmentName];
      } else {
        process.env[environmentName] = originalValue;
      }
    }
  }
}

function runtimeDependencies(dockerExecutor: DockerExecutor): RuntimeDependencies {
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

describe("environment builder execution-boundary integration", () => {
  it("passes only validated proxy and candidate values while validation stays exact", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-environment-candidate-integration-"));
    const repositoryPath = join(fixtureRoot, "repository");
    const stateDirectory = join(fixtureRoot, "state");
    await createCleanRepository(repositoryPath);
    const candidateEnvironments: Readonly<Record<string, string>>[] = [];
    const validationEnvironments: Readonly<Record<string, string>>[] = [];
    const dockerExecutor: DockerExecutor = {
      preflight: async (config) => ({
        daemonVersion: "test-daemon",
        imageReference: `${config.image}@${config.digest}`,
      }),
      run: async (request) => {
        assert.equal(request.runtimeConfig.network, "none");
        if (request.executionKind === "candidate") {
          candidateEnvironments.push(request.environment);
          await writeFile(join(request.workspacePath, "result.txt"), "candidate result\n");
        } else {
          validationEnvironments.push(request.environment);
        }
        return dockerResult(request);
      },
    };

    try {
      await withSyntheticEnvironment({
        HTTPS_PROXY: "https://proxy.example.invalid:8443",
        NO_PROXY: "localhost,127.0.0.1",
        NODE_USE_ENV_PROXY: "1",
        OPENAI_API_KEY: "forbidden-openai-key",
        SSH_AUTH_SOCK: "/private/forbidden-ssh-agent",
        AWS_ACCESS_KEY_ID: "forbidden-cloud-key",
      }, async () => {
        const result = await runVerifiedBestOf({
          task: "Create result.txt",
          candidateCount: 3,
          validationCommands: ["test -f result.txt"],
          repositoryPath,
        }, runtimeConfig(stateDirectory), runtimeDependencies(dockerExecutor));
        assert.equal(result.status, "winner_selected");
      });

      assert.equal(candidateEnvironments.length, 3);
      for (const environment of candidateEnvironments) {
        assert.deepEqual(environment, {
          HTTPS_PROXY: "https://proxy.example.invalid:8443",
          NO_PROXY: "localhost,127.0.0.1",
          NODE_USE_ENV_PROXY: "1",
          DEEPSEEK_API_KEY: SYNTHETIC_CREDENTIAL,
          HOME: "/home",
          DSH_HOME: "/dsh-home",
          TMPDIR: "/tmp",
          DSH_PERMISSION_MODE: "workspace-write",
        });
        assert.equal("PATH" in environment, false);
      }
      assert.equal(validationEnvironments.length, 3);
      for (const environment of validationEnvironments) {
        assert.deepEqual(environment, {
          HOME: "/home",
          DSH_HOME: "/dsh-home",
          TMPDIR: "/tmp",
        });
      }
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("uses the Git builder for the actual central Git spawn", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-environment-git-integration-"));
    const syntheticBinDirectory = join(fixtureRoot, "bin");
    const capturedEnvironmentPath = join(fixtureRoot, "git-environment.txt");
    const markerPath = join(fixtureRoot, "git-launched.marker");
    const syntheticGitPath = join(syntheticBinDirectory, "git");
    await mkdir(syntheticBinDirectory);
    await writeFile(
      syntheticGitPath,
      `#!/bin/sh\n/usr/bin/env > '${capturedEnvironmentPath}'\n/usr/bin/touch '${markerPath}'\nprintf 'synthetic git output\\n'\n`,
    );
    await chmod(syntheticGitPath, 0o755);

    try {
      await withSyntheticEnvironment({
        PATH: `${syntheticBinDirectory}:/usr/bin:/bin`,
        HTTPS_PROXY: "https://proxy.example.invalid:8443",
        DEEPSEEK_API_KEY: SYNTHETIC_CREDENTIAL,
        SSH_AUTH_SOCK: "/private/forbidden-ssh-agent",
      }, async () => {
        assert.equal(
          (await runGit(fixtureRoot, ["status"], { timeoutMs: 10_000 })).trim(),
          "synthetic git output",
        );
      });
      await access(markerPath);
      const capturedEnvironment = parseCapturedEnvironment(
        await readFile(capturedEnvironmentPath, "utf8"),
      );
      assert.equal(capturedEnvironment.GIT_CONFIG_GLOBAL, "/dev/null");
      assert.equal(capturedEnvironment.GIT_CONFIG_NOSYSTEM, "1");
      assert.equal(capturedEnvironment.GIT_PAGER, "cat");
      assert.equal(capturedEnvironment.PAGER, "cat");
      assert.equal(capturedEnvironment.GIT_TERMINAL_PROMPT, "0");
      for (const forbiddenName of [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "DEEPSEEK_API_KEY",
        "SSH_AUTH_SOCK",
      ]) {
        assert.equal(forbiddenName in capturedEnvironment, false);
      }
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("builds the verifier environment before launching the bridge", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-environment-verifier-integration-"));
    const capturedEnvironmentPath = join(fixtureRoot, "verifier-environment.txt");
    const syntheticUvPath = join(fixtureRoot, "synthetic-uv");
    await writeFile(
      syntheticUvPath,
      `#!/bin/sh\n/usr/bin/env > '${capturedEnvironmentPath}'\nprintf '%s\\n' '{"winnerIndex":0,"scores":[1],"ranking":[0],"requestCount":1,"tokenUsage":{}}'\n`,
    );
    await chmod(syntheticUvPath, 0o755);

    try {
      await withSyntheticEnvironment({
        HTTPS_PROXY: "https://proxy.example.invalid:8443",
        NO_PROXY: "localhost,127.0.0.1",
        NODE_USE_ENV_PROXY: "1",
        OPENAI_API_KEY: "forbidden-openai-key",
        SSH_AUTH_SOCK: "/private/forbidden-ssh-agent",
      }, async () => {
        const response = await runPythonVerifier({
          task: "Select the verified candidate",
          candidates: [{ candidateId: "candidate-1", trajectory: "verified" }],
          pivots: 0,
          model: "deepseek-v4-flash",
          nEvaluations: 2,
          maxWorkers: 8,
          cachePath: join(fixtureRoot, "cache"),
          deadlineAt: Date.now() + 10_000,
          timeoutMs: 10_000,
          signal: new AbortController().signal,
        }, {
          config: runtimeConfig(join(fixtureRoot, "state")),
          credentialValue: SYNTHETIC_CREDENTIAL,
          uvExecutable: syntheticUvPath,
        });
        assert.equal(response.winnerIndex, 0);
      });
      const capturedEnvironment = parseCapturedEnvironment(
        await readFile(capturedEnvironmentPath, "utf8"),
      );
      assert.equal(capturedEnvironment.HTTPS_PROXY, "https://proxy.example.invalid:8443");
      assert.equal(capturedEnvironment.NO_PROXY, "localhost,127.0.0.1");
      assert.equal(capturedEnvironment.NODE_USE_ENV_PROXY, "1");
      assert.equal(capturedEnvironment.DEEPSEEK_API_KEY, SYNTHETIC_CREDENTIAL);
      assert.equal(capturedEnvironment.DEEPSEEK_EFFORT, "high");
      assert.equal(capturedEnvironment.DEEPSEEK_MAX_TOKENS, "32768");
      assert.equal(capturedEnvironment.PYTHONUNBUFFERED, "1");
      assert.equal("OPENAI_API_KEY" in capturedEnvironment, false);
      assert.equal("SSH_AUTH_SOCK" in capturedEnvironment, false);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("rejects an invalid proxy before Git, Docker, or verifier launch", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-environment-fail-fast-integration-"));
    const repositoryPath = join(fixtureRoot, "repository");
    const stateDirectory = join(fixtureRoot, "state");
    const syntheticBinDirectory = join(fixtureRoot, "bin");
    const gitMarkerPath = join(fixtureRoot, "git-launched.marker");
    await createCleanRepository(repositoryPath);
    await mkdir(syntheticBinDirectory);
    const syntheticGitPath = join(syntheticBinDirectory, "git");
    await writeFile(syntheticGitPath, `#!/bin/sh\n/usr/bin/touch '${gitMarkerPath}'\n`);
    await chmod(syntheticGitPath, 0o755);
    let dockerPreflightCalls = 0;
    let dockerRunCalls = 0;
    let verifierCalls = 0;
    const dockerExecutor: DockerExecutor = {
      preflight: async (config) => {
        dockerPreflightCalls += 1;
        return {
          daemonVersion: "test-daemon",
          imageReference: `${config.image}@${config.digest}`,
        };
      },
      run: async (request) => {
        dockerRunCalls += 1;
        return dockerResult(request);
      },
    };
    const dependencies = runtimeDependencies(dockerExecutor);

    try {
      await withSyntheticEnvironment({
        PATH: `${syntheticBinDirectory}:/usr/bin:/bin`,
        HTTP_PROXY: "http://proxy.example.invalid:8080",
        http_proxy: "http://proxy.example.invalid:8080",
      }, async () => {
        await assert.rejects(
          runVerifiedBestOf({
            task: "Create result.txt",
            candidateCount: 3,
            validationCommands: ["test -f result.txt"],
            repositoryPath,
          }, runtimeConfig(stateDirectory), {
            ...dependencies,
            runVerifier: async (request) => {
              verifierCalls += 1;
              return dependencies.runVerifier(request);
            },
          }),
          /proxy_environment_conflict/u,
        );
      });
      await assert.rejects(access(gitMarkerPath));
      assert.equal(dockerPreflightCalls, 0);
      assert.equal(dockerRunCalls, 0);
      assert.equal(verifierCalls, 0);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});
