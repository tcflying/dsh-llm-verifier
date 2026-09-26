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
// Node clamps a setTimeout delay above 2^31-1 ms down to 1 ms (warning only), aborting a run instantly.
const MAX_TIMER_MS = 2_147_483_647;
const MAX_TIMEOUT_MIN = 10_080; // 7 days; keeps cfg.totalTimeoutMin * MIN under MAX_TIMER_MS
const IS_WIN = process.platform === "win32";
// $ alone lets a trailing newline through ("x\n" matches); safeModel() rejects it.
const MODEL_RE = /^[A-Za-z0-9._\/:-]{0,200}$/;
const safeModel = (v) => typeof v === "string" && v === v.trim() && MODEL_RE.test(v);
const RUN_ID_RE = /^[0-9]{14}-[0-9a-f]{6}$/;
const MAX_CAPTURE = 8 * 1024 * 1024;
// spawnSync's own default is 1 MiB — a bigger capture is cut off mid-stream with status null
// (measured: partial stdout + ENOBUFS), which is why every ceiling here is explicit.
const MAX_PATCH = 64 * 1024 * 1024;
const LATEST_PROTOCOL_VERSION = "2025-03-26";
const SUPPORTED_PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18"];

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
  // Twin of src/config.ts validationTimeoutMs (default 10 * 60 * 1000), spelled in this file's
  // minute vocabulary: every timeout knob here is *Min and shares MAX_TIMEOUT_MIN as its ceiling.
  validationTimeoutMin: 10,
};

// ---------------------------------------------------------------- tiny utils
// sh is the SYNC face: a hung git freezes the event loop, the run deadline and the host's ping
// together, so it gets a hang ceiling (10 MIN, the same budget a single external step gets in
// the async paths). LLM_VERIFIER_GIT_TIMEOUT_MS is the operator knob for slow storage.
// spawnSync({timeout}) THROWS ERR_OUT_OF_RANGE on a negative or fractional value (measured), and
// `Number(x) || default` only rescues NaN/0/"" — so `LLM_VERIFIER_GIT_TIMEOUT_MS=-1` used to make
// every sync git throw, including inside cleanupWorktrees' finally (losing the original failure).
// Accept only a positive integer, otherwise the default.
const _gitTimeout = Number(process.env.LLM_VERIFIER_GIT_TIMEOUT_MS);
const GIT_TIMEOUT_MS = Number.isInteger(_gitTimeout) && _gitTimeout > 0 ? _gitTimeout : 10 * MIN;
// Every spawn here executes content the candidate or the repository wrote (git inside the user's
// repo, whose hooks run, the worktree dependency install, the validation command, patch capture),
// so none of them may inherit the host's secrets. Allow-list, mirroring src/process.ts
// sanitizedEnvironment: Windows keeps its system roots or cmd/git/node stop resolving, and its env
// names are case-insensitive — a GUI host hands over Path/SystemRoot — so the lookup upper-cases
// while the original spelling is kept (POSIX names stay verbatim).
const ENV_NAMES = ["COLORTERM", "FORCE_COLOR", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "LOGNAME",
  "NO_COLOR", "PATH", "SHELL", "TEMP", "TERM", "TMP", "TMPDIR", "USER"];
const ENV_NAMES_WIN = [...ENV_NAMES, "ALLUSERSPROFILE", "APPDATA", "COMMONPROGRAMFILES", "COMSPEC",
  "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "PATHEXT", "PROGRAMDATA", "PROGRAMFILES", "SYSTEMROOT",
  "USERPROFILE", "WINDIR"];
const ENV_ALLOWED = new Set(IS_WIN ? ENV_NAMES_WIN : ENV_NAMES);
const SPAWN_ENV = Object.fromEntries(Object.entries(process.env)
  .filter(([k, v]) => v !== undefined && ENV_ALLOWED.has(IS_WIN ? k.toUpperCase() : k)));
const sh = (cmd, opts = {}) =>
  spawnSync(cmd[0], cmd.slice(1), { encoding: "utf8", timeout: GIT_TIMEOUT_MS, env: SPAWN_ENV, ...opts });
const git = (repo, args, opts = {}) =>
  sh(["git", ...args], { cwd: repo, ...opts });
const gitOk = (repo, args, opts = {}) => git(repo, args, opts).status === 0;
// Async twin of git(), same per-spawn ceiling: cleanup is the one path that runs *after* the run's
// response is settled, so a frozen loop there costs the host its ping and the shutdown drain a
// timer callback that can no longer fire.
const gitAsync = (repo, args, opts = {}) =>
  shAsync("git", args, { cwd: repo, timeout: GIT_TIMEOUT_MS, ...opts });
