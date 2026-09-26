import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const p = join(process.env.TEMP ?? "/tmp", "dsh-glob-probe");
rmSync(p, { recursive: true, force: true });
mkdirSync(join(p, "src"), { recursive: true });
const g = (...args) => execFileSync("git", args, { cwd: p, encoding: "utf8" });
g("init", "--quiet", ".");
g("config", "user.email", "t@t");
g("config", "user.name", "t");
writeFileSync(join(p, "src", "probe-x.ts"), "1\n");
writeFileSync(join(p, "README.md"), "x\n");
g("add", "-A");
g("commit", "--quiet", "-m", "i");
for (const spec of ["src/probe-[x].ts", ":(top)src/probe-[x].ts", ":(top,literal)src/probe-[x].ts", "src/probe-x.ts"]) {
  let out;
  try { out = g("ls-tree", "-r", "--name-only", "-z", "HEAD", "--", spec).split("\0").filter(Boolean); }
  catch (e) { out = `ERR ${e.message.slice(0, 60)}`; }
  console.log(JSON.stringify(spec), "=>", JSON.stringify(out));
}
console.log("version", g("version").trim());
rmSync(p, { recursive: true, force: true });
