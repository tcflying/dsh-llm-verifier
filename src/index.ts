import type { Context } from "@deepseek-ai/cordis";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { ApprovalOutcome } from "@deepseek-ai/dsh-user-approval";
import z from "@deepseek-ai/schemastery";
import { homedir } from "node:os";
import { join } from "node:path";

import type { CandidateCount, RuntimeConfig } from "./config.ts";
import { applyVerifiedWinner, rollbackVerifiedWinner, runVerifiedBestOf } from "./core.ts";
import { runPythonVerifier } from "./verifier.ts";

export const name = "llm-verifier";
export const inject = ["tools", "approval", "credentials"];
const DEEPSEEK_MODEL_NAME = /^deepseek-[A-Za-z0-9][A-Za-z0-9._-]*$/u;

export interface Config {
  readonly defaultCandidateCount?: CandidateCount;
  readonly candidateProfile?: string;
  readonly credentialRef?: string;
  readonly verifierModel?: string;
  readonly nEvaluations?: number;
  readonly maxVerifierWorkers?: number;
  readonly verifierEffort?: "low" | "high" | "max";
  readonly verifierMaxTokens?: number;
  readonly candidateTimeoutMs?: number;
  readonly validationTimeoutMs?: number;
  readonly runTimeoutMs?: number;
  readonly maxVerifierTraceBytes?: number;
  readonly stateDirectory?: string;
}

export const Config = z.object({
  defaultCandidateCount: z.union([z.const(3), z.const(5)]).default(3),
  candidateProfile: z.string().default("headless"),
  credentialRef: z.string().default("DEEPSEEK_API_KEY"),
  verifierModel: z.string().default("deepseek-v4-flash"),
  nEvaluations: z.natural().min(1).max(4).default(2),
  maxVerifierWorkers: z.natural().min(1).max(16).default(8),
  verifierEffort: z.union([
    z.const("low"),
    z.const("high"),
    z.const("max"),
  ]).default("high"),
  verifierMaxTokens: z.natural().min(1).default(32_768),
  candidateTimeoutMs: z.natural().min(1).default(20 * 60 * 1_000),
  validationTimeoutMs: z.natural().min(1).default(10 * 60 * 1_000),
  runTimeoutMs: z.natural().min(1).default(45 * 60 * 1_000),
  maxVerifierTraceBytes: z.natural().min(1).default(512 * 1_024),
  stateDirectory: z.string().default("$DSH_HOME/llm-verifier"),
});

function expandStateDirectory(configuredStateDirectory: string, dshHomeDirectory: string): string {
  if (configuredStateDirectory === "$DSH_HOME") {
    return dshHomeDirectory;
  }
  if (configuredStateDirectory.startsWith("$DSH_HOME/")) {
    return join(dshHomeDirectory, configuredStateDirectory.slice("$DSH_HOME/".length));
  }
  return configuredStateDirectory;
}

