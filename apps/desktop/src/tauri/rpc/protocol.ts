import * as Schema from "effect/Schema";

/**
 * The shell/host protocol deliberately stays independent of Tauri.  The same
 * JSON values are consumed by the Node host and by the Rust shell, while the
 * transport and lifecycle implementations remain free to evolve separately.
 */

export const JSON_RPC_VERSION = "2.0" as const;

export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
export const MAX_NESTING_DEPTH = 64;
export const MAX_PENDING_REQUESTS = 1024;
export const PRE_READY_RENDERER_QUEUE_LIMIT = 256;
export const PRE_READY_RENDERER_QUEUE_WINDOW_MS = 20_000;
export const HELLO_TIMEOUT_MS = 15_000;

export const RPC_ERROR_CODES = {
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  platform: -32000,
  unsupported: -32001,
  cancelled: -32002,
  timeout: -32003,
} as const;

export const RPC_ERROR_KINDS = [
  "unsupported",
  "invalid-params",
  "platform",
  "cancelled",
  "timeout",
] as const;

/** Every method named in Appendix B (including the schema-only auth callback). */
export const APPENDIX_B_METHODS = [
  "shell.hello",
  "app.quit",
  "app.exit",
  "app.relaunch",
  "app.focus",
  "app.isProtocolClient",
  "app.setProtocolClient",
  "app.getMetrics",
  "app.before-quit",
  "app.window-all-closed",
  "app.activate",
  "app.second-instance",
  "app.open-url",
  "app.shutdown-complete",
  "process.register",
  "process.unregister",
  "process.cancel",
  "ipc.invoke",
  "ipc.push",
  "window.create",
  "window.show",
  "window.hide",
  "window.close",
  "window.destroy",
  "window.focus",
  "window.minimize",
  "window.restore",
  "window.maximize",
  "window.unmaximize",
  "window.reload",
  "window.toggleDevTools",
  "window.setFullscreen",
  "window.setTitle",
  "window.setBounds",
  "window.setBackgroundColor",
  "window.setZoom",
  "window.setAlwaysOnTop",
  "window.getBounds",
  "window.getState",
  "window.event",
  "dialog.openFolder",
  "dialog.openFiles",
  "dialog.message",
  "dialog.error",
  "menu.setApplication",
  "menu.popup",
  "menu.click",
  "shell.openExternal",
  "shell.showItemInFolder",
  "clipboard.writeText",
  "wsl.registerGuest",
  "wsl.unregisterGuest",
  "auth.callback",
  "theme.get",
  "theme.setSource",
  "theme.updated",
  "safeStorage.status",
  "safeStorage.encrypt",
  "safeStorage.decrypt",
  "updater.configure",
  "updater.check",
  "updater.download",
  "updater.install",
  "updater.progress",
  "power.snapshot",
  "power.event",
] as const;

export const RpcMethodName = Schema.Literals(APPENDIX_B_METHODS);
export type RpcMethodName = typeof RpcMethodName.Type;

export const RpcDirection = Schema.Literals(["host-to-shell", "shell-to-host"]);
export type RpcDirection = typeof RpcDirection.Type;

/** Fixture metadata distinguishes wire requests/notifications from responses. */
export const RpcFixtureKind = Schema.Literals(["request", "notification", "response"]);
export type RpcFixtureKind = typeof RpcFixtureKind.Type;

export type RpcMethodSpec = {
  readonly direction: RpcDirection;
  readonly kind: Exclude<RpcFixtureKind, "response">;
};

