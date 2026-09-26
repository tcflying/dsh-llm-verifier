// 924 deployment sync: repo -> every installed copy, then re-verify. DEFAULT IS READ-ONLY: a bare run
// reports drift and writes nothing, because checking drift is the reflex move and it must not deploy. One source of truth = the
// table in 924.md "部署副本普查". Verdict before cleanup, exit code reflects the FILES, not the pipe.
import fs from "node:fs";
import crypto from "node:crypto";
const REPO = "G:/zcode-project/llm-verify/dsh-llm-verifier/minimax-code-plugin/";
const ENG = REPO + ".minimax-plugin/mcp-server.mjs";
const SKILL = REPO + ".minimax-plugin/skills/llm-verifier/SKILL.md";
const TARGETS = [
  [ENG, "C:/Users/datoo/.zcode/skills/llm-verifier/mcp-server.mjs"],
  [ENG, "C:/Users/datoo/.minimax/plugins/llm-verifier/.minimax-plugin/mcp-server.mjs"],
  [SKILL, "C:/Users/datoo/.zcode/skills/llm-verifier/SKILL.md"],
  [SKILL, "C:/Users/datoo/.minimax/plugins/llm-verifier/.minimax-plugin/skills/llm-verifier/SKILL.md"],
  [SKILL, "C:/Users/datoo/.minimax/plugins/llm-verifier/skills/llm-verifier/SKILL.md"],
  [SKILL, "C:/Users/datoo/.minimax/skills/llm-verifier/SKILL.md"],
  [SKILL, "C:/Users/datoo/.qoder-cn/skills/llm-verifier/SKILL.md"],
  [SKILL, "C:/Users/datoo/.jcode/skills/llm-verifier/SKILL.md"],
];
const normHash = (p) => { try { return crypto.createHash("sha256").update(fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n")).digest("hex").slice(0, 12); } catch { return "MISSING"; } };
let bad = 0;
const dryRun = !process.argv.includes("--write");
console.log(dryRun ? "DRY RUN (no writes; pass --write to deploy)" : "SYNCING");
for (const [src, dst] of TARGETS) {
  const want = normHash(src);
  const before = normHash(dst);
  let wrote = "n/a";
  if (!dryRun && before !== want) {
    try {
      fs.mkdirSync(dst.slice(0, dst.lastIndexOf("/")), { recursive: true });
      fs.copyFileSync(src, dst);
      // `copyFile` carries the SOURCE mtime over, so a file deployed right now would report itself as
      // written hours ago. That is not cosmetic: `fill-table-924.mjs` reads "installed mtime older than
      // GATE_START" as "this run moved no bytes" and prints it as the reason its strongest form of the
      // deployment claim is read-only. Stamp the copy so the filesystem tells the truth.
      fs.utimesSync(dst, new Date(), new Date());
      wrote = "copied";
    } catch (e) { wrote = "WRITE FAILED " + e.code; }
  }
  const after = dryRun ? before : normHash(dst);
  const ok = after === want;
  if (!ok) bad += 1;
  console.log(`${ok ? "MATCH" : "DRIFT"}  ${dst.replace("C:/Users/datoo/", "~/").padEnd(64)} want=${want} was=${before} after=${after} ${wrote}`);
}
console.log(bad === 0 ? "\nDEPLOYMENT IN SYNC" : `\nDEPLOYMENT DRIFT: ${bad}`);
process.exit(bad === 0 ? 0 : 1);
