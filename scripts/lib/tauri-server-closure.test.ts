// @effect-diagnostics nodeBuiltinImport:off

import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";
import { parse as parseYaml } from "yaml";

import {
  TAURI_SERVER_ENTRY,
  buildTauriServerClosure,
  type TauriServerClosureCommandInvocation,
} from "./tauri-server-closure.ts";

const temporaryRoots: string[] = [];

const makeFixture = async () => {
  const root = await NodeFS.mkdtemp(NodePath.join(process.cwd(), ".tauri-server-closure-test-"));
  temporaryRoots.push(root);
  const server = NodePath.join(root, "apps/server");
  const output = NodePath.join(root, "resources/server");
  const temporaryRoot = NodePath.join(root, "deploy-temp");

  await NodeFS.mkdir(NodePath.join(server, "dist"), { recursive: true });
  await NodeFS.writeFile(
    NodePath.join(server, "package.json"),
    `${JSON.stringify(
      {
        name: "t3",
        version: "0.0.33",
        type: "module",
        bin: { t3: "./dist/bin.mjs" },
        dependencies: {
          effect: "1.0.0",
          "@ff-labs/fff-node": "0.9.4",
          "msgpackr-extract": "3.0.4",
          "node-pty": "1.1.0",
        },
      },
      null,
      2,
    )}\n`,
  );
  await NodeFS.writeFile(
    NodePath.join(server, "dist/bin.mjs"),
    "#!/usr/bin/env node\nexport {};\n",
  );
  await NodeFS.writeFile(
    NodePath.join(root, "package.json"),
    `${JSON.stringify({ private: true, packageManager: "pnpm@11.10.0" })}\n`,
  );
  await NodeFS.writeFile(
    NodePath.join(root, "pnpm-workspace.yaml"),
    "packages:\n  - apps/*\nallowBuilds:\n  node-pty: true\n  msgpackr-extract: true\n",
  );
  await NodeFS.writeFile(
    NodePath.join(root, "pnpm-lock.yaml"),
    `${JSON.stringify(
      {
        lockfileVersion: "9.0",
        importers: {
          "apps/server": {
            dependencies: {
              "@ff-labs/fff-node": { specifier: "0.9.4", version: "0.9.4" },
              "msgpackr-extract": { specifier: "3.0.4", version: "3.0.4" },
              "node-pty": { specifier: "^1.1.0", version: "1.1.0" },
            },
          },
        },
        packages: {
          "@ff-labs/fff-bin-linux-x64-gnu@0.9.4": {},
          "@ff-labs/fff-bin-linux-x64-musl@0.9.4": {},
          "@ff-labs/fff-bin-win32-x64@0.9.4": {},
          "@ff-labs/fff-node@0.9.4": {},
          "msgpackr-extract@3.0.4": {},
          "node-pty@1.1.0": {},
        },
        snapshots: {
          "@ff-labs/fff-bin-linux-x64-gnu@0.9.4": {},
          "@ff-labs/fff-bin-linux-x64-musl@0.9.4": {},
          "@ff-labs/fff-bin-win32-x64@0.9.4": {},
          "@ff-labs/fff-node@0.9.4": {},
          "msgpackr-extract@3.0.4": {},
          "node-pty@1.1.0": {},
        },
      },
      null,
      2,
    )}\n`,
  );

  return { root, server, output, temporaryRoot };
};

const writeInstall = async (
  targetDir: string,
  options?: { readonly withNodeModules?: boolean },
) => {
  if (options?.withNodeModules === false) return;
  const manifest = JSON.parse(
    await NodeFS.readFile(NodePath.join(targetDir, "package.json"), "utf8"),
  ) as {
    dependencies: Record<string, string>;
  };
  for (const dependency of Object.keys(manifest.dependencies)) {
    const directory = NodePath.join(targetDir, "node_modules", ...dependency.split("/"));
    await NodeFS.mkdir(directory, { recursive: true });
    await NodeFS.writeFile(NodePath.join(directory, "index.js"), "export {};\n");
  }
  for (const name of ["darwin-arm64", "darwin-x64", "win32-arm64", "win32-x64"]) {
    const directory = NodePath.join(targetDir, "node_modules/node-pty/prebuilds", name);
    await NodeFS.mkdir(directory, { recursive: true });
    await NodeFS.writeFile(NodePath.join(directory, "pty.node"), name);
  }
  await NodeFS.mkdir(NodePath.join(targetDir, "node_modules/.bin"), { recursive: true });
  await NodeFS.writeFile(NodePath.join(targetDir, "node_modules/.bin/t3"), "generated");
};

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => NodeFS.rm(root, { recursive: true, force: true })),
  );
});

