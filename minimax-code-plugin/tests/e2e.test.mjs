// Mock 全状态机 e2e：真 spawn 引擎 stdio + 假 mcode，覆盖隔离/评审/落地/回滚/重落地。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.join(here, "..", ".minimax-plugin", "mcp-server.mjs");
const IS_WIN = process.platform === "win32";
const fwd = (p) => p.replace(/\\/g, "/");
// 平台中立：check.js 是提交进各 scratch repo 的脚本，solution.txt 不在就以 1 退出。
const VALIDATE = "node check.js";

// env 驱动的 mcode 替身：candidate 模式写补丁，review 模式把 MOCK_REVIEW_JSON 当评审回执。
// 带 shebang + chmod，POSIX 直接 spawn、Windows 走 `node "<path>"` 前缀（shell:true 拼命令）。
const MOCK_SRC = `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
// 脚手架开关改从 <LLM_VERIFIER_DATA>/mock-env.json 拿（spawnEngine 写的）：引擎现在给每个子进程
// 的是白名单环境，设在引擎进程上的 MOCK_* 不再自动流进候选。只认这一个文件——测里想被候选看见的
// 东西必须走 opts.env；直接设在宿主 process.env 上的值（泄漏哨兵）就只该被"继承"看见。
try { Object.assign(process.env, JSON.parse(fs.readFileSync(
  path.join(process.env.LLM_VERIFIER_DATA, "mock-env.json"), "utf8"))); } catch {}
const a = process.argv.slice(2);
const cwd = a[a.indexOf("--cwd") + 1];
const id = path.basename(cwd) || "cand";
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
process.stdin.resume();
let stdin = "";
process.stdin.on("data", (d) => (stdin += d));
process.stdin.on("end", () => {
  const finish = () => {
    if (!id.startsWith("candidate-")) {
      // S5 测的注入点：评审这一枪顺手把每个 run 的 manifest.json 变成目录 → 引擎随后的终态
      // saveRun 必炸（N5 用的是同一个形状，只是钉在候选那一枪上）。
      if (process.env.MOCK_BREAK_RUN_MANIFEST) {
        const runs = path.join(process.env.LLM_VERIFIER_DATA || ".", "runs");
        for (const rid of fs.readdirSync(runs)) {
          const man = path.join(runs, rid, "manifest.json");
          try { if (fs.statSync(man).isFile()) { fs.rmSync(man, { force: true }); fs.mkdirSync(man); } } catch (e) {}
        }
      }
      // S6 测的缝：评审自报"已开始"（hit），再睡到被中止 —— 于是"取消有没有带走在飞的评审"
      // 是一个可见事实，不需要猜时间窗；睡够久，"没被中止"只会以它自己跑完现形。
      if (process.env.MOCK_REVIEW_HIT) fs.writeFileSync(process.env.MOCK_REVIEW_HIT, String(process.pid));
      const say = () => out({ schemaVersion: 1, type: "exec.result", status: "succeeded",
        output: process.env.MOCK_REVIEW_JSON || "done" });
      const rSleep = Number(process.env.MOCK_REVIEW_SLEEP_MS || 0);
      if (rSleep > 0) setTimeout(say, rSleep); else say();
      return;
    }
    if (!process.env.MOCK_NOOP) {
      const bytes = Number(process.env.MOCK_PATCH_BYTES || 0);
      fs.writeFileSync(path.join(cwd, "solution.txt"),
        "fixed by " + id + "\\n" + "x".repeat(bytes) + "\\n");
    }
    // 补丁抓取测：额外落一个 *.dat，让 git diff 命中仓库里配置的 textconv 门（见 GATE_SRC）。
    // MOCK_GATE_FREE 点名"哪个候选不走门"：抓取是逐候选按序的，于是"这个候选的补丁已经落盘、
    // 下一个正卡在 git 里"是可见事实，测不必猜时间窗（S21 用）。
    if (process.env.MOCK_GATE)
      fs.writeFileSync(path.join(cwd, id === process.env.MOCK_GATE_FREE ? "free.txt" : "probe.dat"), "gated\\n");
    // N1 测：往已有文件追加非 UTF-8 字节。git 只按"有没有 NUL"判文本，这些字节会原样进 diff 行。
    if (process.env.MOCK_RAW_BYTES)
      fs.appendFileSync(path.join(cwd, process.env.MOCK_RAW_NAME || "legacy.txt"),
        Buffer.from(process.env.MOCK_RAW_BYTES.split(",").map(Number)));
    // E1 测的探针：文件名走 mock-env.json，值只走 process.env —— 引擎给候选的白名单环境一破，
    // 哨兵就会随这个文件进补丁、进 manifest、进 report。
    if (process.env.MOCK_CANARY_FILE)
      fs.writeFileSync(path.join(cwd, process.env.MOCK_CANARY_FILE),
        "canary=[" + (process.env.MOCK_LEAK_CANARY || "") + "]\\n");
    // N5 测的注入点：manifest.json 变成目录 → 该候选随后的 saveRun 在 renameSync 上必炸
    if (process.env.MOCK_BREAK_MANIFEST && id === "candidate-1") {
      const man = path.join(path.resolve(cwd, "..", ".."), "manifest.json");
      fs.rmSync(man, { force: true, recursive: true });
      fs.mkdirSync(man);
    }
    // N5 测的注入点：harness.gitignore 变成目录 → 引擎随后的 writeFileSync 必炸（终态凭据测）
    if (process.env.MOCK_BREAK_HARNESS_EXCLUDES && id === "candidate-1") {
      const hx = path.join(path.resolve(cwd, "..", ".."), "harness.gitignore");
      fs.rmSync(hx, { force: true, recursive: true });
      fs.mkdirSync(hx);
    }
    out({ schemaVersion: 1, type: "exec.result", status: "succeeded", output: "done",
      sessionId: "mock-" + id, usage: { inputTokens: 100 + stdin.length, outputTokens: 10 } });
  };
  // N5 测：把自身 OS pid 记进 MOCK_PID_DIR，测才能力证"被中止的兄弟进程真的消失了"。
  // 必须在睡之前写：被中止的候选恰恰是永远走不到 finish 的那个。
  if (process.env.MOCK_PID_DIR && id.startsWith("candidate-")) {
    const d = process.env.MOCK_PID_DIR;
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, id + ".pid"), String(process.pid));
  }
  // MOCK_SLEEP_MS 是逐候选的逗号列表："25000,70000" = candidate-1 睡 25s、candidate-2 睡 70s
  const sleeps = String(process.env.MOCK_SLEEP_MS || "0").split(",");
  const n = Number(id.replace(/\\D+/g, "")) || 1;
  const sleep = Number(sleeps[n - 1] !== undefined ? sleeps[n - 1] : sleeps[0]) || 0;
  if (sleep > 0) setTimeout(finish, sleep); else finish();
});
`;

// validation 替身：先在别的进程里落一个"迟到标记"，再占住 hold 秒并以 3 退出。
// 迟到标记只有在超时把整棵进程组带走时才不会出现在盘上。
const VALHOLD_SRC = `#!/usr/bin/env node
const { spawn } = require("child_process");
const hold = Number(process.argv[2] || 30) * 1000;
const mark = process.argv[3];
const delay = Number(process.argv[4] || 20000);
spawn(process.execPath, ["-e",
  "setTimeout(function(){require('fs').writeFileSync(process.argv[1],'x')}, Number(process.argv[2]))",
  mark, String(delay)], { stdio: "ignore" });
setTimeout(function () { process.exit(3); }, hold);
`;

// E2 的夹具：先起一个 detached 且继承管道的孙进程，然后自己 300ms 退 0。孙进程活着就继续占着
// stdout/stderr 的写端，close（EOF）永远不来；cwd 落在临时目录，免得它把 git worktree remove
// 挡成"权限拒绝"，把这条测变成另一条测。
const PIPEHOLD_SRC = `#!/usr/bin/env node
const { spawn } = require("child_process");
const os = require("os");
const p = spawn(process.execPath, ["-e", "setTimeout(function(){},25000)"],
  { stdio: "inherit", detached: true, cwd: os.tmpdir() });
p.on("error", () => {});
p.unref();
setTimeout(function () { process.exit(0); }, 300);
`;

// 抓取门：git 的 textconv 过滤器，注册成 `*.dat diff=gate` 后 `git diff --cached --binary`
// 会真的调用它。它先自报存在（hit），然后原地阻塞到 release 出现 —— 于是"抓取正在进行"
// 是一个可见事实，测不再靠猜时间窗；窗口长度由 release 决定，不是 flaky 的 sleep。
const GATE_SRC = `#!/usr/bin/env node
const fs = require("fs");
const hit = process.argv[2], release = process.argv[3], maxMs = Number(process.argv[4] || 60000);
fs.writeFileSync(hit, String(process.pid));
const sleep = new Int32Array(new SharedArrayBuffer(4));
const t0 = Date.now();
while (!fs.existsSync(release) && Date.now() - t0 < maxMs)
  Atomics.wait(sleep, 0, 0, 100);
process.exit(0);
`;

let dir, repo, git, mock, bin, valhold, pipehold, gate, eng;
const engines = [];

const spawnEngine = async (opts = {}) => {
  const base = opts.baseDir || dir;
  const dataDir = path.join(base, "data-" + (opts.name || "main"));
  fs.mkdirSync(dataDir, { recursive: true });
  // 脚手架开关走文件、不走环境：引擎给每个子进程的是白名单环境（对齐 src/process.ts
  // sanitizedEnvironment），设在引擎上的 MOCK_* 再也到不了候选那一枪。
  fs.writeFileSync(path.join(dataDir, "mock-env.json"), JSON.stringify(opts.env || {}));
  const child = spawn(process.execPath, [ENGINE], {
    cwd: dir,
    env: {
      ...process.env,
      LLM_VERIFIER_DATA: dataDir,
      LLM_VERIFIER_MCODE_BIN: bin,
      ...(opts.env || {}),
    },
    stdio: ["pipe", "pipe", "inherit"],
  });
  let buf = "", seq = 0;
  const pending = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const m = JSON.parse(line);
      if (m.id && pending.has(m.id)) { pending.get(m.id).res(m); pending.delete(m.id); }
    }
  });
  child.on("close", (code) => {
    for (const { rej } of pending.values()) rej(new Error(`engine exited ${code}`));
    pending.clear();
  });
  const call = (method, params) => new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, { res, rej });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const tool = async (name, args) => {
    const r = await call("tools/call", { name, arguments: args });
    if (r.error) return { __error: r.error.message, __code: r.error.code };
    const t = r.result?.content?.[0]?.text ?? "";
    if (r.result?.isError) return { __error: t };
    try { return JSON.parse(t); } catch { return { __text: t }; }
  };
  const close = async () => {
    child.stdin.end();
    // already-exited engine (e.g. a test that hung up stdin): 'close' will never fire again
    if (child.exitCode === null && child.signalCode === null) await once(child, "close").catch(() => {});
  };
  const notify = (method, params) =>
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  const e = { child, pending, call, tool, notify, lastId: () => seq, close, dataDir };
  if (!opts.noInit) await call("initialize", INIT);
  engines.push(e);
  return e;
};

const INIT = { protocolVersion: "2025-03-26", capabilities: {} };
const call = (m, p) => eng.call(m, p);
const tool = (n, a) => eng.tool(n, a);

const mkRepo = (name) => {
  const p = path.join(dir, name);
  fs.mkdirSync(p, { recursive: true });
  const g = (...a) => spawnSync("git", a, { cwd: p, encoding: "utf8" });
  g("init", "-b", "main", ".");
  fs.writeFileSync(path.join(p, "base.js"), "module.exports = 1;\n");
  fs.writeFileSync(path.join(p, "check.js"),
    "if (!require('fs').existsSync('solution.txt')) process.exit(1);\n");
  g("-c", "user.name=t", "-c", "user.email=t@t", "add", "-A");
  g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "init");
  return { p, g };
};

// 造一份已 winner_selected 的 run（不经过 configure/模型），用来单测 apply 侧行为。
const seedRun = (e, { name, repoPath, patchText, validationCommand, status = "winner_selected" }) => {
  const runId = "20240101000000-abcde" + name.slice(-1);
  const runDir = path.join(e.dataDir, "runs", runId);
  fs.mkdirSync(runDir, { recursive: true });
  const patchPath = path.join(runDir, "candidate-1.patch");
  fs.writeFileSync(patchPath, patchText);
  const sha = crypto.createHash("sha256").update(fs.readFileSync(patchPath)).digest("hex");
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoPath, encoding: "utf8" }).stdout.trim();
  const man = {
    schemaVersion: 1, runId, task: "seeded", repoPath, baseCommit: head, status,
    deadlineAt: Date.now() + 60_000, createdAt: new Date().toISOString(),
    candidateCount: 1, config: { reviewMode: "parent_agent", totalTimeoutMin: 45, enabled: true },
    candidates: [{
      candidateId: "candidate-1", index: 1, generation: { status: "succeeded" },
      validation: { status: "passed", command: validationCommand },
      patchPath, patchSha256: sha, review: null,
    }],
    winnerId: "candidate-1", selectionMethod: "single_survivor", review: null, selection: null,
  };
  fs.writeFileSync(path.join(runDir, "manifest.json"), JSON.stringify(man, null, 2));
  return { runId, runDir, patchPath };
};

// 在 scratch repo 里造一个"能干净落地"的二进制补丁，然后把工作区还原干净。
const makePatch = (r, file, text) => {
  fs.writeFileSync(path.join(r.p, file), text);
  r.g("add", "-A");
  const d = spawnSync("git", ["diff", "--cached", "--binary"],
    { cwd: r.p, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  assert.equal(d.status, 0);
  r.g("reset", "-q");
  fs.rmSync(path.join(r.p, file));
  assert.equal(r.g("status", "--porcelain").stdout.trim(), "", "scratch repo 必须回到干净态");
  return d.stdout;
};

const readManifest = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// 轮询某个外部进程落下的文件：返回"等到了"，超时不抛 —— 断言留给调用方，报错才有上下文。
const until = async (p, ms = 60_000) => {
  for (let i = 0; i < ms / 100 && !fs.existsSync(p); i++) await wait(100);
  return fs.existsSync(p);
};
// 轮询一个 OS pid 是否真的消失（ESRCH）。返回等待毫秒数，超时仍活着返回 -1 ——
// 报错要点名"还活着"，而不是只说断言失败。
const pidGone = async (pid, ms = 90_000) => {
  for (let t = 0; t < ms; t += 200) {
    try { process.kill(pid, 0); }
    catch (e) { if (e.code === "ESRCH") return t; throw e; }
    await wait(200);
  }
  return -1;
};
const readPid = (dir, id) => Number(fs.readFileSync(path.join(dir, `${id}.pid`), "utf8"));
const worktrees = (r) => r.g("worktree", "list").stdout.trim().split(/\r?\n/).length;
const leakyBranches = (r) => r.g("branch", "--list", "llm-verifier/*").stdout.trim();

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "llmv-e2e-"));
  const r0 = mkRepo("origin");
  repo = r0.p;
  git = (...a) => spawnSync("git", a, { cwd: repo, encoding: "utf8" });

  mock = path.join(dir, "mock-mcode2.mjs");
  fs.writeFileSync(mock, MOCK_SRC);
  fs.chmodSync(mock, 0o755);
  bin = IS_WIN ? `node "${mock}"` : mock;
  valhold = path.join(dir, "valhold.cjs");
  fs.writeFileSync(valhold, VALHOLD_SRC);
  fs.chmodSync(valhold, 0o755);
  pipehold = path.join(dir, "pipehold.cjs");
  fs.writeFileSync(pipehold, PIPEHOLD_SRC);
  fs.chmodSync(pipehold, 0o755);
  gate = path.join(dir, "gate.cjs");
  fs.writeFileSync(gate, GATE_SRC);
  fs.chmodSync(gate, 0o755);

  eng = await spawnEngine({ name: "main" });
  await call("initialize", INIT);
});

after(async () => {
  for (const e of engines) await e.close().catch(() => {});
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (e) {
    console.warn(`临时目录未清干净（Windows 偶发 EPERM，%TEMP% 下无妨）: ${e.code}`);
  }
});

test("best-of-N 全状态机", async () => {
  const tools = (await call("tools/list", {})).result.tools;
  assert.equal(tools.length, 6, "6 个工具");

  const run = await tool("verified_best_of", {
    repoPath: repo, task: "fix it", candidateCount: 2, validationCommand: VALIDATE,
  });
  assert.equal(run.status, "review_pending", `两候选都过验证应待人工评审：${JSON.stringify(run)}`);
  assert.equal(run.candidates.length, 2);
  for (const c of run.candidates) {
    assert.equal(c.validation, "passed");
    assert.match(fs.readFileSync(c.patchPath, "utf8"), /solution\.txt/);
  }
  // 隔离契约：改动只留在 worktree，origin 工作区必须干净
  assert.equal(git("status", "--porcelain").stdout.trim(), "", "origin 工作区不该被动过");
  assert.equal(fs.existsSync(path.join(repo, "solution.txt")), false);
  // A12：run 结束后候选 worktree 与分支必须回收
  assert.equal(git("worktree", "list").stdout.trim().split(/\r?\n/).length, 1, "候选 worktree 应已移除");
  assert.equal(git("branch", "--list", "llm-verifier/*").stdout.trim(), "", "候选分支应已删除");

  assert.match((await tool("apply_verified_winner", { runId: run.runId })).__error, /expected winner_selected/);
  assert.match((await tool("select_verified_candidate", { runId: run.runId, candidateId: "candidate-9" })).__error, /unknown candidateId/);

  assert.equal((await tool("select_verified_candidate", { runId: run.runId, candidateId: "candidate-2" })).status, "winner_selected");
  assert.equal((await tool("apply_verified_winner", { runId: run.runId })).status, "applied");
  assert.match(fs.readFileSync(path.join(repo, "solution.txt"), "utf8"), /candidate-2/);

  assert.equal((await tool("rollback_verified_winner", { runId: run.runId })).status, "rolled_back");
  assert.equal(fs.existsSync(path.join(repo, "solution.txt")), false, "回滚后文件应消失");

  // rolled_back 是合法重落地态（DSH parity，踩坑 #4）
  assert.equal((await tool("apply_verified_winner", { runId: run.runId })).status, "applied");
  assert.equal((await tool("rollback_verified_winner", { runId: run.runId })).status, "rolled_back");

  // 落地后被人工改过 → 反向补丁不干净 → 拒绝回滚
  await tool("apply_verified_winner", { runId: run.runId });
  fs.writeFileSync(path.join(repo, "solution.txt"), "hand edited\n");
  assert.match((await tool("rollback_verified_winner", { runId: run.runId })).__error, /rollback refused/);
  git("checkout", "--", "solution.txt");
  git("clean", "-fd");
});

