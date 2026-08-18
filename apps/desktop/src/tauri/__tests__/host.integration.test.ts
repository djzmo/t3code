const { existsSync, mkdtempSync, readFileSync, rmSync } = await import("node:fs");
const NodeOS = await import("node:os");
const NodePath = await import("node:path");

import { assert, it } from "@effect/vitest";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";

import * as DesktopApp from "../../app/DesktopApp.ts";
import * as IpcChannels from "../../ipc/channels.ts";
import * as TauriIpcMain from "../ipc/TauriIpcMain.ts";
import * as TauriWindow from "../electron/TauriWindow.ts";
import { makeDesktopRuntimeLayer } from "../main.ts";
import { make as makeFakeShell } from "../testing/FakeShell.ts";

const repositoryRoot = NodePath.resolve(process.cwd());
const serverEntryPath = NodePath.join(repositoryRoot, "apps/server/dist/bin.mjs");
const persistedRuntimeStateSchema = Schema.Struct({
  pid: Schema.Int,
  port: Schema.Int,
  origin: Schema.String,
});
const decodePersistedRuntimeState = Schema.decodeUnknownEffect(
  Schema.fromJsonString(persistedRuntimeStateSchema),
);

class HostIntegrationReadinessError extends Schema.TaggedErrorClass<HostIntegrationReadinessError>()(
  "HostIntegrationReadinessError",
  { detail: Schema.String },
) {
  override get message(): string {
    return `DesktopApp exited before the main window became ready: ${this.detail}`;
  }
}

const completeDeferred = <A>(deferred: Deferred.Deferred<A>, value: A): void => {
  void Effect.runPromise(Deferred.succeed(deferred, value));
};

const identity = {
  branding: {
    baseName: "Agent Nanoni",
    stageLabel: "Dev",
    displayName: "Agent Nanoni (Dev)",
  },
  displayName: "Agent Nanoni (Dev)",
  appUserModelId: "app.nanoni.agent.desktop.dev",
  linuxDesktopEntryName: "agent-nanoni-dev.desktop",
  linuxWmClass: "agent-nanoni-dev",
  userDataDirName: "agent-nanoni-dev",
  legacyUserDataDirName: "Agent Nanoni (Dev)",
} as const;

