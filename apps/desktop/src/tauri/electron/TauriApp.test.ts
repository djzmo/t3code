import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type * as Electron from "electron";

import * as TauriApp from "./TauriApp.ts";

const helloResult: TauriApp.TauriShellHelloResult = {
  appName: "Agent Nanoni",
  identifier: "app.nanoni.agent.desktop",
  version: "1.0.0",
  tauriVersion: "2.11.5",
  platform: "win32",
  arch: "x64",
  isDev: true,
  execPath: "C:/agent-nanoni/AgentNanoni.exe",
  resourceDir: "C:/agent-nanoni/resources",
  serverRoot: "C:/agent-nanoni/resources/server",
  appDataDir: "C:/Users/test/AppData/Roaming/Agent Nanoni",
  logDir: "C:/Users/test/AppData/Roaming/Agent Nanoni/logs",
  systemLocale: "en-US",
  deepLinkScheme: "agent-nanoni",
  argv: ["--dev"],
  launchUrls: [],
};

type EventCallback = (params: unknown) => TauriApp.TauriShellEventResult | void;

const makeShell = () => {
  const helloCalls: TauriApp.TauriShellHelloParams[] = [];
  const requests: Array<{ readonly method: string; readonly params: unknown }> = [];
  const notifications: Array<{ readonly method: string; readonly params: unknown }> = [];
  const listeners = new Map<string, EventCallback>();

  const shell: TauriApp.TauriShellPort = {
    hello: async (params) => {
      helloCalls.push(params);
      return helloResult;
    },
    request: async <Method extends TauriApp.TauriShellRequestMethod>(
      method: Method,
      params: TauriApp.TauriShellRequestParams<Method>,
    ): Promise<TauriApp.TauriShellRequestResult<Method>> => {
      requests.push({ method, params });
      switch (method) {
        case "app.isProtocolClient":
          return { registered: true } as TauriApp.TauriShellRequestResult<Method>;
        case "app.setProtocolClient":
          return { ok: true } as TauriApp.TauriShellRequestResult<Method>;
        case "app.getMetrics":
          return [
            {
              pid: 100,
              type: "Browser",
              cpuPercent: 12.5,
              memoryKb: 2048,
            },
          ] as unknown as TauriApp.TauriShellRequestResult<Method>;
      }
    },
    notify: async (method, params) => {
      notifications.push({ method, params });
    },
    on: (method, listener) => {
      const callback: EventCallback = (params) => Reflect.apply(listener, undefined, [params]);
      listeners.set(method, callback);
      return () => {
        if (listeners.get(method) === callback) listeners.delete(method);
      };
    },
  };

  return {
    shell,
    helloCalls,
    requests,
    notifications,
    listeners,
    emit: (method: string, params: unknown) => listeners.get(method)?.(params),
  };
};

describe("TauriApp", () => {
  it.effect("forwards hello, lifecycle, protocol, and metrics operations", () =>
    Effect.gen(function* () {
      const fake = makeShell();
      const app = TauriApp.make(fake.shell, { hostPid: 42 });

      assert.deepEqual(yield* app.metadata, {
        appVersion: "1.0.0",
        appPath: "C:/agent-nanoni/resources/server",
        isPackaged: false,
        resourcesPath: "C:/agent-nanoni/resources",
        runningUnderArm64Translation: false,
      });
      assert.strictEqual(yield* app.name, "Agent Nanoni");
      assert.strictEqual(yield* app.systemLocale, "en-US");
      yield* app.whenReady;
      yield* app.quit;
      yield* app.exit(75);
      yield* app.relaunch({});
      assert.isTrue(yield* app.isDefaultProtocolClient("agent-nanoni"));
      assert.isTrue(yield* app.setAsDefaultProtocolClient("agent-nanoni"));
      const metrics = yield* app.getAppMetrics;
      assert.strictEqual(metrics[0]?.pid, 100);
      assert.strictEqual(metrics[0]?.cpu.percentCPUUsage, 12.5);
      yield* app.setName("Agent Nanoni Dev");
      assert.strictEqual(yield* app.name, "Agent Nanoni Dev");

      assert.deepEqual(fake.helloCalls, [{ protocolVersion: "2.0", hostPid: 42 }]);
      assert.deepEqual(fake.notifications, [
        { method: "app.quit", params: {} },
        { method: "app.exit", params: { code: 75 } },
        { method: "app.relaunch", params: {} },
      ]);
      assert.deepEqual(fake.requests, [
        { method: "app.isProtocolClient", params: { scheme: "agent-nanoni" } },
        { method: "app.setProtocolClient", params: { scheme: "agent-nanoni" } },
        { method: "app.getMetrics", params: {} },
      ]);
    }),
  );

  it.effect("returns before-quit prevention and removes scoped listeners", () =>
    Effect.gen(function* () {
      const fake = makeShell();
      const app = TauriApp.make(fake.shell);
      let callbackCalls = 0;

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* app.on("before-quit", (event: Electron.Event) => {
            callbackCalls += 1;
            event.preventDefault();
          });
          const response = fake.emit("app.before-quit", { reason: "user" });
          assert.deepEqual(response, { prevented: true });
        }),
      );

      assert.strictEqual(callbackCalls, 1);
      assert.isFalse(fake.listeners.has("app.before-quit"));
    }),
  );

  it.effect("registers common app events and keeps updater listeners inert", () =>
    Effect.gen(function* () {
      const fake = makeShell();
      const app = TauriApp.make(fake.shell);
      let activateCalls = 0;
      let windowClosedCalls = 0;
      let secondInstanceCalls = 0;
      let openUrlCalls = 0;
      let updaterCalls = 0;

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* app.on("activate", () => {
            activateCalls += 1;
          });
          yield* app.on("window-all-closed", () => {
            windowClosedCalls += 1;
          });
          yield* app.on("second-instance", () => {
            secondInstanceCalls += 1;
          });
          yield* app.on("open-url", () => {
            openUrlCalls += 1;
          });
          yield* app.on("not-an-app-event", () => {
            throw new Error("unsupported event must not run");
          });
          yield* app.onBeforeQuitForUpdate(() => {
            updaterCalls += 1;
          });

          fake.emit("app.activate", { hasVisibleWindows: false });
          fake.emit("app.window-all-closed", {});
          fake.emit("app.second-instance", { argv: ["--open"], cwd: "C:/" });
          fake.emit("app.open-url", { urls: ["agent-nanoni://callback"] });
          assert.isFalse(fake.listeners.has("not-an-app-event"));
        }),
      );

      assert.strictEqual(activateCalls, 1);
      assert.strictEqual(windowClosedCalls, 1);
      assert.strictEqual(secondInstanceCalls, 1);
      assert.strictEqual(openUrlCalls, 1);
      assert.strictEqual(updaterCalls, 0);
      assert.isEmpty(fake.listeners);
    }),
  );
});
