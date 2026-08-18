// @effect-diagnostics nodeBuiltinImport:off
import { readFileSync } from "node:fs";

import { assert, describe, it } from "@effect/vitest";

import { resolveHome } from "./resolveHome.ts";

const portable = (value: string): string => value.replaceAll("\\", "/");

describe("resolveHome", () => {
  it("uses the frozen packaged home on Windows", () => {
    const resolved = resolveHome({
      isPackaged: true,
      platform: "win32",
      homeDirectory: "C:/Users/Alice",
      explicitHome: "C:/tmp/override",
      ambientHome: "C:/Users/Alice/.t3",
    });

    assert.deepEqual(
      {
        ...resolved,
        baseDir: portable(resolved.baseDir),
        stateDir: portable(resolved.stateDir),
      },
      {
        baseDir: "C:/Users/Alice/.agent-nanoni",
        stateDir: "C:/Users/Alice/.agent-nanoni/userdata",
        source: "packaged",
      },
    );
  });

  it("uses the frozen packaged home on macOS", () => {
    const resolved = resolveHome({
      isPackaged: true,
      platform: "darwin",
      homeDirectory: "/Users/alice",
    });

    assert.deepEqual(resolved, {
      baseDir: "/Users/alice/.agent-nanoni",
      stateDir: "/Users/alice/.agent-nanoni/userdata",
      source: "packaged",
    });
  });

  it("uses the frozen packaged home on Linux", () => {
    const resolved = resolveHome({
      isPackaged: true,
      platform: "linux",
      homeDirectory: "/home/alice",
    });

    assert.deepEqual(resolved, {
      baseDir: "/home/alice/.agent-nanoni",
      stateDir: "/home/alice/.agent-nanoni/userdata",
      source: "packaged",
    });
  });

  it("rejects malformed or relative packaged homes", () => {
    const base = {
      isPackaged: true,
      platform: "linux" as const,
    };

    assert.throws(
      () => resolveHome({ ...base, homeDirectory: "alice" }),
      /homeDirectory must be an absolute path/,
    );
    assert.throws(
      () => resolveHome({ ...base, homeDirectory: "   " }),
      /homeDirectory must not be empty/,
    );
    assert.throws(
      () => resolveHome({ ...base, homeDirectory: "C:\\Users\\alice" }),
      /homeDirectory must be an absolute path/,
    );
  });

  it("gives a trimmed explicit home precedence over worktree and ambient values", () => {
    const resolved = resolveHome({
      isPackaged: false,
      platform: "win32",
      homeDirectory: "C:/Users/Alice",
      cwd: "C:/repo",
      explicitHome: "  .cache/agent-nanoni  ",
      worktreePath: "C:/repo",
      ambientHome: "C:/Users/Alice/.t3",
    });

    assert.equal(resolved.source, "cli");
    assert.equal(portable(resolved.baseDir), "C:/repo/.cache/agent-nanoni");
    assert.equal(portable(resolved.stateDir), "C:/repo/.cache/agent-nanoni/userdata");
  });

  it("treats a blank explicit home as unset and keeps the worktree isolated", () => {
    const resolved = resolveHome({
      isPackaged: false,
      platform: "darwin",
      homeDirectory: "/Users/alice",
      worktreePath: "/work/t3code",
      explicitHome: "  ",
      ambientHome: "/Users/alice/.t3",
    });

    assert.deepEqual(resolved, {
      baseDir: "/work/t3code/.t3",
      stateDir: "/work/t3code/.t3/userdata",
      source: "worktree",
    });
  });

  it("ignores ambient T3CODE_HOME inside a worktree", () => {
    const resolved = resolveHome({
      isPackaged: false,
      platform: "linux",
      homeDirectory: "/home/alice",
      worktreePath: "/work/t3code",
      ambientHome: "/home/alice/.t3",
    });

    assert.equal(resolved.baseDir, "/work/t3code/.t3");
    assert.notEqual(resolved.stateDir, "/home/alice/.t3/userdata");
  });

  it("uses ambient T3CODE_HOME outside a worktree", () => {
    const resolved = resolveHome({
      isPackaged: false,
      platform: "linux",
      homeDirectory: "/home/alice",
      ambientHome: "/tmp/agent-nanoni",
    });

    assert.deepEqual(resolved, {
      baseDir: "/tmp/agent-nanoni",
      stateDir: "/tmp/agent-nanoni/userdata",
      source: "ambient",
    });
  });

  it("falls back to a safe home that cannot select ~/.t3/userdata", () => {
    const resolved = resolveHome({
      isPackaged: false,
      platform: "linux",
      homeDirectory: "/home/alice",
    });

    assert.deepEqual(resolved, {
      baseDir: "/home/alice/.t3/tauri",
      stateDir: "/home/alice/.t3/tauri/userdata",
      source: "default",
    });
    assert.notEqual(resolved.stateDir, "/home/alice/.t3/userdata");
  });

  it("has no Electron runtime dependency", () => {
    const source = readFileSync(new URL("./resolveHome.ts", import.meta.url), "utf8");

    assert.notMatch(source, /from\s+["']electron["']/);
    assert.notMatch(source, /require\(["']electron["']\)/);
  });
});
