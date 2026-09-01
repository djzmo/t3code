import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import { JSON_RPC_VERSION } from "../rpc/protocol.ts";
import type * as Electron from "electron";
import type * as ElectronAppService from "../../electron/ElectronApp.ts";

/**
 * The app facade talks to a shell through this deliberately small port.  It
 * describes the messages needed by the shared desktop host, but does not
 * prescribe a transport (stdio RPC, an in-memory fake, or a future native
 * bridge can all implement it).
 */
export interface TauriShellHelloParams {
  readonly protocolVersion: string;
  readonly hostPid: number;
}

export interface TauriShellHelloResult {
  readonly appName: string;
  readonly identifier: string;
  readonly version: string;
  readonly tauriVersion: string;
  readonly platform: string;
  readonly arch: string;
  readonly isDev: boolean;
  readonly execPath: string;
  readonly resourceDir: string;
  readonly serverRoot: string;
  readonly appDataDir: string;
  readonly logDir: string;
  readonly systemLocale: string;
  readonly deepLinkScheme: string;
  readonly argv: readonly string[];
  readonly launchUrls: readonly string[];
}

export interface TauriShellMetric {
  readonly pid: number;
  readonly type: string;
  readonly cpuPercent: number;
  readonly memoryKb: number;
}

export interface TauriShellAppExitParams {
  readonly code: number;
}

export interface TauriShellAppFocusParams {
  readonly steal: boolean;
}

export interface TauriShellProtocolClientParams {
  readonly scheme: string;
}

export interface TauriShellBeforeQuitParams {
  readonly reason: "user" | "menu" | "last-window" | "host" | "updater";
}

export interface TauriShellActivateParams {
  readonly hasVisibleWindows: boolean;
}

export interface TauriShellSecondInstanceParams {
  readonly argv: readonly string[];
  readonly cwd: string;
}

export interface TauriShellOpenUrlParams {
  readonly urls: readonly string[];
}

export type TauriShellRequestMethod =
  | "app.isProtocolClient"
  | "app.setProtocolClient"
  | "app.getMetrics";

export type TauriShellNotificationMethod =
  | "app.quit"
  | "app.exit"
  | "app.relaunch"
  | "app.focus"
  | "app.shutdown-complete";

export type TauriShellEventName =
  | "app.before-quit"
  | "app.activate"
  | "app.window-all-closed"
  | "app.second-instance"
  | "app.open-url";

export type TauriShellRequestParams<Method extends TauriShellRequestMethod> = {
  "app.isProtocolClient": TauriShellProtocolClientParams;
  "app.setProtocolClient": TauriShellProtocolClientParams;
  "app.getMetrics": Record<never, never>;
}[Method];

export type TauriShellNotificationParams<Method extends TauriShellNotificationMethod> = {
  "app.quit": Record<never, never>;
  "app.exit": TauriShellAppExitParams;
  "app.relaunch": Record<never, never>;
  "app.focus": TauriShellAppFocusParams;
  "app.shutdown-complete": Record<never, never>;
}[Method];

export type TauriShellEventParams<Method extends TauriShellEventName> = {
  "app.before-quit": TauriShellBeforeQuitParams;
  "app.activate": TauriShellActivateParams;
  "app.window-all-closed": Record<never, never>;
  "app.second-instance": TauriShellSecondInstanceParams;
  "app.open-url": TauriShellOpenUrlParams;
}[Method];

export type TauriShellRequestResult<Method extends TauriShellRequestMethod> = {
  "app.isProtocolClient": { readonly registered: boolean };
  "app.setProtocolClient": { readonly ok: boolean };
  "app.getMetrics": readonly TauriShellMetric[];
}[Method];

export interface TauriShellEventResult {
  readonly prevented: boolean;
}

export interface TauriShellPort {
  readonly hello: (params: TauriShellHelloParams) => Promise<TauriShellHelloResult>;
  readonly request: <Method extends TauriShellRequestMethod>(
    method: Method,
    params: TauriShellRequestParams<Method>,
  ) => Promise<TauriShellRequestResult<Method>>;
  readonly notify: <Method extends TauriShellNotificationMethod>(
    method: Method,
    params: TauriShellNotificationParams<Method>,
  ) => Promise<void> | void;
  readonly on: <Method extends TauriShellEventName>(
    method: Method,
    listener: (params: TauriShellEventParams<Method>) => TauriShellEventResult | void,
  ) => () => void;
}

