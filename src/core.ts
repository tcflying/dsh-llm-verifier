import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readlink, realpath, rm, statfs, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import type { CandidateCount, RuntimeConfig } from "./config.ts";
import { normalizeCandidateCount } from "./config.ts";
import type {
  CandidateResult,
  DockerExecutor,
  ApplyVerifiedWinnerResult,
  ApplyRuntimeDependencies,
  JsonValue,
  PublicCandidateResult,
  RuntimeDependencies,
  TraceEnvelope,
  TraceEnvelopeMetadata,
  TraceSectionMetadata,
  VerifiedBestOfResult,
  VerifierResponse,
} from "./contracts.ts";
import {
  assertPatchArtifactIdentity,
  captureCandidateChanges,
  capturePatchArtifact,
  createPatchArtifact,
  createDetachedWorktree,
  inspectRepository,
  removeWorktree,
  runGit,
  type GitExecutionOptions,
  type PatchArtifact,
  type RepositorySnapshot,
} from "./git.ts";
import {
  buildCandidateEnvironment,
  buildGitEnvironment,
  buildValidationEnvironment,
  proxySensitiveValues,
  redactSensitiveJsonValue,
  redactSensitiveValues,
  runProcess,
  validateProxyEnvironment,
} from "./process.ts";
import { resolveValidationCommands } from "./validation.ts";

const MINIMUM_FREE_BYTES_PER_CANDIDATE = 512 * 1024 * 1024;
const GIT_CLEANUP_GRACE_CAP_MS = 10_000;
const EXPIRED_DEADLINE_GIT_CLEANUP_TIMEOUT_MS = 1;
const CREDENTIAL_REFERENCE = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const MAX_TASK_CHARACTERS = 100_000;
const PLUGIN_VERSION = "0.1.0";

export interface RunVerifiedBestOfInput {
  readonly task: string;
  readonly candidateCount?: number;
  readonly validationCommands?: readonly string[];
  readonly repositoryPath: string;
  readonly signal?: AbortSignal;
}

export interface ApplyVerifiedWinnerInput {
  readonly runId: string;
  readonly repositoryPath: string;
  readonly signal?: AbortSignal;
}

interface StoredRunManifest {
  readonly repositoryPath: string;
  readonly baseCommit: string;
  readonly validationCommands: string[];
  readonly winnerPatchSha256: string;
  readonly winnerPatchPath: string;
  readonly winnerId: string;
  readonly changedFiles: string[];
}

interface CandidateExecutionRequest {
  readonly candidateId: string;
  readonly worktreePath: string;
  readonly candidateArtifactsDirectory: string;
  readonly task: string;
  readonly validationCommands: readonly string[];
  readonly repository: RepositorySnapshot;
  readonly config: RuntimeConfig;
  readonly credentialValue: string;
  readonly sensitiveValues: readonly string[];
  readonly dockerExecutor: DockerExecutor;
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
}

interface CandidateExecutionResult extends CandidateResult {
  readonly patchArtifact: PatchArtifact | null;
  readonly validationInputPatchSha256: string | null;
}

export class RunDeadlineExceededError extends Error {
  readonly code = "deadline_exceeded";

  constructor(deadlineAt: number, now: number) {
    super(`deadline_exceeded: deadlineAt=${deadlineAt}, now=${now}`);
    this.name = "RunDeadlineExceededError";
  }
}

export function remainingMs(deadlineAt: number, now: number): number {
  if (!Number.isSafeInteger(deadlineAt)) {
    throw new Error(`invalid deadlineAt: expected a safe integer, got ${JSON.stringify(deadlineAt)}`);
  }
  if (!Number.isSafeInteger(now)) {
    throw new Error(`invalid now: expected a safe integer, got ${JSON.stringify(now)}`);
  }
  const remainingBudgetMs = deadlineAt - now;
  if (remainingBudgetMs <= 0) {
    throw new RunDeadlineExceededError(deadlineAt, now);
  }
  return remainingBudgetMs;
}

function stageTimeoutMs(stageLimitMs: number, deadlineAt: number): number {
  return Math.min(stageLimitMs, remainingMs(deadlineAt, Date.now()));
}

export function gitExecutionOptionsForDeadline(
  deadlineAt: number,
  signal: AbortSignal,
): GitExecutionOptions {
  return {
    signal,
    timeoutMs: remainingMs(deadlineAt, Date.now()),
  };
}

export function gitExecutionOptionsForCommandCap(
  timeoutMs: number,
  signal: AbortSignal,
): GitExecutionOptions {
  return { signal, timeoutMs };
}

function gitCleanupExecutionOptions(deadlineAt: number): GitExecutionOptions {
  const remainingCleanupBudgetMs = deadlineAt - Date.now();
  return {
    signal: new AbortController().signal,
    timeoutMs: remainingCleanupBudgetMs <= 0
      ? EXPIRED_DEADLINE_GIT_CLEANUP_TIMEOUT_MS
      : Math.min(GIT_CLEANUP_GRACE_CAP_MS, remainingCleanupBudgetMs),
  };
}

function validateTask(task: string): string {
  const normalizedTask = task.trim();
  if (normalizedTask.length === 0 || normalizedTask.length > MAX_TASK_CHARACTERS) {
    throw new Error(
      `invalid task: expected 1-${MAX_TASK_CHARACTERS} characters, got ${task.length}`,
    );
  }
  return normalizedTask;
}

