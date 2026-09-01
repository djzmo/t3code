import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type * as ElectronThemeService from "../../electron/ElectronTheme.ts";

/**
 * Keep the upstream service key and shape without loading Electron in the
 * Node host bundle.  Native theme integration belongs to the shell phase.
 */
export const ElectronTheme = Context.Service<
  ElectronThemeService.ElectronTheme,
  ElectronThemeService.ElectronTheme["Service"]
>()("@t3tools/desktop/electron/ElectronTheme");

export const make = ElectronTheme.of({
  shouldUseDarkColors: Effect.succeed(false),
  setSource: () => Effect.void,
  onUpdated: (_listener) => Effect.acquireRelease(Effect.void, () => Effect.void),
});

export const layer = Layer.succeed(ElectronTheme, make);
