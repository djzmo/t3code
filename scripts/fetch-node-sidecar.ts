#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - The acquisition boundary intentionally uses Node fs/child-process primitives.

import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { readFileSync, promises as fsPromises } from "node:fs";
import { resolve, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export type NodeSidecarCommandOptions = {
  readonly windowsHide: boolean;
  readonly maxBuffer: number;
  readonly env?: NodeJS.ProcessEnv;
};

export type NodeSidecarCommandRunner = (
  file: string,
  args: ReadonlyArray<string>,
  options: NodeSidecarCommandOptions,
) => Promise<{ readonly stdout: string; readonly stderr: string }>;

const runArchiveCommand: NodeSidecarCommandRunner = async (file, args, options) => {
  const result = await execFile(file, [...args], options);
  return { stdout: result.stdout, stderr: result.stderr };
};

export const NODE_SIDECAR_VERSION = "24.19.0";
export const NODE_SIDECAR_NAME = "agent-nanoni-node";
export const NODE_OVERRIDE_ENV = "AGENT_NANONI_NODE";
export const NODE_HOME_ENV = "T3CODE_HOME";
export const NODE_PORT_ENV = "T3CODE_PORT";

export const SUPPORTED_NODE_SIDECAR_TRIPLES = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "win-arm64",
  "win-x64",
] as const;

export type NodeSidecarTriple = (typeof SUPPORTED_NODE_SIDECAR_TRIPLES)[number];
export type NodeSidecarPlatform = "darwin" | "linux" | "win32" | "windows";
export type NodeSidecarArch = "arm64" | "x64";
export type NodeSidecarArchiveType = "tar.xz" | "zip";

export type NodeSidecarArtifact = {
  readonly archiveName: string;
  readonly archiveType: NodeSidecarArchiveType;
  readonly sha256: string;
  readonly expectedBinaryPath: string;
  readonly expectedLicensePath: string;
};

export type NodeSidecarConfig = {
  readonly version: string;
  readonly baseUrl: string;
  readonly sidecarName: string;
  readonly artifacts: Readonly<Record<NodeSidecarTriple, NodeSidecarArtifact>>;
};

export type NodeSidecarAcquisitionResult = {
  readonly path: string;
  readonly licensePath?: string;
  readonly source: "download" | "cache" | "dev-override";
  readonly triple?: NodeSidecarTriple;
};

export class NodeSidecarError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "NodeSidecarError";
    this.code = code;
  }
}

type JsonObject = { [key: string]: unknown };

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asNonEmptyString = (value: unknown, name: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new NodeSidecarError("invalid-config", `${name} must be a non-empty string.`);
  }
  return value.trim();
};

const normalizeRelativePath = (value: string, name: string): string => {
  const normalized = value.replaceAll("\\", "/");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split("/").some((part) => part === ".." || part.length === 0)
  ) {
    throw new NodeSidecarError("invalid-config", `${name} must be a safe relative path.`);
  }
  return normalized;
};

const artifactFor = (value: unknown, triple: NodeSidecarTriple): NodeSidecarArtifact => {
  if (!isObject(value)) {
    throw new NodeSidecarError("invalid-config", `Missing artifact configuration for '${triple}'.`);
  }
  const archiveName = asNonEmptyString(value.archiveName, `${triple}.archiveName`);
  const archiveType = asNonEmptyString(value.archiveType, `${triple}.archiveType`);
  if (archiveType !== "tar.xz" && archiveType !== "zip") {
    throw new NodeSidecarError("invalid-config", `${triple}.archiveType is unsupported.`);
  }
  const sha256 = asNonEmptyString(value.sha256, `${triple}.sha256`).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new NodeSidecarError("invalid-config", `${triple}.sha256 must be a SHA-256 hex digest.`);
  }
  return {
    archiveName,
    archiveType,
    sha256,
    expectedBinaryPath: normalizeRelativePath(
      asNonEmptyString(value.expectedBinaryPath, `${triple}.expectedBinaryPath`),
      `${triple}.expectedBinaryPath`,
    ),
    expectedLicensePath: normalizeRelativePath(
      asNonEmptyString(value.expectedLicensePath, `${triple}.expectedLicensePath`),
      `${triple}.expectedLicensePath`,
    ),
  };
};

