// @effect-diagnostics nodeBuiltinImport:off
import { readFileSync } from "node:fs";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as DesktopLinuxUrlHandler from "../../app/DesktopLinuxUrlHandler.ts";
import * as TauriLinuxUrlHandler from "./TauriLinuxUrlHandler.ts";

describe("TauriLinuxUrlHandler", () => {
  it("uses the upstream URL-handler service key", () => {
    assert.equal(
      TauriLinuxUrlHandler.DesktopLinuxUrlHandler.key,
      DesktopLinuxUrlHandler.DesktopLinuxUrlHandler.key,
    );
  });

  it.effect("provides a no-op registration effect", () =>
    Effect.gen(function* () {
      const handler = yield* DesktopLinuxUrlHandler.DesktopLinuxUrlHandler;
      assert.isDefined(handler.register);
      yield* handler.register;
    }).pipe(Effect.provide(TauriLinuxUrlHandler.layer)),
  );

  it("does not import Electron or child-process APIs", () => {
    const source = readFileSync(new URL("./TauriLinuxUrlHandler.ts", import.meta.url), "utf8");

    assert.notMatch(source, /from\s+["']electron["']/);
    assert.notMatch(source, /child[_-]?process|unstable\/process/i);
  });
});
