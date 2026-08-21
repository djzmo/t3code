// @effect-diagnostics nodeBuiltinImport:off
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { assert, describe, it } from "@effect/vitest";

const desktopRoot = dirname(
  fileURLToPath(new URL("../../../vite.tauri.config.ts", import.meta.url)),
);
const tauriSourceRoot = join(desktopRoot, "src", "tauri");
const forbiddenSpecifiers = [
  "electron",
  "electron-updater",
  "@clerk/electron",
  "@clerk/electron/storage",
  "@clerk/electron/preload",
] as const;

const tauriConfig = await import(
  fileURLToPath(new URL("../../../vite.tauri.config.ts", import.meta.url))
);
type TauriHostAlias = { readonly find: RegExp; readonly replacement: string };
const TAURI_HOST_ALIASES = tauriConfig.TAURI_HOST_ALIASES as readonly TauriHostAlias[];
const TAURI_HOST_BUILD = tauriConfig.TAURI_HOST_BUILD;
const resolveTauriHostVersionDefines = tauriConfig.resolveTauriHostVersionDefines;

const walkTypeScriptFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return walkTypeScriptFiles(path);
    return entry.isFile() && path.endsWith(".ts") ? [path] : [];
  });

const findAlias = (specifier: string) =>
  TAURI_HOST_ALIASES.find(({ find }) => find instanceof RegExp && find.test(specifier));

describe("Tauri host module aliases", () => {
  it("injects all three version values or explicit development fallbacks", () => {
    assert.deepEqual(
      resolveTauriHostVersionDefines({
        NANONI_PRODUCT_VERSION: "1.2.3",
        NANONI_COMPAT_SERVER_VERSION: "0.0.34-nightly.20260817.1116",
        NANONI_UPSTREAM_TAG: "v0.0.34-nightly.20260817.1116",
      }),
      {
        __NANONI_PRODUCT_VERSION__: '\"1.2.3\"',
        __NANONI_COMPAT_SERVER_VERSION__: '\"0.0.34-nightly.20260817.1116\"',
        __NANONI_UPSTREAM_TAG__: '\"v0.0.34-nightly.20260817.1116\"',
      },
    );
    assert.equal(resolveTauriHostVersionDefines({}).__NANONI_PRODUCT_VERSION__, "undefined");
  });

  it("declares the Node SSR host entry and deterministic CJS output", () => {
    assert.deepEqual(TAURI_HOST_BUILD, {
      entry: "src/tauri/host-entry.ts",
      outDir: "dist-tauri-host",
      fileName: "host.cjs",
    });

    const build = (
      tauriConfig.default as {
        build?: {
          ssr?: string;
          outDir?: string;
          emptyOutDir?: boolean;
          sourcemap?: boolean;
          rollupOptions?: {
            output?: {
              format?: string;
              entryFileNames?: string;
              chunkFileNames?: string;
            };
          };
        };
        ssr?: { target?: string };
      }
    ).build;
    assert.deepEqual(build, {
      ssr: "src/tauri/host-entry.ts",
      outDir: "dist-tauri-host",
      emptyOutDir: true,
      sourcemap: true,
      rollupOptions: {
        output: {
          format: "cjs",
          entryFileNames: "host.cjs",
          chunkFileNames: "chunks/[name]-[hash].cjs",
        },
      },
    });
    assert.deepEqual((tauriConfig.default as { ssr?: unknown }).ssr, {
      target: "node",
      noExternal: true,
    });
  });

  it("maps every forbidden runtime package to an existing exact stub", () => {
    const configuredAliases = (tauriConfig.default as { resolve?: { alias?: unknown } }).resolve
      ?.alias;
    assert.strictEqual(configuredAliases, TAURI_HOST_ALIASES);

    for (const specifier of forbiddenSpecifiers) {
      const alias = findAlias(specifier);
      assert.isDefined(alias, `missing exact alias for ${specifier}`);
      if (alias === undefined) continue;
      assert.isTrue(existsSync(alias.replacement), `missing stub for ${specifier}`);
      assert.isFalse(
        alias.find.test(`${specifier}/unexpected`),
        `alias for ${specifier} must not capture an unlisted subpath`,
      );
    }
  });

  it("covers all forbidden source imports and keeps the Tauri graph runtime-clean", () => {
    const sourceFiles = walkTypeScriptFiles(join(desktopRoot, "src"));
    const importPattern = /(?:from\s+|import\s*\(|require\s*\()(['"])([^'"]+)\1/g;
    const runtimeImportPattern = /(?:^|\n)\s*import\s+(?!type\b)[^\n;]*?from\s+(['"])([^'"]+)\1/g;

    for (const sourceFile of sourceFiles) {
      const source = readFileSync(sourceFile, "utf8");
      for (const match of source.matchAll(importPattern)) {
        const specifier = match[2];
        if (typeof specifier !== "string") continue;
        if (forbiddenSpecifiers.includes(specifier as (typeof forbiddenSpecifiers)[number])) {
          assert.isDefined(
            findAlias(specifier),
            `unaliased forbidden import in ${basename(sourceFile)}`,
          );
        }
      }

      if (!sourceFile.startsWith(tauriSourceRoot) || sourceFile.endsWith(".test.ts")) continue;
      for (const match of source.matchAll(runtimeImportPattern)) {
        assert.notInclude(
          forbiddenSpecifiers,
          match[2],
          `Tauri runtime source must not import ${match[2]} (${basename(sourceFile)})`,
        );
      }
    }
  });

  it("retains only the shared display bootstrap seam in the Electron stub", async () => {
    const electronStub = await import("./electron.ts");
    assert.deepEqual(electronStub.screen.getAllDisplays(), [
      { bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
    ]);
    assert.throws(() => electronStub.app.name, /unavailable in the Tauri host/);
    assert.throws(
      () => electronStub.net.fetch("https://example.test"),
      /unavailable in the Tauri host/,
    );
    assert.throws(
      () => electronStub.safeStorage.isEncryptionAvailable(),
      /unavailable in the Tauri host/,
    );
    assert.throws(
      () => electronStub.safeStorage.encryptString("secret"),
      /unavailable in the Tauri host/,
    );
    assert.throws(
      () => electronStub.safeStorage.decryptString(Buffer.from("secret")),
      /unavailable in the Tauri host/,
    );
    assert.throws(
      () => electronStub.safeStorage.getSelectedStorageBackend(),
      /unavailable in the Tauri host/,
    );
  });
});