// Ceiling for the recursive worktree-root delete — the only cleanup step that is not a spawn, so it
// is the only one that needs a wall clock of its own. AbortSignal.timeout's timer is unref'd, so a
// ceiling this side of it can never hold the process open.
const CLEANUP_RM_TIMEOUT_MS = 5 * MIN;
// A killed spawnSync (timeout, buffer ceiling) writes no stderr: error.message is all that is
// left, and a failure reported as "git failed: <nothing>" reads as the patch's fault.
const gitWhy = (r) => r.error?.message || (r.stderr || "").trim() || `exited ${r.status}`;
const readJson = (p, fallback) => {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
};
const writeJson = (p, v) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // per-write unique temp: a fixed ".tmp" name makes concurrent writers rename a file
  // the previous writer already moved (ENOENT).
  const tmp = `${p}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2));
  fs.renameSync(tmp, p);
};
// Same unique-temp + rename durability, async face: the config write sits inside the mutation
// chain, which can be queued behind a long apply, and must not freeze the loop the host pings.
const writeJsonAsync = async (p, v) => {
  await fs.promises.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(v, null, 2));
  await fs.promises.rename(tmp, p);
};
const tail = (s, n = 1500) => (s || "").slice(-n);
const nowIso = () => new Date().toISOString();
// git spells a worktree path its own way (C:/a/b, and through the MSYS shell /c/a/b) while the
// engine builds them with path.join. Canonicalise before comparing either direction, and keep the
// original spelling for the command line — `git worktree remove` is fed what `add` was given.
const normPath = (p) => {
  let s = String(p).trim().replace(/^"|"$/g, "");
  if (!IS_WIN) return s.replace(/\/{2,}/g, "/").replace(/\/+$/, "") || "/";
  const m = s.match(/^\/([a-zA-Z])\/(.*)/);
  if (m) s = `${m[1].toUpperCase()}:/${m[2]}`;
  return s.replace(/[\\/]+/g, "\\").replace(/\\+$/, "").toLowerCase();
};
// Canonical on-disk form, for path EQUALITY only. `.native` resolves Windows 8.3 segments
// (C:\PROGRA~1) and junctions; the JS walk of fs.realpathSync does not, and this box's test dirs
// live under a %TEMP% that is not always canonical. Falls back to the lexical normPath when the
// OS cannot resolve a path, so a value git accepted still compares instead of erroring obscurely.
const canonPath = (p) => {
  try { return normPath(fs.realpathSync.native(p)); } catch { return normPath(p); }
};
const sha256File = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
// A config timeout is minutes; a spawn timer wants ms. Hand-edited or older-version config.json
// never passes validateConfig, and an unsanitised number is a live timer hazard: Node clamps a
// setTimeout delay above 2^31-1 ms to 1 ms (killing the step instantly), and a fractional or
// negative one throws ERR_OUT_OF_RANGE. So: clamp into range, fall back to DEFAULTS, round, and
// never hand a timer less than 1000 ms.
const minutesToTimeoutMs = (min) => {
  const v = Number(min);
  const safe = Number.isFinite(v) && v > 0 ? Math.min(v, MAX_TIMEOUT_MIN) : DEFAULTS.validationTimeoutMin;
  return Math.max(1000, Math.round(safe * MIN));
};

// Same hazard spelled in the unit the config actually stores. `minutesToTimeoutMs` cannot serve
// these sites because their values feed arithmetic (`deadlineAt`, `--timeout Nm`) rather than a
// spawn timer, so the clamp has to happen before the arithmetic: NaN in, NaN out, and a NaN budget
// makes every `Math.max(1000, Math.min(x, NaN))` NaN, which is falsy — the step then runs with no
// timer at all and passes `--timeout NaNm` to the model CLI.
const minutesIn = (min, fallback) => {
  const v = Number(min);
  // No rounding and no 1-minute floor here: a sub-minute budget is legal input, and S4 depends on
  // it (`validationTimeoutMin: 0.05` = 3 s, unreachable through verifier_configure, whose floor is 1
  // minute). Flooring it here silently turned a 3-second kill into a 60-second one.
  return Number.isFinite(v) && v > 0 ? Math.min(v, MAX_TIMEOUT_MIN) : fallback;
};

// Read at most `cap` bytes of a file. `readFileSync(p,"utf8").slice(0,cap)` decodes the whole
// thing first: a candidate patch may be up to MAX_PATCH (64 MiB) and this runs per candidate.
const readCapped = (p, cap) => {
  const buf = Buffer.allocUnsafe(cap + 1);
  const fd = fs.openSync(p, "r");
  try {
    const n = fs.readSync(fd, buf, 0, cap + 1, 0);
    return { text: buf.toString("utf8", 0, Math.min(n, cap)), over: n > cap };
  } finally { fs.closeSync(fd); }
};

function killTree(child) {
  if (!child || child.pid == null) return;
  if (IS_WIN) {
    const tk = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    tk.on("error", () => { try { child.kill(); } catch {} });
  } else {
    // children are spawned detached, so -pid is the whole process group: killing only the
    // direct child leaves a grandchild holding the pipes open (close never fires).
    try { process.kill(-child.pid, "SIGKILL"); }
    catch { try { child.kill("SIGKILL"); } catch {} }
  }
}

// Async spawn: never blocks the event loop (hosts must keep getting ping/tools/list).
// binary:true returns raw stdout bytes: a captured patch must never round-trip utf8 (U+FFFD).
function shAsync(bin, args, { input, timeout, signal, maxStdout = MAX_CAPTURE, binary = false, ...opts } = {}) {
  return new Promise((resolve) => {
    let child;
    const empty = binary ? Buffer.alloc(0) : "";
    try { child = spawn(bin, args, { detached: !IS_WIN, env: SPAWN_ENV, ...opts }); }
    catch (e) { resolve({ error: String(e), stdout: empty, stderr: "" }); return; }
    let stderr = "", timedOut = false, truncated = false, done = false, stdioGrace = null;
    const chunks = [];
    let stdoutBytes = 0;
    const stdoutVal = () => (binary ? Buffer.concat(chunks) : Buffer.concat(chunks).toString("utf8"));
    const timer = timeout ? setTimeout(() => { timedOut = true; killTree(child); }, timeout) : null;
    const onAbort = () => killTree(child);
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    if (child.stderr) child.stderr.setEncoding("utf8");
    child.stdout?.on("data", (d) => {
      // no setEncoding here, so d is a Buffer and the cap is measured in bytes either way
      if (stdoutBytes <= maxStdout) { chunks.push(d); stdoutBytes += d.length; }
      // past the cap the read is INCOMPLETE, and an incomplete patch must never look valid
      if (stdoutBytes > maxStdout) truncated = true;
    });
    child.stderr?.on("data", (d) => { if (stderr.length < MAX_CAPTURE) stderr += d; });
    const finish = (r) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (stdioGrace) clearTimeout(stdioGrace);
      signal?.removeEventListener("abort", onAbort);
      child.stdout?.removeAllListeners("data");
      child.stderr?.removeAllListeners("data");
      try { child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy(); } catch {}
      resolve(r);
    };
    child.on("error", (e) => finish({ error: String(e), timedOut: timedOut || undefined, stdout: stdoutVal(), stderr }));
    // `close` waits for stdout/stderr EOF, and a grandchild that inherited the write ends can hold
    // them open long after this child is gone — the timeout handler would then only kill again, and
    // the promise would never settle. Settle a short grace after `exit`, the same 250 ms as
    // STDIO_DRAIN_GRACE_MS in src/process.ts, unref'd so it can never hold the server open.
    child.on("exit", (code, sig) => {
      stdioGrace = setTimeout(() => finish({
        status: code, signal: sig, timedOut: timedOut || undefined,
        stdoutTruncated: truncated || undefined, stdout: stdoutVal(), stderr,
      }), 250);
      stdioGrace.unref();
    });
    child.on("close", (code, sig) => finish({
      status: code, signal: sig, timedOut: timedOut || undefined,
      stdoutTruncated: truncated || undefined, stdout: stdoutVal(), stderr,
    }));
    if (input != null && child.stdin) { child.stdin.on("error", () => {}); child.stdin.end(input); }
  });
}

// "absent" and "unreadable" are NOT the same: a torn config.json must not restore the
// defaults (enabled:true) and silently re-arm the verifier. Fail closed on parse errors.
function loadConfig() {
  const failClosed = (detail) => ({ ...DEFAULTS, enabled: false, configError: `${CONFIG_PATH}: ${detail}` });
  let raw;
  try { raw = fs.readFileSync(CONFIG_PATH, "utf8"); }
  catch (e) { return e.code === "ENOENT" ? { ...DEFAULTS } : failClosed(e.message); }
  let saved;
  try { saved = JSON.parse(raw); }
  catch (e) { return failClosed(`unparseable JSON (${e.message})`); }
  if (saved === null || typeof saved !== "object" || Array.isArray(saved))
    return failClosed("stored config is not an object");
  return { ...DEFAULTS, ...saved };
}
// keys=null validates every field (full config); otherwise only the listed keys
// (a configure patch — so one previously-saved bad value can't brick the surface).
function validateConfig(c, keys = null) {
  const has = (k) => !keys || keys.has(k);
  const errs = [];
  const cnt = (v) => Number.isInteger(v) && v >= 1 && v <= 5;
  const mins = (v) => Number.isFinite(v) && v >= 1 && v <= MAX_TIMEOUT_MIN;
  const minsErr = (k) => `${k} must be a number between 1 and ${MAX_TIMEOUT_MIN} minutes (7 days)`;
  const model = safeModel;
  if (has("enabled") && typeof c.enabled !== "boolean") errs.push("enabled must be a boolean");
  if (has("defaultCandidateCount") && !cnt(c.defaultCandidateCount)) errs.push("defaultCandidateCount must be an integer 1-5");
  if (has("maxConcurrent") && !cnt(c.maxConcurrent)) errs.push("maxConcurrent must be an integer 1-5");
  if (has("reviewMode") && !["parent_agent", "mcode_model"].includes(c.reviewMode))
    errs.push('reviewMode must be "parent_agent" or "mcode_model"');
  if (has("candidateModel") && !model(c.candidateModel)) errs.push("candidateModel must match ^[A-Za-z0-9._/-:]+$ (empty = default model)");
  if (has("reviewerModel") && !model(c.reviewerModel)) errs.push("reviewerModel must match ^[A-Za-z0-9._/-:]+$ (empty = default model)");
  if (has("validationCommand") && (typeof c.validationCommand !== "string" || c.validationCommand.length > 1000))
    errs.push("validationCommand must be a string of at most 1000 chars");
  if (has("candidateTimeoutMin") && !mins(c.candidateTimeoutMin)) errs.push(minsErr("candidateTimeoutMin"));
  if (has("totalTimeoutMin") && !mins(c.totalTimeoutMin)) errs.push(minsErr("totalTimeoutMin"));
  if (has("reviewTimeoutMin") && !mins(c.reviewTimeoutMin)) errs.push(minsErr("reviewTimeoutMin"));
  if (has("validationTimeoutMin") && !mins(c.validationTimeoutMin)) errs.push(minsErr("validationTimeoutMin"));
  return errs;
}

// ---------------------------------------------------------------- MCP protocol
let buf = "";
let initialized = false;
const inflight = new Map(); // request id -> AbortController, for notifications/cancelled
const pendingCalls = new Set(); // in-flight tools/call promises, drained before exit
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
const writeMsg = (obj) => { try { process.stdout.write(JSON.stringify(obj) + "\n"); } catch { /* host gone */ } };
// A host that hangs up is not a reason to leave live model sessions editing worktrees
// nobody owns: abort every in-flight run through the same cancel path a
// notifications/cancelled uses, then wait for the tree-kill + the run's finally cleanup
// (worktree/branch removal). The drain only waits: moving the manifest off "running" is the run
// body's job on every exit path — terminal status on return, cancelled on abort, no_winner in
// the crash catch — so a run that dies before its own cleanup leaves "running" and says so.
let draining = false;
function shutdown(reason) {
  if (draining) return;
  draining = true;
  for (const ac of inflight.values()) ac.abort();
  const drain = Promise.allSettled([...pendingCalls]).then(() => 0);
  // ponytail: fixed 60s drain ceiling; a child that ignores SIGKILL (or a leftover sync
  // spawn) can outlive it, and then we exit 1 with the cleanup unfinished — say so loudly,
  // because that is exactly the state that leaks a worktree. 20s was the first number and it
  // fired in a full-suite run on this box (measured: "drain exceeded 20s; exiting 1" while the
  // same test passes alone): the host is already gone, so the only cost of waiting is a briefly
  // longer-lived orphan, while the cost of giving up is a live worktree in the user's repo.
  const ceiling = new Promise((r) => setTimeout(() => r(1), 60_000));
  Promise.race([drain, ceiling]).then((code) => {
    if (code) console.error(`llm-verifier MCP: ${reason} drain exceeded 60s; exiting ${code} with cleanup unfinished`);
    process.exit(code);
  });
}
process.stdin.on("end", () => shutdown("stdin end"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
// Last-resort guard: one bad frame must never take the server down.
process.on("uncaughtException", (e) => {
  writeMsg({ jsonrpc: "2.0", method: "notifications/message", params: { level: "error", data: String(e && e.stack || e) } });
});

function handleLine(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  try { dispatch(msg); } catch (e) {
    const id = msg && typeof msg === "object" ? msg.id : undefined;
    if (id !== undefined && id !== null)
      writeMsg({ jsonrpc: "2.0", id, error: { code: -32603, message: String((e && e.message) || e) } });
  }
}

function dispatch(msg) {
  if (msg === null || typeof msg !== "object" || Array.isArray(msg)) return;
  const { id, method, params } = msg;
  if (typeof method !== "string") {
    if (id !== undefined)
      writeMsg({ jsonrpc: "2.0", id, error: { code: -32600, message: "invalid request: method must be a string" } });
    return;
  }
  if (method === "notifications/cancelled") {
    const ac = params && inflight.get(params.requestId);
    if (ac) ac.abort();
    return;
  }
  if (method.startsWith("notifications/")) return;
  if (method === "initialize") {
    initialized = true;
    writeMsg({
      jsonrpc: "2.0", id,
      result: {
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(params?.protocolVersion)
          ? params.protocolVersion : LATEST_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: PLUGIN_NAME, version: VERSION },
      },
    });
    return;
  }
  if (method === "ping") { writeMsg({ jsonrpc: "2.0", id, result: {} }); return; }
  if (method === "tools/list") { writeMsg({ jsonrpc: "2.0", id, result: { tools: TOOLS } }); return; }
  if (method === "tools/call") {
    if (!initialized) {
      writeMsg({ jsonrpc: "2.0", id, error: { code: -32600, message: "not initialized: send initialize before tools/call" } });
      return;
    }
    // shutdown()'s drain snapshots the calls already in flight, so a frame that was still buffered
    // when it ran would start a run no one is waiting for: allSettled([]) resolves, process.exit
    // lands mid-`git worktree add`, and the run is left registered with a manifest at "running".
    if (draining) {
      writeMsg({ jsonrpc: "2.0", id, error: { code: -32600, message: "server is shutting down; no tool was started" } });
      return;
    }
    const { name, arguments: args } = params || {};
    const ac = new AbortController();
    if (id !== undefined) inflight.set(id, ac);
    const p = Promise.resolve(callTool(name, args || {}, ac.signal))
      .then((r) => writeMsg({ jsonrpc: "2.0", id, result: r }))
      .catch((e) => writeMsg({
        jsonrpc: "2.0", id,
        result: { content: [{ type: "text", text: String(e && e.stack || e) }], isError: true },
      }))
      .finally(() => { inflight.delete(id); pendingCalls.delete(p); });
    pendingCalls.add(p);
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
    description: "Apply the selected candidate's diff to the origin repository, then rerun the stored validation command. Refuses unless status is winner_selected.",
    inputSchema: { type: "object", required: ["runId"], properties: { runId: { type: "string" } } },
  },
  {
    name: "rollback_verified_winner",
    title: "Roll back an applied winner patch",
    description: "Reverse the applied winner patch. Refuses if repository files changed after the apply.",
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
        validationTimeoutMin: { type: "number" },
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

// The kill switch is only real if it is read at the moment of use. Two moments matter:
//  - request arrival (callTool below), and
//  - the instant a queued mutating turn is about to touch the repository.
// A call that arrived while enabled but then waits in the queue behind a long apply must NOT run
// on that stale arrival snapshot after the operator stores enabled:false — that is how the kill
// switch was being bypassed (measured: applyA holding the queue ~20s → configure{enabled:false}
// → applyB still applied). So the queued mutating tools re-read config as the FIRST statement of
// their closure, right before they mutate (same last-safe-point discipline as apply's abort check).
// Re-reading config.json once per queued turn is one sync read: the whole cost.
// verified_best_of is not queued and an in-flight run stays out of scope (documented in runVerifiedBestOf).
function ensureEnabled(name) {
  const cfg = loadConfig();
  if (cfg.enabled === false && name !== "verifier_configure" && name !== "verifier_get_config")
    throw new Error(cfg.configError
      ? `llm-verifier is refusing to run: stored config is unreadable (${cfg.configError}). ` +
        `Verifier is treated as disabled until ${CONFIG_PATH} is fixed or deleted; no model was spawned.`
      : "llm-verifier is disabled; enable via verifier_configure {enabled:true}");
  return cfg;
}

async function callTool(name, args, signal) {
  const cfg = ensureEnabled(name);   // arrival check: reject a disabled call without even queueing it
  switch (name) {
    case "verified_best_of": return text(await runVerifiedBestOf(args, cfg, signal));
    case "select_verified_candidate":
      return text(await serialise(() => { ensureEnabled(name); return selectVerifiedCandidate(args); }));
    case "apply_verified_winner":
      return text(await serialise(() => { ensureEnabled(name); return applyVerifiedWinner(args, signal); }));
    case "rollback_verified_winner":
      return text(await serialise(() => { ensureEnabled(name); return rollbackVerifiedWinner(args); }));
    case "verifier_configure": return text(await serialise(() => configureTool(args)));
    case "verifier_get_config": return text({
      config: cfg,
      configPath: CONFIG_PATH,
      runsDir: RUNS_DIR,
      mcodeBin: MCODE_BIN,
    });
    default: throw new Error(`unknown tool: ${name}`);
  }
}

// Every mutating tool is a read-modify-write of one file (config.json or a run manifest) and
// dispatch is concurrent, so two overlapping turns could merge from the same stale snapshot and
// the later write would drop the earlier field — including the enabled:false kill switch.
// Only the SHORT mutating tools queue here: verified_best_of lasts tens of minutes and must
// never block a configure, and the read-only tools must answer while a run is in flight.
let mutationTurn = Promise.resolve();
const serialise = (task) => {
  const result = mutationTurn.then(task);
  // the chain link swallows every outcome: a handler that throws must not wedge later turns
  mutationTurn = result.then(() => {}, () => {});
  return result;
};

// ---------------------------------------------------------------- engine
function detectValidation(repoPath) {
  const pkg = readJson(path.join(repoPath, "package.json"), null);
  if (pkg && pkg.scripts && pkg.scripts.test) return "npm test";
  return "";
}

// A worktree is a fresh checkout with no node_modules, so `npm test` there fails
// for a reason that has nothing to do with the candidate and every JavaScript
// repo comes back no_winner. Same rule as src/validation.ts setupCommands: the
// install belongs in the worktree, never in the user's repository.
// `--no-save --no-package-lock`: a bare `npm install` writes package-lock.json,
// which is a *tracked* file, so the winner's patch would carry harness-authored
// dependency churn into the user's tree. The lockfile-preserving branches (npm ci,
// --frozen-lockfile) never write it.
function dependencyInstall(worktree) {
  if (!fs.existsSync(path.join(worktree, "package.json"))) return "";
  if (fs.existsSync(path.join(worktree, "node_modules"))) return "";
  if (fs.existsSync(path.join(worktree, "pnpm-lock.yaml"))) return "pnpm install --frozen-lockfile";
  if (fs.existsSync(path.join(worktree, "package-lock.json"))) return "npm ci";
  // yarn.lock alone: installing with npm would resolve a different (unlocked) graph
  // than the repository's own toolchain, so don't guess a second package manager.
  if (fs.existsSync(path.join(worktree, "yarn.lock"))) return "";
  return "npm install --no-save --no-package-lock";
}

function runManifest(runId) { return path.join(RUNS_DIR, runId, "manifest.json"); }
function assertRunId(runId) {
  if (typeof runId !== "string" || !RUN_ID_RE.test(runId))
    throw new Error(`invalid runId: ${JSON.stringify(runId)} (expected format ${RUN_ID_RE.source})`);
}
// The mutation target comes from a receipt file, and every git() call spawns with cwd = that value:
// a missing or relative repoPath makes git run inside *this server's own* working directory, so a
// hand-edited or pre-validation manifest would land the winner's patch in the plugin's tree.
// Nothing downstream can recover that, so the read of the receipt is where it stops. `what` names
// which receipt the bad value came from (manifest | apply-state).
function assertWorkTree(what, runId, p) {
  if (typeof p !== "string" || !path.isAbsolute(p)
    || !gitOk(p, ["rev-parse", "--is-inside-work-tree"])) {
    throw new Error(`run ${runId} ${what} repoPath is not an existing git work tree: ${JSON.stringify(p)} — refusing to act on this run`);
  }
}
// The patch file path is the other record-supplied argument that reaches git — as the last positional
// of `git apply -R <path>`, so a value starting with `-` is read as an OPTION (`--directory=…`, `-p0`)
// and any absolute path is read with this server's own permissions. The apply path only ever writes
// `<runDir>/<candidateId>.patch`, so confining the rollback to that shape costs nothing real.
// realpath on both sides, not lexical resolve: a junction inside the run dir would otherwise walk out.
function assertPatchPath(runId, p) {
  const runRoot = path.join(RUNS_DIR, runId);
  const bad = (why) => { throw new Error(`run ${runId}: the recorded patch path ${JSON.stringify(p)} ${why}`); };
  if (typeof p !== "string" || p === "" || p.startsWith("-")) bad("is not a usable file name");
  const root = realpathOrNull(runRoot);
  const file = realpathOrNull(p);
  if (root === null) bad(`cannot be checked because the run directory ${runRoot} is gone`);
  if (file === null) bad("does not resolve to an existing file");
  if (file !== root && !file.startsWith(root + path.sep)) bad(`is outside the run directory ${runRoot}`);
  return file;
}
function realpathOrNull(p) {
  try { return fs.realpathSync(p); } catch { return null; }
}
function loadRun(runId) {
  assertRunId(runId);
  const p = runManifest(runId);
  let m;
  try { m = JSON.parse(fs.readFileSync(p, "utf8")); }
  catch (e) {
    if (e.code === "ENOENT") throw new Error(`run not found: ${runId} (looked in ${p})`);
    throw new Error(`run manifest is corrupt and unreadable: ${p} (${e.message}) — resolve manually before touching this run`);
  }
  if (m === null || typeof m !== "object")
    throw new Error(`run manifest is corrupt and unreadable: ${p} — resolve manually before touching this run`);
  assertWorkTree("manifest", runId, m.repoPath);
  return m;
}
function saveRun(m) { writeJson(runManifest(m.runId), m); }

// apply-state.json is the SECOND receipt of "a patch is in the user's tree", and the only one that
// is written before the tree is touched (see applyVerifiedWinner). manifest.json is rewritten after
// the mutation through persistRun, which deliberately swallows write failures — so when that rewrite
// is the one that fails (ENOSPC, this box's Windows EPERM on rename-while-open, manifest.json turned
// into a directory) the manifest is stale, missing or unreadable while the patch is live, and
// rollback must still have an entry point. null = no record (nothing was applied, or it rolled back).
function applyStatePath(runId) { return path.join(RUNS_DIR, runId, "apply-state.json"); }
function readApplyState(runId) {
  const p = applyStatePath(runId);
  let m;
  try { m = JSON.parse(fs.readFileSync(p, "utf8")); }
  catch (e) {
    if (e.code === "ENOENT") return null;
    throw new Error(`apply-state record is corrupt and unreadable: ${p} (${e.message}) — resolve manually before touching this run`);
  }
  // This read only ever authorises a destructive reverse apply, so it must name this run and carry
  // every field rollback needs. Anything else is treated as corrupt rather than "close enough":
  // authorising a revert from a guessed path is exactly the failure this file refuses elsewhere.
  if (m === null || typeof m !== "object" || m.runId !== runId
    || typeof m.repoPath !== "string" || typeof m.patchPath !== "string"
    || typeof m.patchSha256 !== "string") {
    throw new Error(`apply-state record is corrupt and unreadable: ${p} — expected {runId, repoPath, patchPath, patchSha256}`);
  }
  return m;
}

// The manifest is the receipt, never the operation. writeJson is unique-temp + rename, so a
// rename can still fail for real (ENOSPC, and this box has produced Windows EPERM on
// remove/rename-while-open): a raw saveRun() on a terminal path turns a good result into an error
// result and leaves the on-disk status lying. Worst of these is apply_verified_winner, where the
// patch is already in the user's tree — which is exactly why that path also lays down
// apply-state.json BEFORE it mutates (see applyStatePath), so a swallowed manifest write costs the
// host a stale status, never the undo entry point.
// These two record the failure in the run's existing internalErrors channel instead (buildReport
// prints it; runOutcome and the apply/rollback results surface it).
// Sites that deliberately keep a raw saveRun() are commented where they stand.
function persistRun(run) {
  try { saveRun(run); return true; }
  catch (e) { return disclose(run, "manifest not written", e); }
}
function persistReport(run) {
  try { saveReport(run); return true; }
  catch (e) { return disclose(run, "report not written", e); }
}
function disclose(run, what, e) {
  const msg = `${what}: ${String((e && e.message) || e)}`;
  const errs = (run.internalErrors ??= []);
  if (!errs.includes(msg)) errs.push(msg);   // a persistently unwritable manifest is one fact, not N
  return false;
}

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

// The ONLY place mcode argv is built, for both candidate and reviewer spawns. validateConfig()
// guards writes; a config.json hand-edited or written by an older engine version still reaches
// here, and on Windows the spawn runs with shell:true — so the allow-list is re-checked at use.
function modelFlag(model, what) {
  if (model === undefined || model === null || model === "") return [];
  if (!safeModel(model))
    throw new Error(`${what} ${JSON.stringify(model)} is not a permitted model identifier (allowed: [A-Za-z0-9._/-]) — refusing to spawn mcode`);
  return ["--model", model];
}

// On Windows the mcode spawn runs with shell:true, and Node then CONCATENATES [bin,...args] into
// one cmd.exe string without quoting each token (measured: `--cwd "C:\my project\..."` arrives at
// the child split into `C:\my` + `project\...`; a spaced bin path yields cmd's
// "'C:\...\with' is not recognized" and the child never starts). So quote any token that carries
// whitespace — unless it already carries a quote (the documented `node "<bin>"` form, where the
// operator took responsibility for the inner path).
const qWinArg = (a) => (IS_WIN && /\s/.test(a) && !a.includes('"') ? `"${a}"` : a);

async function execMcode(cwd, prompt, { timeoutMin, model, modelRole = "model", permission = "off", outputSchema, signal } = {}) {
  // prompt goes via stdin (--input -) so multi-line text survives the shell
  const args = ["exec", "--cwd", cwd, "--permission", permission,
    "--timeout", `${timeoutMin}m`, "--output-format", "json", "--input", "-",
    ...modelFlag(model, modelRole),
    ...(outputSchema ? ["--output-schema", outputSchema] : [])];
  const r = await shAsync(qWinArg(MCODE_BIN), IS_WIN ? args.map(qWinArg) : args, {
    shell: IS_WIN,
    input: prompt,
    timeout: timeoutMin * MIN + 30_000,
    signal,
    // Twin of src/core.ts:928, which hands the generator its allow-listed block plus the one
    // directory it needs (DSH_HOME): here that is this plugin's own data directory. Nothing else
    // the host exports — no API key, no token — reaches the candidate's own tool.
    env: { ...SPAWN_ENV, LLM_VERIFIER_DATA: DATA_DIR },
  });
  if (r.error) return { error: r.error, stderr: r.stderr };
  if (r.timedOut) return { timedOut: true, raw: r.stdout, stderr: r.stderr };
  let result = null;
  for (const line of (r.stdout || "").split("\n")) {
    const t = line.trim();
    if (t.startsWith("{") && t.includes('"exec.result"')) {
      try { result = JSON.parse(t); } catch {}
    }
  }
  return { result, raw: r.stdout, stderr: r.stderr };
}

async function runCandidate(run, cand, signal, abort) {
  const cfg = run.config;
  const remainingMin = Math.max(1, Math.floor((run.deadlineAt - Date.now()) / MIN));
  const res = await execMcode(cand.worktree, buildCandidatePrompt(cand.index, run.candidateCount, run.task), {
    timeoutMin: Math.min(cfg.candidateTimeoutMin, remainingMin),
    model: cfg.candidateModel || undefined,
    modelRole: "candidateModel",
    signal,
  });
  cand.sessionId = res.result?.sessionId || null;
  cand.usage = res.result?.usage || null;
  // Computed AFTER the await: shAsync's abort arm kills the child's tree and records nothing, so a
  // spawn the run itself aborted comes back with no error, no timedOut and no parsed result. Only
  // that case counts — a call that got a real answer keeps its own verdict.
  const killed = res.result ? null : abort?.();
  if (res.error) {
    cand.generation = { status: "error", detail: res.error, stderr: (res.stderr || "").slice(0, 600) };
  } else if (res.timedOut) {
    cand.generation = { status: "timeout" };
  } else if (res.result && res.result.status === "succeeded") {
    cand.generation = { status: "succeeded" };
  } else if (killed) {
    cand.generation = { status: killed.status, abortedBy: killed.cause };
  } else {
    cand.generation = { status: res.result?.status || "failed", detail: tail(res.result?.output || res.raw, 500), stderr: (res.stderr || "").slice(0, 600) };
  }
  return cand;
}

async function runValidation(cand, command, { timeoutMs, signal, abort } = {}) {
  // shell:true lets Node build the platform invocation (cmd /d /s /c "<cmd>" on Windows,
  // /bin/sh -c on POSIX). Hand-spawning ["cmd","/c",command] instead makes cmd.exe exit 0
  // in ~100 ms WITHOUT running anything whenever the command contains quotes — every
  // validationCommand would be a silent no-op pass.
  const r = await shAsync(command, [], { cwd: cand.worktree, timeout: timeoutMs, shell: true, signal });
  const passed = r.status === 0;
  cand.validation = {
    command, status: passed ? "passed" : "failed",
    exitCode: r.status, timedOut: r.timedOut || undefined,
    output: tail((r.stdout || "") + (r.stderr || "") + (r.error ? `\nspawn error: ${r.error}` : "")),
  };
  // A validation the run killed did not fail, it was never allowed to finish — same rule as the
  // `cancelled` status apply_verified_winner already gives its own revalidation.
  const killed = passed ? null : abort?.();
  if (killed) { cand.validation.status = killed.status; cand.validation.abortedBy = killed.cause; }
  return passed;
}

// Per-file summary derived from the captured patch — saves a second git spawn.
// Display-only (manifest diffStat), so a lossy utf8 read of a binary capture is fine here.
function patchStat(patch) {
  const patchText = Buffer.isBuffer(patch) ? patch.toString("utf8") : patch;
  const files = patchText.split(/^diff --git /m).slice(1);
  return files.map((f) => {
    const name = f.slice(0, f.indexOf("\n")).split(" b/").pop();
    const add = (f.match(/^\+(?!\+\+).*\r?$/gm) || []).length;
    const del = (f.match(/^-(?!---).*\r?$/gm) || []).length;
    return `${name} | +${add} -${del}`;
  }).join("\n") || "(no diff)";
}

function buildReport(run) {
  const L = [];
  L.push(`# LLM Verifier report — run ${run.runId}`);
  L.push(`- Status: \`${run.status}\``);
  L.push(`- Task: ${run.task}`);
  L.push(`- Repository: ${run.repoPath}`);
  if (run.baseCommit) L.push(`- Base commit: \`${run.baseCommit}\``);
  L.push(`- Review mode: \`${run.config.reviewMode}\``);
  L.push(`- Candidates: ${run.candidateCount} (concurrency ${run.config.maxConcurrent})`);
  // the harness breaking must not be printed as "the model produced nothing"
  for (const e of run.internalErrors || []) L.push(`- Internal verifier failure: ${e}`);
  // A patch that silently omits the dependency tree is reviewable; one that silently
  // *includes* it is not. Scope is stated because `core.excludesFile` only reaches
  // untracked paths: a repo that commits node_modules can still ship dependency edits.
  L.push(`- Dependency exclusion: untracked \`node_modules/\` is dropped via the harness \`core.excludesFile\`; dependencies the repository itself tracks still appear in a patch`);
  for (const c of run.candidates) {
    L.push("");
    L.push(`## ${c.candidateId}`);
    L.push(`- Generation: \`${c.generation?.status}\`${c.sessionId ? ` (session ${c.sessionId})` : ""}`);
    // A broken harness (a spaced binary path that never launches, a missing toolchain) fails
    // generation with the real cause buried in candidates[].generation.stderr. Without printing
    // it the report says only "failed" and the host reads an infrastructure failure as the model
    // being unable — the same "an observation must not become a verdict" line as patch capture.
    // tail() bounds it the way every other captured field is bounded.
    if ((c.generation?.status === "failed" || c.generation?.status === "error") && c.generation.stderr) {
      L.push(`- Generation stderr:\n\n\`\`\`\n${tail(c.generation.stderr, 800)}\n\`\`\``);
    }
    // `failed` with an empty detail is what a kill by the run's own abort used to look like, and the
    // host reads that as "the model produced nothing". Say which of the two it was.
    if (c.generation?.abortedBy)
      L.push(`- Generation ended because the verifier aborted it (${c.generation.abortedBy}), not because the model failed`);
    L.push(`- Validation: \`${c.validation?.status}\` via \`${c.validation?.command}\``);
    if (c.validation?.abortedBy)
      L.push(`- Validation ended because the verifier aborted it (${c.validation.abortedBy}); its result is not a verdict on the candidate`);
    if (c.validation?.installError) {
      L.push(`- Validation blocked before it ran: \`${c.validation.installCommand}\` failed in the worktree (exit ${c.validation.exitCode}); the candidate was never validated`);
    }
    // Status: no_winner with no reason printed reads as "the model failed", not "capture broke".
    if (c.patchError) L.push(`- Patch capture: \`${c.patchError}\``);
    // The install output is not validation output: labelling it "Validation tail" makes
    // a registry failure read as a failing test run.
    if (c.validation?.output) L.push(`- ${c.validation.installError ? "Install output" : "Validation tail"}:\n\n\`\`\`\n${c.validation.output}\n\`\`\``);
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
  if (run.cleanupWarnings?.length) {
    L.push("");
    L.push(`## Cleanup`);
    for (const w of run.cleanupWarnings) L.push(`- ${w}`);
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

async function cleanupWorktrees(run) {
  const warnings = (run.cleanupWarnings ??= []);
  // A spawn killed by its own timer writes no stderr and no error, which would leave the warning
  // reading "…exit null" with no cause; gitWhy's rule again — an observation must name itself.
  const whyExit = (r) => {
    const w = r.stderr?.trim() || r.error?.message || (r.timedOut ? `timed out after ${GIT_TIMEOUT_MS}ms` : "");
    return w ? `: ${w}` : "";
  };
  const root = path.join(RUNS_DIR, run.runId, "worktrees");
  const prefix = `llm-verifier/${run.runId}/`;
  // What this run still owns, keyed canonically so the two sources cannot double-count: the
  // candidates the pool recorded, PLUS every tree git still has registered under this run's own
  // worktrees/ root. `git worktree add -b` registers the worktree and creates the branch BEFORE it
  // finishes (measured on git 2.55: a post-checkout hook exiting 7 leaves add exit 7 with the tree
  // registered, the branch alive and `worktree prune` powerless, because the directory is there).
  // Candidate k of a run that dies on that failure never reaches run.candidates, so without this
  // sweep its pair has no owner and leaks into the user's repository for good.
  const owned = new Map();
  for (const c of run.candidates) owned.set(normPath(c.worktree), { wt: c.worktree, candId: c.candidateId });
  const ls = await gitAsync(run.repoPath, ["worktree", "list", "--porcelain"]);
  const rootN = normPath(root);
  if (ls.status !== 0) {
    warnings.push(`git worktree list exit ${ls.status}${whyExit(ls)} — this run's leftover worktrees under ${root} may remain`);
  } else {
    for (const line of (ls.stdout || "").split(/\r?\n/)) {
      if (!line.startsWith("worktree ")) continue;
      const printed = line.slice("worktree ".length).trim();
      const n = normPath(printed);
      // Containment first: a path outside this run's own worktrees/ root is somebody else's.
      if (n === rootN || !n.startsWith(rootN + path.sep)) continue;
      const candId = path.basename(printed);
      const wt = path.join(root, candId);          // the spelling `add` was handed, not git's
      if (owned.has(n) || normPath(wt) !== n) continue;
      owned.set(n, { wt, candId });
    }
  }
  let leaked = false;
  const keepBranch = new Set();
  for (const { wt, candId } of owned.values()) {
    const branch = `${prefix}${candId}`;
    // The second --force reaches one state in particular (src/git.ts:229-242): a killed
    // `git worktree add` leaves the registration `locked initializing`, and git refuses a
    // single-force removal of a locked worktree, so that run could never clean up. This engine
    // never locks a worktree, so nothing else can be force-removed that should not be.
    const rm = await gitAsync(run.repoPath, ["worktree", "remove", "--force", "--force", wt]);
    // A failed forced removal (measured: exit 255 / "Permission denied" when a process
    // holds its cwd inside the checkout) leaves the directory on disk *and* the worktree
    // registered. Nothing under that path may be deleted afterwards, and the branch has
    // to stay: half-removing a tree makes it neither prunable nor re-removable, and the
    // warning would then describe a leak it already destroyed.
    if (rm.status !== 0) {
      warnings.push(`worktree left behind: ${wt} and branch ${branch} ` +
        `(git worktree remove exit ${rm.status}${whyExit(rm)})`);
      leaked = true;
      keepBranch.add(candId);
      continue;
    }
    const bd = await gitAsync(run.repoPath, ["branch", "-D", branch]);
    if (bd.status !== 0) {
      warnings.push(`branch left behind: ${branch} (git branch -D exit ${bd.status}${whyExit(bd)})`);
    }
  }
  const prune = await gitAsync(run.repoPath, ["worktree", "prune"]);
  if (prune.status !== 0) {
    warnings.push(`git worktree prune exit ${prune.status}${whyExit(prune)}`);
  }
  // The branches this run created for a worktree that no longer (or never) registered — the other
  // half of a dying `add`, and the one prune cannot reach. Deleting a branch the plugin made is in
  // scope; deleting one the user made is not, so containment is asserted twice over: the pattern is
  // already scoped to this run's prefix and a ref outside it is refused. A ref whose worktree
  // survived the loop above is left alone, exactly as that loop leaves it.
  const refPrefix = `refs/heads/${prefix}`;
  const refs = await gitAsync(run.repoPath, ["for-each-ref", "--format=%(refname)", refPrefix]);
  if (refs.status !== 0) {
    warnings.push(`git for-each-ref exit ${refs.status}${whyExit(refs)} — this run's leftover ${prefix}* branches may remain`);
  } else for (const ref of (refs.stdout || "").split(/\r?\n/).filter(Boolean)) {
    const candId = ref.startsWith(refPrefix) ? ref.slice(refPrefix.length) : "";
    if (!candId || candId.includes("/") || keepBranch.has(candId)) continue;
    const branch = `${prefix}${candId}`;
    const bd = await gitAsync(run.repoPath, ["branch", "-D", branch]);
    if (bd.status !== 0) warnings.push(`branch left behind: ${branch} (git branch -D exit ${bd.status}${whyExit(bd)})`);
  }
  if (leaked) {
    warnings.push(`worktree root kept for inspection: ${root}`);
    return;
  }
  // Work bounded in one sentence: every spawn above is one of ~15 (2 reads + ≤2 per owned tree + ≤1
  // per ref under this run's own prefix, and only this run ever writes there), each carrying
  // GIT_TIMEOUT_MS, and all of them are awaited — so the worst case is serial timeouts on a free
  // event loop (ping answered, shutdown drain firing), not a frozen server. The recursive delete is
  // the one step that is not a spawn, hence its own wall-clock ceiling.
  try {
    await fs.promises.rm(root, { recursive: true, force: true, signal: AbortSignal.timeout(CLEANUP_RM_TIMEOUT_MS) });
  }
  catch (e) { warnings.push(`worktree root not removed: ${root} (${e instanceof Error ? e.message : String(e)})`); }
}

// Uniform response shape for every verified_best_of terminal status.
function runOutcome(run) {
  const winner = run.candidates.find((c) => c.candidateId === run.winnerId);
  const out = {
    status: run.status,
    runId: run.runId,
    winnerId: run.winnerId || null,
    selectionMethod: run.selectionMethod,
    winnerPatchPath: winner?.patchPath || null,
    reportPath: run.reportPath || null,
    manifestPath: runManifest(run.runId),
    baseCommit: run.baseCommit || null,
    candidates: run.candidates.map((c) => ({
      candidateId: c.candidateId,
      generation: c.generation?.status || null,
      validation: c.validation?.status || null,
      diffStat: c.diffStat || null,
      patchPath: c.patchPath || null,
    })),
    nextSteps: [],
  };
  if (run.status === "no_winner") {
    // The harness failing is not "the model produced nothing", and a host that cannot tell
    // the two apart will re-run the task against the same broken state.
    const blocked = run.candidates.filter((c) => c.validation?.installError);
    out.message = run.internalErrors?.length
      ? `Internal verifier failure: ${run.internalErrors.map((s) => tail(s, 300)).join(" | ")} — ` +
        `the run aborted its own candidate pool, so nothing was reviewed or selected`
      : blocked.length
      ? `no candidate was validated: dependency install failed in ${blocked.map((c) => c.candidateId).join(", ")} ` +
        `(see each candidate's validation.output) — the repository's dependencies could not be installed in the worktree`
      : "no candidate completed generation with passing validation";
  }
  else if (run.status === "timeout")
    out.message = `run deadline (totalTimeoutMin ${run.config.totalTimeoutMin}) exceeded; nothing was reviewed or selected`;
  else if (run.status === "review_pending") out.nextSteps = [
    `Read ${run.reportPath} and each candidate patch (candidate-N.patch in the run dir).`,
    "Call select_verified_candidate with your choice, then apply_verified_winner.",
  ];
  else if (run.status === "winner_selected") out.nextSteps = [`call apply_verified_winner {runId:"${run.runId}"}`];
  return out;
}

async function runVerifiedBestOf(args, cfg, signal) {
  const intArg = (v, name, dflt) => {
    if (v === undefined) return dflt;
    if (!Number.isInteger(v) || v < 1 || v > 5)
      throw new Error(`${name} must be an integer 1-5, got ${JSON.stringify(v)}`);
    return v;
  };
  if (args === null || typeof args !== "object") throw new Error("arguments must be an object");
  if (typeof args.repoPath !== "string" || !args.repoPath) throw new Error("repoPath (absolute path) is required");
  if (typeof args.task !== "string" || !args.task.trim()) throw new Error("task (non-empty string) is required");
  const count = intArg(args.candidateCount, "candidateCount", cfg.defaultCandidateCount);
  const concurrent = intArg(args.maxConcurrent, "maxConcurrent", cfg.maxConcurrent);
  if (args.validationCommand !== undefined &&
      (typeof args.validationCommand !== "string" || args.validationCommand.length > 1000))
    throw new Error("validationCommand must be a string of at most 1000 chars");
  if (args.reviewMode !== undefined && !["parent_agent", "mcode_model"].includes(args.reviewMode))
    throw new Error('reviewMode must be "parent_agent" or "mcode_model"');
  if (args.baseBranch !== undefined &&
      (typeof args.baseBranch !== "string" || !args.baseBranch || args.baseBranch.startsWith("-")))
    throw new Error("baseBranch must be a non-empty git ref that does not start with '-'");
  // A hand-edited config.json skips validateConfig, and these identifiers reach an argv-built
  // shell spawn. Checked here, before the first candidate session: execMcode's own modelFlag
  // would throw from inside a worker, where the pool can only report it as an internal failure.
  modelFlag(cfg.candidateModel || "", "candidateModel");
  if ((args.reviewMode ?? cfg.reviewMode) === "mcode_model") modelFlag(cfg.reviewerModel || "", "reviewerModel");

  const repoPath = path.resolve(args.repoPath);
  if (!gitOk(repoPath, ["rev-parse", "--is-inside-work-tree"]))
    throw new Error(`repoPath is not a git work tree: ${repoPath}`);
  // A SUBDIRECTORY passes the check above and then silently breaks the landing step: `git apply`
  // with cwd inside a subdir prints "Skipped patch '<path>'" and EXITS 0 having touched nothing
  // (measured, git 2.55.0.windows.5 — docs/proof/tools/probe-git-apply-subdir-924.mjs), so
  // apply_verified_winner would report `applied` over an unchanged tree. Same gate as
  // src/git.ts inspectRepository: the path must BE the top level. Both sides canonPath'd, because
  // git answers `--show-toplevel` with forward slashes and 8.3 segments are normal here.
  const top = git(repoPath, ["rev-parse", "--show-toplevel"]);
  const rootPath = top.stdout ? canonPath(top.stdout) : "";
  if (top.status !== 0 || !rootPath)
    throw new Error(`cannot read the repository root of ${repoPath}: ${gitWhy(top)}`);
  if (canonPath(repoPath) !== rootPath)
    throw new Error(`repoPath must be the Git repository root: got ${canonPath(repoPath)}, root is ${rootPath}`);
  const dirty = git(repoPath, ["status", "--porcelain"]);
  // An empty --porcelain read is ambiguous: a clean repo prints "", but so does a call killed
  // before the first line (status:null/SIGTERM, ETIMEDOUT) or a maxBuffer overrun (ENOBUFS, stdout
  // truncated). Treating "no output" as "verified clean" let a failed read write the winner into
  // the user's uncommitted work. Refuse until the read itself succeeded, THEN let emptiness mean
  // clean. gitWhy already names the reason (error.message / stderr / exit code).
  if (dirty.error || dirty.status !== 0)
    throw new Error(`cannot read working-tree state: ${gitWhy(dirty)}`);
  if (dirty.stdout.trim() !== "")
    throw new Error("repository has uncommitted changes; commit or stash them before running best-of");
  const head = git(repoPath, ["rev-parse", "HEAD"]);
  if (head.status !== 0) throw new Error(`cannot read HEAD of ${repoPath} (empty repository?): ${tail(gitWhy(head), 300)}`);

  const runId = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14) + "-" + crypto.randomBytes(3).toString("hex");
  // Only `validateConfig`'s own path is checked: a hand-edited or older-version config.json lands
  // here raw, and three of these four knobs go straight into arithmetic. Clamp once, at the
  // snapshot, so every reader (deadlineAt, --timeout Nm, per-step budgets) sees a finite integer
  // inside the ceiling instead of a NaN that disables the timer.
  const tcfg = {
    ...cfg,
    totalTimeoutMin: minutesIn(cfg.totalTimeoutMin, DEFAULTS.totalTimeoutMin),
    candidateTimeoutMin: minutesIn(cfg.candidateTimeoutMin, DEFAULTS.candidateTimeoutMin),
    reviewTimeoutMin: minutesIn(cfg.reviewTimeoutMin, DEFAULTS.reviewTimeoutMin),
    validationTimeoutMin: minutesIn(cfg.validationTimeoutMin, DEFAULTS.validationTimeoutMin),
  };
  const run = {
    schemaVersion: 1,
    runId, task: String(args.task), repoPath,
    baseCommit: head.stdout.trim(),
    deadlineAt: Date.now() + Math.min(tcfg.totalTimeoutMin * MIN, MAX_TIMER_MS),
    status: "running", createdAt: nowIso(),
    candidateCount: count,
    config: {
      ...tcfg,
      maxConcurrent: concurrent,
      validationCommand: args.validationCommand ?? cfg.validationCommand,
      reviewMode: args.reviewMode ?? cfg.reviewMode,
    },
    candidates: [], winnerId: null, selection: null, review: null, selectionMethod: "none",
  };
  const runDir = path.join(RUNS_DIR, runId);
  const wtRoot = path.join(runDir, "worktrees");
  fs.mkdirSync(wtRoot, { recursive: true });
  const baseArgs = args.baseBranch ? [args.baseBranch] : ["HEAD"];
  // ONE deadline for the whole run: every phase spawns with runSignal, so generation,
  // validation and review all die at deadlineAt instead of each trusting its own timer.
  const deadline = new AbortController();
  // deadlineAt is already clamped above, so every `deadlineAt - Date.now()` timer downstream
  // (install, validation, capture, review) stays under Node's setTimeout ceiling as well.
  const deadlineTimer = setTimeout(() => deadline.abort(),
    Math.max(1, Math.min(run.deadlineAt - Date.now(), MAX_TIMER_MS)));
  const runSignal = AbortSignal.any([signal, deadline.signal].filter(Boolean));
  // a manifest that cannot be written must not turn a disclosed failure into a crash: every
  // terminal write below goes through persistRun/persistReport (see their definition).
  // Every phase boundary that can still be cancelled lands here: notifications/cancelled must end
  // on the status that names it, never on the status the interrupted phase would have reached.
  const abortIfCancelled = () => {
    if (!signal?.aborted) return;
    run.status = "cancelled";
    persistRun(run); persistReport(run);
    throw new Error(`run ${runId} cancelled by host`);
  };
  // Which of the run's own aborts ended a step, for the candidate record (see runCandidate).
  // deadline.signal is ALSO the "a worker threw, stop the siblings" lever, so the clock is only
  // blamed when it actually ran out; a worker-failure kill keeps its old shape, where
  // `Internal verifier failure` already carries the real cause at the top of the report.
  const stepAbort = () => signal?.aborted
    ? { status: "cancelled", cause: "cancelled by host" }
    : deadline.signal.aborted && Date.now() >= run.deadlineAt
      ? { status: "timeout", cause: "run deadline exceeded" } : null;
  try {
    for (let i = 1; i <= count; i++) {
      const candId = `candidate-${i}`;
      const wt = path.join(wtRoot, candId);
      const r = git(repoPath, ["worktree", "add", "-b", `llm-verifier/${runId}/${candId}`, wt, ...baseArgs]);
      if (r.status !== 0) throw new Error(`worktree add failed for ${candId}: ${tail(gitWhy(r), 400)}`);
      run.candidates.push({ candidateId: candId, index: i, worktree: wt, generation: null, validation: null, review: null });
    }
    // Deliberately raw: with no manifest on disk at all, no later turn can name this run, so an
    // unwritable first receipt is a precondition failure — abort before spending a model session.
    // The throw still lands in the catch below (status + report) and the finally still reaps every
    // worktree/branch, including candidate k's half-added pair (cleanupWorktrees sweeps by
    // containment, so a pair this loop never recorded has an owner).
    saveRun(run);

    // generate + validate with concurrency limit and run-level deadline
    const queue = [...run.candidates];
    const workers = Array.from({ length: Math.min(run.config.maxConcurrent, queue.length) }, async () => {
      while (queue.length) {
        const cand = queue.shift();
        if (runSignal.aborted) {
          cand.generation = { status: "timeout", detail: "run deadline exceeded before generation started" };
          cand.validation = { status: "skipped" };
          continue;
        }
        await runCandidate(run, cand, runSignal, stepAbort);
        const cmd = run.config.validationCommand || detectValidation(cand.worktree) || "node --test";
        // Only an npm/pnpm/yarn validation can be starved by a missing node_modules;
        // installing for `node --test` would burn the deadline on the registry.
        const setup = /\b(?:npm|pnpm|yarn)\b/.test(cmd) ? dependencyInstall(cand.worktree) : "";
        if (setup && !runSignal.aborted) {
          const s = await shAsync(setup, [], {
            cwd: cand.worktree, shell: true, signal: runSignal,
            timeout: Math.max(1000, Math.min(10 * MIN, run.deadlineAt - Date.now())),
          });
          if (s.status !== 0) {
            // Not the candidate's fault, but an unvalidated candidate must never be
            // a winner: report it as a failed validation and keep the reason.
            cand.validation = {
              // `command` stays the validation command: apply_verified_winner
              // re-runs exactly that field in the user's repository, and an
              // installer must never be what it trusts.
              command: cmd, installCommand: setup,
              status: "failed", exitCode: s.status, installError: true,
              timedOut: s.timedOut || undefined,
              output: tail(`${(s.stdout || "") + (s.stderr || "") + (s.error ? `\nspawn error: ${s.error}` : "")}`),
            };
            // Deliberately raw (same at the per-candidate checkpoint below): these two are progress
            // writes *inside a worker*, where a throw is the mechanism that aborts the run and
            // reaps its siblings; a manifest that cannot take a progress record means the receipt
            // can no longer be trusted, which is an abort condition, not a disclosure.
            saveRun(run);
            continue;
          }
        }
        await runValidation(cand, cmd, {
          timeoutMs: Math.max(1000, Math.min(minutesToTimeoutMs(run.config.validationTimeoutMin),
            run.deadlineAt - Date.now())),
          signal: runSignal,
          abort: stepAbort,
        });
        // deliberately raw — progress write inside a worker, see the note at the install checkpoint
        saveRun(run);
      }
    });
    // Promise.all used to return on the first rejection while siblings kept spawning into a
    // run nobody awaited, whose worktrees the finally block then force-removed.
    workers.forEach((w) => w.catch(() => deadline.abort()));
    const settled = await Promise.allSettled(workers);
    const rejected = settled.filter((s) => s.status === "rejected");
    if (rejected.length)
      run.internalErrors = rejected.map((s) => String((s.reason && s.reason.message) || s.reason));

    // freeze diffs before any review/decision reads them. Async like every other phase:
    // a sync spawnSync here froze the event loop for 33s on a 6000-file worktree, so
    // neither the run deadline nor notifications/cancelled could be honoured while it ran.
    const harnessExcludes = path.join(runDir, "harness.gitignore");
    fs.writeFileSync(harnessExcludes, "node_modules/\n");
    for (const c of run.candidates) {
      const wt = c.worktree;
      // Don't spawn a git we are about to kill: a SIGKILLed `git add` can leave index.lock
      // behind, and a locked worktree is then harder for cleanupWorktrees to take away.
      if (runSignal.aborted) {
        c.diffStat = "(diff capture failed)";
        c.patchError = "diff capture failed: run aborted before capture";
        continue;
      }
      const capTimeout = Math.max(1000, run.deadlineAt - Date.now());
      // Unstage first: core.excludesFile only keeps *untracked* paths out, so a
      // candidate that staged its own node_modules would still get it into
      // `diff --cached`, which reads the index and ignores every exclude rule.
      const reset = await shAsync("git", ["reset", "--quiet"], { cwd: wt, timeout: capTimeout, signal: runSignal });
      // `-c` on argv, not GIT_CONFIG_*: git-for-windows reads getenv through the CRT's
      // ANSI code page, so a non-ASCII profile path (C:\Users\张三) would silently drop
      // the exclusion, and GIT_CONFIG_COUNT is a namespace the host may already use.
      const add = await shAsync("git", ["-c", `core.excludesFile=${harnessExcludes}`, "add", "-A"],
        { cwd: wt, timeout: capTimeout, signal: runSignal });
      // A failed add leaves a half-staged index, and `git diff --cached` then exits 0
      // with a truncated patch that looks like a normal small change. Only the diff's
      // own status was ever checked, so a silently clipped patch could win and be applied.
      const failedStep = reset.error || reset.status !== 0 ? "reset"
        : add.error || add.status !== 0 ? "add" : null;
      if (failedStep !== null) {
        const why = failedStep === "reset" ? reset : add;
        c.diffStat = "(diff capture failed)";
        c.patchError = `diff capture failed: git ${failedStep} ` +
          `${why.error ?? `exited ${why.status} ${tail(why.stderr || "", 160)}`.trim()}`;
        continue;
      }
      const p = await shAsync("git", ["diff", "--cached", "--binary"],
        { cwd: wt, timeout: capTimeout, signal: runSignal, maxStdout: MAX_PATCH, binary: true });
      c.patchPath = path.join(runDir, `${c.candidateId}.patch`);
      fs.writeFileSync(c.patchPath, p.status === 0 ? p.stdout : "");
      c.patchSha256 = sha256File(c.patchPath);
      c.diffStat = p.status === 0 ? patchStat(p.stdout) : "(diff capture failed)";
      // A failed, killed, capped or empty capture is never a "valid empty patch": an
      // uncaught maxBuffer overflow used to hand back 0 bytes and still call the
      // candidate validated.
      c.patchError = p.error ? `diff capture failed: ${p.error}`
        : p.stdoutTruncated ? `diff capture failed: patch exceeds ${MAX_PATCH} bytes (truncated)`
        : p.status !== 0 ? `diff capture failed: git diff exited ${p.status} ${tail(p.stderr, 200)}`
        : p.stdout.length === 0 ? "candidate produced no diff" : null;
    }
    persistRun(run);
    abortIfCancelled();
    // before the deadline branch: the pool aborts that deadline on purpose, and "timeout" would blame the candidates
    if (run.internalErrors?.length) {
      run.status = "no_winner";
      persistRun(run); persistReport(run);
      return runOutcome(run);
    }
    const passed = run.candidates.filter((c) =>
      c.generation?.status === "succeeded" && c.validation?.status === "passed" && !c.patchError);
    if (deadline.signal.aborted && (passed.length === 0 || run.config.reviewMode === "mcode_model")) {
      // The deadline may veto only what it actually cost. Diff capture runs after the pool, one
      // spawn per candidate, so a deadline expiring midway used to throw away the candidates that
      // had already generated, validated and been captured: this branch returned before anything
      // was decided. A candidate the abort did skip carries a patchError and is out of `passed`,
      // so `passed.length === 0` is the honest "the deadline ate this run". A review-mode run is
      // vetoed whatever its survivor count — the mode test below precedes the single-survivor
      // branch, so even one survivor is decided BY the review, and a review cannot run on a spent
      // budget (it would spawn mcode, get its tree killed, retry once, and land in review_pending,
      // impersonating an abstention: see the note after the review call). So that case keeps
      // reporting timeout.
      run.status = "timeout";
      persistRun(run); persistReport(run);
      return runOutcome(run);
    }

    if (passed.length === 0) {
      run.status = "no_winner";
      persistRun(run); persistReport(run);
      return runOutcome(run);
    }

    if (run.config.reviewMode === "mcode_model") {
      const review = await reviewWithMcodeModel(run, passed, runSignal);
      // The review spawn carries runSignal, so this is the one phase boundary that used to have no
      // cancel check behind it: a cancelled review returned no verdict, fell through to
      // review_pending/"pending" and told the host to go select a candidate — indistinguishable
      // from a review that really ran and really abstained. Nothing of the killed review is kept.
      abortIfCancelled();
      run.review = review.receipt;
      if (review.selected) {
        run.winnerId = review.selected;
        run.selectionMethod = "model_review";
        run.status = "winner_selected";
      } else {
        // review produced no usable verdict — do NOT fabricate a winner
        run.status = "review_pending";
        run.selectionMethod = "pending";
      }
    } else if (passed.length === 1) {
      run.winnerId = passed[0].candidateId;
      run.selectionMethod = "single_survivor";
      run.status = "winner_selected";
    } else {
      run.status = "review_pending";
      run.selectionMethod = "pending";
    }
    persistRun(run); persistReport(run);
    return runOutcome(run);
  } catch (e) {
    // Without this the receipt of a crashed run stays "running" on disk forever — the finally
    // block only cleans worktrees (and would re-save the same "running"). Status is reused, not
    // invented, and only while it is still non-terminal: "cancelled" already says what happened.
    if (run.status === "running") {
      (run.internalErrors ??= []).push(`internal verifier failure: ${String((e && e.message) || e)}`);
      run.status = "no_winner";
      persistReport(run);
      persistRun(run);
    }
    throw e;   // the host must still see the failure as an error result
  } finally {
    clearTimeout(deadlineTimer);
    // awaited, and this is the only thing that makes it so: the function body already did
    // `return runOutcome(run)`, so an unawaited call here posts the response while the cleanup is
    // still mid-spawn and the leak it exists to prevent comes back. S7/S8's
    // `worktrees(r) === 1` / `leakyBranches(r) === ""` are the checks that go red on that.
    await cleanupWorktrees(run);   // every exit path, including a throw after capture
    if (run.cleanupWarnings) {
      // `return runOutcome(run)` already ran, so cleanup can only be disclosed on the
      // stderr log and by rewriting the on-disk receipt. The rewrite also happens when
      // the list is empty: `cleanupWarnings: []` is the only durable proof that cleanup
      // ran *and* found nothing, which is otherwise indistinguishable from a build that
      // never had the check.
      for (const w of run.cleanupWarnings) console.error(`[llm-verifier] ${w}`);
      try { saveRun(run); saveReport(run); }
      catch (e) { console.error(`[llm-verifier] cleanup receipt not written: ${e instanceof Error ? e.message : String(e)}`); }
    }
  }
}

async function reviewWithMcodeModel(run, passed, signal) {
  const cfg = run.config;
  const timeoutMin = Math.max(1, Math.min(cfg.reviewTimeoutMin, Math.floor((run.deadlineAt - Date.now()) / MIN)));
  // The 8000-char cap stays, but the read no longer decodes the whole patch to take the first 8000
  // characters of it (a candidate patch can be up to MAX_PATCH), and an incomplete input must not
  // look like a complete one — the reviewer is told what it did not see, same rule as :148-149.
  const diffs = passed.map((c) => {
    const { text, over } = readCapped(c.patchPath, 8000);
    return `### ${c.candidateId}\n\`\`\`diff\n${text}${over ? `\n[patch truncated at 8000 characters — this is NOT the whole change]` : ""}\n\`\`\``;
  }).join("\n\n");
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

  const execReview = (useSchema, p) => execMcode(run.repoPath, p, {
    timeoutMin, model: cfg.reviewerModel || undefined, modelRole: "reviewerModel",
    outputSchema: useSchema ? schemaPath : undefined, signal,
  });
  const parseSchemaJson = (s) => {
    if (!s) return {};
    try { return JSON.parse(s); } catch {}
    const m = s.match(/\{[\s\S]*"scores"[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch {} }
    try { return JSON.parse(s.slice(s.indexOf("{"), s.lastIndexOf("}") + 1)); } catch {}
    return {};
  };
  const started = Date.now();
  let res = await execReview(true, prompt);
  let parsed = parseSchemaJson(res.result?.output);
  if (!Array.isArray(parsed.scores) || parsed.scores.length === 0) {
    res = await execReview(false, lenientPrompt);   // schema path failed → bare-JSON retry
    parsed = parseSchemaJson(res.result?.output);
  }
  const durationMs = Date.now() - started;
  const scores = Array.isArray(parsed.scores) ? parsed.scores : [];
  const valid = new Set(passed.map((c) => c.candidateId));
  const ranked = scores.filter((s) => s && typeof s.candidateId === "string" && valid.has(s.candidateId));
  const scored = new Set(ranked.map((s) => s.candidateId));
  // A score that is not a finite number is not a score: the review schema demands 0-100 integers,
  // and a NaN in the comparator below makes every comparison false, which silently reorders the
  // ranking. Only entries with a usable score take part in it.
  const usable = (s) => typeof s.score === "number" && Number.isFinite(s.score);
  const top = ranked.filter(usable).sort((a, b) => b.score - a.score)[0];
  // Honour the reviewer's own selection; the score order is advisory only (recorded below).
  // Substituting top-ranked while still labelling the outcome "model_review" would attribute
  // a verdict to the reviewer that it never made — so either accept its pick or return no pick.
  const selected = ranked.length > 0 && typeof parsed.selected === "string" && scored.has(parsed.selected)
    ? parsed.selected : null;
  for (const c of passed) {
    // No entry, or an entry the reviewer never scored, leaves `review` unset: buildReport guards on
    // it, and `score: 0` there used to make "said nothing" indistinguishable from "judged worthless"
    // (src/reviewer.ts:199-205 refuses such a review outright; this engine only declines to record it).
    const s = ranked.find((x) => x.candidateId === c.candidateId && usable(x));
    c.review = s ? { score: s.score, risks: s.risks || "" } : null;
  }
  return {
    selected,
    receipt: {
      provider: cfg.reviewerModel || "mcode-default",
      model: cfg.reviewerModel || res.result?.model?.modelId || "default",
      durationMs,
      scores: ranked,
      reviewerSelected: typeof parsed.selected === "string" ? parsed.selected : null,
      topRanked: top?.candidateId || null,
    },
  };
}

function selectVerifiedCandidate({ runId, candidateId, reason }) {
  const run = loadRun(runId);
  if (run.status !== "review_pending")
    throw new Error(`run ${runId} status is ${run.status}, expected review_pending`);
  const cand = run.candidates.find((c) => c.candidateId === candidateId);
  if (!cand) throw new Error(`unknown candidateId ${candidateId}; valid: ${run.candidates.map((c) => c.candidateId).join(", ")}`);
  if (cand.generation?.status !== "succeeded" || cand.validation?.status !== "passed" || cand.patchError)
    throw new Error(`${candidateId} did not complete generation with passing validation and a captured patch` +
      (cand.patchError ? ` (${cand.patchError})` : "") + "; refusing to select");
  run.winnerId = candidateId;
  run.selection = { candidateId, reason: reason || "", by: "parent_agent", at: nowIso() };
  run.selectionMethod = "parent_review";
  run.status = "winner_selected";
  // The manifest write is deliberately raw: a selection has no effect outside this file, so the
  // write IS the operation, and returning winner_selected over an unwritten manifest would leave the
  // disk on review_pending and make the next apply refuse for a reason the host was never told.
  // The report is the opposite — derived, and already on disk for every other path — so a failing
  // report write must not convert a completed selection into an error result: the retry would then
  // hit `status is winner_selected, expected review_pending` and the caller could never learn it had
  // actually succeeded. Report first, so a swallowed report failure is inside the manifest that
  // gets written after it.
  persistReport(run); saveRun(run);
  return { status: run.status, runId, winnerId: candidateId, selectionMethod: run.selectionMethod, patchPath: cand.patchPath, reportPath: run.reportPath || null, manifestPath: runManifest(runId), nextStep: `call apply_verified_winner {runId:"${runId}"}` };
}

function verifyPatchSha(patchPath, expected) {
  if (!expected) return;
  const actual = sha256File(patchPath);
  if (actual !== expected)
    throw new Error(`patch file changed on disk since capture (sha256 expected ${expected}, got ${actual}); refusing to touch it`);
}

// git apply --numstat -z: "add\tdel\tpath\0" records; rename/copy: "add\tdel\0old\0new\0".
function parseNumstatZ(out) {
  const fields = out.split("\0").filter((s) => s !== "");
  const files = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i].split("\t");
    if (f.length >= 3) files.push(f.slice(2).join("\t"));
    else if (f.length === 2) { files.push(fields[i + 2] ?? fields[i + 1]); i += 2; }
  }
  return files;
}

// The statuses apply_verified_winner accepts, spelled as a constant because it is also half of the
// rollback decision: a manifest whose post-apply rewrite never landed still names one of these.
const APPLY_ACCEPTS = ["winner_selected", "rolled_back"];

async function applyVerifiedWinner({ runId }, signal) {
  const run = loadRun(runId);
  if (!APPLY_ACCEPTS.includes(run.status))
    throw new Error(`run ${runId} status is ${run.status}, expected ${APPLY_ACCEPTS.join(" or ")} (rolled_back = re-apply)`);
  // The second receipt outranks the stale first one: a manifest whose terminal rewrite was swallowed
  // still says winner_selected while its patch is already in the tree, and applying again would put
  // the same patch in twice (or refuse on `git apply --check` for a reason that blames the patch).
  // A handle left behind by a rollback that could not delete it (this box has a recorded Windows EPERM
  // history, and the delete is best-effort by design) must not lock the documented rolled_back → apply
  // re-flow. The real "do not land the same patch twice" guard is the `git apply --check` below, which
  // reads the working tree instead of trusting a receipt — so dropping the receipt check here costs no
  // protection, and it also stops a corrupt handle from being read on a path where it cannot matter.
  if (run.status !== "rolled_back" && readApplyState(runId))
    throw new Error(`run ${runId} already has an applied patch in ${run.repoPath} (${applyStatePath(runId)}) — ` +
      `call rollback_verified_winner {runId:"${runId}"} first`);
  const cand = run.candidates.find((c) => c.candidateId === run.winnerId);
  // The apply route is handed the SAME record-supplied value the rollback route is, and passes it to
  // `git apply --check` / `apply` / `--numstat` in argv position. Guarding only the rollback left the
  // wider door open: a `-`-leading value is an OPTION to git, and any absolute path gets read with this
  // server's own permissions. `patch` is the realpath'd answer, so what is recorded and later reversed
  // is the file this check actually looked at.
  const patch = assertPatchPath(runId, cand?.patchPath);
  // Rebinding instead of threading `patch` through the six uses below (three `git apply` calls, the
  // handle, the hash read and the manifest) is the lazy choice on purpose: it is the one form that
  // cannot miss a call site, and it persists the path that was actually checked.
  cand.patchPath = patch;
  if (!fs.existsSync(patch)) throw new Error(`winner patch missing for ${run.winnerId}`);
  if (fs.statSync(patch).size === 0)
    throw new Error(`winner patch ${patch} is empty — an empty patch is a capture failure, not validated work; refusing to apply`);
  verifyPatchSha(patch, cand.patchSha256);
  if (run.baseCommit) {
    const head = git(run.repoPath, ["rev-parse", "HEAD"]);
    const now = head.stdout.trim();
    if (head.status !== 0 || now !== run.baseCommit)
      throw new Error(`repository HEAD moved since run creation (expected ${run.baseCommit}, got ${now}); refusing to apply`);
  }
  const dirty = git(run.repoPath, ["status", "--porcelain"]);
  // Same rule as best-of: a killed/failed status read yields empty stdout, and empty stdout must
  // not be read as "clean" before the patch lands on top of the user's uncommitted work.
  if (dirty.error || dirty.status !== 0)
    throw new Error(`cannot read working-tree state: ${gitWhy(dirty)}`);
  if (dirty.stdout.trim() !== "")
    throw new Error("refusing to apply to a dirty working tree; commit or stash local changes first");
  const check = git(run.repoPath, ["apply", "--check", "--whitespace=nowarn", cand.patchPath]);
  if (check.status !== 0)
    throw new Error(`patch does not apply cleanly to the repository:\n${tail(gitWhy(check), 800)}`);
  // Last safe point: after this the working tree is already modified.
  if (signal?.aborted) throw new Error(`apply of run ${runId} cancelled before the patch was applied; repository untouched`);
  // The rollback handle goes down BEFORE the tree is touched (TS does the same, src/core.ts
  // APPLY_STATE_FILE): everything after this point can fail in ways that leave the patch in the
  // user's files and the manifest never updated — persistRun swallows by design. Refuse to mutate at
  // all rather than risk that state, because an applied patch with no undo entry point is data loss.
  const statePath = applyStatePath(runId);
  try {
    writeJson(statePath, {
      schemaVersion: 1, runId, repoPath: run.repoPath, patchPath: cand.patchPath,
      // The recorded hash is always real: verifyPatchSha treats "no expectation" as "skip", and a
      // handle that cannot be verified is not a handle.
      patchSha256: cand.patchSha256 || sha256File(cand.patchPath),
      baseCommit: run.baseCommit || null, appliedAt: nowIso(),
    });
  } catch (e) {
    throw new Error(`apply of run ${runId} refused: the rollback handle ${statePath} could not be written ` +
      `(${String((e && e.message) || e)}); the repository was not touched`);
  }
  const apply = git(run.repoPath, ["apply", "--whitespace=nowarn", cand.patchPath]);
  if (apply.status !== 0) {
    // git apply is all-or-nothing (no --reject here), so a non-zero exit landed nothing: the handle
    // has to go, or a retry of this run would be blocked by its own failed attempt.
    try { fs.rmSync(statePath, { force: true }); } catch { /* keeping it is the safe direction */ }
    throw new Error(`git apply failed:\n${tail(gitWhy(apply), 800)}`);
  }
  run.appliedAt = nowIso();
  run.appliedPatchPath = cand.patchPath;
  run.appliedPatchSha256 = cand.patchSha256 || null;
  // The 1 MiB spawnSync default used to cut this list off mid-record on a large patch and
  // status was never checked, so a truncated receipt read as "these are the touched files".
  const num = git(run.repoPath, ["apply", "--numstat", "-z", cand.patchPath], { maxBuffer: MAX_CAPTURE });
  const numWhy = num.error?.message || (num.status === 0 ? null : `exited ${num.status}`);
  run.appliedFiles = numWhy ? null : parseNumstatZ(num.stdout || "");
  if (numWhy)
    (run.internalErrors ??= []).push(`appliedFiles unknown: git apply --numstat ${numWhy} ` +
      `— the patch landed, only its file list could not be read back`);
  const vcmd = cand.validation?.command;
  if (vcmd) {
    const probe = { worktree: run.repoPath };
    // The candidate phase's budget and this one are now the same configured number. What is NOT
    // clamped in here is run.deadlineAt: apply is its own tool call, and the deadline stored in
    // the manifest belongs to the candidate run, which is long past by the time a winner is
    // applied — clamping by it would cut every revalidation to the 1000 ms floor.
    await runValidation(probe, vcmd, {
      timeoutMs: minutesToTimeoutMs(run.config?.validationTimeoutMin), signal,
    });
    // A cancelled revalidation never finished: reporting it as "failed" would blame the
    // patch, and reporting "applied" would claim a check that never ran.
    if (signal?.aborted) probe.validation.status = "cancelled";
    run.appliedValidation = probe.validation;
  } else run.appliedValidation = null;
  // Persist the status we are about to return: a manifest/report still reading "applied"
  // while the response says applied_validation_failed is a state lie the next tool call trusts.
  const vs = run.appliedValidation?.status;
  run.status = vs === "cancelled" ? "applied_validation_cancelled"
    : vs === "failed" ? "applied_validation_failed" : "applied";
  // Deliberately non-throwing: the patch is already in the user's tree, so losing the receipt must
  // not cost the host the knowledge of what happened — the status it returns is the real one and
  // the write failure rides along in internalErrors (below), report.md and, if it recovers, the
  // next rewrite of this manifest. What it no longer costs is the undo: apply-state.json, written
  // before the mutation, is the authority rollback reads when this write is the one that failed.
  persistRun(run); persistReport(run);
  const out = {
    runId, status: run.status, appliedFiles: run.appliedFiles,
    validation: run.appliedValidation,
    manifestPath: runManifest(runId),
  };
  // The manifest may be exactly what failed, so the response is the disclosure's last channel.
  if (run.internalErrors?.length) out.internalErrors = run.internalErrors;
  if (run.status !== "applied") {
    out.message = "patch applied but the stored validation command did not confirm it in the " +
      "repository (" + run.status + "); call rollback_verified_winner to undo or fix forward";
  } else {
    out.rollback = `call rollback_verified_winner {runId:"${runId}"} if needed`;
  }
  return out;
}

// The manifest statuses that name "a patch is in the tree", so the only ones a readable manifest may
// be rolled back from. A prefix test on "applied" would silently make any future applied_* literal
// (in either implementation) rollback-eligible by construction. Name the set; refuse anything else.
// apply-state.json is the second, independent route — see rollbackVerifiedWinner.
const ROLLBACK_ELIGIBLE = ["applied", "applied_validation_failed", "applied_validation_cancelled"];

// The paths a git-generated patch touches, for the "did the new commits touch them?" question in
// rollbackVerifiedWinner. Both sides of every header are returned so a rename is matched on old and new
// name. Three states, same contract as src/core.ts: null = a header this cannot read (the caller must
// refuse), [] = the patch genuinely touches nothing, non-empty = the scope. They used to collapse into
// [], and that was the fail-OPEN direction: an under-reporting header shrinks the intersection and lets
// a rollback through that the TS layer refuses. git C-quotes an odd name and puts the quotes AROUND the
// `a/` prefix (measured on git 2.55: `diff --git "a/\344\270\255\346\226\207.py" "b/…"`), while
// `git diff --name-only -z` answers with the raw name — so an un-unquoted header can never intersect
// it, and every repo with a non-ASCII path would keep the refusal this guard exists to avoid.
// `unquoteGitPath` below is the TS twin mirrored. `patchTouchedFiles` differs in shape only because the
// engine has no patch text at that point (it takes a path), and its caller's union with
// `run.appliedFiles` mirrors src/core.ts's union with the record's changedFiles.
function unquoteGitPath(inner) {
  const bytes = [];
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (ch !== "\\") {
      // A quoted run is pure ASCII when git produced it, but `core.quotepath=false` is a LEGITIMATE
      // config and answers with raw bytes: silently keeping the low 8 bits of 中 would hand the caller
      // a wrong name, and a wrong name narrows the intersection that decides whether a rollback is
      // allowed. Wrong is worse than unknown, so this refuses instead.
      const code = ch.charCodeAt(0);
      if (ch === '"' || code > 0xff) return null;
      bytes.push(code);
      continue;
    }
    const esc = inner[i + 1];
    i += 1;
    if (esc === "t") bytes.push(9);
    else if (esc === "n") bytes.push(10);
    else if (esc === "r") bytes.push(13);
    else if (esc === "b") bytes.push(8);
    else if (esc === "f") bytes.push(12);
    else if (esc === '"' || esc === "\\") bytes.push(esc.charCodeAt(0));
    else if (esc !== undefined && esc >= "0" && esc <= "7") {
      // i already points at the first octal digit; 344 -> 0xE4, three bytes of one UTF-8 char
      const digits = /^[0-7]{1,3}/.exec(inner.slice(i))?.[0];
      if (digits === undefined) return null;
      i += digits.length - 1;
      // \400 is not a byte. Buffer.from masks it to 0x00, which is a WRONG name rather than an
      // unknown one — and a wrong name shrinks the intersection that gates this rollback.
      const value = parseInt(digits, 8);
      if (value > 0xff) return null;
      bytes.push(value);
    } else return null;
  }
  return Buffer.from(bytes).toString("utf8");
}

