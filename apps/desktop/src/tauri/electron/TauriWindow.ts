import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type * as Electron from "electron";
import type * as ElectronWindowService from "../../electron/ElectronWindow.ts";

/**
 * The host-side window port is intentionally smaller than a transport.  A
 * stdio RPC client, an in-memory test double, or a native bridge can all
 * implement these operations without changing the Electron-facing service.
 */
export interface TauriWindowCreateParams {
  readonly label: string;
  readonly url?: string;
  readonly title: string;
  readonly width: number;
  readonly height: number;
  readonly minWidth: number;
  readonly minHeight: number;
  readonly x?: number;
  readonly y?: number;
  readonly show: boolean;
  readonly backgroundColor: string;
  readonly decorations: boolean;
  readonly titleBarStyle: string;
  readonly hiddenTitle: boolean;
  readonly trafficLightPosition?: Readonly<{ x: number; y: number }>;
  readonly initScripts: readonly string[];
  readonly zoomFactor?: number;
}

export interface TauriWindowCreateResult {
  readonly label: string;
  readonly id?: number;
}

export interface TauriWindowBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface TauriWindowState {
  readonly visible: boolean;
  readonly focused: boolean;
  readonly minimized: boolean;
  readonly maximized: boolean;
  readonly fullscreen: boolean;
  readonly destroyed: boolean;
}

export type TauriWindowEventType =
  | "created"
  | "closed"
  | "focus"
  | "blur"
  | "minimized"
  | "restored"
  | "maximized"
  | "unmaximized"
  | "fullscreen"
  | "moved"
  | "resized"
  | "theme-changed"
  | "load-failed"
  | "webview-crashed"
  | "navigation-blocked";

export interface TauriWindowEventParams {
  readonly label: string;
  readonly type: TauriWindowEventType;
  readonly data?: unknown;
}

export type TauriWindowRequestMethod = "window.getBounds" | "window.getState";
export type TauriWindowNotificationMethod =
  | "ipc.push"
  | "window.show"
  | "window.hide"
  | "window.close"
  | "window.destroy"
  | "window.focus"
  | "window.minimize"
  | "window.restore"
  | "window.maximize"
  | "window.unmaximize"
  | "window.reload"
  | "window.toggleDevTools"
  | "window.setFullscreen"
  | "window.setTitle"
  | "window.setBounds"
  | "window.setBackgroundColor"
  | "window.setZoom"
  | "window.setAlwaysOnTop";

export interface TauriWindowPort {
  readonly create: (
    params: TauriWindowCreateParams,
  ) => TauriWindowCreateResult | PromiseLike<TauriWindowCreateResult>;
  readonly request: (
    method: TauriWindowRequestMethod,
    params: { readonly label: string },
  ) => unknown | PromiseLike<unknown>;
  readonly notify: (
    method: TauriWindowNotificationMethod,
    params: unknown,
  ) => void | PromiseLike<void>;
  readonly on?: (
    method: "window.event",
    listener: (params: TauriWindowEventParams) => void,
  ) => void | (() => void);
}

export class TauriWindowFacadeError extends Schema.TaggedErrorClass<TauriWindowFacadeError>()(
  "TauriWindowFacadeError",
  {
    label: Schema.String,
    member: Schema.String,
  },
) {
  override get message(): string {
    return `Tauri window facade member ${JSON.stringify(this.member)} is not implemented for ${JSON.stringify(this.label)}.`;
  }
}

export const isTauriWindowFacadeError = Schema.is(TauriWindowFacadeError);

