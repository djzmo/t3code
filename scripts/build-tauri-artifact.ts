#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - This is the explicit build-time process/filesystem boundary.

import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";

import {
  acquireNodeSidecar,
  loadNodeSidecarConfig,
  NODE_SIDECAR_NAME,
  resolveNodeSidecarTriple,
} from "./fetch-node-sidecar.ts";
import { buildTauriServerClosure } from "./lib/tauri-server-closure.ts";
import {
  assertClerkAbsent,
  stageTauriResources,
  type TauriStageResult,
  type TauriStageSources,
} from "./lib/tauri-stage.ts";
import {
  validateTauriPayload,
  type TauriPayloadValidationOptions,
  type TauriPayloadValidationResult,
} from "./lib/tauri-payload-validation.ts";
import {
  resolveProductVersionMetadata,
  type ProductVersionChannel,
  type ProductVersionMetadata,
  type ResolveProductVersionOptions,
} from "./tauri/resolve-product-version.ts";

export type TauriArtifactPlatform = "mac" | "linux" | "win";
export type TauriArtifactArch = "arm64" | "x64";

/**
 * V4-final keeps the loose Tauri resource tree small enough for predictable
 * install time and packaging memory use. These production limits are frozen;
 * the orchestration dependency seam below exists only for focused tests.
 */
export const TAURI_ARTIFACT_PAYLOAD_LIMITS = Object.freeze({
  maxFileCount: 2_500,
  maxRegularFileBytes: 400 * 1024 * 1024,
});

export interface TauriArtifactPayloadLimits {
  readonly maxFileCount: number;
  readonly maxRegularFileBytes: number;
}

export interface TauriArtifactPayloadStats {
  /** Regular files plus symlinks. Directories are reported separately. */
  readonly fileCount: number;
  readonly regularFileCount: number;
  readonly symlinkCount: number;
  readonly directoryCount: number;
  readonly regularFileBytes: number;
}

export const TAURI_ARTIFACT_VERSION_ENVIRONMENT_KEYS = [
  "NANONI_PRODUCT_VERSION",
  "NANONI_COMPAT_SERVER_VERSION",
  "NANONI_UPSTREAM_TAG",
  "APP_VERSION",
] as const;

/** The config is intentionally narrow so base capabilities and windows remain authoritative. */
export interface TauriConfigOverlay {
  readonly version: string;
  readonly build: {
    readonly frontendDist: string;
  };
  readonly bundle: {
    readonly resources: Readonly<Record<string, string>>;
    readonly createUpdaterArtifacts: false;
  };
}

export interface TauriArtifactHookContext {
  readonly metadata: ProductVersionMetadata;
  readonly environment: Readonly<Record<string, string>>;
  readonly configOverlayPath: string;
  readonly configOverlay: TauriConfigOverlay;
  readonly stageRoot: string;
  readonly frontendDist: string;
  readonly nodeSidecarPath: string;
  readonly platform: TauriArtifactPlatform;
  readonly arch: TauriArtifactArch;
  readonly smokeVariant?: "normal" | "forced-kill";
  readonly binaryPath?: string;
}

export type TauriArtifactHook = (context: TauriArtifactHookContext) => void | Promise<void>;

export interface TauriArtifactPrepareContext {
  readonly metadata: ProductVersionMetadata;
  readonly environment: Readonly<Record<string, string>>;
  readonly rootDir: string;
  readonly platform: TauriArtifactPlatform;
  readonly arch: TauriArtifactArch;
}

export type TauriArtifactPrepareHook = (
  context: TauriArtifactPrepareContext,
) => void | Promise<void>;

export interface TauriArtifactFileSystem {
  readonly stat: typeof NodeFS.stat;
  readonly mkdir: typeof NodeFS.mkdir;
  readonly writeFile: typeof NodeFS.writeFile;
}

const defaultFileSystem: TauriArtifactFileSystem = {
  stat: NodeFS.stat,
  mkdir: NodeFS.mkdir,
  writeFile: NodeFS.writeFile,
};

export interface TauriArtifactDependencies {
  readonly fileSystem?: TauriArtifactFileSystem;
  readonly resolveMetadata?: (
    options: ResolveProductVersionOptions,
  ) => ProductVersionMetadata | Promise<ProductVersionMetadata>;
  readonly stageResources?: typeof stageTauriResources;
  readonly assertClerkAbsent?: typeof assertClerkAbsent;
  /** Test seam; production always runs the real staged-payload probes. */
  readonly validatePayload?: (
    options: TauriPayloadValidationOptions,
  ) => Promise<TauriPayloadValidationResult | undefined>;
  readonly writeOverlay?: (path: string, contents: string) => Promise<void>;
  readonly prepare?: TauriArtifactPrepareHook;
  readonly build?: TauriArtifactHook;
  readonly smoke?: TauriArtifactHook;
  /** Test-only limit override; the CLI never exposes this seam. */
  readonly payloadBudgetLimits?: Partial<TauriArtifactPayloadLimits>;
}

export interface BuildTauriArtifactOptions extends Omit<
  TauriStageSources,
  "appUpdateManifestPath"
