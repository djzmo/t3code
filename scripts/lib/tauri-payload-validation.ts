// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalRandom:off globalTimers:off - Explicit build-time filesystem/process boundary.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export const TAURI_PAYLOAD_SERVER_ENTRY = "server/apps/server/dist/bin.mjs" as const;
export const TAURI_PAYLOAD_FFF_ENTRY =
  "server/node_modules/@ff-labs/fff-node/dist/src/index.js" as const;
export const TAURI_PAYLOAD_HOST_ENTRY = "host/host.cjs" as const;
export const TAURI_PAYLOAD_NODE_SIDECAR_NAMES = Object.freeze({
  win: "agent-nanoni-node.exe",
  mac: "agent-nanoni-node",
  linux: "agent-nanoni-node",
});

const FFF_PROBE_SOURCE = `
const { join } = await import("node:path");
const { pathToFileURL } = await import("node:url");
const { FileFinder } = await import(pathToFileURL(process.argv[1]).href);
const probeRoot = process.argv[2];
const result = FileFinder.create({
  basePath: probeRoot,
  frecencyDbPath: join(probeRoot, "frecency.mdb"),
  historyDbPath: join(probeRoot, "history.mdb"),
  disableWatch: true,
  disableMmapCache: true,
  disableContentIndexing: true,
});
if (!result.ok) throw new Error(result.error);
result.value.destroy();
`;

const ELECTRON_IMPORT_PATTERN =
  /(?:require\s*\(\s*['"](?:node:)?electron(?:\/[^'"]*)?['"]\s*\)|import\s*\(\s*['"](?:node:)?electron(?:\/[^'"]*)?['"]\s*\)|import\s+['"](?:node:)?electron(?:\/[^'"]*)?['"]|from\s+['"](?:node:)?electron(?:\/[^'"]*)?['"])/g;

export type TauriPayloadValidationPlatform = "mac" | "linux" | "win";

export interface TauriPayloadValidationCommandResult {
  readonly exitCode: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly timedOut?: boolean;
}

export interface TauriPayloadValidationCommandInvocation {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
}

export type TauriPayloadValidationCommandRunner = (
  invocation: TauriPayloadValidationCommandInvocation,
) => Promise<TauriPayloadValidationCommandResult>;

export interface TauriPayloadValidationOptions {
  /** Root of the exact resource tree that will be passed to Tauri. */
  readonly stageRoot: string;
  /** Optional explicit staged Node executable; defaults to the target platform name. */
  readonly nodeSidecarPath?: string;
  readonly platform?: TauriPayloadValidationPlatform;
  /** Test seam; production uses the bounded child-process runner below. */
  readonly runCommand?: TauriPayloadValidationCommandRunner;
}

export interface TauriPayloadValidationCommandEvidence
  extends TauriPayloadValidationCommandInvocation, TauriPayloadValidationCommandResult {
  readonly operation: "server-version" | "fff-native-load";
}

export interface TauriPayloadValidationResult {
  readonly stageRoot: string;
  readonly nodeSidecarPath: string;
  readonly serverEntryPath: string;
  readonly fffEntryPath: string;
  readonly hostBundlePath: string;
  readonly serverVersion: TauriPayloadValidationCommandEvidence;
  readonly fffNativeLoad: TauriPayloadValidationCommandEvidence;
  readonly host: {
    readonly path: string;
    /** Empty means no runtime Electron import/requires were found. */
    readonly electronImports: ReadonlyArray<string>;
  };
}

export class TauriPayloadValidationError extends Error {
  readonly code:
    | "missing-input"
    | "invalid-input"
    | "command-failed"
    | "native-load-failed"
    | "electron-import";
  readonly operation?: "server-version" | "fff-native-load" | undefined;
  readonly commandResult?: TauriPayloadValidationCommandResult | undefined;
  readonly matches?: ReadonlyArray<string> | undefined;

  constructor(
    code: TauriPayloadValidationError["code"],
    message: string,
    options?: {
      readonly cause?: unknown;
      readonly operation?: "server-version" | "fff-native-load";
      readonly commandResult?: TauriPayloadValidationCommandResult;
      readonly matches?: ReadonlyArray<string>;
    },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "TauriPayloadValidationError";
    this.code = code;
    this.operation = options?.operation;
    this.commandResult = options?.commandResult;
    this.matches = options?.matches;
  }
}

