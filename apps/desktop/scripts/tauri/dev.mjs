import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const scriptDirectory = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const desktopDirectory = NodePath.resolve(scriptDirectory, "../..");
const repositoryRoot = NodePath.resolve(desktopDirectory, "../..");
const developmentIdentifierPrefix = "app.nanoni.agent.desktop.dev.";
const clerkConfigurationKeys = [
  "VITE_CLERK_PUBLISHABLE_KEY",
  "T3CODE_CLERK_PUBLISHABLE_KEY",
  "VITE_CLERK_JWT_TEMPLATE",
  "T3CODE_CLERK_JWT_TEMPLATE",
  "VITE_CLERK_CLI_OAUTH_CLIENT_ID",
  "T3CODE_CLERK_CLI_OAUTH_CLIENT_ID",
];

/**
 * Resolve a worktree path before deriving any identity material from it.
 * Windows paths are normalized for drive-letter and case differences so a
 * junction or a differently-cased checkout cannot create a second identity.
 */
export function normalizeWorktreePath(value, { platform = NodeOS.platform() } = {}) {
  const normalized = NodePath.normalize(value).replaceAll("\\", "/");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function resolveCanonicalWorktreePath({
  cwd = process.cwd(),
  platform = NodeOS.platform(),
  realpath = (path) => NodeFS.realpathSync.native(path),
} = {}) {
  return normalizeWorktreePath(realpath(cwd), { platform });
}

export function worktreeIdentity(canonicalPath) {
  const digest = NodeCrypto.createHash("sha256").update(canonicalPath, "utf8").digest("hex");
  return digest.slice(0, 12);
}

export function resolveDevelopmentIdentifier(canonicalPath) {
  return `${developmentIdentifierPrefix}${worktreeIdentity(canonicalPath)}`;
}

/**
 * Tauri merges this file over tauri.conf.json. Keep it deliberately narrow:
 * the base window, capabilities, and packaged URL scheme must remain intact;
 * only the per-worktree development identifier is changed.
 */
export function createDevelopmentOverlay(identifier, devUrl, { topologyABenchmark = false } = {}) {
  const parsed = new URL(devUrl);
  if (
    parsed.protocol !== "http:" ||
    (parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1")
  ) {
    throw new Error(`Tauri development URL must be loopback HTTP; received ${devUrl}.`);
  }
  return {
    identifier,
    build: { devUrl: parsed.href.replace(/\/$/, "") },
    ...(topologyABenchmark
      ? {
          app: {
            security: {
              capabilities: [
                "main",
                {
                  identifier: "topology-a-pilot",
                  description: "Debug-only permission for the Phase 0 Topology A benchmark.",
                  webviews: ["main"],
                  permissions: ["pilot:default"],
                },
              ],
            },
          },
        }
      : {}),
  };
}

export function findClerkConfiguration(environment) {
  return clerkConfigurationKeys.filter((key) => {
    const value = environment[key];
    return typeof value === "string" && value.trim().length > 0;
  });
}

export function assertClerkAbsent(environment) {
  const configuredKeys = findClerkConfiguration(environment);
  if (configuredKeys.length > 0) {
    throw new Error(
      `Tauri development requires Clerk configuration to be absent until F11; unset ${configuredKeys.join(", ")}.`,
    );
  }
}

export function assertSupportedSidecarNode(version = process.versions.node) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-|$)/.exec(version);
  const major = Number(match?.[1]);
  const minor = Number(match?.[2]);
  const patch = Number(match?.[3]);
  if (major !== 24 || minor < 13 || (minor === 13 && patch < 1)) {
    throw new Error(
      `Tauri development requires Node 24.13.1 or newer in the Node 24 line; received ${version}.`,
    );
  }
}

export const DEV_WEB_GRAPH_ARGS = [
  "run",
  "--filter=@t3tools/contracts",
  "--filter=@t3tools/web",
  "--filter=t3",
  "--parallel",
  "dev",
];

