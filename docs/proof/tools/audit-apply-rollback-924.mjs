// 924 final audit: drive the BUILT plugin (lib/, `pnpm run build`) through real git repos on the
// real filesystem, with no test doubles. Usage: node "%TEMP%/audit924.mjs"  (after `pnpm run build`)
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";

const BUILD = "file:///G:/zcode-project/llm-verify/dsh-llm-verifier/lib/";
const {
  applyVerifiedWinner,
  rollbackVerifiedWinner,
} = await import(BUILD + "core.js");
// Config comes from the production schema's own defaults, not a hand-copied literal: a literal
// here silently rots every time a field is added, and the audit then tests a shape nobody runs.
// (schemastery has no .parse; it is a Standard Schema, so defaults come through ~standard.)
const { VerifierSettingsSchema } = await import(BUILD + "settings.js");
const schemaDefaults = VerifierSettingsSchema["~standard"].validate({}).value;

const git = (repo, ...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const state = mkdtempSync(join(tmpdir(), "audit924-state-"));
const config = {
  ...schemaDefaults,
  dshExecutable: "dsh",
  stateDirectory: state,
  validationTimeoutMs: 60_000,
};
let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures += 1;
};

function repo(withRename) {
  const dir = mkdtempSync(join(tmpdir(), "audit924-repo-"));
  git(dir, "init", "-q", ".");
  git(dir, "config", "user.email", "a@a.invalid");
  git(dir, "config", "user.name", "a");
  writeFileSync(join(dir, "keep.txt"), "original\n");
  writeFileSync(join(dir, "victim.txt"), "THE USER'S OWN PRE-EXISTING CONTENT\n");
  git(dir, "add", "keep.txt", "victim.txt");
  git(dir, "commit", "-qm", "base");
  return dir;
}