test("mcode_model 评审：解析失败不得伪造 winner", async () => {
  const run = await tool("verified_best_of", {
    repoPath: repo, task: "fix it", candidateCount: 2, validationCommand: VALIDATE,
    reviewMode: "mcode_model",
  });
  // mock 只回 "done"，不是合法评审 JSON → 裸 JSON 重试仍失败 → 不得伪造 winner，交回父代理
  assert.equal(run.status, "review_pending");
  assert.equal(run.winnerId, null);
  const man = readManifest(run.manifestPath);
  assert.equal(man.selectionMethod, "pending");
  assert.equal(man.review.scores.length, 0, "没有可用评分时不得留下评分");
  assert.equal(man.review.topRanked, null);
  // durationMs 是真测量值（有限、非负、远小于评审上限），不是常量占位
  assert.ok(Number.isFinite(man.review.durationMs) && man.review.durationMs >= 0 && man.review.durationMs < 60_000,
    `评审回执 durationMs 异常: ${JSON.stringify(man.review)}`);
});

test("enabled:false 只放行配置类工具", async () => {
  await tool("verifier_configure", { enabled: false });
  assert.match((await tool("verified_best_of", { repoPath: repo, task: "x" })).__error, /is disabled/);
  assert.equal((await tool("verifier_get_config", {})).config.enabled, false);
  await tool("verifier_configure", { enabled: true });
});

test("G0 安全护栏：模型名注入拒绝 / runId 穿越拒绝 / 坏帧不死 / 配置类型校验", { timeout: 30_000 }, async () => {
  // A1：model 名会拼进 shell:true 的 spawn，含 shell 元字符必须拒
  assert.match((await tool("verifier_configure", { candidateModel: "x&echo INJECTED" })).__error, /candidateModel/);
  assert.match((await tool("verifier_configure", { reviewerModel: "a;reboot" })).__error, /reviewerModel/);
  // A4：只接受真布尔；"false" 存进去后 loadConfig().enabled === false 是假的，杀开关失效
  assert.match((await tool("verifier_configure", { enabled: "false" })).__error, /enabled/);
  assert.match((await tool("verifier_configure", { defaultCandidateCount: "2" })).__error, /defaultCandidateCount/);
  assert.match((await tool("verifier_configure", { candidateTimeoutMin: null })).__error, /candidateTimeoutMin/);
  // 整数判定：2.5 / 1.5 这类"看起来像数字"的值必须在两个入口都被拒
  assert.match((await tool("verifier_configure", { defaultCandidateCount: 2.5 })).__error, /defaultCandidateCount/);
  assert.match((await tool("verified_best_of", { repoPath: repo, task: "x", candidateCount: 1.5 })).__error, /candidateCount must be an integer 1-5/);
  // 合法值照常通过，且只回滚坏 key 不影响好 key
  assert.equal((await tool("verifier_configure", { candidateModel: "minimax/MiniMax-M2" })).saved, true);
  await tool("verifier_configure", { candidateModel: "" });
  // A2：runId 直接 join 进 RUNS_DIR 路径，穿越格式必须在 loadRun 入口拒掉
  assert.match((await tool("select_verified_candidate", { runId: "../../evil", candidateId: "candidate-1" })).__error, /invalid runId/);
  assert.match((await tool("apply_verified_winner", { runId: "..\\..\\x\\manifest" })).__error, /invalid runId/);
  assert.match((await tool("rollback_verified_winner", { runId: "nope" })).__error, /invalid runId/);
  // A5：截断的 manifest 必须报"损坏"而不是"不存在"（回滚线索不能被状态写入本身销毁）
  const fakeDir = path.join(dir, "data-main", "runs", "20200101000000-abcdef");
  fs.mkdirSync(fakeDir, { recursive: true });
  fs.writeFileSync(path.join(fakeDir, "manifest.json"), '{"runId":"20200101000000-abcdef","sta');
  assert.match((await tool("rollback_verified_winner", { runId: "20200101000000-abcdef" })).__error, /corrupt/);
  assert.match((await tool("rollback_verified_winner", { runId: "20200101000001-abcdef" })).__error, /not found/);
  // A3：非字符串 method 曾是 uncaught TypeError → 进程死；现在必须回 -32600 且继续服务
  const badFrame = new Promise((res) => eng.pending.set(999999, { res, rej: res }));
  eng.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 999999, method: 123 }) + "\n");
  assert.equal((await badFrame).error.code, -32600, "坏帧必须收到 JSON-RPC -32600 错误应答");
  assert.ok((await call("ping", {})).result, "坏帧后服务器必须还能答 ping");
  assert.equal((await tool("verifier_get_config", {})).config.enabled, true, "坏配置未污染开关");
});

test("协议关卡：initialize 之前的 tools/call 必须被拒", async () => {
  const e = await spawnEngine({ name: "initgate", noInit: true });
  try {
    const early = await e.call("tools/call", { name: "verifier_get_config", arguments: {} });
    assert.equal(early.error?.code, -32600, `未 initialize 不得提供服务端能力: ${JSON.stringify(early)}`);
    assert.match(early.error.message, /not initialized/);
    await e.call("initialize", INIT);
    assert.equal((await e.tool("verifier_get_config", {})).config.enabled, true);
  } finally { await e.close(); }
});

test("config.json 撕裂 = 故障关闭（不得回填 enabled:true）", async () => {
  const e = await spawnEngine({ name: "torn" });
  try {
    const cfgPath = path.join(e.dataDir, "config.json");
    // 上一次写只落了一半：评审开关曾是 false，现在读不回来
    fs.writeFileSync(cfgPath, '{"enabled":false,"totalTimeoutM');
    const r = await e.tool("verified_best_of", { repoPath: repo, task: "x" });
    assert.match(r.__error, /unparseable JSON/, `不可解析的配置必须拒跑: ${JSON.stringify(r)}`);
    assert.match(r.__error, /config\.json/, "错误里必须报出是哪个文件");
    const g = await e.tool("verifier_get_config", {});
    assert.equal(g.config.enabled, false, "坏配置期间验证器必须视为关闭");
    assert.match(g.config.configError, /unparseable/);
    // 文件不存在 ≠ 文件读不回：absent 仍走默认值（能力在线）
    fs.rmSync(cfgPath);
    assert.match((await e.tool("verified_best_of", { repoPath: path.join(dir, "not-a-repo"), task: "x" })).__error,
      /not a git work tree/);
  } finally { await e.close(); }
});

test("writeJson 临时文件名唯一：残留 config.json.tmp 不得 brick 配置面", async () => {
  const e = await spawnEngine({ name: "tmpname" });
  try {
    // 定长 .tmp 被并发 rename 抢走时是 ENOENT，被占住时是 EISDIR —— 都是把配置面写死
    fs.mkdirSync(path.join(e.dataDir, "config.json.tmp"));
    assert.equal((await e.tool("verifier_configure", { maxConcurrent: 2 })).saved, true);
    assert.equal((await e.tool("verifier_configure", { maxConcurrent: 3 })).saved, true);
    const extra = fs.readdirSync(e.dataDir).filter((f) => /\.tmp$/.test(f) && f !== "config.json.tmp");
    assert.deepEqual(extra, [], "临时文件必须在 rename 后消失（残留说明写盘没收口）");
  } finally { await e.close(); }
});

test("模型白名单在 spawn 使用点拦截（绕过 configure 预置 config.json）", async () => {
  const e = await spawnEngine({ name: "modeluse" });
  try {
    const marker = fwd(path.join(dir, "modeluse-PWNED.txt"));
    fs.writeFileSync(path.join(e.dataDir, "config.json"), JSON.stringify({
      candidateModel: `x&echo pwned>${marker}`,
    }));
    const r = await e.tool("verified_best_of", { repoPath: repo, task: "x", candidateCount: 1, validationCommand: VALIDATE });
    assert.match(r.__error, /candidateModel .*not a permitted model identifier/, `使用点必须抛: ${JSON.stringify(r)}`);
    assert.equal(fs.existsSync(marker), false, "被污染模型名绝不该进到 shell —— 探针里它会建出 PWNED 文件");
    // 评审路径同样要在 argv 组装处被拦（旧 config.json 只过 validateConfig 是拦不住的）
    fs.writeFileSync(path.join(e.dataDir, "config.json"), JSON.stringify({
      reviewerModel: `y&echo pwned>${marker}`,
    }));
    const r2 = await e.tool("verified_best_of", {
      repoPath: repo, task: "x", candidateCount: 1, validationCommand: VALIDATE, reviewMode: "mcode_model",
    });
    assert.match(r2.__error, /reviewerModel .*not a permitted model identifier/, JSON.stringify(r2));
    assert.equal(fs.existsSync(marker), false);
    // 抛错路径也必须回收 worktree/分支（cleanup 只在成功路径调用 = 每次坏配置漏 N 个）
    const wt = spawnSync("git", ["worktree", "list"], { cwd: repo, encoding: "utf8" }).stdout.trim().split(/\r?\n/);
    assert.equal(wt.length, 1, `异常退出泄漏 worktree: ${wt.join(" | ")}`);
    const br = spawnSync("git", ["branch", "--list", "llm-verifier/*"], { cwd: repo, encoding: "utf8" }).stdout.trim();
    assert.equal(br, "", `异常退出泄漏候选分支: ${br}`);
  } finally { await e.close(); }
});

test("评审谎报：空 scores / 改判 reviewer 选择", async () => {
  // (a) scores 为空但 selected 有值 —— 旧代码会给它盖上 model_review 的章
  const a = await spawnEngine({ name: "emptyscores", env: { MOCK_REVIEW_JSON: '{"scores":[],"selected":"candidate-1"}' } });
  try {
    const run = await a.tool("verified_best_of", {
      repoPath: repo, task: "x", candidateCount: 2, validationCommand: VALIDATE, reviewMode: "mcode_model",
    });
    assert.equal(run.status, "review_pending", `空评分不是裁决: ${JSON.stringify(run)}`);
    assert.equal(run.selectionMethod, "pending");
    assert.equal(run.winnerId, null);
    const man = readManifest(run.manifestPath);
    assert.equal(man.selectionMethod, "pending");
    assert.equal(man.winnerId, null);
  } finally { await a.close(); }

  // (b) reviewer 明确选 candidate-2，评分排序是 1>2 —— 引擎不得改判还署它的名
  const b = await spawnEngine({ name: "disagree", env: {
    MOCK_REVIEW_JSON: '{"scores":[{"candidateId":"candidate-1","score":90},{"candidateId":"candidate-2","score":40}],"selected":"candidate-2"}',
  } });
  try {
    const run = await b.tool("verified_best_of", {
      repoPath: repo, task: "x", candidateCount: 2, validationCommand: VALIDATE, reviewMode: "mcode_model",
    });
    assert.equal(run.winnerId, "candidate-2", `必须尊重 reviewer 自己的选择: ${JSON.stringify(run)}`);
    assert.equal(run.selectionMethod, "model_review");
    const man = readManifest(run.manifestPath);
    assert.equal(man.review.reviewerSelected, "candidate-2");
    assert.equal(man.review.topRanked, "candidate-1", "分数分歧要被记下来，而不是被悄悄抹平");
    assert.equal(man.review.scores.length, 2);
  } finally { await b.close(); }

  // (c) selected 根本不在被评过的候选里 —— 同样不得凭 top 补一个 winner
  const c = await spawnEngine({ name: "unknownpick", env: {
    MOCK_REVIEW_JSON: '{"scores":[{"candidateId":"candidate-1","score":90}],"selected":"candidate-7"}',
  } });
  try {
    const run = await c.tool("verified_best_of", {
      repoPath: repo, task: "x", candidateCount: 2, validationCommand: VALIDATE, reviewMode: "mcode_model",
    });
    assert.equal(run.status, "review_pending");
    assert.equal(run.winnerId, null);
  } finally { await c.close(); }
});

test(">1MiB 补丁不得被写成空补丁", async () => {
  const e = await spawnEngine({ name: "bigpatch", env: { MOCK_PATCH_BYTES: "1600000" } });
  try {
    const run = await e.tool("verified_best_of", { repoPath: repo, task: "x", candidateCount: 1, validationCommand: VALIDATE });
    const man = readManifest(run.manifestPath);
    const c = man.candidates[0];
    assert.equal(c.patchError, null, `大补丁抓取不能被截成空: ${JSON.stringify(c)}`);
    assert.ok(fs.statSync(c.patchPath).size > 1024 * 1024, "补丁必须完整落盘");
    assert.equal(c.validation.status, "passed");
    // 单候选 + 完整补丁 → 仍是合法的 single_survivor（空补丁时会变成 no_winner）
    assert.equal(run.status, "winner_selected");
    assert.equal(run.selectionMethod, "single_survivor");
  } finally { await e.close(); }
});

test("validationCommand 必须真的执行；落盘状态 == 返回状态；空补丁拒绝落地", async () => {
  const e = await spawnEngine({ name: "applyvalid" });
  const r = mkRepo("applyrepo");
  // 带内层引号是 cmd.exe 手工拼接的照妖镜：那条路径下它 100ms 退出 0 且什么都不执行。
  const failCmd = `node -e "require('fs').writeFileSync('validation-ran.txt','x');process.exit(3)"`;
  try {
    const patch = makePatch(r, "feature.txt", "added by candidate\n");
    // 这条命令既是"故意失败"（exit 3），也会留下 validation-ran.txt 证明它被执行过
    const { runId, runDir } = seedRun(e, {
      name: "a", repoPath: r.p, patchText: patch, validationCommand: failCmd,
    });
    const out = await e.tool("apply_verified_winner", { runId });
    assert.equal(out.validation?.status, "failed", `失败命令必须报失败: ${JSON.stringify(out)}`);
    assert.equal(out.validation?.exitCode, 3, "退出码要能穿过 shell 传回来（cmd /c 手工拼接时会变成 0）");
    assert.equal(fs.existsSync(path.join(r.p, "validation-ran.txt")), true, "验证命令没被执行 = 校验是假的");
    assert.equal(out.status, "applied_validation_failed");
    const man = readManifest(path.join(runDir, "manifest.json"));
    assert.equal(man.status, out.status, "manifest 状态必须与返回状态一致");
    assert.match(fs.readFileSync(path.join(runDir, "report.md"), "utf8"), /applied_validation_failed/,
      "report 也得跟着返回状态，不能停在 applied");
    // 失败态正是回滚要能处理的入口
    fs.rmSync(path.join(r.p, "validation-ran.txt"));
    assert.equal((await e.tool("rollback_verified_winner", { runId })).status, "rolled_back");
    assert.equal(fs.existsSync(path.join(r.p, "feature.txt")), false);

    // 空补丁 = 抓取失败，不能当"已验证成果"落地（git 自己的 "no valid patches" 报错不算拦住）
    const empty = seedRun(e, { name: "b", repoPath: r.p, patchText: "", validationCommand: failCmd });
    assert.match((await e.tool("apply_verified_winner", { runId: empty.runId })).__error,
      /winner patch .* is empty/);
  } finally { await e.close(); }
});

test("无 diff 的候选不得被当成已验证成果", async () => {
  const e = await spawnEngine({ name: "nodiff", env: { MOCK_NOOP: "1" } });
  try {
    // 验证命令恒定成功 → 拦住它的只可能是"补丁是空的"这条
    const run = await e.tool("verified_best_of", {
      repoPath: repo, task: "x", candidateCount: 1, validationCommand: "exit 0",
    });
    const man = readManifest(run.manifestPath);
    assert.equal(man.candidates[0].validation.status, "passed", "前置条件：验证确实过了");
    assert.match(man.candidates[0].patchError, /no diff/, `空补丁要记账: ${JSON.stringify(man.candidates[0])}`);
    assert.equal(run.status, "no_winner", `抓不到补丁的候选不具备资格: ${JSON.stringify(run)}`);
    assert.equal(run.winnerId, null);
    // 报告里必须看得见抓取失败：否则 no_winner 读起来像"模型没做出来"
    assert.match(fs.readFileSync(path.join(path.dirname(run.manifestPath), "report.md"), "utf8"),
      /Patch capture.*no diff/, "buildReport 不得只留 succeeded/passed 却藏掉 patchError");
  } finally { await e.close(); }
});

// candidate-1 睡 25s 后进入 60s 的验证；candidate-2 一路睡到 70s（越过 60s 死线）。
// 死线一到：在飞的模型调用必须当场掐掉（不能等它自己 +30s 的宽限计时器），
// 在飞的验证进程要连同子孙一起带走（POSIX 靠进程组，Windows 靠 taskkill /T）。
test("totalTimeoutMin 是全阶段遵守的真死线（含进程组回收）", { timeout: 240_000 }, async () => {
  const mark = path.join(dir, "grandchild-marker.txt");
  fs.rmSync(mark, { force: true });
  const e = await spawnEngine({ name: "deadline", env: { MOCK_SLEEP_MS: "25000,70000" } });
  try {
    assert.equal((await e.tool("verifier_configure", { totalTimeoutMin: 1 })).saved, true);
    const t0 = Date.now();
    const run = await e.tool("verified_best_of", {
      repoPath: repo, task: "x", candidateCount: 2, maxConcurrent: 2,
      validationCommand: `node "${fwd(valhold)}" 60 "${fwd(mark)}" 45000`,
    });
    const elapsed = Date.now() - t0;
    assert.equal(run.status, "timeout", `60s 死线必须中止 run: ${JSON.stringify(run)}`);
    // 墙钟只当"根本没停"的失控闸：桌面有负载时 60s 死线实测 77.5s 才回。
    // "各阶段各等自己计时器"那种旧形状由上面的语义断言判（status/generation/validation/winnerId），
    // 不靠秒数——秒数在慢机器上只会误红，91 s 的余量也不是任何行为的判据。
    assert.ok(elapsed < 180_000, `run 必须停下，实耗 ${elapsed}ms`);
    assert.notEqual(run.candidates[1].generation, "succeeded",
      "死线到了还在睡的模型调用不得算成功生成（不能被 +30s 宽限救回来）");
    assert.ok(run.candidates.every((c) => c.validation !== "passed"),
      `被超时杀掉的验证不得算通过: ${JSON.stringify(run.candidates)}`);
    assert.equal(run.winnerId, null);
    await wait(15_000);   // 迟到标记原定在 t≈70s 落盘
    assert.equal(fs.existsSync(mark), false, "超时只杀直接子进程会留下孙进程继续改盘（POSIX 需进程组）");
  } finally { await e.close(); }
});

