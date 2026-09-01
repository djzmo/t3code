import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import type * as Electron from "electron";
import type * as DesktopWindowService from "../../window/DesktopWindow.ts";
import * as TauriEnvironment from "./TauriEnvironment.ts";
import * as TauriWindow from "../electron/TauriWindow.ts";

/**
 * Phase 0's desktop window service only owns the bootstrap/reveal path.  Full
 * bounds persistence, previews, crash recovery, and native chrome are F3/F5
 * work and deliberately stay outside this façade.
 */
export const DesktopWindow = Context.Service<
  DesktopWindowService.DesktopWindow,
  DesktopWindowService.DesktopWindow["Service"]
>()("@t3tools/desktop/window/DesktopWindow");

const MAIN_WINDOW_OPTIONS: Electron.BrowserWindowConstructorOptions = {
  width: 1320,
  height: 880,
  minWidth: 840,
  minHeight: 620,
  show: false,
  frame: true,
  title: "",
};

export const make = Effect.gen(function* () {
  const environment = yield* TauriEnvironment.DesktopEnvironment;
  const electronWindow = yield* TauriWindow.ElectronWindow;
  const mainRef = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
  const backendReadyRef = yield* Ref.make(false);
  const mainWindowOptions: Electron.BrowserWindowConstructorOptions = {
    ...MAIN_WINDOW_OPTIONS,
    title: environment.displayName,
  };

  const createMain = Effect.gen(function* () {
    const existing = yield* Ref.get(mainRef);
    if (Option.isSome(existing) && !existing.value.isDestroyed()) return existing.value;
    const created = yield* electronWindow.create(mainWindowOptions);
    yield* electronWindow.setMain(created);
    yield* Ref.set(mainRef, Option.some(created));
    return created;
  });

  const ensureMain = Effect.gen(function* () {
    const existing = yield* Ref.get(mainRef);
    if (Option.isSome(existing) && !existing.value.isDestroyed()) return existing.value;
    return yield* createMain;
  });

  const revealOrCreateMain = Effect.gen(function* () {
    const window = yield* ensureMain;
    yield* electronWindow.reveal(window);
    return window;
  });

  const createMainIfBackendReady = Effect.gen(function* () {
    if (!(yield* Ref.get(backendReadyRef))) return;
    const existing = yield* Ref.get(mainRef);
    if (Option.isSome(existing) && !existing.value.isDestroyed()) return;
    yield* createMain;
  });

  return DesktopWindow.of({
    createMain,
    ensureMain,
    revealOrCreateMain,
    activate: Effect.gen(function* () {
      const existing = yield* Ref.get(mainRef);
      if (Option.isSome(existing) && !existing.value.isDestroyed()) {
        yield* electronWindow.reveal(existing.value);
        return;
      }
      yield* createMainIfBackendReady;
    }),
    createMainIfBackendReady,
    // The connecting splash is intentionally omitted in V1.1.  F3 owns the
    // second window and its lifecycle; keeping this effect inert lets the
    // unchanged bootstrap proceed without manufacturing a partial splash.
    showConnectingSplash: Effect.void,
    handleBackendReady: Effect.fn("tauri.desktopWindow.handleBackendReady")(function* (
      _httpBaseUrl: URL,
    ) {
      yield* Ref.set(backendReadyRef, true);
      // Tauri has no Electron `ready-to-show` event in the host process;
      // reveal after the shell acknowledges creation instead.
      yield* revealOrCreateMain;
    }),
    handleBackendNotReady: Ref.set(backendReadyRef, false),
    flushMainWindowBounds: Effect.void,
    dispatchMenuAction: Effect.fn("tauri.desktopWindow.dispatchMenuAction")(function* (action) {
      const target = yield* ensureMain;
      if (target.isDestroyed()) return;
      target.webContents.send("desktop:menu-action", action);
      yield* electronWindow.reveal(target);
    }),
    zoomMain: () => Effect.void,
    syncAppearance: Effect.void,
  });
});

export const layer = Layer.effect(DesktopWindow, make);
