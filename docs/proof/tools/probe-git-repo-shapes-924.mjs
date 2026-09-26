// 波次 24 A9 的反证：一个只读工位声称"引擎没有 TS 的 inspectRepository 形状门 ⇒ sparse checkout /
// submodule 仓库里胜者补丁会在 apply 时删掉被跟踪的文件"。两个形状各自实测，结论是**都不成立**，
// 所以这条没有进引擎。留这个文件是因为"没门"听起来像漏洞，下一位会再立案；判据是原语本身：
//   (1) sparse checkout：跳过的工作树文件会不会被 `git add -A` + `git diff --cached` 记成删除？
//   (2) 未初始化的 submodule（引擎的 `worktree add` 不带 --recurse-submodules）：新建的工作树里
//       vendor/ 存不存在、clean 门过不过、补丁里会不会出现 `deleted file mode 160000`？
// 只建临时仓库，不碰任何真实仓库；跑法：node docs/proof/tools/probe-git-repo-shapes-924.mjs
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const g = (cwd, ...a) => { const r = spawnSync("git", a, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${a.join(" ")} -> ${r.status} ${r.stderr.trim().slice(0, 160)}`); return r.stdout; };
const mk = (n) => { const d = mkdtempSync(join(tmpdir(), n));
  g(d, "init", "-q", "-b", "main"); g(d, "config", "user.email", "probe@p"); g(d, "config", "user.name", "probe"); return d; };
const heads = [];
const roots = [];
try {
  // (1) sparse checkout
  const A = mk("shape-sparse-"); roots.push(A);
  for (const n of ["keep.txt", "gone1.txt", "gone2.txt"]) writeFileSync(join(A, n), n + "\n");
  g(A, "add", "-A"); g(A, "commit", "-q", "-m", "base");
  const sparseOut = g(A, "sparse-checkout", "set", "--no-cone", "keep.txt");
  writeFileSync(join(A, "keep.txt"), "keep.txt\nedited\n");
  g(A, "add", "-A");
  const d1 = g(A, "diff", "--cached", "--binary", "--full-index");
  heads.push(["(1) sparse checkout",
    `skip-worktree=${g(A, "ls-files", "-v").trim().split("\n").filter((l) => l.startsWith("S ")).length}`,
    `status after add=${JSON.stringify(g(A, "status", "--porcelain"))}`.slice(0, 46),
    `patch touches only keep.txt=${d1.split("\n").filter((l) => l.startsWith("diff --git")).length === 1}`,
    `records deletions=${/deleted file mode/.test(d1)}`]);
  // (2) uninitialized submodule in a fresh worktree
  const dep = mk("shape-dep-"); roots.push(dep);
  writeFileSync(join(dep, "lib.js"), "v1\n"); g(dep, "add", "-A"); g(dep, "commit", "-q", "-m", "d1");
  const B = mk("shape-super-"); roots.push(B);
  writeFileSync(join(B, "top.txt"), "t\n"); g(B, "add", "-A"); g(B, "commit", "-q", "-m", "s1");
  g(B, "-c", "protocol.file.allow=always", "submodule", "add", "-q", dep, "vendor");
  g(B, "commit", "-q", "-m", "submodule");
  const wt = join(tmpdir(), "shape-super-wt-" + B.slice(-6)); roots.push(wt);
  g(B, "worktree", "add", "-q", "--detach", wt, "HEAD");
  writeFileSync(join(wt, "top.txt"), "t\nfixed by candidate\n");
  g(wt, "add", "-A");
  const d2 = g(wt, "diff", "--cached", "--binary", "--full-index");
  heads.push(["(2) uninitialized submodule",
    `worktree has vendor/=${existsSync(join(wt, "vendor"))}`,
    `status after add nonempty=${g(wt, "status", "--porcelain") !== ""}`,
    `patch has gitlink=${/Subproject commit/.test(d2)}`,
    `records submodule deletion=${/deleted file mode 160000/.test(d2)}`]);
  console.log(`git ${g(process.cwd(), "--version").trim()}`);
  for (const h of heads) console.log(h.join("  "));
  const verdict = !/deleted file/.test(d1) && !/deleted file mode 160000/.test(d2);
  console.log(`\nREPO-SHAPE CLAIM REFUTED = ${verdict}  (neither shape makes the winner's patch delete tracked entries)`);
  process.exitCode = verdict ? 0 : 1;
} finally {
  for (const r of roots) { try { rmSync(r, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {} }
}
