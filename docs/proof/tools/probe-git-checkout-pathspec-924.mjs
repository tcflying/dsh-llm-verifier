import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const p = join(process.env.TEMP ?? "/tmp", "dsh-glob-probe2");
rmSync(p, { recursive: true, force: true });
mkdirSync(join(p, "src"), { recursive: true });
const g = (...args) => execFileSync("git", args, { cwd: p, encoding: "utf8" });
g("init", "--quiet", ".");
g("config", "user.email", "t@t");
g("config", "user.name", "t");
writeFileSync(join(p, "src", "probe-x.ts"), "COMMITTED\n");
writeFileSync(join(p, "README.md"), "x\n");
g("add", "-A");
g("commit", "--quiet", "-m", "i");

// Is `src/probe-[x].ts` (a name that does NOT exist) able to reach the innocent tracked sibling?
for (const spec of ["src/probe-[x].ts", ":(top)src/probe-[x].ts", ":(top,literal)src/probe-[x].ts"]) {
  writeFileSync(join(p, "src", "probe-x.ts"), "DIRTY local work\n");
  const r = spawnSync("git", ["checkout", "HEAD", "--", spec], { cwd: p, encoding: "utf8" });
  const after = readFileSync(join(p, "src", "probe-x.ts"), "utf8");
  console.log(
    "checkout", JSON.stringify(spec),
    "rc", r.status,
    "err", (r.stderr || "").trim().slice(0, 60),
    "| sibling now:", JSON.stringify(after.slice(0, 12)),
    after.startsWith("DIRTY") ? "KEPT" : "*** CLOBBERED ***",
  );
  writeFileSync(join(p, "src", "probe-x.ts"), "COMMITTED\n");
  g("add", "-A");
  g("commit", "--quiet", "--allow-empty", "-m", "reset sibling");
}
console.log("version", g("version").trim());
rmSync(p, { recursive: true, force: true });
