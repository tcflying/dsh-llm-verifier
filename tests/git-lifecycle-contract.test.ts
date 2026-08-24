import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import {
  gitExecutionOptionsForCommandCap,
  gitExecutionOptionsForDeadline,
} from "../src/core.ts";
import { capturePatchArtifact, runGit } from "../src/git.ts";

async function writeFakeGit(fixtureDirectory: string, scriptBody: string): Promise<string> {
  const executablePath = join(fixtureDirectory, "git");
  await writeFile(executablePath, `#!/usr/bin/env node\n${scriptBody}\n`, { mode: 0o700 });
  return executablePath;
}

async function writeFakeShellGit(fixtureDirectory: string, scriptBody: string): Promise<string> {
  const executablePath = join(fixtureDirectory, "git");
  await writeFile(executablePath, `#!/bin/sh\n${scriptBody}\n`, { mode: 0o700 });
  return executablePath;
}

async function withEnvironment(
  replacements: Readonly<Record<string, string | undefined>>,
  action: () => Promise<void>,
): Promise<void> {
  const originalValues = new Map<string, string | undefined>();
  for (const [environmentName, replacementValue] of Object.entries(replacements)) {
    originalValues.set(environmentName, process.env[environmentName]);
    if (replacementValue === undefined) {
      delete process.env[environmentName];
    } else {
      process.env[environmentName] = replacementValue;
    }
  }
  try {
    await action();
  } finally {
    for (const [environmentName, originalValue] of originalValues) {
      if (originalValue === undefined) {
        delete process.env[environmentName];
      } else {
        process.env[environmentName] = originalValue;
      }
    }
  }
}

function fakeGitPath(fixtureDirectory: string): string {
  return [fixtureDirectory, dirname(process.execPath), "/usr/bin", "/bin"].join(":");
}

function assertProcessDoesNotExist(processId: number): void {
  assert.throws(
    () => process.kill(processId, 0),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
  );
}

function killProcessIfPresent(processId: number | undefined): void {
  if (processId === undefined) {
    return;
  }
  try {
    process.kill(processId, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw error;
    }
  }
}

