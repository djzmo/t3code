const NodeFS = await import("node:fs");
const NodeOS = await import("node:os");
const NodePath = await import("node:path");
const NodeBuffer = await import("node:buffer");
const NodeCrypto = await import("node:crypto");
const NodeZlib = await import("node:zlib");
import { afterEach, describe, expect, it } from "vitest";
import {
  buildProvenancePolicy,
  decodeSlsaProvenanceStatement,
  parseRemoteCliPin,
  RemoteCliPinError,
  verifyRemoteCliPin,
  type GitRunner,
} from "./check-remote-cli-pin.ts";

const temporaryRoots: string[] = [];
const INTEGRITY =
  "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";

const write = (root: string, relativePath: string, content: string | Uint8Array) => {
  const target = NodePath.join(root, relativePath);
  NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
  NodeFS.writeFileSync(target, content);
};

const fixture = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "remote-cli-pin-test-"));
  temporaryRoots.push(root);
  write(
    root,
    "pnpm-workspace.yaml",
    `packages:\n  - apps/*\n  - packages/*\ncatalog:\n  effect: 4.0.0\n`,
  );
  write(
    root,
    "apps/server/package.json",
    JSON.stringify(
      {
        name: "t3",
        version: "0.0.1",
        dependencies: {},
        devDependencies: { "@t3tools/contracts": "workspace:*" },
      },
      null,
      2,
    ),
  );
  write(
    root,
    "apps/desktop/package.json",
    JSON.stringify(
      {
        name: "@t3tools/desktop",
        version: "0.0.1",
        dependencies: { "@tauri-apps/api": "2.0.0" },
      },
      null,
      2,
    ),
  );
  write(
    root,
    "apps/web/package.json",
    JSON.stringify({ name: "@t3tools/web", version: "0.0.1" }, null, 2),
  );
  write(
    root,
    "packages/contracts/package.json",
    JSON.stringify({ name: "@t3tools/contracts", version: "0.0.1" }, null, 2),
  );
  write(root, "packages/contracts/src/index.ts", "export const contract = 'stable';\n");
  write(
    root,
    "apps/server/vite.config.ts",
    "import '../../vite.config.ts';\nimport '../../scripts/lib/build.ts';\n",
  );
  write(root, "apps/server/scripts/cli.ts", "import '../../../scripts/lib/build.ts';\n");
  write(root, "vite.config.ts", "export default {};\n");
  write(root, "scripts/lib/build.ts", "export const build = true;\n");
  write(
    root,
    "apps/desktop/src-tauri/remote-cli.json",
    JSON.stringify(
      {
        upstreamTag: "v0.0.1",
        packageSpec: "t3@0.0.1",
        tarballIntegrity: INTEGRITY,
      },
      null,
      2,
    ),
  );
  write(
    root,
    "pnpm-lock.yaml",
    `lockfileVersion: '9.0'\nimporters:\n  apps/server:\n    devDependencies:\n      '@t3tools/contracts':\n        specifier: workspace:*\n        version: link:../../packages/contracts\n  apps/desktop:\n    dependencies:\n      '@tauri-apps/api':\n        specifier: 2.0.0\n        version: 2.0.0\n  packages/contracts: {}\npackages:\n  '@tauri-apps/api@2.0.0': {}\nsnapshots:\n  '@tauri-apps/api@2.0.0': {}\n`,
  );
  return root;
};

