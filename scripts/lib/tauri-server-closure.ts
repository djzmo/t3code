// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalRandom:off - Explicit build boundary.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { selectCliRuntimeExternalDependencies } from "./cli-external-packages.ts";
import {
  createStagePatchedDependencies,
  createStageWorkspaceConfig,
  resolveFffNativeDependencies,
} from "./desktop-stage-config.ts";
import { resolveCatalogDependencies } from "./resolve-catalog.ts";

export const TAURI_SERVER_ENTRY = "apps/server/dist/bin.mjs" as const;
export const TAURI_SERVER_NODE_MODULES = "node_modules" as const;
export const TAURI_SERVER_CLOSURE_LIMITS = Object.freeze({
  maxFileCount: 2_500,
  maxBytes: 400 * 1024 * 1024,
});

const SERVER_PACKAGE_PATH = "apps/server";
const WINDOWS_COMMAND_ENV = "NANONI_TAURI_CLOSURE_COMMAND";
const WINDOWS_ARGUMENTS_ENV = "NANONI_TAURI_CLOSURE_ARGUMENTS";
const WINDOWS_COMMAND_SCRIPT = Buffer.from(
  [
    `$ProgressPreference = "SilentlyContinue"`,
    `$command = $env:${WINDOWS_COMMAND_ENV}`,
    `$arguments = ConvertFrom-Json $env:${WINDOWS_ARGUMENTS_ENV}`,
    `& $command @arguments`,
    `if ($null -eq $LASTEXITCODE) { exit 1 }`,
    `exit $LASTEXITCODE`,
  ].join("\n"),
  "utf16le",
).toString("base64");

type JsonObject = Record<string, unknown>;
type Platform = "mac" | "linux" | "win";
type Arch = "arm64" | "x64";

interface LockImporterDependency {
  readonly specifier?: unknown;
  readonly version?: unknown;
}

interface LockImporter {
  readonly dependencies?: Record<string, LockImporterDependency>;
}

interface Lockfile extends JsonObject {
  importers?: Record<string, LockImporter>;
  packages?: Record<string, unknown>;
  snapshots?: Record<string, unknown>;
}

export interface TauriServerClosureCommandResult {
  readonly exitCode: number;
  readonly stdout?: string;
  readonly stderr?: string;
}

export interface TauriServerClosureCommandInvocation {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly targetDir: string;
}

export type TauriServerClosureCommandRunner = (
  invocation: TauriServerClosureCommandInvocation,
) => Promise<TauriServerClosureCommandResult>;

export interface TauriServerClosureOptions {
  readonly rootDir?: string;
  readonly outputRoot: string;
  readonly serverPackagePath?: string;
  readonly platform?: Platform;
  readonly arch?: Arch;
  readonly packageManagerCommand?: string;
  readonly temporaryRoot?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly runCommand?: TauriServerClosureCommandRunner;
  /** Test-only limits; production callers use the frozen V4 limits. */
  readonly limits?: Partial<typeof TAURI_SERVER_CLOSURE_LIMITS>;
}

export interface TauriServerClosureResult {
  readonly outputRoot: string;
  readonly entryPath: string;
  readonly nodeModulesPath: string;
  readonly packageJsonPath: string;
  readonly workspacePath: string;
  readonly fileCount: number;
  readonly byteCount: number;
  readonly externalDependencies: ReadonlyArray<string>;
  readonly installedDependencies: ReadonlyArray<string>;
}

export class TauriServerClosureError extends Error {
  readonly code:
    | "missing-input"
    | "invalid-input"
    | "command-failed"
    | "invalid-output"
    | "missing-runtime-dependency"
    | "unsafe-symlink"
    | "payload-budget-exceeded"
    | "transaction-failed";