async function waitForFile(filePath: string, timeoutMs = 5_000): Promise<void> {
  const deadlineAt = Date.now() + timeoutMs;
  while (Date.now() < deadlineAt) {
    try {
      await access(filePath);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`fixture readiness timed out: ${filePath}`);
}

describe("ordinary Git process lifecycle contract", () => {
  it("derives a shared Git timeout from remaining budget without passing deadlineAt", () => {
    const deadlineAt = Date.now() + 500;
    const options = gitExecutionOptionsForDeadline(
      deadlineAt,
      new AbortController().signal,
    );
    assert.ok(options.timeoutMs > 0 && options.timeoutMs <= 500);
    assert.equal("deadlineAt" in options, false);
  });

  it("uses an explicit pre-deadline command cap without fabricating a shared deadline", () => {
    const signal = new AbortController().signal;
    const options = gitExecutionOptionsForCommandCap(12_345, signal);
    assert.deepEqual(options, { signal, timeoutMs: 12_345 });
    assert.equal("deadlineAt" in options, false);
  });

  it("consumes the remaining deadline and terminates a timed-out Git command", async () => {
    const fixtureDirectory = await mkdtemp(join(tmpdir(), "dsh-git-timeout-"));
    const processIdPath = join(fixtureDirectory, "git-pid.txt");
    let processId: number | undefined;
    try {
      await writeFakeShellGit(fixtureDirectory, [
        `trap '' TERM`,
        `printf '%s' "$$" > ${JSON.stringify(processIdPath)}`,
        `while :; do sleep 60; done`,
      ].join("\n"));
      await withEnvironment({ PATH: fakeGitPath(fixtureDirectory) }, async () => {
        const deadlineAt = Date.now() + 2_000;
        const options = gitExecutionOptionsForDeadline(
          deadlineAt,
          new AbortController().signal,
        );
        const startedAt = Date.now();
        await assert.rejects(
          runGit(fixtureDirectory, ["status"], options),
          (error: unknown) => {
            assert.match((error as Error).message, /^git_timeout:/u);
            assert.equal(
              ((error as Error & { cause?: { signal?: NodeJS.Signals } }).cause)?.signal,
              "SIGKILL",
            );
            return true;
          },
        );
        const elapsedMs = Date.now() - startedAt;
        assert.ok(elapsedMs >= 2_900, `Git SIGKILL grace was skipped after ${elapsedMs} ms`);
        assert.ok(elapsedMs < 4_000, `Git timeout exceeded its bound after ${elapsedMs} ms`);
      });
      processId = Number.parseInt(await readFile(processIdPath, "utf8"), 10);
      assertProcessDoesNotExist(processId);
    } finally {
      killProcessIfPresent(processId);
      await rm(fixtureDirectory, { recursive: true, force: true });
    }
  });

  it("propagates Abort and leaves no Git process behind", async () => {
    const fixtureDirectory = await mkdtemp(join(tmpdir(), "dsh-git-abort-"));
    const processIdPath = join(fixtureDirectory, "git-pid.txt");
    let processId: number | undefined;
    try {
      await writeFakeShellGit(fixtureDirectory, [
        `trap '' TERM`,
        `printf '%s' "$$" > ${JSON.stringify(processIdPath)}`,
        `while :; do sleep 60; done`,
      ].join("\n"));
      await withEnvironment({ PATH: fakeGitPath(fixtureDirectory) }, async () => {
        const abortController = new AbortController();
        const gitResult = runGit(fixtureDirectory, ["status"], {
          signal: abortController.signal,
          timeoutMs: 10_000,
        });
        await waitForFile(processIdPath);
        const abortStartedAt = Date.now();
        abortController.abort();
        await assert.rejects(gitResult, (error: unknown) => {
          assert.match((error as Error).message, /^git_aborted:/u);
          assert.equal(
            ((error as Error & { cause?: { signal?: NodeJS.Signals } }).cause)?.signal,
            "SIGKILL",
          );
          return true;
        });
        const abortElapsedMs = Date.now() - abortStartedAt;
        assert.ok(abortElapsedMs >= 900, `Git Abort SIGKILL grace was skipped after ${abortElapsedMs} ms`);
        assert.ok(abortElapsedMs < 2_500, `Git Abort exceeded its bound after ${abortElapsedMs} ms`);
      });
      processId = Number.parseInt(await readFile(processIdPath, "utf8"), 10);
      assertProcessDoesNotExist(processId);
    } finally {
      killProcessIfPresent(processId);
      await rm(fixtureDirectory, { recursive: true, force: true });
    }
  });

  it("bounds drain and rejects a Git command whose descendant holds stdio", async () => {
    const fixtureDirectory = await mkdtemp(join(tmpdir(), "dsh-git-residual-"));
    const childProcessIdPath = join(fixtureDirectory, "child-pid.txt");
    let childProcessId: number | undefined;
    try {
      await writeFakeGit(fixtureDirectory, [
        `import { spawn } from "node:child_process";`,
        `import { writeFileSync } from "node:fs";`,
        `const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], { stdio: ["ignore", process.stdout, process.stderr] });`,
        `writeFileSync(${JSON.stringify(childProcessIdPath)}, String(child.pid));`,
        `child.unref();`,
      ].join("\n"));
      await withEnvironment({ PATH: fakeGitPath(fixtureDirectory) }, async () => {
        const startedAt = Date.now();
        await assert.rejects(
          runGit(fixtureDirectory, ["status"], { timeoutMs: 2_000 }),
          /^Error: git_residual_process:/u,
        );
        const elapsedMs = Date.now() - startedAt;
        assert.ok(elapsedMs >= 200, `Git drain returned too early after ${elapsedMs} ms`);
        assert.ok(elapsedMs < 2_500, `Git drain exceeded its bound after ${elapsedMs} ms`);
      });
      childProcessId = Number.parseInt(await readFile(childProcessIdPath, "utf8"), 10);
      assertProcessDoesNotExist(childProcessId);
    } finally {
      killProcessIfPresent(childProcessId);
      await rm(fixtureDirectory, { recursive: true, force: true });
    }
  });

  it("uses the isolated Git environment without proxy, credential, or SSH values", async () => {
    const fixtureDirectory = await mkdtemp(join(tmpdir(), "dsh-git-environment-"));
    const capturedEnvironmentPath = join(fixtureDirectory, "environment.json");
    try {
      await writeFakeGit(fixtureDirectory, [
        `import { writeFileSync } from "node:fs";`,
        `writeFileSync(${JSON.stringify(capturedEnvironmentPath)}, JSON.stringify(process.env));`,
        `process.stdout.write("synthetic git output\\n");`,
      ].join("\n"));
      await withEnvironment({
        PATH: fakeGitPath(fixtureDirectory),
        HTTP_PROXY: undefined,
        http_proxy: undefined,
        HTTPS_PROXY: "https://proxy.example.invalid:8443",
        https_proxy: undefined,
        ALL_PROXY: undefined,
        all_proxy: undefined,
        NO_PROXY: undefined,
        no_proxy: undefined,
        DEEPSEEK_API_KEY: "synthetic-git-secret",
        SSH_AUTH_SOCK: "/private/forbidden-ssh-agent",
      }, async () => {
        assert.equal(
          (await runGit(fixtureDirectory, ["status"], { timeoutMs: 5_000 })).trim(),
          "synthetic git output",
        );
      });
      await access(capturedEnvironmentPath);
      const capturedEnvironment = JSON.parse(
        await readFile(capturedEnvironmentPath, "utf8"),
      ) as Record<string, string>;
      assert.equal(capturedEnvironment.GIT_CONFIG_GLOBAL, "/dev/null");
      assert.equal(capturedEnvironment.GIT_CONFIG_NOSYSTEM, "1");
      assert.equal(capturedEnvironment.GIT_PAGER, "cat");
      assert.equal(capturedEnvironment.GIT_TERMINAL_PROMPT, "0");
      assert.equal(capturedEnvironment.PAGER, "cat");
      assert.equal("HTTPS_PROXY" in capturedEnvironment, false);
      assert.equal("DEEPSEEK_API_KEY" in capturedEnvironment, false);
      assert.equal("SSH_AUTH_SOCK" in capturedEnvironment, false);
    } finally {
      await rm(fixtureDirectory, { recursive: true, force: true });
    }
  });

  it("preserves binary Git stdout as exact PatchArtifact bytes", async () => {
    const fixtureDirectory = await mkdtemp(join(tmpdir(), "dsh-git-binary-"));
    const expectedPatchBytes = Buffer.from([0xff, 0xfe, 0x00, 0x41, 0x0a]);
    try {
      await writeFakeGit(fixtureDirectory, [
        `if (process.argv[2] === "diff") {`,
        `  process.stdout.write(Buffer.from([${[...expectedPatchBytes].join(", ")}]));`,
        `}`,
      ].join("\n"));
      await withEnvironment({ PATH: fakeGitPath(fixtureDirectory) }, async () => {
        const patchArtifact = await capturePatchArtifact(
          fixtureDirectory,
          "synthetic-base",
          { timeoutMs: 5_000 },
        );
        assert.deepEqual(patchArtifact.bytes, expectedPatchBytes);
        assert.equal(patchArtifact.size, expectedPatchBytes.length);
      });
    } finally {
      await rm(fixtureDirectory, { recursive: true, force: true });
    }
  });
});
