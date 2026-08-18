#!/usr/bin/env node

/**
 * Verify the immutable source pin used by the Tauri SSH runner.
 *
 * This checker intentionally has no dependency on the registry or sigstore at
 * module load time.  CI supplies those boundaries (and tests replace them),
 * while a local run uses git/npm/fetch and reports a useful error when the
 * optional sigstore package has not been installed.
 */

const NodeChildProcess = await import("node:child_process");
const NodeCrypto = await import("node:crypto");
const NodeBuffer = await import("node:buffer");
const NodeZlib = await import("node:zlib");
const NodeFS = await import("node:fs");
const NodeOS = await import("node:os");
const NodePath = await import("node:path");
import { parse as parseYaml } from "yaml";

type NodeBufferType = ReturnType<typeof NodeBuffer.Buffer.from>;

const DEFAULT_REMOTE_CLI_PATH = "apps/desktop/src-tauri/remote-cli.json";
const DEFAULT_UPSTREAM_REMOTE = "upstream";
const UPSTREAM_REPOSITORY = "pingdotgg/t3code";
const UPSTREAM_WORKFLOW_PATH = ".github/workflows/release.yml";
const SLSA_PROVENANCE_PREDICATE = "https://slsa.dev/provenance/v1";
const SIGSTORE_ISSUER = "https://token.actions.githubusercontent.com";
const SOURCE_REPOSITORY_OID = "1.3.6.1.4.1.57264.1.12";
const SOURCE_COMMIT_OID = "1.3.6.1.4.1.57264.1.13";
const VERSION_MANIFESTS = new Set([
  "apps/server/package.json",
  "apps/desktop/package.json",
  "apps/web/package.json",
  "packages/contracts/package.json",
]);
const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;
const EXCLUDED_WORKSPACE_PACKAGES = new Set(["@t3tools/web"]);
const STABLE_VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const NIGHTLY_VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-nightly\.\d{8}\.[1-9]\d*$/;

export type RemoteCliPin = {
  readonly upstreamTag: string;
  readonly packageSpec: string;
  readonly tarballIntegrity?: string;
};

export type GitRunner = (args: ReadonlyArray<string>) => Promise<string>;

export type ProvenancePolicy = {
  readonly certificateIssuer: string;
  readonly certificateIdentityURI: string;
  readonly certificateOIDs: Readonly<Record<string, string>>;
};

export type ProvenanceVerificationInput = {
  readonly packageName: string;
  readonly packageVersion: string;
  readonly upstreamTag: string;
  readonly tagCommit: string;
  readonly distIntegrity: string;
  readonly attestation: unknown;
  readonly policy: ProvenancePolicy;
};

export type ProvenanceResult =
  | {
      readonly status: "attested";
      readonly statement?: unknown;
      readonly certificateIdentity: string;
    }
  | {
      readonly status: "unattested";
      readonly reason?: string;
    };

export type ExecutableSurfaceInput = {
  readonly rootDir: string;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly upstreamTag: string;
  readonly expectedIntegrity: string;
  /** Expected npm-pack paths derived from the pinned tag's manifest/tree. */
  readonly expectedFiles?: ReadonlyArray<string>;
  /** Paths produced by the local tag build; each must be present in npm pack. */
  readonly localBuildFiles?: ReadonlyArray<string>;
  /** Optional exact bytes for local-build files, keyed by package path. */
  readonly localBuildContent?: Readonly<Record<string, string | Uint8Array>>;
};

export type RemoteCliPinCheckerOptions = {
  readonly rootDir?: string;
  readonly remoteCliPath?: string;
  readonly upstreamRemote?: string;
  readonly record?: boolean;
  readonly git?: GitRunner;
  readonly fetch?: typeof globalThis.fetch;
  readonly verifyProvenance?: (input: ProvenanceVerificationInput) => Promise<ProvenanceResult>;
  readonly verifyExecutableSurface?: (input: ExecutableSurfaceInput) => Promise<void>;
  /** Test-only registry metadata. If omitted, package metadata is fetched. */
  readonly distIntegrity?: string;
  /** Test-only attestation response. If omitted, the npm attestation endpoint is fetched. */
  readonly attestation?: unknown;
  /** Immutable CI base ref used to compare a changed integrity pin. */
  readonly integrityBaseRef?: string;
};

export type ServerClosure = {
  readonly workspacePackages: ReadonlySet<string>;
  readonly files: ReadonlySet<string>;
  readonly lockSubset: unknown;
};

export type RemoteCliPinCheckResult = {
  readonly pin: RemoteCliPin;
  readonly packageVersion: string;
  readonly tagCommit: string;
  readonly closure: ServerClosure;
  readonly provenance: ProvenanceResult;
};

export class RemoteCliPinError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RemoteCliPinError";
    this.code = code;
  }
}

type JsonObject = { [key: string]: unknown };
type WorkspacePackage = {
  readonly name: string;
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly manifest: JsonObject;
};
type LockDocument = JsonObject & {
  readonly importers?: JsonObject;
  readonly packages?: JsonObject;
  readonly snapshots?: JsonObject;
};

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asRecord = (value: unknown): JsonObject => (isObject(value) ? value : {});

const readJson = (filePath: string): JsonObject => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(NodeFS.readFileSync(filePath, "utf8")) as unknown;
  } catch (cause) {
    throw new RemoteCliPinError(
      "invalid-json",
      `Unable to read JSON '${filePath}': ${String(cause)}`,
    );
  }
  if (!isObject(parsed)) {
    throw new RemoteCliPinError("invalid-json", `Expected an object in '${filePath}'.`);
  }
  return parsed;
};

const readYaml = (filePath: string): JsonObject => {
  let parsed: unknown;
  try {
    parsed = parseYaml(NodeFS.readFileSync(filePath, "utf8")) as unknown;
  } catch (cause) {
    throw new RemoteCliPinError(
      "invalid-yaml",
      `Unable to read YAML '${filePath}': ${String(cause)}`,
    );
  }
  return asRecord(parsed);
};

const normalizeRelativePath = (value: string): string => value.replaceAll("\\", "/");

const isRemoteTag = (tag: string): boolean =>
  tag.startsWith("v") &&
  (STABLE_VERSION_PATTERN.test(tag.slice(1)) || NIGHTLY_VERSION_PATTERN.test(tag.slice(1)));

const versionFromTag = (tag: string): string => {
  if (!isRemoteTag(tag)) {
    throw new RemoteCliPinError("invalid-tag", `Invalid upstream release tag '${tag}'.`);
  }
  return tag.replace(/^(?:nightly-)?v/, "");
};

