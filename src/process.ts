import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
/** Ceiling on any single body this layer buffers from something it does not control. */
export const MAX_PROCESS_OUTPUT_BYTES = 16 * 1024 * 1024;
const FORCE_KILL_DELAY_MS = 1_000;
const STDIO_DRAIN_GRACE_MS = 250;
// Measured on this desktop (powershell.exe cold start ~4.9s included): the
// unprojected query takes 4.9-14.4s and can even reach 75s, because CIM hydrates
// every property of ~800 processes including CommandLine and ExecutablePath.
// Projecting to the three columns actually used takes 2.2-2.6s, so this cap now
// means what it says; a budget below the cold start would answer nothing and
// degrade every probe to `unknown`.
const WINDOWS_PROCESS_ROWS_TIMEOUT_MS = 10_000;
const IS_WINDOWS = process.platform === "win32";

/** `pid,ppid,name` for every live process; Windows keeps the creator link of an
 * orphan, so a dead root still lists the children it spawned. */
const WINDOWS_PROCESS_ROWS_QUERY =
  "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name | ForEach-Object { \"$($_.ProcessId),$($_.ParentProcessId),$($_.Name)\" }";

// Console infrastructure, not candidate work: Windows starts a conhost per
// console process and retires it asynchronously after the root exits, so it
// shows up as a live descendant of a command that has already finished.
const WINDOWS_CONSOLE_HOST = /^(?:conhost|openconsole)\.exe$/iu;

export interface ProcessRequest {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly input?: string | Buffer;
  /** Windows: enumerate and kill the process tree this child leaves behind.
   * Costs one CIM query (~1s), so only runs that launch untrusted commands set it. */
  readonly detectResidualTree?: boolean;
}

export interface ResidualProcessTree {
  readonly detected: boolean;
  readonly remaining: boolean;
  /** The leftover tree could not be enumerated, so neither clean nor surviving. */
  readonly unknown: boolean;
}

export interface ProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly outputLimitExceeded: boolean;
  /** The direct launch of `executable` failed with ENOENT and this child is the
   * `cmd.exe` retry: cmd answered "is not recognized", which says the harness
   * binary is missing, not that the model behind it failed. */
  readonly usedCommandResolution: boolean;
  /** Observation of what the child left behind, handed over unresolved on
   * purpose: a full process-table walk costs seconds (a degraded WMI burns the
   * whole budget), and awaiting it inside the run put that cost on the stage's
   * clock until the run timeout started erasing already-validated winners.
   * Await it before anything destructive reads the answer. Never rejects. */
  readonly residualProcessGroup: Promise<ResidualProcessTree>;
}

/** The error a rejected `runProcess` throws, when a child actually ran and left
 * something behind: it carries the same observation the resolved result would
 * have, so the caller's `catch` can register it. Without it the surviving
 * grandchild's worktree is deleted out from under the process. */
export interface ProcessRejection extends Error {
  readonly residualProcessGroup: Promise<ResidualProcessTree>;
}

/** Whether a `runProcess` rejection carries an observation worth registering. */
export function isProcessRejection(error: unknown): error is ProcessRejection {
  return error instanceof Error && "residualProcessGroup" in error;
}

function killProcessGroup(processId: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-processId, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw error;
    }
  }
}

function processGroupExists(processId: number): boolean {
  try {
    process.kill(-processId, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }
    // EPERM: the group is alive, we are just not allowed to signal it. Treating
    // that as "does not exist" would report a live process group as reaped.
    return true;
  }
}

function taskKillTree(processId: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const killer = spawn("taskkill", ["/pid", String(processId), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.once("close", () => resolve());
    killer.once("error", () => resolve());
  });
}

/**
 * `pid,ppid,name` rows, or null when the walk could not run. An empty list is a
 * real answer ("nothing is alive under this root"); a missing PowerShell is
 * not, and reporting it as one is what turned residual detection back off
 * silently on any host where the query fails.
 */
async function windowsProcessRows(): Promise<Array<readonly [number, number, string]> | null> {
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_PROCESS_ROWS_QUERY],
      { maxBuffer: 8 * 1024 * 1024, timeout: WINDOWS_PROCESS_ROWS_TIMEOUT_MS, windowsHide: true },
    );
    const rows: Array<readonly [number, number, string]> = [];
    for (const line of stdout.split(/\r?\n/u)) {
      const match = /^(\d+),(\d+),(.+)$/u.exec(line.trim());
      if (match !== null) {
        rows.push([Number(match[1]), Number(match[2]), String(match[3])]);
      }
    }
    return rows;
  } catch {
    // A missing or hung PowerShell must not wedge the run, but it must not be
    // mistaken for a clean tree either.
    return null;
  }
}

