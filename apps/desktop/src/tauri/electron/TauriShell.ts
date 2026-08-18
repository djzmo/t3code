import { REMOTE_CAPABLE_EDITOR_IDS, remoteSchemeForEditor } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type * as ElectronShellService from "../../electron/ElectronShell.ts";

export interface TauriShellOpenExternalParams {
  readonly url: string;
}

export interface TauriShellOpenExternalResult {
  readonly ok: boolean;
}

export interface TauriShellClipboardWriteTextParams {
  readonly text: string;
}

/** Small transport-agnostic port for the shell methods used by ElectronShell. */
export interface TauriShellPort {
  readonly request: (
    method: "shell.openExternal",
    params: TauriShellOpenExternalParams,
  ) => Promise<TauriShellOpenExternalResult> | TauriShellOpenExternalResult;
  readonly notify: (
    method: "clipboard.writeText",
    params: TauriShellClipboardWriteTextParams,
  ) => Promise<void> | void;
}

/** Keep the upstream service key and exact service shape without loading Electron. */
export const ElectronShell = Context.Service<
  ElectronShellService.ElectronShell,
  ElectronShellService.ElectronShell["Service"]
>()("@t3tools/desktop/electron/ElectronShell");

export class TauriShellOpenExternalError extends Schema.TaggedErrorClass<TauriShellOpenExternalError>()(
  "TauriShellOpenExternalError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Tauri shell failed to open an external URL.";
  }
}

export class TauriShellClipboardWriteError extends Schema.TaggedErrorClass<TauriShellClipboardWriteError>()(
  "TauriShellClipboardWriteError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Tauri shell failed to write clipboard text.";
  }
}

// Remote open-in-editor deep links (`vscode://vscode-remote+…`) must reach the
// OS handler; every other non-web scheme stays blocked, matching ElectronShell.
const SAFE_EXTERNAL_PROTOCOLS = new Set([
  "http:",
  "https:",
  ...REMOTE_CAPABLE_EDITOR_IDS.flatMap((id) => {
    const scheme = remoteSchemeForEditor(id);
    return scheme === undefined ? [] : [`${scheme}:`];
  }),
]);

export function parseSafeExternalUrl(rawUrl: unknown): Option.Option<string> {
  if (typeof rawUrl !== "string") {
    return Option.none();
  }

  try {
    const url = new URL(rawUrl);
    return SAFE_EXTERNAL_PROTOCOLS.has(url.protocol) ? Option.some(url.href) : Option.none();
  } catch {
    return Option.none();
  }
}

export const make = (port: TauriShellPort): ElectronShellService.ElectronShell["Service"] =>
  ElectronShell.of({
    openExternal: (rawUrl) =>
      Option.match(parseSafeExternalUrl(rawUrl), {
        onNone: () => Effect.succeed(false),
        onSome: (url) =>
          Effect.tryPromise({
            try: async () => port.request("shell.openExternal", { url }),
            catch: (cause) => new TauriShellOpenExternalError({ cause }),
          }).pipe(
            Effect.map((result) => result.ok),
            Effect.orElseSucceed(() => false),
          ),
      }),
    copyText: (text) =>
      Effect.tryPromise({
        try: async () => {
          await port.notify("clipboard.writeText", { text });
        },
        catch: (cause) => new TauriShellClipboardWriteError({ cause }),
      }).pipe(Effect.orDie, Effect.asVoid),
  });

export const layer = (port: TauriShellPort) => Layer.succeed(ElectronShell, make(port));
