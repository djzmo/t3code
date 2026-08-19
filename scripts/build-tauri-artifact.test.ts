// @effect-diagnostics nodeBuiltinImport:off

import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  TauriArtifactError,
  buildTauriArtifact,
  createTauriConfigOverlay,
  toTauriOverlayFrontendDist,
  inspectTauriArtifactPayload,
  parseTauriArtifactArguments,
  resolveNodeSidecarDestination,
  resolveNodeSidecarSourceName,
  resolveTauriBuildArguments,
  resolveTauriCliCwd,
  resolvePinnedNodeEnvironment,
  resolveTauriSmokeBundlePath,
} from "./build-tauri-artifact.ts";
import { stageTauriResources } from "./lib/tauri-stage.ts";

const temporaryRoots: string[] = [];

const metadata = {
  productVersion: "1.2.3",
  compatibleServerVersion: "0.0.34",
  upstreamBaseTag: "v0.0.34",
  packageSpec: "t3@0.0.34",
  channel: "stable" as const,
};

const makeFixture = async () => {
  const root = await NodeFS.mkdtemp(NodePath.join(process.cwd(), ".tauri-artifact-test-"));
  temporaryRoots.push(root);
  const server = NodePath.join(root, "server");
  const frontend = NodePath.join(root, "frontend");
  const host = NodePath.join(root, "host.cjs");
  const monitor = NodePath.join(root, "t3-resource-monitor");
  const node = NodePath.join(root, "agent-nanoni-node-linux-x64");
  const nodeLicense = NodePath.join(root, "NODE_LICENSE.txt");
  const update = NodePath.join(root, "app-update.yml");
  const stage = NodePath.join(root, "stage");
  const overlay = NodePath.join(root, "overlay.json");

  await NodeFS.mkdir(NodePath.join(server, "apps/server/dist"), { recursive: true });
  await NodeFS.mkdir(frontend, { recursive: true });
  await NodeFS.writeFile(NodePath.join(server, "apps/server/dist/bin.mjs"), "export {}\n");
  await NodeFS.writeFile(NodePath.join(frontend, "index.html"), "<!doctype html>\n");
  await NodeFS.writeFile(host, "#!/usr/bin/env node\n");
  await NodeFS.writeFile(monitor, "monitor\n");
  await NodeFS.writeFile(node, "node\n");
  await NodeFS.writeFile(nodeLicense, "Node license\n");
  await NodeFS.writeFile(update, "provider: tauri\n");

  return { root, server, frontend, host, monitor, node, nodeLicense, update, stage, overlay };
};

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => NodeFS.rm(root, { recursive: true, force: true })),
  );
});