function windowsDescendantPids(rows: ReadonlyArray<readonly [number, number, string]>, rootPid: number): number[] {
  const childrenOf = new Map<number, number[]>();
  for (const [processId, parentProcessId, name] of rows) {
    if (WINDOWS_CONSOLE_HOST.test(name)) {
      continue;
    }
    const siblings = childrenOf.get(parentProcessId);
    if (siblings === undefined) {
      childrenOf.set(parentProcessId, [processId]);
    } else {
      siblings.push(processId);
    }
  }
  const descendants: number[] = [];
  const seen = new Set<number>([rootPid]);
  let frontier = [rootPid];
  while (frontier.length > 0) {
    const nextFrontier: number[] = [];
    for (const parentProcessId of frontier) {
      for (const processId of childrenOf.get(parentProcessId) ?? []) {
        if (seen.has(processId)) {
          continue;
        }
        seen.add(processId);
        descendants.push(processId);
        nextFrontier.push(processId);
      }
    }
    frontier = nextFrontier;
  }
  return descendants;
}

async function terminateWindowsDescendantTree(
  rootPid: number,
  descendantPids: readonly number[],
): Promise<{
  readonly detected: boolean;
  readonly remaining: boolean;
  readonly unknown: boolean;
}> {
  await new Promise<void>((resolve) => {
    const killer = spawn(
      "taskkill",
      ["/F", ...descendantPids.flatMap((processId) => ["/pid", String(processId)])],
      { stdio: "ignore", windowsHide: true },
    );
    killer.once("close", () => resolve());
    killer.once("error", () => resolve());
  });
  let survivors: number[] = [...descendantPids];
  // ponytail: 2 samples minimum to outrun a table-entry recycle; 4 cost up to
  // 4 full process-table walks per step, and a degraded WMI makes that minutes.
  for (let attempt = 0; attempt < 2 && survivors.length > 0; attempt += 1) {
    // A child that exited with its parent, or that `taskkill` just stopped, can
    // stay enumerable for a moment, and its table entry can be recycled to an
    // unrelated process. Only a pid the recomputed parent-link walk still hangs
    // under this root, across a few samples, counts as surviving SIGKILL.
    const rows = await windowsProcessRows();
    if (rows === null) {
      // The tree was real and its death is now unconfirmed: report it as
      // undeterminable rather than as verified-gone.
      return { detected: true, remaining: false, unknown: true };
    }
    const stillOurs = new Set(windowsDescendantPids(rows, rootPid));
    survivors = survivors.filter((processId) => stillOurs.has(processId));
  }
  return { detected: true, remaining: survivors.length > 0, unknown: false };
}

async function terminateResidualProcessGroup(
  processId: number,
  windowsDescendants: readonly number[] | null,
): Promise<{
  readonly detected: boolean;
  readonly remaining: boolean;
  readonly unknown: boolean;
}> {
  if (IS_WINDOWS) {
    if (windowsDescendants === null) {
      return { detected: false, remaining: false, unknown: true };
    }
    if (windowsDescendants.length === 0) {
      return { detected: false, remaining: false, unknown: false };
    }
    return terminateWindowsDescendantTree(processId, windowsDescendants);
  }
  if (!processGroupExists(processId)) {
    return { detected: false, remaining: false, unknown: false };
  }
  killProcessGroup(processId, "SIGKILL");
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  return { detected: true, remaining: processGroupExists(processId), unknown: false };
}

/** Whether `executable` names a Windows batch file, which only runs via cmd.exe.
 * The single predicate both the cmd wrapper below and the config guards use. */
export function isBatchFileExecutable(executable: string): boolean {
  return /\.(?:cmd|bat)$/iu.test(executable);
}

/** `cmd.exe` reinterprets these even between quotes: `"` closes the quoted
 * region, `%` expands an environment variable, and `& | ^ < >` chain, redirect
 * or escape commands. None of them has an escape on a command line (`%%` is
 * batch-file syntax only), so a value holding one cannot be carried faithfully. */
const COMMAND_UNSAFE_CHARACTERS = ["\"", "%", "&", "|", "^", "<", ">"] as const;

/** Measured on this box: a `cmd /d /s /c "<line>"` whose total line exceeds 8191 characters fails at
 * launch with "The file name or extension is too long" (exit 1) — so the value never reaches the
 * harness at all, and the run reports it as a launch failure of the harness. 8000 leaves ~190
 * characters for the executable path plus the profile/permission flags that share the line. */
