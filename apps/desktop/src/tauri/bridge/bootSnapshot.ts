import productVersionDocument from "../../../src-tauri/product-version.json" with { type: "json" };
import remoteCliDocument from "../../../src-tauri/remote-cli.json" with { type: "json" };

/** The three version values embedded in the renderer's first boot snapshot. */
export interface NanoniVersionMetadata {
  readonly productVersion: string;
  readonly compatibleServerVersion: string;
  readonly upstreamBaseTag: string;
}

/** Values which may be supplied by Vite's host-build `define` entries. */
export interface NanoniVersionDefines {
  readonly productVersion?: unknown;
  readonly compatibleServerVersion?: unknown;
  readonly upstreamBaseTag?: unknown;
}

export interface ResolveVersionMetadataOptions {
  /** Override the build defines in tests or a host composition layer. */
  readonly defines?: NanoniVersionDefines;
  /** Override the checked-in development fallback in tests. */
  readonly fallback?: NanoniVersionDefines;
  /** Missing build defines are recoverable only for a development host. */
  readonly isDevelopment?: boolean;
  /** Cross-check the Tauri `shell.hello` version when it is already available. */
  readonly shellHelloVersion?: string;
}

export interface CreateBootSnapshotOptions extends ResolveVersionMetadataOptions {
  /** Other boot values (branding, locale, and bootstraps) supplied by the host. */
  readonly base?: Readonly<Record<string, unknown>>;
}

declare const __NANONI_PRODUCT_VERSION__: unknown;
declare const __NANONI_COMPAT_SERVER_VERSION__: unknown;
declare const __NANONI_UPSTREAM_TAG__: unknown;

declare global {
  interface ImportMeta {
    readonly env?: {
      readonly DEV?: boolean;
    };
  }
}

export const STABLE_VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
export const NIGHTLY_VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-nightly\.\d{8}\.\d+$/u;

const UPSTREAM_TAG_PATTERN = /^v(.+)$/u;
const fallbackFromCheckedInJson = (): NanoniVersionDefines => ({
  productVersion: productVersionDocument.productVersion,
  compatibleServerVersion: (() => {
    const upstreamTag = remoteCliDocument.upstreamTag;
    const packageSpec = remoteCliDocument.packageSpec;
    if (typeof upstreamTag !== "string" || typeof packageSpec !== "string") return undefined;
    const tagVersion = upstreamTag.replace(/^v/u, "");
    return packageSpec === `t3@${tagVersion}` ? tagVersion : undefined;
  })(),
  upstreamBaseTag: remoteCliDocument.upstreamTag,
});

const readBuildDefines = (): NanoniVersionDefines => ({
  productVersion:
    typeof __NANONI_PRODUCT_VERSION__ === "undefined" ? undefined : __NANONI_PRODUCT_VERSION__,
  compatibleServerVersion:
    typeof __NANONI_COMPAT_SERVER_VERSION__ === "undefined"
      ? undefined
      : __NANONI_COMPAT_SERVER_VERSION__,
  upstreamBaseTag:
    typeof __NANONI_UPSTREAM_TAG__ === "undefined" ? undefined : __NANONI_UPSTREAM_TAG__,
});

const defaultIsDevelopment = (): boolean => import.meta.env?.DEV === true;

const nonEmptyString = (name: string, value: unknown): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Nanoni ${name} must be a non-empty string.`);
  }
  return value.trim();
};

const validateVersion = (name: string, value: unknown): string => {
  const version = nonEmptyString(name, value);
  if (!STABLE_VERSION_PATTERN.test(version) && !NIGHTLY_VERSION_PATTERN.test(version)) {
    throw new Error(`Nanoni ${name} '${version}' is not in the upstream release grammar.`);
  }
  return version;
};

const validateMetadata = (values: NanoniVersionDefines): NanoniVersionMetadata => {
  const productVersion = validateVersion("productVersion", values.productVersion);
  const compatibleServerVersion = validateVersion(
    "compatibleServerVersion",
    values.compatibleServerVersion,
  );
  const upstreamBaseTag = nonEmptyString("upstreamBaseTag", values.upstreamBaseTag);

  const tagMatch = UPSTREAM_TAG_PATTERN.exec(upstreamBaseTag);
  if (tagMatch?.[1] !== compatibleServerVersion) {
    throw new Error(
      `Nanoni upstreamBaseTag '${upstreamBaseTag}' does not match compatibleServerVersion '${compatibleServerVersion}'.`,
    );
  }

  return { productVersion, compatibleServerVersion, upstreamBaseTag };
};

const hasAnyBuildDefine = (values: NanoniVersionDefines): boolean =>
  values.productVersion !== undefined ||
  values.compatibleServerVersion !== undefined ||
  values.upstreamBaseTag !== undefined;

/**
 * Resolve the exact app/server version pair used by a desktop host.
 *
 * Packaged builds must receive all three Vite defines. Development builds may
 * omit them and use the checked-in product/remote pin as a deterministic
 * fallback. A partially supplied define set is always an error so a release
 * cannot silently ship mismatched metadata.
 */
export function resolveVersionMetadata(
  options: ResolveVersionMetadataOptions = {},
): NanoniVersionMetadata {
  const defines = options.defines ?? readBuildDefines();
  const allowFallback = options.isDevelopment ?? defaultIsDevelopment();
  const metadata = hasAnyBuildDefine(defines)
    ? validateMetadata(defines)
    : allowFallback
      ? validateMetadata(options.fallback ?? fallbackFromCheckedInJson())
      : validateMetadata(defines);

  if (options.shellHelloVersion !== undefined) {
    assertShellHelloVersion(options.shellHelloVersion, metadata);
  }
  return metadata;
}

/** Ensure the Tauri shell's authoritative app version matches the build. */
export function assertShellHelloVersion(
  shellHelloVersion: unknown,
  metadata: Pick<NanoniVersionMetadata, "productVersion">,
): void {
  const actual = nonEmptyString("shell.hello.version", shellHelloVersion);
  if (actual !== metadata.productVersion) {
    throw new Error(
      `Tauri shell version '${actual}' does not match Nanoni productVersion '${metadata.productVersion}'.`,
    );
  }
}

/** Merge version metadata into the immutable-shaped boot object consumed by the shim. */
export function createBootSnapshot(
  options: CreateBootSnapshotOptions = {},
): Readonly<Record<string, unknown>> & NanoniVersionMetadata {
  const metadata = resolveVersionMetadata(options);
  return Object.freeze({ ...(options.base ?? {}), ...metadata });
}

/** Exposed for tests and host composition code that needs the checked-in pin. */
export const checkedInVersionFallback = fallbackFromCheckedInJson;
