const { existsSync, mkdtempSync, rmSync } = await import("node:fs");
const NodeOS = await import("node:os");
const NodePath = await import("node:path");

import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";

import * as DesktopApp from "../../app/DesktopApp.ts";
import * as IpcChannels from "../../ipc/channels.ts";
import * as TauriIpcMain from "../ipc/TauriIpcMain.ts";
import * as TauriWindow from "../electron/TauriWindow.ts";
import { makeDesktopRuntimeLayer } from "../main.ts";
import { make as makeFakeShell } from "../testing/FakeShell.ts";

const repositoryRoot = NodePath.resolve(process.cwd());
const serverEntryPath = NodePath.join(repositoryRoot, "apps/server/dist/bin.mjs");

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
      const mainWindowCreated = yield* Deferred.make<TauriWindow.TauriWindowEventParams>();
      const removeWindowListener = fake.window.on?.("window.event", (event) => {
        if (event.type === "created") completeDeferred(mainWindowCreated, event);
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => removeWindowListener?.()));

      const runtimeLayer = makeDesktopRuntimeLayer({
        dirname: NodePath.join(repositoryRoot, "apps/desktop/dist-tauri-host"),
        homeDirectory: home,
        platform: process.platform,
        processArch: process.arch,
        identity,
        packageSpec: "t3@0.0.34-nightly.20260817.1116",
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
        Deferred.await(mainWindowCreated),
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

      const branding = ipcMain.invokeSync(IpcChannels.GET_APP_BRANDING_CHANNEL);
      const locale = ipcMain.invokeSync(IpcChannels.GET_SYSTEM_LOCALE_CHANNEL);
      const bootstraps = ipcMain.invokeSync(IpcChannels.GET_LOCAL_ENVIRONMENT_BOOTSTRAPS_CHANNEL);
      assert.isObject(branding);
      assert.equal(locale, "en-US");
      assert.isArray(bootstraps);
      assert.isAtLeast(fake.registrations.length, 1);

      const beforeQuit = fake.emitAppEvent("app.before-quit", { reason: "user" });
      assert.deepEqual(beforeQuit, { prevented: true });
      yield* Fiber.join(programFiber);

      assert.isEmpty(fake.activeRegistrations);
      assert.isTrue(fake.notifications.some(({ method }) => method === "app.quit"));
      assert.isFalse(fake.notifications.some(({ method }) => method === "app.relaunch"));
    }),
);