const expectedArchiveSuffix = (triple: NodeSidecarTriple): NodeSidecarArchiveType =>
  triple.startsWith("win-") ? "zip" : "tar.xz";

/** Parse and validate the fork-owned node-sidecar.json document. */
export const parseNodeSidecarConfig = (value: unknown): NodeSidecarConfig => {
  if (!isObject(value)) {
    throw new NodeSidecarError("invalid-config", "node-sidecar.json must contain an object.");
  }
  const version = asNonEmptyString(value.version, "version");
  if (version !== NODE_SIDECAR_VERSION) {
    throw new NodeSidecarError(
      "invalid-config",
      `Node sidecar version '${version}' does not match the pinned ${NODE_SIDECAR_VERSION}.`,
    );
  }
  const baseUrl = asNonEmptyString(value.baseUrl, "baseUrl");
  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(baseUrl);
  } catch (cause) {
    throw new NodeSidecarError("invalid-config", `baseUrl is not a valid URL: ${String(cause)}`);
  }
  if (
    parsedBaseUrl.protocol !== "https:" ||
    parsedBaseUrl.hostname !== "nodejs.org" ||
    parsedBaseUrl.pathname !== `/dist/v${version}` ||
    parsedBaseUrl.search.length > 0 ||
    parsedBaseUrl.hash.length > 0
  ) {
    throw new NodeSidecarError(
      "invalid-config",
      "baseUrl must be the official HTTPS nodejs.org release directory.",
    );
  }
  const sidecarName = asNonEmptyString(value.sidecarName, "sidecarName");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sidecarName)) {
    throw new NodeSidecarError("invalid-config", "sidecarName contains unsafe characters.");
  }
  if (!isObject(value.artifacts)) {
    throw new NodeSidecarError("invalid-config", "artifacts must be an object.");
  }
  const artifactEntries = Object.entries(value.artifacts);
  if (
    artifactEntries.length !== SUPPORTED_NODE_SIDECAR_TRIPLES.length ||
    artifactEntries.some(
      ([triple]) => !SUPPORTED_NODE_SIDECAR_TRIPLES.includes(triple as NodeSidecarTriple),
    )
  ) {
    throw new NodeSidecarError(
      "invalid-config",
      `artifacts must contain exactly: ${SUPPORTED_NODE_SIDECAR_TRIPLES.join(", ")}.`,
    );
  }

  const artifacts = {} as Record<NodeSidecarTriple, NodeSidecarArtifact>;
  for (const triple of SUPPORTED_NODE_SIDECAR_TRIPLES) {
    const artifact = artifactFor(value.artifacts[triple], triple);
    const expectedArchiveType = expectedArchiveSuffix(triple);
    if (artifact.archiveType !== expectedArchiveType) {
      throw new NodeSidecarError(
        "invalid-config",
        `${triple} must use the official ${expectedArchiveType} archive format.`,
      );
    }
    if (!artifact.archiveName.startsWith(`node-v${version}-${triple}.`)) {
      throw new NodeSidecarError(
        "invalid-config",
        `${triple}.archiveName must be the official Node ${version} archive name.`,
      );
    }
    const expectedExtension = expectedArchiveType === "zip" ? ".zip" : ".tar.xz";
    if (!artifact.archiveName.endsWith(expectedExtension)) {
      throw new NodeSidecarError(
        "invalid-config",
        `${triple}.archiveName must end with ${expectedExtension}.`,
      );
    }
    artifacts[triple] = artifact;
  }

  return { version, baseUrl, sidecarName, artifacts };
};

