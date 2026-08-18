// @effect-diagnostics globalTimers:off - The hard-exit watchdog must survive an interrupted Effect runtime.

import * as NodeOS from "node:os";

import type * as TauriEnvironment from "./app/TauriEnvironment.ts";
import type * as TauriApp from "./electron/TauriApp.ts";
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
  const cleanup = (): void => {
    removeClose();
    removeIpcInvoke();
    broker.close();
    client.close();
  };
  process.once("exit", cleanup);

  const ports = makeShellClientPorts(client);
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