const baselineGit = (root: string): GitRunner => {
  const baseline = new Map<string, string>();
  const visit = (directory: string) => {
    for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const full = NodePath.join(directory, entry.name);
      if (entry.isDirectory()) visit(full);
      else
        baseline.set(
          NodePath.relative(root, full).replaceAll("\\", "/"),
          NodeFS.readFileSync(full, "utf8"),
        );
    }
  };
  visit(root);
  return async (args) => {
    if (args[0] === "rev-parse" && args[1] === "--is-shallow-repository") return "false\n";
    if (args[0] === "rev-parse" && args[1] === "--verify") return "deadbeef\n";
    if (args[0] === "merge-base") return "";
    if (args[0] === "cat-file" && args[1] === "-t") {
      const relativePath = args[2]?.slice(args[2].indexOf(":") + 1);
      if (relativePath !== undefined && baseline.has(relativePath)) return "blob\n";
      if (
        relativePath !== undefined &&
        [...baseline.keys()].some((path) => path.startsWith(`${relativePath}/`))
      ) {
        return "tree\n";
      }
      throw new Error(`missing ${relativePath}`);
    }
    if (args[0] === "ls-tree") {
      const separator = args.indexOf("--");
      const prefixes = separator < 0 ? [] : args.slice(separator + 1);
      return [...baseline.keys()]
        .filter(
          (path) =>
            prefixes.length === 0 ||
            prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`)),
        )
        .join("\n");
    }
    if (args[0] === "show") {
      const relativePath = args[1]?.slice(args[1].indexOf(":") + 1);
      const value = relativePath === undefined ? undefined : baseline.get(relativePath);
      if (
        value === undefined &&
        relativePath !== undefined &&
        [...baseline.keys()].some((path) => path.startsWith(`${relativePath}/`))
      ) {
        return [...baseline.keys()]
          .filter((path) => path.startsWith(`${relativePath}/`))
          .join("\n");
      }
      if (value === undefined) throw new Error(`missing ${relativePath}`);
      return value;
    }
    throw new Error(`unexpected git command ${args.join(" ")}`);
  };
};

const check = (root: string) =>
  verifyRemoteCliPin({
    rootDir: root,
    git: baselineGit(root),
    distIntegrity: INTEGRITY,
    attestation: { attestations: [] },
    verifyExecutableSurface: async () => undefined,
  });

const tarEntry = (name: string, content: string | Uint8Array): NodeBuffer.Buffer => {
  const bytes = NodeBuffer.Buffer.from(content);
  const header = NodeBuffer.Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "ascii");
  header.write("00000000000\0", 108, 12, "ascii");
  header.write("00000000000\0", 116, 12, "ascii");
  header.write(bytes.length.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header[156] = 0x30;
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header.fill(0x20, 148, 156);
  const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  const padding = NodeBuffer.Buffer.alloc((512 - (bytes.length % 512)) % 512);
  return NodeBuffer.Buffer.concat([header, bytes, padding]);
};

type PackedFixtureFile = {
  readonly path: string;
  readonly content: string | Uint8Array;
};

type PackedFixtureOptions = {
  readonly trackedDist?: boolean;
  readonly localBuildFiles?: ReadonlyArray<PackedFixtureFile>;
  readonly extraTarEntries?: ReadonlyArray<PackedFixtureFile>;
};

const packedFixture = (expectedIntegrity: string, options: PackedFixtureOptions = {}) => {
  const root = fixture();
  const packageManifest = {
    name: "t3",
    version: "0.0.1",
    bin: { t3: "dist/t3.js" },
    files: ["dist"],
  };
  write(root, "apps/server/package.json", JSON.stringify(packageManifest, null, 2));
  write(root, "apps/server/dist/t3.js", "#!/usr/bin/env node\n");
  for (const file of options.localBuildFiles ?? []) {
    write(root, `apps/server/dist/${file.path}`, file.content);
  }
  write(
    root,
    "apps/desktop/src-tauri/remote-cli.json",
    JSON.stringify(
      { upstreamTag: "v0.0.1", packageSpec: "t3@0.0.1", tarballIntegrity: expectedIntegrity },
      null,
      2,
    ),
  );
  const tarEntries = [
    tarEntry("package/package.json", `${JSON.stringify(packageManifest)}\n`),
    tarEntry("package/dist/t3.js", "#!/usr/bin/env node\n"),
    ...(options.localBuildFiles ?? []).map((file) =>
      tarEntry(`package/dist/${file.path}`, file.content),
    ),
    ...(options.extraTarEntries ?? []).map((file) =>
      tarEntry(`package/${file.path}`, file.content),
    ),
    NodeBuffer.Buffer.alloc(1024),
  ];
  const tarBytes = NodeBuffer.Buffer.concat(tarEntries);
  const compressedBytes = NodeZlib.gzipSync(tarBytes);
  const archivePath = NodePath.join(root, "t3-0.0.1.tgz");
  NodeFS.writeFileSync(archivePath, compressedBytes);
  const delegate = baselineGit(root);
  const git: GitRunner = async (args) => {
    if (args[0] === "ls-tree" && args.includes("apps/server")) {
      return options.trackedDist === false
        ? "apps/server/package.json\n"
        : "apps/server/package.json\napps/server/dist/t3.js\n";
    }
    return delegate(args);
  };
  return { root, archivePath, git };
};

const npmPackShim = (root: string): string => {
  const shim = NodePath.join(root, "npm-shim");
  NodeFS.mkdirSync(shim, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(shim, "mock-npm.mjs"),
    [
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      "const args = process.argv.slice(2);",
      "const index = args.indexOf('--pack-destination');",
      "if (index < 0 || !args[index + 1]) process.exit(2);",
      "const destination = args[index + 1];",
      "const filename = 't3-0.0.1.tgz';",
      "fs.copyFileSync(process.env.MOCK_NPM_TARBALL, path.join(destination, filename));",
      "process.stdout.write(JSON.stringify([{ filename, integrity: process.env.MOCK_NPM_INTEGRITY }]));",
    ].join("\n"),
  );
  NodeFS.writeFileSync(
    NodePath.join(shim, "npm"),
    `#!/usr/bin/env node\n${NodeFS.readFileSync(NodePath.join(shim, "mock-npm.mjs"), "utf8")}`,
  );
  NodeFS.chmodSync(NodePath.join(shim, "npm"), 0o755);
  NodeFS.writeFileSync(
    NodePath.join(shim, "npm.cmd"),
    `@echo off\r\nnode "%~dp0mock-npm.mjs" %*\r\n`,
  );
  return shim;
};

const runWithDefaultSurface = async (
  root: string,
  archivePath: string,
  git: GitRunner,
  expectedIntegrity: string,
): Promise<unknown> => {
  const shim = npmPackShim(root);
  const previousPath = process.env.PATH;
  const previousArchive = process.env.MOCK_NPM_TARBALL;
  const previousIntegrity = process.env.MOCK_NPM_INTEGRITY;
  const previousTemp = process.env.TEMP;
  const previousTmp = process.env.TMP;
  const temporaryWithSpaces = NodePath.join(root, "npm temporary directory");
  NodeFS.mkdirSync(temporaryWithSpaces, { recursive: true });
  process.env.PATH = `${shim}${NodePath.delimiter}${previousPath ?? ""}`;
  process.env.MOCK_NPM_TARBALL = archivePath;
  process.env.MOCK_NPM_INTEGRITY = expectedIntegrity;
  process.env.TEMP = temporaryWithSpaces;
  process.env.TMP = temporaryWithSpaces;
  try {
    return await verifyRemoteCliPin({
      rootDir: root,
      git,
      distIntegrity: expectedIntegrity,
      attestation: { attestations: [] },
    });
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousArchive === undefined) delete process.env.MOCK_NPM_TARBALL;
    else process.env.MOCK_NPM_TARBALL = previousArchive;
    if (previousIntegrity === undefined) delete process.env.MOCK_NPM_INTEGRITY;
    else process.env.MOCK_NPM_INTEGRITY = previousIntegrity;
    if (previousTemp === undefined) delete process.env.TEMP;
    else process.env.TEMP = previousTemp;
    if (previousTmp === undefined) delete process.env.TMP;
    else process.env.TMP = previousTmp;
  }
};

