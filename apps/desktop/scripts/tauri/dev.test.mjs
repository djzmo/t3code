import { assert, describe, it } from "vite-plus/test";

import {
  DEV_WEB_GRAPH_ARGS,
  assertClerkAbsent,
  createDevelopmentOverlay,
  findClerkConfiguration,
  normalizeWorktreePath,
  resolveDevelopmentCommands,
  resolveDevelopmentIdentifier,
  resolveCanonicalWorktreePath,
  worktreeIdentity,
} from "./dev.mjs";

describe("Tauri development launcher", () => {
  it("normalizes canonical Windows paths before hashing", () => {
    const path = resolveCanonicalWorktreePath({
      cwd: "C:/Worktrees/Nanoni",
      platform: "win32",
      realpath: (value) => `${value}/../NANONI`,
    });

    assert.equal(path, "c:/worktrees/nanoni");
    assert.equal(path, normalizeWorktreePath(path, { platform: "win32" }));
  });

  it("derives a stable, bundle-safe per-worktree identifier", () => {
    const canonicalPath = "/worktrees/agent-nanoni";
    const id = worktreeIdentity(canonicalPath);

    assert.match(id, /^[a-f0-9]{12}$/);
    assert.equal(resolveDevelopmentIdentifier(canonicalPath), `app.nanoni.agent.desktop.dev.${id}`);
  });

  it("keeps the development overlay limited to the identity", () => {
    assert.deepEqual(
      createDevelopmentOverlay(
        "app.nanoni.agent.desktop.dev.0123456789ab",
        "http://127.0.0.1:5737",
      ),
      {
        identifier: "app.nanoni.agent.desktop.dev.0123456789ab",
        build: { devUrl: "http://127.0.0.1:5737" },
      },
    );
    assert.throws(
      () =>
        createDevelopmentOverlay(
          "app.nanoni.agent.desktop.dev.0123456789ab",
          "https://example.com",
        ),
      /loopback HTTP/,
    );
  });

  it("rejects Clerk configuration before spawning either child", () => {
    assert.deepEqual(findClerkConfiguration({ VITE_CLERK_PUBLISHABLE_KEY: "  " }), []);
    assert.throws(
      () => assertClerkAbsent({ T3CODE_CLERK_PUBLISHABLE_KEY: "pk_test_example" }),
      /T3CODE_CLERK_PUBLISHABLE_KEY/,
    );
    assert.doesNotThrow(() => assertClerkAbsent({}));
  });

  it("builds the existing web graph and Tauri command without launching them", () => {
    const commands = resolveDevelopmentCommands({
      overlayPath: "C:/temp/tauri.dev.conf.json",
      extraArgs: ["--debug"],
    });

    assert.deepEqual(commands.web.args, DEV_WEB_GRAPH_ARGS);
    assert.deepEqual(commands.tauri.args, [
      "--filter",
      "@t3tools/desktop",
      "exec",
      "tauri",
      "dev",
      "--config",
      "C:/temp/tauri.dev.conf.json",
      "--debug",
    ]);
  });
});
