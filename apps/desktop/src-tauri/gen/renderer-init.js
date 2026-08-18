(() => {
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
      : {},
  );
  Object.defineProperty(root, "__NANONI_BOOT__", {
    configurable: false,
    enumerable: true,
    writable: false,
    value: boot,
  });

  const sync = deepFreeze({"appBranding":null,"systemLocale":null,"localEnvironmentBootstraps":[],"windowFullscreenState":false});
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
    eventsReady = Promise.resolve(internals.invoke("desktop_events", { channel: eventChannel }))
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
    return Promise.resolve(internals.invoke("host_invoke", { channel, payload })).catch((cause) => {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new Error("Error invoking remote method '" + channel + "': " + message);
    });
  };

  const channels = {"getLocalEnvironmentBearerToken":"desktop:get-local-environment-bearer-token","getClientSettings":"desktop:get-client-settings","setClientSettings":"desktop:set-client-settings","getConnectionCatalog":"desktop:get-connection-catalog","setConnectionCatalog":"desktop:set-connection-catalog","clearConnectionCatalog":"desktop:clear-connection-catalog","discoverSshHosts":"desktop:discover-ssh-hosts","ensureSshEnvironment":"desktop:ensure-ssh-environment","disconnectSshEnvironment":"desktop:disconnect-ssh-environment","fetchSshEnvironmentDescriptor":"desktop:fetch-ssh-environment-descriptor","bootstrapSshBearerSession":"desktop:bootstrap-ssh-bearer-session","fetchSshSessionState":"desktop:fetch-ssh-session-state","issueSshWebSocketTicket":"desktop:issue-ssh-websocket-token","resolveSshPasswordPrompt":"desktop:resolve-ssh-password-prompt","getServerExposureState":"desktop:get-server-exposure-state","setServerExposureMode":"desktop:set-server-exposure-mode","setTailscaleServeEnabled":"desktop:set-tailscale-serve-enabled","getAdvertisedEndpoints":"desktop:get-advertised-endpoints","getWslState":"desktop:get-wsl-state","setWslBackendEnabled":"desktop:set-wsl-backend-enabled","setWslDistro":"desktop:set-wsl-distro","setWslOnly":"desktop:set-wsl-only","pickFolder":"desktop:pick-folder","pickThemeFiles":"desktop:pick-theme-files","setTheme":"desktop:set-theme","showContextMenu":"desktop:context-menu","openExternal":"desktop:open-external","probeRemoteEditors":"desktop:probe-remote-editors","getUpdateState":"desktop:update-get-state","setUpdateChannel":"desktop:update-set-channel","checkForUpdate":"desktop:update-check","downloadUpdate":"desktop:update-download","installUpdate":"desktop:update-install","getAppBranding":"desktop:get-app-branding","getSystemLocale":"desktop:get-system-locale","getLocalEnvironmentBootstraps":"desktop:get-local-environment-bootstraps","getWindowFullscreenState":"desktop:get-window-fullscreen-state"};
  const pushChannels = {"onSshPasswordPrompt":"desktop:ssh-password-prompt","onMenuAction":"desktop:menu-action","onQuitShortcut":"desktop:quit-shortcut","onWindowFullscreenStateChange":"desktop:window-fullscreen-state","onUpdateState":"desktop:update-state"};
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
      result.type === "ssh-password-prompt-cancelled"
    ) {
      const message = typeof result.message === "string" ? result.message : "SSH authentication cancelled.";
      throw new Error(message);
    }
    return result;
  };

  const bridge = Object.freeze({
    getAppBranding: () => sync.appBranding,
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
})();