const MAX_COMMAND_LINE_CHARACTERS = 8_000;

/**
 * Refuse a value that would reach an argument of a `cmd.exe` command line,
 * Windows only: POSIX `spawn` hands argv to the child verbatim.
 * ponytail: ceiling = on Windows a task holding a quote or a `%` is refused
 * rather than run, and one longer than MAX_COMMAND_LINE_CHARACTERS is refused
 * too (the `%` case is the one that matters: cmd expands
 * `%DEEPSEEK_API_KEY%` inside quotes, so an unguarded task puts the credential
 * on a command line any local process can read via WMI). Upgrade = a dsh/mcode
 * stdin prompt contract, which the portable engine already uses (`--input -`)
 * and which takes cmd.exe out of the path entirely; `dsh` has no such option
 * today, so there is nothing to move the text to.
 */
export function assertCommandSafeValue(value: string, label: string): void {
  if (!IS_WINDOWS) {
    return;
  }
  const offending = COMMAND_UNSAFE_CHARACTERS.filter((character) => value.includes(character));
  if (offending.length > 0) {
    throw new Error(
      `invalid ${label}: it contains ${offending.map((character) => JSON.stringify(character)).join(", ")}, which cmd.exe reinterprets even inside quotes (" closes the quoted region, % expands environment variables such as the credential, & | ^ < > chain, redirect or escape commands) and which has no escape on a command line; Windows launches ${label === "task" ? "the harness" : `the configured ${label}`} through cmd.exe. Remove these characters; newlines and all other characters are accepted.`,
    );
  }
  if (value.length > MAX_COMMAND_LINE_CHARACTERS) {
    throw new Error(
      `invalid ${label}: ${value.length} characters exceeds the ${MAX_COMMAND_LINE_CHARACTERS} this build allows inside a cmd.exe command line (measured: cmd refuses a line over 8191 characters with "The file name or extension is too long", so the harness is never launched and the failure would otherwise be blamed on it). Shorten it, or run the plugin on POSIX where argv is passed verbatim.`,
    );
  }
}

/** Node refuses to spawn `.cmd`/`.bat` directly (EINVAL), so a batch harness
 * always goes through `cmd.exe /d /s /c`, and `/s` strips the outer quotes of
 * the argument: everything after whitespace in the path is dropped. Operator
 * config, so it is refused where the rest of it is, not per candidate. */
export function assertBatchFileLaunchable(executable: string): void {
  if (!IS_WINDOWS || !isBatchFileExecutable(executable) || !/\s/u.test(executable)) {
    return;
  }
  throw new Error(
    `invalid dshExecutable ${JSON.stringify(executable)}: a .cmd/.bat harness runs through cmd.exe, whose /s strips the outer quotes, so only the part of the path before the first whitespace is launched and the candidate fails with cmd's own "is not recognized" error. Point dshExecutable at a path without whitespace, or at its 8.3 short-path form (dir /x).`,
  );
}

function resolveSpawnTarget(executable: string, forceCommandResolution: boolean): {
  readonly executable: string;
  readonly commandArguments: readonly string[];
} {
  if (IS_WINDOWS && (forceCommandResolution || isBatchFileExecutable(executable))) {
    // Windows spawn only appends .exe; cmd.exe applies PATHEXT and resolves
    // npm shims such as dsh.cmd.
    return {
      executable: process.env.ComSpec || "cmd.exe",
      commandArguments: ["/d", "/s", "/c", executable],
    };
  }
  return { executable, commandArguments: [] };
}

export async function runProcess(request: ProcessRequest): Promise<ProcessResult> {
  if (request.signal.aborted) {
    throw new Error(`process aborted before launch: ${request.executable}`);
  }

  try {
    return await launchProcess(request, false);
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException).code
      ?? ((error as { cause?: NodeJS.ErrnoException }).cause?.code);
    if (errorCode === "ENOENT" && IS_WINDOWS) {
      return launchProcess(request, true);
    }
    throw error;
  }
}

