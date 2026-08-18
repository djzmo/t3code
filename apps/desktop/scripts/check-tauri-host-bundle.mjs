import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const artifact = resolve("dist-tauri-host/host.cjs");
if (!existsSync(artifact)) {
  throw new Error(`missing Tauri host artifact: ${artifact}`);
}

const source = readFileSync(artifact, "utf8");
const forbiddenRequest =
  /(?:require\s*\(\s*|from\s*["']|import\s*\(\s*["'])["']?(?:electron|electron-updater|@clerk\/electron)(?:\/(?:storage|preload))?["']?/;
if (forbiddenRequest.test(source)) {
  throw new Error("Tauri host artifact retains a runtime Electron, updater, or Clerk request");
}

if (!source.includes("Object.defineProperty(exports")) {
  throw new Error("Tauri host artifact is not a CommonJS bundle");
}

console.log(`Tauri host bundle OK: ${artifact}`);