const parsePin = (value: unknown, filePath: string): RemoteCliPin => {
  if (!isObject(value)) {
    throw new RemoteCliPinError("invalid-pin", `Expected an object in '${filePath}'.`);
  }
  const keys = Object.keys(value).toSorted();
  const allowed = ["packageSpec", "tarballIntegrity", "upstreamTag"];
  if (keys.some((key) => !allowed.includes(key))) {
    throw new RemoteCliPinError("invalid-pin", `Unknown key in '${filePath}'.`);
  }
  if (typeof value.upstreamTag !== "string" || !isRemoteTag(value.upstreamTag)) {
    throw new RemoteCliPinError("invalid-tag", `Invalid upstreamTag in '${filePath}'.`);
  }
  const expectedVersion = versionFromTag(value.upstreamTag);
  if (
    typeof value.packageSpec !== "string" ||
    value.packageSpec !== `t3@${expectedVersion}` ||
    !/^t3@(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-nightly\.\d{8}\.[1-9]\d*)?$/.test(
      value.packageSpec,
    )
  ) {
    throw new RemoteCliPinError(
      "invalid-package-spec",
      `packageSpec must equal 't3@${expectedVersion}' for upstreamTag '${value.upstreamTag}'.`,
    );
  }
  if (value.tarballIntegrity !== undefined) {
    if (
      typeof value.tarballIntegrity !== "string" ||
      !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(value.tarballIntegrity)
    ) {
      throw new RemoteCliPinError(
        "invalid-integrity",
        "tarballIntegrity must be an SRI sha512 value.",
      );
    }
  }
  return {
    upstreamTag: value.upstreamTag,
    packageSpec: value.packageSpec,
    ...(value.tarballIntegrity === undefined ? {} : { tarballIntegrity: value.tarballIntegrity }),
  };
};

const readPin = (rootDir: string, remoteCliPath: string): RemoteCliPin => {
  const filePath = NodePath.resolve(rootDir, remoteCliPath);
  if (!NodeFS.existsSync(filePath)) {
    throw new RemoteCliPinError("missing-pin", `Missing remote CLI pin '${filePath}'.`);
  }
  return parsePin(readJson(filePath), filePath);
};

const assertIntegrityTagCoupling = async (
  pin: RemoteCliPin,
  remoteCliPath: string,
  git: GitRunner,
  baseRef?: string,
): Promise<void> => {
  const effectiveBaseRef =
    baseRef ??
    (process.env.GITHUB_BASE_REF ? `refs/remotes/origin/${process.env.GITHUB_BASE_REF}` : "HEAD^");
  const baseCommit =
    baseRef === undefined
      ? effectiveBaseRef
      : await gitMay(git, ["rev-parse", "--verify", `${effectiveBaseRef}^{commit}`]);
  if (baseRef !== undefined && !baseCommit?.trim()) {
    throw new RemoteCliPinError(
      "integrity-base-missing",
      `Unable to resolve immutable integrity comparison base '${baseRef}'.`,
    );
  }
  const previousText = await gitMay(git, [
    "show",
    `${(baseCommit ?? effectiveBaseRef).trim()}:${remoteCliPath}`,
  ]);
  if (previousText === undefined) return;
  let previous: RemoteCliPin;
  try {
    previous = parsePin(JSON.parse(previousText) as unknown, remoteCliPath);
  } catch {
    return;
  }
  if (
    previous.upstreamTag === pin.upstreamTag &&
    previous.tarballIntegrity !== pin.tarballIntegrity
  ) {
    throw new RemoteCliPinError(
      "integrity-tag-mismatch",
      "tarballIntegrity changed without changing upstreamTag; update the upstream source pin first.",
    );
  }
};

