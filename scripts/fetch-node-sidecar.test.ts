// @effect-diagnostics nodeBuiltinImport:off - This focused test uses local temp files as an injected boundary.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireNodeSidecar,
  loadNodeSidecarConfig,
  resolveNodeSidecarArtifact,
  stripHostEnvironment,
  SUPPORTED_NODE_SIDECAR_TRIPLES,
  type NodeSidecarConfig,
} from "./fetch-node-sidecar.ts";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const configPath = join(repositoryRoot, "apps/desktop/src-tauri/node-sidecar.json");
const temporaryRoots: string[] = [];
const AUTHORITATIVE_SHA256: Readonly<Record<string, string>> = {
  "darwin-arm64": "3f1cf157479c1480352083105e13faf9d008ede98e7e157746b6df940d197b94",
  "darwin-x64": "d35e95230f46f6f0751df497c56622c6735e05d5e1fb1630996a005b9d328fe4",
  "linux-arm64": "01443c1e1a29e531ccad5a46fefa6df490d2189c49f7955904aecdbb0fe86fdc",
  "linux-x64": "14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647",
  "win-arm64": "8502f4a50b458d4cc38ed8f2001556c2cd239d464920f74017926ccb1e1c157f",
  "win-x64": "57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73",
};

const fixtureConfig = (sha256: string): NodeSidecarConfig => {
  const artifacts = Object.fromEntries(
    SUPPORTED_NODE_SIDECAR_TRIPLES.map((triple) => {
      const archiveType = triple.startsWith("win-") ? "zip" : "tar.xz";
      const root = `node-v24.19.0-${triple}`;
      return [
        triple,
        {
          archiveName: `${root}.${archiveType}`,
          archiveType,
          sha256,
          expectedBinaryPath: `${root}/${triple.startsWith("win-") ? "node.exe" : "bin/node"}`,
          expectedLicensePath: `${root}/LICENSE`,
        },
      ];
    }),
  ) as NodeSidecarConfig["artifacts"];
  return {
    version: "24.19.0",
    baseUrl: "https://nodejs.org/dist/v24.19.0",
    sidecarName: "agent-nanoni-node",
    artifacts,
  };
};

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("official Node sidecar configuration", () => {
  it("pins Node 24.19.0 with a secure official artifact for every supported tuple", () => {
    const config = loadNodeSidecarConfig(configPath);

    expect(config.version).toBe("24.19.0");
    expect(Object.keys(config.artifacts).toSorted()).toEqual([
      "darwin-arm64",
      "darwin-x64",
      "linux-arm64",
      "linux-x64",
      "win-arm64",
      "win-x64",
    ]);

    for (const [triple, artifact] of Object.entries(config.artifacts)) {
      expect(config.baseUrl).toBe("https://nodejs.org/dist/v24.19.0");
      expect(artifact.archiveName).toContain("node-v24.19.0");
      expect(artifact.sha256).toBe(AUTHORITATIVE_SHA256[triple]);
      expect(artifact.expectedBinaryPath).not.toMatch(/(?:^|[\\/])\.\.(?:[\\/]|$)/);
      expect(artifact.expectedLicensePath).not.toMatch(/(?:^|[\\/])\.\.(?:[\\/]|$)/);
      expect(resolveNodeSidecarArtifact(config, triple).archiveName).toBe(artifact.archiveName);
    }
  });

  it("rejects unsupported tuples before any download is attempted", () => {
    const config = fixtureConfig("0".repeat(64));
    expect(() => resolveNodeSidecarArtifact(config, "linux-riscv64")).toThrow(
      /unsupported Node sidecar tuple/i,
    );
  });
});

describe("host environment isolation", () => {
  it("strips Electron, Node injection, and unknown T3 leakage without mutating input", () => {
    const input = {
      PATH: "path",
      T3CODE_HOME: "C:/home/.agent-nanoni",
      T3CODE_PORT: "3773",
      T3CODE_INTERNAL_SECRET: "must-not-leak",
      ELECTRON_RUN_AS_NODE: "1",
      ELECTRON_NO_ATTACH_CONSOLE: "1",
      NODE_OPTIONS: "--require evil",
      NODE_PATH: "C:/evil",
      AGENT_NANONI_NODE: "C:/dev/node.exe",
      VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
    };

    const output = stripHostEnvironment(input);

    expect(output).toEqual({
      PATH: "path",
      T3CODE_HOME: "C:/home/.agent-nanoni",
      T3CODE_PORT: "3773",
      AGENT_NANONI_NODE: "C:/dev/node.exe",
      VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
    });
    expect(input).toHaveProperty("ELECTRON_RUN_AS_NODE", "1");
  });
});