const isInside = (root: string, candidate: string): boolean => {
  const relative = NodePath.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${NodePath.sep}`) &&
      !NodePath.isAbsolute(relative))
  );
};

const normalizePlatform = (platform: TauriPayloadValidationPlatform | undefined) => {
  if (platform !== undefined) return platform;
  if (process.platform === "win32") return "win" as const;
  if (process.platform === "darwin") return "mac" as const;
  return "linux" as const;
};

const assertDirectory = async (path: string, name: string): Promise<void> => {
  try {
    const info = await NodeFS.lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new TauriPayloadValidationError("invalid-input", `${name} is not a directory: ${path}`);
    }
  } catch (cause) {
    if (cause instanceof TauriPayloadValidationError) throw cause;
    throw new TauriPayloadValidationError("missing-input", `${name} does not exist: ${path}`, {
      cause,
    });
  }
};

const assertFileInside = async (root: string, path: string, name: string): Promise<void> => {
  if (!isInside(root, path)) {
    throw new TauriPayloadValidationError(
      "invalid-input",
      `${name} must be inside the staged payload: ${path}`,
    );
  }
  try {
    const info = await NodeFS.lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new TauriPayloadValidationError(
        "invalid-input",
        `${name} is not a regular file: ${path}`,
      );
    }
  } catch (cause) {
    if (cause instanceof TauriPayloadValidationError) throw cause;
    throw new TauriPayloadValidationError("missing-input", `${name} does not exist: ${path}`, {
      cause,
    });
  }
};

const defaultCommandRunner: TauriPayloadValidationCommandRunner = async (invocation) => {
  const child = NodeChildProcess.spawn(invocation.command, [...invocation.args], {
    cwd: invocation.cwd,
    env: invocation.environment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));

  return await new Promise<TauriPayloadValidationCommandResult>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({
        exitCode: -1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut: true,
      });
    }, 120_000);
    child.once("error", (cause) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(cause);
    });
    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({
        exitCode: exitCode ?? 1,
        ...(stdout.length === 0 ? {} : { stdout: Buffer.concat(stdout).toString("utf8") }),
        ...(stderr.length === 0 ? {} : { stderr: Buffer.concat(stderr).toString("utf8") }),
      });
    });
  });
};

const commandEvidence = (
  operation: TauriPayloadValidationCommandEvidence["operation"],
  invocation: TauriPayloadValidationCommandInvocation,
  result: TauriPayloadValidationCommandResult,
): TauriPayloadValidationCommandEvidence => ({ operation, ...invocation, ...result });

const execute = async (
  operation: TauriPayloadValidationCommandEvidence["operation"],
  invocation: TauriPayloadValidationCommandInvocation,
  runCommand: TauriPayloadValidationCommandRunner,
): Promise<TauriPayloadValidationCommandEvidence> => {
  let result: TauriPayloadValidationCommandResult;
  try {
    result = await runCommand(invocation);
  } catch (cause) {
    throw new TauriPayloadValidationError(
      operation === "fff-native-load" ? "native-load-failed" : "command-failed",
      `${operation} command could not be started.`,
      { cause, operation },
    );
  }
  const evidence = commandEvidence(operation, invocation, result);
  if (result.exitCode !== 0 || result.timedOut === true) {
    throw new TauriPayloadValidationError(
      operation === "fff-native-load" ? "native-load-failed" : "command-failed",
      `${operation} command failed (exit ${String(result.exitCode)}).${result.timedOut ? " The command timed out." : ""}`,
      { operation, commandResult: evidence },
    );
  }
  return evidence;
};

const isolatedEnvironment = (): NodeJS.ProcessEnv => {
  const environment = { ...process.env };
  // A staged sidecar must never resolve a missing module from the developer's
  // shell or from NODE_OPTIONS inherited by the build runner.
  environment.NODE_PATH = "";
  delete environment.NODE_OPTIONS;
  return environment;
};

const assertNoAncestorNodeModules = async (path: string): Promise<void> => {
  let parent = NodePath.dirname(path);
  for (;;) {
    const candidate = NodePath.join(parent, "node_modules");
    try {
      await NodeFS.lstat(candidate);
      throw new TauriPayloadValidationError(
        "invalid-input",
        `Payload probe is not isolated because an ancestor node_modules is visible: ${candidate}`,
      );
    } catch (cause) {
      if (cause instanceof TauriPayloadValidationError) throw cause;
      const code = (cause as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw cause;
    }
    const next = NodePath.dirname(parent);
    if (next === parent) return;
    parent = next;
  }
};

/**
 * Validate the exact loose resource tree before handing it to Tauri. This is
 * intentionally independent of Tauri/electron so CI can run it without a GUI.
 */
export const validateTauriPayload = async (
  options: TauriPayloadValidationOptions,
): Promise<TauriPayloadValidationResult> => {
  const stageRoot = NodePath.resolve(options.stageRoot);
  await assertDirectory(stageRoot, "Staged payload root");

  const platform = normalizePlatform(options.platform);
  const nodeSidecarPath = NodePath.resolve(
    options.nodeSidecarPath ?? NodePath.join(stageRoot, TAURI_PAYLOAD_NODE_SIDECAR_NAMES[platform]),
  );
  const serverEntryPath = NodePath.join(stageRoot, TAURI_PAYLOAD_SERVER_ENTRY);
  const fffEntryPath = NodePath.join(stageRoot, TAURI_PAYLOAD_FFF_ENTRY);
  const hostBundlePath = NodePath.join(stageRoot, TAURI_PAYLOAD_HOST_ENTRY);
  await Promise.all([
    assertFileInside(stageRoot, nodeSidecarPath, "Staged Node sidecar"),
    assertFileInside(stageRoot, serverEntryPath, "Staged server entry"),
    assertFileInside(stageRoot, fffEntryPath, "Staged fff-node entry"),
    assertFileInside(stageRoot, hostBundlePath, "Staged host bundle"),
  ]);

  const hostSource = await NodeFS.readFile(hostBundlePath, "utf8");
  const electronImports = [...hostSource.matchAll(ELECTRON_IMPORT_PATTERN)].map(
    (match) => match[0],
  );
  if (electronImports.length > 0) {
    throw new TauriPayloadValidationError(
      "electron-import",
      `Staged host bundle contains runtime Electron imports/requires: ${electronImports.join(", ")}`,
      { matches: electronImports },
    );
  }

  const runCommand = options.runCommand ?? defaultCommandRunner;
  // On Windows the user profile can itself contain node_modules. Put the
  // disposable probe at the staged payload's drive root so module resolution
  // cannot walk through the developer profile or workspace. Unix temp roots
  // conventionally sit directly below `/` and are checked below as well.
  const probeBase = process.platform === "win32" ? NodePath.parse(stageRoot).root : NodeOS.tmpdir();
  const probeRoot = await NodeFS.mkdtemp(NodePath.join(probeBase, ".agent-nanoni-payload-probe-"));
  try {
    await assertNoAncestorNodeModules(probeRoot);
    const isolatedServerRoot = NodePath.join(probeRoot, "server");
    await NodeFS.cp(NodePath.join(stageRoot, "server"), isolatedServerRoot, {
      recursive: true,
      dereference: false,
      force: false,
      errorOnExist: true,
    });
    const isolatedServerEntryPath = NodePath.join(isolatedServerRoot, "apps/server/dist/bin.mjs");
    const isolatedFffEntryPath = NodePath.join(
      isolatedServerRoot,
      "node_modules/@ff-labs/fff-node/dist/src/index.js",
    );
    const fffCwd = NodePath.join(probeRoot, "fff-data");
    await NodeFS.mkdir(fffCwd);
    const environment = isolatedEnvironment();
    const serverInvocation: TauriPayloadValidationCommandInvocation = {
      command: nodeSidecarPath,
      args: ["--no-global-search-paths", isolatedServerEntryPath, "--version"],
      cwd: probeRoot,
      environment,
    };
    const serverVersion = await execute("server-version", serverInvocation, runCommand);

    const fffInvocation: TauriPayloadValidationCommandInvocation = {
      command: nodeSidecarPath,
      args: [
        "--no-global-search-paths",
        "--input-type=module",
        "--eval",
        FFF_PROBE_SOURCE,
        isolatedFffEntryPath,
        fffCwd,
      ],
      cwd: fffCwd,
      environment,
    };
    const fffNativeLoad = await execute("fff-native-load", fffInvocation, runCommand);

    return {
      stageRoot,
      nodeSidecarPath,
      serverEntryPath,
      fffEntryPath,
      hostBundlePath,
      serverVersion,
      fffNativeLoad,
      host: { path: hostBundlePath, electronImports },
    };
  } finally {
    await NodeFS.rm(probeRoot, { recursive: true, force: true });
  }
};
