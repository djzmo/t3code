// @effect-diagnostics nodeBuiltinImport:off
import { readFileSync } from "node:fs";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as DesktopPreReadyPlatform from "../../app/DesktopPreReadyPlatform.ts";
import * as TauriPreReadyPlatform from "./TauriPreReadyPlatform.ts";

describe("TauriPreReadyPlatform", () => {
  it("uses the upstream pre-ready service key", () => {
    assert.equal(
      TauriPreReadyPlatform.DesktopPreReadyElectronOptions.key,
      DesktopPreReadyPlatform.DesktopPreReadyElectronOptions.key,
    );
  });

  it.effect("provides deterministic inert Linux options", () =>
    Effect.gen(function* () {
      const options = yield* DesktopPreReadyPlatform.DesktopPreReadyElectronOptions;

      assert.deepEqual(options, {
        linux: null,
        linuxPasswordStoreCommandLine: null,
      });
    }).pipe(Effect.provide(TauriPreReadyPlatform.layer)),
  );

  it("does not import Electron or child-process APIs", () => {
    const source = readFileSync(new URL("./TauriPreReadyPlatform.ts", import.meta.url), "utf8");

    assert.notMatch(source, /from\s+["']electron["']/);
    assert.notMatch(source, /child[_-]?process|unstable\/process/i);
  });
});
