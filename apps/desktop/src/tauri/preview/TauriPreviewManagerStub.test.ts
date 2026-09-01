// @effect-diagnostics nodeBuiltinImport:off
import { readFileSync } from "node:fs";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as Electron from "electron";

import * as PreviewManager from "../../preview/Manager.ts";
import * as TauriPreviewManagerStub from "./TauriPreviewManagerStub.ts";

describe("TauriPreviewManagerStub", () => {
  it("uses the upstream PreviewManager service key", () => {
    assert.equal(TauriPreviewManagerStub.PreviewManager.key, PreviewManager.PreviewManager.key);
  });

  it.effect("keeps a stable bootstrap session and accepts the main window", () =>
    Effect.gen(function* () {
      const manager = yield* PreviewManager.PreviewManager;
      const first = yield* manager.getBrowserSession();
      const second = yield* manager.getBrowserSession();

      assert.strictEqual(first, second);
      assert.isFalse(manager.isBrowserPartition("persist:t3code-preview-shared"));
      yield* manager.setMainWindow({} as Electron.BrowserWindow);
    }).pipe(Effect.provide(TauriPreviewManagerStub.layer)),
  );

  it.effect("fails preview operations with deterministic local errors", () =>
    Effect.gen(function* () {
      const manager = yield* PreviewManager.PreviewManager;
      const error = yield* Effect.flip(manager.createTab("tab-1"));
      if (error._tag === "PreviewOperationError") {
        assert.equal(error.operation, "createTab");
        assert.include(
          error.cause instanceof Error ? error.cause.message : String(error.cause),
          "Phase 0",
        );
      } else {
        return yield* Effect.die(`unexpected preview error: ${error._tag}`);
      }

      const partitionError = yield* Effect.flip(manager.getBrowserPartition());
      if (partitionError._tag === "PreviewOperationError") {
        assert.equal(partitionError.operation, "getBrowserPartition");
      } else {
        return yield* Effect.die(`unexpected preview error: ${partitionError._tag}`);
      }
    }).pipe(Effect.provide(TauriPreviewManagerStub.layer)),
  );

  it.effect("keeps subscriptions and zoom reapplication inert", () =>
    Effect.gen(function* () {
      const manager = yield* PreviewManager.PreviewManager;
      yield* manager.reapplyZoom();
      yield* Effect.scoped(manager.subscribeStateChanges(() => Effect.void));
      yield* Effect.scoped(manager.subscribePointerEvents(() => Effect.void));
      yield* Effect.scoped(manager.subscribeRecordingFrames(() => Effect.void));
    }).pipe(Effect.provide(TauriPreviewManagerStub.layer)),
  );

  it("does not import Electron or child-process APIs", () => {
    const source = readFileSync(new URL("./TauriPreviewManagerStub.ts", import.meta.url), "utf8");

    assert.notMatch(source, /from\s+["']electron["']/);
    assert.notMatch(source, /child[_-]?process|unstable\/process/i);
  });
});