// T1：宿主消失（stdin 关闭）不得等于"就地 process.exit"。当场退出会让 finally  Cleanup 全丢：
// manifest 冻结在 running、worktree/分支外泄、候选进程在服务器死后十几秒还在写用户仓库的副本。
test("stdin 断开：中止在飞的 run、回收进程树，然后才退出", { timeout: 300_000 }, async () => {
  const mark = fwd(path.join(dir, "disconnect-grandchild-marker.txt"));
  const vstart = fwd(path.join(dir, "disconnect-validation-started.txt"));
  fs.rmSync(mark, { force: true }); fs.rmSync(vstart, { force: true });
  const r = mkRepo("disconrepo");
  const e = await spawnEngine({ name: "disconnect" });
  // 不 await：这条 run 的答复永远不会有 —— 宿主就是在这时候挂断的
  e.tool("verified_best_of", {
    repoPath: r.p, task: "x", candidateCount: 1, maxConcurrent: 1,
    // 验证一启动就自报（vstart），其孙进程在 start+15s 落 mark：断连时它还活着就会被看见
    validationCommand: `node -e "require('fs').writeFileSync('${vstart}','x')" && ` +
      `node "${fwd(valhold)}" 60 "${mark}" 15000`,
  }).catch(() => ({}));
  assert.ok(await until(vstart, 150_000), "验证没启动 → 断连测失去意义");
  e.child.stdin.end();              // 宿主挂断
  const [code] = await once(e.child, "close");
  assert.equal(code, 0, "断连后服务器必须自己退出（不能挂着等宿主）");
  const runs = fs.readdirSync(path.join(e.dataDir, "runs"));
  assert.equal(runs.length, 1, `应留下一条记账的 run: ${runs.join(",")}`);
  const man = readManifest(path.join(e.dataDir, "runs", runs[0], "manifest.json"));
  assert.equal(man.status, "cancelled", `manifest 不得冻结在 ${man.status} —— 断连也要走完 finally 收尾`);
  assert.equal(worktrees(r), 1, "断连不得留下检出的 worktree（那是用户仓库的活副本）");
  assert.equal(leakyBranches(r), "", "断连不得留下候选分支");
  await wait(20_000);               // 越过 start+15s 那个写盘点
  assert.equal(fs.existsSync(mark), false, "服务器死后还有子孙在写盘 = 断连没收走进程树");
});

// T2：补丁抓取必须是异步 spawn。抓取是 run 里最后一段同步 spawnSync：6000 文件的实测把事件
// 循环冻住 33.7s，期间 totalTimeoutMin 死线和 notifications/cancelled 都点不着火。
// 用 git 的 textconv 门把"正在抓取"变成可见事实，于是这条测不需要猜时间窗。
test("补丁抓取是异步的：抓取期间 ping 有应答，取消能掐断在飞的 git diff", { timeout: 300_000 }, async () => {
  const hit = path.join(dir, "gate-hit.txt"), release = path.join(dir, "gate-release.txt");
  fs.rmSync(hit, { force: true }); fs.rmSync(release, { force: true });
  const r = mkRepo("caprepo");
  r.g("config", "diff.gate.textconv",
    `node "${fwd(gate)}" "${fwd(hit)}" "${fwd(release)}" 240000`);
  fs.writeFileSync(path.join(r.p, ".gitattributes"), "*.dat diff=gate\n");
  r.g("-c", "user.name=t", "-c", "user.email=t@t", "add", "-A");
  r.g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "textconv gate");
  const e = await spawnEngine({ name: "capture", env: { MOCK_GATE: "1" } });
  try {
    const runP = e.tool("verified_best_of", {
      repoPath: r.p, task: "x", candidateCount: 1, validationCommand: VALIDATE,
    }).catch(() => ({}));
    const runId = e.lastId();   // call() 同步自增，返回时这条 run 的请求 id 已定
    // 抓取还没开始 run 就返回 = 前置阶段报错，把响应打出来，别让它顶替真正的断言
    const raced = await Promise.race([until(hit, 150_000).then(() => null), runP]);
    assert.equal(raced, null, `run 在补丁抓取开始前就返回了: ${JSON.stringify(raced)}`);
    assert.ok(fs.existsSync(hit), "git diff 没触发 textconv 门 → 抓取路径已变，本测失去意义");
    // 此刻抓取正阻塞在外部过滤器里：同步 spawnSync 会把 ping 一起冻死（门要到 finally
    // 放行才解，所以"冻住"这一侧是不看钟的；10s 只是给健康循环留的负载余量）
    const pong = await Promise.race([e.call("ping", {}), wait(10_000).then(() => null)]);
    assert.ok(pong?.result, "补丁抓取期间 ping 得不到回应 = 事件循环被同步 spawn 冻住");
    e.notify("notifications/cancelled", { requestId: runId });
    const run = await runP;
    assert.match(run.__error, /cancelled by host/, `取消必须在抓取处生效: ${JSON.stringify(run)}`);
    const man = readManifest(path.join(e.dataDir, "runs", fs.readdirSync(path.join(e.dataDir, "runs"))[0], "manifest.json"));
    assert.equal(man.status, "cancelled");
    assert.match(man.candidates[0].patchError, /diff capture failed/,
      "被掐断的抓取必须记成抓取失败，而不是空补丁");
    assert.equal(worktrees(r), 1, "取消后 worktree 必须回收");
    assert.equal(leakyBranches(r), "", "取消后分支必须删除");
  } finally {
    fs.writeFileSync(release, "x");   // 兜底放行：抓取被修坏时门不能永远夹着进程
    fs.rmSync(hit, { force: true });
    await e.close();
  }
  assert.equal(fs.existsSync(path.join(r.p, "probe.dat")), false, "候选改动不得漏进 origin 工作区");
});

// S21/S22 共用的夹具：把"抓取正卡在 candidate-2 上"变成可见事实。
// candidate-1 经 MOCK_GATE_FREE 写非门文件 ⇒ 它的补丁必然已经冻结完成（冻结是逐候选按序的）；
// candidate-2 写 *.dat ⇒ 卡在 textconv 门外，直到 release 出现。于是死线到点时盘上确切有 1 个
// 带补丁的幸存者，测不需要猜时间窗。
async function heldAtCapture(caseName) {
  const hit = path.join(dir, `${caseName}-capture-hit.txt`);
  const release = path.join(dir, `${caseName}-capture-release.txt`);
  const reviewHit = path.join(dir, `${caseName}-review-hit.txt`);
  fs.rmSync(hit, { force: true }); fs.rmSync(release, { force: true }); fs.rmSync(reviewHit, { force: true });
  const r = mkRepo(`${caseName}repo`);
  r.g("config", "diff.gate.textconv",
    `node "${fwd(gate)}" "${fwd(hit)}" "${fwd(release)}" 300000`);
  fs.writeFileSync(path.join(r.p, ".gitattributes"), "*.dat diff=gate\n");
  r.g("-c", "user.name=t", "-c", "user.email=t@t", "add", "-A");
  r.g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", `textconv gate for ${caseName}`);
  const e = await spawnEngine({ name: caseName, env: {
    MOCK_GATE: "1", MOCK_GATE_FREE: "candidate-1",
    MOCK_REVIEW_HIT: fwd(reviewHit), MOCK_REVIEW_SLEEP_MS: "240000",
  } });
  return { e, r, hit, release, reviewHit };
}

// S21：死线吃掉的是"评审"那一步的预算时，不得去起评审。
// 与「totalTimeoutMin 是真死线」那条的区别就在前提上：那条是 passed 为空（报 timeout 本来就对），
// 这条是 passed 有一个带补丁的幸存者 —— 旧代码在这里会照常落进评审阶段：白起一棵注定被打断的
// mcode 树（还要重试一次），最后塌成 review_pending，冒充"评审真跑了但弃权"。
// 两条判据都不看钟：状态必须是 timeout；评审那一枪根本不能响（MOCK_REVIEW_HIT 的"真起评审就一定
// 会出现"由 S6 钉着，所以这里"没出现"不是空断言）。
test("S21：死线到期时只剩一个带补丁的幸存者，也不得去起一次注定被打断的评审", { timeout: 420_000 }, async () => {
  const { e, r, hit, release, reviewHit } = await heldAtCapture("s21");
  let run;
  try {
    // 2 分钟而不是 1 分钟：前提要求"卡住发生在死线之前"，而那之前是生成 + 验证 + candidate-1 的抓取。
    // 负载机器上那几步能涨到十几秒，1 分钟的窗口会把慢机器判成红（波次 22 F4 同一个教训）。
    assert.equal((await e.tool("verifier_configure", { totalTimeoutMin: 2 })).saved, true);
    const runP = e.tool("verified_best_of", {
      repoPath: r.p, task: "x", candidateCount: 2, maxConcurrent: 2,
      validationCommand: VALIDATE, reviewMode: "mcode_model",
    }).catch(() => ({}));
    const early = await Promise.race([until(hit, 150_000).then(() => null), runP]);
    assert.equal(early, null, `run 在 candidate-2 的抓取卡住之前就返回了，本测失去意义: ${JSON.stringify(early)}`);
    // 上面那条 race 判不了"门到底响没响"：`until()` 超时是 resolve(false)，而 `.then(() => null)`
    // 把 true/false 一律映成 null ⇒ "门一次没响、run 只是慢到 150s 以上"这种情况照样绿。前提单独钉。
    assert.ok(fs.existsSync(hit), "git diff 没触发 textconv 门 → 抓取路径已变，本测判的不再是'死线落在冻结里'");
    run = await runP;
  } finally {
    fs.writeFileSync(release, "x");   // 兜底放行：抓取路径被改坏时门不能永远夹着进程
    await e.close();
  }
  const runs = fs.readdirSync(path.join(e.dataDir, "runs"));
  assert.equal(runs.length, 1, `应留下一条记账的 run: ${runs.join(",")}`);
  const man = readManifest(path.join(e.dataDir, "runs", runs[0], "manifest.json"));
  const shapes = JSON.stringify(man.candidates.map((c) => [c.candidateId, c.generation?.status, c.validation?.status, c.patchError ? "patchError" : "patch"]));
  // `.catch(() => ({}))` 只是为了让上面那个 race 不因预期的拒绝而炸；这里必须点名"它没有以错误收场"，
  // 否则一条崩掉的 run 也能靠 manifest 上残留的 timeout 蒙过下面几条断言。
  assert.equal(run?.__error, undefined, `工具必须回一条终态而不是错误: ${JSON.stringify(run)}`);
  assert.equal(run.status, "timeout",
    `死线吃掉评审预算必须报 timeout，不得塌成 review_pending 冒充弃权: ${shapes} method=${man.selectionMethod}`);
  // 前提（不是断言的副产品）：必须确切 1 个带补丁的幸存者 + 1 个卡在抓取里被掐掉的候选。
  // 前提塌了的话，这条测就会悄悄退化成"passed 为空"那种本来就该报 timeout 的老形状。
  assert.ok(!man.candidates[0].patchError && man.candidates[1].patchError,
    `前提塌了，需要 1 个已落补丁的幸存者和 1 个抓取被掐的候选: ${shapes}`);
  assert.equal(man.status, run.status, `盘上记账必须和返回一致: ${JSON.stringify({ ret: run.status, man: man.status })}`);
  assert.equal(man.winnerId, null, `timeout 不得同时给出胜者: ${shapes}`);
  assert.equal(fs.existsSync(reviewHit), false, `评审被起了 = 白烧一枪（mcode 替响即证据）: ${shapes}`);
  // patchError 必须点名 `git diff`：死线得是掐在冻结里的。`git add` 失败、64 MiB 上限之类也能造出
  // 一条"有 patchError 的候选 2"，那时这条测判的就是另一件事（而 :1102 那句 aborted 守卫同样不含
  // "git diff"，所以它红的时候说明死线早于冻结开始 —— 前提真的没了，红得对）。
  assert.match(man.candidates[1].patchError ?? "", /git diff/u,
    `candidate-2 的抓取失败必须来自被掐断的 git diff: ${JSON.stringify(man.candidates[1].patchError)}`);
  assert.equal(worktrees(r), 1, "死线掐断冻结之后 worktree 必须回收（被杀的是带着 node 孙进程的 git）");
  assert.equal(leakyBranches(r), "", "死线掐断冻结之后不得留下候选分支");
});

// S22：死线吃掉预算、但**判决并不需要评审**时（出厂默认 reviewMode 就是 parent_agent，见 :41），
// 必须把已经落盘的幸存者交出去，而不是把整个 run 折成 timeout。这是引擎侧的 N31/F1：旧代码那句
// 无条件 `deadline.signal.aborted → timeout` 会连"盘上已经有一份可用补丁"一起丢掉，宿主于是既
// select 不了也 apply 不了，几轮模型花费白烧。
// 前提与 S21 同一套夹具（candidate-1 的补丁已冻结、candidate-2 卡在门外被掐），所以这条测确实
// 走在"有幸存者"那一格上；旧代码在这里回 timeout，收窄之后回 winner_selected + 单幸存者。
test("S22：死线到期时已有可用幸存者，parent_agent 模式必须照常给出判决", { timeout: 420_000 }, async () => {
  const { e, r, hit, release, reviewHit } = await heldAtCapture("s22");
  let run;
  try {
    assert.equal((await e.tool("verifier_configure", { totalTimeoutMin: 2 })).saved, true);
    const runP = e.tool("verified_best_of", {
      repoPath: r.p, task: "x", candidateCount: 2, maxConcurrent: 2,
      validationCommand: VALIDATE, reviewMode: "parent_agent",
    }).catch(() => ({}));
    const early = await Promise.race([until(hit, 150_000).then(() => null), runP]);
    assert.equal(early, null, `run 在 candidate-2 的抓取卡住之前就返回了，本测失去意义: ${JSON.stringify(early)}`);
    // 上面那条 race 判不了"门到底响没响"：`until()` 超时是 resolve(false)，而 `.then(() => null)`
    // 把 true/false 一律映成 null ⇒ "门一次没响、run 只是慢到 150s 以上"这种情况照样绿。前提单独钉。
    assert.ok(fs.existsSync(hit), "git diff 没触发 textconv 门 → 抓取路径已变，本测判的不再是'死线落在冻结里'");
    run = await runP;
  } finally {
    fs.writeFileSync(release, "x");
    await e.close();
  }
  const man = readManifest(path.join(e.dataDir, "runs", fs.readdirSync(path.join(e.dataDir, "runs"))[0], "manifest.json"));
  const shapes = JSON.stringify(man.candidates.map((c) => [c.candidateId, c.generation?.status, c.validation?.status, c.patchError ? "patchError" : "patch"]));
  assert.equal(run?.__error, undefined, `工具必须回一条终态而不是错误: ${JSON.stringify(run)}`);
  assert.ok(!man.candidates[0].patchError && man.candidates[1].patchError,
    `前提塌了，需要 1 个已落补丁的幸存者和 1 个抓取被掐的候选: ${shapes}`);
  assert.equal(run.status, "winner_selected",
    `判决输入已经齐了，晚一步的死线不得把 run 折成 timeout: ${shapes} man=${man.status}`);
  assert.equal(run.winnerId, "candidate-1", `单幸存者必须是那个补丁已落盘的候选: ${shapes}`);
  assert.ok(run.winnerPatchPath && fs.existsSync(run.winnerPatchPath)
    && fs.statSync(run.winnerPatchPath).size > 0,
  `胜者补丁必须还在盘上并且非空（这条测的全部意义）: ${JSON.stringify(run.winnerPatchPath)}`);
  assert.equal(fs.existsSync(reviewHit), false, `parent_agent 模式不得起评审: ${shapes}`);
  assert.match(man.candidates[1].patchError ?? "", /git diff/u,
    `candidate-2 的抓取失败必须来自被掐断的 git diff（否则"有幸存者"这个前提不是死线造出来的）: ${JSON.stringify(man.candidates[1].patchError)}`);
  assert.equal(worktrees(r), 1, "死线掐断冻结之后 worktree 必须回收（被杀的是带着 node 孙进程的 git）");
  assert.equal(leakyBranches(r), "", "死线掐断冻结之后不得留下候选分支");
});

// T3：apply_verified_winner 过去拿不到取消信号 —— 20s 复验在第 3 秒被取消也要跑到 20.4s，
// 并且照常回 applied。取消后的状态既不能像成功，也必须和 manifest 一致，还要留得下回滚入口。
test("apply_verified_winner 可取消：复验被掐掉后不得回报成功", { timeout: 300_000 }, async () => {
  const e = await spawnEngine({ name: "applycancel" });
  const r = mkRepo("cancelrepo");
  const vhit = fwd(path.join(dir, "apply-revalidation-started.txt"));
  const vdone = fwd(path.join(dir, "apply-revalidation-finished.txt"));
  fs.rmSync(vhit, { force: true }); fs.rmSync(vdone, { force: true });
  try {
    const patch = makePatch(r, "feature.txt", "added by candidate\n");
    // 不被取消就会成功退出（20s）—— 那时候回的 applied 就是假的；vdone 用来证明复验进程
    // 是被取消带走的，而不是"跑完了但状态被事后改口"（那条断言不看时钟）。
    const slowOk = `node -e "require('fs').writeFileSync('${vhit}','x');` +
      `setTimeout(function(){require('fs').writeFileSync('${vdone}','x');process.exit(0)},20000)"`;
    // seedRun 用 name 的末位拼 runId，而 runId 必须是 6 位十六进制 → 末位得是个 hex 字符
    const { runId } = seedRun(e, { name: "revalidate1", repoPath: r.p, patchText: patch, validationCommand: slowOk });
    const p = e.tool("apply_verified_winner", { runId }).catch(() => ({}));
    // apply 若在复验启动前就返回，那是前置检查拒的 —— 报错要点名是哪一条，别只说"没跑起来"
    const early = await Promise.race([until(vhit, 150_000).then(() => null), p]);
    assert.equal(early, null, `apply 在复验启动前就返回了: ${JSON.stringify(early)}`);
    assert.ok(fs.existsSync(vhit), "复验没跑起来 → 本测失去意义");
    assert.equal(fs.existsSync(path.join(r.p, "feature.txt")), true, "前置条件：补丁此刻已落地");
    e.notify("notifications/cancelled", { requestId: e.lastId() });
    const out = await p;
    assert.notEqual(out.status, "applied", `取消后的 apply 不得回报成功: ${JSON.stringify(out)}`);
    assert.equal(out.status, "applied_validation_cancelled", JSON.stringify(out));
    assert.equal(out.validation?.status, "cancelled", "复验没跑完就不是 passed/failed");
    const man = readManifest(out.manifestPath);
    assert.equal(man.status, out.status, "manifest 必须与返回状态一致");
    // 不看时钟的锁：复验进程若没被带走，它自己的 20s 定时器会写下 vdone（本机负载下
    // 20s 与 12s 这种时间差断言根本不可判，实测一次全量跑里同一断言偏差到 20.3s）。
    assert.equal(fs.existsSync(vdone), false,
      "复验进程自己跑完了 = 取消没把它带走，状态只是事后改口");
    // 补丁确实在树上 —— 取消态必须是可回滚的，不能把用户卡在半应用
    assert.equal((await e.tool("rollback_verified_winner", { runId })).status, "rolled_back");
    assert.equal(fs.existsSync(path.join(r.p, "feature.txt")), false);
  } finally { await e.close(); }
});

