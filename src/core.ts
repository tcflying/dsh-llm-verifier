import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, realpath, rename, rm, statfs, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import type { CandidateCount } from "./config.ts";
import { normalizeCandidateCount } from "./config.ts";
import type {
  CandidateResult,
  RollbackResult,
  ApplyVerifiedWinnerResult,
  ApplyRuntimeDependencies,
  PublicCandidateResult,
  ReviewReceipt,
  RuntimeDependencies,
  SelectVerifiedCandidateResult,
  VerifiedBestOfResult,
  VerifierResponse,
} from "./contracts.ts";
import {
  captureCandidateChanges,
  createDetachedWorktree,
  inspectRepository,
  literalPathspec,
  pathsKnownToHead,
  removeWorktree,
  runGit,
  type RepositorySnapshot,
} from "./git.ts";
import {
  assertBatchFileLaunchable,
  assertCommandSafeValue,
  isProcessRejection,
  redactSecret,
  runProcess,
  sanitizedEnvironment,
  type ResidualProcessTree,
} from "./process.ts";
import type { RunSettings } from "./settings.ts";
import { expandStateDirectory } from "./settings.ts";
import { resolveValidationCommands } from "./validation.ts";

function progress(message: string): void {
  process.stderr.write(`[llm-verifier] ${new Date().toISOString()} ${message}
`);
}

const MINIMUM_FREE_BYTES_PER_CANDIDATE = 512 * 1024 * 1024;
const CREDENTIAL_REFERENCE = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const MAX_TASK_CHARACTERS = 100_000;
const PLUGIN_VERSION = "0.2.0";

export interface RunVerifiedBestOfInput {
  readonly task: string;
  readonly candidateCount?: number;
  readonly validationCommands?: readonly string[];
  readonly repositoryPath: string;
  /** Settings-document revision at snapshot time, recorded in the run manifest. */
  readonly settingsRevision?: number | null;
  readonly signal?: AbortSignal;
}

export interface ApplyVerifiedWinnerInput {
  readonly runId: string;
  readonly repositoryPath: string;
  readonly candidateId?: string;
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

/**
 * Private apply bookkeeping kept beside the public `apply-result.json`: the
 * per-file hashes are rollback input, and `apply-result.json` mirrors the tool
 * output schema, which forbids extra properties.
 */
interface ApplyStateRecord {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly status: "applying" | "applied";
  readonly baseCommit: string;
  readonly patchSha256: string;
  readonly changedFiles: string[];
  readonly appliedFileSha256: Record<string, string | null>;
}

const APPLY_STATE_FILE = "apply-state.json";
const APPLY_RESULT_FILE = "apply-result.json";
const ROLLBACK_RESULT_FILE = "rollback-result.json";
const LOCK_HEARTBEAT_INTERVAL_MS = 5_000;
const LOCK_STALE_AFTER_MS = 60_000;

/** Every post-apply validation verdict has to carry the same two facts - the tree
 * is already changed, and rollback is the way out - because the host renders only
 * `failure`, and the exit-code and in-flight-cancel branches read as if nothing had
 * landed. */
const APPLIED_TREE_NOTE = "the patch is applied to the working tree; run rollback_verified_winner on this runId to restore it";

async function readOptionalJson(filePath: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${filePath} contains invalid JSON`, { cause: error });
  }
}

function discloseWarning(existing: string | null, note: string): string {
  return existing === null ? note : `${existing}; ${note}`;
}

/**
 * Write-and-rename: a truncated apply-state.json is unreadable JSON, rollback
 * refuses on an unreadable handle, and the tree this record describes stays
 * mutated with no undo door.
 */
async function writeFileAtomic(filePath: string, text: string): Promise<void> {
  const tmpPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmpPath, text, { encoding: "utf8", mode: 0o600 });
    await rename(tmpPath, filePath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * True when a still-present handle forbids the next apply. A handle that
 * outlived its rollback (the delete hit EPERM) must not weld that door shut:
 * only a `rollback-result.json` written *after* the handle proves the tree came
 * back, and the `git apply --check` inside the lock stays the real guard.
 */
async function handleBlocksReapply(applyStatePath: string, rollbackResultPath: string): Promise<boolean> {
  if (await readApplyStateRecord(applyStatePath) === null) {
    return false;
  }
  // ponytail: mtime ordering, so a clock stepping backwards between the rollback
  // and the next apply can make a live handle look stale. The blast radius is one
  // imprecise refusal/acceptance, because `git apply --check` inside the lock
  // still decides. Upgrade path: carry a `rolled_back` status in the record
  // itself, which is what the engine does (no clock dependency).
  try {
    return (await lstat(rollbackResultPath)).mtimeMs <= (await lstat(applyStatePath)).mtimeMs;
  } catch {
    return true;
  }
}

/**
 * git C-quotes a path it considers unusual — measured on git 2.55 with a Chinese filename:
 * `diff --git "a/\344\270\255\346\226\207.py" "b/\344\270\255\346\226\207.py"`, with the quotes
 * wrapping the `a/` prefix. `git diff --name-only -z` prints the raw name, so an un-unquoted header
 * never intersects it and the caller's proof silently becomes a refusal for every such repo.
 * Returns null for any escape sequence this does not model: the caller fails closed, which is
 * the pre-existing behaviour, never a silent pass.
 */
function unquoteGitPath(inner: string): string | null {
  const bytes: number[] = [];
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i] as string;
    if (ch !== "\\") {
      // A quoted run is ASCII when git C-quoted it, but `core.quotepath=false` is a LEGITIMATE config
      // that answers with raw bytes. Keeping only the low 8 bits of 中 yields a WRONG name, and a wrong
      // name shrinks the intersection that gates this rollback — worse than an unknown one, so refuse.
      const code = ch.charCodeAt(0);
      if (ch === '"' || code > 0xff) {
        return null;
      }
      bytes.push(code);
      continue;
    }
    const esc = inner[i + 1];
    i += 1;
    if (esc === "t") bytes.push(9);
    else if (esc === "n") bytes.push(10);
    else if (esc === "r") bytes.push(13);
    else if (esc === "b") bytes.push(8);
    else if (esc === "f") bytes.push(12);
    else if (esc === '"' || esc === "\\") bytes.push(esc.charCodeAt(0));
    else if (esc !== undefined && esc >= "0" && esc <= "7") {
      const digits = /^[0-7]{1,3}/.exec(inner.slice(i))?.[0];
      if (digits === undefined) {
        return null;
      }
      i += digits.length - 1;
      // \400 is not a byte: Buffer.from masks it to 0x00, which is a wrong name rather than an
      // unknown one — and a wrong name shrinks the intersection that gates this rollback.
      const value = Number.parseInt(digits, 8);
      if (value > 0xff) {
        return null;
      }
      bytes.push(value);
    } else {
      return null;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/** @see unquoteGitPath for why the quoted header form has to be understood, not just skipped. */
export function patchTouchedFiles(patchText: string): string[] | null {
  const out = new Set<string>();
  let seen = 0;
  for (const line of patchText.split(/\r?\n/)) {
    if (!line.startsWith("diff --git ")) {
      continue;
    }
    seen += 1;
    const rest = line.slice("diff --git ".length).trim();
    const m = /^(?:"(a\/[^"]*)"|(a\/\S+)) (?:"(b\/[^"]*)"|(b\/\S+))$/.exec(rest);
    if (m === null) {
      return null;
    }
    const fromRaw = m[1] ?? m[2] as string;
    const toRaw = m[3] ?? m[4] as string;
    const from = m[1] === undefined ? fromRaw : unquoteGitPath(fromRaw);
    const to = m[3] === undefined ? toRaw : unquoteGitPath(toRaw);
    if (from === null || to === null) {
      return null;
    }
    out.add(from.slice(2));
    out.add(to.slice(2));
  }
  return seen === 0 ? [] : [...out];
}

async function readApplyStateRecord(filePath: string): Promise<ApplyStateRecord | null> {
  const value = await readOptionalJson(filePath);
  if (value === null) {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid apply state record at ${filePath}`);
  }
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1
    || typeof record.runId !== "string"
    || (record.status !== "applying" && record.status !== "applied")
    || typeof record.baseCommit !== "string"
    // rollback hands baseCommit to git as a positional rev; a hand-edited record
    // must not deliver an option (`--output=…`) or a shell word. The upper bound
    // is 64 because a sha256-object-format repository answers `rev-parse` with
    // 64 hex chars: {7,40} would weld the undo door shut on exactly the repo
    // where the apply succeeded.
    || !/^[0-9a-f]{7,64}$/u.test(record.baseCommit as string)
    || typeof record.patchSha256 !== "string"
    || !Array.isArray(record.changedFiles)
    || record.changedFiles.some((path) => typeof path !== "string")
  ) {
    throw new Error(`invalid apply state record at ${filePath}`);
  }
  const hashesValue = record.appliedFileSha256;
  const hashes: Record<string, string | null> = {};
  if (hashesValue !== undefined && hashesValue !== null) {
    if (typeof hashesValue !== "object" || Array.isArray(hashesValue)) {
      throw new Error(`invalid apply state record at ${filePath}`);
    }
    for (const [path, hash] of Object.entries(hashesValue)) {
      if (hash !== null && typeof hash !== "string") {
        throw new Error(`invalid apply state record at ${filePath}`);
      }
      hashes[path] = hash;
    }
  }
  return {
    schemaVersion: 1,
    runId: record.runId,
    status: record.status,
    baseCommit: record.baseCommit,
    patchSha256: record.patchSha256,
    changedFiles: record.changedFiles as string[],
    appliedFileSha256: hashes,
  };
}

