import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";

vi.mock("electron", () => ({}));

import * as ElectronPowerMonitor from "../../electron/ElectronPowerMonitor.ts";
import * as TauriPowerMonitor from "./TauriPowerMonitor.ts";

describe("TauriPowerMonitor", () => {
  it.effect("provides deterministic V1.1 values through the existing tag", () =>
    Effect.gen(function* () {
      assert.equal(
        TauriPowerMonitor.ElectronPowerMonitor.key,
        ElectronPowerMonitor.ElectronPowerMonitor.key,
      );

      const powerMonitor = yield* ElectronPowerMonitor.ElectronPowerMonitor;
      assert.isFalse(yield* powerMonitor.isOnBatteryPower);
      assert.equal(yield* powerMonitor.getSystemIdleTime, 0);
      assert.equal(yield* powerMonitor.getSystemIdleState(60), "active");
      assert.equal(yield* powerMonitor.getCurrentThermalState, "nominal");

      let invoked = false;
      const listener = () => {
        invoked = true;
      };
      yield* Effect.scoped(
        Effect.all([
          powerMonitor.onSimpleEvent("lock-screen", listener),
          powerMonitor.onThermalStateChange(() => listener()),
          powerMonitor.onSpeedLimitChange(() => listener()),
        ]),
      );
      assert.isFalse(invoked);
    }).pipe(Effect.provide(TauriPowerMonitor.layer)),
  );
});
