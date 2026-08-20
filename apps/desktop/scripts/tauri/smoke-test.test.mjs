import * as NodePath from "node:path";
import { describe, expect, it } from "vitest";

import {
  hasRequiredSmokeReadiness,
  packagedServerEntryFromBundle,
  readSmokeHomeDiagnostics,
} from "./smoke-test.mjs";

describe("Tauri packaged smoke readiness", () => {
  it("requires backend readiness and the first renderer round-trip", () => {
    expect(hasRequiredSmokeReadiness("AGENT_NANONI_SMOKE backend-ready")).toBe(false);
    expect(hasRequiredSmokeReadiness("AGENT_NANONI_SMOKE first-roundtrip")).toBe(false);
    expect(
      hasRequiredSmokeReadiness(
        "AGENT_NANONI_SMOKE backend-ready\nAGENT_NANONI_SMOKE first-roundtrip",
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
});