describe("sidecar acquisition", () => {
  it("downloads into a temporary staging directory, verifies before extraction, and moves atomically", async () => {
    const archive = new TextEncoder().encode("fixture archive bytes");
    const root = mkdtempSync(join(tmpdir(), "nanoni-node-sidecar-test-"));
    temporaryRoots.push(root);
    const config = fixtureConfig(sha256Hex(archive));
    const calls: string[] = [];
    let extractionCount = 0;

    const result = await acquireNodeSidecar({
      config,
      platform: "linux",
      arch: "x64",
      destinationDir: root,
      fetch: async (url, init) => {
        calls.push(`${url} ${String(init?.redirect)}`);
        return new Response(archive, { status: 200 });
      },
      extract: async (_archivePath, extractionRoot) => {
        extractionCount += 1;
        const binaryPath = join(extractionRoot, "node-v24.19.0-linux-x64/bin/node");
        const licensePath = join(extractionRoot, "node-v24.19.0-linux-x64/LICENSE");
        mkdirSync(dirname(binaryPath), { recursive: true });
        writeFileSync(binaryPath, "node binary");
        writeFileSync(licensePath, "Node license");
        return ["node-v24.19.0-linux-x64/bin/node", "node-v24.19.0-linux-x64/LICENSE"];
      },
    });

    expect(result.source).toBe("download");
    expect(result.path).toBe(join(root, "agent-nanoni-node-linux-x64"));
    expect(readFileSync(result.path, "utf8")).toBe("node binary");
    expect(extractionCount).toBe(1);
    expect(calls).toEqual([
      "https://nodejs.org/dist/v24.19.0/node-v24.19.0-linux-x64.tar.xz error",
    ]);
  });

  it("fails closed on a digest mismatch and never invokes extraction", async () => {
    const archive = new TextEncoder().encode("unexpected bytes");
    const root = mkdtempSync(join(tmpdir(), "nanoni-node-sidecar-test-"));
    temporaryRoots.push(root);
    let extractionCount = 0;

    await expect(
      acquireNodeSidecar({
        config: fixtureConfig("0".repeat(64)),
        platform: "linux",
        arch: "x64",
        destinationDir: root,
        fetch: async () => new Response(archive, { status: 200 }),
        extract: async () => {
          extractionCount += 1;
          return [];
        },
      }),
    ).rejects.toThrow(/sha-?256 mismatch/i);

    expect(extractionCount).toBe(0);
  });

  it("reuses a completed binary/license pair without downloading again", async () => {
    const archive = new TextEncoder().encode("fixture archive bytes");
    const root = mkdtempSync(join(tmpdir(), "nanoni-node-sidecar-test-"));
    temporaryRoots.push(root);
    const config = fixtureConfig(sha256Hex(archive));
    const download = {
      fetch: async () => new Response(archive, { status: 200 }),
      extract: async (_archivePath: string, extractionRoot: string) => {
        const binaryPath = join(extractionRoot, "node-v24.19.0-linux-x64/bin/node");
        const licensePath = join(extractionRoot, "node-v24.19.0-linux-x64/LICENSE");
        mkdirSync(dirname(binaryPath), { recursive: true });
        writeFileSync(binaryPath, "node binary");
        writeFileSync(licensePath, "Node license");
        return ["node-v24.19.0-linux-x64/bin/node", "node-v24.19.0-linux-x64/LICENSE"];
      },
    };
    const first = await acquireNodeSidecar({
      config,
      platform: "linux",
      arch: "x64",
      destinationDir: root,
      ...download,
    });
    const second = await acquireNodeSidecar({
      config,
      platform: "linux",
      arch: "x64",
      destinationDir: root,
      fetch: async () => {
        throw new Error("cache should bypass network");
      },
      extract: async () => {
        throw new Error("cache should bypass extraction");
      },
    });

    expect(first.source).toBe("download");
    expect(second).toMatchObject({ source: "cache", path: first.path });
  });

  it("rejects archive traversal entries before accepting an extracted binary", async () => {
    const archive = new TextEncoder().encode("fixture archive bytes");
    const root = mkdtempSync(join(tmpdir(), "nanoni-node-sidecar-test-"));
    temporaryRoots.push(root);

    await expect(
      acquireNodeSidecar({
        config: fixtureConfig(sha256Hex(archive)),
        platform: "linux",
        arch: "x64",
        destinationDir: root,
        fetch: async () => new Response(archive, { status: 200 }),
        extract: async () => ["../outside", "node-v24.19.0-linux-x64/bin/node"],
      }),
    ).rejects.toThrow(/unsafe archive entry/i);
  });

  it("allows an explicit dev override only when development mode is enabled", async () => {
    const root = mkdtempSync(join(tmpdir(), "nanoni-node-sidecar-test-"));
    temporaryRoots.push(root);
    const override = join(root, "node-dev.exe");
    writeFileSync(override, "dev node");
    const config = fixtureConfig("0".repeat(64));

    await expect(
      acquireNodeSidecar({
        config,
        platform: "linux",
        arch: "x64",
        destinationDir: root,
        env: { AGENT_NANONI_NODE: override },
        isDev: false,
        fetch: async () => {
          throw new Error("production override must not download");
        },
      }),
    ).rejects.toThrow(/production override must not download/);

    await expect(
      acquireNodeSidecar({
        config,
        platform: "linux",
        arch: "x64",
        destinationDir: root,
        env: { AGENT_NANONI_NODE: override },
        isDev: true,
        fetch: async () => {
          throw new Error("dev override must bypass download");
        },
      }),
    ).resolves.toMatchObject({ source: "dev-override", path: override });
  });
});
