// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as DesktopWslServerTreeService from "../../wsl/DesktopWslServerTree.ts";
import * as TauriWslServerTree from "./TauriWslServerTree.ts";

describe("TauriWslServerTree", () => {
  it("uses the upstream DesktopWslServerTree service key", () => {
    assert.equal(
      TauriWslServerTree.DesktopWslServerTree.key,
      DesktopWslServerTreeService.DesktopWslServerTree.key,
    );
  });

  it.effect("returns the injected server root without extracting it", () => {
    const serverRoot = "C:/agent-nanoni/resources/server";
    // The production environment has many fields; this boundary fixture only
    // supplies the field this V1.1 stub is allowed to read.
    const environment = {
      serverRoot,
    } as unknown as (typeof TauriWslServerTree.DesktopEnvironment)["Service"];

    return Effect.gen(function* () {
      const tree = yield* TauriWslServerTree.DesktopWslServerTree;
      assert.deepStrictEqual(yield* tree.ensure, { ok: true, root: serverRoot });
      yield* tree.cleanupLegacy;
    }).pipe(
      Effect.provide(
        TauriWslServerTree.layer.pipe(
          Layer.provide(Layer.succeed(TauriWslServerTree.DesktopEnvironment, environment)),
        ),
      ),
    );
  });

  it("does not load Electron or child-process runtime modules", () => {
    const source = NodeFS.readFileSync(new URL("./TauriWslServerTree.ts", import.meta.url), "utf8");

    assert.notMatch(source, /from\s+["']electron["']/);
    assert.notMatch(source, /child[_-]?process|unstable\/process/i);
  });
});