describe("Tauri artifact orchestration", () => {
  it("stages and maps the triple-suffixed Node sidecar, writes the overlay, and runs both smokes", async () => {
    const fixture = await makeFixture();
    const builds: unknown[] = [];
    const smokes: Array<{
      variant: string | undefined;
      environment: Readonly<Record<string, string>>;
    }> = [];

    const result = await buildTauriArtifact({
      platform: "linux",
      arch: "x64",
      stageRoot: fixture.stage,
      frontendDist: fixture.frontend,
      serverClosurePath: fixture.server,
      hostBundlePath: fixture.host,
      nodeSidecarPath: fixture.node,
      nodeLicensePath: fixture.nodeLicense,
      appUpdateManifestPath: fixture.update,
      resourceMonitorPath: fixture.monitor,
      productVersion: metadata.productVersion,
      configOverlayPath: fixture.overlay,
      environment: {
        NANONI_PRODUCT_VERSION: "stale",
        NANONI_NIGHTLY_DATE: "stale",
        VITE_CLERK_PUBLISHABLE_KEY: undefined,
        CI: "1",
      },
      dependencies: {
        resolveMetadata: () => metadata,
        validatePayload: async ({ stageRoot, nodeSidecarPath }) => {
          expect(stageRoot).toBe(NodePath.resolve(fixture.stage));
          expect(nodeSidecarPath).toBe(NodePath.join(fixture.stage, "agent-nanoni-node"));
          return undefined;
        },
        prepare: (context) => {
          expect(context.environment.NANONI_PRODUCT_VERSION).toBe("1.2.3");
        },
        build: (context) => {
          builds.push(context);
        },
        smoke: (context) => {
          smokes.push({ variant: context.smokeVariant, environment: context.environment });
        },
      },
    });

    expect(result.nodeSidecarPath).toBe(
      NodePath.join(fixture.stage, resolveNodeSidecarDestination("linux")),
    );
    expect(await NodeFS.readFile(result.nodeSidecarPath, "utf8")).toBe("node\n");
    expect(result.environment).toMatchObject({
      NANONI_PRODUCT_VERSION: "1.2.3",
      NANONI_COMPAT_SERVER_VERSION: "0.0.34",
      NANONI_UPSTREAM_TAG: "v0.0.34",
      APP_VERSION: "0.0.34",
      CI: "1",
    });
    expect(result.environment).not.toHaveProperty("NANONI_NIGHTLY_DATE");
    expect(JSON.parse(await NodeFS.readFile(fixture.overlay, "utf8"))).toEqual(
      result.configOverlay,
    );
    expect(result.configOverlay.version).toBe("1.2.3");
    expect(result.configOverlay.build.frontendDist).toBe(
      toTauriOverlayFrontendDist(fixture.frontend, fixture.stage),
    );
    expect(result.configOverlay.bundle.createUpdaterArtifacts).toBe(false);
    expect(Object.values(result.configOverlay.bundle.resources)).toEqual([""]);
    expect(Object.keys(result.configOverlay.bundle.resources)[0]).toBe(
      `${NodePath.resolve(fixture.stage)}${NodePath.sep}`,
    );
    const expectedBytes = (
      await Promise.all(
        [
          NodePath.join(fixture.server, "apps/server/dist/bin.mjs"),
          fixture.host,
          fixture.monitor,
          fixture.node,
          fixture.nodeLicense,
          fixture.update,
        ].map(async (path) => (await NodeFS.stat(path)).size),
      )
    ).reduce((total, size) => total + size, 0);
    expect(result.payload).toEqual({
      fileCount: 6,
      regularFileCount: 6,
      symlinkCount: 0,
      directoryCount: 8,
      regularFileBytes: expectedBytes,
    });
    expect(builds).toHaveLength(1);
    expect(smokes.map(({ variant }) => variant)).toEqual(["normal", "forced-kill"]);
    expect(smokes[0]?.environment).toMatchObject({
      NANONI_PRODUCT_VERSION: "1.2.3",
      NANONI_COMPAT_SERVER_VERSION: "0.0.34",
      NANONI_UPSTREAM_TAG: "v0.0.34",
      APP_VERSION: "0.0.34",
      AGENT_NANONI_SMOKE: "1",
    });
    expect(smokes[1]?.environment).toMatchObject({ AGENT_NANONI_SMOKE_KILL_HOST: "1" });
  });

  it("fails the file-count budget before build or smoke", async () => {
    const fixture = await makeFixture();
    const calls: string[] = [];

    await expect(
      buildTauriArtifact({
        platform: "linux",
        arch: "x64",
        stageRoot: fixture.stage,
        frontendDist: fixture.frontend,
        serverClosurePath: fixture.server,
        hostBundlePath: fixture.host,
        nodeSidecarPath: fixture.node,
        nodeLicensePath: fixture.nodeLicense,
        appUpdateManifestPath: fixture.update,
        resourceMonitorPath: fixture.monitor,
        dependencies: {
          resolveMetadata: () => metadata,
          payloadBudgetLimits: { maxFileCount: 4 },
          build: () => {
            calls.push("build");
          },
          smoke: () => {
            calls.push("smoke");
          },
        },
      }),
    ).rejects.toMatchObject<TauriArtifactError>({ code: "payload-budget-exceeded" });
    expect(calls).toEqual([]);
  });

  it("fails the regular-file byte budget before build or smoke", async () => {
    const fixture = await makeFixture();
    const calls: string[] = [];

    await expect(
      buildTauriArtifact({
        platform: "linux",
        arch: "x64",
        stageRoot: fixture.stage,
        frontendDist: fixture.frontend,
        serverClosurePath: fixture.server,
        hostBundlePath: fixture.host,
        nodeSidecarPath: fixture.node,
        nodeLicensePath: fixture.nodeLicense,
        appUpdateManifestPath: fixture.update,
        resourceMonitorPath: fixture.monitor,
        dependencies: {
          resolveMetadata: () => metadata,
          payloadBudgetLimits: { maxRegularFileBytes: 0 },
          build: () => {
            calls.push("build");
          },
          smoke: () => {
            calls.push("smoke");
          },
        },
      }),
    ).rejects.toMatchObject<TauriArtifactError>({ code: "payload-budget-exceeded" });
    expect(calls).toEqual([]);
  });

  it("counts safe symlinks without following them and rejects links outside the stage", async () => {
    const fixture = await makeFixture();
    const outside = NodePath.join(fixture.root, "outside.txt");
    await NodeFS.writeFile(outside, "outside payload\n");
    const staged = await buildTauriArtifact({
      platform: "linux",
      arch: "x64",
      stageRoot: fixture.stage,
      frontendDist: fixture.frontend,
      serverClosurePath: fixture.server,
      hostBundlePath: fixture.host,
      nodeSidecarPath: fixture.node,
      nodeLicensePath: fixture.nodeLicense,
      appUpdateManifestPath: fixture.update,
      resourceMonitorPath: fixture.monitor,
      dependencies: {
        resolveMetadata: () => metadata,
        assertClerkAbsent: async () => undefined,
        validatePayload: async () => undefined,
        stageResources: async (input) => {
          const result = await stageTauriResources(input);
          const linkPath = NodePath.join(result.stageRoot, "host-link");
          await NodeFS.symlink(
            NodePath.relative(NodePath.dirname(linkPath), result.paths.hostBundle),
            linkPath,
            "file",
          );
          return result;
        },
      },
    });
    expect(staged.payload.symlinkCount).toBe(1);
    expect(staged.payload.fileCount).toBe(7);
    expect(staged.payload.regularFileBytes).toBe(
      (await NodeFS.stat(fixture.host)).size +
        (await NodeFS.stat(fixture.node)).size +
        (await NodeFS.stat(fixture.monitor)).size +
        (await NodeFS.stat(fixture.nodeLicense)).size +
        (await NodeFS.stat(fixture.update)).size +
        (await NodeFS.stat(NodePath.join(fixture.server, "apps/server/dist/bin.mjs"))).size,
    );

    await NodeFS.rm(NodePath.join(fixture.stage, "host-link"));
    await NodeFS.symlink(outside, NodePath.join(fixture.stage, "escape"), "file");
    await expect(
      inspectTauriArtifactPayload(fixture.stage),
    ).rejects.toMatchObject<TauriArtifactError>({ code: "unsafe-payload" });
  });

  it("fails closed for partial Clerk configuration before staging", async () => {
    const fixture = await makeFixture();

    await expect(
      buildTauriArtifact({
        platform: "linux",
        arch: "x64",
        stageRoot: fixture.stage,
        frontendDist: fixture.frontend,
        serverClosurePath: fixture.server,
        hostBundlePath: fixture.host,
        nodeSidecarPath: fixture.node,
        nodeLicensePath: fixture.nodeLicense,
        appUpdateManifestPath: fixture.update,
        resourceMonitorPath: fixture.monitor,
        environment: { T3CODE_CLERK_JWT_TEMPLATE: "fork-jwt-only" },
        dependencies: { resolveMetadata: () => metadata },
      }),
    ).rejects.toMatchObject<TauriArtifactError>({ code: "clerk-config-present" });

    await expect(NodeFS.stat(fixture.stage)).rejects.toThrow();
  });

  it("fails closed when a host output contains a publishable key", async () => {
    const fixture = await makeFixture();
    await NodeFS.writeFile(fixture.host, "const leaked = 'pk_test_output';\n");

    await expect(
      buildTauriArtifact({
        platform: "linux",
        arch: "x64",
        stageRoot: fixture.stage,
        frontendDist: fixture.frontend,
        serverClosurePath: fixture.server,
        hostBundlePath: fixture.host,
        nodeSidecarPath: fixture.node,
        nodeLicensePath: fixture.nodeLicense,
        appUpdateManifestPath: fixture.update,
        resourceMonitorPath: fixture.monitor,
        dependencies: { resolveMetadata: () => metadata },
      }),
    ).rejects.toMatchObject<TauriArtifactError>({ code: "clerk-config-present" });
  });

  it("rejects a Node sidecar from a different target tuple", async () => {
    const fixture = await makeFixture();
    await expect(
      buildTauriArtifact({
        platform: "linux",
        arch: "arm64",
        stageRoot: fixture.stage,
        frontendDist: fixture.frontend,
        serverClosurePath: fixture.server,
        hostBundlePath: fixture.host,
        nodeSidecarPath: fixture.node,
        nodeLicensePath: fixture.nodeLicense,
        appUpdateManifestPath: fixture.update,
        resourceMonitorPath: fixture.monitor,
        dependencies: { resolveMetadata: () => metadata },
      }),
    ).rejects.toMatchObject<TauriArtifactError>({ code: "invalid-input" });
  });

  it("keeps CLI parsing pure and maps platform aliases", () => {
    const parsed = parseTauriArtifactArguments(
      [
        "--platform",
        "win32",
        "--arch",
        "arm64",
        "--server",
        "server",
        "--node",
        "agent-nanoni-node-win-arm64.exe",
        "--node-license",
        "NODE_LICENSE.txt",
        "--resource-monitor",
        "monitor.exe",
        "--product-version",
        "1.2.3",
        "--skip-build",
        "--skip-smoke",
      ],
      { rootDir: "C:/repo" },
    );

    expect(parsed.platform).toBe("win");
    expect(parsed.arch).toBe("arm64");
    expect(parsed.skipBuild).toBe(true);
    expect(parsed.debug).toBe(false);
    expect(resolveNodeSidecarSourceName("win", "arm64")).toBe("agent-nanoni-node-win-arm64.exe");
  });

  it("derives target paths after root, platform, and architecture overrides", () => {
    const parsed = parseTauriArtifactArguments([
      "--root",
      "D:/alternate",
      "--platform",
      "win",
      "--arch",
      "arm64",
      "--product-version",
      "1.2.3",
      "--skip-build",
      "--skip-smoke",
    ]);

    expect(parsed.serverClosurePath).toBe(
      NodePath.join("D:/alternate", ".t3/tauri-server-closure/win-arm64"),
    );
    expect(parsed.nodeSidecarPath).toBe(
      NodePath.join(
        "D:/alternate",
        "apps/desktop/src-tauri/binaries/agent-nanoni-node-win-arm64.exe",
      ),
    );
    expect(parsed.resourceMonitorPath).toBe(
      NodePath.join(
        "D:/alternate",
        "native/resource-monitor/target/release/t3-resource-monitor.exe",
      ),
    );
  });

  it("rejects CLI packaging without an explicit version or license", () => {
    const base = [
      "--server",
      "server",
      "--node",
      "agent-nanoni-node-linux-x64",
      "--resource-monitor",
      "monitor",
    ];
    expect(() => parseTauriArtifactArguments([...base, "--node-license", "LICENSE"])).toThrow(
      /--product-version is required/,
    );
    const parsed = parseTauriArtifactArguments(
      [...base, "--node-license", "LICENSE", "--product-version", "1.2.3"],
      { platform: "linux" },
    );
    expect(parsed.platform).toBe("linux");
    expect(parsed.binaryPath).toBeUndefined();

    const windows = parseTauriArtifactArguments(
      [...base, "--node-license", "LICENSE", "--product-version", "1.2.3"],
      { platform: "win" },
    );
    expect(windows.platform).toBe("win");
    expect(windows.skipSmoke).toBe(false);
  });

  it("creates an updater-disabled overlay without touching the base config", () => {
    const overlay = createTauriConfigOverlay({
      productVersion: "1.2.3",
      frontendDist: "./dist",
      stageRoot: "./stage",
    });
    expect(overlay).toMatchObject({
      version: "1.2.3",
      build: { frontendDist: toTauriOverlayFrontendDist("./dist", "./stage") },
      bundle: { createUpdaterArtifacts: false },
    });
    expect(NodePath.isAbsolute(overlay.build.frontendDist)).toBe(false);
  });

  it("runs the Tauri CLI from the desktop project directory", () => {
    expect(resolveTauriCliCwd("C:/repo")).toBe(NodePath.join("C:/repo", "apps/desktop"));
  });

  it("resolves exactly one Linux AppImage and rejects ambiguous or non-file output", async () => {
    const fixture = await makeFixture();
    const appImageDirectory = NodePath.join(
      fixture.root,
      "apps/desktop/src-tauri/target/debug/bundle/appimage",
    );
    await NodeFS.mkdir(appImageDirectory, { recursive: true });
    const appImage = NodePath.join(appImageDirectory, "T3-Code.AppImage");
    await NodeFS.writeFile(appImage, "appimage\n");

    await expect(
      resolveTauriSmokeBundlePath({ rootDir: fixture.root, platform: "linux", profile: "debug" }),
    ).resolves.toBe(appImage);

    await NodeFS.writeFile(NodePath.join(appImageDirectory, "other.AppImage"), "appimage\n");
    await expect(
      resolveTauriSmokeBundlePath({ rootDir: fixture.root, platform: "linux", profile: "debug" }),
    ).rejects.toThrow(/exactly one AppImage/);

    await NodeFS.rm(NodePath.join(appImageDirectory, "other.AppImage"));
    await NodeFS.rm(appImage);
    await NodeFS.mkdir(appImage, { recursive: true });
    await expect(
      resolveTauriSmokeBundlePath({ rootDir: fixture.root, platform: "linux", profile: "debug" }),
    ).rejects.toThrow(/not a regular file/);
  });

  it("resolves the sole macOS app executable and rejects ambiguous app output", async () => {
    const fixture = await makeFixture();
    const macBundleDirectory = NodePath.join(
      fixture.root,
      "apps/desktop/src-tauri/target/release/bundle/macos",
    );
    const appBundle = NodePath.join(macBundleDirectory, "T3 Code.app");
    const executableDirectory = NodePath.join(appBundle, "Contents/MacOS");
    await NodeFS.mkdir(executableDirectory, { recursive: true });
    const executable = NodePath.join(executableDirectory, "T3 Code");
    await NodeFS.writeFile(executable, "mach-o\n");

    await expect(
      resolveTauriSmokeBundlePath({ rootDir: fixture.root, platform: "mac", profile: "release" }),
    ).resolves.toBe(executable);

    await NodeFS.mkdir(NodePath.join(macBundleDirectory, "Other.app", "Contents/MacOS"), {
      recursive: true,
    });
    await expect(
      resolveTauriSmokeBundlePath({ rootDir: fixture.root, platform: "mac", profile: "release" }),
    ).rejects.toThrow(/exactly one macOS \.app bundle/);
  });

  it("fails closed when a macOS app has no single regular executable", async () => {
    const fixture = await makeFixture();
    const executableDirectory = NodePath.join(
      fixture.root,
      "apps/desktop/src-tauri/target/debug/bundle/macos/T3 Code.app/Contents/MacOS",
    );
    await NodeFS.mkdir(NodePath.join(executableDirectory, "not-an-executable"), {
      recursive: true,
    });

    await expect(
      resolveTauriSmokeBundlePath({ rootDir: fixture.root, platform: "mac", profile: "debug" }),
    ).rejects.toThrow(/exactly one macOS app executable/);
  });

  it("resolves the Windows debug executable for packaged smoke", async () => {
    const fixture = await makeFixture();
    const executable = NodePath.join(
      fixture.root,
      "apps/desktop/src-tauri/target/debug/agent-nanoni-desktop.exe",
    );
    await NodeFS.mkdir(NodePath.dirname(executable), { recursive: true });
    await NodeFS.writeFile(executable, "exe\n");
    await expect(
      resolveTauriSmokeBundlePath({ rootDir: fixture.root, platform: "win", profile: "debug" }),
    ).resolves.toBe(executable);
  });

  it("rejects a Windows smoke executable that is missing", async () => {
    const fixture = await makeFixture();
    await expect(
      resolveTauriSmokeBundlePath({ rootDir: fixture.root, platform: "win", profile: "debug" }),
    ).rejects.toThrow(/Windows smoke executable is unavailable/);
  });

  it.skipIf(process.platform !== "win32")(
    "rejects a frontendDist that cannot be made relative to src-tauri",
    () => {
      expect(() =>
        toTauriOverlayFrontendDist("D:/outside/client", "C:/repo/apps/desktop/src-tauri/stage"),
      ).toThrow(
        expect.objectContaining({
          name: "TauriArtifactError",
          code: "frontend-dist-not-relative",
        }),
      );
    },
  );

  it("puts the pinned Node directory first even when the executable is already named node", async () => {
    const nodeExecutable = NodePath.join("C:/bundled-runtime", "node.exe");
    const inheritedPath = NodePath.join("C:/system-runtime", "bin");
    const environment = await resolvePinnedNodeEnvironment(
      "C:/repo",
      { [process.platform === "win32" ? "Path" : "PATH"]: inheritedPath, KEEP: "yes" },
      nodeExecutable,
    );

    expect(environment).toMatchObject({ KEEP: "yes" });
    if (process.platform === "win32") expect(environment).not.toHaveProperty("Path");
    expect(environment.PATH).toBe(
      `${NodePath.dirname(nodeExecutable)}${NodePath.delimiter}${inheritedPath}`,
    );
  });

  it("atomically creates a node shim for concurrent nonstandard runtime names", async () => {
    const rootDir = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "tauri-node-shim-root-"));
    const runtimeDirectory = await NodeFS.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "tauri-node-shim-runtime-"),
    );
    const nodeExecutable = NodePath.join(runtimeDirectory, "nodejs.exe");
    await NodeFS.writeFile(nodeExecutable, "pinned-runtime");

    try {
      const [first, second] = await Promise.all([
        resolvePinnedNodeEnvironment(rootDir, { PATH: "system" }, nodeExecutable),
        resolvePinnedNodeEnvironment(rootDir, { PATH: "system" }, nodeExecutable),
      ]);
      const firstDirectory = first.PATH?.split(NodePath.delimiter)[0];
      const secondDirectory = second.PATH?.split(NodePath.delimiter)[0];
      expect(firstDirectory).toBe(secondDirectory);
      expect(firstDirectory).toContain(NodePath.join(".t3", "tauri-node-shim"));
      const shimName = process.platform === "win32" ? "node.exe" : "node";
      expect(await NodeFS.readFile(NodePath.join(firstDirectory!, shimName), "utf8")).toBe(
        "pinned-runtime",
      );
    } finally {
      await NodeFS.rm(rootDir, { recursive: true, force: true });
      await NodeFS.rm(runtimeDirectory, { recursive: true, force: true });
    }
  });

  it("builds release artifacts by default and debug artifacts only when requested", () => {
    expect(resolveTauriBuildArguments("tauri.js", "overlay.json", false)).not.toContain("--debug");
    expect(resolveTauriBuildArguments("tauri.js", "overlay.json", true)).toContain("--debug");
  });
});
