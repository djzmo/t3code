import type * as TauriApp from "../electron/TauriApp.ts";
import type * as TauriDialog from "../electron/TauriDialog.ts";
import type * as TauriShell from "../electron/TauriShell.ts";
import type * as TauriWindow from "../electron/TauriWindow.ts";
import { JSON_RPC_VERSION } from "./protocol.ts";
import type { RpcParams, ShellClient } from "./ShellClient.ts";

export interface ShellClientPortsOptions {
  /**
   * These values must be the same values used to construct ShellClient.  The
   * adapter checks them on every app.hello call so a stale or miswired host
   * cannot silently accept a shell with a different identity contract.
   */
  readonly protocolVersion?: string;
  readonly hostPid?: number;
}

export interface ShellClientPorts {
  readonly app: TauriApp.TauriShellPort;
  readonly dialog: TauriDialog.TauriDialogPort;
  readonly shell: TauriShell.TauriShellPort;
  readonly window: TauriWindow.TauriWindowPort;
}

const protocolMismatch = (
  expectedProtocolVersion: string,
  expectedHostPid: number,
  actualProtocolVersion: string,
  actualHostPid: number,
): Error =>
  new Error(
    `Tauri shell hello contract mismatch: expected protocol ${JSON.stringify(expectedProtocolVersion)} and host PID ${expectedHostPid}, got protocol ${JSON.stringify(actualProtocolVersion)} and host PID ${actualHostPid}.`,
  );

export const makeShellClientPorts = (
  client: ShellClient,
  options: ShellClientPortsOptions = {},
): ShellClientPorts => {
  const expectedProtocolVersion = options.protocolVersion ?? JSON_RPC_VERSION;
  const expectedHostPid = options.hostPid ?? process.pid;

  const hello = async (
    params: TauriApp.TauriShellHelloParams,
  ): Promise<TauriApp.TauriShellHelloResult> => {
    if (params.protocolVersion !== expectedProtocolVersion || params.hostPid !== expectedHostPid) {
      throw protocolMismatch(
        expectedProtocolVersion,
        expectedHostPid,
        params.protocolVersion,
        params.hostPid,
      );
    }
    return await client.ready;
  };

  const requestApp = <Method extends TauriApp.TauriShellRequestMethod>(
    method: Method,
    params: TauriApp.TauriShellRequestParams<Method>,
  ): Promise<TauriApp.TauriShellRequestResult<Method>> =>
    client.request(method, params) as Promise<TauriApp.TauriShellRequestResult<Method>>;

  const notifyApp = <Method extends TauriApp.TauriShellNotificationMethod>(
    method: Method,
    params: TauriApp.TauriShellNotificationParams<Method>,
  ): Promise<void> => client.notify(method, params);

  const onApp = <Method extends TauriApp.TauriShellEventName>(
    method: Method,
    listener: (
      params: TauriApp.TauriShellEventParams<Method>,
    ) => TauriApp.TauriShellEventResult | void,
  ): (() => void) => {
    if (method === "app.before-quit") {
      return client.onRequest(method, async (params) => {
        const result = listener(params as TauriApp.TauriShellEventParams<Method>);
        return result ?? { prevented: false };
      });
    }
    return client.on(method, (params: RpcParams<typeof method>) => {
      void listener(params as TauriApp.TauriShellEventParams<Method>);
    });
  };

  const requestWindow = (
    method: TauriWindow.TauriWindowRequestMethod,
    params: { readonly label: string },
  ): Promise<unknown> => client.request(method, params);

  const notifyWindow = (
    method: TauriWindow.TauriWindowNotificationMethod,
    params: unknown,
  ): Promise<void> => client.notify(method, params as RpcParams<typeof method>);

  const onWindow = (
    method: "window.event",
    listener: (params: TauriWindow.TauriWindowEventParams) => void,
  ): (() => void) =>
    client.on(method, (params) => listener(params as TauriWindow.TauriWindowEventParams));

  const ports: ShellClientPorts = {
    app: {
      hello,
      request: requestApp,
      notify: notifyApp,
      on: onApp,
    },
    dialog: {
      request: (method, params) => client.request(method, params).then(() => undefined),
    },
    shell: {
      request: (method, params) => client.request(method, params),
      notify: (method, params) => client.notify(method, params),
    },
    window: {
      create: (params) =>
        client.request("window.create", params).then((result) => ({ label: result.label })),
      request: requestWindow,
      notify: notifyWindow,
      on: onWindow,
    },
  };

  return ports;
};