export class TauriWindowCreateError extends Schema.TaggedErrorClass<TauriWindowCreateError>()(
  "TauriWindowCreateError",
  {
    label: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to create Tauri window ${JSON.stringify(this.label)}.`;
  }
}

type Listener = (...args: ReadonlyArray<unknown>) => void;

/** Minimal EventEmitter-compatible surface needed by the shared host. */
class EventHub {
  private readonly listeners = new Map<string, Set<Listener>>();

  on(event: string, listener: Listener): this {
    const listeners = this.listeners.get(event) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  addListener(event: string, listener: Listener): this {
    return this.on(event, listener);
  }

  once(event: string, listener: Listener): this {
    const wrapped: Listener = (...args) => {
      this.removeListener(event, wrapped);
      Reflect.apply(listener, undefined, args);
    };
    return this.on(event, wrapped);
  }

  off(event: string, listener: Listener): this {
    return this.removeListener(event, listener);
  }

  removeListener(event: string, listener: Listener): this {
    const listeners = this.listeners.get(event);
    if (listeners === undefined) return this;
    listeners.delete(listener);
    if (listeners.size === 0) this.listeners.delete(event);
    return this;
  }

  emit(event: string, ...args: ReadonlyArray<unknown>): boolean {
    const listeners = this.listeners.get(event);
    if (listeners === undefined) return false;
    for (const listener of [...listeners]) {
      Reflect.apply(listener, undefined, args);
    }
    return true;
  }
}

type TauriWebContentsHandle = {
  readonly send: (channel: string, ...args: readonly unknown[]) => void;
  readonly on: (event: string, listener: Listener) => TauriWebContentsHandle;
  readonly addListener: (event: string, listener: Listener) => TauriWebContentsHandle;
  readonly once: (event: string, listener: Listener) => TauriWebContentsHandle;
  readonly off: (event: string, listener: Listener) => TauriWebContentsHandle;
  readonly removeListener: (event: string, listener: Listener) => TauriWebContentsHandle;
  readonly isLoadingMainFrame: () => boolean;
  readonly getURL: () => string;
  readonly getZoomLevel: () => number;
  readonly setZoomLevel: (level: number) => void;
  readonly openDevTools: (options?: unknown) => void;
};

export interface TauriWindowHandle {
  readonly label: string;
  readonly id: number;
  readonly webContents: TauriWebContentsHandle;
  readonly isDestroyed: () => boolean;
  readonly isMinimized: () => boolean;
  readonly isVisible: () => boolean;
  readonly isFocused: () => boolean;
  readonly isMaximized: () => boolean;
  readonly isFullScreen: () => boolean;
  readonly getBounds: () => TauriWindowBounds;
  readonly getNormalBounds: () => TauriWindowBounds;
  readonly show: () => void;
  readonly hide: () => void;
  readonly focus: () => void;
  readonly restore: () => void;
  readonly minimize: () => void;
  readonly maximize: () => void;
  readonly unmaximize: () => void;
  readonly close: () => void;
  readonly destroy: () => void;
  readonly setFullScreen: (fullscreen: boolean) => void;
  readonly setTitle: (title: string) => void;
  readonly setBounds: (bounds: Partial<TauriWindowBounds>) => void;
  readonly setBackgroundColor: (color: string) => void;
  readonly setAlwaysOnTop: (flag: boolean) => void;
  readonly on: (event: string, listener: Listener) => TauriWindowHandle;
  readonly addListener: (event: string, listener: Listener) => TauriWindowHandle;
  readonly once: (event: string, listener: Listener) => TauriWindowHandle;
  readonly off: (event: string, listener: Listener) => TauriWindowHandle;
  readonly removeListener: (event: string, listener: Listener) => TauriWindowHandle;
}

type InternalState = {
  bounds: TauriWindowBounds;
  normalBounds: TauriWindowBounds;
  title: string;
  backgroundColor: string;
  zoomLevel: number;
  visible: boolean;
  focused: boolean;
  minimized: boolean;
  maximized: boolean;
  fullscreen: boolean;
  destroyed: boolean;
};

type WindowFacade = TauriWindowHandle & {
  readonly __tauriWindowState: InternalState;
  readonly __tauriWindowHub: EventHub;
};

const asObject = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;

const asFiniteNumber = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const asBoolean = (value: unknown, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : fallback;

const asBounds = (value: unknown, fallback: TauriWindowBounds): TauriWindowBounds => {
  const record = asObject(value);
  if (record === undefined) return fallback;
  return {
    x: asFiniteNumber(record.x, fallback.x),
    y: asFiniteNumber(record.y, fallback.y),
    width: asFiniteNumber(record.width, fallback.width),
    height: asFiniteNumber(record.height, fallback.height),
  };
};

const sendNotification = (
  port: TauriWindowPort,
  method: TauriWindowNotificationMethod,
  params: unknown,
): void => {
  try {
    // Notifications are deliberately fire-and-forget at the Electron-facing
    // boundary.  A later host integration layer can expose transport failures
    // through a receipt without changing this synchronous BrowserWindow shape.
    const result = port.notify(method, params);
    if (typeof result === "object" && result !== null && "then" in result) {
      void Promise.resolve(result).catch(() => undefined);
    }
  } catch {
    // A synchronous transport failure must not leave a rejected Promise behind
    // a BrowserWindow method.  The host owns the authoritative error channel.
  }
};

const notificationParams = (label: string): { readonly label: string } => ({ label });

const applyEvent = (state: InternalState, event: TauriWindowEventParams): void => {
  switch (event.type) {
    case "created":
      state.destroyed = false;
      break;
    case "closed":
      state.destroyed = true;
      state.visible = false;
      state.focused = false;
      break;
    case "focus":
      state.focused = true;
      state.visible = true;
      break;
    case "blur":
      state.focused = false;
      break;
    case "minimized":
      state.minimized = true;
      state.visible = true;
      break;
    case "restored":
      state.minimized = false;
      break;
    case "maximized":
      state.maximized = true;
      break;
    case "unmaximized":
      state.maximized = false;
      break;
    case "fullscreen":
      state.fullscreen = asBoolean(asObject(event.data)?.fullscreen, state.fullscreen);
      break;
    case "moved":
    case "resized": {
      const nextBounds = asBounds(event.data, state.bounds);
      state.bounds = nextBounds;
      if (!state.fullscreen && !state.maximized && !state.minimized) {
        state.normalBounds = nextBounds;
      }
      break;
    }
    default:
      break;
  }
};

const makeWindowFacade = (
  port: TauriWindowPort,
  params: TauriWindowCreateParams,
  result: TauriWindowCreateResult,
  nextId: number,
): WindowFacade => {
  const hub = new EventHub();
  const initialBounds: TauriWindowBounds = {
    x: params.x ?? 0,
    y: params.y ?? 0,
    width: params.width,
    height: params.height,
  };
  const state: InternalState = {
    bounds: initialBounds,
    normalBounds: initialBounds,
    title: params.title,
    backgroundColor: params.backgroundColor,
    zoomLevel: params.zoomFactor ?? 0,
    visible: params.show,
    focused: false,
    minimized: false,
    maximized: false,
    fullscreen: false,
    destroyed: false,
  };
  const label = result.label;
  const id = result.id ?? nextId;

  const notify = (method: TauriWindowNotificationMethod, body: unknown): void => {
    if (state.destroyed && method !== "window.destroy") return;
    sendNotification(port, method, body);
  };

  const webContentsHub = new EventHub();
  const webContents: TauriWebContentsHandle = {
    send: (channel, ...args) =>
      notify("ipc.push", {
        channel,
        payload: args.length === 1 ? args[0] : args,
      }),
    on: (event, listener) => {
      webContentsHub.on(event, listener);
      return webContents;
    },
    addListener: (event, listener) => {
      webContentsHub.addListener(event, listener);
      return webContents;
    },
    once: (event, listener) => {
      webContentsHub.once(event, listener);
      return webContents;
    },
    off: (event, listener) => {
      webContentsHub.off(event, listener);
      return webContents;
    },
    removeListener: (event, listener) => {
      webContentsHub.removeListener(event, listener);
      return webContents;
    },
    isLoadingMainFrame: () => false,
    getURL: () => "",
    getZoomLevel: () => state.zoomLevel,
    setZoomLevel: (level) => {
      state.zoomLevel = level;
      notify("window.setZoom", { label, zoomFactor: level });
    },
    openDevTools: () => notify("window.toggleDevTools", notificationParams(label)),
  };

  const target: WindowFacade = {
    label,
    id,
    webContents,
    __tauriWindowState: state,
    __tauriWindowHub: hub,
    isDestroyed: () => state.destroyed,
    isMinimized: () => state.minimized,
    isVisible: () => state.visible,
    isFocused: () => state.focused,
    isMaximized: () => state.maximized,
    isFullScreen: () => state.fullscreen,
    getBounds: () => state.bounds,
    getNormalBounds: () => state.normalBounds,
    show: () => {
      state.visible = true;
      state.minimized = false;
      notify("window.show", notificationParams(label));
      hub.emit("show");
    },
    hide: () => {
      state.visible = false;
      state.focused = false;
      notify("window.hide", notificationParams(label));
      hub.emit("hide");
    },
    focus: () => {
      state.focused = true;
      state.visible = true;
      notify("window.focus", notificationParams(label));
      hub.emit("focus");
    },
    restore: () => {
      state.minimized = false;
      notify("window.restore", notificationParams(label));
      hub.emit("restore");
    },
    minimize: () => {
      state.minimized = true;
      notify("window.minimize", notificationParams(label));
      hub.emit("minimize");
    },
    maximize: () => {
      state.maximized = true;
      notify("window.maximize", notificationParams(label));
      hub.emit("maximize");
    },
    unmaximize: () => {
      state.maximized = false;
      notify("window.unmaximize", notificationParams(label));
      hub.emit("unmaximize");
    },
    close: () => {
      notify("window.close", notificationParams(label));
      state.destroyed = true;
      state.visible = false;
      state.focused = false;
      hub.emit("closed");
    },
    destroy: () => {
      notify("window.destroy", notificationParams(label));
      state.destroyed = true;
      state.visible = false;
      state.focused = false;
      hub.emit("closed");
    },
    setFullScreen: (fullscreen) => {
      state.fullscreen = fullscreen;
      notify("window.setFullscreen", { label, fullscreen });
    },
    setTitle: (title) => {
      state.title = title;
      notify("window.setTitle", { label, title });
    },
    setBounds: (bounds) => {
      state.bounds = {
        x: bounds.x ?? state.bounds.x,
        y: bounds.y ?? state.bounds.y,
        width: bounds.width ?? state.bounds.width,
        height: bounds.height ?? state.bounds.height,
      };
      if (!state.fullscreen && !state.maximized && !state.minimized) {
        state.normalBounds = state.bounds;
      }
      notify("window.setBounds", { label, ...state.bounds });
    },
    setBackgroundColor: (color) => {
      state.backgroundColor = color;
      notify("window.setBackgroundColor", { label, color });
    },
    setAlwaysOnTop: (flag) => notify("window.setAlwaysOnTop", { label, flag }),
    on: (event, listener) => {
      hub.on(event, listener);
      return proxy;
    },
    addListener: (event, listener) => {
      hub.addListener(event, listener);
      return proxy;
    },
    once: (event, listener) => {
      hub.once(event, listener);
      return proxy;
    },
    off: (event, listener) => {
      hub.off(event, listener);
      return proxy;
    },
    removeListener: (event, listener) => {
      hub.removeListener(event, listener);
      return proxy;
    },
  };

  // The cast is deliberately isolated here: BrowserWindow is an Electron-only
  // structural boundary, while every member used by the Phase 0 host is typed
  // explicitly above.  The proxy makes accidental F3/F5 access fail loudly.
  const proxy = new Proxy(target, {
    get(current, property, receiver) {
      // Promise resolution probes arbitrary objects for a `then` member.  A
      // non-thenable facade must answer that probe without weakening the guard
      // for normal window members.
      if (property === "then") return undefined;
      if (Reflect.has(current, property)) {
        return Reflect.get(current, property, receiver);
      }
      throw new TauriWindowFacadeError({ label, member: String(property) });
    },
  });

  return proxy;
};

const toCreateParams = (
  options: Electron.BrowserWindowConstructorOptions,
  label: string,
): TauriWindowCreateParams => ({
  label,
  title: options.title ?? "",
  width: options.width ?? 1024,
  height: options.height ?? 768,
  minWidth: options.minWidth ?? 0,
  minHeight: options.minHeight ?? 0,
  ...(options.x === undefined ? {} : { x: options.x }),
  ...(options.y === undefined ? {} : { y: options.y }),
  show: options.show ?? true,
  backgroundColor: options.backgroundColor ?? "#ffffff",
  decorations: options.frame ?? true,
  titleBarStyle: typeof options.titleBarStyle === "string" ? options.titleBarStyle : "default",
  hiddenTitle: options.titleBarStyle === "hidden" || options.titleBarStyle === "hiddenInset",
  ...(typeof options.trafficLightPosition === "object" && options.trafficLightPosition !== null
    ? { trafficLightPosition: options.trafficLightPosition }
    : {}),
  initScripts: [],
});

const asState = (value: unknown): TauriWindowState | undefined => {
  const record = asObject(value);
  if (record === undefined) return undefined;
  const required = ["visible", "focused", "minimized", "maximized", "fullscreen", "destroyed"];
  if (!required.every((key) => typeof record[key] === "boolean")) return undefined;
  return {
    visible: record.visible as boolean,
    focused: record.focused as boolean,
    minimized: record.minimized as boolean,
    maximized: record.maximized as boolean,
    fullscreen: record.fullscreen as boolean,
    destroyed: record.destroyed as boolean,
  };
};

const asBoundsResult = (
  value: unknown,
): (TauriWindowBounds & { readonly maximized: boolean }) | undefined => {
  const record = asObject(value);
  if (record === undefined) return undefined;
  if (
    typeof record.x !== "number" ||
    typeof record.y !== "number" ||
    typeof record.width !== "number" ||
    typeof record.height !== "number" ||
    typeof record.maximized !== "boolean"
  ) {
    return undefined;
  }
  return {
    x: record.x,
    y: record.y,
    width: record.width,
    height: record.height,
    maximized: record.maximized,
  };
};

const requestState = (port: TauriWindowPort, method: TauriWindowRequestMethod, label: string) =>
  Promise.resolve(port.request(method, { label }));

export const ElectronWindow = Context.Service<
  ElectronWindowService.ElectronWindow,
  ElectronWindowService.ElectronWindow["Service"]
>()("@t3tools/desktop/electron/ElectronWindow");

export interface TauriWindowOptions {
  readonly initialLabel?: string;
}

type MadeTauriWindowService = {
  readonly service: ElectronWindowService.ElectronWindow["Service"];
  readonly dispose: () => void;
};

const makeWithDisposer = (
  port: TauriWindowPort,
  options: TauriWindowOptions = {},
): MadeTauriWindowService => {
  const handles = new Map<string, WindowFacade>();
  const handleByFacade = new WeakMap<object, WindowFacade>();
  let nextId = 1;
  let main: WindowFacade | undefined;

  // Register exactly one shell event listener for the service.  Per-window
  // subscriptions would accumulate across close/create cycles; dispatching by
  // label keeps the lifetime bounded by the ElectronWindow service itself.
  const removeWindowEventListener = port.on?.("window.event", (event) => {
    const handle = handles.get(event.label);
    if (handle === undefined) return;
    applyEvent(handle.__tauriWindowState, event);
    handle.__tauriWindowHub.emit(event.type, event);
    if (event.type === "closed") {
      handles.delete(handle.label);
      if (main === handle) main = undefined;
    }
  });
  const labelForNextWindow = (): string => {
    const initialLabel = options.initialLabel ?? "main";
    return handles.size === 0 ? initialLabel : `${initialLabel}-${nextId}`;
  };

  const create = (browserOptions: Electron.BrowserWindowConstructorOptions) => {
    const requestedLabel = labelForNextWindow();
    const params = toCreateParams(browserOptions, requestedLabel);
    return Effect.tryPromise({
      try: async () => {
        const result = await port.create(params);
        const handle = makeWindowFacade(port, params, result, nextId);
        nextId += 1;
        handles.set(handle.label, handle);
        handleByFacade.set(handle, handle);
        return handle as unknown as Electron.BrowserWindow;
      },
      catch: (cause) => new TauriWindowCreateError({ label: requestedLabel, cause }),
    }).pipe(Effect.orDie);
  };

  const resolveHandle = (window: Electron.BrowserWindow): WindowFacade => {
    const handle = handleByFacade.get(window as unknown as object);
    if (handle === undefined) {
      throw new TauriWindowFacadeError({ label: "unknown", member: "foreign-window" });
    }
    return handle;
  };

  const mainEffect = Effect.sync(() =>
    main === undefined || main.__tauriWindowState.destroyed
      ? Option.none<Electron.BrowserWindow>()
      : Option.some(main as unknown as Electron.BrowserWindow),
  );

  const service = ElectronWindow.of({
    create,
    main: mainEffect,
    currentMainOrFirst: Effect.sync(() => {
      if (main !== undefined && !main.__tauriWindowState.destroyed) {
        return Option.some(main as unknown as Electron.BrowserWindow);
      }
      const first = [...handles.values()].find((handle) => !handle.__tauriWindowState.destroyed);
      return first === undefined
        ? Option.none<Electron.BrowserWindow>()
        : Option.some(first as unknown as Electron.BrowserWindow);
    }),
    focusedMainOrFirst: Effect.sync(() => {
      const focused = [...handles.values()].find(
        (handle) => handle.__tauriWindowState.focused && !handle.__tauriWindowState.destroyed,
      );
      if (focused !== undefined) return Option.some(focused as unknown as Electron.BrowserWindow);
      if (main !== undefined && !main.__tauriWindowState.destroyed) {
        return Option.some(main as unknown as Electron.BrowserWindow);
      }
      const first = [...handles.values()].find((handle) => !handle.__tauriWindowState.destroyed);
      return first === undefined
        ? Option.none<Electron.BrowserWindow>()
        : Option.some(first as unknown as Electron.BrowserWindow);
    }),
    setMain: (window) =>
      Effect.sync(() => {
        main = resolveHandle(window);
      }),
    clearMain: (window) =>
      Effect.sync(() => {
        if (main === undefined) return;
        if (Option.isSome(window) && resolveHandle(window.value) !== main) return;
        main = undefined;
      }),
    reveal: (window) =>
      Effect.sync(() => {
        const handle = resolveHandle(window);
        if (handle.isDestroyed()) return;
        if (handle.isMinimized()) handle.restore();
        if (!handle.isVisible()) handle.show();
        handle.focus();
      }),
    sendAll: (channel, ...args) =>
      Effect.sync(() => {
        for (const handle of handles.values()) {
          if (!handle.isDestroyed()) handle.webContents.send(channel, ...args);
        }
      }),
    destroyAll: Effect.sync(() => {
      for (const handle of handles.values()) {
        if (!handle.isDestroyed()) handle.destroy();
      }
      main = undefined;
    }),
    syncAllAppearance: (sync) =>
      Effect.forEach([...handles.values()], (handle) =>
        handle.isDestroyed() ? Effect.void : sync(handle as unknown as Electron.BrowserWindow),
      ).pipe(Effect.asVoid),
  });

  return {
    service,
    dispose: () => {
      removeWindowEventListener?.();
      handles.clear();
      main = undefined;
    },
  };
};

/** Direct construction is useful for focused tests and non-scoped hosts. */
export const make = (
  port: TauriWindowPort,
  options?: TauriWindowOptions,
): ElectronWindowService.ElectronWindow["Service"] => makeWithDisposer(port, options).service;

export const layer = (port: TauriWindowPort, options?: TauriWindowOptions) =>
  Layer.effect(
    ElectronWindow,
    Effect.acquireRelease(
      Effect.sync(() => makeWithDisposer(port, options)),
      ({ dispose }) => Effect.sync(dispose),
    ).pipe(Effect.map(({ service }) => service)),
  );

/** Read the mirrored state without reaching through the Electron type boundary. */
export const readMirroredState = (window: TauriWindowHandle): TauriWindowState => {
  const internal = window as unknown as WindowFacade;
  return {
    visible: internal.__tauriWindowState.visible,
    focused: internal.__tauriWindowState.focused,
    minimized: internal.__tauriWindowState.minimized,
    maximized: internal.__tauriWindowState.maximized,
    fullscreen: internal.__tauriWindowState.fullscreen,
    destroyed: internal.__tauriWindowState.destroyed,
  };
};

/**
 * Optional read-through helper for integration code.  Local mirrored values
 * remain authoritative during V1.1; this helper is intentionally not used by
 * the synchronous Electron façade.
 */
export const refreshMirroredState = async (
  port: TauriWindowPort,
  handle: TauriWindowHandle,
): Promise<void> => {
  const internal = handle as unknown as WindowFacade;
  const [boundsValue, stateValue] = await Promise.all([
    requestState(port, "window.getBounds", internal.label),
    requestState(port, "window.getState", internal.label),
  ]);
  const bounds = asBoundsResult(boundsValue);
  const state = asState(stateValue);
  if (bounds !== undefined) {
    internal.__tauriWindowState.bounds = bounds;
    internal.__tauriWindowState.normalBounds = bounds;
  }
  if (state !== undefined) {
    Object.assign(internal.__tauriWindowState, state);
  }
};
