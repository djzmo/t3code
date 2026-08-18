import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import type * as ElectronUpdaterService from "../../electron/ElectronUpdater.ts";

export type { ElectronUpdaterFeedUrl } from "../../electron/ElectronUpdater.ts";

export const ElectronUpdater = Context.Service<
  ElectronUpdaterService.ElectronUpdater,
  ElectronUpdaterService.ElectronUpdater["Service"]
>()("@t3tools/desktop/electron/ElectronUpdater");

// Keep the upstream error tags and fields while avoiding a runtime import of
// electron-updater. The Tauri updater will replace these with shell-backed
// errors in F7.
export class ElectronUpdaterCheckForUpdatesError extends Schema.TaggedErrorClass<ElectronUpdaterCheckForUpdatesError>()(
  "ElectronUpdaterCheckForUpdatesError",
  {
    channel: Schema.NullOr(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Electron updater failed to check for updates on channel ${this.channel ?? "default"}.`;
  }
}

export class ElectronUpdaterDownloadUpdateError extends Schema.TaggedErrorClass<ElectronUpdaterDownloadUpdateError>()(
  "ElectronUpdaterDownloadUpdateError",
  {
    channel: Schema.NullOr(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Electron updater failed to download the update on channel ${this.channel ?? "default"}.`;
  }
}

export class ElectronUpdaterQuitAndInstallError extends Schema.TaggedErrorClass<ElectronUpdaterQuitAndInstallError>()(
  "ElectronUpdaterQuitAndInstallError",
  {
    channel: Schema.NullOr(Schema.String),
    isSilent: Schema.Boolean,
    isForceRunAfter: Schema.Boolean,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Electron updater failed to quit and install the update on channel ${this.channel ?? "default"} (silent: ${this.isSilent}, force run after: ${this.isForceRunAfter}).`;
  }
}

export const ElectronUpdaterError = Schema.Union([
  ElectronUpdaterCheckForUpdatesError,
  ElectronUpdaterDownloadUpdateError,
  ElectronUpdaterQuitAndInstallError,
]);
export type ElectronUpdaterError = typeof ElectronUpdaterError.Type;
export const isElectronUpdaterError = Schema.is(ElectronUpdaterError);

const disabledCause = (): Error => new Error("disabled until F7");

// Electron's allowDowngrade flag is read back by DesktopUpdates when changing
// channels. Keep that one bit of state locally while native updates are absent.
let allowDowngrade = false;

export const make = ElectronUpdater.of({
  setFeedURL: (_options) => Effect.void,
  setAutoDownload: (_value) => Effect.void,
  setAutoInstallOnAppQuit: (_value) => Effect.void,
  setChannel: (_channel) => Effect.void,
  setAllowPrerelease: (_value) => Effect.void,
  allowDowngrade: Effect.sync(() => allowDowngrade),
  setAllowDowngrade: (value) =>
    Effect.sync(() => {
      allowDowngrade = value;
    }),
  setFullChangelog: (_value) => Effect.void,
  setDisableDifferentialDownload: (_value) => Effect.void,
  checkForUpdates: Effect.suspend(() =>
    Effect.fail(
      new ElectronUpdaterCheckForUpdatesError({
        channel: null,
        cause: disabledCause(),
      }),
    ),
  ),
  downloadUpdate: Effect.suspend(() =>
    Effect.fail(
      new ElectronUpdaterDownloadUpdateError({
        channel: null,
        cause: disabledCause(),
      }),
    ),
  ),
  quitAndInstall: ({ isSilent, isForceRunAfter }) =>
    Effect.suspend(() =>
      Effect.fail(
        new ElectronUpdaterQuitAndInstallError({
          channel: null,
          isSilent,
          isForceRunAfter,
          cause: disabledCause(),
        }),
      ),
    ),
  on: (_eventName, _listener) =>
    Effect.acquireRelease(Effect.void, () => Effect.void).pipe(Effect.asVoid),
});

export const layer = Layer.succeed(ElectronUpdater, make);
