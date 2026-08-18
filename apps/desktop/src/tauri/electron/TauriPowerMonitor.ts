import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type * as ElectronPowerMonitorService from "../../electron/ElectronPowerMonitor.ts";

/**
 * V1.1 has no platform power bridge yet.  Keep the Electron-facing service
 * key so the existing telemetry publisher can run against deterministic values
 * while the native implementation is deferred to F8.
 */
export const ElectronPowerMonitor = Context.Service<
  ElectronPowerMonitorService.ElectronPowerMonitor,
  ElectronPowerMonitorService.ElectronPowerMonitor["Service"]
>()("@t3tools/desktop/electron/ElectronPowerMonitor");

const noOpListener = () =>
  Effect.acquireRelease(Effect.void, () => Effect.void).pipe(Effect.asVoid);

export const make = ElectronPowerMonitor.of({
  isOnBatteryPower: Effect.succeed(false),
  getSystemIdleTime: Effect.succeed(0),
  getSystemIdleState: (_idleThresholdSeconds) => Effect.succeed("active" as const),
  getCurrentThermalState: Effect.succeed("nominal" as const),
  onSimpleEvent: (_eventName, _listener) => noOpListener(),
  onThermalStateChange: (_listener) => noOpListener(),
  onSpeedLimitChange: (_listener) => noOpListener(),
});

export const layer = Layer.succeed(ElectronPowerMonitor, make);
