import assert from "node:assert/strict";
import {
  accessSync,
  constants,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

type ProfileLayer = {
  packageName: string;
  patches: unknown;
};

type LoadedProfile = {
  name: string;
  layers: ProfileLayer[];
};

type ComposedEntry = {
  id?: string;
  name?: string;
  inject?: unknown;
};

type LoadProfileFn = (
  binName: string,
  name: string,
  installAnchor: string,
  home: string,
  options: { userLayer: boolean },
) => LoadedProfile | Promise<LoadedProfile>;

type ComposeEntriesFn = (layers: unknown[]) => ComposedEntry[];

type LoadOverlayPatchesFn = (binName: string, file: string) => unknown;

type AppBootNamespace = {
  loadProfile: LoadProfileFn;
  composeEntries: ComposeEntriesFn;
  loadOverlayPatches: LoadOverlayPatchesFn;
};

type StartedFiber = {
  await: () => Promise<unknown>;
  dispose: () => Promise<unknown> | unknown;
};

type LoaderService = {
  create: (options: { name: string; config?: object }) => Promise<string>;
  remove: (id: string) => Promise<unknown>;
  resolve: (id: string) => { fiber: { await: () => Promise<unknown> } };
};

type RuntimeContext = {
  plugin: (plugin: unknown, config?: unknown) => unknown;
  loader?: LoaderService;
  tools?: { schemas: () => Iterable<unknown> };
};

type RuntimePluginConstructor = new (...args: never[]) => object;
type RuntimeServiceConstructor = new (ctx: object, name: string) => object;

type DshRuntime = {
  Context: new () => RuntimeContext;
  Service: RuntimeServiceConstructor;
  SystemPrompt: RuntimePluginConstructor;
  ToolRuntime: RuntimePluginConstructor;
  Loader: RuntimePluginConstructor;
};

type ZeroCostCounters = {
  modelCalls: number;
  credentialResolutions: number;
  networkRequests: number;
};

type PackageJson = {
  name?: string;
  version?: string;
};

type ProfileSmokeCase = {
  profile: string;
  bundles: readonly string[];
  startupId: string;
};

const PROFILE_CASES: readonly ProfileSmokeCase[] = [
  {
    profile: "web",
    bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"],
    startupId: "web-startup",
  },
  {
    profile: "headless",
    bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"],
    startupId: "headless-startup",
  },
];

const EXPECTED_DSH_NAME = "@deepseek-ai/dsh";
const EXPECTED_DSH_VERSION = "0.1.0-rc.7";

function findDshExecutable(pathEnv: string | undefined): string {
  if (pathEnv === undefined || pathEnv === "") {
    throw new Error("process.env.PATH is empty or unset; cannot discover dsh executable");
  }
  for (const dir of pathEnv.split(delimiter)) {
    if (dir === "") {
      continue;
    }
    const candidate = join(dir, "dsh");
    try {
      if (!existsSync(candidate)) {
        continue;
      }
      const stats = statSync(candidate);
      if (!stats.isFile()) {
        continue;
      }
      accessSync(candidate, constants.X_OK);
    } catch {
      continue;
    }
    return realpathSync(candidate);
  }
  throw new Error(`no executable regular file named dsh found in process.env.PATH=${pathEnv}`);
}

function findDshPackageJson(dshExecutable: string): string {
  let dir = dirname(dshExecutable);
  for (;;) {
    const packageJsonPath = join(dir, "package.json");
    if (existsSync(packageJsonPath)) {
      const raw = readFileSync(packageJsonPath, "utf8");
      const parsed = JSON.parse(raw) as PackageJson;
      if (parsed.name === EXPECTED_DSH_NAME) {
        return packageJsonPath;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `no package.json with name === ${JSON.stringify(EXPECTED_DSH_NAME)} walking upward from dsh executable ${dshExecutable} (stopped at ${dir})`,
      );
    }
    dir = parent;
  }
}

function readDshPackageJson(packageJsonPath: string): PackageJson {
  const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as PackageJson;
  if (parsed.name !== EXPECTED_DSH_NAME) {
    throw new Error(
      `expected name ${JSON.stringify(EXPECTED_DSH_NAME)} at ${packageJsonPath}, got ${JSON.stringify(parsed.name)}`,
    );
  }
  if (parsed.version !== EXPECTED_DSH_VERSION) {
    throw new Error(
      `expected ${EXPECTED_DSH_NAME} version ${EXPECTED_DSH_VERSION} at ${packageJsonPath}, got ${JSON.stringify(parsed.version)}`,
    );
  }
  return parsed;
}

function findNamedPackageJson(startPath: string, expectedName: string): string {
  let dir = dirname(startPath);
  for (;;) {
    const packageJsonPath = join(dir, "package.json");
    if (existsSync(packageJsonPath)) {
      const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as PackageJson;
      if (parsed.name === expectedName) {
        return packageJsonPath;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `no package.json with name === ${JSON.stringify(expectedName)} walking upward from ${startPath} (stopped at ${dir})`,
      );
    }
    dir = parent;
  }
}

function pickFunction(namespace: Record<string, unknown>, exportName: string, href: string): Function {
  const direct = namespace[exportName];
  if (typeof direct === "function") {
    return direct;
  }
  const defaultExport = namespace.default;
  if (defaultExport !== null && typeof defaultExport === "object") {
    const nested = (defaultExport as Record<string, unknown>)[exportName];
    if (typeof nested === "function") {
      return nested;
    }
  }
  throw new Error(
    `expected ${exportName} to be a function in ${href}; got ${typeof direct}`,
  );
}

async function importAppBoot(dshPackageJsonPath: string): Promise<AppBootNamespace> {
  const requireFromDsh = createRequire(dshPackageJsonPath);
  let resolved: string;
  try {
    resolved = requireFromDsh.resolve("@deepseek-ai/dsh-app-boot");
  } catch (err) {
    throw new Error(
      `failed to resolve @deepseek-ai/dsh-app-boot from createRequire(${dshPackageJsonPath}): ${String(err)}`,
    );
  }
  const href = pathToFileURL(resolved).href;
  const imported: unknown = await import(href);
  if (imported === null || typeof imported !== "object") {
    throw new Error(`@deepseek-ai/dsh-app-boot namespace is not an object from ${href}`);
  }
  const namespace = imported as Record<string, unknown>;
  return {
    loadProfile: pickFunction(namespace, "loadProfile", href) as LoadProfileFn,
    composeEntries: pickFunction(namespace, "composeEntries", href) as ComposeEntriesFn,
    loadOverlayPatches: pickFunction(namespace, "loadOverlayPatches", href) as LoadOverlayPatchesFn,
  };
}

async function importNamespace(
  requireFromDsh: ReturnType<typeof createRequire>,
  specifier: string,
): Promise<{ namespace: Record<string, unknown>; resolved: string }> {
  let resolved: string;
  try {
    resolved = requireFromDsh.resolve(specifier);
  } catch (error) {
    throw new Error(`failed to resolve ${specifier} from the DSH package: ${String(error)}`);
  }
  const imported: unknown = await import(pathToFileURL(resolved).href);
  if (imported === null || typeof imported !== "object") {
    throw new Error(`${specifier} namespace is not an object from ${resolved}`);
  }
  return { namespace: imported as Record<string, unknown>, resolved };
}

function pickConstructor(
  namespace: Record<string, unknown>,
  exportName: string,
  specifier: string,
): RuntimePluginConstructor {
  const exported = namespace[exportName];
  if (typeof exported !== "function") {
    throw new Error(
      `expected ${specifier} export ${exportName} to be a constructor, got ${typeof exported}`,
    );
  }
  return exported as RuntimePluginConstructor;
}

async function importDshRuntime(packageJsonPath: string): Promise<DshRuntime> {
  const requireFromDsh = createRequire(packageJsonPath);
  const [cordis, loader, systemPrompt, tools] = await Promise.all([
    importNamespace(requireFromDsh, "@deepseek-ai/cordis"),
    importNamespace(requireFromDsh, "@deepseek-ai/cordis-plugin-loader"),
    importNamespace(requireFromDsh, "@deepseek-ai/dsh-system-prompt"),
    importNamespace(requireFromDsh, "@deepseek-ai/dsh-tools"),
  ]);

  const loaderPackageJsonPath = findNamedPackageJson(
    loader.resolved,
    "@deepseek-ai/cordis-plugin-loader",
  );
  const loaderPackage = JSON.parse(readFileSync(loaderPackageJsonPath, "utf8")) as PackageJson;
  if (loaderPackage.version !== "1.0.2") {
    throw new Error(
      `expected @deepseek-ai/cordis-plugin-loader version 1.0.2 at ${loaderPackageJsonPath}, got ${JSON.stringify(loaderPackage.version)}`,
    );
  }

  return {
    Context: pickConstructor(cordis.namespace, "Context", "@deepseek-ai/cordis") as new () => RuntimeContext,
    Service: pickConstructor(
      cordis.namespace,
      "Service",
      "@deepseek-ai/cordis",
    ) as RuntimeServiceConstructor,
    Loader: pickConstructor(
      loader.namespace,
      "Loader",
      "@deepseek-ai/cordis-plugin-loader",
    ),
    SystemPrompt: pickConstructor(
      systemPrompt.namespace,
      "SystemPrompt",
      "@deepseek-ai/dsh-system-prompt",
    ),
    ToolRuntime: pickConstructor(tools.namespace, "ToolRuntime", "@deepseek-ai/dsh-tools"),
  };
}

function createBoundaryServices(Service: RuntimeServiceConstructor, counters: ZeroCostCounters) {
  class TestApproval extends Service {
    constructor(ctx: object) {
      super(ctx, "approval");
    }

    request(): never {
      throw new Error("unexpected approval invocation");
    }
  }

  class TestCredentials extends Service {
    constructor(ctx: object) {
      super(ctx, "credentials");
    }

    get(): never {
      counters.credentialResolutions += 1;
      throw new Error("unexpected credential invocation");
    }
  }

  class TestModelBoundaryProvider extends Service {
    constructor(ctx: object) {
      super(ctx, "modelBoundaryProvider");
    }

    generate(): never {
      counters.modelCalls += 1;
      throw new Error("unexpected model invocation");
    }
  }

  return { TestApproval, TestCredentials, TestModelBoundaryProvider };
}

async function startFiber(
  ctx: RuntimeContext,
  plugin: unknown,
  startedFibers: StartedFiber[],
  config?: unknown,
): Promise<void> {
  const candidate = (config === undefined ? ctx.plugin(plugin) : ctx.plugin(plugin, config)) as Partial<StartedFiber>;
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    typeof candidate.await !== "function" ||
    typeof candidate.dispose !== "function"
  ) {
    throw new Error("ctx.plugin() did not return a fiber with await() and dispose()");
  }
  const fiber = candidate as StartedFiber;
  startedFibers.push(fiber);
  await fiber.await();
}

