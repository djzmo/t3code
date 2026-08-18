// @effect-diagnostics nodeBuiltinImport:off
import { readFileSync } from "node:fs";

import { assert, describe, it } from "@effect/vitest";

import { resolveTauriSshCliRunner } from "./TauriSshCliRunner.ts";

describe("resolveTauriSshCliRunner", () => {
  it("uses the supplied package and engine range for packaged hosts", () => {
    assert.deepEqual(
      resolveTauriSshCliRunner({
        isDevelopment: false,
        packageSpec: "t3@0.0.34-nightly.20260817.1116",
        nodeEngineRange: ">=20.0.0",
      }),
      {
        packageSpec: "t3@0.0.34-nightly.20260817.1116",
        nodeEngineRange: ">=20.0.0",
      },
    );
  });

  it("preserves a development entry path and does not include a package fallback", () => {
    assert.deepEqual(
      resolveTauriSshCliRunner({
        isDevelopment: true,
        devRemoteEntryPath: "  D:/work/apps/server/dist/bin.mjs  ",
        packageSpec: "t3@0.0.34-nightly.20260817.1116",
        nodeEngineRange: " >=20.0.0 ",
      }),
      {
        nodeScriptPath: "D:/work/apps/server/dist/bin.mjs",
        nodeEngineRange: ">=20.0.0",
      },
    );
  });

  it("falls back to the supplied package when the development entry is empty", () => {
    assert.deepEqual(
      resolveTauriSshCliRunner({
        isDevelopment: true,
        devRemoteEntryPath: "  ",
        packageSpec: "t3@0.0.34-nightly.20260817.1116",
        nodeEngineRange: ">=20.0.0",
      }),
      {
        packageSpec: "t3@0.0.34-nightly.20260817.1116",
        nodeEngineRange: ">=20.0.0",
      },
    );
  });

  it("rejects empty package and engine values instead of falling back to latest", () => {
    assert.throws(() =>
      resolveTauriSshCliRunner({
        isDevelopment: false,
        packageSpec: " ",
        nodeEngineRange: ">=20.0.0",
      }),
    );
    assert.throws(() =>
      resolveTauriSshCliRunner({
        isDevelopment: false,
        packageSpec: "t3@0.0.34-nightly.20260817.1116",
        nodeEngineRange: "\t",
      }),
    );
  });

  it("does not import Electron or child-process APIs", () => {
    const source = readFileSync(new URL("./TauriSshCliRunner.ts", import.meta.url), "utf8");

    assert.notMatch(source, /from\s+["']electron["']/);
    assert.notMatch(source, /child[_-]?process|unstable\/process/i);
  });
});
