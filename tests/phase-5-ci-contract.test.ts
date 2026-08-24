import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const CI_WORKFLOW_URL = new URL("../.github/workflows/ci.yml", import.meta.url);

describe("Phase 5 offline CI contract", () => {
  it("pins the complete Node, pnpm, uv, Python, Harness, and action toolchain", async () => {
    const workflow = await readFile(CI_WORKFLOW_URL, "utf8");

    assert.match(workflow, /runs-on: ubuntu-24\.04/u);
    assert.match(
      workflow,
      /actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7\.0\.1/u,
    );
    assert.match(
      workflow,
      /pnpm\/setup@84cb39b217b10273981911c288cd62326dc7c6d2 # v2\.0\.2/u,
    );
    assert.match(
      workflow,
      /astral-sh\/setup-uv@c771a70e6277c0a99b617c7a806ffedaca235ff9 # v9\.0\.0/u,
    );
    assert.match(workflow, /version: "11\.7\.0"/u);
    assert.match(workflow, /runtime: "node@24\.14\.0"/u);
    assert.match(workflow, /version: "0\.11\.6"/u);
    assert.match(workflow, /python-version: "3\.13\.13"/u);
    assert.match(workflow, /pnpm add --global @deepseek-ai\/dsh@0\.1\.0-rc\.7/u);
  });

  it("runs the frozen build and offline test gates without credentials", async () => {
    const workflow = await readFile(CI_WORKFLOW_URL, "utf8");

    assert.match(workflow, /permissions:\n  contents: read/u);
    assert.match(workflow, /persist-credentials: false/u);
    assert.match(workflow, /pnpm install --frozen-lockfile/u);
    assert.match(workflow, /uv sync --frozen --project python/u);
    assert.match(workflow, /pnpm run typecheck/u);
    assert.match(workflow, /pnpm run build/u);
    assert.match(workflow, /run: pnpm test\n        env:\n          UV_OFFLINE: "1"/u);
    assert.doesNotMatch(workflow, /\$\{\{\s*secrets\./u);
    assert.doesNotMatch(workflow, /DEEPSEEK_API_KEY/u);
    assert.doesNotMatch(workflow, /verified_best_of|apply_verified_winner/u);
  });
});