  constructor(code: TauriServerClosureError["code"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TauriServerClosureError";
    this.code = code;
  }
}

interface CopyStats {
  fileCount: number;
  byteCount: number;
}

const defaultCommandRunner: TauriServerClosureCommandRunner = async (invocation) => {
  const command = process.platform === "win32" ? "powershell.exe" : invocation.command;
  const args =
    process.platform === "win32"
      ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", WINDOWS_COMMAND_SCRIPT]
      : [...invocation.args];
  const environment =
    process.platform === "win32"
      ? {
          ...invocation.environment,
          [WINDOWS_COMMAND_ENV]: invocation.command,
          [WINDOWS_ARGUMENTS_ENV]: JSON.stringify(invocation.args),
        }
      : invocation.environment;
  const child = NodeChildProcess.spawn(command, args, {
    cwd: invocation.cwd,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
  return await new Promise<TauriServerClosureCommandResult>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode) =>
      resolve({
        exitCode: exitCode ?? 1,
        ...(stdout.length === 0 ? {} : { stdout: Buffer.concat(stdout).toString("utf8") }),
        ...(stderr.length === 0 ? {} : { stderr: Buffer.concat(stderr).toString("utf8") }),
      }),
    );
  });
};

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const recordOfStrings = (value: unknown): Record<string, string> =>
  isObject(value)
    ? Object.fromEntries(
        Object.entries(value).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      )
    : {};

const recordOfBooleans = (value: unknown): Record<string, boolean> =>
  isObject(value)
    ? Object.fromEntries(
        Object.entries(value).filter(
          (entry): entry is [string, boolean] => typeof entry[1] === "boolean",
        ),
      )
    : {};

const readJson = async (path: string, name: string): Promise<JsonObject> => {
  try {
    const parsed: unknown = JSON.parse(await NodeFS.readFile(path, "utf8"));
    if (isObject(parsed)) return parsed;
  } catch (cause) {
    throw new TauriServerClosureError("invalid-input", `Unable to read ${name}: ${path}.`, {
      cause,
    });
  }
  throw new TauriServerClosureError("invalid-input", `${name} must contain an object: ${path}.`);
};

const assertFile = async (path: string, name: string): Promise<void> => {
  try {
    if ((await NodeFS.lstat(path)).isFile()) return;
  } catch (cause) {
    throw new TauriServerClosureError("missing-input", `${name} does not exist: ${path}.`, {
      cause,
    });
  }
  throw new TauriServerClosureError("invalid-input", `${name} must be a file: ${path}.`);
};

const assertDirectory = async (path: string, name: string): Promise<void> => {
  try {
    if ((await NodeFS.lstat(path)).isDirectory()) return;
  } catch (cause) {
    throw new TauriServerClosureError("missing-input", `${name} does not exist: ${path}.`, {
      cause,
    });
  }
  throw new TauriServerClosureError("invalid-input", `${name} must be a directory: ${path}.`);
};