/** Canonical direction and request/notification kind from Appendix B. */
export const APPENDIX_B_METHOD_SPECS = {
  "shell.hello": { direction: "host-to-shell", kind: "request" },
  "app.quit": { direction: "host-to-shell", kind: "notification" },
  "app.exit": { direction: "host-to-shell", kind: "notification" },
  "app.relaunch": { direction: "host-to-shell", kind: "notification" },
  "app.focus": { direction: "host-to-shell", kind: "notification" },
  "app.isProtocolClient": { direction: "host-to-shell", kind: "request" },
  "app.setProtocolClient": { direction: "host-to-shell", kind: "request" },
  "app.getMetrics": { direction: "host-to-shell", kind: "request" },
  "app.before-quit": { direction: "shell-to-host", kind: "request" },
  "app.window-all-closed": { direction: "shell-to-host", kind: "notification" },
  "app.activate": { direction: "shell-to-host", kind: "notification" },
  "app.second-instance": { direction: "shell-to-host", kind: "notification" },
  "app.open-url": { direction: "shell-to-host", kind: "notification" },
  "app.shutdown-complete": { direction: "host-to-shell", kind: "notification" },
  "process.register": { direction: "host-to-shell", kind: "request" },
  "process.unregister": { direction: "host-to-shell", kind: "notification" },
  "process.cancel": { direction: "host-to-shell", kind: "notification" },
  "ipc.invoke": { direction: "shell-to-host", kind: "request" },
  "ipc.push": { direction: "host-to-shell", kind: "notification" },
  "window.create": { direction: "host-to-shell", kind: "request" },
  "window.show": { direction: "host-to-shell", kind: "notification" },
  "window.hide": { direction: "host-to-shell", kind: "notification" },
  "window.close": { direction: "host-to-shell", kind: "notification" },
  "window.destroy": { direction: "host-to-shell", kind: "notification" },
  "window.focus": { direction: "host-to-shell", kind: "notification" },
  "window.minimize": { direction: "host-to-shell", kind: "notification" },
  "window.restore": { direction: "host-to-shell", kind: "notification" },
  "window.maximize": { direction: "host-to-shell", kind: "notification" },
  "window.unmaximize": { direction: "host-to-shell", kind: "notification" },
  "window.reload": { direction: "host-to-shell", kind: "notification" },
  "window.toggleDevTools": { direction: "host-to-shell", kind: "notification" },
  "window.setFullscreen": { direction: "host-to-shell", kind: "notification" },
  "window.setTitle": { direction: "host-to-shell", kind: "notification" },
  "window.setBounds": { direction: "host-to-shell", kind: "notification" },
  "window.setBackgroundColor": { direction: "host-to-shell", kind: "notification" },
  "window.setZoom": { direction: "host-to-shell", kind: "notification" },
  "window.setAlwaysOnTop": { direction: "host-to-shell", kind: "notification" },
  "window.getBounds": { direction: "host-to-shell", kind: "request" },
  "window.getState": { direction: "host-to-shell", kind: "request" },
  "window.event": { direction: "shell-to-host", kind: "notification" },
  "dialog.openFolder": { direction: "host-to-shell", kind: "request" },
  "dialog.openFiles": { direction: "host-to-shell", kind: "request" },
  "dialog.message": { direction: "host-to-shell", kind: "request" },
  "dialog.error": { direction: "host-to-shell", kind: "request" },
  "menu.setApplication": { direction: "host-to-shell", kind: "request" },
  "menu.popup": { direction: "host-to-shell", kind: "request" },
  "menu.click": { direction: "shell-to-host", kind: "notification" },
  "shell.openExternal": { direction: "host-to-shell", kind: "request" },
  "shell.showItemInFolder": { direction: "host-to-shell", kind: "notification" },
  "clipboard.writeText": { direction: "host-to-shell", kind: "notification" },
  "wsl.registerGuest": { direction: "host-to-shell", kind: "request" },
  "wsl.unregisterGuest": { direction: "host-to-shell", kind: "request" },
  "auth.callback": { direction: "shell-to-host", kind: "notification" },
  "theme.get": { direction: "host-to-shell", kind: "request" },
  "theme.setSource": { direction: "host-to-shell", kind: "notification" },
  "theme.updated": { direction: "shell-to-host", kind: "notification" },
  "safeStorage.status": { direction: "host-to-shell", kind: "request" },
  "safeStorage.encrypt": { direction: "host-to-shell", kind: "request" },
  "safeStorage.decrypt": { direction: "host-to-shell", kind: "request" },
  "updater.configure": { direction: "host-to-shell", kind: "notification" },
  "updater.check": { direction: "host-to-shell", kind: "request" },
  "updater.download": { direction: "host-to-shell", kind: "notification" },
  "updater.install": { direction: "host-to-shell", kind: "notification" },
  "updater.progress": { direction: "shell-to-host", kind: "notification" },
  "power.snapshot": { direction: "host-to-shell", kind: "request" },
  "power.event": { direction: "shell-to-host", kind: "notification" },
} satisfies Record<RpcMethodName, RpcMethodSpec>;

