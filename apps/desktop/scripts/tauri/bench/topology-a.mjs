/**
 * Topology A benchmark core.
 *
 * This module deliberately knows nothing about Tauri, a browser, or an app
 * launcher.  A renderer/test adapter supplies host invocation, push delivery,
 * and reload/snapshot operations.  The same evaluator can therefore run in a
 * real renderer later and in deterministic unit tests today.
 */

export const TOPOLOGY_A_CHANNEL = "desktop:phase0-topology-a-bench";
export const TOPOLOGY_A_PUSH_CHANNEL = "desktop:menu-action";
export const TOPOLOGY_A_MAX_BYTES = 1_048_576;
export const TOPOLOGY_A_ECHO_COUNT = 1_000;
export const TOPOLOGY_A_PUSH_COUNT = 100;
export const TOPOLOGY_A_PUSH_INTERVAL_MS = 10;
export const TOPOLOGY_A_P99_MAX_MS = 50;

export const TOPOLOGY_A_CRITERIA = Object.freeze({
  echoCount: TOPOLOGY_A_ECHO_COUNT,
  pushCount: TOPOLOGY_A_PUSH_COUNT,
  pushIntervalMs: TOPOLOGY_A_PUSH_INTERVAL_MS,
  maxPayloadBytes: TOPOLOGY_A_MAX_BYTES,
  p99MaxMs: TOPOLOGY_A_P99_MAX_MS,
});

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

const now = (adapter) => {
  if (typeof adapter?.now === "function") return Number(adapter.now());
  if (typeof globalThis.performance?.now === "function") return globalThis.performance.now();
  return Date.now();
};

const sleep = async (adapter, durationMs) => {
  if (durationMs <= 0) return;
  if (typeof adapter?.sleep === "function") {
    await adapter.sleep(durationMs);
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, durationMs));
};

const finiteTime = (value, label) => {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`${label} must be finite`);
  return number;
};

export function utf8ByteLength(value) {
  if (typeof value !== "string") throw new TypeError("utf8ByteLength requires a string");
  return new TextEncoder().encode(value).byteLength;
}

export function serializeJson(value) {
  let json;
  try {
    json = JSON.stringify(value);
  } catch (error) {
    throw new TypeError(`value is not JSON serializable: ${String(error)}`);
  }
  if (json === undefined) throw new TypeError("value is not JSON serializable");
  return { json, bytes: utf8ByteLength(json) };
}

/**
 * Return an ASCII string whose JSON-serialized representation is exactly the
 * requested byte count.  JSON string quotes account for the two-byte overhead.
 */
export function makeExactEchoValue(bytes = TOPOLOGY_A_MAX_BYTES) {
  if (!Number.isSafeInteger(bytes) || bytes < 2) {
    throw new RangeError("exact echo bytes must be an integer >= 2");
  }
  let value = "x".repeat(bytes - 2);
  // Keep this correction explicit so the helper remains correct if the value
  // representation changes in the future.
  while (serializeJson(value).bytes < bytes) value += "x";
  while (serializeJson(value).bytes > bytes) value = value.slice(0, -1);
  if (serializeJson(value).bytes !== bytes) {
    throw new Error(`could not create an exact ${bytes}-byte JSON value`);
  }
  return value;
}

export function percentile(values, probability) {
  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    values.some((value) => !Number.isFinite(Number(value))) ||
    !Number.isFinite(probability) ||
    probability < 0 ||
    probability > 1
  ) {
    throw new TypeError("percentile requires finite values and a probability in [0, 1]");
  }
  const sorted = values.map(Number).sort((left, right) => left - right);
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const fraction = position - lower;
  return sorted[lower] + (sorted[upper] - sorted[lower]) * fraction;
}

export const p50 = (values) => percentile(values, 0.5);
export const p99 = (values) => percentile(values, 0.99);

const errorMessage = (error) => (error instanceof Error ? error.message : String(error));

export function failureReceipt(stage, error, details = {}) {
  if (typeof stage !== "string" || stage.length === 0)
    throw new TypeError("failure stage required");
  return {
    kind: "failure",
    stage,
    message: errorMessage(error),
    details: isRecord(details) ? { ...details } : {},
  };
}

