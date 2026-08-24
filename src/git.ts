import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { access, lstat, mkdir, readlink, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { BinaryFileSummary } from "./contracts.ts";
import { buildGitEnvironment, runProcess, validateProxyEnvironment } from "./process.ts";

export interface RepositorySnapshot {
  readonly repositoryPath: string;
  readonly baseCommit: string;
}

export interface CapturedChanges {
  readonly changedFiles: string[];
  readonly binaryFiles: BinaryFileSummary[];
  readonly diffStat: string;
  readonly verifierDiff: string;
  readonly patchArtifact: PatchArtifact;
  readonly patchPath: string;
  readonly patchSha256: string;
}

export interface PatchArtifact {
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly size: number;
}

export interface GitExecutionOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
}

function validatedGitTimeoutMs(options: GitExecutionOptions): number {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error(
      `invalid Git timeoutMs: expected a positive safe integer, got ${JSON.stringify(options.timeoutMs)}`,
    );
  }
  return options.timeoutMs;
}

function gitFailure(
  repositoryPath: string,
  arguments_: readonly string[],
  result: Awaited<ReturnType<typeof runProcess>>,
): Error {
  const commandName = arguments_[0] ?? "command";
  if (result.residualProcessGroupDetected) {
    return new Error(
      result.residualProcessGroupRemaining
        ? `git_residual_process: git ${commandName} left a process group after SIGKILL`
        : `git_residual_process: git ${commandName} left a residual process group`,
      { cause: result },
    );
  }
  if (result.timedOut) {
    return new Error(`git_timeout: git ${commandName} timed out in ${repositoryPath}`, { cause: result });
  }
  if (result.aborted) {
    return new Error(`git_aborted: git ${commandName} was aborted in ${repositoryPath}`, { cause: result });
  }
  if (result.outputLimitExceeded) {
    return new Error(`git_output_limit_exceeded: git ${commandName} exceeded its output limit`, {
      cause: result,
    });
  }
  const standardError = result.stderr.trim();
  return new Error(
    `git ${commandName} failed in ${repositoryPath}: ${standardError || `exit code ${result.exitCode}`}`,
    { cause: result },
  );
}

async function executeGit(
  repositoryPath: string,
  arguments_: readonly string[],
  options: GitExecutionOptions,
) {
  validateProxyEnvironment(process.env);
  const gitEnvironment = buildGitEnvironment(process.env);
  const signal = options.signal ?? new AbortController().signal;
  let result: Awaited<ReturnType<typeof runProcess>>;
  try {
    result = await runProcess({
      executable: "git",
      arguments: arguments_,
      cwd: repositoryPath,
      env: gitEnvironment,
      timeoutMs: validatedGitTimeoutMs(options),
      signal,
    });
  } catch (error) {
    if (signal.aborted) {
      throw new Error(`git_aborted: git ${arguments_[0] ?? "command"} was aborted before launch`, {
        cause: error,
      });
    }
    throw error;
  }
  if (
    result.exitCode !== 0
    || result.timedOut
    || result.aborted
    || result.outputLimitExceeded
    || result.residualProcessGroupDetected
  ) {
    throw gitFailure(repositoryPath, arguments_, result);
  }
  return result;
}

async function collectBinaryFileSummaries(
  worktreePath: string,
  baseCommit: string,
  changedFiles: readonly string[],
  options: GitExecutionOptions,
): Promise<BinaryFileSummary[]> {
  const binaryFiles: BinaryFileSummary[] = [];
  for (const changedFile of changedFiles) {
    const numstat = await runGit(
      worktreePath,
      ["diff", "--numstat", "--no-renames", "--no-textconv", "-z", baseCommit, "--", changedFile],
      options,
    );
    const numstatRecord = numstat.split("\0").find((record) => record.length > 0);
    if (numstatRecord === undefined) {
      continue;
    }
    const firstSeparator = numstatRecord.indexOf("\t");
    const secondSeparator = numstatRecord.indexOf("\t", firstSeparator + 1);
    if (
      firstSeparator < 0
      || secondSeparator < 0
      || numstatRecord.slice(0, firstSeparator) !== "-"
      || numstatRecord.slice(firstSeparator + 1, secondSeparator) !== "-"
    ) {
      continue;
    }

    const changedFilePath = join(worktreePath, changedFile);
    let sizeBytes: number;
    let gitObjectHash: string;
    let state: BinaryFileSummary["state"];
    try {
      const fileMetadata = await lstat(changedFilePath);
      if (!fileMetadata.isFile()) {
        throw new Error(`binary candidate path is not a regular file: ${changedFile}`);
      }
      sizeBytes = fileMetadata.size;
      gitObjectHash = (await runGit(worktreePath, ["hash-object", "--", changedFile], options)).trim();
      state = "present";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      const baseObject = `${baseCommit}:${changedFile}`;
      sizeBytes = Number.parseInt((await runGit(worktreePath, ["cat-file", "-s", baseObject], options)).trim(), 10);
      gitObjectHash = (await runGit(worktreePath, ["rev-parse", baseObject], options)).trim();
      state = "deleted";
    }
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || !/^[0-9a-f]{40,64}$/u.test(gitObjectHash)) {
      throw new Error(
        `invalid binary metadata for ${changedFile}: size=${JSON.stringify(sizeBytes)}, hash=${JSON.stringify(gitObjectHash)}`,
      );
    }
    binaryFiles.push({ path: changedFile, sizeBytes, gitObjectHash, state });
  }
  return binaryFiles;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function runGit(
  repositoryPath: string,
  arguments_: readonly string[],
  options: GitExecutionOptions,
): Promise<string> {
  return (await executeGit(repositoryPath, arguments_, options)).stdout;
}

