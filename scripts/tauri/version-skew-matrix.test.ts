import { afterEach, describe, expect, it, vi } from "vite-plus/test";

interface BrandingModule {
  readonly APP_VERSION: string;
  readonly PRODUCT_VERSION: string;
  readonly COMPATIBLE_SERVER_VERSION: string;
  readonly UPSTREAM_BASE_TAG: string | null;
}

interface VersionSkewModule {
  readonly resolveVersionMismatch: (
    serverVersion: string,
  ) => { readonly clientVersion: string; readonly serverVersion: string } | null;
  readonly manualServerUpdateCommand: (targetVersion: string) => string;
}

const testGlobal = globalThis as typeof globalThis & { window?: unknown };
const originalWindow = testGlobal.window;
const brandingModulePath = "../../apps/web/src/branding.ts";
const versionSkewModulePath = "../../apps/web/src/versionSkew.ts";

const importBranding = async (): Promise<BrandingModule> => import(brandingModulePath);
const importVersionSkew = async (): Promise<VersionSkewModule> => import(versionSkewModulePath);

const installBoot = (compatibleServerVersion: string, productVersion = "1.0.0") => {
  Object.defineProperty(testGlobal, "window", {
    configurable: true,
    value: {
      __NANONI_BOOT__: {
        productVersion,
        compatibleServerVersion,
        upstreamBaseTag: `v${compatibleServerVersion}`,
      },
    },
  });
};

afterEach(() => {
  vi.resetModules();
  if (originalWindow === undefined) {
    Reflect.deleteProperty(testGlobal, "window");
  } else {
    testGlobal.window = originalWindow;
  }
});

describe("Tauri version-skew matrix", () => {
  it("uses the compatible server pin for local and pinned SSH servers", async () => {
    const compatibleVersion = "0.0.34-nightly.20260817.1116";
    installBoot(compatibleVersion, "1.0.0-nightly.20260818.42");
    const [{ COMPATIBLE_SERVER_VERSION, PRODUCT_VERSION }, { resolveVersionMismatch }] =
      await Promise.all([importBranding(), importVersionSkew()]);

    expect(PRODUCT_VERSION).toBe("1.0.0-nightly.20260818.42");
    expect(COMPATIBLE_SERVER_VERSION).toBe(compatibleVersion);
    expect(resolveVersionMismatch(compatibleVersion)).toBeNull();
  });

  it("names the exact compatible package when an older SSH server is detected", async () => {
    const compatibleVersion = "0.0.34-nightly.20260817.1116";
    installBoot(compatibleVersion);
    const { manualServerUpdateCommand, resolveVersionMismatch } = await importVersionSkew();

    expect(resolveVersionMismatch("0.0.33")).toMatchObject({
      clientVersion: compatibleVersion,
      serverVersion: "0.0.33",
    });
    expect(manualServerUpdateCommand(compatibleVersion)).toBe(`npx t3@${compatibleVersion}`);
  });

  it("falls back to the ordinary web build version without a Tauri boot snapshot", async () => {
    Reflect.deleteProperty(testGlobal, "window");
    const branding = await importBranding();

    expect(branding.PRODUCT_VERSION).toBe(branding.APP_VERSION);
    expect(branding.COMPATIBLE_SERVER_VERSION).toBe(branding.APP_VERSION);
    expect(branding.UPSTREAM_BASE_TAG).toBeNull();
  });
});
