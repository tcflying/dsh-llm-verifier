import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { access, lstat, mkdir, readlink, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import type { BinaryFileSummary } from "./contracts.ts";

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;

export interface RepositorySnapshot {
  readonly repositoryPath: string;
  readonly baseCommit: string;
}

export interface CapturedChanges {
  readonly changedFiles: string[];
  readonly binaryFiles: BinaryFileSummary[];
  readonly diffStat: string;
  readonly verifierDiff: string;
  readonly patchPath: string;
  readonly patchSha256: string;
}

async function collectBinaryFileSummaries(
  worktreePath: string,
  baseCommit: string,
  binaryPaths: ReadonlySet<string>,
  changedFiles: readonly string[],
): Promise<BinaryFileSummary[]> {
  const binaryFiles: BinaryFileSummary[] = [];
  for (const changedFile of changedFiles) {
    if (!binaryPaths.has(changedFile)) {
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
      gitObjectHash = (await runGit(worktreePath, ["hash-object", "--", changedFile])).trim();
      state = "present";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      const baseObject = `${baseCommit}:${changedFile}`;
      sizeBytes = Number.parseInt((await runGit(worktreePath, ["cat-file", "-s", baseObject])).trim(), 10);
      gitObjectHash = (await runGit(worktreePath, ["rev-parse", baseObject])).trim();
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

/** Paths in `paths` that Git can find in HEAD, matched with literal pathspecs. */
export async function pathsKnownToHead(
  repositoryPath: string,
  paths: readonly string[],
): Promise<Set<string>> {
  const known = new Set<string>();
  for (let offset = 0; offset < paths.length; offset += 100) {
    const batch = paths.slice(offset, offset + 100);
    const output = await runGit(repositoryPath, [
      "ls-tree", "-r", "--name-only", "-z", "HEAD", "--", ...batch.map(literalPathspec),
    ]);
    for (const path of output.split("\0")) {
      if (path.length > 0) {
        known.add(path);
      }
    }
  }
  return known;
}

/** Keeps bracket/glob characters in a candidate path from being read as a pattern. */
export function literalPathspec(path: string): string {
  return `:(top,literal)${path}`;
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

async function runGitRaw(
  repositoryPath: string,
  arguments_: readonly string[],
  signal?: AbortSignal,
): Promise<Buffer> {
  try {
    const { stdout } = await execFileAsync("git", [...arguments_], {
      cwd: repositoryPath,
      encoding: "buffer",
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      ...(signal === undefined ? {} : { signal }),
    });
    return stdout;
  } catch (error) {
    const processError = error as NodeJS.ErrnoException & { stderr?: string };
    const stderr = typeof processError.stderr === "string" ? processError.stderr.trim() : "";
    const detail = stderr.length === 0 ? processError.message : stderr;
    throw new Error(
      `git ${arguments_[0] ?? "command"} failed in ${repositoryPath}: ${detail}`,
      { cause: error },
    );
  }
}

export async function runGit(
  repositoryPath: string,
  arguments_: readonly string[],
  signal?: AbortSignal,
): Promise<string> {
  return (await runGitRaw(repositoryPath, arguments_, signal)).toString("utf8");
}

/**
 * Byte-exact git output for artifacts that must round-trip, such as a
 * `--binary` patch: decoding to utf8 first would replace non-UTF-8 bytes with
 * U+FFFD and leave a patch nothing can apply.
 */
export async function runGitBytes(
  repositoryPath: string,
  arguments_: readonly string[],
  signal?: AbortSignal,
): Promise<Buffer> {
  return runGitRaw(repositoryPath, arguments_, signal);
}

async function readOptionalGitConfig(
  repositoryPath: string,
  configKey: string,
): Promise<string | undefined> {
  try {
    // `--bool` so git answers the value: `core.sparseCheckout yes`, `on` and `1`
    // are all enabled to git, and a client-side spelling list would be a second,
    // worse parser for one flag.
    return (await runGit(repositoryPath, ["config", "--bool", "--get", configKey])).trim();
  } catch (error) {
    const cause = (error as Error).cause as { code?: number } | undefined;
    if (cause?.code === 1) {
      return undefined;
    }
    throw error;
  }
}

export async function inspectRepository(
  requestedRepositoryPath: string,
  options?: { readonly requireCleanWorkingTree?: boolean },
): Promise<RepositorySnapshot> {
  const requireCleanWorkingTree = options?.requireCleanWorkingTree ?? true;
  const repositoryPath = await realpath(requestedRepositoryPath);
  const topLevelPath = (await runGit(repositoryPath, ["rev-parse", "--show-toplevel"])).trim();
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
  const sparseCheckout = await readOptionalGitConfig(repositoryPath, "core.sparseCheckout");
  if (sparseCheckout === "true") {
    throw new Error(`unsupported repository: sparse checkout is enabled at ${repositoryPath}`);
  }

  // A rollback runs against the tree an apply left behind, so the working tree
  // is expected to be dirty there; the per-file hash guard covers user edits.
  if (requireCleanWorkingTree) {
    const statusOutput = (await runGit(
      repositoryPath,
      ["status", "--porcelain=v1", "--untracked-files=all"],
    )).trim();
    if (statusOutput.length > 0) {
      throw new Error(
        `repository must be clean; git status reported: ${statusOutput.replaceAll("\n", "; ")}`,
      );
    }
  }

  const baseCommit = (await runGit(repositoryPath, ["rev-parse", "--verify", "HEAD"])).trim();
  if (!/^[0-9a-f]{40,64}$/u.test(baseCommit)) {
    throw new Error(`invalid Git HEAD returned for ${repositoryPath}: ${JSON.stringify(baseCommit)}`);
  }
  return { repositoryPath, baseCommit };
}

export async function createDetachedWorktree(
  repository: RepositorySnapshot,
  worktreePath: string,
  signal?: AbortSignal,
): Promise<void> {
  await runGit(
    repository.repositoryPath,
    ["worktree", "add", "--detach", worktreePath, repository.baseCommit],
    signal,
  );
}

export async function removeWorktree(
  repositoryPath: string,
  worktreePath: string,
): Promise<void> {
  // The second `--force` overrides one state in particular: a killed
  // `git worktree add` leaves its registration `locked initializing`, and git
  // refuses a single-`--force` removal of a locked worktree — so the run that
  // interrupted its own checkout could never clean it up. This plugin never
  // locks a worktree, and the one case where a removal must not happen at all
  // (a process still writing into the directory) is skipped by the caller.
  await runGit(repositoryPath, ["worktree", "remove", "--force", "--force", worktreePath]);
}

async function markUntrackedFilesIntentToAdd(worktreePath: string): Promise<void> {
  const untrackedOutput = await runGit(
    worktreePath,
    ["ls-files", "--others", "--exclude-standard", "-z"],
  );
  const untrackedPaths = untrackedOutput.split("\0").filter((path) => path.length > 0);
  for (let pathIndex = 0; pathIndex < untrackedPaths.length; pathIndex += 100) {
    const pathBatch = untrackedPaths.slice(pathIndex, pathIndex + 100);
    await runGit(worktreePath, ["add", "--intent-to-add", "--", ...pathBatch]);
  }
}

async function assertChangedFilesDoNotContainCredential(
  worktreePath: string,
  changedFiles: readonly string[],
  credentialValue: string,
): Promise<void> {
  if (credentialValue.length === 0) {
    // Validation-only runs resolve no credential; there is nothing to protect.
    return;
  }
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

/**
 * One `git diff --numstat -z` walk yields both lists the old two walks produced:
 * the changed paths rollback restores, and the binary set (`-<TAB>-<TAB>path`).
 *
 * A record that is not exactly `added<TAB>deleted<TAB>path` with a non-empty
 * path is a rename or copy record (rename detection makes git write
 * `added<TAB>deleted<TAB>\0old\0new`, so the path arrives empty and the two
 * names as extra records), or a path that contains a tab. Guessing at either
 * would hand rollback a silently wrong path list and restore the wrong file, so
 * the shape is refused loudly instead of parsed leniently.
 */
export function readNumstatRecords(numstatOutput: string): {
  readonly changedFiles: string[];
  readonly binaryPaths: Set<string>;
} {
  const records = numstatOutput.split("\0");
  const changedFiles: string[] = [];
  const binaryPaths = new Set<string>();
  for (const [index, record] of records.entries()) {
    if (record.length === 0) {
      continue; // the trailing separator of the last record
    }
    const fields = record.split("\t");
    const path = fields.length === 3 ? fields[2]! : "";
    if (path.length === 0) {
      // A rename record carries an empty path field and names both paths in the
      // records that follow it.
      const paths = records.slice(index + 1, index + 3).filter((candidate) => candidate.length > 0);
      throw new Error(
        `unsupported git diff --numstat record ${JSON.stringify(record)} for `
        + `${JSON.stringify(paths.length === 0 ? [record] : paths)}: rename and copy records are not `
        + "supported, the numstat query must keep --no-renames",
      );
    }
    changedFiles.push(path);
    if (fields[0] === "-" && fields[1] === "-") {
      binaryPaths.add(path);
    }
  }
  return { changedFiles, binaryPaths };
}

export async function captureCandidateChanges(
  worktreePath: string,
  baseCommit: string,
  candidateArtifactsDirectory: string,
  credentialValue: string,
): Promise<CapturedChanges> {
  await markUntrackedFilesIntentToAdd(worktreePath);
  // `--no-renames` must stay: with rename detection on, git pairs the two paths
  // into one record, so the change set loses the deleted source and rollback
  // never learns it was deleted — `rm` removes the destination instead of
  // restoring both. `readNumstatRecords` refuses that record shape on the spot.
  const numstatOutput = await runGit(
    worktreePath,
    ["diff", "--numstat", "--no-renames", "--no-textconv", "-z", baseCommit, "--"],
  );
  const { changedFiles, binaryPaths } = readNumstatRecords(numstatOutput);
  if (changedFiles.length === 0) {
    throw new Error(`candidate produced no changes relative to ${baseCommit}`);
  }
  await assertChangedFilesDoNotContainCredential(worktreePath, changedFiles, credentialValue);
  const binaryFiles = await collectBinaryFileSummaries(worktreePath, baseCommit, binaryPaths, changedFiles);

  const [patch, verifierDiff, diffStat] = await Promise.all([
    runGitBytes(
      worktreePath,
      ["diff", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", baseCommit, "--"],
    ),
    runGit(
      worktreePath,
      ["diff", "--full-index", "--no-ext-diff", "--no-textconv", baseCommit, "--"],
    ),
    runGit(
      worktreePath,
      ["diff", "--stat", "--no-ext-diff", "--no-textconv", baseCommit, "--"],
    ).then((stat) => stat.trim()),
  ]);
  if (credentialValue.length > 0 && patch.includes(credentialValue)) {
    throw new Error("candidate patch contains the resolved credential and was rejected");
  }
  await mkdir(candidateArtifactsDirectory, { recursive: true });
  const patchPath = join(candidateArtifactsDirectory, "changes.patch");
  await writeFile(patchPath, patch, { mode: 0o600, flag: "wx" });
  return {
    changedFiles,
    binaryFiles,
    diffStat,
    verifierDiff,
    patchPath,
    patchSha256: createHash("sha256").update(patch).digest("hex"),
  };
}
