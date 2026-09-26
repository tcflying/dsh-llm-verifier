// 924 final audit, TS layer, REAL environment: real `dsh` candidates (no fake harness), real git
// worktrees, real validation, real apply, real rollback, driven through lib/core.js as the host drives it.
//   node accept-ts-924.mjs            profile defaults to verifier-e2e (minimax-cn / MiniMax-M3)
//   TS_PROFILE=verifier-m3 node accept-ts-924.mjs
//   KEEP=1 ...                         leave the scratch repo + state dir for inspection
// Verdict is printed BEFORE cleanup, and cleanup never decides the exit code.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const REPO = "G:/zcode-project/llm-verify/dsh-llm-verifier";
const lib = (n) => pathToFileURL(`${REPO}/lib/${n}`).href;
const { runVerifiedBestOf, selectVerifiedCandidate, applyVerifiedWinner, rollbackVerifiedWinner } = await import(lib("core.js"));
const settingsLib = await import(lib("settings.js"));

const PROFILE = process.env.TS_PROFILE || "verifier-e2e";
const KEEP = process.env.KEEP === "1";
const scratch = mkdtempSync(join(tmpdir(), "tsacc924-"));
const stateDirectory = join(scratch, "state");
const repoPath = join(scratch, "repo");
mkdirSync(stateDirectory, { recursive: true });

const git = (...args) => execFileSync("git", args, { cwd: repoPath, encoding: "utf8" });
const results = [];
const check = (name, fn) => {
  try { fn(); results.push(`ok   ${name}`); }
  catch (e) { results.push(`FAIL ${name}: ${String(e.message).split("\n")[0].slice(0, 220)}`); }
};

// --- fixture: a repo with a clean tree and one planted bug the candidates must fix -----------------
mkdirSync(repoPath, { recursive: true });
git("init", "-q", ".");
git("config", "user.email", "audit@invalid");
git("config", "user.name", "audit");
writeFileSync(join(repoPath, "add.js"), "exports.add = (a, b) => a - b;\n");
writeFileSync(join(repoPath, "test.js"), "const {add} = require('./add.js');\nif (add(2, 3) !== 5) { console.error('add(2,3) != 5'); process.exit(1); }\nconsole.log('test ok');\n");
writeFileSync(join(repoPath, "README.md"), "# fixture\n");
git("add", "-A");
git("commit", "-qm", "base: add.js is deliberately broken");

// The schema's own defaults, then the per-run overrides. This harness used to hand-write a partial
// object — `.mjs`, so `tsc` never looks at it, and `docs/proof/tools/` holds zero `.ts` files, so the
// type gate cannot see this directory at all. A missing `validationMode` then rode through as
// `undefined` for every previous run of this tool; the product only tolerated it because the field
// fell through to auto-detection (which wave 16 turned into a refusal, and that refusal is what
// surfaced the hole). Deriving the base from the schema means a renamed or added required field
// shows up here as a failure instead of as a silent default.
const schemaBase = settingsLib.VerifierSettingsSchema["~standard"].validate({}).value;
const runtimeConfig = {
  ...schemaBase,
  candidateProfile: PROFILE,
  credentialRef: "DEEPSEEK_API_KEY",
  verifierModel: "deepseek-v4-flash",
  nEvaluations: 1,
  maxVerifierWorkers: 4,
  verifierEffort: "low",
  verifierMaxTokens: 1024,
  candidateTimeoutMs: 5 * 60_000,
  validationTimeoutMs: 3 * 60_000,
  runTimeoutMs: 15 * 60_000,
  maxVerifierTraceBytes: 4096,
  stateDirectory,
  dshExecutable: "dsh",
  dshHomeDirectory: process.env.DSH_HOME || "C:/Users/datoo/.dsh",
  // parent_agent review mode never auto-selects: it ends `review_pending`, which is what lets this
  // tool drive select -> apply -> rollback against the real model output. The scoring leg is the
  // python/DeepSeek bridge, which wave 15 is editing; it is covered by the engine's real-model run.
  reviewMode: "parent_agent",
};
// Belt for the same hole: name every field the product reads, so a future partial literal fails here
// rather than three model sessions later.
const REQUIRED_SETTINGS = ["enabled", "defaultCandidateCount", "maxConcurrentCandidates", "candidateProfile",
  "reviewMode", "reviewFailurePolicy", "reviewSingleEligible", "validationMode", "validationCommands",
  "credentialRef", "verifierModel", "nEvaluations", "maxVerifierWorkers", "verifierEffort",
  "verifierMaxTokens", "candidateTimeoutMs", "validationTimeoutMs", "runTimeoutMs",
  "maxVerifierTraceBytes", "stateDirectory", "dshExecutable"];
