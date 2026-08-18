import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type * as ElectronSafeStorageService from "../../electron/ElectronSafeStorage.ts";

/**
 * Keep the upstream service key and shape without loading Electron in the
 * Node host bundle. Native safe-storage integration belongs to F4.
 */
export const ElectronSafeStorage = Context.Service<
  ElectronSafeStorageService.ElectronSafeStorage,
  ElectronSafeStorageService.ElectronSafeStorage["Service"]
>()("@t3tools/desktop/electron/ElectronSafeStorage");

const safeStorageErrorFields = {
  cause: Schema.Defect(),
};

export class ElectronSafeStorageAvailabilityError extends Schema.TaggedErrorClass<ElectronSafeStorageAvailabilityError>()(
  "ElectronSafeStorageAvailabilityError",
  safeStorageErrorFields,
) {
  override get message(): string {
    return "Electron safe storage failed to check encryption availability.";
  }
}

export class ElectronSafeStorageEncryptError extends Schema.TaggedErrorClass<ElectronSafeStorageEncryptError>()(
  "ElectronSafeStorageEncryptError",
  safeStorageErrorFields,
) {
  override get message(): string {
    return "Electron safe storage failed to encrypt a string.";
  }
}

export class ElectronSafeStorageDecryptError extends Schema.TaggedErrorClass<ElectronSafeStorageDecryptError>()(
  "ElectronSafeStorageDecryptError",
  safeStorageErrorFields,
) {
  override get message(): string {
    return "Electron safe storage failed to decrypt a string.";
  }
}

export const ElectronSafeStorageError = Schema.Union([
  ElectronSafeStorageAvailabilityError,
  ElectronSafeStorageEncryptError,
  ElectronSafeStorageDecryptError,
]);
export type ElectronSafeStorageError = typeof ElectronSafeStorageError.Type;
export const isElectronSafeStorageError = Schema.is(ElectronSafeStorageError);

const unavailableCause = (): Error => new Error("Tauri safe storage is unavailable.");

export const make = ElectronSafeStorage.of({
  isEncryptionAvailable: Effect.succeed(false),
  encryptString: () =>
    Effect.fail(new ElectronSafeStorageEncryptError({ cause: unavailableCause() })),
  decryptString: () =>
    Effect.fail(new ElectronSafeStorageDecryptError({ cause: unavailableCause() })),
  selectedStorageBackend: Effect.succeed(Option.none()),
});

export const layer = Layer.succeed(ElectronSafeStorage, make);
