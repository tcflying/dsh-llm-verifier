// Stand-in for `mcode exec` so the deployed engine's whole run->apply->rollback cycle can be
// driven without billing a model. Contract read off mcp-server.mjs execMcode():
// argv: exec --cwd <dir> --permission off --timeout Nm --output-format json --input - [--model X]
// stdin: the candidate prompt. Must do real work in --cwd and print one line containing "exec.result".
const fs = require("node:fs");
const path = require("node:path");

const a = process.argv.slice(2);
const opt = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : ""; };
const cwd = opt("--cwd") || process.cwd();
let prompt = "";
try { prompt = fs.readFileSync(0, "utf8"); } catch { /* no stdin is still a valid stub run */ }

const marker = process.env.MCODE_STUB_TOKEN || "deployed-stub-run";
const file = process.env.MCODE_STUB_FILE || "solution.txt";
fs.writeFileSync(path.join(cwd, file), `${marker}\n`);
if (process.env.MCODE_STUB_HITLOG) {
  fs.appendFileSync(process.env.MCODE_STUB_HITLOG,
    `${JSON.stringify({ cwd, model: opt("--model"), promptBytes: Buffer.byteLength(prompt) })}\n`);
}
console.log(JSON.stringify({
  type: "exec.result",
  status: "succeeded",
  sessionId: `stub_${Math.random().toString(36).slice(2, 14)}`,
  output: `stub wrote ${file} in ${cwd}`,
  usage: { input_tokens: 1, output_tokens: 1 },
}));
