// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalRandom:off - This helper is a build-time filesystem boundary.

import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";

import { resolveProductVersion } from "../tauri/resolve-product-version.ts";

/** Environment values that must not be present before the Connect workstream. */
export const CLERK_ENVIRONMENT_KEYS = [
  "T3CODE_CLERK_PUBLISHABLE_KEY",
  "VITE_CLERK_PUBLISHABLE_KEY",
] as const;

/** The two paths consumed by a packaged Tauri host. */
export const TAURI_STAGE_LAYOUT = {
  server: "server",
  host: "host/host.cjs",
  resourceMonitor: "resource-monitor",
  licenses: "licenses",
  updateManifest: "app-update.yml",
} as const;

const CLERK_KEY_PATTERN = /\bpk_(?:live|test)_[A-Za-z0-9_-]+\b/;
const TEMP_DIRECTORY_SUFFIX = ".tmp";
const BACKUP_DIRECTORY_SUFFIX = ".previous";

/** A deliberately small filesystem surface so staging can be tested without a process runner. */
export interface TauriStageFileSystem {
  readonly lstat: typeof NodeFS.lstat;
  readonly readlink: typeof NodeFS.readlink;
  readonly readdir: typeof NodeFS.readdir;
  readonly mkdir: typeof NodeFS.mkdir;
  readonly copyFile: typeof NodeFS.copyFile;
  readonly chmod: typeof NodeFS.chmod;
  readonly symlink: typeof NodeFS.symlink;
  readonly rm: typeof NodeFS.rm;
  readonly rename: typeof NodeFS.rename;
  readonly readFile: typeof NodeFS.readFile;
}

const defaultFileSystem: TauriStageFileSystem = {
  lstat: NodeFS.lstat,
  readlink: NodeFS.readlink,
  readdir: NodeFS.readdir,
  mkdir: NodeFS.mkdir,
  copyFile: NodeFS.copyFile,
  chmod: NodeFS.chmod,
  symlink: NodeFS.symlink,
  rm: NodeFS.rm,
  rename: NodeFS.rename,
  readFile: NodeFS.readFile,
};

export interface TauriStageSources {
  /** A precomputed production server closure containing `apps/server/dist/**`. */
  readonly serverClosurePath?: string;
  /** Alias accepted by build callers that call the closure the server root. */
  readonly serverRootPath?: string;
  readonly hostBundlePath: string;
  readonly resourceMonitorPath: string;
  readonly licensesPath?: string;
  readonly appUpdateManifestPath?: string;
  /** One or more built web roots to inspect for Clerk publishable keys. */
  readonly clerkScanPaths?: ReadonlyArray<string>;
}

export interface TauriStageOptions extends TauriStageSources {
  /** Destination `src-tauri/stage` directory. The helper resolves it to an absolute path. */
  readonly stageRoot: string;
  readonly rootDir?: string;
  /** Product version override. When absent, the fork resolver is invoked. */
  readonly productVersion?: string;
  readonly channel?: "stable" | "nightly";
  readonly date?: string;
  readonly run?: number | string;
  /** Test/build integration seam; defaults to the fork's resolver. */
  readonly productVersionResolver?: (options: {
    readonly rootDir?: string;
    readonly channel?: "stable" | "nightly";
    readonly date?: string;
    readonly run?: number | string;
  }) => string | Promise<string>;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly fileSystem?: TauriStageFileSystem;
}

export interface TauriStageResult {
  readonly stageRoot: string;
  readonly productVersion: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly paths: {
    readonly serverRoot: string;
    readonly hostBundle: string;
    readonly resourceMonitor: string;
    readonly licenses: string;
    readonly appUpdateManifest: string;
  };
}

export class TauriStageError extends Error {
  readonly code:
    | "missing-product-version"
    | "missing-source"
    | "invalid-source"
    | "clerk-config-present"
    | "unsafe-symlink"
    | "transaction-failed";

  constructor(code: TauriStageError["code"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TauriStageError";
    this.code = code;
  }
}

const nonEmpty = (value: string | undefined, name: string): string => {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new TauriStageError("missing-source", `${name} must be a non-empty path.`);
  }
  return trimmed;
};