> {
  readonly rootDir?: string;
  readonly platform: TauriArtifactPlatform;
  readonly arch: TauriArtifactArch;
  readonly stageRoot: string;
  readonly frontendDist: string;
  readonly nodeSidecarPath: string;
  readonly nodeLicensePath: string;
  readonly appUpdateManifestPath: string;
  readonly productVersion?: string;
  readonly channel?: ProductVersionChannel;
  readonly date?: string;
  readonly run?: number | string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /** Defaults to a generated file next to (not inside) the stage directory. */
  readonly configOverlayPath?: string;
  readonly binaryPath?: string;
  readonly dependencies?: TauriArtifactDependencies;
}

export interface BuildTauriArtifactResult {
  readonly metadata: ProductVersionMetadata;
  readonly environment: Readonly<Record<string, string>>;
  readonly stage: TauriStageResult;
  readonly nodeSidecarPath: string;
  readonly configOverlayPath: string;
  readonly configOverlay: TauriConfigOverlay;
  readonly payload: TauriArtifactPayloadStats;
  readonly payloadValidation?: TauriPayloadValidationResult;
  readonly hooks: {
    readonly build: boolean;
    readonly smoke: ReadonlyArray<"normal" | "forced-kill">;
  };
}

export class TauriArtifactError extends Error {
  readonly code:
    | "missing-input"
    | "invalid-input"
    | "clerk-config-present"
    | "payload-budget-exceeded"
    | "unsafe-payload"
    | "frontend-dist-not-relative";

  constructor(code: TauriArtifactError["code"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TauriArtifactError";
    this.code = code;
  }
}

const nonEmpty = (value: string | undefined, name: string): string => {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new TauriArtifactError("missing-input", `${name} must be a non-empty path.`);
  }
  return trimmed;
};

const normalizePlatform = (platform: string): TauriArtifactPlatform => {
  if (platform === "darwin" || platform === "mac") return "mac";
  if (platform === "linux") return "linux";
  if (platform === "win32" || platform === "windows" || platform === "win") return "win";
  throw new TauriArtifactError("invalid-input", `Unsupported Tauri platform '${platform}'.`);
};

const normalizeArch = (arch: string): TauriArtifactArch => {
  if (arch === "x64" || arch === "arm64") return arch;
  throw new TauriArtifactError("invalid-input", `Unsupported Tauri architecture '${arch}'.`);
};

export const resolveTauriArtifactPlatform = (platform = process.platform): TauriArtifactPlatform =>
  normalizePlatform(platform);

export const resolveTauriArtifactArch = (arch = process.arch): TauriArtifactArch => {
  if (arch === "x64" || arch === "arm64") return arch;
  throw new TauriArtifactError("invalid-input", `Unsupported Tauri architecture '${arch}'.`);
};

export const resolveNodeSidecarDestination = (platform: TauriArtifactPlatform): string =>
  `${NODE_SIDECAR_NAME}${platform === "win" ? ".exe" : ""}`;

export const resolveNodeSidecarSourceName = (
  platform: TauriArtifactPlatform,
  arch: TauriArtifactArch,
): string => {
  const triple = resolveNodeSidecarTriple(
    platform === "mac" ? "darwin" : platform === "win" ? "win32" : "linux",
    arch,
  );
  return `${NODE_SIDECAR_NAME}-${triple}${platform === "win" ? ".exe" : ""}`;
};

/**
 * Keep the build and smoke processes on one version contract. Existing NANONI_*
 * values are removed first so a shell's stale nightly/run value cannot leak into
 * a stable artifact.
 */
export const resolveTauriArtifactEnvironment = (
  metadata: ProductVersionMetadata,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined || key.startsWith("NANONI_")) continue;
    result[key] = value;
  }
  result.NANONI_PRODUCT_VERSION = metadata.productVersion;
  result.NANONI_COMPAT_SERVER_VERSION = metadata.compatibleServerVersion;
  result.NANONI_UPSTREAM_TAG = metadata.upstreamBaseTag;
  result.APP_VERSION = metadata.compatibleServerVersion;
  return result;
};

const assertFile = async (
  fs: TauriArtifactFileSystem,
  path: string | undefined,
  name: string,
): Promise<string> => {
  const resolved = nonEmpty(path, name);
  let info: Awaited<ReturnType<typeof NodeFS.stat>>;
  try {
    info = await fs.stat(resolved);
  } catch (cause) {
    throw new TauriArtifactError("missing-input", `${name} does not exist: ${resolved}`, { cause });
  }
  if (!info.isFile()) {
    throw new TauriArtifactError("invalid-input", `${name} must be a file: ${resolved}`);
  }
  return resolved;
};

const assertDirectory = async (
  fs: TauriArtifactFileSystem,
  path: string | undefined,
  name: string,
): Promise<string> => {
  const resolved = nonEmpty(path, name);
  let info: Awaited<ReturnType<typeof NodeFS.stat>>;
  try {
    info = await fs.stat(resolved);
  } catch (cause) {
    throw new TauriArtifactError("missing-input", `${name} does not exist: ${resolved}`, { cause });
  }
  if (!info.isDirectory()) {
    throw new TauriArtifactError("invalid-input", `${name} must be a directory: ${resolved}`);
  }
  return resolved;
};

