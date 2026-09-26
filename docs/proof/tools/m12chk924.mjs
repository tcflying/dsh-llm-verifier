// Independently re-measure the primitives behind wave-12a's S2/S3/S9 before I file them as fact.
// Nothing here touches the repo; scratch lives under a prefix this script owns.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "m12chk-"));
const spacey = join(dir, "with space");
mkdirSync(spacey);
const bat = join(spacey, "echoargs.cmd");
const child = join(dir, "m12-child.mjs");
// The child path has to be the one this script actually wrote. It used to hard-code
// `%TEMP%/m12-child.mjs` while the file went to an mkdtemp directory — so both shell:true rows below
// measured "Cannot find module", not argument splitting, and printed a status that looked like a
// result. A probe whose subject is missing has to fail loudly, hence the assertion.
writeFileSync(bat, `@echo off\r\nnode "${child}" %*\r\n`);
writeFileSync(child, "console.log(JSON.stringify(process.argv.slice(2)));\n");
if (!existsSync(child)) throw new Error("child script missing: the shell rows would measure nothing");

console.log("=== A) shell:true + spaced paths (S2) ===");
const viaShell = spawnSync(bat, ["--cwd", "G:/no space/repo", "--timeout", "6m"], { shell: true, encoding: "utf8" });
console.log("  spaced bin   status=", viaShell.status, "argv seen by child:", (viaShell.stdout || "").trim(), "err:", (viaShell.stderr || "").trim().slice(0, 90));
const batNoSpace = join(dir, "echoargs.cmd");
writeFileSync(batNoSpace, `@echo off\r\nnode "${child}" %*\r\n`);
const viaShellSpacedCwd = spawnSync(batNoSpace, ["--cwd", join(spacey, "repo")], { shell: true, encoding: "utf8" });
console.log("  spaced arg   status=", viaShellSpacedCwd.status, "argv seen:", (viaShellSpacedCwd.stdout || "").trim(), "err:", (viaShellSpacedCwd.stderr || "").trim().slice(0, 90));
const quotedArg = spawnSync(batNoSpace, ["--cwd", `"${join(spacey, "repo")}"`], { shell: true, encoding: "utf8" });
console.log("  qWinArg form status=", quotedArg.status, "argv seen:", (quotedArg.stdout || "").trim());
const noShell = spawnSync(process.execPath, [child, "--cwd", join(spacey, "repo")], { encoding: "utf8" });
console.log("  control (no shell, exact argv) status=", noShell.status, "argv seen:", (noShell.stdout || "").trim());

console.log("=== B) killed spawnSync (S3) ===");
const hang = join(dir, "hang.mjs");
writeFileSync(hang, "process.stdout.write('partial-prefix-of-real-output\\n');\nsetTimeout(()=>{},30_000);\n");
const killed = spawnSync(process.execPath, [hang], { encoding: "utf8", timeout: 1000 });
console.log("  status=", JSON.stringify(killed.status), "signal=", killed.signal,
  "stdout=", JSON.stringify(killed.stdout), "error=", killed.error?.code);
console.log("  => a guard that only asks 'is stdout empty?' reads this as:",
  killed.stdout && killed.stdout.trim().length === 0 ? "CLEAN (fail-open)" : "output present");
const truncated = spawnSync(process.execPath, ["-e", "for(let i=0;i<200000;i++)console.log('x'.repeat(60))"], { encoding: "utf8", maxBuffer: 1024 * 1024 });
console.log("  overran maxBuffer: status=", JSON.stringify(truncated.status), "error=", truncated.error?.code,
  "stdout bytes kept=", (truncated.stdout || "").length, "(=1 MiB ⇒ prefix, not full list)");

console.log("=== C) negative timeout (S9) ===");
for (const t of [-1000, 0, 1500.5, 500]) {
  let r;
  try { r = `returned status=${spawnSync(process.execPath, ["-e", "0"], { timeout: t }).status}`; }
  catch (e) { r = `THREW ${e.code || ""} ${e.message.slice(0, 60)}`; }
  console.log(`  timeout=${String(t)}  ->  ${r}`);
}
console.log(`  Number("-1") || 10*60000 = ${Number("-1") || 600000}  (|| only rescues NaN/0/"" )`);

rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
console.log("scratch really gone:", !existsSync(dir));
