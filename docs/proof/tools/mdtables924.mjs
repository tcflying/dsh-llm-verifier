// 924: structural check for the hand-edited markdown ledger. Every table block (a run of `| … |` lines)
// must declare the same number of cells, counting only UNESCAPED pipes — `\|` inside a cell is literal
// text and is stripped before counting. A backticked `|` is NOT protected: markdown tables split cells
// before code spans are parsed, so `| `a \|\| b` |` must be escaped too. A mismatch is almost always my
// own Edit that replaced part of a row and left the old tail dangling, which renders as a silently
// mis-aligned row, not an error.
// Usage: node docs/proof/tools/mdtables924.mjs [file.md]
import { readFileSync } from "node:fs";

const file = process.argv[2] || "924.md";
const lines = readFileSync(file, "utf8").split(/\r?\n/);
const cells = (t) => t.replace(/\\\|/g, "").split("|").length - 1;

let block = [];
const bad = [];
let blocks = 0;
const flush = () => {
  if (!block.length) return;
  blocks += 1;
  const counts = block.map(([n, c]) => c);
  const uniq = [...new Set(counts)];
  if (uniq.length > 1) bad.push(`line ${block[0][0]}: cells ${counts.join(",")}`);
  // A markdown table needs a header row AND a `|---|` separator. Without them the "table" renders as a
  // paragraph of pipe characters. Measured: rows appended with a blank line between them (an Edit that
  // inserted before a section heading rather than into the table) each became a headerless 1-row block,
  // and the old cell-count rule passed every one of them — three such blocks sat in the residual list
  // unnoticed, and four more predated this wave.
  if (!/^\|[\s:|-]+\|$/.test(block.length > 1 ? lines[block[1][0] - 1].trim() : "")) {
    bad.push(`line ${block[0][0]}: block of ${block.length} row(s) has no |---| separator (renders as text)`);
  }
  block = [];
};
lines.forEach((l, i) => {
  const t = l.trim();
  // A row that starts with `|` but does not close it is a typo'd row, not prose. The previous rule
  // required endsWith("|") and simply skipped such lines, so a missing final pipe deleted the row from
  // every count this tool makes — measured on my own newly added residual row.
  if (t.startsWith("|") && t.length > 2 && !t.endsWith("|")) {
    bad.push(`line ${i + 1}: row is missing its closing pipe (silently skipped before; excluded from blocks here)`);
  }
  if (t.startsWith("|") && t.endsWith("|") && t.length > 2) block.push([i + 1, cells(t)]);
  else flush();
});
flush();

console.log(`${file}: table_blocks=${blocks} inconsistent=${bad.length}`);
for (const b of bad) console.log(`  BAD ${b}`);
// Zero tables is not "all tables fine": a ledger emptied by a bad Edit, or a filename typo that resolves
// to a prose file, would otherwise green this stage forever.
process.exit(bad.length || !blocks ? 1 : 0);
