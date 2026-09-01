import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type * as DesktopLinuxUrlHandlerService from "../../app/DesktopLinuxUrlHandler.ts";

/** Keep the shared service tag while Tauri deep-link registration lives in
 * the native shell.  Phase 0 intentionally performs no Node-side effects. */
export const DesktopLinuxUrlHandler = Context.Service<
  DesktopLinuxUrlHandlerService.DesktopLinuxUrlHandler,
  DesktopLinuxUrlHandlerService.DesktopLinuxUrlHandler["Service"]
>()("@t3tools/desktop/app/DesktopLinuxUrlHandler");

const register = Effect.void;

export const make = DesktopLinuxUrlHandler.of({ register });

export const layer = Layer.succeed(DesktopLinuxUrlHandler, make);