// worktree 是干净 checkout，没有 node_modules：npm 型验证必须先在 worktree 里装依赖，
// 否则每个 JS 仓库都假阴性成 no_winner。装不上要记成"安装失败"而不是候选的错，
// 且一个字节都不许落进 origin 工作区。
test("npm 型验证先在 worktree 装依赖：失败归因到安装，且不污染 origin", { timeout: 180_000 }, async () => {
  const r = mkRepo("jsrepo");
  fs.writeFileSync(path.join(r.p, "package.json"), JSON.stringify({
    name: "jsrepo", version: "1.0.0", scripts: { test: "node check.js" },
  }));
  fs.writeFileSync(path.join(r.p, "package-lock.json"), "{ 这不是合法 json\n");
  r.g("add", "-A");
  r.g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "pkg");
  const run = await tool("verified_best_of", {
    repoPath: r.p, task: "fix it", candidateCount: 1, validationCommand: "npm test",
  });
  assert.equal(run.status, "no_winner", `依赖装不上时不得伪造 winner: ${JSON.stringify(run)}`);
  const v = readManifest(run.manifestPath).candidates[0].validation;
  assert.equal(v.command, "npm test", "validation.command 必须仍是用户要跑的校验命令 —— apply_verified_winner 只信这个字段");
  assert.equal(v.installCommand, "npm ci", "有 package-lock.json 必须走 npm ci");
  assert.equal(v.status, "failed");
  assert.equal(v.installError, true, `失败必须归因到安装: ${JSON.stringify(v)}`);
  // 口径要能走完全程：宿主拿到的 message 与 report.md 都得说是安装坏了，而不是"模型没产出"。
  assert.match(run.message, /dependency install failed in candidate-1/, `no_winner 不得怪到模型头上: ${JSON.stringify(run)}`);
  assert.match(fs.readFileSync(run.reportPath, "utf8"), /Validation blocked before it ran/,
    "report.md 必须点名安装命令失败");
  assert.equal(fs.existsSync(path.join(r.p, "node_modules")), false, "安装只许发生在 worktree");
  assert.equal(r.g("status", "--porcelain").stdout.trim(), "", "origin 工作区必须干净");
});

// 装出来的依赖树绝不能混进补丁：仓库自己没有 .gitignore 时也一样，排除项是 harness 的，
// 不是候选或仓库能改掉的。不联网也能验：让校验命令自己在 worktree 里造出 node_modules。
test("worktree 里新装的 node_modules 不得进入候选补丁", { timeout: 180_000 }, async () => {
  const r = mkRepo("nmrepo");
  fs.writeFileSync(path.join(r.p, "package.json"),
    JSON.stringify({ name: "nmrepo", version: "1.0.0", scripts: { test: "node check.js" } }));
  r.g("add", "-A");
  r.g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "pkg");
  const mkdep = path.join(dir, "mkdep.cjs");
  fs.writeFileSync(mkdep, "const f=require('fs');" +
    "f.mkdirSync('node_modules/dep',{recursive:true});" +
    "f.writeFileSync('node_modules/dep/i.js','dep content\\n');" +
    "f.writeFileSync('solution.txt','real work\\n');\n");
  const run = await tool("verified_best_of", {
    repoPath: r.p, task: "fix it", candidateCount: 1, validationCommand: `node "${fwd(mkdep)}"`,
  });
  // 单候选走 single_survivor，不会停在 review_pending；这里要的是"校验通过 + 补丁干净"。
  assert.equal(run.status, "winner_selected", `校验应通过：${JSON.stringify(run)}`);
  const man = readManifest(run.manifestPath);
  assert.equal(man.candidates[0].validation.status, "passed");
  const patch = fs.readFileSync(man.candidates[0].patchPath, "utf8");
  assert.doesNotMatch(patch, /node_modules/, `依赖树漏进了补丁:\n${patch.slice(0, 500)}`);
  assert.match(patch, /solution\.txt/, "排除装出来的依赖不能顺手漏掉真实改动");
  // 排除项必须写在报告里：审阅者看到"补丁只有两行"时，得知道依赖是被 harness 挡掉的。
  assert.match(fs.readFileSync(run.reportPath, "utf8"), /Dependency exclusion: untracked `node_modules\/` is dropped via the harness/,
    "report.md 必须披露 harness 自己的依赖排除，且把范围限定在未跟踪");
  // 必须是"清理真跑过并且什么都没发现"：字段缺席也算过的话，这条测就分不清
  // 「本轮无泄漏」和「这版构建根本没有清理记账」。
  assert.ok(Array.isArray(man.cleanupWarnings), `manifest 必须带 cleanupWarnings 数组，实得 ${JSON.stringify(man.cleanupWarnings)}`);
  assert.equal(man.cleanupWarnings.length, 0, `正常清理不该报泄漏: ${JSON.stringify(man.cleanupWarnings)}`);
});

// N1：git 只用"有没有 NUL"判断文本，所以 GBK/Shift-JS/latin-1 源文件的 diff 行是带原始字节出栈的。
// 抓取端一旦按 utf8 解码，非法序列就变成 U+FFFD，然后被 sha256 记账、被 git apply 落进用户仓库。
test("非 UTF-8 内容必须按字节进补丁、按字节落地", { timeout: 180_000 }, async () => {
  const RAW = Buffer.from([0xbd, 0xa1, 0xb4, 0xfa]);        // GBK 字节，无 NUL → git 视为文本
  const APPEND = Buffer.from([0xa3, 0xac, 0xd6, 0xe0]);
  const REPLACEMENT = Buffer.from([0xef, 0xbf, 0xbd]);       // utf8 解码出的 U+FFFD
  const r = mkRepo("gbkrepo");
  r.g("config", "core.autocrlf", "false");                   // 换行转换会盖掉"字节保真"这条判据
  const original = Buffer.concat([Buffer.from("MARKER-ASCII:"), RAW]);
  fs.writeFileSync(path.join(r.p, "legacy.txt"), original);
  r.g("-c", "user.name=t", "-c", "user.email=t@t", "add", "-A");
  r.g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "gbk source");
  const e = await spawnEngine({ name: "rawbytes", env: {
    MOCK_RAW_NAME: "legacy.txt", MOCK_RAW_BYTES: APPEND.join(","),
  } });
  try {
    const run = await e.tool("verified_best_of", {
      repoPath: r.p, task: "x", candidateCount: 1, validationCommand: VALIDATE,
    });
    assert.equal(run.status, "winner_selected", `前置条件：候选要真跑完并被抓到补丁: ${JSON.stringify(run)}`);
    const patch = fs.readFileSync(run.candidates[0].patchPath);
    assert.ok(patch.includes(RAW), `补丁必须原样携带非 UTF-8 字节:\n${JSON.stringify(patch.slice(0, 300).toString("latin1"))}`);
    assert.equal(patch.includes(REPLACEMENT), false, "补丁里出现 U+FFFD = 抓取按 utf8 解码过，字节已被改写");
    assert.equal((await e.tool("apply_verified_winner", { runId: run.runId })).status, "applied");
    assert.deepEqual(fs.readFileSync(path.join(r.p, "legacy.txt")),
      Buffer.concat([original, APPEND]), "落地后的字节必须与候选写下的字节逐字节相等");
  } finally { await e.close(); }
});

// N2：Node 把超过 2^31-1 ms 的 setTimeout 延迟夹成 1ms（只发一条警告），于是"合法"的
// totalTimeoutMin 会让整个 run 在下一 tick 自我中止：候选全被 SIGKILL、worktree 与分支永久外泄。
test("超时配置必须有上限，天花板上的 run 不得瞬死", { timeout: 180_000 }, async () => {
  const e = await spawnEngine({ name: "timeoutcap" });
  try {
    for (const k of ["totalTimeoutMin", "candidateTimeoutMin", "reviewTimeoutMin"]) {
      const bad = await e.tool("verifier_configure", { [k]: 10081 });
      assert.match(String(bad.__error), new RegExp(k), `超上限的 ${k} 必须被拒: ${JSON.stringify(bad)}`);
      assert.match(String(bad.__error), /10080/, `拒绝信息必须点名上限: ${JSON.stringify(bad)}`);
    }
    assert.equal((await e.tool("verifier_configure", { totalTimeoutMin: 10080 })).saved, true, "10080 = 上限本身必须可用");
    const t0 = Date.now();
    const run = await e.tool("verified_best_of", {
      repoPath: repo, task: "x", candidateCount: 1, validationCommand: VALIDATE,
    });
    assert.equal(run.status, "winner_selected", `贴着上限的 run 必须真跑出结果: ${JSON.stringify(run)}`);
    assert.equal(run.candidates[0].validation, "passed");
    assert.equal(run.candidates[0].generation, "succeeded");
    assert.ok(Date.now() - t0 < 120_000, `上限内的 run 不该被死线掐掉，实耗 ${Date.now() - t0}ms`);
  } finally { await e.close(); }
});

// N5：一个 worker 抛错（Windows 上并发 rename 撞 EPERM 是这份仓库已记录的真实形状）过去走
// Promise.all：立刻返回、死线从不 abort、兄弟继续开进程，finally 再把它们正在写的 worktree 端掉。
// 兄弟的生成期（120s）必须远长于任何负载下的 taskkill 延迟（实测最坏 30s 级），所以
// "它自己跑完了"只会以 succeeded 现形，不会被负载伪装成中止。
const PID_ABORT = () => path.join(dir, "pids-abort");
const PID_CONTROL = () => path.join(dir, "pids-control");
test("worker 抛错不得孤儿子兄弟进程：等齐、中止、并把内因说出来", { timeout: 300_000 }, async () => {
  const r = mkRepo("poolrepo");
  fs.rmSync(PID_ABORT(), { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  const e = await spawnEngine({ name: "poolfail", env: {
    MOCK_BREAK_MANIFEST: "1",      // candidate-1 的 saveRun 必炸
    MOCK_SLEEP_MS: "0,120000",     // candidate-2 还在生成期内 —— 中止必须把它带走
    MOCK_PID_DIR: fwd(PID_ABORT()),
  } });
  try {
    const t0 = Date.now();
    const run = await e.tool("verified_best_of", {
      repoPath: r.p, task: "x", candidateCount: 2, maxConcurrent: 2, validationCommand: VALIDATE,
    });
    const elapsed = Date.now() - t0;
    assert.equal(run.status, "no_winner", `内因失败也要回一个结构化终态: ${JSON.stringify(run)}`);
    assert.match(run.message, /Internal verifier failure: /, `message 必须点名内因: ${JSON.stringify(run)}`);
    assert.match(run.message, /EBUSY|EPERM|EISDIR|ENOTEMPTY|rename/, `内因的原始错误必须进 message: ${run.message}`);
    const report = fs.readFileSync(run.reportPath, "utf8");
    assert.match(report, /Internal verifier failure: /,
      "report.md 必须带上同一条披露，manifest 写不进去时它是唯一凭据");
    // 因果锁 1（状态）：兄弟被中止的形状 —— 生成没跑完、验证没通过。
    // 中止发生在生成期内：runCandidate 只可能记成 failed（进程被带走、没有 exec.result），
    // 而"被孤儿的兄弟自己跑完"必然记成 succeeded，这条就是那两种形状的分界。
    const sib = run.candidates[1];
    assert.equal(sib.generation, "failed", `兄弟的生成必须是被中止的形状，不是它自己跑完: ${JSON.stringify(run.candidates)}`);
    assert.notEqual(sib.validation, "passed", `被中止的兄弟不得留下通过的验证: ${JSON.stringify(sib)}`);
    assert.match(report, /## candidate-2\n- Generation: `failed`/, "落盘回执里也要是同一形状");
    // 因果锁 2（进程）：兄弟的 OS 进程真的被带走，而不是"在后台继续写盘"。
    const pidFile = PID_ABORT() + path.sep + "candidate-2.pid";
    assert.ok(await until(pidFile, 60_000), `兄弟没记下自己的 pid（${pidFile}）= 中止无从判定`);
    const gone = await pidGone(readPid(PID_ABORT(), "candidate-2"));
    assert.notEqual(gone, -1, "兄弟进程还活着 = abort 没把它带走（Windows 靠 taskkill /T 收整棵树）");
    // 这条只是失控闸（防"根本没停"），不是判据：负载下 taskkill 被延后调度是正常现象，
    // 真判据是上面两条因果锁 —— 它们不看钟。
    assert.ok(elapsed < 180_000, `run 必须停下，实耗 ${elapsed}ms`);
    assert.equal(worktrees(r), 1, `内因失败后 worktree 必须回收: ${r.g("worktree", "list").stdout}`);
    assert.equal(leakyBranches(r), "", `内因失败后分支必须删除: ${leakyBranches(r)}`);
  } finally { await e.close(); }
});

// 正对照：同一形状、两个候选、同样记 pid，只是没人抛错 —— 兄弟必须活着干完自己的活。
// 缺了它，上面那条 ESRCH 可能永远只是因为进程根本没起来，负断言站在死前提上。
test("正对照：无中止时兄弟进程活着并跑完（pid 探针本身有效）", { timeout: 300_000 }, async () => {
  const r = mkRepo("poolctlrepo");
  fs.rmSync(PID_CONTROL(), { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  const e = await spawnEngine({ name: "poolctl", env: {
    MOCK_SLEEP_MS: "0,20000",
    MOCK_PID_DIR: fwd(PID_CONTROL()),
  } });
  try {
    const p = e.tool("verified_best_of", {
      repoPath: r.p, task: "x", candidateCount: 2, maxConcurrent: 2, validationCommand: VALIDATE,
    });
    const pidFile = PID_CONTROL() + path.sep + "candidate-2.pid";
    assert.ok(await until(pidFile, 60_000), `对照候选没记下 pid（${pidFile}）= 记录机制失效`);
    const pid = readPid(PID_CONTROL(), "candidate-2");
    assert.ok(Number.isInteger(pid) && pid > 0, `对照候选记下的 pid 不是个 OS pid: ${pid}`);
    assert.doesNotThrow(() => process.kill(pid, 0), "对照候选此刻必须还活着：它已死则 ESRCH 什么也没证明");
    const run = await p;
    assert.equal(run.__error, undefined, `对照 run 不该失败: ${JSON.stringify(run)}`);
    assert.equal(run.candidates[1].generation, "succeeded", "没被中止的兄弟要跑完自己的生成");
    assert.equal(run.candidates[1].validation, "passed");
  } finally { await e.close(); }
});

// G1：tools/call 是并发派发的，而 configure 是 loadConfig → 合并 → 写盘 的读-改-写。
// 两条重叠加上下同一份旧快照时，后写的会把先写的字段吃掉 —— 最坏形状是会话 1 的
// enabled:false（kill switch）被会话 2 的 maxConcurrent 抹掉，引擎继续跑没人授权的候选。
test("并发 verifier_configure 不得互相吃字段（kill switch 丢不得）", { timeout: 120_000 }, async () => {
  const e = await spawnEngine({ name: "cfgrace" });
  try {
    const [a, b] = await Promise.all([
      e.tool("verifier_configure", { enabled: false }),
      e.tool("verifier_configure", { maxConcurrent: 5 }),
    ]);
    assert.equal(a.saved, true, `第一条必须保存成功: ${JSON.stringify(a)}`);
    assert.equal(b.saved, true, `第二条必须保存成功: ${JSON.stringify(b)}`);
    const cfg = (await e.tool("verifier_get_config", {})).config;
    assert.equal(cfg.enabled, false, `kill switch 被后写的旧快照吃掉了: ${JSON.stringify(cfg)}`);
    assert.equal(cfg.maxConcurrent, 5, `后写的那条没落盘: ${JSON.stringify(cfg)}`);
    assert.ok(fs.readFileSync(path.join(e.dataDir, "config.json"), "utf8").includes('"enabled": false'),
      "盘上的 config.json 才是宿主重启后要信的那份");
    // 排队不得新增失败面：坏输入照常报错，且抛错的那一轮不能把队列焊死
    assert.match((await e.tool("verifier_configure", { enabled: "false" })).__error, /enabled must be a boolean/);
    assert.equal((await e.tool("verifier_configure", { maxConcurrent: 3 })).saved, true,
      "前一回合抛错后，队列必须照常服务");
  } finally { await e.close(); }
});

// G2：runVerifiedBestOf 只有 finally 没有 catch —— 抓取阶段之外的意外抛错（AV 扫盘下的
// EPERM 是真实形状）会让盘上回执永远停在 running，运维分不清"崩了"和"还在跑"。
test("run 体内意外抛错：回执不得停在 running，错仍要报给宿主", { timeout: 180_000 }, async () => {
  const r = mkRepo("crashrepo");
  const e = await spawnEngine({ name: "crashrun", env: { MOCK_BREAK_HARNESS_EXCLUDES: "1" } });
  try {
    const out = await e.tool("verified_best_of", {
      repoPath: r.p, task: "x", candidateCount: 1, validationCommand: VALIDATE,
    });
    assert.match(String(out.__error), /harness\.gitignore|harness/, `宿主必须仍看见这次失败: ${JSON.stringify(out)}`);
    assert.match(String(out.__error), /EISDIR|EPERM|EBUSY|ENOTDIR|EACCES/, `原始成因要跟着上来: ${JSON.stringify(out)}`);
    const runs = fs.readdirSync(path.join(e.dataDir, "runs"));
    assert.equal(runs.length, 1, `应留下一条记账的 run: ${runs.join(",")}`);
    const man = readManifest(path.join(e.dataDir, "runs", runs[0], "manifest.json"));
    assert.notEqual(man.status, "running", "崩溃的回执不得冻结在 running —— 那读起来像还在跑");
    assert.equal(man.status, "no_winner", `意外抛错的终态必须复用既有字面量: ${JSON.stringify(man.status)}`);
    assert.ok((man.internalErrors || []).some((s) => /internal verifier failure/.test(s)),
      `内因要进既有的 internalErrors 通道: ${JSON.stringify(man.internalErrors)}`);
    assert.match(fs.readFileSync(path.join(e.dataDir, "runs", runs[0], "report.md"), "utf8"),
      /Internal verifier failure: /, "report.md 必须看得见同一条崩痕");
    assert.equal(worktrees(r), 1, `崩溃后 worktree 必须回收: ${r.g("worktree", "list").stdout}`);
    assert.equal(leakyBranches(r), "", `崩溃后分支必须删除: ${leakyBranches(r)}`);
  } finally { await e.close(); }
});

// G2：appliedFiles 是"这个补丁动了哪些文件"的唯一凭据。git apply --numstat 走 spawnSync
// 默认的 1 MiB 上限，且 status 从不查 —— 大补丁会被掐成半条记录，照样按权威口径报出去。
test("apply 的文件清单不得被缓冲区上限掐成半条", { timeout: 180_000 }, async () => {
  const N = 10_000;
  const nameAt = (i) => `m${i % 32}/${"x".repeat(120)}${i}.txt`;
  const manyFilePatch = () => {
    let s = "";
    for (let i = 0; i < N; i++) {
      const p = nameAt(i);
      s += `diff --git a/${p} b/${p}\nnew file mode 100644\n--- /dev/null\n+++ b/${p}\n@@ -0,0 +1 @@\n+hi\n`;
    }
    return s;
  };
  const e = await spawnEngine({ name: "bignumstat" });
  const r = mkRepo("numstatrepo");
  try {
    // validationCommand 为空：这条测要的是清单，不是复验，别让 10 秒的 npm 噪音掺进来。
    const { runId } = seedRun(e, { name: "numstat1", repoPath: r.p, patchText: manyFilePatch(), validationCommand: "" });
    const out = await e.tool("apply_verified_winner", { runId });
    assert.equal(out.status, "applied", JSON.stringify(out));
    assert.ok(out.appliedFiles, `清单读不回来时必须报 unknown，而不是给一份截断的: ${JSON.stringify(out.appliedFiles)}`);
    assert.equal(out.appliedFiles.length, N, `文件清单被截断了: ${out.appliedFiles.length}/${N}`);
    assert.equal(out.appliedFiles[N - 1], nameAt(N - 1), "末条记录必须完整（截断就发生在这里）");
    const man = readManifest(out.manifestPath);
    assert.ok(!(man.internalErrors || []).some((s) => /appliedFiles/.test(s)),
      `清单完整时不该有披露: ${JSON.stringify(man.internalErrors)}`);
  } finally { await e.close(); }
});

// G2：sh 是同步面孔，一次挂死的 git 会同时冻住事件循环、run 死线和宿主的 ping。
// 成因用 post-checkout 钩子造（git worktree add 会跑它），上限由 LLM_VERIFIER_GIT_TIMEOUT_MS
// 收紧到 15s —— 于是"被掐掉的 git"必须作为超时失败报出来，而不是让 run 挂在那儿。
test("同步 git 卡死必须按超时上报，不得当作成功（且测自己收掉孤儿钩子）", { timeout: 180_000 }, async () => {
  const r = mkRepo("hangrepo");
  // 本测独占一份临时目录：孤儿钩子的 cwd 落在 <base>/data-hanggit/runs/.../worktrees 里，
  // 只要它活着，after() 的 rmSync(dir,{force:true}) 会把 EPERM 吞成静默 → 目录永久泄漏。
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "llmv-e2e-hang-"));
  const hk = path.join(base, "hang-hooks");
  const pidFile = path.join(base, "hook.pid");
  fs.mkdirSync(hk, { recursive: true });
  // 像 MOCK_PID_DIR 那样先自报 pid 再睡：睡 25s > 15s kill，测必须自己把它带走。
  // 路径写死在钩子里而不是读环境：钩子随 `git worktree add` 起，引擎给它的正是白名单环境。
  // 必须 `exec` node —— 否则 git 起的是 sh，sh 再 fork node：杀了 node，那个 cwd 仍被
  // sh 父进程占着，base 目录删不掉。exec 让 node 顶替 sh、沿用同一个 pid，杀它=杀掉钩子本体。
  fs.writeFileSync(path.join(hk, "post-checkout"), `#!/bin/sh
exec node -e "try{require('fs').writeFileSync('${fwd(pidFile)}',String(process.pid))}catch(e){};setTimeout(function(){},25000)"
`);
  r.g("config", "core.hooksPath", fwd(hk));   // .git/config 不在工作区内，仓库仍是"干净"的
  let e;
  try {
    e = await spawnEngine({ name: "hanggit", baseDir: base, env: { LLM_VERIFIER_GIT_TIMEOUT_MS: "15000" } });
    const out = await e.tool("verified_best_of", {
      repoPath: r.p, task: "x", candidateCount: 1, validationCommand: VALIDATE,
    });
    const err = String(out.__error);
    assert.match(err, /worktree add failed for candidate-1/, `卡死的必须是这一步: ${err}`);
    assert.match(err, /ETIMEDOUT|timed out|SIGTERM|killed/, `必须报成被掐/超时，不能只留空原因: ${err}`);
    assert.ok(await until(pidFile, 30_000), `post-checkout 钩子没记下 pid（${pidFile}）= 本测无法证明自己回收了孤儿`);
    assert.ok(Number.isInteger(readPid(base, "hook")) && readPid(base, "hook") > 0, "钩子记下的必须是个 OS pid");
  } finally {
    await e?.close();
    r.g("config", "--unset", "core.hooksPath");
    // 收掉自己制造的孤儿：不杀它，下面的 rm 会被 force:true 静默吞掉，目录就永久留在 %TEMP%。
    // 而且必须等到 pid 真消失（git 的 sh 父进程会随 node 一起退），否则句柄还没释放就 rm 又 EPERM。
    if (fs.existsSync(pidFile)) {
      const hookPid = readPid(base, "hook");
      try { process.kill(hookPid, "SIGKILL"); } catch {}
      assert.notEqual(await pidGone(hookPid, 15_000), -1,
        `孤儿钩子 pid=${hookPid} 杀不掉 → 临时目录必然泄漏`);
    }
    // 杀掉钩子后 Windows 释放目录句柄有延迟（负载下可达数秒），所以是带上限的轮询删除，
    // 不是一次 rmSync 的 maxRetries。循环结束后仍存在 → 下面的断言红，泄漏就无处藏。
    for (let t = 0; t < 40 && fs.existsSync(base); t++) {
      try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 }); }
      catch (e) { if (e.code !== "EPERM") throw e; }
      if (fs.existsSync(base)) await wait(500);
    }
    // force:true 会让"根本没删掉"看起来像成功：必须显式断言目录真的消失了
    assert.equal(fs.existsSync(base), false, `孤儿钩子没被收掉，临时目录仍在: ${base}`);
  }
});

