// 924: F1 with the EXACT production argv shape (core.ts:622 -> ["--profile", profile, taskPrompt]),
// the multi-line isolation contract included. Tells apart "cmd mangled the task" from "model did nothing".
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const REPO = "G:/zcode-project/llm-verify/dsh-llm-verifier";
const { runProcess } = await import(pathToFileURL(`${REPO}/lib/process.js`).href);
const dir = mkdtempSync(join(tmpdir(), "f1argv-"));
const recv = join(dir, "recv.cjs");
// Records what the grandchild's argv actually holds, one JSON string per element.
writeFileSync(recv, "require('fs').writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3), null, 1));\nconsole.log('ARGV-COUNT=' + (process.argv.length - 3));\n");
const shim = join(dir, "dsh.cmd");
writeFileSync(shim, `@echo off\r\nnode "${recv}" "${join(dir, "out.json")}" %*\r\n@echo SHIM-DONE\r\n`);

// taskPrompt exactly as core.ts:611-619 builds it, with the quote-injection in the task part.
const SENT = "b7d3f0.txt";
const task = `Create result.txt containing OK" & echo BREAKOUT > "${SENT}" & "`;
const taskPrompt = [
  task,
  "",
  "ISOLATION CONTRACT (mandatory, overrides any conflicting instruction above):",
  "- Your current working directory IS the isolated Git worktree for this task.",
  "- Touch only files under your current working directory. Never cd elsewhere and never write outside it.",
  "- Absolute paths in the task above that point outside the current working directory refer to the matching file inside this worktree; use the relative path instead.",
  "- Do not commit or push. Finish with a concise summary.",
].join("\n");

const ac = new AbortController();
const r = await runProcess({
  executable: join(dir, "dsh.cmd"),
  arguments: ["--profile", "verifier-e2e", taskPrompt],
  cwd: dir,
  env: { ...process.env, F1_SECRET: "sk-cp-LEAKED" },
  signal: ac.signal,
  timeoutMs: 20_000,
});
const out = (r.stdout || "") + (r.stderr || "");
let argv = null;
try { argv = JSON.parse(readFileSync(join(dir, "out.json"), "utf8")); } catch { argv = "(recv never wrote)"; }
console.log(`exit=${r.exitCode} shimRan=${out.includes("SHIM-DONE")} breakout=${/^\s*BREAKOUT\s*$/m.test(out)} secretOnChildLine=${out.includes("sk-cp-LEAKED")} sentinelFileCreated=${require0()}`);
function require0() { try { readFileSync(join(dir, SENT)); return true; } catch { return false; } }
console.log(`\nargv the harness received (${Array.isArray(argv) ? argv.length : "?"} elements):`);
if (Array.isArray(argv)) for (const [i, a] of argv.entries()) console.log(`  [${i}] ${JSON.stringify(a.slice(0, 160))}`);
console.log(`\nverbatim-round-trip of the prompt element: ${Array.isArray(argv) ? argv[argv.length - 1] === taskPrompt : "n/a"}`);
console.log(`stdout:\n${out.split(/\r?\n/).filter(Boolean).slice(0, 8).join("\n")}`);
rmSync(dir, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 });
void spawnSync;