const defaultGitRunner =
  (rootDir: string): GitRunner =>
  async (args) => {
    try {
      return NodeChildProcess.execFileSync("git", [...args], {
        cwd: rootDir,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new RemoteCliPinError("git", `git ${args.join(" ")} failed: ${detail}`);
    }
  };

const runGit = async (git: GitRunner, args: ReadonlyArray<string>): Promise<string> => {
  try {
    return await git(args);
  } catch (cause) {
    throw cause instanceof RemoteCliPinError
      ? cause
      : new RemoteCliPinError("git", `git ${args.join(" ")} failed: ${String(cause)}`);
  }
};

const gitMay = async (git: GitRunner, args: ReadonlyArray<string>): Promise<string | undefined> => {
  try {
    return await git(args);
  } catch {
    return undefined;
  }
};

const assertTagAndHistory = async (
  rootDir: string,
  tag: string,
  remote: string,
  git: GitRunner,
): Promise<string> => {
  const shallow = (await gitMay(git, ["rev-parse", "--is-shallow-repository"]))?.trim();
  if (shallow === "true") {
    throw new RemoteCliPinError(
      "shallow-repository",
      "The repository is shallow; fetch-depth: 0 is required.",
    );
  }

  const localTagRef = `refs/tags/${tag}`;
  const isolatedTagRef = `refs/pin-check/${remote}/${tag}`;
  let tagCommit = (
    await gitMay(git, ["rev-parse", "--verify", `refs/tags/${tag}^{commit}`])
  )?.trim();
  const hadLocalTag = tagCommit !== undefined && tagCommit.length > 0;
  const upstreamTagCommit = (
    await gitMay(git, ["rev-parse", "--verify", `${isolatedTagRef}^{commit}`])
  )?.trim();
  if (!upstreamTagCommit) {
    await gitMay(git, ["fetch", "--no-tags", remote, `refs/tags/${tag}:${isolatedTagRef}`]);
  }
  const fetchedTagCommit = (
    await gitMay(git, ["rev-parse", "--verify", `${isolatedTagRef}^{commit}`])
  )?.trim();
  if (!tagCommit) tagCommit = fetchedTagCommit;
  if (tagCommit && fetchedTagCommit && tagCommit !== fetchedTagCommit) {
    throw new RemoteCliPinError(
      "tag-mismatch",
      `Local tag '${tag}' does not match upstream tag '${tag}'.`,
    );
  }
  if (!tagCommit) {
    throw new RemoteCliPinError(
      "missing-tag",
      `Upstream tag '${tag}' does not exist locally or on '${remote}'.`,
    );
  }
  const ancestorRef = hadLocalTag ? localTagRef : isolatedTagRef;
  const ancestor = await gitMay(git, ["merge-base", "--is-ancestor", ancestorRef, "HEAD"]);
  if (ancestor === undefined) {
    throw new RemoteCliPinError(
      "tag-not-ancestor",
      `Upstream tag '${tag}' is not an ancestor of HEAD.`,
    );
  }
  return tagCommit;
};

const packageManifest = (packagePath: string): JsonObject =>
  readJson(NodePath.join(packagePath, "package.json"));

const packageDirs = (rootDir: string): ReadonlyArray<string> => {
  const result: string[] = [];
  for (const firstLevel of ["apps", "packages", "infra", "scripts"]) {
    const parent = NodePath.join(rootDir, firstLevel);
    if (!NodeFS.existsSync(parent)) continue;
    for (const entry of NodeFS.readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "node_modules") continue;
      const candidate = NodePath.join(parent, entry.name);
      if (NodeFS.existsSync(NodePath.join(candidate, "package.json"))) result.push(candidate);
    }
  }
  return result;
};

const discoverWorkspacePackages = (rootDir: string): ReadonlyMap<string, WorkspacePackage> => {
  const packages = new Map<string, WorkspacePackage>();
  for (const absolutePath of packageDirs(rootDir)) {
    const manifest = packageManifest(absolutePath);
    if (typeof manifest.name !== "string") continue;
    const relativePath = normalizeRelativePath(NodePath.relative(rootDir, absolutePath));
    packages.set(manifest.name, { name: manifest.name, relativePath, absolutePath, manifest });
  }
  return packages;
};

const dependencyEntries = (manifest: JsonObject): ReadonlyArray<[string, string]> => {
  const entries: Array<[string, string]> = [];
  for (const section of DEPENDENCY_SECTIONS) {
    const dependencies = asRecord(manifest[section]);
    for (const [name, value] of Object.entries(dependencies)) {
      if (typeof value === "string") entries.push([name, value]);
    }
  }
  return entries;
};

const isWorkspaceDependency = (spec: string): boolean => spec.startsWith("workspace:");

const collectWorkspaceClosure = (
  packages: ReadonlyMap<string, WorkspacePackage>,
): ReadonlySet<string> => {
  const closure = new Set<string>();
  const pending = ["t3"];
  while (pending.length > 0) {
    const packageName = pending.pop();
    if (!packageName || closure.has(packageName) || EXCLUDED_WORKSPACE_PACKAGES.has(packageName))
      continue;
    const packageInfo = packages.get(packageName);
    if (!packageInfo) continue;
    closure.add(packageName);
    for (const [dependencyName, spec] of dependencyEntries(packageInfo.manifest)) {
      if (isWorkspaceDependency(spec) && !EXCLUDED_WORKSPACE_PACKAGES.has(dependencyName)) {
        pending.push(dependencyName);
      }
    }
  }
  return closure;
};

const importSpecifierPattern =
  /(?:import\s+(?:[\s\S]*?\s+from\s+)?|export\s+[\s\S]*?\s+from\s+|import\s*\(|require\s*\()(['"])([^'"\n]+)\1/g;

const resolveLocalImport = (
  rootDir: string,
  importer: string,
  specifier: string,
): string | undefined => {
  if (!specifier.startsWith(".")) return undefined;
  const base = NodePath.resolve(NodePath.dirname(importer), specifier);
  const candidates = [
    base,
    ...[".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"].map(
      (extension) => `${base}${extension}`,
    ),
    ...["index.ts", "index.tsx", "index.mts", "index.js", "index.mjs"].map((entry) =>
      NodePath.join(base, entry),
    ),
  ];
  for (const candidate of candidates) {
    if (!NodeFS.existsSync(candidate) || !NodeFS.statSync(candidate).isFile()) continue;
    const relative = normalizeRelativePath(NodePath.relative(rootDir, candidate));
    if (!relative.startsWith("..")) return candidate;
  }
  return undefined;
};

const collectBuildScriptGraph = (rootDir: string): ReadonlySet<string> => {
  const graph = new Set<string>();
  const pending = [
    NodePath.join(rootDir, "apps/server/vite.config.ts"),
    NodePath.join(rootDir, "apps/server/scripts/cli.ts"),
  ];
  while (pending.length > 0) {
    const filePath = pending.pop();
    if (!filePath || graph.has(filePath) || !NodeFS.existsSync(filePath)) continue;
    graph.add(filePath);
    let source: string;
    try {
      source = NodeFS.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    for (const match of source.matchAll(importSpecifierPattern)) {
      const specifier = match[2];
      if (!specifier) continue;
      const imported = resolveLocalImport(rootDir, filePath, specifier);
      if (imported) pending.push(imported);
    }
  }
  return new Set(
    [...graph].map((filePath) => normalizeRelativePath(NodePath.relative(rootDir, filePath))),
  );
};

const listFiles = (rootDir: string, directory: string): ReadonlyArray<string> => {
  const files: string[] = [];
  const visit = (current: string) => {
    for (const entry of NodeFS.readdirSync(current, { withFileTypes: true })) {
      if (
        ["node_modules", ".git", "dist", "dist-electron", ".t3", ".vite-plus"].includes(entry.name)
      )
        continue;
      const full = NodePath.join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) files.push(normalizeRelativePath(NodePath.relative(rootDir, full)));
    }
  };
  if (NodeFS.existsSync(directory)) visit(directory);
  return files;
};

const packageNameFromLockKey = (key: string): string => {
  if (key.startsWith("@")) {
    const slash = key.indexOf("/");
    const at = key.indexOf("@", slash + 1);
    return at < 0 ? key : key.slice(0, at);
  }
  const at = key.indexOf("@");
  return at < 0 ? key : key.slice(0, at);
};

const lockKeysFor = (
  name: string,
  version: string,
  keys: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  if (version.startsWith("link:") || version.startsWith("workspace:")) return [];
  const base = version.split("(", 1)[0] ?? version;
  return keys
    .filter((key) => {
      if (packageNameFromLockKey(key) !== name) return false;
      const separator = key.indexOf("@", name.startsWith("@") ? 1 : 0);
      return separator >= 0 && key.slice(separator + 1).split("(", 1)[0] === base;
    })
    .toSorted();
};

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .toSorted()
      .map((key) => [key, stableValue(value[key])]),
  );
};

const readLock = (rootDir: string): LockDocument => {
  const value = parseYaml(
    NodeFS.readFileSync(NodePath.join(rootDir, "pnpm-lock.yaml"), "utf8"),
  ) as unknown;
  return asRecord(value) as LockDocument;
};

const selectLockSubset = (rootDir: string, workspaceClosure: ReadonlySet<string>): JsonObject => {
  const lock = readLock(rootDir);
  const importers = asRecord(lock.importers);
  const packages = asRecord(lock.packages);
  const snapshots = asRecord(lock.snapshots);
  const selectedImporters: JsonObject = {};
  const dependencyQueue: Array<{ readonly name: string; readonly version: string }> = [];
  const selectedDependencyNames = new Set<string>();
  const selectedPackageKeys = new Set<string>();

  for (const packageName of workspaceClosure) {
    const packageInfo = discoverWorkspacePackages(rootDir).get(packageName);
    if (!packageInfo) continue;
    const importer = asRecord(importers[packageInfo.relativePath]);
    if (Object.keys(importer).length === 0) continue;
    const filteredImporter: JsonObject = {};
    for (const [sectionName, sectionValue] of Object.entries(importer)) {
      const section = asRecord(sectionValue);
      const filtered: JsonObject = {};
      for (const [dependencyName, dependencyValue] of Object.entries(section)) {
        if (dependencyName === "@t3tools/web") continue;
        filtered[dependencyName] = dependencyValue;
        selectedDependencyNames.add(dependencyName);
        const version = asRecord(dependencyValue).version;
        if (typeof version === "string") dependencyQueue.push({ name: dependencyName, version });
      }
      filteredImporter[sectionName] = filtered;
    }
    selectedImporters[packageInfo.relativePath] = filteredImporter;
  }

  const packageKeys = Object.keys(packages);
  const snapshotKeys = Object.keys(snapshots);
  while (dependencyQueue.length > 0) {
    const dependency = dependencyQueue.pop();
    if (!dependency) continue;
    const packageKeysForDependency = lockKeysFor(dependency.name, dependency.version, packageKeys);
    const snapshotKeysForDependency = lockKeysFor(
      dependency.name,
      dependency.version,
      snapshotKeys,
    );
    for (const key of [...packageKeysForDependency, ...snapshotKeysForDependency]) {
      if (selectedPackageKeys.has(key)) continue;
      selectedPackageKeys.add(key);
      const snapshot = asRecord(snapshots[key]);
      for (const sectionName of ["dependencies", "optionalDependencies", "peerDependencies"]) {
        for (const [name, version] of Object.entries(asRecord(snapshot[sectionName]))) {
          if (typeof version === "string") dependencyQueue.push({ name, version });
        }
      }
    }
  }

  const selectedPackages = Object.fromEntries(
    [...selectedPackageKeys]
      .filter((key) => packages[key] !== undefined)
      .toSorted()
      .map((key) => [key, packages[key]]),
  );
  const selectedSnapshots = Object.fromEntries(
    [...selectedPackageKeys]
      .filter((key) => snapshots[key] !== undefined)
      .toSorted()
      .map((key) => [key, snapshots[key]]),
  );
  for (const key of selectedPackageKeys) selectedDependencyNames.add(packageNameFromLockKey(key));
  const workspace = readYaml(NodePath.join(rootDir, "pnpm-workspace.yaml"));
  const catalogs = asRecord(workspace.catalogs);
  const catalog: JsonObject = {};
  for (const [catalogName, catalogValue] of Object.entries(catalogs)) {
    const entries = asRecord(catalogValue);
    const selected = Object.fromEntries(
      Object.entries(entries).filter(([name]) => selectedDependencyNames.has(name)),
    );
    if (Object.keys(selected).length > 0) catalog[catalogName] = selected;
  }
  const legacyCatalog = asRecord(workspace.catalog);
  const selectedLegacyCatalog = Object.fromEntries(
    Object.entries(legacyCatalog).filter(([name]) => selectedDependencyNames.has(name)),
  );
  const patchedDependencies = asRecord(lock.patchedDependencies);
  const selectedPatches = Object.fromEntries(
    Object.entries(patchedDependencies).filter(([key]) => {
      const packageName = packageNameFromLockKey(key);
      return (
        selectedDependencyNames.has(packageName) &&
        [...selectedPackageKeys].some(
          (selectedKey) =>
            packageNameFromLockKey(selectedKey) === packageName &&
            selectedKey.startsWith(
              `${packageName}@${key.slice(packageName.length + 1).split("@", 1)[0]}`,
            ),
        )
      );
    }),
  );
  const lockOverrides = asRecord(lock.overrides);
  const selectedOverrides = Object.fromEntries(
    Object.entries(lockOverrides).filter(([key]) => {
      const packageName = packageNameFromLockKey(key.split(">", 1)[0] ?? key);
      return selectedDependencyNames.has(packageName);
    }),
  );
  return stableValue({
    catalogs: catalog,
    ...(Object.keys(selectedLegacyCatalog).length > 0 ? { catalog: selectedLegacyCatalog } : {}),
    importers: selectedImporters,
    packages: selectedPackages,
    snapshots: selectedSnapshots,
    patchedDependencies: selectedPatches,
    ...(Object.keys(selectedOverrides).length > 0 ? { overrides: selectedOverrides } : {}),
  }) as JsonObject;
};

const normalizeManifestText = (relativePath: string, text: string): string => {
  const normalizedText = text.replaceAll("\r\n", "\n");
  if (!VERSION_MANIFESTS.has(relativePath)) return normalizedText;
  try {
    const value = JSON.parse(normalizedText) as JsonObject;
    if (typeof value.version !== "string") return normalizedText;
    return `${JSON.stringify({ ...value, version: "__RELEASE_VERSION__" }, null, 2)}\n`;
  } catch {
    return normalizedText;
  }
};

const gitFileAt = async (
  git: GitRunner,
  tag: string,
  relativePath: string,
): Promise<string | undefined> => gitMay(git, ["show", `${tag}:${relativePath}`]);

const compareClosureToTag = async (
  rootDir: string,
  tag: string,
  closure: ServerClosure,
  git: GitRunner,
): Promise<ReadonlyArray<string>> => {
  const changed: string[] = [];
  const historicalFiles = await historicalClosurePaths(tag, closure, git);
  for (const relativePath of new Set([...closure.files, ...historicalFiles])) {
    const currentPath = NodePath.join(rootDir, relativePath);
    const current = NodeFS.existsSync(currentPath)
      ? NodeFS.readFileSync(currentPath, "utf8")
      : undefined;
    const previous = await gitFileAt(git, tag, relativePath);
    if (current === undefined || previous === undefined) {
      if (current !== previous) changed.push(relativePath);
      continue;
    }
    if (
      normalizeManifestText(relativePath, current) !== normalizeManifestText(relativePath, previous)
    ) {
      changed.push(relativePath);
    }
  }
  const currentLock = JSON.stringify(closure.lockSubset);
  const tagLock = await gitFileAt(git, tag, "pnpm-lock.yaml");
  if (tagLock === undefined) {
    throw new RemoteCliPinError(
      "missing-historical-lock",
      `The pinned tag '${tag}' has no pnpm-lock.yaml.`,
    );
  }
  const temporaryRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "remote-cli-pin-tag-"));
  try {
    NodeFS.writeFileSync(NodePath.join(temporaryRoot, "pnpm-lock.yaml"), tagLock);
    const tagWorkspace = await materializeTagWorkspace(tag, git, temporaryRoot);
    const tagSubset = selectLockSubset(tagWorkspace, closure.workspacePackages);
    if (currentLock !== JSON.stringify(tagSubset)) changed.push("pnpm-lock.yaml");
  } catch (cause) {
    if (cause instanceof RemoteCliPinError) throw cause;
    throw new RemoteCliPinError(
      "historical-lock",
      `Unable to compute the lock closure at '${tag}': ${String(cause)}`,
    );
  } finally {
    NodeFS.rmSync(temporaryRoot, { recursive: true, force: true });
  }
  return changed;
};

const historicalClosurePaths = async (
  tag: string,
  closure: ServerClosure,
  git: GitRunner,
): Promise<ReadonlySet<string>> => {
  const paths = new Set<string>();
  const tree = await gitMay(git, [
    "ls-tree",
    "-r",
    "--name-only",
    tag,
    "--",
    "apps/server",
    "packages",
    "infra",
    "scripts",
    "vite.config.ts",
  ]);
  const currentPackagePaths = [...closure.files]
    .filter((path) => path.startsWith("packages/"))
    .map((path) => path.split("/").slice(0, 2).join("/"));
  for (const path of (tree ?? "").split(/\r?\n/).map((value) => value.trim())) {
    if (!path) continue;
    if (
      path.startsWith("apps/server/") ||
      currentPackagePaths.some((prefix) => path.startsWith(`${prefix}/`)) ||
      path === "vite.config.ts" ||
      path.startsWith("scripts/")
    ) {
      paths.add(path);
    }
  }
  const patchText = await gitFileAt(git, tag, "pnpm-lock.yaml");
  if (patchText !== undefined) {
    try {
      const lock = asRecord(parseYaml(patchText) as unknown);
      for (const patchPath of Object.values(asRecord(lock.patchedDependencies))) {
        if (typeof patchPath === "string") paths.add(normalizeRelativePath(patchPath));
      }
    } catch {
      throw new RemoteCliPinError("historical-lock", `Unable to parse the lockfile at '${tag}'.`);
    }
  }
  return paths;
};

/**
 * Materialise only the manifests needed to select the historical lock subset.
 * This avoids a checkout and keeps the checker read-only with respect to the
 * caller's worktree.
 */
const materializeTagWorkspace = async (
  tag: string,
  git: GitRunner,
  temporaryRoot: string,
): Promise<string> => {
  const workspaceText = await gitFileAt(git, tag, "pnpm-workspace.yaml");
  if (workspaceText !== undefined)
    NodeFS.writeFileSync(NodePath.join(temporaryRoot, "pnpm-workspace.yaml"), workspaceText);
  const tree = await runGit(git, [
    "ls-tree",
    "-r",
    "--name-only",
    tag,
    "--",
    "apps",
    "packages",
    "infra",
    "scripts",
  ]);
  const paths = tree
    .split(/\r?\n/)
    .map((path) => path.trim())
    .filter((path) => path.endsWith("/package.json"));
  for (const relativePath of paths) {
    const text = await gitFileAt(git, tag, relativePath);
    if (text === undefined) continue;
    const target = NodePath.join(temporaryRoot, relativePath);
    NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
    NodeFS.writeFileSync(target, text);
  }
  const lockText = await gitFileAt(git, tag, "pnpm-lock.yaml");
  if (lockText !== undefined)
    NodeFS.writeFileSync(NodePath.join(temporaryRoot, "pnpm-lock.yaml"), lockText);
  return temporaryRoot;
};

export const computeServerClosure = (rootDir = process.cwd()): ServerClosure => {
  const packages = discoverWorkspacePackages(rootDir);
  const workspacePackages = collectWorkspaceClosure(packages);
  const files = new Set<string>();
  for (const packageName of workspacePackages) {
    const packageInfo = packages.get(packageName);
    if (!packageInfo) continue;
    for (const file of listFiles(rootDir, packageInfo.absolutePath)) files.add(file);
  }
  for (const file of collectBuildScriptGraph(rootDir)) files.add(file);
  const workspace = readYaml(NodePath.join(rootDir, "pnpm-workspace.yaml"));
  const lockSubset = selectLockSubset(rootDir, workspacePackages);
  const selectedPatchKeys = new Set(
    Object.keys(asRecord(asRecord(lockSubset).patchedDependencies)),
  );
  const patched = asRecord(workspace.patchedDependencies);
  for (const [patchKey, patchValue] of Object.entries(patched)) {
    if (!selectedPatchKeys.has(patchKey)) continue;
    const patchPath = patchValue;
    if (typeof patchPath === "string") {
      const relativePath = normalizeRelativePath(patchPath);
      if (NodeFS.existsSync(NodePath.join(rootDir, relativePath))) files.add(relativePath);
    }
  }
  return { workspacePackages, files, lockSubset };
};

export const parseRemoteCliPin = (
  value: unknown,
  filePath = DEFAULT_REMOTE_CLI_PATH,
): RemoteCliPin => parsePin(value, filePath);

const normalizeSRIHex = (integrity: string): string => {
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(integrity.trim());
  if (!match?.[1])
    throw new RemoteCliPinError("invalid-integrity", `Invalid sha512 SRI '${integrity}'.`);
  return NodeBuffer.Buffer.from(match[1], "base64").toString("hex");
};

const recursiveFind = (value: unknown, key: string): ReadonlyArray<unknown> => {
  const result: unknown[] = [];
  if (Array.isArray(value)) {
    for (const entry of value) result.push(...recursiveFind(entry, key));
  } else if (isObject(value)) {
    for (const [entryKey, entryValue] of Object.entries(value)) {
      if (entryKey === key) result.push(entryValue);
      result.push(...recursiveFind(entryValue, key));
    }
  }
  return result;
};

const attestationEntries = (payload: unknown): ReadonlyArray<JsonObject> => {
  const entries: JsonObject[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isObject(value)) return;
    const predicate = value.predicateType ?? asRecord(value.statement).predicateType;
    if (predicate === SLSA_PROVENANCE_PREDICATE) entries.push(value);
    for (const child of Object.values(value)) visit(child);
  };
  visit(payload);
  return entries;
};