function isPathInside(parentPath: string, childPath: string): boolean {
  const relativePath = relative(parentPath, childPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

async function canonicalStateDirectory(
  configuredStateDirectory: string,
  repositoryPath: string,
): Promise<string> {
  if (!isAbsolute(configuredStateDirectory)) {
    throw new Error(
      `invalid stateDirectory: expected an absolute path, got ${JSON.stringify(configuredStateDirectory)}`,
    );
  }
  const resolvedStateDirectory = resolve(configuredStateDirectory);
  let stateDirectory: string;
  try {
    stateDirectory = await realpath(resolvedStateDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    const stateDirectoryParent = await realpath(dirname(resolvedStateDirectory));
    stateDirectory = join(stateDirectoryParent, resolvedStateDirectory.split("/").at(-1) ?? "");
  }
  if (isPathInside(repositoryPath, stateDirectory)) {
    throw new Error(
      `invalid stateDirectory: ${stateDirectory} must be outside repository ${repositoryPath}`,
    );
  }
  return stateDirectory;
}

async function assertEnoughDiskSpace(
  stateDirectory: string,
  candidateCount: CandidateCount,
): Promise<void> {
  const fileSystemStats = await statfs(dirname(stateDirectory), { bigint: true });
  const availableBytes = fileSystemStats.bavail * fileSystemStats.bsize;
  const requiredBytes = BigInt(candidateCount * MINIMUM_FREE_BYTES_PER_CANDIDATE);
  if (availableBytes < requiredBytes) {
    throw new Error(
      `insufficient disk space for ${candidateCount} candidates: required ${requiredBytes} bytes, available ${availableBytes} bytes at ${stateDirectory}`,
    );
  }
}

export function createApprovalReason(
  repository: RepositorySnapshot,
  candidateCount: CandidateCount,
  validationCommands: readonly string[],
  config: RuntimeConfig,
): string {
  const estimatedVerifierRequests = (candidateCount === 3 ? 18 : 36) * config.nEvaluations;
  return [
    `Run ${candidateCount} isolated DeepSeek Harness candidates in ${repository.repositoryPath}.`,
    `Base commit: ${repository.baseCommit}.`,
    `Validation commands: ${validationCommands.join("; ")}.`,
    "The task, text diffs, and validation evidence may be sent to DeepSeek.",
    `Total run deadline budget after approval and credential resolution: ${config.runTimeoutMs} ms.`,
    `Candidate time policy: each candidate is capped at ${config.candidateTimeoutMs} ms and receives only the remaining shared run budget if it is smaller.`,
    `Validation time policy: each validation command is capped at ${config.validationTimeoutMs} ms and receives only the remaining shared run budget if it is smaller.`,
    "Verifier time policy: the verifier receives only the remaining shared run budget and does not receive a fresh full timeout.",
    "Cleanup grace policy: a unified cleanup deadline budget is unavailable; bounded process and Docker cleanup may finish after the run deadline.",
    `Candidate generation budget: ${candidateCount} headless Harness tasks using profile ${config.candidateProfile}.`,
    `Verifier budget: approximately ${estimatedVerifierRequests} requests to ${config.verifierModel} if every candidate passes (${config.nEvaluations} evaluations per comparison).`,
    "These are estimates; the report records the actual completed tasks and verifier requests.",
  ].join("\n");
}

export function createTraceEnvelope(
  traceBytes: Buffer,
  maximumBytes: number,
  sections: readonly TraceSectionMetadata[],
  artifactSha256: string | null,
): TraceEnvelope {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new Error(`invalid maximumBytes: expected a positive safe integer, got ${JSON.stringify(maximumBytes)}`);
  }
  if (artifactSha256 !== null && !/^[0-9a-f]{64}$/u.test(artifactSha256)) {
    throw new Error(`invalid artifactSha256: ${JSON.stringify(artifactSha256)}`);
  }
  const ownedTraceBytes = Buffer.from(traceBytes);
  if (ownedTraceBytes.length <= maximumBytes) {
    return {
      totalBytes: ownedTraceBytes.length,
      retainedBytes: ownedTraceBytes.length,
      truncated: false,
      head: ownedTraceBytes,
      tail: Buffer.alloc(0),
      sections: sections.map((section) => ({ ...section })),
      artifactSha256,
    };
  }
  const headBytes = Math.ceil(maximumBytes / 2);
  const tailBytes = maximumBytes - headBytes;
  return {
    totalBytes: ownedTraceBytes.length,
    retainedBytes: maximumBytes,
    truncated: true,
    head: Buffer.from(ownedTraceBytes.subarray(0, headBytes)),
    tail: Buffer.from(ownedTraceBytes.subarray(ownedTraceBytes.length - tailBytes)),
    sections: sections.map((section) => ({ ...section })),
    artifactSha256,
  };
}

export function renderTraceEnvelope(envelope: TraceEnvelope): string {
  if (!envelope.truncated) {
    return envelope.head.toString("utf8");
  }
  const metadata = JSON.stringify({
    totalBytes: envelope.totalBytes,
    retainedBytes: envelope.retainedBytes,
    headBytes: envelope.head.length,
    tailBytes: envelope.tail.length,
    truncated: envelope.truncated,
    artifactSha256: envelope.artifactSha256,
    sections: envelope.sections,
  });
  return [
    envelope.head.toString("utf8"),
    `[trace metadata: ${metadata}; complete input retained locally]`,
    envelope.tail.toString("utf8"),
  ].join("\n\n");
}

function traceEnvelopeMetadata(envelope: TraceEnvelope): TraceEnvelopeMetadata {
  return {
    totalBytes: envelope.totalBytes,
    retainedBytes: envelope.retainedBytes,
    truncated: envelope.truncated,
    headBytes: envelope.head.length,
    tailBytes: envelope.tail.length,
    sections: envelope.sections,
    artifactSha256: envelope.artifactSha256,
  };
}

function emptyTraceMetadata(): TraceEnvelopeMetadata {
  return {
    totalBytes: 0,
    retainedBytes: 0,
    truncated: false,
    headBytes: 0,
    tailBytes: 0,
    sections: [],
    artifactSha256: null,
  };
}

function encodeTraceSections(
  sections: readonly { readonly name: string; readonly text: string }[],
): { readonly bytes: Buffer; readonly metadata: readonly TraceSectionMetadata[] } {
  const separator = Buffer.from("\n\n", "utf8");
  const encodedParts: Buffer[] = [];
  const metadata: TraceSectionMetadata[] = [];
  let nextByteOffset = 0;
  for (const [sectionIndex, section] of sections.entries()) {
    if (section.name.length === 0) {
      throw new Error(`invalid trace section name at index ${sectionIndex}: expected a non-empty name`);
    }
    if (sectionIndex > 0) {
      encodedParts.push(separator);
      nextByteOffset += separator.length;
    }
    const sectionBytes = Buffer.from(section.text, "utf8");
    const startByte = nextByteOffset;
    nextByteOffset += sectionBytes.length;
    encodedParts.push(sectionBytes);
    metadata.push({
      name: section.name,
      startByte,
      endByteExclusive: nextByteOffset,
      totalBytes: sectionBytes.length,
    });
  }
  return {
    bytes: Buffer.concat(encodedParts, nextByteOffset),
    metadata,
  };
}

async function writePrivateTextFile(filePath: string, contents: string): Promise<void> {
  await writeFile(filePath, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
}

async function writePrivateBufferFile(filePath: string, contents: Buffer): Promise<void> {
  await writeFile(filePath, contents, { mode: 0o600, flag: "wx" });
}

async function runGitApplyWithVerifiedPatch(
  repositoryPath: string,
  patch: Buffer,
  checkOnly: boolean,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  const gitArguments = ["apply", "--binary", ...(checkOnly ? ["--check"] : []), "-"];
  const result = await runProcess({
    executable: "git",
    arguments: gitArguments,
    cwd: repositoryPath,
    env: buildGitEnvironment(process.env),
    timeoutMs,
    signal,
    input: patch,
  });
  if (
    result.exitCode !== 0
    || result.timedOut
    || result.aborted
    || result.outputLimitExceeded
    || result.residualProcessGroupDetected
  ) {
    const diagnostic = result.stderr.trim() || result.stdout.trim() || "no diagnostic output";
    throw new Error(`git ${gitArguments.slice(0, -1).join(" ")} failed in ${repositoryPath}: ${diagnostic}`);
  }
}

function failureMessage(error: unknown, sensitiveValues: readonly string[]): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSensitiveValues(message, sensitiveValues);
}

function assertRequestDoesNotContainSensitiveValues(
  task: string,
  validationCommands: readonly string[],
  sensitiveValues: readonly string[],
): void {
  for (const sensitiveValue of sensitiveValues) {
    if (sensitiveValue.length === 0) {
      continue;
    }
    if (task.includes(sensitiveValue)) {
      throw new Error("task contains a sensitive environment value and was rejected");
    }
    const sensitiveCommandIndex = validationCommands.findIndex(
      (command) => command.includes(sensitiveValue),
    );
    if (sensitiveCommandIndex >= 0) {
      throw new Error(
        `validationCommands[${sensitiveCommandIndex}] contains a sensitive environment value and was rejected`,
      );
    }
  }
}

function bufferContainsSensitiveValue(
  contents: Buffer,
  sensitiveValues: readonly string[],
): boolean {
  return sensitiveValues.some((sensitiveValue) => {
    return sensitiveValue.length > 0 && contents.includes(Buffer.from(sensitiveValue, "utf8"));
  });
}

async function assertCandidateChangesDoNotContainSensitiveValues(
  worktreePath: string,
  changes: {
    readonly changedFiles: readonly string[];
    readonly diffStat: string;
    readonly patchPath: string;
    readonly verifierDiff: string;
  },
  sensitiveValues: readonly string[],
): Promise<void> {
  const rejectSensitiveChanges = async (reason: string): Promise<never> => {
    await rm(changes.patchPath, { force: true });
    throw new Error(`candidate_change_contains_sensitive_value: ${reason}`);
  };
  if (
    changes.changedFiles.some((changedFile) => sensitiveValues.some(
      (sensitiveValue) => sensitiveValue.length > 0 && changedFile.includes(sensitiveValue),
    ))
  ) {
    await rejectSensitiveChanges("changed file path");
  }
  if (
    sensitiveValues.some((sensitiveValue) => {
      return sensitiveValue.length > 0
        && (changes.diffStat.includes(sensitiveValue) || changes.verifierDiff.includes(sensitiveValue));
    })
  ) {
    await rejectSensitiveChanges("text diff or diff stat");
  }
  for (const changedFile of changes.changedFiles) {
    const changedFilePath = join(worktreePath, changedFile);
    let changedFileMetadata;
    try {
      changedFileMetadata = await lstat(changedFilePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }
    if (changedFileMetadata.isSymbolicLink()) {
      const linkTarget = await readlink(changedFilePath);
      if (sensitiveValues.some((sensitiveValue) => {
        return sensitiveValue.length > 0 && linkTarget.includes(sensitiveValue);
      })) {
        await rejectSensitiveChanges("symbolic link target");
      }
    } else if (
      changedFileMetadata.isFile()
      && bufferContainsSensitiveValue(await readFile(changedFilePath), sensitiveValues)
    ) {
      await rejectSensitiveChanges("changed file contents");
    }
  }
  if (bufferContainsSensitiveValue(await readFile(changes.patchPath), sensitiveValues)) {
    await rejectSensitiveChanges("patch contents");
  }
}

function redactVerifierResponse(
  response: VerifierResponse,
  sensitiveValues: readonly string[],
): VerifierResponse {
  return {
    ...response,
    tokenUsage: redactSensitiveJsonValue(response.tokenUsage, sensitiveValues) as JsonValue | null,
    ...(response.diagnostics === undefined
      ? {}
      : { diagnostics: redactSensitiveValues(response.diagnostics, sensitiveValues) }),
  };
}

async function executeCandidate(request: CandidateExecutionRequest): Promise<CandidateExecutionResult> {
  const startedAt = Date.now();
  const candidateLogPath = join(request.candidateArtifactsDirectory, "candidate.log");
  const logPaths: string[] = [];
  let processExitCode: number | null = null;
  let candidateResponse = "";
  let candidateExecutionTimeoutMs = request.config.candidateTimeoutMs;
  await mkdir(request.candidateArtifactsDirectory, { recursive: true });
  try {
    if (request.config.docker === undefined) {
      throw new Error("docker_runtime_config_missing: RuntimeConfig.docker is required for candidate execution");
    }
    const privateRuntimeDirectory = join(request.candidateArtifactsDirectory, "runtime");
    const privateHomePath = join(privateRuntimeDirectory, "home");
    const privateDshHomePath = join(privateRuntimeDirectory, "dsh-home");
    await mkdir(privateHomePath, { recursive: true, mode: 0o700 });
    await mkdir(privateDshHomePath, { recursive: true, mode: 0o700 });
    const validatedProxyEnvironment = validateProxyEnvironment(process.env);
    const candidateEnvironment = buildCandidateEnvironment(
      validatedProxyEnvironment,
      request.config.credentialRef,
      request.credentialValue,
    );
    await request.dockerExecutor.preflight(request.config.docker);
    const taskPrompt = [
      request.task,
      "",
      "Work only in this isolated Git worktree. Implement the task, do not commit or push, and finish with a concise summary.",
    ].join("\n");
    candidateExecutionTimeoutMs = stageTimeoutMs(
      request.config.candidateTimeoutMs,
      request.deadlineAt,
    );
    const processResult = await request.dockerExecutor.run({
      executionKind: "candidate",
      readonlyRootfs: false,
      runtimeConfig: request.config.docker,
      containerName: `dsh-llm-verifier-${request.candidateId}-${randomUUID()}`,
      repositoryPath: request.repository.repositoryPath,
      workspacePath: request.worktreePath,
      homePath: privateHomePath,
      dshHomePath: privateDshHomePath,
      command: [request.config.dshExecutable, "--profile", request.config.candidateProfile, taskPrompt],
      environment: candidateEnvironment,
      timeoutMs: candidateExecutionTimeoutMs,
      deadlineAt: request.deadlineAt,
      signal: request.signal,
    });
    processExitCode = processResult.exitCode;
    const redactedStandardOutput = redactSensitiveValues(processResult.stdout, request.sensitiveValues);
    const redactedStandardError = redactSensitiveValues(processResult.stderr, request.sensitiveValues);
    candidateResponse = redactedStandardOutput;
    const processDiagnostics = [
      redactedStandardOutput,
      redactedStandardError.length === 0 ? "" : `[stderr]\n${redactedStandardError}`,
      `[exit code: ${processResult.exitCode}]`,
      processResult.timedOut ? "[candidate timed out]" : "",
      processResult.aborted ? "[candidate cancelled]" : "",
      processResult.outputLimitExceeded ? "[output exceeded the 16 MiB safety limit]" : "",
      processResult.residualProcessGroupDetected
        ? "[candidate left a residual process group; it was force-terminated]"
        : "",
      processResult.residualProcessGroupRemaining
        ? "[candidate residual process group remains after SIGKILL]"
        : "",
    ].filter((part) => part.length > 0).join("\n");
    await writePrivateTextFile(
      candidateLogPath,
      processDiagnostics,
    );
    logPaths.push(candidateLogPath);

    const executionStatus = processResult.aborted
      ? "cancelled"
      : processResult.timedOut
        ? "timed_out"
        : processResult.exitCode === 0
          && !processResult.outputLimitExceeded
          && !processResult.residualProcessGroupDetected
          ? "completed"
          : "failed";
    if (executionStatus !== "completed") {
      let failure: string;
      if (processResult.timedOut) {
        failure = `candidate timed out after ${candidateExecutionTimeoutMs} ms`;
      } else if (processResult.aborted) {
        failure = "candidate was cancelled";
      } else if (processResult.outputLimitExceeded) {
        failure = "candidate output exceeded the 16 MiB safety limit";
      } else if (processResult.residualProcessGroupRemaining) {
        failure = "candidate left a process group that remains after SIGKILL";
      } else if (processResult.residualProcessGroupDetected) {
        failure = "candidate left a residual process group; the plugin force-terminated it";
      } else {
        failure = redactedStandardError.trim() || `candidate exited with code ${processResult.exitCode}`;
      }
      return {
        candidateId: request.candidateId,
        executionStatus,
        validationStatus: "not_run",
        durationMs: Date.now() - startedAt,
        processExitCode,
        response: redactedStandardOutput,
        changedFiles: [],
        binaryFiles: [],
        diffStat: "",
        verifierTrace: "",
        verifierTraceTruncated: false,
        verifierTraceMetadata: emptyTraceMetadata(),
        patchPath: null,
        patchSha256: null,
        patchArtifact: null,
        validationInputPatchSha256: null,
        logPaths,
        failure,
        score: null,
        rankingPosition: null,
      };
    }

    const changes = await captureCandidateChanges(
      request.worktreePath,
      request.repository.baseCommit,
      request.candidateArtifactsDirectory,
      request.credentialValue,
      gitExecutionOptionsForDeadline(request.deadlineAt, request.signal),
    );
    await assertCandidateChangesDoNotContainSensitiveValues(
      request.worktreePath,
      changes,
      request.sensitiveValues,
    );
    const validationEvidence: string[] = [];
    let validationStatus: CandidateResult["validationStatus"] = "passed";
    let validationFailure: string | null = null;
    const validationRuntimeDirectory = join(
      request.candidateArtifactsDirectory,
      "validation-runtime",
    );
    const validationWorkspacePath = join(validationRuntimeDirectory, "workspace");
    const validationHomePath = join(validationRuntimeDirectory, "home");
    const validationDshHomePath = join(validationRuntimeDirectory, "dsh-home");
    let validationWorktreeCreated = false;
    let validationInputPatchSha256: string | null = null;
    const validationEnvironment = buildValidationEnvironment({});
    try {
      await mkdir(validationRuntimeDirectory, { recursive: true, mode: 0o700 });
      await createDetachedWorktree(
        request.repository,
        validationWorkspacePath,
        gitExecutionOptionsForDeadline(request.deadlineAt, request.signal),
      );
      validationWorktreeCreated = true;
      await runGitApplyWithVerifiedPatch(
        validationWorkspacePath,
        changes.patchArtifact.bytes,
        true,
        stageTimeoutMs(request.config.validationTimeoutMs, request.deadlineAt),
        request.signal,
      );
      await runGitApplyWithVerifiedPatch(
        validationWorkspacePath,
        changes.patchArtifact.bytes,
        false,
        stageTimeoutMs(request.config.validationTimeoutMs, request.deadlineAt),
        request.signal,
      );
      const validationInputArtifact = await capturePatchArtifact(
        validationWorkspacePath,
        request.repository.baseCommit,
        gitExecutionOptionsForDeadline(request.deadlineAt, request.signal),
      );
      assertPatchArtifactIdentity(changes.patchArtifact, validationInputArtifact);
      validationInputPatchSha256 = validationInputArtifact.sha256;
      await mkdir(validationHomePath, { recursive: true, mode: 0o700 });
      await mkdir(validationDshHomePath, { recursive: true, mode: 0o700 });
      for (const [commandIndex, validationCommand] of request.validationCommands.entries()) {
        const validationResult = await request.dockerExecutor.run({
          executionKind: "validation",
          readonlyRootfs: true,
          runtimeConfig: request.config.docker,
          containerName: `dsh-llm-verifier-${request.candidateId}-validation-${commandIndex + 1}-${randomUUID()}`,
          repositoryPath: request.repository.repositoryPath,
          workspacePath: validationWorkspacePath,
          homePath: validationHomePath,
          dshHomePath: validationDshHomePath,
          command: ["/bin/sh", "-lc", validationCommand],
          environment: validationEnvironment,
          timeoutMs: stageTimeoutMs(request.config.validationTimeoutMs, request.deadlineAt),
          deadlineAt: request.deadlineAt,
          signal: request.signal,
        });
        const validationOutput = redactSensitiveValues([
          `$ ${validationCommand}`,
          validationResult.stdout,
          validationResult.stderr.length === 0 ? "" : `[stderr]\n${validationResult.stderr}`,
          `[exit code: ${validationResult.exitCode}]`,
          validationResult.outputLimitExceeded ? "[output exceeded the 16 MiB safety limit]" : "",
          validationResult.residualProcessGroupDetected
            ? "[validation left a residual process group; it was force-terminated]"
            : "",
          validationResult.residualProcessGroupRemaining
            ? "[validation residual process group remains after SIGKILL]"
            : "",
        ].filter((part) => part.length > 0).join("\n"), request.sensitiveValues);
        validationEvidence.push(validationOutput);
        const validationLogPath = join(
          request.candidateArtifactsDirectory,
          `validation-${commandIndex + 1}.log`,
        );
        await writePrivateTextFile(
          validationLogPath,
          validationOutput,
        );
        logPaths.push(validationLogPath);
        if (validationResult.timedOut || validationResult.aborted) {
          validationStatus = "timed_out";
          validationFailure = `validation command timed out or was cancelled: ${validationCommand}`;
          break;
        }
        if (
          validationResult.exitCode !== 0
          || validationResult.outputLimitExceeded
          || validationResult.residualProcessGroupDetected
        ) {
          validationStatus = "failed";
          validationFailure = validationResult.residualProcessGroupDetected
            ? `validation command left a residual process group: ${validationCommand}`
            : `validation command failed with exit code ${validationResult.exitCode}: ${validationCommand}`;
          break;
        }
      }
      if (validationStatus === "passed") {
        const postValidationArtifact = await capturePatchArtifact(
          validationWorkspacePath,
          request.repository.baseCommit,
          gitExecutionOptionsForDeadline(request.deadlineAt, request.signal),
        );
        try {
          assertPatchArtifactIdentity(changes.patchArtifact, postValidationArtifact);
        } catch (error) {
          await rm(changes.patchPath, { force: true });
          throw error;
        }
      }
    } finally {
      try {
        if (validationWorktreeCreated) {
          await removeWorktree(
            request.repository.repositoryPath,
            validationWorkspacePath,
            gitCleanupExecutionOptions(request.deadlineAt),
          );
        }
      } finally {
        await rm(validationRuntimeDirectory, { recursive: true, force: true });
      }
    }

    const binaryFileEvidence = changes.binaryFiles.length === 0
      ? "None."
      : changes.binaryFiles.map((binaryFile) => [
        `path=${JSON.stringify(binaryFile.path)}`,
        `sizeBytes=${binaryFile.sizeBytes}`,
        `gitObjectHash=${binaryFile.gitObjectHash}`,
        `state=${binaryFile.state}`,
      ].join("; ")).join("\n");
    const encodedVerifierTrace = encodeTraceSections([
      { name: "candidate", text: `Candidate: ${request.candidateId}` },
      { name: "finalResponse", text: `Final response:\n${redactedStandardOutput}` },
      { name: "changedFiles", text: `Changed files:\n${changes.changedFiles.join("\n")}` },
      {
        name: "binaryFiles",
        text: `Binary files (metadata only; no binary content):\n${binaryFileEvidence}`,
      },
      { name: "diffStat", text: `Diff stat:\n${changes.diffStat}` },
      {
        name: "textDiff",
        text: `Text diff:\n${redactSensitiveValues(changes.verifierDiff, request.sensitiveValues)}`,
      },
      {
        name: "validationEvidence",
        text: `Validation evidence:\n${validationEvidence.join("\n\n")}`,
      },
    ]);
    const completeVerifierTracePath = join(
      request.candidateArtifactsDirectory,
      "verifier-input.full.txt",
    );
    await writePrivateBufferFile(completeVerifierTracePath, encodedVerifierTrace.bytes);
    logPaths.push(completeVerifierTracePath);
    const verifierTraceEnvelope = createTraceEnvelope(
      encodedVerifierTrace.bytes,
      request.config.maxVerifierTraceBytes,
      encodedVerifierTrace.metadata,
      changes.patchArtifact.sha256,
    );
    return {
      candidateId: request.candidateId,
      executionStatus: "completed",
      validationStatus,
      durationMs: Date.now() - startedAt,
      processExitCode,
      response: redactedStandardOutput,
      changedFiles: changes.changedFiles,
      binaryFiles: changes.binaryFiles,
      diffStat: changes.diffStat,
      verifierTrace: renderTraceEnvelope(verifierTraceEnvelope),
      verifierTraceTruncated: verifierTraceEnvelope.truncated,
      verifierTraceMetadata: traceEnvelopeMetadata(verifierTraceEnvelope),
      patchPath: changes.patchPath,
      patchSha256: changes.patchSha256,
      patchArtifact: changes.patchArtifact,
      validationInputPatchSha256,
      logPaths,
      failure: validationFailure,
      score: null,
      rankingPosition: null,
    };
  } catch (error) {
    let candidateFailure = failureMessage(error, request.sensitiveValues);
    if (!logPaths.includes(candidateLogPath)) {
      try {
        await writePrivateTextFile(candidateLogPath, `[candidate failure]\n${candidateFailure}\n`);
        logPaths.push(candidateLogPath);
      } catch (logError) {
        candidateFailure = `${candidateFailure}; failed to write ${candidateLogPath}: ${failureMessage(logError, request.sensitiveValues)}`;
      }
    }
    return {
      candidateId: request.candidateId,
      executionStatus: request.signal.aborted ? "cancelled" : "failed",
      validationStatus: "not_run",
      durationMs: Date.now() - startedAt,
      processExitCode,
      response: candidateResponse,
      changedFiles: [],
      binaryFiles: [],
      diffStat: "",
      verifierTrace: "",
      verifierTraceTruncated: false,
      verifierTraceMetadata: emptyTraceMetadata(),
      patchPath: null,
      patchSha256: null,
      patchArtifact: null,
      validationInputPatchSha256: null,
      logPaths,
      failure: candidateFailure,
      score: null,
      rankingPosition: null,
    };
  }
}

function validateVerifierResponse(
  verifierResponse: VerifierResponse,
  eligibleCandidateCount: number,
): void {
  if (
    !Number.isInteger(verifierResponse.winnerIndex)
    || verifierResponse.winnerIndex < 0
    || verifierResponse.winnerIndex >= eligibleCandidateCount
  ) {
    throw new Error(
      `verifier_response_invalid: winnerIndex must reference one of ${eligibleCandidateCount} eligible candidates`,
    );
  }
  if (
    verifierResponse.scores.length !== eligibleCandidateCount
    || verifierResponse.scores.some((score) => !Number.isFinite(score))
  ) {
    throw new Error(
      `verifier_response_invalid: scores must contain ${eligibleCandidateCount} finite values`,
    );
  }
  const rankingSet = new Set(verifierResponse.ranking);
  if (
    verifierResponse.ranking.length !== eligibleCandidateCount
    || rankingSet.size !== eligibleCandidateCount
    || verifierResponse.ranking.some((candidateIndex) => !Number.isInteger(candidateIndex) || candidateIndex < 0 || candidateIndex >= eligibleCandidateCount)
  ) {
    throw new Error(
      `verifier_response_invalid: ranking must contain each of the ${eligibleCandidateCount} candidate indexes exactly once`,
    );
  }
  if (verifierResponse.ranking[0] !== verifierResponse.winnerIndex) {
    throw new Error("verifier_response_invalid: winnerIndex must equal ranking[0]");
  }
}

function publicCandidate(candidate: CandidateResult): PublicCandidateResult {
  return {
    candidateId: candidate.candidateId,
    executionStatus: candidate.executionStatus,
    validationStatus: candidate.validationStatus,
    score: candidate.score,
    changedFiles: candidate.changedFiles,
    failure: candidate.failure,
  };
}

function reportMarkdown(
  result: VerifiedBestOfResult,
  candidateResults: readonly CandidateResult[],
  cleanupWarnings: readonly string[],
  config: RuntimeConfig,
  verifierLogPath: string | null,
): string {
  const tableCell = (value: string): string => value
    .replaceAll("|", "\\|")
    .replaceAll("\r\n", "<br>")
    .replaceAll("\n", "<br>");
  const candidateRows = candidateResults.map((candidate) => [
    candidate.rankingPosition === null ? "—" : String(candidate.rankingPosition),
    candidate.candidateId,
    candidate.executionStatus,
    candidate.processExitCode === null ? "—" : String(candidate.processExitCode),
    candidate.validationStatus,
    candidate.score === null ? "—" : String(candidate.score),
    String(candidate.durationMs),
    candidate.changedFiles.join(", ") || "—",
    candidate.diffStat || "—",
    candidate.patchPath ?? "—",
    candidate.patchSha256 ?? "—",
    candidate.logPaths.join("<br>") || "—",
    candidate.failure ?? "—",
  ].map(tableCell).join(" | "));
  const winnerCandidate = candidateResults.find((candidate) => candidate.candidateId === result.winnerId);
  const reportWarnings = [
    ...cleanupWarnings,
    ...candidateResults
      .filter((candidate) => candidate.verifierTraceTruncated)
      .map((candidate) => [
        `${candidate.candidateId} verifier input was truncated`,
        `original=${candidate.verifierTraceMetadata.totalBytes} bytes`,
        `retained=${candidate.verifierTraceMetadata.retainedBytes} bytes`,
        `artifact SHA-256=${candidate.verifierTraceMetadata.artifactSha256 ?? "unavailable"}`,
        `complete input: ${candidate.logPaths.find((path) => path.endsWith("verifier-input.full.txt")) ?? "path unavailable"}`,
      ].join("; ")),
  ];
  const binaryFileRows = candidateResults.flatMap((candidate) => candidate.binaryFiles.map(
    (binaryFile) => `- ${candidate.candidateId}: path=${JSON.stringify(binaryFile.path)}, size=${binaryFile.sizeBytes} bytes, hash=${binaryFile.gitObjectHash}, state=${binaryFile.state}`,
  ));
  return [
    "# DeepSeek Harness verified Best-of report",
    "",
    `- Run: \`${result.runId}\``,
    `- Base commit: \`${result.baseCommit}\``,
    `- Plugin version: \`${PLUGIN_VERSION}\``,
    `- Requested candidates: ${result.requestedCandidateCount}`,
    `- Candidate Harness tasks launched: ${candidateResults.length}`,
    `- Completed candidates: ${result.completedCandidateCount}`,
    `- Eligible candidates: ${result.eligibleCandidateCount}`,
    `- Candidates entered into ranking: ${result.eligibleCandidateCount}`,
    `- Status: \`${result.status}\``,
    `- Selection: \`${result.selectionMethod ?? "none"}\``,
    `- Winner: \`${result.winnerId ?? "none"}\``,
    `- Verifier requests: ${result.verifierRequestCount}`,
    "- Candidate generation token usage: unavailable (the headless Harness response does not expose structured usage)",
    `- Verifier model: \`${config.verifierModel}\``,
    `- Verifier repetitions: ${config.nEvaluations}`,
    `- Token usage: \`${JSON.stringify(result.tokenUsage)}\``,
    `- Verifier log: \`${verifierLogPath ?? "not run"}\``,
    `- Winner patch: \`${result.winnerPatchPath ?? "none"}\``,
    `- Winner patch SHA-256: \`${winnerCandidate?.patchSha256 ?? "none"}\``,
    `- Report path: \`${result.reportPath}\``,
    `- Failure: ${result.failure ?? "none"}`,
    "",
    "| Rank | Candidate | Execution | Exit | Validation | Score | Duration ms | Changed files | Diff stat | Patch path | Patch SHA-256 | Complete logs | Failure |",
    "|---:|---|---|---:|---|---:|---:|---|---|---|---|---|---|",
    ...candidateRows.map((row) => `| ${row} |`),
    "",
    "## Binary file metadata",
    "",
    ...(binaryFileRows.length === 0 ? ["None."] : binaryFileRows),
    "",
    "## Warnings",
    "",
    ...(reportWarnings.length === 0 ? ["None."] : reportWarnings.map((warning) => `- ${warning}`)),
    "",
  ].join("\n");
}

export async function runVerifiedBestOf(
  input: RunVerifiedBestOfInput,
  config: RuntimeConfig,
  dependencies: RuntimeDependencies,
): Promise<VerifiedBestOfResult> {
  const task = validateTask(input.task);
  const candidateCount = normalizeCandidateCount(input.candidateCount, 3);
  if (!CREDENTIAL_REFERENCE.test(config.credentialRef)) {
    throw new Error(
      `invalid credentialRef: expected a POSIX environment name, got ${JSON.stringify(config.credentialRef)}`,
    );
  }
  const approvalSignal = input.signal ?? new AbortController().signal;
  const repository = await inspectRepository(
    input.repositoryPath,
    gitExecutionOptionsForCommandCap(config.runTimeoutMs, approvalSignal),
  );
  const validationCommands = await resolveValidationCommands(
    repository.repositoryPath,
    input.validationCommands,
  );
  const proxyValues = proxySensitiveValues(process.env);
  assertRequestDoesNotContainSensitiveValues(task, validationCommands, proxyValues);
  const stateDirectory = await canonicalStateDirectory(config.stateDirectory, repository.repositoryPath);
  await assertEnoughDiskSpace(stateDirectory, candidateCount);
  await dependencies.requestApproval(
    createApprovalReason(repository, candidateCount, validationCommands, config),
    approvalSignal,
  );
  const credentialValue = await dependencies.resolveCredential();
  if (credentialValue.length === 0) {
    throw new Error(`credential ${config.credentialRef} resolved to an empty value`);
  }
  const sensitiveValues = [credentialValue, ...proxyValues];
  assertRequestDoesNotContainSensitiveValues(task, validationCommands, sensitiveValues);

  const runAbortController = new AbortController();
  const runStartedAt = Date.now();
  const deadlineAt = runStartedAt + config.runTimeoutMs;
  const relayAbort = (): void => runAbortController.abort(input.signal?.reason);
  input.signal?.addEventListener("abort", relayAbort, { once: true });
  const runTimeout = setTimeout(
    () => runAbortController.abort(new Error(`run timed out after ${config.runTimeoutMs} ms`)),
    remainingMs(deadlineAt, runStartedAt),
  );
  runTimeout.unref();

  try {
  const runId = randomUUID();
  const runDirectory = join(stateDirectory, "runs", runId);
  const worktreesDirectory = join(runDirectory, "worktrees");
  const artifactsDirectory = join(runDirectory, "artifacts");
  await mkdir(worktreesDirectory, { recursive: true, mode: 0o700 });
  await mkdir(artifactsDirectory, { recursive: true, mode: 0o700 });

  const worktreePaths: string[] = [];
  const cleanupWarnings: string[] = [];
  let candidateResults: CandidateExecutionResult[];
  try {
    for (let candidateNumber = 1; candidateNumber <= candidateCount; candidateNumber += 1) {
      const candidateId = `candidate-${candidateNumber}`;
      const worktreePath = join(worktreesDirectory, candidateId);
      await createDetachedWorktree(
        repository,
        worktreePath,
        gitExecutionOptionsForDeadline(deadlineAt, runAbortController.signal),
      );
      worktreePaths.push(worktreePath);
    }
    candidateResults = await Promise.all(worktreePaths.map((worktreePath, candidateIndex) => {
      const candidateId = `candidate-${candidateIndex + 1}`;
      return executeCandidate({
        candidateId,
        worktreePath,
        candidateArtifactsDirectory: join(artifactsDirectory, candidateId),
        task,
        validationCommands,
        repository,
        config,
        credentialValue,
        sensitiveValues,
        dockerExecutor: dependencies.dockerExecutor,
        deadlineAt,
        signal: runAbortController.signal,
      });
    }));
  } finally {
    for (const worktreePath of [...worktreePaths].reverse()) {
      try {
        await removeWorktree(
          repository.repositoryPath,
          worktreePath,
          gitCleanupExecutionOptions(deadlineAt),
        );
      } catch (error) {
        const cleanupFailure = failureMessage(error, sensitiveValues);
        cleanupWarnings.push(
          `worktree cleanup failed; residual directory may remain at ${worktreePath}: ${cleanupFailure}`,
        );
      }
    }
    try {
      await runGit(
        repository.repositoryPath,
        ["worktree", "prune"],
        gitCleanupExecutionOptions(deadlineAt),
      );
    } catch (error) {
      cleanupWarnings.push(failureMessage(error, sensitiveValues));
    }
  }

  const eligibleCandidates = candidateResults.filter(
    (candidate) => candidate.executionStatus === "completed" && candidate.validationStatus === "passed",
  );
  let status: VerifiedBestOfResult["status"] = "no_winner";
  let selectionMethod: VerifiedBestOfResult["selectionMethod"] = null;
  let winner: CandidateExecutionResult | undefined;
  let tokenUsage: VerifiedBestOfResult["tokenUsage"] = null;
  let verifierRequestCount = 0;
  let verifierLogPath: string | null = null;
  let selectionFailure: string | null = runAbortController.signal.aborted
    ? "run was cancelled or exceeded its total timeout"
    : null;

  if (selectionFailure === null && eligibleCandidates.length === 1) {
    status = "winner_selected";
    selectionMethod = "validation_only";
    winner = eligibleCandidates[0];
    if (winner !== undefined) {
      winner.score = 1;
      winner.rankingPosition = 1;
    }
  } else if (selectionFailure === null && eligibleCandidates.length >= 2) {
    verifierLogPath = join(runDirectory, "verifier.log");
    const verifierLogContext = {
      candidateIds: eligibleCandidates.map((candidate) => candidate.candidateId),
      pivots: Math.min(2, eligibleCandidates.length - 1),
      model: config.verifierModel,
      nEvaluations: config.nEvaluations,
      maxWorkers: config.maxVerifierWorkers,
    };
    let verifierLogArtifact: Record<string, unknown>;
    try {
      const receivedVerifierResponse = await dependencies.runVerifier({
        task,
        candidates: eligibleCandidates.map((candidate) => ({
          candidateId: candidate.candidateId,
          trajectory: candidate.verifierTrace,
        })),
        pivots: Math.min(2, eligibleCandidates.length - 1),
        model: config.verifierModel,
        nEvaluations: config.nEvaluations,
        maxWorkers: config.maxVerifierWorkers,
        cachePath: join(runDirectory, "verifier-cache.json"),
        deadlineAt,
        timeoutMs: remainingMs(deadlineAt, Date.now()),
        signal: runAbortController.signal,
      });
      validateVerifierResponse(receivedVerifierResponse, eligibleCandidates.length);
      const verifierResponse = redactVerifierResponse(receivedVerifierResponse, sensitiveValues);
      for (const [candidateIndex, candidate] of eligibleCandidates.entries()) {
        candidate.score = verifierResponse.scores[candidateIndex] ?? null;
      }
      for (const [rankingIndex, candidateIndex] of verifierResponse.ranking.entries()) {
        const rankedCandidate = eligibleCandidates[candidateIndex];
        if (rankedCandidate !== undefined) {
          rankedCandidate.rankingPosition = rankingIndex + 1;
        }
      }
      winner = eligibleCandidates[verifierResponse.winnerIndex];
      status = "winner_selected";
      selectionMethod = "llm_verifier";
      tokenUsage = verifierResponse.tokenUsage;
      verifierRequestCount = verifierResponse.requestCount;
      verifierLogArtifact = {
        schemaVersion: 1,
        status: "success",
        ...verifierLogContext,
        response: verifierResponse,
      };
    } catch (error) {
      status = "failed";
      selectionFailure = failureMessage(error, sensitiveValues);
      verifierLogArtifact = {
        schemaVersion: 1,
        status: "failure",
        ...verifierLogContext,
        failure: selectionFailure,
      };
    }
    await writePrivateTextFile(
      verifierLogPath,
      redactSensitiveValues(`${JSON.stringify(verifierLogArtifact, null, 2)}\n`, sensitiveValues),
    );
  } else if (selectionFailure !== null) {
    status = "failed";
  }

  if (runAbortController.signal.aborted) {
    status = "failed";
    selectionMethod = null;
    winner = undefined;
    selectionFailure = "run was cancelled or exceeded its total timeout";
  }

  let winnerPatchPath: string | null = null;
  let winnerPatchSha256: string | null = null;
  if (winner?.patchPath !== null && winner?.patchPath !== undefined) {
    if (winner.patchArtifact === null) {
      throw new Error(`winner ${winner.candidateId} is missing its immutable patch artifact`);
    }
    const storedCandidateArtifact = createPatchArtifact(await readFile(winner.patchPath));
    assertPatchArtifactIdentity(winner.patchArtifact, storedCandidateArtifact);
    winnerPatchPath = join(runDirectory, "winner.patch");
    await writePrivateBufferFile(winnerPatchPath, winner.patchArtifact.bytes);
    winnerPatchSha256 = winner.patchArtifact.sha256;
  }

  const reportPath = join(runDirectory, "report.md");
  const result: VerifiedBestOfResult = {
    schemaVersion: 1,
    runId,
    baseCommit: repository.baseCommit,
    requestedCandidateCount: candidateCount,
    completedCandidateCount: candidateResults.filter(
      (candidate) => candidate.executionStatus === "completed",
    ).length,
    eligibleCandidateCount: eligibleCandidates.length,
    status,
    selectionMethod,
    winnerId: winner?.candidateId ?? null,
    ranking: [...candidateResults]
      .sort((left, right) => {
        const rankDifference = (left.rankingPosition ?? Number.POSITIVE_INFINITY)
          - (right.rankingPosition ?? Number.POSITIVE_INFINITY);
        return rankDifference === 0
          ? left.candidateId.localeCompare(right.candidateId)
          : rankDifference;
      })
      .map(publicCandidate),
    tokenUsage,
    verifierRequestCount,
    reportPath,
    winnerPatchPath,
    failure: selectionFailure,
  };
  const manifestPath = join(runDirectory, "manifest.json");
  await writePrivateTextFile(
    manifestPath,
    redactSensitiveValues(`${JSON.stringify({
      schemaVersion: 1,
      pluginVersion: PLUGIN_VERSION,
      createdAt: new Date().toISOString(),
      repositoryPath: repository.repositoryPath,
      baseCommit: repository.baseCommit,
      validationCommands,
      winnerPatchSha256,
      verifierLogPath,
      candidateRuns: candidateResults.map((candidate) => ({
        candidateId: candidate.candidateId,
        executionStatus: candidate.executionStatus,
        processExitCode: candidate.processExitCode,
        validationStatus: candidate.validationStatus,
        durationMs: candidate.durationMs,
        rankingPosition: candidate.rankingPosition,
        score: candidate.score,
        changedFiles: candidate.changedFiles,
        binaryFiles: candidate.binaryFiles,
        diffStat: candidate.diffStat,
        patchPath: candidate.patchPath,
        patchSha256: candidate.patchSha256,
        patchSizeBytes: candidate.patchArtifact?.size ?? null,
        validationInputPatchSha256: candidate.validationInputPatchSha256,
        logPaths: candidate.logPaths,
        verifierTraceTruncated: candidate.verifierTraceTruncated,
        verifierTraceMetadata: candidate.verifierTraceMetadata,
        failure: candidate.failure,
      })),
      warnings: [
        ...cleanupWarnings,
        ...candidateResults
          .filter((candidate) => candidate.verifierTraceTruncated)
          .map((candidate) => `${candidate.candidateId} verifier input was truncated`),
      ],
      result,
    }, null, 2)}\n`, sensitiveValues),
  );
  await writePrivateTextFile(
    reportPath,
    redactSensitiveValues(
      reportMarkdown(result, candidateResults, cleanupWarnings, config, verifierLogPath),
      sensitiveValues,
    ),
  );

  return result;
  } finally {
    clearTimeout(runTimeout);
    input.signal?.removeEventListener("abort", relayAbort);
  }
}

function requiredManifestString(
  manifestObject: Record<string, unknown>,
  fieldName: string,
): string {
  const value = manifestObject[fieldName];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`invalid run manifest ${fieldName}: ${JSON.stringify(value)}`);
  }
  return value;
}

function parseStoredRunManifest(manifestText: string): StoredRunManifest {
  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(manifestText);
  } catch (error) {
    throw new Error("run manifest contains invalid JSON", { cause: error });
  }
  if (manifestValue === null || typeof manifestValue !== "object" || Array.isArray(manifestValue)) {
    throw new Error(`invalid run manifest root: ${JSON.stringify(manifestValue)}`);
  }
  const manifest = manifestValue as Record<string, unknown>;
  if (manifest.schemaVersion !== 1) {
    throw new Error(`unsupported run manifest schemaVersion: ${JSON.stringify(manifest.schemaVersion)}`);
  }
  const resultValue = manifest.result;
  if (resultValue === null || typeof resultValue !== "object" || Array.isArray(resultValue)) {
    throw new Error(`invalid run manifest result: ${JSON.stringify(resultValue)}`);
  }
  const result = resultValue as Record<string, unknown>;
  if (result.status !== "winner_selected") {
    throw new Error(`run ${JSON.stringify(result.runId)} has no applicable winner; status is ${JSON.stringify(result.status)}`);
  }
  const validationCommands = manifest.validationCommands;
  if (
    !Array.isArray(validationCommands)
    || validationCommands.length === 0
    || validationCommands.some((command) => typeof command !== "string" || command.length === 0)
  ) {
    throw new Error(`invalid run manifest validationCommands: ${JSON.stringify(validationCommands)}`);
  }
  const winnerPatchSha256 = requiredManifestString(manifest, "winnerPatchSha256");
  if (!/^[0-9a-f]{64}$/u.test(winnerPatchSha256)) {
    throw new Error(`invalid run manifest winnerPatchSha256: ${JSON.stringify(winnerPatchSha256)}`);
  }
  const rankingValue = result.ranking;
  if (!Array.isArray(rankingValue)) {
    throw new Error(`invalid run manifest ranking: ${JSON.stringify(rankingValue)}`);
  }
  const winnerId = requiredManifestString(result, "winnerId");
  const winnerEntry = rankingValue.find((entry) => {
    return entry !== null
      && typeof entry === "object"
      && !Array.isArray(entry)
      && (entry as Record<string, unknown>).candidateId === winnerId;
  });
  if (winnerEntry === undefined) {
    throw new Error(`run manifest winner ${JSON.stringify(winnerId)} is absent from ranking`);
  }
  const changedFilesValue = (winnerEntry as Record<string, unknown>).changedFiles;
  if (!Array.isArray(changedFilesValue) || changedFilesValue.some((path) => typeof path !== "string")) {
    throw new Error(`invalid winner changedFiles: ${JSON.stringify(changedFilesValue)}`);
  }
  return {
    repositoryPath: requiredManifestString(manifest, "repositoryPath"),
    baseCommit: requiredManifestString(manifest, "baseCommit"),
    validationCommands: validationCommands as string[],
    winnerPatchSha256,
    winnerPatchPath: requiredManifestString(result, "winnerPatchPath"),
    winnerId,
    changedFiles: changedFilesValue as string[],
  };
}

