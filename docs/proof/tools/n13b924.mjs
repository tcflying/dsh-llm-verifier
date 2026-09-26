// Adversarial check of wave 11c's numstat parser (N13): the refuse path must be REACHABLE,
// because a guard nobody can trigger is decoration. Runs against the BUILT artifact.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const Z = String.fromCharCode(0), T = String.fromCharCode(9);
const { readNumstatRecords } = await import("file:///G:/zcode-project/llm-verify/dsh-llm-verifier/lib/git.js");
const g = (cwd, ...a) => spawnSync("git", a, { cwd, encoding: "utf8" });
let failures = 0;
// `want !== "throws"` used to mean "PASS as long as nothing threw", so all three parse cases were blind to
// the value they were named after: a `binaryPaths` that regressed to empty still printed PASS. `onValue`
// makes the parsed shape an assertion, and `shape` expands the Set — JSON.stringify(a Set) is `{}`, which
// is why the printed evidence hid the one field the case name promises to check.
const expect = (name, want, fn, onValue) => {
  let threw = false, value;
  try { value = fn(); } catch (e) { threw = true; value = e.message; }
  let pass = want === "throws" ? threw : !threw;
  if (pass && want !== "throws" && onValue) {
    try { onValue(value); } catch (e) { pass = false; value = e.message; }
  }
  if (!pass) failures += 1;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}  -  ${typeof value === "string" ? value.slice(0, 140) : JSON.stringify(value).slice(0, 140)}`);
};
const shape = (r) => ({ files: [...r.changedFiles], binary: [...r.binaryPaths] });
const wantShape = (files, binary) => (v) => {
  const key = (o) => `${[...o.files].sort().join(",")} | ${[...o.binary].sort().join(",")}`;
  if (key(v) !== key({ files, binary })) throw new Error(`got "${key(v)}", want "${key({ files, binary })}"`);
};
const rec = (a, d, p) => a + T + d + T + p + Z;
expect("normal record parses", "value", () => shape(readNumstatRecords(rec("1", "2", "solution.txt"))), wantShape(["solution.txt"], []));
expect("binary + delete parse", "value", () => shape(readNumstatRecords(rec("-", "-", "logo.bin") + rec("3", "0", "gone.txt"))), wantShape(["logo.bin", "gone.txt"], ["logo.bin"]));
expect("trailing separator only", "value", () => shape(readNumstatRecords(Z)), wantShape([], []));
expect("rename record refused", "throws", () => readNumstatRecords("1" + T + "2" + T + Z + "old.txt" + Z + "new.txt" + Z));
expect("tab inside a path refused", "throws", () => readNumstatRecords("1" + T + "2" + T + "a" + T + "b.txt" + Z));
expect("empty path field refused", "throws", () => readNumstatRecords("1" + T + "2" + T + Z + "keep.txt" + Z));
const d = mkdtempSync(join(tmpdir(), "n13b924-"));
g(d, "init", "-q", "."); g(d, "config", "user.email", "a@a.invalid"); g(d, "config", "user.name", "a");
writeFileSync(join(d, "victim.txt"), "x\n"); writeFileSync(join(d, "keep.txt"), "y\n");
g(d, "add", "-A"); g(d, "commit", "-qm", "base");
g(d, "mv", "victim.txt", "renamed.txt"); writeFileSync(join(d, "keep.txt"), "z\n"); g(d, "add", "-A");
const withR = g(d, "diff", "--numstat", "--no-textconv", "-z", "HEAD", "--").stdout;
const prod = g(d, "diff", "--numstat", "--no-renames", "--no-textconv", "-z", "HEAD", "--").stdout;
expect("real git WITH rename detection -> refused (guard reachable)", "throws", () => readNumstatRecords(withR));
expect("real git production shape -> parsed, 3 paths", "value", () => {
  const r = readNumstatRecords(prod);
  const names = r.changedFiles.slice().sort().join(",");
  if (names !== "keep.txt,renamed.txt,victim.txt") throw new Error("unexpected set: " + names);
  return { count: r.changedFiles.length, binary: [...r.binaryPaths] };
});
rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
console.log("scratch gone:", !existsSync(d));
console.log(failures === 0 ? "N13 PARSER CHECK OK" : "N13 PARSER CHECK FAILURES: " + failures);
process.exit(failures === 0 ? 0 : 1);
