import * as NodeFs from "node:fs";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";

import { createDefaultNanoniInitScript } from "../../src/tauri/bridge/shim/initScript.ts";

const desktopRoot = NodePath.resolve(fileURLToPath(new URL("../..", import.meta.url)));

export const rendererInitPath = NodePath.join(desktopRoot, "src-tauri", "gen", "renderer-init.js");

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  NodeFs.mkdirSync(NodePath.dirname(rendererInitPath), { recursive: true });
  NodeFs.writeFileSync(rendererInitPath, `${createDefaultNanoniInitScript()}\n`, "utf8");
}