export const RpcId = Schema.Int;
export type RpcId = typeof RpcId.Type;

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const RpcErrorKind = Schema.Literals(RPC_ERROR_KINDS);
export type RpcErrorKind = typeof RpcErrorKind.Type;

export const RpcErrorData = Schema.Struct({
  kind: RpcErrorKind,
});
export type RpcErrorData = typeof RpcErrorData.Type;

export const RpcError = Schema.Struct({
  code: Schema.Int,
  message: Schema.String,
  data: Schema.optional(RpcErrorData),
});
export type RpcError = typeof RpcError.Type;

const EmptyParams = Schema.Struct({});
const EmptyResult = Schema.Struct({});
const StringArray = Schema.Array(Schema.String);

const ShellHelloParams = Schema.Struct({
  protocolVersion: Schema.String,
  hostPid: NonNegativeInt,
});
const ShellHelloResult = Schema.Struct({
  appName: Schema.String,
  identifier: Schema.String,
  version: Schema.String,
  tauriVersion: Schema.String,
  platform: Schema.String,
  arch: Schema.String,
  isDev: Schema.Boolean,
  execPath: Schema.String,
  resourceDir: Schema.String,
  serverRoot: Schema.String,
  appDataDir: Schema.String,
  logDir: Schema.String,
  systemLocale: Schema.String,
  deepLinkScheme: Schema.String,
  argv: StringArray,
  launchUrls: StringArray,
});

const AppExitParams = Schema.Struct({ code: Schema.Int });
const AppFocusParams = Schema.Struct({ steal: Schema.Boolean });
const AppProtocolClientParams = Schema.Struct({ scheme: Schema.NonEmptyString });
const AppBeforeQuitParams = Schema.Struct({
  reason: Schema.Literals(["user", "menu", "last-window", "host", "updater"]),
});
const AppActivateParams = Schema.Struct({ hasVisibleWindows: Schema.Boolean });
const AppSecondInstanceParams = Schema.Struct({ argv: StringArray, cwd: Schema.String });
const AppOpenUrlParams = Schema.Struct({ urls: StringArray });
const AppMetricsResult = Schema.Array(
  Schema.Struct({
    pid: NonNegativeInt,
    type: Schema.String,
    cpuPercent: Schema.Number,
    memoryKb: NonNegativeInt,
  }),
);

const ProcessRegisterParams = Schema.Struct({
  attemptId: Schema.NonEmptyString,
  pid: NonNegativeInt,
  kind: Schema.Literals(["server", "ssh", "wsl", "other"]),
  spawnedAtMs: NonNegativeInt,
});
const ProcessUnregisterParams = Schema.Struct({ registrationId: Schema.NonEmptyString });
const ProcessCancelParams = Schema.Struct({ attemptId: Schema.NonEmptyString });

const IpcInvokeParams = Schema.Struct({ channel: Schema.NonEmptyString, payload: Schema.Unknown });
const IpcPushParams = IpcInvokeParams;

