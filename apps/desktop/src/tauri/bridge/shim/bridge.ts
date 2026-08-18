import type { ContextMenuItem, DesktopBridge } from "@t3tools/contracts";

import * as IpcChannels from "../../../ipc/channels.ts";

import type { NanoniRendererSyncSnapshot } from "./types.ts";

/**
 * The renderer-facing surface implemented by the Tauri shim.  Preview is
 * deliberately absent in Phase 0; the upstream web client treats an absent
 * preview member as the supported non-preview desktop surface.
 */
export type NanoniDesktopBridge = Omit<DesktopBridge, "preview">;

/**
 * Keep the channel table beside the shim rather than spelling channel strings
 * in the generated init script.  `satisfies` makes additions to
 * `DesktopBridge` fail loudly until the preload parity mapping is updated.
 */
export const NANONI_BRIDGE_CHANNELS = {
  getLocalEnvironmentBearerToken: IpcChannels.GET_LOCAL_ENVIRONMENT_BEARER_TOKEN_CHANNEL,
  getClientSettings: IpcChannels.GET_CLIENT_SETTINGS_CHANNEL,
  setClientSettings: IpcChannels.SET_CLIENT_SETTINGS_CHANNEL,
  getConnectionCatalog: IpcChannels.GET_CONNECTION_CATALOG_CHANNEL,
  setConnectionCatalog: IpcChannels.SET_CONNECTION_CATALOG_CHANNEL,
  clearConnectionCatalog: IpcChannels.CLEAR_CONNECTION_CATALOG_CHANNEL,
  discoverSshHosts: IpcChannels.DISCOVER_SSH_HOSTS_CHANNEL,
  ensureSshEnvironment: IpcChannels.ENSURE_SSH_ENVIRONMENT_CHANNEL,
  disconnectSshEnvironment: IpcChannels.DISCONNECT_SSH_ENVIRONMENT_CHANNEL,
  fetchSshEnvironmentDescriptor: IpcChannels.FETCH_SSH_ENVIRONMENT_DESCRIPTOR_CHANNEL,
  bootstrapSshBearerSession: IpcChannels.BOOTSTRAP_SSH_BEARER_SESSION_CHANNEL,
  fetchSshSessionState: IpcChannels.FETCH_SSH_SESSION_STATE_CHANNEL,
  issueSshWebSocketTicket: IpcChannels.ISSUE_SSH_WEBSOCKET_TOKEN_CHANNEL,
  resolveSshPasswordPrompt: IpcChannels.RESOLVE_SSH_PASSWORD_PROMPT_CHANNEL,
  getServerExposureState: IpcChannels.GET_SERVER_EXPOSURE_STATE_CHANNEL,
  setServerExposureMode: IpcChannels.SET_SERVER_EXPOSURE_MODE_CHANNEL,
  setTailscaleServeEnabled: IpcChannels.SET_TAILSCALE_SERVE_ENABLED_CHANNEL,
  getAdvertisedEndpoints: IpcChannels.GET_ADVERTISED_ENDPOINTS_CHANNEL,
  getWslState: IpcChannels.GET_WSL_STATE_CHANNEL,
  setWslBackendEnabled: IpcChannels.SET_WSL_BACKEND_ENABLED_CHANNEL,
  setWslDistro: IpcChannels.SET_WSL_DISTRO_CHANNEL,
  setWslOnly: IpcChannels.SET_WSL_ONLY_CHANNEL,
  pickFolder: IpcChannels.PICK_FOLDER_CHANNEL,
  pickThemeFiles: IpcChannels.PICK_THEME_FILES_CHANNEL,
  setTheme: IpcChannels.SET_THEME_CHANNEL,
  showContextMenu: IpcChannels.CONTEXT_MENU_CHANNEL,
  openExternal: IpcChannels.OPEN_EXTERNAL_CHANNEL,
  probeRemoteEditors: IpcChannels.PROBE_REMOTE_EDITORS_CHANNEL,
  getUpdateState: IpcChannels.UPDATE_GET_STATE_CHANNEL,
  setUpdateChannel: IpcChannels.UPDATE_SET_CHANNEL_CHANNEL,
  checkForUpdate: IpcChannels.UPDATE_CHECK_CHANNEL,
  downloadUpdate: IpcChannels.UPDATE_DOWNLOAD_CHANNEL,
  installUpdate: IpcChannels.UPDATE_INSTALL_CHANNEL,
  getAppBranding: IpcChannels.GET_APP_BRANDING_CHANNEL,
  getSystemLocale: IpcChannels.GET_SYSTEM_LOCALE_CHANNEL,
  getLocalEnvironmentBootstraps: IpcChannels.GET_LOCAL_ENVIRONMENT_BOOTSTRAPS_CHANNEL,
  getWindowFullscreenState: IpcChannels.GET_WINDOW_FULLSCREEN_STATE_CHANNEL,
} as const satisfies Record<NanoniBridgeInvokeMethod, string>;

