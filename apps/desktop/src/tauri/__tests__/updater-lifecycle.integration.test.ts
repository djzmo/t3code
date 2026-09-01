import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { DesktopUpdateState } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as DesktopBackendPool from "../../backend/DesktopBackendPool.ts";
import * as DesktopConfig from "../../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopLifecycle from "../../app/DesktopLifecycle.ts";
import * as DesktopShutdown from "../../app/DesktopShutdown.ts";
import * as DesktopState from "../../app/DesktopState.ts";
import * as ElectronApp from "../../electron/ElectronApp.ts";
import * as ElectronTheme from "../../electron/ElectronTheme.ts";
import * as ElectronUpdater from "../../electron/ElectronUpdater.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopWindow from "../../window/DesktopWindow.ts";
import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";
import * as DesktopUpdates from "../../updates/DesktopUpdates.ts";
import * as TauriApp from "../electron/TauriApp.ts";
import { make as makeFakeShell } from "../testing/FakeShell.ts";

const completeDeferred = <A>(deferred: Deferred.Deferred<A>, value: A): void => {
  void Effect.runPromise(Deferred.succeed(deferred, value));
};

/**
 * L6 is a cross-seam contract: DesktopUpdates owns the install request, while
 * DesktopLifecycle owns the shell's before-quit continuation.  Keep this
 * fixture deliberately small and use the real services on both sides.
 */
