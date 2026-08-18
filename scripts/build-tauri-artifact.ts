#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - This is the explicit build-time process/filesystem boundary.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";

import { NODE_SIDECAR_NAME, resolveNodeSidecarTriple } from "./fetch-node-sidecar.ts";
import {
  assertClerkAbsent,
  stageTauriResources,
  type TauriStageResult,
  type TauriStageSources,
} from "./lib/tauri-stage.ts";
import {
  resolveProductVersionMetadata,
  type ProductVersionChannel,
  type ProductVersionMetadata,
  type ResolveProductVersionOptions,
} from "./tauri/resolve-product-version.ts";

export type TauriArtifactPlatform = "mac" | "linux" | "win";
export type TauriArtifactArch = "arm64" | "x64";

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
  readonly writeOverlay?: (path: string, contents: string) => Promise<void>;
  readonly prepare?: TauriArtifactPrepareHook;
  readonly build?: TauriArtifactHook;
  readonly smoke?: TauriArtifactHook;
}

export interface BuildTauriArtifactOptions extends TauriStageSources {
  readonly rootDir?: string;
  readonly platform: TauriArtifactPlatform;
  readonly arch: TauriArtifactArch;
  readonly stageRoot: string;
  readonly frontendDist: string;
  readonly nodeSidecarPath: string;
  readonly nodeLicensePath: string;
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
  readonly hooks: {
    readonly build: boolean;
    readonly smoke: ReadonlyArray<"normal" | "forced-kill">;
  };
}

export class TauriArtifactError extends Error {
  readonly code: "missing-input" | "invalid-input" | "clerk-config-present";

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

export const createTauriConfigOverlay = (input: {
  readonly productVersion: string;
  readonly frontendDist: string;
  readonly stageRoot: string;
}): TauriConfigOverlay => ({
  version: input.productVersion,
  build: { frontendDist: NodePath.resolve(input.frontendDist) },
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

  // Scan the actual staged output as well as inputs. A key accidentally emitted
  // by a host/server build must fail before tauri consumes the stage.
  await clerkCheck([stageRoot], {});

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

const createCliHooks = (rootDir: string, binaryPath: string | undefined) => {
  const vpCli = NodePath.join(rootDir, "node_modules/vite-plus/dist/bin.js");
  const tauriCli = NodePath.join(rootDir, "apps/desktop/node_modules/@tauri-apps/cli/tauri.js");
  const prepare: TauriArtifactPrepareHook = async (context) => {
    const options = { cwd: rootDir, environment: context.environment };
    await spawnCommand(process.execPath, [vpCli, "run", "--filter", "t3", "build"], options);
    await spawnCommand(
      process.execPath,
      [vpCli, "run", "--filter", "@t3tools/desktop", "build:tauri-host"],
      options,
    );
  };
  const build: TauriArtifactHook = async (context) => {
    await spawnCommand(
      process.execPath,
      [tauriCli, "build", "--debug", "--config", context.configOverlayPath],
      { cwd: rootDir, environment: context.environment },
    );
  };
  const smoke: TauriArtifactHook = async (context) => {
    if (!binaryPath) {
      throw new Error("A Tauri binary is required for smoke tests; pass --binary.");
    }
    await spawnCommand(
      process.execPath,
      [
        NodePath.join(rootDir, "apps/desktop/scripts/tauri/smoke-test.mjs"),
        "--bundle",
        binaryPath,
        ...(context.smokeVariant === "forced-kill" ? ["--kill-host"] : []),
      ],
      {
        cwd: rootDir,
        environment: context.environment,
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
  readonly productVersion: string;
  readonly channel?: ProductVersionChannel;
  readonly date?: string;
  readonly run?: string;
  readonly configOverlayPath?: string;
  readonly binaryPath?: string;
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
    stageRoot: defaults.stageRoot ?? NodePath.join(rootDir, "apps/desktop/src-tauri/stage"),
    frontendDist: defaults.frontendDist ?? NodePath.join(rootDir, "apps/server/dist/client"),
    hostBundlePath:
      defaults.hostBundlePath ?? NodePath.join(rootDir, "apps/desktop/dist-tauri-host/host.cjs"),
    skipBuild: defaults.skipBuild ?? false,
    skipSmoke: defaults.skipSmoke ?? false,
    ...(defaults.serverClosurePath === undefined
      ? {}
      : { serverClosurePath: defaults.serverClosurePath }),
    ...(defaults.nodeSidecarPath === undefined
      ? {}
      : { nodeSidecarPath: defaults.nodeSidecarPath }),
    ...(defaults.resourceMonitorPath === undefined
      ? {}
      : { resourceMonitorPath: defaults.resourceMonitorPath }),
    ...(defaults.nodeLicensePath === undefined
      ? {}
      : { nodeLicensePath: defaults.nodeLicensePath }),
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
    if (argument === "--skip-build") values.skipBuild = true;
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

  const required = [
    ["--server", values.serverClosurePath],
    ["--node", values.nodeSidecarPath],
    ["--node-license", values.nodeLicensePath],
    ["--resource-monitor", values.resourceMonitorPath],
    ["--product-version", values.productVersion],
  ] as const;
  for (const [flag, value] of required) if (!value) throw new Error(`${flag} is required.`);
  if (!values.skipSmoke && !values.binaryPath) {
    throw new Error("--binary is required unless --skip-smoke is set.");
  }
  return values as TauriArtifactCliOptions;
};

export const runTauriArtifactCli = async (
  args: ReadonlyArray<string> = process.argv.slice(2),
): Promise<BuildTauriArtifactResult> => {
  const parsed = parseTauriArtifactArguments(args);
  const cliHooks = createCliHooks(parsed.rootDir, parsed.binaryPath);
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
