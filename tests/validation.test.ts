import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { resolveValidationCommands } from "../src/validation.ts";

async function createRepositoryFixture(): Promise<string> {
  return mkdtemp(join(tmpdir(), "dsh-llm-verifier-validation-"));
}

describe("validation command resolution", () => {
  it("detects the test command from one JavaScript package manager", async () => {
    const repositoryPath = await createRepositoryFixture();
    try {
      await writeFile(
        join(repositoryPath, "package.json"),
        JSON.stringify({ scripts: { test: "node --test" } }),
      );
      await writeFile(join(repositoryPath, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");

      assert.deepEqual(await resolveValidationCommands(repositoryPath), ["pnpm test"]);
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("fails instead of guessing when project types are ambiguous", async () => {
    const repositoryPath = await createRepositoryFixture();
    try {
      await writeFile(
        join(repositoryPath, "package.json"),
        JSON.stringify({ scripts: { test: "node --test" }, packageManager: "npm@11" }),
      );
      await writeFile(join(repositoryPath, "pyproject.toml"), "[project]\nname='fixture'\n");

      await assert.rejects(
        resolveValidationCommands(repositoryPath),
        /cannot auto-detect validation commands: matched package\.json, pyproject\.toml/,
      );
      assert.deepEqual(
        await resolveValidationCommands(repositoryPath, ["custom check"]),
        ["custom check"],
      );
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("rejects multiple JavaScript lockfiles even when they belong to npm", async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), "dsh-validation-lockfiles-"));
    try {
      await writeFile(
        join(repositoryPath, "package.json"),
        JSON.stringify({ scripts: { test: "node --test" }, packageManager: "npm@11.0.0" }),
      );
      await writeFile(join(repositoryPath, "package-lock.json"), "{}\n");
      await writeFile(join(repositoryPath, "npm-shrinkwrap.json"), "{}\n");
      await assert.rejects(
        resolveValidationCommands(repositoryPath),
        /multiple JavaScript lockfiles.*package-lock\.json.*npm-shrinkwrap\.json/,
      );
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });
});