async function hashWorkingTreeFile(
  repositoryPath: string,
  changedFile: string,
): Promise<string | null> {
  try {
    return createHash("sha256").update(await readFile(join(repositoryPath, changedFile))).digest("hex");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/** What a lock holder writes about itself; absent or unparsable fields are the
 * reason the reclaim path also looks at the file's mtime. */
interface LockRecord {
  readonly pid?: number;
  readonly hostname?: string;
  readonly createdAt?: string;
  readonly heartbeatAt?: string;
}

/** Where a repository's lock record lives: the claim, the heartbeat and a
 * liveness re-check all have to name the same file. */
function repositoryLockPath(stateDirectory: string, repositoryPath: string): string {
  return join(stateDirectory, "locks", `${createHash("sha256").update(repositoryPath).digest("hex")}.lock`);
}

/**
 * The heartbeat is fire-and-forget (`void writeLockRecord().catch(() => {})`), so a
 * critical section that outlives LOCK_STALE_AFTER_MS of silent refreshes lets a
 * second operation seat on the same tree - and this one keeps working, then reports
 * `applied`. Re-read the record and refuse instead of working under the new holder.
 * ponytail: identity is pid+hostname, so a peer inside this same process that
 * reclaimed a starved heartbeat is not caught; that needs a per-acquisition token.
 * A record that cannot be parsed is not caught either, because that is what this
 * holder's own heartbeat rewrite looks like from outside (see `judgeLock`).
 */
async function assertStillHoldingLock(stateDirectory: string, repositoryPath: string): Promise<void> {
  const lockPath = repositoryLockPath(stateDirectory, repositoryPath);
  let recorded: LockRecord | null;
  try {
    recorded = await readOptionalJson(lockPath) as LockRecord | null;
  } catch {
    return;
  }
  if (recorded !== null && recorded.pid === process.pid && recorded.hostname === hostname()) {
    return;
  }
  throw new Error(
    `the repository lock on ${repositoryPath} is no longer this process's: ${lockPath} ${
      recorded === null
        ? "is gone"
        : `names pid ${String(recorded.pid ?? "?")} on host ${String(recorded.hostname ?? "?")}`
    }`,
  );
}

/**
 * `isConcurrencySafe: () => false` only serializes tools inside one host
 * process. An exclusive record keyed on the canonical repository path also
 * covers a second session (IDE plus CLI) driving the same repository.
 */
async function acquireRepositoryLock(
  stateDirectory: string,
  repositoryPath: string,
): Promise<() => Promise<void>> {
  const lockDirectory = join(stateDirectory, "locks");
  const lockPath = repositoryLockPath(stateDirectory, repositoryPath);
  await mkdir(lockDirectory, { recursive: true, mode: 0o700 });
  const hostName = hostname();
  const lockRecord = () => `${JSON.stringify({
    repositoryPath,
    pid: process.pid,
    hostname: hostName,
    createdAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
  })}\n`;
  const writeLockRecord = async (): Promise<void> => {
    await writeFile(lockPath, lockRecord(), { encoding: "utf8", mode: 0o600 });
  };
  /**
   * Whether the lock file at `path` may be reclaimed, and what its record says
   * about its holder. Failing closed on an unreadable record: `null` = the file is
   * gone (the holder released it), which is reclaimable; `undefined` = a record
   * that cannot be read or parsed, which is what the holder's own heartbeat
   * rewrite looks like from outside (`writeFile` truncates, then writes, so a
   * reader inside that window sees "" or half a record). Treating that as absence
   * let a live peer's lock be stolen every 5 s.
   */
  const judgeLock = async (path: string): Promise<{
    reclaimable: boolean;
    recorded: LockRecord | null | undefined;
  }> => {
    let recorded: LockRecord | null | undefined;
    try {
      recorded = await readOptionalJson(path) as LockRecord | null;
    } catch {
      recorded = undefined;
    }
    let lastTouchedAt = recorded === null || recorded === undefined
      ? Number.NaN
      : Date.parse(recorded.heartbeatAt ?? recorded.createdAt ?? "");
    if (recorded !== null && Number.isNaN(lastTouchedAt)) {
      // No readable timestamp: the mtime carries the same heartbeat signal without
      // needing the content, because the holder rewrites the file.
      try {
        lastTouchedAt = (await lstat(path)).mtimeMs;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new Error(
            `cannot take the lock on ${repositoryPath}: ${path} exists but can be neither read nor stat'ed: ${failureMessage(error, "")}`,
          );
        }
      }
    }
    const heartbeatStalled = Number.isNaN(lastTouchedAt) || Date.now() - lastTouchedAt > LOCK_STALE_AFTER_MS;
    const sameHostPidGone = recorded !== null && recorded !== undefined
      && recorded.hostname === hostName
      && typeof recorded.pid === "number"
      && !processAlive(recorded.pid);
    return { reclaimable: heartbeatStalled || sameHostPidGone, recorded };
  };
  /** What every acquisition that ended up holding the path has in common. */
  const seat = (): (() => Promise<void>) => {
    // Liveness is a heartbeat on the lock file, not a pid probe: a recycled pid
    // answers `kill(pid, 0)` forever on Windows, and a pid from a second host
    // sharing this state directory cannot be probed here at all.
    // ponytail: 60s of stall looks abandoned; a holder blocked in a single
    // synchronous call longer than that needs a per-operation lease instead.
    const heartbeat = setInterval(() => {
      void writeLockRecord().catch(() => {});
    }, LOCK_HEARTBEAT_INTERVAL_MS);
    heartbeat.unref();
    return async () => {
      clearInterval(heartbeat);
      // A Windows unlink of a lock file still held open by an antivirus scan
      // raises EPERM after an operation that already succeeded; failing the
      // release would replace that result with an error (and on rollback, cost
      // the user their `rollback-result.json` for a tree already reverted).
      // The stale record is reclaimed by the heartbeat check instead.
      await rm(lockPath, { force: true }).catch(() => {});
    };
  };
  // Windows reports EPERM for touching a file another process has open, and every
  // peer that just read this record had it open. A handle that outlasts the
  // retries belongs to something live, and this call does not go around it.
  const heldByAnotherProcess = (error: unknown): boolean => {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM" || code === "EACCES" || code === "EBUSY";
  };
  const backOff = async (): Promise<void> => new Promise((resolve) => {
    setTimeout(resolve, 10);
  });
  /** `wx` is the claim: "taken" says someone else holds the path. */
  const claim = async (): Promise<"claimed" | "taken" | "held"> => {
    for (let retry = 0; retry < 10; retry += 1) {
      try {
        await writeFile(lockPath, lockRecord(), { encoding: "utf8", mode: 0o600, flag: "wx" });
        return "claimed";
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          return "taken";
        }
        if (!heldByAnotherProcess(error)) {
          throw error;
        }
        if (retry < 9) {
          await backOff();
        }
      }
    }
    return "held";
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const outcome = await claim();
    if (outcome === "claimed") {
      return seat();
    }
    if (outcome === "held") {
      throw new Error(
        `cannot take the lock on ${repositoryPath}: ${lockPath} is held open by another process, so it could not be written`,
      );
    }
    const observed = await judgeLock(lockPath);
    if (!observed.reclaimable) {
      const recorded = observed.recorded;
      throw new Error(
        `another verifier operation is running on ${repositoryPath} (pid ${String(recorded?.pid ?? "?")} on host ${String(recorded?.hostname ?? "?")} since ${String(recorded?.createdAt ?? "?")}), lock: ${lockPath}; it is still heartbeating${recorded === undefined ? ` (its record at ${lockPath} could not be read, so only its file mtime was checked)` : ""}`,
      );
    }
    // That verdict describes a file this call has already lost the right to
    // describe: acting on it with a plain `rm` let two peers that both judged one
    // crashed lock stale each delete the other's freshly written lock, and both
    // sat down. `rename` captures exactly whichever record owned the path at that
    // instant, and the verdict is re-run on the captured record *after* this call
    // holds the path itself - so a peer that seated itself in the meantime gets
    // its record back before this call touches the repository.
    // ponytail: the capture-to-claim hop below still leaves the path free for one
    // await, and a third caller that finds it free has nothing to tell "the
    // crashed lock was cleared" apart from "someone is inside right now", so it
    // seats beside a peer mid-handback. Two callers cannot reach that; a third can.
    // Closing it needs an epoch token per holder, re-checked before each mutation
    // (or a lock service), not a better rename.
    const sidePath = `${lockPath}.${process.pid}.${randomUUID()}.stale`;
    let captured = false;
    let absent = false;
    for (let retry = 0; retry < 10 && !captured && !absent; retry += 1) {
      try {
        await rename(lockPath, sidePath);
        captured = true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          // Released or taken over between the verdict and here: the claim below
          // answers honestly for whoever holds the path now.
          absent = true;
        } else if (!heldByAnotherProcess(error)) {
          throw error;
        } else if (retry < 9) {
          await backOff();
        }
      }
    }
    if (absent) {
      continue;
    }
    if (!captured) {
      throw new Error(
        `cannot take the lock on ${repositoryPath}: ${lockPath} looks abandoned but is still held open by another process, so it was not removed`,
      );
    }
    // Claimed immediately behind the capture: every await between the two is a
    // moment the path reads as free, and a free path is what lets a peer that is
    // running right now be stepped on.
    const claimedOver = await claim();
    if (claimedOver !== "claimed") {
      // Beaten to it. The captured record stays at `sidePath` rather than being
      // renamed over the live claim that won: an orphan `*.stale` file names no
      // lock, and its holder's own heartbeat puts its record back.
      continue;
    }
    if ((await judgeLock(sidePath)).reclaimable) {
      // The captured record really was the crashed one, so this claim stands.
      await rm(sidePath, { force: true }).catch(() => {});
      return seat();
    }
    // Something seated itself between the verdict and the capture, so this was
    // never ours to take. Handing it back replaces a path this call already holds
    // its own claim on, which is what keeps it from ever reading as free here.
    let handedBack = false;
    for (let retry = 0; retry < 10 && !handedBack; retry += 1) {
      try {
        await rename(sidePath, lockPath);
        handedBack = true;
      } catch (error) {
        if (!heldByAnotherProcess(error)) {
          break;
        }
        if (retry < 9) {
          await backOff();
        }
      }
    }
    if (!handedBack) {
      // The live record cannot go back, so this call gives up the claim it made
      // rather than sitting on a lock that belongs to a running peer.
      await rm(lockPath, { force: true }).catch(() => {});
      throw new Error(
        `cannot take the lock on ${repositoryPath}: ${lockPath} was claimed over a live record that could not be put back (${sidePath}), so nothing was changed`,
      );
    }
    // Next pass: the claim meets that live record and refuses it by name.
  }
  // Two attempts, both blocked by something that then took the lock back: a
  // plain race, not an internal error.
  throw new Error(
    `another verifier operation took the lock on ${repositoryPath} while this one was acquiring it (${lockPath}); nothing was changed, try again`,
  );
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

interface CandidateExecutionRequest {
  readonly candidateId: string;
  readonly worktreePath: string;
  readonly candidateArtifactsDirectory: string;
  readonly task: string;
  readonly validationCommands: readonly string[];
  /** Worktrees the caller must not delete, keyed by path, with the reason. */
  readonly residualWorktrees: Map<string, string>;
  /** Run-level inbox of deferred process-tree observations, one per spawn. */
  readonly residualProcessTrees: ResidualProcessTreeNote[];
  readonly repository: RepositorySnapshot;
  readonly config: RunSettings;
  readonly credentialValue: string;
  readonly signal: AbortSignal;
}

interface ResidualProcessTreeNote {
  readonly candidateId: string;
  readonly worktreePath: string;
  readonly step: string;
  readonly tree: Promise<ResidualProcessTree>;
}

/**
 * Records where the observation came from without waiting for it. The answer is
 * read once, by `awaitResidualProcessTrees`, before the run deletes anything.
 */
function trackResidualProcessTree(
  request: CandidateExecutionRequest,
  step: string,
  tree: Promise<ResidualProcessTree>,
): void {
  request.residualProcessTrees.push({
    candidateId: request.candidateId,
    worktreePath: request.worktreePath,
    step,
    tree,
  });
}

function describeResidualProcessTree(tree: ResidualProcessTree): string {
  if (tree.unknown) {
    return "could not be enumerated";
  }
  if (tree.remaining) {
    return "left a process that survived SIGKILL";
  }
  if (tree.detected) {
    return "left a residual process group; it was force-terminated";
  }
  return "left no residual process";
}

/**
 * A process from the worktree's own command tree that survived SIGKILL makes
 * that directory somebody's live working directory, so the run cleanup has to
 * leave it alone. An unenumerable tree is reported in the logs instead of
 * gating the delete: a slow or missing PowerShell must not pile up worktrees on
 * every run. Every walk runs concurrently with its siblings' work, so the total
 * cost here is one enumeration, not one per spawn.
 */
async function awaitResidualProcessTrees(
  notes: readonly ResidualProcessTreeNote[],
  residualWorktrees: Map<string, string>,
): Promise<string> {
  const lines: string[] = [];
  for (const note of notes) {
    const tree = await note.tree;
    lines.push(`${note.candidateId} ${note.step} in ${note.worktreePath}: ${describeResidualProcessTree(tree)}`);
    if (tree.remaining) {
      residualWorktrees.set(note.worktreePath, `${note.step} left a process that survived SIGKILL`);
    }
  }
  return `${lines.join("\n")}${lines.length === 0 ? "" : "\n"}`;
}

