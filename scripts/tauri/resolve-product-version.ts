#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalDate:off - This release preflight reads fork-owned JSON synchronously before build composition.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const STABLE_VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
export const NIGHTLY_VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-nightly\.\d{8}\.\d+$/;

const UPSTREAM_TAG_PATTERN = /^v(.+)$/;
const PRODUCT_VERSION_FILE = "apps/desktop/src-tauri/product-version.json";
const REMOTE_CLI_FILE = "apps/desktop/src-tauri/remote-cli.json";
const DEFAULT_ROOT_DIR = fileURLToPath(new URL("../../", import.meta.url));

export type ProductVersionChannel = "stable" | "nightly";

export interface ResolveProductVersionOptions {
  readonly rootDir?: string;
  readonly channel?: ProductVersionChannel;
  readonly productVersion?: string;
  readonly date?: string;
  readonly run?: number | string;
  readonly now?: Date;
}

export interface ProductVersionMetadata {
  readonly productVersion: string;
  readonly compatibleServerVersion: string;
  readonly upstreamBaseTag: string;
  readonly packageSpec: string;
  readonly channel: ProductVersionChannel;
}

interface ProductVersionDocument {
  readonly productVersion: unknown;
}

interface RemoteCliDocument {
  readonly upstreamTag: unknown;
  readonly packageSpec: unknown;
}

