import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as Effect from "effect/Effect";

import type * as TauriApp from "../electron/TauriApp.ts";
import type * as TauriShell from "../electron/TauriShell.ts";
import type * as TauriWindow from "../electron/TauriWindow.ts";
import type {
  ManagedChildProcessFacts,
  ManagedChildRegistration,
  ManagedChildRegistry,
} from "../process/ManagedChildSpawner.ts";

/** A captured host-to-shell call.  Values are kept as received for assertions. */
export interface FakeShellCall {
  readonly method: string;
  readonly params: unknown;
}

export interface FakeShellEventRecord {
  readonly method: string;
  readonly params: unknown;
  readonly result?: unknown;
}

export interface FakeShellIpcPush {
  readonly channel: string;
  readonly payload: unknown;
}

export interface FakeShellProcessRegistration {
  readonly attemptId: string;
  readonly pid: ChildProcessSpawner.ProcessId;
  readonly kind: ManagedChildProcessFacts["kind"];
  readonly spawnedAtMs: number;
  readonly registrationId: string | null;
}

export interface FakeShellProcessAction {
  readonly registrationId?: string;
  readonly attemptId?: string;
}

export interface FakeShellAudit {
  readonly hello: readonly TauriApp.TauriShellHelloParams[];
  readonly requests: readonly FakeShellCall[];
  readonly notifications: readonly FakeShellCall[];
  readonly events: readonly FakeShellEventRecord[];
  readonly ipcPushes: readonly FakeShellIpcPush[];
  readonly registrations: readonly FakeShellProcessRegistration[];
  readonly unregistrations: readonly FakeShellProcessAction[];
  readonly cancellations: readonly FakeShellProcessAction[];
}

export interface FakeShellOptions {
  /** Overrides the deterministic values returned by `shell.hello`. */
  readonly hello?: Partial<TauriApp.TauriShellHelloResult>;
  readonly metrics?: readonly TauriApp.TauriShellMetric[];
  readonly registeredProtocolSchemes?: readonly string[];
  readonly registrationIdPrefix?: string;
  /** Attempts in this set model a child that exited before registration. */
  readonly nullRegistrationAttempts?: readonly string[];
  readonly defaultWindowBounds?: TauriWindow.TauriWindowBounds;
}

export interface FakeProcessRegisterParams {
  readonly attemptId: string;
  readonly pid: ChildProcessSpawner.ProcessId;
  readonly kind: ManagedChildProcessFacts["kind"];
  readonly spawnedAtMs: number;
}

export interface FakeProcessRegisterResult {
  readonly registrationId: string | null;
}

export interface FakeProcessUnregisterParams {
  readonly registrationId: string;
}

export interface FakeProcessCancelParams {
  readonly attemptId: string;
}

type AppRequestMethod = TauriApp.TauriShellRequestMethod;
type AppNotificationMethod = TauriApp.TauriShellNotificationMethod;
type AppEventName = TauriApp.TauriShellEventName;
type WindowRequestMethod = TauriWindow.TauriWindowRequestMethod;
type WindowNotificationMethod = TauriWindow.TauriWindowNotificationMethod;

type EventListener = (params: unknown) => TauriApp.TauriShellEventResult | void;
type WindowEventListener = (params: TauriWindow.TauriWindowEventParams) => void;

const defaultHello: TauriApp.TauriShellHelloResult = {
  appName: "Agent Nanoni",
  identifier: "app.nanoni.agent.desktop",
  version: "1.0.0",
  tauriVersion: "2.11.5",
  platform: "win32",
  arch: "x64",
  isDev: true,
  execPath: "C:/agent-nanoni/AgentNanoni.exe",
  resourceDir: "C:/agent-nanoni/resources",
  serverRoot: "C:/agent-nanoni/resources/server",
  appDataDir: "C:/Users/test/AppData/Roaming/Agent Nanoni",
  logDir: "C:/Users/test/AppData/Roaming/Agent Nanoni/logs",
  systemLocale: "en-US",
  deepLinkScheme: "agent-nanoni",
  argv: ["--dev"],
  launchUrls: [],
};

const defaultMetrics: readonly TauriApp.TauriShellMetric[] = [];

const emptyBounds: TauriWindow.TauriWindowBounds = {
  x: 0,
  y: 0,
  width: 1024,
  height: 768,
};

