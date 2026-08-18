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
        return { value: payload.value };
      }
      if (payload.op === "push") {
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

const executeRendererSource = async (source, adapter, ready = Promise.resolve(true)) => {
  const previousAdapter = globalThis.__NANONI_TOPOLOGY_A_BENCH_ADAPTER__;
  const previousReady = globalThis.__NANONI_EVENTS_READY__;
  globalThis.__NANONI_TOPOLOGY_A_BENCH_ADAPTER__ = adapter;
  globalThis.__NANONI_EVENTS_READY__ = ready;
  try {
    return await new Function(`return ${source}`)();
  } finally {
    if (previousAdapter === undefined) delete globalThis.__NANONI_TOPOLOGY_A_BENCH_ADAPTER__;
    else globalThis.__NANONI_TOPOLOGY_A_BENCH_ADAPTER__ = previousAdapter;
    if (previousReady === undefined) delete globalThis.__NANONI_EVENTS_READY__;
    else globalThis.__NANONI_EVENTS_READY__ = previousReady;
  }
};

const makeRendererAdapter = (core) => ({
  invoke: (_command, request) => core.invoke(request.payload),
  collectPushes: async (run) => {
    const events = [];
    const remove = core.subscribePush((event) => {
      const payload = JSON.parse(event.payload);
      events.push({ ...payload, receivedAt: performance.now() });
    });
    try {
      await run();
    } finally {
      remove();
    }
    return {
      events,
      sequence: events.map((event) => event.seq),
      latenciesMs: events.map((event) => event.receivedAt - event.sentAt),
    };
  },
  readSnapshot: () => core.readSnapshot(),
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
    const result = await executeRendererSource(
      createRendererEvaluationSource(),
      makeRendererAdapter(core),
    );
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
    assert.isFalse(result.pass);
    assert.deepEqual(result.failures, []);
  });

  it("awaits event readiness before pushes and after reload", async () => {
    const core = makeAdapter();
    const order = [];
    let release;
    const ready = new Promise((resolve) => {
      release = resolve;
    });
    const adapter = makeRendererAdapter(core);
    const originalCollect = adapter.collectPushes;
    adapter.collectPushes = async (...args) => {
      order.push("push");
      return originalCollect(...args);
    };
    const running = executeRendererSource(createRendererEvaluationSource(), adapter, ready);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(order, []);
    release(true);
    const before = await running;
    assert.deepEqual(order, ["push"]);

    const notReady = await executeRendererSource(
      createRendererEvaluationSource(),
      adapter,
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
      adapter,
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
          adapter,
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