function validateTask(task: string): string {
  const normalizedTask = task.trim();
  if (normalizedTask.length === 0 || normalizedTask.length > MAX_TASK_CHARACTERS) {
    throw new Error(
      `invalid task: expected 1-${MAX_TASK_CHARACTERS} characters, got ${task.length}`,
    );
  }
  // The task is a command-line argument of the harness, which on Windows is
  // launched by cmd.exe: length alone is not a bound on what it can do there.
  assertCommandSafeValue(normalizedTask, "task");
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
  const expandedStateDirectory = expandStateDirectory(
    configuredStateDirectory,
    process.env.DSH_HOME ?? join(homedir(), ".dsh"),
  );
  if (!isAbsolute(expandedStateDirectory)) {
    throw new Error(
      `invalid stateDirectory: expected an absolute path, got ${JSON.stringify(configuredStateDirectory)}`,
    );
  }
  const resolvedStateDirectory = resolve(expandedStateDirectory);
  let stateDirectory: string;
  try {
    stateDirectory = await realpath(resolvedStateDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    const stateDirectoryParent = await realpath(dirname(resolvedStateDirectory));
    stateDirectory = join(stateDirectoryParent, basename(resolvedStateDirectory));
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

function createApprovalReason(
  repository: RepositorySnapshot,
  candidateCount: CandidateCount,
  validationCommands: readonly string[],
  config: RunSettings,
): string {
  const estimatedVerifierRequests = (candidateCount === 3 ? 18 : 36) * config.nEvaluations;
  return [
    `Run ${candidateCount} isolated DeepSeek Harness candidates in ${repository.repositoryPath}.`,
    `Base commit: ${repository.baseCommit}.`,
    `Validation commands: ${validationCommands.join("; ")}.`,
    "The task, text diffs, and validation evidence may be sent to DeepSeek.",
    `Maximum run time: ${config.runTimeoutMs} ms.`,
    `Candidate generation budget: ${candidateCount} headless Harness tasks using profile ${config.candidateProfile}.`,
    `Verifier budget: approximately ${estimatedVerifierRequests} requests to ${config.verifierModel} if every candidate passes (${config.nEvaluations} evaluations per comparison).`,
    "These are estimates; the report records the actual completed tasks and verifier requests.",
  ].join("\n");
}

function truncateVerifierTrace(
  trace: string,
  maximumBytes: number,
): { readonly text: string; readonly truncated: boolean } {
  const traceBuffer = Buffer.from(trace, "utf8");
  if (traceBuffer.length <= maximumBytes) {
    return { text: trace, truncated: false };
  }
  // Cut on a character boundary: slicing mid-sequence injects U+FFFD and the
  // CJK text then decodes to more bytes than the budget claims it retained.
  let retainedBytes = maximumBytes;
  while (retainedBytes > 0 && (traceBuffer[retainedBytes] ?? 0) >= 0x80 && (traceBuffer[retainedBytes] ?? 0) < 0xc0) {
    retainedBytes -= 1;
  }
  const retainedTrace = traceBuffer.subarray(0, retainedBytes).toString("utf8");
  return {
    text: `${retainedTrace}\n[truncated: original ${traceBuffer.length} bytes, retained ${retainedBytes} bytes; complete input retained locally]`,
    truncated: true,
  };
}

async function writePrivateTextFile(filePath: string, contents: string): Promise<void> {
  await writeFile(filePath, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
}

/**
 * Rewrite of an artifact this run already wrote. Unlinking first keeps `wx`
 * meaning "never follow or clobber what someone else planted at this path",
 * instead of the rewrite failing with EEXIST from inside a `catch`.
 */
async function replacePrivateTextFile(filePath: string, contents: string): Promise<void> {
  await rm(filePath, { force: true });
  await writePrivateTextFile(filePath, contents);
}

/**
 * Records why a review failed in the run's `verifier.log`. A log that cannot be
 * rewritten is disclosed in the run's warnings: the review cause the caller
 * already stored in `selectionFailure` must not be replaced by a filesystem
 * error, or the run loses its manifest and report over a bookkeeping failure.
 */
async function recordVerifierFailureLog(
  verifierLogPath: string,
  record: Record<string, unknown>,
  credentialValue: string,
  cleanupWarnings: string[],
): Promise<void> {
  try {
    await replacePrivateTextFile(
      verifierLogPath,
      redactSecret(`${JSON.stringify(record, null, 2)}\n`, credentialValue),
    );
  } catch (error) {
    cleanupWarnings.push(
      `verifier.log at ${verifierLogPath} does not record the review failure: ${failureMessage(error, credentialValue)}`,
    );
  }
}

async function runGitApplyWithVerifiedPatch(
  repositoryPath: string,
  patch: Buffer,
  checkOnly: boolean,
  timeoutMs: number,
  signal: AbortSignal,
  reverse = false,
): Promise<void> {
  const gitArguments = ["apply", "--binary", ...(reverse ? ["-R"] : []), ...(checkOnly ? ["--check"] : []), "-"];
  const result = await runProcess({
    executable: "git",
    arguments: gitArguments,
    cwd: repositoryPath,
    env: sanitizedEnvironment(process.env),
    timeoutMs,
    signal,
    input: patch,
  });
  if (
    result.exitCode !== 0
    || result.timedOut
    || result.aborted
    || result.outputLimitExceeded
  ) {
    const diagnostic = result.stderr.trim() || result.stdout.trim() || "no diagnostic output";
    throw new Error(`git ${gitArguments.slice(0, -1).join(" ")} failed in ${repositoryPath}: ${diagnostic}`);
  }
}

/**
 * Whether the recorded patch is verbatim present in the tree. `git apply` is
 * all-or-nothing, so a clean reverse check proves every hunk is the patch's own
 * output, and a reverse apply then removes only those hunks and keeps any edit
 * the user made outside them.
 */
async function patchReversesCleanly(
  repositoryPath: string,
  patch: Buffer,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    await runGitApplyWithVerifiedPatch(repositoryPath, patch, true, timeoutMs, signal, true);
    return true;
  } catch {
    return false;
  }
}

/**
 * Worktree content of `path` identical to HEAD's, absent-and-absent included.
 *
 * `git diff HEAD -- <path>` is silent about a path HEAD does not know: an
 * untracked file never appears in the diff, so the command exits 0 for a
 * patch-added file that holds nothing but the user's own content. Treating that
 * as "matches HEAD" lets the interrupted-apply fallback `rm` a file no rollback
 * was ever asked to touch, so a present path unknown to HEAD never matches.
 *
 * `knownToHead` is the caller's HEAD membership for the whole change set, from
 * one batched `git ls-tree` (see `headKnownToChangeSet`).
 */
async function pathMatchesHead(
  repositoryPath: string,
  path: string,
  knownToHead: ReadonlySet<string>,
): Promise<boolean> {
  if (await hashWorkingTreeFile(repositoryPath, path) !== null && !knownToHead.has(path)) {
    return false;
  }
  try {
    await runGit(repositoryPath, ["diff", "--quiet", "HEAD", "--", literalPathspec(path)]);
    return true;
  } catch (error) {
    const cause = (error as Error).cause as { code?: number } | undefined;
    if (cause?.code === 1) {
      return false;
    }
    throw error;
  }
}

/**
 * One batched `git ls-tree` over HEAD, computed at most once per call and reused
 * by every decision that needs HEAD membership for the same change set. Asking
 * per file cost one process spawn per changed file, inside the repository lock.
 * Safe to share: HEAD is pinned for the duration (while holding the lock the
 * caller either matched it to the record's baseCommit, or proved that no commit
 * since that base touches a recorded path), so the answer cannot go stale
 * between the two uses.
 */
function headKnownToChangeSet(
  repositoryPath: string,
  changedFiles: readonly string[],
): () => Promise<Set<string>> {
  let pending: Promise<Set<string>> | undefined;
  return () => {
    pending ??= pathsKnownToHead(repositoryPath, changedFiles);
    return pending;
  };
}

function failureMessage(error: unknown, credentialValue: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSecret(message, credentialValue);
}

/**
 * Headless stderr contract (DeepSeek Harness 0.1.2): reasoning deltas are
 * streamed as `dsh: reasoning: ...` and failures are reported as
 * `dsh: <code>: <message>`. Reasoning on a failed run is diagnostic noise, not
 * the failure itself, so prefer the structured failure lines when present.
 */
function extractHeadlessFailureDiagnostic(standardError: string): string | null {
  const failureLines = standardError
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^dsh:/.test(line) && !line.startsWith("dsh: reasoning:"));
  return failureLines.length === 0 ? null : failureLines.join("\n");
}

/**
 * Validation commands run through the platform shell: POSIX gets /bin/sh, and
 * Windows gets cmd.exe with the documented /d /s /c argument shape.
 */
function validationShellInvocation(validationCommand: string): {
  readonly executable: string;
  readonly arguments: readonly string[];
} {
  if (process.platform === "win32") {
    // `||`, not `??`: an empty ComSpec is as unusable as a missing one, and
    // spawning "" would fail with a message that names no shell at all.
    return { executable: process.env.ComSpec || "cmd.exe", arguments: ["/d", "/s", "/c", validationCommand] };
  }
  return { executable: "/bin/sh", arguments: ["-lc", validationCommand] };
}

function assertRequestDoesNotContainCredential(
  task: string,
  validationCommands: readonly string[],
  credentialValue: string,
): void {
  if (task.includes(credentialValue)) {
    throw new Error("task contains the resolved credential and was rejected");
  }
  const credentialCommandIndex = validationCommands.findIndex((command) => command.includes(credentialValue));
  if (credentialCommandIndex >= 0) {
    throw new Error(
      `validationCommands[${credentialCommandIndex}] contains the resolved credential and was rejected`,
    );
  }
}

async function executeCandidate(request: CandidateExecutionRequest): Promise<CandidateResult> {
  const startedAt = Date.now();
  const candidateLogPath = join(request.candidateArtifactsDirectory, "candidate.log");
  const logPaths: string[] = [];
  let processExitCode: number | null = null;
  let candidateResponse = "";
  // Which spawn an observation came from, kept in step with the calls below: a
  // `runProcess` that rejects hands its observation over through the error, and
  // the catch at the bottom has to log it against the right command.
  let spawnedStep = "the candidate command";
  try {
    await mkdir(request.candidateArtifactsDirectory, { recursive: true });
    const dshHomeDirectory = request.config.dshHomeDirectory
      ?? process.env.DSH_HOME
      ?? join(homedir(), ".dsh");
    const candidateEnvironment = sanitizedEnvironment(process.env, {
      DSH_HOME: dshHomeDirectory,
      DSH_PERMISSION_MODE: "workspace-write",
      ...(request.credentialValue.length > 0
        ? { [request.config.credentialRef]: request.credentialValue }
        : {}),
    });
    const taskPrompt = [
      request.task,
      "",
      "ISOLATION CONTRACT (mandatory, overrides any conflicting instruction above):",
      "- Your current working directory IS the isolated Git worktree for this task.",
      "- Touch only files under your current working directory. Never cd elsewhere and never write outside it.",
      "- Absolute paths in the task above that point outside the current working directory refer to the matching file inside this worktree; use the relative path instead.",
      "- Do not commit or push. Finish with a concise summary.",
    ].join("\n");
    const processResult = await runProcess({
      executable: request.config.dshExecutable,
      arguments: ["--profile", request.config.candidateProfile, taskPrompt],
      cwd: request.worktreePath,
      env: candidateEnvironment,
      timeoutMs: request.config.candidateTimeoutMs,
      signal: request.signal,
      detectResidualTree: true,
    });
    processExitCode = processResult.exitCode;
    trackResidualProcessTree(request, spawnedStep, processResult.residualProcessGroup);
    const redactedStandardOutput = redactSecret(processResult.stdout, request.credentialValue);
    const redactedStandardError = redactSecret(processResult.stderr, request.credentialValue);
    candidateResponse = redactedStandardOutput;
    const processDiagnostics = [
      redactedStandardOutput,
      redactedStandardError.length === 0 ? "" : `[stderr]\n${redactedStandardError}`,
      `[exit code: ${processResult.exitCode}]`,
      processResult.timedOut ? "[candidate timed out]" : "",
      processResult.aborted ? "[candidate cancelled]" : "",
      processResult.outputLimitExceeded ? "[output exceeded the 16 MiB safety limit]" : "",
      // The residual-process observation is deferred on purpose; it lands once per
      // run in process-tree.log (see awaitResidualProcessTrees), attributed by
      // candidate and step, and is awaited before any worktree is deleted.
    ].filter((part) => part.length > 0).join("\n");
    await writePrivateTextFile(
      candidateLogPath,
      processDiagnostics,
    );
    logPaths.push(candidateLogPath);

    // A leftover process group that the plugin already force-killed is a
    // warning, recorded in the diagnostics above, not a failed candidate: a
    // watcher or dev server leaving a daemon behind must not discard the work
    // the candidate actually finished. Only SIGKILL-survivors stay fatal.
    const executionStatus = processResult.aborted
      ? "cancelled"
      : processResult.timedOut
        ? "timed_out"
        : processResult.exitCode === 0
          && !processResult.outputLimitExceeded
          ? "completed"
          : "failed";
    if (executionStatus !== "completed") {
      let failure: string;
      if (processResult.timedOut) {
        failure = `candidate timed out after ${request.config.candidateTimeoutMs} ms`;
      } else if (processResult.aborted) {
        failure = "candidate was cancelled";
      } else if (processResult.outputLimitExceeded) {
        failure = "candidate output exceeded the 16 MiB safety limit";
      } else {
        const headlessFailure = extractHeadlessFailureDiagnostic(redactedStandardError);
        const nativeFailure = headlessFailure
          ?? (redactedStandardError.trim().length === 0
            ? `candidate exited with code ${processResult.exitCode}`
            : redactedStandardError.trim());
        failure = processResult.usedCommandResolution
          // The direct spawn ENOENTed and cmd.exe answered instead: the harness
          // binary is missing, and cmd's own "is not recognized" must not be
          // filed as a model outcome the verifier is then blamed for.
          ? `the configured dshExecutable ${JSON.stringify(request.config.dshExecutable)} could not be launched; ${nativeFailure}`
          : nativeFailure;
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
        patchPath: null,
        patchSha256: null,
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
    );
    const validationEvidence: string[] = [];
    let validationStatus: CandidateResult["validationStatus"] = "passed";
    let validationFailure: string | null = null;
    const validationEnvironment = sanitizedEnvironment(process.env);
    for (const [commandIndex, validationCommand] of request.validationCommands.entries()) {
      const validationShell = validationShellInvocation(validationCommand);
      spawnedStep = `validation command ${commandIndex + 1}`;
      const validationResult = await runProcess({
        executable: validationShell.executable,
        arguments: validationShell.arguments,
        cwd: request.worktreePath,
        env: validationEnvironment,
        timeoutMs: request.config.validationTimeoutMs,
        signal: request.signal,
        detectResidualTree: true,
      });
      trackResidualProcessTree(request, `validation command ${commandIndex + 1}`, validationResult.residualProcessGroup);
      const validationOutput = redactSecret([
        `$ ${validationCommand}`,
        validationResult.stdout,
        validationResult.stderr.length === 0 ? "" : `[stderr]\n${validationResult.stderr}`,
        `[exit code: ${validationResult.exitCode}]`,
        validationResult.outputLimitExceeded ? "[output exceeded the 16 MiB safety limit]" : "",
      ].filter((part) => part.length > 0).join("\n"), request.credentialValue);
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
      if (validationResult.exitCode !== 0 || validationResult.outputLimitExceeded) {
        validationStatus = "failed";
        validationFailure = `validation command failed with exit code ${validationResult.exitCode}: ${validationCommand}`;
        break;
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
    const completeVerifierTrace = [
      `Candidate: ${request.candidateId}`,
      `Final response:\n${redactedStandardOutput}`,
      `Changed files:\n${changes.changedFiles.join("\n")}`,
      `Binary files (metadata only; no binary content):\n${binaryFileEvidence}`,
      `Diff stat:\n${changes.diffStat}`,
      `Text diff:\n${redactSecret(changes.verifierDiff, request.credentialValue)}`,
      `Validation evidence:\n${validationEvidence.join("\n\n")}`,
    ].join("\n\n");
    const completeVerifierTracePath = join(
      request.candidateArtifactsDirectory,
      "verifier-input.full.txt",
    );
    await writePrivateTextFile(completeVerifierTracePath, completeVerifierTrace);
    logPaths.push(completeVerifierTracePath);
    const verifierTrace = truncateVerifierTrace(
      completeVerifierTrace,
      request.config.maxVerifierTraceBytes,
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
      verifierTrace: verifierTrace.text,
      verifierTraceTruncated: verifierTrace.truncated,
      patchPath: changes.patchPath,
      patchSha256: changes.patchSha256,
      logPaths,
      failure: validationFailure,
      score: null,
      rankingPosition: null,
    };
  } catch (error) {
    // A rejected `runProcess` (the stdin-write path) carries the same deferred
    // observation the resolved result does; without this registration the run
    // would delete that worktree under a process that survived SIGKILL.
    if (isProcessRejection(error)) {
      trackResidualProcessTree(request, spawnedStep, error.residualProcessGroup);
    }
    let candidateFailure = failureMessage(error, request.credentialValue);
    if (!logPaths.includes(candidateLogPath)) {
      try {
        await writePrivateTextFile(candidateLogPath, `[candidate failure]\n${candidateFailure}\n`);
        logPaths.push(candidateLogPath);
      } catch (logError) {
        candidateFailure = `${candidateFailure}; failed to write ${candidateLogPath}: ${failureMessage(logError, request.credentialValue)}`;
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
      patchPath: null,
      patchSha256: null,
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
      `invalid verifier winnerIndex: expected 0-${eligibleCandidateCount - 1}, got ${JSON.stringify(verifierResponse.winnerIndex)}`,
    );
  }
  if (
    verifierResponse.scores.length !== eligibleCandidateCount
    || verifierResponse.scores.some((score) => !Number.isFinite(score))
  ) {
    throw new Error(
      `invalid verifier scores: expected ${eligibleCandidateCount} finite scores, got ${JSON.stringify(verifierResponse.scores)}`,
    );
  }
  const rankingSet = new Set(verifierResponse.ranking);
  if (
    verifierResponse.ranking.length !== eligibleCandidateCount
    || rankingSet.size !== eligibleCandidateCount
    || verifierResponse.ranking.some((candidateIndex) => !Number.isInteger(candidateIndex) || candidateIndex < 0 || candidateIndex >= eligibleCandidateCount)
  ) {
    throw new Error(`invalid verifier ranking: ${JSON.stringify(verifierResponse.ranking)}`);
  }
  if (verifierResponse.ranking[0] !== verifierResponse.winnerIndex) {
    throw new Error(
      `invalid verifier winner: winnerIndex ${verifierResponse.winnerIndex} does not match ranking[0] ${JSON.stringify(verifierResponse.ranking[0])}`,
    );
  }
}

function publicCandidate(candidate: CandidateResult): PublicCandidateResult {
  return {
    candidateId: candidate.candidateId,
    executionStatus: candidate.executionStatus,
    validationStatus: candidate.validationStatus,
    score: candidate.score,
    changedFiles: candidate.changedFiles,
    diffStat: candidate.diffStat,
    durationMs: candidate.durationMs,
    failure: candidate.failure,
  };
}

function reportMarkdown(
  result: VerifiedBestOfResult,
  candidateResults: readonly CandidateResult[],
  cleanupWarnings: readonly string[],
  config: RunSettings,
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
      .map((candidate) => `${candidate.candidateId} verifier input was truncated; complete input: ${candidate.logPaths.find((path) => path.endsWith("verifier-input.full.txt")) ?? "path unavailable"}`),
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
    `- DeepSeek verifier requests: ${result.verifierRequestCount}`,
    "- Candidate generation token usage: unavailable (the headless Harness response does not expose structured usage)",
    ...(result.review !== null
      ? [
        `- Reviewer provider: \`${result.review.provider}\``,
        `- Reviewer model: \`${result.review.model}\``,
        `- Configured reviewer reasoning effort: \`${config.reviewerReasoningEffort || "default"}\``,
        `- Reviewer duration ms: ${result.review.durationMs}`,
      ]
      : result.verifierRequestCount > 0
        ? [
          `- Verifier model: \`${config.verifierModel}\``,
          `- Verifier repetitions: ${config.nEvaluations}`,
        ]
        : ["- Model review: no completed model review"]),
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

/**
 * Run every worktree through `worker` with at most `limit` concurrent
 * executions, preserving one result per worktree in input order. Queued
 * candidates are skipped (marked cancelled) once `signal` aborts.
 */
async function runCandidatePool(
  worktreePaths: string[],
  limit: number,
  abortRun: () => void,
  worker: (worktreePath: string, candidateIndex: number) => Promise<CandidateResult>,
): Promise<CandidateResult[]> {
  // A hand-edited settings document can reach here as NaN or "3": clamp through
  // an integer check, or Array.from({ length: NaN }) yields zero workers and
  // the run silently produces no candidates at all.
  const workerCount = Number.isInteger(limit) && limit > 0 ? limit : 1;
  const concurrency = Math.max(1, Math.min(workerCount, worktreePaths.length));
  const results: CandidateResult[] = new Array(worktreePaths.length);
  let nextIndex = 0;
  const runners = Array.from({ length: concurrency }, async () => {
    while (nextIndex < worktreePaths.length) {
      const candidateIndex = nextIndex;
      nextIndex += 1;
      const worktreePath = worktreePaths[candidateIndex];
      if (worktreePath === undefined) continue;
      results[candidateIndex] = await worker(worktreePath, candidateIndex);
    }
  });
  // allSettled, not all: a rejected worker must not return while sibling
  // candidates still run, because the finally block deletes their worktrees
  // underneath them.
  const outcomes = await Promise.allSettled(runners);
  const failed = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
  if (failed !== undefined) {
    abortRun();
    throw failed.reason;
  }
  return results;
}

export async function runVerifiedBestOf(
  input: RunVerifiedBestOfInput,
  config: RunSettings,
  dependencies: RuntimeDependencies,
): Promise<VerifiedBestOfResult> {
  const task = validateTask(input.task);
  const candidateCount: CandidateCount = normalizeCandidateCount(input.candidateCount, config.defaultCandidateCount);
  // The other two values that end up inside the cmd.exe command line of every
  // candidate: same refusal, at the one place both the config file and the
  // settings document route their values through.
  assertCommandSafeValue(config.candidateProfile, "candidateProfile");
  // The third value that ends up on the same cmd.exe line. `assertBatchFileLaunchable` below only
  // covers whitespace in a *.cmd/*.bat name, and its predicate is anchored, so "dsh.cmd&calc.exe"
  // passed every check and then reached the ENOENT -> `cmd /d /s /c` retry, which runs both halves.
  assertCommandSafeValue(config.dshExecutable, "dshExecutable");
  assertBatchFileLaunchable(config.dshExecutable);
  if (config.validationMode !== "auto" && config.validationMode !== "configured") {
    // Same trust boundary as the unknown reviewMode: settings.ts:113 casts the host document
    // unchecked, and this one fell through to project auto-detection — the operator's configured
    // validation commands would never run, with nothing on disk saying they were skipped.
    throw new Error(
      `invalid validationMode ${JSON.stringify(config.validationMode)}: this build implements "auto" and "configured"`,
    );
  }
  if (!CREDENTIAL_REFERENCE.test(config.credentialRef)) {
    throw new Error(
      `invalid credentialRef: expected a POSIX environment name, got ${JSON.stringify(config.credentialRef)}`,
    );
  }
  const repository = await inspectRepository(input.repositoryPath);
  const { commands: validationCommands, setupCommands } = await resolveValidationCommands(
    repository.repositoryPath,
    // A per-call override wins; otherwise validationMode decides between the
    // configured command list and project auto-detection.
    input.validationCommands
      ?? (config.validationMode === "configured" && config.validationCommands.length > 0
        ? config.validationCommands
        : undefined),
  );
  const stateDirectory = await canonicalStateDirectory(config.stateDirectory, repository.repositoryPath);
  await assertEnoughDiskSpace(stateDirectory, candidateCount);
  const approvalSignal = input.signal ?? new AbortController().signal;
  await dependencies.requestApproval(
    createApprovalReason(repository, candidateCount, validationCommands, config),
    approvalSignal,
  );
  // Optional until LLM ranking needs it: validation-only selection completes
  // without any verifier credential.
  const credentialValue = await dependencies.resolveCredential();
  if (credentialValue.length > 0) {
    assertRequestDoesNotContainCredential(task, validationCommands, credentialValue);
  }

  const runAbortController = new AbortController();
  const relayAbort = (): void => runAbortController.abort(input.signal?.reason);
  input.signal?.addEventListener("abort", relayAbort, { once: true });
  const runTimeout = setTimeout(
    () => runAbortController.abort(new Error(`run timed out after ${config.runTimeoutMs} ms`)),
    config.runTimeoutMs,
  );
  runTimeout.unref();

  // Everything the run record serializes is declared outside the lock body, so the
  // catch below can persist whatever already settled: `apply_verified_winner`,
  // `select_verified_candidate` and `rollback_verified_winner` all refuse a run with
  // no manifest.json, and the candidate results a paid run produced were then
  // unreachable. Only the paths `runId` names and the accumulators move; the work
  // itself still happens under the lock.
  const runId = randomUUID();
  const runDirectory = join(stateDirectory, "runs", runId);
  const manifestPath = join(runDirectory, "manifest.json");
  const reportPath = join(runDirectory, "report.md");
  const cleanupWarnings: string[] = [];
  let candidateResults: CandidateResult[] = [];
  let eligibleCandidates: CandidateResult[] = [];
  let status: VerifiedBestOfResult["status"] = "no_winner";
  let selectionMethod: VerifiedBestOfResult["selectionMethod"] = null;
  let winner: CandidateResult | undefined;
  let tokenUsage: VerifiedBestOfResult["tokenUsage"] = null;
  let verifierRequestCount = 0;
  let verifierLogPath: string | null = null;
  let reviewReceipt: ReviewReceipt | null = null;
  let selectionFailure: string | null = null;
  // The one serialization of the run record, so an incomplete run carries the same
  // manifest and report shape the apply/select/rollback readers already parse.
  // Both writes are exclusive-create, so the failure path below records only a run
  // that has written no record yet: a decision already on disk is never rewritten.
  const persistRunRecord = async (
    recordWinnerPatchPath: string | null,
    recordWinnerPatchSha256: string | null,
  ): Promise<VerifiedBestOfResult> => {
    const resolvedConfig: Record<string, string | number | boolean | string[]> = {
      enabled: config.enabled,
      defaultCandidateCount: config.defaultCandidateCount,
      maxConcurrentCandidates: config.maxConcurrentCandidates,
      candidateProfile: config.candidateProfile,
      reviewMode: config.reviewMode,
      reviewerProvider: config.reviewerProvider,
      reviewerModel: config.reviewerModel,
      reviewerReasoningEffort: config.reviewerReasoningEffort,
      reviewerMaxTokens: config.reviewerMaxTokens,
      reviewerTimeoutMs: config.reviewerTimeoutMs,
      reviewSingleEligible: config.reviewSingleEligible,
      reviewFailurePolicy: config.reviewFailurePolicy,
      validationMode: config.validationMode,
      validationCommands: [...validationCommands],
      credentialRef: config.credentialRef,
      verifierModel: config.verifierModel,
      nEvaluations: config.nEvaluations,
      maxVerifierWorkers: config.maxVerifierWorkers,
      verifierEffort: config.verifierEffort,
      verifierMaxTokens: config.verifierMaxTokens,
      candidateTimeoutMs: config.candidateTimeoutMs,
      validationTimeoutMs: config.validationTimeoutMs,
      runTimeoutMs: config.runTimeoutMs,
      maxVerifierTraceBytes: config.maxVerifierTraceBytes,
      stateDirectory: config.stateDirectory,
    };
    const result: VerifiedBestOfResult = {
      schemaVersion: 2,
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
      winnerPatchPath: recordWinnerPatchPath,
      failure: selectionFailure,
      review: reviewReceipt,
      resolvedConfig,
      settingsRevision: input.settingsRevision ?? null,
    };
    await writePrivateTextFile(
      manifestPath,
      `${JSON.stringify({
        schemaVersion: 2,
        pluginVersion: PLUGIN_VERSION,
        createdAt: new Date().toISOString(),
        repositoryPath: repository.repositoryPath,
        baseCommit: repository.baseCommit,
        validationCommands,
        winnerPatchSha256: recordWinnerPatchSha256,
        verifierLogPath,
        resolvedConfig,
        settingsRevision: input.settingsRevision ?? null,
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
          logPaths: candidate.logPaths,
          verifierTraceTruncated: candidate.verifierTraceTruncated,
          failure: candidate.failure,
        })),
        warnings: [
          ...cleanupWarnings,
          ...candidateResults
            .filter((candidate) => candidate.verifierTraceTruncated)
            .map((candidate) => `${candidate.candidateId} verifier input was truncated`),
        ],
        result,
      }, null, 2)}\n`,
    );
    await writePrivateTextFile(
      reportPath,
      reportMarkdown(result, candidateResults, cleanupWarnings, config, verifierLogPath),
    );
    return result;
  };

  const releaseRepositoryLock = await acquireRepositoryLock(stateDirectory, repository.repositoryPath);
  try {
  progress(`run ${runId} starting: ${candidateCount} candidates, validation: ${validationCommands.join("; ")}`);
  const worktreesDirectory = join(runDirectory, "worktrees");
  const artifactsDirectory = join(runDirectory, "artifacts");
  await mkdir(worktreesDirectory, { recursive: true, mode: 0o700 });
  await mkdir(artifactsDirectory, { recursive: true, mode: 0o700 });

  const worktreePaths: string[] = [];
  // worktree path -> why a process of this run may still be writing into it.
  // Filled in once, by `awaitResidualProcessTrees`, from the observations the
  // candidates registered while their commands were still running in parallel.
  const residualWorktrees = new Map<string, string>();
  const residualProcessTrees: ResidualProcessTreeNote[] = [];
  try {
    for (let candidateNumber = 1; candidateNumber <= candidateCount; candidateNumber += 1) {
      const candidateId = `candidate-${candidateNumber}`;
      const worktreePath = join(worktreesDirectory, candidateId);
      progress(`creating worktree ${candidateNumber}/${candidateCount}`);
      // Recorded before the await: `git worktree add` registers the worktree and
      // then checks it out, so a killed child leaves a registered worktree whose
      // directory still exists — invisible to `git worktree prune` and to a
      // cleanup loop that only learned the path after the rejection escaped.
      worktreePaths.push(worktreePath);
      await createDetachedWorktree(repository, worktreePath, runAbortController.signal);
    }
    progress(`launching ${candidateCount} candidates (max ${config.maxConcurrentCandidates} concurrent)`);
    candidateResults = await runCandidatePool(worktreePaths, config.maxConcurrentCandidates, () => runAbortController.abort(new Error("candidate worker failed")), (worktreePath, candidateIndex) => {
      const candidateId = `candidate-${candidateIndex + 1}`;
      progress(`candidate ${candidateId} started`);
      return executeCandidate({
        candidateId,
        worktreePath,
        candidateArtifactsDirectory: join(artifactsDirectory, candidateId),
        task,
        // The install step belongs to the worktree, which is a bare checkout;
        // the commands persisted for the post-apply revalidation do not, because
        // that one runs in the user's own repository.
        validationCommands: [...setupCommands, ...validationCommands],
        residualWorktrees,
        residualProcessTrees,
        repository,
        config,
        credentialValue,
        signal: runAbortController.signal,
      });
    });
  } finally {
    // One read of every deferred observation, here, before anything is deleted: the
    // walks started while sibling candidates were still working, so the run pays one
    // enumeration instead of one per spawn charged to the stage clock.
    const processTreeLog = await awaitResidualProcessTrees(residualProcessTrees, residualWorktrees);
    if (processTreeLog.length > 0) {
      const processTreeLogPath = join(artifactsDirectory, "process-tree.log");
      try {
        await writeFile(processTreeLogPath, processTreeLog, { encoding: "utf8", mode: 0o600 });
        // The per-stage logs no longer carry these three flags, so name the file
        // that does or the disclosure is unfindable from the run output.
        progress(`residual process tree observations written to ${processTreeLogPath}`);
      } catch {
        cleanupWarnings.push(`process-tree.log could not be written to ${processTreeLogPath}; the run has no residual-process disclosure`);
      }
    }
    for (const worktreePath of [...worktreePaths].reverse()) {
      const residual = residualWorktrees.get(worktreePath);
      if (residual !== undefined) {
        // `git worktree remove --force` deletes the checkout a live child is
        // still writing into: the work is lost and, on Windows, the delete fails
        // on the open files anyway. Leave the directory and say where it is.
        cleanupWarnings.push(
          `worktree at ${worktreePath} was NOT removed because ${residual}; delete it once that process is gone`,
        );
        continue;
      }
      try {
        await removeWorktree(repository.repositoryPath, worktreePath);
      } catch (error) {
        const cleanupFailure = error instanceof Error ? error.message : String(error);
        cleanupWarnings.push(
          `worktree cleanup failed; residual directory may remain at ${worktreePath}: ${cleanupFailure}`,
        );
      }
    }
    try {
      await runGit(repository.repositoryPath, ["worktree", "prune"]);
    } catch (error) {
      cleanupWarnings.push(error instanceof Error ? error.message : String(error));
    }
  }

  for (const candidate of candidateResults) {
    progress(`candidate ${candidate.candidateId}: ${candidate.executionStatus}/${candidate.validationStatus} (${candidate.durationMs}ms)`);
  }
  eligibleCandidates = candidateResults.filter(
    (candidate) => candidate.executionStatus === "completed" && candidate.validationStatus === "passed",
  );
  progress(`${eligibleCandidates.length}/${candidateResults.length} candidates eligible`);
  // Key the veto on what the abort *did*, not on the flag's live value at this instant. Cleanup
  // (residual-tree reads + worktree removal) runs after every candidate has settled and can outlast
  // the whole remaining budget — measured at 52 s on a loaded Windows box, where the flag was set
  // while `candidateResults` already held three honest terminal results. Discarding those erased a
  // won run as `status: failed`. The marker is a candidate whose own process the abort killed
  // (:979); an abort landing in a *validation* window leaves that candidate `completed`/`timed_out`
  // instead, and the run decides among the survivors — the engine does the same on that input (its
  // `runValidation` records an aborted validation as `failed`, so its survivor wins). An abort
  // arriving after the last candidate exited is disclosed by the block below instead.
  // The two reasons an abort happens are actionable in different ways, and both used to print the same
  // sentence: the run's own deadline aborts with a message THIS file generates (`run timed out after
  // <runTimeoutMs> ms`, :1439), while a host cancel carries the host's arbitrary text. Disclose only the
  // first, and only appended — so every consumer that matches the existing wording still matches, and no
  // untrusted host string is echoed into report.md / the manifest.
  const abortDisclosure = (): string => {
    const reason = String((runAbortController.signal.reason as { message?: string } | undefined)?.message ?? "");
    return /^run timed out after \d+ ms$/.test(reason)
      ? `run was cancelled or exceeded its total timeout (${reason})`
      : "run was cancelled or exceeded its total timeout";
  };
  const abortTruncatedThePool = candidateResults.some(
    (candidate) => candidate.executionStatus === "cancelled",
  );
  selectionFailure = runAbortController.signal.aborted && abortTruncatedThePool
    ? abortDisclosure()
    : null;

  const enterReviewPending = (reason: string): void => {
    status = "review_pending";
    selectionMethod = null;
    winner = undefined;
    progress(`run ${runId}: review_pending — ${reason}`);
  };

  if (selectionFailure === null && eligibleCandidates.length === 1 && !config.reviewSingleEligible) {
    status = "winner_selected";
    selectionMethod = "validation_only";
    winner = eligibleCandidates[0];
    if (winner !== undefined) {
      winner.score = 1;
      winner.rankingPosition = 1;
    }
  } else if (selectionFailure === null && eligibleCandidates.length >= 1) {
    if (config.reviewMode === "parent_agent") {
      // Parent-agent mode never auto-selects: the run stays review_pending
      // until an explicit select_verified_candidate call records the choice.
      enterReviewPending("parent agent must pick a winner via select_verified_candidate");
      for (const [index, candidate] of eligibleCandidates.entries()) {
        candidate.rankingPosition = index + 1;
      }
    } else if (config.reviewMode === "dsh_model") {
      // An already-spent budget is a second way this reviewer is unreachable. The deepseek path
      // refuses before it spawns (`process.ts:315` throws `process aborted before launch`), but
      // this one hands the host a dead controller and then relies on the host honouring it —
      // `src/reviewer.ts:133` documents "a host that ignores `signal`" as an expected case, so a
      // cancel press could otherwise be answered with a full paid review.
      const reviewUnreachable = dependencies.reviewCandidates === undefined
        ? "reviewMode 'dsh_model' requires the host LLM runtime (ctx.llm), which is unavailable"
        : "the run deadline expired before reviewMode 'dsh_model' could review the eligible candidates; no review was launched";
      if (dependencies.reviewCandidates === undefined || runAbortController.signal.aborted) {
        if (config.reviewFailurePolicy === "parent_agent") {
          // A handoff caused by an unreachable reviewer has to reach the result too: review_pending
          // with `failure: none` is indistinguishable from an ordinary parent-agent choice — the same
          // rule the two sibling handoffs follow at :1629 and :1712.
          enterReviewPending(reviewUnreachable);
          selectionFailure = reviewUnreachable;
        } else {
          status = "failed";
          selectionFailure = reviewUnreachable;
        }
      } else {
        try {
          const diffTexts: string[] = [];
          for (const candidate of eligibleCandidates) {
            if (candidate.patchPath === null) {
              diffTexts.push("");
              continue;
            }
            try {
              // The deepseek path caps its trace at maxVerifierTraceBytes; the
              // host reviewer gets the same ceiling instead of an unbounded
              // patch per candidate inlined into one prompt.
              diffTexts.push(truncateVerifierTrace(
                await readFile(candidate.patchPath, "utf8"),
                config.maxVerifierTraceBytes,
              ).text);
            } catch {
              diffTexts.push("");
            }
          }
          const receipt = await dependencies.reviewCandidates({
            provider: config.reviewerProvider,
            model: config.reviewerModel,
            ...(config.reviewerReasoningEffort !== "" ? { reasoningEffort: config.reviewerReasoningEffort } : {}),
            maxTokens: config.reviewerMaxTokens,
            timeoutMs: config.reviewerTimeoutMs,
            signal: runAbortController.signal,
            task,
            candidates: eligibleCandidates.map((candidate, index) => ({
              candidateId: candidate.candidateId,
              validationStatus: candidate.validationStatus,
              diffStat: candidate.diffStat,
              changedFiles: candidate.changedFiles,
              diffText: diffTexts[index] ?? "",
            })),
          });
          reviewReceipt = receipt;
          status = "winner_selected";
          selectionMethod = "dsh_model";
          winner = eligibleCandidates.find((candidate) => candidate.candidateId === receipt.selectedId);
          for (const candidate of eligibleCandidates) {
            candidate.score = receipt.scores[candidate.candidateId] ?? null;
          }
          const ranked = [...eligibleCandidates].sort((left, right) => {
            const byScore = (right.score ?? 0) - (left.score ?? 0);
            return byScore !== 0 ? byScore : left.candidateId.localeCompare(right.candidateId);
          });
          for (const [index, candidate] of ranked.entries()) {
            candidate.rankingPosition = index + 1;
          }
          progress(`dsh_model review selected ${receipt.selectedId} in ${receipt.durationMs}ms`);
        } catch (error) {
          const failure = failureMessage(error, credentialValue);
          if (config.reviewFailurePolicy === "parent_agent") {
            const handoff = `dsh_model review failed (${failure}); policy hands off to the parent agent`;
            enterReviewPending(handoff);
            selectionFailure = handoff;
          } else {
            status = "failed";
            selectionFailure = failure;
          }
        }
      }
    } else if (config.reviewMode === "deepseek_verifier") {
      if (eligibleCandidates.length === 1) {
        // The comparison bridge accepts 2-5 inputs; a single candidate cannot
        // be compared without fabricating inputs, so it goes to review unless
        // the operator accepted validation-only for single candidates.
        if (config.reviewSingleEligible) {
          enterReviewPending("single eligible candidate cannot enter the comparison bridge; parent review required");
        } else {
          status = "winner_selected";
          selectionMethod = "validation_only";
          winner = eligibleCandidates[0];
          if (winner !== undefined) {
            winner.score = 1;
            winner.rankingPosition = 1;
          }
        }
      } else if (credentialValue.length === 0) {
        if (config.reviewFailurePolicy === "parent_agent") {
          // Same reason as the two review-failure handoffs below: the cause belongs in the result.
          const handoff = `credential ${config.credentialRef} is not configured; policy hands off to the parent agent`;
          enterReviewPending(handoff);
          selectionFailure = handoff;
        } else {
          status = "failed";
          selectionFailure = `reviewMode 'deepseek_verifier' requires credential ${config.credentialRef}, which is not configured`;
        }
      } else {
        verifierLogPath = join(runDirectory, "verifier.log");
        let verifierResponseForLog: VerifierResponse | undefined;
        try {
          const verifierResponse = await dependencies.runVerifier({
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
            signal: runAbortController.signal,
          });
          verifierResponseForLog = verifierResponse;
          await writePrivateTextFile(
            verifierLogPath,
            redactSecret(`${JSON.stringify({
              candidateIds: eligibleCandidates.map((candidate) => candidate.candidateId),
              pivots: Math.min(2, eligibleCandidates.length - 1),
              model: config.verifierModel,
              nEvaluations: config.nEvaluations,
              maxWorkers: config.maxVerifierWorkers,
              response: verifierResponse,
            }, null, 2)}\n`, credentialValue),
          );
          validateVerifierResponse(verifierResponse, eligibleCandidates.length);
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
        } catch (error) {
          const verifierFailure = failureMessage(error, credentialValue);
          const candidateIds = eligibleCandidates.map((candidate) => candidate.candidateId);
          if (config.reviewFailurePolicy === "parent_agent") {
            // The cause has to reach the result, not only the log: a run that
            // lands in review_pending because the reviewer broke reads as an
            // ordinary handoff with `failure: none` otherwise.
            const handoff = `deepseek_verifier review failed (${verifierFailure}); policy hands off to the parent agent`;
            enterReviewPending(handoff);
            selectionFailure = handoff;
            await recordVerifierFailureLog(
              verifierLogPath,
              {
                candidateIds,
                failure: verifierFailure,
                response: verifierResponseForLog,
              },
              credentialValue,
              cleanupWarnings,
            );
          } else {
            status = "failed";
            selectionFailure = verifierFailure;
            await recordVerifierFailureLog(
              verifierLogPath,
              {
                candidateIds,
                pivots: Math.min(2, eligibleCandidates.length - 1),
                model: config.verifierModel,
                nEvaluations: config.nEvaluations,
                maxWorkers: config.maxVerifierWorkers,
                failure: verifierFailure,
                response: verifierResponseForLog,
              },
              credentialValue,
              cleanupWarnings,
            );
          }
        }
      }
    } else {
      // settings.ts:113 casts the host settings document straight to RunSettings, so a typo'd or
      // stale reviewMode in the persisted file reaches here unvalidated. Falling through used to
      // leave status at "no_winner" with failure: none — indistinguishable from "candidates ran
      // and none qualified".
      status = "failed";
      selectionFailure = `unknown reviewMode ${JSON.stringify(config.reviewMode)}: this build implements parent_agent, dsh_model and deepseek_verifier`;
    }
  } else if (selectionFailure !== null) {
    status = "failed";
  }

  // `awaitingHostSelection` is not a second flag to keep in sync, it is `status` one line earlier:
  // `enterReviewPending` writes review_pending through a closure, so control-flow analysis cannot
  // see it and reads the comparison below as impossible (TS2367) if it is written against `status`.
  const awaitingHostSelection: string = status;
  if (runAbortController.signal.aborted && status !== "winner_selected" && awaitingHostSelection !== "review_pending") {
    status = "failed";
    selectionMethod = null;
    winner = undefined;
    selectionFailure ??= abortDisclosure();
  } else if (runAbortController.signal.aborted) {
    // The decision was already taken over the eligible pool; a deadline that lands afterwards
    // does not un-take it. `review_pending` is that same kind of state: the pool is settled and
    // the host still has a move (`select_verified_candidate` refuses every other status), so
    // rewriting it to "failed" would spend the run's whole model cost and leave nothing to pick.
    // Erasing the winner here also skipped the winner.patch write below and
    // threw away work the caller could still apply. Disclose the truncation instead.
    const reason = runAbortController.signal.reason;
    const why = reason instanceof Error ? reason.message : String(reason);
    cleanupWarnings.push(status === "winner_selected"
      ? `run aborted after a winner was selected (${why}): ` +
        "the winner covers only the candidates that finished in time"
      : `run aborted while it was waiting for the host to pick a winner (${why}): ` +
        "the eligible pool is frozen, so select_verified_candidate can still record the choice");
  }

  let winnerPatchPath: string | null = null;
  let winnerPatchSha256: string | null = null;
  if (winner?.patchPath !== null && winner?.patchPath !== undefined) {
    winnerPatchPath = join(runDirectory, "winner.patch");
    const sourcePatch = await readFile(winner.patchPath);
    const sourcePatchSha256 = createHash("sha256").update(sourcePatch).digest("hex");
    if (sourcePatchSha256 !== winner.patchSha256) {
      throw new Error(
        `candidate patch ${winner.patchPath} hash changed: expected ${winner.patchSha256}, got ${sourcePatchSha256}`,
      );
    }
    // Re-apply after rollback: winner.patch already exists from the previous
    // apply; overwrite only when its bytes still match the recorded hash.
    try {
      const existingSha = createHash("sha256").update(await readFile(winnerPatchPath)).digest("hex");
      if (existingSha !== sourcePatchSha256) {
        throw new Error(
          `winner.patch already exists with different content (sha ${existingSha.slice(0, 12)}…); refusing to overwrite`,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await writeFile(winnerPatchPath, sourcePatch, { mode: 0o600 });
    winnerPatchSha256 = sourcePatchSha256;
  }

  progress(`run ${runId} complete: status=${status}, winner=${winner?.candidateId ?? "none"}`);
  return await persistRunRecord(winnerPatchPath, winnerPatchSha256);
  } catch (error) {
    // A throw anywhere above reaches here: `git worktree add` rejects on an abort or a
    // Windows long path, and the winner-patch stage rethrows anything but ENOENT off the
    // existing `winner.patch`. Both spent the candidate budget, so the settled results are
    // persisted as an honest incomplete run — status `failed` plus the reason — before the
    // error goes back to the host unchanged. The record writes are exclusive-create, so a
    // run whose manifest already landed keeps that record and only prints below.
    const failure = failureMessage(error, credentialValue);
    status = "failed";
    // The same trio the abort branch above resets: a `failed` run that still names a
    // winner is rendered as `Winner: candidate-2` for every status, over a run the
    // apply, select and rollback readers all refuse.
    selectionMethod = null;
    winner = undefined;
    selectionFailure = discloseWarning(selectionFailure, failure);
    try {
      await persistRunRecord(null, null);
    } catch (recordError) {
      progress(`run ${runId} could not write its record at ${manifestPath}: ${failureMessage(recordError, credentialValue)}`);
    }
    throw error;
  } finally {
    clearTimeout(runTimeout);
    input.signal?.removeEventListener("abort", relayAbort);
    await releaseRepositoryLock();
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

function parseStoredRunManifest(manifestText: string, selectionText?: string): StoredRunManifest {
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
  if (manifest.schemaVersion !== 1 && manifest.schemaVersion !== 2) {
    throw new Error(`unsupported run manifest schemaVersion: ${JSON.stringify(manifest.schemaVersion)}`);
  }
  const resultValue = manifest.result;
  if (resultValue === null || typeof resultValue !== "object" || Array.isArray(resultValue)) {
    throw new Error(`invalid run manifest result: ${JSON.stringify(resultValue)}`);
  }
  const result = resultValue as Record<string, unknown>;
  const status = result.status;
  if (status !== "winner_selected" && status !== "review_pending") {
    throw new Error(`run ${JSON.stringify(result.runId)} has no applicable winner; status is ${JSON.stringify(status)}`);
  }
  const validationCommands = manifest.validationCommands;
  if (
    !Array.isArray(validationCommands)
    || validationCommands.length === 0
    || validationCommands.some((command) => typeof command !== "string" || command.length === 0)
  ) {
    throw new Error(`invalid run manifest validationCommands: ${JSON.stringify(validationCommands)}`);
  }
  const rankingValue = result.ranking;
  if (!Array.isArray(rankingValue)) {
    throw new Error(`invalid run manifest ranking: ${JSON.stringify(rankingValue)}`);
  }
  const candidateRuns = Array.isArray(manifest.candidateRuns) ? (manifest.candidateRuns as Array<Record<string, unknown>>) : [];
  let winnerId: string;
  let winnerPatchSha256: string;
  let winnerPatchPath: string | null;
  let changedFiles: string[];
  if (status === "winner_selected") {
    winnerId = requiredManifestString(result, "winnerId");
    winnerPatchSha256 = requiredManifestString(manifest, "winnerPatchSha256");
    if (!/^[0-9a-f]{64}$/u.test(winnerPatchSha256)) {
      throw new Error(`invalid run manifest winnerPatchSha256: ${JSON.stringify(winnerPatchSha256)}`);
    }
    winnerPatchPath = requiredManifestString(result, "winnerPatchPath");
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
    changedFiles = changedFilesValue as string[];
  } else {
    if (selectionText === undefined) {
      throw new Error(
        `run ${JSON.stringify(result.runId)} is awaiting an explicit reviewer choice; call select_verified_candidate first`,
      );
    }
    let selectionValue: unknown;
    try {
      selectionValue = JSON.parse(selectionText);
    } catch (error) {
      throw new Error("selection record contains invalid JSON", { cause: error });
    }
    if (selectionValue === null || typeof selectionValue !== "object" || Array.isArray(selectionValue)) {
      throw new Error("invalid selection record root");
    }
    const record = selectionValue as Record<string, unknown>;
    if (record.status !== "selected") {
      throw new Error(`invalid selection record status: ${JSON.stringify(record.status)}`);
    }
    if (typeof record.candidateId !== "string" || record.candidateId.length === 0) {
      throw new Error("selection record is missing candidateId");
    }
    if (typeof record.reason !== "string" || record.reason.trim().length === 0) {
      throw new Error("selection record is missing the reviewer reason");
    }
    winnerId = record.candidateId;
    const candidate = candidateRuns.find((entry) => entry.candidateId === winnerId);
    if (candidate === undefined) {
      throw new Error(`selected candidate ${JSON.stringify(winnerId)} is absent from the run manifest`);
    }
    if (candidate.executionStatus !== "completed" || candidate.validationStatus !== "passed") {
      throw new Error(
        `selected candidate ${JSON.stringify(winnerId)} is not eligible (execution ${JSON.stringify(candidate.executionStatus)}, validation ${JSON.stringify(candidate.validationStatus)})`,
      );
    }
    if (typeof candidate.patchPath !== "string" || candidate.patchPath.length === 0) {
      throw new Error(`selected candidate ${JSON.stringify(winnerId)} has no patch in the manifest`);
    }
    if (typeof candidate.patchSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(candidate.patchSha256)) {
      throw new Error(`selected candidate ${JSON.stringify(winnerId)} has an invalid patch hash`);
    }
    const changedFilesValue = candidate.changedFiles;
    if (!Array.isArray(changedFilesValue) || changedFilesValue.some((path) => typeof path !== "string")) {
      throw new Error(`invalid selected candidate changedFiles: ${JSON.stringify(changedFilesValue)}`);
    }
    winnerPatchSha256 = candidate.patchSha256;
    winnerPatchPath = candidate.patchPath;
    changedFiles = changedFilesValue as string[];
  }
  return {
    repositoryPath: requiredManifestString(manifest, "repositoryPath"),
    baseCommit: requiredManifestString(manifest, "baseCommit"),
    validationCommands: validationCommands as string[],
    winnerPatchSha256,
    winnerPatchPath,
    winnerId,
    changedFiles,
  };
}

export async function applyVerifiedWinner(
  input: ApplyVerifiedWinnerInput,
  config: RunSettings,
  dependencies: ApplyRuntimeDependencies,
): Promise<ApplyVerifiedWinnerResult> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(input.runId)) {
    throw new Error(`invalid runId: expected a UUID v4, got ${JSON.stringify(input.runId)}`);
  }
  const repository = await inspectRepository(input.repositoryPath);
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
  const manifestText = await readFile(manifestPath, "utf8");
  const selectionPath = join(runDirectory, "selection.json");
  let selectionText: string | undefined;
  try {
    selectionText = await readFile(selectionPath, "utf8");
  } catch {
    selectionText = undefined;
  }
  const manifest = parseStoredRunManifest(manifestText, selectionText);
  const applyStatePath = join(runDirectory, APPLY_STATE_FILE);
  const applyResultPath = join(runDirectory, APPLY_RESULT_FILE);
  // Checked before any side effect: a previous apply must be rolled back first,
  // and re-applying after a rollback has to succeed rather than fail on an
  // already-existing record after the tree was already mutated. This early read
  // is a fail-fast only: the decision is re-taken inside the lock below, so two
  // concurrent applies of the same run cannot both get past it.
  if (await handleBlocksReapply(applyStatePath, join(runDirectory, ROLLBACK_RESULT_FILE))) {
    throw new Error(
      `run ${input.runId} is already applied to this repository; roll it back with rollback_verified_winner before applying it again`,
    );
  }
  const manifestRaw = JSON.parse(manifestText) as Record<string, unknown>;
  const resultStatus = (manifestRaw.result as Record<string, unknown>).status;
  let effectiveChangedFiles = manifest.changedFiles;
  let effectiveWinnerPatchSha256 = manifest.winnerPatchSha256;
  let effectiveWinnerId = manifest.winnerId;
  // An override brings its own bytes: they are held here and written to
  // `winner.patch` inside the repository lock, because that write is a mutation
  // of run state and must not sit outside the critical section.
  let overridePatch: Buffer | null = null;
  let overrideCandidateId = input.candidateId;
  if (
    overrideCandidateId !== undefined
    && selectionText !== undefined
  ) {
    const selection = JSON.parse(selectionText) as { candidateId?: unknown };
    if (selection.candidateId !== overrideCandidateId) {
      throw new Error(
        `candidateId ${JSON.stringify(overrideCandidateId)} conflicts with the recorded selection ${JSON.stringify(selection.candidateId)}; call select_verified_candidate again to change the choice`,
      );
    }
  }
  if (
    overrideCandidateId !== undefined
    && manifestRaw.schemaVersion === 2
    && resultStatus === "winner_selected"
    && overrideCandidateId !== manifest.winnerId
  ) {
    throw new Error(
      `run ${input.runId} recorded ${manifest.winnerId} as the verified winner; candidateId overrides are only supported on legacy v1 runs`,
    );
  }
  if (resultStatus === "review_pending" && overrideCandidateId === undefined) {
    overrideCandidateId = manifest.winnerId;
  }
  if (overrideCandidateId) {
    const candidateRuns = (manifestRaw.candidateRuns ?? []) as Array<Record<string, unknown>>;
    const target = candidateRuns.find((cr) => cr.candidateId === overrideCandidateId);
    if (!target) throw new Error(`candidate ${overrideCandidateId} not found in run ${input.runId}`);
    if (target.executionStatus !== "completed" || target.validationStatus !== "passed") {
      throw new Error(
        `candidate ${JSON.stringify(overrideCandidateId)} is not eligible (execution ${JSON.stringify(target.executionStatus)}, validation ${JSON.stringify(target.validationStatus)})`,
      );
    }
    const patchPath = target.patchPath;
    if (typeof patchPath !== "string" || patchPath.length === 0) {
      throw new Error(`candidate ${overrideCandidateId} has no patch in manifest`);
    }
    if (!isPathInside(runDirectory, resolve(patchPath))) {
      throw new Error(
        `candidate ${overrideCandidateId} patch path escaped its run directory: ${patchPath}`,
      );
    }
    const recordedPatchSha256 = target.patchSha256;
    if (typeof recordedPatchSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(recordedPatchSha256)) {
      throw new Error(`candidate ${overrideCandidateId} has an invalid patch hash`);
    }
    const patchContent = await readFile(patchPath);
    const sha256 = createHash("sha256").update(patchContent).digest("hex");
    if (sha256 !== recordedPatchSha256) {
      throw new Error(
        `candidate ${overrideCandidateId} patch hash changed: expected ${recordedPatchSha256}, got ${sha256}`,
      );
    }
    const changedFilesValue = target.changedFiles;
    if (!Array.isArray(changedFilesValue) || changedFilesValue.some((path) => typeof path !== "string")) {
      throw new Error(`invalid candidate ${overrideCandidateId} changedFiles`);
    }
    overridePatch = patchContent;
    effectiveWinnerPatchSha256 = sha256;
    effectiveWinnerId = overrideCandidateId;
    effectiveChangedFiles = changedFilesValue as string[];
  }
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
  // review_pending runs resolve the winner patch from the selected candidate's
  // artifacts: the override block above verified those bytes, and writing them
  // to `winner.patch` waits for the repository lock.
  const effectiveWinnerPatchPath = resultStatus === "review_pending"
    ? expectedPatchPath
    : manifest.winnerPatchPath;
  if (resolve(effectiveWinnerPatchPath) !== expectedPatchPath) {
    throw new Error(
      `run manifest winnerPatchPath escaped its run directory: ${effectiveWinnerPatchPath}`,
    );
  }
  const patchMetadata = overridePatch === null ? await lstat(expectedPatchPath) : null;
  if (patchMetadata !== null && !patchMetadata.isFile()) {
    throw new Error(`winner patch must be a regular file, got ${expectedPatchPath}`);
  }
  const patch = overridePatch ?? await readFile(await realpath(expectedPatchPath));
  const actualPatchSha256 = createHash("sha256").update(patch).digest("hex");
  if (actualPatchSha256 !== effectiveWinnerPatchSha256) {
    throw new Error(
      `winner patch hash changed for run ${input.runId}: expected ${effectiveWinnerPatchSha256}, got ${actualPatchSha256}`,
    );
  }
  for (const changedFile of effectiveChangedFiles) {
    if (isAbsolute(changedFile) || !isPathInside(repository.repositoryPath, join(repository.repositoryPath, changedFile))) {
      throw new Error(
        `winner changedFiles contains a path that escapes the repository: ${JSON.stringify(changedFile)}`,
      );
    }
  }
  const createApplyState = (
    status: ApplyStateRecord["status"],
    appliedFileSha256: Record<string, string | null> = {},
  ): ApplyStateRecord => ({
    schemaVersion: 1,
    runId: input.runId,
    status,
    baseCommit: manifest.baseCommit,
    patchSha256: actualPatchSha256,
    changedFiles: effectiveChangedFiles,
    appliedFileSha256,
  });
  const approvalSignal = input.signal ?? new AbortController().signal;
  await runGitApplyWithVerifiedPatch(
    repository.repositoryPath,
    patch,
    true,
    config.validationTimeoutMs,
    approvalSignal,
  );
  await dependencies.requestApproval(
    [
      `Apply verified winner ${effectiveWinnerId} from run ${input.runId}.`,
      `Repository: ${repository.repositoryPath}.`,
      `Patch SHA-256: ${actualPatchSha256}.`,
      `Changed files: ${effectiveChangedFiles.join(", ")}.`,
      `Validation commands after apply: ${manifest.validationCommands.join("; ")}.`,
      "The patch will not be staged, committed, pushed, stashed, or reset.",
    ].join("\n"),
    approvalSignal,
  );
  const credentialValue = await dependencies.resolveCredential();

  // Set only for a post-mutation write that cannot land (the rollback handle, a
  // validation log); disclosed in the returned result rather than thrown over a
  // tree that is already changed.
  let applyNote: string | null = null;

  // The lock spans every guard read that gates a mutation plus the mutation
  // itself, exactly like rollback. The checks above it are fail-fast only: two
  // concurrent `apply_verified_winner` calls on one runId used to both walk past
  // every guard, because the guards and the state writes sat on opposite sides
  // of the lock. The interactive approval wait stays outside it deliberately, so
  // a human taking a minute to answer does not hold the repository.
  const releaseRepositoryLock = await acquireRepositoryLock(stateDirectory, repository.repositoryPath);
  try {
    // The operator kill switch is re-read here, beside the other guards that gate
    // a mutation: the handler's check and this one are separated by an approval
    // wait that can take a minute, during which `enabled: false` can land.
    if (dependencies.isDisabled?.() === true) {
      throw new Error("apply_verified_winner is disabled by the llm-verifier settings (enabled: false)");
    }
    if (await handleBlocksReapply(applyStatePath, join(runDirectory, ROLLBACK_RESULT_FILE))) {
      throw new Error(
        `run ${input.runId} is already applied to this repository; roll it back with rollback_verified_winner before applying it again`,
      );
    }
    // The approval wait above sat outside this lock, so a peer session could
    // have re-selected meanwhile: the bytes about to be applied are the prepared
    // candidate's, and the durable record has to name that same one.
    const selectionInLock = await readOptionalJson(selectionPath) as { candidateId?: unknown } | null;
    if (selectionInLock !== null && selectionInLock.candidateId !== effectiveWinnerId) {
      throw new Error(
        `selection changed to ${JSON.stringify(selectionInLock.candidateId)} while run ${input.runId} awaited approval, but ${JSON.stringify(effectiveWinnerId)} was prepared: re-run select_verified_candidate for the winner you want, then apply_verified_winner again`,
      );
    }
    const repositoryAfterApproval = await inspectRepository(repository.repositoryPath);
    if (repositoryAfterApproval.baseCommit !== manifest.baseCommit) {
      throw new Error(
        `repository HEAD changed while applying run ${input.runId}: expected ${manifest.baseCommit}, got ${repositoryAfterApproval.baseCommit}`,
      );
    }
    await runGitApplyWithVerifiedPatch(
      repository.repositoryPath,
      patch,
      true,
      config.validationTimeoutMs,
      approvalSignal,
    );
    if (overridePatch !== null) {
      await writeFile(expectedPatchPath, overridePatch, { mode: 0o600 });
    }
    // The rollback handle is recorded *before* the tree changes, and the apply
    // itself is not interruptible: an approval cancel or tool timeout landing
    // here would otherwise leave a half-applied tree with nothing to roll back.
    await writeFileAtomic(applyStatePath, `${JSON.stringify(createApplyState("applying"), null, 2)}\n`);
    try {
      await runGitApplyWithVerifiedPatch(
        repository.repositoryPath,
        patch,
        false,
        config.validationTimeoutMs,
        new AbortController().signal,
      );
    } catch (error) {
      // The record is the only handle on a tree this apply may have changed, so
      // it stays: the caller's next stop is rollback, not a hand-edited JSON.
      throw new Error(
        `${failureMessage(error, "")} The apply of run ${input.runId} was recorded before it ran; run rollback_verified_winner on this runId to restore the tree, then apply again.`,
        { cause: error },
      );
    }
    const appliedFileSha256: Record<string, string | null> = {};
    for (const changedFile of effectiveChangedFiles) {
      appliedFileSha256[changedFile] = await hashWorkingTreeFile(repository.repositoryPath, changedFile);
    }
    // Post-mutation, this write must not abort a landed apply: the tree is already changed, and
    // throwing here loses the apply result and skips validation. Deliberately NOT retried with a
    // bare writeFile: that opens with truncation, so a failure between the truncate and the last
    // byte leaves a half-written handle, which this layer's readApplyStateRecord refuses to parse
    // — the exact stranded-tree state the atomic write exists to prevent, traded for a slightly
    // more precise record. Leaving the pre-mutation `"applying"` record behind is safe: rollback
    // then proves the revert from the hash-verified patch instead of from appliedFileSha256.
    try {
      await writeFileAtomic(applyStatePath, `${JSON.stringify(createApplyState("applied", appliedFileSha256), null, 2)}\n`);
    } catch (error) {
      applyNote = `the patch of run ${input.runId} is on the tree but its rollback handle could not be raised to "applied": `
        + `${failureMessage(error, "")} The apply itself finished; the handle still says "applying", so a later rollback proves the revert `
        + "from the hash-verified patch instead of from recorded hashes.";
      progress(applyNote);
    }
    // The validation loop and the receipts stay inside the lock on purpose: the
    // commands run in the user's repository and the ceiling is one full
    // config.validationTimeoutMs per command, plus the process-table walks the
    // residual read waits for (the heartbeat every 5 s is what keeps a long pass
    // seated, and the loop re-checks the record because a failed beat is silent).
    // Releasing at the mutation used to let a second
    // call take the lock and run rollback_verified_winner over this tree, deleting
    // apply-state.json / apply-result.json and writing its own rollback-result.json
    // while this call still reported `applied` - and then this call's receipts
    // landed on top of the rollback's.
    const validationLogPaths: string[] = [];
    let validationStatus: ApplyVerifiedWinnerResult["validationStatus"] = "passed";
    let validationFailure: string | null = null;
    const validationEnvironment = sanitizedEnvironment(process.env);
    try {
      for (const [commandIndex, validationCommand] of manifest.validationCommands.entries()) {
        const validationShell = validationShellInvocation(validationCommand);
        const validationResult = await runProcess({
          executable: validationShell.executable,
          arguments: validationShell.arguments,
          cwd: repository.repositoryPath,
          env: validationEnvironment,
          timeoutMs: config.validationTimeoutMs,
          signal: approvalSignal,
          detectResidualTree: true,
        });
        // The wait above is the longest stretch of this widened section (one full
        // config.validationTimeoutMs, plus up to 10 s of process-table walks for the
        // residual read below), and a heartbeat that failed during it is silent - so
        // re-check the lock here, before any of that is recorded as a verdict.
        await assertStillHoldingLock(stateDirectory, repository.repositoryPath);
        const validationLog = redactSecret([
          `$ ${validationCommand}`,
          validationResult.stdout,
          validationResult.stderr.length === 0 ? "" : `[stderr]\n${validationResult.stderr}`,
          `[exit code: ${validationResult.exitCode}]`,
          validationResult.outputLimitExceeded ? "[output exceeded the 16 MiB safety limit]" : "",
          // Post-apply revalidation runs in the user's own repository, where there is no
          // sibling candidate work to overlap the walk against and nothing gets deleted,
          // so this one waits for the observation and records it here.
          `[process tree ${describeResidualProcessTree(await validationResult.residualProcessGroup)}]`,
        ].filter((part) => part.length > 0).join("\n"), credentialValue);
        const validationLogPath = join(runDirectory, `apply-validation-${commandIndex + 1}.log`);
        // Bookkeeping: a log that will not land must not become a verdict on the
        // user's patch, so it is disclosed as a note and the loop continues.
        try {
          await writeFile(validationLogPath, validationLog, { encoding: "utf8", mode: 0o600 });
          validationLogPaths.push(validationLogPath);
        } catch (error) {
          applyNote = discloseWarning(
            applyNote,
            `post-apply validation log ${validationLogPath} was not written: ${failureMessage(error, credentialValue)}`,
          );
          progress(applyNote);
        }
        if (validationResult.timedOut || validationResult.aborted) {
          validationStatus = "timed_out";
          validationFailure = `post-apply validation timed out or was cancelled: ${validationCommand}; ${APPLIED_TREE_NOTE}.`;
          break;
        }
        if (validationResult.exitCode !== 0 || validationResult.outputLimitExceeded) {
          validationStatus = "failed";
          validationFailure = `post-apply validation failed with exit code ${validationResult.exitCode}: ${validationCommand}; ${APPLIED_TREE_NOTE}.`;
          break;
        }
      }
    } catch (error) {
      // `runProcess` reports a cancel that lands while a command runs as an aborted
      // result, but it *throws* `process aborted before launch` at a command it is
      // asked to start on an already-aborted signal - and the apply itself is not
      // interruptible, so a host cancel during the window right after the patch
      // lands always takes that path. Recorded as a validation outcome instead of
      // escaping as a bare shell error: the patch is on the tree and the caller
      // needs the receipt and the rollback pointer, not a lost run.
      validationStatus = approvalSignal.aborted ? "timed_out" : "failed";
      validationFailure = `post-apply validation did not complete for run ${input.runId}: ${failureMessage(error, credentialValue)}; ${APPLIED_TREE_NOTE}.`;
    }

    const applyResult: ApplyVerifiedWinnerResult = {
      schemaVersion: 1,
      runId: input.runId,
      status: validationStatus === "passed" ? "applied" : "applied_validation_failed",
      patchSha256: actualPatchSha256,
      changedFiles: effectiveChangedFiles,
      validationStatus,
      validationLogPaths,
      failure: applyNote === null ? validationFailure : discloseWarning(validationFailure, applyNote),
    };
    await writeFile(applyResultPath, `${JSON.stringify(applyResult, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    return applyResult;
  } finally {
    await releaseRepositoryLock();
  }
}

export async function rollbackVerifiedWinner(
  input: ApplyVerifiedWinnerInput,
  config: RunSettings,
): Promise<RollbackResult> {
  const runId = input.runId;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(runId)) {
    throw new Error(`invalid runId: expected a UUID v4, got ${JSON.stringify(runId)}`);
  }
  // An applied patch leaves the tree dirty by design, so only the repository
  // identity checks of inspectRepository apply here; user edits are caught by
  // the per-file hash comparison below.
  const repository = await inspectRepository(input.repositoryPath, { requireCleanWorkingTree: false });
  const stateDirectory = await canonicalStateDirectory(config.stateDirectory, repository.repositoryPath);
  const expectedRunDirectory = join(stateDirectory, "runs", runId);
  let resolvedRunDirectory: string;
  try {
    resolvedRunDirectory = await realpath(expectedRunDirectory);
  } catch {
    throw new Error(`no ${APPLY_STATE_FILE} found for run ${runId}: nothing to rollback`);
  }
  if (!isPathInside(stateDirectory, resolvedRunDirectory)) {
    throw new Error(
      `run directory escaped stateDirectory: ${expectedRunDirectory} resolved to ${resolvedRunDirectory}`,
    );
  }
  const applyStatePath = join(resolvedRunDirectory, APPLY_STATE_FILE);
  const rollbackSignal = input.signal ?? new AbortController().signal;
  const releaseRepositoryLock = await acquireRepositoryLock(stateDirectory, repository.repositoryPath);
  let interruptedRollbackWarning: string | null = null;
  let changedFiles: string[] = [];
  try {
    // Every read that decides a destructive step happens inside the lock: a
    // peer that applied or committed meanwhile must not be reverted blind.
    const applyState = await readApplyStateRecord(applyStatePath);
    if (applyState === null) {
      throw new Error(`no ${APPLY_STATE_FILE} found for run ${runId}: nothing to rollback`);
    }
    const storedManifest = JSON.parse(await readFile(join(resolvedRunDirectory, "manifest.json"), "utf8")) as {
      repositoryPath?: string;
    };
    if (storedManifest.repositoryPath !== undefined && (await realpath(storedManifest.repositoryPath)) !== repository.repositoryPath) {
      throw new Error(
        `run ${runId} belongs to ${storedManifest.repositoryPath}, not ${repository.repositoryPath}`,
      );
    }
    changedFiles = applyState.changedFiles;
    for (const changedFile of changedFiles) {
      if (isAbsolute(changedFile) || !isPathInside(repository.repositoryPath, join(repository.repositoryPath, changedFile))) {
        throw new Error(
          `run ${runId} record contains a path that escapes the repository: ${JSON.stringify(changedFile)}`,
        );
      }
    }
    // A recorded patch hash is worthless unless rollback reads it: the bytes in
    // the run directory are a separate file from the record.
    const recordedPatchPath = join(resolvedRunDirectory, "winner.patch");
    let recordedPatch: Buffer;
    try {
      recordedPatch = await readFile(recordedPatchPath);
    } catch (error) {
      throw new Error(
        `rollback refused: ${recordedPatchPath} cannot be read, so the recorded apply of run ${runId} cannot be verified`,
        { cause: error },
      );
    }
    if (createHash("sha256").update(recordedPatch).digest("hex") !== applyState.patchSha256) {
      throw new Error(
        `rollback refused: ${recordedPatchPath} no longer hashes to the patch recorded for run ${runId}`,
      );
    }
    // Whole-HEAD equality welded the undo door shut for a commit somewhere else
    // on the branch. The claim that actually matters is narrower: no commit since
    // the recorded base touches a path this revert is about to write. Scope is the
    // record *union* the verified patch bytes, so a record that under-reports
    // cannot buy a wider tolerance than its own patch; and the comparison is one
    // `-z` diff between the two revs intersected in-process, because a pathspec
    // list grows with the patch (argv ceiling) and quotes unusual names back into
    // something that never matches. Runs after the hash check for that reason.
    const headCommit = (await runGit(repository.repositoryPath, ["rev-parse", "--verify", "HEAD"])).trim();
    if (headCommit !== applyState.baseCommit) {
      const headerPaths = patchTouchedFiles(recordedPatch.toString("utf8"));
      const scope = [...new Set(headerPaths === null ? changedFiles : [...changedFiles, ...headerPaths])];
      const between = new Set((await runGit(repository.repositoryPath, [
        "diff", "--name-only", "-z", applyState.baseCommit, "HEAD",
      ])).split("\0").filter((line) => line !== ""));
      const touched = scope.filter((path) => between.has(path));
      if (headerPaths === null || scope.length === 0 || touched.length > 0) {
        throw new Error(
          `rollback refused: HEAD is ${headCommit} but run ${runId} was applied at ${applyState.baseCommit}; `
          + (touched.length > 0
            ? `those commits touch the patched paths (${touched.join(", ")}), so reverting to HEAD would destroy that work`
            : "neither the record nor the patch bytes name a path set this rollback can trust"),
        );
      }
      interruptedRollbackWarning = discloseWarning(interruptedRollbackWarning,
        `HEAD moved from ${applyState.baseCommit} to ${headCommit}, but no commit in between touches a recorded path`);
    }
    // A hash recorded at apply time is the only way to tell "the patch is
    // applied" from "the user then edited the file": porcelain status cannot.
    let revertByReverseApply = false;
    const headKnown = headKnownToChangeSet(repository.repositoryPath, changedFiles);
    if (applyState.status === "applying") {
      // `"applying"` carries no post-apply hashes, which is not licence to
      // restore HEAD over the tree: a refused apply writes nothing, so the tree
      // can still hold only the user's work. Either the recorded patch provably
      // covers the tree, or every path still matches HEAD, or rollback stops.
      revertByReverseApply = await patchReversesCleanly(
        repository.repositoryPath,
        recordedPatch,
        config.validationTimeoutMs,
        rollbackSignal,
      );
      if (!revertByReverseApply) {
        const unverifiable: string[] = [];
        const knownToHead = await headKnown();
        for (const changedFile of changedFiles) {
          if (!await pathMatchesHead(repository.repositoryPath, changedFile, knownToHead)) {
            unverifiable.push(changedFile);
          }
        }
        if (unverifiable.length > 0) {
          throw new Error(
            `rollback refused: the apply of run ${runId} was interrupted and ${unverifiable.join(", ")} matches neither the recorded patch nor HEAD, so nothing here can be reverted safely. Restore those paths yourself and roll back again; the record is kept until then. For a tracked path, \`git checkout HEAD -- <path>\` restores HEAD but discards the uncommitted edit, so copy it out first; a path only in the worktree (untracked, e.g. one the patch added) has no HEAD content to restore, so deleting it destroys whatever it holds.`,
          );
        }
      }
    } else {
      const userModified: string[] = [];
      for (const changedFile of changedFiles) {
        const appliedHash = applyState.appliedFileSha256[changedFile];
        if (appliedHash === undefined || await hashWorkingTreeFile(repository.repositoryPath, changedFile) !== appliedHash) {
          userModified.push(changedFile);
        }
      }
      if (userModified.length > 0) {
        throw new Error(
          `rollback refused: post-apply changes detected for ${userModified.join(", ")}; commit or stash them first`,
        );
      }
    }
    if (revertByReverseApply) {
      // Exact for the verified bytes, and it keeps an edit the user made
      // outside the patch's hunks instead of clobbering it with HEAD.
      await runGitApplyWithVerifiedPatch(
        repository.repositoryPath,
        recordedPatch,
        false,
        config.validationTimeoutMs,
        rollbackSignal,
        true,
      );
    } else {
      // `git checkout HEAD -- <added file>` aborts the whole command with a
      // pathspec error, so restore HEAD-known paths and delete the rest.
      const knownToHead = await headKnown();
      const restoredPaths = changedFiles.filter((changedFile) => knownToHead.has(changedFile));
      for (let offset = 0; offset < restoredPaths.length; offset += 100) {
        const batch = restoredPaths.slice(offset, offset + 100);
        await runGit(repository.repositoryPath, ["checkout", "HEAD", "--", ...batch.map(literalPathspec)]);
      }
      for (const changedFile of changedFiles) {
        if (knownToHead.has(changedFile)) {
          continue;
        }
        await rm(join(repository.repositoryPath, changedFile), { force: true });
      }
    }
    // Restoring the working tree is only half of it: an intent-to-add or staged
    // entry survives as `AD <path>`, so the index still claims the patch. Apply
    // required a clean index, therefore unstage these paths back to HEAD.
    for (let offset = 0; offset < changedFiles.length; offset += 100) {
      const batch = changedFiles.slice(offset, offset + 100);
      await runGit(repository.repositoryPath, ["reset", "--quiet", "--", ...batch.map(literalPathspec)]);
    }
    if (applyState.status === "applying") {
      interruptedRollbackWarning = discloseWarning(interruptedRollbackWarning, revertByReverseApply
        ? "the apply of this run was interrupted before it was recorded; the tree was reverted by reverse-applying the hash-verified patch"
        : "the apply of this run was interrupted before it was recorded; no recorded path differed from HEAD, so nothing had to be reverted");
    }
    // The tree is back, so a handle that refuses to be deleted (Windows EPERM on
    // a path another process still holds) must not error a completed rollback,
    // skip the result receipt, and leave the next apply blocked on it.
    for (const [label, path] of [["apply-state", applyStatePath], ["apply-result", join(resolvedRunDirectory, APPLY_RESULT_FILE)]] as const) {
      try {
        await rm(path, { force: true });
      } catch (error) {
        interruptedRollbackWarning = discloseWarning(interruptedRollbackWarning,
          `${label} could not be removed even though the tree was restored: ${failureMessage(error, "")}`);
      }
    }
    // Reverse-apply restores the blob bytes, which under core.autocrlf are LF
    // while the working tree was CRLF: the revert is correct yet `git status`
    // still reports the path as modified. Disclose rather than let the receipt
    // claim a clean tree it did not deliver — and an unreadable status is
    // disclosed too, never read as "clean" and never allowed to error a rollback
    // whose tree is already back (an IDE holding .git/index.lock is routine).
    let dirtyAfter: string;
    try {
      dirtyAfter = (await runGit(repository.repositoryPath, ["status", "--porcelain"])).trim();
    } catch (error) {
      dirtyAfter = "";
      interruptedRollbackWarning = discloseWarning(interruptedRollbackWarning,
        `post-rollback working-tree status unreadable: ${failureMessage(error, "")}`);
    }
    if (dirtyAfter !== "") {
      interruptedRollbackWarning = discloseWarning(interruptedRollbackWarning,
        `the working tree is not clean after rollback: ${dirtyAfter.split(/\r?\n/).join(" ")}`);
    }
    const rollbackResult: RollbackResult = {
      schemaVersion: 1,
      runId,
      status: "rolled_back",
      changedFiles,
      failure: interruptedRollbackWarning,
    };
    // Still inside the repository lock on purpose: the re-apply guard compares
    // this receipt's mtime against the handle's, so a peer that takes the lock
    // in the gap before the write can land its own handle and then read as
    // "predates the rollback". A receipt that will not write is disclosed, not
    // thrown: the tree is already back, and an operator retrying here would
    // otherwise be told "nothing to rollback" about a run that was reverted.
    try {
      await writeFile(
        join(resolvedRunDirectory, ROLLBACK_RESULT_FILE),
        JSON.stringify(rollbackResult, null, 2),
        { encoding: "utf8", mode: 0o600 },
      );
      return rollbackResult;
    } catch (error) {
      const note = `rollback-result.json could not be written: ${failureMessage(error, "")}`;
      progress(note);
      return { ...rollbackResult, failure: discloseWarning(rollbackResult.failure, note) };
    }
  } finally {
    await releaseRepositoryLock();
  }
}

export interface SelectVerifiedCandidateInput {
  readonly runId: string;
  readonly repositoryPath: string;
  readonly candidateId: string;
  readonly reason: string;
  /** Filled by the host from the calling agent, never trusted from model output. */
  readonly sessionId?: string;
}

/**
 * Record an explicit parent-agent selection for a run in review_pending.
 * Writing selection.json is the only way a review_pending run becomes
 * applicable; the record keeps the reason and the host-filled session id as
 * the audit trail. Re-selecting overwrites the record until apply.
 */
export async function selectVerifiedCandidate(
  input: SelectVerifiedCandidateInput,
  config: RunSettings,
): Promise<SelectVerifiedCandidateResult> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(input.runId)) {
    throw new Error(`invalid runId: expected a UUID v4, got ${JSON.stringify(input.runId)}`);
  }
  if (input.candidateId.trim().length === 0) {
    throw new Error("candidateId is required");
  }
  const reason = input.reason.trim();
  if (reason.length === 0) {
    throw new Error("a non-empty reason is required for an explicit selection");
  }
  // Selecting writes `selection.json` and touches no tracked file, so a user who
  // kept coding after the review_pending run must still be able to record the
  // choice; apply is where a clean tree is required.
  const repository = await inspectRepository(input.repositoryPath, { requireCleanWorkingTree: false });
  const stateDirectory = await canonicalStateDirectory(config.stateDirectory, repository.repositoryPath);
  const requestedRunDirectory = join(stateDirectory, "runs", input.runId);
  const runDirectory = await realpath(requestedRunDirectory);
  if (!isPathInside(stateDirectory, runDirectory)) {
    throw new Error(
      `run directory escaped stateDirectory: ${requestedRunDirectory} resolved to ${runDirectory}`,
    );
  }
  // Read and write are one critical section: a selection landing between apply's
  // guard reads and its mutation would leave the tree and the record disagreeing.
  const releaseRepositoryLock = await acquireRepositoryLock(stateDirectory, repository.repositoryPath);
  try {
    const manifestPath = join(runDirectory, "manifest.json");
    const manifestRaw = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    if (manifestRaw.schemaVersion !== 2) {
      throw new Error("select_verified_candidate requires a schemaVersion 2 run manifest");
    }
    const result = manifestRaw.result as Record<string, unknown> | undefined;
    if (result === undefined || typeof result !== "object" || Array.isArray(result)) {
      throw new Error(`run ${input.runId} manifest has no result record`);
    }
    if (result.status !== "review_pending") {
      throw new Error(
        `run ${input.runId} is not awaiting a selection; status is ${JSON.stringify(result.status)}`,
      );
    }
    const candidateRuns = (manifestRaw.candidateRuns ?? []) as Array<Record<string, unknown>>;
    const target = candidateRuns.find((entry) => entry.candidateId === input.candidateId);
    if (target === undefined) {
      throw new Error(`candidate ${JSON.stringify(input.candidateId)} is not part of run ${input.runId}`);
    }
    if (target.executionStatus !== "completed" || target.validationStatus !== "passed") {
      throw new Error(
        `candidate ${JSON.stringify(input.candidateId)} is not eligible (execution ${JSON.stringify(target.executionStatus)}, validation ${JSON.stringify(target.validationStatus)})`,
      );
    }
    const selectedAt = new Date().toISOString();
    const record = {
      schemaVersion: 2,
      runId: input.runId,
      candidateId: input.candidateId,
      reason,
      status: "selected",
      selectedAt,
      sessionId: input.sessionId ?? null,
    };
    await writeFile(join(runDirectory, "selection.json"), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    return {
      schemaVersion: 2,
      runId: input.runId,
      candidateId: input.candidateId,
      reason,
      status: "selected",
      selectedAt,
      sessionId: input.sessionId ?? null,
    };
  } finally {
    await releaseRepositoryLock();
  }
}