function resolvePluginConfig(config: Config): {
  readonly defaultCandidateCount: CandidateCount;
  readonly runtimeConfig: RuntimeConfig;
} {
  const dshHomeDirectory = process.env.DSH_HOME ?? join(homedir(), ".dsh");
  const candidateProfile = (config.candidateProfile ?? "headless").trim();
  const configuredCredentialRef = (config.credentialRef ?? "DEEPSEEK_API_KEY").trim();
  const verifierModel = (config.verifierModel ?? "deepseek-v4-flash").trim();
  if (candidateProfile.length === 0) {
    throw new Error(`invalid candidateProfile: got ${JSON.stringify(config.candidateProfile)}`);
  }
  if (configuredCredentialRef.length === 0) {
    throw new Error(`invalid credentialRef: got ${JSON.stringify(config.credentialRef)}`);
  }
  if (!DEEPSEEK_MODEL_NAME.test(verifierModel)) {
    throw new Error(
      `invalid verifierModel: expected a DeepSeek model name beginning with "deepseek-", got ${JSON.stringify(config.verifierModel)}`,
    );
  }
  return {
    defaultCandidateCount: config.defaultCandidateCount ?? 3,
    runtimeConfig: {
      candidateProfile,
      credentialRef: configuredCredentialRef,
      verifierModel,
      nEvaluations: config.nEvaluations ?? 2,
      maxVerifierWorkers: config.maxVerifierWorkers ?? 8,
      verifierEffort: config.verifierEffort ?? "high",
      verifierMaxTokens: config.verifierMaxTokens ?? 32_768,
      candidateTimeoutMs: config.candidateTimeoutMs ?? 20 * 60 * 1_000,
      validationTimeoutMs: config.validationTimeoutMs ?? 10 * 60 * 1_000,
      runTimeoutMs: config.runTimeoutMs ?? 45 * 60 * 1_000,
      maxVerifierTraceBytes: config.maxVerifierTraceBytes ?? 512 * 1_024,
      stateDirectory: expandStateDirectory(
        config.stateDirectory ?? "$DSH_HOME/llm-verifier",
        dshHomeDirectory,
      ),
      dshExecutable: "dsh",
      dshHomeDirectory,
    },
  };
}

const candidateOutputProperties = {
  candidateId: { type: "string", required: true },
  executionStatus: {
    type: "string",
    enum: ["cancelled", "completed", "failed", "timed_out"],
    required: true,
  },
  validationStatus: {
    type: "string",
    enum: ["failed", "not_run", "passed", "timed_out"],
    required: true,
  },
  score: {
    oneOf: [{ type: "number" }, { type: "null" }],
    required: true,
  },
  changedFiles: {
    type: "array",
    items: { type: "string" },
    required: true,
  },
  failure: {
    oneOf: [{ type: "string" }, { type: "null" }],
    required: true,
  },
} as const;

const verifiedBestOfOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    schemaVersion: { type: "integer", const: 1, required: true },
    runId: { type: "string", required: true },
    baseCommit: { type: "string", required: true },
    requestedCandidateCount: { type: "integer", enum: [3, 5], required: true },
    completedCandidateCount: { type: "integer", required: true },
    eligibleCandidateCount: { type: "integer", required: true },
    status: {
      type: "string",
      enum: ["failed", "no_winner", "winner_selected"],
      required: true,
    },
    selectionMethod: {
      oneOf: [
        { type: "string", enum: ["llm_verifier", "validation_only", "parent_agent_review"] },
        { type: "null" },
      ],
      required: true,
    },
    winnerId: {
      oneOf: [{ type: "string" }, { type: "null" }],
      required: true,
    },
    ranking: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { ...candidateOutputProperties, diffStat: { type: "string" }, durationMs: { type: "integer" } },
      },
      required: true,
    },
    tokenUsage: { type: "json", required: true },
    verifierRequestCount: { type: "integer", required: true },
    reportPath: { type: "string", required: true },
    winnerPatchPath: {
      oneOf: [{ type: "string" }, { type: "null" }],
      required: true,
    },
    failure: {
      oneOf: [{ type: "string" }, { type: "null" }],
      required: true,
    },
  },
} as const;

const applyWinnerOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    schemaVersion: { type: "integer", const: 1, required: true },
    runId: { type: "string", required: true },
    status: {
      type: "string",
      enum: ["applied", "applied_validation_failed"],
      required: true,
    },
    patchSha256: { type: "string", required: true },
    changedFiles: { type: "array", items: { type: "string" }, required: true },
    validationStatus: {
      type: "string",
      enum: ["failed", "passed", "timed_out"],
      required: true,
    },
    validationLogPaths: { type: "array", items: { type: "string" }, required: true },
    failure: {
      oneOf: [{ type: "string" }, { type: "null" }],
      required: true,
    },
  },
} as const;