export const isFailureReceipt = (value) =>
  isRecord(value) && value.kind === "failure" && typeof value.stage === "string";

const invokeHost = async (adapter, payload) => {
  const invoke = adapter?.invokeHost ?? adapter?.invoke;
  if (typeof invoke !== "function")
    throw new TypeError("benchmark adapter requires invoke(payload)");
  // `invokeHost` is unambiguous; the arity fallback keeps simple fake adapters
  // ergonomic while supporting a renderer-shaped (channel, payload) function.
  if (adapter.invokeHost !== undefined || invoke.length < 2) {
    return await invoke.call(adapter, payload);
  }
  return await invoke.call(adapter, "host_invoke", {
    channel: TOPOLOGY_A_CHANNEL,
    payload,
  });
};

const echoedValue = (response) =>
  isRecord(response) && Object.prototype.hasOwnProperty.call(response, "value")
    ? response.value
    : response;

const jsonEqual = (left, right) => {
  try {
    return serializeJson(left).json === serializeJson(right).json;
  } catch {
    return false;
  }
};

export async function measureEchoRoundTrips(
  adapter,
  { count = TOPOLOGY_A_ECHO_COUNT, valueFactory = (index) => index } = {},
) {
  if (!Number.isSafeInteger(count) || count < TOPOLOGY_A_ECHO_COUNT) {
    throw new RangeError(`echo count must be at least ${TOPOLOGY_A_ECHO_COUNT}`);
  }
  const durations = [];
  for (let index = 0; index < count; index += 1) {
    const value = valueFactory(index);
    const startedAt = now(adapter);
    const response = await invokeHost(adapter, { op: "echo", value });
    const durationMs = finiteTime(now(adapter) - startedAt, "echo duration");
    if (!jsonEqual(echoedValue(response), value)) {
      throw new Error(`echo ${index} did not round-trip its value`);
    }
    durations.push(durationMs);
  }
  return {
    count,
    durationsMs: durations,
    p50Ms: p50(durations),
    p99Ms: p99(durations),
    p99Pass: p99(durations) < TOPOLOGY_A_P99_MAX_MS,
  };
}

const parsePushEvent = (event) => {
  let candidate = event;
  if (isRecord(event) && Object.prototype.hasOwnProperty.call(event, "payload")) {
    if (event.channel !== undefined && event.channel !== TOPOLOGY_A_PUSH_CHANNEL) {
      throw new Error(`unexpected push channel: ${String(event.channel)}`);
    }
    candidate = event.payload;
  }
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch (error) {
      throw new Error(`invalid push payload: ${errorMessage(error)}`);
    }
  }
  if (
    !isRecord(candidate) ||
    !Number.isSafeInteger(candidate.seq) ||
    candidate.seq < 0 ||
    !Number.isFinite(Number(candidate.sentAt))
  ) {
    throw new Error("invalid ordered push receipt");
  }
  return { seq: candidate.seq, sentAt: Number(candidate.sentAt) };
};

const subscribePushes = (adapter, listener) => {
  const subscribe = adapter?.subscribePush ?? adapter?.onPush;
  if (typeof subscribe !== "function") {
    throw new TypeError("benchmark adapter requires subscribePush(listener)");
  }
  const remove = subscribe.call(adapter, listener);
  return typeof remove === "function" ? remove : () => undefined;
};

