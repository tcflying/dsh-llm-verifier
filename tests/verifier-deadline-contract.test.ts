import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { RuntimeConfig } from "../src/config.ts";
import type { VerifierRequest } from "../src/contracts.ts";
import { RunDeadlineExceededError } from "../src/core.ts";
import { runPythonVerifier } from "../src/verifier.ts";

function runtimeConfig(stateDirectory: string): RuntimeConfig {
  return {
    candidateProfile: "headless",
    credentialRef: "DEEPSEEK_API_KEY",
    verifierModel: "deepseek-v4-flash",
    nEvaluations: 2,
    maxVerifierWorkers: 8,
    verifierEffort: "high",
    verifierMaxTokens: 32_768,
    candidateTimeoutMs: 1_200,
    validationTimeoutMs: 1_200,
    runTimeoutMs: 1_200,
    maxVerifierTraceBytes: 512 * 1_024,
    stateDirectory,
    dshExecutable: "/container/dsh",
  };
}

function verifierRequest(deadlineAt: number, timeoutMs: number): VerifierRequest {
  return {
    task: "Choose the best fixture",
    candidates: [
      { candidateId: "candidate-1", trajectory: "first" },
      { candidateId: "candidate-2", trajectory: "second" },
    ],
    pivots: 1,
    model: "deepseek-v4-flash",
    nEvaluations: 2,
    maxWorkers: 8,
    cachePath: "/tmp/verifier-deadline-cache.json",
    deadlineAt,
    timeoutMs,
    signal: new AbortController().signal,
  };
}

async function createFakeUv(
  fixtureDirectory: string,
  responseDelayMs: number,
): Promise<{
  readonly executablePath: string;
  readonly launchMarkerPath: string;
  readonly terminationMarkerPath: string;
}> {
  const executablePath = join(fixtureDirectory, "fake-uv.mjs");
  const launchMarkerPath = join(fixtureDirectory, "launched.txt");
  const terminationMarkerPath = join(fixtureDirectory, "terminated.txt");
  const script = `#!/usr/bin/env node
import { writeFileSync } from "node:fs";

writeFileSync(${JSON.stringify(launchMarkerPath)}, String(Date.now()));
process.on("SIGTERM", () => {
  writeFileSync(${JSON.stringify(terminationMarkerPath)}, String(Date.now()));
  process.exit(0);
});
process.stdin.resume();
setTimeout(() => {
  process.stdout.write(JSON.stringify({
    winnerIndex: 0,
    scores: [1, 0],
    ranking: [0, 1],
    requestCount: 1,
    tokenUsage: { calls: 1 }
  }));
}, ${responseDelayMs});
`;
  await writeFile(executablePath, script, { mode: 0o700 });
  return { executablePath, launchMarkerPath, terminationMarkerPath };
}

async function expectBridgeTimeout(
  request: VerifierRequest,
  config: RuntimeConfig,
  uvExecutable: string,
): Promise<number> {
  const startedAt = Date.now();
  await assert.rejects(
    runPythonVerifier(request, {
      config,
      credentialValue: "synthetic-verifier-credential",
      uvExecutable,
    }),
    /verifier bridge failed/u,
  );
  return Date.now() - startedAt;
}

describe("verifier deadline consumption contract", () => {
  it("uses the remaining deadline budget instead of the full run timeout", async () => {
    const fixtureDirectory = await mkdtemp(join(tmpdir(), "dsh-verifier-deadline-"));
    try {
      const fakeUv = await createFakeUv(fixtureDirectory, 2_000);
      const elapsedMs = await expectBridgeTimeout(
        verifierRequest(Date.now() + 260, 1_000),
        runtimeConfig(fixtureDirectory),
        fakeUv.executablePath,
      );
      assert.ok(elapsedMs >= 180, `verifier stopped too early after ${elapsedMs} ms`);
      assert.ok(elapsedMs < 700, `verifier reset to the full run timeout: ${elapsedMs} ms`);
    } finally {
      await rm(fixtureDirectory, { recursive: true, force: true });
    }
  });

  it("does not replace the request timeout with config.runTimeoutMs", async () => {
    const fixtureDirectory = await mkdtemp(join(tmpdir(), "dsh-verifier-deadline-"));
    try {
      const fakeUv = await createFakeUv(fixtureDirectory, 2_000);
      const elapsedMs = await expectBridgeTimeout(
        verifierRequest(Date.now() + 900, 120),
        runtimeConfig(fixtureDirectory),
        fakeUv.executablePath,
      );
      assert.ok(elapsedMs >= 60, `verifier stopped too early after ${elapsedMs} ms`);
      assert.ok(elapsedMs < 500, `verifier reset to the full run timeout: ${elapsedMs} ms`);
    } finally {
      await rm(fixtureDirectory, { recursive: true, force: true });
    }
  });

  it("fails with deadline_exceeded without launching an expired verifier", async () => {
    const fixtureDirectory = await mkdtemp(join(tmpdir(), "dsh-verifier-deadline-"));
    try {
      const fakeUv = await createFakeUv(fixtureDirectory, 0);
      await assert.rejects(
        runPythonVerifier(verifierRequest(Date.now() - 1, 100), {
          config: runtimeConfig(fixtureDirectory),
          credentialValue: "synthetic-verifier-credential",
          uvExecutable: fakeUv.executablePath,
        }),
        (error: unknown) => {
          assert.ok(error instanceof RunDeadlineExceededError);
          assert.equal(error.code, "deadline_exceeded");
          return true;
        },
      );
      await assert.rejects(access(fakeUv.launchMarkerPath), { code: "ENOENT" });
    } finally {
      await rm(fixtureDirectory, { recursive: true, force: true });
    }
  });

  it("terminates near the request absolute deadline", async () => {
    const fixtureDirectory = await mkdtemp(join(tmpdir(), "dsh-verifier-deadline-"));
    try {
      const fakeUv = await createFakeUv(fixtureDirectory, 2_000);
      const startedAt = Date.now();
      const deadlineAt = startedAt + 350;
      await expectBridgeTimeout(
        verifierRequest(deadlineAt, deadlineAt - Date.now()),
        runtimeConfig(fixtureDirectory),
        fakeUv.executablePath,
      );
      const finishedAt = Date.now();
      assert.ok(finishedAt >= deadlineAt - 50, `finished before deadline: ${finishedAt}`);
      assert.ok(finishedAt <= deadlineAt + 400, `finished after deadline: ${finishedAt}`);
    } finally {
      await rm(fixtureDirectory, { recursive: true, force: true });
    }
  });
});
