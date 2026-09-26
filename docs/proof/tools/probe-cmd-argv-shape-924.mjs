// 924: what survives cmd.exe when the payload never appears on the command line?
// Env-var channel + quoted reference, then compare what the grandchild's argv actually holds.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "cmdesc-924-"));
const recv = join(dir, "recv.mjs");
writeFileSync(recv, "console.log(JSON.stringify(process.argv.slice(2)));\n");
const shim = join(dir, "run.cmd");
writeFileSync(shim, `@echo off\r\nnode "${recv.replace(/\\/g, "\\\\")}" %*\r\n`);

const PAYLOADS = {
  quotes: 'fix the error "cannot find x" ok',
  amp: 'a" & echo PWNED & "b',
  pct: 'key=%DSH_SECRET% and 100% done',
  pipes: 'x | y > z < w ^q',
  multiline: "line1\nline2",
};

// enc: how we place the reference into the cmd command line
const ENCS = {
  // current TS behaviour: Node builds argv, escapes " as \", cmd re-parses everything
  current: (v) => ({ mode: "argv", value: v }),
  // payload via env, referenced inside one quoted region, " doubled for cmd+CRT
  envDoubled: (v) => ({ mode: "env", value: `"${v.replace(/"/g, '""')}"` }),
  // payload via env, referenced inside one quoted region, " left alone
  envRaw: (v) => ({ mode: "env", value: `"${v}"` }),
};

function run(name, payload) {
  for (const [encName, enc] of Object.entries(ENCS)) {
    const spec = enc(payload);
    const env = { ...process.env, DSH_SECRET: "sk-cp-LEAK", DSH_TASK: payload };
    const r = spec.mode === "argv"
      ? spawnSync(shim, [payload], { encoding: "utf8", env })
      : spawnSync("cmd.exe", ["/d", "/s", "/c", `"${shim}" ${spec.value.replace(/%DSH_TASK%/g, "")}`.replace("  ", " ")], {
        encoding: "utf8", env, windowsVerbatimArguments: true, shell: false,
      });
    // The env form: command line must reference %DSH_TASK%, never the payload itself.
    const out = ((r.stdout || "") + (r.stderr || "")).split(/\r?\n/).filter(Boolean);
    const argv = out.find((l) => l.startsWith("["));
    let got;
    try { got = JSON.parse(argv ?? "[]"); } catch { got = `<unparsed:${argv}>`; }
    const one = Array.isArray(got) ? got.join("\n") : String(got);
    console.log(`${name.padEnd(10)} ${encName.padEnd(11)} ok=${r.status === 0} verbatim=${one === payload} pwned=${out.some((l) => /PWNED/.test(l) && !l.startsWith("["))} leak=${out.some((l) => l.includes("sk-cp-LEAK"))}`);
    if (one !== payload) console.log(`             got=${JSON.stringify(one).slice(0, 110)}`);
  }
}
for (const [name, payload] of Object.entries(PAYLOADS)) run(name, payload);

// The env-reference form: user text never appears on the command line, but cmd
// expands %DSH_TASK% and then tokenizes the RESULT. Does a metachar survive?
console.log("\n--- %DSH_TASK% reference form ---");
for (const [name, payload] of Object.entries(PAYLOADS)) {
  for (const [form, cmdLine] of [
    ["quoted", `"${shim}" "%DSH_TASK%"`],
    ["bare", `"${shim}" %DSH_TASK%`],
  ]) {
    const r = spawnSync("cmd.exe", ["/d", "/s", "/c", cmdLine], {
      encoding: "utf8", env: { ...process.env, DSH_SECRET: "sk-cp-LEAK", DSH_TASK: payload }, windowsVerbatimArguments: true,
    });
    const out = ((r.stdout || "") + (r.stderr || "")).split(/\r?\n/).filter(Boolean);
    let got;
    try { got = JSON.parse(out.find((l) => l.startsWith("[")) ?? "[]"); } catch { got = out; }
    const one = Array.isArray(got) ? got.join("\n") : String(got);
    console.log(`${name.padEnd(10)} ${form.padEnd(7)} exit=${r.status} verbatim=${one === payload} pwned=${out.some((l) => /^PWNED/.test(l))} leak=${out.some((l) => l.includes("sk-cp-LEAK"))}${one === payload ? "" : ` got=${JSON.stringify(one).slice(0, 100)}`}`);
  }
}
