import { assert, describe, it } from "@effect/vitest";

import { JsonRpcPeer, encodeJsonRpcFrame } from "./JsonRpcPeer.ts";
import {
  ShellClient,
  createNodeStdioTransport,
  redirectOutputToStderr,
  type ShellClientByteTransport,
} from "./ShellClient.ts";

const helloResult = {
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
} as const;

type Listener = (bytes: Uint8Array) => void | Promise<void>;

const transportPair = (): {
  readonly client: ShellClientByteTransport;
  readonly shell: JsonRpcPeer;
  readonly writes: Uint8Array[];
  readonly close: () => void;
  readonly listenerCounts: () => { data: number; close: number };
} => {
  const clientData = new Set<Listener>();
  const clientClose = new Set<(cause?: unknown) => void>();
  const writes: Uint8Array[] = [];
  let closed = false;
  const client: ShellClientByteTransport = {
    write: (bytes) => {
      writes.push(bytes);
      return shell.receive(bytes);
    },
    onData: (listener) => {
      clientData.add(listener);
      return () => clientData.delete(listener);
    },
    onClose: (listener) => {
      clientClose.add(listener);
      return () => clientClose.delete(listener);
    },
    close: () => {
      closed = true;
      clientData.clear();
      clientClose.clear();
    },
  };
  const shell = new JsonRpcPeer({
    write: async (frame) => {
      if (closed) return;
      for (const listener of clientData) await listener(frame);
    },
  });
  return {
    client,
    shell,
    writes,
    close: () => {
      for (const listener of clientClose) listener(new Error("closed"));
    },
    listenerCounts: () => ({ data: clientData.size, close: clientClose.size }),
  };
};

const setup = () => {
  const pair = transportPair();
  pair.shell.onRequest("shell.hello", () => helloResult);
  return pair;
};

describe("ShellClient", () => {
  it("sends shell.hello first and validates its exact result", async () => {
    const pair = setup();
    const client = new ShellClient({ transport: pair.client, hostPid: 123 });

    assert.deepEqual(await client.ready, helloResult);
    assert.equal(pair.writes.length, 1);
    assert.match(new TextDecoder().decode(pair.writes[0]), /"method":"shell\.hello"/);
    client.close();
  });

  it("routes typed requests, notifications, and events after readiness", async () => {
    const pair = setup();
    const client = new ShellClient({ transport: pair.client });
    await client.ready;

    pair.shell.onRequest("window.getState", () => ({
      visible: true,
      focused: false,
      minimized: false,
      maximized: false,
      fullscreen: false,
      destroyed: false,
    }));
    assert.deepEqual(await client.request("window.getState", { label: "main" }), {
      visible: true,
      focused: false,
      minimized: false,
      maximized: false,
      fullscreen: false,
      destroyed: false,
    });

    const received: string[] = [];
    const remove = client.onEvent("window.event", (params) => {
      received.push(params.type);
    });
    await pair.shell.notify("window.event", { label: "main", type: "focus" });
    assert.deepEqual(received, ["focus"]);
    remove();
    client.close();
  });

  it("times out the hello handshake and closes the peer", async () => {
    const pair = transportPair();
    const client = new ShellClient({
      transport: pair.client,
      helloTimeoutMs: 5,
    });
    const pending = client.ready.then(
      () => undefined,
      (cause: unknown) => cause,
    );
    await new Promise<void>((resolve) => {
      AbortSignal.timeout(15).addEventListener("abort", () => resolve(), { once: true });
    });
    const error = await pending;
    assert.instanceOf(error, Error);
    assert.equal(client.pendingCount, 0);
  });

  it("rejects pending requests and removes transport listeners on closure", async () => {
    const pair = setup();
    const client = new ShellClient({ transport: pair.client });
    await client.ready;
    pair.shell.onRequest("window.getBounds", async () => new Promise(() => undefined));
    const pending = client.request("window.getBounds", { label: "main" });
    await Promise.resolve();
    pair.close();
    const error = await pending.then(
      () => undefined,
      (cause: unknown) => cause,
    );
    assert.instanceOf(error, Error);
    assert.equal(client.pendingCount, 0);
    assert.deepEqual(pair.listenerCounts(), { data: 0, close: 0 });
  });
});

describe("stdio output boundary", () => {
  it("redirects stdout and console writes to stderr and restores them", () => {
    const stdout: Array<unknown[]> = [];
    const stderr: Array<unknown[]> = [];
    const consoleTarget = {
      debug: (...args: unknown[]) => {
        stdout.push(args);
      },
      info: (...args: unknown[]) => {
        stdout.push(args);
      },
      log: (...args: unknown[]) => {
        stdout.push(args);
      },
      warn: (...args: unknown[]) => {
        stdout.push(args);
      },
    };
    const redirectedStdout = {
      write: (...args: unknown[]) => {
        stdout.push(args);
      },
    };
    const restore = redirectOutputToStderr({
      stdout: redirectedStdout,
      stderr: {
        write: (...args: unknown[]) => {
          stderr.push(args);
        },
      },
      console: consoleTarget,
    });
    const target = consoleTarget as { log: (...args: unknown[]) => void };
    redirectedStdout.write("raw");
    target.log("hello", 2);
    assert.deepEqual(stderr, [["raw"], ["hello 2\n"]]);
    restore();
    target.log("restored");
    assert.deepEqual(stdout.at(-1), ["restored"]);
  });
});

describe("createNodeStdioTransport", () => {
  it("forwards stdin bytes and writes frames without leaking to stdout", async () => {
    const stdin = new (await import("node:stream")).PassThrough();
    const stdout = new (await import("node:stream")).PassThrough();
    const stderr = new (await import("node:stream")).PassThrough();
    const transport = createNodeStdioTransport({ stdin, stdout, stderr });
    const received: Uint8Array[] = [];
    transport.onData((bytes) => {
      received.push(bytes);
    });
    const chunks: Buffer[] = [];
    stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stdin.write(Buffer.from([1, 2, 3]));
    await transport.write(Uint8Array.of(4, 5));
    assert.isDefined(received[0]);
    assert.deepEqual([...received[0]!], [1, 2, 3]);
    const written = Buffer.concat(chunks);
    assert.deepEqual([...written], [4, 5]);
    transport.close?.();
  });
});
