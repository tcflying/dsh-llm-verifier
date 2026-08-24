import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  DockerContractError,
  type DockerCommandResult,
  type DockerExecutionRequest,
  type DockerRuntimeConfig,
  buildDockerRunArguments,
  preflightDockerRuntime,
  validateDockerRuntimeConfig,
} from "../src/docker.ts";

const CONFIGURED_DIGEST = `sha256:${"a".repeat(64)}`;
const VALID_CONFIG: DockerRuntimeConfig = {
  image: "example.invalid/dsh-llm-verifier-runtime:0.1.0",
  digest: CONFIGURED_DIGEST,
  cpus: 2,
  memory: "2g",
  pidsLimit: 256,
  network: "none",
};

function dockerExecutionRequest(
  overrides: Partial<DockerExecutionRequest> = {},
): DockerExecutionRequest {
  return {
    executionKind: "candidate",
    readonlyRootfs: false,
    runtimeConfig: VALID_CONFIG,
    containerName: "dsh-llm-verifier-candidate-1-test",
    repositoryPath: "/tmp/source-repository",
    workspacePath: "/tmp/verifier-run/workspace",
    homePath: "/tmp/verifier-run/home",
    dshHomePath: "/tmp/verifier-run/dsh-home",
    command: ["dsh", "--profile", "headless", "implement the task"],
    environment: {
      DEEPSEEK_API_KEY: "secret-not-for-command-line",
      HOME: "/home",
      DSH_HOME: "/dsh-home",
      TMPDIR: "/tmp",
      DSH_PERMISSION_MODE: "workspace-write",
    },
    timeoutMs: 10_000,
    deadlineAt: Date.now() + 60_000,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function dockerResult(overrides: Partial<DockerCommandResult> = {}): DockerCommandResult {
  return {
    exitCode: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
    aborted: false,
    ...overrides,
  };
}

function assertDockerError(error: unknown, expectedCode: DockerContractError["code"]): boolean {
  assert.ok(error instanceof DockerContractError);
  assert.equal(error.code, expectedCode);
  assert.match(error.message, new RegExp(`^${expectedCode}:`, "u"));
  return true;
}

describe("Docker-only execution contract", () => {
  it("builds a digest-pinned, resource-limited candidate command with only private mounts", () => {
    const request = dockerExecutionRequest();
    const arguments_ = buildDockerRunArguments(request);

    assert.deepEqual(arguments_.slice(0, 22), [
      "run",
      "--rm",
      "--name",
      request.containerName,
      "--cpus",
      "2",
      "--memory",
      "2g",
      "--pids-limit",
      "256",
      "--network",
      "none",
      "-v",
      "/tmp/verifier-run/workspace:/workspace",
      "-v",
      "/tmp/verifier-run/home:/home",
      "-v",
      "/tmp/verifier-run/dsh-home:/dsh-home",
      "--workdir",
      "/workspace",
      "--env",
      "DEEPSEEK_API_KEY",
    ]);
    assert.equal(arguments_.includes("HOME=/home"), true);
    assert.equal(arguments_.includes("DSH_HOME=/dsh-home"), true);
    assert.equal(arguments_.includes("TMPDIR=/tmp"), true);
    assert.equal(arguments_.includes("secret-not-for-command-line"), false);
    assert.deepEqual(arguments_.slice(-5), [
      `${VALID_CONFIG.image}@${VALID_CONFIG.digest}`,
      "dsh",
      "--profile",
      "headless",
      "implement the task",
    ]);
    assert.equal(arguments_.some((argument) => argument.includes("docker.sock")), false);
    assert.equal(arguments_.includes("/tmp/source-repository:/workspace"), false);
  });

  it("rejects repository-root, host-runtime, and Docker socket mounts", () => {
    const forbiddenRequests: DockerExecutionRequest[] = [
      dockerExecutionRequest({ workspacePath: "/tmp/source-repository" }),
      dockerExecutionRequest({ homePath: homedir() }),
      dockerExecutionRequest({ dshHomePath: process.env.DSH_HOME ?? join(homedir(), ".dsh") }),
      dockerExecutionRequest({ dshHomePath: "/var/run/docker.sock" }),
    ];

    for (const request of forbiddenRequests) {
      assert.throws(
        () => buildDockerRunArguments(request),
        (error: unknown) => assertDockerError(error, "docker_runtime_config_invalid"),
      );
    }
  });

  it("makes validation rootfs read-only with a private tmpfs while candidates remain writable", () => {
    const candidateArguments = buildDockerRunArguments(dockerExecutionRequest());
    const validationArguments = buildDockerRunArguments(dockerExecutionRequest({
      executionKind: "validation",
      readonlyRootfs: true,
      containerName: "dsh-llm-verifier-validation-test",
    }));

    assert.equal(candidateArguments.includes("--read-only"), false);
    assert.equal(candidateArguments.includes("--tmpfs"), false);
    assert.equal(validationArguments.includes("--read-only"), true);
    const tmpfsIndex = validationArguments.indexOf("--tmpfs");
    assert.notEqual(tmpfsIndex, -1);
    assert.equal(validationArguments[tmpfsIndex + 1], "/tmp");
    assert.equal(validationArguments.includes("--network"), true);
    assert.equal(validationArguments[validationArguments.indexOf("--network") + 1], "none");
  });

  it("rejects execution kinds whose readonly-rootfs policy does not match", () => {
    for (const request of [
      dockerExecutionRequest({ executionKind: "candidate", readonlyRootfs: true }),
      dockerExecutionRequest({ executionKind: "validation", readonlyRootfs: false }),
    ]) {
      assert.throws(
        () => buildDockerRunArguments(request),
        (error: unknown) => assertDockerError(error, "docker_runtime_config_invalid"),
      );
    }
  });

  it("rejects a missing digest before invoking the Docker CLI", async () => {
    let dockerCommandCalls = 0;
    await assert.rejects(
      preflightDockerRuntime(
        { ...VALID_CONFIG, digest: "" },
        {
          runDockerCommand: async () => {
            dockerCommandCalls += 1;
            return dockerResult();
          },
        },
      ),
      (error: unknown) => assertDockerError(error, "docker_image_missing_digest"),
    );
    assert.equal(dockerCommandCalls, 0);
  });

  it("rejects latest and implicit-latest image references", () => {
    for (const image of ["example.invalid/runtime:latest", "example.invalid/runtime"]) {
      assert.throws(
        () => validateDockerRuntimeConfig({ ...VALID_CONFIG, image }),
        (error: unknown) => assertDockerError(error, "docker_runtime_config_invalid"),
      );
    }
  });

  it("rejects every missing or invalid resource field before Docker access", async () => {
    const invalidConfigs: DockerRuntimeConfig[] = [
      { ...VALID_CONFIG, digest: "sha256:not-a-digest" },
      { ...VALID_CONFIG, cpus: 0 },
      { ...VALID_CONFIG, memory: "" },
      { ...VALID_CONFIG, pidsLimit: 0 },
      { ...VALID_CONFIG, network: "bridge" as DockerRuntimeConfig["network"] },
    ];
    for (const invalidConfig of invalidConfigs) {
      let dockerCommandCalls = 0;
      await assert.rejects(
        preflightDockerRuntime(invalidConfig, {
          runDockerCommand: async () => {
            dockerCommandCalls += 1;
            return dockerResult();
          },
        }),
        (error: unknown) => assertDockerError(error, "docker_runtime_config_invalid"),
      );
      assert.equal(dockerCommandCalls, 0);
    }
  });

  it("fails when the Docker CLI or daemon is unavailable without attempting inspect or run", async () => {
    for (const failureMode of ["missing-cli", "unavailable-daemon"] as const) {
      const dockerCommands: string[][] = [];
      await assert.rejects(
        preflightDockerRuntime(VALID_CONFIG, {
          runDockerCommand: async (arguments_) => {
            dockerCommands.push([...arguments_]);
            if (failureMode === "missing-cli") {
              throw new Error("spawn docker ENOENT");
            }
            return dockerResult({ exitCode: 1, stderr: "daemon unavailable" });
          },
        }),
        (error: unknown) => assertDockerError(error, "docker_runtime_unavailable"),
      );
      assert.deepEqual(dockerCommands, [["version", "--format", "{{.Server.Version}}"]]);
      assert.equal(dockerCommands.some((arguments_) => arguments_[0] === "run"), false);
    }
  });

  it("rejects an unavailable image without attempting docker run", async () => {
    const dockerCommands: string[][] = [];
    await assert.rejects(
      preflightDockerRuntime(VALID_CONFIG, {
        runDockerCommand: async (arguments_) => {
          dockerCommands.push([...arguments_]);
          return arguments_[0] === "version"
            ? dockerResult({ stdout: "29.2.1\n" })
            : dockerResult({ exitCode: 1, stderr: "No such image" });
        },
      }),
      (error: unknown) => assertDockerError(error, "docker_image_unavailable"),
    );
    assert.equal(dockerCommands.some((arguments_) => arguments_[0] === "run"), false);
  });

  it("rejects a digest mismatch without attempting docker run", async () => {
    const dockerCommands: string[][] = [];
    await assert.rejects(
      preflightDockerRuntime(VALID_CONFIG, {
        runDockerCommand: async (arguments_) => {
          dockerCommands.push([...arguments_]);
          if (arguments_[0] === "version") {
            return dockerResult({ stdout: "29.2.1\n" });
          }
          return dockerResult({ stdout: JSON.stringify([`example.invalid/runtime@sha256:${"b".repeat(64)}`]) });
        },
      }),
      (error: unknown) => assertDockerError(error, "docker_digest_mismatch"),
    );
    assert.equal(dockerCommands.some((arguments_) => arguments_[0] === "run"), false);
  });

  it("accepts only a reachable daemon and the exact configured image digest", async () => {
    const dockerCommands: string[][] = [];
    const result = await preflightDockerRuntime(VALID_CONFIG, {
      runDockerCommand: async (arguments_) => {
        dockerCommands.push([...arguments_]);
        if (arguments_[0] === "version") {
          return dockerResult({ stdout: "29.2.1\n" });
        }
        return dockerResult({
          stdout: JSON.stringify([`example.invalid/dsh-llm-verifier-runtime@${CONFIGURED_DIGEST}`]),
        });
      },
    });

    assert.deepEqual(result, {
      daemonVersion: "29.2.1",
      imageReference: `${VALID_CONFIG.image}@${CONFIGURED_DIGEST}`,
    });
    assert.deepEqual(dockerCommands, [
      ["version", "--format", "{{.Server.Version}}"],
      [
        "image",
        "inspect",
        "--format",
        "{{json .RepoDigests}}",
        `${VALID_CONFIG.image}@${CONFIGURED_DIGEST}`,
      ],
    ]);
    assert.equal(dockerCommands.some((arguments_) => arguments_[0] === "run"), false);
  });
});