function launchProcess(request: ProcessRequest, forceCommandResolution: boolean): Promise<ProcessResult> {
  const spawnTarget = resolveSpawnTarget(request.executable, forceCommandResolution);
  return new Promise<ProcessResult>((resolve, reject) => {
    const childProcess = spawn(spawnTarget.executable, [...spawnTarget.commandArguments, ...request.arguments], {
      cwd: request.cwd,
      env: request.env,
      // POSIX needs detached to address the child as a process group; on
      // Windows detached hangs cmd.exe children, and taskkill /T walks the
      // parent-child tree without it.
      detached: !IS_WINDOWS,
      windowsHide: IS_WINDOWS,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let capturedOutputBytes = 0;
    let timedOut = false;
    let aborted = false;
    let outputLimitExceeded = false;
    let terminationStarted = false;
    let standardInputError: Error | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let stdioDrainTimer: NodeJS.Timeout | undefined;
    let launchFailed = false;
    let settled = false;
    let descendantProbe: Promise<readonly number[] | null> | undefined;
    let treeKill: Promise<void> | undefined;

    const terminate = (): void => {
      if (terminationStarted || childProcess.pid === undefined) {
        return;
      }
      terminationStarted = true;
      if (IS_WINDOWS) {
        // taskkill /T /F is already forceful; the settle path awaits it and then
        // walks the creator links for whatever survived, so a kill that lands
        // after this call has returned is still reported.
        treeKill = taskKillTree(childProcess.pid);
        return;
      }
      try {
        killProcessGroup(childProcess.pid, "SIGTERM");
      } catch (error) {
        stderrChunks.push(Buffer.from(`[process-group termination failed: ${(error as Error).message}]\n`));
        childProcess.kill("SIGTERM");
      }
      forceKillTimer = setTimeout(() => {
        if (childProcess.pid !== undefined) {
          try {
            killProcessGroup(childProcess.pid, "SIGKILL");
          } catch (error) {
            stderrChunks.push(Buffer.from(`[process-group force kill failed: ${(error as Error).message}]\n`));
            childProcess.kill("SIGKILL");
          }
        }
      }, FORCE_KILL_DELAY_MS);
      forceKillTimer.unref();
    };

    const captureChunk = (target: Buffer[], chunk: Buffer): void => {
      if (outputLimitExceeded) {
        return;
      }
      capturedOutputBytes += chunk.length;
      if (capturedOutputBytes > MAX_PROCESS_OUTPUT_BYTES) {
        outputLimitExceeded = true;
        terminate();
        return;
      }
      target.push(chunk);
    };
    childProcess.stdout.on("data", (chunk: Buffer) => captureChunk(stdoutChunks, chunk));
    childProcess.stderr.on("data", (chunk: Buffer) => captureChunk(stderrChunks, chunk));
    childProcess.stdin.on("error", (error) => {
      standardInputError = error;
    });
    childProcess.stdin.end(request.input ?? "");

    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, request.timeoutMs);
    timeout.unref();

    const handleAbort = (): void => {
      aborted = true;
      terminate();
    };
    request.signal.addEventListener("abort", handleAbort, { once: true });

    childProcess.once("error", (error) => {
      launchFailed = true;
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimer !== undefined) {
        clearTimeout(forceKillTimer);
      }
      if (stdioDrainTimer !== undefined) {
        clearTimeout(stdioDrainTimer);
      }
      request.signal.removeEventListener("abort", handleAbort);
      reject(new Error(`failed to launch ${request.executable}: ${error.message}`, { cause: error }));
    });
    const settle = (exitCode: number | null, exitSignal: NodeJS.Signals | null): void => {
      if (settled || launchFailed) {
        return;
      }
      settled = true;
      if (stdioDrainTimer !== undefined) {
        clearTimeout(stdioDrainTimer);
      }
      clearTimeout(timeout);
      if (forceKillTimer !== undefined) {
        clearTimeout(forceKillTimer);
      }
      request.signal.removeEventListener("abort", handleAbort);
      if (childProcess.pid === undefined) {
        reject(new Error(`process closed without a PID: ${request.executable}`));
        return;
      }
      const processId = childProcess.pid;
      // A timeout or abort skipped the exit-time probe, so its `taskkill /T /F`
      // used to stay fire-and-forget: the run resolved while the kill was still
      // running and reported `detected:false` for a tree that might not be dead.
      // The kill is awaited here, and a caller that asked for residual detection
      // also gets one post-kill walk for whatever survived it.
      // The walk is only affordable where we are already killing a tree
      // (timeout/abort). Probing on every normal exit put a full process-table
      // query on the resolve path of every spawn and starved candidate timeouts.
      const residualDescendants: Promise<readonly number[] | null> = descendantProbe !== undefined
        ? descendantProbe
        : (treeKill ?? Promise.resolve()).then(() => (IS_WINDOWS && (timedOut || aborted) && request.detectResidualTree === true
          ? windowsProcessRows().then((rows) => (rows === null ? null : windowsDescendantPids(rows, processId)))
          // `null` = not observed. Returning `[]` here would claim "verified no
          // descendants", which is the fail-open shape this whole path exists to avoid.
          : Promise.resolve(null)));
      const residualProcessGroup: Promise<ResidualProcessTree> = residualDescendants
        .then((windowsDescendants) => terminateResidualProcessGroup(processId, windowsDescendants))
        .catch(() => ({ detected: false, remaining: false, unknown: true }));
      if (standardInputError !== undefined && exitCode === 0) {
        // Hand the observation over on this path too: the child ran, so whatever
        // it left behind is exactly as real as on the resolve path.
        reject(Object.assign(new Error(
          `failed to write stdin for ${request.executable}: ${standardInputError.message}`,
          { cause: standardInputError },
        ), { residualProcessGroup }));
        return;
      }
      resolve({
        exitCode,
        signal: exitSignal,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        timedOut,
        aborted,
        outputLimitExceeded,
        usedCommandResolution: forceCommandResolution,
        residualProcessGroup,
      });
    };
    // `close` waits for stdout/stderr EOF, and a grandchild that inherited the
    // write ends can hold it open forever after the child is gone. Settle a
    // short grace after `exit` so one leaked file descriptor cannot wedge a
    // whole run past its timeout.
    childProcess.once("exit", (exitCode, exitSignal) => {
      if (IS_WINDOWS && request.detectResidualTree === true && !terminationStarted && childProcess.pid !== undefined) {
        // Probed while this child's exit is still in flight and its pid is ours
        // to name: the tree is found through the creator links of the live
        // processes, so no liveness guess about a recyclable pid is involved.
        // ponytail: a pid recycled inside the probe-to-taskkill window can be
        // named in the list; re-check the creator link per pid if that ever bites.
        const rootPid = childProcess.pid;
        descendantProbe = windowsProcessRows().then((rows) =>
          (rows === null ? null : windowsDescendantPids(rows, rootPid)));
      }
      stdioDrainTimer = setTimeout(() => {
        settle(exitCode, exitSignal);
      }, STDIO_DRAIN_GRACE_MS);
      stdioDrainTimer.unref();
    });
    childProcess.once("close", (exitCode, exitSignal) => {
      settle(exitCode, exitSignal);
    });
  });
}