afterEach(() => {
  for (const root of temporaryRoots.splice(0))
    NodeFS.rmSync(root, { recursive: true, force: true });
});

describe("remote CLI pin closure", () => {
  it.each([
    [
      {
        upstreamTag: "nightly-v0.0.1-nightly.20260818.1",
        packageSpec: "t3@0.0.1-nightly.20260818.1",
      },
      "invalid-tag",
    ],
    [{ upstreamTag: "v0.0.1", packageSpec: "t3@0.0.2" }, "invalid-package-spec"],
    [{ upstreamTag: "v0.0.1", packageSpec: "t3@0.0.1", extra: true }, "invalid-pin"],
  ] satisfies ReadonlyArray<readonly [Record<string, unknown>, string]>)(
    "rejects malformed pin grammar (%s)",
    (value: Record<string, unknown>, code: string) => {
      expect(() => parseRemoteCliPin(value)).toThrowError(expect.objectContaining({ code }));
    },
  );

  it("t1: ignores Tauri-only desktop dependencies", async () => {
    const root = fixture();
    write(
      root,
      "apps/desktop/package.json",
      JSON.stringify(
        {
          name: "@t3tools/desktop",
          version: "99.0.0",
          dependencies: { "@tauri-apps/api": "9.9.9", "@tauri-apps/plugin-shell": "9.9.9" },
        },
        null,
        2,
      ),
    );
    await expect(check(root)).resolves.toMatchObject({ packageVersion: "0.0.1" });
  });

  it("ignores changed scripts outside the pinned tag's reachable build graph", async () => {
    const root = fixture();
    write(root, "scripts/dev-runner.ts", "export const mode = 'upstream';\n");
    const git = baselineGit(root);
    write(root, "scripts/dev-runner.ts", "export const mode = 'tauri';\n");

    await expect(
      verifyRemoteCliPin({
        rootDir: root,
        git,
        distIntegrity: INTEGRITY,
        attestation: { attestations: [] },
        verifyExecutableSurface: async () => undefined,
      }),
    ).resolves.toMatchObject({ packageVersion: "0.0.1" });
  });

  it("resolves historical extensionless directory imports through an index blob", async () => {
    const root = fixture();
    write(root, "apps/server/vite.config.ts", "import '../../scripts/lib';\n");
    write(root, "apps/server/scripts/cli.ts", "export const cli = true;\n");
    write(root, "scripts/lib/index.ts", "export const indexed = true;\n");
    const delegate = baselineGit(root);
    const directoryShows: string[] = [];
    const git: GitRunner = async (args) => {
      if (args[0] === "show" && args[1]?.endsWith(":scripts/lib")) {
        directoryShows.push(args[1]);
        throw new Error("EISDIR");
      }
      return delegate(args);
    };
    write(root, "scripts/lib/index.ts", "export const indexed = false;\n");

    await expect(
      verifyRemoteCliPin({
        rootDir: root,
        git,
        distIntegrity: INTEGRITY,
        attestation: { attestations: [] },
        verifyExecutableSurface: async () => undefined,
      }),
    ).rejects.toMatchObject<RemoteCliPinError>({ code: "server-closure-diff" });
    expect(directoryShows).toEqual([]);
  });

  it.each(["cts", "cjs"])(
    "tracks extensionless directory imports resolved through index.%s",
    async (extension) => {
      const root = fixture();
      write(root, "apps/server/vite.config.ts", "import '../../scripts/lib';\n");
      write(root, "apps/server/scripts/cli.ts", "export const cli = true;\n");
      const indexedPath = `scripts/lib/index.${extension}`;
      write(root, indexedPath, "export const indexed = true;\n");
      const git = baselineGit(root);
      write(root, indexedPath, "export const indexed = false;\n");

      await expect(
        verifyRemoteCliPin({
          rootDir: root,
          git,
          distIntegrity: INTEGRITY,
          attestation: { attestations: [] },
          verifyExecutableSurface: async () => undefined,
        }),
      ).rejects.toMatchObject<RemoteCliPinError>({ code: "server-closure-diff" });
    },
  );

  it.each([
    [
      "dynamic import",
      "void import(`../../scripts/lib/build.ts`);\n",
      "apps/server/vite.config.ts",
    ],
    ["require", "void require(`../../../scripts/lib/build.ts`);\n", "apps/server/scripts/cli.ts"],
  ])("tracks literal-backtick %s dependencies", async (_name, source, importer) => {
    const root = fixture();
    write(root, importer, source);
    const git = baselineGit(root);
    write(root, "scripts/lib/build.ts", "export const build = false;\n");

    await expect(
      verifyRemoteCliPin({
        rootDir: root,
        git,
        distIntegrity: INTEGRITY,
        attestation: { attestations: [] },
        verifyExecutableSurface: async () => undefined,
      }),
    ).rejects.toMatchObject<RemoteCliPinError>({ code: "server-closure-diff" });
  });

  it.each([
    ["interpolated", "void import(`../../scripts/lib/${name}.ts`);\n"],
    ["multiline interpolated", "void import(`../../scripts/lib/${\nname}.ts`);\n"],
    ["escaped", "void import(`../../scripts/lib/build\\\\x2Ets`);\n"],
  ])("fails closed for %s template build imports", async (_name, source) => {
    const root = fixture();
    write(root, "apps/server/vite.config.ts", source);
    await expect(check(root)).rejects.toMatchObject<RemoteCliPinError>({
      code: "server-closure-diff",
    });
  });

  it("tracks reachable build imports separated by JavaScript comments", async () => {
    const root = fixture();
    write(
      root,
      "apps/server/vite.config.ts",
      "import/* graph comments are valid here */{build}from'../../scripts/lib/build.ts';\n",
    );
    write(root, "apps/server/scripts/cli.ts", "export const cli = true;\n");
    const git = baselineGit(root);
    write(root, "scripts/lib/build.ts", "export const build = false;\n");

    await expect(
      verifyRemoteCliPin({
        rootDir: root,
        git,
        distIntegrity: INTEGRITY,
        attestation: { attestations: [] },
        verifyExecutableSurface: async () => undefined,
      }),
    ).rejects.toMatchObject<RemoteCliPinError>({ code: "server-closure-diff" });
  });

  it("tracks reachable build requires separated by JavaScript comments", async () => {
    const root = fixture();
    write(root, "apps/server/vite.config.ts", "export default {};\n");
    write(
      root,
      "apps/server/scripts/cli.ts",
      "const { build } = require/* graph comments are valid here */('../../../scripts/lib/build.ts');\n",
    );
    const git = baselineGit(root);
    write(root, "scripts/lib/build.ts", "export const build = false;\n");

    await expect(
      verifyRemoteCliPin({
        rootDir: root,
        git,
        distIntegrity: INTEGRITY,
        attestation: { attestations: [] },
        verifyExecutableSurface: async () => undefined,
      }),
    ).rejects.toMatchObject<RemoteCliPinError>({ code: "server-closure-diff" });
  });

  it("rejects shallow repositories before trusting a tag", async () => {
    const root = fixture();
    const git: GitRunner = async (args) => {
      if (args[0] === "rev-parse" && args[1] === "--is-shallow-repository") return "true\n";
      throw new Error("unexpected git command");
    };
    await expect(
      verifyRemoteCliPin({ rootDir: root, git }),
    ).rejects.toMatchObject<RemoteCliPinError>({
      code: "shallow-repository",
    });
  });

  it("rejects a tag that is not an ancestor of HEAD", async () => {
    const root = fixture();
    const git: GitRunner = async (args) => {
      if (args[0] === "rev-parse" && args[1] === "--is-shallow-repository") return "false\n";
      if (args[0] === "rev-parse" && args[1] === "--verify") return "deadbeef\n";
      if (args[0] === "merge-base") throw new Error("not an ancestor");
      throw new Error("unexpected git command");
    };
    await expect(
      verifyRemoteCliPin({ rootDir: root, git }),
    ).rejects.toMatchObject<RemoteCliPinError>({
      code: "tag-not-ancestor",
    });
  });

  it("fetches a missing upstream tag into an isolated ref", async () => {
    const root = fixture();
    const calls: string[][] = [];
    const delegate = baselineGit(root);
    let fetched = false;
    const git: GitRunner = async (args) => {
      calls.push([...args]);
      if (
        args[0] === "rev-parse" &&
        args[1] === "--verify" &&
        args[2] === "refs/tags/v0.0.1^{commit}"
      ) {
        throw new Error("missing local tag");
      }
      if (
        args[0] === "rev-parse" &&
        args[1] === "--verify" &&
        args[2] === "refs/pin-check/upstream/v0.0.1^{commit}" &&
        !fetched
      ) {
        throw new Error("missing isolated tag");
      }
      if (args[0] === "fetch") fetched = true;
      return delegate(args);
    };
    await expect(
      verifyRemoteCliPin({
        rootDir: root,
        git,
        distIntegrity: INTEGRITY,
        attestation: { attestations: [] },
        verifyExecutableSurface: async () => undefined,
      }),
    ).resolves.toMatchObject({ packageVersion: "0.0.1" });
    expect(calls).toContainEqual([
      "fetch",
      "--no-tags",
      "upstream",
      "refs/tags/v0.0.1:refs/pin-check/upstream/v0.0.1",
    ]);
    expect(calls.some((args) => args[0] === "update-ref")).toBe(false);
  });

  it("includes historical closure paths so a deleted pinned file trips", async () => {
    const root = fixture();
    const delegate = baselineGit(root);
    const git: GitRunner = async (args) => {
      if (
        args[0] === "cat-file" &&
        args[1] === "-t" &&
        args[2] === "v0.0.1:apps/server/deleted.ts"
      ) {
        return "blob\n";
      }
      if (args[0] === "ls-tree" && args.includes("apps/server")) {
        return "apps/server/deleted.ts\napps/server/package.json\n";
      }
      if (args[0] === "show" && args[1] === "v0.0.1:apps/server/deleted.ts") {
        return "export const old = true;\n";
      }
      return delegate(args);
    };
    await expect(
      verifyRemoteCliPin({
        rootDir: root,
        git,
        distIntegrity: INTEGRITY,
        attestation: { attestations: [] },
        verifyExecutableSurface: async () => undefined,
      }),
    ).rejects.toMatchObject<RemoteCliPinError>({ code: "server-closure-diff" });
  });

  it("refuses an integrity change when the upstream tag did not change", async () => {
    const root = fixture();
    const delegate = baselineGit(root);
    const previous = JSON.stringify({
      upstreamTag: "v0.0.1",
      packageSpec: "t3@0.0.1",
      tarballIntegrity:
        "sha512-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB==",
    });
    const git: GitRunner = async (args) => {
      if (
        args[0] === "show" &&
        args[1]?.includes("apps/desktop/src-tauri/remote-cli.json")
      ) {
        return previous;
      }
      return delegate(args);
    };
    await expect(
      verifyRemoteCliPin({ rootDir: root, git, integrityBaseRef: "HEAD^" }),
    ).rejects.toMatchObject<RemoteCliPinError>({
      code: "integrity-tag-mismatch",
    });
  });

  it("t2: normalizes the four release manifest versions", async () => {
    const root = fixture();
    write(
      root,
      "apps/server/package.json",
      JSON.stringify(
        {
          name: "t3",
          version: "9.9.9",
          dependencies: {},
          devDependencies: { "@t3tools/contracts": "workspace:*" },
        },
        null,
        2,
      ),
    );
    write(
      root,
      "apps/desktop/package.json",
      JSON.stringify({ name: "@t3tools/desktop", version: "9.9.9", dependencies: {} }, null, 2),
    );
    write(
      root,
      "apps/web/package.json",
      JSON.stringify({ name: "@t3tools/web", version: "9.9.9" }, null, 2),
    );
    write(
      root,
      "packages/contracts/package.json",
      JSON.stringify({ name: "@t3tools/contracts", version: "9.9.9" }, null, 2),
    );
    await expect(check(root)).resolves.toMatchObject({ packageVersion: "0.0.1" });
  });

  it("ignores worktree line-ending conversion", async () => {
    const root = fixture();
    const git = baselineGit(root);
    const generatedPath = NodePath.join(root, "packages/contracts/src/index.ts");
    NodeFS.writeFileSync(
      generatedPath,
      NodeFS.readFileSync(generatedPath, "utf8").replaceAll("\n", "\r\n"),
    );

    await expect(
      verifyRemoteCliPin({
        rootDir: root,
        git,
        distIntegrity: INTEGRITY,
        attestation: { attestations: [] },
        verifyExecutableSurface: async () => undefined,
      }),
    ).resolves.toMatchObject({ packageVersion: "0.0.1" });
  });

  it.each([
    [
      "contracts source",
      (root: string) =>
        write(root, "packages/contracts/src/index.ts", "export const contract = 'changed';\n"),
    ],
    [
      "reachable lock entry",
      (root: string) =>
        write(
          root,
          "pnpm-lock.yaml",
          NodeFS.readFileSync(NodePath.join(root, "pnpm-lock.yaml"), "utf8").replace(
            "link:../../packages/contracts",
            "link:../../packages/contracts?changed",
          ),
        ),
    ],
    [
      "transitive build script",
      (root: string) => write(root, "scripts/lib/build.ts", "export const build = false;\n"),
    ],
  ] satisfies ReadonlyArray<readonly [string, (root: string) => void]>)(
    "t3: trips on %s",
    async (_label: string, mutate: (root: string) => void) => {
      const root = fixture();
      const git = baselineGit(root);
      mutate(root);
      await expect(
        verifyRemoteCliPin({
          rootDir: root,
          git,
          distIntegrity: INTEGRITY,
          attestation: { attestations: [] },
          verifyExecutableSurface: async () => undefined,
        }),
      ).rejects.toMatchObject<RemoteCliPinError>({ code: "server-closure-diff" });
    },
  );
});

