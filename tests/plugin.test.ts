import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { apply, skipsInteractiveApproval } from "../src/index.ts";

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
