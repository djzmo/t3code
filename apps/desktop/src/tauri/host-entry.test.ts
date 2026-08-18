import { assert, describe, it } from "@effect/vitest";

import type * as TauriApp from "./electron/TauriApp.ts";
import {
  createHostTransportCloseHandler,
  HOST_HARD_EXIT_TIMEOUT_MS,
  identityFromHello,
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
});
