import type { RemoteT3RunnerOptions } from "@t3tools/ssh/tunnel";

import remoteCliJson from "../../../src-tauri/remote-cli.json" with { type: "json" };

export interface ResolveTauriSshCliRunnerInput {
  readonly isDevelopment: boolean;
  readonly devRemoteEntryPath?: string;
  /**
   * Optional compatibility assertion for callers that already have the pin.
   * The canonical value always comes from remote-cli.json.
   */
  readonly packageSpec?: string;
  readonly nodeEngineRange: string;
}

export interface RemoteCliPin {
  readonly upstreamTag: string;
  readonly packageSpec: string;
}

export interface ResolvedRemoteCliPin extends RemoteCliPin {
  readonly compatibleServerVersion: string;
}

const UPSTREAM_VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-nightly\.\d{8}\.\d+)?$/;
const UPSTREAM_TAG_PATTERN = /^v(.+)$/;

const requireNonEmpty = (name: string, value: string): string => {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`Tauri SSH CLI runner requires a non-empty ${name}.`);
  }
  return normalized;
};

const resolveRemoteCliPinFromUnknown = (value: unknown): RemoteCliPin => {
  if (typeof value !== "object" || value === null) {
    throw new Error("Tauri remote CLI pin must be an object.");
  }

  const record = value as Record<string, unknown>;
  if (typeof record.upstreamTag !== "string" || typeof record.packageSpec !== "string") {
    throw new Error("Tauri remote CLI pin requires upstreamTag and packageSpec strings.");
  }

  return {
    upstreamTag: requireNonEmpty("upstream tag", record.upstreamTag),
    packageSpec: requireNonEmpty("package specification", record.packageSpec),
  };
};

/**
 * Derive the server compatibility version from the exact upstream tag.
 *
 * The package specification is deliberately checked against that derivation;
 * accepting a mismatched package would make a release look compatible while
 * provisioning a different server.
 */
export const resolveRemoteCliPin = (input: RemoteCliPin): ResolvedRemoteCliPin => {
  const upstreamTag = requireNonEmpty("upstream tag", input.upstreamTag);
  const packageSpec = requireNonEmpty("package specification", input.packageSpec);
  const tagMatch = UPSTREAM_TAG_PATTERN.exec(upstreamTag);
  const compatibleServerVersion = tagMatch?.[1];

  if (
    compatibleServerVersion === undefined ||
    !UPSTREAM_VERSION_PATTERN.test(compatibleServerVersion)
  ) {
    throw new Error(`Unsupported upstream tag '${upstreamTag}'.`);
  }

  const expectedPackageSpec = `t3@${compatibleServerVersion}`;
  if (packageSpec !== expectedPackageSpec) {
    throw new Error(
      `Package specification '${packageSpec}' does not match upstream tag '${upstreamTag}'.`,
    );
  }

  return { upstreamTag, packageSpec, compatibleServerVersion };
};

/** The checked-in pin is the only packaged SSH CLI source of truth. */
export const REMOTE_CLI_PIN = resolveRemoteCliPin(resolveRemoteCliPinFromUnknown(remoteCliJson));

/**
 * Resolve the runner shape consumed by the shared SSH tunnel.
 *
 * Development keeps using the local server entry path. Packaged and fallback
 * launches always consume the checked-in exact release pin; there is no
 * channel-based or floating package resolution at this boundary.
 */
export const resolveTauriSshCliRunner = (
  input: ResolveTauriSshCliRunnerInput,
): RemoteT3RunnerOptions => {
  const nodeEngineRange = requireNonEmpty("Node engine range", input.nodeEngineRange);
  const devRemoteEntryPath = input.devRemoteEntryPath?.trim();

  if (input.isDevelopment && devRemoteEntryPath !== undefined && devRemoteEntryPath.length > 0) {
    return {
      nodeScriptPath: devRemoteEntryPath,
      nodeEngineRange,
    };
  }

  const suppliedPackageSpec = input.packageSpec?.trim();
  if (suppliedPackageSpec !== undefined && suppliedPackageSpec.length === 0) {
    throw new Error("Tauri SSH CLI runner requires a non-empty package specification.");
  }
  if (suppliedPackageSpec !== undefined && suppliedPackageSpec !== REMOTE_CLI_PIN.packageSpec) {
    throw new Error(
      `Tauri SSH CLI runner package specification must be '${REMOTE_CLI_PIN.packageSpec}'.`,
    );
  }

  return {
    packageSpec: REMOTE_CLI_PIN.packageSpec,
    nodeEngineRange,
  };
};