// ============================ 第 13 轮（wave 13a）新增回归测 ============================

// G0：kill switch 必须在"真正要改动仓库的那一刻"重新判定，而不是只在请求到达时快照一次。
// 形状（实测）：applyA 的复验睡 20s 占住 mutationTurn → configure{enabled:false} 在队列里排队 →
// applyB 在到达时读到的是"仍启用"的旧快照，被排进去 → 轮到它时若不重读 config，补丁照样落地。
// 两个 apply 打不同仓库，否则 applyA 会把工作区弄脏，applyB 会被"脏工作区"这条挡住（测不到 kill switch）。
test("G0：kill switch 必须对'入队后才被停用'的那一枪生效（授权在队列内重读）", { timeout: 180_000 }, async () => {
  const e = await spawnEngine({ name: "killswitch" });
  const rA = mkRepo("ks-a");   // 长占队列的那枪
  const rB = mkRepo("ks-b");   // 被 kill switch 拦住的那枪
  const hold = path.join(dir, "ks-hold.txt");
  try {
    fs.rmSync(hold, { force: true });
    // runA：补丁落地后复验睡 20s（先把 patchA 落进 rA，再把队列按住），复验成功 → applyA 回 applied。
    const patchA = makePatch(rA, "featureA.txt", "held\n");
    const slowHold = `node -e "require('fs').writeFileSync('${fwd(hold)}','x');` +
      `setTimeout(function(){process.exit(0)},20000)"`;
    const { runId: idA } = seedRun(e, { name: "ks-a1", repoPath: rA.p, patchText: patchA, validationCommand: slowHold });

    // runB：干净可落地的补丁，用来证明"没有 kill switch 时它真的会落地"。runId 末位必须与 idA 不同。
    const patchB = makePatch(rB, "featureB.txt", "must not land\n");
    const { runId: idB } = seedRun(e, { name: "ks-b2", repoPath: rB.p, patchText: patchB, validationCommand: "" });

    const pA = e.tool("apply_verified_winner", { runId: idA });
    assert.ok(await until(hold, 60_000),
      "applyA 没进到复验阶段 = 它没占住 mutationTurn，本测失去意义");

    // 队列此刻被 applyA 按住：configure 与 applyB 都排在它后面。
    const pCfg = e.tool("verifier_configure", { enabled: false });
    const pB = e.tool("apply_verified_winner", { runId: idB });

    const cfg = await pCfg;
    assert.equal(cfg.saved, true, `kill switch 必须真的保存了: ${JSON.stringify(cfg)}`);
    const outB = await pB;
    await pA;
    assert.match(String(outB.__error), /is disabled/,
      `授权快照在队列外被绕过：applyB 仍落地了 → ${JSON.stringify(outB)}`);
    assert.equal(fs.existsSync(path.join(rB.p, "featureB.txt")), false,
      "被停用之后排到的那一枪绝不能把补丁写进仓库");
  } finally { await e.close(); }
});

// G1：spawnSync 的 status 从没被看，只看了 stdout —— "被杀/报错前没来得及打印" 会被当成"工作区干净"，
// 于是把优胜补丁盖进用户未提交的改动上（之后 rollback 还拒绝）。这里用"损坏的 .git/index"把
// git status --porcelain 稳定地做成 status 128 + 空 stdout（实测），同时 rev-parse HEAD 仍成功，
// 正好复现"空输出被误读成干净"这一形状。删掉新加的状态检查 → 这条会红（当成干净→继续 apply）。
test("G1 apply：脏工作区状态读不出来时必须拒绝，而不是当成干净", { timeout: 120_000 }, async () => {
  const e = await spawnEngine({ name: "unreadystatus" });
  const r = mkRepo("unreadystatusrepo");
  try {
    const patch = makePatch(r, "feature.txt", "added\n");
    const { runId } = seedRun(e, { name: "ustat1", repoPath: r.p, patchText: patch, validationCommand: "" });
    // 让仓库"确实脏"（未提交改动），再毁掉索引文件：git status --porcelain → 128 + 空 stdout。
    fs.writeFileSync(path.join(r.p, "tracked.txt"), "uncommitted local work\n");
    r.g("add", "-A");
    fs.writeFileSync(path.join(r.p, "tracked.txt"), "uncommitted local work changed again\n");
    fs.writeFileSync(path.join(r.p, ".git", "index"), "GARBAGEGARBAGEGARBAGE");
    const out = await e.tool("apply_verified_winner", { runId });
    assert.match(String(out.__error), /cannot read working-tree state/,
      `读不出工作区状态时必须是这个原因: ${JSON.stringify(out)}`);
    assert.equal(fs.existsSync(path.join(r.p, "feature.txt")), false,
      "读不出状态=拒绝，绝不能把补丁盖进未提交的工作里");
  } finally { await e.close(); }
});

// G2：LLM_VERIFIER_GIT_TIMEOUT_MS 是个未经校验的数：Number("-1")||默认 = -1，
// 而 spawnSync({timeout:-1}) 直接抛 ERR_OUT_OF_RANGE（实测），于是每一个同步 git 都炸，
// 连 finally 里的 cleanupWorktrees 也炸 → 清理半途而废、原始错误被 RangeError 顶掉。
// 只接受正整数，否则回落默认。删掉校验 → 每个 git 抛 → run 跑不完 → 这条会红。
test("G2：坏掉的 GIT_TIMEOUT_MS 必须回落到默认值，run 照常跑完", { timeout: 180_000 }, async () => {
  for (const bad of ["-1", "-1000", "1500.5", "0", "abc"]) {
    const e = await spawnEngine({ name: "gtmo" + Buffer.from(bad).toString("hex"), env: { LLM_VERIFIER_GIT_TIMEOUT_MS: bad } });
    try {
      const run = await e.tool("verified_best_of", { repoPath: repo, task: "x", candidateCount: 1, validationCommand: VALIDATE });
      assert.equal(run.__error, undefined, `非法 GIT_TIMEOUT_MS=${bad} 不得让每个 git 调用抛: ${JSON.stringify(run)}`);
      assert.equal(run.status, "winner_selected", `非法 GIT_TIMEOUT_MS=${bad} 必须回落默认并跑完: ${JSON.stringify(run)}`);
      assert.equal(run.candidates[0].validation, "passed", `非法 ${bad} 下同步 git 应正常: ${JSON.stringify(run)}`);
    } finally { await e.close(); }
  }
});

// G1(Windows)：shell:true 把 [bin,...args] 拼成一条 cmd 串却不逐词加引号 ——
// 带空格的 --cwd 会被 cmd 拆成两截（实测：子进程收到 "...my" + "project\\..."），
// 候选于是走错分支、solution.txt 没落 → validation 失败 → no_winner。含空格路径必须跑到 winner_selected。
test("G1(Windows)：仓库/数据目录含空格时 mcode argv 不得被 shell 拆碎", { timeout: 180_000 }, async () => {
  const base = path.join(dir, "proj w space");           // 数据目录含空格 → worktree 的 --cwd 含空格
  const r = mkRepo(path.join("proj w space", "repo w space"));  // 仓库也在带空格的目录下
  const e = await spawnEngine({ name: "wspace", baseDir: base });
  try {
    const run = await e.tool("verified_best_of", { repoPath: r.p, task: "x", candidateCount: 1, validationCommand: VALIDATE });
    assert.equal(run.__error, undefined, `含空格路径不该把 run 变成错误: ${JSON.stringify(run)}`);
    assert.equal(run.status, "winner_selected",
      `带空格的 --cwd 被拆碎会让候选走错分支: ${JSON.stringify(run)}`);
    assert.equal(run.candidates[0].validation, "passed", `argv 拆碎时 validation 必失败: ${JSON.stringify(run)}`);
    assert.match(fs.readFileSync(run.candidates[0].patchPath, "utf8"), /solution\.txt/,
      "候选必须真的在自己的 worktree 里落了文件");
  } finally { await e.close(); }
});

// G1(Windows)：MCODE_BIN 落在带空格的目录下也必须能跑起来（宿主写 `node "<带空格路径>"` 的形态）。
// 若把逐词加引号写成"整条 bin 也硬裹一层引号"，这条会直接把引擎搞崩——它守的是别过度引用。
test("G1(Windows)：MCODE_BIN 位于带空格目录时 run 必须跑完", { timeout: 180_000 }, async () => {
  const binDir = path.join(dir, "mcode dir");
  fs.mkdirSync(binDir, { recursive: true });
  const spacedMock = path.join(binDir, "mock mcode.mjs");   // 文件名也带空格
  fs.writeFileSync(spacedMock, MOCK_SRC);
  fs.chmodSync(spacedMock, 0o755);
  const e = await spawnEngine({ name: "spacedbin", env: { LLM_VERIFIER_MCODE_BIN: `node "${spacedMock}"` } });
  try {
    const run = await e.tool("verified_best_of", { repoPath: repo, task: "x", candidateCount: 1, validationCommand: VALIDATE });
    assert.equal(run.__error, undefined, `带空格的 MCODE_BIN 不得报错: ${JSON.stringify(run)}`);
    assert.equal(run.status, "winner_selected", `带空格的 MCODE_BIN 必须真跑到择优: ${JSON.stringify(run)}`);
  } finally { await e.close(); }
});

// (2b) 生成失败时的真实成因藏在 candidates[].generation.stderr 里；buildReport 以前只印 status，
// 宿主于是把"脚手架坏了"读成"模型不行"。现在 status=failed/error 时要把 stderr 尾部（沿用文件里
// 已有的 tail 界定）也印进 report.md —— 但响应体形状（status/message）保持不变。
test("buildReport：生成失败时必须把捕获到的 stderr 印出来（成因不外推到模型头上）", { timeout: 180_000 }, async () => {
  const canary = "MCODE-SPAWN-FAILURE-CANARY-9b1f";
  const noisy = path.join(dir, "noisy-mcode.mjs");
  fs.writeFileSync(noisy, `process.stderr.write("${canary} line1\\n");\nprocess.stderr.write("${canary} tail\\n");\nprocess.exit(7);\n`);
  const e = await spawnEngine({ name: "generr", env: { LLM_VERIFIER_MCODE_BIN: `node "${fwd(noisy)}"` } });
  try {
    const run = await e.tool("verified_best_of", { repoPath: repo, task: "x", candidateCount: 1, validationCommand: VALIDATE });
    // 响应体形状不变：仍是那个 no_winner + 那句"没有一个候选完成生成并通过验证"。
    assert.equal(run.status, "no_winner", `坏生成不该被选成 winner: ${JSON.stringify(run)}`);
    assert.equal(run.candidates[0].generation, "failed", JSON.stringify(run.candidates[0]));
    assert.match(String(run.message), /no candidate completed generation/, `响应 message 形状不得变: ${JSON.stringify(run)}`);
    // 但落盘 report.md 必须看得见真成因，宿主才知道是脚手架坏了。
    const report = fs.readFileSync(run.reportPath, "utf8");
    assert.match(report, /Generation stderr:/, `report 必须印出 stderr 段落:\n${report.slice(0, 800)}`);
    assert.ok(report.includes(canary), `report 必须带上捕获的 stderr 原文（含尾部）:\n${report.slice(0, 800)}`);
    assert.match(report, /Generation stderr[\s\S]*tail/, "印的要是尾部而不是只截头");
  } finally { await e.close(); }
});

// G3：回滚资格以前是 startsWith("applied") —— 任何一个未来的 applied_* 字面量都会"按构造"变成可回滚，
// 悄无声息。改成显式列举真正在树里留下补丁的那三个状态，其余一律点名拒绝。
test("G3：rollback 只认那三个真的落了补丁的状态，别按前缀认 applied_*", { timeout: 180_000 }, async () => {
  const e = await spawnEngine({ name: "rollelig" });
  const r = mkRepo("rolleligrepo");
  try {
    const patch = makePatch(r, "feature.txt", "added\n");
    const { runId } = seedRun(e, { name: "relg1", repoPath: r.p, patchText: patch, validationCommand: "" });
    assert.equal((await e.tool("apply_verified_winner", { runId })).status, "applied");
    // 补丁此刻真的在树里；把状态改成一个"以 applied 开头但并不表示已落地"的未来字面量。
    const manPath = path.join(e.dataDir, "runs", runId, "manifest.json");
    const man = readManifest(manPath);
    man.status = "applied_partial_dry_run";
    fs.writeFileSync(manPath, JSON.stringify(man, null, 2));
    const rb = await e.tool("rollback_verified_winner", { runId });
    assert.match(String(rb.__error), /expected one of applied \/ applied_validation_failed \/ applied_validation_cancelled/,
      `非白名单状态必须点名拒绝: ${JSON.stringify(rb)}`);
    assert.match(String(rb.__error), /applied_partial_dry_run/, "拒绝信息必须报出它看到的那个状态");
    assert.equal(fs.existsSync(path.join(r.p, "feature.txt")), true, "拒了就一个字节都不许动");
    // 双落地保护读的是把手，不是 manifest 状态：终态写盘被吞掉时盘上停着的正是 apply 自己接受的
    // 那个前置状态（winner_selected），第二次 apply 必须被 apply-state.json 拦住，而不是把同一个
    // 补丁再盖一遍。
    man.status = "winner_selected";
    fs.writeFileSync(manPath, JSON.stringify(man, null, 2));
    assert.match(String((await e.tool("apply_verified_winner", { runId })).__error),
      /already has an applied patch/, "重落地必须由 apply-state 把手拦住");
    // 合法状态照常可回滚（放宽判据必须配一枚绿对照）。
    man.status = "applied";
    fs.writeFileSync(manPath, JSON.stringify(man, null, 2));
    assert.equal((await e.tool("rollback_verified_winner", { runId })).status, "rolled_back");
    assert.equal(fs.existsSync(path.join(r.p, "feature.txt")), false, "白名单内必须照常回滚");
  } finally { await e.close(); }
});

