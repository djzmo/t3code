import type { NanoniRendererInitScriptOptions } from "./types.ts";
import {
  NANONI_BRIDGE_CHANNELS,
  NANONI_PUSH_CHANNELS,
  NANONI_SSH_PASSWORD_PROMPT_CANCELLED_RESULT,
} from "./bridge.ts";

const DEFAULT_INVOKE_COMMAND = "host_invoke";
const DEFAULT_EVENTS_COMMAND = "desktop_events";

const serializeScriptValue = (value: unknown, label: string): string => {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (cause) {
    throw new TypeError(`Unable to serialize ${label} for the Tauri init script.`, { cause });
  }
  if (serialized === undefined) {
    throw new TypeError(`Unable to serialize ${label} for the Tauri init script.`);
  }

  // Keep the generated source safe when a future caller embeds it in an HTML
  // document or a script-bearing diagnostic page.  JSON remains unchanged
  // after evaluation.
  return serialized
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
};

/**
 * Build the small init script used by every Phase 0 renderer window.
 *
 * The script deliberately uses Tauri's documented internal bridge rather than
 * importing a module: initialization scripts execute before the web bundle and
 * have no module loader.  The callback/channel shape mirrors
 * `@tauri-apps/api/core` so the Rust command receives a real Channel marker.
 */