const WindowLabelParams = Schema.Struct({ label: Schema.NonEmptyString });
const WindowFullscreenParams = Schema.Struct({
  label: Schema.NonEmptyString,
  fullscreen: Schema.Boolean,
});
const WindowTitleParams = Schema.Struct({ label: Schema.NonEmptyString, title: Schema.String });
const WindowBoundsParams = Schema.Struct({
  label: Schema.NonEmptyString,
  x: Schema.Int,
  y: Schema.Int,
  width: Schema.Int,
  height: Schema.Int,
});
const WindowBackgroundColorParams = Schema.Struct({
  label: Schema.NonEmptyString,
  color: Schema.String,
});
const WindowZoomParams = Schema.Struct({
  label: Schema.NonEmptyString,
  zoomFactor: Schema.Number,
});
const WindowAlwaysOnTopParams = Schema.Struct({
  label: Schema.NonEmptyString,
  flag: Schema.Boolean,
});
const WindowCreateParams = Schema.Struct({
  label: Schema.NonEmptyString,
  url: Schema.optional(Schema.String),
  title: Schema.String,
  width: Schema.Int,
  height: Schema.Int,
  minWidth: Schema.Int,
  minHeight: Schema.Int,
  x: Schema.optional(Schema.Int),
  y: Schema.optional(Schema.Int),
  show: Schema.Boolean,
  backgroundColor: Schema.String,
  decorations: Schema.Boolean,
  titleBarStyle: Schema.String,
  hiddenTitle: Schema.Boolean,
  trafficLightPosition: Schema.optional(Schema.Struct({ x: Schema.Int, y: Schema.Int })),
  initScripts: StringArray,
  zoomFactor: Schema.optional(Schema.Number),
});
const WindowEventParams = Schema.Struct({
  label: Schema.NonEmptyString,
  type: Schema.Literals([
    "created",
    "closed",
    "focus",
    "blur",
    "minimized",
    "restored",
    "maximized",
    "unmaximized",
    "fullscreen",
    "moved",
    "resized",
    "theme-changed",
    "load-failed",
    "webview-crashed",
    "navigation-blocked",
  ]),
  data: Schema.optional(Schema.Unknown),
});
const WindowBoundsResult = Schema.Struct({
  x: Schema.Int,
  y: Schema.Int,
  width: Schema.Int,
  height: Schema.Int,
  maximized: Schema.Boolean,
});
const WindowStateResult = Schema.Struct({
  visible: Schema.Boolean,
  focused: Schema.Boolean,
  minimized: Schema.Boolean,
  maximized: Schema.Boolean,
  fullscreen: Schema.Boolean,
  destroyed: Schema.Boolean,
});

const DialogOpenFolderParams = Schema.Struct({
  ownerLabel: Schema.optional(Schema.String),
  defaultPath: Schema.optional(Schema.String),
});
const DialogOpenFilesParams = Schema.Struct({
  ownerLabel: Schema.optional(Schema.String),
  defaultPath: Schema.optional(Schema.String),
  filters: Schema.optional(
    Schema.Array(Schema.Struct({ name: Schema.String, extensions: StringArray })),
  ),
});
const DialogMessageParams = Schema.Struct({
  kind: Schema.String,
  title: Schema.optional(Schema.String),
  message: Schema.String,
  detail: Schema.optional(Schema.String),
  buttons: StringArray,
  defaultId: Schema.optional(NonNegativeInt),
  cancelId: Schema.optional(NonNegativeInt),
});
const DialogErrorParams = Schema.Struct({
  title: Schema.String,
  content: Schema.String,
});

const MenuItem = Schema.Struct({
  id: Schema.optional(Schema.String),
  label: Schema.optional(Schema.String),
  role: Schema.optional(Schema.String),
  type: Schema.optional(Schema.String),
  enabled: Schema.optional(Schema.Boolean),
  checked: Schema.optional(Schema.Boolean),
  accelerator: Schema.optional(Schema.String),
  submenu: Schema.optional(Schema.Array(Schema.Unknown)),
});
const MenuSetApplicationParams = Schema.Struct({ items: Schema.Array(MenuItem) });
const MenuPopupParams = Schema.Struct({
  ownerLabel: Schema.NonEmptyString,
  items: Schema.Array(MenuItem),
  position: Schema.optional(Schema.Struct({ x: Schema.Int, y: Schema.Int })),
});
const MenuClickParams = Schema.Struct({ id: Schema.NonEmptyString });

