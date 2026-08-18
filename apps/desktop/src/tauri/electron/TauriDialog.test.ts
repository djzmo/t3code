// @effect-diagnostics nodeBuiltinImport:off
import { readFileSync } from "node:fs";

import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Electron from "electron";

import * as ElectronDialog from "../../electron/ElectronDialog.ts";
import * as TauriDialog from "./TauriDialog.ts";

describe("TauriDialog", () => {
  it("uses the upstream ElectronDialog service key", () => {
    assert.equal(TauriDialog.ElectronDialog.key, ElectronDialog.ElectronDialog.key);
  });

  it.effect("forwards showErrorBox to dialog.error without changing the payload", () => {
    const calls: Array<{
      readonly method: "dialog.error";
      readonly params: TauriDialog.TauriDialogErrorParams;
    }> = [];
    const port: TauriDialog.TauriDialogPort = {
      request: (method, params) => {
        calls.push({ method, params });
      },
    };

    return Effect.gen(function* () {
      const dialog = yield* ElectronDialog.ElectronDialog;
      yield* dialog.showErrorBox("Startup failed", "Could not start.");

      assert.deepEqual(calls, [
        {
          method: "dialog.error",
          params: { title: "Startup failed", content: "Could not start." },
        },
      ]);
    }).pipe(Effect.provide(TauriDialog.layer(port)));
  });

  it.effect("wraps dialog transport failures in a typed, non-secret error", () => {
    const cause = new Error("transport secret should stay out of the message");
    const port: TauriDialog.TauriDialogPort = {
      request: () => {
        throw cause;
      },
    };

    return Effect.gen(function* () {
      const dialog = yield* ElectronDialog.ElectronDialog;
      const exit = yield* Effect.exit(dialog.showErrorBox("private title", "private content"));

      assert.isTrue(exit._tag === "Failure");
      if (exit._tag === "Success") return;
      const error = Cause.squash(exit.cause);
      assert.instanceOf(error, TauriDialog.ElectronDialogShowErrorBoxError);
      assert.equal(error.titleLength, "private title".length);
      assert.equal(error.contentLength, "private content".length);
      assert.notInclude(error.message, "private title");
      assert.notInclude(error.message, "private content");
      assert.notInclude(error.message, cause.message);
      assert.strictEqual(error.cause, cause);
    }).pipe(Effect.provide(TauriDialog.layer(port)));
  });

  it.effect("returns deterministic typed failures for unsupported pickers and message boxes", () =>
    Effect.gen(function* () {
      const dialog = yield* ElectronDialog.ElectronDialog;
      const folderError = yield* Effect.flip(
        dialog.pickFolder({
          owner: Option.none(),
          defaultPath: Option.some("/private/secret"),
        }),
      );
      assert.instanceOf(folderError, TauriDialog.ElectronDialogPickFolderError);
      assert.isTrue(TauriDialog.isElectronDialogError(folderError));
      assert.isNull(folderError.ownerWindowId);
      assert.equal(folderError.defaultPath, "/private/secret");

      const filesError = yield* Effect.flip(
        dialog.pickFiles({
          owner: Option.none(),
          defaultPath: Option.some("/private/secret"),
          filters: [],
        }),
      );
      assert.instanceOf(filesError, TauriDialog.ElectronDialogPickFilesError);
      assert.isTrue(TauriDialog.isElectronDialogError(filesError));
      assert.isNull(filesError.ownerWindowId);
      assert.equal(filesError.defaultPath, "/private/secret");

      const messageError = yield* Effect.flip(
        dialog.showMessageBox({
          type: "warning",
          title: "private title",
          message: "private message",
          detail: "private detail",
          buttons: ["Discard"],
        } satisfies Electron.MessageBoxOptions),
      );
      assert.instanceOf(messageError, TauriDialog.ElectronDialogShowMessageBoxError);
      assert.isTrue(TauriDialog.isElectronDialogError(messageError));
      assert.equal(messageError.titleLength, "private title".length);
      assert.equal(messageError.messageLength, "private message".length);
      assert.equal(messageError.detailLength, "private detail".length);
      assert.equal(messageError.buttonCount, 1);
      assert.notInclude(messageError.message, "private");
    }).pipe(
      Effect.provide(
        TauriDialog.layer({
          request: async () => {},
        }),
      ),
    ),
  );

  it("does not import Electron or the upstream runtime implementation", () => {
    const source = readFileSync(new URL("./TauriDialog.ts", import.meta.url), "utf8");

    assert.notMatch(source, /^import\s+\*\s+as\s+Electron\s+from\s+["']electron["']/m);
    assert.notMatch(
      source,
      /^import\s+\*\s+as\s+ElectronDialogService\s+from\s+["']\.\.\/\.\.\/electron\/ElectronDialog\.ts["']/m,
    );
  });
});