function executable(name) {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

export function createSpawnOptions({ cwd, env, platform = process.platform }) {
  return {
    cwd,
    env,
    stdio: "inherit",
    windowsHide: true,
    // A detached Unix child is the leader of its own process group. This lets
    // shutdown target the group using the PID captured from spawn(), so any
    // descendants (for example the Vite process tree) are cleaned up too.
    ...(platform === "win32" ? {} : { detached: true }),
  };
}

export function resolveDevelopmentCommands({
  overlayPath,
  extraArgs = [],
  topologyABenchmark = false,
}) {
  return {
    host: {
      command: executable("pnpm"),
      args: ["--filter", "@t3tools/desktop", "run", "build:tauri-host"],
    },
    web: {
      command: executable("vp"),
      args: [...DEV_WEB_GRAPH_ARGS],
    },
    tauri: {
      command: executable("pnpm"),
      args: [
        "--filter",
        "@t3tools/desktop",
        "exec",
        "tauri",
        "dev",
        "--config",
        overlayPath,
        ...(topologyABenchmark ? ["--features", "topology-a-pilot"] : []),
        ...extraArgs,
      ],
    },
  };
}

export function resolveHostEnvironment(
  environment,
  {
    nodeExecutable = process.execPath,
    hostEntry = NodePath.join(desktopDirectory, "dist-tauri-host", "host.cjs"),
  } = {},
) {
  return {
    ...environment,
    AGENT_NANONI_NODE: nodeExecutable,
    AGENT_NANONI_HOST_ENTRY: hostEntry,
  };
}

function writeOverlay({ directory, identifier, devUrl, topologyABenchmark }) {
  NodeFS.mkdirSync(directory, { recursive: true });
  const overlayPath = NodePath.join(directory, "tauri.dev.conf.json");
  NodeFS.writeFileSync(
    overlayPath,
    `${JSON.stringify(createDevelopmentOverlay(identifier, devUrl, { topologyABenchmark }), null, 2)}\n`,
    "utf8",
  );
  return overlayPath;
}

export function terminateChild(
  child,
  {
    platform = process.platform,
    killProcess = process.kill,
    spawnSync = NodeChildProcess.spawnSync,
  } = {},
) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  const hasCapturedPid =
    typeof child.pid === "number" && Number.isInteger(child.pid) && child.pid > 0;

  if (platform === "win32" && hasCapturedPid) {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
    });
    return;
  }

  if (platform !== "win32" && hasCapturedPid) {
    try {
      // Negative PIDs address the process group led by the captured child PID.
      killProcess(-child.pid, "SIGTERM");
      return;
    } catch {
      // Fall back to the child handle if the process group no longer exists.
    }
  }

  child.kill("SIGTERM");
}

function waitForExit(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(child.exitCode ?? 1);
      return;
    }

    child.once("exit", (code) => resolve(code ?? 1));
    child.once("error", () => resolve(1));
  });
}

async function run() {
  const environment = resolveHostEnvironment(process.env);
  const topologyABenchmark = environment.AGENT_NANONI_TOPOLOGY_A_BENCH === "1";
  assertSupportedSidecarNode();
  assertClerkAbsent(environment);

  const canonicalPath = resolveCanonicalWorktreePath();
  const identifier = resolveDevelopmentIdentifier(canonicalPath);
  const devUrl = environment.VITE_DEV_SERVER_URL;
  if (typeof devUrl !== "string" || devUrl.trim().length === 0) {
    throw new Error("VITE_DEV_SERVER_URL is required for Tauri development.");
  }
  const overlayDirectory = NodeFS.mkdtempSync(
    NodePath.join(NodeOS.tmpdir(), "agent-nanoni-tauri-dev-"),
  );
  const overlayPath = writeOverlay({
    directory: overlayDirectory,
    identifier,
    devUrl,
    topologyABenchmark,
  });
  const commands = resolveDevelopmentCommands({
    overlayPath,
    topologyABenchmark,
    extraArgs: process.argv.slice(2),
  });
  const spawnOptions = createSpawnOptions({ cwd: repositoryRoot, env: environment });
  const hostBuild = NodeChildProcess.spawn(commands.host.command, commands.host.args, spawnOptions);
  const hostBuildExit = await waitForExit(hostBuild);
  if (hostBuildExit !== 0) {
    NodeFS.rmSync(overlayDirectory, { recursive: true, force: true });
    process.exitCode = hostBuildExit;
    return;
  }
  const web = NodeChildProcess.spawn(commands.web.command, commands.web.args, spawnOptions);
  const tauri = NodeChildProcess.spawn(commands.tauri.command, commands.tauri.args, {
    ...spawnOptions,
    cwd: desktopDirectory,
  });
  let stopping = false;
  const stop = () => {
    if (stopping) {
      return;
    }

    stopping = true;
    terminateChild(web);
    terminateChild(tauri);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  const firstExit = await Promise.race([
    waitForExit(web).then((code) => ({ child: web, code })),
    waitForExit(tauri).then((code) => ({ child: tauri, code })),
  ]);
  stop();
  const remainingExit = await Promise.all([waitForExit(web), waitForExit(tauri)]);
  NodeFS.rmSync(overlayDirectory, { recursive: true, force: true });
  process.exitCode =
    firstExit.child === tauri
      ? firstExit.code
      : firstExit.code !== 0
        ? firstExit.code
        : remainingExit[1];
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