const decodeAttestationPayload = (attestation: unknown): NodeBufferType | undefined => {
  for (const candidate of recursiveFind(attestation, "payload")) {
    if (typeof candidate !== "string") continue;
    try {
      const bytes = NodeBuffer.Buffer.from(candidate, "base64");
      const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
      if (isObject(parsed)) return bytes;
    } catch {
      // Continue looking for a plain statement.
    }
  }
  return undefined;
};

const decodeStatement = (attestation: unknown): unknown => {
  const payload = decodeAttestationPayload(attestation);
  if (payload !== undefined) return JSON.parse(payload.toString("utf8")) as unknown;
  for (const candidate of recursiveFind(attestation, "statement")) {
    if (
      isObject(candidate) &&
      (candidate.predicateType !== undefined || candidate.subject !== undefined)
    ) {
      return candidate;
    }
  }
  return undefined;
};

/** Decode the base64 DSSE payload from an npm SLSA attestation for fixture tests. */
export const decodeSlsaProvenanceStatement = (attestation: unknown): unknown =>
  decodeStatement(attestation);

const signerIdentity = (value: unknown): string | undefined => {
  const identity = asRecord(asRecord(value).identity);
  return typeof identity.subjectAlternativeName === "string"
    ? identity.subjectAlternativeName
    : undefined;
};

