import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type * as ElectronMenuService from "../../electron/ElectronMenu.ts";

// Keep the upstream service key and shape so the shared desktop host can be
// reused unchanged, without loading Electron into the Tauri host bundle.
export const ElectronMenu = Context.Service<
  ElectronMenuService.ElectronMenu,
  ElectronMenuService.ElectronMenu["Service"]
>()("@t3tools/desktop/electron/ElectronMenu");

export const make = ElectronMenu.of({
  setApplicationMenu: (_template) => Effect.void,
  popupTemplate: (_input) => Effect.void,
  showContextMenu: (_input) => Effect.succeed(Option.none<string>()),
});

export const layer = Layer.succeed(ElectronMenu, make);
