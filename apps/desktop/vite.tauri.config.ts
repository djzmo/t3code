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

export default defineConfig({
  resolve: {
    alias: TAURI_HOST_ALIASES,
  },
});
