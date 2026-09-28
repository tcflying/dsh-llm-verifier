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
  // OpenCode runs the same engine from its own skills dir; it sat OUTSIDE this list from 922 until
  // 2026-09-28 and silently kept serving a two-weeks-stale engine missing all of waves-924's
  // security fixes. Missing from TARGETS = missing from every drift check, by construction.
  [ENG, "C:/Users/datoo/.config/opencode/skills/llm-verifier/mcp-server.mjs"],
  [SKILL, "C:/Users/datoo/.zcode/skills/llm-verifier/SKILL.md"],
  [SKILL, "C:/Users/datoo/.minimax/plugins/llm-verifier/.minimax-plugin/skills/llm-verifier/SKILL.md"],
  [SKILL, "C:/Users/datoo/.minimax/plugins/llm-verifier/skills/llm-verifier/SKILL.md"],
  [SKILL, "C:/Users/datoo/.minimax/skills/llm-verifier/SKILL.md"],
  [SKILL, "C:/Users/datoo/.qoder-cn/skills/llm-verifier/SKILL.md"],
  [SKILL, "C:/Users/datoo/.jcode/skills/llm-verifier/SKILL.md"],
  [SKILL, "C:/Users/datoo/.config/opencode/skills/llm-verifier/SKILL.md"],
];
// A read failure must never compare equal to itself. The old "MISSING" sentinel made
// missing-file === missing-file read as MATCH (928 P1-2): a wiped install directory was the one
// state most needing an alarm and the one state this tool blessed. null is not a hash.
const normHash = (p) => { try { return crypto.createHash("sha256").update(fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n")).digest("hex").slice(0, 12); } catch { return null; } };
// Registration is part of deployment: an engine at the right bytes behind a disabled entry is not
// deployed. Each host below is checked for an entry that is present and not explicitly disabled;
// MiniMax additionally requires configured:true (its loader hard-gates on it). Missing file/entry
// is a failure, not a skip — there is no state of this list where "cannot tell" should exit 0.
const HOST_REGISTRATIONS = [
  { label: "codex",   file: "C:/Users/datoo/.codex/config.toml",          want: (t) => {
    // Line scan, not one regex: the llm-verifier block is followed by an `.env` sub-block whose
    // own keys would blur into the segment under any single-pattern match.
    let inSeg = false;
    for (const l of t.split(/\r?\n/)) {
      if (/^\[/.test(l)) { inSeg = l.trim() === "[mcp_servers.llm-verifier]"; continue; }
      // Skip comment lines before the key test: a `# enabled = true` annotation inside the
      // segment must not satisfy a check whose point is the live value (P7 review, 2026-09-28).
      if (l.trimStart().startsWith("#")) continue;
      if (inSeg && /^enabled\s*=/.test(l)) return /\btrue\b/.test(l);
    }
    return false;
  } },
  { label: "zcode",   file: "C:/Users/datoo/.zcode/cli/config.json",      want: (d) => d?.mcp?.servers?.["llm-verifier"]?.enabled === true },
  { label: "jcode",   file: "C:/Users/datoo/.jcode/mcp.json",             want: (d) => d?.servers?.["llm-verifier"]?.enabled !== false },
  { label: "minimax", file: "C:/Users/datoo/.minimax/mcp/mcp.json",       want: (d) => d?.mcpServers?.["llm-verifier"]?.configured === true && d?.mcpServers?.["llm-verifier"]?.enabled !== false },
  { label: "opencode",file: "C:/Users/datoo/.config/opencode/opencode.json", want: (d) => d?.mcp?.["llm-verifier"]?.enabled === true },
];
if (TARGETS.length === 0) { console.error("DEPLOYMENT CHECK BROKEN: TARGETS is empty — nothing would be verified"); process.exit(2); }
let bad = 0;
const dryRun = !process.argv.includes("--write");
console.log(dryRun ? "DRY RUN (no writes; pass --write to deploy)" : "SYNCING");
for (const [src, dst] of TARGETS) {
  const want = normHash(src);
  if (want === null) { bad += 1; console.log(`DRIFT  SOURCE UNREADABLE for ${dst} (repo file missing?)`); continue; }
  const before = normHash(dst);
  if (before === null) { bad += 1; console.log(`DRIFT  ${dst.replace("C:/Users/datoo/", "~/")} DEST UNREADABLE (not deployed / deleted)`); continue; }
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
for (const h of HOST_REGISTRATIONS) {
  let ok = false, why = "";
  try {
    const text = fs.readFileSync(h.file, "utf8");
    ok = h.file.endsWith(".toml") ? h.want(text) : h.want(JSON.parse(text));
    why = ok ? "" : "entry missing/disabled";
  } catch (e) { why = "unreadable: " + e.code; }
  if (!ok) bad += 1;
  console.log(`${ok ? "MATCH" : "DRIFT"}  registration ${h.label.padEnd(9)} ${h.file.replace("C:/Users/datoo/", "~/")}${why ? "  -> " + why : ""}`);
}
console.log(bad === 0 ? "\nDEPLOYMENT IN SYNC" : `\nDEPLOYMENT DRIFT: ${bad}`);
process.exit(bad === 0 ? 0 : 1);
