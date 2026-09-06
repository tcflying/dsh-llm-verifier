import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { apply, skipsInteractiveApproval } from "../src/index.ts";
import { SETTINGS_NAMESPACE, validateVerifierSettings } from "../src/settings.ts";

describe("Cordis plugin", () => {
  it("registers the three public tools", () => {
    const registeredToolNames: string[] = [];
    const context = {
      tools: {
        register(tool: { name: string }) {
          registeredToolNames.push(tool.name);
        },
      },
    };

    apply(context as never, {});

    assert.deepEqual(registeredToolNames, ["verified_best_of", "rollback_verified_winner", "apply_verified_winner"]);
  });

  it("registers the settings namespace when the host provides settings", () => {
    const registrations: Array<{ ns: string; options: { applies?: string } }> = [];
    const context = {
      tools: { register() {} },
      inject(services: string[], callback: (scoped: never) => void) {
        assert.deepEqual(services, ["settings"]);
        callback({
          settings: {
            register(ns: string, _schema: unknown, options: { applies?: string }) {
              registrations.push({ ns, options });
              return { scope: true };
            },
          },
        } as never);
      },
    };

    apply(context as never, {});

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

    assert.equal(registeredToolNames.length, 3);
  });

  it("rejects cross-field-invalid settings sections", () => {
    const base = {
      enabled: true,
      defaultCandidateCount: 3,
      maxConcurrentCandidates: 3,
      candidateProfile: "headless",
      reviewMode: "parent_agent",
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
});