export const loadNodeSidecarConfig = (filePath: string): NodeSidecarConfig => {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  } catch (cause) {
    throw new NodeSidecarError("invalid-config", `Unable to read '${filePath}': ${String(cause)}`);
  }
  return parseNodeSidecarConfig(value);
};

export const resolveNodeSidecarTriple = (
  platform: NodeSidecarPlatform,
  arch: NodeSidecarArch,
): NodeSidecarTriple => {
  const normalizedPlatform = platform === "windows" ? "win32" : platform;
  if (
    normalizedPlatform !== "win32" &&
    normalizedPlatform !== "darwin" &&
    normalizedPlatform !== "linux"
  ) {
    throw new NodeSidecarError(
      "unsupported-platform",
      `Unsupported Node sidecar platform '${platform}'.`,
    );
  }
  if (arch !== "x64" && arch !== "arm64") {
    throw new NodeSidecarError(
      "unsupported-architecture",
      `Unsupported Node sidecar architecture '${arch}'.`,
    );
  }
  const triple = `${normalizedPlatform === "win32" ? "win" : normalizedPlatform}-${arch}`;
  if (!SUPPORTED_NODE_SIDECAR_TRIPLES.includes(triple as NodeSidecarTriple)) {
    throw new NodeSidecarError(
      "unsupported-platform",
      `Unsupported Node sidecar tuple '${triple}'.`,
    );
  }
  return triple as NodeSidecarTriple;
};

export const resolveNodeSidecarArtifact = (
  config: NodeSidecarConfig,
  triple: string,
): NodeSidecarArtifact => {
  if (!SUPPORTED_NODE_SIDECAR_TRIPLES.includes(triple as NodeSidecarTriple)) {
    throw new NodeSidecarError("unsupported-tuple", `Unsupported Node sidecar tuple '${triple}'.`);
  }
  const artifact = config.artifacts[triple as NodeSidecarTriple];
  if (artifact === undefined) {
    throw new NodeSidecarError(
      "unsupported-tuple",
      `No Node sidecar artifact configured for '${triple}'.`,
    );
  }
  return artifact;
};

const defaultFileSystem: NodeSidecarFileSystem = {
  mkdtemp: (prefix) => fsPromises.mkdtemp(prefix),
  mkdir: async (path) => {
    await fsPromises.mkdir(path, { recursive: true });
  },
  writeFile: async (path, data) => {
    await fsPromises.writeFile(path, data);
  },
  copyFile: async (source, destination) => {
    await fsPromises.copyFile(source, destination);
  },
  rename: async (source, destination) => {
    await fsPromises.rename(source, destination);
  },
  rm: async (path) => {
    await fsPromises.rm(path, { recursive: true, force: true });
  },
  stat: (path) => fsPromises.stat(path),
  exists: async (path) => {
    try {
      await fsPromises.stat(path);
      return true;
    } catch (cause) {
      if (isNodeError(cause) && cause.code === "ENOENT") return false;
      throw cause;
    }
  },
  chmod: async (path, mode) => {
    await fsPromises.chmod(path, mode);
  },
};

export interface NodeSidecarFileSystem {
  readonly mkdtemp: (prefix: string) => Promise<string>;
  readonly mkdir: (path: string) => Promise<void>;
  readonly writeFile: (path: string, data: Uint8Array) => Promise<void>;
  readonly copyFile: (source: string, destination: string) => Promise<void>;
  readonly rename: (source: string, destination: string) => Promise<void>;
  readonly rm: (path: string) => Promise<void>;
  readonly stat: (path: string) => Promise<{ readonly isFile: () => boolean }>;
  readonly exists: (path: string) => Promise<boolean>;
  readonly chmod?: (path: string, mode: number) => Promise<void>;
}

type BinaryResponse = {
  readonly ok: boolean;
  readonly status: number;
  readonly arrayBuffer: () => Promise<ArrayBuffer>;
};

