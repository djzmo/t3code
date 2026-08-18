import { assert, describe, it } from "@effect/vitest";

import { JsonRpcPeer, type JsonRpcPeerTransport } from "./JsonRpcPeer.ts";
import { makeShellClientPorts } from "./ShellClientPorts.ts";
import { ShellClient, type ShellClientByteTransport } from "./ShellClient.ts";
import type * as TauriApp from "../electron/TauriApp.ts";
import type * as TauriWindow from "../electron/TauriWindow.ts";

const helloResult: TauriApp.TauriShellHelloResult = {
  appName: "T3 Code",
  identifier: "com.t3.code",
  version: "0.0.1",
  tauriVersion: "2.11.5",
  platform: "win32",
  arch: "x64",
  isDev: true,
  execPath: "C:/T3.exe",
  resourceDir: "C:/resources",
  serverRoot: "C:/resources/server",
  appDataDir: "C:/state",
  logDir: "C:/logs",
  systemLocale: "en-US",
  deepLinkScheme: "t3",
  argv: [],
  launchUrls: [],
};

type ByteListener = (bytes: Uint8Array) => void | Promise<void>;

const setup = () => {
  const dataListeners = new Set<ByteListener>();
  const closeListeners = new Set<(cause?: unknown) => void>();
  let closed = false;
  let client!: ShellClientByteTransport;
  const shell = new JsonRpcPeer({
    write: async (frame) => {
      if (closed) return;
      for (const listener of dataListeners) await listener(frame);
    },
  } satisfies JsonRpcPeerTransport);
  client = {
    write: (bytes) => shell.receive(bytes),
    onData: (listener) => {
      dataListeners.add(listener);
      return () => dataListeners.delete(listener);
    },
    onClose: (listener) => {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
    close: () => {
      closed = true;
      dataListeners.clear();
      closeListeners.clear();
    },
  };
  shell.onRequest("shell.hello", () => helloResult);
  return { client, shell };
};

describe("makeShellClientPorts", () => {
  it("adapts app, dialog, shell, and window methods with exact directions", async () => {
    const pair = setup();
    const client = new ShellClient({ transport: pair.client, protocolVersion: "2.0", hostPid: 42 });
    const notifications: Array<{ method: string; params: unknown }> = [];
    pair.shell.onNotification("clipboard.writeText", (params) => {
      notifications.push({ method: "clipboard.writeText", params });
    });
    pair.shell.onRequest("dialog.error", (params) => {
      notifications.push({ method: "dialog.error", params });
      return {};
    });
    pair.shell.onRequest("app.isProtocolClient", () => ({ registered: true }));
    pair.shell.onRequest("app.getMetrics", () => []);
    pair.shell.onRequest("shell.openExternal", () => ({ ok: true }));
    pair.shell.onRequest("window.create", (params) => ({
      label: (params as { readonly label: string }).label,
    }));
    pair.shell.onRequest("window.getState", () => ({
      visible: true,
      focused: false,
      minimized: false,
      maximized: false,
      fullscreen: false,
      destroyed: false,
    }));

    const ports = makeShellClientPorts(client, { protocolVersion: "2.0", hostPid: 42 });
    assert.deepEqual(await ports.app.hello({ protocolVersion: "2.0", hostPid: 42 }), helloResult);
    assert.deepEqual(await ports.app.request("app.isProtocolClient", { scheme: "t3" }), {
      registered: true,
    });
    assert.deepEqual(await ports.app.request("app.getMetrics", {}), []);
    await ports.dialog.request("dialog.error", { title: "Title", content: "Content" });
    assert.deepEqual(
      await ports.shell.request("shell.openExternal", { url: "https://example.com" }),
      {
        ok: true,
      },
    );
    await ports.shell.notify("clipboard.writeText", { text: "copied" });
    assert.deepEqual(
      await ports.window.create({
        label: "main",
        title: "Main",
        width: 800,
        height: 600,
        minWidth: 400,
        minHeight: 300,
        show: true,
        backgroundColor: "#fff",
        decorations: true,
        titleBarStyle: "default",
        hiddenTitle: false,
        initScripts: [],
      }),
      { label: "main" },
    );
    assert.deepEqual(await ports.window.request("window.getState", { label: "main" }), {
      visible: true,
      focused: false,
      minimized: false,
      maximized: false,
      fullscreen: false,
      destroyed: false,
    });
    assert.deepEqual(notifications, [
      { method: "dialog.error", params: { title: "Title", content: "Content" } },
      { method: "clipboard.writeText", params: { text: "copied" } },
    ]);
    client.close();
  });

  it("subscribes and disposes notification listeners, including before-quit requests", async () => {
    const pair = setup();
    const client = new ShellClient({ transport: pair.client, protocolVersion: "2.0", hostPid: 42 });
    const ports = makeShellClientPorts(client, {
      protocolVersion: "2.0",
      hostPid: 42,
    });
    await client.ready;

    let focusCalls = 0;
    const removeFocus = ports.app.on("app.activate", () => {
      focusCalls += 1;
    });
    await pair.shell.notify("app.activate", { hasVisibleWindows: true });
    assert.equal(focusCalls, 1);
    removeFocus();
    await pair.shell.notify("app.activate", { hasVisibleWindows: true });
    assert.equal(focusCalls, 1);

    const beforeQuit = ports.app.on("app.before-quit", () => ({ prevented: true }));
    assert.deepEqual(await pair.shell.request("app.before-quit", { reason: "user" }), {
      prevented: true,
    });
    beforeQuit();
    const missingHandlerError = await pair.shell
      .request("app.before-quit", { reason: "user" })
      .then(
        () => undefined,
        (cause: unknown) => cause,
      );
    assert.instanceOf(missingHandlerError, Error);
    assert.match(String(missingHandlerError), /Unknown method app\.before-quit/);

    let windowEvents = 0;
    const removeWindow = ports.window.on?.(
      "window.event",
      (_event: TauriWindow.TauriWindowEventParams) => {
        windowEvents += 1;
      },
    );
    await pair.shell.notify("window.event", { label: "main", type: "created" });
    assert.equal(windowEvents, 1);
    removeWindow?.();
    await pair.shell.notify("window.event", { label: "main", type: "created" });
    assert.equal(windowEvents, 1);
    client.close();
  });

  it("rejects hello calls with a contract mismatch", async () => {
    const pair = setup();
    const client = new ShellClient({ transport: pair.client, protocolVersion: "2.0", hostPid: 42 });
    const ports = makeShellClientPorts(client, { protocolVersion: "2.0", hostPid: 42 });
    const mismatchError = await ports.app.hello({ protocolVersion: "2.0", hostPid: 99 }).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    assert.instanceOf(mismatchError, Error);
    assert.match(String(mismatchError), /hello contract mismatch/);
    client.close();
  });
});
