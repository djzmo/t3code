import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ElectronSafeStorage from "../../electron/ElectronSafeStorage.ts";
import * as TauriSafeStorage from "./TauriSafeStorage.ts";

describe("TauriSafeStorage", () => {
  it.effect("provides the existing ElectronSafeStorage tag with unavailable stubs", () =>
    Effect.gen(function* () {
      assert.equal(
        TauriSafeStorage.ElectronSafeStorage.key,
        ElectronSafeStorage.ElectronSafeStorage.key,
      );

      const storage = yield* ElectronSafeStorage.ElectronSafeStorage;
      assert.isFalse(yield* storage.isEncryptionAvailable);
      assert.deepStrictEqual(yield* storage.selectedStorageBackend, Option.none());

      const secret = "do-not-leak-this-value";
      const encryptError = yield* Effect.flip(storage.encryptString(secret));
      assert.instanceOf(encryptError, TauriSafeStorage.ElectronSafeStorageEncryptError);
      assert.isTrue(TauriSafeStorage.isElectronSafeStorageError(encryptError));
      assert.instanceOf(encryptError.cause, Error);
      assert.notInclude((encryptError.cause as Error).message, secret);

      const decryptError = yield* Effect.flip(storage.decryptString(new Uint8Array([1, 2, 3])));
      assert.instanceOf(decryptError, TauriSafeStorage.ElectronSafeStorageDecryptError);
      assert.isTrue(TauriSafeStorage.isElectronSafeStorageError(decryptError));
      assert.instanceOf(decryptError.cause, Error);
      assert.notInclude((decryptError.cause as Error).message, secret);
    }).pipe(Effect.provide(TauriSafeStorage.layer)),
  );
});
