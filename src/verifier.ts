import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { JsonValue, VerifierRequest, VerifierResponse } from "./contracts.ts";
import type { RuntimeConfig } from "./config.ts";
import { remainingMs } from "./core.ts";
import {
  buildVerifierEnvironment,
  proxySensitiveValues,
  redactSensitiveJsonValue,
  redactSensitiveValues,
  runProcess,
} from "./process.ts";

interface VerifierRunnerOptions {
  readonly config: RuntimeConfig;
  readonly credentialValue: string;
  readonly uvExecutable?: string;
}

function expectObject(value: unknown, fieldName: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw verifierResponseInvalid(`${fieldName} must be an object`);
  }
  return value as Record<string, unknown>;
}

function expectInteger(value: unknown, fieldName: string): number {
  if (!Number.isInteger(value)) {
    throw verifierResponseInvalid(`${fieldName} must be an integer`);
  }
  return value as number;
}

function expectNonNegativeInteger(value: unknown, fieldName: string): number {
  const integerValue = expectInteger(value, fieldName);
  if (integerValue < 0) {
    throw verifierResponseInvalid(`${fieldName} must be non-negative`);
  }
  return integerValue;
}

function expectNumberArray(value: unknown, fieldName: string): number[] {
  if (!Array.isArray(value) || value.some((item) => !Number.isFinite(item))) {
    throw verifierResponseInvalid(`${fieldName} must contain finite numbers`);
  }
  return value as number[];
}

function expectIntegerArray(value: unknown, fieldName: string): number[] {
  if (!Array.isArray(value) || value.some((item) => !Number.isInteger(item))) {
    throw verifierResponseInvalid(`${fieldName} must contain integers`);
  }
  return value as number[];
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).every(isJsonValue);
  }
  return false;
}

function verifierResponseInvalid(reason: string): Error {
  return new Error(`verifier_response_invalid: ${reason}`);
}

export function parseVerifierResponse(
  rawOutput: string,
  sensitiveValues: readonly string[],
): VerifierResponse {
  let parsedOutput: unknown;
  try {
    parsedOutput = JSON.parse(rawOutput);
  } catch (error) {
    throw new Error("verifier_response_invalid: response is not valid JSON", { cause: error });
  }
  const response = expectObject(parsedOutput, "verifier response");
  const tokenUsage = response.tokenUsage;
  if (!isJsonValue(tokenUsage)) {
    throw verifierResponseInvalid("tokenUsage must be JSON-safe");
  }
  return {
    winnerIndex: expectInteger(response.winnerIndex, "winnerIndex"),
    scores: expectNumberArray(response.scores, "scores"),
    ranking: expectIntegerArray(response.ranking, "ranking"),
    requestCount: expectNonNegativeInteger(response.requestCount, "requestCount"),
    tokenUsage: redactSensitiveJsonValue(tokenUsage, sensitiveValues) as JsonValue,
  };
}

function verifierTimeoutMs(request: VerifierRequest): number {
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0) {
    throw new Error(
      `invalid verifier timeoutMs: expected a positive safe integer, got ${JSON.stringify(request.timeoutMs)}`,
    );
  }
  return Math.min(request.timeoutMs, remainingMs(request.deadlineAt, Date.now()));
}

function validateBridgeResponse(
  rawOutput: string,
  sensitiveValues: readonly string[],
  candidateCount: number,
): VerifierResponse {
  let response: VerifierResponse;
  try {
    response = parseVerifierResponse(rawOutput, sensitiveValues);
  } catch (error) {
    const message = error instanceof Error ? error.message : "response validation failed";
    const reason = message.startsWith("verifier_response_invalid: ")
      ? message.slice("verifier_response_invalid: ".length)
      : "response validation failed";
    throw new Error(`verifier_bridge_response_invalid: ${reason}`, { cause: error });
  }
  if (response.scores.length !== candidateCount) {
    throw new Error(
      `verifier_bridge_response_invalid: scores length must equal candidate count ${candidateCount}`,
    );
  }
  if (response.ranking.length !== candidateCount) {
    throw new Error(
      `verifier_bridge_response_invalid: ranking length must equal candidate count ${candidateCount}`,
    );
  }
  return response;
}

function cacheCleanupFailure(executionError: unknown, cleanupError: unknown): Error {
  const cleanupMessage = "verifier_cache_cleanup_failed: cache removal failed";
  if (executionError instanceof Error) {
    return new Error(`${executionError.message}; ${cleanupMessage}`, {
      cause: new AggregateError([executionError, cleanupError]),
    });
  }
  return new Error(cleanupMessage, { cause: cleanupError });
}

export async function runPythonVerifier(
  request: VerifierRequest,
  options: VerifierRunnerOptions,
): Promise<VerifierResponse> {
  const timeoutMs = verifierTimeoutMs(request);
  const sensitiveValues = [
    options.credentialValue,
    ...proxySensitiveValues(process.env),
  ];
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const pythonProjectPath = join(packageRoot, "python");
  const bridgePath = join(pythonProjectPath, "verifier_bridge.py");
  const verifierEnvironment = buildVerifierEnvironment(process.env, {
    credentialName: options.config.credentialRef,
    credentialValue: options.credentialValue,
    effort: options.config.verifierEffort,
    maxTokens: options.config.verifierMaxTokens,
  });
  let executionError: unknown;
  try {
    const bridgeResult = await runProcess({
      executable: options.uvExecutable ?? "uv",
      arguments: [
        "run",
        "--frozen",
        "--project",
        pythonProjectPath,
        "python",
        bridgePath,
      ],
      cwd: pythonProjectPath,
      env: verifierEnvironment,
      timeoutMs,
      signal: request.signal,
      input: JSON.stringify({
        task: request.task,
        candidates: request.candidates,
        pivots: request.pivots,
        model: request.model,
        nEvaluations: request.nEvaluations,
        maxWorkers: request.maxWorkers,
        cachePath: request.cachePath,
      }),
    });
    const standardError = redactSensitiveValues(bridgeResult.stderr, sensitiveValues).trim();
    if (bridgeResult.residualProcessGroupDetected) {
      throw new Error(
        bridgeResult.residualProcessGroupRemaining
          ? "verifier_bridge_residual_process: process group remains after SIGKILL"
          : "verifier_bridge_residual_process: residual process group was force-terminated",
      );
    }
    if (
      bridgeResult.exitCode !== 0
      || bridgeResult.timedOut
      || bridgeResult.aborted
      || bridgeResult.outputLimitExceeded
    ) {
      throw new Error(
        `verifier bridge failed with exit code ${bridgeResult.exitCode}: ${standardError || "no diagnostic output"}`,
      );
    }
    return {
      ...validateBridgeResponse(
        bridgeResult.stdout.trim(),
        sensitiveValues,
        request.candidates.length,
      ),
      diagnostics: standardError,
    };
  } catch (error) {
    executionError = error;
    throw error;
  } finally {
    try {
      await rm(request.cachePath, { force: true });
    } catch (cleanupError) {
      throw cacheCleanupFailure(executionError, cleanupError);
    }
  }
}
