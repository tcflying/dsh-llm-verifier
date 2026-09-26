import { readNumstatRecords } from "file:///G:/zcode-project/llm-verify/dsh-llm-verifier/lib/git.js";
const Z = String.fromCharCode(0), T = String.fromCharCode(9);
const r = readNumstatRecords(["-", "-", "logo.bin"].join(T) + Z + ["1", "2", "a.txt"].join(T) + Z);
const isSet = r.binaryPaths instanceof Set;
const ok = isSet && r.binaryPaths.size === 1 && r.binaryPaths.has("logo.bin") && !r.binaryPaths.has("a.txt") && r.changedFiles.length === 2;
console.log("binaryPaths is Set:", isSet, "| size:", r.binaryPaths.size, "| has logo.bin:", r.binaryPaths.has("logo.bin"), "| has a.txt:", r.binaryPaths.has("a.txt"));
console.log("changedFiles:", JSON.stringify(r.changedFiles));
console.log(ok ? "BINARY SET CHECK OK - the -/- branch does real work" : "BINARY SET CHECK FAIL");
process.exit(ok ? 0 : 1);