// S12：E-F2 的把手是"多出来的入口"，不是"多出来的门闩"。readApplyState 对**存在但读不出**的记录是抛错的
// （apply 那条改树的路径该抛，见 :1334），如果 rollback 照原样让同一个抛错先发生，它就发生在读 manifest
// 之前 —— 于是"补丁确实在树里 + manifest 明写着 applied"这种本来一定能撤销的情形，会因为一份坏掉的**辅助**
// 凭据而永久失去撤销入口。方向必须是：辅助凭据坏了就当没有，主凭据（manifest）照常授权，并把这件事披露出来。
test("S12：把手读不出不得顶掉回滚入口，manifest 明说 applied 时仍须撤得掉", { timeout: 180_000 }, async () => {
  const e = await spawnEngine({ name: "badhandle" });
  const r = mkRepo("badhandlerrepo");
  try {
    const patch = makePatch(r, "feature.txt", "added\n");
    const { runId } = seedRun(e, { name: "bhd0", repoPath: r.p, patchText: patch, validationCommand: "" });
    assert.equal((await e.tool("apply_verified_winner", { runId })).status, "applied");
    const stPath = path.join(e.dataDir, "runs", runId, "apply-state.json");
    // 前提先钉住：这条测判的是"坏把手"，把手若压根没被写过，测的就是别的东西并且会空转。
    assert.equal(fs.existsSync(stPath), true, "前提：apply 必须在改树之前落下把手");
    fs.writeFileSync(stPath, "{ this is not json");

    const rb = await e.tool("rollback_verified_winner", { runId });
    assert.equal(rb.status, "rolled_back", `坏把手 + manifest 说 applied ⇒ 必须仍撤得掉: ${JSON.stringify(rb)}`);
    assert.equal(fs.existsSync(path.join(r.p, "feature.txt")), false, "树必须真的被撤回");
    assert.ok((rb.internalErrors || []).some((w) => /apply-state unreadable/.test(String(w))),
      `坏把手必须被披露，不能静默降级: ${JSON.stringify(rb)}`);

    // 反向对照（放宽判据必须配一枚"仍须拒绝"）：把手坏了 + manifest **不**声称落地过 ⇒ 没有任何一份
    // 有效凭据能授权反向 apply，此时拒绝才是对的。
    const r2 = mkRepo("badhandlerrepo2");
    const { runId: id2 } = seedRun(e, { name: "bhd1", repoPath: r2.p, patchText: makePatch(r2, "f2.txt", "x\n"), validationCommand: "" });
    assert.equal((await e.tool("apply_verified_winner", { runId: id2 })).status, "applied");
    const man2 = path.join(e.dataDir, "runs", id2, "manifest.json");
    const m2 = readManifest(man2);
    m2.status = "winner_selected"; // 假装终态写盘被吞：这正是把手存在的理由
    fs.writeFileSync(man2, JSON.stringify(m2, null, 2));
    fs.writeFileSync(path.join(e.dataDir, "runs", id2, "apply-state.json"), "garbage");
    const rb2 = await e.tool("rollback_verified_winner", { runId: id2 });
    assert.match(String(rb2.__error), /expected one of applied/, `坏把手不得反过来变成撤销许可证: ${JSON.stringify(rb2)}`);
    assert.equal(fs.existsSync(path.join(r2.p, "f2.txt")), true, "拒了就一个字节都不许动");
  } finally { await e.close(); }
});

// S15（波次 18 复审的 F1）：N33 把"HEAD 变了就拒绝"当成判据，但 HEAD 会因为**与补丁无关**的提交而前进，
// 那时反向 apply 依然是可证明安全的（补丁那几个文件在新提交里没被碰）。TS 侧同样是全等判据，所以这条不是
// 两层不一致，而是两层一起过粗：用户提交了自己的工作之后就再也撤不掉工具那份补丁，除非改写历史。
// 精确判据用一次 git diff 就能拿到：base..HEAD 里若没有补丁涉及的文件，回滚照做。
test("S15：无关提交不得拦掉一次可证明安全的回滚（精确判据代替 HEAD 全等）", { timeout: 180_000 }, async () => {
  const e = await spawnEngine({ name: "unrelated" });
  const r = mkRepo("unrelatedrepo");
  try {
    const { runId } = seedRun(e, { name: "una0", repoPath: r.p, patchText: makePatch(r, "win.txt", "candidate\n"), validationCommand: "" });
    assert.equal((await e.tool("apply_verified_winner", { runId })).status, "applied");
    fs.writeFileSync(path.join(r.p, "unrelated.txt"), "the user's own work\n");
    r.g("add", "unrelated.txt");
    r.g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "unrelated work committed after the apply");
    const rb = await e.tool("rollback_verified_winner", { runId });
    assert.equal(rb.status, "rolled_back", `补丁文件没被那个提交碰过 ⇒ 回滚必须照做: ${JSON.stringify(rb)}`);
    assert.equal(fs.existsSync(path.join(r.p, "win.txt")), false, "补丁要真的撤掉");
    assert.equal(fs.existsSync(path.join(r.p, "unrelated.txt")), true, "用户自己的文件一个字节都不许动");
    assert.match(r.g("log", "--oneline").stdout, /unrelated work/, "那条无关提交必须还在历史里");
  } finally { await e.close(); }
});

