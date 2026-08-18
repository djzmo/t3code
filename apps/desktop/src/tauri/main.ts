import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeOS from "node:os";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as NetService from "@t3tools/shared/Net";
import type { RemoteT3RunnerOptions } from "@t3tools/ssh/tunnel";
import serverPackageJson from "../../../server/package.json" with { type: "json" };

import * as DesktopApp from "../app/DesktopApp.ts";
import * as DesktopAppIdentity from "../app/DesktopAppIdentity.ts";
import * as DesktopConnectionCatalogStore from "../app/DesktopConnectionCatalogStore.ts";
import * as DesktopAssets from "../app/DesktopAssets.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopLifecycle from "../app/DesktopLifecycle.ts";
import * as DesktopLinuxUrlHandler from "../app/DesktopLinuxUrlHandler.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopShutdown from "../app/DesktopShutdown.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as DesktopSavedEnvironments from "../settings/DesktopSavedEnvironments.ts";
import * as DesktopBackendConfiguration from "../backend/DesktopBackendConfiguration.ts";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopLocalEnvironmentAuth from "../backend/DesktopLocalEnvironmentAuth.ts";
import * as DesktopNetworkInterfaces from "../backend/DesktopNetworkInterfaces.ts";
import * as DesktopServerExposure from "../backend/DesktopServerExposure.ts";
import * as DesktopPreReadyPlatform from "../app/DesktopPreReadyPlatform.ts";
import * as DesktopShellEnvironment from "../shell/DesktopShellEnvironment.ts";
import * as DesktopSshEnvironment from "../ssh/DesktopSshEnvironment.ts";
import * as DesktopSshPasswordPrompts from "../ssh/DesktopSshPasswordPrompts.ts";
import * as DesktopTelemetryPublisher from "../telemetry/DesktopTelemetryPublisher.ts";
import * as DesktopUpdates from "../updates/DesktopUpdates.ts";
import * as DesktopWslBackend from "../wsl/DesktopWslBackend.ts";
import * as DesktopWslEnvironment from "../wsl/DesktopWslEnvironment.ts";
import * as DesktopWslServerTree from "../wsl/DesktopWslServerTree.ts";
import * as DesktopApplicationMenu from "../window/DesktopApplicationMenu.ts";

import * as TauriApp from "./electron/TauriApp.ts";
import * as TauriDialog from "./electron/TauriDialog.ts";
import * as TauriMenu from "./electron/TauriMenu.ts";
import * as TauriPowerMonitor from "./electron/TauriPowerMonitor.ts";
import * as TauriProtocol from "./electron/TauriProtocol.ts";
import * as TauriSafeStorage from "./electron/TauriSafeStorage.ts";
import * as TauriShell from "./electron/TauriShell.ts";
import * as TauriTheme from "./electron/TauriTheme.ts";
import * as TauriUpdater from "./electron/TauriUpdater.ts";
import * as TauriWindow from "./electron/TauriWindow.ts";
import * as TauriClerk from "./app/TauriClerk.ts";
import * as TauriDesktopWindow from "./app/TauriDesktopWindow.ts";
import * as TauriEnvironment from "./app/TauriEnvironment.ts";
import * as TauriLinuxUrlHandler from "./app/TauriLinuxUrlHandler.ts";
import * as TauriPreReadyPlatform from "./app/TauriPreReadyPlatform.ts";
import * as TauriSshCliRunner from "./app/TauriSshCliRunner.ts";
import * as TauriWslServerTree from "./wsl/TauriWslServerTree.ts";
import * as TauriIpcMain from "./ipc/TauriIpcMain.ts";
import * as TauriPreview from "./preview/TauriPreviewManagerStub.ts";
import * as ManagedChildSpawner from "./process/ManagedChildSpawner.ts";

export interface TauriHostPorts {
  readonly app: TauriApp.TauriShellPort;
  readonly dialog: TauriDialog.TauriDialogPort;
  readonly shell: TauriShell.TauriShellPort;
  readonly window: TauriWindow.TauriWindowPort;
  readonly registry: ManagedChildSpawner.ManagedChildRegistry;
}

export interface TauriHostEnvironmentOptions {
  readonly dirname: string;
  readonly homeDirectory?: string;
  readonly platform: NodeJS.Platform;
  readonly processArch: string;
  readonly identity: TauriEnvironment.TauriEnvironmentIdentity;
}

export interface TauriHostOptions extends TauriHostEnvironmentOptions {
  readonly ports: TauriHostPorts;
  readonly packageSpec: string;
  readonly nodeEngineRange?: string;
  readonly protocolVersion?: string;
}

const resolveSshRunner = (
  environment: DesktopEnvironment.DesktopEnvironment["Service"],
  settings: DesktopAppSettings.DesktopSettings,
  options: TauriHostOptions,
): RemoteT3RunnerOptions =>
  TauriSshCliRunner.resolveTauriSshCliRunner({
    isDevelopment: environment.isDevelopment,
    ...(Option.isSome(environment.devRemoteT3ServerEntryPath)
      ? { devRemoteEntryPath: environment.devRemoteT3ServerEntryPath.value }
      : {}),
    packageSpec: options.packageSpec,
    nodeEngineRange: options.nodeEngineRange ?? serverPackageJson.engines.node,
  });