export type NodeSidecarFetcher = (input: string, init?: RequestInit) => Promise<BinaryResponse>;

export type NodeSidecarExtractor = (
  archivePath: string,
  extractionRoot: string,
  archiveType: NodeSidecarArchiveType,
) => Promise<ReadonlyArray<string>>;

const isNodeError = (cause: unknown): cause is NodeJS.ErrnoException =>
  cause instanceof Error && "code" in cause;

const assertSafeArchiveEntry = (entry: string): string => {
  const normalized = entry.replaceAll("\\", "/");
  const parts = normalized.split("/");
  const pathParts = normalized.endsWith("/") ? parts.slice(0, -1) : parts;
  if (
    pathParts.length === 0 ||
    normalized.includes("\0") ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    pathParts.some((part) => part === ".." || part.length === 0)
  ) {
    throw new NodeSidecarError("unsafe-archive-entry", `Unsafe archive entry '${entry}'.`);
  }
  return normalized;
};

export const validateArchiveEntries = (entries: ReadonlyArray<string>): ReadonlyArray<string> =>
  entries.map(assertSafeArchiveEntry);

const ARCHIVE_COMMAND_MAX_BUFFER = 8 * 1024 * 1024;

const powershellScript = (operation: "list" | "extract"): string => {
  if (operation === "list") {
    return [
      "$ErrorActionPreference = 'Stop'",
      "Add-Type -AssemblyName System.IO.Compression.FileSystem",
      "$archive = [System.IO.Compression.ZipFile]::OpenRead($env:AGENT_NANONI_NODE_ARCHIVE_PATH)",
      "try { foreach ($entry in $archive.Entries) { [Console]::WriteLine($entry.FullName) } } finally { $archive.Dispose() }",
    ].join("; ");
  }
  return [
    "$ErrorActionPreference = 'Stop'",
    "Expand-Archive -LiteralPath $env:AGENT_NANONI_NODE_ARCHIVE_PATH -DestinationPath $env:AGENT_NANONI_NODE_EXTRACTION_ROOT -Force",
  ].join("; ");
};

const encodePowerShell = (script: string): string =>
  Buffer.from(script, "utf16le").toString("base64");

const powershellCommand = (
  archivePath: string,
  extractionRoot: string,
  operation: "list" | "extract",
): { readonly args: ReadonlyArray<string>; readonly options: NodeSidecarCommandOptions } => ({
  args: [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    encodePowerShell(powershellScript(operation)),
  ],
  options: {
    windowsHide: true,
    maxBuffer: ARCHIVE_COMMAND_MAX_BUFFER,
    env: {
      ...process.env,
      AGENT_NANONI_NODE_ARCHIVE_PATH: archivePath,
      AGENT_NANONI_NODE_EXTRACTION_ROOT: extractionRoot,
    },
  },
});

/**
 * Extract a downloaded Node archive using the archive format's native tool.
 *
 * Windows Node releases are ZIP files. PowerShell is invoked with an encoded
 * script and paths supplied through the child environment, so archive paths
 * never become PowerShell source. The archive is listed and validated before
 * `Expand-Archive` runs, preserving the traversal barrier used by tar.xz.
 */
