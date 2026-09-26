// 924: mcp.json must stay valid against the schema it declares — with exactly one named exception.
// No deps: the stdio branch of agent-plugins 1.0.0 is small enough to check directly from the schema file.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1"));
const REPO = "G:/zcode-project/llm-verify/dsh-llm-verifier";
const PLUGIN_MCP = `${REPO}/minimax-code-plugin/.minimax-plugin/mcp.json`;
const INSTALLED = [
  "C:/Users/datoo/.minimax/plugins/llm-verifier/.minimax-plugin/mcp.json",
  "C:/Users/datoo/.minimax/plugins/llm-verifier/mcp.json",
];
// Vendored copy of https://agent-plugins.org/schemas/1.0.0/mcp.schema.json (fetched 2026-09-25).
const schema = JSON.parse(fs.readFileSync(path.join(HERE, "mcp.schema.json"), "utf8"));
const stdio = schema.$defs.stdioServer;
const ALLOWED = Object.keys(stdio.properties);
if (stdio.additionalProperties !== false) throw new Error("schema shape changed: stdioServer no longer closes extra keys");
// `timeout` is NOT in the schema. It is present on every plugin config installed on this box, including
// ones demonstrably loaded by their host, so the hosts tolerate (and probably honour) it; our runs last up
// to 45 minutes, so dropping a kill-window knob on spec grounds alone would trade a nit for an outage.
const HOST_EXTENSIONS = ["timeout"];
const failures = [];

// Every host that is supposed to be able to launch the engine, with the accessor that finds our entry.
// The accessors differ because the hosts differ: MiniMax and the shipped artifact use a top-level
// "mcpServers", ZCode nests "mcp.servers" inside its whole-app config, JCode's file keys it "servers".
// A gate that parsed only "mcpServers" silently validated 2 of the 4 registrations on this box.
const ENGINE = `${REPO}/minimax-code-plugin/.minimax-plugin/mcp-server.mjs`;
const HOSTS = [
  { label: "minimax", file: "C:/Users/datoo/.minimax/mcp.json", pick: (d) => d.mcpServers?.["llm-verifier"], required: true },
  { label: "zcode", file: "C:/Users/datoo/.zcode/cli/config.json", pick: (d) => d.mcp?.servers?.["llm-verifier"], required: true },
  { label: "jcode", file: "C:/Users/datoo/.jcode/mcp.json", pick: (d) => d.servers?.["llm-verifier"], required: true },
  // Qoder CN and Qoder carry only SKILL.md: no MCP registration exists, so there is nothing to validate.
  // required:false is not a blind spot — if someone later registers it, hostCheck validates the new entry,
  // and an engine file that no host points at can still be caught by the sync drift detector.
  { label: "qoder-cn", file: "C:/Users/datoo/.qoder-cn/mcp.json", pick: (d) => d.mcpServers?.["llm-verifier"] ?? d.servers?.["llm-verifier"], required: false },
  { label: "qoder", file: "C:/Users/datoo/.qoder/mcp.json", pick: (d) => d.mcpServers?.["llm-verifier"] ?? d.servers?.["llm-verifier"], required: false },
];

// The per-server rules, shared by the shipped artifact and the installed overlays so the two cannot
// drift into validating different things (an absolved installed copy is the one the host loads).
function serverRules(label, name, s) {
  const extra = Object.keys(s).filter((k) => !ALLOWED.includes(k) && !HOST_EXTENSIONS.includes(k));
  if (extra.length) failures.push(`${label}: server ${name} carries keys the schema forbids: ${extra.join(",")}`);
  for (const req of stdio.required) if (!(req in s)) failures.push(`${label}: server ${name} missing required ${req}`);
  if (s.type !== stdio.properties.type.const) failures.push(`${label}: server ${name} type must be ${stdio.properties.type.const}`);
  if (typeof s.command !== "string" || s.command.length === 0) failures.push(`${label}: server ${name} command must be a non-empty string`);
  if (!Array.isArray(s.args) || s.args.some((a) => typeof a !== "string")) failures.push(`${label}: server ${name} args must be an array of strings`);
  if ("cwd" in s && !new RegExp(stdio.properties.cwd.pattern).test(s.cwd)) {
    failures.push(`${label}: server ${name} cwd ${JSON.stringify(s.cwd)} violates the schema pattern ${stdio.properties.cwd.pattern}`);
  }
  if ("cwd" in s && !Array.isArray(s.args)) failures.push(`${label}: server ${name} uses cwd but has no args array`);
  const env = s.env || {};
  for (const k of Object.keys(env)) {
    if (["PLUGIN_ROOT", "PLUGIN_DATA"].includes(k)) failures.push(`${label}: server ${name} env must not define ${k} (reserved by the schema)`);
    if (typeof env[k] !== "string") failures.push(`${label}: server ${name} env ${k} is not a string`);
  }
}