const ShellOpenExternalParams = Schema.Struct({ url: Schema.NonEmptyString });
const ShellShowItemParams = Schema.Struct({ path: Schema.NonEmptyString });
const ClipboardWriteTextParams = Schema.Struct({ text: Schema.String });

const WslRegisterGuestParams = Schema.Struct({
  instanceId: Schema.NonEmptyString,
  distro: Schema.NonEmptyString,
  nonce: Schema.NonEmptyString,
  identityFile: Schema.NonEmptyString,
  state: Schema.Literals(["pending", "active"]),
  pid: Schema.optional(NonNegativeInt),
  pgid: Schema.optional(NonNegativeInt),
});
const WslUnregisterGuestParams = Schema.Struct({ instanceId: Schema.NonEmptyString });
const AuthCallbackParams = Schema.Struct({ url: Schema.NonEmptyString });

const ThemeSetSourceParams = Schema.Struct({ source: Schema.String });
const ThemeUpdatedParams = Schema.Struct({ shouldUseDarkColors: Schema.Boolean });

const SafeStorageEncryptParams = Schema.Struct({ plaintext: Schema.String });
const SafeStorageDecryptParams = Schema.Struct({ ciphertextBase64: Schema.String });
const SafeStorageStatusResult = Schema.Struct({
  available: Schema.Boolean,
  backend: Schema.optional(Schema.String),
});
const SafeStorageEncryptResult = Schema.Struct({ ciphertextBase64: Schema.String });
const SafeStorageDecryptResult = Schema.Struct({ plaintext: Schema.String });

const UpdaterConfigureParams = Schema.Struct({
  endpoints: StringArray,
  channel: Schema.String,
  allowDowngrade: Schema.Boolean,
  target: Schema.optional(Schema.String),
});
const UpdaterInstallParams = Schema.Struct({ relaunch: Schema.Boolean });
const UpdaterProgressParams = Schema.Struct({
  transferred: NonNegativeInt,
  total: Schema.optional(NonNegativeInt),
});
const UpdaterCheckResult = Schema.Struct({
  available: Schema.Boolean,
  version: Schema.optional(Schema.String),
  notes: Schema.optional(Schema.String),
  date: Schema.optional(Schema.String),
});

const PowerEventParams = Schema.Struct({ type: Schema.String, value: Schema.Unknown });
const PowerSnapshotResult = Schema.Struct({
  onBattery: Schema.Boolean,
  idleSeconds: NonNegativeInt,
  idleState: Schema.String,
  thermalState: Schema.String,
});

