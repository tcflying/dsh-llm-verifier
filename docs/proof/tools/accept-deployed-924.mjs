// 924 final acceptance: drive the DEPLOYED engine copies exactly the way the hosts do —
// real MCP stdio frames, real git repositories, real apply/rollback against a working tree.
//
//   node "%TEMP%/accept-deployed-924.mjs"            # stub generator: proves the whole cycle
//   ACC_MODEL=minimax/MiniMax-M2 node ...            # real mcode: proves model work rides through
//   KEEP=1 node ...                                  # leave the temp dirs + print their paths
//   node "%TEMP%/accept-deployed-924.mjs" 2          # only the Nth copy (1-based)
//
// Stub mode is honest about what it proves: the engine's capture/validate/select/apply/rollback
// machinery, not the model's competence. Real-model mode is the only one that can show that.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const COPIES = [
  { host: "Codex/jcode -> .zcode", p: "C:/Users/datoo/.zcode/skills/llm-verifier/mcp-server.mjs" },
  { host: "MiniMax plugin", p: "C:/Users/datoo/.minimax/plugins/llm-verifier/.minimax-plugin/mcp-server.mjs" },
];
const only = Number(process.argv[2] || 0);
const KEEP = !!process.env.KEEP;
const STUB = !process.env.ACC_MODEL;
const MODEL = process.env.ACC_MODEL || "";
const TOKEN = STUB ? "deployed-stub-run" : "deployed-real-run";
const STUB_BIN = "G:/zcode-project/llm-verify/dsh-llm-verifier/docs/proof/tools/mcode-stub-924.cmd";
const TOOLS = ["verified_best_of", "select_verified_candidate", "apply_verified_winner",
  "rollback_verified_winner", "verifier_configure", "verifier_get_config"];

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  -> ${String(detail).replace(/\r?\n/g, " | ").slice(0, 260)}` : ""}`);
  if (!ok) failures += 1;
};
const g = (cwd, ...args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} -> ${r.status} ${r.stderr}`);
  return r.stdout;
};

function connect(ENGINE, data) {
  const env = { ...process.env, LLM_VERIFIER_DATA: data };
  if (STUB) env.LLM_VERIFIER_MCODE_BIN = STUB_BIN;
  const child = spawn(process.execPath, [ENGINE], { cwd: data, env, stdio: ["pipe", "pipe", "pipe"] });
  let buf = "", seq = 0;
  const pending = new Map();
  const err = [];
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id && pending.has(m.id)) { const w = pending.get(m.id); pending.delete(m.id); clearTimeout(w.t); w.res(m); }
    }
  });
  child.stderr.on("data", (d) => { if (err.length < 40) err.push(String(d).trim()); });
  const rpc = (method, params) => new Promise((res, rej) => {
    const id = ++seq;
    const t = setTimeout(() => { pending.delete(id); rej(new Error(`timeout: ${method}`)); }, STUB ? 180_000 : 600_000);
    pending.set(id, { res, t });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  return {
    rpc, err,
    async tool(name, args) {
      const m = await rpc("tools/call", { name, arguments: args });
      if (m.error) return { __error: m.error.message };
      const t = m.result?.content?.[0]?.text ?? "";
      if (m.result?.isError) return { __error: t };
      try { return JSON.parse(t); } catch { return { __text: t }; }
    },
    close: () => { try { child.stdin.end(); } catch {} try { child.kill(); } catch {} },
  };
}

const queue = only ? [COPIES[only - 1]].filter(Boolean) : COPIES;
if (queue.length === 0) {
  // A bad CLI index used to yield an empty queue, zero checks and the same OK banner a real pass
  // prints — an exit code that lied. Name the range instead.
  console.log(`\nDEPLOYED ACCEPTANCE FAILURES:\n - no installed copy at index ${only} (there are ${COPIES.length}); refusing to certify zero checks`);
  process.exit(1);
}
const summary = [];
for (const { host, p } of queue) {
  const tag = host.split(/[^A-Za-z0-9]/)[0] || host;
  console.log(`\n===== ${host} :: ${p}  [${STUB ? "stub generator" : `real mcode ${MODEL}`}]`);
  if (!existsSync(p)) { check(`${tag} engine file present`, false, p); continue; }
  const data = mkdtempSync(join(tmpdir(), `acc924-${tag}-`));
  const repo = mkdtempSync(join(tmpdir(), `acc924-repo-`));
  const e = connect(p, data);
  try {
    g(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "readme.md"), "baseline\n");
    g(repo, "add", "readme.md");
    g(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");

    await e.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "acc924", version: "1" } });
    const names = ((await e.rpc("tools/list", {})).result?.tools ?? []).map((t) => t.name);
    check(`${tag} tools/list has exactly the six tools`, TOOLS.every((t) => names.includes(t)) && names.length === 6, names.join(","));

    const cfgArgs = { enabled: true, candidateTimeoutMin: 6, totalTimeoutMin: 9, reviewTimeoutMin: 2 };
    if (MODEL) { cfgArgs.candidateModel = MODEL; cfgArgs.reviewerModel = MODEL; }
    const cfg = await e.tool("verifier_configure", cfgArgs);
    check(`${tag} verifier_configure saved`, cfg.saved === true, JSON.stringify(cfg));
    check(`${tag} get_config reports its own data dir`,
      String((await e.tool("verifier_get_config", {})).configPath ?? "").replace(/\\/g, "/").startsWith(data.replace(/\\/g, "/")),
      (await e.tool("verifier_get_config", {})).configPath);

    // A ceiling that is only in the code but not on the wire is a claim, not a guard.
    const tooBig = await e.tool("verifier_configure", { totalTimeoutMin: 99_999 });
    check(`${tag} totalTimeoutMin above the 7-day ceiling is refused`,
      String(tooBig.__error ?? "").includes("10080"), JSON.stringify(tooBig));
    const afterRefusal = await e.tool("verifier_get_config", {});
    check(`${tag} a refused configure left the stored config untouched`,
      afterRefusal.config?.totalTimeoutMin === 9, JSON.stringify(afterRefusal.config?.totalTimeoutMin));
    check(`${tag} an unknown setting is refused, not silently merged`,
      String((await e.tool("verifier_configure", { nonsenseKnob: 1 })).__error ?? "").includes("nonsenseKnob"), "see error text");
    // On a copy that still accepts an over-ceiling value this probe leaves the poisoned number
    // stored, and the run below would then self-abort for the wrong reason. Re-arm the probe config.
    const rearmed = await e.tool("verifier_configure", cfgArgs);
    check(`${tag} probe config re-armed after the range probes`, rearmed.config?.totalTimeoutMin === 9, rearmed.config?.totalTimeoutMin);

    const run = await e.tool("verified_best_of", {
      repoPath: repo,
      task: `Create a file named solution.txt in the repository root whose only line is: ${TOKEN}. Do not modify any other file.`,
      candidateCount: 1,
      validationCommand: "if not exist solution.txt exit 1",
    });
    console.log(`      run -> ${JSON.stringify(run).slice(0, 320)}`);
    if (run.status !== "winner_selected") {
      check(`${tag} run reaches winner_selected`, false, run.message || run.__error || run.status);
      if (run.reportPath && existsSync(run.reportPath))
        console.log("      report.md -> " + readFileSync(run.reportPath, "utf8").replace(/\r?\n/g, " | ").slice(0, 900));
      if (run.manifestPath && existsSync(run.manifestPath)) {
        const man = JSON.parse(readFileSync(run.manifestPath, "utf8"));
        console.log("      generation -> " + JSON.stringify(man.candidates?.[0]?.generation).slice(0, 500));
      }
      continue;
    }
    check(`${tag} run reaches winner_selected`, true, run.runId);

    const man = JSON.parse(readFileSync(run.manifestPath, "utf8"));
    const cand = man.candidates[0];
    const patch = readFileSync(cand.patchPath, "utf8");
    check(`${tag} captured patch carries the external work`, patch.includes("solution.txt") && patch.includes(`+${TOKEN}`), patch.slice(0, 220));
    check(`${tag} report discloses the dependency exclusion scope`,
      readFileSync(run.reportPath, "utf8").includes("Dependency exclusion: untracked `node_modules/` is dropped via the harness"));
    // The `## Cleanup` block in report.md is conditional on warnings existing (mcp-server.mjs:591);
    // the receipt for a clean run is the manifest field, asserted next.
    check(`${tag} cleanup ran and found nothing leaked`,
      Array.isArray(man.cleanupWarnings) && man.cleanupWarnings.length === 0, JSON.stringify(man.cleanupWarnings));
    // Prove the premise first: the manifest recorded where the worktree WAS, so this check
    // cannot pass by pointing at a path that never existed.
    const wt = cand.worktree && String(cand.worktree).replace(/\\/g, "/");
    check(`${tag} worktree path recorded in the manifest`, !!wt, wt || JSON.stringify(Object.keys(cand)));
    check(`${tag} that worktree is gone after cleanup`, !!wt && !existsSync(wt), wt);
    check(`${tag} selecting on a finished run is refused`,
      String((await e.tool("select_verified_candidate", { runId: run.runId, candidateId: "candidate-1", reason: "probe" })).__error ?? "").includes("expected review_pending"),
      "engine wording");

    const ap = await e.tool("apply_verified_winner", { runId: run.runId });
    check(`${tag} apply on a real repo`, ap.status === "applied", JSON.stringify(ap).slice(0, 220));
    check(`${tag} winner content on disk`, existsSync(join(repo, "solution.txt")), existsSync(join(repo, "solution.txt")) ? readFileSync(join(repo, "solution.txt"), "utf8").trim() : "missing");
    check(`${tag} a second apply of the same run is refused`,
      String((await e.tool("apply_verified_winner", { runId: run.runId })).__error ?? "").includes("status is applied"),
      "engine wording at mcp-server.mjs:1050");

    const rb = await e.tool("rollback_verified_winner", { runId: run.runId });
    check(`${tag} rollback restores the repo`, rb.status === "rolled_back", JSON.stringify(rb).slice(0, 220));
    check(`${tag} winner content removed by rollback`, !existsSync(join(repo, "solution.txt")));
    check(`${tag} baseline file survived the whole cycle`,
      existsSync(join(repo, "readme.md")) && readFileSync(join(repo, "readme.md"), "utf8") === "baseline\n");
    check(`${tag} repo clean after run->apply->rollback`, g(repo, "status", "--porcelain").trim() === "", g(repo, "status", "--porcelain"));
    // The engine deliberately allows re-apply from rolled_back (mcp-server.mjs:1050); prove the
    // whole cycle is repeatable rather than one-shot.
    const re = await e.tool("apply_verified_winner", { runId: run.runId });
    check(`${tag} re-apply after rollback works`, re.status === "applied", JSON.stringify(re).slice(0, 160));
    const re2 = await e.tool("rollback_verified_winner", { runId: run.runId });
    check(`${tag} second rollback restores again`, re2.status === "rolled_back" && g(repo, "status", "--porcelain").trim() === "", re2.status);
  } catch (err) {
    check(`${tag} cycle completed without throwing`, false, err instanceof Error ? err.message : String(err));
    if (err?.stderr) console.log("      stderr -> " + String(err.stderr).slice(0, 400));
  } finally {
    e.close();
    // Verdict first, then cleanup: an EPERM on Windows must neither mask nor fake a result,
    // and KEEP=1 retains the scene instead of deleting the evidence (a lesson from wave 9).
    console.log(`      ${STUB ? "stub" : "real"}: data=${data} repo=${repo}${KEEP ? "  (kept)" : ""}`);
    if (!KEEP) for (const d of [data, repo]) { try { rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (x) { console.log(`      cleanup of ${d} failed: ${x.message}`); } }
  }
  summary.push(`${host}: failures so far ${failures}`);
}
console.log("\n" + summary.join("\n"));
console.log(failures === 0 ? `\nDEPLOYED ACCEPTANCE OK (${STUB ? "stub" : "real mcode"})` : `\nDEPLOYED ACCEPTANCE FAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
