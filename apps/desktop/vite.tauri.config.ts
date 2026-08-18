import { fileURLToPath } from "node:url";

import { defineConfig } from "vite-plus";

const stubPath = (name: string): string =>
  fileURLToPath(new URL(`./src/tauri/stubs/${name}.ts`, import.meta.url));

/**
 * Exact package aliases for the Node host bundle used by Tauri.
 *
 * The aliases are intentionally regex-based: a broad `electron` alias would
 * also capture unrelated package names, while a broad Clerk alias could hide
 * a newly introduced subpath. Unsupported APIs resolve to the tiny stubs and
 * throw at the point of use.
 */
export const TAURI_HOST_ALIASES = [
  { find: /^electron$/, replacement: stubPath("electron") },
  { find: /^electron-updater$/, replacement: stubPath("electron-updater") },
  { find: /^@clerk\/electron$/, replacement: stubPath("clerk-electron") },
  { find: /^@clerk\/electron\/storage$/, replacement: stubPath("clerk-electron") },
  { find: /^@clerk\/electron\/preload$/, replacement: stubPath("clerk-electron") },
] as const;

export const TAURI_HOST_BUILD = {
  entry: "src/tauri/main.ts",
  outDir: "dist-tauri-host",
  fileName: "host.cjs",
} as const;

export const resolveTauriHostVersionDefines = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
) => {
  const define = (name: string): string => {
    const value = environment[name];
    return value === undefined ? "undefined" : JSON.stringify(value);
  };
  return {
    __NANONI_PRODUCT_VERSION__: define("NANONI_PRODUCT_VERSION"),
    __NANONI_COMPAT_SERVER_VERSION__: define("NANONI_COMPAT_SERVER_VERSION"),
    __NANONI_UPSTREAM_TAG__: define("NANONI_UPSTREAM_TAG"),
  } as const;
};

export default defineConfig({
  define: resolveTauriHostVersionDefines(),
  resolve: {
    alias: TAURI_HOST_ALIASES,
  },
  build: {
    ssr: TAURI_HOST_BUILD.entry,
    outDir: TAURI_HOST_BUILD.outDir,
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      output: {
        format: "cjs",
        entryFileNames: TAURI_HOST_BUILD.fileName,
        chunkFileNames: "chunks/[name]-[hash].cjs",
      },
    },
  },
  ssr: {
    target: "node",
  },
});