async function disposeStartedFibers(startedFibers: StartedFiber[]): Promise<void> {
  while (startedFibers.length > 0) {
    const fiber = startedFibers.pop();
    if (fiber === undefined) {
      throw new Error("started fiber stack unexpectedly became empty");
    }
    await fiber.dispose();
  }
}

function requireLoader(ctx: RuntimeContext, profile: string): LoaderService {
  const loader = ctx.loader;
  if (
    loader === undefined ||
    typeof loader.create !== "function" ||
    typeof loader.remove !== "function" ||
    typeof loader.resolve !== "function"
  ) {
    throw new Error(`${profile} smoke did not receive a real Loader service`);
  }
  return loader;
}

function targetToolCounts(ctx: RuntimeContext): { verifiedBestOf: number; applyVerifiedWinner: number } {
  if (ctx.tools === undefined || typeof ctx.tools.schemas !== "function") {
    throw new Error("ctx.tools.schemas is unavailable after ToolRuntime startup");
  }
  let verifiedBestOf = 0;
  let applyVerifiedWinner = 0;
  for (const schema of ctx.tools.schemas()) {
    if (schema === null || typeof schema !== "object" || typeof (schema as { name?: unknown }).name !== "string") {
      throw new Error(`tool schema has no string name: ${JSON.stringify(schema)}`);
    }
    const name = (schema as { name: string }).name;
    if (name === "verified_best_of") {
      verifiedBestOf += 1;
    } else if (name === "apply_verified_winner") {
      applyVerifiedWinner += 1;
    }
  }
  return { verifiedBestOf, applyVerifiedWinner };
}

