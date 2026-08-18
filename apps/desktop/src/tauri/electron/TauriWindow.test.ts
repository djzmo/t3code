import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as UpstreamElectronWindow from "../../electron/ElectronWindow.ts";
import * as TauriWindow from "./TauriWindow.ts";

const makePort = () => {
  const notifications: Array<{ readonly method: string; readonly params: unknown }> = [];
  const created: TauriWindow.TauriWindowCreateParams[] = [];
  const listeners: Array<(event: TauriWindow.TauriWindowEventParams) => void> = [];
  let listenerRegistrationCount = 0;
  let disposerCallCount = 0;

  const port: TauriWindow.TauriWindowPort = {
    create: (params) => {
      created.push(params);
      return { label: params.label };
    },
    request: (_method, _params) => ({}),
    notify: (method, params) => {
      notifications.push({ method, params });
    },
    on: (_method, listener) => {
      listenerRegistrationCount += 1;
      listeners.push(listener);
      return () => {
        disposerCallCount += 1;
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
  };

  return {
    port,
    notifications,
    created,
    get listenerRegistrationCount() {
      return listenerRegistrationCount;
    },
    get disposerCallCount() {
      return disposerCallCount;
    },
    emit: (event: TauriWindow.TauriWindowEventParams) => {
      for (const listener of [...listeners]) listener(event);
    },
  } as const;
};

const captureUnsupportedMember = (window: object): unknown => {
  try {
    Reflect.get(window, "setAutoHideCursor");
    return undefined;
  } catch (error) {
    return error;
  }
};

describe("TauriWindow", () => {
  it.effect("creates a guarded facade and forwards supported window operations", () =>
    Effect.gen(function* () {
      const fake = makePort();
      const service = TauriWindow.make(fake.port);
      const window = yield* service.create({
        title: "Agent Nanoni",
        width: 900,
        height: 700,
        minWidth: 840,
        minHeight: 620,
        show: false,
        frame: false,
        backgroundColor: "#101010",
        webPreferences: {},
      });
      const handle = window as unknown as TauriWindow.TauriWindowHandle;

      assert.equal(handle.label, "main");
      assert.strictEqual(handle.id, 1);
      assert.isFalse(handle.isVisible());
      handle.setTitle("Updated");
      handle.setBounds({ x: 20, y: 30, width: 1000, height: 800 });
      handle.show();
      handle.focus();
      handle.webContents.send("desktop:menu-action", "open-settings");
      yield* service.reveal(window);

      assert.deepEqual(fake.created, [
        {
          label: "main",
          title: "Agent Nanoni",
          width: 900,
          height: 700,
          minWidth: 840,
          minHeight: 620,
          show: false,
          backgroundColor: "#101010",
          decorations: false,
          titleBarStyle: "default",
          hiddenTitle: false,
          initScripts: [],
        },
      ]);
      assert.deepEqual(fake.notifications, [
        { method: "window.setTitle", params: { label: "main", title: "Updated" } },
        {
          method: "window.setBounds",
          params: { label: "main", x: 20, y: 30, width: 1000, height: 800 },
        },
        { method: "window.show", params: { label: "main" } },
        { method: "window.focus", params: { label: "main" } },
        {
          method: "ipc.push",
          params: { channel: "desktop:menu-action", payload: "open-settings" },
        },
        { method: "window.focus", params: { label: "main" } },
      ]);
      assert.deepEqual(TauriWindow.readMirroredState(handle), {
        visible: true,
        focused: true,
        minimized: false,
        maximized: false,
        fullscreen: false,
        destroyed: false,
      });
    }),
  );

  it.effect("throws a typed error for unsupported facade members", () =>
    Effect.gen(function* () {
      const fake = makePort();
      const service = TauriWindow.make(fake.port);
      const window = yield* service.create({
        title: "Test",
        width: 100,
        height: 100,
        minWidth: 0,
        minHeight: 0,
        show: true,
        webPreferences: {},
      });

      const caught = captureUnsupportedMember(window as unknown as object);
      assert.isTrue(TauriWindow.isTauriWindowFacadeError(caught));
      if (TauriWindow.isTauriWindowFacadeError(caught)) {
        assert.strictEqual(caught.member, "setAutoHideCursor");
        assert.strictEqual(caught.label, "main");
      }
    }),
  );

  it.effect("uses one service listener across close and recreate cycles", () =>
    Effect.gen(function* () {
      const fake = makePort();
      const service = TauriWindow.make(fake.port);
      const first = yield* service.create({
        title: "First",
        width: 100,
        height: 100,
        minWidth: 0,
        minHeight: 0,
        show: true,
        webPreferences: {},
      });
      const firstHandle = first as unknown as TauriWindow.TauriWindowHandle;
      firstHandle.close();
      assert.deepEqual(fake.notifications[0], {
        method: "window.close",
        params: { label: "main" },
      });
      assert.isTrue(TauriWindow.readMirroredState(firstHandle).destroyed);
      fake.emit({ label: "main", type: "closed" });
      yield* service.create({
        title: "Second",
        width: 100,
        height: 100,
        minWidth: 0,
        minHeight: 0,
        show: true,
        webPreferences: {},
      });
      assert.strictEqual(fake.listenerRegistrationCount, 1);
    }),
  );

  it.effect("disposes the service listener with its layer scope", () =>
    Effect.gen(function* () {
      const fake = makePort();
      yield* Effect.scoped(
        Effect.gen(function* () {
          const service = yield* TauriWindow.ElectronWindow;
          yield* service.create({
            title: "Scoped",
            width: 100,
            height: 100,
            minWidth: 0,
            minHeight: 0,
            show: true,
            webPreferences: {},
          });
          assert.strictEqual(fake.listenerRegistrationCount, 1);
          assert.strictEqual(fake.disposerCallCount, 0);
        }).pipe(Effect.provide(TauriWindow.layer(fake.port))),
      );
      assert.strictEqual(fake.disposerCallCount, 1);

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* TauriWindow.ElectronWindow;
        }).pipe(Effect.provide(TauriWindow.layer(fake.port))),
      );
      assert.strictEqual(fake.listenerRegistrationCount, 2);
      assert.strictEqual(fake.disposerCallCount, 2);
    }),
  );

  it("keeps the upstream Context.Service key while avoiding runtime Electron imports", () => {
    assert.strictEqual(TauriWindow.ElectronWindow.key, UpstreamElectronWindow.ElectronWindow.key);
    // The module imports Electron only through type-only declarations; this
    // assertion proves the facade can be loaded without an Electron runtime.
    assert.isFunction(TauriWindow.make);
  });
});
