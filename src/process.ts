import { spawn } from "node:child_process";

const MAX_PROCESS_OUTPUT_BYTES = 16 * 1024 * 1024;
const FORCE_KILL_DELAY_MS = 1_000;

export interface ProcessRequest {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly input?: string | Buffer;
}

export interface ProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly outputLimitExceeded: boolean;
  readonly residualProcessGroupDetected: boolean;
  readonly residualProcessGroupRemaining: boolean;
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
    throw error;
  }
}

async function terminateResidualProcessGroup(processId: number): Promise<{
  readonly detected: boolean;
  readonly remaining: boolean;
}> {
  if (!processGroupExists(processId)) {
    return { detected: false, remaining: false };
  }
  killProcessGroup(processId, "SIGKILL");
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  return { detected: true, remaining: processGroupExists(processId) };
}

export async function runProcess(request: ProcessRequest): Promise<ProcessResult> {
  if (process.platform === "win32") {
    throw new Error("dsh-llm-verifier does not support Windows process isolation");
  }
  if (request.signal.aborted) {
    throw new Error(`process aborted before launch: ${request.executable}`);
  }

  return new Promise<ProcessResult>((resolve, reject) => {
    const childProcess = spawn(request.executable, [...request.arguments], {
      cwd: request.cwd,
      env: request.env,
      detached: true,
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
    let launchFailed = false;

    const terminate = (): void => {
      if (terminationStarted || childProcess.pid === undefined) {
        return;
      }
      terminationStarted = true;
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
      clearTimeout(timeout);
      if (forceKillTimer !== undefined) {
        clearTimeout(forceKillTimer);
      }
      request.signal.removeEventListener("abort", handleAbort);
      reject(new Error(`failed to launch ${request.executable}: ${error.message}`, { cause: error }));
    });
    childProcess.once("close", (exitCode, exitSignal) => {
      if (launchFailed) {
        return;
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
      void terminateResidualProcessGroup(childProcess.pid).then((residualProcessGroup) => {
        if (standardInputError !== undefined && exitCode === 0) {
          reject(new Error(
            `failed to write stdin for ${request.executable}: ${standardInputError.message}`,
            { cause: standardInputError },
          ));
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
          residualProcessGroupDetected: residualProcessGroup.detected,
          residualProcessGroupRemaining: residualProcessGroup.remaining,
        });
      }, reject);
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

export function sanitizedEnvironment(
  sourceEnvironment: NodeJS.ProcessEnv,
  explicitValues: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [environmentName, environmentValue] of Object.entries(sourceEnvironment)) {
    if (environmentValue !== undefined && ALLOWED_ENVIRONMENT_NAMES.has(environmentName)) {
      environment[environmentName] = environmentValue;
    }
  }
  return { ...environment, ...explicitValues };
}

export function redactSecret(text: string, secret: string): string {
  if (secret.length === 0) {
    throw new Error("cannot redact an empty credential value");
  }
  return text.replaceAll(secret, "[REDACTED]");
}
