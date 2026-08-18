import { assert, describe, it } from "@effect/vitest";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as Effect from "effect/Effect";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as Stream from "effect/Stream";

import * as TauriApp from "./electron/TauriApp.ts";
import * as TauriDialog from "./electron/TauriDialog.ts";
import * as TauriShell from "./electron/TauriShell.ts";
import * as TauriWindow from "./electron/TauriWindow.ts";
import * as TauriDesktopWindow from "./app/TauriDesktopWindow.ts";
import * as ManagedChildSpawner from "./process/ManagedChildSpawner.ts";
import { make as makeFakeShell } from "./testing/FakeShell.ts";
import { makeDesktopRuntimeLayer } from "./main.ts";

const fake = makeFakeShell();
const runtimeLayer = makeDesktopRuntimeLayer({
  dirname: "C:/worktree/apps/desktop/dist-tauri",
  homeDirectory: process.cwd(),
  platform: "win32",
  processArch: "x64",
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
  ports: {
    app: fake.app,
    dialog: {
      request: (method, params) =>
        fake.request(method as never, params as never).then(() => undefined),
    },
    shell: fake.shell,
    window: fake.window,
    registry: fake.registry,
  },
});

describe("Tauri host composition", () => {
  it.effect("builds the shared desktop graph with injected Tauri ports", () =>
    Effect.gen(function* () {
      const app = yield* TauriApp.ElectronApp;
      const window = yield* TauriWindow.ElectronWindow;
      const desktopWindow = yield* TauriDesktopWindow.DesktopWindow;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      assert.isDefined(app);
      assert.isDefined(window);
      assert.isDefined(desktopWindow);
      assert.isDefined(spawner);
      assert.strictEqual(fake.helloCalls.length, 1);
    }).pipe(Effect.provide(runtimeLayer)),
  );

  it.effect("keeps the shell adapters injectable without importing Electron", () =>
    Effect.gen(function* () {
      const shell = yield* TauriShell.ElectronShell;
      const dialog = yield* TauriDialog.ElectronDialog;

      assert.isTrue(yield* shell.openExternal("https://example.com"));
      yield* dialog.showErrorBox("Startup failed", "test");
      assert.isTrue(fake.requests.some(({ method }) => method === "shell.openExternal"));
      assert.isTrue(fake.requests.some(({ method }) => method === "dialog.error"));
    }).pipe(Effect.provide(runtimeLayer)),
  );

  it.effect("routes every derived child helper through the managed composition boundary", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const beforeRegistrations = fake.registrations.length;
        const command = ChildProcess.make(
          process.execPath,
          ["-e", "process.stdout.write('one\\ntwo\\n')"],
          {
            cwd: process.cwd(),
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
          },
        );

        assert.equal(yield* spawner.string(command), "one\ntwo\n");
        assert.deepEqual(yield* spawner.lines(command), ["one", "two"]);
        assert.equal(yield* spawner.exitCode(command), ChildProcessSpawner.ExitCode(0));
        assert.deepEqual(yield* spawner.streamLines(command).pipe(Stream.runCollect), [
          "one",
          "two",
        ]);

        const registrations = fake.registrations.slice(beforeRegistrations);
        // ChildProcessSpawner.make derives string/lines/exitCode/streamLines
        // from spawn.  Four receipts prove the runtime layer did not expose
        // the raw Node delegate to any of those helpers.
        assert.lengthOf(registrations, 4);
        assert.isTrue(registrations.every(({ pid }) => Number(pid) > 0));
        assert.isEmpty(fake.activeRegistrations);
      }),
    ).pipe(Effect.provide(runtimeLayer)),
  );
});