const resolveExistingSource = async (
  fs: TauriStageFileSystem,
  value: string | undefined,
  name: string,
): Promise<string> => {
  const source = nonEmpty(value, name);
  let info: Awaited<ReturnType<typeof NodeFS.lstat>>;
  try {
    info = await fs.lstat(source);
  } catch (cause) {
    throw new TauriStageError("missing-source", `${name} does not exist: ${source}`, { cause });
  }
  if (!info.isFile() && !info.isDirectory() && !info.isSymbolicLink()) {
    throw new TauriStageError("invalid-source", `${name} is not a file or directory: ${source}`);
  }
  return source;
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

const copyTree = async (
  fs: TauriStageFileSystem,
  source: string,
  destination: string,
  sourceRoot: string,
  destinationRoot: string,
): Promise<void> => {
  const info = await fs.lstat(source);
  if (info.isSymbolicLink()) {
    const linkTarget = await fs.readlink(source);
    const resolvedTarget = NodePath.resolve(NodePath.dirname(source), linkTarget);
    if (!isInside(sourceRoot, resolvedTarget)) {
      throw new TauriStageError(
        "unsafe-symlink",
        `Refusing to stage symlink outside the closure: ${source} -> ${linkTarget}`,
      );
    }
    const targetInfo = await fs.lstat(resolvedTarget);
    const destinationTarget = NodePath.relative(
      NodePath.dirname(destination),
      NodePath.join(destinationRoot, NodePath.relative(sourceRoot, resolvedTarget)),
    );
    await fs.symlink(
      destinationTarget,
      destination,
      targetInfo.isDirectory() ? "junction" : "file",
    );
    return;
  }

  if (info.isDirectory()) {
    await fs.mkdir(destination, { recursive: true });
    const entries = (await fs.readdir(source, { withFileTypes: true })).toSorted((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      await copyTree(
        fs,
        NodePath.join(source, entry.name),
        NodePath.join(destination, entry.name),
        sourceRoot,
        destinationRoot,
      );
    }
    return;
  }

  await fs.mkdir(NodePath.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
  // Preserve executable bits for host.cjs and resource-monitor. Node's copyFile
  // otherwise applies the process umask to a newly-created destination.
  await fs.chmod(destination, info.mode & 0o7777);
};

const scanTextFile = async (
  fs: TauriStageFileSystem,
  path: string,
  hits: string[],
): Promise<void> => {
  const info = await fs.lstat(path);
  if (!info.isFile() || info.size > 8 * 1024 * 1024) return;
  const contents = await fs.readFile(path, "utf8");
  if (CLERK_KEY_PATTERN.test(contents)) hits.push(path);
};

const scanClerkPath = async (
  fs: TauriStageFileSystem,
  path: string,
  hits: string[],
): Promise<void> => {
  const info = await fs.lstat(path);
  if (info.isSymbolicLink()) {
    throw new TauriStageError(
      "unsafe-symlink",
      `Refusing to scan a Clerk asset through a symlink: ${path}`,
    );
  }
  if (info.isFile()) {
    await scanTextFile(fs, path, hits);
    return;
  }
  if (!info.isDirectory()) return;
  const entries = (await fs.readdir(path, { withFileTypes: true })).toSorted((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const entry of entries) {
    // Dependencies are not a web build input and may contain fixture strings.
    // Skipping them keeps the assertion focused and makes scans deterministic.
    if (entry.isDirectory() && entry.name === "node_modules") continue;
    await scanClerkPath(fs, NodePath.join(path, entry.name), hits);
  }
};

export const assertClerkAbsent = async (
  paths: ReadonlyArray<string>,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  fileSystem: TauriStageFileSystem = defaultFileSystem,
): Promise<void> => {
  const configured = CLERK_ENVIRONMENT_KEYS.filter((name) => environment[name]?.trim());
  if (configured.length > 0) {
    throw new TauriStageError(
      "clerk-config-present",
      `Clerk configuration is not permitted in a Tauri stage (${configured.join(", ")}).`,
    );
  }

  const hits: string[] = [];
  for (const path of paths.toSorted()) {
    await scanClerkPath(fileSystem, path, hits);
  }
  if (hits.length > 0) {
    throw new TauriStageError(
      "clerk-config-present",
      `Clerk publishable key found in staged web assets: ${hits.toSorted().join(", ")}.`,
    );
  }
};

export const resolveStageProductVersion = async (options: {
  readonly rootDir?: string;
  readonly productVersion?: string;
  readonly channel?: "stable" | "nightly";
  readonly date?: string;
  readonly run?: number | string;
  readonly resolver?: TauriStageOptions["productVersionResolver"];
}): Promise<string> => {
  if (options.productVersion?.trim()) return options.productVersion.trim();
  const resolver = options.resolver ?? ((input) => resolveProductVersion(input));
  const resolved = await resolver({
    ...(options.rootDir === undefined ? {} : { rootDir: options.rootDir }),
    ...(options.channel === undefined ? {} : { channel: options.channel }),
    ...(options.date === undefined ? {} : { date: options.date }),
    ...(options.run === undefined ? {} : { run: options.run }),
  });
  if (!resolved.trim()) {
    throw new TauriStageError(
      "missing-product-version",
      "Product version resolver returned an empty value.",
    );
  }
  return resolved.trim();
};

const stagePath = (root: string, relative: string): string => NodePath.join(root, relative);

const randomSuffix = (): string =>
  `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;

/**
 * Stage the loose Tauri resources into one deterministic transaction.
 *
 * No build or process is launched here. Callers may use the returned
 * `environment` when invoking `tauri build`; in particular the product
 * version is always exported explicitly as `NANONI_PRODUCT_VERSION`.
 */
export const stageTauriResources = async (
  options: TauriStageOptions,
): Promise<TauriStageResult> => {
  const fs = options.fileSystem ?? defaultFileSystem;
  const stageRoot = NodePath.resolve(nonEmpty(options.stageRoot, "stageRoot"));
  const sourceServer = await resolveExistingSource(
    fs,
    options.serverClosurePath ?? options.serverRootPath,
    "serverClosurePath",
  );
  const hostBundle = await resolveExistingSource(fs, options.hostBundlePath, "hostBundlePath");
  const resourceMonitor = await resolveExistingSource(
    fs,
    options.resourceMonitorPath,
    "resourceMonitorPath",
  );
  const licenses = options.licensesPath
    ? await resolveExistingSource(fs, options.licensesPath, "licensesPath")
    : undefined;
  const updateManifest = options.appUpdateManifestPath
    ? await resolveExistingSource(fs, options.appUpdateManifestPath, "appUpdateManifestPath")
    : undefined;
  const productVersion = await resolveStageProductVersion({
    ...options,
    resolver: options.productVersionResolver,
  });
  const environment = {
    ...process.env,
    ...options.environment,
    NANONI_PRODUCT_VERSION: productVersion,
  };
  await assertClerkAbsent(options.clerkScanPaths ?? [], environment, fs);

  const tempRoot = `${stageRoot}${TEMP_DIRECTORY_SUFFIX}-${randomSuffix()}`;
  const backupRoot = `${stageRoot}${BACKUP_DIRECTORY_SUFFIX}-${randomSuffix()}`;
  try {
    await fs.rm(tempRoot, { recursive: true, force: true });
    await fs.mkdir(tempRoot, { recursive: true });

    await copyTree(
      fs,
      sourceServer,
      stagePath(tempRoot, TAURI_STAGE_LAYOUT.server),
      sourceServer,
      stagePath(tempRoot, TAURI_STAGE_LAYOUT.server),
    );
    await copyTree(
      fs,
      hostBundle,
      stagePath(tempRoot, TAURI_STAGE_LAYOUT.host),
      hostBundle,
      stagePath(tempRoot, TAURI_STAGE_LAYOUT.host),
    );
    await copyTree(
      fs,
      resourceMonitor,
      stagePath(
        tempRoot,
        NodePath.join(TAURI_STAGE_LAYOUT.resourceMonitor, NodePath.basename(resourceMonitor)),
      ),
      resourceMonitor,
      stagePath(
        tempRoot,
        NodePath.join(TAURI_STAGE_LAYOUT.resourceMonitor, NodePath.basename(resourceMonitor)),
      ),
    );
    if (licenses) {
      await copyTree(
        fs,
        licenses,
        stagePath(tempRoot, TAURI_STAGE_LAYOUT.licenses),
        licenses,
        stagePath(tempRoot, TAURI_STAGE_LAYOUT.licenses),
      );
    }
    if (updateManifest) {
      await copyTree(
        fs,
        updateManifest,
        stagePath(tempRoot, TAURI_STAGE_LAYOUT.updateManifest),
        updateManifest,
        stagePath(tempRoot, TAURI_STAGE_LAYOUT.updateManifest),
      );
    }

    let hadPrevious = false;
    try {
      await fs.rename(stageRoot, backupRoot);
      hadPrevious = true;
    } catch (cause) {
      const errorCode = (cause as NodeJS.ErrnoException).code;
      if (errorCode !== "ENOENT") throw cause;
    }
    try {
      await fs.rename(tempRoot, stageRoot);
    } catch (cause) {
      if (hadPrevious) {
        await fs.rename(backupRoot, stageRoot).catch(() => undefined);
      }
      throw cause;
    }
    if (hadPrevious) await fs.rm(backupRoot, { recursive: true, force: true });
  } catch (cause) {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    if (cause instanceof TauriStageError) throw cause;
    throw new TauriStageError(
      "transaction-failed",
      `Unable to stage Tauri resources at ${stageRoot}.`,
      {
        cause,
      },
    );
  }

  return {
    stageRoot,
    productVersion,
    environment,
    paths: {
      serverRoot: stagePath(stageRoot, TAURI_STAGE_LAYOUT.server),
      hostBundle: stagePath(stageRoot, TAURI_STAGE_LAYOUT.host),
      resourceMonitor: stagePath(
        stageRoot,
        NodePath.join(TAURI_STAGE_LAYOUT.resourceMonitor, NodePath.basename(resourceMonitor)),
      ),
      licenses: stagePath(stageRoot, TAURI_STAGE_LAYOUT.licenses),
      appUpdateManifest: stagePath(stageRoot, TAURI_STAGE_LAYOUT.updateManifest),
    },
  };
};

export const stageTauri = stageTauriResources;