const assertClerkConfigurationAbsent = (
  environment: Readonly<Record<string, string | undefined>>,
): void => {
  const configured = Object.entries(environment)
    .filter(
      ([key, value]) =>
        /^(?:T3CODE|VITE)_CLERK_/u.test(key) && typeof value === "string" && value.trim(),
    )
    .map(([key]) => key)
    .toSorted();
  if (configured.length > 0) {
    throw new TauriArtifactError(
      "clerk-config-present",
      `Clerk configuration is not permitted in a Tauri artifact until F11 (${configured.join(", ")}).`,
    );
  }
};

const defaultOverlayPath = (stageRoot: string): string =>
  NodePath.join(NodePath.dirname(stageRoot), "tauri.phase0.conf.json");

/** Absolute `frontendDist` makes wry load `file://`, which the shell's
 *  same-origin guard rejects. Keep the overlay path relative to `src-tauri`
 *  so Tauri serves the UI on `http://tauri.localhost`. */
export const toTauriOverlayFrontendDist = (frontendDist: string, stageRoot: string): string => {
  const srcTauriDir = NodePath.dirname(NodePath.resolve(stageRoot));
  const relative = NodePath.relative(srcTauriDir, NodePath.resolve(frontendDist));
  if (NodePath.isAbsolute(relative)) {
    throw new TauriArtifactError(
      "frontend-dist-not-relative",
      `frontendDist '${frontendDist}' is not relative to the Tauri crate at '${srcTauriDir}'.`,
    );
  }
  return (relative === "" ? "." : relative).split(NodePath.sep).join("/");
};

export const createTauriConfigOverlay = (input: {
  readonly productVersion: string;
  readonly frontendDist: string;
  readonly stageRoot: string;
}): TauriConfigOverlay => ({
  version: input.productVersion,
  build: { frontendDist: toTauriOverlayFrontendDist(input.frontendDist, input.stageRoot) },
  bundle: {
    // Tauri preserves directory structure for directory mappings. A glob map
    // would flatten every match into the destination and collide on common
    // names such as package.json.
    resources: { [`${NodePath.resolve(input.stageRoot)}${NodePath.sep}`]: "" },
    createUpdaterArtifacts: false,
  },
});

