import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";

import * as ElectronTheme from "../../electron/ElectronTheme.ts";
import * as TauriTheme from "./TauriTheme.ts";

describe("TauriTheme", () => {
  it.effect("provides the existing ElectronTheme tag with deterministic stubs", () =>
    Effect.gen(function* () {
      assert.equal(TauriTheme.ElectronTheme.key, ElectronTheme.ElectronTheme.key);

      const theme = yield* ElectronTheme.ElectronTheme;
      assert.isFalse(yield* theme.shouldUseDarkColors);

      yield* theme.setSource("dark");
      yield* theme.setSource("light");

      const listener = vi.fn();
      yield* Effect.scoped(theme.onUpdated(listener));
      assert.isFalse(listener.mock.calls.length > 0);
    }).pipe(Effect.provide(TauriTheme.layer)),
  );
});
