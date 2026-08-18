// @effect-diagnostics nodeBuiltinImport:off
import { readFileSync } from "node:fs";

import { assert, describe, it } from "@effect/vitest";

import {
  REMOTE_CLI_PIN,
  resolveRemoteCliPin,
  resolveTauriSshCliRunner,
} from "./TauriSshCliRunner.ts";

describe("resolveTauriSshCliRunner", () => {
  it("consumes the exact package pin from remote-cli.json for packaged hosts", () => {
    assert.deepEqual(
      resolveTauriSshCliRunner({
        isDevelopment: false,
        nodeEngineRange: ">=20.0.0",
      }),
      {
        packageSpec: REMOTE_CLI_PIN.packageSpec,
        nodeEngineRange: ">=20.0.0",
      },
    );
  });

  it("rejects a packaged override that differs from the canonical pin", () => {
    assert.throws(() =>
      resolveTauriSshCliRunner({
        isDevelopment: false,
        packageSpec: "t3@latest",
        nodeEngineRange: ">=20.0.0",
      }),
    );
  });

  it("preserves a development entry path without a package fallback", () => {
    assert.deepEqual(
      resolveTauriSshCliRunner({
        isDevelopment: true,
        devRemoteEntryPath: "  D:/work/apps/server/dist/bin.mjs  ",
        nodeEngineRange: " >=20.0.0 ",
      }),
      {
        nodeScriptPath: "D:/work/apps/server/dist/bin.mjs",
        nodeEngineRange: ">=20.0.0",
      },
    );
  });

  it("uses the canonical package when the development entry is empty", () => {
    assert.deepEqual(
      resolveTauriSshCliRunner({
        isDevelopment: true,
        devRemoteEntryPath: "  ",
        nodeEngineRange: ">=20.0.0",
      }),
      {
        packageSpec: REMOTE_CLI_PIN.packageSpec,
        nodeEngineRange: ">=20.0.0",
      },
    );
  });

  it("rejects an empty package override and engine range", () => {
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
        nodeEngineRange: "\t",
      }),
    );
  });

  it("derives the compatible server version from the exact upstream tag", () => {
    assert.deepEqual(resolveRemoteCliPin(REMOTE_CLI_PIN), {
      ...REMOTE_CLI_PIN,
      compatibleServerVersion: "0.0.34-nightly.20260817.1116",
    });
  });

  it("rejects a package pin that is not the stripped upstream tag", () => {
    assert.throws(() =>
      resolveRemoteCliPin({
        upstreamTag: "v1.2.3",
        packageSpec: "t3@1.2.4",
      }),
    );
  });

  it("does not import Electron or child-process APIs", () => {
    const source = readFileSync(new URL("./TauriSshCliRunner.ts", import.meta.url), "utf8");

    assert.notMatch(source, /from\s+["']electron["']/);
    assert.notMatch(source, /child[_-]?process|unstable\/process/i);
  });
});
