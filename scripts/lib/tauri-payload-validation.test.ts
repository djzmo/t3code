// @effect-diagnostics nodeBuiltinImport:off

import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  TAURI_PAYLOAD_FFF_ENTRY,
  TAURI_PAYLOAD_HOST_ENTRY,
  TAURI_PAYLOAD_SERVER_ENTRY,
  validateTauriPayload,
  type TauriPayloadValidationCommandInvocation,
} from "./tauri-payload-validation.ts";

const temporaryRoots: string[] = [];

const makeFixture = async (hostSource = "#!/usr/bin/env node\n") => {
  const root = await NodeFS.mkdtemp(
    NodePath.join(process.cwd(), ".tauri-payload-validation-test-"),
  );
  temporaryRoots.push(root);
  const paths = {
    root,
    node: NodePath.join(root, "agent-nanoni-node.exe"),
    server: NodePath.join(root, TAURI_PAYLOAD_SERVER_ENTRY),
    fff: NodePath.join(root, TAURI_PAYLOAD_FFF_ENTRY),
    host: NodePath.join(root, TAURI_PAYLOAD_HOST_ENTRY),
  };
  await NodeFS.mkdir(NodePath.dirname(paths.server), { recursive: true });
  await NodeFS.mkdir(NodePath.dirname(paths.fff), { recursive: true });
  await NodeFS.mkdir(NodePath.dirname(paths.host), { recursive: true });
  await Promise.all([
    NodeFS.writeFile(paths.node, "node sidecar\n"),
    NodeFS.writeFile(paths.server, "console.log('t3 v0.0.33')\n"),
    NodeFS.writeFile(paths.fff, "export const FileFinder = {};\n"),
    NodeFS.writeFile(paths.host, hostSource),
  ]);
  return paths;
};

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => NodeFS.rm(root, { recursive: true, force: true })),
  );
});

describe("validateTauriPayload", () => {
  it("runs both isolated sidecar probes and returns structured evidence", async () => {
    const fixture = await makeFixture();
    const invocations: TauriPayloadValidationCommandInvocation[] = [];

    const result = await validateTauriPayload({
      stageRoot: fixture.root,
      platform: "win",
      runCommand: async (invocation) => {
        invocations.push(invocation);
        await expect(NodeFS.stat(invocation.cwd)).resolves.toMatchObject({});
        return {
          exitCode: 0,
          stdout: invocation.args.includes("--version") ? "t3 v0.0.33\n" : "",
        };
      },
    });

    expect(result.stageRoot).toBe(fixture.root);
    expect(result.nodeSidecarPath).toBe(fixture.node);
    expect(result.serverEntryPath).toBe(fixture.server);
    expect(result.fffEntryPath).toBe(fixture.fff);
    expect(result.hostBundlePath).toBe(fixture.host);
    expect(result.host.electronImports).toEqual([]);
    expect(result.serverVersion).toMatchObject({
      operation: "server-version",
      command: fixture.node,
      exitCode: 0,
    });
    expect(result.serverVersion.args[0]).toBe("--no-global-search-paths");
    expect(result.serverVersion.args[1]).toMatch(
      /payload-probe-.*[\\/]server[\\/]apps[\\/]server[\\/]dist[\\/]bin\.mjs$/,
    );
    expect(result.serverVersion.args[1]).not.toBe(fixture.server);
    expect(result.serverVersion.args[2]).toBe("--version");
    expect(result.fffNativeLoad).toMatchObject({
      operation: "fff-native-load",
      command: fixture.node,
      exitCode: 0,
    });
    expect(result.fffNativeLoad.args.slice(0, 3)).toEqual([
      "--no-global-search-paths",
      "--input-type=module",
      "--eval",
    ]);
    expect(
      result.fffNativeLoad.args.some((argument) =>
        /payload-probe-.*[\\/]server[\\/]node_modules[\\/]@ff-labs[\\/]fff-node[\\/]dist[\\/]src[\\/]index\.js$/.test(
          argument,
        ),
      ),
    ).toBe(true);
    expect(result.fffNativeLoad.args).toContain(result.fffNativeLoad.cwd);
    expect(invocations).toHaveLength(2);
    for (const invocation of invocations) {
      expect(invocation.environment.NODE_PATH).toBe("");
      expect(invocation.environment.NODE_OPTIONS).toBeUndefined();
      expect(invocation.cwd).not.toBe(fixture.root);
    }
  });

  it("rejects a missing staged target before starting a command", async () => {
    const fixture = await makeFixture();
    await NodeFS.rm(fixture.fff);
    let commandStarted = false;

    await expect(
      validateTauriPayload({
        stageRoot: fixture.root,
        platform: "win",
        runCommand: async () => {
          commandStarted = true;
          return { exitCode: 0 };
        },
      }),
    ).rejects.toMatchObject({ code: "missing-input" });
    expect(commandStarted).toBe(false);
  });

  it("rejects a sidecar path outside the staged payload", async () => {
    const fixture = await makeFixture();
    const outside = NodePath.join(fixture.root, "..", "outside-node.exe");
    await NodeFS.writeFile(outside, "outside\n");
    try {
      await expect(
        validateTauriPayload({
          stageRoot: fixture.root,
          nodeSidecarPath: outside,
          platform: "win",
          runCommand: async () => ({ exitCode: 0 }),
        }),
      ).rejects.toMatchObject({ code: "invalid-input" });
    } finally {
      await NodeFS.rm(outside, { force: true });
    }
  });

  it("rejects runtime Electron imports in the staged host", async () => {
    const fixture = await makeFixture(
      "const electron = require('electron');\nexport { electron };\n",
    );
    let commandStarted = false;

    await expect(
      validateTauriPayload({
        stageRoot: fixture.root,
        platform: "win",
        runCommand: async () => {
          commandStarted = true;
          return { exitCode: 0 };
        },
      }),
    ).rejects.toMatchObject({ code: "electron-import" });
    expect(commandStarted).toBe(false);
  });

  it.each([
    "import electron from 'electron';\n",
    "import('electron/main');\n",
    "import 'node:electron';\n",
    "const electron = require('node:electron');\n",
  ])("rejects Electron import form %s", async (hostSource) => {
    const fixture = await makeFixture(hostSource);
    await expect(
      validateTauriPayload({
        stageRoot: fixture.root,
        platform: "win",
        runCommand: async () => ({ exitCode: 0 }),
      }),
    ).rejects.toMatchObject({ code: "electron-import" });
  });

  it("reports a failed server version command with its captured output", async () => {
    const fixture = await makeFixture();
    await expect(
      validateTauriPayload({
        stageRoot: fixture.root,
        platform: "win",
        runCommand: async () => ({ exitCode: 17, stderr: "missing dependency\n" }),
      }),
    ).rejects.toMatchObject({
      code: "command-failed",
      operation: "server-version",
      commandResult: { exitCode: 17, stderr: "missing dependency\n" },
    });
  });

  it("reports a failed fff native-load command separately", async () => {
    const fixture = await makeFixture();
    let calls = 0;
    await expect(
      validateTauriPayload({
        stageRoot: fixture.root,
        platform: "win",
        runCommand: async () => {
          calls += 1;
          return calls === 1
            ? { exitCode: 0, stdout: "t3 v0.0.33\n" }
            : { exitCode: 23, stderr: "native addon load failed\n" };
        },
      }),
    ).rejects.toMatchObject({
      code: "native-load-failed",
      operation: "fff-native-load",
      commandResult: { exitCode: 23, stderr: "native addon load failed\n" },
    });
  });
});