/** Method payload contracts.  Keeping this map explicit makes additions visible in review. */
export const RpcMethodParams = {
  "shell.hello": ShellHelloParams,
  "app.quit": EmptyParams,
  "app.exit": AppExitParams,
  "app.relaunch": EmptyParams,
  "app.focus": AppFocusParams,
  "app.isProtocolClient": AppProtocolClientParams,
  "app.setProtocolClient": AppProtocolClientParams,
  "app.getMetrics": EmptyParams,
  "app.before-quit": AppBeforeQuitParams,
  "app.window-all-closed": EmptyParams,
  "app.activate": AppActivateParams,
  "app.second-instance": AppSecondInstanceParams,
  "app.open-url": AppOpenUrlParams,
  "app.shutdown-complete": EmptyParams,
  "process.register": ProcessRegisterParams,
  "process.unregister": ProcessUnregisterParams,
  "process.cancel": ProcessCancelParams,
  "ipc.invoke": IpcInvokeParams,
  "ipc.push": IpcPushParams,
  "window.create": WindowCreateParams,
  "window.show": WindowLabelParams,
  "window.hide": WindowLabelParams,
  "window.close": WindowLabelParams,
  "window.destroy": WindowLabelParams,
  "window.focus": WindowLabelParams,
  "window.minimize": WindowLabelParams,
  "window.restore": WindowLabelParams,
  "window.maximize": WindowLabelParams,
  "window.unmaximize": WindowLabelParams,
  "window.reload": WindowLabelParams,
  "window.toggleDevTools": WindowLabelParams,
  "window.setFullscreen": WindowFullscreenParams,
  "window.setTitle": WindowTitleParams,
  "window.setBounds": WindowBoundsParams,
  "window.setBackgroundColor": WindowBackgroundColorParams,
  "window.setZoom": WindowZoomParams,
  "window.setAlwaysOnTop": WindowAlwaysOnTopParams,
  "window.getBounds": WindowLabelParams,
  "window.getState": WindowLabelParams,
  "window.event": WindowEventParams,
  "dialog.openFolder": DialogOpenFolderParams,
  "dialog.openFiles": DialogOpenFilesParams,
  "dialog.message": DialogMessageParams,
  "dialog.error": DialogErrorParams,
  "menu.setApplication": MenuSetApplicationParams,
  "menu.popup": MenuPopupParams,
  "menu.click": MenuClickParams,
  "shell.openExternal": ShellOpenExternalParams,
  "shell.showItemInFolder": ShellShowItemParams,
  "clipboard.writeText": ClipboardWriteTextParams,
  "wsl.registerGuest": WslRegisterGuestParams,
  "wsl.unregisterGuest": WslUnregisterGuestParams,
  "auth.callback": AuthCallbackParams,
  "theme.get": EmptyParams,
  "theme.setSource": ThemeSetSourceParams,
  "theme.updated": ThemeUpdatedParams,
  "safeStorage.status": EmptyParams,
  "safeStorage.encrypt": SafeStorageEncryptParams,
  "safeStorage.decrypt": SafeStorageDecryptParams,
  "updater.configure": UpdaterConfigureParams,
  "updater.check": EmptyParams,
  "updater.download": EmptyParams,
  "updater.install": UpdaterInstallParams,
  "updater.progress": UpdaterProgressParams,
  "power.snapshot": EmptyParams,
  "power.event": PowerEventParams,
} satisfies Record<RpcMethodName, Schema.Top>;

export const RpcMethodResults = {
  "shell.hello": ShellHelloResult,
  "app.quit": EmptyResult,
  "app.exit": EmptyResult,
  "app.relaunch": EmptyResult,
  "app.focus": EmptyResult,
  "app.isProtocolClient": Schema.Struct({ registered: Schema.Boolean }),
  "app.setProtocolClient": Schema.Struct({ ok: Schema.Boolean }),
  "app.getMetrics": AppMetricsResult,
  "app.before-quit": Schema.Struct({ prevented: Schema.Boolean }),
  "app.window-all-closed": EmptyResult,
  "app.activate": EmptyResult,
  "app.second-instance": EmptyResult,
  "app.open-url": EmptyResult,
  "app.shutdown-complete": EmptyResult,
  "process.register": Schema.Struct({ registrationId: Schema.Union([Schema.String, Schema.Null]) }),
  "process.unregister": EmptyResult,
  "process.cancel": EmptyResult,
  "ipc.invoke": Schema.Struct({ result: Schema.Unknown }),
  "ipc.push": EmptyResult,
  "window.create": Schema.Struct({ label: Schema.NonEmptyString }),
  "window.show": EmptyResult,
  "window.hide": EmptyResult,
  "window.close": EmptyResult,
  "window.destroy": EmptyResult,
  "window.focus": EmptyResult,
  "window.minimize": EmptyResult,
  "window.restore": EmptyResult,
  "window.maximize": EmptyResult,
  "window.unmaximize": EmptyResult,
  "window.reload": EmptyResult,
  "window.toggleDevTools": EmptyResult,
  "window.setFullscreen": EmptyResult,
  "window.setTitle": EmptyResult,
  "window.setBounds": EmptyResult,
  "window.setBackgroundColor": EmptyResult,
  "window.setZoom": EmptyResult,
  "window.setAlwaysOnTop": EmptyResult,
  "window.getBounds": WindowBoundsResult,
  "window.getState": WindowStateResult,
  "window.event": EmptyResult,
  "dialog.openFolder": Schema.Struct({ path: Schema.Union([Schema.String, Schema.Null]) }),
  "dialog.openFiles": Schema.Struct({ paths: StringArray }),
  "dialog.message": Schema.Struct({ response: Schema.Int }),
  "dialog.error": EmptyResult,
  "menu.setApplication": EmptyResult,
  "menu.popup": Schema.Struct({ selectedId: Schema.Union([Schema.String, Schema.Null]) }),
  "menu.click": EmptyResult,
  "shell.openExternal": Schema.Struct({ ok: Schema.Boolean }),
  "shell.showItemInFolder": EmptyResult,
  "clipboard.writeText": EmptyResult,
  "wsl.registerGuest": Schema.Struct({ ok: Schema.Boolean }),
  "wsl.unregisterGuest": Schema.Struct({ ok: Schema.Boolean }),
  "auth.callback": EmptyResult,
  "theme.get": Schema.Struct({ shouldUseDarkColors: Schema.Boolean }),
  "theme.setSource": EmptyResult,
  "theme.updated": EmptyResult,
  "safeStorage.status": SafeStorageStatusResult,
  "safeStorage.encrypt": SafeStorageEncryptResult,
  "safeStorage.decrypt": SafeStorageDecryptResult,
  "updater.configure": EmptyResult,
  "updater.check": UpdaterCheckResult,
  "updater.download": EmptyResult,
  "updater.install": EmptyResult,
  "updater.progress": EmptyResult,
  "power.snapshot": PowerSnapshotResult,
  "power.event": EmptyResult,
} satisfies Record<RpcMethodName, Schema.Top>;

