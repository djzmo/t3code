import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as DesktopEnvironmentService from "../../app/DesktopEnvironment.ts";

type DesktopEnvironment = DesktopEnvironmentService.DesktopEnvironment["Service"];

/**
 * Keep the shared DesktopEnvironment service key for the Tauri host.  The
 * service implementation is deliberately imported from the Electron-neutral
 * environment module; this adapter does not load the Electron runtime.
 */
export const DesktopEnvironment = DesktopEnvironmentService.DesktopEnvironment;

export interface TauriEnvironmentIdentity {
  readonly branding: DesktopEnvironment["branding"];
  readonly displayName: string;
  readonly appUserModelId: string;
  readonly linuxDesktopEntryName: string;
  readonly linuxWmClass: string;
  readonly userDataDirName: string;
  readonly legacyUserDataDirName: string;
}

export interface TauriEnvironmentInput
  extends DesktopEnvironmentService.MakeDesktopEnvironmentInput {
  /** Identity comes from the shell/owner configuration; it is not frozen here. */
  readonly identity: TauriEnvironmentIdentity;
}

const baseInput = ({ identity: _identity, ...input }: TauriEnvironmentInput) => input;

const decorate = (
  environment: DesktopEnvironment,
  input: TauriEnvironmentInput,
): DesktopEnvironment => {
  const packagedServerRoot = environment.path.join(input.resourcesPath, "server");
  const appRoot = input.isPackaged ? packagedServerRoot : environment.appRoot;
  const serverRoot = input.isPackaged ? packagedServerRoot : environment.serverRoot;

  return {
    ...environment,
    appRoot,
    serverRoot,
    backendEntryPath: environment.path.join(serverRoot, "apps/server/dist/bin.mjs"),
    appUpdateYmlPath: environment.path.join(input.resourcesPath, "app-update.yml"),
    branding: input.identity.branding,
    displayName: input.identity.displayName,
    appUserModelId: input.identity.appUserModelId,
    linuxDesktopEntryName: input.identity.linuxDesktopEntryName,
    linuxWmClass: input.identity.linuxWmClass,
    userDataDirName: input.identity.userDataDirName,
    legacyUserDataDirName: input.identity.legacyUserDataDirName,
  };
};

const make = (input: TauriEnvironmentInput) =>
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironmentService.DesktopEnvironment;
    return decorate(environment, input);
  }).pipe(Effect.provide(DesktopEnvironmentService.layer(baseInput(input))));

export const layer = (input: TauriEnvironmentInput) =>
  Layer.effect(DesktopEnvironmentService.DesktopEnvironment, make(input));