describe("remote CLI provenance policy", () => {
  it("requires the exact issuer, workflow identities, and certificate OIDs", () => {
    expect(buildProvenancePolicy("v0.0.1", "deadbeef")).toEqual({
      certificateIssuer: "https://token.actions.githubusercontent.com",
      certificateIdentityURI:
        "^https://github\\.com/pingdotgg\\/t3code/\\.github/workflows/release\\.yml@refs/(?:heads/main|tags/v0\\.0\\.1)$",
      certificateOIDs: {
        "1.3.6.1.4.1.57264.1.12": "https://github.com/pingdotgg/t3code",
        "1.3.6.1.4.1.57264.1.13": "deadbeef",
      },
    });
  });

  const validStatement = () => ({
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: "t3-0.0.1.tgz", digest: { sha512: "0".repeat(128) } }],
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: {
            repository: "https://github.com/pingdotgg/t3code",
            path: ".github/workflows/release.yml",
            ref: "refs/heads/main",
          },
        },
        resolvedDependencies: [{ digest: { gitCommit: "deadbeef" } }],
      },
    },
  });

  const provenanceCheck = (
    root: string,
    statement: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ) => {
    const pinPath = NodePath.join(root, "apps/desktop/src-tauri/remote-cli.json");
    const pin = JSON.parse(NodeFS.readFileSync(pinPath, "utf8")) as Record<string, unknown>;
    delete pin.tarballIntegrity;
    NodeFS.writeFileSync(pinPath, JSON.stringify(pin, null, 2));
    return verifyRemoteCliPin({
      rootDir: root,
      git: baselineGit(root),
      distIntegrity: INTEGRITY,
      attestation: {
        attestations: [
          {
            predicateType: "https://slsa.dev/provenance/v1",
            ...extra,
          },
        ],
      },
      verifyProvenance: async () => ({
        status: "attested" as const,
        statement,
        certificateIdentity:
          "https://github.com/pingdotgg/t3code/.github/workflows/release.yml@refs/heads/main",
      }),
      verifyExecutableSurface: async () => undefined,
    });
  };

  it("accepts a statement bound to npm integrity, workflow, ref, and tag commit", async () => {
    const root = fixture();
    await expect(provenanceCheck(root, validStatement())).resolves.toMatchObject({
      provenance: { status: "attested" },
    });
  });

  it("requires the verified signer SAN instead of attestation metadata", async () => {
    const root = fixture();
    const pinPath = NodePath.join(root, "apps/desktop/src-tauri/remote-cli.json");
    const pin = JSON.parse(NodeFS.readFileSync(pinPath, "utf8")) as Record<string, unknown>;
    delete pin.tarballIntegrity;
    NodeFS.writeFileSync(pinPath, JSON.stringify(pin, null, 2));
    await expect(
      verifyRemoteCliPin({
        rootDir: root,
        git: baselineGit(root),
        distIntegrity: INTEGRITY,
        attestation: {
          attestations: [{ predicateType: "https://slsa.dev/provenance/v1" }],
        },
        verifyProvenance: async () =>
          ({
            status: "attested",
            statement: validStatement(),
          }) as never,
        verifyExecutableSurface: async () => undefined,
      }),
    ).rejects.toMatchObject<RemoteCliPinError>({ code: "identity-mismatch" });
  });

  it("rejects nested workflow claims when the structured SLSA path is missing", async () => {
    const root = fixture();
    const statement = validStatement();
    delete (statement.predicate as Record<string, unknown>).buildDefinition;
    (statement as Record<string, unknown>).workflow = {
      repository: "https://github.com/pingdotgg/t3code",
      path: ".github/workflows/release.yml",
      ref: "refs/heads/main",
    };
    await expect(provenanceCheck(root, statement)).rejects.toMatchObject<RemoteCliPinError>({
      code: "invalid-attestation",
    });
  });

  it("decodes the npm DSSE payload from the selected SLSA fixture", () => {
    const statement = validStatement();
    const payload = Buffer.from(JSON.stringify(statement)).toString("base64");
    expect(
      decodeSlsaProvenanceStatement({
        attestations: [
          {
            predicateType: "https://slsa.dev/provenance/v1",
            bundle: { dsseEnvelope: { payload } },
          },
        ],
      }),
    ).toEqual(statement);
  });

  it.each([
    [
      "subject",
      (statement: Record<string, unknown>) => {
        statement.subject = [{ digest: { sha512: "f".repeat(128) } }];
      },
      "subject-mismatch",
    ],
    [
      "workflow",
      (statement: Record<string, unknown>) => {
        const predicate = statement.predicate as Record<string, unknown>;
        const buildDefinition = predicate.buildDefinition as Record<string, unknown>;
        const parameters = buildDefinition.externalParameters as Record<string, unknown>;
        parameters.workflow = {
          repository: "https://example.test",
          path: ".github/workflows/release.yml",
          ref: "refs/heads/main",
        };
      },
      "workflow-mismatch",
    ],
    [
      "ref",
      (statement: Record<string, unknown>) => {
        const predicate = statement.predicate as Record<string, unknown>;
        const buildDefinition = predicate.buildDefinition as Record<string, unknown>;
        const parameters = buildDefinition.externalParameters as Record<string, unknown>;
        (parameters.workflow as Record<string, unknown>).ref = "refs/tags/v0.0.2";
      },
      "workflow-ref-mismatch",
    ],
    [
      "commit",
      (statement: Record<string, unknown>) => {
        const predicate = statement.predicate as Record<string, unknown>;
        const buildDefinition = predicate.buildDefinition as Record<string, unknown>;
        (buildDefinition.resolvedDependencies as Array<Record<string, unknown>>)[0] = {
          digest: { gitCommit: "badc0de" },
        };
      },
      "commit-mismatch",
    ],
  ] satisfies ReadonlyArray<
    readonly [string, (statement: Record<string, unknown>) => void, string]
  >)(
    "rejects a wrong %s claim",
    async (_name: string, mutate: (statement: Record<string, unknown>) => void, code: string) => {
      const root = fixture();
      const statement = validStatement();
      mutate(statement);
      await expect(provenanceCheck(root, statement)).rejects.toMatchObject<RemoteCliPinError>({
        code,
      });
    },
  );

  it.each([
    ["issuer", { certificateIssuer: "https://example.test" }, "issuer-mismatch"],
    [
      "identity",
      {
        certificateIdentityURI:
          "https://github.com/other/repo/.github/workflows/release.yml@refs/heads/main",
      },
      "identity-mismatch",
    ],
    [
      "OID",
      {
        certificateOIDs: {
          "1.3.6.1.4.1.57264.1.12": "https://github.com/pingdotgg/t3code",
          "1.3.6.1.4.1.57264.1.13": "badc0de",
        },
      },
      "certificate-oid-mismatch",
    ],
  ] satisfies ReadonlyArray<readonly [string, Record<string, unknown>, string]>)(
    "rejects a wrong certificate %s",
    async (_name: string, extra: Record<string, unknown>, code: string) => {
      const root = fixture();
      await expect(
        provenanceCheck(root, validStatement(), extra),
      ).rejects.toMatchObject<RemoteCliPinError>({
        code,
      });
    },
  );

  it("rejects an unattested fallback with a changed recorded integrity", async () => {
    const root = fixture();
    await expect(
      verifyRemoteCliPin({
        rootDir: root,
        git: baselineGit(root),
        distIntegrity:
          "sha512-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB==",
        attestation: { attestations: [] },
        verifyExecutableSurface: async () => undefined,
      }),
    ).rejects.toMatchObject<RemoteCliPinError>({ code: "integrity-mismatch" });
  });

  it("records and verifies an unattested fallback only with --record", async () => {
    const root = fixture();
    const pinPath = NodePath.join(root, "apps/desktop/src-tauri/remote-cli.json");
    const pin = JSON.parse(NodeFS.readFileSync(pinPath, "utf8")) as Record<string, unknown>;
    delete pin.tarballIntegrity;
    NodeFS.writeFileSync(pinPath, JSON.stringify(pin, null, 2));
    let surfaceCalls = 0;
    await expect(
      verifyRemoteCliPin({
        rootDir: root,
        git: baselineGit(root),
        record: true,
        distIntegrity: INTEGRITY,
        attestation: { attestations: [] },
        verifyExecutableSurface: async () => {
          surfaceCalls += 1;
        },
      }),
    ).resolves.toMatchObject({ provenance: { status: "unattested" } });
    expect(surfaceCalls).toBe(1);
    expect(JSON.parse(NodeFS.readFileSync(pinPath, "utf8"))).toMatchObject({
      tarballIntegrity: INTEGRITY,
    });
  });
});