const assertFixturePolicyFields = (attestation: unknown, policy: ProvenancePolicy): void => {
  const entry = attestationEntries(attestation)[0] ?? asRecord(attestation);
  const issuers = [entry.certificateIssuer].filter(
    (value): value is string => typeof value === "string",
  );
  if (issuers.some((issuer) => issuer !== policy.certificateIssuer)) {
    throw new RemoteCliPinError(
      "issuer-mismatch",
      "Sigstore certificate issuer does not match policy.",
    );
  }
  const identities = [entry.certificateIdentityURI].filter(
    (value): value is string => typeof value === "string",
  );
  if (identities.some((identity) => !new RegExp(policy.certificateIdentityURI).test(identity))) {
    throw new RemoteCliPinError(
      "identity-mismatch",
      "Sigstore certificate identity does not match policy.",
    );
  }
  for (const candidate of [entry.certificateOIDs]) {
    if (!isObject(candidate)) continue;
    for (const [oid, expected] of Object.entries(policy.certificateOIDs)) {
      if (candidate[oid] !== undefined && candidate[oid] !== expected) {
        throw new RemoteCliPinError(
          "certificate-oid-mismatch",
          `Sigstore certificate OID ${oid} does not match policy.`,
        );
      }
    }
  }
};

// Fulcio stores CI claim extensions as DER UTF8String values. sigstore 4.1.1
// compares custom OID policy bytes to the extension's encoded octets, so the
// semantic policy value must be wrapped before it is passed to verify(). Both
// mandatory values are short ASCII strings and therefore use DER's one-byte
// length form.
const encodeFulcioOidPolicyValue = (value: string): string => {
  const bytes = NodeBuffer.Buffer.from(value, "utf8");
  if (bytes.length >= 128 || !bytes.every((byte) => byte < 128)) {
    throw new RemoteCliPinError(
      "invalid-certificate-policy",
      "Fulcio certificate OID policy values must be short ASCII strings.",
    );
  }
  return `${String.fromCharCode(0x0c, bytes.length)}${value}`;
};

