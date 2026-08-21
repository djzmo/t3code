import { EventEmitter } from "node:events";
import * as NodePath from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import {
  defaultSmokeTimeoutMs,
  hasRequiredSmokeReadiness,
  packagedServerEntryFromBundle,
  readSmokeHomeDiagnostics,
  runSmoke,
} from "./smoke-test.mjs";

const READY_PATTERN = /backend[ ._-]+ready/i;
const READINESS = "AGENT_NANONI_SMOKE backend-ready\nAGENT_NANONI_SMOKE first-roundtrip\n";

const smokeOptions = () => ({
  binary: process.execPath,
  cwd: process.cwd(),
  timeoutMs: 5_000,
  killHost: false,
  readyPattern: READY_PATTERN,
  childArguments: [],
});

const missingFile = async () => {
  throw Object.assign(new Error("missing"), { code: "ENOENT" });
};

const makeFakeChild = () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
};

describe("Tauri packaged smoke readiness", () => {
  it("gives Linux AppImage extract enough time to reach backend readiness", () => {
    expect(defaultSmokeTimeoutMs("linux")).toBe(90_000);
    expect(defaultSmokeTimeoutMs("win32")).toBe(30_000);
    expect(defaultSmokeTimeoutMs("darwin")).toBe(30_000);
  });

  it("requires backend readiness and the first renderer round-trip", () => {
    expect(hasRequiredSmokeReadiness("AGENT_NANONI_SMOKE backend-ready")).toBe(false);
    expect(hasRequiredSmokeReadiness("AGENT_NANONI_SMOKE first-roundtrip")).toBe(false);
    expect(
      hasRequiredSmokeReadiness(
        "AGENT_NANONI_SMOKE backend-ready\nAGENT_NANONI_SMOKE first-roundtrip",
      ),
    ).toBe(true);
    expect(
      hasRequiredSmokeReadiness(
        [
          "AGENT_NANONI_SMOKE backend-ready",
          "AGENT_NANONI_SMOKE navigation tauri://localhost",
          "AGENT_NANONI_SMOKE first-roundtrip",
          "AGENT_NANONI_SMOKE clean-exit-requested",
        ].join("\n"),
      ),
    ).toBe(true);
  });

  it("resolves the staged server entry inside a macOS .app", () => {
    const binary = "/tmp/bundle/macos/Agent Nanoni.app/Contents/MacOS/agent-nanoni-desktop";
    expect(packagedServerEntryFromBundle(binary, "darwin")).toBe(
      NodePath.join(
        "/tmp/bundle/macos/Agent Nanoni.app/Contents/MacOS",
        "..",
        "Resources",
        "server",
        "apps",
        "server",
        "dist",
        "bin.mjs",
      ),
    );
    expect(
      packagedServerEntryFromBundle("/tmp/bundle/appimage/Agent Nanoni.AppImage", "linux"),
    ).toBeUndefined();
  });

  it("dumps smoke-home backend logs when they exist", async () => {
    const smokeHome = "/tmp/smoke";
    const files = new Map([
      [
        NodePath.join(smokeHome, "userdata/logs/server-child.log"),
        "Cannot find module '/app/Resources/server/apps/server/dist/bin.mjs'",
      ],
    ]);
    const diagnostics = await readSmokeHomeDiagnostics(smokeHome, {
      readFile: async (path) => {
        const text = files.get(path);
        if (text === undefined) {
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        }
        return text;
      },
    });
    expect(diagnostics).toContain("Cannot find module");
    expect(diagnostics).toContain("desktop-main.log");
    expect(diagnostics).toContain("<missing>");
  });

  it("passes when the child prints readiness and exits in the same tick", async () => {
    await runSmoke({
      ...smokeOptions(),
      childArguments: [
        "-e",
        `process.stderr.write(${JSON.stringify(READINESS)}); process.exit(0);`,
      ],
    });
  });

  it("accepts readiness chunks that arrive after exit and before close", async () => {
    const child = makeFakeChild();
    const spawn = () => {
      queueMicrotask(() => {
        child.emit("exit", 0, null);
        setImmediate(() => {
          child.stderr.write(READINESS);
          child.emit("close", 0, null);
        });
      });
      return child;
    };
    await runSmoke(smokeOptions(), { spawn });
  });

  it("does not throw unreadiness if markers arrive while reading smoke-home logs", async () => {
    const child = makeFakeChild();
    const spawn = () => {
      queueMicrotask(() => {
        child.emit("exit", 0, null);
        child.emit("close", 0, null);
      });
      return child;
    };
    let readFileCalls = 0;
    await runSmoke(smokeOptions(), {
      spawn,
      fileSystem: {
        mkdtemp: async (prefix) => `${prefix}home`,
        access: async () => {},
        rm: async () => {},
        readFile: async () => {
          readFileCalls += 1;
          if (readFileCalls === 1) {
            child.stderr.write(READINESS);
          }
          return missingFile();
        },
      },
    });
  });
});