export const extractNodeSidecarArchive = async (
  archivePath: string,
  extractionRoot: string,
  archiveType: NodeSidecarArchiveType,
  command: NodeSidecarCommandRunner = runArchiveCommand,
): Promise<ReadonlyArray<string>> => {
  if (archiveType === "zip") {
    let listing: string;
    try {
      const invocation = powershellCommand(archivePath, extractionRoot, "list");
      const listed = await command("powershell.exe", invocation.args, invocation.options);
      listing = listed.stdout;
    } catch (cause) {
      throw new NodeSidecarError("extract", `Unable to inspect Node ZIP archive: ${String(cause)}`);
    }
    const entries = validateArchiveEntries(
      listing.split(/\r?\n/).filter((entry) => entry.length > 0),
    );
    try {
      const invocation = powershellCommand(archivePath, extractionRoot, "extract");
      await command("powershell.exe", invocation.args, invocation.options);
    } catch (cause) {
      throw new NodeSidecarError("extract", `Unable to extract Node ZIP archive: ${String(cause)}`);
    }
    return entries;
  }

  let listing: string;
  try {
    const listed = await command("tar", ["-tf", archivePath], {
      windowsHide: true,
      maxBuffer: ARCHIVE_COMMAND_MAX_BUFFER,
    });
    listing = listed.stdout;
  } catch (cause) {
    throw new NodeSidecarError("extract", `Unable to inspect Node archive: ${String(cause)}`);
  }
  const entries = validateArchiveEntries(
    listing.split(/\r?\n/).filter((entry) => entry.length > 0),
  );
  try {
    await command("tar", ["-xf", archivePath, "-C", extractionRoot], {
      windowsHide: true,
      maxBuffer: ARCHIVE_COMMAND_MAX_BUFFER,
    });
  } catch (cause) {
    throw new NodeSidecarError("extract", `Unable to extract Node archive: ${String(cause)}`);
  }
  return entries;
};

const defaultExtractArchive: NodeSidecarExtractor = (archivePath, extractionRoot, archiveType) =>
  extractNodeSidecarArchive(archivePath, extractionRoot, archiveType);

const verifyResponse = async (response: BinaryResponse, url: string): Promise<Uint8Array> => {
  if (!response.ok) {
    throw new NodeSidecarError(
      "download",
      `Node archive request failed (${response.status}) for ${url}.`,
    );
  }
  let bytes: ArrayBuffer;
  try {
    bytes = await response.arrayBuffer();
  } catch (cause) {
    throw new NodeSidecarError(
      "download",
      `Unable to read Node archive response: ${String(cause)}`,
    );
  }
  return new Uint8Array(bytes);
};

const verifySha256 = (bytes: Uint8Array, expected: string): void => {
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new NodeSidecarError(
      "sha256-mismatch",
      `Node archive SHA-256 mismatch: expected ${expected}, got ${actual}.`,
    );
  }
};

const ensureInside = (root: string, candidate: string, name: string): string => {
  const rootPath = resolve(root);
  const candidatePath = resolve(candidate);
  const relativePath = relative(rootPath, candidatePath);
  if (relativePath.startsWith(".." + sep) || relativePath === ".." || isAbsolute(relativePath)) {
    throw new NodeSidecarError("unsafe-path", `${name} escapes its staging directory.`);
  }
  return candidatePath;
};

const sidecarOutputName = (sidecarName: string, triple: NodeSidecarTriple): string =>
  `${sidecarName}-${triple}${triple.startsWith("win-") ? ".exe" : ""}`;

/**
 * Strip Electron and accidental T3/Node injection from the environment passed
 * to the host. The returned record is new; the caller's environment is never
 * mutated. Deliberate host inputs (T3CODE_HOME/PORT and AGENT_NANONI_*) stay.
 */
export const stripHostEnvironment = (
  input: Readonly<Record<string, string | undefined>>,
): Record<string, string> => {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || key === "NODE_OPTIONS" || key === "NODE_PATH") continue;
    if (key === "ELECTRON_RUN_AS_NODE" || key.startsWith("ELECTRON_")) continue;
    if (key.startsWith("T3CODE_") && key !== NODE_HOME_ENV && key !== NODE_PORT_ENV) continue;
    output[key] = value;
  }
  return output;
};

export const stripElectronEnvironment = stripHostEnvironment;