const NO_PARAM_METHODS = new Set<RpcMethodName>([
  "app.quit",
  "app.relaunch",
  "app.getMetrics",
  "app.window-all-closed",
  "app.shutdown-complete",
  "updater.check",
  "updater.download",
  "power.snapshot",
  "theme.get",
  "safeStorage.status",
]);

export const decodeMethodParams = (method: RpcMethodName, params: unknown) =>
  Schema.decodeUnknownSync(RpcMethodParams[method])(
    params === undefined && NO_PARAM_METHODS.has(method) ? {} : params,
  );

export const decodeMethodResult = (method: RpcMethodName, result: unknown) =>
  Schema.decodeUnknownSync(RpcMethodResults[method])(result);

const makeRequestSchema = (method: RpcMethodName) =>
  Schema.Struct({
    jsonrpc: Schema.Literal(JSON_RPC_VERSION),
    id: RpcId,
    method: Schema.Literal(method),
    params: NO_PARAM_METHODS.has(method)
      ? Schema.optional(RpcMethodParams[method])
      : RpcMethodParams[method],
  });

type NotificationEnvelope = {
  readonly jsonrpc: typeof JSON_RPC_VERSION;
  readonly method: RpcMethodName;
  readonly params?: unknown;
};

const makeNotificationSchema = (method: RpcMethodName) =>
  Schema.Struct({
    jsonrpc: Schema.Literal(JSON_RPC_VERSION),
    method: Schema.Literal(method),
    id: Schema.optional(Schema.Never),
    params: NO_PARAM_METHODS.has(method)
      ? Schema.optional(RpcMethodParams[method])
      : RpcMethodParams[method],
  }).pipe(
    Schema.check(
      Schema.makeFilter((value: NotificationEnvelope) =>
        "id" in value ? "notifications must not include an id" : undefined,
      ),
    ),
  );

const requestMethods = APPENDIX_B_METHODS.filter(
  (method) => APPENDIX_B_METHOD_SPECS[method].kind === "request",
);
const notificationMethods = APPENDIX_B_METHODS.filter(
  (method) => APPENDIX_B_METHOD_SPECS[method].kind === "notification",
);
const requestVariants = requestMethods.map(makeRequestSchema);
const notificationVariants = notificationMethods.map(makeNotificationSchema);

export const RpcRequest = Schema.Union(requestVariants);
export type RpcRequest = typeof RpcRequest.Type;

export const RpcNotification = Schema.Union(notificationVariants);
export type RpcNotification = typeof RpcNotification.Type;