it.effect("routes updater install through one lifecycle shutdown", () =>
  Effect.gen(function* () {
    const fake = makeFakeShell({
      hello: {
        appName: "Agent Nanoni",
        identifier: "app.nanoni.agent.desktop",
        version: "1.0.0",
        tauriVersion: "2.11.5",
        platform: "darwin",
        arch: "x64",
        isDev: false,
      },
    });
    const sequence: string[] = [];
    let onAppQuit: (() => void) | undefined;
    let updaterHookRegistrations = 0;
    let updaterHookCalls = 0;
    let quitAndInstallCalls = 0;
    let shutdownRequests = 0;

    // The native shell's app.quit notification produces the continuation
    // before-quit event.  The updater's own call produces the first event.
    const appPort: TauriApp.TauriShellPort = {
      hello: fake.app.hello,
      request: fake.app.request,
      notify: (method, params) => {
        const result = fake.app.notify(method as never, params as never);
        if (method === "app.quit") {
          sequence.push("app.quit");
          fake.emitAppEvent("app.before-quit", { reason: "updater" });
          onAppQuit?.();
        }
        return result;
      },
      on: fake.app.on,
    };
    const tauriApp = TauriApp.make(appPort);
    const electronApp = {
      ...tauriApp,
      onBeforeQuitForUpdate: (listener: () => void) => {
        updaterHookRegistrations += 1;
        return tauriApp.onBeforeQuitForUpdate(() => {
          updaterHookCalls += 1;
          listener();
        });
      },
    } satisfies ElectronApp.ElectronApp["Service"];
    const appLayer = Layer.succeed(TauriApp.ElectronApp, electronApp);

    const updaterListeners = new Map<string, Set<(...args: readonly unknown[]) => void>>();
    const updaterLayer = Layer.succeed(ElectronUpdater.ElectronUpdater, {
      setFeedURL: () => Effect.void,
      setAutoDownload: () => Effect.void,
      setAutoInstallOnAppQuit: () => Effect.void,
      setChannel: () => Effect.void,
      setAllowPrerelease: () => Effect.void,
      allowDowngrade: Effect.succeed(false),
      setAllowDowngrade: () => Effect.void,
      setFullChangelog: () => Effect.void,
      setDisableDifferentialDownload: () => Effect.void,
      checkForUpdates: Effect.void,
      downloadUpdate: Effect.void,
      quitAndInstall: () =>
        Effect.sync(() => {
          quitAndInstallCalls += 1;
          sequence.push("updater.quitAndInstall");
          fake.emitAppEvent("app.before-quit", { reason: "updater" });
        }),
      on: (eventName, listener) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const listeners = updaterListeners.get(eventName) ?? new Set();
            listeners.add(listener as unknown as (...args: readonly unknown[]) => void);
            updaterListeners.set(eventName, listeners);
          }),
          () =>
            Effect.sync(() => {
              const listeners = updaterListeners.get(eventName);
              listeners?.delete(listener as unknown as (...args: readonly unknown[]) => void);
              if (listeners?.size === 0) updaterListeners.delete(eventName);
            }),
        ).pipe(Effect.asVoid),
    } satisfies ElectronUpdater.ElectronUpdater["Service"]);

    const electronWindowLayer = Layer.succeed(ElectronWindow.ElectronWindow, {
      create: () => Effect.die("unexpected BrowserWindow creation"),
      main: Effect.succeed(Option.none()),
      currentMainOrFirst: Effect.succeed(Option.none()),
      focusedMainOrFirst: Effect.succeed(Option.none()),
      setMain: () => Effect.void,
      clearMain: () => Effect.void,
      reveal: () => Effect.void,
      sendAll: (_channel, state) =>
        Effect.sync(() => sequence.push(`state:${(state as DesktopUpdateState).status}`)),
      destroyAll: Effect.sync(() => sequence.push("destroyAll")),
      syncAllAppearance: () => Effect.void,
    } satisfies ElectronWindow.ElectronWindow["Service"]);

    const backendLayer = DesktopBackendPool.layerTest([
      {
        id: DesktopBackendPool.PRIMARY_INSTANCE_ID,
        label: Effect.succeed("primary"),
        start: Effect.void,
        stop: () => Effect.sync(() => sequence.push("backend.stop")),
        currentConfig: Effect.succeed(Option.none()),
        snapshot: Effect.succeed({
          desiredRunning: true,
          ready: true,
          activePid: Option.none(),
          restartAttempt: 0,
          restartScheduled: false,
        }),
        waitForReady: () => Effect.succeed(true),
      } satisfies DesktopBackendPool.DesktopBackendInstance,
    ]);

    const desktopWindowLayer = Layer.succeed(DesktopWindow.DesktopWindow, {
      createMain: Effect.die("unexpected main window creation"),
      ensureMain: Effect.die("unexpected main window creation"),
      revealOrCreateMain: Effect.die("unexpected main window creation"),
      activate: Effect.void,
      createMainIfBackendReady: Effect.void,
      showConnectingSplash: Effect.void,
      handleBackendReady: () => Effect.void,
      handleBackendNotReady: Effect.void,
      flushMainWindowBounds: Effect.sync(() => sequence.push("flushBounds")),
      dispatchMenuAction: () => Effect.void,
      zoomMain: () => Effect.void,
      syncAppearance: Effect.void,
    } satisfies DesktopWindow.DesktopWindow["Service"]);
    const themeLayer = Layer.succeed(ElectronTheme.ElectronTheme, {
      shouldUseDarkColors: Effect.succeed(false),
      setSource: () => Effect.void,
      onUpdated: () => Effect.acquireRelease(Effect.void, () => Effect.void).pipe(Effect.asVoid),
    });

    const shutdownLayer = Layer.effect(
      DesktopShutdown.DesktopShutdown,
      Effect.gen(function* () {
        const requested = yield* Deferred.make<void>();
        const completed = yield* Deferred.make<void>();
        const completeRef = yield* Ref.make(false);
        return DesktopShutdown.DesktopShutdown.of({
          request: Effect.suspend(() => {
            shutdownRequests += 1;
            return Deferred.succeed(requested, undefined).pipe(Effect.asVoid);
          }),
          awaitRequest: Deferred.await(requested),
          markComplete: Ref.set(completeRef, true).pipe(
            Effect.andThen(Deferred.succeed(completed, undefined)),
            Effect.asVoid,
          ),
          awaitComplete: Deferred.await(completed),
          isComplete: Ref.get(completeRef),
        });
      }),
    );

    const stateLayer = DesktopState.layer;
    const configLayer = DesktopConfig.layerTest({
      T3CODE_HOME: `/tmp/agent-nanoni-updater-${process.pid}`,
      T3CODE_DESKTOP_MOCK_UPDATES: "true",
      T3CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT: "4141",
    });
    const environmentLayer = DesktopEnvironment.layer({
      dirname: "/repo/apps/desktop/src",
      homeDirectory: `/tmp/agent-nanoni-updater-home-${process.pid}`,
      platform: "darwin",
      processArch: "x64",
      appVersion: "1.0.0",
      appPath: "/repo",
      isPackaged: true,
      resourcesPath: "/repo/resources",
      runningUnderArm64Translation: false,
    }).pipe(Layer.provide(configLayer), Layer.provide(NodeServices.layer));

    const runtimeLayer = Layer.mergeAll(DesktopLifecycle.layer, DesktopUpdates.layer).pipe(
      Layer.provideMerge(appLayer),
      Layer.provideMerge(themeLayer),
      Layer.provideMerge(desktopWindowLayer),
      Layer.provideMerge(shutdownLayer),
      Layer.provideMerge(stateLayer),
      Layer.provideMerge(updaterLayer),
      Layer.provideMerge(electronWindowLayer),
      Layer.provideMerge(backendLayer),
      Layer.provideMerge(DesktopAppSettings.layerTest()),
      Layer.provideMerge(environmentLayer),
      Layer.provideMerge(configLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    const appQuitRequested = yield* Deferred.make<void>();
    onAppQuit = () => {
      completeDeferred(appQuitRequested, undefined);
    };

    yield* Effect.scoped(
      Effect.gen(function* () {
        const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
        const updates = yield* DesktopUpdates.DesktopUpdates;
        const shutdown = yield* DesktopShutdown.DesktopShutdown;

        yield* lifecycle.register;
        yield* updates.configure;

        for (const listener of updaterListeners.get("update-downloaded") ?? []) {
          listener({ version: "1.0.1" });
        }
        yield* Effect.yieldNow;

        const installFiber = yield* updates.install.pipe(Effect.forkScoped);
        yield* shutdown.awaitRequest;
        assert.equal(shutdownRequests, 1, "updater install must request one lifecycle shutdown");

        yield* shutdown.markComplete;
        yield* Fiber.join(installFiber);
        yield* Deferred.await(appQuitRequested);
      }),
    ).pipe(Effect.provide(runtimeLayer));

    const beforeQuitEvents = fake.events.filter(({ method }) => method === "app.before-quit");
    assert.equal(updaterHookRegistrations, 1, "lifecycle must register the updater hook");
    assert.equal(updaterHookCalls, 0, "Tauri's updater hook must never fire");
    assert.equal(quitAndInstallCalls, 1);
    assert.deepEqual(
      beforeQuitEvents.map(
        (event) => (event.result as { readonly prevented?: boolean } | undefined)?.prevented,
      ),
      [true, false],
      "the updater quit is intercepted once, then the continuation is allowed",
    );
    assert.equal(shutdownRequests, 1);
    const lifecycleSequence = sequence.filter((entry) => !entry.startsWith("state:"));
    assert.deepEqual(lifecycleSequence.slice(0, 5), [
      "backend.stop",
      "destroyAll",
      "updater.quitAndInstall",
      "flushBounds",
      "app.quit",
    ]);
  }),
);
