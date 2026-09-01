// @effect-diagnostics nodeBuiltinImport:off - this pure helper selects path dialects explicitly.
import * as NodePath from "node:path";

/**
 * The three platforms whose path rules matter to the desktop shell.  The
 * implementation deliberately chooses the path dialect from this value
 * rather than from the machine running the resolver, which keeps startup
 * decisions deterministic in tests and when the host is cross-compiled.
 */
export type HomePlatform = "win32" | "darwin" | "linux";

export type HomeSource = "cli" | "worktree" | "ambient" | "default" | "packaged";

export interface ResolveHomeInput {
  /** `true` for the installed/resource layout; `false` for the dev loop. */
  readonly isPackaged: boolean;
  readonly platform: HomePlatform;
  /** The operating-system home directory reported by the host. */
  readonly homeDirectory: string;
  /** `--home-dir` (or an equivalent explicit T3CODE_HOME override). */
  readonly explicitHome?: string;
  /** Canonical git worktree root, when the dev process is inside a worktree. */
  readonly worktreePath?: string;
  /** Ambient T3CODE_HOME. It is ignored whenever worktreePath is present. */
  readonly ambientHome?: string;
  /** Base for relative development overrides. Defaults to homeDirectory. */
  readonly cwd?: string;
}

export interface ResolvedHome {
  /** The value supplied to T3CODE_HOME / the app's base directory. */
  readonly baseDir: string;
  /** The directory containing desktop state and the server's userdata. */
  readonly stateDir: string;
  readonly source: HomeSource;
}

export class HomeResolutionError extends Error {
  readonly _tag = "HomeResolutionError";

  constructor(message: string) {
    super(message);
    this.name = "HomeResolutionError";
  }
}

interface PathApi {
  readonly isAbsolute: (path: string) => boolean;
  readonly resolve: (...paths: string[]) => string;
  readonly join: (...paths: string[]) => string;
}

const pathForPlatform = (platform: HomePlatform): PathApi =>
  platform === "win32" ? NodePath.win32 : NodePath.posix;

const requireNonEmpty = (name: string, value: string): string => {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new HomeResolutionError(`${name} must not be empty.`);
  }
  return trimmed;
};

const requireAbsolute = (name: string, value: string, path: PathApi): string => {
  const trimmed = requireNonEmpty(name, value);
  if (!path.isAbsolute(trimmed)) {
    throw new HomeResolutionError(`${name} must be an absolute path; received '${value}'.`);
  }
  return path.resolve(trimmed);
};

const optionalConfiguredPath = (
  name: string,
  value: string | undefined,
  path: PathApi,
  base: string,
): string | undefined => {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }

  const trimmed = value.trim();
  // `path.resolve` is intentionally given an explicit base.  A resolver used
  // during startup must not depend on process.cwd(), otherwise two launches
  // with the same inputs can select different databases.
  return path.resolve(base, trimmed);
};

/**
 * Resolve the Agent Nanoni data home without touching the filesystem.
 *
 * Development precedence is the same as the dev runner:
 * explicit `--home-dir`, worktree-local `.t3`, ambient `T3CODE_HOME`,
 * then a safe per-user `.t3/tauri` default.  In particular, a worktree never
 * falls through to an ambient home, which could otherwise select the live
 * `~/.t3/userdata` database.  Packaged builds use only the frozen identity
 * path `<os-home>/.agent-nanoni/userdata`.
 */
export const resolveHome = (input: ResolveHomeInput): ResolvedHome => {
  const path = pathForPlatform(input.platform);
  const homeDirectory = requireAbsolute("homeDirectory", input.homeDirectory, path);

  if (input.isPackaged) {
    const baseDir = path.join(homeDirectory, ".agent-nanoni");
    return {
      baseDir,
      stateDir: path.join(baseDir, "userdata"),
      source: "packaged",
    };
  }

  const resolutionBase =
    optionalConfiguredPath("cwd", input.cwd, path, homeDirectory) ?? homeDirectory;
  const explicitHome = optionalConfiguredPath(
    "explicitHome",
    input.explicitHome,
    path,
    resolutionBase,
  );
  if (explicitHome !== undefined) {
    return {
      baseDir: explicitHome,
      stateDir: path.join(explicitHome, "userdata"),
      source: "cli",
    };
  }

  const worktreePath = optionalConfiguredPath(
    "worktreePath",
    input.worktreePath,
    path,
    resolutionBase,
  );
  if (worktreePath !== undefined) {
    const baseDir = path.join(worktreePath, ".t3");
    return {
      baseDir,
      stateDir: path.join(baseDir, "userdata"),
      source: "worktree",
    };
  }

  const ambientHome = optionalConfiguredPath(
    "ambientHome",
    input.ambientHome,
    path,
    resolutionBase,
  );
  if (ambientHome !== undefined) {
    return {
      baseDir: ambientHome,
      stateDir: path.join(ambientHome, "userdata"),
      source: "ambient",
    };
  }

  const baseDir = path.join(homeDirectory, ".t3", "tauri");
  return {
    baseDir,
    stateDir: path.join(baseDir, "userdata"),
    source: "default",
  };
};
