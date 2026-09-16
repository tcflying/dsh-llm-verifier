#!/usr/bin/env node
// llm-verifier MCP server for MiniMax Code — zero-dependency stdio server.
// Ports the dsh-llm-verifier workflow: best-of-N candidate generation with git
// worktree isolation, validation, review routing (parent_agent | mcode_model),
// then select/apply/rollback of the winning patch.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

// ---------------------------------------------------------------- constants
const PLUGIN_NAME = "llm-verifier";
const VERSION = "1.0.0";
const DATA_DIR = process.env.LLM_VERIFIER_DATA
  || path.join(os.homedir(), ".minimax", "plugins", PLUGIN_NAME, "data");
const RUNS_DIR = path.join(DATA_DIR, "runs");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const MCODE_BIN = process.env.LLM_VERIFIER_MCODE_BIN || "mcode";
const MIN = 60_000;

const DEFAULTS = {
  enabled: true,
  defaultCandidateCount: 2,
  maxConcurrent: 2,
  validationCommand: "",            // empty → auto-detect (package.json test script → npm test)
  reviewMode: "parent_agent",       // parent_agent | mcode_model
  reviewerModel: "",                // provider/model override for the mcode_model reviewer
  candidateModel: "",               // provider/model override for candidate agents
  candidateTimeoutMin: 20,
  totalTimeoutMin: 45,
  reviewTimeoutMin: 5,
};

// ---------------------------------------------------------------- tiny utils
const sh = (cmd, opts = {}) =>
  spawnSync(cmd[0], cmd.slice(1), { encoding: "utf8", ...opts });
const git = (repo, args, opts = {}) =>
  sh(["git", ...args], { cwd: repo, ...opts });
const gitOk = (repo, args, opts = {}) => git(repo, args, opts).status === 0;
const readJson = (p, fallback) => {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
};
const writeJson = (p, v) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(v, null, 2));
};
const tail = (s, n = 1500) => (s || "").slice(-n);
const nowIso = () => new Date().toISOString();

function loadConfig() {
  return { ...DEFAULTS, ...readJson(CONFIG_PATH, {}) };
}
function validateConfig(c) {
  const errs = [];
  const cnt = (v) => Number.isInteger(v) && v >= 1 && v <= 5;
  if (!cnt(c.defaultCandidateCount)) errs.push("defaultCandidateCount must be 1-5");
  if (!cnt(c.maxConcurrent)) errs.push("maxConcurrent must be 1-5");
  if (!["parent_agent", "mcode_model"].includes(c.reviewMode))
    errs.push('reviewMode must be "parent_agent" or "mcode_model"');
  if (typeof c.candidateTimeoutMin !== "number" || c.candidateTimeoutMin < 1) errs.push("candidateTimeoutMin must be >= 1");
  if (typeof c.totalTimeoutMin !== "number" || c.totalTimeoutMin < 1) errs.push("totalTimeoutMin must be >= 1");
  return errs;
}

// ---------------------------------------------------------------- MCP protocol
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) handleLine(line);
  }
});
process.stdin.on("end", () => process.exit(0));
const writeMsg = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

