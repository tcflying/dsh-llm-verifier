import { spawn } from "node:child_process";

const MAX_PROCESS_OUTPUT_BYTES = 16 * 1024 * 1024;
const FORCE_KILL_DELAY_MS = 1_000;
const PROCESS_DRAIN_GRACE_MS = 250;

export type ProcessTerminationReason =
  | "completed"
  | "launch_failed"
  | "timeout"
  | "aborted"
  | "output_limit_exceeded"
  | "process_error";

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
  readonly stdoutBytes?: Buffer;
  readonly stderrBytes?: Buffer;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly outputLimitExceeded: boolean;
  readonly residualProcessGroupDetected: boolean;
  readonly residualProcessGroupRemaining: boolean;
  readonly terminationReason: ProcessTerminationReason;
  readonly drainCompleted: boolean;
  readonly drainTimedOut: boolean;
  readonly finishedAt: number;
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

  return new Promise<ProcessResult>((resolve) => {
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
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let terminationReason: ProcessTerminationReason | undefined;
    let terminationStarted = false;
    let finishStarted = false;
    let childExited = false;
    let standardOutputEnded = false;
    let standardErrorEnded = false;
    let resolveDrain: (() => void) | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;

    const markStandardOutputEnded = (): void => {
      standardOutputEnded = true;
      if (standardErrorEnded) {
        resolveDrain?.();
      }
    };
    const markStandardErrorEnded = (): void => {
      standardErrorEnded = true;
      if (standardOutputEnded) {
        resolveDrain?.();
      }
    };
    childProcess.stdout.once("end", markStandardOutputEnded);
    childProcess.stdout.once("close", markStandardOutputEnded);
    childProcess.stderr.once("end", markStandardErrorEnded);
    childProcess.stderr.once("close", markStandardErrorEnded);

    const waitForBoundedDrain = async (): Promise<{
      readonly completed: boolean;
      readonly timedOut: boolean;
    }> => {
      if (standardOutputEnded && standardErrorEnded) {
        return { completed: true, timedOut: false };
      }
      let drainTimedOut = false;
      await new Promise<void>((resolveDrainPromise) => {
        let drainSettled = false;
        const settleDrain = (): void => {
          if (drainSettled) {
            return;
          }
          drainSettled = true;
          clearTimeout(drainTimer);
          resolveDrain = undefined;
          resolveDrainPromise();
        };
        resolveDrain = settleDrain;
        const drainTimer = setTimeout(() => {
          drainTimedOut = true;
          childProcess.stdout.destroy();
          childProcess.stderr.destroy();
          settleDrain();
        }, PROCESS_DRAIN_GRACE_MS);
        drainTimer.unref();
        if (standardOutputEnded && standardErrorEnded) {
          settleDrain();
        }
      });
      return { completed: !drainTimedOut, timedOut: drainTimedOut };
    };

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

    const finish = (reason: ProcessTerminationReason): void => {
      terminationReason ??= reason;
      if (
        reason !== "completed"
        && reason !== "launch_failed"
        && !childExited
      ) {
        terminate();
      }
      if (finishStarted || (!childExited && reason !== "launch_failed")) {
        return;
      }
      finishStarted = true;
      if (timeoutTimer !== undefined) {
        clearTimeout(timeoutTimer);
      }
      if (forceKillTimer !== undefined) {
        clearTimeout(forceKillTimer);
      }
      request.signal.removeEventListener("abort", handleAbort);
      void (async () => {
        const drain = await waitForBoundedDrain();
        let residualProcessGroup = { detected: false, remaining: false };
        if (childProcess.pid !== undefined) {
          try {
            residualProcessGroup = await terminateResidualProcessGroup(childProcess.pid);
          } catch (error) {
            stderrChunks.push(Buffer.from(
              `[residual process-group cleanup failed: ${(error as Error).message}]\n`,
            ));
            residualProcessGroup = { detected: true, remaining: true };
          }
        }
        const stdoutBytes = Buffer.concat(stdoutChunks);
        const stderrBytes = Buffer.concat(stderrChunks);
        resolve({
          exitCode,
          signal: exitSignal,
          stdout: stdoutBytes.toString("utf8"),
          stderr: stderrBytes.toString("utf8"),
          stdoutBytes,
          stderrBytes,
          timedOut,
          aborted,
          outputLimitExceeded,
          residualProcessGroupDetected: residualProcessGroup.detected,
          residualProcessGroupRemaining: residualProcessGroup.remaining,
          terminationReason: terminationReason ?? reason,
          drainCompleted: drain.completed,
          drainTimedOut: drain.timedOut,
          finishedAt: Date.now(),
        });
      })();
    };

    const captureChunk = (target: Buffer[], chunk: Buffer): void => {
      if (outputLimitExceeded) {
        return;
      }
      capturedOutputBytes += chunk.length;
      if (capturedOutputBytes > MAX_PROCESS_OUTPUT_BYTES) {
        outputLimitExceeded = true;
        finish("output_limit_exceeded");
        return;
      }
      target.push(chunk);
    };
    childProcess.stdout.on("data", (chunk: Buffer) => captureChunk(stdoutChunks, chunk));
    childProcess.stderr.on("data", (chunk: Buffer) => captureChunk(stderrChunks, chunk));
    childProcess.stdin.on("error", (error) => {
      stderrChunks.push(Buffer.from(`[process stdin failed: ${error.message}]\n`));
      finish("process_error");
    });
    childProcess.stdin.end(request.input ?? "");

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      finish("timeout");
    }, request.timeoutMs);
    timeoutTimer.unref();

    function handleAbort(): void {
      aborted = true;
      finish("aborted");
    }
    request.signal.addEventListener("abort", handleAbort, { once: true });

    childProcess.once("error", (error) => {
      const launchFailed = childProcess.pid === undefined;
      stderrChunks.push(Buffer.from(
        `[process ${launchFailed ? "launch" : "runtime"} failed for ${request.executable}: ${error.message}]\n`,
      ));
      if (launchFailed) {
        childExited = true;
      }
      finish(launchFailed ? "launch_failed" : "process_error");
    });
    childProcess.once("exit", (observedExitCode, observedExitSignal) => {
      childExited = true;
      exitCode = observedExitCode;
      exitSignal = observedExitSignal;
      finish("completed");
    });
    childProcess.once("close", (observedExitCode, observedExitSignal) => {
      childExited = true;
      exitCode ??= observedExitCode;
      exitSignal ??= observedExitSignal;
      markStandardOutputEnded();
      markStandardErrorEnded();
      finish("completed");
    });
    if (request.signal.aborted) {
      handleAbort();
    }
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