const cloneBounds = (bounds: TauriWindow.TauriWindowBounds): TauriWindow.TauriWindowBounds => ({
  x: bounds.x,
  y: bounds.y,
  width: bounds.width,
  height: bounds.height,
});

interface WindowState {
  readonly label: string;
  bounds: TauriWindow.TauriWindowBounds;
  title: string;
  backgroundColor: string;
  zoomFactor: number;
  visible: boolean;
  focused: boolean;
  minimized: boolean;
  maximized: boolean;
  fullscreen: boolean;
  destroyed: boolean;
}

const initialWindowState = (
  params: TauriWindow.TauriWindowCreateParams,
  fallbackBounds: TauriWindow.TauriWindowBounds,
): WindowState => ({
  label: params.label,
  bounds: {
    x: params.x ?? fallbackBounds.x,
    y: params.y ?? fallbackBounds.y,
    width: params.width,
    height: params.height,
  },
  title: params.title,
  backgroundColor: params.backgroundColor,
  zoomFactor: params.zoomFactor ?? 0,
  visible: params.show,
  focused: false,
  minimized: false,
  maximized: false,
  fullscreen: false,
  destroyed: false,
});

/**
 * In-memory shell boundary used by the V1.1 host tests.
 *
 * This intentionally models ports and observable calls only.  It has no
 * framing, transport, lifecycle deadlines, or native process identity checks;
 * those behaviours belong to V1.2.
 */
export class FakeShell {
  readonly registry: ManagedChildRegistry;
  readonly app: TauriApp.TauriShellPort;
  readonly shell: TauriShell.TauriShellPort;
  readonly window: TauriWindow.TauriWindowPort;

  readonly #helloCalls: TauriApp.TauriShellHelloParams[] = [];
  readonly #requests: FakeShellCall[] = [];
  readonly #notifications: FakeShellCall[] = [];
  readonly #events: FakeShellEventRecord[] = [];
  readonly #ipcPushes: FakeShellIpcPush[] = [];
  readonly #registrations: FakeShellProcessRegistration[] = [];
  readonly #unregistrations: FakeShellProcessAction[] = [];
  readonly #cancellations: FakeShellProcessAction[] = [];
  readonly #listeners = new Map<string, Set<EventListener>>();
  readonly #windowListeners = new Set<WindowEventListener>();
  readonly #windows = new Map<string, WindowState>();
  readonly #registrationsByToken = new Map<string, FakeShellProcessRegistration>();
  readonly #registrationsByAttempt = new Map<string, FakeShellProcessRegistration>();
  readonly #protocolSchemes: Set<string>;
  readonly #nullRegistrationAttempts: Set<string>;
  readonly #metrics: readonly TauriApp.TauriShellMetric[];
  readonly #hello: TauriApp.TauriShellHelloResult;
  readonly #registrationIdPrefix: string;
  readonly #defaultWindowBounds: TauriWindow.TauriWindowBounds;
  #nextRegistrationId = 1;
  #nextWindowId = 1;

  constructor(options: FakeShellOptions = {}) {
    this.#hello = { ...defaultHello, ...options.hello };
    this.#metrics = options.metrics ?? defaultMetrics;
    this.#protocolSchemes = new Set(options.registeredProtocolSchemes ?? []);
    this.#nullRegistrationAttempts = new Set(options.nullRegistrationAttempts ?? []);
    this.#registrationIdPrefix = options.registrationIdPrefix ?? "registration";
    this.#defaultWindowBounds = options.defaultWindowBounds ?? emptyBounds;

    this.registry = {
      register: (facts) => this.register(facts),
      unregister: (registrationId) => this.unregister(registrationId),
      cancel: (attemptId) => this.cancel(attemptId),
    };
    this.app = {
      hello: (params) => this.hello(params),
      request: (method, params) => this.request(method, params),
      notify: (method, params) => this.notify(method, params),
      on: (method, listener) => this.on(method, listener),
    };
    this.shell = {
      request: (method, params) => this.request(method, params),
      notify: (method, params) => this.notify(method, params),
    };
    this.window = {
      create: (params) => this.create(params),
      request: (method, params) => this.request(method, params),
      notify: (method, params) => this.notify(method, params),
      on: (method, listener) => this.on(method, listener),
    };
  }

