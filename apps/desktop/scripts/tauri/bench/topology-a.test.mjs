import { assert, describe, it } from "vite-plus/test";

import {
  assertTopologyACriteria,
  createRendererEvaluationSource,
  evaluateTopologyA,
  finalizeTopologyAReload,
  makeExactEchoValue,
  measureEchoRoundTrips,
  measureExactEchoThroughput,
  measureOrderedPushes,
  p50,
  p99,
  createRendererPostReloadSource,
  TOPOLOGY_A_CHANNEL,
  TOPOLOGY_A_ECHO_COUNT,
  TOPOLOGY_A_MAX_BYTES,
  TOPOLOGY_A_PUSH_COUNT,
} from "./topology-a.mjs";

const makeAdapter = ({ brokenPushOrder = false, failEcho = false, delayedPushMs = 0 } = {}) => {
  let clock = 0;
  let snapshot = { boot: { version: "1.0.0" }, sync: { locale: "en-US" } };
  const listeners = new Set();
  const adapter = {
    now: () => clock,
    sleep: async (durationMs) => {
      clock += durationMs;
    },
    subscribePush(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async invoke(payload) {
      clock += 1;
      if (payload.op === "echo") {
        if (failEcho) throw new Error("fake echo failure");
        if (
          new TextEncoder().encode(JSON.stringify(payload.value)).byteLength > TOPOLOGY_A_MAX_BYTES
        ) {
          throw new Error("Topology A benchmark echo exceeds 1048576 bytes.");
        }
        return { value: payload.value };
      }
      if (payload.op === "push") {
        if (payload.seq < 0 || payload.seq >= TOPOLOGY_A_PUSH_COUNT) {
          throw new Error("Invalid Topology A benchmark request.");
        }
        const seq = brokenPushOrder ? TOPOLOGY_A_PUSH_COUNT - 1 - payload.seq : payload.seq;
        const deliver = () => {
          for (const listener of listeners) {
            listener({
              channel: "desktop:menu-action",
              payload: JSON.stringify({ seq, sentAt: payload.sentAt }),
            });
          }
          clock += 1;
        };
        if (delayedPushMs > 0) setTimeout(deliver, delayedPushMs);
        else deliver();
        return { seq: payload.seq };
      }
      throw new Error(`unexpected op ${payload.op}`);
    },
    async reload() {
      snapshot = JSON.parse(JSON.stringify(snapshot));
    },
    readSnapshot() {
      return snapshot;
    },
  };
  return adapter;
};

const rejects = async (run, pattern) => {
  try {
    await run();
    throw new Error("expected operation to reject");
  } catch (error) {
    assert.match(String(error), pattern);
  }
};

const executeRendererSource = async (
  source,
  desktopBridge,
  ready = Promise.resolve(true),
  boot = { productVersion: "1.0.0" },
  tauriInternals,
) => {
  const previousBridge = globalThis.desktopBridge;
  const previousReady = globalThis.__NANONI_EVENTS_READY__;
  const previousBoot = globalThis.__NANONI_BOOT__;
  const previousInternals = globalThis.__TAURI_INTERNALS__;
  globalThis.desktopBridge = desktopBridge;
  globalThis.__NANONI_EVENTS_READY__ = ready;
  globalThis.__NANONI_BOOT__ = boot;
  if (tauriInternals === undefined) delete globalThis.__TAURI_INTERNALS__;
  else globalThis.__TAURI_INTERNALS__ = tauriInternals;
  try {
    return await new Function(`return ${source}`)();
  } finally {
    if (previousBridge === undefined) delete globalThis.desktopBridge;
    else globalThis.desktopBridge = previousBridge;
    if (previousReady === undefined) delete globalThis.__NANONI_EVENTS_READY__;
    else globalThis.__NANONI_EVENTS_READY__ = previousReady;
    if (previousBoot === undefined) delete globalThis.__NANONI_BOOT__;
    else globalThis.__NANONI_BOOT__ = previousBoot;
    if (previousInternals === undefined) delete globalThis.__TAURI_INTERNALS__;
    else globalThis.__TAURI_INTERNALS__ = previousInternals;
  }
};

const makeRendererBridge = (core) => ({
  invoke: (_channel, payload) => core.invoke(payload),
  onMenuAction: (listener) => core.subscribePush((event) => listener(event.payload)),
  getAppBranding: () => null,
  getSystemLocale: () => "en-US",
  getLocalEnvironmentBootstraps: () => [],
  getWindowFullscreenState: () => false,
});

describe("Topology A benchmark core", () => {
  it("creates an exact one-mebibyte serialized echo value and computes percentiles", () => {
    const value = makeExactEchoValue();
    assert.equal(new TextEncoder().encode(JSON.stringify(value)).byteLength, TOPOLOGY_A_MAX_BYTES);
    assert.equal(p50([1, 2, 3, 4]), 2.5);
    assert.closeTo(p99([1, 2, 3, 4]), 3.97, 0.000_001);
  });

  it("requires at least 1000 echo samples and measures p50/p99", async () => {
    const adapter = makeAdapter();
    await rejects(
      () => measureEchoRoundTrips(adapter, { count: TOPOLOGY_A_ECHO_COUNT - 1 }),
      /at least 1000/,
    );
    const result = await measureEchoRoundTrips(adapter);
    assert.equal(result.count, TOPOLOGY_A_ECHO_COUNT);
    assert.isBelow(result.p50Ms, 50);
    assert.isBelow(result.p99Ms, 50);
    assert.isTrue(result.p99Pass);
  });

  it("requires exactly 100 ordered pushes and records per-push latency", async () => {
    const adapter = makeAdapter();
    const result = await measureOrderedPushes(adapter);
    assert.equal(result.count, TOPOLOGY_A_PUSH_COUNT);
    assert.deepEqual(result.sequence, [...Array(TOPOLOGY_A_PUSH_COUNT).keys()]);
    assert.lengthOf(result.latenciesMs, TOPOLOGY_A_PUSH_COUNT);
    assert.isTrue(result.ordered);
    await rejects(
      () => measureOrderedPushes(adapter, { count: TOPOLOGY_A_PUSH_COUNT - 1 }),
      /exactly 100/,
    );
    await rejects(
      () => measureOrderedPushes(makeAdapter({ brokenPushOrder: true })),
      /ordering violation/,
    );
    const delayed = await measureOrderedPushes(makeAdapter({ delayedPushMs: 2 }));
    assert.equal(delayed.events.length, TOPOLOGY_A_PUSH_COUNT);

    const burst = makeAdapter();
    burst.sleep = async () => undefined;
    const burstResult = await measureOrderedPushes(burst);
    assert.isFalse(burstResult.cadencePass);
    assert.isFalse(burstResult.ratePass);
  });

  it("measures the exact payload throughput and rejects alternate payload sizes", async () => {
    const result = await measureExactEchoThroughput(makeAdapter());
    assert.equal(result.bytes, TOPOLOGY_A_MAX_BYTES);
    assert.isAtLeast(result.throughputBytesPerSecond, TOPOLOGY_A_MAX_BYTES);
    await rejects(
      () => measureExactEchoThroughput(makeAdapter(), { bytes: TOPOLOGY_A_MAX_BYTES - 1 }),
      /exact payload must be 1048576 bytes/,
    );
  });

  it("compares boot and sync snapshots across reload and emits failure receipts", async () => {
    const result = await evaluateTopologyA(makeAdapter());
    assert.isTrue(result.pass);
    assert.isTrue(result.criteria.reloadStable);
    assert.isTrue(result.criteria.pushCadence);
    assert.isTrue(result.criteria.pushRate);
    assert.doesNotThrow(() => assertTopologyACriteria(result));

    const failed = await evaluateTopologyA(makeAdapter({ failEcho: true }));
    assert.isFalse(failed.pass);
    assert.isAtLeast(failed.failures.length, 1);
    assert.equal(failed.failures[0].kind, "failure");
    assert.equal(failed.failures[0].stage, "echo");
    assert.throws(() => assertTopologyACriteria(failed), /criteria failed/);
  });

  it("executes the renderer evaluation source with the canonical result shape", async () => {
    const core = makeAdapter();
    const source = createRendererEvaluationSource();
    assert.notInclude(source, "__NANONI_TOPOLOGY_A_BENCH_ADAPTER__");
    assert.include(source, "desktopBridge.invoke");
    assert.include(source, "desktopBridge.onMenuAction");
    const result = await executeRendererSource(source, makeRendererBridge(core));
    assert.equal(result.schemaVersion, 1);
    assert.equal(result.channel, TOPOLOGY_A_CHANNEL);
    assert.equal(result.phase, "before-reload");
    assert.equal(result.echoes.count, TOPOLOGY_A_ECHO_COUNT);
    assert.equal(result.pushes.count, TOPOLOGY_A_PUSH_COUNT);
    assert.equal(result.pushes.sequence[0], 0);
    assert.equal(result.pushes.sequence.at(-1), TOPOLOGY_A_PUSH_COUNT - 1);
    assert.isTrue(result.pushes.cadencePass);
    assert.isTrue(result.pushes.ratePass);
    assert.equal(result.exactEcho.bytes, TOPOLOGY_A_MAX_BYTES);
    assert.deepEqual(result.failureProbe, {
      invalidCountRejected: true,
      oversizedPayloadRejected: true,
      pass: true,
    });
    assert.isTrue(result.criteria.failureModes);
    assert.isFalse(result.pass);
    assert.deepEqual(result.failures, []);
  });

  it("uses the Tauri host invoke boundary when the real bridge has named methods only", async () => {
    const core = makeAdapter();
    const bridge = makeRendererBridge(core);
    delete bridge.invoke;
    const calls = [];
    const tauriInternals = {
      invoke(command, args) {
        calls.push([command, args]);
        return core.invoke(args.payload);
      },
    };

    const result = await executeRendererSource(
      createRendererEvaluationSource(),
      bridge,
      Promise.resolve(true),
      { productVersion: "1.0.0" },
      tauriInternals,
    );

    assert.equal(calls.length, TOPOLOGY_A_ECHO_COUNT + TOPOLOGY_A_PUSH_COUNT + 3);
    for (const [command, args] of calls) {
      assert.equal(command, "host_invoke");
      assert.deepEqual(Object.keys(args).sort(), ["channel", "payload"]);
      assert.equal(args.channel, TOPOLOGY_A_CHANNEL);
    }
    assert.equal(calls.filter(([, { payload }]) => payload.op === "push").length, 101);
    assert.equal(calls.filter(([, { payload }]) => payload.op === "echo").length, 1_002);
    assert.equal(result.echoes.count, TOPOLOGY_A_ECHO_COUNT);
    assert.equal(result.pushes.count, TOPOLOGY_A_PUSH_COUNT);
    assert.isTrue(result.pushes.ordered);
    assert.equal(result.exactEcho.bytes, TOPOLOGY_A_MAX_BYTES);
    assert.deepEqual(result.failureProbe, {
      invalidCountRejected: true,
      oversizedPayloadRejected: true,
      pass: true,
    });
    assert.deepEqual(result.failures, []);
  });

  it("awaits event readiness before pushes and after reload", async () => {
    const core = makeAdapter();
    const order = [];
    let release;
    const ready = new Promise((resolve) => {
      release = resolve;
    });
    const bridge = makeRendererBridge(core);
    const originalSubscribe = bridge.onMenuAction;
    bridge.onMenuAction = (listener) => {
      order.push("push");
      return originalSubscribe(listener);
    };
    const running = executeRendererSource(createRendererEvaluationSource(), bridge, ready);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(order, []);
    release(true);
    const before = await running;
    assert.deepEqual(order, ["push"]);

    const notReady = await executeRendererSource(
      createRendererEvaluationSource(),
      bridge,
      Promise.resolve(false),
    );
    assert.isFalse(notReady.criteria.pushCount);
    assert.equal(notReady.failures.find(({ stage }) => stage === "push")?.kind, "failure");

    let postReady;
    const postGate = new Promise((resolve) => {
      postReady = resolve;
    });
    const postRunning = executeRendererSource(
      createRendererPostReloadSource(before),
      bridge,
      postGate,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    postReady(true);
    const post = await postRunning;
    assert.equal(post.phase, "complete");
    assert.isTrue(post.reload.stable);
    assert.isTrue(post.pass);
    assert.doesNotThrow(() => assertTopologyACriteria(post));

    await rejects(
      () =>
        executeRendererSource(
          createRendererPostReloadSource(before),
          bridge,
          Promise.resolve(false),
        ),
      /not ready after reload/,
    );

    const changed = finalizeTopologyAReload(before, {
      boot: { version: "2.0.0" },
      sync: { locale: "en-US" },
    });
    assert.isFalse(changed.pass);
    assert.isFalse(changed.criteria.reloadStable);
    assert.equal(changed.failures.at(-1).stage, "reload");
  });
});