function requireAllowedApproval(outcome: ApprovalOutcome, toolName: string): void {
  if (outcome !== "allowed-once") {
    throw new Error(`${toolName} approval was not granted: ${outcome}`);
  }
}

export function apply(ctx: Context, config: Config = {}): void {
  const { defaultCandidateCount, runtimeConfig } = resolvePluginConfig(config);

  ctx.tools.register(defineTool({
    name: "verified_best_of",
    description: "Run 3 or 5 isolated coding candidates, test them, and select a verified patch without changing the current repository.",
    parameters: {
      task: {
        type: "string",
        required: true,
        description: "The coding task every isolated candidate must implement.",
      },
      candidateCount: {
        type: "integer",
        enum: [3, 5],
        default: defaultCandidateCount,
        description: "Number of isolated candidates. Defaults to 3; use 5 for higher-value tasks.",
      },
      validationCommands: {
        type: "array",
        items: { type: "string" },
        description: "Optional validation commands. When omitted, one supported root project type is detected.",
      },
    },
    output: {
      schema: verifiedBestOfOutputSchema,
      render: (_args, value) => [{
        type: "text",
        text: [
          `Verified Best-of-${value.requestedCandidateCount}: ${value.status}.`,
          `Winner: ${value.winnerId ?? "none"}.`,
          `Eligible candidates: ${value.eligibleCandidateCount}.`,
          ...value.ranking.map((r) => {
            const parts = [`  ${r.candidateId}: ${r.executionStatus}/${r.validationStatus}`];
            if (r.changedFiles.length > 0) parts.push(`files: ${r.changedFiles.join(", ")}`);
            if (r.diffStat) parts.push(r.diffStat);
            if (r.failure) parts.push(`FAIL: ${r.failure.slice(0, 100)}`);
            return parts.join(" | ");
          }),
          `Report: ${value.reportPath}.`,
          value.winnerPatchPath === null ? "No patch is available." : `Patch: ${value.winnerPatchPath}. Apply only with apply_verified_winner.`,
          ...(value.selectionMethod === "parent_agent_review" && value.eligibleCandidateCount > 0 ? [
            "SELECTION METHOD: parent_agent_review. You (the parent agent) should review each candidate's changes and decide which is best.",
            `To select a different candidate, call apply_verified_winner with candidateId set to the preferred candidate ID.`,
            `Available candidates: ${value.ranking.map((r) => r.candidateId).join(", ")}.`,
          ] : []),
          value.failure === null ? "" : `Failure: ${value.failure}`,
        ].filter((line) => line.length > 0).join("\n"),
      }],
    },
    timeoutMs: runtimeConfig.runTimeoutMs + 60_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const repositoryPath = exec.agent?.session.header.cwd;
      if (repositoryPath === undefined) {
        throw new Error("verified_best_of requires a calling agent with a session cwd");
      }
      let operationCredential: string | undefined;
      return runVerifiedBestOf(
        {
          task: args.task,
          candidateCount: args.candidateCount ?? defaultCandidateCount,
          ...(args.validationCommands === undefined ? {} : { validationCommands: args.validationCommands }),
          repositoryPath,
          signal: exec.signal,
        },
        runtimeConfig,
        {
          requestApproval: async (reason, signal) => {
            const agent = exec.agent;
            if (agent === undefined) {
              throw new Error("verified_best_of approval requires a calling agent");
            }
            requireAllowedApproval(await ctx.approval.request({
              agent,
              toolName: "verified_best_of",
              callId: exec.callId,
              reason,
              signal,
            }), "verified_best_of");
          },
          resolveCredential: async () => {
            const resolvedCredential = await ctx.credentials.resolve(credentialRef(runtimeConfig.credentialRef));
            // Absence is not fatal here: validation-only runs complete without
            // a verifier credential. runVerifiedBestOf enforces the requirement
            // only when LLM ranking is actually needed.
            const value = resolvedCredential?.value ?? "";
            if (value.length > 0) {
              operationCredential = value;
            }
            return value;
          },
          runVerifier: async (request) => {
            if (operationCredential === undefined || operationCredential.length === 0) {
              throw new Error(`credential ${runtimeConfig.credentialRef} is not configured`);
            }
            return runPythonVerifier(request, {
              config: runtimeConfig,
              credentialValue: operationCredential,
            });
          },
        },
      );
    },
  }));



  ctx.tools.register(defineTool({
    name: "rollback_verified_winner",
    description: "Revert the changes applied by a previous apply_verified_winner call. Only works after an apply has been executed.",
    parameters: {
      runId: {
        type: "string",
        required: true,
        description: "The runId of the previously applied verified_best_of run.",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          schemaVersion: { type: "integer", const: 1, required: true },
          runId: { type: "string", required: true },
          status: { type: "string", const: "rolled_back", required: true },
          changedFiles: { type: "array", items: { type: "string" }, required: true },
          failure: { oneOf: [{ type: "string" }, { type: "null" }], required: true },
        },
      },
      render: (_args, value) => [{
        type: "text",
        text: [
          `Rollback result: ${value.status}.`,
          `Reverted files: ${value.changedFiles.join(", ")}.`,
          value.failure === null ? "" : `Failure: ${value.failure}`,
        ].filter((line) => line.length > 0).join(String.fromCharCode(10)),
      }],
    },
    timeoutMs: runtimeConfig.validationTimeoutMs + 60_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const repositoryPath = exec.agent?.session.header.cwd;
      if (repositoryPath === undefined) {
        throw new Error("rollback_verified_winner requires a calling agent with a session cwd");
      }
      return rollbackVerifiedWinner(
        { runId: args.runId, repositoryPath, signal: exec.signal },
        runtimeConfig,
      );
    },
  }));  ctx.tools.register(defineTool({
    name: "apply_verified_winner",
    description: "After a separate approval, apply one previously verified winner patch and rerun its validation commands.",
    parameters: {
      runId: {
        type: "string",
        required: true,
        description: "The runId returned by verified_best_of.",
      },
      candidateId: {
        type: "string",
        description: "Override: apply this specific candidate instead of the auto-selected winner. Use when selectionMethod is parent_agent_review.",
      },
    },
    output: {
      schema: applyWinnerOutputSchema,
      render: (_args, value) => [{
        type: "text",
        text: [
          `Apply result: ${value.status}.`,
          `Changed files: ${value.changedFiles.join(", ")}.`,
          `Validation: ${value.validationStatus}.`,
          value.failure === null ? "" : `Failure: ${value.failure}`,
        ].filter((line) => line.length > 0).join("\n"),
      }],
    },
    timeoutMs: runtimeConfig.validationTimeoutMs * 10 + 60_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const repositoryPath = exec.agent?.session.header.cwd;
      if (repositoryPath === undefined) {
        throw new Error("apply_verified_winner requires a calling agent with a session cwd");
      }
      return applyVerifiedWinner(
        { runId: args.runId, repositoryPath, signal: exec.signal, ...(args.candidateId !== undefined ? { candidateId: args.candidateId } : {}) },
        runtimeConfig,
        {
          requestApproval: async (reason, signal) => {
            const agent = exec.agent;
            if (agent === undefined) {
              throw new Error("apply_verified_winner approval requires a calling agent");
            }
            requireAllowedApproval(await ctx.approval.request({
              agent,
              toolName: "apply_verified_winner",
              callId: exec.callId,
              reason,
              signal,
            }), "apply_verified_winner");
          },
          resolveCredential: async () => {
            const resolvedCredential = await ctx.credentials.resolve(
              credentialRef(runtimeConfig.credentialRef),
            );
            // Only used for log redaction; an unconfigured credential means
            // there is nothing to redact.
            return resolvedCredential?.value ?? "";
          },
        },
      );
    },
  }));
}

export default apply;
