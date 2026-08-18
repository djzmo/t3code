import { assert, describe, it } from "vite-plus/test";

import {
  DEV_WEB_GRAPH_ARGS,
  assertClerkAbsent,
  createDevelopmentOverlay,
  createSpawnOptions,
  findClerkConfiguration,
  normalizeWorktreePath,
  resolveDevelopmentCommands,
  resolveHostEnvironment,
  resolveDevelopmentIdentifier,
  resolveCanonicalWorktreePath,
  terminateChild,
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

    assert.deepEqual(commands.host.args, [
      "--filter",
      "@t3tools/desktop",
      "run",
      "build:tauri-host",
    ]);
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

  it("pins the development sidecar to this Node runtime and host bundle", () => {
    assert.deepEqual(
      resolveHostEnvironment(
        { KEEP: "yes", AGENT_NANONI_NODE: "untrusted" },
        { nodeExecutable: "C:/node.exe", hostEntry: "C:/host.cjs" },
      ),
      {
        KEEP: "yes",
        AGENT_NANONI_NODE: "C:/node.exe",
        AGENT_NANONI_HOST_ENTRY: "C:/host.cjs",
      },
    );
  });

  it("detaches Unix children so shutdown can address their process groups", () => {
    assert.equal(
      createSpawnOptions({ cwd: "/worktrees/agent-nanoni", env: {}, platform: "linux" }).detached,
      true,
    );
    assert.equal(
      createSpawnOptions({ cwd: "C:/worktrees/agent-nanoni", env: {}, platform: "win32" }).detached,
      undefined,
    );
  });

  it("terminates a Unix child process group using only the captured PID", () => {
    const calls = [];
    const child = {
      pid: 31415,
      exitCode: null,
      signalCode: null,
      kill: () => calls.push(["child", "SIGTERM"]),
    };

    terminateChild(child, {
      platform: "linux",
      killProcess: (...args) => calls.push(["group", ...args]),
    });

    assert.deepEqual(calls, [["group", -31415, "SIGTERM"]]);
  });

  it("falls back to the captured child handle when the Unix group is gone", () => {
    const calls = [];
    const child = {
      pid: 27182,
      exitCode: null,
      signalCode: null,
      kill: (signal) => calls.push(["child", signal]),
    };

    terminateChild(child, {
      platform: "darwin",
      killProcess: () => {
        throw new Error("ESRCH");
      },
    });

    assert.deepEqual(calls, [["child", "SIGTERM"]]);
  });

  it("keeps Windows shutdown scoped to the captured PID taskkill", () => {
    const calls = [];
    const child = {
      pid: 4242,
      exitCode: null,
      signalCode: null,
      kill: () => calls.push(["child", "SIGTERM"]),
    };

    terminateChild(child, {
      platform: "win32",
      spawnSync: (...args) => calls.push(["taskkill", ...args]),
    });

    assert.deepEqual(calls, [
      ["taskkill", "taskkill", ["/PID", "4242", "/T", "/F"], { stdio: "ignore" }],
    ]);
  });
});