/** Event channels sent by `ElectronWindow.sendAll`/`TauriWindow.webContents.send`. */
export const NANONI_PUSH_CHANNELS = {
  onSshPasswordPrompt: IpcChannels.SSH_PASSWORD_PROMPT_CHANNEL,
  onMenuAction: IpcChannels.MENU_ACTION_CHANNEL,
  onQuitShortcut: IpcChannels.QUIT_SHORTCUT_CHANNEL,
  onWindowFullscreenStateChange: IpcChannels.WINDOW_FULLSCREEN_STATE_CHANNEL,
  onUpdateState: IpcChannels.UPDATE_STATE_CHANNEL,
} as const;

export const NANONI_SSH_PASSWORD_PROMPT_CANCELLED_RESULT =
  IpcChannels.SSH_PASSWORD_PROMPT_CANCELLED_RESULT;

export interface NanoniBridgeTransport {
  readonly sync: NanoniRendererSyncSnapshot;
  readonly invoke: <T>(channel: string, payload: unknown) => Promise<T>;
  readonly on: <T>(channel: string, listener: (payload: T) => void) => () => void;
}

type ResultOf<Method> = Method extends (...args: infer _Args) => infer Result
  ? Awaited<Result>
  : never;

type NanoniBridgeInvokeMethod = Exclude<
  keyof NanoniDesktopBridge,
  | "onMenuAction"
  | "onQuitShortcut"
  | "onSshPasswordPrompt"
  | "onUpdateState"
  | "onWindowFullscreenStateChange"
>;

type EnsureBootstrap = ResultOf<NanoniDesktopBridge["ensureSshEnvironment"]>;
type EnsureCancelled = {
  readonly type: typeof NANONI_SSH_PASSWORD_PROMPT_CANCELLED_RESULT;
  readonly message: string;
};
type EnsureResult = EnsureBootstrap | EnsureCancelled;

const isEnsureCancelled = (value: EnsureResult): value is EnsureCancelled =>
  typeof value === "object" &&
  value !== null &&
  "type" in value &&
  value.type === NANONI_SSH_PASSWORD_PROMPT_CANCELLED_RESULT;

const formatInvokeError = (channel: string, cause: unknown): Error => {
  const message = cause instanceof Error ? cause.message : String(cause);
  return new Error(`Error invoking remote method '${channel}': ${message}`, { cause });
};

/**
 * Pure bridge factory used by parity tests and by host-side adapters.  The
 * init script contains the same small object inlined because it runs before a
 * module loader exists in the renderer.
 */
