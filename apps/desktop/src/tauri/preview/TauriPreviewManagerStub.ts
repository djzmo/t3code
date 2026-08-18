import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import type * as PreviewManagerService from "../../preview/Manager.ts";

/**
 * Phase 0 does not create a browser surface. Keep the upstream service key so
 * the host can compose the existing desktop program without importing the
 * Electron-backed implementation.
 */
export const PreviewManager = Context.Service<
  PreviewManagerService.PreviewManager,
  PreviewManagerService.PreviewManager["Service"]
>()("@t3tools/desktop/preview/Manager/PreviewManager");

type PreviewManagerError = PreviewManagerService.PreviewManagerError;
type BrowserSession = Effect.Success<
  ReturnType<PreviewManagerService.PreviewManager["Service"]["getBrowserSession"]>
>;

// DesktopWindow uses getBrowserSession only as a readiness probe in the
// headless host. The value is never observed until the Tauri window façade is
// introduced, so an opaque stable object is the smallest safe placeholder.
// This is the sole boundary cast in this stub: Electron.Session is an opaque
// runtime object that cannot be constructed without loading Electron.
const bootstrapSession = Object.freeze({}) as unknown as BrowserSession;

export class PreviewOperationError extends Schema.TaggedErrorClass<PreviewOperationError>()(
  "PreviewOperationError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop preview operation failed: ${this.operation}`;
  }
}

const unsupported = (operation: string): Effect.Effect<never, PreviewManagerError> =>
  Effect.fail(
    new PreviewOperationError({
      operation,
      cause: new Error(`Preview is unavailable in the Tauri Phase 0 host: ${operation}.`),
    }),
  );

export const make = PreviewManager.of({
  setMainWindow: () => Effect.void,
  getBrowserSession: () => Effect.succeed(bootstrapSession),
  isBrowserPartition: () => false,
  createTab: () => unsupported("createTab"),
  closeTab: () => unsupported("closeTab"),
  registerWebview: () => unsupported("registerWebview"),
  navigate: () => unsupported("navigate"),
  goBack: () => unsupported("goBack"),
  goForward: () => unsupported("goForward"),
  refresh: () => unsupported("refresh"),
  zoomIn: () => unsupported("zoomIn"),
  zoomOut: () => unsupported("zoomOut"),
  resetZoom: () => unsupported("resetZoom"),
  reapplyZoom: () => Effect.void,
  hardReload: () => unsupported("hardReload"),
  setColorScheme: () => unsupported("setColorScheme"),
  openDevTools: () => unsupported("openDevTools"),
  clearCookies: () => unsupported("clearCookies"),
  clearCache: () => unsupported("clearCache"),
  getBrowserPartition: () => unsupported("getBrowserPartition"),
  setAnnotationTheme: () => unsupported("setAnnotationTheme"),
  pickElement: () => unsupported("pickElement"),
  cancelPickElement: () => unsupported("cancelPickElement"),
  captureScreenshot: () => unsupported("captureScreenshot"),
  revealArtifact: () => unsupported("revealArtifact"),
  copyArtifactToClipboard: () => unsupported("copyArtifactToClipboard"),
  openPictureInPicture: () => unsupported("openPictureInPicture"),
  closePictureInPicture: () => unsupported("closePictureInPicture"),
  startRecording: () => unsupported("startRecording"),
  stopRecording: () => unsupported("stopRecording"),
  saveRecording: () => unsupported("saveRecording"),
  automationStatus: () => unsupported("automationStatus"),
  automationSnapshot: () => unsupported("automationSnapshot"),
  automationClick: () => unsupported("automationClick"),
  automationType: () => unsupported("automationType"),
  automationPress: () => unsupported("automationPress"),
  automationScroll: () => unsupported("automationScroll"),
  automationEvaluate: () => unsupported("automationEvaluate"),
  automationWaitFor: () => unsupported("automationWaitFor"),
  subscribeStateChanges: () => Effect.void,
  subscribePointerEvents: () => Effect.void,
  subscribeRecordingFrames: () => Effect.void,
});

export const layer = Layer.succeed(PreviewManager, make);
