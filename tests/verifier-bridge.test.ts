import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const pythonExecutable = process.platform === "win32" ? "python" : "python3";
const scratchCachePath = join(tmpdir(), "verifier-test-cache.json");

async function runBridge(request: unknown): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const bridgePath = join(testDirectory, "..", "python", "verifier_bridge.py");
  const fixtureModulePath = join(testDirectory, "fixtures", "python");
  const childProcess = spawn(pythonExecutable, [bridgePath], {
    env: { ...process.env, PYTHONPATH: fixtureModulePath },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  childProcess.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
  childProcess.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
  childProcess.stdin.end(JSON.stringify(request));
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    childProcess.once("error", reject);
    childProcess.once("close", resolve);
  });
  return {
    exitCode,
    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
    stderr: Buffer.concat(stderrChunks).toString("utf8"),
  };
}

async function runRealBridge(request: unknown): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const pythonProjectPath = join(testDirectory, "..", "python");
  const bridgePath = join(pythonProjectPath, "verifier_bridge.py");
  const bridgeEnvironment = { ...process.env };
  for (const environmentName of Object.keys(bridgeEnvironment)) {
    if (
      environmentName === "DEEPSEEK_API_KEY"
      || environmentName === "OPENAI_BASE_URL"
      || environmentName.startsWith("VERTEX_")
      || environmentName.startsWith("GOOGLE_CLOUD_")
    ) {
      delete bridgeEnvironment[environmentName];
    }
  }
  const childProcess = spawn(
    "uv",
    ["run", "--frozen", "--project", pythonProjectPath, "python", bridgePath],
    { cwd: pythonProjectPath, env: bridgeEnvironment, stdio: ["pipe", "pipe", "pipe"] },
  );
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  childProcess.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
  childProcess.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
  childProcess.stdin.end(JSON.stringify(request));
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    childProcess.once("error", reject);
    childProcess.once("close", resolve);
  });
  return {
    exitCode,
    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
    stderr: Buffer.concat(stderrChunks).toString("utf8"),
  };
}

