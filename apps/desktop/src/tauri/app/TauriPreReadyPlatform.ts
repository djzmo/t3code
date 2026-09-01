import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

import type * as DesktopPreReadyPlatformService from "../../app/DesktopPreReadyPlatform.ts";

/**
 * The Tauri shell has no Chromium command-line setup to perform before the
 * host is ready.  Keep the upstream service tag so the shared desktop
 * startup code can observe a deterministic, inert value.
 */
export const DesktopPreReadyElectronOptions = Context.Service<
  DesktopPreReadyPlatformService.DesktopPreReadyElectronOptions,
  DesktopPreReadyPlatformService.DesktopPreReadyElectronOptions["Service"]
>()("@t3tools/desktop/app/DesktopPreReadyPlatform/DesktopPreReadyElectronOptions");

const options: DesktopPreReadyPlatformService.DesktopPreReadyElectronOptions["Service"] = {
  linux: null,
  linuxPasswordStoreCommandLine: null,
};

export const layer = Layer.succeed(DesktopPreReadyElectronOptions, options);

/** A no-op pre-ready effect for callers that need an explicit setup step. */
export const make = DesktopPreReadyElectronOptions.of(options);
