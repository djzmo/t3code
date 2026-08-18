import type { RemoteT3RunnerOptions } from "@t3tools/ssh/tunnel";

export interface ResolveTauriSshCliRunnerInput {
  readonly isDevelopment: boolean;
  readonly devRemoteEntryPath?: string;
  readonly packageSpec: string;
  readonly nodeEngineRange: string;
}

const requireNonEmpty = (name: string, value: string): string => {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`Tauri SSH CLI runner requires a non-empty ${name}.`);
  }
  return normalized;
};

/**
 * Resolve the runner shape consumed by the shared SSH tunnel.
 *
 * Phase 0 deliberately leaves the values to the host composition. V3a owns
 * resolving the pinned packageSpec; this helper only prevents an accidental
 * empty value from falling through to an unpinned `npx t3` invocation.
 */
export const resolveTauriSshCliRunner = (
  input: ResolveTauriSshCliRunnerInput,
): RemoteT3RunnerOptions => {
  const packageSpec = requireNonEmpty("package specification", input.packageSpec);
  const nodeEngineRange = requireNonEmpty("Node engine range", input.nodeEngineRange);
  const devRemoteEntryPath = input.devRemoteEntryPath?.trim();

  if (input.isDevelopment && devRemoteEntryPath !== undefined && devRemoteEntryPath.length > 0) {
    return {
      nodeScriptPath: devRemoteEntryPath,
      nodeEngineRange,
    };
  }

  return {
    packageSpec,
    nodeEngineRange,
  };
};