function check(label, file) {
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) { failures.push(`${label}: unreadable/unparsable (${e.message})`); return; }
  for (const k of Object.keys(doc)) {
    if (k !== "$schema" && k !== "mcpServers") failures.push(`${label}: top-level key ${k} not allowed (schema top-level: ${Object.keys(schema.properties).join(",")})`);
  }
  if (doc.$schema !== schema.$id) failures.push(`${label}: $schema is ${doc.$schema}, gate validates against ${schema.$id} — refresh the vendored schema`);
  const servers = doc.mcpServers || {};
  // An artifact that declares no server of ours is not "vacuously valid" — it is a plugin that installs
  // nothing, and every host check downstream would still have been green.
  if (!servers["llm-verifier"]) { failures.push(`${label}: ${file} declares no "llm-verifier" server`); return; }
  for (const [name, s] of Object.entries(servers)) {
    serverRules(label, name, s);
    // The machine-independence rule the whole gate exists for: no baked-in user home in the shipped artifact.
    const raw = fs.readFileSync(file, "utf8");
    if (label === "plugin" && /C:\/Users\/|\/home\/|\/Users\/datoo/.test(raw)) {
      failures.push(`${label}: shipped artifact hard-codes a user path — it cannot resolve on another machine: ${raw.match(/"(?:C:\/Users|\/home)[^"]*"/)?.[0]}`);
    }
    console.log(`ok  ${label.padEnd(8)} keys=${Object.keys(s).join(",")} args=${JSON.stringify(s.args)} cwd=${s.cwd ?? "(unset)"}`);
    // ${PLUGIN_ROOT} for the shipped artifact is minimax-code-plugin/, which is two levels above the
    // mcp.json itself — derived from PLUGIN_MCP so a REPO spelling change cannot silently break it.
    if (name === "llm-verifier") resolveEngine(`${label}/artifact`, s, path.posix.dirname(path.posix.dirname(PLUGIN_MCP)));
  }
}

