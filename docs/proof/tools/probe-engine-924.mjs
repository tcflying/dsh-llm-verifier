// 924 final audit — engine security invariants, run against the CURRENT mcp-server.mjs.
// No mcode needed: every negative test is proven by a marker file that only appears
// if the unvalidated value reaches cmd.exe. Usage: node "%TEMP%/probe-engine-924.mjs"
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const ENGINE = "G:/zcode-project/llm-verify/dsh-llm-verifier/minimax-code-plugin/.minimax-plugin/mcp-server.mjs";
const data = mkdtempSync(join(tmpdir(), "probe924-"));
const cfgPath = join(data, "config.json");
const mark = (n) => join(data, `PWNED_${n}.txt`);

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  -> ${String(detail).slice(0, 150)}` : ""}`);
  if (!ok) failures += 1;
};

function connect(extraEnv = {}) {
  const child = spawn(process.execPath, [ENGINE], {
    cwd: data,
    env: { ...process.env, LLM_VERIFIER_DATA: data, ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  const pending = new Map();
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const w = pending.get(msg.id);
      if (w) { pending.delete(msg.id); w(msg); }
    }
  });
  child.stderr.on("data", () => {});
  let seq = 0;
  const rpc = (method, params, id = ++seq) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout waiting for ${method}`)); }, 25_000);
    pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  const raw = (text) => child.stdin.write(text + "\n");
  return {
    child, rpc, notify, raw, pending,
    close: () => { try { child.stdin.end(); } catch {} try { child.kill(); } catch {} },
  };
}

const textOf = (m) => (m?.result?.content?.[0]?.text ?? m?.error?.message ?? JSON.stringify(m));

// ------------------------------------------------- 1. initialize gate + protocol echo
{
  const s = connect();
  let earlyRefused = false;
  try {
    const m = await s.rpc("tools/call", { name: "verifier_get_config", arguments: {} });
    earlyRefused = !!m.error || m.result?.isError === true;
  } catch (e) { earlyRefused = true; }
  check("E1 tools/call before initialize is refused", earlyRefused);
  const init = await s.rpc("initialize", { protocolVersion: "1999-99-99", capabilities: {} });
  const echoed = init.result?.protocolVersion;
  check("E2 foreign protocolVersion is not echoed back verbatim", echoed !== "1999-99-99", `got ${echoed}`);
  await s.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  const ok = await s.rpc("tools/call", { name: "verifier_get_config", arguments: {} });
  check("E3 a normal session still works after the gate", !ok.error && ok.result?.isError !== true, textOf(ok));
  s.close();
}

// ------------------------------------------------- 4. malformed frames must not kill the server
{
  const s = connect();
  await s.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  s.raw(JSON.stringify({ jsonrpc: "2.0", id: 900, method: 123 }));
  s.raw(JSON.stringify({ jsonrpc: "2.0", id: 901 }));
  s.raw('{"jsonrpc":"2.0","id":902,"method":"tools/call"');
  s.raw(JSON.stringify({ jsonrpc: "2.0", id: 903, method: null }));
  const ping = await s.rpc("ping", {});
  check("E4 server survives non-string method / missing method / truncated JSON", !!ping.result, JSON.stringify(ping).slice(0, 80));
  check("E5 exited cleanly during that burst", s.child.exitCode === null, `exitCode=${s.child.exitCode}`);
  s.close();
}

// ------------------------------------------------- 6. runId traversal
{
  const s = connect();
  await s.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  for (const bad of ["../../evil", "a/../../b", "..\\..\\evil", ""]) {
    const m = await s.rpc("tools/call", { name: "select_verified_candidate", arguments: { runId: bad, candidateId: "candidate-1", reason: "x" } });
    check(`E6 runId ${JSON.stringify(bad)} refused`, m.result?.isError === true || !!m.error, textOf(m));
  }
  s.close();
}

// ------------------------------------------------- 5. model injection, both doors
{
  const s = connect();
  await s.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  const m = await s.rpc("tools/call", {
    name: "verifier_configure",
    arguments: { candidateModel: `x&echo PWNED_A1>${mark("CFG")}` },
  });
  check("E7 configure refuses an injecting candidateModel", m.result?.isError === true || !!m.error, textOf(m));
  check("E8 no marker from the configure door", !existsSync(mark("CFG")));

  // second door: a value already sitting in config.json (older engine, hand edit)
  writeFileSync(cfgPath, JSON.stringify({
    enabled: true, defaultCandidateCount: 1, maxConcurrent: 1, reviewMode: "parent_agent",
    candidateTimeoutMin: 1, totalTimeoutMin: 1, reviewTimeoutMin: 1,
    candidateModel: `x&echo PWNED_USE>${mark("USE")}`,
  }), "utf8");
  const s2 = connect();
  await s2.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  const run = await s2.rpc("tools/call", {
    name: "verified_best_of",
    params: undefined,
    arguments: { repoPath: data, task: "prove the injection door is closed" },
  }, 500);
  const t = textOf(run);
  check("E9 pre-seeded model refused at spawn time (not silently run)", /not a permitted model|permitted model identifier|invalid model/i.test(t), t);
  check("E10 no marker from the use door", !existsSync(mark("USE")), "if this is FAIL the injection still executes");
  s2.close();
}

// ------------------------------------------------- 7. kill switch must fail closed
{
  const s = connect();
  await s.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  const bad = await s.rpc("tools/call", { name: "verifier_configure", arguments: { enabled: "false" } });
  check("E11 {enabled:\"false\"} is refused outright", bad.result?.isError === true || !!bad.error, textOf(bad));
  const off = await s.rpc("tools/call", { name: "verifier_configure", arguments: { enabled: false } });
  check("E12 {enabled:false} saves", off.result?.isError !== true && !off.error, textOf(off));
  const blocked = await s.rpc("tools/call", {
    name: "verified_best_of", arguments: { repoPath: data, task: "must not run while disabled" },
  });
  check("E13 best_of refuses while disabled", blocked.result?.isError === true, textOf(blocked));

  // torn config must fail CLOSED, not fall back to enabled defaults
  writeFileSync(cfgPath, '{"enabled":false,"totalTimeoutM', "utf8");
  const s3 = connect();
  await s3.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  const torn = await s3.rpc("tools/call", { name: "verifier_get_config", arguments: {} }, 700);
  const tornText = textOf(torn);
  check("E14 torn config is reported, not silently ignored", /corrupt|unreadable|invalid|configError|parse/i.test(tornText), tornText);
  const tornRun = await s3.rpc("tools/call", {
    name: "verified_best_of", arguments: { repoPath: data, task: "must not run on a torn config" },
  }, 701);
  check("E15 best_of refuses on a torn config (fail closed)", tornRun.result?.isError === true, textOf(tornRun));
  s3.close();
}

// ------------------------------------------------- 8. candidate bounds are enforced server-side
{
  const s = connect();
  await s.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  rmSync(cfgPath, { force: true });
  for (const n of [0, 2000, "2", 2.5]) {
    const m = await s.rpc("tools/call", {
      name: "verified_best_of", arguments: { repoPath: data, task: "bounds check", candidateCount: n },
    });
    check(`E16 candidateCount ${JSON.stringify(n)} refused server-side`, m.result?.isError === true, textOf(m));
  }
  s.close();
}

// Verdict first: a Windows EPERM while an engine child is still exiting must never
// mask or fake the conclusion (same ordering rule as accept-deployed-924.mjs).
console.log(failures === 0 ? "\nENGINE PROBE OK" : `\nENGINE PROBE FAILURES: ${failures}`);
try { rmSync(data, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 }); }
catch (e) { console.log(`(scratch dir left behind: ${data} — ${e.code})`); }
process.exit(failures === 0 ? 0 : 1);