const writeOverlay = async (
  path: string,
  overlay: TauriConfigOverlay,
  fs: TauriArtifactFileSystem,
): Promise<void> => {
  await fs.mkdir(NodePath.dirname(path), { recursive: true });
  await fs.writeFile(path, `${JSON.stringify(overlay, null, 2)}\n`, "utf8");
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

const resolvePayloadLimits = (
  overrides: Partial<TauriArtifactPayloadLimits> | undefined,
): TauriArtifactPayloadLimits => {
  const limits = {
    ...TAURI_ARTIFACT_PAYLOAD_LIMITS,
    ...overrides,
  };
  if (
    !Number.isSafeInteger(limits.maxFileCount) ||
    limits.maxFileCount < 0 ||
    !Number.isSafeInteger(limits.maxRegularFileBytes) ||
    limits.maxRegularFileBytes < 0
  ) {
    throw new TauriArtifactError(
      "invalid-input",
      "Tauri payload budget limits must be non-negative safe integers.",
    );
  }
  return limits;
};

/**
 * Inspect a staged resource tree without ever following a symlink. The
 * acceptance count intentionally includes regular files and symlinks only;
 * directories are reported for diagnostics but do not consume the file budget.
 */
export const inspectTauriArtifactPayload = async (
  stageRoot: string,
  limits: TauriArtifactPayloadLimits = TAURI_ARTIFACT_PAYLOAD_LIMITS,
): Promise<TauriArtifactPayloadStats> => {
  const root = NodePath.resolve(stageRoot);
  const resolvedLimits = resolvePayloadLimits(limits);
  let fileCount = 0;
  let regularFileCount = 0;
  let symlinkCount = 0;
  let directoryCount = 0;
  let regularFileBytes = 0;

  const failBudget = (message: string): never => {
    throw new TauriArtifactError("payload-budget-exceeded", message);
  };

  const visit = async (path: string): Promise<void> => {
    let info: Awaited<ReturnType<typeof NodeFS.lstat>>;
    try {
      info = await NodeFS.lstat(path);
    } catch (cause) {
      throw new TauriArtifactError(
        "unsafe-payload",
        `Unable to inspect staged payload entry: ${path}.`,
        { cause },
      );
    }

    if (info.isSymbolicLink()) {
      let linkTarget: string;
      try {
        linkTarget = await NodeFS.readlink(path);
      } catch (cause) {
        throw new TauriArtifactError(
          "unsafe-payload",
          `Unable to read staged payload symlink: ${path}.`,
          { cause },
        );
      }
      const resolvedTarget = NodePath.resolve(NodePath.dirname(path), linkTarget);
      if (!isInside(root, resolvedTarget)) {
        throw new TauriArtifactError(
          "unsafe-payload",
          `Refusing staged payload symlink outside the stage: ${path} -> ${linkTarget}.`,
        );
      }
      fileCount += 1;
      symlinkCount += 1;
      if (fileCount > resolvedLimits.maxFileCount) {
        failBudget(
          `Staged Tauri payload contains ${String(fileCount)} files/symlinks; maximum is ${String(resolvedLimits.maxFileCount)}.`,
        );
      }
      return;
    }

    if (info.isDirectory()) {
      directoryCount += 1;
      let entries: ReadonlyArray<{ readonly name: string }>;
      try {
        entries = (await NodeFS.readdir(path, { withFileTypes: true })).toSorted((a, b) =>
          a.name.localeCompare(b.name),
        );
      } catch (cause) {
        throw new TauriArtifactError(
          "unsafe-payload",
          `Unable to inspect staged payload directory: ${path}.`,
          { cause },
        );
      }
      for (const entry of entries) await visit(NodePath.join(path, entry.name));
      return;
    }

    if (info.isFile()) {
      fileCount += 1;
      regularFileCount += 1;
      regularFileBytes += info.size;
      if (fileCount > resolvedLimits.maxFileCount) {
        failBudget(
          `Staged Tauri payload contains ${String(fileCount)} files/symlinks; maximum is ${String(resolvedLimits.maxFileCount)}.`,
        );
      }
      if (regularFileBytes > resolvedLimits.maxRegularFileBytes) {
        failBudget(
          `Staged Tauri payload contains ${String(regularFileBytes)} regular-file bytes; maximum is ${String(resolvedLimits.maxRegularFileBytes)}.`,
        );
      }
      return;
    }

    throw new TauriArtifactError(
      "unsafe-payload",
      `Unsupported filesystem entry in staged Tauri payload: ${path}.`,
    );
  };

  let rootInfo: Awaited<ReturnType<typeof NodeFS.lstat>>;
  try {
    rootInfo = await NodeFS.lstat(root);
  } catch (cause) {
    throw new TauriArtifactError(
      "unsafe-payload",
      `Unable to inspect staged payload root: ${root}.`,
      {
        cause,
      },
    );
  }
  if (!rootInfo.isDirectory()) {
    throw new TauriArtifactError(
      "unsafe-payload",
      `Staged payload root is not a directory: ${root}.`,
    );
  }
  await visit(root);
  return { fileCount, regularFileCount, symlinkCount, directoryCount, regularFileBytes };
};

export const buildTauriArtifact = async (
  options: BuildTauriArtifactOptions,
): Promise<BuildTauriArtifactResult> => {
  const dependencies = options.dependencies ?? {};
  const fs = dependencies.fileSystem ?? defaultFileSystem;
  const platform = normalizePlatform(options.platform);
  const arch = normalizeArch(options.arch);
  const rootDir = NodePath.resolve(options.rootDir ?? process.cwd());
  const stageRoot = NodePath.resolve(nonEmpty(options.stageRoot, "stageRoot"));
  const metadataResolver = dependencies.resolveMetadata ?? resolveProductVersionMetadata;
  const metadata = await metadataResolver({
    rootDir,
    ...(options.productVersion === undefined ? {} : { productVersion: options.productVersion }),
    ...(options.channel === undefined ? {} : { channel: options.channel }),
    ...(options.date === undefined ? {} : { date: options.date }),
    ...(options.run === undefined ? {} : { run: options.run }),
  });
  const environment = resolveTauriArtifactEnvironment(metadata, options.environment);
  assertClerkConfigurationAbsent(environment);
  await dependencies.prepare?.({ metadata, environment, rootDir, platform, arch });

  const frontendDist = await assertDirectory(fs, options.frontendDist, "frontendDist");
  const serverClosurePath = await assertDirectory(
    fs,
    options.serverClosurePath ?? options.serverRootPath,
    "serverClosurePath",
  );
  const hostBundlePath = await assertFile(fs, options.hostBundlePath, "hostBundlePath");
  const nodeSidecarPath = await assertFile(fs, options.nodeSidecarPath, "nodeSidecarPath");
  const resourceMonitorPath = await assertFile(
    fs,
    options.resourceMonitorPath,
    "resourceMonitorPath",
  );
  const nodeLicensePath = await assertFile(fs, options.nodeLicensePath, "nodeLicensePath");
  const appUpdateManifestPath = await assertFile(
    fs,
    options.appUpdateManifestPath,
    "appUpdateManifestPath",
  );

  const expectedNodeName = resolveNodeSidecarSourceName(platform, arch);
  const actualNodeName = NodePath.basename(nodeSidecarPath);
  if (actualNodeName !== expectedNodeName) {
    throw new TauriArtifactError(
      "invalid-input",
      `nodeSidecarPath must be the ${expectedNodeName} sidecar; received ${actualNodeName}.`,
    );
  }

  const scanPaths = [frontendDist, ...(options.clerkScanPaths ?? [])];
  const clerkCheck = dependencies.assertClerkAbsent ?? assertClerkAbsent;
  await clerkCheck(scanPaths, environment);

  const stageResources = dependencies.stageResources ?? stageTauriResources;
  const stage = await stageResources({
    ...options,
    stageRoot,
    serverClosurePath,
    hostBundlePath,
    resourceMonitorPath,
    nodeSidecarPath,
    nodeSidecarDestinationName: resolveNodeSidecarDestination(platform),
    nodeLicensePath,
    appUpdateManifestPath,
    productVersion: metadata.productVersion,
    environment,
    clerkScanPaths: scanPaths,
  });
  const stagedNodeSidecarPath = stage.paths.nodeSidecar;
  if (stagedNodeSidecarPath === undefined) {
    throw new TauriArtifactError(
      "missing-input",
      "The staging transaction omitted the Node sidecar.",
    );
  }

  const payload = await inspectTauriArtifactPayload(
    stageRoot,
    resolvePayloadLimits(dependencies.payloadBudgetLimits),
  );

  // Scan the actual staged output as well as inputs. A key accidentally emitted
  // by a host/server build must fail before tauri consumes the stage.
  await clerkCheck([stageRoot], {});

  const payloadValidation = await (dependencies.validatePayload ?? validateTauriPayload)({
    stageRoot,
    platform,
    nodeSidecarPath: stagedNodeSidecarPath,
  });

  const configOverlayPath = NodePath.resolve(
    options.configOverlayPath ?? defaultOverlayPath(stageRoot),
  );
  const configOverlay = createTauriConfigOverlay({
    productVersion: metadata.productVersion,
    frontendDist,
    stageRoot,
  });
  if (dependencies.writeOverlay) {
    await dependencies.writeOverlay(
      configOverlayPath,
      `${JSON.stringify(configOverlay, null, 2)}\n`,
    );
  } else {
    await writeOverlay(configOverlayPath, configOverlay, fs);
  }

  const baseContext = {
    metadata,
    environment,
    configOverlayPath,
    configOverlay,
    stageRoot,
    frontendDist,
    nodeSidecarPath: stagedNodeSidecarPath,
    platform,
    arch,
    ...(options.binaryPath === undefined ? {} : { binaryPath: options.binaryPath }),
  } satisfies TauriArtifactHookContext;

  if (dependencies.build) {
    await dependencies.build(baseContext);
    // The frontend/host build is allowed to emit files after the input scan;
    // inspect those outputs before either smoke variant launches the bundle.
    await clerkCheck([frontendDist, stageRoot], {});
  }
  const smokeVariants: Array<"normal" | "forced-kill"> = [];
  if (dependencies.smoke) {
    await dependencies.smoke({
      ...baseContext,
      smokeVariant: "normal",
      environment: { ...environment, AGENT_NANONI_SMOKE: "1" },
    });
    smokeVariants.push("normal");
    await dependencies.smoke({
      ...baseContext,
      smokeVariant: "forced-kill",
      environment: {
        ...environment,
        AGENT_NANONI_SMOKE: "1",
        AGENT_NANONI_SMOKE_KILL_HOST: "1",
      },
    });
    smokeVariants.push("forced-kill");
  }

  return {
    metadata,
    environment,
    stage,
    nodeSidecarPath: stagedNodeSidecarPath,
    configOverlayPath,
    configOverlay,
    payload,
    ...(payloadValidation === undefined ? {} : { payloadValidation }),
    hooks: { build: dependencies.build !== undefined, smoke: smokeVariants },
  };
};

interface SpawnCommandOptions {
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
}

const spawnCommand = (
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnCommandOptions,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(command, [...args], {
      cwd: options.cwd,
      env: options.environment,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) return resolve();
      reject(new Error(`${command} ${args.join(" ")} exited with ${signal ?? code ?? "unknown"}.`));
    });
  });

