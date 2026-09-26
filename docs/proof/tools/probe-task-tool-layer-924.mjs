// 924: prove F1 at the TOOL level (not just runProcess). A task containing a double quote is fed to
// verified_best_of through the real core. If cmd.exe re-parses it, the injected `>` redirect creates a
// sentinel file; the candidate's own patch would never contain one, so its presence is unambiguous.
// Diagnostic only — the permanent regression assertion belongs to the charset guard's own test.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const REPO = "G:/zcode-project/llm-verify/dsh-llm-verifier";
const { runVerifiedBestOf } = await import(pathToFileURL(`${REPO}/lib/core.js`).href);
const scratch = mkdtempSync(join(tmpdir(), "f1quote924-"));
const repoPath = join(scratch, "repo");
const stateDirectory = join(scratch, "state");
mkdirSync(repoPath, { recursive: true });
mkdirSync(stateDirectory, { recursive: true });
const git = (...a) => execFileSync("git", a, { cwd: repoPath, encoding: "utf8" });
git("init", "-q", ".");
git("config", "user.email", "audit@invalid");
git("config", "user.name", "audit");
writeFileSync(join(repoPath, "README.md"), "# f1 probe\n");
git("add", "-A");
git("commit", "-qm", "base");

const SENTINEL = "c8f2e1d0.txt";
// The quote closes cmd's quoted argument; the redirect then runs as its own command.
const task = `Create result.txt containing OK" & echo BREAKOUT > ${SENTINEL} & "`;
const config = {
  candidateProfile: process.env.TS_PROFILE || "verifier-e2e",
  credentialRef: "DEEPSEEK_API_KEY",
  verifierModel: "deepseek-v4-flash",
  nEvaluations: 1,
  maxVerifierWorkers: 1,
  verifierEffort: "low",
  verifierMaxTokens: 512,
  candidateTimeoutMs: 3 * 60_000,
  validationTimeoutMs: 60_000,
  runTimeoutMs: 5 * 60_000,
  maxVerifierTraceBytes: 2048,
  stateDirectory,
  dshExecutable: "dsh",
  reviewMode: "parent_agent",
  reviewSingleEligible: false,
};

let note = "run threw";
try {
  const run = await runVerifiedBestOf({ task, candidateCount: 1, validationCommands: ["node -e \"0\""], repositoryPath: repoPath }, config, {
    requestApproval: async () => undefined,
    resolveCredential: async () => "",
    runVerifier: async () => { throw new Error("unused"); },
  });
  note = `status=${run.status} eligible=${run.eligibleCandidateCount ?? "?"} msg=${String(run.message ?? "").slice(0, 160)}`;
  const c = (run.candidates ?? [])[0];
  if (c) note += ` exec=${c.executionStatus}/${c.validationStatus}`;
} catch (e) {
  note = `threw: ${String(e.message).split("\n")[0].slice(0, 260)}`;
}

// Was the injected redirect executed anywhere under the scratch tree?
const hits = [];
const walk = (d) => {
  for (const f of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, f.name);
    if (f.isDirectory()) walk(p);
    else if (f.name === SENTINEL) hits.push(`${p} :: ${readFileSync(p, "utf8").trim()}`);
  }
};
try { walk(scratch); } catch (e) { hits.push(`walk error ${e.code}`); }
console.log(`task sent : ${JSON.stringify(task)}`);
console.log(`tool said: ${note}`);
console.log(`sentinel ${SENTINEL} found: ${hits.length > 0}`);
for (const h of hits) console.log(`  ${h}`);
console.log(hits.length > 0 ? "\nF1 AT TOOL LEVEL: BREAKOUT EXECUTED (cmd re-parsed the task)" : "\nF1 AT TOOL LEVEL: no breakout observed");
rmSync(scratch, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 });