export async function measureOrderedPushes(
  adapter,
  { count = TOPOLOGY_A_PUSH_COUNT, timeoutMs = 5_000 } = {},
) {
  if (!Number.isSafeInteger(count) || count !== TOPOLOGY_A_PUSH_COUNT) {
    throw new RangeError(`push count must be exactly ${TOPOLOGY_A_PUSH_COUNT}`);
  }
  const timestamps = [];
  const events = [];
  let resolvePushes;
  let rejectPushes;
  const pushesComplete = new Promise((resolve, reject) => {
    resolvePushes = resolve;
    rejectPushes = reject;
  });
  const remove = subscribePushes(adapter, (event) => {
    try {
      events.push({ ...parsePushEvent(event), receivedAt: now(adapter) });
      if (events.length === count) resolvePushes();
      if (events.length > count) rejectPushes(new Error(`received more than ${count} pushes`));
    } catch (error) {
      rejectPushes(error);
    }
  });
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    remove();
    throw new RangeError("push timeout must be positive");
  }
  let timeout;
  try {
    const cadenceStartedAt = now(adapter);
    const sends = [];
    for (let seq = 0; seq < count; seq += 1) {
      const dueAt = cadenceStartedAt + seq * TOPOLOGY_A_PUSH_INTERVAL_MS;
      await sleep(adapter, dueAt - now(adapter));
      const sentAt = finiteTime(now(adapter), "push dispatch timestamp");
      timestamps.push(sentAt);
      sends.push(invokeHost(adapter, { op: "push", seq, sentAt }));
    }
    await Promise.all(sends);
    if (events.length < count) {
      await Promise.race([
        pushesComplete,
        new Promise((_, reject) => {
          timeout = setTimeout(
            () =>
              reject(new Error(`timed out waiting for ${count} pushes; received ${events.length}`)),
            timeoutMs,
          );
        }),
      ]);
    }
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    remove();
  }
  if (events.length !== count) {
    throw new Error(`expected ${count} pushes, received ${events.length}`);
  }
  const expected = Array.from({ length: count }, (_, index) => index);
  const sequence = events.map((event) => event.seq);
  if (sequence.some((value, index) => value !== expected[index])) {
    throw new Error(`push ordering violation: ${sequence.join(",")}`);
  }
  const latenciesMs = events.map((event, index) => {
    const latency = finiteTime(event.receivedAt - event.sentAt, "push latency");
    if (latency < 0) throw new Error(`push ${index} has a negative latency`);
    return latency;
  });
  const cadenceDeltasMs = timestamps
    .slice(1)
    .map((timestamp, index) => timestamp - timestamps[index]);
  const elapsedMs = timestamps[count - 1] - timestamps[0];
  const ratePerSecond = ((count - 1) / Math.max(elapsedMs, Number.EPSILON)) * 1_000;
  const ratePass = ratePerSecond >= 90 && ratePerSecond <= 110;
  return {
    count,
    sequence,
    sentAt: timestamps,
    events,
    latenciesMs,
    p50Ms: p50(latenciesMs),
    p99Ms: p99(latenciesMs),
    ordered: true,
    cadenceDeltasMs,
    cadencePass: ratePass,
    ratePerSecond,
    ratePass,
  };
}

export async function measureExactEchoThroughput(adapter, { bytes = TOPOLOGY_A_MAX_BYTES } = {}) {
  if (bytes !== TOPOLOGY_A_MAX_BYTES) {
    throw new RangeError(`exact payload must be ${TOPOLOGY_A_MAX_BYTES} bytes`);
  }
  const value = makeExactEchoValue(bytes);
  const serialized = serializeJson(value);
  if (serialized.bytes !== bytes) {
    throw new Error(`exact payload serialized to ${serialized.bytes} bytes`);
  }
  const startedAt = now(adapter);
  const response = await invokeHost(adapter, { op: "echo", value });
  const durationMs = finiteTime(now(adapter) - startedAt, "exact echo duration");
  if (!jsonEqual(echoedValue(response), value)) throw new Error("exact echo did not round-trip");
  return {
    bytes,
    durationMs,
    throughputBytesPerSecond: (bytes / Math.max(durationMs, Number.EPSILON)) * 1_000,
  };
}

const readSnapshot = async (adapter) => {
  if (typeof adapter?.readSnapshot === "function") return await adapter.readSnapshot();
  const boot = typeof adapter?.readBoot === "function" ? await adapter.readBoot() : undefined;
  const sync = typeof adapter?.readSync === "function" ? await adapter.readSync() : undefined;
  if (boot === undefined && sync === undefined) {
    throw new TypeError("benchmark adapter requires readSnapshot or readBoot/readSync");
  }
  return { boot, sync };
};