// S16（波次 18 复审的 F2 + 一层此前没人走过的路径）：现有引擎测里所有补丁都是"新增文件"，反向 apply 就是删文件，
// 永远回不到"改动型补丁"。这条专门跑改动型补丁，并钉住一条不变量：**回滚报成功时用户树必须是干净的**。
// 复审工位说 core.autocrlf=true 的 Windows 默认下，反向 apply 会把 LF 写回盘上，于是 git 认为脏，而收据写
// rolled_back，紧接着的再落地还会被"脏树"挡住（正是 N32 想留的那条路）。前提是否真能造出来，由这条测自己回答。
test("S16：回滚报成功时用户树必须干净（改动型补丁 + core.autocrlf=true）", { timeout: 180_000 }, async () => {
  const e = await spawnEngine({ name: "modpatch" });
  const r = mkRepo("modpatchrepo");
  try {
    r.g("config", "core.autocrlf", "true");
    const lf = "l1\nl2\nl3\n";
    fs.writeFileSync(path.join(r.p, "f.txt"), lf);
    r.g("add", "-A");
    r.g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "an LF file in a CRLF-normalising repo");
    // 改动型补丁：写新内容 → 与索引比 → 还原工作树
    fs.writeFileSync(path.join(r.p, "f.txt"), "l1\nl2-edited\nl3\n");
    r.g("add", "-A");
    const d = spawnSync("git", ["diff", "--cached", "--binary"], { cwd: r.p, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    assert.equal(d.status, 0);
    r.g("reset", "-q");
    fs.writeFileSync(path.join(r.p, "f.txt"), lf);
    assert.equal(r.g("status", "--porcelain").stdout.trim(), "", "夹具前提：造完补丁后工作树要干净");

    const { runId } = seedRun(e, { name: "mod0", repoPath: r.p, patchText: d.stdout, validationCommand: "" });
    const ap = await e.tool("apply_verified_winner", { runId });
    assert.equal(ap.status, "applied", `改动型补丁必须能落地，否则这条测走不到回滚: ${JSON.stringify(ap)}`);
    assert.match(fs.readFileSync(path.join(r.p, "f.txt"), "utf8"), /l2-edited/, "apply 之后文件要真的带上改动");
    const rb = await e.tool("rollback_verified_winner", { runId });
    assert.equal(rb.status, "rolled_back", `回滚本身要成功: ${JSON.stringify(rb)}`);
    const dirty = r.g("status", "--porcelain").stdout.trim();
    const body = fs.readFileSync(path.join(r.p, "f.txt"), "utf8");
    assert.ok(!/l2-edited/.test(body), "内容要回到改动之前");
    // 判据是"不得撒谎"，不是"这台机器的换行一定正常"：环境真的脏了就必须点名披露。
    // 今天实测：porcelain = " M f.txt"，盘上是 "l1\r\nl2\r\nl3\r\n"（blob 是 LF）⇒ 这条测有牙。
    console.log(`[S16] post-rollback porcelain=${JSON.stringify(dirty)} on-disk=${JSON.stringify(body)}`);
    if (dirty !== "") {
      assert.ok((rb.internalErrors || []).some((w) => /after rollback the working tree is not clean/i.test(String(w))),
        `git 认为还有未提交改动时，收据必须披露它，而不是只说 rolled_back: dirty=${JSON.stringify(dirty)} out=${JSON.stringify(rb)}`);
    }
  } finally { await e.close(); }
});


// S13：回滚成功但把手删不掉（本机有 Windows EPERM 的记录，:566-570 那条注释就是为了它而写）⇒ 盘上留着一个
// 有效把手，而 manifest 已写 rolled_back。apply 侧 :1334 的"有把手就拒"于是把这个 run 的**再落地**流程
// （e2e 基线测里就断言了 rolled_back → apply 可用）永久堵死，而且报错让用户先去回滚 —— 回滚已经做完了。
// 判据：把手只是凭据，真正的"别把同一个补丁盖两遍"是 :1355 那次读树的 `git apply --check`。
test("S13：回滚后残留的把手不得堵死 rolled_back → 再落地这条路", { timeout: 180_000 }, async () => {
  const e = await spawnEngine({ name: "stalehandle" });
  const r = mkRepo("stalehandlerrepo");
  try {
    const { runId } = seedRun(e, { name: "shd0", repoPath: r.p, patchText: makePatch(r, "feature.txt", "added\n"), validationCommand: "" });
    assert.equal((await e.tool("apply_verified_winner", { runId })).status, "applied");
    const stPath = path.join(e.dataDir, "runs", runId, "apply-state.json");
    // 把把手换成一个删不掉的目录：读它 ⇒ EISDIR（等于坏凭据），删它 ⇒ 抛错（等于 rm 失败）。
    fs.rmSync(stPath);
    fs.mkdirSync(stPath);

    const rb = await e.tool("rollback_verified_winner", { runId });
    assert.equal(rb.status, "rolled_back", `第一步：残留把手不得顶掉回滚: ${JSON.stringify(rb)}`);
    assert.ok((rb.internalErrors || []).some((w) => /apply-state not removed/.test(String(w))),
      `删不掉必须被披露: ${JSON.stringify(rb.internalErrors)}`);
    assert.equal(fs.existsSync(path.join(r.p, "feature.txt")), false, "树要真的撤回");

    // 第二步换成**真实**那种残留：rm 失败后留在盘上的仍是那份可读的把手（不是目录）。目录那种形状是我这
    // 个夹具造出来的更强状态 —— 它连 rename 都过不去，那条路任何逻辑修复都救不了，不该混进这条判据里。
    fs.rmSync(stPath, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    assert.equal(fs.existsSync(stPath), false, "夹具前提：目录得先清掉，否则第二步判的还是第一步那个更强状态");
    fs.writeFileSync(stPath, JSON.stringify({
      schemaVersion: 1, runId, repoPath: r.p,
      patchPath: path.join(e.dataDir, "runs", runId, "candidate-1.patch"),
      patchSha256: readManifest(path.join(e.dataDir, "runs", runId, "manifest.json")).candidates[0].patchSha256,
      appliedAt: new Date().toISOString(),
    }));

    const re = await e.tool("apply_verified_winner", { runId });
    assert.equal(re.status, "applied",
      `第二步（本条的正主）：rolled_back + 盘上有删不掉的把手 ⇒ 仍须能再落地，而不是叫用户去回滚一次已完成的事: ${JSON.stringify(re)}`);
    assert.equal(fs.existsSync(path.join(r.p, "feature.txt")), true, "再落地要真的把文件放回去");
  } finally { await e.close(); }
});

// S14：用户把中选补丁 commit 之后再回滚。TS 侧 core.ts:2171 明确拒绝（HEAD 已不是 applyState.baseCommit），
// 引擎侧回滚以前不查 HEAD ⇒ 同一句工具调用两层给出相反答案，而且引擎那侧是把**已提交**的内容改回未提交的
// 删除/修改，收据还写着 rolled_back（提交并没有被撤）。这是"同一 bug/修复只做在一层"的项目头号缺陷类。
test("S14：HEAD 已经前进（用户提交了补丁）时回滚必须拒绝，和 TS 层同口径", { timeout: 180_000 }, async () => {
  const e = await spawnEngine({ name: "headmoved" });
  try {
    // 绿对照：HEAD 不动时回滚照旧成功 —— 收紧判据必须配一枚"合法路径仍然要过"的对照。
    const r1 = mkRepo("headokrepo");
    const { runId: id1 } = seedRun(e, { name: "heda", repoPath: r1.p, patchText: makePatch(r1, "feature.txt", "added\n"), validationCommand: "" });
    assert.equal((await e.tool("apply_verified_winner", { runId: id1 })).status, "applied");
    assert.equal((await e.tool("rollback_verified_winner", { runId: id1 })).status, "rolled_back",
      "HEAD 未动时新守卫不得拦住回滚");

    const r2 = mkRepo("headmovedrepo");
    const { runId: id2 } = seedRun(e, { name: "hedb", repoPath: r2.p, patchText: makePatch(r2, "f2.txt", "x\n"), validationCommand: "" });
    assert.equal((await e.tool("apply_verified_winner", { runId: id2 })).status, "applied");
    r2.g("add", "-A");
    r2.g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "user committed the winner");
    const rb = await e.tool("rollback_verified_winner", { runId: id2 });
    assert.match(String(rb.__error), /HEAD moved/, `提交过就必须拒绝，并把两个 commit 都报出来: ${JSON.stringify(rb)}`);
    assert.match(String(rb.__error), /touch the patched paths: f2\.txt/, `拒绝必须点名是哪些路径被提交了: ${JSON.stringify(rb)}`);
    assert.equal(fs.existsSync(path.join(r2.p, "f2.txt")), true, "拒绝之后已提交的文件一个字节都不许动");
  } finally { await e.close(); }
});

// ============================ 第 13 轮（wave 13b）新增回归测 ============================

// S4：apply_verified_winner 的复验以前吃的是硬编码的 10 * MIN —— 配置里那份验证预算没人读，
// 它也不受任何 run 预算管（apply 是独立的一枪，manifest 里的 deadlineAt 属于候选阶段，落地时早过了）。
// 现在两个阶段读同一个 validationTimeoutMin（= src/config.ts validationTimeoutMs 的分钟口径）。
// 判据不看钟：一条 12 秒退 0 的验证命令，配 3 秒预算 → timedOut；预算若还是 10 分钟 → 它跑得完，
// 于是 candidate 回 winner_selected、apply 回 applied，两条断言当场红。
test("S4：复验预算走 validationTimeoutMin，不再是 apply 里硬编码的 10 分钟", { timeout: 180_000 }, async () => {
  const e = await spawnEngine({ name: "valbudget" });
  const r = mkRepo("valbudgetrepo");
  try {
    // 0.05 分钟 = 3 秒。绕开 verifier_configure 是刻意的：工具面的下限是 1 分钟（给不了秒级预算），
    // 而手改 config.json 是本仓库既有的旁路缝（见"模型白名单在 spawn 使用点拦截"）。
    fs.writeFileSync(path.join(e.dataDir, "config.json"), JSON.stringify({ validationTimeoutMin: 0.05 }));
    const slowOk = `node -e "setTimeout(function(){process.exit(0)},12000)"`;

    const run = await e.tool("verified_best_of", {
      repoPath: r.p, task: "x", candidateCount: 1, validationCommand: slowOk,
    });
    const v = readManifest(run.manifestPath).candidates[0].validation;
    assert.equal(v.timedOut, true, `候选阶段的验证预算没读配置项: ${JSON.stringify(v)}`);
    assert.equal(run.status, "no_winner", `被预算掐掉的验证不得算通过: ${JSON.stringify(run)}`);

    // apply 那一枪读的是 manifest 里的快照（和它读 validation.command 的来源一致），所以补进快照。
    const patch = makePatch(r, "feature.txt", "added by candidate\n");
    const { runId } = seedRun(e, { name: "valbud1", repoPath: r.p, patchText: patch, validationCommand: slowOk });
    const manPath = path.join(e.dataDir, "runs", runId, "manifest.json");
    const man = readManifest(manPath);
    man.config.validationTimeoutMin = 0.05;
    fs.writeFileSync(manPath, JSON.stringify(man, null, 2));
    const out = await e.tool("apply_verified_winner", { runId });
    assert.equal(out.validation?.timedOut, true, `apply 的复验没走配置预算: ${JSON.stringify(out)}`);
    assert.equal(out.status, "applied_validation_failed", JSON.stringify(out));
    assert.equal(fs.existsSync(path.join(r.p, "feature.txt")), true, "复验超时不得顺手把补丁撤回");
  } finally { await e.close(); }
});

// S5：终态凭据写不下去，不得把已经发生的事变成一次抛错。writeJson 是"唯一临时名 + rename"，
// rename 会真失败（ENOSPC，以及这台机器记录过的 Windows EPERM）；apply 之后补丁已经在用户树里，
// 抛错等于把"已落地 + 回滚入口"这条信息整个弄丢。而回滚入口本身不能只长在 manifest 上：
// apply_verified_winner 在动手改树**之前**先落一份 apply-state.json 把手（对齐 src/core.ts 的
// APPLY_STATE_FILE），manifest 是目录时 rollback_verified_winner 读把手也能把补丁撤回来。
// 删掉那次写盘 → (a) 末尾三条当场红（回滚只剩 manifest 一条路，读不出即拒）。
test("S5：manifest 写不进去不得顶掉真结果，必须留下 manifest not written 披露", { timeout: 180_000 }, async () => {
  // (a) apply：复验那一枪把 manifest.json 变成目录 → 引擎随后的终态 saveRun 必炸（N5 同形状，
  // 只是钉在终态那一次写盘上）。校验命令本身退 0，所以真实状态是 applied。
  const e = await spawnEngine({ name: "s5apply" });
  const r = mkRepo("s5applyrepo");
  try {
    const patch = makePatch(r, "feature.txt", "added by candidate\n");
    const { runId, runDir } = seedRun(e, {
      name: "s5appl1", repoPath: r.p, patchText: patch, validationCommand: "exit 0",
    });
    const mpath = fwd(path.join(runDir, "manifest.json"));
    const breaker = `node -e "const f=require('fs');` +
      `f.rmSync('${mpath}',{force:true,recursive:true});f.mkdirSync('${mpath}');process.exit(0)"`;
    const man = readManifest(path.join(runDir, "manifest.json"));
    man.candidates[0].validation.command = breaker;
    fs.writeFileSync(path.join(runDir, "manifest.json"), JSON.stringify(man, null, 2));

    const out = await e.tool("apply_verified_winner", { runId });
    assert.equal(out.__error, undefined, `凭据写不下去不得把 apply 变成一次错误: ${JSON.stringify(out)}`);
    assert.equal(out.status, "applied", `响应必须带真实状态: ${JSON.stringify(out)}`);
    assert.ok((out.internalErrors || []).some((s) => /manifest not written: /.test(s)),
      `写盘失败必须跟着响应回来，而不是只留在盘上: ${JSON.stringify(out)}`);
    assert.equal(fs.existsSync(path.join(r.p, "feature.txt")), true, "前置条件：补丁此刻已经在用户树里");
    const report = fs.readFileSync(path.join(runDir, "report.md"), "utf8");
    assert.match(report, /- Status: `applied`/, "report.md 也必须是真实状态");
    assert.match(report, /Internal verifier failure: manifest not written: /,
      "report.md 是凭据写不进时唯一还落得下的披露通道");

    // 另一半（审计点名的缺失）：manifest 此刻是目录，回滚只能也必须有另一份凭据可用 ——
    // apply-state.json 是动手改树之前落下的把手，manifest 写不进 / 读不出时它是唯一的撤销入口。
    const rb = await e.tool("rollback_verified_winner", { runId });
    assert.equal(rb.__error, undefined,
      `manifest 写不进 / 读不出时回滚不得失去入口（apply-state.json 才是把手）: ${JSON.stringify(rb)}`);
    assert.equal(rb.status, "rolled_back", JSON.stringify(rb));
    assert.equal(fs.existsSync(path.join(r.p, "feature.txt")), false, "回滚必须真的把补丁撤出用户树");
    assert.equal(fs.existsSync(path.join(runDir, "apply-state.json")), false,
      "用完的把手必须消失，否则这个 run 的重落地会被自己那次回滚拦住");
  } finally { await e.close(); }

  // (b) verified_best_of 的终态写盘：评审那一枪把每个 run 的 manifest.json 变成目录 →
  // 回 winner_selected 的那一次 saveRun 必炸，宿主拿到的仍必须是真实终态而不是一个错误。
  const b = await spawnEngine({ name: "s5run", env: {
    MOCK_BREAK_RUN_MANIFEST: "1",
    MOCK_REVIEW_JSON: '{"scores":[{"candidateId":"candidate-1","score":88}],"selected":"candidate-1"}',
  } });
  const r2 = mkRepo("s5runrepo");
  try {
    const run = await b.tool("verified_best_of", {
      repoPath: r2.p, task: "x", candidateCount: 1, validationCommand: VALIDATE, reviewMode: "mcode_model",
    });
    assert.equal(run.__error, undefined, `凭据写不下去不得把 run 变成错误: ${JSON.stringify(run)}`);
    assert.equal(run.status, "winner_selected", JSON.stringify(run));
    assert.equal(run.winnerId, "candidate-1");
    assert.match(fs.readFileSync(run.reportPath, "utf8"), /Internal verifier failure: manifest not written: /);
    assert.equal(worktrees(r2), 1, "凭据写不进也得回收 worktree");
    assert.equal(leakyBranches(r2), "", "凭据写不进也得删分支");
  } finally { await b.close(); }
});

// S6：评审阶段是唯一一个"带着 runSignal  spawn、后面却没有取消检查"的阶段边界。宿主在那一刻
// notifications/cancelled：被杀死的评审给不出裁决，旧代码于是照常落 review_pending + pending，
// 还提示宿主"去 select_verified_candidate"—— 和"评审真跑了但 abstain"完全无法区分。
// 缝：评审自报已开始再睡 60s，取消在几秒内到达；不看钟的判据是状态本身。
test("S6：评审阶段收到 notifications/cancelled 必须落成 cancelled", { timeout: 180_000 }, async () => {
  const r = mkRepo("s6repo");
  const hit = path.join(dir, "s6-review-hit.txt");
  fs.rmSync(hit, { force: true });
  const e = await spawnEngine({ name: "reviewcancel", env: {
    MOCK_REVIEW_HIT: fwd(hit), MOCK_REVIEW_SLEEP_MS: "60000",
    MOCK_REVIEW_JSON: '{"scores":[{"candidateId":"candidate-1","score":88}],"selected":"candidate-1"}',
  } });
  try {
    const p = e.tool("verified_best_of", {
      repoPath: r.p, task: "x", candidateCount: 1, validationCommand: VALIDATE, reviewMode: "mcode_model",
    });
    const runId = e.lastId();
    const early = await Promise.race([until(hit, 150_000).then(() => null), p]);
    assert.equal(early, null, `run 在评审启动前就返回了，本测失去意义: ${JSON.stringify(early)}`);
    e.notify("notifications/cancelled", { requestId: runId });
    const out = await p;
    assert.match(String(out.__error), /cancelled by host/,
      `评审被取消必须报成被宿主取消: ${JSON.stringify(out)}`);
    const runs = fs.readdirSync(path.join(e.dataDir, "runs"));
    assert.equal(runs.length, 1, `应留下一条记账的 run: ${runs.join(",")}`);
    const man = readManifest(path.join(e.dataDir, "runs", runs[0], "manifest.json"));
    assert.equal(man.status, "cancelled",
      `评审阶段的取消不得留下 ${man.status} —— 那读起来像"评审给了结论、等人挑"）`);
    assert.notEqual(man.selectionMethod, "pending", "abstain 的口径不能被一次取消借用");
    assert.equal(man.review, null, `被掐死的评审不得留下一份像真裁决的回执: ${JSON.stringify(man.review)}`);
    assert.equal(worktrees(r), 1, "取消评审后 worktree 必须回收");
    assert.equal(leakyBranches(r), "", "取消评审后分支必须删除");
  } finally { await e.close(); }
});

// S7：`git worktree add -b` 会先登记 worktree、先建分支，再跑 checkout —— 所以一条半途而废的 add
// 留下的是"登记 + 分支 + 半个目录"三样，而候选 k 从没进过 run.candidates，清理循环按
// run.candidates 迭代就永远看不见它：登记没人摘、分支没人删，而 `worktree prune` 对目录还在的
// worktree 无能为力。缝用 post-checkout 钩子（实测 git 2.55：钩子退 7 → add 退 7，登记与分支都在），
// 只对 candidate-2 失效，candidate-1 必须正常建出来，才是"半途而废"的形状。
test("S7：worktree add 半途而废留下的登记与分支必须被回收", { timeout: 180_000 }, async () => {
  const r = mkRepo("addfailrepo");
  const hk = path.join(dir, "addfail-hooks");
  fs.mkdirSync(hk, { recursive: true });
  fs.writeFileSync(path.join(hk, "post-checkout"),
    '#!/bin/sh\ncase "$(pwd)" in\ncandidate-2*|*candidate-2*) exit 7 ;;\nesac\nexit 0\n');
  fs.chmodSync(path.join(hk, "post-checkout"), 0o755);
  r.g("config", "core.hooksPath", fwd(hk));
  const e = await spawnEngine({ name: "addfail" });
  try {
    const out = await e.tool("verified_best_of", {
      repoPath: r.p, task: "x", candidateCount: 2, validationCommand: VALIDATE,
    });
    assert.match(String(out.__error), /worktree add failed for candidate-2/,
      `必须是第二步失败: ${JSON.stringify(out)}`);
    const runs = fs.readdirSync(path.join(e.dataDir, "runs"));
    assert.equal(runs.length, 1, `这条 run 要留下凭据: ${runs.join(",")}`);
    const man = readManifest(path.join(e.dataDir, "runs", runs[0], "manifest.json"));
    assert.notEqual(man.status, "running", "半途而废的 run 也要有终态");
    assert.ok((man.internalErrors || []).some((s) => /worktree add failed for candidate-2/.test(s)),
      `原始成因要进既有的 internalErrors 通道: ${JSON.stringify(man.internalErrors)}`);
    assert.ok(Array.isArray(man.cleanupWarnings), `清理必须跑过并记账: ${JSON.stringify(man.cleanupWarnings)}`);
    assert.equal(worktrees(r), 1,
      `不得留下登记的候选 worktree: ${r.g("worktree", "list").stdout}`);
    assert.equal(leakyBranches(r), "",
      `不得留下候选分支（llm-verifier/<runId>/ 前缀是本插件自己造的，才有资格删）: ${leakyBranches(r)}`);
  } finally { await e.close(); }
});

// S8：ref 兜底管的是「分支在、登记不在」那一半（S7 那对里 prune 也够不着的孤儿分支形态）。它的匹配
// 模式一旦写错就永远是空集 —— 而空集不报错：git for-each-ref 退 0、stdout 为空，所以 :759 那条
// status !== 0 的告警也不会响，兜底静默失效且没人知道。这里让 post-checkout 钩子在候选 2 的 add
// 过程中，于本 run 自己的前缀下多造一条从未登记过 worktree 的分支：主 sweep 按登记迭代看不见它，
// 只有 ref 兜底删得掉。把兜底模式改回对不上前缀的写法（曾经是的 zz-${prefix}）这条测即变红。
test("S8：本 run 前缀下没有 worktree 登记的孤儿分支必须被 ref 兜底回收", { timeout: 180_000 }, async () => {
  const r = mkRepo("orphanrepo");
  const hk = path.join(dir, "orphan-hooks");
  fs.mkdirSync(hk, { recursive: true });
  fs.writeFileSync(path.join(hk, "post-checkout"),
    '#!/bin/sh\ncase "$(pwd)" in\n*candidate-2*)\n' +
    '  rid=$(basename "$(dirname "$(dirname "$(pwd)")")")\n' +
    '  git branch "llm-verifier/$rid/candidate-9" HEAD || exit 9\n  ;;\nesac\nexit 0\n');
  fs.chmodSync(path.join(hk, "post-checkout"), 0o755);
  r.g("config", "core.hooksPath", fwd(hk));
  const e = await spawnEngine({ name: "orphan" });
  try {
    const out = await e.tool("verified_best_of", {
      repoPath: r.p, task: "x", candidateCount: 2, validationCommand: VALIDATE,
    });
    assert.equal(out.__error, undefined, `run 本身要跑成功，孤儿分支才是唯一变量: ${JSON.stringify(out)}`);
    const man = readManifest(out.manifestPath);
    // 反向对照：正常回收不得报泄漏，否则"没泄漏"和"泄漏了但没说"就分不开。
    assert.ok(Array.isArray(man.cleanupWarnings), `清理必须跑过并记账: ${JSON.stringify(Object.keys(man))}`);
    assert.deepEqual(man.cleanupWarnings, [],
      `孤儿分支要安静地被回收，不该产生告警: ${JSON.stringify(man.cleanupWarnings)}`);
    assert.equal(leakyBranches(r), "",
      `ref 兜底必须删掉这条没有登记的孤儿分支: ${leakyBranches(r)}`);
    assert.equal(worktrees(r), 1,
      `工作区也不得留下候选 worktree: ${r.g("worktree", "list").stdout}`);
  } finally { await e.close(); }
});

// S9：只有走 configure 的 config 会被 validateConfig 钳住；手改/旧版 config.json 是直接进 run 的。
// 四个时限里有三个进的是**算术**而不是定时器：NaN ⇒ deadlineAt=NaN ⇒ 每一步的
// `Math.max(1000, Math.min(x, NaN))` 都是 NaN ⇒ falsy ⇒ 那一步干脆不装定时器，还会把
// `--timeout NaNm` 送进 mcode 的 argv；null ⇒ deadline 就是"现在"，整个 run 1 ms 内被判 timeout。
// 断言挂在盘上的快照值上（钳制的直接证据），不挂时钟上——时钟断言在争用下不可判定。
test("S9：坏掉的时限配置必须回落到默认值，不得把死线变成 NaN 或 0", { timeout: 180_000 }, async () => {
  const r = mkRepo("cfgtrepo");
  const e = await spawnEngine({ name: "cfgtimeout" });
  try {
    fs.writeFileSync(path.join(e.dataDir, "config.json"), JSON.stringify({
      totalTimeoutMin: "abc", candidateTimeoutMin: null, reviewTimeoutMin: 0,
    }));
    const out = await e.tool("verified_best_of", {
      repoPath: r.p, task: "x", candidateCount: 1, validationCommand: VALIDATE,
    });
    assert.equal(out.__error, undefined, `坏配置要回落，不是把 run 打死: ${JSON.stringify(out)}`);
    const man = readManifest(out.manifestPath);
    assert.equal(man.config.totalTimeoutMin, 45, `totalTimeoutMin 未钳制: ${JSON.stringify(man.config)}`);
    assert.equal(man.config.candidateTimeoutMin, 20, "candidateTimeoutMin 未钳制");
    assert.equal(man.config.reviewTimeoutMin, 5, "reviewTimeoutMin 未钳制");
    assert.ok(Number.isFinite(man.deadlineAt) && man.deadlineAt > Date.parse(man.createdAt),
      `deadlineAt 必须是未来的真数: ${man.deadlineAt} / ${man.createdAt}`);
    assert.notEqual(man.status, "timeout", `回落后的 run 不该被判超时: ${man.status}`);
  } finally { await e.close(); }
});

// S10：manifest 里的 repoPath 是**被变更目标**，而每个 git() 都用它当 cwd 起子进程。缺了它，
// spawnSync({cwd: undefined}) 不报错、就在服务端自己的进程 cwd 里跑（实测 status 0），于是补丁
// 落在插件宿主的工作树里；而 `if (run.baseCommit)` 那道 HEAD 校验也一起被跳过。所以拦截点必须在
// 读 manifest 那一层 —— apply / rollback / 任何后续动作都走 loadRun。
test("S10：manifest 的 repoPath 不是仓库时，任何动作都必须拒绝", { timeout: 180_000 }, async () => {
  const r = mkRepo("repopathrepo");
  const e = await spawnEngine({ name: "repopath" });
  try {
    const patch = makePatch(r, "feature.txt", "added by candidate\n");
    const { runId, runDir } = seedRun(e, {
      name: "rppath0", repoPath: r.p, patchText: patch, validationCommand: "exit 0",
    });
    const mpath = path.join(runDir, "manifest.json");
    const man = readManifest(mpath);
    delete man.repoPath;                       // 旧版/手改 manifest 的形状
    fs.writeFileSync(mpath, JSON.stringify(man, null, 2));
    const out = await e.tool("apply_verified_winner", { runId });
    assert.match(String(out.__error), /repoPath is not an existing git work tree/,
      `必须是 loadRun 的点名拒绝，不能是碰巧的 git 报错: ${JSON.stringify(out)}`);
    assert.equal(fs.existsSync(path.join(r.p, "feature.txt")), false, "不得落在用户仓库里");
  } finally { await e.close(); }
});

// S11：select 里 report.md 写失败**不得**把一次已完成的选择不变成错误。裸 saveRun 是刻意的（写盘
// 就是操作本身），但 report 是从 manifest 派生的：它炸掉时若抛错，宿主收到 error，重试又被
// "status is winner_selected, expected review_pending" 挡住 —— 于是它永远不知道自己已经选成功了。
// 修法是把 report 的失败吞进 internalErrors 并且**先写 report 再写 manifest**，让披露留在盘上。
test("S11：report.md 写不进时，select 仍要返回成功并把失败记进 manifest", { timeout: 180_000 }, async () => {
  const r = mkRepo("selreportrepo");
  const e = await spawnEngine({ name: "selreport" });
  try {
    const out0 = await e.tool("verified_best_of", {
      repoPath: r.p, task: "x", candidateCount: 2, validationCommand: VALIDATE,
    });
    assert.equal(out0.status, "review_pending", `这条测需要父代理评审态: ${JSON.stringify(out0)}`);
    const rdir = path.dirname(out0.manifestPath);
    fs.rmSync(path.join(rdir, "report.md"), { force: true });
    fs.mkdirSync(path.join(rdir, "report.md"));   // EISDIR：report 写不下去，manifest 仍可写
    const sel = await e.tool("select_verified_candidate", {
      runId: out0.runId, candidateId: "candidate-1", reason: "924 S11",
    });
    assert.equal(sel.__error, undefined, `report 写不进不得让选择变成错误: ${JSON.stringify(sel)}`);
    assert.equal(sel.status, "winner_selected", JSON.stringify(sel));
    const man = readManifest(out0.manifestPath);
    assert.equal(man.status, "winner_selected", "盘上终态必须和响应一致");
    assert.ok((man.internalErrors || []).some((s) => /report not written: /.test(s)),
      `失败的披露必须留在盘上（这就是先写 report 再写 manifest 的理由）: ${JSON.stringify(man.internalErrors)}`);
  } finally { await e.close(); }
});

// S17：回滚要 reverse-apply 的那个补丁路径来自凭据文件（apply-state.json 的 patchPath，或把手读不出来
// 时的 manifest.appliedPatchPath）。它被当作 `git apply -R <path>` 的位置参数递进去：以 `-` 开头的值会被
// git 当成**选项**读，任何绝对路径都会被这个服务用自己的权限读一遍。baseCommit 已经有十六进制围栏了，
// 这条没有 ⇒ 关掉的那扇门比留着的这扇更宽。判据：路径必须落在该 run 自己的目录里，而且拒绝要发生在
// 动树之前。收紧守卫必须带一枚"合法入口仍然通过"的对照，否则这条测是在测我自己写窄的世界。
test("S17：回滚使用的补丁路径是记录里的值，必须先钉在 run 目录内", { timeout: 180_000 }, async () => {
  const e = await spawnEngine({ name: "patchfence" });
  const r = mkRepo("patchfencerepo");
  try {
    const { runId, runDir } = seedRun(e, {
      name: "pfna", repoPath: r.p, patchText: makePatch(r, "feature.txt", "added\n"), validationCommand: "",
    });
    assert.equal((await e.tool("apply_verified_winner", { runId })).status, "applied");
    const stPath = path.join(runDir, "apply-state.json");
    const record = () => JSON.parse(fs.readFileSync(stPath, "utf8"));
    const rewrite = (patchPath) => fs.writeFileSync(stPath, JSON.stringify({ ...record(), patchPath }));
    assert.equal(record().patchPath, path.join(runDir, "candidate-1.patch"), "夹具前提：把手得先带着引擎自己写的那个路径");

    rewrite("--assume-unchanged");
    let rb = await e.tool("rollback_verified_winner", { runId });
    assert.match(rb.__error, /not a usable file name/u, `选项形状必须在 argv 之前被拒: ${JSON.stringify(rb)}`);
    assert.equal(fs.existsSync(path.join(r.p, "feature.txt")), true, "被拒绝的回滚不得已经动过树");

    rewrite(path.join(r.p, "feature.txt"));
    rb = await e.tool("rollback_verified_winner", { runId });
    assert.match(rb.__error, /outside the run directory/u, `真实存在但越界的路径必须停在动手之前: ${JSON.stringify(rb)}`);
    assert.equal(fs.existsSync(path.join(r.p, "feature.txt")), true, "同上：越界路径不得被 reverse-apply");

    rewrite(path.join(runDir, "candidate-1.patch"));
    rb = await e.tool("rollback_verified_winner", { runId });
    assert.equal(rb.status, "rolled_back", `合法入口必须照旧通过（对照臂）: ${JSON.stringify(rb)}`);
    assert.equal(fs.existsSync(path.join(r.p, "feature.txt")), false, "对照臂要真的撤回");
  } finally { await e.close(); }
});

// S19：同一份来自凭据的 patchPath，回滚侧刚上了围栏，落地侧（applyVerifiedWinner）却是**第一次**被
// 读到就送进 `git apply --check` / `apply` / `--numstat` 的 argv 位置 —— 也就是说我上一波关的那扇门比
// 旁边这扇更窄。波次 20 复审指出的原话："the apply half is still open"。判据同 S17：选项形状拒、越界
// 真实文件拒（且都必须在动树与落把手之前），以及一枚合法入口的绿对照。
test("S19：apply 侧的补丁路径同样来自凭据，必须先过 run 目录围栏", { timeout: 180_000 }, async () => {
  const e = await spawnEngine({ name: "applyfence" });
  const r = mkRepo("applyfencerepo");
  try {
    const { runId, runDir, patchPath } = seedRun(e, {
      name: "afna", repoPath: r.p, patchText: makePatch(r, "feature.txt", "added\n"), validationCommand: "",
    });
    const mp = path.join(runDir, "manifest.json");
    const tamper = (p) => {
      const m = readManifest(mp);
      m.candidates[0].patchPath = p;
      fs.writeFileSync(mp, JSON.stringify(m));
    };
    const untouched = () => {
      assert.equal(fs.existsSync(path.join(r.p, "feature.txt")), false, "被拒绝的 apply 不得动用户的树");
      assert.equal(fs.existsSync(path.join(runDir, "apply-state.json")), false, "被拒绝的 apply 不得留下撤销把手");
    };

    tamper("--assume-unchanged");
    let res = await e.tool("apply_verified_winner", { runId });
    assert.match(res.__error, /not a usable file name/u, `选项形状必须先进 git 之前被拒: ${JSON.stringify(res)}`);
    untouched();

    // base.js, not feature.txt: the apply route has not created anything yet, so a path the patch would
    // create does not exist and would trip the "no such file" branch instead of the containment branch.
    // What must be proven here is that an EXISTING file outside the run dir is refused before its hash.
    tamper(path.join(r.p, "base.js"));
    res = await e.tool("apply_verified_winner", { runId });
    assert.match(res.__error, /outside the run directory/u, `越界但真实存在的路径必须停在哈希校验之前: ${JSON.stringify(res)}`);
    untouched();

    tamper(patchPath);
    res = await e.tool("apply_verified_winner", { runId });
    assert.equal(res.status, "applied", `合法入口必须照旧能落地（对照臂）: ${JSON.stringify(res)}`);
    assert.equal(fs.existsSync(path.join(r.p, "feature.txt")), true, "对照臂要真的把补丁放回去");
  } finally { await e.close(); }
});

// S20：路径级 HEAD 判断的范围必须是**两个来源的并集**（补丁头 ∪ 凭据里记录的 appliedFiles），只取头是
// 波次 20 复审抓出来的第二处两层不一致：TS 用并集、引擎只用头。危险方向很具体 —— 头少报（或被裁切）时
// 交集变小 ⇒ 引擎放行、TS 拒绝，而引擎那条放行会把**已提交**的内容反成未提交的删除。
// 判据形状照 S15/S16：同一份盘，只改"提交里有没有碰到并集里的路径"。
test("S20：并集里只有 appliedFiles 认识的路径时，提交了它就必须拒绝回滚", { timeout: 180_000 }, async () => {
  const e = await spawnEngine({ name: "union" });
  const r = mkRepo("unionrepo");
  try {
    const { runId, runDir } = seedRun(e, {
      name: "unaa", repoPath: r.p, patchText: makePatch(r, "feature.txt", "added\n"), validationCommand: "",
    });
    assert.equal((await e.tool("apply_verified_winner", { runId })).status, "applied");
    // 让 appliedFiles 比补丁头多知道一个路径：真实世界里 numstat 就是那个更全的来源，这里手工置成同一种
    // 形状（夹具能造的合法形态，TS 侧同理由 record.changedFiles 供）
    const mp = path.join(runDir, "manifest.json");
    const man = readManifest(mp);
    man.appliedFiles = ["feature.txt", "extra.txt"];
    fs.writeFileSync(mp, JSON.stringify(man));
    fs.writeFileSync(path.join(r.p, "extra.txt"), "committed by the user\n");
    r.g("add", "extra.txt");
    r.g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "user commits extra.txt");

    const rb = await e.tool("rollback_verified_winner", { runId });
    assert.match(rb.__error, /those commits touch the patched paths: extra\.txt/u,
      `并集里多出来的那条必须参与判断（放行说明它只看了补丁头）: ${JSON.stringify(rb)}`);
    assert.equal(fs.readFileSync(path.join(r.p, "feature.txt"), "utf8").replace(/\r\n/g, "\n"), "added\n",
      "拒绝要停在动树之前：已落地的补丁内容不得被反掉");

    // 绿对照：把那次提交换成一个并集都不认识的路径，同一份盘就得放行
    const r2 = mkRepo("unionrepo2");
    const s2 = seedRun(e, { name: "unab", repoPath: r2.p, patchText: makePatch(r2, "feature.txt", "added\n"), validationCommand: "" });
    assert.equal((await e.tool("apply_verified_winner", { runId: s2.runId })).status, "applied");
    const mp2 = path.join(s2.runDir, "manifest.json");
    const man2 = readManifest(mp2);
    man2.appliedFiles = ["feature.txt", "extra.txt"];
    fs.writeFileSync(mp2, JSON.stringify(man2));
    fs.writeFileSync(path.join(r2.p, "unrelated.txt"), "other work\n");
    r2.g("add", "unrelated.txt");
    r2.g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "unrelated");
    const rb2 = await e.tool("rollback_verified_winner", { runId: s2.runId });
    assert.equal(rb2.status, "rolled_back", `并集没撞上就该放行（对照臂）: ${JSON.stringify(rb2)}`);
    assert.equal(fs.existsSync(path.join(r2.p, "feature.txt")), false, "对照臂要真的撤回");
    assert.equal(fs.existsSync(path.join(r2.p, "unrelated.txt")), true, "无关提交不得被撤销");
  } finally { await e.close(); }
});