export const resolveTauriCliCwd = (rootDir: string): string =>
  NodePath.join(rootDir, "apps/desktop");

const TAURI_CLI_RUNNER =
  "require(process.argv[1]).run(process.argv.slice(2), 'tauri').catch((error) => { console.error(error.message); process.exit(1) })";

export const resolveTauriBuildArguments = (
  tauriCli: string,
  configOverlayPath: string,
  debug: boolean,
): ReadonlyArray<string> => [
  "-e",
  TAURI_CLI_RUNNER,
  tauriCli,
  "build",
  ...(debug ? ["--debug"] : []),
  "--config",
  configOverlayPath,
];

export const resolvePinnedNodeEnvironment = async (
  rootDir: string,
  environment: Readonly<Record<string, string>>,
  nodeExecutable = process.execPath,
): Promise<Readonly<Record<string, string>>> => {
  let nodeDirectory = NodePath.dirname(nodeExecutable);
  if (!/^node(?:\.exe)?$/i.test(NodePath.basename(nodeExecutable))) {
    const executableInfo = await NodeFS.stat(nodeExecutable);
    const shimIdentity = NodeCrypto.createHash("sha256")
      .update(NodePath.resolve(nodeExecutable))
      .update("\0")
      .update(String(executableInfo.size))
      .update("\0")
      .update(String(executableInfo.mtimeMs))
      .digest("hex")
      .slice(0, 16);
    nodeDirectory = NodePath.join(rootDir, ".t3/tauri-node-shim", shimIdentity);
    const shimPath = NodePath.join(
      nodeDirectory,
      process.platform === "win32" ? "node.exe" : "node",
    );
    await NodeFS.mkdir(nodeDirectory, { recursive: true });
    const temporaryShimPath = `${shimPath}.${process.pid}.${NodeCrypto.randomUUID()}.tmp`;
    await NodeFS.copyFile(nodeExecutable, temporaryShimPath);
    if (process.platform !== "win32") {
      await NodeFS.chmod(temporaryShimPath, executableInfo.mode & 0o777);
    }
    try {
      await NodeFS.rename(temporaryShimPath, shimPath);
    } catch (cause) {
      const installedShim = await NodeFS.stat(shimPath).catch(() => undefined);
      if (!installedShim?.isFile() || installedShim.size !== executableInfo.size) throw cause;
    } finally {
      await NodeFS.rm(temporaryShimPath, { force: true });
    }
  }
  const inheritedPath =
    environment.PATH ??
    (process.platform === "win32"
      ? Object.entries(environment).find(([key]) => key.toUpperCase() === "PATH")?.[1]
      : undefined) ??
    process.env.PATH ??
    "";
  const normalizedEnvironment =
    process.platform === "win32"
      ? Object.fromEntries(
          Object.entries(environment).filter(([key]) => key.toUpperCase() !== "PATH"),
        )
      : environment;
  return {
    ...normalizedEnvironment,
    PATH:
      inheritedPath.length === 0
        ? nodeDirectory
        : `${nodeDirectory}${NodePath.delimiter}${inheritedPath}`,
  };
};