const MINIMAL_SYSTEM_ENVIRONMENT_NAMES = [
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
] as const;
const PROXY_URL_ENVIRONMENT_NAME_PAIRS = [
  ["HTTP_PROXY", "http_proxy"],
  ["HTTPS_PROXY", "https_proxy"],
  ["ALL_PROXY", "all_proxy"],
] as const;
const NO_PROXY_ENVIRONMENT_NAMES = ["NO_PROXY", "no_proxy"] as const;
const MAX_PROXY_URL_LENGTH = 2_048;
const MAX_NO_PROXY_LENGTH = 4_096;

function copyDefinedEnvironmentValues(
  sourceEnvironment: NodeJS.ProcessEnv,
  environmentNames: readonly string[],
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const environmentName of environmentNames) {
    const environmentValue = sourceEnvironment[environmentName];
    if (environmentValue !== undefined) {
      environment[environmentName] = environmentValue;
    }
  }
  return environment;
}

function proxyError(code: string, fieldNames: readonly string[], reason: string): Error {
  return new Error(`${code}: fields=${fieldNames.join(",")}; reason=${reason}`);
}

function presentEnvironmentNames(
  sourceEnvironment: NodeJS.ProcessEnv,
  environmentNames: readonly string[],
): string[] {
  return environmentNames.filter((environmentName) => sourceEnvironment[environmentName] !== undefined);
}

