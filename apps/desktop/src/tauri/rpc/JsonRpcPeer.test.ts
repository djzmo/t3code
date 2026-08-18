import { assert, describe, it } from "@effect/vitest";

import { JsonRpcPeer, JsonRpcPeerError, encodeJsonRpcFrame } from "./JsonRpcPeer.ts";

const helloResult = {
  appName: "Agent Nanoni",
  identifier: "app.nanoni.agent.desktop",
  version: "1.0.0",
  tauriVersion: "2.11.5",
  platform: "win32",
  arch: "x64",
  isDev: true,
  execPath: "C:/AgentNanoni.exe",
  resourceDir: "C:/resources",
  serverRoot: "C:/resources/server",
  appDataDir: "C:/state",
  logDir: "C:/logs",
  systemLocale: "en-US",
  deepLinkScheme: "agent-nanoni",
  argv: [],
  launchUrls: [],
};

const pair = () => {
  let left!: JsonRpcPeer;
  let right!: JsonRpcPeer;
  left = new JsonRpcPeer({ write: (frame) => right.receive(frame) });
  right = new JsonRpcPeer({ write: (frame) => left.receive(frame) });
  return { left, right };
};

describe("JsonRpcPeer", () => {
  it("round-trips typed requests and results", async () => {
    const { left, right } = pair();
    right.onRequest("shell.hello", () => helloResult);

    assert.deepEqual(
      await left.request("shell.hello", { protocolVersion: "2.0", hostPid: 42 }),
      helloResult,
    );
    assert.equal(left.pendingCount, 0);
  });

  it("dispatches ordered notifications", async () => {
    const { left, right } = pair();
    const received: number[] = [];
    right.onNotification("app.exit", (params) => {
      received.push((params as { code: number }).code);
    });

    await left.notify("app.exit", { code: 1 });
    await left.notify("app.exit", { code: 2 });
    assert.deepEqual(received, [1, 2]);
  });

  it("reassembles frames split inside UTF-8 code points", async () => {
    const frames: Uint8Array[] = [];
    const peer = new JsonRpcPeer({
      write: (frame) => {
        frames.push(frame);
      },
    });
    const received: string[] = [];
    peer.onNotification("clipboard.writeText", (params) => {
      received.push((params as { text: string }).text);
    });
    const frame = encodeJsonRpcFrame({
      jsonrpc: "2.0",
      method: "clipboard.writeText",
      params: { text: "emoji 🧭 and 漢字" },
    });

    for (const byte of frame) await peer.receive(Uint8Array.of(byte));
    assert.deepEqual(received, ["emoji 🧭 and 漢字"]);
    assert.deepEqual(frames, []);
  });

  it("sends cancellation and rejects the pending request", async () => {
    const written: Uint8Array[] = [];
    const peer = new JsonRpcPeer({
      write: (frame) => {
        written.push(frame);
      },
    });
    const controller = new AbortController();
    const pending = peer.request("window.getState", { label: "main" }, controller.signal);
    await Promise.resolve();
    controller.abort();

    const error = await pending.then(
      () => undefined,
      (cause: unknown) => cause,
    );
    assert.instanceOf(error, JsonRpcPeerError);
    assert.equal(peer.pendingCount, 0);
    assert.equal(written.length, 2);
  });

  it("rejects all pending requests when the transport closes", async () => {
    const peer = new JsonRpcPeer({ write: () => undefined });
    const pending = peer.request("window.getBounds", { label: "main" });
    await Promise.resolve();
    peer.close();

    const error = await pending.then(
      () => undefined,
      (cause: unknown) => cause,
    );
    assert.instanceOf(error, JsonRpcPeerError);
    assert.equal(peer.pendingCount, 0);
  });
});
