import type { DesktopAppBranding, DesktopEnvironmentBootstrap } from "@t3tools/contracts";

/**
 * Values that the shell knows before the first renderer module is evaluated.
 * Keep this object JSON-shaped: it is embedded in a Tauri initialization
 * script and is never reconstructed through an IPC round trip.
 */
export type NanoniBootSnapshot = Readonly<Record<string, unknown>>;

/**
 * The synchronous part of the Electron preload surface.  These values are
 * copied into the init script so module-level web code can read them without
 * racing an asynchronous invoke.
 */
export interface NanoniRendererSyncSnapshot {
  readonly appBranding: DesktopAppBranding | null;
  readonly systemLocale: string | null;
  readonly localEnvironmentBootstraps: readonly DesktopEnvironmentBootstrap[];
  /** Cached because the upstream preload reads this synchronously at boot. */
  readonly windowFullscreenState?: boolean;
}

export interface NanoniRendererInitScriptOptions {
  readonly boot?: NanoniBootSnapshot;
  readonly sync: NanoniRendererSyncSnapshot;
  /** Tauri command exposed by the shell for one renderer invoke path. */
  readonly invokeCommand?: string;
  /** Tauri command exposed by the shell for ordered renderer pushes. */
  readonly eventsCommand?: string;
}
