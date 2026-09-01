import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";

import * as ElectronUpdater from "../../electron/ElectronUpdater.ts";
import * as TauriUpdater from "./TauriUpdater.ts";

describe("TauriUpdater", () => {
  it.effect("provides the existing ElectronUpdater tag and scoped no-op listeners", () =>
    Effect.gen(function* () {
      assert.equal(TauriUpdater.ElectronUpdater.key, ElectronUpdater.ElectronUpdater.key);

      const updater = yield* TauriUpdater.ElectronUpdater;
      const listener = vi.fn();
      yield* Effect.scoped(updater.on("update-available", listener));
      assert.isFalse(listener.mock.calls.length > 0);
    }).pipe(Effect.provide(TauriUpdater.layer)),
  );

  it.effect("keeps allowDowngrade state for interface parity", () =>
    Effect.gen(function* () {
      const updater = yield* TauriUpdater.ElectronUpdater;
      assert.isFalse(yield* updater.allowDowngrade);
      yield* updater.setAllowDowngrade(true);
      assert.isTrue(yield* updater.allowDowngrade);
      yield* updater.setAllowDowngrade(false);
      assert.isFalse(yield* updater.allowDowngrade);
    }).pipe(Effect.provide(TauriUpdater.layer)),
  );

  it.effect("fails disabled operations with typed, non-secret errors", () =>
    Effect.gen(function* () {
      const updater = yield* TauriUpdater.ElectronUpdater;

      const checkError = yield* updater.checkForUpdates.pipe(Effect.flip);
      assert.instanceOf(checkError, TauriUpdater.ElectronUpdaterCheckForUpdatesError);
      assert.isTrue(TauriUpdater.isElectronUpdaterError(checkError));
      assert.instanceOf(checkError.cause, Error);
      assert.equal((checkError.cause as Error).message, "disabled until F7");

      const downloadError = yield* updater.downloadUpdate.pipe(Effect.flip);
      assert.instanceOf(downloadError, TauriUpdater.ElectronUpdaterDownloadUpdateError);
      assert.instanceOf(downloadError.cause, Error);
      assert.equal((downloadError.cause as Error).message, "disabled until F7");

      const installError = yield* updater
        .quitAndInstall({ isSilent: true, isForceRunAfter: true })
        .pipe(Effect.flip);
      assert.instanceOf(installError, TauriUpdater.ElectronUpdaterQuitAndInstallError);
      assert.equal(installError.isSilent, true);
      assert.equal(installError.isForceRunAfter, true);
      assert.instanceOf(installError.cause, Error);
      assert.equal((installError.cause as Error).message, "disabled until F7");
    }).pipe(Effect.provide(TauriUpdater.layer)),
  );
});
