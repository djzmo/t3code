import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type * as DesktopEnvironmentService from "../../app/DesktopEnvironment.ts";
import type * as DesktopWslServerTreeService from "../../wsl/DesktopWslServerTree.ts";

// Keep the same string key as the upstream environment service without
// importing its Electron-adjacent implementation.  TauriEnvironment provides
// this slot when the host composition is assembled.
export const DesktopEnvironment = Context.Service<
  DesktopEnvironmentService.DesktopEnvironment,
  DesktopEnvironmentService.DesktopEnvironment["Service"]
>()("@t3tools/desktop/app/DesktopEnvironment");

/** WSL extraction and preflight remain Phase 1/F6 work. */
export const DesktopWslServerTree = Context.Service<
  DesktopWslServerTreeService.DesktopWslServerTree,
  DesktopWslServerTreeService.DesktopWslServerTree["Service"]
>()("@t3tools/desktop/wsl/DesktopWslServerTree");

export const layer = Layer.effect(
  DesktopWslServerTree,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment;

    return DesktopWslServerTree.of({
      // The native extraction/preflight path is intentionally deferred to F6;
      // V1.1 preserves the configured server root for callers that select WSL.
      ensure: Effect.succeed({ ok: true, root: environment.serverRoot } as const),
      cleanupLegacy: Effect.void,
    });
  }),
);
