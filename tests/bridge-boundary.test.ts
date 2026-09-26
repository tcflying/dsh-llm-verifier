/**
 * Boundary regression checks for wave 15: the python bridge's backend
 * selection, its degenerate/non-finite score guards and its single stdout
 * write, plus the web client's debounced settings writes.
 *
 * Only this file's own cases run here; nothing reads src/**.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(testDirectory, "..");
const pythonProjectPath = join(projectRoot, "python");
const bridgePath = join(pythonProjectPath, "verifier_bridge.py");
const venvPython =
  process.platform === "win32"
    ? join(pythonProjectPath, ".venv", "Scripts", "python.exe")
    : join(pythonProjectPath, ".venv", "bin", "python");
const ambientPython = process.platform === "win32" ? "python" : "python3";

type BridgeRun = { exitCode: number | null; stdout: string; stderr: string };

/** Names the host's sanitizedEnvironment allowlist never forwards. */
const DROPPED_ENVIRONMENT = [
  "DEEPSEEK_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "ALL_PROXY",
  "all_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
];

async function runBridge(
  request: unknown,
  options: { cwd?: string; executable?: string } = {},
): Promise<BridgeRun> {
  const environment: NodeJS.ProcessEnv = { ...process.env, PYTHONDONTWRITEBYTECODE: "1" };
  for (const name of DROPPED_ENVIRONMENT) delete environment[name];
  const child = spawn(options.executable ?? venvPython, ["-B", bridgePath], {
    cwd: options.cwd ?? pythonProjectPath,
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
  child.stdin.end(JSON.stringify(request));
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return {
    exitCode,
    stdout: Buffer.concat(out).toString("utf8"),
    stderr: Buffer.concat(err).toString("utf8"),
  };
}

const CRITERION_IDS = ["specification_adherence", "output_match", "error_signal_detection"];

/** Every directed pair the bridge needs at nEvaluations=2, pivots=1, 2 candidates. */
function completeCache(expression: (candidateIndex: number) => string): string {
  const entries: string[] = [];
  for (const criterionId of CRITERION_IDS) {
    for (const [a, b] of [[0, 1], [1, 0]] as const) {
      for (let repetition = 0; repetition < 2; repetition += 1) {
        entries.push(
          `"${criterionId}|task|${a},${b}|${repetition}": {"score_A": ${expression(a)}, "score_B": ${expression(b)}}`,
        );
      }
    }
  }
  return `{${entries.join(",")}}`;
}

function bridgeRequest(cachePath: string, model = "deepseek-v4-flash"): Record<string, unknown> {
  return {
    task: "Fix the fixture",
    candidates: [
      { candidateId: "candidate-1", trajectory: "candidate A" },
      { candidateId: "candidate-2", trajectory: "candidate B" },
    ],
    pivots: 1,
    model,
    nEvaluations: 2,
    maxWorkers: 4,
    cachePath,
  };
}

const venvMissing = existsSync(venvPython) ? false : `no bridge interpreter at ${venvPython}`;

describe("verifier bridge backend selection", { skip: venvMissing }, () => {
  it("a .env in the spawn cwd never receives the key or the trajectories", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dsh-bridge-env-hijack-"));
    const hits: Array<{ authorization: string; bytes: number }> = [];
    const server = createServer((req, res) => {
      let bytes = 0;
      req.on("data", (chunk: Buffer) => { bytes += chunk.length; });
      req.on("end", () => {
        hits.push({ authorization: String(req.headers.authorization ?? ""), bytes });
        res.writeHead(400, { "content-type": "application/json" });
        res.end('{"error":{"message":"planted"}}');
      });
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as { port: number }).port;
      // Gitignored, so invisible to `git status`: this file decides the host.
      await writeFile(
        join(directory, ".env"),
        `OPENAI_BASE_URL=http://127.0.0.1:${port}/v1\nDEEPSEEK_API_KEY=sk-SENTINEL-not-a-key\n`,
      );
      const cachePath = join(directory, "scores.json");
      // An empty cache forces an uncached comparison, i.e. a real client.
      await writeFile(cachePath, "{}");

      const run = await runBridge(bridgeRequest(cachePath), { cwd: directory });

      assert.equal(hits.length, 0, `the .env-named host was contacted: ${JSON.stringify(hits)}`);
      assert.notEqual(run.exitCode, 0);
      assert.equal(run.stdout, "");
      assert.match(run.stderr, /refusing to let <cwd>\/\.env choose the verifier backend/);
    } finally {
      await new Promise<void>((resolve) => { server.close(() => resolve()); });
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("refuses a non-discriminating score vector instead of electing index 0", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dsh-bridge-tie-"));
    try {
      const cachePath = join(directory, "scores.json");
      await writeFile(cachePath, completeCache(() => "0.5"));

      const run = await runBridge(bridgeRequest(cachePath), { cwd: directory });

      assert.notEqual(run.exitCode, 0, `a degenerate verdict was accepted: ${run.stdout}`);
      assert.equal(run.stdout, "");
      assert.match(
        run.stderr,
        /verifier_bridge: verifier produced a non-discriminating score vector: \[0\.5, 0\.5\]/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("refuses a non-finite score by index instead of writing NaN", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dsh-bridge-nan-"));
    try {
      const cachePath = join(directory, "scores.json");
      await writeFile(cachePath, completeCache(() => "NaN"));

      const run = await runBridge(bridgeRequest(cachePath), { cwd: directory });

      assert.notEqual(run.exitCode, 0, `a NaN verdict was accepted: ${run.stdout}`);
      assert.equal(run.stdout, "");
      assert.match(run.stderr, /verifier produced a non-finite score at index 0: nan/);
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("still writes exactly one parseable verdict for a discriminating cache", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dsh-bridge-ok-"));
    try {
      const cachePath = join(directory, "scores.json");
      await writeFile(cachePath, completeCache((index) => (index === 0 ? "0.2" : "0.9")));

      const run = await runBridge(bridgeRequest(cachePath), { cwd: directory });

      assert.equal(run.exitCode, 0, run.stderr);
      assert.equal(run.stderr, "");
      assert.equal(run.stdout.trim().split("\n").length, 1, "the payload must be written once");
      const verdict = JSON.parse(run.stdout) as Record<string, unknown>;
      assert.deepEqual(Object.keys(verdict).sort(), ["ranking", "requestCount", "scores", "tokenUsage", "winnerIndex"]);
      assert.equal(verdict.winnerIndex, 1);
      assert.deepEqual(verdict.ranking, [1, 0]);
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("rejects a model id the settings document would reject", async () => {
    const run = await runBridge(bridgeRequest(join(tmpdir(), "dsh-unused-scores.json"), "deepseek-"), {
      executable: ambientPython,
    });

    assert.equal(run.exitCode, 1, run.stdout);
    assert.equal(run.stdout, "");
    assert.match(run.stderr, /model must begin with 'deepseek-' followed by a letter or digit, got 'deepseek-'/);
  });
});

type Element = { type: unknown; props: Record<string, unknown>; children: Element[] };
type Scope = {
  getSnapshot: () => unknown;
  subscribe: (listener: () => void) => () => void;
  set: (field: string, value: unknown) => Promise<void>;
};
type React = { begin: (hooks: unknown[]) => void; unmount: () => void };

/** The minimum of React's surface this card touches, with a manual unmount. */
function fakeReact() {
  let hooks: unknown[] = [];
  let cursor = 0;
  const cleanups: Array<() => void> = [];
  return {
    createElement(
      type: unknown,
      props: Record<string, unknown> | null,
      ...children: unknown[]
    ): Element {
      const kept = children
        .flat(Infinity)
        .filter((child) => child !== null && child !== undefined);
      return {
        type,
        props: { ...(props ?? {}), children: kept },
        children: kept.filter(
          (child) => typeof child === "object" && Array.isArray((child as Element).children),
        ) as Element[],
      };
    },
    useState(initial: unknown) {
      const index = cursor;
      cursor += 1;
      if (!(index in hooks)) {
        hooks[index] = { value: typeof initial === "function" ? (initial as () => unknown)() : initial };
      }
      const box = hooks[index] as { value: unknown };
      return [box.value, (next: unknown) => {
        box.value = typeof next === "function" ? (next as (previous: unknown) => unknown)(box.value) : next;
      }];
    },
    useRef(initial: unknown) {
      const index = cursor;
      cursor += 1;
      if (!(index in hooks)) hooks[index] = { current: initial };
      return hooks[index] as { current: Record<string, unknown> };
    },
    useEffect(effect: () => unknown) {
      const index = cursor;
      cursor += 1;
      if (!(index in hooks)) {
        hooks[index] = true;
        const cleanup = effect();
        if (typeof cleanup === "function") cleanups.push(cleanup as () => void);
      }
    },
    /** Point the hook slots at one card instance's state and rewind the cursor. */
    begin(nextHooks: unknown[]) {
      hooks = nextHooks;
      cursor = 0;
    },
    unmount() {
      for (const cleanup of cleanups.splice(0)) cleanup();
    },
  };
}

function caption(node: Element): string {
  return (node.props.children as unknown[]).filter((child) => typeof child === "string").join("");
}

/** Loads the real client module and hands back its SettingsCard component. */
function loadSettingsCard(react: ReturnType<typeof fakeReact>): (scope: Scope) => Element {
  const source = readFileSync(join(projectRoot, "client", "client.js"), "utf8");
  const cards: Array<() => Element> = [];
  let moduleFactory: ((require: (id: string) => unknown) => unknown) | undefined;
  new Function("window", source)({
    __ModuleLoader__: {
      load: (descriptor: { factory: (require: (id: string) => unknown) => unknown }) => {
        moduleFactory = descriptor.factory;
      },
    },
  });
  const exports = (moduleFactory as NonNullable<typeof moduleFactory>)((id: string) =>
    id === "react" ? react : undefined,
  ) as { apply: (context: unknown) => void };
  exports.apply({
    inject: (_dependencies: string[], build: (scoped: unknown) => void) =>
      build({
        settingsScope: { bind: () => ({}) },
        slots: {
          inject: (_name: string, register: () => unknown) => { cards.push(register() as () => Element); },
          register: (_descriptor: unknown, render: () => Element) => render,
        },
      }),
  });
  assert.equal(cards.length, 2, "expected the plugin item and the settings section");
  const [firstCard] = cards;
  assert.ok(firstCard, "the plugin registered no card to mount");
  const element = firstCard();
  const component = element.type as (props: Record<string, unknown>) => Element;
  return (scope) => component({ scope });
}

/** The control of the labelled row whose caption starts with `text`. */
function controlOf(node: Element, text: string): Element | null {
  const [captionNode, controlNode] = node.children;
  if (node.type === "label" && node.children.length === 2 && captionNode !== undefined
    && controlNode !== undefined && caption(captionNode).startsWith(text)) {
    return controlNode;
  }
  for (const child of node.children) {
    const found = controlOf(child, text);
    if (found) return found;
  }
  return null;
}

function alertOf(node: Element): string | null {
  if (node.props.role === "alert") return caption(node);
  for (const child of node.children) {
    const found = alertOf(child);
    if (found !== null) return found;
  }
  return null;
}

const SETTINGS = {
  enabled: true,
  defaultCandidateCount: 3,
  maxConcurrentCandidates: 3,
  candidateProfile: "headless",
  reviewMode: "deepseek_verifier",
  reviewerProvider: "",
  reviewerModel: "",
  reviewerReasoningEffort: "",
  reviewerMaxTokens: 32768,
  credentialRef: "DEEPSEEK_API_KEY",
  verifierModel: "deepseek-v4-flash",
  nEvaluations: 2,
  maxVerifierWorkers: 8,
  verifierEffort: "high",
  verifierMaxTokens: 32768,
  reviewSingleEligible: false,
  reviewFailurePolicy: "stop",
  reviewerTimeoutMs: 10 * 60_000,
  validationMode: "auto",
  validationCommands: [],
  candidateTimeoutMs: 20 * 60_000,
  validationTimeoutMs: 10 * 60_000,
  runTimeoutMs: 45 * 60_000,
  maxVerifierTraceBytes: 512 * 1024,
  stateDirectory: "$DSH_HOME/llm-verifier",
};

/** One mounted card: its own hook state, its own recorded writes. */
function mount(card: (scope: Scope) => Element, react: React) {
  const writes: Array<[string, unknown]> = [];
  const hooks: unknown[] = [];
  const scope: Scope = {
    getSnapshot: () => ({ status: "ready", value: SETTINGS, writable: true, revision: 1 }),
    subscribe: () => () => {},
    set: async (field: string, value: unknown) => { writes.push([field, value]); },
  };
  return {
    writes,
    render: () => {
      react.begin(hooks);
      return card(scope);
    },
    change(caption: string): (event: unknown) => void {
      const control = controlOf(this.render(), caption);
      assert.ok(control, `the ${caption} row was not found`);
      return control!.props.onChange as (event: unknown) => void;
    },
    alert(): string | null {
      return alertOf(this.render());
    },
  };
}

describe("settings card write scheduling", () => {
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 450));

  function harness() {
    const react = fakeReact();
    return { react, card: loadSettingsCard(react) };
  }

  it("debounces the minute fields so a half-typed budget is never stored", async () => {
    const { react, card } = harness();
    const instance = mount(card, react);
    const change = instance.change("全流程时限");

    change({ target: { value: "4" } });
    change({ target: { value: "45" } });
    assert.deepEqual(instance.writes, [], "a keystroke persisted immediately");
    await settle();
    assert.deepEqual(instance.writes, [["runTimeoutMs", 45 * 60_000]]);
  });

  it("debounces the text fields such as credentialRef and stateDirectory", async () => {
    const { react, card } = harness();
    const instance = mount(card, react);
    const change = instance.change("凭据引用名");

    change({ target: { value: "DEEPI" } });
    change({ target: { value: "DEEPSEEK_API_KEY" } });
    assert.deepEqual(instance.writes, [], "a half-typed credential ref was persisted");
    await settle();
    assert.deepEqual(instance.writes, [["credentialRef", "DEEPSEEK_API_KEY"]]);
  });

  it("reports an out-of-range edit instead of discarding it silently", async () => {
    const { react, card } = harness();
    const instance = mount(card, react);
    const change = instance.change("答案数量");

    change({ target: { value: "9" } });
    await settle();
    assert.deepEqual(instance.writes, [], "an out-of-range value was stored");
    assert.equal(instance.alert(), "保存失败：defaultCandidateCount 必须是 1-5 范围内的整数。");

    // Integrality is part of the schema (z.natural), and a fractional box value used to pass the
    // UI's Number.isFinite check and then die on save — the edit vanished with no explanation.
    change({ target: { value: "3.5" } });
    await settle();
    assert.deepEqual(instance.writes, [], "a fractional candidate count was stored");
    assert.equal(instance.alert(), "保存失败：defaultCandidateCount 必须是 1-5 范围内的整数。");

    change({ target: { value: "4" } });
    await settle();
    assert.deepEqual(instance.writes, [["defaultCandidateCount", 4]]);
    assert.equal(instance.alert(), null, "the range error was left standing after a valid edit");
  });

  it("bounds a minutes edit against the same ceiling the schema uses", async () => {
    const { react, card } = harness();
    const instance = mount(card, react);
    const change = instance.change("评审时限（分钟）");

    change({ target: { value: "99999" } });
    await settle();
    assert.deepEqual(instance.writes, [], "a minutes value past MAX_TIMEOUT_MS was stored");
    assert.match(instance.alert() ?? "", /必须是 1-10080 范围内的整数分钟/);

    change({ target: { value: "abc" } });
    await settle();
    assert.deepEqual(instance.writes, [], "unparseable text became 60000 ms through the old coercion");

    change({ target: { value: "0" } });
    await settle();
    assert.deepEqual(instance.writes, [], "0 was coerced up to the default instead of refused");

    change({ target: { value: "10080" } });
    await settle();
    assert.deepEqual(instance.writes, [["reviewerTimeoutMs", 10_080 * 60_000]], "the ceiling itself must be writable");
    assert.equal(instance.alert(), null, "the range error was left standing after a valid edit");
  });

  it("reports an out-of-range KiB edit instead of discarding it silently", async () => {
    const { react, card } = harness();
    const instance = mount(card, react);
    const change = instance.change("评审轨迹上限（KiB）");

    change({ target: { value: "9000" } });
    await settle();
    assert.deepEqual(instance.writes, [], "an out-of-range KiB value was stored");
    assert.equal(instance.alert(), "保存失败：maxVerifierTraceBytes 必须是 1-8192 范围内的数字。");

    change({ target: { value: "" } });
    await settle();
    assert.deepEqual(instance.writes, [], "clearing the box stored a number");

    change({ target: { value: "1024" } });
    await settle();
    assert.deepEqual(instance.writes, [["maxVerifierTraceBytes", 1024 * 1024]], "KiB was not converted to bytes");
    assert.equal(instance.alert(), null, "the range error was left standing after a valid edit");
  });

  it("keeps two mounted cards from cancelling each other's pending write", async () => {
    const { react, card } = harness();
    const a = mount(card, react);
    const b = mount(card, react);
    a.change("答案数量")({ target: { value: "4" } });
    b.change("答案数量")({ target: { value: "5" } });
    await settle();
    assert.deepEqual(a.writes, [["defaultCandidateCount", 4]], "card A's write was cancelled by card B");
    assert.deepEqual(b.writes, [["defaultCandidateCount", 5]]);
  });

  it("clears outstanding timers when the card unmounts", async () => {
    const { react, card } = harness();
    const instance = mount(card, react);
    instance.change("答案数量")({ target: { value: "4" } });
    react.unmount();
    await settle();
    assert.deepEqual(instance.writes, [], "a write landed after the card unmounted");
  });
});
