import type { DesktopAppBranding, DesktopEnvironmentBootstrap } from "@t3tools/contracts";

/** Values written by the desktop host before the first web module evaluates. */
export interface NanoniBootSnapshot {
  readonly productVersion?: string;
  readonly compatibleServerVersion?: string;
  readonly upstreamBaseTag?: string;
  readonly platform?: string;
  readonly isDev?: boolean;
  readonly branding?: DesktopAppBranding | null;
  readonly locale?: string | null;
  readonly fullscreen?: boolean;
  readonly bootstraps?: readonly DesktopEnvironmentBootstrap[];
  readonly [key: string]: unknown;
}

declare global {
  interface Window {
    __NANONI_BOOT__?: NanoniBootSnapshot;
  }
}
