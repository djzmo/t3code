import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as DesktopConfig from "../../app/DesktopConfig.ts";
import * as TauriDesktopWindow from "./TauriDesktopWindow.ts";
import * as TauriEnvironment from "./TauriEnvironment.ts";
import * as TauriWindow from "../electron/TauriWindow.ts";

const environmentLayer = TauriEnvironment.layer({
  dirname: "C:/worktree/apps/desktop/dist-tauri",
  homeDirectory: "C:/Users/test",
  platform: "win32",
  processArch: "x64",
  appVersion: "1.0.0-dev",
  appPath: "C:/worktree/apps/desktop/dist-tauri/host.cjs",
  isPackaged: false,
  resourcesPath: "C:/worktree/resources",
  runningUnderArm64Translation: false,
  identity: {
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
  },
}).pipe(Layer.provideMerge(NodeServices.layer), Layer.provideMerge(DesktopConfig.layerTest({})));

const makePort = () => {
  const notifications: Array<{ readonly method: string; readonly params: unknown }> = [];
  const created: TauriWindow.TauriWindowCreateParams[] = [];
  const port: TauriWindow.TauriWindowPort = {
    create: (params) => {
      created.push(params);
      return { label: params.label };
    },
    request: () => ({}),
    notify: (method, params) => {
      notifications.push({ method, params });
    },
  };
  return { port, notifications, created } as const;
};

describe("TauriDesktopWindow", () => {
  it.effect("creates and reveals the main window when the backend becomes ready", () => {
    const fake = makePort();
    const layer = TauriDesktopWindow.layer.pipe(Layer.provide(TauriWindow.layer(fake.port)));
    const fullLayer = layer.pipe(Layer.provideMerge(environmentLayer));

    return Effect.gen(function* () {
      const desktopWindow = yield* TauriDesktopWindow.DesktopWindow;
      yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

      assert.deepEqual(fake.created, [
        {
          label: "main",
          title: "Agent Nanoni (Dev)",
          width: 1320,
          height: 880,
          minWidth: 840,
          minHeight: 620,
          show: false,
          backgroundColor: "#ffffff",
          decorations: true,
          titleBarStyle: "default",
          hiddenTitle: false,
          initScripts: [],
        },
      ]);
      assert.deepEqual(fake.notifications, [
        { method: "window.show", params: { label: "main" } },
        { method: "window.focus", params: { label: "main" } },
      ]);
      const main = yield* desktopWindow.ensureMain;
      assert.isFalse(main.isDestroyed());
    }).pipe(Effect.provide(fullLayer));
  });

  it.effect("keeps the V1.1-only operations inert and routes menu actions", () =>
    Effect.suspend(() => {
      const fake = makePort();
      return Effect.gen(function* () {
        const desktopWindow = yield* TauriDesktopWindow.DesktopWindow;
        yield* desktopWindow.createMain;
        yield* desktopWindow.zoomMain("in");
        yield* desktopWindow.syncAppearance;
        yield* desktopWindow.dispatchMenuAction("open-settings");
        assert.deepEqual(fake.notifications, [
          {
            method: "ipc.push",
            params: { channel: "desktop:menu-action", payload: "open-settings" },
          },
          { method: "window.show", params: { label: "main" } },
          { method: "window.focus", params: { label: "main" } },
        ]);
      }).pipe(
        Effect.provide(
          TauriDesktopWindow.layer.pipe(
            Layer.provide(TauriWindow.layer(fake.port)),
            Layer.provideMerge(environmentLayer),
          ),
        ),
      );
    }),
  );
});