function assertToolCounts(
  ctx: RuntimeContext,
  expected: number,
  label: string,
): void {
  const counts = targetToolCounts(ctx);
  assert.equal(counts.verifiedBestOf, expected, `${label} verified_best_of=${counts.verifiedBestOf}`);
  assert.equal(
    counts.applyVerifiedWinner,
    expected,
    `${label} apply_verified_winner=${counts.applyVerifiedWinner}`,
  );
}

function assertZeroCost(counters: ZeroCostCounters, label: string): void {
  assert.deepEqual(counters, {
    modelCalls: 0,
    credentialResolutions: 0,
    networkRequests: 0,
  }, label);
}

async function runPluginLifecycle(
  profile: string,
  counters: ZeroCostCounters,
  runtime: DshRuntime,
): Promise<void> {
  const ctx = new runtime.Context();
  const startedFibers: StartedFiber[] = [];
  const boundaries = createBoundaryServices(runtime.Service, counters);
  let loader: LoaderService | undefined;
  let entryId: string | undefined;
  try {
    await startFiber(ctx, runtime.SystemPrompt, startedFibers, {});
    await startFiber(ctx, runtime.ToolRuntime, startedFibers, {});
    await startFiber(ctx, boundaries.TestModelBoundaryProvider, startedFibers);
    await startFiber(ctx, boundaries.TestApproval, startedFibers);
    await startFiber(ctx, boundaries.TestCredentials, startedFibers);
    await startFiber(ctx, runtime.Loader, startedFibers, {
      baseUrl: new URL("../", import.meta.url).href,
    });

    loader = requireLoader(ctx, profile);
    const pluginNamespace = await import("../src/index.ts");
    assert.equal(Object.hasOwn(pluginNamespace, "default"), false, `${profile} plugin has default export`);
    assert.equal(typeof pluginNamespace.apply, "function", `${profile} plugin apply is not a function`);

    entryId = await loader.create({
      name: "./src/index.ts",
      config: { candidateProfile: "headless" },
    });
    await loader.resolve(entryId).fiber.await();
    assertToolCounts(ctx, 1, `${profile} after Loader activation`);
    assertZeroCost(counters, `${profile} activation crossed a zero-cost boundary`);

    await loader.remove(entryId);
    entryId = undefined;
    assertToolCounts(ctx, 0, `${profile} after Loader removal`);
    assertZeroCost(counters, `${profile} removal crossed a zero-cost boundary`);

    await disposeStartedFibers(startedFibers);
    assertZeroCost(counters, `${profile} cleanup crossed a zero-cost boundary`);
  } finally {
    try {
      if (entryId !== undefined && loader !== undefined) {
        await loader.remove(entryId);
      }
    } finally {
      await disposeStartedFibers(startedFibers);
    }
  }
}

