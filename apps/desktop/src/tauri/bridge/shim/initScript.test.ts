import { assert, describe, it } from "@effect/vitest";

import { createNanoniInitScript } from "./initScript.ts";
import { NANONI_BRIDGE_CHANNELS, NANONI_PUSH_CHANNELS } from "./bridge.ts";

type Callback = (value: unknown) => void;

const makeRenderer = () => {
  const callbacks = new Map<number, Callback>();
  const invocations: Array<{ readonly command: string; readonly args: unknown }> = [];
  let nextCallbackId = 1;
  const internals = {
    invoke: (command: string, args: unknown) => {
      invocations.push({ command, args });
      return Promise.resolve({ command, args });
    },
    transformCallback: (callback: Callback) => {
      const id = nextCallbackId++;
      callbacks.set(id, callback);
      return id;
    },
    unregisterCallback: (id: number) => {
      callbacks.delete(id);
    },
  };
  const window = { __TAURI_INTERNALS__: internals } as Record<string, unknown>;
  return { callbacks, invocations, window };
};

const runInitScript = (window: Record<string, unknown>): void => {
  const script = createNanoniInitScript({
    boot: {
      productVersion: "1.0.0",
      compatibleServerVersion: "0.0.34-nightly.20260817.1116",
      html: "</script>\u2028",
    },
    sync: {
      appBranding: { baseName: "Agent Nanoni", stageLabel: "Dev", displayName: "Agent Nanoni" },
      systemLocale: "fr-FR",
      windowFullscreenState: true,
      localEnvironmentBootstraps: [
        {
          id: "primary",
          label: "Local",
          httpBaseUrl: "http://127.0.0.1:3000",
          wsBaseUrl: "ws://127.0.0.1:3000",
        },
      ],
    },
  });
  new Function("window", script)(window);
};

