import { homedir, tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

import type { DockerRuntimeConfig } from "./config.ts";
import {
  proxySensitiveValues,
  redactSensitiveValues,
  runProcess,
  sanitizedEnvironment,
  type ProcessResult,
  validateProxyEnvironment,
} from "./process.ts";

export type { DockerRuntimeConfig } from "./config.ts";

const DOCKER_PREFLIGHT_TIMEOUT_MS = 10_000;
const DOCKER_CLEANUP_GRACE_CAP_MS = 10_000;
const EXPIRED_DEADLINE_CLEANUP_TIMEOUT_MS = 1;
const DOCKER_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const DOCKER_MEMORY_PATTERN = /^[1-9][0-9]*(?:[bkmg]i?b?)?$/iu;
const NON_SENSITIVE_DOCKER_ENVIRONMENT_VALUES: Readonly<Record<string, string | undefined>> = {
  HOME: "/home",
  DSH_HOME: "/dsh-home",
  TMPDIR: "/tmp",
  DSH_PERMISSION_MODE: "workspace-write",
  NODE_USE_ENV_PROXY: "1",
};

export interface DockerExecutionRequest {
  readonly executionKind: "candidate" | "validation";
  readonly readonlyRootfs: boolean;
  readonly runtimeConfig: DockerRuntimeConfig;
  readonly containerName: string;
  readonly repositoryPath: string;
  readonly workspacePath: string;
  readonly homePath: string;
  readonly dshHomePath: string;
  readonly command: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
}

export interface DockerExecutionResult extends ProcessResult {
  readonly containerId: string;
  readonly durationMs: number;
}

export type DockerContractErrorCode =
  | "docker_digest_mismatch"
  | "docker_image_missing_digest"
  | "docker_image_unavailable"
  | "docker_cleanup_failed"
  | "docker_runtime_config_invalid"
  | "docker_runtime_config_missing"
  | "docker_runtime_unavailable";

export class DockerContractError extends Error {
  readonly code: DockerContractErrorCode;

  constructor(code: DockerContractErrorCode, detail: string, options?: ErrorOptions) {
    super(`${code}: ${detail}`, options);
    this.name = "DockerContractError";
    this.code = code;
  }
}

export interface DockerCommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly aborted: boolean;
}

export type RunDockerCommand = (
  arguments_: readonly string[],
  signal: AbortSignal,
) => Promise<DockerCommandResult>;

export interface DockerPreflightOptions {
  readonly signal?: AbortSignal;
  readonly runDockerCommand?: RunDockerCommand;
}

export interface DockerPreflightResult {
  readonly daemonVersion: string;
  readonly imageReference: string;
}

export type RunDockerContainerCommand = (
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
  signal: AbortSignal,
) => Promise<ProcessResult>;

export interface DockerContainerOptions {
  readonly runDockerCommand?: RunDockerContainerCommand;
}

function invalidConfig(field: keyof DockerRuntimeConfig, value: unknown): never {
  throw new DockerContractError(
    "docker_runtime_config_invalid",
    `${field}=${JSON.stringify(value)}`,
  );
}

function validateImage(image: string): void {
  if (image.length === 0 || image.trim() !== image || image.includes("@")) {
    invalidConfig("image", image);
  }
  const lastPathSeparator = image.lastIndexOf("/");
  const tagSeparator = image.lastIndexOf(":");
  if (tagSeparator <= lastPathSeparator) {
    invalidConfig("image", image);
  }
  const tag = image.slice(tagSeparator + 1);
  if (tag.length === 0 || tag.toLowerCase() === "latest") {
    invalidConfig("image", image);
  }
}

export function validateDockerRuntimeConfig(config: DockerRuntimeConfig): void {
  validateImage(config.image);
  if (config.digest.length === 0) {
    throw new DockerContractError(
      "docker_image_missing_digest",
      `digest=${JSON.stringify(config.digest)}`,
    );
  }
  if (!DOCKER_DIGEST_PATTERN.test(config.digest)) {
    invalidConfig("digest", config.digest);
  }
  if (!Number.isFinite(config.cpus) || config.cpus <= 0) {
    invalidConfig("cpus", config.cpus);
  }
  if (!DOCKER_MEMORY_PATTERN.test(config.memory)) {
    invalidConfig("memory", config.memory);
  }
  if (!Number.isSafeInteger(config.pidsLimit) || config.pidsLimit <= 0) {
    invalidConfig("pidsLimit", config.pidsLimit);
  }
  if (config.network !== "none") {
    invalidConfig("network", config.network);
  }
}

