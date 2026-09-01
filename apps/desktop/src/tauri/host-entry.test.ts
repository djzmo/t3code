import { assert, describe, it } from "@effect/vitest";

import type * as TauriApp from "./electron/TauriApp.ts";
import type * as TauriWindow from "./electron/TauriWindow.ts";
import * as TauriIpcMain from "./ipc/TauriIpcMain.ts";
import {
  createHostTransportCloseHandler,
  HOST_HARD_EXIT_TIMEOUT_MS,
  identityFromHello,
  registerTopologyABenchmark,
  TOPOLOGY_A_BENCH_CHANNEL,
  TOPOLOGY_A_BENCH_MAX_BYTES,
} from "./host-entry.ts";

const hello = {
  appName: "Agent Nanoni",
  identifier: "app.nanoni.agent.desktop.dev.1234",
  version: "1.0.0",
  tauriVersion: "2.11.5",
  platform: "win32",
  arch: "x64",
  isDev: true,
  execPath: "C:/Agent Nanoni.exe",
  resourceDir: "C:/resources",
  serverRoot: "C:/resources/server",
  appDataDir: "C:/state",
  logDir: "C:/state/logs",
  systemLocale: "en-US",
  deepLinkScheme: "nanoni",
  argv: [],
  launchUrls: [],
} satisfies TauriApp.TauriShellHelloResult;

describe("Tauri host entry", () => {
  it("derives the isolated runtime identity from the native hello", () => {
    assert.deepEqual(identityFromHello(hello), {
      branding: {
        baseName: "Agent Nanoni",
        stageLabel: "Dev",
        displayName: "Agent Nanoni (Dev)",
      },
      displayName: "Agent Nanoni (Dev)",
      appUserModelId: "app.nanoni.agent.desktop.dev.1234",
      linuxDesktopEntryName: "app-nanoni-agent-desktop-dev-1234.desktop",
      linuxWmClass: "app-nanoni-agent-desktop-dev-1234",
      userDataDirName: "app.nanoni.agent.desktop.dev.1234",
      legacyUserDataDirName: "Agent Nanoni (Dev)",
    });
  });

  it("selects nightly and alpha branding from packaged versions", () => {
    assert.equal(
      identityFromHello({ ...hello, isDev: false, version: "1.2.3-nightly.20260818.4" }).branding
        .stageLabel,
      "Nightly",
    );
    assert.equal(
      identityFromHello({ ...hello, isDev: false, version: "1.2.3" }).branding.stageLabel,
      "Alpha",
    );
  });

  it("starts one normal shutdown and arms the five-second hard-exit barrier", () => {
    const events: string[] = [];
    let deadline: (() => void) | undefined;
    const onClose = createHostTransportCloseHandler({
      closeBroker: (cause) => events.push(`broker:${String(cause)}`),
      requestShutdown: () => events.push("shutdown"),
      hardExit: (code) => events.push(`exit:${code}`),
      scheduleHardExit: (callback, delayMs) => {
        assert.equal(delayMs, HOST_HARD_EXIT_TIMEOUT_MS);
        deadline = callback;
        events.push("deadline");
        return { unref: () => events.push("unref") };
      },
    });

    onClose("shell-eof");
    onClose("duplicate");
    assert.deepEqual(events, ["broker:shell-eof", "deadline", "unref", "shutdown"]);
    assert.isDefined(deadline);
    deadline();
    assert.deepEqual(events, ["broker:shell-eof", "deadline", "unref", "shutdown", "exit:1"]);
  });

  it("does not register the Topology A benchmark channel in a normal host", async () => {
    const ipcMain = TauriIpcMain.make();
    registerTopologyABenchmark({
      ipcMain,
      window: {} as never,
      environment: {},
    });

    try {
      await ipcMain.invoke(TOPOLOGY_A_BENCH_CHANNEL, { op: "echo", value: "normal" });
      throw new Error("expected the benchmark channel to be absent");
    } catch (error) {
      assert.match(String(error), /No invoke handler registered/);
    }
  });

  it("registers strict echo and ordered push operations only when explicitly enabled", async () => {
    const ipcMain = TauriIpcMain.make();
    const pushes: unknown[] = [];
    const registration = registerTopologyABenchmark({
      ipcMain,
      window: {
        notify: async (method: TauriWindow.TauriWindowNotificationMethod, params: unknown) => {
          pushes.push({ method, params });
        },
      } as unknown as TauriWindow.TauriWindowPort,
      environment: { AGENT_NANONI_TOPOLOGY_A_BENCH: "1" },
    });

    assert.deepEqual(
      await ipcMain.invoke(TOPOLOGY_A_BENCH_CHANNEL, { op: "echo", value: { answer: 42 } }),
      { value: { answer: 42 } },
    );
    for (const [seq, sentAt] of [10, 20, 30].entries()) {
      assert.deepEqual(
        await ipcMain.invoke(TOPOLOGY_A_BENCH_CHANNEL, { op: "push", seq, sentAt }),
        { seq },
      );
    }
    assert.deepEqual(
      pushes.map((entry) => entry),
      [
        {
          method: "ipc.push",
          params: {
            channel: "desktop:menu-action",
            payload: JSON.stringify({ seq: 0, sentAt: 10 }),
          },
        },
        {
          method: "ipc.push",
          params: {
            channel: "desktop:menu-action",
            payload: JSON.stringify({ seq: 1, sentAt: 20 }),
          },
        },
        {
          method: "ipc.push",
          params: {
            channel: "desktop:menu-action",
            payload: JSON.stringify({ seq: 2, sentAt: 30 }),
          },
        },
      ],
    );

    const invalid = async (payload: unknown, pattern: RegExp): Promise<void> => {
      try {
        await ipcMain.invoke(TOPOLOGY_A_BENCH_CHANNEL, payload);
        throw new Error("expected benchmark request to reject");
      } catch (error) {
        assert.match(String(error), pattern);
      }
    };
    await invalid({ op: "unknown" }, /Unknown Topology A benchmark operation/);
    await invalid({ op: "echo", value: "ok", extra: true }, /Invalid Topology A benchmark request/);
    await invalid({ op: "push", seq: -1, sentAt: 1 }, /Invalid Topology A benchmark request/);
    await invalid({ op: "push", seq: 100, sentAt: 1 }, /Invalid Topology A benchmark request/);
    await invalid({ op: "push", seq: 0, sentAt: Number.NaN }, /Invalid/);
    await invalid(
      { op: "echo", value: "x".repeat(TOPOLOGY_A_BENCH_MAX_BYTES) },
      /exceeds 1048576 bytes/,
    );

    registration.remove();
    await invalid({ op: "echo", value: "removed" }, /No invoke handler registered/);
  });
});