const verifyStatement = (
  statement: unknown,
  expected: {
    readonly distIntegrity: string;
    readonly tagCommit: string;
    readonly upstreamTag: string;
    readonly policy: ProvenancePolicy;
  },
  certificateIdentity: string,
): void => {
  if (!isObject(statement))
    throw new RemoteCliPinError(
      "invalid-attestation",
      "Sigstore attestation did not contain a statement.",
    );
  if (statement.predicateType !== SLSA_PROVENANCE_PREDICATE) {
    throw new RemoteCliPinError(
      "predicate-mismatch",
      "Sigstore statement predicateType is not SLSA provenance v1.",
    );
  }
  const subjectEntries = Array.isArray(statement.subject) ? statement.subject.filter(isObject) : [];
  if (subjectEntries.length === 0) {
    throw new RemoteCliPinError("invalid-attestation", "Sigstore statement has no subjects.");
  }
  const expectedHex = normalizeSRIHex(expected.distIntegrity);
  const subjectDigest = subjectEntries
    .map((entry) => asRecord(entry.digest).sha512)
    .find((digest): digest is string => typeof digest === "string");
  if (
    !subjectDigest ||
    (subjectDigest.toLowerCase() !== expectedHex.toLowerCase() &&
      subjectDigest.toLowerCase() !== expected.distIntegrity.toLowerCase())
  ) {
    throw new RemoteCliPinError(
      "subject-mismatch",
      "Sigstore subject sha512 does not match npm dist.integrity.",
    );
  }
  const predicate = asRecord(statement.predicate);
  const buildDefinition = asRecord(predicate.buildDefinition);
  const externalParameters = asRecord(buildDefinition.externalParameters);
  const workflowObject = asRecord(externalParameters.workflow);
  if (
    !isObject(predicate) ||
    !isObject(buildDefinition) ||
    !isObject(externalParameters) ||
    !isObject(externalParameters.workflow)
  ) {
    throw new RemoteCliPinError(
      "invalid-attestation",
      "Sigstore statement is missing the structured SLSA build definition.",
    );
  }
  const repository = workflowObject.repository;
  if (
    (repository !== UPSTREAM_REPOSITORY &&
      repository !== `https://github.com/${UPSTREAM_REPOSITORY}`) ||
    workflowObject.path !== UPSTREAM_WORKFLOW_PATH
  ) {
    throw new RemoteCliPinError(
      "workflow-mismatch",
      "Sigstore workflow does not match the upstream release workflow.",
    );
  }
  const workflowRef = workflowObject.ref;
  if (typeof workflowRef !== "string")
    throw new RemoteCliPinError("workflow-mismatch", "Sigstore statement has no workflow ref.");
  const expectedRefs = new Set(["refs/heads/main", `refs/tags/${expected.upstreamTag}`]);
  if (!expectedRefs.has(workflowRef)) {
    throw new RemoteCliPinError(
      "workflow-ref-mismatch",
      "Sigstore statement workflow ref is not the upstream main or exact release tag ref.",
    );
  }
  const identityRef = certificateIdentity.match(
    /@((?:refs\/heads\/main)|(?:refs\/tags\/[^/]+))$/,
  )?.[1];
  if (identityRef === undefined) {
    throw new RemoteCliPinError(
      "identity-mismatch",
      "Verified Sigstore signer identity has no supported workflow ref.",
    );
  }
  if (identityRef !== workflowRef) {
    throw new RemoteCliPinError(
      "workflow-ref-mismatch",
      "Sigstore certificate identity ref differs from statement workflow ref.",
    );
  }
  const dependencies = buildDefinition.resolvedDependencies;
  if (!Array.isArray(dependencies)) {
    throw new RemoteCliPinError(
      "invalid-attestation",
      "Sigstore statement has no resolvedDependencies array.",
    );
  }
  const commits = dependencies
    .filter(isObject)
    .map((dependency) => asRecord(dependency.digest).gitCommit)
    .filter((value): value is string => typeof value === "string");
  if (!commits.includes(expected.tagCommit)) {
    throw new RemoteCliPinError(
      "commit-mismatch",
      "Sigstore resolved dependency commit does not match the pinned tag commit.",
    );
  }
};

const defaultVerifyProvenance = async (
  input: ProvenanceVerificationInput,
): Promise<ProvenanceResult> => {
  let sigstore: Record<string, unknown>;
  try {
    const packageName: string = "sigstore";
    sigstore = (await import(packageName)) as Record<string, unknown>;
  } catch (cause) {
    throw new RemoteCliPinError(
      "missing-sigstore",
      `sigstore@4.1.1 is required to verify an attested pin; install the pinned dependency (${String(cause)}).`,
    );
  }
  const verify = sigstore.verify;
  if (typeof verify !== "function") {
    throw new RemoteCliPinError("invalid-sigstore", "sigstore@4.1.1 does not expose verify().");
  }
  const selectedAttestation =
    attestationEntries(input.attestation)[0] ?? asRecord(input.attestation);
  const statement = decodeStatement(selectedAttestation);
  const bundle = asRecord(selectedAttestation).bundle ?? selectedAttestation;
  const payload =
    decodeAttestationPayload(selectedAttestation) ??
    (statement === undefined
      ? NodeBuffer.Buffer.alloc(0)
      : NodeBuffer.Buffer.from(JSON.stringify(statement)));
  const verified = await (
    verify as (bundle: unknown, payload: Uint8Array, policy: ProvenancePolicy) => Promise<unknown>
  )(bundle, payload, {
    ...input.policy,
    certificateOIDs: Object.fromEntries(
      Object.entries(input.policy.certificateOIDs).map(([oid, value]) => [
        oid,
        encodeFulcioOidPolicyValue(value),
      ]),
    ),
  });
  const identity = signerIdentity(verified);
  if (identity === undefined) {
    throw new RemoteCliPinError(
      "identity-mismatch",
      "Sigstore verification returned no signer subjectAlternativeName.",
    );
  }
  verifyStatement(statement, input, identity);
  return {
    status: "attested",
    statement,
    certificateIdentity: identity,
  };
};

const fetchJson = async (fetcher: typeof globalThis.fetch, url: string): Promise<unknown> => {
  const response = await fetcher(url, { headers: { accept: "application/json" } });
  if (response.status === 404) return undefined;
  if (!response.ok)
    throw new RemoteCliPinError(
      "registry",
      `Registry request failed (${response.status}) for ${url}.`,
    );
  return (await response.json()) as unknown;
};

const findDistIntegrity = (metadata: unknown): string | undefined => {
  if (!isObject(metadata)) return undefined;
  if (typeof asRecord(metadata.dist).integrity === "string")
    return asRecord(metadata.dist).integrity as string;
  const versions = asRecord(metadata.versions);
  for (const value of Object.values(versions)) {
    if (
      typeof asRecord(value).dist === "object" &&
      typeof asRecord(asRecord(value).dist).integrity === "string"
    ) {
      return asRecord(asRecord(value).dist).integrity as string;
    }
  }
  return undefined;
};

