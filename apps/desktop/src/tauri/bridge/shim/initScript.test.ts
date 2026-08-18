import { assert, describe, it } from "@effect/vitest";

import { createNanoniInitScript } from "./initScript.ts";

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
    };
    assert.deepEqual(bridge.getAppBranding(), {
      baseName: "Agent Nanoni",
      stageLabel: "Dev",
      displayName: "Agent Nanoni",
    });
    assert.equal(bridge.getSystemLocale(), "fr-FR");
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
      invoke: (channel: string, payload: unknown) => Promise<unknown>;
      on: (channel: string, listener: (payload: unknown) => void) => () => void;
    };
    const received: unknown[] = [];
    const remove = bridge.on("desktop:test", (payload) => received.push(payload));

    const result = await bridge.invoke("desktop:echo", { answer: 42 });
    assert.deepEqual(result, {
      command: "host_invoke",
      args: { channel: "desktop:echo", payload: { answer: 42 } },
    });
    assert.equal(invocations.length, 2);
    assert.equal(invocations[0]?.command, "desktop_events");
    assert.equal(invocations[1]?.command, "host_invoke");

    const eventArgs = invocations[0]?.args as { channel: { toJSON: () => string } };
    assert.equal(eventArgs.channel.toJSON(), "__CHANNEL__:1");
    const callback = callbacks.get(1);
    assert.isFunction(callback);
    callback?.({ index: 1, message: { channel: "desktop:test", payload: "second" } });
    callback?.({ index: 0, message: { channel: "desktop:test", payload: "first" } });
    assert.deepEqual(received, ["first", "second"]);

    remove();
    callback?.({ index: 2, message: { channel: "desktop:test", payload: "ignored" } });
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
      invoke: (channel: string, payload: unknown) => Promise<unknown>;
    };

    return bridge.invoke("desktop:secret", null).then(
      () => assert.fail("expected invoke to reject"),
      (error: unknown) =>
        assert.equal(String(error), "Error: Error invoking remote method 'desktop:secret': denied"),
    );
  });
});
