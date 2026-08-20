import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";

import { inspectRepository } from "../src/git.ts";

const execFileAsync = promisify(execFile);

async function createCleanRepository(): Promise<string> {
  const repositoryPath = await mkdtemp(join(tmpdir(), "dsh-llm-verifier-git-"));
  await execFileAsync("git", ["init", "--quiet", repositoryPath]);
  await execFileAsync("git", ["config", "user.email", "tests@example.invalid"], { cwd: repositoryPath });
  await execFileAsync("git", ["config", "user.name", "Verifier Tests"], { cwd: repositoryPath });
  await writeFile(join(repositoryPath, "README.md"), "fixture\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: repositoryPath });
  await execFileAsync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: repositoryPath });
  return repositoryPath;
}

describe("repository preflight", () => {
  it("accepts a clean repository root and rejects later modifications", async () => {
    const repositoryPath = await createCleanRepository();
    try {
      const snapshot = await inspectRepository(repositoryPath);
      const { stdout: expectedCommit } = await execFileAsync("git", ["rev-parse", "HEAD"], {
        cwd: repositoryPath,
      });
      assert.equal(snapshot.repositoryPath, await realpath(repositoryPath));
      assert.equal(snapshot.baseCommit, expectedCommit.trim());

      await writeFile(join(repositoryPath, "README.md"), "changed\n");
      await assert.rejects(
        inspectRepository(repositoryPath),
        /repository must be clean; git status reported: M README\.md/,
      );
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });
});
