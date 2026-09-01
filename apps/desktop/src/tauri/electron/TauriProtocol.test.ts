import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";

const { handleMock, unhandleMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  unhandleMock: vi.fn(),
}));

vi.mock("electron", () => ({
  protocol: {
    handle: handleMock,
    unhandle: unhandleMock,
  },
}));

import * as ElectronProtocol from "../../electron/ElectronProtocol.ts";
import * as TauriProtocol from "./TauriProtocol.ts";

describe("TauriProtocol", () => {
  it.effect("provides the existing ElectronProtocol tag as a scoped no-op", () =>
    Effect.gen(function* () {
      assert.equal(TauriProtocol.ElectronProtocol.key, ElectronProtocol.ElectronProtocol.key);

      const protocol = yield* ElectronProtocol.ElectronProtocol;
      yield* Effect.scoped(
        protocol.registerDesktopProtocol({
          scheme: "t3code-dev",
          targetOrigin: new URL("http://127.0.0.1:3773/"),
          backendOrigin: new URL("http://127.0.0.1:3774/"),
          clerkFrontendApiHostname: undefined,
        }),
      );

      assert.isEmpty(handleMock.mock.calls);
      assert.isEmpty(unhandleMock.mock.calls);
    }).pipe(Effect.provide(TauriProtocol.layer)),
  );
});