async function runGitBuffer(
  repositoryPath: string,
  arguments_: readonly string[],
  options: GitExecutionOptions,
): Promise<Buffer> {
  const result = await executeGit(repositoryPath, arguments_, options);
  if (result.stdoutBytes === undefined) {
    throw new Error(`git_binary_output_missing: git ${arguments_[0] ?? "command"} returned no byte output`);
  }
  return Buffer.from(result.stdoutBytes);
}

export function createPatchArtifact(patchBytes: Buffer): PatchArtifact {
  const bytes = Buffer.from(patchBytes);
  return {
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
  };
}

export function assertPatchArtifactIdentity(
  expectedArtifact: PatchArtifact,
  actualArtifact: PatchArtifact,
): void {
  if (
    expectedArtifact.sha256 !== actualArtifact.sha256
    || expectedArtifact.size !== actualArtifact.size
    || !expectedArtifact.bytes.equals(actualArtifact.bytes)
  ) {
    throw new Error(
      `artifact_sha256_mismatch: expected=${expectedArtifact.sha256}; actual=${actualArtifact.sha256}`,
    );
  }
}

async function readOptionalGitConfig(
  repositoryPath: string,
  configKey: string,
  options: GitExecutionOptions,
): Promise<string | undefined> {
  try {
    return (await runGit(repositoryPath, ["config", "--get", configKey], options)).trim();
  } catch (error) {
    const cause = (error as Error).cause as { exitCode?: number | null } | undefined;
    if (cause?.exitCode === 1) {
      return undefined;
    }
    throw error;
  }
}

export async function inspectRepository(
  requestedRepositoryPath: string,
  options: GitExecutionOptions,
): Promise<RepositorySnapshot> {
  const repositoryPath = await realpath(requestedRepositoryPath);
  const topLevelPath = (await runGit(
    repositoryPath,
    ["rev-parse", "--show-toplevel"],
    options,
  )).trim();
  const canonicalTopLevelPath = await realpath(topLevelPath);
  if (canonicalTopLevelPath !== repositoryPath) {
    throw new Error(
      `repositoryPath must be the Git repository root: got ${repositoryPath}, root is ${canonicalTopLevelPath}`,
    );
  }

  const gitMetadataPath = join(repositoryPath, ".git");
  const gitMetadata = await lstat(gitMetadataPath);
  if (!gitMetadata.isDirectory()) {
    throw new Error(
      `unsupported Git layout: expected a .git directory at ${gitMetadataPath}`,
    );
  }
  if (await pathExists(join(repositoryPath, ".gitmodules"))) {
    throw new Error(`unsupported repository: submodules are present at ${repositoryPath}`);
  }
  const sparseCheckout = await readOptionalGitConfig(
    repositoryPath,
    "core.sparseCheckout",
    options,
  );
  if (sparseCheckout === "true") {
    throw new Error(`unsupported repository: sparse checkout is enabled at ${repositoryPath}`);
  }

  const statusOutput = (await runGit(
    repositoryPath,
    ["status", "--porcelain=v1", "--untracked-files=all"],
    options,
  )).trim();
  if (statusOutput.length > 0) {
    throw new Error(
      `repository must be clean; git status reported: ${statusOutput.replaceAll("\n", "; ")}`,
    );
  }

  const baseCommit = (await runGit(
    repositoryPath,
    ["rev-parse", "--verify", "HEAD"],
    options,
  )).trim();
  if (!/^[0-9a-f]{40,64}$/u.test(baseCommit)) {
    throw new Error(`invalid Git HEAD returned for ${repositoryPath}: ${JSON.stringify(baseCommit)}`);
  }
  return { repositoryPath, baseCommit };
}

export async function createDetachedWorktree(
  repository: RepositorySnapshot,
  worktreePath: string,
  options: GitExecutionOptions,
): Promise<void> {
  await runGit(
    repository.repositoryPath,
    ["worktree", "add", "--detach", worktreePath, repository.baseCommit],
    options,
  );
}

export async function removeWorktree(
  repositoryPath: string,
  worktreePath: string,
  options: GitExecutionOptions,
): Promise<void> {
  await runGit(repositoryPath, ["worktree", "remove", "--force", worktreePath], options);
}

