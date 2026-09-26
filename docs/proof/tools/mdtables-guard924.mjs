// 924: prove `mdtables924.mjs` can go red, in the two shapes its original rule was blind to.
// A structural check that has only ever printed `inconsistent=0` certifies nothing about itself: the
// ledger damage this tool exists to catch was found *because* of a red run, and the two shapes below
// (a row whose closing pipe is missing, a headerless block created by inserting rows before a heading)
// both passed the old rule while the rows were visibly broken. So each mutant must exit 1 with its own
// message and the untouched ledger must still exit 0.
// Usage: node docs/proof/tools/mdtables-guard924.mjs
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const CHECKER = `${repo}docs/proof/tools/mdtables924.mjs`;
const LEDGER = `${repo}924.md`;
const src = readFileSync(LEDGER, "utf8").split("\n");

const run = (lines, tag) => {
  const f = `${tmpdir()}/mdtables-guard924-${tag}.md`;
  try {
    writeFileSync(f, lines.join("\n"));
    const r = spawnSync(process.execPath, [CHECKER, f], { encoding: "utf8" });
    return { rc: r.status, out: `${r.stdout}${r.stderr}` };
  } finally {
    rmSync(f, { force: true });
  }
};

// Anchors are DERIVED, never quoted from the ledger's prose. This guard died in the 2026-09-26 03:47
// rehearsal because all three mutants pointed at hand-written residual-table rows by their leading text
// ("| 同步工具留下的 6 份" and co.), and I had just re-worded one of those rows while correcting its
// attribution — so the probe that exists to prove the checker can go red went red for a reason unrelated
// to the checker. A proof that breaks whenever the proved-against document is edited is not a proof.
// What a mutant actually needs is a structural position: a data row whose line above is also a data row
// (so blank-inserting it yields a 1-row block with no `|---|`, not a still-valid header+separator block).
const isRow = (l) => typeof l === "string" && l.startsWith("| ") && l.endsWith(" |");
const isSep = (l) => /^\|[\s:|-]+\|$/.test(String(l).trim());
const candidates = src.map((l, i) => (i > 0 && isRow(l) && isRow(src[i - 1]) && !isSep(l) && !isSep(src[i - 1]) ? i : -1)).filter((i) => i > 0);
if (candidates.length < 3) throw new Error(`need >=3 adjacent data-row pairs to mutate, found ${candidates.length}: the ledger's table shape changed`);
const pick = (n, what) => {
  const i = candidates[n];
  console.log(`  anchor for ${what}: line ${i + 1} ${JSON.stringify(src[i].slice(0, 48))}...`);
  return i;
};

const results = [];
const caseOf = (name, lines, expect) => {
  const r = run(lines, name);
  const ok = r.rc === 1 && r.out.includes(expect);
  results.push(`${ok ? "OK  " : "FAIL"} ${name}: rc=${r.rc} ${ok ? `(named: ${expect})` : `wanted rc=1 + ${JSON.stringify(expect)}, got: ${r.out.trim().split("\n").slice(0, 2).join(" | ")}`}`);
};

// control: the ledger as it stands must be green, or the two mutants prove nothing about the checker.
const control = run(src, "control");
results.push(`${control.rc === 0 ? "OK  " : "FAIL"} control (unmutated ledger): rc=${control.rc} ${control.out.trim().split("\n")[0]}`);

// M1: drop the closing pipe off a data row — the exact defect a hand Edit made in wave 25.
const i1 = pick(0, "missing-closing-pipe");
const m1 = src.map((l, i) => (i === i1 ? l.replace(/\s*\|\s*$/, "") : l));
if (m1[i1] === src[i1]) throw new Error("M1 is a no-op: the anchor row has no closing pipe to strip");
caseOf("no-closing-pipe", m1, "missing its closing pipe");

// M2: pull a blank line in front of a row — an Edit aimed at a section heading rather than the table
// leaves the row as a 1-row headerless block, which the cell-count rule passes vacuously.
const i2 = pick(1, "headerless-block");
const m2 = [...src.slice(0, i2), "", ...src.slice(i2)];
if (m2[i2 + 1] !== src[i2]) throw new Error("M2 is a no-op: the blank line did not land in front of the row");
caseOf("headerless-block", m2, "no |---| separator");

// M3: keep the original rule honest too — glue a stray tail onto one row so the block disagrees.
const i3 = pick(2, "cell-count");
const m3 = src.map((l, i) => (i === i3 ? `${l}| 我自己粘回来的旧尾巴 |` : l));
if (m3[i3] === src[i3]) throw new Error("M3 is a no-op: the tail was not appended");
caseOf("cell-count", m3, "cells ");

for (const l of results) console.log(l);
const bad = results.filter((l) => l.startsWith("FAIL")).length;
console.log(bad ? `GUARD RED: ${bad} case(s) did not behave` : "GUARD GREEN: the ledger checker is load-bearing in all three shapes");
process.exit(bad ? 1 : 0);