function validateProxyUrl(environmentName: string, proxyUrlValue: string): void {
  if (proxyUrlValue.length > MAX_PROXY_URL_LENGTH) {
    throw proxyError("proxy_url_too_long", [environmentName], `maximum=${MAX_PROXY_URL_LENGTH}`);
  }
  if (
    proxyUrlValue.length === 0
    || proxyUrlValue.trim() !== proxyUrlValue
    || /[\u0000-\u001f\u007f]/u.test(proxyUrlValue)
  ) {
    throw proxyError("proxy_environment_invalid", [environmentName], "invalid proxy URL format");
  }
  let parsedProxyUrl: URL;
  try {
    parsedProxyUrl = new URL(proxyUrlValue);
  } catch {
    throw proxyError("proxy_environment_invalid", [environmentName], "invalid proxy URL format");
  }
  if (parsedProxyUrl.protocol !== "http:" && parsedProxyUrl.protocol !== "https:") {
    throw proxyError("proxy_protocol_invalid", [environmentName], "expected http or https");
  }
  if (parsedProxyUrl.username.length > 0 || parsedProxyUrl.password.length > 0) {
    throw proxyError("proxy_url_contains_credentials", [environmentName], "userinfo is forbidden");
  }
  if (
    parsedProxyUrl.hostname.length === 0
    || (parsedProxyUrl.pathname !== "" && parsedProxyUrl.pathname !== "/")
    || parsedProxyUrl.search.length > 0
    || parsedProxyUrl.hash.length > 0
  ) {
    throw proxyError("proxy_environment_invalid", [environmentName], "proxy URL must contain only an origin");
  }
}

function validateNoProxy(environmentName: string, noProxyValue: string): void {
  if (
    noProxyValue.length > MAX_NO_PROXY_LENGTH
    || /[\u0000-\u001f\u007f\s]/u.test(noProxyValue)
    || noProxyValue.includes("://")
    || noProxyValue.includes("@")
  ) {
    throw proxyError(
      "proxy_environment_invalid",
      [environmentName],
      `invalid NO_PROXY format or length greater than ${MAX_NO_PROXY_LENGTH}`,
    );
  }
}

export function validateProxyEnvironment(
  sourceEnvironment: NodeJS.ProcessEnv,
): Readonly<Record<string, string>> {
  const validatedProxyEnvironment: Record<string, string> = {};
  for (const environmentNamePair of PROXY_URL_ENVIRONMENT_NAME_PAIRS) {
    const presentNames = presentEnvironmentNames(sourceEnvironment, environmentNamePair);
    if (presentNames.length > 1) {
      throw proxyError("proxy_environment_conflict", presentNames, "uppercase and lowercase forms coexist");
    }
    const environmentName = presentNames[0];
    if (environmentName === undefined) {
      continue;
    }
    const proxyUrlValue = sourceEnvironment[environmentName];
    if (proxyUrlValue === undefined) {
      continue;
    }
    validateProxyUrl(environmentName, proxyUrlValue);
    validatedProxyEnvironment[environmentName] = proxyUrlValue;
  }

  const presentNoProxyNames = presentEnvironmentNames(
    sourceEnvironment,
    NO_PROXY_ENVIRONMENT_NAMES,
  );
  if (presentNoProxyNames.length > 1) {
    throw proxyError(
      "proxy_environment_conflict",
      presentNoProxyNames,
      "uppercase and lowercase forms coexist",
    );
  }
  const noProxyEnvironmentName = presentNoProxyNames[0];
  if (noProxyEnvironmentName !== undefined) {
    const noProxyValue = sourceEnvironment[noProxyEnvironmentName];
    if (noProxyValue !== undefined) {
      validateNoProxy(noProxyEnvironmentName, noProxyValue);
      validatedProxyEnvironment[noProxyEnvironmentName] = noProxyValue;
    }
  }

  const nodeUseEnvProxyValue = sourceEnvironment.NODE_USE_ENV_PROXY;
  if (nodeUseEnvProxyValue !== undefined) {
    if (nodeUseEnvProxyValue !== "1") {
      throw proxyError(
        "proxy_environment_invalid",
        ["NODE_USE_ENV_PROXY"],
        "expected the exact value 1",
      );
    }
    validatedProxyEnvironment.NODE_USE_ENV_PROXY = nodeUseEnvProxyValue;
  }
  return validatedProxyEnvironment;
}

