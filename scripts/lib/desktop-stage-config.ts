export type DesktopStagePlatform = "mac" | "linux" | "win";
export type DesktopStageArch = "arm64" | "x64" | "universal";

export interface DesktopStageWorkspaceConfig {
  readonly supportedArchitectures: {
    readonly os: ReadonlyArray<string>;
    readonly cpu: ReadonlyArray<string>;
    readonly libc?: ReadonlyArray<string>;
  };
  readonly allowBuilds?: Readonly<Record<string, boolean>>;
  readonly patchedDependencies?: Readonly<Record<string, string>>;
  readonly overrides?: Readonly<Record<string, string>>;
  readonly nodeLinker?: "hoisted";
}

export function resolveFffNativeDependencies(
  platform: DesktopStagePlatform,
  arch: DesktopStageArch,
  version: string,
): Record<string, string> {
  const architectures = arch === "universal" ? (["arm64", "x64"] as const) : [arch];

  if (platform === "mac") {
    return Object.fromEntries(
      architectures.map((architecture) => [`@ff-labs/fff-bin-darwin-${architecture}`, version]),
    );
  }
  if (platform === "win") {
    return Object.fromEntries(
      architectures.map((architecture) => [`@ff-labs/fff-bin-win32-${architecture}`, version]),
    );
  }
  return Object.fromEntries(
    architectures.flatMap((architecture) =>
      ["gnu", "musl"].map((libc) => [`@ff-labs/fff-bin-linux-${architecture}-${libc}`, version]),
    ),
  );
}

export function createStageWorkspaceConfig(input: {
  readonly platform: DesktopStagePlatform;
  readonly arch: DesktopStageArch;
  readonly allowBuilds?: Record<string, boolean>;
  readonly patchedDependencies?: Record<string, string>;
  readonly overrides?: Record<string, string>;
  readonly linuxServerBackend?: boolean;
}): DesktopStageWorkspaceConfig {
  const { platform, arch, allowBuilds, patchedDependencies, overrides, linuxServerBackend } = input;
  const hostOs = platform === "mac" ? "darwin" : platform === "win" ? "win32" : "linux";
  const hostCpu = arch === "universal" ? ["arm64", "x64"] : [arch];
  const supportedArchitectures =
    platform === "linux"
      ? { os: [hostOs], cpu: hostCpu, libc: ["glibc"] }
      : linuxServerBackend
        ? { os: Array.from(new Set([hostOs, "linux"])), cpu: hostCpu, libc: ["glibc"] }
        : { os: [hostOs], cpu: hostCpu };

  return {
    supportedArchitectures,
    ...(allowBuilds && Object.keys(allowBuilds).length > 0 ? { allowBuilds } : {}),
    ...(patchedDependencies && Object.keys(patchedDependencies).length > 0
      ? { patchedDependencies }
      : {}),
    ...(overrides && Object.keys(overrides).length > 0 ? { overrides } : {}),
    ...(linuxServerBackend ? { nodeLinker: "hoisted" as const } : {}),
  };
}

export function createStagePatchedDependencies(
  patchedDependencies: Record<string, string>,
  dependencies: Record<string, unknown>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(patchedDependencies).filter(([patchKey]) =>
      Object.hasOwn(dependencies, patchedDependencyPackageName(patchKey)),
    ),
  );
}

function patchedDependencyPackageName(patchKey: string): string {
  const versionSeparator = patchKey.lastIndexOf("@");
  return versionSeparator > 0 ? patchKey.slice(0, versionSeparator) : patchKey;
}
