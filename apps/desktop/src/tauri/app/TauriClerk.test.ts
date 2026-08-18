// @effect-diagnostics nodeBuiltinImport:off
import { readFileSync } from "node:fs";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as DesktopClerkService from "../../app/DesktopClerk.ts";
import * as TauriClerk from "./TauriClerk.ts";

describe("TauriClerk", () => {
  it("uses the upstream DesktopClerk service key", () => {
    assert.equal(TauriClerk.DesktopClerk.key, DesktopClerkService.DesktopClerk.key);
  });

  it.effect("exposes a deterministic configure effect", () =>
    Effect.gen(function* () {
      const clerk = yield* DesktopClerkService.DesktopClerk;
      assert.isTrue(Effect.isEffect(clerk.configure));
    }).pipe(Effect.provide(TauriClerk.layer)),
  );

  it("does not load Electron or Clerk runtime modules", () => {
    const source = readFileSync(new URL("./TauriClerk.ts", import.meta.url), "utf8");

    assert.notMatch(source, /from\s+["'](?:electron|@clerk\/electron)(?:\/[^"']*)?["']/);
    assert.notMatch(source, /child[_-]?process|unstable\/process/i);
  });
});