const dshExecutable = findDshExecutable(process.env.PATH);
const dshPackageJsonPath = findDshPackageJson(dshExecutable);
readDshPackageJson(dshPackageJsonPath);

const repositoryPatchPath = fileURLToPath(new URL("../cordis.patch.yml", import.meta.url));
const appBootPromise = importAppBoot(dshPackageJsonPath);
const dshRuntimePromise = importDshRuntime(dshPackageJsonPath);

for (const { profile, bundles, startupId } of PROFILE_CASES) {
  test(`public profile load: ${profile}`, async () => {
    const { loadProfile, composeEntries, loadOverlayPatches } = await appBootPromise;
    const runtime = await dshRuntimePromise;
    const zeroCostCounters: ZeroCostCounters = {
      modelCalls: 0,
      credentialResolutions: 0,
      networkRequests: 0,
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      zeroCostCounters.networkRequests += 1;
      throw new Error("unexpected network invocation");
    }) as typeof globalThis.fetch;
    const home = mkdtempSync(join(tmpdir(), "dsh-llm-verifier-profile-smoke-"));
    try {
      const loaded = await loadProfile("dsh", profile, dshPackageJsonPath, home, {
        userLayer: false,
      });
      assert.equal(loaded.name, profile);
      assert.deepEqual(
        loaded.layers.map((layer) => layer.packageName),
        [...bundles],
      );
      const composed = composeEntries(loaded.layers.map((layer) => layer.patches));
      const startups = composed.filter((entry) => entry.id === startupId);
      assert.equal(
        startups.length,
        1,
        `expected exactly one composed entry with id ${JSON.stringify(startupId)}`,
      );

      const overlayPatches = loadOverlayPatches("dsh", repositoryPatchPath);
      const composedWithOverlay = composeEntries([
        ...loaded.layers.map((layer) => layer.patches),
        overlayPatches,
      ]);
      const verifiers = composedWithOverlay.filter((entry) => entry.id === "llm-verifier");
      assert.equal(verifiers.length, 1, 'expected exactly one composed entry with id "llm-verifier"');
      const verifier = verifiers[0];
      assert.ok(verifier);
      assert.equal(verifier.name, "dsh-llm-verifier");
      assert.deepEqual(verifier.inject, ["tools", "approval", "credentials"]);

      await runPluginLifecycle(profile, zeroCostCounters, runtime);
      assertZeroCost(zeroCostCounters, `${profile} smoke crossed a zero-cost boundary`);
    } finally {
      try {
        rmSync(home, { recursive: true, force: true });
      } finally {
        globalThis.fetch = originalFetch;
      }
    }
  });
}