const missingSettings = REQUIRED_SETTINGS.filter((k) => runtimeConfig[k] === undefined);
check(`harness config carries every required setting (missing: ${missingSettings.join(", ") || "none"})`, () => {
  assert.deepEqual(missingSettings, []);
});
const deps = {
  requestApproval: async () => undefined,
  resolveCredential: async () => "",
  runVerifier: async () => { throw new Error("not exercised in this leg"); },
};
const task = "In the current directory, edit add.js so that add(2, 3) returns 5. Change only add.js.";
const validationCommands = ["node test.js"];

const run = await runVerifiedBestOf({ task, candidateCount: 2, validationCommands, repositoryPath: repoPath }, runtimeConfig, deps);

check(`run reached a status the apply/rollback legs can be driven from (got ${run.status})`, () => {
  // `no_winner` used to be accepted here, and the branch below then skipped select + apply + rollback +
  // re-clean (8 of the 10 substantive checks) while still exiting 0. A real-model leg that never applied
  // anything cannot certify the apply path, so it is a red, not a green with a footnote: the fix is to
  // re-run or look at the candidates, not to lower the claim.
  assert.ok(["winner_selected", "review_pending"].includes(run.status), `unexpected status: ${run.status} / ${run.message ?? ""}`);
});
check("two candidate worktrees were created and then removed", () => {
  const listed = git("worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree "));
  assert.equal(listed.length, 1, `worktree list still holds: ${listed.join(" , ")}`);
});
check("manifest + report landed on disk", () => {
  assert.ok(run.reportPath && existsSync(run.reportPath), "report.md missing");
  const manifestPath = join(run.reportPath.replace(/report\.md$/, ""), "manifest.json");
  assert.ok(existsSync(manifestPath), `manifest.json missing next to ${run.reportPath}`);
  globalThis.__manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
});
const dumpShape = () => {
  const m = globalThis.__manifest;
  const runs = m.candidateRuns ?? m.candidates ?? [];
  console.log(`manifest top keys: ${Object.keys(m).join(",")}`);
  console.log(`candidate keys:    ${Object.keys(runs[0] ?? {}).join(",")}`);
};
check("two candidates recorded, each with an execution + validation outcome", () => {
  const runs = globalThis.__manifest.candidateRuns ?? globalThis.__manifest.candidates;
  assert.equal(runs.length, 2, `manifest candidates: ${runs.length}`);
  const ids = new Set(runs.map((c) => c.candidateId ?? c.id));
  assert.equal(ids.size, 2, `candidate ids not unique: ${[...ids].join(",")}`);
  for (const c of runs) {
    assert.ok(String(c.executionStatus ?? "").length > 0, `candidate ${c.candidateId} records no execution status`);
    assert.ok(String(c.validationStatus ?? "").length > 0, `candidate ${c.candidateId} records no validation status`);
  }
  // A real model that claims it edited files and writes nothing must be excluded from ranking.
  const noChange = runs.filter((c) => (c.changedFiles ?? []).length === 0);
  for (const c of noChange) {
    assert.notEqual(c.validationStatus, "passed", `candidate ${c.candidateId} changed nothing yet was validated`);
  }
});
check("each eligible candidate produced a real patch on disk", () => {
  const runs = globalThis.__manifest.candidateRuns ?? globalThis.__manifest.candidates;
  let seen = 0;
  for (const c of runs) {
    if (c.validationStatus !== "passed") continue;
    const p = c.patchPath;
    assert.ok(typeof p === "string" && p.length > 0, `candidate ${c.candidateId} passed validation with no patch path`);
    assert.ok(existsSync(p), `candidate ${c.candidateId} patchPath does not exist: ${p}`);
    assert.ok(readFileSync(p).length > 0, `candidate ${c.candidateId} patch is empty`);
    seen += 1;
  }
  if (globalThis.__manifest.result.eligibleCandidateCount > 0) assert.ok(seen > 0, "eligible>0 but no patch artifact exists");
});

