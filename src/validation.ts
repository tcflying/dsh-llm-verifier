import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

const MAX_VALIDATION_COMMANDS = 10;
const MAX_VALIDATION_COMMAND_LENGTH = 4_096;

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function validateExplicitCommands(validationCommands: readonly string[]): string[] {
  if (validationCommands.length === 0 || validationCommands.length > MAX_VALIDATION_COMMANDS) {
    throw new Error(
      `invalid validationCommands: expected 1-${MAX_VALIDATION_COMMANDS} commands, got ${validationCommands.length}`,
    );
  }
  return validationCommands.map((validationCommand, commandIndex) => {
    const normalizedCommand = validationCommand.trim();
    if (normalizedCommand.length === 0 || normalizedCommand.length > MAX_VALIDATION_COMMAND_LENGTH) {
      throw new Error(
        `invalid validationCommands[${commandIndex}]: expected 1-${MAX_VALIDATION_COMMAND_LENGTH} characters, got ${JSON.stringify(validationCommand)}`,
      );
    }
    return normalizedCommand;
  });
}

type JavaScriptPackageManager = "bun" | "npm" | "pnpm" | "yarn";

function packageManagerFromDeclaration(packageManager: unknown): JavaScriptPackageManager | undefined {
  if (typeof packageManager !== "string") {
    return undefined;
  }
  const managerName = packageManager.split("@", 1)[0];
  if (managerName === "bun" || managerName === "npm" || managerName === "pnpm" || managerName === "yarn") {
    return managerName;
  }
  throw new Error(
    `cannot auto-detect validation commands: unsupported packageManager ${JSON.stringify(packageManager)}`,
  );
}

export interface ResolvedValidationCommands {
  /** Commands rerun in the user's own repository after an apply. */
  readonly commands: string[];
  /** Commands run once per candidate worktree before `commands`. A fresh
   * worktree is a bare checkout with no installed dependencies, so the install
   * belongs there and not in the repository the winner is applied to. */
  readonly setupCommands: string[];
}

async function detectJavaScriptCommand(repositoryPath: string): Promise<ResolvedValidationCommands> {
  const packageJsonPath = join(repositoryPath, "package.json");
  const packageJsonValue: unknown = JSON.parse(await readFile(packageJsonPath, "utf8"));
  if (packageJsonValue === null || typeof packageJsonValue !== "object" || Array.isArray(packageJsonValue)) {
    throw new Error(`invalid package.json: expected an object at ${packageJsonPath}`);
  }
  const packageJson = packageJsonValue as Record<string, unknown>;
  const scripts = packageJson.scripts;
  if (
    scripts === null
    || typeof scripts !== "object"
    || Array.isArray(scripts)
    || typeof (scripts as Record<string, unknown>).test !== "string"
  ) {
    throw new Error(`cannot auto-detect validation commands: package.json has no test script at ${packageJsonPath}`);
  }

  const foundLockfiles: Array<readonly [string, JavaScriptPackageManager]> = [];
  const lockfileMapping: ReadonlyArray<readonly [string, JavaScriptPackageManager]> = [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["package-lock.json", "npm"],
    ["npm-shrinkwrap.json", "npm"],
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
  ];
  for (const [lockfileName, managerName] of lockfileMapping) {
    if (await pathExists(join(repositoryPath, lockfileName))) {
      foundLockfiles.push([lockfileName, managerName]);
    }
  }
  if (foundLockfiles.length > 1) {
    throw new Error(
      `cannot auto-detect validation commands: multiple JavaScript lockfiles found (${foundLockfiles.map(([lockfileName]) => lockfileName).join(", ")})`,
    );
  }

  const declaredManager = packageManagerFromDeclaration(packageJson.packageManager);
  const lockfileManager = foundLockfiles[0]?.[1];
  if (declaredManager !== undefined && lockfileManager !== undefined && declaredManager !== lockfileManager) {
    throw new Error(
      `cannot auto-detect validation commands: packageManager is ${declaredManager} but lockfile belongs to ${lockfileManager}`,
    );
  }
  const managerName = declaredManager ?? lockfileManager;
  if (managerName === undefined) {
    throw new Error(
      `cannot auto-detect validation commands: package.json declares no supported packageManager and has no recognized lockfile at ${repositoryPath}`,
    );
  }
  // Candidates run in a fresh worktree that has no installed dependencies, so a
  // bare `<manager> test` fails for every candidate and the run reports
  // `no_winner` for what is really a missing install. Installing from the
  // lockfile first makes the worktree check self-contained. The install is
  // carried apart from the test command because the post-apply revalidation runs
  // in the user's repository, where `npm ci` would wipe their own node_modules,
  // may rewrite their lockfile, needs network, and is never undone by a
  // rollback. The patch is captured before validation either way, so an install
  // rewriting the lockfile cannot change what gets applied.
  // ponytail: validationTimeoutMs has to cover the install; raise it for a tree
  // whose dependency fetch is slower than the default budget.
  const lockfileName = foundLockfiles[0]?.[0];
  const install = managerName === "npm"
    ? (lockfileName === undefined ? "npm install" : "npm ci")
    : `${managerName} install --frozen-lockfile`;
  return { commands: [`${managerName} test`], setupCommands: [install] };
}

export async function resolveValidationCommands(
  repositoryPath: string,
  explicitValidationCommands?: readonly string[],
): Promise<ResolvedValidationCommands> {
  if (explicitValidationCommands !== undefined) {
    // What the caller named is what runs, in the worktree and after the apply.
    return { commands: validateExplicitCommands(explicitValidationCommands), setupCommands: [] };
  }

  const projectMarkers: ReadonlyArray<readonly [string, string]> = [
    ["package.json", "javascript"],
    ["pyproject.toml", "python"],
    ["Cargo.toml", "rust"],
    ["go.mod", "go"],
  ];
  const matchedMarkers: Array<readonly [string, string]> = [];
  for (const [markerName, projectType] of projectMarkers) {
    if (await pathExists(join(repositoryPath, markerName))) {
      matchedMarkers.push([markerName, projectType]);
    }
  }

  const makefilePath = join(repositoryPath, "Makefile");
  if (await pathExists(makefilePath)) {
    const makefile = await readFile(makefilePath, "utf8");
    if (/^test\s*:/mu.test(makefile)) {
      matchedMarkers.push(["Makefile", "make"]);
    }
  }

  if (matchedMarkers.length !== 1) {
    const markerSummary = matchedMarkers.length === 0
      ? "no supported project marker"
      : `matched ${matchedMarkers.map(([markerName]) => markerName).join(", ")}`;
    throw new Error(`cannot auto-detect validation commands: ${markerSummary} at ${repositoryPath}`);
  }

  const matchedProjectType = matchedMarkers[0]?.[1];
  // No setup step for the other project types: `uv run`, `cargo test` and
  // `go test` resolve their own dependencies as part of the test command.
  const plain = (command: string): ResolvedValidationCommands => ({ commands: [command], setupCommands: [] });
  switch (matchedProjectType) {
    case "javascript":
      return await detectJavaScriptCommand(repositoryPath);
    case "python":
      return plain("uv run pytest");
    case "rust":
      return plain("cargo test");
    case "go":
      return plain("go test ./...");
    case "make":
      return plain("make test");
    default:
      throw new Error(`cannot auto-detect validation commands: unknown project type ${JSON.stringify(matchedProjectType)}`);
  }
}