export type ElectronAppMetadata = ElectronAppService.ElectronAppMetadata;

export class ElectronAppMetadataReadError extends Schema.TaggedErrorClass<ElectronAppMetadataReadError>()(
  "ElectronAppMetadataReadError",
  {
    property: Schema.Literals(["app-version", "app-path"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read Tauri app metadata property "${this.property}".`;
  }
}

export class ElectronAppWhenReadyError extends Schema.TaggedErrorClass<ElectronAppWhenReadyError>()(
  "ElectronAppWhenReadyError",
  {
    isPackaged: Schema.Boolean,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to wait for the Tauri app to become ready (packaged: ${this.isPackaged}).`;
  }
}

export class TauriShellHelloError extends Schema.TaggedErrorClass<TauriShellHelloError>()(
  "TauriShellHelloError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Tauri shell hello failed.";
  }
}

export class TauriShellCommandError extends Schema.TaggedErrorClass<TauriShellCommandError>()(
  "TauriShellCommandError",
  {
    method: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Tauri shell command failed: ${this.method}.`;
  }
}

/** Keep the exact tag key and service shape consumed by shared desktop code. */
export const ElectronApp = Context.Service<
  ElectronAppService.ElectronApp,
  ElectronAppService.ElectronApp["Service"]
>()("@t3tools/desktop/electron/ElectronApp");

export interface TauriAppOptions {
  readonly protocolVersion?: string;
  readonly hostPid?: number;
}

const noOp = Effect.void;

const sendNotification = <Method extends TauriShellNotificationMethod>(
  shell: TauriShellPort,
  method: Method,
  params: TauriShellNotificationParams<Method>,
): Effect.Effect<void> =>
  Effect.tryPromise({
    try: async () => {
      await shell.notify(method, params);
    },
    catch: (cause) => new TauriShellCommandError({ method, cause }),
  }).pipe(Effect.orDie, Effect.asVoid);

const request = <Method extends TauriShellRequestMethod>(
  shell: TauriShellPort,
  method: Method,
  params: TauriShellRequestParams<Method>,
): Effect.Effect<TauriShellRequestResult<Method>> =>
  Effect.tryPromise({
    try: () => shell.request(method, params),
    catch: (cause) => new TauriShellCommandError({ method, cause }),
  }).pipe(Effect.orDie);

const makePreventableEvent = (): Electron.Event => {
  let prevented = false;
  return {
    preventDefault: () => {
      prevented = true;
    },
    get defaultPrevented() {
      return prevented;
    },
  };
};

const processMetricType = (value: string): Electron.ProcessMetric["type"] => {
  switch (value) {
    case "Browser":
    case "Tab":
    case "Utility":
    case "Zygote":
    case "Sandbox helper":
    case "GPU":
    case "Pepper Plugin":
    case "Pepper Plugin Broker":
    case "Unknown":
      return value;
    default:
      return "Unknown";
  }
};

const registerEvent = (
  shell: TauriShellPort,
  eventName: string,
  listener: (...args: ReadonlyArray<unknown>) => void,
): Effect.Effect<void, never, Scope.Scope> => {
  switch (eventName) {
    case "before-quit": {
      const add = () =>
        shell.on("app.before-quit", () => {
          const event = makePreventableEvent();
          listener(event);
          return { prevented: event.defaultPrevented };
        });
      return Effect.acquireRelease(Effect.sync(add), (remove) => Effect.sync(remove)).pipe(
        Effect.asVoid,
      );
    }
    case "activate": {
      const add = () =>
        shell.on("app.activate", (params) => {
          listener(makePreventableEvent(), params.hasVisibleWindows);
        });
      return Effect.acquireRelease(Effect.sync(add), (remove) => Effect.sync(remove)).pipe(
        Effect.asVoid,
      );
    }
    case "window-all-closed": {
      const add = () =>
        shell.on("app.window-all-closed", () => {
          listener();
        });
      return Effect.acquireRelease(Effect.sync(add), (remove) => Effect.sync(remove)).pipe(
        Effect.asVoid,
      );
    }
    case "second-instance": {
      const add = () =>
        shell.on("app.second-instance", (params) => {
          listener(makePreventableEvent(), params.argv, params.cwd);
        });
      return Effect.acquireRelease(Effect.sync(add), (remove) => Effect.sync(remove)).pipe(
        Effect.asVoid,
      );
    }
    case "open-url": {
      const add = () =>
        shell.on("app.open-url", (params) => {
          listener(makePreventableEvent(), params.urls);
        });
      return Effect.acquireRelease(Effect.sync(add), (remove) => Effect.sync(remove)).pipe(
        Effect.asVoid,
      );
    }
    default:
      return Effect.acquireRelease(Effect.void, () => Effect.void).pipe(Effect.asVoid);
  }
};

export const make = (
  shell: TauriShellPort,
  options: TauriAppOptions = {},
): ElectronAppService.ElectronApp["Service"] => {
  const protocolVersion = options.protocolVersion ?? JSON_RPC_VERSION;
  const hostPid = options.hostPid ?? process.pid;
  let helloPromise: Promise<TauriShellHelloResult> | undefined;
  let helloResult: TauriShellHelloResult | undefined;
  let configuredName: string | undefined;

  const hello = (): Promise<TauriShellHelloResult> =>
    (helloPromise ??= shell.hello({ protocolVersion, hostPid }).then((result) => {
      helloResult = result;
      return result;
    }));

  const readHello = Effect.tryPromise({
    try: hello,
    catch: (cause) => new TauriShellHelloError({ cause }),
  });

  return {
    metadata: readHello.pipe(
      Effect.map(
        (result): ElectronAppMetadata => ({
          appVersion: result.version,
          appPath: result.serverRoot,
          isPackaged: !result.isDev,
          resourcesPath: result.resourceDir,
          runningUnderArm64Translation: false,
        }),
      ),
      Effect.mapError(
        (cause) =>
          new ElectronAppMetadataReadError({
            property: "app-path",
            cause,
          }),
      ),
    ),
    name: readHello.pipe(
      Effect.orDie,
      Effect.map((result) => configuredName ?? result.appName),
    ),
    systemLocale: Effect.suspend(() =>
      helloResult === undefined
        ? readHello.pipe(
            Effect.orDie,
            Effect.map((result) => result.systemLocale),
          )
        : Effect.succeed(helloResult.systemLocale),
    ),
    whenReady: readHello.pipe(
      Effect.asVoid,
      Effect.mapError(
        (cause) =>
          new ElectronAppWhenReadyError({
            isPackaged: true,
            cause,
          }),
      ),
    ),
    quit: sendNotification(shell, "app.quit", {}),
    exit: (code) => sendNotification(shell, "app.exit", { code }),
    relaunch: () => sendNotification(shell, "app.relaunch", {}),
    setPath: () => noOp,
    setName: (name) =>
      Effect.sync(() => {
        configuredName = name;
      }),
    setAboutPanelOptions: () => noOp,
    setAppUserModelId: () => noOp,
    getAppMetrics: request(shell, "app.getMetrics", {}).pipe(
      Effect.map((metrics) =>
        metrics.map(
          (metric): Electron.ProcessMetric => ({
            pid: metric.pid,
            type: processMetricType(metric.type),
            creationTime: 0,
            cpu: {
              percentCPUUsage: metric.cpuPercent,
              idleWakeupsPerSecond: 0,
            },
            memory: {
              peakWorkingSetSize: metric.memoryKb,
              workingSetSize: metric.memoryKb,
              privateBytes: metric.memoryKb,
            },
          }),
        ),
      ),
    ),
    isDefaultProtocolClient: (protocol) =>
      request(shell, "app.isProtocolClient", { scheme: protocol }).pipe(
        Effect.map((result) => result.registered),
      ),
    setAsDefaultProtocolClient: (protocol) =>
      request(shell, "app.setProtocolClient", { scheme: protocol }).pipe(
        Effect.map((result) => result.ok),
      ),
    setDesktopName: () => noOp,
    setDockIcon: () => noOp,
    appendCommandLineSwitch: () => noOp,
    onBeforeQuitForUpdate: () =>
      Effect.acquireRelease(Effect.void, () => Effect.void).pipe(Effect.asVoid),
    removeCommandLineSwitch: () => noOp,
    on: <Args extends ReadonlyArray<unknown>>(
      eventName: string,
      listener: (...args: Args) => void,
    ) =>
      registerEvent(shell, eventName, (...args) => {
        Reflect.apply(listener, undefined, args);
      }),
  };
};

export const layer = (shell: TauriShellPort, options?: TauriAppOptions) =>
  Layer.succeed(ElectronApp, make(shell, options));
