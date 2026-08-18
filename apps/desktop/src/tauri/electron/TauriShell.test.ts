// @effect-diagnostics nodeBuiltinImport:off
import { readFileSync } from "node:fs";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { REMOTE_CAPABLE_EDITOR_IDS, remoteSchemeForEditor } from "@t3tools/contracts";

import * as ElectronShell from "../../electron/ElectronShell.ts";
import * as TauriShell from "./TauriShell.ts";

describe("TauriShell", () => {
  it("uses the upstream ElectronShell service key", () => {
    assert.equal(TauriShell.ElectronShell.key, ElectronShell.ElectronShell.key);
  });

  it.effect("forwards allowed URLs and returns the shell boolean exactly", () => {
    const calls: Array<{
      readonly method: "shell.openExternal";
      readonly params: TauriShell.TauriShellOpenExternalParams;
    }> = [];
    const port: TauriShell.TauriShellPort = {
      request: (method, params) => {
        calls.push({ method, params });
        return { ok: false };
      },
      notify: async () => {},
    };

    return Effect.gen(function* () {
      const shell = yield* ElectronShell.ElectronShell;
      const result = yield* shell.openExternal("https://example.com/path");

      assert.strictEqual(result, false);
      assert.deepEqual(calls, [
        {
          method: "shell.openExternal",
          params: { url: "https://example.com/path" },
        },
      ]);
    }).pipe(Effect.provide(TauriShell.layer(port)));
  });

  it("keeps the external URL allow-list in parity with ElectronShell", () => {
    const urls = [
      "http://example.com/path?q=1",
      "https://example.com/path?q=1",
      ...REMOTE_CAPABLE_EDITOR_IDS.map((editorId) => {
        const scheme = remoteSchemeForEditor(editorId);
        assert.isString(scheme);
        return `${scheme}://vscode-remote/ssh-remote+dev/workspace`;
      }),
    ];

    for (const rawUrl of urls) {
      const expected = ElectronShell.parseSafeExternalUrl(rawUrl);
      const actual = TauriShell.parseSafeExternalUrl(rawUrl);

      assert.equal(Option.isSome(actual), Option.isSome(expected), rawUrl);
      if (Option.isSome(actual) && Option.isSome(expected)) {
        assert.equal(actual.value, expected.value, rawUrl);
      }
    }
  });

  it("accepts every upstream remote editor scheme through the RPC port", () => {
    const calls: TauriShell.TauriShellOpenExternalParams[] = [];
    const port: TauriShell.TauriShellPort = {
      request: (_method, params) => {
        calls.push(params);
        return { ok: true };
      },
      notify: async () => {},
    };

    return Effect.gen(function* () {
      const shell = yield* ElectronShell.ElectronShell;

      for (const editorId of REMOTE_CAPABLE_EDITOR_IDS) {
        const scheme = remoteSchemeForEditor(editorId);
        assert.isString(scheme);
        const url = `${scheme}://vscode-remote/ssh-remote+dev/workspace`;
        assert.isTrue(yield* shell.openExternal(url), url);
      }

      assert.deepEqual(
        calls.map(({ url }) => url),
        REMOTE_CAPABLE_EDITOR_IDS.map((editorId) => {
          const scheme = remoteSchemeForEditor(editorId);
          assert.isString(scheme);
          return `${scheme}://vscode-remote/ssh-remote+dev/workspace`;
        }),
      );
    }).pipe(Effect.provide(TauriShell.layer(port)));
  });

  it.effect("does not notify the shell for malformed or disallowed URLs", () => {
    const calls: string[] = [];
    const port: TauriShell.TauriShellPort = {
      request: (method) => {
        calls.push(method);
        return { ok: true };
      },
      notify: async () => {},
    };

    return Effect.gen(function* () {
      const shell = yield* ElectronShell.ElectronShell;
      assert.isFalse(yield* shell.openExternal("file:///private/secret"));
      assert.isFalse(yield* shell.openExternal("javascript:alert(1)"));
      assert.isFalse(yield* shell.openExternal("data:text/plain,secret"));
      assert.isFalse(yield* shell.openExternal("not a URL"));
      assert.isFalse(yield* shell.openExternal(42));
      assert.deepEqual(calls, []);
    }).pipe(Effect.provide(TauriShell.layer(port)));
  });

  it.effect("rejects unsafe URL families without invoking the RPC port", () => {
    const calls: TauriShell.TauriShellOpenExternalParams[] = [];
    const port: TauriShell.TauriShellPort = {
      request: (_method, params) => {
        calls.push(params);
        return { ok: true };
      },
      notify: async () => {},
    };
    const unsafeUrls: unknown[] = [
      "file:///private/secret",
      "javascript:alert(1)",
      "data:text/plain,secret",
      "blob:https://example.com/id",
      "custom://arbitrary",
      "vscode+evil://vscode-remote/ssh-remote+dev/workspace",
      "https://",
      "http://[::1",
      "",
      "   ",
      null,
      undefined,
      42,
      { toString: () => "https://example.com" },
    ];

    return Effect.gen(function* () {
      const shell = yield* ElectronShell.ElectronShell;

      for (const rawUrl of unsafeUrls) {
        assert.isFalse(yield* shell.openExternal(rawUrl), String(rawUrl));
      }

      assert.deepEqual(calls, []);
    }).pipe(Effect.provide(TauriShell.layer(port)));
  });

  it.effect("preserves allow-listed remote editor schemes", () => {
    const calls: TauriShell.TauriShellOpenExternalParams[] = [];
    const port: TauriShell.TauriShellPort = {
      request: (_method, params) => {
        calls.push(params);
        return { ok: true };
      },
      notify: async () => {},
    };

    return Effect.gen(function* () {
      const shell = yield* ElectronShell.ElectronShell;
      const result = yield* shell.openExternal("vscode://vscode-remote/ssh-remote+dev/workspace");

      assert.isTrue(result);
      assert.deepEqual(calls, [{ url: "vscode://vscode-remote/ssh-remote+dev/workspace" }]);
    }).pipe(Effect.provide(TauriShell.layer(port)));
  });

  it.effect("returns false when the shell request rejects", () => {
    const port: TauriShell.TauriShellPort = {
      request: async () => {
        throw new Error("transport secret");
      },
      notify: async () => {},
    };

    return Effect.gen(function* () {
      const shell = yield* ElectronShell.ElectronShell;
      assert.isFalse(yield* shell.openExternal("https://example.com"));
    }).pipe(Effect.provide(TauriShell.layer(port)));
  });

  it.effect("maps copyText to the clipboard notification", () => {
    const calls: Array<{
      readonly method: "clipboard.writeText";
      readonly params: TauriShell.TauriShellClipboardWriteTextParams;
    }> = [];
    const port: TauriShell.TauriShellPort = {
      request: () => ({ ok: false }),
      notify: (method, params) => {
        calls.push({ method, params });
      },
    };

    return Effect.gen(function* () {
      const shell = yield* ElectronShell.ElectronShell;
      yield* shell.copyText("clipboard secret");
      assert.deepEqual(calls, [
        {
          method: "clipboard.writeText",
          params: { text: "clipboard secret" },
        },
      ]);
    }).pipe(Effect.provide(TauriShell.layer(port)));
  });

  it("does not import Electron or the upstream runtime implementation", () => {
    const source = readFileSync(new URL("./TauriShell.ts", import.meta.url), "utf8");

    assert.notMatch(source, /from\s+["']electron["']/);
    assert.notMatch(
      source,
      /^import\s+\*\s+as\s+ElectronShellService\s+from\s+["']\.\.\/\.\.\/electron\/ElectronShell\.ts["']/m,
    );
  });
});
