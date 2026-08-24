import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const STABILITY_REPORT_URL = new URL(
  "../docs/acceptance/phase-5-test-stability-report.md",
  import.meta.url,
);

describe("Phase 5 test stability evidence contract", () => {
  it("records the complete stability report schema", async () => {
    const report = await readFile(STABILITY_REPORT_URL, "utf8");
    for (const requiredField of [
      "testRunCount",
      "successfulRuns",
      "failedRuns",
      "failureNames",
      "failureFrequency",
      "failureDistribution",
      "environment",
      "nodeVersion",
      "pnpmVersion",
      "cleanupObserved",
      "networkUsed",
      "credentialUsed",
    ]) {
      assert.match(report, new RegExp(`\\| \`${requiredField}\` \\|`, "u"));
    }
  });

  it("preserves every distinct failure observation", async () => {
    const report = await readFile(STABILITY_REPORT_URL, "utf8");
    for (const failureName of [
      "runs five isolated candidates and uses two verifier pivots",
      "kills the complete process group when a command times out",
      "force-kills a process group that ignores SIGTERM",
    ]) {
      assert.match(report, new RegExp(failureName, "u"));
    }
    assert.match(report, /`failedRuns` \| 3/u);
    assert.match(report, /3\/9 overall; 0\/5 in the dedicated diagnostic matrix/u);
  });

  it("forbids a success-only stability conclusion", async () => {
    const report = await readFile(STABILITY_REPORT_URL, "utf8");
    assert.match(report, /does not prove an environment-only cause/u);
    assert.match(report, /does not rule out a low-frequency lifecycle defect/u);
    assert.match(report, /No success-only summary is permitted/u);
    assert.doesNotMatch(report, /(?:all runs|fully stable|zero flakiness)\b/iu);
  });

  it("keeps every external execution path approval-gated", async () => {
    const report = await readFile(STABILITY_REPORT_URL, "utf8");
    for (const externalGate of [
      "Hosted CI",
      "Native Best-of-3",
      "Native Best-of-5",
      "Terminal-Bench",
    ]) {
      assert.match(report, new RegExp(`- ${externalGate}: APPROVAL REQUIRED`, "u"));
    }
    assert.match(report, /Credential usage: NOT AUTHORIZED/u);
    assert.match(report, /Cost: 0/u);
  });

  it("records zero network and credential use without overstating cleanup", async () => {
    const report = await readFile(STABILITY_REPORT_URL, "utf8");
    assert.match(report, /`networkUsed` \| false/u);
    assert.match(report, /`credentialUsed` \| false/u);
    assert.match(report, /direct OS orphan inventory NOT RECORDED/u);
    assert.match(report, /does not claim that an orphan process or external temporary artifact was impossible/u);
  });
});
