import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type * as DesktopClerkService from "../../app/DesktopClerk.ts";

/**
 * Clerk integration is intentionally deferred until the F11 decision.  The
 * host still needs the upstream service key so the shared startup graph can
 * be composed without loading the Electron Clerk runtime.
 */
export const DesktopClerk = Context.Service<
  DesktopClerkService.DesktopClerk,
  DesktopClerkService.DesktopClerk["Service"]
>()("@t3tools/desktop/app/DesktopClerk");

export const make = DesktopClerk.of({
  configure: Effect.void,
});

export const layer = Layer.succeed(DesktopClerk, make);