// S18：git 会为它认为"不寻常"的名字把 diff 头行 C 引号化，而引号是包住 `a/` 前缀的（本机 git 2.55 实测：
// `diff --git "a/\344\270\255\346\226\207.py" "b/…"`）。`git diff --name-only -z` 那边回答的是**原始**
// 名字 ⇒ 不解引号就永远交集为空，而"为空"在这条守卫里的语义是"我信不过"——于是中文仓库里一次无关提交就把
// 撤销门焊死，正是 S15 要救的那种用户。TS 层已有 unquoteGitPath + 单测；这条是引擎侧的活体对照（项目头号
// 缺陷类是"修复只做在一层"）。
test("S18：非 ASCII 文件名的补丁不得把撤销门焊死", { timeout: 180_000 }, async () => {
  const e = await spawnEngine({ name: "quotepath" });
  const r = mkRepo("quoterepo");
  try {
    const patchText = makePatch(r, "中文.py", "print(1)\n");
    // 夹具前提，不是装饰：这台机器的 git 若关了 core.quotepath，头行就没有引号，这条测会静默变成空转
    assert.match(patchText, /^diff --git "a\//mu, "前提不成立：这份 git 没有把非 ASCII 名字 C 引号化");
    const { runId } = seedRun(e, { name: "qpta", repoPath: r.p, patchText, validationCommand: "" });
    assert.equal((await e.tool("apply_verified_winner", { runId })).status, "applied");
    fs.writeFileSync(path.join(r.p, "unrelated.txt"), "other work\n");
    // 点名 add，不用 -A：-A 会把刚落地的 中文.py 一起提交进去，那条提交就真的动了被补丁的路径，
    // 夹具前提（"无关提交"）反过来被我的夹具证伪了。
    r.g("add", "unrelated.txt");
    r.g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "unrelated work");

    const rb = await e.tool("rollback_verified_winner", { runId });
    assert.equal(rb.status, "rolled_back",
      `无关提交之后仍须能撤销；报"names no paths"就说明头行没被读懂: ${JSON.stringify(rb)}`);
    assert.equal(fs.existsSync(path.join(r.p, "中文.py")), false, "补丁内容要真的撤回");
    assert.equal(fs.existsSync(path.join(r.p, "unrelated.txt")), true, "无关提交带来的文件不得被撤销");
  } finally { await e.close(); }
});

// E1：引擎的每一个 spawn 都必须过环境白名单（对齐 src/process.ts:517-552 sanitizedEnvironment，
// TS 层用它起候选 src/core.ts:928 和验证 :1038/:2332）。攻击面是候选/仓库自己写的那一类代码：
// 候选那一枪里的代理会把读到的东西写进文件，文件进补丁；验证那一枪更直接，候选 package.json 的
// install 生命周期脚本读的就是 process.env。哨兵只设在宿主的 process.env 上（不进 mock-env.json，
// 那是脚手架开关的通道），白名单一破，它就会随补丁回到引擎的凭据里。
test("E1：候选与验证那一枪不得继承宿主的环境变量", { timeout: 180_000 }, async () => {
  const CANARY = "sk-SENTINEL-not-a-key-7c1f";
  process.env.MOCK_LEAK_CANARY = CANARY;      // 必须在 spawnEngine 之前
  const e = await spawnEngine({ name: "envallow", env: { MOCK_CANARY_FILE: "leak.txt" } });
  try {
    const run = await e.tool("verified_best_of", {
      repoPath: repo, task: "x", candidateCount: 1,
      validationCommand: `node -e "require('fs').appendFileSync('leak.txt',` +
        `'\\nvalidation=['+(process.env.MOCK_LEAK_CANARY||'')+']')"`
    });
    assert.equal(run.__error, undefined, JSON.stringify(run));
    assert.equal(run.status, "winner_selected", `前置条件：这枪要真跑出补丁: ${JSON.stringify(run)}`);
    const patch = fs.readFileSync(run.winnerPatchPath, "utf8");
    // 夹具前提：两个探针都得真的写进这份补丁，否则"没有哨兵"是空断言。
    assert.match(patch, /leak\.txt/, `探针文件没被抓到，本测失去意义:\n${patch}`);
    assert.match(patch, /canary=\[\]/, `候选那一枪的探针没落盘: ${patch}`);
    assert.match(patch, /validation=\[\]/, `验证那一枪的探针没落盘: ${patch}`);
    assert.equal(patch.includes(CANARY), false, "候选/验证读到了宿主的环境变量（补丁里有哨兵）");
    assert.equal(fs.readFileSync(run.manifestPath, "utf8").includes(CANARY), false,
      "哨兵不得出现在 run manifest 里");
  } finally {
    delete process.env.MOCK_LEAK_CANARY;
    await e.close();
  }
});

// E2：子进程自己退了、孙进程还占着它留下的管道时，close 永远不来，而超时那一枪只会再杀一次 ——
// promise 就悬着，整条 run 跟着悬着。TS 层在 src/process.ts:491-510 用"exit 之后 250ms 宽限结算"
// 解决，这里同款（close 那条路照旧，谁先到算谁）。判据不看墙钟：验证预算只有 3s（0.05 分钟，S4
// 同款手改 config.json 旁路），没有宽限时答案只能来自预算那次杀树 —— 删掉 exit 处理器实测
// 30.1s 红在 timedOut=true（孙进程自己 25s 睡完、管道这才 EOF），有宽限时 exit 后 550ms 就结算。
test("E2：管道被孙进程占着时，验证仍须在 exit 宽限内结算而不是被预算掐掉", { timeout: 180_000 }, async () => {
  const e = await spawnEngine({ name: "stdiograce" });
  const r = mkRepo("stdiogracerepo");
  try {
    fs.writeFileSync(path.join(e.dataDir, "config.json"), JSON.stringify({ validationTimeoutMin: 0.05 }));
    const run = await e.tool("verified_best_of", {
      repoPath: r.p, task: "x", candidateCount: 1,
      validationCommand: `node "${fwd(pipehold)}"`,
    });
    assert.equal(run.__error, undefined, JSON.stringify(run));
    assert.equal(run.status, "winner_selected",
      `验证必须按 exit 宽限结算，不能被 3s 预算掐掉: ${JSON.stringify(run)}`);
    const v = readManifest(run.manifestPath).candidates[0].validation;
    assert.equal(v.status, "passed", JSON.stringify(v));
    assert.notEqual(v.timedOut, true, "超时杀树那条路不得是答案");
  } finally { await e.close(); }
});

// R1：引擎过去只问 `--is-inside-work-tree`，所以仓库的**子目录**也能开跑 —— 而 `git apply` 在子目录
// 里执行时打印 "Skipped patch '<path>'" 并退 0，工作区分毫未动（git 2.55.0.windows.5 实测 8 条断言
// 全绿：docs/proof/tools/probe-git-apply-subdir-924.mjs）。于是那条 run 会带着 apply-state 记录和
// 一份未改动树上的回执回报 `applied`。门与 src/git.ts:169-181 同形（两侧 realpath 后比大小写无关
// 的正规式），且必须落在任何 worktree/run 目录被造出来之前。
test("R1：repoPath 是仓库子目录时必须在开工前被点名拒绝", { timeout: 180_000 }, async () => {
  const r = mkRepo("rootgate");
  const sub = path.join(r.p, "packages", "app");
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, "nested.js"), "module.exports = 1;\n");
  r.g("-c", "user.name=t", "-c", "user.email=t@t", "add", "-A");
  r.g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "nested dir");
  const e = await spawnEngine({ name: "rootgate" });
  try {
    const bad = await e.tool("verified_best_of", {
      repoPath: sub, task: "x", candidateCount: 1, validationCommand: VALIDATE,
    });
    assert.match(String(bad.__error), /must be the Git repository root/, JSON.stringify(bad));
    // got / root is 两个路径都要报出来（走正规式比，Windows 给的是长路径 + 反斜杠）
    const flat = (s) => String(s).replace(/[\\/]+/g, "/").toLowerCase();
    assert.ok(flat(bad.__error).includes("packages/app") && flat(bad.__error).includes("rootgate"),
      `got 与 root is 必须都点名: ${bad.__error}`);
    // 拒绝必须零副作用：没有 run 目录、没有检出的 worktree、没有候选分支
    const runsDir = path.join(e.dataDir, "runs");
    const left = fs.existsSync(runsDir) ? fs.readdirSync(runsDir) : [];
    assert.deepEqual(left, [], `被拒的 repoPath 不得留下 run 目录: ${left.join(",")}`);
    assert.equal(worktrees(r), 1, "被拒的 repoPath 不得检出 worktree");
    assert.equal(leakyBranches(r), "", "被拒的 repoPath 不得留下分支");
    // 反向半条：同一个仓库的根必须照常放行，否则这条门只是"什么都拒"
    const ok = await e.tool("verified_best_of", {
      repoPath: r.p, task: "x", candidateCount: 1, validationCommand: VALIDATE,
    });
    assert.equal(ok.__error, undefined, `仓库根必须仍被接受: ${JSON.stringify(ok)}`);
    assert.equal(ok.status, "winner_selected", JSON.stringify(ok));
    assert.equal(worktrees(r), 1, "带子目录的仓库在根上仍要收干净");
  } finally { await e.close(); }
});

// R2：宿主取消落在生成/验证那一枪上时，shAsync 只把孩子带走、什么都不记 —— 那一枪于是既没有
// error、也没有 timedOut、更没有解析出的 result，runCandidate/runValidation 落到最后的 `failed`
// 分支，report.md 把脚手架自己的中止写成"模型没做出来"。缝：candidate-1 停在生成的睡眠里
// （MOCK_PID_DIR 先自报 pid 才睡 ⇒ 生成本枪真的在飞），随后 notifications/cancelled，不看钟。
test("R2：被 run 自己的取消杀掉的步骤必须点名取消，不得记成 failed", { timeout: 240_000 }, async () => {
  const r = mkRepo("abortcause");
  const pids = path.join(dir, "pids-abortcause");
  fs.rmSync(pids, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  const e = await spawnEngine({ name: "abortcause", env: {
    MOCK_SLEEP_MS: "240000", MOCK_PID_DIR: fwd(pids),
  } });
  try {
    const p = e.tool("verified_best_of", {
      repoPath: r.p, task: "x", candidateCount: 1, maxConcurrent: 1, validationCommand: VALIDATE,
    }).catch(() => ({}));
    const runId = e.lastId();   // call() 同步自增，返回时这条 run 的请求 id 已定
    assert.ok(await until(path.join(pids, "candidate-1.pid"), 150_000),
      "候选没进入生成就结束了 = 本测失去意义");
    e.notify("notifications/cancelled", { requestId: runId });
    await p;
  } finally { await e.close(); }
  const runsDir = path.join(e.dataDir, "runs");
  const runs = fs.readdirSync(runsDir);
  assert.equal(runs.length, 1, `应留下一条记账的 run: ${runs.join(",")}`);
  const runDir = path.join(runsDir, runs[0]);
  const man = readManifest(path.join(runDir, "manifest.json"));
  assert.equal(man.status, "cancelled", JSON.stringify(man.status));
  const c = man.candidates[0];
  assert.equal(c.generation.status, "cancelled",
    `生成被 run 自己掐断不得记成候选的失败: ${JSON.stringify(c.generation)}`);
  assert.equal(c.generation.abortedBy, "cancelled by host", JSON.stringify(c.generation));
  assert.equal(c.validation.status, "cancelled",
    `同一枪之后的验证也不得记成 failed: ${JSON.stringify(c.validation)}`);
  assert.equal(c.validation.abortedBy, "cancelled by host", JSON.stringify(c.validation));
  const report = fs.readFileSync(path.join(runDir, "report.md"), "utf8");
  assert.match(report, /- Generation: `cancelled`/, report);
  assert.match(report, /Generation ended because the verifier aborted it \(cancelled by host\)/,
    `report.md 必须说出成因是脚手架自己的中止: ${report}`);
  assert.match(report, /Validation ended because the verifier aborted it \(cancelled by host\)/, report);
  assert.doesNotMatch(report, /- Generation: `failed`/, "取消不得伪装成模型的失败");
});

// R3：`s?.score ?? 0` 让"评审压根没提这个候选"和"评审给了 0 分"在 report.md 里长成同一句话
// （TS 层 src/reviewer.ts:199-205 对这种评审直接拒收）。评审的显式 selected 照旧优先，
// 但没被评过的候选不能白拿一个 0 分。
test("R3：评审漏评的候选不得被印成 score 0", { timeout: 180_000 }, async () => {
  const r = mkRepo("noscore");
  const e = await spawnEngine({ name: "noscore", env: {
    MOCK_REVIEW_JSON: '{"scores":[{"candidateId":"candidate-1","score":88,"risks":"ok"}],"selected":"candidate-1"}',
  } });
  try {
    const run = await e.tool("verified_best_of", {
      repoPath: r.p, task: "x", candidateCount: 2, validationCommand: VALIDATE, reviewMode: "mcode_model",
    });
    assert.equal(run.__error, undefined, JSON.stringify(run));
    assert.equal(run.winnerId, "candidate-1", `评审的显式选择照旧生效: ${JSON.stringify(run)}`);
    const man = readManifest(run.manifestPath);
    assert.equal(man.candidates[0].review.score, 88, JSON.stringify(man.candidates[0].review));
    assert.equal(man.candidates[1].review, null,
      `没被评过的候选不得有一份评审: ${JSON.stringify(man.candidates[1].review)}`);
    const report = fs.readFileSync(run.reportPath, "utf8");
    const tail2 = report.slice(report.indexOf("## candidate-2"));
    assert.ok(tail2.length > 10, `前提：报告里要有 candidate-2 那一节: ${report}`);
    assert.doesNotMatch(tail2, /Review score/, `漏评的候选不许有评分行:\n${tail2}`);
    assert.doesNotMatch(report, /score 0/, `report.md 任何角落都不许出现"score 0":\n${report}`);
  } finally { await e.close(); }
});