describe("Python verifier bridge", () => {
  it("returns one validated JSON result on stdout", async () => {
    const bridgeResult = await runBridge({
      task: "Fix the fixture",
      candidates: [
        { candidateId: "candidate-1", trajectory: "candidate A" },
        { candidateId: "candidate-2", trajectory: "candidate B" },
      ],
      pivots: 1,
      model: "deepseek-v4-flash",
      nEvaluations: 2,
      maxWorkers: 8,
      cachePath: scratchCachePath,
    });

    assert.equal(bridgeResult.exitCode, 0, bridgeResult.stderr);
    assert.deepEqual(JSON.parse(bridgeResult.stdout), {
      winnerIndex: 1,
      scores: [0.2, 0.9],
      ranking: [1, 0],
      requestCount: 18,
      tokenUsage: { calls: 18, input_tokens: 12, output_tokens: 3 },
    });
    assert.equal(bridgeResult.stderr, "");
  });

  it("rejects a verifier model from another provider", async () => {
    const bridgeResult = await runBridge({
      task: "Fix the fixture",
      candidates: [
        { candidateId: "candidate-1", trajectory: "candidate A" },
        { candidateId: "candidate-2", trajectory: "candidate B" },
      ],
      pivots: 1,
      model: "gpt-5",
      nEvaluations: 2,
      maxWorkers: 8,
      cachePath: scratchCachePath,
    });

    assert.equal(bridgeResult.exitCode, 1);
    assert.equal(bridgeResult.stdout, "");
    assert.match(bridgeResult.stderr, /model must begin with 'deepseek-'.*gpt-5/);
  });

  it("matches the real llm-verifier 0.2.0 API using a complete offline cache", async () => {
    const fixtureDirectory = await mkdtemp(join(tmpdir(), "dsh-real-verifier-cache-"));
    const cachePath = join(fixtureDirectory, "scores.json");
    const criteriaIds = [
      "specification_adherence",
      "output_match",
      "error_signal_detection",
    ];
    const cache: Record<string, { score_A: number; score_B: number }> = {};
    for (const criterionId of criteriaIds) {
      for (const [candidateA, candidateB] of [[0, 1], [1, 0]] as const) {
        for (const repetition of [0, 1]) {
          const candidateScores = [0.2, 0.9];
          cache[`${criterionId}|task|${candidateA},${candidateB}|${repetition}`] = {
            score_A: candidateScores[candidateA] ?? 0,
            score_B: candidateScores[candidateB] ?? 0,
          };
        }
      }
    }
    await writeFile(cachePath, JSON.stringify(cache));

    try {
      const bridgeResult = await runRealBridge({
        task: "Fix the fixture",
        candidates: [
          { candidateId: "candidate-1", trajectory: "candidate A" },
          { candidateId: "candidate-2", trajectory: "candidate B" },
        ],
        pivots: 1,
        model: "deepseek-v4-flash",
        nEvaluations: 2,
        maxWorkers: 8,
        cachePath,
      });

      assert.equal(bridgeResult.exitCode, 0, bridgeResult.stderr);
      const response = JSON.parse(bridgeResult.stdout) as Record<string, unknown>;
      assert.equal(response.winnerIndex, 1);
      assert.deepEqual(response.ranking, [1, 0]);
      assert.equal(response.requestCount, 0);
      assert.equal((response.tokenUsage as Record<string, unknown>).calls, 0);
    } finally {
      await rm(fixtureDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("builds the DeepSeek client once even when every worker asks at the same moment", async () => {
    // llm_verifier hands the bridge's lazy wrapper to the whole worker pool, and each worker
    // resolves it through __getattr__ -> _build(). create_deepseek_client() reads <cwd>/.env (file
    // I/O, GIL released), so the unbolted check-then-act built one client per worker and kept one.
    const fixtureDirectory = await mkdtemp(join(tmpdir(), "dsh-bridge-client-race-"));
    const logPath = join(fixtureDirectory, "builds.log");
    const scriptPath = join(fixtureDirectory, "race.py");
    await writeFile(scriptPath, [
      "import importlib.util, os, sys, threading, time, types",
      "class _Stub:",
      "    def __getattr__(self, name):",
      "        return lambda *a, **k: None",
      "def create_deepseek_client(api_key, model):",
      "    time.sleep(0.05)   # widen the window the unbolted version lost in",
      "    with open(os.environ['BRIDGE_CLIENT_LOG'], 'a', encoding='utf-8') as fh:",
      "        fh.write('built\\n')",
      "    return _Stub()",
      "pkg = types.ModuleType('llm_verifier')",
      "mod = types.ModuleType('llm_verifier.fine_grained_reward')",
      "mod.create_deepseek_client = create_deepseek_client",
      "pkg.fine_grained_reward = mod",
      "sys.modules['llm_verifier'] = pkg",
      "sys.modules['llm_verifier.fine_grained_reward'] = mod",
      "spec = importlib.util.spec_from_file_location('vb', sys.argv[1])",
      "module = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(module)",
      "client = module.DeepSeekClient('deepseek-v4-flash')",
      "pool = [threading.Thread(target=lambda: getattr(client, 'chat')) for _ in range(8)]",
      "for t in pool: t.start()",
      "for t in pool: t.join()",
      "print(len(open(os.environ['BRIDGE_CLIENT_LOG'], encoding='utf-8').read().splitlines()))",
    ].join("\n"));
    const bridgePath = join(testDirectory, "..", "python", "verifier_bridge.py");
    const childProcess = spawn(pythonExecutable, [scriptPath, bridgePath], {
      env: { ...process.env, DEEPSEEK_API_KEY: "sk-SENTINEL-not-a-key", BRIDGE_CLIENT_LOG: logPath },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    childProcess.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    childProcess.stderr.on("data", (chunk: Buffer) => errChunks.push(chunk));
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      childProcess.once("error", reject);
      childProcess.once("close", resolve);
    });
    await rm(fixtureDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    // force:true swallows Windows EPERM into silence, so the cleanup is asserted, not assumed.
    await assert.rejects(access(fixtureDirectory));
    assert.equal(exitCode, 0, Buffer.concat(errChunks).toString("utf8"));
    assert.equal(Buffer.concat(chunks).toString("utf8").trim(), "1",
      "the lazy client was built more than once: _build() is not locked");
  });
});