export const createNanoniInitScript = (options: NanoniRendererInitScriptOptions): string => {
  const boot = serializeScriptValue(options.boot ?? {}, "__NANONI_BOOT__");
  const sync = serializeScriptValue(options.sync, "renderer sync values");
  const invokeCommand = serializeScriptValue(
    options.invokeCommand ?? DEFAULT_INVOKE_COMMAND,
    "invoke command",
  );
  const eventsCommand = serializeScriptValue(
    options.eventsCommand ?? DEFAULT_EVENTS_COMMAND,
    "events command",
  );
  const bridgeChannels = serializeScriptValue(NANONI_BRIDGE_CHANNELS, "bridge channels");
  const pushChannels = serializeScriptValue(NANONI_PUSH_CHANNELS, "push channels");
  const sshPasswordPromptCancelledResult = serializeScriptValue(
    NANONI_SSH_PASSWORD_PROMPT_CANCELLED_RESULT,
    "SSH cancellation result type",
  );

  return `(() => {
  "use strict";
  const root = window;
  const internals = root.__TAURI_INTERNALS__;
  if (!internals || typeof internals.invoke !== "function") {
    throw new Error("Agent Nanoni requires the Tauri renderer bridge.");
  }

  const deepFreeze = (value) => {
    if (value === null || (typeof value !== "object" && typeof value !== "function")) {
      return value;
    }
    if (Object.isFrozen(value)) return value;
    Object.freeze(value);
    for (const key of Reflect.ownKeys(value)) {
      deepFreeze(value[key]);
    }
    return value;
  };

  const boot = deepFreeze(
    Object.prototype.hasOwnProperty.call(root, "__NANONI_BOOT__")
      ? root.__NANONI_BOOT__
      : ${boot},
  );
  Object.defineProperty(root, "__NANONI_BOOT__", {
    configurable: false,
    enumerable: true,
    writable: false,
    value: boot,
  });

  const sync = deepFreeze(${sync});
  const listenersByChannel = new Map();
  const listenersFor = (channel) => {
    let listeners = listenersByChannel.get(channel);
    if (listeners === undefined) {
      listeners = new Set();
      listenersByChannel.set(channel, listeners);
    }
    return listeners;
  };
  const onPush = (channel, listener) => {
    if (typeof channel !== "string" || channel.length === 0) {
      throw new TypeError("desktopBridge.on requires a non-empty channel.");
    }
    if (typeof listener !== "function") {
      throw new TypeError("desktopBridge.on requires a listener function.");
    }
    const listeners = listenersFor(channel);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) listenersByChannel.delete(channel);
    };
  };
  const dispatchPush = (value) => {
    if (value === null || typeof value !== "object") return;
    if (typeof value.channel !== "string" || !Object.prototype.hasOwnProperty.call(value, "payload")) {
      return;
    }
    const listeners = listenersByChannel.get(value.channel);
    if (listeners === undefined) return;
    for (const listener of [...listeners]) listener(value.payload);
  };

  let callbackId;
  let nextMessageIndex = 0;
  let endMessageIndex;
  const pendingMessages = new Map();
  const cleanupCallback = () => {
    if (callbackId === undefined || typeof internals.unregisterCallback !== "function") return;
    internals.unregisterCallback(callbackId);
  };
  const consumeChannelMessage = (raw) => {
    if (raw === null || typeof raw !== "object") return;
    const index = raw.index;
    if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0) return;
    if (Object.prototype.hasOwnProperty.call(raw, "end")) {
      if (index === nextMessageIndex) cleanupCallback();
      else endMessageIndex = index;
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(raw, "message")) return;
    if (index < nextMessageIndex) return;
    if (index > nextMessageIndex) {
      if (!pendingMessages.has(index)) pendingMessages.set(index, raw.message);
      return;
    }
    dispatchPush(raw.message);
    nextMessageIndex += 1;
    while (pendingMessages.has(nextMessageIndex)) {
      dispatchPush(pendingMessages.get(nextMessageIndex));
      pendingMessages.delete(nextMessageIndex);
      nextMessageIndex += 1;
    }
    if (endMessageIndex === nextMessageIndex) cleanupCallback();
  };

  let eventsReady = Promise.resolve(false);
  if (typeof internals.transformCallback === "function") {
    callbackId = internals.transformCallback(consumeChannelMessage);
    const channelMarker = () => "__CHANNEL__:" + callbackId;
    const eventChannel = {
      toJSON: channelMarker,
      __TAURI_TO_IPC_KEY__: channelMarker,
    };
    eventsReady = Promise.resolve(internals.invoke(${eventsCommand}, { channel: eventChannel }))
      .then(() => true)
      .catch(() => {
        cleanupCallback();
        return false;
      });
  }

  const invoke = (channel, payload) => {
    if (typeof channel !== "string" || channel.length === 0) {
      return Promise.reject(new TypeError("desktopBridge.invoke requires a non-empty channel."));
    }
    return Promise.resolve(internals.invoke(${invokeCommand}, { channel, payload })).catch((cause) => {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new Error("Error invoking remote method '" + channel + "': " + message);
    });
  };

  const channels = ${bridgeChannels};
  const pushChannels = ${pushChannels};
  const call = (method, payload) => invoke(channels[method], payload);
  const onObject = (channel, listener) =>
    onPush(channel, (value) => {
      if (value === null || typeof value !== "object") return;
      listener(value);
    });
  const ensureSshEnvironment = async (target, options) => {
    const result = await call("ensureSshEnvironment", {
      target,
      ...(options === undefined ? {} : { options }),
    });
    if (
      result !== null &&
      typeof result === "object" &&
      result.type === ${sshPasswordPromptCancelledResult}
    ) {
      const message = typeof result.message === "string" ? result.message : "SSH authentication cancelled.";
      throw new Error(message);
    }
    return result;
  };

  const bridge = Object.freeze({
    getAppBranding: () => sync.appBranding,
    getClientPlatform: () => sync.clientPlatform,
    getSystemLocale: () => sync.systemLocale,
    getLocalEnvironmentBootstraps: () => sync.localEnvironmentBootstraps,
    getLocalEnvironmentBearerToken: () => call("getLocalEnvironmentBearerToken", null),
    getClientSettings: () => call("getClientSettings", null),
    setClientSettings: (settings) => call("setClientSettings", settings),
    getConnectionCatalog: () => call("getConnectionCatalog", null),
    setConnectionCatalog: (catalog) => call("setConnectionCatalog", catalog),
    clearConnectionCatalog: () => call("clearConnectionCatalog", null),
    discoverSshHosts: () => call("discoverSshHosts", null),
    ensureSshEnvironment,
    disconnectSshEnvironment: (target) => call("disconnectSshEnvironment", target),
    fetchSshEnvironmentDescriptor: (httpBaseUrl) =>
      call("fetchSshEnvironmentDescriptor", { httpBaseUrl }),
    bootstrapSshBearerSession: (httpBaseUrl, credential) =>
      call("bootstrapSshBearerSession", { httpBaseUrl, credential }),
    fetchSshSessionState: (httpBaseUrl, bearerToken) =>
      call("fetchSshSessionState", { httpBaseUrl, bearerToken }),
    issueSshWebSocketTicket: (httpBaseUrl, bearerToken) =>
      call("issueSshWebSocketTicket", { httpBaseUrl, bearerToken }),
    onSshPasswordPrompt: (listener) => onObject(pushChannels.onSshPasswordPrompt, listener),
    resolveSshPasswordPrompt: (requestId, password) =>
      call("resolveSshPasswordPrompt", { requestId, password }),
    getServerExposureState: () => call("getServerExposureState", null),
    setServerExposureMode: (mode) => call("setServerExposureMode", mode),
    setTailscaleServeEnabled: (input) => call("setTailscaleServeEnabled", input),
    getAdvertisedEndpoints: () => call("getAdvertisedEndpoints", null),
    getWslState: () => call("getWslState", null),
    setWslBackendEnabled: (enabled) => call("setWslBackendEnabled", enabled),
    setWslDistro: (distro) => call("setWslDistro", distro),
    setWslOnly: (enabled) => call("setWslOnly", enabled),
    pickFolder: (options) => call("pickFolder", options === undefined ? {} : options),
    pickProjectFavicon: (initialPath) => call("pickProjectFavicon", initialPath),
    pickThemeFiles: () => call("pickThemeFiles", null),
    setTheme: (theme) => call("setTheme", theme),
    showContextMenu: (items, position) =>
      call("showContextMenu", {
        items,
        ...(position === undefined ? {} : { position }),
      }),
    openExternal: (url) => call("openExternal", url),
    probeRemoteEditors: () => call("probeRemoteEditors", null),
    onMenuAction: (listener) =>
      onPush(pushChannels.onMenuAction, (action) => {
        if (typeof action !== "string") return;
        listener(action);
      }),
    onQuitShortcut: (listener) =>
      onPush(pushChannels.onQuitShortcut, (state) => {
        if (state !== "down" && state !== "up") return;
        listener(state);
      }),
    getWindowFullscreenState: () => sync.windowFullscreenState === true,
    onWindowFullscreenStateChange: (listener) =>
      onPush(pushChannels.onWindowFullscreenStateChange, (fullscreen) => {
        if (typeof fullscreen !== "boolean") return;
        listener(fullscreen);
      }),
    getUpdateState: () => call("getUpdateState", null),
    setUpdateChannel: (channel) => call("setUpdateChannel", channel),
    checkForUpdate: () => call("checkForUpdate", null),
    downloadUpdate: () => call("downloadUpdate", null),
    installUpdate: () => call("installUpdate", null),
    onUpdateState: (listener) => onObject(pushChannels.onUpdateState, listener),
  });
  Object.defineProperty(root, "desktopBridge", {
    configurable: false,
    enumerable: true,
    writable: false,
    value: bridge,
  });
  Object.defineProperty(root, "__NANONI_EVENTS_READY__", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: eventsReady,
  });
})();`;
};

/** Frozen bootstrap artifact embedded by the native window builder. */
export const createDefaultNanoniInitScript = (): string =>
  createNanoniInitScript({
    sync: {
      appBranding: null,
      clientPlatform: "unknown",
      systemLocale: null,
      localEnvironmentBootstraps: [],
      windowFullscreenState: false,
    },
  });

export { DEFAULT_EVENTS_COMMAND, DEFAULT_INVOKE_COMMAND };