function patchTouchedFiles(patchPath) {
  let text;
  try { text = fs.readFileSync(patchPath, "utf8"); } catch { return null; }
  const heads = text.split("\n").filter((l) => l.startsWith("diff --git "));
  const out = new Set();
  for (const l of heads) {
    const rest = l.slice("diff --git ".length).trim();
    const m = /^(?:"(a\/[^"]*)"|(a\/\S+)) (?:"(b\/[^"]*)"|(b\/\S+))$/.exec(rest);
    if (!m) return null;
    const from = m[1] === undefined ? m[2] : unquoteGitPath(m[1]);
    const to = m[3] === undefined ? m[4] : unquoteGitPath(m[3]);
    if (from === null || to === null) return null;
    out.add(from.slice(2)); out.add(to.slice(2));
  }
  return heads.length ? [...out] : [];
}

function rollbackVerifiedWinner({ runId }) {
  assertRunId(runId);   // before any receipt path is built from it
  // Two receipts can prove a patch is in the tree, and they fail differently: the manifest is
  // rewritten AFTER the mutation through a swallow (so it can be stale, a directory, or gone), while
  // apply-state.json is written BEFORE it. Read both, then act on whichever says the patch landed.
  // The handle is the AUXILIARY receipt, so an unreadable one must not become a lock on the exit door:
  // "manifest clearly says applied + handle garbage" was rollback-eligible before apply-state existed
  // and still is. Degrade to "no handle" and disclose it. The apply path stays strict (readApplyState
  // throwing at :1334 is what stops a double apply), because there the handle is the thing refusing.
  let state = null;
  let stateError = null;
  try { state = readApplyState(runId); } catch (e) { stateError = e; }
  let run = null;
  let manifestError = null;
  try { run = loadRun(runId); } catch (e) { manifestError = e; }
  if (!run) {
    // With nothing readable in the manifest the handle is the only undo entry point left; without a
    // handle either, the manifest's own refusal is the right answer (a missing receipt is not a
    // licence to reverse-apply a guessed path).
    if (!state) throw stateError || manifestError;
    assertWorkTree("apply-state", runId, state.repoPath);
  } else if (!ROLLBACK_ELIGIBLE.includes(String(run.status))
    // A manifest still naming a status apply itself accepts is one whose post-apply rewrite never
    // landed — the handle is what makes that rollback-eligible instead of stranding the patch. Every
    // other status is still refused by name: the handle grants no licence for a hand-edited or
    // future applied_* literal.
    && !(state && APPLY_ACCEPTS.includes(String(run.status)))) {
    throw new Error(`run ${runId} status is ${run.status}, expected one of ${ROLLBACK_ELIGIBLE.join(" / ")}; refusing to roll back` +
      (stateError ? ` (the apply-state handle could not vouch for it either: ${stateError.message})` : ""));
  }
  const repoPath = run ? run.repoPath : state.repoPath;
  const patchPath = assertPatchPath(runId, state ? state.patchPath : run.appliedPatchPath);
  const patchSha = state ? state.patchSha256 : run.appliedPatchSha256;
  // A reverse apply reverts the WORKING TREE, so rolling back after the user committed the winner would
  // turn committed history into uncommitted deletions while the receipt claims the run was rolled back.
  // That is the only thing worth refusing. Comparing whole HEADs also refuses when HEAD moved because of
  // an unrelated commit — which strands a provably-safe rollback and tells the user to rewrite history
  // (S15). Scope the question to the paths this patch touches: if base..HEAD left them alone, the tree for
  // them is exactly what apply produced, and `-R --check` below still has to agree. Anything we cannot
  // parse falls back to the coarse refusal, so precision is only ever gained when we are sure.
  const baseCommit = (state && state.baseCommit) || (run && run.baseCommit) || null;
  // baseCommit reaches git as a positional rev below, so it has to be one: a
  // hand-edited run file must not deliver an option like `--output=…`. The ceiling is 64, not 40:
  // a repository initialised with --object-format=sha256 answers rev-parse with 64 hex chars, and
  // rejecting that here would strand the one tree whose apply provably worked.
  if (baseCommit !== null && !/^[0-9a-f]{7,64}$/iu.test(String(baseCommit)))
    throw new Error(`rollback refused: the run records base commit ${JSON.stringify(baseCommit)}, which is not a hex SHA`);
  if (baseCommit) {
    const head = git(repoPath, ["rev-parse", "HEAD"]);
    const now = head.stdout.trim();
    if (head.status === 0 && now === baseCommit) {
      // unchanged: nothing to decide
    } else if (head.status !== 0) {
      throw new Error(`rollback refused: HEAD is unreadable (${gitWhy(head)}) while run ${runId} was applied at ${baseCommit}`);
    } else {
      // Same three-state contract as src/core.ts: null = a header this cannot read (refuse), [] = the
      // patch genuinely touches nothing. They are not the same fact and collapsing them made the engine
      // narrower than the record on purpose while the TS layer unions the two sources — a header that
      // under-reports would let this route reverse-apply over committed work that TS refuses.
      const headerPaths = patchTouchedFiles(patchPath);
      const recorded = Array.isArray(run?.appliedFiles) ? run.appliedFiles : [];
      const scope = [...new Set(headerPaths === null ? recorded : [...recorded, ...headerPaths])];
      if (headerPaths === null || scope.length === 0) {
        throw new Error(`rollback refused: HEAD moved (${baseCommit} -> ${now}) and the recorded patch names no paths this check can trust; ` +
          `refusing rather than reversing over possibly-committed work`);
      }
      // One `-z` diff between the two revs, intersected in process: a pathspec list would grow with
      // the patch (Windows argv ceiling) and would quote unusual names back into something that never
      // matches the recorded path.
      const moved = git(repoPath, ["diff", "--name-only", "-z", baseCommit, "HEAD"]);
      if (moved.status !== 0) throw new Error(`rollback refused: cannot compare ${baseCommit}..HEAD for this patch (${gitWhy(moved)})`);
      const between = new Set(moved.stdout.split("\0").filter((l) => l !== ""));
      const hit = scope.filter((p) => between.has(p));
      if (hit.length) {
        throw new Error(`rollback refused: HEAD moved (${baseCommit} -> ${now}) and those commits touch the patched paths: ${hit.join(", ")}; ` +
          "rolling back would rewrite committed work — revert the commit that contains the patch instead");
      }
    }
  } else if (run) {
    // A build older than the baseCommit field wrote manifests without it. Refusing here strands a
    // rollback the user cannot otherwise take back, so the door stays open — but the absent guard is
    // disclosed, never silently skipped.
    disclose(run, "rollback has no recorded base commit; the reverse-apply check is the only HEAD guard",
      new Error(`baseCommit absent from both the apply-state record and the manifest of run ${runId}`));
  }
  verifyPatchSha(patchPath, patchSha);
  const check = git(repoPath, ["apply", "-R", "--check", "--whitespace=nowarn", patchPath]);
  if (check.status !== 0)
    throw new Error("rollback refused: repository files changed after apply (reverse patch does not apply cleanly). " +
      "Resolve local edits first, or reverse the patch manually:\n" + tail(gitWhy(check), 800));
  const r = git(repoPath, ["apply", "-R", "--whitespace=nowarn", patchPath]);
  if (r.status !== 0) throw new Error(`reverse apply failed:\n${tail(gitWhy(r), 800)}`);
  // `git apply` writes blob bytes. In a repo that normalises line endings (core.autocrlf is a Windows
  // default) the smudged form is what git expects on disk, so a perfectly successful reverse apply can
  // still leave " M <path>" behind while the content is the pre-patch text. Saying rolled_back over that
  // is a lie the user finds out about when the next apply refuses on "dirty working tree" (S16). Observe
  // it and disclose; an unreadable status is also disclosed, never read as clean.
  const after = git(repoPath, ["status", "--porcelain"]);
  let postRollbackNote = null;
  if (after.error || after.status !== 0) postRollbackNote = `post-rollback working-tree status unreadable: ${gitWhy(after)}`;
  else if (after.stdout.trim() !== "") postRollbackNote = `after rollback the working tree is not clean: ${tail(after.stdout, 400)}`;
  // The handle is spent now that the tree is back; leaving it would make this run's own next apply
  // refuse on its leftovers. A failed delete is the safe direction (it blocks a double-apply, and
  // rolling back twice refuses on the reverse-apply check above), so it is disclosed, never fatal.
  let leftoverNote = null;
  try { fs.rmSync(applyStatePath(runId), { force: true }); }
  catch (e) {
    if (run) disclose(run, "apply-state not removed", e);
    // No manifest means no internalErrors to append to — but the response itself is still a
    // channel, and dropping it here would leave the function's one quiet failure being the
    // receipt for its own leftovers.
    else leftoverNote = `apply-state not removed: ${e}`;
  }
  // The tree is back; now say that the rollback ran on one receipt instead of two. Before persistRun,
  // or the disclosure never reaches disk.
  if (stateError && run) disclose(run, "apply-state unreadable, rollback authorized by the manifest alone", stateError);
  if (!run) {
    // No manifest to carry anything, so the response is the only channel left. `stateError` cannot
    // be set on this branch (no run and no readable state throws above), so the two notes here are
    // the dirty tree and the leftover handle.
    const notes = [postRollbackNote, leftoverNote].filter((note) => note !== null);
    return notes.length ? { status: "rolled_back", runId, internalErrors: notes } : { status: "rolled_back", runId };
  }
  if (postRollbackNote) {
    const errs = (run.internalErrors ??= []);
    if (!errs.includes(postRollbackNote)) errs.push(postRollbackNote);
  }
  run.status = "rolled_back";
  run.rolledBackAt = nowIso();
  // Same as apply: the reverse patch has already landed, so an unwritable receipt is disclosed,
  // not thrown — a throw here hides a completed rollback and leaves the manifest saying "applied".
  persistRun(run); persistReport(run);
  const out = { status: run.status, runId };
  if (run.internalErrors?.length) out.internalErrors = run.internalErrors;
  return out;
}

async function configureTool(patch) {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch))
    throw new Error("verifier_configure arguments must be an object");
  const keys = Object.keys(patch);
  const errs = validateConfig(patch, new Set(keys));
  const unknown = keys.filter((k) => !(k in DEFAULTS));
  if (unknown.length) errs.push("unknown setting(s): " + unknown.join(", "));
  if (errs.length) throw new Error("invalid settings: " + errs.join("; "));
  // Read inside the queued turn: a snapshot taken before this call got its turn is the stale
  // one that loses the previous writer's field.
  const merged = { ...loadConfig(), ...patch };
  delete merged.configError;   // a fail-closed read must not be persisted into a healthy config
  await writeJsonAsync(CONFIG_PATH, merged);
  return { saved: true, config: merged, configPath: CONFIG_PATH };
}