describe("Nanoni renderer init script", () => {
  it("publishes frozen boot and synchronous preload-compatible values before evaluation", () => {
    const { window } = makeRenderer();
    runInitScript(window);

    const boot = window.__NANONI_BOOT__ as Record<string, unknown>;
    assert.equal(boot.productVersion, "1.0.0");
    assert.isTrue(Object.isFrozen(boot));
    assert.isTrue(Object.isFrozen(boot.html));

    const bridge = window.desktopBridge as {
      getAppBranding: () => unknown;
      getSystemLocale: () => unknown;
      getLocalEnvironmentBootstraps: () => unknown;
      getWindowFullscreenState: () => boolean;
    };
    assert.deepEqual(bridge.getAppBranding(), {
      baseName: "Agent Nanoni",
      stageLabel: "Dev",
      displayName: "Agent Nanoni",
    });
    assert.equal(bridge.getSystemLocale(), "fr-FR");
    assert.isTrue(bridge.getWindowFullscreenState());
    assert.deepEqual(bridge.getLocalEnvironmentBootstraps(), [
      {
        id: "primary",
        label: "Local",
        httpBaseUrl: "http://127.0.0.1:3000",
        wsBaseUrl: "ws://127.0.0.1:3000",
      },
    ]);
  });

  it("uses host_invoke and registers one ordered desktop_events channel", async () => {
    const { callbacks, invocations, window } = makeRenderer();
    runInitScript(window);
    const bridge = window.desktopBridge as {
      getClientSettings: () => Promise<unknown>;
      onMenuAction: (listener: (action: string) => void) => () => void;
    };
    const received: unknown[] = [];
    const remove = bridge.onMenuAction((payload) => received.push(payload));

    const result = await bridge.getClientSettings();
    assert.deepEqual(result, {
      command: "host_invoke",
      args: { channel: NANONI_BRIDGE_CHANNELS.getClientSettings, payload: null },
    });
    assert.equal(invocations.length, 2);
    assert.equal(invocations[0]?.command, "desktop_events");
    assert.equal(invocations[1]?.command, "host_invoke");

    const eventArgs = invocations[0]?.args as { channel: { toJSON: () => string } };
    assert.equal(eventArgs.channel.toJSON(), "__CHANNEL__:1");
    const callback = callbacks.get(1);
    assert.isFunction(callback);
    callback?.({
      index: 1,
      message: { channel: NANONI_PUSH_CHANNELS.onMenuAction, payload: "second" },
    });
    callback?.({
      index: 0,
      message: { channel: NANONI_PUSH_CHANNELS.onMenuAction, payload: "first" },
    });
    assert.deepEqual(received, ["first", "second"]);

    remove();
    callback?.({
      index: 2,
      message: { channel: NANONI_PUSH_CHANNELS.onMenuAction, payload: "ignored" },
    });
    assert.deepEqual(received, ["first", "second"]);
  });

  it("formats invoke failures with the Electron-compatible method context", () => {
    const { window } = makeRenderer();
    const internals = window.__TAURI_INTERNALS__ as {
      invoke: (command: string, args: unknown) => Promise<never>;
    };
    internals.invoke = () => Promise.reject(new Error("denied"));
    runInitScript(window);
    const bridge = window.desktopBridge as {
      openExternal: (url: string) => Promise<unknown>;
    };

    return bridge.openExternal("https://example.com").then(
      () => assert.fail("expected invoke to reject"),
      (error: unknown) =>
        assert.equal(
          String(error),
          `Error: Error invoking remote method '${NANONI_BRIDGE_CHANNELS.openExternal}': denied`,
        ),
    );
  });

  it("matches the Electron preload member set while omitting preview", () => {
    const { window } = makeRenderer();
    runInitScript(window);
    const keys = Object.keys(window.desktopBridge as object).sort();
    assert.deepEqual(
      keys,
      [
        "bootstrapSshBearerSession",
        "checkForUpdate",
        "clearConnectionCatalog",
        "disconnectSshEnvironment",
        "discoverSshHosts",
        "downloadUpdate",
        "ensureSshEnvironment",
        "fetchSshEnvironmentDescriptor",
        "fetchSshSessionState",
        "getAdvertisedEndpoints",
        "getAppBranding",
        "getClientSettings",
        "getConnectionCatalog",
        "getLocalEnvironmentBearerToken",
        "getLocalEnvironmentBootstraps",
        "getServerExposureState",
        "getSystemLocale",
        "getUpdateState",
        "getWindowFullscreenState",
        "getWslState",
        "installUpdate",
        "issueSshWebSocketTicket",
        "onMenuAction",
        "onQuitShortcut",
        "onSshPasswordPrompt",
        "onUpdateState",
        "onWindowFullscreenStateChange",
        "openExternal",
        "pickFolder",
        "pickThemeFiles",
        "probeRemoteEditors",
        "resolveSshPasswordPrompt",
        "setClientSettings",
        "setConnectionCatalog",
        "setServerExposureMode",
        "setTailscaleServeEnabled",
        "setTheme",
        "setUpdateChannel",
        "setWslBackendEnabled",
        "setWslDistro",
        "setWslOnly",
        "showContextMenu",
      ].sort(),
    );
    assert.isFalse("preview" in (window.desktopBridge as object));
  });

  it("rethrows the Electron cancellation message for SSH prompts", async () => {
    const { window } = makeRenderer();
    const internals = window.__TAURI_INTERNALS__ as {
      invoke: (command: string, args: unknown) => Promise<unknown>;
    };
    internals.invoke = (_command, args) => {
      const request = args as { readonly channel?: string };
      if (request.channel === NANONI_BRIDGE_CHANNELS.ensureSshEnvironment) {
        return Promise.resolve({
          type: "ssh-password-prompt-cancelled",
          message: "No password entered.",
        });
      }
      return Promise.resolve(undefined);
    };
    runInitScript(window);
    const bridge = window.desktopBridge as {
      ensureSshEnvironment: (target: unknown) => Promise<unknown>;
    };
    await bridge.ensureSshEnvironment({ host: "example.com" }).then(
      () => assert.fail("expected cancellation to reject"),
      (error: unknown) => assert.equal(String(error), "Error: No password entered."),
    );
  });
});
