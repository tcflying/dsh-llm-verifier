// 924 / wave-12b F1 self-verification: does runProcess hand the candidate task text to cmd.exe unescaped?
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const LIB = "G:/zcode-project/llm-verify/dsh-llm-verifier/lib/process.js";
const dir = mkdtempSync(join(tmpdir(), "v12b-924-"));
const shim = join(dir, "probe.cmd");
// Prints exactly what cmd.exe hands it, so a breakout is visible as an extra line.
writeFileSync(shim, "@echo GOT=[%*]\r\n");
const { runProcess } = await import(pathToFileURL(LIB).href);
const AbortSignal = AbortController;

async function attempt(args) {
  const ac = new AbortController();
  const r = await runProcess({
    executable: shim,
    arguments: args,
    cwd: dir,
    env: { ...process.env, V12B_SECRET: "sk-cp-LEAKED" },
    signal: ac.signal,
    timeoutMs: 10_000,
  });
  return r.stdout;
}

const cases = [
  ["control", ["Create result.txt"]],
  ["quote-breakout", ['x" & echo PWNED & "y']],
  ["env-expansion", ["key=%V12B_SECRET%"]],
];
for (const [name, args] of cases) {
  const out = await attempt(args);
  console.log(`${name.padEnd(16)} PWNED=${/^\s*PWNED\s*$/mu.test(out)} leaked=${out.includes("sk-cp-LEAKED")}`);
  console.log(`   ${out.split(/\r?\n/).filter(Boolean).join(" ⏎ ")}`);
}

// F4 separately: spaced executable path (the "C:\Program Files" case).
const spaced = mkdtempSync(join(tmpdir(), "v12b dir-924-"));
const shim2 = join(spaced, "probe.cmd");
writeFileSync(shim2, "@echo SPACED-OK\r\n");
const out2 = await (async () => {
  const ac = new AbortController();
  const r = await runProcess({ executable: shim2, arguments: ["x"], cwd: dir, env: process.env, signal: ac.signal, timeoutMs: 10_000 });
  return `exit=${r.exitCode} out=${JSON.stringify(r.stdout)}`;
})().catch((e) => `threw=${e.message.slice(0, 90)}`);
console.log(`spaced-path  ${out2}`);
rmSync(dir, { recursive: true, force: true });
rmSync(spaced, { recursive: true, force: true });
void spawnSync;