export function proxySensitiveValues(sourceEnvironment: NodeJS.ProcessEnv): string[] {
  const validatedProxyEnvironment = validateProxyEnvironment(sourceEnvironment);
  const sensitiveValues = new Set<string>();
  for (const [environmentName, environmentValue] of Object.entries(validatedProxyEnvironment)) {
    if (environmentName === "NODE_USE_ENV_PROXY" || environmentValue.length === 0) {
      continue;
    }
    sensitiveValues.add(environmentValue);
    if (environmentName.toUpperCase() !== "NO_PROXY") {
      sensitiveValues.add(new URL(environmentValue).origin);
    }
  }
  return [...sensitiveValues].sort((left, right) => right.length - left.length);
}

export function redactSensitiveValues(
  text: string,
  sensitiveValues: readonly string[],
): string {
  const uniqueSensitiveValues = [...new Set(sensitiveValues)]
    .filter((sensitiveValue) => sensitiveValue.length > 0)
    .sort((left, right) => right.length - left.length);
  let redactedText = text;
  for (const sensitiveValue of uniqueSensitiveValues) {
    redactedText = redactedText.replaceAll(sensitiveValue, "[REDACTED]");
  }
  return redactedText;
}

export function redactSensitiveJsonValue(
  value: unknown,
  sensitiveValues: readonly string[],
): unknown {
  if (typeof value === "string") {
    return redactSensitiveValues(value, sensitiveValues);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveJsonValue(item, sensitiveValues));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(
      ([fieldName, fieldValue]) => [
        redactSensitiveValues(fieldName, sensitiveValues),
        redactSensitiveJsonValue(fieldValue, sensitiveValues),
      ],
    ));
  }
  return value;
}

function validateCredential(credentialName: string, credentialValue: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(credentialName)) {
    throw new Error(`environment_credential_name_invalid: field=${credentialName}`);
  }
  if (credentialValue.length === 0) {
    throw new Error(`environment_credential_value_invalid: field=${credentialName}; reason=empty`);
  }
}

export function buildCandidateEnvironment(
  sourceEnvironment: NodeJS.ProcessEnv,
  credentialName: string,
  credentialValue: string,
): Record<string, string> {
  validateCredential(credentialName, credentialValue);
  return {
    ...copyDefinedEnvironmentValues(sourceEnvironment, MINIMAL_SYSTEM_ENVIRONMENT_NAMES),
    ...validateProxyEnvironment(sourceEnvironment),
    [credentialName]: credentialValue,
    HOME: "/home",
    DSH_HOME: "/dsh-home",
    TMPDIR: "/tmp",
    DSH_PERMISSION_MODE: "workspace-write",
  };
}

export interface VerifierEnvironmentValues {
  readonly credentialName: string;
  readonly credentialValue: string;
  readonly effort: string;
  readonly maxTokens: number;
}

export function buildVerifierEnvironment(
  sourceEnvironment: NodeJS.ProcessEnv,
  values: VerifierEnvironmentValues,
): Record<string, string> {
  validateCredential(values.credentialName, values.credentialValue);
  if (!Number.isSafeInteger(values.maxTokens) || values.maxTokens <= 0) {
    throw new Error(`verifier_environment_max_tokens_invalid: got=${JSON.stringify(values.maxTokens)}`);
  }
  return {
    ...copyDefinedEnvironmentValues(sourceEnvironment, MINIMAL_SYSTEM_ENVIRONMENT_NAMES),
    ...validateProxyEnvironment(sourceEnvironment),
    [values.credentialName]: values.credentialValue,
    DEEPSEEK_EFFORT: values.effort,
    DEEPSEEK_MAX_TOKENS: String(values.maxTokens),
    PYTHONUNBUFFERED: "1",
  };
}

export function buildValidationEnvironment(
  sourceEnvironment: NodeJS.ProcessEnv,
): Record<string, string> {
  return {
    ...copyDefinedEnvironmentValues(sourceEnvironment, MINIMAL_SYSTEM_ENVIRONMENT_NAMES),
    HOME: "/home",
    DSH_HOME: "/dsh-home",
    TMPDIR: "/tmp",
  };
}

export function buildGitEnvironment(
  sourceEnvironment: NodeJS.ProcessEnv,
): Record<string, string> {
  return {
    ...copyDefinedEnvironmentValues(sourceEnvironment, MINIMAL_SYSTEM_ENVIRONMENT_NAMES),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    PAGER: "cat",
  };
}

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
  return redactSensitiveValues(text, [secret]);
}