export async function compareReloadSnapshots(adapter) {
  if (typeof adapter?.reload !== "function")
    throw new TypeError("benchmark adapter requires reload()");
  const before = await readSnapshot(adapter);
  await adapter.reload();
  const after = await readSnapshot(adapter);
  const bootEqual = jsonEqual(before.boot, after.boot);
  const syncEqual = jsonEqual(before.sync, after.sync);
  return {
    before,
    after,
    bootEqual,
    syncEqual,
    stable: bootEqual && syncEqual,
  };
}

const invokeStage = async (stage, operation, callback, failures) => {
  try {
    return await callback();
  } catch (error) {
    failures.push(failureReceipt(stage, error, { operation }));
    return null;
  }
};

export async function evaluateTopologyA(adapter, options = {}) {
  const failures = [];
  const echoes = await invokeStage(
    "echo",
    "echo",
    () => measureEchoRoundTrips(adapter, options.echoes),
    failures,
  );
  const pushes = await invokeStage(
    "push",
    "push",
    () => measureOrderedPushes(adapter, options.pushes),
    failures,
  );
  const exactEcho = await invokeStage(
    "exact-echo",
    "echo",
    () => measureExactEchoThroughput(adapter, options.exactEcho),
    failures,
  );
  const reload = await invokeStage(
    "reload",
    "reload",
    () => compareReloadSnapshots(adapter),
    failures,
  );
  const criteria = {
    echoCount: echoes?.count === TOPOLOGY_A_ECHO_COUNT,
    echoP99: echoes?.p99Pass === true,
    pushCount: pushes?.count === TOPOLOGY_A_PUSH_COUNT,
    pushOrder: pushes?.ordered === true,
    pushCadence: pushes?.cadencePass === true,
    pushRate: pushes?.ratePass === true,
    exactPayload: exactEcho?.bytes === TOPOLOGY_A_MAX_BYTES,
    reloadStable: reload?.stable === true,
  };
  const pass = failures.length === 0 && Object.values(criteria).every(Boolean);
  return {
    schemaVersion: 1,
    channel: TOPOLOGY_A_CHANNEL,
    criteria,
    pass,
    echoes,
    pushes,
    exactEcho,
    reload,
    failures,
  };
}

export function finalizeTopologyAReload(beforeResult, afterSnapshot) {
  if (!isRecord(beforeResult) || !isRecord(beforeResult.criteria)) {
    throw new TypeError("pre-reload Topology A result is required");
  }
  const beforeSnapshot = beforeResult.reload?.before;
  if (!isRecord(beforeSnapshot) || !isRecord(afterSnapshot)) {
    throw new TypeError("before and after reload snapshots are required");
  }
  const bootEqual = jsonEqual(beforeSnapshot.boot, afterSnapshot.boot);
  const syncEqual = jsonEqual(beforeSnapshot.sync, afterSnapshot.sync);
  const stable = bootEqual && syncEqual;
  const failures = Array.isArray(beforeResult.failures) ? [...beforeResult.failures] : [];
  if (!stable) {
    failures.push(
      failureReceipt("reload", new Error("boot or sync snapshot changed across reload"), {
        bootEqual,
        syncEqual,
      }),
    );
  }
  const criteria = { ...beforeResult.criteria, reloadStable: stable };
  return {
    ...beforeResult,
    criteria,
    pass: failures.length === 0 && Object.values(criteria).every(Boolean),
    reload: { before: beforeSnapshot, after: afterSnapshot, bootEqual, syncEqual, stable },
    failures,
    phase: "complete",
  };
}

export function assertTopologyACriteria(result) {
  if (!isRecord(result) || result.pass !== true) {
    const failures = Array.isArray(result?.failures) ? result.failures : [];
    const detail = failures.map((failure) => `${failure.stage}: ${failure.message}`).join("; ");
    throw new Error(`Topology A benchmark criteria failed${detail ? `: ${detail}` : "."}`);
  }
  return result;
}