// The host-side contract is narrower than the artifact contract: these files are host-owned config, and
// they already carry keys the agent-plugins schema forbids (`enabled`, `configured`) and omit ones it
// requires (`type` on JCode). Applying serverRules here would fail on registrations that demonstrably
// work, so the host check asserts only what a launcher actually needs, then verifies the bytes it loads.
const hash = (f) => crypto.createHash("sha256").update(fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n")).digest("hex").slice(0, 12);

// One resolver for both loops. The shipped artifact and the installed copies differ deliberately —
// the artifact is relative to ${PLUGIN_ROOT} so it stays machine-independent, the copies are absolute —
// so identity between them is not the invariant. "The file the host will actually spawn is the repo
// file, byte for byte" is.
function resolveEngine(label, s, baseDir) {
  // A named failure, not a stack trace: args[0] can be "" (⇒ the resolved path is a directory and
  // readFileSync throws EISDIR) or a path realpath refuses, and the gate must still print its whole
  // failure list instead of dying here with an unattributable exit code.
  try {
    const rel = (s.args?.[0] ?? "").replaceAll("\\", "/");
    const cwd = (s.cwd || "").replace("${PLUGIN_ROOT}", baseDir);
    const target = path.isAbsolute(rel) ? rel : `${cwd}/${rel}`;
    if (!fs.existsSync(target)) { failures.push(`${label}: resolves to ${target}, which does not exist (the host would fail to start the server)`); return; }
    const st = fs.statSync(target);
    if (!st.isFile()) { failures.push(`${label}: resolves to ${target}, which is not a file`); return; }
    const real = fs.realpathSync.native(target).replaceAll("\\", "/");
    const drift = hash(real) !== hash(ENGINE);
    console.log(`${drift ? "BAD" : "ok "} ${label.padEnd(13)} -> ${real}${real === target ? "" : ` (via ${target})`} engine=${hash(real)}`);
    if (drift) failures.push(`${label}: loaded engine ${real} is ${hash(real)}, repo ${ENGINE} is ${hash(ENGINE)} — run sync-deployed-924.mjs --write`);
  } catch (e) {
    failures.push(`${label}: could not resolve its engine path (${String(e && e.message || e)})`);
  }
}

// ponytail: this proves each host resolves to a *real* file that matches the repo. It does NOT prove that
// file is one sync-deployed-924.mjs writes — a 5th host pointing at a path outside that TARGETS list would
// read "ok" here and stay stale forever. Verified by hand 2026-09-25: the 5 registrations resolve to 2
// distinct paths, both present in sync-deployed-924.mjs TARGETS. Re-check that containment if a host moves.
function hostCheck({ label, file, pick, required }) {
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) {
    // Absent used to be invisible. required:true means the host is expected to launch us: a missing or
    // unparsable config is a host that cannot start the server, which is exactly the failure to catch.
    if (required) failures.push(`${label}: ${file} is missing or unparsable (${e.message}) — no server registration for this host`);
    else console.log(`n/a ${label.padEnd(9)} no registration file (SKILL.md-only install; tracked separately)`);
    return;
  }
  const s = pick(doc);
  if (!s) {
    if (required) failures.push(`${label}: ${file} declares no "llm-verifier" server`);
    else console.log(`n/a ${label.padEnd(9)} ${file} exists but registers no llm-verifier server`);
    return;
  }
  const bad = [];
  if (typeof s.command !== "string" || s.command.length === 0) bad.push("command must be a non-empty string");
  if (!Array.isArray(s.args) || s.args.length === 0 || s.args.some((a) => typeof a !== "string")) bad.push("args must be a non-empty array of strings");
  if ("type" in s && s.type !== "stdio") bad.push(`type ${JSON.stringify(s.type)} is not stdio`);
  if ("enabled" in s && s.enabled !== true) bad.push(`enabled=${JSON.stringify(s.enabled)} — the host will not launch a disabled server`);
  for (const [k, v] of Object.entries(s.env || {})) {
    if (typeof v !== "string") bad.push(`env ${k} is not a string`);
    if (["PLUGIN_ROOT", "PLUGIN_DATA"].includes(k)) bad.push(`env defines ${k}, which the host reserves`);
  }
  if (bad.length) { failures.push(`${label}: ${bad.join("; ")}`); return; }
  resolveEngine(label, s, path.posix.dirname(file.replaceAll("\\", "/")));
}

check("plugin", PLUGIN_MCP);
for (const [i, f] of INSTALLED.entries()) {
  const label = `installed${i + 1}`;
  let doc;
  try { doc = JSON.parse(fs.readFileSync(f, "utf8")); }
  catch (e) { failures.push(`${label}: ${f} is missing or unparsable (${e.message}) — no server registration for this host`); continue; }
  const s = doc.mcpServers?.["llm-verifier"];
  if (!s) { failures.push(`${label}: ${f} declares no "llm-verifier" server`); continue; }
  serverRules(label, "llm-verifier", s);
  // ${PLUGIN_ROOT} is the plugin root, which is the parent of the mcp.json at INSTALLED[1].
  resolveEngine(label, s, path.posix.dirname(INSTALLED[1].replaceAll("\\", "/")));
}
for (const h of HOSTS) hostCheck(h);

console.log(failures.length ? `\nMCP CONFIG FAILURES:\n - ${failures.join("\n - ")}` : "\nMCP CONFIG OK");
process.exit(failures.length ? 1 : 0);