export type TauriArtifactProfile = "debug" | "release";

export interface ResolveTauriSmokeBundleOptions {
  readonly rootDir: string;
  readonly platform: TauriArtifactPlatform;
  readonly profile: TauriArtifactProfile;
}

/**
 * Resolve the staged bundle that Tauri produced for a packaged smoke.
 *
 * The target binary is not a runnable packaged application on POSIX: it has
 * neither the resource tree nor the platform loader setup. Keep this lookup
 * deliberately strict so a smoke can never silently fall back to that bare
 * target or pick an arbitrary artifact from a dirty target directory.
 */
export const resolveTauriSmokeBundlePath = async ({
  rootDir,
  platform,
  profile,
}: ResolveTauriSmokeBundleOptions): Promise<string> => {
  if (platform === "win") {
    const executable = NodePath.resolve(
      rootDir,
      "apps/desktop/src-tauri/target",
      profile,
      "agent-nanoni-desktop.exe",
    );
    const stats = await NodeFS.stat(executable).catch((cause) => {
      throw new Error(`Windows smoke executable is unavailable: ${executable}`, { cause });
    });
    if (!stats.isFile()) {
      throw new Error(`Windows smoke executable is not a regular file: ${executable}`);
    }
    return executable;
  }

  const bundleRoot = NodePath.resolve(rootDir, "apps/desktop/src-tauri/target", profile, "bundle");
  const bundleDirectory = NodePath.join(bundleRoot, platform === "linux" ? "appimage" : "macos");
  const entries = await NodeFS.readdir(bundleDirectory, { withFileTypes: true }).catch((cause) => {
    throw new Error(`Tauri ${platform} smoke bundle directory is unavailable: ${bundleDirectory}`, {
      cause,
    });
  });

  if (platform === "linux") {
    const appImages = entries.filter((entry) => entry.name.toLowerCase().endsWith(".appimage"));
    if (appImages.length !== 1) {
      throw new Error(
        `Expected exactly one AppImage in ${bundleDirectory}; found ${appImages.length}.`,
      );
    }
    const appImage = appImages[0];
    if (appImage === undefined || !appImage.isFile()) {
      throw new Error(
        `Tauri AppImage is not a regular file: ${NodePath.join(bundleDirectory, appImage?.name ?? "?")}`,
      );
    }
    return NodePath.join(bundleDirectory, appImage.name);
  }

  const appBundles = entries.filter((entry) => entry.name.toLowerCase().endsWith(".app"));
  if (appBundles.length !== 1) {
    throw new Error(
      `Expected exactly one macOS .app bundle in ${bundleDirectory}; found ${appBundles.length}.`,
    );
  }
  const appBundle = appBundles[0];
  if (appBundle === undefined || !appBundle.isDirectory()) {
    throw new Error(
      `macOS app bundle is not a directory: ${NodePath.join(bundleDirectory, appBundle?.name ?? "?")}`,
    );
  }

  const executableDirectory = NodePath.join(bundleDirectory, appBundle.name, "Contents", "MacOS");
  const executableEntries = await NodeFS.readdir(executableDirectory, {
    withFileTypes: true,
  }).catch((cause) => {
    throw new Error(`macOS app executable directory is unavailable: ${executableDirectory}`, {
      cause,
    });
  });
  const executables = executableEntries.filter((entry) => entry.isFile());
  if (executables.length !== 1) {
    throw new Error(
      `Expected exactly one macOS app executable in ${executableDirectory}; found ${executables.length}.`,
    );
  }
  const executable = executables[0];
  if (executable === undefined) {
    throw new Error(`macOS app executable is missing: ${executableDirectory}`);
  }
  return NodePath.join(executableDirectory, executable.name);
};

