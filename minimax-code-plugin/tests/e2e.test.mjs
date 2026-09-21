// Mock 全状态机 e2e：真 spawn 引擎 stdio + 假 mcode，覆盖隔离/评审/落地/回滚/重落地。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.join(here, "..", ".minimax-plugin", "mcp-server.mjs");
const VALIDATE = "type solution.txt >nul 2>&1"; // 引擎 runValidation 走 cmd /c，见下方 skip

let dir, repo, child, buf = "", pending = new Map(), seq = 0;

const call = (method, params) => new Promise((res, rej) => {
  const id = ++seq;
  pending.set(id, { res, rej });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
});
const tool = async (name, args) => {
  const r = await call("tools/call", { name, arguments: args });
  if (r.error) return { __error: r.error.message };
  const t = r.result?.content?.[0]?.text ?? "";
  if (r.result?.isError) return { __error: t };
  try { return JSON.parse(t); } catch { return { __text: t }; }
};
const git = (...a) => spawnSync("git", a, { cwd: repo, encoding: "utf8" });

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "llmv-e2e-"));
  repo = path.join(dir, "origin");
  fs.mkdirSync(repo);
  git("init", "-b", "main", ".");
  fs.writeFileSync(path.join(repo, "base.js"), "module.exports = 1;\n");
  git("-c", "user.name=t", "-c", "user.email=t@t", "add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "init");

  child = spawn(process.execPath, [ENGINE], {
    cwd: dir,
    env: {
      ...process.env,
      LLM_VERIFIER_DATA: path.join(dir, "data"),
      // shell:true 下这一串就是命令前缀，绕开 .mjs 无执行关联的问题
      LLM_VERIFIER_MCODE_BIN: `node "${path.join(here, "mock-mcode.mjs")}"`,
    },
    stdio: ["pipe", "pipe", "inherit"],
  });
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
});

after(async () => {
  child.stdin.end();                       // 引擎自己的退出路径：stdin 关闭即 exit
  await once(child, "close").catch(() => {});
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (e) {
    console.warn(`临时目录未清干净（Windows 偶发 EPERM，%TEMP% 下无妨）: ${e.code}`);
  }
});

test("best-of-N 全状态机", async (t) => {
  if (process.platform !== "win32")
    return t.skip("runValidation 用 cmd /c 跑验证命令，非 Windows 上候选必然全灭");

  await call("initialize", { protocolVersion: "2025-03-26", capabilities: {} });
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

test("mcode_model 评审：schema 失败兜底 + selected 必须最高分", async (t) => {
  if (process.platform !== "win32") return t.skip("同上");

  const run = await tool("verified_best_of", {
    repoPath: repo, task: "fix it", candidateCount: 2, validationCommand: VALIDATE,
    reviewMode: "mcode_model",
  });
  // mock 只回 "done"，不是合法评审 JSON → 裸 JSON 重试仍失败 → 兜底取 passed[0]
  assert.equal(run.status, "winner_selected");
  assert.equal(run.winnerId, "candidate-1");
  const man = JSON.parse(fs.readFileSync(run.manifestPath, "utf8"));
  assert.equal(man.selectionMethod, "model_review");
  assert.ok(man.review.durationMs >= 0, "评审回执落盘");
});

test("enabled:false 只放行配置类工具", async () => {
  await tool("verifier_configure", { enabled: false });
  assert.match((await tool("verified_best_of", { repoPath: repo, task: "x" })).__error, /is disabled/);
  assert.equal((await tool("verifier_get_config", {})).config.enabled, false);
  await tool("verifier_configure", { enabled: true });
});