const defaultExecutableSurface = async (input: ExecutableSurfaceInput): Promise<void> => {
  const temporary = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "remote-cli-pin-pack-"));
  try {
    const packageSpec = `${input.packageName}@${input.packageVersion}`;
    const packArguments = [
      "pack",
      packageSpec,
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      temporary,
    ];
    let executable = "npm";
    let executableArguments = packArguments;
    let environment = process.env;
    if (process.platform === "win32") {
      const wrapper = NodePath.join(temporary, "run-npm-pack.cmd");
      NodeFS.writeFileSync(
        wrapper,
        [
          "@echo off",
          'npm pack "%AGENT_NANONI_NPM_PACKAGE_SPEC%" --ignore-scripts --json --pack-destination "%AGENT_NANONI_NPM_PACK_DESTINATION%"',
          "",
        ].join("\r\n"),
      );
      executable = process.env.ComSpec ?? "cmd.exe";
      executableArguments = ["/d", "/s", "/c", "call", wrapper];
      environment = {
        ...process.env,
        AGENT_NANONI_NPM_PACKAGE_SPEC: packageSpec,
        AGENT_NANONI_NPM_PACK_DESTINATION: temporary,
      };
    }
    const output = NodeChildProcess.execFileSync(executable, executableArguments, {
      cwd: input.rootDir,
      encoding: "utf8",
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const metadata = JSON.parse(output) as unknown;
    const integrity = asRecord(Array.isArray(metadata) ? metadata[0] : metadata).integrity;
    if (integrity !== input.expectedIntegrity) {
      throw new RemoteCliPinError(
        "integrity-mismatch",
        "npm pack integrity does not match remote-cli.json.",
      );
    }
    const tarball = asRecord(Array.isArray(metadata) ? metadata[0] : metadata).filename;
    if (typeof tarball !== "string")
      throw new RemoteCliPinError("surface-mismatch", "npm pack returned no tarball filename.");
    const compressedBytes = NodeFS.readFileSync(
      NodePath.isAbsolute(tarball) ? tarball : NodePath.join(temporary, tarball),
    );
    const tarBytes = NodeZlib.gunzipSync(compressedBytes);
    const tarEntries = new Map<string, NodeBufferType>();
    for (let offset = 0; offset + 512 <= tarBytes.length; ) {
      const header = tarBytes.subarray(offset, offset + 512);
      if (header.every((byte) => byte === 0)) break;
      const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
      const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
      const fullName = prefix.length > 0 ? `${prefix}/${name}` : name;
      const sizeText = header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim();
      const size = sizeText.length === 0 ? 0 : Number.parseInt(sizeText, 8);
      if (!Number.isFinite(size) || size < 0)
        throw new RemoteCliPinError("surface-mismatch", "npm pack returned an invalid tar header.");
      tarEntries.set(fullName, tarBytes.subarray(offset + 512, offset + 512 + size));
      offset += 512 + Math.ceil(size / 512) * 512;
    }
    const packageJsonBytes = tarEntries.get("package/package.json");
    if (!packageJsonBytes)
      throw new RemoteCliPinError(
        "surface-mismatch",
        "npm pack did not contain package/package.json.",
      );
    const packageJson = JSON.parse(packageJsonBytes.toString("utf8")) as JsonObject;
    if (packageJson.name !== input.packageName || packageJson.version !== input.packageVersion) {
      throw new RemoteCliPinError(
        "surface-mismatch",
        "npm pack package metadata does not match the pinned package.",
      );
    }
    if (!isObject(packageJson.bin) && typeof packageJson.bin !== "string") {
      throw new RemoteCliPinError(
        "surface-mismatch",
        "npm pack package has no executable bin entry.",
      );
    }
    const binTargets =
      typeof packageJson.bin === "string"
        ? [packageJson.bin]
        : Object.values(asRecord(packageJson.bin)).filter(
            (value): value is string => typeof value === "string",
          );
    for (const target of binTargets) {
      const normalizedTarget = target.replaceAll("\\", "/").replace(/^\.\//, "");
      if (!tarEntries.has(`package/${normalizedTarget}`)) {
        throw new RemoteCliPinError(
          "surface-mismatch",
          `npm pack is missing executable '${target}'.`,
        );
      }
    }
    const expectedFiles = new Set(input.expectedFiles ?? []);
    const actualFiles = new Set(tarEntries.keys());
    for (const expected of expectedFiles) {
      if (!actualFiles.has(expected)) {
        throw new RemoteCliPinError(
          "surface-mismatch",
          `npm pack is missing expected file '${expected}'.`,
        );
      }
    }
    for (const actual of actualFiles) {
      if (!expectedFiles.has(actual)) {
        throw new RemoteCliPinError(
          "surface-mismatch",
          `npm pack contains unexpected file '${actual}'.`,
        );
      }
    }
    for (const localBuildFile of input.localBuildFiles ?? []) {
      if (!tarEntries.has(localBuildFile)) {
        throw new RemoteCliPinError(
          "surface-mismatch",
          `npm pack is missing local-build file '${localBuildFile}'.`,
        );
      }
    }
    for (const [localBuildFile, expectedContent] of Object.entries(input.localBuildContent ?? {})) {
      const actual = tarEntries.get(localBuildFile);
      if (!actual) {
        throw new RemoteCliPinError(
          "surface-mismatch",
          `npm pack is missing local-build file '${localBuildFile}'.`,
        );
      }
      const bytes =
        typeof expectedContent === "string"
          ? NodeBuffer.Buffer.from(expectedContent)
          : NodeBuffer.Buffer.from(expectedContent);
      if (!actual.equals(bytes)) {
        throw new RemoteCliPinError(
          "surface-mismatch",
          `npm pack content differs for local-build file '${localBuildFile}'.`,
        );
      }
    }
    // npm's dist.integrity is the SRI digest of the compressed .tgz bytes,
    // not the decompressed tar stream used for the executable-surface checks.
    const compressedIntegrity = `sha512-${NodeCrypto.createHash("sha512").update(compressedBytes).digest("base64")}`;
    if (compressedIntegrity !== input.expectedIntegrity) {
      throw new RemoteCliPinError(
        "integrity-mismatch",
        "npm pack tarball digest does not match remote-cli.json.",
      );
    }
  } catch (cause) {
    if (cause instanceof RemoteCliPinError) throw cause;
    throw new RemoteCliPinError(
      "surface-mismatch",
      `Executable-surface verification failed: ${String(cause)}`,
    );
  } finally {
    NodeFS.rmSync(temporary, { recursive: true, force: true });
  }
};

const expectedSurfaceFilesAtTag = async (
  tag: string,
  git: GitRunner,
): Promise<ReadonlyArray<string>> => {
  const manifestText = await gitFileAt(git, tag, "apps/server/package.json");
  const manifest = manifestText === undefined ? {} : asRecord(JSON.parse(manifestText) as unknown);
  const tree = await gitMay(git, ["ls-tree", "-r", "--name-only", tag, "--", "apps/server"]);
  const sourceFiles = (tree ?? "")
    .split(/\r?\n/)
    .map((path) => path.trim())
    .filter((path) => path.length > 0)
    .map((path) => path.slice("apps/server/".length))
    .filter((path) => path.length > 0);
  const files = Array.isArray(manifest.files)
    ? manifest.files.filter((entry): entry is string => typeof entry === "string")
    : [];
  const expected = new Set<string>(["package/package.json"]);
  const selected = files.length > 0 ? files : ["dist"];
  for (const entry of selected) {
    const normalized = entry.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
    for (const sourceFile of sourceFiles) {
      if (
        sourceFile === normalized ||
        sourceFile.startsWith(`${normalized}/`) ||
        (normalized.endsWith("/**") && sourceFile.startsWith(`${normalized.slice(0, -3)}/`))
      ) {
        expected.add(`package/${sourceFile}`);
      }
    }
  }
  return [...expected].toSorted();
};

const writePin = (rootDir: string, remoteCliPath: string, pin: RemoteCliPin): void => {
  const filePath = NodePath.resolve(rootDir, remoteCliPath);
  NodeFS.writeFileSync(filePath, `${JSON.stringify(pin, null, 2)}\n`);
};

export const verifyRemoteCliPin = async (
  options: RemoteCliPinCheckerOptions = {},
): Promise<RemoteCliPinCheckResult> => {
  const rootDir = NodePath.resolve(options.rootDir ?? process.cwd());
  const remoteCliPath = options.remoteCliPath ?? DEFAULT_REMOTE_CLI_PATH;
  const remote = options.upstreamRemote ?? DEFAULT_UPSTREAM_REMOTE;
  const pin = readPin(rootDir, remoteCliPath);
  const packageVersion = versionFromTag(pin.upstreamTag);
  const git = options.git ?? defaultGitRunner(rootDir);
  await assertIntegrityTagCoupling(pin, remoteCliPath, git, options.integrityBaseRef);
  const tagCommit = await assertTagAndHistory(rootDir, pin.upstreamTag, remote, git);
  const closure = computeServerClosure(rootDir);
  const changed = await compareClosureToTag(rootDir, pin.upstreamTag, closure, git);
  if (changed.length > 0) {
    throw new RemoteCliPinError(
      "server-closure-diff",
      `The computed server closure differs from ${pin.upstreamTag}: ${changed.toSorted().join(", ")}`,
    );
  }

  const fetcher = options.fetch ?? globalThis.fetch;
  const metadata =
    options.distIntegrity === undefined
      ? await fetchJson(
          fetcher,
          `https://registry.npmjs.org/t3/${encodeURIComponent(packageVersion)}`,
        )
      : undefined;
  const distIntegrity = options.distIntegrity ?? findDistIntegrity(metadata);
  if (distIntegrity === undefined) {
    throw new RemoteCliPinError(
      "missing-integrity",
      `No dist.integrity found for t3@${packageVersion}.`,
    );
  }
  const attestation =
    options.attestation === undefined
      ? await fetchJson(
          fetcher,
          `https://registry.npmjs.org/-/npm/v1/attestations/t3@${encodeURIComponent(packageVersion)}`,
        )
      : options.attestation;
  const policy: ProvenancePolicy = {
    certificateIssuer: SIGSTORE_ISSUER,
    certificateIdentityURI: `^https://github\\.com/${UPSTREAM_REPOSITORY.replace("/", "\\/")}/${UPSTREAM_WORKFLOW_PATH.replaceAll(".", "\\.")}@refs/(?:heads/main|tags/${pin.upstreamTag.replaceAll(".", "\\.")})$`,
    certificateOIDs: {
      [SOURCE_REPOSITORY_OID]: `https://github.com/${UPSTREAM_REPOSITORY}`,
      [SOURCE_COMMIT_OID]: tagCommit,
    },
  };
  const hasAttestation = attestation !== undefined && attestationEntries(attestation).length > 0;
  let provenance: ProvenanceResult;
  if (hasAttestation) {
    assertFixturePolicyFields(attestation, policy);
    const verifier = options.verifyProvenance ?? defaultVerifyProvenance;
    provenance = await verifier({
      packageName: "t3",
      packageVersion,
      upstreamTag: pin.upstreamTag,
      tagCommit,
      distIntegrity,
      attestation,
      policy,
    });
    if (provenance.status !== "attested") {
      throw new RemoteCliPinError(
        "unattested",
        "An attestation was present but could not be verified; refusing fallback.",
      );
    }
    if (!new RegExp(policy.certificateIdentityURI).test(provenance.certificateIdentity)) {
      throw new RemoteCliPinError(
        "identity-mismatch",
        "Verified Sigstore signer identity does not match policy.",
      );
    }
    if (provenance.statement !== undefined) {
      verifyStatement(
        provenance.statement,
        {
          distIntegrity,
          tagCommit,
          upstreamTag: pin.upstreamTag,
          policy,
        },
        provenance.certificateIdentity,
      );
    }
    if (pin.tarballIntegrity !== undefined) {
      throw new RemoteCliPinError(
        "stale-integrity",
        "tarballIntegrity must be removed when provenance is attested.",
      );
    }
  } else {
    provenance = { status: "unattested", reason: "No SLSA provenance attestation was published." };
    const expectedFiles = await expectedSurfaceFilesAtTag(pin.upstreamTag, git);
    const localBuildContent: Record<string, string> = {};
    const localBuildFiles = listFiles(rootDir, NodePath.join(rootDir, "apps/server/dist")).map(
      (file) => {
        const packagePath = `package/${file.slice("apps/server/".length)}`;
        localBuildContent[packagePath] = NodeFS.readFileSync(NodePath.join(rootDir, file), "utf8");
        return packagePath;
      },
    );
    const integrity = pin.tarballIntegrity;
    if (integrity === undefined) {
      if (!options.record) {
        throw new RemoteCliPinError(
          "missing-fallback-integrity",
          "Unattested pins require tarballIntegrity; rerun with --record after review.",
        );
      }
      const recorded = distIntegrity;
      await (options.verifyExecutableSurface ?? defaultExecutableSurface)({
        rootDir,
        packageName: "t3",
        packageVersion,
        upstreamTag: pin.upstreamTag,
        expectedIntegrity: recorded,
        expectedFiles,
        localBuildFiles,
        localBuildContent,
      });
      writePin(rootDir, remoteCliPath, { ...pin, tarballIntegrity: recorded });
    } else {
      if (integrity !== distIntegrity) {
        throw new RemoteCliPinError(
          "integrity-mismatch",
          "Recorded tarballIntegrity differs from registry dist.integrity.",
        );
      }
      await (options.verifyExecutableSurface ?? defaultExecutableSurface)({
        rootDir,
        packageName: "t3",
        packageVersion,
        upstreamTag: pin.upstreamTag,
        expectedIntegrity: integrity,
        expectedFiles,
        localBuildFiles,
        localBuildContent,
      });
    }
  }
  return { pin, packageVersion, tagCommit, closure, provenance };
};

export const buildProvenancePolicy = (upstreamTag: string, tagCommit: string): ProvenancePolicy => {
  const version = versionFromTag(upstreamTag);
  void version;
  return {
    certificateIssuer: SIGSTORE_ISSUER,
    certificateIdentityURI: `^https://github\\.com/${UPSTREAM_REPOSITORY.replace("/", "\\/")}/${UPSTREAM_WORKFLOW_PATH.replaceAll(".", "\\.")}@refs/(?:heads/main|tags/${upstreamTag.replaceAll(".", "\\.")})$`,
    certificateOIDs: {
      [SOURCE_REPOSITORY_OID]: `https://github.com/${UPSTREAM_REPOSITORY}`,
      [SOURCE_COMMIT_OID]: tagCommit,
    },
  };
};

const parseCli = (argv: ReadonlyArray<string>): RemoteCliPinCheckerOptions => {
  let rootDir: string | undefined;
  let remoteCliPath: string | undefined;
  let upstreamRemote: string | undefined;
  let integrityBaseRef: string | undefined;
  let record = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--record") record = true;
    else if (argument === "--root") rootDir = argv[++index];
    else if (argument === "--remote-cli") remoteCliPath = argv[++index];
    else if (argument === "--upstream") upstreamRemote = argv[++index];
    else if (argument === "--integrity-base-ref") integrityBaseRef = argv[++index];
    else throw new RemoteCliPinError("usage", `Unknown argument '${argument}'.`);
  }
  return {
    ...(rootDir === undefined ? {} : { rootDir }),
    ...(remoteCliPath === undefined ? {} : { remoteCliPath }),
    ...(upstreamRemote === undefined ? {} : { upstreamRemote }),
    ...(integrityBaseRef === undefined ? {} : { integrityBaseRef }),
    ...(record ? { record: true } : {}),
  };
};

if (import.meta.main) {
  verifyRemoteCliPin(parseCli(process.argv.slice(2)))
    .then(() => process.stdout.write("remote CLI pin is valid\n"))
    .catch((cause: unknown) => {
      process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
      process.exitCode = 1;
    });
}
