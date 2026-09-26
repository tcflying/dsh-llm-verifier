import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { apply, Config, skipsInteractiveApproval } from "../src/index.ts";
import {
  expandStateDirectory,
  SETTINGS_NAMESPACE,
  VerifierSettingsSchema,
  validateVerifierSettings,
  type VerifierSettings,
} from "../src/settings.ts";

describe("Cordis plugin", () => {
  it("registers the four public tools", () => {
    const registeredToolNames: string[] = [];
    const context = {
      tools: {
        register(tool: { name: string }) {
          registeredToolNames.push(tool.name);
        },
      },
    };

    apply(context as never, {});

    assert.deepEqual(registeredToolNames, ["verified_best_of", "rollback_verified_winner", "select_verified_candidate", "apply_verified_winner"]);
  });

  it("registers the settings namespace when the host provides settings", () => {
    const registrations: Array<{ ns: string; options: { applies?: string } }> = [];
    const injectCalls: string[][] = [];
    const context = {
      tools: { register() {} },
      inject(services: string[], callback: (scoped: never) => void) {
        injectCalls.push(services);
        if (services[0] === "settings") {
          callback({
            settings: {
              register(ns: string, _schema: unknown, options: { applies?: string }) {
                registrations.push({ ns, options });
                return { get: () => null };
              },
            },
          } as never);
        }
      },
    };

    apply(context as never, {});

    assert.deepEqual(injectCalls, [["settings"], ["llm"]]);
    assert.equal(registrations.length, 1);
    assert.equal(registrations[0]?.ns, SETTINGS_NAMESPACE);
    assert.equal(registrations[0]?.options.applies, "live");
  });

  it("keeps loading on hosts without a settings service", () => {
    const registeredToolNames: string[] = [];
    const context = {
      tools: {
        register(tool: { name: string }) {
          registeredToolNames.push(tool.name);
        },
      },
    };

    apply(context as never, {});

    assert.equal(registeredToolNames.length, 4);
  });

  it("rejects cross-field-invalid settings sections", () => {
    const base: VerifierSettings = {
      enabled: true,
      defaultCandidateCount: 3,
      maxConcurrentCandidates: 3,
      candidateProfile: "headless",
      reviewMode: "parent_agent",
      reviewerProvider: "",
      reviewerModel: "",
      reviewerReasoningEffort: "",
      reviewerMaxTokens: 4_096,
      reviewerTimeoutMs: 30_000,
      reviewSingleEligible: true,
      reviewFailurePolicy: "stop",
      validationMode: "auto",
      validationCommands: [],
      credentialRef: "DEEPSEEK_API_KEY",
      verifierModel: "deepseek-v4-flash",
      nEvaluations: 2,
      maxVerifierWorkers: 8,
      verifierEffort: "high",
      verifierMaxTokens: 32768,
      candidateTimeoutMs: 1_200_000,
      validationTimeoutMs: 600_000,
      runTimeoutMs: 2_700_000,
      maxVerifierTraceBytes: 524_288,
      stateDirectory: "C:\\tmp\\llm-verifier",
    };
    validateVerifierSettings({ ...base });
    assert.throws(
      () => validateVerifierSettings({ ...base, runTimeoutMs: 300_000 }),
      /runTimeoutMs/,
    );
    assert.throws(
      () => validateVerifierSettings({ ...base, validationMode: "configured" }),
      /configured/,
    );
    assert.throws(
      () => validateVerifierSettings({ ...base, reviewMode: "deepseek_verifier", verifierModel: "gpt-5" }),
      /deepseek_verifier/,
    );
  });

  it("refuses a timeout that setTimeout would silently clamp to 1ms", () => {
    // `setTimeout(fn, 2_147_483_648)` fires after 1ms and only warns, so a
    // hand-edited settings document with a huge timeout would abort every run the
    // instant it starts. The ceiling is 7 days, the same limit the portable
    // engine enforces, and it has to be refused at load with the field named.
    const fields = ["candidateTimeoutMs", "validationTimeoutMs", "runTimeoutMs"] as const;
    // Both config layers carry the ceiling: the settings document and the plugin
    // config file, which are parsed by separate schemas.
    const layers = [
      { label: "settings", parse: (values: Record<string, number>) => VerifierSettingsSchema(values as never) as Record<string, number> },
      { label: "config", parse: (values: Record<string, number>) => Config(values as never) as Record<string, number> },
    ];
    for (const { label, parse } of layers) {
      for (const key of fields) {
        const read = (value: number): number | undefined => parse({ [key]: value })[key];
        assert.throws(
          () => read(604_800_001),
          (error: unknown) => {
            assert.match(String(error), new RegExp(key));
            assert.match(String(error), /604800000/);
            return true;
          },
          `${label} ${key} above the ceiling must be refused and named in the message`,
        );
        assert.equal(read(604_800_000), 604_800_000, `${label} ${key} at the ceiling must be accepted`);
      }
    }
  });

  it("rejects a verifier model from another provider", () => {
    const context = {
      tools: {
        register() {
          throw new Error("a tool must not be registered for invalid configuration");
        },
      },
    };

    assert.throws(
      () => apply(context as never, { verifierModel: "gpt-5" }),
      /invalid verifierModel.*gpt-5/,
    );
  });

  it("skips the interactive ask only under the unattended 'never' policy", () => {
    assert.equal(skipsInteractiveApproval("never", undefined), true);
    assert.equal(skipsInteractiveApproval(undefined, "never"), true);
    assert.equal(skipsInteractiveApproval("never", "ask"), true);
    assert.equal(skipsInteractiveApproval("ask", "never"), false);
    assert.equal(skipsInteractiveApproval(undefined, undefined), false);
    assert.equal(skipsInteractiveApproval("ask", undefined), false);
  });

  it("gates all four tools on the enabled kill switch", async () => {
    // `enabled: false` is the operator's stop. Reading it in one of four handlers
    // meant storing false still let an apply, a rollback or a recorded selection
    // through, so the switch stopped nothing that changes state.
    interface RegisteredTool {
      name: string;
      execute: (args: Record<string, unknown>, exec: unknown) => Promise<unknown>;
    }
    const tools: RegisteredTool[] = [];
    let enabled = false;
    const context = {
      tools: { register(tool: RegisteredTool) { tools.push(tool); } },
      inject(services: string[], callback: (scoped: never) => void) {
        if (services[0] === "settings") {
          callback({
            settings: {
              register: () => ({ get: () => ({ enabled }) }),
              describe: () => [],
            },
          } as never);
        }
      },
    };
    apply(context as never, {});
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["verified_best_of", "rollback_verified_winner", "select_verified_candidate", "apply_verified_winner"],
    );
    const exec = {
      agent: { session: { header: { cwd: "not-a-repository" }, id: "session-1" } },
      signal: new AbortController().signal,
      callId: "call-1",
    };
    const runId = "00000000-0000-4000-8000-000000000000";
    const argumentsByTool: Record<string, Record<string, unknown>> = {
      verified_best_of: { task: "Fix the fixture" },
      rollback_verified_winner: { runId },
      select_verified_candidate: { runId, candidateId: "candidate-1", reason: "smallest diff" },
      apply_verified_winner: { runId },
    };
    for (const tool of tools) {
      enabled = false;
      await assert.rejects(
        tool.execute(argumentsByTool[tool.name] ?? {}, exec),
        new RegExp(`${tool.name} is disabled by the llm-verifier settings`, "u"),
        `${tool.name} must refuse while enabled is false`,
      );
      // Control: with the switch on, the same call gets past the guard and fails
      // further in, on the repository it was pointed at.
      enabled = true;
      const outcome = await tool.execute(argumentsByTool[tool.name] ?? {}, exec).then(
        () => "resolved",
        (error: unknown) => String(error),
      );
      assert.doesNotMatch(outcome, /is disabled by the llm-verifier settings/u, `${tool.name} must not refuse while enabled`);
    }
  });

  it("refuses an empty DSH_HOME instead of relocating run state to the drive root", () => {
    // `stateDirectory: "$DSH_HOME/llm-verifier"` with `DSH_HOME=""` expanded to
    // "/llm-verifier", which is absolute, passed every check, and moved all runs,
    // locks and patches to the system drive root. An empty DSH_HOME has no
    // legitimate reading, so the expansion is where it is refused.
    assert.throws(() => expandStateDirectory("$DSH_HOME/llm-verifier", ""), /invalid DSH_HOME/u);
    assert.throws(() => expandStateDirectory("$DSH_HOME\\llm-verifier", "   "), /invalid DSH_HOME/u);
    assert.throws(() => expandStateDirectory("$DSH_HOME", ""), /invalid DSH_HOME/u);
    // A configured absolute path needs no home, and a real one still expands.
    assert.equal(expandStateDirectory("C:\\tmp\\llm-verifier", ""), "C:\\tmp\\llm-verifier");
    assert.equal(expandStateDirectory("$DSH_HOME/llm-verifier", "D:\\dsh"), "D:\\dsh/llm-verifier");
    assert.equal(expandStateDirectory("$DSH_HOME", "D:\\dsh"), "D:\\dsh");
  });
});
