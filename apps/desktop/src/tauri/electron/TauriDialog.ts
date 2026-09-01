import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type * as Electron from "electron";
import type * as ElectronDialogService from "../../electron/ElectronDialog.ts";

/** The one dialog request implemented by the Phase 0 shell adapter. */
export interface TauriDialogErrorParams {
  readonly title: string;
  readonly content: string;
}

export interface TauriDialogPort {
  readonly request: (
    method: "dialog.error",
    params: TauriDialogErrorParams,
  ) => Promise<void> | void;
}

export class ElectronDialogPickFolderError extends Schema.TaggedErrorClass<ElectronDialogPickFolderError>()(
  "ElectronDialogPickFolderError",
  {
    ownerWindowId: Schema.NullOr(Schema.Number),
    defaultPath: Schema.NullOr(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Tauri folder picker is unavailable in the Phase 0 host.";
  }
}

export class ElectronDialogPickFilesError extends Schema.TaggedErrorClass<ElectronDialogPickFilesError>()(
  "ElectronDialogPickFilesError",
  {
    ownerWindowId: Schema.NullOr(Schema.Number),
    defaultPath: Schema.NullOr(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Tauri file picker is unavailable in the Phase 0 host.";
  }
}

export class ElectronDialogShowMessageBoxError extends Schema.TaggedErrorClass<ElectronDialogShowMessageBoxError>()(
  "ElectronDialogShowMessageBoxError",
  {
    type: Schema.NullOr(Schema.Literals(["none", "info", "error", "question", "warning"])),
    titleLength: Schema.NullOr(Schema.Number),
    messageLength: Schema.Number,
    detailLength: Schema.NullOr(Schema.Number),
    buttonCount: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Tauri message boxes are unavailable in the Phase 0 host.";
  }
}

export class ElectronDialogShowErrorBoxError extends Schema.TaggedErrorClass<ElectronDialogShowErrorBoxError>()(
  "ElectronDialogShowErrorBoxError",
  {
    titleLength: Schema.Number,
    contentLength: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Tauri error dialog failed.";
  }
}

export const ElectronDialogError = Schema.Union([
  ElectronDialogPickFolderError,
  ElectronDialogPickFilesError,
  ElectronDialogShowMessageBoxError,
  ElectronDialogShowErrorBoxError,
]);
export type ElectronDialogError = typeof ElectronDialogError.Type;
export const isElectronDialogError = Schema.is(ElectronDialogError);

/** Keep the upstream service key and exact service shape without loading Electron. */
export const ElectronDialog = Context.Service<
  ElectronDialogService.ElectronDialog,
  ElectronDialogService.ElectronDialog["Service"]
>()("@t3tools/desktop/electron/ElectronDialog");

const unavailableCause = (operation: string): Error =>
  new Error(`Tauri dialog operation is unavailable in the Phase 0 host: ${operation}.`);

const makeUnsupportedFolder = (
  input: ElectronDialogService.ElectronDialogPickFolderInput,
): ElectronDialogPickFolderError =>
  new ElectronDialogPickFolderError({
    ownerWindowId: Option.match(input.owner, {
      onNone: () => null,
      onSome: (owner) => owner.id,
    }),
    defaultPath: Option.getOrNull(input.defaultPath),
    cause: unavailableCause("pickFolder"),
  });

const makeUnsupportedFiles = (
  input: ElectronDialogService.ElectronDialogPickFilesInput,
): ElectronDialogPickFilesError =>
  new ElectronDialogPickFilesError({
    ownerWindowId: Option.match(input.owner, {
      onNone: () => null,
      onSome: (owner) => owner.id,
    }),
    defaultPath: Option.getOrNull(input.defaultPath),
    cause: unavailableCause("pickFiles"),
  });

const makeUnsupportedMessage = (
  options: Electron.MessageBoxOptions,
): ElectronDialogShowMessageBoxError =>
  new ElectronDialogShowMessageBoxError({
    type: options.type ?? null,
    titleLength: options.title?.length ?? null,
    messageLength: options.message.length,
    detailLength: options.detail?.length ?? null,
    buttonCount: options.buttons?.length ?? 0,
    cause: unavailableCause("showMessageBox"),
  });

export const make = (port: TauriDialogPort): ElectronDialogService.ElectronDialog["Service"] =>
  ElectronDialog.of({
    pickFolder: (input) => Effect.fail(makeUnsupportedFolder(input)),
    pickFiles: (input) => Effect.fail(makeUnsupportedFiles(input)),
    showMessageBox: (options) => Effect.fail(makeUnsupportedMessage(options)),
    showErrorBox: (title, content) =>
      Effect.tryPromise({
        try: async () => {
          await port.request("dialog.error", { title, content });
        },
        catch: (cause) =>
          new ElectronDialogShowErrorBoxError({
            titleLength: title.length,
            contentLength: content.length,
            cause,
          }),
      }).pipe(Effect.orDie, Effect.asVoid),
  });

export const layer = (port: TauriDialogPort) => Layer.succeed(ElectronDialog, make(port));
