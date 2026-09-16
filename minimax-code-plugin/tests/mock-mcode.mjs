import fs from "node:fs"; import path from "node:path";
const a = process.argv.slice(2);
const cwd = a[a.indexOf("--cwd") + 1];
const id = path.basename(cwd) || "cand";
process.stdin.resume();
let stdin = "";
process.stdin.on("data", (d) => (stdin += d));
process.stdin.on("end", () => {
  fs.writeFileSync(path.join(cwd, "solution.txt"), "fixed by " + id + " (prompt " + stdin.length + " chars)\n");
  const out = { schemaVersion: 1, type: "exec.result", status: "succeeded", output: "done",
    sessionId: "mock-" + id, usage: { inputTokens: 100 + stdin.length, outputTokens: 10 } };
  process.stdout.write(JSON.stringify(out) + "\n");
});