const isInside = (root: string, candidate: string): boolean => {
  const relative = NodePath.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${NodePath.sep}`) &&
      !NodePath.isAbsolute(relative))
  );
};

const normalizePlatform = (value: Platform | undefined): Platform => {
  if (value) return value;
  if (process.platform === "darwin") return "mac";
  if (process.platform === "win32") return "win";
  return "linux";
};

const normalizeArch = (value: Arch | undefined): Arch => {
  if (value) return value;
  if (process.arch === "arm64") return "arm64";
  if (process.arch === "x64") return "x64";
  throw new TauriServerClosureError(
    "invalid-input",
    `Unsupported closure architecture: ${process.arch}.`,
  );
};

const randomSuffix = (): string =>
  `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;

const copyTree = async (
  source: string,
  destination: string,
  sourceRoot: string,
  destinationRoot: string,
): Promise<CopyStats> => {
  const info = await NodeFS.lstat(source);
  if (info.isSymbolicLink()) {
    const linkTarget = await NodeFS.readlink(source);
    const resolvedTarget = NodePath.resolve(NodePath.dirname(source), linkTarget);
    if (!isInside(sourceRoot, resolvedTarget)) {
      throw new TauriServerClosureError(
        "unsafe-symlink",
        `Refusing closure symlink outside its root: ${source} -> ${linkTarget}.`,
      );
    }
    if (process.platform === "win32") {
      throw new TauriServerClosureError(
        "invalid-output",
        `Windows closure install must be hoisted and symlink-free: ${source}.`,
      );
    }
    const destinationTarget = NodePath.join(
      destinationRoot,
      NodePath.relative(sourceRoot, resolvedTarget),
    );
    await NodeFS.mkdir(NodePath.dirname(destination), { recursive: true });
    await NodeFS.symlink(
      NodePath.relative(NodePath.dirname(destination), destinationTarget),
      destination,
    );
    return { fileCount: 1, byteCount: 0 };
  }
  if (info.isDirectory()) {
    await NodeFS.mkdir(destination, { recursive: true });
    let stats: CopyStats = { fileCount: 0, byteCount: 0 };
    const entries = (await NodeFS.readdir(source, { withFileTypes: true })).toSorted((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const child = await copyTree(
        NodePath.join(source, entry.name),
        NodePath.join(destination, entry.name),
        sourceRoot,
        destinationRoot,
      );
      stats = {
        fileCount: stats.fileCount + child.fileCount,
        byteCount: stats.byteCount + child.byteCount,
      };
    }
    await NodeFS.chmod(destination, info.mode & 0o7777);
    return stats;
  }
  if (!info.isFile()) {
    throw new TauriServerClosureError("invalid-output", `Unsupported closure entry: ${source}.`);
  }
  await NodeFS.mkdir(NodePath.dirname(destination), { recursive: true });
  await NodeFS.copyFile(source, destination);
  await NodeFS.chmod(destination, info.mode & 0o7777);
  return { fileCount: 1, byteCount: info.size };
};

const validatePrivateTemporaryRoot = (
  temporaryRoot: string,
  rootDir: string,
  serverPackagePath: string,
  outputRoot: string,
): void => {
  const unsafe =
    isInside(temporaryRoot, rootDir) ||
    isInside(temporaryRoot, serverPackagePath) ||
    isInside(serverPackagePath, temporaryRoot) ||
    isInside(temporaryRoot, outputRoot) ||
    isInside(outputRoot, temporaryRoot);
  if (unsafe) {
    throw new TauriServerClosureError(
      "invalid-input",
      `temporaryRoot must not contain or overlap the repository, source, or output: ${temporaryRoot}.`,
    );
  }
};

const selectedDependencies = (
  manifest: JsonObject,
  platform: Platform,
  arch: Arch,
): { runtime: Record<string, string>; installed: Record<string, string> } => {
  const declared = {
    ...recordOfStrings(manifest.dependencies),
    ...recordOfStrings(manifest.optionalDependencies),
  };
  const runtime = selectCliRuntimeExternalDependencies(declared);
  const fffVersion = runtime["@ff-labs/fff-node"];
  if (!fffVersion) {
    throw new TauriServerClosureError(
      "missing-runtime-dependency",
      "apps/server must declare @ff-labs/fff-node for the native CLI closure.",
    );
  }
  const installed = {
    ...runtime,
    ...resolveFffNativeDependencies(platform, arch, fffVersion),
    ...(platform === "win" ? resolveFffNativeDependencies("linux", arch, fffVersion) : {}),
  };
  // Stage workspace `libc: ["glibc"]` cannot materialize musl optional bins.
  for (const dependency of Object.keys(installed)) {
    if (dependency.startsWith("@ff-labs/fff-bin-") && dependency.endsWith("-musl")) {
      delete installed[dependency];
    }
  }
  return {
    runtime,
    installed,
  };
};

const lockVersionWithoutPeerContext = (version: string): string => {
  const separator = version.indexOf("(");
  return separator === -1 ? version : version.slice(0, separator);
};

const lockSnapshotKey = (
  lockfile: Lockfile,
  dependency: string,
  requestedVersion: string,
): string | undefined => {
  const snapshots = lockfile.snapshots;
  if (!snapshots) return undefined;
  const normalized = lockVersionWithoutPeerContext(requestedVersion);
  const prefix = `${dependency}@${normalized}`;
  return Object.keys(snapshots).find((key) => key === prefix || key.startsWith(`${prefix}(`));
};

const projectFrozenLockfile = (
  lockfile: Lockfile,
  installedDependencies: Record<string, string>,
  patchedDependencies: Record<string, string>,
  overrides: Record<string, string>,
): { readonly lockfile: Lockfile; readonly dependencies: Record<string, string> } => {
  if (
    !isObject(lockfile.importers) ||
    !isObject(lockfile.packages) ||
    !isObject(lockfile.snapshots)
  ) {
    throw new TauriServerClosureError(
      "invalid-input",
      "pnpm-lock.yaml must contain importers, packages, and snapshots for a frozen closure.",
    );
  }
  const serverImporter = lockfile.importers[SERVER_PACKAGE_PATH];
  if (!isObject(serverImporter)) {
    throw new TauriServerClosureError(
      "invalid-input",
      `pnpm-lock.yaml is missing the ${SERVER_PACKAGE_PATH} importer.`,
    );
  }
  const sourceDependencies = isObject(serverImporter.dependencies)
    ? (serverImporter.dependencies as Record<string, LockImporterDependency>)
    : {};
  const lockDependencies: Record<string, LockImporterDependency> = {};
  const exactDependencies: Record<string, string> = {};
  for (const [dependency, requestedVersion] of Object.entries(installedDependencies)) {
    const sourceEntry = sourceDependencies[dependency];
    const snapshotKey = lockSnapshotKey(lockfile, dependency, requestedVersion);
    const lockVersion =
      typeof sourceEntry?.version === "string"
        ? sourceEntry.version
        : snapshotKey?.slice(dependency.length + 1);
    if (!lockVersion) {
      throw new TauriServerClosureError(
        "invalid-input",
        `pnpm-lock.yaml has no exact resolution for closure dependency '${dependency}'.`,
      );
    }
    const exactVersion = lockVersionWithoutPeerContext(lockVersion);
    if (!exactVersion) {
      throw new TauriServerClosureError(
        "invalid-input",
        `pnpm-lock.yaml has an invalid resolution for closure dependency '${dependency}'.`,
      );
    }
    exactDependencies[dependency] = exactVersion;
    lockDependencies[dependency] = { specifier: exactVersion, version: lockVersion };
  }

  const sourcePatchedDependencies = recordOfStrings(lockfile.patchedDependencies);
  const projectedPatchedDependencies = Object.fromEntries(
    Object.keys(patchedDependencies)
      .filter((key) => typeof sourcePatchedDependencies[key] === "string")
      .map((key) => [key, sourcePatchedDependencies[key]]),
  );
  const projected: Lockfile = {
    ...lockfile,
    importers: {
      ".": { dependencies: lockDependencies },
    },
  };
  delete projected.patchedDependencies;
  delete projected.overrides;
  if (Object.keys(projectedPatchedDependencies).length > 0) {
    projected.patchedDependencies = projectedPatchedDependencies;
  }
  if (Object.keys(overrides).length > 0) {
    projected.overrides = overrides;
  }
  // The closure manifest is fully pinned and has no catalog or package-extension
  // declarations. Keep the package/snapshot graph and integrity data from the
  // repository lock, but remove root-only configuration that would make pnpm
  // reject this intentionally projected importer under --frozen-lockfile.
  for (const key of [
    "catalogs",
    "packageExtensions",
    "packageExtensionsChecksum",
    "peerDependencyRules",
    "minimumReleaseAgeExclude",
  ]) {
    delete projected[key];
  }
  return { lockfile: projected, dependencies: exactDependencies };
};

const copyRelevantPatches = async (
  rootDir: string,
  installRoot: string,
  patchedDependencies: Record<string, string>,
): Promise<void> => {
  for (const relative of new Set(Object.values(patchedDependencies))) {
    const source = NodePath.resolve(rootDir, relative);
    if (!isInside(NodePath.join(rootDir, "patches"), source)) {
      throw new TauriServerClosureError(
        "invalid-input",
        `Unsafe workspace patch path: ${relative}.`,
      );
    }
    await assertFile(source, "selected workspace patch");
    const destination = NodePath.resolve(installRoot, relative);
    await NodeFS.mkdir(NodePath.dirname(destination), { recursive: true });
    await NodeFS.copyFile(source, destination);
  }
};

const pruneInstall = async (installRoot: string, platform: Platform, arch: Arch): Promise<void> => {
  const modules = NodePath.join(installRoot, "node_modules");
  await NodeFS.rm(NodePath.join(modules, ".bin"), { recursive: true, force: true });
  await NodeFS.rm(NodePath.join(installRoot, "pnpm-lock.yaml"), { force: true });
  const prebuilds = NodePath.join(modules, "node-pty", "prebuilds");
  try {
    const keep = new Set([
      `${platform === "mac" ? "darwin" : platform === "win" ? "win32" : "linux"}-${arch}`,
      ...(platform === "win" ? [`linux-${arch}`] : []),
    ]);
    for (const entry of await NodeFS.readdir(prebuilds, { withFileTypes: true })) {
      if (entry.isDirectory() && !keep.has(entry.name)) {
        await NodeFS.rm(NodePath.join(prebuilds, entry.name), { recursive: true, force: true });
      }
    }
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }
  await pruneMuslNatives(modules);
};

const pruneMuslNatives = async (directory: string): Promise<void> => {
  let entries;
  try {
    entries = await NodeFS.readdir(directory, { withFileTypes: true });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
    throw cause;
  }
  for (const entry of entries) {
    const path = NodePath.join(directory, entry.name);
    if (entry.name.includes(".musl.") || entry.name.endsWith("-musl")) {
      await NodeFS.rm(path, { recursive: true, force: true });
      continue;
    }
    if (entry.isDirectory()) await pruneMuslNatives(path);
  }
};

const assertInstalledDependencies = async (
  installRoot: string,
  dependencies: ReadonlyArray<string>,
): Promise<void> => {
  for (const dependency of dependencies) {
    const path = NodePath.join(installRoot, "node_modules", ...dependency.split("/"));
    try {
      await NodeFS.lstat(path);
    } catch (cause) {
      throw new TauriServerClosureError(
        "missing-runtime-dependency",
        `Production install omitted '${dependency}' at ${path}.`,
        { cause },
      );
    }
  }
};

const publishAtomically = async (publishRoot: string, outputRoot: string): Promise<void> => {
  const previousRoot = `${outputRoot}.previous-${randomSuffix()}`;
  let hadPrevious = false;
  try {
    await NodeFS.mkdir(NodePath.dirname(outputRoot), { recursive: true });
    try {
      const current = await NodeFS.lstat(outputRoot);
      if (!current.isDirectory()) {
        throw new TauriServerClosureError(
          "invalid-input",
          `outputRoot must be a directory when it exists: ${outputRoot}.`,
        );
      }
      await NodeFS.rename(outputRoot, previousRoot);
      hadPrevious = true;
    } catch (cause) {
      if (cause instanceof TauriServerClosureError) throw cause;
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
    try {
      await NodeFS.rename(publishRoot, outputRoot);
    } catch (cause) {
      if (hadPrevious) await NodeFS.rename(previousRoot, outputRoot).catch(() => undefined);
      throw cause;
    }
    if (hadPrevious) await NodeFS.rm(previousRoot, { recursive: true, force: true });
  } catch (cause) {
    if (cause instanceof TauriServerClosureError) throw cause;
    throw new TauriServerClosureError(
      "transaction-failed",
      `Unable to publish server closure at ${outputRoot}.`,
      { cause },
    );
  }
};

export const buildTauriServerClosure = async (
  options: TauriServerClosureOptions,
): Promise<TauriServerClosureResult> => {
  const rootDir = NodePath.resolve(options.rootDir ?? process.cwd());
  const serverPackagePath = NodePath.resolve(
    options.serverPackagePath ?? NodePath.join(rootDir, SERVER_PACKAGE_PATH),
  );
  const outputRoot = NodePath.resolve(options.outputRoot);
  const platform = normalizePlatform(options.platform);
  const arch = normalizeArch(options.arch);
  const sourceManifest = await readJson(
    NodePath.join(serverPackagePath, "package.json"),
    "apps/server/package.json",
  );
  const sourceDist = NodePath.join(serverPackagePath, "dist");
  await assertDirectory(sourceDist, "apps/server/dist");
  await assertFile(NodePath.join(sourceDist, "bin.mjs"), "apps/server/dist/bin.mjs");
  if (
    isInside(serverPackagePath, outputRoot) ||
    isInside(outputRoot, serverPackagePath) ||
    outputRoot === NodePath.parse(outputRoot).root
  ) {
    throw new TauriServerClosureError("invalid-input", `Unsafe outputRoot: ${outputRoot}.`);
  }

  const temporaryRoot = NodePath.resolve(
    options.temporaryRoot ?? `${outputRoot}.install-${randomSuffix()}`,
  );
  validatePrivateTemporaryRoot(temporaryRoot, rootDir, serverPackagePath, outputRoot);
  const publishRoot = `${outputRoot}.publish-${randomSuffix()}`;
  const { runtime, installed: unresolvedInstalled } = selectedDependencies(
    sourceManifest,
    platform,
    arch,
  );
  const rootManifest = await readJson(NodePath.join(rootDir, "package.json"), "root package.json");
  const rootLockfile = parseYaml(
    await NodeFS.readFile(NodePath.join(rootDir, "pnpm-lock.yaml"), "utf8"),
  ) as unknown;
  if (!isObject(rootLockfile)) {
    throw new TauriServerClosureError("invalid-input", "pnpm-lock.yaml must contain an object.");
  }
  const rootPackageManager = rootManifest.packageManager;
  if (typeof rootPackageManager !== "string" || !/^pnpm@[^@\s]+$/.test(rootPackageManager.trim())) {
    throw new TauriServerClosureError(
      "invalid-input",
      "root package.json must declare a pinned pnpm packageManager for the server closure.",
    );
  }
  const workspace = parseYaml(
    await NodeFS.readFile(NodePath.join(rootDir, "pnpm-workspace.yaml"), "utf8"),
  ) as unknown;
  if (!isObject(workspace)) {
    throw new TauriServerClosureError(
      "invalid-input",
      "pnpm-workspace.yaml must contain an object.",
    );
  }
  const catalog = recordOfStrings(workspace.catalog);
  const installed = resolveCatalogDependencies(unresolvedInstalled, catalog, "apps/server");
  const overrides = resolveCatalogDependencies(
    recordOfStrings(workspace.overrides),
    catalog,
    "apps/server",
  );
  const selectedPatches = createStagePatchedDependencies(
    recordOfStrings(workspace.patchedDependencies),
    installed,
  );
  const projectedLockfile = projectFrozenLockfile(
    rootLockfile,
    installed,
    selectedPatches,
    overrides,
  );
  const workspaceConfig = {
    ...createStageWorkspaceConfig({
      platform,
      arch,
      allowBuilds: recordOfBooleans(workspace.allowBuilds),
      patchedDependencies: selectedPatches,
      overrides,
      linuxServerBackend: platform === "win",
    }),
    // Isolated pnpm layouts are symlink farms. Tauri copies resources into a
    // .app / AppImage without preserving those links, so @ff-labs/fff-node
    // disappears at runtime. A hoisted tree is real directories.
    nodeLinker: "hoisted" as const,
  };
  const packageJson = {
    name: "agent-nanoni-server-closure",
    version: typeof sourceManifest.version === "string" ? sourceManifest.version : "0.0.0",
    private: true,
    type: "module",
    packageManager: rootPackageManager.trim(),
    bin: { t3: `./${TAURI_SERVER_ENTRY}` },
    dependencies: projectedLockfile.dependencies,
  };
  const limits = { ...TAURI_SERVER_CLOSURE_LIMITS, ...options.limits };
  if (
    !Number.isSafeInteger(limits.maxFileCount) ||
    limits.maxFileCount < 0 ||
    !Number.isSafeInteger(limits.maxBytes) ||
    limits.maxBytes < 0
  ) {
    throw new TauriServerClosureError(
      "invalid-input",
      "Closure limits must be safe non-negative integers.",
    );
  }

  try {
    await NodeFS.rm(temporaryRoot, { recursive: true, force: true });
    await NodeFS.rm(publishRoot, { recursive: true, force: true });
    const installDist = NodePath.join(temporaryRoot, SERVER_PACKAGE_PATH, "dist");
    await copyTree(sourceDist, installDist, sourceDist, installDist);
    await NodeFS.writeFile(
      NodePath.join(temporaryRoot, "package.json"),
      `${JSON.stringify(packageJson, null, 2)}\n`,
    );
    await NodeFS.writeFile(
      NodePath.join(temporaryRoot, "pnpm-workspace.yaml"),
      stringifyYaml(workspaceConfig),
    );
    await NodeFS.writeFile(
      NodePath.join(temporaryRoot, "pnpm-lock.yaml"),
      stringifyYaml(projectedLockfile.lockfile),
    );
    await copyRelevantPatches(rootDir, temporaryRoot, selectedPatches);

    const invocation: TauriServerClosureCommandInvocation = {
      command:
        options.packageManagerCommand?.trim() ||
        (process.platform === "win32" ? "corepack.cmd" : "corepack"),
      args: [
        ...(options.packageManagerCommand?.trim() ? [] : ["pnpm"]),
        "install",
        "--prod",
        "--frozen-lockfile",
      ],
      cwd: temporaryRoot,
      environment: {
        ...process.env,
        ...options.environment,
        COREPACK_ENABLE_PROJECT_SPEC: "1",
      },
      targetDir: temporaryRoot,
    };
    const commandResult = await (options.runCommand ?? defaultCommandRunner)(invocation);
    if (commandResult.exitCode !== 0) {
      const detail = [commandResult.stdout?.trim(), commandResult.stderr?.trim()]
        .filter(Boolean)
        .join("\n");
      throw new TauriServerClosureError(
        "command-failed",
        `Production closure install failed with exit code ${String(commandResult.exitCode)}.${detail ? `\n${detail}` : ""}`,
      );
    }
    await assertDirectory(NodePath.join(temporaryRoot, "node_modules"), "production node_modules");
    await pruneInstall(temporaryRoot, platform, arch);
    await assertInstalledDependencies(temporaryRoot, Object.keys(installed));

    const stats = await copyTree(temporaryRoot, publishRoot, temporaryRoot, publishRoot);
    if (stats.fileCount > limits.maxFileCount || stats.byteCount > limits.maxBytes) {
      throw new TauriServerClosureError(
        "payload-budget-exceeded",
        `Server closure is ${String(stats.fileCount)} files / ${String(stats.byteCount)} bytes; limits are ${String(limits.maxFileCount)} / ${String(limits.maxBytes)}.`,
      );
    }
    await assertFile(NodePath.join(publishRoot, TAURI_SERVER_ENTRY), "published server entry");
    await publishAtomically(publishRoot, outputRoot);
    return {
      outputRoot,
      entryPath: NodePath.join(outputRoot, TAURI_SERVER_ENTRY),
      nodeModulesPath: NodePath.join(outputRoot, "node_modules"),
      packageJsonPath: NodePath.join(outputRoot, "package.json"),
      workspacePath: NodePath.join(outputRoot, "pnpm-workspace.yaml"),
      fileCount: stats.fileCount,
      byteCount: stats.byteCount,
      externalDependencies: Object.keys(runtime).toSorted(),
      installedDependencies: Object.keys(installed).toSorted(),
    };
  } finally {
    await NodeFS.rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
    await NodeFS.rm(publishRoot, { recursive: true, force: true }).catch(() => undefined);
  }
};