  get audit(): FakeShellAudit {
    return {
      hello: [...this.#helloCalls],
      requests: [...this.#requests],
      notifications: [...this.#notifications],
      events: [...this.#events],
      ipcPushes: [...this.#ipcPushes],
      registrations: [...this.#registrations],
      unregistrations: [...this.#unregistrations],
      cancellations: [...this.#cancellations],
    };
  }

  get helloCalls(): readonly TauriApp.TauriShellHelloParams[] {
    return this.#helloCalls;
  }

  get requests(): readonly FakeShellCall[] {
    return this.#requests;
  }

  get notifications(): readonly FakeShellCall[] {
    return this.#notifications;
  }

  get events(): readonly FakeShellEventRecord[] {
    return this.#events;
  }

  get ipcPushes(): readonly FakeShellIpcPush[] {
    return this.#ipcPushes;
  }

  get registrations(): readonly FakeShellProcessRegistration[] {
    return this.#registrations;
  }

  get unregistrations(): readonly FakeShellProcessAction[] {
    return this.#unregistrations;
  }

  get cancellations(): readonly FakeShellProcessAction[] {
    return this.#cancellations;
  }

  /** Registrations which have not received an unregister/cancel action. */
  get activeRegistrations(): readonly FakeShellProcessRegistration[] {
    return [...this.#registrationsByToken.values()];
  }

  hello(params: TauriApp.TauriShellHelloParams): Promise<TauriApp.TauriShellHelloResult> {
    this.#helloCalls.push(params);
    return Promise.resolve({ ...this.#hello });
  }

  request<Method extends AppRequestMethod>(
    method: Method,
    params: TauriApp.TauriShellRequestParams<Method>,
  ): Promise<TauriApp.TauriShellRequestResult<Method>>;
  request(
    method: "shell.openExternal",
    params: TauriShell.TauriShellOpenExternalParams,
  ): Promise<TauriShell.TauriShellOpenExternalResult>;
  request(method: WindowRequestMethod, params: { readonly label: string }): Promise<unknown>;
  request(
    method: "process.register",
    params: FakeProcessRegisterParams,
  ): Promise<FakeProcessRegisterResult>;
  request(method: string, params: unknown): Promise<unknown> {
    this.#requests.push({ method, params });
    switch (method) {
      case "app.isProtocolClient":
        return Promise.resolve({
          registered: this.#protocolSchemes.has(
            (params as TauriApp.TauriShellProtocolClientParams).scheme,
          ),
        });
      case "app.setProtocolClient":
        this.#protocolSchemes.add((params as TauriApp.TauriShellProtocolClientParams).scheme);
        return Promise.resolve({ ok: true });
      case "app.getMetrics":
        return Promise.resolve(this.#metrics.map((metric) => ({ ...metric })));
      case "shell.openExternal":
        return Promise.resolve({ ok: true });
      case "window.getBounds": {
        const state = this.#windows.get((params as { readonly label: string }).label);
        if (state === undefined)
          return Promise.resolve({ ...this.#defaultWindowBounds, maximized: false });
        return Promise.resolve({ ...state.bounds, maximized: state.maximized });
      }
      case "window.getState": {
        const state = this.#windows.get((params as { readonly label: string }).label);
        return Promise.resolve(
          state === undefined
            ? {
                visible: false,
                focused: false,
                minimized: false,
                maximized: false,
                fullscreen: false,
                destroyed: true,
              }
            : { ...state },
        );
      }
      case "process.register":
        return Effect.runPromise(this.register(params as FakeProcessRegisterParams));
      default:
        return Promise.resolve({});
    }
  }

  notify<Method extends AppNotificationMethod>(
    method: Method,
    params: TauriApp.TauriShellNotificationParams<Method>,
  ): Promise<void>;
  notify(
    method: "clipboard.writeText",
    params: TauriShell.TauriShellClipboardWriteTextParams,
  ): Promise<void>;
  notify(method: WindowNotificationMethod, params: unknown): Promise<void>;
  notify(method: "process.unregister", params: FakeProcessUnregisterParams): Promise<void>;
  notify(method: "process.cancel", params: FakeProcessCancelParams): Promise<void>;
  notify(method: string, params: unknown): Promise<void> {
    this.#notifications.push({ method, params });
    if (method === "ipc.push") {
      const push = params as { readonly channel: string; readonly payload: unknown };
      this.#ipcPushes.push({ channel: push.channel, payload: push.payload });
    }
    if (method === "clipboard.writeText") {
      // Clipboard writes are notifications too, and remain visible in the
      // shared notification audit above.
    }
    switch (method) {
      case "process.unregister":
        return Effect.runPromise(
          this.unregister((params as FakeProcessUnregisterParams).registrationId),
        );
      case "process.cancel":
        return Effect.runPromise(this.cancel((params as FakeProcessCancelParams).attemptId));
      case "window.show":
      case "window.hide":
      case "window.close":
      case "window.destroy":
      case "window.focus":
      case "window.minimize":
      case "window.restore":
      case "window.maximize":
      case "window.unmaximize":
      case "window.reload":
      case "window.toggleDevTools":
      case "window.setFullscreen":
      case "window.setTitle":
      case "window.setBounds":
      case "window.setBackgroundColor":
      case "window.setZoom":
      case "window.setAlwaysOnTop":
        this.applyWindowNotification(method, params);
        return Promise.resolve();
      default:
        return Promise.resolve();
    }
  }

  on<Method extends AppEventName>(
    method: Method,
    listener: (
      params: TauriApp.TauriShellEventParams<Method>,
    ) => TauriApp.TauriShellEventResult | void,
  ): () => void;
  on(method: "window.event", listener: WindowEventListener): () => void;
  on(method: string, listener: EventListener | WindowEventListener): () => void {
    if (method === "window.event") {
      const windowListener = listener as WindowEventListener;
      this.#windowListeners.add(windowListener);
      return () => this.#windowListeners.delete(windowListener);
    }
    const listeners = this.#listeners.get(method) ?? new Set<EventListener>();
    const appListener = listener as EventListener;
    listeners.add(appListener);
    this.#listeners.set(method, listeners);
    return () => {
      listeners.delete(appListener);
      if (listeners.size === 0) this.#listeners.delete(method);
    };
  }

  /** Emit a shell event synchronously; before-quit returns the prevention ack. */
  emit<Method extends AppEventName>(
    method: Method,
    params: TauriApp.TauriShellEventParams<Method>,
  ): TauriApp.TauriShellEventResult | void;
  emit(method: "window.event", params: TauriWindow.TauriWindowEventParams): void;
  emit(method: string, params: unknown): TauriApp.TauriShellEventResult | void {
    if (method === "window.event") {
      const event = params as TauriWindow.TauriWindowEventParams;
      this.#windowListeners.forEach((listener) => listener(event));
      this.#events.push({ method, params });
      return;
    }
    const listeners = this.#listeners.get(method);
    let prevented = false;
    if (listeners !== undefined) {
      for (const listener of [...listeners]) {
        const result = listener(params);
        if (result?.prevented === true) prevented = true;
      }
    }
    const result = method === "app.before-quit" ? { prevented } : undefined;
    this.#events.push({ method, params, ...(result === undefined ? {} : { result }) });
    return result;
  }

  emitAppEvent<Method extends AppEventName>(
    method: Method,
    params: TauriApp.TauriShellEventParams<Method>,
  ): TauriApp.TauriShellEventResult | void {
    return this.emit(method, params);
  }

  emitWindowEvent(params: TauriWindow.TauriWindowEventParams): void {
    this.emit("window.event", params);
  }

  create(
    params: TauriWindow.TauriWindowCreateParams,
  ): Promise<TauriWindow.TauriWindowCreateResult> {
    const state = initialWindowState(params, this.#defaultWindowBounds);
    this.#windows.set(params.label, state);
    this.#requests.push({ method: "window.create", params });
    this.#events.push({ method: "window.create", params, result: { label: params.label } });
    this.emitWindowEvent({ label: params.label, type: "created" });
    const id = this.#nextWindowId;
    this.#nextWindowId += 1;
    return Promise.resolve({ label: params.label, id });
  }

  register(facts: ManagedChildProcessFacts): Effect.Effect<ManagedChildRegistration> {
    return Effect.sync(() => {
      const existing = this.#registrationsByAttempt.get(facts.attemptId);
      if (existing !== undefined) return { registrationId: existing.registrationId };

      const registrationId = this.#nullRegistrationAttempts.has(facts.attemptId)
        ? null
        : `${this.#registrationIdPrefix}-${String(this.#nextRegistrationId++)}`;
      const record: FakeShellProcessRegistration = {
        attemptId: facts.attemptId,
        pid: facts.pid,
        kind: facts.kind,
        spawnedAtMs: facts.spawnedAtMs,
        registrationId,
      };
      this.#registrations.push(record);
      this.#registrationsByAttempt.set(facts.attemptId, record);
      if (registrationId !== null) this.#registrationsByToken.set(registrationId, record);
      return { registrationId };
    });
  }

  unregister(registrationId: string): Effect.Effect<void> {
    return Effect.sync(() => {
      this.#unregistrations.push({ registrationId });
      const record = this.#registrationsByToken.get(registrationId);
      if (record === undefined) return;
      this.#registrationsByToken.delete(registrationId);
      this.#registrationsByAttempt.delete(record.attemptId);
    });
  }

  cancel(attemptId: string): Effect.Effect<void> {
    return Effect.sync(() => {
      this.#cancellations.push({ attemptId });
      const record = this.#registrationsByAttempt.get(attemptId);
      if (record === undefined) return;
      this.#registrationsByAttempt.delete(attemptId);
      if (record.registrationId !== null) this.#registrationsByToken.delete(record.registrationId);
    });
  }

  private applyWindowNotification(method: WindowNotificationMethod, params: unknown): void {
    const body = typeof params === "object" && params !== null ? params : {};
    const labelValue = Reflect.get(body, "label");
    if (typeof labelValue !== "string") return;
    const state = this.#windows.get(labelValue);
    if (state === undefined) return;

    switch (method) {
      case "window.show":
        state.visible = true;
        state.minimized = false;
        break;
      case "window.hide":
        state.visible = false;
        state.focused = false;
        break;
      case "window.close":
      case "window.destroy":
        state.destroyed = true;
        state.visible = false;
        state.focused = false;
        break;
      case "window.focus":
        state.visible = true;
        state.focused = true;
        break;
      case "window.minimize":
        state.minimized = true;
        break;
      case "window.restore":
        state.minimized = false;
        break;
      case "window.maximize":
        state.maximized = true;
        break;
      case "window.unmaximize":
        state.maximized = false;
        break;
      case "window.setFullscreen": {
        const fullscreen = Reflect.get(body, "fullscreen");
        if (typeof fullscreen === "boolean") state.fullscreen = fullscreen;
        break;
      }
      case "window.setTitle": {
        const title = Reflect.get(body, "title");
        if (typeof title === "string") state.title = title;
        break;
      }
      case "window.setBounds": {
        const bounds = body as Partial<TauriWindow.TauriWindowBounds>;
        state.bounds = {
          x: typeof bounds.x === "number" ? bounds.x : state.bounds.x,
          y: typeof bounds.y === "number" ? bounds.y : state.bounds.y,
          width: typeof bounds.width === "number" ? bounds.width : state.bounds.width,
          height: typeof bounds.height === "number" ? bounds.height : state.bounds.height,
        };
        break;
      }
      case "window.setBackgroundColor": {
        const color = Reflect.get(body, "color");
        if (typeof color === "string") state.backgroundColor = color;
        break;
      }
      case "window.setZoom": {
        const zoomFactor = Reflect.get(body, "zoomFactor");
        if (typeof zoomFactor === "number") state.zoomFactor = zoomFactor;
        break;
      }
      case "window.reload":
      case "window.toggleDevTools":
      case "window.setAlwaysOnTop":
        break;
      case "ipc.push":
        return;
    }
    this.emitWindowEvent({ label: labelValue, type: this.windowEventType(method), data: params });
  }

  private windowEventType(
    method: Exclude<WindowNotificationMethod, "ipc.push">,
  ): TauriWindow.TauriWindowEventType {
    switch (method) {
      case "window.show":
        return "focus";
      case "window.hide":
        return "blur";
      case "window.close":
      case "window.destroy":
        return "closed";
      case "window.focus":
        return "focus";
      case "window.minimize":
        return "minimized";
      case "window.restore":
        return "restored";
      case "window.maximize":
        return "maximized";
      case "window.unmaximize":
        return "unmaximized";
      case "window.setFullscreen":
        return "fullscreen";
      case "window.setBounds":
        return "resized";
      default:
        return "focus";
    }
  }
}

export const make = (options?: FakeShellOptions): FakeShell => new FakeShell(options);