const asRecord = (value: unknown, filePath: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${filePath} must contain a JSON object.`);
  }
  return value as Record<string, unknown>;
};

const readJson = <T>(rootDir: string, relativePath: string): T => {
  const filePath = resolve(rootDir, relativePath);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  } catch (cause) {
    throw new Error(`Unable to read ${relativePath}.`, { cause });
  }
  return asRecord(value, filePath) as T;
};

const nonEmptyString = (name: string, value: unknown): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value.trim();
};

const readProductVersionDocument = (rootDir: string): ProductVersionDocument =>
  readJson<ProductVersionDocument>(rootDir, PRODUCT_VERSION_FILE);

const readRemoteCliDocument = (rootDir: string): RemoteCliDocument =>
  readJson<RemoteCliDocument>(rootDir, REMOTE_CLI_FILE);

export const readProductVersion = (rootDir = DEFAULT_ROOT_DIR): string =>
  nonEmptyString("productVersion", readProductVersionDocument(rootDir).productVersion);

const validateStableVersion = (version: string): string => {
  if (!STABLE_VERSION_PATTERN.test(version)) {
    throw new Error(`Product version '${version}' is not a stable X.Y.Z version.`);
  }
  return version;
};

const formatUtcDate = (date: Date): string => {
  if (Number.isNaN(date.getTime())) {
    throw new Error("Nightly version date must be valid.");
  }

  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  return `${year.toString().padStart(4, "0")}${month.toString().padStart(2, "0")}${day
    .toString()
    .padStart(2, "0")}`;
};

const resolveNightlyDate = (options: ResolveProductVersionOptions): string => {
  const date =
    options.date ?? process.env.NANONI_NIGHTLY_DATE ?? formatUtcDate(options.now ?? new Date());
  if (!/^\d{8}$/.test(date)) {
    throw new Error(`Nightly version date '${date}' must use YYYYMMDD.`);
  }
  return date;
};

const resolveNightlyRun = (options: ResolveProductVersionOptions): string => {
  const rawRun = options.run ?? process.env.GITHUB_RUN_NUMBER ?? "1";
  const run = String(rawRun).trim();
  if (!/^[1-9]\d*$/.test(run)) {
    throw new Error(`Nightly version run '${run}' must be a positive integer.`);
  }
  return run;
};

export const resolveNightlyVersion = (
  stableVersion: string,
  options: Pick<ResolveProductVersionOptions, "date" | "run" | "now"> = {},
): string => {
  const baseVersion = validateStableVersion(stableVersion);
  const date = resolveNightlyDate(options);
  const run = resolveNightlyRun(options);
  const version = `${baseVersion}-nightly.${date}.${run}`;

  if (!NIGHTLY_VERSION_PATTERN.test(version)) {
    throw new Error(`Resolved nightly product version '${version}' is not upstream-compatible.`);
  }
  return version;
};

/**
 * Return the upstream compatibility version after checking the exact pin.
 * Only the leading `v` is removed from the tag.
 */
export const deriveCompatibleServerVersion = (
  upstreamTagInput: string,
  packageSpecInput: string,
): string => {
  const upstreamTag = nonEmptyString("upstreamTag", upstreamTagInput);
  const packageSpec = nonEmptyString("packageSpec", packageSpecInput);
  const match = UPSTREAM_TAG_PATTERN.exec(upstreamTag);
  const compatibleServerVersion = match?.[1];

  if (
    compatibleServerVersion === undefined ||
    (!STABLE_VERSION_PATTERN.test(compatibleServerVersion) &&
      !NIGHTLY_VERSION_PATTERN.test(compatibleServerVersion))
  ) {
    throw new Error(`Upstream tag '${upstreamTag}' is not in the upstream release grammar.`);
  }

  const expectedPackageSpec = `t3@${compatibleServerVersion}`;
  if (packageSpec !== expectedPackageSpec) {
    throw new Error(
      `Package specification '${packageSpec}' does not match upstream tag '${upstreamTag}'.`,
    );
  }

  return compatibleServerVersion;
};

export const resolveProductVersionMetadata = (
  options: ResolveProductVersionOptions = {},
): ProductVersionMetadata => {
  const rootDir = resolve(options.rootDir ?? DEFAULT_ROOT_DIR);
  const seed = validateStableVersion(options.productVersion ?? readProductVersion(rootDir));
  const channel = options.channel ?? "stable";
  const productVersion =
    channel === "nightly" ? resolveNightlyVersion(seed, options) : validateStableVersion(seed);
  const remoteCli = readRemoteCliDocument(rootDir);
  const upstreamBaseTag = nonEmptyString("upstreamTag", remoteCli.upstreamTag);
  const packageSpec = nonEmptyString("packageSpec", remoteCli.packageSpec);
  const compatibleServerVersion = deriveCompatibleServerVersion(upstreamBaseTag, packageSpec);

  return {
    productVersion,
    compatibleServerVersion,
    upstreamBaseTag,
    packageSpec,
    channel,
  };
};

/** Resolve only the Tauri product version; metadata is available separately. */
export const resolveProductVersion = (options: ResolveProductVersionOptions = {}): string => {
  const rootDir = resolve(options.rootDir ?? DEFAULT_ROOT_DIR);
  const seed = validateStableVersion(options.productVersion ?? readProductVersion(rootDir));
  return options.channel === "nightly" ? resolveNightlyVersion(seed, options) : seed;
};

const parseCliOptions = (args: ReadonlyArray<string>): ResolveProductVersionOptions => {
  let channel: ProductVersionChannel = "stable";
  let rootDir: string | undefined;
  let productVersion: string | undefined;
  let date: string | undefined;
  let run: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const next = args[index + 1];
    if (argument === "--channel" && (next === "stable" || next === "nightly")) {
      channel = next;
      index += 1;
    } else if (argument === "--root" && next !== undefined) {
      rootDir = next;
      index += 1;
    } else if (argument === "--product-version" && next !== undefined) {
      productVersion = next;
      index += 1;
    } else if (argument === "--date" && next !== undefined) {
      date = next;
      index += 1;
    } else if ((argument === "--run" || argument === "--run-number") && next !== undefined) {
      run = next;
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete argument '${argument}'.`);
    }
  }

  return {
    ...(rootDir === undefined ? {} : { rootDir }),
    channel,
    ...(productVersion === undefined ? {} : { productVersion }),
    ...(date === undefined ? {} : { date }),
    ...(run === undefined ? {} : { run }),
  };
};

if (import.meta.main) {
  try {
    const options = parseCliOptions(process.argv.slice(2));
    process.stdout.write(`${resolveProductVersion(options)}\n`);
  } catch (cause) {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exitCode = 1;
  }
}
