import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type * as ElectronProtocolService from "../../electron/ElectronProtocol.ts";

/**
 * The Tauri host serves the renderer from `frontendDist`, so there is no
 * renderer-origin protocol handler to install in the V1.1 host.  Keep the
 * service shape and tag key used by the shared desktop code until the Rust
 * shell owns the corresponding security boundary in V1.2/V1.3.
 */
export const ElectronProtocol = Context.Service<
  ElectronProtocolService.ElectronProtocol,
  ElectronProtocolService.ElectronProtocol["Service"]
>()("@t3tools/desktop/electron/ElectronProtocol");

const registerDesktopProtocol: ElectronProtocolService.ElectronProtocol["Service"]["registerDesktopProtocol"] =
  (_input) => Effect.acquireRelease(Effect.void, () => Effect.void).pipe(Effect.asVoid);

export const make = ElectronProtocol.of({ registerDesktopProtocol });

export const layer = Layer.succeed(ElectronProtocol, make);