export const RpcSuccessResponse = Schema.Struct({
  jsonrpc: Schema.Literal(JSON_RPC_VERSION),
  id: RpcId,
  result: Schema.Unknown,
});
export type RpcSuccessResponse = typeof RpcSuccessResponse.Type;

export const RpcErrorResponse = Schema.Struct({
  jsonrpc: Schema.Literal(JSON_RPC_VERSION),
  id: Schema.Union([RpcId, Schema.Null]),
  error: RpcError,
});
export type RpcErrorResponse = typeof RpcErrorResponse.Type;

export const RpcResponse = Schema.Union([RpcSuccessResponse, RpcErrorResponse]);
export type RpcResponse = typeof RpcResponse.Type;

export const RpcEnvelope = Schema.Union([RpcRequest, RpcNotification, RpcResponse]);
export type RpcEnvelope = typeof RpcEnvelope.Type;

/**
 * A fixture adds a stable label and direction around one wire envelope.  The
 * direction is intentionally metadata: JSON-RPC itself is symmetric and the
 * shell/host implementation decides which side is allowed to send a method.
 */
export const RpcFixture = Schema.Struct({
  name: Schema.NonEmptyString,
  direction: RpcDirection,
  kind: RpcFixtureKind,
  envelope: RpcEnvelope,
});
export type RpcFixture = typeof RpcFixture.Type;

export const RpcFixtureCollection = Schema.Array(RpcFixture);
export type RpcFixtureCollection = typeof RpcFixtureCollection.Type;

export const RpcResultFixture = Schema.Struct({
  name: Schema.NonEmptyString,
  method: RpcMethodName,
  direction: RpcDirection,
  kind: Schema.Literal("response"),
  envelope: RpcSuccessResponse,
});
export type RpcResultFixture = typeof RpcResultFixture.Type;

export const FrameFixture = Schema.Struct({
  name: Schema.NonEmptyString,
  description: Schema.NonEmptyString,
  /** A valid encoded frame, represented as UTF-8 text when one exists. */
  frame: Schema.optional(Schema.String),
  /** Invalid input bytes are represented without lossy Unicode coercion. */
  bytesBase64: Schema.optional(Schema.String),
  bytes: Schema.optional(Schema.Array(Schema.Int)),
  expect: Schema.Literals(["accept", "reject", "resync", "close"]),
  reason: Schema.optional(Schema.String),
});
export type FrameFixture = typeof FrameFixture.Type;

export const ErrorFixture = Schema.Struct({
  name: Schema.NonEmptyString,
  description: Schema.NonEmptyString,
  envelope: RpcErrorResponse,
  expectKind: Schema.Literals([
    "invalid-request",
    "method-not-found",
    "invalid-params",
    "platform",
    "unsupported",
    "cancelled",
    "timeout",
  ]),
});
export type ErrorFixture = typeof ErrorFixture.Type;

export const LimitFixture = Schema.Struct({
  name: Schema.NonEmptyString,
  description: Schema.NonEmptyString,
  limit: NonNegativeInt,
  observed: NonNegativeInt,
  expect: Schema.Literals(["accept", "reject", "close", "queue", "cancel"]),
});
export type LimitFixture = typeof LimitFixture.Type;

export const ProtocolFixtureDocument = Schema.Struct({
  protocolVersion: Schema.Literal(JSON_RPC_VERSION),
  fixtures: RpcFixtureCollection,
  results: Schema.Array(RpcResultFixture),
  errors: Schema.Array(ErrorFixture),
  limits: Schema.Array(LimitFixture),
  frames: Schema.Array(FrameFixture),
});
export type ProtocolFixtureDocument = typeof ProtocolFixtureDocument.Type;

/**
 * Encode/decode helpers used by fixture tests and by the future stdio peer.
 * They intentionally do not add framing or transport side effects.
 */
export const encodeEnvelope = Schema.encodeSync(RpcEnvelope);
export const decodeEnvelope = Schema.decodeUnknownSync(RpcEnvelope);
export const decodeFixtureDocument = Schema.decodeUnknownSync(ProtocolFixtureDocument);