function isPathInside(parentPath: string, childPath: string): boolean {
  const relativePath = relative(resolve(parentPath), resolve(childPath));
  return relativePath === ""
    || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function validateDockerExecutionRequest(request: DockerExecutionRequest): void {
  validateDockerRuntimeConfig(request.runtimeConfig);
  validateProxyEnvironment(request.environment);
  if (!Number.isSafeInteger(request.deadlineAt)) {
    throw new DockerContractError(
      "docker_runtime_config_invalid",
      `deadlineAt=${JSON.stringify(request.deadlineAt)}`,
    );
  }
  if (
    (request.executionKind === "candidate" && request.readonlyRootfs)
    || (request.executionKind === "validation" && !request.readonlyRootfs)
  ) {
    throw new DockerContractError(
      "docker_runtime_config_invalid",
      `executionKind=${request.executionKind}, readonlyRootfs=${request.readonlyRootfs}`,
    );
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(request.containerName)) {
    throw new DockerContractError(
      "docker_runtime_config_invalid",
      `containerName=${JSON.stringify(request.containerName)}`,
    );
  }
  const mountedPaths = [request.workspacePath, request.homePath, request.dshHomePath];
  for (const mountedPath of mountedPaths) {
    if (!isAbsolute(mountedPath)) {
      throw new DockerContractError(
        "docker_runtime_config_invalid",
        `mount source must be absolute: ${JSON.stringify(mountedPath)}`,
      );
    }
    if (mountedPath.includes("docker.sock")) {
      throw new DockerContractError(
        "docker_runtime_config_invalid",
        `docker socket mount is forbidden: ${JSON.stringify(mountedPath)}`,
      );
    }
  }
  if (new Set(mountedPaths.map((mountedPath) => resolve(mountedPath))).size !== mountedPaths.length) {
    throw new DockerContractError(
      "docker_runtime_config_invalid",
      "workspace, HOME, and DSH_HOME mount sources must be distinct",
    );
  }
  if (resolve(request.workspacePath) === resolve(request.repositoryPath)) {
    throw new DockerContractError(
      "docker_runtime_config_invalid",
      `repository root mount is forbidden: ${JSON.stringify(request.repositoryPath)}`,
    );
  }
  for (const privatePath of [request.homePath, request.dshHomePath]) {
    if (isPathInside(request.repositoryPath, privatePath)) {
      throw new DockerContractError(
        "docker_runtime_config_invalid",
        `private runtime path must be outside the repository: ${JSON.stringify(privatePath)}`,
      );
    }
  }
  const hostDshHome = process.env.DSH_HOME ?? resolve(homedir(), ".dsh");
  if (resolve(request.homePath) === resolve(homedir())) {
    throw new DockerContractError(
      "docker_runtime_config_invalid",
      `host HOME mount is forbidden: ${JSON.stringify(request.homePath)}`,
    );
  }
  if (resolve(request.dshHomePath) === resolve(hostDshHome)) {
    throw new DockerContractError(
      "docker_runtime_config_invalid",
      `host DSH_HOME mount is forbidden: ${JSON.stringify(request.dshHomePath)}`,
    );
  }
  if (request.command.length === 0 || request.command.some((argument) => argument.length === 0)) {
    throw new DockerContractError(
      "docker_runtime_config_invalid",
      `command=${JSON.stringify(request.command)}`,
    );
  }
  const requiredEnvironment = {
    HOME: "/home",
    DSH_HOME: "/dsh-home",
    TMPDIR: "/tmp",
  } as const;
  for (const [environmentName, expectedValue] of Object.entries(requiredEnvironment)) {
    if (request.environment[environmentName] !== expectedValue) {
      throw new DockerContractError(
        "docker_runtime_config_invalid",
        `${environmentName}=${JSON.stringify(request.environment[environmentName])}`,
      );
    }
  }
}

export function buildDockerRunArguments(request: DockerExecutionRequest): string[] {
  validateDockerExecutionRequest(request);
  const arguments_ = [
    "run",
    "--rm",
    "--name",
    request.containerName,
    "--cpus",
    String(request.runtimeConfig.cpus),
    "--memory",
    request.runtimeConfig.memory,
    "--pids-limit",
    String(request.runtimeConfig.pidsLimit),
    "--network",
    "none",
    ...(request.readonlyRootfs ? ["--read-only", "--tmpfs", "/tmp"] : []),
    "-v",
    `${request.workspacePath}:/workspace`,
    "-v",
    `${request.homePath}:/home`,
    "-v",
    `${request.dshHomePath}:/dsh-home`,
    "--workdir",
    "/workspace",
  ];
  for (const [environmentName, environmentValue] of Object.entries(request.environment)) {
    arguments_.push(
      "--env",
      environmentName === "HOME" || environmentName === "DSH_HOME" || environmentName === "TMPDIR"
        ? `${environmentName}=${environmentValue}`
        : environmentName,
    );
  }
  arguments_.push(
    `${request.runtimeConfig.image}@${request.runtimeConfig.digest}`,
    ...request.command,
  );
  return arguments_;
}

async function runDockerContainerCli(
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<ProcessResult> {
  return runProcess({
    executable: "docker",
    arguments: arguments_,
    cwd: tmpdir(),
    env: environment,
    timeoutMs,
    signal,
  });
}

interface DockerCleanupFailure {
  readonly operation: "remove" | "stop";
  readonly diagnostic: string;
}

interface DockerCleanupAttempt {
  readonly deadlineExceeded: boolean;
  readonly failure: DockerCleanupFailure | null;
}

interface DockerCleanupResult {
  readonly deadlineExceeded: boolean;
  readonly failures: DockerCleanupFailure[];
}

function containerIsAbsent(result: ProcessResult): boolean {
  return /No such container:/u.test(`${result.stderr}\n${result.stdout}`);
}

function dockerCommandDiagnostic(result: ProcessResult): string {
  const commandOutput = result.stderr.trim() || result.stdout.trim();
  if (commandOutput.length > 0) {
    return commandOutput;
  }
  return [
    `exitCode=${result.exitCode}`,
    `timedOut=${result.timedOut}`,
    `aborted=${result.aborted}`,
    `outputLimitExceeded=${result.outputLimitExceeded}`,
  ].join(", ");
}

async function attemptContainerCleanupCommand(
  runDockerCommand: RunDockerContainerCommand,
  arguments_: readonly string[],
  operation: DockerCleanupFailure["operation"],
  signal: AbortSignal,
  deadlineAt: number,
): Promise<DockerCleanupAttempt> {
  const cleanupStartedAt = Date.now();
  const remainingCleanupBudgetMs = deadlineAt - cleanupStartedAt;
  const deadlineExceeded = remainingCleanupBudgetMs <= 0;
  const timeoutMs = deadlineExceeded
    ? EXPIRED_DEADLINE_CLEANUP_TIMEOUT_MS
    : Math.min(DOCKER_CLEANUP_GRACE_CAP_MS, remainingCleanupBudgetMs);
  const deadlineDiagnostic = deadlineExceeded
    ? `deadline_exceeded: deadlineAt=${deadlineAt}, now=${cleanupStartedAt}`
    : null;
  let result: ProcessResult;
  try {
    result = await runDockerCommand(
      arguments_,
      sanitizedEnvironment(process.env),
      timeoutMs,
      signal,
    );
  } catch (error) {
    return {
      deadlineExceeded,
      failure: {
        operation,
        diagnostic: [
          deadlineDiagnostic,
          error instanceof Error ? error.message : String(error),
        ].filter((part): part is string => part !== null).join("; "),
      },
    };
  }
  if (commandSucceeded(result) || containerIsAbsent(result)) {
    return { deadlineExceeded, failure: null };
  }
  return {
    deadlineExceeded,
    failure: {
      operation,
      diagnostic: [deadlineDiagnostic, dockerCommandDiagnostic(result)]
        .filter((part): part is string => part !== null)
        .join("; "),
    },
  };
}

async function cleanupDockerContainer(
  containerName: string,
  runDockerCommand: RunDockerContainerCommand,
  deadlineAt: number,
): Promise<DockerCleanupResult> {
  const cleanupSignal = new AbortController().signal;
  const stopAttempt = await attemptContainerCleanupCommand(
    runDockerCommand,
    ["stop", "--timeout", "1", containerName],
    "stop",
    cleanupSignal,
    deadlineAt,
  );
  const removeAttempt = await attemptContainerCleanupCommand(
    runDockerCommand,
    ["rm", "--force", containerName],
    "remove",
    cleanupSignal,
    deadlineAt,
  );
  const failures = [stopAttempt.failure, removeAttempt.failure].filter(
    (failure): failure is DockerCleanupFailure => failure !== null,
  );
  return {
    deadlineExceeded: stopAttempt.deadlineExceeded || removeAttempt.deadlineExceeded,
    failures,
  };
}

function cleanupFailureCode(failures: readonly DockerCleanupFailure[]): string {
  const operations = new Set(failures.map((failure) => failure.operation));
  if (operations.size === 2) {
    return "docker_stop_and_remove_failed";
  }
  return operations.has("stop") ? "docker_stop_failed" : "docker_remove_failed";
}

function executionDiagnostic(
  executionResult: ProcessResult | undefined,
  executionError: unknown,
): string {
  if (executionError !== undefined) {
    return executionError instanceof Error ? executionError.message : String(executionError);
  }
  if (executionResult === undefined) {
    return "execution result unavailable";
  }
  return [
    `exitCode=${executionResult.exitCode}`,
    `timedOut=${executionResult.timedOut}`,
    `aborted=${executionResult.aborted}`,
    `outputLimitExceeded=${executionResult.outputLimitExceeded}`,
  ].join(", ");
}

function dockerSensitiveValues(environment: Readonly<Record<string, string>>): string[] {
  const sensitiveValues = new Set(proxySensitiveValues(environment));
  for (const [environmentName, environmentValue] of Object.entries(environment)) {
    if (environmentValue.length === 0) {
      continue;
    }
    const allowedValue = NON_SENSITIVE_DOCKER_ENVIRONMENT_VALUES[environmentName];
    if (
      Object.hasOwn(NON_SENSITIVE_DOCKER_ENVIRONMENT_VALUES, environmentName)
      && (allowedValue === undefined || allowedValue === environmentValue)
    ) {
      continue;
    }
    sensitiveValues.add(environmentValue);
  }
  return [...sensitiveValues].sort((left, right) => right.length - left.length);
}

export async function runDockerContainer(
  request: DockerExecutionRequest,
  options: DockerContainerOptions = {},
): Promise<DockerExecutionResult> {
  const sensitiveValues = dockerSensitiveValues(request.environment);
  const arguments_ = buildDockerRunArguments(request);
  const runDockerCommand = options.runDockerCommand ?? runDockerContainerCli;
  const dockerCliValues: Record<string, string> = {};
  for (const [environmentName, environmentValue] of Object.entries(request.environment)) {
    if (environmentName !== "HOME" && environmentName !== "DSH_HOME" && environmentName !== "TMPDIR") {
      dockerCliValues[environmentName] = environmentValue;
    }
  }
  const startedAt = Date.now();
  let executionResult: ProcessResult | undefined;
  let executionError: unknown;
  try {
    executionResult = await runDockerCommand(
      arguments_,
      sanitizedEnvironment(process.env, dockerCliValues),
      request.timeoutMs,
      request.signal,
    );
  } catch (error) {
    const executionErrorMessage = error instanceof Error ? error.message : String(error);
    const redactedExecutionErrorMessage = redactSensitiveValues(
      executionErrorMessage,
      sensitiveValues,
    );
    executionError = error instanceof Error && redactedExecutionErrorMessage === executionErrorMessage
      ? error
      : new Error(redactedExecutionErrorMessage);
  }
  const cleanup = await cleanupDockerContainer(
    request.containerName,
    runDockerCommand,
    request.deadlineAt,
  );
  const cleanupFailures = cleanup.failures;
  if (cleanupFailures.length > 0) {
    const cleanupDetails = redactSensitiveValues(cleanupFailures
      .map((failure) => `${failure.operation}=${JSON.stringify(failure.diagnostic)}`)
      .join(", "), sensitiveValues);
    const cleanupError = new DockerContractError(
      "docker_cleanup_failed",
      [
        `containerId=${JSON.stringify(request.containerName)}`,
        `errorCode=${cleanupFailureCode(cleanupFailures)}`,
        `cleanupDeadline=${cleanup.deadlineExceeded ? "deadline_exceeded" : "within_deadline"}`,
        `execution=${JSON.stringify(redactSensitiveValues(
          executionDiagnostic(executionResult, executionError),
          sensitiveValues,
        ))}`,
        cleanupDetails,
      ].join(", "),
      executionError === undefined ? undefined : { cause: executionError },
    );
    throw cleanupError;
  }
  if (executionError !== undefined) {
    throw executionError;
  }
  if (executionResult === undefined) {
    throw new Error(`Docker execution returned no result for container ${request.containerName}`);
  }
  const cleanupDeadlineDiagnostic = cleanup.deadlineExceeded
    ? `[docker cleanup deadline_exceeded: deadlineAt=${request.deadlineAt}]`
    : "";
  return {
    ...executionResult,
    stdout: redactSensitiveValues(executionResult.stdout, sensitiveValues),
    stderr: redactSensitiveValues([executionResult.stderr, cleanupDeadlineDiagnostic]
      .filter((diagnostic) => diagnostic.length > 0)
      .join("\n"), sensitiveValues),
    containerId: request.containerName,
    durationMs: Date.now() - startedAt,
  };
}

async function runDockerCli(
  arguments_: readonly string[],
  signal: AbortSignal,
): Promise<DockerCommandResult> {
  return runProcess({
    executable: "docker",
    arguments: arguments_,
    cwd: tmpdir(),
    env: sanitizedEnvironment(process.env),
    timeoutMs: DOCKER_PREFLIGHT_TIMEOUT_MS,
    signal,
  });
}

function commandSucceeded(result: DockerCommandResult): boolean {
  return result.exitCode === 0 && !result.timedOut && !result.aborted;
}

async function requireDockerCommand(
  runDockerCommand: RunDockerCommand,
  arguments_: readonly string[],
  signal: AbortSignal,
  errorCode: DockerContractErrorCode,
  detail: string,
): Promise<DockerCommandResult> {
  let result: DockerCommandResult;
  try {
    result = await runDockerCommand(arguments_, signal);
  } catch (error) {
    throw new DockerContractError(errorCode, detail, { cause: error });
  }
  if (!commandSucceeded(result)) {
    throw new DockerContractError(errorCode, detail);
  }
  return result;
}

export async function preflightDockerRuntime(
  config: DockerRuntimeConfig,
  options: DockerPreflightOptions = {},
): Promise<DockerPreflightResult> {
  validateDockerRuntimeConfig(config);
  const signal = options.signal ?? new AbortController().signal;
  if (signal.aborted) {
    throw new DockerContractError("docker_runtime_unavailable", "preflight was cancelled before launch");
  }
  const runDockerCommand = options.runDockerCommand ?? runDockerCli;
  const versionResult = await requireDockerCommand(
    runDockerCommand,
    ["version", "--format", "{{.Server.Version}}"],
    signal,
    "docker_runtime_unavailable",
    "Docker CLI or daemon is unavailable",
  );
  const daemonVersion = versionResult.stdout.trim();
  if (daemonVersion.length === 0) {
    throw new DockerContractError(
      "docker_runtime_unavailable",
      "Docker daemon returned an empty server version",
    );
  }

  const imageReference = `${config.image}@${config.digest}`;
  const inspectResult = await requireDockerCommand(
    runDockerCommand,
    ["image", "inspect", "--format", "{{json .RepoDigests}}", imageReference],
    signal,
    "docker_image_unavailable",
    `configured image is unavailable: ${imageReference}`,
  );
  let repositoryDigests: unknown;
  try {
    repositoryDigests = JSON.parse(inspectResult.stdout);
  } catch (error) {
    throw new DockerContractError(
      "docker_digest_mismatch",
      `Docker returned invalid digest metadata for ${imageReference}`,
      { cause: error },
    );
  }
  if (
    !Array.isArray(repositoryDigests)
    || !repositoryDigests.every((repositoryDigest) => typeof repositoryDigest === "string")
    || !repositoryDigests.some((repositoryDigest) => repositoryDigest.endsWith(`@${config.digest}`))
  ) {
    throw new DockerContractError(
      "docker_digest_mismatch",
      `configured digest was not reported for ${imageReference}`,
    );
  }

  return { daemonVersion, imageReference };
}
