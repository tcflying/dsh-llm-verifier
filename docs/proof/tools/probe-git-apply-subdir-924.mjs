// 波次 24 A9 的正解。工位说"引擎缺 TS 的仓库形状门 ⇒ 补丁会删用户跟踪文件"，那半句被
// probe-git-repo-shapes-924.mjs 推翻；**缺门这件事本身是真的**，但真后果在 apply 那一侧，方向和它说的相反：
// 不是删错，是**什么都没做却报成功**。git 从仓库子目录跑 `apply` 时，会把"不在当前前缀下"的补丁
// 打印成 `Skipped patch '<path>'` 并**以 0 退出**。引擎只查 `--is-inside-work-tree`（`:998`），所以
// repoPath 给子目录它照收：候选在整仓 worktree 里正常产出补丁，apply 从子目录起就静默空转，
// 而调用方按 rc==0 判"已应用"、写 apply-state/收据。TS 侧靠 git.ts:175-181 要求 toplevel 相等，天然不会走到这。
// 本文件断言的是 git 自己的行为（不是我的推断）：哪天 git 改成报错，这里会先红，那条门也就该换写法。
//   node docs/proof/tools/probe-git-apply-subdir-924.mjs
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync, existsSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const g = (c, ...a) => spawnSync("git", a, { cwd: c, encoding: "utf8" });
const G = (c, ...a) => { const r = g(c, ...a); if (r.status !== 0) throw new Error(`git ${a.join(" ")} -> ${r.status} ${r.stderr.trim().slice(0, 140)}`); return r.stdout; };
const roots = [];
try {
  const R = mkdtempSync(join(tmpdir(), "appl-sub-")); roots.push(R);
  G(R, "init", "-q", "-b", "main"); G(R, "config", "user.email", "probe@p"); G(R, "config", "user.name", "probe");
  writeFileSync(join(R, "top.txt"), "top\n");
  mkdirSync(join(R, "sub"), { recursive: true });
  writeFileSync(join(R, "sub", "inner.txt"), "inner\n");
  G(R, "add", "-A"); G(R, "commit", "-q", "-m", "base");
  // Both paths live under one per-run parent: a fixed `appl-sub-wt` makes `git worktree add` throw at a
// leftover from a killed run, and the probe would then go red for a reason unrelated to its claim. The
// worktree target itself has to be absent, so it is a name inside the parent rather than the parent.
const scratch = mkdtempSync(join(tmpdir(), "appl-sub-scratch-")); roots.push(scratch);
const wt = join(scratch, "tree");
  G(R, "worktree", "add", "-q", "--detach", wt, "HEAD");
  writeFileSync(join(wt, "top.txt"), "top\nfixed by candidate\n");
  G(wt, "add", "-A");
  const pf = join(tmpdir(), "appl-sub.patch");
  writeFileSync(pf, G(wt, "diff", "--cached", "--binary", "--full-index"));
  const before = readdirSync(R).join(",");
  const chk = g(join(R, "sub"), "apply", "--check", "-v", pf);
  const app = g(join(R, "sub"), "apply", "-v", pf);
  const checks = [
    ["engine accepts repoPath=subdir (only --is-inside-work-tree)", g(join(R, "sub"), "rev-parse", "--is-inside-work-tree").status === 0],
    ["git apply --check from subdir exits 0", chk.status === 0],
    ["it prints 'Skipped patch'", /Skipped patch/.test(chk.stderr + chk.stdout)],
    ["git apply from subdir exits 0", app.status === 0],
    ["nothing was applied (root file bytes unchanged)", readFileSync(join(R, "top.txt"), "utf8") === "top\n"],
    ["no stray file created in the subdir", !existsSync(join(R, "sub", "top.txt"))],
    ["tree listing unchanged", readdirSync(R).join(",") === before],
    ["git itself calls the tree clean afterwards", G(R, "status", "--porcelain") === ""],
  ];
  for (const [n, ok] of checks) console.log(`${ok ? "ok  " : "FAIL"}  ${n}`);
  const bad = checks.filter(([, ok]) => !ok).length;
  console.log(`\n${bad === 0 ? "SILENT-NOOP CONFIRMED" : "PREMISE CHANGED"}  git ${G(R, "--version").trim()}`);
  console.log("⇒ 引擎必须在接受 repoPath 之前要求 `rev-parse --show-toplevel` 与它相等（TS 已有该门）。");
  process.exitCode = bad === 0 ? 0 : 1;
} finally { for (const r of roots) { try { rmSync(r, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {} } }