async function markUntrackedFilesIntentToAdd(
  worktreePath: string,
  options: GitExecutionOptions,
): Promise<void> {
  const untrackedOutput = await runGit(
    worktreePath,
    ["ls-files", "--others", "--exclude-standard", "-z"],
    options,
  );
  const untrackedPaths = untrackedOutput.split("\0").filter((path) => path.length > 0);
  for (let pathIndex = 0; pathIndex < untrackedPaths.length; pathIndex += 100) {
    const pathBatch = untrackedPaths.slice(pathIndex, pathIndex + 100);
    await runGit(worktreePath, ["add", "--intent-to-add", "--", ...pathBatch], options);
  }
}

async function captureCurrentPatchArtifact(
  worktreePath: string,
  baseCommit: string,
  options: GitExecutionOptions,
): Promise<PatchArtifact> {
  const patchBytes = await runGitBuffer(
    worktreePath,
    ["diff", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", baseCommit, "--"],
    options,
  );
  return createPatchArtifact(patchBytes);
}

export async function capturePatchArtifact(
  worktreePath: string,
  baseCommit: string,
  options: GitExecutionOptions,
): Promise<PatchArtifact> {
  await markUntrackedFilesIntentToAdd(worktreePath, options);
  return captureCurrentPatchArtifact(worktreePath, baseCommit, options);
}

async function assertChangedFilesDoNotContainCredential(
  worktreePath: string,
  changedFiles: readonly string[],
  credentialValue: string,
): Promise<void> {
  const credentialBytes = Buffer.from(credentialValue, "utf8");
  for (const changedFile of changedFiles) {
    if (changedFile.includes(credentialValue)) {
      throw new Error(`candidate path contains the resolved credential and was rejected: ${changedFile}`);
    }
    const changedFilePath = join(worktreePath, changedFile);
    let fileMetadata;
    try {
      fileMetadata = await lstat(changedFilePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }
    if (fileMetadata.isSymbolicLink()) {
      if ((await readlink(changedFilePath)).includes(credentialValue)) {
        throw new Error(`candidate file ${changedFile} contains the resolved credential and was rejected`);
      }
      continue;
    }
    if (fileMetadata.isFile() && await fileContainsBytes(changedFilePath, credentialBytes)) {
      throw new Error(`candidate file ${changedFile} contains the resolved credential and was rejected`);
    }
  }
}

async function fileContainsBytes(filePath: string, searchedBytes: Buffer): Promise<boolean> {
  let retainedTail = Buffer.alloc(0);
  for await (const fileChunk of createReadStream(filePath, { highWaterMark: 64 * 1024 })) {
    const chunkBuffer = Buffer.isBuffer(fileChunk) ? fileChunk : Buffer.from(fileChunk);
    const searchableBytes = retainedTail.length === 0
      ? chunkBuffer
      : Buffer.concat([retainedTail, chunkBuffer]);
    if (searchableBytes.includes(searchedBytes)) {
      return true;
    }
    const retainedByteCount = Math.min(
      Math.max(0, searchedBytes.length - 1),
      searchableBytes.length,
    );
    retainedTail = searchableBytes.subarray(searchableBytes.length - retainedByteCount);
  }
  return false;
}

export async function captureCandidateChanges(
  worktreePath: string,
  baseCommit: string,
  candidateArtifactsDirectory: string,
  credentialValue: string,
  options: GitExecutionOptions,
): Promise<CapturedChanges> {
  await markUntrackedFilesIntentToAdd(worktreePath, options);
  const changedFilesOutput = await runGit(
    worktreePath,
    ["diff", "--name-only", "--no-textconv", "-z", baseCommit, "--"],
    options,
  );
  const changedFiles = changedFilesOutput.split("\0").filter((path) => path.length > 0);
  if (changedFiles.length === 0) {
    throw new Error(`candidate produced no changes relative to ${baseCommit}`);
  }
  await assertChangedFilesDoNotContainCredential(worktreePath, changedFiles, credentialValue);
  const binaryFiles = await collectBinaryFileSummaries(
    worktreePath,
    baseCommit,
    changedFiles,
    options,
  );

  const patchArtifact = await captureCurrentPatchArtifact(worktreePath, baseCommit, options);
  if (patchArtifact.bytes.includes(Buffer.from(credentialValue, "utf8"))) {
    throw new Error("candidate patch contains the resolved credential and was rejected");
  }
  const verifierDiff = await runGit(
    worktreePath,
    ["diff", "--full-index", "--no-ext-diff", "--no-textconv", baseCommit, "--"],
    options,
  );
  const diffStat = (
    await runGit(
      worktreePath,
      ["diff", "--stat", "--no-ext-diff", "--no-textconv", baseCommit, "--"],
      options,
    )
  ).trim();
  await mkdir(candidateArtifactsDirectory, { recursive: true });
  const patchPath = join(candidateArtifactsDirectory, "changes.patch");
  await writeFile(patchPath, patchArtifact.bytes, { mode: 0o600, flag: "wx" });
  return {
    changedFiles,
    binaryFiles,
    diffStat,
    verifierDiff,
    patchArtifact,
    patchPath,
    patchSha256: patchArtifact.sha256,
  };
}