describe("buildTauriServerClosure", () => {
  it("installs only the selected runtime closure and atomically publishes the layout", async () => {
    const fixture = await makeFixture();
    await NodeFS.mkdir(fixture.output, { recursive: true });
    await NodeFS.writeFile(NodePath.join(fixture.output, "stale.txt"), "stale\n");
    let invocation: TauriServerClosureCommandInvocation | undefined;
    let generatedManifest:
      | { packageManager?: string; dependencies?: Record<string, string> }
      | undefined;
    let generatedLock:
      | {
          importers?: Record<
            string,
            { dependencies?: Record<string, { specifier?: string; version?: string }> }
          >;
        }
      | undefined;

    const result = await buildTauriServerClosure({
      rootDir: fixture.root,
      outputRoot: fixture.output,
      temporaryRoot: fixture.temporaryRoot,
      runCommand: async (input) => {
        invocation = input;
        generatedManifest = JSON.parse(
          await NodeFS.readFile(NodePath.join(input.targetDir, "package.json"), "utf8"),
        ) as typeof generatedManifest;
        generatedLock = parseYaml(
          await NodeFS.readFile(NodePath.join(input.targetDir, "pnpm-lock.yaml"), "utf8"),
        ) as typeof generatedLock;
        await writeInstall(input.targetDir);
        return { exitCode: 0, stdout: "installed\n" };
      },
    });

    expect(invocation?.command).toBe(process.platform === "win32" ? "corepack.cmd" : "corepack");
    expect(invocation?.args).toEqual(["pnpm", "install", "--prod", "--frozen-lockfile"]);
    expect(invocation?.cwd).toBe(fixture.temporaryRoot);
    expect(invocation?.environment.COREPACK_ENABLE_PROJECT_SPEC).toBe("1");
    expect(generatedManifest?.packageManager).toBe("pnpm@11.10.0");
    expect(generatedManifest?.dependencies).toEqual({
      "@ff-labs/fff-bin-linux-x64-gnu": "0.9.4",
      "@ff-labs/fff-bin-linux-x64-musl": "0.9.4",
      "@ff-labs/fff-bin-win32-x64": "0.9.4",
      "@ff-labs/fff-node": "0.9.4",
      "msgpackr-extract": "3.0.4",
      "node-pty": "1.1.0",
    });
    expect(generatedLock?.importers?.["."]?.dependencies?.["node-pty"]).toEqual({
      specifier: "1.1.0",
      version: "1.1.0",
    });
    expect(generatedLock).not.toHaveProperty("catalogs");
    expect(result.entryPath).toBe(NodePath.join(fixture.output, TAURI_SERVER_ENTRY));
    expect(result.nodeModulesPath).toBe(NodePath.join(fixture.output, "node_modules"));
    expect(result.packageJsonPath).toBe(NodePath.join(fixture.output, "package.json"));
    expect(result.externalDependencies).toEqual([
      "@ff-labs/fff-node",
      "msgpackr-extract",
      "node-pty",
    ]);
    expect(result.installedDependencies).toContain("@ff-labs/fff-bin-win32-x64");
    expect(result.installedDependencies).toContain("@ff-labs/fff-bin-linux-x64-gnu");
    expect(result.fileCount).toBeGreaterThan(4);
    expect(result.byteCount).toBeGreaterThan(0);
    expect(await NodeFS.readFile(result.entryPath, "utf8")).toContain("export {}");
    await expect(NodeFS.access(NodePath.join(fixture.output, "stale.txt"))).rejects.toThrow();
    await expect(
      NodeFS.access(NodePath.join(fixture.output, "apps/server/node_modules")),
    ).rejects.toThrow();
    await expect(
      NodeFS.access(NodePath.join(fixture.output, "node_modules/.bin")),
    ).rejects.toThrow();
    await expect(NodeFS.access(fixture.temporaryRoot)).rejects.toThrow();
  });

  it("prunes non-target node-pty prebuilds", async () => {
    const fixture = await makeFixture();
    const result = await buildTauriServerClosure({
      rootDir: fixture.root,
      outputRoot: fixture.output,
      temporaryRoot: fixture.temporaryRoot,
      runCommand: async (input) => {
        await writeInstall(input.targetDir);
        return { exitCode: 0 };
      },
    });

    await expect(
      NodeFS.access(NodePath.join(result.nodeModulesPath, "node-pty/prebuilds/win32-x64/pty.node")),
    ).resolves.toBeUndefined();
    await expect(
      NodeFS.access(NodePath.join(result.nodeModulesPath, "node-pty/prebuilds/darwin-x64")),
    ).rejects.toThrow();
  });

  it("preserves an existing output when deploy fails", async () => {
    const fixture = await makeFixture();
    await NodeFS.mkdir(fixture.output, { recursive: true });
    const sentinel = NodePath.join(fixture.output, "sentinel.txt");
    await NodeFS.writeFile(sentinel, "keep\n");

    await expect(
      buildTauriServerClosure({
        rootDir: fixture.root,
        outputRoot: fixture.output,
        temporaryRoot: fixture.temporaryRoot,
        runCommand: async () => ({ exitCode: 17, stderr: "no deploy\n" }),
      }),
    ).rejects.toMatchObject({ code: "command-failed" });

    expect(await NodeFS.readFile(sentinel, "utf8")).toBe("keep\n");
    await expect(
      NodeFS.access(NodePath.join(fixture.output, TAURI_SERVER_ENTRY)),
    ).rejects.toThrow();
  });

  it.each(["output", "source"] as const)(
    "rejects a temporary root overlapping %s without deleting it",
    async (overlap) => {
      const fixture = await makeFixture();
      await NodeFS.mkdir(fixture.output, { recursive: true });
      const protectedPath =
        overlap === "output"
          ? NodePath.join(fixture.output, "sentinel.txt")
          : NodePath.join(fixture.server, "dist/bin.mjs");
      if (overlap === "output") await NodeFS.writeFile(protectedPath, "keep\n");

      await expect(
        buildTauriServerClosure({
          rootDir: fixture.root,
          outputRoot: fixture.output,
          temporaryRoot: overlap === "output" ? fixture.output : fixture.server,
          runCommand: async () => {
            throw new Error("must not run");
          },
        }),
      ).rejects.toMatchObject({ code: "invalid-input" });

      await expect(NodeFS.access(protectedPath)).resolves.toBeUndefined();
    },
  );

  it("fails closed when the production dependency tree is absent", async () => {
    const fixture = await makeFixture();
    await expect(
      buildTauriServerClosure({
        rootDir: fixture.root,
        outputRoot: fixture.output,
        temporaryRoot: fixture.temporaryRoot,
        runCommand: async (input) => {
          await writeInstall(input.targetDir, { withNodeModules: false });
          return { exitCode: 0 };
        },
      }),
    ).rejects.toMatchObject({ code: "missing-input" });
    await expect(NodeFS.access(fixture.output)).rejects.toThrow();
  });

  it("rejects a symlink that escapes the deployment root without touching output", async () => {
    if (process.platform === "win32") return;
    const fixture = await makeFixture();
    await NodeFS.mkdir(fixture.output, { recursive: true });
    const sentinel = NodePath.join(fixture.output, "sentinel.txt");
    await NodeFS.writeFile(sentinel, "keep\n");
    const outside = NodePath.join(fixture.root, "outside.txt");
    await NodeFS.writeFile(outside, "outside\n");

    await expect(
      buildTauriServerClosure({
        rootDir: fixture.root,
        outputRoot: fixture.output,
        temporaryRoot: fixture.temporaryRoot,
        runCommand: async (input) => {
          await writeInstall(input.targetDir);
          await NodeFS.symlink(outside, NodePath.join(input.targetDir, "escape.txt"));
          return { exitCode: 0 };
        },
      }),
    ).rejects.toMatchObject({ code: "unsafe-symlink" });

    expect(await NodeFS.readFile(sentinel, "utf8")).toBe("keep\n");
  });
});