const createCliHooks = (options: TauriArtifactCliOptions) => {
  const { rootDir, platform, arch } = options;
  const vpCli = NodePath.join(rootDir, "node_modules/vite-plus/dist/bin.js");
  const tauriCli = NodePath.join(rootDir, "apps/desktop/node_modules/@tauri-apps/cli/main.js");
  const prepare: TauriArtifactPrepareHook = async (context) => {
    const environment = await resolvePinnedNodeEnvironment(rootDir, context.environment);
    const commandOptions = { cwd: rootDir, environment };
    await spawnCommand(process.execPath, [vpCli, "run", "--filter", "t3", "build"], commandOptions);
    await spawnCommand(
      process.execPath,
      [vpCli, "run", "--filter", "@t3tools/desktop", "build:tauri-host"],
      commandOptions,
    );
    await spawnCommand(process.execPath, [vpCli, "run", "build:resource-monitor"], commandOptions);
    await buildTauriServerClosure({
      rootDir,
      outputRoot: options.serverClosurePath,
      platform,
      arch,
      environment,
    });
    const acquisition = await acquireNodeSidecar({
      config: loadNodeSidecarConfig(
        NodePath.join(rootDir, "apps/desktop/src-tauri/node-sidecar.json"),
      ),
      platform: platform === "win" ? "win32" : platform === "mac" ? "darwin" : "linux",
      arch,
      destinationDir: NodePath.dirname(options.nodeSidecarPath),
      isDev: false,
      env: environment,
    });
    if (
      NodePath.resolve(acquisition.path) !== NodePath.resolve(options.nodeSidecarPath) ||
      acquisition.licensePath === undefined ||
      NodePath.resolve(acquisition.licensePath) !== NodePath.resolve(options.nodeLicensePath)
    ) {
      throw new Error("Pinned Node acquisition did not produce the requested target paths.");
    }
  };
  const build: TauriArtifactHook = async (context) => {
    await spawnCommand(
      process.execPath,
      resolveTauriBuildArguments(tauriCli, context.configOverlayPath, options.debug),
      { cwd: resolveTauriCliCwd(rootDir), environment: context.environment },
    );
  };
  const smoke: TauriArtifactHook = async (context) => {
    const bundlePath =
      options.binaryPath ??
      (await resolveTauriSmokeBundlePath({
        rootDir,
        platform,
        profile: options.debug ? "debug" : "release",
      }));
    await spawnCommand(
      process.execPath,
      [
        NodePath.join(rootDir, "apps/desktop/scripts/tauri/smoke-test.mjs"),
        "--bundle",
        bundlePath,
        ...(context.smokeVariant === "forced-kill" ? ["--kill-host"] : []),
      ],
      {
        cwd: rootDir,
        environment: {
          ...context.environment,
          ...(platform === "linux" ? { APPIMAGE_EXTRACT_AND_RUN: "1" } : {}),
        },
      },
    );
  };
  return { prepare, build, smoke };
};

const readArgument = (args: ReadonlyArray<string>, index: number, flag: string): string => {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
};

export interface TauriArtifactCliOptions {
  readonly rootDir: string;
  readonly platform: TauriArtifactPlatform;
  readonly arch: TauriArtifactArch;
  readonly stageRoot: string;
  readonly frontendDist: string;
  readonly serverClosurePath: string;
  readonly hostBundlePath: string;
  readonly nodeSidecarPath: string;
  readonly resourceMonitorPath: string;
  readonly nodeLicensePath: string;
  readonly appUpdateManifestPath: string;
  readonly productVersion: string;
  readonly channel?: ProductVersionChannel;
  readonly date?: string;
  readonly run?: string;
  readonly configOverlayPath?: string;
  readonly binaryPath?: string;
  readonly debug: boolean;
  readonly skipBuild: boolean;
  readonly skipSmoke: boolean;
}