export const makeNanoniDesktopBridge = (transport: NanoniBridgeTransport): NanoniDesktopBridge => {
  const invoke = <T>(channel: string, payload: unknown): Promise<T> =>
    transport.invoke<T>(channel, payload).catch((cause) => {
      throw formatInvokeError(channel, cause);
    });

  const invokeMethod = <K extends NanoniBridgeInvokeMethod>(
    method: K,
    payload: unknown,
  ): Promise<ResultOf<NanoniDesktopBridge[K]>> =>
    invoke<ResultOf<NanoniDesktopBridge[K]>>(NANONI_BRIDGE_CHANNELS[method], payload);

  const bridge = {
    getAppBranding: () => transport.sync.appBranding,
    getSystemLocale: () => transport.sync.systemLocale,
    getLocalEnvironmentBootstraps: () => transport.sync.localEnvironmentBootstraps,
    getLocalEnvironmentBearerToken: () => invokeMethod("getLocalEnvironmentBearerToken", null),
    getClientSettings: () => invokeMethod("getClientSettings", null),
    setClientSettings: (settings) => invokeMethod("setClientSettings", settings),
    getConnectionCatalog: () => invokeMethod("getConnectionCatalog", null),
    setConnectionCatalog: (catalog) => invokeMethod("setConnectionCatalog", catalog),
    clearConnectionCatalog: () => invokeMethod("clearConnectionCatalog", null),
    discoverSshHosts: () => invokeMethod("discoverSshHosts", null),
    ensureSshEnvironment: async (target, options) => {
      const result = await invoke<EnsureResult>(NANONI_BRIDGE_CHANNELS.ensureSshEnvironment, {
        target,
        ...(options === undefined ? {} : { options }),
      });
      if (isEnsureCancelled(result)) {
        throw new Error(result.message);
      }
      return result;
    },
    disconnectSshEnvironment: (target) => invokeMethod("disconnectSshEnvironment", target),
    fetchSshEnvironmentDescriptor: (httpBaseUrl) =>
      invokeMethod("fetchSshEnvironmentDescriptor", { httpBaseUrl }),
    bootstrapSshBearerSession: (httpBaseUrl, credential) =>
      invokeMethod("bootstrapSshBearerSession", { httpBaseUrl, credential }),
    fetchSshSessionState: (httpBaseUrl, bearerToken) =>
      invokeMethod("fetchSshSessionState", { httpBaseUrl, bearerToken }),
    issueSshWebSocketTicket: (httpBaseUrl, bearerToken) =>
      invokeMethod("issueSshWebSocketTicket", { httpBaseUrl, bearerToken }),
    onSshPasswordPrompt: (listener) =>
      transport.on(NANONI_PUSH_CHANNELS.onSshPasswordPrompt, listener),
    resolveSshPasswordPrompt: (requestId, password) =>
      invokeMethod("resolveSshPasswordPrompt", { requestId, password }),
    getServerExposureState: () => invokeMethod("getServerExposureState", null),
    setServerExposureMode: (mode) => invokeMethod("setServerExposureMode", mode),
    setTailscaleServeEnabled: (input) => invokeMethod("setTailscaleServeEnabled", input),
    getAdvertisedEndpoints: () => invokeMethod("getAdvertisedEndpoints", null),
    getWslState: () => invokeMethod("getWslState", null),
    setWslBackendEnabled: (enabled) => invokeMethod("setWslBackendEnabled", enabled),
    setWslDistro: (distro) => invokeMethod("setWslDistro", distro),
    setWslOnly: (enabled) => invokeMethod("setWslOnly", enabled),
    pickFolder: (options) => invokeMethod("pickFolder", options === undefined ? {} : options),
    pickThemeFiles: () => invokeMethod("pickThemeFiles", null),
    setTheme: (theme) => invokeMethod("setTheme", theme),
    showContextMenu: <T extends string>(
      items: readonly ContextMenuItem<T>[],
      position: { readonly x: number; readonly y: number } | undefined,
    ) =>
      invoke<T | null>(NANONI_BRIDGE_CHANNELS.showContextMenu, {
        items,
        ...(position === undefined ? {} : { position }),
      }),
    openExternal: (url) => invokeMethod("openExternal", url),
    probeRemoteEditors: () => invokeMethod("probeRemoteEditors", null),
    onMenuAction: (listener) => transport.on(NANONI_PUSH_CHANNELS.onMenuAction, listener),
    onQuitShortcut: (listener) => transport.on(NANONI_PUSH_CHANNELS.onQuitShortcut, listener),
    getWindowFullscreenState: () => transport.sync.windowFullscreenState ?? false,
    onWindowFullscreenStateChange: (listener) =>
      transport.on(NANONI_PUSH_CHANNELS.onWindowFullscreenStateChange, listener),
    getUpdateState: () => invokeMethod("getUpdateState", null),
    setUpdateChannel: (channel) => invokeMethod("setUpdateChannel", channel),
    checkForUpdate: () => invokeMethod("checkForUpdate", null),
    downloadUpdate: () => invokeMethod("downloadUpdate", null),
    installUpdate: () => invokeMethod("installUpdate", null),
    onUpdateState: (listener) => transport.on(NANONI_PUSH_CHANNELS.onUpdateState, listener),
  } satisfies NanoniDesktopBridge;

  return bridge;
};