const withTemporaryHome = Effect.acquireRelease(
  Effect.sync(() => {
    const home = mkdtempSync(NodePath.join(NodeOS.tmpdir(), "agent-nanoni-host-"));
    const previous = {
      appData: process.env.APPDATA,
      t3Home: process.env.T3CODE_HOME,
      port: process.env.T3CODE_PORT,
      devServerUrl: process.env.VITE_DEV_SERVER_URL,
      disableAutoUpdate: process.env.T3CODE_DISABLE_AUTO_UPDATE,
    };
    process.env.APPDATA = home;
    process.env.T3CODE_HOME = home;
    delete process.env.T3CODE_PORT;
    delete process.env.VITE_DEV_SERVER_URL;
    process.env.T3CODE_DISABLE_AUTO_UPDATE = "1";
    return { home, previous };
  }),
  ({ home, previous }) =>
    Effect.sync(() => {
      if (previous.appData === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = previous.appData;
      if (previous.t3Home === undefined) delete process.env.T3CODE_HOME;
      else process.env.T3CODE_HOME = previous.t3Home;
      if (previous.port === undefined) delete process.env.T3CODE_PORT;
      else process.env.T3CODE_PORT = previous.port;
      if (previous.devServerUrl === undefined) delete process.env.VITE_DEV_SERVER_URL;
      else process.env.VITE_DEV_SERVER_URL = previous.devServerUrl;
      if (previous.disableAutoUpdate === undefined) delete process.env.T3CODE_DISABLE_AUTO_UPDATE;
      else process.env.T3CODE_DISABLE_AUTO_UPDATE = previous.disableAutoUpdate;
      rmSync(home, { recursive: true, force: true });
    }),
);

it.live.skipIf(!existsSync(serverEntryPath))(
  "boots DesktopApp against the real server and shuts down through Tauri lifecycle",
  () =>
    Effect.gen(function* () {
      assert.match(process.version, /^v24\./, "real-host integration requires repository Node 24");
      const { home } = yield* withTemporaryHome;
      const fake = makeFakeShell({
        hello: {
          appName: "Agent Nanoni",
          identifier: "app.nanoni.agent.desktop.dev",
          version: "1.0.0",
          isDev: true,
          execPath: process.execPath,
          resourceDir: NodePath.join(repositoryRoot, "apps/desktop/dist-tauri-host"),
          serverRoot: repositoryRoot,
          appDataDir: home,
          logDir: NodePath.join(home, "logs"),
          platform: process.platform,
          arch: process.arch,
          argv: [],
          launchUrls: [],
        },
      });
      const ipcMain = TauriIpcMain.make();
      const backendReadyRevealed = yield* Deferred.make<TauriWindow.TauriWindowEventParams>();
      const removeWindowListener = fake.window.on?.("window.event", (event) => {
        // TauriDesktopWindow.handleBackendReady is called only after
        // DesktopBackendManager's authoritative HTTP readiness probe.  The
        // resulting reveal emits focus after window creation; waiting for it
        // keeps this integration gate from passing on creation alone.
        if (event.type === "focus") completeDeferred(backendReadyRevealed, event);
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => removeWindowListener?.()));

      const runtimeLayer = makeDesktopRuntimeLayer({
        dirname: NodePath.join(repositoryRoot, "apps/desktop/dist-tauri-host"),
        homeDirectory: home,
        platform: process.platform,
        processArch: process.arch,
        identity,
        ports: {
          app: fake.app,
          dialog: {
            request: (method, params) =>
              fake.request(method as never, params as never).then(() => undefined),
          },
          shell: fake.shell,
          window: fake.window,
          registry: fake.registry,
          ipcMain,
        },
      });

      const programExited = yield* Deferred.make<void>();
      const program = DesktopApp.program.pipe(
        Effect.provide(runtimeLayer),
        Effect.ensuring(Deferred.succeed(programExited, undefined)),
      );
      const programFiber = yield* Effect.forkScoped(program);
      yield* Effect.raceFirst(
        Deferred.await(backendReadyRevealed),
        Deferred.await(programExited).pipe(
          Effect.flatMap(() =>
            Effect.fail(
              new HostIntegrationReadinessError({
                detail: "program exit",
              }),
            ),
          ),
        ),
      );

      const runtimeStatePath = NodePath.join(home, "userdata", "server-runtime.json");
      assert.isTrue(existsSync(runtimeStatePath));
      const runtimeState = yield* decodePersistedRuntimeState(
        readFileSync(runtimeStatePath, "utf8"),
      );
      const origin = new URL(runtimeState.origin);
      assert.equal(origin.protocol, "http:");
      assert.include(["127.0.0.1", "localhost"], origin.hostname);

      // This is the server's public, token-free readiness/bootstrap receipt,
      // using the persisted origin written by that exact child process.
      const readinessResponse = yield* HttpClient.get(
        new URL("/.well-known/t3/environment", origin),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new HostIntegrationReadinessError({
              detail: `well-known readiness request failed: ${String(cause)}`,
            }),
        ),
        Effect.provide(NodeHttpClient.layerUndici),
      );
      yield* readinessResponse.text;
      assert.equal(readinessResponse.status, 200);
      const serverRegistration = fake.registrations.find(
        ({ pid }) => Number(pid) === runtimeState.pid,
      );
      assert.isDefined(serverRegistration);
      assert.isTrue(fake.activeRegistrations.some(({ pid }) => Number(pid) === runtimeState.pid));

      const createRequestIndex = fake.requests.findIndex(
        ({ method }) => method === "window.create",
      );
      const showNotificationIndex = fake.notifications.findIndex(
        ({ method }) => method === "window.show",
      );
      const focusNotificationIndex = fake.notifications.findIndex(
        ({ method }) => method === "window.focus",
      );
      assert.isAtLeast(createRequestIndex, 0);
      assert.isAtLeast(showNotificationIndex, 0);
      assert.isTrue(focusNotificationIndex > showNotificationIndex);

      const branding = ipcMain.invokeSync(IpcChannels.GET_APP_BRANDING_CHANNEL);
      const locale = ipcMain.invokeSync(IpcChannels.GET_SYSTEM_LOCALE_CHANNEL);
      const bootstraps = ipcMain.invokeSync(IpcChannels.GET_LOCAL_ENVIRONMENT_BOOTSTRAPS_CHANNEL);
      assert.isObject(branding);
      assert.equal(locale, "en-US");
      assert.isArray(bootstraps);
      assert.isAtLeast(fake.registrations.length, 1);
      const windowCreate = fake.requests.find(({ method }) => method === "window.create");
      assert.isDefined(windowCreate);
      const initScripts = (windowCreate?.params as { readonly initScripts?: readonly string[] })
        .initScripts;
      assert.lengthOf(initScripts ?? [], 1);
      assert.include(initScripts?.[0] ?? "", "__NANONI_BOOT__");
      assert.include(initScripts?.[0] ?? "", "desktopBridge");

      const beforeQuit = fake.emitAppEvent("app.before-quit", { reason: "user" });
      assert.deepEqual(beforeQuit, { prevented: true });
      yield* Fiber.join(programFiber);

      assert.isEmpty(fake.activeRegistrations);
      assert.isTrue(fake.notifications.some(({ method }) => method === "app.quit"));
      assert.isFalse(fake.notifications.some(({ method }) => method === "app.relaunch"));
    }),
);
