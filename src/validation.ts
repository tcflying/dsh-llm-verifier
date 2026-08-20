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

async function detectJavaScriptCommand(repositoryPath: string): Promise<string> {
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
  return `${managerName} test`;
}

export async function resolveValidationCommands(
  repositoryPath: string,
  explicitValidationCommands?: readonly string[],
): Promise<string[]> {
  if (explicitValidationCommands !== undefined) {
    return validateExplicitCommands(explicitValidationCommands);
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
  switch (matchedProjectType) {
    case "javascript":
      return [await detectJavaScriptCommand(repositoryPath)];
    case "python":
      return ["uv run pytest"];
    case "rust":
      return ["cargo test"];
    case "go":
      return ["go test ./..."];
    case "make":
      return ["make test"];
    default:
      throw new Error(`cannot auto-detect validation commands: unknown project type ${JSON.stringify(matchedProjectType)}`);
  }
}
