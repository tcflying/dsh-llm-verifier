// Deployment census: every installed copy vs its repo source, compared after newline normalisation
// (a CRLF-only difference is not drift). Also lists repo files that have no installed copy at all.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
const REPO = "G:/zcode-project/llm-verify/dsh-llm-verifier/minimax-code-plugin/";
const normHash = (p) => { try { return crypto.createHash("sha256").update(fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n")).digest("hex").slice(0, 12); } catch { return "MISSING"; } };
const repoTree = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "tests") continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else repoTree.push(p.slice(REPO.length).replaceAll("\\", "/"));
  }
})(REPO);
console.log("REPO plugin tree (" + repoTree.length + " files):");
for (const f of repoTree.sort()) console.log("   " + normHash(REPO + f).padEnd(14) + f);

const TARGETS = [
  ["C:/Users/datoo/.zcode/skills/llm-verifier/mcp-server.mjs", ".minimax-plugin/mcp-server.mjs"],
  ["C:/Users/datoo/.zcode/skills/llm-verifier/SKILL.md", ".minimax-plugin/skills/llm-verifier/SKILL.md"],
  ["C:/Users/datoo/.minimax/plugins/llm-verifier/.minimax-plugin/mcp-server.mjs", ".minimax-plugin/mcp-server.mjs"],
  ["C:/Users/datoo/.minimax/plugins/llm-verifier/.minimax-plugin/skills/llm-verifier/SKILL.md", ".minimax-plugin/skills/llm-verifier/SKILL.md"],
  ["C:/Users/datoo/.minimax/plugins/llm-verifier/skills/llm-verifier/SKILL.md", ".minimax-plugin/skills/llm-verifier/SKILL.md"],
  ["C:/Users/datoo/.minimax/skills/llm-verifier/SKILL.md", ".minimax-plugin/skills/llm-verifier/SKILL.md"],
  ["C:/Users/datoo/.qoder-cn/skills/llm-verifier/SKILL.md", ".minimax-plugin/skills/llm-verifier/SKILL.md"],
  ["C:/Users/datoo/.jcode/skills/llm-verifier/SKILL.md", ".minimax-plugin/skills/llm-verifier/SKILL.md"],
  ["C:/Users/datoo/.minimax/plugins/llm-verifier/plugin.json", "plugin.json"],
  ["C:/Users/datoo/.minimax/plugins/llm-verifier/.minimax-plugin/plugin.json", ".minimax-plugin/plugin.json"],
  ["C:/Users/datoo/.minimax/plugins/llm-verifier/.claude-plugin/plugin.json", ".claude-plugin/plugin.json"],
];
console.log("\nINSTALLED COPIES:");
for (const [dst, srcRel] of TARGETS) {
  const a = normHash(dst), b = normHash(REPO + srcRel);
  const verdict = a === "MISSING" ? "NOT INSTALLED" : a === b ? "in sync    " : "DRIFT      ";
  console.log("   " + verdict + dst.replace("C:/Users/datoo/", "~/").padEnd(62) + "dst=" + a + " src(" + srcRel + ")=" + b);
}
console.log("\nrepo-side hashes of the two moving files: engine=" + normHash(REPO + ".minimax-plugin/mcp-server.mjs") + " skill=" + normHash(REPO + ".minimax-plugin/skills/llm-verifier/SKILL.md"));