const makeEnvironmentLayer = (
  appLayer: ReturnType<typeof TauriApp.layer>,
  options: TauriHostOptions,
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const metadata = yield* TauriApp.ElectronApp.pipe(Effect.flatMap((app) => app.metadata));
      return TauriEnvironment.layer({
        dirname: options.dirname,
        homeDirectory: options.homeDirectory ?? NodeOS.homedir(),
        platform: options.platform,
        processArch: options.processArch,
        ...metadata,
        identity: options.identity,
      });
    }),
  ).pipe(Layer.provide(appLayer), Layer.provideMerge(NodeServices.layer));

const makeManagedChildSpawnerLayer = (registry: ManagedChildSpawner.ManagedChildRegistry) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      return Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ManagedChildSpawner.decorateManagedChildSpawner(delegate, { registry }),
      );
    }),
  ).pipe(Layer.provide(NodeServices.layer));

export const makeDesktopRuntimeLayer = (options: TauriHostOptions) => {
  const tauriAppLayer =
    options.protocolVersion === undefined
      ? TauriApp.layer(options.ports.app)
      : TauriApp.layer(options.ports.app, { protocolVersion: options.protocolVersion });
  const tauriEnvironmentLayer = makeEnvironmentLayer(tauriAppLayer, options);
  const tauriElectronLayer = Layer.mergeAll(
    tauriAppLayer,
    TauriDialog.layer(options.ports.dialog),
    TauriMenu.layer,
    TauriPowerMonitor.layer,
    TauriProtocol.layer,
    TauriSafeStorage.layer,
    TauriShell.layer(options.ports.shell),
    TauriTheme.layer,
    TauriUpdater.layer,
    TauriWindow.layer(options.ports.window),
    TauriIpcMain.layer(),
  );

  const foundationLayer = Layer.mergeAll(
    DesktopState.layer,
    DesktopShutdown.layer,
    DesktopAppSettings.layer,
    DesktopClientSettings.layer,
    DesktopConnectionCatalogStore.layer.pipe(Layer.provideMerge(DesktopSavedEnvironments.layer)),
    DesktopAssets.layer,
    DesktopObservability.layer,
  ).pipe(Layer.provideMerge(tauriEnvironmentLayer));

  const sshEnvironmentLayer = Layer.unwrap(
    Effect.gen(function* () {
      const environment = yield* DesktopEnvironment.DesktopEnvironment;
      const settings = yield* DesktopAppSettings.DesktopAppSettings;
      return DesktopSshEnvironment.layer({
        resolveCliRunner: settings.get.pipe(
          Effect.map((currentSettings) => resolveSshRunner(environment, currentSettings, options)),
        ),
      });
    }),
  ).pipe(
    Layer.provideMerge(DesktopSshPasswordPrompts.layer()),
    Layer.provideMerge(foundationLayer),
  );

  const serverExposureLayer = DesktopServerExposure.layer.pipe(
    Layer.provideMerge(DesktopNetworkInterfaces.layer),
    Layer.provideMerge(foundationLayer),
  );
  const previewLayer = TauriPreview.layer.pipe(Layer.provideMerge(foundationLayer));
  const windowLayer = TauriDesktopWindow.layer.pipe(
    Layer.provideMerge(serverExposureLayer),
    Layer.provideMerge(previewLayer),
  );
  const backendLayer = DesktopBackendPool.layer.pipe(
    Layer.provideMerge(DesktopAppIdentity.layer),
    Layer.provideMerge(DesktopBackendConfiguration.layer),
    Layer.provideMerge(DesktopWslEnvironment.layer),
    Layer.provideMerge(TauriWslServerTree.layer),
    Layer.provideMerge(DesktopTelemetryPublisher.layer),
    Layer.provideMerge(windowLayer),
  );
  const wslBackendLayer = DesktopWslBackend.layer.pipe(Layer.provideMerge(backendLayer));
  const localAuthLayer = DesktopLocalEnvironmentAuth.layer.pipe(Layer.provideMerge(backendLayer));
  const applicationCoreLayer = Layer.mergeAll(
    DesktopLifecycle.layer,
    DesktopApplicationMenu.layer,
    TauriLinuxUrlHandler.layer,
    DesktopShellEnvironment.layer,
  ).pipe(
    Layer.provideMerge(DesktopUpdates.layer),
    Layer.provideMerge(wslBackendLayer),
    Layer.provideMerge(localAuthLayer),
    Layer.provideMerge(TauriClerk.layer),
    Layer.provideMerge(TauriPreReadyPlatform.layer),
  );
  const applicationLayer = applicationCoreLayer.pipe(Layer.provideMerge(sshEnvironmentLayer));
  const runtimeLayer = applicationLayer.pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(NodeHttpClient.layerUndici),
    Layer.provideMerge(NetService.layer),
    Layer.provideMerge(tauriElectronLayer),
    Layer.provideMerge(makeManagedChildSpawnerLayer(options.ports.registry)),
  );

  return runtimeLayer;
};

export const run = (options: TauriHostOptions): void => {
  DesktopApp.program.pipe(Effect.provide(makeDesktopRuntimeLayer(options)), NodeRuntime.runMain);
};