// Stage a winner patch that modifies keep.txt, adds new.txt, and renames victim.txt.
function makeRun(dir, { renamed, added, editedAfter }) {
  const runId = randomUUID();
  const runDir = join(state, "runs", runId);
  git(dir, "rev-parse", "HEAD");
  const base = git(dir, "rev-parse", "HEAD");
  const work = mkdtempSync(join(tmpdir(), "audit924-wt-"));
  git(work, "init", "-q", ".");
  git(work, "config", "user.email", "a@a.invalid");
  git(work, "config", "user.name", "a");
  writeFileSync(join(work, "keep.txt"), "original\n");
  writeFileSync(join(work, "victim.txt"), "THE USER'S OWN PRE-EXISTING CONTENT\n");
  git(work, "add", "-A");
  git(work, "commit", "-qm", "base");
  writeFileSync(join(work, "keep.txt"), "patched by winner\n");
  writeFileSync(join(work, "new.txt"), "brand new file from the patch\n");
  if (renamed) git(work, "mv", "victim.txt", "renamed.txt");
  git(work, "add", "-A");
  // Mirror src/git.ts captureCandidateChanges exactly: the patch query carries --no-textconv
  // (a textconv filter would otherwise rewrite the patch body) but NOT --no-renames, which is
  // only on the numstat query that builds the path list.
  const patch = git(work, "diff", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", "HEAD", "--");
  rmSync(work, { recursive: true, force: true });
  return { runId, runDir, base, patch };
}

// (case 1 of an earlier draft only re-verified that `git apply` can apply a git-generated
// patch — a git fact, not a product fact, and it never called the code under audit. The
// rename-patch behaviour it was meant to sanity-check is covered for real by the engine e2e
// ("worktree 里新装的 node_modules 不得进入候选补丁", 非 UTF-8 字节补丁) and tests/git.test.ts.)

// ---------------------------------------------------------------- case 2: drive the real tool pair
{
  const dir = repo(false);
  const runId = randomUUID();
  const runDir = join(state, "runs", runId);
  const base = git(dir, "rev-parse", "HEAD");
  const keep = join(dir, "keep.txt");
  const patch = [
    "diff --git a/keep.txt b/keep.txt",
    "index 0000000000000000000000000000000000000000..1111111111111111111111111111111111111111 100644",
    "--- a/keep.txt",
    "+++ b/keep.txt",
    "@@ -1 +1 @@",
    "-original",
    "+winner content",
    "diff --git a/new.txt b/new.txt",
    "new file mode 100644",
    "index 0000000000000000000000000000000000000000..2222222222222222222222222222222222222222",
    "--- /dev/null",
    "+++ b/new.txt",
    "@@ -0,0 +1 @@",
    "+added by winner",
    "",
  ].join("\n");
  const sha = createHash("sha256").update(patch).digest("hex");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "winner.patch"), patch);
  writeFileSync(join(runDir, "manifest.json"), JSON.stringify({
    schemaVersion: 2,
    repositoryPath: dir,
    baseCommit: base,
    validationCommands: ["node -e \"process.exit(0)\""],
    winnerPatchSha256: sha,
    winnerPatchPath: join(runDir, "winner.patch"),
    winnerId: "candidate-1",
    changedFiles: ["keep.txt", "new.txt"],
    result: { status: "winner_selected" },
    candidateRuns: [{
      candidateId: "candidate-1",
      executionStatus: "completed",
      validationStatus: "passed",
      patchPath: join(runDir, "winner.patch"),
      patchSha256: sha,
      changedFiles: ["keep.txt", "new.txt"],
    }],
    ranking: ["candidate-1"],
  }));
  const deps = { requestApproval: async () => {}, resolveCredential: async () => "" };
  let applied = null;
  try {
    applied = await applyVerifiedWinner({ runId, repositoryPath: dir }, config, deps);
  } catch (error) {
    check("case2 apply succeeded", false, error.message);
  }
  if (applied) {
    check("case2 apply status", applied.status === "applied" || applied.status === "applied_validation_failed", applied.status);
    check("case2 tree is patched", readFileSync(keep, "utf8") === "winner content\n", readFileSync(keep, "utf8"));
    check("case2 new file exists", existsSync(join(dir, "new.txt")));
    // rollback must restore the tree exactly
    const rolled = await rollbackVerifiedWinner({ runId, repositoryPath: dir }, config);
    check("case2 rollback status", rolled.status === "rolled_back", JSON.stringify(rolled));
    check("case2 keep.txt back at base", readFileSync(keep, "utf8") === "original\n", readFileSync(keep, "utf8"));
    check("case2 added file removed", !existsSync(join(dir, "new.txt")));
    check("case2 tree clean incl. index", git(dir, "status", "--porcelain").length === 0, git(dir, "status", "--porcelain"));
    // re-apply must work (B3)
    const again = await applyVerifiedWinner({ runId, repositoryPath: dir }, config, deps);
    check("case2 re-apply after rollback works", again.status === "applied" || again.status === "applied_validation_failed", again.status);
    const rolled2 = await rollbackVerifiedWinner({ runId, repositoryPath: dir }, config);
    check("case2 second rollback clean", git(dir, "status", "--porcelain").length === 0 && rolled2.status === "rolled_back", git(dir, "status", "--porcelain"));
    // B2: user edits an applied file, rollback must refuse and PRESERVE the edit
    await applyVerifiedWinner({ runId, repositoryPath: dir }, config, deps);
    writeFileSync(keep, "MY OWN UNCOMMITTED WORK\n");
    let refused = false;
    try {
      await rollbackVerifiedWinner({ runId, repositoryPath: dir }, config);
    } catch (error) {
      refused = true;
      check("case2 rollback refusal names the file", /keep\.txt/.test(error.message), error.message.slice(0, 120));
    }
    check("case2 rollback refused after user edit", refused);
    check("case2 user bytes survived", existsSync(keep) && readFileSync(keep, "utf8") === "MY OWN UNCOMMITTED WORK\n", readFileSync(keep, "utf8"));
  }
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nAUDIT OK" : `\nAUDIT FAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
