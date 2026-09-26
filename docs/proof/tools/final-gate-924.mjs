// 924 final gate: one deterministic run of every acceptance layer, repo -> built -> deployed.
//   node final-gate-924.mjs            full (both long suites + real-model cycle)
//   node final-gate-924.mjs --fast     skip the two long suites (engine e2e, TS)
//   node final-gate-924.mjs --no-real  skip the billed real-model runs
//   node final-gate-924.mjs --sync     ALSO overwrite the installed host copies (state-changing; off by
//                                      default so a rehearsal can never deploy an in-flight writer's file)
// Verdict table last; exit code is the AND of every stage that ran (never a pipeline tail).
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const REPO = "G:/zcode-project/llm-verify/dsh-llm-verifier";
// The probe/acceptance tools live next to this file in the repo, not in TEMP: a TEMP sweep once
// destroyed the final audit mid-run.
const T = "G:/zcode-project/llm-verify/dsh-llm-verifier/docs/proof/tools";
const DEPLOYED = [
  "C:/Users/datoo/.zcode/skills/llm-verifier/mcp-server.mjs",
  "C:/Users/datoo/.minimax/plugins/llm-verifier/.minimax-plugin/mcp-server.mjs",
];
const fast = process.argv.includes("--fast");
const noReal = process.argv.includes("--no-real");
const doSync = process.argv.includes("--sync");
const rows = [];
// The gate's red-stage evidence dumps raw child output into a shared %TEMP%. The product redacts every
// log it writes (`redactSecret` in src/process.ts); a proof tool that leaves a bearer token on disk while
// explaining a failure would be the worse offender. Deliberately over-broad: a false mask costs a line of
// evidence, a missed one costs a credential.
// The gate has always printed "silent window" claims it never measured. This box runs other projects'
// tests and desktop gates concurrently, so load is sampled at both ends of the run and goes into the log:
// node.exe count, how many of them are NOT this repo, and the cumulative CPU milliseconds of the others.
// The delta is the control that says whether a red was the code's or the machine's.
const loadSample = () => {
  // One PowerShell call, and the CPU comes from CIM itself (UserModeTime/KernelModeTime, microseconds,
  // cumulative per process). The first attempt joined `Get-Process -Name node` for TotalProcessorTime and
  // silently produced 0 ms for 50 live processes — a meter that can only print zero is worse than no meter,
  // because it reads like a measurement.
  const q = "$p = Get-CimInstance Win32_Process -Filter \"Name='node.exe'\";"
    + "foreach ($e in $p) { \"$($e.ProcessId)|$(if ($null -eq $e.UserModeTime) { -1 } else { [Math]::Round(($e.UserModeTime + $e.KernelModeTime) / 10000) })|$($e.CommandLine)\" }";
  const r = spawnSync("powershell", ["-NoProfile", "-Command", q], { encoding: "utf8" });
  if (r.status !== 0) return { nodes: -1, foreign: -1, foreignMs: -1 };
  const rows = (r.stdout || "").split(/\r?\n/).filter((l) => /^\d+\|-?\d+\|/.test(l))
    .map((l) => { const a = l.indexOf("|"), b = l.indexOf("|", a + 1); return [l.slice(0, a), l.slice(a + 1, b), l.slice(b + 1)]; });
  const foreign = rows.filter(([, , cmd]) => cmd && !cmd.includes("llm-verify"));
  const unknown = foreign.filter(([, ms]) => ms === "-1").length;
  return {
    nodes: rows.length,
    foreign: foreign.length,
    foreignMs: foreign.reduce((a, [, ms]) => a + Math.max(0, Number(ms)), 0),
    unknownMs: unknown,
  };
};
const LOAD_START = loadSample();
console.log(`LOAD_START=${JSON.stringify(LOAD_START)}`);
const redact = (s) => String(s)
  .replace(/sk-[A-Za-z0-9_-]{6,}/g, "sk-REDACTED")
  .replace(/(authorization["']?\s*[:=]\s*(?:bearer\s+)?)[A-Za-z0-9._~+/-]{8,}/gi, "$1REDACTED")
  .replace(/((?:api[_-]?key|token|secret|password)["']?\s*[:=]\s*["']?)[^"',\s&]{6,}/gi, "$1REDACTED");
// The dumps only happen when something is red, so a broken regex would be discovered at the worst moment.
// Check it on every gate start instead: sentinel in, mask out, ordinary evidence untouched.
{
  const probe = redact('k=sk-SENTINELnotAKEY1 Authorization: Bearer abcDEF123456 and {"apiKey":"zzzSECRET77"}');
  const clean = redact("PASS TS suite 665.0s exit=0 tests=115 pass=113 fail=0 skip=2");
  if (/SENTINEL|abcDEF123456|zzzSECRET/.test(probe) || /REDACTED/.test(clean)) {
    throw new Error("the gate's redactor is broken; refusing to write evidence dumps");
  }
}
// Blocking sleep: every stage here is a `spawnSync`, so Atomics.wait is the only wait that does not
// turn the whole pipeline into an async function for the sake of one gap between two stages.
const sleepSync = (ms) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};
const stage = (name, cmd, args, spawnOpts = {}) => {
  const t0 = Date.now();
  const r = spawnSync(cmd, args, { cwd: REPO, encoding: "utf8", shell: true, maxBuffer: 64e6, ...spawnOpts });
  const secs = (Date.now() - t0) / 1000;
  const out = (r.stdout || "") + (r.stderr || "");
  // A suite that matched zero test files exits 0 and prints tests=0: green with nothing run. The
  // tally is only trusted when it proves at least one test actually executed. Measured 2026-09-25:
  // a non-matching glob => exit 0 + `tests 0` (caught here); a mistyped literal path => exit 1 with
  // "Could not find ..." (caught by the status term). There is no reachable "exit 0 + no tally".
  const tally = /ℹ tests (\d+)[\s\S]*?ℹ pass (\d+)[\s\S]*?ℹ fail (\d+)[\s\S]*?ℹ skipped (\d+)/.exec(out);
  const ok = r.status === 0 && !(tally && Number(tally[1]) === 0);
  const counts = tally ? ` tests=${tally[1]} pass=${tally[2]} fail=${tally[3]} skip=${tally[4]}` : "";
  const marker = /AUDIT OK|DEPLOYMENT IN SYNC|ENGINE PROBE OK|N13 PARSER CHECK OK|MCP CONFIG OK|BRIDGE GUARD CHECK OK|DEPLOYED ACCEPTANCE OK(?: \([^)]*\))?/.exec(out);
  const failLine = out.split(/\r?\n/).filter((l) => /^(FAIL|DRIFT|✖ failing|N13 PARSER CHECK FAILURES|DEPLOYED ACCEPTANCE FAILURES|ENGINE PROBE FAILURES|AUDIT FAILURES|DEPLOYMENT DRIFT)/.test(l)).slice(0, 4).join(" | ");
  rows.push(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(34)} ${secs.toFixed(1).padStart(7)}s exit=${r.status}${counts}${marker ? " [" + marker[0] + "]" : ""}`);
  const row = rows[rows.length - 1];
  if (!ok && failLine) rows.push(`        ↳ ${failLine.slice(0, 400)}`);
  if (!ok) {
    // A red stage has to leave its own evidence. The four-line digest cannot name the offending
    // tests, and discovering them meant re-running a ten-minute suite against bytes that had since
    // moved — the re-run is no longer a witness to the failure it is explaining.
    const dump = `C:/Users/datoo/AppData/Local/Temp/gate-fail-${name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.log`;
    // The gate's own red-stage dump goes to a shared %TEMP% and can carry a suite's verbose output, which
    // in this project means candidate/model text. Every product-side log is redacted; this one is written
    // by the same hand and must not be the exception.
    writeFileSync(dump, `$ ${cmd} ${args.join(" ")}\nexit=${r.status}\n--- stdout+stderr ---\n${redact(out)}`);
    rows.push(`        ↳ full output kept: ${dump}`);
  }
  console.log(row);
  if (!ok) rows.slice(rows.length - 2).forEach((l) => console.log(l));
  return ok;
};

stage("typecheck", "npx", ["tsc", "-p", "tsconfig.json", "--noEmit"]);
stage("build -> lib/", "npx", ["tsc", "-p", "tsconfig.build.json"]);
stage("audit: built artifact + parity", "node", [`${T}/audit-build-924.mjs`]);
// Serialized on purpose: these files share the real git binary and this box's disk, and under default
// file concurrency three of them flake red with no code at fault (proven by running each alone). This
// stage is the authoritative verdict of the final gate, so it buys determinism with wall time; `pnpm
// test` stays concurrent for the inner loop.
// Front-loaded because it is the gate's only timing-sensitive stage. Measured 2026-09-26 in its old
// position (directly after the 852 s engine suite, behind a 65 s drain gap): 973.5 s and 3 tests red on
// their own subprocess budgets. The same command alone on the same loaded box: 748.8 s, 121 tests, 0 red.
// So the gap did not fix it — the preceding stage's drain must not overlap at all, which means the
// sensitive stage goes first, where the only thing ahead of it is a 7 s tsc.
// `--test-timeout` is load-bearing, not decoration: the fixture comments name "node:test's own per-test
// timeout" as the ceiling that is allowed to fire on a wedged fixture, and that ceiling is OPT-IN (measured
// 2026-09-26: a 12 s test under these exact flags ran 12006 ms and exited 0). Without it, the one
// uncapped poll loop in the suite (`waitForFile(apply-state.json)`) would hang this authoritative run
// forever instead of reddening it. 600 s is >3x the slowest legitimate test measured in-gate (167 s).
if (!fast) stage("TS suite", "node", ["--test", "--test-concurrency=1", "--test-timeout=600000", "tests/**/*.test.ts"]);
stage("probe: numstat parser (repo)", "node", [`${T}/n13b924.mjs`]);
// Two premises that wave-24 code decisions rest on, re-checked every run: the repo-shape claim was
// REFUTED (so the engine deliberately has no sparse/submodule gate), and the subdir-apply claim was
// CONFIRMED as a silent rc-0 no-op (so the engine must require `rev-parse --show-toplevel` equality).
// If git ever moves either behaviour, these go red and the two decisions have to be revisited.
stage("probe: git repo-shape claims refuted", "node", [`${T}/probe-git-repo-shapes-924.mjs`]);
stage("probe: git apply from subdir is a silent no-op", "node", [`${T}/probe-git-apply-subdir-924.mjs`]);
// The ledger IS an acceptance artifact this wave: a hand-edited table row that loses a cell mis-renders a
// finding silently, and a one-shot script of mine already damaged it once (see 924.md "我自己的一次数据损坏").
stage("check: 924.md table blocks intact", "node", [`${T}/mdtables924.mjs`]);
// ...and the checker above must be able to go red: it has printed `inconsistent=0` for waves on end, and
// two real shapes (a row with no closing pipe, a headerless block) stayed invisible under its first rule.
stage("probe: ledger checker is load-bearing", "node", [`${T}/mdtables-guard924.mjs`]);
// The bridge's own lazy-proxy guards, asserted in the interpreter the module actually runs under.
stage("probe: bridge init guard (python)", "python", ["docs/proof/tools/bridge-guard924.py"]);
// The TS layer's own live cycle (real dsh candidates, real worktrees, apply + rollback). Billed, so
// it shares the --no-real switch with the engine's real-model legs.
if (!noReal) stage("accept: TS live model cycle", "node", [`${T}/accept-ts-924.mjs`]);
stage("probe: security invariants (repo engine)", "node", [`${T}/probe-any-924.mjs`], { env: { ...process.env, PROBE_ENGINE: `${REPO}/minimax-code-plugin/.minimax-plugin/mcp-server.mjs` } });
if (!fast) stage("engine e2e suite", "node", ["--test", "minimax-code-plugin/tests/e2e.test.mjs"]);
// Drain gap: the e2e suite's last cases kill engines, and an engine's shutdown wait is capped at 60 s
// (its cleanup has to reap process trees). Measured on the 2026-09-25 21:35 rehearsal: the very next
// stage's first tests ran 14x slow and two went red on candidate/validation budgets alone, while both
// were green in 7.9 s / 167 s when run alone. Sleeping here is cheaper than a red authoritative run
// whose numbers I then cannot use. This gap used to sit in front of the TS suite; that pairing is gone
// now (see the note at the TS stage's new position near the top), so what it protects downstream is the
// billed real-model legs of the two deployed copies.
if (!fast) sleepSync(65_000);
// Sync is opt-in AND the sync tool is read-only by default: a rehearsal must never deploy a file
// another writer is still editing. Without --sync this stage still fails on drift, it just does not write.
if (doSync) stage("sync deployed copies", "node", [`${T}/sync-deployed-924.mjs`, "--write"]);
else stage("deployed copies match repo (dry)", "node", [`${T}/sync-deployed-924.mjs`]);
// The host-config schema check ALSO compares the installed engines' bytes against the repo, so it has
// to run after the sync above: standing before it, a `--sync` run reported drift it was about to erase
// (measured 2026-09-25: stage 6 red on `installed1..jcode is 68e3b12a7f36, repo is f1aadaa4a146` while
// the very next stages probe the freshly synced copies), and a red gate row is a re-run of everything.
stage("gate: mcp.json vs agent-plugins schema", "node", [`${T}/mcp-config-924.mjs`]);
for (const [i, d] of DEPLOYED.entries()) {
  stage(`probe: invariants (deployed ${i + 1})`, "node", [`${T}/probe-any-924.mjs`], { env: { ...process.env, PROBE_ENGINE: d } });
  stage(`accept: stub cycle (deployed ${i + 1})`, "node", [`${T}/accept-deployed-924.mjs`, String(i + 1)]);
  if (!noReal) stage(`accept: REAL model cycle (deployed ${i + 1})`, "node", [`${T}/accept-deployed-924.mjs`, String(i + 1)], { env: { ...process.env, ACC_MODEL: "minimax/MiniMax-M3" } });
}
const bad = rows.filter((l) => l.startsWith("FAIL")).length;
// `stages run` used to count `rows.length`, which also holds the `↳` continuation lines: the metric
// disagreed with its own name (16 stages printed "stages run: 20"), and a downstream cross-check
// against the stage rows then aborts on a green run. Count the verdict rows; report the rest.
const stageRows = rows.filter((l) => /^(PASS|FAIL)/.test(l)).length;
// The table must declare what it did NOT run: a --fast --no-real pass reads identically to a full one
// otherwise, and the stub rows print the same marker as the real-model rows.
const mode = `${fast ? "--fast (suites skipped)" : "full suites"} · ${noReal ? "--no-real (model cycles skipped)" : "model cycles INCLUDED"} · ${doSync ? "--sync (installed copies WRITTEN)" : "installed copies NOT written"}`;
console.log(`\n================ FINAL GATE ================\nMODE: ${mode}\nstages run: ${stageRows}\n` + rows.join("\n"));
console.log(bad === 0 ? "\nFINAL GATE: ALL LAYERS GREEN" : `\nFINAL GATE: ${bad} FAILING STAGES`);
// Stamps in the log itself, so a downstream reader never has to trust its memory of when this ran:
// a ledger generator that guesses the window is one deleted temp file away from inventing it.
const endedAt = new Date();
console.log(`GATE_END=${endedAt.toISOString()}`);
// Repeat the opening sample INSIDE the summary block. `fill-table-924.mjs` deliberately reads only the
// last FINAL GATE block (so a two-run log can't publish run 1's verdict over run 2's rows) — and the
// first sample was printed before the banner, so no real log ever carried both stamps in one block. The
// publisher therefore aborted on every run since the meter existed (wave-27 F1, measured: LOAD_START at
// index 0 of the archived log, -1 inside the block).
console.log(`LOAD_START=${JSON.stringify(LOAD_START)}`);
console.log(`LOAD_END=${JSON.stringify(loadSample())}`);
console.log(`GATE_START=${new Date(endedAt.getTime() - process.uptime() * 1000).toISOString()}`);
console.log(`GATE_EXIT=${bad === 0 ? 0 : 1}`);
process.exit(bad === 0 ? 0 : 1);
