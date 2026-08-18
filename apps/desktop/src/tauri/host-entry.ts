// @effect-diagnostics globalTimers:off - The hard-exit watchdog must survive an interrupted Effect runtime.

import * as NodeOS from "node:os";

import type * as TauriEnvironment from "./app/TauriEnvironment.ts";
import type * as TauriApp from "./electron/TauriApp.ts";
import type * as TauriWindow from "./electron/TauriWindow.ts";
import * as TauriIpcMain from "./ipc/TauriIpcMain.ts";
import { run } from "./main.ts";
import { makeBrokeredChildSpawner } from "./process/BrokeredChildSpawner.ts";
import { makeRpcProcessBroker, type RpcProcessPeer } from "./process/RpcProcessBroker.ts";
import {
  createNodeStdioTransport,
  type RpcParams,
  type ShellClient,
  ShellClient as ShellClientRuntime,
} from "./rpc/ShellClient.ts";
import { makeShellClientPorts } from "./rpc/ShellClientPorts.ts";

/**
 * The Topology A benchmark is deliberately opt-in.  It is not part of the
 * normal desktop IPC surface and must never be installed by a regular host.
 */
export const TOPOLOGY_A_BENCH_ENV = "AGENT_NANONI_TOPOLOGY_A_BENCH";
export const TOPOLOGY_A_BENCH_CHANNEL = "desktop:phase0-topology-a-bench";
export const TOPOLOGY_A_BENCH_MAX_BYTES = 1_048_576;
export const TOPOLOGY_A_BENCH_MAX_PUSH_COUNT = 100;

type TopologyABenchEcho = {
  readonly op: "echo";
  readonly value: unknown;
};

type TopologyABenchPush = {
  readonly op: "push";
  readonly seq: number;
  readonly sentAt: number;
};

type TopologyABenchRequest = TopologyABenchEcho | TopologyABenchPush;

const invalidTopologyABenchRequest = (): Error =>
  new Error("Invalid Topology A benchmark request.");

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const serializedByteLength = (value: unknown): number => {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw invalidTopologyABenchRequest();
  }
  if (serialized === undefined) throw invalidTopologyABenchRequest();
  return new TextEncoder().encode(serialized).byteLength;
};

const parseTopologyABenchRequest = (raw: unknown): TopologyABenchRequest => {
  if (!isPlainRecord(raw) || typeof raw.op !== "string") {
    throw invalidTopologyABenchRequest();
  }

  if (raw.op === "echo") {
    if (!hasExactKeys(raw, ["op", "value"])) throw invalidTopologyABenchRequest();
    if (serializedByteLength(raw.value) > TOPOLOGY_A_BENCH_MAX_BYTES) {
      throw new Error(`Topology A benchmark echo exceeds ${TOPOLOGY_A_BENCH_MAX_BYTES} bytes.`);
    }
    return { op: "echo", value: raw.value };
  }

  if (raw.op === "push") {
    if (!hasExactKeys(raw, ["op", "seq", "sentAt"])) throw invalidTopologyABenchRequest();
    const seq = raw.seq;
    const sentAt = raw.sentAt;
    if (
      typeof seq !== "number" ||
      !Number.isSafeInteger(seq) ||
      seq < 0 ||
      seq >= TOPOLOGY_A_BENCH_MAX_PUSH_COUNT ||
      typeof sentAt !== "number" ||
      !Number.isFinite(sentAt)
    ) {
      throw invalidTopologyABenchRequest();
    }
    return { op: "push", seq, sentAt };
  }

  throw new Error(`Unknown Topology A benchmark operation: ${raw.op}.`);
};

export interface TopologyABenchRegistration {
  readonly remove: () => void;
}