/**
 * Return a dependency-free renderer source.  A caller supplies
 * `globalThis.__NANONI_TOPOLOGY_A_BENCH_ADAPTER__` with the adapter methods
 * documented above; this keeps the source usable by an evaluateScript call
 * without importing a Tauri plugin into the benchmark core.
 */
const rendererEvaluation = async function topologyARendererEvaluation() {
  const adapter = globalThis.__NANONI_TOPOLOGY_A_BENCH_ADAPTER__;
  const channel = "desktop:phase0-topology-a-bench";
  const pushChannel = "desktop:menu-action";
  const maxBytes = 1_048_576;
  const echoCount = 1_000;
  const pushCount = 100;
  const pushIntervalMs = 10;
  const p99MaxMs = 50;
  const now = () => performance.now();
  const jsonEqual = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  const percentile = (values, probability) => {
    const sorted = [...values].sort((a, b) => a - b);
    const position = (sorted.length - 1) * probability;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    return lower === upper
      ? sorted[lower]
      : sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
  };
  const failure = (stage, error) => ({
    kind: "failure",
    stage,
    message: error instanceof Error ? error.message : String(error),
    details: {},
  });
  const invoke = (payload) => {
    if (!adapter || typeof adapter.invoke !== "function") {
      throw new Error("Topology A renderer adapter is missing");
    }
    return adapter.invoke("host_invoke", { channel, payload });
  };
  const waitForEvents = async () => {
    const ready = globalThis.__NANONI_EVENTS_READY__;
    if (ready === undefined || (await ready) !== true) {
      throw new Error("Topology A desktop event channel is not ready");
    }
  };
  const failures = [];
  let echoes = null;
  try {
    const durationsMs = [];
    for (let index = 0; index < echoCount; index += 1) {
      const startedAt = now();
      const response = await invoke({ op: "echo", value: index });
      if (!response || !jsonEqual(response.value, index)) {
        throw new Error(`echo ${index} did not round-trip its value`);
      }
      durationsMs.push(now() - startedAt);
    }
    echoes = {
      count: echoCount,
      durationsMs,
      p50Ms: percentile(durationsMs, 0.5),
      p99Ms: percentile(durationsMs, 0.99),
      p99Pass: percentile(durationsMs, 0.99) < p99MaxMs,
    };
  } catch (error) {
    failures.push(failure("echo", error));
  }
  let pushes = null;
  try {
    await waitForEvents();
    const sentAt = [];
    const cadenceStartedAt = now();
    if (!adapter || typeof adapter.collectPushes !== "function") {
      throw new Error("Topology A renderer adapter requires collectPushes(listener)");
    }
    pushes = await adapter.collectPushes(async () => {
      const sends = [];
      for (let seq = 0; seq < pushCount; seq += 1) {
        const dueAt = cadenceStartedAt + seq * pushIntervalMs;
        const remaining = dueAt - now();
        if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
        const dispatchAt = now();
        sentAt.push(dispatchAt);
        sends.push(invoke({ op: "push", seq, sentAt: dispatchAt }));
      }
      await Promise.all(sends);
    });
    const sequence = pushes?.events?.map((event) => event.seq) ?? pushes?.sequence;
    const latenciesMs =
      pushes?.latenciesMs ?? (pushes?.events ?? []).map((event, index) => now() - sentAt[index]);
    const cadenceDeltasMs = sentAt.slice(1).map((timestamp, index) => timestamp - sentAt[index]);
    const ratePerSecond =
      ((pushCount - 1) / Math.max(sentAt[pushCount - 1] - sentAt[0], Number.EPSILON)) * 1_000;
    const ratePass = ratePerSecond >= 90 && ratePerSecond <= 110;
    pushes = {
      count: pushCount,
      sequence,
      sentAt,
      events: pushes?.events ?? [],
      latenciesMs,
      p50Ms: percentile(latenciesMs, 0.5),
      p99Ms: percentile(latenciesMs, 0.99),
      ordered: sequence?.every((value, index) => value === index) === true,
      cadenceDeltasMs,
      cadencePass: ratePass,
      ratePerSecond,
      ratePass,
    };
  } catch (error) {
    failures.push(failure("push", error));
  }
  let exactEcho = null;
  try {
    const value = "x".repeat(maxBytes - 2);
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength !== maxBytes) {
      throw new Error("exact payload did not serialize to 1048576 bytes");
    }
    const startedAt = now();
    const response = await invoke({ op: "echo", value });
    if (!response || !jsonEqual(response.value, value))
      throw new Error("exact echo did not round-trip");
    const durationMs = now() - startedAt;
    exactEcho = {
      bytes: maxBytes,
      durationMs,
      throughputBytesPerSecond: (maxBytes / Math.max(durationMs, Number.EPSILON)) * 1_000,
    };
  } catch (error) {
    failures.push(failure("exact-echo", error));
  }
  let snapshot = null;
  try {
    if (!adapter || typeof adapter.readSnapshot !== "function") {
      throw new Error("Topology A renderer snapshot adapter is missing");
    }
    snapshot = await adapter.readSnapshot();
  } catch (error) {
    failures.push(failure("reload", error));
  }
  const criteria = {
    echoCount: echoes?.count === echoCount,
    echoP99: echoes?.p99Pass === true,
    pushCount: pushes?.count === pushCount,
    pushOrder: pushes?.ordered === true,
    pushCadence: pushes?.cadencePass === true,
    pushRate: pushes?.ratePass === true,
    exactPayload: exactEcho?.bytes === maxBytes,
    reloadStable: false,
  };
  return {
    schemaVersion: 1,
    channel,
    criteria,
    pass: false,
    echoes,
    pushes,
    exactEcho,
    reload: { before: snapshot, after: null, bootEqual: false, syncEqual: false, stable: false },
    failures,
    phase: "before-reload",
  };
};