export type AcquireNodeSidecarOptions = {
  readonly config: NodeSidecarConfig;
  readonly platform: NodeSidecarPlatform;
  readonly arch: NodeSidecarArch;
  readonly destinationDir: string;
  readonly isDev?: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: NodeSidecarFetcher;
  readonly fileSystem?: NodeSidecarFileSystem;
  readonly extract?: NodeSidecarExtractor;
};

const resolveDevOverride = async (
  options: AcquireNodeSidecarOptions,
  fileSystem: NodeSidecarFileSystem,
): Promise<NodeSidecarAcquisitionResult | undefined> => {
  const override = options.env?.[NODE_OVERRIDE_ENV]?.trim();
  if (!options.isDev || override === undefined || override.length === 0) return undefined;
  if (!isAbsolute(override)) {
    throw new NodeSidecarError(
      "invalid-override",
      `${NODE_OVERRIDE_ENV} must be an absolute path.`,
    );
  }
  const metadata = await fileSystem.stat(override).catch((cause: unknown) => {
    throw new NodeSidecarError(
      "invalid-override",
      `Unable to inspect ${NODE_OVERRIDE_ENV}: ${String(cause)}`,
    );
  });
  if (!metadata.isFile()) {
    throw new NodeSidecarError("invalid-override", `${NODE_OVERRIDE_ENV} must point to a file.`);
  }
  return { path: override, source: "dev-override" };
};

export const acquireNodeSidecar = async (
  options: AcquireNodeSidecarOptions,
): Promise<NodeSidecarAcquisitionResult> => {
  const fileSystem = options.fileSystem ?? defaultFileSystem;
  const override = await resolveDevOverride(options, fileSystem);
  if (override !== undefined) return override;

  const triple = resolveNodeSidecarTriple(options.platform, options.arch);
  const artifact = resolveNodeSidecarArtifact(options.config, triple);
  const destinationDir = resolve(options.destinationDir);
  await fileSystem.mkdir(destinationDir);
  const outputName = sidecarOutputName(options.config.sidecarName, triple);
  const finalPath = ensureInside(
    destinationDir,
    join(destinationDir, outputName),
    "sidecar output",
  );
  const licensePath = ensureInside(
    destinationDir,
    join(destinationDir, "NODE_LICENSE.txt"),
    "license output",
  );
  const existingBinary = await fileSystem.exists(finalPath);
  const existingLicense = await fileSystem.exists(licensePath);
  if (existingBinary && existingLicense) {
    const binaryMetadata = await fileSystem.stat(finalPath);
    const licenseMetadata = await fileSystem.stat(licensePath);
    if (binaryMetadata.isFile() && licenseMetadata.isFile()) {
      return { path: finalPath, licensePath, source: "cache", triple };
    }
  }
  if (existingBinary) await fileSystem.rm(finalPath);
  if (existingLicense) await fileSystem.rm(licensePath);

  const stagingRoot = await fileSystem.mkdtemp(join(destinationDir, ".agent-nanoni-node-"));
  const archivePath = ensureInside(stagingRoot, join(stagingRoot, artifact.archiveName), "archive");
  const extractionRoot = ensureInside(stagingRoot, join(stagingRoot, "extract"), "extraction root");
  const stagedBinary = ensureInside(
    extractionRoot,
    join(extractionRoot, artifact.expectedBinaryPath),
    "expected binary",
  );
  const stagedLicense = ensureInside(
    extractionRoot,
    join(extractionRoot, artifact.expectedLicensePath),
    "expected license",
  );
  const fetcher = options.fetch ?? (globalThis.fetch as unknown as NodeSidecarFetcher);
  const extractor = options.extract ?? defaultExtractArchive;
  const url = `${options.config.baseUrl}/${artifact.archiveName}`;

  let publishedLicense = false;
  let publishedBinary = false;
  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== "https:" || parsedUrl.hostname !== "nodejs.org") {
      throw new NodeSidecarError(
        "insecure-url",
        `Refusing non-official Node archive URL '${url}'.`,
      );
    }
    const response = await fetcher(url, { redirect: "error" });
    const bytes = await verifyResponse(response, url);
    verifySha256(bytes, artifact.sha256);
    await fileSystem.writeFile(archivePath, bytes);
    await fileSystem.mkdir(extractionRoot);
    const entries = validateArchiveEntries(
      await extractor(archivePath, extractionRoot, artifact.archiveType),
    );
    const expectedBinaryEntry = artifact.expectedBinaryPath.replaceAll("\\", "/");
    const expectedLicenseEntry = artifact.expectedLicensePath.replaceAll("\\", "/");
    if (!entries.includes(expectedBinaryEntry) || !entries.includes(expectedLicenseEntry)) {
      throw new NodeSidecarError(
        "missing-archive-entry",
        `Node archive did not contain '${expectedBinaryEntry}' and '${expectedLicenseEntry}'.`,
      );
    }
    const binaryMetadata = await fileSystem.stat(stagedBinary);
    const licenseMetadata = await fileSystem.stat(stagedLicense);
    if (!binaryMetadata.isFile() || !licenseMetadata.isFile()) {
      throw new NodeSidecarError("invalid-archive", "Node archive entries are not regular files.");
    }
    if (!triple.startsWith("win-") && fileSystem.chmod !== undefined) {
      await fileSystem.chmod(stagedBinary, 0o755);
    }
    await fileSystem.copyFile(
      stagedLicense,
      ensureInside(stagingRoot, join(stagingRoot, "NODE_LICENSE.txt"), "license"),
    );
    await fileSystem.rename(join(stagingRoot, "NODE_LICENSE.txt"), licensePath);
    publishedLicense = true;
    await fileSystem.rename(stagedBinary, finalPath);
    publishedBinary = true;
    return { path: finalPath, licensePath, source: "download", triple };
  } catch (cause) {
    if (publishedLicense && !publishedBinary)
      await fileSystem.rm(licensePath).catch(() => undefined);
    throw cause instanceof NodeSidecarError
      ? cause
      : new NodeSidecarError("acquisition", `Unable to acquire Node sidecar: ${String(cause)}`);
  } finally {
    await fileSystem.rm(stagingRoot).catch(() => undefined);
  }
};

