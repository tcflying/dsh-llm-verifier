import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { MAX_TIMEOUT_MS, type RuntimeConfig } from "./config.ts";

/**
 * Structural surface of the optional host settings seam (@deepseek-ai/dsh-settings).
 * Declared locally instead of imported so the plugin keeps installing into
 * profiles that never load a settings provider (plain headless), while the
 * web host supplies the real implementation at runtime.
 */
interface SettingsProviderLike {
  register<T>(
    ns: string,
    schema: unknown,
    options?: {
      base?: Partial<T>;
      applies?: "live" | "restart";
      validate?: (value: T) => void;
    },
  ): { get(): unknown };
}

export const SETTINGS_NAMESPACE = "llm-verifier";

export type ReviewMode = "parent_agent" | "dsh_model" | "deepseek_verifier";

/**
 * The default stateDirectory is written as `$DSH_HOME/...`. Config-file
 * loading expands it; a settings-document value reaches the tools unexpanded,
 * and no host expands it for us, so tools resolve it at the point of use.
 */
export function expandStateDirectory(
  configuredStateDirectory: string,
  dshHomeDirectory: string,
): string {
  const usesDshHome = configuredStateDirectory === "$DSH_HOME"
    || configuredStateDirectory.startsWith("$DSH_HOME/")
    || configuredStateDirectory.startsWith("$DSH_HOME\\");
  if (usesDshHome && dshHomeDirectory.trim().length === 0) {
    // `process.env.DSH_HOME ?? fallback` does not rescue `DSH_HOME=""`, and an
    // empty home makes the expansion `$DSH_HOME/llm-verifier` → `/llm-verifier`
    // → the system drive root: absolute, so it passed every check and moved all
    // run state, locks and patches out of the user's dsh directory. An empty
    // DSH_HOME has no legitimate reading.
    throw new Error(
      `invalid DSH_HOME: expanding ${JSON.stringify(configuredStateDirectory)} with an empty DSH_HOME would put all run state at the filesystem root; set DSH_HOME to a directory or configure an absolute stateDirectory`,
    );
  }
  if (configuredStateDirectory === "$DSH_HOME") {
    return dshHomeDirectory;
  }
  if (usesDshHome) {
    return `${dshHomeDirectory}/${configuredStateDirectory.slice("$DSH_HOME".length + 1)}`;
  }
  return configuredStateDirectory;
}

/** Flat namespace section. Existing Config keys keep their names; new keys extend the same document. */
export interface VerifierSettings {
  enabled: boolean;
  defaultCandidateCount: number;
  maxConcurrentCandidates: number;
  candidateProfile: string;
  reviewMode: ReviewMode;
  reviewerProvider: string;
  reviewerModel: string;
  reviewerReasoningEffort: string;
  reviewerMaxTokens: number;
  reviewerTimeoutMs: number;
  reviewSingleEligible: boolean;
  reviewFailurePolicy: "stop" | "parent_agent";
  validationMode: "auto" | "configured";
  validationCommands: string[];
  credentialRef: string;
  verifierModel: string;
  nEvaluations: number;
  maxVerifierWorkers: number;
  verifierEffort: "low" | "high" | "max";
  verifierMaxTokens: number;
  candidateTimeoutMs: number;
  validationTimeoutMs: number;
  runTimeoutMs: number;
  maxVerifierTraceBytes: number;
  stateDirectory: string;
}

/** Run-time settings: the namespace section plus the process-execution secrets the UI never edits. */
export type RunSettings = VerifierSettings & {
  dshExecutable: string;
  dshHomeDirectory?: string;
};

/** Scope registered for this namespace on hosts that provide settings; null on headless. */
let registeredScope: { get(): unknown } | null = null;
let registeredProvider: { describe(): unknown } | null = null;

export function registeredVerifierScope(): unknown {
  return registeredScope;
}

/**
 * Snapshot the resolved settings for one run. The host scope already layers
 * schema defaults, the composition base, and the user document; the fallback
 * covers headless hosts where no settings provider exists.
 */
export function resolveRunSettings(fallback: RunSettings): {
  section: RunSettings;
  settingsRevision: number | null;
} {
  if (registeredScope === null) {
    return { section: fallback, settingsRevision: null };
  }
  const section = registeredScope.get() as RunSettings;
  let settingsRevision: number | null = null;
  if (registeredProvider !== null) {
    // The host provider's describe() returns a bare descriptor array.
    const described: unknown = registeredProvider.describe();
    const list = Array.isArray(described)
      ? (described as Array<{ ns: string; revision: number }>)
      : ((described as { namespaces?: Array<{ ns: string; revision: number }> }).namespaces ?? []);
    const descriptor = list.find((namespace) => namespace.ns === SETTINGS_NAMESPACE);
    settingsRevision = descriptor?.revision ?? null;
  }
  return { section, settingsRevision };
}