export const parseTauriArtifactArguments = (
  args: ReadonlyArray<string>,
  defaults: Partial<TauriArtifactCliOptions> = {},
): TauriArtifactCliOptions => {
  const rootDir =
    defaults.rootDir ?? NodePath.resolve(fileURLToPath(new URL("../", import.meta.url)));
  type MutableCliOptions = {
    -readonly [Key in keyof TauriArtifactCliOptions]?: TauriArtifactCliOptions[Key];
  };
  const values: MutableCliOptions = {
    rootDir,
    platform: defaults.platform ?? resolveTauriArtifactPlatform(),
    arch: defaults.arch ?? resolveTauriArtifactArch(),
    ...(defaults.stageRoot === undefined ? {} : { stageRoot: defaults.stageRoot }),
    ...(defaults.frontendDist === undefined ? {} : { frontendDist: defaults.frontendDist }),
    ...(defaults.hostBundlePath === undefined ? {} : { hostBundlePath: defaults.hostBundlePath }),
    ...(defaults.serverClosurePath === undefined
      ? {}
      : { serverClosurePath: defaults.serverClosurePath }),
    ...(defaults.nodeSidecarPath === undefined
      ? {}
      : { nodeSidecarPath: defaults.nodeSidecarPath }),
    ...(defaults.nodeLicensePath === undefined
      ? {}
      : { nodeLicensePath: defaults.nodeLicensePath }),
    ...(defaults.resourceMonitorPath === undefined
      ? {}
      : { resourceMonitorPath: defaults.resourceMonitorPath }),
    ...(defaults.appUpdateManifestPath === undefined
      ? {}
      : { appUpdateManifestPath: defaults.appUpdateManifestPath }),
    debug: defaults.debug ?? false,
    skipBuild: defaults.skipBuild ?? false,
    skipSmoke: defaults.skipSmoke ?? false,
    ...(defaults.productVersion === undefined ? {} : { productVersion: defaults.productVersion }),
    ...(defaults.channel === undefined ? {} : { channel: defaults.channel }),
    ...(defaults.date === undefined ? {} : { date: defaults.date }),
    ...(defaults.run === undefined ? {} : { run: defaults.run }),
    ...(defaults.configOverlayPath === undefined
      ? {}
      : { configOverlayPath: defaults.configOverlayPath }),
    ...(defaults.binaryPath === undefined ? {} : { binaryPath: defaults.binaryPath }),
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--debug") values.debug = true;
    else if (argument === "--skip-build") values.skipBuild = true;
    else if (argument === "--skip-smoke") values.skipSmoke = true;
    else if (argument === "--root") values.rootDir = readArgument(args, index++, argument);
    else if (argument === "--platform")
      values.platform = normalizePlatform(readArgument(args, index++, argument));
    else if (argument === "--arch")
      values.arch = normalizeArch(readArgument(args, index++, argument));
    else if (argument === "--stage-root") values.stageRoot = readArgument(args, index++, argument);
    else if (argument === "--frontend-dist")
      values.frontendDist = readArgument(args, index++, argument);
    else if (argument === "--server")
      values.serverClosurePath = readArgument(args, index++, argument);
    else if (argument === "--host") values.hostBundlePath = readArgument(args, index++, argument);
    else if (argument === "--node") values.nodeSidecarPath = readArgument(args, index++, argument);
    else if (argument === "--resource-monitor")
      values.resourceMonitorPath = readArgument(args, index++, argument);
    else if (argument === "--node-license")
      values.nodeLicensePath = readArgument(args, index++, argument);
    else if (argument === "--app-update")
      values.appUpdateManifestPath = readArgument(args, index++, argument);
    else if (argument === "--product-version")
      values.productVersion = readArgument(args, index++, argument);
    else if (argument === "--channel") {
      const channel = readArgument(args, index++, argument);
      if (channel !== "stable" && channel !== "nightly")
        throw new Error(`Unsupported channel '${channel}'.`);
      values.channel = channel;
    } else if (argument === "--date") values.date = readArgument(args, index++, argument);
    else if (argument === "--run") values.run = readArgument(args, index++, argument);
    else if (argument === "--config-overlay")
      values.configOverlayPath = readArgument(args, index++, argument);
    else if (argument === "--binary") values.binaryPath = readArgument(args, index++, argument);
    else throw new Error(`Unknown Tauri artifact option '${argument}'.`);
  }

  const finalRoot = values.rootDir ?? rootDir;
  const finalPlatform = values.platform ?? resolveTauriArtifactPlatform();
  const finalArch = values.arch ?? resolveTauriArtifactArch();
  values.stageRoot ??= NodePath.join(finalRoot, "apps/desktop/src-tauri/stage");
  values.frontendDist ??= NodePath.join(finalRoot, "apps/server/dist/client");
  values.hostBundlePath ??= NodePath.join(finalRoot, "apps/desktop/dist-tauri-host/host.cjs");
  values.serverClosurePath ??= NodePath.join(
    finalRoot,
    ".t3/tauri-server-closure",
    `${finalPlatform}-${finalArch}`,
  );
  values.nodeSidecarPath ??= NodePath.join(
    finalRoot,
    "apps/desktop/src-tauri/binaries",
    resolveNodeSidecarSourceName(finalPlatform, finalArch),
  );
  values.nodeLicensePath ??= NodePath.join(
    finalRoot,
    "apps/desktop/src-tauri/binaries/NODE_LICENSE.txt",
  );
  values.resourceMonitorPath ??= NodePath.join(
    finalRoot,
    "native/resource-monitor/target/release",
    finalPlatform === "win" ? "t3-resource-monitor.exe" : "t3-resource-monitor",
  );
  values.appUpdateManifestPath ??= NodePath.join(
    finalRoot,
    "apps/desktop/src-tauri/app-update.yml",
  );

  const required = [
    ["--server", values.serverClosurePath],
    ["--node", values.nodeSidecarPath],
    ["--node-license", values.nodeLicensePath],
    ["--app-update", values.appUpdateManifestPath],
    ["--resource-monitor", values.resourceMonitorPath],
    ["--product-version", values.productVersion],
  ] as const;
  for (const [flag, value] of required) if (!value) throw new Error(`${flag} is required.`);
  return values as TauriArtifactCliOptions;
};

export const runTauriArtifactCli = async (
  args: ReadonlyArray<string> = process.argv.slice(2),
): Promise<BuildTauriArtifactResult> => {
  const parsed = parseTauriArtifactArguments(args);
  const cliHooks = createCliHooks(parsed);
  return buildTauriArtifact({
    ...parsed,
    dependencies: {
      ...(parsed.skipBuild ? {} : { prepare: cliHooks.prepare, build: cliHooks.build }),
      ...(parsed.skipSmoke ? {} : { smoke: cliHooks.smoke }),
    },
  });
};

if (import.meta.main) {
  runTauriArtifactCli().catch((cause) => {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exitCode = 1;
  });
}