export interface TopologyABenchRegistrationOptions {
  readonly ipcMain: TauriIpcMain.TauriIpcMain;
  readonly window: TauriWindow.TauriWindowPort;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

/**
 * Install the opt-in Topology A benchmark invoke handler.
 *
 * The push path intentionally goes through the same `ipc.push` notification
 * used by the application.  It therefore exercises host → native → renderer
 * ordering rather than a benchmark-only shortcut.
 */
export const registerTopologyABenchmark = ({
  ipcMain,
  window,
  environment = process.env,
}: TopologyABenchRegistrationOptions): TopologyABenchRegistration => {
  if (environment[TOPOLOGY_A_BENCH_ENV] !== "1") return { remove: () => undefined };

  ipcMain.handle(TOPOLOGY_A_BENCH_CHANNEL, async (_event, raw) => {
    const request = parseTopologyABenchRequest(raw);
    if (request.op === "echo") return { value: request.value };

    await window.notify("ipc.push", {
      channel: "desktop:menu-action",
      payload: JSON.stringify({ seq: request.seq, sentAt: request.sentAt }),
    });
    return { seq: request.seq };
  });

  return { remove: () => ipcMain.removeHandler(TOPOLOGY_A_BENCH_CHANNEL) };
};

const stageLabel = (
  hello: TauriApp.TauriShellHelloResult,
): TauriEnvironment.TauriEnvironmentIdentity["branding"]["stageLabel"] => {
  if (hello.isDev) return "Dev";
  return hello.version.includes("-nightly.") ? "Nightly" : "Alpha";
};

export const identityFromHello = (
  hello: TauriApp.TauriShellHelloResult,
): TauriEnvironment.TauriEnvironmentIdentity => {
  const stage = stageLabel(hello);
  const displayName = `${hello.appName} (${stage})`;
  const linuxName = hello.identifier.replaceAll(".", "-");
  return {
    branding: { baseName: hello.appName, stageLabel: stage, displayName },
    displayName,
    appUserModelId: hello.identifier,
    linuxDesktopEntryName: `${linuxName}.desktop`,
    linuxWmClass: linuxName,
    userDataDirName: hello.identifier,
    legacyUserDataDirName: displayName,
  };
};

const processPeer = (client: ShellClient): RpcProcessPeer => ({
  request: (method, params) => client.request(method, params as RpcParams<typeof method>),
  notify: (method, params) => client.notify(method, params as RpcParams<typeof method>),
  onNotification: (method, handler) => client.onEvent(method, (params) => handler(params)),
});

const hostDirectory = (): string => {
  const entryPath = process.argv[1];
  if (entryPath === undefined) return process.cwd();
  const separator = Math.max(entryPath.lastIndexOf("/"), entryPath.lastIndexOf("\\"));
  return separator < 0 ? process.cwd() : entryPath.slice(0, separator);
};

export const HOST_HARD_EXIT_TIMEOUT_MS = 5_000;

export interface HostTransportCloseDependencies {
  readonly closeBroker: (cause?: unknown) => void;
  readonly requestShutdown: () => void;
  readonly hardExit: (code: number) => void;
  readonly scheduleHardExit?: (
    callback: () => void,
    delayMs: number,
  ) => { readonly unref: () => void };
}

/**
 * Turn shell transport loss into the host's normal Effect shutdown, with the
 * L7 hard-exit deadline as a final containment barrier. The handler is
 * one-shot because both stdin EOF and the process cleanup path can report the
 * same close.
 */
export const createHostTransportCloseHandler = (
  dependencies: HostTransportCloseDependencies,
): ((cause?: unknown) => void) => {
  let closing = false;
  const scheduleHardExit =
    dependencies.scheduleHardExit ??
    ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));

  return (cause?: unknown) => {
    if (closing) return;
    closing = true;
    dependencies.closeBroker(cause);
    const deadline = scheduleHardExit(() => dependencies.hardExit(1), HOST_HARD_EXIT_TIMEOUT_MS);
    deadline.unref();
    dependencies.requestShutdown();
  };
};

export const startHost = async (): Promise<void> => {
  const transport = createNodeStdioTransport();
  const client = new ShellClientRuntime({ transport });
  const hello = await client.ready;
  process.env.T3CODE_HOME = hello.appDataDir;

  const ipcMain = TauriIpcMain.make();
  const broker = makeRpcProcessBroker(processPeer(client));
  const onTransportClose = createHostTransportCloseHandler({
    closeBroker: (cause) => broker.close(cause),
    requestShutdown: () => process.kill(process.pid, "SIGTERM"),
    hardExit: (code) => process.exit(code),
  });
  const removeClose = transport.onClose(onTransportClose);
  const removeIpcInvoke = client.onRequest("ipc.invoke", async ({ channel, payload }) => ({
    result: await ipcMain.invoke(channel, payload),
  }));
  const ports = makeShellClientPorts(client);
  const topologyABench = registerTopologyABenchmark({ ipcMain, window: ports.window });
  const cleanup = (): void => {
    topologyABench.remove();
    removeClose();
    removeIpcInvoke();
    broker.close();
    client.close();
  };
  process.once("exit", cleanup);

  run({
    dirname: hostDirectory(),
    homeDirectory: NodeOS.homedir(),
    platform: process.platform,
    processArch: process.arch,
    identity: identityFromHello(hello),
    shellHello: hello,
    childSpawner: makeBrokeredChildSpawner({ broker }),
    ports: {
      ...ports,
      ipcMain,
    },
  });
};

if (process.env.VITEST === undefined) {
  void startHost().catch((cause: unknown) => {
    process.stderr.write(`failed to start Agent Nanoni host: ${String(cause)}\n`);
    process.exitCode = 1;
  });
}