const rendererPostReloadEvaluation = async function topologyARendererPostReloadEvaluation(
  beforeResult,
) {
  const adapter = globalThis.__NANONI_TOPOLOGY_A_BENCH_ADAPTER__;
  const ready = globalThis.__NANONI_EVENTS_READY__;
  if (ready === undefined || (await ready) !== true) {
    throw new Error("Topology A desktop event channel is not ready after reload");
  }
  if (!adapter || typeof adapter.readSnapshot !== "function") {
    throw new Error("Topology A renderer snapshot adapter is missing");
  }
  const after = await adapter.readSnapshot();
  const before = beforeResult?.reload?.before;
  if (!before || typeof before !== "object" || !after || typeof after !== "object") {
    throw new Error("Topology A pre-reload result and snapshots are required");
  }
  const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  const bootEqual = equal(before.boot, after.boot);
  const syncEqual = equal(before.sync, after.sync);
  const stable = bootEqual && syncEqual;
  const failures = Array.isArray(beforeResult.failures) ? [...beforeResult.failures] : [];
  if (!stable) {
    failures.push({
      kind: "failure",
      stage: "reload",
      message: "boot or sync snapshot changed across reload",
      details: { bootEqual, syncEqual },
    });
  }
  const criteria = { ...beforeResult.criteria, reloadStable: stable };
  return {
    ...beforeResult,
    criteria,
    pass: failures.length === 0 && Object.values(criteria).every(Boolean),
    reload: { before, after, bootEqual, syncEqual, stable },
    failures,
    phase: "complete",
  };
};

export function createRendererEvaluationSource() {
  return `(${rendererEvaluation.toString()})();`;
}

/**
 * Evaluate after the pilot runner has reloaded the renderer.  Reload is kept
 * outside the evaluated context because a page navigation destroys the
 * JavaScript realm before it can read a post-reload value.
 */
export function createRendererPostReloadSource(beforeResult) {
  if (!isRecord(beforeResult)) throw new TypeError("pre-reload Topology A result is required");
  return `(${rendererPostReloadEvaluation.toString()})(${JSON.stringify(beforeResult)});`;
}

export const rendererEvaluationSource = createRendererEvaluationSource;
export const rendererPostReloadSource = createRendererPostReloadSource;
export const measureTopologyA = evaluateTopologyA;
export const runTopologyABenchmark = evaluateTopologyA;
