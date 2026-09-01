import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

type PackageManifest = {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
};

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const cargoManifestPath = fileURLToPath(
  new URL("../../apps/desktop/src-tauri/Cargo.toml", import.meta.url),
);
const cargoLockPath = fileURLToPath(
  new URL("../../apps/desktop/src-tauri/Cargo.lock", import.meta.url),
);
const desktopPackagePath = fileURLToPath(
  new URL("../../apps/desktop/package.json", import.meta.url),
);

const cargoManifest = readFileSync(cargoManifestPath, "utf8");
const cargoLock = readFileSync(cargoLockPath, "utf8");
const desktopPackage = JSON.parse(readFileSync(desktopPackagePath, "utf8")) as PackageManifest;

const packageVersion = (packageName: string): string | undefined =>
  desktopPackage.dependencies?.[packageName] ?? desktopPackage.devDependencies?.[packageName];

const assertCargoPackageVersion = (packageName: string, version: string) => {
  const escapedName = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  expect(cargoLock).toMatch(
    new RegExp(
      `\\[\\[package\\]\\]\\r?\\nname = "${escapedName}"\\r?\\nversion = "${escapedVersion}"`,
    ),
  );
};

describe("Tauri toolchain alignment", () => {
  it("pins the direct Rust Tauri set exactly", () => {
    expect(cargoManifest).toContain('tauri = { version = "=2.11.5"');
    expect(cargoManifest).toContain('tauri-build = "=2.6.3"');
    expect(cargoManifest).toContain('muda = "=0.19.3"');

    assertCargoPackageVersion("tauri", "2.11.5");
    assertCargoPackageVersion("tauri-build", "2.6.3");
    assertCargoPackageVersion("muda", "0.19.3");
  });

  it("keeps the JavaScript API and CLI on their compatible exact pins", () => {
    expect(packageVersion("@tauri-apps/api")).toBe("2.11.1");
    expect(packageVersion("@tauri-apps/cli")).toBe("2.11.4");
  });

  it("keeps Rust and JavaScript feature-plugin pairs complete", () => {
    const rustPlugins = [...cargoManifest.matchAll(/^tauri-plugin-([a-z0-9-]+)\s*=/gm)]
      .map((match) => match[1])
      .filter((name) => name !== "pilot");
    const javascriptPlugins = Object.keys({
      ...desktopPackage.dependencies,
      ...desktopPackage.devDependencies,
    })
      .filter((name) => name.startsWith("@tauri-apps/plugin-"))
      .map((name) => name.slice("@tauri-apps/plugin-".length));

    expect(javascriptPlugins.toSorted()).toEqual(rustPlugins.toSorted());
  });

  it("pins the CLI-only debug Pilot against the repository Rust toolchain", () => {
    expect(cargoManifest).toContain('rust-version = "1.95"');
    expect(cargoManifest).toContain(
      'tauri-plugin-pilot = { version = "=0.7.2", default-features = false, optional = true }',
    );
    expect(cargoManifest).toContain('topology-a-pilot = ["dep:tauri-plugin-pilot"]');
    expect(packageVersion("@tauri-apps/plugin-pilot")).toBeUndefined();
  });

  it("keeps the app identity and main-only capability explicit", () => {
    const config = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../../apps/desktop/src-tauri/tauri.conf.json", import.meta.url)),
        "utf8",
      ),
    ) as {
      readonly identifier?: string;
      readonly productName?: string;
      readonly app?: { readonly security?: { readonly capabilities?: string[] } };
    };
    const capability = JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL("../../apps/desktop/src-tauri/capabilities/main.json", import.meta.url),
        ),
        "utf8",
      ),
    ) as { readonly webviews?: string[] };

    expect(config.identifier).toBe("app.nanoni.agent.desktop");
    expect(config.productName).toBe("Agent Nanoni");
    expect(config.app?.security?.capabilities).toEqual(["main"]);
    expect(capability.webviews).toEqual(["main"]);
  });

  it("resolves all files from the repository root", () => {
    expect(cargoManifestPath.startsWith(repositoryRoot)).toBe(true);
    expect(cargoLockPath.startsWith(repositoryRoot)).toBe(true);
    expect(desktopPackagePath.startsWith(repositoryRoot)).toBe(true);
  });
});