const ALLOWED_ENVIRONMENT_NAMES = new Set([
  "COLORTERM",
  "FORCE_COLOR",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "NO_COLOR",
  "PATH",
  "SHELL",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
]);

// Minimum Windows set: without SystemRoot/COMSPEC/PATHEXT, spawned console
// programs, git, and Node itself fail in undocumented ways.
const ALLOWED_WINDOWS_ENVIRONMENT_NAMES = new Set([
  ...ALLOWED_ENVIRONMENT_NAMES,
  "ALLUSERSPROFILE",
  "APPDATA",
  "COMMONPROGRAMFILES",
  "COMSPEC",
  "HOMEDRIVE",
  "HOMEPATH",
  "LOCALAPPDATA",
  "PATHEXT",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "SYSTEMROOT",
  "USERPROFILE",
  "WINDIR",
]);

export function sanitizedEnvironment(
  sourceEnvironment: NodeJS.ProcessEnv,
  explicitValues: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  const allowedEnvironmentNames = IS_WINDOWS
    ? ALLOWED_WINDOWS_ENVIRONMENT_NAMES
    : ALLOWED_ENVIRONMENT_NAMES;
  const environment: NodeJS.ProcessEnv = {};
  for (const [environmentName, environmentValue] of Object.entries(sourceEnvironment)) {
    // Windows environment names are case-insensitive, and a GUI/Electron host
    // hands over `Path`/`SystemRoot`/`ComSpec`. A case-sensitive lookup would
    // drop them and every spawn would fail to resolve git or dsh. POSIX names
    // are case-sensitive, so there the lookup stays verbatim.
    const lookupName = IS_WINDOWS ? environmentName.toUpperCase() : environmentName;
    if (environmentValue !== undefined && allowedEnvironmentNames.has(lookupName)) {
      environment[environmentName] = environmentValue;
    }
  }
  return { ...environment, ...explicitValues };
}

export function redactSecret(text: string, secret: string): string {
  if (secret.length === 0) {
    // No credential is in scope (validation-only runs resolve none), so there
    // is nothing to redact.
    return text;
  }
  return text.replaceAll(secret, "[REDACTED]");
}
