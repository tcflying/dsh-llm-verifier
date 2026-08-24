import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { RuntimeConfig } from "../src/config.ts";
import type { VerifierRequest } from "../src/contracts.ts";
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
    candidateTimeoutMs: 5_000,
    validationTimeoutMs: 5_000,
    runTimeoutMs: 5_000,
    maxVerifierTraceBytes: 512 * 1_024,
    stateDirectory,
    dshExecutable: "dsh",
  };
}

function verifierRequest(cachePath: string): VerifierRequest {
  return {
    task: "Choose the best candidate",
    candidates: [
      { candidateId: "candidate-1", trajectory: "first" },
      { candidateId: "candidate-2", trajectory: "second" },
    ],
    pivots: 1,
    model: "deepseek-v4-flash",
    nEvaluations: 2,
    maxWorkers: 8,
    cachePath,
    deadlineAt: Date.now() + 5_000,
    timeoutMs: 5_000,
    signal: new AbortController().signal,
  };
}

async function writeFakeUv(
  fixtureDirectory: string,
  fileName: string,
  scriptBody: string,
): Promise<string> {
  const executablePath = join(fixtureDirectory, fileName);
  await writeFile(executablePath, `#!/usr/bin/env node\n${scriptBody}\n`, { mode: 0o700 });
  return executablePath;
}

async function runFakeBridge(
  fixtureDirectory: string,
  uvExecutable: string,
  cachePath: string,
) {
  return runPythonVerifier(verifierRequest(cachePath), {
    config: runtimeConfig(fixtureDirectory),
    credentialValue: "synthetic-bridge-credential",
    uvExecutable,
  });
}

describe("verifier bridge protocol and cleanup contract", () => {
  it("rejects non-finite bridge scores without exposing stdout", async () => {
    const fixtureDirectory = await mkdtemp(join(tmpdir(), "dsh-bridge-nonfinite-"));
    const cachePath = join(fixtureDirectory, "cache.json");
    try {
      const uvExecutable = await writeFakeUv(
        fixtureDirectory,
        "nonfinite-uv.mjs",
        `process.stdout.write('{"winnerIndex":0,"scores":[1e400,0],"ranking":[0,1],"requestCount":1,"tokenUsage":null}');`,
      );
      await assert.rejects(
        runFakeBridge(fixtureDirectory, uvExecutable, cachePath),
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          assert.match(message, /^verifier_bridge_response_invalid: scores must contain finite numbers/u);
          assert.doesNotMatch(message, /1e400/u);
          return true;
        },
      );
    } finally {
      await rm(fixtureDirectory, { recursive: true, force: true });
    }
  });

  it("rejects score and ranking lengths that do not match the request", async () => {
    const fixtureDirectory = await mkdtemp(join(tmpdir(), "dsh-bridge-length-"));
    const cachePath = join(fixtureDirectory, "cache.json");
    try {
      const uvExecutable = await writeFakeUv(
        fixtureDirectory,
        "length-uv.mjs",
        `process.stdout.write(JSON.stringify({winnerIndex:0,scores:[1],ranking:[0],requestCount:1,tokenUsage:null}));`,
      );
      await assert.rejects(
        runFakeBridge(fixtureDirectory, uvExecutable, cachePath),
        /^Error: verifier_bridge_response_invalid: scores length must equal candidate count 2/u,
      );
    } finally {
      await rm(fixtureDirectory, { recursive: true, force: true });
    }
  });

  it("fails a successful bridge response that leaves a residual process group", async () => {
    const fixtureDirectory = await mkdtemp(join(tmpdir(), "dsh-bridge-residual-"));
    const cachePath = join(fixtureDirectory, "cache.json");
    const childProcessIdPath = join(fixtureDirectory, "child-pid.txt");
    let childProcessId: number | undefined;
    try {
      const executablePath = join(fixtureDirectory, "residual-uv.sh");
      await writeFile(executablePath, [
        "#!/bin/sh",
        "sleep 60 </dev/null >/dev/null 2>&1 &",
        "child_pid=$!",
        `printf '%s' \"$child_pid\" > '${childProcessIdPath}'`,
        "printf '%s' '{\"winnerIndex\":0,\"scores\":[1,0],\"ranking\":[0,1],\"requestCount\":1,\"tokenUsage\":null}'",
      ].join("\n"), { mode: 0o700 });

      await assert.rejects(
        runFakeBridge(fixtureDirectory, executablePath, cachePath),
        /^Error: verifier_bridge_residual_process:/u,
      );
      const recordedChildProcessId = Number.parseInt(await readFile(childProcessIdPath, "utf8"), 10);
      assert.ok(Number.isInteger(recordedChildProcessId));
      childProcessId = recordedChildProcessId;
      assert.throws(
        () => process.kill(recordedChildProcessId, 0),
        (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
      );
    } finally {
      if (childProcessId !== undefined) {
        try {
          process.kill(childProcessId, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
            throw error;
          }
        }
      }
      await rm(fixtureDirectory, { recursive: true, force: true });
    }
  });

  it("removes a bridge cache artifact on a response failure", async () => {
    const fixtureDirectory = await mkdtemp(join(tmpdir(), "dsh-bridge-cache-cleanup-"));
    const cachePath = join(fixtureDirectory, "cache.json");
    try {
      const uvExecutable = await writeFakeUv(
        fixtureDirectory,
        "cache-uv.mjs",
        [
          `import { writeFileSync } from "node:fs";`,
          `writeFileSync(${JSON.stringify(cachePath)}, "temporary-cache");`,
          `process.stdout.write("invalid-json");`,
        ].join("\n"),
      );
      await assert.rejects(
        runFakeBridge(fixtureDirectory, uvExecutable, cachePath),
        /^Error: verifier_bridge_response_invalid:/u,
      );
      await assert.rejects(access(cachePath), { code: "ENOENT" });
    } finally {
      await rm(fixtureDirectory, { recursive: true, force: true });
    }
  });

  it("makes cache cleanup failure observable after attempting removal", async () => {
    const fixtureDirectory = await mkdtemp(join(tmpdir(), "dsh-bridge-cache-failure-"));
    const cachePath = join(fixtureDirectory, "cache-directory");
    try {
      const uvExecutable = await writeFakeUv(
        fixtureDirectory,
        "cache-directory-uv.mjs",
        [
          `import { mkdirSync } from "node:fs";`,
          `mkdirSync(${JSON.stringify(cachePath)});`,
          `process.stdout.write(JSON.stringify({winnerIndex:0,scores:[1,0],ranking:[0,1],requestCount:1,tokenUsage:null}));`,
        ].join("\n"),
      );
      await assert.rejects(
        runFakeBridge(fixtureDirectory, uvExecutable, cachePath),
        /^Error: verifier_cache_cleanup_failed: cache removal failed/u,
      );
      await access(cachePath);
    } finally {
      await rm(fixtureDirectory, { recursive: true, force: true });
    }
  });
});