function handleLine(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (method === "notifications/initialized" || (method || "").startsWith("notifications/")) return;
  if (method === "initialize") {
    writeMsg({
      jsonrpc: "2.0", id,
      result: {
        protocolVersion: params?.protocolVersion || "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: PLUGIN_NAME, version: VERSION },
      },
    });
    return;
  }
  if (method === "ping") { writeMsg({ jsonrpc: "2.0", id, result: {} }); return; }
  if (method === "tools/list") { writeMsg({ jsonrpc: "2.0", id, result: { tools: TOOLS } }); return; }
  if (method === "tools/call") {
    const { name, arguments: args } = params || {};
    callTool(name, args || {})
      .then((r) => writeMsg({ jsonrpc: "2.0", id, result: r }))
      .catch((e) => writeMsg({
        jsonrpc: "2.0", id,
        result: { content: [{ type: "text", text: String(e && e.stack || e) }], isError: true },
      }));
    return;
  }
  writeMsg({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method: ${method}` } });
}

const text = (obj) => ({ content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] });

// ---------------------------------------------------------------- tool defs
const TOOLS = [
  {
    name: "verified_best_of",
    title: "Run best-of-N candidates with validation and review",
    description:
      "Generate N independent candidate solutions for a coding task in isolated git worktrees, " +
      "validate each with a command, then route to review. Returns review_pending (read the " +
      "report, then call select_verified_candidate + apply_verified_winner) or winner_selected " +
      "(call apply_verified_winner). Requires repoPath (absolute path of the target git repo) and task.",
    inputSchema: {
      type: "object",
      required: ["repoPath", "task"],
      properties: {
        repoPath: { type: "string", description: "Absolute path of the target git repository" },
        task: { type: "string", description: "The coding task for every candidate" },
        candidateCount: { type: "integer", minimum: 1, maximum: 5 },
        maxConcurrent: { type: "integer", minimum: 1, maximum: 5 },
        validationCommand: { type: "string", description: "Shell command run inside each worktree; empty = auto-detect npm test" },
        reviewMode: { type: "string", enum: ["parent_agent", "mcode_model"] },
        baseBranch: { type: "string", description: "Optional base branch to branch worktrees from (default: current HEAD)" },
      },
    },
  },
  {
    name: "select_verified_candidate",
    title: "Select the winning candidate after review",
    description: "Pick the winner among candidates of a review_pending run. Audit-recorded.",
    inputSchema: {
      type: "object",
      required: ["runId", "candidateId"],
      properties: {
        runId: { type: "string" },
        candidateId: { type: "string", description: "e.g. candidate-1" },
        reason: { type: "string" },
      },
    },
  },
  {
    name: "apply_verified_winner",
    title: "Apply the winning patch to the repository",
    description: "Apply the selected candidate's diff to the origin repository. Refuses unless status is winner_selected.",
    inputSchema: { type: "object", required: ["runId"], properties: { runId: { type: "string" } } },
  },
  {
    name: "rollback_verified_winner",
    title: "Roll back an applied winner patch",
    description: "Reverse the applied winner patch. Refuses if repository files were modified after the apply.",
    inputSchema: { type: "object", required: ["runId"], properties: { runId: { type: "string" } } },
  },
  {
    name: "verifier_configure",
    title: "Configure the verifier",
    description: "Persist verifier settings (merged into stored config). Omitted fields keep their values.",
    inputSchema: {
      type: "object",
      properties: {
        enabled: { type: "boolean" },
        defaultCandidateCount: { type: "integer", minimum: 1, maximum: 5 },
        maxConcurrent: { type: "integer", minimum: 1, maximum: 5 },
        validationCommand: { type: "string" },
        reviewMode: { type: "string", enum: ["parent_agent", "mcode_model"] },
        reviewerModel: { type: "string" },
        candidateModel: { type: "string" },
        candidateTimeoutMin: { type: "number" },
        totalTimeoutMin: { type: "number" },
        reviewTimeoutMin: { type: "number" },
      },
    },
  },
  {
    name: "verifier_get_config",
    title: "Read verifier configuration and paths",
    description: "Return the effective verifier config, config file path and runs directory.",
    inputSchema: { type: "object", properties: {} },
  },
];

async function callTool(name, args) {
  if (loadConfig().enabled === false && name !== "verifier_configure" && name !== "verifier_get_config")
    throw new Error("llm-verifier is disabled; enable via verifier_configure {enabled:true}");
  switch (name) {
    case "verified_best_of": return text(await runVerifiedBestOf(args));
    case "select_verified_candidate": return text(selectVerifiedCandidate(args));
    case "apply_verified_winner": return text(applyVerifiedWinner(args));
    case "rollback_verified_winner": return text(rollbackVerifiedWinner(args));
    case "verifier_configure": return text(configureTool(args));
    case "verifier_get_config": return text({
      config: loadConfig(),
      configPath: CONFIG_PATH,
      runsDir: RUNS_DIR,
      mcodeBin: MCODE_BIN,
    });
    default: throw new Error(`unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------- engine
function detectValidation(repoPath) {
  const pkg = readJson(path.join(repoPath, "package.json"), null);
  if (pkg && pkg.scripts && pkg.scripts.test) return "npm test";
  return "";
}

function runManifest(runId) { return path.join(RUNS_DIR, runId, "manifest.json"); }
function loadRun(runId) {
  const m = readJson(runManifest(runId), null);
  if (!m) throw new Error(`run not found: ${runId} (looked in ${runManifest(runId)})`);
  return m;
}
function saveRun(m) { writeJson(runManifest(m.runId), m); }

function buildCandidatePrompt(n, total, task) {
  return [
    `You are candidate ${n} of ${total} in a best-of-N run. Solve the task independently; do not assume other candidates exist.`,
    "",
    "TASK:",
    task,
    "",
    "ISOLATION CONTRACT (mandatory):",
    "- Work ONLY inside your current working directory (your own git worktree).",
    "- Never edit, write, or cd outside it — the original repository and sibling worktrees are strictly off limits.",
    "- Absolute paths pointing outside your cwd are forbidden.",
    "- Finish by making sure the project's validation command passes in your worktree.",
  ].join("\n");
}

function execMcode(cwd, prompt, { timeoutMin, model, permission = "off", outputSchema } = {}) {
  // prompt goes via stdin (--input -) so multi-line text survives the shell
  const args = ["exec", "--cwd", cwd, "--permission", permission,
    "--timeout", `${timeoutMin}m`, "--output-format", "json", "--input", "-"];
  if (model) args.push("--model", model);
  if (outputSchema) args.push("--output-schema", outputSchema);
  return new Promise((resolve) => {
    const child = spawn(MCODE_BIN, args, {
      shell: process.platform === "win32",
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "", err = "";
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      resolve({ timedOut: true, raw: out, stderr: err });
    }, timeoutMin * MIN + 30_000);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => { clearTimeout(timer); resolve({ error: String(e), stderr: err }); });
    child.on("close", () => {
      clearTimeout(timer);
      let result = null;
      for (const line of out.split("\n")) {
        const t = line.trim();
        if (t.startsWith("{") && t.includes('"exec.result"')) {
          try { result = JSON.parse(t); } catch {}
        }
      }
      resolve({ result, raw: out, stderr: err });
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

async function runCandidate(run, cand) {
  const cfg = run.config;
  const res = await execMcode(cand.worktree, buildCandidatePrompt(cand.index, run.candidateCount, run.task), {
    timeoutMin: cfg.candidateTimeoutMin,
    model: cfg.candidateModel || undefined,
  });
  cand.sessionId = res.result?.sessionId || null;
  cand.usage = res.result?.usage || null;
  if (res.error) {
    cand.generation = { status: "error", detail: res.error };
  } else if (res.timedOut) {
    cand.generation = { status: "timeout" };
  } else if (res.result && res.result.status === "succeeded") {
    cand.generation = { status: "succeeded" };
  } else {
    cand.generation = { status: res.result?.status || "failed", detail: tail(res.result?.output || res.raw, 500), stderr: (res.stderr || "").slice(0, 600) };
  }
  return cand;
}

function runValidation(cand, command) {
  const r = sh(["cmd", "/c", command], { cwd: cand.worktree, encoding: "utf8", timeout: 10 * MIN });
  const passed = r.status === 0;
  cand.validation = { command, status: passed ? "passed" : "failed", exitCode: r.status, output: tail(r.stdout + r.stderr) };
  return passed;
}

function diffStat(run, cand) {
  const r = git(cand.worktree, ["diff", "--cached", "--stat"]);
  return r.status === 0 ? r.stdout.trim() : "(diff stat failed)";
}

function buildReport(run) {
  const L = [];
  L.push(`# LLM Verifier report — run ${run.runId}`);
  L.push(`- Status: \`${run.status}\``);
  L.push(`- Task: ${run.task}`);
  L.push(`- Repository: ${run.repoPath}`);
  L.push(`- Review mode: \`${run.config.reviewMode}\``);
  L.push(`- Candidates: ${run.candidateCount} (concurrency ${run.config.maxConcurrent})`);
  for (const c of run.candidates) {
    L.push("");
    L.push(`## ${c.candidateId}`);
    L.push(`- Generation: \`${c.generation?.status}\`${c.sessionId ? ` (session ${c.sessionId})` : ""}`);
    L.push(`- Validation: \`${c.validation?.status}\` via \`${c.validation?.command}\``);
    if (c.validation?.output) L.push(`- Validation tail:\n\n\`\`\`\n${c.validation.output}\n\`\`\``);
    if (c.review) L.push(`- Review score: ${c.review.score} — ${c.review.risks || ""}`);
    if (run.winnerId === c.candidateId) L.push("- **WINNER**");
  }
  if (run.review) {
    L.push("");
    L.push(`## Review receipt`);
    L.push(`- Reviewer: \`${run.review.provider} / ${run.review.model}\``);
    L.push(`- Duration ms: ${run.review.durationMs}`);
    L.push(`- Selection: \`${run.selectionMethod}\``);
    if (run.review.scores) {
      for (const s of run.review.scores) L.push(`  - ${s.candidateId}: score ${s.score}${s.risks ? ` — ${s.risks}` : ""}`);
    }
  }
  if (run.selection) L.push(`- Selection reason: ${run.selection.reason} (${run.selection.by})`);
  const usage = run.candidates.filter((c) => c.usage);
  if (usage.length) {
    const ti = usage.reduce((a, c) => a + (c.usage.inputTokens || 0), 0);
    const to = usage.reduce((a, c) => a + (c.usage.outputTokens || 0), 0);
    L.push("");
    L.push(`- Token usage (candidates): input ${ti}, output ${to}`);
  }
  L.push("");
  L.push(`- Manifest: ${runManifest(run.runId)}`);
  return L.join("\n");
}

function saveReport(run) {
  const p = path.join(RUNS_DIR, run.runId, "report.md");
  fs.writeFileSync(p, buildReport(run));
  run.reportPath = p;
}

async function runVerifiedBestOf(args) {
  const cfg = loadConfig();
  const repoPath = path.resolve(args.repoPath);
  if (!gitOk(repoPath, ["rev-parse", "--is-inside-work-tree"]))
    throw new Error(`repoPath is not a git work tree: ${repoPath}`);
  const runId = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14) + "-" + crypto.randomBytes(3).toString("hex");
  const count = args.candidateCount ?? cfg.defaultCandidateCount;
  const run = {
    schemaVersion: 1,
    runId, task: String(args.task), repoPath,
    status: "running", createdAt: nowIso(),
    candidateCount: count,
    config: {
      ...cfg,
      maxConcurrent: args.maxConcurrent ?? cfg.maxConcurrent,
      validationCommand: args.validationCommand ?? cfg.validationCommand,
      reviewMode: args.reviewMode ?? cfg.reviewMode,
    },
    candidates: [], winnerId: null, selection: null, review: null, selectionMethod: "none",
  };
  const runDir = path.join(RUNS_DIR, runId);
  const wtRoot = path.join(runDir, "worktrees");
  fs.mkdirSync(wtRoot, { recursive: true });
  const baseArgs = args.baseBranch ? [args.baseBranch] : ["HEAD"];
  for (let i = 1; i <= count; i++) {
    const candId = `candidate-${i}`;
    const wt = path.join(wtRoot, candId);
    const r = git(repoPath, ["worktree", "add", "-b", `llm-verifier/${runId}/${candId}`, wt, ...baseArgs]);
    if (r.status !== 0) throw new Error(`worktree add failed for ${candId}: ${tail(r.stderr, 400)}`);
    run.candidates.push({ candidateId: candId, index: i, worktree: wt, generation: null, validation: null, review: null });
  }
  saveRun(run);

  // generate + validate with concurrency limit
  const queue = [...run.candidates];
  const workers = Array.from({ length: Math.min(run.config.maxConcurrent, queue.length) }, async () => {
    while (queue.length) {
      const cand = queue.shift();
      await runCandidate(run, cand);
      const cmd = run.config.validationCommand || detectValidation(cand.worktree) || "node --test";
      runValidation(cand, cmd);
      saveRun(run);
    }
  });
  await Promise.all(workers);

  const passed = run.candidates.filter((c) => c.validation?.status === "passed");

  // freeze diffs before any review/decision reads them
  for (const c of run.candidates) {
    git(c.worktree, ["add", "-A"]);
    const p = git(c.worktree, ["diff", "--cached", "--binary"]);
    c.patchPath = path.join(RUNS_DIR, runId, `${c.candidateId}.patch`);
    fs.writeFileSync(c.patchPath, p.status === 0 ? p.stdout : "");
    c.diffStat = diffStat(run, c);
  }
  saveRun(run);

  if (passed.length === 0) {
    run.status = "no_winner";
    saveRun(run); saveReport(run);
    return { status: run.status, runId, reportPath: run.reportPath, message: "no candidate passed validation" };
  }

  if (run.config.reviewMode === "mcode_model") {
    const review = await reviewWithMcodeModel(run, passed);
    run.review = review.receipt;
    run.winnerId = review.selected;
    run.selectionMethod = "model_review";
    run.status = "winner_selected";
  } else if (passed.length === 1) {
    run.winnerId = passed[0].candidateId;
    run.selectionMethod = "single_survivor";
    run.status = "winner_selected";
  } else {
    run.status = "review_pending";
    run.selectionMethod = "pending";
  }
  saveRun(run); saveReport(run);
  const out = { status: run.status, runId, winnerId: run.winnerId, reportPath: run.reportPath, manifestPath: runManifest(runId) };
  if (run.status === "review_pending") {
    out.nextSteps = [
      `Read ${run.reportPath} and each candidate patch (candidate-N.patch in the run dir).`,
      "Call select_verified_candidate with your choice, then apply_verified_winner.",
    ];
    out.candidates = run.candidates.map((c) => ({
      candidateId: c.candidateId, diffStat: c.diffStat,
      validation: c.validation?.status, patchPath: c.patchPath,
    }));
  }
  return out;
}

function reviewWithMcodeModel(run, passed) {
  const cfg = run.config;
  const diffs = passed.map((c) =>
    `### ${c.candidateId}\n\`\`\`diff\n${fs.readFileSync(c.patchPath, "utf8").slice(0, 8000)}\n\`\`\``).join("\n\n");
  const schema = {
    type: "object", required: ["scores", "selected"],
    properties: {
      scores: { type: "array", items: { type: "object", required: ["candidateId", "score"], properties: {
        candidateId: { type: "string" }, score: { type: "integer", minimum: 0, maximum: 100 }, risks: { type: "string" } } } },
      selected: { type: "string" },
    },
  };
  const schemaPath = path.join(RUNS_DIR, run.runId, "review-schema.json");
  writeJson(schemaPath, schema);
  const prompt = [
    "You are a strict code reviewer comparing candidate patches that all pass the same validation.",
    "Score each candidate 0-100 (correctness, completeness, discipline; penalize stray files or scope creep).",
    "Then select exactly one candidateId (the top-scored one).",
    "",
    diffs,
  ].join("\n");
  const lenientPrompt = prompt + "\n\nRespond with ONLY a JSON object, no prose, no fences: " +
    '{"scores":[{"candidateId":"candidate-1","score":0,"risks":"..."}],"selected":"<top-scored candidateId>"}';

  const execReview = (useSchema, p) => {
    const args = ["exec", "--cwd", run.repoPath, "--permission", "off",
      "--timeout", `${cfg.reviewTimeoutMin}m`, "--output-format", "json",
      ...(useSchema ? ["--output-schema", schemaPath] : []),
      "--input", "-", ...(cfg.reviewerModel ? ["--model", cfg.reviewerModel] : [])];
    return spawnSync(MCODE_BIN, args,
      { encoding: "utf8", shell: process.platform === "win32", input: p,
        timeout: cfg.reviewTimeoutMin * MIN + 30_000 });
  };
  const parseSchemaJson = (s) => {
    if (!s) return {};
    try { return JSON.parse(s); } catch {}
    const m = s.match(/\{[\s\S]*"scores"[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch {} }
    try { return JSON.parse(s.slice(s.indexOf("{"), s.lastIndexOf("}") + 1)); } catch {}
    return {};
  };
  const extractResult = (stdout) => {
    for (const line of (stdout || "").split("\n")) {
      const t = line.trim();
      if (t.startsWith("{") && t.includes('"exec.result"')) {
        try { return JSON.parse(t); } catch {}
      }
    }
    return null;
  };
  const started = Date.now();
  let sync = execReview(true, prompt);
  let result = extractResult(sync.stdout);
  let parsed = parseSchemaJson(result?.output);
  if (!Array.isArray(parsed.scores) || parsed.scores.length === 0) {
    sync = execReview(false, lenientPrompt);   // schema path failed → bare-JSON retry
    result = extractResult(sync.stdout);
    parsed = parseSchemaJson(result?.output);
  }
  const durationMs = Date.now() - started;
  const scores = Array.isArray(parsed.scores) ? parsed.scores : [];
  let selected = parsed.selected;
  const valid = new Set(passed.map((c) => c.candidateId));
  const top = [...scores].filter((s) => valid.has(s.candidateId)).sort((a, b) => b.score - a.score)[0];
  if (!valid.has(selected) || (top && (scores.find((s) => s.candidateId === selected)?.score || 0) < top.score))
    selected = top?.candidateId || passed[0].candidateId; // strict: selected must be top-ranked
  for (const c of passed) {
    const s = scores.find((x) => x.candidateId === c.candidateId);
    c.review = { score: s?.score ?? 0, risks: s?.risks || "" };
  }
  return {
    selected,
    receipt: {
      provider: cfg.reviewerModel || "mcode-default",
      model: cfg.reviewerModel || result?.model?.modelId || "default",
      durationMs,
      scores: scores.filter((s) => valid.has(s.candidateId)),
    },
  };
}

function selectVerifiedCandidate({ runId, candidateId, reason }) {
  const run = loadRun(runId);
  if (run.status !== "review_pending")
    throw new Error(`run ${runId} status is ${run.status}, expected review_pending`);
  const cand = run.candidates.find((c) => c.candidateId === candidateId);
  if (!cand) throw new Error(`unknown candidateId ${candidateId}; valid: ${run.candidates.map((c) => c.candidateId).join(", ")}`);
  if (cand.validation?.status !== "passed") throw new Error(`${candidateId} did not pass validation; refusing to select`);
  run.winnerId = candidateId;
  run.selection = { candidateId, reason: reason || "", by: "parent_agent", at: nowIso() };
  run.selectionMethod = "parent_review";
  run.status = "winner_selected";
  saveRun(run); saveReport(run);
  return { status: run.status, runId, winnerId: candidateId, nextStep: `call apply_verified_winner {runId:"${runId}"}` };
}

function applyVerifiedWinner({ runId }) {
  const run = loadRun(runId);
  if (run.status !== "winner_selected" && run.status !== "rolled_back")
    throw new Error(`run ${runId} status is ${run.status}, expected winner_selected (or rolled_back for re-apply)`);
  const cand = run.candidates.find((c) => c.candidateId === run.winnerId);
  if (!cand?.patchPath || !fs.existsSync(cand.patchPath)) throw new Error(`winner patch missing for ${run.winnerId}`);
  const check = git(run.repoPath, ["apply", "--check", "--whitespace=nowarn", cand.patchPath]);
  if (check.status !== 0)
    throw new Error(`patch does not apply cleanly to the repository:\n${tail(check.stderr, 800)}`);
  const apply = git(run.repoPath, ["apply", "--whitespace=nowarn", cand.patchPath]);
  if (apply.status !== 0) throw new Error(`git apply failed:\n${tail(apply.stderr, 800)}`);
  run.appliedAt = nowIso();
  run.status = "applied";
  run.appliedPatchPath = cand.patchPath;
  const num = git(run.repoPath, ["apply", "--numstat", cand.patchPath]);
  run.appliedFiles = (num.stdout || "").split("\n").filter(Boolean).map((l) => l.split("\t").pop());
  saveRun(run); saveReport(run);
  return { status: run.status, runId, appliedFiles: run.appliedFiles, rollback: `call rollback_verified_winner {runId:"${runId}"} if needed` };
}

function rollbackVerifiedWinner({ runId }) {
  const run = loadRun(runId);
  if (run.status !== "applied") throw new Error(`run ${runId} status is ${run.status}, expected applied`);
  const check = git(run.repoPath, ["apply", "-R", "--check", "--whitespace=nowarn", run.appliedPatchPath]);
  if (check.status !== 0)
    throw new Error("rollback refused: repository files changed after apply (reverse patch does not apply cleanly). " +
      "Resolve local edits first, or reverse the patch manually:\n" + tail(check.stderr, 800));
  const r = git(run.repoPath, ["apply", "-R", "--whitespace=nowarn", run.appliedPatchPath]);
  if (r.status !== 0) throw new Error(`reverse apply failed:\n${tail(r.stderr, 800)}`);
  run.status = "rolled_back";
  run.rolledBackAt = nowIso();
  saveRun(run); saveReport(run);
  return { status: run.status, runId };
}

function configureTool(patch) {
  const merged = { ...loadConfig(), ...patch };
  const errs = validateConfig(merged);
  if (errs.length) throw new Error("invalid settings: " + errs.join("; "));
  fs.mkdirSync(DATA_DIR, { recursive: true });
  writeJson(CONFIG_PATH, merged);
  return { saved: true, config: merged, configPath: CONFIG_PATH };
}