const defaultConfigPath = fileURLToPath(
  new URL("../apps/desktop/src-tauri/node-sidecar.json", import.meta.url),
);

const parseCli = (
  argv: ReadonlyArray<string>,
): {
  readonly platform: NodeSidecarPlatform;
  readonly arch: NodeSidecarArch;
  readonly destinationDir: string;
  readonly isDev: boolean;
} => {
  let platform: NodeSidecarPlatform = process.platform as NodeSidecarPlatform;
  let arch: NodeSidecarArch = process.arch as NodeSidecarArch;
  let destinationDir = resolve("apps/desktop/src-tauri/binaries");
  let isDev = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = argv[index + 1];
    if (argument === "--platform" && next !== undefined) {
      platform = next as NodeSidecarPlatform;
      index += 1;
    } else if (argument === "--arch" && next !== undefined) {
      arch = next as NodeSidecarArch;
      index += 1;
    } else if (argument === "--destination" && next !== undefined) {
      destinationDir = resolve(next);
      index += 1;
    } else if (argument === "--dev") isDev = true;
    else throw new NodeSidecarError("usage", `Unknown or incomplete argument '${argument}'.`);
  }
  return { platform, arch, destinationDir, isDev };
};

if (import.meta.main) {
  try {
    const options = parseCli(process.argv.slice(2));
    const config = loadNodeSidecarConfig(defaultConfigPath);
    const result = await acquireNodeSidecar({
      config,
      platform: options.platform,
      arch: options.arch,
      destinationDir: options.destinationDir,
      isDev: options.isDev,
      env: process.env,
    });
    process.stdout.write(`${result.path}\n`);
  } catch (cause) {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exitCode = 1;
  }
}