describe("remote CLI executable surface", () => {
  it("accepts generated untracked dist files selected by the package manifest", async () => {
    const packageManifest = JSON.stringify({
      name: "t3",
      version: "0.0.1",
      bin: { t3: "dist/t3.js" },
      files: ["dist"],
    });
    const tarBytes = NodeBuffer.Buffer.concat([
      tarEntry("package/package.json", `${packageManifest}\n`),
      tarEntry("package/dist/t3.js", "#!/usr/bin/env node\n"),
      NodeBuffer.Buffer.alloc(1024),
    ]);
    const compressedBytes = NodeZlib.gzipSync(tarBytes);
    const validIntegrity = `sha512-${NodeCrypto.createHash("sha512").update(compressedBytes).digest("base64")}`;
    const packed = packedFixture(validIntegrity, { trackedDist: false });

    await expect(
      runWithDefaultSurface(packed.root, packed.archivePath, packed.git, validIntegrity),
    ).resolves.toMatchObject({ packageVersion: "0.0.1" });
  });

  it("rejects a tar entry outside the pinned package surface", async () => {
    const packageManifest = JSON.stringify({
      name: "t3",
      version: "0.0.1",
      bin: { t3: "dist/t3.js" },
      files: ["dist"],
    });
    const tarBytes = NodeBuffer.Buffer.concat([
      tarEntry("package/package.json", `${packageManifest}\n`),
      tarEntry("package/dist/t3.js", "#!/usr/bin/env node\n"),
      tarEntry("package/unexpected.txt", "must not ship\n"),
      NodeBuffer.Buffer.alloc(1024),
    ]);
    const compressedBytes = NodeZlib.gzipSync(tarBytes);
    const validIntegrity = `sha512-${NodeCrypto.createHash("sha512").update(compressedBytes).digest("base64")}`;
    const packed = packedFixture(validIntegrity, {
      trackedDist: false,
      extraTarEntries: [{ path: "unexpected.txt", content: "must not ship\n" }],
    });

    await expect(
      runWithDefaultSurface(packed.root, packed.archivePath, packed.git, validIntegrity),
    ).rejects.toMatchObject<RemoteCliPinError>({ code: "surface-mismatch" });
  });

  it("compares generated binary files byte-for-byte", async () => {
    const binary = new Uint8Array([0x00, 0xff, 0x80, 0xc3, 0x28, 0x00]);
    const packageManifest = JSON.stringify({
      name: "t3",
      version: "0.0.1",
      bin: { t3: "dist/t3.js" },
      files: ["dist"],
    });
    const tarBytes = NodeBuffer.Buffer.concat([
      tarEntry("package/package.json", `${packageManifest}\n`),
      tarEntry("package/dist/t3.js", "#!/usr/bin/env node\n"),
      tarEntry("package/dist/icon.ico", binary),
      NodeBuffer.Buffer.alloc(1024),
    ]);
    const compressedBytes = NodeZlib.gzipSync(tarBytes);
    const validIntegrity = `sha512-${NodeCrypto.createHash("sha512").update(compressedBytes).digest("base64")}`;
    const packed = packedFixture(validIntegrity, {
      trackedDist: false,
      localBuildFiles: [{ path: "icon.ico", content: binary }],
    });

    await expect(
      runWithDefaultSurface(packed.root, packed.archivePath, packed.git, validIntegrity),
    ).resolves.toMatchObject({ packageVersion: "0.0.1" });
  });

  it("checks compressed npm-pack integrity through the default verifier", async () => {
    const packageManifest = JSON.stringify({
      name: "t3",
      version: "0.0.1",
      bin: { t3: "dist/t3.js" },
      files: ["dist"],
    });
    const tarBytes = NodeBuffer.Buffer.concat([
      tarEntry("package/package.json", `${packageManifest}\n`),
      tarEntry("package/dist/t3.js", "#!/usr/bin/env node\n"),
      NodeBuffer.Buffer.alloc(1024),
    ]);
    const compressedBytes = NodeZlib.gzipSync(tarBytes);
    const validIntegrity = `sha512-${NodeCrypto.createHash("sha512").update(compressedBytes).digest("base64")}`;
    const valid = packedFixture(validIntegrity);
    await expect(
      runWithDefaultSurface(valid.root, valid.archivePath, valid.git, validIntegrity),
    ).resolves.toMatchObject({ packageVersion: "0.0.1" });

    const wrongIntegrity = `sha512-${NodeCrypto.createHash("sha512").update("wrong").digest("base64")}`;
    const wrong = packedFixture(wrongIntegrity);
    await expect(
      runWithDefaultSurface(wrong.root, wrong.archivePath, wrong.git, wrongIntegrity),
    ).rejects.toMatchObject<RemoteCliPinError>({ code: "integrity-mismatch" });
  });
});