export async function applyVerifiedWinner(
  input: ApplyVerifiedWinnerInput,
  config: RuntimeConfig,
  dependencies: ApplyRuntimeDependencies,
): Promise<ApplyVerifiedWinnerResult> {
  const proxyValues = proxySensitiveValues(process.env);
  const approvalSignal = input.signal ?? new AbortController().signal;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(input.runId)) {
    throw new Error(`invalid runId: expected a UUID v4, got ${JSON.stringify(input.runId)}`);
  }
  const repository = await inspectRepository(
    input.repositoryPath,
    gitExecutionOptionsForCommandCap(config.runTimeoutMs, approvalSignal),
  );
  const stateDirectory = await canonicalStateDirectory(config.stateDirectory, repository.repositoryPath);
  const requestedRunDirectory = join(stateDirectory, "runs", input.runId);
  const runDirectory = await realpath(requestedRunDirectory);
  if (!isPathInside(stateDirectory, runDirectory)) {
    throw new Error(
      `run directory escaped stateDirectory: ${requestedRunDirectory} resolved to ${runDirectory}`,
    );
  }
  const manifestPath = join(runDirectory, "manifest.json");
  const manifestMetadata = await lstat(manifestPath);
  if (!manifestMetadata.isFile()) {
    throw new Error(`run manifest must be a regular file, got ${manifestPath}`);
  }
  const manifest = parseStoredRunManifest(await readFile(manifestPath, "utf8"));
  if (await realpath(manifest.repositoryPath) !== repository.repositoryPath) {
    throw new Error(
      `run ${input.runId} belongs to ${manifest.repositoryPath}, not ${repository.repositoryPath}`,
    );
  }
  if (repository.baseCommit !== manifest.baseCommit) {
    throw new Error(
      `repository HEAD changed since run ${input.runId}: expected ${manifest.baseCommit}, got ${repository.baseCommit}`,
    );
  }
  const expectedPatchPath = join(runDirectory, "winner.patch");
  if (resolve(manifest.winnerPatchPath) !== expectedPatchPath) {
    throw new Error(
      `run manifest winnerPatchPath escaped its run directory: ${manifest.winnerPatchPath}`,
    );
  }
  const patchMetadata = await lstat(expectedPatchPath);
  if (!patchMetadata.isFile()) {
    throw new Error(`winner patch must be a regular file, got ${expectedPatchPath}`);
  }
  const canonicalPatchPath = await realpath(expectedPatchPath);
  const patch = await readFile(canonicalPatchPath);
  const actualPatchSha256 = createHash("sha256").update(patch).digest("hex");
  if (actualPatchSha256 !== manifest.winnerPatchSha256) {
    throw new Error(
      `winner patch hash changed for run ${input.runId}: expected ${manifest.winnerPatchSha256}, got ${actualPatchSha256}`,
    );
  }
  assertRequestDoesNotContainSensitiveValues("", manifest.validationCommands, proxyValues);
  if (
    manifest.changedFiles.some((changedFile) => proxyValues.some(
      (proxyValue) => changedFile.includes(proxyValue),
    ))
    || bufferContainsSensitiveValue(patch, proxyValues)
  ) {
    throw new Error("stored winner patch contains a sensitive proxy value and was rejected");
  }
  await dependencies.requestApproval(
    [
      `Apply verified winner ${manifest.winnerId} from run ${input.runId}.`,
      `Repository: ${repository.repositoryPath}.`,
      `Patch SHA-256: ${actualPatchSha256}.`,
      `Changed files: ${manifest.changedFiles.join(", ")}.`,
      `Validation commands after apply: ${manifest.validationCommands.join("; ")}.`,
      `Apply and post-apply validation share a ${config.runTimeoutMs} ms deadline starting after this approval and credential resolution.`,
      "Patch checks, apply, and each validation command receive only the remaining operation budget; stage limits do not reset it.",
      "The patch will not be staged, committed, pushed, stashed, or reset.",
    ].join("\n"),
    approvalSignal,
  );
  const credentialValue = await dependencies.resolveCredential();
  if (credentialValue.length === 0) {
    throw new Error(`credential ${config.credentialRef} resolved to an empty value`);
  }
  const sensitiveValues = [credentialValue, ...proxyValues];
  assertRequestDoesNotContainSensitiveValues("", manifest.validationCommands, sensitiveValues);
  if (
    manifest.changedFiles.some((changedFile) => sensitiveValues.some(
      (sensitiveValue) => changedFile.includes(sensitiveValue),
    ))
    || bufferContainsSensitiveValue(patch, sensitiveValues)
  ) {
    throw new Error("stored winner patch contains a sensitive environment value and was rejected");
  }

  const applyStartedAt = Date.now();
  const applyDeadlineAt = applyStartedAt + config.runTimeoutMs;
  const applyTimeoutMs = remainingMs(applyDeadlineAt, applyStartedAt);
  const applyAbortController = new AbortController();
  const relayApplyAbort = (): void => applyAbortController.abort(approvalSignal.reason);
  if (approvalSignal.aborted) {
    relayApplyAbort();
  } else {
    approvalSignal.addEventListener("abort", relayApplyAbort, { once: true });
  }
  const applyTimeout = setTimeout(
    () => applyAbortController.abort(
      new RunDeadlineExceededError(applyDeadlineAt, Date.now()),
    ),
    applyTimeoutMs,
  );
  applyTimeout.unref();

  try {
  let repositoryAfterApproval: RepositorySnapshot;
  try {
    repositoryAfterApproval = await inspectRepository(
      repository.repositoryPath,
      gitExecutionOptionsForDeadline(applyDeadlineAt, applyAbortController.signal),
    );
  } catch (error) {
    if (Date.now() >= applyDeadlineAt) {
      const deadlineFailure = applyAbortController.signal.reason;
      throw deadlineFailure instanceof RunDeadlineExceededError
        ? deadlineFailure
        : new RunDeadlineExceededError(applyDeadlineAt, Date.now());
    }
    throw error;
  }
  if (repositoryAfterApproval.baseCommit !== manifest.baseCommit) {
    throw new Error(
      `repository HEAD changed while applying run ${input.runId}: expected ${manifest.baseCommit}, got ${repositoryAfterApproval.baseCommit}`,
    );
  }
  await runGitApplyWithVerifiedPatch(
    repository.repositoryPath,
    patch,
    true,
    stageTimeoutMs(config.validationTimeoutMs, applyDeadlineAt),
    applyAbortController.signal,
  );
  await runGitApplyWithVerifiedPatch(
    repository.repositoryPath,
    patch,
    false,
    stageTimeoutMs(config.validationTimeoutMs, applyDeadlineAt),
    applyAbortController.signal,
  );

  const validationLogPaths: string[] = [];
  let validationStatus: ApplyVerifiedWinnerResult["validationStatus"] = "passed";
  let validationFailure: string | null = null;
  const validationEnvironment = buildValidationEnvironment(process.env);
  for (const [commandIndex, validationCommand] of manifest.validationCommands.entries()) {
    let validationTimeoutMs: number;
    try {
      validationTimeoutMs = stageTimeoutMs(config.validationTimeoutMs, applyDeadlineAt);
    } catch (error) {
      if (!(error instanceof RunDeadlineExceededError)) {
        throw error;
      }
      validationStatus = "timed_out";
      validationFailure = `post-apply validation deadline_exceeded before launch: ${validationCommand}`;
      break;
    }
    if (applyAbortController.signal.aborted) {
      validationStatus = "timed_out";
      validationFailure = `post-apply validation deadline_exceeded before launch: ${validationCommand}`;
      break;
    }
    const validationResult = await runProcess({
      executable: "/bin/sh",
      arguments: ["-lc", validationCommand],
      cwd: repository.repositoryPath,
      env: validationEnvironment,
      timeoutMs: validationTimeoutMs,
      signal: applyAbortController.signal,
    });
    const validationLog = redactSensitiveValues([
      `$ ${validationCommand}`,
      validationResult.stdout,
      validationResult.stderr.length === 0 ? "" : `[stderr]\n${validationResult.stderr}`,
      `[exit code: ${validationResult.exitCode}]`,
      validationResult.outputLimitExceeded ? "[output exceeded the 16 MiB safety limit]" : "",
      validationResult.residualProcessGroupDetected
        ? "[validation left a residual process group; it was force-terminated]"
        : "",
      validationResult.residualProcessGroupRemaining
        ? "[validation residual process group remains after SIGKILL]"
        : "",
    ].filter((part) => part.length > 0).join("\n"), sensitiveValues);
    const validationLogPath = join(runDirectory, `apply-validation-${commandIndex + 1}.log`);
    await writePrivateTextFile(validationLogPath, validationLog);
    validationLogPaths.push(validationLogPath);
    if (validationResult.timedOut || validationResult.aborted) {
      validationStatus = "timed_out";
      validationFailure = `post-apply validation timed out or was cancelled: ${validationCommand}`;
      break;
    }
    if (
      validationResult.exitCode !== 0
      || validationResult.outputLimitExceeded
      || validationResult.residualProcessGroupDetected
    ) {
      validationStatus = "failed";
      validationFailure = validationResult.residualProcessGroupDetected
        ? `post-apply validation left a residual process group: ${validationCommand}`
        : `post-apply validation failed with exit code ${validationResult.exitCode}: ${validationCommand}`;
      break;
    }
  }

  const applyResult: ApplyVerifiedWinnerResult = {
    schemaVersion: 1,
    runId: input.runId,
    status: validationStatus === "passed" ? "applied" : "applied_validation_failed",
    patchSha256: actualPatchSha256,
    changedFiles: manifest.changedFiles,
    validationStatus,
    validationLogPaths,
    failure: validationFailure,
  };
  await writePrivateTextFile(
    join(runDirectory, "apply-result.json"),
    redactSensitiveValues(`${JSON.stringify(applyResult, null, 2)}\n`, sensitiveValues),
  );
  return applyResult;
  } finally {
    clearTimeout(applyTimeout);
    approvalSignal.removeEventListener("abort", relayApplyAbort);
  }
}