let outcome = "skipped";
if (run.status === "no_winner") {
  outcome = "no_winner (apply/rollback legs skipped: nothing eligible)";
} else {
  const winner = run.winnerId ?? (() => {
    const runs = globalThis.__manifest.candidateRuns ?? [];
    const passed = runs.find((c) => c.validationStatus === "passed") ?? runs[0];
    return passed.candidateId;
  })();
  if (run.status === "review_pending") {
    const sel = await selectVerifiedCandidate({
      runId: run.runId,
      candidateId: winner,
      repositoryPath: repoPath,
      reason: "924 final audit: chose the candidate whose patch makes node test.js pass",
    }, runtimeConfig);
    check("select_verified_candidate records the choice", () => assert.equal(sel?.status, "selected",
      `select said: ${JSON.stringify(sel).slice(0, 200)}`));
    outcome = `selected ${winner}`;
  }
  const before = readFileSync(join(repoPath, "add.js"), "utf8");
  const applied = await applyVerifiedWinner({ runId: run.runId, repositoryPath: repoPath }, runtimeConfig, deps);
  check(`apply reports success (got ${applied?.status ?? JSON.stringify(applied).slice(0, 120)})`, () => {
    // The state, not the prose: contracts.ts:161 declares "applied" | "applied_validation_failed",
    // and a result carrying no `message` at all used to satisfy a regex that only ever saw "".
    assert.equal(applied?.status, "applied", `apply said: ${JSON.stringify(applied).slice(0, 200)}`);
  });
  check("the winner's fix is now in the user's working tree", () => {
    const now = readFileSync(join(repoPath, "add.js"), "utf8");
    assert.notEqual(now, before, "add.js unchanged after apply — the patch did not land");
  });
  const treeAfterApply = execFileSync("node", ["test.js"], { cwd: repoPath, encoding: "utf8" });
  check("the repo's own test passes after apply", () => assert.match(treeAfterApply, /test ok/));

  const rolled = await rollbackVerifiedWinner({ runId: run.runId, repositoryPath: repoPath }, runtimeConfig);
  check("rollback returns rolled_back", () => assert.equal(rolled?.status, "rolled_back",
    `rollback said: ${JSON.stringify(rolled).slice(0, 200)}`));
  check("add.js is restored to the committed content after rollback", () => {
    // core.autocrlf=true on this box: a faithful restore still differs from the blob by CRLF, so the
    // byte comparison is done normalized AND against git's own verdict (an empty porcelain status is
    // the only claim that "the tree is back" that git itself agrees with).
    const now = readFileSync(join(repoPath, "add.js"), "utf8").replace(/\r\n/g, "\n");
    const head = execFileSync("git", ["show", "HEAD:add.js"], { cwd: repoPath, encoding: "utf8" }).replace(/\r\n/g, "\n");
    assert.equal(now, head, "rollback did not restore the committed content");
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: repoPath, encoding: "utf8" }).trim(), "", "tree is not clean after rollback");
  });
  check("no leftovers: worktree list is back to the main checkout only", () => {
    const listed = git("worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree "));
    assert.equal(listed.length, 1);
    assert.deepEqual(git("status", "--porcelain").trim(), "", `tree dirty after rollback: ${git("status", "--porcelain")}`);
  });
  check("the run disclosed no warnings", () => {
    const m = globalThis.__manifest;
    // The TS manifest key is `warnings` — the field written by the manifest literal in src/core.ts, not
    // the engine's `cleanupWarnings`. Cited by name, never by line number: that line has drifted three
    // times today. And `?? []` would let a build that never writes the field pass — so the array's
    // existence is the first assertion, not a default.
    assert.ok(Array.isArray(m.warnings), `manifest has no warnings array: ${JSON.stringify(Object.keys(m))}`);
    assert.deepEqual(m.warnings, [], `warnings: ${JSON.stringify(m.warnings)}`);
  });
}

const failures = results.filter((l) => l.startsWith("FAIL"));
console.log(`\n================ TS LIVE ACCEPTANCE (profile ${PROFILE}) ================`);
console.log(`run ${run.runId} status=${run.status} eligible=${run.eligibleCandidateCount ?? "?"} winner=${run.winnerId ?? "-"} outcome=${outcome}`);
console.log(results.join("\n"));
try { dumpShape(); } catch (e) { console.log(`shape dump failed: ${e.message}`); }
console.log(failures.length ? `\nTS LIVE ACCEPTANCE FAILURES: ${failures.length}` : "\nTS LIVE ACCEPTANCE OK");
if (!KEEP) rmSync(scratch, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 });
else console.log(`KEEP=1 scratch left at ${scratch}`);
process.exit(failures.length ? 1 : 0);