export const VerifierSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  defaultCandidateCount: z.natural().min(1).max(5).default(3),
  maxConcurrentCandidates: z.natural().min(1).max(5).default(3),
  candidateProfile: z.string().default("headless"),
  reviewMode: z.union([
    z.const("parent_agent"),
    z.const("dsh_model"),
    z.const("deepseek_verifier"),
  ]).default("parent_agent"),
  reviewerProvider: z.string().default(""),
  reviewerModel: z.string().default(""),
  reviewerReasoningEffort: z.string().default(""),
  reviewerMaxTokens: z.natural().min(256).max(32_768).default(4_096),
  // Bounded at the schema layer too: the `reviewerTimeoutMs <= runTimeoutMs` cross-field rule
  // only runs inside validateVerifierSettings(), i.e. not on every path that reads a config.
  reviewerTimeoutMs: z.natural().min(1).max(MAX_TIMEOUT_MS).default(300_000),
  reviewSingleEligible: z.boolean().default(true),
  reviewFailurePolicy: z.union([
    z.const("stop"),
    z.const("parent_agent"),
  ]).default("stop"),
  validationMode: z.union([
    z.const("auto"),
    z.const("configured"),
  ]).default("auto"),
  validationCommands: z.array(z.string()).default([]),
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
  // The ceiling is 7 days: Node clamps a `setTimeout` delay above 2^31-1 ms down
  // to 1 ms (it only warns), so an unbounded hand-edited value would abort every
  // run instantly instead of honouring the config. One constant, both schema layers.
  candidateTimeoutMs: z.natural().min(1).max(MAX_TIMEOUT_MS).default(20 * 60 * 1_000),
  validationTimeoutMs: z.natural().min(1).max(MAX_TIMEOUT_MS).default(10 * 60 * 1_000),
  runTimeoutMs: z.natural().min(1).max(MAX_TIMEOUT_MS).default(45 * 60 * 1_000),
  maxVerifierTraceBytes: z.natural().min(1).default(512 * 1_024),
  stateDirectory: z.string().default("$DSH_HOME/llm-verifier"),
});

/** Cross-field rules the per-field schema cannot express (design §5). */
export function validateVerifierSettings(value: VerifierSettings): void {
  if (value.runTimeoutMs < Math.max(value.candidateTimeoutMs, value.validationTimeoutMs)) {
    throw new Error(
      `invalid runTimeoutMs ${value.runTimeoutMs}: must not be smaller than candidateTimeoutMs ${value.candidateTimeoutMs} or validationTimeoutMs ${value.validationTimeoutMs}`,
    );
  }
  if (value.validationMode === "configured" && value.validationCommands.length === 0) {
    throw new Error("validationMode 'configured' requires at least one validation command");
  }
  if (
    value.reviewMode === "deepseek_verifier" &&
    !/^deepseek-[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value.verifierModel)
  ) {
    throw new Error(
      `reviewMode 'deepseek_verifier' requires a DeepSeek verifierModel, got ${JSON.stringify(value.verifierModel)}`,
    );
  }
  if (value.reviewMode === "dsh_model") {
    if (value.reviewerProvider.trim().length === 0 || value.reviewerModel.trim().length === 0) {
      throw new Error(
        "reviewMode 'dsh_model' requires both reviewerProvider and reviewerModel",
      );
    }
  }
  if (value.reviewerTimeoutMs > value.runTimeoutMs) {
    throw new Error(
      `invalid reviewerTimeoutMs ${value.reviewerTimeoutMs}: must not exceed runTimeoutMs ${value.runTimeoutMs}`,
    );
  }
}

/** Flatten a resolved runtime config back to namespace field names for the composition base layer. */
export function settingsBaseFrom(
  defaultCandidateCount: number,
  runtimeConfig: RuntimeConfig,
): RunSettings {
  return {
    enabled: true,
    defaultCandidateCount,
    maxConcurrentCandidates: 3,
    candidateProfile: runtimeConfig.candidateProfile,
    reviewMode: "parent_agent",
    reviewerProvider: "",
    reviewerModel: "",
    reviewerReasoningEffort: "",
    reviewerMaxTokens: 4_096,
    reviewerTimeoutMs: 300_000,
    reviewSingleEligible: true,
    reviewFailurePolicy: "stop",
    validationMode: "auto",
    validationCommands: [],
    credentialRef: runtimeConfig.credentialRef,
    verifierModel: runtimeConfig.verifierModel,
    nEvaluations: runtimeConfig.nEvaluations,
    maxVerifierWorkers: runtimeConfig.maxVerifierWorkers,
    verifierEffort: runtimeConfig.verifierEffort,
    verifierMaxTokens: runtimeConfig.verifierMaxTokens,
    candidateTimeoutMs: runtimeConfig.candidateTimeoutMs,
    validationTimeoutMs: runtimeConfig.validationTimeoutMs,
    runTimeoutMs: runtimeConfig.runTimeoutMs,
    maxVerifierTraceBytes: runtimeConfig.maxVerifierTraceBytes,
    stateDirectory: runtimeConfig.stateDirectory,
    dshExecutable: runtimeConfig.dshExecutable,
    ...(runtimeConfig.dshHomeDirectory === undefined ? {} : { dshHomeDirectory: runtimeConfig.dshHomeDirectory }),
  };
}

/**
 * Register the `llm-verifier` settings namespace when the host provides the
 * settings service. Optional by construction: profiles without settings never
 * invoke the callback and the plugin keeps its config-file-only behavior.
 */
export function registerVerifierSettings(ctx: Context, base: VerifierSettings): void {
  const owner = ctx as Context & {
    inject?: (
      services: string[],
      callback: (
        scoped: Context & {
          settings: SettingsProviderLike & {
            describe(): unknown;
          };
        },
      ) => void,
    ) => void;
  };
  if (typeof owner.inject !== "function") {
    return;
  }
  owner.inject(["settings"], (scoped) => {
    registeredScope = scoped.settings.register(SETTINGS_NAMESPACE, VerifierSettingsSchema, {
      base,
      applies: "live",
      validate: validateVerifierSettings,
    });
    registeredProvider = scoped.settings;
  });
}
