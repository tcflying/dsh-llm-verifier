import assert from "node:assert/strict";
import { accessSync, constants as fsConstants, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

const EXPECTED_EXPORT_KEYS = ["Config", "apply", "inject", "name"];
const EXPECTED_INJECT = ["tools", "approval", "credentials"];
const EXPECTED_DSH_IDENTITY = "@deepseek-ai/dsh@0.1.0-rc.7";
const EXPECTED_LOADER_IDENTITY = "@deepseek-ai/cordis-plugin-loader@1.0.2";

function readPackageIdentity(packageJsonPath: string): { name: string; version: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  } catch (error) {
    throw new Error(
      `invalid JSON in ${packageJsonPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`package.json at ${packageJsonPath} is not an object: ${JSON.stringify(parsed)}`);
  }
  const record = parsed as { name?: unknown; version?: unknown };
  if (typeof record.name !== "string" || typeof record.version !== "string") {
    throw new Error(
      `package.json at ${packageJsonPath} has name=${JSON.stringify(record.name)} version=${JSON.stringify(record.version)}`,
    );
  }
  return { name: record.name, version: record.version };
}

function findNamedPackage(
  startFilePath: string,
  expectedName: string,
): { directory: string; name: string; version: string; packageJsonPath: string } {
  let current = dirname(startFilePath);
  const examined: string[] = [];
  for (;;) {
    const packageJsonPath = join(current, "package.json");
    if (existsSync(packageJsonPath)) {
      const identity = readPackageIdentity(packageJsonPath);
      examined.push(`${packageJsonPath}=${identity.name}@${identity.version}`);
      if (identity.name === expectedName) {
        return {
          directory: current,
          name: identity.name,
          version: identity.version,
          packageJsonPath,
        };
      }
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(
        `could not find package ${expectedName} from ${startFilePath}; examined ${examined.join(", ") || "(no package.json)"}`,
      );
    }
    current = parent;
  }
}

function locateDshExecutable(): string {
  const pathValue = process.env.PATH;
  if (pathValue === undefined || pathValue === "") {
    throw new Error(`PATH is unset or empty: ${JSON.stringify(pathValue)}`);
  }
  for (const dir of pathValue.split(delimiter)) {
    if (dir === "") {
      continue;
    }
    const candidate = join(dir, "dsh");
    const stats = statSync(candidate, { throwIfNoEntry: false });
    if (stats === undefined || !stats.isFile()) {
      continue;
    }
    try {
      accessSync(candidate, fsConstants.X_OK);
    } catch {
      continue;
    }
    return candidate;
  }
  throw new Error(`dsh executable not found on PATH=${JSON.stringify(pathValue)}`);
}

function resolveRealDshPath(dshExecutable: string): string {
  try {
    return realpathSync(dshExecutable);
  } catch (error) {
    throw new Error(
      `failed to realpath dsh executable ${JSON.stringify(dshExecutable)}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function assertPluginContract(moduleNamespace: object, label: string): void {
  const keys = Object.keys(moduleNamespace).sort();
  assert.deepEqual(keys, EXPECTED_EXPORT_KEYS, `${label} keys=${JSON.stringify(keys)}`);
  assert.equal(Object.hasOwn(moduleNamespace, "default"), false, `${label} unexpectedly has default`);
  const record = moduleNamespace as {
    name?: unknown;
    inject?: unknown;
    Config?: unknown;
    apply?: unknown;
  };
  assert.equal(record.name, "llm-verifier", `${label} name=${JSON.stringify(record.name)}`);
  assert.deepEqual(record.inject, EXPECTED_INJECT, `${label} inject=${JSON.stringify(record.inject)}`);
  assert.notEqual(record.Config, undefined, `${label} Config is missing`);
  assert.notEqual(record.Config, null, `${label} Config is null`);
  assert.equal(typeof record.apply, "function", `${label} apply type=${typeof record.apply}`);
}

function getLoaderPrototype(loaderModule: { Loader?: unknown; default?: unknown }): {
  unwrapExports: (exports: unknown) => unknown;
} {
  const Loader = loaderModule.Loader ?? loaderModule.default;
  if (
    Loader === null ||
    (typeof Loader !== "object" && typeof Loader !== "function") ||
    !("prototype" in Loader) ||
    Loader.prototype === null ||
    typeof Loader.prototype !== "object" ||
    typeof (Loader.prototype as { unwrapExports?: unknown }).unwrapExports !== "function"
  ) {
    throw new Error(
      `Loader.unwrapExports missing; keys=${JSON.stringify(Object.keys(loaderModule).sort())} Loader=${String(Loader)}`,
    );
  }
  return Object.create(Loader.prototype) as { unwrapExports: (exports: unknown) => unknown };
}

type StartedFiber = {
  await: () => Promise<unknown>;
  dispose: () => unknown;
};

type LoaderService = {
  create: (options: { name: string; config?: object }) => Promise<string>;
  remove: (id: string) => Promise<unknown>;
  resolve: (id: string) => { fiber: { await: () => Promise<unknown> } };
};

function resolveFromDsh(
  requireFromDsh: ReturnType<typeof createRequire>,
  specifier: string,
  fromDirectory: string,
): string {
  try {
    return requireFromDsh.resolve(specifier);
  } catch (error) {
    throw new Error(
      `failed to resolve ${specifier} from ${fromDirectory}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function getNamedExport(moduleNamespace: object, exportName: string, label: string): unknown {
  if (!Object.hasOwn(moduleNamespace, exportName)) {
    throw new Error(
      `${label} missing export ${exportName}; keys=${JSON.stringify(Object.keys(moduleNamespace).sort())}`,
    );
  }
  return (moduleNamespace as Record<string, unknown>)[exportName];
}

function getNamedConstructor(
  moduleNamespace: object,
  exportName: string,
  label: string,
): new (...args: never[]) => object {
  const value = getNamedExport(moduleNamespace, exportName, label);
  if (typeof value !== "function") {
    throw new Error(`${label} export ${exportName} type=${typeof value}`);
  }
  return value as new (...args: never[]) => object;
}

function unexpectedInvocation(): never {
  throw new Error("unexpected invocation");
}

function createTestOnlyServices(Service: new (ctx: object, name: string) => object) {
  class TestApproval extends Service {
    constructor(ctx: object) {
      super(ctx, "approval");
    }
    request(): never {
      return unexpectedInvocation();
    }
  }

  class TestCredentials extends Service {
    constructor(ctx: object) {
      super(ctx, "credentials");
    }
    get(): never {
      return unexpectedInvocation();
    }
  }

  return { TestApproval, TestCredentials };
}

async function startServiceFiber(
  ctx: { plugin: (plugin: unknown, config?: unknown) => unknown },
  plugin: unknown,
  started: StartedFiber[],
  config?: unknown,
): Promise<StartedFiber> {
  const fiber = (config === undefined ? ctx.plugin(plugin) : ctx.plugin(plugin, config)) as StartedFiber;
  if (fiber === null || typeof fiber !== "object" || typeof fiber.await !== "function") {
    throw new Error("ctx.plugin() did not return a fiber with await()");
  }
  started.push(fiber);
  await fiber.await();
  return fiber;
}

function countToolSchemaNames(ctx: object): Map<string, number> {
  const tools = (ctx as { tools?: { schemas?: unknown } }).tools;
  if (tools === undefined || typeof tools.schemas !== "function") {
    throw new Error("ctx.tools.schemas is not a function");
  }
  const schemas = tools.schemas();
  if (
    schemas === null ||
    schemas === undefined ||
    typeof (schemas as { [Symbol.iterator]?: unknown })[Symbol.iterator] !== "function"
  ) {
    throw new Error(`ctx.tools.schemas() is not iterable: ${typeof schemas}`);
  }
  const counts = new Map<string, number>();
  for (const schema of schemas as Iterable<unknown>) {
    if (schema === null || typeof schema !== "object" || typeof (schema as { name?: unknown }).name !== "string") {
      throw new Error(`tool schema missing string name: ${JSON.stringify(schema)}`);
    }
    const name = (schema as { name: string }).name;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

function assertVerifiedToolCounts(counts: Map<string, number>, expected: number, label: string): void {
  const verifiedBestOf = counts.get("verified_best_of") ?? 0;
  const applyVerifiedWinner = counts.get("apply_verified_winner") ?? 0;
  assert.equal(verifiedBestOf, expected, `${label} verified_best_of=${verifiedBestOf}`);
  assert.equal(applyVerifiedWinner, expected, `${label} apply_verified_winner=${applyVerifiedWinner}`);
}

async function disposeStartedFibers(started: StartedFiber[]): Promise<void> {
  for (let index = started.length - 1; index >= 0; index -= 1) {
    const fiber = started[index];
    if (fiber === undefined || typeof fiber.dispose !== "function") {
      throw new Error("started service fiber is missing dispose()");
    }
    await fiber.dispose();
  }
}

const LOADER_PLANES = [
  { label: "source", specifier: "./src/index.ts" },
  { label: "built", specifier: "./lib/index.js" },
] as const;

const INVALID_LOADER_CONFIGS = [
  { field: "candidateProfile", value: "   ", config: { candidateProfile: "   " } },
  { field: "credentialRef", value: "\t", config: { credentialRef: "\t" } },
  { field: "verifierModel", value: "gpt-5", config: { verifierModel: "gpt-5" } },
] as const;

type RuntimeConstructors = {
  Context: new () => {
    plugin: (plugin: unknown, config?: unknown) => unknown;
  };
  SystemPrompt: new (...args: never[]) => object;
  ToolRuntime: new (...args: never[]) => object;
  Loader: new (...args: never[]) => object;
  TestApproval: new (ctx: object) => object;
  TestCredentials: new (ctx: object) => object;
};

async function resolveRuntimeConstructors(): Promise<RuntimeConstructors> {
  const dshExecutable = locateDshExecutable();
  const realDshPath = resolveRealDshPath(dshExecutable);
  const dshPackage = findNamedPackage(realDshPath, "@deepseek-ai/dsh");
  const dshIdentity = `${dshPackage.name}@${dshPackage.version}`;
  if (dshIdentity !== EXPECTED_DSH_IDENTITY) {
    throw new Error(
      `DSH package differs: expected ${EXPECTED_DSH_IDENTITY}, got ${dshIdentity} at ${dshPackage.packageJsonPath} (realpath ${realDshPath})`,
    );
  }

  const requireFromDsh = createRequire(join(dshPackage.directory, "package.json"));
  const cordisResolved = resolveFromDsh(requireFromDsh, "@deepseek-ai/cordis", dshPackage.directory);
  const systemPromptResolved = resolveFromDsh(requireFromDsh, "@deepseek-ai/dsh-system-prompt", dshPackage.directory);
  const toolsResolved = resolveFromDsh(requireFromDsh, "@deepseek-ai/dsh-tools", dshPackage.directory);
  const loaderResolved = resolveFromDsh(requireFromDsh, "@deepseek-ai/cordis-plugin-loader", dshPackage.directory);

  const loaderPackage = findNamedPackage(loaderResolved, "@deepseek-ai/cordis-plugin-loader");
  const loaderIdentity = `${loaderPackage.name}@${loaderPackage.version}`;
  if (loaderIdentity !== EXPECTED_LOADER_IDENTITY) {
    throw new Error(
      `Loader package differs: expected ${EXPECTED_LOADER_IDENTITY}, got ${loaderIdentity} at ${loaderPackage.packageJsonPath} (resolved ${loaderResolved})`,
    );
  }

  const [cordisModule, systemPromptModule, toolsModule, loaderModule] = await Promise.all([
    import(pathToFileURL(cordisResolved).href),
    import(pathToFileURL(systemPromptResolved).href),
    import(pathToFileURL(toolsResolved).href),
    import(pathToFileURL(loaderResolved).href),
  ]);

  const Context = getNamedConstructor(cordisModule, "Context", "@deepseek-ai/cordis") as new () => {
    plugin: (plugin: unknown, config?: unknown) => unknown;
  };
  const Service = getNamedConstructor(cordisModule, "Service", "@deepseek-ai/cordis") as new (
    ctx: object,
    name: string,
  ) => object;
  const SystemPrompt = getNamedConstructor(systemPromptModule, "SystemPrompt", "@deepseek-ai/dsh-system-prompt");
  const ToolRuntime = getNamedConstructor(toolsModule, "ToolRuntime", "@deepseek-ai/dsh-tools");
  const Loader = getNamedConstructor(loaderModule, "Loader", "@deepseek-ai/cordis-plugin-loader");
  const { TestApproval, TestCredentials } = createTestOnlyServices(Service);
  return { Context, SystemPrompt, ToolRuntime, Loader, TestApproval, TestCredentials };
}

async function startRequiredServices(
  ctx: { plugin: (plugin: unknown, config?: unknown) => unknown },
  runtime: RuntimeConstructors,
  started: StartedFiber[],
): Promise<void> {
  await startServiceFiber(ctx, runtime.SystemPrompt, started, {});
  await startServiceFiber(ctx, runtime.ToolRuntime, started, {});
  await startServiceFiber(ctx, runtime.TestApproval, started);
  await startServiceFiber(ctx, runtime.TestCredentials, started);
  await startServiceFiber(ctx, runtime.Loader, started, { baseUrl: new URL("../", import.meta.url).href });
}

function requireLoaderService(ctx: object, label: string): LoaderService {
  const loaderService = (ctx as { loader?: LoaderService }).loader;
  if (
    loaderService === undefined ||
    typeof loaderService.create !== "function" ||
    typeof loaderService.remove !== "function" ||
    typeof loaderService.resolve !== "function"
  ) {
    throw new Error(`${label} ctx.loader is missing create/remove/resolve after Loader start`);
  }
  return loaderService;
}

async function cleanupLoaderCase(
  entryId: string | undefined,
  loader: LoaderService | undefined,
  started: StartedFiber[],
): Promise<void> {
  try {
    if (entryId !== undefined && loader !== undefined) {
      await loader.remove(entryId);
    }
  } finally {
    await disposeStartedFibers(started);
  }
}

function collectErrorChainText(error: unknown): string {
  const texts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    if (typeof current === "string") {
      texts.push(current);
      break;
    }
    if (current instanceof Error) {
      texts.push(current.message);
      texts.push(String(current));
      current = current.cause;
      continue;
    }
    if (typeof current === "object") {
      const record = current as { message?: unknown; cause?: unknown };
      if (typeof record.message === "string") {
        texts.push(record.message);
      }
      texts.push(String(current));
      current = record.cause;
      continue;
    }
    texts.push(String(current));
    break;
  }
  if (texts.length === 0) {
    return String(error);
  }
  return texts.join("\n");
}

describe("loader contract", () => {
  it("exposes only the named source entry exports", async () => {
    const sourceModule = await import("../src/index.ts");
    assertPluginContract(sourceModule, "source");
  });

  it("unwraps the built entry with the real Loader as the same named-export namespace", async () => {
    const dshExecutable = locateDshExecutable();
    const realDshPath = resolveRealDshPath(dshExecutable);
    const dshPackage = findNamedPackage(realDshPath, "@deepseek-ai/dsh");
    const dshIdentity = `${dshPackage.name}@${dshPackage.version}`;
    if (dshIdentity !== EXPECTED_DSH_IDENTITY) {
      throw new Error(
        `DSH package differs: expected ${EXPECTED_DSH_IDENTITY}, got ${dshIdentity} at ${dshPackage.packageJsonPath} (realpath ${realDshPath})`,
      );
    }

    const requireFromDsh = createRequire(join(dshPackage.directory, "package.json"));
    let loaderResolved: string;
    try {
      loaderResolved = requireFromDsh.resolve("@deepseek-ai/cordis-plugin-loader");
    } catch (error) {
      throw new Error(
        `failed to resolve @deepseek-ai/cordis-plugin-loader from ${dshPackage.directory}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const loaderPackage = findNamedPackage(loaderResolved, "@deepseek-ai/cordis-plugin-loader");
    const loaderIdentity = `${loaderPackage.name}@${loaderPackage.version}`;
    if (loaderIdentity !== EXPECTED_LOADER_IDENTITY) {
      throw new Error(
        `Loader package differs: expected ${EXPECTED_LOADER_IDENTITY}, got ${loaderIdentity} at ${loaderPackage.packageJsonPath} (resolved ${loaderResolved})`,
      );
    }

    const loaderModule = await import(pathToFileURL(loaderResolved).href);
    const builtModule = await import("../lib/index.js");
    const unwrapped = getLoaderPrototype(loaderModule).unwrapExports(builtModule);

    assert.equal(unwrapped, builtModule);
    assert.deepEqual(Object.keys(builtModule).sort(), EXPECTED_EXPORT_KEYS);
    assert.deepEqual(
      Object.keys(unwrapped as object).sort(),
      EXPECTED_EXPORT_KEYS,
    );
    assertPluginContract(builtModule, "built");
    assertPluginContract(unwrapped as object, "unwrapped");
  });

  it("loads source and built planes through Loader, removes both tools, and reloads them once", async () => {
    const runtime = await resolveRuntimeConstructors();

    for (const plane of LOADER_PLANES) {
      const ctx = new runtime.Context();
      const started: StartedFiber[] = [];
      let loader: LoaderService | undefined;
      let entryId: string | undefined;
      try {
        await startRequiredServices(ctx, runtime, started);
        loader = requireLoaderService(ctx, plane.label);

        entryId = await loader.create({ name: plane.specifier, config: {} });
        await loader.resolve(entryId).fiber.await();
        assertVerifiedToolCounts(countToolSchemaNames(ctx), 1, `${plane.label} first load`);

        await loader.remove(entryId);
        entryId = undefined;
        assertVerifiedToolCounts(countToolSchemaNames(ctx), 0, `${plane.label} after remove`);

        entryId = await loader.create({ name: plane.specifier, config: {} });
        await loader.resolve(entryId).fiber.await();
        assertVerifiedToolCounts(countToolSchemaNames(ctx), 1, `${plane.label} after reload`);
      } finally {
        await cleanupLoaderCase(entryId, loader, started);
      }
    }
  });

  it("rejects invalid config on source and built planes before tool registration", async () => {
    const runtime = await resolveRuntimeConstructors();

    for (const plane of LOADER_PLANES) {
      for (const invalid of INVALID_LOADER_CONFIGS) {
        const caseLabel = `${plane.label} ${invalid.field}=${JSON.stringify(invalid.value)}`;
        const ctx = new runtime.Context();
        const started: StartedFiber[] = [];
        let loader: LoaderService | undefined;
        let entryId: string | undefined;
        try {
          await startRequiredServices(ctx, runtime, started);
          loader = requireLoaderService(ctx, caseLabel);
          assertVerifiedToolCounts(countToolSchemaNames(ctx), 0, `${caseLabel} before create`);

          const trackedCreate = loader.create({ name: plane.specifier, config: invalid.config }).then((id) => {
            entryId = id;
            return id;
          });
          await assert.rejects(trackedCreate, (error: unknown) => {
            const combined = collectErrorChainText(error);
            const serializedValue = JSON.stringify(invalid.value);
            assert.ok(
              combined.includes(invalid.field),
              `${caseLabel} rejection missing field ${JSON.stringify(invalid.field)}; combined=${JSON.stringify(combined)}`,
            );
            assert.ok(
              combined.includes(serializedValue),
              `${caseLabel} rejection missing ${serializedValue}; combined=${JSON.stringify(combined)}`,
            );
            return true;
          });

          assertVerifiedToolCounts(countToolSchemaNames(ctx), 0, `${caseLabel} after reject`);
        } finally {
          await cleanupLoaderCase(entryId, loader, started);
        }
      }
    }
  });
});
