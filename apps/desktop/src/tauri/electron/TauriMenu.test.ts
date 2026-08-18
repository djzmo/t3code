import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Electron from "electron";

import * as ElectronMenu from "../../electron/ElectronMenu.ts";
import * as TauriMenu from "./TauriMenu.ts";

describe("TauriMenu", () => {
  it.effect("provides the existing ElectronMenu tag", () =>
    Effect.gen(function* () {
      assert.equal(TauriMenu.ElectronMenu.key, ElectronMenu.ElectronMenu.key);

      const menu = yield* TauriMenu.ElectronMenu;
      yield* menu.setApplicationMenu([{ label: "File" }]);
      yield* menu.popupTemplate({
        window: {} as Electron.BrowserWindow,
        template: [{ label: "Copy" }],
      });

      const selectedItemId = yield* menu.showContextMenu({
        window: {} as Electron.BrowserWindow,
        items: [{ id: "copy", label: "Copy" }],
        position: Option.none(),
      });

      assert.isTrue(Option.isNone(selectedItemId));
    }).pipe(Effect.provide(TauriMenu.layer)),
  );
});
